use std::collections::HashMap;
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
use validation::{
    artifact_coordinates, parse_panel_release_version, validate_commit, validate_slug,
    wait_until_healthy,
};

#[cfg(not(unix))]
use validation::ensure_update_platform;

// 这些只有测试通过 `super::` 使用。 / Used only by the tests, through `super::`.
#[cfg(test)]
use catalog::{
    build_lock_revision, panel_release_asset_name, sort_newest_upstream_first,
    to_kixdns_update_notice, to_panel_update_notice,
};
#[cfg(test)]
use github::{
    artifact_page_count, trusted_workflow_runs, validate_github_token, workflow_runs_url,
    write_github_token,
};
#[cfg(test)]
use install::{artifact_sources, extract_artifact};
#[cfg(test)]
use storage::{
    delete_stored_version, load_bundled_manifest, load_verified_version, store_version,
    update_stored_capabilities,
};
#[cfg(test)]
use validation::{
    parse_artifact_reference, sha256, validate_digest, validate_remote_build_identity,
};

const ACTIVE_VERSION_KEY: &str = "installed_panel_version";
const LEGACY_ACTIVE_COMMIT_KEY: &str = "installed_panel_commit";
const UPSTREAM_REPOSITORY: &str = "olicesx/kixdns";
const PANEL_REPOSITORY: &str = "tuoro/kixdns-panel";
const MAX_ARTIFACT_BYTES: usize = 128 * 1024 * 1024;
const MAX_BINARY_BYTES: u64 = 96 * 1024 * 1024;
const ARTIFACT_PAGE_SIZE: usize = 100;
const MAX_ARTIFACT_PAGES: usize = 25;
const REMOTE_VERSION_LIMIT: usize = 12;
const MAX_INSTALLED_VERSIONS: usize = 8;
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
    repository: Arc<str>,
    workflow: Arc<str>,
    release_workflow: Arc<str>,
    branch: Arc<str>,
    artifact: Arc<str>,
    initial_commit: Option<Arc<str>>,
    initial_source_id: Option<u64>,
    panel_commit: Option<Arc<str>>,
    panel_release: Option<Arc<str>>,
    binary_path: Arc<PathBuf>,
    versions_path: Arc<PathBuf>,
    bundled_metadata: Arc<PathBuf>,
    apply_lock: Arc<Mutex<()>>,
    artifact_cache: Arc<RwLock<Option<CachedArtifacts>>>,
    remote_cache: Arc<RwLock<HashMap<VersionSource, CachedRemoteVersions>>>,
    panel_cache: Arc<RwLock<Option<CachedPanelUpdate>>>,
    /// 按 Artifact ID 缓存构建所用的依赖修订；一次构建的锁文件永远不变。
    /// Dependency revision of each build by artifact id; a build's lock never changes.
    dependency_revisions: Arc<RwLock<HashMap<u64, Option<u32>>>>,
    github_token_path: Arc<PathBuf>,
    github_token: Arc<RwLock<Option<SecretString>>>,
    github_rate_limit: Arc<RwLock<Option<GithubRateLimit>>>,
}

pub struct UpdateSettings {
    pub repository: String,
    pub workflow: String,
    pub release_workflow: String,
    pub branch: String,
    pub artifact: String,
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

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub installed_commit: Option<String>,
    pub latest_commit: String,
    pub run_id: u64,
    pub created_at: String,
    pub run_url: String,
    pub artifact: String,
    pub artifact_digest: String,
    pub download_url: String,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct VersionCatalog {
    pub source: VersionSource,
    pub active_source: Option<VersionSource>,
    pub active_commit: Option<String>,
    pub binary_present: bool,
    pub remote_error: Option<String>,
    pub remote_versions: Vec<RemoteVersion>,
    pub installed_versions: Vec<InstalledVersion>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateNotifications {
    pub kixdns: KixdnsUpdateNotice,
    pub panel: PanelUpdateNotice,
}

#[derive(Debug, Clone, Serialize)]
pub struct KixdnsUpdateNotice {
    pub available: bool,
    pub source: VersionSource,
    pub current_commit: Option<String>,
    pub latest_commit: Option<String>,
    pub source_id: Option<u64>,
    pub run_id: Option<u64>,
    pub release_tag: Option<String>,
    pub created_at: Option<String>,
    pub build_url: Option<String>,
    /// 同一版本换上修补过的依赖重新构建：提示依赖安全升级，而不是新版本。
    /// The same version rebuilt with patched dependencies: shown as a dependency
    /// security upgrade rather than a new version.
    pub security_update: bool,
    pub dependency_revision: Option<u32>,
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VersionSource {
    #[default]
    Action,
    Release,
}

impl VersionSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Action => "action",
            Self::Release => "release",
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
        let source = match source {
            "action" => VersionSource::Action,
            "release" => VersionSource::Release,
            _ => return Err(UpdateError::Invalid("活动版本来源无效".to_owned())),
        };
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

#[derive(Debug, Clone, Serialize)]
pub struct RemoteVersion {
    pub source: VersionSource,
    pub source_id: u64,
    pub commit: String,
    pub run_id: Option<u64>,
    pub release_tag: Option<String>,
    pub patchset: Option<u32>,
    pub created_at: String,
    pub source_url: String,
    pub build_url: String,
    pub artifact: String,
    pub artifact_digest: String,
    pub download_url: String,
    pub installed: bool,
    pub active: bool,
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
struct WorkflowRuns {
    workflow_runs: Vec<WorkflowRun>,
}

#[derive(Debug, Clone, Deserialize)]
struct WorkflowRun {
    id: u64,
    head_sha: String,
    created_at: String,
    html_url: String,
    // 这三项决定一次运行能不能进版本目录，所以都是 Option：GitHub 少给一项时
    // 这次运行被丢弃，而不是反序列化失败把整个目录拖垮。
    // These three decide whether a run may enter the catalogue, so all are
    // Option: a run GitHub describes without one is dropped instead of failing
    // deserialisation of the whole list.
    #[serde(default)]
    event: Option<String>,
    #[serde(default)]
    head_branch: Option<String>,
    #[serde(default)]
    head_repository: Option<WorkflowRunRepository>,
}

#[derive(Debug, Clone, Deserialize)]
struct WorkflowRunRepository {
    #[serde(default)]
    full_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ArtifactList {
    total_count: usize,
    artifacts: Vec<Artifact>,
}

#[derive(Debug, Clone, Deserialize)]
struct Artifact {
    id: u64,
    name: String,
    expired: bool,
    digest: Option<String>,
    workflow_run: Option<ArtifactWorkflowRun>,
}

#[derive(Debug, Clone, Deserialize)]
struct ArtifactWorkflowRun {
    id: u64,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    published_at: Option<String>,
    assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct ReleaseAsset {
    name: String,
    digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum TrackReference {
    Action(u64),
    Release(String),
}

#[derive(Debug)]
struct TrackArtifact {
    source_id: u64,
    name: String,
    digest: String,
    reference: TrackReference,
    patchset: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
struct BuildIdentity {
    repository: String,
    source: VersionSource,
    commit: String,
    #[serde(default)]
    official_run_id: Option<u64>,
    #[serde(default)]
    release_id: Option<u64>,
    #[serde(default)]
    release_tag: Option<String>,
    patchset: u32,
    #[serde(default)]
    dependency_revision: Option<u32>,
    control_protocol: u32,
}

struct ExtractedArtifact {
    binary: Vec<u8>,
    identity: BuildIdentity,
    build_commit: String,
    config_capabilities: Vec<String>,
}

/// 内核包的一个下载来源。 / One place a kernel package can be downloaded from.
struct ArtifactSource {
    url: String,
    token: Option<SecretString>,
    label: &'static str,
}

/// GitHub contents 接口返回的仓库文件。
/// A repository file as returned by the GitHub contents API.
#[derive(Debug, Deserialize)]
struct RepositoryFile {
    encoding: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactCapabilities {
    schema_version: u32,
    config_capabilities: Vec<String>,
}

#[derive(Debug, Clone)]
struct ResolvedVersion {
    remote: RemoteVersion,
    build_run_id: u64,
}

struct CachedRemoteVersions {
    loaded_at: Instant,
    versions: Vec<ResolvedVersion>,
}

struct CachedArtifacts {
    loaded_at: Instant,
    artifacts: Vec<Artifact>,
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
    #[error("更新产物校验失败：{0}")]
    Verification(String),
    #[error("安装更新失败：{0}")]
    Install(String),
    #[error("目标版本与当前配置不兼容：{0}")]
    IncompatibleConfig(String),
    #[error("当前平台不支持自动更新")]
    Unsupported,
}

impl UpdateManager {
    pub fn new(database: Database, settings: UpdateSettings) -> Result<Self, UpdateError> {
        let UpdateSettings {
            repository,
            workflow,
            release_workflow,
            branch,
            artifact,
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
        validate_slug(&repository, true)?;
        validate_slug(&workflow, false)?;
        validate_slug(&release_workflow, false)?;
        validate_slug(&branch, false)?;
        validate_slug(&artifact, false)?;
        artifact_coordinates(&artifact)?;
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
            repository: Arc::from(repository),
            workflow: Arc::from(workflow),
            release_workflow: Arc::from(release_workflow),
            branch: Arc::from(branch),
            artifact: Arc::from(artifact),
            initial_commit: installed_commit.map(|commit| Arc::from(commit.to_ascii_lowercase())),
            initial_source_id: installed_source_id,
            panel_commit: panel_installed_commit
                .map(|commit| Arc::from(commit.to_ascii_lowercase())),
            panel_release: panel_installed_release.map(Arc::from),
            binary_path: Arc::new(binary_path),
            versions_path: Arc::new(versions_path),
            bundled_metadata: Arc::new(bundled_metadata),
            apply_lock: Arc::new(Mutex::new(())),
            artifact_cache: Arc::new(RwLock::new(None)),
            remote_cache: Arc::new(RwLock::new(HashMap::new())),
            panel_cache: Arc::new(RwLock::new(None)),
            dependency_revisions: Arc::new(RwLock::new(HashMap::new())),
            github_token_path: Arc::new(github_token_path),
            github_token: Arc::new(RwLock::new(github_token)),
            github_rate_limit: Arc::new(RwLock::new(None)),
        })
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
