use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Cursor, ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Mutex, RwLock};

use crate::auth::unix_timestamp;
use crate::config_capabilities::{
    canonical_runtime_capabilities, ensure_config_supported, validate_declared_capabilities,
};
use crate::control::ControlClient;
use crate::db::Database;
use crate::operations::{Operations, ServiceAction};

mod validation;

use validation::{
    artifact_coordinates, constant_hash_eq, parse_artifact_reference, parse_panel_release_version,
    persist, sha256, sync_directory, validate_build_identity, validate_commit, validate_digest,
    validate_elf, validate_hex_digest, validate_remote_build_identity, validate_slug,
    wait_until_healthy, write_executable, write_private_file,
};

#[cfg(not(unix))]
use validation::ensure_update_platform;

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

fn artifact_page_count(total_count: usize) -> Result<usize, UpdateError> {
    let pages = total_count.div_ceil(ARTIFACT_PAGE_SIZE);
    if pages <= MAX_ARTIFACT_PAGES {
        return Ok(pages);
    }
    Err(UpdateError::Network(format!(
        "Artifact 数量超过分页安全上限（最多 {} 条）",
        ARTIFACT_PAGE_SIZE * MAX_ARTIFACT_PAGES
    )))
}

fn parse_rate_limit(headers: &reqwest::header::HeaderMap) -> Option<GithubRateLimit> {
    let limit = headers
        .get("x-ratelimit-limit")?
        .to_str()
        .ok()?
        .parse()
        .ok()?;
    let remaining = headers
        .get("x-ratelimit-remaining")?
        .to_str()
        .ok()?
        .parse()
        .ok()?;
    let reset_at = headers
        .get("x-ratelimit-reset")?
        .to_str()
        .ok()?
        .parse()
        .ok()?;
    Some(GithubRateLimit {
        limit,
        remaining,
        reset_at,
    })
}

fn validate_github_token(token: &str) -> Result<(), UpdateError> {
    if token.is_empty() || token.len() > MAX_GITHUB_TOKEN_BYTES {
        return Err(UpdateError::Invalid("GitHub Token 长度无效".to_owned()));
    }
    if !token
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(UpdateError::Invalid(
            "GitHub Token 只能包含 ASCII 字母、数字、下划线或短横线".to_owned(),
        ));
    }
    if !(token.starts_with("github_pat_")
        || ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]
            .iter()
            .any(|prefix| token.starts_with(prefix)))
    {
        return Err(UpdateError::Invalid(
            "GitHub Token 格式无效，支持 Fine-grained PAT 和 Classic PAT".to_owned(),
        ));
    }
    Ok(())
}

fn read_github_token(path: &Path) -> Result<Option<SecretString>, UpdateError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(UpdateError::Invalid(error.to_string())),
    };
    if !metadata.file_type().is_file() {
        return Err(UpdateError::Invalid(
            "GitHub Token 路径必须是普通文件".to_owned(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(UpdateError::Invalid(
                "GitHub Token 文件权限过宽，请设置为 0600".to_owned(),
            ));
        }
    }
    if metadata.len() > MAX_GITHUB_TOKEN_BYTES as u64 + 1 {
        return Err(UpdateError::Invalid("GitHub Token 文件过大".to_owned()));
    }
    let token =
        fs::read_to_string(path).map_err(|error| UpdateError::Invalid(error.to_string()))?;
    let token = token.strip_suffix('\n').unwrap_or(&token);
    let token = token.strip_suffix('\r').unwrap_or(token);
    validate_github_token(token)?;
    Ok(Some(SecretString::from(token.to_owned())))
}

fn write_github_token(path: &Path, token: &str) -> Result<(), UpdateError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| UpdateError::Invalid("GitHub Token 路径缺少父目录".to_owned()))?;
    ensure_directory(parent)?;
    if let Ok(metadata) = fs::symlink_metadata(path)
        && !metadata.file_type().is_file()
    {
        return Err(UpdateError::Invalid(
            "GitHub Token 路径必须是普通文件".to_owned(),
        ));
    }
    let temporary = write_private_file(parent, ".github-token-", token.as_bytes())?;
    persist(temporary, path)?;
    sync_directory(parent)
}

fn remove_github_token(path: &Path) -> Result<(), UpdateError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| UpdateError::Invalid("GitHub Token 路径缺少父目录".to_owned()))?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            fs::remove_file(path).map_err(|error| UpdateError::Install(error.to_string()))?;
            sync_directory(parent)
        }
        Ok(_) => Err(UpdateError::Invalid(
            "GitHub Token 路径必须是普通文件".to_owned(),
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(UpdateError::Install(error.to_string())),
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
    management_enabled: bool,
    binary_path: Arc<PathBuf>,
    versions_path: Arc<PathBuf>,
    bundled_metadata: Arc<PathBuf>,
    apply_lock: Arc<Mutex<()>>,
    artifact_cache: Arc<RwLock<Option<CachedArtifacts>>>,
    remote_cache: Arc<RwLock<HashMap<VersionSource, CachedRemoteVersions>>>,
    panel_cache: Arc<RwLock<Option<CachedPanelUpdate>>>,
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
    pub management_enabled: bool,
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
    pub management_enabled: bool,
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
    pub management_enabled: bool,
    pub available: bool,
    pub source: VersionSource,
    pub current_commit: Option<String>,
    pub latest_commit: Option<String>,
    pub source_id: Option<u64>,
    pub run_id: Option<u64>,
    pub release_tag: Option<String>,
    pub created_at: Option<String>,
    pub build_url: Option<String>,
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
    control_protocol: u32,
}

struct ExtractedArtifact {
    binary: Vec<u8>,
    identity: BuildIdentity,
    build_commit: String,
    config_capabilities: Vec<String>,
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
            management_enabled,
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
        let client = reqwest::Client::builder()
            .user_agent(concat!("kixdns-panel/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|error| UpdateError::Invalid(error.to_string()))?;
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
            management_enabled,
            binary_path: Arc::new(binary_path),
            versions_path: Arc::new(versions_path),
            bundled_metadata: Arc::new(bundled_metadata),
            apply_lock: Arc::new(Mutex::new(())),
            artifact_cache: Arc::new(RwLock::new(None)),
            remote_cache: Arc::new(RwLock::new(HashMap::new())),
            panel_cache: Arc::new(RwLock::new(None)),
            github_token_path: Arc::new(github_token_path),
            github_token: Arc::new(RwLock::new(github_token)),
            github_rate_limit: Arc::new(RwLock::new(None)),
        })
    }

    pub async fn github_token_status(&self) -> GithubTokenStatus {
        GithubTokenStatus {
            configured: self.github_token.read().await.is_some(),
            rate_limit: self.github_rate_limit.read().await.clone(),
        }
    }

    pub async fn save_github_token(&self, token: String) -> Result<GithubTokenStatus, UpdateError> {
        validate_github_token(&token)?;
        let (rate_limit, status) = self.verify_github_token(&token).await?;
        write_github_token(&self.github_token_path, &token)?;
        *self.github_token.write().await = Some(SecretString::from(token));
        *self.github_rate_limit.write().await = Some(rate_limit);
        self.clear_remote_caches().await;
        Ok(status)
    }

    pub async fn delete_github_token(&self) -> Result<GithubTokenStatus, UpdateError> {
        remove_github_token(&self.github_token_path)?;
        *self.github_token.write().await = None;
        *self.github_rate_limit.write().await = None;
        self.clear_remote_caches().await;
        Ok(self.github_token_status().await)
    }

    async fn clear_remote_caches(&self) {
        self.artifact_cache.write().await.take();
        self.remote_cache.write().await.clear();
        self.panel_cache.write().await.take();
    }

    async fn verify_github_token(
        &self,
        token: &str,
    ) -> Result<(GithubRateLimit, GithubTokenStatus), UpdateError> {
        let response = self
            .client
            .get("https://api.github.com/rate_limit")
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| {
                UpdateError::Network(format!("GitHub API connection failed: {error}"))
            })?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(UpdateError::Invalid(
                "GitHub Token 无效，请检查后重试".to_owned(),
            ));
        }
        let rate_limit = parse_rate_limit(response.headers());
        if response.status() == reqwest::StatusCode::FORBIDDEN {
            let message = if rate_limit.as_ref().is_some_and(|rate| rate.remaining == 0) {
                "GitHub Token 的 API 配额已用尽，请等待重置或更换 Token"
            } else {
                "GitHub 拒绝验证该 Token，请检查访问策略"
            };
            return Err(UpdateError::Network(message.to_owned()));
        }
        let payload = response
            .error_for_status()
            .map_err(|error| UpdateError::Network(error.to_string()))?
            .json::<GithubRateLimitResponse>()
            .await
            .map_err(|error| {
                UpdateError::Network(format!("GitHub API response invalid: {error}"))
            })?;
        let rate_limit = rate_limit.unwrap_or(GithubRateLimit {
            limit: payload.resources.core.limit,
            remaining: payload.resources.core.remaining,
            reset_at: payload.resources.core.reset,
        });
        Ok((
            rate_limit.clone(),
            GithubTokenStatus {
                configured: true,
                rate_limit: Some(rate_limit),
            },
        ))
    }

    pub async fn notifications(&self) -> Result<UpdateNotifications, UpdateError> {
        if !self.management_enabled {
            return Ok(UpdateNotifications {
                kixdns: KixdnsUpdateNotice::external(),
                panel: self.panel_update_notice().await?,
            });
        }
        let active = self.active_version().await?;
        let source = active
            .as_ref()
            .map_or_else(VersionSource::default, |version| version.source);
        let latest = self
            .resolved_remote_versions(source)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| UpdateError::Network("没有可安装的成功增强构建".to_owned()))?;
        Ok(UpdateNotifications {
            kixdns: to_kixdns_update_notice(&latest.remote, active.as_ref()),
            panel: self.panel_update_notice().await?,
        })
    }

    pub async fn initialize_installed_version(&self) -> Result<(), UpdateError> {
        if !self.management_enabled {
            return Ok(());
        }
        if let Some(active) = self.active_version().await? {
            self.adopt_active_version(&active).await?;
        }
        Ok(())
    }

    /// 返回本地活动版本声明的配置能力，供 `KixDNS` 停止时的编辑器继续识别字段。
    pub async fn active_capabilities(&self) -> Result<Vec<String>, UpdateError> {
        if !self.management_enabled {
            return Ok(Vec::new());
        }
        let Some(key) = self.active_version().await? else {
            return Ok(Vec::new());
        };
        let versions_path = Arc::clone(&self.versions_path);
        let binary_path = Arc::clone(&self.binary_path);
        let bundled_metadata = Arc::clone(&self.bundled_metadata);
        let initial = self.initial_version_key()?;
        tokio::task::spawn_blocking(move || {
            let (manifest, _) = match load_verified_version(&versions_path, &key) {
                Ok(version) => version,
                Err(_) if initial.as_ref() == Some(&key) && key.source_id.is_some() => {
                    // 首次安装时版本目录可能尚未建立，仍以已校验的完整包清单为准。
                    let binary = read_regular_file(&binary_path, "当前 KixDNS 二进制")?;
                    (
                        load_bundled_manifest(&bundled_metadata, &key, &binary)?,
                        binary,
                    )
                }
                Err(error) => return Err(error),
            };
            Ok(canonical_runtime_capabilities(
                &manifest.config_capabilities,
            ))
        })
        .await
        .map_err(|error| UpdateError::Install(error.to_string()))?
    }

    pub async fn catalog(&self, source: VersionSource) -> Result<VersionCatalog, UpdateError> {
        let binary_present = regular_file_exists(self.binary_path.as_ref())?;
        if !self.management_enabled {
            return Ok(VersionCatalog {
                source,
                management_enabled: false,
                active_source: None,
                active_commit: None,
                binary_present,
                remote_error: None,
                remote_versions: Vec::new(),
                installed_versions: Vec::new(),
            });
        }
        let active_version = self.active_version().await?;
        if binary_present && let Some(version) = active_version.as_ref() {
            self.adopt_active_version(version).await?;
        }
        let mut installed_versions = self.installed_versions(active_version.as_ref()).await?;
        let installed = installed_versions
            .iter()
            .filter_map(|version| VersionKey::installed(version).ok())
            .collect::<HashSet<_>>();
        let (mut remote_versions, remote_error) =
            match self.remote_versions(source, REMOTE_VERSION_LIMIT).await {
                Ok(versions) => (versions, None),
                Err(error) => {
                    tracing::warn!(%error, source = source.as_str(), "远端版本目录暂不可用");
                    (Vec::new(), Some(error.to_string()))
                }
            };
        for version in &mut remote_versions {
            let key = VersionKey::remote(version)?;
            version.installed = installed.contains(&key);
            version.active = active_version.as_ref() == Some(&key);
        }
        installed_versions.sort_by_key(|version| Reverse(version.installed_at));
        Ok(VersionCatalog {
            source,
            management_enabled: true,
            active_source: active_version.as_ref().map(|version| version.source),
            active_commit: active_version.map(|version| version.commit),
            binary_present,
            remote_error,
            remote_versions,
            installed_versions,
        })
    }

    pub async fn check(&self) -> Result<UpdateInfo, UpdateError> {
        self.ensure_management_enabled()?;
        let active_version = self.active_version().await?;
        let resolved = self
            .resolved_remote_versions(VersionSource::Action)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| UpdateError::Network("没有可安装的成功增强构建".to_owned()))?;
        Ok(to_update_info(resolved, active_version.as_ref()))
    }

    pub async fn apply(
        &self,
        config: &Value,
        operations: &Operations,
        control: &ControlClient,
    ) -> Result<UpdateInfo, UpdateError> {
        self.ensure_management_enabled()?;
        let _guard = self.apply_lock.lock().await;
        let active_version = self.active_version().await?;
        let candidate = self
            .resolved_remote_versions(VersionSource::Action)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| UpdateError::Network("没有可安装的成功增强构建".to_owned()))?;
        let resolved = self
            .resolve_remote(VersionSource::Action, candidate.remote.source_id)
            .await?;
        let key = VersionKey::remote(&resolved.remote)?;
        if active_version.as_ref() != Some(&key) {
            self.install_resolved(&resolved, config).await?;
            self.activate_locked(&key, config, operations, control)
                .await?;
        }
        Ok(to_update_info(resolved, Some(&key)))
    }

    pub async fn install_version(
        &self,
        source: VersionSource,
        source_id: u64,
        config: &Value,
        operations: &Operations,
        control: &ControlClient,
    ) -> Result<InstalledVersion, UpdateError> {
        self.ensure_management_enabled()?;
        let _guard = self.apply_lock.lock().await;
        let resolved = self.resolve_remote(source, source_id).await?;
        let key = VersionKey::remote(&resolved.remote)?;
        self.install_resolved(&resolved, config).await?;
        self.activate_locked(&key, config, operations, control)
            .await
    }

    pub async fn activate_version(
        &self,
        source: VersionSource,
        version: &str,
        config: &Value,
        operations: &Operations,
        control: &ControlClient,
    ) -> Result<InstalledVersion, UpdateError> {
        self.ensure_management_enabled()?;
        let _guard = self.apply_lock.lock().await;
        let key = match version.parse::<u64>() {
            Ok(source_id) if source_id > 0 => self.installed_key(source, source_id).await?,
            _ => VersionKey::new(source, version)?,
        };
        self.activate_locked(&key, config, operations, control)
            .await
    }

    pub async fn delete_version(
        &self,
        source: VersionSource,
        version: &str,
    ) -> Result<InstalledVersion, UpdateError> {
        self.ensure_management_enabled()?;
        let _guard = self.apply_lock.lock().await;
        let key = match version.parse::<u64>() {
            Ok(source_id) if source_id > 0 => self.installed_key(source, source_id).await?,
            _ => VersionKey::new(source, version)?,
        };
        if self.active_version().await?.as_ref() == Some(&key) {
            return Err(UpdateError::Invalid(
                "当前运行版本不能删除，请先切换版本".to_owned(),
            ));
        }
        let versions_path = Arc::clone(&self.versions_path);
        tokio::task::spawn_blocking(move || delete_stored_version(&versions_path, &key))
            .await
            .map_err(|error| UpdateError::Install(error.to_string()))?
    }

    fn ensure_management_enabled(&self) -> Result<(), UpdateError> {
        if self.management_enabled {
            Ok(())
        } else {
            Err(UpdateError::Invalid(
                "当前为外部 KixDNS 模式，面板不会替换或管理其二进制".to_owned(),
            ))
        }
    }

    async fn active_version(&self) -> Result<Option<VersionKey>, UpdateError> {
        if !regular_file_exists(self.binary_path.as_ref())? {
            return Ok(None);
        }
        let initial = self.initial_version_key()?;
        if let Some(initial) = initial.as_ref()
            && self.bundled_binary_matches(initial).await?
        {
            return Ok(Some(initial.clone()));
        }
        let current = self
            .database
            .get_setting(ACTIVE_VERSION_KEY)
            .await
            .map_err(|error| UpdateError::Install(error.to_string()))?;
        if let Some(current) = current {
            let key = VersionKey::parse(&current)?;
            if self.stored_binary_matches(&key).await? {
                return Ok(Some(key));
            }
        }
        let legacy = self
            .database
            .get_setting(LEGACY_ACTIVE_COMMIT_KEY)
            .await
            .map_err(|error| UpdateError::Install(error.to_string()))?;
        let initial_legacy = if self.initial_source_id.is_none() {
            self.initial_commit.as_deref().map(str::to_owned)
        } else {
            None
        };
        legacy
            .or(initial_legacy)
            .map(|commit| VersionKey::new(VersionSource::Action, commit))
            .transpose()
    }

    fn initial_version_key(&self) -> Result<Option<VersionKey>, UpdateError> {
        self.initial_commit
            .as_deref()
            .map(|commit| match self.initial_source_id {
                Some(source_id) => VersionKey::tracked(VersionSource::Action, source_id, commit),
                None => VersionKey::new(VersionSource::Action, commit),
            })
            .transpose()
    }

    async fn bundled_binary_matches(&self, key: &VersionKey) -> Result<bool, UpdateError> {
        if key.source_id.is_none() {
            return Ok(false);
        }
        let binary_path = Arc::clone(&self.binary_path);
        let metadata_path = Arc::clone(&self.bundled_metadata);
        let key = key.clone();
        tokio::task::spawn_blocking(move || {
            let binary = read_regular_file(&binary_path, "当前 KixDNS 二进制")?;
            match load_bundled_manifest(&metadata_path, &key, &binary) {
                Ok(_) => Ok(true),
                Err(error) => {
                    tracing::warn!(%error, "完整包身份与当前 KixDNS 二进制不匹配");
                    Ok(false)
                }
            }
        })
        .await
        .map_err(|error| UpdateError::Install(error.to_string()))?
    }

    async fn stored_binary_matches(&self, key: &VersionKey) -> Result<bool, UpdateError> {
        let binary_path = Arc::clone(&self.binary_path);
        let versions_path = Arc::clone(&self.versions_path);
        let key = key.clone();
        tokio::task::spawn_blocking(move || {
            let current = read_regular_file(&binary_path, "当前 KixDNS 二进制")?;
            match load_verified_version(&versions_path, &key) {
                Ok((_, stored)) => Ok(constant_hash_eq(&sha256(&current), &sha256(&stored))),
                Err(UpdateError::Invalid(_)) => Ok(false),
                Err(error) => Err(error),
            }
        })
        .await
        .map_err(|error| UpdateError::Install(error.to_string()))?
    }

    async fn workflow_runs(
        &self,
        source: VersionSource,
        limit: usize,
    ) -> Result<Vec<WorkflowRun>, UpdateError> {
        let limit = limit.clamp(1, 30);
        let workflow = match source {
            VersionSource::Action => &self.workflow,
            VersionSource::Release => &self.release_workflow,
        };
        self.workflow_runs_for(workflow, limit).await
    }

    async fn workflow_runs_for(
        &self,
        workflow: &str,
        limit: usize,
    ) -> Result<Vec<WorkflowRun>, UpdateError> {
        let limit = limit.clamp(1, 30);
        let runs_url = format!(
            "https://api.github.com/repos/{}/actions/workflows/{}/runs?branch={}&status=success&per_page={limit}",
            self.repository, workflow, self.branch
        );
        let runs = self.get_json::<WorkflowRuns>(&runs_url).await?;
        Ok(runs
            .workflow_runs
            .into_iter()
            .filter(|run| validate_commit(&run.head_sha).is_ok())
            .take(limit)
            .collect())
    }

    pub async fn panel_update_notice(&self) -> Result<PanelUpdateNotice, UpdateError> {
        if let Some(cached) = self.panel_cache.read().await.as_ref()
            && cached.loaded_at.elapsed() < PANEL_CACHE_TTL
        {
            return Ok(cached.notice.clone());
        }
        let release_url =
            format!("https://api.github.com/repos/{PANEL_REPOSITORY}/releases/latest");
        let release = self
            .get_json_optional::<GithubRelease>(&release_url)
            .await?;
        let notice = to_panel_update_notice(
            self.panel_commit.as_deref(),
            self.panel_release.as_deref(),
            release.as_ref(),
        )?;
        self.panel_cache.write().await.replace(CachedPanelUpdate {
            loaded_at: Instant::now(),
            notice: notice.clone(),
        });
        Ok(notice)
    }

    async fn remote_versions(
        &self,
        source: VersionSource,
        limit: usize,
    ) -> Result<Vec<RemoteVersion>, UpdateError> {
        Ok(self
            .resolved_remote_versions(source)
            .await?
            .into_iter()
            .take(limit)
            .map(|version| version.remote)
            .collect())
    }

    async fn resolved_remote_versions(
        &self,
        source: VersionSource,
    ) -> Result<Vec<ResolvedVersion>, UpdateError> {
        if let Some(cached) = self.remote_cache.read().await.get(&source)
            && cached.loaded_at.elapsed() < REMOTE_CACHE_TTL
        {
            return Ok(cached.versions.clone());
        }

        let versions = self.fetch_track_versions(source).await?;
        self.remote_cache.write().await.insert(
            source,
            CachedRemoteVersions {
                loaded_at: Instant::now(),
                versions: versions.clone(),
            },
        );
        Ok(versions)
    }

    async fn fetch_track_versions(
        &self,
        source: VersionSource,
    ) -> Result<Vec<ResolvedVersion>, UpdateError> {
        let runs = self.workflow_runs(source, 30).await?;
        let artifacts = self.repository_artifacts().await?;
        let mut by_run = HashMap::<u64, Vec<TrackArtifact>>::new();
        for artifact in artifacts {
            if artifact.expired {
                continue;
            }
            let Some(parsed) = parse_artifact_reference(&self.artifact, source, &artifact.name)
            else {
                continue;
            };
            let (Some(workflow_run), Some(digest)) = (artifact.workflow_run, artifact.digest)
            else {
                continue;
            };
            if validate_digest(&digest).is_ok() {
                by_run
                    .entry(workflow_run.id)
                    .or_default()
                    .push(TrackArtifact {
                        source_id: artifact.id,
                        name: artifact.name,
                        digest,
                        reference: parsed.reference,
                        patchset: parsed.patchset,
                    });
            }
        }
        let mut references = HashSet::new();
        let mut versions = Vec::new();
        for run in runs {
            for artifact in by_run.remove(&run.id).unwrap_or_default() {
                if !references.insert(artifact.reference.clone()) {
                    continue;
                }
                versions.push(ResolvedVersion {
                    build_run_id: run.id,
                    remote: self.track_version(source, run.clone(), artifact),
                });
            }
        }
        versions.sort_by(|left, right| {
            right.build_run_id.cmp(&left.build_run_id).then_with(|| {
                right
                    .remote
                    .run_id
                    .cmp(&left.remote.run_id)
                    .then_with(|| right.remote.release_tag.cmp(&left.remote.release_tag))
            })
        });
        versions.truncate(30);
        Ok(versions)
    }

    async fn repository_artifacts(&self) -> Result<Vec<Artifact>, UpdateError> {
        let mut cache = self.artifact_cache.write().await;
        if let Some(cached) = cache.as_ref()
            && cached.loaded_at.elapsed() < REMOTE_CACHE_TTL
        {
            return Ok(cached.artifacts.clone());
        }

        let mut artifacts = Vec::new();
        let mut artifact_ids = HashSet::new();
        let mut total_count = 0;
        for page in 1..=MAX_ARTIFACT_PAGES {
            let artifacts_url = format!(
                "https://api.github.com/repos/{}/actions/artifacts?per_page={ARTIFACT_PAGE_SIZE}&page={page}",
                self.repository
            );
            let response = self.get_json::<ArtifactList>(&artifacts_url).await?;
            total_count = total_count.max(response.total_count);
            artifact_page_count(total_count)?;
            artifacts.extend(
                response
                    .artifacts
                    .into_iter()
                    .filter(|artifact| artifact_ids.insert(artifact.id)),
            );
            if artifacts.len() >= total_count {
                cache.replace(CachedArtifacts {
                    loaded_at: Instant::now(),
                    artifacts: artifacts.clone(),
                });
                return Ok(artifacts);
            }
        }

        Err(UpdateError::Network(
            "GitHub Artifact 分页结果不完整，请稍后重试".to_owned(),
        ))
    }

    async fn resolve_remote(
        &self,
        source: VersionSource,
        source_id: u64,
    ) -> Result<ResolvedVersion, UpdateError> {
        self.fetch_track_versions(source)
            .await?
            .into_iter()
            .find(|version| version.remote.source_id == source_id)
            .ok_or_else(|| UpdateError::Invalid("指定版本不在最近 30 次成功增强构建中".to_owned()))
    }

    fn track_version(
        &self,
        source: VersionSource,
        run: WorkflowRun,
        artifact: TrackArtifact,
    ) -> RemoteVersion {
        let download_url = format!(
            "https://nightly.link/{}/actions/runs/{}/{}.zip",
            self.repository, run.id, artifact.name
        );
        let build_url = run.html_url;
        let (run_id, release_tag, source_url) = match artifact.reference {
            TrackReference::Action(official_run_id) => (
                Some(official_run_id),
                None,
                format!("https://github.com/{UPSTREAM_REPOSITORY}/actions/runs/{official_run_id}"),
            ),
            TrackReference::Release(tag) => (
                None,
                Some(tag.clone()),
                format!("https://github.com/{UPSTREAM_REPOSITORY}/releases/tag/{tag}"),
            ),
        };
        RemoteVersion {
            source,
            source_id: artifact.source_id,
            commit: run.head_sha,
            run_id,
            release_tag,
            patchset: artifact.patchset,
            created_at: run.created_at,
            source_url,
            build_url,
            artifact: artifact.name,
            artifact_digest: artifact.digest,
            download_url,
            installed: false,
            active: false,
        }
    }

    async fn get_json<T>(&self, url: &str) -> Result<T, UpdateError>
    where
        T: serde::de::DeserializeOwned,
    {
        self.github_response(url)
            .await?
            .json()
            .await
            .map_err(|error| UpdateError::Network(error.to_string()))
    }

    async fn get_json_optional<T>(&self, url: &str) -> Result<Option<T>, UpdateError>
    where
        T: serde::de::DeserializeOwned,
    {
        let response = self.github_response_optional(url).await?;
        let Some(response) = response else {
            return Ok(None);
        };
        response
            .json()
            .await
            .map(Some)
            .map_err(|error| UpdateError::Network(error.to_string()))
    }

    async fn github_response(&self, url: &str) -> Result<reqwest::Response, UpdateError> {
        self.github_response_optional(url)
            .await?
            .ok_or_else(|| UpdateError::Network("GitHub API 资源不存在".to_owned()))
    }

    async fn github_response_optional(
        &self,
        url: &str,
    ) -> Result<Option<reqwest::Response>, UpdateError> {
        if !url.starts_with("https://api.github.com/") {
            return Err(UpdateError::Invalid("GitHub API 地址不可信".to_owned()));
        }
        let token = self.github_token.read().await.clone();
        let mut request = self
            .client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json");
        if let Some(token) = token.as_ref() {
            request = request.bearer_auth(token.expose_secret());
        }
        let response = request.send().await.map_err(|error| {
            UpdateError::Network(format!("GitHub API connection failed: {error}"))
        })?;
        if let Some(rate_limit) = parse_rate_limit(response.headers()) {
            *self.github_rate_limit.write().await = Some(rate_limit.clone());
            if response.status() == reqwest::StatusCode::FORBIDDEN && rate_limit.remaining == 0 {
                let message = if token.is_some() {
                    "GitHub Token 的 API 配额已用尽，请等待重置或更换 Token"
                } else {
                    "GitHub 匿名 API 配额已用尽，请在系统页配置 GitHub Token"
                };
                return Err(UpdateError::Network(message.to_owned()));
            }
        }
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(UpdateError::Network(
                "GitHub Token 已失效，请在系统页重新配置".to_owned(),
            ));
        }
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        response
            .error_for_status()
            .map(Some)
            .map_err(|error| UpdateError::Network(format!("GitHub API request failed: {error}")))
    }

    async fn download(&self, version: &ResolvedVersion) -> Result<Vec<u8>, UpdateError> {
        let response = self
            .client
            .get(&version.remote.download_url)
            .send()
            .await
            .map_err(|error| UpdateError::Network(error.to_string()))?
            .error_for_status()
            .map_err(|error| UpdateError::Network(error.to_string()))?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_ARTIFACT_BYTES as u64)
        {
            return Err(UpdateError::Verification(
                "Artifact 超过 128 MiB".to_owned(),
            ));
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| UpdateError::Network(error.to_string()))?;
            if bytes.len().saturating_add(chunk.len()) > MAX_ARTIFACT_BYTES {
                return Err(UpdateError::Verification(
                    "Artifact 超过 128 MiB".to_owned(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let expected = version
            .remote
            .artifact_digest
            .strip_prefix("sha256:")
            .ok_or_else(|| UpdateError::Verification("Artifact digest 格式无效".to_owned()))?;
        let actual = sha256(&bytes);
        if !constant_hash_eq(expected, &actual) {
            return Err(UpdateError::Verification(format!(
                "Artifact digest 不匹配：期望 {expected}，实际 {actual}"
            )));
        }
        Ok(bytes)
    }

    async fn install_resolved(
        &self,
        version: &ResolvedVersion,
        config: &Value,
    ) -> Result<(), UpdateError> {
        let key = VersionKey::remote(&version.remote)?;
        if self.version_exists(&key)? {
            return Ok(());
        }
        let archive = self.download(version).await?;
        let extracted = tokio::task::spawn_blocking(move || extract_artifact(&archive))
            .await
            .map_err(|error| UpdateError::Verification(error.to_string()))??;
        if !extracted
            .build_commit
            .eq_ignore_ascii_case(&version.remote.commit)
        {
            return Err(UpdateError::Verification(
                "包内构建提交与 GitHub 来源提交不匹配".to_owned(),
            ));
        }
        validate_remote_build_identity(&version.remote, &extracted.identity)?;
        ensure_config_supported(config, &extracted.config_capabilities)
            .map_err(|error| UpdateError::IncompatibleConfig(error.to_string()))?;
        validate_elf(&extracted.binary)?;
        let manifest = VersionManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            source: Some(version.remote.source),
            source_id: Some(version.remote.source_id),
            commit: version.remote.commit.clone(),
            run_id: version.remote.run_id,
            release_tag: version.remote.release_tag.clone(),
            created_at: Some(version.remote.created_at.clone()),
            source_url: Some(version.remote.source_url.clone()),
            build_url: Some(version.remote.build_url.clone()),
            artifact: version.remote.artifact.clone(),
            artifact_digest: Some(version.remote.artifact_digest.clone()),
            upstream_repository: Some(extracted.identity.repository),
            upstream_commit: Some(extracted.identity.commit),
            patchset: Some(extracted.identity.patchset),
            control_protocol: Some(extracted.identity.control_protocol),
            config_capabilities: extracted.config_capabilities,
            binary_sha256: sha256(&extracted.binary),
            installed_at: unix_timestamp(),
        };
        let versions_path = Arc::clone(&self.versions_path);
        tokio::task::spawn_blocking(move || {
            store_version(&versions_path, &manifest, &extracted.binary)
        })
        .await
        .map_err(|error| UpdateError::Install(error.to_string()))??;
        Ok(())
    }

    async fn activate_locked(
        &self,
        key: &VersionKey,
        config: &Value,
        operations: &Operations,
        control: &ControlClient,
    ) -> Result<InstalledVersion, UpdateError> {
        if regular_file_exists(self.binary_path.as_ref())?
            && let Some(active) = self.active_version().await?
        {
            self.adopt_active_version(&active).await?;
            if let Err(error) = self.capture_active_capabilities(&active, control).await {
                tracing::warn!(%error, "无法记录当前 KixDNS 的配置能力");
            }
        }
        let versions_path = Arc::clone(&self.versions_path);
        let key_owned = key.clone();
        let (manifest, binary) =
            tokio::task::spawn_blocking(move || load_verified_version(&versions_path, &key_owned))
                .await
                .map_err(|error| UpdateError::Install(error.to_string()))??;
        ensure_config_supported(config, &manifest.config_capabilities)
            .map_err(|error| UpdateError::IncompatibleConfig(error.to_string()))?;
        let previous = self.activate_binary(binary, operations, control).await?;
        if let Err(error) = self
            .database
            .set_setting(ACTIVE_VERSION_KEY, key.encoded(), unix_timestamp())
            .await
        {
            if let Err(rollback) = self
                .restore_previous(previous.as_deref(), operations, control)
                .await
            {
                return Err(UpdateError::Install(format!(
                    "记录活动版本失败：{error}；恢复原版本也失败：{rollback}"
                )));
            }
            return Err(UpdateError::Install(format!(
                "记录活动版本失败，已恢复原版本：{error}"
            )));
        }
        let versions_path = Arc::clone(&self.versions_path);
        let active = key.clone();
        match tokio::task::spawn_blocking(move || prune_versions(&versions_path, &active)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!(%error, "活动版本已切换，但清理旧版本失败"),
            Err(error) => tracing::warn!(%error, "活动版本已切换，但清理任务异常结束"),
        }
        Ok(manifest.into_installed(true))
    }

    async fn adopt_active_version(&self, key: &VersionKey) -> Result<(), UpdateError> {
        let binary_path = Arc::clone(&self.binary_path);
        let versions_path = Arc::clone(&self.versions_path);
        let bundled_metadata = Arc::clone(&self.bundled_metadata);
        let initial = self.initial_version_key()?;
        let key = key.clone();
        let worker_key = key.clone();
        let artifact = self.artifact.to_string();
        tokio::task::spawn_blocking(move || {
            let binary = read_regular_file(&binary_path, "当前 KixDNS 二进制")?;
            validate_elf(&binary)?;
            if let Ok((_, stored)) = load_verified_version(&versions_path, &worker_key) {
                if !constant_hash_eq(&sha256(&binary), &sha256(&stored)) {
                    return Err(UpdateError::Verification(
                        "活动版本记录与当前 KixDNS 二进制不一致".to_owned(),
                    ));
                }
                return Ok(());
            }
            let manifest =
                if initial.as_ref() == Some(&worker_key) && worker_key.source_id.is_some() {
                    load_bundled_manifest(&bundled_metadata, &worker_key, &binary)?
                } else {
                    if worker_key.source_id.is_some() {
                        return Err(UpdateError::Verification(
                            "活动版本缺少可信构建元数据".to_owned(),
                        ));
                    }
                    VersionManifest {
                        schema_version: MANIFEST_SCHEMA_VERSION,
                        source: Some(worker_key.source),
                        source_id: None,
                        commit: worker_key.commit.clone(),
                        run_id: None,
                        release_tag: None,
                        created_at: None,
                        source_url: None,
                        build_url: None,
                        artifact,
                        artifact_digest: None,
                        upstream_repository: None,
                        upstream_commit: None,
                        patchset: None,
                        control_protocol: None,
                        config_capabilities: Vec::new(),
                        binary_sha256: sha256(&binary),
                        installed_at: unix_timestamp(),
                    }
                };
            store_version(&versions_path, &manifest, &binary)
        })
        .await
        .map_err(|error| UpdateError::Install(error.to_string()))??;
        self.database
            .set_setting(ACTIVE_VERSION_KEY, key.encoded(), unix_timestamp())
            .await
            .map_err(|error| UpdateError::Install(error.to_string()))
    }

    async fn capture_active_capabilities(
        &self,
        key: &VersionKey,
        control: &ControlClient,
    ) -> Result<(), UpdateError> {
        let capabilities = canonical_runtime_capabilities(
            &control
                .health()
                .await
                .map_err(|error| UpdateError::Install(error.to_string()))?
                .capabilities,
        );
        let versions_path = Arc::clone(&self.versions_path);
        let key = key.clone();
        tokio::task::spawn_blocking(move || {
            update_stored_capabilities(&versions_path, &key, capabilities)
        })
        .await
        .map_err(|error| UpdateError::Install(error.to_string()))?
    }

    fn version_exists(&self, key: &VersionKey) -> Result<bool, UpdateError> {
        let path = locate_version_directory(self.versions_path.as_ref(), key)?;
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                load_verified_version(self.versions_path.as_ref(), key)?;
                Ok(true)
            }
            Ok(_) => Err(UpdateError::Install("版本目录类型无效".to_owned())),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(UpdateError::Install(error.to_string())),
        }
    }

    async fn installed_versions(
        &self,
        active_version: Option<&VersionKey>,
    ) -> Result<Vec<InstalledVersion>, UpdateError> {
        let versions_path = Arc::clone(&self.versions_path);
        let active_version = active_version.cloned();
        tokio::task::spawn_blocking(move || list_installed(&versions_path, active_version.as_ref()))
            .await
            .map_err(|error| UpdateError::Install(error.to_string()))?
    }

    async fn installed_key(
        &self,
        source: VersionSource,
        source_id: u64,
    ) -> Result<VersionKey, UpdateError> {
        let versions_path = Arc::clone(&self.versions_path);
        tokio::task::spawn_blocking(move || {
            find_installed_key(&versions_path, source, source_id)?
                .ok_or_else(|| UpdateError::Invalid("指定版本尚未安装或来源身份已失效".to_owned()))
        })
        .await
        .map_err(|error| UpdateError::Install(error.to_string()))?
    }

    async fn activate_binary(
        &self,
        binary: Vec<u8>,
        operations: &Operations,
        control: &ControlClient,
    ) -> Result<Option<Vec<u8>>, UpdateError> {
        #[cfg(not(unix))]
        ensure_update_platform()?;
        validate_elf(&binary)?;
        let target = self.binary_path.as_ref();
        let current = match fs::symlink_metadata(target) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(UpdateError::Install(
                        "目标二进制必须是普通文件，不能是符号链接".to_owned(),
                    ));
                }
                Some(fs::read(target).map_err(|error| {
                    UpdateError::Install(format!("读取当前二进制失败：{error}"))
                })?)
            }
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => {
                return Err(UpdateError::Install(format!("读取当前二进制失败：{error}")));
            }
        };
        let parent = target
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .ok_or_else(|| UpdateError::Install("目标二进制缺少父目录".to_owned()))?;
        let candidate = write_executable(parent, ".kixdns-candidate-", &binary)?;
        if let Some(bytes) = current.as_deref() {
            let backup_path = target.with_file_name("kixdns.previous");
            let backup = write_executable(parent, ".kixdns-backup-", bytes)?;
            persist(backup, &backup_path)?;
        }

        operations
            .service_action(ServiceAction::Stop)
            .await
            .map_err(|error| UpdateError::Install(error.to_string()))?;
        if let Err(error) = persist(candidate, target) {
            let _ = operations.service_action(ServiceAction::Start).await;
            return Err(error);
        }
        if let Err(error) = operations.service_action(ServiceAction::Start).await {
            self.restore_previous(current.as_deref(), operations, control)
                .await
                .map_err(|rollback| {
                    UpdateError::Install(format!("新版本启动失败：{error}；{rollback}"))
                })?;
            return Err(UpdateError::Install(format!(
                "新版本启动失败，已恢复原状态：{error}"
            )));
        }
        if let Err(error) = wait_until_healthy(control).await {
            self.restore_previous(current.as_deref(), operations, control)
                .await
                .map_err(|rollback| UpdateError::Install(format!("{error}；{rollback}")))?;
            return Err(UpdateError::Install(format!("{error}；已恢复原状态")));
        }
        sync_directory(parent)?;
        Ok(current)
    }

    async fn restore_previous(
        &self,
        previous: Option<&[u8]>,
        operations: &Operations,
        control: &ControlClient,
    ) -> Result<(), UpdateError> {
        let _ = operations.service_action(ServiceAction::Stop).await;
        let target = self.binary_path.as_ref();
        let parent = target
            .parent()
            .ok_or_else(|| UpdateError::Install("目标二进制缺少父目录".to_owned()))?;
        let Some(previous) = previous else {
            match fs::remove_file(target) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(UpdateError::Install(error.to_string())),
            }
            sync_directory(parent)?;
            return Ok(());
        };
        let temporary = write_executable(parent, ".kixdns-rollback-", previous)?;
        persist(temporary, target)?;
        operations
            .service_action(ServiceAction::Start)
            .await
            .map_err(|error| UpdateError::Install(format!("恢复旧版本后启动失败：{error}")))?;
        wait_until_healthy(control)
            .await
            .map_err(|error| UpdateError::Install(format!("恢复旧版本后健康检查失败：{error}")))?;
        Ok(())
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
            control_protocol: self.control_protocol,
            config_capabilities: self.config_capabilities,
            binary_sha256: self.binary_sha256,
            installed_at: self.installed_at,
            active,
        }
    }
}

fn to_update_info(version: ResolvedVersion, active: Option<&VersionKey>) -> UpdateInfo {
    let available =
        VersionKey::remote(&version.remote).map_or(true, |latest| active != Some(&latest));
    UpdateInfo {
        installed_commit: active.map(|active| active.commit.clone()),
        latest_commit: version.remote.commit,
        run_id: version.remote.source_id,
        created_at: version.remote.created_at,
        run_url: version.remote.source_url,
        artifact: version.remote.artifact,
        artifact_digest: version.remote.artifact_digest,
        download_url: version.remote.download_url,
        available,
    }
}

fn to_kixdns_update_notice(
    version: &RemoteVersion,
    active: Option<&VersionKey>,
) -> KixdnsUpdateNotice {
    let available = active.is_some_and(|active| {
        active.source != version.source
            || !active.commit.eq_ignore_ascii_case(&version.commit)
            || active.source_id != Some(version.source_id)
    });
    KixdnsUpdateNotice {
        management_enabled: true,
        available,
        source: version.source,
        current_commit: active.map(|active| active.commit.clone()),
        latest_commit: Some(version.commit.clone()),
        source_id: Some(version.source_id),
        run_id: version.run_id,
        release_tag: version.release_tag.clone(),
        created_at: Some(version.created_at.clone()),
        build_url: Some(version.build_url.clone()),
    }
}

impl KixdnsUpdateNotice {
    fn external() -> Self {
        Self {
            management_enabled: false,
            available: false,
            source: VersionSource::default(),
            current_commit: None,
            latest_commit: None,
            source_id: None,
            run_id: None,
            release_tag: None,
            created_at: None,
            build_url: None,
        }
    }
}

fn to_panel_update_notice(
    current_commit: Option<&str>,
    current_release: Option<&str>,
    release: Option<&GithubRelease>,
) -> Result<PanelUpdateNotice, UpdateError> {
    let current_version = semver::Version::parse(env!("CARGO_PKG_VERSION"))
        .map_err(|error| UpdateError::Invalid(format!("面板版本无效：{error}")))?;
    let Some(release) = release else {
        return Ok(PanelUpdateNotice {
            available: false,
            current_version: current_version.to_string(),
            current_commit: current_commit.map(str::to_owned),
            current_release: current_release.map(str::to_owned),
            latest_version: None,
            published_at: None,
            release_url: None,
            artifact: None,
            artifact_digest: None,
            download_url: None,
        });
    };
    let latest_version = parse_panel_release_version(&release.tag_name)?;
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == panel_release_asset_name());
    if let Some(digest) = asset.and_then(|asset| asset.digest.as_deref()) {
        validate_digest(digest)?;
    }
    let installed_version = current_release
        .map(parse_panel_release_version)
        .transpose()
        .map_err(|error| UpdateError::Invalid(format!("已安装面板 Release 无效：{error}")))?;
    let available = asset.is_some()
        && installed_version.as_ref().map_or_else(
            || latest_version >= current_version,
            |installed| latest_version > *installed,
        );
    let release_url = format!(
        "https://github.com/{PANEL_REPOSITORY}/releases/tag/{}",
        release.tag_name
    );
    let download_url = asset.map(|asset| {
        format!(
            "https://github.com/{PANEL_REPOSITORY}/releases/download/{}/{}",
            release.tag_name, asset.name
        )
    });
    Ok(PanelUpdateNotice {
        available,
        current_version: current_version.to_string(),
        current_commit: current_commit.map(str::to_owned),
        current_release: current_release.map(str::to_owned),
        latest_version: Some(latest_version.to_string()),
        published_at: release.published_at.clone(),
        release_url: Some(release_url),
        artifact: asset.map(|asset| asset.name.clone()),
        artifact_digest: asset.and_then(|asset| asset.digest.clone()),
        download_url,
    })
}

fn panel_release_asset_name() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "kixdns-panel-linux-arm64.zip",
        _ => "kixdns-panel-linux-x86_64.zip",
    }
}

fn extract_artifact(archive: &[u8]) -> Result<ExtractedArtifact, UpdateError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(archive))
        .map_err(|error| UpdateError::Verification(format!("Artifact 不是有效 ZIP：{error}")))?;
    let checksums = read_zip_entry(&mut archive, "SHA256SUMS", 64 * 1024)?;
    let checksums = String::from_utf8(checksums)
        .map_err(|_| UpdateError::Verification("SHA256SUMS 不是 UTF-8".to_owned()))?;
    let checksums = parse_checksums(&checksums)?;
    let binary = read_verified_zip_entry(&mut archive, &checksums, "kixdns", MAX_BINARY_BYTES)?;
    let identity = read_verified_zip_entry(
        &mut archive,
        &checksums,
        "upstream.lock.json",
        MAX_BUILD_IDENTITY_BYTES,
    )?;
    let identity: BuildIdentity = serde_json::from_slice(&identity)
        .map_err(|error| UpdateError::Verification(format!("构建身份无效：{error}")))?;
    validate_build_identity(&identity)?;
    let build_commit =
        read_verified_zip_entry(&mut archive, &checksums, "KIXDNS_BUILD_COMMIT", 128)?;
    let build_commit = String::from_utf8(build_commit)
        .map_err(|_| UpdateError::Verification("KIXDNS_BUILD_COMMIT 不是 UTF-8".to_owned()))?;
    let build_commit = build_commit.trim().to_owned();
    validate_commit(&build_commit)
        .map_err(|_| UpdateError::Verification("包内构建提交无效".to_owned()))?;
    let config_capabilities = match read_optional_verified_zip_entry(
        &mut archive,
        &checksums,
        "KIXDNS_CAPABILITIES.json",
        MAX_CAPABILITIES_BYTES,
    )? {
        Some(content) => {
            let manifest: ArtifactCapabilities = serde_json::from_slice(&content)
                .map_err(|error| UpdateError::Verification(format!("配置能力清单无效：{error}")))?;
            if manifest.schema_version != 1 {
                return Err(UpdateError::Verification(
                    "配置能力清单版本不受支持".to_owned(),
                ));
            }
            validate_declared_capabilities(&manifest.config_capabilities)
                .map_err(UpdateError::Verification)?;
            manifest.config_capabilities
        }
        None => Vec::new(),
    };
    Ok(ExtractedArtifact {
        binary,
        identity,
        build_commit,
        config_capabilities,
    })
}

fn parse_checksums(checksums: &str) -> Result<HashMap<String, String>, UpdateError> {
    let mut parsed = HashMap::new();
    for line in checksums.lines().filter(|line| !line.trim().is_empty()) {
        let mut fields = line.split_whitespace();
        let digest = fields
            .next()
            .ok_or_else(|| UpdateError::Verification("SHA256SUMS 格式无效".to_owned()))?;
        let name = fields
            .next()
            .map(|value| value.trim_start_matches('*'))
            .ok_or_else(|| UpdateError::Verification("SHA256SUMS 格式无效".to_owned()))?;
        if fields.next().is_some() {
            return Err(UpdateError::Verification(
                "SHA256SUMS 包含不受支持的文件名".to_owned(),
            ));
        }
        validate_hex_digest(digest)?;
        if parsed.insert(name.to_owned(), digest.to_owned()).is_some() {
            return Err(UpdateError::Verification(format!(
                "SHA256SUMS 重复声明 {name}"
            )));
        }
    }
    Ok(parsed)
}

fn read_verified_zip_entry(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    checksums: &HashMap<String, String>,
    name: &str,
    limit: u64,
) -> Result<Vec<u8>, UpdateError> {
    let expected = checksums
        .get(name)
        .ok_or_else(|| UpdateError::Verification(format!("SHA256SUMS 缺少 {name}")))?;
    let bytes = read_zip_entry(archive, name, limit)?;
    let actual = sha256(&bytes);
    if !constant_hash_eq(expected, &actual) {
        return Err(UpdateError::Verification(format!(
            "{name} 摘要不匹配：期望 {expected}，实际 {actual}"
        )));
    }
    Ok(bytes)
}

fn read_optional_verified_zip_entry(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    checksums: &HashMap<String, String>,
    name: &str,
    limit: u64,
) -> Result<Option<Vec<u8>>, UpdateError> {
    let count = archive.file_names().filter(|entry| *entry == name).count();
    match count {
        0 if checksums.contains_key(name) => Err(UpdateError::Verification(format!(
            "SHA256SUMS 声明了缺失的 {name}"
        ))),
        0 => Ok(None),
        1 => read_verified_zip_entry(archive, checksums, name, limit).map(Some),
        _ => Err(UpdateError::Verification(format!(
            "Artifact 中的 {name} 重复"
        ))),
    }
}

fn read_zip_entry(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    name: &str,
    limit: u64,
) -> Result<Vec<u8>, UpdateError> {
    if archive.file_names().filter(|entry| *entry == name).count() != 1 {
        return Err(UpdateError::Verification(format!(
            "Artifact 中的 {name} 缺失或重复"
        )));
    }
    let file = archive
        .by_name(name)
        .map_err(|_| UpdateError::Verification(format!("Artifact 缺少 {name}")))?;
    if file.is_dir() || file.size() > limit {
        return Err(UpdateError::Verification(format!("{name} 大小无效")));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(file.size()).unwrap_or(0));
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| UpdateError::Verification(format!("读取 {name} 失败：{error}")))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > limit {
        return Err(UpdateError::Verification(format!("{name} 超过大小限制")));
    }
    Ok(bytes)
}

mod storage;

use storage::{
    delete_stored_version, ensure_directory, find_installed_key, list_installed,
    load_bundled_manifest, load_verified_version, locate_version_directory, prune_versions,
    read_regular_file, regular_file_exists, store_version, update_stored_capabilities,
};

#[cfg(test)]
#[path = "updates/tests.rs"]
mod tests;
