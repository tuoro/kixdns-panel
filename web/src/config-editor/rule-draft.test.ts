import { describe, expect, it } from 'vitest'
import { createGuidedRuleFromTemplate, guidedRuleValidationErrors } from './guided-rule'
import { hasResponseProcessing, responseValidationErrors, withResponseState } from './rule-draft'
import type { PipelineConfig } from './types'

const pipeline: PipelineConfig = { id: 'default', rules: [] }

describe('响应处理编辑状态', () => {
  it('关闭响应后忽略未补全的隐藏字段，再开启恢复原有草稿', () => {
    const draft = createGuidedRuleFromTemplate(pipeline, 'response_fallback', 'missing')
    draft.response_matchers[0]!.cidr = ''
    const original = structuredClone(draft)
    const enabled = withResponseState(draft, true)
    expect(guidedRuleValidationErrors(enabled, pipeline.id, ['default'])).toEqual(expect.arrayContaining([
      '请补全响应条件',
      '目标 Pipeline 不存在',
    ]))

    const disabled = withResponseState(draft, false)
    expect(hasResponseProcessing(disabled)).toBe(false)
    expect(guidedRuleValidationErrors(disabled, pipeline.id, ['default'])).toEqual([])
    expect(draft).toEqual(original)
    expect(withResponseState(draft, true)).toEqual(original)
  })

  it('无响应匹配条件但存在任一分支动作时，仍应展开现有响应设置', () => {
    const rule = createGuidedRuleFromTemplate(pipeline, 'domain_upstream')
    expect(hasResponseProcessing(rule)).toBe(false)
    rule.response_actions_on_miss = [{ type: 'continue' }]
    expect(hasResponseProcessing(rule)).toBe(true)
    expect(responseValidationErrors(rule, true)).toEqual([])
  })

  it('启用时要求转发和分支动作，关闭后不阻止普通规则提交', () => {
    const rule = createGuidedRuleFromTemplate(pipeline, 'ad_block')
    expect(responseValidationErrors(rule, true)).toEqual([
      '响应处理需要先添加转发动作',
      '请至少配置一个响应分支动作',
    ])
    expect(responseValidationErrors(rule, false)).toEqual([])
    rule.actions = [{ type: 'forward', upstream: '1.1.1.1:53' }]
    expect(responseValidationErrors(rule, true)).toEqual(['请至少配置一个响应分支动作'])
    rule.response_actions_on_match = [{ type: 'log', level: 'warn' }]
    expect(responseValidationErrors(rule, true)).toEqual([])
  })
})
