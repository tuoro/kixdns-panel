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

export type UpstreamHealth = 'healthy' | 'degraded' | 'unhealthy'

/** 成功率 ≥ 99% 且平均耗时 < 1 s 记为健康；成功率 < 95% 或平均耗时 ≥ 2 s 记为异常；其余为降级。 */
export function upstreamHealth(item: UpstreamCount): UpstreamHealth {
  const rate = upstreamSuccessRate(item)
  const latency = item.avg_latency_ms ?? 0
  if (item.attempts - item.aborted <= 0) return 'healthy'
  if (rate < 0.95 || latency >= 2_000) return 'unhealthy'
  if (rate >= 0.99 && latency < 1_000) return 'healthy'
  return 'degraded'
}

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

/** 缓存命中按来源拆分：新鲜、过期直出、等待上游超时后用旧、上游失败后用旧。 */
export function cacheComposition(metrics: MetricsSnapshot): ShareRow[] {
  const stale = metrics.cache_stale
  const rows = [
    { key: 'fresh', label: '新鲜命中', count: metrics.cache_hits_fresh },
    { key: 'expired', label: '过期直出', count: stale.expired },
    { key: 'client_timeout', label: '等待上游超时后用旧', count: stale.client_timeout },
    { key: 'upstream_failure', label: '上游失败后用旧', count: stale.upstream_failure },
  ]
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  if (total === 0) return []
  return rows.map((row) => ({ ...row, share: row.count / total }))
}
