import { describe, expect, it } from 'vitest'
import { cacheComposition, pipelineDistribution, rcodeDistribution, settledAttempts, upstreamHealth } from './dashboard-presentation'
import { emptyOverview } from './dashboard-state'

describe('概览 Pipeline 分布', () => {
  it('按命中次数排序，并以计数总和计算真实占比', () => {
    const distribution = pipelineDistribution([
      { name: 'domestic', count: 2_773_104 },
      { name: 'default', count: 8_914_380 },
      { name: 'blocked', count: 1_159_908 },
    ])

    expect(distribution.map((item) => item.name)).toEqual(['default', 'domestic', 'blocked'])
    expect(distribution[0]?.share).toBe(8_914_380 / 12_847_392)
    expect(distribution.reduce((sum, item) => sum + item.share, 0)).toBeCloseTo(1)
  })

  it('不通过最小宽度放大小流量，也不隐藏零命中条目', () => {
    const distribution = pipelineDistribution([
      { name: 'large', count: 999 },
      { name: 'small', count: 1 },
      { name: 'zero', count: 0 },
    ])

    expect(distribution.map((item) => item.share)).toEqual([0.999, 0.001, 0])
  })

  it('空数据和全部零计数不会生成无效比例', () => {
    expect(pipelineDistribution([])).toEqual([])
    expect(pipelineDistribution([{ name: 'waiting', count: 0 }])).toEqual([
      { name: 'waiting', count: 0, share: 0 },
    ])
  })

  it('不修改传入的顺序和条目', () => {
    const items = Object.freeze([
      Object.freeze({ name: 'small', count: 1 }),
      Object.freeze({ name: 'large', count: 2 }),
    ])

    expect(pipelineDistribution(items)[0]?.name).toBe('large')
    expect(items[0]?.name).toBe('small')
  })
})

describe('上游健康与分布', () => {
  const base = { upstream: '1.1.1.1:53', transport: 'udp', errors: 0, rejected: 0, rcodes: [], tcp_fallbacks: 0 }

  it('按成功率与平均耗时分三档，竞争落败不计入', () => {
    expect(upstreamHealth({ ...base, attempts: 100, success: 100, aborted: 0, avg_latency_ms: 12 })).toBe('healthy')
    expect(upstreamHealth({ ...base, attempts: 100, success: 0, aborted: 100, avg_latency_ms: null })).toBe('healthy')
    expect(upstreamHealth({ ...base, attempts: 100, success: 97, aborted: 0, avg_latency_ms: 12 })).toBe('degraded')
    expect(upstreamHealth({ ...base, attempts: 100, success: 100, aborted: 0, avg_latency_ms: 1_500 })).toBe('degraded')
    expect(upstreamHealth({ ...base, attempts: 100, success: 90, aborted: 0, avg_latency_ms: 12 })).toBe('unhealthy')
    expect(upstreamHealth({ ...base, attempts: 100, success: 100, aborted: 0, avg_latency_ms: 2_400 })).toBe('unhealthy')
    expect(settledAttempts({ ...base, attempts: 100, success: 40, aborted: 60, avg_latency_ms: null })).toBe(40)
  })

  it('响应码分布合并所有上游并把少见响应码归为其他', () => {
    const rows = rcodeDistribution([
      { ...base, attempts: 10, success: 10, aborted: 0, avg_latency_ms: 1, rcodes: [{ name: 'NoError', count: 60 }, { name: 'NXDomain', count: 30 }, { name: 'NotImp', count: 5 }] },
      { ...base, upstream: '8.8.8.8:53', attempts: 10, success: 10, aborted: 0, avg_latency_ms: 1, rcodes: [{ name: 'NoError', count: 5 }] },
    ])
    expect(rows.map((row) => [row.label, row.count])).toEqual([['NOERROR', 65], ['NXDOMAIN', 30], ['其他', 5]])
    expect(rows[0].share).toBeCloseTo(0.65)
    expect(rcodeDistribution([])).toEqual([])
  })

  it('缓存构成按来源拆分，无命中时为空', () => {
    const overview = emptyOverview()
    expect(cacheComposition(overview.metrics)).toEqual([])
    overview.metrics.cache_hits_fresh = 90
    overview.metrics.cache_stale = { expired: 6, client_timeout: 3, upstream_failure: 1 }
    const rows = cacheComposition(overview.metrics)
    expect(rows.map((row) => row.key)).toEqual(['fresh', 'expired', 'client_timeout', 'upstream_failure'])
    expect(rows[0].share).toBeCloseTo(0.9)
    expect(rows[3].count).toBe(1)
  })
})
