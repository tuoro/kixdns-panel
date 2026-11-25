import { byteLength, isIp, isNet, isQclass, isQtype, isRcode, isTtl, kernelRegexCause, QCLASSES, qtypeRule, RCODES, regexCauseText, TTL_PROBLEM, TXT_SEGMENT_BYTES } from '../config-model/grammar'
import { kernelRegexChecking, type RegexKind } from '../config-model/regex-check'
import { forwardTarget, matchOperator, splitAddrs } from '../config-model/kernel'
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
  // TXT 内容「等于」空的只命中空的 TXT，内核照收；「开头是」「匹配正则」空着对每份带 TXT 的回答都成立，内核不收
  // TXT content 「等于」 empty matches only an empty TXT and the kernel takes it; 「开头是」 or 「匹配正则」 empty holds for every answer with
  // TXT, which the kernel refuses
  const emptyTxt = matcher.type === 'response_txt_content' && matcher.mode === 'exact' && typeof matcher.value === 'string'
  for (const field of ['value', 'cidr'] as const) {
    if (fields.includes(field) && !matcher[field]?.trim() && !(field === 'value' && emptyTxt)) errors[field] = required
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
    if (['qtype', 'response_type'].includes(matcher.type) && !isQtype(value)) errors.value = `KixDNS 只认 ${qtypeRule()}`
    else if (['qclass', 'response_qclass'].includes(matcher.type) && !isQclass(value)) errors.value = `KixDNS 只认 ${QCLASSES.join('、')}`
    else if (matcher.type === 'response_rcode' && !isRcode(value)) errors.value = `KixDNS 只认 ${RCODES.join('、')}，其余的响应码写 OTHER`
    // 说的是内核不收的那个原因：写法、编译后太大、TXT 太长各说各的 / The reason given is the kernel's own: the syntax, too big once compiled,
    // or a TXT regex too long, each in its own words
    else if (regex && cause) errors.value = regexCauseText(regex, cause)
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
  pipeline: requiredFieldError('要转到的组', true),
  ip: requiredFieldError('IP'),
  target: requiredFieldError('目标域名'),
}

// defaultUpstream 是写进内核的默认上游（没写时内核用 1.1.1.1:53）：没写上游的转发问它 / defaultUpstream is the default upstream as written to
// the kernel (1.1.1.1:53 when it writes none), which a forward writing no upstream asks
/**
 * 一串条件里白写的「不是」（config.rs ignored_negation）：第一个条件前面没有东西可合，它身上的「且不是 / 或不是」不把它取反；只有一个条件时，
 * 规则级的取反也只落在它身上，一样白写。内核把这两种当配置问题，不收。说的是怎么改：请求条件前面放一个「所有请求」，回答条件把动作挪到
 * 「不满足或没有回答时」
 * A negation written for nothing in a chain of conditions (config.rs ignored_negation): the first condition has nothing before it to
 * join, so its and-not or or-not does not negate it; with a single condition a chain-level negation lands on it alone, for nothing just
 * the same. The kernel takes either as a configuration problem and refuses it. What is said is how to fix it: put 所有请求 first for
 * request conditions, move the actions to 不满足或没有回答时 for answer conditions
 */
export function negationProblem(matchers: readonly MatcherConfig[], chainOperator: string, scope: MatcherScope): string | null {
  const negated = (op: string | undefined) => ['and_not', 'or_not'].includes(matchOperator(op))
  const first = matchers[0]
  if (!first) return null
  if (!negated(first.operator) && !(matchers.length === 1 && matchOperator(first.operator) === 'and' && negated(chainOperator))) return null
  return negationWords(scope === 'response')
}
/** 白写的「不是」怎么说（见 negationProblem），written 是写的那个运算符的叫法；内核报的同一件事也这样说 / How a negation written for nothing
 * is said (see negationProblem), written being what the operator written is called; the kernel's report of it reads the same */
export function negationWords(response: boolean, written = '不是'): string {
  return response
    ? `第一个回答条件前面没有东西可合，写的「${written}」不起作用，KixDNS 不收；要在它不成立时处理，把动作写到「不满足或没有回答时」`
    : `第一个条件前面没有东西可合，写的「${written}」不起作用，KixDNS 不收；要排除它，前面先加一个「所有请求」条件`
}

export function actionFieldErrors(
  action: ActionConfig,
  pipelineIds: readonly string[] = [],
  defaultUpstream = '1.1.1.1:53',
): Record<string, string> {
  const errors: Record<string, string> = {}
  const requiredFields: Record<string, 'pipeline' | 'ip' | 'target'> = {
    jump_to_pipeline: 'pipeline',
    static_ip_response: 'ip',
    static_cname_response: 'target',
  }
  const requiredField = requiredFields[action.type]
  if (requiredField && !action[requiredField]?.trim()) errors[requiredField] = ACTION_REQUIRED[requiredField]
  // TXT 至少一段，空的那段也算（[""] 内核照收，[] 不收） / TXT takes at least one segment, an empty one counting ([""] the kernel takes, [] not)
  if (action.type === 'static_txt_response' || action.type === 'replace_txt_response') {
    const values = Array.isArray(action.text) ? action.text : action.text === undefined ? [] : [action.text]
    const long = values.find((value) => byteLength(value) > TXT_SEGMENT_BYTES)
    if (!values.length) errors.text = 'TXT 至少要有一段，空的也行'
    else if (long !== undefined) errors.text = `每段 TXT 最长 ${TXT_SEGMENT_BYTES} 字节，有一段 ${byteLength(long)} 字节`
  }
  // 固定响应码照 parse_rcode 读：六个之一，大小写不论（OTHER 只在回答条件里有） / A fixed rcode read as parse_rcode does: one of the six, in
  // any case (OTHER belongs to answer conditions only)
  if (action.type === 'static_response' && (!isRcode(action.rcode ?? '') || /^other$/i.test(action.rcode ?? ''))) errors.rcode = `KixDNS 只认 ${RCODES.join('、')}`
  // 固定 IP 照内核读：逗号隔开，每一项都是 IP / Fixed IPs as the kernel reads them: comma-separated, each one an IP
  if (action.type === 'static_ip_response' && !errors.ip && !(action.ip ?? '').split(',').every((ip) => isIp(ip.trim()))) errors.ip = 'IP 写得不对，几个 IP 用逗号隔开'
  // 转发的每个上游照 upstream_problem 读，没写前缀的按这个动作的 transport（「自动识别协议」是没写，按 UDP）。上游空着就不写这个键，问默认上游，
  // 经这个动作的 transport 问：默认上游经 UDP 就用不了的设置里已经说了，这里只说经 UDP 用得了、经它用不了的（config.rs rule_problems）
  // Each upstream of a forward read as upstream_problem does, one without a prefix by this action's transport (自动识别协议 writes none, so
  // UDP). An empty upstream is not written and the default upstream is asked, over this action's transport: what makes it unusable over
  // UDP the settings already say, so only one usable over UDP yet not over this transport is said here (config.rs rule_problems)
  if (action.type === 'forward') {
    const transport = action.transport || 'udp'
    // 导入的高级规则里上游也可能写成数组、null（kernel.ts forwardTarget） / An imported advanced rule may write upstream as an array or null too
    // (kernel.ts forwardTarget)
    const written = splitAddrs(forwardTarget(action.upstream, ''))
    const asked = written.length ? written : splitAddrs(defaultUpstream).filter((u) => !upstreamProblem(u))
    const bad = asked.map((u) => [u, upstreamProblem(u, transport)] as const).find(([, p]) => p)
    if (bad) errors.upstream = `${written.length ? '上游' : '没写上游，问的是默认上游'} ${bad[0]}${bad[1]}`
  }
  if (action.type === 'static_cname_response' && !errors.target && !validDnsName(action.target ?? '')) errors.target = 'CNAME 目标域名写得不对'
  // TTL 是 u32，0 也行 / A TTL is a u32, 0 included
  if ((action.type === 'static_cname_response' || action.type === 'static_txt_response') && action.ttl !== undefined && !isTtl(action.ttl)) errors.ttl = TTL_PROBLEM
  // 转到自己所在的这一组内核照收（只记一条提醒：跳转绕了圈），这里也不拦 / A jump to its own group the kernel takes (noting only a warning
  // that the jumps go round), so it is not stopped here either
  if (action.type === 'jump_to_pipeline' && !errors.pipeline && pipelineIds.length > 0 && !pipelineIds.includes(action.pipeline ?? '')) errors.pipeline = '要转到的组不存在'
  return errors
}
