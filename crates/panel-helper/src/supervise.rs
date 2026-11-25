//! 看管模式（`kixdns-panel-helper supervise`）：容器的主进程。内核和面板都是它的子进程，都以非 root 身份跑；它对面板提供和
//! systemd、`OpenWrt` 上一样的 helper 套接字（start/stop/restart/panel-update，外加 status），所以面板在三处是同一个面板。
//!
//! - 内核照 procd 的 `respawn 3600 5 5`：退出了 5 秒后拉起，一小时内崩超过 5 次就不再拉起（状态是 failed）；用户停了就记下来，
//!   重建容器以后还是停着，和 `systemctl disable` 一样。
//! - 面板跑镜像里的和在线装的里面最新的那份；退出了 5 秒后拉起。在线装的那份起来以后 60 秒内连着退出 3 次，就记成起不来、退回
//!   下一份，原因写进 state.json，系统页照着说。换面板（在线更新、重启）时内核一直跑着，DNS 不断。
//! - PID 1 的事自己做：收到 SIGTERM 先停面板和内核再退出；收孤儿和收自己的子进程是同一个 `waitpid(-1)`，再设上 child
//!   subreaper，不是 PID 1 时（`docker run --init`）也一样。
//!
//! The supervise mode (`kixdns-panel-helper supervise`): the container's main process. The kernel and the panel are its
//! children, both run as non-root; it offers the panel the same helper socket as on systemd and `OpenWrt` (start, stop,
//! restart, panel-update, plus status), so the panel is the same panel in all three places.
//!
//! - The kernel follows procd's `respawn 3600 5 5`: brought back 5 seconds after it exits, no longer once it crashed more
//!   than 5 times within an hour (the state is then failed); a stop by the user is remembered, so it stays down after the
//!   container is rebuilt, as with `systemctl disable`.
//! - The panel runs the newest of the image's and the online-installed copies; brought back 5 seconds after it exits. One
//!   installed online that exits 3 times in a row within 60 seconds of starting is recorded as failing and the next copy
//!   runs instead, with the reason in state.json for the system page. Switching panels (online update, restart) keeps the
//!   kernel running, so DNS never stops.
//! - PID 1 duties are its own: on SIGTERM it stops the panel and the kernel, then exits; reaping orphans and its own
//!   children is the same `waitpid(-1)`, and with child subreaper set this holds when it is not PID 1 too
//!   (`docker run --init`).

mod layout;
mod state;

use std::error::Error;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rustix::process::{
    Pid, Signal, WaitOptions, WaitStatus, getpid, getuid, kill_process, set_child_subreaper, wait,
};
use signal_hook::consts::{SIGCHLD, SIGHUP, SIGINT, SIGTERM};
use signal_hook::iterator::Signals;

use self::layout::{Layout, PanelRoot};
use self::state::{PanelFailure, State};
use crate::protocol::{self, ServiceAction};

#[derive(Debug, clap::Parser)]
#[command(
    name = "supervise",
    about = "容器的主进程：看管 KixDNS 内核和面板，对面板提供服务控制套接字"
)]
pub struct Args {
    /// 镜像里的面板，布局和 `OpenWrt` 安装包一样 / The image's panel, laid out as the `OpenWrt` package
    #[arg(long, default_value = "/opt/kixdns-panel")]
    image: PathBuf,

    /// 数据卷 / The data volume
    #[arg(long, default_value = "/data")]
    data: PathBuf,

    /// 套接字放在这下面 / Where the sockets go
    #[arg(long, default_value = "/run")]
    run: PathBuf,

    #[arg(long, default_value_t = 5533)]
    kernel_uid: u32,

    #[arg(long, default_value_t = 5738)]
    panel_uid: u32,

    /// 内核和面板共用的组，内核靠它读面板写的配置 / The group the kernel and the panel share, through which the kernel reads
    /// the config the panel writes
    #[arg(long, default_value_t = 5533)]
    gid: u32,
}

/// procd 的 `respawn 3600 5 5`：隔 5 秒拉起；跑不满一小时就退出算一次崩，崩超过 5 次不再拉起
/// procd's `respawn 3600 5 5`: brought back after 5 seconds; an exit within an hour of starting is a crash, and after more
/// than 5 crashes it is not brought back
const RESPAWN_DELAY: Duration = Duration::from_secs(5);
const RESPAWN_THRESHOLD: Duration = Duration::from_hours(1);
const RESPAWN_RETRY: u32 = 5;
/// 发了 SIGTERM 这么久还不退就 SIGKILL；比 `docker stop` 的 10 秒短，容器退出前总能收拾完
/// SIGKILL after this long past SIGTERM; shorter than `docker stop`'s 10 seconds, so the container always finishes first
const STOP_TIMEOUT: Duration = Duration::from_secs(8);
/// 在线装的面板起来以后这么久之内连着退出这么多次，就是起不来 / An online-installed panel exiting this many times in a row,
/// each within this long of starting, does not come up
const PANEL_SETTLE: Duration = Duration::from_mins(1);
const PANEL_TRIES: u32 = 3;
/// 和 systemd 的 `LimitNOFILE=65536`、`OpenWrt` 的 `nofile="65536 65536"` 一样 / As systemd's `LimitNOFILE=65536` and
/// `OpenWrt`'s `nofile="65536 65536"`
const KERNEL_NOFILE: &str = "65536";
/// 和 systemd unit、`OpenWrt` init 脚本一样，逐请求的应答记录不进日志；用户设了 `RUST_LOG` 就用用户的
/// As in the systemd unit and the `OpenWrt` init script, per-request answer records stay out of the log; a `RUST_LOG` the
/// user set wins
const KERNEL_LOG_FILTER: &str = "info,kixdns::engine::phases=warn";

type Reply = Sender<Result<String, String>>;

enum Event {
    Signal(i32),
    Request(ServiceAction, Reply),
}

pub fn run(args: &Args) -> Result<(), Box<dyn Error>> {
    let layout = Layout {
        image: args.image.clone(),
        data: args.data.clone(),
        run: args.run.clone(),
        kernel_uid: args.kernel_uid,
        panel_uid: args.panel_uid,
        gid: args.gid,
    };
    layout.prepare()?;
    set_child_subreaper(Some(getpid()))?;
    let (events, inbox) = mpsc::channel();
    // 先接住 SIGCHLD 再起子进程，不会漏收 / SIGCHLD is caught before any child starts, so none is missed
    let mut signals = Signals::new([SIGCHLD, SIGTERM, SIGINT, SIGHUP])?;
    let signal_events = events.clone();
    std::thread::spawn(move || {
        for signal in signals.forever() {
            if signal_events.send(Event::Signal(signal)).is_err() {
                return;
            }
        }
    });
    let listener = protocol::listen(&layout.helper_socket(), layout.panel_uid)?;
    // 面板，和看管进程自己的用户（root：镜像的健康检查、docker exec 进来的管理员，本来就什么都能做）
    // The panel, and the supervisor's own user (root: the image's health check, an admin in docker exec, who can do
    // anything anyway)
    let allowed = [layout.panel_uid, getuid().as_raw()];
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let events = events.clone();
            std::thread::spawn(move || {
                let outcome = protocol::answer(stream, &allowed, |action| {
                    let (reply, answer) = mpsc::channel();
                    events
                        .send(Event::Request(action, reply))
                        .map_err(|_| "看管进程正在退出")?;
                    match answer.recv_timeout(Duration::from_secs(25)) {
                        Ok(result) => result.map_err(Into::into),
                        Err(_) => Err("看管进程没有及时回答".into()),
                    }
                });
                if let Err(error) = outcome {
                    eprintln!("kixdns-panel-helper: {error}");
                }
            });
        }
    });
    Supervisor::new(layout).run(&inbox);
    Ok(())
}

/// 一个子进程在哪一步 / Where a child is
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Run {
    /// 没在跑，也不打算起 / Not running, and not about to start
    Idle,
    Up {
        pid: Pid,
        since: Instant,
    },
    /// 发了 SIGTERM 在等它退出；`kill_at` 到了还在就 SIGKILL；退了以后 `again` 为真就马上再起
    /// SIGTERM sent, waiting for the exit; SIGKILL at `kill_at` if still there; once gone it starts again at once when
    /// `again`
    Stopping {
        pid: Pid,
        kill_at: Option<Instant>,
        again: bool,
    },
    /// 等到 `at` 再起 / Starts again at `at`
    Waiting {
        at: Instant,
    },
}

impl Run {
    fn deadline(self) -> Option<Instant> {
        match self {
            Self::Stopping { kill_at, .. } => kill_at,
            Self::Waiting { at } => Some(at),
            Self::Idle | Self::Up { .. } => None,
        }
    }

    fn pid(self) -> Option<Pid> {
        match self {
            Self::Up { pid, .. } | Self::Stopping { pid, .. } => Some(pid),
            Self::Idle | Self::Waiting { .. } => None,
        }
    }

    /// 让它停下：在跑的发 SIGTERM，在等的不等了。`again` 是停下以后要不要马上再起
    /// Brings it down: a running one gets SIGTERM, a waiting one waits no more. `again` is whether it starts again at once
    /// when down
    fn stop(&mut self, again: bool) {
        *self = match *self {
            Self::Up { pid, .. } => {
                // 已经退了的进程收不到信号也无妨，等着收它就是 / A process already gone cannot take the signal, and is reaped anyway
                let _ = kill_process(pid, Signal::TERM);
                Self::Stopping {
                    pid,
                    kill_at: Some(Instant::now() + STOP_TIMEOUT),
                    again,
                }
            }
            Self::Stopping { pid, kill_at, .. } => Self::Stopping {
                pid,
                kill_at,
                again,
            },
            Self::Idle | Self::Waiting { .. } => Self::Idle,
        };
    }
}

struct Kernel {
    run: Run,
    crashes: u32,
    /// 崩得太多不再拉起了 / Crashed too often and is no longer brought back
    gave_up: bool,
    /// 等它停下的请求 / Requests waiting for it to be down
    stopped: Vec<Reply>,
    /// 等它起来的请求 / Requests waiting for it to be up
    started: Vec<Reply>,
}

struct Panel {
    run: Run,
    root: PanelRoot,
    quick_exits: u32,
}

struct Supervisor {
    layout: Layout,
    state: State,
    kernel: Kernel,
    panel: Panel,
    leaving: bool,
}

impl Supervisor {
    fn new(layout: Layout) -> Self {
        let state = State::load(&layout.state_file());
        let root = layout.choose_panel(&state.failed_panels);
        Self {
            layout,
            state,
            kernel: Kernel {
                run: Run::Idle,
                crashes: 0,
                gave_up: false,
                stopped: Vec::new(),
                started: Vec::new(),
            },
            panel: Panel {
                run: Run::Idle,
                root,
                quick_exits: 0,
            },
            leaving: false,
        }
    }

    fn run(mut self, inbox: &Receiver<Event>) {
        if self.state.kernel_stopped {
            say("内核上次被停下了，这次不启动；在面板里点「启动」");
        } else {
            self.spawn_kernel();
        }
        self.spawn_panel();
        while !(self.leaving && self.kernel.run == Run::Idle && self.panel.run == Run::Idle) {
            let deadline = [self.kernel.run.deadline(), self.panel.run.deadline()]
                .into_iter()
                .flatten()
                .min();
            let event = match deadline {
                Some(deadline) => {
                    match inbox.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                        Ok(event) => Some(event),
                        Err(RecvTimeoutError::Timeout) => None,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                None => match inbox.recv() {
                    Ok(event) => Some(event),
                    Err(_) => return,
                },
            };
            match event {
                Some(Event::Signal(SIGCHLD)) => self.reap(),
                Some(Event::Signal(_)) => self.leave(),
                Some(Event::Request(action, reply)) => self.request(action, reply),
                None => {}
            }
            self.on_time();
        }
        say("面板和内核都停了，退出");
    }

    /// 收走所有退出了的子进程，包括转到这里的孤儿 / Reaps every child that exited, orphans handed over here included
    fn reap(&mut self) {
        while let Ok(Some((pid, status))) = wait(WaitOptions::NOHANG) {
            if self.kernel.run.pid() == Some(pid) {
                self.kernel_exited(status);
            } else if self.panel.run.pid() == Some(pid) {
                self.panel_exited(status);
            }
        }
    }

    fn on_time(&mut self) {
        let now = Instant::now();
        for (run, name) in [
            (&mut self.kernel.run, "内核"),
            (&mut self.panel.run, "面板"),
        ] {
            if let Run::Stopping {
                pid,
                kill_at: Some(kill_at),
                again,
            } = *run
                && kill_at <= now
            {
                say(&format!(
                    "{name} {} 秒内没有退出，强制结束",
                    STOP_TIMEOUT.as_secs()
                ));
                let _ = kill_process(pid, Signal::KILL);
                *run = Run::Stopping {
                    pid,
                    kill_at: None,
                    again,
                };
            }
        }
        if matches!(self.kernel.run, Run::Waiting { at } if at <= now) {
            self.spawn_kernel();
        }
        if matches!(self.panel.run, Run::Waiting { at } if at <= now) {
            self.spawn_panel();
        }
    }

    fn leave(&mut self) {
        if !self.leaving {
            say("收到退出信号，停下面板和内核");
            self.leaving = true;
        }
        self.panel.run.stop(false);
        self.kernel.run.stop(false);
    }

    fn request(&mut self, action: ServiceAction, reply: Reply) {
        if self.leaving {
            let _ = reply.send(Err("看管进程正在退出".to_owned()));
            return;
        }
        match action {
            ServiceAction::Status => {
                let _ = reply.send(Ok(self.kernel_status()));
            }
            ServiceAction::Start => {
                if let Err(error) = self.remember_kernel_stopped(false) {
                    let _ = reply.send(Err(error));
                    return;
                }
                self.start_kernel(reply);
            }
            ServiceAction::Restart => {
                self.kernel.run.stop(true);
                self.start_kernel(reply);
            }
            ServiceAction::Stop => {
                if let Err(error) = self.remember_kernel_stopped(true) {
                    let _ = reply.send(Err(error));
                    return;
                }
                self.kernel.gave_up = false;
                self.kernel.run.stop(false);
                if self.kernel.run == Run::Idle {
                    let _ = reply.send(Ok(String::new()));
                } else {
                    self.kernel.stopped.push(reply);
                }
            }
            ServiceAction::PanelUpdate => {
                // 用户要更新就让每个版本都再试一次，然后换到最新的那份 / An update the user asked for gives every version
                // another try, then switches to the newest
                if !self.state.failed_panels.is_empty() {
                    self.state.failed_panels.clear();
                    self.save_state();
                }
                let _ = reply.send(Ok(String::new()));
                self.panel.root = self.layout.choose_panel(&self.state.failed_panels);
                self.panel.quick_exits = 0;
                say(&format!("面板在线更新：换成{}", self.panel.root.label()));
                self.panel.run.stop(true);
                if self.panel.run == Run::Idle {
                    self.spawn_panel();
                }
            }
        }
    }

    /// 用户要它起来：不管崩过几次都重新数；还在停的等它停完马上再起
    /// The user wants it up: crashes are counted afresh; one still stopping starts again as soon as it is down
    fn start_kernel(&mut self, reply: Reply) {
        self.kernel.crashes = 0;
        self.kernel.gave_up = false;
        match &mut self.kernel.run {
            Run::Up { .. } => {
                let _ = reply.send(Ok(String::new()));
            }
            Run::Stopping { again, .. } => {
                *again = true;
                self.kernel.started.push(reply);
            }
            Run::Idle | Run::Waiting { .. } => {
                self.kernel.started.push(reply);
                self.spawn_kernel();
            }
        }
    }

    fn spawn_kernel(&mut self) {
        let spawned = self
            .kernel_command()
            .and_then(|mut command| command.spawn());
        let outcome = match spawned {
            Ok(child) => {
                let pid = Pid::from_child(&child);
                self.kernel.run = Run::Up {
                    pid,
                    since: Instant::now(),
                };
                say(&format!("内核已启动（pid {}）", pid.as_raw_nonzero()));
                Ok(String::new())
            }
            Err(error) => {
                self.kernel_down(Duration::ZERO, &format!("没能启动（{error}）"));
                Err(format!("内核没能启动：{error}"))
            }
        };
        for reply in self.kernel.started.drain(..) {
            let _ = reply.send(outcome.clone());
        }
    }

    fn kernel_command(&self) -> std::io::Result<Command> {
        self.layout.seed_kernel()?;
        let log = self.layout.open_kernel_log()?;
        let mut command = run_as(self.layout.kernel_uid, self.layout.gid);
        command
            .args(["--bind-service", "--nofile", KERNEL_NOFILE, "--"])
            .arg(self.layout.kernel_binary())
            .args(["run", "--config"])
            .arg(self.layout.pipeline())
            .arg("--admin-socket")
            .arg(self.layout.admin_socket())
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log);
        if std::env::var_os("RUST_LOG").is_none() {
            command.env("RUST_LOG", KERNEL_LOG_FILTER);
        }
        Ok(command)
    }

    fn kernel_exited(&mut self, status: WaitStatus) {
        match self.kernel.run {
            Run::Stopping { again, .. } => {
                say("内核已停止");
                for reply in self.kernel.stopped.drain(..) {
                    let _ = reply.send(Ok(String::new()));
                }
                self.kernel.run = Run::Idle;
                if again && !self.leaving {
                    self.spawn_kernel();
                } else {
                    for reply in self.kernel.started.drain(..) {
                        let _ = reply.send(Err("内核被停下了，没有再启动".to_owned()));
                    }
                }
            }
            Run::Up { since, .. } => self.kernel_down(since.elapsed(), &how(status)),
            Run::Idle | Run::Waiting { .. } => {}
        }
    }

    /// 内核自己没了（或者没能起来）：照 procd 的规矩数一次崩，过 5 秒拉起，崩太多就放弃
    /// The kernel went down by itself (or did not start): one crash by procd's rule, back after 5 seconds, given up after
    /// too many
    fn kernel_down(&mut self, ran: Duration, how: &str) {
        self.kernel.crashes = count_crash(self.kernel.crashes, ran);
        if self.kernel.crashes > RESPAWN_RETRY {
            self.kernel.run = Run::Idle;
            self.kernel.gave_up = true;
            say(&format!(
                "内核{how}；一小时内已经崩了 {} 次，不再拉起，看内核日志找原因，在面板里点「启动」再试",
                self.kernel.crashes
            ));
        } else {
            self.kernel.run = Run::Waiting {
                at: Instant::now() + RESPAWN_DELAY,
            };
            say(&format!(
                "内核{how}，{} 秒后重新拉起",
                RESPAWN_DELAY.as_secs()
            ));
        }
    }

    /// systemd `ActiveState SubState MainPID` 的说法，面板照 systemd 的规矩读
    /// In systemd's `ActiveState SubState MainPID` words, read by the panel by systemd's rules
    fn kernel_status(&self) -> String {
        match self.kernel.run {
            Run::Up { pid, .. } => format!("active running {}", pid.as_raw_nonzero()),
            Run::Stopping { pid, .. } => {
                format!("deactivating stop-sigterm {}", pid.as_raw_nonzero())
            }
            Run::Waiting { .. } => "activating auto-restart 0".to_owned(),
            Run::Idle if self.kernel.gave_up => "failed failed 0".to_owned(),
            Run::Idle => "inactive dead 0".to_owned(),
        }
    }

    fn remember_kernel_stopped(&mut self, stopped: bool) -> Result<(), String> {
        if self.state.kernel_stopped == stopped {
            return Ok(());
        }
        self.state.kernel_stopped = stopped;
        self.state.save(&self.layout.state_file()).map_err(|error| {
            self.state.kernel_stopped = !stopped;
            format!("记不下内核的启停：{error}")
        })
    }

    fn save_state(&self) {
        if let Err(error) = self.state.save(&self.layout.state_file()) {
            say(&format!(
                "写不了 {}：{error}",
                self.layout.state_file().display()
            ));
        }
    }

    fn spawn_panel(&mut self) {
        let mut command = run_as(self.layout.panel_uid, self.layout.gid);
        command
            .arg("--")
            .arg(self.panel.root.server())
            .stdin(Stdio::null());
        for (key, value) in self.layout.panel_env(&self.panel.root) {
            match value {
                Some(value) => command.env(key, value),
                None => command.env_remove(key),
            };
        }
        match command.spawn() {
            Ok(child) => {
                let pid = Pid::from_child(&child);
                self.panel.run = Run::Up {
                    pid,
                    since: Instant::now(),
                };
                say(&format!(
                    "{} 已启动（pid {}）",
                    self.panel.root.label(),
                    pid.as_raw_nonzero()
                ));
            }
            Err(error) => self.panel_down(Duration::ZERO, &format!("没能启动（{error}）")),
        }
    }

    fn panel_exited(&mut self, status: WaitStatus) {
        match self.panel.run {
            Run::Stopping { again, .. } => {
                self.panel.run = Run::Idle;
                if again && !self.leaving {
                    self.spawn_panel();
                }
            }
            Run::Up { since, .. } => self.panel_down(since.elapsed(), &how(status)),
            Run::Idle | Run::Waiting { .. } => {}
        }
    }

    /// 面板自己没了：在线装的那份刚起来就连着退出，就记成起不来、换下一份马上起；别的过 5 秒拉起
    /// The panel went down by itself: an online-installed copy exiting again and again right after starting is recorded as
    /// failing and the next copy starts at once; otherwise it is brought back after 5 seconds
    fn panel_down(&mut self, ran: Duration, how: &str) {
        self.panel.quick_exits = count_quick_exit(self.panel.quick_exits, ran);
        let failed = self.panel.root.clone();
        if failed.online && self.panel.quick_exits >= PANEL_TRIES {
            let reason = format!(
                "起来以后 {} 秒内连着退出了 {} 次，最后一次{how}",
                PANEL_SETTLE.as_secs(),
                self.panel.quick_exits
            );
            self.state.failed_panels.insert(
                failed.name(),
                PanelFailure {
                    at: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map_or(0, |elapsed| elapsed.as_secs()),
                    reason: reason.clone(),
                },
            );
            self.save_state();
            self.panel.root = self.layout.choose_panel(&self.state.failed_panels);
            self.panel.quick_exits = 0;
            say(&format!(
                "{} {reason}，退回{}",
                failed.label(),
                self.panel.root.label()
            ));
            self.spawn_panel();
        } else {
            self.panel.run = Run::Waiting {
                at: Instant::now() + RESPAWN_DELAY,
            };
            say(&format!(
                "{} {how}，{} 秒后重新拉起",
                failed.label(),
                RESPAWN_DELAY.as_secs()
            ));
        }
    }
}

/// 起一个降了权的自己，由它 exec 目标程序（见 `run_as`）/ Starts a copy of itself with lowered privileges that execs the
/// target (see `run_as`)
fn run_as(uid: u32, gid: u32) -> Command {
    let mut command = Command::new("/proc/self/exe");
    command.args([
        "run-as",
        "--uid",
        &uid.to_string(),
        "--gid",
        &gid.to_string(),
    ]);
    command
}

/// 跑不满一小时就退出算一次崩；跑满了的从头数 / An exit within an hour of starting is one more crash; one that ran longer
/// starts the count afresh
fn count_crash(crashes: u32, ran: Duration) -> u32 {
    if ran < RESPAWN_THRESHOLD {
        crashes + 1
    } else {
        0
    }
}

/// 起来以后很快就退出算一次；跑稳了以后退出的从头数 / An exit soon after starting is one more; one after it settled starts
/// the count afresh
fn count_quick_exit(quick_exits: u32, ran: Duration) -> u32 {
    if ran < PANEL_SETTLE {
        quick_exits + 1
    } else {
        0
    }
}

fn how(status: WaitStatus) -> String {
    match (status.exit_status(), status.terminating_signal()) {
        (Some(code), _) => format!("退出了（退出码 {code}）"),
        (None, Some(signal)) => format!("被信号 {signal} 结束了"),
        (None, None) => "退出了".to_owned(),
    }
}

fn say(message: &str) {
    eprintln!("kixdns-panel-helper: {message}");
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{
        PANEL_SETTLE, PANEL_TRIES, RESPAWN_RETRY, RESPAWN_THRESHOLD, count_crash, count_quick_exit,
    };

    /// procd 的 `respawn 3600 5 5`：一小时内第 6 次崩才放弃；中间跑满过一小时就从头数
    /// procd's `respawn 3600 5 5`: it gives up on the sixth crash within an hour; a run of an hour in between starts over
    #[test]
    fn the_kernel_gives_up_after_more_than_five_quick_crashes() {
        let quick = Duration::from_secs(10);
        let mut crashes = 0;
        for _ in 0..RESPAWN_RETRY {
            crashes = count_crash(crashes, quick);
            assert!(crashes <= RESPAWN_RETRY, "前 5 次还拉起");
        }
        assert_eq!(
            count_crash(crashes, RESPAWN_THRESHOLD),
            0,
            "跑满一小时从头数"
        );
        assert!(count_crash(crashes, quick) > RESPAWN_RETRY, "第 6 次放弃");
    }

    /// 刚起来就退出才算数，连着 3 次就是起不来；跑稳过一次就从头数
    /// Only exits right after starting count, three in a row mean it does not come up; one settled run starts over
    #[test]
    fn a_panel_fails_after_three_quick_exits_in_a_row() {
        let quick = Duration::from_secs(2);
        let mut exits = count_quick_exit(0, quick);
        exits = count_quick_exit(exits, quick);
        assert!(exits < PANEL_TRIES);
        assert_eq!(count_quick_exit(exits, PANEL_SETTLE), 0, "跑稳了从头数");
        assert_eq!(count_quick_exit(exits, quick), PANEL_TRIES);
    }
}
