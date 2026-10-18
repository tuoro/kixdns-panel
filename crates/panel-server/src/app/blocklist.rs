//! 拦截列表的接口和定时更新 / The blocklists' endpoints and scheduled update

use std::collections::BTreeMap;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use crate::auth::{authenticate, unix_timestamp, verify_csrf};
use crate::blocklist_data::{
    BuildRequest, BuildResult, SourceStatus, blocklist_path, replace_blocklist_path,
};
use crate::error::{AppError, AppResult};
use crate::geo_data::GeoDataSchedule;

use super::geo::{clean_up_after_update, schedule_label};
use super::{
    AppState, SystemConfigWrite, map_blocklist_error, system_config_base, write_system_config,
};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/config/blocklists", get(get_blocklists))
        .route("/config/blocklists/build", post(build_blocklists))
        .route("/config/blocklists/schedule", put(save_schedule))
}

/// 拦截列表页要的：每个列表的情况（按链接）和自动更新的设置 / What the blocklist page needs: each list's status (by
/// link) and the automatic-update setting
#[derive(Debug, Serialize)]
struct Blocklists {
    sources: BTreeMap<String, SourceStatus>,
    schedule: GeoDataSchedule,
}

#[derive(Debug, Deserialize)]
struct ScheduleRequest {
    interval_hours: Option<u64>,
}

async fn get_blocklists(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<Blocklists>> {
    authenticate(&state.database, &jar).await?;
    let sources = state
        .blocklists
        .sources()
        .await
        .map_err(map_blocklist_error)?;
    let schedule = state
        .blocklists
        .schedule()
        .get()
        .await
        .map_err(map_blocklist_error)?;
    Ok(Json(Blocklists { sources, schedule }))
}

/// 页面添加、开关、更新订阅时：下载要下载的，合成文件。和「下载并填入配置」一样只准备文件，路径由页面填进草稿，保存后
/// 才生效。
/// When the page adds, switches or updates a subscription: downloads what needs downloading and builds the file. Like
/// 下载并填入配置 it only prepares the file; the page puts the path into the draft, which takes effect on save.
async fn build_blocklists(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<BuildRequest>,
) -> AppResult<Json<BuildResult>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let result = state
        .blocklists
        .build(request)
        .await
        .map_err(map_blocklist_error)?;
    state
        .database
        .audit(
            Some(session.username),
            "config.blocklists.build".to_owned(),
            build_note(result.sources.len(), result.failed),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(result))
}

/// 审计里怎么说这次合成：几个列表、几个没下载成功；不折行空格让数字和「个」不拆开
/// How the audit describes a build: how many lists, how many failed to download; no-break spaces keep a number with its
/// 个
fn build_note(lists: usize, failed: usize) -> String {
    if failed == 0 {
        format!("{lists}\u{a0}个列表")
    } else {
        format!("{lists}\u{a0}个列表，{failed}\u{a0}个没下载成功")
    }
}

async fn save_schedule(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<ScheduleRequest>,
) -> AppResult<Json<GeoDataSchedule>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let schedule = state
        .blocklists
        .schedule()
        .set_interval(request.interval_hours)
        .await
        .map_err(map_blocklist_error)?;
    state
        .database
        .audit(
            Some(session.username),
            "config.blocklists.schedule".to_owned(),
            schedule
                .interval_hours
                .map_or_else(|| "关闭".to_owned(), schedule_label),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(schedule))
}

/// 到了时间就更新正在用的拦截列表。有列表没更新上时，其余照常换上，自动更新记下几个没更新上。
/// Updates the blocklists in use when one is due. When some lists fail to update the rest still go in, and the
/// schedule records how many failed.
pub(super) async fn run_due_blocklist_schedule(state: &AppState) -> anyhow::Result<()> {
    let now = unix_timestamp();
    let schedule = state.blocklists.schedule().get().await?;
    if !schedule.is_due(now) {
        return Ok(());
    }
    // 配置里还没用拦截列表时没有可更新的：不算一次更新，也不记成功，保存了列表以后才开始
    // With no blocklists in the config there is nothing to update: it counts as no run and records no success, starting
    // once lists are saved
    let (_, base) = system_config_base(state).await?;
    if blocklist_path(&base.content).is_none() {
        return Ok(());
    }
    state.blocklists.schedule().mark_attempt(now).await?;
    let outcome = apply_scheduled_blocklist_update(state).await;
    let error = match &outcome {
        Ok(0) => None,
        Ok(failed) => Some(format!("{failed}\u{a0}个列表没更新上，接着用上一份")),
        Err(error) => Some(format!("{error:#}")),
    };
    state
        .blocklists
        .schedule()
        .mark_result(unix_timestamp(), error)
        .await?;
    outcome.map(|_| ())
}

/// 重新下载正在用的列表，内容变了就把新文件换进配置。返回没更新上的列表数。
/// Downloads the lists in use again and, when their content changed, swaps the new file into the config. Returns how
/// many lists failed to update.
pub(super) async fn apply_scheduled_blocklist_update(state: &AppState) -> anyhow::Result<usize> {
    // 和写配置时同一份为底，换的才是它在用的文件 / The same config the write starts from, so the file swapped is
    // the one it uses
    let (_, base) = system_config_base(state).await?;
    let Some(refresh) = state.blocklists.refresh_running(&base.content).await? else {
        return Ok(0);
    };
    // 保留的版本和写配置在同一把锁里读，免得漏掉刚保存的版本
    // The retained versions are read under the same lock as the config write, so they cannot miss the version just
    // saved
    let retained = {
        let _apply_guard = state.config_apply_lock.lock().await;
        if let Some((old, new)) = &refresh.replaced {
            write_system_config(
                state,
                &SystemConfigWrite {
                    subject: "新的拦截列表",
                    message: "定时更新拦截列表",
                    audit_action: "config.blocklists.schedule.apply",
                    audit_note: None,
                },
                |candidate| Ok(replace_blocklist_path(candidate, old, new)),
            )
            .await?;
        }
        state.config.retained_contents().await?
    };
    clean_up_after_update(state, &retained, "拦截列表").await;
    Ok(refresh.failed)
}

#[cfg(test)]
mod tests {
    use super::build_note;

    #[test]
    fn the_audit_says_how_many_lists_failed() {
        assert_eq!(build_note(3, 0), "3\u{a0}个列表");
        assert_eq!(build_note(3, 1), "3\u{a0}个列表，1\u{a0}个没下载成功");
    }
}
