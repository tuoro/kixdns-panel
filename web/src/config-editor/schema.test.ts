import { describe, expect, it } from 'vitest'
import { SETTING_SECTIONS } from './schema'

// 查询排行一直开着、客户端地址照原样记：基础设置里没有这两个开关
// Rankings are always on with whole client addresses: the settings carry neither switch
describe('查询排行没有开关', () => {
  it('基础设置里没有统计和脱敏', () => {
    const keys = SETTING_SECTIONS.flatMap((section) => section.fields.map((field) => field.key))
    expect(keys).not.toContain('statistics_enabled')
    expect(keys).not.toContain('statistics_anonymize_client_ip')
  })
})

describe('高级规则的选项说面板的话', () => {
  // 允许留下的英文：协议、记录类型、响应码这些本来就这么叫的 / English allowed to stay: names that are spelled this way anyway
  const ALLOWED = new Set(['GeoSite', 'GeoIP', 'EDNS', 'TXT', 'CNAME', 'REFUSED', 'NXDOMAIN', 'TTL', 'MMDB', 'DAT'])
  it('条件、动作、组合方式的名字里没有内核的英文', async () => {
    const { ACTION_TYPES, MATCHER_DEFINITIONS, MATCH_OPERATORS } = await import('./schema')
    const labels = [...ACTION_TYPES, ...MATCH_OPERATORS, ...Object.values(MATCHER_DEFINITIONS).flat()].map((item) => item.label)
    const english = labels.flatMap((label) => label.match(/[A-Za-z]{3,}/g) ?? []).filter((word) => !ALLOWED.has(word))
    expect(english).toEqual([])
  })
})
