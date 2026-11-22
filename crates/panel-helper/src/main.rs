#[cfg(target_os = "linux")]
mod linux {
    use std::fs;
    use std::io::{Read, Write};
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{Duration, Instant};

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

        /// 没有 systemctl 时（OpenWrt/procd）用它启停：`脚本 enable start` / `stop disable` / `restart`。
        /// Used instead of systemctl when there is none (OpenWrt/procd).
        #[arg(long, default_value = "/etc/init.d/kixdns")]
        init_script: PathBuf,
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
        // 有 systemd 时行为和以前完全一样：走 systemctl。
        // With systemd present the behaviour is unchanged: go through systemctl.
        if let Some(systemctl) = find_executable(&["/usr/bin/systemctl", "/bin/systemctl"]) {
            let mut command = Command::new(systemctl);
            command.arg("--no-ask-password");
            command.args(systemctl_arguments(action, &args.unit));
            let output = command.output()?;
            if !output.status.success() {
                let detail = String::from_utf8_lossy(&output.stderr);
                return Err(format!("systemctl 执行失败: {}", detail.trim()).into());
            }
            return Ok(());
        }
        // 没有 systemd（OpenWrt/procd）时改用 init 脚本，并保持和 systemd 一致的持久化语义：
        // 启用 = enable + start，停用 = stop + disable。否则路由器重启后内核又会自己起来。
        // Without systemd (OpenWrt/procd) fall back to the init script, keeping systemd's
        // persistence semantics: enable = enable + start, disable = stop + disable. Otherwise
        // the kernel comes back by itself after a router reboot.
        if args.init_script.is_file() {
            if !check_root_executable(&args.init_script)? {
                return Err(format!(
                    "init 脚本权限无效：{}（要 root 所有、组和其他用户不可写的普通文件）",
                    args.init_script.display()
                )
                .into());
            }
            let service = service_name(&args.unit);
            // 动作前记下运行 pid：restart 后要等新进程真正起来（pid 变了）再返回，
            // 否则面板拿到的还是旧进程的 active/running。
            // Remember the running pid before the action: after restart we wait until the new
            // process is up (pid changed), otherwise the panel still sees the old active/running.
            let before = match action {
                ServiceAction::Restart => ubus_snapshot(service),
                _ => UbusState::Unknown,
            };
            for verb in init_script_verbs(action) {
                let output = Command::new(&args.init_script).arg(verb).output()?;
                if !output.status.success() {
                    let detail = String::from_utf8_lossy(&output.stderr);
                    return Err(format!(
                        "{} {verb} 执行失败: {}",
                        args.init_script.display(),
                        detail.trim()
                    )
                    .into());
                }
            }
            // procd 的 stop/restart 不等进程退出就返回；等状态落定再回 OK。
            // procd's stop/restart returns before the process exits; wait for the state to
            // settle before replying OK.
            wait_for_settle(action, service, before);
            return Ok(());
        }
        Err("找不到 systemctl，也没有可用的 init 脚本".into())
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

    /// 没有 systemd 时 init 脚本要按顺序跑的动作，语义对齐 systemctl 的 enable/disable。
    /// The verbs to run, in order, against the init script when there is no systemd, matching
    /// systemctl's enable/disable semantics.
    fn init_script_verbs(action: ServiceAction) -> &'static [&'static str] {
        match action {
            ServiceAction::Start => &["enable", "start"],
            ServiceAction::Stop => &["stop", "disable"],
            ServiceAction::Restart => &["restart"],
            ServiceAction::PanelUpdate => &[],
        }
    }

    /// `ubus call service list` 里一个服务的运行状态。
    /// The running state of one service in `ubus call service list`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum UbusState {
        /// 服务不在列表里：还没起来或被 procd 清掉。
        Absent,
        /// 在列表里但没有 running 的实例：启动失败之类。
        NotRunning,
        /// 有 running 实例，附带 pid（可能取不到）。
        Running(Option<u32>),
        /// 拿不到 ubus 或不是 JSON，无法判断。
        Unknown,
    }

    /// `kixdns.service` → `kixdns`：procd/ubus 里都用短名。
    fn service_name(unit: &str) -> &str {
        unit.strip_suffix(".service").unwrap_or(unit)
    }

    fn ubus_snapshot(service: &str) -> UbusState {
        let Some(ubus) = find_executable(&["/usr/bin/ubus", "/bin/ubus"]) else {
            return UbusState::Unknown;
        };
        let request = format!("{{\"name\":\"{service}\"}}");
        let Ok(output) = Command::new(ubus)
            .args(["call", "service", "list", &request])
            .output()
        else {
            return UbusState::Unknown;
        };
        if !output.status.success() {
            return UbusState::Unknown;
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
            return UbusState::Unknown;
        };
        let Some(entry) = value.get(service) else {
            return UbusState::Absent;
        };
        if let Some(instances) = entry
            .get("instances")
            .and_then(serde_json::Value::as_object)
        {
            for instance in instances.values() {
                if instance.get("running").and_then(serde_json::Value::as_bool) == Some(true) {
                    let pid = instance
                        .get("pid")
                        .and_then(serde_json::Value::as_u64)
                        .and_then(|pid| u32::try_from(pid).ok());
                    return UbusState::Running(pid);
                }
            }
        }
        UbusState::NotRunning
    }

    /// procd 的 stop/restart 不等进程退出就返回；等状态落定再回 OK，面板才不会读到旧状态。
    /// 最多等 `term_timeout`（procd 里 5s）再加 1s 余量。
    /// procd's stop/restart returns before the process exits; wait until the state settles so the
    /// panel does not read a stale state. Waits up to the 5s term timeout plus a 1s margin.
    fn wait_for_settle(action: ServiceAction, service: &str, before: UbusState) {
        // 没有 ubus 根本无从判断，不能平白加 6 秒延迟。
        if find_executable(&["/usr/bin/ubus", "/bin/ubus"]).is_none() {
            return;
        }
        let before_pid = match before {
            UbusState::Running(pid) => pid,
            _ => None,
        };
        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            let state = ubus_snapshot(service);
            if reached_goal(action, before_pid, state) || Instant::now() >= deadline {
                return;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    /// 动作的目标状态是否已经达到：stop 要服务消失或不再 running；restart 要新进程起来
    /// （pid 变了）；start 不额外等。
    /// Whether the action's goal state has been reached: stop wants the service gone or not
    /// running; restart wants a new process up (pid changed); start does not wait here.
    fn reached_goal(action: ServiceAction, before_pid: Option<u32>, state: UbusState) -> bool {
        match action {
            ServiceAction::Restart => match state {
                UbusState::Running(pid) => match (before_pid, pid) {
                    (Some(old), Some(new)) => old != new,
                    _ => true,
                },
                _ => false,
            },
            ServiceAction::Stop => matches!(state, UbusState::Absent | UbusState::NotRunning),
            ServiceAction::Start | ServiceAction::PanelUpdate => true,
        }
    }

    /// helper 以 root 身份执行的文件（在线更新器、init 脚本）只认 root 所有、组和其他用户写不进的普通文件，不认符号链接：
    /// 不然能改这个文件或者链接目标的人，就能借 helper 以 root 跑任意命令。读不到文件时把错误原样交出去
    ///
    /// Files the helper runs as root (the online updater, the init script) are trusted only as regular files owned by root
    /// that neither group nor others can write, never through a symlink: otherwise whoever can change the file or the
    /// link target runs any command as root through the helper. When the file cannot be read the error is handed on as is
    fn check_root_executable(path: &Path) -> std::io::Result<bool> {
        use std::os::unix::fs::MetadataExt;

        let metadata = fs::symlink_metadata(path)?;
        Ok(!metadata.file_type().is_symlink()
            && metadata.is_file()
            && metadata.uid() == 0
            && metadata.mode() & 0o022 == 0)
    }

    fn launch_panel_update() -> Result<(), Box<dyn std::error::Error>> {
        const UPDATER: &str = "/usr/local/libexec/kixdns-panel-online-update";
        if !check_root_executable(Path::new(UPDATER))? {
            return Err("面板在线更新器权限无效".into());
        }
        // 没有 systemd-run 的平台（OpenWrt/procd、musl）暂时不支持在线更新：更新器是给
        // glibc 打的包，硬装会把 glibc 二进制塞进 musl 系统。先明确拒绝，等 musl 内核/面板
        // 包发布后再打开。
        // Platforms without systemd-run (OpenWrt/procd, musl) do not support online updates yet:
        // the updater ships glibc binaries and would drop them into a musl system. Refuse clearly
        // until musl kernel/panel packages are published.
        let Some(systemd_run) = find_executable(&["/usr/bin/systemd-run", "/bin/systemd-run"])
        else {
            return Err(
                "当前平台暂不支持在线更新（没有 systemd-run；musl 版安装包尚未发布）".into(),
            );
        };
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
            ServiceAction, UbusState, check_root_executable, init_script_verbs, parse_action,
            reached_goal, service_name, systemctl_arguments, validate_socket_path, validate_unit,
        };

        /// 以 root 跑的 init 脚本：组或其他用户可写的、不归 root 的、符号链接都不认；读不到的把错误交出去。
        /// 测试以普通用户跑时自己建的文件不归 root，以 root 跑（比如在路由器上）时就归 root，两种都对得上
        /// The init script run as root: group- or other-writable, not owned by root, or a symlink is refused; an
        /// unreadable one hands on the error. Run as a normal user the test's own file is not root's; run as root (on a
        /// router, say) it is, and both cases hold
        #[test]
        fn init_script_must_be_a_root_owned_file_nobody_else_can_write() {
            use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};

            let directory =
                std::env::temp_dir().join(format!("kixdns-helper-test-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&directory);
            std::fs::create_dir_all(&directory).unwrap();
            let script = directory.join("kixdns");
            std::fs::write(&script, "#!/bin/sh\n").unwrap();

            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o775)).unwrap();
            assert!(!check_root_executable(&script).unwrap(), "组可写不认");
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o757)).unwrap();
            assert!(!check_root_executable(&script).unwrap(), "其他用户可写不认");

            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            let owned_by_root = std::fs::metadata(&script).unwrap().uid() == 0;
            assert_eq!(check_root_executable(&script).unwrap(), owned_by_root);

            let link = directory.join("link");
            symlink(&script, &link).unwrap();
            assert!(!check_root_executable(&link).unwrap(), "符号链接不认");
            assert!(check_root_executable(&directory.join("missing")).is_err());

            std::fs::remove_dir_all(&directory).unwrap();
        }

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
        fn init_script_matches_systemd_persistence() {
            // procd 下没有 systemd，init 脚本也要做到 enable+start / stop+disable，
            // 否则重启后内核又会自己起来。
            assert_eq!(init_script_verbs(ServiceAction::Start), ["enable", "start"]);
            assert_eq!(init_script_verbs(ServiceAction::Stop), ["stop", "disable"]);
            assert_eq!(init_script_verbs(ServiceAction::Restart), ["restart"]);
            assert!(init_script_verbs(ServiceAction::PanelUpdate).is_empty());
        }

        #[test]
        fn waits_for_procd_to_settle_after_stop_and_restart() {
            // stop：服务消失或没有 running 实例才算停好。
            assert!(!reached_goal(
                ServiceAction::Stop,
                None,
                UbusState::Running(Some(3260))
            ));
            assert!(reached_goal(ServiceAction::Stop, None, UbusState::Absent));
            assert!(reached_goal(
                ServiceAction::Stop,
                None,
                UbusState::NotRunning
            ));
            // restart：要等新进程（pid 变了）才算重启好，旧 pid 还在不算。
            assert!(!reached_goal(
                ServiceAction::Restart,
                Some(3260),
                UbusState::Running(Some(3260))
            ));
            assert!(reached_goal(
                ServiceAction::Restart,
                Some(3260),
                UbusState::Running(Some(3300))
            ));
            assert!(!reached_goal(
                ServiceAction::Restart,
                Some(3260),
                UbusState::Absent
            ));
            // 取不到旧 pid 时，只要见到 running 就算数。
            assert!(reached_goal(
                ServiceAction::Restart,
                None,
                UbusState::Running(Some(3300))
            ));
            // start 不额外等。
            assert!(reached_goal(ServiceAction::Start, None, UbusState::Unknown));
        }

        #[test]
        fn service_name_drops_the_systemd_suffix() {
            assert_eq!(service_name("kixdns.service"), "kixdns");
            assert_eq!(service_name("kixdns"), "kixdns");
        }

        #[test]
        fn validates_unit_and_socket_arguments() {
            assert!(validate_unit("kixdns.service").is_ok());
            assert!(validate_unit("kixdns@edge.service").is_ok());
            assert!(validate_unit("../sshd.service").is_err());
            assert!(validate_socket_path(Path::new("/run/kixdns-panel/control.sock")).is_ok());
            assert!(validate_socket_path(Path::new("relative.sock")).is_err());
        }

        /// 与 panel-server 的 `Operations::new` 和 scripts/test-unit-name-rule.sh
        /// 共用同一份名单：helper 是 unit 名的第二个 Rust 校验点，不能自己漂走。
        /// Shares one fixture list with panel-server's `Operations::new` and
        /// scripts/test-unit-name-rule.sh: the helper is the second Rust site
        /// validating the unit name and must not drift on its own.
        #[test]
        fn unit_name_rule_matches_the_installer_fixtures() {
            for unit in [
                "kixdns.service",
                "kixdns@x.service",
                "k.service",
                "0k.service",
                "a-b_c.d.service",
            ] {
                assert!(validate_unit(unit).is_ok(), "should accept {unit}");
            }
            let too_long = format!("{}.service", "k".repeat(121));
            for unit in [
                "_kixdns.service",
                "-x.service",
                ".hidden.service",
                "@inst.service",
                "a..b.service",
                "kixdns",
                "",
                too_long.as_str(),
            ] {
                assert!(validate_unit(unit).is_err(), "should reject {unit:?}");
            }
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
