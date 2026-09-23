# KixDNS 增强管理协议 v1

## 传输

Linux 默认地址为 `/run/kixdns/admin.sock`。协议使用 Unix Socket 上的 HTTP/1.1，响应体为 UTF-8 JSON；指标端点使用 Prometheus 文本格式。Socket 只允许 Panel Server 所在用户或用户组访问。

所有 JSON 响应都包含 `protocol_version: 1`。未知字段必须被客户端忽略，已有字段在同一协议版本内不得改变语义。

## 端点

### `GET /v1/health`

返回进程状态、上游提交、增强补丁版本、启动时间、当前配置代数和可选能力列表。当前增强版包含 `stats_top_v1`、`config_query_stats_v1` 和 `diagnostics_trace_v1`：分别声明查询排行、统计配置字段和规则执行轨迹。客户端只能在对应能力存在时使用端点或写入受控字段。

`capabilities` 中除配置能力外，还包含面板功能门控：`stats_top_v1`（查询排行）、`diagnostics_trace_v1`（诊断轨迹）、`metrics_upstream_precision_v1`（增强版 p21 起，表示 `/v1/metrics` 提供 `aborted` 结果、上游耗时、响应码、实际传输、请求完成状态与过期缓存原因；面板只有看到它才计算上游健康并用剔除竞争落败的成功率公式，否则健康显示为未知）、`metrics_upstream_response_latency_v1`（增强版 p25 起，表示 `/v1/metrics` 另外提供只算拿到响应的上游耗时，面板用它计算平均耗时）。运行时能力负责当前进程的配置门控。尚未启动的目标版本使用 Artifact 内经 SHA-256 校验的 `KIXDNS_CAPABILITIES.json` 预检，完整规则见[配置能力契约](config-capabilities.md)。

### `GET /v1/config/active`

返回当前已生效配置，而不是磁盘文件状态：

~~~json
{
  "protocol_version": 1,
  "generation": 18,
  "sha256": "4d5b...",
  "loaded_at_unix": 1785215400,
  "reload_sequence": 24,
  "last_reload": {
    "success": true,
    "error": null
  }
}
~~~

Panel Server 保存配置后，只有该端点的 `sha256` 与磁盘配置一致时才报告已生效。
`reload_sequence` 在每次热加载成功或最终失败时递增，客户端必须等待它大于写入前的值，避免把旧回执误判为本次结果。

### `GET /v1/metrics`

第一版固定以下指标：

- `kixdns_requests_total`
- `kixdns_requests_inflight`
- `kixdns_cache_lookups_total`
- `kixdns_cache_hits_total{kind="fresh|stale"}`
- `kixdns_cache_entries`
- `kixdns_pipeline_hits_total{pipeline}`
- `kixdns_rule_matches_total{pipeline,rule,phase}`
- `kixdns_upstream_attempts_total{upstream,transport}`
- `kixdns_upstream_results_total{upstream,transport,result}`
- `kixdns_config_reload_total{result}`

增强版 p20 起追加以下序列；面板服务在缺少它们时把对应字段保持为默认值，不视为协议错误：

- `kixdns_cache_stale_total{reason="expired|client_timeout|upstream_failure"}`：过期缓存命中的原因拆分，三者之和等于 `kixdns_cache_hits_total{kind="stale"}`。
- `kixdns_requests_finished_total{status="completed|failed|cancelled"}`：请求完成状态，不含后台刷新。
- `kixdns_request_latency_ms_bucket{le="10|50|100|500|1000|+Inf"}`、`kixdns_request_latency_ms_sum`、`kixdns_request_latency_ms_count`：端到端耗时直方图与累计值（毫秒，`_sum` 保留三位小数）。
- `kixdns_upstream_latency_ms_sum{upstream,transport}`、`kixdns_upstream_latency_ms_count{upstream,transport}`：已得到结果的上游尝试累计耗时与次数，不含 `aborted`。
- `kixdns_upstream_response_latency_ms_sum{upstream,transport}`、`kixdns_upstream_response_latency_ms_count{upstream,transport}`：只算拿到响应的尝试，即 `success` 与 `rejected`；超时和连接错误的 `error` 不计入，否则一次超时就把整段超时时长加进平均耗时。
- `kixdns_upstream_rcodes_total{upstream,rcode}`：上游应答的响应码计数，`rcode` 为 hickory 的变体名（`NoError`、`NXDomain`、`ServFail`、`Refused` 等）。
- `kixdns_upstream_via_total{upstream,transport,via}`：`transport` 为该地址选定的传输，`via` 为实际带回答案的传输；`transport="udp"` 且 `via="tcp"` 即 TCP 兜底。

标签值必须转义，且只能来自配置中有界的 Pipeline、规则和上游集合。

### `POST /v1/config/validate`

请求体为候选 KixDNS JSON 配置，最大 4 MiB。增强进程使用与热加载完全相同的解析、规范化和运行时编译流程验证配置，但不修改磁盘或活动配置。成功返回 Pipeline 与规则数量；失败返回 `422` 和结构化错误。

### `POST /v1/cache/flush`

清空 DNS 响应缓存和规则缓存，返回本次操作前后的条目数量。

### `GET /v1/stats/top`

返回有界内存中的客户端与请求域名排行。`window` 仅接受 `3600`、`21600`、`86400` 秒，`limit` 接受 1–50；默认返回最近 24 小时 Top 20。响应包含统计开关、客户端脱敏状态、观察请求数、丢弃更新数、保留时间和生成时间。

统计使用 24 个小时桶，窗口边界为小时级估算。每小时最多保留 4096 个域名和 1024 个客户端；容量耗尽或分片竞争时只丢弃统计更新，不阻塞 DNS 请求。数据只保存在内存中，进程重启后清空。

### `POST /v1/stats/clear`

清空全部查询排行，不改变配置中的统计开关。

### `POST /v1/diagnostics/trace`

在当前进程内执行一次真实 DNS 查询并返回结果与有界执行轨迹。请求只接受 `domain` 和固定白名单中的 `record_type`，不能指定服务器；请求体最大 2 KiB，执行最长 6 秒。轨迹覆盖请求解析、Pipeline 选择与跳转、响应/规则缓存、候选规则匹配、最终动作、实际上游和响应阶段匹配。

轨迹最多保留 128 步，超出时设置 `trace_truncated: true`。普通 DNS 请求未进入诊断作用域时不会分配或保存轨迹。该端点会像普通查询一样影响请求指标和缓存；客户端必须先确认 health 含有 `diagnostics_trace_v1`，旧增强版则回退到监听端口上的基础 DNS 查询。

## 查询统计配置

- `settings.statistics_enabled`：是否采集查询排行，默认 `false`。
- `settings.statistics_anonymize_client_ip`：IPv4 按 `/24`、IPv6 按 `/64` 聚合，默认 `false`。

开关或脱敏方式发生变化时，现有排行立即清空，避免不同隐私口径的数据混合。
这两个字段要求 `config_query_stats_v1`；旧增强版运行时返回 `stats_top_v1` 时，面板将其视为当前进程的兼容别名。

## 指标语义

- 缓存命中率为 `fresh + stale` 命中数除以缓存查询数。
- Pipeline 命中表示一次请求选择或跳转进入该 Pipeline。
- 规则命中表示匹配器链结果为真；`phase` 为 `request` 或 `response`。
- 上游 attempt 表示一次已配置的上游操作，result 表示该操作最终结果，而不是规则中的 Forward 动作数。`tcp_udp` 的内部 TCP 回退属于同一次操作。
- `result` 取值为 `success`、`error`、`rejected`、`aborted`，attempt 与 result 一一对应。`aborted` 表示多上游并发竞争中被更快的上游抢先应答而取消的尝试，它既不是成功也不是失败；`rejected` 表示上游回了 SERVFAIL 或 REFUSED、结果被丢弃，上游本身在正常应答，这些响应码已经计入响应码分布。因此面板的上游成功率是 `success / (success + error)`：只有超时和连接错误算失败，竞争落败和被拒绝的应答都不进分母——把 `aborted` 算进去会让同一规则下的上游按应答先后瓜分成功率，把 `rejected` 算进去则会让上游替它解析不了的域名背锅。增强版 p19 之前不上报 `aborted`，落败的尝试没有任何 result。
- 并发数覆盖进入异步处理至响应完成的请求，不包含已在同步快速路径返回的请求。面板首页不再展示并发数，该序列仅保留给外部消费者。
- 上游平均耗时以 `kixdns_upstream_response_latency_ms_sum / _count` 计算，只算拿到响应的尝试；增强版 p25 之前没有这组序列，退回 `kixdns_upstream_latency_ms_sum / _count`，其中含超时时长。
- 以上计数都从 KixDNS 启动起累加。面板每分钟采样一次，存在内存里，概览用当前值减去一小时内最早的采样，得到最近一小时的计数（`/api/v1/overview` 中每个上游的 `recent` 与 `metrics.upstream_window_seconds`）；KixDNS 一小时内重启过时直接用它启动以来的计数。面板重启后前几分钟没有窗口，退回累计值。
- 健康按最近一小时判断；某个上游最近一小时可判断的响应（`success + error`）不足 50 次时退回启动以来的累计，累计也不足 50 次记为观察中。成功率 ≥ 99% 且平均耗时 < 1 s 记为健康，成功率 < 95% 或平均耗时 ≥ 2 s 记为异常，其余为降级。
