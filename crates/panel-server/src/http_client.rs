//! 面板连外网（GitHub API、内核和面板的更新包、Geo 数据、拦截列表）用的 HTTP 客户端
//! The HTTP client the panel reaches the internet with (GitHub API, kernel and panel updates, Geo data, block lists)

use std::sync::Once;

use reqwest::{Certificate, ClientBuilder};

/// 带着面板的 User-Agent 的客户端：TLS 用 rustls 和 ring，只认编进二进制的 Mozilla 根证书（webpki-root-certs），不读系统
/// 证书：OpenWrt 安装包不依赖 ca-bundle，没装它的路由器上照样能连。代理照 `HTTPS_PROXY` 这些环境变量走，超时和重定向由调用方定
/// A client with the panel's User-Agent: TLS through rustls and ring, trusting only the Mozilla roots built into the binary
/// (`webpki-root-certs`) and never the system's, since the `OpenWrt` package does not depend on `ca-bundle` and a router
/// without it still connects. Proxies follow environment variables such as `HTTPS_PROXY`; the caller sets the timeouts and
/// redirects
pub(crate) fn builder() -> ClientBuilder {
    // reqwest 只带 rustls、不带加密实现（rustls-no-provider），建客户端前要先装上进程级的 ring / reqwest carries rustls without a
    // crypto provider (rustls-no-provider), so the process-wide ring provider goes in before any client is built
    static RING: Once = Once::new();
    RING.call_once(|| {
        rustls::crypto::ring::default_provider()
            .install_default()
            .expect("面板里只有这里装 rustls 的加密实现");
    });
    reqwest::Client::builder()
        .user_agent(concat!("kixdns-panel/", env!("CARGO_PKG_VERSION")))
        .tls_certs_only(
            webpki_root_certs::TLS_SERVER_ROOT_CERTS
                .iter()
                .map(|der| Certificate::from_der(der).expect("只用 rustls 时 DER 原样收下")),
        )
}
