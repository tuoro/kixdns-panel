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

// 日志级别写页面上的叫法 / Log levels in the page's words
const LEVEL_NAMES: Record<string, string> = { trace: '跟踪', debug: '调试', info: '信息', warn: '警告', error: '错误' }

export function summarizeMatcher(matcher: MatcherConfig, scope: MatcherScope): string {
  const value = text(matcher.value)
  const cidr = text(matcher.cidr)
  const countries = text(matcher.country_codes)

  switch (matcher.type) {
    case 'any': return '所有请求'
    case 'listener_label': return `监听标签是 ${value}`
    case 'client_ip': return `客户端 IP 属于 ${cidr}`
    case 'domain_suffix': return `域名是 ${value}（含子域名）`
    case 'domain_regex': return `域名匹配正则 ${value}`
    case 'qclass': return `查询类别是 ${value}`
    case 'edns_present': return expectation(matcher, '请求带 EDNS', '请求不带 EDNS')
    case 'geo_site': return `域名属于 GeoSite ${geoSiteValue(matcher.value)}`
    case 'geo_site_not': return `域名不属于 GeoSite ${geoSiteValue(matcher.value)}`
    case 'geoip_country': return `客户端地区是 ${countries}`
    case 'geoip_private': return expectation(matcher, '客户端是内网', '客户端不是内网')
    case 'qtype': return `查询类型是 ${value}`
    case 'upstream_equals': return `回答来自 ${value}`
    case 'request_domain_suffix': return `请求的域名是 ${value}（含子域名）`
    case 'request_domain_regex': return `请求的域名匹配正则 ${value}`
    case 'response_type': return `回答的记录类型是 ${value}`
    case 'response_rcode': return `响应码是 ${value}`
    case 'response_qclass': return `查询类别是 ${value}`
    case 'response_edns_present': return expectation(matcher, '回答带 EDNS', '回答不带 EDNS')
    case 'response_upstream_ip': return `上游 IP 属于 ${cidr}`
    case 'response_answer_ip': return `回答的 IP 属于 ${cidr}`
    case 'response_answer_ip_geoip_country': return `回答 IP 的地区是 ${countries}`
    case 'response_answer_ip_geoip_private': return expectation(matcher, '回答的是内网地址', '回答的不是内网地址')
    case 'response_request_domain_geosite': return `请求的域名属于 GeoSite ${geoSiteValue(matcher.value)}`
    case 'response_request_domain_geosite_not': return `请求的域名不属于 GeoSite ${geoSiteValue(matcher.value)}`
    case 'response_txt_content': return `TXT 内容${matcher.mode === 'prefix' ? '开头是' : matcher.mode === 'regex' ? '匹配正则' : '等于'} ${value}`
    default: return `${scope === 'response' ? '响应条件' : '请求条件'} ${matcher.type}`
  }
}

/**
 * 同一种条件用「或」连起来时并成一句：「应答 IP 属于 A、B 或 C」，不把「应答 IP 属于」念三遍（审计 D21）。
 * 返回共同的前半句和每一项的值；认不出这个形状就返回 null。
 * Conditions of one type joined by OR read as one sentence, 「应答 IP 属于 A、B 或 C」, instead of repeating
 * 「应答 IP 属于」 three times (audit D21). Returns the shared lead and each item's value, or null when the shape differs.
 */
export function sameTypeAlternatives(matchers: MatcherConfig[], matcherOperator: string, scope: MatcherScope): { lead: string; values: string[] } | null {
  if (matchers.length < 2 || matcherOperator !== 'or') return null
  const type = matchers[0]!.type
  // 否定的类型不并：「不属于 A 或 B」读起来是两个都不属于，内核算的却是「不属于 A」或「不属于 B」
  // Negated types never merge: 「不属于 A 或 B」 reads as outside both, but the kernel evaluates (not A) or (not B)
  if (type.endsWith('_not')) return null
  if (!matchers.every((matcher) => matcher.type === type && matcher.operator === 'and')) return null
  const values = matchers.map((matcher) => text(matcher.cidr, '') || text(matcher.country_codes, '') || (type.includes('geosite') || type.startsWith('geo_site') ? geoSiteValue(matcher.value) : text(matcher.value, '')))
  if (values.some((value) => !value)) return null
  const summaries = matchers.map((matcher) => summarizeMatcher(matcher, scope))
  const lead = summaries[0]!.slice(0, summaries[0]!.length - values[0]!.length)
  if (!lead || summaries.some((summary, index) => summary !== `${lead}${values[index]}`)) return null
  return { lead, values }
}

export function summarizeMatchers(
  matchers: MatcherConfig[],
  matcherOperator: string,
  scope: MatcherScope,
): string {
  if (matchers.length === 0) return scope === 'response' ? '所有回答' : '所有请求'
  const summaries = matchers.map((matcher) => summarizeMatcher(matcher, scope))
  if (summaries.length === 1) return summaries[0]!
  const alternatives = sameTypeAlternatives(matchers, matcherOperator, scope)
  if (alternatives) return `${alternatives.lead}${alternatives.values.slice(0, -1).join('、')} 或 ${alternatives.values.at(-1)}`
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

// 传输方式按人的叫法写：tcp_udp、doh 是配置里的键值，不是给人读的。认不出的照旧转大写。
// Transports as people say them: tcp_udp and doh are config values, not words. Unknown ones are uppercased as before.
const TRANSPORT_LABELS: Record<string, string> = { udp: 'UDP', tcp: 'TCP', tcp_udp: 'TCP+UDP', doh: 'DoH', dot: 'DoT', doq: 'DoQ' }

export function transportLabel(transport: string): string {
  return TRANSPORT_LABELS[transport.toLowerCase()] ?? transport.toUpperCase()
}

export function summarizeAction(action: ActionConfig, phase: 'request' | 'response' = 'request'): string {
  switch (action.type) {
    case 'log': return `记录日志（${LEVEL_NAMES[text(action.level, 'info')] ?? text(action.level, 'info')}）`
    case 'static_response': return `返回 ${text(action.rcode)}`
    case 'static_ip_response': return `返回 IP ${text(action.ip)}`
    case 'static_cname_response': return `直接回答 CNAME ${text(action.target)}`
    case 'static_txt_response': return `返回 TXT ${text(action.text)}`
    case 'replace_txt_response': return `替换 TXT 为 ${text(action.text)}`
    // 还没选目标时写成缺什么，不占 ID 那个位置：否则读起来像跳去一个叫「未选择」的 Pipeline（审计第八轮 D1）
    // With no target yet, say what is missing instead of filling the ID slot, which read as a Pipeline named 未选择 (audit round 8, D1)
    case 'jump_to_pipeline': return action.pipeline?.trim() ? `转到 ${action.pipeline.trim()}` : '转到（还没选）'
    // 回答后的 allow 是照常返回上游的回答 / allow in the answer phase returns the upstream's answer as is
    case 'allow': return phase === 'response' ? '照常返回' : '交给默认上游'
    case 'deny': return '拦截（REFUSED）'
    case 'forward': {
      // 几个上游用顿号隔开；协议名是英文，用半角括号贴在地址后面（中文排版里英文内容用半角标点）
      // Several upstreams are separated by 、; the protocol is an English term, so it follows the address in half-width brackets
      const transport = text(action.transport, '')
      const upstreams = (typeof action.upstream === 'string' ? action.upstream.split(',') : Array.isArray(action.upstream) ? action.upstream : [])
        .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
        .map((item) => item.trim())
      return `转发给 ${upstreams.length ? upstreams.join('、') : '默认上游'}${transport ? ` (${transportLabel(transport)})` : ''}`
    }
    case 'continue': return '继续往下'
    default: return `动作 ${action.type}（面板认不出）`
  }
}

// 「然后」后面紧跟动词，中文和中文之间不空格 / 然后 is followed straight by the verb: no space between Chinese words
export function summarizeActions(actions: ActionConfig[], phase: 'request' | 'response' = 'request'): string {
  if (actions.length === 0) return '未配置动作'
  return actions.map((action) => summarizeAction(action, phase)).join('，然后')
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
