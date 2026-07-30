import { describe, expect, it } from 'vitest'
import type { GeoDataManifest, KixdnsVersionCatalog, ServiceStatus, UpdateNotifications, ValidationResult } from './types'
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

  it('安装并切换 KixDNS 构建', async () => {
    const initial = await mockRequest<KixdnsVersionCatalog>('/api/v1/kixdns/versions?source=release')
    const latest = initial.remote_versions[0]
    expect(latest.active).toBe(false)
    expect(latest.installed).toBe(false)

    await mockRequest(`/api/v1/kixdns/versions/${latest.source}/${latest.source_id}/install`, { method: 'POST' })
    const installed = await mockRequest<KixdnsVersionCatalog>('/api/v1/kixdns/versions?source=release')
    expect(installed.active_commit).toBe(latest.commit)
    expect(installed.active_source).toBe('release')
    expect(installed.installed_versions.some((version) => version.source === 'release' && version.commit === latest.commit)).toBe(true)

    const previous = initial.active_commit as string
    const previousSource = initial.active_source as string
    await mockRequest(`/api/v1/kixdns/versions/${previousSource}/${previous}/activate`, { method: 'POST' })
    const switched = await mockRequest<KixdnsVersionCatalog>('/api/v1/kixdns/versions?source=release')
    expect(switched.active_commit).toBe(previous)
    expect(switched.active_source).toBe(previousSource)
  })

  it('展示上游官方 Action 与增强构建的独立身份', async () => {
    const catalog = await mockRequest<KixdnsVersionCatalog>('/api/v1/kixdns/versions?source=action')
    expect(catalog.remote_versions).toHaveLength(4)
    expect(catalog.remote_versions[0].run_id).toBe(30235703570)
    expect(catalog.remote_versions[0].source_id).not.toBe(catalog.remote_versions[0].run_id)
    expect(new Set(catalog.remote_versions.map((version) => version.source_id)).size).toBe(4)
    expect(catalog.remote_versions[0].source_url).toContain('olicesx/kixdns/actions/runs/30235703570')
    expect(catalog.remote_versions[0].build_url).toContain('tuoro/kixdns-panel/actions/runs/30376438766')
    expect(catalog.remote_versions[0].artifact).toBe('kixdns-enhanced-action-30235703570-p5-10844244cec4-linux-x86_64')
    expect(catalog.remote_versions.every((version) => /^sha256:[a-f0-9]{64}$/.test(version.artifact_digest))).toBe(true)
    expect(new Set(catalog.remote_versions.map((version) => version.run_id)).size).toBe(4)
    expect(catalog.installed_versions.every((version) => version.commit !== version.upstream_commit)).toBe(true)
    expect(catalog.installed_versions.some((version) => version.upstream_commit === '374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25')).toBe(true)
  })

  it('按来源隔离相同增强提交的本地库存', async () => {
    const releases = await mockRequest<KixdnsVersionCatalog>('/api/v1/kixdns/versions?source=release')
    const release = releases.remote_versions[0]
    await mockRequest(`/api/v1/kixdns/versions/${release.source}/${release.source_id}/install`, { method: 'POST' })
    const actions = await mockRequest<KixdnsVersionCatalog>('/api/v1/kixdns/versions?source=action')
    expect(releases.source).toBe('release')
    expect(actions.source).toBe('action')
    expect(release.release_tag).toBe('v0.1.1')
    expect(release.commit).toBe(actions.remote_versions[0].commit)
    expect(actions.remote_versions[0].installed).toBe(true)
    expect(actions.remote_versions[0].active).toBe(false)
    expect(new Set(actions.installed_versions.filter((version) => version.commit === release.commit).map((version) => version.source))).toEqual(new Set(['action', 'release']))
  })

  it('删除非活动本地版本并拒绝删除当前版本', async () => {
    const before = await mockRequest<KixdnsVersionCatalog>('/api/v1/kixdns/versions?source=action')
    const removable = before.installed_versions.find((version) => !version.active)
    const active = before.installed_versions.find((version) => version.active)
    expect(removable).toBeDefined()
    expect(active).toBeDefined()

    const removableIdentity = removable?.source_id ?? removable?.commit
    await mockRequest(`/api/v1/kixdns/versions/${removable?.source ?? 'action'}/${removableIdentity}/delete`, { method: 'POST' })
    const after = await mockRequest<KixdnsVersionCatalog>('/api/v1/kixdns/versions?source=action')
    expect(after.installed_versions).toHaveLength(before.installed_versions.length - 1)
    expect(after.installed_versions.some((version) => version.source_id === removable?.source_id)).toBe(false)

    const activeIdentity = active?.source_id ?? active?.commit
    await expect(mockRequest(`/api/v1/kixdns/versions/${active?.source ?? 'action'}/${activeIdentity}/delete`, { method: 'POST' }))
      .rejects.toThrow('当前运行版本不能删除')
  })

  it('分别返回 KixDNS 与面板正式版更新', async () => {
    const updates = await mockRequest<UpdateNotifications>('/api/v1/updates/status')
    expect(updates.kixdns.available).toBe(true)
    expect(updates.kixdns.source).toBe('action')
    expect(updates.panel.available).toBe(true)
    expect(updates.panel.current_release).toBeNull()
    expect(updates.panel.latest_version).toBe('0.2.0')
    expect(updates.panel.download_url).toMatch(/releases\/download\/v0\.2\.0/)
  })
})
