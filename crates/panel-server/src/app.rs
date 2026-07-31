use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use axum::body::Body;
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_SECURITY_POLICY, REFERRER_POLICY};
use axum::http::{HeaderMap, HeaderValue, Request};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::CookieJar;
use axum_extra::extract::cookie::{Cookie, SameSite};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::Duration;
use tokio::sync::{Mutex, Semaphore};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

mod geo;

use geo::{
    cleanup_geo_data, get_geo_data, get_geo_data_schedule, save_geo_data_schedule,
    spawn_geo_scheduler, sync_geo_data,
};

use crate::auth::{
    CSRF_COOKIE, LoginLimiter, SESSION_COOKIE, SESSION_SECONDS, TrustedProxies, authenticate,
    hash_password, issue_session, token_hash, unix_timestamp, validate_password, validate_username,
    verify_csrf, verify_password,
};
use crate::config_capabilities::ensure_config_supported;
use crate::config_store::{ConfigError, ConfigStore, MAX_CONFIG_BYTES};
use crate::control::{
    ActiveConfig, CacheFlushResult, ControlClient, ControlError, Health, MetricsSnapshot,
    QueryStatsSnapshot, StatsClearResult, ValidationResult,
};
use crate::db::{
    AuditPage, ConfigVersionSummary, Database, SessionRecord, UserRecord, ensure_database_parent,
};
use crate::error::{AppError, AppResult};
use crate::geo_data::{GeoDataError, GeoDataManager};
use crate::operations::{
    DnsDiagnostic, LogEntry, OperationError, Operations, ServiceAction, ServiceStatus,
};
use crate::updates::{
    InstalledVersion, UpdateError, UpdateInfo, UpdateManager, UpdateNotifications, UpdateSettings,
    VersionCatalog, VersionSource,
};

#[derive(Debug, Clone)]
pub struct AppSettings {
    pub bind: SocketAddr,
    pub database_path: PathBuf,
    pub config_path: PathBuf,
    pub control_socket: PathBuf,
    pub service_unit: String,
    pub diagnostic_server: SocketAddr,
    pub update_repository: String,
    pub update_workflow: String,
    pub update_release_workflow: String,
    pub update_branch: String,
    pub update_artifact: String,
    pub installed_commit: Option<String>,
    pub panel_installed_commit: Option<String>,
    pub panel_installed_release: Option<String>,
    pub kixdns_management_enabled: bool,
    pub kixdns_binary: PathBuf,
    pub kixdns_versions: PathBuf,
    pub geo_data_path: PathBuf,
    pub web_root: PathBuf,
    pub secure_cookie: bool,
    pub trusted_proxies: TrustedProxies,
}

#[derive(Clone)]
pub struct AppState {
    database: Database,
    config: ConfigStore,
    control: ControlClient,
    operations: Operations,
    updates: UpdateManager,
    geo_data: GeoDataManager,
    secure_cookie: bool,
    trusted_proxies: TrustedProxies,
    login_limiter: Arc<LoginLimiter>,
    password_slots: Arc<Semaphore>,
    config_apply_lock: Arc<Mutex<()>>,
    dummy_password_hash: Arc<str>,
}

#[derive(Debug, Deserialize)]
struct Credentials {
    username: String,
    password: String,
}

#[derive(Debug, Serialize)]
struct SetupStatus {
    required: bool,
}

#[derive(Debug, Serialize)]
struct UserView {
    id: i64,
    username: String,
}

#[derive(Debug, Serialize)]
struct AuthResponse {
    user: UserView,
    csrf_token: String,
    expires_at: i64,
}

#[derive(Debug, Deserialize)]
struct SaveConfigRequest {
    content: Value,
    expected_sha256: String,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Deserialize)]
struct ExpectedConfigRequest {
    expected_sha256: String,
}

#[derive(Debug, Serialize)]
struct VersionsResponse {
    versions: Vec<ConfigVersionSummary>,
}

#[derive(Debug, Serialize)]
struct DeleteConfigVersionResponse {
    deleted_id: i64,
}

#[derive(Debug, Serialize)]
struct ConfigDocumentResponse {
    content: Value,
    sha256: String,
    modified_at: i64,
    version_id: Option<i64>,
    runtime: ConfigRuntimeState,
}

#[derive(Debug, Serialize)]
struct ConfigRuntimeState {
    status: &'static str,
    active_sha256: Option<String>,
    generation: Option<u64>,
}

#[derive(Debug, Serialize)]
struct OverviewResponse {
    health: Health,
    active_config: ActiveConfig,
    metrics: MetricsSnapshot,
}

#[derive(Debug, Serialize)]
struct ConfigApplyResponse {
    version_id: i64,
    sha256: String,
    active_config: ActiveConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    validation: Option<ValidationResult>,
}

#[derive(Debug, Deserialize)]
struct LogsQuery {
    #[serde(default = "default_log_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize)]
struct AuditQuery {
    #[serde(default = "default_audit_limit")]
    limit: usize,
    before_id: Option<i64>,
    action_prefix: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct KixdnsVersionsQuery {
    #[serde(default)]
    source: VersionSource,
}

#[derive(Debug, Deserialize)]
struct QueryStatsQuery {
    #[serde(default = "default_stats_window")]
    window: u64,
    #[serde(default = "default_stats_limit")]
    limit: usize,
}

#[derive(Debug, Serialize)]
struct LogsResponse {
    entries: Vec<LogEntry>,
}

#[derive(Debug, Deserialize)]
struct DnsDiagnosticRequest {
    domain: String,
    #[serde(default = "default_record_type")]
    record_type: String,
}

/// 启动面板 HTTP 服务并等待关闭信号。
///
/// # Errors
///
/// 数据库初始化、配置导入、监听或 HTTP 服务失败时返回错误。
pub async fn run(settings: AppSettings) -> anyhow::Result<()> {
    let bind = settings.bind;
    let app = build_app(settings).await?;
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("监听面板地址失败：{bind}"))?;
    tracing::info!(address = %bind, "KixDNS Panel 已启动");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .context("HTTP 服务失败")
}

/// 初始化持久化状态并构建面板路由。
///
/// # Errors
///
/// 数据库、密码哈希或初始配置历史初始化失败时返回错误。
pub async fn build_app(settings: AppSettings) -> anyhow::Result<Router> {
    ensure_database_parent(&settings.database_path)?;
    let database = Database::open(settings.database_path).await?;
    let config = ConfigStore::new(settings.config_path, database.clone());
    config.initialize_history().await?;
    let dummy_password_hash = hash_password("dummy-password-for-timing".to_owned()).await?;
    let updates = UpdateManager::new(
        database.clone(),
        UpdateSettings {
            repository: settings.update_repository,
            workflow: settings.update_workflow,
            release_workflow: settings.update_release_workflow,
            branch: settings.update_branch,
            artifact: settings.update_artifact,
            installed_commit: settings.installed_commit,
            panel_installed_commit: settings.panel_installed_commit,
            panel_installed_release: settings.panel_installed_release,
            management_enabled: settings.kixdns_management_enabled,
            binary_path: settings.kixdns_binary,
            versions_path: settings.kixdns_versions,
        },
    )
    .map_err(|error| anyhow::anyhow!(error))?;
    let geo_data = GeoDataManager::new(database.clone(), &settings.geo_data_path)
        .map_err(|error| anyhow::anyhow!(error))?;
    let state = AppState {
        database,
        config,
        control: ControlClient::new(settings.control_socket),
        operations: Operations::new(settings.service_unit, settings.diagnostic_server)
            .map_err(|error| anyhow::anyhow!(error))?,
        updates,
        geo_data,
        secure_cookie: settings.secure_cookie,
        trusted_proxies: settings.trusted_proxies,
        login_limiter: Arc::new(LoginLimiter::default()),
        password_slots: Arc::new(Semaphore::new(4)),
        config_apply_lock: Arc::new(Mutex::new(())),
        dummy_password_hash: Arc::from(dummy_password_hash),
    };
    spawn_geo_scheduler(state.clone());
    let api = api_router(state);

    let index_file = settings.web_root.join("index.html");
    let web = ServeDir::new(settings.web_root)
        .append_index_html_on_directories(true)
        .fallback(ServeFile::new(index_file));

    Ok(Router::new()
        .nest("/api/v1", api)
        .fallback_service(web)
        .layer(axum::extract::DefaultBodyLimit::max(
            MAX_CONFIG_BYTES + 64 * 1024,
        ))
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn(security_headers)))
}

fn api_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/setup", get(setup_status).post(setup))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/session", get(session))
        .route("/overview", get(overview))
        .route("/stats/top", get(query_stats))
        .route("/stats/clear", post(clear_query_stats))
        .route("/config", get(get_config).put(save_config))
        .route("/config/validate", post(validate_config))
        .route("/config/geo-data", get(get_geo_data))
        .route("/config/geo-data/sync", post(sync_geo_data))
        .route("/config/geo-data/cleanup", post(cleanup_geo_data))
        .route(
            "/config/geo-data/schedule",
            get(get_geo_data_schedule).put(save_geo_data_schedule),
        )
        .route("/config/versions", get(config_versions))
        .route(
            "/config/versions/{id}",
            get(config_version).delete(delete_config_version),
        )
        .route("/config/versions/{id}/restore", post(restore_config))
        .route("/cache/flush", post(flush_cache))
        .route("/service", get(service_status))
        .route("/service/{action}", post(service_action))
        .route("/logs", get(logs))
        .route("/audit", get(audit_events))
        .route("/diagnostics/dns", post(dns_diagnostic))
        .route("/updates", get(check_updates))
        .route("/updates/status", get(update_notifications))
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
        .fallback(not_found)
        .with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({"status": "ok", "version": env!("CARGO_PKG_VERSION")}))
}

async fn setup_status(State(state): State<AppState>) -> AppResult<Json<SetupStatus>> {
    Ok(Json(SetupStatus {
        required: !state
            .database
            .has_users()
            .await
            .map_err(AppError::Internal)?,
    }))
}

async fn setup(
    State(state): State<AppState>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<Credentials>,
) -> AppResult<(CookieJar, Json<AuthResponse>)> {
    let client_ip = state.trusted_proxies.client_ip(address.ip(), &headers);
    state.login_limiter.check(client_ip, &request.username)?;
    if state
        .database
        .has_users()
        .await
        .map_err(AppError::Internal)?
    {
        return Err(AppError::Conflict(
            "setup_completed",
            "初始管理员已经创建".to_owned(),
        ));
    }
    let username = validate_username(&request.username)?;
    validate_password(&request.password)?;
    let _permit = state
        .password_slots
        .acquire()
        .await
        .map_err(|_| AppError::Internal(anyhow::anyhow!("密码任务池已关闭")))?;
    let password_hash = hash_password(request.password)
        .await
        .map_err(AppError::Internal)?;
    let user = state
        .database
        .create_first_user(username.clone(), password_hash, unix_timestamp())
        .await
        .map_err(|error| {
            if error.to_string().contains("setup_already_completed") {
                AppError::Conflict("setup_completed", "初始管理员已经创建".to_owned())
            } else {
                AppError::Internal(error)
            }
        })?;
    state.login_limiter.clear(client_ip, &username);
    state
        .database
        .audit(
            Some(username),
            "auth.setup".to_owned(),
            "创建初始管理员".to_owned(),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    create_authenticated_response(&state, jar, &user).await
}

async fn login(
    State(state): State<AppState>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<Credentials>,
) -> AppResult<(CookieJar, Json<AuthResponse>)> {
    let client_ip = state.trusted_proxies.client_ip(address.ip(), &headers);
    state.login_limiter.check(client_ip, &request.username)?;
    let username = validate_username(&request.username).ok();
    let user = match username {
        Some(username) => state
            .database
            .find_user(username)
            .await
            .map_err(AppError::Internal)?,
        None => None,
    };
    let _permit = state
        .password_slots
        .acquire()
        .await
        .map_err(|_| AppError::Internal(anyhow::anyhow!("密码任务池已关闭")))?;
    let encoded = match &user {
        Some(user) => user.password_hash.clone(),
        None => state.dummy_password_hash.to_string(),
    };
    let password_allowed = request.password.len() <= 256;
    let candidate = if password_allowed {
        request.password
    } else {
        "invalid-password-shape".to_owned()
    };
    let password_valid = verify_password(candidate, encoded)
        .await
        .map_err(AppError::Internal)?;
    let Some(user) = user.filter(|_| password_valid && password_allowed) else {
        state
            .login_limiter
            .record_failure(client_ip, &request.username);
        return Err(AppError::Unauthorized);
    };
    state.login_limiter.clear(client_ip, &user.username);
    state
        .database
        .audit(
            Some(user.username.clone()),
            "auth.login".to_owned(),
            "登录成功".to_owned(),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    create_authenticated_response(&state, jar, &user).await
}

async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<(CookieJar, Json<Value>)> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        state
            .database
            .delete_session(token_hash(cookie.value()))
            .await
            .map_err(AppError::Internal)?;
    }
    let jar = clear_auth_cookies(jar, state.secure_cookie);
    Ok((jar, Json(json!({"ok": true}))))
}

async fn session(State(state): State<AppState>, jar: CookieJar) -> AppResult<Json<AuthResponse>> {
    let session = authenticate(&state.database, &jar).await?;
    let csrf_token = jar
        .get(CSRF_COOKIE)
        .map(|cookie| cookie.value().to_owned())
        .filter(|token| token_hash(token) == session.csrf_hash)
        .ok_or(AppError::Unauthorized)?;
    Ok(Json(AuthResponse {
        user: session_user_view(&session),
        csrf_token,
        expires_at: session.expires_at,
    }))
}

async fn get_config(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<ConfigDocumentResponse>> {
    authenticate(&state.database, &jar).await?;
    let document = state.config.current().await.map_err(map_config_error)?;
    let runtime = match state.control.active_config().await {
        Ok(active) => ConfigRuntimeState {
            status: if active.sha256 == document.sha256 {
                "active"
            } else {
                "different"
            },
            active_sha256: Some(active.sha256),
            generation: Some(active.generation),
        },
        Err(_) => ConfigRuntimeState {
            status: "unavailable",
            active_sha256: None,
            generation: None,
        },
    };
    Ok(Json(ConfigDocumentResponse {
        content: document.content,
        sha256: document.sha256,
        modified_at: document.modified_at,
        version_id: document.version_id,
        runtime,
    }))
}

async fn overview(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<OverviewResponse>> {
    authenticate(&state.database, &jar).await?;
    let (health, active_config, metrics) = tokio::join!(
        state.control.health(),
        state.control.active_config(),
        state.control.metrics(),
    );
    Ok(Json(OverviewResponse {
        health: health.map_err(map_control_error)?,
        active_config: active_config.map_err(map_control_error)?,
        metrics: metrics.map_err(map_control_error)?,
    }))
}

async fn query_stats(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<QueryStatsQuery>,
) -> AppResult<Json<QueryStatsSnapshot>> {
    authenticate(&state.database, &jar).await?;
    if !matches!(query.window, 3_600 | 21_600 | 86_400) {
        return Err(AppError::BadRequest(
            "stats_window_invalid",
            "统计窗口仅支持 1、6 或 24 小时".to_owned(),
        ));
    }
    if !(1..=50).contains(&query.limit) {
        return Err(AppError::BadRequest(
            "stats_limit_invalid",
            "排行数量必须在 1 到 50 之间".to_owned(),
        ));
    }
    state
        .control
        .top_stats(query.window, query.limit)
        .await
        .map(Json)
        .map_err(map_control_error)
}

async fn clear_query_stats(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<Json<StatsClearResult>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    state
        .control
        .clear_stats()
        .await
        .map(Json)
        .map_err(map_control_error)
}

async fn validate_config(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(content): Json<Value>,
) -> AppResult<Json<ValidationResult>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let _apply_guard = state.config_apply_lock.lock().await;
    ensure_running_config_supported(&state, &content).await?;
    state
        .control
        .validate(&content)
        .await
        .map(Json)
        .map_err(map_control_error)
}

async fn save_config(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<SaveConfigRequest>,
) -> AppResult<Json<ConfigApplyResponse>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let _apply_guard = state.config_apply_lock.lock().await;
    ensure_running_config_supported(&state, &request.content).await?;
    let previous = state.config.current().await.map_err(map_config_error)?;
    let before_reload = state
        .control
        .active_config()
        .await
        .map_err(map_control_error)?;
    let validation = state
        .control
        .validate(&request.content)
        .await
        .map_err(map_control_error)?;
    ensure_validation_accepted(&validation)?;
    let result = state
        .config
        .save(
            request.content,
            &request.expected_sha256,
            request.message,
            session.username.clone(),
        )
        .await
        .map_err(map_config_error)?;
    let active_config = match state
        .control
        .wait_for_config(
            &result.sha256,
            before_reload.reload_sequence,
            std::time::Duration::from_secs(5),
        )
        .await
    {
        Ok(active) => active,
        Err(error) => {
            rollback_config(&state, previous.content, &result.sha256, &session.username).await?;
            return Err(AppError::Unprocessable(
                "reload_failed",
                format!("新配置未生效，已自动回滚：{error}"),
            ));
        }
    };
    state
        .database
        .audit(
            Some(session.username),
            "config.save".to_owned(),
            format!("保存配置版本 #{}", result.version_id),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(ConfigApplyResponse {
        version_id: result.version_id,
        sha256: result.sha256,
        active_config,
        validation: Some(validation),
    }))
}

async fn config_versions(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<VersionsResponse>> {
    authenticate(&state.database, &jar).await?;
    let versions = state.config.versions().await.map_err(AppError::Internal)?;
    Ok(Json(VersionsResponse { versions }))
}

async fn config_version(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    jar: CookieJar,
) -> AppResult<Json<crate::config_store::ConfigVersionDetail>> {
    authenticate(&state.database, &jar).await?;
    state
        .config
        .version(id)
        .await
        .map(Json)
        .map_err(map_config_error)
}

async fn restore_config(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<ExpectedConfigRequest>,
) -> AppResult<Json<ConfigApplyResponse>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let _apply_guard = state.config_apply_lock.lock().await;
    let previous = state.config.current().await.map_err(map_config_error)?;
    let before_reload = state
        .control
        .active_config()
        .await
        .map_err(map_control_error)?;
    let candidate = state
        .config
        .version_content(id)
        .await
        .map_err(map_config_error)?;
    ensure_running_config_supported(&state, &candidate).await?;
    let validation = state
        .control
        .validate(&candidate)
        .await
        .map_err(map_control_error)?;
    ensure_validation_accepted(&validation)?;
    let result = state
        .config
        .restore(id, &request.expected_sha256, session.username.clone())
        .await
        .map_err(map_config_error)?;
    let active_config = match state
        .control
        .wait_for_config(
            &result.sha256,
            before_reload.reload_sequence,
            std::time::Duration::from_secs(5),
        )
        .await
    {
        Ok(active) => active,
        Err(error) => {
            rollback_config(&state, previous.content, &result.sha256, &session.username).await?;
            return Err(AppError::Unprocessable(
                "reload_failed",
                format!("历史配置未生效，已自动回滚：{error}"),
            ));
        }
    };
    state
        .database
        .audit(
            Some(session.username),
            "config.restore".to_owned(),
            format!("恢复配置版本 #{id}，生成版本 #{}", result.version_id),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(ConfigApplyResponse {
        version_id: result.version_id,
        sha256: result.sha256,
        active_config,
        validation: Some(validation),
    }))
}

async fn delete_config_version(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<ExpectedConfigRequest>,
) -> AppResult<Json<DeleteConfigVersionResponse>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    state
        .config
        .delete_version(id, &request.expected_sha256)
        .await
        .map_err(map_config_error)?;
    state
        .database
        .audit(
            Some(session.username),
            "config.version.delete".to_owned(),
            format!("删除配置版本 #{id}"),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(DeleteConfigVersionResponse { deleted_id: id }))
}

async fn flush_cache(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<Json<CacheFlushResult>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let result = state
        .control
        .flush_cache()
        .await
        .map_err(map_control_error)?;
    state
        .database
        .audit(
            Some(session.username),
            "cache.flush".to_owned(),
            format!(
                "清理响应缓存 {} 项、规则缓存 {} 项",
                result.response_entries_before, result.rule_entries_before
            ),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(result))
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
) -> AppResult<Json<LogsResponse>> {
    authenticate(&state.database, &jar).await?;
    let entries = state
        .operations
        .logs(query.limit)
        .await
        .map_err(map_operation_error)?;
    Ok(Json(LogsResponse { entries }))
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
    let result = state
        .operations
        .dns_query(request.domain, request.record_type.clone())
        .await
        .map_err(map_operation_error)?;
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

async fn rollback_config(
    state: &AppState,
    previous_content: Value,
    failed_sha256: &str,
    actor: &str,
) -> AppResult<()> {
    let current_sequence = state
        .control
        .active_config()
        .await
        .map_or(0, |active| active.reload_sequence);
    let rollback = state
        .config
        .save(
            previous_content,
            failed_sha256,
            "热加载失败自动回滚".to_owned(),
            actor.to_owned(),
        )
        .await
        .map_err(map_config_error)?;
    state
        .control
        .wait_for_config(
            &rollback.sha256,
            current_sequence,
            std::time::Duration::from_secs(5),
        )
        .await
        .map_err(|error| {
            AppError::Internal(anyhow::anyhow!("自动回滚后 KixDNS 未恢复：{error}"))
        })?;
    state
        .database
        .audit(
            Some(actor.to_owned()),
            "config.auto_rollback".to_owned(),
            format!("自动回滚生成配置版本 #{}", rollback.version_id),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)
}

async fn ensure_running_config_supported(state: &AppState, content: &Value) -> AppResult<()> {
    let health = state.control.health().await.map_err(map_control_error)?;
    ensure_config_supported(content, &health.capabilities)
        .map_err(|error| AppError::Unprocessable("unsupported_config_fields", error.to_string()))
}

fn ensure_validation_accepted(validation: &ValidationResult) -> AppResult<()> {
    if validation.valid {
        Ok(())
    } else {
        Err(AppError::Unprocessable(
            "config_validation_failed",
            "KixDNS 拒绝该配置，请先修正校验错误".to_owned(),
        ))
    }
}

async fn create_authenticated_response(
    state: &AppState,
    jar: CookieJar,
    user: &UserRecord,
) -> AppResult<(CookieJar, Json<AuthResponse>)> {
    let (session_token, csrf_token, expires_at) = issue_session(&state.database, user)
        .await
        .map_err(AppError::Internal)?;
    let jar = jar
        .add(auth_cookie(
            SESSION_COOKIE,
            session_token,
            true,
            state.secure_cookie,
        ))
        .add(auth_cookie(
            CSRF_COOKIE,
            csrf_token.clone(),
            false,
            state.secure_cookie,
        ));
    Ok((
        jar,
        Json(AuthResponse {
            user: UserView {
                id: user.id,
                username: user.username.clone(),
            },
            csrf_token,
            expires_at,
        }),
    ))
}

fn auth_cookie(
    name: &'static str,
    value: String,
    http_only: bool,
    secure: bool,
) -> Cookie<'static> {
    Cookie::build((name, value))
        .path("/")
        .http_only(http_only)
        .same_site(SameSite::Strict)
        .secure(secure)
        .max_age(Duration::seconds(SESSION_SECONDS))
        .build()
}

fn clear_auth_cookies(jar: CookieJar, secure: bool) -> CookieJar {
    [SESSION_COOKIE, CSRF_COOKIE]
        .into_iter()
        .fold(jar, |jar, name| {
            jar.remove(
                Cookie::build((name, ""))
                    .path("/")
                    .secure(secure)
                    .max_age(Duration::ZERO)
                    .build(),
            )
        })
}

fn session_user_view(session: &SessionRecord) -> UserView {
    UserView {
        id: session.user_id,
        username: session.username.clone(),
    }
}

fn map_config_error(error: ConfigError) -> AppError {
    match error {
        ConfigError::NotFound => {
            AppError::NotFound("config_not_found", "配置文件不存在".to_owned())
        }
        ConfigError::Conflict => AppError::Conflict(
            "config_conflict",
            "配置已被其他操作修改，请刷新后重试".to_owned(),
        ),
        ConfigError::ActiveVersion => AppError::Conflict(
            "config_version_active",
            "当前生效版本不能删除，请先恢复其他版本".to_owned(),
        ),
        ConfigError::Invalid(message) => AppError::BadRequest("config_invalid", message),
        ConfigError::Internal(error) => AppError::Internal(error),
    }
}

fn map_control_error(error: ControlError) -> AppError {
    match error {
        ControlError::Rejected(message) => AppError::Unprocessable("kixdns_rejected", message),
        ControlError::Unavailable(message) => {
            AppError::ServiceUnavailable("kixdns_unavailable", message)
        }
        ControlError::Protocol(message) => {
            AppError::ServiceUnavailable("kixdns_protocol_error", message)
        }
        ControlError::Unsupported(message) => {
            AppError::NotFound("kixdns_capability_unsupported", message)
        }
    }
}

fn default_stats_window() -> u64 {
    86_400
}

fn default_stats_limit() -> usize {
    20
}

fn map_geo_data_error(error: GeoDataError) -> AppError {
    match error {
        GeoDataError::Invalid(message) => AppError::BadRequest("geo_data_invalid", message),
        GeoDataError::Download(message) => {
            AppError::Unprocessable("geo_data_download_failed", message)
        }
        GeoDataError::Internal(error) => AppError::Internal(error),
    }
}

fn map_operation_error(error: OperationError) -> AppError {
    match error {
        OperationError::Invalid(message) => AppError::BadRequest("operation_invalid", message),
        #[cfg(not(unix))]
        OperationError::Unsupported => {
            AppError::ServiceUnavailable("operation_unsupported", "当前平台不支持此操作".to_owned())
        }
        OperationError::Failed(message) => {
            AppError::ServiceUnavailable("operation_failed", message)
        }
    }
}

fn map_update_error(error: UpdateError) -> AppError {
    match error {
        UpdateError::Invalid(message) => AppError::BadRequest("update_invalid", message),
        UpdateError::Network(message) => {
            AppError::ServiceUnavailable("update_network_error", message)
        }
        UpdateError::Verification(message) => {
            AppError::Unprocessable("update_verification_failed", message)
        }
        UpdateError::Install(message) => {
            AppError::ServiceUnavailable("update_install_failed", message)
        }
        UpdateError::IncompatibleConfig(message) => {
            AppError::Unprocessable("unsupported_config_fields", message)
        }
        UpdateError::Unsupported => {
            AppError::ServiceUnavailable("update_unsupported", "当前平台不支持自动更新".to_owned())
        }
    }
}

const fn default_log_limit() -> usize {
    200
}

const fn default_audit_limit() -> usize {
    50
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

fn default_record_type() -> String {
    "A".to_owned()
}

async fn not_found() -> AppError {
    AppError::NotFound("not_found", "端点不存在".to_owned())
}

async fn security_headers(request: Request<Body>, next: Next) -> Response {
    let is_api = request.uri().path().starts_with("/api/");
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        ),
    );
    if is_api {
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(%error, "监听 Ctrl+C 失败");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => tracing::error!(%error, "监听 SIGTERM 失败"),
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}

#[cfg(test)]
#[path = "app/tests.rs"]
mod tests;
