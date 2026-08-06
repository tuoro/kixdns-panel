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
pub struct DnsDiagnostic {
    pub server: String,
    pub domain: String,
    pub record_type: String,
    pub response_code: String,
    pub elapsed_ms: u64,
    pub truncated: bool,
    pub answers: Vec<String>,
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
    pub async fn logs(&self, limit: usize) -> Result<Vec<LogEntry>, OperationError> {
        let limit = limit.clamp(1, 500).to_string();
        let output = run_command(
            "journalctl",
            &[
                "--unit",
                self.service_unit.as_ref(),
                "--no-pager",
                "--output=json",
                "--output-fields=__REALTIME_TIMESTAMP,PRIORITY,SYSLOG_IDENTIFIER,MESSAGE",
                "--lines",
                &limit,
            ],
            Duration::from_secs(10),
        )
        .await?;
        Ok(parse_journal(&output))
    }

    #[cfg(not(unix))]
    #[allow(clippy::unused_async)]
    pub async fn logs(&self, _limit: usize) -> Result<Vec<LogEntry>, OperationError> {
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

#[cfg(unix)]
fn parse_journal(output: &str) -> Vec<LogEntry> {
    output
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .map(|value| LogEntry {
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
        })
        .collect()
}

#[cfg(unix)]
fn json_string<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
}

#[cfg(unix)]
fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use hickory_proto::op::{Message, MessageType};
    use serde_json::json;
    use tokio::net::UdpSocket;

    use super::{Operations, ServiceAction, parse_record_type};

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
