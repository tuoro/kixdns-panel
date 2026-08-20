import { createRule } from './model'
import { MATCHER_DEFINITIONS } from './schema'
import { analyzeRuleFlow, ruleMatchesEveryRequest } from './summary'
import type { ActionConfig, MatcherConfig, MatcherScope, PipelineConfig, RuleConfig } from './types'

export type GuidedRuleTemplateId = 'domain_upstream' | 'cn_split' | 'ad_block' | 'response_fallback' | 'blank'

export interface GuidedRuleTemplate {
  id: GuidedRuleTemplateId
  name: string
  description: string
}

export const GUIDED_RULE_TEMPLATES: GuidedRuleTemplate[] = [
  { id: 'domain_upstream', name: '指定域名上游', description: '指定域名交给单独的 DNS 解析' },
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

function missingMatcherValue(matcher: MatcherConfig, scope: MatcherScope): boolean {
  const fields = MATCHER_DEFINITIONS[scope].find((item) => item.value === matcher.type)?.fields ?? []
  if (fields.includes('value') && !matcher.value?.trim()) return true
  if (fields.includes('cidr') && !matcher.cidr?.trim()) return true
  return fields.includes('country_codes') && (!matcher.country_codes || matcher.country_codes.length === 0)
}

function missingActionValue(action: ActionConfig): boolean {
  if (action.type === 'forward') return !action.upstream?.trim()
  if (action.type === 'jump_to_pipeline') return !action.pipeline?.trim()
  if (action.type === 'static_ip_response') return !action.ip?.trim()
  if (action.type === 'static_txt_response' || action.type === 'replace_txt_response') {
    return Array.isArray(action.text) ? action.text.length === 0 : !action.text?.trim()
  }
  return false
}

export function guidedRuleValidationErrors(
  rule: RuleConfig,
  currentPipelineId: string,
  pipelineIds: readonly string[] = [],
): string[] {
  const errors: string[] = []
  if (!rule.name.trim()) errors.push('请填写规则名称')
  if (rule.matchers.some((matcher) => missingMatcherValue(matcher, 'request'))) errors.push('请补全请求条件')
  if (rule.actions.length === 0) errors.push('请至少添加一个执行动作')
  if (rule.actions.some(missingActionValue)) errors.push('请补全执行动作')
  if (rule.response_matchers.some((matcher) => missingMatcherValue(matcher, 'response'))) errors.push('请补全响应条件')
  const responseActions = [...rule.response_actions_on_match, ...rule.response_actions_on_miss]
  if (responseActions.some(missingActionValue)) errors.push('请补全响应分支动作')
  if ([...rule.actions, ...responseActions].some((action) => action.type === 'jump_to_pipeline' && action.pipeline === currentPipelineId)) {
    errors.push('不能跳转到当前 Pipeline')
  }
  if (pipelineIds.length > 0 && [...rule.actions, ...responseActions].some((action) => (
    action.type === 'jump_to_pipeline' && action.pipeline && !pipelineIds.includes(action.pipeline)
  ))) errors.push('目标 Pipeline 不存在')
  return errors
}

const TERMINAL_ACTION_TYPES = new Set([
  'static_response',
  'static_ip_response',
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
