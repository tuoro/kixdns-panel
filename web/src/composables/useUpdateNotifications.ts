import { computed, ref, watch, type Ref } from 'vue'
import type { UpdateNotifications } from '../api/types'
import { useUpdateStatus } from './useUpdateStatus'

const STORAGE_PREFIX = 'kixdns-panel:read-updates:v1:'
const MAX_READ_IDENTITIES = 64

export interface UpdateNoticeItem {
  id: string
  kind: 'kixdns' | 'panel'
  title: string
  detail: string
  meta: string
  target: string
  external: boolean
}

export function buildUpdateNotices(status: UpdateNotifications | null): UpdateNoticeItem[] {
  if (!status) return []
  const notices: UpdateNoticeItem[] = []
  const { kixdns, panel } = status
  if (kixdns?.available) {
    notices.push({
      // 已读记录按编号存：每个发布的内核包编号都不一样，新版本总是一条新提示。
      // Read state is stored by id: every released package has its own id, so a new
      // version is always a new notice.
      id: `kixdns:fork:${kixdns.source_id}`,
      kind: 'kixdns',
      title: 'KixDNS 内核',
      detail: '有新版本',
      meta: kixdns.release_tag,
      target: '/system',
      external: false,
    })
  }
  if (panel?.available) {
    notices.push({
      id: `panel:${panel.latest_version ?? 'unknown'}`,
      kind: 'panel',
      title: 'KixDNS 面板',
      detail: '有新版本',
      meta: panel.latest_version ? `v${panel.latest_version}` : '',
      target: panel.release_url ?? '/system',
      external: Boolean(panel.release_url),
    })
  }
  return notices
}

function loadReadIdentities(key: string): string[] {
  if (!key || typeof window === 'undefined') return []
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((value): value is string => typeof value === 'string' && value.length <= 160)
      .slice(-MAX_READ_IDENTITIES)
  } catch {
    return []
  }
}

export function useUpdateNotifications(username: Readonly<Ref<string>>) {
  const updates = useUpdateStatus()
  const storageKey = computed(() => username.value
    ? `${STORAGE_PREFIX}${encodeURIComponent(username.value.slice(0, 128))}`
    : '')
  const readIdentities = ref<string[]>([])
  const notices = computed(() => buildUpdateNotices(updates.status.value))
  const unreadNotices = computed(() => notices.value.filter((notice) => !readIdentities.value.includes(notice.id)))
  const unreadCount = computed(() => unreadNotices.value.length)

  function persist(next: string[]): void {
    readIdentities.value = [...new Set(next)].slice(-MAX_READ_IDENTITIES)
    if (!storageKey.value || typeof window === 'undefined') return
    try {
      window.localStorage.setItem(storageKey.value, JSON.stringify(readIdentities.value))
    } catch {
      // 浏览器禁用本地存储时，已读状态仍在当前页面会话内有效。
    }
  }

  function markRead(id: string): void {
    if (readIdentities.value.includes(id)) return
    persist([...readIdentities.value, id])
  }

  function markAllRead(): void {
    persist([...readIdentities.value, ...notices.value.map((notice) => notice.id)])
  }

  function isRead(id: string): boolean {
    return readIdentities.value.includes(id)
  }

  watch(storageKey, (key) => {
    readIdentities.value = loadReadIdentities(key)
  }, { immediate: true })

  return {
    ...updates,
    notices,
    unreadNotices,
    unreadCount,
    isRead,
    markRead,
    markAllRead,
  }
}
