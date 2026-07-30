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
