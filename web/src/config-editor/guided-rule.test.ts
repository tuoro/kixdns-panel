import { describe, expect, it } from 'vitest'
import { buildGuidedRule, createGuidedRuleDraft, guidedRuleInsertIndex } from './guided-rule'
import type { PipelineConfig } from './types'

function pipeline(): PipelineConfig {
  return {
    id: 'default',
    rules: [{
      name: 'fallback-forward',
      matchers: [],
      matcher_operator: 'and',
      actions: [{ type: 'forward', upstream: '1.1.1.1:53' }],
      response_matchers: [],
      response_matcher_operator: 'and',
      response_actions_on_match: [],
      response_actions_on_miss: [],
    }],
  }
}

describe('引导式规则创建', () => {
  it('将 GeoSite 转发意图生成标准规则', () => {
    const current = pipeline()
    const draft = createGuidedRuleDraft()
    draft.scopeValue = 'geosite:cn'
    draft.targetValue = '223.5.5.5:53'

    expect(buildGuidedRule(current, draft)).toMatchObject({
      name: 'geo-site-cn-forward',
      matchers: [{ type: 'geo_site', operator: 'and', value: 'geosite:cn' }],
      matcher_operator: 'and',
      actions: [{ type: 'forward', upstream: '223.5.5.5:53', transport: '' }],
    })
  })

  it('保留自定义名称并避免与已有规则重名', () => {
    const current = pipeline()
    const draft = createGuidedRuleDraft()
    draft.name = 'fallback-forward'
    draft.scopeValue = 'cn'
    draft.targetValue = '223.5.5.5:53'

    expect(buildGuidedRule(current, draft).name).toBe('fallback-forward-2')
  })

  it('把具体规则放到终止型兜底规则之前，把新兜底规则放在末尾', () => {
    const current = pipeline()
    expect(guidedRuleInsertIndex(current, 'geo_site')).toBe(0)
    expect(guidedRuleInsertIndex(current, 'all')).toBe(1)

    current.rules[0]!.actions = [{ type: 'continue' }]
    expect(guidedRuleInsertIndex(current, 'domain_suffix')).toBe(1)

    current.rules[0]!.actions = [{ type: 'forward' }]
    current.rules[0]!.response_actions_on_match = [{ type: 'continue' }]
    expect(guidedRuleInsertIndex(current, 'qtype')).toBe(0)
  })
})
