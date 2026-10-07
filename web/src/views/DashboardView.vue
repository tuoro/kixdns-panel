<script setup lang="ts">
import { ChartColumn, ChevronRight, CircleAlert, CircleX, Eraser, ListChecks, Power, RefreshCw } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { apiRequest } from '../api/client'
import type { CacheFlushResult, Overview, QueryStatsSnapshot, ServiceStatus, StatsClearResult } from '../api/types'
import UiCard from '../components/ui/UiCard.vue'
import UiEmpty from '../components/ui/UiEmpty.vue'
import UiNumber from '../components/ui/UiNumber.vue'
import UiPageHeader from '../components/ui/UiPageHeader.vue'
import UiSection from '../components/ui/UiSection.vue'
import UiTabs from '../components/ui/UiTabs.vue'
import { useConfirm } from '../composables/useConfirm'
import { useToast } from '../composables/useToast'
import { HEALTH_LABELS, MIN_HEALTH_SAMPLES, cacheComposition, pipelineDistribution, rcodeDistribution, latencyBands, latencyBasis, latencyHealth, recentWindowLabel, settledAttempts, upstreamBasis, upstreamHealth } from '../dashboard-presentation'
import type { UpstreamHealth } from '../dashboard-presentation'
import { dashboardRuntimeState, emptyOverview, emptyQueryStats, hasStaleDashboardData, supportsQueryStats, supportsUpstreamPrecision } from '../dashboard-state'
import { sparkline } from '../trend'
import { softBreakOffsets } from '../ui/soft-breaks'
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
// 最近一次读到运行数据的时刻：页头的「更新于」和没有采集时刻的快照都用它
// When runtime data was last read: the header's 更新于, and snapshots that carry no capture time
const loadedAt = ref<number | null>(null)
const toast = useToast()
const confirm = useConfirm()
const activeView = ref('runtime')
const views = [
  { value: 'runtime', label: '运行情况' },
  { value: 'stats', label: '查询排行' },
  { value: 'rules', label: '规则命中' },
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
const statsSupported = computed(() => supportsQueryStats(overview.value?.health.capabilities ?? []))
const runtimeUnavailable = computed(() => hasStaleDashboardData(runtimeState.value))
const runtimeControlsDisabled = computed(() => runtimeState.value !== 'live')
const displayOverview = computed(() => overview.value ?? (runtimeState.value === 'stopped-empty' ? emptyOverview() : null))
const showStatsSection = computed(() => statsSupported.value || runtimeState.value === 'stopped-empty')
const displayStats = computed(() => stats.value ?? (runtimeState.value === 'stopped-empty' ? emptyQueryStats(statsWindow.value) : null))
const maxClient = computed(() => Math.max(1, ...(stats.value?.clients.map((item) => item.count) ?? [])))
const maxDomain = computed(() => Math.max(1, ...(stats.value?.domains.map((item) => item.count) ?? [])))

// ---------- 页头：按服务状态写事实，和系统页同一种写法 ----------
// ---------- Header: facts by service state, written as on the system page ----------
type Tone = 'ok' | 'warn' | 'err' | 'off'
const serviceTone = computed<Tone>(() => {
  const current = service.value
  if (!current) return 'off'
  if (current.active_state === 'active') return 'ok'
  if (current.active_state === 'failed') return 'err'
  if (['activating', 'reloading', 'deactivating'].includes(current.active_state) || current.sub_state === 'auto-restart') return 'warn'
  return 'off'
})
const serviceLabel = computed(() => {
  const current = service.value
  if (current?.active_state === 'deactivating') return '正在停止'
  return { ok: '运行中', warn: '正在启动', err: '启动失败', off: '已停止' }[serviceTone.value]
})
// 「运行中 · active/running」是同一件事说两遍；只有不寻常的状态，systemd 的原始写法才多带了信息（同系统页）。
// "运行中 · active/running" says one thing twice; only unusual states carry information in systemd's own words (as on the system page).
const unusualServiceState = computed(() => {
  const current = service.value
  const state = current ? `${current.active_state}/${current.sub_state}` : ''
  return state && !['active/running', 'inactive/dead'].includes(state) ? state : ''
})
function clock(ms: number, seconds: boolean): string {
  const date = new Date(ms)
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false })
  if (date.toDateString() === new Date().toDateString()) return time
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${time}`
}
const snapshotLabel = computed(() => {
  const captured = overview.value?.captured_at_unix ? overview.value.captured_at_unix * 1000 : loadedAt.value
  return captured ? clock(captured, false) : ''
})
const updatedLabel = computed(() => (loadedAt.value ? clock(loadedAt.value, true) : ''))
// 页头服务状态后面还跟什么：实时写运行时长和更新时刻，读不到实时数据写快照时刻 / What follows the service state: uptime and update time when live, the snapshot time otherwise
const metaTail = computed<'live' | 'snapshot' | ''>(() => (runtimeState.value === 'live' && overview.value ? 'live' : runtimeUnavailable.value && snapshotLabel.value ? 'snapshot' : ''))

// ---------- 页级提示：一次只出一条，读取错误写进原因行 ----------
// ---------- Page notice: one at a time, a read error goes in its reason line ----------
interface PageNotice { tone: 'warn' | 'err' | 'off'; icon: typeof CircleAlert; title: string; reason: string; action?: 'retry' | 'config' | 'logs' }
// 原因行把几条读取错误和一句「接下来会怎样」连成一段 / The reason line joins the read errors and one sentence on what happens next
function reasonOf(...parts: string[]): string {
  return parts.filter(Boolean).map((part) => part.replace(/[。；;.]$/, '')).join('；') + '。'
}
const notice = computed<PageNotice | null>(() => {
  if (loading.value) return null
  const snapshot = snapshotLabel.value ? ` ${snapshotLabel.value} ` : ''
  // 运行数据的错误不带前缀（标题已经说了是运行数据）；服务状态的错误带「服务状态：」，和它分得开
  // A runtime-data error goes unprefixed (the title already says so); a service error carries 服务状态： to tell the two apart
  const serviceErrorPart = serviceError.value ? `服务状态：${serviceError.value}` : ''
  // 服务不是干净地停着（启动失败、正在启动、正在停止），提示和页头说同一件事
  // When the service is not cleanly stopped (failed, starting, stopping), the notice says what the header says
  const tone = serviceTone.value
  const serviceTitle = tone === 'err' ? 'KixDNS 启动失败' : tone === 'warn' ? `KixDNS ${serviceLabel.value}` : ''
  // 原因按状态说接下来会怎样：启动失败指去日志；正在启动说完成后自动更新；正在停止不许诺什么
  // The reason says what comes next by state: a failure points to the logs, a start updates on completion, a stop promises nothing
  const serviceNotice = (shown: string): PageNotice => tone === 'err'
    ? { tone: 'err', icon: CircleX, title: serviceTitle, reason: reasonOf(shown, '查看日志了解启动失败的原因'), action: 'logs' }
    : { tone: 'warn', icon: CircleAlert, title: serviceTitle, reason: reasonOf(shown, service.value?.active_state === 'activating' ? '启动完成后概览会自动更新' : '') }
  switch (runtimeState.value) {
    case 'stopped-empty':
      return serviceTitle
        ? serviceNotice('还没有运行数据')
        : { tone: 'off', icon: Power, title: 'KixDNS 已停止', reason: reasonOf('还没有运行数据', '启动 KixDNS 后概览会自动更新') }
    case 'stopped-snapshot':
      return serviceTitle
        ? serviceNotice(`显示停止前${snapshot}的快照`)
        : { tone: 'off', icon: Power, title: 'KixDNS 已停止', reason: reasonOf(`显示停止前${snapshot}的快照`, '启动 KixDNS 后概览会自动更新') }
    case 'unavailable-snapshot':
      return { tone: 'warn', icon: CircleAlert, title: '实时数据暂不可用', reason: reasonOf(overviewError.value || 'KixDNS 暂时没有应答', serviceErrorPart, `显示${snapshot}的快照，恢复后会自动更新`), action: 'retry' }
    case 'unavailable':
      return { tone: 'err', icon: CircleX, title: '读不到运行数据', reason: reasonOf(overviewError.value, serviceErrorPart, '页面每 15 秒自动重试'), action: 'retry' }
    default: {
      // 手上的数据还标着实时，但最近一次刷新失败了：和上面同一件事，写法一样
      // The data in hand is still marked live but the latest refresh failed: the same situation as above, written the same way
      if (overviewError.value) return { tone: 'warn', icon: CircleAlert, title: '实时数据暂不可用', reason: reasonOf(overviewError.value, serviceErrorPart, `显示 ${updatedLabel.value} 读到的数据，恢复后会自动更新`), action: 'retry' }
      const reload = overview.value?.active_config.last_reload
      if (overview.value && reload && !reload.success) {
        // 卡片里有失败原文时才指过去 / Point to the card only when it actually shows the failure text
        return { tone: 'warn', icon: CircleAlert, title: '配置重载失败', reason: reasonOf(`新配置没有生效，仍按配置代次 #${overview.value.active_config.generation} 运行`, reload.error ? '失败原因见下方「当前运行配置」' : ''), action: 'config' }
      }
      return serviceError.value ? { tone: 'warn', icon: CircleAlert, title: '服务状态读取失败', reason: reasonOf(serviceError.value), action: 'retry' } : null
    }
  }
})

// ---------- 信号带 ----------
const finishedTotal = computed(() => {
  const finished = displayOverview.value?.metrics.requests_finished
  return finished ? finished.completed + finished.failed + finished.cancelled : 0
})
const finishedShare = (value: number) => (finishedTotal.value ? value / finishedTotal.value : 0)

// ---------- 三项体征 ----------
const precisionSupported = computed(() => supportsUpstreamPrecision(displayOverview.value?.health.capabilities ?? []))
const recentWindow = computed(() => displayOverview.value?.metrics.recent_window_seconds ?? null)
function latencyParts(value: number): { figure: string; unit: string } {
  // 1 秒以上写秒：「2480 ms」要读者自己换算，「2.5 s」一眼就是慢
  // A second or more is written in seconds: 2480 ms makes the reader convert, 2.5 s reads as slow at once
  // 先取整再定单位：999.6 ms 取整是 1000，要写成 1.0 s，不写「1000 ms」
  // Round before choosing the unit: 999.6 ms rounds to 1000, which is written 1.0 s, never 1000 ms
  const tenths = Math.round(value * 10) / 10
  if (tenths < 10) return { figure: tenths.toFixed(1), unit: 'ms' }
  const rounded = Math.round(value)
  if (rounded >= 1000) return { figure: (value / 1000).toFixed(1), unit: 's' }
  return { figure: String(rounded), unit: 'ms' }
}
function formatLatency(value: number | null): string {
  if (value === null) return '—'
  const parts = latencyParts(value)
  return `${parts.figure} ${parts.unit}`
}
// 响应速度和上游状态一样看最近一小时；这一小时请求不够时退回启动以来的累计，名称照实写。
// Speed covers the last hour like upstream status; with too few requests it falls back to the lifetime total, and the name says so.
const speed = computed(() => {
  const metrics = displayOverview.value?.metrics
  if (!metrics) return null
  const basis = latencyBasis(metrics)
  const { latency } = basis
  const bands = latencyBands(latency)
  const share = (count: number) => (latency.samples ? count / latency.samples : 0)
  return {
    period: basis.recent ? recentWindowLabel(recentWindow.value) : '启动以来',
    average: latencyParts(latency.avg_ms),
    bands,
    health: latencyHealth(latency),
    within10: share(latency.within_10ms),
    within100: share(latency.within_100ms),
    slower: bands.find((band) => band.key === 'slower')?.share ?? 0,
    // 四档明细写进细条的读屏名称；触屏看不到 title，所以不慢时注脚写两档累计，慢时换成最慢那档
    // The four bands go in the bar's accessible name; touch screens never see a title, so the footnote gives two cumulative
    // figures normally and switches to the slowest band when latency is not healthy
    spoken: bands.map((band) => `${band.label} ${formatSmallPercent(band.share)}`).join('，'),
  }
})
const cacheLookups = computed(() => displayOverview.value?.metrics.cache_lookups_total ?? 0)
const cacheHitRate = computed(() => {
  const metrics = displayOverview.value?.metrics
  return metrics && cacheLookups.value ? (metrics.cache_hits_fresh + metrics.cache_hits_stale) / cacheLookups.value : 0
})
const cacheFreshShare = computed(() => (cacheLookups.value ? (displayOverview.value?.metrics.cache_hits_fresh ?? 0) / cacheLookups.value : 0))
const cacheStaleShare = computed(() => (cacheLookups.value ? (displayOverview.value?.metrics.cache_hits_stale ?? 0) / cacheLookups.value : 0))
const staleShare = computed(() => {
  const metrics = displayOverview.value?.metrics
  const hits = metrics ? metrics.cache_hits_fresh + metrics.cache_hits_stale : 0
  return hits ? metrics!.cache_hits_stale / hits : 0
})

// 每行的成功率、耗时、次数和明细都取同一个依据：最近一小时，响应不够时是启动以来的累计。
// 排序始终按累计响应次数，免得表格随窗口来回跳。
// Every figure in a row comes from one basis: the last hour, or the lifetime total when there were too few responses.
// Rows always sort by lifetime responses, so the list does not reshuffle as the window moves.
const upstreamRows = computed(() => [...(displayOverview.value?.metrics.upstreams ?? [])]
  .sort((left, right) => settledAttempts(right) - settledAttempts(left))
  .map((item) => {
    const basis = upstreamBasis(item)
    return { ...item, shown: basis.tally, sinceStart: !basis.recent && recentWindow.value !== null, settled: settledAttempts(basis.tally), health: precisionSupported.value ? upstreamHealth(item) : 'pending' as UpstreamHealth }
  }))
const healthCounts = computed(() => {
  const counts = { pending: 0, healthy: 0, degraded: 0, unhealthy: 0 }
  for (const item of upstreamRows.value) counts[item.health] += 1
  return counts
})
const judgedUpstreams = computed(() => upstreamRows.value.length - healthCounts.value.pending)
// 每一行都退回了累计时，整个上游状态（和健康卡）的时段改写成启动以来；只有部分退回时不逐行标注，也不在健康卡里计数
// When every row fell back to the lifetime total, the upstream status section (and the health tile) names the whole run as
// its period; when only some did, neither the rows nor the health tile mark them
const allSinceStart = computed(() => upstreamRows.value.length > 0 && upstreamRows.value.every((item) => item.sinceStart))
const ledgerPeriod = computed(() => (allSinceStart.value ? '启动以来' : recentWindowLabel(recentWindow.value)))
// 上游状态里有没有耗时：旧增强版整列都没有，就不画这一列 / Whether upstream status has latency at all: old enhanced builds have none, and the column is not drawn
const hasLatency = computed(() => upstreamRows.value.some((item) => item.shown.avg_latency_ms !== null))
// 细条按上游逐个分段，顺序固定：健康、降级、异常、观察中
// The bar has one segment per upstream in a fixed order: healthy, degraded, unhealthy, pending
const healthSegments = computed(() => (['healthy', 'degraded', 'unhealthy', 'pending'] as const)
  .map((key) => ({ key, share: upstreamRows.value.length ? healthCounts.value[key] / upstreamRows.value.length : 0 }))
  .filter((segment) => segment.share > 0))
// 降级、异常各带各的颜色，不拼成一段用最坏的那个颜色；后面最多再跟一项：有观察中的写观察中，没有才写判定标准
// Degraded and unhealthy each keep their own colour rather than sharing the worse one; at most one more item follows —
// the upstreams still observed, or the criteria when there are none
interface FootPart { text: string; tone?: UpstreamHealth }
const healthFoot = computed<FootPart[]>(() => {
  const { degraded, unhealthy, pending } = healthCounts.value
  const trouble: FootPart[] = []
  if (degraded) trouble.push({ text: `${degraded} 个降级`, tone: 'degraded' })
  if (unhealthy) trouble.push({ text: `${unhealthy} 个异常`, tone: 'unhealthy' })
  const observed: FootPart | null = pending ? { text: `${pending} 个观察中，响应不足 ${MIN_HEALTH_SAMPLES} 次` } : null
  const criteria: FootPart = { text: '成功率 ≥ 99% 且平均 < 1 s' }
  if (trouble.length) return [...trouble, observed ?? criteria]
  return observed ? [observed, criteria] : [criteria]
})
const expandedUpstream = ref<string | null>(null)
const upstreamKey = (item: { upstream: string; transport: string }) => `${item.upstream}:${item.transport}`
function toggleUpstream(item: { upstream: string; transport: string }): void {
  expandedUpstream.value = expandedUpstream.value === upstreamKey(item) ? null : upstreamKey(item)
}
function healthLabel(health: UpstreamHealth): string {
  return precisionSupported.value ? HEALTH_LABELS[health] : '不支持判定'
}
function fallbackShare(item: { transport: string; settled: number; shown: { tcp_fallbacks: number } }): string {
  return item.transport === 'udp' && item.settled > 0 ? formatPercent(item.shown.tcp_fallbacks / item.settled) : '—'
}
// 长地址只在目录边界的「/」后面断行（同 JSON 视图的规矩），不从词中间断开
// Long addresses break only after a directory 「/」 (the JSON view's rule), never inside a word
function breakable(text: string): string[] {
  const parts: string[] = []
  let at = 0
  for (const offset of softBreakOffsets(text)) {
    parts.push(text.slice(at, offset))
    at = offset
  }
  parts.push(text.slice(at))
  return parts
}

// ---------- 三栏分布：全是启动以来的累计 ----------
const pipelines = computed(() => pipelineDistribution(displayOverview.value?.metrics.pipelines ?? []))
const rcodes = computed(() => rcodeDistribution(displayOverview.value?.metrics.upstreams ?? []))
const cacheRows = computed(() => (displayOverview.value ? cacheComposition(displayOverview.value.metrics) : []))

// ---------- 规则命中：按执行次数降序 ----------
const rules = computed(() => [...(displayOverview.value?.metrics.rules ?? [])].sort((left, right) => right.count - left.count))

// ---------- 当前运行配置 ----------
const configTag = computed(() => {
  if (!overview.value) return { label: '未运行', tone: '' }
  if (runtimeUnavailable.value) return { label: '运行快照', tone: '' }
  return overview.value.active_config.last_reload.success ? { label: '已生效', tone: 'ok' } : { label: '重载失败', tone: 'warn' }
})

// ---------- 查询排行 ----------
const statsWindowKey = computed({
  get: () => String(statsWindow.value),
  set: (value: string) => { void setStatsWindow(Number(value)) },
})
const statsWindowItems = computed(() => statsWindows.map((item) => ({ value: String(item.value), label: item.label, disabled: runtimeControlsDisabled.value })))
// 时段跟着手上这份数据的窗口写，不跟着刚点的那一档：新窗口的数据到了才换
// The period follows the window of the data in hand, not the option just pressed: it changes when the new window's data arrives
const statsWindowLabel = computed(() => {
  const seconds = displayStats.value?.window_seconds ?? statsWindow.value
  return `近 ${statsWindows.find((item) => item.value === seconds)?.label ?? `${Math.round(seconds / 3600)} 小时`}`
})
const rankingGroups = [
  { id: 'clients', title: '客户端排行', description: '按来源地址聚合', empty: '当前窗口暂无客户端数据' },
  { id: 'domains', title: '请求域名排行', description: '按查询次数', empty: '当前窗口暂无域名数据' },
] as const

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
      loadedAt.value = Date.now()
    } else overviewError.value = errorMessage(overviewResult.reason)
    if (serviceResult.status === 'fulfilled') {
      service.value = serviceResult.value
      serviceError.value = ''
    } else serviceError.value = errorMessage(serviceResult.reason)
  })().finally(() => {
    loading.value = false
    refreshing.value = false
    requesting.value = false
    pendingLoad = null
  })
  return pendingLoad
}

// 每次请求编一个号，只收最新那次的结果：切窗口、清空之后，还在路上的旧请求回来也不会盖掉新数据。
// 定时刷新遇到正在进行的请求就搭车；切窗口、清空要的是新数据，必须重新发。
// Each request gets a number and only the latest one's result is kept: after switching windows or clearing, an older request
// still in flight cannot overwrite the new data. A timed refresh rides along with a request in progress; switching windows and
// clearing need fresh data and always send their own.
let statsRequest = 0
function loadStats(silent = false, fresh = false): Promise<void> {
  if (!statsSupported.value) {
    // 能力没了（换回了旧内核）：在路上的请求一并作废 / The capability is gone (an older kernel): requests in flight are void too
    statsRequest += 1
    stats.value = null
    statsError.value = ''
    statsLoading.value = false
    pendingStatsLoad = null
    return Promise.resolve()
  }
  if (pendingStatsLoad && !fresh) return pendingStatsLoad
  if (!silent) statsLoading.value = true
  const request = ++statsRequest
  const load = apiRequest<QueryStatsSnapshot>(`/api/v1/stats/top?window=${statsWindow.value}&limit=10`)
    .then((result) => {
      if (request !== statsRequest) return
      stats.value = result
      statsError.value = ''
    })
    .catch((error: unknown) => {
      if (request === statsRequest) statsError.value = errorMessage(error)
    })
    .finally(() => {
      if (request !== statsRequest) return
      statsLoading.value = false
      pendingStatsLoad = null
    })
  pendingStatsLoad = load
  return load
}

async function refreshAll(): Promise<void> {
  await load()
  await loadStats()
}

async function setStatsWindow(windowSeconds: number): Promise<void> {
  if (statsWindow.value === windowSeconds) return
  statsWindow.value = windowSeconds
  await loadStats(false, true)
}

async function clearQueryStats(): Promise<void> {
  // 排行是统计数据，清掉之后重新累计即可，不是不可逆的破坏，所以不用红色。
  if (!await confirm.ask({
    title: '清空查询排行',
    body: '当前窗口的客户端和请求域名统计会被清零，之后重新累计。解析行为和缓存都不受影响。',
    confirmLabel: '清空排行',
  })) return
  statsClearing.value = true
  try {
    await apiRequest<StatsClearResult>('/api/v1/stats/clear', { method: 'POST' })
    toast.success('查询排行已清空')
    await loadStats(true, true)
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    statsClearing.value = false
  }
}

async function flushCache(): Promise<void> {
  if (!await confirm.ask({
    title: '清空内部缓存',
    body: `${formatNumber(displayOverview.value?.metrics.cache_entries ?? 0)} 条缓存条目会被丢弃。接下来一小段时间里这些域名要重新向上游查询，响应会变慢；解析结果本身不受影响。`,
    confirmLabel: '清空缓存',
  })) return
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

const SPARK_WIDTH = 260
const SPARK_HEIGHT = 74

/**
 * 曲线覆盖多久就说多久，而且这句话只替曲线说。写死「近 24 小时」而实际只攒了
 * 三小时，是把「还没攒够」说成了「这就是一天的量」。
 *
 * 旁边那个大数字不归它管。那是启动以来的累计，名称写明了「启动以来」，和它下面的完成率
 * 算的是同一段账。我曾让大数字跟着曲线走，于是「近 1 小时请求」底下紧跟着一行
 * 按累计算出来的完成率——两个口径挤在同一处，读者没有任何线索能看出来。
 *
 * The caption states the period the curve actually covers, and it speaks only
 * for the curve. Writing "last 24 hours" while three hours have been collected
 * would present "not enough data yet" as a full day's volume.
 *
 * The headline figure beside it is not its business: it is the lifetime total,
 * named 启动以来, on the same clock as the completion rate beneath it. Making the
 * headline follow the curve once put "requests in the last hour" directly above a
 * completion rate computed over the entire run — two different periods in one
 * place, with nothing to tell the reader they differ.
 */
const trendWindow = computed(() => {
  const trend = displayOverview.value?.trend
  if (!trend || trend.points.length === 0) return ''
  const seconds = trend.points.length * (trend.bucket_seconds || 3600)
  if (seconds >= 24 * 3600) return '近 24 小时'
  // 不满一小时就按分钟说。四舍五入到小时会把 25 分钟说成「近 0 小时」，
  // 或者更糟，说成「近 1 小时」——把刚开机说成已经跑满一小时。
  // Below an hour the caption counts minutes: rounding to hours would render 25
  // minutes as "last 0 hours" or, worse, "last 1 hour", presenting a panel just
  // started as one that has run a full hour.
  if (seconds < 3600) return `近 ${Math.max(1, Math.round(seconds / 60))} 分钟`
  return `近 ${Math.round(seconds / 3600)} 小时`
})

const trendPending = computed(() => {
  // 没运行过就没有采样可说；「启动后会怎样」页顶提示已经说了，这里和三张卡一样只写「尚无数据」
  // Never run means nothing sampled; the page notice already says what starting will do, so this reads 尚无数据 like the tiles
  if (!overview.value) return '尚无数据'
  const trend = displayOverview.value?.trend
  if (!trend || trend.points.length === 0) return '面板刚开始采样，一两分钟后显示请求量趋势'
  return '再过一会儿就能画出趋势，面板每分钟采样一次'
})

const spark = computed(() => {
  const points = displayOverview.value?.trend.points ?? []
  // 一个点连不成线，交回 null 让模板去说明原因。
  if (points.length < 2) return null
  return sparkline(points.map((point) => point.requests), SPARK_WIDTH, SPARK_HEIGHT)
})

// 信号带让这个数字独占一行，完整写出，不缩写成万/亿：读者拿到的应该是配置和日志里能对得上的那个数。
// The signal band gives this figure a line of its own and writes it in full, never as 万/亿: the reader
// should get the number they can match against the config and the logs.
const compactTotal = computed(() => {
  // 从没启动过就没有「启动以来」可数：写「—」，和下面三张卡一致 / Never started means nothing to count since start: —, as on the tiles below
  if (!overview.value) return '—'
  return formatNumber(overview.value.metrics.requests_total)
})

// 第一次读取还没结束就离开页面时，不能再装上定时器 / Leaving before the first read finishes must not install the timers afterwards
let unmounted = false
onMounted(async () => {
  await load()
  await loadStats()
  if (unmounted) return
  timer = window.setInterval(() => void load(true), 15000)
  statsTimer = window.setInterval(() => void loadStats(true), 60000)
})
onBeforeUnmount(() => {
  unmounted = true
  window.clearInterval(timer)
  window.clearInterval(statsTimer)
})
</script>

<template>
  <div class="page overview-page">
    <UiPageHeader class="overview-heading" title="概览">
      <template #meta>
        <template v-if="service">
          <span class="ui-dot" :class="{ 'ui-dot--warn': serviceTone === 'warn', 'ui-dot--err': serviceTone === 'err', 'ui-dot--off': serviceTone === 'off' }" aria-hidden="true"></span>
          <span class="ui-mono">{{ service.unit }}</span>
          <!-- 「·」收在前一段的末尾：折行只会发生在它后面，它可以在行尾，不会出现在行首（GB/T 15834）
               The 「·」 closes the segment before it, so a wrap can only fall after it: it may end a line, never start one (GB/T 15834) -->
          <span>{{ serviceLabel }}<span v-if="unusualServiceState || metaTail" class="ui-sep">·</span></span>
          <span v-if="unusualServiceState"><span class="ui-mono">{{ unusualServiceState }}</span><span v-if="metaTail" class="ui-sep">·</span></span>
          <template v-if="metaTail === 'live' && overview">
            <span>已运行 {{ formatDuration(overview.health.uptime_seconds) }}<span class="ui-sep overview-meta-time">·</span></span>
            <span class="overview-meta-time">更新于 <span class="ui-mono">{{ updatedLabel }}</span></span>
          </template>
          <span v-else-if="metaTail === 'snapshot'">快照 <span class="ui-mono">{{ snapshotLabel }}</span></span>
        </template>
        <span v-else-if="loading" class="sk overview-skeleton-meta" role="status" aria-label="读取服务状态"></span>
        <span v-else>服务状态暂不可用</span>
      </template>
      <template #actions>
        <button class="ui-icon-btn" type="button" title="刷新" aria-label="刷新" :disabled="requesting || statsLoading" @click="refreshAll">
          <RefreshCw :size="16" :class="{ spin: refreshing || statsLoading }" aria-hidden="true" />
        </button>
      </template>
    </UiPageHeader>

    <!-- 页级提示一次只一条：结论、原因（读取错误写在这里）、最多一个动作 -->
    <div v-if="notice" class="ui-notice overview-notice" :class="notice.tone === 'warn' ? '' : `ui-notice--${notice.tone}`" :role="notice.tone === 'err' ? 'alert' : 'status'">
      <component :is="notice.icon" :size="16" aria-hidden="true" />
      <span>{{ notice.title }}</span>
      <small>{{ notice.reason }}</small>
      <button v-if="notice.action === 'retry'" class="ui-btn ui-btn--secondary ui-btn--sm ui-notice__action" type="button" :disabled="requesting" @click="refreshAll">重试</button>
      <RouterLink v-else-if="notice.action === 'config'" class="ui-btn ui-btn--secondary ui-btn--sm ui-notice__action" to="/config">管理配置</RouterLink>
      <RouterLink v-else-if="notice.action === 'logs'" class="ui-btn ui-btn--secondary ui-btn--sm ui-notice__action" to="/logs">查看日志</RouterLink>
    </div>

    <!-- 读取失败又没有任何数据时不出页签：下面没有可切换的东西 / No tabs when reading failed with no data at all: there is nothing to switch between -->
    <UiTabs v-if="loading || displayOverview" v-model="activeView" class="overview-tabs" :items="views" label="概览视图" id-prefix="overview" />

    <!-- 骨架的分块照抄结果版式：信号带、三张体征卡、几行上游状态。尺寸对不上，数据到达时整页会跳。
         The skeleton copies the result's blocks: the signal band, three vital tiles, a few upstream rows. Mismatched sizes make the page jump when data arrives. -->
    <div v-if="loading" class="overview-skeleton" role="status" aria-label="正在读取运行数据">
      <div class="sk overview-skeleton-signal"></div>
      <div class="overview-skeleton-vitals"><i v-for="n in 3" :key="n" class="sk"></i></div>
      <div class="overview-skeleton-rows"><i v-for="n in 4" :key="n" class="sk"></i></div>
    </div>
    <template v-else-if="displayOverview">
      <section id="overview-panel-runtime" v-show="activeView === 'runtime'" class="overview-view" role="tabpanel" aria-labelledby="overview-tab-runtime" tabindex="0">
        <!-- 最重要的数字独占一处并带趋势。这一页第一眼该回答的只有一个问题：在变好还是变坏。
             The number that matters most sits alone with its trend: the page's first question is whether things are getting better or worse. -->
        <section class="overview-signal" aria-label="请求量">
          <div class="overview-signal-main">
            <span class="overview-signal-label">启动以来请求</span>
            <strong class="overview-total-value"><UiNumber :value="compactTotal" /></strong>
            <span class="overview-signal-sub">
              <span v-if="finishedTotal">完成 <b>{{ formatPercent(finishedShare(displayOverview.metrics.requests_finished.completed)) }}</b></span>
            </span>
          </div>
          <!-- 曲线自带时段说明。这句话只说明曲线，不去动旁边那个累计数字。 -->
          <div v-if="spark" class="overview-trend">
            <span class="overview-trend-label">{{ trendWindow }} <b>{{ formatNumber(displayOverview.trend.total) }}</b> 次</span>
            <!-- 曲线随宽度拉伸；末端圆点放在 SVG 外面按百分比定位，不跟着被拉成椭圆
                 The curve stretches with the width; the end dot sits outside the SVG, placed by percentage, so it never becomes an ellipse -->
            <div class="overview-spark-box">
              <svg class="overview-spark" :viewBox="`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`" preserveAspectRatio="none" role="img" :aria-label="trendWindow + '请求量趋势'">
                <path class="overview-spark-area" :d="spark.area" />
                <path class="overview-spark-line" :d="spark.line" />
              </svg>
              <i class="overview-spark-end" :style="{ left: `${spark.lastX / SPARK_WIDTH * 100}%`, top: `${spark.lastY / SPARK_HEIGHT * 100}%` }" aria-hidden="true"></i>
            </div>
          </div>
          <!-- 说清楚缺的是什么：缺的从来不是采样次数，是还没攒够能连成线的时间。 -->
          <p v-else class="overview-spark-pending">{{ trendPending }}</p>
        </section>

        <!-- 三张卡共用四行（名称、大数、细条、注脚）：注脚折行时三根细条也在一条线上。
             每张卡的名称都写时段：速度和健康看最近一小时，缓存命中是启动以来。
             The three tiles share four rows (name, figure, bar, footnote), so the bars stay level when a footnote wraps.
             Each tile names its period: speed and health cover the last hour, cache hits the whole run. -->
        <section class="overview-vitals" aria-label="关键指标">
          <article v-if="speed" class="overview-vital overview-vital--speed">
            <h2 class="overview-vital-label">响应速度<template v-if="speed.bands.length"> · {{ speed.period }}</template></h2>
            <template v-if="speed.bands.length">
              <p class="overview-vital-figure"><strong><UiNumber :value="speed.average.figure" /></strong><span>{{ speed.average.unit }} 平均</span></p>
              <span class="overview-meter" role="img" :aria-label="`耗时分布：${speed.spoken}`">
                <i v-for="band in speed.bands" :key="band.key" :class="`overview-meter--${band.key}`" :style="{ width: `${band.share * 100}%` }"></i>
              </span>
              <p v-if="speed.health === 'healthy'" class="overview-vital-foot"><span>10 ms 内 <b>{{ formatPercent(speed.within10) }}</b><span class="ui-sep">·</span></span><span>100 ms 内 <b>{{ formatPercent(speed.within100) }}</b></span></p>
              <p v-else class="overview-vital-foot"><span :class="`overview-text--${speed.health}`">100 ms 内 <b>{{ formatPercent(speed.within100) }}</b><span class="ui-sep">·</span></span><span>1 s 以上 <b>{{ formatSmallPercent(speed.slower) }}</b></span></p>
            </template>
            <template v-else>
              <p class="overview-vital-figure"><strong>—</strong></p>
              <span class="overview-meter is-empty" aria-hidden="true"></span>
              <p class="overview-vital-foot">{{ !overview ? '尚无数据' : precisionSupported ? '还没有请求' : '更新增强版后显示耗时' }}</p>
            </template>
          </article>
          <article class="overview-vital">
            <h2 class="overview-vital-label" title="未过期的命中与续用旧结果都算命中">缓存命中率<template v-if="cacheLookups"> · 启动以来</template></h2>
            <p class="overview-vital-figure"><strong><UiNumber v-if="cacheLookups" :value="formatPercent(cacheHitRate)" /><template v-else>—</template></strong></p>
            <span class="overview-meter" :class="{ 'is-empty': !cacheLookups }" role="img" :aria-label="`未过期命中 ${formatPercent(cacheFreshShare)}，续用旧结果 ${formatPercent(cacheStaleShare)}`">
              <i class="overview-meter--fresh" :style="{ width: `${cacheFreshShare * 100}%` }"></i><i class="overview-meter--stale" :style="{ width: `${cacheStaleShare * 100}%` }"></i>
            </span>
            <p v-if="!cacheLookups" class="overview-vital-foot">{{ overview ? '还没有查询过缓存' : '尚无数据' }}</p>
            <p v-else class="overview-vital-foot"><span>{{ formatNumber(displayOverview.metrics.cache_entries) }} 条缓存<span v-if="staleShare" class="ui-sep">·</span></span><span v-if="staleShare">续用旧结果 {{ formatPercent(staleShare) }}</span></p>
          </article>
          <article class="overview-vital">
            <h2 class="overview-vital-label">上游健康<template v-if="precisionSupported && judgedUpstreams"> · {{ ledgerPeriod }}</template></h2>
            <template v-if="precisionSupported && judgedUpstreams">
              <p class="overview-vital-figure"><strong><UiNumber :value="String(healthCounts.healthy)" /></strong><span>/ {{ upstreamRows.length }} 健康</span></p>
              <span class="overview-meter overview-meter--health" role="img" :aria-label="`健康 ${healthCounts.healthy} 个，降级 ${healthCounts.degraded} 个，异常 ${healthCounts.unhealthy} 个，观察中 ${healthCounts.pending} 个`">
                <i v-for="segment in healthSegments" :key="segment.key" :class="`overview-meter--${segment.key}`" :style="{ width: `${segment.share * 100}%` }"></i>
              </span>
              <p class="overview-vital-foot"><span v-for="(part, index) in healthFoot" :key="part.text" :class="part.tone ? `overview-text--${part.tone}` : ''">{{ part.text }}<span v-if="index < healthFoot.length - 1" class="ui-sep">·</span></span></p>
            </template>
            <template v-else>
              <p class="overview-vital-figure"><strong>—</strong></p>
              <span class="overview-meter is-empty" aria-hidden="true"></span>
              <p class="overview-vital-foot">{{ !overview ? '尚无数据' : !precisionSupported ? '更新增强版后显示健康判定' : upstreamRows.length ? `${upstreamRows.length} 个上游都在观察中，各满 ${MIN_HEALTH_SAMPLES} 次响应后判定` : '还没有上游应答过请求' }}</p>
            </template>
          </article>
        </section>

        <!-- 手动刷新时上游状态变淡；每 15 秒的定时刷新数据不动（全站约定） / Upstream status fades on a manual refresh only; timed refreshes leave the data still (site convention) -->
        <UiSection class="overview-ledger" :class="{ 'is-refreshing': refreshing }" title="上游状态" :aside="upstreamRows.length ? `${ledgerPeriod} · 成功率只算超时和连接错误` : undefined">
          <!-- 四列用于扫读：成功率、耗时、次数。错误、拒绝、TCP 兜底收进每行的展开里，是排查时才看的数。
               一行里只允许一个告警色：成功率和耗时同时染红，读者分不出到底是哪一项出了问题。
               Four columns to scan: success rate, latency, responses. Errors, refusals and TCP fallback live in each row's
               expansion — figures for troubleshooting. One warning colour per row: colouring both the rate and the latency
               leaves the reader unable to tell which one went wrong. -->
          <div v-if="upstreamRows.length" class="overview-ledger-list" :class="{ 'overview-ledger-list--no-latency': !hasLatency }">
            <!-- 读屏从每格前面的列名里知道是哪一列，表头只给眼睛看 / Screen readers get each column name inside its cell; the header row is for the eye -->
            <div class="ui-rec-head" aria-hidden="true"><span>上游</span><span>成功率</span><span v-if="hasLatency">平均耗时</span><span>响应次数</span><span></span></div>
            <template v-for="item in upstreamRows" :key="upstreamKey(item)">
              <div class="ui-rec overview-upstream" :class="{ 'is-open': expandedUpstream === upstreamKey(item) }">
                <div class="overview-upstream-id">
                  <!-- 状态点和地址块并排；地址过长时在块里折行，传输标签跟在地址末尾，不会把点单独留在一行
                       The dot sits beside an address block; a long address wraps inside the block with the transport tag
                       following it, so the dot is never left alone on a line -->
                  <span class="overview-upstream-name">
                    <i class="ui-dot overview-dot" :class="`overview-dot--${item.health}`" role="img" :aria-label="healthLabel(item.health)" :title="healthLabel(item.health)"></i>
                    <!-- 地址最后一段和传输标签绑在一起折行，标签不会单独落到下一行 / The address's last segment and the transport tag wrap together, so the tag never drops to a line of its own -->
                    <span class="overview-address"><template v-for="(part, index) in breakable(item.upstream).slice(0, -1)" :key="index"><span class="ui-mono">{{ part }}</span><wbr /></template><span class="overview-address-tail"><span class="ui-mono">{{ breakable(item.upstream).at(-1) }}</span><span class="ui-tag ui-tag--mono">{{ item.transport }}</span></span></span>
                  </span>
                </div>
                <span class="ui-rec__n" :class="`overview-text--${item.health}`"><span class="overview-sr-only">成功率 </span>{{ formatPercent(upstreamSuccessRate(item.shown)) }}</span>
                <span v-if="hasLatency" class="ui-rec__n"><span class="overview-sr-only">平均耗时 </span>{{ formatLatency(item.shown.avg_latency_ms) }}</span>
                <span class="ui-rec__n"><span class="overview-sr-only">响应 </span>{{ formatNumber(item.settled) }}<span class="overview-sr-only"> 次</span></span>
                <span class="ui-rec__act">
                  <button type="button" class="ui-icon-btn ui-icon-btn--sm overview-expand" :aria-expanded="expandedUpstream === upstreamKey(item)" :aria-label="`${item.upstream} 的错误与兜底明细`" @click="toggleUpstream(item)">
                    <ChevronRight :size="16" aria-hidden="true" />
                  </button>
                </span>
                <!-- 「·」由样式画在每项前面，行首那个被裁掉：折行后不会有点挂在行尾 / The 「·」 is drawn before each item and clipped at a line start, so a wrapped line never ends on one -->
                <p class="ui-rec__phone overview-upstream-line"><span>成功率 <b :class="`overview-text--${item.health}`">{{ formatPercent(upstreamSuccessRate(item.shown)) }}</b></span><span v-if="hasLatency">平均 {{ formatLatency(item.shown.avg_latency_ms) }}</span><span>{{ formatNumber(item.settled) }} 次响应</span></p>
              </div>
              <div v-if="expandedUpstream === upstreamKey(item)" class="overview-upstream-detail ui-rise">
                <dl class="ui-strip overview-upstream-counts">
                  <div><dt>成功</dt><dd>{{ formatNumber(item.shown.success) }}</dd></div>
                  <div><dt>错误</dt><dd>{{ formatNumber(item.shown.errors) }}</dd></div>
                  <div><dt>拒绝</dt><dd>{{ formatNumber(item.shown.rejected) }}</dd></div>
                  <div><dt>TCP 兜底</dt><dd>{{ fallbackShare(item) }}</dd></div>
                </dl>
              </div>
            </template>
          </div>
          <p v-else class="overview-empty">还没有请求转发到上游，转发后在这里按上游列出。</p>
        </UiSection>

        <!-- 三块同一种东西（主项做大、其余列表），并成一行三栏；都是启动以来的累计。
             Three blocks of one kind (the leading figure large, the rest listed) share one row; all are lifetime totals. -->
        <div class="overview-distributions" :class="{ 'is-first-empty': !pipelines.length }">
          <!-- 区块空着时不写时段和口径：说明的是一张不存在的表 / An empty block drops its period note: it would describe a table that is not there -->
          <UiSection class="overview-distribution" title="请求分布" :aside="pipelines.length ? '启动以来 · 按 Pipeline' : undefined">
            <template v-if="pipelines.length">
              <p class="overview-lead"><span class="overview-lead-share">{{ formatPercent(pipelines[0].share) }}</span><span class="overview-lead-name ui-mono">{{ pipelines[0].name }}</span><span class="overview-lead-count">{{ formatNumber(pipelines[0].count) }} 次</span></p>
              <ul v-if="pipelines.length > 1" class="overview-shares" aria-label="Pipeline 命中分布">
                <li v-for="pipeline in pipelines.slice(1)" :key="pipeline.name"><span class="ui-mono">{{ pipeline.name }}</span><span class="overview-share-count">{{ formatNumber(pipeline.count) }}</span><span>{{ formatPercent(pipeline.share) }}</span></li>
              </ul>
            </template>
            <p v-else class="overview-empty">还没有请求命中 Pipeline，命中后在这里按 Pipeline 列出。</p>
          </UiSection>
          <UiSection v-if="rcodes.length" class="overview-distribution" title="响应码分布" aside="启动以来 · 已得到结果的请求">
            <p class="overview-lead"><span class="overview-lead-share">{{ formatPercent(rcodes[0].share) }}</span><span class="overview-lead-name">{{ rcodes[0].label }}</span></p>
            <ul class="overview-shares" aria-label="响应码分布">
              <li v-for="row in rcodes.slice(1)" :key="row.key"><span>{{ row.label }}</span><span>{{ formatPercent(row.share) }}</span></li>
            </ul>
          </UiSection>
          <UiSection v-if="cacheRows.length" class="overview-distribution" title="缓存构成" aside="启动以来 · 命中按来源">
            <p class="overview-lead"><span class="overview-lead-share">{{ formatPercent(cacheRows[0].share) }}</span><span class="overview-lead-name">{{ cacheRows[0].label }}</span></p>
            <ul class="overview-shares" aria-label="缓存构成">
              <li v-for="row in cacheRows.slice(1)" :key="row.key"><span>{{ row.label }}</span><span>{{ formatPercent(row.share) }}</span></li>
            </ul>
          </UiSection>
        </div>
      </section>

      <section id="overview-panel-stats" v-show="activeView === 'stats'" class="overview-view" role="tabpanel" aria-labelledby="overview-tab-stats" tabindex="0">
        <!-- 页签已经写了「查询排行」，这里不再重复标题：这一行只说时段和总量，右边是窗口和清空。
             The tab already says 查询排行, so no repeated title: this line gives the period and the volume, with the window and clearing on the right. -->
        <!-- 统计没启用、内核不支持时，时段、总量和窗口都无从说起，整行不出 / With statistics off or unsupported there is no period, volume or window to speak of, so the line is omitted -->
        <!-- 没运行过：没有窗口、没有总量可说，工具行不出；两张表照样留着（首次安装保留完整布局），各写「尚无数据」
             Never run: no window or volume to speak of, so no toolbar; both tables stay (first install keeps the full layout), each reading 尚无数据 -->
        <div v-if="runtimeState !== 'stopped-empty' && showStatsSection && displayStats?.enabled !== false" class="overview-toolbar">
          <p><span>{{ statsWindowLabel }}<span v-if="displayStats" class="ui-sep">·</span></span><template v-if="displayStats"><span>已观察 {{ formatNumber(displayStats.requests_observed) }} 次请求<span v-if="displayStats.dropped_updates" class="ui-sep">·</span></span><span v-if="displayStats.dropped_updates">丢弃 {{ formatNumber(displayStats.dropped_updates) }} 次统计更新</span></template></p>
          <div class="overview-toolbar-tools">
            <UiTabs v-model="statsWindowKey" variant="segment" size="sm" :items="statsWindowItems" label="统计窗口" />
            <!-- 清空按钮一直在，没东西可清、读不到排行时置灰：分段不会因为它出现消失而左右跳
                 The clear button is always there, disabled with nothing to clear or no data read, so the segment never shifts -->
            <button class="ui-icon-btn ui-icon-btn--sm" type="button" title="清空查询排行" aria-label="清空查询排行" :disabled="statsClearing || runtimeControlsDisabled || !stats?.enabled || !stats.requests_observed" @click="clearQueryStats"><Eraser :size="16" aria-hidden="true" /></button>
          </div>
        </div>
        <div v-if="statsError && runtimeState !== 'stopped-empty'" class="ui-notice ui-notice--err overview-notice" role="alert">
          <CircleX :size="16" aria-hidden="true" />
          <span>查询排行读取失败</span>
          <small>{{ statsError }}</small>
          <button class="ui-btn ui-btn--secondary ui-btn--sm ui-notice__action" type="button" :disabled="statsLoading" @click="loadStats()">重试</button>
        </div>
        <UiEmpty v-if="!showStatsSection" :icon="ChartColumn" title="当前 KixDNS 不提供查询排行" desc="更新增强版后可以按客户端和域名查看请求量。" />
        <div v-else-if="displayStats?.enabled" class="overview-rankings" :class="{ 'is-loading': statsLoading }">
          <section v-for="group in rankingGroups" :key="group.id" class="overview-ranking">
            <header><h2>{{ group.title }}</h2><p>{{ group.id === 'clients' && displayStats.anonymized_clients ? '按脱敏网段聚合' : group.description }}</p></header>
            <ol v-if="displayStats[group.id].length" class="overview-ranking-list">
              <li v-for="(item, index) in displayStats[group.id]" :key="item.name">
                <span class="overview-rank">{{ String(index + 1).padStart(2, '0') }}</span>
                <strong class="ui-mono"><template v-for="(part, partIndex) in breakable(item.name)" :key="partIndex"><wbr v-if="partIndex" />{{ part }}</template></strong><span class="overview-rank-count">{{ formatNumber(item.count) }}</span>
                <i aria-hidden="true"><span :style="{ width: `${item.count / (group.id === 'clients' ? maxClient : maxDomain) * 100}%` }"></span></i>
              </li>
            </ol>
            <p v-else class="overview-empty">{{ runtimeState === 'stopped-empty' ? '尚无数据' : group.empty }}</p>
          </section>
        </div>
        <!-- 下方配置卡已有「管理配置」，这里只说开关在哪，不再放第二个去同一处的按钮
             The config card below already links to the config page; this says where the switch is instead of adding a second link -->
        <UiEmpty v-else-if="stats" :icon="ChartColumn" title="查询统计未启用" desc="在配置页「基础设置 › 查询统计」打开「启用查询排行」后，这里按客户端和域名列出请求量。" />
        <p v-else-if="!statsError" class="overview-empty">{{ statsLoading ? '正在读取查询排行' : '查询排行暂不可用' }}</p>
      </section>

      <section id="overview-panel-rules" v-show="activeView === 'rules'" class="overview-view" role="tabpanel" aria-labelledby="overview-tab-rules" tabindex="0">
        <div v-if="rules.length" class="overview-toolbar"><p><span>启动以来<span class="ui-sep">·</span></span><span>请求与响应阶段的累计执行次数</span></p></div>
        <div v-if="rules.length" class="overview-rules">
          <div class="ui-rec-head"><span>阶段</span><span>规则</span><span>Pipeline</span><span>执行次数</span></div>
          <div v-for="rule in rules" :key="`${rule.pipeline}:${rule.phase}:${rule.rule}`" class="ui-rec overview-rule">
            <span class="overview-rule-phase"><span class="ui-tag" :class="{ 'overview-phase--request': rule.phase === 'request' }">{{ rule.phase === 'request' ? '请求' : '响应' }}</span></span>
            <strong class="overview-rule-name ui-mono">{{ rule.rule }}</strong>
            <span class="overview-rule-pipeline ui-mono">{{ rule.pipeline }}</span>
            <span class="overview-rule-count">{{ formatNumber(rule.count) }}</span>
            <p class="ui-rec__phone overview-rule-line"><span class="ui-tag" :class="{ 'overview-phase--request': rule.phase === 'request' }">{{ rule.phase === 'request' ? '请求' : '响应' }}</span><span class="ui-mono">{{ rule.pipeline }}</span></p>
          </div>
        </div>
        <UiEmpty v-else :icon="ListChecks" title="还没有规则执行过" desc="请求经过 Pipeline 里的规则后，这里按执行次数列出每条规则。" />
      </section>

      <UiCard class="overview-runtime" :title="runtimeState === 'stopped-snapshot' ? '最后运行配置' : overview ? '当前运行配置' : '运行配置'">
        <template #actions><span class="ui-tag overview-config-state" :class="configTag.tone ? `ui-tag--${configTag.tone}` : ''">{{ configTag.label }}</span></template>
        <!-- 读者来这里确认的是「现在跑的是哪一代配置」：代次做主项，重载序号和补丁集是附注，两个摘要收成一条（同系统页「当前安装」）。
             What the reader checks here is which generation is running: that leads, the reload sequence and patchset qualify it,
             and the two digests share one strip (as on the system page's 当前安装). -->
        <template v-if="overview">
          <p class="overview-config-lead">配置代次 <span class="ui-mono">#{{ overview.active_config.generation }}</span></p>
          <p class="overview-config-meta"><span>重载 <span class="ui-mono">#{{ overview.active_config.reload_sequence }}</span><span class="ui-sep">·</span></span><span>补丁集 <span class="ui-mono">{{ overview.health.patchset ? `p${overview.health.patchset}` : '未记录' }}</span></span></p>
          <p v-if="!overview.active_config.last_reload.success && overview.active_config.last_reload.error" class="overview-reload-error ui-mono">{{ overview.active_config.last_reload.error }}</p>
          <dl class="ui-strip overview-config-hashes">
            <div><dt>配置摘要</dt><dd class="ui-mono" :title="overview.active_config.sha256">{{ shortHash(overview.active_config.sha256, 14) }}</dd></div>
            <div><dt>上游提交</dt><dd class="ui-mono">{{ shortHash(overview.health.upstream_commit, 12) }}</dd></div>
          </dl>
        </template>
        <!-- 没运行过就没有配置可说：一句话代替一排占位 / Never run means no configuration to report: one sentence instead of a row of placeholders -->
        <p v-else class="overview-config-empty">KixDNS 启动后显示正在运行的配置。</p>
        <template #foot>
          <!-- 按钮不能按时，左边写原因 / When the buttons cannot be used, the left side says why -->
          <!-- 各块的数字已经各自写了时段，这里不再总括一句；按钮不能按时只说什么时候能按，状态由页顶提示说
               Each block names its own period, so no blanket statement here; when the button is unavailable this says when it will be, the page notice says why -->
          <span v-if="runtimeState === 'live' && overview" class="overview-runtime-note"><span>PID <span class="ui-mono">{{ overview.health.pid }}</span></span></span>
          <span v-else class="overview-runtime-note">{{ runtimeState === 'unavailable-snapshot' ? '实时数据恢复后才能清空缓存' : 'KixDNS 运行后才能清空缓存' }}</span>
          <span class="overview-runtime-actions">
            <RouterLink class="ui-btn ui-btn--secondary ui-btn--sm" to="/config">管理配置</RouterLink>
            <button class="ui-btn ui-btn--danger ui-btn--sm" type="button" :disabled="flushing || runtimeControlsDisabled" @click="flushCache"><Eraser :size="14" aria-hidden="true" />{{ flushing ? '正在清理' : '清空内部缓存' }}</button>
          </span>
        </template>
      </UiCard>
    </template>
  </div>
</template>

<style scoped>
.overview-page { display: grid; gap: var(--s-5); color: var(--l-ink); }
.overview-page > * { min-width: 0; }
/* 「·」收在前一段里，和前一段隔开的距离由它自己补上（段与段之间的 gap 在它后面）
   The 「·」 lives inside the segment before it and supplies its own space from that segment (the gap between segments follows it) */
.overview-page .ui-sep { margin-inline-start: var(--s-2); }
.overview-skeleton-meta { width: 16rem; height: calc(var(--t-2) * var(--lh-base)); }
.overview-tabs { margin-bottom: calc(var(--s-1) * -1); }
.overview-view { display: grid; gap: var(--s-6); outline-offset: var(--s-1); }
/* 鼠标点进面板不画框，键盘进来照常显示焦点 / No ring when a panel is clicked; keyboard focus still shows */
.overview-view:focus:not(:focus-visible) { outline: none; }

/* 信号带：整页唯一一处深底，最重要的数字独占其中并带趋势。
   The signal band is the page's one dark surface: the number that matters most sits alone on it with its trend. */
/* 曲线占满大数右边的全部宽度：24 个小时桶挤在窄条里看不出起伏，中间还空出一大块深色。
   The curve takes all the width right of the figure: 24 hourly buckets squeezed into a narrow strip show no shape, and left a dark gulf in the middle. */
.overview-signal { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: var(--s-7); padding: var(--s-5); border-radius: var(--r-3); color: var(--d-ink); background: var(--d-shell); }
.overview-signal-main { min-width: 0; display: grid; gap: var(--s-2); }
.overview-signal-label, .overview-trend-label, .overview-signal-sub { color: var(--d-ink-2); font-size: var(--t-2); font-variant-numeric: tabular-nums; }
.overview-signal-sub b, .overview-trend-label b { color: var(--d-ink); font-weight: var(--w-medium); }
/* 不在数字中间断行：十位数完整写出，手机上换小一档字号而不是折行。
   Never break inside a number: ten digits are written in full, and phones take one size down rather than wrapping. */
.overview-total-value { font-family: var(--f-display); font-size: var(--t-7); font-weight: var(--w-medium); letter-spacing: -.04em; line-height: var(--lh-tight); white-space: nowrap; }
.overview-trend { min-width: 0; display: grid; gap: var(--s-2); justify-self: stretch; }
.overview-spark { display: block; width: 100%; height: var(--s-8); overflow: visible; }
/* 趋势线和大数字同色：它们说的是同一件事，分开配色会读成两条信息。 */
.overview-spark-line { fill: none; stroke: var(--d-ink); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.overview-spark-area { fill: color-mix(in srgb, var(--d-ink) 13%, transparent); stroke: none; }
.overview-spark-box { position: relative; }
.overview-spark-end { position: absolute; width: calc(var(--size-dot) - 1px); height: calc(var(--size-dot) - 1px); border-radius: var(--r-full); background: var(--d-ink); transform: translate(-50%, -50%); }
.overview-spark-pending { margin: 0; color: var(--d-ink-2); font-size: var(--t-2); line-height: var(--lh-base); }

/* 三张体征卡共用四行：名称、大数、细条、注脚。 / The three vital tiles share four rows: name, figure, bar, footnote. */
.overview-vitals { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-2) var(--s-4); }
.overview-vital { grid-row: span 4; display: grid; grid-template-rows: subgrid; row-gap: var(--s-2); min-width: 0; padding: var(--s-4) var(--s-5); border: 1px solid var(--l-hair); border-radius: var(--r-3); background: var(--l-surface); }
.overview-vital-label { margin: 0; color: var(--l-ink-2); font-size: var(--t-2); font-weight: var(--w-normal); }
.overview-vital-figure { display: flex; align-items: baseline; gap: var(--s-1) var(--s-2); margin: 0; color: var(--l-ink-3); font-size: var(--t-3); font-variant-numeric: tabular-nums; }
.overview-vital-figure strong { color: var(--l-ink); font-family: var(--f-display); font-size: var(--t-6); font-weight: var(--w-medium); letter-spacing: -.035em; line-height: var(--lh-tight); white-space: nowrap; }
.overview-vital-foot { align-self: start; display: flex; flex-wrap: wrap; gap: 0 var(--s-2); margin: 0; color: var(--l-ink-3); font-size: var(--t-2); line-height: var(--lh-base); font-variant-numeric: tabular-nums; }
.overview-vital-foot b { color: var(--l-ink-2); font-weight: var(--w-medium); }
/* 细条：一个零件，分段画。耗时是墨色深浅四档；缓存是两段墨色，空白就是未命中；健康按上游状态上色，只有它有颜色。
   The bar is one part drawn in segments: latency in four ink shades; cache in two, the gap being misses; health coloured
   by upstream status, the only bar with colour. */
.overview-meter { align-self: center; display: flex; gap: 2px; height: var(--s-1); overflow: hidden; border-radius: var(--r-full); background: var(--l-sunk); }
.overview-meter > i { display: block; height: 100%; }
.overview-meter.is-empty { visibility: hidden; }
.overview-meter--within-10ms, .overview-meter--fresh { background: var(--l-ink); }
.overview-meter--within-100ms { background: color-mix(in srgb, var(--l-ink) 55%, transparent); }
.overview-meter--within-1s, .overview-meter--stale { background: color-mix(in srgb, var(--l-ink) 30%, transparent); }
.overview-meter--slower { background: color-mix(in srgb, var(--l-ink) 15%, transparent); }
.overview-meter--health { background: transparent; }
.overview-meter--healthy { background: var(--ok-mark-l); }
.overview-meter--degraded { background: var(--warn-l); }
.overview-meter--unhealthy { background: var(--err-l); }
.overview-meter--pending { background: var(--l-ink-3); }
.overview-text--degraded { color: var(--warn-l); }
.overview-text--unhealthy { color: var(--err-l); }
/* 染色的那一项里，数值跟着染色（组件里的 b 默认是次要墨色）/ Inside a coloured item the value takes the colour too (b is otherwise the secondary ink) */
.overview-vital-foot .overview-text--degraded b, .overview-vital-foot .overview-text--unhealthy b { color: inherit; }
/* 中文只在标点和空格处折行，不把「数据」「判定」这类词拆开；实在放不下再任意断
   Chinese wraps at punctuation and spaces only, never splitting a word such as 数据; anywhere is the fallback when nothing fits */
.overview-vital-foot, .overview-view :deep(.ui-empty__desc) { word-break: keep-all; overflow-wrap: anywhere; }
.overview-upstream-line b.overview-text--degraded { color: var(--warn-l); }
.overview-upstream-line b.overview-text--unhealthy { color: var(--err-l); }

/* 上游状态：组件库的记录行。 / Upstream status uses the kit's record rows. */
/* 地址列至少 18rem、占两份，数字列各占一份：地址不被挤窄，数字也不会被推到最右边。展开条用同一套列。
   The address column gets at least 18rem and two shares, each number column one, so the address is never squeezed and the
   figures never pushed to the far edge. The expansion uses the same columns. */
.overview-ledger .ui-rec, .overview-ledger .ui-rec-head, .overview-upstream-detail { --rec-cols: minmax(18rem, 2fr) repeat(3, minmax(6.5rem, 1fr)) var(--h-sm); }
.overview-ledger-list--no-latency :is(.ui-rec, .ui-rec-head, .overview-upstream-detail) { --rec-cols: minmax(18rem, 2fr) repeat(2, minmax(6.5rem, 1fr)) var(--h-sm); }
.overview-ledger.is-refreshing .overview-ledger-list { opacity: .72; transition: opacity var(--m-quick) var(--ease-out); }
.overview-upstream-id { min-width: 0; display: grid; gap: 2px; }
.overview-upstream-name { display: flex; align-items: baseline; gap: var(--s-2); min-width: 0; }
.overview-address { min-width: 0; font-size: var(--t-3); line-height: var(--lh-base); overflow-wrap: anywhere; }
.overview-address-tail { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 2px var(--s-2); max-width: 100%; vertical-align: top; }
.overview-dot { flex: 0 0 auto; transform: translateY(-1px); }
.overview-dot--healthy { background: var(--ok-mark-l); }
.overview-dot--degraded { background: var(--warn-l); }
.overview-dot--unhealthy { background: var(--err-l); }
.overview-dot--pending { background: var(--l-ink-3); }
.overview-expand svg { transition: transform var(--m-slow) var(--ease-out); }
.overview-expand[aria-expanded="true"] svg { transform: rotate(90deg); }
.overview-upstream.is-open { border-bottom-color: transparent; }
/* 展开条：分隔线画满整行；四项排成 2×2 放在地址那一列里、和地址左边对齐，不落到右边的数字列下面（十位数的累计一行放不下四项）
   The expansion: its rule spans the row; the four figures sit 2×2 in the address column, aligned with the address, never under
   the number columns (four ten-digit totals do not fit on one line) */
.overview-upstream-detail { display: grid; grid-template-columns: var(--rec-cols); column-gap: var(--s-4); padding-bottom: var(--s-3); border-bottom: 1px solid var(--l-hair); }
.overview-upstream-detail:last-child { border-bottom: 0; }
.overview-upstream-counts { grid-column: 1; grid-template-columns: repeat(2, minmax(0, 1fr)); padding-left: calc(var(--size-dot) + var(--s-2)); font-variant-numeric: tabular-nums; }
/* 每项的「·」占项与项之间的整段空隙（点两边各 8px），行首那项的点落在左边界外、被 overflow 裁掉
   Each item's 「·」 fills the whole space between items (8px either side of the dot); the line-start item's dot falls outside
   the left edge and is clipped by overflow */
.overview-upstream-line { --sep: calc(var(--s-2) * 2 + .3em); flex-wrap: wrap; align-items: baseline; column-gap: var(--sep); margin: 0; overflow: hidden; color: var(--l-ink-3); font-size: var(--t-2); font-variant-numeric: tabular-nums; }
.overview-upstream-line > span::before { content: "·"; display: inline-block; width: var(--sep); margin-inline-start: calc(var(--sep) * -1); color: var(--l-line-strong); text-align: center; }
.overview-upstream-line b { color: var(--l-ink-2); font-weight: var(--w-medium); }

/* 分布：1200 以上并成一行，第一栏（Pipeline 名长）宽一些；响应码、缓存为空时不渲染，剩下的铺满。900–1199 和 900 以下见下面的媒体查询。
   Distributions: from 1200 up they share a row, the first (long Pipeline names) wider; empty response-code or cache blocks are
   not rendered and the rest fill the row. 900–1199 and below 900 are in the media queries further down. */
.overview-distributions { display: grid; grid-auto-flow: column; grid-template-columns: minmax(0, 1.6fr); grid-auto-columns: minmax(0, 1fr); gap: var(--s-6); align-items: start; }
.overview-distributions.is-first-empty { grid-template-columns: minmax(0, 1fr); }
.overview-distribution { align-content: start; }
.overview-lead { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-1) var(--s-2); margin: 0; }
.overview-lead-share { font-family: var(--f-display); font-size: var(--t-6); font-weight: var(--w-medium); font-variant-numeric: tabular-nums; letter-spacing: -.035em; line-height: var(--lh-tight); }
.overview-lead-name { min-width: 0; font-size: var(--t-3); font-weight: var(--w-medium); overflow-wrap: anywhere; }
.overview-lead-count { color: var(--l-ink-3); font-size: var(--t-2); font-variant-numeric: tabular-nums; }
.overview-shares { display: grid; gap: var(--s-1); margin: 0; padding: 0; list-style: none; color: var(--l-ink-2); font-size: var(--t-2); }
/* 各栏行高一致：等宽字和正文字的行各按自己的字体量高，三栏会逐行错开 / One row height across the columns: mono and body rows would each take their own font's height and drift apart */
.overview-shares li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--s-3); align-items: baseline; min-height: calc(var(--t-2) * var(--lh-base)); line-height: var(--lh-base); }
.overview-shares li > * { line-height: inherit; }
.overview-shares li:has(.overview-share-count) { grid-template-columns: minmax(0, 1fr) auto 3.5rem; }
.overview-shares li > span:first-child { min-width: 0; overflow-wrap: anywhere; }
.overview-shares li > span:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; }
.overview-share-count { color: var(--l-ink-3); }

/* 查询排行、规则命中：页签下一行说明，右边工具。 / Stats and rules: a line under the tabs, tools on the right. */
.overview-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s-2) var(--s-4); }
.overview-toolbar p, .overview-config-meta, .overview-runtime-note { display: flex; flex-wrap: wrap; gap: 0 var(--s-2); margin: 0; color: var(--l-ink-3); font-size: var(--t-2); font-variant-numeric: tabular-nums; }
.overview-toolbar-tools { display: flex; align-items: center; gap: var(--s-2); }
.overview-rankings { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-6); transition: opacity var(--m-quick) var(--ease-out); }
.overview-rankings.is-loading { opacity: .5; }
.overview-ranking { min-width: 0; }
.overview-ranking h2 { margin: 0; font-family: var(--f-display); font-size: var(--t-4); font-weight: var(--w-bold); }
.overview-ranking header p { margin: var(--s-1) 0 var(--s-3); color: var(--l-ink-3); font-size: var(--t-2); }
.overview-ranking-list { margin: 0; padding: 0; list-style: none; }
.overview-ranking-list li { display: grid; grid-template-columns: var(--s-5) minmax(0, 1fr) auto; gap: var(--s-1) var(--s-2); align-items: baseline; padding: var(--s-3) 0; border-bottom: 1px solid var(--l-hair); }
.overview-ranking-list li:last-child { border-bottom: 0; }
.overview-rank { color: var(--l-ink-3); font-family: var(--f-mono); font-size: var(--t-1); }
.overview-ranking-list strong { min-width: 0; font-size: var(--t-3); font-weight: var(--w-medium); overflow-wrap: anywhere; }
.overview-rank-count { font-size: var(--t-2); font-variant-numeric: tabular-nums; }
.overview-ranking-list li > i { grid-column: 2 / -1; height: 3px; background: var(--l-hair); }
.overview-ranking-list i > span { display: block; height: 100%; background: var(--ok-mark-l); }

/* 表头和各行共用一套列宽：规则名那一列按内容定宽，Pipeline 紧跟在后面，次数靠右。
   组件库把首列以外的表头都右对齐，这里只有次数是数字列，规则和 Pipeline 的表头改回左对齐。
   Head and rows share one set of columns: the rule column fits its content, Pipeline follows right after, the count sits right.
   The kit right-aligns every heading after the first; here only the count is numeric, so the rule and Pipeline headings align left. */
.overview-rules { display: grid; grid-template-columns: auto fit-content(45%) minmax(0, 1fr) auto; column-gap: var(--s-6); }
.overview-rules .ui-rec, .overview-rules .ui-rec-head { grid-column: 1 / -1; grid-template-columns: subgrid; column-gap: inherit; }
.overview-rules .ui-rec-head > :nth-child(2), .overview-rules .ui-rec-head > :nth-child(3) { text-align: left; }
.overview-rule { align-items: baseline; }
.overview-rule-name { min-width: 0; font-size: var(--t-3); font-weight: var(--w-medium); overflow-wrap: anywhere; }
.overview-rule-pipeline { min-width: 0; color: var(--l-ink-3); font-size: var(--t-2); overflow-wrap: anywhere; }
.overview-rule-count { text-align: right; font-variant-numeric: tabular-nums; }
/* 「请求」阶段标签用已发布的绿，保留。 / The 请求 phase tag keeps its released green. */
.overview-phase--request { color: var(--ok-l); border-color: var(--ok-line-l); }
.overview-rule-line { align-items: center; gap: var(--s-2); margin: 0; color: var(--l-ink-3); font-size: var(--t-2); }

/* 和系统页「当前安装」同一种叠法：主项、附注、细线下的摘要条 / Stacked as on the system page's 当前安装: lead, qualifiers, digests under a hairline */
.overview-runtime :deep(.ui-card__body) { display: grid; gap: var(--s-1); }
.overview-config-empty { margin: 0; color: var(--l-ink-3); font-size: var(--t-2); }
.overview-config-lead { margin: 0; color: var(--l-ink-2); font-size: var(--t-3); }
.overview-config-lead .ui-mono { color: var(--l-ink); font-family: var(--f-display); font-size: var(--t-6); font-weight: var(--w-medium); letter-spacing: -.035em; }
.overview-reload-error { margin: var(--s-1) 0 0; color: var(--warn-l); font-size: var(--t-2); overflow-wrap: anywhere; }
/* 细线画满卡片，两项限宽 / The rule spans the card; the two items are capped */
.overview-config-hashes { grid-template-columns: repeat(2, minmax(0, 18rem)); margin-top: var(--s-3); padding-top: var(--s-3); border-top: 1px solid var(--l-hair); }
.overview-runtime-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2); }

.overview-empty { margin: 0; padding: var(--s-5) 0; color: var(--l-ink-3); font-size: var(--t-2); }
/* 骨架按结果实测的尺寸画（1280：信号带 158、卡 136；641–899：卡 156；375：信号带 209、卡 128），间距同 .overview-view
   The skeleton uses the result's measured sizes (1280: band 158, tiles 136; 641–899: tiles 156; 375: band 209, tiles 128), spaced as .overview-view */
.overview-skeleton { display: grid; gap: var(--s-6); }
.overview-skeleton-signal { height: calc(var(--s-8) * 2 + var(--s-5) + 6px); border-radius: var(--r-3); }
.overview-skeleton-vitals { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-4); }
.overview-skeleton-vitals i { height: calc(var(--s-8) * 2 + var(--s-2)); border-radius: var(--r-3); }
/* 和 UiSection 一样从细线下开始 / Starts under a hairline, as UiSection does */
.overview-skeleton-rows { display: grid; gap: var(--s-6); padding-top: var(--s-5); border-top: 1px solid var(--l-hair); }
.overview-skeleton-rows i { width: 60%; height: var(--s-3); }
.overview-skeleton-rows i:first-child { width: 8rem; height: var(--t-4); }
.overview-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

/* 900–1199：请求分布独占一行（内容限宽，数字不离名字太远），下面响应码和缓存构成两栏等宽；只剩一块时铺满
   900–1199: the request distribution takes its own row (content capped so figures stay near names), response codes and cache
   share the row below in equal halves; a block left alone fills the row */
@media (max-width: 1199px) {
  .overview-distributions, .overview-distributions.is-first-empty { grid-auto-flow: row; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .overview-distribution:first-child, .overview-distribution:nth-child(2):last-child { grid-column: 1 / -1; }
  .overview-distribution:first-child :is(.overview-lead, .overview-shares) { max-width: 40rem; }
}
/* 900 以下：上游状态和规则换成两行式（四列挤不下），第二行和展开条都和地址对齐；分布一块一行，标题满宽，内容限宽
   Below 900: upstream status and rules turn to two-line rows (four columns no longer fit), with the second line and the expansion
   aligned to the address; distributions stack, headings full width, content capped */
@media (max-width: 899px) {
  .overview-ledger .ui-rec, .overview-ledger-list--no-latency :is(.ui-rec, .overview-upstream-detail), .overview-upstream-detail { --rec-cols: minmax(0, 1fr) var(--h-touch); }
  .overview-ledger .ui-rec { row-gap: var(--s-1); }
  .overview-ledger .ui-rec-head, .overview-ledger .ui-rec__n { display: none; }
  .overview-ledger .ui-rec__phone { display: flex; grid-column: 1; padding-left: calc(var(--size-dot) + var(--s-2)); }
  /* 裁剪边界要落在文字起点：这一行用外边距对齐地址，不用内边距 / The clip edge must sit where the text starts, so this line aligns with a margin, not padding */
  .overview-ledger .overview-upstream-line { margin-left: calc(var(--size-dot) + var(--s-2)); padding-left: 0; }
  .overview-upstream .ui-rec__act { grid-row: 1 / span 2; grid-column: 2; }
  .overview-distributions, .overview-distributions.is-first-empty { grid-template-columns: minmax(0, 1fr); }
  .overview-lead, .overview-shares { max-width: 40rem; }
  .overview-rules { grid-template-columns: minmax(0, 1fr) auto; column-gap: var(--s-4); }
  .overview-rules .ui-rec-head, .overview-rule-phase, .overview-rule-pipeline { display: none; }
  .overview-rules .ui-rec__phone { display: flex; grid-column: 1 / -1; }
  .overview-rule { row-gap: var(--s-1); }
}
@media (min-width: 641px) and (max-width: 899px) {
  .overview-skeleton-vitals i { height: calc(var(--s-8) * 2 + var(--s-2) + 20px); }
}

@media (max-width: 640px) {
  .overview-page { gap: var(--s-4); }
  .overview-meta-time { display: none; }
  /* 小屏上块与块之间收紧：细线上下各 12（24/24 加上行高，一屏里空出近 60）。再紧到 8，标题就离上一块比离自己的数字还近
     Tighter between blocks on a phone: 12 above and below each hairline (24/24 plus leading left nearly 60 empty). At 8 a
     heading sits closer to the block above than to its own figure */
  .overview-view { gap: var(--s-3); }
  .overview-view .ui-section { padding-top: var(--s-3); }
  /* 上游最后一行（或它的展开条）不再自带下内边距，和下面的块也只隔 12 / The last upstream row (or its expansion) drops its bottom padding, so it too sits 12 above the next block */
  .overview-ledger-list > :last-child { padding-bottom: 0; }
  .overview-signal { grid-template-columns: minmax(0, 1fr); gap: var(--s-3); padding: var(--s-4); }
  .overview-total-value { font-size: var(--t-6); }
  .overview-spark { height: var(--s-7); }
  .overview-vitals, .overview-skeleton-vitals { grid-template-columns: minmax(0, 1fr); }
  .overview-skeleton-signal { height: calc(var(--s-8) * 3 + var(--s-4) + 1px); }
  .overview-skeleton-vitals i { height: calc(var(--s-8) * 2); }
  .overview-skeleton-meta { height: calc(var(--t-2) * var(--lh-base) * 2 + 2px); }
  .overview-skeleton { gap: var(--s-3); }
  .overview-skeleton-vitals { gap: var(--s-2); }
  .overview-vital { padding: var(--s-3) var(--s-4); }
  .overview-toolbar { align-items: stretch; }
  .overview-toolbar-tools { width: 100%; justify-content: space-between; }
  .overview-rankings { grid-template-columns: minmax(0, 1fr); gap: var(--s-3); }
  /* 三块分布叠起来时和整页一样隔 12 / Stacked distributions keep the page's 12 rhythm */
  .overview-distributions { gap: var(--s-3); }
  .overview-toolbar-tools > .ui-seg { flex: 1; }
  .overview-runtime-actions { width: 100%; }
  .overview-runtime-actions > * { flex: 1 1 0; }
}
</style>
