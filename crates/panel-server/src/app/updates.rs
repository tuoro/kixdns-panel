use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use crate::auth::{authenticate, unix_timestamp, verify_csrf};
use crate::error::{AppError, AppResult};
use crate::panel_update::{PanelUpdateStatus, read_status as read_panel_update_status};
use crate::updates::{
    GithubTokenStatus, InstalledVersion, UpdateInfo, UpdateNotifications, VersionCatalog,
    VersionSource,
};

use super::{AppState, map_config_error, map_operation_error, map_update_error};

#[derive(Debug, Serialize)]
struct PanelUpdateStartResponse {
    accepted: bool,
    target_version: String,
}

#[derive(Debug, Deserialize)]
struct GithubTokenRequest {
    token: String,
}

#[derive(Debug, Default, Deserialize)]
struct KixdnsVersionsQuery {
    #[serde(default)]
    source: VersionSource,
}

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/updates", get(check_updates))
        .route("/updates/status", get(update_notifications))
        .route(
            "/settings/github-token",
            get(github_token_status)
                .put(save_github_token)
                .delete(delete_github_token),
        )
        .route(
            "/panel-update",
            get(panel_update_status).post(start_panel_update),
        )
        .route("/updates/apply", post(apply_update))
        .route("/kixdns/versions", get(kixdns_versions))
        .route(
            "/kixdns/versions/{source}/{source_id}/install",
            post(install_kixdns_version),
        )
        .route(
            "/kixdns/versions/{source}/{commit}/activate",
            post(activate_kixdns_version),
        )
        .route(
            "/kixdns/versions/{source}/{identity}/delete",
            post(delete_kixdns_version),
        )
}

async fn check_updates(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<UpdateInfo>> {
    authenticate(&state.database, &jar).await?;
    state
        .updates
        .check()
        .await
        .map(Json)
        .map_err(map_update_error)
}

async fn update_notifications(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<UpdateNotifications>> {
    authenticate(&state.database, &jar).await?;
    state
        .updates
        .notifications()
        .await
        .map(Json)
        .map_err(map_update_error)
}

async fn github_token_status(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<GithubTokenStatus>> {
    authenticate(&state.database, &jar).await?;
    Ok(Json(state.updates.github_token_status().await))
}

async fn save_github_token(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<GithubTokenRequest>,
) -> AppResult<Json<GithubTokenStatus>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let status = state
        .updates
        .save_github_token(request.token)
        .await
        .map_err(map_update_error)?;
    state
        .database
        .audit(
            Some(session.username),
            "system.github_token.configure".to_owned(),
            "配置 GitHub API Token".to_owned(),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(status))
}

async fn delete_github_token(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<Json<GithubTokenStatus>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let status = state
        .updates
        .delete_github_token()
        .await
        .map_err(map_update_error)?;
    state
        .database
        .audit(
            Some(session.username),
            "system.github_token.remove".to_owned(),
            "删除 GitHub API Token".to_owned(),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(status))
}

async fn panel_update_status(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<PanelUpdateStatus>> {
    authenticate(&state.database, &jar).await?;
    read_panel_update_status()
        .await
        .map(Json)
        .map_err(AppError::Internal)
}

async fn start_panel_update(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<Json<PanelUpdateStartResponse>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    if read_panel_update_status()
        .await
        .map_err(AppError::Internal)?
        .is_running()
    {
        return Err(AppError::Conflict(
            "panel_update_running",
            "面板在线更新正在进行".to_owned(),
        ));
    }
    let notice = state
        .updates
        .panel_update_notice()
        .await
        .map_err(map_update_error)?;
    if !notice.available {
        return Err(AppError::Conflict(
            "panel_update_not_available",
            "当前没有可安装的面板正式更新".to_owned(),
        ));
    }
    let target_version = format!(
        "v{}",
        notice.latest_version.ok_or_else(|| {
            AppError::Internal(anyhow::anyhow!("可用面板更新缺少目标版本"))
        })?
    );
    state
        .operations
        .start_panel_update()
        .await
        .map_err(map_operation_error)?;
    state
        .database
        .audit(
            Some(session.username),
            "panel.update.start".to_owned(),
            format!("开始在线更新面板到 {target_version}"),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(PanelUpdateStartResponse {
        accepted: true,
        target_version,
    }))
}

async fn apply_update(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<Json<UpdateInfo>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let _apply_guard = state.config_apply_lock.lock().await;
    let config = state.config.current().await.map_err(map_config_error)?;
    let result = state
        .updates
        .apply(&config.content, &state.operations, &state.control)
        .await
        .map_err(map_update_error)?;
    state
        .database
        .audit(
            Some(session.username),
            "update.apply".to_owned(),
            format!("安装增强构建 {}", result.latest_commit),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(result))
}

async fn kixdns_versions(
    State(state): State<AppState>,
    Query(query): Query<KixdnsVersionsQuery>,
    jar: CookieJar,
) -> AppResult<Json<VersionCatalog>> {
    authenticate(&state.database, &jar).await?;
    state
        .updates
        .catalog(query.source)
        .await
        .map(Json)
        .map_err(map_update_error)
}

async fn install_kixdns_version(
    State(state): State<AppState>,
    Path((source, source_id)): Path<(VersionSource, u64)>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<Json<InstalledVersion>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let _apply_guard = state.config_apply_lock.lock().await;
    let config = state.config.current().await.map_err(map_config_error)?;
    let result = state
        .updates
        .install_version(
            source,
            source_id,
            &config.content,
            &state.operations,
            &state.control,
        )
        .await
        .map_err(map_update_error)?;
    state
        .database
        .audit(
            Some(session.username),
            "kixdns.version.install".to_owned(),
            format!("从 {source:?} 安装并激活增强构建 {}", result.commit),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(result))
}

async fn activate_kixdns_version(
    State(state): State<AppState>,
    Path((source, commit)): Path<(VersionSource, String)>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<Json<InstalledVersion>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let _apply_guard = state.config_apply_lock.lock().await;
    let config = state.config.current().await.map_err(map_config_error)?;
    let result = state
        .updates
        .activate_version(
            source,
            &commit,
            &config.content,
            &state.operations,
            &state.control,
        )
        .await
        .map_err(map_update_error)?;
    state
        .database
        .audit(
            Some(session.username),
            "kixdns.version.activate".to_owned(),
            format!("切换增强构建 {}", result.commit),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(result))
}

async fn delete_kixdns_version(
    State(state): State<AppState>,
    Path((source, identity)): Path<(VersionSource, String)>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<Json<InstalledVersion>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let result = state
        .updates
        .delete_version(source, &identity)
        .await
        .map_err(map_update_error)?;
    state
        .database
        .audit(
            Some(session.username),
            "kixdns.version.delete".to_owned(),
            format!("删除本地增强构建 {}", result.commit),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(result))
}
