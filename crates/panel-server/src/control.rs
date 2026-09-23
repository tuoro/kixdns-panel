use std::collections::{BTreeMap, BTreeSet};
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Health {
    pub protocol_version: u8,
    pub status: String,
    pub pid: u32,
    pub version: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticTrace {
    pub protocol_version: u8,
    pub domain: String,
    pub record_type: String,
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
    /// 各上游 `recent` 实际覆盖的秒数，最长一小时；还没有可比的采样时为空。
    /// Seconds actually covered by each upstream's `recent`, at most an hour; empty
    /// until there is a sample to compare against.
    #[serde(default)]
    pub upstream_window_seconds: Option<u64>,
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
    /// 100 ms 内返回的请求数，用于"绝大多数请求在 100 ms 内返回"。
    pub within_100ms: u64,
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
    pub tcp_fallbacks: u64,
    pub avg_latency_ms: Option<f64>,
}

const fn default_live() -> bool {
    true
}

#[derive(Debug, thiserror::Error)]
pub enum ControlError {
    #[error("KixDNS 增强控制接口不可用：{0}")]
    Unavailable(String),
    #[error("KixDNS 增强控制协议错误：{0}")]
    Protocol(String),
    #[error("KixDNS 拒绝操作：{0}")]
    Rejected(String),
    #[error("KixDNS 增强能力不可用：{0}")]
    #[cfg_attr(not(unix), allow(dead_code))]
    Unsupported(String),
}

impl ControlClient {
    #[must_use]
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            socket_path: Arc::new(socket_path),
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

    pub async fn diagnostic_trace(
        &self,
        domain: &str,
        record_type: &str,
    ) -> Result<DiagnosticTrace, ControlError> {
        let body = serde_json::to_vec(&serde_json::json!({
            "domain": domain,
            "record_type": record_type,
        }))
        .map_err(|error| ControlError::Protocol(format!("序列化诊断请求失败：{error}")))?;
        self.post_json("/v1/diagnostics/trace", body).await
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
                        .unwrap_or_else(|| "配置热加载失败".to_owned()),
                ));
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(ControlError::Unavailable(
                    "等待配置热加载回执超时".to_owned(),
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
        let (_, body) = self.request("POST", path, body).await?;
        decode_versioned_json(path, &body)
    }

    #[cfg(unix)]
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Vec<u8>,
    ) -> Result<(u16, Vec<u8>), ControlError> {
        use bytes::Bytes;
        use http_body_util::{BodyExt, Full, Limited};
        use hyper::Request;
        use hyper::client::conn::http1;
        use hyper_util::rt::TokioIo;
        use tokio::net::UnixStream;

        let stream = tokio::time::timeout(
            Duration::from_secs(2),
            UnixStream::connect(self.socket_path.as_ref()),
        )
        .await
        .map_err(|_| ControlError::Unavailable("连接超时".to_owned()))?
        .map_err(|error| ControlError::Unavailable(error.to_string()))?;
        let (mut sender, connection) = http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|error| ControlError::Unavailable(error.to_string()))?;
        tokio::spawn(async move {
            if let Err(error) = connection.await {
                tracing::debug!(%error, "KixDNS 控制连接结束");
            }
        });

        let request = Request::builder()
            .method(method)
            .uri(path)
            .header("host", "localhost")
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(body)))
            .map_err(|error| ControlError::Protocol(error.to_string()))?;
        let response = tokio::time::timeout(Duration::from_secs(5), sender.send_request(request))
            .await
            .map_err(|_| ControlError::Unavailable("请求超时".to_owned()))?
            .map_err(|error| ControlError::Unavailable(error.to_string()))?;
        let status = response.status();
        let bytes = Limited::new(response.into_body(), MAX_RESPONSE_BYTES)
            .collect()
            .await
            .map_err(|error| ControlError::Protocol(format!("读取响应失败：{error}")))?
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

    #[cfg(not(unix))]
    #[allow(clippy::unused_async)]
    async fn request(
        &self,
        _method: &str,
        _path: &str,
        _body: Vec<u8>,
    ) -> Result<(u16, Vec<u8>), ControlError> {
        Err(ControlError::Unavailable(
            "当前平台不支持 Unix Socket".to_owned(),
        ))
    }
}

fn decode_versioned_json<T>(path: &str, body: &[u8]) -> Result<T, ControlError>
where
    T: serde::de::DeserializeOwned,
{
    let envelope: ProtocolEnvelope = serde_json::from_slice(body)
        .map_err(|error| ControlError::Protocol(format!("解析 {path} 响应失败：{error}")))?;
    if envelope.protocol_version != CONTROL_PROTOCOL_VERSION {
        return Err(ControlError::Protocol(format!(
            "{path} 使用不受支持的控制协议 v{}，面板仅支持 v{CONTROL_PROTOCOL_VERSION}",
            envelope.protocol_version
        )));
    }
    serde_json::from_slice(body)
        .map_err(|error| ControlError::Protocol(format!("解析 {path} 响应失败：{error}")))
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
                if sample.labels.get("le") == Some("100") {
                    self.snapshot.request_latency.within_100ms = value;
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
    use super::{
        ControlError, DiagnosticTrace, Health, QueryStatsSnapshot, decode_versioned_json,
        parse_metrics,
    };

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
        assert_eq!(metrics.cache_stale.expired, 1);
        assert_eq!(metrics.requests_finished.completed, 40);
        assert_eq!(metrics.requests_finished.cancelled, 1);
        assert_eq!(metrics.request_latency.samples, 42);
        assert_eq!(metrics.request_latency.within_100ms, 40);
        assert!((metrics.request_latency.avg_ms - 14.0).abs() < 1e-9);
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
        assert!(metrics.upstream_window_seconds.is_none());
        assert!(replied.recent.is_none());
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
    }
}
