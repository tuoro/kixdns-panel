import { describe, expect, it } from 'vitest'
import { MIN_HEALTH_SAMPLES, cacheComposition, pipelineDistribution, rcodeDistribution, settledAttempts, upstreamBasis, upstreamHealth, upstreamWindowLabel } from './dashboard-presentation'
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
  const base = { upstream: '1.1.1.1:53', transport: 'udp', errors: 0, rejected: 0, rcodes: [], tcp_fallbacks: 0, recent: null }
  const tally = { errors: 0, rejected: 0, aborted: 0, tcp_fallbacks: 0 }

  it('按成功率与平均耗时分三档，竞争落败不计入，样本不足时观察中', () => {
    expect(upstreamHealth({ ...base, attempts: 100, success: 100, aborted: 0, avg_latency_ms: 12 })).toBe('healthy')
    expect(upstreamHealth({ ...base, attempts: 100, success: 0, aborted: 100, avg_latency_ms: null })).toBe('pending')
    // 刚启动：45 次响应里 2 次连接建立失败，不能就此判降级
    expect(upstreamHealth({ ...base, attempts: 45, success: 43, errors: 2, aborted: 0, avg_latency_ms: 295 })).toBe('pending')
    expect(upstreamHealth({ ...base, attempts: MIN_HEALTH_SAMPLES, success: MIN_HEALTH_SAMPLES - 2, errors: 2, aborted: 0, avg_latency_ms: 295 })).toBe('degraded')
    expect(upstreamHealth({ ...base, attempts: 100, success: 97, errors: 3, aborted: 0, avg_latency_ms: 12 })).toBe('degraded')
    expect(upstreamHealth({ ...base, attempts: 100, success: 100, aborted: 0, avg_latency_ms: 1_500 })).toBe('degraded')
    expect(upstreamHealth({ ...base, attempts: 100, success: 90, errors: 10, aborted: 0, avg_latency_ms: 12 })).toBe('unhealthy')
    expect(upstreamHealth({ ...base, attempts: 100, success: 100, aborted: 0, avg_latency_ms: 2_400 })).toBe('unhealthy')
    expect(settledAttempts({ attempts: 100, aborted: 60 })).toBe(40)
  })

  it('SERVFAIL、REFUSED 不算上游失败', () => {
    // 四成查询上游如实回了 SERVFAIL：上游在正常工作，出问题的是那些域名
    expect(upstreamHealth({ ...base, attempts: 100, success: 60, rejected: 40, aborted: 0, avg_latency_ms: 20 })).toBe('healthy')
  })

  it('最近一小时响应够多时只看最近一小时', () => {
    // 几天前断过一阵，累计成功率只有 90%；最近一小时一次没错
    const recovered = { ...base, attempts: 10_000, success: 9_000, errors: 1_000, aborted: 0, avg_latency_ms: 30, recent: { ...tally, attempts: 600, success: 600, avg_latency_ms: 12 } }
    expect(upstreamBasis(recovered)).toEqual({ tally: recovered.recent, recent: true })
    expect(upstreamHealth(recovered)).toBe('healthy')
    // 累计一直很好，最近一小时开始超时
    const failingNow = { ...base, attempts: 100_000, success: 99_900, errors: 100, aborted: 0, avg_latency_ms: 12, recent: { ...tally, attempts: 200, success: 150, errors: 50, avg_latency_ms: 800 } }
    expect(upstreamHealth(failingNow)).toBe('unhealthy')
  })

  it('最近一小时可判断的响应不足 50 次时退回启动以来的累计', () => {
    // 备用上游这一小时只用了 12 次，3 次超时不足以判异常
    const quiet = { ...base, attempts: 5_000, success: 4_990, errors: 10, aborted: 0, avg_latency_ms: 25, recent: { ...tally, attempts: 12, success: 9, errors: 3, avg_latency_ms: 40 } }
    expect(upstreamBasis(quiet)).toEqual({ tally: quiet, recent: false })
    expect(upstreamHealth(quiet)).toBe('healthy')
    // 120 次尝试里 90 次是 SERVFAIL：可判断的只有 30 次，同样不够
    const mostlyServfail = { ...quiet, recent: { ...tally, attempts: 120, success: 28, errors: 2, rejected: 90, avg_latency_ms: 40 } }
    expect(upstreamBasis(mostlyServfail).recent).toBe(false)
  })

  it('台账标题写出实际依据的时间段', () => {
    expect(upstreamWindowLabel(null)).toBe('启动以来')
    expect(upstreamWindowLabel(3_600)).toBe('最近一小时')
    // 每分钟采样一次，正常时窗口是 59 到 60 分钟
    expect(upstreamWindowLabel(3_541)).toBe('最近一小时')
    // KixDNS 20 分钟前重启
    expect(upstreamWindowLabel(1_200)).toBe('最近 20 分钟')
    expect(upstreamWindowLabel(20)).toBe('最近 1 分钟')
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
