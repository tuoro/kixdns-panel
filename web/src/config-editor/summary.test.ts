import { describe, expect, it } from 'vitest'
import { analyzeRuleFlow, findBlockingRule, ruleMatchesEveryRequest, summarizeAction, summarizeMatchers, summarizeRule } from './summary'
import type { PipelineConfig, RuleConfig } from './types'

describe('规则语义摘要', () => {
  it('将 GeoSite 与查询类型表达为全部满足的自然语言', () => {
    expect(summarizeMatchers([
      { type: 'geo_site', operator: 'and', value: 'cn' },
      { type: 'qtype', operator: 'and', value: 'A' },
    ], 'and', 'request')).toBe('域名属于 GeoSite cn 且 查询类型为 A')
    expect(summarizeMatchers([
      { type: 'geo_site', operator: 'and', value: 'geosite:cn' },
    ], 'and', 'request')).toBe('域名属于 GeoSite cn')
  })

  it('保留任一满足和自定义否定关系', () => {
    expect(summarizeMatchers([
      { type: 'geo_site', operator: 'and', value: 'cn' },
      { type: 'geo_site', operator: 'and', value: 'private' },
    ], 'or', 'request')).toBe('域名属于 GeoSite cn 或 private')
    // 同一种条件用「或」连起来时并成一句，不把前半句念三遍 / Same-type OR conditions merge into one sentence instead of repeating the lead
    expect(summarizeMatchers([
      { type: 'response_answer_ip', operator: 'and', cidr: '0.0.0.0/32' },
      { type: 'response_answer_ip', operator: 'and', cidr: '240.0.0.0/4' },
      { type: 'response_answer_ip', operator: 'and', cidr: '255.255.255.255/32' },
    ], 'or', 'response')).toBe('应答 IP 属于 0.0.0.0/32、240.0.0.0/4 或 255.255.255.255/32')
    // 否定的不并：「不属于 A 或 B」读起来是两个都不属于，内核算的是「不属于 A」或「不属于 B」
    // Negations never merge: 「不属于 A 或 B」 reads as outside both, while the kernel evaluates (not A) or (not B)
    expect(summarizeMatchers([
      { type: 'geo_site_not', operator: 'and', value: 'cn' },
      { type: 'geo_site_not', operator: 'and', value: 'private' },
    ], 'or', 'request')).toBe('域名不属于 GeoSite cn 或 域名不属于 GeoSite private')
    // 「且」不能这样并：属于 A 且属于 B 不是属于「A、B」 / AND cannot merge: in A and in B is not in 「A、B」
    expect(summarizeMatchers([
      { type: 'geo_site', operator: 'and', value: 'cn' },
      { type: 'geo_site', operator: 'and', value: 'private' },
    ], 'and', 'request')).toBe('域名属于 GeoSite cn 且 域名属于 GeoSite private')

    expect(summarizeMatchers([
      { type: 'domain_suffix', operator: 'and', value: '.example' },
      { type: 'client_ip', operator: 'and_not', cidr: '192.0.2.0/24' },
    ], 'and', 'request')).toBe('域名后缀为 .example 且非 客户端 IP 属于 192.0.2.0/24')
  })

  it('准确摘要主要动作并保留未知动作类型', () => {
    expect(summarizeAction({ type: 'forward', upstream: '1.1.1.1:53', transport: 'udp' }))
      .toBe('转发至 1.1.1.1:53 (UDP)')
    expect(summarizeAction({ type: 'static_cname_response', target: 'origin.example.' }))
      .toBe('将域名映射到 origin.example.')
    expect(summarizeAction({ type: 'continue' })).toBe('继续匹配后续规则')
    expect(summarizeAction({ type: 'future_action' })).toBe('执行 future_action')
    // 传输方式按人的叫法写，不出现 TCP_UDP、DOH 这样的配置值。 / Transports as people say them, not config values.
    expect(summarizeAction({ type: 'forward', upstream: '223.5.5.5:53', transport: 'tcp_udp' })).toBe('转发至 223.5.5.5:53 (TCP+UDP)')
    expect(summarizeAction({ type: 'forward', upstream: 'https://dns.google/dns-query', transport: 'doh' })).toBe('转发至 https://dns.google/dns-query (DoH)')
    expect(summarizeAction({ type: 'forward', upstream: 'x', transport: 'future' })).toBe('转发至 x (FUTURE)')
    // 几个上游用顿号隔开 / Several upstreams are separated by 、
    expect(summarizeAction({ type: 'forward', upstream: 'https://doh.pub/dns-query,https://dns.alidns.com/dns-query', transport: 'doh' }))
      .toBe('转发至 https://doh.pub/dns-query、https://dns.alidns.com/dns-query (DoH)')
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

  it('按照真实请求动作顺序区分终止、继续和响应后继续', () => {
    const makeRule = (actions: RuleConfig['actions']): RuleConfig => ({
      name: 'rule',
      matchers: [],
      matcher_operator: 'and',
      actions,
      response_matchers: [],
      response_matcher_operator: 'and',
      response_actions_on_match: [],
      response_actions_on_miss: [],
    })

    expect(analyzeRuleFlow(makeRule([{ type: 'log' }, { type: 'continue' }])).kind).toBe('continue')
    expect(analyzeRuleFlow(makeRule([{ type: 'static_response', rcode: 'NXDOMAIN' }])).kind).toBe('terminate')
    expect(analyzeRuleFlow(makeRule([{ type: 'static_cname_response', target: 'origin.example.' }])).kind).toBe('terminate')
    expect(analyzeRuleFlow(makeRule([{ type: 'jump_to_pipeline', pipeline: 'next' }])).kind).toBe('jump')

    const forwarding = makeRule([{ type: 'forward', upstream: '1.1.1.1:53' }])
    forwarding.response_actions_on_match = [{ type: 'continue' }]
    expect(analyzeRuleFlow(forwarding).kind).toBe('conditional')
    expect(analyzeRuleFlow(makeRule([{ type: 'future_action' }])).kind).toBe('unknown')
  })

  it('只对能够静态确定的全匹配规则报告后续遮挡', () => {
    const pipeline: PipelineConfig = {
      id: 'default',
      rules: [
        {
          name: 'fallback',
          matchers: [{ type: 'any', operator: 'and' }],
          matcher_operator: 'and',
          actions: [{ type: 'forward' }],
          response_matchers: [],
          response_matcher_operator: 'and',
          response_actions_on_match: [],
          response_actions_on_miss: [],
        },
        {
          name: 'specific',
          matchers: [{ type: 'geo_site', operator: 'and', value: 'cn' }],
          matcher_operator: 'and',
          actions: [{ type: 'deny' }],
          response_matchers: [],
          response_matcher_operator: 'and',
          response_actions_on_match: [],
          response_actions_on_miss: [],
        },
      ],
    }

    expect(ruleMatchesEveryRequest(pipeline.rules[0]!)).toBe(true)
    expect(ruleMatchesEveryRequest(pipeline.rules[1]!)).toBe(false)
    expect(findBlockingRule(pipeline, 1)).toEqual({ index: 0, name: 'fallback' })

    pipeline.rules[0]!.actions = [{ type: 'continue' }]
    expect(findBlockingRule(pipeline, 1)).toBeUndefined()
  })
})
