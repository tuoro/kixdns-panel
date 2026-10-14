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
  active_state: string
  sub_state: string
  main_pid: number
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
 * 查询日志：每次 DNS 查询一条，按时间倒序。内核把同一个请求的几条事件串成一条交给面板，面板写进按天分的文件。
 * The query log: one entry per DNS query, newest first. The kernel joins a request's events into one record for the panel, which
 * writes it into day files.
 */
// forwarded 上游回的；cached / stale 缓存（新鲜 / 过期）；joined 和同一查询合并；blocked 规则拦下（拒绝、错误码或 0.0.0.0）；
// answered 规则或映射直接回答；failed 没拿到结果
// forwarded: an upstream answered; cached / stale: the cache (fresh / expired); joined: merged with the same query in flight;
// blocked: a rule stopped it (refusal, an error code or 0.0.0.0); answered: a rule or mapping answered itself; failed: no result
export type QueryLogOutcome = 'forwarded' | 'cached' | 'stale' | 'joined' | 'blocked' | 'answered' | 'failed'

/** 处理过程里的一步 / One step of how the query was handled */
export interface QueryLogStep {
  /** 从请求开始累计的毫秒 / Milliseconds since the request started */
  at_ms: number
  kind: 'pipeline' | 'rule' | 'cache' | 'upstream' | 'check' | 'response'
  pipeline: string
  /** rule、check：内核里的规则名 / rule, check: the kernel rule name */
  rule?: string
  /** rule：这条规则的去向；check：触发时改去哪 / rule: where it sends the request; check: where a match sends it */
  target?: string
  /** cache：命中（新鲜或过期）还是没命中 / cache: a hit (fresh or stale) or a miss */
  cache?: 'fresh' | 'stale' | 'miss'
  /** upstream：地址和协议 / upstream: address and protocol */
  upstream?: string
  transport?: string
  /** upstream：先回的那个、落后的、出错的 / upstream: the one that answered first, one that lost the race, one that failed */
  result?: 'won' | 'lost' | 'error'
  rcode?: string
  latency_ms?: number
  error?: string
  /** check：触发了没有 / check: whether it matched */
  matched?: boolean
}

export interface QueryLogEntry {
  seq: number
  time_unix_ms: number
  /** 客户端 IP；开了「只记网段」就是网段 / The client IP, or its subnet when only subnets are kept */
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
  rcode: string
  answers: string[]
  latency_ms: number
  /** 失败时的原因 / Why it failed */
  error: string | null
  steps: QueryLogStep[]
}

/** 面板没来得及从内核取走、漏记的一段 / A stretch the panel could not collect from the kernel in time */
export interface QueryLogGap {
  seq: number
  time_unix_ms: number
  gap: number
}

export type QueryLogItem = QueryLogEntry | QueryLogGap

export interface QueryLogPage {
  protocol_version: 1
  /** 内核支持查询日志（能力 querylog_v1） / The kernel supports the query log (capability querylog_v1) */
  supported: boolean
  enabled: boolean
  items: QueryLogItem[]
  /** 再往前取时带上的游标；没有更早的为 null / The cursor for older items; null when there are none */
  next_before: number | null
  newest_seq: number
}

export interface QueryLogSettings {
  enabled: boolean
  /** 保存多久（小时）：6、24、168、720、2160，或 1–8760 自己填 / How long to keep, in hours */
  retention_hours: number
  /** 最多占多少空间（字节） / The space cap, in bytes */
  max_bytes: number
  /** 客户端只记网段（IPv4 /24、IPv6 /64，和查询排行的脱敏一样） / Keep only the client's subnet (IPv4 /24, IPv6 /64, as the rankings do) */
  anonymize_clients: boolean
  /** 不记录的域名（含子域名） / Domains not recorded, subdomains included */
  ignored_domains: string[]
  used_bytes: number
  /** 最早一条的时间，没有为 null / The oldest entry's time, null when empty */
  oldest_unix_ms: number | null
}
