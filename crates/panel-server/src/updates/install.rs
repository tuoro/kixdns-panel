//! 下载、校验、安装与切换 `KixDNS` 版本，以及本地版本库存。
//! Downloading, verifying, installing and switching `KixDNS` versions, and the local inventory.

use super::ACTIVE_VERSION_KEY;
use super::ArtifactCapabilities;
use super::ExtractedArtifact;
use super::InstalledVersion;
use super::KernelSource;
use super::LEGACY_ACTIVE_COMMIT_KEY;
use super::LEGACY_REPLACED_KEY;
use super::MANIFEST_SCHEMA_VERSION;
use super::MAX_ARTIFACT_BYTES;
use super::MAX_BINARY_BYTES;
use super::MAX_BUILD_IDENTITY_BYTES;
use super::MAX_CAPABILITIES_BYTES;
use super::PREVIOUS_VERSION_KEY;
use super::RemoteVersion;
use super::ServiceHost;
use super::UPSTREAM_REPOSITORY;
use super::UpdateError;
use super::UpdateManager;
use super::VersionKey;
use super::VersionManifest;
use super::VersionSource;
use super::storage::bundled_binary_is_current;
use super::storage::list_installed;
use super::storage::load_bundled_manifest;
use super::storage::load_verified_version;
use super::storage::locate_version_directory;
use super::storage::prune_versions;
use super::storage::read_regular_file;
use super::storage::regular_file_exists;
use super::storage::store_version;
use super::storage::update_stored_capabilities;
use super::validation::kernel_architecture;
use super::validation::persist;
use super::validation::sha256;
use super::validation::sync_directory;
use super::validation::validate_elf;
use super::validation::validate_hex_digest;
use super::validation::write_executable;
use crate::auth::unix_timestamp;
use crate::config_capabilities::canonical_runtime_capabilities;
use crate::config_capabilities::ensure_config_supported;
use crate::config_capabilities::validate_declared_capabilities;
use crate::operations::ServiceAction;
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::io::ErrorKind;
use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

/// 解开 fork 发布的内核包：根目录下 `SHA256SUMS` 列出的 kixdns、`KIXDNS_SOURCE.json` 和
/// `KIXDNS_CAPABILITIES.json` 逐个核对摘要。包是谁、哪一版，由调用方拿 `KIXDNS_SOURCE.json`
/// 和发布清单对照。
/// Unpacks a fork release's kernel package: kixdns, `KIXDNS_SOURCE.json` and
/// `KIXDNS_CAPABILITIES.json` at the root are each checked against `SHA256SUMS`. Which
/// package and version it is gets settled by the caller, against the release manifest.
pub(super) fn extract_artifact(archive: &[u8]) -> Result<ExtractedArtifact, UpdateError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(archive))
        .map_err(|error| UpdateError::Verification(format!("不是有效的 ZIP 文件：{error}")))?;
    let checksums = read_zip_entry(&mut archive, "SHA256SUMS", 64 * 1024)?;
    let checksums = String::from_utf8(checksums)
        .map_err(|_| UpdateError::Verification("SHA256SUMS 不是 UTF-8".to_owned()))?;
    let checksums = parse_checksums(&checksums)?;
    let binary = read_verified_zip_entry(&mut archive, &checksums, "kixdns", MAX_BINARY_BYTES)?;
    let source = read_verified_zip_entry(
        &mut archive,
        &checksums,
        "KIXDNS_SOURCE.json",
        MAX_BUILD_IDENTITY_BYTES,
    )?;
    let source: KernelSource = serde_json::from_slice(&source)
        .map_err(|error| UpdateError::Verification(format!("内核来源说明无效：{error}")))?;
    if source.schema_version != 1 {
        return Err(UpdateError::Verification(
            "内核来源说明的格式不受支持".to_owned(),
        ));
    }
    let capabilities = read_verified_zip_entry(
        &mut archive,
        &checksums,
        "KIXDNS_CAPABILITIES.json",
        MAX_CAPABILITIES_BYTES,
    )?;
    let config_capabilities = parse_capabilities(&capabilities)?;
    Ok(ExtractedArtifact {
        binary,
        source,
        config_capabilities,
    })
}

/// 内核包和完整包里的 `KIXDNS_CAPABILITIES.json`。
/// `KIXDNS_CAPABILITIES.json` in a kernel package or a full package.
pub(super) fn parse_capabilities(content: &[u8]) -> Result<Vec<String>, UpdateError> {
    let manifest: ArtifactCapabilities = serde_json::from_slice(content)
        .map_err(|error| UpdateError::Verification(format!("配置能力清单无效：{error}")))?;
    if manifest.schema_version != 1 {
        return Err(UpdateError::Verification(
            "配置能力清单版本不受支持".to_owned(),
        ));
    }
    validate_declared_capabilities(&manifest.config_capabilities)
        .map_err(UpdateError::Verification)?;
    Ok(manifest.config_capabilities)
}

/// 包里的 `KIXDNS_SOURCE.json` 必须正是发布清单说的那一版：同一仓库、版本、提交、原版提交，
/// 本机架构，控制协议也一致。
/// The package's `KIXDNS_SOURCE.json` must be exactly the version the release manifest
/// names: same repository, version, commit and upstream commit, this architecture, and
/// the same control protocol.
pub(super) fn verify_kernel_source(
    source: &KernelSource,
    repository: &str,
    version: &str,
    commit: &str,
    upstream_commit: Option<&str>,
) -> Result<(), UpdateError> {
    let matches = source.repository == repository
        && source.version == version
        && source.commit.eq_ignore_ascii_case(commit)
        && match (source.upstream_commit.as_deref(), upstream_commit) {
            (Some(packaged), Some(expected)) => packaged.eq_ignore_ascii_case(expected),
            (None, None) => true,
            _ => false,
        }
        && source.arch == kernel_architecture();
    if !matches {
        return Err(UpdateError::Verification(
            "内核包的来源说明和发布清单对不上".to_owned(),
        ));
    }
    if source.control_protocol != super::CONTROL_PROTOCOL_VERSION {
        return Err(UpdateError::Verification(format!(
            "控制协议不兼容：需要 v{}，这个内核是 v{}",
            super::CONTROL_PROTOCOL_VERSION,
            source.control_protocol
        )));
    }
    Ok(())
}

pub(super) fn parse_checksums(checksums: &str) -> Result<HashMap<String, String>, UpdateError> {
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

pub(super) fn read_verified_zip_entry(
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
    if expected != &actual {
        return Err(UpdateError::Verification(format!(
            "{name} 的校验值对不上（应为 {}…，实际 {}…）",
            short_digest(expected),
            short_digest(&actual)
        )));
    }
    Ok(bytes)
}

pub(super) fn read_zip_entry(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    name: &str,
    limit: u64,
) -> Result<Vec<u8>, UpdateError> {
    // zip 9 起文件名逐个解码，可能失败；解不开的文件名说明包有问题，和其他校验一样直接拒绝
    // Since zip 9, names are decoded one by one and can fail; an undecodable name means a broken
    // package, refused like any other failed check
    let mut found = 0usize;
    for entry in archive.file_names() {
        let entry = entry
            .map_err(|error| UpdateError::Verification(format!("包里的文件名无效：{error}")))?;
        if entry == name {
            found += 1;
        }
    }
    if found != 1 {
        return Err(UpdateError::Verification(format!(
            "包里的 {name} 缺失或重复"
        )));
    }
    let file = archive
        .by_name(name)
        .map_err(|_| UpdateError::Verification(format!("包里缺少 {name}")))?;
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

impl UpdateManager {
    /// 启动时把正在运行的内核记进本机库存，然后只留它和上一个。旧面板最多留过 8 个版本，
    /// 也没记过上一个，这时把装得最晚的另一个当作上一个。清理失败不影响启动。
    /// At start-up, record the running kernel in the local inventory and keep only it and
    /// the previous one. Older panels kept up to eight versions and never recorded a
    /// previous one; the most recently installed other version then becomes it. A failed
    /// clean-up does not stop the start.
    pub async fn initialize_installed_version(&self) -> Result<(), UpdateError> {
        let Some(active) = self.active_version().await? else {
            return Ok(());
        };
        self.adopt_active_version(&active).await?;
        let recorded = self.previous_key(Some(&active)).await;
        let versions_path = Arc::clone(&self.versions_path);
        let worker_recorded = recorded.clone();
        let settled = tokio::task::spawn_blocking(move || {
            // 按清单里的身份认版本，和清理时一致；目录名在旧布局下可能少了 Artifact ID。
            // Versions are identified by their manifests, as pruning does; under the old
            // layout a directory name may lack the artifact id.
            let others = list_installed(&versions_path, None)?
                .into_iter()
                .filter_map(|version| {
                    let key = VersionKey::installed(&version).ok()?;
                    (key != active).then_some((key, version.installed_at))
                })
                .collect::<Vec<_>>();
            let previous = worker_recorded
                .filter(|recorded| others.iter().any(|(key, _)| key == recorded))
                .or_else(|| {
                    others
                        .iter()
                        .max_by_key(|(_, installed_at)| *installed_at)
                        .map(|(key, _)| key.clone())
                });
            prune_versions(&versions_path, &active, previous.as_ref())?;
            Ok::<_, UpdateError>(previous)
        })
        .await
        .map_err(|error| UpdateError::Install(error.to_string()))?;
        let previous = match settled {
            Ok(previous) => previous,
            Err(error) => {
                tracing::warn!(%error, "清理本机内核版本失败");
                return Ok(());
            }
        };
        if previous == recorded {
            return Ok(());
        }
        let result = match previous {
            Some(previous) => {
                self.database
                    .set_setting(PREVIOUS_VERSION_KEY, previous.encoded(), unix_timestamp())
                    .await
            }
            None => self.database.delete_setting(PREVIOUS_VERSION_KEY).await,
        };
        if let Err(error) = result {
            tracing::warn!(%error, "记录上一个内核失败");
        }
        Ok(())
    }

    /// 返回本地活动版本声明的配置能力，供 `KixDNS` 停止时的编辑器继续识别字段。
    pub async fn active_capabilities(&self) -> Result<Vec<String>, UpdateError> {
        let Some(key) = self.active_version().await? else {
            return Ok(Vec::new());
        };
        let versions_path = Arc::clone(&self.versions_path);
        let binary_path = Arc::clone(&self.binary_path);
        let bundled_metadata = Arc::clone(&self.bundled_metadata);
        let repository = Arc::clone(&self.kernel_repository);
        let initial = self.initial_version_key()?;
        tokio::task::spawn_blocking(move || {
            let (manifest, _) = match load_verified_version(&versions_path, &key) {
                Ok(version) => version,
                Err(_) if initial.as_ref() == Some(&key) && key.source_id.is_some() => {
                    // 首次安装时版本目录可能尚未建立，仍以已校验的完整包清单为准。
                    let binary = read_regular_file(&binary_path, "当前 KixDNS 二进制")?;
                    (
                        load_bundled_manifest(&bundled_metadata, &repository, &key, &binary)?,
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

    /// 更新到最新内核。`expected` 是页面上显示的那个包：之后又发布了更新的版本就拒绝，
    /// 确认框里写的版本就是装上的版本。启动时自动替换旧轨道内核不经过页面，不传。
    /// Updates to the newest kernel. `expected` is the package the page showed: if a newer
    /// version has been released since, the update is refused, so the version named in the
    /// confirmation is the one installed. The start-up replacement of an old-track kernel
    /// has no page and passes none.
    pub async fn update(
        &self,
        expected: Option<u64>,
        config: &Value,
        host: &dyn ServiceHost,
    ) -> Result<InstalledVersion, UpdateError> {
        let _guard = self.apply_lock.lock().await;
        let latest = self.fetch_latest().await?;
        self.update_locked(&latest, expected, config, host).await
    }

    pub(super) async fn update_locked(
        &self,
        latest: &RemoteVersion,
        expected: Option<u64>,
        config: &Value,
        host: &dyn ServiceHost,
    ) -> Result<InstalledVersion, UpdateError> {
        if expected.is_some_and(|expected| expected != latest.source_id) {
            return Err(UpdateError::Conflict(
                "没有更新内核：又发布了更新的版本，点「检查更新」看过后再更新".to_owned(),
            ));
        }
        let key = VersionKey::remote(latest)?;
        if self.active_version().await?.as_ref() == Some(&key) {
            return self.installed_version(&key, true).await;
        }
        self.install_resolved(latest, config).await?;
        self.activate_locked(&key, config, host).await
    }

    /// 回到上一个内核。切换成功后原来的内核成了上一个，再回退一次就换回来。
    /// Goes back to the previous kernel. Once switched, the kernel it replaced becomes the
    /// previous one, so rolling back again switches back.
    pub async fn rollback(
        &self,
        config: &Value,
        host: &dyn ServiceHost,
    ) -> Result<InstalledVersion, UpdateError> {
        let _guard = self.apply_lock.lock().await;
        let active = self.active_version().await?;
        let previous = self
            .previous_key(active.as_ref())
            .await
            .ok_or_else(|| UpdateError::Conflict("本机没有上一个内核".to_owned()))?;
        self.activate_locked(&previous, config, host).await
    }

    /// 正在运行旧轨道的内核（Action 构建或更早的 Release）、而且它们从没被换下过时返回它。
    /// 旧轨道已停止更新，新面板启动时把它换成 fork 的最新版本；换下后用户又自己回退到
    /// 旧内核的，不再替换。
    /// Returns the running kernel when it comes from an old track (an Action build or an
    /// earlier Release) and none was ever replaced. The old tracks are no longer updated,
    /// so a new panel replaces it with the fork's newest version at start-up; a user who
    /// rolls back to an old kernel afterwards is left alone.
    pub async fn legacy_kernel_to_replace(&self) -> Result<Option<InstalledVersion>, UpdateError> {
        let Some(active) = self.active_version().await? else {
            return Ok(None);
        };
        if active.source == VersionSource::Fork {
            return Ok(None);
        }
        let replaced = self
            .database
            .get_setting(LEGACY_REPLACED_KEY)
            .await
            .map_err(|error| UpdateError::Install(error.to_string()))?;
        if replaced.is_some() {
            return Ok(None);
        }
        self.installed_version(&active, true).await.map(Some)
    }

    /// 记下的上一个内核；没有记录、记录无效或正好是当前内核时为空。
    /// The recorded previous kernel; none when nothing is recorded, the record is invalid
    /// or it is the current kernel.
    pub(super) async fn previous_key(&self, active: Option<&VersionKey>) -> Option<VersionKey> {
        let stored = match self.database.get_setting(PREVIOUS_VERSION_KEY).await {
            Ok(stored) => stored?,
            Err(error) => {
                tracing::warn!(%error, "读取上一个内核记录失败");
                return None;
            }
        };
        match VersionKey::parse(&stored) {
            Ok(key) if active != Some(&key) => Some(key),
            Ok(_) => None,
            Err(error) => {
                tracing::warn!(%error, "上一个内核的记录无效");
                None
            }
        }
    }

    pub(super) async fn installed_version(
        &self,
        key: &VersionKey,
        active: bool,
    ) -> Result<InstalledVersion, UpdateError> {
        let versions_path = Arc::clone(&self.versions_path);
        let key = key.clone();
        tokio::task::spawn_blocking(move || {
            load_verified_version(&versions_path, &key)
                .map(|(manifest, _)| manifest.into_installed(active))
        })
        .await
        .map_err(|error| UpdateError::Install(error.to_string()))?
    }

    pub(super) async fn active_version(&self) -> Result<Option<VersionKey>, UpdateError> {
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

    pub(super) fn initial_version_key(&self) -> Result<Option<VersionKey>, UpdateError> {
        self.initial_commit
            .as_deref()
            .map(|commit| match self.initial_source_id {
                Some(source_id) => VersionKey::tracked(self.initial_source, source_id, commit),
                None => VersionKey::new(self.initial_source, commit),
            })
            .transpose()
    }

    pub(super) async fn bundled_binary_matches(
        &self,
        key: &VersionKey,
    ) -> Result<bool, UpdateError> {
        if key.source_id.is_none() {
            return Ok(false);
        }
        let binary_path = Arc::clone(&self.binary_path);
        let metadata_path = Arc::clone(&self.bundled_metadata);
        let repository = Arc::clone(&self.kernel_repository);
        let key = key.clone();
        tokio::task::spawn_blocking(move || {
            let binary = read_regular_file(&binary_path, "当前 KixDNS 二进制")?;
            // 换过内核以后二进制本来就不是包里那个：照实说「不是」，不记警告（以前每次查看内核都记两条）
            // After a kernel update the binary is simply not the package's: say no without a warning (each kernel check used to log two)
            if !bundled_binary_is_current(&metadata_path, &binary) {
                return Ok(false);
            }
            match load_bundled_manifest(&metadata_path, &repository, &key, &binary) {
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

    pub(super) async fn stored_binary_matches(
        &self,
        key: &VersionKey,
    ) -> Result<bool, UpdateError> {
        let binary_path = Arc::clone(&self.binary_path);
        let versions_path = Arc::clone(&self.versions_path);
        let key = key.clone();
        tokio::task::spawn_blocking(move || {
            let current = read_regular_file(&binary_path, "当前 KixDNS 二进制")?;
            match load_verified_version(&versions_path, &key) {
                Ok((_, stored)) => Ok(sha256(&current) == sha256(&stored)),
                Err(UpdateError::Invalid(_)) => Ok(false),
                Err(error) => Err(error),
            }
        })
        .await
        .map_err(|error| UpdateError::Install(error.to_string()))?
    }

    // API JSON 请求很小，20 秒总超时足够；4 MB 以上的内核包在国内到 GitHub 的慢链路上
    // 常要几分钟，共用这个总超时会让低于约 200 KB/s 的安装必然失败。所以客户端只限定连接和
    // 两次收到数据之间的间隔，下载请求再单独给一个宽松的总时限。
    // API JSON is small and 20 s total is plenty, but a 4 MB+ kernel package over a slow
    // mainland-China link to GitHub takes minutes; sharing that total made every install
    // below ~200 KB/s fail. The client therefore bounds only connecting and the gap between
    // received data, and the download request gets its own generous total limit.
    pub(super) const API_TIMEOUT: Duration = Duration::from_secs(20);

    pub(super) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

    pub(super) const READ_TIMEOUT: Duration = Duration::from_secs(30);

    pub(super) const DOWNLOAD_TIMEOUT: Duration = Duration::from_mins(5);

    /// 下载一个发布文件，超过 `limit` 字节就放弃。发布页的文件是公开的，不带 Token；
    /// GitHub 回应跳转到存储服务，reqwest 跟过去。
    /// Downloads one release file, giving up past `limit` bytes. Release files are public,
    /// so no token is sent; GitHub answers with a redirect to storage, which reqwest follows.
    pub(super) async fn fetch_limited(
        client: &reqwest::Client,
        url: &str,
        limit: usize,
        timeout: Duration,
    ) -> Result<Vec<u8>, UpdateError> {
        // reqwest 把读超时和总超时都报成一句 "error decoding response body"，用户看不出是网太慢。
        // reqwest reports both read and total timeouts as "error decoding response body", which does
        // not tell the user the link was too slow.
        let network = |error: reqwest::Error| {
            if error.is_timeout() {
                UpdateError::Network(format!(
                    "下载 KixDNS 内核超时：网络太慢或连接断了，检查到 GitHub 的网络后再试（{error}）"
                ))
            } else {
                UpdateError::Network(error.to_string())
            }
        };
        let too_large = || UpdateError::Verification(format!("超过 {}", format_size(limit)));
        // 请求级时限覆盖客户端的 20 秒总超时，只作用于这次下载。
        // The per-request limit overrides the client's 20 s total, for this download only.
        let response = client
            .get(url)
            .timeout(timeout)
            .send()
            .await
            .map_err(network)?
            .error_for_status()
            .map_err(network)?;
        if response
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            return Err(too_large());
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(network)?;
            if bytes.len().saturating_add(chunk.len()) > limit {
                return Err(too_large());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    /// 下载内核包并和发布清单里的 SHA-256 对照。
    /// Downloads a kernel package and checks it against the release manifest's SHA-256.
    pub(super) async fn download_verified(
        client: &reqwest::Client,
        url: &str,
        digest: &str,
        timeout: Duration,
    ) -> Result<Vec<u8>, UpdateError> {
        let expected = digest
            .strip_prefix("sha256:")
            .ok_or_else(|| UpdateError::Verification("校验值格式无效".to_owned()))?;
        let bytes = Self::fetch_limited(client, url, MAX_ARTIFACT_BYTES, timeout).await?;
        let actual = sha256(&bytes);
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(UpdateError::Verification(format!(
                "下载的包和发布的校验值对不上（应为 {}…，实际 {}…）",
                short_digest(expected),
                short_digest(&actual)
            )));
        }
        Ok(bytes)
    }

    pub(super) async fn install_resolved(
        &self,
        version: &RemoteVersion,
        config: &Value,
    ) -> Result<(), UpdateError> {
        let key = VersionKey::remote(version)?;
        if self.version_exists(&key)? {
            return Ok(());
        }
        // 发布清单已经说了这一版认哪些配置字段：当前配置用不了就不必下载。
        // The release manifest already says which config fields this version knows: when
        // the current config cannot run on it there is no point downloading.
        ensure_config_supported(config, &version.config_capabilities)
            .map_err(|error| UpdateError::IncompatibleConfig(error.to_string()))?;
        let archive = Self::download_verified(
            &self.client,
            &version.download_url,
            &version.artifact_digest,
            Self::DOWNLOAD_TIMEOUT,
        )
        .await?;
        let extracted = tokio::task::spawn_blocking(move || extract_artifact(&archive))
            .await
            .map_err(|error| UpdateError::Verification(error.to_string()))??;
        verify_kernel_source(
            &extracted.source,
            &self.kernel_repository,
            &version.release_tag,
            &version.commit,
            version.upstream_commit.as_deref(),
        )?;
        if extracted.config_capabilities != version.config_capabilities {
            return Err(UpdateError::Verification(
                "内核包的配置能力和发布清单对不上".to_owned(),
            ));
        }
        ensure_config_supported(config, &extracted.config_capabilities)
            .map_err(|error| UpdateError::IncompatibleConfig(error.to_string()))?;
        validate_elf(&extracted.binary)?;
        let manifest = VersionManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            source: Some(VersionSource::Fork),
            source_id: Some(version.source_id),
            commit: version.commit.clone(),
            run_id: None,
            release_tag: Some(version.release_tag.clone()),
            created_at: version.created_at.clone(),
            source_url: version.source_url.clone(),
            build_url: Some(version.build_url.clone()),
            artifact: version.artifact.clone(),
            artifact_digest: Some(version.artifact_digest.clone()),
            upstream_repository: version
                .upstream_commit
                .as_ref()
                .map(|_| UPSTREAM_REPOSITORY.to_owned()),
            upstream_commit: version.upstream_commit.clone(),
            patchset: None,
            dependency_revision: None,
            control_protocol: Some(version.control_protocol),
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

    pub(super) async fn activate_locked(
        &self,
        key: &VersionKey,
        config: &Value,
        host: &dyn ServiceHost,
    ) -> Result<InstalledVersion, UpdateError> {
        let replaced = self.active_version().await?;
        if let Some(active) = replaced.as_ref() {
            self.adopt_active_version(active).await?;
            if let Err(error) = self.capture_active_capabilities(active, host).await {
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
        // 失败的说法用构建号称呼两边：回退时目标比当前旧，说「新内核」「原来的内核」会把方向说反
        // Failures name both sides by build: on a rollback the target is older than the current one, and 新内核 / 原来的内核 would read backwards
        let target_name = manifest.clone().into_installed(false).label();
        let current_name = match replaced.as_ref() {
            Some(active) => self
                .installed_version(active, true)
                .await
                .map_or_else(|_| "原来的内核".to_owned(), |version| version.label()),
            None => "原来的内核".to_owned(),
        };
        let names = SwitchNames {
            target: &target_name,
            current: &current_name,
        };
        let (previous, running) = self.activate_binary(binary, host, names).await?;
        if let Err(error) = self
            .database
            .set_setting(ACTIVE_VERSION_KEY, key.encoded(), unix_timestamp())
            .await
        {
            if let Err(rollback) = self
                .restore_previous(previous.as_deref(), host, running)
                .await
            {
                return Err(UpdateError::Install(format!(
                    "记录活动版本失败：{error}；换回{} 也没成功：{}",
                    after_cjk(&current_name),
                    rollback.reason()
                )));
            }
            return Err(UpdateError::Install(format!(
                "记录活动版本失败，已恢复原版本：{error}"
            )));
        }
        let previous = match replaced.filter(|replaced| replaced != key) {
            Some(replaced) => {
                self.remember_replaced(&replaced, key).await;
                Some(replaced)
            }
            None => self.previous_key(Some(key)).await,
        };
        let versions_path = Arc::clone(&self.versions_path);
        let active = key.clone();
        match tokio::task::spawn_blocking(move || {
            prune_versions(&versions_path, &active, previous.as_ref())
        })
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!(%error, "活动版本已切换，但清理旧版本失败"),
            Err(error) => tracing::warn!(%error, "活动版本已切换，但清理任务异常结束"),
        }
        Ok(manifest.into_installed(true))
    }

    /// 切换成功后记下被换下的内核，它成了上一个；旧轨道的内核被 fork 发布版换下时另记一笔。
    /// 写不进去只影响回退目标，切换本身已经完成，不撤销。
    /// After a successful switch, record the replaced kernel as the previous one, and note
    /// when an old-track kernel gave way to a fork release. A failed write only affects the
    /// rollback target; the switch itself is done and stays.
    async fn remember_replaced(&self, replaced: &VersionKey, active: &VersionKey) {
        let now = unix_timestamp();
        if let Err(error) = self
            .database
            .set_setting(PREVIOUS_VERSION_KEY, replaced.encoded(), now)
            .await
        {
            tracing::warn!(%error, "内核已切换，但没能记下上一个内核");
        }
        if replaced.source != VersionSource::Fork
            && active.source == VersionSource::Fork
            && let Err(error) = self
                .database
                .set_setting(LEGACY_REPLACED_KEY, now.to_string(), now)
                .await
        {
            tracing::warn!(%error, "内核已切换，但没能记下旧内核已被替换");
        }
    }

    pub(super) async fn adopt_active_version(&self, key: &VersionKey) -> Result<(), UpdateError> {
        let binary_path = Arc::clone(&self.binary_path);
        let versions_path = Arc::clone(&self.versions_path);
        let bundled_metadata = Arc::clone(&self.bundled_metadata);
        let repository = Arc::clone(&self.kernel_repository);
        let initial = self.initial_version_key()?;
        let key = key.clone();
        let worker_key = key.clone();
        tokio::task::spawn_blocking(move || {
            let binary = read_regular_file(&binary_path, "当前 KixDNS 二进制")?;
            validate_elf(&binary)?;
            if let Ok((_, stored)) = load_verified_version(&versions_path, &worker_key) {
                if sha256(&binary) != sha256(&stored) {
                    return Err(UpdateError::Verification(
                        "活动版本记录与当前 KixDNS 二进制不一致".to_owned(),
                    ));
                }
                return Ok(());
            }
            let manifest =
                if initial.as_ref() == Some(&worker_key) && worker_key.source_id.is_some() {
                    load_bundled_manifest(&bundled_metadata, &repository, &worker_key, &binary)?
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
                        artifact: legacy_artifact_name().to_owned(),
                        artifact_digest: None,
                        upstream_repository: None,
                        upstream_commit: None,
                        patchset: None,
                        dependency_revision: None,
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

    pub(super) async fn capture_active_capabilities(
        &self,
        key: &VersionKey,
        host: &dyn ServiceHost,
    ) -> Result<(), UpdateError> {
        let capabilities = canonical_runtime_capabilities(&host.runtime_capabilities().await?);
        let versions_path = Arc::clone(&self.versions_path);
        let key = key.clone();
        tokio::task::spawn_blocking(move || {
            update_stored_capabilities(&versions_path, &key, capabilities)
        })
        .await
        .map_err(|error| UpdateError::Install(error.to_string()))?
    }

    pub(super) fn version_exists(&self, key: &VersionKey) -> Result<bool, UpdateError> {
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

    pub(super) async fn activate_binary(
        &self,
        binary: Vec<u8>,
        host: &dyn ServiceHost,
        names: SwitchNames<'_>,
    ) -> Result<(Option<Vec<u8>>, bool), UpdateError> {
        let SwitchNames {
            target: target_name,
            current: current_name,
        } = names;
        let back = after_cjk(current_name);
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
        // 先读状态再动文件：切换保持服务原来的启停，而 helper 的 start/stop
        // 会顺带 enable/disable。运行中只发一次 restart（不改开机策略，停机
        // 窗口也最短）；没运行就只换程序，下次启动时生效，不让 DNS 意外开始
        // 监听 53 端口（原版 Ubuntu 上这个端口可能还被 systemd-resolved 占着）。
        // Read the state before touching files: a switch keeps the service's
        // running state, and the helper's start/stop also enable/disable. A
        // running service gets one restart (enablement kept, shortest outage);
        // a stopped one only gets the new binary, effective at next start, so
        // DNS never starts listening on port 53 unexpectedly (on stock Ubuntu
        // systemd-resolved may still hold that port).
        let running = host.service_running().await?;
        let candidate = write_executable(parent, ".kixdns-candidate-", &binary)?;
        // 旧进程运行时 rename 替换文件是安全的：进程持有的是旧 inode。
        // Renaming over the file while the old process runs is safe: the
        // process holds the old inode.
        persist(candidate, target)?;
        if !running {
            sync_directory(parent)?;
            return Ok((current, false));
        }
        if let Err(error) = host.service_action(ServiceAction::Restart).await {
            let (cause, hint) = split_hint(&error.reason());
            let reason = format!("{target_name} 没能启动：{cause}");
            self.restore_previous(current.as_deref(), host, true)
                .await
                .map_err(|rollback| {
                    UpdateError::Install(both_failed(&reason, &back, &cause, &rollback.reason()))
                })?;
            return Err(UpdateError::Install(format!(
                "{reason}，已换回{back}{hint}"
            )));
        }
        if let Err(error) = host.wait_until_healthy().await {
            // 只要里面那句（「没有在 5 秒内启动起来（…）」），主语在这里加上，不带「安装更新失败：」前缀，读起来是一句话
            // Only the inner phrase (没有在 5 秒内启动起来（…）) with the subject added here and without the 安装更新失败： prefix, so it reads as one sentence
            let cause = error.reason();
            let reason = format!("{target_name} {cause}");
            self.restore_previous(current.as_deref(), host, true)
                .await
                .map_err(|rollback| {
                    UpdateError::Install(both_failed(&reason, &back, &cause, &rollback.reason()))
                })?;
            return Err(UpdateError::Install(format!("{reason}，已换回{back}")));
        }
        sync_directory(parent)?;
        Ok((current, true))
    }

    /// 放回旧程序；只有切换前服务在运行时才重启，恢复的同样是原来的启停状态。
    /// Put the previous binary back; restart only when the service was running
    /// before the switch, so the restored state is the original one as well.
    pub(super) async fn restore_previous(
        &self,
        previous: Option<&[u8]>,
        host: &dyn ServiceHost,
        running: bool,
    ) -> Result<(), UpdateError> {
        let target = self.binary_path.as_ref();
        let parent = target
            .parent()
            .ok_or_else(|| UpdateError::Install("目标二进制缺少父目录".to_owned()))?;
        match previous {
            Some(previous) => {
                let temporary = write_executable(parent, ".kixdns-rollback-", previous)?;
                persist(temporary, target)?;
            }
            None => match fs::remove_file(target) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(UpdateError::Install(error.to_string())),
            },
        }
        sync_directory(parent)?;
        if !running {
            return Ok(());
        }
        // 没有旧程序时也重启一次：unit 的 ConditionFileIsExecutable 不再满足，
        // 服务随之停下，而不是把没通过检查的新版本留在运行。
        // Restart even without a previous binary: the unit's
        // ConditionFileIsExecutable no longer holds, so the service stops
        // instead of leaving the failed new version running.
        // 失败的原因不带主语：调用的地方知道换回的是哪个构建 / Failure reasons carry no subject: the caller knows which build it went back to
        host.service_action(ServiceAction::Restart)
            .await
            .map_err(|error| UpdateError::Install(error.reason()))?;
        if previous.is_none() {
            return Ok(());
        }
        host.wait_until_healthy()
            .await
            .map_err(|error| UpdateError::Install(error.reason()))?;
        Ok(())
    }
}

/// 切换失败时怎么称呼两边：要换上的和原来的内核（日期版本、构建 #N、Release 标签） / How a failed switch names both sides: the kernel going in and the one it replaces (a date version, 构建 #N, a Release tag)
#[derive(Clone, Copy)]
pub(super) struct SwitchNames<'a> {
    pub(super) target: &'a str,
    pub(super) current: &'a str,
}

/// 两边都没起来：先说新的为什么没起来，再说换回去也没起来；原因相同就不说第二遍，括号不套括号。最后一步在系统页上就能做
/// Neither came up: why the new one failed, then that switching back failed too; the same cause is not repeated and parentheses never nest.
/// The last step can be taken right on the system page
fn both_failed(reason: &str, back: &str, cause: &str, rollback: &str) -> String {
    let (rollback, hint) = split_hint(rollback);
    let again = if rollback == cause {
        String::new()
    } else {
        format!("：{rollback}")
    };
    // systemd 拒绝重启时要过一会儿才肯再启动：说「过一会儿」，看原因的命令放在最后
    // When systemd refused the restart it only starts again after a while: say so, and put the command for the cause last
    format!(
        "{reason}；换回{back} 也没有启动起来{again}。KixDNS 现在停着，过一会儿再点「启动」{hint}"
    )
}

// 服务助手的失败句子拆成原因和看原因的命令（命令总放在最后），并去掉它自带的「KixDNS 没能重启：」主语，免得和这里的主语说两遍
// Splits a helper failure sentence into the cause and the command to see why (the command always goes last), and drops its own
// 「KixDNS 没能重启：」 subject so it is not said twice beside the subject here
fn split_hint(message: &str) -> (String, String) {
    let (cause, hint) = match message.find("。查看原因：") {
        Some(at) => (&message[..at], &message[at..]),
        None => (message, ""),
    };
    let cause = [
        "KixDNS 没能重启：",
        "KixDNS 没能启动：",
        "KixDNS 没能停止：",
    ]
    .iter()
    .find_map(|subject| cause.strip_prefix(subject))
    .unwrap_or(cause);
    (cause.to_owned(), hint.to_owned())
}

/// 接在汉字后面：日期版本、Release 标签这类以字母数字开头的名字前空一格（「换回 2026.10.13」），「构建 #N」紧接（「换回构建 #N」）
/// After Chinese text: a name starting with a Latin letter or digit, such as a date version or a Release tag, takes a space (换回 2026.10.13); 构建 #N follows directly (换回构建 #N)
pub(super) fn after_cjk(name: &str) -> String {
    if name.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        format!(" {name}")
    } else {
        name.to_owned()
    }
}

/// 校验值只给前 12 位：整串 64 位在手机上要占五六行，前 12 位已经够对照 / Only the first 12 characters of a digest: all 64 take five or six lines on a phone, and 12 are enough to compare
fn short_digest(digest: &str) -> &str {
    digest.get(..12).unwrap_or(digest)
}

/// 早期安装没有记下内核包名，补记录时用当时的默认包名。
/// Early installs recorded no package name; the default name of the time fills the record.
fn legacy_artifact_name() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "kixdns-enhanced-linux-arm64",
        _ => "kixdns-enhanced-linux-x86_64",
    }
}

/// 大小上限的说法：整 MiB 写 MiB，否则写 KiB。
/// How a size limit reads: whole MiB as MiB, otherwise KiB.
fn format_size(bytes: usize) -> String {
    const MIB: usize = 1024 * 1024;
    if bytes.is_multiple_of(MIB) {
        format!("{}\u{a0}MiB", bytes / MIB)
    } else {
        format!("{}\u{a0}KiB", bytes / 1024)
    }
}
