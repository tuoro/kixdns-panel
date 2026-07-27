use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::Context;
use clap::Parser;
use kixdns_panel_server::{AppSettings, run};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(version, about = "KixDNS 增强管理面板服务")]
struct Args {
    /// 面板 HTTP 监听地址。
    #[arg(long, env = "KIXDNS_PANEL_BIND", default_value = "127.0.0.1:8080")]
    bind: SocketAddr,

    /// `SQLite` 数据库路径。
    #[arg(long, env = "KIXDNS_PANEL_DATABASE", default_value = "data/panel.db")]
    database: PathBuf,

    /// `KixDNS` 配置文件路径；API 不能改写此路径。
    #[arg(long, env = "KIXDNS_CONFIG", default_value = "config/pipeline.json")]
    config: PathBuf,

    /// 为浏览器 Cookie 设置 Secure；通过 HTTPS 反向代理部署时应启用。
    #[arg(long, env = "KIXDNS_PANEL_SECURE_COOKIE", default_value_t = false)]
    secure_cookie: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();
    run(AppSettings {
        bind: args.bind,
        database_path: args.database,
        config_path: args.config,
        secure_cookie: args.secure_cookie,
    })
    .await
    .context("面板服务异常退出")
}
