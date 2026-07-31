use std::fs::{self, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, bail};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;

const MAX_CONFIG_VERSIONS: i64 = 100;
const MAX_AUDIT_EVENTS: i64 = 10_000;
const CURRENT_SCHEMA_VERSION: i64 = 3;

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

#[derive(Debug, Clone, Serialize)]
pub struct AuditEvent {
    pub id: i64,
    pub actor: Option<String>,
    pub action: String,
    pub detail: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuditPage {
    pub events: Vec<AuditEvent>,
    pub next_cursor: Option<i64>,
}

impl Database {
    pub async fn open(path: PathBuf) -> anyhow::Result<Self> {
        let populated = fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 0);
        prepare_database_file(&path)?;
        let database = Self {
            path: Arc::new(path),
        };
        let migration_path = Arc::clone(&database.path);
        database
            .call(move |connection| initialize_database(connection, &migration_path, populated))
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
            let transaction = connection.transaction()?;
            transaction.execute(
                "INSERT INTO config_versions(sha256, content, message, actor, created_at) \
                 VALUES(?1, ?2, ?3, ?4, ?5)",
                params![sha256, content, message, actor, created_at],
            )?;
            let id = transaction.last_insert_rowid();
            prune_config_versions(&transaction)?;
            transaction.commit()?;
            Ok(id)
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
            let transaction = connection.transaction()?;
            let latest: Option<String> = transaction
                .query_row(
                    "SELECT sha256 FROM config_versions ORDER BY id DESC LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            if latest.as_deref() == Some(&sha256) {
                return Ok(None);
            }
            transaction.execute(
                "INSERT INTO config_versions(sha256, content, message, actor, created_at) \
                 VALUES(?1, ?2, ?3, ?4, ?5)",
                params![sha256, content, message, actor, created_at],
            )?;
            let id = transaction.last_insert_rowid();
            prune_config_versions(&transaction)?;
            transaction.commit()?;
            Ok(Some(id))
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

    pub async fn config_version_contents(&self) -> anyhow::Result<Vec<String>> {
        self.call(|connection| {
            let mut statement =
                connection.prepare("SELECT content FROM config_versions ORDER BY id DESC")?;
            let rows = statement.query_map([], |row| row.get(0))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        })
        .await
    }

    pub async fn latest_config_version_id_by_sha256(
        &self,
        sha256: String,
    ) -> anyhow::Result<Option<i64>> {
        self.call(move |connection| {
            connection
                .query_row(
                    "SELECT id FROM config_versions WHERE sha256 = ?1 ORDER BY id DESC LIMIT 1",
                    [sha256],
                    |row| row.get(0),
                )
                .optional()
                .map_err(Into::into)
        })
        .await
    }

    pub async fn delete_config_version(&self, id: i64) -> anyhow::Result<bool> {
        self.call(move |connection| {
            Ok(connection.execute("DELETE FROM config_versions WHERE id = ?1", [id])? > 0)
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
            let transaction = connection.transaction()?;
            transaction.execute(
                "INSERT INTO audit_events(actor, action, detail, created_at) VALUES(?1, ?2, ?3, ?4)",
                params![actor, action, detail, created_at],
            )?;
            prune_audit_events(&transaction)?;
            transaction.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn list_audit_events(
        &self,
        limit: usize,
        before_id: Option<i64>,
        action_prefix: Option<String>,
    ) -> anyhow::Result<AuditPage> {
        let limit = limit.clamp(1, 100);
        let query_limit = i64::try_from(limit + 1).unwrap_or(101);
        let action_pattern = action_prefix.map(|prefix| format!("{prefix}%"));
        self.call(move |connection| {
            let mut statement = connection.prepare(
                "SELECT id, actor, action, detail, created_at FROM audit_events \
                 WHERE (?1 IS NULL OR id < ?1) AND (?2 IS NULL OR action LIKE ?2) \
                 ORDER BY id DESC LIMIT ?3",
            )?;
            let rows =
                statement.query_map(params![before_id, action_pattern, query_limit], |row| {
                    Ok(AuditEvent {
                        id: row.get(0)?,
                        actor: row.get(1)?,
                        action: row.get(2)?,
                        detail: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                })?;
            let mut events = rows.collect::<Result<Vec<_>, _>>()?;
            let has_more = events.len() > limit;
            events.truncate(limit);
            let next_cursor = if has_more {
                events.last().map(|event| event.id)
            } else {
                None
            };
            Ok(AuditPage {
                events,
                next_cursor,
            })
        })
        .await
    }

    pub async fn get_setting(&self, key: &'static str) -> anyhow::Result<Option<String>> {
        self.call(move |connection| {
            connection
                .query_row(
                    "SELECT value FROM app_settings WHERE key = ?1",
                    [key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(Into::into)
        })
        .await
    }

    pub async fn set_setting(
        &self,
        key: &'static str,
        value: String,
        updated_at: i64,
    ) -> anyhow::Result<()> {
        self.call(move |connection| {
            connection.execute(
                "INSERT INTO app_settings(key, value, updated_at) VALUES(?1, ?2, ?3) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, value, updated_at],
            )?;
            Ok(())
        })
        .await
    }
}

fn initialize_database(
    connection: &mut Connection,
    path: &Path,
    populated: bool,
) -> anyhow::Result<()> {
    connection.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > CURRENT_SCHEMA_VERSION {
        bail!("数据库版本 {version} 高于当前支持的版本 {CURRENT_SCHEMA_VERSION}，请升级面板");
    }
    if populated && version < CURRENT_SCHEMA_VERSION {
        let backup = backup_database(connection, path, version)?;
        tracing::info!(
            source_version = version,
            backup = %backup.display(),
            "迁移前数据库备份已创建"
        );
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if version < 1 {
        transaction.execute_batch(
            r"
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
    }
    if version < 2 {
        transaction.execute_batch(
            r"
            CREATE TABLE IF NOT EXISTS app_settings (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            PRAGMA user_version = 2;
            ",
        )?;
    }
    if version < 3 {
        transaction.execute_batch(
            r"
            CREATE INDEX IF NOT EXISTS config_versions_sha_idx
                ON config_versions(sha256, id DESC);
            CREATE INDEX IF NOT EXISTS audit_events_created_idx
                ON audit_events(created_at DESC, id DESC);
            PRAGMA user_version = 3;
            ",
        )?;
    }
    transaction.commit()?;
    prune_config_versions(connection)?;
    prune_audit_events(connection)?;
    Ok(())
}

fn backup_database(
    connection: &Connection,
    path: &Path,
    source_version: i64,
) -> anyhow::Result<PathBuf> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("数据库文件名不是有效 UTF-8")?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut sequence = 0_u16;
    let backup = loop {
        let suffix = if sequence == 0 {
            String::new()
        } else {
            format!("-{sequence}")
        };
        let candidate = parent.join(format!(
            "{file_name}.v{source_version}-{timestamp}{suffix}.bak"
        ));
        if !candidate.exists() {
            break candidate;
        }
        sequence = sequence
            .checked_add(1)
            .context("无法为数据库备份生成唯一文件名")?;
    };
    let backup_text = backup.to_str().context("数据库备份路径不是有效 UTF-8")?;
    connection
        .execute("VACUUM INTO ?1", [backup_text])
        .context("创建迁移前数据库备份失败")?;
    #[cfg(unix)]
    restrict_file_permissions(&backup)?;
    Ok(backup)
}

fn prune_config_versions(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute(
        "DELETE FROM config_versions WHERE id <= COALESCE((\
         SELECT id FROM config_versions ORDER BY id DESC LIMIT 1 OFFSET ?1), 0)",
        [MAX_CONFIG_VERSIONS],
    )?;
    Ok(())
}

fn prune_audit_events(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute(
        "DELETE FROM audit_events WHERE id <= COALESCE((\
         SELECT id FROM audit_events ORDER BY id DESC LIMIT 1 OFFSET ?1), 0)",
        [MAX_AUDIT_EVENTS],
    )?;
    Ok(())
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

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, params};
    use tempfile::tempdir;

    use super::{
        CURRENT_SCHEMA_VERSION, Database, MAX_AUDIT_EVENTS, MAX_CONFIG_VERSIONS,
        prune_audit_events, prune_config_versions,
    };

    #[test]
    fn retains_only_recent_configuration_and_audit_rows() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE config_versions (id INTEGER PRIMARY KEY, value TEXT);\
                 CREATE TABLE audit_events (id INTEGER PRIMARY KEY, value TEXT);",
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();
        for id in 1..=MAX_CONFIG_VERSIONS + 5 {
            transaction
                .execute(
                    "INSERT INTO config_versions(id, value) VALUES(?1, ?2)",
                    params![id, id.to_string()],
                )
                .unwrap();
        }
        for id in 1..=MAX_AUDIT_EVENTS + 5 {
            transaction
                .execute(
                    "INSERT INTO audit_events(id, value) VALUES(?1, ?2)",
                    params![id, id.to_string()],
                )
                .unwrap();
        }
        prune_config_versions(&transaction).unwrap();
        prune_audit_events(&transaction).unwrap();
        transaction.commit().unwrap();

        let config_range: (i64, i64) = connection
            .query_row("SELECT COUNT(*), MIN(id) FROM config_versions", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        let audit_range: (i64, i64) = connection
            .query_row("SELECT COUNT(*), MIN(id) FROM audit_events", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(config_range, (MAX_CONFIG_VERSIONS, 6));
        assert_eq!(audit_range, (MAX_AUDIT_EVENTS, 6));
    }

    #[tokio::test]
    async fn migrates_v1_database_once_and_keeps_a_consistent_backup() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("panel.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                r"
                CREATE TABLE users (
                    id INTEGER PRIMARY KEY,
                    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    password_hash TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE sessions (
                    id INTEGER PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    token_hash TEXT NOT NULL UNIQUE,
                    csrf_hash TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE config_versions (
                    id INTEGER PRIMARY KEY,
                    sha256 TEXT NOT NULL,
                    content TEXT NOT NULL,
                    message TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE audit_events (
                    id INTEGER PRIMARY KEY,
                    actor TEXT,
                    action TEXT NOT NULL,
                    detail TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                INSERT INTO users(username, password_hash, created_at)
                    VALUES('admin', 'hash', 1);
                PRAGMA user_version = 1;
                ",
            )
            .unwrap();
        drop(connection);

        Database::open(path.clone()).await.unwrap();
        let migrated = Connection::open(&path).unwrap();
        let version: i64 = migrated
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        assert_eq!(
            migrated
                .query_row("SELECT username FROM users", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "admin"
        );
        assert!(
            migrated
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .is_ok()
        );
        drop(migrated);

        let backups = database_backups(directory.path());
        assert_eq!(backups.len(), 1);
        let backup = Connection::open(&backups[0]).unwrap();
        let backup_version: i64 = backup
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(backup_version, 1);
        assert_eq!(
            backup
                .query_row("SELECT COUNT(*) FROM users", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(backup);

        Database::open(path).await.unwrap();
        assert_eq!(database_backups(directory.path()).len(), 1);
    }

    #[tokio::test]
    async fn paginates_and_filters_audit_events_without_duplicates() {
        let directory = tempdir().unwrap();
        let database = Database::open(directory.path().join("panel.db"))
            .await
            .unwrap();
        for (index, action) in [
            "auth.login",
            "config.save",
            "service.restart",
            "config.restore",
        ]
        .into_iter()
        .enumerate()
        {
            database
                .audit(
                    Some("admin".to_owned()),
                    action.to_owned(),
                    format!("事件 {index}"),
                    i64::try_from(index).unwrap(),
                )
                .await
                .unwrap();
        }

        let first = database.list_audit_events(2, None, None).await.unwrap();
        assert_eq!(first.events.len(), 2);
        assert_eq!(first.events[0].action, "config.restore");
        let cursor = first.next_cursor.unwrap();
        let second = database
            .list_audit_events(2, Some(cursor), None)
            .await
            .unwrap();
        assert_eq!(second.events.len(), 2);
        assert!(second.next_cursor.is_none());
        assert!(
            first
                .events
                .iter()
                .all(|left| { second.events.iter().all(|right| left.id != right.id) })
        );

        let filtered = database
            .list_audit_events(100, None, Some("config.".to_owned()))
            .await
            .unwrap();
        assert_eq!(filtered.events.len(), 2);
        assert!(
            filtered
                .events
                .iter()
                .all(|event| event.action.starts_with("config."))
        );
    }

    #[tokio::test]
    async fn rejects_databases_from_a_newer_panel_version() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("panel.db");
        let connection = Connection::open(&path).unwrap();
        connection.pragma_update(None, "user_version", 99).unwrap();
        drop(connection);

        let Err(error) = Database::open(path).await else {
            panic!("未来版本数据库不应被当前面板打开");
        };
        assert!(format!("{error:#}").contains("高于当前支持的版本"));
        assert!(database_backups(directory.path()).is_empty());
    }

    fn database_backups(directory: &std::path::Path) -> Vec<std::path::PathBuf> {
        std::fs::read_dir(directory)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "bak"))
            .collect()
    }
}
