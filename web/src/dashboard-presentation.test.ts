import { describe, expect, it } from 'vitest'
import type { FlowControl, RequestLatency } from './api/types'
import { MIN_HEALTH_SAMPLES, cacheComposition, flowView, latencyBands, latencyBasis, latencyHealth, rcodeDistribution, recentWindowLabel, settledAttempts, upstreamBasis, upstreamHealth } from './dashboard-presentation'
import { emptyOverview } from './dashboard-state'
import { formatPercent, upstreamSuccessRate } from './utils'

describe('上游健康与分布', () => {
  const base = { upstream: '1.1.1.1:53', transport: 'udp', errors: 0, rejected: 0, throttled: 0, rcodes: [], tcp_fallbacks: 0, recent: null }
  const tally = { errors: 0, rejected: 0, aborted: 0, throttled: 0, tcp_fallbacks: 0 }

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
    expect(settledAttempts({ attempts: 100, aborted: 60, throttled: 0 })).toBe(40)
  })

  it('SERVFAIL、REFUSED 不算上游失败', () => {
    // 四成查询上游如实回了 SERVFAIL：上游在正常工作，出问题的是那些域名
    expect(upstreamHealth({ ...base, attempts: 100, success: 60, rejected: 40, aborted: 0, avg_latency_ms: 20 })).toBe('healthy')
  })

  it('被限速既不算成功也不算失败，也不算一次响应', () => {
    // 四成尝试回了 HTTP 429：成功率只看拿到结果的那些，上游照样健康 / Four in ten attempts got HTTP 429: the success rate looks only at
    // attempts with a result, and the upstream stays healthy
    expect(upstreamHealth({ ...base, attempts: 100, success: 60, throttled: 40, aborted: 0, avg_latency_ms: 20 })).toBe('healthy')
    expect(settledAttempts({ attempts: 100, aborted: 20, throttled: 30 })).toBe(50)
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

  it('上游状态标题写出实际依据的时间段', () => {
    expect(recentWindowLabel(null)).toBe('启动以来')
    expect(recentWindowLabel(3_600)).toBe('最近一小时')
    // 每分钟采样一次，正常时窗口是 59 到 60 分钟
    expect(recentWindowLabel(3_541)).toBe('最近一小时')
    // KixDNS 20 分钟前重启
    expect(recentWindowLabel(1_200)).toBe('最近 20 分钟')
    expect(recentWindowLabel(20)).toBe('最近 1 分钟')
  })

  it('快照的时段从快照那一刻往前说，不说「最近」', () => {
    expect(recentWindowLabel(3_600, true)).toBe('快照前一小时')
    expect(recentWindowLabel(3_541, true)).toBe('快照前一小时')
    expect(recentWindowLabel(1_200, true)).toBe('快照前 20 分钟')
    expect(recentWindowLabel(null, true)).toBe('启动以来')
  })

  it('查询排行的 6、24 小时窗口按小时说，快照一样从快照往前说', () => {
    expect(recentWindowLabel(21_600)).toBe('最近 6 小时')
    expect(recentWindowLabel(86_400)).toBe('最近 24 小时')
    expect(recentWindowLabel(21_600, true)).toBe('快照前 6 小时')
    expect(recentWindowLabel(86_400, true)).toBe('快照前 24 小时')
  })

  it('成功率按页面上写出来的那一位小数判断：写着 99.0% 就够健康，写着 95.0% 就不算异常', () => {
    // 9,899 ÷ 10,000 = 98.99%，页面写 99.0% / 9,899 ÷ 10,000 = 98.99%, shown as 99.0%
    const shown99 = { ...base, attempts: 10_000, success: 9_899, errors: 101, aborted: 0, avg_latency_ms: 20 }
    expect(formatPercent(upstreamSuccessRate(shown99))).toBe('99.0%')
    expect(upstreamHealth(shown99)).toBe('healthy')
    // 94.96% 写 95.0%：降级，不是异常 / 94.96% shows as 95.0%: degraded, not unhealthy
    const shown95 = { ...base, attempts: 10_000, success: 9_496, errors: 504, aborted: 0, avg_latency_ms: 20 }
    expect(formatPercent(upstreamSuccessRate(shown95))).toBe('95.0%')
    expect(upstreamHealth(shown95)).toBe('degraded')
    // 写出来不到的照样不到 / What shows below the line is below it
    const shown989 = { ...base, attempts: 10_000, success: 9_894, errors: 106, aborted: 0, avg_latency_ms: 20 }
    expect(formatPercent(upstreamSuccessRate(shown989))).toBe('98.9%')
    expect(upstreamHealth(shown989)).toBe('degraded')
    const shown949 = { ...base, attempts: 10_000, success: 9_494, errors: 506, aborted: 0, avg_latency_ms: 20 }
    expect(formatPercent(upstreamSuccessRate(shown949))).toBe('94.9%')
    expect(upstreamHealth(shown949)).toBe('unhealthy')
  })

  it('响应码分布合并所有上游并把少见响应码归为其他', () => {
    const rows = rcodeDistribution([
      { ...base, attempts: 10, success: 10, aborted: 0, avg_latency_ms: 1, rcodes: [{ name: 'NOERROR', count: 60 }, { name: 'NXDOMAIN', count: 30 }, { name: 'NOTIMP', count: 5 }] },
      { ...base, upstream: '8.8.8.8:53', attempts: 10, success: 10, aborted: 0, avg_latency_ms: 1, rcodes: [{ name: 'NOERROR', count: 5 }] },
    ])
    expect(rows.map((row) => [row.label, row.count])).toEqual([['NOERROR', 65], ['NXDOMAIN', 30], ['其他', 5]])
    expect(rows[0].share).toBeCloseTo(0.65)
    expect(rcodeDistribution([])).toEqual([])
  })

  it('响应码分布也认较早内核的 hickory 写法', () => {
    const rows = rcodeDistribution([
      { ...base, attempts: 10, success: 10, aborted: 0, avg_latency_ms: 1, rcodes: [{ name: 'NoError', count: 6 }, { name: 'ServFail', count: 3 }, { name: 'NotImp', count: 1 }] },
    ])
    expect(rows.map((row) => [row.label, row.count])).toEqual([['NOERROR', 6], ['SERVFAIL', 3], ['其他', 1]])
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

describe('响应速度', () => {
  const lifetime: RequestLatency = { samples: 1_000_000, avg_ms: 40, within_10ms: 600_000, within_100ms: 900_000, within_1s: 990_000 }
  const withRecent = (recent: RequestLatency | null) => ({ ...emptyOverview().metrics, request_latency: lifetime, request_latency_recent: recent })

  it('耗时分成互不重叠的四段，合计是全部请求', () => {
    // 内核给的是累计桶：10 ms 内 817 次、100 ms 内 969 次、1 s 内 996 次
    const bands = latencyBands({ samples: 1_000, avg_ms: 12, within_10ms: 817, within_100ms: 969, within_1s: 996 })
    expect(bands.map((band) => [band.label, band.count])).toEqual([['10 ms 内', 817], ['10–100 ms', 152], ['100 ms–1 s', 27], ['1 s 以上', 4]])
    expect(bands.reduce((sum, band) => sum + band.share, 0)).toBeCloseTo(1)
    expect(latencyBands({ samples: 0, avg_ms: 0, within_10ms: 0, within_100ms: 0, within_1s: 0 })).toEqual([])
  })

  it('最近一小时请求够多时看最近一小时，不够时退回启动以来的累计', () => {
    const recent: RequestLatency = { samples: 600, avg_ms: 8, within_10ms: 500, within_100ms: 598, within_1s: 600 }
    expect(latencyBasis(withRecent(recent))).toEqual({ latency: recent, recent: true })
    // 夜里一小时只有 49 次请求，几次慢请求不该决定整张卡
    const quiet = { ...recent, samples: MIN_HEALTH_SAMPLES - 1 }
    expect(latencyBasis(withRecent(quiet))).toEqual({ latency: lifetime, recent: false })
    expect(latencyBasis(withRecent(null)).recent).toBe(false)
  })

  it('按 100 ms 内返回的占比判断，没有请求时观察中', () => {
    const at = (within100: number) => latencyHealth({ samples: 100, avg_ms: 10, within_10ms: 0, within_100ms: within100, within_1s: 100 })
    expect(at(95)).toBe('healthy')
    expect(at(94)).toBe('degraded')
    expect(at(80)).toBe('degraded')
    expect(at(79)).toBe('unhealthy')
    expect(latencyHealth({ samples: 0, avg_ms: 0, within_10ms: 0, within_100ms: 0, within_1s: 0 })).toBe('pending')
  })
})

describe('flowView', () => {
  const flow = (over: Partial<FlowControl> = {}): FlowControl => ({
    enabled: true,
    refused: { capacity: 30, memory: 0, connection: 0, queue: 900, stuck: 4, unanswered: 0 },
    turns: 5,
    stuck: 2,
    memory_room: null,
    clients: [
      { client: '192.168.1.20', refused: 800, age_seconds: 90 },
      { client: '192.168.1.33', refused: 40, age_seconds: 7200 },
    ],
    recent: { refused: { capacity: 10, memory: 0, connection: 0, queue: 600, stuck: 0, unanswered: 0 }, turns: 1 },
    ...over,
  })
  const now = 1_800_000_000_000

  it('按最近一小时算，只列拦过的防线和这一小时里被拦过的设备', () => {
    const view = flowView(flow(), 3_540, false, now)
    expect(view.period).toBe('最近一小时')
    expect(view.refused.map((row) => [row.label, row.count])).toEqual([['处理不过来时排不下', 600], ['处理不过来时发得多', 10]])
    expect(view.total).toBe(610)
    expect(view.turns).toBe(1)
    expect(view.clients).toEqual([{ client: '192.168.1.20', refused: 800, ago: '1 分钟前' }])
    expect(view.memory).toBeNull()
  })

  it('没有窗口时按启动以来，设备都列', () => {
    const view = flowView(flow({ recent: null }), null, false, now)
    expect(view.period).toBe('启动以来')
    expect(view.total).toBe(934)
    expect(view.turns).toBe(5)
    expect(view.clients.map((client) => client.client)).toEqual(['192.168.1.20', '192.168.1.33'])
  })

  it('内存：两倍余量以上充足，一到两倍紧张，不到一倍见底', () => {
    expect(flowView(flow({ memory_room: 2 }), 3_600).memory).toEqual({ label: '充足', tone: 'ok' })
    expect(flowView(flow({ memory_room: 1.56 }), 3_600).memory).toEqual({ label: '紧张，剩底线的 1.6 倍', tone: 'warn' })
    expect(flowView(flow({ memory_room: 0.8 }), 3_600).memory).toEqual({ label: '见底', tone: 'bad' })
  })
})
