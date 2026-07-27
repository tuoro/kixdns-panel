use std::fs::{self, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, bail};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;

#[derive(Clone)]
pub struct Database {
    path: Arc<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct UserRecord {
    pub id: i64,
    pub username: String,
    pub password_hash: String,
}

#[derive(Debug, Clone)]
pub struct SessionRecord {
    pub user_id: i64,
    pub username: String,
    pub csrf_hash: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigVersionSummary {
    pub id: i64,
    pub sha256: String,
    pub message: String,
    pub actor: String,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct ConfigVersion {
    pub summary: ConfigVersionSummary,
    pub content: String,
}

impl Database {
    pub async fn open(path: PathBuf) -> anyhow::Result<Self> {
        prepare_database_file(&path)?;
        let database = Self {
            path: Arc::new(path),
        };
        database
            .call(|connection| {
                connection.execute_batch(
                    r"
                    PRAGMA journal_mode = WAL;
                    PRAGMA foreign_keys = ON;
                    CREATE TABLE IF NOT EXISTS users (
                        id            INTEGER PRIMARY KEY,
                        username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
                        password_hash TEXT NOT NULL,
                        created_at    INTEGER NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS sessions (
                        id          INTEGER PRIMARY KEY,
                        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        token_hash  TEXT NOT NULL UNIQUE,
                        csrf_hash   TEXT NOT NULL,
                        expires_at  INTEGER NOT NULL,
                        created_at  INTEGER NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
                    CREATE TABLE IF NOT EXISTS config_versions (
                        id         INTEGER PRIMARY KEY,
                        sha256     TEXT NOT NULL,
                        content    TEXT NOT NULL,
                        message    TEXT NOT NULL,
                        actor      TEXT NOT NULL,
                        created_at INTEGER NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS config_versions_created_idx
                        ON config_versions(created_at DESC);
                    CREATE TABLE IF NOT EXISTS audit_events (
                        id         INTEGER PRIMARY KEY,
                        actor      TEXT,
                        action     TEXT NOT NULL,
                        detail     TEXT NOT NULL,
                        created_at INTEGER NOT NULL
                    );
                    PRAGMA user_version = 1;
                    ",
                )?;
                Ok(())
            })
            .await
            .context("初始化数据库结构失败")?;
        #[cfg(unix)]
        restrict_file_permissions(&database.path)?;
        Ok(database)
    }

    async fn call<T, F>(&self, operation: F) -> anyhow::Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> anyhow::Result<T> + Send + 'static,
    {
        let path = Arc::clone(&self.path);
        tokio::task::spawn_blocking(move || {
            let mut connection = Connection::open(path.as_ref())
                .with_context(|| format!("打开数据库失败：{}", path.display()))?;
            connection.busy_timeout(Duration::from_secs(5))?;
            connection.pragma_update(None, "foreign_keys", "ON")?;
            operation(&mut connection)
        })
        .await
        .context("数据库任务异常结束")?
    }

    pub async fn has_users(&self) -> anyhow::Result<bool> {
        self.call(|connection| {
            let count: i64 =
                connection.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?;
            Ok(count > 0)
        })
        .await
    }

    pub async fn create_first_user(
        &self,
        username: String,
        password_hash: String,
        now: i64,
    ) -> anyhow::Result<UserRecord> {
        self.call(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let count: i64 =
                transaction.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?;
            if count != 0 {
                bail!("setup_already_completed");
            }
            transaction.execute(
                "INSERT INTO users(username, password_hash, created_at) VALUES(?1, ?2, ?3)",
                params![username, password_hash, now],
            )?;
            let user = UserRecord {
                id: transaction.last_insert_rowid(),
                username,
                password_hash,
            };
            transaction.commit()?;
            Ok(user)
        })
        .await
    }

    pub async fn find_user(&self, username: String) -> anyhow::Result<Option<UserRecord>> {
        self.call(move |connection| {
            connection
                .query_row(
                    "SELECT id, username, password_hash FROM users WHERE username = ?1",
                    [username],
                    |row| {
                        Ok(UserRecord {
                            id: row.get(0)?,
                            username: row.get(1)?,
                            password_hash: row.get(2)?,
                        })
                    },
                )
                .optional()
                .map_err(Into::into)
        })
        .await
    }

    pub async fn create_session(
        &self,
        user_id: i64,
        token_hash: String,
        csrf_hash: String,
        expires_at: i64,
        now: i64,
    ) -> anyhow::Result<()> {
        self.call(move |connection| {
            connection.execute("DELETE FROM sessions WHERE expires_at <= ?1", [now])?;
            connection.execute(
                "INSERT INTO sessions(user_id, token_hash, csrf_hash, expires_at, created_at) \
                 VALUES(?1, ?2, ?3, ?4, ?5)",
                params![user_id, token_hash, csrf_hash, expires_at, now],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn find_session(
        &self,
        token_hash: String,
        now: i64,
    ) -> anyhow::Result<Option<SessionRecord>> {
        self.call(move |connection| {
            connection
                .query_row(
                    "SELECT u.id, u.username, s.csrf_hash, s.expires_at \
                     FROM sessions s JOIN users u ON u.id = s.user_id \
                     WHERE s.token_hash = ?1 AND s.expires_at > ?2",
                    params![token_hash, now],
                    |row| {
                        Ok(SessionRecord {
                            user_id: row.get(0)?,
                            username: row.get(1)?,
                            csrf_hash: row.get(2)?,
                            expires_at: row.get(3)?,
                        })
                    },
                )
                .optional()
                .map_err(Into::into)
        })
        .await
    }

    pub async fn delete_session(&self, token_hash: String) -> anyhow::Result<()> {
        self.call(move |connection| {
            connection.execute("DELETE FROM sessions WHERE token_hash = ?1", [token_hash])?;
            Ok(())
        })
        .await
    }

    pub async fn store_config_version(
        &self,
        sha256: String,
        content: String,
        message: String,
        actor: String,
        created_at: i64,
    ) -> anyhow::Result<i64> {
        self.call(move |connection| {
            connection.execute(
                "INSERT INTO config_versions(sha256, content, message, actor, created_at) \
                 VALUES(?1, ?2, ?3, ?4, ?5)",
                params![sha256, content, message, actor, created_at],
            )?;
            Ok(connection.last_insert_rowid())
        })
        .await
    }

    pub async fn store_config_if_changed(
        &self,
        sha256: String,
        content: String,
        message: String,
        actor: String,
        created_at: i64,
    ) -> anyhow::Result<Option<i64>> {
        self.call(move |connection| {
            let latest: Option<String> = connection
                .query_row(
                    "SELECT sha256 FROM config_versions ORDER BY id DESC LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            if latest.as_deref() == Some(&sha256) {
                return Ok(None);
            }
            connection.execute(
                "INSERT INTO config_versions(sha256, content, message, actor, created_at) \
                 VALUES(?1, ?2, ?3, ?4, ?5)",
                params![sha256, content, message, actor, created_at],
            )?;
            Ok(Some(connection.last_insert_rowid()))
        })
        .await
    }

    pub async fn list_config_versions(
        &self,
        limit: usize,
    ) -> anyhow::Result<Vec<ConfigVersionSummary>> {
        let limit = i64::try_from(limit.min(200)).unwrap_or(200);
        self.call(move |connection| {
            let mut statement = connection.prepare(
                "SELECT id, sha256, message, actor, created_at \
                 FROM config_versions ORDER BY id DESC LIMIT ?1",
            )?;
            let rows = statement.query_map([limit], |row| {
                Ok(ConfigVersionSummary {
                    id: row.get(0)?,
                    sha256: row.get(1)?,
                    message: row.get(2)?,
                    actor: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        })
        .await
    }

    pub async fn get_config_version(&self, id: i64) -> anyhow::Result<Option<ConfigVersion>> {
        self.call(move |connection| {
            connection
                .query_row(
                    "SELECT id, sha256, content, message, actor, created_at \
                     FROM config_versions WHERE id = ?1",
                    [id],
                    |row| {
                        Ok(ConfigVersion {
                            summary: ConfigVersionSummary {
                                id: row.get(0)?,
                                sha256: row.get(1)?,
                                message: row.get(3)?,
                                actor: row.get(4)?,
                                created_at: row.get(5)?,
                            },
                            content: row.get(2)?,
                        })
                    },
                )
                .optional()
                .map_err(Into::into)
        })
        .await
    }

    pub async fn audit(
        &self,
        actor: Option<String>,
        action: String,
        detail: String,
        created_at: i64,
    ) -> anyhow::Result<()> {
        self.call(move |connection| {
            connection.execute(
                "INSERT INTO audit_events(actor, action, detail, created_at) VALUES(?1, ?2, ?3, ?4)",
                params![actor, action, detail, created_at],
            )?;
            Ok(())
        })
        .await
    }
}

fn prepare_database_file(path: &Path) -> anyhow::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            bail!(
                "数据库路径必须是普通文件，不能是符号链接：{}",
                path.display()
            );
        }
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("检查数据库路径失败"),
    }

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(path)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                bail!(
                    "数据库路径必须是普通文件，不能是符号链接：{}",
                    path.display()
                );
            }
            Ok(())
        }
        Err(error) => Err(error).context("创建数据库文件失败"),
    }
}

#[cfg(unix)]
fn restrict_file_permissions(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("设置数据库权限失败：{}", path.display()))?;
    Ok(())
}

pub fn ensure_database_parent(path: &Path) -> anyhow::Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .with_context(|| format!("创建数据库目录失败：{}", parent.display()))?;
    }
    Ok(())
}
