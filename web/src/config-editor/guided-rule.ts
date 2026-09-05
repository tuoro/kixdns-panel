import { createRule } from './model'
import { actionFieldErrors, matcherFieldErrors, REQUIRED_FIELD_ERROR } from './field-validation'
import { CONFIG_STATIC_CNAME_RESPONSE_V1 } from './schema'
import { analyzeRuleFlow, ruleMatchesEveryRequest } from './summary'
import type { ActionConfig, PipelineConfig, RuleConfig } from './types'

export type GuidedRuleTemplateId = 'domain_upstream' | 'domain_mapping' | 'cn_split' | 'ad_block' | 'response_fallback' | 'blank'

export interface GuidedRuleTemplate {
  id: GuidedRuleTemplateId
  name: string
  description: string
  requiresCapability?: string
}

export const GUIDED_RULE_TEMPLATES: GuidedRuleTemplate[] = [
  { id: 'domain_upstream', name: '指定域名上游', description: '指定域名交给单独的 DNS 解析' },
  { id: 'domain_mapping', name: '域名映射', description: '把查询域名映射到另一个域名', requiresCapability: CONFIG_STATIC_CNAME_RESPONSE_V1 },
  { id: 'cn_split', name: '国内域名分流', description: 'GeoSite CN 使用国内 DNS' },
  { id: 'ad_block', name: '广告域名拒绝', description: '拒绝广告分类中的域名' },
  { id: 'response_fallback', name: '异常响应回退', description: '异常应答记录日志并切换流程' },
  { id: 'blank', name: '空白组合', description: '从空白规则自由组合条件和动作' },
]

function uniqueRuleName(pipeline: PipelineConfig, requested: string): string {
  const base = requested.trim() || 'guided-rule'
  const used = new Set(pipeline.rules.map((rule) => rule.name))
  if (!used.has(base)) return base
  let index = 2
  while (used.has(`${base}-${index}`)) index += 1
  return `${base}-${index}`
}

function cloneRule(rule: RuleConfig): RuleConfig {
  return JSON.parse(JSON.stringify(rule)) as RuleConfig
}

function namedRule(pipeline: PipelineConfig, name: string): RuleConfig {
  const rule = createRule(pipeline)
  rule.name = uniqueRuleName(pipeline, name)
  return rule
}

export function createGuidedRuleFromTemplate(
  pipeline: PipelineConfig,
  templateId: GuidedRuleTemplateId,
  fallbackPipeline = '',
): RuleConfig {
  const rule = namedRule(pipeline, templateId.replaceAll('_', '-'))
  if (templateId === 'blank') return rule

  if (templateId === 'domain_upstream') {
    rule.matchers = [{ type: 'domain_suffix', operator: 'and', value: 'example.com' }]
    rule.actions = [{ type: 'forward', upstream: '1.1.1.1:53', transport: '' }]
  } else if (templateId === 'domain_mapping') {
    rule.matchers = [{ type: 'domain_suffix', operator: 'and', value: 'alias.example' }]
    rule.actions = [{ type: 'static_cname_response', target: 'origin.example.', ttl: 300 }]
  } else if (templateId === 'cn_split') {
    rule.matchers = [{ type: 'geo_site', operator: 'and', value: 'geosite:cn' }]
    rule.actions = [{ type: 'forward', upstream: '223.5.5.5:53', transport: '' }]
  } else if (templateId === 'ad_block') {
    rule.matchers = [{ type: 'geo_site', operator: 'and', value: 'geosite:category-ads-all' }]
    rule.actions = [{ type: 'deny' }]
  } else {
    rule.matchers = [{ type: 'geo_site', operator: 'and', value: 'geosite:cn' }]
    rule.actions = [{
      type: 'forward',
      upstream: 'https://doh.pub/dns-query, https://dns.alidns.com/dns-query',
      transport: '',
    }]
    rule.response_matchers = [
      { type: 'response_answer_ip', operator: 'and', cidr: '0.0.0.0/32' },
      { type: 'response_answer_ip', operator: 'and', cidr: '240.0.0.0/4' },
      { type: 'response_answer_ip', operator: 'and', cidr: '255.255.255.255/32' },
    ]
    rule.response_matcher_operator = 'or'
    rule.response_actions_on_match = [
      { type: 'log', level: 'warn' },
      { type: 'jump_to_pipeline', pipeline: fallbackPipeline },
    ]
  }
  return rule
}

export function cloneGuidedRule(rule: RuleConfig): RuleConfig {
  return cloneRule(rule)
}

export function guidedRuleValidationErrors(
  rule: RuleConfig,
  currentPipelineId: string,
  pipelineIds: readonly string[] = [],
): string[] {
  const errors: string[] = []
  const requestMatcherErrors = rule.matchers.flatMap((matcher) => Object.values(matcherFieldErrors(matcher, 'request')))
  const responseMatcherErrors = rule.response_matchers.flatMap((matcher) => Object.values(matcherFieldErrors(matcher, 'response')))
  const requestActionErrors = rule.actions.flatMap((action) => Object.values(actionFieldErrors(action, currentPipelineId, pipelineIds)))
  const responseActionErrors = [...rule.response_actions_on_match, ...rule.response_actions_on_miss]
    .flatMap((action) => Object.values(actionFieldErrors(action, currentPipelineId, pipelineIds)))
  if (!rule.name.trim()) errors.push('请填写规则名称')
  if (requestMatcherErrors.includes(REQUIRED_FIELD_ERROR)) errors.push('请补全请求条件')
  if (rule.actions.length === 0) errors.push('请至少添加一个执行动作')
  if (requestActionErrors.includes(REQUIRED_FIELD_ERROR)) errors.push('请补全执行动作')
  if (responseMatcherErrors.includes(REQUIRED_FIELD_ERROR)) errors.push('请补全响应条件')
  if (responseActionErrors.includes(REQUIRED_FIELD_ERROR)) errors.push('请补全响应分支动作')
  const fieldErrors = [...requestMatcherErrors, ...responseMatcherErrors, ...requestActionErrors, ...responseActionErrors]
  return [...new Set([...errors, ...fieldErrors.filter((error) => error !== REQUIRED_FIELD_ERROR)])]
}

const TERMINAL_ACTION_TYPES = new Set([
  'static_response',
  'static_ip_response',
  'static_cname_response',
  'static_txt_response',
  'replace_txt_response',
  'jump_to_pipeline',
  'allow',
  'deny',
  'continue',
])

export function ignoredActionsAfterTerminal(actions: ActionConfig[], stage: 'request' | 'response' = 'request'): number {
  const terminalIndex = actions.findIndex((action) => (
    TERMINAL_ACTION_TYPES.has(action.type) || (stage === 'request' && action.type === 'forward')
  ))
  return terminalIndex >= 0 ? Math.max(0, actions.length - terminalIndex - 1) : 0
}

export function guidedRuleInsertIndexForRule(pipeline: PipelineConfig, rule: RuleConfig): number {
  if (ruleMatchesEveryRequest(rule)) {
    const flow = analyzeRuleFlow(rule)
    if (flow.kind !== 'continue' && flow.kind !== 'conditional') return pipeline.rules.length
  }
  const blockerIndex = pipeline.rules.findIndex((item) => {
    const flow = analyzeRuleFlow(item)
    return ruleMatchesEveryRequest(item) && flow.kind !== 'continue'
  })
  return blockerIndex < 0 ? pipeline.rules.length : blockerIndex
}
