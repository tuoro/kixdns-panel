import { describe, expect, it } from 'vitest'
import type { KixdnsVersionCatalog, ServiceStatus, ValidationResult } from './types'
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

  it('安装并切换 KixDNS 构建', async () => {
    const initial = await mockRequest<KixdnsVersionCatalog>('/api/v1/kixdns/versions?source=release')
    const latest = initial.remote_versions[0]
    expect(latest.active).toBe(false)
    expect(latest.installed).toBe(false)

    await mockRequest(`/api/v1/kixdns/versions/${latest.source}/${latest.source_id}/install`, { method: 'POST' })
    const installed = await mockRequest<KixdnsVersionCatalog>('/api/v1/kixdns/versions?source=release')
    expect(installed.active_commit).toBe(latest.commit)
    expect(installed.installed_versions.some((version) => version.commit === latest.commit)).toBe(true)

    const previous = initial.active_commit as string
    await mockRequest(`/api/v1/kixdns/versions/${previous}/activate`, { method: 'POST' })
    const switched = await mockRequest<KixdnsVersionCatalog>('/api/v1/kixdns/versions?source=release')
    expect(switched.active_commit).toBe(previous)
  })

  it('用真实构建身份区分同一上游的不同包', async () => {
    const catalog = await mockRequest<KixdnsVersionCatalog>('/api/v1/kixdns/versions?source=action')
    expect(catalog.remote_versions.map((version) => version.run_id)).toEqual([
      30361560969,
      30353958253,
      30344337649,
    ])
    expect(new Set(catalog.remote_versions.map((version) => version.commit)).size).toBe(3)
    expect(catalog.remote_versions.every((version) => /^sha256:[a-f0-9]{64}$/.test(version.artifact_digest))).toBe(true)
    expect(catalog.installed_versions.every((version) => version.commit !== version.upstream_commit)).toBe(true)
    expect(new Set(catalog.installed_versions.map((version) => version.upstream_commit))).toEqual(new Set([
      '374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25',
    ]))
    expect(new Set(catalog.installed_versions.map((version) => version.binary_sha256))).toEqual(new Set([
      'ee714ecae2d9f93e1ee8e242b1e351be4671ad53b4adc4dc3e70d20472a9c27a',
    ]))
  })

  it('在 Release 与 Action 来源间复用同一构建库存', async () => {
    const releases = await mockRequest<KixdnsVersionCatalog>('/api/v1/kixdns/versions?source=release')
    const release = releases.remote_versions[0]
    await mockRequest(`/api/v1/kixdns/versions/${release.source}/${release.source_id}/install`, { method: 'POST' })
    const actions = await mockRequest<KixdnsVersionCatalog>('/api/v1/kixdns/versions?source=action')
    expect(releases.source).toBe('release')
    expect(actions.source).toBe('action')
    expect(release.release_tag).toBe('kixdns-374d63ccfdde-p5-r1')
    expect(release.commit).toBe(actions.remote_versions[0].commit)
    expect(actions.remote_versions[0].installed).toBe(true)
  })
})
