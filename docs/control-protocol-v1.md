# KixDNS 增强管理协议 v1

## 传输

Linux 默认地址为 `/run/kixdns/admin.sock`。协议使用 Unix Socket 上的 HTTP/1.1，响应体为 UTF-8 JSON；指标端点使用 Prometheus 文本格式。Socket 只允许 Panel Server 所在用户或用户组访问。

所有 JSON 响应都包含 `protocol_version: 1`。未知字段必须被客户端忽略，已有字段在同一协议版本内不得改变语义。

## 端点

### `GET /v1/health`

返回进程状态、上游提交、增强补丁版本、启动时间和当前配置代数。

### `GET /v1/config/active`

返回当前已生效配置，而不是磁盘文件状态：

~~~json
{
  "protocol_version": 1,
  "generation": 18,
  "sha256": "4d5b...",
  "loaded_at": "2026-07-28T10:30:00Z",
  "last_reload": {
    "success": true,
    "error": null
  }
}
~~~

Panel Server 保存配置后，只有该端点的 `sha256` 与磁盘配置一致时才报告已生效。

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

### `POST /v1/cache/flush`

清空 DNS 响应缓存和规则缓存，返回本次操作前后的条目数量。

## 指标语义

- 缓存命中率为 `fresh + stale` 命中数除以缓存查询数。
- Pipeline 命中表示一次请求选择或跳转进入该 Pipeline。
- 规则命中表示匹配器链结果为真；`phase` 为 `request` 或 `response`。
- 上游 attempt 表示一次实际网络尝试，result 表示该尝试最终结果，而不是规则中的 Forward 动作数。
- 并发数覆盖进入异步处理至响应完成的请求，不包含已在同步快速路径返回的请求。

