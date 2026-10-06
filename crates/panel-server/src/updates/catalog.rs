//! 最新内核与更新提示：在最近的成功构建里找出最新的上游版本，判断是否提示 `KixDNS` 与面板更新。
//! The latest kernel and update notices: the newest upstream version among recent successful
//! builds, and whether a `KixDNS` or panel update is offered.

use super::BuildIdentity;
use super::CachedLatest;
use super::CachedPanelUpdate;
use super::CachedRevision;
use super::GithubRelease;
use super::InstalledVersion;
use super::KixdnsKernel;
use super::KixdnsUpdateNotice;
use super::MAX_BUILD_IDENTITY_BYTES;
use super::PANEL_CACHE_TTL;
use super::PANEL_REPOSITORY;
use super::PanelUpdateNotice;
use super::REMOTE_CACHE_TTL;
use super::RemoteVersion;
use super::RepositoryFile;
use super::ResolvedVersion;
use super::TrackArtifact;
use super::UPSTREAM_REPOSITORY;
use super::UpdateError;
use super::UpdateManager;
use super::UpdateNotifications;
use super::VersionKey;
use super::VersionSource;
use super::WORKFLOW_RUN_WINDOW;
use super::WorkflowRun;
use super::storage::regular_file_exists;
use super::validation::parse_artifact_reference;
use super::validation::parse_panel_release_version;
use super::validation::validate_build_identity;
use super::validation::validate_commit;
use super::validation::validate_digest;
use super::validation::validate_remote_build_identity;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::time::Instant;

/// 最新的上游版本，同一上游版本取最新的一次构建。我们什么时候重新打包（续期、依赖刷新）
/// 不参与上游先后的比较，只在上游版本相同时挑出最新的那次。
/// The newest upstream version, and of its builds the latest. When we happened to
/// repackage (renewal, dependency refresh) never decides the upstream order; it only
/// picks the latest build of the same upstream version.
pub(super) fn newest_upstream_build(
    versions: impl IntoIterator<Item = ResolvedVersion>,
) -> Option<ResolvedVersion> {
    versions
        .into_iter()
        .max_by_key(|version| (version.remote.run_id, version.build_run_id))
}

/// 只有更新的上游版本、或同一上游版本的更高补丁集才算更新；同一版本重新打包不算，
/// 更旧的上游版本也不会被当成更新。
/// Only a newer upstream version, or a higher patchset of the same upstream version,
/// counts as an update. Repackaging the same version does not, and an older upstream
/// version is never offered as one.
pub(super) fn is_newer_upstream_build(version: &RemoteVersion, current: &InstalledVersion) -> bool {
    match Some(version.run_id).cmp(&current.run_id) {
        Ordering::Greater => true,
        Ordering::Equal => matches!(
            (version.patchset, current.patchset),
            (Some(latest), Some(installed)) if latest > installed
        ),
        Ordering::Less => false,
    }
}

/// 同一上游版本、同一补丁集，但不是同一个包：只有这种情况才需要去查依赖修订。
/// Same upstream version and patchset but a different package: the only case where the
/// dependency revision has to be looked up.
pub(super) fn same_version_rebuilt(version: &RemoteVersion, current: &InstalledVersion) -> bool {
    current.run_id == Some(version.run_id)
        && version.patchset.is_some()
        && version.patchset == current.patchset
        && version.artifact != current.artifact
}

/// 新构建的依赖修订高于已安装的，就是依赖安全升级。早期记录没有修订号，按 0 算；
/// 同一个包名意味着同一份构建输入，不会被误判。
/// A newer build with a higher dependency revision than the installed one is a
/// dependency security upgrade. Older records carry no revision and count as 0; an
/// identical package name means identical build inputs, so it is never misread.
pub(super) fn is_dependency_security_update(
    version: &RemoteVersion,
    current: &InstalledVersion,
    latest_revision: Option<u32>,
) -> bool {
    same_version_rebuilt(version, current)
        && latest_revision.is_some_and(|latest| latest > current.dependency_revision.unwrap_or(0))
}

pub(super) fn build_lock_revision(
    file: &RepositoryFile,
    version: &RemoteVersion,
) -> Result<Option<u32>, UpdateError> {
    use base64::Engine;

    if file.encoding != "base64" {
        return Err(UpdateError::Verification("构建锁文件编码无效".to_owned()));
    }
    let encoded = file
        .content
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect::<String>();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| UpdateError::Verification("构建锁文件编码无效".to_owned()))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_BUILD_IDENTITY_BYTES {
        return Err(UpdateError::Verification("构建锁文件过大".to_owned()));
    }
    let identity: BuildIdentity = serde_json::from_slice(&bytes)
        .map_err(|error| UpdateError::Verification(format!("构建锁文件无效：{error}")))?;
    validate_build_identity(&identity)?;
    validate_remote_build_identity(version, &identity)?;
    Ok(identity.dependency_revision)
}

pub(super) fn to_kixdns_update_notice(
    version: &RemoteVersion,
    active: Option<&VersionKey>,
    current: Option<&InstalledVersion>,
    latest_revision: Option<u32>,
) -> KixdnsUpdateNotice {
    // 记下了上游 Run 的才能按上游先后比较；Release 内核和早期安装都没有。
    // Only an install that recorded its upstream run can be compared in upstream order;
    // Release kernels and early installs did not.
    let current = current.filter(|current| current.run_id.is_some());
    let security_update = current
        .is_some_and(|current| is_dependency_security_update(version, current, latest_revision));
    let available = security_update
        || active.is_some_and(|active| {
            // Release 轨道已停止构建，最新的 Action 内核就是它的更新。
            // The Release track no longer builds, so the newest Action kernel is its update.
            if active.source != VersionSource::Action {
                return true;
            }
            match current {
                Some(current) => is_newer_upstream_build(version, current),
                // 早期安装没有记录上游身份，只能按构建身份比较。
                // Early installs recorded no upstream identity, so only the build identity
                // can be compared.
                None => {
                    !active.commit.eq_ignore_ascii_case(&version.commit)
                        || active.source_id != Some(version.source_id)
                }
            }
        });
    KixdnsUpdateNotice {
        available,
        current_commit: active.map(|active| active.commit.clone()),
        latest_commit: version.commit.clone(),
        source_id: version.source_id,
        run_id: version.run_id,
        created_at: version.created_at.clone(),
        build_url: version.build_url.clone(),
        security_update,
        dependency_revision: latest_revision.filter(|_| security_update),
    }
}

pub(super) fn to_panel_update_notice(
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

pub(super) fn panel_release_asset_name() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "kixdns-panel-linux-arm64.zip",
        _ => "kixdns-panel-linux-x86_64.zip",
    }
}

impl UpdateManager {
    pub(super) async fn clear_remote_caches(&self) {
        self.artifact_cache.write().await.take();
        self.latest_cache.write().await.take();
        self.panel_cache.write().await.take();
    }

    pub async fn notifications(&self) -> UpdateNotifications {
        let (kixdns, panel) = tokio::join!(self.kixdns_update_notice(), self.panel_update_notice());
        let (kixdns, kixdns_error) = match kixdns {
            Ok(notice) => (Some(notice), None),
            Err(error) => {
                tracing::warn!(%error, "内核更新检查失败");
                (None, Some(error.to_string()))
            }
        };
        let (panel, panel_error) = match panel {
            Ok(notice) => (Some(notice), None),
            Err(error) => {
                tracing::warn!(%error, "面板更新检查失败");
                (None, Some(error.to_string()))
            }
        };
        UpdateNotifications {
            kixdns,
            kixdns_error,
            panel,
            panel_error,
        }
    }

    async fn kixdns_update_notice(&self) -> Result<KixdnsUpdateNotice, UpdateError> {
        let latest = self.latest_remote().await?;
        let active = self.active_version().await?;
        let current = match active.as_ref() {
            Some(key) => self.installed_version(key, true).await.ok(),
            None => None,
        };
        let latest_revision = match current.as_ref() {
            Some(current) if same_version_rebuilt(&latest.remote, current) => {
                match self.build_dependency_revision(&latest.remote).await {
                    Ok(revision) => revision,
                    Err(error) => {
                        tracing::warn!(%error, "无法读取新构建的依赖修订");
                        None
                    }
                }
            }
            _ => None,
        };
        Ok(to_kixdns_update_notice(
            &latest.remote,
            active.as_ref(),
            current.as_ref(),
            latest_revision,
        ))
    }

    pub async fn kernel(&self) -> Result<KixdnsKernel, UpdateError> {
        let binary_present = regular_file_exists(self.binary_path.as_ref())?;
        let active_key = self.active_version().await?;
        let active = match active_key.as_ref() {
            Some(key) => {
                self.adopt_active_version(key).await?;
                Some(self.installed_version(key, true).await?)
            }
            None => None,
        };
        let previous = match self.previous_key(active_key.as_ref()).await {
            Some(key) => match self.installed_version(&key, false).await {
                Ok(version) => Some(version),
                Err(error) => {
                    tracing::warn!(%error, "上一个内核已不可用");
                    None
                }
            },
            None => None,
        };
        let (latest, remote_error) = match self.latest_remote().await {
            Ok(version) => (Some(version.remote), None),
            Err(error) => {
                tracing::warn!(%error, "最新内核暂不可读");
                (None, Some(error.to_string()))
            }
        };
        Ok(KixdnsKernel {
            binary_present,
            active,
            previous,
            latest,
            remote_error,
        })
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

    /// 读出一次构建实际使用的锁文件里的依赖修订：取构建提交上的版本目录文件，
    /// 它正是构建时的输入。包名里放不下修订号，这是唯一的来源。
    /// Reads the dependency revision from the lock a build actually used: the catalogue
    /// file at the build commit is exactly what the build consumed. The artifact name
    /// cannot carry the revision, so this is the only source.
    pub(super) async fn build_dependency_revision(
        &self,
        version: &RemoteVersion,
    ) -> Result<Option<u32>, UpdateError> {
        if let Some(cached) = *self.dependency_revision.read().await
            && cached.source_id == version.source_id
        {
            return Ok(cached.revision);
        }
        validate_commit(&version.commit)?;
        let url = format!(
            "https://api.github.com/repos/{}/contents/upstreams/actions/{}.json?ref={}",
            self.repository, version.run_id, version.commit
        );
        let revision = match self.get_json_optional::<RepositoryFile>(&url).await? {
            Some(file) => build_lock_revision(&file, version)?,
            None => None,
        };
        self.dependency_revision
            .write()
            .await
            .replace(CachedRevision {
                source_id: version.source_id,
                revision,
            });
        Ok(revision)
    }

    /// 最新内核，一分钟内复用上次的结果。
    /// The newest kernel, reusing the last answer for a minute.
    pub(super) async fn latest_remote(&self) -> Result<ResolvedVersion, UpdateError> {
        if let Some(cached) = self.latest_cache.read().await.as_ref()
            && cached.loaded_at.elapsed() < REMOTE_CACHE_TTL
        {
            return Ok(cached.version.clone());
        }
        self.fetch_latest().await
    }

    /// 绕过缓存重新找最新内核，并把结果记进缓存。
    /// Finds the newest kernel again past the cache and caches the result.
    pub(super) async fn fetch_latest(&self) -> Result<ResolvedVersion, UpdateError> {
        let runs = self.workflow_runs(WORKFLOW_RUN_WINDOW).await?;
        let artifacts = self.repository_artifacts().await?;
        let mut by_run = HashMap::<u64, Vec<TrackArtifact>>::new();
        for artifact in artifacts {
            if artifact.expired {
                continue;
            }
            let Some(parsed) = parse_artifact_reference(&self.artifact, &artifact.name) else {
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
                        official_run_id: parsed.official_run_id,
                        patchset: parsed.patchset,
                    });
            }
        }
        let mut candidates = Vec::new();
        for run in runs {
            for artifact in by_run.remove(&run.id).unwrap_or_default() {
                candidates.push(ResolvedVersion {
                    build_run_id: run.id,
                    remote: self.remote_version(&run, artifact),
                });
            }
        }
        let latest = newest_upstream_build(candidates)
            .ok_or_else(|| UpdateError::Network("没有可安装的成功增强构建".to_owned()))?;
        self.latest_cache.write().await.replace(CachedLatest {
            loaded_at: Instant::now(),
            version: latest.clone(),
        });
        Ok(latest)
    }

    pub(super) fn remote_version(
        &self,
        run: &WorkflowRun,
        artifact: TrackArtifact,
    ) -> RemoteVersion {
        let download_url = format!(
            "https://nightly.link/{}/actions/runs/{}/{}.zip",
            self.repository, run.id, artifact.name
        );
        let official_run_id = artifact.official_run_id;
        RemoteVersion {
            source: VersionSource::Action,
            source_id: artifact.source_id,
            commit: run.head_sha.clone(),
            run_id: official_run_id,
            patchset: artifact.patchset,
            created_at: run.created_at.clone(),
            source_url: format!(
                "https://github.com/{UPSTREAM_REPOSITORY}/actions/runs/{official_run_id}"
            ),
            build_url: run.html_url.clone(),
            artifact: artifact.name,
            artifact_digest: artifact.digest,
            download_url,
        }
    }
}
