//! 版本目录与更新提示：按上游先后排列远端版本，判断是否提示 `KixDNS` 与面板更新。
//! The version catalogue and update notices: remote versions in upstream order, and whether
//! a `KixDNS` or panel update is offered.

use super::BuildIdentity;
use super::CachedPanelUpdate;
use super::CachedRemoteVersions;
use super::GithubRelease;
use super::InstalledVersion;
use super::KixdnsUpdateNotice;
use super::MAX_BUILD_IDENTITY_BYTES;
use super::PANEL_CACHE_TTL;
use super::PANEL_REPOSITORY;
use super::PanelUpdateNotice;
use super::REMOTE_CACHE_TTL;
use super::REMOTE_VERSION_LIMIT;
use super::RemoteVersion;
use super::RepositoryFile;
use super::ResolvedVersion;
use super::TrackArtifact;
use super::TrackReference;
use super::UPSTREAM_REPOSITORY;
use super::UpdateError;
use super::UpdateInfo;
use super::UpdateManager;
use super::UpdateNotifications;
use super::VersionCatalog;
use super::VersionKey;
use super::VersionSource;
use super::WorkflowRun;
use super::storage::regular_file_exists;
use super::validation::parse_artifact_reference;
use super::validation::parse_panel_release_version;
use super::validation::validate_build_identity;
use super::validation::validate_commit;
use super::validation::validate_digest;
use super::validation::validate_remote_build_identity;
use std::cmp::Ordering;
use std::cmp::Reverse;
use std::collections::HashMap;
use std::collections::HashSet;
use std::time::Instant;

pub(super) fn to_update_info(version: ResolvedVersion, active: Option<&VersionKey>) -> UpdateInfo {
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

/// 上游先后：Action 按上游运行编号，Release 按版本号。Action 是 Release 的预览，越晚的
/// 运行越接近甚至超过当前 Release；我们什么时候重新打包不参与比较。
/// Upstream order: action runs by upstream run id, releases by version number. The
/// action track previews the next release, so a later run is closer to it or beyond it;
/// when we happened to repackage a version never takes part.
pub(super) fn upstream_order(
    run_id: Option<u64>,
    release_tag: Option<&str>,
) -> (Option<u64>, Option<semver::Version>, Option<&str>) {
    (
        run_id,
        release_tag
            .and_then(|tag| semver::Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()),
        release_tag,
    )
}

/// 最新的上游版本排最前；同一上游版本只剩最新一次构建，所以构建时间只在完全相同时兜底。
/// The newest upstream version comes first. Each upstream version keeps only its latest
/// build, so build time only breaks exact ties.
pub(super) fn sort_newest_upstream_first(versions: &mut [ResolvedVersion]) {
    versions.sort_by(|left, right| {
        let left_order = upstream_order(left.remote.run_id, left.remote.release_tag.as_deref());
        let right_order = upstream_order(right.remote.run_id, right.remote.release_tag.as_deref());
        right_order
            .cmp(&left_order)
            .then_with(|| right.build_run_id.cmp(&left.build_run_id))
    });
}

/// 只有更新的上游版本、或同一上游版本的更高补丁集才算更新；同一版本重新打包不算，
/// 更旧的上游版本也不会被当成更新。
/// Only a newer upstream version, or a higher patchset of the same upstream version,
/// counts as an update. Repackaging the same version does not, and an older upstream
/// version is never offered as one.
pub(super) fn is_newer_upstream_build(version: &RemoteVersion, current: &InstalledVersion) -> bool {
    let latest = upstream_order(version.run_id, version.release_tag.as_deref());
    let installed = upstream_order(current.run_id, current.release_tag.as_deref());
    match latest.cmp(&installed) {
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
    has_upstream_identity(current, version.source)
        && upstream_order(version.run_id, version.release_tag.as_deref())
            == upstream_order(current.run_id, current.release_tag.as_deref())
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

pub(super) fn has_upstream_identity(version: &InstalledVersion, source: VersionSource) -> bool {
    match source {
        VersionSource::Action => version.run_id.is_some(),
        VersionSource::Release => version.release_tag.is_some(),
    }
}

pub(super) fn to_kixdns_update_notice(
    version: &RemoteVersion,
    active: Option<&VersionKey>,
    current: Option<&InstalledVersion>,
    latest_revision: Option<u32>,
) -> KixdnsUpdateNotice {
    let current = current.filter(|current| has_upstream_identity(current, version.source));
    let security_update = active.is_some_and(|active| active.source == version.source)
        && current.is_some_and(|current| {
            is_dependency_security_update(version, current, latest_revision)
        });
    let available = security_update
        || active.is_some_and(|active| {
            if active.source != version.source {
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
        source: version.source,
        current_commit: active.map(|active| active.commit.clone()),
        latest_commit: Some(version.commit.clone()),
        source_id: Some(version.source_id),
        run_id: version.run_id,
        release_tag: version.release_tag.clone(),
        created_at: Some(version.created_at.clone()),
        build_url: Some(version.build_url.clone()),
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
        self.remote_cache.write().await.clear();
        self.panel_cache.write().await.take();
    }

    pub async fn notifications(&self) -> Result<UpdateNotifications, UpdateError> {
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
        let installed = self.installed_versions(active.as_ref()).await?;
        let current = installed.iter().find(|version| version.active);
        let latest_revision = match current {
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
        Ok(UpdateNotifications {
            kixdns: to_kixdns_update_notice(
                &latest.remote,
                active.as_ref(),
                current,
                latest_revision,
            ),
            panel: self.panel_update_notice().await?,
        })
    }

    pub async fn catalog(&self, source: VersionSource) -> Result<VersionCatalog, UpdateError> {
        let binary_present = regular_file_exists(self.binary_path.as_ref())?;
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
            active_source: active_version.as_ref().map(|version| version.source),
            active_commit: active_version.map(|version| version.commit),
            binary_present,
            remote_error,
            remote_versions,
            installed_versions,
        })
    }

    pub async fn check(&self) -> Result<UpdateInfo, UpdateError> {
        let active_version = self.active_version().await?;
        let resolved = self
            .resolved_remote_versions(VersionSource::Action)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| UpdateError::Network("没有可安装的成功增强构建".to_owned()))?;
        Ok(to_update_info(resolved, active_version.as_ref()))
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

    pub(super) async fn remote_versions(
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

    /// 读出一次构建实际使用的锁文件里的依赖修订：取构建提交上的版本目录文件，
    /// 它正是构建时的输入。包名里放不下修订号，这是唯一的来源。
    /// Reads the dependency revision from the lock a build actually used: the catalogue
    /// file at the build commit is exactly what the build consumed. The artifact name
    /// cannot carry the revision, so this is the only source.
    pub(super) async fn build_dependency_revision(
        &self,
        version: &RemoteVersion,
    ) -> Result<Option<u32>, UpdateError> {
        if let Some(revision) = self
            .dependency_revisions
            .read()
            .await
            .get(&version.source_id)
        {
            return Ok(*revision);
        }
        let path = match (
            version.source,
            version.run_id,
            version.release_tag.as_deref(),
        ) {
            (VersionSource::Action, Some(run_id), _) => format!("upstreams/actions/{run_id}.json"),
            (VersionSource::Release, _, Some(tag)) => format!("upstreams/releases/{tag}.json"),
            _ => return Ok(None),
        };
        validate_commit(&version.commit)?;
        let url = format!(
            "https://api.github.com/repos/{}/contents/{path}?ref={}",
            self.repository, version.commit
        );
        let revision = match self.get_json_optional::<RepositoryFile>(&url).await? {
            Some(file) => build_lock_revision(&file, version)?,
            None => None,
        };
        let mut cache = self.dependency_revisions.write().await;
        if cache.len() >= REMOTE_VERSION_LIMIT {
            cache.clear();
        }
        cache.insert(version.source_id, revision);
        Ok(revision)
    }

    pub(super) async fn resolved_remote_versions(
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

    pub(super) async fn fetch_track_versions(
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
        sort_newest_upstream_first(&mut versions);
        versions.truncate(30);
        Ok(versions)
    }

    pub(super) async fn resolve_remote(
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

    pub(super) fn track_version(
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
}
