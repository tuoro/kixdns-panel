import type { ActionConfig, MatcherConfig, MatcherScope, PipelineConfig, RuleConfig } from './types'

export type RuleFlowKind = 'continue' | 'terminate' | 'jump' | 'conditional' | 'unknown'

export interface RuleFlowSummary {
  kind: RuleFlowKind
  label: string
}

export interface BlockingRuleSummary {
  index: number
  name: string
}

function text(value: unknown, fallback = '未设置'): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    if (items.length) return items.join('、')
  }
  return fallback
}

function expectation(matcher: MatcherConfig, positive: string, negative: string): string {
  return matcher.expect === false ? negative : positive
}

function geoSiteValue(value: unknown): string {
  return text(value).replace(/^geosite:/i, '')
}

export function summarizeMatcher(matcher: MatcherConfig, scope: MatcherScope): string {
  const value = text(matcher.value)
  const cidr = text(matcher.cidr)
  const countries = text(matcher.country_codes)

  switch (matcher.type) {
    case 'any': return '任意请求'
    case 'listener_label': return `监听标签为 ${value}`
    case 'client_ip': return `客户端 IP 属于 ${cidr}`
    case 'domain_suffix': return `域名后缀为 ${value}`
    case 'domain_regex': return `域名匹配正则 ${value}`
    case 'qclass': return `查询 QClass 为 ${value}`
    case 'edns_present': return expectation(matcher, '请求包含 EDNS', '请求不包含 EDNS')
    case 'geo_site': return `域名属于 GeoSite ${geoSiteValue(matcher.value)}`
    case 'geo_site_not': return `域名不属于 GeoSite ${geoSiteValue(matcher.value)}`
    case 'geoip_country': return `客户端 GeoIP 国家为 ${countries}`
    case 'geoip_private': return expectation(matcher, '客户端 IP 为私网', '客户端 IP 不为私网')
    case 'qtype': return `查询类型为 ${value}`
    case 'upstream_equals': return `实际上游为 ${value}`
    case 'request_domain_suffix': return `请求域名后缀为 ${value}`
    case 'request_domain_regex': return `请求域名匹配正则 ${value}`
    case 'response_type': return `响应类型为 ${value}`
    case 'response_rcode': return `响应 RCode 为 ${value}`
    case 'response_qclass': return `响应 QClass 为 ${value}`
    case 'response_edns_present': return expectation(matcher, '响应包含 EDNS', '响应不包含 EDNS')
    case 'response_upstream_ip': return `上游 IP 属于 ${cidr}`
    case 'response_answer_ip': return `应答 IP 属于 ${cidr}`
    case 'response_answer_ip_geoip_country': return `应答 IP GeoIP 国家为 ${countries}`
    case 'response_answer_ip_geoip_private': return expectation(matcher, '应答 IP 为私网', '应答 IP 不为私网')
    case 'response_request_domain_geosite': return `请求域名属于 GeoSite ${geoSiteValue(matcher.value)}`
    case 'response_request_domain_geosite_not': return `请求域名不属于 GeoSite ${geoSiteValue(matcher.value)}`
    case 'response_txt_content': return `TXT 内容以${matcher.mode === 'prefix' ? '前缀' : matcher.mode === 'regex' ? '正则' : '精确'}方式匹配 ${value}`
    default: return `${scope === 'response' ? '响应条件' : '请求条件'} ${matcher.type}`
  }
}

export function summarizeMatchers(
  matchers: MatcherConfig[],
  matcherOperator: string,
  scope: MatcherScope,
): string {
  if (matchers.length === 0) return scope === 'response' ? '任意响应' : '任意请求'
  const summaries = matchers.map((matcher) => summarizeMatcher(matcher, scope))
  if (summaries.length === 1) return summaries[0]!
  if (matchers.every((matcher) => matcher.operator === 'and')) {
    return summaries.join(matcherOperator === 'or' ? ' 或 ' : ' 且 ')
  }

  return summaries.reduce((result, summary, index) => {
    if (index === 0) return summary
    const operator = matchers[index]?.operator
    const conjunction = operator === 'or'
      ? ' 或 '
      : operator === 'and_not'
        ? ' 且非 '
        : operator === 'or_not'
          ? ' 或非 '
          : operator === 'not'
            ? ' 非 '
            : ' 且 '
    return `${result}${conjunction}${summary}`
  }, '')
}

export function summarizeAction(action: ActionConfig): string {
  switch (action.type) {
    case 'log': return `记录 ${text(action.level, 'info')} 日志`
    case 'static_response': return `返回 ${text(action.rcode)}`
    case 'static_ip_response': return `返回 IP ${text(action.ip)}`
    case 'static_cname_response': return `将域名映射到 ${text(action.target)}`
    case 'static_txt_response': return `返回 TXT ${text(action.text)}`
    case 'replace_txt_response': return `替换 TXT 为 ${text(action.text)}`
    case 'jump_to_pipeline': return `跳转至 Pipeline ${text(action.pipeline, '未选择')}`
    case 'allow': return '允许当前结果'
    case 'deny': return '拒绝请求'
    case 'forward': {
      const transport = text(action.transport, '')
      return `转发至 ${text(action.upstream, '默认上游')}${transport ? `（${transport.toUpperCase()}）` : ''}`
    }
    case 'continue': return '继续匹配后续规则'
    default: return `执行 ${action.type}`
  }
}

export function summarizeActions(actions: ActionConfig[]): string {
  if (actions.length === 0) return '未配置动作'
  return actions.map(summarizeAction).join('，然后 ')
}

export function summarizeRule(rule: RuleConfig): { condition: string; action: string } {
  return {
    condition: summarizeMatchers(rule.matchers, rule.matcher_operator, 'request'),
    action: summarizeActions(rule.actions),
  }
}

function hasResponseContinue(rule: RuleConfig): boolean {
  return [...rule.response_actions_on_match, ...rule.response_actions_on_miss]
    .some((action) => action.type === 'continue')
}

export function analyzeRuleFlow(rule: RuleConfig): RuleFlowSummary {
  if (rule.actions.filter((action) => action.type === 'forward').length > 1) {
    return hasResponseContinue(rule)
      ? { kind: 'conditional', label: '响应后可能继续' }
      : { kind: 'terminate', label: '在此终止' }
  }

  for (const action of rule.actions) {
    if (action.type === 'log') continue
    if (action.type === 'continue' || action.type === 'replace_txt_response') {
      return { kind: 'continue', label: '继续后续规则' }
    }
    if (action.type === 'jump_to_pipeline') return { kind: 'jump', label: '跳转流程' }
    if (action.type === 'forward') {
      return hasResponseContinue(rule)
        ? { kind: 'conditional', label: '响应后可能继续' }
        : { kind: 'terminate', label: '在此终止' }
    }
    if ([
      'static_response',
      'static_ip_response',
      'static_cname_response',
      'static_txt_response',
      'allow',
      'deny',
    ].includes(action.type)) return { kind: 'terminate', label: '在此终止' }
    return { kind: 'unknown', label: '控制流未知' }
  }

  return { kind: 'continue', label: '继续后续规则' }
}

export function ruleMatchesEveryRequest(rule: RuleConfig): boolean {
  if (rule.matchers.length === 0) return true
  if (!rule.matchers.every((matcher) => matcher.operator === 'and')) return false
  if (rule.matcher_operator === 'or') return rule.matchers.some((matcher) => matcher.type === 'any')
  return rule.matcher_operator === 'and' && rule.matchers.every((matcher) => matcher.type === 'any')
}

export function findBlockingRule(pipeline: PipelineConfig, ruleIndex: number): BlockingRuleSummary | undefined {
  for (let index = 0; index < ruleIndex; index += 1) {
    const rule = pipeline.rules[index]
    if (!rule || !ruleMatchesEveryRequest(rule)) continue
    const flow = analyzeRuleFlow(rule)
    if (flow.kind === 'terminate' || flow.kind === 'jump') {
      return { index, name: rule.name || `规则 ${index + 1}` }
    }
  }
  return undefined
}
