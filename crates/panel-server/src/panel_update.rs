use std::io::ErrorKind;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

const STATUS_FILE: &str = "/var/lib/kixdns-panel-update/status.json";
const MAX_STATUS_BYTES: u64 = 8 * 1024;
const RUNNING_TIMEOUT_SECONDS: u64 = 30 * 60;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PanelUpdateState {
    Idle,
    Checking,
    Downloading,
    Complete,
    Failed,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PanelUpdateStatus {
    pub state: PanelUpdateState,
    pub message: String,
    pub target_version: String,
    pub updated_at: u64,
}

impl PanelUpdateStatus {
    pub fn is_running(&self) -> bool {
        matches!(
            self.state,
            PanelUpdateState::Checking | PanelUpdateState::Downloading
        ) && unix_timestamp().saturating_sub(self.updated_at) <= RUNNING_TIMEOUT_SECONDS
    }

    fn validate(mut self) -> Result<Self, anyhow::Error> {
        if self.message.chars().count() > 300
            || (!self.target_version.is_empty() && !valid_release(&self.target_version))
        {
            anyhow::bail!("面板在线更新状态内容无效");
        }
        if matches!(
            self.state,
            PanelUpdateState::Checking | PanelUpdateState::Downloading
        ) && !self.is_running()
        {
            self.state = PanelUpdateState::Failed;
            "上次在线更新未正常结束，请重新发起更新".clone_into(&mut self.message);
        }
        // 失败状态只由下一次在线更新重写；改用安装包升级到（或越过）目标版本后，那次失败已经
        // 不成立，继续显示只会误导。
        // A failed status is only rewritten by the next online update; once the panel reached (or
        // passed) the target some other way, that failure no longer holds and showing it misleads.
        if self.state == PanelUpdateState::Failed && target_reached(&self.target_version) {
            return Ok(idle_status());
        }
        Ok(self)
    }
}

pub async fn read_status() -> Result<PanelUpdateStatus, anyhow::Error> {
    let metadata = match tokio::fs::symlink_metadata(STATUS_FILE).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(idle_status()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_STATUS_BYTES
        || !trusted_metadata(&metadata)
    {
        anyhow::bail!("面板在线更新状态文件权限无效");
    }
    let capacity = usize::try_from(metadata.len())
        .map_err(|_| anyhow::anyhow!("面板在线更新状态文件大小无效"))?;
    let mut content = Vec::with_capacity(capacity);
    tokio::fs::File::open(STATUS_FILE)
        .await?
        .take(MAX_STATUS_BYTES + 1)
        .read_to_end(&mut content)
        .await?;
    if content.len() as u64 > MAX_STATUS_BYTES {
        anyhow::bail!("面板在线更新状态文件过大");
    }
    serde_json::from_slice::<PanelUpdateStatus>(&content)?.validate()
}

fn idle_status() -> PanelUpdateStatus {
    PanelUpdateStatus {
        state: PanelUpdateState::Idle,
        message: String::new(),
        target_version: String::new(),
        updated_at: 0,
    }
}

fn target_reached(target_version: &str) -> bool {
    let (Some(target), Ok(running)) = (
        target_version
            .strip_prefix('v')
            .and_then(|version| semver::Version::parse(version).ok()),
        semver::Version::parse(env!("CARGO_PKG_VERSION")),
    ) else {
        return false;
    };
    running >= target
}

fn valid_release(value: &str) -> bool {
    let Some(version) = value.strip_prefix('v') else {
        return false;
    };
    version.split('.').count() == 3
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(unix)]
fn trusted_metadata(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    metadata.uid() == 0 && metadata.permissions().mode() & 0o022 == 0
}

#[cfg(not(unix))]
fn trusted_metadata(_metadata: &std::fs::Metadata) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::{PanelUpdateState, PanelUpdateStatus, valid_release};

    #[test]
    fn accepts_only_stable_release_tags() {
        assert!(valid_release("v1.0.3"));
        assert!(!valid_release("1.0.3"));
        assert!(!valid_release("v1.0.3-rc.1"));
        assert!(!valid_release("v1.0"));
    }

    fn failed_status(target_version: &str) -> PanelUpdateStatus {
        PanelUpdateStatus {
            state: PanelUpdateState::Failed,
            message: "在线更新失败：安装失败：下载超时".to_owned(),
            target_version: target_version.to_owned(),
            updated_at: 1,
        }
    }

    #[test]
    fn failure_is_cleared_once_the_panel_reaches_its_target() {
        // 回归：在线更新失败后改用安装包升级成功，状态文件没人重写，系统页一直挂着那次失败。
        // Regression: after a failed online update the panel was upgraded from a package; nothing
        // rewrote the status file, so the system page kept showing that failure.
        let running = concat!("v", env!("CARGO_PKG_VERSION"));
        let status = failed_status(running).validate().unwrap();
        assert_eq!(status.state, PanelUpdateState::Idle);
        assert!(status.message.is_empty());

        let older = failed_status("v0.0.1").validate().unwrap();
        assert_eq!(older.state, PanelUpdateState::Idle);

        // 目标仍比运行中的面板新：失败还没解决，原因要留着。
        // The target is still newer than the running panel: the failure stands and keeps its reason.
        let pending = failed_status("v999.0.0").validate().unwrap();
        assert_eq!(pending.state, PanelUpdateState::Failed);
        assert_eq!(pending.message, "在线更新失败：安装失败：下载超时");
        // 没有目标版本的失败（例如还没查到最新版就出错）无从判断是否已解决，保留给用户看。
        // A failure with no target (e.g. before the latest release was known) cannot be judged resolved; keep it.
        let unknown = failed_status("").validate().unwrap();
        assert_eq!(unknown.state, PanelUpdateState::Failed);
    }

    #[test]
    fn rejects_unknown_status_fields() {
        let content = br#"{"state":"complete","message":"ok","target_version":"v1.0.3","updated_at":1,"url":"https://example.com"}"#;
        assert!(serde_json::from_slice::<PanelUpdateStatus>(content).is_err());
        let valid =
            br#"{"state":"failed","message":"error","target_version":"v1.0.3","updated_at":1}"#;
        let status = serde_json::from_slice::<PanelUpdateStatus>(valid).unwrap();
        assert_eq!(status.state, PanelUpdateState::Failed);
    }
}
