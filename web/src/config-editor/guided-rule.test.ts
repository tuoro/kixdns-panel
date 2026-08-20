import { describe, expect, it } from 'vitest'
import {
  cloneGuidedRule,
  createGuidedRuleFromTemplate,
  guidedRuleInsertIndexForRule,
  guidedRuleValidationErrors,
  ignoredActionsAfterTerminal,
} from './guided-rule'
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

describe('一键添加规则', () => {
  it('常用模板生成可继续编辑的完整标准规则', () => {
    const current = pipeline()
    const fallback = createGuidedRuleFromTemplate(current, 'response_fallback', 'global_doh')

    expect(fallback).toMatchObject({
      name: 'response-fallback',
      matchers: [{ type: 'geo_site', value: 'geosite:cn' }],
      actions: [{ type: 'forward' }],
      response_matcher_operator: 'or',
      response_actions_on_match: [
        { type: 'log', level: 'warn' },
        { type: 'jump_to_pipeline', pipeline: 'global_doh' },
      ],
    })
    expect(guidedRuleValidationErrors(fallback, current.id)).toEqual([])
    expect(guidedRuleInsertIndexForRule(current, fallback)).toBe(0)
  })

  it('编辑副本保留未知字段且不修改原规则', () => {
    const original = pipeline().rules[0]!
    original.future_rule_option = { enabled: true }
    original.actions[0]!.future_action_option = 'keep'

    const copy = cloneGuidedRule(original)
    copy.name = 'changed'

    expect(original.name).toBe('fallback-forward')
    expect(copy.future_rule_option).toEqual({ enabled: true })
    expect(copy.actions[0]?.future_action_option).toBe('keep')
  })

  it('校验缺失字段、自跳转和终止动作后的无效动作', () => {
    const current = pipeline()
    const blank = createGuidedRuleFromTemplate(current, 'blank')
    blank.actions = [
      { type: 'jump_to_pipeline', pipeline: current.id },
      { type: 'log', level: 'info' },
    ]

    expect(guidedRuleValidationErrors(blank, current.id)).toContain('不能跳转到当前 Pipeline')
    expect(ignoredActionsAfterTerminal(blank.actions)).toBe(1)
    expect(ignoredActionsAfterTerminal([{ type: 'forward' }, { type: 'log' }], 'response')).toBe(0)
    expect(ignoredActionsAfterTerminal([{ type: 'continue' }, { type: 'log' }], 'response')).toBe(1)
    expect(guidedRuleInsertIndexForRule(current, blank)).toBe(1)

    blank.actions = [{ type: 'continue' }]
    expect(guidedRuleInsertIndexForRule(current, blank)).toBe(0)
  })
})
