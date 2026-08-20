import { describe, expect, it } from 'vitest'
import { analyzeRuleFlow, findBlockingRule, ruleMatchesEveryRequest, summarizeAction, summarizeMatchers, summarizeRule } from './summary'
import type { PipelineConfig, RuleConfig } from './types'

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
