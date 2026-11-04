# KixDNS Enhanced Control Protocol v1

[简体中文](control-protocol-v1.md) | **English**

## Transport

The default address on Linux is `/run/kixdns/admin.sock`. The protocol uses HTTP/1.1 over a Unix Socket. Response bodies are UTF-8 JSON. The metrics endpoint uses the Prometheus text format. Only the user or user group that Panel Server runs under is allowed to access the socket.

All JSON responses contain `protocol_version: 1`. Clients must ignore unknown fields. Existing fields must not change meaning within the same protocol version.

## Endpoints

### `GET /v1/health`

Returns the process status, the upstream commit, the release version (`release_version`, `release_commit`; only kernels released by the fork have them, all others report `null`), the patchset (only old patchset kernels have it; fork kernels report `unknown`), the start time, the current config generation and the capability list `capabilities`. A client may use an endpoint or write a controlled field only when the matching capability is present. Kernels released by the fork declare all the capabilities listed below. p28 lacks those starting with `querylog_`:

- Config capabilities: `config_query_stats_v1` (query statistics config fields, see below), `config_static_cname_response_v1` (the `static_cname_response` action, that is, a fixed CNAME answer; the panel's domain mapping uses it)
- `stats_top_v1`: the query rankings endpoint
- `diagnostics_trace_v1`: the diagnostics trace endpoint
- `diagnostics_trace_client_v1`: since enhanced build p28, diagnostics trace and draft trial runs accept `client_ip`, which pretends the query comes from this client
- `diagnostics_trace_candidate_v1`: since enhanced build p28, the draft trial run endpoint `POST /v1/diagnostics/trace-candidate`
- `metrics_upstream_precision_v1`: since enhanced build p21, `/v1/metrics` provides the `aborted` result, upstream latency, response codes, actual transport, request completion status and stale cache reasons. The panel computes upstream health and uses the success rate formula that excludes race losers only when it sees this capability. Otherwise health is shown as unknown
- `metrics_upstream_response_latency_v1`: since enhanced build p25, `/v1/metrics` also provides upstream latency that counts only attempts that got a response. The panel uses it to compute average latency
- `querylog_v1`: since fork kernel 2026.10.14, the query log endpoint `GET /v1/querylog`
- `querylog_wait_v1`: since fork kernel 2026.11.02.9, a query log fetch may carry `instance` and `wait_ms` (see below)
- `querylog_stored_v1`: since fork kernel 2026.11.02.11, a query log fetch may carry `stored`. The kernel deletes only what the panel says is stored. Several waiting requests are each woken (see below)
- `querylog_until_v1`: since fork kernel 2026.11.02.12, a query log fetch may carry `until`, which hands over records only up to this sequence number (see below)
- `querylog_records_v1`: since fork kernel 2026.11.03.4, a query log fetch may carry `format=records1`, which hands over the encoded records as they are (see below)

Runtime capabilities handle the config gate for the current process. A target version that has not started yet is preflighted with the SHA-256-validated `KIXDNS_CAPABILITIES.json` in the kernel package. For the full rules, see the [config capability contract](config-capabilities.en.md).

### `GET /v1/config/active`

Returns the config currently in effect, not the state of the file on disk:

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

After Panel Server saves a config, it reports the config as in effect only when this endpoint's `sha256` matches the config on disk.
`reload_sequence` increments each time a hot reload succeeds or finally fails. A client must wait until it is greater than the value from before the write, so that an old receipt is not mistaken for the result of this reload.

### `GET /v1/metrics`

The first version fixes the following metrics:

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

Since enhanced build p20, the following series are added. When they are missing, the panel service keeps the matching fields at their default values and does not treat this as a protocol error:

- `kixdns_cache_stale_total{reason="expired|client_timeout|upstream_failure"}`: the breakdown of stale cache hits by reason. The sum of the three equals `kixdns_cache_hits_total{kind="stale"}`.
- `kixdns_requests_finished_total{status="completed|failed|cancelled"}`: request completion status, excluding background refresh.
- `kixdns_request_latency_ms_bucket{le="10|50|100|500|1000|+Inf"}`, `kixdns_request_latency_ms_sum`, `kixdns_request_latency_ms_count`: end-to-end latency histogram and cumulative values (milliseconds, `_sum` keeps three decimal places).
- `kixdns_upstream_latency_ms_sum{upstream,transport}`, `kixdns_upstream_latency_ms_count{upstream,transport}`: cumulative latency and count of upstream attempts that got a result, excluding `aborted` and `throttled`.
- `kixdns_upstream_response_latency_ms_sum{upstream,transport}`, `kixdns_upstream_response_latency_ms_count{upstream,transport}`: counts only attempts that got a response, that is, `success` and `rejected`. `error` from timeouts and connection errors is not counted; otherwise one timeout would add the whole timeout duration to the average latency.
- `kixdns_upstream_rcodes_total{upstream,rcode}`: count of response codes in upstream answers. `rcode` is the hickory variant name (`NoError`, `NXDomain`, `ServFail`, `Refused` and so on).
- `kixdns_upstream_via_total{upstream,transport,via}`: `transport` is the transport selected for this address. `via` is the transport that actually brought the answer back. `transport="udp"` with `via="tcp"` means TCP fallback.

Label values must be escaped and may come only from the bounded sets of Pipelines, rules and upstreams in the config.

### `POST /v1/config/validate`

The request body is a candidate KixDNS JSON config, at most 4 MiB. The enhanced process validates the config with exactly the same parsing, normalization and runtime compilation flow as hot reload, but does not modify the disk or the active config. On success it returns the Pipeline and rule counts. On failure it returns `422` and a structured error.

### `POST /v1/cache/flush`

Clears the DNS response cache and the rule cache. Returns the entry counts before and after this operation.

### `GET /v1/stats/top`

Returns client and request domain rankings held in bounded memory. `window` accepts only `3600`, `21600` and `86400` seconds. `limit` accepts 1–50. The default returns the Top 20 for the last 24 hours. The response contains `enabled`, `anonymized_clients`, the observed request count, the dropped update count, the retention time and the generation time. New kernels always collect statistics and record full client addresses, so these two fields are always `true` and `false`. Old kernels fill them in from the statistics switch and the anonymization setting in the config (see below).

Statistics use 24 hourly buckets. Window boundaries are hour-level estimates. Each hour keeps at most 4096 domains and 1024 clients. When capacity runs out or shards contend, only statistics updates are dropped; DNS requests are not blocked. The data is kept only in memory and is cleared when the process restarts.

### `POST /v1/stats/clear`

Clears all query rankings.

### `GET /v1/querylog`

Requires `querylog_v1`. The kernel records queries in a handoff area in memory. The panel fetches them by cursor and writes them into its own query log. The handoff area holds 16384 records on kernels that declare `querylog_wait_v1` and 4096 records before that. When it is full, the oldest are dropped.

**Parameters**

- `after`: the `seq` of the last record the panel has already fetched, 0 on the first fetch;
- `limit`: 1–2000, default 2000;
- `until` (requires `querylog_until_v1`): hands over only records whose `seq` does not exceed it. When a stretch after `after` has been pushed out, this page still does not cross the boundary to hand over records after `until`, and `missed` counts only up to `until`. So when the panel fetches several adjacent ranges at the same time, the ranges do not overlap;
- `instance` (requires `querylog_wait_v1`): the kernel process the cursor belongs to, that is, the `instance` in the answer of the page that gave the cursor.
  - If it belongs to this kernel process: the panel has stored the records up to and including `after`, and the kernel deletes them from the handoff area.
  - If it belongs to another process: nothing is deleted, there is no wait, and the kernel replies at once.
  - If absent: nothing is deleted.
  - When the panel probes which process this is with an `after` far greater than `newest_seq`, it must not carry this parameter;
- `stored` (requires `querylog_stored_v1`, takes effect only together with `instance`): the record up to which the panel has stored. When it is carried, the kernel deletes records up to and including the smaller of `stored` and `after`, so the panel may fetch several pages at the same time: the `after` of the later pages runs ahead, and `stored` stays at the record already written. When it is absent, `after` is treated as stored, as before;
- `format` (requires `querylog_records_v1`): `json` (default) or `records1`. For the answer of the latter, see "Encoded records" below;
- `wait_ms` (requires `querylog_wait_v1`): 0–5000. When fewer than `limit` records have accumulated after `after` (with `until`, when the records up to it are not all there yet), the kernel waits at most this long before replying. Once full, it replies at once;
- Any other parameter returns 400 `querylog_query_invalid`.

For kernels that declare `querylog_wait_v1`, the panel always keeps one request pending: 500 records per page, carrying `instance` and `wait_ms=1000`, and fetching again at once after each result. For other kernels it fetches according to rate, at most one second apart, 250 records per page.

For kernels that declare both `querylog_stored_v1` and `querylog_until_v1`, the panel fetches several pages at the same time once it has a cursor:
- Pages whose end the `newest_seq` last reported by the kernel has already passed are requested first, with `until` (the end of this page) and `wait_ms=0`, at most 4 pages at the same time;
- The page not known to have any records carries no `until` and carries `wait_ms=1000`. Nothing further is requested until it returns;
- Every page carries `stored`, which is the last record already written;
- Writes still go page after page in `seq` order. For pages that were pushed out entirely, the missed counts are merged into one row and written together with the later records;
- On the panel's first fetch, or when a page exceeds the 8 MiB answer limit, the panel uses the page-by-page method.

For kernels that declare `querylog_records_v1`, the panel always carries `format=records1` and writes the records as JSON itself to store them.

**Answer**

| Field | Meaning |
| --- | --- |
| `instance` | The moment the kernel process started recording (milliseconds). It changes when the process changes |
| `newest_seq` | Sequence number of the newest record |
| `missed` | Number of records after the cursor that have already been pushed out or cleared and cannot be fetched |
| `untracked` | Cumulative count of what was not recorded: the requests being processed at the same time exceeded the limit (16384 on kernels that declare `querylog_wait_v1`, 4096 before that), or a record was too long to fit in the handoff area |
| `more` | There is more after the point this page reached; fetch again at once |
| `entries` | Records in ascending `seq` order |

**Records**

Each record carries:
- `seq`, `time_unix_ms` (the moment the request started);
- the full `client`, `transport`;
- `qname`, `qtype`;
- `latency_us`, `status` (`completed` / `failed` / `cancelled`), `outcome`;
- `rcode` when there is an answer, `answers` with at most 8 answer records, a possible `error`;
- the last entered `pipeline`, the `rule` that made the decision, the answering `upstream` (when forwarding, the upstream that answered; when using the cache, the source of the cache);
- `steps`, at most 64 steps.

`outcome` takes the first match, in order:
1. `cached`, `stale`: the cache was used;
2. `failed`: SERVFAIL, or an engine error;
3. `joined`: joined someone else's identical query;
4. `static`: an answer given directly by a rule;
5. `forwarded`: forwarded to an upstream;
6. `cancelled`: all other cases.

`static` includes blocking and custom answers. The panel tells them apart by the rule that made the decision.

Each step in `steps` carries `at_us` and `kind`. For requests answered on the spot on the fast path (since kernel 2026.11.03.5), the steps are reported together only after the answer, and `at_us` is always 0: for order, look at the order in the array; for duration, look at `latency_us`.

- `pipeline`: entered a Pipeline;
- `rule`: a rule hit in the request phase, or a rule evaluated in the post-answer check (carries `matched`);
- `decision`: a decision with no matching rule step;
- `cache`: the result of the cache lookup;
- `joined`: joined someone else's query;
- `upstream`: asked an upstream. `result` is `success`, `rejected`, `error`, `aborted` (another upstream answered first) or `throttled` (it replied with a rate limit, HTTP 429 for DoH; `error` holds the original text);
- `upstream_skipped`: another upstream could be asked in the same forward, and this upstream has just replied with a rate limit and is still paused, so it was not asked this time. Carries `upstream`, `transport` and `reason` (currently only `throttled`). It is not an attempt and enters no count. Old panels that do not recognize this step skip it.

**Encoded records (`format=records1`)**

When a request ends, the kernel already encodes its record into a short run of bytes and puts it in the handoff area. With `format=records1`, these bytes are handed over as they are, and the kernel does not write JSON. The answer's type is `application/octet-stream`. The JSON the panel writes is byte-for-byte the same as what the kernel writes. The kernel-generated samples `crates/panel-server/tests/fixtures/querylog-records1.*` guarantee this.

Encoding:
- A number is a varint: seven bits per byte, low bits first. A high bit of 1 means more follows.
- Text is a length (number) plus the raw UTF-8 text.
- An enum is one byte. Its number is in the table below.
- Optional items: text has one byte in front, 0 absent, 1 present. For an enum, 0 means absent, otherwise the value is the number plus one. A response code is a number: 0 means absent, otherwise the value is the response code plus one.

A page:

| Order | Content |
| --- | --- |
| 1 | `KXQL` and a one-byte version `1` |
| 2 | Numbers: `protocol_version`, `instance`, `capacity`, `newest_seq`, `missed`, `untracked` |
| 3 | One byte: `more` (0 or 1) |
| 4 | Numbers: the `seq` of the first record (each following record adds one), the record count |
| 5 | Each record: length (number) and the encoded bytes |

A record. The order is the order of the JSON fields (`seq` is not in the record; it is computed from the position):

| Order | Field | Encoding |
| --- | --- | --- |
| 1 | `time_unix_ms` | Number |
| 2 | `client` | Address: one byte `4` plus 4 bytes, or `6` plus 16 bytes |
| 3 | `transport` | Optional enum |
| 4 | `qname` | Text |
| 5 | `qtype` | Text |
| 6 | `latency_us` | Number |
| 7 | `status` | Enum |
| 8 | `outcome` | Enum |
| 9 | `rcode` | Optional response code |
| 10 | `answers` | Count (number); each one: one byte `4` plus 4 bytes, `6` plus 16 bytes, or `0` plus text |
| 11 | `error`, `pipeline`, `rule`, `upstream` | Each is optional text |
| 12 | `steps` | Step count (number); each step as below |
| 13 | `steps_truncated` | One byte; non-zero means truncated |

A step. First `at_us` (number) and a one-byte kind, then, by kind:

| Kind | `kind` | What follows |
| --- | --- | --- |
| 0 | `pipeline` | `pipeline` (text) |
| 1 | `rule` | `pipeline`, `rule` (text); `phase` (enum); `matched` (one byte: 0 absent, 1 no, 2 yes); `decision` (optional enum); `target` (optional text) |
| 2 | `decision` | `pipeline` (text); `rule` (optional text); `phase`, `decision` (enum); `target` (optional text) |
| 3 | `cache` | `result` (optional enum; `miss` when absent); `source` (optional text) |
| 4 | `joined` | Nothing |
| 5 | `upstream` | `upstream` (text); `transport`, `via`, `result` (enum); `latency_us` (number); `rcode` (optional response code); `error` (optional text) |
| 6 | `upstream_skipped` | `upstream` (text); `transport`, `reason` (enum) |

Enum numbers, counting from 0:

| Enum | Values |
| --- | --- |
| The record's `transport` | `udp`, `tcp`, `doh` |
| `status` | `completed`, `failed`, `cancelled` |
| `outcome` | `forwarded`, `cached`, `stale`, `joined`, `static`, `failed`, `cancelled` |
| `phase` | `request`, `response` |
| `decision` | `static`, `forward`, `jump`, `continue` |
| The `cache` step's `result` | `fresh`, `stale`, `stale_timeout`, `stale_failure` |
| The `upstream` step's `transport`, `via` | `udp`, `tcp`, `tcp_udp`, `doh`, `dot`, `doq` |
| The `upstream` step's `result` | `success`, `rejected`, `error`, `aborted`, `throttled` |
| `reason` | `throttled` |

When a response code is written as JSON: 0–10 are, in order, `NOERROR`, `FORMERR`, `SERVFAIL`, `NXDOMAIN`, `NOTIMP`, `REFUSED`, `YXDOMAIN`, `YXRRSET`, `NXRRSET`, `NOTAUTH`, `NOTZONE`. Others are written as `RCODE` plus the number.

Changing the encoding requires a new version: a new capability name and `format` (`querylog_records_v2`, `records2`), and the version byte at the start changes with them. A kernel test hard-codes the bytes of a page; when the encoding changes, that test fails.

**When the kernel records**

- The kernel records only during the period when the panel is fetching: each fetch refreshes the timestamp. After more than 120 seconds with no fetch, the kernel stops recording and clears the handoff area, and `seq` keeps counting as usual. When the panel stops for a while and comes back, fetching with the old cursor returns `missed`, which is the records not fetched before the stop and cleared later.
- Kernels that declare `querylog_wait_v1` start recording as soon as they start, including the few seconds at boot when the kernel comes up before the panel. Earlier kernels start recording only at the panel's first fetch.
- Background refreshes and diagnostics queries are not recorded.
- After a kernel restart, `instance` changes and `seq` counts again from 1. The panel has to fetch again from `after=0`.

### `POST /v1/diagnostics/trace`

Runs one real DNS query inside the current process and returns the result and a bounded execution trace. The request accepts `domain`, a `record_type` from a fixed allowlist, and an optional `client_ip` (requires `diagnostics_trace_client_v1`). It cannot specify a server. The request body is at most 2 KiB, and execution takes at most 6 seconds. `client_ip` makes the engine treat this query as coming from that address: conditions that match on client IP, ECS's "send the client's subnet" and per-client caching all use it. When it is not set, it is `127.0.0.1`. The `client_ip` in the response is the address actually used. The trace covers request parsing, Pipeline selection and jumps, response/rule cache, candidate rule matching, the final action, the actual upstream and response phase matching.

The trace keeps at most 128 steps. Beyond that, `trace_truncated: true` is set. Normal DNS requests that have not entered the diagnostics scope do not allocate or keep a trace. This endpoint affects request metrics and the cache like a normal query, but since p28 it does not enter the query rankings: test domains and specified client IPs are not real traffic. A client must first confirm that health contains `diagnostics_trace_v1`. For older enhanced builds it falls back to a basic DNS query on the listening port.

### `POST /v1/diagnostics/trace-candidate`

Requires `diagnostics_trace_candidate_v1`. Runs one trial query with a candidate config, without touching the config in use, the cache or the statistics. The request body is the diagnostics trace fields plus `config` (the same complete config object as `/v1/config/validate`), at most 4 MiB plus 4 KiB. Unknown fields are always rejected.

The candidate config first goes through the same validation as `/v1/config/validate`. If it does not pass, the endpoint returns 422 `config_invalid`. The trial run executes in the child process `kixdns panel-trial`: it reads the request from standard input and writes the result to standard output, binds no listening port, turns off background refresh and uses separate statistics. The UDP socket pool and the GeoSite watcher thread opened while building the engine end with the child process. Only one trial run executes at a time, with a total time limit of 12 seconds. On timeout the endpoint returns 504 `diagnostic_timeout` and ends the child process. When the child process fails to start or gives no result, the endpoint returns 503 `diagnostic_trial_unavailable`.

The response on success is the same as for diagnostics trace, plus `candidate: true`. The trial run really asks the upstreams in the candidate config.

## Query statistics configuration

A new kernel with the control socket on (`--admin-socket`) always collects query rankings and records client addresses as they are. Without the control socket it does not collect them, because nobody could read them. The two fields below can still be read and old configs load as usual, but new kernels no longer look at them, and changing them neither clears the rankings nor changes the cache generation:

- `settings.statistics_enabled`: old kernels use it to decide whether to collect query rankings. Default `false`.
- `settings.statistics_anonymize_client_ip`: old kernels use it to aggregate clients by IPv4 `/24` and IPv6 `/64`. Default `false`.

The panel no longer offers these two switches and does not block saving, updating or rolling back because of them. Values already in the config are written back unchanged. Kernels still declare `config_query_stats_v1`, meaning they recognize these two fields. When an older enhanced build returns `stats_top_v1` at runtime, the panel treats it as a compatibility alias of the same capability.

## Metric semantics

- The cache hit rate is the number of `fresh + stale` hits divided by the number of cache lookups.
- A Pipeline hit means a request selected or jumped into that Pipeline.
- A rule hit means the matcher chain result is true. `phase` is `request` or `response`.
- An upstream attempt means one configured upstream operation. A result means the final result of that operation, not the number of Forward actions in rules. The internal TCP fallback of `tcp_udp` belongs to the same operation.
- `result` takes the values `success`, `error`, `rejected`, `aborted` and `throttled`. Attempts and results correspond one to one. `throttled` means the upstream replied with a rate limit (HTTP 429 for DoH): there is no DNS answer, it counts as neither success nor failure, it does not enter the success rate denominator, it does not count as a response and no latency is counted. The kernel then pauses this upstream briefly (following `Retry-After` if the server gave it, limited to 1 to 60 seconds, and 1 second if it did not). During the pause, the upstream is not asked when the same forward has other upstreams. Kernels from before rate limits were recognized record 429 as `error`. `aborted` means an attempt cancelled in a concurrent multi-upstream race because a faster upstream answered first. It is neither success nor failure. `rejected` means the upstream replied SERVFAIL or REFUSED and the result was discarded. The upstream itself is answering normally, and these response codes are already counted in the response code distribution. So the panel's upstream success rate is `success / (success + error)`: only timeouts and connection errors count as failures. Race losers and rejected answers do not enter the denominator. Counting `aborted` would make upstreams under the same rule split the success rate by who answers first. Counting `rejected` would make an upstream take the blame for domains it cannot resolve. Enhanced builds before p19 do not report `aborted`, and losing attempts have no result at all.
- The concurrency count covers requests from entering asynchronous processing to response completion. It does not include requests already returned on the synchronous fast path. The panel home page no longer shows the concurrency count. This series is kept only for external consumers.
- Average upstream latency is computed as `kixdns_upstream_response_latency_ms_sum / _count`, counting only attempts that got a response. Enhanced builds before p25 do not have this group of series, so it falls back to `kixdns_upstream_latency_ms_sum / _count`, which includes timeout durations.
- All the counts above accumulate from KixDNS start. The panel samples once per minute and keeps the samples in memory. The overview subtracts the earliest sample within the hour from the current value to get the counts for the last hour (`recent` of each upstream and `metrics.request_latency_recent` in `/api/v1/overview`; the window length is `metrics.recent_window_seconds`). When KixDNS has restarted within the hour, the counts since its start are used directly. For the first few minutes after a panel restart there is no window, so it falls back to the cumulative values.
- Health is judged on the last hour. When an upstream has fewer than 50 judgeable responses (`success + error`) in the last hour, it falls back to the cumulative count since start. When the cumulative count is also fewer than 50, it is marked as under observation. Success rate ≥ 99% and average latency < 1 s is marked healthy. Success rate < 95% or average latency ≥ 2 s is marked abnormal. Everything else is degraded.
- The response speed on the home page also looks at the last hour. When this hour has fewer than 50 requests, it falls back to the cumulative values. The cumulative buckets of the end-to-end latency histogram are converted into four non-overlapping intervals: within 10 ms, 10–100 ms, 100 ms–1 s, above 1 s. ≥ 95% returned within 100 ms is marked healthy, ≥ 80% is marked degraded, and everything else is abnormal.
