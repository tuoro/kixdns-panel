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

export function dashboardRuntimeState(
  overview: Overview | null,
  service: ServiceStatus | null,
): DashboardRuntimeState {
  if (overview?.live) return 'live'
  if (!overview) return serviceStopped(overview, service) ? 'stopped-empty' : 'unavailable'
  return serviceStopped(overview, service) ? 'stopped-snapshot' : 'unavailable-snapshot'
}

export function hasStaleDashboardData(state: DashboardRuntimeState): boolean {
  return state === 'stopped-snapshot' || state === 'unavailable-snapshot'
}

export function emptyOverview(): Overview {
  return {
    live: false,
    service_active: false,
    captured_at_unix: 0,
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
