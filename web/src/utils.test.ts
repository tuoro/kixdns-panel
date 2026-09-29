import { describe, expect, it } from 'vitest'
import { errorMessage, formatAgo, formatDuration, formatKixdnsVersion, formatPercent, formatSmallPercent, formatVersionTime, shortHash, upstreamSuccessRate } from './utils'

describe('界面格式化工具', () => {
  it('生成稳定且紧凑的运行指标', () => {
    expect(formatPercent(0.81234)).toBe('81.2%')
    expect(formatDuration(0)).toBe('0 秒')
    expect(formatDuration(59)).toBe('59 秒')
    expect(formatDuration(60)).toBe('1 分钟')
    expect(formatDuration(1260)).toBe('21 分钟')
    expect(formatDuration(3600)).toBe('1 小时')
    expect(formatDuration(3660)).toBe('1 小时 1 分钟')
    expect(formatDuration(86400)).toBe('1 天')
    expect(formatDuration(90061)).toBe('1 天 1 小时')
    expect(shortHash('0123456789abcdef', 8)).toBe('01234567')
    expect(shortHash(null)).toBe('未记录')
  })

  it('不会把未知异常直接渲染为对象字符串', () => {
    expect(errorMessage(new Error('明确错误'))).toBe('明确错误')
    expect(errorMessage({ secret: 'value' })).toBe('操作失败，请稍后重试')
  })

  it('使用上游身份展示 KixDNS 版本', () => {
    expect(formatKixdnsVersion({ source: 'release', source_id: 1, run_id: null, release_tag: 'v0.1.1' })).toBe('v0.1.1')
    expect(formatKixdnsVersion({ source: 'action', source_id: 2, run_id: 30235703570, release_tag: null })).toBe('Run #30235703570')
    expect(formatKixdnsVersion({ source: 'action', source_id: 8695590365, run_id: null, release_tag: null })).toBe('Artifact #8695590365')
    expect(formatKixdnsVersion(null)).toBe('未记录')
  })
})

describe('上游成功率', () => {
  it('只把超时和连接错误算作失败', () => {
    expect(upstreamSuccessRate({ success: 95, errors: 5 })).toBeCloseTo(0.95)
    // 上游如实回了 SERVFAIL / REFUSED：那是域名或上游策略的问题，归在响应码分布里，不拖成功率
    const answeredWithServfail = { attempts: 70, success: 20, errors: 0, rejected: 30, aborted: 20 }
    expect(upstreamSuccessRate(answeredWithServfail)).toBe(1)
  })

  it('并发竞争中被取消的尝试不计入分母', () => {
    const lostMostRaces = { attempts: 20, success: 4, errors: 1, rejected: 0, aborted: 15 }
    expect(upstreamSuccessRate(lostMostRaces)).toBeCloseTo(0.8)
  })

  it('没有可判断的响应时为 0', () => {
    expect(upstreamSuccessRate({ success: 0, errors: 0 })).toBe(0)
  })
})

describe('极小占比', () => {
  it('发生过但四舍五入到 0.0% 时写成「低于 0.1%」', () => {
    // 1,204 次 / 1,284.7 万次 = 0.0094%，直接格式化会写成 0.0%。
    expect(formatSmallPercent(1_204 / 12_847_392)).toBe('低于 0.1%')
  })

  it('真正为零时仍然写 0.0%，不和「极小」混为一谈', () => {
    expect(formatSmallPercent(0)).toBe('0.0%')
  })

  it('刚好到得了一位小数就照常显示', () => {
    expect(formatSmallPercent(0.001)).toBe('0.1%')
    expect(formatSmallPercent(0.0005)).toBe('0.1%')
  })

  it('负值不当作极小值处理', () => {
    expect(formatSmallPercent(-0.0001)).toBe('-0.0%')
  })
})

describe('formatVersionTime', () => {
  // 以本地时间 2026-09-26 12:00 为「现在」 / "Now" is 2026-09-26 12:00 local time
  const now = new Date(2026, 8, 26, 12, 0).getTime()
  const at = (...parts: [number, number, number, number, number]) => new Date(...parts).getTime() / 1000

  it('今天和昨天写字，不写秒', () => {
    expect(formatVersionTime(at(2026, 8, 26, 0, 5), now)).toBe('今天 00:05')
    expect(formatVersionTime(at(2026, 8, 25, 18, 46), now)).toBe('昨天 18:46')
    expect(formatVersionTime(at(2026, 8, 25, 0, 0), now)).toBe('昨天 00:00')
  })

  it('今年更早的只写月日和时间，往年写年月日', () => {
    expect(formatVersionTime(at(2026, 8, 24, 18, 46), now)).toBe('09/24 18:46')
    expect(formatVersionTime(at(2025, 11, 31, 23, 59), now)).toBe('2025/12/31')
  })
})

describe('formatAgo', () => {
  const now = 1_790_000_000_000
  it('按分钟、小时、天往上走，不写秒', () => {
    expect(formatAgo(now / 1000 - 20, now)).toBe('刚刚')
    expect(formatAgo(now / 1000 - 5 * 60, now)).toBe('5 分钟前')
    expect(formatAgo(now / 1000 - 3 * 3600, now)).toBe('3 小时前')
    expect(formatAgo(now / 1000 - 3 * 86_400 - 60, now)).toBe('3 天前')
  })
})
