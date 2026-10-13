use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock};

use crate::control::ControlClient;
use crate::db::Database;
use crate::operations::{Operations, ServiceAction};

mod catalog;
mod github;
mod install;
mod validation;

use github::read_github_token;
use validation::{parse_panel_release_version, validate_commit, validate_slug, wait_until_healthy};

#[cfg(not(unix))]
use validation::ensure_update_platform;

// 这些只有测试通过 `super::` 使用。 / Used only by the tests, through `super::`.
#[cfg(test)]
use catalog::{
    panel_release_asset_name, remote_version, to_kixdns_update_notice, to_panel_update_notice,
};
#[cfg(test)]
use github::{validate_github_token, write_github_token};
#[cfg(test)]
use install::extract_artifact;
#[cfg(test)]
use storage::{
    load_bundled_manifest, load_verified_version, prune_versions, store_version,
    update_stored_capabilities,
};
#[cfg(test)]
use validation::{parse_kernel_version, sha256, validate_digest};

const ACTIVE_VERSION_KEY: &str = "installed_panel_version";
const LEGACY_ACTIVE_COMMIT_KEY: &str = "installed_panel_commit";
/// 上一个内核：回退的目标，也是本机除当前内核之外唯一留下的版本。
/// The previous kernel: the rollback target, and the only version kept besides the
/// current one.
const PREVIOUS_VERSION_KEY: &str = "previous_kixdns_version";
/// 旧轨道的内核（Action 构建或更早的 Release）第一次被换成 fork 发布版的时间。有这条
/// 记录，用户自己回退到旧内核后，面板重启时不再替换一次。
/// When a kernel from an old track (an Action build or an earlier Release) was first
/// replaced by a fork release. With this recorded, a user who rolls back to the old kernel
/// is not replaced again when the panel restarts.
const LEGACY_REPLACED_KEY: &str = "legacy_kernel_replaced_at";
const UPSTREAM_REPOSITORY: &str = "olicesx/kixdns";
const PANEL_REPOSITORY: &str = "tuoro/kixdns-panel";
const MAX_ARTIFACT_BYTES: usize = 128 * 1024 * 1024;
const MAX_BINARY_BYTES: u64 = 96 * 1024 * 1024;
/// 内核发布附带的清单：版本、提交和每个架构内核包的大小与 SHA-256。
/// The manifest attached to a kernel release: version, commit, and each architecture's
/// package size and SHA-256.
const RELEASE_MANIFEST_NAME: &str = "manifest.json";
const MAX_RELEASE_MANIFEST_BYTES: usize = 64 * 1024;
const MANIFEST_SCHEMA_VERSION: u32 = 5;
const SOURCE_MANIFEST_SCHEMA_VERSION: u32 = 4;
const CONTROL_PROTOCOL_VERSION: u32 = 1;
const MAX_BUILD_IDENTITY_BYTES: u64 = 64 * 1024;
const MAX_CAPABILITIES_BYTES: u64 = 64 * 1024;
const REMOTE_CACHE_TTL: Duration = Duration::from_mins(1);
const PANEL_CACHE_TTL: Duration = Duration::from_mins(15);
const MAX_GITHUB_TOKEN_BYTES: usize = 256;

/// 版本切换对宿主机的全部要求。抽成 trait 让切换流程能用假宿主测试：
/// 测试据此断言切换只发 Restart（systemd 的 restart 不改开机策略），
/// 从不发会顺带 enable/disable 的 Start/Stop。
/// Everything a version switch needs from the host. As a trait the switch can
/// run against a fake host, which is how tests assert that a switch only ever
/// sends Restart (systemd's restart keeps enablement) and never the Start/Stop
/// that also enable/disable the unit.
pub trait ServiceHost: Send + Sync {
    /// 服务当前是否在运行（含正在启动、重载）。
    /// Whether the service currently runs (including activating or reloading).
    fn service_running(&self) -> BoxFuture<'_, Result<bool, UpdateError>>;
    fn service_action(&self, action: ServiceAction) -> BoxFuture<'_, Result<(), UpdateError>>;
    fn wait_until_healthy(&self) -> BoxFuture<'_, Result<(), UpdateError>>;
    fn runtime_capabilities(&self) -> BoxFuture<'_, Result<Vec<String>, UpdateError>>;
}

/// 真实宿主：systemctl 读状态、root helper 重启、控制通道做健康检查。
/// 持有克隆而不是引用，这样整个切换可以交给独立任务跑完。
/// The real host: systemctl for state, the root helper for restart and the
/// control socket for health. It owns clones rather than references so a
/// whole switch can be handed to its own task.
#[derive(Clone)]
pub struct LiveServiceHost {
    operations: Operations,
    control: ControlClient,
}

impl LiveServiceHost {
    pub fn new(operations: Operations, control: ControlClient) -> Self {
        Self {
            operations,
            control,
        }
    }
}

impl ServiceHost for LiveServiceHost {
    // 这组状态与 web/src/version-switch.ts 的 serviceRunsForSwitch 保持一致。
    // Keep this set in step with serviceRunsForSwitch in web/src/version-switch.ts.
    fn service_running(&self) -> BoxFuture<'_, Result<bool, UpdateError>> {
        Box::pin(async move {
            let status = self
                .operations
                .service_status()
                .await
                .map_err(|error| UpdateError::Install(format!("读取服务状态失败：{error}")))?;
            Ok(matches!(
                status.active_state.as_str(),
                "active" | "activating" | "reloading"
            ))
        })
    }

    fn service_action(&self, action: ServiceAction) -> BoxFuture<'_, Result<(), UpdateError>> {
        Box::pin(async move {
            self.operations
                .service_action(action)
                .await
                .map(|_| ())
                .map_err(|error| UpdateError::Install(error.to_string()))
        })
    }

    fn wait_until_healthy(&self) -> BoxFuture<'_, Result<(), UpdateError>> {
        Box::pin(wait_until_healthy(&self.control))
    }

    fn runtime_capabilities(&self) -> BoxFuture<'_, Result<Vec<String>, UpdateError>> {
        Box::pin(async move {
            self.control
                .health()
                .await
                .map(|health| health.capabilities)
                .map_err(|error| UpdateError::Install(error.to_string()))
        })
    }
}

#[derive(Clone)]
pub struct UpdateManager {
    client: reqwest::Client,
    database: Database,
    kernel_repository: Arc<str>,
    initial_source: VersionSource,
    initial_commit: Option<Arc<str>>,
    initial_source_id: Option<u64>,
    panel_commit: Option<Arc<str>>,
    panel_release: Option<Arc<str>>,
    binary_path: Arc<PathBuf>,
    versions_path: Arc<PathBuf>,
    bundled_metadata: Arc<PathBuf>,
    apply_lock: Arc<Mutex<()>>,
    latest_cache: Arc<RwLock<Option<CachedLatest>>>,
    panel_cache: Arc<RwLock<Option<CachedPanelUpdate>>>,
    github_token_path: Arc<PathBuf>,
    github_token: Arc<RwLock<Option<SecretString>>>,
    github_rate_limit: Arc<RwLock<Option<GithubRateLimit>>>,
}

pub struct UpdateSettings {
    /// 发布内核的仓库（日期版本的 GitHub Release）。
    /// The repository that publishes kernels (date-versioned GitHub Releases).
    pub kernel_repository: String,
    /// 完整安装包自带内核的来源：`fork`，或者旧安装包留下的空值（Action 构建）。
    /// Where the full package's bundled kernel came from: `fork`, or empty as left by older
    /// packages (an Action build).
    pub installed_source: Option<String>,
    pub installed_commit: Option<String>,
    pub installed_source_id: Option<u64>,
    pub panel_installed_commit: Option<String>,
    pub panel_installed_release: Option<String>,
    pub binary_path: PathBuf,
    pub versions_path: PathBuf,
    pub bundled_metadata: PathBuf,
    pub github_token_path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
pub struct GithubRateLimit {
    pub limit: u64,
    pub remaining: u64,
    pub reset_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct GithubTokenStatus {
    pub configured: bool,
    pub rate_limit: Option<GithubRateLimit>,
}

#[derive(Debug, Deserialize)]
struct GithubRateLimitResponse {
    resources: GithubRateLimitResources,
}

#[derive(Debug, Deserialize)]
struct GithubRateLimitResources {
    core: GithubRateLimitCore,
}

#[derive(Debug, Deserialize)]
struct GithubRateLimitCore {
    limit: u64,
    remaining: u64,
    reset: i64,
}

/// 系统页的内核卡片：当前、上一个和远端最新的内核。远端读不到时其余照常返回。
/// The System page's kernel card: the current, the previous and the newest remote
/// kernel. When the remote cannot be read the rest is still returned.
#[derive(Debug, Clone, Serialize)]
pub struct KixdnsKernel {
    pub binary_present: bool,
    pub active: Option<InstalledVersion>,
    pub previous: Option<InstalledVersion>,
    pub latest: Option<RemoteVersion>,
    pub remote_error: Option<String>,
}

/// 内核和面板的更新提示各查各的：一边查不到，另一边照样提示。
/// Kernel and panel updates are checked separately: when one cannot be read, the other
/// is still offered.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateNotifications {
    pub kixdns: Option<KixdnsUpdateNotice>,
    pub kixdns_error: Option<String>,
    pub panel: Option<PanelUpdateNotice>,
    pub panel_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KixdnsUpdateNotice {
    pub available: bool,
    pub current_commit: Option<String>,
    pub latest_commit: String,
    pub source_id: u64,
    /// 最新版本的日期版本号，例如 2026.10.13.2。
    /// The newest version's date version, such as 2026.10.13.2.
    pub release_tag: String,
    pub created_at: Option<String>,
    /// 这一版的发布页，写着更新说明。 / This version's release page, with its notes.
    pub release_url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PanelUpdateNotice {
    pub available: bool,
    pub current_version: String,
    pub current_commit: Option<String>,
    pub current_release: Option<String>,
    pub latest_version: Option<String>,
    pub published_at: Option<String>,
    pub release_url: Option<String>,
    pub artifact: Option<String>,
    pub artifact_digest: Option<String>,
    pub download_url: Option<String>,
}

/// 内核来自哪里。远端只剩 fork 发布的日期版本；Action（面板仓库按补丁集构建）和
/// Release（更早的正式版轨道）只出现在以前装下的内核上。
/// Where a kernel came from. Only the fork's date-versioned releases are offered
/// remotely; Action (built by the panel repository from a patchset) and Release (the
/// older release track) appear only on kernels installed earlier.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VersionSource {
    #[default]
    Action,
    Release,
    Fork,
}

impl VersionSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Action => "action",
            Self::Release => "release",
            Self::Fork => "fork",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "action" => Some(Self::Action),
            "release" => Some(Self::Release),
            "fork" => Some(Self::Fork),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct VersionKey {
    source: VersionSource,
    source_id: Option<u64>,
    commit: String,
}

impl VersionKey {
    fn new(source: VersionSource, commit: impl Into<String>) -> Result<Self, UpdateError> {
        let commit = commit.into().to_ascii_lowercase();
        validate_commit(&commit)?;
        Ok(Self {
            source,
            source_id: None,
            commit,
        })
    }

    fn tracked(
        source: VersionSource,
        source_id: u64,
        commit: impl Into<String>,
    ) -> Result<Self, UpdateError> {
        if source_id == 0 {
            return Err(UpdateError::Invalid("版本来源身份无效".to_owned()));
        }
        let mut key = Self::new(source, commit)?;
        key.source_id = Some(source_id);
        Ok(key)
    }

    fn encoded(&self) -> String {
        match self.source_id {
            Some(source_id) => format!("{}:{source_id}:{}", self.source.as_str(), self.commit),
            None => format!("{}:{}", self.source.as_str(), self.commit),
        }
    }

    fn directory_name(&self) -> String {
        match self.source_id {
            Some(source_id) => format!("{}-{source_id}-{}", self.source.as_str(), self.commit),
            None => format!("{}-{}", self.source.as_str(), self.commit),
        }
    }

    fn parse(value: &str) -> Result<Self, UpdateError> {
        let Some((source, identity)) = value.split_once(':') else {
            return Self::new(VersionSource::Action, value);
        };
        let source = VersionSource::parse(source)
            .ok_or_else(|| UpdateError::Invalid("活动版本来源无效".to_owned()))?;
        let Some((source_id, commit)) = identity.split_once(':') else {
            return Self::new(source, identity);
        };
        let source_id = source_id
            .parse::<u64>()
            .map_err(|_| UpdateError::Invalid("活动版本来源身份无效".to_owned()))?;
        Self::tracked(source, source_id, commit)
    }

    fn remote(version: &RemoteVersion) -> Result<Self, UpdateError> {
        Self::tracked(version.source, version.source_id, version.commit.clone())
    }

    fn installed(version: &InstalledVersion) -> Result<Self, UpdateError> {
        let source = version.source.unwrap_or_default();
        match version.source_id {
            Some(source_id) => Self::tracked(source, source_id, version.commit.clone()),
            None => Self::new(source, version.commit.clone()),
        }
    }
}

/// 远端最新的内核：fork 最新发布里本机架构的那个包，已对过发布清单。
/// The newest remote kernel: this architecture's package in the fork's latest release,
/// already checked against the release manifest.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteVersion {
    pub source: VersionSource,
    /// 内核包在 GitHub 上的资源编号。 / The package's GitHub asset id.
    pub source_id: u64,
    pub commit: String,
    pub release_tag: String,
    pub upstream_commit: Option<String>,
    pub created_at: Option<String>,
    /// 基于的原版提交。 / The upstream commit it is based on.
    pub source_url: Option<String>,
    /// 这一版的发布页。 / This version's release page.
    pub build_url: String,
    pub artifact: String,
    pub artifact_digest: String,
    pub download_url: String,
    pub control_protocol: u32,
    pub config_capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstalledVersion {
    pub source: Option<VersionSource>,
    pub source_id: Option<u64>,
    pub commit: String,
    pub run_id: Option<u64>,
    pub release_tag: Option<String>,
    pub created_at: Option<String>,
    pub source_url: Option<String>,
    pub build_url: Option<String>,
    pub artifact: String,
    pub artifact_digest: Option<String>,
    pub upstream_repository: Option<String>,
    pub upstream_commit: Option<String>,
    pub patchset: Option<u32>,
    pub dependency_revision: Option<u32>,
    pub control_protocol: Option<u32>,
    pub config_capabilities: Vec<String>,
    pub binary_sha256: String,
    pub installed_at: i64,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VersionManifest {
    schema_version: u32,
    #[serde(default)]
    source: Option<VersionSource>,
    #[serde(default)]
    source_id: Option<u64>,
    commit: String,
    #[serde(default)]
    run_id: Option<u64>,
    #[serde(default)]
    release_tag: Option<String>,
    created_at: Option<String>,
    #[serde(default, alias = "run_url")]
    source_url: Option<String>,
    #[serde(default)]
    build_url: Option<String>,
    artifact: String,
    artifact_digest: Option<String>,
    #[serde(default)]
    upstream_repository: Option<String>,
    #[serde(default)]
    upstream_commit: Option<String>,
    #[serde(default)]
    patchset: Option<u32>,
    #[serde(default)]
    dependency_revision: Option<u32>,
    #[serde(default)]
    control_protocol: Option<u32>,
    #[serde(default)]
    config_capabilities: Vec<String>,
    binary_sha256: String,
    installed_at: i64,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct ReleaseAsset {
    #[serde(default)]
    id: u64,
    name: String,
    #[serde(default)]
    size: u64,
    digest: Option<String>,
}

/// 内核发布附带的 `manifest.json`。以后多出的字段不影响读取。
/// The `manifest.json` attached to a kernel release. Fields added later do not stop it
/// from being read.
#[derive(Debug, Clone, Deserialize)]
struct ReleaseManifest {
    schema_version: u32,
    repository: String,
    version: String,
    commit: String,
    #[serde(default)]
    upstream_commit: Option<String>,
    control_protocol: u32,
    config_capabilities: Vec<String>,
    assets: std::collections::HashMap<String, ReleaseManifestAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct ReleaseManifestAsset {
    name: String,
    size: u64,
    sha256: String,
}

/// 内核包里的 `KIXDNS_SOURCE.json`：这个包是哪个仓库、哪一版、哪个提交、哪个架构。
/// `KIXDNS_SOURCE.json` inside a kernel package: which repository, version, commit and
/// architecture the package is.
#[derive(Debug, Clone, Deserialize)]
struct KernelSource {
    schema_version: u32,
    repository: String,
    version: String,
    commit: String,
    #[serde(default)]
    upstream_commit: Option<String>,
    arch: String,
    control_protocol: u32,
}

/// 旧的 Action 内核包和完整包里的上游身份（`upstream.lock.json`）。只在识别以前装下的
/// 内核时还会读到。
/// The upstream identity (`upstream.lock.json`) in old Action packages and full packages.
/// Read only when recognising kernels installed earlier.
#[derive(Debug, Clone, Deserialize)]
struct BuildIdentity {
    repository: String,
    source: VersionSource,
    commit: String,
    #[serde(default)]
    official_run_id: Option<u64>,
    patchset: u32,
    #[serde(default)]
    dependency_revision: Option<u32>,
    control_protocol: u32,
}

struct ExtractedArtifact {
    binary: Vec<u8>,
    source: KernelSource,
    config_capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactCapabilities {
    schema_version: u32,
    config_capabilities: Vec<String>,
}

struct CachedLatest {
    loaded_at: Instant,
    version: RemoteVersion,
}

struct CachedPanelUpdate {
    loaded_at: Instant,
    notice: PanelUpdateNotice,
}

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("更新配置无效：{0}")]
    Invalid(String),
    #[error("检查更新失败：{0}")]
    Network(String),
    /// 内核包和面板更新包都会走到这里，开头不写死是哪一种 / Both kernel packages and panel updates end up here, so the opening does not name either
    #[error("更新包没通过校验：{0}")]
    Verification(String),
    #[error("安装更新失败：{0}")]
    Install(String),
    #[error("目标版本与当前配置不兼容：{0}")]
    IncompatibleConfig(String),
    /// 页面看到的状态已经过时，比如又发布了更新的版本、本机没有上一个内核。
    /// The state the page showed is out of date: a newer version has been released, or
    /// there is no previous kernel on this host.
    #[error("{0}")]
    Conflict(String),
    #[error("当前平台不支持自动更新")]
    Unsupported,
}

impl UpdateError {
    /// 页面在「检查失败：」后面接的那句：检查更新失败只给原因，不再带自己的前缀。
    /// The phrase the page puts after 检查失败：; a failed check gives only its cause, without its own prefix.
    pub fn reason(&self) -> String {
        match self {
            Self::Network(reason) | Self::Install(reason) => reason.clone(),
            other => other.to_string(),
        }
    }
}

impl UpdateManager {
    pub fn new(database: Database, settings: UpdateSettings) -> Result<Self, UpdateError> {
        let UpdateSettings {
            kernel_repository,
            installed_source,
            installed_commit,
            installed_source_id,
            panel_installed_commit,
            panel_installed_release,
            binary_path,
            versions_path,
            bundled_metadata,
            github_token_path,
        } = settings;
        let panel_installed_release =
            panel_installed_release.filter(|release| !release.trim().is_empty());
        validate_slug(&kernel_repository, true)?;
        let initial_source = match installed_source.as_deref().map(str::trim) {
            None | Some("") => VersionSource::Action,
            Some(source) => VersionSource::parse(source)
                .filter(|source| *source != VersionSource::Release)
                .ok_or_else(|| UpdateError::Invalid("已安装 KixDNS 的来源无效".to_owned()))?,
        };
        if initial_source == VersionSource::Fork && installed_source_id.is_none() {
            return Err(UpdateError::Invalid(
                "已安装 KixDNS 的来源身份不完整".to_owned(),
            ));
        }
        if let Some(commit) = installed_commit.as_deref() {
            validate_commit(commit)?;
        }
        if installed_source_id == Some(0)
            || (installed_source_id.is_some() && installed_commit.is_none())
        {
            return Err(UpdateError::Invalid(
                "已安装 KixDNS 的来源身份不完整".to_owned(),
            ));
        }
        if let Some(commit) = panel_installed_commit.as_deref() {
            validate_commit(commit)?;
        }
        if let Some(release) = panel_installed_release.as_deref() {
            let installed = parse_panel_release_version(release)
                .map_err(|_| UpdateError::Invalid("已安装面板 Release 标签无效".to_owned()))?;
            let package = semver::Version::parse(env!("CARGO_PKG_VERSION"))
                .map_err(|error| UpdateError::Invalid(format!("面板版本无效：{error}")))?;
            if installed != package {
                return Err(UpdateError::Invalid(
                    "已安装面板 Release 与程序版本不一致".to_owned(),
                ));
            }
        }
        ensure_directory(&versions_path)?;
        let binary_parent = binary_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .ok_or_else(|| UpdateError::Invalid("KixDNS 二进制缺少父目录".to_owned()))?;
        ensure_directory(binary_parent)?;
        let client =
            Self::http_client(Self::API_TIMEOUT, Self::CONNECT_TIMEOUT, Self::READ_TIMEOUT)?;
        let github_token = read_github_token(&github_token_path)?;
        Ok(Self {
            client,
            database,
            kernel_repository: Arc::from(kernel_repository),
            initial_source,
            initial_commit: installed_commit.map(|commit| Arc::from(commit.to_ascii_lowercase())),
            initial_source_id: installed_source_id,
            panel_commit: panel_installed_commit
                .map(|commit| Arc::from(commit.to_ascii_lowercase())),
            panel_release: panel_installed_release.map(Arc::from),
            binary_path: Arc::new(binary_path),
            versions_path: Arc::new(versions_path),
            bundled_metadata: Arc::new(bundled_metadata),
            apply_lock: Arc::new(Mutex::new(())),
            latest_cache: Arc::new(RwLock::new(None)),
            panel_cache: Arc::new(RwLock::new(None)),
            github_token_path: Arc::new(github_token_path),
            github_token: Arc::new(RwLock::new(github_token)),
            github_rate_limit: Arc::new(RwLock::new(None)),
        })
    }
}

impl InstalledVersion {
    /// 审计日志里对这个内核的称呼，和界面一致（web/src/utils.ts 的 formatKixdnsVersion）：
    /// fork 发布的日期版本或 Release 标签本身，旧的 Action 内核是构建 #上游 Run 编号；
    /// 早期安装只有构建提交。
    /// How the audit log names this kernel, matching the page (formatKixdnsVersion in
    /// web/src/utils.ts): a fork release's date version or a Release tag itself, 构建 # and
    /// the upstream run for an old Action kernel; early installs only have the build commit.
    pub fn label(&self) -> String {
        match (self.run_id, self.release_tag.as_deref()) {
            (Some(run_id), _) => format!("构建 #{run_id}"),
            (None, Some(tag)) => tag.to_owned(),
            (None, None) => format!("构建 {}", self.commit.get(..12).unwrap_or(&self.commit)),
        }
    }
}

impl VersionManifest {
    fn into_installed(self, active: bool) -> InstalledVersion {
        InstalledVersion {
            source: self.source,
            source_id: self.source_id,
            commit: self.commit,
            run_id: self.run_id,
            release_tag: self.release_tag,
            created_at: self.created_at,
            source_url: self.source_url,
            build_url: self.build_url,
            artifact: self.artifact,
            artifact_digest: self.artifact_digest,
            upstream_repository: self.upstream_repository,
            upstream_commit: self.upstream_commit,
            patchset: self.patchset,
            dependency_revision: self.dependency_revision,
            control_protocol: self.control_protocol,
            config_capabilities: self.config_capabilities,
            binary_sha256: self.binary_sha256,
            installed_at: self.installed_at,
            active,
        }
    }
}

mod storage;

use storage::ensure_directory;

#[cfg(test)]
#[path = "updates/tests.rs"]
pub(crate) mod tests;

#[cfg(test)]
#[path = "updates/download_tests.rs"]
mod download_tests;
