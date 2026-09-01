#[cfg(unix)]
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use tempfile::{Builder, NamedTempFile};

use crate::control::ControlClient;
use crate::digest::sha256_hex;

use super::{
    BuildIdentity, CONTROL_PROTOCOL_VERSION, RemoteVersion, SOURCE_MANIFEST_SCHEMA_VERSION,
    TrackReference, UPSTREAM_REPOSITORY, UpdateError, VersionManifest, VersionSource,
};

pub(super) fn validate_slug(value: &str, repository: bool) -> Result<(), UpdateError> {
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

pub(super) fn validate_digest(digest: &str) -> Result<(), UpdateError> {
    let value = digest
        .strip_prefix("sha256:")
        .ok_or_else(|| UpdateError::Verification("只接受 SHA-256 Artifact digest".to_owned()))?;
    validate_hex_digest(value)
}

pub(super) fn validate_commit(commit: &str) -> Result<(), UpdateError> {
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

pub(super) fn parse_panel_release_version(tag: &str) -> Result<semver::Version, UpdateError> {
    validate_release_tag(tag)?;
    let version = tag
        .strip_prefix('v')
        .ok_or_else(|| UpdateError::Verification("面板 Release 标签必须使用 v 前缀".to_owned()))?;
    semver::Version::parse(version)
        .map_err(|error| UpdateError::Verification(format!("面板 Release 版本无效：{error}")))
}

pub(super) fn artifact_coordinates(artifact: &str) -> Result<(&str, &str), UpdateError> {
    let (prefix, architecture) = artifact
        .rsplit_once("-linux-")
        .ok_or_else(|| UpdateError::Invalid("Artifact 名称必须以 -linux-<架构> 结尾".to_owned()))?;
    if prefix.is_empty() || architecture.is_empty() {
        return Err(UpdateError::Invalid("Artifact 名称无效".to_owned()));
    }
    Ok((prefix, architecture))
}

pub(super) struct ParsedArtifactReference {
    pub(super) reference: TrackReference,
    pub(super) patchset: Option<u32>,
}

pub(super) fn parse_artifact_reference(
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

pub(super) fn validate_build_identity(identity: &BuildIdentity) -> Result<(), UpdateError> {
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

pub(super) fn validate_remote_build_identity(
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

pub(super) fn validate_manifest_source(manifest: &VersionManifest) -> Result<(), UpdateError> {
    match (
        manifest.source,
        manifest.source_id,
        manifest.run_id,
        manifest.release_tag.as_deref(),
    ) {
        (None, None, _, None) if manifest.schema_version < SOURCE_MANIFEST_SCHEMA_VERSION => Ok(()),
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

pub(super) fn validate_manifest_build_identity(
    manifest: &VersionManifest,
) -> Result<(), UpdateError> {
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

pub(super) fn validate_hex_digest(value: &str) -> Result<(), UpdateError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(UpdateError::Verification("SHA-256 摘要格式无效".to_owned()));
    }
    Ok(())
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}

pub(super) fn validate_elf(binary: &[u8]) -> Result<(), UpdateError> {
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

pub(super) fn write_executable(
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

pub(super) fn write_private_file(
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

pub(super) fn persist(temporary: NamedTempFile, path: &Path) -> Result<(), UpdateError> {
    temporary
        .persist(path)
        .map_err(|error| UpdateError::Install(error.error.to_string()))?;
    Ok(())
}

#[cfg_attr(not(unix), allow(clippy::unnecessary_wraps))]
pub(super) fn sync_directory(path: &Path) -> Result<(), UpdateError> {
    #[cfg(unix)]
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| UpdateError::Install(error.to_string()))?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub(super) async fn wait_until_healthy(control: &ControlClient) -> Result<(), UpdateError> {
    const TIMEOUT: Duration = Duration::from_secs(10);

    wait_until_healthy_for(control, TIMEOUT).await
}

async fn wait_until_healthy_for(
    control: &ControlClient,
    timeout: Duration,
) -> Result<(), UpdateError> {
    const RETRY_INTERVAL: Duration = Duration::from_millis(250);

    let deadline = tokio::time::Instant::now() + timeout;
    let mut last_error = None;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, control.health()).await {
            Ok(Ok(_)) => return Ok(()),
            Ok(Err(error)) => last_error = Some(error.to_string()),
            Err(_) => {
                last_error = Some("等待控制接口响应超时".to_owned());
                break;
            }
        }
        tokio::time::sleep(
            RETRY_INTERVAL.min(deadline.saturating_duration_since(tokio::time::Instant::now())),
        )
        .await;
    }
    let cause = last_error.unwrap_or_else(|| "控制接口没有返回健康状态".to_owned());
    Err(UpdateError::Install(format!(
        "KixDNS 在 {} 秒内未通过健康检查：{cause}",
        timeout.as_secs_f64()
    )))
}

#[cfg(not(unix))]
pub(super) fn ensure_update_platform() -> Result<(), UpdateError> {
    Err(UpdateError::Unsupported)
}

#[cfg(all(test, unix))]
mod tests {
    use std::time::Duration;

    use tempfile::tempdir;

    use super::wait_until_healthy_for;
    use crate::control::ControlClient;

    #[tokio::test]
    async fn health_timeout_preserves_the_control_error() {
        let directory = tempdir().unwrap();
        let control = ControlClient::new(directory.path().join("missing.sock"));

        let error = wait_until_healthy_for(&control, Duration::from_millis(10))
            .await
            .unwrap_err();

        assert!(error.to_string().contains("增强控制接口不可用"));
    }
}
