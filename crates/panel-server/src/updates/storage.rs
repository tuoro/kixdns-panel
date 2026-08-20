use std::cmp::Reverse;
use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use tempfile::Builder;

use crate::auth::unix_timestamp;
use crate::config_capabilities::validate_declared_capabilities;

use super::validation::{
    constant_hash_eq, persist, sha256, sync_directory, validate_build_identity, validate_commit,
    validate_digest, validate_elf, validate_hex_digest, validate_manifest_build_identity,
    validate_manifest_source, validate_slug, write_executable, write_private_file,
};
use super::{
    ArtifactCapabilities, BuildIdentity, InstalledVersion, MANIFEST_SCHEMA_VERSION,
    MAX_BINARY_BYTES, MAX_BUILD_IDENTITY_BYTES, MAX_CAPABILITIES_BYTES, MAX_INSTALLED_VERSIONS,
    PANEL_REPOSITORY, SOURCE_MANIFEST_SCHEMA_VERSION, UPSTREAM_REPOSITORY, UpdateError, VersionKey,
    VersionManifest, VersionSource,
};

pub(super) fn store_version(
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

pub(super) fn load_bundled_manifest(
    metadata_path: &Path,
    key: &VersionKey,
    binary: &[u8],
) -> Result<VersionManifest, UpdateError> {
    if key.source != VersionSource::Action {
        return Err(UpdateError::Verification(
            "完整安装包只支持 Action 增强构建身份".to_owned(),
        ));
    }
    let source_id = key
        .source_id
        .ok_or_else(|| UpdateError::Verification("完整包缺少 Artifact ID".to_owned()))?;
    let build_commit = read_metadata_text(metadata_path, "KIXDNS_BUILD_COMMIT", 128)?;
    validate_commit(&build_commit)
        .map_err(|_| UpdateError::Verification("完整包构建提交无效".to_owned()))?;
    if !build_commit.eq_ignore_ascii_case(&key.commit) {
        return Err(UpdateError::Verification(
            "完整包构建提交与安装环境不一致".to_owned(),
        ));
    }
    let metadata_source_id = read_metadata_u64(metadata_path, "KIXDNS_ARTIFACT_ID")?;
    if metadata_source_id != source_id {
        return Err(UpdateError::Verification(
            "完整包 Artifact ID 与安装环境不一致".to_owned(),
        ));
    }
    let build_run_id = read_metadata_u64(metadata_path, "KIXDNS_SOURCE_RUN_ID")?;
    let artifact = read_metadata_text(metadata_path, "KIXDNS_ARTIFACT_NAME", 256)?;
    validate_slug(&artifact, false)
        .map_err(|_| UpdateError::Verification("完整包 Artifact 名称无效".to_owned()))?;
    let artifact_digest = read_metadata_text(metadata_path, "KIXDNS_ARTIFACT_DIGEST", 128)?;
    validate_digest(&artifact_digest)?;
    let declared_binary_digest = read_metadata_text(metadata_path, "KIXDNS_BINARY_SHA256", 128)?;
    validate_hex_digest(&declared_binary_digest)?;
    let binary_sha256 = sha256(binary);
    if !constant_hash_eq(&declared_binary_digest, &binary_sha256) {
        return Err(UpdateError::Verification(
            "当前 KixDNS 二进制与完整包身份不匹配".to_owned(),
        ));
    }
    let identity_bytes = read_metadata_file(
        metadata_path,
        "upstream.lock.json",
        MAX_BUILD_IDENTITY_BYTES,
    )?;
    let identity: BuildIdentity = serde_json::from_slice(&identity_bytes)
        .map_err(|error| UpdateError::Verification(format!("完整包上游身份无效：{error}")))?;
    validate_build_identity(&identity)?;
    if identity.source != VersionSource::Action {
        return Err(UpdateError::Verification(
            "完整包上游来源与 Action 轨道不一致".to_owned(),
        ));
    }
    let official_run_id = identity
        .official_run_id
        .ok_or_else(|| UpdateError::Verification("完整包缺少上游 Action Run ID".to_owned()))?;
    let capabilities_bytes = read_metadata_file(
        metadata_path,
        "KIXDNS_CAPABILITIES.json",
        MAX_CAPABILITIES_BYTES,
    )?;
    let capabilities: ArtifactCapabilities = serde_json::from_slice(&capabilities_bytes)
        .map_err(|error| UpdateError::Verification(format!("完整包配置能力无效：{error}")))?;
    if capabilities.schema_version != 1 {
        return Err(UpdateError::Verification(
            "完整包配置能力清单版本不受支持".to_owned(),
        ));
    }
    validate_declared_capabilities(&capabilities.config_capabilities)
        .map_err(UpdateError::Verification)?;
    validate_elf(binary)?;
    Ok(VersionManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        source: Some(VersionSource::Action),
        source_id: Some(source_id),
        commit: build_commit,
        run_id: Some(official_run_id),
        release_tag: None,
        created_at: None,
        source_url: Some(format!(
            "https://github.com/{UPSTREAM_REPOSITORY}/actions/runs/{official_run_id}"
        )),
        build_url: Some(format!(
            "https://github.com/{PANEL_REPOSITORY}/actions/runs/{build_run_id}"
        )),
        artifact,
        artifact_digest: Some(artifact_digest),
        upstream_repository: Some(identity.repository),
        upstream_commit: Some(identity.commit),
        patchset: Some(identity.patchset),
        control_protocol: Some(identity.control_protocol),
        config_capabilities: capabilities.config_capabilities,
        binary_sha256,
        installed_at: unix_timestamp(),
    })
}

fn read_metadata_file(directory: &Path, name: &str, limit: u64) -> Result<Vec<u8>, UpdateError> {
    let bytes = read_regular_file(&directory.join(name), name)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > limit {
        return Err(UpdateError::Verification(format!(
            "完整包元数据 {name} 超过大小限制"
        )));
    }
    Ok(bytes)
}

fn read_metadata_text(directory: &Path, name: &str, limit: u64) -> Result<String, UpdateError> {
    let bytes = read_metadata_file(directory, name, limit)?;
    let value = String::from_utf8(bytes)
        .map_err(|_| UpdateError::Verification(format!("完整包元数据 {name} 不是 UTF-8")))?;
    let value = value.trim();
    if value.is_empty() || value.lines().count() != 1 {
        return Err(UpdateError::Verification(format!(
            "完整包元数据 {name} 格式无效"
        )));
    }
    Ok(value.to_owned())
}

fn read_metadata_u64(directory: &Path, name: &str) -> Result<u64, UpdateError> {
    read_metadata_text(directory, name, 64)?
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| UpdateError::Verification(format!("完整包元数据 {name} 无效")))
}

pub(super) fn load_verified_version(
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

pub(super) fn update_stored_capabilities(
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

pub(super) fn list_installed(
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

pub(super) fn find_installed_key(
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

pub(super) fn prune_versions(
    versions_path: &Path,
    active_version: &VersionKey,
) -> Result<(), UpdateError> {
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

pub(super) fn delete_stored_version(
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

pub(super) fn locate_version_directory(
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

pub(super) fn ensure_directory(path: &Path) -> Result<(), UpdateError> {
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

pub(super) fn regular_file_exists(path: &Path) -> Result<bool, UpdateError> {
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

pub(super) fn read_regular_file(path: &Path, label: &str) -> Result<Vec<u8>, UpdateError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| UpdateError::Install(format!("读取{label}失败：{error}")))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(UpdateError::Verification(format!(
            "{label}必须是普通文件，不能是符号链接"
        )));
    }
    fs::read(path).map_err(|error| UpdateError::Install(format!("读取{label}失败：{error}")))
}
