#[cfg(unix)]
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use tempfile::{Builder, NamedTempFile};

use crate::control::ControlClient;
use crate::digest::sha256_hex;

use super::{
    BuildIdentity, CONTROL_PROTOCOL_VERSION, SOURCE_MANIFEST_SCHEMA_VERSION, UPSTREAM_REPOSITORY,
    UpdateError, VersionManifest, VersionSource,
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
        .ok_or_else(|| UpdateError::Verification("只接受 SHA-256 校验值".to_owned()))?;
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

/// fork 发布的日期版本：北京时间的日期 `YYYY.MM.DD`，同一天再发布时是 `YYYY.MM.DD.N`（N 从 2 起）。
/// 字段按年、月、日、当天第几次排列，比较就是逐段比数字，2026.10.13.10 比 2026.10.13.9 新。
/// A fork release's date version: the date in Beijing time `YYYY.MM.DD`, or `YYYY.MM.DD.N`
/// (N from 2) for a later release the same day. The fields run year, month, day, sequence,
/// so comparing compares each part as a number and 2026.10.13.10 is newer than 2026.10.13.9.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct KernelVersion {
    year: u16,
    month: u8,
    day: u8,
    sequence: u32,
}

pub(super) fn parse_kernel_version(tag: &str) -> Result<KernelVersion, UpdateError> {
    fn fixed(value: &str, width: usize) -> Option<u32> {
        (value.len() == width && value.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| value.parse().ok())
            .flatten()
    }
    let invalid = || UpdateError::Verification("内核版本号无效".to_owned());
    let mut parts = tag.split('.');
    let (Some(year), Some(month), Some(day)) = (parts.next(), parts.next(), parts.next()) else {
        return Err(invalid());
    };
    let sequence = match (parts.next(), parts.next()) {
        (None, None) => 1,
        // 当天第几次不补零：2026.10.13.02 不是这里发布的写法。
        // The sequence carries no leading zero: 2026.10.13.02 is not how releases are named.
        (Some(sequence), None)
            if !sequence.starts_with('0')
                && (1..=9).contains(&sequence.len())
                && sequence.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            sequence
                .parse::<u32>()
                .ok()
                .filter(|sequence| *sequence >= 2)
                .ok_or_else(invalid)?
        }
        _ => return Err(invalid()),
    };
    let year = fixed(year, 4).and_then(|year| u16::try_from(year).ok());
    let month = fixed(month, 2)
        .filter(|month| (1..=12).contains(month))
        .and_then(|month| u8::try_from(month).ok());
    let day = fixed(day, 2)
        .filter(|day| (1..=31).contains(day))
        .and_then(|day| u8::try_from(day).ok());
    match (year, month, day) {
        (Some(year), Some(month), Some(day)) => Ok(KernelVersion {
            year,
            month,
            day,
            sequence,
        }),
        _ => Err(invalid()),
    }
}

/// 本机架构在内核发布里的写法。 / This host's architecture as kernel releases write it.
pub(super) fn kernel_architecture() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        _ => "x86_64",
    }
}

/// 某个版本里本机架构的内核包文件名。
/// The file name of this architecture's kernel package in a given version.
pub(super) fn kernel_asset_name(version: &str) -> String {
    format!("kixdns-{version}-linux-{}.zip", kernel_architecture())
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
    if identity.dependency_revision == Some(0) {
        return Err(UpdateError::Verification("依赖修订编号无效".to_owned()));
    }
    if identity.control_protocol != CONTROL_PROTOCOL_VERSION {
        return Err(UpdateError::Verification(format!(
            "控制协议不兼容：需要 v{CONTROL_PROTOCOL_VERSION}，这个内核是 v{}",
            identity.control_protocol
        )));
    }
    // 带 upstream.lock.json 的只有旧的 Action 构建；Release 内核只会是以前装下的。
    // Only old Action builds carry upstream.lock.json; a Release kernel can only be one
    // installed earlier.
    if identity.source != VersionSource::Action
        || identity.official_run_id.is_none_or(|run_id| run_id == 0)
    {
        return Err(UpdateError::Verification(
            "包内上游来源不是有效的 Action 构建".to_owned(),
        ));
    }
    Ok(())
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
        (Some(VersionSource::Fork), Some(source_id), None, Some(tag)) if source_id > 0 => {
            parse_kernel_version(tag).map(|_| ())
        }
        _ => Err(UpdateError::Verification(
            "版本清单来源身份不完整".to_owned(),
        )),
    }
}

pub(super) fn validate_manifest_build_identity(
    manifest: &VersionManifest,
) -> Result<(), UpdateError> {
    if manifest.source == Some(VersionSource::Fork) {
        return validate_fork_manifest_identity(manifest);
    }
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

/// fork 发布没有补丁集和依赖修订；基于的原版提交（有的话）和控制协议照样核对。
/// A fork release has no patchset or dependency revision; the upstream commit it is based
/// on (when recorded) and the control protocol are still checked.
fn validate_fork_manifest_identity(manifest: &VersionManifest) -> Result<(), UpdateError> {
    if manifest.patchset.is_some() || manifest.dependency_revision.is_some() {
        return Err(UpdateError::Verification(
            "版本清单中的构建身份无效".to_owned(),
        ));
    }
    match (
        manifest.upstream_repository.as_deref(),
        manifest.upstream_commit.as_deref(),
    ) {
        (None, None) => {}
        (Some(repository), Some(commit)) => {
            if repository != UPSTREAM_REPOSITORY {
                return Err(UpdateError::Verification("上游仓库身份无效".to_owned()));
            }
            validate_commit(commit)
                .map_err(|_| UpdateError::Verification("上游提交身份无效".to_owned()))?;
        }
        _ => {
            return Err(UpdateError::Verification(
                "版本清单中的构建身份不完整".to_owned(),
            ));
        }
    }
    if manifest.control_protocol != Some(CONTROL_PROTOCOL_VERSION) {
        return Err(UpdateError::Verification(
            "版本清单中的控制协议无效".to_owned(),
        ));
    }
    Ok(())
}

pub(super) fn validate_hex_digest(value: &str) -> Result<(), UpdateError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(UpdateError::Verification(
            "SHA-256 校验值格式无效".to_owned(),
        ));
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
            Ok(Err(error)) => last_error = Some(health_cause(&error)),
            Err(_) => {
                last_error = Some("没有回应".to_owned());
                break;
            }
        }
        tokio::time::sleep(
            RETRY_INTERVAL.min(deadline.saturating_duration_since(tokio::time::Instant::now())),
        )
        .await;
    }
    let cause = last_error.unwrap_or_else(|| "没有回应".to_owned());
    Err(UpdateError::Install(format!(
        "没有在 {} 秒内启动起来（{cause}）",
        timeout.as_secs_f64()
    )))
}

// 健康检查失败的原因，一个短语：套接字不在就是已停止，其余照错误本身说 / Why the health check failed, in one phrase: a missing socket means stopped; anything else as the error says
fn health_cause(error: &crate::control::ControlError) -> String {
    match error {
        crate::control::ControlError::Unavailable(message)
            if message.contains("No such file")
                || message.contains("os error 2")
                || message.contains("找不到指定的文件") =>
        {
            "KixDNS 已停止".to_owned()
        }
        other => other.to_string(),
    }
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

        assert!(error.to_string().contains("秒内启动起来"));
        assert!(error.to_string().contains("KixDNS 已停止"));
    }
}
