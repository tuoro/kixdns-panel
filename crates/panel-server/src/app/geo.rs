use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum_extra::extract::CookieJar;
use serde::Deserialize;

use crate::auth::{authenticate, unix_timestamp, verify_csrf};
use crate::control::ControlError;
use crate::error::{AppError, AppResult};
use crate::geo_data::{
    GeoDataCleanupResult, GeoDataManifest, GeoDataSchedule, GeoDataSyncRequest,
    apply_manifest_paths,
};

use super::{
    AppState, ensure_running_config_supported, map_config_error, map_geo_data_error,
    rollback_config,
};

#[derive(Debug, Deserialize)]
pub(super) struct GeoDataScheduleRequest {
    interval_hours: Option<u64>,
}

pub(super) async fn get_geo_data(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<GeoDataManifest>> {
    authenticate(&state.database, &jar).await?;
    state
        .geo_data
        .current()
        .await
        .map(Json)
        .map_err(map_geo_data_error)
}

pub(super) async fn sync_geo_data(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<GeoDataSyncRequest>,
) -> AppResult<Json<GeoDataManifest>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let result = state
        .geo_data
        .sync(request)
        .await
        .map_err(map_geo_data_error)?;
    state
        .database
        .audit(
            Some(session.username),
            "config.geo_data.sync".to_owned(),
            format!(
                "同步 Geo 数据：MMDB {}，GeoIP {}，GeoSite {} 个",
                usize::from(result.geoip_mmdb.is_some()),
                usize::from(result.geoip_dat.is_some()),
                result.geosite.len()
            ),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(result))
}

pub(super) async fn cleanup_geo_data(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<Json<GeoDataCleanupResult>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let result = remove_unreferenced_geo_data(&state).await?;
    state
        .database
        .audit(
            Some(session.username),
            "config.geo_data.cleanup".to_owned(),
            format!(
                "清理 Geo 数据：删除 {} 个文件，释放 {} 字节",
                result.removed_files, result.reclaimed_bytes
            ),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(result))
}

pub(super) async fn get_geo_data_schedule(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<GeoDataSchedule>> {
    authenticate(&state.database, &jar).await?;
    state
        .geo_data
        .schedule()
        .await
        .map(Json)
        .map_err(map_geo_data_error)
}

pub(super) async fn save_geo_data_schedule(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<GeoDataScheduleRequest>,
) -> AppResult<Json<GeoDataSchedule>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    if request.interval_hours.is_some() {
        let manifest = state.geo_data.current().await.map_err(map_geo_data_error)?;
        if GeoDataSyncRequest::from_manifest(&manifest).is_empty() {
            return Err(AppError::BadRequest(
                "geo_data_schedule_empty",
                "请先配置并下载至少一个远程 Geo 数据源".to_owned(),
            ));
        }
    }
    let schedule = state
        .geo_data
        .set_schedule(request.interval_hours)
        .await
        .map_err(map_geo_data_error)?;
    state
        .database
        .audit(
            Some(session.username),
            "config.geo_data.schedule".to_owned(),
            schedule.interval_hours.map_or_else(
                || "关闭 Geo 自动更新".to_owned(),
                |hours| format!("设置 Geo 自动更新间隔为 {hours} 小时"),
            ),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(schedule))
}

pub(super) fn spawn_geo_scheduler(state: AppState) {
    tokio::spawn(async move {
        let start = tokio::time::Instant::now() + Duration::from_mins(1);
        let mut ticker = tokio::time::interval_at(start, Duration::from_mins(15));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            if let Err(error) = run_due_geo_schedule(&state).await {
                tracing::warn!(error = ?error, "Geo 定时更新失败");
            }
        }
    });
}

async fn run_due_geo_schedule(state: &AppState) -> anyhow::Result<()> {
    let now = unix_timestamp();
    let schedule = state.geo_data.schedule().await?;
    if !schedule.is_due(now) {
        return Ok(());
    }
    state.geo_data.mark_schedule_attempt(now).await?;
    let result = apply_scheduled_geo_update(state).await;
    let error = result.as_ref().err().map(|error| format!("{error:#}"));
    state
        .geo_data
        .mark_schedule_result(unix_timestamp(), error)
        .await?;
    result
}

async fn apply_scheduled_geo_update(state: &AppState) -> anyhow::Result<()> {
    let manifest = state.geo_data.current().await?;
    let request = GeoDataSyncRequest::from_manifest(&manifest);
    if request.is_empty() {
        anyhow::bail!("没有可用于自动更新的远程 Geo 数据源");
    }
    let updated = state.geo_data.sync(request).await?;
    apply_synced_geo_data(state, &updated).await
}

/// 删除当前清单和所有保留配置版本都不引用的 Geo 文件；回滚到任一保留版本时，它引用的文件都还在。
/// Delete Geo files that neither the current manifest nor any retained config version references;
/// rolling back to any retained version still finds every file it points at.
async fn remove_unreferenced_geo_data(state: &AppState) -> AppResult<GeoDataCleanupResult> {
    let retained = state
        .config
        .retained_contents()
        .await
        .map_err(map_config_error)?;
    state
        .geo_data
        .cleanup(&retained)
        .await
        .map_err(map_geo_data_error)
}

/// 把刚同步好的 Geo 清单写进配置，再清掉不再被引用的旧文件。
/// Write a freshly synced Geo manifest into the config, then remove old files nothing references.
pub(super) async fn apply_synced_geo_data(
    state: &AppState,
    updated: &GeoDataManifest,
) -> anyhow::Result<()> {
    // 清理与写配置同在一把锁里，免得清理读到的保留版本和刚保存的版本错开。
    // Cleanup runs under the same lock as the config write, so the retained versions it reads
    // cannot miss the version just saved.
    let _apply_guard = state.config_apply_lock.lock().await;
    write_synced_geo_config(state, updated).await?;
    // 每次定时更新都会下载新的内容寻址文件；不在这里清理，旧文件只会越积越多。
    // 清理失败不影响已生效的更新，只记日志，下次运行会再试。
    // Every scheduled run downloads new content-addressed files; without cleaning here the old
    // ones only pile up. A failed cleanup does not undo an applied update: log it and retry next run.
    match remove_unreferenced_geo_data(state).await {
        Ok(result) => tracing::info!(
            removed_files = result.removed_files,
            reclaimed_bytes = result.reclaimed_bytes,
            "Geo 定时更新后清理未引用的旧文件"
        ),
        Err(error) => tracing::warn!(error = ?error, "Geo 定时更新后清理旧文件失败"),
    }
    Ok(())
}

async fn write_synced_geo_config(
    state: &AppState,
    updated: &GeoDataManifest,
) -> anyhow::Result<()> {
    let runtime = state.control.active_config().await;
    let previous = if matches!(&runtime, Err(ControlError::Unavailable(_))) {
        state.config.desired().await?
    } else {
        state.config.current().await?
    };
    let mut candidate = previous.content.clone();
    if !apply_manifest_paths(&mut candidate, updated)? {
        return Ok(());
    }

    let result = match runtime {
        Ok(before_reload) => {
            ensure_running_config_supported(state, &candidate).await?;
            let validation = state.control.validate(&candidate).await?;
            if !validation.valid {
                anyhow::bail!("KixDNS 拒绝定时更新后的 Geo 配置");
            }
            let result = state
                .config
                .save(
                    candidate,
                    &previous.sha256,
                    "定时更新 Geo 数据".to_owned(),
                    "system".to_owned(),
                )
                .await?;
            if let Err(error) = state
                .control
                .wait_for_config(
                    &result.sha256,
                    before_reload.reload_sequence,
                    Duration::from_secs(5),
                )
                .await
            {
                rollback_config(state, previous.content, &result.sha256, "system").await?;
                anyhow::bail!("定时更新后的 Geo 配置未生效，已自动回滚：{error}");
            }
            result
        }
        Err(ControlError::Unavailable(_)) => {
            state
                .config
                .save_pending(
                    candidate,
                    &previous.sha256,
                    "定时更新 Geo 数据（待 KixDNS 启动）".to_owned(),
                    "system".to_owned(),
                )
                .await?
        }
        Err(error) => return Err(anyhow::Error::new(error)),
    };
    state
        .database
        .audit(
            None,
            "config.geo_data.schedule.apply".to_owned(),
            format!("定时更新 Geo 数据并生成配置版本 #{}", result.version_id),
            unix_timestamp(),
        )
        .await?;
    Ok(())
}
