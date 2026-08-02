import type { Overview, ServiceStatus } from './api/types'

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
