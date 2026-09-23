use std::net::{Ipv4Addr, SocketAddr};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::ConnectInfo;
use axum::http::header::{
    CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, COOKIE, SET_COOKIE,
};
use axum::http::{Request, StatusCode};
use futures_util::future::BoxFuture;
use serde_json::Value;
use tempfile::{TempDir, tempdir};
use tower::ServiceExt;

use super::{
    AppSettings, MetricSample, TrustedProxies, build_app, build_request_trend,
    ensure_validation_accepted, trend_bucket_seconds,
};
use crate::control::ValidationResult;

struct AuthenticatedApp {
    directory: TempDir,
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
        service_helper_socket: "/run/kixdns-panel/control.sock".into(),
        diagnostic_server: "127.0.0.1:53".parse().unwrap(),
        update_repository: "tuoro/kixdns-panel".to_owned(),
        update_workflow: "build-kixdns.yml".to_owned(),
        update_release_workflow: "build-kixdns-release.yml".to_owned(),
        update_branch: "main".to_owned(),
        update_artifact: "kixdns-enhanced-linux-x86_64".to_owned(),
        installed_commit: None,
        installed_source_id: None,
        panel_installed_commit: None,
        panel_installed_release: None,
        kixdns_binary: directory.path().join("kixdns"),
        kixdns_versions: directory.path().join("versions"),
        bundled_metadata: directory.path().join("bundle"),
        github_token_path: directory.path().join("github-token"),
        geo_data_path: directory.path().join("geo"),
        web_root,
        secure_cookie: false,
        trusted_proxies: TrustedProxies::default(),
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
        serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap()).unwrap();
    let csrf_token = payload["csrf_token"].as_str().unwrap().to_owned();
    AuthenticatedApp {
        directory,
        app,
        cookies,
        csrf_token,
    }
}

#[tokio::test]
async fn login_rejects_invalid_credentials_without_session_cookie() {
    let context = authenticated_app().await;

    for credentials in [
        r#"{"username":"missing-user","password":"a-secure-password"}"#,
        r#"{"username":"admin","password":"wrong-password"}"#,
    ] {
        let mut request = Request::post("/api/v1/auth/login")
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(credentials))
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from((Ipv4Addr::LOCALHOST, 42_001))));

        let response = context.app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers().get_all(SET_COOKIE).iter().count(), 0);

        let payload: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(payload["error"]["code"], "invalid_credentials");
        assert_eq!(payload["error"]["message"], "用户名或密码错误");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_wrong_logins_cannot_outrun_the_rate_limit() {
    let context = authenticated_app().await;
    let mut attempts = tokio::task::JoinSet::new();
    for _ in 0..40 {
        let app = context.app.clone();
        attempts.spawn(async move {
            let mut request = Request::post("/api/v1/auth/login")
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"username":"admin","password":"wrong-password"}"#,
                ))
                .unwrap();
            request
                .extensions_mut()
                .insert(ConnectInfo(SocketAddr::from((Ipv4Addr::LOCALHOST, 42_002))));
            app.oneshot(request).await.unwrap().status()
        });
    }
    let mut verified = 0;
    let mut limited = 0;
    while let Some(status) = attempts.join_next().await {
        match status.unwrap() {
            StatusCode::UNAUTHORIZED => verified += 1,
            StatusCode::TOO_MANY_REQUESTS => limited += 1,
            other => panic!("unexpected status {other}"),
        }
    }

    // 五次预算必须在进入密码校验前就占住，并发请求不能一起挤过检查。
    // The five-attempt budget is reserved before password verification, so
    // parallel requests cannot all slip past the check together.
    assert_eq!(
        verified, 5,
        "{verified} guesses reached password verification"
    );
    assert_eq!(limited, 35);
}

#[tokio::test]
async fn ipv6_clients_in_one_slash_64_share_one_login_budget() {
    let context = authenticated_app().await;
    let mut statuses = Vec::new();
    for host in 1..=6_u16 {
        let mut request = Request::post("/api/v1/auth/login")
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"username":"admin","password":"wrong-password"}"#,
            ))
            .unwrap();
        let address = std::net::Ipv6Addr::new(0x2001, 0xdb8, 0, 1, 0, 0, 0, host);
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from((address, 42_003))));
        statuses.push(context.app.clone().oneshot(request).await.unwrap().status());
    }

    assert_eq!(statuses[..5], [StatusCode::UNAUTHORIZED; 5]);
    assert_eq!(statuses[5], StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn a_username_spray_from_one_address_does_not_lock_out_the_admin() {
    let context = authenticated_app().await;
    let login = |username: String, password: &str, octet: u8| {
        let mut request = Request::post("/api/v1/auth/login")
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::json!({"username": username, "password": password}).to_string(),
            ))
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from((
                Ipv4Addr::new(203, 0, 113, octet),
                42_004,
            ))));
        context.app.clone().oneshot(request)
    };

    let mut statuses = Vec::new();
    for index in 0..21 {
        statuses.push(
            login(format!("guess-{index}"), "wrong-password", 9)
                .await
                .unwrap()
                .status(),
        );
    }
    // 喷洒的那个地址用完自己的用户名预算后被拒绝。
    // The spraying address is refused once its username budget is spent.
    assert_eq!(statuses[..20], [StatusCode::UNAUTHORIZED; 20]);
    assert_eq!(statuses[20], StatusCode::TOO_MANY_REQUESTS);

    // 别的地址上的管理员照常登录。
    // The admin on another address still logs in.
    let response = login("admin".to_owned(), "a-secure-password", 10)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
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

    let updates = context
        .app
        .clone()
        .oneshot(
            Request::get("/api/v1/updates/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(updates.status(), StatusCode::UNAUTHORIZED);

    let panel_update_status = context
        .app
        .clone()
        .oneshot(
            Request::get("/api/v1/panel-update")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(panel_update_status.status(), StatusCode::UNAUTHORIZED);

    let panel_update_without_csrf = context
        .app
        .clone()
        .oneshot(
            Request::post("/api/v1/panel-update")
                .header(COOKIE, context.cookies.clone())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(panel_update_without_csrf.status(), StatusCode::FORBIDDEN);

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

#[tokio::test]
async fn index_is_revalidated_while_hashed_assets_stay_cached() {
    // 更新会整目录换掉静态文件，旧的带哈希分块随之消失。index.html 被缓存的话，
    // 开着的标签页会继续引用已经不存在的分块，下一次切换页面就加载失败。
    // An update swaps the whole static directory and the old hashed chunks go
    // with it. A cached index.html keeps an open tab pointing at chunks that no
    // longer exist, and its next route change fails to load.
    let (directory, app) = test_app().await;
    let assets = directory.path().join("web/assets");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(assets.join("index-3f9a1c.js"), "export {}").unwrap();

    for path in ["/", "/index.html", "/config"] {
        let response = app
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(
            response.headers().get(CACHE_CONTROL).unwrap(),
            "no-cache",
            "{path} 每次都要向服务端确认 / must be revalidated every time"
        );
    }

    let response = app
        .clone()
        .oneshot(
            Request::get("/assets/index-3f9a1c.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    // 文件名带内容哈希，内容变了名字就变，可以长期缓存。
    // The name carries a content hash and changes with the content, so it may be cached for good.
    assert_eq!(
        response.headers().get(CACHE_CONTROL).unwrap(),
        "public, max-age=31536000, immutable"
    );

    // 已被删掉的分块落到 SPA 回退上拿到的是 index.html，绝不能被当成资源长期缓存。
    // A deleted chunk falls through to the SPA fallback and gets index.html,
    // which must never be cached as if it were the asset.
    let response = app
        .oneshot(
            Request::get("/assets/index-0ld000.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers().get(CACHE_CONTROL).unwrap(), "no-cache");
}

#[tokio::test]
async fn github_token_settings_require_authentication_and_csrf() {
    let context = authenticated_app().await;
    let unauthorized = context
        .app
        .clone()
        .oneshot(
            Request::get("/api/v1/settings/github-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let forbidden = context
        .app
        .clone()
        .oneshot(
            Request::put("/api/v1/settings/github-token")
                .header(CONTENT_TYPE, "application/json")
                .header(COOKIE, context.cookies.clone())
                .body(Body::from(r#"{"token":"github_pat_example"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

    let status = context
        .app
        .oneshot(
            Request::get("/api/v1/settings/github-token")
                .header(COOKIE, context.cookies)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(status.status(), StatusCode::OK);
    let payload: Value =
        serde_json::from_slice(&to_bytes(status.into_body(), 64 * 1024).await.unwrap()).unwrap();
    assert_eq!(
        payload,
        serde_json::json!({"configured": false, "rate_limit": null})
    );
}

#[tokio::test]
async fn geo_data_api_requires_auth_and_rejects_insecure_urls() {
    let context = authenticated_app().await;
    let unauthorized = context
        .app
        .clone()
        .oneshot(
            Request::get("/api/v1/config/geo-data")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let current = context
        .app
        .clone()
        .oneshot(
            Request::get("/api/v1/config/geo-data")
                .header(COOKIE, context.cookies.clone())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(current.status(), StatusCode::OK);
    let payload: Value =
        serde_json::from_slice(&to_bytes(current.into_body(), 64 * 1024).await.unwrap()).unwrap();
    assert!(payload["geoip_mmdb"].is_null());
    assert_eq!(payload["geosite"], serde_json::json!([]));

    let rejected = context
        .app
        .oneshot(
            Request::post("/api/v1/config/geo-data/sync")
                .header(CONTENT_TYPE, "application/json")
                .header(COOKIE, context.cookies)
                .header("x-csrf-token", context.csrf_token)
                .body(Body::from(
                    r#"{"geoip_mmdb_url":"http://127.0.0.1/geo.mmdb","geosite_urls":[]}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn geo_cleanup_requires_csrf_and_removes_unreferenced_files() {
    let context = authenticated_app().await;
    let digest = "c".repeat(64);
    let removable = context
        .directory
        .path()
        .join("geo")
        .join(format!("geosite-{digest}.dat"));
    std::fs::write(&removable, b"obsolete").unwrap();

    let forbidden = context
        .app
        .clone()
        .oneshot(
            Request::post("/api/v1/config/geo-data/cleanup")
                .header(COOKIE, context.cookies.clone())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
    assert!(removable.exists());

    let cleaned = context
        .app
        .oneshot(
            Request::post("/api/v1/config/geo-data/cleanup")
                .header(COOKIE, context.cookies)
                .header("x-csrf-token", context.csrf_token)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cleaned.status(), StatusCode::OK);
    let payload: Value =
        serde_json::from_slice(&to_bytes(cleaned.into_body(), 64 * 1024).await.unwrap()).unwrap();
    assert_eq!(payload["scanned_files"], 1);
    assert_eq!(payload["removed_files"], 1);
    assert_eq!(payload["reclaimed_bytes"], 8);
    assert!(!removable.exists());
}

/// 直接组装 `AppState`：定时 Geo 更新不经过 HTTP 路由，测试需要拿到状态本身。
/// Assemble an `AppState` directly: scheduled Geo updates bypass the HTTP routes, so the test needs the state.
async fn test_state(directory: &TempDir) -> super::AppState {
    use std::sync::Arc;

    let database = crate::db::Database::open(directory.path().join("panel.db"))
        .await
        .unwrap();
    let config = crate::config_store::ConfigStore::new(
        directory.path().join("pipeline.json"),
        database.clone(),
    );
    config.initialize_history().await.unwrap();
    let updates = crate::updates::UpdateManager::new(
        database.clone(),
        crate::updates::UpdateSettings {
            repository: "tuoro/kixdns-panel".to_owned(),
            workflow: "build-kixdns.yml".to_owned(),
            release_workflow: "build-kixdns-release.yml".to_owned(),
            branch: "main".to_owned(),
            artifact: "kixdns-enhanced-linux-x86_64".to_owned(),
            installed_commit: None,
            installed_source_id: None,
            panel_installed_commit: None,
            panel_installed_release: None,
            binary_path: directory.path().join("kixdns"),
            versions_path: directory.path().join("versions"),
            bundled_metadata: directory.path().join("bundle"),
            github_token_path: directory.path().join("github-token"),
        },
    )
    .unwrap();
    let geo_data =
        crate::geo_data::GeoDataManager::new(database.clone(), &directory.path().join("geo"))
            .unwrap();
    super::AppState {
        database,
        config,
        control: crate::control::ControlClient::new(directory.path().join("admin.sock")),
        operations: crate::operations::Operations::new(
            "kixdns.service".to_owned(),
            "/run/kixdns-panel/control.sock".into(),
            "127.0.0.1:53".parse().unwrap(),
        )
        .unwrap(),
        updates,
        geo_data,
        secure_cookie: false,
        trusted_proxies: TrustedProxies::default(),
        login_limiter: Arc::new(crate::auth::LoginLimiter::default()),
        password_slots: Arc::new(tokio::sync::Semaphore::new(1)),
        config_apply_lock: Arc::new(tokio::sync::Mutex::new(())),
        dummy_password_hash: Arc::from("unused"),
        upstream_history: Arc::default(),
    }
}

#[tokio::test]
async fn scheduled_geo_update_removes_unreferenced_files_and_keeps_rollback_targets() {
    // 回归：定时更新每次下载到新的内容寻址文件，却只有手动清理会删旧文件，磁盘只增不减。
    // Regression: every scheduled run downloads new content-addressed files, but only the manual
    // cleanup deleted old ones, so the disk only ever grew.
    let directory = tempdir().unwrap();
    let geo_root = directory.path().join("geo");
    std::fs::create_dir(&geo_root).unwrap();
    let geo_root = std::fs::canonicalize(geo_root).unwrap();
    let previous = geo_root.join(format!("geoip-mmdb-{}.mmdb", "a".repeat(64)));
    let current = geo_root.join(format!("geoip-mmdb-{}.mmdb", "b".repeat(64)));
    let orphan = geo_root.join(format!("geosite-{}.dat", "c".repeat(64)));
    for path in [&previous, &current, &orphan] {
        std::fs::write(path, b"geo").unwrap();
    }
    std::fs::write(
        directory.path().join("pipeline.json"),
        serde_json::json!({
            "pipelines": [],
            "settings": { "geoip_db_path": previous.to_string_lossy() },
        })
        .to_string(),
    )
    .unwrap();
    let state = test_state(&directory).await;
    let manifest = crate::geo_data::GeoDataManifest {
        geoip_mmdb: Some(crate::geo_data::GeoDataResource {
            url: "https://example.com/geo.mmdb".to_owned(),
            path: current.to_string_lossy().into_owned(),
            sha256: "b".repeat(64),
            size: 3,
            downloaded_at: 1,
        }),
        geoip_dat: None,
        geosite: Vec::new(),
    };

    super::geo::apply_synced_geo_data(&state, &manifest)
        .await
        .unwrap();

    assert!(current.exists(), "新配置引用的文件必须保留");
    assert!(previous.exists(), "历史版本引用的文件必须保留，回滚才能用");
    assert!(!orphan.exists(), "没有任何版本引用的旧文件应被清理");

    // 源文件没变、配置无需改写的那次运行也要清理，否则此前积下的旧文件永远留着。
    // A run whose sources did not change and left the config alone still cleans up, or files
    // left over from earlier runs would stay forever.
    std::fs::write(&orphan, b"geo").unwrap();
    super::geo::apply_synced_geo_data(&state, &manifest)
        .await
        .unwrap();
    assert!(current.exists() && previous.exists());
    assert!(!orphan.exists(), "配置未变的定时更新也应清理未引用的旧文件");
}

#[tokio::test]
async fn geo_schedule_requires_sources_before_enabling() {
    let context = authenticated_app().await;
    let current = context
        .app
        .clone()
        .oneshot(
            Request::get("/api/v1/config/geo-data/schedule")
                .header(COOKIE, context.cookies.clone())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(current.status(), StatusCode::OK);

    let forbidden = context
        .app
        .clone()
        .oneshot(
            Request::put("/api/v1/config/geo-data/schedule")
                .header(CONTENT_TYPE, "application/json")
                .header(COOKIE, context.cookies.clone())
                .body(Body::from(r#"{"interval_hours":24}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

    let rejected = context
        .app
        .oneshot(
            Request::put("/api/v1/config/geo-data/schedule")
                .header(CONTENT_TYPE, "application/json")
                .header(COOKIE, context.cookies)
                .header("x-csrf-token", context.csrf_token)
                .body(Body::from(r#"{"interval_hours":24}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
    let payload: Value =
        serde_json::from_slice(&to_bytes(rejected.into_body(), 64 * 1024).await.unwrap()).unwrap();
    assert_eq!(payload["error"]["code"], "geo_data_schedule_empty");
}

#[tokio::test]
async fn audit_api_requires_auth_and_uses_stable_cursor_pagination() {
    let context = authenticated_app().await;
    let unauthorized = context
        .app
        .clone()
        .oneshot(Request::get("/api/v1/audit").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let cleanup = context
        .app
        .clone()
        .oneshot(
            Request::post("/api/v1/config/geo-data/cleanup")
                .header(COOKIE, context.cookies.clone())
                .header("x-csrf-token", context.csrf_token.clone())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cleanup.status(), StatusCode::OK);

    let first = context
        .app
        .clone()
        .oneshot(
            Request::get("/api/v1/audit?limit=1")
                .header(COOKIE, context.cookies.clone())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first: Value =
        serde_json::from_slice(&to_bytes(first.into_body(), 64 * 1024).await.unwrap()).unwrap();
    assert_eq!(first["events"].as_array().unwrap().len(), 1);
    assert_eq!(first["events"][0]["action"], "config.geo_data.cleanup");
    let first_id = first["events"][0]["id"].as_i64().unwrap();
    let cursor = first["next_cursor"].as_i64().unwrap();

    let second = context
        .app
        .clone()
        .oneshot(
            Request::get(format!("/api/v1/audit?limit=1&before_id={cursor}"))
                .header(COOKIE, context.cookies.clone())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let second: Value =
        serde_json::from_slice(&to_bytes(second.into_body(), 64 * 1024).await.unwrap()).unwrap();
    assert_ne!(second["events"][0]["id"], first_id);
    assert!(second["next_cursor"].is_null());

    let filtered = context
        .app
        .clone()
        .oneshot(
            Request::get("/api/v1/audit?action_prefix=config.")
                .header(COOKIE, context.cookies.clone())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let filtered: Value =
        serde_json::from_slice(&to_bytes(filtered.into_body(), 64 * 1024).await.unwrap()).unwrap();
    assert_eq!(filtered["events"].as_array().unwrap().len(), 1);

    let invalid = context
        .app
        .oneshot(
            Request::get("/api/v1/audit?action_prefix=%25")
                .header(COOKIE, context.cookies)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
}

// 只测被拒的一侧：合法级别会真的去跑 journalctl，测试机上未必有那个 unit。
// Only the rejected side is tested here: a valid level really runs journalctl,
// and the test host need not have the unit.
#[tokio::test]
async fn logs_api_rejects_levels_outside_the_three_buckets() {
    let context = authenticated_app().await;
    let unauthorized = context
        .app
        .clone()
        .oneshot(
            Request::get("/api/v1/logs?level=error")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    for level in ["debug", "warn", "ERROR", "", "4..4"] {
        let invalid = context
            .app
            .clone()
            .oneshot(
                Request::get(format!("/api/v1/logs?level={level}"))
                    .header(COOKIE, context.cookies.clone())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST, "level={level:?}");
        let payload: Value =
            serde_json::from_slice(&to_bytes(invalid.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(
            payload["error"]["code"], "log_level_invalid",
            "level={level:?}"
        );
    }
}

#[test]
fn rejected_validation_cannot_reach_config_write() {
    let validation = ValidationResult {
        protocol_version: 1,
        valid: false,
        pipeline_count: 0,
        rule_count: 0,
    };
    assert!(ensure_validation_accepted(&validation).is_err());
}

#[tokio::test]
async fn config_version_delete_protects_current_version_and_requires_csrf() {
    let context = authenticated_app().await;

    let config_response = context
        .app
        .clone()
        .oneshot(
            Request::get("/api/v1/config")
                .header(COOKIE, context.cookies.clone())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let config: Value = serde_json::from_slice(
        &to_bytes(config_response.into_body(), 64 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();

    let versions_response = context
        .app
        .clone()
        .oneshot(
            Request::get("/api/v1/config/versions")
                .header(COOKIE, context.cookies.clone())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let versions: Value = serde_json::from_slice(
        &to_bytes(versions_response.into_body(), 64 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    let current_id = versions["versions"][0]["id"].as_i64().unwrap();
    let endpoint = format!("/api/v1/config/versions/{current_id}");
    let body = format!(
        r#"{{"expected_sha256":"{}"}}"#,
        config["sha256"].as_str().unwrap()
    );

    let unauthorized = context
        .app
        .clone()
        .oneshot(
            Request::delete(&endpoint)
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(body.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let forbidden = context
        .app
        .clone()
        .oneshot(
            Request::delete(&endpoint)
                .header(CONTENT_TYPE, "application/json")
                .header(COOKIE, context.cookies.clone())
                .body(Body::from(body.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

    let protected = context
        .app
        .oneshot(
            Request::delete(endpoint)
                .header(CONTENT_TYPE, "application/json")
                .header(COOKIE, context.cookies)
                .header("x-csrf-token", context.csrf_token)
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(protected.status(), StatusCode::CONFLICT);
    let payload: Value =
        serde_json::from_slice(&to_bytes(protected.into_body(), 64 * 1024).await.unwrap()).unwrap();
    assert_eq!(payload["error"]["code"], "config_version_active");
}

#[tokio::test]
async fn config_version_bulk_delete_removes_selected_versions_atomically() {
    let context = authenticated_app().await;
    let config_response = context
        .app
        .clone()
        .oneshot(
            Request::get("/api/v1/config")
                .header(COOKIE, context.cookies.clone())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let config: Value = serde_json::from_slice(
        &to_bytes(config_response.into_body(), 64 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    let save_body = serde_json::json!({
        "content": {
            "version": "1.0",
            "pipelines": []
        },
        "expected_sha256": config["sha256"],
        "message": "批量删除测试"
    });
    let save_response = context
        .app
        .clone()
        .oneshot(
            Request::put("/api/v1/config")
                .header(CONTENT_TYPE, "application/json")
                .header(COOKIE, context.cookies.clone())
                .header("x-csrf-token", context.csrf_token.clone())
                .body(Body::from(save_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(save_response.status(), StatusCode::OK);
    let saved: Value = serde_json::from_slice(
        &to_bytes(save_response.into_body(), 64 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    let version_id = saved["version_id"].as_i64().unwrap();
    let delete_body = serde_json::json!({
        "ids": [version_id],
        "expected_sha256": saved["sha256"]
    });

    let deleted_response = context
        .app
        .clone()
        .oneshot(
            Request::delete("/api/v1/config/versions/bulk")
                .header(CONTENT_TYPE, "application/json")
                .header(COOKIE, context.cookies.clone())
                .header("x-csrf-token", context.csrf_token)
                .body(Body::from(delete_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(deleted_response.status(), StatusCode::OK);
    let deleted: Value = serde_json::from_slice(
        &to_bytes(deleted_response.into_body(), 64 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(deleted["deleted_ids"], serde_json::json!([version_id]));

    let versions_response = context
        .app
        .oneshot(
            Request::get("/api/v1/config/versions")
                .header(COOKIE, context.cookies)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let versions: Value = serde_json::from_slice(
        &to_bytes(versions_response.into_body(), 64 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(
        versions["versions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|version| version["id"] != version_id)
    );
}

#[tokio::test]
async fn config_document_exposes_runtime_and_version_detail() {
    let context = authenticated_app().await;
    let config_response = context
        .app
        .clone()
        .oneshot(
            Request::get("/api/v1/config")
                .header(COOKIE, context.cookies.clone())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let config: Value = serde_json::from_slice(
        &to_bytes(config_response.into_body(), 64 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    let current_id = config["version_id"].as_i64().unwrap();
    assert_eq!(config["runtime"]["status"], "unavailable");
    assert!(config["runtime"]["active_sha256"].is_null());

    let detail_response = context
        .app
        .oneshot(
            Request::get(format!("/api/v1/config/versions/{current_id}"))
                .header(COOKIE, context.cookies)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(detail_response.status(), StatusCode::OK);
    let detail: Value = serde_json::from_slice(
        &to_bytes(detail_response.into_body(), 64 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(detail["id"], current_id);
    assert_eq!(detail["content"]["pipelines"], serde_json::json!([]));
}

#[tokio::test]
async fn config_save_while_kixdns_is_stopped_creates_pending_version() {
    let context = authenticated_app().await;
    let current = context
        .app
        .clone()
        .oneshot(
            Request::get("/api/v1/config")
                .header(COOKIE, context.cookies.clone())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(current.status(), StatusCode::OK);
    let current: Value =
        serde_json::from_slice(&to_bytes(current.into_body(), 64 * 1024).await.unwrap()).unwrap();
    let expected_sha256 = current["sha256"].as_str().unwrap();

    let response = context
        .app
        .clone()
        .oneshot(
            Request::put("/api/v1/config")
                .header(CONTENT_TYPE, "application/json")
                .header(COOKIE, context.cookies.clone())
                .header("x-csrf-token", context.csrf_token.clone())
                .body(Body::from(format!(
                    r#"{{"content":{{"pipelines":[{{"id":"stopped-test","rules":[]}}]}}, "expected_sha256":"{expected_sha256}", "message":"stopped runtime"}}"#
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["apply_state"], "pending");
    assert!(payload["active_config"].is_null());
    assert!(
        !body
            .windows(b"No such file".len())
            .any(|window| window == b"No such file")
    );
    assert!(
        !body
            .windows(b"os error 2".len())
            .any(|window| window == b"os error 2")
    );
    let formal_content: Value = serde_json::from_slice(
        &std::fs::read(context.directory.path().join("pipeline.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(formal_content["pipelines"], serde_json::json!([]));

    let document = context
        .app
        .oneshot(
            Request::get("/api/v1/config")
                .header(COOKIE, context.cookies)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(document.status(), StatusCode::OK);
    let document: Value =
        serde_json::from_slice(&to_bytes(document.into_body(), 64 * 1024).await.unwrap()).unwrap();
    assert_eq!(document["runtime"]["apply_state"], "pending");
    assert_eq!(document["pending"]["message"], "stopped runtime");
    assert_eq!(document["content"]["pipelines"][0]["id"], "stopped-test");
}

#[tokio::test]
async fn version_delete_requires_authentication_and_csrf() {
    let context = authenticated_app().await;
    let endpoint = "/api/v1/kixdns/versions/action/42/delete";

    let unauthorized = context
        .app
        .clone()
        .oneshot(Request::post(endpoint).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let forbidden = context
        .app
        .oneshot(
            Request::post(endpoint)
                .header(COOKIE, context.cookies)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
}

// ---------------------------------------------------------------------------
// 请求量趋势：累计计数器 → 每小时请求数
// The request trend: cumulative counters folded into per-hour request counts
// ---------------------------------------------------------------------------

/// 基准时刻取整点，让桶边界可以直接用小时算清楚。
/// A round hour as the reference point, so bucket edges are plain arithmetic.
const NOW: i64 = 1_800_000_000;

fn sample(minutes_ago: i64, started_at: i64, requests_total: i64) -> MetricSample {
    MetricSample {
        captured_at: NOW - minutes_ago * 60,
        kernel_started_at: started_at,
        requests_total,
    }
}

#[test]
fn accumulates_consecutive_deltas_without_losing_any() {
    // 连续三次采样的两段增量 100 + 150 应当一次不差地进到结果里。
    // 桶宽跟着覆盖时长走，所以这里不再断言落进几个桶——那正是写死一小时
    // 留下的毛病；要守住的是「摊派不丢数」。
    let samples = [
        sample(30, 1, 1_000),
        sample(20, 1, 1_100),
        sample(10, 1, 1_250),
    ];
    let trend = build_request_trend(&samples, NOW);

    assert_eq!(trend.total, 250, "两段增量一次不差");
    assert_eq!(
        trend.points.iter().map(|point| point.requests).sum::<u64>(),
        250,
        "各格之和等于合计",
    );
    assert!(trend.points.len() >= 2, "半小时的覆盖应当画得出曲线");
}

#[test]
fn counts_only_the_post_restart_total_when_the_kernel_restarted() {
    // 内核重启后计数器归零：8_000 → 120。
    // 单纯做减法会得到负数（饱和成 0），把重启后真实发生的 120 次请求丢掉。
    let samples = [sample(30, 1, 8_000), sample(10, 2, 120)];
    let trend = build_request_trend(&samples, NOW);

    assert_eq!(trend.total, 120, "重启后的累计值就是这一段能知道的全部");
}

#[test]
fn treats_a_restart_as_a_reset_even_when_the_counter_moved_forward() {
    // 重启后内核又跑满了，累计值比重启前还高（8_000 → 9_500）。
    // 计数器单调递增的假设在这里失效：两值相减得到 1_500，
    // 而重启后真正发生的是 9_500 次。只看数值大小的实现会安静地少算。
    let samples = [sample(30, 1, 8_000), sample(10, 2, 9_500)];
    let trend = build_request_trend(&samples, NOW);

    assert_eq!(trend.total, 9_500);
}

#[test]
fn spreads_an_interval_that_spans_several_buckets_across_all_of_them() {
    // 面板停了三小时，恢复后第一次采样带来 3_000 的增量。
    // 全算在结束的那个桶里会在图上凭空造出一根尖峰。
    let samples = [sample(200, 1, 1_000), sample(20, 1, 4_000)];
    let trend = build_request_trend(&samples, NOW);

    assert!(trend.points.len() >= 3, "这一段跨过了至少三个桶");
    let peak = trend
        .points
        .iter()
        .map(|point| point.requests)
        .max()
        .unwrap();
    assert!(
        peak < 3_000,
        "增量应当摊到各桶，而不是全部堆在一个桶里，实际最高一格 {peak}"
    );
    assert!(
        trend.total.abs_diff(3_000) <= trend.points.len() as u64,
        "摊派只允许整除带来的零头误差，实际合计 {}",
        trend.total
    );
}

#[test]
fn omits_buckets_no_sample_covers() {
    // 面板刚装上两小时，只有两个桶有数据。
    // 补齐 24 格会把「那时还没开始采」画成「那时没有请求」。
    let samples = [sample(110, 1, 100), sample(50, 1, 400), sample(5, 1, 900)];
    let trend = build_request_trend(&samples, NOW);

    assert!(
        trend.points.len() < 24,
        "没有采样覆盖的桶不出现在结果里，实际 {} 格",
        trend.points.len()
    );
    assert_eq!(trend.total, 800);
}

#[test]
fn drops_samples_that_fall_before_the_window() {
    // 窗口左边界之外的采样只用来给第一个桶提供减法基准，本身不产生数据点。
    let samples = [sample(24 * 60 + 90, 1, 500), sample(10, 1, 900)];
    let trend = build_request_trend(&samples, NOW);

    let earliest = trend.points.first().expect("窗口内应当有数据点");
    assert!(
        earliest.start_unix >= NOW - 24 * 3_600,
        "数据点不能落在 24 小时窗口之前"
    );
}

#[test]
fn ignores_samples_that_did_not_advance_in_time() {
    // 同一秒重复写入时不应当产生除零。
    let samples = [sample(10, 1, 100), sample(10, 1, 100)];
    let trend = build_request_trend(&samples, NOW);

    assert_eq!(trend.total, 0);
    assert!(trend.points.is_empty());
}

// ---------------------------------------------------------------------------
// 桶宽跟着已采到的时长走
// The bucket width follows the period actually collected
// ---------------------------------------------------------------------------

#[test]
fn draws_a_curve_within_the_first_half_hour() {
    // 面板刚跑 25 分钟、每分钟一次采样。桶宽写死一小时的话这 26 个样本全落进
    // 同一个桶，只剩一个点连不成线，页面于是一直说「趋势需要至少两次采样」。
    let samples: Vec<MetricSample> = (0..=25)
        .map(|minute| sample(25 - minute, 1, 1_000 + minute * 40))
        .collect();
    let trend = build_request_trend(&samples, NOW);

    assert!(
        trend.points.len() >= 2,
        "跑了 25 分钟就该画得出曲线，实际只有 {} 个点",
        trend.points.len()
    );
    assert!(trend.bucket_seconds < 3_600, "桶宽应当小于一小时");
    assert_eq!(trend.total, 1_000, "25 段每段 40 次");
}

#[test]
fn keeps_hourly_buckets_once_a_full_day_is_collected() {
    // 攒满 24 小时之后回到一小时一格，也就是设计稿里那张图。
    let samples = [sample(24 * 60, 1, 0), sample(0, 1, 240_000)];
    let trend = build_request_trend(&samples, NOW);
    assert_eq!(trend.bucket_seconds, 3_600);
}

#[test]
fn never_goes_finer_than_the_sampling_interval() {
    // 比采样间隔还细的桶里没有第二个数据点可填，只会画出锯齿。
    assert_eq!(trend_bucket_seconds(60), 60);
    assert_eq!(trend_bucket_seconds(5), 60);
    assert_eq!(trend_bucket_seconds(0), 60);
}

/// 健康检查处停住的宿主：测试据此在切换进行到一半时断开「请求」。
/// A host that halts at the health check, so the test can drop the "request"
/// while the switch is half-way through.
struct GatedHost {
    reached_health_check: tokio::sync::Notify,
    release_health_check: tokio::sync::Notify,
    calls: std::sync::Mutex<Vec<String>>,
}

impl crate::updates::ServiceHost for GatedHost {
    fn service_running(&self) -> BoxFuture<'_, Result<bool, crate::updates::UpdateError>> {
        Box::pin(async move { Ok(true) })
    }

    fn service_action(
        &self,
        action: crate::operations::ServiceAction,
    ) -> BoxFuture<'_, Result<(), crate::updates::UpdateError>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(format!("{action:?}"));
            Ok(())
        })
    }

    fn wait_until_healthy(&self) -> BoxFuture<'_, Result<(), crate::updates::UpdateError>> {
        Box::pin(async move {
            self.reached_health_check.notify_one();
            self.release_health_check.notified().await;
            Ok(())
        })
    }

    fn runtime_capabilities(
        &self,
    ) -> BoxFuture<'_, Result<Vec<String>, crate::updates::UpdateError>> {
        Box::pin(async move { Ok(Vec::new()) })
    }
}

#[tokio::test]
async fn a_dropped_request_does_not_cancel_a_version_switch() {
    use crate::updates::VersionSource;
    use crate::updates::tests::{active_setting, switch_fixture};

    let fixture = switch_fixture().await;
    let host = std::sync::Arc::new(GatedHost {
        reached_health_check: tokio::sync::Notify::new(),
        release_health_check: tokio::sync::Notify::new(),
        calls: std::sync::Mutex::new(Vec::new()),
    });
    let manager = fixture.manager.clone();
    let worker_host = std::sync::Arc::clone(&host);
    // 外层任务扮演 hyper 为这次请求驱动的处理函数。
    // The outer task stands in for the handler hyper drives for the request.
    let request = tokio::spawn(super::updates::run_detached(async move {
        manager
            .activate_version(
                VersionSource::Action,
                "43",
                &serde_json::json!({"pipelines": []}),
                &*worker_host,
            )
            .await
            .map_err(|error| crate::error::AppError::Internal(error.into()))
    }));
    host.reached_health_check.notified().await;

    // 浏览器断开：处理函数的 future 被丢弃。
    // The browser disconnects: the handler future is dropped.
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    host.release_health_check.notify_one();

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while active_setting(&fixture.database).await != Some(fixture.target_setting()) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "切换在请求断开后停在了半路：活动版本没有记录"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(std::fs::read(&fixture.binary_path).unwrap(), fixture.target);
    assert_eq!(host.calls.lock().unwrap().as_slice(), ["Restart"]);
}

#[tokio::test]
async fn a_panicking_version_switch_becomes_an_internal_error() {
    let result = super::updates::run_detached(async {
        assert!(!std::hint::black_box(true), "切换任务故意 panic");
        Ok(())
    })
    .await;

    assert!(matches!(result, Err(crate::error::AppError::Internal(_))));
}

#[test]
fn caps_the_bucket_at_an_hour_however_long_it_has_run() {
    // 跑了一周也不会变成一天一格：窗口固定看最近的一段，不是全部历史。
    assert_eq!(trend_bucket_seconds(7 * 24 * 3_600), 3_600);
}
