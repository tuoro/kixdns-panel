//! 重启以后 `KixDNS` 起不来时，把改过、要重启才生效的设置退回它上次正常启动时的值。
//!
//! 这些设置（监听地址等）改了照常重载，`KixDNS` 却还用启动时的值，所以一份能重载的配置照样可能在重启时起不来，
//! 比如新的监听地址被别的程序占着。那时 `KixDNS` 连不上，保存只能存成待应用、等它回来，于是走进死路。
//!
//! 这里只记 `KixDNS` 活着时报来的事实：
//! - 它启动时用的设置：它在跑、没有设置等着重启、文件就是它在用的那份、而且已经稳稳跑了一阵时，文件里的设置就是；
//! - 它最后报的那几项要重启才生效的设置。
//!
//! 起没起来不靠谁发起了重启来判断（配置页、系统页、内核更新、主机重启都一样）：`KixDNS` 连不上、服务在失败或者
//! systemd 正在重试、正式文件里那几项又和启动时的值不同时，配置页就能把它们写回文件再重启。
//!
//! When `KixDNS` does not come back from a restart, put the settings that were changed and took a restart back to
//! the values it last started with. Those settings (listen addresses and the like) reload as usual while `KixDNS`
//! keeps the values it started with, so a config that reloads fine can still fail at a restart, say when the new
//! listen address is taken by another program. `KixDNS` is then unreachable, a save can only be kept as pending
//! until it returns, and there is no way out.
//!
//! Only facts reported by a live `KixDNS` are recorded here:
//! - the settings it started with: while it runs with nothing waiting for a restart, the file is the one in use and
//!   it has run steadily for a while, the file's settings are those;
//! - the settings it last reported as waiting for a restart.
//!
//! Whether it came up does not depend on who restarted it (the config page, the system page, a kernel update or a
//! host reboot alike): with `KixDNS` unreachable, the service failed or being retried by systemd, and those settings
//! in the formal file differing from their starting values, the config page can write them back and restart.

use std::collections::BTreeMap;

use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::auth::{authenticate, unix_timestamp, verify_csrf};
use crate::config_store::ConfigDocument;
use crate::control::ActiveConfig;
use crate::db::CONFIG_APPLY_PENDING;
use crate::error::{AppError, AppResult};
use crate::operations::{ServiceAction, ServiceStatus};

use super::{AppState, map_config_error, map_operation_error, reconcile_pending};

const STARTUP_KEY: &str = "kixdns_startup_settings_v1";
/// 配置刚载入的那几秒不拿来记启动时的值：内核先开控制通道、后绑监听，起不来的新进程也会短暂应答
///
/// The first seconds after a config load are not used to record the starting values: the kernel opens its control
/// channel before binding its listeners, so a new process that cannot come up may still answer briefly
const STEADY_SECONDS: i64 = 10;

/// `KixDNS` 上次正常启动时用的设置、那份文件的散列，和它最后报的要重启才生效的设置
///
/// The settings `KixDNS` last started with properly, the hash of that file, and the settings it last reported as
/// waiting for a restart
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
struct Startup {
    sha256: String,
    settings: Map<String, Value>,
    restart_pending: Vec<String>,
}

#[derive(Debug, Serialize)]
pub(super) struct RollbackResponse {
    version_id: i64,
}

async fn load(state: &AppState) -> Option<Startup> {
    let stored = state.database.get_setting(STARTUP_KEY).await.ok()??;
    serde_json::from_str(&stored).ok()
}

async fn store(state: &AppState, startup: &Startup) {
    if let Ok(serialized) = serde_json::to_string(startup)
        && let Err(error) = state
            .database
            .set_setting(STARTUP_KEY, serialized, unix_timestamp())
            .await
    {
        tracing::warn!(%error, "无法记下 KixDNS 启动时的设置");
    }
}

/// 读到一次活着的 `KixDNS` 以后记下它报的事实。`formal` 只在它就是正式文件时给（有待应用版本时读到的不是）
///
/// After reading a live `KixDNS`, record what it reported. `formal` is given only when it is the formal file (with a
/// pending version the document read is not)
pub(super) async fn note_live(
    state: &AppState,
    active: &ActiveConfig,
    formal: Option<&ConfigDocument>,
) {
    let Some(reported) = &active.restart_pending else {
        return;
    };
    let stored = load(state).await;
    let next = if reported.is_empty() {
        let steady = unix_timestamp()
            .saturating_sub(i64::try_from(active.loaded_at_unix).unwrap_or(i64::MAX))
            >= STEADY_SECONDS;
        match formal {
            Some(formal) if steady && active.sha256 == formal.sha256 => Startup {
                sha256: formal.sha256.clone(),
                settings: settings_of(&formal.content),
                restart_pending: Vec::new(),
            },
            _ => return,
        }
    } else {
        let Some(stored) = &stored else { return };
        Startup {
            sha256: stored.sha256.clone(),
            settings: stored.settings.clone(),
            restart_pending: reported.clone(),
        }
    };
    if stored.as_ref() != Some(&next) {
        store(state, &next).await;
    }
}

/// 可以退回的设置和它们上次启动时的值（`null` 是没写、用默认值）：`KixDNS` 最后报过要重启的、正式文件里仍和启动时
/// 不同的那几项
///
/// The settings that can go back with the values they last started with (`null` for unset, on the default): those
/// `KixDNS` last reported as waiting for a restart that still differ from their starting values in the formal file
fn rollback_values(startup: &Startup, formal: &Value) -> Option<BTreeMap<String, Value>> {
    let now = settings_of(formal);
    let values: BTreeMap<String, Value> = startup
        .restart_pending
        .iter()
        .filter(|key| now.get(*key) != startup.settings.get(*key))
        .map(|key| {
            (
                key.clone(),
                startup.settings.get(key).cloned().unwrap_or(Value::Null),
            )
        })
        .collect();
    (!values.is_empty()).then_some(values)
}

/// 服务确实没在跑：失败了，或者 systemd 正在隔几秒重试。还在加载（比如读一份大的 `GeoSite`）时不算
///
/// The service is really not running: it failed, or systemd is retrying every few seconds. Still loading (a large
/// `GeoSite`, say) does not count
fn did_not_come_up(service: &ServiceStatus) -> bool {
    service.active_state == "failed"
        || (service.active_state == "activating" && service.sub_state == "auto-restart")
}

/// `KixDNS` 连不上时给配置页的：服务确实起不来、又有可以退回的设置时才给 / For the config page while `KixDNS` is
/// unreachable: given only when the service really does not come up and there are settings to put back
pub(super) async fn offer(
    state: &AppState,
    formal: &ConfigDocument,
) -> Option<BTreeMap<String, Value>> {
    let startup = load(state).await?;
    let values = rollback_values(&startup, &formal.content)?;
    let service = state.operations.service_status().await.ok()?;
    did_not_come_up(&service).then_some(values)
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
    let Some(values) = load(&state)
        .await
        .and_then(|startup| rollback_values(&startup, &formal.content))
    else {
        return Err(AppError::Conflict(
            "restart_rollback_missing",
            "没有可以退回的设置：改过的设置已经和上次启动时一样".to_owned(),
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
            "退回重启前改过的设置".to_owned(),
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
                "退回重启前改过的设置（含待应用的修改）".to_owned(),
                session.username.clone(),
            )
            .await
            .map_err(map_config_error)?,
        None => written,
    };
    state
        .operations
        .service_request(ServiceAction::Restart)
        .await
        .map_err(map_operation_error)?;
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

    fn startup(settings: &Value, restart_pending: &[&str]) -> Startup {
        Startup {
            sha256: "s".to_owned(),
            settings: settings.as_object().cloned().unwrap_or_default(),
            restart_pending: restart_pending
                .iter()
                .map(|key| (*key).to_owned())
                .collect(),
        }
    }

    /// 只退最后报过要重启、文件里仍和启动时不同的那几项；退过的、改回原值的不再提
    /// Only the settings last reported as waiting and still different in the file go back; ones already put back or
    /// changed back are not offered
    #[test]
    fn offers_only_the_reported_settings_that_still_differ() {
        let started = startup(
            &json!({ "bind_udp": "0.0.0.0:53", "min_ttl": 0 }),
            &["bind_udp", "cache_capacity"],
        );
        let file = json!({ "settings": { "bind_udp": "0.0.0.0:5300", "cache_capacity": 30000, "min_ttl": 30 } });
        assert_eq!(
            rollback_values(&started, &file),
            Some(BTreeMap::from([
                ("bind_udp".to_owned(), json!("0.0.0.0:53")),
                ("cache_capacity".to_owned(), Value::Null),
            ]))
        );
        let put_back = json!({ "settings": { "bind_udp": "0.0.0.0:53", "min_ttl": 30 } });
        assert_eq!(rollback_values(&started, &put_back), None);
        assert_eq!(rollback_values(&startup(&json!({}), &[]), &file), None);
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
        };
        assert!(did_not_come_up(&status("failed", "failed")));
        assert!(did_not_come_up(&status("activating", "auto-restart")));
        assert!(!did_not_come_up(&status("active", "running")));
        assert!(!did_not_come_up(&status("inactive", "dead")));
        assert!(!did_not_come_up(&status("activating", "start")));
    }
}
