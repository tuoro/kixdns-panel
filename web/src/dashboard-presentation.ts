import type { NamedCount } from './api/types'

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
