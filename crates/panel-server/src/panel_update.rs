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
            self.message = "上次在线更新未正常结束，请重新发起更新".to_owned();
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
    let mut content = Vec::with_capacity(metadata.len() as usize);
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
