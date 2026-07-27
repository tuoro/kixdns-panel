<script setup lang="ts">
import { Download, Pause, Play, RefreshCw, Search } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { apiRequest } from '../api/client'
import type { LogEntry, LogsResponse } from '../api/types'
import { useToast } from '../composables/useToast'
import { errorMessage } from '../utils'

const entries = ref<LogEntry[]>([])
const query = ref('')
const level = ref('all')
const loading = ref(false)
const live = ref(true)
const toast = useToast()
let timer: number | undefined

const filtered = computed(() => entries.value.filter((entry) => {
  const matchesLevel = level.value === 'all' || (level.value === 'error' ? entry.priority <= 3 : level.value === 'warning' ? entry.priority === 4 : entry.priority >= 5)
  const needle = query.value.toLowerCase()
  return matchesLevel && (!needle || entry.message.toLowerCase().includes(needle) || entry.source.toLowerCase().includes(needle))
}))

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

async function load(silent = false): Promise<void> {
  if (!silent) loading.value = true
  try {
    entries.value = (await apiRequest<LogsResponse>('/api/v1/logs?limit=500')).entries
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    loading.value = false
  }
}

function download(): void {
  const content = filtered.value.map((entry) => `${timestamp(entry.timestamp_unix_micros)} [${label(entry.priority)}] ${entry.source}: ${entry.message}`).join('\n')
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `kixdns-${new Date().toISOString().slice(0, 10)}.log`
  anchor.click()
  URL.revokeObjectURL(url)
}

onMounted(async () => {
  await load()
  timer = window.setInterval(() => { if (live.value) void load(true) }, 5000)
})
onBeforeUnmount(() => window.clearInterval(timer))
</script>

<template>
  <div class="page logs-page">
    <section class="log-console">
      <header class="log-toolbar">
        <div class="search-field"><Search :size="16" /><input v-model="query" aria-label="筛选日志" placeholder="筛选消息或来源" /></div>
        <select v-model="level" aria-label="日志级别"><option value="all">全部级别</option><option value="error">错误</option><option value="warning">警告</option><option value="info">信息</option></select>
        <button class="button button--secondary" type="button" :class="{ 'button--active': live }" @click="live = !live"><Pause v-if="live" :size="16" /><Play v-else :size="16" />{{ live ? '实时' : '已暂停' }}</button>
        <button class="icon-button" type="button" title="刷新日志" :disabled="loading" @click="load()"><RefreshCw :size="18" :class="{ spin: loading }" /></button>
        <button class="icon-button" type="button" title="下载筛选结果" :disabled="filtered.length === 0" @click="download"><Download :size="18" /></button>
      </header>
      <div class="log-summary"><span>{{ filtered.length }} / {{ entries.length }} 条</span><span><i :class="live ? 'status-dot' : 'status-dot status-dot--muted'"></i>{{ live ? '每 5 秒刷新' : '自动刷新已暂停' }}</span></div>
      <div class="log-stream">
        <div v-for="(entry, index) in filtered" :key="`${entry.timestamp_unix_micros}-${index}`" class="log-line">
          <time>{{ timestamp(entry.timestamp_unix_micros) }}</time><span class="log-level" :class="levelClass(entry.priority)">{{ label(entry.priority) }}</span><strong>{{ entry.source }}</strong><p>{{ entry.message }}</p>
        </div>
        <p v-if="filtered.length === 0" class="empty-state">没有符合条件的日志</p>
      </div>
    </section>
  </div>
</template>
