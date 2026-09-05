import { describe, expect, it } from 'vitest'
import { actionFieldErrors, matcherFieldErrors, REQUIRED_FIELD_ERROR, validDnsName } from './field-validation'
import { createGuidedRuleFromTemplate, guidedRuleValidationErrors } from './guided-rule'
import type { ActionConfig, PipelineConfig } from './types'

describe('配置字段共享校验', () => {
  it('按条件的实际字段检查必填值，并保留未知类型', () => {
    expect(matcherFieldErrors({ type: 'domain_suffix', operator: 'and', value: '  ' }, 'request'))
      .toEqual({ value: REQUIRED_FIELD_ERROR })
    expect(matcherFieldErrors({ type: 'response_answer_ip', operator: 'and' }, 'response'))
      .toEqual({ cidr: REQUIRED_FIELD_ERROR })
    expect(matcherFieldErrors({ type: 'geoip_country', operator: 'and', country_codes: [' '] }, 'selector'))
      .toEqual({ country_codes: REQUIRED_FIELD_ERROR })
    expect(matcherFieldErrors({ type: 'edns_present', operator: 'and', expect: false }, 'request')).toEqual({})
    expect(matcherFieldErrors({ type: 'future_matcher', operator: 'and' }, 'request')).toEqual({})
  })

  it('缺失 CNAME 目标只报告必填错误，非法目标报告格式错误', () => {
    expect(actionFieldErrors({ type: 'static_cname_response', target: ' ' }, 'default'))
      .toEqual({ target: REQUIRED_FIELD_ERROR })
    expect(actionFieldErrors({ type: 'static_cname_response', target: 'bad target' }, 'default'))
      .toEqual({ target: 'CNAME 目标域名格式无效' })
  })

  it('DNS 名称按 UTF-8 字节检查标签与总长度，支持结尾根点', () => {
    expect(validDnsName(' origin.example. ')).toBe(true)
    expect(validDnsName('a..example')).toBe(false)
    expect(validDnsName('.')).toBe(false)
    expect(validDnsName(`${'a'.repeat(63)}.example`)).toBe(true)
    expect(validDnsName(`${'a'.repeat(64)}.example`)).toBe(false)
    expect(validDnsName(`${'中'.repeat(21)}.example`)).toBe(true)
    expect(validDnsName(`${'中'.repeat(22)}.example`)).toBe(false)
    expect(validDnsName([63, 63, 63, 61].map((length) => 'a'.repeat(length)).join('.'))).toBe(true)
    expect(validDnsName([63, 63, 63, 62].map((length) => 'a'.repeat(length)).join('.'))).toBe(false)
  })

  it.each([undefined, 0, 300, 4_294_967_295])('CNAME TTL 接受有效边界 %s', (ttl) => {
    expect(actionFieldErrors({ type: 'static_cname_response', target: 'origin.example.', ttl }, 'default')).toEqual({})
  })

  it.each([-1, 1.5, 4_294_967_296, Number.NaN, Number.POSITIVE_INFINITY])('CNAME TTL 拒绝无效值 %s', (ttl) => {
    expect(actionFieldErrors({ type: 'static_cname_response', target: 'origin.example.', ttl }, 'default'))
      .toEqual({ ttl: 'CNAME TTL 必须是 0 到 4294967295 的整数' })
  })

  it('区分未选择、自跳转、目标不存在；省略列表时不猜测目标是否存在', () => {
    expect(actionFieldErrors({ type: 'jump_to_pipeline', pipeline: '' }, 'default', ['default']))
      .toEqual({ pipeline: REQUIRED_FIELD_ERROR })
    expect(actionFieldErrors({ type: 'jump_to_pipeline', pipeline: 'default' }, 'default', ['default']))
      .toEqual({ pipeline: '不能跳转到当前 Pipeline' })
    expect(actionFieldErrors({ type: 'jump_to_pipeline', pipeline: 'removed' }, 'default', ['default']))
      .toEqual({ pipeline: '目标 Pipeline 不存在' })
    expect(actionFieldErrors({ type: 'jump_to_pipeline', pipeline: 'fallback' }, 'default')).toEqual({})
  })

  it('TXT 必须包含有效文本，未知动作不被前端误判', () => {
    expect(actionFieldErrors({ type: 'static_txt_response', text: [' ', ''] }, 'default'))
      .toEqual({ text: REQUIRED_FIELD_ERROR })
    expect(actionFieldErrors({ type: 'replace_txt_response', text: 'v=spf1' }, 'default')).toEqual({})
    expect(actionFieldErrors({ type: 'future_action', future_field: 'keep' }, 'default')).toEqual({})
  })

  it('引导表单汇总复用同一校验，覆盖两个响应分支并去重', () => {
    const pipeline: PipelineConfig = { id: 'default', rules: [] }
    const rule = createGuidedRuleFromTemplate(pipeline, 'blank')
    const invalidCname: ActionConfig = { type: 'static_cname_response', target: 'bad target', ttl: -1 }
    rule.matchers = [{ type: 'domain_suffix', operator: 'and', value: '' }]
    rule.actions = [{ type: 'forward', upstream: '' }]
    rule.response_matchers = [{ type: 'response_answer_ip', operator: 'and', cidr: '' }]
    rule.response_actions_on_match = [invalidCname]
    rule.response_actions_on_miss = [{ ...invalidCname }, { type: 'jump_to_pipeline', pipeline: 'removed' }]
    expect(guidedRuleValidationErrors(rule, 'default', ['default'])).toEqual([
      '请补全请求条件', '请补全执行动作', '请补全响应条件',
      'CNAME 目标域名格式无效', 'CNAME TTL 必须是 0 到 4294967295 的整数', '目标 Pipeline 不存在',
    ])
  })
})
