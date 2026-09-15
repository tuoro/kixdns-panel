<script setup lang="ts">
import { ClipboardList, Download, Pause, Play, RefreshCw, Search, Terminal } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { apiRequest } from '../api/client'
import type { AuditEvent, AuditPage, LogEntry, LogsResponse } from '../api/types'
import StatusBanner from '../components/StatusBanner.vue'
import { segmentLogMessage } from '../logs'
import { errorMessage } from '../utils'

const entries = ref<LogEntry[]>([])
const auditEvents = ref<AuditEvent[]>([])
const mode = ref<'runtime' | 'audit'>('runtime')
const query = ref('')
const auditQuery = ref('')
const level = ref('all')
const auditCategory = ref('all')
const loading = ref(false)
const requesting = ref(false)
const auditLoading = ref(false)
const auditRequesting = ref(false)
const live = ref(true)
const loadError = ref('')
const auditError = ref('')
const auditCursor = ref<number | null>(null)
const runtimeCursor = ref<string | null>(null)
const runtimeStream = ref<HTMLDivElement | null>(null)
const loadingOlder = ref(false)
let timer: number | undefined
let pendingLoad: Promise<void> | null = null

const filtered = computed(() => entries.value.filter((entry) => {
  const matchesLevel = level.value === 'all' || (level.value === 'error' ? entry.priority <= 3 : level.value === 'warning' ? entry.priority === 4 : entry.priority >= 5)
  const needle = query.value.toLowerCase()
  return matchesLevel && (!needle || entry.message.toLowerCase().includes(needle) || entry.source.toLowerCase().includes(needle))
}))
const filteredAudit = computed(() => {
  const needle = auditQuery.value.trim().toLowerCase()
  if (!needle) return auditEvents.value
  return auditEvents.value.filter((event) =>
    event.action.toLowerCase().includes(needle)
    || event.detail.toLowerCase().includes(needle)
    || (event.actor ?? 'system').toLowerCase().includes(needle),
  )
})
// 分段跟着筛选结果算一次；放在模板里会让每次重绘都重新切一遍正文。
const lines = computed(() => filtered.value.map((entry) => ({ entry, segments: segmentLogMessage(entry.message) })))
const activeError = computed(() => mode.value === 'runtime' ? loadError.value : auditError.value)
const activeRequesting = computed(() => mode.value === 'runtime' ? requesting.value : auditRequesting.value)
const activeCount = computed(() => mode.value === 'runtime' ? entries.value.length : auditEvents.value.length)

const auditOptions = [
  { value: 'all', label: '全部' },
  { value: 'config.', label: '配置' },
  { value: 'service.', label: '服务' },
  { value: 'kixdns.', label: 'KixDNS' },
  { value: 'auth.', label: '认证' },
  { value: 'diagnostic.', label: '诊断' },
]

const levelOptions = [
  { value: 'all', label: '全部' },
  { value: 'error', label: '错误' },
  { value: 'warning', label: '警告' },
  { value: 'info', label: '信息' },
]

function label(priority: number): string {
  if (priority <= 3) return '错误'
  if (priority === 4) return '警告'
  return '信息'
}

// 级别落在行本身：左边一条三像素色条加极淡底色。
// 徽章在密集列表里是噪音，色条能一眼扫下来。
function levelClass(priority: number): string {
  return priority <= 3 ? 'log-line--error' : priority === 4 ? 'log-line--warning' : 'log-line--info'
}

function timestamp(microseconds: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false }).format(new Date(microseconds / 1000))
}

function auditTimestamp(seconds: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(seconds * 1000))
}

function load(silent = false): Promise<void> {
  if (pendingLoad) return pendingLoad
  if (!silent) loading.value = true
  requesting.value = true
  pendingLoad = (async () => {
    const page = await apiRequest<LogsResponse>('/api/v1/logs?limit=500')
    entries.value = page.entries
    runtimeCursor.value = page.next_cursor
    loadError.value = ''
    await nextTick()
    if (runtimeStream.value) runtimeStream.value.scrollTop = 0
  })().catch((error: unknown) => {
    loadError.value = errorMessage(error)
  }).finally(() => {
    requesting.value = false
    pendingLoad = null
    loading.value = false
  })
  return pendingLoad
}

async function loadOlder(): Promise<void> {
  if (requesting.value || runtimeCursor.value === null) return
  requesting.value = true
  loadingOlder.value = true
  live.value = false
  try {
    const parameters = new URLSearchParams({
      limit: '500',
      before: runtimeCursor.value,
    })
    const page = await apiRequest<LogsResponse>(`/api/v1/logs?${parameters}`)
    entries.value = [...entries.value, ...page.entries]
    runtimeCursor.value = page.next_cursor
    loadError.value = ''
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    requesting.value = false
    loadingOlder.value = false
  }
}

function handleRuntimeScroll(event: Event): void {
  const stream = event.currentTarget as HTMLDivElement
  if (stream.scrollTop > 24 && live.value) live.value = false
  const remaining = stream.scrollHeight - stream.scrollTop - stream.clientHeight
  if (remaining <= 96 && runtimeCursor.value !== null && !requesting.value) void loadOlder()
}

function toggleLive(): void {
  if (live.value) {
    live.value = false
    return
  }
  live.value = true
  void load()
}

async function loadAudit(reset = true): Promise<void> {
  if (auditRequesting.value) return
  auditRequesting.value = true
  auditLoading.value = true
  try {
    const parameters = new URLSearchParams({ limit: '100' })
    if (!reset && auditCursor.value !== null) parameters.set('before_id', String(auditCursor.value))
    if (auditCategory.value !== 'all') parameters.set('action_prefix', auditCategory.value)
    const page = await apiRequest<AuditPage>(`/api/v1/audit?${parameters}`)
    auditEvents.value = reset ? page.events : [...auditEvents.value, ...page.events]
    auditCursor.value = page.next_cursor
    auditError.value = ''
  } catch (error) {
    auditError.value = errorMessage(error)
  } finally {
    auditRequesting.value = false
    auditLoading.value = false
  }
}

function switchMode(next: 'runtime' | 'audit'): void {
  mode.value = next
  if (next === 'audit' && auditEvents.value.length === 0) void loadAudit()
}

function selectAuditCategory(value: string): void {
  if (auditCategory.value === value) return
  auditCategory.value = value
  void loadAudit()
}

function retry(): void {
  if (mode.value === 'runtime') void load()
  else void loadAudit()
}

function download(): void {
  const content = mode.value === 'runtime'
    ? filtered.value.map((entry) => `${timestamp(entry.timestamp_unix_micros)} [${label(entry.priority)}] ${entry.source}: ${entry.message}`).join('\n')
    : filteredAudit.value.map((event) => `${auditTimestamp(event.created_at)} [${event.actor ?? 'system'}] ${event.action}: ${event.detail}`).join('\n')
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `kixdns-${mode.value}-${new Date().toISOString().slice(0, 10)}.log`
  anchor.click()
  URL.revokeObjectURL(url)
}

onMounted(async () => {
  await load()
  timer = window.setInterval(() => { if (mode.value === 'runtime' && live.value) void load(true) }, 5000)
})
onBeforeUnmount(() => window.clearInterval(timer))
</script>

<template>
  <div class="page logs-page">
    <StatusBanner v-if="activeError" :message="activeError" :stale="activeCount > 0" :busy="activeRequesting" @retry="retry" />
    <section class="log-console">
      <nav class="log-view-tabs" aria-label="日志视图">
        <button type="button" :class="{ active: mode === 'runtime' }" @click="switchMode('runtime')"><Terminal :size="14" />运行日志</button>
        <button type="button" :class="{ active: mode === 'audit' }" @click="switchMode('audit')"><ClipboardList :size="14" />操作审计</button>
      </nav>
      <header v-if="mode === 'runtime'" class="log-toolbar">
        <div class="search-field"><Search :size="16" /><input v-model="query" aria-label="筛选日志" placeholder="筛选消息或来源" /></div>
        <div class="log-seg" role="group" aria-label="日志级别">
          <button v-for="option in levelOptions" :key="option.value" type="button" :class="{ 'is-on': level === option.value }" :aria-pressed="level === option.value" @click="level = option.value">{{ option.label }}</button>
        </div>
        <!-- 运行日志没有单独的刷新键。实时开着时它每 5 秒就刷一次，按一下最多早
             拿到 5 秒的日志；实时停着时按它更糟——load() 会丢掉已经翻出来的历史、
             把视图弹回顶部，却不恢复实时，等于把你正在读的位置作废还什么也没换来。
             要最新的就按「已暂停」恢复实时，那一下本来就会立刻取一次。

             The runtime log has no separate refresh. With live on it already
             refreshes every five seconds, so pressing it buys at most five
             seconds; with live off it is worse than useless — load() discards
             the history paged in, snaps the view back to the top and does not
             resume live, throwing away the reader's place for nothing. Resuming
             live is the way to get the newest lines, and it fetches at once. -->
        <button class="button button--secondary" type="button" :class="{ 'button--active': live }" :disabled="requesting" @click="toggleLive"><Pause v-if="live" :size="16" /><Play v-else :size="16" />{{ live ? '实时' : '已暂停' }}</button>
        <button class="icon-button" type="button" title="下载筛选结果" :disabled="filtered.length === 0" @click="download"><Download :size="18" /></button>
      </header>
      <header v-else class="log-toolbar">
        <div class="search-field"><Search :size="16" /><input v-model="auditQuery" aria-label="筛选操作审计" placeholder="筛选操作人、动作或详情" /></div>
        <div class="log-seg" role="group" aria-label="审计动作类别">
          <button v-for="option in auditOptions" :key="option.value" type="button" :class="{ 'is-on': auditCategory === option.value }" :aria-pressed="auditCategory === option.value" :disabled="auditRequesting" @click="selectAuditCategory(option.value)">{{ option.label }}</button>
        </div>
        <button class="icon-button" type="button" title="刷新审计记录" :disabled="auditRequesting" @click="loadAudit()"><RefreshCw :size="18" :class="{ spin: auditLoading }" /></button>
        <button class="icon-button" type="button" title="下载筛选结果" :disabled="filteredAudit.length === 0" @click="download"><Download :size="18" /></button>
      </header>
      <div v-if="mode === 'runtime'" class="log-summary"><span>{{ filtered.length }} / {{ entries.length }} 条{{ runtimeCursor !== null ? '，向下滚动加载更早日志' : '' }}</span><span><i :class="live ? 'status-dot' : 'status-dot status-dot--muted'"></i>{{ live ? '最新日志在顶部，每 5 秒刷新' : '浏览历史时自动暂停' }}</span></div>
      <div v-else class="log-summary"><span>{{ filteredAudit.length }} / {{ auditEvents.length }} 条</span><span>最多保留 10,000 条操作记录</span></div>
      <div v-if="mode === 'runtime'" ref="runtimeStream" class="log-stream" @scroll="handleRuntimeScroll">
        <div v-for="({ entry, segments }, index) in lines" :key="`${entry.timestamp_unix_micros}-${index}`" class="log-line" :class="levelClass(entry.priority)">
          <time>{{ timestamp(entry.timestamp_unix_micros) }}</time>
          <span class="log-sr-only">{{ label(entry.priority) }}</span>
          <strong>{{ entry.source }}</strong>
          <p><template v-for="(segment, part) in segments" :key="part"><em v-if="segment.strong">{{ segment.text }}</em><template v-else>{{ segment.text }}</template></template></p>
        </div>
        <button v-if="runtimeCursor !== null" class="runtime-load-more" type="button" :disabled="requesting" @click="loadOlder"><RefreshCw :size="14" :class="{ spin: loadingOlder }" />{{ loadingOlder ? '正在加载' : '加载更早日志' }}</button>
        <p v-if="filtered.length === 0 && !loadError" class="empty-state">没有符合条件的日志</p>
      </div>
      <div v-else class="log-stream">
        <div v-for="event in filteredAudit" :key="event.id" class="log-line audit-line">
          <time>{{ auditTimestamp(event.created_at) }}</time><strong>{{ event.actor ?? 'system' }}</strong><code>{{ event.action }}</code><p>{{ event.detail }}</p>
        </div>
        <button v-if="auditCursor !== null && !auditQuery" class="audit-load-more" type="button" :disabled="auditRequesting" @click="loadAudit(false)"><RefreshCw :size="14" :class="{ spin: auditLoading }" />加载更多</button>
        <p v-if="filteredAudit.length === 0 && !auditError" class="empty-state">没有符合条件的审计记录</p>
      </div>
    </section>
  </div>
</template>
