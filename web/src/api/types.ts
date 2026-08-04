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

export interface Overview {
  health: Health
  active_config: ActiveConfig
  metrics: MetricsSnapshot
  live: boolean
  service_active: boolean | null
  captured_at_unix: number
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
  management_enabled: boolean
  available: boolean
  source: KixdnsVersionSource
  current_commit: string | null
  latest_commit: string | null
  source_id: number | null
  run_id: number | null
  release_tag: string | null
  created_at: string | null
  build_url: string | null
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
  control_protocol: number | null
  config_capabilities: string[]
  binary_sha256: string
  installed_at: number
  active: boolean
}

export interface KixdnsVersionCatalog {
  source: KixdnsVersionSource
  management_enabled: boolean
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
