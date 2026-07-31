<script setup lang="ts">
import { ClipboardList, Download, Pause, Play, RefreshCw, Search, Terminal } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { apiRequest } from '../api/client'
import type { AuditEvent, AuditPage, LogEntry, LogsResponse } from '../api/types'
import StatusBanner from '../components/StatusBanner.vue'
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
const activeError = computed(() => mode.value === 'runtime' ? loadError.value : auditError.value)
const activeRequesting = computed(() => mode.value === 'runtime' ? requesting.value : auditRequesting.value)
const activeCount = computed(() => mode.value === 'runtime' ? entries.value.length : auditEvents.value.length)

function label(priority: number): string {
  if (priority <= 3) return '错误'
  if (priority === 4) return '警告'
  return '信息'
}

function levelClass(priority: number): string {
  return priority <= 3 ? 'log-level--error' : priority === 4 ? 'log-level--warning' : 'log-level--info'
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
    entries.value = (await apiRequest<LogsResponse>('/api/v1/logs?limit=500')).entries
    loadError.value = ''
  })().catch((error: unknown) => {
    loadError.value = errorMessage(error)
  }).finally(() => {
    requesting.value = false
    pendingLoad = null
    loading.value = false
  })
  return pendingLoad
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

function changeAuditCategory(event: Event): void {
  auditCategory.value = (event.currentTarget as HTMLSelectElement).value
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
        <select v-model="level" aria-label="日志级别"><option value="all">全部级别</option><option value="error">错误</option><option value="warning">警告</option><option value="info">信息</option></select>
        <button class="button button--secondary" type="button" :class="{ 'button--active': live }" @click="live = !live"><Pause v-if="live" :size="16" /><Play v-else :size="16" />{{ live ? '实时' : '已暂停' }}</button>
        <button class="icon-button" type="button" title="刷新日志" :disabled="requesting" @click="load()"><RefreshCw :size="18" :class="{ spin: loading }" /></button>
        <button class="icon-button" type="button" title="下载筛选结果" :disabled="filtered.length === 0" @click="download"><Download :size="18" /></button>
      </header>
      <header v-else class="log-toolbar">
        <div class="search-field"><Search :size="16" /><input v-model="auditQuery" aria-label="筛选操作审计" placeholder="筛选操作人、动作或详情" /></div>
        <select v-model="auditCategory" aria-label="审计动作类别" :disabled="auditRequesting" @change="changeAuditCategory">
          <option value="all">全部动作</option><option value="config.">配置</option><option value="service.">服务</option><option value="kixdns.">KixDNS</option><option value="auth.">认证</option><option value="diagnostic.">诊断</option>
        </select>
        <button class="icon-button" type="button" title="刷新审计记录" :disabled="auditRequesting" @click="loadAudit()"><RefreshCw :size="18" :class="{ spin: auditLoading }" /></button>
        <button class="icon-button" type="button" title="下载筛选结果" :disabled="filteredAudit.length === 0" @click="download"><Download :size="18" /></button>
      </header>
      <div v-if="mode === 'runtime'" class="log-summary"><span>{{ filtered.length }} / {{ entries.length }} 条</span><span><i :class="live ? 'status-dot' : 'status-dot status-dot--muted'"></i>{{ live ? '每 5 秒刷新' : '自动刷新已暂停' }}</span></div>
      <div v-else class="log-summary"><span>{{ filteredAudit.length }} / {{ auditEvents.length }} 条</span><span>最多保留 10,000 条操作记录</span></div>
      <div v-if="mode === 'runtime'" class="log-stream">
        <div v-for="(entry, index) in filtered" :key="`${entry.timestamp_unix_micros}-${index}`" class="log-line">
          <time>{{ timestamp(entry.timestamp_unix_micros) }}</time><span class="log-level" :class="levelClass(entry.priority)">{{ label(entry.priority) }}</span><strong>{{ entry.source }}</strong><p>{{ entry.message }}</p>
        </div>
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
