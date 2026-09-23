import { describe, expect, it } from 'vitest'
import type { UpdateNotifications } from '../api/types'
import { buildUpdateNotices } from './useUpdateNotifications'

const status: UpdateNotifications = {
  kixdns: {
    available: true,
    source: 'action',
    current_commit: 'a'.repeat(40),
    latest_commit: 'b'.repeat(40),
    source_id: 42,
    run_id: 99,
    release_tag: null,
    created_at: '2026-07-30T00:00:00Z',
    build_url: 'https://github.com/tuoro/kixdns-panel/actions/runs/100',
    security_update: false,
    dependency_revision: null,
  },
  panel: {
    available: true,
    current_version: '1.0.0',
    current_commit: 'c'.repeat(40),
    current_release: null,
    latest_version: '1.0.1',
    published_at: '2026-07-30T00:00:00Z',
    release_url: 'https://github.com/tuoro/kixdns-panel/releases/tag/v1.0.1',
    artifact: 'kixdns-panel-linux-x86_64.zip',
    artifact_digest: `sha256:${'d'.repeat(64)}`,
    download_url: 'https://github.com/tuoro/kixdns-panel/releases/download/v1.0.1/kixdns-panel-linux-x86_64.zip',
  },
}

describe('更新通知', () => {
  it('使用不可变版本身份区分两类通知', () => {
    const notices = buildUpdateNotices(status)
    expect(notices.map((notice) => notice.id)).toEqual(['kixdns:action:42', 'panel:1.0.1'])
    expect(notices[0]).toMatchObject({ external: false, target: '/system' })
    expect(notices[1]).toMatchObject({ external: true, meta: 'Release · v1.0.1' })
  })

  it('同一版本的依赖修订提示为依赖安全升级', () => {
    const [notice] = buildUpdateNotices({
      kixdns: { ...status.kixdns, security_update: true, dependency_revision: 1 },
      panel: { ...status.panel, available: false },
    })
    expect(notice).toMatchObject({ detail: '依赖安全升级可用', meta: 'Action · Run #99 · r1' })
    expect(buildUpdateNotices(status)[0]).toMatchObject({ detail: '新的增强构建可用', meta: 'Action · Run #99' })
  })

  it('只展示当前仍可用的更新', () => {
    const notices = buildUpdateNotices({
      kixdns: { ...status.kixdns, available: false },
      panel: { ...status.panel, available: false },
    })
    expect(notices).toEqual([])
  })
})
