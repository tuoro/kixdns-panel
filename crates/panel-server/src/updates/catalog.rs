//! 最新内核与更新提示：读 fork 的最新发布并对过发布清单，判断是否提示 `KixDNS` 与面板更新。
//! The latest kernel and update notices: the fork's latest release checked against its
//! manifest, and whether a `KixDNS` or panel update is offered.

use super::CachedLatest;
use super::CachedPanelUpdate;
use super::GithubRelease;
use super::InstalledVersion;
use super::KixdnsKernel;
use super::KixdnsUpdateNotice;
use super::MAX_ARTIFACT_BYTES;
use super::MAX_RELEASE_MANIFEST_BYTES;
use super::PANEL_CACHE_TTL;
use super::PANEL_REPOSITORY;
use super::PanelUpdateNotice;
use super::RELEASE_MANIFEST_NAME;
use super::REMOTE_CACHE_TTL;
use super::ReleaseManifest;
use super::RemoteVersion;
use super::UPSTREAM_REPOSITORY;
use super::UpdateError;
use super::UpdateManager;
use super::UpdateNotifications;
use super::VersionKey;
use super::VersionSource;
use super::storage::regular_file_exists;
use super::validation::kernel_architecture;
use super::validation::kernel_asset_name;
use super::validation::parse_kernel_version;
use super::validation::parse_panel_release_version;
use super::validation::validate_commit;
use super::validation::validate_digest;
use super::validation::validate_hex_digest;
use crate::config_capabilities::validate_declared_capabilities;
use std::time::Instant;

/// 核对 fork 最新发布和它的清单，得出本机架构要装的那个包。发布标签、清单、GitHub 记下的
/// 资源三方必须一致；下载地址按仓库和标签自己拼，不用 GitHub 给的。
/// Checks the fork's latest release against its manifest and yields this architecture's
/// package. The release tag, the manifest and the assets GitHub lists must all agree; the
/// download address is built from the repository and tag rather than taken from GitHub.
pub(super) fn remote_version(
    repository: &str,
    release: &GithubRelease,
    manifest: &ReleaseManifest,
) -> Result<RemoteVersion, UpdateError> {
    let invalid = |message: &str| UpdateError::Verification(message.to_owned());
    if release.draft || release.prerelease {
        return Err(invalid("最新发布还不是正式版本"));
    }
    let tag = release.tag_name.as_str();
    parse_kernel_version(tag)?;
    if manifest.schema_version != 1 {
        return Err(invalid("内核发布清单的格式不受支持"));
    }
    if manifest.repository != repository {
        return Err(invalid("内核发布清单的仓库身份无效"));
    }
    if manifest.version != tag {
        return Err(invalid("内核发布清单和发布标签对不上"));
    }
    validate_commit(&manifest.commit).map_err(|_| invalid("内核发布清单的提交无效"))?;
    if let Some(upstream) = manifest.upstream_commit.as_deref() {
        validate_commit(upstream).map_err(|_| invalid("内核发布清单的原版提交无效"))?;
    }
    if manifest.control_protocol != super::CONTROL_PROTOCOL_VERSION {
        return Err(UpdateError::Verification(format!(
            "控制协议不兼容：需要 v{}，这个内核是 v{}",
            super::CONTROL_PROTOCOL_VERSION,
            manifest.control_protocol
        )));
    }
    validate_declared_capabilities(&manifest.config_capabilities)
        .map_err(UpdateError::Verification)?;
    let architecture = kernel_architecture();
    let expected = manifest.assets.get(architecture).ok_or_else(|| {
        UpdateError::Verification(format!("这一版没有本机架构（{architecture}）的内核包"))
    })?;
    let name = kernel_asset_name(tag);
    if expected.name != name {
        return Err(invalid("内核发布清单里的包名和版本对不上"));
    }
    validate_hex_digest(&expected.sha256)?;
    if expected.size == 0 || expected.size > MAX_ARTIFACT_BYTES as u64 {
        return Err(invalid("内核发布清单里的包大小无效"));
    }
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == name)
        .ok_or_else(|| invalid("这一版缺少本机架构的内核包"))?;
    let digest = format!("sha256:{}", expected.sha256.to_ascii_lowercase());
    if asset.id == 0
        || asset.size != expected.size
        || asset
            .digest
            .as_deref()
            .is_some_and(|recorded| !recorded.eq_ignore_ascii_case(&digest))
    {
        return Err(invalid("GitHub 上的内核包和发布清单对不上"));
    }
    Ok(RemoteVersion {
        source: VersionSource::Fork,
        source_id: asset.id,
        commit: manifest.commit.to_ascii_lowercase(),
        release_tag: tag.to_owned(),
        upstream_commit: manifest
            .upstream_commit
            .as_deref()
            .map(str::to_ascii_lowercase),
        created_at: release.published_at.clone(),
        source_url: manifest
            .upstream_commit
            .as_deref()
            .map(|commit| upstream_commit_url(&commit.to_ascii_lowercase())),
        build_url: release_page_url(repository, tag),
        artifact: name.clone(),
        artifact_digest: digest,
        download_url: release_download_url(repository, tag, &name),
        control_protocol: manifest.control_protocol,
        config_capabilities: manifest.config_capabilities.clone(),
    })
}

pub(super) fn upstream_commit_url(commit: &str) -> String {
    format!("https://github.com/{UPSTREAM_REPOSITORY}/commit/{commit}")
}

pub(super) fn release_page_url(repository: &str, tag: &str) -> String {
    format!("https://github.com/{repository}/releases/tag/{tag}")
}

fn release_download_url(repository: &str, tag: &str, name: &str) -> String {
    format!("https://github.com/{repository}/releases/download/{tag}/{name}")
}

/// 只有更新的日期版本才算更新。旧轨道的内核（Action 构建、更早的 Release）已停止更新，
/// fork 的最新版本就是它们的更新。
/// Only a newer date version counts as an update. Kernels from the old tracks (Action
/// builds, earlier Releases) are no longer updated, so the fork's newest version is their
/// update.
pub(super) fn to_kixdns_update_notice(
    version: &RemoteVersion,
    active: Option<&VersionKey>,
    current: Option<&InstalledVersion>,
) -> KixdnsUpdateNotice {
    let available = active.is_some_and(|active| {
        if active.source != VersionSource::Fork {
            return true;
        }
        let installed = current
            .and_then(|current| current.release_tag.as_deref())
            .and_then(|tag| parse_kernel_version(tag).ok());
        match (parse_kernel_version(&version.release_tag), installed) {
            (Ok(latest), Some(installed)) => latest > installed,
            // 记录读不出来时只能按构建身份比较。
            // When the record cannot be read only the build identity can be compared.
            _ => {
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
        release_tag: version.release_tag.clone(),
        created_at: version.created_at.clone(),
        release_url: version.build_url.clone(),
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
        self.latest_cache.write().await.take();
        self.panel_cache.write().await.take();
    }

    pub async fn notifications(&self) -> UpdateNotifications {
        let (kixdns, panel) = tokio::join!(self.kixdns_update_notice(), self.panel_update_notice());
        let (kixdns, kixdns_error) = match kixdns {
            Ok(notice) => (Some(notice), None),
            Err(error) => {
                tracing::warn!(%error, "内核更新检查失败");
                (None, Some(error.reason()))
            }
        };
        let (panel, panel_error) = match panel {
            Ok(notice) => (Some(notice), None),
            Err(error) => {
                tracing::warn!(%error, "面板更新检查失败");
                (None, Some(error.reason()))
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
        Ok(to_kixdns_update_notice(
            &latest,
            active.as_ref(),
            current.as_ref(),
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
            Ok(version) => (Some(version), None),
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

    /// 最新内核，一分钟内复用上次的结果。
    /// The newest kernel, reusing the last answer for a minute.
    pub(super) async fn latest_remote(&self) -> Result<RemoteVersion, UpdateError> {
        if let Some(cached) = self.latest_cache.read().await.as_ref()
            && cached.loaded_at.elapsed() < REMOTE_CACHE_TTL
        {
            return Ok(cached.version.clone());
        }
        self.fetch_latest().await
    }

    /// 绕过缓存重新读 fork 的最新发布和它的清单，并把结果记进缓存。发布页的下载不算
    /// GitHub API 次数，所以一次检查只用一次 API。
    /// Reads the fork's latest release and its manifest again past the cache and caches
    /// the result. Release downloads do not count against the GitHub API limit, so a
    /// check spends one API call.
    pub(super) async fn fetch_latest(&self) -> Result<RemoteVersion, UpdateError> {
        let url = format!(
            "https://api.github.com/repos/{}/releases/latest",
            self.kernel_repository
        );
        let release = self
            .get_json_optional::<GithubRelease>(&url)
            .await?
            .ok_or_else(|| UpdateError::Network("内核仓库还没有发布版本".to_owned()))?;
        parse_kernel_version(&release.tag_name)?;
        if !release
            .assets
            .iter()
            .any(|asset| asset.name == RELEASE_MANIFEST_NAME)
        {
            return Err(UpdateError::Verification("这一版缺少发布清单".to_owned()));
        }
        let manifest_url = release_download_url(
            &self.kernel_repository,
            &release.tag_name,
            RELEASE_MANIFEST_NAME,
        );
        let bytes = Self::fetch_limited(
            &self.client,
            &manifest_url,
            MAX_RELEASE_MANIFEST_BYTES,
            Self::API_TIMEOUT,
        )
        .await?;
        let manifest: ReleaseManifest = serde_json::from_slice(&bytes)
            .map_err(|error| UpdateError::Verification(format!("内核发布清单无效：{error}")))?;
        let latest = remote_version(&self.kernel_repository, &release, &manifest)?;
        self.latest_cache.write().await.replace(CachedLatest {
            loaded_at: Instant::now(),
            version: latest.clone(),
        });
        Ok(latest)
    }
}
