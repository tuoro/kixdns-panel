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

#[derive(Debug, Deserialize)]
struct ProtocolEnvelope {
    protocol_version: u8,
}

#[derive(Debug, Clone, Default, Serialize)]
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
}

#[derive(Debug, Clone, Serialize)]
pub struct NamedCount {
    pub name: String,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuleCount {
    pub pipeline: String,
    pub rule: String,
    pub phase: String,
    pub count: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct UpstreamCount {
    pub upstream: String,
    pub transport: String,
    pub attempts: u64,
    pub success: u64,
    pub errors: u64,
    pub rejected: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum ControlError {
    #[error("KixDNS 增强控制接口不可用：{0}")]
    Unavailable(String),
    #[error("KixDNS 增强控制协议错误：{0}")]
    Protocol(String),
    #[error("KixDNS 拒绝操作：{0}")]
    Rejected(String),
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

    pub async fn validate(&self, content: &Value) -> Result<ValidationResult, ControlError> {
        let body = serde_json::to_vec(content)
            .map_err(|error| ControlError::Protocol(format!("序列化候选配置失败：{error}")))?;
        self.post_json("/v1/config/validate", body).await
    }

    pub async fn flush_cache(&self) -> Result<CacheFlushResult, ControlError> {
        self.post_json("/v1/cache/flush", Vec::new()).await
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
    seen: BTreeSet<&'static str>,
}

impl MetricsBuilder {
    fn record(&mut self, sample: &Sample) {
        let Some(value) = numeric_value(&sample.value) else {
            return;
        };
        if self.record_scalar(&sample.metric, value) {
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
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
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
            self.snapshot.upstreams = self.upstreams.into_values().collect();
            Ok(self.snapshot)
        } else {
            Err(ControlError::Protocol(format!(
                "指标响应缺少必需序列：{}",
                missing.join("、")
            )))
        }
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
    use super::{ControlError, Health, decode_versioned_json, parse_metrics};

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
"#;
        let metrics = parse_metrics(text).unwrap();
        assert_eq!(metrics.requests_total, 42);
        assert_eq!(metrics.cache_hits_fresh, 8);
        assert_eq!(metrics.pipelines[0].count, 21);
        assert_eq!(metrics.rules[0].rule, "allow");
        assert_eq!(metrics.upstreams[0].success, 7);
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
}
