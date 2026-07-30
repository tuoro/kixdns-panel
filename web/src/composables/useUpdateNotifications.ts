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
  if (status.kixdns.available) {
    const version = status.kixdns.source === 'release'
      ? status.kixdns.release_tag ?? `Release #${status.kixdns.source_id}`
      : status.kixdns.run_id ? `Run #${status.kixdns.run_id}` : `Artifact #${status.kixdns.source_id}`
    notices.push({
      id: `kixdns:${status.kixdns.source}:${status.kixdns.source_id}`,
      kind: 'kixdns',
      title: 'KixDNS 增强包',
      detail: '新的增强构建可用',
      meta: `${status.kixdns.source === 'release' ? 'Release' : 'Action'} · ${version}`,
      target: '/system',
      external: false,
    })
  }
  if (status.panel.available) {
    notices.push({
      id: `panel:${status.panel.latest_version ?? 'unknown'}`,
      kind: 'panel',
      title: 'KixDNS Panel',
      detail: '新的面板正式版可用',
      meta: status.panel.latest_version ? `Release · v${status.panel.latest_version}` : 'Release',
      target: status.panel.release_url ?? '/system',
      external: Boolean(status.panel.release_url),
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
