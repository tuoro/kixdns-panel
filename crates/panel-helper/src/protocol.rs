//! helper 套接字的协议：面板写一个动作，helper 回一行 `OK`（`status` 带上状态）或 `ERROR 原因`。服务控制模式和看管模式共用
//!
//! The helper socket protocol: the panel writes one action, the helper answers one line, `OK` (with the state for
//! `status`) or `ERROR <reason>`. Shared by the service-control mode and the supervise mode

use std::error::Error;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::time::Duration;

use rustix::fs::{Uid, chown};
use rustix::net::sockopt::socket_peercred;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
    PanelUpdate,
    /// 内核现在的状态；只有看管模式回答 / The kernel's current state; only the supervise mode answers it
    Status,
}

pub fn parse_action(action: &str) -> Result<ServiceAction, Box<dyn Error>> {
    match action {
        "start" => Ok(ServiceAction::Start),
        "stop" => Ok(ServiceAction::Stop),
        "restart" => Ok(ServiceAction::Restart),
        "panel-update" => Ok(ServiceAction::PanelUpdate),
        "status" => Ok(ServiceAction::Status),
        _ => Err("helper 请求动作不受支持".into()),
    }
}

pub fn validate_socket_path(path: &Path) -> Result<(), Box<dyn Error>> {
    if !path.is_absolute()
        || path.as_os_str().len() > 255
        || path
            .components()
            .any(|component| component.as_os_str() == "..")
    {
        return Err("helper Socket 路径无效".into());
    }
    Ok(())
}

/// 绑好 helper 套接字：路径上原来的套接字先删掉（别的东西不删），新的只给 `owner` 读写
///
/// Binds the helper socket: an old socket at the path goes first (anything else stays), and the new one is readable and
/// writable by `owner` only
pub fn listen(path: &Path, owner: u32) -> Result<UnixListener, Box<dyn Error>> {
    validate_socket_path(path)?;
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.file_type().is_socket() {
            return Err(format!("helper Socket 路径不是 Unix Socket: {}", path.display()).into());
        }
        fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    chown(path, Some(Uid::from_raw(owner)), None)?;
    Ok(listener)
}

/// 答一个连接：只认 `allowed_uid` 的请求，读出动作交给 `handle`，它给的详情跟在 `OK` 后面，出错回 `ERROR 原因`
///
/// Answers one connection: only requests from `allowed_uid` count; the action read goes to `handle`, whose detail follows
/// `OK`, and an error answers `ERROR <reason>`
pub fn answer(
    mut stream: UnixStream,
    allowed_uid: u32,
    handle: impl FnOnce(ServiceAction) -> Result<String, Box<dyn Error>>,
) -> Result<(), Box<dyn Error>> {
    let credentials = socket_peercred(&stream)?;
    if credentials.uid.as_raw() != allowed_uid {
        return Err("拒绝非面板用户的 helper 请求".into());
    }
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let outcome = read_action(&stream).and_then(handle);
    let response = match &outcome {
        Ok(detail) if detail.is_empty() => "OK\n".to_owned(),
        Ok(detail) => format!("OK {detail}\n"),
        Err(error) => {
            let detail = error.to_string().replace(['\r', '\n'], " ");
            format!("ERROR {}\n", detail.chars().take(1_024).collect::<String>())
        }
    };
    let written = stream
        .write_all(response.as_bytes())
        .and_then(|()| stream.flush());
    outcome?;
    Ok(written?)
}

fn read_action(stream: &UnixStream) -> Result<ServiceAction, Box<dyn Error>> {
    let mut request = Vec::new();
    stream.take(64).read_to_end(&mut request)?;
    parse_action(std::str::from_utf8(&request)?.trim())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{ServiceAction, parse_action, validate_socket_path};

    #[test]
    fn accepts_only_fixed_service_actions() {
        assert_eq!(parse_action("start").unwrap(), ServiceAction::Start);
        assert_eq!(parse_action("stop").unwrap(), ServiceAction::Stop);
        assert_eq!(parse_action("restart").unwrap(), ServiceAction::Restart);
        assert_eq!(
            parse_action("panel-update").unwrap(),
            ServiceAction::PanelUpdate
        );
        assert_eq!(parse_action("status").unwrap(), ServiceAction::Status);
        assert!(parse_action("restart; reboot").is_err());
        assert!(parse_action("reload").is_err());
    }

    #[test]
    fn validates_socket_arguments() {
        assert!(validate_socket_path(Path::new("/run/kixdns-panel/control.sock")).is_ok());
        assert!(validate_socket_path(Path::new("relative.sock")).is_err());
        assert!(validate_socket_path(Path::new("/run/../etc/control.sock")).is_err());
    }
}
