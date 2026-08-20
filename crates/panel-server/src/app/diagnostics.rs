use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::CookieJar;
use serde::Deserialize;

use crate::auth::{authenticate, unix_timestamp, verify_csrf};
use crate::db::AuditPage;
use crate::error::{AppError, AppResult};
use crate::operations::{DnsDiagnostic, LogPage, ServiceAction, ServiceStatus};

use super::{
    AppState, map_config_error, map_control_error, map_operation_error, reconcile_pending,
};

const DIAGNOSTICS_TRACE_CAPABILITY: &str = "diagnostics_trace_v1";

#[derive(Debug, Deserialize)]
struct LogsQuery {
    #[serde(default = "default_log_limit")]
    limit: usize,
    before: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AuditQuery {
    #[serde(default = "default_audit_limit")]
    limit: usize,
    before_id: Option<i64>,
    action_prefix: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DnsDiagnosticRequest {
    domain: String,
    #[serde(default = "default_record_type")]
    record_type: String,
}

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/service", get(service_status))
        .route("/service/{action}", post(service_action))
        .route("/logs", get(logs))
        .route("/audit", get(audit_events))
        .route("/diagnostics/dns", post(dns_diagnostic))
}

async fn service_status(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<ServiceStatus>> {
    authenticate(&state.database, &jar).await?;
    state
        .operations
        .service_status()
        .await
        .map(Json)
        .map_err(map_operation_error)
}

async fn service_action(
    State(state): State<AppState>,
    Path(action): Path<String>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<Json<ServiceStatus>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let parsed = ServiceAction::parse(&action).map_err(map_operation_error)?;
    let status = state
        .operations
        .service_action(parsed)
        .await
        .map_err(map_operation_error)?;
    if matches!(parsed, ServiceAction::Start | ServiceAction::Restart) {
        let reconcile_state = state.clone();
        tokio::spawn(async move {
            if let Err(error) = reconcile_pending(&reconcile_state).await {
                tracing::warn!(error = ?error, "服务启动后应用待应用配置失败");
            }
        });
    }
    state
        .database
        .audit(
            Some(session.username),
            format!("service.{action}"),
            format!("服务状态：{}/{}", status.active_state, status.sub_state),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(status))
}

async fn logs(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<LogsQuery>,
) -> AppResult<Json<LogPage>> {
    authenticate(&state.database, &jar).await?;
    if query.before.as_deref().is_some_and(|cursor| {
        cursor.is_empty()
            || cursor.len() > 4_096
            || !cursor.bytes().all(|byte| byte.is_ascii_graphic())
    }) {
        return Err(AppError::BadRequest(
            "log_cursor_invalid",
            "日志游标无效".to_owned(),
        ));
    }
    state
        .operations
        .logs(query.limit, query.before.as_deref())
        .await
        .map(Json)
        .map_err(map_operation_error)
}

async fn audit_events(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<AuditQuery>,
) -> AppResult<Json<AuditPage>> {
    authenticate(&state.database, &jar).await?;
    if query.before_id.is_some_and(|id| id <= 0) {
        return Err(AppError::BadRequest(
            "audit_query_invalid",
            "审计游标无效".to_owned(),
        ));
    }
    let action_prefix = normalize_action_prefix(query.action_prefix)?;
    state
        .database
        .list_audit_events(query.limit, query.before_id, action_prefix)
        .await
        .map(Json)
        .map_err(AppError::Internal)
}

async fn dns_diagnostic(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<DnsDiagnosticRequest>,
) -> AppResult<Json<DnsDiagnostic>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let supports_trace = state.control.health().await.is_ok_and(|health| {
        health
            .capabilities
            .iter()
            .any(|capability| capability == DIAGNOSTICS_TRACE_CAPABILITY)
    });
    let result = if supports_trace {
        let trace = state
            .control
            .diagnostic_trace(&request.domain, &request.record_type)
            .await
            .map_err(map_control_error)?;
        DnsDiagnostic {
            server: "KixDNS 内部执行链".to_owned(),
            domain: trace.domain,
            record_type: trace.record_type,
            response_code: trace.response_code,
            elapsed_ms: trace.elapsed_ms,
            truncated: trace.truncated,
            answers: trace.answers,
            trace_supported: true,
            trace_truncated: trace.trace_truncated,
            trace: trace.trace,
        }
    } else {
        let config = state.config.current().await.map_err(map_config_error)?;
        state
            .operations
            .dns_query(&config.content, request.domain, request.record_type.clone())
            .await
            .map_err(map_operation_error)?
    };
    state
        .database
        .audit(
            Some(session.username),
            "diagnostic.dns".to_owned(),
            format!("执行 {} 查询", request.record_type),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(result))
}

const fn default_log_limit() -> usize {
    200
}

const fn default_audit_limit() -> usize {
    50
}

fn default_record_type() -> String {
    "A".to_owned()
}

fn normalize_action_prefix(value: Option<String>) -> AppResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(AppError::BadRequest(
            "audit_query_invalid",
            "审计动作筛选无效".to_owned(),
        ));
    }
    Ok(Some(value.to_ascii_lowercase()))
}
