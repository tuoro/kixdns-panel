//! 重启以后 `KixDNS` 起不来时，把改过、要重启才生效的设置退回它上次正常启动时的值。
//!
//! 这些设置（监听地址等）改了照常重载，`KixDNS` 却还用启动时的值，所以一份能重载的配置照样可能在重启时起不来，
//! 比如新的监听地址被别的程序占着。那时 `KixDNS` 连不上，保存只能存成待应用、等它回来，于是走进死路。
//!
//! 这里只记 `KixDNS` 报来的事实，按进程认，由服务端自己记（后台每 5 秒那一遍、配置页和概览的每次读）：
//! - **参考进程**是最近一个稳稳起来的进程：同一个进程隔几秒被看见两次才算稳（起不来的进程只在绑监听前应答几毫秒，
//!   和加载多久无关）。新进程一稳就换成参考，不管知不知道它启动时的值；
//! - **启动时的值**：一个进程报「没有设置等着重启」、正式文件又是它在用的那份时，文件里的设置就是它启动时的值。
//!   参考进程的这份不知道时，不给退回；
//! - 参考进程最后报的**要重启才生效的设置**；
//! - **起不来的记号**：连不上时服务失败、或者 systemd 正在重试，就记住；systemd 重试的那一下服务是 `active`，只看
//!   当下的状态会时有时无。面板发起的每次启动、重启、退回前后都清掉（那是一次新的尝试；请求途中读到的还是上一次的状态），
//!   面板自己启动时、见到稳的进程时也清。内核更新时的重启不经过这里，新内核加载那几秒要等见到稳的进程才清。
//!
//! 给不给退回、接不接受退回用同一个判断：`KixDNS` 连不上、有起不来的记号、服务没被干净地停掉、正式文件里那几项
//! 又和启动时的值不同。不看是谁发起的重启（配置页、系统页、内核更新、主机重启都一样）。
//!
//! When `KixDNS` does not come back from a restart, put the settings that were changed and took a restart back to
//! the values it last started with. Those settings (listen addresses and the like) reload as usual while `KixDNS`
//! keeps the values it started with, so a config that reloads fine can still fail at a restart, say when the new
//! listen address is taken by another program. `KixDNS` is then unreachable, a save can only be kept as pending
//! until it returns, and there is no way out.
//!
//! Only what `KixDNS` reports is recorded here, per process, by the server itself (the 5-second background pass and
//! every read by the config page or the overview):
//! - the **reference process** is the latest one that came up steadily: one process seen twice a few seconds apart
//!   (a process that cannot come up answers only for milliseconds before binding, however long it loaded). A new
//!   process becomes the reference once steady, whether or not its starting values are known;
//! - its **starting values**: when a process reports nothing waiting for a restart and the formal file is the one it
//!   uses, the file's settings are what it started with. When the reference's are unknown, no rollback is offered;
//! - the **settings waiting for a restart** the reference last reported;
//! - the **did-not-come-up mark**: set when, unreachable, the service failed or systemd is retrying it; during a retry
//!   the service reads `active`, so the state of the moment alone would come and go. Cleared before and after every
//!   start, restart or rollback the panel sends (a new attempt; what is read during the request is still the last
//!   attempt's state), on the panel's own start, and when a steady process is seen. A restart during a kernel update
//!   does not pass here, so while the new kernel loads it is cleared only once a steady process is seen.
//!
//! Offering a rollback and accepting one use the same test: `KixDNS` unreachable, the mark set, the service not
//! cleanly stopped, and those settings in the formal file differing from their starting values. Who restarted it does
//! not matter (the config page, the system page, a kernel update or a host reboot alike).

use std::collections::BTreeMap;

use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::Mutex;

use crate::auth::{authenticate, unix_timestamp, verify_csrf};
use crate::control::{ActiveConfig, Health};
use crate::db::CONFIG_APPLY_PENDING;
use crate::error::{AppError, AppResult};
use crate::operations::{ServiceAction, ServiceStatus};

use super::{AppState, map_config_error, map_operation_error, reconcile_pending};

const STARTUP_KEY: &str = "kixdns_startup_settings_v2";
/// 没发布过的旧格式，第一次写新格式时删掉 / An unreleased older format, removed on the first write of the new one
const OLD_STARTUP_KEY: &str = "kixdns_startup_settings_v1";
/// 同一个进程隔这么久被看见两次才算稳 / How far apart one process must be seen twice to count as steady
const STEADY_SECONDS: u64 = 3;
/// 读、改、写记录串行：后台那一遍、配置页、概览的读会同时跑 / Reads, changes and writes of the record are serialised: the
/// background pass and the config page's and overview's reads run at the same time
static RECORD_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Process {
    pid: u32,
    started_at: u64,
}

/// 还没稳的最新进程：第一次看见时它活了多久、它启动时的值（知道的话）
///
/// The newest process not yet steady: how long it had run when first seen, and its starting values when known
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Watch {
    process: Process,
    first_uptime: u64,
    settings: Option<Map<String, Value>>,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct Startup {
    process: Option<Process>,
    settings: Option<Map<String, Value>>,
    restart_pending: Vec<String>,
    watching: Option<Watch>,
    down: bool,
}

#[derive(Debug, Serialize)]
pub(super) struct RollbackResponse {
    version_id: i64,
}

/// 读不到记录时为 `None`（那就不改它）；坏掉的记录当成空的 / `None` when the record cannot be read (it is then left
/// alone); a damaged record counts as empty
async fn load(state: &AppState) -> Option<Startup> {
    match state.database.get_setting(STARTUP_KEY).await {
        Ok(Some(stored)) => Some(serde_json::from_str(&stored).unwrap_or_default()),
        Ok(None) => Some(Startup::default()),
        Err(error) => {
            tracing::warn!(%error, "无法读取 KixDNS 启动时的设置");
            None
        }
    }
}

async fn update(state: &AppState, change: impl FnOnce(Startup) -> Startup) {
    let _guard = RECORD_LOCK.lock().await;
    let Some(before) = load(state).await else {
        return;
    };
    let next = change(before.clone());
    if next == before {
        return;
    }
    if let Ok(serialized) = serde_json::to_string(&next)
        && let Err(error) = state
            .database
            .set_setting(STARTUP_KEY, serialized, unix_timestamp())
            .await
    {
        tracing::warn!(%error, "无法记下 KixDNS 启动时的设置");
    }
    if before == Startup::default() {
        let _ = state.database.delete_setting(OLD_STARTUP_KEY).await;
    }
}

/// 读到一个活着的进程。`formal` 是正式文件里的设置，只在它报「没有设置等着重启」、文件又是它在用的那份时给
///
/// A live process was read. `formal` is the formal file's settings, given only when it reports nothing waiting for a
/// restart and the file is the one it uses
fn seen_alive(
    mut startup: Startup,
    health: &Health,
    active: &ActiveConfig,
    formal: Option<Map<String, Value>>,
) -> Startup {
    let process = Process {
        pid: health.pid,
        started_at: health.started_at_unix,
    };
    let reported = active.restart_pending.clone().unwrap_or_default();
    if startup.process.as_ref() == Some(&process) {
        if formal.is_some() {
            startup.settings = formal;
        }
        startup.restart_pending = reported;
        startup.down = false;
        return startup;
    }
    let mut watch = match startup.watching.take() {
        Some(watch) if watch.process == process => watch,
        _ => Watch {
            process: process.clone(),
            first_uptime: health.uptime_seconds,
            settings: None,
        },
    };
    if formal.is_some() {
        watch.settings = formal;
    }
    if health.uptime_seconds.saturating_sub(watch.first_uptime) >= STEADY_SECONDS {
        startup.process = Some(watch.process);
        startup.settings = watch.settings;
        startup.restart_pending = reported;
        startup.down = false;
    } else {
        startup.watching = Some(watch);
    }
    startup
}

/// 服务确实没在跑：失败了，或者 systemd 正在隔几秒重试。还在加载（比如读一份大的 `GeoSite`）时不算
///
/// The service is really not running: it failed, or systemd is retrying every few seconds. Still loading (a large
/// `GeoSite`, say) does not count
fn did_not_come_up(service: &ServiceStatus) -> bool {
    service.active_state == "failed"
        || (service.active_state == "activating" && service.sub_state == "auto-restart")
}

/// 读到活着的 `KixDNS` 以后记下它报的事实 / After reading a live `KixDNS`, record what it reported
pub(super) async fn note_alive(state: &AppState, health: &Health, active: &ActiveConfig) {
    // 只有它报「没有设置等着重启」时才用得上正式文件 / The formal file is of use only when nothing waits for a restart
    let formal = if active.restart_pending.as_deref() == Some(&[]) {
        match state.config.current().await {
            Ok(formal) if formal.sha256 == active.sha256 => Some(settings_of(&formal.content)),
            _ => None,
        }
    } else {
        None
    };
    update(state, |startup| seen_alive(startup, health, active, formal)).await;
}

/// `KixDNS` 连不上时看一眼服务：起不来就记住 / With `KixDNS` unreachable, look at the service and remember a failure to
/// come up
async fn note_unreachable(state: &AppState) -> Option<ServiceStatus> {
    let service = state.operations.service_status().await.ok()?;
    if did_not_come_up(&service) {
        update(state, |startup| Startup {
            down: true,
            ..startup
        })
        .await;
    }
    Some(service)
}

/// 后台每 5 秒那一遍：没有人开着配置页、概览时也照样记 / The 5-second background pass: recorded even with no config page
/// or overview open
pub(super) async fn observe(state: &AppState) {
    match tokio::join!(state.control.health(), state.control.active_config()) {
        (Ok(health), Ok(active)) => note_alive(state, &health, &active).await,
        _ => {
            note_unreachable(state).await;
        }
    }
}

/// 一次新的尝试（启动、重启、退回，面板自己启动时也算）：上一次起不来的结论不算到它头上
///
/// A new attempt (a start, restart or rollback, and the panel's own start): the last attempt's failure is not held
/// against it
pub(super) async fn new_attempt(state: &AppState) {
    update(state, |startup| Startup {
        down: false,
        ..startup
    })
    .await;
}

/// 给服务状态用的：起不来（当下失败或重试，或者有记号、服务没停、`KixDNS` 连不上）
///
/// For the service status: not coming up (failing or being retried right now, or the mark set with the service not
/// stopped and `KixDNS` unreachable)
pub(super) async fn not_up(state: &AppState, service: &ServiceStatus) -> bool {
    if did_not_come_up(service) {
        update(state, |startup| Startup {
            down: true,
            ..startup
        })
        .await;
        return true;
    }
    service.active_state != "inactive"
        && load(state).await.is_some_and(|startup| startup.down)
        && state.control.active_config().await.is_err()
}

/// 可以退回的设置和它们上次启动时的值（`null` 是没写、用默认值）：参考进程最后报过要重启的、正式文件里仍和启动时
/// 不同的那几项；启动时的值不知道时没有
///
/// The settings that can go back with the values they last started with (`null` for unset, on the default): those the
/// reference process last reported as waiting for a restart that still differ from their starting values in the formal
/// file; none when the starting values are unknown
fn rollback_values(startup: &Startup, formal: &Value) -> Option<BTreeMap<String, Value>> {
    let started = startup.settings.as_ref()?;
    let now = settings_of(formal);
    let values: BTreeMap<String, Value> = startup
        .restart_pending
        .iter()
        .filter(|key| now.get(*key) != started.get(*key))
        .map(|key| {
            (
                key.clone(),
                started.get(key).cloned().unwrap_or(Value::Null),
            )
        })
        .collect();
    (!values.is_empty()).then_some(values)
}

/// `KixDNS` 连不上时给配置页、概览的，也是退回接口接受的条件：有起不来的记号、服务没被干净地停掉、还有可以退回的设置
///
/// For the config page and the overview while `KixDNS` is unreachable, and the condition the rollback accepts: the mark
/// set, the service not cleanly stopped, and settings to put back
pub(super) async fn offer(state: &AppState, formal: &Value) -> Option<BTreeMap<String, Value>> {
    unreachable(state, formal).await.1
}

/// `KixDNS` 连不上时：它是不是起不来（有记号、服务没被干净地停掉），以及能退回的设置。不能退回的起不来也照样说
///
/// With `KixDNS` unreachable: whether it is not coming up (the mark set, the service not cleanly stopped), and the
/// settings that can go back. A failure with nothing to put back is said all the same
pub(super) async fn unreachable(
    state: &AppState,
    formal: &Value,
) -> (bool, Option<BTreeMap<String, Value>>) {
    let Some(service) = note_unreachable(state).await else {
        return (false, None);
    };
    let Some(startup) = load(state).await else {
        return (false, None);
    };
    if !startup.down || service.active_state == "inactive" {
        return (false, None);
    }
    (true, rollback_values(&startup, formal))
}

/// 把那几项写回启动时的值，直接写进正式文件再重启（`KixDNS` 不在，没法让它先校验）。改的只是正式文件，也就是这次
/// 起不来的进程读的那份：其余内容是它重载接受过的，这几项是它跑过的。还在等着的待应用版本没校验过，不写进文件，
/// 而是改好同样几项，另存成新的待应用版本，等 `KixDNS` 回来照常校验、应用；没有生效的版本不带上
///
/// Write those settings back to their starting values straight into the formal file and restart (`KixDNS` is not there
/// to check it first). Only the formal file changes, the one the process that failed read: the rest is what it accepted
/// on reload and these values are what it ran with. A pending version still waiting was never checked, so it is not
/// written to the file; the same settings are changed in it and it is stored as a new pending version, to be checked
/// and applied as usual once `KixDNS` is back. A version that was refused is not carried along
pub(super) async fn roll_back(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<Json<RollbackResponse>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let _apply_guard = state.config_apply_lock.lock().await;
    if state.control.active_config().await.is_ok() {
        return Err(AppError::Conflict(
            "restart_rollback_missing",
            "KixDNS 已经在运行，不用退回".to_owned(),
        ));
    }
    let formal = state.config.current().await.map_err(map_config_error)?;
    let Some(values) = offer(&state, &formal.content).await else {
        return Err(AppError::Conflict(
            "restart_rollback_missing",
            "现在没有要退回的设置".to_owned(),
        ));
    };
    let desired = state.config.desired().await.map_err(map_config_error)?;
    let waiting = state
        .config
        .pending()
        .await
        .map_err(AppError::Internal)?
        .filter(|pending| pending.apply_state == CONFIG_APPLY_PENDING)
        .map(|_| desired.content.clone());
    let written = state
        .config
        .save_pending(
            with_values(formal.content.clone(), &values)?,
            &desired.sha256,
            "退回原来的设置".to_owned(),
            session.username.clone(),
        )
        .await
        .map_err(map_config_error)?;
    state
        .config
        .write_pending(written.version_id)
        .await
        .map_err(map_config_error)?;
    let result = match waiting {
        Some(content) => state
            .config
            .save_pending(
                with_values(content, &values)?,
                &written.sha256,
                "退回原来的设置（含待应用的修改）".to_owned(),
                session.username.clone(),
            )
            .await
            .map_err(map_config_error)?,
        None => written,
    };
    new_attempt(&state).await;
    state
        .operations
        .service_request(ServiceAction::Restart)
        .await
        .map_err(map_operation_error)?;
    // 请求途中读到的旧状态不算这一次的 / An old state read during the request does not count against this attempt
    new_attempt(&state).await;
    let reconcile_state = state.clone();
    tokio::spawn(async move {
        if let Err(error) = reconcile_pending(&reconcile_state).await {
            tracing::warn!(error = ?error, "退回设置重启后确认配置失败");
        }
    });
    state
        .database
        .audit(
            Some(session.username),
            "config.restart_rollback".to_owned(),
            format!(
                "{}，生成版本 #{}",
                values.keys().cloned().collect::<Vec<_>>().join("、"),
                result.version_id
            ),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(RollbackResponse {
        version_id: result.version_id,
    }))
}

/// 写进配置文件的是页面确认过的那个待应用版本 / The pending version the page confirmed is the one written
#[derive(Debug, Deserialize)]
pub(super) struct WritePendingRequest {
    version_id: i64,
}

/// 起不来、又没有可以退回的设置时，把还在等的待应用版本直接写进正式文件再重启：`KixDNS` 启动时读的是正式文件，
/// 起不来就轮不到待应用的版本（`KixDNS` 不在，没法让它先校验，页面照实说）。还是起不来的话，改好再写一次。
/// 能退回时、那一版已经在文件里时、待应用的版本换过时都不接受，和页面给不给这个按钮同一个判断
///
/// Not coming up with nothing to put back: write the pending version still waiting straight into the formal file and
/// restart. `KixDNS` reads the formal file when it starts, so while it does not come up the pending version never gets
/// its turn (`KixDNS` is not there to check it first, and the page says so). If it still does not come up, edit and
/// write again. Refused while a rollback is on offer, when that version is in the file already, or when the pending
/// version changed meanwhile: the same test as whether the page offers the button
pub(super) async fn restart_with_pending(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<WritePendingRequest>,
) -> AppResult<Json<RollbackResponse>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let _apply_guard = state.config_apply_lock.lock().await;
    let refuse = |message: String| {
        Err(AppError::Conflict(
            "restart_pending_write_needless",
            message,
        ))
    };
    if state.control.active_config().await.is_ok() {
        return refuse("KixDNS 已经在运行，不用写进配置文件".to_owned());
    }
    let formal = state.config.current().await.map_err(map_config_error)?;
    let (down, rollback) = unreachable(&state, &formal.content).await;
    if !down {
        return refuse("KixDNS 现在不是启动失败，没有写进配置文件".to_owned());
    }
    if rollback.is_some() {
        return refuse("现在可以退回原来的设置，没有写进配置文件".to_owned());
    }
    let pending = state
        .config
        .pending()
        .await
        .map_err(AppError::Internal)?
        .filter(|pending| pending.apply_state == CONFIG_APPLY_PENDING);
    let Some(pending) = pending.filter(|pending| pending.id == request.version_id) else {
        return refuse("待应用的版本已经变了，没有写进配置文件".to_owned());
    };
    if pending.sha256 == formal.sha256 {
        return refuse(format!("版本 #{} 已经写进配置文件了", pending.id));
    }
    state
        .config
        .write_pending(pending.id)
        .await
        .map_err(map_config_error)?;
    new_attempt(&state).await;
    state
        .operations
        .service_request(ServiceAction::Restart)
        .await
        .map_err(map_operation_error)?;
    new_attempt(&state).await;
    let reconcile_state = state.clone();
    tokio::spawn(async move {
        if let Err(error) = reconcile_pending(&reconcile_state).await {
            tracing::warn!(error = ?error, "写进配置文件重启后确认配置失败");
        }
    });
    state
        .database
        .audit(
            Some(session.username),
            "config.write_pending_restart".to_owned(),
            format!("#{}", pending.id),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(RollbackResponse {
        version_id: pending.id,
    }))
}

fn with_values(mut content: Value, values: &BTreeMap<String, Value>) -> AppResult<Value> {
    // 全用默认值的配置可以没有 settings：要写回非默认值时补上 / A config on all defaults may lack settings: add it
    // when a non-default value goes back
    let Some(settings) = content.as_object_mut().and_then(|root| {
        root.entry("settings")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
    }) else {
        return Err(AppError::Unprocessable(
            "restart_rollback_invalid",
            "这份配置的 settings 不是对象，没法退回".to_owned(),
        ));
    };
    for (key, value) in values {
        if value.is_null() {
            settings.remove(key);
        } else {
            settings.insert(key.clone(), value.clone());
        }
    }
    Ok(content)
}

fn settings_of(content: &Value) -> Map<String, Value> {
    content
        .get("settings")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn health(pid: u32, uptime_seconds: u64) -> Health {
        serde_json::from_value(json!({
            "protocol_version": 1, "status": "ok", "pid": pid, "version": "test", "upstream_commit": "test",
            "patchset": "p0", "started_at_unix": u64::from(pid) * 100, "uptime_seconds": uptime_seconds,
            "config_generation": 1, "capabilities": [],
        }))
        .unwrap()
    }

    fn active(restart_pending: Option<&[&str]>) -> ActiveConfig {
        let mut active = json!({
            "protocol_version": 1, "generation": 1, "sha256": "s", "loaded_at_unix": 0, "reload_sequence": 1,
            "last_reload": { "success": true, "error": null },
        });
        if let Some(pending) = restart_pending {
            active["restart_pending"] = json!(pending);
        }
        serde_json::from_value(active).unwrap()
    }

    fn settings(value: &Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    fn put_back(startup: &Startup, file: &Value) -> Option<BTreeMap<String, Value>> {
        rollback_values(startup, &json!({ "settings": file }))
    }

    /// 重启成功后很快又改了同一项：记下的是这次启动时的值；起不来的进程只应答一下，成不了参考
    /// The same setting changed again soon after a successful restart: the values recorded are this start's; a process
    /// that cannot come up answers only once and never becomes the reference
    #[test]
    fn the_reference_follows_each_process_that_came_up() {
        let a = json!({ "bind_udp": "0.0.0.0:53" });
        let b = json!({ "bind_udp": "0.0.0.0:5300" });
        let c = json!({ "bind_udp": "0.0.0.0:5301" });
        // 面板升级时 A 已经跑了很久：隔几秒看见两次就成参考 / A has run for long when the panel is upgraded: seen twice a
        // few seconds apart, it becomes the reference
        let mut startup = seen_alive(
            Startup::default(),
            &health(1, 86_400),
            &active(Some(&[])),
            Some(settings(&a)),
        );
        startup = seen_alive(
            startup,
            &health(1, 86_405),
            &active(Some(&[])),
            Some(settings(&a)),
        );
        assert_eq!(startup.settings, Some(settings(&a)));
        // 改成 B、重启：新进程刚起来时记下 B，一秒后马上又改成 C（重载了，名单不为空）；几秒后再被看见，B 是它的值
        // Changed to B and restarted: the new process records B on first sight, and a second later C is saved (reloaded,
        // so the list is not empty); seen again seconds later, B is its value
        startup = seen_alive(
            startup,
            &health(2, 1),
            &active(Some(&[])),
            Some(settings(&b)),
        );
        assert_eq!(startup.settings, Some(settings(&a)));
        startup = seen_alive(startup, &health(2, 5), &active(Some(&["bind_udp"])), None);
        assert_eq!(startup.settings, Some(settings(&b)));
        assert_eq!(startup.restart_pending, ["bind_udp"]);
        // 重启后 C 绑不上：起不来的进程只应答一下，成不了参考 / Restarted and C cannot bind: the failing process answers once and
        // never becomes the reference
        startup = seen_alive(
            startup,
            &health(3, 9),
            &active(Some(&[])),
            Some(settings(&c)),
        );
        startup.down = true;
        let b_back = Some(BTreeMap::from([(
            "bind_udp".to_owned(),
            json!("0.0.0.0:5300"),
        )]));
        assert_eq!(put_back(&startup, &c), b_back);
        // 改回 A 也退回 B / Changed back to A, it still goes back to B
        assert_eq!(put_back(&startup, &a), b_back);
        // 起不来的记号要稳的进程才清 / Only a steady process clears the mark
        assert!(seen_alive(startup.clone(), &health(4, 1), &active(Some(&[])), None).down);
        let later = seen_alive(
            seen_alive(startup, &health(4, 1), &active(Some(&[])), None),
            &health(4, 6),
            &active(Some(&[])),
            None,
        );
        assert!(!later.down);
    }

    /// 停着时改、存成待应用、启动：起来的进程读的是正式文件，应用待应用版本以后名单不为空，它照样成参考、带着启动时的值
    /// Edited while stopped, kept as pending, then started: the process reads the formal file, and after the pending
    /// version is applied the list is not empty; it still becomes the reference with its starting values
    #[test]
    fn a_start_with_a_pending_version_still_records_the_starting_values() {
        let a = json!({ "bind_udp": "0.0.0.0:53" });
        let mut startup = seen_alive(
            Startup::default(),
            &health(2, 0),
            &active(Some(&[])),
            Some(settings(&a)),
        );
        startup = seen_alive(startup, &health(2, 4), &active(Some(&["bind_udp"])), None);
        assert_eq!(startup.settings, Some(settings(&a)));
        assert_eq!(startup.restart_pending, ["bind_udp"]);
    }

    /// 稳稳起来却不知道启动时的值（旧内核不报名单）：它照样换成参考，以后起不来也不拿更早的值去退
    /// Steadily up with unknown starting values (an old kernel that reports no list): it still becomes the reference, and a
    /// later failure does not roll back to older values
    #[test]
    fn an_unknown_start_replaces_the_old_reference() {
        let a = json!({ "bind_udp": "0.0.0.0:53" });
        let mut startup = Startup {
            process: Some(Process {
                pid: 1,
                started_at: 100,
            }),
            settings: Some(settings(&a)),
            restart_pending: vec!["bind_udp".to_owned()],
            ..Startup::default()
        };
        startup = seen_alive(startup, &health(2, 30), &active(None), None);
        startup = seen_alive(startup, &health(2, 40), &active(None), None);
        startup.down = true;
        assert_eq!(startup.settings, None);
        assert_eq!(
            put_back(&startup, &json!({ "bind_udp": "0.0.0.0:5300" })),
            None
        );
    }

    /// 只退最后报过要重启、文件里仍和启动时不同的那几项；退过的、改回原值的不再提
    /// Only the settings last reported as waiting and still different in the file go back; ones already put back or
    /// changed back are not offered
    #[test]
    fn offers_only_the_reported_settings_that_still_differ() {
        let started = Startup {
            settings: Some(settings(&json!({ "bind_udp": "0.0.0.0:53", "min_ttl": 0 }))),
            restart_pending: vec!["bind_udp".to_owned(), "cache_capacity".to_owned()],
            ..Startup::default()
        };
        let file = json!({ "bind_udp": "0.0.0.0:5300", "cache_capacity": 30000, "min_ttl": 30 });
        assert_eq!(
            put_back(&started, &file),
            Some(BTreeMap::from([
                ("bind_udp".to_owned(), json!("0.0.0.0:53")),
                ("cache_capacity".to_owned(), Value::Null),
            ]))
        );
        assert_eq!(
            put_back(
                &started,
                &json!({ "bind_udp": "0.0.0.0:53", "min_ttl": 30 })
            ),
            None
        );
        assert_eq!(put_back(&Startup::default(), &file), None);
    }

    /// 起不来才算：失败、或者 systemd 正在重试；还在加载、停着都不算
    /// Only a service that does not come up counts: failed, or being retried by systemd; loading or stopped does not
    #[test]
    fn only_a_failed_or_retrying_service_did_not_come_up() {
        let status = |active: &str, sub: &str| ServiceStatus {
            unit: "kixdns.service".to_owned(),
            active_state: active.to_owned(),
            sub_state: sub.to_owned(),
            main_pid: 0,
            did_not_come_up: false,
        };
        assert!(did_not_come_up(&status("failed", "failed")));
        assert!(did_not_come_up(&status("activating", "auto-restart")));
        assert!(!did_not_come_up(&status("active", "running")));
        assert!(!did_not_come_up(&status("inactive", "dead")));
        assert!(!did_not_come_up(&status("activating", "start")));
    }
}
