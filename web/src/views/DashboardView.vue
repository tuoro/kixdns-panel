<script setup lang="ts">
import { Activity, CircleAlert, Database, Eraser, Globe2, MonitorSmartphone, RefreshCw, ShieldCheck, Timer, Zap } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { apiRequest } from '../api/client'
import type { CacheFlushResult, Overview, QueryStatsSnapshot, ServiceStatus, StatsClearResult } from '../api/types'
import StatusBanner from '../components/StatusBanner.vue'
import { useToast } from '../composables/useToast'
import { dashboardRuntimeState, hasStaleDashboardData } from '../dashboard-state'
import { errorMessage, formatDuration, formatNumber, formatPercent, shortHash } from '../utils'

const overview = ref<Overview | null>(null)
const service = ref<ServiceStatus | null>(null)
const stats = ref<QueryStatsSnapshot | null>(null)
const loading = ref(true)
const refreshing = ref(false)
const requesting = ref(false)
const flushing = ref(false)
const statsLoading = ref(false)
const statsClearing = ref(false)
const statsWindow = ref(86_400)
const overviewError = ref('')
const serviceError = ref('')
const statsError = ref('')
const toast = useToast()
let timer: number | undefined
let statsTimer: number | undefined
let pendingLoad: Promise<void> | null = null
let pendingStatsLoad: Promise<void> | null = null

const statsWindows = [
  { label: '1 小时', value: 3_600 },
  { label: '6 小时', value: 21_600 },
  { label: '24 小时', value: 86_400 },
]

const runtimeState = computed(() => dashboardRuntimeState(overview.value, service.value))
const overviewDisplayError = computed(() => runtimeState.value === 'stopped-empty' ? '' : overviewError.value)
const loadError = computed(() => [overviewDisplayError.value, serviceError.value, statsError.value].filter(Boolean).join('；'))
const statsSupported = computed(() => overview.value?.health.capabilities.includes('stats_top_v1') ?? false)
const runtimeUnavailable = computed(() => hasStaleDashboardData(runtimeState.value))
const maxClient = computed(() => Math.max(1, ...(stats.value?.clients.map((item) => item.count) ?? [])))
const maxDomain = computed(() => Math.max(1, ...(stats.value?.domains.map((item) => item.count) ?? [])))

const cacheHitRate = computed(() => {
  const metrics = overview.value?.metrics
  if (!metrics?.cache_lookups_total) return 0
  return (metrics.cache_hits_fresh + metrics.cache_hits_stale) / metrics.cache_lookups_total
})
const maxPipeline = computed(() => Math.max(1, ...(overview.value?.metrics.pipelines.map((item) => item.count) ?? [])))

function load(silent = false): Promise<void> {
  if (pendingLoad) return pendingLoad
  if (!silent) refreshing.value = true
  requesting.value = true
  pendingLoad = (async () => {
    const [overviewResult, serviceResult] = await Promise.allSettled([
      apiRequest<Overview>('/api/v1/overview'),
      apiRequest<ServiceStatus>('/api/v1/service'),
    ])
    if (overviewResult.status === 'fulfilled') {
      overview.value = overviewResult.value
      overviewError.value = ''
    } else overviewError.value = `运行数据：${errorMessage(overviewResult.reason)}`
    if (serviceResult.status === 'fulfilled') {
      service.value = serviceResult.value
      serviceError.value = ''
    } else serviceError.value = `服务状态：${errorMessage(serviceResult.reason)}`
  })().finally(() => {
    loading.value = false
    refreshing.value = false
    requesting.value = false
    pendingLoad = null
  })
  return pendingLoad
}

function loadStats(silent = false): Promise<void> {
  if (!statsSupported.value) {
    stats.value = null
    statsError.value = ''
    return Promise.resolve()
  }
  if (pendingStatsLoad) return pendingStatsLoad
  if (!silent) statsLoading.value = true
  pendingStatsLoad = apiRequest<QueryStatsSnapshot>(`/api/v1/stats/top?window=${statsWindow.value}&limit=10`)
    .then((result) => {
      stats.value = result
      statsError.value = ''
    })
    .catch((error: unknown) => {
      statsError.value = `查询排行：${errorMessage(error)}`
    })
    .finally(() => {
      statsLoading.value = false
      pendingStatsLoad = null
    })
  return pendingStatsLoad
}

async function refreshAll(): Promise<void> {
  await load()
  await loadStats()
}

async function setStatsWindow(windowSeconds: number): Promise<void> {
  if (statsWindow.value === windowSeconds) return
  statsWindow.value = windowSeconds
  await loadStats()
}

async function clearQueryStats(): Promise<void> {
  if (!window.confirm('清空全部客户端和请求域名排行？')) return
  statsClearing.value = true
  try {
    await apiRequest<StatsClearResult>('/api/v1/stats/clear', { method: 'POST' })
    toast.success('查询排行已清空')
    await loadStats(true)
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    statsClearing.value = false
  }
}

async function flushCache(): Promise<void> {
  if (!window.confirm('清空 KixDNS 响应缓存和规则缓存？')) return
  flushing.value = true
  try {
    const result = await apiRequest<CacheFlushResult>('/api/v1/cache/flush', { method: 'POST' })
    toast.success(`已清理 ${formatNumber(result.response_entries_before + result.rule_entries_before)} 个缓存条目`)
    await load(true)
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    flushing.value = false
  }
}

onMounted(async () => {
  await load()
  await loadStats()
  timer = window.setInterval(() => void load(true), 15000)
  statsTimer = window.setInterval(() => void loadStats(true), 60000)
})
onBeforeUnmount(() => {
  window.clearInterval(timer)
  window.clearInterval(statsTimer)
})
</script>

<template>
  <div class="page dashboard-page">
    <div class="page-actions">
      <div class="status-line"><span :class="service?.active_state === 'active' ? 'status-dot' : 'status-dot status-dot--danger'"></span>{{ service?.unit ?? 'kixdns.service' }} · {{ service?.sub_state ?? '读取中' }}</div>
      <button class="button button--secondary" type="button" :disabled="requesting || statsLoading" @click="refreshAll"><RefreshCw :size="16" :class="{ spin: refreshing || statsLoading }" />刷新</button>
    </div>

    <StatusBanner v-if="loadError" :message="loadError" :stale="hasStaleDashboardData(runtimeState)" :busy="requesting" @retry="load()" />
    <section v-if="!loading && runtimeState === 'stopped-empty'" class="status-banner status-banner--paused" role="status">
      <CircleAlert :size="18" />
      <div><strong>KixDNS 未启动</strong><p>当前尚无运行数据，启动 KixDNS 后概览将自动更新。</p></div>
    </section>
    <section v-if="runtimeUnavailable" class="status-banner status-banner--paused" role="status">
      <CircleAlert :size="18" />
      <div><strong>{{ runtimeState === 'stopped-snapshot' ? 'KixDNS 已停止' : '实时数据暂不可用' }}</strong><p>{{ runtimeState === 'stopped-snapshot' ? '当前显示最后一次运行快照，数据已停止更新。' : '当前显示最近一次成功快照，实时数据恢复后会自动更新。' }}</p></div>
    </section>

    <div v-if="loading" class="skeleton-grid"><span v-for="index in 4" :key="index"></span></div>
    <template v-else-if="overview">
      <section class="metric-grid" aria-label="核心指标">
        <article class="metric"><span class="metric__icon metric__icon--green"><Zap :size="19" /></span><div><small>累计请求</small><strong>{{ formatNumber(overview.metrics.requests_total) }}</strong><em>当前 {{ overview.metrics.requests_inflight }} 个并发</em></div></article>
        <article class="metric"><span class="metric__icon metric__icon--amber"><Activity :size="19" /></span><div><small>缓存命中率</small><strong>{{ formatPercent(cacheHitRate) }}</strong><em>含新鲜与过期命中</em></div></article>
        <article class="metric"><span class="metric__icon metric__icon--ink"><Database :size="19" /></span><div><small>缓存条目</small><strong>{{ formatNumber(overview.metrics.cache_entries) }}</strong><em>运行时内部条目</em></div></article>
        <article class="metric"><span class="metric__icon metric__icon--red"><Timer :size="19" /></span><div><small>持续运行</small><strong>{{ formatDuration(overview.health.uptime_seconds) }}</strong><em>PID {{ overview.health.pid }}</em></div></article>
      </section>

      <section class="dashboard-grid">
        <article class="panel panel--span-6">
          <header class="panel__header"><div><h2>Pipeline 命中</h2><p>按累计请求次数排序</p></div><span class="tag">{{ overview.metrics.pipelines.length }} 条</span></header>
          <div class="bar-list">
            <div v-for="pipeline in overview.metrics.pipelines" :key="pipeline.name" class="bar-row">
              <div><strong>{{ pipeline.name }}</strong><span>{{ formatNumber(pipeline.count) }}</span></div>
              <span class="bar-track"><i :style="{ width: `${Math.max(2, pipeline.count / maxPipeline * 100)}%` }"></i></span>
            </div>
            <p v-if="overview.metrics.pipelines.length === 0" class="empty-state">尚无 Pipeline 命中数据</p>
          </div>
        </article>

        <article class="panel panel--span-6 runtime-panel">
          <header class="panel__header"><div><h2>运行时配置</h2><p>最近一次结构化热加载</p></div><span :class="overview.active_config.last_reload.success ? 'tag tag--success' : 'tag tag--danger'">{{ overview.active_config.last_reload.success ? '生效' : '失败' }}</span></header>
          <dl class="detail-list">
            <div><dt>配置代次</dt><dd>#{{ overview.active_config.generation }}</dd></div>
            <div><dt>重载序号</dt><dd>#{{ overview.active_config.reload_sequence }}</dd></div>
            <div><dt>配置摘要</dt><dd class="mono">{{ shortHash(overview.active_config.sha256, 14) }}</dd></div>
            <div><dt>上游提交</dt><dd class="mono">{{ shortHash(overview.health.upstream_commit, 12) }}</dd></div>
            <div><dt>补丁集</dt><dd>v{{ overview.health.patchset }}</dd></div>
          </dl>
          <button class="button button--danger-quiet button--full" type="button" :disabled="flushing || runtimeUnavailable" @click="flushCache"><Eraser :size="16" />{{ flushing ? '正在清理' : '清空内部缓存' }}</button>
        </article>

        <template v-if="statsSupported">
          <div class="stats-section-heading panel--span-12">
            <div>
              <h2>查询排行</h2>
              <p v-if="stats">已观察 {{ formatNumber(stats.requests_observed) }} 次请求<span v-if="stats.dropped_updates"> · 丢弃 {{ formatNumber(stats.dropped_updates) }} 次统计更新</span></p>
              <p v-else>客户端与请求域名</p>
            </div>
            <div class="stats-section-tools">
              <div class="stats-window-tabs" role="group" aria-label="统计窗口">
                <button v-for="option in statsWindows" :key="option.value" type="button" :class="{ active: statsWindow === option.value }" :disabled="statsLoading || runtimeUnavailable" @click="setStatsWindow(option.value)">{{ option.label }}</button>
              </div>
              <button v-if="stats?.enabled" class="icon-button" type="button" title="清空查询排行" :disabled="statsClearing || runtimeUnavailable" @click="clearQueryStats"><Eraser :size="16" /></button>
            </div>
          </div>

          <template v-if="stats?.enabled">
            <article class="panel panel--span-6 ranking-panel">
              <header class="panel__header"><div><h2>客户端排行</h2><p>{{ stats.anonymized_clients ? '按脱敏网段聚合' : '按来源地址聚合' }}</p></div><MonitorSmartphone :size="18" /></header>
              <div class="ranking-list">
                <div v-for="(item, index) in stats.clients" :key="item.name" class="ranking-row">
                  <span>{{ String(index + 1).padStart(2, '0') }}</span>
                  <div><p><strong class="mono" :title="item.name">{{ item.name }}</strong><b>{{ formatNumber(item.count) }}</b></p><i><em :style="{ width: `${Math.max(2, item.count / maxClient * 100)}%` }"></em></i></div>
                </div>
                <p v-if="stats.clients.length === 0" class="empty-state">当前窗口暂无客户端数据</p>
              </div>
            </article>

            <article class="panel panel--span-6 ranking-panel ranking-panel--domain">
              <header class="panel__header"><div><h2>请求域名排行</h2><p>按查询次数降序排列</p></div><Globe2 :size="18" /></header>
              <div class="ranking-list">
                <div v-for="(item, index) in stats.domains" :key="item.name" class="ranking-row">
                  <span>{{ String(index + 1).padStart(2, '0') }}</span>
                  <div><p><strong class="mono" :title="item.name">{{ item.name }}</strong><b>{{ formatNumber(item.count) }}</b></p><i><em :style="{ width: `${Math.max(2, item.count / maxDomain * 100)}%` }"></em></i></div>
                </div>
                <p v-if="stats.domains.length === 0" class="empty-state">当前窗口暂无域名数据</p>
              </div>
            </article>
          </template>

          <article v-else-if="stats" class="panel panel--span-12 stats-disabled">
            <span><ShieldCheck :size="20" /></span>
            <div><strong>查询统计未启用</strong><p>当前没有收集客户端地址和请求域名。</p></div>
            <RouterLink class="button button--secondary" to="/config">打开配置</RouterLink>
          </article>

          <article v-else class="panel panel--span-12 ranking-loading">
            <span>{{ statsLoading ? '正在读取查询排行' : '查询排行暂不可用' }}</span>
          </article>
        </template>

        <article class="panel panel--span-12">
          <header class="panel__header"><div><h2>上游请求</h2><p>内部尝试、成功和异常计数</p></div></header>
          <div class="table-scroll"><table><thead><tr><th>上游</th><th>传输</th><th>尝试</th><th>成功率</th><th>错误</th><th>拒绝</th></tr></thead><tbody><tr v-for="item in overview.metrics.upstreams" :key="`${item.upstream}:${item.transport}`"><td class="mono table-strong">{{ item.upstream }}</td><td><span class="tag tag--muted">{{ item.transport }}</span></td><td>{{ formatNumber(item.attempts) }}</td><td>{{ formatPercent(item.attempts ? item.success / item.attempts : 0) }}</td><td :class="{ 'text-danger': item.errors > 0 }">{{ formatNumber(item.errors) }}</td><td>{{ formatNumber(item.rejected) }}</td></tr><tr v-if="overview.metrics.upstreams.length === 0"><td class="empty-state" colspan="6">尚无上游请求数据</td></tr></tbody></table></div>
        </article>

        <article class="panel panel--span-12">
          <header class="panel__header"><div><h2>规则命中</h2><p>请求与响应阶段的累计执行次数</p></div><span class="tag">{{ overview.metrics.rules.length }} 项</span></header>
          <div class="rule-grid"><div v-for="rule in overview.metrics.rules" :key="`${rule.pipeline}:${rule.phase}:${rule.rule}`"><span :class="rule.phase === 'request' ? 'phase phase--request' : 'phase phase--response'">{{ rule.phase === 'request' ? '请求' : '响应' }}</span><strong>{{ rule.rule }}</strong><small>{{ rule.pipeline }}</small><b>{{ formatNumber(rule.count) }}</b></div></div>
        </article>
      </section>
    </template>
    <section v-else class="panel empty-state">{{ runtimeState === 'stopped-empty' ? 'KixDNS 启动后将在此展示运行数据。' : '运行数据暂不可用，请检查增强控制通道。' }}</section>
  </div>
</template>
