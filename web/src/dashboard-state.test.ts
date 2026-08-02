import { describe, expect, it } from 'vitest'
import type { Overview, ServiceStatus } from './api/types'
import { dashboardRuntimeState, hasStaleDashboardData } from './dashboard-state'

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
})
