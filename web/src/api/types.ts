export interface User {
  id: number
  username: string
}

export interface AuthSession {
  user: User
  csrf_token: string
  expires_at: number
}

export interface Health {
  protocol_version: number
  status: string
  pid: number
  version: string
  /** fork 发布时编译进去的日期版本和提交；补丁集构建和本地构建没有。 / The date version and commit a fork release compiles in; patchset and local builds have neither. */
  release_version?: string | null
  release_commit?: string | null
  upstream_commit: string
  patchset: string
  started_at_unix: number
  uptime_seconds: number
  config_generation: number
  capabilities: string[]
}

export interface ActiveConfig {
  protocol_version: number
  generation: number
  sha256: string
  loaded_at_unix: number
  reload_sequence: number
  last_reload: {
    success: boolean
    error: string | null
  }
  /** 配置里改过、要重启 KixDNS 才生效的设置（内核的设置名）；旧内核不报告 */
  restart_pending?: string[]
}

export interface NamedCount {
  name: string
  count: number
}

export interface RuleCount {
  pipeline: string
  rule: string
  phase: 'request' | 'response'
  count: number
}

export interface UpstreamCount {
  upstream: string
  transport: string
  attempts: number
  success: number
  errors: number
  rejected: number
  /** 并发竞争中被取消的尝试，不计入成功率分母。 */
  aborted: number
  /** 上游回了限速（DoH 的 HTTP 429）的尝试：没有给出 DNS 回答，既不算成功也不算失败。 */
  throttled: number
  /** 平均耗时（毫秒）：增强版 p25 起只算拿到响应的尝试，更早的含超时；旧增强版为 null。 */
  avg_latency_ms: number | null
  /** 按响应码计数，按次数降序。 */
  rcodes: NamedCount[]
  /** 选定 UDP 但靠 TCP 兜底才拿到答案的次数。 */
  tcp_fallbacks: number
  /** 最近一段时间（最长一小时）的计数；面板还没有可比的采样时为 null。 */
  recent: UpstreamTally | null
}

/** 一段时间内某个上游的计数。 */
export interface UpstreamTally {
  attempts: number
  success: number
  errors: number
  rejected: number
  aborted: number
  throttled: number
  tcp_fallbacks: number
  avg_latency_ms: number | null
}

export interface FinishedCounts {
  completed: number
  failed: number
  cancelled: number
}

export interface RequestLatency {
  samples: number
  avg_ms: number
  within_10ms: number
  within_100ms: number
  within_1s: number
}

export interface StaleBreakdown {
  expired: number
  client_timeout: number
  upstream_failure: number
}

export interface MetricsSnapshot {
  requests_total: number
  requests_inflight: number
  cache_lookups_total: number
  cache_hits_fresh: number
  cache_hits_stale: number
  cache_entries: number
  config_generation: number
  reload_success: number
  reload_failure: number
  pipelines: NamedCount[]
  rules: RuleCount[]
  upstreams: UpstreamCount[]
  requests_finished: FinishedCounts
  request_latency: RequestLatency
  cache_stale: StaleBreakdown
  /** 最近一段时间的端到端耗时，与 `recent_window_seconds` 同一个窗口；没有窗口时为 null。 */
  request_latency_recent: RequestLatency | null
  /** 各上游 `recent` 与 `request_latency_recent` 实际覆盖的秒数，最长一小时；面板还没有可比的采样时为 null。 */
  recent_window_seconds: number | null
}

export interface QueryStatsSnapshot {
  protocol_version: number
  enabled: boolean
  anonymized_clients: boolean
  window_seconds: number
  retention_seconds: number
  generated_at_unix: number
  requests_observed: number
  dropped_updates: number
  clients: NamedCount[]
  domains: NamedCount[]
  live: boolean
  captured_at_unix: number | null
}

export interface StatsClearResult {
  protocol_version: number
  cleared: boolean
}

/** 一个整点桶内的请求数。 */
export interface TrendPoint {
  start_unix: number
  requests: number
}

export interface RequestTrend {
  bucket_seconds: number
  /**
   * 只包含采样真正覆盖到的桶，按时间升序。面板刚装上时这里比 24 条短——
   * 补零会把「还没有数据」画成「那时没有请求」。
   */
  points: TrendPoint[]
  /** 上列各桶之和。 */
  total: number
}

export interface Overview {
  health: Health
  active_config: ActiveConfig
  metrics: MetricsSnapshot
  live: boolean
  service_active: boolean | null
  captured_at_unix: number
  trend: RequestTrend
}

export interface ServiceStatus {
  unit: string
  /** KixDNS 起不来（失败、systemd 在重试，或者重试的那一下）：服务端补上，各页据此说「启动失败」 */
  did_not_come_up?: boolean
  active_state: string
  sub_state: string
  main_pid: number
  /** 起不来时可以退回的设置和它们上次启动时的值（和配置页同一份）；其余时候省略 */
  restart_rollback?: Record<string, unknown>
  /** 起不来、不能退回时可以写进配置文件的待应用版本（和配置页同一份）；其余时候省略 */
  pending_writable?: number
}

export interface ConfigDocument {
  content: Record<string, unknown>
  sha256: string
  modified_at: number
  version_id: number | null
  /**
   * 待应用版本的摘要。待应用内容仍由上面的 content 返回，避免客户端
   * 同时维护两份可编辑 JSON。
   */
  pending?: PendingConfig | null
  runtime: {
    status: 'active' | 'different' | 'pending' | 'failed' | 'unavailable'
    active_sha256: string | null
    generation: number | null
    apply_state?: ConfigRuntimeApplyState
    declared_capabilities?: string[]
    pending_error?: string | null
    /** 改过、要重启 KixDNS 才生效的设置（内核的设置名）；没有或内核不报告时省略 */
    restart_pending?: string[]
    /** 重启后 KixDNS 没回来时，可以退回的设置和它们上次启动时的值（null 是没写、用默认值）；其余时候省略 */
    restart_rollback?: Record<string, unknown>
    /** 服务端看出 KixDNS 起不来（连不上、systemd 放弃了或在重试）；能不能退回都会带；其余时候省略 */
    did_not_come_up?: boolean
    /** 起不来、不能退回时，可以写进配置文件的待应用版本（已经在文件里的、退回时带上的修改都不算）；其余时候省略 */
    pending_writable?: number
  }
}

export type ConfigRuntimeApplyState = 'active' | 'pending' | 'failed' | 'unavailable'
export type ConfigVersionApplyState = 'applied' | 'pending' | 'failed' | 'superseded'

export interface PendingConfig {
  version_id?: number | null
  sha256?: string | null
  message?: string
  actor?: string
  created_at?: number
  error?: string | null
  /** 退回写下的版本：settings 只改回那几项，settings_and_pending 带上了待应用的修改；页面不报它的编号 */
  from_rollback?: 'settings' | 'settings_and_pending'
}

export interface ConfigVersion {
  id: number
  sha256: string
  message: string
  actor: string
  created_at: number
  apply_state?: ConfigVersionApplyState
  apply_error?: string | null
}

export interface ConfigVersions {
  versions: ConfigVersion[]
}

export interface ConfigVersionDetail extends ConfigVersion {
  content: Record<string, unknown>
}

export interface DeleteConfigVersionResult {
  deleted_id: number
}

export interface DeleteConfigVersionsResult {
  deleted_ids: number[]
}

export interface ValidationResult {
  protocol_version: number
  valid: boolean
  pipeline_count: number
  rule_count: number
}

export interface ConfigApplyResult {
  version_id: number
  sha256: string
  apply_state?: 'applied' | 'pending'
  active_config?: ActiveConfig
  apply_error?: string | null
  validation?: ValidationResult
}

export interface GeoDataResource {
  url: string
  path: string
  sha256: string
  size: number
  downloaded_at: number
}

export interface GeoDataManifest {
  geoip_mmdb: GeoDataResource | null
  geoip_dat: GeoDataResource | null
  geosite: GeoDataResource[]
}

/** 安装包自带的 GeoSite（Loyalsoldier 的 geosite.dat）；开发构建没有。 / The GeoSite the package brings along (Loyalsoldier's geosite.dat); development builds have none. */
export interface GeoDataBuiltin {
  /** 导入后按这个链接更新，用户可以改成别的。 / Updates follow this link once imported; the user may change it. */
  url: string
  release: string
  release_url: string
  published_at: string | null
  sha256: string
  size: number
}

/** GeoSite 数据里的一个分类：域名数，以及带各属性（cn、ads、!cn…）的域名数。 / One GeoSite category: its domain count and the count per attribute (cn, ads, !cn …). */
export interface GeositeCategory {
  /** 小写的分类名 / The category name in lower case */
  name: string
  domains: number
  attributes: { key: string; domains: number }[]
}

/** 一个 GeoSite 文件读得怎么样：读到了给内容摘要，读不到给原因。 / How one GeoSite file read: its content digest, or why it did not. */
export interface GeositeFile {
  path: string
  sha256: string | null
  error: string | null
}

/** 面板知道的 GeoSite 文件和它们的分类，分类按内容摘要放。 / The GeoSite files the panel knows and their categories, keyed by content digest. */
export interface GeositeCategories {
  files: GeositeFile[]
  builtin: GeositeFile | null
  catalogs: Record<string, GeositeCategory[]>
}

export interface GeoDataSyncRequest {
  geoip_mmdb_url: string | null
  geoip_dat_url: string | null
  geosite_urls: string[]
}

export interface GeoDataCleanupResult {
  scanned_files: number
  removed_files: number
  reclaimed_bytes: number
}

export interface GeoDataSchedule {
  interval_hours: 24 | 168 | null
  last_attempt_at: number | null
  last_success_at: number | null
  last_error: string | null
  next_run_at: number | null
}

/** 拦截列表里没用上的一行（服务端最多给前 20 行） / One unused line of a blocklist (the server gives the first 20 at most) */
export interface BlocklistSkippedLine { line: number; text: string; reason: string; modifier?: string }
/** title：列表开头注释里写的标题（`! Title: …`），没有时不带 / title: the title in the list's opening comments (`! Title: …`), absent without one */
export interface BlocklistSummary { rules: number; skipped: number; samples: BlocklistSkippedLine[]; title?: string }
/** 一个订阅的列表（按链接）最近一份读得怎么样 / How the latest copy of one subscribed list (by link) read */
export interface BlocklistSource {
  /** 在用的那一份；还没下载成功过时为 null / The copy in use; null until a download succeeds */
  sha256: string | null
  downloaded_at: number | null
  summary: BlocklistSummary
  /** 最近一次下载没成功的原因；成功以后清掉 / Why the latest download failed; cleared once one succeeds */
  last_error: string | null
  /** 这次失败重下可能就好（连接一类）；链接不对、文件读不懂时为 false / Whether downloading again may help (connection trouble); false for a wrong link or an unreadable file */
  retryable?: boolean
  last_attempt_at: number | null
  rejected_sha256: string | null
}
export interface BlocklistState { sources: Record<string, BlocklistSource>; schedule: GeoDataSchedule }
export interface BlocklistBuildRequest { subscriptions: { url: string; enabled: boolean }[]; refresh: string[] }
export interface BlocklistBuildResult {
  /** 合并出的文件；启用的列表一个都还没有、或者合起来没有要拦截的时为 null / The merged file; null while no enabled list has a copy, or when they block nothing together */
  path: string | null
  sources: Record<string, BlocklistSource>
  /** 这次没下载成功的列表数 / How many lists failed to download this time */
  failed: number
}

export interface CacheFlushResult {
  protocol_version: number
  response_entries_before: number
  response_entries_after: number
  rule_entries_before: number
  rule_entries_after: number
}

export interface LogEntry {
  timestamp_unix_micros: number
  priority: number
  source: string
  message: string
}

export interface LogsResponse {
  entries: LogEntry[]
  next_cursor: string | null
  /** journald 看不到这个 unit 的输出时（unit 不存在，或 StandardOutput/StandardError
   *  被改到 journald 之外），服务端拼好的完整一句提示，原样展示；null 表示能看到。
   *  The complete sentence composed server-side when journald cannot see the
   *  unit's output (unit missing, or StandardOutput/StandardError redirected),
   *  rendered verbatim; null means visible. */
  notice: string | null
}

export interface AuditEvent {
  id: number
  actor: string | null
  action: string
  detail: string
  created_at: number
}

export interface AuditPage {
  events: AuditEvent[]
  next_cursor: number | null
}

export interface DnsDiagnostic {
  server: string
  domain: string
  record_type: string
  response_code: string
  elapsed_ms: number
  truncated: boolean
  answers: string[]
  trace_supported: boolean
  trace_truncated: boolean
  trace: DnsTraceStep[]
  /** 内核按哪个客户端 IP 处理的；旧内核没有 / The client IP the kernel used; absent on older kernels */
  client_ip?: string | null
  /** 测的是正在用的配置还是草稿；旧面板服务没有 / Live config or draft; absent on older panel servers */
  source?: 'live' | 'draft'
}

export interface DnsTraceStep {
  stage: string
  status: string
  label: string
  detail: string | null
  elapsed_ms: number
}

export interface KixdnsUpdateNotice {
  available: boolean
  current_commit: string | null
  latest_commit: string
  source_id: number
  /** 最新版本的日期版本号，例如 2026.10.13.2。 / The newest version's date version, such as 2026.10.13.2. */
  release_tag: string
  created_at: string | null
  /** 这一版的发布页。 / This version's release page. */
  release_url: string
}

export interface PanelUpdateNotice {
  available: boolean
  current_version: string
  current_commit: string | null
  current_release: string | null
  latest_version: string | null
  published_at: string | null
  release_url: string | null
  artifact: string | null
  artifact_digest: string | null
  download_url: string | null
}

/**
 * 内核和面板的更新各查各的：一边查不到时那一边为空、原因写在旁边，另一边照常提示。
 * Kernel and panel updates are checked separately: when one cannot be read it is null
 * with the reason beside it, and the other is still offered.
 */
export interface UpdateNotifications {
  kixdns: KixdnsUpdateNotice | null
  kixdns_error: string | null
  panel: PanelUpdateNotice | null
  panel_error: string | null
}

export interface GithubRateLimit {
  limit: number
  remaining: number
  reset_at: number
}

export interface GithubTokenStatus {
  configured: boolean
  rate_limit: GithubRateLimit | null
}

export type PanelUpdateState = 'idle' | 'checking' | 'downloading' | 'complete' | 'failed'

export interface PanelUpdateStatus {
  state: PanelUpdateState
  message: string
  target_version: string
  updated_at: number
}

export interface PanelUpdateStartResponse {
  accepted: boolean
  target_version: string
}

/**
 * 远端只有 fork 发布的日期版本；Action（面板仓库按补丁集构建）和 Release（更早的正式版轨道）只出现在以前装下的内核上。
 * Only the fork's date-versioned releases are offered remotely; Action (built by the panel repository from a patchset)
 * and Release (the older release track) appear only on kernels installed earlier.
 */
export type KixdnsVersionSource = 'action' | 'release' | 'fork'

export interface RemoteKixdnsVersion {
  source: 'fork'
  source_id: number
  commit: string
  release_tag: string
  upstream_commit: string | null
  created_at: string | null
  /** 基于的原版提交。 / The upstream commit it is based on. */
  source_url: string | null
  /** 这一版的发布页。 / This version's release page. */
  build_url: string
  artifact: string
  artifact_digest: string
  download_url: string
  control_protocol: number
  config_capabilities: string[]
}

export interface InstalledKixdnsVersion {
  source: KixdnsVersionSource | null
  source_id: number | null
  commit: string
  run_id: number | null
  release_tag: string | null
  created_at: string | null
  source_url: string | null
  build_url: string | null
  artifact: string
  artifact_digest: string | null
  upstream_repository: string | null
  upstream_commit: string | null
  patchset: number | null
  dependency_revision: number | null
  control_protocol: number | null
  config_capabilities: string[]
  binary_sha256: string
  installed_at: number
  active: boolean
}

/**
 * 内核：正在用的、本机保存的上一个（可以回退），以及 fork 最新发布的版本。
 * The kernel: the one in use, the previous one kept on this host (to roll back to),
 * and the newest version the fork released.
 */
export interface KixdnsKernel {
  binary_present: boolean
  active: InstalledKixdnsVersion | null
  previous: InstalledKixdnsVersion | null
  latest: RemoteKixdnsVersion | null
  remote_error: string | null
}

export interface SetupStatus {
  required: boolean
}

export type ServiceAction = 'start' | 'stop' | 'restart'

/**
 * 查询日志：每次 DNS 查询一条，按时间倒序。面板每秒从内核取走新的查询，按小时分段存在面板所在的机器上。
 * 接口原样带着内核的字段（耗时是微秒、处理步骤是内核的说法），页面先换成下面的「显示用」记录再画。
 * The query log: one entry per DNS query, newest first. Every second the panel takes the new queries from the kernel and keeps them in
 * hourly segments on its own machine. The API carries the kernel's fields as they are (latencies in microseconds, steps in the kernel's
 * terms); the page turns them into the display records below before drawing.
 */
// forwarded 上游回的；cached / stale 缓存（新鲜 / 过期）；joined 和同一查询合并；blocked 规则拦下；answered 规则或映射直接回答；
// failed 没拿到结果；cancelled 回答之前请求就没了（客户端不等了，或者 KixDNS 停了）
// forwarded: an upstream answered; cached / stale: the cache (fresh / expired); joined: merged with the same query in flight;
// blocked: a rule stopped it; answered: a rule or mapping answered itself; failed: no result; cancelled: the request was gone before
// an answer (the client stopped waiting, or KixDNS stopped)
export type QueryLogOutcome = 'forwarded' | 'cached' | 'stale' | 'joined' | 'blocked' | 'answered' | 'failed' | 'cancelled'

/** 接口里处理过程的一步（内核的说法） / One step of the handling as the API gives it (the kernel's terms) */
export interface QueryLogStepRecord {
  /** 从请求开始累计的微秒 / Microseconds since the request started */
  at_us: number
  kind: 'pipeline' | 'rule' | 'decision' | 'cache' | 'joined' | 'upstream' | 'upstream_skipped'
  pipeline?: string
  rule?: string
  phase?: 'request' | 'response'
  /** rule（回答后检查）：条件命中了没有 / rule (an answer check): whether its condition matched */
  matched?: boolean
  decision?: 'static' | 'forward' | 'jump' | 'continue'
  /** 跳去的列表，或者转发的上游 / The list jumped to, or the upstream forwarded to */
  target?: string
  /** cache：命中（新鲜、过期）还是没命中；source 是缓存的答案原先来自哪 / cache: a hit (fresh, stale) or a miss; source is where the cached answer came from */
  result?: 'fresh' | 'stale' | 'stale_timeout' | 'stale_failure' | 'miss' | 'success' | 'rejected' | 'error' | 'aborted' | 'throttled'
  source?: string
  /** upstream_skipped：为什么这次没问它（它刚回过限速，还在暂停） / upstream_skipped: why it was not asked this time (it had just
   * answered with a rate limit and is still paused) */
  reason?: 'throttled'
  /** upstream：地址、配置的协议、实际用的协议 / upstream: the address, the configured protocol, the protocol actually used */
  upstream?: string
  transport?: string
  via?: string
  latency_us?: number
  rcode?: string
  error?: string
}

/** 接口里的一条查询 / One query as the API gives it */
export interface QueryLogRecord {
  /** 面板的编号，一直往上数 / The panel's number, always counting up */
  id: number
  seq: number
  time_unix_ms: number
  client: string
  transport?: 'udp' | 'tcp' | 'doh'
  qname: string
  qtype: string
  latency_us: number
  status: 'completed' | 'failed' | 'cancelled'
  outcome: QueryLogOutcome
  rcode?: string
  answers: string[]
  error?: string
  pipeline?: string
  rule?: string
  upstream?: string
  steps: QueryLogStepRecord[]
  steps_truncated?: boolean
}

/** 漏记的一段：面板没能从内核取到的那么多条 / A gap: that many queries the panel could not get from the kernel */
export interface QueryLogGap {
  id: number
  time_unix_ms: number
  gap: number
}

export interface QueryLogPage {
  items: Array<QueryLogRecord | QueryLogGap>
  /** 再往前取时带上的编号；没有更早的为 null / The id to read further back from; null when nothing older exists */
  next_before: number | null
  newest_id: number | null
  /** 整个日志最新一条的时间，不管筛选 / When the log's newest record was written, whatever the filter */
  newest_unix_ms: number | null
  /** 这次往前找到了哪一刻（一次最多看那么多条，没凑满一页时有用） / How far back this read got (a read looks at only so much, useful when the page is short) */
  scanned_to_unix_ms: number | null
  /** 内核支持查询日志（能力 querylog_v1）；还不知道时也算支持 / The kernel has the query log (capability querylog_v1); unknown counts as yes */
  supported: boolean
}

export interface QueryLogSettings {
  /** 保存多久（小时）：6、24、168、720、2160，或 1–8760 自己填 / How long to keep, in hours */
  retention_hours: number
  /** 最多占多少空间（字节），按磁盘上实际占的算 / The space cap in bytes, as actually used on disk */
  max_bytes: number
  /** 不记录的域名（含子域名） / Domains not recorded, subdomains included */
  ignored_domains: string[]
  used_bytes: number
  /** 能看到的最早那一刻，没有为 null / The earliest moment that can be seen, null when empty */
  oldest_unix_ms: number | null
  supported: boolean
}

/** 页面画的处理过程的一步 / One step of the handling as the page draws it */
export interface QueryLogStep {
  /** 从请求开始累计的毫秒 / Milliseconds since the request started */
  at_ms: number
  kind: 'pipeline' | 'rule' | 'cache' | 'joined' | 'upstream' | 'skipped' | 'check' | 'response'
  pipeline: string
  /** rule、check：内核里的规则名；没有规则命中、按列表的默认去处时没有 / rule, check: the kernel rule name; absent when no rule matched and the list's default applied */
  rule?: string
  /** rule：这条规则的去向（block、answer 是直接回应）；check：触发时改去哪 / rule: where it sends the request (block, answer are direct replies); check: where a match sends it */
  target?: string
  /** 转发给哪个上游（规则自己就转发时） / The upstream forwarded to (when the rule forwards itself) */
  forward?: string
  /** cache：命中（新鲜或过期）还是没命中 / cache: a hit (fresh or stale) or a miss */
  cache?: 'fresh' | 'stale' | 'miss'
  /**
   * cache 是 stale 时为什么回了过期的：过期就先回（不等上游）、上游没在等待时间内回、上游都失败了
   * Why a stale answer went back: served at once on expiry (no wait for an upstream), the upstream missed the client wait, or every
   * upstream failed
   */
  stale?: 'now' | 'timeout' | 'failure'
  /** upstream、skipped：地址和协议；cache：答案原先来自哪 / upstream, skipped: address and protocol; cache: where the answer came from */
  upstream?: string
  transport?: string
  /** upstream：先回的那个、被丢下的（别的先回了）、回了却没用的（SERVFAIL、REFUSED）、出错的、回了限速的（HTTP 429）
   * upstream: the one that answered first, one dropped because another answered first, one whose reply was not used (SERVFAIL,
   * REFUSED), one that failed, one that answered with a rate limit (HTTP 429) */
  result?: 'won' | 'lost' | 'rejected' | 'error' | 'throttled'
  rcode?: string
  latency_ms?: number
  error?: string
  /** check：触发了没有 / check: whether it matched */
  matched?: boolean
}

/** 页面画的一条查询 / One query as the page draws it */
export interface QueryLogEntry {
  id: number
  time_unix_ms: number
  client: string
  transport: 'udp' | 'tcp' | 'doh' | null
  qname: string
  qtype: string
  /** 请求最后停下的内核 Pipeline / The kernel pipeline the request finally stopped in */
  pipeline: string
  /** 决定结果的规则（内核名），没有为 null / The deciding rule (kernel name), null when none */
  rule: string | null
  outcome: QueryLogOutcome
  /** 回答来自哪个上游地址（缓存命中时是缓存的来源） / The upstream address the answer came from (for a cache hit, where the cached answer came from) */
  upstream: string | null
  /** 回给客户端的响应码；没回成时是空的 / The response code sent to the client; empty when nothing was sent */
  rcode: string
  answers: string[]
  latency_ms: number
  /** 失败时的原因 / Why it failed */
  error: string | null
  steps: QueryLogStep[]
  /** 处理过程太长，后面的没记 / The handling ran too long and the rest was not kept */
  steps_truncated: boolean
}

export type QueryLogItem = QueryLogEntry | QueryLogGap
