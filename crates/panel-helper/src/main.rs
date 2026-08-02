#[cfg(target_os = "linux")]
mod linux {
    use std::fs;
    use std::io::{Read, Write};
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::Duration;

    use clap::Parser;
    use rustix::fs::{Uid, chown};
    use rustix::net::sockopt::socket_peercred;

    #[derive(Debug, Parser)]
    #[command(about = "KixDNS Panel 受限服务控制 helper")]
    struct Args {
        #[arg(long, default_value = "/run/kixdns-panel/control.sock")]
        socket: PathBuf,

        #[arg(long)]
        unit: String,

        #[arg(long)]
        allowed_uid: u32,
    }

    pub fn run() -> Result<(), Box<dyn std::error::Error>> {
        let args = Args::parse();
        validate_unit(&args.unit)?;
        validate_socket_path(&args.socket)?;

        if let Ok(metadata) = fs::symlink_metadata(&args.socket) {
            if metadata.file_type().is_symlink() || !metadata.file_type().is_socket() {
                return Err(format!(
                    "helper Socket 路径不是 Unix Socket: {}",
                    args.socket.display()
                )
                .into());
            }
            fs::remove_file(&args.socket)?;
        }

        let listener = UnixListener::bind(&args.socket)?;
        fs::set_permissions(&args.socket, fs::Permissions::from_mode(0o600))?;
        chown(&args.socket, Some(Uid::from_raw(args.allowed_uid)), None)?;

        for connection in listener.incoming() {
            match connection {
                Ok(stream) => {
                    if let Err(error) = handle_connection(stream, &args) {
                        eprintln!("kixdns-panel-helper: {error}");
                    }
                }
                Err(error) => eprintln!("kixdns-panel-helper: {error}"),
            }
        }
        Ok(())
    }

    fn handle_connection(
        mut stream: UnixStream,
        args: &Args,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let credentials = socket_peercred(&stream)?;
        if credentials.uid.as_raw() != args.allowed_uid {
            return Err("拒绝非面板用户的 helper 请求".into());
        }

        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        match execute_request(&stream, args) {
            Ok(()) => {
                stream.write_all(b"OK\n")?;
                stream.flush()?;
                Ok(())
            }
            Err(error) => {
                let detail = error.to_string().replace(['\r', '\n'], " ");
                let response =
                    format!("ERROR {}\n", detail.chars().take(1_024).collect::<String>());
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
                Err(error)
            }
        }
    }

    fn execute_request(stream: &UnixStream, args: &Args) -> Result<(), Box<dyn std::error::Error>> {
        let mut request = Vec::new();
        stream.take(64).read_to_end(&mut request)?;
        let action = parse_action(std::str::from_utf8(&request)?.trim())?;
        if action == ServiceAction::PanelUpdate {
            return launch_panel_update();
        }
        let systemctl = find_executable(&["/usr/bin/systemctl", "/bin/systemctl"])
            .ok_or("找不到 systemctl")?;
        let mut command = Command::new(systemctl);
        command.arg("--no-ask-password");
        command.args(systemctl_arguments(action, &args.unit));
        let output = command.output()?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            return Err(format!("systemctl 执行失败: {}", detail.trim()).into());
        }
        Ok(())
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum ServiceAction {
        Start,
        Stop,
        Restart,
        PanelUpdate,
    }

    fn parse_action(action: &str) -> Result<ServiceAction, Box<dyn std::error::Error>> {
        match action {
            "start" => Ok(ServiceAction::Start),
            "stop" => Ok(ServiceAction::Stop),
            "restart" => Ok(ServiceAction::Restart),
            "panel-update" => Ok(ServiceAction::PanelUpdate),
            _ => Err("helper 请求动作不受支持".into()),
        }
    }

    fn systemctl_arguments(action: ServiceAction, unit: &str) -> Vec<&str> {
        match action {
            ServiceAction::Start => vec!["enable", "--now", unit],
            ServiceAction::Stop => vec!["disable", "--now", unit],
            ServiceAction::Restart => vec!["restart", unit],
            ServiceAction::PanelUpdate => Vec::new(),
        }
    }

    fn launch_panel_update() -> Result<(), Box<dyn std::error::Error>> {
        use std::os::unix::fs::MetadataExt;

        const UPDATER: &str = "/usr/local/libexec/kixdns-panel-online-update";
        let metadata = fs::symlink_metadata(UPDATER)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.uid() != 0
            || metadata.mode() & 0o022 != 0
        {
            return Err("面板在线更新器权限无效".into());
        }
        let systemd_run = find_executable(&["/usr/bin/systemd-run", "/bin/systemd-run"])
            .ok_or("找不到 systemd-run")?;
        let output = Command::new(systemd_run)
            .args([
                "--quiet",
                "--collect",
                "--unit=kixdns-panel-update.service",
                "--property=Type=exec",
                UPDATER,
            ])
            .output()?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            return Err(format!("启动面板在线更新失败: {}", detail.trim()).into());
        }
        Ok(())
    }

    fn find_executable<'a>(paths: &[&'a str]) -> Option<&'a str> {
        paths.iter().copied().find(|path| Path::new(path).is_file())
    }

    fn validate_unit(unit: &str) -> Result<(), Box<dyn std::error::Error>> {
        if unit.is_empty()
            || unit.len() > 128
            || !unit.ends_with(".service")
            || !unit
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            || unit.contains("..")
            || !unit.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'_' | b'-' | b'.')
            })
        {
            return Err("KixDNS systemd unit 名称无效".into());
        }
        Ok(())
    }

    fn validate_socket_path(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
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

    #[cfg(test)]
    mod tests {
        use std::path::Path;

        use super::{
            ServiceAction, parse_action, systemctl_arguments, validate_socket_path, validate_unit,
        };

        #[test]
        fn accepts_only_fixed_service_actions() {
            assert_eq!(parse_action("start").unwrap(), ServiceAction::Start);
            assert_eq!(parse_action("stop").unwrap(), ServiceAction::Stop);
            assert_eq!(parse_action("restart").unwrap(), ServiceAction::Restart);
            assert_eq!(
                parse_action("panel-update").unwrap(),
                ServiceAction::PanelUpdate
            );
            assert!(parse_action("restart; reboot").is_err());
            assert!(parse_action("reload").is_err());
        }

        #[test]
        fn persists_start_and_stop_state() {
            assert_eq!(
                systemctl_arguments(ServiceAction::Start, "kixdns.service"),
                ["enable", "--now", "kixdns.service"]
            );
            assert_eq!(
                systemctl_arguments(ServiceAction::Stop, "kixdns.service"),
                ["disable", "--now", "kixdns.service"]
            );
            assert_eq!(
                systemctl_arguments(ServiceAction::Restart, "kixdns.service"),
                ["restart", "kixdns.service"]
            );
            assert!(systemctl_arguments(ServiceAction::PanelUpdate, "kixdns.service").is_empty());
        }

        #[test]
        fn validates_unit_and_socket_arguments() {
            assert!(validate_unit("kixdns.service").is_ok());
            assert!(validate_unit("kixdns@edge.service").is_ok());
            assert!(validate_unit("../sshd.service").is_err());
            assert!(validate_socket_path(Path::new("/run/kixdns-panel/control.sock")).is_ok());
            assert!(validate_socket_path(Path::new("relative.sock")).is_err());
        }
    }
}

#[cfg(target_os = "linux")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    linux::run()
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("kixdns-panel-helper 仅支持 Linux");
}
