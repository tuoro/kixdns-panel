import { describe, expect, it } from 'vitest'
import type { Overview, ServiceStatus } from './api/types'
import { dashboardRuntimeState, emptyOverview, emptyQueryStats, hasStaleDashboardData } from './dashboard-state'

const stoppedService: ServiceStatus = {
  unit: 'kixdns.service',
  active_state: 'inactive',
  sub_state: 'dead',
  main_pid: 0,
}

const liveOverview = { live: true, service_active: true } as Overview
const snapshot = { live: false, service_active: false } as Overview

describe('概览运行状态', () => {
  it('首次安装且服务未启动时不会误判为过期数据', () => {
    const state = dashboardRuntimeState(null, stoppedService)

    expect(state).toBe('stopped-empty')
    expect(hasStaleDashboardData(state)).toBe(false)
  })

  it('仅在实际存在历史快照时标记数据过期', () => {
    const state = dashboardRuntimeState(snapshot, stoppedService)

    expect(state).toBe('stopped-snapshot')
    expect(hasStaleDashboardData(state)).toBe(true)
  })

  it('保留实时与异常状态的区分', () => {
    expect(dashboardRuntimeState(liveOverview, null)).toBe('live')
    expect(dashboardRuntimeState(null, null)).toBe('unavailable')
    expect(dashboardRuntimeState({ ...snapshot, service_active: null }, null)).toBe('unavailable-snapshot')
  })

  it('为首次未启动状态提供完整但不伪造数据的展示模型', () => {
    const overview = emptyOverview()
    const stats = emptyQueryStats(86_400)

    expect(overview.live).toBe(false)
    expect(overview.metrics.requests_total).toBe(0)
    expect(overview.metrics.pipelines).toEqual([])
    expect(overview.health.upstream_commit).toBe('')
    expect(stats.enabled).toBe(true)
    expect(stats.clients).toEqual([])
    expect(stats.window_seconds).toBe(86_400)
  })
})
