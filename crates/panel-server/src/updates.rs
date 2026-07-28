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

const ACTIVE_COMMIT_KEY: &str = "installed_panel_commit";
const MAX_ARTIFACT_BYTES: usize = 128 * 1024 * 1024;
const MAX_BINARY_BYTES: u64 = 96 * 1024 * 1024;
const REMOTE_VERSION_LIMIT: usize = 12;
const MAX_INSTALLED_VERSIONS: usize = 8;
const MANIFEST_SCHEMA_VERSION: u32 = 3;
const CONTROL_PROTOCOL_VERSION: u32 = 1;
const MAX_BUILD_IDENTITY_BYTES: u64 = 64 * 1024;
const REMOTE_CACHE_TTL: Duration = Duration::from_mins(1);

#[derive(Clone)]
pub struct UpdateManager {
    client: reqwest::Client,
    database: Database,
    repository: Arc<str>,
    workflow: Arc<str>,
    branch: Arc<str>,
    artifact: Arc<str>,
    initial_commit: Option<Arc<str>>,
    binary_path: Arc<PathBuf>,
    versions_path: Arc<PathBuf>,
    apply_lock: Arc<Mutex<()>>,
    remote_cache: Arc<RwLock<HashMap<VersionSource, CachedRemoteVersions>>>,
}

pub struct UpdateSettings {
    pub repository: String,
    pub workflow: String,
    pub branch: String,
    pub artifact: String,
    pub installed_commit: Option<String>,
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
    pub active_commit: Option<String>,
    pub binary_present: bool,
    pub remote_versions: Vec<RemoteVersion>,
    pub installed_versions: Vec<InstalledVersion>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VersionSource {
    #[default]
    Action,
    Release,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteVersion {
    pub source: VersionSource,
    pub source_id: u64,
    pub commit: String,
    pub run_id: Option<u64>,
    pub release_tag: Option<String>,
    pub created_at: String,
    pub source_url: String,
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
    pub artifact: String,
    pub artifact_digest: Option<String>,
    pub upstream_repository: Option<String>,
    pub upstream_commit: Option<String>,
    pub patchset: Option<u32>,
    pub build_revision: Option<u32>,
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
    artifact: String,
    artifact_digest: Option<String>,
    #[serde(default)]
    upstream_repository: Option<String>,
    #[serde(default)]
    upstream_commit: Option<String>,
    #[serde(default)]
    patchset: Option<u32>,
    #[serde(default)]
    build_revision: Option<u32>,
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
struct GitHubRelease {
    id: u64,
    tag_name: String,
    target_commitish: String,
    published_at: Option<String>,
    html_url: String,
    draft: bool,
    assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct ReleaseAsset {
    name: String,
    digest: Option<String>,
    browser_download_url: String,
}

#[derive(Debug, Clone, Deserialize)]
struct BuildIdentity {
    repository: String,
    commit: String,
    patchset: u32,
    #[serde(default)]
    build_revision: Option<u32>,
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
}

struct CachedRemoteVersions {
    loaded_at: Instant,
    versions: Vec<ResolvedVersion>,
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
            branch,
            artifact,
            installed_commit,
            binary_path,
            versions_path,
        } = settings;
        validate_slug(&repository, true)?;
        validate_slug(&workflow, false)?;
        validate_slug(&branch, false)?;
        validate_slug(&artifact, false)?;
        if let Some(commit) = installed_commit.as_deref() {
            validate_commit(commit)?;
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
            branch: Arc::from(branch),
            artifact: Arc::from(artifact),
            initial_commit: installed_commit.map(Arc::from),
            binary_path: Arc::new(binary_path),
            versions_path: Arc::new(versions_path),
            apply_lock: Arc::new(Mutex::new(())),
            remote_cache: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    pub async fn catalog(&self, source: VersionSource) -> Result<VersionCatalog, UpdateError> {
        let active_commit = self.active_commit().await?;
        let binary_present = regular_file_exists(self.binary_path.as_ref())?;
        if binary_present && let Some(commit) = active_commit.as_deref() {
            self.adopt_active_version(commit).await?;
        }
        let mut installed_versions = self.installed_versions(active_commit.as_deref()).await?;
        let installed = installed_versions
            .iter()
            .map(|version| version.commit.as_str())
            .collect::<HashSet<_>>();
        let mut remote_versions = self.remote_versions(source, REMOTE_VERSION_LIMIT).await?;
        for version in &mut remote_versions {
            version.installed = installed.contains(version.commit.as_str());
            version.active = active_commit.as_deref() == Some(version.commit.as_str());
        }
        installed_versions.sort_by_key(|version| Reverse(version.installed_at));
        Ok(VersionCatalog {
            source,
            active_commit,
            binary_present,
            remote_versions,
            installed_versions,
        })
    }

    pub async fn check(&self) -> Result<UpdateInfo, UpdateError> {
        let active_commit = self.active_commit().await?;
        let resolved = self
            .resolved_remote_versions(VersionSource::Action)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| UpdateError::Network("没有可安装的成功增强构建".to_owned()))?;
        Ok(to_update_info(resolved, active_commit))
    }

    pub async fn apply(
        &self,
        operations: &Operations,
        control: &ControlClient,
    ) -> Result<UpdateInfo, UpdateError> {
        let _guard = self.apply_lock.lock().await;
        let active_commit = self.active_commit().await?;
        let candidate = self
            .resolved_remote_versions(VersionSource::Action)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| UpdateError::Network("没有可安装的成功增强构建".to_owned()))?;
        let resolved = self.resolve_action(candidate.remote.source_id).await?;
        if active_commit.as_deref() != Some(resolved.remote.commit.as_str()) {
            self.install_resolved(&resolved).await?;
            self.activate_locked(&resolved.remote.commit, operations, control)
                .await?;
        }
        let installed_commit = Some(resolved.remote.commit.clone());
        Ok(to_update_info(resolved, installed_commit))
    }

    pub async fn install_version(
        &self,
        source: VersionSource,
        source_id: u64,
        operations: &Operations,
        control: &ControlClient,
    ) -> Result<InstalledVersion, UpdateError> {
        let _guard = self.apply_lock.lock().await;
        let resolved = self.resolve_remote(source, source_id).await?;
        let commit = resolved.remote.commit.clone();
        self.install_resolved(&resolved).await?;
        self.activate_locked(&commit, operations, control).await
    }

    pub async fn activate_version(
        &self,
        commit: &str,
        operations: &Operations,
        control: &ControlClient,
    ) -> Result<InstalledVersion, UpdateError> {
        validate_commit(commit)?;
        let _guard = self.apply_lock.lock().await;
        self.activate_locked(commit, operations, control).await
    }

    async fn active_commit(&self) -> Result<Option<String>, UpdateError> {
        if !regular_file_exists(self.binary_path.as_ref())? {
            return Ok(None);
        }
        self.database
            .get_setting(ACTIVE_COMMIT_KEY)
            .await
            .map_err(|error| UpdateError::Install(error.to_string()))
            .map(|value| value.or_else(|| self.initial_commit.as_deref().map(str::to_owned)))
    }

    async fn workflow_runs(&self, limit: usize) -> Result<Vec<WorkflowRun>, UpdateError> {
        let limit = limit.clamp(1, 30);
        let runs_url = format!(
            "https://api.github.com/repos/{}/actions/workflows/{}/runs?branch={}&status=success&per_page={limit}",
            self.repository, self.workflow, self.branch
        );
        let runs = self.get_json::<WorkflowRuns>(&runs_url).await?;
        let mut commits = HashSet::new();
        Ok(runs
            .workflow_runs
            .into_iter()
            .filter(|run| validate_commit(&run.head_sha).is_ok())
            .filter(|run| commits.insert(run.head_sha.clone()))
            .take(limit)
            .collect())
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

        let versions = match source {
            VersionSource::Action => self.fetch_action_versions().await?,
            VersionSource::Release => self.fetch_release_versions().await?,
        };
        self.remote_cache.write().await.insert(
            source,
            CachedRemoteVersions {
                loaded_at: Instant::now(),
                versions: versions.clone(),
            },
        );
        Ok(versions)
    }

    async fn fetch_action_versions(&self) -> Result<Vec<ResolvedVersion>, UpdateError> {
        let runs = self.workflow_runs(30).await?;
        let artifacts_url = format!(
            "https://api.github.com/repos/{}/actions/artifacts?per_page=100",
            self.repository
        );
        let artifacts = self.get_json::<ArtifactList>(&artifacts_url).await?;
        let mut digests = HashMap::new();
        for artifact in artifacts.artifacts {
            if artifact.name != self.artifact.as_ref() || artifact.expired {
                continue;
            }
            let (Some(workflow_run), Some(digest)) = (artifact.workflow_run, artifact.digest)
            else {
                continue;
            };
            if validate_digest(&digest).is_ok() {
                digests.entry(workflow_run.id).or_insert(digest);
            }
        }
        Ok(runs
            .into_iter()
            .filter_map(|run| {
                let artifact_digest = digests.remove(&run.id)?;
                Some(ResolvedVersion {
                    remote: self.action_version(run, artifact_digest),
                })
            })
            .take(REMOTE_VERSION_LIMIT)
            .collect())
    }

    async fn fetch_release_versions(&self) -> Result<Vec<ResolvedVersion>, UpdateError> {
        let url = format!(
            "https://api.github.com/repos/{}/releases?per_page=30",
            self.repository
        );
        Ok(self
            .get_json::<Vec<GitHubRelease>>(&url)
            .await?
            .into_iter()
            .filter_map(|release| self.release_version(release))
            .take(REMOTE_VERSION_LIMIT)
            .collect())
    }

    async fn resolve_remote(
        &self,
        source: VersionSource,
        source_id: u64,
    ) -> Result<ResolvedVersion, UpdateError> {
        match source {
            VersionSource::Action => self.resolve_action(source_id).await,
            VersionSource::Release => self
                .fetch_release_versions()
                .await?
                .into_iter()
                .find(|version| version.remote.source_id == source_id)
                .ok_or_else(|| {
                    UpdateError::Invalid("指定 Release 不在最近 30 个有效发布中".to_owned())
                }),
        }
    }

    async fn find_run(&self, run_id: u64) -> Result<WorkflowRun, UpdateError> {
        self.workflow_runs(30)
            .await?
            .into_iter()
            .find(|run| run.id == run_id)
            .ok_or_else(|| {
                UpdateError::Invalid("指定 Action 不在最近 30 次成功增强构建中".to_owned())
            })
    }

    fn action_version(&self, run: WorkflowRun, artifact_digest: String) -> RemoteVersion {
        let download_url = format!(
            "https://nightly.link/{}/actions/runs/{}/{}.zip",
            self.repository, run.id, self.artifact
        );
        RemoteVersion {
            source: VersionSource::Action,
            source_id: run.id,
            commit: run.head_sha,
            run_id: Some(run.id),
            release_tag: None,
            created_at: run.created_at,
            source_url: run.html_url,
            artifact: self.artifact.to_string(),
            artifact_digest,
            download_url,
            installed: false,
            active: false,
        }
    }

    fn release_version(&self, release: GitHubRelease) -> Option<ResolvedVersion> {
        if release.draft
            || validate_commit(&release.target_commitish).is_err()
            || validate_release_tag(&release.tag_name).is_err()
        {
            return None;
        }
        let created_at = release.published_at?;
        let asset_name = format!("{}.zip", self.artifact);
        let asset = release
            .assets
            .into_iter()
            .find(|asset| asset.name == asset_name)?;
        let artifact_digest = asset.digest?;
        if validate_digest(&artifact_digest).is_err()
            || !is_release_download_url(
                &asset.browser_download_url,
                &self.repository,
                &release.tag_name,
                &asset_name,
            )
        {
            return None;
        }
        Some(ResolvedVersion {
            remote: RemoteVersion {
                source: VersionSource::Release,
                source_id: release.id,
                commit: release.target_commitish,
                run_id: None,
                release_tag: Some(release.tag_name),
                created_at,
                source_url: release.html_url,
                artifact: self.artifact.to_string(),
                artifact_digest,
                download_url: asset.browser_download_url,
                installed: false,
                active: false,
            },
        })
    }

    async fn resolve_action(&self, run_id: u64) -> Result<ResolvedVersion, UpdateError> {
        let run = self.find_run(run_id).await?;
        validate_commit(&run.head_sha).map_err(|_| {
            UpdateError::Verification("GitHub Action 未返回完整构建提交 SHA".to_owned())
        })?;
        let artifacts_url = format!(
            "https://api.github.com/repos/{}/actions/runs/{}/artifacts?per_page=100",
            self.repository, run.id
        );
        let artifacts = self.get_json::<ArtifactList>(&artifacts_url).await?;
        let artifact = artifacts
            .artifacts
            .into_iter()
            .find(|artifact| artifact.name == self.artifact.as_ref() && !artifact.expired)
            .ok_or_else(|| UpdateError::Network("构建产物不存在或已过期".to_owned()))?;
        let artifact_digest = artifact.digest.ok_or_else(|| {
            UpdateError::Verification("GitHub 未提供 Artifact digest，拒绝自动安装".to_owned())
        })?;
        validate_digest(&artifact_digest)?;
        Ok(ResolvedVersion {
            remote: self.action_version(run, artifact_digest),
        })
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
        if self.version_exists(&version.remote.commit)? {
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
        if version.remote.source == VersionSource::Release {
            let tag =
                version.remote.release_tag.as_deref().ok_or_else(|| {
                    UpdateError::Verification("Release 来源缺少版本标签".to_owned())
                })?;
            validate_release_build_identity(tag, &extracted.identity)?;
        }
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
            artifact: version.remote.artifact.clone(),
            artifact_digest: Some(version.remote.artifact_digest.clone()),
            upstream_repository: Some(extracted.identity.repository),
            upstream_commit: Some(extracted.identity.commit),
            patchset: Some(extracted.identity.patchset),
            build_revision: extracted.identity.build_revision,
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
        commit: &str,
        operations: &Operations,
        control: &ControlClient,
    ) -> Result<InstalledVersion, UpdateError> {
        if regular_file_exists(self.binary_path.as_ref())?
            && let Some(active) = self.active_commit().await?
        {
            self.adopt_active_version(&active).await?;
        }
        let versions_path = Arc::clone(&self.versions_path);
        let commit_owned = commit.to_owned();
        let (manifest, binary) = tokio::task::spawn_blocking(move || {
            load_verified_version(&versions_path, &commit_owned)
        })
        .await
        .map_err(|error| UpdateError::Install(error.to_string()))??;
        let previous = self.activate_binary(binary, operations, control).await?;
        if let Err(error) = self
            .database
            .set_setting(ACTIVE_COMMIT_KEY, commit.to_owned(), unix_timestamp())
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
        let active = commit.to_owned();
        match tokio::task::spawn_blocking(move || prune_versions(&versions_path, &active)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!(%error, "活动版本已切换，但清理旧版本失败"),
            Err(error) => tracing::warn!(%error, "活动版本已切换，但清理任务异常结束"),
        }
        Ok(manifest.into_installed(true))
    }

    async fn adopt_active_version(&self, commit: &str) -> Result<(), UpdateError> {
        validate_commit(commit)?;
        if self.version_exists(commit)? {
            return Ok(());
        }
        let binary_path = Arc::clone(&self.binary_path);
        let versions_path = Arc::clone(&self.versions_path);
        let commit = commit.to_owned();
        let artifact = self.artifact.to_string();
        tokio::task::spawn_blocking(move || {
            let binary = read_regular_file(&binary_path, "当前 KixDNS 二进制")?;
            validate_elf(&binary)?;
            let manifest = VersionManifest {
                schema_version: MANIFEST_SCHEMA_VERSION,
                source: None,
                source_id: None,
                commit,
                run_id: None,
                release_tag: None,
                created_at: None,
                source_url: None,
                artifact,
                artifact_digest: None,
                upstream_repository: None,
                upstream_commit: None,
                patchset: None,
                build_revision: None,
                control_protocol: None,
                binary_sha256: sha256(&binary),
                installed_at: unix_timestamp(),
            };
            store_version(&versions_path, &manifest, &binary)
        })
        .await
        .map_err(|error| UpdateError::Install(error.to_string()))?
    }

    fn version_exists(&self, commit: &str) -> Result<bool, UpdateError> {
        let path = version_path(self.versions_path.as_ref(), commit)?;
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(true),
            Ok(_) => Err(UpdateError::Install("版本目录类型无效".to_owned())),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(UpdateError::Install(error.to_string())),
        }
    }

    async fn installed_versions(
        &self,
        active_commit: Option<&str>,
    ) -> Result<Vec<InstalledVersion>, UpdateError> {
        let versions_path = Arc::clone(&self.versions_path);
        let active_commit = active_commit.map(str::to_owned);
        tokio::task::spawn_blocking(move || {
            list_installed(&versions_path, active_commit.as_deref())
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
            source_id: self.source_id.or(self.run_id),
            commit: self.commit,
            run_id: self.run_id,
            release_tag: self.release_tag,
            created_at: self.created_at,
            source_url: self.source_url,
            artifact: self.artifact,
            artifact_digest: self.artifact_digest,
            upstream_repository: self.upstream_repository,
            upstream_commit: self.upstream_commit,
            patchset: self.patchset,
            build_revision: self.build_revision,
            control_protocol: self.control_protocol,
            binary_sha256: self.binary_sha256,
            installed_at: self.installed_at,
            active,
        }
    }
}

fn to_update_info(version: ResolvedVersion, installed_commit: Option<String>) -> UpdateInfo {
    let available = installed_commit.as_deref() != Some(version.remote.commit.as_str());
    UpdateInfo {
        installed_commit,
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
    let target = version_path(versions_path, &manifest.commit)?;
    if target.exists() {
        load_verified_version(versions_path, &manifest.commit)?;
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
    commit: &str,
) -> Result<(VersionManifest, Vec<u8>), UpdateError> {
    let directory = version_path(versions_path, commit)?;
    let metadata = fs::symlink_metadata(&directory)
        .map_err(|_| UpdateError::Invalid("指定版本尚未安装".to_owned()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(UpdateError::Verification("版本目录类型无效".to_owned()));
    }
    let manifest_bytes = read_regular_file(&directory.join("manifest.json"), "版本清单")?;
    let manifest: VersionManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| UpdateError::Verification(format!("版本清单无效：{error}")))?;
    if !(1..=MANIFEST_SCHEMA_VERSION).contains(&manifest.schema_version)
        || manifest.commit != commit
    {
        return Err(UpdateError::Verification("版本清单身份不匹配".to_owned()));
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
    active_commit: Option<&str>,
) -> Result<Vec<InstalledVersion>, UpdateError> {
    let mut versions = Vec::new();
    for entry in
        fs::read_dir(versions_path).map_err(|error| UpdateError::Install(error.to_string()))?
    {
        let entry = entry.map_err(|error| UpdateError::Install(error.to_string()))?;
        let Some(commit) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if validate_commit(&commit).is_err() {
            continue;
        }
        match load_verified_version(versions_path, &commit) {
            Ok((manifest, _)) => {
                versions.push(manifest.into_installed(active_commit == Some(commit.as_str())));
            }
            Err(error) => tracing::warn!(commit, %error, "忽略损坏的本地 KixDNS 版本"),
        }
    }
    Ok(versions)
}

fn prune_versions(versions_path: &Path, active_commit: &str) -> Result<(), UpdateError> {
    let mut versions = list_installed(versions_path, Some(active_commit))?;
    versions.sort_by_key(|version| Reverse(version.installed_at));
    let keep = versions
        .iter()
        .take(MAX_INSTALLED_VERSIONS)
        .map(|version| version.commit.clone())
        .chain(std::iter::once(active_commit.to_owned()))
        .collect::<HashSet<_>>();
    for version in versions {
        if keep.contains(&version.commit) {
            continue;
        }
        let path = version_path(versions_path, &version.commit)?;
        let metadata =
            fs::symlink_metadata(&path).map_err(|error| UpdateError::Install(error.to_string()))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(UpdateError::Install("待清理版本目录类型无效".to_owned()));
        }
        fs::remove_dir_all(path).map_err(|error| UpdateError::Install(error.to_string()))?;
    }
    sync_directory(versions_path)
}

fn version_path(versions_path: &Path, commit: &str) -> Result<PathBuf, UpdateError> {
    validate_commit(commit)?;
    Ok(versions_path.join(commit.to_ascii_lowercase()))
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

fn is_release_download_url(url: &str, repository: &str, tag: &str, asset: &str) -> bool {
    url == format!("https://github.com/{repository}/releases/download/{tag}/{asset}")
}

fn validate_build_identity(identity: &BuildIdentity) -> Result<(), UpdateError> {
    validate_slug(&identity.repository, true)
        .map_err(|_| UpdateError::Verification("上游仓库身份无效".to_owned()))?;
    validate_commit(&identity.commit)
        .map_err(|_| UpdateError::Verification("上游提交身份无效".to_owned()))?;
    if identity.patchset == 0 {
        return Err(UpdateError::Verification("增强补丁集版本无效".to_owned()));
    }
    if identity.build_revision == Some(0) {
        return Err(UpdateError::Verification("构建修订版本无效".to_owned()));
    }
    if identity.control_protocol != CONTROL_PROTOCOL_VERSION {
        return Err(UpdateError::Verification(format!(
            "控制协议不兼容：需要 v{CONTROL_PROTOCOL_VERSION}，产物为 v{}",
            identity.control_protocol
        )));
    }
    Ok(())
}

fn validate_release_build_identity(tag: &str, identity: &BuildIdentity) -> Result<(), UpdateError> {
    let revision = identity
        .build_revision
        .ok_or_else(|| UpdateError::Verification("Release 产物缺少构建修订身份".to_owned()))?;
    let expected = format!(
        "kixdns-{}-p{}-r{}",
        &identity.commit[..12],
        identity.patchset,
        revision
    );
    if tag != expected {
        return Err(UpdateError::Verification(format!(
            "Release 标签与包内构建身份不匹配：期望 {expected}"
        )));
    }
    Ok(())
}

fn validate_manifest_source(manifest: &VersionManifest) -> Result<(), UpdateError> {
    match (
        manifest.source,
        manifest.source_id,
        manifest.run_id,
        manifest.release_tag.as_deref(),
    ) {
        (None, None, _, None) => Ok(()),
        (Some(VersionSource::Action), Some(source_id), Some(run_id), None)
            if source_id > 0 && source_id == run_id =>
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
        manifest.build_revision,
        manifest.control_protocol,
    ) {
        (None, None, None, None, None) => Ok(()),
        (
            Some(repository),
            Some(commit),
            Some(patchset),
            build_revision,
            Some(control_protocol),
        ) => validate_build_identity(&BuildIdentity {
            repository: repository.clone(),
            commit: commit.clone(),
            patchset,
            build_revision,
            control_protocol,
        }),
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
        BuildIdentity, MANIFEST_SCHEMA_VERSION, RemoteVersion, VersionManifest, VersionSource,
        extract_artifact, is_release_download_url, load_verified_version, sha256, store_version,
        validate_commit, validate_digest, validate_release_build_identity, validate_slug,
    };

    const TEST_BUILD_COMMIT: &str = "4e8002d08a56afc08be335d0d5ed337c7690f9af";

    const TEST_IDENTITY: &str = r#"{
        "repository":"olicesx/kixdns",
        "commit":"374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25",
        "patchset":5,
        "build_revision":1,
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
        assert!(is_release_download_url(
            "https://github.com/tuoro/kixdns-panel/releases/download/kixdns-374d63ccfdde-p5-r1/kixdns-enhanced-linux-x86_64.zip",
            "tuoro/kixdns-panel",
            "kixdns-374d63ccfdde-p5-r1",
            "kixdns-enhanced-linux-x86_64.zip",
        ));
        let identity = serde_json::from_str::<BuildIdentity>(TEST_IDENTITY).unwrap();
        assert!(validate_release_build_identity("kixdns-374d63ccfdde-p5-r1", &identity).is_ok());
        assert!(validate_release_build_identity("kixdns-374d63ccfdde-p5-r2", &identity).is_err());
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
            created_at: "2026-07-28T00:00:00Z".to_owned(),
            source_url: "https://github.com/example/actions/runs/42".to_owned(),
            artifact: "kixdns-enhanced-linux-x86_64".to_owned(),
            artifact_digest: artifact_digest.clone(),
            download_url: "https://nightly.link/example/actions/runs/42/artifact.zip".to_owned(),
            installed: false,
            active: false,
        };

        let serialized = serde_json::to_value(remote).unwrap();
        assert_eq!(serialized["artifact_digest"], artifact_digest);
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
            source_url: Some("https://github.com/example/actions/runs/42".to_owned()),
            artifact: "kixdns-enhanced-linux-x86_64".to_owned(),
            artifact_digest: Some(format!("sha256:{}", "a".repeat(64))),
            upstream_repository: Some("olicesx/kixdns".to_owned()),
            upstream_commit: Some(commit.to_owned()),
            patchset: Some(5),
            build_revision: Some(1),
            control_protocol: Some(1),
            binary_sha256: sha256(&binary),
            installed_at: 42,
        };
        store_version(directory.path(), &manifest, &binary).unwrap();
        let (loaded, loaded_binary) = load_verified_version(directory.path(), commit).unwrap();
        assert_eq!(loaded.commit, commit);
        assert_eq!(loaded_binary, binary);

        std::fs::write(directory.path().join(commit).join("kixdns"), b"tampered").unwrap();
        assert!(load_verified_version(directory.path(), commit).is_err());
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
            artifact: "kixdns-enhanced-linux-x86_64".to_owned(),
            artifact_digest: None,
            upstream_repository: None,
            upstream_commit: None,
            patchset: None,
            build_revision: None,
            control_protocol: None,
            binary_sha256: sha256(&binary),
            installed_at: 42,
        };

        store_version(directory.path(), &manifest, &binary).unwrap();
        let (loaded, _) = load_verified_version(directory.path(), commit).unwrap();
        assert_eq!(loaded.schema_version, 1);
        assert!(loaded.upstream_commit.is_none());
    }
}
