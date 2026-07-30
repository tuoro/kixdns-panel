use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Cursor, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tempfile::{Builder, NamedTempFile};
use tokio::sync::{Mutex, RwLock};

use crate::auth::unix_timestamp;
use crate::control::ControlClient;
use crate::db::Database;
use crate::digest::sha256_hex;
use crate::operations::{Operations, ServiceAction};

const ACTIVE_VERSION_KEY: &str = "installed_panel_version";
const LEGACY_ACTIVE_COMMIT_KEY: &str = "installed_panel_commit";
const UPSTREAM_REPOSITORY: &str = "olicesx/kixdns";
const PANEL_REPOSITORY: &str = "tuoro/kixdns-panel";
const MAX_ARTIFACT_BYTES: usize = 128 * 1024 * 1024;
const MAX_BINARY_BYTES: u64 = 96 * 1024 * 1024;
const REMOTE_VERSION_LIMIT: usize = 12;
const MAX_INSTALLED_VERSIONS: usize = 8;
const MANIFEST_SCHEMA_VERSION: u32 = 4;
const CONTROL_PROTOCOL_VERSION: u32 = 1;
const MAX_BUILD_IDENTITY_BYTES: u64 = 64 * 1024;
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
            self.install_resolved(&resolved).await?;
            self.activate_locked(&key, operations, control).await?;
        }
        Ok(to_update_info(resolved, Some(&key)))
    }

    pub async fn install_version(
        &self,
        source: VersionSource,
        source_id: u64,
        operations: &Operations,
        control: &ControlClient,
    ) -> Result<InstalledVersion, UpdateError> {
        self.ensure_management_enabled()?;
        let _guard = self.apply_lock.lock().await;
        let resolved = self.resolve_remote(source, source_id).await?;
        let key = VersionKey::remote(&resolved.remote)?;
        self.install_resolved(&resolved).await?;
        self.activate_locked(&key, operations, control).await
    }

    pub async fn activate_version(
        &self,
        source: VersionSource,
        version: &str,
        operations: &Operations,
        control: &ControlClient,
    ) -> Result<InstalledVersion, UpdateError> {
        self.ensure_management_enabled()?;
        let _guard = self.apply_lock.lock().await;
        let key = match version.parse::<u64>() {
            Ok(source_id) if source_id > 0 => self.installed_key(source, source_id).await?,
            _ => VersionKey::new(source, version)?,
        };
        self.activate_locked(&key, operations, control).await
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

    async fn install_resolved(&self, version: &ResolvedVersion) -> Result<(), UpdateError> {
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
        operations: &Operations,
        control: &ControlClient,
    ) -> Result<InstalledVersion, UpdateError> {
        if regular_file_exists(self.binary_path.as_ref())?
            && let Some(active) = self.active_version().await?
        {
            self.adopt_active_version(&active).await?;
        }
        let versions_path = Arc::clone(&self.versions_path);
        let key_owned = key.clone();
        let (manifest, binary) =
            tokio::task::spawn_blocking(move || load_verified_version(&versions_path, &key_owned))
                .await
                .map_err(|error| UpdateError::Install(error.to_string()))??;
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
                binary_sha256: sha256(&binary),
                installed_at: unix_timestamp(),
            };
            store_version(&versions_path, &manifest, &binary)
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
    Ok(ExtractedArtifact {
        binary,
        identity,
        build_commit,
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
    if manifest.schema_version == MANIFEST_SCHEMA_VERSION && manifest.source.is_none() {
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
    if manifest.schema_version < MANIFEST_SCHEMA_VERSION {
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

fn validate_slug(value: &str, repository: bool) -> Result<(), UpdateError> {
    let slash_count = value.bytes().filter(|byte| *byte == b'/').count();
    if value.is_empty()
        || value.len() > 200
        || (repository && slash_count != 1)
        || (!repository && slash_count != 0)
        || value.split('/').any(|part| matches!(part, "" | "." | ".."))
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'-' | b'.'))
    {
        return Err(UpdateError::Invalid(
            "仓库、工作流或产物名称无效".to_owned(),
        ));
    }
    Ok(())
}

fn validate_digest(digest: &str) -> Result<(), UpdateError> {
    let value = digest
        .strip_prefix("sha256:")
        .ok_or_else(|| UpdateError::Verification("只接受 SHA-256 Artifact digest".to_owned()))?;
    validate_hex_digest(value)
}

fn validate_commit(commit: &str) -> Result<(), UpdateError> {
    if commit.len() != 40 || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(UpdateError::Invalid(
            "构建提交必须是完整的 40 位十六进制 SHA".to_owned(),
        ));
    }
    Ok(())
}

fn validate_release_tag(tag: &str) -> Result<(), UpdateError> {
    if tag.is_empty()
        || tag.len() > 100
        || !tag
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(UpdateError::Verification("Release 标签无效".to_owned()));
    }
    Ok(())
}

fn parse_panel_release_version(tag: &str) -> Result<semver::Version, UpdateError> {
    validate_release_tag(tag)?;
    let version = tag
        .strip_prefix('v')
        .ok_or_else(|| UpdateError::Verification("面板 Release 标签必须使用 v 前缀".to_owned()))?;
    semver::Version::parse(version)
        .map_err(|error| UpdateError::Verification(format!("面板 Release 版本无效：{error}")))
}

fn artifact_coordinates(artifact: &str) -> Result<(&str, &str), UpdateError> {
    let (prefix, architecture) = artifact
        .rsplit_once("-linux-")
        .ok_or_else(|| UpdateError::Invalid("Artifact 名称必须以 -linux-<架构> 结尾".to_owned()))?;
    if prefix.is_empty() || architecture.is_empty() {
        return Err(UpdateError::Invalid("Artifact 名称无效".to_owned()));
    }
    Ok((prefix, architecture))
}

struct ParsedArtifactReference {
    reference: TrackReference,
    patchset: Option<u32>,
}

fn parse_artifact_reference(
    base: &str,
    source: VersionSource,
    artifact: &str,
) -> Option<ParsedArtifactReference> {
    let (prefix, architecture) = artifact_coordinates(base).ok()?;
    let prefix = format!("{prefix}-{}-", source.as_str());
    let suffix = format!("-linux-{architecture}");
    let identity = artifact.strip_prefix(&prefix)?.strip_suffix(&suffix)?;
    let (reference, patchset) = parse_artifact_build_identity(identity)?;
    let reference = match source {
        VersionSource::Action => reference
            .parse::<u64>()
            .ok()
            .filter(|run_id| *run_id > 0 && run_id.to_string() == reference)
            .map(TrackReference::Action),
        VersionSource::Release => validate_release_tag(reference)
            .ok()
            .map(|()| TrackReference::Release(reference.to_owned())),
    }?;
    Some(ParsedArtifactReference {
        reference,
        patchset,
    })
}

fn parse_artifact_build_identity(identity: &str) -> Option<(&str, Option<u32>)> {
    let Some((reference, build)) = identity.rsplit_once("-p") else {
        return Some((identity, None));
    };
    let Some((patchset, fingerprint)) = build.split_once('-') else {
        return Some((identity, None));
    };
    if fingerprint.len() != 12 || !fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Some((identity, None));
    }
    let patchset = patchset.parse::<u32>().ok().filter(|value| *value > 0)?;
    Some((reference, Some(patchset)))
}

fn validate_build_identity(identity: &BuildIdentity) -> Result<(), UpdateError> {
    if identity.repository != UPSTREAM_REPOSITORY {
        return Err(UpdateError::Verification("上游仓库身份无效".to_owned()));
    }
    validate_commit(&identity.commit)
        .map_err(|_| UpdateError::Verification("上游提交身份无效".to_owned()))?;
    if identity.patchset == 0 {
        return Err(UpdateError::Verification("增强补丁集版本无效".to_owned()));
    }
    if identity.control_protocol != CONTROL_PROTOCOL_VERSION {
        return Err(UpdateError::Verification(format!(
            "控制协议不兼容：需要 v{CONTROL_PROTOCOL_VERSION}，产物为 v{}",
            identity.control_protocol
        )));
    }
    match identity.source {
        VersionSource::Action
            if identity.official_run_id.is_some_and(|run_id| run_id > 0)
                && identity.release_id.is_none()
                && identity.release_tag.is_none() => {}
        VersionSource::Release
            if identity.release_id.is_some_and(|release_id| release_id > 0)
                && identity
                    .release_tag
                    .as_deref()
                    .is_some_and(|tag| validate_release_tag(tag).is_ok())
                && identity.official_run_id.is_none() => {}
        _ => {
            return Err(UpdateError::Verification(
                "包内上游来源身份不完整".to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_remote_build_identity(
    remote: &RemoteVersion,
    identity: &BuildIdentity,
) -> Result<(), UpdateError> {
    if remote.source != identity.source {
        return Err(UpdateError::Verification(
            "包内上游来源与所选版本轨道不匹配".to_owned(),
        ));
    }
    if remote
        .patchset
        .is_some_and(|patchset| patchset != identity.patchset)
    {
        return Err(UpdateError::Verification(
            "包内补丁集与 Artifact 名称不匹配".to_owned(),
        ));
    }
    match remote.source {
        VersionSource::Action if remote.run_id == identity.official_run_id => Ok(()),
        VersionSource::Release if remote.release_tag == identity.release_tag => Ok(()),
        VersionSource::Action => Err(UpdateError::Verification(
            "包内官方 Action Run 与 Artifact 名称不匹配".to_owned(),
        )),
        VersionSource::Release => Err(UpdateError::Verification(
            "包内上游 Release 标签与 Artifact 名称不匹配".to_owned(),
        )),
    }
}

fn validate_manifest_source(manifest: &VersionManifest) -> Result<(), UpdateError> {
    match (
        manifest.source,
        manifest.source_id,
        manifest.run_id,
        manifest.release_tag.as_deref(),
    ) {
        (None, None, _, None) if manifest.schema_version < MANIFEST_SCHEMA_VERSION => Ok(()),
        (Some(_), None, None, None) => Ok(()),
        (Some(VersionSource::Action), Some(source_id), Some(run_id), None)
            if source_id > 0 && run_id > 0 =>
        {
            Ok(())
        }
        (Some(VersionSource::Release), Some(source_id), None, Some(tag)) if source_id > 0 => {
            validate_release_tag(tag)
        }
        _ => Err(UpdateError::Verification(
            "版本清单来源身份不完整".to_owned(),
        )),
    }
}

fn validate_manifest_build_identity(manifest: &VersionManifest) -> Result<(), UpdateError> {
    match (
        manifest.upstream_repository.as_ref(),
        manifest.upstream_commit.as_ref(),
        manifest.patchset,
        manifest.control_protocol,
    ) {
        (None, None, None, None) => Ok(()),
        (Some(repository), Some(commit), Some(patchset), Some(control_protocol)) => {
            if repository != UPSTREAM_REPOSITORY {
                return Err(UpdateError::Verification("上游仓库身份无效".to_owned()));
            }
            validate_commit(commit)
                .map_err(|_| UpdateError::Verification("上游提交身份无效".to_owned()))?;
            if patchset == 0 || control_protocol != CONTROL_PROTOCOL_VERSION {
                return Err(UpdateError::Verification(
                    "版本清单中的增强构建身份无效".to_owned(),
                ));
            }
            Ok(())
        }
        _ => Err(UpdateError::Verification(
            "版本清单中的构建身份不完整".to_owned(),
        )),
    }
}

fn validate_hex_digest(value: &str) -> Result<(), UpdateError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(UpdateError::Verification("SHA-256 摘要格式无效".to_owned()));
    }
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}

fn constant_hash_eq(left: &str, right: &str) -> bool {
    use subtle::ConstantTimeEq;
    left.as_bytes().ct_eq(right.as_bytes()).unwrap_u8() == 1
}

fn validate_elf(binary: &[u8]) -> Result<(), UpdateError> {
    if binary.len() < 20 || &binary[..4] != b"\x7fELF" || binary[5] != 1 {
        return Err(UpdateError::Verification(
            "更新二进制不是小端 ELF".to_owned(),
        ));
    }
    let machine = u16::from_le_bytes([binary[18], binary[19]]);
    let expected = match std::env::consts::ARCH {
        "x86_64" => 62,
        "aarch64" => 183,
        architecture => {
            tracing::debug!(architecture, "不支持的自动更新架构");
            return Err(UpdateError::Unsupported);
        }
    };
    if machine != expected {
        return Err(UpdateError::Verification(format!(
            "ELF 架构不匹配：期望 {expected}，实际 {machine}"
        )));
    }
    Ok(())
}

fn write_executable(
    directory: &Path,
    prefix: &str,
    bytes: &[u8],
) -> Result<NamedTempFile, UpdateError> {
    let temporary = write_private_file(directory, prefix, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o750))
            .map_err(|error| UpdateError::Install(error.to_string()))?;
    }
    Ok(temporary)
}

fn write_private_file(
    directory: &Path,
    prefix: &str,
    bytes: &[u8],
) -> Result<NamedTempFile, UpdateError> {
    let mut temporary = Builder::new()
        .prefix(prefix)
        .tempfile_in(directory)
        .map_err(|error| UpdateError::Install(error.to_string()))?;
    temporary
        .write_all(bytes)
        .map_err(|error| UpdateError::Install(error.to_string()))?;
    temporary
        .flush()
        .map_err(|error| UpdateError::Install(error.to_string()))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| UpdateError::Install(error.to_string()))?;
    Ok(temporary)
}

fn persist(temporary: NamedTempFile, path: &Path) -> Result<(), UpdateError> {
    temporary
        .persist(path)
        .map_err(|error| UpdateError::Install(error.error.to_string()))?;
    Ok(())
}

#[cfg_attr(not(unix), allow(clippy::unnecessary_wraps))]
fn sync_directory(path: &Path) -> Result<(), UpdateError> {
    #[cfg(unix)]
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| UpdateError::Install(error.to_string()))?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

async fn wait_until_healthy(control: &ControlClient) -> Result<(), UpdateError> {
    for _ in 0..40 {
        if control.health().await.is_ok() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(UpdateError::Install(
        "新版本在 10 秒内未通过健康检查".to_owned(),
    ))
}

#[cfg(not(unix))]
fn ensure_update_platform() -> Result<(), UpdateError> {
    Err(UpdateError::Unsupported)
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use tempfile::tempdir;

    use super::{
        BuildIdentity, GithubRelease, MANIFEST_SCHEMA_VERSION, ParsedArtifactReference,
        ReleaseAsset, RemoteVersion, TrackReference, UpdateError, UpdateManager, UpdateSettings,
        VersionKey, VersionManifest, VersionSource, delete_stored_version, extract_artifact,
        load_verified_version, panel_release_asset_name, parse_artifact_reference, sha256,
        store_version, to_kixdns_update_notice, to_panel_update_notice, validate_commit,
        validate_digest, validate_remote_build_identity, validate_slug,
    };
    use crate::db::Database;

    const TEST_BUILD_COMMIT: &str = "4e8002d08a56afc08be335d0d5ed337c7690f9af";

    const TEST_IDENTITY: &str = r#"{
        "repository":"olicesx/kixdns",
        "source":"action",
        "commit":"374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25",
        "official_run_id":30235703570,
        "patchset":5,
        "control_protocol":1
    }"#;

    fn test_elf() -> Vec<u8> {
        let mut binary = vec![0_u8; 32];
        binary[..4].copy_from_slice(b"\x7fELF");
        binary[5] = 1;
        let machine = match std::env::consts::ARCH {
            "aarch64" => 183_u16,
            _ => 62_u16,
        };
        binary[18..20].copy_from_slice(&machine.to_le_bytes());
        binary
    }

    fn test_checksums(binary: &[u8], identity: &str) -> String {
        format!(
            "{}  kixdns\n{}  upstream.lock.json\n{}  KIXDNS_BUILD_COMMIT\n",
            sha256(binary),
            sha256(identity.as_bytes()),
            sha256(TEST_BUILD_COMMIT.as_bytes())
        )
    }

    fn test_manifest(source_id: u64, commit: &str, binary: &[u8]) -> VersionManifest {
        VersionManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            source: Some(VersionSource::Action),
            source_id: Some(source_id),
            commit: commit.to_owned(),
            run_id: Some(source_id),
            release_tag: None,
            created_at: Some("2026-07-28T00:00:00Z".to_owned()),
            source_url: Some(format!(
                "https://github.com/olicesx/kixdns/actions/runs/{source_id}"
            )),
            build_url: Some("https://github.com/tuoro/kixdns-panel/actions/runs/99".to_owned()),
            artifact: format!("kixdns-enhanced-action-{source_id}-linux-x86_64"),
            artifact_digest: Some(format!("sha256:{}", "a".repeat(64))),
            upstream_repository: Some("olicesx/kixdns".to_owned()),
            upstream_commit: Some("374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25".to_owned()),
            patchset: Some(5),
            control_protocol: Some(1),
            binary_sha256: sha256(binary),
            installed_at: 42,
        }
    }

    #[test]
    fn validates_fixed_update_coordinates_and_digests() {
        assert!(validate_slug("tuoro/kixdns-panel", true).is_ok());
        assert!(validate_slug("https://evil.invalid", true).is_err());
        assert!(validate_slug("build-kixdns.yml", false).is_ok());
        assert!(validate_slug("../../workflow", false).is_err());
        assert!(validate_slug("..", false).is_err());
        assert!(validate_slug("owner/..", true).is_err());
        assert!(validate_digest(&format!("sha256:{}", "a".repeat(64))).is_ok());
        assert!(validate_digest("sha256:bad").is_err());
        assert!(validate_commit("374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25").is_ok());
        assert!(validate_commit("not-a-commit").is_err());
        let tracked = VersionKey::tracked(
            VersionSource::Action,
            42,
            "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25",
        )
        .unwrap();
        assert_eq!(VersionKey::parse(&tracked.encoded()).unwrap(), tracked);
        assert!(matches!(
            parse_artifact_reference(
                "kixdns-enhanced-linux-x86_64",
                VersionSource::Action,
                "kixdns-enhanced-action-30235703570-linux-x86_64"
            ),
            Some(ParsedArtifactReference {
                reference: TrackReference::Action(30_235_703_570),
                patchset: None,
            })
        ));
        assert!(matches!(
            parse_artifact_reference(
                "kixdns-enhanced-linux-x86_64",
                VersionSource::Release,
                "kixdns-enhanced-release-v0.1.1-linux-x86_64"
            ),
            Some(ParsedArtifactReference {
                reference: TrackReference::Release(tag),
                patchset: None,
            }) if tag == "v0.1.1"
        ));
        assert!(matches!(
            parse_artifact_reference(
                "kixdns-enhanced-linux-x86_64",
                VersionSource::Action,
                "kixdns-enhanced-action-30235703570-p5-44e7e6b02316-linux-x86_64"
            ),
            Some(ParsedArtifactReference {
                reference: TrackReference::Action(30_235_703_570),
                patchset: Some(5),
            })
        ));
        assert!(
            parse_artifact_reference(
                "kixdns-enhanced-linux-x86_64",
                VersionSource::Release,
                "kixdns-enhanced-release-../../bad-linux-x86_64"
            )
            .is_none()
        );
    }

    #[test]
    fn serializes_remote_artifact_identity() {
        let artifact_digest = format!("sha256:{}", "a".repeat(64));
        let remote = RemoteVersion {
            source: VersionSource::Action,
            source_id: 42,
            commit: "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25".to_owned(),
            run_id: Some(42),
            release_tag: None,
            patchset: None,
            created_at: "2026-07-28T00:00:00Z".to_owned(),
            source_url: "https://github.com/olicesx/kixdns/actions/runs/42".to_owned(),
            build_url: "https://github.com/tuoro/kixdns-panel/actions/runs/99".to_owned(),
            artifact: "kixdns-enhanced-action-42-linux-x86_64".to_owned(),
            artifact_digest: artifact_digest.clone(),
            download_url: "https://nightly.link/example/actions/runs/42/artifact.zip".to_owned(),
            installed: false,
            active: false,
        };

        let serialized = serde_json::to_value(remote).unwrap();
        assert_eq!(serialized["artifact_digest"], artifact_digest);
    }

    #[test]
    fn notifies_only_for_newer_panel_release_with_matching_asset() {
        let no_release = to_panel_update_notice(Some(TEST_BUILD_COMMIT), None, None).unwrap();
        assert!(!no_release.available);
        assert!(no_release.latest_version.is_none());

        let release = |tag: &str, asset_name: &str| GithubRelease {
            tag_name: tag.to_owned(),
            published_at: Some("2026-07-30T00:00:00Z".to_owned()),
            assets: vec![ReleaseAsset {
                name: asset_name.to_owned(),
                digest: Some(format!("sha256:{}", "a".repeat(64))),
            }],
        };
        let same = release("v0.1.0", panel_release_asset_name());
        assert!(
            !to_panel_update_notice(None, Some("v0.1.0"), Some(&same))
                .unwrap()
                .available
        );
        assert!(
            to_panel_update_notice(Some(TEST_BUILD_COMMIT), None, Some(&same))
                .unwrap()
                .available
        );

        let older = release("v0.0.9", panel_release_asset_name());
        assert!(
            !to_panel_update_notice(Some(TEST_BUILD_COMMIT), None, Some(&older))
                .unwrap()
                .available
        );

        let wrong_asset = release("v0.2.0", "kixdns-panel-windows.zip");
        assert!(
            !to_panel_update_notice(None, None, Some(&wrong_asset))
                .unwrap()
                .available
        );

        let newer = release("v0.2.0", panel_release_asset_name());
        let notice = to_panel_update_notice(Some(TEST_BUILD_COMMIT), None, Some(&newer)).unwrap();
        assert!(notice.available);
        assert_eq!(notice.current_version, "0.1.0");
        assert_eq!(notice.latest_version.as_deref(), Some("0.2.0"));
        assert_eq!(
            notice.download_url.as_deref(),
            Some(
                format!(
                    "https://github.com/tuoro/kixdns-panel/releases/download/v0.2.0/{}",
                    panel_release_asset_name()
                )
                .as_str()
            )
        );
    }

    #[test]
    fn legacy_kixdns_identity_is_not_treated_as_exact_build() {
        let remote = RemoteVersion {
            source: VersionSource::Action,
            source_id: 42,
            commit: TEST_BUILD_COMMIT.to_owned(),
            run_id: Some(7),
            release_tag: None,
            patchset: Some(5),
            created_at: "2026-07-30T00:00:00Z".to_owned(),
            source_url: "https://github.com/olicesx/kixdns/actions/runs/7".to_owned(),
            build_url: "https://github.com/tuoro/kixdns-panel/actions/runs/8".to_owned(),
            artifact: "kixdns-enhanced-linux-x86_64".to_owned(),
            artifact_digest: format!("sha256:{}", "a".repeat(64)),
            download_url: "https://nightly.link/example.zip".to_owned(),
            installed: false,
            active: false,
        };
        let legacy = VersionKey::new(VersionSource::Action, TEST_BUILD_COMMIT).unwrap();
        assert!(to_kixdns_update_notice(&remote, Some(&legacy)).available);

        let exact = VersionKey::tracked(VersionSource::Action, 42, TEST_BUILD_COMMIT).unwrap();
        assert!(!to_kixdns_update_notice(&remote, Some(&exact)).available);
    }

    #[test]
    fn extracts_only_checksum_verified_binary() {
        let binary = b"test-binary";
        let checksum = test_checksums(binary, TEST_IDENTITY);
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("kixdns", options).unwrap();
        writer.write_all(binary).unwrap();
        writer.start_file("SHA256SUMS", options).unwrap();
        writer.write_all(checksum.as_bytes()).unwrap();
        writer.start_file("upstream.lock.json", options).unwrap();
        writer.write_all(TEST_IDENTITY.as_bytes()).unwrap();
        writer.start_file("KIXDNS_BUILD_COMMIT", options).unwrap();
        writer.write_all(TEST_BUILD_COMMIT.as_bytes()).unwrap();
        let archive = writer.finish().unwrap().into_inner();

        let extracted = extract_artifact(&archive).unwrap();
        assert_eq!(extracted.binary, binary);
        assert_eq!(extracted.identity.patchset, 5);
        assert_eq!(extracted.build_commit, TEST_BUILD_COMMIT);

        let wrong_checksum = checksum.replace(&sha256(binary), &"0".repeat(64));
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer.start_file("kixdns", options).unwrap();
        writer.write_all(binary).unwrap();
        writer.start_file("SHA256SUMS", options).unwrap();
        writer.write_all(wrong_checksum.as_bytes()).unwrap();
        writer.start_file("upstream.lock.json", options).unwrap();
        writer.write_all(TEST_IDENTITY.as_bytes()).unwrap();
        writer.start_file("KIXDNS_BUILD_COMMIT", options).unwrap();
        writer.write_all(TEST_BUILD_COMMIT.as_bytes()).unwrap();
        let tampered = writer.finish().unwrap().into_inner();
        assert!(extract_artifact(&tampered).is_err());
    }

    #[test]
    fn rejects_incompatible_control_protocol() {
        let binary = b"test-binary";
        let incompatible =
            TEST_IDENTITY.replace("\"control_protocol\":1", "\"control_protocol\":2");
        let checksum = test_checksums(binary, &incompatible);
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("kixdns", options).unwrap();
        writer.write_all(binary).unwrap();
        writer.start_file("SHA256SUMS", options).unwrap();
        writer.write_all(checksum.as_bytes()).unwrap();
        writer.start_file("upstream.lock.json", options).unwrap();
        writer.write_all(incompatible.as_bytes()).unwrap();
        writer.start_file("KIXDNS_BUILD_COMMIT", options).unwrap();
        writer.write_all(TEST_BUILD_COMMIT.as_bytes()).unwrap();
        let archive = writer.finish().unwrap().into_inner();

        assert!(extract_artifact(&archive).is_err());
    }

    #[test]
    fn stores_and_revalidates_local_versions() {
        let directory = tempdir().unwrap();
        let binary = test_elf();
        let commit = "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25";
        let manifest = VersionManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            source: Some(VersionSource::Action),
            source_id: Some(42),
            commit: commit.to_owned(),
            run_id: Some(42),
            release_tag: None,
            created_at: Some("2026-07-28T00:00:00Z".to_owned()),
            source_url: Some("https://github.com/olicesx/kixdns/actions/runs/42".to_owned()),
            build_url: Some("https://github.com/tuoro/kixdns-panel/actions/runs/99".to_owned()),
            artifact: "kixdns-enhanced-action-42-linux-x86_64".to_owned(),
            artifact_digest: Some(format!("sha256:{}", "a".repeat(64))),
            upstream_repository: Some("olicesx/kixdns".to_owned()),
            upstream_commit: Some(commit.to_owned()),
            patchset: Some(5),
            control_protocol: Some(1),
            binary_sha256: sha256(&binary),
            installed_at: 42,
        };
        let key = VersionKey::tracked(VersionSource::Action, 42, commit).unwrap();
        store_version(directory.path(), &manifest, &binary).unwrap();
        let (loaded, loaded_binary) = load_verified_version(directory.path(), &key).unwrap();
        assert_eq!(loaded.commit, commit);
        assert_eq!(loaded_binary, binary);

        std::fs::write(
            directory.path().join(key.directory_name()).join("kixdns"),
            b"tampered",
        )
        .unwrap();
        assert!(load_verified_version(directory.path(), &key).is_err());
    }

    #[test]
    fn deletes_only_verified_local_version_directories() {
        let directory = tempdir().unwrap();
        let binary = test_elf();
        let commit = "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25";
        let key = VersionKey::tracked(VersionSource::Action, 42, commit).unwrap();
        store_version(
            directory.path(),
            &test_manifest(42, commit, &binary),
            &binary,
        )
        .unwrap();

        let deleted = delete_stored_version(directory.path(), &key).unwrap();

        assert_eq!(deleted.source_id, Some(42));
        assert!(!deleted.active);
        assert!(!directory.path().join(key.directory_name()).exists());

        std::fs::write(
            directory.path().join(key.directory_name()),
            b"not-a-directory",
        )
        .unwrap();
        assert!(matches!(
            delete_stored_version(directory.path(), &key),
            Err(UpdateError::Verification(_))
        ));
        assert!(directory.path().join(key.directory_name()).is_file());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_version_directory_when_deleting() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let commit = "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25";
        let key = VersionKey::tracked(VersionSource::Action, 42, commit).unwrap();
        symlink(outside.path(), directory.path().join(key.directory_name())).unwrap();

        assert!(matches!(
            delete_stored_version(directory.path(), &key),
            Err(UpdateError::Verification(_))
        ));
        assert!(outside.path().is_dir());
    }

    #[tokio::test]
    async fn treats_empty_panel_release_as_unset() {
        let directory = tempdir().unwrap();
        let manager = UpdateManager::new(
            Database::open(directory.path().join("panel.db"))
                .await
                .unwrap(),
            UpdateSettings {
                repository: "tuoro/kixdns-panel".to_owned(),
                workflow: "build-kixdns.yml".to_owned(),
                release_workflow: "build-kixdns-release.yml".to_owned(),
                branch: "main".to_owned(),
                artifact: "kixdns-enhanced-linux-x86_64".to_owned(),
                installed_commit: None,
                panel_installed_commit: None,
                panel_installed_release: Some(String::new()),
                management_enabled: true,
                binary_path: directory.path().join("bin/kixdns"),
                versions_path: directory.path().join("versions"),
            },
        )
        .unwrap();

        assert!(manager.panel_release.is_none());
    }

    #[tokio::test]
    async fn refuses_to_delete_the_active_version() {
        let directory = tempdir().unwrap();
        let database = Database::open(directory.path().join("panel.db"))
            .await
            .unwrap();
        let binary_path = directory.path().join("bin/kixdns");
        let versions_path = directory.path().join("versions");
        let manager = UpdateManager::new(
            database.clone(),
            UpdateSettings {
                repository: "tuoro/kixdns-panel".to_owned(),
                workflow: "build-kixdns.yml".to_owned(),
                release_workflow: "build-kixdns-release.yml".to_owned(),
                branch: "main".to_owned(),
                artifact: "kixdns-enhanced-linux-x86_64".to_owned(),
                installed_commit: None,
                panel_installed_commit: None,
                panel_installed_release: None,
                management_enabled: true,
                binary_path: binary_path.clone(),
                versions_path: versions_path.clone(),
            },
        )
        .unwrap();
        let binary = test_elf();
        let commit = "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25";
        let key = VersionKey::tracked(VersionSource::Action, 42, commit).unwrap();
        std::fs::write(binary_path, &binary).unwrap();
        store_version(&versions_path, &test_manifest(42, commit, &binary), &binary).unwrap();
        database
            .set_setting(super::ACTIVE_VERSION_KEY, key.encoded(), 42)
            .await
            .unwrap();

        let error = manager
            .delete_version(VersionSource::Action, "42")
            .await
            .unwrap_err();

        assert!(matches!(error, UpdateError::Invalid(_)));
        assert!(versions_path.join(key.directory_name()).is_dir());
    }

    #[tokio::test]
    async fn external_mode_never_manages_kixdns_versions() {
        let directory = tempdir().unwrap();
        let binary_path = directory.path().join("bin/kixdns");
        std::fs::create_dir_all(binary_path.parent().unwrap()).unwrap();
        std::fs::write(&binary_path, test_elf()).unwrap();
        let manager = UpdateManager::new(
            Database::open(directory.path().join("panel.db"))
                .await
                .unwrap(),
            UpdateSettings {
                repository: "tuoro/kixdns-panel".to_owned(),
                workflow: "build-kixdns.yml".to_owned(),
                release_workflow: "build-kixdns-release.yml".to_owned(),
                branch: "main".to_owned(),
                artifact: "kixdns-enhanced-linux-x86_64".to_owned(),
                installed_commit: None,
                panel_installed_commit: None,
                panel_installed_release: None,
                management_enabled: false,
                binary_path,
                versions_path: directory.path().join("versions"),
            },
        )
        .unwrap();

        let catalog = manager.catalog(VersionSource::Release).await.unwrap();
        assert!(!catalog.management_enabled);
        assert!(catalog.binary_present);
        assert!(catalog.remote_versions.is_empty());
        assert!(catalog.installed_versions.is_empty());
        assert!(matches!(
            manager
                .delete_version(VersionSource::Action, TEST_BUILD_COMMIT)
                .await,
            Err(UpdateError::Invalid(message)) if message.contains("外部 KixDNS")
        ));
    }

    #[test]
    fn reads_legacy_manifest_without_build_identity() {
        let directory = tempdir().unwrap();
        let binary = test_elf();
        let commit = "8eb8588ebe3e7965cf40ca161c05ac400ac2f5e5";
        let manifest = VersionManifest {
            schema_version: 1,
            source: None,
            source_id: None,
            commit: commit.to_owned(),
            run_id: None,
            release_tag: None,
            created_at: None,
            source_url: None,
            build_url: None,
            artifact: "kixdns-enhanced-linux-x86_64".to_owned(),
            artifact_digest: None,
            upstream_repository: None,
            upstream_commit: None,
            patchset: None,
            control_protocol: None,
            binary_sha256: sha256(&binary),
            installed_at: 42,
        };

        store_version(directory.path(), &manifest, &binary).unwrap();
        let key = VersionKey::new(VersionSource::Action, commit).unwrap();
        std::fs::rename(
            directory.path().join(key.directory_name()),
            directory.path().join(commit),
        )
        .unwrap();
        let (loaded, _) = load_verified_version(directory.path(), &key).unwrap();
        assert_eq!(loaded.schema_version, 1);
        assert_eq!(loaded.source, Some(VersionSource::Action));
        assert!(loaded.upstream_commit.is_none());
    }

    #[test]
    fn keeps_tracked_builds_with_the_same_commit_separate() {
        let directory = tempdir().unwrap();
        let binary = test_elf();
        let commit = TEST_BUILD_COMMIT;
        let make_manifest =
            |source, source_id, run_id, release_tag, artifact: &str| VersionManifest {
                schema_version: MANIFEST_SCHEMA_VERSION,
                source: Some(source),
                source_id: Some(source_id),
                commit: commit.to_owned(),
                run_id,
                release_tag,
                created_at: Some("2026-07-28T00:00:00Z".to_owned()),
                source_url: Some("https://github.com/olicesx/kixdns".to_owned()),
                build_url: Some("https://github.com/tuoro/kixdns-panel/actions/runs/99".to_owned()),
                artifact: artifact.to_owned(),
                artifact_digest: Some(format!("sha256:{}", "a".repeat(64))),
                upstream_repository: Some("olicesx/kixdns".to_owned()),
                upstream_commit: Some("374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25".to_owned()),
                patchset: Some(5),
                control_protocol: Some(1),
                binary_sha256: sha256(&binary),
                installed_at: 42,
            };
        let action = make_manifest(
            VersionSource::Action,
            99,
            Some(30_235_703_570),
            None,
            "kixdns-enhanced-action-30235703570-linux-x86_64",
        );
        let release = make_manifest(
            VersionSource::Release,
            100,
            None,
            Some("v0.1.1".to_owned()),
            "kixdns-enhanced-release-v0.1.1-linux-x86_64",
        );
        let previous_action = make_manifest(
            VersionSource::Action,
            101,
            Some(30_231_271_280),
            None,
            "kixdns-enhanced-action-30231271280-linux-x86_64",
        );

        store_version(directory.path(), &action, &binary).unwrap();
        store_version(directory.path(), &release, &binary).unwrap();
        store_version(directory.path(), &previous_action, &binary).unwrap();

        let action_key = VersionKey::tracked(VersionSource::Action, 99, commit).unwrap();
        let release_key = VersionKey::tracked(VersionSource::Release, 100, commit).unwrap();
        let previous_action_key = VersionKey::tracked(VersionSource::Action, 101, commit).unwrap();
        assert!(directory.path().join(action_key.directory_name()).is_dir());
        assert!(directory.path().join(release_key.directory_name()).is_dir());
        assert!(
            directory
                .path()
                .join(previous_action_key.directory_name())
                .is_dir()
        );
        assert_eq!(
            load_verified_version(directory.path(), &action_key)
                .unwrap()
                .0
                .source,
            Some(VersionSource::Action)
        );
        assert_eq!(
            load_verified_version(directory.path(), &release_key)
                .unwrap()
                .0
                .source,
            Some(VersionSource::Release)
        );
    }

    #[test]
    fn verifies_package_identity_against_selected_track() {
        let identity = serde_json::from_str::<BuildIdentity>(TEST_IDENTITY).unwrap();
        let remote = RemoteVersion {
            source: VersionSource::Action,
            source_id: 99,
            commit: TEST_BUILD_COMMIT.to_owned(),
            run_id: Some(30_235_703_570),
            release_tag: None,
            patchset: Some(5),
            created_at: "2026-07-28T00:00:00Z".to_owned(),
            source_url: "https://github.com/olicesx/kixdns/actions/runs/30235703570".to_owned(),
            build_url: "https://github.com/tuoro/kixdns-panel/actions/runs/99".to_owned(),
            artifact: "kixdns-enhanced-action-30235703570-linux-x86_64".to_owned(),
            artifact_digest: format!("sha256:{}", "a".repeat(64)),
            download_url: "https://nightly.link/example/artifact.zip".to_owned(),
            installed: false,
            active: false,
        };
        assert!(validate_remote_build_identity(&remote, &identity).is_ok());
        let mut wrong_track = remote;
        wrong_track.source = VersionSource::Release;
        wrong_track.run_id = None;
        wrong_track.release_tag = Some("v0.1.1".to_owned());
        assert!(validate_remote_build_identity(&wrong_track, &identity).is_err());
    }
}
