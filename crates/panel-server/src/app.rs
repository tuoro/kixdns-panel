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
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use axum_extra::extract::CookieJar;
use axum_extra::extract::cookie::{Cookie, SameSite};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::Duration;
use tokio::sync::{Mutex, Semaphore};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

const OVERVIEW_SNAPSHOT_KEY: &str = "overview_snapshot_v1";
const STATS_SNAPSHOT_1H_KEY: &str = "stats_snapshot_1h_v1";
const STATS_SNAPSHOT_6H_KEY: &str = "stats_snapshot_6h_v1";
const STATS_SNAPSHOT_24H_KEY: &str = "stats_snapshot_24h_v1";

mod diagnostics;
mod geo;
mod updates;

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
use crate::config_store::{ConfigError, ConfigStore, MAX_CONFIG_BYTES, SaveResult};
use crate::control::{
    ActiveConfig, CacheFlushResult, ControlClient, ControlError, Health, MetricsSnapshot,
    QueryStatsSnapshot, StatsClearResult, ValidationResult,
};
use crate::db::{
    CONFIG_APPLY_APPLIED, CONFIG_APPLY_FAILED, CONFIG_APPLY_PENDING, ConfigVersionSummary,
    Database, MetricSample, SessionRecord, UserRecord, ensure_database_parent,
};
use crate::error::{AppError, AppResult};
use crate::geo_data::{GeoDataError, GeoDataManager};
use crate::operations::{OperationError, Operations};
use crate::updates::{UpdateError, UpdateManager, UpdateSettings};

#[derive(Debug, Clone)]
pub struct AppSettings {
    pub bind: SocketAddr,
    pub database_path: PathBuf,
    pub config_path: PathBuf,
    pub control_socket: PathBuf,
    pub service_unit: String,
    pub service_helper_socket: PathBuf,
    pub diagnostic_server: SocketAddr,
    pub update_repository: String,
    pub update_workflow: String,
    pub update_release_workflow: String,
    pub update_branch: String,
    pub update_artifact: String,
    pub installed_commit: Option<String>,
    pub installed_source_id: Option<u64>,
    pub panel_installed_commit: Option<String>,
    pub panel_installed_release: Option<String>,
    pub kixdns_binary: PathBuf,
    pub kixdns_versions: PathBuf,
    pub bundled_metadata: PathBuf,
    pub github_token_path: PathBuf,
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

#[derive(Debug, Deserialize)]
struct DeleteConfigVersionsRequest {
    ids: Vec<i64>,
    expected_sha256: String,
}

#[derive(Debug, Serialize)]
struct DeleteConfigVersionsResponse {
    deleted_ids: Vec<i64>,
}

#[derive(Debug, Serialize)]
struct ConfigDocumentResponse {
    content: Value,
    sha256: String,
    modified_at: i64,
    version_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending: Option<PendingConfigResponse>,
    runtime: ConfigRuntimeState,
}

#[derive(Debug, Serialize)]
struct PendingConfigResponse {
    version_id: i64,
    sha256: String,
    message: String,
    actor: String,
    created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct ConfigRuntimeState {
    status: &'static str,
    active_sha256: Option<String>,
    generation: Option<u64>,
    apply_state: String,
    declared_capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OverviewResponse {
    health: Health,
    active_config: ActiveConfig,
    metrics: MetricsSnapshot,
    live: bool,
    #[serde(default)]
    service_active: Option<bool>,
    captured_at_unix: u64,
    /// 请求量趋势。快照里也会带上一份，但读取时总是用当前采样覆盖——
    /// 内核不可用时计数器停在原地，采样库却仍然是最新的。
    ///
    /// The request trend. A copy lands in the snapshot as well, but a read
    /// always overwrites it from the sample store: when the kernel is
    /// unreachable its counters are frozen while the samples are still current.
    #[serde(default)]
    trend: RequestTrend,
}

/// 一个整点桶内的请求数。
///
/// The number of requests inside one hourly bucket.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrendPoint {
    start_unix: i64,
    requests: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RequestTrend {
    bucket_seconds: i64,
    /// 只包含采样真正覆盖到的桶，按时间升序。面板刚装上时这里比 24 条短，
    /// 补零会把「还没有数据」画成「那时没有请求」。
    ///
    /// Only the buckets the samples actually cover, oldest first. This is
    /// shorter than 24 entries on a freshly installed panel: padding with
    /// zeros would draw "no data yet" as "no requests then".
    points: Vec<TrendPoint>,
    /// 上列各桶之和，也就是覆盖到的那段时间里的请求总数。
    ///
    /// The sum of the buckets above: requests over the covered period.
    total: u64,
}

#[derive(Debug, Serialize)]
struct ConfigApplyResponse {
    version_id: i64,
    sha256: String,
    apply_state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    apply_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_config: Option<ActiveConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    validation: Option<ValidationResult>,
}

#[derive(Debug, Deserialize)]
struct QueryStatsQuery {
    #[serde(default = "default_stats_window")]
    window: u64,
    #[serde(default = "default_stats_limit")]
    limit: usize,
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
            installed_source_id: settings.installed_source_id,
            panel_installed_commit: settings.panel_installed_commit,
            panel_installed_release: settings.panel_installed_release,
            binary_path: settings.kixdns_binary,
            versions_path: settings.kixdns_versions,
            bundled_metadata: settings.bundled_metadata,
            github_token_path: settings.github_token_path,
        },
    )
    .map_err(|error| anyhow::anyhow!(error))?;
    updates
        .initialize_installed_version()
        .await
        .map_err(|error| anyhow::anyhow!(error))?;
    let geo_data = GeoDataManager::new(database.clone(), &settings.geo_data_path)
        .map_err(|error| anyhow::anyhow!(error))?;
    let state = AppState {
        database,
        config,
        control: ControlClient::new(settings.control_socket),
        operations: Operations::new(
            settings.service_unit,
            settings.service_helper_socket,
            settings.diagnostic_server,
        )
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
    spawn_config_reconciler(state.clone());
    spawn_metrics_sampler(state.clone());
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
        .route("/config/versions/bulk", delete(delete_config_versions))
        .route(
            "/config/versions/{id}",
            get(config_version).delete(delete_config_version),
        )
        .route("/config/versions/{id}/restore", post(restore_config))
        .route("/cache/flush", post(flush_cache))
        .merge(diagnostics::routes())
        .merge(updates::routes())
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
        return Err(AppError::InvalidCredentials);
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
    let document = state.config.desired().await.map_err(map_config_error)?;
    let pending = state.config.pending().await.map_err(AppError::Internal)?;
    let declared_capabilities = state
        .updates
        .active_capabilities()
        .await
        .unwrap_or_default();
    let pending_status = pending
        .as_ref()
        .map(|summary| match summary.apply_state.as_str() {
            CONFIG_APPLY_FAILED => "failed",
            _ => "pending",
        });
    let runtime = match state.control.active_config().await {
        Ok(active) => ConfigRuntimeState {
            status: pending_status.unwrap_or(if active.sha256 == document.sha256 {
                "active"
            } else {
                "different"
            }),
            active_sha256: Some(active.sha256),
            generation: Some(active.generation),
            apply_state: pending.as_ref().map_or_else(
                || "active".to_owned(),
                |summary| summary.apply_state.clone(),
            ),
            declared_capabilities: declared_capabilities.clone(),
            pending_error: pending
                .as_ref()
                .and_then(|summary| summary.apply_error.clone()),
        },
        Err(_) => ConfigRuntimeState {
            status: pending_status.unwrap_or("unavailable"),
            active_sha256: None,
            generation: None,
            apply_state: pending.as_ref().map_or_else(
                || "unavailable".to_owned(),
                |summary| summary.apply_state.clone(),
            ),
            declared_capabilities,
            pending_error: pending
                .as_ref()
                .and_then(|summary| summary.apply_error.clone()),
        },
    };
    Ok(Json(ConfigDocumentResponse {
        content: document.content,
        sha256: document.sha256,
        modified_at: document.modified_at,
        version_id: document.version_id,
        pending: pending.map(|summary| PendingConfigResponse {
            version_id: summary.id,
            sha256: summary.sha256,
            message: summary.message,
            actor: summary.actor,
            created_at: summary.created_at,
            error: summary.apply_error,
        }),
        runtime,
    }))
}

async fn overview(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<OverviewResponse>> {
    authenticate(&state.database, &jar).await?;
    let results = tokio::join!(
        state.control.health(),
        state.control.active_config(),
        state.control.metrics(),
    );
    match results {
        (Ok(health), Ok(active_config), Ok(metrics)) => {
            let snapshot = OverviewResponse {
                health,
                active_config,
                metrics,
                live: true,
                service_active: Some(true),
                captured_at_unix: u64::try_from(unix_timestamp()).unwrap_or_default(),
                trend: load_request_trend(&state).await,
            };
            if let Ok(serialized) = serde_json::to_string(&snapshot)
                && let Err(error) = state
                    .database
                    .set_setting(OVERVIEW_SNAPSHOT_KEY, serialized, unix_timestamp())
                    .await
            {
                tracing::warn!(%error, "无法保存概览运行快照");
            }
            Ok(Json(snapshot))
        }
        (health, active_config, metrics) => {
            if let Ok(Some(serialized)) = state.database.get_setting(OVERVIEW_SNAPSHOT_KEY).await {
                match serde_json::from_str::<OverviewResponse>(&serialized) {
                    Ok(mut snapshot) => {
                        snapshot.live = false;
                        snapshot.service_active = state
                            .operations
                            .service_status()
                            .await
                            .ok()
                            .map(|status| status.active_state == "active");
                        snapshot.trend = load_request_trend(&state).await;
                        return Ok(Json(snapshot));
                    }
                    Err(error) => tracing::warn!(%error, "忽略损坏的概览运行快照"),
                }
            }
            let error = health
                .err()
                .or_else(|| active_config.err())
                .or_else(|| metrics.err())
                .expect("失败分支至少包含一个控制接口错误");
            Err(map_control_error(error))
        }
    }
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
    let snapshot_key = match query.window {
        3_600 => STATS_SNAPSHOT_1H_KEY,
        21_600 => STATS_SNAPSHOT_6H_KEY,
        86_400 => STATS_SNAPSHOT_24H_KEY,
        _ => unreachable!("统计窗口已经验证"),
    };
    match state.control.top_stats(query.window, query.limit).await {
        Ok(mut snapshot) => {
            snapshot.live = true;
            snapshot.captured_at_unix = Some(u64::try_from(unix_timestamp()).unwrap_or_default());
            if let Ok(serialized) = serde_json::to_string(&snapshot)
                && let Err(error) = state
                    .database
                    .set_setting(snapshot_key, serialized, unix_timestamp())
                    .await
            {
                tracing::warn!(%error, "无法保存查询排行快照");
            }
            Ok(Json(snapshot))
        }
        Err(error) => {
            if let Ok(Some(serialized)) = state.database.get_setting(snapshot_key).await {
                match serde_json::from_str::<QueryStatsSnapshot>(&serialized) {
                    Ok(mut snapshot) => {
                        snapshot.live = false;
                        return Ok(Json(snapshot));
                    }
                    Err(snapshot_error) => {
                        tracing::warn!(%snapshot_error, "忽略损坏的查询排行快照");
                    }
                }
            }
            Err(map_control_error(error))
        }
    }
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
    let result = save_candidate(
        &state,
        request.content,
        &request.expected_sha256,
        request.message,
        session.username.clone(),
    )
    .await?;
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
    Ok(Json(result))
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
    let candidate = state
        .config
        .version_content(id)
        .await
        .map_err(map_config_error)?;
    let result = save_candidate(
        &state,
        candidate,
        &request.expected_sha256,
        format!("回滚至版本 #{id}"),
        session.username.clone(),
    )
    .await?;
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
    Ok(Json(result))
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
    let _apply_guard = state.config_apply_lock.lock().await;
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

async fn delete_config_versions(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<DeleteConfigVersionsRequest>,
) -> AppResult<Json<DeleteConfigVersionsResponse>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let _apply_guard = state.config_apply_lock.lock().await;
    let deleted_ids = state
        .config
        .delete_versions(request.ids, &request.expected_sha256)
        .await
        .map_err(map_config_error)?;
    state
        .database
        .audit(
            Some(session.username),
            "config.version.bulk_delete".to_owned(),
            format!("批量删除 {} 个配置版本", deleted_ids.len()),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(DeleteConfigVersionsResponse { deleted_ids }))
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

async fn save_candidate(
    state: &AppState,
    content: Value,
    expected_sha256: &str,
    message: String,
    actor: String,
) -> AppResult<ConfigApplyResponse> {
    let result = state
        .config
        .save_pending(content.clone(), expected_sha256, message, actor)
        .await
        .map_err(map_config_error)?;
    apply_pending_candidate(state, &content, result).await
}

async fn apply_pending_candidate(
    state: &AppState,
    content: &Value,
    result: SaveResult,
) -> AppResult<ConfigApplyResponse> {
    let Some(validation) = validate_candidate(state, content, &result).await? else {
        return Ok(pending_response(result.version_id, result.sha256, None));
    };
    activate_candidate(state, result, validation).await
}

async fn validate_candidate(
    state: &AppState,
    content: &Value,
    result: &SaveResult,
) -> AppResult<Option<ValidationResult>> {
    let health = match state.control.health().await {
        Ok(health) => health,
        Err(error) if should_defer_control(&error) => return Ok(None),
        Err(error) => {
            mark_candidate_failed(state, result.version_id, error.to_string()).await?;
            return Err(map_control_error(error));
        }
    };
    if let Err(error) = ensure_config_supported(content, &health.capabilities) {
        let message = error.to_string();
        mark_candidate_failed(state, result.version_id, message.clone()).await?;
        return Err(AppError::Unprocessable(
            "unsupported_config_fields",
            message,
        ));
    }
    let validation = match state.control.validate(content).await {
        Ok(validation) => validation,
        Err(error) if should_defer_control(&error) => return Ok(None),
        Err(error) => {
            mark_candidate_failed(state, result.version_id, error.to_string()).await?;
            return Err(map_control_error(error));
        }
    };
    if !validation.valid {
        mark_candidate_failed(
            state,
            result.version_id,
            "KixDNS 拒绝该配置，请先修正校验错误",
        )
        .await?;
        ensure_validation_accepted(&validation)?;
    }
    Ok(Some(validation))
}

async fn mark_candidate_failed(
    state: &AppState,
    version_id: i64,
    error: impl Into<String>,
) -> AppResult<()> {
    state
        .config
        .mark_pending_failed(version_id, error)
        .await
        .map_err(AppError::Internal)
}

async fn activate_candidate(
    state: &AppState,
    result: SaveResult,
    validation: ValidationResult,
) -> AppResult<ConfigApplyResponse> {
    let previous = match state.config.current().await {
        Ok(previous) => previous,
        Err(error) => {
            mark_candidate_failed(state, result.version_id, error.to_string()).await?;
            return Err(map_config_error(error));
        }
    };
    let before_reload = match state.control.active_config().await {
        Ok(active) => active,
        Err(error) if should_defer_control(&error) => {
            return Ok(pending_response(
                result.version_id,
                result.sha256,
                Some(validation),
            ));
        }
        Err(error) => {
            mark_candidate_failed(state, result.version_id, error.to_string()).await?;
            return Err(map_control_error(error));
        }
    };
    state
        .config
        .write_pending(result.version_id)
        .await
        .map_err(map_config_error)?;
    let active_config =
        if before_reload.sha256 == result.sha256 && before_reload.last_reload.success {
            Ok(before_reload)
        } else {
            state
                .control
                .wait_for_config(
                    &result.sha256,
                    before_reload.reload_sequence,
                    std::time::Duration::from_secs(5),
                )
                .await
        };
    let active_config = match active_config {
        Ok(active) => active,
        Err(error) => {
            state
                .config
                .restore_formal(previous.content)
                .await
                .map_err(map_config_error)?;
            mark_candidate_failed(state, result.version_id, error.to_string()).await?;
            return Err(AppError::Unprocessable(
                "reload_failed",
                format!("新配置未生效，旧配置仍已保留：{error}"),
            ));
        }
    };
    state
        .config
        .mark_applied(result.version_id)
        .await
        .map_err(map_config_error)?;
    Ok(ConfigApplyResponse {
        version_id: result.version_id,
        sha256: result.sha256,
        apply_state: CONFIG_APPLY_APPLIED,
        apply_error: None,
        active_config: Some(active_config),
        validation: Some(validation),
    })
}

fn pending_response(
    version_id: i64,
    sha256: String,
    validation: Option<ValidationResult>,
) -> ConfigApplyResponse {
    ConfigApplyResponse {
        version_id,
        sha256,
        apply_state: CONFIG_APPLY_PENDING,
        apply_error: None,
        active_config: None,
        validation,
    }
}

fn should_defer_control(error: &ControlError) -> bool {
    matches!(
        error,
        ControlError::Unavailable(_) | ControlError::Unsupported(_)
    )
}

/// 采样间隔。一分钟一次，24 小时约 1440 行，按整点聚合成趋势。
///
/// The sampling interval: once a minute, about 1440 rows a day, aggregated
/// into hourly buckets for the trend.
const METRIC_SAMPLE_INTERVAL_SECONDS: u64 = 60;
/// 趋势最多给 24 个点；桶宽跟着已经采到的时长走，不写死。
///
/// 写死一小时一格是错的：面板刚跑 25 分钟时全部采样落进同一个桶，只有一个点，
/// 连不成线，页面于是一直说「趋势需要至少两次采样」——而采样其实有二十几次，
/// 缺的是第二个桶。桶宽随时长自适应之后，跑满一小时之前也画得出曲线。
///
/// At most 24 points, with the bucket width following the period actually
/// collected rather than being fixed. A fixed hour is wrong: 25 minutes after
/// start every sample lands in one bucket, leaving a single point that cannot
/// form a line, so the page keeps saying the trend needs two samples — when
/// there are two dozen and what is missing is a second bucket. Adapting the
/// width draws a curve well before the first hour is up.
const TREND_BUCKETS: i64 = 24;
/// 桶宽下限就是采样间隔：再细也没有第二个数据点可填。
const MIN_TREND_BUCKET_SECONDS: i64 = METRIC_SAMPLE_INTERVAL_SECONDS.cast_signed();
/// 桶宽上限一小时，对应攒满 24 小时之后的那张图。
const MAX_TREND_BUCKET_SECONDS: i64 = 60 * 60;

/// 按采样覆盖的时长挑一个桶宽，目标是刚好铺满 24 格。
fn trend_bucket_seconds(covered_seconds: i64) -> i64 {
    if covered_seconds <= 0 {
        return MIN_TREND_BUCKET_SECONDS;
    }
    let ideal = (covered_seconds + TREND_BUCKETS - 1) / TREND_BUCKETS;
    ideal.clamp(MIN_TREND_BUCKET_SECONDS, MAX_TREND_BUCKET_SECONDS)
}

fn spawn_metrics_sampler(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(
            METRIC_SAMPLE_INTERVAL_SECONDS,
        ));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            if let Err(error) = sample_metrics(&state).await {
                // 内核没在跑的时候这里每分钟都会失败，用 debug 免得刷满日志。
                // This fails once a minute while the kernel is down; debug keeps
                // it out of the log.
                tracing::debug!(error = ?error, "指标采样跳过");
            }
        }
    });
}

async fn sample_metrics(state: &AppState) -> anyhow::Result<()> {
    let (health, metrics) = tokio::try_join!(state.control.health(), state.control.metrics())?;
    state
        .database
        .record_metric_sample(MetricSample {
            captured_at: unix_timestamp(),
            kernel_started_at: i64::try_from(health.started_at_unix).unwrap_or(i64::MAX),
            requests_total: i64::try_from(metrics.requests_total).unwrap_or(i64::MAX),
        })
        .await
}

async fn load_request_trend(state: &AppState) -> RequestTrend {
    let now = unix_timestamp();
    // 桶宽要等读到采样才定得下来，所以这里按最宽的情况取数：24 个一小时的桶，
    // 外加左端多读一格——窗口左端那个桶需要一个更早的样本才能求差。多读的部分
    // 落在窗口外时不会产生数据点。
    //
    // The bucket width cannot be known before the samples are read, so this
    // fetches for the widest case — 24 hourly buckets — plus one bucket further
    // back, because the leftmost bucket needs an earlier sample to take a
    // difference against. Anything outside the window yields no point.
    let widest = MAX_TREND_BUCKET_SECONDS * (TREND_BUCKETS + 1);
    match state.database.metric_samples_since(now - widest).await {
        Ok(samples) => build_request_trend(&samples, now),
        Err(error) => {
            tracing::warn!(%error, "无法读取指标采样，趋势留空");
            RequestTrend::default()
        }
    }
}

/// 把累计计数器折算成每个整点桶的请求数。
///
/// 两处必须照顾到，否则画出来的曲线会骗人：
/// 一是内核重启会让计数器归零，靠 `kernel_started_at` 变化识别，
/// 这时只能拿重启后的累计值当本段增量，重启前那一截无从得知；
/// 二是面板自己停过一段时间的话，两次采样之间会跨过好几个桶，
/// 增量按覆盖时长摊到每个桶上，而不是全算在结束的那个桶里——
/// 后者会在图上凭空造出一根尖峰。
///
/// Folds the cumulative counter into per-hour request counts.
///
/// Two cases have to be handled or the curve lies. A kernel restart resets the
/// counter; it is identified by a change in `kernel_started_at`, and the only
/// available estimate for that interval is the post-restart total, with the
/// pre-restart tail unknowable. And when the panel itself was down, one
/// interval spans several buckets; its delta is spread across them in
/// proportion to the time covered rather than charged to the closing bucket,
/// which would invent a spike.
fn build_request_trend(samples: &[MetricSample], now: i64) -> RequestTrend {
    // 覆盖时长从最早那次采样算到现在。第一次采样本身不产生增量，所以真正
    // 能画出来的那段从它开始。
    // The covered period runs from the earliest sample to now. That first sample
    // yields no delta of its own, so the drawable span begins there.
    let covered = samples.first().map_or(0, |first| now - first.captured_at);
    let bucket_seconds = trend_bucket_seconds(covered);
    let window_start = now - bucket_seconds * TREND_BUCKETS;
    let mut buckets = vec![0u64; usize::try_from(TREND_BUCKETS).unwrap_or_default()];
    let mut covered_buckets = vec![false; buckets.len()];

    for pair in samples.windows(2) {
        let (previous, current) = (pair[0], pair[1]);
        if current.captured_at <= previous.captured_at {
            continue;
        }
        let delta = interval_delta(previous, current);
        spread_interval(
            delta,
            previous.captured_at,
            current.captured_at,
            window_start,
            bucket_seconds,
            &mut buckets,
            &mut covered_buckets,
        );
    }

    let points: Vec<TrendPoint> = buckets
        .iter()
        .enumerate()
        .filter(|(index, _)| covered_buckets[*index])
        .map(|(index, requests)| TrendPoint {
            start_unix: window_start + bucket_seconds * i64::try_from(index).unwrap_or(0),
            requests: *requests,
        })
        .collect();
    let total = points.iter().map(|point| point.requests).sum();
    RequestTrend {
        bucket_seconds,
        points,
        total,
    }
}

fn interval_delta(previous: MetricSample, current: MetricSample) -> u64 {
    if current.kernel_started_at != previous.kernel_started_at {
        // 内核重启过，计数器从零重新开始；重启前那一截丢了，只能报重启后的部分。
        // The kernel restarted and the counter began again from zero; the tail
        // before the restart is lost, so only the part after it is reported.
        return u64::try_from(current.requests_total).unwrap_or_default();
    }
    u64::try_from(
        current
            .requests_total
            .saturating_sub(previous.requests_total),
    )
    .unwrap_or_default()
}

fn spread_interval(
    delta: u64,
    start: i64,
    end: i64,
    window_start: i64,
    bucket_seconds: i64,
    buckets: &mut [u64],
    covered: &mut [bool],
) {
    let span = end - start;
    if span <= 0 {
        return;
    }
    for (index, bucket) in buckets.iter_mut().enumerate() {
        let offset = bucket_seconds * i64::try_from(index).unwrap_or(0);
        let bucket_start = window_start + offset;
        let bucket_end = bucket_start + bucket_seconds;
        let from = start.max(bucket_start);
        let to = end.min(bucket_end);
        if to <= from {
            continue;
        }
        covered[index] = true;
        // 按「到这一格为止的累计份额」相减，而不是各算各的再取整。
        //
        // 每格单独 floor(delta * overlap / span) 会各丢一点零头，桶一多就积成
        // 可观的缺口：一段 120 次的增量摊到 16 个格里，每格 7.5 取整成 7，
        // 合计只剩 112。用累计值相减，零头自然落到下一格，合计始终等于 delta。
        //
        // Each bucket's share is the difference of two running totals rather
        // than its own independently floored quotient. Flooring per bucket
        // loses a fraction each time, and with many buckets that accumulates
        // into a visible shortfall: a delta of 120 spread over 16 buckets gives
        // 7.5 each, floors to 7, and totals 112. Taking differences carries the
        // remainder into the next bucket, so the parts always sum to delta.
        let share = scaled(delta, to - start, span) - scaled(delta, from - start, span);
        *bucket = bucket.saturating_add(share);
    }
}

/// `delta * position / span`，用 128 位算避免中途溢出。
fn scaled(delta: u64, position: i64, span: i64) -> u64 {
    let position = position.clamp(0, span);
    u64::try_from(
        u128::from(delta) * u128::try_from(position).unwrap_or_default()
            / u128::try_from(span).unwrap_or(1),
    )
    .unwrap_or_default()
}

fn spawn_config_reconciler(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(5));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            if let Err(error) = reconcile_pending(&state).await {
                tracing::warn!(error = ?error, "待应用配置收敛失败");
            }
        }
    });
}

async fn reconcile_pending(state: &AppState) -> anyhow::Result<()> {
    let Some(pending) = state.config.pending().await? else {
        return Ok(());
    };
    if pending.apply_state != CONFIG_APPLY_PENDING {
        return Ok(());
    }
    let _apply_guard = state.config_apply_lock.lock().await;
    let Some(pending) = state.config.pending().await? else {
        return Ok(());
    };
    if pending.apply_state != CONFIG_APPLY_PENDING {
        return Ok(());
    }
    let content = state.config.version(pending.id).await?.content;
    let result = SaveResult {
        version_id: pending.id,
        sha256: pending.sha256,
    };
    if let Err(error) = apply_pending_candidate(state, &content, result).await {
        tracing::warn!(error = ?error, "待应用配置应用失败");
    }
    Ok(())
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
        ControlError::Unavailable(message) => AppError::ServiceUnavailable(
            "kixdns_unavailable",
            normalize_control_unavailable_message(&message),
        ),
        ControlError::Protocol(message) => {
            AppError::ServiceUnavailable("kixdns_protocol_error", message)
        }
        ControlError::Unsupported(message) => {
            AppError::NotFound("kixdns_capability_unsupported", message)
        }
    }
}

fn normalize_control_unavailable_message(message: &str) -> String {
    if message.contains("No such file")
        || message.contains("os error 2")
        || message.contains("找不到指定的文件")
    {
        "KixDNS 未启动，增强控制接口暂不可用".to_owned()
    } else {
        message.to_owned()
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
