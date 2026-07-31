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
        let systemctl = ["/usr/bin/systemctl", "/bin/systemctl"]
            .into_iter()
            .find(|path| Path::new(path).is_file())
            .ok_or("找不到 systemctl")?;
        let output = Command::new(systemctl)
            .args(["--no-ask-password", action, &args.unit])
            .output()?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            return Err(format!("systemctl 执行失败: {}", detail.trim()).into());
        }
        Ok(())
    }

    fn parse_action(action: &str) -> Result<&str, Box<dyn std::error::Error>> {
        if matches!(action, "start" | "stop" | "restart") {
            Ok(action)
        } else {
            Err("helper 只允许 start、stop 或 restart".into())
        }
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

        use super::{parse_action, validate_socket_path, validate_unit};

        #[test]
        fn accepts_only_fixed_service_actions() {
            assert!(parse_action("start").is_ok());
            assert!(parse_action("restart").is_ok());
            assert!(parse_action("restart; reboot").is_err());
            assert!(parse_action("reload").is_err());
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
