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

export interface Overview {
  health: Health
  active_config: ActiveConfig
  metrics: MetricsSnapshot
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
}

export interface ConfigVersion {
  id: number
  sha256: string
  message: string
  actor: string
  created_at: number
}

export interface ConfigVersions {
  versions: ConfigVersion[]
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
  active_config: ActiveConfig
  validation?: ValidationResult
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

export interface RemoteKixdnsVersion {
  commit: string
  run_id: number
  created_at: string
  run_url: string
  artifact: string
  download_url: string
  installed: boolean
  active: boolean
}

export interface InstalledKixdnsVersion {
  commit: string
  run_id: number | null
  created_at: string | null
  run_url: string | null
  artifact: string
  artifact_digest: string | null
  upstream_repository: string | null
  upstream_commit: string | null
  patchset: number | null
  control_protocol: number | null
  binary_sha256: string
  installed_at: number
  active: boolean
}

export interface KixdnsVersionCatalog {
  active_commit: string | null
  binary_present: boolean
  remote_versions: RemoteKixdnsVersion[]
  installed_versions: InstalledKixdnsVersion[]
}

export interface SetupStatus {
  required: boolean
}

export type ServiceAction = 'start' | 'stop' | 'restart'
