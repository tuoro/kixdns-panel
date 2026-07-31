use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Cursor, ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tempfile::Builder;
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
    artifact_coordinates, constant_hash_eq, ensure_update_platform, parse_artifact_reference,
    parse_panel_release_version, persist, sha256, sync_directory, validate_build_identity,
    validate_commit, validate_digest, validate_elf, validate_hex_digest,
    validate_manifest_build_identity, validate_manifest_source, validate_remote_build_identity,
    validate_slug, wait_until_healthy, write_executable, write_private_file,
};

const ACTIVE_VERSION_KEY: &str = "installed_panel_version";
const LEGACY_ACTIVE_COMMIT_KEY: &str = "installed_panel_commit";
const UPSTREAM_REPOSITORY: &str = "olicesx/kixdns";
const PANEL_REPOSITORY: &str = "tuoro/kixdns-panel";
const MAX_ARTIFACT_BYTES: usize = 128 * 1024 * 1024;
const MAX_BINARY_BYTES: u64 = 96 * 1024 * 1024;
const REMOTE_VERSION_LIMIT: usize = 12;
const MAX_INSTALLED_VERSIONS: usize = 8;
const MANIFEST_SCHEMA_VERSION: u32 = 5;
const SOURCE_MANIFEST_SCHEMA_VERSION: u32 = 4;
const CONTROL_PROTOCOL_VERSION: u32 = 1;
const MAX_BUILD_IDENTITY_BYTES: u64 = 64 * 1024;
const MAX_CAPABILITIES_BYTES: u64 = 64 * 1024;
const REMOTE_CACHE_TTL: Duration = Duration::from_mins(1);
const PANEL_CACHE_TTL: Duration = Duration::from_mins(15);

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
    panel_commit: Option<Arc<str>>,
    panel_release: Option<Arc<str>>,
    management_enabled: bool,
    binary_path: Arc<PathBuf>,
    versions_path: Arc<PathBuf>,
    apply_lock: Arc<Mutex<()>>,
    remote_cache: Arc<RwLock<HashMap<VersionSource, CachedRemoteVersions>>>,
    panel_cache: Arc<RwLock<Option<CachedPanelUpdate>>>,
}

pub struct UpdateSettings {
    pub repository: String,
    pub workflow: String,
    pub release_workflow: String,
    pub branch: String,
    pub artifact: String,
    pub installed_commit: Option<String>,
    pub panel_installed_commit: Option<String>,
    pub panel_installed_release: Option<String>,
    pub management_enabled: bool,
    pub binary_path: PathBuf,
    pub versions_path: PathBuf,
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
    artifacts: Vec<Artifact>,
}

#[derive(Debug, Deserialize)]
struct Artifact {
    id: u64,
    name: String,
    expired: bool,
    digest: Option<String>,
    workflow_run: Option<ArtifactWorkflowRun>,
}

#[derive(Debug, Deserialize)]
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
            panel_installed_commit,
            panel_installed_release,
            management_enabled,
            binary_path,
            versions_path,
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
        Ok(Self {
            client,
            database,
            repository: Arc::from(repository),
            workflow: Arc::from(workflow),
            release_workflow: Arc::from(release_workflow),
            branch: Arc::from(branch),
            artifact: Arc::from(artifact),
            initial_commit: installed_commit.map(Arc::from),
            panel_commit: panel_installed_commit
                .map(|commit| Arc::from(commit.to_ascii_lowercase())),
            panel_release: panel_installed_release.map(Arc::from),
            management_enabled,
            binary_path: Arc::new(binary_path),
            versions_path: Arc::new(versions_path),
            apply_lock: Arc::new(Mutex::new(())),
            remote_cache: Arc::new(RwLock::new(HashMap::new())),
            panel_cache: Arc::new(RwLock::new(None)),
        })
    }

    pub async fn notifications(&self) -> Result<UpdateNotifications, UpdateError> {
        if !self.management_enabled {
            return Ok(UpdateNotifications {
                kixdns: KixdnsUpdateNotice::external(),
                panel: self.panel_update().await?,
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
            panel: self.panel_update().await?,
        })
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
        let mut remote_versions = self.remote_versions(source, REMOTE_VERSION_LIMIT).await?;
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
        let current = self
            .database
            .get_setting(ACTIVE_VERSION_KEY)
            .await
            .map_err(|error| UpdateError::Install(error.to_string()))?;
        if let Some(current) = current {
            return VersionKey::parse(&current).map(Some);
        }
        let legacy = self
            .database
            .get_setting(LEGACY_ACTIVE_COMMIT_KEY)
            .await
            .map_err(|error| UpdateError::Install(error.to_string()))?;
        legacy
            .or_else(|| self.initial_commit.as_deref().map(str::to_owned))
            .map(|commit| VersionKey::new(VersionSource::Action, commit))
            .transpose()
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

    async fn panel_update(&self) -> Result<PanelUpdateNotice, UpdateError> {
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
        let artifacts_url = format!(
            "https://api.github.com/repos/{}/actions/artifacts?per_page=100",
            self.repository
        );
        let artifacts = self.get_json::<ArtifactList>(&artifacts_url).await?;
        let mut by_run = HashMap::<u64, Vec<TrackArtifact>>::new();
        for artifact in artifacts.artifacts {
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
        self.client
            .get(url)
            .send()
            .await
            .map_err(|error| UpdateError::Network(error.to_string()))?
            .error_for_status()
            .map_err(|error| UpdateError::Network(error.to_string()))?
            .json()
            .await
            .map_err(|error| UpdateError::Network(error.to_string()))
    }

    async fn get_json_optional<T>(&self, url: &str) -> Result<Option<T>, UpdateError>
    where
        T: serde::de::DeserializeOwned,
    {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|error| UpdateError::Network(error.to_string()))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        response
            .error_for_status()
            .map_err(|error| UpdateError::Network(error.to_string()))?
            .json()
            .await
            .map(Some)
            .map_err(|error| UpdateError::Network(error.to_string()))
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
        if self.version_exists(key)? {
            return Ok(());
        }
        let binary_path = Arc::clone(&self.binary_path);
        let versions_path = Arc::clone(&self.versions_path);
        let key = key.clone();
        let artifact = self.artifact.to_string();
        tokio::task::spawn_blocking(move || {
            let binary = read_regular_file(&binary_path, "当前 KixDNS 二进制")?;
            validate_elf(&binary)?;
            let manifest = VersionManifest {
                schema_version: MANIFEST_SCHEMA_VERSION,
                source: Some(key.source),
                source_id: None,
                commit: key.commit,
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
            };
            store_version(&versions_path, &manifest, &binary)
        })
        .await
        .map_err(|error| UpdateError::Install(error.to_string()))?
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

fn store_version(
    versions_path: &Path,
    manifest: &VersionManifest,
    binary: &[u8],
) -> Result<(), UpdateError> {
    if !(1..=MANIFEST_SCHEMA_VERSION).contains(&manifest.schema_version) {
        return Err(UpdateError::Verification("版本清单格式不受支持".to_owned()));
    }
    validate_commit(&manifest.commit)?;
    if let Some(digest) = manifest.artifact_digest.as_deref() {
        validate_digest(digest)?;
    }
    validate_manifest_source(manifest)?;
    validate_manifest_build_identity(manifest)?;
    validate_declared_capabilities(&manifest.config_capabilities)
        .map_err(UpdateError::Verification)?;
    validate_elf(binary)?;
    if !constant_hash_eq(&manifest.binary_sha256, &sha256(binary)) {
        return Err(UpdateError::Verification(
            "版本清单二进制摘要不匹配".to_owned(),
        ));
    }
    ensure_directory(versions_path)?;
    let source = manifest.source.unwrap_or_default();
    let key = match manifest.source_id {
        Some(source_id) => VersionKey::tracked(source, source_id, manifest.commit.clone())?,
        None => VersionKey::new(source, manifest.commit.clone())?,
    };
    if manifest.schema_version >= SOURCE_MANIFEST_SCHEMA_VERSION && manifest.source.is_none() {
        return Err(UpdateError::Verification("当前版本清单缺少来源".to_owned()));
    }
    let target = version_path(versions_path, &key);
    if target.exists() {
        load_verified_version(versions_path, &key)?;
        return Ok(());
    }
    let stage = Builder::new()
        .prefix(".version-")
        .tempdir_in(versions_path)
        .map_err(|error| UpdateError::Install(error.to_string()))?;
    let binary_file = write_executable(stage.path(), ".kixdns-", binary)?;
    persist(binary_file, &stage.path().join("kixdns"))?;
    let mut manifest_bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| UpdateError::Install(error.to_string()))?;
    manifest_bytes.push(b'\n');
    let manifest_file = write_private_file(stage.path(), ".manifest-", &manifest_bytes)?;
    persist(manifest_file, &stage.path().join("manifest.json"))?;
    sync_directory(stage.path())?;
    fs::rename(stage.path(), &target).map_err(|error| UpdateError::Install(error.to_string()))?;
    sync_directory(versions_path)?;
    Ok(())
}

fn load_verified_version(
    versions_path: &Path,
    key: &VersionKey,
) -> Result<(VersionManifest, Vec<u8>), UpdateError> {
    let directory = locate_version_directory(versions_path, key)?;
    let metadata = fs::symlink_metadata(&directory)
        .map_err(|_| UpdateError::Invalid("指定版本尚未安装".to_owned()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(UpdateError::Verification("版本目录类型无效".to_owned()));
    }
    let manifest_bytes = read_regular_file(&directory.join("manifest.json"), "版本清单")?;
    let mut manifest: VersionManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| UpdateError::Verification(format!("版本清单无效：{error}")))?;
    if !(1..=MANIFEST_SCHEMA_VERSION).contains(&manifest.schema_version)
        || !manifest.commit.eq_ignore_ascii_case(&key.commit)
    {
        return Err(UpdateError::Verification("版本清单身份不匹配".to_owned()));
    }
    if manifest.schema_version < SOURCE_MANIFEST_SCHEMA_VERSION {
        manifest.source = Some(key.source);
        manifest.source_id = None;
        manifest.run_id = None;
        manifest.release_tag = None;
        manifest.source_url = None;
        manifest.build_url = None;
    } else if manifest.source != Some(key.source)
        || key
            .source_id
            .is_some_and(|source_id| manifest.source_id != Some(source_id))
    {
        return Err(UpdateError::Verification("版本清单来源不匹配".to_owned()));
    }
    if let Some(digest) = manifest.artifact_digest.as_deref() {
        validate_digest(digest)?;
    }
    validate_manifest_source(&manifest)?;
    validate_manifest_build_identity(&manifest)?;
    validate_declared_capabilities(&manifest.config_capabilities)
        .map_err(UpdateError::Verification)?;
    validate_hex_digest(&manifest.binary_sha256)?;
    let binary = read_regular_file(&directory.join("kixdns"), "版本二进制")?;
    if u64::try_from(binary.len()).unwrap_or(u64::MAX) > MAX_BINARY_BYTES {
        return Err(UpdateError::Verification(
            "版本二进制超过大小限制".to_owned(),
        ));
    }
    validate_elf(&binary)?;
    let actual = sha256(&binary);
    if !constant_hash_eq(&manifest.binary_sha256, &actual) {
        return Err(UpdateError::Verification(
            "本地版本二进制摘要不匹配".to_owned(),
        ));
    }
    Ok((manifest, binary))
}

fn update_stored_capabilities(
    versions_path: &Path,
    key: &VersionKey,
    capabilities: Vec<String>,
) -> Result<(), UpdateError> {
    validate_declared_capabilities(&capabilities).map_err(UpdateError::Verification)?;
    let (mut manifest, _) = load_verified_version(versions_path, key)?;
    if manifest.config_capabilities == capabilities
        && manifest.schema_version == MANIFEST_SCHEMA_VERSION
    {
        return Ok(());
    }
    manifest.schema_version = MANIFEST_SCHEMA_VERSION;
    manifest.config_capabilities = capabilities;
    let directory = locate_version_directory(versions_path, key)?;
    let mut bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| UpdateError::Install(error.to_string()))?;
    bytes.push(b'\n');
    let temporary = write_private_file(&directory, ".manifest-", &bytes)?;
    persist(temporary, &directory.join("manifest.json"))?;
    sync_directory(&directory)
}

fn list_installed(
    versions_path: &Path,
    active_version: Option<&VersionKey>,
) -> Result<Vec<InstalledVersion>, UpdateError> {
    let mut versions = Vec::new();
    let mut found = HashSet::new();
    for entry in
        fs::read_dir(versions_path).map_err(|error| UpdateError::Install(error.to_string()))?
    {
        let entry = entry.map_err(|error| UpdateError::Install(error.to_string()))?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(key) = parse_version_directory(&name) else {
            continue;
        };
        if !found.insert(key.clone()) {
            continue;
        }
        match load_verified_version(versions_path, &key) {
            Ok((manifest, _)) => {
                versions.push(manifest.into_installed(active_version == Some(&key)));
            }
            Err(error) => tracing::warn!(version = name, %error, "忽略损坏的本地 KixDNS 版本"),
        }
    }
    Ok(versions)
}

fn find_installed_key(
    versions_path: &Path,
    source: VersionSource,
    source_id: u64,
) -> Result<Option<VersionKey>, UpdateError> {
    for entry in
        fs::read_dir(versions_path).map_err(|error| UpdateError::Install(error.to_string()))?
    {
        let entry = entry.map_err(|error| UpdateError::Install(error.to_string()))?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(key) = parse_version_directory(&name) else {
            continue;
        };
        let Ok((manifest, _)) = load_verified_version(versions_path, &key) else {
            continue;
        };
        if manifest.source == Some(source) && manifest.source_id == Some(source_id) {
            return Ok(Some(key));
        }
    }
    Ok(None)
}

fn prune_versions(versions_path: &Path, active_version: &VersionKey) -> Result<(), UpdateError> {
    let mut versions = list_installed(versions_path, Some(active_version))?;
    versions.sort_by_key(|version| Reverse(version.installed_at));
    let keep = versions
        .iter()
        .take(MAX_INSTALLED_VERSIONS)
        .filter_map(|version| VersionKey::installed(version).ok())
        .chain(std::iter::once(active_version.clone()))
        .collect::<HashSet<_>>();
    for version in versions {
        let key = VersionKey::installed(&version)?;
        if keep.contains(&key) {
            continue;
        }
        let path = locate_version_directory(versions_path, &key)?;
        let metadata =
            fs::symlink_metadata(&path).map_err(|error| UpdateError::Install(error.to_string()))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(UpdateError::Install("待清理版本目录类型无效".to_owned()));
        }
        fs::remove_dir_all(path).map_err(|error| UpdateError::Install(error.to_string()))?;
    }
    sync_directory(versions_path)
}

fn delete_stored_version(
    versions_path: &Path,
    key: &VersionKey,
) -> Result<InstalledVersion, UpdateError> {
    let (manifest, _) = load_verified_version(versions_path, key)?;
    let path = locate_version_directory(versions_path, key)?;
    let metadata =
        fs::symlink_metadata(&path).map_err(|error| UpdateError::Install(error.to_string()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(UpdateError::Verification(
            "待删除版本目录类型无效".to_owned(),
        ));
    }
    fs::remove_dir_all(path).map_err(|error| UpdateError::Install(error.to_string()))?;
    sync_directory(versions_path)?;
    Ok(manifest.into_installed(false))
}

fn parse_version_directory(name: &str) -> Option<VersionKey> {
    if validate_commit(name).is_ok() {
        return VersionKey::new(VersionSource::Action, name).ok();
    }
    let (source, identity) = name.split_once('-')?;
    let source = match source {
        "action" => VersionSource::Action,
        "release" => VersionSource::Release,
        _ => return None,
    };
    let Some((source_id, commit)) = identity.split_once('-') else {
        return VersionKey::new(source, identity).ok();
    };
    let source_id = source_id.parse::<u64>().ok()?;
    VersionKey::tracked(source, source_id, commit).ok()
}

fn version_path(versions_path: &Path, key: &VersionKey) -> PathBuf {
    versions_path.join(key.directory_name())
}

fn locate_version_directory(
    versions_path: &Path,
    key: &VersionKey,
) -> Result<PathBuf, UpdateError> {
    let current = version_path(versions_path, key);
    if path_entry_exists(&current)? {
        return Ok(current);
    }
    if key.source_id.is_some() {
        let trackless = versions_path.join(format!("{}-{}", key.source.as_str(), key.commit));
        if path_entry_exists(&trackless)? {
            return Ok(trackless);
        }
    }
    if key.source == VersionSource::Release {
        return Ok(current);
    }
    let legacy = versions_path.join(&key.commit);
    if path_entry_exists(&legacy)? {
        return Ok(legacy);
    }
    Ok(current)
}

fn path_entry_exists(path: &Path) -> Result<bool, UpdateError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(UpdateError::Install(error.to_string())),
    }
}

fn ensure_directory(path: &Path) -> Result<(), UpdateError> {
    fs::create_dir_all(path).map_err(|error| UpdateError::Install(error.to_string()))?;
    let metadata =
        fs::symlink_metadata(path).map_err(|error| UpdateError::Install(error.to_string()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(UpdateError::Invalid(format!(
            "目录必须是普通目录：{}",
            path.display()
        )));
    }
    Ok(())
}

fn regular_file_exists(path: &Path) -> Result<bool, UpdateError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(UpdateError::Install(format!(
            "路径必须是普通文件：{}",
            path.display()
        ))),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(UpdateError::Install(error.to_string())),
    }
}

fn read_regular_file(path: &Path, label: &str) -> Result<Vec<u8>, UpdateError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| UpdateError::Install(format!("读取{label}失败：{error}")))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(UpdateError::Verification(format!(
            "{label}必须是普通文件，不能是符号链接"
        )));
    }
    fs::read(path).map_err(|error| UpdateError::Install(format!("读取{label}失败：{error}")))
}

#[cfg(test)]
#[path = "updates/tests.rs"]
mod tests;
