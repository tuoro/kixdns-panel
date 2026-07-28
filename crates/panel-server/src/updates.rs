use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::{Builder, NamedTempFile};
use tokio::sync::Mutex;

use crate::auth::unix_timestamp;
use crate::control::ControlClient;
use crate::db::Database;
use crate::operations::Operations;
use crate::operations::ServiceAction;

const INSTALLED_COMMIT_KEY: &str = "installed_panel_commit";
const MAX_ARTIFACT_BYTES: usize = 128 * 1024 * 1024;
const MAX_BINARY_BYTES: u64 = 96 * 1024 * 1024;

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
    apply_lock: Arc<Mutex<()>>,
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

#[derive(Debug, Deserialize)]
struct WorkflowRuns {
    workflow_runs: Vec<WorkflowRun>,
}

#[derive(Debug, Deserialize)]
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
    pub fn new(
        database: Database,
        repository: String,
        workflow: String,
        branch: String,
        artifact: String,
        installed_commit: Option<String>,
        binary_path: PathBuf,
    ) -> Result<Self, UpdateError> {
        validate_slug(&repository, true)?;
        validate_slug(&workflow, false)?;
        validate_slug(&branch, false)?;
        validate_slug(&artifact, false)?;
        if let Some(commit) = installed_commit.as_deref() {
            validate_commit(commit)?;
        }
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
            apply_lock: Arc::new(Mutex::new(())),
        })
    }

    pub async fn check(&self) -> Result<UpdateInfo, UpdateError> {
        let installed_commit = self
            .database
            .get_setting(INSTALLED_COMMIT_KEY)
            .await
            .map_err(|error| UpdateError::Install(error.to_string()))?
            .or_else(|| self.initial_commit.as_deref().map(str::to_owned));
        let runs_url = format!(
            "https://api.github.com/repos/{}/actions/workflows/{}/runs?branch={}&status=success&per_page=1",
            self.repository, self.workflow, self.branch
        );
        let runs = self.get_json::<WorkflowRuns>(&runs_url).await?;
        let run = runs
            .workflow_runs
            .into_iter()
            .next()
            .ok_or_else(|| UpdateError::Network("没有成功的增强构建".to_owned()))?;
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
            .ok_or_else(|| UpdateError::Network("成功构建中没有目标架构产物".to_owned()))?;
        let digest = artifact.digest.ok_or_else(|| {
            UpdateError::Verification("GitHub 未提供 Artifact digest，拒绝自动安装".to_owned())
        })?;
        validate_digest(&digest)?;
        let download_url = format!(
            "https://nightly.link/{}/workflows/{}/{}/{}.zip",
            self.repository, self.workflow, self.branch, self.artifact
        );
        let available = installed_commit.as_deref() != Some(run.head_sha.as_str());
        Ok(UpdateInfo {
            installed_commit,
            latest_commit: run.head_sha,
            run_id: run.id,
            created_at: run.created_at,
            run_url: run.html_url,
            artifact: artifact.name,
            artifact_digest: digest,
            download_url,
            available,
        })
    }

    pub async fn apply(
        &self,
        operations: &Operations,
        control: &ControlClient,
    ) -> Result<UpdateInfo, UpdateError> {
        let _guard = self.apply_lock.lock().await;
        let mut info = self.check().await?;
        if !info.available {
            return Ok(info);
        }
        let archive = self.download(&info).await?;
        let binary = tokio::task::spawn_blocking(move || extract_binary(&archive))
            .await
            .map_err(|error| UpdateError::Verification(error.to_string()))??;
        self.install(binary, operations, control).await?;
        self.database
            .set_setting(
                INSTALLED_COMMIT_KEY,
                info.latest_commit.clone(),
                unix_timestamp(),
            )
            .await
            .map_err(|error| UpdateError::Install(error.to_string()))?;
        info.installed_commit = Some(info.latest_commit.clone());
        info.available = false;
        Ok(info)
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

    async fn download(&self, info: &UpdateInfo) -> Result<Vec<u8>, UpdateError> {
        let response = self
            .client
            .get(&info.download_url)
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
        let expected = info
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

    async fn install(
        &self,
        binary: Vec<u8>,
        operations: &Operations,
        control: &ControlClient,
    ) -> Result<(), UpdateError> {
        #[cfg(not(unix))]
        ensure_update_platform()?;
        validate_elf(&binary)?;
        let target = self.binary_path.as_ref();
        let metadata = fs::symlink_metadata(target)
            .map_err(|error| UpdateError::Install(format!("读取当前二进制失败：{error}")))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(UpdateError::Install(
                "目标二进制必须是普通文件，不能是符号链接".to_owned(),
            ));
        }
        let parent = target
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .ok_or_else(|| UpdateError::Install("目标二进制缺少父目录".to_owned()))?;
        let candidate = write_executable(parent, ".kixdns-candidate-", &binary)?;
        let current = fs::read(target)
            .map_err(|error| UpdateError::Install(format!("读取当前二进制失败：{error}")))?;
        let backup_path = target.with_file_name("kixdns.previous");
        let backup = write_executable(parent, ".kixdns-backup-", &current)?;
        persist(backup, &backup_path)?;

        operations
            .service_action(ServiceAction::Stop)
            .await
            .map_err(|error| UpdateError::Install(error.to_string()))?;
        if let Err(error) = persist(candidate, target) {
            let _ = operations.service_action(ServiceAction::Start).await;
            return Err(error);
        }
        if let Err(error) = operations.service_action(ServiceAction::Start).await {
            self.restore_backup(&backup_path, operations, control)
                .await
                .map_err(|rollback| {
                    UpdateError::Install(format!("新版本启动失败：{error}；{rollback}"))
                })?;
            return Err(UpdateError::Install(format!(
                "新版本启动失败，已恢复旧版本：{error}"
            )));
        }
        if let Err(error) = wait_until_healthy(control).await {
            self.restore_backup(&backup_path, operations, control)
                .await
                .map_err(|rollback| UpdateError::Install(format!("{error}；{rollback}")))?;
            return Err(UpdateError::Install(format!("{error}；已恢复旧版本")));
        }
        sync_directory(parent)?;
        Ok(())
    }

    async fn restore_backup(
        &self,
        backup_path: &Path,
        operations: &Operations,
        control: &ControlClient,
    ) -> Result<(), UpdateError> {
        let _ = operations.service_action(ServiceAction::Stop).await;
        let backup = fs::read(backup_path)
            .map_err(|error| UpdateError::Install(format!("读取回滚二进制失败：{error}")))?;
        let parent = self
            .binary_path
            .parent()
            .ok_or_else(|| UpdateError::Install("目标二进制缺少父目录".to_owned()))?;
        let temporary = write_executable(parent, ".kixdns-rollback-", &backup)?;
        persist(temporary, self.binary_path.as_ref())?;
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

fn extract_binary(archive: &[u8]) -> Result<Vec<u8>, UpdateError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(archive))
        .map_err(|error| UpdateError::Verification(format!("Artifact 不是有效 ZIP：{error}")))?;
    let checksums = read_zip_entry(&mut archive, "SHA256SUMS", 64 * 1024)?;
    let checksums = String::from_utf8(checksums)
        .map_err(|_| UpdateError::Verification("SHA256SUMS 不是 UTF-8".to_owned()))?;
    let expected = checksums
        .lines()
        .find_map(|line| {
            let mut fields = line.split_whitespace();
            let digest = fields.next()?;
            let name = fields.next()?.trim_start_matches('*');
            (name == "kixdns").then(|| digest.to_owned())
        })
        .ok_or_else(|| UpdateError::Verification("SHA256SUMS 缺少 kixdns".to_owned()))?;
    validate_hex_digest(&expected)?;
    let binary = read_zip_entry(&mut archive, "kixdns", MAX_BINARY_BYTES)?;
    let actual = sha256(&binary);
    if !constant_hash_eq(&expected, &actual) {
        return Err(UpdateError::Verification(format!(
            "二进制摘要不匹配：期望 {expected}，实际 {actual}"
        )));
    }
    Ok(binary)
}

fn read_zip_entry(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    name: &str,
    limit: u64,
) -> Result<Vec<u8>, UpdateError> {
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
            "已安装构建提交必须是完整的 40 位十六进制 SHA".to_owned(),
        ));
    }
    Ok(())
}

fn validate_hex_digest(value: &str) -> Result<(), UpdateError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(UpdateError::Verification("SHA-256 摘要格式无效".to_owned()));
    }
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
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
    let mut temporary = Builder::new()
        .prefix(prefix)
        .tempfile_in(directory)
        .map_err(|error| UpdateError::Install(error.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o755))
            .map_err(|error| UpdateError::Install(error.to_string()))?;
    }
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

    use super::{extract_binary, sha256, validate_commit, validate_digest, validate_slug};

    #[test]
    fn validates_fixed_update_coordinates_and_digests() {
        assert!(validate_slug("tuoro/kixdns-panel", true).is_ok());
        assert!(validate_slug("https://evil.invalid", true).is_err());
        assert!(validate_slug("build-enhanced.yml", false).is_ok());
        assert!(validate_slug("../../workflow", false).is_err());
        assert!(validate_slug("..", false).is_err());
        assert!(validate_slug("owner/..", true).is_err());
        assert!(validate_digest(&format!("sha256:{}", "a".repeat(64))).is_ok());
        assert!(validate_digest("sha256:bad").is_err());
        assert!(validate_commit("374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25").is_ok());
        assert!(validate_commit("not-a-commit").is_err());
    }

    #[test]
    fn extracts_only_checksum_verified_binary() {
        let binary = b"test-binary";
        let checksum = format!("{}  kixdns\n", sha256(binary));
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("kixdns", options).unwrap();
        writer.write_all(binary).unwrap();
        writer.start_file("SHA256SUMS", options).unwrap();
        writer.write_all(checksum.as_bytes()).unwrap();
        let archive = writer.finish().unwrap().into_inner();

        assert_eq!(extract_binary(&archive).unwrap(), binary);

        let wrong_checksum = format!("{}  kixdns\n", "0".repeat(64));
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer.start_file("kixdns", options).unwrap();
        writer.write_all(binary).unwrap();
        writer.start_file("SHA256SUMS", options).unwrap();
        writer.write_all(wrong_checksum.as_bytes()).unwrap();
        let tampered = writer.finish().unwrap().into_inner();
        assert!(extract_binary(&tampered).is_err());
    }
}
