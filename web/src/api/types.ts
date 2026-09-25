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
  /** 运行配置的过期缓存策略；找不到内核正在运行的那份配置时为 null。 */
  stale_policy: StalePolicy | null
}

/** 服务过期响应开没开，以及客户端等待多少毫秒：决定哪几种续用旧结果可能出现。 */
export interface StalePolicy {
  enabled: boolean
  client_timeout_ms: number
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
}

export interface DnsTraceStep {
  stage: string
  status: string
  label: string
  detail: string | null
  elapsed_ms: number
}

export interface UpdateInfo {
  installed_commit: string | null
  latest_commit: string
  run_id: number
  created_at: string
  run_url: string
  artifact: string
  artifact_digest: string
  download_url: string
  available: boolean
}

export interface KixdnsUpdateNotice {
  available: boolean
  source: KixdnsVersionSource
  current_commit: string | null
  latest_commit: string | null
  source_id: number | null
  run_id: number | null
  release_tag: string | null
  created_at: string | null
  build_url: string | null
  /** 同一版本换上修补过的依赖重新构建。 / The same version rebuilt with patched dependencies. */
  security_update: boolean
  dependency_revision: number | null
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

export interface UpdateNotifications {
  kixdns: KixdnsUpdateNotice
  panel: PanelUpdateNotice
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

export type KixdnsVersionSource = 'action' | 'release'

export interface RemoteKixdnsVersion {
  source: KixdnsVersionSource
  source_id: number
  commit: string
  run_id: number | null
  release_tag: string | null
  patchset: number | null
  created_at: string
  source_url: string
  build_url: string
  artifact: string
  artifact_digest: string
  download_url: string
  installed: boolean
  active: boolean
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

export interface KixdnsVersionCatalog {
  source: KixdnsVersionSource
  active_source: KixdnsVersionSource | null
  active_commit: string | null
  binary_present: boolean
  remote_error: string | null
  remote_versions: RemoteKixdnsVersion[]
  installed_versions: InstalledKixdnsVersion[]
}

export interface SetupStatus {
  required: boolean
}

export type ServiceAction = 'start' | 'stop' | 'restart'
