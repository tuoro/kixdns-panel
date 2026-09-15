import { describe, expect, it } from 'vitest'
import { errorMessage, formatCompactNumber, formatDuration, formatKixdnsVersion, formatPercent, shortHash, upstreamSuccessRate } from './utils'

describe('界面格式化工具', () => {
  it('生成稳定且紧凑的运行指标', () => {
    expect(formatPercent(0.81234)).toBe('81.2%')
    expect(formatDuration(0)).toBe('0 秒')
    expect(formatDuration(59)).toBe('59 秒')
    expect(formatDuration(60)).toBe('0 小时 1 分钟')
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
  it('并发竞争中被取消的尝试不计入分母', () => {
    // 两个上游各尝试 20 次，1.1.1.1 每次胜出，8.8.8.8 每次落败但从未失败
    expect(upstreamSuccessRate({ attempts: 20, success: 20, aborted: 0 })).toBe(1)
    expect(upstreamSuccessRate({ attempts: 20, success: 0, aborted: 20 })).toBe(0)
    expect(upstreamSuccessRate({ attempts: 20, success: 4, aborted: 15 })).toBeCloseTo(0.8)
  })

  it('旧增强版没有 aborted 字段时退化为成功除以尝试', () => {
    expect(upstreamSuccessRate({ attempts: 10, success: 7 })).toBeCloseTo(0.7)
    expect(upstreamSuccessRate({ attempts: 0, success: 0 })).toBe(0)
  })
})

describe('formatCompactNumber', () => {
  it('万位以下保持原样，不做无谓缩写', () => {
    expect(formatCompactNumber(0)).toBe('0')
    expect(formatCompactNumber(9_999)).toBe('9,999')
  })

  it('万位起缩写并保留一位小数，避免失真', () => {
    // 概览页那个真实数值：断行前是 12,847,39 / 2，缩写后一行放得下
    expect(formatCompactNumber(12_847_392)).toBe('1,284.7 万')
    expect(formatCompactNumber(10_000)).toBe('1.0 万')
  })

  it('量级足够大时不再保留小数', () => {
    expect(formatCompactNumber(123_456_789_0)).toBe('12.3 亿')
    // 9,999 万那位小数相对整数部分不足万分之一，读者用不上
    expect(formatCompactNumber(99_990_000)).toBe('9,999 万')
  })

  it('负数按绝对值选择量级', () => {
    expect(formatCompactNumber(-12_847_392)).toBe('-1,284.7 万')
  })
})
