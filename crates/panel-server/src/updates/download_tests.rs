//! 内核下载与安装：超时分层（API 用短总时限，下载只在断流或整体过久时放弃）、大小上限、
//! 摘要核对，以及从本地服务装一个 fork 发布包的完整过程。
//! Kernel downloads and installs: timeout layering (API calls keep a short total limit,
//! downloads give up only when data stops arriving or the whole transfer runs too long),
//! the size limit, the digest check, and installing a fork release package end to end
//! from a local server.

use std::time::{Duration, Instant};

use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::tests::{
    TEST_CAPABILITIES, TEST_VERSION, fork_remote, kernel_package, kernel_source_json, test_settings,
};
use super::{MAX_ARTIFACT_BYTES, UpdateError, UpdateManager, VersionKey, VersionSource};
use crate::db::Database;

/// 本地 HTTP 服务：声明 `declared` 字节，再每隔 `interval` 发一个字节，共 `chunks` 个；
/// 发完后停顿 `stall_after` 才关闭连接。
/// A local HTTP server that declares `declared` bytes, sends one byte every `interval` for
/// `chunks` bytes, and pauses `stall_after` before closing.
async fn trickle_server(
    declared: usize,
    chunks: usize,
    interval: Duration,
    stall_after: Duration,
) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let read = socket.read(&mut buffer).await.unwrap();
            if read == 0 {
                return;
            }
            request.extend_from_slice(&buffer[..read]);
        }
        let header =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n");
        if socket.write_all(header.as_bytes()).await.is_err() {
            return;
        }
        for _ in 0..chunks {
            tokio::time::sleep(interval).await;
            if socket.write_all(b"k").await.is_err() {
                return;
            }
        }
        tokio::time::sleep(stall_after).await;
    });
    format!("http://{address}/artifact.zip")
}

fn timeout_message(result: Result<Vec<u8>, UpdateError>) -> String {
    match result {
        Err(UpdateError::Network(message)) => message,
        other => panic!("期望网络超时错误，实际 {other:?}"),
    }
}

#[tokio::test]
async fn slow_artifact_download_outlives_the_api_timeout() {
    // 回归：下载与 API 共用 20 秒总超时，低于约 215 KB/s 的链路一定下载失败。
    // Regression: the download shared the API's 20 s total, so links below ~215 KB/s always failed.
    let url = trickle_server(8, 8, Duration::from_millis(100), Duration::ZERO).await;
    let client = UpdateManager::http_client(
        Duration::from_millis(300),
        Duration::from_secs(1),
        Duration::from_secs(1),
    )
    .unwrap();

    let bytes =
        UpdateManager::fetch_limited(&client, &url, MAX_ARTIFACT_BYTES, Duration::from_secs(5))
            .await
            .unwrap();

    assert_eq!(bytes, b"kkkkkkkk");
}

#[tokio::test]
async fn stalled_artifact_download_fails_on_the_read_timeout() {
    // 放宽总时限后，一个不再发数据的连接不能拖满 5 分钟。
    // With the total limit relaxed, a connection that stops sending must not hold on for 5 minutes.
    let url = trickle_server(4, 1, Duration::ZERO, Duration::from_secs(8)).await;
    let client = UpdateManager::http_client(
        Duration::from_secs(20),
        Duration::from_secs(1),
        Duration::from_millis(300),
    )
    .unwrap();
    let started = Instant::now();

    let message = timeout_message(
        UpdateManager::fetch_limited(&client, &url, MAX_ARTIFACT_BYTES, Duration::from_secs(20))
            .await,
    );

    assert!(
        started.elapsed() < Duration::from_secs(3),
        "断流应在读超时后放弃，实际等了 {:?}",
        started.elapsed()
    );
    assert!(message.contains("下载 KixDNS 内核超时"), "{message}");
}

#[tokio::test]
async fn endless_artifact_download_fails_on_the_download_timeout() {
    // 一直有数据但永远下不完的连接，要在下载总时限处停下并说明是下载超时。
    // A connection that keeps trickling but never finishes stops at the download limit and says so.
    let url = trickle_server(200, 200, Duration::from_millis(50), Duration::ZERO).await;
    let client = UpdateManager::http_client(
        Duration::from_secs(30),
        Duration::from_secs(1),
        Duration::from_secs(1),
    )
    .unwrap();
    let started = Instant::now();

    let message = timeout_message(
        UpdateManager::fetch_limited(
            &client,
            &url,
            MAX_ARTIFACT_BYTES,
            Duration::from_millis(500),
        )
        .await,
    );

    assert!(
        started.elapsed() < Duration::from_secs(3),
        "下载总时限应生效，实际等了 {:?}",
        started.elapsed()
    );
    assert!(message.contains("下载 KixDNS 内核超时"), "{message}");
}

/// 对每个连接依次回一个固定响应，并记下请求头（小写）。返回基址和记录。
/// Answers each connection with the next canned response and records the request
/// headers, lowercased. Returns the base URL and the record.
async fn recording_server(
    responses: Vec<Vec<u8>>,
) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = std::sync::Arc::clone(&requests);
    tokio::spawn(async move {
        for response in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = socket.read(&mut buffer).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            recorded
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(&request).to_lowercase());
            let _ = socket.write_all(&response).await;
        }
    });
    (format!("http://{address}"), requests)
}

fn response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

fn digest_of(bytes: &[u8]) -> String {
    format!("sha256:{}", super::sha256(bytes))
}

fn test_client() -> reqwest::Client {
    UpdateManager::http_client(
        Duration::from_secs(5),
        Duration::from_secs(1),
        Duration::from_secs(1),
    )
    .unwrap()
}

#[tokio::test]
async fn a_release_file_past_its_limit_is_refused() {
    let (server, _) = recording_server(vec![response("200 OK", "", &[b'k'; 2048])]).await;

    let error = UpdateManager::fetch_limited(
        &test_client(),
        &format!("{server}/manifest.json"),
        1024,
        Duration::from_secs(5),
    )
    .await
    .unwrap_err();

    assert!(
        matches!(error, UpdateError::Verification(ref message) if message == "超过 1\u{a0}KiB"),
        "{error:?}"
    );
}

#[tokio::test]
async fn follows_the_release_redirect_to_storage_without_credentials() {
    let (storage, storage_requests) =
        recording_server(vec![response("200 OK", "", b"package")]).await;
    let redirect = format!("Location: {storage}/package.zip\r\n");
    let (github, _) = recording_server(vec![response("302 Found", &redirect, b"")]).await;

    let bytes = UpdateManager::download_verified(
        &test_client(),
        &format!("{github}/releases/download/{TEST_VERSION}/package.zip"),
        &digest_of(b"package"),
        Duration::from_secs(5),
    )
    .await
    .unwrap();

    assert_eq!(bytes, b"package");
    assert!(!storage_requests.lock().unwrap()[0].contains("authorization"));
}

#[tokio::test]
async fn a_package_that_differs_from_the_manifest_is_refused() {
    let (server, _) = recording_server(vec![response("200 OK", "", b"tampered")]).await;

    let error = UpdateManager::download_verified(
        &test_client(),
        &format!("{server}/package.zip"),
        &digest_of(b"package"),
        Duration::from_secs(5),
    )
    .await
    .unwrap_err();

    assert!(
        matches!(error, UpdateError::Verification(ref message) if message.contains("校验值对不上")),
        "{error:?}"
    );
}

/// 一个刚建好的面板，只为安装测试：没有内核，fork 仓库是测试用的那个。
/// A fresh panel just for install tests: no kernel, and the test fork repository.
async fn install_manager(directory: &std::path::Path) -> UpdateManager {
    let database = Database::open(directory.join("panel.db")).await.unwrap();
    UpdateManager::new(database, test_settings(directory)).unwrap()
}

fn test_binary() -> Vec<u8> {
    let mut binary = vec![0_u8; 32];
    binary[..4].copy_from_slice(b"\x7fELF");
    binary[5] = 1;
    let machine = match std::env::consts::ARCH {
        "aarch64" => 183_u16,
        _ => 62_u16,
    };
    binary[18..20].copy_from_slice(&machine.to_le_bytes());
    binary[31] = 5;
    binary
}

#[tokio::test]
async fn installs_a_release_package_that_matches_its_manifest() {
    let directory = tempdir().unwrap();
    let manager = install_manager(directory.path()).await;
    let binary = test_binary();
    let mut remote = fork_remote(77, TEST_VERSION);
    let package = kernel_package(
        &binary,
        &kernel_source_json(TEST_VERSION, &remote.commit),
        TEST_CAPABILITIES,
    );
    let (server, _) = recording_server(vec![response("200 OK", "", &package)]).await;
    remote.download_url = format!("{server}/{}", remote.artifact);
    remote.artifact_digest = digest_of(&package);

    manager
        .install_resolved(&remote, &serde_json::json!({"pipelines": []}))
        .await
        .unwrap();

    let key = VersionKey::tracked(VersionSource::Fork, 77, &remote.commit).unwrap();
    let (manifest, stored) =
        super::load_verified_version(&directory.path().join("versions"), &key).unwrap();
    assert_eq!(stored, binary);
    assert_eq!(manifest.release_tag.as_deref(), Some(TEST_VERSION));
    assert_eq!(manifest.upstream_commit, remote.upstream_commit);
    assert_eq!(manifest.patchset, None);
    assert_eq!(
        manifest.artifact_digest.as_deref(),
        Some(remote.artifact_digest.as_str())
    );
    assert_eq!(manifest.config_capabilities, vec!["config_query_stats_v1"]);
}

#[tokio::test]
async fn a_package_for_another_version_is_not_stored() {
    let directory = tempdir().unwrap();
    let manager = install_manager(directory.path()).await;
    let mut remote = fork_remote(77, TEST_VERSION);
    // 包本身完好、摘要也对，但它说自己是另一版。
    // The package is intact and its digest matches, but it says it is another version.
    let package = kernel_package(
        &test_binary(),
        &kernel_source_json("2026.10.13", &remote.commit),
        TEST_CAPABILITIES,
    );
    let (server, _) = recording_server(vec![response("200 OK", "", &package)]).await;
    remote.download_url = format!("{server}/{}", remote.artifact);
    remote.artifact_digest = digest_of(&package);

    let error = manager
        .install_resolved(&remote, &serde_json::json!({"pipelines": []}))
        .await
        .unwrap_err();

    assert!(matches!(error, UpdateError::Verification(_)), "{error:?}");
    assert_eq!(
        std::fs::read_dir(directory.path().join("versions"))
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn a_package_whose_capabilities_differ_from_the_manifest_is_not_stored() {
    let directory = tempdir().unwrap();
    let manager = install_manager(directory.path()).await;
    let mut remote = fork_remote(77, TEST_VERSION);
    // 清单说认查询排行，包里却没有：配置页会按清单放行，内核却不认。
    // The manifest says query statistics are known but the package lacks them: the config
    // page would allow what the kernel then ignores.
    let package = kernel_package(
        &test_binary(),
        &kernel_source_json(TEST_VERSION, &remote.commit),
        r#"{"schema_version":1,"config_capabilities":[]}"#,
    );
    let (server, _) = recording_server(vec![response("200 OK", "", &package)]).await;
    remote.download_url = format!("{server}/{}", remote.artifact);
    remote.artifact_digest = digest_of(&package);

    let error = manager
        .install_resolved(&remote, &serde_json::json!({"pipelines": []}))
        .await
        .unwrap_err();

    assert!(
        matches!(error, UpdateError::Verification(ref message) if message.contains("配置能力")),
        "{error:?}"
    );
}

#[tokio::test]
async fn a_config_the_release_cannot_run_is_refused_before_downloading() {
    let directory = tempdir().unwrap();
    let manager = install_manager(directory.path()).await;
    let (server, requests) = recording_server(vec![response("200 OK", "", b"package")]).await;
    let mut remote = fork_remote(77, TEST_VERSION);
    remote.download_url = format!("{server}/{}", remote.artifact);
    remote.config_capabilities = Vec::new();

    let error = manager
        .install_resolved(
            &remote,
            &serde_json::json!({
                "pipelines": [{"id": "default", "rules": [{"actions": [{"type": "static_cname_response", "target": "origin.example."}]}]}]
            }),
        )
        .await
        .unwrap_err();

    assert!(
        matches!(error, UpdateError::IncompatibleConfig(_)),
        "{error:?}"
    );
    assert!(requests.lock().unwrap().is_empty(), "nothing is downloaded");
}
