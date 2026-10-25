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
    // 假的 systemctl：照目录里的 unit-state 回答，没有就是停着 / A fake systemctl: answers from unit-state in the directory,
    // stopped when there is none
    let systemctl = directory.path().join("systemctl");
    std::fs::write(
        &systemctl,
        "#!/bin/sh\ncat \"$(dirname \"$0\")/unit-state\" 2>/dev/null || printf 'ActiveState=inactive\\nSubState=dead\\nMainPID=0\\n'\n",
    )
    .unwrap();
    std::fs::set_permissions(
        &systemctl,
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    let app = build_app(AppSettings {
        systemctl: Some(systemctl),
        bind: "127.0.0.1:0".parse().unwrap(),
        database_path: directory.path().join("panel.db"),
        config_path,
        control_socket: directory.path().join("admin.sock"),
        service_unit: "kixdns.service".to_owned(),
        service_helper_socket: directory.path().join("helper.sock"),
        diagnostic_server: "127.0.0.1:53".parse().unwrap(),
        kernel_repository: "tuoro/kixdns".to_owned(),
        installed_source: None,
        installed_commit: None,
        installed_source_id: None,
        panel_installed_commit: None,
        panel_installed_release: None,
        kixdns_binary: directory.path().join("kixdns"),
        kixdns_versions: directory.path().join("versions"),
        bundled_metadata: directory.path().join("bundle"),
        github_token_path: directory.path().join("github-token"),
        geo_data_path: directory.path().join("geo"),
        builtin_geosite: None,
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

/// 定时更新拦截列表：配置里在用的文件换成新合成的（KixDNS 没运行时存成待应用的版本），换下的旧文件还被当前配置
/// 引用，回滚时用得上，所以留着
/// A scheduled blocklist update swaps the file the config uses for the newly built one (as a pending version while
/// `KixDNS` is not running); the old file is still referenced by the current config, which a rollback needs, so it stays
#[tokio::test]
async fn a_scheduled_blocklist_update_swaps_the_file_in_the_config() {
    use crate::blocklist_data::{BuildRequest, Subscription};

    let directory = tempdir().unwrap();
    std::fs::write(
        directory.path().join("pipeline.json"),
        r#"{"pipelines":[]}"#,
    )
    .unwrap();
    let state = test_state(&directory).await;
    // 指向本机的链接下载前就被拒，正好当作下载失败 / A link to this machine is refused before downloading, which stands
    // in for a failed download
    let url = "https://127.0.0.1/a.txt";
    state
        .blocklists
        .hold_for_tests(url, "||ads.example^\n")
        .await;
    let old = state
        .blocklists
        .build(BuildRequest {
            subscriptions: vec![Subscription {
                url: url.to_owned(),
                enabled: true,
            }],
            refresh: Vec::new(),
        })
        .await
        .unwrap()
        .path
        .unwrap();
    std::fs::write(
        directory.path().join("pipeline.json"),
        serde_json::json!({ "pipelines": [], "settings": { "geosite_data_paths": [old] } })
            .to_string(),
    )
    .unwrap();
    state
        .blocklists
        .hold_for_tests(url, "||ads.example^\n||more.example^\n")
        .await;

    let failed = super::blocklist::apply_scheduled_blocklist_update(&state)
        .await
        .unwrap();
    assert_eq!(failed, 1);
    let pending = state.config.desired().await.unwrap().content;
    let new = pending["settings"]["geosite_data_paths"][0]
        .as_str()
        .unwrap();
    assert_ne!(new, old);
    assert!(
        std::fs::read_to_string(new)
            .unwrap()
            .contains("domain:more.example")
    );
    assert!(
        std::path::Path::new(&old).exists(),
        "the current config still uses it"
    );
    let events = state
        .database
        .list_audit_events(
            10,
            None,
            Some("config.blocklists.schedule.apply".to_owned()),
        )
        .await
        .unwrap();
    assert_eq!(events.events.len(), 1);
}

/// 拦截列表的接口：不登录不给，改东西要带 CSRF，链接和自动更新的间隔写错了不收
/// The blocklist endpoints: nothing without signing in, changes need the CSRF token, and bad links or intervals are
/// refused
#[tokio::test]
async fn blocklist_api_requires_auth_and_checks_what_it_gets() {
    let context = authenticated_app().await;
    let send = |request: Request<Body>| context.app.clone().oneshot(request);
    let json_body = |response: axum::response::Response| async move {
        serde_json::from_slice::<Value>(&to_bytes(response.into_body(), 64 * 1024).await.unwrap())
            .unwrap()
    };

    let unauthorized = send(
        Request::get("/api/v1/config/blocklists")
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    let current = send(
        Request::get("/api/v1/config/blocklists")
            .header(COOKIE, context.cookies.clone())
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(current.status(), StatusCode::OK);
    let current = json_body(current).await;
    assert_eq!(current["sources"], serde_json::json!({}));
    assert!(current["schedule"]["interval_hours"].is_null());

    let build = |csrf: Option<&str>, body: &'static str| {
        let mut request = Request::post("/api/v1/config/blocklists/build")
            .header(CONTENT_TYPE, "application/json")
            .header(COOKIE, context.cookies.clone());
        if let Some(csrf) = csrf {
            request = request.header("x-csrf-token", csrf);
        }
        request.body(Body::from(body)).unwrap()
    };
    let forbidden = send(build(None, r#"{"subscriptions":[]}"#)).await.unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
    let insecure = send(build(
        Some(&context.csrf_token),
        r#"{"subscriptions":[{"url":"http://lists.example/a.txt","enabled":true}]}"#,
    ))
    .await
    .unwrap();
    assert_eq!(insecure.status(), StatusCode::BAD_REQUEST);
    let insecure = json_body(insecure).await;
    assert_eq!(insecure["error"]["code"], "blocklist_invalid");
    assert_eq!(
        insecure["error"]["message"],
        "拦截列表「http://lists.example/a.txt」：链接只能用 https://"
    );
    let empty = send(build(Some(&context.csrf_token), r#"{"subscriptions":[]}"#))
        .await
        .unwrap();
    assert_eq!(empty.status(), StatusCode::OK);
    assert_eq!(
        json_body(empty).await,
        serde_json::json!({ "path": null, "sources": {}, "failed": 0 })
    );

    let schedule = |interval: &'static str| {
        Request::put("/api/v1/config/blocklists/schedule")
            .header(CONTENT_TYPE, "application/json")
            .header(COOKIE, context.cookies.clone())
            .header("x-csrf-token", context.csrf_token.clone())
            .body(Body::from(interval))
            .unwrap()
    };
    let rejected = send(schedule(r#"{"interval_hours":12}"#)).await.unwrap();
    assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
    let daily = send(schedule(r#"{"interval_hours":24}"#)).await.unwrap();
    assert_eq!(daily.status(), StatusCode::OK);
    assert_eq!(json_body(daily).await["interval_hours"], 24);
    let audit = send(
        Request::get("/api/v1/audit?action_prefix=config.blocklists")
            .header(COOKIE, context.cookies.clone())
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .unwrap();
    let audit = json_body(audit).await;
    let events: Vec<(&str, &str)> = audit["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| {
            (
                event["action"].as_str().unwrap(),
                event["detail"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        events,
        [
            ("config.blocklists.schedule", "每天"),
            ("config.blocklists.build", "0\u{a0}个列表"),
        ]
    );
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
            kernel_repository: "tuoro/kixdns".to_owned(),
            installed_source: None,
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
    let blocklists =
        crate::blocklist_data::BlocklistManager::new(geo_data.clone(), database.clone());
    let database_for_querylog = database.clone();
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
        blocklists,
        geosite_catalog: Arc::default(),
        secure_cookie: false,
        trusted_proxies: TrustedProxies::default(),
        login_limiter: Arc::new(crate::auth::LoginLimiter::default()),
        password_slots: Arc::new(tokio::sync::Semaphore::new(1)),
        config_apply_lock: Arc::new(tokio::sync::Mutex::new(())),
        dummy_password_hash: Arc::from("unused"),
        recent_history: Arc::default(),
        querylog: super::querylog::QueryLog::open(
            &directory.path().join("panel.db"),
            &database_for_querylog,
        )
        .await
        .unwrap(),
    }
}

/// 一份测试用的内置 GeoSite：只有 `cn` 分类的数据文件和它的说明。
/// A test built-in `GeoSite`: a data file holding only the `cn` category, and its descriptor.
fn write_builtin_geosite(directory: &std::path::Path) -> (std::path::PathBuf, Vec<u8>) {
    let builtin = directory.join("builtin");
    std::fs::create_dir_all(&builtin).unwrap();
    let data = b"\x0a\x04\x0a\x02cn".to_vec();
    std::fs::write(builtin.join("geosite.dat"), &data).unwrap();
    let descriptor = builtin.join("geosite.json");
    std::fs::write(
        &descriptor,
        serde_json::json!({
            "schema_version": 1,
            "file": "geosite.dat",
            "url": "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat",
            "release": "202610122207",
            "release_url": "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/tag/202610122207",
            "sha256": crate::digest::sha256_hex(&data),
            "size": data.len(),
        })
        .to_string(),
    )
    .unwrap();
    (descriptor, data)
}

async fn builtin_geosite_state(
    directory: &TempDir,
    settings: serde_json::Value,
) -> super::AppState {
    std::fs::write(
        directory.path().join("pipeline.json"),
        serde_json::json!({ "pipelines": [], "settings": settings }).to_string(),
    )
    .unwrap();
    let mut state = test_state(directory).await;
    let (descriptor, _) = write_builtin_geosite(directory.path());
    state.geo_data = state.geo_data.clone().with_builtin_geosite(descriptor);
    state
}

/// 全新安装的首次启动：配置里没有 `GeoSite` 时导入内置的那份，写进配置（KixDNS 还没启动，存成待应用
/// 的版本），记进审计，标记用掉就删；之后再启动不会再导入。
/// A fresh install's first start: with no `GeoSite` in the config the built-in copy is imported and
/// written into the config (a pending version, `KixDNS` has not started), audited, and the marker is
/// spent; later starts import nothing again.
#[tokio::test]
async fn a_fresh_install_imports_the_builtin_geosite_once() {
    let directory = tempdir().unwrap();
    let state = builtin_geosite_state(&directory, serde_json::json!({})).await;
    let marker = directory.path().join("geo/.import-builtin-geosite");
    std::fs::write(&marker, b"").unwrap();

    super::geo::seed_builtin_geosite(&state).await.unwrap();

    assert!(!marker.exists(), "the marker is spent");
    let manifest = state.geo_data.current().await.unwrap();
    assert_eq!(manifest.geosite.len(), 1);
    let desired = state.config.desired().await.unwrap();
    assert_eq!(
        desired.content["settings"]["geosite_data_paths"],
        serde_json::json!([manifest.geosite[0].path])
    );
    assert!(
        state.config.pending().await.unwrap().is_some(),
        "waits for KixDNS to start"
    );
    let audit = state
        .database
        .list_audit_events(10, None, Some("config.geo_data.import_builtin".to_owned()))
        .await
        .unwrap();
    assert_eq!(audit.events.len(), 1);
    assert!(audit.events[0].actor.is_none());
    assert!(
        audit.events[0].detail.contains("202610122207"),
        "{}",
        audit.events[0].detail
    );

    // 没有标记就什么都不做：用户删掉 GeoSite 以后，重启不会把它塞回来
    // Without the marker nothing happens: once the user removes GeoSite, a restart does not put it back
    super::geo::seed_builtin_geosite(&state).await.unwrap();
    assert_eq!(
        state
            .database
            .list_audit_events(10, None, Some("config.geo_data.import_builtin".to_owned()))
            .await
            .unwrap()
            .events
            .len(),
        1
    );
}

/// 配置里已经写着 GeoSite（比如迁移来的 `KixDNS` 配置）：不导入，不改配置，只用掉标记。
/// A config that already names `GeoSite` files (such as a migrated `KixDNS` config): nothing is imported
/// and the config is untouched; the marker is just spent.
#[tokio::test]
async fn the_builtin_geosite_never_replaces_a_configured_source() {
    let directory = tempdir().unwrap();
    let own = serde_json::json!({ "geosite_data_paths": ["/srv/geo/my-geosite.dat"] });
    let state = builtin_geosite_state(&directory, own.clone()).await;
    let marker = directory.path().join("geo/.import-builtin-geosite");
    std::fs::write(&marker, b"").unwrap();

    super::geo::seed_builtin_geosite(&state).await.unwrap();

    assert!(!marker.exists());
    assert!(state.geo_data.current().await.unwrap().geosite.is_empty());
    let desired = state.config.desired().await.unwrap();
    assert_eq!(desired.content["settings"], own);
    assert!(state.config.pending().await.unwrap().is_none());
}

/// 只更新过面板的主机没有标记：不自动导入，由用户在 Geo 设置里自己点。
/// A host that only updated the panel has no marker: nothing is imported until the user asks.
#[tokio::test]
async fn an_upgraded_host_is_not_seeded() {
    let directory = tempdir().unwrap();
    let state = builtin_geosite_state(&directory, serde_json::json!({})).await;

    super::geo::seed_builtin_geosite(&state).await.unwrap();

    assert!(state.geo_data.current().await.unwrap().geosite.is_empty());
    assert!(state.config.pending().await.unwrap().is_none());
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
async fn kernel_switches_require_authentication_and_csrf() {
    let context = authenticated_app().await;
    for (endpoint, body) in [
        ("/api/v1/kixdns/kernel/update", r#"{"source_id":42}"#),
        ("/api/v1/kixdns/kernel/rollback", ""),
    ] {
        let unauthorized = context
            .app
            .clone()
            .oneshot(
                Request::post(endpoint)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            unauthorized.status(),
            StatusCode::UNAUTHORIZED,
            "{endpoint}"
        );

        let forbidden = context
            .app
            .clone()
            .oneshot(
                Request::post(endpoint)
                    .header(COOKIE, context.cookies.clone())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN, "{endpoint}");
    }
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
            .rollback(&serde_json::json!({"pipelines": []}), &*worker_host)
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

/// 内核不在（或是 p28 之前的版本）时，指定客户端 IP、测试草稿都要明确拒绝，不能悄悄退回成普通查询。
/// Without a kernel (or with one before p28), an assigned client IP and a draft test are refused plainly, never quietly downgraded to a plain query.
#[tokio::test]
async fn dns_diagnostic_refuses_options_the_kernel_does_not_declare() {
    let context = authenticated_app().await;
    for (body, code) in [
        (
            serde_json::json!({ "domain": "example.com", "record_type": "A", "client_ip": "192.168.1.9" }),
            "diagnostic_client_unsupported",
        ),
        (
            serde_json::json!({ "domain": "example.com", "record_type": "A", "config": { "pipelines": [] } }),
            "diagnostic_candidate_unsupported",
        ),
    ] {
        let response = context
            .app
            .clone()
            .oneshot(
                Request::post("/api/v1/diagnostics/dns")
                    .header(COOKIE, context.cookies.clone())
                    .header("x-csrf-token", context.csrf_token.clone())
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let payload: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(payload["error"]["code"], code, "{payload}");
    }
}

#[test]
fn reload_failures_read_as_one_plain_phrase() {
    use crate::control::ControlError;
    assert_eq!(
        super::reload_failure(&ControlError::Rejected("没有给出原因".to_owned())),
        "KixDNS 没有接受这份配置：没有给出原因"
    );
    assert_eq!(
        super::reload_failure(&ControlError::Unavailable(
            "No such file or directory (os error 2)".to_owned()
        )),
        "KixDNS 已停止"
    );
    assert_eq!(
        super::reload_failure(&ControlError::Unavailable(
            "KixDNS 没有及时确认新配置".to_owned()
        )),
        "KixDNS 没有及时确认新配置"
    );
    assert_eq!(
        super::reload_failure(&ControlError::Unavailable("connection refused".to_owned())),
        "连不上 KixDNS：connection refused"
    );
}

// 原因单独读不出是哪件事（「校验值格式无效」）：页面拿到的要带「更新包没通过校验：」的开头，内核和面板更新都适用
// The reason alone does not say what failed (校验值格式无效): the page gets the 更新包没通过校验 opening, which fits kernel and panel updates alike
#[test]
fn an_update_verification_error_reaches_the_page_with_its_opening() {
    let error = super::map_update_error(crate::updates::UpdateError::Verification(
        "校验值格式无效".to_owned(),
    ));
    assert!(matches!(
        error,
        crate::error::AppError::Unprocessable("update_verification_failed", _)
    ));
    assert_eq!(error.to_string(), "更新包没通过校验：校验值格式无效");
}

// ---------------------------------------------------------------------------
// 待应用的版本原地生效 / Putting the pending version into effect in place
// ---------------------------------------------------------------------------

/// 假的 `KixDNS` 控制接口：报告它在用的就是磁盘上那份配置，文件一变就算重载了一次（真的 `KixDNS` 自己盯着这个文件）。
/// A fake `KixDNS` control socket: it reports the config file on disk as the one in use, and a changed file counts
/// as one reload (the real `KixDNS` watches that file itself).
/// `valid` 是校验的结论 / `valid` is what validation answers
fn start_fake_kixdns(directory: &std::path::Path, valid: bool) -> tokio::task::JoinHandle<()> {
    use axum::routing::{get, post};
    let socket = directory.join("admin.sock");
    let config = directory.join("pipeline.json");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let seen = std::sync::Arc::new(std::sync::Mutex::new((String::new(), 0_u64)));
    let active = move || {
        let sha256 = crate::digest::sha256_hex(&std::fs::read(&config).unwrap());
        let mut seen = seen.lock().unwrap();
        if seen.0 != sha256 {
            seen.0.clone_from(&sha256);
            seen.1 += 1;
        }
        serde_json::json!({
            "protocol_version": 1, "generation": seen.1, "sha256": sha256, "loaded_at_unix": 0,
            "reload_sequence": seen.1, "last_reload": { "success": true, "error": null },
        })
    };
    let router = Router::new()
        .route(
            "/v1/health",
            get(|| async {
                axum::Json(serde_json::json!({
                    "protocol_version": 1, "status": "ok", "pid": 1, "version": "test", "upstream_commit": "test",
                    "patchset": "p0", "started_at_unix": 0, "uptime_seconds": 1, "config_generation": 1, "capabilities": [],
                }))
            }),
        )
        .route(
            "/v1/config/active",
            get(move || {
                let active = active.clone();
                async move { axum::Json(active()) }
            }),
        )
        .route(
            "/v1/config/validate",
            post(move || async move {
                axum::Json(serde_json::json!({ "protocol_version": 1, "valid": valid, "pipeline_count": 1, "rule_count": 0 }))
            }),
        );
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() })
}

/// 假的 `KixDNS`：报告磁盘上那份配置在用，`restart_pending` 照给出的写（None 时像旧内核一样不写）
/// A fake `KixDNS` reporting the config on disk as in use, with `restart_pending` as given (left out, as an
/// older kernel does, when None)
fn start_fake_kixdns_reporting_restart(
    directory: &std::path::Path,
    restart_pending: Option<Value>,
) -> tokio::task::JoinHandle<()> {
    use axum::routing::get;
    let socket = directory.join("admin.sock");
    let config = directory.join("pipeline.json");
    let health_dir = directory.to_path_buf();
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let router = Router::new()
        .route(
            "/v1/health",
            get(move || {
                // 进程号和已运行时长照目录里的文件回答，测试用它们演一个新进程、一段时间过去
                // The process id and uptime come from files in the directory, so a test can play a new process and time
                // passing
                let read = |name: &str, default: u64| {
                    std::fs::read_to_string(health_dir.join(name)).ok().and_then(|text| text.trim().parse().ok()).unwrap_or(default)
                };
                let pid = read("kernel-pid", 1);
                let body = serde_json::json!({
                    "protocol_version": 1, "status": "ok", "pid": pid, "version": "test", "upstream_commit": "test",
                    "patchset": "p0", "started_at_unix": pid * 100, "uptime_seconds": read("kernel-uptime", 60),
                    "config_generation": 1, "capabilities": [],
                });
                async move { axum::Json(body) }
            }),
        )
        .route(
            "/v1/config/active",
            get(move || {
                let mut active = serde_json::json!({
                    "protocol_version": 1, "generation": 1,
                    "sha256": crate::digest::sha256_hex(&std::fs::read(&config).unwrap()), "loaded_at_unix": 0,
                    "reload_sequence": 1, "last_reload": { "success": true, "error": null },
                });
                if let Some(pending) = &restart_pending {
                    active["restart_pending"] = pending.clone();
                }
                async move { axum::Json(active) }
            }),
        );
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() })
}

/// 内核报来的「改过、要重启才生效的设置」原样交给配置页；没有、或者旧内核不报时不写这一项
/// The settings the kernel reports as changed and waiting for a restart reach the config page as they are; with
/// none, or from an older kernel that does not report them, the field is left out
#[tokio::test]
async fn config_runtime_carries_the_settings_waiting_for_a_restart() {
    let context = authenticated_app().await;
    let kixdns = start_fake_kixdns_reporting_restart(
        context.directory.path(),
        Some(serde_json::json!(["bind_udp", "cache_capacity"])),
    );
    let document = get_json(&context, "/api/v1/config").await;
    assert_eq!(document["runtime"]["status"], "active");
    assert_eq!(
        document["runtime"]["restart_pending"],
        serde_json::json!(["bind_udp", "cache_capacity"])
    );
    kixdns.abort();
    let _ = kixdns.await;

    for reported in [Some(serde_json::json!([])), None] {
        let _ = std::fs::remove_file(context.directory.path().join("admin.sock"));
        let kixdns = start_fake_kixdns_reporting_restart(context.directory.path(), reported);
        let document = get_json(&context, "/api/v1/config").await;
        assert_eq!(document["runtime"]["status"], "active");
        assert!(document["runtime"].get("restart_pending").is_none());
        kixdns.abort();
        let _ = kixdns.await;
    }
}

async fn send_json(context: &AuthenticatedApp, request: Request<Body>) -> (StatusCode, Value) {
    let response = context.app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 256 * 1024).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

async fn get_json(context: &AuthenticatedApp, path: &str) -> Value {
    let request = Request::get(path)
        .header(COOKIE, context.cookies.clone())
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(context, request).await;
    assert_eq!(status, StatusCode::OK, "{path}");
    body
}

async fn apply_version(context: &AuthenticatedApp, id: i64) -> (StatusCode, Value) {
    let request = Request::post(format!("/api/v1/config/versions/{id}/apply"))
        .header(COOKIE, context.cookies.clone())
        .header("x-csrf-token", context.csrf_token.clone())
        .body(Body::empty())
        .unwrap();
    send_json(context, request).await
}

/// `KixDNS` 停着时存一份，存成待应用版本，返回它的编号 / Save while `KixDNS` is down, so it is stored as a pending version; returns its id
async fn save_pending(context: &AuthenticatedApp, pipeline: &str, message: &str) -> i64 {
    let expected = get_json(context, "/api/v1/config").await["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    let body = serde_json::json!({
        "content": { "pipelines": [{ "id": pipeline, "rules": [] }] },
        "expected_sha256": expected,
        "message": message,
    });
    let request = Request::put("/api/v1/config")
        .header(CONTENT_TYPE, "application/json")
        .header(COOKIE, context.cookies.clone())
        .header("x-csrf-token", context.csrf_token.clone())
        .body(Body::from(body.to_string()))
        .unwrap();
    let (status, payload) = send_json(context, request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["apply_state"], "pending");
    payload["version_id"].as_i64().unwrap()
}

// 「现在应用」让待应用的那个版本原地生效：不新建版本，编号和备注都不变；再按一次只回「已生效」，不再多出版本
// 现在应用 puts the pending version itself into effect: no new version, its number and note stay; pressing again only
// answers 已生效 and adds no version
#[tokio::test]
async fn applying_the_pending_version_keeps_its_number_and_note() {
    let context = authenticated_app().await;
    let pending = save_pending(&context, "in-place", "把视频域名交给 CDN 组").await;
    let count = get_json(&context, "/api/v1/config/versions").await["versions"]
        .as_array()
        .unwrap()
        .len();
    let _kixdns = start_fake_kixdns(context.directory.path(), true);

    for _ in 0..2 {
        let (status, payload) = apply_version(&context, pending).await;
        assert_eq!(status, StatusCode::OK, "{payload}");
        assert_eq!(payload["version_id"], pending);
        assert_eq!(payload["apply_state"], "applied");
        assert!(payload["active_config"].is_object());
    }

    let versions = get_json(&context, "/api/v1/config/versions").await["versions"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(versions.len(), count, "no new version");
    let applied = versions.iter().find(|v| v["id"] == pending).unwrap();
    assert_eq!(applied["apply_state"], "applied");
    assert_eq!(applied["message"], "把视频域名交给 CDN 组");
    let document = get_json(&context, "/api/v1/config").await;
    assert!(document["pending"].is_null());
    assert_eq!(document["version_id"], pending);
    let formal: Value = serde_json::from_slice(
        &std::fs::read(context.directory.path().join("pipeline.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(formal["pipelines"][0]["id"], "in-place");
}

// 按下时待应用的已经不是这一版（别处又存了一版）：回冲突，什么都不动
// The pending version is no longer the one pressed (another was saved meanwhile): a conflict, and nothing changes
#[tokio::test]
async fn applying_a_version_that_is_no_longer_pending_is_a_conflict() {
    let context = authenticated_app().await;
    let first = save_pending(&context, "first", "第一版").await;
    let second = save_pending(&context, "second", "第二版").await;
    let (status, payload) = apply_version(&context, first).await;
    assert_eq!(status, StatusCode::CONFLICT, "{payload}");
    assert_eq!(payload["error"]["code"], "config_conflict");
    let document = get_json(&context, "/api/v1/config").await;
    assert_eq!(document["pending"]["version_id"], second);
}

async fn apply_audits(context: &AuthenticatedApp) -> usize {
    get_json(context, "/api/v1/audit?action_prefix=config.apply").await["events"]
        .as_array()
        .unwrap()
        .len()
}

// KixDNS 连不上时按「现在应用」：版本还是待应用，审计里不记一条什么都没做的「应用」
// 现在应用 while KixDNS is unreachable: the version stays pending, and no 「应用」 that did nothing is audited
#[tokio::test]
async fn applying_while_kixdns_is_unreachable_stays_pending_unaudited() {
    let context = authenticated_app().await;
    let pending = save_pending(&context, "deferred", "先存着").await;
    let (status, payload) = apply_version(&context, pending).await;
    assert_eq!(status, StatusCode::OK, "{payload}");
    assert_eq!(payload["apply_state"], "pending");
    assert_eq!(payload["version_id"], pending);
    assert_eq!(apply_audits(&context).await, 0);
    let document = get_json(&context, "/api/v1/config").await;
    assert_eq!(document["pending"]["version_id"], pending);
}

// 后台（或者上一次按）刚让这一版试过、没有生效：再按回的是它没生效的原因，不是「别处改过了」
// The background (or an earlier press) just tried this version and it did not take: pressing again answers with why, not
// 别处改过了
#[tokio::test]
async fn applying_a_version_that_failed_answers_with_its_reason() {
    let context = authenticated_app().await;
    let pending = save_pending(&context, "refused", "会被拒").await;
    let _kixdns = start_fake_kixdns(context.directory.path(), false);
    let (status, _) = apply_version(&context, pending).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, payload) = apply_version(&context, pending).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{payload}");
    assert_eq!(payload["error"]["code"], "reload_failed");
    assert!(
        payload["error"]["message"]
            .as_str()
            .unwrap()
            .contains("KixDNS 没有接受这份配置"),
        "{payload}"
    );
    assert_eq!(apply_audits(&context).await, 0);
}

// 已经生效了的版本再按一次，KixDNS 这会儿停了也照实回「已生效」（只是给不出它在用的配置）
// Pressing again on a version already in effect answers 已生效 even with KixDNS stopped right now (only the active config is unknown)
#[tokio::test]
async fn an_applied_version_answers_applied_even_with_kixdns_down() {
    let context = authenticated_app().await;
    let pending = save_pending(&context, "then-down", "生效后停了").await;
    let kixdns = start_fake_kixdns(context.directory.path(), true);
    let (status, _) = apply_version(&context, pending).await;
    assert_eq!(status, StatusCode::OK);
    kixdns.abort();
    let _ = kixdns.await;
    let (status, payload) = apply_version(&context, pending).await;
    assert_eq!(status, StatusCode::OK, "{payload}");
    assert_eq!(payload["apply_state"], "applied");
    assert!(payload["active_config"].is_null());
}

/// 配置页挑 `GeoSite` 分类：读配置里的文件，同一个文件只读一次；相对路径、读不到的文件给出原因；不登录不给。
/// Picking `GeoSite` categories on the config page: the config's files are read, each once; a relative or
/// unreadable path comes back with the reason; nothing without signing in.
#[tokio::test]
async fn geosite_categories_come_from_the_files_the_config_names() {
    use crate::geosite_catalog::test_data::{domain, site};

    let context = authenticated_app().await;
    let mut data = site(
        "GOOGLE",
        &[domain("google.com", &[]), domain("google.cn", &["cn"])],
    );
    data.extend(site("cn", &[domain("baidu.com", &[])]));
    let local = context.directory.path().join("local.dat");
    std::fs::write(&local, &data).unwrap();
    let missing = context.directory.path().join("missing.dat");
    // 拦截列表合并的文件不当 GeoSite 分类列出来 / The blocklists' merged file is not listed for its categories
    let blocklist = context
        .directory
        .path()
        .join("geo")
        .join(format!("blocklist-{}.json", "e".repeat(64)));
    std::fs::write(
        context.directory.path().join("pipeline.json"),
        serde_json::json!({
            "pipelines": [],
            "settings": { "geosite_data_paths": [local, "relative.dat", missing, local, blocklist] },
        })
        .to_string(),
    )
    .unwrap();

    let unauthorized = context
        .app
        .clone()
        .oneshot(
            Request::get("/api/v1/config/geo-data/geosite-categories")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let response = context
        .app
        .clone()
        .oneshot(
            Request::get("/api/v1/config/geo-data/geosite-categories")
                .header(COOKIE, context.cookies.clone())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap()).unwrap();
    let sha256 = crate::digest::sha256_hex(&data);
    assert_eq!(
        body["files"],
        serde_json::json!([
            { "path": local, "sha256": sha256, "error": null },
            { "path": "relative.dat", "sha256": null, "error": "写的是相对路径，面板不知道 KixDNS 从哪个目录找它" },
            { "path": missing, "sha256": null, "error": "文件不存在" },
        ]),
        "each path once, in config order"
    );
    assert_eq!(body["builtin"], Value::Null);
    assert_eq!(
        body["catalogs"],
        serde_json::json!({
            sha256: [
                { "name": "cn", "domains": 1, "attributes": [] },
                { "name": "google", "domains": 2, "attributes": [{ "key": "cn", "domains": 1 }] },
            ],
        })
    );
}

/// 内置那份和导入后的副本内容一样：分类只放一份，两边都指向它。
/// The built-in file and its imported copy hold the same bytes: the categories appear once and both point at them.
#[test]
fn the_builtin_geosite_and_its_imported_copy_share_one_catalog() {
    use crate::geosite_catalog::test_data::{domain, site};

    let directory = tempdir().unwrap();
    let data = site("cn", &[domain("baidu.com", &["cn"])]);
    let builtin = directory.path().join("builtin.dat");
    let copy = directory.path().join("geosite-copy.dat");
    std::fs::write(&builtin, &data).unwrap();
    std::fs::write(&copy, &data).unwrap();
    let cache = crate::geosite_catalog::CatalogCache::default();
    let result = super::geo::read_geosite_files(
        &cache,
        &[copy.to_string_lossy().into_owned()],
        Some(builtin),
    );
    let value = serde_json::to_value(&result).unwrap();
    let sha256 = crate::digest::sha256_hex(&data);
    assert_eq!(value["files"][0]["sha256"], sha256);
    assert_eq!(value["builtin"]["sha256"], sha256);
    assert_eq!(value["catalogs"].as_object().unwrap().len(), 1);
}

// ---------------------------------------------------------------------------
// 查询日志 / The query log
// ---------------------------------------------------------------------------

/// 假内核的查询日志交接区：`ring` 里是还留着的那些，`newest` 是编到第几条了
/// The fake kernel's query-log ring: `ring` holds what is still there, `newest` the last number given out
struct FakeQueryLog {
    instance: u64,
    ring: Vec<Value>,
    newest: u64,
    untracked: u64,
    capabilities: Vec<&'static str>,
    /// 每次来取时要的条数 / How many records each take asked for
    limits: Vec<usize>,
    /// 一次要得比这多，应答就超过 8 MiB / Asking for more than this makes the reply exceed 8 MiB
    oversize_above: Option<usize>,
    /// 带着这一条时应答就超过 8 MiB / A reply carrying this record exceeds 8 MiB
    oversize_seq: Option<u64>,
}

type SharedQueryLog = std::sync::Arc<std::sync::Mutex<FakeQueryLog>>;

fn fake_query_log(ring: Vec<Value>) -> SharedQueryLog {
    let newest = ring
        .last()
        .map_or(0, |entry| entry["seq"].as_u64().unwrap());
    std::sync::Arc::new(std::sync::Mutex::new(FakeQueryLog {
        instance: 100,
        ring,
        newest,
        untracked: 0,
        capabilities: vec!["querylog_v1"],
        limits: Vec::new(),
        oversize_above: None,
        oversize_seq: None,
    }))
}

/// 假的内核：报告磁盘上那份配置在用，按内核的规矩交出查询日志（`missed` 和 `more` 的算法一样）
/// A fake kernel: it reports the config on disk as in use and hands out its query log by the kernel's rules (`missed`
/// and `more` computed the same way)
fn start_fake_querylog_kernel(
    directory: &std::path::Path,
    log: SharedQueryLog,
) -> tokio::task::JoinHandle<()> {
    use axum::extract::Query;
    use axum::routing::get;
    let socket = directory.join("admin.sock");
    let config = directory.join("pipeline.json");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let health_log = log.clone();
    let router = Router::new()
        .route(
            "/v1/health",
            get(move || {
                let capabilities = health_log.lock().unwrap().capabilities.clone();
                async move {
                    axum::Json(serde_json::json!({
                        "protocol_version": 1, "status": "ok", "pid": 1, "version": "test", "upstream_commit": "test",
                        "patchset": "p0", "started_at_unix": 0, "uptime_seconds": 1, "config_generation": 1,
                        "capabilities": capabilities,
                    }))
                }
            }),
        )
        .route(
            "/v1/config/active",
            get(move || {
                let sha256 = crate::digest::sha256_hex(&std::fs::read(&config).unwrap());
                async move {
                    axum::Json(serde_json::json!({
                        "protocol_version": 1, "generation": 1, "sha256": sha256, "loaded_at_unix": 0,
                        "reload_sequence": 1, "last_reload": { "success": true, "error": null },
                    }))
                }
            }),
        )
        .route(
            "/v1/querylog",
            get(move |Query(query): Query<std::collections::HashMap<String, u64>>| {
                let mut log = log.lock().unwrap();
                let after = query["after"];
                let limit = usize::try_from(query["limit"]).unwrap();
                log.limits.push(limit);
                let seq = |entry: &Value| entry["seq"].as_u64().unwrap();
                let first_kept = log.ring.first().map_or(log.newest + 1, seq);
                let entries: Vec<Value> = log
                    .ring
                    .iter()
                    .filter(|entry| seq(entry) > after)
                    .take(limit)
                    .cloned()
                    .collect();
                let more = entries.last().is_some_and(|entry| seq(entry) < log.newest);
                let mut page = serde_json::json!({
                    "protocol_version": 1, "instance": log.instance, "capacity": 4096, "newest_seq": log.newest,
                    "missed": first_kept.saturating_sub(after + 1), "untracked": log.untracked, "more": more,
                    "entries": entries,
                });
                let carries_huge = log
                    .oversize_seq
                    .is_some_and(|huge| entries.iter().any(|entry| seq(entry) == huge));
                if carries_huge || log.oversize_above.is_some_and(|most| limit > most) {
                    page["padding"] = Value::String("x".repeat(9 * 1024 * 1024));
                }
                async move { axum::Json(page) }
            }),
        );
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() })
}

/// 内核的一条查询记录 / One kernel query record
fn kernel_entry(seq: u64, qname: &str, qtype: &str) -> Value {
    serde_json::json!({
        "seq": seq, "time_unix_ms": 1_792_065_600_000_u64 + seq, "client": "192.168.1.9", "transport": "udp",
        "qname": qname, "qtype": qtype, "latency_us": 900, "status": "completed", "outcome": "forwarded",
        "rcode": "NOERROR", "answers": ["93.184.215.14"], "pipeline": "main", "upstream": "1.1.1.1:53",
        "steps": [{"at_us": 1, "kind": "upstream", "upstream": "1.1.1.1:53", "transport": "udp", "via": "udp",
                   "result": "success", "latency_us": 800, "rcode": "NOERROR"}],
    })
}

/// 「空地址」拦截回一个 HTTPS 查询：NOERROR、没有记录 / A 空地址 block answering an HTTPS query: NOERROR, no records
fn blocked_https_entry(seq: u64) -> Value {
    serde_json::json!({
        "seq": seq, "time_unix_ms": 1_792_065_600_000_u64 + seq, "client": "192.168.1.9", "transport": "udp",
        "qname": "ads.example", "qtype": "HTTPS", "latency_us": 40, "status": "completed", "outcome": "static",
        "rcode": "NOERROR", "answers": [], "pipeline": "main", "rule": "block-ads",
        "steps": [
            {"at_us": 1, "kind": "pipeline", "pipeline": "main"},
            {"at_us": 2, "kind": "rule", "pipeline": "main", "rule": "block-ads", "phase": "request", "decision": "static"},
        ],
    })
}

fn querylog_items(state: &super::AppState) -> Vec<Value> {
    state
        .querylog
        .store
        .as_ref()
        .unwrap()
        .read_page(&crate::querylog::PageQuery {
            filter: crate::querylog::Filter::default(),
            before: None,
            after: None,
            limit: 500,
            cutoff_ms: 0,
        })
        .items
}

/// 「拦截 · SERVFAIL」：内核把 SERVFAIL 排在固定回答前面，记成失败 / 「Block · SERVFAIL」: the kernel ranks SERVFAIL above a
/// fixed answer and records a failure
fn servfail_block_entry(seq: u64) -> Value {
    serde_json::json!({
        "seq": seq, "time_unix_ms": 1_792_065_600_000_u64 + seq, "client": "192.168.1.9", "transport": "udp",
        "qname": "tracker.example", "qtype": "A", "latency_us": 40, "status": "completed", "outcome": "failed",
        "rcode": "SERVFAIL", "answers": [], "pipeline": "main", "rule": "block-trackers",
        "steps": [
            {"at_us": 1, "kind": "pipeline", "pipeline": "main"},
            {"at_us": 2, "kind": "rule", "pipeline": "main", "rule": "block-trackers", "phase": "request", "decision": "static"},
        ],
    })
}

fn querylog_ids(state: &super::AppState) -> Vec<u64> {
    querylog_items(state)
        .iter()
        .map(|item| item["id"].as_u64().unwrap())
        .collect()
}

/// 采集：普通条目原样记、按内核在用的配置分出拦截（「空地址」和「SERVFAIL」都是）、忽略的域名不记；交接区挤掉的
/// 和没记下的合成一行漏记；内核换了进程就从头取，进程时刻碰巧一样也认得出来
/// Collecting: ordinary entries are kept as they are, blocks are told apart by the config the kernel uses (空地址 and
/// SERVFAIL alike), ignored domains are not recorded; what the ring dropped and what went unrecorded make one gap row;
/// a restarted kernel is read from the start, even when its process time happens to match
#[tokio::test]
async fn the_collector_records_queries_gaps_and_follows_a_kernel_restart() {
    let directory = tempdir().unwrap();
    std::fs::write(
        directory.path().join("pipeline.json"),
        serde_json::json!({
            "pipelines": [{"id": "main", "rules": [
                {"name": "block-ads", "matchers": [{"type": "domain_suffix", "value": "ads.example"}],
                 "actions": [{"type": "static_ip_response", "ip": "0.0.0.0,::"}]},
                {"name": "block-trackers", "matchers": [{"type": "domain_suffix", "value": "tracker.example"}],
                 "actions": [{"type": "static_response", "rcode": "SERVFAIL"}]},
            ]}],
        })
        .to_string(),
    )
    .unwrap();
    let state = test_state(&directory).await;
    state
        .querylog
        .set_settings(crate::querylog::QueryLogSettings {
            ignored_domains: vec!["ignored.test".to_owned()],
            ..crate::querylog::QueryLogSettings::default()
        });
    let log = fake_query_log(vec![
        kernel_entry(2, "a.example", "A"),
        blocked_https_entry(3),
        servfail_block_entry(4),
        kernel_entry(5, "pixel.ignored.test", "A"),
    ]);
    log.lock().unwrap().untracked = 5;
    let _kernel = start_fake_querylog_kernel(directory.path(), log.clone());
    let mut collector = super::querylog::Collector::default();

    // 交接区开头的 1 在面板来之前就挤掉了，那时面板还没开始记，不算漏记
    // Record 1 left the ring before the panel came, when the panel was not recording yet: no gap
    collector.tick(&state).await.unwrap();
    let items = querylog_items(&state);
    assert_eq!(
        items.len(),
        3,
        "no gap, and the ignored domain is not recorded: {items:?}"
    );
    assert_eq!(items[0]["qname"], "tracker.example");
    assert_eq!(
        items[0]["outcome"], "blocked",
        "a SERVFAIL block is a block"
    );
    assert_eq!(items[1]["qname"], "ads.example");
    assert_eq!(
        items[1]["outcome"], "blocked",
        "told apart by the rule, not the empty answer"
    );
    assert_eq!(items[2]["outcome"], "forwarded");

    // 交接区溢出：6、7 被挤掉，又有 2 个没记下 / The ring overflowed: 6 and 7 were pushed out, and 2 more went unrecorded
    {
        let mut log = log.lock().unwrap();
        log.ring = vec![kernel_entry(8, "b.example", "AAAA")];
        log.newest = 8;
        log.untracked = 7;
    }
    collector.tick(&state).await.unwrap();
    let items = querylog_items(&state);
    assert_eq!(items[0]["qname"], "b.example");
    assert_eq!(items[1]["gap"], 4);

    // 内核重启：编号从 1 重新数 / The kernel restarted: numbering starts again at 1
    {
        let mut log = log.lock().unwrap();
        log.instance = 200;
        log.ring = vec![
            kernel_entry(1, "after-restart.example", "A"),
            kernel_entry(2, "c.example", "A"),
            kernel_entry(3, "d.example", "A"),
        ];
        log.newest = 3;
        log.untracked = 0;
    }
    collector.tick(&state).await.unwrap();
    assert_eq!(querylog_items(&state)[0]["qname"], "d.example");
    assert_eq!(querylog_ids(&state), [8, 7, 6, 5, 4, 3, 2, 1]);

    // 又重启了，进程时刻碰巧一样：编号比游标还小，照样从头取
    // Restarted again with the same process time: numbers below the cursor still give it away
    {
        let mut log = log.lock().unwrap();
        log.ring = vec![kernel_entry(1, "same-instance.example", "A")];
        log.newest = 1;
    }
    collector.tick(&state).await.unwrap();
    assert_eq!(querylog_items(&state)[0]["qname"], "same-instance.example");
    assert_eq!(
        state.querylog.store.as_ref().unwrap().cursor(),
        Some(crate::querylog::Cursor {
            instance: 200,
            seq: 1
        })
    );

    // 没有新的就什么也不写 / Nothing new writes nothing
    collector.tick(&state).await.unwrap();
    assert_eq!(querylog_items(&state).len(), 9);
}

/// 一页超过 8 MiB 的应答上限时减半再取，不在同一个游标上卡住
/// A page over the 8 MiB reply cap is taken again at half the size instead of sticking at the same cursor
#[tokio::test]
async fn the_collector_takes_smaller_pages_when_one_is_too_large() {
    let directory = tempdir().unwrap();
    let state = test_state(&directory).await;
    let log = fake_query_log(vec![kernel_entry(1, "a.example", "A")]);
    log.lock().unwrap().oversize_above = Some(100);
    let _kernel = start_fake_querylog_kernel(directory.path(), log.clone());

    super::querylog::Collector::default()
        .tick(&state)
        .await
        .unwrap();
    assert_eq!(log.lock().unwrap().limits, [250, 125, 62]);
    assert_eq!(querylog_ids(&state), [1]);
}

/// 一条也放不下时往前跳过它，不在同一个游标上卡住：有游标时算一行漏记；还没有游标时不算，那时分不清是太大的
/// 还是面板开始记之前就挤掉的
/// A record that cannot fit even alone is skipped instead of sticking at the same cursor: with a cursor it counts as a
/// gap row; without one it does not, since it cannot then be told from records pushed out before recording began
#[tokio::test]
async fn the_collector_skips_a_record_too_large_to_take() {
    let directory = tempdir().unwrap();
    let state = test_state(&directory).await;
    let log = fake_query_log(vec![
        kernel_entry(1, "huge.example", "A"),
        kernel_entry(2, "a.example", "A"),
    ]);
    log.lock().unwrap().oversize_seq = Some(1);
    let _kernel = start_fake_querylog_kernel(directory.path(), log.clone());
    let mut collector = super::querylog::Collector::default();

    collector.tick(&state).await.unwrap();
    assert_eq!(
        log.lock().unwrap().limits,
        [250, 125, 62, 31, 15, 7, 3, 1, 1, 1],
        "halved down to one, one probe for the process, then one at a time"
    );
    let items = querylog_items(&state);
    assert_eq!(items.len(), 1, "no gap row on the first take: {items:?}");
    assert_eq!(items[0]["qname"], "a.example");

    {
        let mut log = log.lock().unwrap();
        log.ring = vec![
            kernel_entry(3, "huge.example", "A"),
            kernel_entry(4, "b.example", "A"),
        ];
        log.newest = 4;
        log.oversize_seq = Some(3);
        log.limits.clear();
    }
    collector.tick(&state).await.unwrap();
    assert_eq!(
        log.lock().unwrap().limits,
        [250, 125, 62, 31, 15, 7, 3, 1, 1, 1]
    );
    let items = querylog_items(&state);
    assert_eq!(items[0]["qname"], "b.example");
    assert_eq!(
        items[1]["gap"], 1,
        "with a cursor the skipped record is a gap"
    );
    assert_eq!(
        state.querylog.store.as_ref().unwrap().cursor(),
        Some(crate::querylog::Cursor {
            instance: 100,
            seq: 4
        })
    );
}

/// 查询日志的目录打不开时面板照常启动，只是不记，接口说清楚 / With the query-log directory unusable the panel still starts,
/// records nothing, and the endpoints say so
#[tokio::test]
async fn an_unusable_querylog_directory_does_not_stop_the_panel() {
    let directory = tempdir().unwrap();
    std::fs::write(directory.path().join("querylog"), b"not a directory").unwrap();
    let state = test_state(&directory).await;
    assert!(state.querylog.store.is_none());
    let log = fake_query_log(vec![kernel_entry(1, "a.example", "A")]);
    let _kernel = start_fake_querylog_kernel(directory.path(), log.clone());
    super::querylog::Collector::default()
        .tick(&state)
        .await
        .unwrap();
    assert!(
        log.lock().unwrap().limits.is_empty(),
        "nothing to write to, so nothing is taken"
    );
}

/// 内核不支持查询日志时不去取，页面也照实说不支持 / A kernel without the query log is not asked, and the page says so
#[tokio::test]
async fn the_collector_leaves_a_kernel_without_the_query_log_alone() {
    let directory = tempdir().unwrap();
    let state = test_state(&directory).await;
    let log = fake_query_log(vec![kernel_entry(1, "a.example", "A")]);
    log.lock().unwrap().capabilities = Vec::new();
    let _kernel = start_fake_querylog_kernel(directory.path(), log.clone());
    assert!(state.querylog.supported(), "unknown counts as supported");

    super::querylog::Collector::default()
        .tick(&state)
        .await
        .unwrap();
    assert!(log.lock().unwrap().limits.is_empty());
    assert!(!state.querylog.supported());
    assert!(querylog_items(&state).is_empty());
}

async fn wait_for_querylog(context: &AuthenticatedApp, count: usize) -> Value {
    for _ in 0..50 {
        let page = get_json(context, "/api/v1/querylog").await;
        if page["items"].as_array().unwrap().len() >= count {
            return page;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("the collector never delivered {count} records");
}

async fn put_querylog_settings(context: &AuthenticatedApp, body: Value) -> (StatusCode, Value) {
    let request = Request::put("/api/v1/querylog/settings")
        .header(COOKIE, context.cookies.clone())
        .header("x-csrf-token", context.csrf_token.clone())
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    send_json(context, request).await
}

/// 页面用的接口：后台任务每秒取一次，按条件筛，设置检查后存下并记审计，清空以后什么也不剩
/// The page's endpoints: the background task takes once a second, reads filter, settings are checked, saved and
/// audited, and nothing is left after clearing
#[tokio::test]
async fn the_querylog_endpoints_filter_save_settings_and_clear() {
    let context = authenticated_app().await;
    let log = fake_query_log(vec![
        kernel_entry(1, "a.example", "A"),
        blocked_https_entry(2),
    ]);
    let _kernel = start_fake_querylog_kernel(context.directory.path(), log);

    let page = wait_for_querylog(&context, 2).await;
    let anonymous = Request::get("/api/v1/querylog")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        send_json(&context, anonymous).await.0,
        StatusCode::UNAUTHORIZED
    );
    let without_csrf = Request::post("/api/v1/querylog/clear")
        .header(COOKIE, context.cookies.clone())
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        send_json(&context, without_csrf).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(page["supported"], true);
    assert_eq!(page["newest_id"], 2);
    assert_eq!(page["next_before"], Value::Null);
    let blocked = get_json(&context, "/api/v1/querylog?outcomes=blocked,answered").await;
    // 这份配置里没有这条规则：只看回答，NOERROR 又没有记录，算自定义回答
    // The config has no such rule: by the answer alone, NOERROR with no records is a custom answer
    assert_eq!(blocked["items"][0]["outcome"], "answered");
    let by_domain = get_json(&context, "/api/v1/querylog?q=A.EXAMPLE&limit=1").await;
    assert_eq!(by_domain["items"].as_array().unwrap().len(), 1);
    assert_eq!(by_domain["items"][0]["qname"], "a.example");

    for (path, code) in [
        ("/api/v1/querylog?outcomes=lost", "querylog_filter_invalid"),
        (
            "/api/v1/querylog?rule=x&rule_phase=later",
            "querylog_filter_invalid",
        ),
        ("/api/v1/querylog?limit=501", "querylog_limit_invalid"),
    ] {
        let request = Request::get(path)
            .header(COOKIE, context.cookies.clone())
            .body(Body::empty())
            .unwrap();
        let (status, body) = send_json(&context, request).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}");
        assert_eq!(body["error"]["code"], code, "{path}");
    }

    let defaults = get_json(&context, "/api/v1/querylog/settings").await;
    assert_eq!(defaults["retention_hours"], 2_160);
    assert_eq!(defaults["max_bytes"], 500 * 1024 * 1024);
    assert!(defaults["used_bytes"].as_u64().unwrap() > 0);
    let (status, saved) = put_querylog_settings(
        &context,
        serde_json::json!({"retention_hours": 168, "ignored_domains": ["Tracker.Test."]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["retention_hours"], 168);
    assert_eq!(
        saved["max_bytes"],
        500 * 1024 * 1024,
        "a partial save keeps the rest"
    );
    assert_eq!(
        saved["ignored_domains"],
        serde_json::json!(["tracker.test"])
    );
    // 只改一项，其余照旧 / Changing one setting keeps the others
    let (status, again) =
        put_querylog_settings(&context, serde_json::json!({"ignored_domains": []})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["retention_hours"], 168);
    assert_eq!(again["ignored_domains"], serde_json::json!([]));
    let (status, refused) =
        put_querylog_settings(&context, serde_json::json!({"max_bytes": 1024})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(refused["error"]["code"], "querylog_settings_invalid");
    let audit = get_json(&context, "/api/v1/audit?action_prefix=querylog").await;
    assert_eq!(
        audit["events"][1]["detail"],
        "保存 7 天，最多 500 MB，不记录 1 个域名"
    );
    assert_eq!(
        audit["events"][0]["detail"],
        "保存 7 天，最多 500 MB，每个域名都记"
    );

    let request = Request::post("/api/v1/querylog/clear")
        .header(COOKIE, context.cookies.clone())
        .header("x-csrf-token", context.csrf_token.clone())
        .body(Body::empty())
        .unwrap();
    let (status, cleared) = send_json(&context, request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cleared["used_bytes"], 0);
    assert_eq!(cleared["oldest_unix_ms"], Value::Null);
    let page = get_json(&context, "/api/v1/querylog").await;
    assert!(page["items"].as_array().unwrap().is_empty());
}

/// 假的服务助手：每个请求回「OK」，收到的动作依次记下 / A fake service helper: answers OK to every request and
/// keeps the actions it received in order
fn start_fake_helper(
    directory: &std::path::Path,
) -> (
    tokio::task::JoinHandle<()>,
    std::sync::Arc<std::sync::Mutex<Vec<String>>>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::UnixListener::bind(directory.join("helper.sock")).unwrap();
    let actions = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = std::sync::Arc::clone(&actions);
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut action = String::new();
            stream.read_to_string(&mut action).await.unwrap();
            seen.lock().unwrap().push(action);
            stream.write_all(b"OK\n").await.unwrap();
        }
    });
    (task, actions)
}

async fn stop_fake_kixdns(directory: &std::path::Path, kixdns: tokio::task::JoinHandle<()>) {
    kixdns.abort();
    let _ = kixdns.await;
    let _ = std::fs::remove_file(directory.join("admin.sock"));
}

async fn post_empty(context: &AuthenticatedApp, path: &str) -> (StatusCode, Value) {
    let request = Request::post(path)
        .header(COOKIE, context.cookies.clone())
        .header("x-csrf-token", context.csrf_token.clone())
        .body(Body::empty())
        .unwrap();
    send_json(context, request).await
}

fn write_pipeline(directory: &std::path::Path, content: &Value) {
    std::fs::write(
        directory.join("pipeline.json"),
        serde_json::to_vec_pretty(content).unwrap(),
    )
    .unwrap();
}

fn set_unit(directory: &std::path::Path, active: &str, sub: &str) {
    std::fs::write(
        directory.join("unit-state"),
        format!("ActiveState={active}\nSubState={sub}\nMainPID=0\n"),
    )
    .unwrap();
}

/// 让假 `KixDNS` 当一个稳稳跑着的进程被看见两次（隔 4 秒） / Have the fake `KixDNS` seen twice as one steadily running process
/// (4 seconds apart)
async fn seen_steady(context: &AuthenticatedApp, directory: &std::path::Path) {
    std::fs::write(directory.join("kernel-uptime"), "60").unwrap();
    get_json(context, "/api/v1/config").await;
    std::fs::write(directory.join("kernel-uptime"), "64").unwrap();
    get_json(context, "/api/v1/config").await;
}

/// 改了监听地址、重启后起不来：退回只改正式文件里那一项、别的修改留着，写进文件再重启；再按一次就没有可退的了
/// A listen address changed and the restart does not come up: the rollback changes only that setting in the formal
/// file, keeps every other edit, writes the file and restarts; pressed again there is nothing left to put back
#[tokio::test]
async fn a_restart_that_does_not_come_back_can_put_the_changed_settings_back() {
    let context = authenticated_app().await;
    let directory = context.directory.path();
    let (_helper, actions) = start_fake_helper(directory);
    set_unit(directory, "active", "running");
    write_pipeline(
        directory,
        &serde_json::json!({ "settings": { "bind_udp": "0.0.0.0:53" }, "pipelines": [] }),
    );
    let kixdns = start_fake_kixdns_reporting_restart(directory, Some(serde_json::json!([])));
    seen_steady(&context, directory).await;
    stop_fake_kixdns(directory, kixdns).await;
    write_pipeline(
        directory,
        &serde_json::json!({ "settings": { "bind_udp": "0.0.0.0:5300", "min_ttl": 30 }, "pipelines": [] }),
    );
    let kixdns =
        start_fake_kixdns_reporting_restart(directory, Some(serde_json::json!(["bind_udp"])));
    get_json(&context, "/api/v1/config").await;
    // KixDNS 在跑时没有可退的 / Nothing to put back while KixDNS runs
    let (status, _) = post_empty(&context, "/api/v1/config/restart-rollback").await;
    assert_eq!(status, StatusCode::CONFLICT);
    // 新进程绑不上新地址，systemd 在重试 / The new process cannot bind the new address and systemd retries
    stop_fake_kixdns(directory, kixdns).await;
    set_unit(directory, "activating", "auto-restart");
    let document = get_json(&context, "/api/v1/config").await;
    assert_eq!(
        document["runtime"]["restart_rollback"],
        serde_json::json!({ "bind_udp": "0.0.0.0:53" })
    );
    let service = get_json(&context, "/api/v1/service").await;
    assert_eq!(service["did_not_come_up"], true);

    let (status, payload) = post_empty(&context, "/api/v1/config/restart-rollback").await;
    assert_eq!(status, StatusCode::OK, "{payload}");
    assert_eq!(actions.lock().unwrap().as_slice(), ["restart"]);
    let written: Value =
        serde_json::from_slice(&std::fs::read(directory.join("pipeline.json")).unwrap()).unwrap();
    assert_eq!(
        written["settings"],
        serde_json::json!({ "bind_udp": "0.0.0.0:53", "min_ttl": 30 })
    );
    let document = get_json(&context, "/api/v1/config").await;
    assert_eq!(document["pending"]["version_id"], payload["version_id"]);
    let (status, _) = post_empty(&context, "/api/v1/config/restart-rollback").await;
    assert_eq!(status, StatusCode::CONFLICT);
}

/// 一次新的启动、重启是新的尝试：它还在加载（服务 active、连不上）时不提上一次的起不来，退回也不接受；
/// 下一次 systemd 重试被看见时才又给出
/// A new start or restart is a new attempt: while it loads (service active, unreachable) the last failure is not
/// raised and a rollback is refused; it is offered again only once the next systemd retry is seen
#[tokio::test]
async fn a_new_attempt_does_not_inherit_the_last_failure() {
    let context = authenticated_app().await;
    let directory = context.directory.path();
    let (_helper, _actions) = start_fake_helper(directory);
    set_unit(directory, "active", "running");
    write_pipeline(
        directory,
        &serde_json::json!({ "settings": {}, "pipelines": [] }),
    );
    let kixdns = start_fake_kixdns_reporting_restart(directory, Some(serde_json::json!([])));
    seen_steady(&context, directory).await;
    stop_fake_kixdns(directory, kixdns).await;
    write_pipeline(
        directory,
        &serde_json::json!({ "settings": { "cache_capacity": 30000 }, "pipelines": [] }),
    );
    let kixdns =
        start_fake_kixdns_reporting_restart(directory, Some(serde_json::json!(["cache_capacity"])));
    get_json(&context, "/api/v1/config").await;
    stop_fake_kixdns(directory, kixdns).await;
    set_unit(directory, "activating", "auto-restart");
    let document = get_json(&context, "/api/v1/config").await;
    assert_eq!(
        document["runtime"]["restart_rollback"],
        serde_json::json!({ "cache_capacity": null })
    );

    // 占端口的程序停了，再重启一次：新进程还在加载 / The program holding the port stopped and it is restarted once more:
    // the new process is still loading
    set_unit(directory, "active", "running");
    post_empty(&context, "/api/v1/service/restart").await;
    let document = get_json(&context, "/api/v1/config").await;
    assert!(document["runtime"].get("restart_rollback").is_none());
    assert!(
        get_json(&context, "/api/v1/service")
            .await
            .get("did_not_come_up")
            .is_none()
    );
    let (status, _) = post_empty(&context, "/api/v1/config/restart-rollback").await;
    assert_eq!(status, StatusCode::CONFLICT);
    // 下一次重试被看见：又起不来了 / The next retry is seen: it failed again
    set_unit(directory, "activating", "auto-restart");
    let document = get_json(&context, "/api/v1/config").await;
    assert_eq!(
        document["runtime"]["restart_rollback"],
        serde_json::json!({ "cache_capacity": null })
    );
}

/// 起不来时存下的待应用版本没校验过：不写进正式文件，改好同样几项另存成新的待应用版本，等 `KixDNS` 回来再校验
/// A pending version saved while it is down was never checked: it is not written to the formal file; the same settings
/// are changed in it and it is stored as a new pending version, checked once `KixDNS` is back
#[tokio::test]
async fn the_rollback_keeps_an_unchecked_pending_version_out_of_the_formal_file() {
    let context = authenticated_app().await;
    let directory = context.directory.path();
    let (_helper, _actions) = start_fake_helper(directory);
    set_unit(directory, "active", "running");
    write_pipeline(
        directory,
        &serde_json::json!({ "settings": {}, "pipelines": [] }),
    );
    let kixdns = start_fake_kixdns_reporting_restart(directory, Some(serde_json::json!([])));
    seen_steady(&context, directory).await;
    stop_fake_kixdns(directory, kixdns).await;
    write_pipeline(
        directory,
        &serde_json::json!({ "settings": { "cache_capacity": 30000 }, "pipelines": [] }),
    );
    let kixdns =
        start_fake_kixdns_reporting_restart(directory, Some(serde_json::json!(["cache_capacity"])));
    get_json(&context, "/api/v1/config").await;
    stop_fake_kixdns(directory, kixdns).await;
    set_unit(directory, "activating", "auto-restart");
    let waiting = save_pending(&context, "edited-while-down", "起不来时改的").await;

    let (status, payload) = post_empty(&context, "/api/v1/config/restart-rollback").await;
    assert_eq!(status, StatusCode::OK, "{payload}");
    // 正式文件是原来那份退回这一项，没有待应用版本里的修改 / The formal file is the previous one with this setting put
    // back, without the pending version's edits
    let written: Value =
        serde_json::from_slice(&std::fs::read(directory.join("pipeline.json")).unwrap()).unwrap();
    assert_eq!(
        written,
        serde_json::json!({ "settings": {}, "pipelines": [] })
    );
    let id = payload["version_id"].as_i64().unwrap();
    assert!(id > waiting);
    let version = get_json(&context, &format!("/api/v1/config/versions/{id}")).await;
    assert_eq!(version["apply_state"], "pending");
    assert_eq!(
        version["content"]["pipelines"][0]["id"],
        "edited-while-down"
    );
    assert!(
        version["content"]["settings"]
            .get("cache_capacity")
            .is_none()
    );
}
