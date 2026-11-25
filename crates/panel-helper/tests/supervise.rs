//! 看管模式整体跑一遍：真起 `kixdns-panel-helper supervise`，内核和面板换成记事的 shell 脚本，经 helper 套接字发请求。普通用户跑时
//! 内核、面板都用自己的身份；以 root 跑（比如在 `OpenWrt` 虚拟机上）时用两个别的用户，顺带看降权和能力对不对
//!
//! The supervise mode end to end: a real `kixdns-panel-helper supervise` with shell scripts that take notes standing in
//! for the kernel and the panel, driven through the helper socket. Run as a normal user the kernel and the panel use its
//! own identity; run as root (on an `OpenWrt` VM, say) they use two other users, and the lowered privileges and the
//! capability are checked as well
#![cfg(target_os = "linux")]

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use rustix::process::{Gid, Uid, getgid, getuid};
use rustix::thread::{set_thread_res_gid, set_thread_res_uid};

const KERNEL: &str = "#!/bin/sh\necho \"kernel $$ $*\"\nexec sleep 600\n";
const CRASHING_KERNEL: &str = "#!/bin/sh\necho \"crash $$\"\nexit 3\n";

struct Supervisor {
    root: tempfile::TempDir,
    child: Option<Child>,
    ids: [u32; 3],
}

impl Supervisor {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let ids = if getuid().is_root() {
            [5533, 5738, 5533]
        } else {
            [getuid().as_raw(), getuid().as_raw(), getgid().as_raw()]
        };
        let image = root.path().join("image");
        write(&image.join("etc/pipeline.json"), "{}", 0o644);
        write(&image.join("bin/kixdns"), KERNEL, 0o755);
        write(
            &image.join("bin/kixdns-panel-server"),
            &panel_script(0),
            0o755,
        );
        // 面板以别的用户跑时也要记得下来 / Writable by the panel when it runs as another user
        write(&root.path().join("panel-runs"), "", 0o666);
        Self {
            root,
            child: None,
            ids,
        }
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.root.path().join(relative)
    }

    fn start(&mut self) {
        let [kernel, panel, group] = self.ids;
        // 上一次留下的套接字文件先删掉，等到的才是这一次的 / The socket file the last run left goes first, so the one waited
        // for is this run's
        let socket = self.path("run/kixdns-panel/control.sock");
        let _ = std::fs::remove_file(&socket);
        let child = Command::new(env!("CARGO_BIN_EXE_kixdns-panel-helper"))
            .arg("supervise")
            .arg("--image")
            .arg(self.path("image"))
            .arg("--data")
            .arg(self.path("data"))
            .arg("--run")
            .arg(self.path("run"))
            .args(["--kernel-uid", &kernel.to_string()])
            .args(["--panel-uid", &panel.to_string()])
            .args(["--gid", &group.to_string()])
            .env_remove("RUST_LOG")
            .spawn()
            .unwrap();
        self.child = Some(child);
        wait_for("helper 套接字", || socket.exists());
    }

    /// SIGTERM 以后它要自己停下面板和内核、正常退出 / After SIGTERM it stops the panel and the kernel itself and exits cleanly
    fn stop(&mut self) {
        let mut child = self.child.take().unwrap();
        let pid = rustix::process::Pid::from_child(&child);
        rustix::process::kill_process(pid, rustix::process::Signal::TERM).unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success(), "看管进程退出状态 {status}");
                return;
            }
            assert!(Instant::now() < deadline, "看管进程 15 秒内没有退出");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// 以面板的身份问一句：root 跑时在一个单独的线程里换成面板用户再连（换身份只换这个线程）
    /// Asks as the panel: run as root, the connection is made from a thread of its own switched to the panel user (the
    /// switch only affects that thread)
    fn ask(&self, action: &str) -> String {
        let socket = self.path("run/kixdns-panel/control.sock");
        let [_, panel, group] = self.ids;
        let action = action.to_owned();
        std::thread::spawn(move || {
            if getuid().as_raw() != panel {
                set_thread_res_gid(
                    Gid::from_raw(group),
                    Gid::from_raw(group),
                    Gid::from_raw(group),
                )
                .unwrap();
                set_thread_res_uid(
                    Uid::from_raw(panel),
                    Uid::from_raw(panel),
                    Uid::from_raw(panel),
                )
                .unwrap();
            }
            let mut stream = UnixStream::connect(socket).unwrap();
            stream.write_all(action.as_bytes()).unwrap();
            stream.shutdown(std::net::Shutdown::Write).unwrap();
            let mut reply = String::new();
            stream.read_to_string(&mut reply).unwrap();
            reply.trim_end().to_owned()
        })
        .join()
        .unwrap()
    }

    /// 内核在跑时它的 pid / The kernel's pid while it runs
    fn kernel_pid(&self) -> Option<u32> {
        self.ask("status")
            .strip_prefix("OK active running ")
            .map(|pid| pid.parse().unwrap())
    }

    fn kernel_log(&self) -> String {
        std::fs::read_to_string(self.path("data/logs/kixdns.log")).unwrap_or_default()
    }

    /// 面板每次启动记一行「pid 网页目录」/ The panel notes "pid web-root" at each start
    fn panel_runs(&self) -> Vec<(u32, String)> {
        std::fs::read_to_string(self.path("panel-runs"))
            .unwrap()
            .lines()
            .map(|line| {
                let (pid, web) = line.split_once(' ').unwrap();
                (pid.parse().unwrap(), web.to_owned())
            })
            .collect()
    }

    fn online_panel(&self, version: &str, exit: i32) -> PathBuf {
        let dir = self.path("data/panel").join(version);
        write(&dir.join("PANEL_RELEASE"), &format!("v{version}\n"), 0o644);
        write(&dir.join("web/index.html"), "<!doctype html>", 0o644);
        write(
            &dir.join("bin/kixdns-panel-server"),
            &panel_script(exit),
            0o755,
        );
        dir
    }
}

/// 测试半路失败时也让它自己停下内核和面板，不留下没人管的子进程 / A test failing half way still lets it stop the kernel and
/// the panel itself, so no child is left behind
impl Drop for Supervisor {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let pid = rustix::process::Pid::from_child(&child);
            let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
            let _ = child.wait();
        }
    }
}

/// 记下自己的 pid 和网页目录；`exit` 不是 0 就马上以它退出，是 0 就一直跑。顺手留一个孤儿给看管进程收
/// Notes its pid and web root; a non-zero `exit` exits with it at once, zero runs on. It leaves an orphan behind for the
/// supervisor to reap
fn panel_script(exit: i32) -> String {
    let tail = if exit == 0 {
        "exec sleep 600".to_owned()
    } else {
        format!("exit {exit}")
    };
    format!(
        "#!/bin/sh\necho \"$$ $KIXDNS_WEB_ROOT\" >> \"$KIXDNS_CONTAINER_DATA/../panel-runs\"\n(sleep 1 &)\n{tail}\n"
    )
}

fn write(path: &Path, content: &str, mode: u32) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".tmp");
    std::fs::write(&temporary, content).unwrap();
    std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(mode)).unwrap();
    std::fs::rename(&temporary, path).unwrap();
}

fn wait_for(what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !ready() {
        assert!(Instant::now() < deadline, "20 秒内没等到{what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

fn proc_field(pid: u32, file: &str, field: &str) -> String {
    std::fs::read_to_string(format!("/proc/{pid}/{file}"))
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix(field).map(|rest| rest.trim().to_owned()))
        .unwrap_or_else(|| panic!("/proc/{pid}/{file} 没有 {field}"))
}

/// 内核和面板起来、听面板的启停，停了以后重启看管进程还是停着；以 root 跑时内核是降了权、只带绑定低端口能力的普通用户
/// The kernel and the panel come up and obey the panel's start and stop, a stop survives a supervisor restart; run as root
/// the kernel is an ordinary user with lowered privileges holding only the low-port binding capability
#[test]
fn the_kernel_runs_and_obeys_the_panel() {
    let mut supervisor = Supervisor::new();
    supervisor.start();
    wait_for("内核起来", || supervisor.kernel_pid().is_some());
    let first = supervisor.kernel_pid().unwrap();
    assert_eq!(
        std::fs::read_to_string(supervisor.path("data/kernels/kixdns")).unwrap(),
        KERNEL,
        "第一次启动放一份镜像里的内核"
    );
    assert_eq!(
        std::fs::read_to_string(supervisor.path("data/config/pipeline.json")).unwrap(),
        "{}"
    );
    wait_for("内核写日志", || {
        supervisor
            .kernel_log()
            .contains(&format!("kernel {first} run --config"))
    });
    wait_for("面板起来", || !supervisor.panel_runs().is_empty());
    assert_eq!(
        supervisor.panel_runs()[0].1,
        supervisor.path("image/web").display().to_string()
    );
    if getuid().is_root() {
        assert_eq!(
            proc_field(first, "status", "Uid:"),
            "5533\t5533\t5533\t5533"
        );
        assert_eq!(
            proc_field(first, "status", "Gid:"),
            "5533\t5533\t5533\t5533"
        );
        assert_eq!(proc_field(first, "status", "CapEff:"), "0000000000000400");
        assert_eq!(proc_field(first, "status", "CapAmb:"), "0000000000000400");
        assert_eq!(proc_field(first, "status", "NoNewPrivs:"), "1");
        let panel = supervisor.panel_runs()[0].0;
        assert_eq!(
            proc_field(panel, "status", "Uid:"),
            "5738\t5738\t5738\t5738"
        );
        assert_eq!(proc_field(panel, "status", "CapEff:"), "0000000000000000");
    }
    let limits = proc_field(first, "limits", "Max open files");
    assert!(limits.starts_with("65536"), "{limits}");
    assert_eq!(
        limits.split_whitespace().take(2).collect::<Vec<_>>(),
        ["65536", "65536"]
    );

    assert_eq!(supervisor.ask("restart"), "OK");
    let second = supervisor.kernel_pid().unwrap();
    assert_ne!(first, second, "restart 回 OK 时新的内核已经起来");
    assert!(!alive(first));

    assert_eq!(supervisor.ask("stop"), "OK");
    assert_eq!(supervisor.ask("status"), "OK inactive dead 0");
    assert!(!alive(second), "stop 回 OK 时内核已经退出");
    assert!(supervisor.ask("reload").starts_with("ERROR "));

    // 孤儿（面板留下的 sleep 1）也收掉了：看管进程名下没有僵尸 / Orphans (the panel's leftover sleep 1) are reaped too: no
    // zombie under the supervisor
    let me = supervisor.child.as_ref().unwrap().id();
    std::thread::sleep(Duration::from_millis(1_500));
    let zombies: Vec<_> = std::fs::read_dir("/proc")
        .unwrap()
        .filter_map(|entry| std::fs::read_to_string(entry.ok()?.path().join("stat")).ok())
        .filter(|stat| {
            let fields: Vec<_> = stat
                .rsplit_once(')')
                .unwrap()
                .1
                .split_whitespace()
                .collect();
            fields[0] == "Z" && fields[1] == me.to_string()
        })
        .collect();
    assert!(zombies.is_empty(), "{zombies:?}");

    // 停着的内核在看管进程重启（重建容器）以后还是停着 / A stopped kernel stays stopped across a supervisor restart (a
    // container rebuild)
    let panel = supervisor.panel_runs()[0].0;
    supervisor.stop();
    assert!(!alive(panel), "看管进程退出前停下面板");
    supervisor.start();
    wait_for("面板再起来", || supervisor.panel_runs().len() == 2);
    assert_eq!(supervisor.ask("status"), "OK inactive dead 0");
    assert_eq!(supervisor.ask("start"), "OK");
    let third = supervisor.kernel_pid().expect("start 回 OK 时内核已经起来");
    supervisor.stop();
    assert!(!alive(third), "看管进程退出前停下内核");
}

/// 内核自己崩了：状态是在重拉，5 秒后拉起来 / The kernel crashes by itself: the state reads as being brought back, and it is
/// up again after 5 seconds
#[test]
fn a_crashed_kernel_is_brought_back() {
    let mut supervisor = Supervisor::new();
    supervisor.start();
    wait_for("内核起来", || supervisor.kernel_pid().is_some());
    write(
        &supervisor.path("data/kernels/kixdns"),
        CRASHING_KERNEL,
        0o755,
    );
    assert_eq!(supervisor.ask("restart"), "OK");
    wait_for("内核崩了在重拉", || {
        supervisor.ask("status") == "OK activating auto-restart 0"
    });
    write(&supervisor.path("data/kernels/kixdns"), KERNEL, 0o755);
    wait_for("内核重新拉起来", || {
        supervisor.kernel_pid().is_some()
    });
    assert_eq!(supervisor.kernel_log().matches("crash ").count(), 1);
    supervisor.stop();
}

/// 在线装的新面板起不来就退回镜像里的，原因记下来，内核一直跑着；再点在线更新就重新试它
/// A new panel installed online that does not come up gives way to the image's with the reason recorded, while the kernel
/// keeps running; another online update tries it again
#[test]
fn a_failing_online_panel_falls_back_while_dns_keeps_running() {
    let mut supervisor = Supervisor::new();
    let online = supervisor.online_panel("999.0.0", 1);
    supervisor.start();
    wait_for("内核起来", || supervisor.kernel_pid().is_some());
    let kernel = supervisor.kernel_pid().unwrap();
    let image_web = supervisor.path("image/web").display().to_string();
    wait_for("退回镜像里的面板", || {
        supervisor
            .panel_runs()
            .last()
            .is_some_and(|(_, web)| *web == image_web)
    });
    let runs = supervisor.panel_runs();
    assert_eq!(runs.len(), 4, "在线装的试 3 次，再起镜像里的：{runs:?}");
    assert!(
        runs[..3]
            .iter()
            .all(|(_, web)| *web == online.join("web").display().to_string())
    );
    let state: serde_json::Value = serde_json::from_slice(
        &std::fs::read(supervisor.path("data/supervisor/state.json")).unwrap(),
    )
    .unwrap();
    let reason = state["failed_panels"]["999.0.0"]["reason"]
        .as_str()
        .unwrap();
    assert!(reason.contains("连着退出了 3 次"), "{reason}");
    assert!(reason.contains("退出码 1"), "{reason}");
    assert_eq!(supervisor.kernel_pid(), Some(kernel), "换面板时内核不停");

    // 修好的版本重新装上、点在线更新：换成它，记号清掉，内核还是那一个 / The fixed version installed again with another
    // online update: it takes over, the mark goes, and the kernel is still the same one
    supervisor.online_panel("999.0.0", 0);
    assert_eq!(supervisor.ask("panel-update"), "OK");
    wait_for("换成在线装的面板", || {
        supervisor.panel_runs().len() == 5
    });
    assert_eq!(
        supervisor.panel_runs()[4].1,
        online.join("web").display().to_string()
    );
    assert_eq!(
        std::fs::read_to_string(supervisor.path("data/supervisor/state.json")).unwrap(),
        "{}"
    );
    assert_eq!(supervisor.kernel_pid(), Some(kernel), "换面板时内核不停");
    supervisor.stop();
}
