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
    let retained = state
        .config
        .retained_contents()
        .await
        .map_err(map_config_error)?;
    let result = state
        .geo_data
        .cleanup(&retained)
        .await
        .map_err(map_geo_data_error)?;
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
    let _apply_guard = state.config_apply_lock.lock().await;
    let runtime = state.control.active_config().await;
    let previous = if matches!(&runtime, Err(ControlError::Unavailable(_))) {
        state.config.desired().await?
    } else {
        state.config.current().await?
    };
    let mut candidate = previous.content.clone();
    if !apply_manifest_paths(&mut candidate, &updated)? {
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
