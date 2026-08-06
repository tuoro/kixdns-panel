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

use super::{AppSettings, TrustedProxies, build_app, ensure_validation_accepted};
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
        kixdns_management_enabled: true,
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
