import { describe, expect, it } from 'vitest'
import { errorMessage, formatDuration, formatKixdnsVersion, formatPercent, shortHash } from './utils'

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
