# KixDNS 增强控制协议 v1

**简体中文** | [English](control-protocol-v1.en.md)

## 传输

Linux 默认地址为 `/run/kixdns/admin.sock`。协议使用 Unix Socket 上的 HTTP/1.1，响应体为 UTF-8 JSON；指标端点使用 Prometheus 文本格式。Socket 只允许 Panel Server 所在用户或用户组访问。

所有 JSON 响应都包含 `protocol_version: 1`。未知字段必须被客户端忽略，已有字段在同一协议版本内不得改变语义。

## 端点

### `GET /v1/health`

返回进程状态、上游提交、发布版本（`release_version`、`release_commit`，只有 fork 发布的内核才有，其余为 `null`）、补丁集（旧的补丁集内核才有，fork 内核报 `unknown`）、启动时间、当前配置代数和能力列表 `capabilities`。客户端只能在对应能力存在时使用端点或写入受控字段。fork 发布的内核声明下面列的全部能力，p28 没有 `querylog_` 开头的那些：

- 配置能力：`config_query_stats_v1`（查询统计配置字段，见下文）、`config_static_cname_response_v1`（`static_cname_response` 动作，即固定 CNAME 应答，面板的域名映射用它）
- `stats_top_v1`：查询排行端点
- `diagnostics_trace_v1`：诊断轨迹端点
- `diagnostics_trace_client_v1`：增强版 p28 起，诊断轨迹和草稿试跑接受 `client_ip`，假装查询来自这个客户端
- `diagnostics_trace_candidate_v1`：增强版 p28 起，草稿试跑端点 `POST /v1/diagnostics/trace-candidate`
- `metrics_upstream_precision_v1`：增强版 p21 起，`/v1/metrics` 提供 `aborted` 结果、上游耗时、响应码、实际传输、请求完成状态与过期缓存原因。面板只有看到它才计算上游健康并用剔除竞争落败的成功率公式，否则健康显示为未知
- `metrics_upstream_response_latency_v1`：增强版 p25 起，`/v1/metrics` 另外提供只算拿到响应的上游耗时，面板用它计算平均耗时
- `querylog_v1`：fork 内核 2026.10.14 起，查询日志端点 `GET /v1/querylog`
- `querylog_wait_v1`：fork 内核 2026.11.02.9 起，取查询日志时可以带 `instance` 和 `wait_ms`（见下文）
- `querylog_stored_v1`：fork 内核 2026.11.02.11 起，取查询日志时可以带 `stored`，内核只删面板说存好了的；几个等着的请求各自会被叫醒（见下文）
- `querylog_until_v1`：fork 内核 2026.11.02.12 起，取查询日志时可以带 `until`，只交到这个序号为止（见下文）
- `querylog_records_v1`：fork 内核 2026.11.03.4 起，取查询日志时可以带 `format=records1`，把编好的记录原样交出来（见下文）

运行时能力负责当前进程的配置门控。尚未启动的目标版本使用内核包内经 SHA-256 校验的 `KIXDNS_CAPABILITIES.json` 预检，完整规则见[配置能力契约](config-capabilities.md)。

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
- `kixdns_upstream_latency_ms_sum{upstream,transport}`、`kixdns_upstream_latency_ms_count{upstream,transport}`：已得到结果的上游尝试累计耗时与次数，不含 `aborted` 和 `throttled`。
- `kixdns_upstream_response_latency_ms_sum{upstream,transport}`、`kixdns_upstream_response_latency_ms_count{upstream,transport}`：只算拿到响应的尝试，即 `success` 与 `rejected`；超时和连接错误的 `error` 不计入，否则一次超时就把整段超时时长加进平均耗时。
- `kixdns_upstream_rcodes_total{upstream,rcode}`：上游应答的响应码计数，`rcode` 为 hickory 的变体名（`NoError`、`NXDomain`、`ServFail`、`Refused` 等）。
- `kixdns_upstream_via_total{upstream,transport,via}`：`transport` 为该地址选定的传输，`via` 为实际带回答案的传输；`transport="udp"` 且 `via="tcp"` 即 TCP 兜底。

标签值必须转义，且只能来自配置中有界的 Pipeline、规则和上游集合。

### `POST /v1/config/validate`

请求体为候选 KixDNS JSON 配置，最大 4 MiB。增强进程使用与热加载完全相同的解析、规范化和运行时编译流程验证配置，但不修改磁盘或活动配置。成功返回 Pipeline 与规则数量；失败返回 `422` 和结构化错误。

### `POST /v1/cache/flush`

清空 DNS 响应缓存和规则缓存，返回本次操作前后的条目数量。

### `GET /v1/stats/top`

返回有界内存中的客户端与请求域名排行。`window` 仅接受 `3600`、`21600`、`86400` 秒，`limit` 接受 1–50；默认返回最近 24 小时 Top 20。响应包含 `enabled`、`anonymized_clients`、观察请求数、丢弃更新数、保留时间和生成时间。新内核一直统计、记完整的客户端地址，这两个字段恒为 `true` 和 `false`；旧内核按配置里的统计开关和脱敏设置填写（见下文）。

统计使用 24 个小时桶，窗口边界为小时级估算。每小时最多保留 4096 个域名和 1024 个客户端；容量耗尽或分片竞争时只丢弃统计更新，不阻塞 DNS 请求。数据只保存在内存中，进程重启后清空。

### `POST /v1/stats/clear`

清空全部查询排行。

### `GET /v1/querylog`

需要 `querylog_v1`。内核把查询记在内存里的交接区，面板按游标取走，写进自己的查询日志。交接区声明 `querylog_wait_v1` 的内核是 16384 条，之前是 4096 条，满了丢最旧的。

**参数**

- `after`：面板已经取到的最后一条 `seq`，第一次取时为 0；
- `limit`：1–2000，默认 2000；
- `until`（需要 `querylog_until_v1`）：只交 `seq` 不超过它的记录。`after` 之后被挤掉了一截时，这一页也不越界交出 `until` 之后的记录，`missed` 只算到 `until` 为止。面板同时取相邻的几段时，各段因此互不重叠；
- `instance`（需要 `querylog_wait_v1`）：游标所属的内核进程，就是取到游标那一页应答里的 `instance`。
  - 是这个内核进程的：面板已经把 `after` 及以前的记录存好了，内核把它们从交接区删掉。
  - 是别的进程的：一条不删，也不等，马上回。
  - 不带：一条不删。
  - 面板拿一个远大于 `newest_seq` 的 `after` 探问是哪个进程时，不能带它；
- `stored`（需要 `querylog_stored_v1`，和 `instance` 一起才起作用）：面板已经存好到哪一条。带了它，内核删的是 `stored` 和 `after` 里小的那个及以前的记录，于是面板可以同时取几页：后面几页的 `after` 走在前头，`stored` 停在写好的那一条。不带时照旧把 `after` 当作存好了；
- `format`（需要 `querylog_records_v1`）：`json`（默认）或 `records1`，后者的应答见下面的「编好的记录」；
- `wait_ms`（需要 `querylog_wait_v1`）：0–5000。`after` 之后攒不满 `limit` 条（带了 `until` 时，到它为止的还没齐）时，最多等这么久再回，攒满马上回；
- 其他参数一律返回 400 `querylog_query_invalid`。

面板对声明了 `querylog_wait_v1` 的内核一直挂着一个请求：一页 500 条，带上 `instance` 和 `wait_ms=1000`，取到了马上接着取。对其他内核按速率来取，最长隔一秒，一页 250 条。

对同时声明了 `querylog_stored_v1` 和 `querylog_until_v1` 的内核，面板已经有游标时几页同时取：
- 内核上回说的 `newest_seq` 已经过了一页末尾的，这几页先要着，带 `until`（这一页的末尾）和 `wait_ms=0`，同时最多 4 页；
- 不知道有没有的那页不带 `until`，带 `wait_ms=1000`，它回来之前不再往后要；
- 每页都带 `stored`，是已经写下的最后一条；
- 写还是按 `seq` 一页接一页。整段都被挤掉了的几页，漏掉的条数并成一行，和后面的记录一起写；
- 面板第一次取，或者有一页超过 8 MiB 的应答上限时，照一页页的办法。

对声明了 `querylog_records_v1` 的内核，面板每次都带 `format=records1`，自己写成 JSON 存下。

**应答**

| 字段 | 含义 |
| --- | --- |
| `instance` | 内核进程开始记的时刻（毫秒），换了进程就变 |
| `newest_seq` | 最新一条的编号 |
| `missed` | 游标之后已经被挤掉或清掉、取不到的条数 |
| `untracked` | 没记下的累计数：同时在处理的请求超过上限（声明 `querylog_wait_v1` 的内核是 16384 个，之前是 4096 个），或者一条记录长得放不进交接区 |
| `more` | 这一页交到的地方之后还有，马上接着取 |
| `entries` | 按 `seq` 从小到大的记录 |

**记录**

每条记录带：
- `seq`、`time_unix_ms`（请求开始时刻）；
- 完整的 `client`，`transport`；
- `qname`、`qtype`；
- `latency_us`、`status`（`completed` / `failed` / `cancelled`）、`outcome`；
- 有应答时的 `rcode`，最多 8 条回答记录的 `answers`，可能的 `error`；
- 最后进入的 `pipeline`、做出决定的 `rule`、回答的 `upstream`（转发时是回答的上游，用缓存时是缓存的来源）；
- 最多 64 步的 `steps`。

`outcome` 按顺序取第一个符合的：
1. `cached`、`stale`：用了缓存；
2. `failed`：SERVFAIL，或者引擎出错；
3. `joined`：搭了别人的同一个查询；
4. `static`：规则直接给的回答；
5. `forwarded`：转发给了上游；
6. `cancelled`：其余情况。

`static` 包括拦截和自定义回答，由面板按做出决定的那条规则去分。

`steps` 每步带 `at_us` 和 `kind`。快速路径当场答的请求（内核 2026.11.03.5 起），各步是答完才一起上报的，`at_us` 都是 0：先后看数组里的顺序，用了多久看 `latency_us`。

- `pipeline`：进入一个 Pipeline；
- `rule`：请求阶段命中的规则，或回答后检查评估过的规则（带 `matched`）；
- `decision`：没有对应规则步骤的决定；
- `cache`：查缓存的结果；
- `joined`：搭了别人的查询；
- `upstream`：问了一个上游，`result` 是 `success`、`rejected`、`error`、`aborted`（别的上游先答了）或 `throttled`（回了限速，DoH 的 HTTP 429；`error` 里是原文）；
- `upstream_skipped`：同一次转发里有别的上游可问，这个上游刚回过限速、还在暂停，这次没问它，带 `upstream`、`transport` 和 `reason`（目前只有 `throttled`）。它不是一次尝试，不进任何计数；不认识这一步的旧面板会跳过它。

**编好的记录（`format=records1`）**

内核在请求结束时就把一条记录编成一小段字节，放在交接区里。带 `format=records1` 时，这些字节原样交出来，内核不再写成 JSON。应答的类型是 `application/octet-stream`。面板写出的 JSON 和内核写的逐字节一样，由内核生成的样本 `crates/panel-server/tests/fixtures/querylog-records1.*` 保证。

编法：
- 数字是变长整数：每个字节七位，低位在前，高位为 1 表示后面还有。
- 文字是长度（数字）加 UTF-8 原文。
- 枚举是一个字节，编号见下表。
- 可有可无的项：文字前面一个字节，0 没有、1 有；枚举 0 表示没有，否则是编号加一；响应码是数字，0 表示没有，否则是响应码加一。

一页：

| 顺序 | 内容 |
| --- | --- |
| 1 | `KXQL` 和一个字节的版本 `1` |
| 2 | 数字：`protocol_version`、`instance`、`capacity`、`newest_seq`、`missed`、`untracked` |
| 3 | 一个字节：`more`（0 或 1） |
| 4 | 数字：第一条的 `seq`（往后一条加一）、条数 |
| 5 | 每条：长度（数字）和编好的字节 |

一条记录，顺序就是 JSON 字段的顺序（`seq` 不在记录里，由位置算出）：

| 顺序 | 字段 | 编法 |
| --- | --- | --- |
| 1 | `time_unix_ms` | 数字 |
| 2 | `client` | 地址：一个字节 `4` 加 4 字节，或 `6` 加 16 字节 |
| 3 | `transport` | 可有可无的枚举 |
| 4 | `qname` | 文字 |
| 5 | `qtype` | 文字 |
| 6 | `latency_us` | 数字 |
| 7 | `status` | 枚举 |
| 8 | `outcome` | 枚举 |
| 9 | `rcode` | 可有可无的响应码 |
| 10 | `answers` | 条数（数字），每条：一个字节 `4` 加 4 字节、`6` 加 16 字节，或 `0` 加文字 |
| 11 | `error`、`pipeline`、`rule`、`upstream` | 各是可有可无的文字 |
| 12 | `steps` | 步数（数字），每步见下 |
| 13 | `steps_truncated` | 一个字节，非 0 表示截断了 |

一步，先是 `at_us`（数字）和一个字节的种类，后面按种类：

| 种类 | `kind` | 后面的内容 |
| --- | --- | --- |
| 0 | `pipeline` | `pipeline`（文字） |
| 1 | `rule` | `pipeline`、`rule`（文字）；`phase`（枚举）；`matched`（一个字节：0 没有、1 否、2 是）；`decision`（可有可无的枚举）；`target`（可有可无的文字） |
| 2 | `decision` | `pipeline`（文字）；`rule`（可有可无的文字）；`phase`、`decision`（枚举）；`target`（可有可无的文字） |
| 3 | `cache` | `result`（可有可无的枚举，没有时是 `miss`）；`source`（可有可无的文字） |
| 4 | `joined` | 没有 |
| 5 | `upstream` | `upstream`（文字）；`transport`、`via`、`result`（枚举）；`latency_us`（数字）；`rcode`（可有可无的响应码）；`error`（可有可无的文字） |
| 6 | `upstream_skipped` | `upstream`（文字）；`transport`、`reason`（枚举） |

枚举的编号，从 0 数起：

| 枚举 | 值 |
| --- | --- |
| 记录的 `transport` | `udp`、`tcp`、`doh` |
| `status` | `completed`、`failed`、`cancelled` |
| `outcome` | `forwarded`、`cached`、`stale`、`joined`、`static`、`failed`、`cancelled` |
| `phase` | `request`、`response` |
| `decision` | `static`、`forward`、`jump`、`continue` |
| `cache` 步的 `result` | `fresh`、`stale`、`stale_timeout`、`stale_failure` |
| `upstream` 步的 `transport`、`via` | `udp`、`tcp`、`tcp_udp`、`doh`、`dot`、`doq` |
| `upstream` 步的 `result` | `success`、`rejected`、`error`、`aborted`、`throttled` |
| `reason` | `throttled` |

响应码写成 JSON 时：0–10 依次是 `NOERROR`、`FORMERR`、`SERVFAIL`、`NXDOMAIN`、`NOTIMP`、`REFUSED`、`YXDOMAIN`、`YXRRSET`、`NXRRSET`、`NOTAUTH`、`NOTZONE`，别的写成 `RCODE` 加数字。

改了编法就要换版本：新的能力名和 `format`（`querylog_records_v2`、`records2`），开头的版本字节也跟着变。内核的测试把一页的字节写死了，改了编法那个测试会红。

**什么时候记**

- 内核只在面板来取的那段时间里记：每次来取都会刷新时刻，超过 120 秒没人来取就停止记录并清空交接区，`seq` 照常往下数。面板停了一阵再回来时，按旧游标取会得到 `missed`，就是停之前没取走、后来被清掉的那些。
- 声明 `querylog_wait_v1` 的内核一启动就开始记，开机时比面板先起来的那几秒也记下；之前的内核要等面板第一次来取才开始记。
- 后台刷新和诊断查询不记。
- 内核重启后 `instance` 变了、`seq` 从 1 重新数，面板要从 `after=0` 重新取。

### `POST /v1/diagnostics/trace`

在当前进程内执行一次真实 DNS 查询并返回结果与有界执行轨迹。请求接受 `domain`、固定白名单中的 `record_type`，以及可选的 `client_ip`（需要 `diagnostics_trace_client_v1`），不能指定服务器；请求体最大 2 KiB，执行最长 6 秒。`client_ip` 让引擎把这次查询当作来自该地址：按客户端 IP 匹配的条件、ECS 的「发送客户端所在子网」和按客户端区分的缓存都按它算；不填时是 `127.0.0.1`。响应里的 `client_ip` 是实际使用的地址。轨迹覆盖请求解析、Pipeline 选择与跳转、响应/规则缓存、候选规则匹配、最终动作、实际上游和响应阶段匹配。

轨迹最多保留 128 步，超出时设置 `trace_truncated: true`。普通 DNS 请求未进入诊断作用域时不会分配或保存轨迹。该端点会像普通查询一样影响请求指标和缓存，但从 p28 起不进查询排行：测试用的域名和指定的客户端 IP 不是真实流量。客户端必须先确认 health 含有 `diagnostics_trace_v1`，旧增强版则回退到监听端口上的基础 DNS 查询。

### `POST /v1/diagnostics/trace-candidate`

需要 `diagnostics_trace_candidate_v1`。拿一份候选配置试跑一次查询，不碰正在用的配置、缓存和统计。请求体是诊断轨迹的字段加上 `config`（与 `/v1/config/validate` 相同的完整配置对象），最大 4 MiB 加 4 KiB；未知字段一律拒绝。

候选配置先走与 `/v1/config/validate` 相同的校验，不通过时返回 422 `config_invalid`。试跑在子进程 `kixdns panel-trial` 里执行：它从标准输入读请求、往标准输出写结果，不绑定任何监听端口，关掉后台刷新，用独立的统计；建引擎时打开的 UDP socket 池和 GeoSite 监视线程随子进程一起结束。同一时间只跑一个试跑，总时限 12 秒，超时返回 504 `diagnostic_timeout` 并结束子进程；子进程起不来或没有给出结果时返回 503 `diagnostic_trial_unavailable`。

成功时的响应与诊断轨迹相同，另加 `candidate: true`。试跑会真的去问候选配置里的上游。

## 查询统计配置

新内核开了控制通道（`--admin-socket`）就一直统计查询排行，客户端地址照原样记；没开控制通道时不统计，因为没有谁读得到。下面两个字段仍能读，旧配置照常加载，但新内核不再看它们，改它们也不清空排行、不让缓存换代：

- `settings.statistics_enabled`：旧内核据此决定是否采集查询排行，默认 `false`。
- `settings.statistics_anonymize_client_ip`：旧内核据此把客户端按 IPv4 `/24`、IPv6 `/64` 聚合，默认 `false`。

面板不再提供这两个开关，也不因为它们挡住保存、更新或回退；配置里已有的值原样写回。内核仍声明 `config_query_stats_v1`，表示认得这两个字段；旧增强版运行时返回 `stats_top_v1` 时，面板将其视为同一能力的兼容别名。

## 指标语义

- 缓存命中率为 `fresh + stale` 命中数除以缓存查询数。两个数都只算要靠上游回答的请求：缓存里存着的上游回答直接答上的算命中，决定去问上游的算一次没命中的查询；规则自己给的回答（拦截列表、域名映射、规则里写的静态回答），不管是当场给的还是开着 `min_ttl` 时存在缓存里的，都不计入。内核 2026.11.14.2 之前每次查缓存都算一次查询，拦得越多命中率越低，存进缓存的规则回答又算成命中。
- Pipeline 命中表示一次请求选择或跳转进入该 Pipeline。
- 规则命中表示匹配器链结果为真；`phase` 为 `request` 或 `response`。
- 上游 attempt 表示一次已配置的上游操作，result 表示该操作最终结果，而不是规则中的 Forward 动作数。`tcp_udp` 的内部 TCP 回退属于同一次操作。
- `result` 取值为 `success`、`error`、`rejected`、`aborted`、`throttled`，attempt 与 result 一一对应。`throttled` 表示上游回了限速（DoH 的 HTTP 429）：没有 DNS 回答，既不算成功也不算失败，不进成功率分母，也不算一次响应、不计耗时；内核随后让这个上游暂停一小会儿（服务器给了 `Retry-After` 就按它，限在 1 到 60 秒，没给就 1 秒），暂停期间同一次转发里还有别的上游时就不问它。认得限速之前的内核把 429 记成 `error`。`aborted` 表示多上游并发竞争中被更快的上游抢先应答而取消的尝试，它既不是成功也不是失败；`rejected` 表示上游回了 SERVFAIL 或 REFUSED、结果被丢弃，上游本身在正常应答，这些响应码已经计入响应码分布。因此面板的上游成功率是 `success / (success + error)`：只有超时和连接错误算失败，竞争落败和被拒绝的应答都不进分母——把 `aborted` 算进去会让同一规则下的上游按应答先后瓜分成功率，把 `rejected` 算进去则会让上游替它解析不了的域名背锅。增强版 p19 之前不上报 `aborted`，落败的尝试没有任何 result。
- 并发数覆盖进入异步处理至响应完成的请求，不包含已在同步快速路径返回的请求。面板首页不再展示并发数，该序列仅保留给外部消费者。
- 上游平均耗时以 `kixdns_upstream_response_latency_ms_sum / _count` 计算，只算拿到响应的尝试；增强版 p25 之前没有这组序列，退回 `kixdns_upstream_latency_ms_sum / _count`，其中含超时时长。
- 以上计数都从 KixDNS 启动起累加。面板每分钟采样一次，存在内存里，概览用当前值减去一小时内最早的采样，得到最近一小时的计数（`/api/v1/overview` 中每个上游的 `recent`、`metrics.request_latency_recent`，窗口长度为 `metrics.recent_window_seconds`）；KixDNS 一小时内重启过时直接用它启动以来的计数。面板重启后前几分钟没有窗口，退回累计值。
- 健康按最近一小时判断；某个上游最近一小时可判断的响应（`success + error`）不足 50 次时退回启动以来的累计，累计也不足 50 次记为观察中。成功率 ≥ 99% 且平均耗时 < 1 s 记为健康，成功率 < 95% 或平均耗时 ≥ 2 s 记为异常，其余为降级。
- 首页的响应速度同样看最近一小时，这一小时请求不足 50 次时退回累计。端到端耗时直方图的累计桶换算成四段不重叠的区间：10 ms 内、10–100 ms、100 ms–1 s、1 s 以上；100 ms 内返回 ≥ 95% 记为健康，≥ 80% 记为降级，其余为异常。
