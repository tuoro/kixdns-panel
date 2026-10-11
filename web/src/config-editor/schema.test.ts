import { describe, expect, it } from 'vitest'
import {
  CONFIG_QUERY_STATS_V1,
  SETTING_SECTIONS,
  settingShouldRender,
  settingSupported,
} from './schema'

const statisticsField = SETTING_SECTIONS
  .flatMap((section) => section.fields)
  .find((field) => field.key === 'statistics_enabled')!

describe('配置字段能力门控', () => {
  it('接受正式能力和旧版运行时别名', () => {
    expect(settingSupported(statisticsField, [CONFIG_QUERY_STATS_V1])).toBe(true)
    expect(settingSupported(statisticsField, ['stats_top_v1'])).toBe(true)
  })

  it('隐藏不受支持且尚未存在的字段', () => {
    expect(settingShouldRender(statisticsField, {}, [])).toBe(false)
  })

  it('只读保留配置中已经存在的不受支持字段', () => {
    expect(settingShouldRender(statisticsField, { statistics_enabled: false }, [])).toBe(true)
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
