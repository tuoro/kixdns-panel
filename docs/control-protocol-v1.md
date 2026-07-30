# KixDNS 增强管理协议 v1

## 传输

Linux 默认地址为 `/run/kixdns/admin.sock`。协议使用 Unix Socket 上的 HTTP/1.1，响应体为 UTF-8 JSON；指标端点使用 Prometheus 文本格式。Socket 只允许 Panel Server 所在用户或用户组访问。

所有 JSON 响应都包含 `protocol_version: 1`。未知字段必须被客户端忽略，已有字段在同一协议版本内不得改变语义。

## 端点

### `GET /v1/health`

返回进程状态、上游提交、增强补丁版本、启动时间、当前配置代数和可选能力列表。当前增强版包含 `capabilities: ["stats_top_v1", "config_query_stats_v1"]`：前者允许调用排行端点，后者表示 KixDNS 会解析查询统计配置字段。客户端只能在对应能力存在时使用端点或写入受控字段。

运行时能力负责当前进程的配置门控。尚未启动的目标版本使用 Artifact 内经 SHA-256 校验的 `KIXDNS_CAPABILITIES.json` 预检，完整规则见[配置能力契约](config-capabilities.md)。

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
- 并发数覆盖进入异步处理至响应完成的请求，不包含已在同步快速路径返回的请求。
