import { createRule } from './model'
import { actionFieldErrors, isRequiredFieldError, matcherFieldErrors } from './field-validation'
import { CONFIG_STATIC_CNAME_RESPONSE_V1 } from './schema'
import { analyzeRuleFlow, ruleMatchesEveryRequest } from './summary'
import type { ActionConfig, PipelineConfig, RuleConfig } from './types'

export type GuidedRuleTemplateId = 'domain_upstream' | 'domain_mapping' | 'cn_split' | 'ad_block' | 'response_fallback' | 'blank'

export interface GuidedRuleTemplate {
  id: GuidedRuleTemplateId
  name: string
  description: string
  // 说明里的机器值（地址），画成等宽 / Machine values in the description (addresses), set in mono
  values?: string[]
  requiresCapability?: string
}

// 添加入口和一键添加规则都有的起点，名字和说明只写这一次，两边一字不差（审计 D11）
// Starting points both 添加入口 and the rule dialog offer; their names and descriptions are written once, identical in both (audit D11)
export const SHARED_TEMPLATE_COPY = {
  domain_upstream: { name: '指定域名上游', description: '指定域名使用独立 DNS' },
  domain_mapping: { name: '域名映射', description: '把查询域名映射到另一个域名' },
  ad_block: { name: '广告域名拒绝', description: '拒绝广告分类中的域名' },
  blank: { name: '空白方案', description: '从空白条件和动作开始' },
} as const

// 规则层面的「国内域名」只是一条规则，和添加入口里一次建两个入口的「国内外 DNS 分流」不是一回事，名字不能像
// The rule-level domestic template is a single rule, not 添加入口's two-entry 国内外 DNS 分流, and must not be named like it
export const GUIDED_RULE_TEMPLATES: GuidedRuleTemplate[] = [
  { id: 'domain_upstream', ...SHARED_TEMPLATE_COPY.domain_upstream },
  { id: 'domain_mapping', ...SHARED_TEMPLATE_COPY.domain_mapping, requiresCapability: CONFIG_STATIC_CNAME_RESPONSE_V1 },
  { id: 'cn_split', name: '国内域名走国内 DNS', description: 'GeoSite cn 转发至 223.5.5.5', values: ['223.5.5.5'] },
  { id: 'ad_block', ...SHARED_TEMPLATE_COPY.ad_block },
  { id: 'response_fallback', name: '异常响应回退', description: '异常响应记录日志并切换流程' },
  { id: 'blank', ...SHARED_TEMPLATE_COPY.blank },
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

// 模板只写做法，不替人做选择：异常响应回退跳去哪个 Pipeline 留空，选了模板就显示「还差 1 项」（规范 3.6，审计第六轮 D3）
// Templates write the method and never make a choice for you: where 异常响应回退 jumps starts empty, so the template shows 还差 1 项 (spec 3.6, audit round 6, D3)
export function createGuidedRuleFromTemplate(pipeline: PipelineConfig, templateId: GuidedRuleTemplateId): RuleConfig {
  const rule = namedRule(pipeline, templateId.replaceAll('_', '-'))
  if (templateId === 'blank') return rule

  // 域名和映射目标留空，示例只在占位符里（审计第二轮 B1） / Domains and mapping targets start empty, the example only in the placeholder (audit round 2, B1)
  if (templateId === 'domain_upstream') {
    rule.matchers = [{ type: 'domain_suffix', operator: 'and', value: '' }]
    rule.actions = [{ type: 'forward', upstream: '1.1.1.1:53', transport: '' }]
  } else if (templateId === 'domain_mapping') {
    rule.matchers = [{ type: 'domain_suffix', operator: 'and', value: '' }]
    rule.actions = [{ type: 'static_cname_response', target: '', ttl: 300 }]
  } else if (templateId === 'cn_split') {
    rule.matchers = [{ type: 'geo_site', operator: 'and', value: 'cn' }]
    rule.actions = [{ type: 'forward', upstream: '223.5.5.5:53', transport: '' }]
  } else if (templateId === 'ad_block') {
    rule.matchers = [{ type: 'geo_site', operator: 'and', value: 'category-ads-all' }]
    rule.actions = [{ type: 'deny' }]
  } else {
    rule.matchers = [{ type: 'geo_site', operator: 'and', value: 'cn' }]
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
      { type: 'jump_to_pipeline', pipeline: '' },
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
  if (requestMatcherErrors.some(isRequiredFieldError)) errors.push('请补全请求条件')
  if (rule.actions.length === 0) errors.push('至少要一个动作')
  if (requestActionErrors.some(isRequiredFieldError)) errors.push('请补全执行动作')
  if (responseMatcherErrors.some(isRequiredFieldError)) errors.push('请补全响应条件')
  if (responseActionErrors.some(isRequiredFieldError)) errors.push('请补全响应分支动作')
  const fieldErrors = [...requestMatcherErrors, ...responseMatcherErrors, ...requestActionErrors, ...responseActionErrors]
  return [...new Set([...errors, ...fieldErrors.filter((error) => !isRequiredFieldError(error))])]
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
