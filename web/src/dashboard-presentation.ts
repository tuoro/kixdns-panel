import type { FlowControl, FlowRefused, MetricsSnapshot, RequestLatency, UpstreamCount, UpstreamTally } from './api/types'
import { formatAgo, shownPercent, upstreamSuccessRate } from './utils'

export type UpstreamHealth = 'pending' | 'healthy' | 'degraded' | 'unhealthy'

/** 响应少于这个数时不下结论，避免刚启动时几次连接建立失败就把上游判成降级。 */
export const MIN_HEALTH_SAMPLES = 50

/** 成功率的分母：成功与超时、连接错误的次数。 */
export function judgedAttempts(tally: Pick<UpstreamTally, 'success' | 'errors'>): number {
  return tally.success + tally.errors
}

export interface UpstreamBasis {
  tally: UpstreamTally
  /** true 表示最近一小时，false 表示 KixDNS 启动以来的累计。 */
  recent: boolean
}

/**
 * 最近一小时有 50 次以上可判断的响应就看最近一小时；不够的话（面板刚重启、备用上游平时
 * 很少用到）退回启动以来的累计，免得几次偶然的失败决定判断。
 */
export function upstreamBasis(item: UpstreamCount): UpstreamBasis {
  if (item.recent && judgedAttempts(item.recent) >= MIN_HEALTH_SAMPLES) return { tally: item.recent, recent: true }
  return { tally: item, recent: false }
}

/**
 * 可判断的响应不足 50 次记为观察中；成功率 ≥ 99% 且平均耗时 < 1 s 记为健康；
 * 成功率 < 95% 或平均耗时 ≥ 2 s 记为异常；其余为降级。
 * 成功率按页面上写出来的那一位小数比：写着「99.0%」的就够 99%，不会旁边写着 99.0% 却染成降级。
 * The success rate is compared at the one decimal the page shows: one reading 「99.0%」 meets 99%, so a rate shown as 99.0% is
 * never coloured degraded.
 */
export function upstreamHealth(item: UpstreamCount): UpstreamHealth {
  const { tally } = upstreamBasis(item)
  if (judgedAttempts(tally) < MIN_HEALTH_SAMPLES) return 'pending'
  const rate = shownPercent(upstreamSuccessRate(tally))
  const latency = tally.avg_latency_ms ?? 0
  if (rate < 95 || latency >= 2_000) return 'unhealthy'
  if (rate >= 99 && latency < 1_000) return 'healthy'
  return 'degraded'
}

/**
 * 上游状态和响应速度依据的时间段。面板每分钟采样一次，正常时窗口在 59 到 60 分钟之间，
 * 都叫一小时；KixDNS 一小时内重启过时窗口从它启动算起；面板还没采到样本时没有窗口，只有累计。
 * 查询排行的 6、24 小时窗口也用它，按小时说。
 * snapshot：手上是 KixDNS 停了、读不到时留下的快照，窗口截在快照那一刻，从那里往前说，不说「最近」。
 * The query rankings' 6- and 24-hour windows use it too, told in hours.
 * snapshot: what is in hand is the snapshot left when KixDNS stopped or could not be read, so the window ends at the snapshot and is
 * counted back from there, never as 最近.
 */
export function recentWindowLabel(seconds: number | null, snapshot = false): string {
  if (seconds === null) return '启动以来'
  const lead = snapshot ? '快照前' : '最近'
  if (seconds >= 2 * 3600) return `${lead} ${Math.round(seconds / 3600)} 小时`
  if (seconds >= 55 * 60) return `${lead}一小时`
  return `${lead} ${Math.max(1, Math.round(seconds / 60))} 分钟`
}

export interface LatencyBasis {
  latency: RequestLatency
  /** true 表示最近一小时，false 表示 KixDNS 启动以来的累计。 */
  recent: boolean
}

/** 最近一小时有 50 次以上请求就看最近一小时；夜里几乎没人用时退回启动以来的累计。 */
export function latencyBasis(metrics: MetricsSnapshot): LatencyBasis {
  const recent = metrics.request_latency_recent
  if (recent && recent.samples >= MIN_HEALTH_SAMPLES) return { latency: recent, recent: true }
  return { latency: metrics.request_latency, recent: false }
}

/**
 * 耗时分成互不重叠的四段。内核上报的是累计桶（10 ms 内、100 ms 内……），直接列出来
 * 「100 ms 内 97%」会和「10 ms 内 82%」重叠，读者会把两个数加起来。
 */
export function latencyBands(latency: RequestLatency): ShareRow[] {
  if (latency.samples === 0) return []
  const rows = [
    { key: 'within-10ms', label: '10 ms 内', count: latency.within_10ms },
    { key: 'within-100ms', label: '10–100 ms', count: latency.within_100ms - latency.within_10ms },
    { key: 'within-1s', label: '100 ms–1 s', count: latency.within_1s - latency.within_100ms },
    { key: 'slower', label: '1 s 以上', count: latency.samples - latency.within_1s },
  ]
  return rows.map((row) => {
    const count = Math.max(0, row.count)
    return { ...row, count, share: count / latency.samples }
  })
}

/** 100 ms 内返回 ≥ 95% 记为健康，≥ 80% 记为降级，其余为异常；没有请求时观察中。 */
export function latencyHealth(latency: RequestLatency): UpstreamHealth {
  if (latency.samples === 0) return 'pending'
  const share = latency.within_100ms / latency.samples
  return share >= 0.95 ? 'healthy' : share >= 0.8 ? 'degraded' : 'unhealthy'
}

export const HEALTH_LABELS: Record<UpstreamHealth, string> = { pending: '观察中', healthy: '健康', degraded: '降级', unhealthy: '异常' }

/** 已得到结果的尝试数：不含并发竞争中被取消的，也不含被限速的（没有给出 DNS 回答）。 */
export function settledAttempts(item: Pick<UpstreamTally, 'attempts' | 'aborted' | 'throttled'>): number {
  return Math.max(0, item.attempts - item.aborted - item.throttled)
}

export interface ShareRow {
  key: string
  label: string
  count: number
  share: number
}

const RCODE_LABELS: Record<string, string> = { NoError: 'NOERROR', NXDomain: 'NXDOMAIN', ServFail: 'SERVFAIL', Refused: 'REFUSED' }
const RCODE_ORDER = ['NoError', 'NXDomain', 'ServFail', 'Refused']

/** 全部上游的响应码分布；四个常见响应码单列，其余合并为"其他"。 */
export function rcodeDistribution(upstreams: readonly UpstreamCount[]): ShareRow[] {
  const totals = new Map<string, number>()
  for (const upstream of upstreams) {
    for (const rcode of upstream.rcodes) {
      const key = RCODE_ORDER.includes(rcode.name) ? rcode.name : 'other'
      totals.set(key, (totals.get(key) ?? 0) + rcode.count)
    }
  }
  const total = [...totals.values()].reduce((sum, value) => sum + value, 0)
  if (total === 0) return []
  return [...RCODE_ORDER, 'other']
    .filter((key) => (totals.get(key) ?? 0) > 0)
    .map((key) => ({ key, label: RCODE_LABELS[key] ?? '其他', count: totals.get(key) ?? 0, share: (totals.get(key) ?? 0) / total }))
}

/**
 * 缓存命中按来源拆分。
 *
 * 「过期」说的是条目本身，不是这次命中的结果——TTL 到了但 KixDNS 照样把旧答案
 * 发了出去，请求因此没有变慢也没有失败。叫「过期命中」会读成「命中了不该命中的
 * 东西」，把一次成功的兜底说成了故障，所以措辞落在「续用旧结果」上。
 *
 * Cache hits split by origin. "Expired" describes the entry, not the outcome:
 * the TTL lapsed but KixDNS served the old answer anyway, so the request
 * neither slowed down nor failed. Calling that an "expired hit" reads as
 * having hit something one should not have, turning a successful fallback into
 * a fault, so the wording says the answer was reused instead.
 */
export function cacheComposition(metrics: MetricsSnapshot): ShareRow[] {
  const stale = metrics.cache_stale
  const rows = [
    { key: 'fresh', label: '未过期直接命中', count: metrics.cache_hits_fresh },
    { key: 'expired', label: '直接续用旧结果', count: stale.expired },
    { key: 'client_timeout', label: '等上游超时后续用', count: stale.client_timeout },
    { key: 'upstream_failure', label: '上游失败后续用', count: stale.upstream_failure },
  ]
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  if (total === 0) return []
  return rows.map((row) => ({ ...row, share: row.count / total }))
}

/** 各道防线在卡片上叫什么，按平常最可能出现的先后排 / What each defence is called on the card, in the order they most often turn up */
export const FLOW_DEFENCES: readonly { key: keyof FlowRefused; label: string }[] = [
  { key: 'queue', label: '处理不过来时排不下' },
  { key: 'capacity', label: '处理不过来时发得多' },
  { key: 'memory', label: '内存不够' },
  { key: 'connection', label: '内存不够时的新连接' },
  { key: 'stuck', label: '等上游卡住的太多' },
  { key: 'unanswered', label: '上游不回答这台设备' },
]

export interface FlowView {
  /** 时段：最近一小时，或启动以来 */
  period: string
  /** 拦过的防线，次数多的在前 */
  refused: { key: keyof FlowRefused; label: string; count: number }[]
  total: number
  turns: number
  stuck: number
  /** 内存：充足、紧张（还剩底线的几倍）、见底；最近一分钟没读过内存时为 null（在途少时内核不看内存） */
  memory: { label: string; tone: 'ok' | 'warn' | 'bad' } | null
  /** 这个时段里被拦过的设备，次数多的在前；快照时不写多久以前（离快照多久不知道） */
  clients: { client: string; refused: number; ago: string }[]
}

/**
 * 智能流控卡片要写的：有最近一小时的窗口就按窗口算，没有就按启动以来；设备只列这个时段里被拦过的。
 * What the flow control card shows: over the recent window when there is one, otherwise since the start; only devices refused within
 * that period are listed.
 */
export function flowView(flow: FlowControl, windowSeconds: number | null, snapshot = false, now = Date.now()): FlowView {
  const recent = flow.recent && windowSeconds !== null ? flow.recent : null
  const counts = recent?.refused ?? flow.refused
  const refused = FLOW_DEFENCES.map(({ key, label }) => ({ key, label, count: counts[key] }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count)
  const room = flow.memory_room
  const memory = room === null ? null
    : room >= 2 ? { label: '充足', tone: 'ok' as const }
    : room >= 1 ? { label: `紧张，剩底线的 ${room.toFixed(1)} 倍`, tone: 'warn' as const }
    : { label: '见底', tone: 'bad' as const }
  const within = recent ? windowSeconds! : Infinity
  const nowSeconds = now / 1000
  return {
    period: recent ? recentWindowLabel(windowSeconds, snapshot) : '启动以来',
    refused,
    total: refused.reduce((sum, row) => sum + row.count, 0),
    turns: recent?.turns ?? flow.turns,
    stuck: flow.stuck,
    memory,
    clients: flow.clients
      .filter((client) => client.age_seconds <= within)
      .map((client) => ({ client: client.client, refused: client.refused, ago: snapshot ? '' : formatAgo(nowSeconds - client.age_seconds, now) })),
  }
}
