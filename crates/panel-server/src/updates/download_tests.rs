//! 产物下载的超时分层：API 用短总时限，下载只在断流或整体过久时放弃。
//! Timeout layering for artifact downloads: API calls keep a short total limit,
//! downloads give up only when data stops arriving or the whole transfer runs too long.

use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::{UpdateError, UpdateManager};

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

    let bytes = UpdateManager::fetch_artifact(&client, &url, Duration::from_secs(5))
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
        UpdateManager::fetch_artifact(&client, &url, Duration::from_secs(20)).await,
    );

    assert!(
        started.elapsed() < Duration::from_secs(3),
        "断流应在读超时后放弃，实际等了 {:?}",
        started.elapsed()
    );
    assert!(message.contains("下载 KixDNS 产物超时"), "{message}");
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
        UpdateManager::fetch_artifact(&client, &url, Duration::from_millis(500)).await,
    );

    assert!(
        started.elapsed() < Duration::from_secs(3),
        "下载总时限应生效，实际等了 {:?}",
        started.elapsed()
    );
    assert!(message.contains("下载 KixDNS 产物超时"), "{message}");
}
