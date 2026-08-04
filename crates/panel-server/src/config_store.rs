use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use anyhow::{Context, bail};
use serde::Serialize;
use serde_json::Value;
use tempfile::Builder;
use tokio::sync::Mutex;

use crate::auth::unix_timestamp;
use crate::db::{CONFIG_APPLY_FAILED, CONFIG_APPLY_PENDING, ConfigVersionSummary, Database};
use crate::digest::sha256_hex;

pub const MAX_CONFIG_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone)]
pub struct ConfigStore {
    path: Arc<PathBuf>,
    database: Database,
    write_lock: Arc<Mutex<()>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigDocument {
    pub content: Value,
    pub sha256: String,
    pub modified_at: i64,
    pub version_id: Option<i64>,
    #[serde(skip)]
    raw: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigVersionDetail {
    #[serde(flatten)]
    pub summary: ConfigVersionSummary,
    pub content: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct SaveResult {
    pub version_id: i64,
    pub sha256: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("配置文件不存在")]
    NotFound,
    #[error("配置已被其他操作修改")]
    Conflict,
    #[error("当前生效版本不能删除")]
    ActiveVersion,
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl ConfigStore {
    #[must_use]
    pub fn new(path: PathBuf, database: Database) -> Self {
        Self {
            path: Arc::new(path),
            database,
            write_lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn initialize_history(&self) -> anyhow::Result<()> {
        if self.database.pending_config_version().await?.is_some() {
            // 待应用版本优先保留；启动时的正式文件只是上一份已生效配置。
            return Ok(());
        }
        match self.current().await {
            Ok(document) => {
                self.database
                    .store_config_if_changed(
                        document.sha256,
                        document.raw,
                        "导入启动时配置".to_owned(),
                        "system".to_owned(),
                        unix_timestamp(),
                    )
                    .await?;
            }
            Err(ConfigError::NotFound) => {}
            Err(error) => return Err(anyhow::Error::new(error)),
        }
        Ok(())
    }

    pub async fn current(&self) -> Result<ConfigDocument, ConfigError> {
        let path = Arc::clone(&self.path);
        let mut document = tokio::task::spawn_blocking(move || read_document(&path))
            .await
            .context("读取配置任务异常结束")??;
        document.version_id = self
            .database
            .latest_config_version_id_by_sha256(document.sha256.clone())
            .await?;
        Ok(document)
    }

    /// 返回面板当前应编辑的配置。存在待应用或应用失败版本时，以该版本为准。
    pub async fn desired(&self) -> Result<ConfigDocument, ConfigError> {
        if let Some(version) = self.database.pending_config_version().await? {
            let content: Value =
                serde_json::from_str(&version.content).context("待应用配置内容已损坏")?;
            validate_config_shape(&content)?;
            return Ok(ConfigDocument {
                content,
                sha256: version.summary.sha256,
                modified_at: version.summary.created_at,
                version_id: Some(version.summary.id),
                raw: version.content,
            });
        }
        self.current().await
    }

    pub async fn pending(&self) -> anyhow::Result<Option<ConfigVersionSummary>> {
        Ok(self
            .database
            .pending_config_version()
            .await?
            .map(|version| version.summary))
    }

    pub async fn save(
        &self,
        content: Value,
        expected_sha256: &str,
        message: String,
        actor: String,
    ) -> Result<SaveResult, ConfigError> {
        let _guard = self.write_lock.lock().await;
        let current = self.current().await?;
        if !constant_hash_eq(&current.sha256, expected_sha256) {
            return Err(ConfigError::Conflict);
        }
        self.save_locked(content, message, actor).await
    }

    /// 将配置保存为待应用版本，不触碰 `KixDNS` 正式配置文件。
    pub async fn save_pending(
        &self,
        content: Value,
        expected_sha256: &str,
        message: String,
        actor: String,
    ) -> Result<SaveResult, ConfigError> {
        let _guard = self.write_lock.lock().await;
        let current = self.desired().await?;
        if !constant_hash_eq(&current.sha256, expected_sha256) {
            return Err(ConfigError::Conflict);
        }
        self.save_pending_locked(content, message, actor).await
    }

    /// 将指定待应用版本原子写入正式文件，但暂不改变历史状态。
    ///
    /// 调用方应在 `KixDNS` 返回热加载成功回执后再调用 `mark_applied`。
    pub async fn write_pending(&self, version_id: i64) -> Result<SaveResult, ConfigError> {
        let _guard = self.write_lock.lock().await;
        let version = self
            .database
            .get_config_version(version_id)
            .await?
            .ok_or(ConfigError::NotFound)?;
        if !matches!(
            version.summary.apply_state.as_str(),
            CONFIG_APPLY_PENDING | CONFIG_APPLY_FAILED
        ) {
            return Err(ConfigError::Invalid("该配置版本当前不可应用".to_owned()));
        }
        let content: Value =
            serde_json::from_str(&version.content).context("待应用配置内容已损坏")?;
        validate_config_shape(&content)?;
        let path = Arc::clone(&self.path);
        let bytes = version.content.as_bytes().to_vec();
        tokio::task::spawn_blocking(move || atomic_write(&path, &bytes))
            .await
            .context("写入配置任务异常结束")??;
        Ok(SaveResult {
            version_id,
            sha256: version.summary.sha256,
        })
    }

    /// 将待应用版本标记为已生效。
    pub async fn mark_applied(&self, version_id: i64) -> Result<(), ConfigError> {
        if !self
            .database
            .mark_config_version_applied(version_id)
            .await?
        {
            return Err(ConfigError::Conflict);
        }
        Ok(())
    }

    /// 原子恢复正式配置文件，不新增历史版本。
    pub async fn restore_formal(&self, content: Value) -> Result<(), ConfigError> {
        validate_config_shape(&content)?;
        let serialized = format_json(&content)?;
        if serialized.len() > MAX_CONFIG_BYTES {
            return Err(ConfigError::Invalid("配置文件不能超过 4 MiB".to_owned()));
        }
        let path = Arc::clone(&self.path);
        let bytes = serialized.into_bytes();
        tokio::task::spawn_blocking(move || atomic_write(&path, &bytes))
            .await
            .context("写入配置任务异常结束")??;
        Ok(())
    }

    pub async fn mark_pending_failed(
        &self,
        version_id: i64,
        error: impl Into<String>,
    ) -> anyhow::Result<()> {
        self.database
            .mark_config_version_failed(version_id, error.into())
            .await?;
        Ok(())
    }

    pub async fn version_content(&self, version_id: i64) -> Result<Value, ConfigError> {
        Ok(self.version(version_id).await?.content)
    }

    pub async fn version(&self, version_id: i64) -> Result<ConfigVersionDetail, ConfigError> {
        let version = self
            .database
            .get_config_version(version_id)
            .await?
            .ok_or(ConfigError::NotFound)?;
        let content = serde_json::from_str(&version.content).context("历史配置内容已损坏")?;
        validate_config_shape(&content)?;
        Ok(ConfigVersionDetail {
            summary: version.summary,
            content,
        })
    }

    pub async fn delete_version(
        &self,
        version_id: i64,
        expected_sha256: &str,
    ) -> Result<(), ConfigError> {
        let _guard = self.write_lock.lock().await;
        let desired = self.desired().await?;
        if !constant_hash_eq(&desired.sha256, expected_sha256) {
            return Err(ConfigError::Conflict);
        }
        if self
            .current()
            .await
            .ok()
            .and_then(|current| current.version_id)
            == Some(version_id)
        {
            return Err(ConfigError::ActiveVersion);
        }
        if !self.database.delete_config_version(version_id).await? {
            return Err(ConfigError::NotFound);
        }
        Ok(())
    }

    async fn save_locked(
        &self,
        content: Value,
        message: String,
        actor: String,
    ) -> Result<SaveResult, ConfigError> {
        validate_config_shape(&content)?;
        let serialized = format_json(&content)?;
        if serialized.len() > MAX_CONFIG_BYTES {
            return Err(ConfigError::Invalid("配置文件不能超过 4 MiB".to_owned()));
        }
        let sha256 = sha256(serialized.as_bytes());
        let path = Arc::clone(&self.path);
        let bytes = serialized.as_bytes().to_vec();
        tokio::task::spawn_blocking(move || atomic_write(&path, &bytes))
            .await
            .context("写入配置任务异常结束")??;
        let version_id = self
            .database
            .store_config_version(
                sha256.clone(),
                serialized,
                normalize_message(&message),
                actor,
                unix_timestamp(),
            )
            .await?;
        Ok(SaveResult { version_id, sha256 })
    }

    async fn save_pending_locked(
        &self,
        content: Value,
        message: String,
        actor: String,
    ) -> Result<SaveResult, ConfigError> {
        validate_config_shape(&content)?;
        let serialized = format_json(&content)?;
        if serialized.len() > MAX_CONFIG_BYTES {
            return Err(ConfigError::Invalid("配置文件不能超过 4 MiB".to_owned()));
        }
        let sha256 = sha256(serialized.as_bytes());
        let version_id = self
            .database
            .store_pending_config_version(
                sha256.clone(),
                serialized,
                normalize_message(&message),
                actor,
                unix_timestamp(),
            )
            .await?;
        Ok(SaveResult { version_id, sha256 })
    }

    pub async fn versions(&self) -> anyhow::Result<Vec<ConfigVersionSummary>> {
        self.database.list_config_versions(100).await
    }

    pub async fn retained_contents(&self) -> Result<Vec<Value>, ConfigError> {
        let mut contents = Vec::new();
        if let Ok(current) = self.current().await {
            contents.push(current.content);
        }
        for serialized in self.database.config_version_contents().await? {
            let content = serde_json::from_str(&serialized).context("历史配置内容已损坏")?;
            validate_config_shape(&content)?;
            contents.push(content);
        }
        Ok(contents)
    }
}

fn read_document(path: &Path) -> Result<ConfigDocument, ConfigError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Err(ConfigError::NotFound),
        Err(error) => return Err(anyhow::Error::new(error).into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ConfigError::Invalid(
            "配置路径必须是普通文件，不能是符号链接".to_owned(),
        ));
    }
    if metadata.len() > MAX_CONFIG_BYTES as u64 {
        return Err(ConfigError::Invalid("配置文件不能超过 4 MiB".to_owned()));
    }
    let bytes = fs::read(path).with_context(|| format!("读取配置失败：{}", path.display()))?;
    let raw = String::from_utf8(bytes.clone()).context("配置文件必须使用 UTF-8 编码")?;
    let content: Value = serde_json::from_str(&raw).context("配置不是有效 JSON")?;
    validate_config_shape(&content)?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| {
            i64::try_from(duration.as_secs()).unwrap_or(i64::MAX)
        });
    Ok(ConfigDocument {
        content,
        sha256: sha256(&bytes),
        modified_at,
        version_id: None,
        raw,
    })
}

fn validate_config_shape(content: &Value) -> Result<(), ConfigError> {
    let Some(object) = content.as_object() else {
        return Err(ConfigError::Invalid(
            "配置根节点必须是 JSON 对象".to_owned(),
        ));
    };
    if let Some(pipelines) = object.get("pipelines")
        && !pipelines.is_array()
    {
        return Err(ConfigError::Invalid("pipelines 必须是数组".to_owned()));
    }
    Ok(())
}

fn format_json(content: &Value) -> anyhow::Result<String> {
    let mut output = serde_json::to_string_pretty(content).context("序列化配置失败")?;
    output.push('\n');
    Ok(output)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path)
        && (metadata.file_type().is_symlink() || !metadata.is_file())
    {
        bail!("配置路径必须是普通文件，不能是符号链接");
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)
        .with_context(|| format!("创建配置目录失败：{}", parent.display()))?;
    let mut temporary = Builder::new()
        .prefix(".kixdns-panel-")
        .tempfile_in(parent)
        .context("创建配置临时文件失败")?;
    if let Ok(metadata) = fs::metadata(path) {
        temporary
            .as_file()
            .set_permissions(metadata.permissions())
            .context("复制配置文件权限失败")?;
    } else {
        #[cfg(unix)]
        restrict_new_config(temporary.as_file())?;
    }
    temporary.write_all(bytes).context("写入配置临时文件失败")?;
    temporary.flush().context("刷新配置临时文件失败")?;
    temporary
        .as_file()
        .sync_all()
        .context("同步配置临时文件失败")?;
    temporary
        .persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("原子替换配置失败：{}", path.display()))?;
    #[cfg(unix)]
    sync_parent(parent)?;
    Ok(())
}

#[cfg(unix)]
fn restrict_new_config(file: &fs::File) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o640))?;
    Ok(())
}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> anyhow::Result<()> {
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}

fn constant_hash_eq(left: &str, right: &str) -> bool {
    use subtle::ConstantTimeEq;
    left.as_bytes().ct_eq(right.as_bytes()).unwrap_u8() == 1
}

fn normalize_message(message: &str) -> String {
    let message = message.trim();
    if message.is_empty() {
        "更新配置".to_owned()
    } else {
        message.chars().take(200).collect()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tempfile::tempdir;

    use super::{ConfigError, ConfigStore, format_json};
    use crate::db::{Database, ensure_database_parent};

    #[tokio::test]
    async fn saves_with_optimistic_lock_and_restores_history() {
        let directory = tempdir().unwrap();
        let database_path = directory.path().join("panel.db");
        ensure_database_parent(&database_path).unwrap();
        let database = Database::open(database_path).await.unwrap();
        let config_path = directory.path().join("pipeline.json");
        std::fs::write(&config_path, "{\"pipelines\":[]}").unwrap();
        let store = ConfigStore::new(config_path, database);
        store.initialize_history().await.unwrap();

        let initial = store.current().await.unwrap();
        assert!(initial.version_id.is_some());
        let saved = store
            .save(
                json!({"pipelines": [{"id": "default", "rules": []}]}),
                &initial.sha256,
                "新增默认管线".to_owned(),
                "admin".to_owned(),
            )
            .await
            .unwrap();
        assert_ne!(saved.sha256, initial.sha256);

        let conflict = store
            .save(
                json!({"pipelines": []}),
                &initial.sha256,
                String::new(),
                "admin".to_owned(),
            )
            .await;
        assert!(matches!(conflict, Err(ConfigError::Conflict)));

        let versions = store.versions().await.unwrap();
        let initial_version = versions.last().unwrap();
        assert_eq!(
            store.version_content(initial_version.id).await.unwrap(),
            json!({"pipelines": []})
        );
        let restored = store
            .save(
                store.version_content(initial_version.id).await.unwrap(),
                &saved.sha256,
                format!("回滚至版本 #{}", initial_version.id),
                "admin".to_owned(),
            )
            .await
            .unwrap();
        assert_eq!(store.current().await.unwrap().sha256, restored.sha256);

        let active_delete = store
            .delete_version(restored.version_id, &restored.sha256)
            .await;
        assert!(matches!(active_delete, Err(ConfigError::ActiveVersion)));

        store
            .delete_version(initial_version.id, &restored.sha256)
            .await
            .unwrap();
        assert!(matches!(
            store.version_content(initial_version.id).await,
            Err(ConfigError::NotFound)
        ));

        let conflict = store.delete_version(saved.version_id, "stale-sha256").await;
        assert!(matches!(conflict, Err(ConfigError::Conflict)));
    }

    #[test]
    fn preserves_json_object_order_when_formatting() {
        let content = serde_json::from_str(
            r#"{"version":"1.0","settings":{"bind_udp":"0.0.0.0:5353","cache_capacity":10000},"pipeline_select":[],"pipelines":[]}"#,
        )
        .unwrap();
        let formatted = format_json(&content).unwrap();

        let positions = [
            "\"version\"",
            "\"settings\"",
            "\"pipeline_select\"",
            "\"pipelines\"",
        ]
        .map(|key| formatted.find(key).unwrap());
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(
            formatted.find("\"bind_udp\"").unwrap() < formatted.find("\"cache_capacity\"").unwrap()
        );
    }
}
