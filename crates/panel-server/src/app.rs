use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use axum::body::Body;
use axum::extract::{ConnectInfo, Path, State};
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
use tokio::sync::Semaphore;
use tower_http::trace::TraceLayer;

use crate::auth::{
    CSRF_COOKIE, LoginLimiter, SESSION_COOKIE, SESSION_SECONDS, authenticate, hash_password,
    issue_session, token_hash, unix_timestamp, validate_password, validate_username, verify_csrf,
    verify_password,
};
use crate::config_store::{ConfigError, ConfigStore, MAX_CONFIG_BYTES};
use crate::db::{
    ConfigVersionSummary, Database, SessionRecord, UserRecord, ensure_database_parent,
};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct AppSettings {
    pub bind: SocketAddr,
    pub database_path: PathBuf,
    pub config_path: PathBuf,
    pub secure_cookie: bool,
}

#[derive(Clone)]
pub struct AppState {
    database: Database,
    config: ConfigStore,
    secure_cookie: bool,
    login_limiter: Arc<LoginLimiter>,
    password_slots: Arc<Semaphore>,
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
    let state = AppState {
        database,
        config,
        secure_cookie: settings.secure_cookie,
        login_limiter: Arc::new(LoginLimiter::default()),
        password_slots: Arc::new(Semaphore::new(4)),
        dummy_password_hash: Arc::from(dummy_password_hash),
    };

    Ok(Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/setup", get(setup_status).post(setup))
        .route("/api/v1/auth/login", post(login))
        .route("/api/v1/auth/logout", post(logout))
        .route("/api/v1/auth/session", get(session))
        .route("/api/v1/config", get(get_config).put(save_config))
        .route("/api/v1/config/versions", get(config_versions))
        .route("/api/v1/config/versions/{id}/restore", post(restore_config))
        .fallback(not_found)
        .layer(axum::extract::DefaultBodyLimit::max(
            MAX_CONFIG_BYTES + 64 * 1024,
        ))
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn(security_headers))
        .with_state(state))
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

async fn save_config(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<SaveConfigRequest>,
) -> AppResult<Json<crate::config_store::SaveResult>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
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

async fn restore_config(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<RestoreConfigRequest>,
) -> AppResult<Json<crate::config_store::SaveResult>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let result = state
        .config
        .restore(id, &request.expected_sha256, session.username.clone())
        .await
        .map_err(map_config_error)?;
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
        HeaderValue::from_static("default-src 'self'; frame-ancestors 'none'; base-uri 'self'"),
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

    use axum::body::{Body, to_bytes};
    use axum::extract::ConnectInfo;
    use axum::http::header::{CONTENT_TYPE, COOKIE, SET_COOKIE};
    use axum::http::{Request, StatusCode};
    use serde_json::Value;
    use tempfile::tempdir;
    use tower::ServiceExt;

    use super::{AppSettings, build_app};

    #[tokio::test]
    async fn setup_issues_session_and_write_requires_csrf() {
        let directory = tempdir().unwrap();
        let config_path = directory.path().join("pipeline.json");
        std::fs::write(&config_path, "{\"pipelines\":[]}").unwrap();
        let app = build_app(AppSettings {
            bind: "127.0.0.1:0".parse().unwrap(),
            database_path: directory.path().join("panel.db"),
            config_path,
            secure_cookie: false,
        })
        .await
        .unwrap();

        let mut setup = Request::post("/api/v1/setup")
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"username":"admin","password":"a-secure-password"}"#,
            ))
            .unwrap();
        setup
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from((Ipv4Addr::LOCALHOST, 42_000))));
        let response = app.clone().oneshot(setup).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let cookies = response
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap().split(';').next().unwrap())
            .collect::<Vec<_>>()
            .join("; ");
        assert!(cookies.contains("kixdns_session="));
        assert!(cookies.contains("kixdns_csrf="));
        let payload: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        assert!(payload["csrf_token"].as_str().is_some());

        let unauthorized = app
            .clone()
            .oneshot(Request::get("/api/v1/config").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let forbidden = app
            .oneshot(
                Request::put("/api/v1/config")
                    .header(CONTENT_TYPE, "application/json")
                    .header(COOKIE, cookies)
                    .body(Body::from(
                        r#"{"content":{"pipelines":[]},"expected_sha256":"invalid"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
    }
}
