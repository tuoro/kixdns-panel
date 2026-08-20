import { describe, expect, it } from 'vitest'
import { summarizeAction, summarizeMatchers, summarizeRule } from './summary'
import type { RuleConfig } from './types'

describe('规则语义摘要', () => {
  it('将 GeoSite 与查询类型表达为全部满足的自然语言', () => {
    expect(summarizeMatchers([
      { type: 'geo_site', operator: 'and', value: 'cn' },
      { type: 'qtype', operator: 'and', value: 'A' },
    ], 'and', 'request')).toBe('域名属于 GeoSite cn 且 查询类型为 A')
  })

  it('保留任一满足和自定义否定关系', () => {
    expect(summarizeMatchers([
      { type: 'geo_site', operator: 'and', value: 'cn' },
      { type: 'geo_site', operator: 'and', value: 'private' },
    ], 'or', 'request')).toBe('域名属于 GeoSite cn 或 域名属于 GeoSite private')

    expect(summarizeMatchers([
      { type: 'domain_suffix', operator: 'and', value: '.example' },
      { type: 'client_ip', operator: 'and_not', cidr: '192.0.2.0/24' },
    ], 'and', 'request')).toBe('域名后缀为 .example 且非 客户端 IP 属于 192.0.2.0/24')
  })

  it('准确摘要主要动作并保留未知动作类型', () => {
    expect(summarizeAction({ type: 'forward', upstream: '1.1.1.1:53', transport: 'udp' }))
      .toBe('转发至 1.1.1.1:53（UDP）')
    expect(summarizeAction({ type: 'continue' })).toBe('继续匹配后续规则')
    expect(summarizeAction({ type: 'future_action' })).toBe('执行 future_action')
  })

  it('为完整规则分别生成条件和动作摘要', () => {
    const rule: RuleConfig = {
      name: 'domestic',
      matchers: [],
      matcher_operator: 'and',
      actions: [{ type: 'deny' }],
      response_matchers: [],
      response_matcher_operator: 'and',
      response_actions_on_match: [],
      response_actions_on_miss: [],
    }

    expect(summarizeRule(rule)).toEqual({ condition: '任意请求', action: '拒绝请求' })
  })
})
