<script setup lang="ts">
import { ArrowUpRight, ChevronRight, CircleAlert, Eraser, RefreshCw } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { apiRequest } from '../api/client'
import type { CacheFlushResult, Overview, QueryStatsSnapshot, ServiceStatus, StatsClearResult } from '../api/types'
import StatusBanner from '../components/StatusBanner.vue'
import { useToast } from '../composables/useToast'
import { HEALTH_LABELS, MIN_HEALTH_SAMPLES, cacheComposition, pipelineDistribution, rcodeDistribution, settledAttempts, upstreamHealth } from '../dashboard-presentation'
import type { UpstreamHealth } from '../dashboard-presentation'
import { dashboardRuntimeState, emptyOverview, emptyQueryStats, hasStaleDashboardData, supportsQueryStats, supportsUpstreamPrecision } from '../dashboard-state'
import { sparkline } from '../trend'
import { errorMessage, formatDuration, formatNumber, formatPercent, formatSmallPercent, shortHash, upstreamSuccessRate } from '../utils'

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
const activeView = ref('runtime')
const views = [
  { id: 'runtime', label: '运行情况' },
  { id: 'stats', label: '查询排行' },
  { id: 'rules', label: '规则命中' },
]
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
const statsSupported = computed(() => supportsQueryStats(overview.value?.health.capabilities ?? []))
const runtimeUnavailable = computed(() => hasStaleDashboardData(runtimeState.value))
const runtimeControlsDisabled = computed(() => runtimeState.value !== 'live')
const displayOverview = computed(() => overview.value ?? (runtimeState.value === 'stopped-empty' ? emptyOverview() : null))
const showStatsSection = computed(() => statsSupported.value || runtimeState.value === 'stopped-empty')
const displayStats = computed(() => stats.value ?? (runtimeState.value === 'stopped-empty' ? emptyQueryStats(statsWindow.value) : null))
const maxClient = computed(() => Math.max(1, ...(stats.value?.clients.map((item) => item.count) ?? [])))
const maxDomain = computed(() => Math.max(1, ...(stats.value?.domains.map((item) => item.count) ?? [])))

const cacheHitRate = computed(() => {
  const metrics = displayOverview.value?.metrics
  if (!metrics?.cache_lookups_total) return 0
  return (metrics.cache_hits_fresh + metrics.cache_hits_stale) / metrics.cache_lookups_total
})
const pipelines = computed(() => pipelineDistribution(displayOverview.value?.metrics.pipelines ?? []))
const finishedTotal = computed(() => {
  const finished = displayOverview.value?.metrics.requests_finished
  return finished ? finished.completed + finished.failed + finished.cancelled : 0
})
const finishedShare = (value: number) => (finishedTotal.value ? value / finishedTotal.value : 0)
const latencyKnown = computed(() => (displayOverview.value?.metrics.request_latency.samples ?? 0) > 0)
const within100Share = computed(() => {
  const latency = displayOverview.value?.metrics.request_latency
  return latency?.samples ? latency.within_100ms / latency.samples : 0
})
const latencyHealth = computed<UpstreamHealth>(() => (within100Share.value >= 0.95 ? 'healthy' : within100Share.value >= 0.8 ? 'degraded' : 'unhealthy'))
const staleShare = computed(() => {
  const metrics = displayOverview.value?.metrics
  const hits = metrics ? metrics.cache_hits_fresh + metrics.cache_hits_stale : 0
  return hits ? metrics!.cache_hits_stale / hits : 0
})
const precisionSupported = computed(() => supportsUpstreamPrecision(displayOverview.value?.health.capabilities ?? []))
const upstreamRows = computed(() => [...(displayOverview.value?.metrics.upstreams ?? [])]
  .map((item) => ({ ...item, settled: settledAttempts(item), health: precisionSupported.value ? upstreamHealth(item) : 'pending' as UpstreamHealth }))
  .sort((left, right) => right.settled - left.settled))
const healthCounts = computed(() => {
  const counts = { pending: 0, healthy: 0, degraded: 0, unhealthy: 0 }
  for (const item of upstreamRows.value) counts[item.health] += 1
  return counts
})
const assessedUpstreams = computed(() => upstreamRows.value.length - healthCounts.value.pending)
const healthSummary = computed(() => {
  const parts: string[] = []
  if (healthCounts.value.degraded) parts.push(`${healthCounts.value.degraded} 个降级`)
  if (healthCounts.value.unhealthy) parts.push(`${healthCounts.value.unhealthy} 个异常`)
  return parts.join(' · ')
})
const overallHealth = computed<UpstreamHealth>(() => (healthCounts.value.unhealthy ? 'unhealthy' : healthCounts.value.degraded ? 'degraded' : 'healthy'))
const rcodes = computed(() => rcodeDistribution(displayOverview.value?.metrics.upstreams ?? []))
const cacheRows = computed(() => (displayOverview.value ? cacheComposition(displayOverview.value.metrics) : []))
function formatLatency(value: number | null): string {
  return value === null ? '—' : `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`
}
function fallbackShare(item: { transport: string; settled: number; tcp_fallbacks: number }): string {
  return item.transport === 'udp' && item.settled > 0 ? formatPercent(item.tcp_fallbacks / item.settled) : '—'
}
const rankingGroups = [
  {
    id: 'clients', title: '客户端排行',
    description: '按来源地址聚合',
  },
  {
    id: 'domains', title: '请求域名排行', description: '按查询次数降序排列',
  },
] as const
const configStateLabel = computed(() => {
  if (!overview.value) return '未运行'
  if (runtimeUnavailable.value) return '运行快照'
  return overview.value.active_config.last_reload.success ? '已生效' : '重载失败'
})

function moveViewFocus(event: KeyboardEvent, index: number): void {
  let next = index
  if (event.key === 'ArrowRight') next = (index + 1) % views.length
  else if (event.key === 'ArrowLeft') next = (index + views.length - 1) % views.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = views.length - 1
  else return
  event.preventDefault()
  activeView.value = views[next]!.id
  const tab = event.currentTarget as HTMLButtonElement
  tab.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
}

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

const expandedUpstream = ref<string | null>(null)
const upstreamKey = (item: { upstream: string; transport: string }) => `${item.upstream}:${item.transport}`
function toggleUpstream(item: { upstream: string; transport: string }): void {
  expandedUpstream.value = expandedUpstream.value === upstreamKey(item) ? null : upstreamKey(item)
}

const SPARK_WIDTH = 260
const SPARK_HEIGHT = 74

/**
 * 采样覆盖多久就说多久。写死「近 24 小时」而实际只攒了三小时，
 * 是把「还没攒够」说成了「这就是一天的量」。
 *
 * The label states the period the samples actually cover. Writing "last 24
 * hours" while only three hours have been collected would present "not enough
 * data yet" as a full day's volume.
 */
const trendLabel = computed(() => {
  const trend = displayOverview.value?.trend
  if (!trend || trend.points.length === 0) return '请求总数'
  const hours = Math.round((trend.points.length * (trend.bucket_seconds || 3600)) / 3600)
  return hours >= 24 ? '近 24 小时请求' : `近 ${hours} 小时请求`
})

const spark = computed(() => {
  const points = displayOverview.value?.trend.points ?? []
  // 一个点连不成线，交回 null 让模板去说明原因。
  if (points.length < 2) return null
  return sparkline(points.map((point) => point.requests), SPARK_WIDTH, SPARK_HEIGHT)
})

/**
 * 信号带上的大数字：有趋势就报趋势覆盖的那段，没有就退回累计总数。
 * 两者含义不同，所以标题跟着一起换。
 */
const signalTotal = computed(() => {
  const trend = displayOverview.value?.trend
  if (trend && trend.points.length > 0) return trend.total
  return displayOverview.value?.metrics.requests_total ?? null
})

/**
 * 信号带把这个数字独占一行，375 宽下十位数实测 137px、可用 311px，
 * 所以不再缩写成万/亿。缩写是为旧版那种两列窄卡加的，版式一变就成了多余的一层
 * 转换——读者拿到的应该是配置和日志里能对得上的那个数。
 *
 * The signal band gives this figure a line of its own: at 375 a ten-digit
 * number measures 137px against 311px available, so it is no longer abbreviated.
 * The abbreviation existed for the old two-up narrow cards; with that layout
 * gone it is a conversion standing between the reader and the number they can
 * match against the config and the logs.
 */
const compactTotal = computed(() => {
  const total = signalTotal.value
  return total == null ? '--' : formatNumber(total)
})

/** 兜底次数占请求总数的比例；请求数为 0 时不显示，避免除以零后写出 0.0% */
const fallbackOfRequests = computed(() => {
  const metrics = displayOverview.value?.metrics
  if (!metrics?.requests_total) return ''
  return formatSmallPercent(metrics.cache_stale.upstream_failure / metrics.requests_total)
})

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
  <div class="page overview-page">
    <header class="page-heading overview-heading">
      <div>
        <h1>运行概览</h1>
        <p class="overview-heading-context">{{ service?.unit ?? 'kixdns.service' }} · {{ service?.sub_state ?? '读取中' }}</p>
      </div>
      <button class="overview-button" type="button" :disabled="requesting || statsLoading" @click="refreshAll">
        <RefreshCw :size="16" :class="{ spin: refreshing || statsLoading }" /><span>刷新</span>
      </button>
    </header>

    <StatusBanner v-if="loadError" class="overview-notice" :message="loadError" :stale="hasStaleDashboardData(runtimeState)" :busy="requesting || statsLoading" @retry="refreshAll" />
    <section v-if="!loading && runtimeState === 'stopped-empty'" class="overview-notice overview-notice--paused" role="status">
      <CircleAlert :size="18" />
      <div><strong>KixDNS 未启动</strong><p>当前尚无运行数据，启动 KixDNS 后概览将自动更新。</p></div>
    </section>
    <section v-if="runtimeUnavailable" class="overview-notice overview-notice--paused" role="status">
      <CircleAlert :size="18" />
      <div>
        <strong>{{ runtimeState === 'stopped-snapshot' ? 'KixDNS 已停止' : '实时数据暂不可用' }}</strong>
        <p>{{ runtimeState === 'stopped-snapshot' ? '当前显示最后一次运行快照，数据已停止更新。' : '当前显示最近一次成功快照，实时数据恢复后会自动更新。' }}</p>
      </div>
    </section>

    <div class="overview-tabs" role="tablist" aria-label="概览视图">
      <button v-for="(view, index) in views" :id="`overview-tab-${view.id}`" :key="view.id" type="button" role="tab"
        :aria-selected="activeView === view.id" :aria-controls="`overview-panel-${view.id}`" :tabindex="activeView === view.id ? 0 : -1"
        @click="activeView = view.id" @keydown="moveViewFocus($event, index)">{{ view.label }}</button>
    </div>

    <div v-if="loading" class="overview-loading" role="status">正在读取运行数据…</div>
    <template v-else-if="displayOverview">
      <section id="overview-panel-runtime" v-show="activeView === 'runtime'" class="overview-view" role="tabpanel" aria-labelledby="overview-tab-runtime" tabindex="0">
        <!-- 最重要的数字独占一处并带趋势，其余三项降为平级。
             四张等宽卡片让读者自己找重点，而这页第一眼该回答的只有一个问题：
             在变好还是变坏。 -->
        <section class="overview-signal" aria-label="请求量">
          <div class="overview-signal-main">
            <span class="overview-signal-label">{{ trendLabel }}</span>
            <strong class="overview-total-value">{{ compactTotal }}</strong>
            <span class="overview-signal-sub">
              <span v-if="finishedTotal">完成 <b>{{ formatPercent(finishedShare(displayOverview.metrics.requests_finished.completed)) }}</b></span>
              <span v-if="latencyKnown">平均 <b>{{ Math.round(displayOverview.metrics.request_latency.avg_ms) }} ms</b></span>
              <span v-if="latencyKnown"><i class="overview-dot" :class="`overview-dot--${latencyHealth}`" aria-hidden="true"></i><b>{{ formatPercent(within100Share) }}</b> 在 100 ms 内返回</span>
              <span>持续运行 {{ overview ? formatDuration(displayOverview.health.uptime_seconds) : '--' }}</span>
            </span>
          </div>
          <svg v-if="spark" class="overview-spark" :viewBox="`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`" preserveAspectRatio="none" role="img" :aria-label="trendLabel + '趋势'">
            <path class="overview-spark-area" :d="spark.area" />
            <path class="overview-spark-line" :d="spark.line" />
            <circle class="overview-spark-end" :cx="spark.lastX" :cy="spark.lastY" r="3" />
          </svg>
          <!-- 采样不足两点时画不出趋势。说清楚是「还没攒够」，不是「没有流量」。 -->
          <p v-else class="overview-spark-pending">趋势需要至少两次采样，面板每分钟采一次</p>
        </section>

        <section class="overview-stats-row" aria-label="运行统计">
          <article class="overview-stat">
            <span class="overview-stat-label" title="未过期的命中与续用旧结果都算命中">缓存命中率</span>
            <strong class="overview-kpi-value">{{ formatPercent(cacheHitRate) }}</strong>
            <span class="overview-stat-note">{{ formatNumber(displayOverview.metrics.cache_entries) }} 条缓存<template v-if="staleShare"> · 续用旧结果 {{ formatPercent(staleShare) }}</template></span>
          </article>
          <article class="overview-stat">
            <span class="overview-stat-label">上游健康</span>
            <template v-if="precisionSupported">
              <span class="overview-kpi-value-row">
                <strong class="overview-kpi-value">{{ healthCounts.healthy }}</strong>
                <span class="overview-kpi-unit">/ {{ assessedUpstreams }}</span>
              </span>
              <span class="overview-stat-note"><b v-if="healthSummary" :class="`overview-text--${overallHealth}`">{{ healthSummary }}</b><template v-if="healthSummary"> · </template>成功率 ≥ 99% 且平均耗时 &lt; 1 s 记为健康</span>
              <span v-if="healthCounts.pending" class="overview-stat-note">{{ healthCounts.pending }} 个上游观察中，响应不足 {{ MIN_HEALTH_SAMPLES }} 次</span>
            </template>
            <template v-else>
              <strong class="overview-kpi-value">—</strong>
              <span class="overview-stat-note">当前增强版不提供健康判定所需数据，更新增强版后显示</span>
            </template>
          </article>
          <article class="overview-stat">
            <span class="overview-stat-label">兜底使用</span>
            <span class="overview-kpi-value-row">
              <strong class="overview-kpi-value">{{ formatNumber(displayOverview.metrics.cache_stale.upstream_failure) }}</strong>
              <span class="overview-kpi-unit">次</span>
            </span>
            <span class="overview-stat-note">上游失败后返回旧缓存<template v-if="fallbackOfRequests"> · 占请求 {{ fallbackOfRequests }}</template></span>
          </article>
        </section>

        <!-- 主项做大、小项列表。90% 对 9% 这种分布用堆叠条读不出任何信息，
             而且给每一段配一个颜色会把绿色用成装饰——绿在这个面板里只表示健康。
             A leading figure with the rest as a list. A 90/9 split tells you
             nothing as a stacked bar, and colouring each segment spends green
             on decoration when green here means only "healthy". -->
        <section class="overview-section overview-distribution" aria-labelledby="overview-distribution-heading">
          <header class="overview-section-heading"><h2 id="overview-distribution-heading">请求分布</h2><p>按 Pipeline 累计命中</p></header>
          <template v-if="pipelines.length">
            <p class="overview-dist-main"><span class="overview-dist-share">{{ formatPercent(pipelines[0].share) }}</span><span class="overview-dist-name">{{ pipelines[0].name }}</span><span class="overview-dist-count">{{ formatNumber(pipelines[0].count) }} 次</span></p>
            <ul class="overview-pipeline-list" aria-label="Pipeline 命中分布">
              <li v-for="pipeline in pipelines.slice(1)" :key="pipeline.name">
                <span class="overview-pipeline-name"><strong>{{ pipeline.name }}</strong></span>
                <span class="overview-pipeline-count">{{ formatNumber(pipeline.count) }}</span>
                <span class="overview-pipeline-share">{{ formatPercent(pipeline.share) }}</span>
              </li>
            </ul>
          </template>
          <p v-else class="overview-empty">尚无 Pipeline 命中数据</p>
        </section>

        <section class="overview-section" aria-labelledby="overview-upstream-heading">
          <header class="overview-section-heading"><div><h2 id="overview-upstream-heading">上游台账</h2><p>按响应次数排序；成功率不含并发竞争中被取消的尝试</p></div><span>{{ upstreamRows.length }} 个上游</span></header>
          <template v-if="upstreamRows.length">
            <div class="overview-upstream-desktop">
              <!-- 九列收成四列：身份、成功率、耗时、响应次数。
                   错误、拒绝、TCP 兜底收进每行的展开里——它们是排查时才看的数，
                   平时每行都摆出来只会稀释真正要扫的那两列。诊断页的执行步骤
                   不能藏是因为那是那一页的产出；这里恰恰相反，藏起来的是次要项。
                   一行里只允许一个告警色：成功率和耗时同时染红，
                   读者分不出到底是哪一项出了问题。 -->
              <table class="overview-table">
                <caption class="overview-sr-only">各上游的运行时累计请求结果</caption>
                <thead><tr><th scope="col">上游</th><th scope="col">成功率</th><th scope="col">平均耗时</th><th scope="col">响应次数</th><th scope="col"><span class="overview-sr-only">明细</span></th></tr></thead>
                <tbody><template v-for="item in upstreamRows" :key="upstreamKey(item)"><tr>
                  <th scope="row">
                    <span class="overview-upstream-cell">
                      <i class="overview-dot" :class="`overview-dot--${item.health}`" role="img" :aria-label="HEALTH_LABELS[item.health]" :title="HEALTH_LABELS[item.health]"></i>
                      <span class="overview-mono">{{ item.upstream }}</span>
                      <span class="overview-transport">{{ item.transport }}</span>
                    </span>
                  </th>
                  <td>
                    <span class="overview-rate-cell">
                      <span :class="`overview-text--${item.health}`">{{ formatPercent(upstreamSuccessRate(item)) }}</span>
                      <span class="overview-rate-bar" aria-hidden="true"><i :class="`overview-rate-bar--${item.health}`" :style="{ width: `${upstreamSuccessRate(item) * 100}%` }"></i></span>
                    </span>
                  </td>
                  <td>{{ formatLatency(item.avg_latency_ms) }}</td>
                  <td>{{ formatNumber(item.settled) }}</td>
                  <td class="overview-expand-cell">
                    <button type="button" class="overview-expand" :aria-expanded="expandedUpstream === upstreamKey(item)" :aria-label="`${item.upstream} 的错误与兜底明细`" @click="toggleUpstream(item)">
                      <ChevronRight :size="15" :class="{ 'overview-expand--open': expandedUpstream === upstreamKey(item) }" />
                    </button>
                  </td>
                </tr>
                <tr v-if="expandedUpstream === upstreamKey(item)" :key="`${upstreamKey(item)}:detail`" class="overview-table-detail">
                  <td colspan="5">
                    <dl class="overview-upstream-counts">
                      <div><dt>成功</dt><dd>{{ formatNumber(item.success) }}</dd></div>
                      <div><dt>错误</dt><dd :class="{ 'overview-warning': item.errors > 0 }">{{ formatNumber(item.errors) }}</dd></div>
                      <div><dt>拒绝</dt><dd>{{ formatNumber(item.rejected) }}</dd></div>
                      <div><dt>TCP 兜底</dt><dd>{{ fallbackShare(item) }}</dd></div>
                    </dl>
                  </td>
                </tr></template></tbody>
              </table>
            </div>
            <div class="overview-upstream-mobile">
              <details v-for="item in upstreamRows" :key="`${item.upstream}:${item.transport}`" class="overview-upstream-detail">
                <summary>
                  <span class="overview-upstream-identity"><i class="overview-dot" :class="`overview-dot--${item.health}`" aria-hidden="true"></i><strong class="overview-mono">{{ item.upstream }}</strong><span class="overview-transport">{{ item.transport }}</span></span>
                  <span class="overview-upstream-summary">成功率 <b :class="`overview-text--${item.health}`">{{ formatPercent(upstreamSuccessRate(item)) }}</b> · 平均 {{ formatLatency(item.avg_latency_ms) }} · {{ formatNumber(item.settled) }} 次响应</span>
                  <ChevronRight :size="18" class="overview-disclosure-icon" />
                </summary>
                <dl class="overview-upstream-counts">
                  <div><dt>成功</dt><dd>{{ formatNumber(item.success) }}</dd></div>
                  <div><dt>错误</dt><dd :class="{ 'overview-warning': item.errors > 0 }">{{ formatNumber(item.errors) }}</dd></div>
                  <div><dt>拒绝</dt><dd>{{ formatNumber(item.rejected) }}</dd></div>
                  <div><dt>TCP 兜底</dt><dd>{{ fallbackShare(item) }}</dd></div>
                </dl>
              </details>
            </div>
          </template>
          <p v-else class="overview-empty">尚无上游请求数据</p>
        </section>

        <section v-if="rcodes.length || cacheRows.length" class="overview-section overview-breakdowns" aria-label="响应码与缓存构成">
          <div v-if="rcodes.length" class="overview-breakdown">
            <header class="overview-section-heading"><div><h2>响应码分布</h2><p>全部上游 · 已得到结果的请求</p></div></header>
            <p class="overview-dist-main"><span class="overview-dist-share">{{ formatPercent(rcodes[0].share) }}</span><span class="overview-dist-name">{{ rcodes[0].label }}</span></p>
            <ul class="overview-legend" aria-label="响应码分布">
              <li v-for="row in rcodes.slice(1)" :key="row.key"><span>{{ row.label }}</span><span>{{ formatPercent(row.share) }}</span></li>
            </ul>
          </div>
          <div v-if="cacheRows.length" class="overview-breakdown">
            <header class="overview-section-heading"><div><h2>缓存构成</h2><p>命中按来源拆分</p></div></header>
            <p class="overview-dist-main"><span class="overview-dist-share">{{ formatPercent(cacheRows[0].share) }}</span><span class="overview-dist-name">{{ cacheRows[0].label }}</span></p>
            <ul class="overview-legend" aria-label="缓存构成">
              <li v-for="row in cacheRows.slice(1)" :key="row.key"><span>{{ row.label }}</span><span>{{ formatPercent(row.share) }}</span></li>
            </ul>
          </div>
        </section>
      </section>

      <section id="overview-panel-stats" v-show="activeView === 'stats'" class="overview-view" role="tabpanel" aria-labelledby="overview-tab-stats" tabindex="0">
        <header class="overview-section-heading overview-stats-heading">
          <div><h2>查询排行</h2><p v-if="displayStats">已观察 {{ formatNumber(displayStats.requests_observed) }} 次请求<span v-if="displayStats.dropped_updates"> · 丢弃 {{ formatNumber(displayStats.dropped_updates) }} 次统计更新</span></p><p v-else>客户端与请求域名</p></div>
          <div class="overview-stats-tools">
            <div class="overview-windows" role="group" aria-label="统计窗口">
              <button v-for="option in statsWindows" :key="option.value" type="button" :aria-pressed="statsWindow === option.value" :disabled="statsLoading || runtimeControlsDisabled" @click="setStatsWindow(option.value)">{{ option.label }}</button>
            </div>
            <button v-if="stats?.enabled" class="overview-button overview-icon-button" type="button" title="清空查询排行" aria-label="清空查询排行" :disabled="statsClearing || runtimeControlsDisabled" @click="clearQueryStats"><Eraser :size="16" /></button>
          </div>
        </header>
        <p v-if="!showStatsSection" class="overview-empty">当前 KixDNS 未提供查询排行能力。</p>
        <div v-else-if="displayStats?.enabled" class="overview-rankings">
          <section v-for="group in rankingGroups" :key="group.id" class="overview-ranking">
            <header><h3>{{ group.title }}</h3><p>{{ group.id === 'clients' && displayStats.anonymized_clients ? '按脱敏网段聚合' : group.description }}</p></header>
            <ol v-if="displayStats[group.id].length" class="overview-ranking-list">
              <li v-for="(item, index) in displayStats[group.id]" :key="item.name">
                <span class="overview-rank">{{ String(index + 1).padStart(2, '0') }}</span>
                <strong class="overview-mono" :title="item.name">{{ item.name }}</strong><span>{{ formatNumber(item.count) }}</span>
                <i aria-hidden="true"><span :style="{ width: `${item.count / (group.id === 'clients' ? maxClient : maxDomain) * 100}%` }"></span></i>
              </li>
            </ol>
            <p v-else class="overview-empty">{{ group.id === 'clients' ? '当前窗口暂无客户端数据' : '当前窗口暂无域名数据' }}</p>
          </section>
        </div>
        <div v-else-if="stats" class="overview-empty overview-stats-disabled"><strong>查询统计未启用</strong><p>当前没有收集客户端地址和请求域名。</p><RouterLink class="overview-button" to="/config">打开配置<ArrowUpRight :size="16" /></RouterLink></div>
        <p v-else class="overview-empty">{{ statsLoading ? '正在读取查询排行' : '查询排行暂不可用' }}</p>
      </section>

      <section id="overview-panel-rules" v-show="activeView === 'rules'" class="overview-view" role="tabpanel" aria-labelledby="overview-tab-rules" tabindex="0">
        <header class="overview-section-heading"><div><h2>规则命中</h2><p>请求与响应阶段的累计执行次数</p></div><span>{{ displayOverview.metrics.rules.length }} 项</span></header>
        <div v-if="displayOverview.metrics.rules.length" class="overview-rules">
          <div class="overview-rule-head" aria-hidden="true"><span>阶段</span><span>Pipeline</span><span>规则</span><span>执行次数</span></div>
          <ul>
            <li v-for="rule in displayOverview.metrics.rules" :key="`${rule.pipeline}:${rule.phase}:${rule.rule}`" class="overview-rule">
              <span class="overview-phase" :class="{ 'overview-phase--response': rule.phase === 'response' }">{{ rule.phase === 'request' ? '请求' : '响应' }}</span>
              <span class="overview-rule-pipeline overview-mono">{{ rule.pipeline }}</span><strong class="overview-rule-name overview-mono">{{ rule.rule }}</strong><span class="overview-rule-count">{{ formatNumber(rule.count) }}</span>
            </li>
          </ul>
        </div>
        <p v-else class="overview-empty">尚无规则命中数据</p>
      </section>

      <section class="overview-runtime" aria-labelledby="overview-runtime-heading">
        <header class="overview-runtime-heading">
          <div><h2 id="overview-runtime-heading">{{ runtimeUnavailable ? '最后运行配置' : '当前运行配置' }}</h2><span class="overview-config-state" :class="{ 'overview-config-state--active': runtimeState === 'live' && displayOverview.active_config.last_reload.success, 'overview-warning': overview && !displayOverview.active_config.last_reload.success }">{{ configStateLabel }}</span></div>
          <RouterLink class="overview-button" to="/config">管理配置<ArrowUpRight :size="16" /></RouterLink>
        </header>
        <dl class="overview-runtime-ledger">
          <div><dt>配置代次</dt><dd>{{ overview ? `#${displayOverview.active_config.generation}` : '--' }}</dd></div>
          <div><dt>重载序号</dt><dd>{{ overview ? `#${displayOverview.active_config.reload_sequence}` : '--' }}</dd></div>
          <div><dt>配置摘要</dt><dd class="overview-mono" :title="overview ? displayOverview.active_config.sha256 : undefined">{{ overview ? shortHash(displayOverview.active_config.sha256, 14) : '--' }}</dd></div>
          <div><dt>上游提交</dt><dd class="overview-mono">{{ overview ? shortHash(displayOverview.health.upstream_commit, 12) : '--' }}</dd></div>
          <div><dt>补丁集</dt><dd>{{ overview ? `v${displayOverview.health.patchset}` : '--' }}</dd></div>
        </dl>
        <p v-if="overview && !displayOverview.active_config.last_reload.success && displayOverview.active_config.last_reload.error" class="overview-reload-error">{{ displayOverview.active_config.last_reload.error }}</p>
        <footer class="overview-runtime-footer">
          <p>PID {{ overview ? displayOverview.health.pid : '--' }}<span> · 统计为运行时累计值</span></p>
          <button class="overview-button overview-cache-button" type="button" :disabled="flushing || runtimeControlsDisabled" @click="flushCache"><Eraser :size="15" />{{ flushing ? '正在清理' : '清空内部缓存' }}</button>
        </footer>
      </section>
    </template>
    <p v-else class="overview-empty">运行数据暂不可用，请检查增强控制通道。</p>
  </div>
</template>

<style scoped>
.overview-page { color: var(--ink); font-size: 14px; line-height: 1.5; }
.overview-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.overview-heading h1 { margin: 0; font-size: 28px; font-weight: 650; letter-spacing: -.04em; line-height: 1.25; }
.overview-heading-context { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
.overview-button { min-height: 40px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 13px; border: 1px solid var(--line); border-radius: 4px; color: var(--ink); background: var(--surface); font: inherit; font-size: 13px; text-decoration: none; cursor: pointer; }
.overview-button:hover:not(:disabled) { border-color: var(--ink); }
.overview-button:disabled { opacity: .45; cursor: not-allowed; }
.overview-button:focus-visible, .overview-tabs button:focus-visible, .overview-windows button:focus-visible, .overview-upstream-detail summary:focus-visible { outline: 2px solid var(--green); outline-offset: 3px; }
.overview-notice { margin-bottom: 16px; }
.overview-notice--paused { display: flex; align-items: flex-start; gap: 10px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); }
.overview-notice--paused > svg { flex: 0 0 auto; margin-top: 2px; color: var(--muted); }
.overview-notice p { margin: 3px 0 0; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.overview-tabs { display: flex; gap: 28px; min-height: 46px; margin-bottom: 24px; border-bottom: 1px solid var(--line); }
.overview-tabs button { position: relative; padding: 0 8px 12px; border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 14px; cursor: pointer; }
.overview-tabs button[aria-selected="true"] { color: var(--ink); font-weight: 600; }
.overview-tabs button[aria-selected="true"]::after { position: absolute; right: 0; bottom: -1px; left: 0; height: 3px; background: var(--green); content: ''; }
.overview-view { outline-offset: 5px; }
/* 信号带：整页唯一一处深底，最重要的数字独占其中并带趋势。
   The signal band is the page's one dark surface: the number that matters most
   sits alone on it with its trend. */
.overview-signal { display: grid; grid-template-columns: minmax(0, 1fr) 260px; align-items: center; gap: 28px; margin-bottom: 20px; padding: 22px 24px; border-radius: 4px; color: var(--d-ink); background: var(--ink); }
.overview-signal-main { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.overview-signal-label { color: var(--d-ink-2); font-size: var(--t-1); }
.overview-signal-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 18px; color: var(--d-ink-2); font-size: var(--t-1); font-variant-numeric: tabular-nums; }
.overview-signal-sub b { color: var(--d-ink); font-weight: 500; }
/* 趋势线和大数字同色：它们说的是同一件事，分开配色会读成两条信息。 */
.overview-spark { width: 100%; height: 74px; overflow: visible; }
.overview-spark-line { fill: none; stroke: var(--d-ink); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.overview-spark-area { fill: rgba(255, 255, 255, .13); stroke: none; }
.overview-spark-end { fill: var(--d-ink); }
.overview-spark-pending { color: var(--d-ink-2); font-size: var(--t-1); line-height: 1.6; }

.overview-stats-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-bottom: 28px; }
.overview-stat { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 16px 18px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); }
.overview-stat-label { color: var(--muted); font-size: var(--t-1); }
.overview-stat-note { color: var(--muted); font-size: var(--t-1); line-height: 1.55; font-variant-numeric: tabular-nums; }
.overview-stat-note b { font-weight: 500; }
/* 不允许在数字中间断行。overflow-wrap: anywhere 是为了防溢出加的，
   但它对大数字是错的药：375 宽下 12,847,392 会被折成 12,847,39 / 2。
   窄屏另有缩写（见 compactTotal），所以这里不需要靠断行来兜底。
   Never break inside a number. overflow-wrap: anywhere was added to stop
   overflow but is the wrong remedy here: at 375px it folds 12,847,392 into
   12,847,39 and 2. Narrow screens abbreviate instead (see compactTotal), so
   wrapping is not needed as a fallback. */
.overview-total-value, .overview-kpi-value { max-width: 100%; margin: 0; font-size: 40px; font-weight: 500; font-variant-numeric: tabular-nums; letter-spacing: -.045em; line-height: 1.1; white-space: nowrap; }
.overview-kpi-value-row { display: flex; align-items: baseline; gap: 6px; }
.overview-kpi-unit { color: var(--muted); font-size: 14px; font-variant-numeric: tabular-nums; }
.overview-dot { display: inline-block; flex: 0 0 8px; width: 8px; height: 8px; border-radius: 50%; vertical-align: middle; }
.overview-dot--pending { background: #b7bfbb; }
.overview-dot--healthy { background: var(--green); }
.overview-dot--degraded { background: var(--amber); }
.overview-dot--unhealthy { background: var(--red); }
.overview-text--pending, .overview-text--healthy { color: inherit; }
.overview-text--degraded { color: var(--amber); }
.overview-text--unhealthy { color: var(--red); }
.overview-breakdowns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 48px; }
.overview-breakdown { min-width: 0; }
.overview-breakdown .overview-section-heading { margin-bottom: 14px; }
/* 主项做大、小项列表。取代原来的堆叠条。 */
.overview-dist-main { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; margin: 0 0 10px; }
.overview-dist-share { font-size: 30px; font-weight: 500; font-variant-numeric: tabular-nums; letter-spacing: -.035em; line-height: 1.1; }
.overview-dist-name { min-width: 0; font-size: var(--t-3); overflow-wrap: anywhere; }
.overview-dist-count { margin-left: auto; color: var(--muted); font-size: var(--t-1); font-variant-numeric: tabular-nums; }
.overview-legend { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; font-size: 13px; }
.overview-legend li { display: flex; justify-content: space-between; gap: 8px; min-width: 0; color: var(--muted); }
.overview-legend li > span:last-child { font-variant-numeric: tabular-nums; }
/* 成功率配一根小条形：纯数字要逐个比对，条形一眼看得出哪个矮。
   一行里只允许一个告警色，所以耗时列不再跟着染色。 */
/* 布局放进单元格里的容器，不要直接把 td/th 变成 flex 或 grid：
   那样会让表格的自动列宽算错，上游列占掉一半宽度而「响应次数」被压到竖着断字。
   Layout goes in a wrapper inside the cell rather than turning the td/th itself
   into a flex or grid container: doing that throws off the table's automatic
   column widths, leaving the upstream column half the table and squeezing the
   count column until its header breaks one character per line. */
.overview-table thead th:first-child { width: 42%; }
.overview-table thead th:nth-child(2) { width: 130px; }
.overview-table thead th:nth-child(3), .overview-table thead th:nth-child(4) { width: 110px; }
.overview-upstream-cell { display: flex; align-items: center; gap: 8px; min-width: 0; font-weight: 400; }
.overview-upstream-cell .overview-mono { min-width: 0; overflow-wrap: anywhere; }
.overview-rate-cell { display: grid; gap: 4px; }
.overview-rate-bar { display: block; height: 3px; border-radius: 2px; background: var(--line); }
.overview-rate-bar > i { display: block; height: 100%; border-radius: 2px; background: var(--ink); }
.overview-rate-bar--degraded { background: var(--amber) !important; }
.overview-rate-bar--unhealthy { background: var(--red) !important; }
.overview-expand-cell { width: 36px; text-align: right; }
.overview-expand { display: inline-flex; padding: 4px; color: var(--muted); background: none; border: 0; border-radius: 3px; cursor: pointer; }
.overview-expand:hover { color: var(--ink); background: var(--canvas); }
.overview-expand--open { transform: rotate(90deg); }
.overview-table-detail > td { padding-top: 0; }

.overview-section { padding: 22px 0 0; margin-bottom: 24px; border-top: 1px solid var(--line); }
.overview-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 16px; }
.overview-section-heading > div:first-child { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 16px; min-width: 0; }
.overview-section-heading h2, .overview-runtime h2 { margin: 0; font-size: 17px; font-weight: 600; line-height: 1.4; }
.overview-section-heading p, .overview-section-heading > span { margin: 0; color: var(--muted); font-size: 12px; }
.overview-pipeline-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.overview-pipeline-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 10px; align-items: baseline; min-width: 0; color: var(--muted); font-size: var(--t-2); }
.overview-pipeline-name { min-width: 0; }
.overview-pipeline-name strong { font-weight: 400; overflow-wrap: anywhere; }
.overview-pipeline-count { font-variant-numeric: tabular-nums; }
.overview-pipeline-share { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.overview-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.overview-table th, .overview-table td { padding: 13px 12px; border-top: 0; border-bottom: 1px solid var(--line); background: transparent; text-align: right; white-space: normal; text-transform: none; font-variant-numeric: tabular-nums; }
.overview-table tr:last-child th, .overview-table tr:last-child td { border-bottom: 0; }
.overview-table thead th { color: var(--muted); font-size: 12px; font-weight: 500; }
.overview-table th:first-child, .overview-table td:nth-child(2), .overview-table th:nth-child(2) { text-align: left; }
.overview-table th:first-child { padding-left: 0; font-weight: 500; overflow-wrap: anywhere; }
.overview-table td:last-child, .overview-table th:last-child { padding-right: 0; }
.overview-table tbody th { max-width: 320px; color: var(--ink); font-size: 14px; }
.overview-transport { display: inline-block; padding: 2px 6px; border: 1px solid var(--line); border-radius: 3px; color: var(--ink); font: inherit; font-size: 12px; white-space: nowrap; }
.overview-warning { color: #a56118; }
.overview-upstream-mobile { display: none; }
.overview-runtime { margin-top: 24px; padding: 18px 20px 0; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); }
.overview-runtime-heading, .overview-runtime-heading > div { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 16px; }
.overview-runtime-heading { margin-bottom: 18px; }
.overview-runtime-heading h2 { font-size: 15px; }
.overview-config-state { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
.overview-config-state::before { width: 7px; height: 7px; border-radius: 50%; background: currentColor; content: ''; }
.overview-config-state--active { color: var(--green); }
.overview-runtime-ledger { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 16px; margin: 0 0 18px; }
.overview-runtime-ledger > div { min-width: 0; padding-right: 10px; border-right: 1px solid var(--line); }
.overview-runtime-ledger > div:last-child { border: 0; }
.overview-runtime-ledger dt { margin-bottom: 4px; color: var(--muted); font-size: 12px; }
.overview-runtime-ledger dd { margin: 0; overflow-wrap: anywhere; font-size: 13px; }
.overview-runtime-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 54px; border-top: 1px solid var(--line); }
.overview-runtime-footer p { margin: 0; color: var(--muted); font-size: 12px; }
.overview-cache-button { border-color: transparent; background: transparent; color: var(--muted); font-size: 12px; }
.overview-reload-error { color: #a56118; overflow-wrap: anywhere; font-size: 12px; }
.overview-stats-heading { align-items: flex-start; margin-bottom: 24px; }
.overview-stats-heading > div:first-child { display: block; }
.overview-stats-heading p { margin-top: 4px; }
.overview-stats-tools { display: flex; align-items: center; gap: 8px; }
.overview-windows { display: flex; }
.overview-windows button { min-height: 40px; padding: 7px 12px; border: 1px solid var(--line); border-right: 0; color: var(--muted); background: var(--surface); font: inherit; font-size: 12px; cursor: pointer; }
.overview-windows button:first-child { border-radius: 4px 0 0 4px; }
.overview-windows button:last-child { border-right: 1px solid var(--line); border-radius: 0 4px 4px 0; }
.overview-windows button[aria-pressed="true"] { color: var(--green); background: var(--canvas); box-shadow: inset 0 -2px var(--green); }
.overview-windows button:disabled { opacity: .45; cursor: not-allowed; }
.overview-icon-button { width: 40px; padding: 0; }
.overview-rankings { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 36px; }
.overview-ranking { min-width: 0; }
.overview-ranking h3 { margin: 0; font-size: 15px; font-weight: 600; }
.overview-ranking header p { margin: 3px 0 14px; color: var(--muted); font-size: 12px; }
.overview-ranking-list, .overview-rules ul { margin: 0; padding: 0; list-style: none; }
.overview-ranking-list li { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 6px 8px; padding: 13px 0; border-bottom: 1px solid var(--line); }
.overview-rank { color: var(--muted); font-size: 12px; }
.overview-ranking-list strong { min-width: 0; font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.overview-ranking-list li > span:last-of-type { font-size: 13px; font-variant-numeric: tabular-nums; }
.overview-ranking-list li > i { grid-column: 2 / -1; height: 3px; background: var(--line); }
.overview-ranking-list i > span { display: block; height: 100%; background: var(--green); }
.overview-rule, .overview-rule-head { display: grid; grid-template-columns: 72px minmax(100px, 1fr) minmax(160px, 2fr) 110px; gap: 16px; align-items: center; padding: 14px 0; border-bottom: 1px solid var(--line); }
.overview-rule-head { color: var(--muted); font-size: 12px; }
.overview-rule-head > span:last-child, .overview-rule-count { text-align: right; font-variant-numeric: tabular-nums; }
.overview-rule-name { min-width: 0; font-size: 14px; font-weight: 500; overflow-wrap: anywhere; }
.overview-rule-pipeline { color: var(--muted); overflow-wrap: anywhere; font-size: 13px; }
.overview-phase { justify-self: start; padding: 2px 7px; border: 1px solid var(--line); border-radius: 3px; color: var(--green); font-size: 12px; }
.overview-phase--response { color: var(--muted); }
.overview-empty, .overview-loading { padding: 28px 0; color: var(--muted); font-size: 13px; }
.overview-stats-disabled > * { display: block; margin: 0 0 8px; }
.overview-stats-disabled .overview-button { display: inline-flex; margin-top: 8px; }
.overview-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.overview-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

@media (max-width: 1000px) {
  .overview-signal { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .overview-stats-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .overview-breakdowns { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .overview-runtime-ledger { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .overview-table th, .overview-table td { padding: 12px 8px; font-size: 13px; }
  .overview-table tbody th { max-width: 230px; }
}

@media (max-width: 700px) {
  .overview-heading { margin-bottom: 8px; }
  .overview-heading h1 { font-size: 20px; letter-spacing: -.025em; }
  .overview-heading-context { display: none; }
  .overview-button { min-height: 44px; padding: 8px 10px; font-size: 12px; }
  .overview-heading > .overview-button { gap: 5px; }
  .overview-tabs { gap: 16px; min-height: 44px; margin-bottom: 16px; }
  .overview-tabs button { padding: 0 4px 9px; font-size: 14px; }
  .overview-signal { padding: 16px 16px 14px; margin-bottom: 14px; gap: 12px; }
  .overview-signal-sub { gap: 4px 12px; }
  .overview-spark { height: 52px; }
  .overview-stats-row { grid-template-columns: minmax(0, 1fr); gap: 10px; margin-bottom: 22px; }
  .overview-stat { gap: 4px; padding: 13px 14px; }
  .overview-total-value, .overview-kpi-value { font-size: 30px; }
  .overview-dist-share { font-size: 24px; }
  .overview-breakdowns { gap: 18px; }
  .overview-legend { gap: 6px; }
  .overview-section { padding-top: 16px; margin-bottom: 18px; }
  .overview-section-heading { align-items: baseline; gap: 8px; margin-bottom: 10px; }
  .overview-section-heading h2 { font-size: 15px; }
  .overview-section-heading > div:first-child { display: block; }
  .overview-section-heading > div > p { display: none; }
  .overview-section-heading > p, .overview-section-heading > span { font-size: 12px; }
  .overview-pipeline-list { display: block; margin-top: 5px; }
  .overview-pipeline-list li { grid-template-columns: minmax(0, 1fr) auto 49px; gap: 8px; align-items: center; min-height: 34px; border-bottom: 1px solid var(--line); font-size: 14px; }
  .overview-pipeline-list li:last-child { border-bottom: 0; }
  .overview-pipeline-name { grid-column: auto; }
  .overview-pipeline-share { font-size: 12px; text-align: right; }
  .overview-upstream-desktop { display: none; }
  .overview-upstream-mobile { display: block; }
  .overview-upstream-detail { border-bottom: 1px solid var(--line); }
  .overview-upstream-detail:last-child { border-bottom: 0; }
  .overview-upstream-detail summary { position: relative; display: grid; gap: 4px; min-height: 56px; padding: 11px 28px 11px 0; list-style: none; cursor: pointer; }
  .overview-upstream-detail summary::-webkit-details-marker { display: none; }
  .overview-upstream-identity { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
  .overview-upstream-identity strong { min-width: 0; overflow-wrap: anywhere; font-size: 14px; font-weight: 500; }
  .overview-transport { padding: 0 5px; font-size: 12px; }
  .overview-upstream-summary { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .overview-upstream-summary b { font-weight: 500; }
  .overview-disclosure-icon { position: absolute; top: 21px; right: 0; color: var(--muted); transition: transform .15s; }
  .overview-upstream-detail[open] .overview-disclosure-icon { transform: rotate(90deg); }
  .overview-upstream-counts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 0; padding: 3px 0 14px; }
  .overview-upstream-counts dt { color: var(--muted); font-size: 12px; }
  .overview-upstream-counts dd { margin: 3px 0 0; font-size: 12px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .overview-runtime { margin-top: 18px; padding: 12px 12px 0; }
  .overview-runtime-heading { margin-bottom: 12px; }
  .overview-runtime-heading > div { gap: 8px; }
  .overview-runtime-heading h2 { font-size: 14px; }
  .overview-runtime-heading > .overview-button { min-height: 44px; padding: 4px 7px; font-size: 12px; }
  .overview-config-state { gap: 4px; font-size: 12px; }
  .overview-config-state::before { width: 6px; height: 6px; }
  .overview-runtime-ledger { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; margin-bottom: 12px; }
  .overview-runtime-ledger > div { border: 0; padding: 0; }
  .overview-runtime-ledger dt { margin-bottom: 2px; font-size: 12px; }
  .overview-runtime-ledger dd { font-size: 12px; }
  .overview-runtime-footer { gap: 6px; min-height: 48px; }
  .overview-runtime-footer p { font-size: 12px; }
  .overview-runtime-footer p span { display: none; }
  .overview-cache-button { padding-right: 0; font-size: 12px; }
  .overview-stats-heading { flex-direction: column; gap: 14px; margin-bottom: 18px; }
  .overview-stats-heading > div > p { display: block; font-size: 12px; }
  .overview-stats-tools { width: 100%; justify-content: space-between; gap: 10px; }
  .overview-windows button { min-height: 44px; padding: 8px 13px; font-size: 12px; }
  .overview-icon-button { width: 44px; }
  .overview-rankings { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .overview-ranking-list li { grid-template-columns: 21px minmax(0, 1fr) auto; gap: 5px 7px; padding: 11px 0; }
  .overview-ranking-list strong, .overview-ranking-list li > span:last-of-type { font-size: 14px; }
  .overview-rule-head { display: none; }
  .overview-rule { grid-template-columns: minmax(0, 1fr) auto; gap: 5px 10px; padding: 12px 0; }
  .overview-phase { grid-column: 1; grid-row: 1; font-size: 12px; }
  .overview-rule-count { grid-column: 2; grid-row: 1 / 4; align-self: center; font-size: 14px; }
  .overview-rule-name { grid-column: 1; grid-row: 2; font-size: 13px; }
  .overview-rule-pipeline { grid-column: 1; grid-row: 3; font-size: 12px; }
  .overview-notice--paused { padding: 12px; }
}
</style>
