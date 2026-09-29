import type { Overview, QueryStatsSnapshot, ServiceStatus } from './api/types'

export type DashboardRuntimeState =
  | 'live'
  | 'stopped-empty'
  | 'stopped-snapshot'
  | 'unavailable-snapshot'
  | 'unavailable'

function serviceStopped(overview: Overview | null, service: ServiceStatus | null): boolean {
  return service?.active_state === 'inactive' || overview?.service_active === false
}

// 启动失败、正在启动、正在停止：服务没在正常运行，读不到数据是因为它，不是面板和内核之间断了
// Failed, starting or stopping: the service is not running normally, which is why there is no data — not a broken link to the kernel
function serviceNotRunning(service: ServiceStatus | null): boolean {
  return ['failed', 'activating', 'deactivating'].includes(service?.active_state ?? '')
}

export function dashboardRuntimeState(
  overview: Overview | null,
  service: ServiceStatus | null,
): DashboardRuntimeState {
  if (overview?.live) return 'live'
  // 没有任何数据时，服务没在正常运行也按「未运行」保留完整布局（同首次安装），而不是只剩一条读取失败
  // With no data at all, a service that is not running normally keeps the full layout as never-run (as on first install), not a lone read error
  if (!overview) return serviceStopped(overview, service) || serviceNotRunning(service) ? 'stopped-empty' : 'unavailable'
  return serviceStopped(overview, service) ? 'stopped-snapshot' : 'unavailable-snapshot'
}

export function hasStaleDashboardData(state: DashboardRuntimeState): boolean {
  return state === 'stopped-snapshot' || state === 'unavailable-snapshot'
}

export function supportsQueryStats(capabilities: string[]): boolean {
  return capabilities.includes('stats_top_v1')
}

/** 增强版 p21 起上报竞争落败、耗时等序列；没有它时上游成功率与健康判定不可信。 */
export function supportsUpstreamPrecision(capabilities: string[]): boolean {
  return capabilities.includes('metrics_upstream_precision_v1')
}

export function emptyOverview(): Overview {
  return {
    live: false,
    service_active: false,
    captured_at_unix: 0,
    // 空态不补零点：一条全是 0 的曲线会被读成「那段时间没有请求」，
    // 而这里的实情是还没有采到任何数据。
    trend: { bucket_seconds: 3600, points: [], total: 0 },
    health: {
      protocol_version: 0,
      status: 'stopped',
      pid: 0,
      version: '',
      upstream_commit: '',
      patchset: '',
      started_at_unix: 0,
      uptime_seconds: 0,
      config_generation: 0,
      capabilities: [],
    },
    active_config: {
      protocol_version: 0,
      generation: 0,
      sha256: '',
      loaded_at_unix: 0,
      reload_sequence: 0,
      last_reload: { success: false, error: null },
    },
    metrics: {
      requests_total: 0,
      requests_inflight: 0,
      cache_lookups_total: 0,
      cache_hits_fresh: 0,
      cache_hits_stale: 0,
      cache_entries: 0,
      config_generation: 0,
      reload_success: 0,
      reload_failure: 0,
      pipelines: [],
      rules: [],
      upstreams: [],
      requests_finished: { completed: 0, failed: 0, cancelled: 0 },
      request_latency: { samples: 0, avg_ms: 0, within_10ms: 0, within_100ms: 0, within_1s: 0 },
      request_latency_recent: null,
      cache_stale: { expired: 0, client_timeout: 0, upstream_failure: 0 },
      recent_window_seconds: null,
    },
  }
}

export function emptyQueryStats(windowSeconds: number): QueryStatsSnapshot {
  return {
    protocol_version: 0,
    enabled: true,
    anonymized_clients: false,
    window_seconds: windowSeconds,
    retention_seconds: windowSeconds,
    generated_at_unix: 0,
    requests_observed: 0,
    dropped_updates: 0,
    clients: [],
    domains: [],
    live: false,
    captured_at_unix: null,
  }
}
