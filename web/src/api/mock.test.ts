import { describe, expect, it } from 'vitest'
import type {
  AuditPage,
  ConfigDocument,
  ConfigVersions,
  ConfigVersionDetail,
  DeleteConfigVersionResult,
  DeleteConfigVersionsResult,
  DnsDiagnostic,
  GeoDataCleanupResult,
  GeoDataManifest,
  GeoDataSchedule,
  KixdnsKernel,
  PanelUpdateStartResponse,
  PanelUpdateStatus,
  QueryStatsSnapshot,
  ServiceStatus,
  StatsClearResult,
  UpdateNotifications,
  ValidationResult,
} from './types'
import { mockRequest } from './mock'

describe('演示 API', () => {
  it('按服务动作更新运行状态', async () => {
    const stopped = await mockRequest<ServiceStatus>('/api/v1/service/stop', { method: 'POST' })
    expect(stopped.active_state).toBe('inactive')
    expect(stopped.main_pid).toBe(0)

    const started = await mockRequest<ServiceStatus>('/api/v1/service/start', { method: 'POST' })
    expect(started.active_state).toBe('active')
    expect(started.main_pid).toBeGreaterThan(0)
  })

  it('使用候选配置统计 Pipeline', async () => {
    const result = await mockRequest<ValidationResult>('/api/v1/config/validate', {
      method: 'POST',
      body: JSON.stringify({ pipelines: [{ id: 'default' }, { id: 'blocked' }] }),
    })
    expect(result.valid).toBe(true)
    expect(result.pipeline_count).toBe(2)
  })

  it('按窗口返回并清空查询排行', async () => {
    const ranking = await mockRequest<QueryStatsSnapshot>('/api/v1/stats/top?window=21600&limit=10')
    expect(ranking.enabled).toBe(true)
    expect(ranking.window_seconds).toBe(21_600)
    expect(ranking.clients[0]?.count).toBeGreaterThan(0)
    expect(ranking.domains[0]?.name).toBe('api.github.com')

    const cleared = await mockRequest<StatsClearResult>('/api/v1/stats/clear', { method: 'POST' })
    expect(cleared.cleared).toBe(true)
    const empty = await mockRequest<QueryStatsSnapshot>('/api/v1/stats/top?window=21600&limit=10')
    expect(empty.requests_observed).toBe(0)
    expect(empty.clients).toEqual([])
    expect(empty.domains).toEqual([])
  })

  it('返回真实规则路径形状的 DNS 诊断轨迹', async () => {
    const result = await mockRequest<DnsDiagnostic>('/api/v1/diagnostics/dns', {
      method: 'POST',
      body: JSON.stringify({ domain: 'example.com', record_type: 'A' }),
    })
    expect(result.trace_supported).toBe(true)
    expect(result.trace.some((step) => step.stage === 'rule' && step.status === 'matched')).toBe(true)
    expect(result.trace.some((step) => step.stage === 'upstream' && step.status === 'succeeded')).toBe(true)
  })

  it('同步远程 Geo 数据并返回受管路径', async () => {
    const result = await mockRequest<GeoDataManifest>('/api/v1/config/geo-data/sync', {
      method: 'POST',
      body: JSON.stringify({
        geoip_mmdb_url: 'https://example.com/country.mmdb',
        geoip_dat_url: null,
        geosite_urls: ['https://example.com/geosite.dat'],
      }),
    })
    expect(result.geoip_mmdb?.path).toMatch(/^\/var\/lib\/kixdns-panel\/geo\/geoip-mmdb-/)
    expect(result.geoip_dat).toBeNull()
    expect(result.geosite).toHaveLength(1)
    expect(result.geosite[0]?.url).toBe('https://example.com/geosite.dat')
  })

  it('保存 Geo 自动更新设置并清理旧文件', async () => {
    const scheduled = await mockRequest<GeoDataSchedule>('/api/v1/config/geo-data/schedule', {
      method: 'PUT',
      body: JSON.stringify({ interval_hours: 24 }),
    })
    expect(scheduled.interval_hours).toBe(24)
    expect(scheduled.next_run_at).not.toBeNull()

    const cleaned = await mockRequest<GeoDataCleanupResult>('/api/v1/config/geo-data/cleanup', { method: 'POST' })
    expect(cleaned.scanned_files).toBeGreaterThanOrEqual(cleaned.removed_files)
    expect(cleaned.reclaimed_bytes).toBeGreaterThan(0)
  })

  it('按游标和动作前缀读取操作审计', async () => {
    const first = await mockRequest<AuditPage>('/api/v1/audit?limit=2&action_prefix=config.')
    expect(first.events).toHaveLength(2)
    expect(first.events.every((event) => event.action.startsWith('config.'))).toBe(true)
    expect(first.next_cursor).toBe(17)

    const second = await mockRequest<AuditPage>(`/api/v1/audit?limit=2&action_prefix=config.&before_id=${first.next_cursor}`)
    expect(second.events).toHaveLength(1)
    expect(second.events[0]?.id).toBe(12)
    expect(second.next_cursor).toBeNull()
  })

  it('删除历史配置但保护当前生效版本', async () => {
    const config = await mockRequest<ConfigDocument>('/api/v1/config')
    const before = await mockRequest<ConfigVersions>('/api/v1/config/versions')
    const current = before.versions.find((version) => version.sha256 === config.sha256)
    const removable = before.versions.find((version) => version.id !== current?.id)
    expect(current).toBeDefined()
    expect(removable).toBeDefined()

    const detail = await mockRequest<ConfigVersionDetail>(`/api/v1/config/versions/${removable?.id}`)
    expect(detail.id).toBe(removable?.id)
    expect(detail.content).not.toEqual(config.content)

    await expect(mockRequest<DeleteConfigVersionResult>(`/api/v1/config/versions/${current?.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ expected_sha256: config.sha256 }),
    })).rejects.toThrow('当前生效版本不能删除')

    const deleted = await mockRequest<DeleteConfigVersionResult>(`/api/v1/config/versions/${removable?.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ expected_sha256: config.sha256 }),
    })
    expect(deleted.deleted_id).toBe(removable?.id)
    const after = await mockRequest<ConfigVersions>('/api/v1/config/versions')
    expect(after.versions.some((version) => version.id === removable?.id)).toBe(false)

    const bulkRemovable = after.versions.find((version) => version.id !== current?.id)
    expect(bulkRemovable).toBeDefined()
    await expect(mockRequest<DeleteConfigVersionsResult>('/api/v1/config/versions/bulk', {
      method: 'DELETE',
      body: JSON.stringify({
        ids: [current?.id, bulkRemovable?.id],
        expected_sha256: config.sha256,
      }),
    })).rejects.toThrow('当前生效版本不能删除')
    const afterRejectedBulk = await mockRequest<ConfigVersions>('/api/v1/config/versions')
    expect(afterRejectedBulk.versions.some((version) => version.id === bulkRemovable?.id)).toBe(true)

    const bulkDeleted = await mockRequest<DeleteConfigVersionsResult>('/api/v1/config/versions/bulk', {
      method: 'DELETE',
      body: JSON.stringify({
        ids: [bulkRemovable?.id],
        expected_sha256: config.sha256,
      }),
    })
    expect(bulkDeleted.deleted_ids).toEqual([bulkRemovable?.id])
  })

  it('更新到最新内核后能回到上一个', async () => {
    const initial = await mockRequest<KixdnsKernel>('/api/v1/kixdns/kernel')
    const latest = initial.latest
    expect(latest).not.toBeNull()
    expect(initial.active?.source_id).not.toBe(latest?.source_id)
    expect(initial.previous).not.toBeNull()

    // 只装界面上看到的那个构建：编号对不上说明上游又出了新的。
    // Only the build the page showed is installed: a different id means upstream moved on.
    await expect(mockRequest('/api/v1/kixdns/kernel/update', {
      method: 'POST',
      body: JSON.stringify({ source_id: initial.active?.source_id }),
    })).rejects.toThrow('上游又有了更新的构建')

    const updated = await mockRequest<KixdnsKernel>('/api/v1/kixdns/kernel/update', {
      method: 'POST',
      body: JSON.stringify({ source_id: latest?.source_id }),
    })
    expect(updated.active?.source_id).toBe(latest?.source_id)
    expect(updated.active?.config_capabilities).toContain('config_static_cname_response_v1')
    expect(updated.previous?.source_id).toBe(initial.active?.source_id)

    const rolledBack = await mockRequest<KixdnsKernel>('/api/v1/kixdns/kernel/rollback', { method: 'POST' })
    expect(rolledBack.active?.source_id).toBe(initial.active?.source_id)
    expect(rolledBack.previous?.source_id).toBe(latest?.source_id)
  })

  it('切换内核保持服务原来的启停状态', async () => {
    await mockRequest('/api/v1/service/stop', { method: 'POST' })
    try {
      await mockRequest('/api/v1/kixdns/kernel/rollback', { method: 'POST' })
      const stopped = await mockRequest<ServiceStatus>('/api/v1/service')
      expect(stopped.active_state).toBe('inactive')
    } finally {
      await mockRequest('/api/v1/service/start', { method: 'POST' })
    }
    await mockRequest('/api/v1/kixdns/kernel/rollback', { method: 'POST' })
    const running = await mockRequest<ServiceStatus>('/api/v1/service')
    expect(running.active_state).toBe('active')
  })

  it('展示上游官方 Action 与增强构建的独立身份', async () => {
    const kernel = await mockRequest<KixdnsKernel>('/api/v1/kixdns/kernel')
    const latest = kernel.latest
    expect(latest?.source).toBe('action')
    expect(latest?.run_id).toBe(30235703570)
    expect(latest?.source_id).not.toBe(latest?.run_id)
    expect(latest?.source_url).toContain('olicesx/kixdns/actions/runs/30235703570')
    expect(latest?.build_url).toContain('tuoro/kixdns-panel/actions/runs/30565639501')
    expect(latest?.artifact).toBe('kixdns-enhanced-action-30235703570-p8-46ac788fc96c-linux-x86_64')
    expect(latest?.artifact_digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    // 最新那个构建按演示状态还没装，所以能力要从真正装着的版本上取。
    // The newest build is not installed in the demo, so capabilities come from the one that is.
    expect(kernel.active?.config_capabilities).toContain('config_query_stats_v1')
    for (const version of [kernel.active, kernel.previous]) {
      expect(version?.commit).not.toBe(version?.upstream_commit)
    }
    expect(kernel.active?.upstream_commit).toBe('647c5b1d2af6963176d7f8da6c3ed031e6b58497')
  })

  it('分别返回 KixDNS 与面板正式版更新', async () => {
    const updates = await mockRequest<UpdateNotifications>('/api/v1/updates/status')
    expect(updates.kixdns?.available).toBe(true)
    expect(updates.kixdns_error).toBeNull()
    expect(updates.panel?.available).toBe(true)
    expect(updates.panel?.current_release).toBeNull()
    expect(updates.panel?.latest_version).toBe('1.0.1')
    expect(updates.panel?.download_url).toMatch(/releases\/download\/v1\.0\.1/)
    expect(updates.panel_error).toBeNull()
  })

  it('在面板内部启动在线更新并返回进度', async () => {
    const started = await mockRequest<PanelUpdateStartResponse>('/api/v1/panel-update', { method: 'POST' })
    const status = await mockRequest<PanelUpdateStatus>('/api/v1/panel-update')
    expect(started).toEqual({ accepted: true, target_version: 'v1.0.1' })
    expect(status).toMatchObject({ state: 'downloading', target_version: 'v1.0.1' })
  })

  it('配置和删除 GitHub Token 时不返回凭据内容', async () => {
    const saved = await mockRequest('/api/v1/settings/github-token', {
      method: 'PUT',
      body: JSON.stringify({ token: 'github_pat_example' }),
    })
    expect(saved).toMatchObject({ configured: true, rate_limit: { limit: 5_000 } })
    expect(JSON.stringify(saved)).not.toContain('github_pat_example')

    const removed = await mockRequest('/api/v1/settings/github-token', { method: 'DELETE' })
    expect(removed).toEqual({ configured: false, rate_limit: null })
  })
})
