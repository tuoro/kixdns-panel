import { BLOCKLIST_PIPELINE, BLOCKLIST_RULE, ownMatcher, parseOwnRules, TAG_ALLOW, TAG_ALLOW_IMPORTANT, TAG_BLOCK, TAG_BLOCK_IMPORTANT } from './blocklist'
import { toTree, treeText } from './condTree'
import {
  byteLength, cidrOf, isCidr, isCnameTarget, isDomain, isIp, isPrefix, isQclass, isQtype, isRcode, isTtl, kernelDomain, kernelRegexOk, QCLASSES, QTYPES, RCODES, TTL_PROBLEM,
  TXT_REGEX_BYTES, TXT_SEGMENT_BYTES, upstreamFault, upstreamTransport, type UpstreamFault,
} from './grammar'
export { isCidr, isDomain, isIp, kernelDomain } from './grammar'
// 配置页的数据模型：上游组配一次，规则引用组名；规则组、域名映射、默认值也在这里。compile() 把它落成内核配置，
// importer.ts 把内核配置读回来，document.ts 负责和配置文件之间的存取。
// The config page's model: upstream groups are configured once and rules reference them by name; rule groups, mappings and
// defaults live here too. compile() turns it into the kernel config, importer.ts reads one back, document.ts stores and loads it.

export type Protocol = 'auto' | 'udp' | 'tcp' | 'tcp_udp' | 'doh' | 'dot' | 'doq'
export interface UpstreamAddress { address: string; protocol: Protocol }
// null：不处理客户端子网，原样转发 / null: leave the client subnet alone
export type Ecs = null | { mode: 'clear' } | { mode: 'client'; v4: number; v6: number } | { mode: 'static'; subnet: string }
export interface UpstreamGroup {
  id: string
  // 从旧配置导入时保留原来的 Pipeline ID，缓存和引用都不变 / Kept from an imported config so the cache and references stay put
  pipelineId?: string
  name: string
  addresses: UpstreamAddress[]
  ecs: Ecs
  fallback: { group: string; onError: boolean; onPolluted: boolean }
}

export type ConditionField = 'domain' | 'geosite' | 'client_ip' | 'client_country' | 'client_private' | 'qtype' | 'qclass' | 'edns'
export interface Condition { id: number; field: ConditionField; negate: boolean; regex?: boolean; exact?: boolean; values: string[] }

export type ResponseField = 'rcode' | 'answer_ip' | 'answer_country' | 'answer_private' | 'answer_type' | 'upstream' | 'upstream_ip'
  | 'request_domain' | 'request_geosite' | 'txt' | 'qclass' | 'edns'
export interface ResponseCondition { id: number; field: ResponseField; negate: boolean; regex?: boolean; exact?: boolean; txtMode?: 'exact' | 'prefix' | 'regex'; values: string[] }

export type BlockResponse = 'default' | 'NXDOMAIN' | 'REFUSED' | 'SERVFAIL' | 'NOERROR' | 'zero'
export type Outcome =
  | { type: 'upstream'; group: string }
  | { type: 'block'; response: BlockResponse }
  // IP 可以写几个，用逗号隔开，按查询类型挑 v4 或 v6；IP 回答的 TTL 内核固定 300 秒，只有 CNAME 和 TXT 能改
  // IP takes several, comma-separated, picked by query type; the kernel fixes IP answers at TTL 300, only CNAME and TXT take one
  | { type: 'answer'; kind: 'ip' | 'cname' | 'txt'; value: string; ttl: number | null }
  | { type: 'group'; group: string }
  | { type: 'continue' }
export type Remedy = Outcome | { type: 'rewrite_txt'; value: string } | { type: 'none' }
// thenLog / otherwiseLog：处理之前顺便记一条日志（现在面板的「异常响应回退」模板就是这样） / Log before handling (today's 异常响应回退 template does this)
export interface ResponseHandling { mode: 'inherit' | 'custom' | 'off'; match: 'all' | 'any'; conditions: ResponseCondition[]; then: Remedy; otherwise: Remedy; thenLog?: LogLevel | null; otherwiseLog?: LogLevel | null }
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'
export interface Rule {
  id: number
  name: string
  note: string
  enabled: boolean
  // 外层是「或」，每组里是「且」；空着就是所有请求 / Outer list is OR, each group is AND; empty means every request
  conditions: Condition[][]
  outcome: Outcome
  log: { enabled: boolean; level: LogLevel }
  ecs: 'inherit' | Ecs
  response: ResponseHandling
  // 最近一次改动的时间（ISO），导入的写「导入」；命中数不存，由概览的统计按名字对上 / When it was last edited (ISO), 「导入」 for imported ones; hit counts are not stored, the overview's statistics match them by name
  edited: string
  // 高级规则：放不进上面这些字段的内核规则，原样保留、原样写回 / An advanced rule: kernel rules that fit none of the fields above, kept and written back verbatim
  raw?: Record<string, unknown>[]
}
// 规则组只能由「转到规则组」带进来；按监听标签直接进组的入口算高级入口（旧版模型读进来时挪过去，见 document.ts）
// A rule group is entered only through 转到规则组; an entry by listener label is an advanced entry (older models move it there on read, see document.ts)
export interface RuleGroup { id: string; name: string; note: string; rules: Rule[]; rest: Outcome; pipelineId?: string; extra?: Record<string, unknown> }
// 高级入口：域名映射和主列表以外的内核入口（监听标签、认不出的条件），原样保留 / An advanced entry: a kernel entry other than the mappings and the main list (listener labels, unrecognised conditions), kept verbatim
export interface RawEntry { pipeline: string; matchers: Record<string, unknown>[]; matcher_operator?: string }
export interface Mapping { id: number; domain: string; target: string; ttl: number | null; enabled: boolean }
export interface Defaults { block: 'NXDOMAIN' | 'REFUSED' | 'zero' }
// 拦截列表：订阅的列表（名字、链接、开关）和自己写的规则在草稿里，保存后生效；file 是面板服务端按启用的列表合成的 GeoSite
// 文件，订阅一变由页面请服务端重新合成，换上新的路径。builtFor 记着 file 是按哪组列表合成的（见 blocklistKey）：它和订阅对不上时
// 文件是旧的，页面要重新合成，保存要等它
// Blocklists: the subscribed lists (name, link, switch) and the rules of one's own live in the draft and take effect on save; file is
// the GeoSite file the panel server builds from the enabled lists, rebuilt at the page's request whenever the subscriptions change.
// builtFor records which lists file was built for (see blocklistKey): when it disagrees with the subscriptions the file is stale, the
// page builds again and a save waits for it
export interface Subscription { id: number; name: string; url: string; enabled: boolean }
export interface Blocklists { subscriptions: Subscription[]; file: string | null; custom: string; builtFor: string }
export const emptyBlocklists = (): Blocklists => ({ subscriptions: [], file: null, custom: '', builtFor: '' })
/** 合成的文件取决于哪些列表：启用的链接，不论先后 / What the merged file depends on: the enabled links, in any order */
export const blocklistKey = (b: Pick<Blocklists, 'subscriptions'>): string => b.subscriptions.filter((s) => s.enabled).map((s) => s.url).sort().join('\n')
// settings 是内核的全局设置（监听、缓存、Geo 数据……），原样写进配置；只有 default_upstream 由「其余请求」决定
// settings are the kernel's global settings (listeners, cache, Geo data…), written as they are; only default_upstream follows 其余请求
export interface Model {
  format: string
  settings: Record<string, unknown>
  groups: UpstreamGroup[]
  rules: Rule[]
  ruleGroups: RuleGroup[]
  mappings: Mapping[]
  rest: Outcome
  defaults: Defaults
  blocklists: Blocklists
  // 以下只在导入旧配置时出现：主列表原来的 Pipeline ID、高级入口、原样保留的 Pipeline、认不出的顶层键
  // Only present after importing an older config: the main list's original pipeline ID, advanced entries, pipelines kept verbatim, unknown top-level keys
  mainId?: string
  mappingId?: string
  mainExtra?: Record<string, unknown>
  entries?: RawEntry[]
  // 排在主列表入口后面、永远轮不到的入口，原样写回原位 / Entries after the main list's, which never run, written back in place
  trailingEntries?: RawEntry[]
  rawPipelines?: Record<string, unknown>[]
  extra?: Record<string, unknown>
}

export const PROTOCOL_LABEL: Record<Protocol, string> = { auto: '自动', udp: 'UDP', tcp: 'TCP', tcp_udp: 'TCP+UDP', doh: 'DoH', dot: 'DoT', doq: 'DoQ' }
export const POLLUTED_CIDRS = ['0.0.0.0/32', '240.0.0.0/4', '255.255.255.255/32']

// 地址认协议：写了前缀就按前缀，没写就是 UDP / An address's protocol: its prefix when it has one, UDP otherwise
export function detectProtocol(address: string): Exclude<Protocol, 'auto'> {
  const a = address.trim().toLowerCase()
  if (a.startsWith('https://') || a.startsWith('doh://')) return 'doh'
  if (a.startsWith('tls://') || a.startsWith('dot://')) return 'dot'
  if (a.startsWith('quic://') || a.startsWith('doq://')) return 'doq'
  if (a.startsWith('tcp+udp://') || a.startsWith('udp+tcp://')) return 'tcp_udp'
  if (a.startsWith('tcp://')) return 'tcp'
  return 'udp'
}
export function effectiveProtocol(item: UpstreamAddress): Exclude<Protocol, 'auto'> {
  return item.protocol === 'auto' ? detectProtocol(item.address) : item.protocol
}
const bare = (address: string) => address.trim().replace(/^[a-z+]+:\/\//i, '')
// 内核认的写法：协议写成地址前缀 / The kernel's form: the protocol as an address prefix
export function kernelAddress(item: UpstreamAddress): string {
  if (item.protocol === 'auto') return item.address.trim()
  const host = bare(item.address)
  const prefix: Record<Exclude<Protocol, 'auto'>, string> = { udp: 'udp://', tcp: 'tcp://', tcp_udp: 'tcp+udp://', doh: 'https://', dot: 'tls://', doq: 'quic://' }
  return `${prefix[item.protocol]}${host}`
}
/**
 * 没写端口的地址按 DNS 的 53 补上：UDP、TCP+UDP 内核只认「IP:端口」，TCP 要「主机:端口」，大家又习惯只写 223.5.5.5。上游组的抽屉按「完成」时
 * 写进草稿的就是补好的；DoH、DoT、DoQ 内核自己有缺省，不动
 * A missing port is taken as DNS's 53: for UDP and TCP+UDP the kernel takes only 「IP:port」 and TCP needs 「host:port」, while people are used
 * to writing just 223.5.5.5. The upstream group drawer writes the completed address into the draft on 完成; DoH, DoT and DoQ have the
 * kernel's own defaults and are left alone
 */
export function withDefaultPort(item: UpstreamAddress): UpstreamAddress {
  const protocol = effectiveProtocol(item)
  if (protocol !== 'udp' && protocol !== 'tcp' && protocol !== 'tcp_udp') return item
  const address = item.address.trim()
  const prefix = /^[a-z+]+:\/\//i.exec(address)?.[0] ?? ''
  const host = address.slice(prefix.length)
  // 方括号里的 IPv6 也一样：写了括号没写端口 / An IPv6 in brackets too: brackets written, the port not
  const bracketed = /^\[([^\]]+)\]$/.exec(host)?.[1]
  if (bracketed !== undefined && bracketed.includes(':') && isIp(bracketed)) return { ...item, address: `${prefix}${host}:53` }
  const bare = isIp(host) || (protocol === 'tcp' && /^[A-Za-z0-9.-]+$/.test(host))
  return bare ? { ...item, address: `${prefix}${host.includes(':') ? `[${host}]` : host}:53` } : item
}
/**
 * 一个上游地址写进内核的样子：协议写成前缀，没写端口的按 53 补上。编配置、编辑器查地址、按地址认组和对统计都用它，
 * 所以没点「完成」就保存的、以前存下来没带端口的，写出去都是内核认的那样，下次保存就好了
 * One upstream address as written to the kernel: the protocol as a prefix, a missing port taken as 53. Compiling, the editor's
 * check, matching groups by address and matching statistics all use it, so an address saved without 完成, or stored portless
 * long ago, is written as the kernel takes it and heals on the next save
 */
export const kernelUpstream = (item: UpstreamAddress): string => kernelAddress(withDefaultPort(item))
/**
 * 一串逗号隔开的上游（设置里的默认上游）逐个按 withDefaultPort 补端口，没写前缀的照 UDP 读，和内核一样；要补的那几个换掉，别的写法（空格、逗号）
 * 一个字不动。默认上游写完（离开这一格、按回车）时用它，和上游组的地址按「完成」时一样
 * A comma-separated string of upstreams (the settings' default upstream) given ports one by one by withDefaultPort, one without a prefix read
 * as UDP as the kernel does; only those needing a port change, and the rest of the writing (spaces, commas) stays exactly as it was. Used when
 * 默认上游 is written (leaving the box, pressing Enter), as an upstream group's addresses are on 完成
 */
export function withDefaultPorts(text: string): string {
  return text.split(',').map((part) => {
    const address = part.trim()
    const done = address ? withDefaultPort({ address, protocol: 'auto' }).address : address
    return done === address ? part : part.replace(address, done)
  }).join(',')
}

// ---------- 文字摘要 / summaries ----------

// 每种条件能怎么比、列表里怎么读：编辑器的下拉和列表摘要用同一份措辞
// How each condition compares and how the list reads it: the editor's menus and the list summary share these words
export interface OpDef { value: string; label: string; negate: boolean; regex?: boolean; exact?: boolean; txtMode?: 'exact' | 'prefix' | 'regex'; phrase?: string }
// merge：并进另一个字段的运算里，不单独出现在字段下拉（「客户端 IP · 是内网」） / merge: folded into another field's comparisons instead of listed on its own (客户端 IP · 是内网)
export interface FieldDef { label: string; subject?: string; merge?: string; ops: OpDef[]; values: boolean; placeholder: string; upper?: boolean; suggest?: string; valid?: (v: string, c: { regex?: boolean; exact?: boolean; txtMode?: string }) => boolean;
  // 值写错时说清是哪种错，没有就用笼统的那句 / Says which mistake the values make; without it the general line is used
  explain?: (c: { regex?: boolean; exact?: boolean; values: string[] }) => string | null; hint?: string }
const IS: OpDef[] = [{ value: 'is', label: '是', negate: false }, { value: 'not', label: '不是', negate: true }]
const IN: OpDef[] = [{ value: 'is', label: '在', negate: false }, { value: 'not', label: '不在', negate: true }]
// 「属于」是这个名字和它下面的所有子域名，「就是」只算这个名字本身 / 「属于」 is the name and every subdomain under it, 「就是」 the name itself only
const DOMAIN_OPS: OpDef[] = [
  { value: 'is', label: '属于', negate: false }, { value: 'not', label: '不属于', negate: true },
  { value: 'exact', label: '就是', negate: false, exact: true }, { value: 'nexact', label: '不是', negate: true, exact: true },
  { value: 're', label: '匹配正则', negate: false, regex: true }, { value: 'nre', label: '不匹配正则', negate: true, regex: true },
]
// 「就是」配 *. 自相矛盾：通配符说的是子域名 / 「就是」 with *. contradicts itself: the wildcard speaks of subdomains
const domainValid = (v: string, c: { regex?: boolean; exact?: boolean }) => (c.regex ? kernelRegexOk('domain', v) : isDomain(v) && !(c.exact && v.startsWith('*.')))
// 内核按写的原样查分类，「geosite:cn」找不到 cn 这个分类，永远不命中 / The kernel looks the category up as written, so 「geosite:cn」 never finds cn and never matches
const noGeositePrefix = (v: string): boolean => !/^geosite:/i.test(v)
// 记录类型、类别、响应码内核只认那几个：标红的同时说出能用哪些（HTTPS 这样的真类型标红了不说，看着像面板错了）
// Record types, classes and rcodes are a fixed few for the kernel: a value marked red comes with the ones that can be used (HTTPS marked red
// without a word looks like the panel's mistake)
const onlyThese = (label: string, ok: (v: string) => boolean, these: string) => (c: { values: string[] }): string | null =>
  (c.values.every(ok) ? null : `「${label}」里标红的 KixDNS 不认，能用的是 ${these}`)
const TYPES_TEXT = QTYPES.join('、')
const CLASSES_TEXT = QCLASSES.join('、')
export const FIELD: Record<ConditionField, FieldDef> = {
  domain: { label: '域名', ops: DOMAIN_OPS, values: true, placeholder: 'example.com，回车添加', valid: domainValid, explain: (c) => exactWildcardProblem(c) },
  // 行里叫 GeoSite（正式面板一直这么叫），句子里说「域名属于 GeoSite cn」 / The row says GeoSite (the production panel's name); sentences say 「域名属于 GeoSite cn」
  geosite: { label: 'GeoSite', subject: '域名', ops: [{ value: 'is', label: '属于', phrase: '属于 GeoSite', negate: false }, { value: 'not', label: '不属于', phrase: '不属于 GeoSite', negate: true }], values: true, placeholder: '搜索分类，如 cn、google', suggest: 'geosite', valid: noGeositePrefix },
  client_ip: { label: '客户端 IP', ops: IN, values: true, placeholder: '192.168.1.0/24 或单个 IP', valid: (v) => isCidr(v) },
  client_country: { label: '客户端地区', ops: IS, values: true, placeholder: 'CN、HK…', upper: true, suggest: 'country', valid: (v) => /^[a-z]{2}$|^[a-z0-9_-]{3,}$/i.test(v), hint: 'GeoIP 国家代码' },
  client_private: { label: '客户端网络', merge: 'client_ip', ops: [{ value: 'is', label: '是内网', phrase: '客户端是内网', negate: false }, { value: 'not', label: '不是内网', phrase: '客户端不是内网', negate: true }], values: false, placeholder: '' },
  // 记录类型是助记词，和响应码一样用正文字体 / Record types are mnemonics, in the body face like response codes
  qtype: { label: '查询类型', ops: IS, values: true, placeholder: 'A、AAAA、PTR…', upper: true, suggest: 'qtype', valid: isQtype, explain: onlyThese('查询类型', isQtype, TYPES_TEXT) },
  qclass: { label: '查询类别', ops: IS, values: true, placeholder: 'IN、CH、HS', upper: true, suggest: 'qclass', valid: isQclass, explain: onlyThese('查询类别', isQclass, CLASSES_TEXT) },
  edns: { label: 'EDNS', ops: [{ value: 'is', label: '带', phrase: '带 EDNS', negate: false }, { value: 'not', label: '不带', phrase: '不带 EDNS', negate: true }], values: false, placeholder: '' },
}
export const RESPONSE_FIELD: Record<ResponseField, FieldDef> = {
  // 响应码是助记词，正文字体（同诊断页、概览） / Response codes are mnemonics in the body face (as on diagnostics and the overview)
  // 认不出的响应码内核不报错，悄悄当成「这六个以外的任何响应码」：这里只收那六个和明写的 OTHER / The kernel takes an unknown rcode without a word
  // and quietly reads it as 「any code but the six」: only the six and an explicit OTHER are taken here
  rcode: { label: '响应码', ops: IS, values: true, placeholder: 'SERVFAIL、NXDOMAIN…', upper: true, suggest: 'rcode', valid: isRcode, explain: onlyThese('响应码', isRcode, `${RCODES.join('、')}，其余的响应码写 OTHER`) },
  answer_ip: { label: '回答的 IP', ops: IN, values: true, placeholder: '0.0.0.0/32、240.0.0.0/4…', valid: (v) => isCidr(v) },
  answer_country: { label: '回答 IP 的地区', ops: IS, values: true, placeholder: 'CN、US…', upper: true, suggest: 'country' },
  answer_private: { label: '回答 IP 的网络', merge: 'answer_ip', ops: [{ value: 'is', label: '是内网', phrase: '回答的是内网地址', negate: false }, { value: 'not', label: '不是内网', phrase: '回答的不是内网地址', negate: true }], values: false, placeholder: '' },
  answer_type: { label: '回答的记录类型', ops: IS, values: true, placeholder: 'A、AAAA、CNAME…', upper: true, suggest: 'qtype', valid: isQtype, explain: onlyThese('回答的记录类型', isQtype, TYPES_TEXT) },
  upstream: { label: '回答来自', ops: IS, values: true, placeholder: '10.0.0.53:53' },
  upstream_ip: { label: '上游 IP', ops: IN, values: true, placeholder: '10.0.0.0/8', valid: (v) => isCidr(v) },
  request_domain: { label: '请求的域名', ops: DOMAIN_OPS, values: true, placeholder: 'example.com', valid: domainValid, explain: (c) => exactWildcardProblem(c) },
  request_geosite: { label: '请求域名 GeoSite', subject: '请求的域名', ops: [{ value: 'is', label: '属于', phrase: '属于 GeoSite', negate: false }, { value: 'not', label: '不属于', phrase: '不属于 GeoSite', negate: true }], values: true, placeholder: '搜索分类，如 cn', suggest: 'geosite', valid: noGeositePrefix },
  txt: { label: 'TXT 内容', ops: [
    { value: 'is', label: '等于', negate: false, txtMode: 'exact' }, { value: 'not', label: '不等于', negate: true, txtMode: 'exact' },
    { value: 'prefix', label: '开头是', negate: false, txtMode: 'prefix' }, { value: 'nprefix', label: '开头不是', negate: true, txtMode: 'prefix' },
    { value: 're', label: '匹配正则', negate: false, txtMode: 'regex' }, { value: 'nre', label: '不匹配正则', negate: true, txtMode: 'regex' },
  ], values: true, placeholder: 'v=spf1，回车添加', valid: (v, c) => (c.txtMode === 'regex' ? byteLength(v) <= TXT_REGEX_BYTES && kernelRegexOk('txt', v) : true) },
  qclass: { label: '查询类别', ops: IS, values: true, placeholder: 'IN', upper: true, suggest: 'qclass', valid: isQclass, explain: onlyThese('查询类别', isQclass, CLASSES_TEXT) },
  edns: { label: '回答的 EDNS', ops: [{ value: 'is', label: '带', phrase: '回答带 EDNS', negate: false }, { value: 'not', label: '不带', phrase: '回答不带 EDNS', negate: true }], values: false, placeholder: '' },
}
export function opOf(def: FieldDef, c: { negate: boolean; regex?: boolean; exact?: boolean; txtMode?: string }): OpDef {
  return def.ops.find((o) => o.negate === c.negate && Boolean(o.regex) === Boolean(c.regex) && Boolean(o.exact) === Boolean(c.exact) && (o.txtMode ?? undefined) === (c.txtMode ?? undefined))
    ?? def.ops.find((o) => o.negate === c.negate) ?? def.ops[0]!
}

// 值多了列表里只写前两个；full 时全写（「改了哪些」用：改的可能正是后面那几个） / Many values show the first two in lists; full writes them all (for the
// review: the change may be in the later ones)
function joinValues(values: string[], full = false): string {
  if (full || values.length <= 3) return values.join('、')
  return `${values.slice(0, 2).join('、')} 等 ${values.length} 个`
}
function phrase(def: FieldDef, c: { negate: boolean; regex?: boolean; exact?: boolean; txtMode?: string; values: string[] }, full = false): string {
  const op = opOf(def, c)
  if (!def.values) return op.phrase ?? `${def.label}${op.label}`
  const subject = def.subject ?? def.label
  return `${subject}${/[A-Za-z0-9]$/.test(subject) ? ' ' : ''}${op.phrase ?? op.label} ${joinValues(c.values, full) || '…'}`
}
export const conditionText = (c: Condition) => phrase(FIELD[c.field], c)
export const responseConditionText = (c: ResponseCondition) => phrase(RESPONSE_FIELD[c.field], c)
// full：每个值都写出来（「改了哪些」用） / full: every value written out (for the review)
interface TextOptions { full?: boolean }
// 列表、对比和右栏都按编辑时的结构说：先读成「全部 / 任一 + 条件组」，组里的条件放进括号，不展开成重复的几段
// Lists, diffs and the rail all speak in the edited structure: read back as 「all / any plus groups」, a group's conditions in parentheses rather than expanded into repeated clauses
export function conditionsText(groups: Condition[][], o?: TextOptions): string {
  return treeText(toTree(groups, () => 0), (c) => phrase(FIELD[c.field], c, o?.full))
}

// 内核原样的条件链读成一句话（高级规则和高级入口用） / A verbatim kernel chain read as a sentence (for advanced rules and entries)
const RAW_LABEL: Record<string, string> = {
  any: '所有请求', listener_label: '监听标签是', client_ip: '客户端 IP 在', domain_suffix: '域名属于', domain_exact: '域名就是', domain_regex: '域名匹配正则', geo_site: '域名属于 GeoSite', geo_site_not: '域名不属于 GeoSite',
  geoip_country: '客户端地区是', geoip_private: '客户端内网', qtype: '查询类型是', qclass: '查询类别是', edns_present: '带 EDNS',
}
export function rawMatchersText(matchers: Record<string, unknown>[] | undefined, ruleOp?: string): string {
  if (!matchers?.length) return '所有请求'
  const own = matchers.map((m) => String(m.operator ?? 'and'))
  const ops = own.every((o) => o === 'and') && ruleOp && ruleOp !== 'and' ? own.map(() => ruleOp) : own
  const one = (m: Record<string, unknown>) => {
    const label = RAW_LABEL[String(m.type)] ?? String(m.type)
    const v = m.value ?? m.cidr ?? m.country_codes ?? (m.expect === undefined ? '' : m.expect ? '' : '（否）')
    return `${label}${v === '' ? '' : ` ${Array.isArray(v) ? v.join('、') : String(v)}`}`
  }
  const join: Record<string, string> = { and: ' 且 ', or: ' 或 ', and_not: ' 且不是 ', not: ' 且不是 ', or_not: ' 或不是 ' }
  return matchers.map((m, i) => (i === 0 ? one(m) : `${join[ops[i]!] ?? ' 且 '}${one(m)}`)).join('')
}

export function groupName(model: Model, id: string): string | null {
  return model.groups.find((g) => g.id === id)?.name ?? null
}
export function ruleGroupName(model: Model, id: string): string | null {
  return model.ruleGroups.find((g) => g.id === id)?.name ?? null
}
export function blockLabel(model: Model, response: BlockResponse): string {
  const r = response === 'default' ? model.defaults.block : response
  return r === 'zero' ? '0.0.0.0 / ::' : r === 'NOERROR' ? '空回答' : r
}
// 列表里那颗结果胶囊：动词 + 客户端实际收到什么 / The outcome pill in the list: the verb plus what the client actually gets
export function outcomePill(model: Model, o: Outcome): { verb: string; value: string; broken: boolean } {
  switch (o.type) {
    case 'upstream': { const n = groupName(model, o.group); return { verb: '交给', value: n ?? '已删除的组', broken: !n } }
    case 'block': return { verb: '拦截', value: blockLabel(model, o.response), broken: false }
    case 'answer': {
      const kind = o.kind === 'ip' ? '' : o.kind === 'cname' ? 'CNAME ' : 'TXT '
      return { verb: '回答', value: `${kind}${o.kind === 'txt' ? `"${o.value}"` : o.value.split(',').map((x) => x.trim()).filter(Boolean).join(', ') || '…'}`, broken: !o.value.trim() }
    }
    case 'group': { const n = ruleGroupName(model, o.group); return { verb: '转到规则组', value: n ?? '已删除的规则组', broken: !n } }
    case 'continue': return { verb: '继续', value: '往下一条', broken: false }
  }
}
// TXT、CNAME 回答写了 TTL 就说出来：它和回答的内容一样写进配置（IP 回答的 TTL 内核固定 300 秒，不写）
// A TXT or CNAME answer says its TTL when one is set: it is written to the config as the content is (an IP answer's TTL is fixed at 300 and never written)
const ttlText = (ttl: number | null) => (ttl === null ? '' : `，TTL ${ttl} 秒`)
export function outcomeSentence(model: Model, o: Outcome): string {
  switch (o.type) {
    case 'upstream': return `交给「${groupName(model, o.group) ?? '已删除的组'}」解析`
    case 'block': return `拦截，回应 ${blockLabel(model, o.response)}`
    case 'answer': return o.kind === 'txt' ? `直接回答 TXT「${o.value}」${ttlText(o.ttl)}` : o.kind === 'ip' ? `直接回答 ${splitList(o.value).join('、')}` : `直接回答 CNAME ${o.value}${ttlText(o.ttl)}`
    case 'group': return `转到规则组「${ruleGroupName(model, o.group) ?? '已删除'}」`
    case 'continue': return '不作决定，继续往下一条'
  }
}
export function remedySentence(model: Model, r: Remedy): string {
  if (r.type === 'none') return '照常返回'
  if (r.type === 'rewrite_txt') return `把 TXT 改成「${r.value}」`
  if (r.type === 'upstream') return `改问「${groupName(model, r.group) ?? '已删除的组'}」`
  return outcomeSentence(model, r)
}
// 「…时」：前面是字母或数字时隔一个空格（「不是 CN 时」） / 「…时」 with a space after a Latin letter or digit (「不是 CN 时」)
export const withShi = (text: string) => `${text}${/[A-Za-z0-9]$/.test(text) ? ' ' : ''}时`
export function fallbackSentence(model: Model, g: UpstreamGroup): string | null {
  if (!g.fallback.group || (!g.fallback.onError && !g.fallback.onPolluted)) return null
  const when = [g.fallback.onPolluted ? '结果被污染' : '', g.fallback.onError ? '上游回 SERVFAIL 或 REFUSED' : ''].filter(Boolean).join('、')
  return `${withShi(when)}改问「${groupName(model, g.fallback.group) ?? '已删除的组'}」`
}
export function ecsText(ecs: Ecs): string {
  if (!ecs) return '不处理客户端子网'
  if (ecs.mode === 'clear') return '不发送客户端子网'
  if (ecs.mode === 'client') return `发送客户端子网（IPv4/${ecs.v4}，IPv6/${ecs.v6}）`
  return `固定发送 ${ecs.subnet || '…'}`
}
// 日志级别写页面上的叫法 / Log levels in the page's words
export const LOG_LEVEL_NAME: Record<LogLevel, string> = { trace: '跟踪', debug: '调试', info: '信息', warn: '警告', error: '错误' }
/**
 * 回答后检查读成一句话：满足时怎么做、同时记的日志，否则怎么做、同时记的日志。规则编辑的右栏和「改了哪些」共用；full 时每个值都写出来（「改了哪些」用）
 * The answer check as one sentence: what happens when it holds and the log written alongside, then otherwise and its log. Shared by the rule
 * editor's reading and the review; with full every value is written out (for the review)
 */
export function checkSentence(model: Model, r: ResponseHandling, o?: TextOptions): string {
  const logged = (level: LogLevel | null | undefined) => (level ? `，同时记一条${LOG_LEVEL_NAME[level] ?? level}日志` : '')
  const when = r.conditions.map((c) => phrase(RESPONSE_FIELD[c.field], c, o?.full)).join(r.match === 'all' ? ' 且 ' : '，或 ')
  const otherwise = r.otherwise.type === 'none' && !r.otherwiseLog ? '' : `，否则${remedySentence(model, r.otherwise)}${logged(r.otherwiseLog)}`
  return `${withShi(when)}${remedySentence(model, r.then)}${logged(r.thenLog)}${otherwise}`
}

// ---------- 校验 / validation ----------

export const splitList = (v: string) => v.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
// 「属于」本身就含子域名，*. 写不写一样 / 「属于」 already covers subdomains, so *. changes nothing
export const withoutWildcard = (v: string) => v.replace(/^\*\./, '')

// 域名「就是」写了 *.：通配符说的是子域名，和「就是」矛盾，直接说怎么改 / 域名 就是 with *.: a wildcard speaks of subdomains, which 就是 excludes, so say how to fix it
export const exactWildcardProblem = (c: { regex?: boolean; exact?: boolean; values: string[] }): string | null =>
  !c.regex && c.exact && c.values.some((v) => v.startsWith('*.')) ? '「就是」只算这个名字本身，*. 要改用「属于」' : null
// 写进内核的那几个值：去掉两头空白，空的不算（编配置时也这样，见 eachValue） / The values written to the kernel: trimmed, blanks
// dropped (as compiling does, see eachValue)
const filledValues = (values: string[]): string[] => values.map((x) => x.trim()).filter(Boolean)
export function valueProblem(def: FieldDef, c: { values: string[]; regex?: boolean; exact?: boolean; txtMode?: string }): string | null {
  if (!def.values) return null
  // 查的就是写进内核的那几个：只有空白的值编出来什么都没有，「全部满足」时成了所有回答都算 / What is checked is what is written: a value of
  // blanks compiles to nothing, which under 「全部满足」 made every answer count
  const filled = { ...c, values: filledValues(c.values) }
  if (!filled.values.length) return `「${def.label}」还没填值`
  const why = def.explain?.(filled)
  if (why) return why
  if (def.valid && !filled.values.every((v) => def.valid!(v, filled))) return `「${def.label}」里有写错的值（标红的那个）`
  return null
}
export const conditionProblem = (c: Condition) => valueProblem(FIELD[c.field], c)

const txtProblem = (text: string): string | null => {
  const bytes = byteLength(text)
  return bytes > TXT_SEGMENT_BYTES ? `TXT 内容最长 ${TXT_SEGMENT_BYTES} 字节，现在 ${bytes} 字节` : null
}
/**
 * 一个结果要填的东西写没写对：规则的结果、回答后检查的「然后」「否则」都用它。OutcomeParams 当场标出来，ruleProblems 保存前拦下；
 * 选的组没了也算，转到不存在的 Pipeline 内核整份配置都不收
 * Whether what an outcome needs is filled in right: used for a rule's outcome and the answer check's then and otherwise. OutcomeParams marks it
 * on the spot and ruleProblems stops the save; a chosen group that is gone counts too, since the kernel refuses a jump to a missing pipeline
 */
export function outcomeProblem(model: Model, o: Outcome | Remedy): string | null {
  if (o.type === 'upstream' && !groupName(model, o.group)) return '选的上游组已经删掉了'
  if (o.type === 'group' && !ruleGroupName(model, o.group)) return '选的规则组已经删掉了'
  if (o.type === 'rewrite_txt') return txtProblem(o.value)
  if (o.type !== 'answer') return null
  if (!o.value.trim()) return '自定义回答还没填内容'
  if (o.kind === 'ip' && !splitList(o.value).every(isIp)) return '回答的 IP 写得不对，几个 IP 用逗号隔开'
  if (o.kind === 'cname' && !isCnameTarget(o.value.trim())) return '回答的域名写得不对'
  if (o.kind === 'txt' && txtProblem(o.value)) return txtProblem(o.value)
  // IP 回答不写 TTL（内核固定 300 秒） / An IP answer writes no TTL (the kernel fixes it at 300)
  if (o.kind !== 'ip' && o.ttl !== null && !isTtl(o.ttl)) return TTL_PROBLEM
  return null
}
/**
 * 客户端子网写没写对：固定子网写成「IP/前缀」，前缀不超过地址的位数；发送客户端子网的两个前缀也一样（框空着时是空字符串）。
 * 内核读得进 255 以内的前缀，超过位数的悄悄截掉，所以这里按位数拦
 * Whether a client subnet is written right: a fixed subnet as 「IP/prefix」 with the prefix within the address's bits; the two prefixes of
 * 发送客户端子网 likewise (an empty box is an empty string). The kernel reads any prefix up to 255 and quietly cuts one beyond the bits,
 * so the bits are the limit here
 */
export function ecsProblem(ecs: Ecs | 'inherit'): string | null {
  if (!ecs || ecs === 'inherit' || ecs.mode === 'clear') return null
  if (ecs.mode === 'static') {
    const [ip = '', prefix = '', ...rest] = ecs.subnet.trim().split('/')
    return isIp(ip) && !rest.length && /^\d{1,3}$/.test(prefix) && isPrefix(Number(prefix), ip.includes(':') ? 128 : 32) ? null : '固定子网写成 203.0.113.0/24 这样'
  }
  return isPrefix(ecs.v4, 32) && isPrefix(ecs.v6, 128) ? null : '子网前缀：IPv4 填 0 到 32，IPv6 填 0 到 128'
}
// 上游地址哪里不对，接在「第 N 个地址」后面说 / What is wrong with an upstream address, said after 「第 N 个地址」
const ADDRESS_FAULT: Record<UpstreamFault, (protocol: string) => string> = {
  prefix: () => '的前缀认不出：DoH 写 https://，DoT 写 tls://，DoQ 写 quic://，TCP 写 tcp://',
  'ip-port': (p) => `：${p} 只能写 IP 和端口，比如 223.5.5.5:53；域名要用 TCP、DoH、DoT 或 DoQ`,
  port: () => '的端口要在 1 到 65535 之间',
  'host-port': () => '：TCP 写成 主机:端口，比如 dns.example:53',
  host: () => '：主机名只能有字母、数字、点和横线',
  url: (p) => `不是 KixDNS 读得懂的 ${p} 地址`,
  path: (p) => `：${p} 的地址不能带路径`,
  'server-name': () => '的服务器名写得不对',
  sni: () => '：DoQ 用 IP 时要写 ?sni=服务器名，比如 quic://223.5.5.5?sni=dns.alidns.com',
}
/** 一个上游（写进内核的样子）内核用不用得了，用得了为 null；说法接在地址后面（「第 2 个地址的端口要在…」「上游 x：UDP 只能…」）。
 * transport 是没写前缀时的传输（高级规则里转发动作的 transport） / Whether the kernel can use one upstream as written to the kernel, null when it
 * can; the words follow the address (「第 2 个地址的端口要在…」, 「上游 x：UDP 只能…」). transport is the one used without a prefix (a forward
 * action's transport in an advanced rule) */
export function upstreamProblem(upstream: string, transport = 'udp'): string | null {
  const fault = upstreamFault(upstream, transport)
  const kind = upstreamTransport(upstream, transport)
  return fault ? ADDRESS_FAULT[fault](PROTOCOL_LABEL[kind as Protocol] ?? kind) : null
}
/** 上游组里一个地址内核用不用得了：查的就是写进内核的那样（kernelUpstream） / Whether the kernel can use one address of a group: what is checked is what is written to the kernel (kernelUpstream) */
export const addressProblem = (item: UpstreamAddress): string | null => upstreamProblem(kernelUpstream(item))
/**
 * 一串逗号隔开的上游（设置里的默认上游）内核用不用得了：每一个照 UDP 读，一个都没有也不收（config.rs problems）。说法和上游组的地址一样，
 * 用得了为 null
 * Whether the kernel can use a comma-separated string of upstreams (the settings' default upstream): each read as UDP, and none at all
 * refused too (config.rs problems). Worded as an upstream group's addresses; null when it can
 */
export function upstreamListProblem(text: string): string | null {
  const list = text.split(',').map((u) => u.trim()).filter(Boolean)
  if (!list.length) return '至少填一个地址'
  for (const [i, u] of list.entries()) { const p = upstreamProblem(u); if (p) return `第 ${i + 1} 个地址${p}` }
  return null
}
// 规则可以不起名字（同 Surge：一条规则就是条件和去向）；没有名字时用条件当标题
// A rule may go unnamed (as in Surge, a rule is its condition and its target); without a name its condition is the title
export function ruleTitle(rule: Rule): string {
  const name = rule.name.trim()
  if (name) return name
  if (rule.raw) return '没有名字的高级规则'
  return conditionsText(rule.conditions)
}

// 新规则的空壳：没有条件、不检查回答；编号由调用方给（模型里现有编号之后） / A blank rule: no conditions, no answer check; the id comes from the caller (after the model's existing ones)
export const inheritResponse = (): ResponseHandling => ({ mode: 'inherit', match: 'any', conditions: [], then: { type: 'none' }, otherwise: { type: 'none' } })
export function newRule(id: number, outcome: Outcome): Rule {
  return { id, name: '', note: '', enabled: true, conditions: [[]], outcome, log: { enabled: false, level: 'info' }, ecs: 'inherit', response: inheritResponse(), edited: new Date().toISOString() }
}
// 模型里下一个没用过的编号：规则、条件、映射共用一个号段 / The next unused id in a model: rules, conditions and mappings share one sequence
export function nextId(model: Model): number {
  const ids: number[] = []
  const walk = (rules: Rule[]) => { for (const r of rules) { ids.push(r.id); for (const g of r.conditions) for (const c of g) ids.push(c.id); for (const c of r.response.conditions) ids.push(c.id) } }
  walk(model.rules)
  for (const rg of model.ruleGroups) walk(rg.rules)
  for (const x of model.mappings) ids.push(x.id)
  for (const x of model.blocklists.subscriptions) ids.push(x.id)
  return Math.max(0, ...ids) + 1
}

/**
 * 回答条件的「全部 / 任一」放得下这些条件吗：内核在这里只认一层，「全部满足」只能有一个条件拆成几个匹配器，「满足任一」的「不是」只能各一个值。
 * 编辑器（ruleProblems）和导入（importer.ts responseOf）用同一句判断，导入读出来的总是编辑器认的
 * Whether the answer check's all / any can hold these conditions: the kernel reads a single level here, so 「全部满足」 takes one condition
 * spread over several matchers and 「满足任一」 one value per 不是. The editor (ruleProblems) and the import (importer.ts responseOf) share
 * this test, so what an import reads is always what the editor accepts
 */
export function responseShapeProblem(r: Pick<ResponseHandling, 'match' | 'conditions'>): string | null {
  const terms = r.conditions.flatMap(responseTerms)
  if (r.match === 'all' && terms.filter((t) => !t.negative && t.any.length > 1).length > 1) return '「全部满足」时只能有一个条件填多个值，其余的拆成单独的条件或改成「满足任一」'
  if (r.match === 'any' && terms.filter((t) => t.negative).length > r.conditions.filter((c) => c.negate && filledValues(c.values).length).length) return '「满足任一」时，「不是」的条件只能填一个值，几个值拆成几条'
  return null
}
type AnyCondition = Condition | ResponseCondition
/**
 * 一组「且」起来的条件里，同一种比法既是又不是同一个值：内核里这个值的那一支永远不成立，导入时被去掉（整组都是它时整条读成高级规则）。
 * 比的是写进内核的匹配器，和导入的认法一样；不同的比法（属于和就是）不算
 * Within one AND group, one comparison both holds and is negated for one value: the kernel's branch for that value never holds and the
 * import drops it (a whole group of it reads back as an advanced rule). The matchers written to the kernel are compared, as the import
 * compares them; different comparisons (属于 and 就是) do not count
 */
function contradiction(group: AnyCondition[], fields: Record<string, FieldDef>, terms: (c: AnyCondition) => Term[]): string | null {
  const kind = (c: AnyCondition) => `${c.field}|${Boolean(c.regex)}|${Boolean(c.exact)}|${'txtMode' in c ? c.txtMode ?? '' : ''}`
  // 每个值写成的匹配器，按「是」写；几个值合成一个匹配器的（地区、网段列表）整个算一个 / The matcher each value is written as, taken as 是;
  // fields whose values make one matcher (regions, network lists) count as one
  const matchers = (c: AnyCondition): { key: string; value: string }[] => {
    const values = filledValues(c.values)
    const any = terms({ ...c, negate: false } as AnyCondition).flatMap((t) => t.any)
    return any.map((m, i) => ({ key: JSON.stringify(m), value: any.length === values.length ? values[i]! : values.join('、') }))
  }
  for (const yes of group.filter((c) => !c.negate)) {
    for (const no of group.filter((c) => c.negate && kind(c) === kind(yes))) {
      const def = fields[yes.field]!
      const said = `同一组里「${def.label}」既${opOf(def, yes).label}又${opOf(def, no).label}`
      if (!def.values) return `${said}，去掉其中一个`
      const negated = new Set(matchers(no).map((m) => m.key))
      const shared = matchers(yes).find((m) => negated.has(m.key))
      if (shared) return `${said} ${shared.value}，去掉其中一个`
    }
  }
  return null
}

/**
 * 一处要改的在规则编辑里的哪儿：条件、结果、客户端子网、回答后检查的条件、「然后」「否则」。手机上后四样各在一个弹层里，编辑器按它标出那一行、
 * 找第一处时先打开那个弹层
 * Where in the rule editor a mistake sits: the conditions, the outcome, the client subnet, the answer check's conditions, 然后, 否则. On a
 * phone the last four each live in a sheet, so the editor marks that row and opens the sheet before finding the first mistake
 */
export type ProblemPlace = 'conditions' | 'outcome' | 'ecs' | 'after' | 'then' | 'otherwise'
export function ruleProblemPlaces(model: Model, rule: Rule): { place: ProblemPlace; text: string }[] {
  const out: { place: ProblemPlace; text: string }[] = []
  const at = (place: ProblemPlace, text: string | null) => { if (text) out.push({ place, text }) }
  if (rule.raw) return []
  for (const group of rule.conditions) {
    for (const c of group) at('conditions', conditionProblem(c))
    at('conditions', contradiction(group, FIELD, (c) => requestTerms(c as Condition)))
  }
  at('outcome', outcomeProblem(model, rule.outcome))
  // 客户端子网和回答后检查只在交给上游组时写进配置 / Client subnet and the answer check are written only when the rule hands off to an upstream group
  if (rule.outcome.type === 'upstream') at('ecs', ecsProblem(rule.ecs))
  if (rule.outcome.type === 'upstream' && rule.response.mode === 'custom') {
    const r = rule.response
    if (!r.conditions.length) at('after', '「回答后检查」还没加条件')
    for (const c of r.conditions) at('after', valueProblem(RESPONSE_FIELD[c.field], c))
    at('after', responseShapeProblem(r))
    // 「满足任一」里既是又不是：总有一个成立，不矛盾 / Under 「满足任一」 is and is-not: one of them always holds, no contradiction
    if (r.match === 'all') at('after', contradiction(r.conditions, RESPONSE_FIELD, (c) => responseTerms(c as ResponseCondition)))
    // 没有条件时「然后」「否则」都不写进配置 / Without conditions neither then nor otherwise is written
    if (r.conditions.length) {
      const then = outcomeProblem(model, r.then)
      at('then', then && `「回答后检查」的「然后」：${then}`)
      const otherwise = outcomeProblem(model, r.otherwise)
      at('otherwise', otherwise && `「回答后检查」的「否则」：${otherwise}`)
    }
  }
  if (kernelRuleCount(rule) > 32) at('conditions', '条件组合太多（展开后超过 32 条），把多值条件合并成一个')
  return out
}
export const ruleProblems = (model: Model, rule: Rule): string[] => ruleProblemPlaces(model, rule).map((p) => p.text)

// ---------- 落成内核配置 / compile ----------

type KMatcher = Record<string, unknown> & { type: string; operator?: string }
interface KRule { name: string; matchers: KMatcher[]; matcher_operator: string; actions: Record<string, unknown>[]; response_matchers: KMatcher[]; response_matcher_operator: string; response_actions_on_match: Record<string, unknown>[]; response_actions_on_miss: Record<string, unknown>[] }
interface KPipeline { id: string; ecs?: Record<string, unknown>; rules: KRule[] }
export interface KernelConfig { [key: string]: unknown; version: string; settings: Record<string, unknown>; pipeline_select: { pipeline: string; matcher_operator: string; matchers: KMatcher[] }[]; pipelines: KPipeline[] }

// 一个条件落成的「项」：单个匹配器，或几个只要中一个的匹配器 / A condition becomes a term: one matcher, or several of which any may match
interface Term { negative: boolean; any: KMatcher[] }
// 一个值一个匹配器的条件：「是」几个值里中一个就算，落成一项；「不是」每个值一项否定（几个都不是） / A condition with one matcher per value:
// 是 holds when one of the values does, so it is one term; 不是 is a negated term per value (none of them)
const eachValue = (c: { negate: boolean; values: string[] }, make: (x: string) => KMatcher): Term[] => {
  const v = c.values.map((x) => x.trim()).filter(Boolean)
  return c.negate ? v.map((x) => ({ negative: true, any: [make(x)] })) : [{ negative: false, any: v.map(make) }]
}
function requestTerms(c: Condition): Term[] {
  const v = c.values.map((x) => x.trim()).filter(Boolean)
  switch (c.field) {
    // 中文这样的域名写成 punycode（kernelDomain），正则原样 / Names such as Chinese ones go as punycode (kernelDomain), regexes as written
    case 'domain': return eachValue(c, (x) => (c.regex ? { type: 'domain_regex', value: x } : c.exact ? { type: 'domain_exact', value: kernelDomain(x) } : { type: 'domain_suffix', value: kernelDomain(withoutWildcard(x)) }))
    case 'geosite': return eachValue(c, (x) => ({ type: 'geo_site', value: x }))
    // client_ip 只认一个网段（matcher/mod.rs client_net）：和域名一样一个值一个匹配器 / client_ip takes one network (matcher/mod.rs client_net),
    // so like domains it is one matcher per value
    case 'client_ip': return eachValue(c, (x) => ({ type: 'client_ip', cidr: cidrOf(x) }))
    case 'client_country': return [{ negative: c.negate, any: [{ type: 'geoip_country', country_codes: v.map((x) => x.toUpperCase()) }] }]
    case 'client_private': return [{ negative: false, any: [{ type: 'geoip_private', expect: !c.negate }] }]
    case 'edns': return [{ negative: false, any: [{ type: 'edns_present', expect: !c.negate }] }]
    case 'qtype':
    case 'qclass': return eachValue(c, (x) => ({ type: c.field, value: x.toUpperCase() }))
  }
}
function responseTerms(c: ResponseCondition): Term[] {
  const v = c.values.map((x) => x.trim()).filter(Boolean)
  const each = (make: (x: string) => KMatcher) => eachValue(c, make)
  switch (c.field) {
    case 'rcode': return each((x) => ({ type: 'response_rcode', value: x.toUpperCase() }))
    case 'answer_type': return each((x) => ({ type: 'response_type', value: x.toUpperCase() }))
    case 'upstream': return each((x) => ({ type: 'upstream_equals', value: x }))
    case 'qclass': return each((x) => ({ type: 'response_qclass', value: x.toUpperCase() }))
    case 'request_domain': return each((x) => (c.regex ? { type: 'request_domain_regex', value: x } : c.exact ? { type: 'request_domain_exact', value: kernelDomain(x) } : { type: 'request_domain_suffix', value: kernelDomain(withoutWildcard(x)) }))
    // 类型名照内核的写：response_request_domain_geo_site（config.rs ResponseMatcher::ResponseRequestDomainGeoSite），以前写的 _geosite 内核不认，
    // 整份配置都不收。「不属于」也按否定的项写（不用 _not 那个匹配器）：几个值时和别的字段一样由下面的条件链和 ruleProblems 的「满足任一」那条管。
    // 回答阶段总拿着 GeoSite 数据（engine/rules.rs acquire_geo_locks），所以否定的 response_request_domain_geo_site 和 _not 那个一样
    // The type name is the kernel's: response_request_domain_geo_site (config.rs ResponseMatcher::ResponseRequestDomainGeoSite); the _geosite
    // written before is unknown to the kernel, which refused the whole config. 不属于 is a negated term too (not the _not matcher): with several
    // values it is handled, like any other field, by the chains below and ruleProblems' 满足任一 check. The answer phase always holds the GeoSite
    // data (engine/rules.rs acquire_geo_locks), so a negated response_request_domain_geo_site equals the _not matcher
    case 'request_geosite': return each((x) => ({ type: 'response_request_domain_geo_site', value: x }))
    case 'txt': return each((x) => ({ type: 'response_txt_content', mode: c.txtMode ?? 'exact', value: x }))
    case 'answer_ip': return [{ negative: c.negate, any: [{ type: 'response_answer_ip', cidr: v.map(cidrOf).join(',') }] }]
    case 'upstream_ip': return [{ negative: c.negate, any: [{ type: 'response_upstream_ip', cidr: v.map(cidrOf).join(',') }] }]
    case 'answer_country': return [{ negative: c.negate, any: [{ type: 'response_answer_ip_geoip_country', country_codes: v.map((x) => x.toUpperCase()) }] }]
    case 'answer_private': return [{ negative: false, any: [{ type: 'response_answer_ip_geoip_private', expect: !c.negate }] }]
    case 'edns': return [{ negative: false, any: [{ type: 'response_edns_present', expect: !c.negate }] }]
  }
}

// 内核按从左到右的顺序结合每一项，第一项的结果做起点，没有括号。所以「几个里中一个」只能放最前面；
// 后面再有这样的项，就拆成几条结论相同的规则（谁先命中谁生效，效果一样）。
// The kernel folds left to right with the first item as the seed and no brackets, so a "one of several" term can only lead;
// any further such term splits the rule into several with the same outcome (first match wins, so the result is identical).
export function andChains(terms: Term[], seed: KMatcher | null): { matchers: KMatcher[]; operator: string }[] {
  const positives = terms.filter((t) => !t.negative)
  const negatives = terms.filter((t) => t.negative).map((t) => ({ ...t.any[0]!, operator: 'and_not' }))
  const multi = positives.filter((t) => t.any.length > 1)
  const single = positives.filter((t) => t.any.length === 1).map((t) => ({ ...t.any[0]!, operator: 'and' }))
  const lead = multi[0]
  const rest = multi.slice(1)
  let tails: KMatcher[][] = [[]]
  for (const t of rest) tails = tails.flatMap((tail) => t.any.map((m) => [...tail, { ...m, operator: 'and' }]))
  return tails.map((tail) => {
    const head: KMatcher[] = lead ? lead.any.map((m, i) => ({ ...m, operator: i === 0 ? 'and' : 'or' })) : []
    let matchers = [...head, ...single, ...tail, ...negatives]
    if (!head.length && !single.length && !tail.length) matchers = negatives.length ? [{ ...(seed ?? { type: 'any' }), operator: 'and' }, ...negatives] : []
    return { matchers, operator: 'and' }
  })
}
// 回答阶段没有「任意」匹配器，第一项又总按肯定起头（matcher/mod.rs eval_match_chain），所以全是「不是」的时候
// 先用同一个条件垫出恒真（x 或非 x）或恒假（x 且非 x），再把每一项并进来。
// The answer phase has no 'any' matcher and the first item always seeds as a positive (matcher/mod.rs eval_match_chain), so when every
// item is negated the chain first builds a constant from one item — true as x or_not x, false as x and_not x — and folds the rest onto it.
// 一个匹配器都没写出来（值只有空白）的条件不算；一个都不剩时为 null，和没有条件一样不写回答处理（ruleProblems 拦着保存）
// A condition that writes no matcher (blank values only) does not count; with none left it is null and, as with no conditions, no answer
// handling is written (ruleProblems holds the save back)
function responseChain(r: ResponseHandling): { matchers: KMatcher[]; operator: string } | null {
  const terms = r.conditions.flatMap(responseTerms).filter((t) => t.any.length)
  if (!terms.length) return null
  const items = terms.flatMap((t) => t.any.map((m) => ({ m, negative: t.negative })))
  if (r.match === 'any') {
    const pos = items.filter((i) => !i.negative)
    const neg = items.filter((i) => i.negative).map((i) => ({ ...i.m, operator: 'or_not' }))
    if (pos.length) return { matchers: [...pos.map((i, n) => ({ ...i.m, operator: n === 0 ? 'and' : 'or' })), ...neg], operator: 'and' }
    const x = items[0]!.m
    return { matchers: [{ ...x, operator: 'and' }, { ...x, operator: 'and_not' }, ...neg], operator: 'and' }
  }
  if (terms.every((t) => t.negative)) {
    const x = terms[0]!.any[0]!
    return { matchers: [{ ...x, operator: 'and' }, { ...x, operator: 'or_not' }, ...terms.map((t) => ({ ...t.any[0]!, operator: 'and_not' }))], operator: 'and' }
  }
  return andChains(terms, null)[0]!
}

export const upstreamPipelineId = (model: Model, id: string) => model.groups.find((g) => g.id === id)?.pipelineId ?? `upstream-${id}`
export const ruleGroupPipelineId = (model: Model, id: string) => model.ruleGroups.find((g) => g.id === id)?.pipelineId ?? `group-${id}`
export const mainPipelineId = (model: Model) => model.mainId ?? 'main'
function kernelEcs(ecs: Ecs): Record<string, unknown> | null {
  if (!ecs) return null
  if (ecs.mode === 'clear') return { mode: 'clear' }
  if (ecs.mode === 'client') return { mode: 'from_client_ip', prefix_v4: ecs.v4, prefix_v6: ecs.v6 }
  const [ip, prefix] = ecs.subnet.split('/')
  return { mode: 'static', ip, prefix: Number(prefix ?? 24) }
}
// 转发只放在自己的 Pipeline 里：Pipeline 级的 ECS 决定缓存按什么隔开，跳过去时内核按目标 Pipeline 重算，所以每个转发的 ECS 都写在它的 Pipeline 上
// A forward lives only in its own pipeline: the pipeline-level ECS sets how the cache is split, and a jump recomputes it from the target, so each forward's ECS goes on its pipeline
function forwardPipeline(model: Model, id: string, groupId: string, ecs: Ecs, response: Partial<KRule>): KPipeline {
  const g = model.groups.find((x) => x.id === groupId)
  const kecs = kernelEcs(ecs)
  const action: Record<string, unknown> = g?.addresses.length ? { type: 'forward', upstream: g.addresses.map(kernelUpstream).join(', ') } : { type: 'allow' }
  if (kecs && action.type === 'forward') action.ecs = kecs
  return { id, ...(kecs ? { ecs: kecs } : {}), rules: [{ ...emptyRule(id, [action]), ...response }] }
}
function outcomeActions(model: Model, o: Outcome | Remedy): Record<string, unknown>[] {
  switch (o.type) {
    case 'upstream': return [{ type: 'jump_to_pipeline', pipeline: upstreamPipelineId(model, o.group) }]
    case 'block': {
      const r = o.response === 'default' ? model.defaults.block : o.response
      if (r === 'zero') return [{ type: 'static_ip_response', ip: '0.0.0.0,::' }]
      if (r === 'REFUSED') return [{ type: 'deny' }]
      return [{ type: 'static_response', rcode: r }]
    }
    case 'answer': {
      const ttl = o.ttl === null ? {} : { ttl: o.ttl }
      if (o.kind === 'ip') return [{ type: 'static_ip_response', ip: splitList(o.value).join(',') }]
      if (o.kind === 'cname') return [{ type: 'static_cname_response', target: o.value.trim(), ...ttl }]
      return [{ type: 'static_txt_response', text: [o.value], ...ttl }]
    }
    case 'group': return [{ type: 'jump_to_pipeline', pipeline: ruleGroupPipelineId(model, o.group) }]
    case 'continue': return [{ type: 'continue' }]
    case 'rewrite_txt': return [{ type: 'replace_txt_response', text: [o.value] }]
    case 'none': return []
  }
}
function groupFallback(model: Model, g: UpstreamGroup): Pick<KRule, 'response_matchers' | 'response_matcher_operator' | 'response_actions_on_match'> | null {
  const f = g.fallback
  if (!f.group || (!f.onError && !f.onPolluted) || !model.groups.some((x) => x.id === f.group)) return null
  const matchers: KMatcher[] = []
  if (f.onError) for (const value of ['SERVFAIL', 'REFUSED']) matchers.push({ type: 'response_rcode', value })
  if (f.onPolluted) for (const cidr of POLLUTED_CIDRS) matchers.push({ type: 'response_answer_ip', cidr })
  return { response_matchers: matchers, response_matcher_operator: 'or', response_actions_on_match: [{ type: 'jump_to_pipeline', pipeline: upstreamPipelineId(model, f.group) }] }
}
const emptyRule = (name: string, actions: Record<string, unknown>[]): KRule => ({ name, matchers: [], matcher_operator: 'and', actions, response_matchers: [], response_matcher_operator: 'and', response_actions_on_match: [], response_actions_on_miss: [] })

// 规则单独设了 ECS 或回答处理时，自己带一个转发 Pipeline / A rule with its own ECS or answer handling gets its own forward pipeline
const ownsForward = (rule: Rule) => !rule.raw && rule.outcome.type === 'upstream' && (rule.ecs !== 'inherit' || rule.response.mode !== 'inherit')
function rulePipeline(model: Model, rule: Rule): KPipeline | null {
  const o = rule.outcome
  if (o.type !== 'upstream' || !ownsForward(rule)) return null
  const g = model.groups.find((x) => x.id === o.group)
  let response: Partial<KRule> = {}
  const chain = rule.response.mode === 'custom' ? responseChain(rule.response) : null
  if (chain) {
    const withLog = (level: LogLevel | null | undefined, acts: Record<string, unknown>[]) => (level ? [{ type: 'log', level }, ...acts] : acts)
    response = { response_matchers: chain.matchers, response_matcher_operator: chain.operator, response_actions_on_match: withLog(rule.response.thenLog, outcomeActions(model, rule.response.then)), response_actions_on_miss: withLog(rule.response.otherwiseLog, outcomeActions(model, rule.response.otherwise)) }
  } else if (rule.response.mode === 'inherit' && g) response = groupFallback(model, g) ?? {}
  return forwardPipeline(model, `rule-${rule.id}`, o.group, rule.ecs === 'inherit' ? (g?.ecs ?? null) : rule.ecs, response)
}
function kernelRules(model: Model, rule: Rule, kname: string): KRule[] {
  if (rule.raw) return JSON.parse(JSON.stringify(rule.raw)) as KRule[]
  const pre = rule.log.enabled ? [{ type: 'log', level: rule.log.level }] : []
  const actions = [...pre, ...(ownsForward(rule) ? [{ type: 'jump_to_pipeline', pipeline: `rule-${rule.id}` }] : outcomeActions(model, rule.outcome))]
  const groups = rule.conditions.filter((g) => g.length)
  const chains = (groups.length ? groups : [[]]).flatMap((g) => andChains(g.flatMap(requestTerms), { type: 'any' }))
  return chains.map((chain, i) => ({ ...emptyRule(chains.length > 1 ? `${kname}#${i + 1}` : kname, actions), matchers: chain.matchers, matcher_operator: chain.operator }))
}

// ---------- 内核规则名 / kernel rule names ----------
// 内核按规则名记命中、写执行路径和查询日志；面板读回来时要认出每个名字是哪条规则。名字由这里起，同一个列表里每个名字只指向一样东西，
// 读的一方都查编译时一起做出来的对照表（kernelRuleIndex），不再按名字的样子猜
// The kernel counts hits and writes traces and the query log by rule name; reading them back the panel must tell which rule each
// name is. Names are given here, so within a list every name stands for one thing, and every reader looks up the index made with
// the config (kernelRuleIndex) instead of guessing from a name's shape
const SPLIT = /#\d+$/
const baseName = (name: string) => name.replace(SPLIT, '')

/**
 * 一个列表里每条启用的规则在内核里叫什么。名字只能认回它自己时用名字；以下几种用 rule-编号，和没起名字的规则一样：
 * 同一列表里重名、和本列表的其余请求同名、形如「…#数字」（拆开的几段就这么叫）或「rule-数字」、是高级规则原样写回的名字的基名。
 * 重名的几条一起改用编号，调整顺序时内核名不跟着变
 * What each enabled rule of a list is called in the kernel. Its name when the name can only lead back to it; rule-<id>, as an unnamed
 * rule is, when the name repeats in the list, equals the list's catch-all, is shaped like 「…#digits」 (how split parts are named) or
 * 「rule-digits」, or is the base of a name an advanced rule writes back verbatim. Repeated names all switch together, so reordering
 * changes no kernel name.
 * rule-编号 也要躲开列表里已经有人用的名字（高级规则原样写回的、别的规则自己的名字）：被占了就用 rule-编号-2 这样的，读回来时按上一份编出来的
 * 对照表认（importer.ts carryOver），不靠名字的样子
 * rule-<id> steers clear of names the list already uses too (written back verbatim by advanced rules, other rules' own names): when taken
 * it becomes rule-<id>-2 and so on, read back through the previous compile's index (importer.ts carryOver), not by the name's shape
 */
function listKernelNames(rules: Rule[], rest: string): Map<number, string> {
  const live = rules.filter((r) => r.enabled)
  const verbatim = new Set(live.flatMap((r) => (r.raw ?? []).flatMap((k) => (typeof k.name === 'string' ? [baseName(k.name)] : []))))
  const uses = new Map<string, number>()
  for (const r of live) if (!r.raw && r.name.trim()) uses.set(r.name.trim(), (uses.get(r.name.trim()) ?? 0) + 1)
  const own = (name: string) => name !== '' && uses.get(name) === 1 && name !== rest && !SPLIT.test(name) && !/^rule-\d+$/.test(name) && !verbatim.has(name)
  const names = new Map<number, string>()
  const claimed = new Set<string>([...verbatim, rest])
  for (const r of live) if (!r.raw && own(r.name.trim())) { names.set(r.id, r.name.trim()); claimed.add(r.name.trim()) }
  for (const r of live) {
    if (r.raw || names.has(r.id)) continue
    let name = `rule-${r.id}`
    for (let n = 2; claimed.has(name); n++) name = `rule-${r.id}-${n}`
    claimed.add(name)
    names.set(r.id, name)
  }
  return names
}

/** 内核规则名指向面板里的哪一样 / What a kernel rule name stands for in the panel */
export type KernelRuleRef =
  | { kind: 'rule'; id: number }
  | { kind: 'rest' }
  | { kind: 'groupRest'; group: string }
  | { kind: 'blocklist' }
  | { kind: 'mapping'; domain: string }
  | { kind: 'forward'; group: string }
  | { kind: 'ownForward'; id: number }

export interface KernelRuleIndex {
  /**
   * 列表里一个内核规则名指向什么。确切的名字先认；拆开的几段（名字#N）的基名在没有这个确切名字时也认得。不知道列表时传 null：
   * 只在一个列表里出现的名字照样认得。认不出、或者一个名字被两样东西认领时为 null：宁可认不出，不认错
   * What a kernel rule name in a list stands for. Exact names come first; the base of split parts (name#N) is known where no exact
   * name is that. With no list (null) a name found in one list only is still known. Null when unknown, or when two things claim the
   * name: better unknown than wrong
   */
  lookup: (pipeline: string | null, name: string) => KernelRuleRef | null
  /**
   * 规则在内核里所在的列表和名字（拆开的几段取基名，和查询日志按规则筛选的认法一样）。没写进内核、高级规则的几条没有共同的基名、
   * 或者这个基名在列表里还有别的在用（按它筛会混进别的）时为 null
   * The list and name a rule has in the kernel (the base for split parts, as the query log's rule filter matches). Null when it is not
   * in the kernel, an advanced rule's kernel rules share no base, or something else in the list uses that base too (filtering by it
   * would mix the other in)
   */
  nameOf: (ruleId: number) => { pipeline: string; name: string } | null
}

/** 写出的内核配置和它的规则名对照表，同一次编译做出来；strict 时重名的 Pipeline id 直接报错（测试里默认这样） / The kernel config and its
 * rule-name index, made by one compile; with strict a repeated pipeline id throws (the default in tests) */
export function compileNamed(model: Model, strict = STRICT_PIPELINE_IDS): { config: KernelConfig; index: KernelRuleIndex } {
  type Names = Map<string, Map<string, KernelRuleRef | null>>
  // 内核报上来的是确切的名字：确切的名字先认，拆开的几段的基名只在没有这个确切名字时才算 / The kernel reports exact names: an exact name comes
  // first, and the base of split parts counts only where no exact name is that
  const exact: Names = new Map()
  const bases: Names = new Map()
  // 每个列表里每个基名被谁用着：查询日志按基名筛，基名只归一条规则时才能拿来代表它 / Who uses each base in each list: the query log filters by
  // base, so a base stands for a rule only when it is that rule's alone
  const owners = new Map<string, Map<string, Set<string>>>()
  const ruleBases = new Map<number, { pipeline: string; names: Set<string> }>()
  const key = (ref: KernelRuleRef) => JSON.stringify(ref)
  const put = (names: Names, pipeline: string, name: string, ref: KernelRuleRef) => {
    const here = names.get(pipeline) ?? new Map<string, KernelRuleRef | null>()
    names.set(pipeline, here)
    const was = here.get(name)
    here.set(name, was === undefined ? ref : was && key(was) === key(ref) ? was : null)
  }
  const claim = (pipeline: string, name: string, ref: KernelRuleRef) => {
    put(exact, pipeline, name, ref)
    if (SPLIT.test(name)) put(bases, pipeline, baseName(name), ref)
    const here = owners.get(pipeline) ?? new Map<string, Set<string>>()
    owners.set(pipeline, here)
    here.set(baseName(name), (here.get(baseName(name)) ?? new Set<string>()).add(key(ref)))
    if (ref.kind !== 'rule') return
    const at = ruleBases.get(ref.id) ?? { pipeline, names: new Set<string>() }
    at.names.add(baseName(name))
    ruleBases.set(ref.id, at)
  }
  const config = compileClaiming(model, claim)
  const clash = strict ? repeatedPipelineIds(config) : []
  if (clash.length) throw new Error(`编出了两个同名的 Pipeline：${clash.join('、')}`)
  // 一个列表里这个名字：undefined 是没有，null 是被两样东西认领 / This name in one list: undefined when absent, null when two things claim it
  const inList = (pipeline: string, name: string): KernelRuleRef | null | undefined => {
    const here = exact.get(pipeline)
    return here?.has(name) ? here.get(name)! : bases.get(pipeline)?.get(name)
  }
  const index: KernelRuleIndex = {
    lookup: (pipeline, name) => {
      if (pipeline !== null) return inList(pipeline, name) ?? null
      const found = [...exact.keys()].map((p) => inList(p, name)).filter((ref) => ref !== undefined)
      return found.length && found.every((ref) => ref && key(ref) === key(found[0]!)) ? found[0]! : null
    },
    nameOf: (ruleId) => {
      const at = ruleBases.get(ruleId)
      if (!at || at.names.size !== 1) return null
      const name = [...at.names][0]!
      return owners.get(at.pipeline)?.get(name)?.size === 1 ? { pipeline: at.pipeline, name } : null
    },
  }
  return { config, index }
}

export const kernelRuleIndex = (model: Model): KernelRuleIndex => compileNamed(model).index

export const mappingIsIp = (r: Mapping) => splitList(r.target).every(isIp)
// 映射本来就连同子域名，*. 写不写一样；写进内核的后缀不带它（带着就成了后缀「*.x」，什么都不命中），和条件里的「属于」一样
// A mapping covers subdomains already, so *. changes nothing; the suffix written to the kernel leaves it out (kept, it became the suffix 「*.x」
// and matched nothing), as 属于 in a condition does
export const mappingDomain = (r: Pick<Mapping, 'domain'>): string => withoutWildcard(r.domain.trim())
/** 映射写进内核的后缀：中文这样的域名换成 punycode；页面上和规则名照写的 / The suffix a mapping writes to the kernel: names such as Chinese ones
 * as punycode, while the page and the rule name keep what was written */
export const mappingKernelDomain = (r: Pick<Mapping, 'domain'>): string => kernelDomain(mappingDomain(r))
function mappingActions(r: Mapping): Record<string, unknown>[] {
  if (mappingIsIp(r)) return [{ type: 'static_ip_response', ip: splitList(r.target).join(',') }]
  return [{ type: 'static_cname_response', target: r.target.trim(), ...(r.ttl === null ? {} : { ttl: r.ttl }) }]
}
/** 写进内核的映射：启用、域名和目标都填了 / A mapping that goes into the kernel: enabled, with domain and target filled in */
export const mappingLive = (r: Mapping): boolean => r.enabled && Boolean(r.domain.trim()) && Boolean(r.target.trim())
/** 一条映射在内核里的那条规则 / A mapping's rule in the kernel */
export const mappingRule = (r: Mapping): KRule => ({ ...emptyRule(`域名映射 ${r.domain.trim()}`, mappingActions(r)), matchers: [{ type: 'domain_suffix', value: mappingKernelDomain(r), operator: 'and' }] })
/** 一个上游组在内核里的那个 Pipeline：转发到组的地址，带组的子网和备用 / An upstream group's pipeline in the kernel: a forward to its addresses with its subnet and fallback */
export const groupPipeline = (model: Model, g: UpstreamGroup): KPipeline => forwardPipeline(model, upstreamPipelineId(model, g.id), g.id, g.ecs, groupFallback(model, g) ?? {})
export function kernelRuleCount(rule: Rule): number {
  if (rule.raw) return rule.raw.length
  const groups = rule.conditions.filter((g) => g.length)
  return (groups.length ? groups : [[]]).reduce((n, g) => n + andChains(g.flatMap(requestTerms), { type: 'any' }).length, 0)
}

/**
 * 拦截列表的入口，排在域名映射后面、高级入口前面，都进只回拦截的那个 Pipeline。自己写的放行比什么都优先，所以每个入口都减掉它们；
 * 自己写的拦截列表里的放行管不了；列表里带 `$important` 的拦截只有带 `$important` 的放行管得了；其余的拦截减掉列表里所有放行
 * The blocklists' entries, after the mappings and before the advanced entries, all into the pipeline that only blocks. The rules
 * of one's own that allow come first of all, so every entry takes them off; one's own blocks are beyond the lists' allows; a
 * list's `$important` block yields only to `$important` allows; every other block yields to all the lists' allows
 */
export function blocklistEntries(model: Model, pipeline = BLOCKLIST_PIPELINE): KernelConfig['pipeline_select'] {
  const own = parseOwnRules(model.blocklists.custom).rules
  const allows = own.filter((r) => r.allow).map((r): KMatcher => ({ ...ownMatcher(r.match), operator: 'and_not' }))
  const blocks = own.filter((r) => !r.allow).map((r, i): KMatcher => ({ ...ownMatcher(r.match), operator: i ? 'or' : 'and' }))
  const entry = (matchers: KMatcher[]) => ({ pipeline, matcher_operator: 'and', matchers: [...matchers, ...allows] })
  const tag = (value: string, operator: string): KMatcher => ({ type: 'geo_site', value, operator })
  const entries = blocks.length ? [entry(blocks)] : []
  if (model.blocklists.file) {
    entries.push(entry([tag(TAG_BLOCK_IMPORTANT, 'and'), tag(TAG_ALLOW_IMPORTANT, 'and_not')]))
    entries.push(entry([tag(TAG_BLOCK, 'and'), tag(TAG_ALLOW, 'and_not'), tag(TAG_ALLOW_IMPORTANT, 'and_not')]))
  }
  return entries
}

// 规则、上游组、规则组和原样保留的 Pipeline 用掉的 id：域名映射和拦截列表的 Pipeline 都躲开它们 / The ids rules, upstream groups, rule
// groups and verbatim pipelines take: the mappings' and the blocklists' pipelines both steer clear of them
function listPipelineIds(model: Model): Set<string> {
  const rules = [...model.rules, ...model.ruleGroups.flatMap((rg) => rg.rules)].filter((r) => r.enabled)
  return new Set<string>([
    ...model.groups.map((g) => upstreamPipelineId(model, g.id)), mainPipelineId(model),
    ...model.ruleGroups.map((rg) => ruleGroupPipelineId(model, rg.id)), ...(model.rawPipelines ?? []).map((p) => String(p.id)),
    ...rules.flatMap((r) => (ownsForward(r) ? [`rule-${r.id}`] : [])),
  ])
}
/**
 * 规则编号定下它自己那个转发的名字（rule-编号）。这几个形如 rule-编号 的 id 已经是别的 Pipeline 的（读成上游组、规则组或原样保留的），新规则
 * 不用对应的编号，不然它以后单独设子网或回答检查时编出两个同名的。编辑器发新编号时按它躲（导入起编号时躲的是配置里所有的 Pipeline）
 * A rule's id names its own forward (rule-<id>). These rule-<id>-shaped ids already belong to other pipelines (read as upstream groups, rule
 * groups or kept verbatim), so a new rule does not take the matching id, or once it sets its own subnet or answer check it compiles to two of
 * one name. The editor's new ids steer clear of them (the import's steer clear of every pipeline in the config)
 */
export function foreignRulePipelines(model: Model): Set<string> {
  const ids = [...model.groups.map((g) => upstreamPipelineId(model, g.id)), ...model.ruleGroups.map((rg) => ruleGroupPipelineId(model, rg.id)), ...(model.rawPipelines ?? []).map((p) => String(p.id)), mainPipelineId(model), model.mappingId ?? '']
  return new Set(ids.filter((id) => /^rule-\d+$/.test(id)))
}
/**
 * 域名映射那个 Pipeline 的 id：一般是 domain_mapping，导入的配置里叫别的就用那个；别的列表已经叫这个名字时（比如 JSON 里把一个规则组改成了
 * domain_mapping），换成 domain_mapping-2 这样不重名的。编配置、测试域名、执行路径、查询日志和概览都用它
 * The mappings' pipeline id: usually domain_mapping, or what an imported config called it; when another list already has that name (a rule group
 * renamed domain_mapping in the JSON, say), one nothing else uses such as domain_mapping-2. Compiling, the domain tester, the trace, the query
 * log and the overview all use it
 */
export function mappingPipelineId(model: Model): string {
  const taken = listPipelineIds(model)
  const own = model.mappingId ?? 'domain_mapping'
  let id = own
  for (let n = 2; taken.has(id); n++) id = `${own}-${n}`
  return id
}
/**
 * 拦截列表那个 Pipeline 的 id：一般是 blocklist；JSON 里手改过、认不出的旧拦截列表还留着同名的 Pipeline 时，换成 blocklist-2 这样不重名的。
 * 编配置、测试域名和执行路径都用它
 * The blocklists' pipeline id: usually blocklist; when a hand-edited old blocklist that could not be recognised still keeps a pipeline of that
 * name, one nothing else uses such as blocklist-2. Compiling, the domain tester and the trace all use it
 */
export function blocklistPipelineId(model: Model): string {
  const taken = new Set([...listPipelineIds(model), mappingPipelineId(model)])
  let id = BLOCKLIST_PIPELINE
  for (let n = 2; taken.has(id); n++) id = `${BLOCKLIST_PIPELINE}-${n}`
  return id
}

/**
 * 写出的配置里重名的 Pipeline id。内核的校验和热重载不收；启动时只记警告照样加载，入口和跳转只认后一个，前一个的规则悄悄没了（以前的内核校验时
 * 也照收）。所以面板一个都不该写出来：测试里 compile 直接报错，页面上保存条说保存不了，不写出去（useConfigDocument pipelineClash）
 * The pipeline ids a written config repeats. The kernel's validation and reload refuse them; startup only warns and loads them, entries and
 * jumps reach the later one and the earlier one's rules silently vanish (earlier kernels took them at validation too). So the panel must
 * write none: in tests compile throws outright, and on the page the save bar says the save cannot happen and nothing is written
 * (useConfigDocument pipelineClash)
 */
export function repeatedPipelineIds(config: Pick<KernelConfig, 'pipelines'>): string[] {
  const ids = config.pipelines.map((p) => p.id)
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
}
/** 草稿写出去会有重名的 Pipeline id 吗（不报错，给页面用） / Whether the draft would write repeated pipeline ids (never throws; for the page) */
export const draftPipelineClashes = (model: Model): string[] => repeatedPipelineIds(compileClaiming(model, () => {}))
// 测试里重名的 Pipeline id 直接报错：哪一处编出了它，当场看得见 / In tests a repeated pipeline id throws outright, so whatever compiled it shows at once
const STRICT_PIPELINE_IDS = import.meta.env?.MODE === 'test'

export function compile(model: Model): KernelConfig {
  return compileNamed(model).config
}

type Claim = (pipeline: string, name: string, ref: KernelRuleRef) => void
// 一个列表里的规则：按 listKernelNames 起名，每条内核规则登记它是哪条面板规则 / A list's rules: named by listKernelNames, each kernel rule claimed for its panel rule
function listRules(model: Model, pipeline: string, rules: Rule[], rest: string, claim: Claim): KRule[] {
  const names = listKernelNames(rules, rest)
  return rules.filter((r) => r.enabled).flatMap((r) => kernelRules(model, r, names.get(r.id) ?? '').map((kr) => { claim(pipeline, kr.name, { kind: 'rule', id: r.id }); return kr }))
}

function compileClaiming(model: Model, claim: Claim): KernelConfig {
  const pipelines: KernelConfig['pipelines'] = []
  for (const g of model.groups) {
    const forward = groupPipeline(model, g)
    for (const r of forward.rules) claim(forward.id, r.name, { kind: 'forward', group: g.id })
    pipelines.push(forward)
  }
  // 域名映射和现在的面板一样做成最前面的入口：所有请求先过它，被高级入口带去别处的也一样
  // Domain mappings are the first entry, as in today's panel: every request meets them first, including those an advanced entry sends elsewhere
  const live = model.mappings.filter(mappingLive)
  const mappingId = mappingPipelineId(model)
  if (live.length) {
    for (const r of live) claim(mappingId, `域名映射 ${r.domain.trim()}`, { kind: 'mapping', domain: r.domain.trim() })
    pipelines.push({ id: mappingId, rules: live.map(mappingRule) })
  }
  const mainId = mainPipelineId(model)
  const main = [...listRules(model, mainId, model.rules, '其余请求', claim), emptyRule('其余请求', outcomeActions(model, model.rest))]
  claim(mainId, '其余请求', { kind: 'rest' })
  pipelines.push({ ...model.mainExtra, id: mainId, rules: main })
  const select: KernelConfig['pipeline_select'] = live.length ? [{ pipeline: mappingId, matcher_operator: 'and', matchers: live.map((r, i) => ({ type: 'domain_suffix', value: mappingKernelDomain(r), operator: i ? 'or' : 'and' })) }] : []
  const blocklistId = blocklistPipelineId(model)
  const blocking = blocklistEntries(model, blocklistId)
  if (blocking.length) {
    claim(blocklistId, BLOCKLIST_RULE, { kind: 'blocklist' })
    pipelines.push({ id: blocklistId, rules: [emptyRule(BLOCKLIST_RULE, outcomeActions(model, { type: 'block', response: 'default' }))] })
    select.push(...blocking)
  }
  // 入口顺序：域名映射、拦截列表、高级入口、主列表 / Entry order: domain mappings, blocklists, advanced entries, the main list
  for (const rg of model.ruleGroups) {
    const id = ruleGroupPipelineId(model, rg.id)
    const rest = `${rg.name}·其余`
    pipelines.push({ ...rg.extra, id, rules: [...listRules(model, id, rg.rules, rest, claim), emptyRule(rest, outcomeActions(model, rg.rest))] })
    claim(id, rest, { kind: 'groupRest', group: rg.id })
  }
  select.push(...(model.entries ?? []).map((e) => JSON.parse(JSON.stringify({ matcher_operator: 'and', ...e })) as KernelConfig['pipeline_select'][number]))
  for (const p of model.rawPipelines ?? []) pipelines.push(JSON.parse(JSON.stringify(p)) as KPipeline)
  for (const r of [...model.rules, ...model.ruleGroups.flatMap((rg) => rg.rules)]) {
    const own = r.enabled ? rulePipeline(model, r) : null
    if (!own) continue
    for (const k of own.rules) claim(own.id, k.name, { kind: 'ownForward', id: r.id })
    pipelines.push(own)
  }
  select.push({ pipeline: mainPipelineId(model), matcher_operator: 'and', matchers: [] })
  select.push(...(model.trailingEntries ?? []).map((e) => JSON.parse(JSON.stringify({ matcher_operator: 'and', ...e })) as KernelConfig['pipeline_select'][number]))
  const own = defaultUpstreamOf(model)
  // 照写的默认上游（有高级规则、或其余请求拦截时）也按 53 补上没写的端口，和上游组的地址一样：没点「完成」就保存的、以前存下来的，写出去都是内核认的
  // A default upstream written as it is (with advanced rules, or when 其余请求 blocks) takes 53 for a missing port too, as a group's addresses
  // do: one saved without 完成, or stored long ago, is written as the kernel takes it
  const asWritten = model.settings.default_upstream
  const settings: Record<string, unknown> = { ...model.settings, ...(own !== undefined ? { default_upstream: own } : typeof asWritten === 'string' ? { default_upstream: withDefaultPorts(asWritten) } : {}) }
  // 拦截列表合成的文件排在 Geo 数据的 GeoSite 后面，和面板服务端同步 Geo 数据时的写法一样 / The blocklists' file follows Geo data's GeoSite files, as the panel server writes them when syncing Geo data
  if (model.blocklists.file) {
    settings.geosite_data_paths = [...(Array.isArray(settings.geosite_data_paths) ? settings.geosite_data_paths : []), model.blocklists.file]
  }
  return { ...model.extra, version: model.format, settings, pipeline_select: select, pipelines }
}

// 内核的默认上游只在「放行」和没写上游的转发里用到；写成其余请求那个组的地址，两处说法一致
// The kernel's default upstream is only used by allow and by a forward without upstream; it takes the catch-all group's addresses so both agree
// 有高级规则或原样保留的 Pipeline 时不改：它们里面的「允许」还按原来的默认上游走 / Left alone when advanced rules or kept pipelines exist: their allow still means the original default
/** 默认上游是不是由其余请求的组写的（是的话设置里那一项不写进内核，页面上不显示） / Whether the default upstream is written from 其余请求's group
 * (when it is, the setting is not written to the kernel and the page does not show it) */
export const defaultUpstreamFromRest = (model: Model): boolean => defaultUpstreamOf(model) !== undefined
function defaultUpstreamOf(model: Model): string | undefined {
  const keepDefault = Boolean(model.rawPipelines?.length) || [...model.rules, ...model.ruleGroups.flatMap((g) => g.rules)].some((r) => r.raw)
  const restGroup = !keepDefault && model.rest.type === 'upstream' ? model.groups.find((g) => g.id === (model.rest as { group: string }).group) : undefined
  return restGroup?.addresses.length ? restGroup.addresses.map(kernelUpstream).join(', ') : undefined
}

/**
 * compile 写 settings 的反面：内核里的 settings 去掉 compile 自己加上的两样，得到模型里的 settings。一是按其余请求写的默认上游（值和这份模型
 * 编出来的一样时），二是拦截列表合成的文件（model.blocklists.file）。compile 写的时候盖住了模型里这两项原来的样子，所以从 was（上一份模型的
 * settings）拿回来：上一份没有就没有，不把 compile 的产物收进设置
 * The reverse of how compile writes settings: the kernel's settings without the two things compile adds, giving the model's settings. One is
 * the default upstream written from 其余请求 (when it equals what this model compiles to), the other the blocklists' merged file
 * (model.blocklists.file). Compile covered what the model held for these two, so they come back from was (the previous model's settings):
 * absent there, absent here, and nothing compile made is taken into the settings
 */
export function settingsFromKernel(model: Model, kernel: Record<string, unknown>, was: Record<string, unknown>): Record<string, unknown> {
  const settings = JSON.parse(JSON.stringify(kernel)) as Record<string, unknown>
  const restore = (key: string) => { if (was[key] !== undefined) settings[key] = JSON.parse(JSON.stringify(was[key])) as unknown; else delete settings[key] }
  const own = defaultUpstreamOf(model)
  if (own !== undefined && settings.default_upstream === own) restore('default_upstream')
  // 照写的那个只是补了端口：模型里还是原来的写法 / The one written as it is only took its ports: the model keeps how it was written
  else if (own === undefined && typeof was.default_upstream === 'string' && settings.default_upstream === withDefaultPorts(was.default_upstream)) settings.default_upstream = was.default_upstream
  const file = model.blocklists.file
  if (file && Array.isArray(settings.geosite_data_paths)) {
    const paths = (settings.geosite_data_paths as unknown[]).filter((p) => p !== file)
    // 只剩合成的文件时，这一项是 compile 加的 / With only the merged file there, compile made this key
    if (paths.length || Array.isArray(was.geosite_data_paths)) settings.geosite_data_paths = paths
    else restore('geosite_data_paths')
  }
  return settings
}

// 编辑器里「生成的内核规则」：这条规则在内核里长什么样。名字按它所在（或要放进）的列表起，草稿换掉列表里原来那条
// The editor's 生成的内核规则: what this rule becomes in the kernel. Its name follows the list it sits in (or goes into), with the draft
// in place of the list's copy
export function kernelPreview(model: Model, rule: Rule, groupId: string | null): { rules: unknown[]; pipeline: unknown } {
  const group = groupId === null ? undefined : model.ruleGroups.find((g) => g.id === groupId)
  const list = group ? group.rules : model.rules
  // 草稿停用着也按启用起名：预览说的是它写进内核时的样子 / A draft switched off is named as if enabled: the preview shows it as written to the kernel
  const draft = { ...rule, enabled: true }
  const withDraft = list.some((r) => r.id === rule.id) ? list.map((r) => (r.id === rule.id ? draft : r)) : [...list, draft]
  const name = listKernelNames(withDraft, group ? `${group.name}·其余` : '其余请求').get(rule.id) ?? `rule-${rule.id}`
  return ruleKernel(model, rule, name)
}
/** 一条规则编出来的内核规则（按 kname 起名，拆开的几段是 kname#N）和它自己的转发 Pipeline / A rule's kernel rules (named kname, split parts kname#N) and its own forward pipeline */
export const ruleKernel = (model: Model, rule: Rule, kname: string): { rules: unknown[]; pipeline: unknown } => ({ rules: kernelRules(model, rule, kname), pipeline: rulePipeline(model, rule) })
