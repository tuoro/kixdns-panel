use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use crate::auth::{authenticate, unix_timestamp, verify_csrf};
use crate::error::{AppError, AppResult};
use crate::panel_update::{PanelUpdateStatus, read_status as read_panel_update_status};
use crate::updates::{GithubTokenStatus, KixdnsKernel, LiveServiceHost, UpdateNotifications};

use super::{AppState, map_config_error, map_operation_error, map_update_error};

fn live_host(state: &AppState) -> LiveServiceHost {
    LiveServiceHost::new(state.operations.clone(), state.control.clone())
}

/// 在独立任务里跑完持锁的版本切换，处理函数只负责等结果。
/// 浏览器断开时 hyper 会丢弃处理函数的 future；切换若直接在里面 await，
/// 就会停在「服务已重启、活动版本未记录、审计未写」这样的半路上。放进
/// `tokio::spawn` 后，丢弃的只是等待，切换本身照常完成或回滚。任务 panic
/// 时转成内部错误。
/// Run the lock-held version switch on its own task and let the handler only
/// wait for it. When the browser disconnects hyper drops the handler future;
/// awaiting the switch inline would stop it half-way, with the service
/// restarted but the active version and audit unrecorded. Under `tokio::spawn`
/// only the waiting is dropped and the switch completes or rolls back. A
/// panicking task becomes an internal error.
pub(super) async fn run_detached<T, F>(work: F) -> AppResult<T>
where
    F: Future<Output = AppResult<T>> + Send + 'static,
    T: Send + 'static,
{
    tokio::spawn(work).await.map_err(|error| {
        AppError::Internal(anyhow::anyhow!("KixDNS 版本切换任务异常结束：{error}"))
    })?
}

#[derive(Debug, Serialize)]
struct PanelUpdateStartResponse {
    accepted: bool,
    target_version: String,
}

#[derive(Debug, Deserialize)]
struct GithubTokenRequest {
    token: String,
}

#[derive(Debug, Deserialize)]
struct KernelUpdateRequest {
    source_id: u64,
}

pub(super) fn routes() -> Router<AppState> {
    Router::new()
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
        .route("/kixdns/kernel", get(kixdns_kernel))
        .route("/kixdns/kernel/update", post(update_kixdns_kernel))
        .route("/kixdns/kernel/rollback", post(rollback_kixdns_kernel))
}

/// Release 轨道已停止构建：新面板启动后在后台把 Release 内核换成最新的 Action 内核。
/// 走和「更新」按钮同一套下载、校验、配置兼容检查、切换与失败回滚；哪一步失败都保持原样、
/// 记进审计，下次启动再试，用户也可以在系统页手动更新。
/// The Release track no longer builds, so after start-up a new panel replaces a Release
/// kernel with the newest Action kernel in the background. It goes through the same
/// download, verification, config compatibility check, switch and rollback as the update
/// button; when any step fails nothing changes, the audit log says so, and the next start
/// tries again while the user can still update from the System page.
pub(super) fn spawn_release_kernel_replacement(state: AppState) {
    tokio::spawn(async move {
        if let Err(error) = replace_release_kernel(&state).await {
            tracing::warn!(error = ?error, "自动替换 Release 内核没有完成");
        }
    });
}

async fn replace_release_kernel(state: &AppState) -> anyhow::Result<()> {
    let Some(release) = state.updates.release_kernel_to_replace().await? else {
        return Ok(());
    };
    let _apply_guard = state.config_apply_lock.lock().await;
    let config = state.config.current().await?;
    let (action, detail) = match state
        .updates
        .update(None, &config.content, &live_host(state))
        .await
    {
        Ok(installed) => (
            "kixdns.kernel.replace_release",
            format!(
                "Release 轨道已停止构建，内核已从 {} 自动换成 {}",
                release.label(),
                installed.label()
            ),
        ),
        Err(error) => (
            "kixdns.kernel.replace_release_failed",
            format!(
                "没能把 Release 内核 {} 自动换成最新内核：{error}。下次启动面板时再试，也可以在系统页手动更新",
                release.label()
            ),
        ),
    };
    state
        .database
        .audit(None, action.to_owned(), detail, unix_timestamp())
        .await
}

async fn update_notifications(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<UpdateNotifications>> {
    authenticate(&state.database, &jar).await?;
    Ok(Json(state.updates.notifications().await))
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

async fn kixdns_kernel(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<KixdnsKernel>> {
    authenticate(&state.database, &jar).await?;
    state
        .updates
        .kernel()
        .await
        .map(Json)
        .map_err(map_update_error)
}

async fn update_kixdns_kernel(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<KernelUpdateRequest>,
) -> AppResult<Json<KixdnsKernel>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    run_detached(async move {
        let _apply_guard = state.config_apply_lock.lock().await;
        let config = state.config.current().await.map_err(map_config_error)?;
        let installed = state
            .updates
            .update(Some(request.source_id), &config.content, &live_host(&state))
            .await
            .map_err(map_update_error)?;
        state
            .database
            .audit(
                Some(session.username),
                "kixdns.kernel.update".to_owned(),
                format!("内核更新到 {}", installed.label()),
                unix_timestamp(),
            )
            .await
            .map_err(AppError::Internal)?;
        state
            .updates
            .kernel()
            .await
            .map(Json)
            .map_err(map_update_error)
    })
    .await
}

async fn rollback_kixdns_kernel(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<Json<KixdnsKernel>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    run_detached(async move {
        let _apply_guard = state.config_apply_lock.lock().await;
        let config = state.config.current().await.map_err(map_config_error)?;
        let installed = state
            .updates
            .rollback(&config.content, &live_host(&state))
            .await
            .map_err(map_update_error)?;
        state
            .database
            .audit(
                Some(session.username),
                "kixdns.kernel.rollback".to_owned(),
                format!("内核回退到 {}", installed.label()),
                unix_timestamp(),
            )
            .await
            .map_err(AppError::Internal)?;
        state
            .updates
            .kernel()
            .await
            .map(Json)
            .map_err(map_update_error)
    })
    .await
}
