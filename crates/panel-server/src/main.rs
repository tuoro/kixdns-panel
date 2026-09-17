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
    #[arg(long, env = "KIXDNS_PANEL_BIND", default_value = "0.0.0.0:5738")]
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

    /// root 服务控制 helper 的 Unix Socket。
    #[arg(
        long,
        env = "KIXDNS_SERVICE_HELPER_SOCKET",
        default_value = "/run/kixdns-panel/control.sock"
    )]
    service_helper_socket: PathBuf,

    /// DNS 诊断服务器地址；本机地址会自动跟随当前配置的 UDP 监听端口。
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

    /// 当前完整安装包自带增强 Artifact 的 GitHub ID。
    #[arg(long, env = "KIXDNS_INSTALLED_SOURCE_ID")]
    installed_source_id: Option<String>,

    /// 当前完整安装包对应的面板提交，由安装脚本填写。
    #[arg(long, env = "KIXDNS_PANEL_INSTALLED_COMMIT")]
    panel_installed_commit: Option<String>,

    /// 当前正式面板安装包的 Release 标签；开发构建为空。
    #[arg(long, env = "KIXDNS_PANEL_INSTALLED_RELEASE")]
    panel_installed_release: Option<String>,

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

    /// 完整安装包保存的 `KixDNS` 构建身份目录。
    #[arg(
        long,
        env = "KIXDNS_BUNDLED_METADATA",
        default_value = "/var/lib/kixdns-panel/bundle"
    )]
    bundled_metadata: PathBuf,

    /// GitHub API Token 文件路径；未配置时使用匿名模式。
    #[arg(
        long,
        env = "KIXDNS_GITHUB_TOKEN_FILE",
        default_value = "/var/lib/kixdns-panel/github-token"
    )]
    github_token_path: PathBuf,

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

impl Args {
    fn into_settings(self) -> anyhow::Result<AppSettings> {
        let args = self;
        // 旧安装器会把没有值的安装身份写成 `KEY=`，clap 把它当作已提供的空值；
        // 空值一律按「未设置」处理，否则面板在 systemd 里反复崩溃。
        // Older installers wrote identity keys as `KEY=` and clap sees that as a
        // provided empty value; treat blank as unset instead of crash-looping.
        let installed_source_id = present(args.installed_source_id)
            .map(|value| value.parse::<u64>())
            .transpose()
            .context("KIXDNS_INSTALLED_SOURCE_ID 必须是正整数")?;
        Ok(AppSettings {
            bind: args.bind,
            database_path: args.database,
            config_path: args.config,
            control_socket: args.control_socket,
            service_unit: args.service_unit,
            service_helper_socket: args.service_helper_socket,
            diagnostic_server: args.diagnostic_server,
            update_repository: args.update_repository,
            update_workflow: args.update_workflow,
            update_release_workflow: args.update_release_workflow,
            update_branch: args.update_branch,
            update_artifact: args.update_artifact,
            installed_commit: present(args.installed_commit),
            installed_source_id,
            panel_installed_commit: present(args.panel_installed_commit),
            panel_installed_release: present(args.panel_installed_release),
            kixdns_binary: args.kixdns_binary,
            kixdns_versions: args.kixdns_versions,
            bundled_metadata: args.bundled_metadata,
            github_token_path: args.github_token_path,
            geo_data_path: args.geo_data,
            web_root: args.web_root,
            secure_cookie: args.secure_cookie,
            trusted_proxies: args.trusted_proxies,
        })
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    run(Args::parse().into_settings()?)
        .await
        .context("面板服务异常退出")
}

fn present(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

fn default_artifact() -> String {
    match std::env::consts::ARCH {
        "aarch64" => "kixdns-enhanced-linux-arm64".to_owned(),
        _ => "kixdns-enhanced-linux-x86_64".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_installed_identity_is_treated_as_absent() {
        // 旧版「仅安装面板」模式把这些键写成空值；面板必须照常启动。
        // The removed panel-only mode wrote these keys empty; the panel must still start.
        let settings = Args::try_parse_from([
            "kixdns-panel-server",
            "--installed-commit",
            "",
            "--installed-source-id",
            "",
            "--panel-installed-commit",
            " ",
            "--panel-installed-release",
            "",
        ])
        .expect("空的安装身份不应让参数解析失败")
        .into_settings()
        .unwrap();
        assert_eq!(settings.installed_commit, None);
        assert_eq!(settings.installed_source_id, None);
        assert_eq!(settings.panel_installed_commit, None);
        assert_eq!(settings.panel_installed_release, None);
    }

    #[test]
    fn malformed_installed_source_id_is_still_rejected() {
        let result = Args::try_parse_from(["kixdns-panel-server", "--installed-source-id", "abc"])
            .map_err(anyhow::Error::from)
            .and_then(Args::into_settings);
        assert!(result.is_err());
    }
}
