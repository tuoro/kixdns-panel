import type { MetricsSnapshot, NamedCount, UpstreamCount } from './api/types'
import { upstreamSuccessRate } from './utils'

export interface PipelineShare extends NamedCount {
  share: number
}

/** 分布以所有 Pipeline 的实际命中计数为分母，不放大小流量分段。 */
export function pipelineDistribution(items: readonly NamedCount[]): PipelineShare[] {
  const total = items.reduce((sum, item) => sum + item.count, 0)
  return [...items]
    .sort((left, right) => right.count - left.count)
    .map((item) => ({ ...item, share: total > 0 ? item.count / total : 0 }))
}

export type UpstreamHealth = 'pending' | 'healthy' | 'degraded' | 'unhealthy'

/** 响应少于这个数时不下结论，避免刚启动时几次连接建立失败就把上游判成降级。 */
export const MIN_HEALTH_SAMPLES = 50

/**
 * 响应不足 50 次记为观察中；成功率 ≥ 99% 且平均耗时 < 1 s 记为健康；
 * 成功率 < 95% 或平均耗时 ≥ 2 s 记为异常；其余为降级。
 */
export function upstreamHealth(item: UpstreamCount): UpstreamHealth {
  const rate = upstreamSuccessRate(item)
  const latency = item.avg_latency_ms ?? 0
  if (settledAttempts(item) < MIN_HEALTH_SAMPLES) return 'pending'
  if (rate < 0.95 || latency >= 2_000) return 'unhealthy'
  if (rate >= 0.99 && latency < 1_000) return 'healthy'
  return 'degraded'
}

export const HEALTH_LABELS: Record<UpstreamHealth, string> = { pending: '观察中', healthy: '健康', degraded: '降级', unhealthy: '异常' }

/** 已得到结果的尝试数：不含并发竞争中被取消的。 */
export function settledAttempts(item: UpstreamCount): number {
  return Math.max(0, item.attempts - item.aborted)
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
