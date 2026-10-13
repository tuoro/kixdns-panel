import { describe, expect, it } from 'vitest'
import type { KixdnsUpdateNotice, PanelUpdateNotice, UpdateNotifications } from '../api/types'
import { buildUpdateNotices } from './useUpdateNotifications'

const kixdns: KixdnsUpdateNotice = {
  available: true,
  current_commit: 'a'.repeat(40),
  latest_commit: 'b'.repeat(40),
  source_id: 42,
  release_tag: '2026.10.13.2',
  created_at: '2026-10-13T09:12:40Z',
  release_url: 'https://github.com/tuoro/kixdns/releases/tag/2026.10.13.2',
}

const panel: PanelUpdateNotice = {
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
}

const status: UpdateNotifications = { kixdns, kixdns_error: null, panel, panel_error: null }

describe('更新通知', () => {
  it('使用不可变版本身份区分两类通知', () => {
    const notices = buildUpdateNotices(status)
    expect(notices.map((notice) => notice.id)).toEqual(['kixdns:fork:42', 'panel:1.0.1'])
    expect(notices[0]).toMatchObject({ external: false, target: '/system' })
    expect(notices[1]).toMatchObject({ external: true, meta: 'v1.0.1' })
  })

  // 依赖修复也会发一个新版本，所以内核只有一种提示：有新版本，写版本号。
  // A dependency fix ships as a new version too, so the kernel has one notice: a new version, by its number.
  it('内核的新版本按日期版本提示', () => {
    expect(buildUpdateNotices(status)[0]).toMatchObject({ title: 'KixDNS 内核', detail: '有新版本', meta: '2026.10.13.2' })
  })

  it('只展示当前仍可用的更新', () => {
    const notices = buildUpdateNotices({
      ...status,
      kixdns: { ...kixdns, available: false },
      panel: { ...panel, available: false },
    })
    expect(notices).toEqual([])
  })

  // 内核查不到时面板的更新照样提示，反过来也一样。
  // The panel update is still offered when the kernel cannot be checked, and the other way round.
  it('一边检查失败不影响另一边的提示', () => {
    expect(buildUpdateNotices({ ...status, kixdns: null, kixdns_error: '没有可安装的成功增强构建' })
      .map((notice) => notice.id)).toEqual(['panel:1.0.1'])
    expect(buildUpdateNotices({ ...status, panel: null, panel_error: 'GitHub API 资源不存在' })
      .map((notice) => notice.id)).toEqual(['kixdns:fork:42'])
  })
})
