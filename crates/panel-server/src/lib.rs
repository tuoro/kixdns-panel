mod app;
mod auth;
mod config_capabilities;
mod config_store;
mod control;
mod db;
mod digest;
mod error;
mod geo_data;
mod operations;
mod panel_update;
mod recent_window;
mod updates;

pub use app::{AppSettings, build_app, run};
pub use auth::TrustedProxies;

/// 忘记密码时在面板所在的机器上执行：删除所有管理员和会话，面板回到「创建管理员」。返回删掉了几个管理员。
/// Run on the panel's machine after a forgotten password: deletes every administrator and session so the panel opens on
/// 创建管理员 again. Returns how many administrators were removed.
///
/// # Errors
///
/// Fails when the database cannot be opened or written.
pub async fn reset_admins(database_path: std::path::PathBuf) -> anyhow::Result<usize> {
    let database = db::Database::open(database_path).await?;
    database.reset_admins(auth::unix_timestamp()).await
}
