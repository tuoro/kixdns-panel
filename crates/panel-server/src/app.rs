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

use crate::auth::{
    CSRF_COOKIE, LoginLimiter, SESSION_COOKIE, SESSION_SECONDS, authenticate, hash_password,
    issue_session, token_hash, unix_timestamp, validate_password, validate_username, verify_csrf,
    verify_password,
};
use crate::config_store::{ConfigError, ConfigStore, MAX_CONFIG_BYTES};
use crate::control::{
    ActiveConfig, CacheFlushResult, ControlClient, ControlError, Health, MetricsSnapshot,
    ValidationResult,
};
use crate::db::{
    ConfigVersionSummary, Database, SessionRecord, UserRecord, ensure_database_parent,
};
use crate::error::{AppError, AppResult};
use crate::operations::{
    DnsDiagnostic, LogEntry, OperationError, Operations, ServiceAction, ServiceStatus,
};
use crate::updates::{
    InstalledVersion, UpdateError, UpdateInfo, UpdateManager, UpdateSettings, VersionCatalog,
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
    pub update_branch: String,
    pub update_artifact: String,
    pub installed_commit: Option<String>,
    pub kixdns_binary: PathBuf,
    pub kixdns_versions: PathBuf,
    pub web_root: PathBuf,
    pub secure_cookie: bool,
}

#[derive(Clone)]
pub struct AppState {
    database: Database,
    config: ConfigStore,
    control: ControlClient,
    operations: Operations,
    updates: UpdateManager,
    secure_cookie: bool,
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
struct RestoreConfigRequest {
    expected_sha256: String,
}

#[derive(Debug, Serialize)]
struct VersionsResponse {
    versions: Vec<ConfigVersionSummary>,
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
            branch: settings.update_branch,
            artifact: settings.update_artifact,
            installed_commit: settings.installed_commit,
            binary_path: settings.kixdns_binary,
            versions_path: settings.kixdns_versions,
        },
    )
    .map_err(|error| anyhow::anyhow!(error))?;
    let state = AppState {
        database,
        config,
        control: ControlClient::new(settings.control_socket),
        operations: Operations::new(settings.service_unit, settings.diagnostic_server)
            .map_err(|error| anyhow::anyhow!(error))?,
        updates,
        secure_cookie: settings.secure_cookie,
        login_limiter: Arc::new(LoginLimiter::default()),
        password_slots: Arc::new(Semaphore::new(4)),
        config_apply_lock: Arc::new(Mutex::new(())),
        dummy_password_hash: Arc::from(dummy_password_hash),
    };

    let api = Router::new()
        .route("/health", get(health))
        .route("/setup", get(setup_status).post(setup))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/session", get(session))
        .route("/overview", get(overview))
        .route("/config", get(get_config).put(save_config))
        .route("/config/validate", post(validate_config))
        .route("/config/versions", get(config_versions))
        .route("/config/versions/{id}/restore", post(restore_config))
        .route("/cache/flush", post(flush_cache))
        .route("/service", get(service_status))
        .route("/service/{action}", post(service_action))
        .route("/logs", get(logs))
        .route("/diagnostics/dns", post(dns_diagnostic))
        .route("/updates", get(check_updates))
        .route("/updates/apply", post(apply_update))
        .route("/kixdns/versions", get(kixdns_versions))
        .route(
            "/kixdns/versions/{commit}/install",
            post(install_kixdns_version),
        )
        .route(
            "/kixdns/versions/{commit}/activate",
            post(activate_kixdns_version),
        )
        .fallback(not_found)
        .with_state(state);

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
    jar: CookieJar,
    Json(request): Json<Credentials>,
) -> AppResult<(CookieJar, Json<AuthResponse>)> {
    state.login_limiter.check(address.ip())?;
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
    state.login_limiter.clear(address.ip());
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
    jar: CookieJar,
    Json(request): Json<Credentials>,
) -> AppResult<(CookieJar, Json<AuthResponse>)> {
    state.login_limiter.check(address.ip())?;
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
        state.login_limiter.record_failure(address.ip());
        return Err(AppError::Unauthorized);
    };
    state.login_limiter.clear(address.ip());
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
) -> AppResult<Json<crate::config_store::ConfigDocument>> {
    authenticate(&state.database, &jar).await?;
    state
        .config
        .current()
        .await
        .map(Json)
        .map_err(map_config_error)
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

async fn validate_config(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(content): Json<Value>,
) -> AppResult<Json<ValidationResult>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
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

async fn restore_config(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<RestoreConfigRequest>,
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
    let validation = state
        .control
        .validate(&candidate)
        .await
        .map_err(map_control_error)?;
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

async fn apply_update(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<Json<UpdateInfo>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let result = state
        .updates
        .apply(&state.operations, &state.control)
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
    jar: CookieJar,
) -> AppResult<Json<VersionCatalog>> {
    authenticate(&state.database, &jar).await?;
    state
        .updates
        .catalog()
        .await
        .map(Json)
        .map_err(map_update_error)
}

async fn install_kixdns_version(
    State(state): State<AppState>,
    Path(commit): Path<String>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<Json<InstalledVersion>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let result = state
        .updates
        .install_version(&commit, &state.operations, &state.control)
        .await
        .map_err(map_update_error)?;
    state
        .database
        .audit(
            Some(session.username),
            "kixdns.version.install".to_owned(),
            format!("安装并激活增强构建 {}", result.commit),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(result))
}

async fn activate_kixdns_version(
    State(state): State<AppState>,
    Path(commit): Path<String>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<Json<InstalledVersion>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let result = state
        .updates
        .activate_version(&commit, &state.operations, &state.control)
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
        UpdateError::Unsupported => {
            AppError::ServiceUnavailable("update_unsupported", "当前平台不支持自动更新".to_owned())
        }
    }
}

const fn default_log_limit() -> usize {
    200
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
mod tests {
    use std::net::{Ipv4Addr, SocketAddr};

    use axum::Router;
    use axum::body::{Body, to_bytes};
    use axum::extract::ConnectInfo;
    use axum::http::header::{
        CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, COOKIE, SET_COOKIE,
    };
    use axum::http::{Request, StatusCode};
    use serde_json::Value;
    use tempfile::{TempDir, tempdir};
    use tower::ServiceExt;

    use super::{AppSettings, build_app};

    struct AuthenticatedApp {
        _directory: TempDir,
        app: Router,
        cookies: String,
        csrf_token: String,
    }

    async fn test_app() -> (TempDir, Router) {
        let directory = tempdir().unwrap();
        let config_path = directory.path().join("pipeline.json");
        std::fs::write(&config_path, "{\"pipelines\":[]}").unwrap();
        let web_root = directory.path().join("web");
        std::fs::create_dir(&web_root).unwrap();
        std::fs::write(web_root.join("index.html"), "<main>KixDNS Panel</main>").unwrap();
        let app = build_app(AppSettings {
            bind: "127.0.0.1:0".parse().unwrap(),
            database_path: directory.path().join("panel.db"),
            config_path,
            control_socket: directory.path().join("admin.sock"),
            service_unit: "kixdns.service".to_owned(),
            diagnostic_server: "127.0.0.1:53".parse().unwrap(),
            update_repository: "tuoro/kixdns-panel".to_owned(),
            update_workflow: "build-enhanced.yml".to_owned(),
            update_branch: "main".to_owned(),
            update_artifact: "kixdns-enhanced-linux-x86_64".to_owned(),
            installed_commit: None,
            kixdns_binary: directory.path().join("kixdns"),
            kixdns_versions: directory.path().join("versions"),
            web_root,
            secure_cookie: false,
        })
        .await
        .unwrap();
        (directory, app)
    }

    async fn authenticated_app() -> AuthenticatedApp {
        let (directory, app) = test_app().await;
        let mut request = Request::post("/api/v1/setup")
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"username":"admin","password":"a-secure-password"}"#,
            ))
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from((Ipv4Addr::LOCALHOST, 42_000))));
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers().get(CACHE_CONTROL).unwrap(), "no-store");
        assert!(
            response
                .headers()
                .get(CONTENT_SECURITY_POLICY)
                .unwrap()
                .to_str()
                .unwrap()
                .contains("frame-ancestors 'none'")
        );
        let set_cookies = response
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        let cookies = set_cookies
            .iter()
            .map(|value| value.split(';').next().unwrap())
            .collect::<Vec<_>>()
            .join("; ");
        assert!(cookies.contains("kixdns_session="));
        assert!(cookies.contains("kixdns_csrf="));
        let session_cookie = set_cookies
            .iter()
            .find(|value| value.starts_with("kixdns_session="))
            .unwrap();
        let csrf_cookie = set_cookies
            .iter()
            .find(|value| value.starts_with("kixdns_csrf="))
            .unwrap();
        assert!(session_cookie.contains("HttpOnly"));
        assert!(session_cookie.contains("SameSite=Strict"));
        assert!(csrf_cookie.contains("SameSite=Strict"));
        assert!(!csrf_cookie.contains("HttpOnly"));
        let payload: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        let csrf_token = payload["csrf_token"].as_str().unwrap().to_owned();
        AuthenticatedApp {
            _directory: directory,
            app,
            cookies,
            csrf_token,
        }
    }

    #[tokio::test]
    async fn setup_issues_session_and_write_requires_csrf() {
        let context = authenticated_app().await;

        let unauthorized = context
            .app
            .clone()
            .oneshot(Request::get("/api/v1/config").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let forbidden = context
            .app
            .clone()
            .oneshot(
                Request::put("/api/v1/config")
                    .header(CONTENT_TYPE, "application/json")
                    .header(COOKIE, context.cookies.clone())
                    .body(Body::from(
                        r#"{"content":{"pipelines":[]},"expected_sha256":"invalid"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

        let logout = context
            .app
            .clone()
            .oneshot(
                Request::post("/api/v1/auth/logout")
                    .header(COOKIE, context.cookies)
                    .header("x-csrf-token", context.csrf_token)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(logout.status(), StatusCode::OK);
        assert_eq!(logout.headers().get_all(SET_COOKIE).iter().count(), 2);

        let deep_link = context
            .app
            .clone()
            .oneshot(Request::get("/config").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(deep_link.status(), StatusCode::OK);
        assert!(deep_link.headers().contains_key(CONTENT_SECURITY_POLICY));
        let body = to_bytes(deep_link.into_body(), 64 * 1024).await.unwrap();
        assert_eq!(body.as_ref(), b"<main>KixDNS Panel</main>");

        let unknown_api = context
            .app
            .oneshot(
                Request::get("/api/v1/not-an-endpoint")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unknown_api.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            unknown_api.headers().get(CONTENT_TYPE).unwrap(),
            "application/json"
        );
    }
}
