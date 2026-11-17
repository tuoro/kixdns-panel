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
const CURRENT_SCHEMA_VERSION: i64 = 6;
/// 采样保留 25 小时：比 24 小时的展示窗口多留一格，
/// 让窗口左端始终能找到一个更早的样本来求差。
/// Samples are kept for 25 hours — one bucket more than the 24-hour display
/// window — so the left edge of the window always has an earlier sample to
/// take a difference against.
const METRIC_SAMPLE_RETENTION_SECONDS: i64 = 25 * 60 * 60;

pub const CONFIG_APPLY_APPLIED: &str = "applied";
pub const CONFIG_APPLY_PENDING: &str = "pending";
pub const CONFIG_APPLY_FAILED: &str = "failed";
pub const CONFIG_APPLY_SUPERSEDED: &str = "superseded";

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

/// 一次指标采样。计数器是自内核启动以来的累计值，
/// `kernel_started_at` 用来识别内核重启——那一刻计数器归零。
///
/// One metrics sample. The counter is cumulative since the kernel started, and
/// `kernel_started_at` is what identifies a kernel restart — the moment the
/// counter goes back to zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MetricSample {
    pub captured_at: i64,
    pub kernel_started_at: i64,
    pub requests_total: i64,
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
    pub apply_state: String,
    pub apply_error: Option<String>,
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

    /// 删除所有管理员和他们的登录会话。忘记密码时在面板所在的机器上执行；之后打开面板会回到「创建管理员」。
    /// 配置、版本历史和审计记录都不动。返回删掉了几个管理员。
    /// Delete every administrator and their sessions. Run on the panel's machine after a forgotten password; the panel then opens
    /// on 创建管理员 again. Configuration, version history and the audit log are untouched. Returns how many administrators went.
    pub async fn reset_admins(&self, now: i64) -> anyhow::Result<usize> {
        self.call(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute("DELETE FROM sessions", [])?;
            let removed = transaction.execute("DELETE FROM users", [])?;
            transaction.execute(
                "INSERT INTO audit_events(actor, action, detail, created_at) VALUES(NULL, 'auth.reset_admin', ?1, ?2)",
                params![format!("删除 {removed} 个管理员"), now],
            )?;
            transaction.commit()?;
            Ok(removed)
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
        self.store_config_version_with_state(
            sha256,
            content,
            message,
            actor,
            created_at,
            CONFIG_APPLY_APPLIED,
        )
        .await
    }

    async fn store_config_version_with_state(
        &self,
        sha256: String,
        content: String,
        message: String,
        actor: String,
        created_at: i64,
        apply_state: &'static str,
    ) -> anyhow::Result<i64> {
        self.call(move |connection| {
            let transaction = connection.transaction()?;
            if apply_state == CONFIG_APPLY_APPLIED {
                transaction.execute(
                    "UPDATE config_versions
                     SET apply_state = ?1, apply_error = NULL
                     WHERE apply_state IN (?2, ?3)",
                    params![
                        CONFIG_APPLY_SUPERSEDED,
                        CONFIG_APPLY_PENDING,
                        CONFIG_APPLY_FAILED
                    ],
                )?;
            }
            transaction.execute(
                "INSERT INTO config_versions(
                     sha256, content, message, actor, created_at, apply_state, apply_error
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, NULL)",
                params![sha256, content, message, actor, created_at, apply_state],
            )?;
            let id = transaction.last_insert_rowid();
            prune_config_versions(&transaction)?;
            transaction.commit()?;
            Ok(id)
        })
        .await
    }

    pub async fn store_pending_config_version(
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
                "UPDATE config_versions
                 SET apply_state = ?1, apply_error = NULL
                 WHERE apply_state IN (?2, ?3)",
                params![
                    CONFIG_APPLY_SUPERSEDED,
                    CONFIG_APPLY_PENDING,
                    CONFIG_APPLY_FAILED
                ],
            )?;
            transaction.execute(
                "INSERT INTO config_versions(
                     sha256, content, message, actor, created_at, apply_state, apply_error
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, NULL)",
                params![
                    sha256,
                    content,
                    message,
                    actor,
                    created_at,
                    CONFIG_APPLY_PENDING
                ],
            )?;
            let id = transaction.last_insert_rowid();
            prune_config_versions(&transaction)?;
            transaction.commit()?;
            Ok(id)
        })
        .await
    }

    pub async fn pending_config_version(&self) -> anyhow::Result<Option<ConfigVersion>> {
        self.call(|connection| {
            connection
                .query_row(
                    "SELECT id, sha256, content, message, actor, created_at, apply_state, apply_error
                     FROM config_versions
                     WHERE apply_state IN (?1, ?2)
                     ORDER BY id DESC LIMIT 1",
                    params![CONFIG_APPLY_PENDING, CONFIG_APPLY_FAILED],
                    |row| {
                        Ok(ConfigVersion {
                            summary: ConfigVersionSummary {
                                id: row.get(0)?,
                                sha256: row.get(1)?,
                                message: row.get(3)?,
                                actor: row.get(4)?,
                                created_at: row.get(5)?,
                                apply_state: row.get(6)?,
                                apply_error: row.get(7)?,
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

    pub async fn mark_config_version_applied(&self, id: i64) -> anyhow::Result<bool> {
        self.call(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let changed = transaction.execute(
                "UPDATE config_versions
                 SET apply_state = ?1, apply_error = NULL
                 WHERE id = ?2 AND apply_state IN (?3, ?4)",
                params![
                    CONFIG_APPLY_APPLIED,
                    id,
                    CONFIG_APPLY_PENDING,
                    CONFIG_APPLY_FAILED
                ],
            )?;
            if changed > 0 {
                transaction.execute(
                    "UPDATE config_versions
                     SET apply_state = ?1, apply_error = NULL
                     WHERE apply_state IN (?2, ?3) AND id != ?4",
                    params![
                        CONFIG_APPLY_SUPERSEDED,
                        CONFIG_APPLY_PENDING,
                        CONFIG_APPLY_FAILED,
                        id
                    ],
                )?;
            }
            transaction.commit()?;
            Ok(changed > 0)
        })
        .await
    }

    pub async fn mark_config_version_failed(&self, id: i64, error: String) -> anyhow::Result<bool> {
        self.call(move |connection| {
            let changed = connection.execute(
                "UPDATE config_versions
                 SET apply_state = ?1, apply_error = ?2
                 WHERE id = ?3 AND apply_state IN (?4, ?5)",
                params![
                    CONFIG_APPLY_FAILED,
                    error,
                    id,
                    CONFIG_APPLY_PENDING,
                    CONFIG_APPLY_FAILED
                ],
            )?;
            Ok(changed > 0)
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
                    "SELECT sha256 FROM config_versions
                     WHERE apply_state = ?1 ORDER BY id DESC LIMIT 1",
                    [CONFIG_APPLY_APPLIED],
                    |row| row.get(0),
                )
                .optional()?;
            if latest.as_deref() == Some(&sha256) {
                return Ok(None);
            }
            transaction.execute(
                "INSERT INTO config_versions(
                     sha256, content, message, actor, created_at, apply_state, apply_error
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, NULL)",
                params![
                    sha256,
                    content,
                    message,
                    actor,
                    created_at,
                    CONFIG_APPLY_APPLIED
                ],
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
                "SELECT id, sha256, message, actor, created_at, apply_state, apply_error \
                 FROM config_versions ORDER BY id DESC LIMIT ?1",
            )?;
            let rows = statement.query_map([limit], |row| {
                Ok(ConfigVersionSummary {
                    id: row.get(0)?,
                    sha256: row.get(1)?,
                    message: row.get(2)?,
                    actor: row.get(3)?,
                    created_at: row.get(4)?,
                    apply_state: row.get(5)?,
                    apply_error: row.get(6)?,
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
                    "SELECT id, sha256, content, message, actor, created_at, apply_state, apply_error \
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
                                apply_state: row.get(6)?,
                                apply_error: row.get(7)?,
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
                    "SELECT id FROM config_versions
                     WHERE sha256 = ?1
                     ORDER BY CASE apply_state
                         WHEN ?2 THEN 0
                         ELSE 1
                     END, id DESC LIMIT 1",
                    params![sha256, CONFIG_APPLY_APPLIED],
                    |row| row.get(0),
                )
                .optional()
                .map_err(Into::into)
        })
        .await
    }

    pub async fn delete_config_versions(&self, ids: Vec<i64>) -> anyhow::Result<bool> {
        self.call(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            for id in ids {
                if transaction.execute("DELETE FROM config_versions WHERE id = ?1", [id])? == 0 {
                    return Ok(false);
                }
            }
            transaction.commit()?;
            Ok(true)
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

    /// 写入一次采样并顺手裁掉过期行。
    /// 存的是内核给出的累计值原样，不是差值——重启和停机怎么算留到读取时决定，
    /// 这样以后改判断规则不必丢掉已经采到的数据。
    ///
    /// Records one sample and prunes expired rows. What is stored is the
    /// kernel's cumulative counter verbatim, never a difference: how restarts
    /// and outages are accounted for is decided at read time, so revising that
    /// rule later does not throw away samples already taken.
    pub async fn record_metric_sample(&self, sample: MetricSample) -> anyhow::Result<()> {
        self.call(move |connection| {
            connection.execute(
                "INSERT INTO metric_samples(captured_at, kernel_started_at, requests_total) \
                 VALUES(?1, ?2, ?3) \
                 ON CONFLICT(captured_at) DO UPDATE SET \
                 kernel_started_at = excluded.kernel_started_at, \
                 requests_total = excluded.requests_total",
                params![
                    sample.captured_at,
                    sample.kernel_started_at,
                    sample.requests_total
                ],
            )?;
            connection.execute(
                "DELETE FROM metric_samples WHERE captured_at < ?1",
                [sample.captured_at - METRIC_SAMPLE_RETENTION_SECONDS],
            )?;
            Ok(())
        })
        .await
    }

    /// 按时间升序读回 `since` 之后的采样。
    ///
    /// Reads samples taken at or after `since`, oldest first.
    pub async fn metric_samples_since(&self, since: i64) -> anyhow::Result<Vec<MetricSample>> {
        self.call(move |connection| {
            let mut statement = connection.prepare(
                "SELECT captured_at, kernel_started_at, requests_total FROM metric_samples \
                 WHERE captured_at >= ?1 ORDER BY captured_at ASC",
            )?;
            let samples = statement
                .query_map([since], |row| {
                    Ok(MetricSample {
                        captured_at: row.get(0)?,
                        kernel_started_at: row.get(1)?,
                        requests_total: row.get(2)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(samples)
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

    pub async fn delete_setting(&self, key: &'static str) -> anyhow::Result<()> {
        self.call(move |connection| {
            connection.execute("DELETE FROM app_settings WHERE key = ?1", [key])?;
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
    apply_migrations(&transaction, version)?;
    transaction.commit()?;
    prune_config_versions(connection)?;
    prune_audit_events(connection)?;
    Ok(())
}

/// 版本编号不再复用：没有 `AUTOINCREMENT` 时，删掉最新的一版，下一版就拿到它的编号，还停在旧 #N 的页面会把另一份
/// 内容当成 #N 应用，操作记录里的「版本 #N」也说不清是哪一份。`SQLite` 不能给已有的表加 `AUTOINCREMENT`，只能照原样
/// 重建：列、默认值、索引都和原来一样；行带着原来的编号搬过去，`sqlite_sequence` 随之记下其中最大的，以后的编号
/// 从它往上走。这张表没有外键，也没有别的表引用它。
/// Version ids are no longer reused: without `AUTOINCREMENT`, deleting the newest version hands its id to the next
/// one, a page still on the old #N applies other content as #N, and 「版本 #N」 in the audit cannot say which content
/// it was. `SQLite` cannot add `AUTOINCREMENT` to an existing table, so it is rebuilt as it was: the same columns,
/// defaults and indexes; the rows move over with their ids, `sqlite_sequence` records the largest of them, and later
/// ids count up from there. The table has no foreign keys, and no other table refers to it.
const CONFIG_VERSIONS_WITH_AUTOINCREMENT: &str = r"
    CREATE TABLE config_versions_autoincrement (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        sha256      TEXT NOT NULL,
        content     TEXT NOT NULL,
        message     TEXT NOT NULL,
        actor       TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        apply_state TEXT NOT NULL DEFAULT 'applied',
        apply_error TEXT
    );
    INSERT INTO config_versions_autoincrement(
        id, sha256, content, message, actor, created_at, apply_state, apply_error
    )
    SELECT id, sha256, content, message, actor, created_at, apply_state, apply_error
    FROM config_versions;
    DROP TABLE config_versions;
    ALTER TABLE config_versions_autoincrement RENAME TO config_versions;
    CREATE INDEX config_versions_created_idx
        ON config_versions(created_at DESC);
    CREATE INDEX config_versions_sha_idx
        ON config_versions(sha256, id DESC);
    CREATE INDEX config_versions_apply_idx
        ON config_versions(apply_state, id DESC);
    PRAGMA user_version = 6;
";

/// 逐级补齐缺失的 schema 版本。每一段只负责把版本从 n-1 推到 n，
/// 已经是最新的数据库一段都不会执行。
///
/// Brings a database up one schema version at a time. Each block moves the
/// version from n-1 to n only; a database already at the latest version runs
/// none of them.
fn apply_migrations(transaction: &rusqlite::Transaction<'_>, version: i64) -> rusqlite::Result<()> {
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
    if version < 4 {
        transaction.execute_batch(
            r"
            ALTER TABLE config_versions
                ADD COLUMN apply_state TEXT NOT NULL DEFAULT 'applied';
            ALTER TABLE config_versions
                ADD COLUMN apply_error TEXT;
            CREATE INDEX IF NOT EXISTS config_versions_apply_idx
                ON config_versions(apply_state, id DESC);
            PRAGMA user_version = 4;
            ",
        )?;
    }
    if version < 5 {
        transaction.execute_batch(
            r"
            CREATE TABLE IF NOT EXISTS metric_samples (
                captured_at       INTEGER PRIMARY KEY,
                kernel_started_at INTEGER NOT NULL,
                requests_total    INTEGER NOT NULL
            );
            PRAGMA user_version = 5;
            ",
        )?;
    }
    if version < 6 {
        transaction.execute_batch(CONFIG_VERSIONS_WITH_AUTOINCREMENT)?;
    }
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
        "DELETE FROM config_versions
         WHERE id <= COALESCE((
             SELECT id FROM config_versions ORDER BY id DESC LIMIT 1 OFFSET ?1
         ), 0)
         AND COALESCE(apply_state, 'applied') != ?2",
        params![MAX_CONFIG_VERSIONS, CONFIG_APPLY_PENDING],
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
    use rusqlite::{Connection, OptionalExtension, params};
    use tempfile::tempdir;

    use super::{
        CURRENT_SCHEMA_VERSION, Database, MAX_AUDIT_EVENTS, MAX_CONFIG_VERSIONS,
        METRIC_SAMPLE_RETENTION_SECONDS, MetricSample, prune_audit_events, prune_config_versions,
    };

    #[tokio::test]
    async fn reset_admins_brings_back_setup_and_keeps_the_audit_trail() {
        let directory = tempdir().unwrap();
        let database = Database::open(directory.path().join("panel.db"))
            .await
            .unwrap();
        database
            .create_first_user("admin".to_owned(), "hash".to_owned(), 1)
            .await
            .unwrap();
        assert!(database.has_users().await.unwrap());
        assert_eq!(database.reset_admins(2).await.unwrap(), 1);
        assert!(!database.has_users().await.unwrap());
        // 重置后能重新创建管理员 / A new administrator can be created after the reset
        database
            .create_first_user("admin2".to_owned(), "hash".to_owned(), 3)
            .await
            .unwrap();
    }

    #[test]
    fn retains_only_recent_configuration_and_audit_rows() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE config_versions (
                     id INTEGER PRIMARY KEY,
                     value TEXT,
                     apply_state TEXT NOT NULL DEFAULT 'applied'
                 );\
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
        let has_apply_state: i64 = migrated
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('config_versions')
                 WHERE name = 'apply_state'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(has_apply_state, 1);
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

    /// 一张表的全部内容和定义：每一行、每一列的定义、每个索引的列、外键
    /// A table's whole content and definition: every row, every column's definition, each index's columns, the foreign keys
    fn table_snapshot(connection: &Connection, table: &str) -> Vec<Vec<rusqlite::types::Value>> {
        let rows = |sql: &str| {
            let mut statement = connection.prepare(sql).unwrap();
            let width = statement.column_count();
            statement
                .query_map([], |row| {
                    (0..width)
                        .map(|index| row.get::<_, rusqlite::types::Value>(index))
                        .collect::<Result<Vec<_>, _>>()
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        let mut snapshot = rows(&format!("SELECT * FROM {table} ORDER BY rowid"));
        snapshot.extend(rows(&format!("PRAGMA table_info('{table}')")));
        snapshot.extend(rows(&format!("PRAGMA foreign_key_list('{table}')")));
        for index in rows(&format!(
            "SELECT name, \"unique\", origin, partial FROM pragma_index_list('{table}') ORDER BY name"
        )) {
            let rusqlite::types::Value::Text(name) = &index[0] else {
                panic!("索引名不是文本 / an index name that is not text");
            };
            snapshot.push(index.clone());
            snapshot.extend(rows(&format!("PRAGMA index_xinfo('{name}')")));
        }
        snapshot
    }

    // 删掉最新的一版以后再存，新版本拿到的是新编号：还停在旧版本 #N 的页面不会把另一份内容当成 #N 应用
    // After the newest version is deleted, the next save gets a new id: a page still on the old #N cannot apply other
    // content as #N
    #[tokio::test]
    async fn a_deleted_newest_version_id_is_never_given_again() {
        let directory = tempdir().unwrap();
        let database = Database::open(directory.path().join("panel.db"))
            .await
            .unwrap();
        let store = |message: &str| {
            database.store_pending_config_version(
                format!("sha-{message}"),
                "{}".to_owned(),
                message.to_owned(),
                "admin".to_owned(),
                1,
            )
        };
        assert_eq!(store("first").await.unwrap(), 1);
        assert_eq!(store("second").await.unwrap(), 2);
        assert!(database.delete_config_versions(vec![2]).await.unwrap());
        assert_eq!(store("third").await.unwrap(), 3);
    }

    /// 第 5 版结构（第 1 到第 5 段迁移建出来的样子），每张表放几行；版本编号 3 删过，留着空洞
    /// Schema 5 (as migrations 1 to 5 build it) with a few rows in every table; version id 3 was deleted and left a gap
    const SCHEMA_5_WITH_ROWS: &str = r"
        CREATE TABLE users (
            id            INTEGER PRIMARY KEY,
            username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
            password_hash TEXT NOT NULL,
            created_at    INTEGER NOT NULL
        );
        CREATE TABLE sessions (
            id          INTEGER PRIMARY KEY,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token_hash  TEXT NOT NULL UNIQUE,
            csrf_hash   TEXT NOT NULL,
            expires_at  INTEGER NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
        CREATE TABLE config_versions (
            id         INTEGER PRIMARY KEY,
            sha256     TEXT NOT NULL,
            content    TEXT NOT NULL,
            message    TEXT NOT NULL,
            actor      TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX config_versions_created_idx
            ON config_versions(created_at DESC);
        CREATE TABLE audit_events (
            id         INTEGER PRIMARY KEY,
            actor      TEXT,
            action     TEXT NOT NULL,
            detail     TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE app_settings (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX config_versions_sha_idx
            ON config_versions(sha256, id DESC);
        CREATE INDEX audit_events_created_idx
            ON audit_events(created_at DESC, id DESC);
        ALTER TABLE config_versions
            ADD COLUMN apply_state TEXT NOT NULL DEFAULT 'applied';
        ALTER TABLE config_versions
            ADD COLUMN apply_error TEXT;
        CREATE INDEX config_versions_apply_idx
            ON config_versions(apply_state, id DESC);
        CREATE TABLE metric_samples (
            captured_at       INTEGER PRIMARY KEY,
            kernel_started_at INTEGER NOT NULL,
            requests_total    INTEGER NOT NULL
        );
        INSERT INTO users(id, username, password_hash, created_at)
            VALUES(1, 'admin', 'hash', 10);
        INSERT INTO sessions(id, user_id, token_hash, csrf_hash, expires_at, created_at)
            VALUES(1, 1, 'token', 'csrf', 99, 11);
        INSERT INTO config_versions(id, sha256, content, message, actor, created_at)
            VALUES(1, 'sha-1', '{}', '初始配置', 'system', 12);
        INSERT INTO config_versions(id, sha256, content, message, actor, created_at, apply_state)
            VALUES(2, 'sha-2', '[1]', '改了上游', 'admin', 13, 'superseded');
        INSERT INTO config_versions
            VALUES(4, 'sha-4', '[2]', '没生效', 'admin', 14, 'failed', '端口被占用');
        INSERT INTO audit_events(id, actor, action, detail, created_at)
            VALUES(7, 'admin', 'config.save', '版本 #4', 14);
        INSERT INTO app_settings VALUES('statistics_enabled', 'true', 15);
        INSERT INTO metric_samples VALUES(16, 1, 300);
        PRAGMA user_version = 5;
";

    // 从当前的第 5 版结构迁移：每张表的行、列、索引、外键原样保留（编号有空洞也不重排），迁移前留一份备份；
    // 迁移以后删掉最新的一版再存，编号不再复用
    // Migrating from the current schema 5: every table's rows, columns, indexes and foreign keys stay as they were (ids
    // with a gap are not renumbered), with a backup taken first; deleting the newest version afterwards and saving again
    // no longer reuses its id
    #[tokio::test]
    async fn migrates_v5_config_versions_so_ids_are_never_reused() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("panel.db");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(SCHEMA_5_WITH_ROWS).unwrap();
        let tables = [
            "users",
            "sessions",
            "config_versions",
            "audit_events",
            "app_settings",
            "metric_samples",
        ];
        let before = tables.map(|table| table_snapshot(&connection, table));
        drop(connection);

        let database = Database::open(path.clone()).await.unwrap();
        let migrated = Connection::open(&path).unwrap();
        assert_eq!(tables.map(|table| table_snapshot(&migrated, table)), before);
        assert_eq!(
            migrated
                .query_row("PRAGMA foreign_key_check", [], |_| Ok(()))
                .optional()
                .unwrap(),
            None
        );
        drop(migrated);

        assert!(database.delete_config_versions(vec![4]).await.unwrap());
        let next = database
            .store_config_version(
                "sha-5".to_owned(),
                "{}".to_owned(),
                "迁移以后".to_owned(),
                "admin".to_owned(),
                17,
            )
            .await
            .unwrap();
        assert_eq!(next, 5, "the deleted newest id 4 is not given again");

        let migrated = Connection::open(&path).unwrap();
        let version: i64 = migrated
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        drop(migrated);
        let backups = database_backups(directory.path());
        assert_eq!(backups.len(), 1);
        let backup = Connection::open(&backups[0]).unwrap();
        assert_eq!(
            backup
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            5
        );
        assert_eq!(table_snapshot(&backup, "config_versions"), before[2]);
        drop(backup);

        // 再打开一次不再迁移、不再备份，编号照旧往上走 / Opening again neither migrates nor backs up, and ids keep rising
        let database = Database::open(path).await.unwrap();
        assert_eq!(database_backups(directory.path()).len(), 1);
        assert!(database.delete_config_versions(vec![5]).await.unwrap());
        let next = database
            .store_config_version(
                "sha-6".to_owned(),
                "{}".to_owned(),
                "再打开以后".to_owned(),
                "admin".to_owned(),
                18,
            )
            .await
            .unwrap();
        assert_eq!(next, 6);
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

    #[tokio::test]
    async fn keeps_metric_samples_in_order_and_drops_expired_ones() {
        let directory = tempdir().unwrap();
        let database = Database::open(directory.path().join("panel.db"))
            .await
            .unwrap();
        let now = 1_800_000_000;
        // 第一条明显早于保留期，写入后面那条时应当被裁掉。
        // 故意不取边界值：一条正好落在保留期端点上的样本留不留，
        // 不是这个用例想固定下来的语义。
        //
        // The first is well beyond the retention window and the later write
        // prunes it. The boundary itself is deliberately avoided: whether a
        // sample landing exactly on the retention edge survives is not the
        // semantic this test means to pin down.
        for (captured_at, requests_total) in [
            (now - METRIC_SAMPLE_RETENTION_SECONDS - 3_600, 10),
            (now - 120, 200),
            (now - 60, 260),
        ] {
            database
                .record_metric_sample(MetricSample {
                    captured_at,
                    kernel_started_at: 1,
                    requests_total,
                })
                .await
                .unwrap();
        }

        let samples = database.metric_samples_since(0).await.unwrap();
        assert_eq!(samples.len(), 2, "过期样本应当已被裁掉");
        assert_eq!(samples[0].captured_at, now - 120, "结果按时间升序");
        assert_eq!(samples[1].requests_total, 260);

        let recent = database.metric_samples_since(now - 90).await.unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].captured_at, now - 60);
    }

    #[tokio::test]
    async fn overwrites_a_metric_sample_taken_within_the_same_second() {
        let directory = tempdir().unwrap();
        let database = Database::open(directory.path().join("panel.db"))
            .await
            .unwrap();
        for requests_total in [100, 140] {
            database
                .record_metric_sample(MetricSample {
                    captured_at: 1_800_000_000,
                    kernel_started_at: 1,
                    requests_total,
                })
                .await
                .unwrap();
        }

        let samples = database.metric_samples_since(0).await.unwrap();
        assert_eq!(samples.len(), 1, "同一秒只保留一条，而不是写入失败");
        assert_eq!(samples[0].requests_total, 140, "后写的覆盖先写的");
    }
}
