use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use getrandom::fill;
use hickory_proto::op::{Message, MessageType, OpCode, Query};
use hickory_proto::rr::{Name, RecordType};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone)]
pub struct Operations {
    #[cfg_attr(not(unix), allow(dead_code))]
    service_unit: Arc<str>,
    #[cfg_attr(not(unix), allow(dead_code))]
    service_helper_socket: PathBuf,
    diagnostic_server: SocketAddr,
    /// 读服务状态用的 systemctl；测试里换成一个照文件回答的假程序 / The systemctl used to read the service state; tests swap in
    /// a fake one that answers from a file
    #[cfg_attr(not(unix), allow(dead_code))]
    systemctl: Arc<str>,
    /// procd 环境下的服务 pid 文件；Some 时用它读状态，不再调 systemctl
    /// The service pid file under procd; when Some, status is read from it instead of systemctl
    #[cfg_attr(not(unix), allow(dead_code))]
    service_pidfile: Option<PathBuf>,
    /// procd 环境下的服务日志文件；Some 时日志页读它，不再调 journalctl
    /// The service log file under procd; when Some, the log page reads it instead of journalctl
    #[cfg_attr(not(unix), allow(dead_code))]
    service_logfile: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceStatus {
    pub unit: String,
    pub active_state: String,
    pub sub_state: String,
    pub main_pid: u32,
    /// `KixDNS` 起不来（失败、systemd 在重试，或者重试的那一下）：由服务状态接口补上，各页据此一样说「启动失败」
    ///
    /// `KixDNS` does not come up (failed, retried by systemd, or the moment of a retry): filled in by the service status
    /// endpoint, so every page says 启动失败 alike
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub did_not_come_up: bool,
    /// 起不来时可以退回的设置和它们上次启动时的值（和配置页同一份）：由服务状态接口补上，各页据此给出路
    ///
    /// While it does not come up, the settings that can go back and their starting values (the config page's): filled
    /// in by the service status endpoint, so every page offers the way out
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restart_rollback: Option<std::collections::BTreeMap<String, Value>>,
    /// 起不来、不能退回时可以写进配置文件的待应用版本（和配置页同一份）：由服务状态接口补上
    ///
    /// While it does not come up with nothing to put back, the pending version that can be written into the config
    /// file (the config page's): filled in by the service status endpoint
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_writable: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub timestamp_unix_micros: u64,
    pub priority: u8,
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogPage {
    pub entries: Vec<LogEntry>,
    pub next_cursor: Option<String>,
    /// journald 看不到这个 unit 的输出时，给读者的完整一句话：unit 在 systemd
    /// 里不存在，或者它把 StandardOutput/StandardError 改到了 journald 之外。
    /// 两种情况下 `journalctl --unit` 都只剩 systemd 自己的启停记录，日志页看着
    /// 正常却一条 `KixDNS` 的输出都没有。句子在服务端拼好，前端原样展示；
    /// None 表示 journald 能看到。
    /// The complete sentence for the reader when journald cannot see this
    /// unit's output: the unit does not exist in systemd, or it sends
    /// StandardOutput/StandardError somewhere other than journald. Either way
    /// `journalctl --unit` holds only systemd's own start/stop lines and the
    /// page looks fine while showing nothing from `KixDNS`. Composed here and
    /// rendered verbatim by the frontend; None means journald sees the output.
    pub notice: Option<String>,
}

/// 日志级别桶。三段范围必须和前端 `label()/levelClass()` 的分桶完全一致
/// （<=3 错误、==4 警告、>=5 信息），否则筛「警告」会漏掉或混进别的行。
/// The level buckets. The three ranges must equal the frontend's
/// `label()/levelClass()` buckets (<=3 error, ==4 warning, >=5 info), or a
/// "warning" filter drops or admits the wrong lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Error,
    Warning,
    Info,
}

impl LogLevel {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "error" => Some(Self::Error),
            "warning" => Some(Self::Warning),
            "info" => Some(Self::Info),
            _ => None,
        }
    }

    /// journalctl 的 `--priority=FROM..TO` 取值；两端都闭区间，顺序无关。
    /// The `--priority=FROM..TO` range for journalctl; inclusive on both ends.
    #[cfg(any(unix, test))]
    const fn journal_priority_range(self) -> &'static str {
        match self {
            Self::Error => "0..3",
            Self::Warning => "4..4",
            Self::Info => "5..7",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DnsDiagnostic {
    pub server: String,
    pub domain: String,
    pub record_type: String,
    pub response_code: String,
    pub elapsed_ms: u64,
    pub truncated: bool,
    pub answers: Vec<String>,
    pub trace_supported: bool,
    pub trace_truncated: bool,
    pub trace: Vec<crate::control::DiagnosticTraceStep>,
    /// 内核按哪个客户端 IP 处理的；旧内核和基础查询为空 / The client IP the kernel used; empty on older kernels and the basic query
    pub client_ip: Option<String>,
    /// 测的是哪份配置：正在用的还是草稿 / Which config was tested: the live one or the draft
    pub source: DiagnosticSource,
}

/// 诊断用的配置 / The config a diagnostic ran against
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSource {
    /// 正在用的配置 / The live config
    #[default]
    Live,
    /// 还没保存的草稿 / The unsaved draft
    Draft,
}

#[derive(Debug, Clone, Copy)]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
}

impl ServiceAction {
    pub fn parse(value: &str) -> Result<Self, OperationError> {
        match value {
            "start" => Ok(Self::Start),
            "stop" => Ok(Self::Stop),
            "restart" => Ok(Self::Restart),
            _ => Err(OperationError::Invalid(
                "服务动作只允许 start、stop 或 restart".to_owned(),
            )),
        }
    }

    #[cfg(unix)]
    const fn argument(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum OperationError {
    #[error("{0}")]
    Invalid(String),
    #[cfg(not(unix))]
    #[error("当前平台不支持此操作")]
    Unsupported,
    // 失败的原因本身已经是一句完整的话（「连不上面板的服务助手…」「KixDNS 没能启动…」），不再加「宿主机操作失败：」
    // The reason is already a whole sentence (连不上面板的服务助手…, KixDNS 没能启动…), so no 宿主机操作失败： prefix
    #[error("{0}")]
    Failed(String),
}

impl Operations {
    pub fn new(
        service_unit: String,
        service_helper_socket: PathBuf,
        diagnostic_server: SocketAddr,
    ) -> Result<Self, OperationError> {
        if service_unit.is_empty()
            || service_unit.len() > 128
            || !service_unit.ends_with(".service")
            || !service_unit
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            || service_unit.contains("..")
            || !service_unit.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'_' | b'-' | b'.')
            })
        {
            return Err(OperationError::Invalid("KixDNS 服务名称无效".to_owned()));
        }
        Ok(Self {
            service_unit: Arc::from(service_unit),
            service_helper_socket,
            diagnostic_server,
            systemctl: Arc::from("systemctl"),
            service_pidfile: None,
            service_logfile: None,
        })
    }

    /// 切到 procd 后端：状态读 pid 文件、日志读日志文件（OpenWrt 上没有 systemd）
    /// Switch to the procd backend: status from a pid file, logs from a log file (no systemd on `OpenWrt`)
    #[must_use]
    pub fn with_procd_service(
        mut self,
        pidfile: Option<PathBuf>,
        logfile: Option<PathBuf>,
    ) -> Self {
        self.service_pidfile = pidfile;
        self.service_logfile = logfile;
        self
    }

    #[must_use]
    pub fn with_systemctl(mut self, program: &str) -> Self {
        self.systemctl = Arc::from(program);
        self
    }

    #[cfg(unix)]
    pub async fn service_status(&self) -> Result<ServiceStatus, OperationError> {
        if let Some(pidfile) = &self.service_pidfile {
            // 先用 ubus 问 procd 自己：它分得清「用户停掉的」（服务不在列表里）和「崩了没
            // 被拉起来的」（实例还在但 running=false）。ubus 用不了（不在 OpenWrt 上、
            // 命令缺失或输出读不懂）才退回 pid 文件。
            // Ask procd through ubus first: it can tell "the user stopped it" (the service is
            // gone from the list) from "it crashed and was not brought back" (the instance
            // remains but running=false). Only when ubus is unusable (not on OpenWrt, missing
            // command or unreadable output) do we fall back to the pid file.
            if let Some(status) = procd_status_via_ubus(self.service_unit.as_ref()).await {
                return Ok(status);
            }
            return Ok(procd_status_via_pidfile(
                self.service_unit.as_ref(),
                pidfile,
            ));
        }
        let output = run_command(
            &self.systemctl,
            &[
                "show",
                self.service_unit.as_ref(),
                "--no-pager",
                "--property=ActiveState,SubState,MainPID",
            ],
            Duration::from_secs(10),
        )
        .await?;
        parse_service_status(self.service_unit.as_ref(), &output)
    }

    #[cfg(not(unix))]
    #[allow(clippy::unused_async)]
    pub async fn service_status(&self) -> Result<ServiceStatus, OperationError> {
        Err(OperationError::Unsupported)
    }

    #[cfg(unix)]
    pub async fn service_action(
        &self,
        action: ServiceAction,
    ) -> Result<ServiceStatus, OperationError> {
        self.helper_request(action.argument()).await?;
        self.service_status().await
    }

    /// 只发服务动作，不再读一遍状态（调用方自己等 `KixDNS` 回来） / Send the service action only, without reading the
    /// status back (the caller waits for `KixDNS` itself)
    #[cfg(unix)]
    pub async fn service_request(&self, action: ServiceAction) -> Result<(), OperationError> {
        self.helper_request(action.argument()).await
    }

    #[cfg(unix)]
    pub async fn start_panel_update(&self) -> Result<(), OperationError> {
        self.helper_request("panel-update").await
    }

    #[cfg(unix)]
    async fn helper_request(&self, action: &str) -> Result<(), OperationError> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixStream;

        let mut stream = tokio::time::timeout(
            Duration::from_secs(10),
            UnixStream::connect(&self.service_helper_socket),
        )
        .await
        .map_err(|_| {
            OperationError::Failed(
                "连不上面板的服务助手（kixdns-panel-helper）：连接超时".to_owned(),
            )
        })?
        .map_err(|error| {
            OperationError::Failed(format!(
                "连不上面板的服务助手（kixdns-panel-helper）：{error}"
            ))
        })?;
        stream
            .write_all(action.as_bytes())
            .await
            .map_err(|error| OperationError::Failed(format!("无法发送服务动作：{error}")))?;
        stream
            .shutdown()
            .await
            .map_err(|error| OperationError::Failed(format!("无法结束服务动作请求：{error}")))?;
        let mut response = String::new();
        tokio::time::timeout(
            Duration::from_secs(30),
            BufReader::new(stream).read_line(&mut response),
        )
        .await
        .map_err(|_| OperationError::Failed("服务控制超时".to_owned()))?
        .map_err(|error| OperationError::Failed(format!("读取服务控制结果失败：{error}")))?;
        if response.trim() != "OK" {
            return Err(OperationError::Failed(helper_failure(
                &self.service_unit,
                action,
                &response,
            )));
        }
        Ok(())
    }

    #[cfg(not(unix))]
    #[allow(clippy::unused_async)]
    pub async fn service_action(
        &self,
        _action: ServiceAction,
    ) -> Result<ServiceStatus, OperationError> {
        Err(OperationError::Unsupported)
    }

    #[cfg(not(unix))]
    #[allow(clippy::unused_async)]
    pub async fn service_request(&self, _action: ServiceAction) -> Result<(), OperationError> {
        Err(OperationError::Unsupported)
    }

    #[cfg(not(unix))]
    #[allow(clippy::unused_async)]
    pub async fn start_panel_update(&self) -> Result<(), OperationError> {
        Err(OperationError::Unsupported)
    }

    #[cfg(unix)]
    pub async fn logs(
        &self,
        limit: usize,
        before_cursor: Option<&str>,
        level: Option<LogLevel>,
    ) -> Result<LogPage, OperationError> {
        let limit = limit.clamp(1, 500);
        if let Some(logfile) = self.service_logfile.clone() {
            return Ok(procd_logs(&logfile, limit, before_cursor, level).await);
        }
        let arguments = journal_arguments(self.service_unit.as_ref(), limit, before_cursor, level);
        let arguments = arguments.iter().map(String::as_str).collect::<Vec<_>>();
        // unit 状态和日志本身并行查：多一次 systemctl 不该让日志页慢一倍。
        // 一起要 LoadState：unit 不存在时 systemctl show 照样退出 0，只是打印
        // StandardOutput=inherit，不看 LoadState 会把「找不到 unit」说成「输出被改了去向」。
        // systemctl 失败只是少了提示，不能把整页日志一起拖垮，所以吞掉错误。
        // The unit's state is queried alongside the journal so the extra
        // systemctl call does not double the page's latency. LoadState comes
        // with it: for a missing unit `systemctl show` still exits 0 and prints
        // StandardOutput=inherit, so without LoadState "unit not found" would be
        // reported as "output redirected". A failing systemctl only loses the
        // notice; it must not fail the log request.
        let show_arguments = [
            "show",
            self.service_unit.as_ref(),
            "--no-pager",
            "--property=LoadState,StandardOutput,StandardError",
        ];
        let (journal, unit_state) = tokio::join!(
            run_command("journalctl", &arguments, Duration::from_secs(10)),
            run_command(&self.systemctl, &show_arguments, Duration::from_secs(10))
        );
        let mut page = parse_journal_page(&journal?, before_cursor, limit);
        page.notice = unit_state
            .ok()
            .and_then(|output| unit_log_notice(self.service_unit.as_ref(), &output));
        Ok(page)
    }

    #[cfg(not(unix))]
    #[allow(clippy::unused_async)]
    pub async fn logs(
        &self,
        _limit: usize,
        _before_cursor: Option<&str>,
        _level: Option<LogLevel>,
    ) -> Result<LogPage, OperationError> {
        Err(OperationError::Unsupported)
    }

    pub async fn dns_query(
        &self,
        config: &Value,
        domain: String,
        record_type: String,
    ) -> Result<DnsDiagnostic, OperationError> {
        if domain.len() > 253 {
            return Err(OperationError::Invalid("域名过长".to_owned()));
        }
        let name = Name::from_ascii(&domain)
            .map_err(|error| OperationError::Invalid(format!("域名无效：{error}")))?;
        let record_type = parse_record_type(&record_type)?;
        let mut id_bytes = [0_u8; 2];
        fill(&mut id_bytes)
            .map_err(|error| OperationError::Failed(format!("生成查询 ID 失败：{error}")))?;
        let request_id = u16::from_be_bytes(id_bytes);
        let mut message = Message::new(request_id, MessageType::Query, OpCode::Query);
        message.metadata.recursion_desired = true;
        message.add_query(Query::query(name, record_type));
        let request = message
            .to_vec()
            .map_err(|error| OperationError::Failed(format!("编码 DNS 请求失败：{error}")))?;
        let diagnostic_server = self.diagnostic_server_for(config)?;
        let bind_address = match diagnostic_server.ip() {
            IpAddr::V4(_) => SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
            IpAddr::V6(_) => SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), 0),
        };
        let socket = tokio::net::UdpSocket::bind(bind_address)
            .await
            .map_err(|error| OperationError::Failed(error.to_string()))?;
        socket
            .connect(diagnostic_server)
            .await
            .map_err(|error| OperationError::Failed(error.to_string()))?;
        let started = Instant::now();
        socket
            .send(&request)
            .await
            .map_err(|error| OperationError::Failed(error.to_string()))?;
        let mut response = vec![0_u8; 65_535];
        let length = tokio::time::timeout(Duration::from_secs(3), socket.recv(&mut response))
            .await
            .map_err(|_| OperationError::Failed("DNS 查询超时".to_owned()))?
            .map_err(|error| OperationError::Failed(error.to_string()))?;
        response.truncate(length);
        let response = Message::from_vec(&response)
            .map_err(|error| OperationError::Failed(format!("解析 DNS 响应失败：{error}")))?;
        if response.metadata.id != request_id {
            return Err(OperationError::Failed("DNS 响应 ID 不匹配".to_owned()));
        }
        Ok(DnsDiagnostic {
            server: diagnostic_server.to_string(),
            domain,
            record_type: record_type.to_string(),
            response_code: response.metadata.response_code.to_string(),
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            truncated: response.metadata.truncation,
            answers: response.answers.iter().map(ToString::to_string).collect(),
            trace_supported: false,
            trace_truncated: false,
            trace: Vec::new(),
            client_ip: None,
            source: DiagnosticSource::Live,
        })
    }

    fn diagnostic_server_for(&self, config: &Value) -> Result<SocketAddr, OperationError> {
        if !self.diagnostic_server.ip().is_loopback() {
            return Ok(self.diagnostic_server);
        }
        let Some(bind_udp) = config.pointer("/settings/bind_udp").and_then(Value::as_str) else {
            return Ok(self.diagnostic_server);
        };
        let bind_udp = bind_udp.parse::<SocketAddr>().map_err(|error| {
            OperationError::Invalid(format!(
                "当前配置的 settings.bind_udp 无效，无法确定诊断端口：{error}"
            ))
        })?;
        let ip = match bind_udp.ip() {
            IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
            ip => ip,
        };
        Ok(SocketAddr::new(ip, bind_udp.port()))
    }
}

fn parse_record_type(value: &str) -> Result<RecordType, OperationError> {
    let value = value.trim().to_ascii_uppercase();
    if !matches!(
        value.as_str(),
        "A" | "AAAA" | "CNAME" | "MX" | "NS" | "PTR" | "SOA" | "SRV" | "TXT"
    ) {
        return Err(OperationError::Invalid("不支持的 DNS 记录类型".to_owned()));
    }
    RecordType::from_str(&value)
        .map_err(|error| OperationError::Invalid(format!("记录类型无效：{error}")))
}

#[cfg(unix)]
async fn run_command(
    program: &str,
    arguments: &[&str],
    timeout: Duration,
) -> Result<String, OperationError> {
    use tokio::process::Command;

    let output = tokio::time::timeout(timeout, Command::new(program).args(arguments).output())
        .await
        .map_err(|_| OperationError::Failed(format!("{program} 执行超时")))?
        .map_err(|error| OperationError::Failed(format!("无法执行 {program}：{error}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(OperationError::Failed(truncate(&stderr, 1_024)));
    }
    String::from_utf8(output.stdout)
        .map_err(|_| OperationError::Failed(format!("{program} 输出不是 UTF-8")))
}

/// 读不到 procd 时的兜底状态：pid 文件里的进程还活着就是 active，否则 inactive。
/// Fallback status when procd cannot be queried: active while the pid in the pid file is
/// alive, inactive otherwise.
#[cfg(unix)]
fn procd_status_via_pidfile(unit: &str, pidfile: &std::path::Path) -> ServiceStatus {
    let pid = std::fs::read_to_string(pidfile)
        .ok()
        .and_then(|text| {
            text.split_whitespace()
                .next()
                .and_then(|value| value.parse::<u32>().ok())
        })
        .filter(|pid| *pid > 0 && std::path::Path::new(&format!("/proc/{pid}")).exists());
    match pid {
        Some(pid) => active_status(unit, pid),
        None => inactive_status(unit),
    }
}

/// 通过 `ubus call service list` 问 procd 服务状态；ubus 不在、调用失败或输出读不懂时返回
/// `None`，交给 pid 文件兜底。
/// Ask procd for the service state through `ubus call service list`; returns `None` when
/// ubus is absent, the call fails or the output cannot be read, so the pid file takes over.
#[cfg(unix)]
async fn procd_status_via_ubus(unit: &str) -> Option<ServiceStatus> {
    let service = unit.strip_suffix(".service").unwrap_or(unit);
    let filter = format!("{{\"name\":\"{service}\"}}");
    let output = run_command(
        "ubus",
        &["call", "service", "list", &filter],
        Duration::from_secs(5),
    )
    .await
    .ok()?;
    parse_procd_status_from_ubus(unit, &output)
}

/// procd 在实例还在时，即使没在跑也把它留在 `service list` 里（respawn 耗尽、崩溃但没被删）。
/// 因此：有实例 running=true → active；有实例但都不 running → failed（起不来）；服务根本不在
/// 列表里（用户 stop 掉了，procd 已删）→ inactive。
/// procd keeps an instance in `service list` even when it is not running (respawn exhausted,
/// crashed but not deleted). So: any instance running=true → active; instances present but none
/// running → failed (did not come up); the service not listed at all (the user stopped it, procd
/// deleted it) → inactive.
#[cfg(unix)]
fn parse_procd_status_from_ubus(unit: &str, output: &str) -> Option<ServiceStatus> {
    let root: Value = serde_json::from_str(output).ok()?;
    let object = root.as_object()?;
    let service = unit.strip_suffix(".service").unwrap_or(unit);
    let Some(entry) = object.get(service) else {
        return Some(inactive_status(unit));
    };
    let Some(instances) = entry.get("instances").and_then(Value::as_object) else {
        return Some(inactive_status(unit));
    };
    let mut running_pid = None;
    for instance in instances.values() {
        let running = instance
            .get("running")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if running {
            let pid = instance
                .get("pid")
                .and_then(Value::as_u64)
                .and_then(|pid| u32::try_from(pid).ok())
                .unwrap_or(0);
            running_pid = Some(pid);
        }
    }
    Some(match running_pid {
        Some(pid) => active_status(unit, pid),
        None if instances.is_empty() => inactive_status(unit),
        None => failed_status(unit),
    })
}

#[cfg(unix)]
fn active_status(unit: &str, pid: u32) -> ServiceStatus {
    ServiceStatus {
        unit: unit.to_owned(),
        active_state: "active".to_owned(),
        sub_state: "running".to_owned(),
        main_pid: pid,
        did_not_come_up: false,
        restart_rollback: None,
        pending_writable: None,
    }
}

#[cfg(unix)]
fn inactive_status(unit: &str) -> ServiceStatus {
    ServiceStatus {
        unit: unit.to_owned(),
        active_state: "inactive".to_owned(),
        sub_state: "dead".to_owned(),
        main_pid: 0,
        did_not_come_up: false,
        restart_rollback: None,
        pending_writable: None,
    }
}

#[cfg(unix)]
fn failed_status(unit: &str) -> ServiceStatus {
    ServiceStatus {
        unit: unit.to_owned(),
        active_state: "failed".to_owned(),
        sub_state: "failed".to_owned(),
        main_pid: 0,
        did_not_come_up: false,
        restart_rollback: None,
        pending_writable: None,
    }
}

/// 从日志文件取一页，新的在前。游标是行的文件绝对字节偏移：翻旧页时只取偏移更小的行。
/// 只读文件末尾那一块（最多 8 MiB），用 seek 定位，不再把整个日志读进内存；读盘放到
/// `spawn_blocking`，不阻塞 tokio。
/// One page from the log file, newest first. The cursor is a line's absolute byte offset in
/// the file: older pages only take lines with a smaller offset. Only the tail (at most 8 MiB)
/// is read, located with seek, instead of reading the whole log into memory; the disk read runs
/// on `spawn_blocking` so it does not block tokio.
#[cfg(unix)]
async fn procd_logs(
    logfile: &std::path::Path,
    limit: usize,
    before_cursor: Option<&str>,
    level: Option<LogLevel>,
) -> LogPage {
    let logfile = logfile.to_owned();
    let before_cursor = before_cursor.map(str::to_owned);
    match tokio::task::spawn_blocking(move || {
        procd_logs_blocking(&logfile, limit, before_cursor.as_deref(), level)
    })
    .await
    {
        Ok(page) => page,
        Err(error) => LogPage {
            entries: Vec::new(),
            next_cursor: None,
            notice: Some(format!("读取日志失败：{error}")),
        },
    }
}

#[cfg(unix)]
fn procd_logs_blocking(
    logfile: &std::path::Path,
    limit: usize,
    before_cursor: Option<&str>,
    level: Option<LogLevel>,
) -> LogPage {
    use std::io::{Read, Seek, SeekFrom};

    // 只读末尾 8 MiB：文件再大也不会一次吃进内存。
    // Read only the last 8 MiB so a huge file cannot be loaded at once.
    const MAX_READ: u64 = 8 * 1024 * 1024;
    let mut file = match std::fs::File::open(logfile) {
        Ok(file) => file,
        // 日志文件还没建出来是空页，不是错误。
        // A log file that does not exist yet is an empty page, not an error.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return LogPage {
                entries: Vec::new(),
                next_cursor: None,
                notice: None,
            };
        }
        Err(error) => {
            return LogPage {
                entries: Vec::new(),
                next_cursor: None,
                notice: Some(format!("读取日志失败：{error}")),
            };
        }
    };
    let length = file.metadata().map_or(0, |meta| meta.len());
    let base = length.saturating_sub(MAX_READ);
    if let Err(error) = file.seek(SeekFrom::Start(base)) {
        return LogPage {
            entries: Vec::new(),
            next_cursor: None,
            notice: Some(format!("读取日志失败：{error}")),
        };
    }
    let tail_len = usize::try_from(length - base).unwrap_or(0);
    let mut buffer = Vec::with_capacity(tail_len);
    if let Err(error) = file.read_to_end(&mut buffer) {
        return LogPage {
            entries: Vec::new(),
            next_cursor: None,
            notice: Some(format!("读取日志失败：{error}")),
        };
    }
    // 尾部窗口可能从一行中间开始：丢掉第一个不完整的行。
    // The tail window may start mid-line: drop the first, incomplete line.
    let mut offset = if base > 0 {
        match buffer.iter().position(|byte| *byte == b'\n') {
            Some(index) => index + 1,
            None => buffer.len(),
        }
    } else {
        0
    };
    let mut lines: Vec<(u64, String)> = Vec::new();
    while offset <= buffer.len() {
        let rest = &buffer[offset..];
        let end = rest.iter().position(|byte| *byte == b'\n');
        let (line_bytes, next) = match end {
            Some(index) => (&rest[..index], offset + index + 1),
            None => (rest, buffer.len() + 1),
        };
        lines.push((
            base + offset as u64,
            String::from_utf8_lossy(line_bytes).into_owned(),
        ));
        offset = next;
    }
    let cursor_offset = before_cursor.and_then(|value| value.parse::<u64>().ok());
    let mut entries: Vec<(u64, LogEntry)> = lines
        .into_iter()
        .filter(|(_, line)| !line.trim().is_empty())
        .rev()
        .filter(|(start, _)| cursor_offset.is_none_or(|cursor| *start < cursor))
        .filter_map(|(start, line)| {
            let (timestamp_unix_micros, priority, message) = parse_log_line(&line);
            if let Some(wanted) = level {
                let matched = match wanted {
                    LogLevel::Error => priority <= 3,
                    LogLevel::Warning => priority == 4,
                    LogLevel::Info => priority >= 5,
                };
                if !matched {
                    return None;
                }
            }
            Some((
                start,
                LogEntry {
                    timestamp_unix_micros,
                    priority,
                    source: "kixdns".to_owned(),
                    message: truncate(message, 4_096),
                },
            ))
        })
        .collect();
    let has_more = entries.len() > limit;
    entries.truncate(limit);
    let next_cursor = has_more
        .then(|| entries.last().map(|(start, _)| start.to_string()))
        .flatten();
    LogPage {
        entries: entries.into_iter().map(|(_, entry)| entry).collect(),
        next_cursor,
        notice: None,
    }
}

/// 解析 `2026-11-21T20:00:00.123456Z  INFO kixdns: ...` 这种 tracing 行；
/// 认不出时间戳就记 0，级别取时间戳之后的第一个词，不再在整行里搜关键字
/// （否则 `terror.example.com`、`no error` 会被误判成 ERROR）。级别词本身从返回的
/// 消息里删掉，因为面板已经单独显示级别，留着会重复成 `INFO client request finished ...`。
/// Parses a tracing line like `2026-11-21T20:00:00.123456Z  INFO kixdns: ...`;
/// an unparsable timestamp becomes 0 and the level is the first word after the timestamp,
/// instead of scanning the whole line for a keyword (which misreads `terror.example.com`
/// and `no error` as ERROR). The level word itself is stripped from the returned message
/// because the panel already shows the level separately.
#[cfg(unix)]
fn parse_log_line(line: &str) -> (u64, u8, &str) {
    let mut rest = line.trim_start();
    let mut timestamp = 0u64;
    if let Some((head, tail)) = rest.split_once(char::is_whitespace) {
        timestamp = timestamp_micros(head);
        if timestamp > 0 {
            rest = tail.trim_start();
        }
    }
    let first = rest.split_whitespace().next().unwrap_or("");
    let mut message = rest;
    let priority = match first {
        "ERROR" | "Error" | "error" => {
            message = rest[first.len()..].trim_start();
            3
        }
        "WARN" | "Warn" | "warn" | "WARNING" | "Warning" | "warning" => {
            message = rest[first.len()..].trim_start();
            4
        }
        "INFO" | "Info" | "info" | "DEBUG" | "Debug" | "debug" | "TRACE" | "Trace" | "trace" => {
            message = rest[first.len()..].trim_start();
            6
        }
        _ => 6,
    };
    (timestamp, priority, message)
}

/// `2026-11-21T20:00:00.123456Z` / `...123Z` / `...T20:00:00Z`，以及带 `±HH:MM` 偏移的
/// 本地时间（`LocalTime::rfc_3339()`）→ UTC 微秒时间戳；失败返回 0。
/// A trailing `Z` or `±HH:MM` zone is honoured so local-time logs line up with UTC ones.
#[cfg(unix)]
fn timestamp_micros(value: &str) -> u64 {
    let bytes = value.as_bytes();
    if bytes.len() < 20 || bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
        return 0;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        value.get(range).and_then(|part| part.parse::<i64>().ok())
    };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        number(0..4),
        number(5..7),
        number(8..10),
        number(11..13),
        number(14..16),
        number(17..19),
    ) else {
        return 0;
    };
    let mut micros_fraction = 0i64;
    if let Some(dot) = value.find('.') {
        let fraction = value[dot + 1..]
            .chars()
            .take_while(char::is_ascii_digit)
            .take(6)
            .collect::<String>();
        if !fraction.is_empty() {
            let exponent = 6u32.saturating_sub(u32::try_from(fraction.len()).unwrap_or(6));
            let scale = 10i64.pow(exponent);
            micros_fraction = fraction.parse::<i64>().unwrap_or(0) * scale;
        }
    }
    let days = days_from_civil(year, month, day);
    // 时间戳可能带时区：`Z`（UTC）或 `±HH:MM`（本地时间）。内核不接 journald 时写的是带
    // 偏移的本地时间（LocalTime::rfc_3339()），要减掉偏移才能和其它日志对齐。
    // The timestamp may carry a zone: `Z` (UTC) or `±HH:MM` (local time); convert to UTC.
    let tz_offset = parse_timezone_offset(&value[19..]);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - tz_offset;
    u64::try_from(seconds * 1_000_000 + micros_fraction).unwrap_or(0)
}

/// 解析结尾的 `Z` / `+08:00` / `-05:30` 时区偏移成「东为正」的秒数；认不出（没有时区、
/// 乱码）一律当 UTC(0)，与旧行为一致。
/// Parse a trailing `Z` / `+08:00` / `-05:30` zone offset into seconds east of UTC; anything
/// unrecognised (no zone, junk) counts as UTC (0), matching the previous behaviour.
#[cfg(unix)]
fn parse_timezone_offset(suffix: &str) -> i64 {
    let Some(position) = suffix.find(['+', '-']) else {
        return 0;
    };
    let zone = &suffix[position..];
    let sign = if zone.starts_with('-') { -1 } else { 1 };
    let body = &zone[1..];
    let (hours, minutes) = match body.split_once(':') {
        Some((hours, minutes)) => (hours, minutes),
        None if body.len() == 4 => (&body[..2], &body[2..]),
        None if body.len() == 2 => (body, "0"),
        None => return 0,
    };
    let (Ok(hours), Ok(minutes)) = (hours.parse::<i64>(), minutes.parse::<i64>()) else {
        return 0;
    };
    sign * (hours * 3_600 + minutes * 60)
}

/// Howard Hinnant 的 `days_from_civil`，避免为一行日志拉一个日期库。
#[cfg(unix)]
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(unix)]
fn parse_service_status(unit: &str, output: &str) -> Result<ServiceStatus, OperationError> {
    let mut fields = output.lines().filter_map(|line| line.split_once('='));
    let mut active_state = None;
    let mut sub_state = None;
    let mut main_pid = None;
    for (key, value) in &mut fields {
        match key {
            "ActiveState" => active_state = Some(value.to_owned()),
            "SubState" => sub_state = Some(value.to_owned()),
            "MainPID" => main_pid = value.parse().ok(),
            _ => {}
        }
    }
    Ok(ServiceStatus {
        unit: unit.to_owned(),
        active_state: active_state
            .ok_or_else(|| OperationError::Failed("systemctl 缺少 ActiveState".to_owned()))?,
        sub_state: sub_state
            .ok_or_else(|| OperationError::Failed("systemctl 缺少 SubState".to_owned()))?,
        main_pid: main_pid.unwrap_or(0),
        did_not_come_up: false,
        restart_rollback: None,
        pending_writable: None,
    })
}

/// 级别筛选交给 journalctl 而不是浏览器：浏览器只看得到已经翻出来的几页，
/// 一条老错误在读者滚到它之前都是隐身的，计数也只是「已加载里的几条」。
/// The level filter runs in journalctl, not the browser: the browser only sees
/// the pages already loaded, so an old error stays hidden until the reader
/// scrolls to it and the count means "of what happens to be loaded".
#[cfg(any(unix, test))]
fn journal_arguments(
    unit: &str,
    limit: usize,
    before_cursor: Option<&str>,
    level: Option<LogLevel>,
) -> Vec<String> {
    let requested_lines = limit.saturating_add(usize::from(before_cursor.is_some()) + 1);
    let mut arguments = vec![
        "--unit".to_owned(),
        unit.to_owned(),
        "--no-pager".to_owned(),
        "--output=json".to_owned(),
        "--output-fields=__CURSOR,__REALTIME_TIMESTAMP,PRIORITY,SYSLOG_IDENTIFIER,MESSAGE"
            .to_owned(),
        "--reverse".to_owned(),
        "--lines".to_owned(),
        requested_lines.to_string(),
    ];
    if let Some(level) = level {
        arguments.push(format!("--priority={}", level.journal_priority_range()));
    }
    if let Some(cursor) = before_cursor {
        arguments.extend(["--cursor".to_owned(), cursor.to_owned()]);
    }
    arguments
}

/// 读 `systemctl show --property=LoadState,StandardOutput,StandardError` 的输出，
/// 拼出日志页顶部那句提示；journald 能看到 unit 的输出时返回 None。
/// 先看 LoadState：unit 不存在时 systemctl show 仍然退出 0，只是每个属性都打印
/// 默认值（StandardOutput=inherit），不先看它就会把「找不到 unit」说成「输出被
/// 改了去向」。再看输出去向：stdout 只有 journal 和 journal+console 算到；stderr
/// 多一个 inherit（默认值，跟随 stdout）。只重定向了 stderr 也要报：panic 和致命
/// 错误走的正是 stderr。缺字段时视为看得到——猜不准就不吓人。
/// Reads `systemctl show --property=LoadState,StandardOutput,StandardError`
/// and composes the notice shown above the log page; None when journald sees
/// the unit's output. `LoadState` is checked first: for a missing unit
/// `systemctl show` still exits 0 and prints every property's default
/// (StandardOutput=inherit), so without it "unit not found" would read as
/// "output redirected". Then the destinations: stdout counts only as journal
/// or journal+console; stderr additionally as inherit (the default, which
/// follows stdout). A redirected stderr alone is still reported: panics and
/// fatal errors go there. Missing fields count as visible; when unsure, do
/// not alarm.
#[cfg(any(unix, test))]
fn unit_log_notice(unit: &str, output: &str) -> Option<String> {
    let mut load_state = None;
    let mut redirected = Vec::new();
    for (key, value) in output.lines().filter_map(|line| line.split_once('=')) {
        let value = value.trim();
        let reaches_journal = match key {
            "LoadState" => {
                load_state = Some(value);
                continue;
            }
            "StandardOutput" => matches!(value, "journal" | "journal+console"),
            "StandardError" => matches!(value, "inherit" | "journal" | "journal+console"),
            _ => continue,
        };
        if !reaches_journal {
            redirected.push(format!("{key}={}", truncate(value, 256)));
        }
    }
    if let Some(state) = load_state.filter(|state| *state != "loaded") {
        return Some(format!(
            "systemd 里找不到 KixDNS 的服务（{unit}，LoadState={}），日志页读不到它的输出",
            truncate(state, 64)
        ));
    }
    (!redirected.is_empty()).then(|| {
        format!(
            "KixDNS 的输出没有送到 journald（{}），这里只能看到 systemd 记下的启动和停止",
            redirected.join("，")
        )
    })
}

#[cfg(any(unix, test))]
fn parse_journal_page(output: &str, before_cursor: Option<&str>, limit: usize) -> LogPage {
    let mut entries = output
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .map(|value| {
            (
                json_string(&value, "__CURSOR").map(str::to_owned),
                LogEntry {
                    timestamp_unix_micros: json_string(&value, "__REALTIME_TIMESTAMP")
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(0),
                    priority: json_string(&value, "PRIORITY")
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(6),
                    source: truncate(
                        json_string(&value, "SYSLOG_IDENTIFIER").unwrap_or("kixdns"),
                        128,
                    ),
                    message: truncate(json_string(&value, "MESSAGE").unwrap_or(""), 4_096),
                },
            )
        })
        .filter(|(cursor, _)| cursor.as_deref() != before_cursor)
        .collect::<Vec<_>>();
    let has_more = entries.len() > limit;
    entries.truncate(limit);
    let next_cursor = has_more
        .then(|| entries.last().and_then(|(cursor, _)| cursor.clone()))
        .flatten();
    let entries = entries
        .into_iter()
        .map(|(_, entry)| entry)
        .collect::<Vec<_>>();
    LogPage {
        entries,
        next_cursor,
        notice: None,
    }
}

#[cfg(any(unix, test))]
fn json_string<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
}

#[cfg(any(unix, test))]
/// 服务助手回的失败行换成一句人话：去掉协议里的「ERROR」；systemctl 的英文原话不进提示（照样记进日志），给出看原因的命令
/// The helper's failure line becomes one plain sentence: the protocol's ERROR goes; systemctl's English original stays out of the message
/// (it is still logged), and the command to see why is given
#[cfg_attr(not(unix), allow(dead_code))]
fn helper_failure(unit: &str, action: &str, response: &str) -> String {
    let line = response.trim();
    let line = line.strip_prefix("ERROR").map_or(line, str::trim_start);
    tracing::warn!(action, detail = %line, "服务助手报告失败");
    if !line.contains("systemctl") {
        return truncate(line, 1_024);
    }
    let (subject, unit) = match action {
        "start" => ("KixDNS 没能启动", unit),
        "stop" => ("KixDNS 没能停止", unit),
        "restart" => ("KixDNS 没能重启", unit),
        _ => ("面板没能开始在线更新", "kixdns-panel-update.service"),
    };
    format!("{subject}：systemd 拒绝了这次操作。查看原因：journalctl -u {unit} -n 50 --no-pager")
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use hickory_proto::op::{Message, MessageType};
    use serde_json::json;
    use tokio::net::UdpSocket;

    #[cfg(target_os = "linux")]
    use super::procd_status_via_pidfile;
    use super::{
        LogLevel, OperationError, Operations, ServiceAction, helper_failure, journal_arguments,
        parse_journal_page, parse_record_type, procd_logs, unit_log_notice,
    };
    #[cfg(unix)]
    use super::{parse_log_line, parse_procd_status_from_ubus, timestamp_micros};

    // 服务助手的失败不把协议记号和 systemctl 的英文原话交给页面，给出看原因的命令；别的原因照原样
    // A helper failure hands the page neither the protocol token nor systemctl's English original, but the command to see why; other reasons pass through
    #[test]
    fn helper_failures_read_as_one_sentence() {
        let refused = "ERROR systemctl 执行失败: Job for kixdns.service failed because start of the service was attempted too often.\n";
        assert_eq!(
            helper_failure("kixdns.service", "start", refused),
            "KixDNS 没能启动：systemd 拒绝了这次操作。查看原因：journalctl -u kixdns.service -n 50 --no-pager"
        );
        assert_eq!(
            helper_failure("dns.service", "restart", refused),
            "KixDNS 没能重启：systemd 拒绝了这次操作。查看原因：journalctl -u dns.service -n 50 --no-pager"
        );
        assert_eq!(
            helper_failure("kixdns.service", "stop", "ERROR 不支持的动作\n"),
            "不支持的动作"
        );
        assert_eq!(
            OperationError::Failed(
                "连不上面板的服务助手（kixdns-panel-helper）：连接超时".to_owned()
            )
            .to_string(),
            "连不上面板的服务助手（kixdns-panel-helper）：连接超时"
        );
    }

    fn operations(unit: &str) -> Result<Operations, OperationError> {
        Operations::new(
            unit.to_owned(),
            "/run/kixdns-panel/control.sock".into(),
            "127.0.0.1:53".parse().unwrap(),
        )
    }

    /// 这份名单和 scripts/test-unit-name-rule.sh 里的一字不差：Rust 与 bash 各自
    /// 校验同一个 unit 名，一边放行另一边拒绝，面板就会在启动时整个拒绝工作。
    /// The same list as scripts/test-unit-name-rule.sh, verbatim: Rust and bash
    /// each validate the unit name, and if one admits what the other rejects
    /// the whole panel refuses to start.
    #[test]
    fn unit_name_rule_matches_the_installer_fixtures() {
        for unit in [
            "kixdns.service",
            "kixdns@x.service",
            "k.service",
            "0k.service",
            "a-b_c.d.service",
        ] {
            assert!(operations(unit).is_ok(), "should accept {unit}");
        }
        let longest = format!("{}.service", "k".repeat(120));
        assert_eq!(longest.len(), 128);
        assert!(operations(&longest).is_ok());

        let too_long = format!("{}.service", "k".repeat(121));
        assert_eq!(too_long.len(), 129);
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
            assert!(operations(unit).is_err(), "should reject {unit:?}");
        }
    }

    #[test]
    fn level_filter_maps_to_the_frontend_priority_buckets() {
        assert_eq!(LogLevel::parse("error"), Some(LogLevel::Error));
        assert_eq!(LogLevel::parse("warning"), Some(LogLevel::Warning));
        assert_eq!(LogLevel::parse("info"), Some(LogLevel::Info));
        assert_eq!(LogLevel::parse("warn"), None);
        assert_eq!(LogLevel::parse("ERROR"), None);
        assert_eq!(LogLevel::parse(""), None);

        let without = journal_arguments("kixdns.service", 500, None, None);
        assert!(
            !without
                .iter()
                .any(|argument| argument.starts_with("--priority"))
        );
        assert_eq!(without[7], "501");

        let priority = |level| {
            journal_arguments("kixdns.service", 500, Some("c9"), Some(level))
                .into_iter()
                .find(|argument| argument.starts_with("--priority="))
                .unwrap()
        };
        assert_eq!(priority(LogLevel::Error), "--priority=0..3");
        assert_eq!(priority(LogLevel::Warning), "--priority=4..4");
        assert_eq!(priority(LogLevel::Info), "--priority=5..7");
        let paged = journal_arguments("kixdns.service", 500, Some("c9"), Some(LogLevel::Info));
        assert_eq!(paged[7], "502");
        assert_eq!(&paged[9..], ["--cursor", "c9"]);
    }

    #[test]
    fn log_notice_only_when_journald_cannot_see_the_unit() {
        let notice = |output: &str| unit_log_notice("kixdns.service", output);
        assert_eq!(
            notice("LoadState=loaded\nStandardOutput=journal\nStandardError=inherit\n"),
            None
        );
        assert_eq!(
            notice("LoadState=loaded\nStandardOutput=journal+console\nStandardError=journal\n"),
            None
        );
        // unit 不存在：systemctl show 退出 0 并打印 StandardOutput=inherit，
        // 这句必须说「找不到」而不是「输出被改了去向」。
        // Missing unit: systemctl show exits 0 and prints StandardOutput=inherit;
        // the sentence must say "not found", not "output redirected".
        assert_eq!(
            notice("LoadState=not-found\nStandardOutput=inherit\nStandardError=inherit\n")
                .as_deref(),
            Some(
                "systemd 里找不到 KixDNS 的服务（kixdns.service，LoadState=not-found），日志页读不到它的输出"
            )
        );
        assert_eq!(
            notice(
                "LoadState=loaded\nStandardOutput=file:/var/log/kixdns.log\nStandardError=inherit\n"
            )
            .as_deref(),
            Some(
                "KixDNS 的输出没有送到 journald（StandardOutput=file:/var/log/kixdns.log），这里只能看到 systemd 记下的启动和停止"
            )
        );
        assert_eq!(
            notice("StandardOutput=journal\nStandardError=null\n").as_deref(),
            Some(
                "KixDNS 的输出没有送到 journald（StandardError=null），这里只能看到 systemd 记下的启动和停止"
            )
        );
        assert_eq!(
            notice(
                "LoadState=loaded\nStandardOutput=append:/var/log/kixdns.log\nStandardError=truncate:/var/log/kixdns.err\n"
            )
            .as_deref(),
            Some("KixDNS 的输出没有送到 journald（StandardOutput=append:/var/log/kixdns.log，StandardError=truncate:/var/log/kixdns.err），这里只能看到 systemd 记下的启动和停止")
        );
        assert_eq!(notice(""), None);
        assert_eq!(notice("ActiveState=active\n"), None);
    }

    #[test]
    fn rejects_commands_and_unlisted_record_types() {
        assert!(ServiceAction::parse("restart; reboot").is_err());
        assert!(parse_record_type("AXFR").is_err());
        assert!(parse_record_type("AAAA").is_ok());
        assert!(
            Operations::new(
                "../../bad".to_owned(),
                "/run/kixdns-panel/control.sock".into(),
                "127.0.0.1:53".parse().unwrap()
            )
            .is_err()
        );
        assert!(
            Operations::new(
                "--system.service".to_owned(),
                "/run/kixdns-panel/control.sock".into(),
                "127.0.0.1:53".parse().unwrap()
            )
            .is_err()
        );
        assert!(
            Operations::new(
                "kixdns".to_owned(),
                "/run/kixdns-panel/control.sock".into(),
                "127.0.0.1:53".parse().unwrap()
            )
            .is_err()
        );
        assert!(
            Operations::new(
                "kixdns.service".to_owned(),
                "/run/kixdns-panel/control.sock".into(),
                "127.0.0.1:53".parse().unwrap()
            )
            .is_ok()
        );
    }

    #[test]
    fn journal_pages_keep_newest_entries_first_and_exclude_cursor_boundary() {
        let initial = [
            r#"{"__CURSOR":"c3","__REALTIME_TIMESTAMP":"3","PRIORITY":"6","SYSLOG_IDENTIFIER":"kixdns","MESSAGE":"newest"}"#,
            r#"{"__CURSOR":"c2","__REALTIME_TIMESTAMP":"2","PRIORITY":"4","SYSLOG_IDENTIFIER":"kixdns","MESSAGE":"middle"}"#,
            r#"{"__CURSOR":"c1","__REALTIME_TIMESTAMP":"1","PRIORITY":"3","SYSLOG_IDENTIFIER":"kixdns","MESSAGE":"old"}"#,
        ]
        .join("\n");
        let page = parse_journal_page(&initial, None, 2);

        assert_eq!(
            page.entries
                .iter()
                .map(|entry| entry.timestamp_unix_micros)
                .collect::<Vec<_>>(),
            vec![3, 2]
        );
        assert_eq!(page.next_cursor.as_deref(), Some("c2"));

        let older = [
            r#"{"__CURSOR":"c2","__REALTIME_TIMESTAMP":"2","PRIORITY":"4","SYSLOG_IDENTIFIER":"kixdns","MESSAGE":"boundary"}"#,
            r#"{"__CURSOR":"c1","__REALTIME_TIMESTAMP":"1","PRIORITY":"3","SYSLOG_IDENTIFIER":"kixdns","MESSAGE":"older"}"#,
            r#"{"__CURSOR":"c0","__REALTIME_TIMESTAMP":"0","PRIORITY":"6","SYSLOG_IDENTIFIER":"kixdns","MESSAGE":"oldest"}"#,
        ]
        .join("\n");
        let page = parse_journal_page(&older, Some("c2"), 1);

        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].timestamp_unix_micros, 1);
        assert_eq!(page.next_cursor.as_deref(), Some("c1"));
    }

    #[test]
    fn local_diagnostic_server_follows_configured_udp_listener() {
        let operations = Operations::new(
            "kixdns.service".to_owned(),
            "/run/kixdns-panel/control.sock".into(),
            "127.0.0.1:53".parse().unwrap(),
        )
        .unwrap();

        assert_eq!(
            operations
                .diagnostic_server_for(&json!({"settings": {"bind_udp": "0.0.0.0:5353"}}))
                .unwrap(),
            "127.0.0.1:5353".parse().unwrap()
        );
        assert_eq!(
            operations
                .diagnostic_server_for(&json!({"settings": {"bind_udp": "[::]:8053"}}))
                .unwrap(),
            "[::1]:8053".parse().unwrap()
        );
        assert_eq!(
            operations
                .diagnostic_server_for(&json!({"settings": {"bind_udp": "192.0.2.10:5300"}}))
                .unwrap(),
            "192.0.2.10:5300".parse().unwrap()
        );
    }

    #[test]
    fn remote_diagnostic_server_remains_an_explicit_override() {
        let operations = Operations::new(
            "kixdns.service".to_owned(),
            "/run/kixdns-panel/control.sock".into(),
            "192.0.2.53:53".parse().unwrap(),
        )
        .unwrap();

        assert_eq!(
            operations
                .diagnostic_server_for(&json!({"settings": {"bind_udp": "0.0.0.0:5353"}}))
                .unwrap(),
            "192.0.2.53:53".parse().unwrap()
        );
    }

    #[tokio::test]
    async fn dns_query_reaches_non_standard_port_from_current_config() {
        let server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let server_address = server.local_addr().unwrap();
        let responder = tokio::spawn(async move {
            let mut request = vec![0_u8; 512];
            let (length, peer) = server.recv_from(&mut request).await.unwrap();
            let mut response = Message::from_vec(&request[..length]).unwrap();
            response.metadata.message_type = MessageType::Response;
            let response = response.to_vec().unwrap();
            server.send_to(&response, peer).await.unwrap();
        });
        let operations = Operations::new(
            "kixdns.service".to_owned(),
            "/run/kixdns-panel/control.sock".into(),
            "127.0.0.1:53".parse().unwrap(),
        )
        .unwrap();
        let config = json!({
            "settings": {
                "bind_udp": server_address.to_string()
            }
        });

        let result = operations
            .dns_query(&config, "example.com".to_owned(), "A".to_owned())
            .await
            .unwrap();
        responder.await.unwrap();

        assert_eq!(result.server, server_address.to_string());
        assert_eq!(result.response_code, "No Error");
    }

    /// procd 后端（pid 文件兜底）：pid 文件里的进程还活着才算 active；文件没了、pid 死了、
    /// 内容不是数字都算 inactive。`/proc` 只有 Linux 有，所以这条测试只在 Linux 上跑。
    /// procd backend (pid-file fallback): active only while the pid in the pid file is alive; a
    /// missing file, a dead pid or a non-numeric body all read as inactive. `/proc` only exists
    /// on Linux, so this test runs on Linux only.
    #[cfg(target_os = "linux")]
    #[test]
    fn procd_status_follows_the_pid_file() {
        let directory = tempfile::tempdir().unwrap();
        let pidfile = directory.path().join("kixdns.pid");

        let missing = procd_status_via_pidfile("kixdns", &pidfile);
        assert_eq!(missing.unit, "kixdns");
        assert_eq!(missing.active_state, "inactive");
        assert_eq!(missing.sub_state, "dead");
        assert_eq!(missing.main_pid, 0);
        assert!(!missing.did_not_come_up);

        std::fs::write(&pidfile, format!("{}\n", std::process::id())).unwrap();
        let alive = procd_status_via_pidfile("kixdns", &pidfile);
        assert_eq!(alive.active_state, "active");
        assert_eq!(alive.sub_state, "running");
        assert_eq!(alive.main_pid, std::process::id());

        // procd 写的是裸 pid；进程退出后 pid 文件还在，这种残留不能当成 active。
        // procd writes a bare pid; a stale file whose process is gone must not read as active.
        std::fs::write(&pidfile, "4194304\n").unwrap();
        assert_eq!(
            procd_status_via_pidfile("kixdns", &pidfile).active_state,
            "inactive"
        );

        std::fs::write(&pidfile, "not a pid\n").unwrap();
        assert_eq!(
            procd_status_via_pidfile("kixdns", &pidfile).active_state,
            "inactive"
        );
    }

    /// ubus 输出里实例还在跑是 active；实例在但都没 running 是 failed（起不来）；服务不在
    /// 列表里是 inactive（用户停掉了）；读不懂就当没问到，返回 None 交给 pid 文件兜底。
    /// In ubus output an instance that runs is active; instances present but none running is
    /// failed (did not come up); a service absent from the list is inactive (the user stopped
    /// it); unreadable output is None so the pid file takes over.
    #[cfg(unix)]
    #[test]
    fn procd_ubus_output_maps_to_service_status() {
        let running = parse_procd_status_from_ubus(
            "kixdns.service",
            r#"{"kixdns":{"instances":{"instance1":{"running":true,"pid":4321}}}}"#,
        )
        .expect("可读的 ubus 输出");
        assert_eq!(running.active_state, "active");
        assert_eq!(running.sub_state, "running");
        assert_eq!(running.main_pid, 4321);

        // respawn 耗尽 / 崩溃没被拉起：实例还在，但 running=false。
        // Respawn exhausted / crashed and not restarted: the instance is still there, running=false.
        let failed = parse_procd_status_from_ubus(
            "kixdns.service",
            r#"{"kixdns":{"instances":{"instance1":{"running":false,"pid":0}}}}"#,
        )
        .expect("可读的 ubus 输出");
        assert_eq!(failed.active_state, "failed");
        assert_eq!(failed.sub_state, "failed");

        // 用户 stop 掉了，procd 把它从列表里删了。
        // The user stopped it, so procd removed it from the list.
        let stopped =
            parse_procd_status_from_ubus("kixdns.service", "{}").expect("可读的 ubus 输出");
        assert_eq!(stopped.active_state, "inactive");

        // 输出不是 JSON：当作没问到。
        // The output is not JSON: treat it as "did not get an answer".
        assert!(parse_procd_status_from_ubus("kixdns.service", "not json").is_none());
    }

    /// 日志页按行倒序给，游标是行的文件绝对字节偏移；翻旧页只取偏移更小的行，并识别 tracing 的级别。
    /// The log page is newest-first, the cursor is the line's absolute byte offset: paging back
    /// only takes smaller offsets, and the tracing level is recognised.
    #[cfg(unix)]
    #[tokio::test]
    async fn procd_logs_page_backwards_through_the_file() {
        let directory = tempfile::tempdir().unwrap();
        let logfile = directory.path().join("kixdns.log");
        std::fs::write(
            &logfile,
            "2026-11-21T00:00:01.000000Z  INFO dns server started bind_udp=127.0.0.1:20553 第一行\n\
             2026-11-21T00:00:02.000000Z  WARN dns upstream slow 第二行\n\
             2026-11-21T00:00:03.000000Z ERROR dns server exited boom 第三行\n",
        )
        .unwrap();

        let first = procd_logs(&logfile, 2, None, None).await;
        assert_eq!(first.entries.len(), 2);
        assert!(
            first.entries[0].message.contains("第三行"),
            "{:?}",
            first.entries[0]
        );
        assert!(first.entries[1].message.contains("第二行"));
        assert_eq!(
            first.entries[0].timestamp_unix_micros,
            1_795_219_203_000_000
        );
        assert_eq!(first.entries[0].priority, 3);
        assert_eq!(first.entries[1].priority, 4);
        assert!(first.notice.is_none());

        let cursor = first.next_cursor.clone().expect("还有更旧的日志");
        let older = procd_logs(&logfile, 2, Some(&cursor), None).await;
        assert_eq!(older.entries.len(), 1);
        assert!(older.entries[0].message.contains("第一行"));
        assert!(older.next_cursor.is_none(), "第一页之后不该再给游标");

        let errors = procd_logs(&logfile, 10, None, Some(LogLevel::Error)).await;
        assert_eq!(errors.entries.len(), 1);
        assert!(errors.entries[0].message.contains("第三行"));
        let warnings = procd_logs(&logfile, 10, None, Some(LogLevel::Warning)).await;
        assert_eq!(warnings.entries.len(), 1);
        assert!(warnings.entries[0].message.contains("第二行"));

        // 日志文件还没建出来时是空页，不是错误：进程刚起来就会有人看日志页。
        // A log file that does not exist yet is an empty page, not an error.
        let empty = procd_logs(&directory.path().join("missing.log"), 10, None, None).await;
        assert!(empty.entries.is_empty());
        assert!(empty.next_cursor.is_none());
    }

    /// 只认时间戳后的第一个词当级别，正文里的 error/warn 字样不该误判；级别词本身也不该
    /// 留在消息里（面板已经单独显示级别）。
    /// Only the first word after the timestamp is the level; "error"/"warn" inside the message
    /// must not be misread, and the level word itself must not stay in the message.
    #[cfg(unix)]
    #[test]
    fn log_level_comes_from_the_word_after_the_timestamp() {
        let (_, priority, message) =
            parse_log_line("2026-11-21T00:00:01.000000Z  INFO resolved terror.example.com");
        assert_eq!(priority, 6, "正文里的 terror 不该被当成 ERROR");
        assert_eq!(
            message, "resolved terror.example.com",
            "INFO 级别词要从消息里删掉"
        );
        let (_, priority, _) =
            parse_log_line("2026-11-21T00:00:01.000000Z  INFO kixdns: no error happened");
        assert_eq!(priority, 6, "正文里的 error 不该被当成 ERROR");
        let (_, priority, message) =
            parse_log_line("2026-11-21T00:00:01.000000Z   WARN kixdns: warner");
        assert_eq!(priority, 4, "WARN 行要判成 warning");
        assert_eq!(message, "kixdns: warner", "WARN 级别词要从消息里删掉");
        let (_, priority, message) = parse_log_line("2026-11-21T00:00:01.000000Z ERROR boom");
        assert_eq!(priority, 3);
        assert_eq!(message, "boom", "ERROR 级别词要从消息里删掉");
    }

    /// `2026-11-21T00:00:00.123456Z` 这类 tracing 时间戳要能被认出来，认不出就记 0；
    /// 带 `Z` 或 `±HH:MM` 时区偏移的都要按 UTC 归一。
    /// Tracing timestamps like `2026-11-21T00:00:00.123456Z` are parsed; `Z` and `±HH:MM`
    /// offsets are both normalised to UTC; nonsense becomes 0.
    #[cfg(unix)]
    #[test]
    fn tracing_timestamps_parse_to_micros() {
        assert_eq!(
            timestamp_micros("2026-11-21T00:00:00Z"),
            1_795_219_200_000_000
        );
        assert_eq!(
            timestamp_micros("2024-02-29T12:34:56.123456Z"),
            1_709_210_096_123_456
        );
        assert_eq!(
            timestamp_micros("2000-01-01T00:00:00.5Z"),
            946_684_800_500_000
        );
        // 东八区本地时间 15:00:02 == UTC 07:00:02；和 Z 结尾的同一墙钟时间差 8 小时。
        assert_eq!(
            timestamp_micros("2026-11-22T15:00:02.000000+08:00"),
            1_795_330_802_000_000
        );
        // 西五区本地时间 10:00:02 == UTC 15:00:02。
        assert_eq!(
            timestamp_micros("2026-11-22T10:00:02.000000-05:00"),
            1_795_359_602_000_000
        );
        // 没有时区后缀时按 UTC 处理，和旧行为一致。
        assert_eq!(
            timestamp_micros("2026-11-21T00:00:00.123456"),
            1_795_219_200_123_456
        );
        assert_eq!(timestamp_micros("不是时间"), 0);
        assert_eq!(timestamp_micros(""), 0);
    }
}
