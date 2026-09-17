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
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceStatus {
    pub unit: String,
    pub active_state: String,
    pub sub_state: String,
    pub main_pid: u32,
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
    #[error("宿主机操作失败：{0}")]
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
            return Err(OperationError::Invalid("systemd unit 名称无效".to_owned()));
        }
        Ok(Self {
            service_unit: Arc::from(service_unit),
            service_helper_socket,
            diagnostic_server,
        })
    }

    #[cfg(unix)]
    pub async fn service_status(&self) -> Result<ServiceStatus, OperationError> {
        let output = run_command(
            "systemctl",
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
        .map_err(|_| OperationError::Failed("helper 连接超时".to_owned()))?
        .map_err(|error| OperationError::Failed(format!("无法连接服务控制 helper：{error}")))?;
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
            return Err(OperationError::Failed(truncate(&response, 1_024)));
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
            run_command("systemctl", &show_arguments, Duration::from_secs(10))
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
            "systemd 里找不到 unit {unit}（LoadState={}），日志页读不到它的输出",
            truncate(state, 64)
        ));
    }
    (!redirected.is_empty()).then(|| {
        format!(
            "这个 unit 的输出没有送到 journald（{}），这里只会看到 systemd 自己的启停记录",
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
fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use hickory_proto::op::{Message, MessageType};
    use serde_json::json;
    use tokio::net::UdpSocket;

    use super::{
        LogLevel, OperationError, Operations, ServiceAction, journal_arguments, parse_journal_page,
        parse_record_type, unit_log_notice,
    };

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
                "systemd 里找不到 unit kixdns.service（LoadState=not-found），日志页读不到它的输出"
            )
        );
        assert_eq!(
            notice(
                "LoadState=loaded\nStandardOutput=file:/var/log/kixdns.log\nStandardError=inherit\n"
            )
            .as_deref(),
            Some(
                "这个 unit 的输出没有送到 journald（StandardOutput=file:/var/log/kixdns.log），这里只会看到 systemd 自己的启停记录"
            )
        );
        assert_eq!(
            notice("StandardOutput=journal\nStandardError=null\n").as_deref(),
            Some(
                "这个 unit 的输出没有送到 journald（StandardError=null），这里只会看到 systemd 自己的启停记录"
            )
        );
        assert_eq!(
            notice(
                "LoadState=loaded\nStandardOutput=append:/var/log/kixdns.log\nStandardError=truncate:/var/log/kixdns.err\n"
            )
            .as_deref(),
            Some("这个 unit 的输出没有送到 journald（StandardOutput=append:/var/log/kixdns.log，StandardError=truncate:/var/log/kixdns.err），这里只会看到 systemd 自己的启停记录")
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
}
