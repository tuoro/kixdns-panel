<script setup lang="ts">
import { ChartColumn, CircleAlert, CircleX, Eraser, ListChecks, Power, RefreshCw, SlidersHorizontal } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { apiRequest } from '../api/client'
import type { CacheFlushResult, Overview, QueryStatsSnapshot, ServiceStatus, StatsClearResult } from '../api/types'
import UiDotText from '../components/ui/UiDotText.vue'
import UiEmpty from '../components/ui/UiEmpty.vue'
import UiNumber from '../components/ui/UiNumber.vue'
import UiPageHeader from '../components/ui/UiPageHeader.vue'
import UiTabs from '../components/ui/UiTabs.vue'
import { useConfirm } from '../composables/useConfirm'
import { useToast } from '../composables/useToast'
import { HEALTH_LABELS, cacheComposition, pipelineDistribution, rcodeDistribution, latencyBasis, recentWindowLabel, settledAttempts, upstreamBasis, upstreamHealth } from '../dashboard-presentation'
import type { ShareRow, UpstreamHealth } from '../dashboard-presentation'
import { dashboardRuntimeState, emptyOverview, emptyQueryStats, hasStaleDashboardData, supportsQueryStats, supportsUpstreamPrecision } from '../dashboard-state'
import { sparkline } from '../trend'
import { softBreakOffsets } from '../ui/soft-breaks'
import { errorMessage, formatDuration, formatNumber, formatPercent, shortHash, upstreamSuccessRate } from '../utils'

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


// ---------- 查询量卡：启动以来的累计，三项小计里成功率、缓存命中和它同一段账，延迟单独写时段 ----------
// ---------- Volume card: the lifetime total; of the three sub-figures, success and cache hits share its clock, latency names its own ----------
const finishedTotal = computed(() => {
  const finished = displayOverview.value?.metrics.requests_finished
  return finished ? finished.completed + finished.failed + finished.cancelled : 0
})
const finishedShare = (value: number) => (finishedTotal.value ? value / finishedTotal.value : 0)

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
// 平均延迟和上游状态一样看最近一小时；这一小时请求不够时退回启动以来的累计，名称照实写。
// Average latency covers the last hour like upstream status; with too few requests it falls back to the lifetime total, and the name says so.
const speed = computed(() => {
  const metrics = displayOverview.value?.metrics
  if (!metrics) return null
  const basis = latencyBasis(metrics)
  if (basis.latency.samples === 0) return null
  return { period: basis.recent ? recentWindowLabel(recentWindow.value) : '启动以来', average: latencyParts(basis.latency.avg_ms) }
})
const cacheLookups = computed(() => displayOverview.value?.metrics.cache_lookups_total ?? 0)
const cacheHitRate = computed(() => {
  const metrics = displayOverview.value?.metrics
  return metrics && cacheLookups.value ? (metrics.cache_hits_fresh + metrics.cache_hits_stale) / cacheLookups.value : 0
})

// ---------- 上游状态 ----------
// 每行的成功率、耗时、次数和明细都取同一个依据：最近一小时，响应不够时是启动以来的累计。
// 排序始终按累计响应次数，免得列表随窗口来回跳。
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
// 每一行都退回了累计时，整张卡的时段改写成启动以来；只有部分退回时不逐行标注
// When every row fell back to the lifetime total the card names the whole run as its period; when only some did, the rows are not marked
const allSinceStart = computed(() => upstreamRows.value.length > 0 && upstreamRows.value.every((item) => item.sinceStart))
const ledgerPeriod = computed(() => (allSinceStart.value ? '启动以来' : recentWindowLabel(recentWindow.value)))
// 上游状态里有没有耗时：旧增强版整列都没有，右边就写成功率，也不画细条 / Whether there is latency at all: old enhanced builds have none, so the right end shows the success rate and no bar is drawn
const hasLatency = computed(() => upstreamRows.value.some((item) => item.shown.avg_latency_ms !== null))
// 最慢的上游定细条的满格：每条细条的长度是该上游平均耗时占最慢那个的比例
// The slowest upstream sets the full bar: each bar's length is that upstream's average latency as a share of the slowest
const slowestLatency = computed(() => Math.max(0, ...upstreamRows.value.map((item) => item.shown.avg_latency_ms ?? 0)))
function latencyShare(item: { shown: { avg_latency_ms: number | null } }): number {
  return slowestLatency.value && item.shown.avg_latency_ms !== null ? item.shown.avg_latency_ms / slowestLatency.value : 0
}
// 页头的上游事实：个数，后面跟一句判定汇总——全部正常，或各有几个降级、异常、观察中
// The header's upstream fact: the count, then one summary of the verdicts: all healthy, or how many are degraded, unhealthy, still observed
const upstreamFact = computed<string[]>(() => {
  const total = upstreamRows.value.length
  if (!total) return []
  const parts = [`${total} 个`]
  if (!precisionSupported.value) return parts
  const { degraded, unhealthy, pending } = healthCounts.value
  if (degraded) parts.push(`${degraded} 个降级`)
  if (unhealthy) parts.push(`${unhealthy} 个异常`)
  if (pending) parts.push(`${pending} 个观察中`)
  if (parts.length === 1) parts.push('全部正常')
  return parts
})
const upstreamKey = (item: { upstream: string; transport: string }) => `${item.upstream}:${item.transport}`
function healthLabel(health: UpstreamHealth): string {
  return precisionSupported.value ? HEALTH_LABELS[health] : '不支持判定'
}
function fallbackShare(item: { transport: string; settled: number; shown: { tcp_fallbacks: number } }): string {
  return item.transport === 'udp' && item.settled > 0 ? formatPercent(item.shown.tcp_fallbacks / item.settled) : '—'
}
// 错误、拒绝、TCP 兜底是排查时才看的数，收进这一行的悬停提示里 / Errors, refusals and TCP fallback are troubleshooting figures and live in the row's hover title
function upstreamTitle(item: { transport: string; settled: number; shown: { success: number; errors: number; rejected: number; tcp_fallbacks: number } }): string {
  const parts = [`成功 ${formatNumber(item.shown.success)}`, `错误 ${formatNumber(item.shown.errors)}`, `拒绝 ${formatNumber(item.shown.rejected)}`]
  if (item.transport === 'udp') parts.push(`TCP 兜底 ${fallbackShare(item)}`)
  return parts.join('，')
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

// ---------- 三张分布卡：全是启动以来的累计，每行一个名字、「次数 · 占比」和一条细条 ----------
// ---------- Three distribution cards: all lifetime totals, each row a name, 「count · share」 and a bar ----------
interface ShareCard { key: string; title: string; note: string[]; mono?: boolean; rows: ShareRow[]; empty: string }
const pipelines = computed(() => pipelineDistribution(displayOverview.value?.metrics.pipelines ?? []))
const shareCards = computed<ShareCard[]>(() => [
  { key: 'pipelines', title: '请求分布', note: ['启动以来', '按 Pipeline'], mono: true, rows: pipelines.value.map((row) => ({ key: row.name, label: row.name, count: row.count, share: row.share })), empty: overview.value ? '还没有请求命中 Pipeline，命中后在这里按 Pipeline 列出。' : '尚无数据' },
  { key: 'rcodes', title: '响应码分布', note: ['启动以来', '已得到结果的请求'], rows: rcodeDistribution(displayOverview.value?.metrics.upstreams ?? []), empty: '' },
  { key: 'cache', title: '缓存构成', note: ['启动以来', '命中按来源'], rows: displayOverview.value ? cacheComposition(displayOverview.value.metrics) : [], empty: '' },
])
// 请求分布一直在右栏；响应码和缓存构成空着时不出卡（说明的是一张不存在的表），有的和运行配置并成底下一排
// Request distribution always sits in the right column; empty response-code and cache cards are not drawn (they would describe a table that is not there), the rest share the bottom row with the running configuration
const pairCards = computed(() => shareCards.value.slice(1).filter((card) => card.rows.length))

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

// 传输方式和配置页的协议名写法一致（UDP、TCP+UDP、DoH），不显示接口里的小写机器值
// Transports read like the config page's protocol names (UDP, TCP+UDP, DoH) rather than the API's lowercase machine values
const TRANSPORT_LABELS: Record<string, string> = { udp: 'UDP', tcp: 'TCP', tcp_udp: 'TCP+UDP', doh: 'DoH', dot: 'DoT', doq: 'DoQ', h3: 'DoH3' }
function transportLabel(transport: string): string { return TRANSPORT_LABELS[transport] ?? transport }

const SPARK_WIDTH = 260
const SPARK_HEIGHT = 56

/**
 * 曲线覆盖多久就说多久，而且这句话只替曲线说。写死「近 24 小时」而实际只攒了
 * 三小时，是把「还没攒够」说成了「这就是一天的量」。
 *
 * 旁边那个大数字不归它管。那是启动以来的累计，名称写明了「启动以来」，和它下面的成功率
 * 算的是同一段账。我曾让大数字跟着曲线走，于是「近 1 小时请求」底下紧跟着一行
 * 按累计算出来的完成率——两个口径挤在同一处，读者没有任何线索能看出来。
 *
 * The caption states the period the curve actually covers, and it speaks only
 * for the curve. Writing "last 24 hours" while three hours have been collected
 * would present "not enough data yet" as a full day's volume.
 *
 * The headline figure beside it is not its business: it is the lifetime total,
 * named 启动以来, on the same clock as the success rate beneath it. Making the
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
  // 没运行过就没有采样可说；「启动后会怎样」页顶提示已经说了，这里和大数字一样只写「尚无数据」
  // Never run means nothing sampled; the page notice already says what starting will do, so this reads 尚无数据 like the figure
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
// 最后一个桶是不是正在进行的这一小时 / Whether the last bucket is the hour still in progress
const lastIsNow = computed(() => {
  const trend = displayOverview.value?.trend
  const last = trend?.points.at(-1)?.start_unix
  return last !== undefined && Date.now() / 1000 - last < (trend?.bucket_seconds || 3600) * 1.5
})
// 正在进行的这一小时还没攒满，最后一段画成虚线，读者不会把它读成流量骤降
// The hour in progress is not full yet, so the last segment is dashed and never reads as traffic collapsing
const sparkPaths = computed(() => {
  const curve = spark.value?.curve ?? ''
  const parts = curve.split(' C')
  if (!lastIsNow.value || parts.length < 3) return { solid: curve, live: '' }
  const end = parts.at(-2)!.match(/-?[\d.]+/g)!.slice(-2)
  return { solid: parts.slice(0, -1).join(' C'), live: `M${end[0]},${end[1]} C${parts.at(-1)}` }
})
// 曲线的量级：最忙那个桶的请求数，写在柱图的标题行右端 / The curve's magnitude: the busiest bucket's requests, at the right end of the bar chart's title row
const sparkPeak = computed(() => Math.max(0, ...(displayOverview.value?.trend.points ?? []).map((point) => point.requests)))
// 桶是一小时才叫「最忙一小时」，否则说「最忙时段」 / Only hourly buckets are called 最忙一小时; other bucket sizes say 最忙时段
const peakLabel = computed(() => ((displayOverview.value?.trend.bucket_seconds || 3600) === 3600 ? '最忙一小时' : '最忙时段'))

// ---------- 每小时查询：趋势的每个桶画一根柱，和上面的曲线是同一份采样 ----------
// ---------- Hourly queries: one bar per trend bucket, the same samples as the curve above ----------
// 两条虚线网格落在整数刻度上：取不超过峰值一半的那个「整」数（1、2、2.5、5 乘十的幂）作一格，画一格和两格；柱顶上方留 4%
// The two dashed gridlines sit on round values: the largest round number (1, 2, 2.5, 5 times a power of ten) not above half the peak is one step, drawn at one and two steps; 4% headroom above the tallest bar
function roundStep(value: number): number {
  if (value <= 0) return 0
  const base = 10 ** Math.floor(Math.log10(value))
  const mantissa = value / base
  return (mantissa >= 5 ? 5 : mantissa >= 2.5 ? 2.5 : mantissa >= 2 ? 2 : 1) * base
}
const barScale = computed(() => {
  const top = sparkPeak.value * 1.04
  const step = roundStep(sparkPeak.value / 2)
  return { top, lines: step ? [step, step * 2].map((value) => ({ value, share: value / top })) : [] }
})
const bars = computed(() => (displayOverview.value?.trend.points ?? []).map((point, index, points) => ({
  key: point.start_unix,
  share: barScale.value.top ? point.requests / barScale.value.top : 0,
  live: lastIsNow.value && index === points.length - 1,
  title: `${clock(point.start_unix * 1000, false)} 起 ${formatNumber(point.requests)} 次`,
})))
// 网格的刻度值按万、亿缩写：这里只标量级，精确的数在柱子的提示和上面的卡里
// Gridline values abbreviate to 万 and 亿: they only give the scale; exact figures are in the bars' titles and the card above
function compactCount(value: number): string {
  const trim = (n: number) => String(Math.round(n * 10) / 10)
  if (value >= 1e8) return `${trim(value / 1e8)} 亿`
  if (value >= 1e4) return `${trim(value / 1e4)} 万`
  return formatNumber(value)
}

// 柱图大约有多宽，用来丢掉放不下的刻度字：手机是整张卡减去内边距；宽屏是左栏（版心最宽 1280，减右栏和 20 的间距）减去内边距
// Roughly how wide the bar chart is, for dropping axis labels that cannot fit: the card minus its padding on a phone; on wide screens the left column (the 1280 measure less the right column and the 20 gutter) minus the padding
const viewportWidth = ref(typeof window === 'undefined' ? 1440 : window.innerWidth)
const onViewportResize = () => { viewportWidth.value = window.innerWidth }
const chartPixels = computed(() => {
  const vw = viewportWidth.value
  if (vw < 641) return vw - 64
  const measure = Math.min(vw - 232 - 64, 1280)
  if (vw < 900) return measure - 40
  return measure - (vw < 1200 ? 360 : 440) - 20 - 40
})

// 柱图的时间刻度：本地整点，每 1/2/3/6 小时一个（最多四个），按时间落在所属那根柱子里的位置；右端写「现在 HH:MM」，
// 采样停过时右端改写最后一个桶的整点，不让旧数据看起来像现在。放不下的刻度字直接去掉：会压住右端那个字的不要
// The bar chart's time ticks: local whole hours every 1/2/3/6 hours (at most four), each placed by time inside its bucket's bar;
// the right end reads 现在 HH:MM, or the last bucket's hour after a sampling gap so old data never pass for now. A label that
// cannot fit is dropped: none may run into the right-end label
interface AxisTick { x: number; label: string; end?: boolean; start?: boolean }
const axisTicks = computed<AxisTick[]>(() => {
  const trend = displayOverview.value?.trend
  const points = trend?.points ?? []
  if (!trend || points.length < 2) return []
  const bucket = trend.bucket_seconds || 3600
  const first = points[0].start_unix
  const last = points[points.length - 1].start_unix
  const span = last - first
  if (span <= 0) return []
  const isNow = lastIsNow.value
  const ticks: AxisTick[] = [{ x: 1, label: isNow ? `现在 ${clock(Date.now(), false)}` : `${new Date(last * 1000).getHours()}:00`, end: true }]
  const stepHours = [1, 2, 3, 6].find((hours) => span / (hours * 3600) <= 4.5)
  if (!stepHours) return ticks
  const px = chartPixels.value
  let index = 0
  for (let at = Math.ceil(first / 3600) * 3600; at < last + bucket; at += 3600) {
    const date = new Date(at * 1000)
    if (date.getHours() % stepHours !== 0) continue
    while (index + 1 < points.length && points[index + 1].start_unix <= at) index += 1
    const from = points[index].start_unix
    // 落在采样断档里的整点没有柱子可挂，不画 / A whole hour inside a sampling gap has no bar to hang on and is skipped
    if (at >= from + bucket) continue
    const x = (index + (at - from) / bucket) / points.length
    if ((1 - x) * px < (isNow ? 84 : 56)) continue
    // 字居中在它的时刻上；离左端不到 18 时改为从那里向右写，不越出卡片 / Centred on its moment; within 18 of the left end it runs rightward from there instead of passing the card edge
    ticks.push({ x, label: `${date.getHours()}:00`, start: x * px < 18 })
  }
  return ticks.sort((a, b) => a.x - b.x)
})

// 大数字独占一行，完整写出，不缩写成万/亿：读者拿到的应该是配置和日志里能对得上的那个数。
// The figure has a line of its own and is written in full, never as 万/亿: the reader should get the number they can match
// against the config and the logs.
const compactTotal = computed(() => {
  // 从没启动过就没有「启动以来」可数：写「—」，和三项小计一致 / Never started means nothing to count since start: —, as in the three sub-figures
  if (!overview.value) return '—'
  return formatNumber(overview.value.metrics.requests_total)
})

// 第一次读取还没结束就离开页面时，不能再装上定时器 / Leaving before the first read finishes must not install the timers afterwards
let unmounted = false
onMounted(async () => {
  window.addEventListener('resize', onViewportResize, { passive: true })
  await load()
  await loadStats()
  if (unmounted) return
  timer = window.setInterval(() => void load(true), 15000)
  statsTimer = window.setInterval(() => void loadStats(true), 60000)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onViewportResize)
  unmounted = true
  window.clearInterval(timer)
  window.clearInterval(statsTimer)
})
</script>

<template>
  <div class="page overview-page">
    <UiPageHeader class="overview-heading" title="概览">
      <template #meta>
        <!-- 事实行：标签在上、值在下，一项一件事；宽屏排成一行，手机两项一行
             The facts row: label over value, one thing per item; one line on wide screens, two per line on a phone -->
        <div v-if="service || displayOverview" class="ui-facts overview-facts">
          <div>
            <span class="ui-lbl">状态</span>
            <b :title="service?.unit"><span class="ui-dot" :class="{ 'ui-dot--warn': serviceTone === 'warn', 'ui-dot--err': serviceTone === 'err', 'ui-dot--off': serviceTone === 'off' }" aria-hidden="true"></span>{{ service ? serviceLabel : '暂不可用' }}<small v-if="unusualServiceState" class="ui-mono">{{ unusualServiceState }}</small></b>
          </div>
          <div v-if="metaTail === 'live' && overview"><span class="ui-lbl">已运行</span><b>{{ formatDuration(overview.health.uptime_seconds) }}</b></div>
          <div v-else-if="metaTail === 'snapshot'"><span class="ui-lbl">快照</span><b>{{ snapshotLabel }}</b></div>
          <div v-if="overview"><span class="ui-lbl">配置版本</span><b>#{{ overview.active_config.generation }}</b></div>
          <div v-if="upstreamFact.length"><span class="ui-lbl">上游</span><b><UiDotText :parts="upstreamFact" /></b></div>
          <div v-if="metaTail === 'live'" class="overview-meta-time"><span class="ui-lbl">更新于</span><b>{{ updatedLabel }}</b></div>
        </div>
        <span v-else-if="loading" class="sk overview-skeleton-meta" role="status" aria-label="读取服务状态"></span>
        <span v-else>服务状态暂不可用</span>
      </template>
      <template #actions>
        <button class="ui-btn ui-btn--secondary ui-btn--icon" type="button" title="刷新" aria-label="刷新" :disabled="requesting || statsLoading" @click="refreshAll">
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

    <!-- 骨架的分块照抄结果版式：左栏两张图卡、右栏两张列表卡。尺寸对不上，数据到达时整页会跳。
         The skeleton copies the result's blocks: two chart cards on the left, two list cards on the right. Mismatched sizes make the page jump when data arrives. -->
    <div v-if="loading" class="overview-skeleton" role="status" aria-label="正在读取运行数据">
      <div class="overview-skeleton-col"><i class="sk overview-skeleton-stat"></i><i class="sk overview-skeleton-bars"></i></div>
      <div class="overview-skeleton-col"><i class="sk overview-skeleton-list"></i><i class="sk overview-skeleton-list"></i></div>
    </div>
    <template v-else-if="displayOverview">
      <section id="overview-panel-runtime" v-show="activeView === 'runtime'" class="overview-view" role="tabpanel" aria-labelledby="overview-tab-runtime" tabindex="0">
        <div class="overview-grid" :class="{ 'is-empty': !overview }">
          <div class="overview-col">
            <!-- 最重要的数字独占一张卡并带趋势。这一页第一眼该回答的只有一个问题：在变好还是变坏。
                 The number that matters most has a card of its own with its trend: the page's first question is whether things are getting better or worse. -->
            <section class="ui-card overview-card overview-card--volume" aria-label="查询量">
              <div class="overview-card-head">
                <h2 class="ui-card__label ui-dots"><span>查询量</span><span v-if="overview">启动以来</span></h2>
                <!-- 曲线自带时段说明。这句话只说明曲线，不去动旁边那个累计数字。 -->
                <span v-if="spark" class="overview-card-note overview-trend-label">{{ trendWindow }} <b>{{ formatNumber(displayOverview.trend.total) }}</b> 次</span>
              </div>
              <p class="overview-total"><strong class="overview-total-value"><UiNumber :value="compactTotal" /></strong><small v-if="overview">次</small></p>
              <!-- 三项小计共用两行（名称、数），细线隔开；只有延迟的时段和卡不同，它自己写 / Three sub-figures on two shared rows (name, figure) between hairlines; only latency's period differs from the card's, so it names it -->
              <dl class="overview-subs">
                <div><dt class="ui-lbl">成功率</dt><dd><UiNumber v-if="finishedTotal" :value="formatPercent(finishedShare(displayOverview.metrics.requests_finished.completed))" /><template v-else>—</template></dd></div>
                <div><dt class="ui-lbl">缓存命中</dt><dd><UiNumber v-if="cacheLookups" :value="formatPercent(cacheHitRate)" /><template v-else>—</template></dd></div>
                <div><dt class="ui-lbl ui-dots"><span>平均延迟</span><span v-if="speed">{{ speed.period }}</span></dt><dd><template v-if="speed"><UiNumber :value="speed.average.figure" /> <small>{{ speed.average.unit }}</small></template><template v-else>—</template></dd></div>
              </dl>
              <!-- 曲线贴着卡片的左右和底边；正在进行的这一小时画成虚线 / The curve runs to the card's left, right and bottom edges; the hour in progress is dashed -->
              <div v-if="spark" class="overview-spark-box">
                <svg class="overview-spark" :viewBox="`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`" preserveAspectRatio="none" role="img" :aria-label="trendWindow + '请求量趋势'">
                  <defs><linearGradient id="overview-spark-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".22" /><stop offset="1" stop-color="currentColor" stop-opacity="0" /></linearGradient></defs>
                  <path class="overview-spark-area" :d="spark.curveArea" />
                  <path class="overview-spark-line" :d="sparkPaths.solid" />
                  <path v-if="sparkPaths.live" class="overview-spark-line overview-spark-line--live" :d="sparkPaths.live" />
                </svg>
              </div>
              <!-- 说清楚缺的是什么：缺的从来不是采样次数，是还没攒够能连成线的时间。 -->
              <p v-else class="overview-spark-pending">{{ trendPending }}</p>
            </section>

            <!-- 每小时查询：同一份采样按桶画柱；最后一根是正在进行的这一小时，画淡。卡片撑到和右栏一样高，柱图跟着长高
                 Hourly queries: the same samples drawn as one bar per bucket; the last bar is the hour in progress, drawn faint. The card stretches to the right column's height and the chart grows with it -->
            <section class="ui-card overview-card overview-card--bars" aria-label="每小时查询">
              <div class="overview-card-head">
                <h2 class="ui-card__label">每小时查询</h2>
                <span v-if="sparkPeak" class="overview-card-note">{{ peakLabel }} <b>{{ formatNumber(sparkPeak) }}</b> 次</span>
              </div>
              <div v-if="bars.length" class="overview-bars" role="img" :aria-label="`${trendWindow}每小时查询量`">
                <div class="overview-bars-plot">
                  <div class="overview-bars-cols">
                    <i v-for="bar in bars" :key="bar.key" :class="{ 'is-live': bar.live }" :style="{ height: `${bar.share * 100}%` }" :title="bar.title"></i>
                  </div>
                  <span v-for="line in barScale.lines" :key="line.value" class="overview-bars-line" :style="{ bottom: `${line.share * 100}%` }"><i>{{ compactCount(line.value) }}</i></span>
                </div>
                <div class="overview-bars-axis" aria-hidden="true"><span v-for="tick in axisTicks" :key="tick.label" :class="{ 'is-end': tick.end, 'is-start': tick.start }" :style="{ left: `${tick.x * 100}%` }">{{ tick.label }}</span></div>
              </div>
              <p v-else class="overview-spark-pending">{{ trendPending }}</p>
            </section>
          </div>

          <div class="overview-col">
            <!-- 手动刷新时上游状态变淡；每 15 秒的定时刷新数据不动（全站约定） / Upstream status fades on a manual refresh only; timed refreshes leave the data still (site convention) -->
            <!-- 每个上游一行：状态点、地址、传输方式，右端是平均耗时，下面一条按最慢上游定满格的细条，再一行成功率和响应次数。
                 一行里只允许一个告警色：成功率染色，细条按判定上色，耗时本身不染。
                 One row per upstream: status dot, address, transport, the average latency at the right end, a bar scaled to the slowest upstream, then a line with the success rate and responses. One warning colour per row: the rate is coloured and the bar follows the verdict; the latency itself is not. -->
            <section class="ui-card overview-card overview-card--upstreams" :class="{ 'is-refreshing': refreshing }" aria-label="上游状态">
              <div class="overview-card-head">
                <h2 class="ui-card__label">上游状态</h2>
                <span v-if="upstreamRows.length" class="overview-card-note">{{ ledgerPeriod }}</span>
              </div>
              <div v-if="upstreamRows.length" class="overview-rows">
                <div v-for="item in upstreamRows" :key="upstreamKey(item)" class="overview-row" :title="upstreamTitle(item)">
                  <span class="overview-row-name">
                    <i class="ui-dot overview-dot" :class="`overview-dot--${item.health}`" role="img" :aria-label="healthLabel(item.health)"></i>
                    <!-- 地址最后一段和传输标签绑在一起折行，标签不会单独落到下一行 / The address's last segment and the transport tag wrap together, so the tag never drops to a line of its own -->
                    <span class="overview-address"><template v-for="(part, index) in breakable(item.upstream).slice(0, -1)" :key="index"><span class="ui-mono">{{ part }}</span><wbr /></template><span class="overview-address-tail"><span class="ui-mono">{{ breakable(item.upstream).at(-1) }}</span><span class="overview-row-tag">{{ transportLabel(item.transport) }}</span></span></span>
                  </span>
                  <span class="overview-row-value">{{ hasLatency ? formatLatency(item.shown.avg_latency_ms) : formatPercent(upstreamSuccessRate(item.shown)) }}</span>
                  <p class="overview-row-sub ui-dots"><span v-if="hasLatency">成功率 <b :class="`overview-text--${item.health}`">{{ formatPercent(upstreamSuccessRate(item.shown)) }}</b></span><span>{{ formatNumber(item.settled) }} 次响应</span></p>
                  <span v-if="hasLatency" class="overview-row-bar" aria-hidden="true"><i :class="`overview-bar--${item.health}`" :style="{ width: `${latencyShare(item) * 100}%` }"></i></span>
                </div>
              </div>
              <p v-else class="overview-empty">{{ overview ? '还没有请求转发到上游，转发后在这里按上游列出。' : '尚无数据' }}</p>
            </section>

            <!-- 请求分布：名字、「次数 · 占比」、细条；空着时不写时段和口径（说明的是一张不存在的表）
                 Request distribution: name, 「count · share」, bar; empty, it drops its period note (it would describe a table that is not there) -->
            <section v-for="card in shareCards.slice(0, 1)" :key="card.key" class="ui-card overview-card overview-card--share" :aria-label="card.title">
              <div class="overview-card-head">
                <h2 class="ui-card__label">{{ card.title }}</h2>
                <span v-if="card.rows.length" class="overview-card-note"><UiDotText :parts="card.note" /></span>
              </div>
              <div v-if="card.rows.length" class="overview-rows">
                <div v-for="row in card.rows" :key="row.key" class="overview-row">
                  <span class="overview-row-name"><span :class="{ 'ui-mono': card.mono }">{{ row.label }}</span></span>
                  <span class="overview-row-value">{{ formatNumber(row.count) }} · {{ formatPercent(row.share) }}</span>
                  <span class="overview-row-bar" aria-hidden="true"><i :style="{ width: `${row.share * 100}%` }"></i></span>
                </div>
              </div>
              <p v-else class="overview-empty">{{ card.empty }}</p>
            </section>
          </div>
        </div>

        <!-- 底下一排：响应码分布、缓存构成（有数据才出）和当前运行配置；三张卡同高，运行配置的按钮落在底边
             The bottom row: response codes, cache composition (drawn only with data) and the running configuration; three cards of one height, the configuration's buttons on the bottom edge -->
        <div class="overview-trio">
          <section v-for="card in pairCards" :key="card.key" class="ui-card overview-card overview-card--share" :aria-label="card.title">
            <div class="overview-card-head">
              <h2 class="ui-card__label">{{ card.title }}</h2>
              <span class="overview-card-note"><UiDotText :parts="card.note" /></span>
            </div>
            <div class="overview-rows">
              <div v-for="row in card.rows" :key="row.key" class="overview-row">
                <span class="overview-row-name"><span :class="{ 'ui-mono': card.mono }">{{ row.label }}</span></span>
                <span class="overview-row-value">{{ formatNumber(row.count) }} · {{ formatPercent(row.share) }}</span>
                <span class="overview-row-bar" aria-hidden="true"><i :style="{ width: `${row.share * 100}%` }"></i></span>
              </div>
            </div>
          </section>

          <!-- 运行配置是整体可操作的东西（有自己的按钮和状态），所以是一张卡 / The running configuration is acted on as a whole (its own buttons and state), hence a card -->
          <section class="ui-card overview-card overview-card--config overview-runtime" :aria-label="runtimeState === 'stopped-snapshot' ? '最后运行配置' : '当前运行配置'">
            <div class="overview-card-head">
              <h2 class="ui-card__label">{{ runtimeState === 'stopped-snapshot' ? '最后运行配置' : overview ? '当前运行配置' : '运行配置' }}</h2>
              <span class="ui-tag overview-config-state" :class="configTag.tone ? `ui-tag--${configTag.tone}` : ''">{{ configTag.label }}</span>
            </div>
            <div class="overview-runtime-body">
              <!-- 读者来这里确认的是「现在跑的是哪一代配置」：代次做主项，其余四项在细线下的摘要条里
                   What the reader checks here is which generation is running: that leads, and the other four sit in the strip under the hairline -->
              <template v-if="overview">
                <p class="overview-config-lead"><span>配置代次</span><strong class="ui-mono">#{{ overview.active_config.generation }}</strong></p>
                <p v-if="!overview.active_config.last_reload.success && overview.active_config.last_reload.error" class="overview-reload-error ui-mono">{{ overview.active_config.last_reload.error }}</p>
                <!-- 每一对「名称 值」是一个不拆开的块，点在块之间；哈希照常用等宽 / Each name–value pair is one unbroken block with dots between blocks; hashes stay mono -->
                <p class="overview-config-line ui-dots"><span>重载 <span class="ui-num">#{{ overview.active_config.reload_sequence }}</span></span><span>补丁集 <span class="ui-num">{{ overview.health.patchset ? `p${overview.health.patchset}` : '未记录' }}</span></span><span>配置摘要 <span class="ui-mono">{{ shortHash(overview.active_config.sha256, 14) }}</span></span><span>上游提交 <span class="ui-mono">{{ shortHash(overview.health.upstream_commit, 12) }}</span></span></p>
                <dl class="ui-strip overview-config-hashes">
                  <div><dt>重载</dt><dd class="ui-num">#{{ overview.active_config.reload_sequence }}</dd></div>
                  <div><dt>补丁集</dt><dd class="ui-num">{{ overview.health.patchset ? `p${overview.health.patchset}` : '未记录' }}</dd></div>
                  <div><dt>配置摘要</dt><dd class="ui-mono" :title="overview.active_config.sha256">{{ shortHash(overview.active_config.sha256, 14) }}</dd></div>
                  <div><dt>上游提交</dt><dd class="ui-mono">{{ shortHash(overview.health.upstream_commit, 12) }}</dd></div>
                </dl>
              </template>
              <!-- 没运行过就没有配置可说：一句话代替一排占位 / Never run means no configuration to report: one sentence instead of a row of placeholders -->
              <p v-else class="overview-config-empty">KixDNS 启动后显示正在运行的配置。</p>
            </div>
            <!-- 按钮不能按时只说什么时候能按，状态由页顶提示说；PID 在系统页页头里，这里不重复
                 When the buttons are unavailable this says when they will be, the page notice says why; the PID lives in the system page's header -->
            <div class="overview-runtime-foot">
              <span v-if="runtimeState !== 'live' || !overview" class="overview-runtime-note">{{ runtimeState === 'unavailable-snapshot' ? '实时数据恢复后才能清空缓存' : 'KixDNS 运行后才能清空缓存' }}</span>
              <span class="overview-runtime-actions">
                <RouterLink class="ui-btn ui-btn--secondary" to="/config"><SlidersHorizontal :size="16" aria-hidden="true" />管理配置</RouterLink>
                <button class="ui-btn ui-btn--danger" type="button" :disabled="flushing || runtimeControlsDisabled" @click="flushCache"><Eraser :size="16" aria-hidden="true" />{{ flushing ? '正在清理' : '清空内部缓存' }}</button>
              </span>
            </div>
          </section>
        </div>
      </section>

      <section id="overview-panel-stats" v-show="activeView === 'stats'" class="overview-view" role="tabpanel" aria-labelledby="overview-tab-stats" tabindex="0">
        <!-- 页签已经写了「查询排行」，这里不再重复标题：这一行只说时段和总量，右边是窗口和清空。
             The tab already says 查询排行, so no repeated title: this line gives the period and the volume, with the window and clearing on the right. -->
        <!-- 统计没启用、内核不支持时，时段、总量和窗口都无从说起，整行不出 / With statistics off or unsupported there is no period, volume or window to speak of, so the line is omitted -->
        <!-- 没运行过：没有窗口、没有总量可说，工具行不出；两张表照样留着（首次安装保留完整布局），各写「尚无数据」
             Never run: no window or volume to speak of, so no toolbar; both tables stay (first install keeps the full layout), each reading 尚无数据 -->
        <div v-if="runtimeState !== 'stopped-empty' && showStatsSection && displayStats?.enabled !== false" class="overview-toolbar">
          <p class="ui-dots"><span>{{ statsWindowLabel }}</span><template v-if="displayStats"><span>已观察 {{ formatNumber(displayStats.requests_observed) }} 次请求</span><span v-if="displayStats.dropped_updates">丢弃 {{ formatNumber(displayStats.dropped_updates) }} 次统计更新</span></template></p>
          <div class="overview-toolbar-tools">
            <UiTabs v-model="statsWindowKey" variant="segment" :items="statsWindowItems" label="统计窗口" />
            <!-- 清空按钮一直在，没东西可清、读不到排行时置灰：分段不会因为它出现消失而左右跳
                 The clear button is always there, disabled with nothing to clear or no data read, so the segment never shifts -->
            <button class="ui-btn ui-btn--danger overview-clear" type="button" title="清空查询排行" :disabled="statsClearing || runtimeControlsDisabled || !stats?.enabled || !stats.requests_observed" @click="clearQueryStats" aria-label="清空查询排行"><Eraser :size="16" aria-hidden="true" /><span class="overview-clear__label">清空</span></button>
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
            <header class="overview-ranking-head"><h2>{{ group.title }}</h2><p>{{ group.id === 'clients' && displayStats.anonymized_clients ? '按脱敏网段聚合' : group.description }}</p></header>
            <ol v-if="displayStats[group.id].length" class="overview-ranking-list">
              <li v-for="(item, index) in displayStats[group.id]" :key="item.name">
                <span class="overview-rank">{{ index + 1 }}</span>
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
        <div v-if="rules.length" class="overview-toolbar"><p class="ui-dots"><span>启动以来</span><span>请求与响应阶段的累计执行次数</span></p></div>
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
    </template>
  </div>
</template>

<style scoped>
/* 这一页自己的几个尺寸：卡片之间 20（Surge 的卡片节奏，token 里没有 20 这一档）、卡片内边 24/16（全站卡片的既定内边）、柱图最矮多高、曲线多高、小计数字多大
   This page's own few sizes: 20 between cards (Surge's card rhythm; the scale has no 20 step), 24/16 inside them (the panel's settled card inset), the chart's minimum height, the curve's height, the sub-figure size */
.overview-page { --ov-gap: 20px; --ov-pad: var(--s-5); --ov-pad-top: var(--s-4); --ov-plot: 140px; --ov-spark: 56px; --ov-sub: 20px; display: grid; gap: var(--s-5); color: var(--l-ink); }
/* 骨架块的高度是结果实测的（1440：查询量卡、柱图卡、上游卡、分布卡；375 见文件末尾），只在这里写一次 / Skeleton block heights are measured from the result (1440: volume, bars, upstreams, distribution; 375 at the end of this file), written once here */
.overview-page { --ov-sk-stat: 233px; --ov-sk-bars: 241px; --ov-sk-list: 271px; --ov-sk-list-2: 203px; }
.overview-page > * { min-width: 0; }
.overview-skeleton-meta { width: 16rem; height: calc(var(--t-2) * var(--lh-base)); }
.overview-tabs { margin-bottom: 0; }
.overview-view { display: grid; gap: var(--ov-gap); outline-offset: var(--s-1); }
/* 鼠标点进面板不画框，键盘进来照常显示焦点 / No ring when a panel is clicked; keyboard focus still shows */
.overview-view:focus:not(:focus-visible) { outline: none; }

/* ---------- 页头事实行 ---------- */
/* 页头说明本身已经离标题 8，事实行再加 4 就是 12 / The header's meta sits 8 under the title; the facts row adds 4 for 12 */
.overview-facts { flex: 1 1 100%; margin-top: var(--s-1); }
.overview-facts b > .ui-dot { margin-right: calc(var(--s-1) - var(--s-2)); }
.overview-facts b > small { color: var(--l-ink-3); font-weight: var(--w-normal); }

/* ---------- 版式：左栏两张图卡，右栏 440 的两张列表卡，底下一排三张 ----------
   两栏各自把第二张卡撑到栏底：左边长高的是柱图，右边是请求分布。两栏底边因此永远齐平。
   ---------- Layout: two chart cards on the left, two 440 list cards on the right, a row of three below ----------
   Each column stretches its second card to the column's bottom: the bar chart on the left, request distribution on the right, so the two bottoms always meet. */
.overview-grid { display: grid; grid-template-columns: minmax(0, 1fr) 440px; gap: var(--ov-gap); align-items: stretch; }
.overview-col { display: grid; grid-template-rows: auto minmax(0, 1fr); gap: var(--ov-gap); min-width: 0; }
/* 没运行过时卡里只有一句「尚无数据」，撑高只会撑出空白：两栏各按内容高，底边不强求齐平 / Never run, each card holds one line of 尚无数据 and stretching would only stretch blank: both columns take their content height and the bottoms are not forced level */
.overview-grid.is-empty .overview-col { grid-template-rows: none; align-content: start; }
.overview-trio { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--ov-gap); }
.overview-trio > :only-child { grid-column: 1 / -1; }

/* ---------- 卡片：小标签、右上角一句灰字、内容 ---------- */
/* 标题行离卡顶 16（手机 12），和组件库卡片头一样；两侧和底边是 24/16 / The title row sits 16 (12 on phones) under the card's top edge, as the kit's card head does; sides and bottom are 24/16 */
/* 组件库让卡片里的 div 伸展；这里只有柱图那块该伸展 / The kit lets a card's divs grow; here only the chart block should */
.overview-card { position: relative; padding: var(--ov-pad-top) var(--ov-pad) var(--ov-pad); }
.overview-card > div, .overview-card > dl, .overview-card > p { flex: 0 0 auto; }
.overview-card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); }
.overview-card-head h2 { min-width: 0; }
.overview-card-note { color: var(--l-ink-3); font-size: var(--t-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.overview-card-note b { color: var(--l-ink-2); font-weight: var(--w-medium); }
.overview-empty { margin: 0; padding: var(--s-3) 0 0; color: var(--l-ink-3); font-size: var(--t-2); }

/* ---------- 查询量卡 ---------- */
/* 曲线要贴到卡片的三条边，卡片不留下内边距，溢出裁掉 / The curve must reach three of the card's edges, so the card keeps no bottom padding and clips overflow */
.overview-card--volume { overflow: hidden; padding-bottom: 0; }
.overview-total { display: flex; align-items: baseline; gap: var(--s-2); margin: var(--s-2) 0 0; }
/* 不在数字中间断行：十位数完整写出；字形自带的左边空白按字号收回，第一笔和标签对齐
   Never break inside a number: ten digits are written in full; the glyph's own left bearing is taken back so the first stroke lines up with the label */
.overview-total-value { margin-left: -0.04em; font-family: var(--f-display); font-size: var(--t-7); font-weight: var(--w-heavy); font-variant-numeric: tabular-nums; letter-spacing: -.02em; line-height: var(--lh-tight); white-space: nowrap; }
.overview-total small { color: var(--l-ink-2); font-size: var(--t-3); font-weight: var(--w-bold); }
/* 三项小计共用两行：名称一行、数一行，名称折行时三个数仍在一条线上 / Three sub-figures on two shared rows, names then figures, so the figures stay level when a name wraps */
.overview-subs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-template-rows: auto auto; margin: var(--s-4) 0 0; padding: var(--s-3) 0 var(--s-4); border-top: 1px solid var(--l-hair); }
.overview-subs > div { grid-row: span 2; display: grid; grid-template-rows: subgrid; row-gap: var(--s-1); min-width: 0; padding-left: var(--s-4); border-left: 1px solid var(--l-hair); }
.overview-subs > div:first-child { padding-left: 0; border-left: 0; }
.overview-subs dt { grid-row: 1; margin: 0; }
.overview-subs dd { grid-row: 2; display: flex; align-items: baseline; gap: var(--s-1); margin: 0; font-family: var(--f-display); font-size: var(--ov-sub); font-weight: var(--w-heavy); font-variant-numeric: tabular-nums; letter-spacing: -.01em; line-height: var(--lh-tight); white-space: nowrap; }
.overview-subs dd small { color: var(--l-ink-2); font-size: var(--t-3); font-weight: var(--w-medium); letter-spacing: 0; }
.overview-spark-box { margin: 0 calc(var(--ov-pad) * -1); }
/* 趋势线和柱图同色：它们说的是同一件事 / The curve and the bars share one colour: they say the same thing */
.overview-spark { display: block; width: 100%; height: var(--ov-spark); color: var(--accent); overflow: visible; }
.overview-spark-area { fill: url(#overview-spark-fill); stroke: none; }
.overview-spark-line { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.overview-spark-line--live { stroke-dasharray: 3 3; }
.overview-spark-pending { margin: 0; padding-top: var(--s-3); color: var(--l-ink-3); font-size: var(--t-2); line-height: var(--lh-base); }
.overview-card--volume .overview-spark-pending { padding-bottom: var(--ov-pad); }

/* ---------- 每小时查询卡 ---------- */
/* 刻度值放在右边 44 的空档里，不压在柱子上：最高的几根柱子常常就在右端（傍晚） / Gridline values sit in a 44 gutter on the right, never over a bar: the tallest bars are often at the right end (the evening) */
.overview-card--bars > .overview-bars { --ov-gutter: 44px; flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; margin-top: var(--s-3); }
.overview-bars-plot { position: relative; flex: 1 1 auto; min-height: var(--ov-plot); border-bottom: 1px solid var(--l-line-strong); }
.overview-bars-cols { position: absolute; top: 0; right: var(--ov-gutter); bottom: 0; left: 0; display: flex; align-items: flex-end; gap: var(--s-2); padding: 0 var(--s-1); }
/* 没请求的小时也留 2 高：看得出那一小时有采样，只是没人问 / An hour with no requests still draws 2 tall: it was sampled, nobody asked */
.overview-bars-cols > i { flex: 1 1 0; min-width: 0; min-height: calc(var(--s-1) / 2); border-radius: var(--r-1); background: var(--accent); }
.overview-bars-cols > i.is-live { opacity: .35; }
/* 网格线穿过空档到卡边，刻度值骑在线上、靠右，底色盖住身后那段虚线 / Gridlines run through the gutter to the card edge; the value rides the line at the right, its fill covering the dashes behind it */
.overview-bars-line { position: absolute; right: 0; left: 0; border-top: 1px dashed var(--l-line-strong); }
.overview-bars-line > i { position: absolute; top: 50%; right: 0; padding-left: var(--s-1); background: var(--l-surface); color: var(--l-ink-3); font-size: var(--t-1); font-style: normal; font-variant-numeric: tabular-nums; line-height: 1; white-space: nowrap; transform: translateY(-50%); }
.overview-bars-axis { position: relative; height: calc(var(--t-1) * var(--lh-base)); margin: var(--s-2) var(--ov-gutter) 0 0; color: var(--l-ink-3); font-size: var(--t-1); font-variant-numeric: tabular-nums; }
.overview-bars-axis > span { position: absolute; top: 0; transform: translateX(-50%); white-space: nowrap; }
.overview-bars-axis > span.is-start { transform: none; }
.overview-bars-axis > span.is-end { transform: translateX(-100%); }

/* ---------- 列表卡：一行一个名字、右对齐的数、一条细条 ---------- */
.overview-card--upstreams.is-refreshing .overview-rows { opacity: .72; transition: opacity var(--m-quick) var(--ease-out); }
.overview-rows { display: grid; margin-top: var(--s-1); }
.overview-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--s-1) var(--s-3); align-items: center; padding: var(--s-3) 0; border-top: 1px solid var(--l-hair); font-size: var(--t-3); }
.overview-row:first-child { padding-top: var(--s-2); border-top: 0; }
.overview-row:last-child { padding-bottom: 0; }
.overview-row-name { display: flex; align-items: center; gap: var(--s-2); min-width: 0; font-weight: var(--w-medium); }
.overview-row-name > .ui-mono, .overview-address .ui-mono { font-size: var(--t-3); }
.overview-row-tag { color: var(--l-ink-3); font-size: var(--t-2); font-weight: var(--w-normal); }
.overview-row-value { color: var(--l-ink-2); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.overview-row-bar { grid-column: 1 / -1; height: var(--s-1); overflow: hidden; border-radius: var(--r-full); background: var(--l-hair); }
/* 很小的一段也画 4 宽，不会成一个点 / A tiny share still draws 4 wide instead of a speck */
.overview-row-bar > i { display: block; height: 100%; min-width: var(--s-1); border-radius: inherit; background: var(--accent); }
.overview-bar--degraded { background: var(--warn-l); }
.overview-bar--unhealthy { background: var(--err-l); }
.overview-bar--pending { background: var(--l-ink-3); }
.overview-row-sub { grid-column: 1 / -1; margin: 0; color: var(--l-ink-3); font-size: var(--t-2); font-variant-numeric: tabular-nums; }
.overview-row-sub b { color: var(--l-ink-2); font-weight: var(--w-medium); }
.overview-text--degraded, .overview-row-sub b.overview-text--degraded { color: var(--warn-l); }
.overview-text--unhealthy, .overview-row-sub b.overview-text--unhealthy { color: var(--err-l); }
.overview-address { min-width: 0; overflow-wrap: anywhere; }
.overview-address-tail { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--s-2); max-width: 100%; vertical-align: top; }
.overview-dot { flex: 0 0 auto; }
.overview-dot--healthy { background: var(--ok-mark-l); }
.overview-dot--degraded { background: var(--warn-l); }
.overview-dot--unhealthy { background: var(--err-l); }
.overview-dot--pending { background: var(--l-ink-3); }

/* ---------- 查询排行、规则命中：页签下一行说明，右边工具 ---------- */
.overview-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s-2) var(--s-4); }
.overview-toolbar p, .overview-config-meta, .overview-runtime-note { margin: 0; color: var(--l-ink-3); font-size: var(--t-2); font-variant-numeric: tabular-nums; }
.overview-toolbar-tools { display: flex; align-items: center; gap: var(--s-2); }
/* 清空和「清空内部缓存」「停止」一样是带红边的按钮，盒子贴着版心右边 / 清空 is an outlined destructive button like 清空内部缓存 and 停止, its box on the measure's right edge */
.overview-clear { flex: none; }
/* 手机上只留橡皮擦图标的 36 方块，不像第四个筛选项；名字在 aria-label 和 title 里 / On phones only a 36 square with the eraser icon remains, so it no longer reads as a fourth filter; its name lives in aria-label and title */
@media (max-width: 640px) { .overview-clear { width: var(--h-md); padding: 0; } .overview-clear__label { display: none; } }
.overview-rankings { position: relative; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-4); transition: opacity var(--m-quick) var(--ease-out); }
.overview-rankings.is-loading { opacity: .5; }
/* 两列在全站的 16 格线上，中间一条竖细线把左列的数字和右列的名次隔开，不读成一行 / Both lists sit on the site's 16 grid; a vertical hairline in the gutter keeps the left list's counts apart from the right list's ranks */
/* 竖线从表头细线往下接，到最后一根条为止，和横线接成一个 T / The rule runs down from the header hairline to the last bar, meeting the header line in a T */
@media (min-width: 641px) {
  .overview-rankings > :nth-child(2) .overview-ranking-list { position: relative; }
  .overview-rankings > :nth-child(2) .overview-ranking-list::before { position: absolute; top: calc(var(--s-2) * -1); bottom: var(--s-2); left: calc(var(--s-4) / -2 - 1px); border-left: 1px solid var(--l-hair); content: ''; }
}
/* 排行和其他区块一样：标题行上面一条细线 / Rankings match every other section: a hairline over the title row */
.overview-ranking { min-width: 0; padding-top: var(--s-5); border-top: 1px solid var(--l-hair); }
.overview-ranking h2 { margin: 0; font-family: var(--f-display); font-size: var(--t-4); font-weight: var(--w-bold); }
/* 排行的标题行和别的区块一样：说明在右边、同一条基线 / The ranking title row matches the other sections: the caption on the right, on one baseline */
.overview-ranking-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--s-1) var(--s-4); margin-bottom: var(--s-2); }
.overview-ranking-head p { margin: 0; color: var(--l-ink-3); font-size: var(--t-2); }
.overview-ranking-list { margin: 0; padding: 0; list-style: none; }
/* 每行只有一条横线：细条本身。行与行之间不再加分隔线 / Each row draws one horizontal line, its bar; no divider between rows */
.overview-ranking-list li { display: grid; grid-template-columns: var(--s-5) minmax(0, 1fr) auto; gap: var(--s-2); align-items: baseline; padding: var(--s-2) 0 var(--s-3); line-height: calc(var(--s-5) - 2px); }
/* 名次和规则列表的序号一样：正文字体、等宽数字、不补零 / Ranks read like rule numbers: body face, tabular figures, no zero padding */
.overview-rank { color: var(--l-ink-3); font-size: var(--t-1); font-variant-numeric: tabular-nums; }
.overview-ranking-list strong { min-width: 0; font-size: var(--t-2); font-weight: var(--w-medium); overflow-wrap: anywhere; }
.overview-rank-count { font-size: var(--t-2); font-variant-numeric: tabular-nums; }
.overview-ranking-list li > i { grid-column: 2 / -1; height: var(--s-1); overflow: hidden; border-radius: var(--r-full); background: var(--l-sunk); }
.overview-ranking-list i > span { display: block; height: 100%; border-radius: inherit; background: var(--l-ink); }
/* 排行的条是数字的陪衬：中灰、3 高，紧贴在名字下面；墨色只留给数字。行距收紧，一屏多放几条
   Ranking bars accompany the numbers: mid grey, 3 tall, tucked under the name; ink stays with the figures. Tighter rows show more per screen */
.overview-ranking-list li { row-gap: var(--s-1); padding: var(--s-2) 0; }
.overview-ranking-list li > i { height: var(--s-1); }
/* 商业版：排行的条用品牌色，和概览别的条一致 / Commercial pass: ranking bars take the accent, like every other bar on the overview */
.overview-ranking-list i > span { background: var(--accent); }

/* 表头和各行共用一套列宽：规则名那一列按内容定宽，Pipeline 紧跟在后面，次数靠右。
   组件库把首列以外的表头都右对齐，这里只有次数是数字列，规则和 Pipeline 的表头改回左对齐。
   Head and rows share one set of columns: the rule column fits its content, Pipeline follows right after, the count sits right.
   The kit right-aligns every heading after the first; here only the count is numeric, so the rule and Pipeline headings align left. */
/* 规则、Pipeline 两列平分剩下的宽度，Pipeline 从中线开始：宽屏上规则名和次数之间有一列垫着，不是一整段空白
   Rule and pipeline split the spare width, so the pipeline starts at the middle: on a wide screen a column bridges the rule and
   its count instead of one long gap */
.overview-rules { display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr) auto; column-gap: var(--s-6); }
.overview-rules .ui-rec, .overview-rules .ui-rec-head { grid-column: 1 / -1; grid-template-columns: subgrid; column-gap: inherit; }
.overview-rules .ui-rec-head > :nth-child(2), .overview-rules .ui-rec-head > :nth-child(3) { text-align: left; }
.overview-rule { align-items: baseline; }
.overview-rule-name { min-width: 0; font-size: var(--t-3); font-weight: var(--w-medium); overflow-wrap: anywhere; }
.overview-rule-pipeline { min-width: 0; color: var(--l-ink-3); font-size: var(--t-2); overflow-wrap: anywhere; }
.overview-rule-count { text-align: right; font-variant-numeric: tabular-nums; }
/* 「请求」阶段标签用已发布的绿，保留。 / The 请求 phase tag keeps its released green. */
.overview-phase--request { color: var(--ok-l); border-color: var(--ok-line-l); }
.overview-rule-line { align-items: center; gap: var(--s-2); margin: 0; color: var(--l-ink-3); font-size: var(--t-2); }

/* ---------- 当前运行配置卡：主项、细线下的摘要条、底边的按钮 ---------- */
.overview-runtime-body { display: grid; gap: var(--s-3); margin-top: var(--s-2); }
/* 卡片被撑高时按钮仍落在底边 / When the card is stretched the buttons stay on the bottom edge */
.overview-runtime-foot { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-4); margin-top: auto; padding-top: var(--s-4); color: var(--l-ink-3); font-size: var(--t-2); }
.overview-config-empty { margin: 0; color: var(--l-ink-3); font-size: var(--t-2); }
.overview-config-lead { display: grid; gap: var(--s-1); margin: 0; }
.overview-config-lead > span { color: var(--l-ink-3); font-size: var(--t-1); }
.overview-config-lead > strong { color: var(--l-ink); font-family: var(--f-display); font-size: var(--t-6); font-weight: var(--w-heavy); letter-spacing: -.02em; line-height: var(--lh-tight); }
.overview-reload-error { margin: var(--s-1) 0 0; color: var(--warn-l); font-size: var(--t-2); overflow-wrap: anywhere; }
.overview-config-line { display: none; margin: 0; color: var(--l-ink-2); font-size: var(--t-2); }
.overview-config-hashes { padding-top: var(--s-3); border-top: 1px solid var(--l-hair); }
.overview-runtime-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2); margin-left: auto; }

/* ---------- 骨架：按结果实测的尺寸画，间距同结果 ---------- */
.overview-skeleton { display: grid; grid-template-columns: minmax(0, 1fr) 440px; gap: var(--ov-gap); }
.overview-skeleton-col { display: grid; gap: var(--ov-gap); align-content: start; }
.overview-skeleton-col > i { border-radius: var(--r-3); }
.overview-skeleton-stat { height: var(--ov-sk-stat); }
.overview-skeleton-bars { height: var(--ov-sk-bars); }
.overview-skeleton-list { height: var(--ov-sk-list); }
.overview-skeleton-list + .overview-skeleton-list { height: var(--ov-sk-list-2); }
.overview-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

/* 1160–1199：右栏收到 360，底下一排两张、第三张（单数时的最后一张）满宽。再窄左栏就不到 480（侧栏 232 + 页边 64 + 右栏 380），
   三项小计会折行，所以 1159 起一栏到底 / 1160–1199: the right column narrows to 360; the bottom row holds two, an odd last card spans the row.
   Narrower, the left column drops under 480 (sidebar 232 + page gutters 64 + right column 380) and the sub-figures wrap, so from 1159 it is one column */
@media (max-width: 1199px) {
  .overview-grid, .overview-skeleton { grid-template-columns: minmax(0, 1fr) 360px; }
  .overview-trio { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .overview-trio > :last-child:nth-child(odd) { grid-column: 1 / -1; }
}
@media (max-width: 1159px) {
  .overview-grid, .overview-col, .overview-trio, .overview-skeleton, .overview-skeleton-col { grid-template-columns: minmax(0, 1fr); grid-template-rows: none; }
  .overview-trio > :last-child:nth-child(odd) { grid-column: auto; }
}
/* 900 以下：一栏到底，卡片按原来的顺序叠；规则换成两行式（四列挤不下）
   Below 900: a single column, the cards stacked in the same order; rules turn to two-line rows (four columns no longer fit) */
@media (max-width: 899px) {
  .overview-rules { grid-template-columns: minmax(0, 1fr) auto; column-gap: var(--s-4); }
  .overview-rules .ui-rec-head, .overview-rule-phase, .overview-rule-pipeline { display: none; }
  .overview-rules .ui-rec__phone { display: flex; grid-column: 1 / -1; }
  .overview-rule { row-gap: var(--s-1); }
}

@media (max-width: 640px) {
  /* 手机上卡片内边距 16、卡与卡之间 16；柱图不用撑高，最矮 160 / On phones 16 inside and between cards; the chart need not stretch and is at least 160 tall */
  .overview-page { --ov-gap: var(--s-4); --ov-pad: var(--s-4); --ov-pad-top: var(--s-3); --ov-plot: 160px; gap: var(--s-4); }
  .overview-meta-time { display: none; }
  /* 事实两项一行 / Two facts per line */
  .overview-facts { gap: var(--s-3) var(--s-5); }
  .overview-facts > div { flex: 0 0 calc(50% - var(--s-5) / 2); }
  .overview-skeleton-meta { height: calc(var(--t-4) * var(--lh-base) * 2 + 2px); }
  .overview-page { --ov-sk-stat: 250px; --ov-sk-bars: 246px; --ov-sk-list: 267px; --ov-sk-list-2: 197px; }
  /* 24 根柱子挤在 311 宽里：缝 3，柱子还有 10 宽 / 24 bars in 311: gaps of 3 leave bars 10 wide */
  .overview-bars-cols { gap: 3px; padding: 0; }
  /* 手机上代次做主项，其余四项收成一行小字 / On a phone the generation leads and the other four fold into one line of small text */
  .overview-config-hashes { display: none; }
  .overview-config-line { display: flex; }
  .overview-toolbar { align-items: stretch; }
  .overview-toolbar-tools { width: 100%; justify-content: space-between; }
  .overview-rankings { grid-template-columns: minmax(0, 1fr); gap: var(--s-5); padding-top: var(--s-3); }
  /* 排行的第一块紧跟在时段选择下面，不画顶线：选择那一行不是一个区块 / The first ranking follows the window picker without a top rule: the picker row is not a section */
  .overview-ranking:first-child { padding-top: 0; border-top: 0; }
  /* 排行之间的细线上下一样远：上面是列表间距，下面是区块内边距，最后一行不再自带下边距 / The line between rankings is equally far from both: the list gap above, the section padding below, the last row without its own bottom padding */
  .overview-ranking { padding-top: var(--s-4); }
  .overview-rankings { gap: var(--s-4); }
  .overview-ranking-list li:last-child { padding-bottom: 0; }
  .overview-toolbar-tools > .ui-seg { flex: 1; }
  .overview-runtime-actions { width: 100%; }
  .overview-runtime-actions > * { flex: 1 1 0; }
}
</style>
