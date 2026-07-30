import { describe, expect, it } from 'vitest'
import type { UpdateNotifications } from '../api/types'
import { buildUpdateNotices } from './useUpdateNotifications'

const status: UpdateNotifications = {
  kixdns: {
    management_enabled: true,
    available: true,
    source: 'action',
    current_commit: 'a'.repeat(40),
    latest_commit: 'b'.repeat(40),
    source_id: 42,
    run_id: 99,
    release_tag: null,
    created_at: '2026-07-30T00:00:00Z',
    build_url: 'https://github.com/tuoro/kixdns-panel/actions/runs/100',
  },
  panel: {
    available: true,
    current_version: '0.1.0',
    current_commit: 'c'.repeat(40),
    current_release: null,
    latest_version: '0.2.0',
    published_at: '2026-07-30T00:00:00Z',
    release_url: 'https://github.com/tuoro/kixdns-panel/releases/tag/v0.2.0',
    artifact: 'kixdns-panel-linux-x86_64.zip',
    artifact_digest: `sha256:${'d'.repeat(64)}`,
    download_url: 'https://github.com/tuoro/kixdns-panel/releases/download/v0.2.0/kixdns-panel-linux-x86_64.zip',
  },
}

describe('更新通知', () => {
  it('使用不可变版本身份区分两类通知', () => {
    const notices = buildUpdateNotices(status)
    expect(notices.map((notice) => notice.id)).toEqual(['kixdns:action:42', 'panel:0.2.0'])
    expect(notices[0]).toMatchObject({ external: false, target: '/system' })
    expect(notices[1]).toMatchObject({ external: true, meta: 'Release · v0.2.0' })
  })

  it('只展示当前仍可用的更新', () => {
    const notices = buildUpdateNotices({
      kixdns: { ...status.kixdns, available: false },
      panel: { ...status.panel, available: false },
    })
    expect(notices).toEqual([])
  })

  it('外部 KixDNS 模式不生成增强包通知', () => {
    const notices = buildUpdateNotices({
      kixdns: { ...status.kixdns, management_enabled: false, available: false },
      panel: { ...status.panel, available: false },
    })
    expect(notices).toEqual([])
  })
})
