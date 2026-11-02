use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use prometheus_parse::{Sample, Scrape, Value as MetricValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg_attr(not(unix), allow(dead_code))]
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const CONTROL_PROTOCOL_VERSION: u8 = 1;

#[derive(Clone)]
pub struct ControlClient {
    #[cfg_attr(not(unix), allow(dead_code))]
    socket_path: Arc<PathBuf>,
    /// 取查询日志用过的连接，留着接着用：积压时每秒几百页，每页都新建连接，两边都白花系统调用
    /// The connections query log takes have used, kept for the next ones: with hundreds of pages a second while
    /// records pile up, a new connection per page costs both sides system calls for nothing
    #[cfg(unix)]
    idle: Arc<std::sync::Mutex<Vec<Connection>>>,
}

/// 一条控制连接 / A control connection
#[cfg(unix)]
type Connection = hyper::client::conn::http1::SendRequest<http_body_util::Full<bytes::Bytes>>;

/// 最多留几条用过的连接：同时取的页数之外留些余地 / The most connections kept: some room beyond the pages taken at once
#[cfg(unix)]
const IDLE_CONNECTIONS: usize = 8;

/// 连接的时限 / The time limit for connecting
#[cfg(unix)]
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Health {
    pub protocol_version: u8,
    pub status: String,
    pub pid: u32,
    pub version: String,
    /// fork 发布时编译进去的日期版本和提交；补丁集构建和本地构建没有。
    /// The date version and commit a fork release compiles in; patchset and local builds
    /// have neither.
    #[serde(default)]
    pub release_version: Option<String>,
    #[serde(default)]
    pub release_commit: Option<String>,
    pub upstream_commit: String,
    pub patchset: String,
    pub started_at_unix: u64,
    pub uptime_seconds: u64,
    pub config_generation: u64,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveConfig {
    pub protocol_version: u8,
    pub generation: u64,
    pub sha256: String,
    pub loaded_at_unix: u64,
    pub reload_sequence: u64,
    pub last_reload: ReloadResult,
    /// 配置里改过、要重启 `KixDNS` 才生效的设置（内核的设置名）；不报告它的内核为 `None`
    ///
    /// Settings the configuration changed that take a restart of `KixDNS` to apply (the
    /// kernel's setting names); `None` from a kernel that does not report it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_pending: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReloadResult {
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationResult {
    pub protocol_version: u8,
    pub valid: bool,
    pub pipeline_count: usize,
    pub rule_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheFlushResult {
    pub protocol_version: u8,
    pub response_entries_before: u64,
    pub response_entries_after: u64,
    pub rule_entries_before: u64,
    pub rule_entries_after: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryStatsSnapshot {
    pub protocol_version: u8,
    pub enabled: bool,
    pub anonymized_clients: bool,
    pub window_seconds: u64,
    pub retention_seconds: u64,
    pub generated_at_unix: u64,
    pub requests_observed: u64,
    pub dropped_updates: u64,
    pub clients: Vec<NamedCount>,
    pub domains: Vec<NamedCount>,
    #[serde(default = "default_live")]
    pub live: bool,
    #[serde(default)]
    pub captured_at_unix: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatsClearResult {
    pub protocol_version: u8,
    pub cleared: bool,
}

/// 会等着交的内核（`querylog_wait_v1`）多认的两项 / What a kernel that can wait (`querylog_wait_v1`) also takes
#[derive(Debug, Clone, Copy)]
pub struct QueryLogWait {
    /// 游标是哪个内核进程的：是这个内核自己的，`after` 及以前的它就删掉（面板已经存好了）；是别的进程的，它不等、马上回
    /// The kernel process the cursor belongs to: if it is this kernel's own, the kernel deletes everything up to
    /// `after` (the panel has stored it); if another process's, the kernel answers at once without waiting
    pub instance: Option<u64>,
    /// 面板存好到哪一条（`querylog_stored_v1`）：给了它，内核只删到这里，`after` 只说从哪往后取。面板同时取着好几段
    /// 时取到哪和存到哪不是一回事
    /// The record the panel has stored up to (`querylog_stored_v1`): given it, the kernel deletes only up to here and
    /// `after` only says where to take from. A panel taking several ranges at once has taken further than it stored
    pub stored: Option<u64>,
    /// 只取到这个序号为止（`querylog_until_v1`）：前面被挤掉了一截时，这一页也不越界交出下一页的记录
    /// No record past this number (`querylog_until_v1`): with a stretch before it pushed out, the page still does not
    /// hand over the next page's records
    pub until: Option<u64>,
    /// 要编好的记录（`querylog_records_v1`）：内核把交接区里的字节原样交出来，不再写成 JSON
    /// Ask for the encoded records (`querylog_records_v1`): the kernel hands over the ring's bytes as they are
    /// instead of writing them as JSON
    pub records: bool,
    /// 攒不满一页时最多等多久 / How long the kernel may wait at most while a page has not filled
    pub wait: Duration,
}

/// 取一页查询日志的路径和时限：让内核等的那么久加在平常的时限上
/// The path and time limit for taking a page of the query log: however long the kernel may wait is added to the usual
/// limit
fn querylog_request(after: u64, limit: usize, waiting: Option<QueryLogWait>) -> (String, Duration) {
    let mut path = format!("/v1/querylog?after={after}&limit={limit}");
    let mut timeout = REQUEST_TIMEOUT;
    if let Some(waiting) = waiting {
        if let Some(until) = waiting.until {
            let _ = write!(path, "&until={until}");
        }
        if let Some(instance) = waiting.instance {
            let _ = write!(path, "&instance={instance}");
        }
        if let Some(stored) = waiting.stored {
            let _ = write!(path, "&stored={stored}");
        }
        if waiting.records {
            path.push_str("&format=records1");
        }
        let _ = write!(path, "&wait_ms={}", waiting.wait.as_millis());
        timeout += waiting.wait;
    }
    (path, timeout)
}

/// 内核查询日志的一页（`querylog_v1`）：`after` 之后的条目，按 `seq` 从小到大
/// One page of the kernel's query log (`querylog_v1`): the entries after `after`, in ascending `seq`
#[derive(Debug, Clone)]
pub struct QueryLogPage {
    pub protocol_version: u8,
    /// 这个内核进程开始记的时刻（毫秒），换了进程就变 / When this kernel process started recording (ms); a new process changes it
    pub instance: u64,
    /// 最新一条的编号 / The newest number given out
    pub newest_seq: u64,
    /// 游标之后已经被挤掉或清掉、取不到了的条数 / Records after the cursor that were pushed out or cleared and are gone
    pub missed: u64,
    /// 同时在处理的请求太多、没记下的累计数 / The running count of requests not recorded because too many were in flight
    pub untracked: u64,
    /// 还有，马上接着取 / More are waiting; fetch again right away
    pub more: bool,
    pub entries: QueryLogEntries,
}

/// 一页里的记录。内核把 `entries` 写在最后，这时交出整页原文和记录开始的地方，由采集的人一条条读：读面板要看的
/// 几项时就找到了这一条的结尾，每条只扫一遍。页的样子出乎意料时，整页照常解析，交出各条的原文
/// The records of a page. The kernel writes `entries` last, and then the page's text goes out with where the
/// records begin, for the collector to read one by one: reading the items the panel looks at finds where each
/// record ends, so each is scanned once. A page shaped otherwise is parsed whole as usual and each record's text
/// goes out
#[derive(Debug, Clone)]
pub enum QueryLogEntries {
    /// 整页原文，记录从 `at` 开始（`[` 之后），还没校验 / The page's text, the records beginning at `at` (after the
    /// `[`), not yet checked
    Text { page: String, at: usize },
    /// 各条的原文，照写下来（见 `querylog::KernelEntry`）/ Each record's text, written as it is (see `querylog::KernelEntry`)
    Raw(Vec<Box<serde_json::value::RawValue>>),
    /// 内核编好的记录（`querylog_records_v1`）：整页原文，第一条的序号，各条在原文里的位置
    /// The kernel's encoded records (`querylog_records_v1`): the page's body, the first record's number, and
    /// where each record sits in the body
    Records {
        page: Vec<u8>,
        first: u64,
        records: Vec<std::ops::Range<usize>>,
    },
}

impl QueryLogEntries {
    /// 各条的原文：整页原文先整页解析 / Each record's text, the page's text parsed whole first
    ///
    /// # Errors
    ///
    /// 整页解析不了时 / When the page does not parse
    pub fn into_raw(self) -> serde_json::Result<Vec<Box<serde_json::value::RawValue>>> {
        match self {
            Self::Text { page, .. } => {
                Ok(serde_json::from_str::<WholeQueryLogPage>(&page)?.entries)
            }
            Self::Raw(entries) => Ok(entries),
            Self::Records {
                page,
                first,
                records,
            } => (first..)
                .zip(records)
                .map(|(seq, range)| {
                    let mut json = Vec::new();
                    crate::querylog_records::write_record(seq, &page[range], &mut json)
                        .ok_or_else(|| {
                            serde::de::Error::custom(format!("第 {seq} 条编好的记录读不通"))
                        })?;
                    let text = String::from_utf8(json).map_err(serde::de::Error::custom)?;
                    serde_json::value::RawValue::from_string(text)
                })
                .collect(),
        }
    }
}

/// 整页照常解析时的样子 / A page as parsed whole
#[derive(Deserialize)]
struct WholeQueryLogPage {
    protocol_version: u8,
    instance: u64,
    newest_seq: u64,
    missed: u64,
    #[serde(default)]
    untracked: u64,
    more: bool,
    entries: Vec<Box<serde_json::value::RawValue>>,
}

/// `entries` 之前的那几项 / The items before `entries`
#[derive(Deserialize)]
struct QueryLogPageHead {
    protocol_version: u8,
    instance: u64,
    newest_seq: u64,
    missed: u64,
    #[serde(default)]
    untracked: u64,
    more: bool,
}

impl QueryLogPage {
    /// 读一页。`entries` 在最后时只读前面那几项，记录留给采集的人一条条读；否则整页解析。解析不了时连同原文交回，
    /// 好再看是不是协议版本不对
    /// Reads a page. With `entries` last only the items before it are read and the records are left for the
    /// collector to read one by one; otherwise the page is parsed whole. On failure the text comes back too, to check
    /// whether the protocol version is wrong
    fn parse(body: Vec<u8>) -> Result<Self, (serde_json::Error, Vec<u8>)> {
        // 前面那几项都是数字和真假，键名不会出现在字符串里 / The items before are numbers and booleans, so the key
        // cannot sit inside a string
        const KEY: &str = ",\"entries\":[";
        if body.starts_with(crate::querylog_records::MAGIC) {
            return Self::parse_records(body);
        }
        let page = match String::from_utf8(body) {
            Ok(page) => page,
            Err(error) => return Self::parse_whole(error.into_bytes()),
        };
        let head = page
            .get(..page.len().min(4_096))
            .and_then(|head| head.find(KEY))
            .and_then(|key| {
                let head = serde_json::from_str::<QueryLogPageHead>(&format!("{}}}", &page[..key]));
                Some((key, head.ok()?))
            });
        let Some((key, head)) = head else {
            return Self::parse_whole(page.into_bytes());
        };
        Ok(Self {
            protocol_version: head.protocol_version,
            instance: head.instance,
            newest_seq: head.newest_seq,
            missed: head.missed,
            untracked: head.untracked,
            more: head.more,
            entries: QueryLogEntries::Text {
                at: key + KEY.len(),
                page,
            },
        })
    }

    /// 内核编好的记录（`querylog_records_v1`）的一页 / A page of the kernel's encoded records
    /// (`querylog_records_v1`)
    fn parse_records(body: Vec<u8>) -> Result<Self, (serde_json::Error, Vec<u8>)> {
        let Some(head) = crate::querylog_records::RecordsPage::read(&body) else {
            return Err((serde::de::Error::custom("编好的记录这一页读不通"), body));
        };
        Ok(Self {
            protocol_version: head.protocol_version,
            instance: head.instance,
            newest_seq: head.newest_seq,
            missed: head.missed,
            untracked: head.untracked,
            more: head.more,
            entries: QueryLogEntries::Records {
                page: body,
                first: head.first,
                records: head.records,
            },
        })
    }

    fn parse_whole(body: Vec<u8>) -> Result<Self, (serde_json::Error, Vec<u8>)> {
        let page: WholeQueryLogPage = match serde_json::from_slice(&body) {
            Ok(page) => page,
            Err(error) => return Err((error, body)),
        };
        Ok(Self {
            protocol_version: page.protocol_version,
            instance: page.instance,
            newest_seq: page.newest_seq,
            missed: page.missed,
            untracked: page.untracked,
            more: page.more,
            entries: QueryLogEntries::Raw(page.entries),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticTrace {
    pub protocol_version: u8,
    pub domain: String,
    pub record_type: String,
    /// 内核实际按哪个客户端 IP 处理的；p28 之前的内核不返回 / The client IP the kernel actually used; kernels before p28 omit it
    #[serde(default)]
    pub client_ip: Option<String>,
    /// 是不是用草稿配置试跑的 / Whether this ran against the draft config
    #[serde(default)]
    pub candidate: bool,
    pub response_code: String,
    pub elapsed_ms: u64,
    pub truncated: bool,
    pub answers: Vec<String>,
    pub trace_truncated: bool,
    pub trace: Vec<DiagnosticTraceStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticTraceStep {
    pub stage: String,
    pub status: String,
    pub label: String,
    pub detail: Option<String>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Deserialize)]
struct ProtocolEnvelope {
    protocol_version: u8,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MetricsSnapshot {
    pub requests_total: u64,
    pub requests_inflight: u64,
    pub cache_lookups_total: u64,
    pub cache_hits_fresh: u64,
    pub cache_hits_stale: u64,
    pub cache_entries: u64,
    pub config_generation: u64,
    pub reload_success: u64,
    pub reload_failure: u64,
    pub pipelines: Vec<NamedCount>,
    pub rules: Vec<RuleCount>,
    pub upstreams: Vec<UpstreamCount>,
    /// 请求完成状态计数；增强版 p20 起提供，旧版本为 0。
    #[serde(default)]
    pub requests_finished: FinishedCounts,
    /// 端到端耗时摘要；增强版 p20 起提供。
    #[serde(default)]
    pub request_latency: RequestLatency,
    /// 过期缓存命中的原因拆分；增强版 p20 起提供。
    #[serde(default)]
    pub cache_stale: StaleBreakdown,
    /// 最近一段时间的端到端耗时，与 `recent_window_seconds` 同一个窗口；没有窗口时为空。
    /// End-to-end latency over the same window as `recent_window_seconds`; empty
    /// without a window.
    #[serde(default)]
    pub request_latency_recent: Option<RequestLatency>,
    /// 各上游 `recent` 与 `request_latency_recent` 实际覆盖的秒数，最长一小时；还没有
    /// 可比的采样时为空。
    /// Seconds actually covered by each upstream's `recent` and by
    /// `request_latency_recent`, at most an hour; empty until there is a sample to
    /// compare against.
    #[serde(default)]
    pub recent_window_seconds: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FinishedCounts {
    pub completed: u64,
    pub failed: u64,
    pub cancelled: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RequestLatency {
    pub samples: u64,
    pub avg_ms: f64,
    /// 10 ms 内返回的请求数。 / Requests answered within 10 ms.
    #[serde(default)]
    pub within_10ms: u64,
    /// 100 ms 内返回的请求数，用于"绝大多数请求在 100 ms 内返回"。
    pub within_100ms: u64,
    /// 1 s 内返回的请求数。 / Requests answered within 1 s.
    #[serde(default)]
    pub within_1s: u64,
    /// 耗时累计值，只给窗口相减用。 / The latency total, kept only for window arithmetic.
    #[serde(skip)]
    pub sum_ms: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StaleBreakdown {
    pub expired: u64,
    pub client_timeout: u64,
    pub upstream_failure: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamedCount {
    pub name: String,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleCount {
    pub pipeline: String,
    pub rule: String,
    pub phase: String,
    pub count: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpstreamCount {
    pub upstream: String,
    pub transport: String,
    pub attempts: u64,
    pub success: u64,
    pub errors: u64,
    pub rejected: u64,
    /// 并发竞争中被取消的尝试；增强版 p19 起上报，旧版本缺省为 0。
    #[serde(default)]
    pub aborted: u64,
    /// 上游回了限速（DoH 的 HTTP 429）的尝试：既不算成功也不算失败；认得限速的内核才上报，更早的缺省为 0。
    /// Attempts the upstream answered with a rate limit (`DoH` HTTP 429): neither a success nor a failure; only kernels that know
    /// rate limits report them, 0 for older ones.
    #[serde(default)]
    pub throttled: u64,
    /// 已结算尝试的平均耗时（毫秒）；增强版 p20 起提供。
    #[serde(default)]
    pub avg_latency_ms: Option<f64>,
    /// 按响应码计数；增强版 p20 起提供。
    #[serde(default)]
    pub rcodes: Vec<NamedCount>,
    /// 选定 UDP 但靠 TCP 兜底才拿到答案的次数；增强版 p20 起提供。
    #[serde(default)]
    pub tcp_fallbacks: u64,
    /// 最近一段时间（最长一小时）的计数，由面板每分钟的采样做差得到。
    /// Counts over the recent window (at most an hour), taken as the difference
    /// against the panel's per-minute samples.
    #[serde(default)]
    pub recent: Option<UpstreamTally>,
    /// 算平均耗时用的累计耗时与次数，只在进程内用来求窗口差，不下发。
    /// The latency sum and count behind `avg_latency_ms`, kept in process for
    /// window differences and never sent out.
    #[serde(skip)]
    pub latency_sum_ms: f64,
    #[serde(skip)]
    pub latency_samples: u64,
}

/// 一段时间内某个上游的计数。 / One upstream's counts over a period.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UpstreamTally {
    pub attempts: u64,
    pub success: u64,
    pub errors: u64,
    pub rejected: u64,
    pub aborted: u64,
    /// 旧版面板存下的概览快照里没有这一项，读出来按 0 算
    /// Overview snapshots saved by older panels lack it; it reads back as 0
    #[serde(default)]
    pub throttled: u64,
    pub tcp_fallbacks: u64,
    pub avg_latency_ms: Option<f64>,
}

const fn default_live() -> bool {
    true
}

#[derive(Debug, thiserror::Error)]
pub enum ControlError {
    // 这些说法会原样出现在页面上：说发生了什么，不用「增强控制接口」这类内部叫法
    // These read verbatim on the page: they say what happened, without internal names such as 增强控制接口
    #[error("连不上 KixDNS：{0}")]
    Unavailable(String),
    #[error("读不懂 KixDNS 的回应：{0}")]
    Protocol(String),
    /// 回应超过 8 MiB 的上限 / The reply is over the 8 MiB cap
    #[error("KixDNS 的回应太大了：{0}")]
    #[cfg_attr(not(unix), allow(dead_code))]
    TooLarge(String),
    #[error("KixDNS 没有接受这份配置：{0}")]
    Rejected(String),
    #[error("KixDNS 不支持：{0}")]
    #[cfg_attr(not(unix), allow(dead_code))]
    Unsupported(String),
}

impl ControlClient {
    #[must_use]
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            socket_path: Arc::new(socket_path),
            #[cfg(unix)]
            idle: Arc::default(),
        }
    }

    pub async fn health(&self) -> Result<Health, ControlError> {
        self.get_json("/v1/health").await
    }

    pub async fn active_config(&self) -> Result<ActiveConfig, ControlError> {
        self.get_json("/v1/config/active").await
    }

    pub async fn metrics(&self) -> Result<MetricsSnapshot, ControlError> {
        let (_, body) = self.request("GET", "/v1/metrics", Vec::new()).await?;
        let text = String::from_utf8(body)
            .map_err(|_| ControlError::Protocol("指标响应不是 UTF-8".to_owned()))?;
        parse_metrics(&text)
    }

    pub async fn top_stats(
        &self,
        window_seconds: u64,
        limit: usize,
    ) -> Result<QueryStatsSnapshot, ControlError> {
        self.get_json(&format!(
            "/v1/stats/top?window={window_seconds}&limit={limit}"
        ))
        .await
    }

    /// 取 `after` 之后的查询日志。每条最多带 64 步，一页 250 条也在 8 MiB 的应答上限以内。
    /// Takes the query log after `after`. An entry carries at most 64 steps, so a page of 250 stays within the 8 MiB reply cap.
    /// 一页可能有几 MB，只解析一遍：协议版本也从这一遍里读，解析不了时再看是不是版本不对
    /// A page may run to megabytes, so it is parsed once: the protocol version is read in the same
    /// pass, and only when that fails is the version checked on its own
    ///
    /// 给了 `waiting`，内核攒不满一页时最多等这么久再回，存好了的也删掉（见 [`QueryLogWait`]）
    /// With `waiting`, a kernel short of a page waits at most that long before answering, and deletes what is stored
    /// (see [`QueryLogWait`])
    pub async fn querylog(
        &self,
        after: u64,
        limit: usize,
        waiting: Option<QueryLogWait>,
    ) -> Result<QueryLogPage, ControlError> {
        let (path, timeout) = querylog_request(after, limit, waiting);
        let (_, body) = self.request_reusing(&path, timeout).await?;
        let page =
            QueryLogPage::parse(body).map_err(|(error, body)| {
                match serde_json::from_slice::<ProtocolEnvelope>(&body) {
                    Ok(envelope) if envelope.protocol_version != CONTROL_PROTOCOL_VERSION => {
                        unsupported_protocol(&path, envelope.protocol_version)
                    }
                    _ => ControlError::Protocol(format!("解析 {path} 响应失败：{error}")),
                }
            })?;
        if page.protocol_version != CONTROL_PROTOCOL_VERSION {
            return Err(unsupported_protocol(&path, page.protocol_version));
        }
        Ok(page)
    }

    pub async fn clear_stats(&self) -> Result<StatsClearResult, ControlError> {
        self.post_json("/v1/stats/clear", Vec::new()).await
    }

    pub async fn validate(&self, content: &Value) -> Result<ValidationResult, ControlError> {
        let body = serde_json::to_vec(content)
            .map_err(|error| ControlError::Protocol(format!("序列化候选配置失败：{error}")))?;
        self.post_json("/v1/config/validate", body).await
    }

    pub async fn flush_cache(&self) -> Result<CacheFlushResult, ControlError> {
        self.post_json("/v1/cache/flush", Vec::new()).await
    }

    /// 在正在用的配置上诊断一次查询。内核自己最多跑 6 秒，这里多等两秒，让内核的超时说明能传回来。
    /// Diagnose one query on the live config. The kernel runs at most 6 seconds; waiting two more lets its own timeout message come back.
    pub async fn diagnostic_trace(
        &self,
        domain: &str,
        record_type: &str,
        client_ip: Option<std::net::IpAddr>,
    ) -> Result<DiagnosticTrace, ControlError> {
        let body = serde_json::to_vec(&diagnostic_body(domain, record_type, client_ip, None))
            .map_err(|error| ControlError::Protocol(format!("序列化诊断请求失败：{error}")))?;
        self.post_json_within("/v1/diagnostics/trace", body, Duration::from_secs(8))
            .await
    }

    /// 拿草稿配置试跑一次查询（内核 p28 起）。内核总时限 12 秒，这里等 15 秒。
    /// Run one query against the draft config (kernel p28 on). The kernel's limit is 12 seconds; this waits 15.
    pub async fn diagnostic_trace_candidate(
        &self,
        domain: &str,
        record_type: &str,
        client_ip: Option<std::net::IpAddr>,
        config: &Value,
    ) -> Result<DiagnosticTrace, ControlError> {
        let body = serde_json::to_vec(&diagnostic_body(
            domain,
            record_type,
            client_ip,
            Some(config),
        ))
        .map_err(|error| ControlError::Protocol(format!("序列化试跑请求失败：{error}")))?;
        self.post_json_within(
            "/v1/diagnostics/trace-candidate",
            body,
            Duration::from_secs(15),
        )
        .await
    }

    pub async fn wait_for_config(
        &self,
        sha256: &str,
        after_sequence: u64,
        timeout: Duration,
    ) -> Result<ActiveConfig, ControlError> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let active = self.active_config().await?;
            if active.reload_sequence > after_sequence
                && active.sha256 == sha256
                && active.last_reload.success
            {
                return Ok(active);
            }
            if active.reload_sequence > after_sequence && !active.last_reload.success {
                return Err(ControlError::Rejected(
                    active
                        .last_reload
                        .error
                        .unwrap_or_else(|| "没有给出原因".to_owned()),
                ));
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(ControlError::Unavailable(
                    "KixDNS 没有及时确认新配置".to_owned(),
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    async fn get_json<T>(&self, path: &str) -> Result<T, ControlError>
    where
        T: serde::de::DeserializeOwned,
    {
        let (_, body) = self.request("GET", path, Vec::new()).await?;
        decode_versioned_json(path, &body)
    }

    async fn post_json<T>(&self, path: &str, body: Vec<u8>) -> Result<T, ControlError>
    where
        T: serde::de::DeserializeOwned,
    {
        self.post_json_within(path, body, REQUEST_TIMEOUT).await
    }

    async fn post_json_within<T>(
        &self,
        path: &str,
        body: Vec<u8>,
        timeout: Duration,
    ) -> Result<T, ControlError>
    where
        T: serde::de::DeserializeOwned,
    {
        let (_, body) = self.request_within("POST", path, body, timeout).await?;
        decode_versioned_json(path, &body)
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Vec<u8>,
    ) -> Result<(u16, Vec<u8>), ControlError> {
        self.request_within(method, path, body, REQUEST_TIMEOUT)
            .await
    }

    #[cfg(unix)]
    async fn request_within(
        &self,
        method: &str,
        path: &str,
        body: Vec<u8>,
        timeout: Duration,
    ) -> Result<(u16, Vec<u8>), ControlError> {
        let mut connection = self.connect().await?;
        let response = send(&mut connection, method, path, body, timeout)
            .await
            .map_err(SendFailure::into_error)?;
        read_reply(response).await
    }

    /// 取查询日志：先用留着的连接，没有才新建。留着的连接可能已经断了（内核重启、空闲太久）：断了就换下一条。这是 GET，
    /// 再问一次不会多删什么；超时这样的真问题不重试。读完了应答的连接才放回去
    /// Taking the query log: a kept connection first, a new one only without any. A kept one may have gone (the kernel
    /// restarted, idle too long), in which case the next is tried. This is a GET, and asking again deletes nothing more;
    /// real trouble such as a timeout is not retried. Only a connection whose reply was read whole goes back
    #[cfg(unix)]
    async fn request_reusing(
        &self,
        path: &str,
        timeout: Duration,
    ) -> Result<(u16, Vec<u8>), ControlError> {
        while let Some(mut connection) = self.take_idle() {
            let alive = tokio::time::timeout(CONNECT_TIMEOUT, connection.ready())
                .await
                .is_ok_and(|ready| ready.is_ok());
            if !alive {
                continue;
            }
            match send(&mut connection, "GET", path, Vec::new(), timeout).await {
                Ok(response) => return self.read_and_keep(connection, response).await,
                Err(SendFailure::Closed(_)) => {}
                Err(failure @ SendFailure::TimedOut) => return Err(failure.into_error()),
            }
        }
        let mut connection = self.connect().await?;
        let response = send(&mut connection, "GET", path, Vec::new(), timeout)
            .await
            .map_err(SendFailure::into_error)?;
        self.read_and_keep(connection, response).await
    }

    #[cfg(unix)]
    fn take_idle(&self) -> Option<Connection> {
        self.idle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pop()
    }

    /// 读完应答；整个读完了（内核回了错误也算）连接就留着 / Reads the reply; the connection is kept once it was read
    /// whole, a kernel's error reply included
    #[cfg(unix)]
    async fn read_and_keep(
        &self,
        connection: Connection,
        response: hyper::Response<hyper::body::Incoming>,
    ) -> Result<(u16, Vec<u8>), ControlError> {
        let reply = read_reply(response).await;
        if matches!(
            reply,
            Ok(_) | Err(ControlError::Rejected(_) | ControlError::Unsupported(_))
        ) {
            let mut idle = self
                .idle
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if idle.len() < IDLE_CONNECTIONS {
                idle.push(connection);
            }
        }
        reply
    }

    #[cfg(unix)]
    async fn connect(&self) -> Result<Connection, ControlError> {
        use hyper::client::conn::http1;
        use hyper_util::rt::TokioIo;
        use tokio::net::UnixStream;

        let stream = tokio::time::timeout(
            CONNECT_TIMEOUT,
            UnixStream::connect(self.socket_path.as_ref()),
        )
        .await
        .map_err(|_| ControlError::Unavailable("连接超时".to_owned()))?
        .map_err(|error| ControlError::Unavailable(error.to_string()))?;
        let (sender, connection) = http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|error| ControlError::Unavailable(error.to_string()))?;
        tokio::spawn(async move {
            if let Err(error) = connection.await {
                tracing::debug!(%error, "KixDNS 控制连接结束");
            }
        });
        Ok(sender)
    }

    #[cfg(not(unix))]
    async fn request_reusing(
        &self,
        path: &str,
        timeout: Duration,
    ) -> Result<(u16, Vec<u8>), ControlError> {
        self.request_within("GET", path, Vec::new(), timeout).await
    }

    #[cfg(not(unix))]
    #[allow(clippy::unused_async)]
    async fn request_within(
        &self,
        _method: &str,
        _path: &str,
        _body: Vec<u8>,
        _timeout: Duration,
    ) -> Result<(u16, Vec<u8>), ControlError> {
        Err(ControlError::Unavailable(
            "当前平台不支持 Unix Socket".to_owned(),
        ))
    }
}

/// 请求没发成：连接断了，或者等应答超时 / A request that did not go through: the connection was gone, or the reply
/// timed out
#[cfg(unix)]
enum SendFailure {
    Closed(String),
    TimedOut,
}

#[cfg(unix)]
impl SendFailure {
    fn into_error(self) -> ControlError {
        match self {
            Self::Closed(message) => ControlError::Unavailable(message),
            Self::TimedOut => ControlError::Unavailable("请求超时".to_owned()),
        }
    }
}

/// 在一条连接上发一个请求，等到应答的头 / Sends a request on a connection and waits for the head of the reply
#[cfg(unix)]
async fn send(
    connection: &mut Connection,
    method: &str,
    path: &str,
    body: Vec<u8>,
    timeout: Duration,
) -> Result<hyper::Response<hyper::body::Incoming>, SendFailure> {
    let request = hyper::Request::builder()
        .method(method)
        .uri(path)
        .header("host", "localhost")
        .header("content-type", "application/json")
        .body(http_body_util::Full::new(bytes::Bytes::from(body)))
        .map_err(|error| SendFailure::Closed(error.to_string()))?;
    tokio::time::timeout(timeout, connection.send_request(request))
        .await
        .map_err(|_| SendFailure::TimedOut)?
        .map_err(|error| SendFailure::Closed(error.to_string()))
}

/// 读完应答；内核回了错误就变成错误 / Reads the whole reply; a kernel's error reply becomes an error
#[cfg(unix)]
async fn read_reply(
    response: hyper::Response<hyper::body::Incoming>,
) -> Result<(u16, Vec<u8>), ControlError> {
    use http_body_util::{BodyExt, Limited};

    let status = response.status();
    let bytes = Limited::new(response.into_body(), MAX_RESPONSE_BYTES)
        .collect()
        .await
        .map_err(|error| {
            if error.is::<http_body_util::LengthLimitError>() {
                ControlError::TooLarge(format!("超过 {} MiB", MAX_RESPONSE_BYTES / 1024 / 1024))
            } else {
                ControlError::Protocol(format!("读取响应失败：{error}"))
            }
        })?
        .to_bytes()
        .to_vec();
    if !status.is_success() {
        let message = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|value| value.pointer("/error/message")?.as_str().map(str::to_owned))
            .unwrap_or_else(|| format!("HTTP {status}"));
        if status == hyper::StatusCode::NOT_FOUND {
            return Err(ControlError::Unsupported(message));
        }
        return Err(ControlError::Rejected(message));
    }
    Ok((status.as_u16(), bytes))
}

/// 普通控制请求的应答时限 / The reply limit for ordinary control requests
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// 诊断与试跑的请求体：客户端 IP 和草稿配置只在有的时候才带上，旧内核收到的还是原来的两个字段。
/// The diagnostic and trial body: the client IP and the draft config ride along only when present, so an older kernel still gets just the two original fields.
fn diagnostic_body(
    domain: &str,
    record_type: &str,
    client_ip: Option<std::net::IpAddr>,
    config: Option<&Value>,
) -> Value {
    let mut body = serde_json::json!({ "domain": domain, "record_type": record_type });
    if let Some(ip) = client_ip {
        body["client_ip"] = Value::String(ip.to_string());
    }
    if let Some(config) = config {
        body["config"] = config.clone();
    }
    body
}

fn decode_versioned_json<T>(path: &str, body: &[u8]) -> Result<T, ControlError>
where
    T: serde::de::DeserializeOwned,
{
    let envelope: ProtocolEnvelope = serde_json::from_slice(body)
        .map_err(|error| ControlError::Protocol(format!("解析 {path} 响应失败：{error}")))?;
    if envelope.protocol_version != CONTROL_PROTOCOL_VERSION {
        return Err(unsupported_protocol(path, envelope.protocol_version));
    }
    serde_json::from_slice(body)
        .map_err(|error| ControlError::Protocol(format!("解析 {path} 响应失败：{error}")))
}

fn unsupported_protocol(path: &str, version: u8) -> ControlError {
    ControlError::Protocol(format!(
        "{path} 使用不受支持的控制协议 v{version}，面板仅支持 v{CONTROL_PROTOCOL_VERSION}"
    ))
}

fn parse_metrics(text: &str) -> Result<MetricsSnapshot, ControlError> {
    let scrape = Scrape::parse(text.lines().map(|line| Ok(line.to_owned())))
        .map_err(|error| ControlError::Protocol(format!("解析 Prometheus 指标失败：{error}")))?;
    let mut builder = MetricsBuilder::default();
    for sample in scrape.samples {
        builder.record(&sample);
    }
    builder.finish()
}

#[derive(Default)]
struct MetricsBuilder {
    snapshot: MetricsSnapshot,
    pipelines: BTreeMap<String, u64>,
    rules: BTreeMap<(String, String, String), u64>,
    upstreams: BTreeMap<(String, String), UpstreamCount>,
    upstream_latency: BTreeMap<(String, String), (f64, u64)>,
    upstream_response_latency: BTreeMap<(String, String), (f64, u64)>,
    upstream_rcodes: BTreeMap<(String, String), u64>,
    request_latency_sum_ms: f64,
    seen: BTreeSet<&'static str>,
}

impl MetricsBuilder {
    /// 上游耗时的累计值与次数：`kixdns_upstream_response_latency_ms_*` 只算拿到响应的
    /// 尝试，`kixdns_upstream_latency_ms_*` 含超时。
    /// The latency sum and count for an upstream: the response series counts replies
    /// only, the plain series includes timeouts.
    fn upstream_latency_entry(&mut self, sample: &Sample) -> Option<&mut (f64, u64)> {
        let key = (
            sample.labels.get("upstream")?.to_owned(),
            sample.labels.get("transport")?.to_owned(),
        );
        let map = if sample
            .metric
            .starts_with("kixdns_upstream_response_latency_ms")
        {
            &mut self.upstream_response_latency
        } else {
            &mut self.upstream_latency
        };
        Some(map.entry(key).or_default())
    }

    fn record(&mut self, sample: &Sample) {
        if let Some(value) = float_value(&sample.value) {
            match sample.metric.as_str() {
                "kixdns_request_latency_ms_sum" => {
                    self.request_latency_sum_ms = value;
                    return;
                }
                "kixdns_upstream_latency_ms_sum" | "kixdns_upstream_response_latency_ms_sum" => {
                    if let Some(entry) = self.upstream_latency_entry(sample) {
                        entry.0 = value;
                    }
                    return;
                }
                _ => {}
            }
        }
        let Some(value) = numeric_value(&sample.value) else {
            return;
        };
        if self.record_scalar(&sample.metric, value) || self.record_extended(sample, value) {
            return;
        }
        match sample.metric.as_str() {
            "kixdns_cache_hits_total" => match sample.labels.get("kind") {
                Some("fresh") => {
                    self.snapshot.cache_hits_fresh = value;
                    self.seen.insert("kixdns_cache_hits_total{kind=fresh}");
                }
                Some("stale") => {
                    self.snapshot.cache_hits_stale = value;
                    self.seen.insert("kixdns_cache_hits_total{kind=stale}");
                }
                _ => {}
            },
            "kixdns_config_reload_total" => match sample.labels.get("result") {
                Some("success") => {
                    self.snapshot.reload_success = value;
                    self.seen
                        .insert("kixdns_config_reload_total{result=success}");
                }
                Some("failure") => {
                    self.snapshot.reload_failure = value;
                    self.seen
                        .insert("kixdns_config_reload_total{result=failure}");
                }
                _ => {}
            },
            "kixdns_pipeline_hits_total" => {
                if let Some(name) = sample.labels.get("pipeline") {
                    self.pipelines.insert(name.to_owned(), value);
                }
            }
            "kixdns_rule_matches_total" => {
                if let (Some(pipeline), Some(rule), Some(phase)) = (
                    sample.labels.get("pipeline"),
                    sample.labels.get("rule"),
                    sample.labels.get("phase"),
                ) {
                    self.rules.insert(
                        (pipeline.to_owned(), rule.to_owned(), phase.to_owned()),
                        value,
                    );
                }
            }
            "kixdns_upstream_attempts_total" | "kixdns_upstream_results_total" => {
                if let (Some(upstream), Some(transport)) = (
                    sample.labels.get("upstream"),
                    sample.labels.get("transport"),
                ) {
                    let entry = self
                        .upstreams
                        .entry((upstream.to_owned(), transport.to_owned()))
                        .or_insert_with(|| UpstreamCount {
                            upstream: upstream.to_owned(),
                            transport: transport.to_owned(),
                            ..UpstreamCount::default()
                        });
                    if sample.metric == "kixdns_upstream_attempts_total" {
                        entry.attempts = value;
                    } else {
                        match sample.labels.get("result") {
                            Some("success") => entry.success = value,
                            Some("error") => entry.errors = value,
                            Some("rejected") => entry.rejected = value,
                            Some("aborted") => entry.aborted = value,
                            Some("throttled") => entry.throttled = value,
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }

    /// 增强版 p20 起新增的序列；旧版本没有这些行时保持默认值。
    fn record_extended(&mut self, sample: &Sample, value: u64) -> bool {
        match sample.metric.as_str() {
            "kixdns_cache_stale_total" => match sample.labels.get("reason") {
                Some("expired") => self.snapshot.cache_stale.expired = value,
                Some("client_timeout") => self.snapshot.cache_stale.client_timeout = value,
                Some("upstream_failure") => self.snapshot.cache_stale.upstream_failure = value,
                _ => {}
            },
            "kixdns_requests_finished_total" => match sample.labels.get("status") {
                Some("completed") => self.snapshot.requests_finished.completed = value,
                Some("failed") => self.snapshot.requests_finished.failed = value,
                Some("cancelled") => self.snapshot.requests_finished.cancelled = value,
                _ => {}
            },
            "kixdns_request_latency_ms_bucket" => {
                let latency = &mut self.snapshot.request_latency;
                match sample.labels.get("le") {
                    Some("10") => latency.within_10ms = value,
                    Some("100") => latency.within_100ms = value,
                    Some("1000") => latency.within_1s = value,
                    _ => {}
                }
            }
            "kixdns_request_latency_ms_count" => {
                self.snapshot.request_latency.samples = value;
            }
            "kixdns_upstream_latency_ms_count" | "kixdns_upstream_response_latency_ms_count" => {
                if let Some(entry) = self.upstream_latency_entry(sample) {
                    entry.1 = value;
                }
            }
            "kixdns_upstream_rcodes_total" => {
                if let (Some(upstream), Some(rcode)) =
                    (sample.labels.get("upstream"), sample.labels.get("rcode"))
                {
                    self.upstream_rcodes
                        .insert((upstream.to_owned(), rcode.to_owned()), value);
                }
            }
            "kixdns_upstream_via_total" => {
                if let (Some(upstream), Some("udp"), Some("tcp")) = (
                    sample.labels.get("upstream"),
                    sample.labels.get("transport"),
                    sample.labels.get("via"),
                ) {
                    self.upstreams
                        .entry((upstream.to_owned(), "udp".to_owned()))
                        .or_insert_with(|| UpstreamCount {
                            upstream: upstream.to_owned(),
                            transport: "udp".to_owned(),
                            ..UpstreamCount::default()
                        })
                        .tcp_fallbacks = value;
                }
            }
            _ => return false,
        }
        true
    }

    fn record_scalar(&mut self, metric: &str, value: u64) -> bool {
        let (target, key) = match metric {
            "kixdns_requests_total" => (&mut self.snapshot.requests_total, "kixdns_requests_total"),
            "kixdns_requests_inflight" => (
                &mut self.snapshot.requests_inflight,
                "kixdns_requests_inflight",
            ),
            "kixdns_cache_lookups_total" => (
                &mut self.snapshot.cache_lookups_total,
                "kixdns_cache_lookups_total",
            ),
            "kixdns_cache_entries" => (&mut self.snapshot.cache_entries, "kixdns_cache_entries"),
            "kixdns_config_generation" => (
                &mut self.snapshot.config_generation,
                "kixdns_config_generation",
            ),
            _ => return false,
        };
        *target = value;
        self.seen.insert(key);
        true
    }

    fn finish(mut self) -> Result<MetricsSnapshot, ControlError> {
        const REQUIRED: [&str; 9] = [
            "kixdns_requests_total",
            "kixdns_requests_inflight",
            "kixdns_cache_lookups_total",
            "kixdns_cache_hits_total{kind=fresh}",
            "kixdns_cache_hits_total{kind=stale}",
            "kixdns_cache_entries",
            "kixdns_config_generation",
            "kixdns_config_reload_total{result=success}",
            "kixdns_config_reload_total{result=failure}",
        ];
        let missing = REQUIRED
            .into_iter()
            .filter(|name| !self.seen.contains(name))
            .collect::<Vec<_>>();
        if missing.is_empty() {
            self.snapshot.pipelines = self
                .pipelines
                .into_iter()
                .map(|(name, count)| NamedCount { name, count })
                .collect();
            self.snapshot.rules = self
                .rules
                .into_iter()
                .map(|((pipeline, rule, phase), count)| RuleCount {
                    pipeline,
                    rule,
                    phase,
                    count,
                })
                .collect();
            if let Some(avg) = average(
                self.request_latency_sum_ms,
                self.snapshot.request_latency.samples,
            ) {
                self.snapshot.request_latency.avg_ms = avg;
            }
            self.snapshot.request_latency.sum_ms = self.request_latency_sum_ms;
            let upstream_latency = self.upstream_latency;
            let upstream_response_latency = self.upstream_response_latency;
            let upstream_rcodes = self.upstream_rcodes;
            self.snapshot.upstreams = self
                .upstreams
                .into_values()
                .map(|mut upstream| {
                    let key = (upstream.upstream.clone(), upstream.transport.clone());
                    // 增强版 p25 起有只算拿到响应的耗时，超时不再把平均耗时拉高；
                    // 更早的版本只能用含超时的已结算耗时。
                    // From enhanced p25 there is a latency over replies only, so timeouts no
                    // longer inflate the average; older builds only have the settled one.
                    if let Some((sum, count)) = upstream_response_latency
                        .get(&key)
                        .or_else(|| upstream_latency.get(&key))
                    {
                        upstream.latency_sum_ms = *sum;
                        upstream.latency_samples = *count;
                        upstream.avg_latency_ms = average(*sum, *count);
                    }
                    let mut rcodes = upstream_rcodes
                        .iter()
                        .filter(|((name, _), _)| *name == upstream.upstream)
                        .map(|((_, rcode), count)| NamedCount {
                            name: rcode.clone(),
                            count: *count,
                        })
                        .collect::<Vec<_>>();
                    rcodes.sort_by(|left, right| {
                        right
                            .count
                            .cmp(&left.count)
                            .then_with(|| left.name.cmp(&right.name))
                    });
                    upstream.rcodes = rcodes;
                    upstream
                })
                .collect();
            Ok(self.snapshot)
        } else {
            Err(ControlError::Protocol(format!(
                "指标响应缺少必需序列：{}",
                missing.join("、")
            )))
        }
    }
}

/// 计数远小于 2^52，转换不会损失精度。/ Counts stay far below 2^52, so the cast is exact.
#[allow(clippy::cast_precision_loss)]
fn average(sum_ms: f64, count: u64) -> Option<f64> {
    (count > 0).then(|| sum_ms / count as f64)
}

fn float_value(value: &MetricValue) -> Option<f64> {
    match value {
        MetricValue::Counter(value) | MetricValue::Gauge(value) | MetricValue::Untyped(value)
            if value.is_finite() && *value >= 0.0 =>
        {
            Some(*value)
        }
        _ => None,
    }
}

fn numeric_value(value: &MetricValue) -> Option<u64> {
    let value = match value {
        MetricValue::Counter(value) | MetricValue::Gauge(value) | MetricValue::Untyped(value) => {
            *value
        }
        MetricValue::Histogram(_) | MetricValue::Summary(_) => return None,
    };
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 {
        format!("{value:.0}").parse().ok()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::ControlClient;
    #[cfg(unix)]
    use std::sync::Arc;

    use std::time::Duration;

    use super::{
        ControlError, DiagnosticTrace, Health, QueryLogEntries, QueryLogPage, QueryLogWait,
        QueryStatsSnapshot, REQUEST_TIMEOUT, decode_versioned_json, parse_metrics,
        querylog_request,
    };

    /// 内核那样的一页（`entries` 在最后）只读前面那几项，记录原文留着；别的样子整页解析；读不了时原文交回
    /// A page as the kernel writes it (`entries` last) is read only up to the records, whose text is kept; any other
    /// shape is parsed whole; a page that cannot be read hands its text back
    #[test]
    fn a_query_log_page_leaves_its_records_to_be_read_once() {
        let kernel = br#"{"protocol_version":1,"instance":7,"capacity":16384,"newest_seq":9,"missed":2,"untracked":3,"more":true,"entries":[{"seq":8},{"seq":9}]}"#;
        let page = QueryLogPage::parse(kernel.to_vec()).unwrap();
        assert_eq!(
            (
                page.instance,
                page.newest_seq,
                page.missed,
                page.untracked,
                page.more
            ),
            (7, 9, 2, 3, true)
        );
        let QueryLogEntries::Text { page: text, at } = &page.entries else {
            panic!("the records are left as text");
        };
        assert_eq!(&text[*at..], r#"{"seq":8},{"seq":9}]}"#);
        let raw: Vec<String> = page
            .entries
            .into_raw()
            .unwrap()
            .into_iter()
            .map(|entry| entry.get().to_owned())
            .collect();
        assert_eq!(raw, [r#"{"seq":8}"#, r#"{"seq":9}"#]);

        let reordered = br#"{"entries":[{"seq":1}],"protocol_version":1,"instance":7,"newest_seq":1,"missed":0,"more":false}"#;
        let page = QueryLogPage::parse(reordered.to_vec()).unwrap();
        assert!(matches!(&page.entries, QueryLogEntries::Raw(entries) if entries.len() == 1));
        assert_eq!(page.untracked, 0, "an older kernel without the count");

        let odd_head = br#"{"protocol_version":1,"instance":"7","newest_seq":1,"missed":0,"more":false,"entries":[]}"#;
        assert!(QueryLogPage::parse(odd_head.to_vec()).is_err());

        let newer = br#"{"protocol_version":2,"rows":[]}"#;
        let (_, body) = QueryLogPage::parse(newer.to_vec()).unwrap_err();
        assert_eq!(body, newer, "the text comes back for the version check");
    }

    /// 小服务器答够了以后怎么办 / What the small server does once it has answered enough
    #[cfg(unix)]
    #[derive(Clone, Copy)]
    enum Then {
        /// 马上关 / Closes at once
        Close,
        /// 不关，也再不答 / Stays open and never answers again
        Silent,
        /// 等到下一个请求，什么也不回就关 / Waits for the next request and closes without answering it
        CloseOnRequest,
    }

    /// 一个数连接的小服务器：每条连接答 `answers` 个请求，然后照 `then` 办；每个请求回一页空的查询日志。数的是接受了几条连接
    /// A small server counting connections: each answers `answers` requests and then does as `then` says; every
    /// request gets an empty query log page. The count is of the connections accepted
    #[cfg(unix)]
    fn counting_server(
        path: std::path::PathBuf,
        answers: usize,
        then: Then,
    ) -> Arc<std::sync::atomic::AtomicUsize> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&accepted);
        let listener = tokio::net::UnixListener::bind(path).unwrap();
        tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::spawn(async move {
                    let body = r#"{"protocol_version":1,"instance":7,"newest_seq":0,"missed":0,"more":false,"entries":[]}"#;
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{body}",
                        body.len()
                    );
                    let mut request = Vec::new();
                    for answer in 0.. {
                        if answer == answers {
                            match then {
                                Then::Close => return,
                                Then::Silent => std::future::pending::<()>().await,
                                Then::CloseOnRequest => {
                                    let mut chunk = [0; 1024];
                                    let _ = stream.read(&mut chunk).await;
                                    return;
                                }
                            }
                        }
                        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                            let mut chunk = [0; 1024];
                            match stream.read(&mut chunk).await {
                                Ok(0) | Err(_) => return,
                                Ok(read) => request.extend_from_slice(&chunk[..read]),
                            }
                        }
                        request.clear();
                        if stream.write_all(reply.as_bytes()).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        accepted
    }

    /// 一页接一页地取，用的是同一条连接 / Page after page uses one connection
    #[cfg(unix)]
    #[tokio::test]
    async fn query_log_takes_share_a_connection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("control.sock");
        let accepted = counting_server(path.clone(), usize::MAX, Then::Close);
        let client = ControlClient::new(path);
        for _ in 0..5 {
            client.querylog(0, 10, None).await.unwrap();
        }
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// 同时取几页时各用各的连接，取完都留着接着用 / Pages taken at once use a connection each, all kept afterwards
    #[cfg(unix)]
    #[tokio::test]
    async fn query_log_takes_at_once_use_a_connection_each_and_keep_them() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("control.sock");
        let accepted = counting_server(path.clone(), usize::MAX, Then::Close);
        let client = ControlClient::new(path);
        for _ in 0..3 {
            let (first, second, third) = tokio::join!(
                client.querylog(0, 10, None),
                client.querylog(0, 10, None),
                client.querylog(0, 10, None)
            );
            first.unwrap();
            second.unwrap();
            third.unwrap();
        }
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    /// 留着的连接断了（内核重启、空闲太久）：换一条新的，调用的人看不出来
    /// A kept connection that has gone (the kernel restarted, idle too long) is replaced, unnoticed by the caller
    #[cfg(unix)]
    #[tokio::test]
    async fn a_kept_connection_that_has_gone_is_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("control.sock");
        let accepted = counting_server(path.clone(), 1, Then::Close);
        let client = ControlClient::new(path);
        for round in 1..=4 {
            client.querylog(0, 10, None).await.unwrap();
            assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), round);
            tokio::task::yield_now().await;
        }
    }

    /// 连接是发请求的时候才断的（看着还活着，发过去没回就关了）：也换一条新的再问一次，这一页不算失败
    /// A connection that goes only as the request is sent (it looked alive, and closed without answering) is replaced
    /// too and the page asked for again, which does not count as a failure
    #[cfg(unix)]
    #[tokio::test]
    async fn a_connection_gone_while_sending_is_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("control.sock");
        let accepted = counting_server(path.clone(), 1, Then::CloseOnRequest);
        let client = ControlClient::new(path);
        client.querylog(0, 10, None).await.unwrap();
        client.querylog(0, 10, None).await.unwrap();
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    /// 留着的连接有上限：同时取的再多，用完也只留这么多 / Kept connections have a limit: however many pages were taken at
    /// once, only so many stay afterwards
    #[cfg(unix)]
    #[tokio::test]
    async fn only_so_many_connections_are_kept() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("control.sock");
        let _accepted = counting_server(path.clone(), usize::MAX, Then::Close);
        let client = ControlClient::new(path);
        let takes: Vec<_> = (0..20).map(|_| client.querylog(0, 10, None)).collect();
        for take in futures_util::future::join_all(takes).await {
            take.unwrap();
        }
        assert_eq!(
            std::iter::from_fn(|| client.take_idle()).count(),
            super::IDLE_CONNECTIONS
        );
    }

    /// 等应答超时是真问题，不换一条连接再问一遍，那条连接也不留 / A timed-out reply is real trouble: it is not asked again on
    /// another connection, and that connection is not kept
    #[cfg(unix)]
    #[tokio::test]
    async fn a_timeout_is_not_retried_on_another_connection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("control.sock");
        let accepted = counting_server(path.clone(), 1, Then::Silent);
        let client = ControlClient::new(path);
        client.querylog(0, 10, None).await.unwrap();
        let timed_out = client
            .request_reusing("/v1/querylog", Duration::from_millis(50))
            .await;
        assert!(
            matches!(timed_out, Err(ControlError::Unavailable(_))),
            "{timed_out:?}"
        );
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(client.take_idle().is_none());
    }

    /// 普通控制请求照旧每次新建，不占留着的连接 / Ordinary control requests still connect each time and keep nothing
    #[cfg(unix)]
    #[tokio::test]
    async fn only_query_log_takes_keep_their_connection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("control.sock");
        let accepted = counting_server(path.clone(), usize::MAX, Then::Close);
        let client = ControlClient::new(path);
        for _ in 0..2 {
            client
                .request_within("GET", "/v1/whatever", Vec::new(), REQUEST_TIMEOUT)
                .await
                .unwrap();
        }
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert!(client.take_idle().is_none());
    }

    #[test]
    fn a_query_log_take_says_what_the_kernel_may_do() {
        assert_eq!(
            querylog_request(7, 250, None),
            ("/v1/querylog?after=7&limit=250".to_owned(), REQUEST_TIMEOUT)
        );
        let waiting = |instance| QueryLogWait {
            instance,
            stored: None,
            until: None,
            records: false,
            wait: Duration::from_secs(1),
        };
        assert_eq!(
            querylog_request(7, 2_000, Some(waiting(Some(100)))),
            (
                "/v1/querylog?after=7&limit=2000&instance=100&wait_ms=1000".to_owned(),
                REQUEST_TIMEOUT + Duration::from_secs(1)
            )
        );
        assert_eq!(
            querylog_request(0, 2_000, Some(waiting(None))).0,
            "/v1/querylog?after=0&limit=2000&wait_ms=1000"
        );
        assert_eq!(
            querylog_request(
                9,
                500,
                Some(QueryLogWait {
                    stored: Some(4),
                    ..waiting(Some(100))
                })
            )
            .0,
            "/v1/querylog?after=9&limit=500&instance=100&stored=4&wait_ms=1000"
        );
        assert_eq!(
            querylog_request(
                9,
                500,
                Some(QueryLogWait {
                    stored: Some(4),
                    until: Some(509),
                    records: true,
                    wait: Duration::ZERO,
                    ..waiting(Some(100))
                })
            ),
            (
                "/v1/querylog?after=9&limit=500&until=509&instance=100&stored=4&format=records1&wait_ms=0"
                    .to_owned(),
                REQUEST_TIMEOUT
            )
        );
    }

    #[test]
    fn parses_and_groups_panel_metrics() {
        let text = r#"
kixdns_requests_total 42
kixdns_requests_inflight 2
kixdns_cache_lookups_total 20
kixdns_cache_hits_total{kind="fresh"} 8
kixdns_cache_hits_total{kind="stale"} 1
kixdns_cache_entries 7
kixdns_config_generation 3
kixdns_config_reload_total{result="success"} 2
kixdns_config_reload_total{result="failure"} 0
kixdns_pipeline_hits_total{pipeline="default"} 21
kixdns_rule_matches_total{pipeline="default",rule="allow",phase="request"} 13
kixdns_upstream_attempts_total{upstream="1.1.1.1:53",transport="udp"} 9
kixdns_upstream_results_total{upstream="1.1.1.1:53",transport="udp",result="success"} 7
kixdns_upstream_attempts_total{upstream="8.8.8.8:53",transport="udp"} 9
kixdns_upstream_results_total{upstream="8.8.8.8:53",transport="udp",result="aborted"} 8
kixdns_upstream_results_total{upstream="8.8.8.8:53",transport="udp",result="error"} 1
kixdns_upstream_attempts_total{upstream="dns.example/dns-query",transport="doh"} 5
kixdns_upstream_results_total{upstream="dns.example/dns-query",transport="doh",result="success"} 2
kixdns_upstream_results_total{upstream="dns.example/dns-query",transport="doh",result="throttled"} 3
kixdns_cache_stale_total{reason="expired"} 1
kixdns_cache_stale_total{reason="client_timeout"} 0
kixdns_cache_stale_total{reason="upstream_failure"} 0
kixdns_requests_finished_total{status="completed"} 40
kixdns_requests_finished_total{status="failed"} 1
kixdns_requests_finished_total{status="cancelled"} 1
kixdns_request_latency_ms_bucket{le="10"} 30
kixdns_request_latency_ms_bucket{le="50"} 38
kixdns_request_latency_ms_bucket{le="100"} 40
kixdns_request_latency_ms_bucket{le="500"} 41
kixdns_request_latency_ms_bucket{le="1000"} 42
kixdns_request_latency_ms_bucket{le="+Inf"} 42
kixdns_request_latency_ms_sum 588.000
kixdns_request_latency_ms_count 42
kixdns_upstream_latency_ms_sum{upstream="1.1.1.1:53",transport="udp"} 84.500
kixdns_upstream_latency_ms_count{upstream="1.1.1.1:53",transport="udp"} 7
kixdns_upstream_rcodes_total{upstream="1.1.1.1:53",rcode="NoError"} 6
kixdns_upstream_rcodes_total{upstream="1.1.1.1:53",rcode="NXDomain"} 1
kixdns_upstream_via_total{upstream="1.1.1.1:53",transport="udp",via="udp"} 5
kixdns_upstream_via_total{upstream="1.1.1.1:53",transport="udp",via="tcp"} 2
"#;
        let metrics = parse_metrics(text).unwrap();
        assert_eq!(metrics.requests_total, 42);
        assert_eq!(metrics.cache_hits_fresh, 8);
        assert_eq!(metrics.pipelines[0].count, 21);
        assert_eq!(metrics.rules[0].rule, "allow");
        assert_eq!(metrics.upstreams[0].success, 7);
        assert_eq!(metrics.upstreams[0].aborted, 0);
        assert_eq!(metrics.upstreams[1].upstream, "8.8.8.8:53");
        assert_eq!(metrics.upstreams[1].attempts, 9);
        assert_eq!(metrics.upstreams[1].aborted, 8);
        assert_eq!(metrics.upstreams[1].errors, 1);
        assert_eq!(metrics.upstreams[1].throttled, 0);
        assert_eq!(metrics.upstreams[2].upstream, "dns.example/dns-query");
        assert_eq!(
            (
                metrics.upstreams[2].success,
                metrics.upstreams[2].errors,
                metrics.upstreams[2].throttled
            ),
            (2, 0, 3)
        );
        assert_eq!(metrics.cache_stale.expired, 1);
        assert_eq!(metrics.requests_finished.completed, 40);
        assert_eq!(metrics.requests_finished.cancelled, 1);
        assert_eq!(metrics.request_latency.samples, 42);
        assert_eq!(metrics.request_latency.within_10ms, 30);
        assert_eq!(metrics.request_latency.within_100ms, 40);
        assert_eq!(metrics.request_latency.within_1s, 42);
        assert!((metrics.request_latency.avg_ms - 14.0).abs() < 1e-9);
        assert!((metrics.request_latency.sum_ms - 588.0).abs() < 1e-9);
        let first = &metrics.upstreams[0];
        assert!((first.avg_latency_ms.unwrap() - 84.5 / 7.0).abs() < 1e-9);
        assert_eq!(first.tcp_fallbacks, 2);
        assert_eq!(first.rcodes[0].name, "NoError");
        assert_eq!(first.rcodes[0].count, 6);
        assert_eq!(first.rcodes[1].name, "NXDomain");
        assert!(metrics.upstreams[1].avg_latency_ms.is_none());
        assert!(metrics.upstreams[1].rcodes.is_empty());
    }

    #[test]
    fn older_enhanced_builds_leave_extended_series_at_defaults() {
        let text = r#"
kixdns_requests_total 42
kixdns_requests_inflight 2
kixdns_cache_lookups_total 20
kixdns_cache_hits_total{kind="fresh"} 8
kixdns_cache_hits_total{kind="stale"} 1
kixdns_cache_entries 7
kixdns_config_generation 3
kixdns_config_reload_total{result="success"} 2
kixdns_config_reload_total{result="failure"} 0
kixdns_upstream_attempts_total{upstream="1.1.1.1:53",transport="udp"} 9
kixdns_upstream_results_total{upstream="1.1.1.1:53",transport="udp",result="success"} 7
"#;
        let metrics = parse_metrics(text).unwrap();
        assert_eq!(metrics.request_latency.samples, 0);
        assert!(metrics.request_latency.avg_ms.abs() < f64::EPSILON);
        assert_eq!(metrics.requests_finished.completed, 0);
        assert_eq!(metrics.cache_stale.expired, 0);
        assert!(metrics.upstreams[0].avg_latency_ms.is_none());
        assert_eq!(metrics.upstreams[0].tcp_fallbacks, 0);
    }

    #[test]
    fn average_latency_counts_only_replies_when_the_kernel_reports_them() {
        let text = r#"
kixdns_requests_total 42
kixdns_requests_inflight 2
kixdns_cache_lookups_total 20
kixdns_cache_hits_total{kind="fresh"} 8
kixdns_cache_hits_total{kind="stale"} 1
kixdns_cache_entries 7
kixdns_config_generation 3
kixdns_config_reload_total{result="success"} 2
kixdns_config_reload_total{result="failure"} 0
kixdns_upstream_attempts_total{upstream="1.1.1.1:53",transport="udp"} 3
kixdns_upstream_results_total{upstream="1.1.1.1:53",transport="udp",result="success"} 2
kixdns_upstream_results_total{upstream="1.1.1.1:53",transport="udp",result="error"} 1
kixdns_upstream_attempts_total{upstream="8.8.8.8:53",transport="udp"} 2
kixdns_upstream_results_total{upstream="8.8.8.8:53",transport="udp",result="success"} 2
kixdns_upstream_latency_ms_sum{upstream="1.1.1.1:53",transport="udp"} 9040.000
kixdns_upstream_latency_ms_count{upstream="1.1.1.1:53",transport="udp"} 3
kixdns_upstream_response_latency_ms_sum{upstream="1.1.1.1:53",transport="udp"} 40.000
kixdns_upstream_response_latency_ms_count{upstream="1.1.1.1:53",transport="udp"} 2
kixdns_upstream_latency_ms_sum{upstream="8.8.8.8:53",transport="udp"} 60.000
kixdns_upstream_latency_ms_count{upstream="8.8.8.8:53",transport="udp"} 2
"#;
        let metrics = parse_metrics(text).unwrap();
        // p25 起：一次 9 秒超时不再把平均耗时拉到 3 秒。
        // From p25: one 9-second timeout no longer drags the average up to 3 seconds.
        let replied = &metrics.upstreams[0];
        assert!((replied.avg_latency_ms.unwrap() - 20.0).abs() < 1e-9);
        assert!((replied.latency_sum_ms - 40.0).abs() < 1e-9);
        assert_eq!(replied.latency_samples, 2);
        // 旧内核没有这个序列，退回含超时的已结算耗时。
        // Older kernels lack the series and fall back to the settled latency.
        let legacy = &metrics.upstreams[1];
        assert!((legacy.avg_latency_ms.unwrap() - 30.0).abs() < 1e-9);
        assert_eq!(legacy.latency_samples, 2);
        assert!(metrics.recent_window_seconds.is_none());
        assert!(metrics.request_latency_recent.is_none());
        assert!(replied.recent.is_none());
    }

    /// 旧版面板存下的概览快照里，最近一段的计数没有 throttled：照样读得出来，按 0 算
    /// An overview snapshot saved by an older panel has no throttled in its recent counts: it still reads, as 0
    #[test]
    fn reads_a_recent_tally_saved_without_throttled() {
        let tally: super::UpstreamTally = serde_json::from_str(
            r#"{"attempts":12,"success":9,"errors":1,"rejected":0,"aborted":2,"tcp_fallbacks":0,"avg_latency_ms":4.5}"#,
        )
        .expect("an older snapshot's tally reads");
        assert_eq!((tally.attempts, tally.aborted, tally.throttled), (12, 2, 0));
    }

    #[test]
    fn rejects_incomplete_metrics_and_unknown_protocol_versions() {
        assert!(matches!(
            parse_metrics("kixdns_requests_total 1\n"),
            Err(ControlError::Protocol(_))
        ));

        let response = br#"{"protocol_version":2}"#;
        let decoded = decode_versioned_json::<Health>("/v1/health", response);
        assert!(matches!(decoded, Err(ControlError::Protocol(_))));
    }

    #[test]
    fn decodes_query_rankings_and_defaults_old_capabilities() {
        let response = br#"{
            "protocol_version":1,
            "enabled":true,
            "anonymized_clients":true,
            "window_seconds":86400,
            "retention_seconds":86400,
            "generated_at_unix":100,
            "requests_observed":42,
            "dropped_updates":2,
            "clients":[{"name":"192.168.1.0/24","count":20}],
            "domains":[{"name":"example.com","count":12}]
        }"#;
        let stats = decode_versioned_json::<QueryStatsSnapshot>("/v1/stats/top", response).unwrap();
        assert_eq!(stats.requests_observed, 42);
        assert_eq!(stats.clients[0].name, "192.168.1.0/24");
        assert_eq!(stats.domains[0].count, 12);

        let old_health = br#"{
            "protocol_version":1,"status":"ok","pid":1,"version":"0.1.0",
            "upstream_commit":"abc","patchset":"5","started_at_unix":1,
            "uptime_seconds":2,"config_generation":3
        }"#;
        let health = decode_versioned_json::<Health>("/v1/health", old_health).unwrap();
        assert!(health.capabilities.is_empty());
        assert_eq!(health.release_version, None);

        // fork 发布的内核没有补丁集，另报日期版本和这一版的提交。
        // A fork release has no patchset and reports its date version and commit instead.
        let release_health = br#"{
            "protocol_version":1,"status":"ok","pid":1,"version":"0.1.0",
            "release_version":"2026.10.13.2",
            "release_commit":"527ae0a023c81094d80c949d844dbc7d1da85b32",
            "upstream_commit":"42981abe52ce53271be50b430594e02601e8b615",
            "patchset":"unknown","started_at_unix":1,"uptime_seconds":2,
            "config_generation":3,"capabilities":["stats_top_v1"]
        }"#;
        let health = decode_versioned_json::<Health>("/v1/health", release_health).unwrap();
        assert_eq!(health.release_version.as_deref(), Some("2026.10.13.2"));
        let browser = serde_json::to_value(&health).unwrap();
        assert_eq!(browser["release_version"], "2026.10.13.2");
        assert_eq!(
            browser["release_commit"],
            "527ae0a023c81094d80c949d844dbc7d1da85b32"
        );
    }

    #[test]
    fn decodes_diagnostic_execution_trace() {
        let response = r#"{
            "protocol_version":1,
            "domain":"example.com",
            "record_type":"A",
            "response_code":"No Error",
            "elapsed_ms":12,
            "truncated":false,
            "answers":[],
            "trace_truncated":false,
            "trace":[{
                "stage":"rule",
                "status":"matched",
                "label":"geosite-global",
                "detail":"管线：default",
                "elapsed_ms":1
            }]
        }"#;
        let trace =
            decode_versioned_json::<DiagnosticTrace>("/v1/diagnostics/trace", response.as_bytes())
                .unwrap();
        assert_eq!(trace.domain, "example.com");
        assert_eq!(trace.trace[0].status, "matched");
        assert!(!trace.trace_truncated);
        // p28 之前的内核不返回这两个字段 / Kernels before p28 omit these two
        assert_eq!(trace.client_ip, None);
        assert!(!trace.candidate);
    }

    #[test]
    fn decodes_the_client_ip_and_candidate_flag_from_p28() {
        let response = r#"{"protocol_version":1,"domain":"a.example","record_type":"A","client_ip":"192.168.1.9","candidate":true,
            "response_code":"No Error","elapsed_ms":3,"truncated":false,"answers":[],"trace_truncated":false,"trace":[]}"#;
        let trace = decode_versioned_json::<DiagnosticTrace>(
            "/v1/diagnostics/trace-candidate",
            response.as_bytes(),
        )
        .unwrap();
        assert_eq!(trace.client_ip.as_deref(), Some("192.168.1.9"));
        assert!(trace.candidate);
    }

    #[test]
    fn diagnostic_body_adds_the_client_ip_and_config_only_when_present() {
        let plain = super::diagnostic_body("a.example", "A", None, None);
        assert_eq!(
            plain,
            serde_json::json!({ "domain": "a.example", "record_type": "A" })
        );
        let config = serde_json::json!({ "pipelines": [] });
        let full = super::diagnostic_body(
            "a.example",
            "AAAA",
            Some("fd00::9".parse().unwrap()),
            Some(&config),
        );
        assert_eq!(
            full,
            serde_json::json!({ "domain": "a.example", "record_type": "AAAA", "client_ip": "fd00::9", "config": { "pipelines": [] } })
        );
    }
}
