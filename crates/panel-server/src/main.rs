use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::Context;
use clap::Parser;
use kixdns_panel_server::{AppSettings, TrustedProxies, run};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(version, about = "KixDNS 增强管理面板服务")]
struct Args {
    /// 面板 HTTP 监听地址。
    #[arg(long, env = "KIXDNS_PANEL_BIND", default_value = "127.0.0.1:5738")]
    bind: SocketAddr,

    /// `SQLite` 数据库路径。
    #[arg(long, env = "KIXDNS_PANEL_DATABASE", default_value = "data/panel.db")]
    database: PathBuf,

    /// `KixDNS` 配置文件路径；API 不能改写此路径。
    #[arg(long, env = "KIXDNS_CONFIG", default_value = "config/pipeline.json")]
    config: PathBuf,

    /// `KixDNS Enhanced` 本机控制 Socket。
    #[arg(
        long,
        env = "KIXDNS_CONTROL_SOCKET",
        default_value = "/run/kixdns/admin.sock"
    )]
    control_socket: PathBuf,

    /// 允许面板控制和读取日志的 `systemd` unit。
    #[arg(long, env = "KIXDNS_SERVICE_UNIT", default_value = "kixdns.service")]
    service_unit: String,

    /// DNS 诊断固定查询的服务器地址。
    #[arg(long, env = "KIXDNS_DIAGNOSTIC_SERVER", default_value = "127.0.0.1:53")]
    diagnostic_server: SocketAddr,

    /// 发布增强 Artifact 的 GitHub 仓库。
    #[arg(
        long,
        env = "KIXDNS_UPDATE_REPOSITORY",
        default_value = "tuoro/kixdns-panel"
    )]
    update_repository: String,

    /// 增强构建工作流文件名。
    #[arg(
        long,
        env = "KIXDNS_UPDATE_WORKFLOW",
        default_value = "build-kixdns.yml"
    )]
    update_workflow: String,

    /// 上游正式版增强构建工作流文件名。
    #[arg(
        long,
        env = "KIXDNS_UPDATE_RELEASE_WORKFLOW",
        default_value = "build-kixdns-release.yml"
    )]
    update_release_workflow: String,

    /// 下载 Artifact 的分支。
    #[arg(long, env = "KIXDNS_UPDATE_BRANCH", default_value = "main")]
    update_branch: String,

    /// nightly.link Artifact 名称。
    #[arg(long, env = "KIXDNS_UPDATE_ARTIFACT", default_value_t = default_artifact())]
    update_artifact: String,

    /// 当前完整安装包对应的面板仓库提交；在线更新记录优先于此值。
    #[arg(long, env = "KIXDNS_INSTALLED_COMMIT")]
    installed_commit: Option<String>,

    /// 当前完整安装包对应的面板提交，由安装脚本填写。
    #[arg(long, env = "KIXDNS_PANEL_INSTALLED_COMMIT")]
    panel_installed_commit: Option<String>,

    /// 当前正式面板安装包的 Release 标签；开发构建为空。
    #[arg(long, env = "KIXDNS_PANEL_INSTALLED_RELEASE")]
    panel_installed_release: Option<String>,

    /// 是否允许面板替换、安装和切换 `KixDNS` 二进制。
    #[arg(long, env = "KIXDNS_MANAGEMENT_ENABLED", default_value_t = true)]
    kixdns_management_enabled: bool,

    /// 自动更新替换的 `KixDNS Enhanced` 二进制路径。
    #[arg(long, env = "KIXDNS_BINARY", default_value = "/usr/local/bin/kixdns")]
    kixdns_binary: PathBuf,

    /// 已校验 `KixDNS Enhanced` 版本库存目录。
    #[arg(
        long,
        env = "KIXDNS_VERSIONS",
        default_value = "/var/lib/kixdns-panel/versions"
    )]
    kixdns_versions: PathBuf,

    /// 面板下载并管理的 GeoIP/GeoSite 数据目录。
    #[arg(
        long,
        env = "KIXDNS_GEO_DATA",
        default_value = "/var/lib/kixdns-panel/geo"
    )]
    geo_data: PathBuf,

    /// Vue 前端构建产物目录。
    #[arg(long, env = "KIXDNS_WEB_ROOT", default_value = "web/dist")]
    web_root: PathBuf,

    /// 为浏览器 Cookie 设置 Secure；通过 HTTPS 反向代理部署时应启用。
    #[arg(long, env = "KIXDNS_PANEL_SECURE_COOKIE", default_value_t = false)]
    secure_cookie: bool,

    /// 允许提供 `X-Forwarded-For` 的反向代理 CIDR，逗号分隔。
    #[arg(
        long,
        env = "KIXDNS_TRUSTED_PROXIES",
        default_value = "127.0.0.1/32,::1/128"
    )]
    trusted_proxies: TrustedProxies,
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
        control_socket: args.control_socket,
        service_unit: args.service_unit,
        diagnostic_server: args.diagnostic_server,
        update_repository: args.update_repository,
        update_workflow: args.update_workflow,
        update_release_workflow: args.update_release_workflow,
        update_branch: args.update_branch,
        update_artifact: args.update_artifact,
        installed_commit: args.installed_commit,
        panel_installed_commit: args.panel_installed_commit,
        panel_installed_release: args.panel_installed_release,
        kixdns_management_enabled: args.kixdns_management_enabled,
        kixdns_binary: args.kixdns_binary,
        kixdns_versions: args.kixdns_versions,
        geo_data_path: args.geo_data,
        web_root: args.web_root,
        secure_cookie: args.secure_cookie,
        trusted_proxies: args.trusted_proxies,
    })
    .await
    .context("面板服务异常退出")
}

fn default_artifact() -> String {
    match std::env::consts::ARCH {
        "aarch64" => "kixdns-enhanced-linux-arm64".to_owned(),
        _ => "kixdns-enhanced-linux-x86_64".to_owned(),
    }
}
