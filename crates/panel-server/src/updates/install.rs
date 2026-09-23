//! 下载、校验、安装与切换 `KixDNS` 版本，以及本地版本库存。
//! Downloading, verifying, installing and switching `KixDNS` versions, and the local inventory.

use super::ACTIVE_VERSION_KEY;
use super::ArtifactCapabilities;
use super::ArtifactSource;
use super::BuildIdentity;
use super::ExtractedArtifact;
use super::InstalledVersion;
use super::LEGACY_ACTIVE_COMMIT_KEY;
use super::MANIFEST_SCHEMA_VERSION;
use super::MAX_ARTIFACT_BYTES;
use super::MAX_BINARY_BYTES;
use super::MAX_BUILD_IDENTITY_BYTES;
use super::MAX_CAPABILITIES_BYTES;
use super::RemoteVersion;
use super::ResolvedVersion;
use super::ServiceHost;
use super::UpdateError;
use super::UpdateInfo;
use super::UpdateManager;
use super::VersionKey;
use super::VersionManifest;
use super::VersionSource;
use super::catalog::to_update_info;
use super::storage::delete_stored_version;
use super::storage::find_installed_key;
use super::storage::list_installed;
use super::storage::load_bundled_manifest;
use super::storage::load_verified_version;
use super::storage::locate_version_directory;
use super::storage::prune_versions;
use super::storage::read_regular_file;
use super::storage::regular_file_exists;
use super::storage::store_version;
use super::storage::update_stored_capabilities;
use super::validation::persist;
use super::validation::sha256;
use super::validation::sync_directory;
use super::validation::validate_build_identity;
use super::validation::validate_commit;
use super::validation::validate_elf;
use super::validation::validate_hex_digest;
use super::validation::validate_remote_build_identity;
use super::validation::write_executable;
use crate::auth::unix_timestamp;
use crate::config_capabilities::canonical_runtime_capabilities;
use crate::config_capabilities::ensure_config_supported;
use crate::config_capabilities::validate_declared_capabilities;
use crate::operations::ServiceAction;
use futures_util::StreamExt;
use secrecy::ExposeSecret;
use secrecy::SecretString;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::io::ErrorKind;
use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

/// 按顺序尝试的下载来源。Actions 产物即使在公开仓库也要登录才能下载，匿名只能走
/// nightly.link；配了 Token 时先直接从 GitHub 下载，Token 权限不够或下载失败再回退。
/// Download sources in the order they are tried. Actions artifacts need a login even in
/// a public repository, so anonymous downloads can only go through nightly.link. With a
/// token configured GitHub is tried first, falling back when the token lacks the
/// permission or the download fails.
pub(super) fn artifact_sources(
    repository: &str,
    version: &RemoteVersion,
    token: Option<&SecretString>,
) -> Vec<ArtifactSource> {
    let mut sources = Vec::new();
    if let Some(token) = token {
        sources.push(ArtifactSource {
            url: format!(
                "https://api.github.com/repos/{repository}/actions/artifacts/{}/zip",
                version.source_id
            ),
            token: Some(token.clone()),
            label: "GitHub",
        });
    }
    sources.push(ArtifactSource {
        url: version.download_url.clone(),
        token: None,
        label: "nightly.link",
    });
    sources
}

pub(super) fn extract_artifact(archive: &[u8]) -> Result<ExtractedArtifact, UpdateError> {
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
            "{name} 摘要不匹配：期望 {expected}，实际 {actual}"
        )));
    }
    Ok(bytes)
}

pub(super) fn read_optional_verified_zip_entry(
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

pub(super) fn read_zip_entry(
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

impl UpdateManager {
    pub async fn initialize_installed_version(&self) -> Result<(), UpdateError> {
        if let Some(active) = self.active_version().await? {
            self.adopt_active_version(&active).await?;
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

    pub async fn apply(
        &self,
        config: &Value,
        host: &dyn ServiceHost,
    ) -> Result<UpdateInfo, UpdateError> {
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
            self.activate_locked(&key, config, host).await?;
        }
        Ok(to_update_info(resolved, Some(&key)))
    }

    pub async fn install_version(
        &self,
        source: VersionSource,
        source_id: u64,
        config: &Value,
        host: &dyn ServiceHost,
    ) -> Result<InstalledVersion, UpdateError> {
        let _guard = self.apply_lock.lock().await;
        let resolved = self.resolve_remote(source, source_id).await?;
        let key = VersionKey::remote(&resolved.remote)?;
        self.install_resolved(&resolved, config).await?;
        self.activate_locked(&key, config, host).await
    }

    pub async fn activate_version(
        &self,
        source: VersionSource,
        version: &str,
        config: &Value,
        host: &dyn ServiceHost,
    ) -> Result<InstalledVersion, UpdateError> {
        let _guard = self.apply_lock.lock().await;
        let key = match version.parse::<u64>() {
            Ok(source_id) if source_id > 0 => self.installed_key(source, source_id).await?,
            _ => VersionKey::new(source, version)?,
        };
        self.activate_locked(&key, config, host).await
    }

    pub async fn delete_version(
        &self,
        source: VersionSource,
        version: &str,
    ) -> Result<InstalledVersion, UpdateError> {
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
                Some(source_id) => VersionKey::tracked(VersionSource::Action, source_id, commit),
                None => VersionKey::new(VersionSource::Action, commit),
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

    // API JSON 请求很小，20 秒总超时足够；4 MB 以上的产物在国内到 GitHub、nightly.link 的慢链路上
    // 常要几分钟，共用这个总超时会让低于约 200 KB/s 的安装必然失败。所以客户端只限定连接和
    // 两次收到数据之间的间隔，下载请求再单独给一个宽松的总时限。
    // API JSON is small and 20 s total is plenty, but a 4 MB+ artifact over a slow mainland-China link to
    // GitHub or nightly.link takes minutes; sharing that total made every install below ~200 KB/s fail.
    // The client therefore bounds only connecting and the gap between received data, and the download
    // request gets its own generous total limit.
    pub(super) const API_TIMEOUT: Duration = Duration::from_secs(20);

    pub(super) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

    pub(super) const READ_TIMEOUT: Duration = Duration::from_secs(30);

    pub(super) const DOWNLOAD_TIMEOUT: Duration = Duration::from_mins(5);

    pub(super) async fn fetch_artifact(
        client: &reqwest::Client,
        url: &str,
        token: Option<&SecretString>,
        timeout: Duration,
    ) -> Result<Vec<u8>, UpdateError> {
        // reqwest 把读超时和总超时都报成一句 "error decoding response body"，用户看不出是网太慢。
        // reqwest reports both read and total timeouts as "error decoding response body", which does
        // not tell the user the link was too slow.
        let network = |error: reqwest::Error| {
            if error.is_timeout() {
                UpdateError::Network(format!(
                    "下载 KixDNS 产物超时：网络过慢或连接中断，请检查到 GitHub 的网络后重试（{error}）"
                ))
            } else {
                UpdateError::Network(error.to_string())
            }
        };
        // 请求级时限覆盖客户端的 20 秒总超时，只作用于这次下载。
        // The per-request limit overrides the client's 20 s total, for this download only.
        let mut request = client.get(url).timeout(timeout);
        if let Some(token) = token {
            // GitHub 回应的是跳转到存储服务的地址；换了主机时 reqwest 会去掉认证头，Token 不会跟过去。
            // GitHub answers with a redirect to blob storage; reqwest drops the auth header when
            // the host changes, so the token never follows it.
            request = request.bearer_auth(token.expose_secret());
        }
        let response = request
            .send()
            .await
            .map_err(network)?
            .error_for_status()
            .map_err(network)?;
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
            let chunk = chunk.map_err(network)?;
            if bytes.len().saturating_add(chunk.len()) > MAX_ARTIFACT_BYTES {
                return Err(UpdateError::Verification(
                    "Artifact 超过 128 MiB".to_owned(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    pub(super) async fn download(&self, version: &ResolvedVersion) -> Result<Vec<u8>, UpdateError> {
        let token = self.github_token.read().await.clone();
        let sources = artifact_sources(&self.repository, &version.remote, token.as_ref());
        Self::fetch_first_verified(
            &self.client,
            &sources,
            &version.remote.artifact_digest,
            Self::DOWNLOAD_TIMEOUT,
        )
        .await
    }

    /// 依次尝试每个来源，返回第一个通过摘要校验的包；都失败时报最后一个来源的错误。
    /// Tries each source in turn and returns the first package that passes the digest
    /// check; when all fail, reports the last source's error.
    pub(super) async fn fetch_first_verified(
        client: &reqwest::Client,
        sources: &[ArtifactSource],
        digest: &str,
        timeout: Duration,
    ) -> Result<Vec<u8>, UpdateError> {
        let expected = digest
            .strip_prefix("sha256:")
            .ok_or_else(|| UpdateError::Verification("Artifact digest 格式无效".to_owned()))?;
        let mut last_error = None;
        for (index, source) in sources.iter().enumerate() {
            let result = Self::fetch_artifact(client, &source.url, source.token.as_ref(), timeout)
                .await
                .and_then(|bytes| {
                    let actual = sha256(&bytes);
                    if actual == expected {
                        Ok(bytes)
                    } else {
                        Err(UpdateError::Verification(format!(
                            "Artifact digest 不匹配：期望 {expected}，实际 {actual}"
                        )))
                    }
                });
            match result {
                Ok(bytes) => return Ok(bytes),
                Err(error) => {
                    if index + 1 < sources.len() {
                        tracing::warn!(%error, source = source.label, "内核包下载失败，改用下一个来源");
                    }
                    last_error = Some(error);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| UpdateError::Network("没有可用的下载来源".to_owned())))
    }

    pub(super) async fn install_resolved(
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
            dependency_revision: extracted.identity.dependency_revision,
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

    pub(super) async fn activate_locked(
        &self,
        key: &VersionKey,
        config: &Value,
        host: &dyn ServiceHost,
    ) -> Result<InstalledVersion, UpdateError> {
        if regular_file_exists(self.binary_path.as_ref())?
            && let Some(active) = self.active_version().await?
        {
            self.adopt_active_version(&active).await?;
            if let Err(error) = self.capture_active_capabilities(&active, host).await {
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
        let (previous, running) = self.activate_binary(binary, host).await?;
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

    pub(super) async fn adopt_active_version(&self, key: &VersionKey) -> Result<(), UpdateError> {
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
                if sha256(&binary) != sha256(&stored) {
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

    pub(super) async fn installed_versions(
        &self,
        active_version: Option<&VersionKey>,
    ) -> Result<Vec<InstalledVersion>, UpdateError> {
        let versions_path = Arc::clone(&self.versions_path);
        let active_version = active_version.cloned();
        tokio::task::spawn_blocking(move || list_installed(&versions_path, active_version.as_ref()))
            .await
            .map_err(|error| UpdateError::Install(error.to_string()))?
    }

    pub(super) async fn installed_key(
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

    pub(super) async fn activate_binary(
        &self,
        binary: Vec<u8>,
        host: &dyn ServiceHost,
    ) -> Result<(Option<Vec<u8>>, bool), UpdateError> {
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
            self.restore_previous(current.as_deref(), host, true)
                .await
                .map_err(|rollback| {
                    UpdateError::Install(format!("新版本启动失败：{error}；{rollback}"))
                })?;
            return Err(UpdateError::Install(format!(
                "新版本启动失败，已恢复原状态：{error}"
            )));
        }
        if let Err(error) = host.wait_until_healthy().await {
            self.restore_previous(current.as_deref(), host, true)
                .await
                .map_err(|rollback| UpdateError::Install(format!("{error}；{rollback}")))?;
            return Err(UpdateError::Install(format!("{error}；已恢复原状态")));
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
        host.service_action(ServiceAction::Restart)
            .await
            .map_err(|error| UpdateError::Install(format!("恢复旧版本后启动失败：{error}")))?;
        if previous.is_none() {
            return Ok(());
        }
        host.wait_until_healthy()
            .await
            .map_err(|error| UpdateError::Install(format!("恢复旧版本后健康检查失败：{error}")))?;
        Ok(())
    }
}
