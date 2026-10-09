import { toTree, treeText } from './condTree'
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
export interface Condition { id: number; field: ConditionField; negate: boolean; regex?: boolean; values: string[] }

export type ResponseField = 'rcode' | 'answer_ip' | 'answer_country' | 'answer_private' | 'answer_type' | 'upstream' | 'upstream_ip'
  | 'request_domain' | 'request_geosite' | 'txt' | 'qclass' | 'edns'
export interface ResponseCondition { id: number; field: ResponseField; negate: boolean; regex?: boolean; txtMode?: 'exact' | 'prefix' | 'regex'; values: string[] }

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
export interface RuleGroup { id: string; name: string; note: string; rules: Rule[]; rest: Outcome; listener: string; pipelineId?: string; extra?: Record<string, unknown> }
// 高级入口：除了「按监听标签进规则组」以外的内核入口，原样保留 / An advanced entry: a kernel entry other than a listener label into a rule group, kept verbatim
export interface RawEntry { pipeline: string; matchers: Record<string, unknown>[]; matcher_operator?: string }
export interface Mapping { id: number; domain: string; target: string; ttl: number | null; enabled: boolean }
export interface Defaults { block: 'NXDOMAIN' | 'REFUSED' | 'zero' }
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

// ---------- 文字摘要 / summaries ----------

// 每种条件能怎么比、列表里怎么读：编辑器的下拉和列表摘要用同一份措辞
// How each condition compares and how the list reads it: the editor's menus and the list summary share these words
export interface OpDef { value: string; label: string; negate: boolean; regex?: boolean; txtMode?: 'exact' | 'prefix' | 'regex'; phrase?: string }
// merge：并进另一个字段的运算里，不单独出现在字段下拉（「客户端 IP · 是内网」） / merge: folded into another field's comparisons instead of listed on its own (客户端 IP · 是内网)
export interface FieldDef { label: string; subject?: string; merge?: string; ops: OpDef[]; values: boolean; placeholder: string; mono: boolean; upper?: boolean; suggest?: string; valid?: (v: string, c: { regex?: boolean; txtMode?: string }) => boolean; hint?: string }
const IS: OpDef[] = [{ value: 'is', label: '是', negate: false }, { value: 'not', label: '不是', negate: true }]
const IN: OpDef[] = [{ value: 'is', label: '在', negate: false }, { value: 'not', label: '不在', negate: true }]
const DOMAIN_OPS: OpDef[] = [
  { value: 'is', label: '是（含子域名）', phrase: '是', negate: false }, { value: 'not', label: '不是', negate: true },
  { value: 're', label: '匹配正则', negate: false, regex: true }, { value: 'nre', label: '不匹配正则', negate: true, regex: true },
]
const validRegex = (v: string) => { try { new RegExp(v.replace(/^\(\?i\)/, '')); return true } catch { return false } }
const domainValid = (v: string, c: { regex?: boolean }) => (c.regex ? validRegex(v) : isDomain(v))
export const FIELD: Record<ConditionField, FieldDef> = {
  domain: { label: '域名', ops: DOMAIN_OPS, values: true, placeholder: 'example.com，回车添加', mono: true, valid: domainValid },
  // 行里叫 GeoSite（正式面板一直这么叫），句子里说「域名属于 GeoSite cn」 / The row says GeoSite (the production panel's name); sentences say 「域名属于 GeoSite cn」
  geosite: { label: 'GeoSite', subject: '域名', ops: [{ value: 'is', label: '属于', phrase: '属于 GeoSite', negate: false }, { value: 'not', label: '不属于', phrase: '不属于 GeoSite', negate: true }], values: true, placeholder: 'cn、category-ads-all…', mono: true, suggest: 'geosite' },
  client_ip: { label: '客户端 IP', ops: IN, values: true, placeholder: '192.168.1.0/24 或单个 IP', mono: true, valid: (v) => isCidr(v) },
  client_country: { label: '客户端地区', ops: IS, values: true, placeholder: 'CN、HK…', mono: true, upper: true, suggest: 'country', valid: (v) => /^[a-z]{2}$|^[a-z0-9_-]{3,}$/i.test(v), hint: 'GeoIP 国家代码' },
  client_private: { label: '客户端网络', merge: 'client_ip', ops: [{ value: 'is', label: '是内网', phrase: '客户端是内网', negate: false }, { value: 'not', label: '不是内网', phrase: '客户端不是内网', negate: true }], values: false, placeholder: '', mono: false },
  // 记录类型是助记词，和响应码一样用正文字体 / Record types are mnemonics, in the body face like response codes
  qtype: { label: '查询类型', ops: IS, values: true, placeholder: 'A、AAAA、PTR…', mono: false, upper: true, suggest: 'qtype' },
  qclass: { label: '查询类别', ops: IS, values: true, placeholder: 'IN、CH、HS', mono: true, upper: true, suggest: 'qclass' },
  edns: { label: 'EDNS', ops: [{ value: 'is', label: '带', phrase: '带 EDNS', negate: false }, { value: 'not', label: '不带', phrase: '不带 EDNS', negate: true }], values: false, placeholder: '', mono: false },
}
export const RESPONSE_FIELD: Record<ResponseField, FieldDef> = {
  // 响应码是助记词，正文字体（同诊断页、概览） / Response codes are mnemonics in the body face (as on diagnostics and the overview)
  rcode: { label: '响应码', ops: IS, values: true, placeholder: 'SERVFAIL、NXDOMAIN…', mono: false, upper: true, suggest: 'rcode' },
  answer_ip: { label: '回答的 IP', ops: IN, values: true, placeholder: '0.0.0.0/32、240.0.0.0/4…', mono: true, valid: (v) => isCidr(v) },
  answer_country: { label: '回答 IP 的地区', ops: IS, values: true, placeholder: 'CN、US…', mono: true, upper: true, suggest: 'country' },
  answer_private: { label: '回答 IP 的网络', merge: 'answer_ip', ops: [{ value: 'is', label: '是内网', phrase: '回答的是内网地址', negate: false }, { value: 'not', label: '不是内网', phrase: '回答的不是内网地址', negate: true }], values: false, placeholder: '', mono: false },
  answer_type: { label: '回答的记录类型', ops: IS, values: true, placeholder: 'A、AAAA、CNAME…', mono: false, upper: true, suggest: 'qtype' },
  upstream: { label: '回答来自', ops: IS, values: true, placeholder: '10.0.0.53:53', mono: true },
  upstream_ip: { label: '上游 IP', ops: IN, values: true, placeholder: '10.0.0.0/8', mono: true, valid: (v) => isCidr(v) },
  request_domain: { label: '请求的域名', ops: DOMAIN_OPS, values: true, placeholder: 'example.com', mono: true, valid: domainValid },
  request_geosite: { label: '请求域名 GeoSite', subject: '请求的域名', ops: [{ value: 'is', label: '属于', phrase: '属于 GeoSite', negate: false }, { value: 'not', label: '不属于', phrase: '不属于 GeoSite', negate: true }], values: true, placeholder: 'cn', mono: true, suggest: 'geosite' },
  txt: { label: 'TXT 内容', ops: [
    { value: 'is', label: '等于', negate: false, txtMode: 'exact' }, { value: 'not', label: '不等于', negate: true, txtMode: 'exact' },
    { value: 'prefix', label: '开头是', negate: false, txtMode: 'prefix' }, { value: 'nprefix', label: '开头不是', negate: true, txtMode: 'prefix' },
    { value: 're', label: '匹配正则', negate: false, txtMode: 'regex' }, { value: 'nre', label: '不匹配正则', negate: true, txtMode: 'regex' },
  ], values: true, placeholder: 'v=spf1，回车添加', mono: true, valid: (v, c) => (c.txtMode === 'regex' ? validRegex(v) : true) },
  qclass: { label: '查询类别', ops: IS, values: true, placeholder: 'IN', mono: true, upper: true, suggest: 'qclass' },
  edns: { label: '回答的 EDNS', ops: [{ value: 'is', label: '带', phrase: '回答带 EDNS', negate: false }, { value: 'not', label: '不带', phrase: '回答不带 EDNS', negate: true }], values: false, placeholder: '', mono: false },
}
export function opOf(def: FieldDef, c: { negate: boolean; regex?: boolean; txtMode?: string }): OpDef {
  return def.ops.find((o) => o.negate === c.negate && Boolean(o.regex) === Boolean(c.regex) && (o.txtMode ?? undefined) === (c.txtMode ?? undefined))
    ?? def.ops.find((o) => o.negate === c.negate) ?? def.ops[0]!
}

function joinValues(values: string[]): string {
  if (values.length <= 3) return values.join('、')
  return `${values.slice(0, 2).join('、')} 等 ${values.length} 个`
}
function phrase(def: FieldDef, c: { negate: boolean; regex?: boolean; txtMode?: string; values: string[] }): string {
  const op = opOf(def, c)
  if (!def.values) return op.phrase ?? `${def.label}${op.label}`
  const subject = def.subject ?? def.label
  return `${subject}${/[A-Za-z0-9]$/.test(subject) ? ' ' : ''}${op.phrase ?? op.label} ${joinValues(c.values) || '…'}`
}
export const conditionText = (c: Condition) => phrase(FIELD[c.field], c)
export const responseConditionText = (c: ResponseCondition) => phrase(RESPONSE_FIELD[c.field], c)
// 列表、对比和右栏都按编辑时的结构说：先读成「全部 / 任一 + 条件组」，组里的条件放进括号，不展开成重复的几段
// Lists, diffs and the rail all speak in the edited structure: read back as 「all / any plus groups」, a group's conditions in parentheses rather than expanded into repeated clauses
export function conditionsText(groups: Condition[][]): string {
  return treeText(toTree(groups, () => 0), conditionText)
}

// 内核原样的条件链读成一句话（高级规则和高级入口用） / A verbatim kernel chain read as a sentence (for advanced rules and entries)
const RAW_LABEL: Record<string, string> = {
  any: '任意请求', listener_label: '监听标签是', client_ip: '客户端 IP 在', domain_suffix: '域名是', domain_regex: '域名匹配正则', geo_site: '域名属于 GeoSite', geo_site_not: '域名不属于 GeoSite',
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
export function outcomePill(model: Model, o: Outcome): { verb: string; value: string; mono: boolean; broken: boolean } {
  switch (o.type) {
    case 'upstream': { const n = groupName(model, o.group); return { verb: '上游', value: n ?? '已删除的组', mono: false, broken: !n } }
    // 响应码是助记词，正文字体；只有 0.0.0.0 / :: 这种地址才用等宽 / Response codes are mnemonics in the body face; only addresses such as 0.0.0.0 / :: are mono
    case 'block': return { verb: '拦截', value: blockLabel(model, o.response), mono: (o.response === 'default' ? model.defaults.block : o.response) === 'zero', broken: false }
    case 'answer': {
      const kind = o.kind === 'ip' ? '' : o.kind === 'cname' ? 'CNAME ' : 'TXT '
      return { verb: '回答', value: `${kind}${o.kind === 'txt' ? `"${o.value}"` : o.value.split(',').map((x) => x.trim()).filter(Boolean).join(', ') || '…'}`, mono: true, broken: !o.value.trim() }
    }
    case 'group': { const n = ruleGroupName(model, o.group); return { verb: '转到', value: n ?? '已删除的规则组', mono: false, broken: !n } }
    case 'continue': return { verb: '继续', value: '交给下一条', mono: false, broken: false }
  }
}
export function outcomeSentence(model: Model, o: Outcome): string {
  switch (o.type) {
    case 'upstream': return `交给「${groupName(model, o.group) ?? '已删除的组'}」解析`
    case 'block': return `拦截，回应 ${blockLabel(model, o.response)}`
    case 'answer': return o.kind === 'txt' ? `直接回答 TXT「${o.value}」` : o.kind === 'ip' ? `直接回答 ${splitList(o.value).join('、')}` : `直接回答 CNAME ${o.value}`
    case 'group': return `转到规则组「${ruleGroupName(model, o.group) ?? '已删除'}」`
    case 'continue': return '不作决定，交给下一条规则'
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

// ---------- 校验 / validation ----------

export const splitList = (v: string) => v.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const IPV6 = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i
export const isIp = (v: string) => IPV4.test(v) || IPV6.test(v)
export const isCidr = (v: string) => { const [ip, len] = v.split('/'); return isIp(ip ?? '') && (len === undefined || /^\d{1,3}$/.test(len)) }
export const isDomain = (v: string) => /^(\*\.)?[a-z0-9_-]+(\.[a-z0-9_-]+)*\.?$/i.test(v)

export function valueProblem(def: FieldDef, c: { values: string[]; regex?: boolean; txtMode?: string }): string | null {
  if (!def.values) return null
  if (!c.values.length) return `「${def.label}」还没填值`
  if (def.valid && !c.values.every((v) => def.valid!(v, c))) return `「${def.label}」里有写错的值（标红的那个）`
  return null
}
export const conditionProblem = (c: Condition) => valueProblem(FIELD[c.field], c)
// 规则可以不起名字（同 Surge：一条规则就是条件和去向）；没有名字时用条件当标题
// A rule may go unnamed (as in Surge, a rule is its condition and its target); without a name its condition is the title
export function ruleTitle(rule: Rule): string {
  const name = rule.name.trim()
  if (name) return name
  if (rule.raw) return '原样保留的内核规则'
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
  return Math.max(0, ...ids) + 1
}

export function ruleProblems(model: Model, rule: Rule): string[] {
  const out: string[] = []
  if (rule.raw) return []
  for (const group of rule.conditions) for (const c of group) { const p = conditionProblem(c); if (p) out.push(p) }
  const o = rule.outcome
  if (o.type === 'upstream' && !groupName(model, o.group)) out.push('选的上游组已经删掉了')
  if (o.type === 'group' && !ruleGroupName(model, o.group)) out.push('选的规则组已经删掉了')
  if (o.type === 'answer') {
    if (!o.value.trim()) out.push('自定义回答还没填内容')
    else if (o.kind === 'ip' && !splitList(o.value).every(isIp)) out.push('回答的 IP 写得不对，几个 IP 用逗号隔开')
    else if (o.kind === 'cname' && !isDomain(o.value.trim())) out.push('回答的域名写得不对')
  }
  if (rule.outcome.type === 'upstream' && rule.response.mode === 'custom') {
    const r = rule.response
    if (!r.conditions.length) out.push('「上游回答后」还没加条件')
    for (const c of r.conditions) { const p = valueProblem(RESPONSE_FIELD[c.field], c); if (p) out.push(p) }
    if (r.match === 'all' && r.conditions.flatMap(responseTerms).filter((t) => !t.negative && t.any.length > 1).length > 1) out.push('「全部满足」时只能有一个条件填多个值，其余的拆成单独的条件或改成「满足任一」')
    if (r.match === 'any' && r.conditions.flatMap(responseTerms).filter((t) => t.negative).length > r.conditions.filter((c) => c.negate).length) out.push('「满足任一」时，「不是」的条件只能填一个值，几个值拆成几条')
    if (r.then.type === 'answer' && !r.then.value.trim()) out.push('「上游回答后」的自定义回答还没填内容')
  }
  if (kernelRuleCount(rule) > 32) out.push('条件组合太多（展开后超过 32 条），把多值条件合并成一个')
  return out
}

// ---------- 落成内核配置 / compile ----------

type KMatcher = Record<string, unknown> & { type: string; operator?: string }
interface KRule { name: string; matchers: KMatcher[]; matcher_operator: string; actions: Record<string, unknown>[]; response_matchers: KMatcher[]; response_matcher_operator: string; response_actions_on_match: Record<string, unknown>[]; response_actions_on_miss: Record<string, unknown>[] }
interface KPipeline { id: string; ecs?: Record<string, unknown>; rules: KRule[] }
export interface KernelConfig { [key: string]: unknown; version: string; settings: Record<string, unknown>; pipeline_select: { pipeline: string; matcher_operator: string; matchers: KMatcher[] }[]; pipelines: KPipeline[] }

const cidrOf = (v: string) => (v.includes('/') ? v : `${v}/${v.includes(':') ? 128 : 32}`)

// 一个条件落成的「项」：单个匹配器，或几个只要中一个的匹配器 / A condition becomes a term: one matcher, or several of which any may match
interface Term { negative: boolean; any: KMatcher[] }
function requestTerms(c: Condition): Term[] {
  const v = c.values.map((x) => x.trim()).filter(Boolean)
  switch (c.field) {
    case 'domain':
      if (c.negate) return v.map((x) => ({ negative: true, any: [c.regex ? { type: 'domain_regex', value: x } : { type: 'domain_suffix', value: x.replace(/^\*\./, '') }] }))
      return [{ negative: false, any: v.map((x) => (c.regex ? { type: 'domain_regex', value: x } : { type: 'domain_suffix', value: x.replace(/^\*\./, '') })) }]
    case 'geosite':
      if (c.negate) return v.map((x) => ({ negative: true, any: [{ type: 'geo_site', value: x }] }))
      return [{ negative: false, any: v.map((x) => ({ type: 'geo_site', value: x })) }]
    case 'client_ip': return [{ negative: c.negate, any: [{ type: 'client_ip', cidr: v.map(cidrOf).join(',') }] }]
    case 'client_country': return [{ negative: c.negate, any: [{ type: 'geoip_country', country_codes: v.map((x) => x.toUpperCase()) }] }]
    case 'client_private': return [{ negative: false, any: [{ type: 'geoip_private', expect: !c.negate }] }]
    case 'edns': return [{ negative: false, any: [{ type: 'edns_present', expect: !c.negate }] }]
    case 'qtype':
    case 'qclass':
      if (c.negate) return v.map((x) => ({ negative: true, any: [{ type: c.field, value: x.toUpperCase() }] }))
      return [{ negative: false, any: v.map((x) => ({ type: c.field, value: x.toUpperCase() })) }]
  }
}
function responseTerms(c: ResponseCondition): Term[] {
  const v = c.values.map((x) => x.trim()).filter(Boolean)
  const each = (make: (x: string) => KMatcher) => (c.negate ? v.map((x) => ({ negative: true, any: [make(x)] })) : [{ negative: false, any: v.map(make) }])
  switch (c.field) {
    case 'rcode': return each((x) => ({ type: 'response_rcode', value: x.toUpperCase() }))
    case 'answer_type': return each((x) => ({ type: 'response_type', value: x.toUpperCase() }))
    case 'upstream': return each((x) => ({ type: 'upstream_equals', value: x }))
    case 'qclass': return each((x) => ({ type: 'response_qclass', value: x.toUpperCase() }))
    case 'request_domain': return each((x) => (c.regex ? { type: 'request_domain_regex', value: x } : { type: 'request_domain_suffix', value: x }))
    case 'request_geosite': return v.map((x) => ({ negative: false, any: [{ type: c.negate ? 'response_request_domain_geosite_not' : 'response_request_domain_geosite', value: x }] }))
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
function responseChain(r: ResponseHandling): { matchers: KMatcher[]; operator: string } {
  const terms = r.conditions.flatMap(responseTerms)
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
  const action: Record<string, unknown> = g?.addresses.length ? { type: 'forward', upstream: g.addresses.map(kernelAddress).join(', ') } : { type: 'allow' }
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
  if (rule.response.mode === 'custom' && rule.response.conditions.length) {
    const chain = responseChain(rule.response)
    const withLog = (level: LogLevel | null | undefined, acts: Record<string, unknown>[]) => (level ? [{ type: 'log', level }, ...acts] : acts)
    response = { response_matchers: chain.matchers, response_matcher_operator: chain.operator, response_actions_on_match: withLog(rule.response.thenLog, outcomeActions(model, rule.response.then)), response_actions_on_miss: withLog(rule.response.otherwiseLog, outcomeActions(model, rule.response.otherwise)) }
  } else if (rule.response.mode === 'inherit' && g) response = groupFallback(model, g) ?? {}
  return forwardPipeline(model, `rule-${rule.id}`, o.group, rule.ecs === 'inherit' ? (g?.ecs ?? null) : rule.ecs, response)
}
function kernelRules(model: Model, rule: Rule): KRule[] {
  if (rule.raw) return JSON.parse(JSON.stringify(rule.raw)) as KRule[]
  const pre = rule.log.enabled ? [{ type: 'log', level: rule.log.level }] : []
  const actions = [...pre, ...(ownsForward(rule) ? [{ type: 'jump_to_pipeline', pipeline: `rule-${rule.id}` }] : outcomeActions(model, rule.outcome))]
  const groups = rule.conditions.filter((g) => g.length)
  const chains = (groups.length ? groups : [[]]).flatMap((g) => andChains(g.flatMap(requestTerms), { type: 'any' }))
  // 没起名字的规则在内核里用编号当名字；面板自己的名字和备注另外保存，读回来时还是不带名字
  // An unnamed rule takes its id as the kernel name; the panel keeps its own names and notes separately, so it reads back unnamed
  const kname = rule.name.trim() || `rule-${rule.id}`
  return chains.map((chain, i) => ({ ...emptyRule(chains.length > 1 ? `${kname}#${i + 1}` : kname, actions), matchers: chain.matchers, matcher_operator: chain.operator }))
}

export const mappingIsIp = (r: Mapping) => splitList(r.target).every(isIp)
function mappingActions(r: Mapping): Record<string, unknown>[] {
  if (mappingIsIp(r)) return [{ type: 'static_ip_response', ip: splitList(r.target).join(',') }]
  return [{ type: 'static_cname_response', target: r.target.trim(), ...(r.ttl === null ? {} : { ttl: r.ttl }) }]
}
export function kernelRuleCount(rule: Rule): number {
  if (rule.raw) return rule.raw.length
  const groups = rule.conditions.filter((g) => g.length)
  return (groups.length ? groups : [[]]).reduce((n, g) => n + andChains(g.flatMap(requestTerms), { type: 'any' }).length, 0)
}

export function compile(model: Model): KernelConfig {
  const pipelines: KernelConfig['pipelines'] = []
  for (const g of model.groups) pipelines.push(forwardPipeline(model, upstreamPipelineId(model, g.id), g.id, g.ecs, groupFallback(model, g) ?? {}))
  // 域名映射和现在的面板一样做成最前面的入口：所有请求先过它，带监听标签直接进规则组的也一样
  // Domain mappings are the first entry, as in today's panel: every request meets them first, including those a listener sends straight to a rule group
  const live = model.mappings.filter((r) => r.enabled && r.domain.trim() && r.target.trim())
  const mappingId = model.mappingId ?? 'domain_mapping'
  if (live.length) pipelines.push({ id: mappingId, rules: live.map((r) => ({ ...emptyRule(`域名映射 ${r.domain.trim()}`, mappingActions(r)), matchers: [{ type: 'domain_suffix', value: r.domain.trim(), operator: 'and' }] })) })
  const main = [...model.rules.filter((r) => r.enabled).flatMap((r) => kernelRules(model, r)), emptyRule('其余请求', outcomeActions(model, model.rest))]
  pipelines.push({ ...model.mainExtra, id: mainPipelineId(model), rules: main })
  const select: KernelConfig['pipeline_select'] = live.length ? [{ pipeline: mappingId, matcher_operator: 'and', matchers: live.map((r, i) => ({ type: 'domain_suffix', value: r.domain.trim(), operator: i ? 'or' : 'and' })) }] : []
  // 入口顺序：域名映射、按监听标签进规则组、高级入口、主列表 / Entry order: domain mappings, listener labels into rule groups, advanced entries, the main list
  for (const rg of model.ruleGroups) {
    const id = ruleGroupPipelineId(model, rg.id)
    pipelines.push({ ...rg.extra, id, rules: [...rg.rules.filter((r) => r.enabled).flatMap((r) => kernelRules(model, r)), emptyRule(`${rg.name}·其余`, outcomeActions(model, rg.rest))] })
    if (rg.listener.trim()) select.push({ pipeline: id, matcher_operator: 'and', matchers: [{ type: 'listener_label', value: rg.listener.trim() }] })
  }
  select.push(...(model.entries ?? []).map((e) => JSON.parse(JSON.stringify({ matcher_operator: 'and', ...e })) as KernelConfig['pipeline_select'][number]))
  for (const p of model.rawPipelines ?? []) pipelines.push(JSON.parse(JSON.stringify(p)) as KPipeline)
  for (const r of [...model.rules, ...model.ruleGroups.flatMap((rg) => rg.rules)]) {
    const own = r.enabled ? rulePipeline(model, r) : null
    if (own) pipelines.push(own)
  }
  select.push({ pipeline: mainPipelineId(model), matcher_operator: 'and', matchers: [] })
  select.push(...(model.trailingEntries ?? []).map((e) => JSON.parse(JSON.stringify({ matcher_operator: 'and', ...e })) as KernelConfig['pipeline_select'][number]))
  // 内核的默认上游只在「放行」和没写上游的转发里用到；写成其余请求那个组的地址，两处说法一致
  // The kernel's default upstream is only used by allow and by a forward without upstream; it takes the catch-all group's addresses so both agree
  // 有高级规则或原样保留的 Pipeline 时不改：它们里面的「允许」还按原来的默认上游走 / Left alone when advanced rules or kept pipelines exist: their allow still means the original default
  const keepDefault = Boolean(model.rawPipelines?.length) || [...model.rules, ...model.ruleGroups.flatMap((g) => g.rules)].some((r) => r.raw)
  const restGroup = !keepDefault && model.rest.type === 'upstream' ? model.groups.find((g) => g.id === (model.rest as { group: string }).group) : undefined
  const settings = { ...model.settings, ...(restGroup?.addresses.length ? { default_upstream: restGroup.addresses.map(kernelAddress).join(', ') } : {}) }
  return { ...model.extra, version: model.format, settings, pipeline_select: select, pipelines }
}

// 编辑器里「生成的内核规则」：这条规则在内核里长什么样 / The editor's 生成的内核规则: what this rule becomes in the kernel
export function kernelPreview(model: Model, rule: Rule): { rules: unknown[]; pipeline: unknown } {
  return { rules: kernelRules(model, rule), pipeline: rulePipeline(model, rule) }
}
