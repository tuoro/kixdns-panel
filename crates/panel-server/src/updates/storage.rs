use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use tempfile::Builder;

use crate::auth::unix_timestamp;
use crate::config_capabilities::validate_declared_capabilities;

use super::catalog::{release_page_url, upstream_commit_url};
use super::install::{parse_capabilities, verify_kernel_source};
use super::validation::{
    kernel_asset_name, parse_kernel_version, persist, sha256, sync_directory,
    validate_build_identity, validate_commit, validate_digest, validate_elf, validate_hex_digest,
    validate_manifest_build_identity, validate_manifest_source, validate_slug, write_executable,
    write_private_file,
};
use super::{
    BuildIdentity, CONTROL_PROTOCOL_VERSION, InstalledVersion, KernelSource,
    MANIFEST_SCHEMA_VERSION, MAX_BINARY_BYTES, MAX_BUILD_IDENTITY_BYTES, MAX_CAPABILITIES_BYTES,
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
    if manifest.binary_sha256 != sha256(binary) {
        return Err(UpdateError::Verification(
            "版本清单里的二进制摘要对不上".to_owned(),
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

/// 完整安装包随带的内核身份。新安装包带的是 fork 发布版（`KIXDNS_SOURCE.json`）；只更新
/// 过面板的主机还留着旧安装包的 Action 构建身份（`upstream.lock.json`），两种都要认。
/// The kernel identity a full package brought along. New packages carry a fork release
/// (`KIXDNS_SOURCE.json`); hosts that only updated the panel still keep an old package's
/// Action build identity (`upstream.lock.json`), so both are recognised.
pub(super) fn load_bundled_manifest(
    metadata_path: &Path,
    repository: &str,
    key: &VersionKey,
    binary: &[u8],
) -> Result<VersionManifest, UpdateError> {
    match key.source {
        VersionSource::Fork => load_bundled_release(metadata_path, repository, key, binary),
        VersionSource::Action => load_bundled_action(metadata_path, key, binary),
        VersionSource::Release => Err(UpdateError::Verification(
            "完整安装包不会带 Release 内核".to_owned(),
        )),
    }
}

/// 两种完整包共有的几项：包编号、内核包名和摘要、二进制摘要都要和安装环境、当前二进制一致。
/// What both kinds of full package share: the package id, the package name and digest
/// and the binary digest must all match the install environment and the current binary.
struct BundledPackage {
    source_id: u64,
    commit: String,
    artifact: String,
    artifact_digest: String,
    binary_sha256: String,
    config_capabilities: Vec<String>,
}

fn read_bundled_package(
    metadata_path: &Path,
    key: &VersionKey,
    binary: &[u8],
) -> Result<BundledPackage, UpdateError> {
    let source_id = key
        .source_id
        .ok_or_else(|| UpdateError::Verification("完整包缺少内核包编号".to_owned()))?;
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
            "完整包里的内核包编号和安装环境不一致".to_owned(),
        ));
    }
    let artifact = read_metadata_text(metadata_path, "KIXDNS_ARTIFACT_NAME", 256)?;
    validate_slug(&artifact, false)
        .map_err(|_| UpdateError::Verification("完整包里的内核包名称无效".to_owned()))?;
    let artifact_digest = read_metadata_text(metadata_path, "KIXDNS_ARTIFACT_DIGEST", 128)?;
    validate_digest(&artifact_digest)?;
    let declared_binary_digest = read_metadata_text(metadata_path, "KIXDNS_BINARY_SHA256", 128)?;
    validate_hex_digest(&declared_binary_digest)?;
    let binary_sha256 = sha256(binary);
    if declared_binary_digest != binary_sha256 {
        return Err(UpdateError::Verification(
            "当前 KixDNS 二进制与完整包身份不匹配".to_owned(),
        ));
    }
    let capabilities = read_metadata_file(
        metadata_path,
        "KIXDNS_CAPABILITIES.json",
        MAX_CAPABILITIES_BYTES,
    )?;
    let config_capabilities = parse_capabilities(&capabilities).map_err(|error| {
        UpdateError::Verification(format!("完整包配置能力无效：{}", error.reason()))
    })?;
    validate_elf(binary)?;
    Ok(BundledPackage {
        source_id,
        commit: build_commit,
        artifact,
        artifact_digest,
        binary_sha256,
        config_capabilities,
    })
}

fn load_bundled_release(
    metadata_path: &Path,
    repository: &str,
    key: &VersionKey,
    binary: &[u8],
) -> Result<VersionManifest, UpdateError> {
    let package = read_bundled_package(metadata_path, key, binary)?;
    let source_bytes = read_metadata_file(
        metadata_path,
        "KIXDNS_SOURCE.json",
        MAX_BUILD_IDENTITY_BYTES,
    )?;
    let source: KernelSource = serde_json::from_slice(&source_bytes)
        .map_err(|error| UpdateError::Verification(format!("完整包内核来源无效：{error}")))?;
    if source.schema_version != 1 {
        return Err(UpdateError::Verification(
            "完整包内核来源的格式不受支持".to_owned(),
        ));
    }
    parse_kernel_version(&source.version)?;
    if let Some(upstream) = source.upstream_commit.as_deref() {
        validate_commit(upstream)
            .map_err(|_| UpdateError::Verification("完整包原版提交无效".to_owned()))?;
    }
    verify_kernel_source(
        &source,
        repository,
        &source.version,
        &package.commit,
        source.upstream_commit.as_deref(),
    )?;
    if package.artifact != kernel_asset_name(&source.version) {
        return Err(UpdateError::Verification(
            "完整包里的内核包名称和版本对不上".to_owned(),
        ));
    }
    let upstream_commit = source
        .upstream_commit
        .as_deref()
        .map(str::to_ascii_lowercase);
    Ok(VersionManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        source: Some(VersionSource::Fork),
        source_id: Some(package.source_id),
        commit: package.commit.to_ascii_lowercase(),
        run_id: None,
        release_tag: Some(source.version.clone()),
        created_at: None,
        source_url: upstream_commit.as_deref().map(upstream_commit_url),
        build_url: Some(release_page_url(repository, &source.version)),
        artifact: package.artifact,
        artifact_digest: Some(package.artifact_digest),
        upstream_repository: upstream_commit
            .as_ref()
            .map(|_| UPSTREAM_REPOSITORY.to_owned()),
        upstream_commit,
        patchset: None,
        dependency_revision: None,
        control_protocol: Some(CONTROL_PROTOCOL_VERSION),
        config_capabilities: package.config_capabilities,
        binary_sha256: package.binary_sha256,
        installed_at: unix_timestamp(),
    })
}

fn load_bundled_action(
    metadata_path: &Path,
    key: &VersionKey,
    binary: &[u8],
) -> Result<VersionManifest, UpdateError> {
    let package = read_bundled_package(metadata_path, key, binary)?;
    let build_run_id = read_metadata_u64(metadata_path, "KIXDNS_SOURCE_RUN_ID")?;
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
        .ok_or_else(|| UpdateError::Verification("完整包缺少原版构建编号".to_owned()))?;
    Ok(VersionManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        source: Some(VersionSource::Action),
        source_id: Some(package.source_id),
        commit: package.commit,
        run_id: Some(official_run_id),
        release_tag: None,
        created_at: None,
        source_url: Some(format!(
            "https://github.com/{UPSTREAM_REPOSITORY}/actions/runs/{official_run_id}"
        )),
        build_url: Some(format!(
            "https://github.com/{PANEL_REPOSITORY}/actions/runs/{build_run_id}"
        )),
        artifact: package.artifact,
        artifact_digest: Some(package.artifact_digest),
        upstream_repository: Some(identity.repository),
        upstream_commit: Some(identity.commit),
        patchset: Some(identity.patchset),
        dependency_revision: identity.dependency_revision,
        control_protocol: Some(identity.control_protocol),
        config_capabilities: package.config_capabilities,
        binary_sha256: package.binary_sha256,
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
    if manifest.binary_sha256 != actual {
        return Err(UpdateError::Verification(
            "本地版本的二进制摘要对不上".to_owned(),
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

/// 本机只留当前内核和上一个，其余的删掉。损坏的版本目录列不出来，这里也不碰。
/// Keeps only the current kernel and the previous one and removes the rest. Damaged
/// version directories are not listed, so they are left alone here.
pub(super) fn prune_versions(
    versions_path: &Path,
    active: &VersionKey,
    previous: Option<&VersionKey>,
) -> Result<(), UpdateError> {
    for version in list_installed(versions_path, Some(active))? {
        let key = VersionKey::installed(&version)?;
        if &key == active || previous == Some(&key) {
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

fn parse_version_directory(name: &str) -> Option<VersionKey> {
    if validate_commit(name).is_ok() {
        return VersionKey::new(VersionSource::Action, name).ok();
    }
    let (source, identity) = name.split_once('-')?;
    let source = VersionSource::parse(source)?;
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
    // 只有 Action 内核留下过只用提交命名的旧目录。
    // Only Action kernels left old directories named by commit alone.
    if key.source != VersionSource::Action {
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
