import { byteLength, isIp, isNet, isQclass, isQtype, isRcode, isTtl, kernelRegexCause, QCLASSES, QTYPES, RCODES, regexCauseText, TTL_PROBLEM, TXT_SEGMENT_BYTES } from '../config-model/grammar'
import { kernelRegexChecking, type RegexKind } from '../config-model/regex-check'
import { upstreamProblem } from '../config-model/model'
import { matcherHint } from './matcher-hints'
import { MATCHER_DEFINITIONS } from './schema'
import type { ActionConfig, MatcherConfig, MatcherScope } from './types'

// 必填的格子空着时，错误说出它叫什么，和这一行写的字段名一样：「还没填域名」「还没选 Pipeline」（审计第五轮 B3；第十三轮去掉「请」）
// An empty required field is named in its error as its row labels it: 还没填域名, 还没选 Pipeline (audit round 5, B3; round 13 dropped 请)
export function requiredFieldError(label: string, choose = false): string {
  return `${choose ? '还没选' : '还没填'}${/^[A-Za-z0-9]/.test(label) ? ' ' : ''}${label}`
}

export function isRequiredFieldError(message: string): boolean {
  return /^还没(?:填|选)/.test(message)
}

export function validDnsName(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || /\s/.test(trimmed)) return false
  const withoutRoot = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed
  if (!withoutRoot || new TextEncoder().encode(withoutRoot).length > 253) return false
  return withoutRoot.split('.').every((label) => label.length > 0 && new TextEncoder().encode(label).length <= 63)
}

// GeoSite 条件的值是分类名本身：内核把它原样当标签去查，写成 geosite:cn 永远匹配不上。
// A GeoSite condition's value is the bare category: the kernel looks it up as the tag exactly as written, so geosite:cn never matches.
const GEOSITE_MATCHERS = new Set(['geo_site', 'geo_site_not', 'response_request_domain_geo_site', 'response_request_domain_geo_site_not'])
export const GEOSITE_PREFIX_ERROR = '只写分类名，去掉 geosite: 前缀'

export function isGeoSiteMatcher(matcher: MatcherConfig): boolean {
  return GEOSITE_MATCHERS.has(matcher.type)
}

/** 这个条件的值是哪一种正则；不是正则时为 null / Which kind of regex this condition's value is; null when it is no regex */
function regexKindOf(matcher: MatcherConfig): RegexKind | null {
  if (['domain_regex', 'request_domain_regex'].includes(matcher.type)) return 'domain'
  return matcher.type === 'response_txt_content' && matcher.mode === 'regex' ? 'txt' : null
}

/**
 * 这个条件的正则还在问面板服务端，本地也没看出毛病：出错提示先停在上一次的结论上，标成在查（见 regex-check.ts）
 * This condition's regex is still being asked about and the page finds nothing wrong itself: its error stays at the last conclusion,
 * marked as checking (see regex-check.ts)
 */
export function matcherValueChecking(matcher: MatcherConfig): boolean {
  const kind = regexKindOf(matcher)
  const value = matcher.value ?? ''
  return kind !== null && Boolean(value.trim()) && kernelRegexChecking(kind, value) && kernelRegexCause(kind, value) === null
}

export function matcherFieldErrors(matcher: MatcherConfig, scope: MatcherScope): Record<string, string> {
  const errors: Record<string, string> = {}
  const fields = MATCHER_DEFINITIONS[scope].find((item) => item.value === matcher.type)?.fields ?? []
  const required = requiredFieldError(matcherHint(matcher).label, matcher.type === 'qtype')
  for (const field of ['value', 'cidr'] as const) {
    if (fields.includes(field) && !matcher[field]?.trim()) errors[field] = required
  }
  if (!errors.value && isGeoSiteMatcher(matcher) && /^geosite:/i.test(matcher.value?.trim() ?? '')) errors.value = GEOSITE_PREFIX_ERROR
  if (fields.includes('country_codes') && !matcher.country_codes?.some((code) => code.trim())) {
    errors.country_codes = required
  }
  // 内核读不进、或者会另作解释的写法当场标出来，读法和条件表单一样（config-model/grammar.ts） / What the kernel cannot read, or would read
  // some other way, is marked at once, by the same reading as the condition form (config-model/grammar.ts)
  const value = matcher.value ?? ''
  if (!errors.value && value.trim()) {
    const regex = regexKindOf(matcher)
    const cause = regex ? kernelRegexCause(regex, value) : null
    if (['qtype', 'response_type'].includes(matcher.type) && !isQtype(value)) errors.value = `KixDNS 只认 ${QTYPES.join('、')}`
    else if (['qclass', 'response_qclass'].includes(matcher.type) && !isQclass(value)) errors.value = `KixDNS 只认 ${QCLASSES.join('、')}`
    else if (matcher.type === 'response_rcode' && !isRcode(value)) errors.value = `KixDNS 只认 ${RCODES.join('、')}，其余的响应码写 OTHER`
    // 说的是内核不收的那个原因：写法、编译后太大、TXT 太长各说各的 / The reason given is the kernel's own: the syntax, too big once compiled,
    // or a TXT regex too long, each in its own words
    else if (regex && cause) errors.value = regexCauseText(cause)
  }
  // 规则和入口的 client_ip 只认一个网段；回答阶段的网段是逗号隔开的列表 / A rule's or entry's client_ip takes one network; answer-phase networks
  // are a comma-separated list
  const cidr = matcher.cidr ?? ''
  if (!errors.cidr && cidr.trim()) {
    if (matcher.type === 'client_ip' && !isNet(cidr)) errors.cidr = '只能写一个带前缀的网段，比如 192.168.1.0/24；几个网段写成几个条件'
    else if (matcher.type !== 'client_ip' && !cidr.split(',').map((c) => c.trim()).filter(Boolean).every(isNet)) errors.cidr = '网段写成 0.0.0.0/32 这样，几个用逗号隔开'
  }
  return errors
}

// 动作参数的名字和动作列表里写的一样；CNAME 的「目标」在这里说全，和域名映射页一样叫「目标域名」
// Action parameters are named as the action list labels them; the CNAME 目标 is spelled out as 目标域名, as the mapping tab calls it
const ACTION_REQUIRED = {
  upstream: requiredFieldError('上游'),
  pipeline: requiredFieldError('要转到的组', true),
  ip: requiredFieldError('IP'),
  target: requiredFieldError('目标域名'),
}

export function actionFieldErrors(
  action: ActionConfig,
  currentPipelineId: string,
  pipelineIds: readonly string[] = [],
): Record<string, string> {
  const errors: Record<string, string> = {}
  const requiredFields: Record<string, 'upstream' | 'pipeline' | 'ip' | 'target'> = {
    forward: 'upstream',
    jump_to_pipeline: 'pipeline',
    static_ip_response: 'ip',
    static_cname_response: 'target',
  }
  const requiredField = requiredFields[action.type]
  if (requiredField && !action[requiredField]?.trim()) errors[requiredField] = ACTION_REQUIRED[requiredField]
  if (action.type === 'static_txt_response' || action.type === 'replace_txt_response') {
    const values = Array.isArray(action.text) ? action.text : [action.text ?? '']
    const long = values.find((value) => byteLength(value) > TXT_SEGMENT_BYTES)
    if (!values.some((value) => value.trim())) errors.text = requiredFieldError('文本')
    else if (long !== undefined) errors.text = `每段 TXT 最长 ${TXT_SEGMENT_BYTES} 字节，有一段 ${byteLength(long)} 字节`
  }
  // 固定 IP 照内核读：逗号隔开，每一项都是 IP / Fixed IPs as the kernel reads them: comma-separated, each one an IP
  if (action.type === 'static_ip_response' && !errors.ip && !(action.ip ?? '').split(',').every((ip) => isIp(ip.trim()))) errors.ip = 'IP 写得不对，几个 IP 用逗号隔开'
  // 转发的每个上游照 upstream_problem 读，没写前缀的按这个动作的 transport / Each upstream of a forward read as upstream_problem does, one without
  // a prefix by this action's transport
  if (action.type === 'forward' && !errors.upstream && action.upstream) {
    const bad = action.upstream.split(',').map((u) => u.trim()).filter(Boolean).map((u) => [u, upstreamProblem(u, action.transport ?? 'udp')] as const).find(([, p]) => p)
    if (bad) errors.upstream = `上游 ${bad[0]}${bad[1]}`
  }
  if (action.type === 'static_cname_response') {
    if (!errors.target && !validDnsName(action.target ?? '')) errors.target = 'CNAME 目标域名写得不对'
    if (action.ttl !== undefined && !isTtl(action.ttl)) errors.ttl = TTL_PROBLEM
  }
  if (action.type === 'jump_to_pipeline' && !errors.pipeline) {
    if (action.pipeline === currentPipelineId) errors.pipeline = '不能转到自己所在的这一组'
    else if (pipelineIds.length > 0 && !pipelineIds.includes(action.pipeline ?? '')) errors.pipeline = '要转到的组不存在'
  }
  return errors
}
