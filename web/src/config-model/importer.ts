import { BLOCKLIST_PIPELINE, BLOCKLIST_RULE, mergedFileIn, ownMatcher, ownRuleText, parseOwnRules, TAG_ALLOW, TAG_ALLOW_IMPORTANT, TAG_BLOCK, TAG_BLOCK_IMPORTANT } from './blocklist'
import { effectiveOps, kernelKey, normalizeAddress, sameKernel, type KAction, type KConfigLike, type KMatcher, type KPipelineLike, type KRuleLike, type KSelectorLike } from './kernel'
import {
  blocklistEntries, blocklistKey, compileNamed, emptyBlocklists, FIELD, groupPipeline, isIp, kernelUpstream, mainPipelineId, mappingKernelDomain, mappingLive, mappingRule, POLLUTED_CIDRS,
  RESPONSE_FIELD, ruleGroupPipelineId, ruleKernel, settingsFromKernel, splitList,
  type Blocklists, type BlockResponse, type Condition, type Defaults, type Ecs, type FieldDef, type Mapping, type Model, type Outcome, type Protocol, type Remedy,
  type ResponseCondition, type ResponseHandling, type Rule, type RuleGroup, type UpstreamAddress, type UpstreamGroup, nextId as nextFreeId } from './model'

// 把任何一份内核配置读成模型，不丢东西：能放进规则、上游组、域名映射的就放进去，放不进的原样保留成高级规则 / 高级入口，
// 写回去和原来一样。每一处改动都记一条说明给用户看。依据的内核行为见 kernel.ts 顶上的出处。
// Reads any kernel config into the new model without losing anything: what fits rules, upstream groups and domain mappings goes
// there, and what does not is kept verbatim as advanced rules / entries that write back unchanged. Every change is reported to the
// user. The kernel behaviour relied on is cited at the top of kernel-sim.ts.

export interface ImportNote { level: 'info' | 'warn'; text: string }
export interface ImportResult { model: Model; notes: ImportNote[]; stats: { rules: number; raw: number; groups: number; mappings: number } }
// 读出来的规则、上游组、映射各来自内核里的哪一段：接回上一份时拿上一份编出来的样子和它比
// Where in the kernel each rule, upstream group and mapping read back came from: carrying the previous model over compares its compiled form with it
interface Origin {
  // 规则：列表里的几条内核规则（拆开的几段），和它自己的转发 Pipeline（rule-编号） / A rule: its kernel rules in the list (the split parts) and its own forward pipeline (rule-<id>)
  rules: Map<Rule, { rules: KRuleLike[]; pipeline: KPipelineLike | null }>
  groups: Map<UpstreamGroup, KPipelineLike>
  mappings: Map<Mapping, KRuleLike>
}

const RULE_KEYS = new Set(['name', 'matchers', 'matcher_operator', 'actions', 'response_matchers', 'response_matcher_operator', 'response_actions_on_match', 'response_actions_on_miss'])
const PIPELINE_KEYS = new Set(['id', 'rules', 'ecs'])
const TOP_KEYS = new Set(['version', 'settings', 'pipeline_select', 'pipelines', 'panel'])
const BLOCK_RCODES: Record<string, BlockResponse> = { NXDOMAIN: 'NXDOMAIN', REFUSED: 'REFUSED', SERVFAIL: 'SERVFAIL', NOERROR: 'NOERROR' }
const DEFAULT_BLOCKS = new Set<BlockResponse>(['NXDOMAIN', 'REFUSED', 'zero'])
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const isTrueChain = (ms: KMatcher[] | undefined) => !ms?.length || (ms.length === 1 && ms[0]!.type === 'any')
class Raw extends Error {}
const raw = (why: string): never => { throw new Raw(why) }

// ---------- 上游地址和子网 / addresses and subnets ----------
const PROTOCOLS = new Set(['udp', 'tcp', 'tcp_udp', 'doh', 'dot', 'doq'])
// tcp:// udp:// tcp+udp:// 读成「地址 + 协议」（新格式就是这样写出去的）；https:// tls:// quic:// 这类照原样留着，自动识别 /
// tcp:// udp:// tcp+udp:// read as address + protocol (how the new format writes them); https:// tls:// quic:// and the like stay as written, detected automatically
const PLAIN_PREFIX: Record<string, Protocol> = { 'tcp://': 'tcp', 'udp://': 'udp', 'tcp+udp://': 'tcp_udp', 'udp+tcp://': 'tcp_udp' }
function addressesOf(upstream: string, transport: unknown): UpstreamAddress[] {
  const t = typeof transport === 'string' && PROTOCOLS.has(transport) ? transport : 'udp'
  return splitList(upstream.replace(/,/g, ' ')).map((address): UpstreamAddress => {
    const prefix = Object.keys(PLAIN_PREFIX).find((p) => address.toLowerCase().startsWith(p))
    if (prefix) return { address: address.slice(prefix.length), protocol: PLAIN_PREFIX[prefix] === 'udp' ? 'auto' : PLAIN_PREFIX[prefix]! }
    return { address, protocol: address.includes('://') || t === 'udp' ? 'auto' : (t as Protocol) }
  })
}
// 按写进内核的样子比（没写端口的补上 53）：只写了 IP 的和带 :53 的是同一个上游 / Compared as written to the kernel (53 for a missing port): an IP
// alone and the same with :53 are one upstream
const addrKey = (addrs: UpstreamAddress[]) => addrs.map((a) => normalizeAddress(kernelUpstream(a))).sort().join('|')
function ecsOf(k: unknown): Ecs {
  if (k === undefined || k === null) return null
  const e = k as Record<string, unknown>
  if (e.mode === 'clear') return { mode: 'clear' }
  if (e.mode === 'from_client_ip') return { mode: 'client', v4: Number(e.prefix_v4 ?? 24), v6: Number(e.prefix_v6 ?? 56) }
  if (e.mode === 'static') return { mode: 'static', subnet: `${String(e.ip)}/${Number(e.prefix ?? 24)}` }
  return raw('ECS 写法认不出')
}
const ecsEq = (a: Ecs, b: Ecs) => JSON.stringify(a) === JSON.stringify(b)

// ---------- 条件：把内核的条件链展开成「或」的若干组「且」 / conditions: a kernel chain as an OR of AND groups ----------
interface Lit { m: KMatcher; neg: boolean }
// 第一项按肯定起头，之后 and / and_not 是乘，or / or_not 是并（kernel-sim.ts foldChain） / The first item seeds positive; and / and_not multiply, or / or_not union
function dnf(matchers: KMatcher[] | undefined, ruleOp: string | undefined): Lit[][] {
  if (!matchers?.length) return [[]]
  const ops = effectiveOps(matchers, ruleOp)
  const lit = (m: KMatcher, neg: boolean): Lit[][] => {
    const { operator: _op, ...bare } = m
    if (bare.type === 'any') return neg ? [] : [[]]
    return [[{ m: bare as KMatcher, neg }]]
  }
  let acc = lit(matchers[0]!, false)
  for (let i = 1; i < matchers.length; i++) {
    const op = ops[i]
    const l = lit(matchers[i]!, op === 'and_not' || op === 'not' || op === 'or_not')
    if (op === 'or' || op === 'or_not') acc = [...acc, ...l]
    else {
      const next: Lit[][] = []
      for (const a of acc) for (const b of l) next.push([...a, ...b])
      if (next.length > 128) raw('条件组合太多')
      acc = next
    }
  }
  // 去掉自相矛盾的组、重复的项和被包含的组 / drop contradictory groups, duplicate items and subsumed groups
  const key = (l: Lit) => `${l.neg ? '!' : ''}${JSON.stringify(l.m)}`
  let groups = acc.map((g) => [...new Map(g.map((l) => [key(l), l])).values()]).filter((g) => !g.some((l) => g.some((o) => o.neg !== l.neg && JSON.stringify(o.m) === JSON.stringify(l.m))))
  groups = groups.filter((g, i) => !groups.some((o, j) => j !== i && o.length <= g.length && o.every((l) => g.some((x) => key(x) === key(l))) && (o.length < g.length || j < i)))
  return groups
}

const values = (m: KMatcher, k: string) => String(m[k] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
const codesOf = (m: KMatcher) => (Array.isArray(m.country_codes) ? m.country_codes.map(String) : values(m, 'country_codes')).map((c) => c.toUpperCase())
let nextId = 100_000
const cid = () => nextId++
// 要填值的条件读出来是空的（内核里写的是空字符串）：面板编配置时会把空值去掉，「全部满足」就成了所有回答都算、规则的条件就成了所有请求都算，
// 所以放不进面板的写法，原样保留
// A condition that takes values reads back empty (the kernel holds an empty string): the panel drops blank values when compiling, so
// 「全部满足」 would count every answer and a rule's condition every request; it fits no panel field and is kept verbatim
function filled<C extends { field: string; values: string[] }>(c: C, fields: Record<string, FieldDef>): C {
  return fields[c.field]?.values && (!c.values.length || c.values.some((v) => !v.trim())) ? raw('条件的值是空的') : c
}
function requestCondition(l: Lit): Condition {
  return filled(requestConditionOf(l), FIELD)
}
function requestConditionOf(l: Lit): Condition {
  const { m, neg } = l
  const v = String(m.value ?? '')
  switch (m.type) {
    case 'domain_suffix': return { id: cid(), field: 'domain', negate: neg, regex: false, values: [v] }
    case 'domain_exact': return { id: cid(), field: 'domain', negate: neg, regex: false, exact: true, values: [v] }
    case 'domain_regex': return { id: cid(), field: 'domain', negate: neg, regex: true, values: [v] }
    case 'geo_site': return { id: cid(), field: 'geosite', negate: neg, values: [v] }
    case 'geo_site_not': return { id: cid(), field: 'geosite', negate: !neg, values: [v] }
    case 'client_ip': return { id: cid(), field: 'client_ip', negate: neg, values: values(m, 'cidr') }
    case 'geoip_country': return { id: cid(), field: 'client_country', negate: neg, values: codesOf(m) }
    case 'geoip_private': return { id: cid(), field: 'client_private', negate: Boolean(m.expect) === neg, values: [] }
    case 'edns_present': return { id: cid(), field: 'edns', negate: Boolean(m.expect) === neg, values: [] }
    case 'qtype': return { id: cid(), field: 'qtype', negate: neg, values: [v.toUpperCase()] }
    case 'qclass': return { id: cid(), field: 'qclass', negate: neg, values: [v.toUpperCase()] }
    default: return raw(`条件类型 ${m.type} 没有对应的写法`)
  }
}
function responseCondition(l: Lit): ResponseCondition {
  return filled(responseConditionOf(l), RESPONSE_FIELD)
}
function responseConditionOf(l: Lit): ResponseCondition {
  const { m, neg } = l
  const v = String(m.value ?? '')
  const c = (field: ResponseCondition['field'], vals: string[], extra: Partial<ResponseCondition> = {}): ResponseCondition => ({ id: cid(), field, negate: neg, values: vals, ...extra })
  switch (m.type) {
    case 'response_rcode': return c('rcode', [v.toUpperCase()])
    case 'response_type': return c('answer_type', [v.toUpperCase()])
    case 'upstream_equals': return c('upstream', [v])
    case 'response_qclass': return c('qclass', [v.toUpperCase()])
    case 'request_domain_suffix': return c('request_domain', [v])
    case 'request_domain_exact': return c('request_domain', [v], { exact: true })
    case 'request_domain_regex': return c('request_domain', [v], { regex: true })
    // 内核的写法是 _geo_site；以前面板（和高级规则的编辑器）写的 _geosite 内核不认，这样的配置从没生效过，读进来照样认，写回去换成内核的
    // The kernel's spelling is _geo_site; the _geosite the panel (and the advanced rule editor) used to write is unknown to the kernel, so such a
    // config never took effect: it still reads back, and writes back in the kernel's spelling
    case 'response_request_domain_geo_site':
    case 'response_request_domain_geosite': return c('request_geosite', [v])
    case 'response_request_domain_geo_site_not':
    case 'response_request_domain_geosite_not': return { ...c('request_geosite', [v]), negate: !neg }
    case 'response_txt_content': return c('txt', [v], { txtMode: (['exact', 'prefix', 'regex'].includes(String(m.mode)) ? m.mode : 'exact') as 'exact' | 'prefix' | 'regex' })
    case 'response_answer_ip': return c('answer_ip', values(m, 'cidr'))
    case 'response_upstream_ip': return c('upstream_ip', values(m, 'cidr'))
    case 'response_answer_ip_geoip_country': return c('answer_country', codesOf(m))
    case 'response_answer_ip_geoip_private': return { ...c('answer_private', []), negate: Boolean(m.expect) === neg }
    case 'response_edns_present': return { ...c('edns', []), negate: Boolean(m.expect) === neg }
    default: return raw(`回答条件类型 ${m.type} 没有对应的写法`)
  }
}
// 同一组里同一种「不是」并成一条（几个值都不是）；只差一个肯定条件的几组并成一组（几个值任一） /
// Within a group, negations of one kind merge (none of the values); groups differing in one positive condition merge (any of the values)
// 比法相同才并：字段、是不是、正则、就是，TXT 还有等于 / 开头是 / 正则（等于和开头是并成一个，写回去就都成了等于）
// Only one comparison merges: field, negation, regex, exact, and for TXT exact / prefix / regex too (merging exact into prefix wrote both back as exact)
type CondLike = { field: string; negate: boolean; regex?: boolean; exact?: boolean; txtMode?: string; values: string[] }
const condsKey = (c: Condition[][]) => c.map((g) => g.map(fullKey).sort().join('&')).sort().join('|')
const condKey = (c: Omit<CondLike, 'values'>) => `${c.field}|${c.negate}|${Boolean(c.regex)}|${Boolean(c.exact)}|${c.txtMode ?? ''}`
const fullKey = (c: CondLike) => `${condKey(c)}|${[...c.values].sort().join(',')}`
function mergeNegatives<C extends CondLike>(conds: C[]): C[] {
  const out: C[] = []
  for (const c of conds) {
    const same = c.negate && c.values.length ? out.find((o) => o.negate && o.values.length && condKey(o) === condKey(c)) : undefined
    if (same) same.values = [...new Set([...same.values, ...c.values])]
    else out.push({ ...c, values: [...c.values] })
  }
  return out
}
// 回答条件也用它：responseChain 把「全部满足」里那个多值条件写成「(a 或 b) 且 c」，展开就是只差这一个值的几组
// Answer conditions use it too: responseChain writes the multi-valued condition of 「全部满足」 as (a or b) and c, which expands to groups
// differing in that one value
function mergeGroups<C extends CondLike>(groups: C[][]): C[][] {
  let gs = groups.map((g) => mergeNegatives(g))
  for (let changed = true; changed;) {
    changed = false
    outer: for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) {
      const a = gs[i]!
      const b = gs[j]!
      if (a.length !== b.length) continue
      const ka = a.map(fullKey)
      const kb = b.map(fullKey)
      const onlyA = a.filter((_, n) => !kb.includes(ka[n]!))
      const onlyB = b.filter((_, n) => !ka.includes(kb[n]!))
      if (onlyA.length !== 1 || onlyB.length !== 1) continue
      const x = onlyA[0]!
      const y = onlyB[0]!
      // 不填值的（客户端网络、EDNS、回答 IP 的网络）没有几个值可并 / Fields without values (client network, EDNS, answer network) have no values to merge
      if (x.negate || y.negate || !x.values.length || condKey(x) !== condKey(y)) continue
      gs[i] = a.map((c) => (c === x ? { ...x, values: [...new Set([...x.values, ...y.values])] } : c))
      gs = gs.filter((_, n) => n !== j)
      changed = true
      break outer
    }
  }
  return gs
}

// ---------- 导入 / import ----------
export function importKernel(cfg: KConfigLike, prev?: Model): ImportResult {
  const notes: ImportNote[] = []
  const note = (text: string, level: ImportNote['level'] = 'info') => notes.push({ level, text })
  const origin: Origin = { rules: new Map(), groups: new Map(), mappings: new Map() }
  // 新规则的编号从上一份用过的编号之后开始：页面重开以后计数从头来，会和接回来的旧编号撞上（点一条开的是另一条）
  // New rules number from above every id the previous model used: after a page reload the counter starts over and would collide with carried-over ids
  // (clicking one rule opened another)
  if (prev) nextId = Math.max(nextId, nextFreeId(prev))
  // 两个 Pipeline 同名：内核的校验和热重载不收，启动时只记警告照样加载，入口和跳转按名字找到的是后一个（engine/types.rs pipeline_index），前一个的
  // 规则用不上。正在跑的配置可能就是这样：照内核读，后一个放在前一个的位置，前一个去掉，说一句。不然读出来的模型自己就编出两个同名的
  // Two pipelines of one name: the kernel's validation and reload refuse them, while startup only warns and loads them, entries and jumps then
  // finding the later one by name (engine/types.rs pipeline_index) and the earlier one's rules going unused. A running config may be so: read
  // as the kernel reads it, the later one takes the earlier one's place, the earlier one goes, and a note says so. Otherwise the model read
  // would compile to two of one name itself
  const pipelines: KPipelineLike[] = []
  const placed = new Map<string, number>()
  const shadowed = new Set<string>()
  for (const p of (cfg.pipelines ?? []) as KPipelineLike[]) {
    const at = placed.get(p.id)
    if (at === undefined) { placed.set(p.id, pipelines.length); pipelines.push(p); continue }
    pipelines[at] = p
    shadowed.add(p.id)
  }
  for (const id of shadowed) note(`有两个 Pipeline 都叫「${id}」，KixDNS 的入口和跳转只用后一个，前一个已去掉`, 'warn')
  const byId = new Map(pipelines.map((p) => [p.id, p]))
  const settings = clone(cfg.settings ?? {})
  const defaultUp = String(settings.default_upstream ?? '1.1.1.1:53')
  const selectors = cfg.pipeline_select ?? []
  const extra = Object.fromEntries(Object.entries(cfg).filter(([k]) => !TOP_KEYS.has(k)))

  // 谁引用了谁：入口、请求阶段跳转、回答阶段跳转 / Who references what: entries, request-phase jumps, answer-phase jumps
  const refs = new Map<string, { from: 'entry' | 'request' | 'response'; pipeline?: string; rule?: KRuleLike }[]>()
  const ref = (to: string, r: { from: 'entry' | 'request' | 'response'; pipeline?: string; rule?: KRuleLike }) => refs.set(to, [...(refs.get(to) ?? []), r])
  for (const s of selectors) ref(s.pipeline, { from: 'entry' })
  for (const p of pipelines) for (const r of p.rules ?? []) {
    for (const a of r.actions ?? []) if (a.type === 'jump_to_pipeline') ref(String(a.pipeline), { from: 'request', pipeline: p.id, rule: r })
    for (const a of [...(r.response_actions_on_match ?? []), ...(r.response_actions_on_miss ?? [])]) if (a.type === 'jump_to_pipeline') ref(String(a.pipeline), { from: 'response', pipeline: p.id, rule: r })
  }

  // 只有一条兜底转发的 Pipeline，就是一个上游组（回答处理是标准备用时连备用一起） /
  // A pipeline holding a single catch-all forward is an upstream group (with its fallback when the answer handling is the standard one)
  interface Fwd { addrs: UpstreamAddress[]; ecs: Ecs; rule: KRuleLike }
  const fwd = new Map<string, Fwd>()
  for (const p of pipelines) {
    const rules = p.rules ?? []
    const r = rules[0]
    if (rules.length !== 1 || !r || !isTrueChain(r.matchers) || Object.keys(r).some((k) => !RULE_KEYS.has(k)) || Object.keys(p).some((k) => !PIPELINE_KEYS.has(k))) continue
    const acts = r.actions ?? []
    if (acts.length !== 1) continue
    const a = acts[0]!
    try {
      if (a.type === 'allow') fwd.set(p.id, { addrs: addressesOf(defaultUp, 'udp'), ecs: null, rule: r })
      else if (a.type === 'forward') fwd.set(p.id, { addrs: addressesOf(typeof a.upstream === 'string' && a.upstream ? a.upstream : defaultUp, a.transport), ecs: ecsOf(a.ecs), rule: r })
    } catch { /* 认不出的 ECS：不当上游组 / unrecognized ECS: not a group */ }
  }
  type Fallback = { onError: boolean; onPolluted: boolean; target: string } | 'none' | null
  function fallbackOf(r: KRuleLike): Fallback {
    const onMatch = r.response_actions_on_match ?? []
    const onMiss = r.response_actions_on_miss ?? []
    if (!onMatch.length && !onMiss.length) return 'none'
    if (onMiss.length || onMatch.length !== 1 || onMatch[0]!.type !== 'jump_to_pipeline') return null
    const ms = r.response_matchers ?? []
    const ops = effectiveOps(ms, r.response_matcher_operator)
    if (!ms.length || ops.slice(1).some((o) => o !== 'or')) return null
    const rcodes = new Set<string>()
    const cidrs = new Set<string>()
    for (const m of ms) {
      if (m.type === 'response_rcode') rcodes.add(String(m.value).toUpperCase())
      else if (m.type === 'response_answer_ip') values(m, 'cidr').forEach((c) => cidrs.add(c))
      else return null
    }
    const onError = rcodes.size === 2 && rcodes.has('SERVFAIL') && rcodes.has('REFUSED')
    const onPolluted = cidrs.size === POLLUTED_CIDRS.length && POLLUTED_CIDRS.every((c) => cidrs.has(c))
    if ((rcodes.size && !onError) || (cidrs.size && !onPolluted)) return null
    return { onError, onPolluted, target: String(onMatch[0]!.pipeline) }
  }
  // 新格式里规则自带的转发 Pipeline（rule-编号）不当上游组，并回那条规则 / The new format's per-rule forward pipelines (rule-N) are not groups; they fold back into their rule
  // 一条规则拆成「名字#1、#2」时几条都跳到同一个 rule-编号 / A rule split into name#1, #2 jumps to the same rule-N from each part
  const soleReferrer = (id: string) => {
    const r = refs.get(id) ?? []
    return r.length > 0 && r.every((x) => x.from === 'request' && x.rule && x.rule.name.replace(/#\d+$/, '') === r[0]!.rule!.name.replace(/#\d+$/, ''))
  }
  const ownRulePipeline = (id: string) => /^rule-\d+$/.test(id) && soleReferrer(id)
  const groupIds = new Set([...fwd.keys()].filter((id) => fallbackOf(fwd.get(id)!.rule) !== null && !ownRulePipeline(id)))
  for (let changed = true; changed;) {
    changed = false
    for (const id of groupIds) {
      const f = fallbackOf(fwd.get(id)!.rule)
      if (f && f !== 'none' && (!groupIds.has(f.target) || f.target === id)) { groupIds.delete(id); changed = true }
    }
  }
  const groups: UpstreamGroup[] = []
  const usedGroupIds = new Set<string>()
  const pipelineIds = new Set(pipelines.map((p) => p.id))
  // 组的编号要没用过；编号定下的 Pipeline 名字（upstream-编号）也不能是配置里别的 Pipeline 的，own 是这个组自己读自的那个。两个 Pipeline 同名，
  // 内核的校验不收（比如 JSON 里把 upstream-x 改成了规则列表，里面的转发又按上一份认回组 x）
  // A group id must be unused, and the pipeline name it gives (upstream-<id>) must not be another pipeline's in the config, own being the one
  // this group was read from. Two pipelines of one name and the kernel's validation refuses the config (upstream-x turned into a rule list in
  // the JSON, say, with the forward inside matched back to the previous group x)
  const freeGroupId = (id: string, own?: string) => !usedGroupIds.has(id) && (!pipelineIds.has(`upstream-${id}`) || `upstream-${id}` === own)
  const slug = (base: string, own?: string) => {
    let id = base.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'group'
    for (let n = 2; !freeGroupId(id, own); n++) id = `${base}-${n}`
    usedGroupIds.add(id)
    return id
  }
  // 规则的编号也定下一个 Pipeline 名字：单独设了子网或回答检查的规则自己的转发叫 rule-编号。配置里已经有这个名字的 Pipeline 时跳过这个编号
  // A rule's id gives a pipeline name too: a rule with its own subnet or answer check has its own forward named rule-<id>. An id whose name a
  // pipeline in the config already has is skipped
  const ruleId = () => { let id = cid(); while (pipelineIds.has(`rule-${id}`)) id = cid(); return id }
  const hostLabel = (addrs: UpstreamAddress[]) => {
    const host = (a: UpstreamAddress) => a.address.replace(/^[a-z+]+:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '')
    return addrs.length > 1 ? `${host(addrs[0]!)} 等 ${addrs.length} 个` : host(addrs[0]!)
  }
  const uniqueName = (name: string) => { let n = name; for (let i = 2; groups.some((g) => g.name === n); i++) n = `${name}（${i}）`; return n }
  const groupOfPipeline = new Map<string, UpstreamGroup>()
  const prevGroupOf = (p: KPipelineLike) => prev?.groups.find((g) => (g.pipelineId ?? `upstream-${g.id}`) === p.id)
  // 认回上一份的组先占住编号，新组起编号时让开：两个组同编号，编出来就是两个同名的 Pipeline / Groups matched to the previous model hold their ids
  // first and new groups step aside: two groups of one id compile to two pipelines of one name
  for (const p of pipelines) { const g = groupIds.has(p.id) ? prevGroupOf(p) : undefined; if (g) usedGroupIds.add(g.id) }
  // 主列表编出来叫什么：接住所有请求的入口进的是规则列表时就是它，进的是上游组（只有一条转发，比如内核最简单的那种配置）时是 main。叫 main 的
  // 上游组不留原来的 Pipeline id：留着就和主列表同名，最新的内核校验时不收；以前的内核照收、只认后一个，主列表的「其余请求」转给自己，一个请求
  // 都解析不出来
  // What the main list compiles to: the catch-all entry's pipeline when it is a rule list, main when it is an upstream group (a single
  // forward, as in the kernel's simplest config). An upstream group called main does not keep that pipeline id: kept, it shares the main
  // list's name, which the latest kernel's validation refuses; earlier kernels took it, used the later one, and the main list's 其余请求
  // handed requests to itself so none resolved
  const catchEntry = selectors.find((s) => isTrueChain(s.matchers) && byId.has(s.pipeline))?.pipeline ?? pipelines[0]?.id
  const mainListId = catchEntry !== undefined && !groupIds.has(catchEntry) ? catchEntry : 'main'
  for (const p of pipelines) {
    if (!groupIds.has(p.id)) continue
    const f = fwd.get(p.id)!
    const keeps = p.id !== mainListId
    // 不留原来 id 的那个组照样认回上一份的编号和名字，只要编号定下的 upstream-编号 没被别的 Pipeline 占着 / The group not keeping its id still takes
    // the previous model's id and name, as long as the upstream-<id> that id names is not another pipeline's
    const prevG = [prevGroupOf(p)].find((x) => x && (keeps || !pipelineIds.has(`upstream-${x.id}`)))
    const id = prevG?.id ?? slug(p.id.startsWith('upstream-') ? p.id.slice(9) : p.id, keeps ? p.id : undefined)
    usedGroupIds.add(id)
    const g: UpstreamGroup = { id, name: uniqueName(prevG?.name ?? (p.id.startsWith('upstream-') ? p.id.slice(9) : p.id)), addresses: f.addrs, ecs: f.ecs, fallback: { group: '', onError: false, onPolluted: false } }
    if (keeps && p.id !== `upstream-${id}`) g.pipelineId = p.id
    groups.push(g)
    groupOfPipeline.set(p.id, g)
    origin.groups.set(g, p)
  }
  for (const p of pipelines) {
    const g = groupOfPipeline.get(p.id)
    const f = g ? fallbackOf(fwd.get(p.id)!.rule) : null
    if (g && f && f !== 'none') g.fallback = { group: groupOfPipeline.get(f.target)!.id, onError: f.onError, onPolluted: f.onPolluted }
  }
  const createdGroups: string[] = []
  // 从默认上游建出来的组单独记：说明里写它来自默认上游，不说「从规则里的转发地址」 / Groups built from the default upstream are kept apart, so the note says where they came from
  const fromDefault: string[] = []
  // 规则里直接写的转发：先找地址一样的组，子网不同就在规则上单独设，组有备用而规则没有就让规则「不检查」 /
  // A forward written in a rule: reuse a group with the same addresses, overriding the subnet on the rule when it differs and turning
  // the answer check off when the group has a fallback the rule did not
  function groupFor(addrs: UpstreamAddress[], ecs: Ecs, name?: string): { group: UpstreamGroup; ecs: Ecs | 'inherit'; off: boolean } {
    const k = addrKey(addrs)
    const plain = (g: UpstreamGroup) => !g.fallback.onError && !g.fallback.onPolluted
    const g = groups.find((x) => addrKey(x.addresses) === k && ecsEq(x.ecs, ecs) && plain(x))
      ?? groups.find((x) => addrKey(x.addresses) === k && plain(x))
      ?? groups.find((x) => addrKey(x.addresses) === k)
    if (g) return { group: g, ecs: ecsEq(g.ecs, ecs) ? 'inherit' : ecs, off: !plain(g) }
    const prevG = prev?.groups.find((x) => addrKey(x.addresses) === k)
    const created: UpstreamGroup = { id: prevG && freeGroupId(prevG.id) ? prevG.id : slug(name === '默认上游' ? 'default' : hostLabel(addrs).split(' ')[0]!), name: uniqueName(prevG?.name ?? name ?? hostLabel(addrs)), addresses: addrs, ecs, fallback: { group: '', onError: false, onPolluted: false } }
    usedGroupIds.add(created.id)
    groups.push(created)
    if (name === '默认上游') fromDefault.push(created.name)
    else createdGroups.push(created.name)
    return { group: created, ecs: 'inherit', off: false }
  }
  const defaultGroup = () => groupFor(addressesOf(defaultUp, 'udp'), null, '默认上游').group

  // ---------- 入口：先认出现在面板的域名映射 / entries: today's domain mappings first ----------
  const catchAt = selectors.findIndex((s) => isTrueChain(s.matchers) && byId.has(s.pipeline))
  // 排在接住所有请求的入口后面的入口永远轮不到；原样留在最后，写回去位置不变 / Entries after the catch-all never run; they stay verbatim at the end and write back in place
  const trailing: Model['entries'] = selectors.slice(catchAt >= 0 ? catchAt + 1 : selectors.length).map((s) => clone({ pipeline: s.pipeline, matchers: s.matchers ?? [], ...(s.matcher_operator ? { matcher_operator: s.matcher_operator } : {}) }))
  for (const s of trailing) note(`入口「${s.pipeline}」排在接住所有请求的入口后面，永远轮不到，原样保留在最后`)
  let pre = (catchAt >= 0 ? selectors.slice(0, catchAt) : selectors).filter((s) => {
    if (byId.has(s.pipeline)) return true
    note(`入口指向的「${s.pipeline}」不存在，内核会跳过它，已去掉`)
    return false
  })
  const mainSource = catchAt >= 0 ? selectors[catchAt]!.pipeline : pipelines[0]?.id
  // 最前面一个只有域名后缀的入口，进一个每条都是「域名 → 固定回答」的 Pipeline，两边域名一样 /
  // A leading entry of domain suffixes into a pipeline whose rules each answer one of the same domains
  const mappings: Mapping[] = []
  let mappingId: string | undefined
  const first = pre[0]
  if (first && first.pipeline !== mainSource) {
    const p = byId.get(first.pipeline)!
    const ops = effectiveOps(first.matchers ?? [], first.matcher_operator)
    const domains = (first.matchers ?? []).map((m) => (m.type === 'domain_suffix' ? String(m.value) : null))
    const rows = (p.rules ?? []).map((r) => {
      const a = r.actions ?? []
      const m = r.matchers ?? []
      if (m.length !== 1 || m[0]!.type !== 'domain_suffix' || a.length !== 1 || (r.response_actions_on_match ?? []).length || (r.response_actions_on_miss ?? []).length) return null
      const act = a[0]!
      if (act.type === 'static_cname_response') return { domain: String(m[0]!.value), target: String(act.target ?? ''), ttl: act.ttl === undefined ? null : Number(act.ttl) }
      if (act.type === 'static_ip_response' && splitList(String(act.ip)).every(isIp)) return { domain: String(m[0]!.value), target: splitList(String(act.ip)).join(', '), ttl: null }
      return null
    })
    const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))
    if (domains.every(Boolean) && ops.slice(1).every((o) => o === 'or') && rows.length && rows.every(Boolean) && (refs.get(p.id) ?? []).length === 1
      && sameSet(domains as string[], rows.map((r) => r!.domain))) {
      rows.forEach((r, i) => { const m: Mapping = { id: cid(), domain: r!.domain, target: r!.target, ttl: r!.ttl, enabled: true }; mappings.push(m); origin.mappings.set(m, p.rules![i]!) })
      if (p.id !== 'domain_mapping') mappingId = p.id
      pre = pre.slice(1)
    }
  }
  const mappingPipeline = mappings.length ? first!.pipeline : undefined

  // ---------- 拦截列表：域名映射后面、进只回拦截的 Pipeline 的那几个入口 / blocklists: the entries after the mappings into the pipeline that only blocks ----------
  let blocklists: Blocklists = emptyBlocklists()
  let blocklistPipeline: string | undefined
  // 一般叫 blocklist；和手改过的旧 Pipeline 重名时编出来的是 blocklist-2 这样的（见 compile） / Usually blocklist; when it clashed with an old
  // hand-edited pipeline, compile named it blocklist-2 and so on
  const blId = pre[0] && /^blocklist(?:-\d+)?$/.test(pre[0].pipeline) ? pre[0].pipeline : BLOCKLIST_PIPELINE
  const blp = byId.get(blId)
  const blRule = blp?.rules?.length === 1 ? blp.rules[0]! : undefined
  const blockAction = blRule?.actions?.length === 1 ? staticOutcome(blRule.actions[0]!) : null
  // 拦截列表回的就是「拦截时怎么回应」（compile 按默认写它），所以只认那三种回应 / The blocklists answer with 拦截时怎么回应 (compile writes the default
  // there), so only its three answers are recognised
  const blockDefault = blockAction?.type === 'block' && DEFAULT_BLOCKS.has(blockAction.response) ? blockAction.response as Defaults['block'] : undefined
  if (blRule && blRule.name === BLOCKLIST_RULE && isTrueChain(blRule.matchers) && blockDefault && Object.keys(blRule).every((k) => RULE_KEYS.has(k))
    && !(blRule.response_actions_on_match ?? []).length && !(blRule.response_actions_on_miss ?? []).length
    && Object.keys(blp!).every((k) => k === 'id' || k === 'rules') && (refs.get(blId) ?? []).every((r) => r.from === 'entry')) {
    const count = pre.findIndex((e) => e.pipeline !== blId)
    const leading = count < 0 ? pre : pre.slice(0, count)
    const found = readBlocklistEntries(leading, settings, prev)
    if (found && leading.length === (refs.get(blId) ?? []).length) {
      blocklists = found.blocklists
      blocklistPipeline = blId
      pre = pre.slice(leading.length)
      // 合成的文件从 settings 里去掉由 settingsFromKernel 做（见最后） / Taking the merged file out of settings is settingsFromKernel's job (see the end)
      if (found.file && !prev) note('配置里用着一个拦截列表文件，但没记下是哪些列表合成的；在「拦截列表」重新订阅以后才能更新它', 'warn')
    }
  }
  // 拦截列表的入口在 JSON 里改过、认不出来：照原样读成别的，说一句，不让拦截列表页像是什么都没开
  // The blocklist entries were edited in the JSON and cannot be recognised: they are read as something else, and a note says so, so the
  // blocklist page does not look as if nothing were on
  if (!blocklistPipeline && blp && blRule?.name === BLOCKLIST_RULE) note('拦截列表的入口在面板外改过，认不出来，已原样读成规则列表最前面的几条；要回到「拦截列表」里管理，先删掉这几条，再重新订阅', 'warn')
  // 上一份的拦截列表没写出入口（都关着、自己写的规则一条也用不上）时，内核里没有它的痕迹：原样接回来
  // When the previous blocklists wrote no entry (all switched off, no rule of one's own in use) the kernel holds no trace of them: they come back as they were
  if (!blocklistPipeline && prev && !blocklistEntries(prev).length) blocklists = { ...clone(prev.blocklists), file: null }

  // 只被一条规则跳过去、回答处理又不是标准备用的转发 Pipeline（比如新格式里单独设了子网的规则），并回那条规则 /
  // A forward pipeline that only one rule jumps to and whose answer handling is not a standard fallback (like a new-format rule with its own subnet) folds back into that rule
  const inline = new Set([...fwd.keys()].filter((id) => !groupIds.has(id) && id !== mainSource && soleReferrer(id)))
  const consumed = new Map<string, string>()
  const isList = (id: string) => byId.has(id) && !groupIds.has(id) && id !== mappingPipeline && id !== blocklistPipeline && !inline.has(id)

  // ---------- 入口怎么落：原样保留 / 变成主列表最前面的规则 ----------
  // ---------- how entries land: kept verbatim / rules at the top of the main list ----------
  // 内核按顺序看入口：最后一个必须原样保留的入口（带监听标签，或条件认不出）之前的都原样保留成高级入口，之后的变成规则，排在主列表最前面
  // （它们本来就在主列表之前被看到）。监听标签是 KixDNS 启动参数给整个进程的一个标签，不是每个监听各一个，所以不放到规则组上
  // The kernel reads entries in order: everything up to the last entry that must stay verbatim (a listener label, or conditions not
  // recognised) stays as an advanced entry, and the entries after it become rules at the head of the main list (they were seen before
  // the main list anyway). A listener label is one label for the whole process from KixDNS's startup flags, not one per listener, so it
  // does not go on rule groups
  const later = pre
  const entryConditions = (s: { matchers?: KMatcher[]; matcher_operator?: string }): Condition[][] | null => {
    try { return mergeGroups(dnf(s.matchers, s.matcher_operator).map((g) => g.map(requestCondition))) } catch (e) { if (e instanceof Raw) return null; throw e }
  }
  const mustStay = (s: (typeof later)[number], i: number) => (s.matchers ?? []).some((m) => m.type === 'listener_label') || entryConditions(s) === null || (s.pipeline === mainSource && i < later.length - 1)
  let lastStay = -1
  later.forEach((s, i) => { if (mustStay(s, i)) lastStay = i })
  const kept = later.slice(0, lastStay + 1)
  const asRules = later.slice(lastStay + 1).filter((s) => s.pipeline !== mainSource)
  const entries: Model['entries'] = kept.length ? kept.map((s) => clone({ pipeline: s.pipeline, matchers: s.matchers ?? [], ...(s.matcher_operator ? { matcher_operator: s.matcher_operator } : {}) })) : undefined
  if (kept.length) note(`有 ${kept.length} 个入口带着监听标签或认不出的条件，排在其他入口前面，原样保留成高级入口`, 'warn')
  // 只被一个入口用到的 Pipeline 展开进主列表，不另立规则组 / A pipeline used by only one entry unfolds into the main list instead of becoming a rule group
  const unfold = new Set(asRules.map((s) => s.pipeline).filter((id) => isList(id) && (refs.get(id) ?? []).length === 1))

  // ---------- 规则组 / rule groups ----------
  const ruleGroups: RuleGroup[] = []
  const ruleGroupOf = new Map<string, RuleGroup>()
  function makeRuleGroup(id: string): RuleGroup {
    const p = byId.get(id)!
    const prevRg = prev?.ruleGroups.find((g) => (g.pipelineId ?? `group-${g.id}`) === id)
    let gid = prevRg?.id ?? (id.startsWith('group-') ? id.slice(6) : id)
    while (ruleGroups.some((g) => g.id === gid)) gid = `${gid}-2`
    const rg: RuleGroup = { id: gid, name: prevRg?.name ?? gid, note: prevRg?.note ?? '', rules: [], rest: { type: 'continue' } }
    if (id !== `group-${gid}`) rg.pipelineId = id
    const ex = Object.fromEntries(Object.entries(p).filter(([k]) => !PIPELINE_KEYS.has(k)))
    if (Object.keys(ex).length) rg.extra = ex
    ruleGroups.push(rg)
    ruleGroupOf.set(id, rg)
    return rg
  }
  for (const p of pipelines) if (isList(p.id) && p.id !== mainSource && !unfold.has(p.id)) makeRuleGroup(p.id)

  // ---------- 规则 / rules ----------
  let rawCount = 0
  const rawPipelines: Record<string, unknown>[] = []
  function remedyOf(actions: KAction[]): { remedy: Remedy; log: Rule['log']['level'] | null } {
    const logs = actions.filter((a) => a.type === 'log')
    const rest = actions.filter((a) => a.type !== 'log')
    const firstReal = actions.findIndex((a) => a.type !== 'log')
    if (rest.length > 1 || (firstReal >= 0 && actions.slice(firstReal).some((a) => a.type === 'log'))) return raw('回答后检查里有几个动作')
    const log = logs.length ? ((typeof logs[0]!.level === 'string' ? logs[0]!.level : 'info') as Rule['log']['level']) : null
    if (!rest.length) return { remedy: { type: 'none' }, log }
    const a = rest[0]!
    const done = (remedy: Remedy) => ({ remedy, log })
    switch (a.type) {
      case 'allow': return done({ type: 'none' })
      case 'jump_to_pipeline': {
        const t = String(a.pipeline)
        if (groupOfPipeline.has(t)) return done({ type: 'upstream', group: groupOfPipeline.get(t)!.id })
        if (ruleGroupOf.has(t)) return done({ type: 'group', group: ruleGroupOf.get(t)!.id })
        return raw(`回答后转到的「${t}」不是上游组也不是规则组`)
      }
      case 'forward': {
        if (typeof a.upstream !== 'string' || !a.upstream) return raw('回答后的转发没写地址')
        const r = groupFor(addressesOf(a.upstream, a.transport), null)
        if (r.ecs !== 'inherit' || r.off) return raw('回答后的转发和现有的组设置不同')
        return done({ type: 'upstream', group: r.group.id })
      }
      case 'replace_txt_response': {
        const text = Array.isArray(a.text) ? a.text : [a.text]
        return text.length === 1 ? done({ type: 'rewrite_txt', value: String(text[0]) }) : raw('替换成几段 TXT')
      }
      default: return done(staticOutcome(a) ?? raw(`回答后检查里的动作 ${a.type} 没有对应的写法`))
    }
  }
  function staticOutcome(a: KAction): Outcome | null {
    if (a.type === 'deny') return { type: 'block', response: 'REFUSED' }
    if (a.type === 'static_response') { const r = BLOCK_RCODES[String(a.rcode).toUpperCase()]; return r ? { type: 'block', response: r } : null }
    if (a.type === 'static_ip_response') {
      const ips = splitList(String(a.ip))
      if (!ips.length || !ips.every(isIp)) return null
      if (ips.length === 2 && ips.includes('0.0.0.0') && ips.includes('::')) return { type: 'block', response: 'zero' }
      return { type: 'answer', kind: 'ip', value: ips.join(', '), ttl: null }
    }
    if (a.type === 'static_cname_response') return String(a.target ?? '').trim() ? { type: 'answer', kind: 'cname', value: String(a.target).trim(), ttl: a.ttl === undefined ? null : Number(a.ttl) } : null
    if (a.type === 'static_txt_response') { const t = Array.isArray(a.text) ? a.text : [a.text]; return t.length === 1 ? { type: 'answer', kind: 'txt', value: String(t[0]), ttl: a.ttl === undefined ? null : Number(a.ttl) } : null }
    return null
  }
  function responseOf(r: KRuleLike): ResponseHandling | null {
    const onMatch = r.response_actions_on_match ?? []
    const onMiss = r.response_actions_on_miss ?? []
    if (!onMatch.length && !onMiss.length) return null
    if (!(r.response_matchers ?? []).length) return raw('回答后检查没有条件')
    const groupsL = dnf(r.response_matchers, r.response_matcher_operator)
    if (!groupsL.length) return raw('回答条件永远不成立')
    let match: 'all' | 'any'
    let conds: ResponseCondition[]
    if (groupsL.length === 1) { match = 'all'; conds = mergeNegatives(groupsL[0]!.map(responseCondition)) }
    else if (groupsL.every((g) => g.length === 1)) {
      match = 'any'
      conds = []
      for (const c of groupsL.map((g) => responseCondition(g[0]!))) {
        const same = !c.negate && c.values.length ? conds.find((o) => !o.negate && o.values.length && condKey(o) === condKey(c)) : undefined
        if (same) same.values = [...new Set([...same.values, ...c.values])]
        else conds.push(c)
      }
    } else {
      // 「全部满足」里一个条件填几个值：responseChain 写成「(a 或 b) 且 c」，展开是只差这一个值的几组，并回一个多值条件（和请求条件的 mergeGroups 一样）
      // 「全部满足」 with one multi-valued condition: responseChain writes (a or b) and c, which expands to groups differing in that one value, merged
      // back into one multi-valued condition (as mergeGroups does for request conditions)
      // 并出来的总是编辑器认的（responseShapeProblem）：一条链从左往右结合，「或」只能把一个匹配器添成新的一组，后面的「且」乘到每一组上，
      // 只差一个值的几组只能来自连着的几个「或」，所以并出来最多一个多值条件；「满足任一」里「不是」从不并
      // What merges is always what the editor accepts (responseShapeProblem): a chain folds left to right, an or adds one matcher as a new
      // group and each later and multiplies onto every group, so groups differing in one value can only come from consecutive ors and the
      // merge yields at most one multi-valued condition; under 「满足任一」 a 不是 is never merged
      const merged = mergeGroups(groupsL.map((g) => g.map(responseCondition)))
      if (merged.length !== 1) return raw('回答条件既有「且」又有「或」')
      match = 'all'
      conds = merged[0]!
    }
    const then = remedyOf(onMatch)
    const otherwise = remedyOf(onMiss)
    return { mode: 'custom', match, conditions: conds, then: then.remedy, otherwise: otherwise.remedy, thenLog: then.log, otherwiseLog: otherwise.log }
  }
  const base = (name: string) => name.replace(/#\d+$/, '')
  function convertRule(kr: KRuleLike, where: string): Rule {
    // 面板给没起名字的规则编的内核名（rule-编号）读回来时还原成不带名字 / The kernel name the panel made up for an unnamed rule (rule-<id>) reads back as no name
    const rule: Rule = { id: ruleId(), name: /^rule-\d+$/.test(base(kr.name)) ? '' : base(kr.name), note: '', enabled: true, conditions: [[]], outcome: { type: 'continue' }, log: { enabled: false, level: 'info' }, ecs: 'inherit', response: { mode: 'inherit', match: 'any', conditions: [], then: { type: 'none' }, otherwise: { type: 'none' } }, edited: '导入' }
    try {
      if (Object.keys(kr).some((k) => !RULE_KEYS.has(k))) raw('规则里有认不出的字段')
      rule.conditions = mergeGroups(dnf(kr.matchers, kr.matcher_operator).map((g) => g.map(requestCondition)))
      if (!rule.conditions.length) raw('条件永远不成立')
      const actions = kr.actions ?? []
      const hasResponse = (kr.response_actions_on_match ?? []).length + (kr.response_actions_on_miss ?? []).length > 0
      const forwards = actions.filter((a) => a.type === 'forward')
      let forwardedHere = false
      let own: KPipelineLike | null = null
      const setForward = (addrs: UpstreamAddress[], ecs: Ecs, from: KRuleLike) => {
        const g = groupFor(addrs, ecs)
        rule.outcome = { type: 'upstream', group: g.group.id }
        rule.ecs = g.ecs
        // 回答处理正好是这个组的备用：就是「沿用上游组」 / An answer check that is exactly the group's fallback is 沿用上游组
        const f = fallbackOf(from)
        const gf = g.group.fallback
        if (f && f !== 'none' && groupOfPipeline.get(f.target)?.id === gf.group && f.onError === gf.onError && f.onPolluted === gf.onPolluted) { rule.response = { ...rule.response, mode: 'inherit' }; return }
        const resp = responseOf(from)
        rule.response = resp ?? { ...rule.response, mode: g.off ? 'off' : 'inherit' }
      }
      // 几个转发的规则内核加载时会合并（不带子网、不执行其他动作）：不替用户整理，原样保留 / A rule with several forwards is merged by the kernel at load (no subnet, no other actions); it is kept verbatim rather than tidied
      if (forwards.length > 1) raw(`一条规则里有 ${forwards.length}\u00a0个转发`)
      let decided = false
      for (const [i, a] of actions.entries()) {
        if (a.type === 'log') { if (!rule.log.enabled) rule.log = { enabled: true, level: (typeof a.level === 'string' ? a.level : 'info') as Rule['log']['level'] }; continue }
        const dead = actions.length - i - 1
        if (a.type === 'continue' || a.type === 'replace_txt_response') rule.outcome = { type: 'continue' }
        else if (a.type === 'forward') { setForward(addressesOf(typeof a.upstream === 'string' && a.upstream ? a.upstream : defaultUp, a.transport), ecsOf(a.ecs), kr); forwardedHere = true }
        else if (a.type === 'allow') rule.outcome = { type: 'upstream', group: defaultGroup().id }
        else if (a.type === 'jump_to_pipeline') {
          const t = String(a.pipeline)
          if (groupOfPipeline.has(t)) rule.outcome = { type: 'upstream', group: groupOfPipeline.get(t)!.id }
          else if (inline.has(t) && (consumed.get(t) ?? rule.name) === rule.name) { const f = fwd.get(t)!; setForward(f.addrs, f.ecs, f.rule); consumed.set(t, rule.name); own = byId.get(t)! }
          else if (ruleGroupOf.has(t)) rule.outcome = { type: 'group', group: ruleGroupOf.get(t)!.id }
          else raw(t === mainSource ? '跳回主列表' : `跳到不存在的「${t}」`)
        } else rule.outcome = staticOutcome(a) ?? raw(`动作 ${a.type} 没有对应的写法`)
        if (a.type === 'replace_txt_response') note(`「${base(kr.name)}」在请求时就替换 TXT，内核当作「继续往下一条」处理，已这样显示`)
        if (dead) raw(`决定结果的动作后面还有 ${dead}\u00a0个动作`)
        decided = true
        break
      }
      if (!decided) rule.outcome = { type: 'continue' }
      if (hasResponse && !forwardedHere) raw('回答后检查挂在不直接转发的规则上')
      origin.rules.set(rule, { rules: [kr], pipeline: own })
      return rule
    } catch (e) {
      if (!(e instanceof Raw)) throw e
      rawCount++
      note(`「${base(kr.name)}」${where}放不进面板的写法（${e.message}），原样保留为高级规则`, 'warn')
      const kept: Rule = { ...rule, conditions: [[]], outcome: { type: 'continue' }, response: { ...rule.response, mode: 'inherit' }, ecs: 'inherit', raw: [clone(kr) as unknown as Record<string, unknown>] }
      // 高级规则也记下来：认改名靠位置，少了它后面的都错一位。它跳去的自己那个转发（只有它跳去、原样保留着）也记下：接回上一份时编出来要比的
      // 就是这两样，编号定下的 rule-编号 也是它的，不算别人的
      // Advanced rules are recorded too: renames are found by position, and leaving them out would shift every rule after them by one. The own
      // forward it jumps to (only it does, kept verbatim) is recorded as well: carrying the previous model over compares both, and the
      // rule-<id> its id names is its own, not another's
      const ownJump = (kr.actions ?? []).find((a) => a.type === 'jump_to_pipeline' && inline.has(String(a.pipeline)) && !consumed.has(String(a.pipeline)))
      origin.rules.set(kept, { rules: [kr], pipeline: ownJump ? byId.get(String(ownJump.pipeline)) ?? null : null })
      return kept
    }
  }
  const sameBehaviour = (a: Rule, b: Rule) => JSON.stringify([a.outcome, a.log, a.ecs, { ...a.response, conditions: a.response.conditions.map(fullKey) }]) === JSON.stringify([b.outcome, b.log, b.ecs, { ...b.response, conditions: b.response.conditions.map(fullKey) }])
  const isAll = (c: Condition[][]) => c.length === 1 && !c[0]!.length
  function convertList(krs: KRuleLike[], where: string): { rules: Rule[]; rest: Outcome; popped: string | null } {
    const rules: Rule[] = []
    // 认段靠内核里的名字（不带 #N），不靠面板的名字：没起名字的规则面板名字都是空的，两条相邻的会被误合成一条
    // Pieces are matched by their kernel name (without #N), not the panel name: unnamed rules all have an empty panel name, so two
    // neighbours would be merged by mistake
    let lastKernel: string | null = null
    for (const kr of krs) {
      const r = convertRule(kr, where)
      const last = rules.at(-1)
      // 新格式把一条规则拆成「名字#1、#2」写进内核，读回来合成一条 / The new format splits one rule into name#1, #2; read back as one
      if (last && !last.raw && !r.raw && /#\d+$/.test(kr.name) && lastKernel === base(kr.name) && sameBehaviour(last, r)) {
        last.conditions = mergeGroups([...last.conditions, ...r.conditions])
        origin.rules.get(last)?.rules.push(kr)
      } else rules.push(r)
      lastKernel = base(kr.name)
    }
    const last = rules.at(-1)
    if (last && !last.raw && isAll(last.conditions) && (last.outcome.type === 'upstream' || last.outcome.type === 'block')
      && !last.log.enabled && last.ecs === 'inherit' && last.response.mode === 'inherit') {
      rules.pop()
      return { rules, rest: last.outcome, popped: last.name }
    }
    return { rules, rest: { type: 'upstream', group: defaultGroup().id }, popped: null }
  }
  // 两组条件「且」起来 / AND two condition sets
  const andConds = (a: Condition[][], b: Condition[][]) => mergeGroups(a.flatMap((x) => b.map((y) => {
    const seen = new Set<string>()
    return [...x, ...y].filter((c) => { const k = fullKey(c); if (seen.has(k)) return false; seen.add(k); return true }).map((c) => ({ ...c, id: cid() }))
  })))

  // 入口变成的规则 / rules made from entries
  const entryRules: Rule[] = []
  for (const s of asRules) {
    const when = entryConditions(s)!
    const t = s.pipeline
    const plain = (outcome: Outcome): Rule => ({ id: ruleId(), name: t, note: '', enabled: true, conditions: when, outcome, log: { enabled: false, level: 'info' }, ecs: 'inherit', response: { mode: 'inherit', match: 'any', conditions: [], then: { type: 'none' }, otherwise: { type: 'none' } }, edited: '导入' })
    if (groupOfPipeline.has(t)) { entryRules.push(plain({ type: 'upstream', group: groupOfPipeline.get(t)!.id })); continue }
    if (unfold.has(t)) {
      // 先试着展开；里面有放不进的规则就把这次试的痕迹全撤掉，退回成规则组 / Try unfolding; if something inside does not fit, undo every trace of the attempt and fall back to a rule group
      const snap = { notes: notes.length, raw: rawCount, groups: groups.length, created: createdGroups.length, ids: new Set(usedGroupIds), consumed: new Map(consumed) }
      const list = convertList(byId.get(t)!.rules ?? [], '')
      if (!list.rules.some((r) => r.raw)) {
        for (const r of list.rules) entryRules.push({ ...r, conditions: andConds(when, r.conditions) })
        const lastR = list.rules.at(-1)
        const covered = !list.popped && lastR && lastR.outcome.type !== 'continue' && condsKey(andConds(when, lastR.conditions)) === condsKey(when)
        // 被弹出来当「其余」的那条兜底规则放回来，名字照旧（命中统计按名字算） / The catch-all popped as 其余 comes back under its own name (hit counts go by name)
        if (!covered) entryRules.push({ ...plain(list.rest), name: list.popped ?? `${t}·其余` })
        continue
      }
      notes.length = snap.notes
      rawCount = snap.raw
      groups.length = snap.groups
      createdGroups.length = snap.created
      usedGroupIds.clear(); snap.ids.forEach((x) => usedGroupIds.add(x))
      consumed.clear(); snap.consumed.forEach((v, k) => consumed.set(k, v))
      makeRuleGroup(t)
    }
    entryRules.push(plain({ type: 'group', group: ruleGroupOf.get(t)!.id }))
  }

  const mainP = mainSource ? byId.get(mainSource) : undefined
  let mainId: string | undefined
  let mainExtra: Record<string, unknown> | undefined
  let main: { rules: Rule[]; rest: Outcome }
  if (mainP && groupOfPipeline.has(mainP.id)) main = { rules: [], rest: { type: 'upstream', group: groupOfPipeline.get(mainP.id)!.id } }
  else if (mainP) {
    main = convertList(mainP.rules ?? [], '')
    if (mainP.id !== 'main') mainId = mainP.id
    const ex = Object.fromEntries(Object.entries(mainP).filter(([k]) => !PIPELINE_KEYS.has(k)))
    if (Object.keys(ex).length) mainExtra = ex
  } else main = { rules: [], rest: { type: 'upstream', group: defaultGroup().id } }
  main.rules = [...entryRules, ...main.rules]
  for (const rg of ruleGroups) {
    const p = byId.get(rg.pipelineId ?? `group-${rg.id}`)!
    const list = convertList(p.rules ?? [], `（规则组「${rg.name}」）`)
    rg.rules = list.rules
    rg.rest = list.rest
    if (!(refs.get(p.id) ?? []).length) note(`规则组「${rg.name}」没有规则转到它，也没有入口指向它，内核用不到它；先保留着`)
  }
  for (const id of inline) if (!consumed.has(id)) rawPipelines.push(clone(byId.get(id)!) as unknown as Record<string, unknown>)

  // 只因为放不进而建出来、最后没人用的组去掉 / Drop groups created along the way that nothing ended up using
  const allRules = [...main.rules, ...ruleGroups.flatMap((g) => g.rules)]
  const used = new Set<string>()
  const useOutcome = (o: Outcome | Remedy) => { if (o.type === 'upstream') used.add(o.group) }
  useOutcome(main.rest)
  for (const rg of ruleGroups) useOutcome(rg.rest)
  for (const r of allRules) { useOutcome(r.outcome); useOutcome(r.response.then); useOutcome(r.response.otherwise) }
  for (const g of groups) if (g.fallback.group) used.add(g.fallback.group)
  const finalGroups = groups.filter((g) => used.has(g.id) || groupIds.has(g.pipelineId ?? `upstream-${g.id}`))
  const createdUsed = createdGroups.filter((name) => finalGroups.some((g) => g.name === name))
  const defaultUsed = fromDefault.filter((name) => finalGroups.some((g) => g.name === name))

  const geoPrefixed = allRules.flatMap((r) => r.conditions.flat()).filter((c) => c.field === 'geosite' && c.values.some((v) => /^geosite:/i.test(v))).length
  if (geoPrefixed) note(`有 ${geoPrefixed} 个 GeoSite 条件多写了「geosite:」前缀，内核找不到对应的分类，永远不会命中；关掉说明后在页面上方一键去掉`, 'warn')
  if (createdUsed.length) note(`从规则里的转发地址整理出上游组：${createdUsed.join('、')}，名字可以改`)
  for (const name of defaultUsed) note(settings.default_upstream === undefined ? `配置里没写默认上游，按 KixDNS 的默认 ${defaultUp} 建了上游组「${name}」` : `其余请求原来交给默认上游 ${defaultUp}，整理成了上游组「${name}」`)

  let model: Model = {
    format: String(cfg.version ?? '1.0'),
    settings,
    groups: finalGroups,
    rules: main.rules,
    ruleGroups,
    mappings,
    rest: main.rest,
    // 认出了拦截列表就照它回的读：没有上一份时（导入文件）不再变回 NXDOMAIN，JSON 里改了它的回应也照改的读
    // With the blocklists recognised, their answer is read: without a previous model (a file import) it no longer falls back to NXDOMAIN, and
    // an answer changed in the JSON reads as changed
    defaults: blocklistPipeline && blockDefault ? { block: blockDefault } : prev?.defaults ?? { block: 'NXDOMAIN' },
    blocklists,
    ...(mainId ? { mainId } : {}),
    ...(mappingId ? { mappingId } : {}),
    ...(mainExtra ? { mainExtra } : {}),
    ...(entries ? { entries } : {}),
    ...(trailing.length ? { trailingEntries: trailing } : {}),
    ...(rawPipelines.length ? { rawPipelines } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  }
  if (prev) model = carryOver(model, prev, origin, pipelineIds)
  // compile 自己加进 settings 的（按其余请求写的默认上游、拦截列表合成的文件）不收进模型 / What compile adds to settings itself (the default
  // upstream written from 其余请求, the blocklists' merged file) is not taken into the model
  model.settings = settingsFromKernel(model, settings, prev?.settings ?? {})
  return { model, notes, stats: { rules: allRules.length, raw: rawCount, groups: finalGroups.length, mappings: mappings.length } }
}

// 规则引用的组在这份模型里都在：不在的组编出来的 Pipeline 名字也可能碰巧和内核里的一样 / Every group the rule refers to is in this model: a missing
// one can compile to the same pipeline name by chance
function refersHere(m: Model, r: Rule): boolean {
  const used = [r.outcome, ...(r.response.mode === 'custom' ? [r.response.then, r.response.otherwise] : [])]
  return used.every((o) => (o.type === 'upstream' ? m.groups.some((g) => g.id === o.group) : o.type !== 'group' || m.ruleGroups.some((g) => g.id === o.group)))
}

// 内核里没有的东西从上一份接回来：规则的编号、备注、停用的规则和映射。规则、上游组、映射放进这份模型编出来和它读自的那段内核配置一样时，
// 整个留上一份：一种内核写法导入时只能读成一种样子，面板里却有好几种写法编出来一样（「拦截 · 沿用默认」和具体的响应码，「不检查」和没有备用的
// 组上的「沿用」……），换成另一种意思就变了（以后改默认、改组的备用和子网时跟不跟着变）
// What the kernel does not hold comes from the previous model: rule ids, notes, disabled rules and mappings. A rule, upstream group or mapping
// that, placed in this model, compiles to the kernel part it was read from stays the previous model's object entirely: the import can read a
// kernel form one way only, while several panel forms compile alike (拦截 · 沿用默认 and the concrete code, 不检查 and 沿用 on a group without
// fallback…), and swapping one for another changes the meaning (whether it follows a later change of the default, the group's fallback or subnet)
function carryOver(model: Model, prev: Model, origin: Origin, pipelineIds: ReadonlySet<string>): Model {
  // 上游组先换：规则自己的转发里写着组的地址和备用 / Groups first: a rule's own forward holds its group's addresses and fallback
  model.groups.forEach((g, i) => {
    const p = prev.groups.find((x) => x.id === g.id)
    const from = origin.groups.get(g)
    if (!p || !from) return
    model.groups[i] = clone(p)
    // Pipeline id 也要一样：叫 main 的上游组这回不留原来的 id（见上面 mainListId），上一份里留着的不接回来 / The pipeline id must agree too: an
    // upstream group called main no longer keeps that id (see mainListId above), so the previous model's kept one does not come back
    if (!sameKernel(groupPipeline(model, model.groups[i]!), from) || p.pipelineId !== g.pipelineId) model.groups[i] = g
  })
  // 「拦截 · 沿用默认」写进内核就是具体的响应码，读回来按上一份认回「沿用默认」。比的是这份模型的默认（JSON 里改了拦截列表的回应时默认跟着变）：
  // 换成沿用默认以后编出来要和内核里一样
  // 拦截 · 沿用默认 reaches the kernel as a concrete code; the previous model restores it. This model's default is the one compared (it moves
  // when the JSON changed the blocklists' answer): once restored, it must compile to what the kernel holds
  const sameBlock = (p: Outcome, r: Outcome) => p.type === 'block' && p.response === 'default' && r.type === 'block' && model.defaults.block === r.response
  if (sameBlock(prev.rest, model.rest)) model.rest = prev.rest
  for (const rg of model.ruleGroups) { const p = prev.ruleGroups.find((x) => x.id === rg.id); if (p && sameBlock(p.rest, rg.rest)) rg.rest = p.rest }
  // 每个列表连同它在上一份里的 Pipeline id：上一份编出来的规则名按它查 / Each list with its pipeline id in the previous model: the previous
  // compile's rule names are looked up by it
  const lists: [Rule[], Rule[], string][] = [[model.rules, prev.rules, mainPipelineId(prev)], ...model.ruleGroups.map((g): [Rule[], Rule[], string] => [g.rules, prev.ruleGroups.find((p) => p.id === g.id)?.rules ?? [], ruleGroupPipelineId(prev, g.id)])]
  // 上一份编出来时每个内核规则名是哪一条：JSON 里没动的名字认得回原来那条，rule-编号 这类面板起的名字也一样，不靠名字的样子猜
  // Which rule each kernel rule name was when the previous model compiled: a name the JSON left alone leads back to that rule, panel-made
  // names such as rule-<id> included, without guessing from a name's shape
  // 上一份可能是以前存下来、自己就编出重名 Pipeline 的模型：这里只要它的名字，不因为它报错 / The previous model may be an old stored one
  // that compiles to repeated pipeline ids itself: only its names are wanted here, so it does not throw for that
  const prevIndex = compileNamed(prev, false).index
  // 没起名字的规则名字都是空的：只按名字找会全接到第一条上（编号重复、备注抄错）。没名字的再要条件一样，上一份的每条只接一次
  // Unnamed rules all have an empty name: matching on the name alone gave every one the first one's id and note. Unnamed ones must also have the same
  // conditions, and each previous rule is taken once
  const sameShape = (a: Rule, b: Rule) => (a.raw || b.raw ? JSON.stringify(a.raw ?? null) === JSON.stringify(b.raw ?? null) : condsKey(a.conditions) === condsKey(b.conditions))
  // cand 编出来和 r 读自的内核规则、它自己的转发 Pipeline 都一样，就换到 r 的位置上；不一样留着 r。内核规则的名字不比：它只管计数和执行路径，
  // 哪一条是哪一条已经由认回来的那一步定了，同列表里别的规则改了名也会让它的内核名跟着变
  // cand takes r's place when it compiles to the kernel rules r was read from and to its own forward pipeline; otherwise r stays. Kernel rule
  // names are left out of the comparison: they only drive counts and traces, which rule is which was settled by the matching, and a rename
  // elsewhere in the list can change this rule's kernel name too
  const unnamed = (rules: unknown[]) => (rules as Record<string, unknown>[]).map(({ name: _name, ...r }) => r)
  // 编号定下规则自己那个转发 Pipeline 的名字（rule-编号）：这个名字在读进来的配置里是别的 Pipeline（读成了上游组、规则组或原样保留）时，不接上一份的
  // 编号，不然这条规则现在或以后自带转发时编出两个同名的。它读自的那个自己的转发不算：并回了规则，不再单独写出去
  // An id names the rule's own forward pipeline (rule-<id>): when that name is another pipeline of the config read in (read as an upstream group,
  // a rule group or kept verbatim) the previous id is not taken, or this rule, with its own forward now or later, compiles to two of one name.
  // The own forward it was read from does not count: folded into the rule, it is not written out on its own
  const takesId = (r: Rule, id: number) => !pipelineIds.has(`rule-${id}`) || origin.rules.get(r)?.pipeline?.id === `rule-${id}`
  // 编出来的样子（不带内核规则名）写成一个键：名字、停用与否不进编出来的样子，上一份的每条只编一次 / What a rule compiles to (kernel rule names
  // left out) as one key: neither the name nor being disabled enters it, so each previous rule is compiled once
  const kernelOf = (rules: unknown[], pipeline: unknown) => kernelKey([unnamed(rules), pipeline ?? null])
  const compiled = new Map<Rule, string>()
  const compiledKey = (cand: Rule) => {
    if (!compiled.has(cand)) { const k = ruleKernel(model, cand, ''); compiled.set(cand, kernelOf(k.rules, k.pipeline)) }
    return compiled.get(cand)!
  }
  // 高级规则原样写回，它跳去的那个转发由原样保留的 Pipeline 写出去，所以只比规则；读成面板规则的这条已经把自己的转发并回来了，上一份的高级规则
  // 写回去就跳到一个没有的 Pipeline，不换
  // An advanced rule writes back verbatim and the forward it jumps to is written by the kept pipeline, so only the rules are compared; when the
  // rule read back is a panel rule that folded its own forward in, the previous advanced rule would jump to a pipeline no longer there, so it
  // is not swapped in
  const compilesAs = (r: Rule, cand: Rule): boolean => {
    const from = origin.rules.get(r)
    if (!from || !refersHere(model, cand) || !takesId(r, cand.id) || (cand.raw && !r.raw && from.pipeline)) return false
    return compiledKey(cand) === kernelOf(from.rules, cand.raw ? null : from.pipeline)
  }
  // 读成高级规则的这条换回上一份的面板写法时，它跳去的那个转发由面板规则自己编出来，不再原样保留一份（不然两个同名）
  // When a rule read as advanced goes back to the previous panel form, the forward it jumps to is compiled by the panel rule itself and is no
  // longer kept verbatim too (or there would be two of one name)
  const folded = new Set<string>()
  const replace = (list: Rule[], r: Rule, cand: Rule): Rule => {
    list[list.indexOf(r)] = cand
    const own = origin.rules.get(r)?.pipeline
    if (r.raw && !cand.raw && own) folded.add(own.id)
    return cand
  }
  const keep = (list: Rule[], r: Rule, cand: Rule): Rule => (compilesAs(r, cand) ? replace(list, r, cand) : r)
  for (const [now, before, pipeline] of lists) {
    // 上一份的每条认回了现在的哪一条：停用的规则按它前面那条认回来的规则放回去（没起名字的规则名字都一样，按名字找会放错位置）
    // Which current rule each previous rule was matched to: a disabled rule goes back after the matched rule before it (unnamed rules share one name, so
    // finding the anchor by name put it in the wrong place)
    const paired = new Map<Rule, Rule>()
    const matched = new Set<Rule>()
    const read = now.filter((r) => origin.rules.has(r))
    const live = before.filter((x) => x.enabled)
    // 读回来的这条在内核里叫什么（拆开的几段取基名）；只有它叫这个名字时才拿名字认 / What the rule read back is called in the kernel (the base for
    // split parts); the name identifies it only when no other rule read back has it
    const kernelName = (r: Rule) => origin.rules.get(r)!.rules[0]!.name.replace(/#\d+$/, '')
    const uses = new Map<string, number>()
    for (const r of read) uses.set(kernelName(r), (uses.get(kernelName(r)) ?? 0) + 1)
    // 上一份编出来就叫这个名字的那条的编号；上一份没编出来的（停用着的）按 rule-编号 认 / The id of the rule the previous compile gave this name; one
    // the previous compile did not write (disabled) by rule-<id>
    const saidId = (r: Rule): number | undefined => {
      const ref = prevIndex.lookup(pipeline, kernelName(r))
      if (ref?.kind === 'rule') return ref.id
      const id = /^rule-(\d+)$/.exec(kernelName(r))?.[1]
      return id === undefined ? undefined : Number(id)
    }
    // 名字没在 JSON 里改过：上一份编出来就是这个名字（没起名字的在内核里叫 rule-编号，名字从上一份接回来）/ The name was not changed in the JSON:
    // the previous compile gave it this very name (an unnamed rule is rule-<id> in the kernel; its name comes from the previous model)
    const nameKept = (r: Rule, p: Rule) => prevIndex.nameOf(p.id)?.name === kernelName(r)
    // 认回来、内容按内核里现在的读：编号、备注、改动时间从上一份接过来 / Matched with the content read from the kernel as it is now: the id, note and
    // edit time come over from the previous model
    const pairEdit = (r: Rule, p: Rule, name: string) => {
      paired.set(p, r)
      matched.add(r)
      Object.assign(r, { id: takesId(r, p.id) ? p.id : r.id, name, note: p.note, edited: p.edited, outcome: sameBlock(p.outcome, r.outcome) ? p.outcome : r.outcome })
      // 条件一样只是顺序不同（内核要求多值的条件排最前）：用上一份的顺序 / Same conditions in another order (the kernel wants a multi-valued one first): keep the previous order
      if (!r.raw && !p.raw && condsKey(r.conditions) === condsKey(p.conditions)) r.conditions = p.conditions
      if (!r.raw && !p.raw && r.response.mode === 'custom' && p.response.mode === 'custom' && JSON.stringify({ ...r.response, conditions: r.response.conditions.map(fullKey).sort() }) === JSON.stringify({ ...p.response, conditions: p.response.conditions.map(fullKey).sort() })) r.response = p.response
    }
    // 编出来一样：整条换成上一份的，名字在 JSON 里改了就用新的。高级规则原样写回，名字在原样的内核规则里：用内核里现在的那份，不然改的名字写回去
    // 又变回原来的
    // Compiling alike: the previous one takes its place whole, with the new name when the JSON changed it. An advanced rule is written back
    // verbatim with its names inside the kernel rules: the kernel's current ones are used, or the new name would be written back as the old one
    const pairSame = (r: Rule, p: Rule) => {
      const cand: Rule = { ...clone(p), enabled: true, name: nameKept(r, p) ? p.name : r.name, ...(r.raw ? { raw: clone(r.raw) } : {}) }
      replace(now, r, cand)
      paired.set(p, cand)
      matched.add(r).add(cand)
    }
    // 认的先后：先按面板起的名字（rule-编号这类，JSON 里没动），再按名字和编出来的样子都一样，再按只有编出来的样子一样（改名、挪位置、把停用的加
    // 回来），最后才按只有名字一样（内容在 JSON 里改了）。内容在前、名字在后：把一条改成另一条的名字时，两条各认各的；只有名字一样的那一步走到时，
    // 内容和上一份某条一样的都已经被它认走了，名字一样的抢不着
    // The order of matching: first by a panel-made name (rule-<id> and the like, left alone in the JSON), then by name and compiled form together,
    // then by compiled form alone (a rename, a move, a disabled rule added back), and only last by name alone (content edited in the JSON). Content
    // before names: renaming one rule to another's name leaves each matched to its own; by the time name alone is tried, every rule whose
    // content equals a previous one has already claimed it, so a mere namesake cannot take it
    // 1. 面板起的名字：上一份编出这个名字的那条，内容改了也是 / 1. A panel-made name: the rule the previous compile gave that name, content edits included
    for (const r of read) {
      const k = kernelName(r)
      const ref = uses.get(k) === 1 ? prevIndex.lookup(pipeline, k) : null
      const p = ref?.kind === 'rule' ? before.find((x) => x.id === ref.id && x.enabled && !paired.has(x)) : undefined
      if (p && k !== p.name.trim()) pairEdit(r, p, p.name)
    }
    // 2、3. 名字和编出来的样子都一样，然后只有编出来的样子一样。几条都合适时先要启用着的（改名比删一条再加回停用的常见），再要编号对得上的，再要同一
    // 位置的，最后按先后。名字和内容都改了的对不上任何一条，是新规则
    // 2, 3. Name and compiled form together, then compiled form alone. Of several that fit, enabled ones come first (a rename is likelier than
    // deleting one and re-adding a disabled one), then the one whose id agrees, then the one at the same place, then the first. A rule with both
    // name and content changed fits none and is new
    for (const byName of [true, false]) {
      read.forEach((r, i) => {
        if (matched.has(r)) return
        const fits = before.filter((p) => !paired.has(p) && (!byName || p.name === r.name) && compilesAs(r, p))
        const pool = fits.some((p) => p.enabled) ? fits.filter((p) => p.enabled) : fits
        const id = saidId(r)
        const p = pool.find((x) => x.id === id) ?? (pool.length > 1 ? pool.find((x) => x === live[i]) : undefined) ?? pool[0]
        if (p) pairSame(r, p)
      })
    }
    // 4. 只有名字一样：内容在 JSON 里改了（入口读成的规则也按名字认）。内核里叫 rule-编号的没有名字可认，第 1 步没认回来就是新的
    // 4. Name alone: the content was edited in the JSON (rules made from entries are matched by name too). One called rule-<id> in the kernel
    // has no name to go by: not matched in step 1, it is new
    for (const r of [...now]) {
      if (matched.has(r) || (origin.rules.has(r) && /^rule-\d+$/.test(kernelName(r)))) continue
      const p = before.find((x) => x.enabled && !paired.has(x) && x.name === r.name && (r.name !== '' || sameShape(x, r)))
      if (p) pairEdit(r, p, r.name)
    }
    // 认回来的规则编出来和内核里一样：整条留上一份 / A matched rule that compiles to what the kernel holds stays the previous one entirely
    for (const [p, r] of paired) if (origin.rules.has(r)) paired.set(p, keep(now, r, clone(p)))
    // 前面那条也是停用的（已经放回去了）就接在它后面：只看认回来的规则时，连着的几条停用规则会倒过来，每手改一次换一次
    // When the rule before is disabled too (already put back) it anchors there: looking at matched rules only, consecutive disabled rules came back reversed
    // and swapped on every hand edit
    before.forEach((p, i) => {
      // 加回来、已经启用的那条不再放一份停用的 / One added back and enabled is not put back disabled as well
      if (p.enabled || paired.has(p)) return
      const anchor = before.slice(0, i).reverse().find((x) => paired.has(x) || !x.enabled)
      const at = anchor ? now.indexOf(paired.get(anchor) ?? anchor) + 1 : 0
      now.splice(at, 0, p)
    })
  }
  if (folded.size && model.rawPipelines) {
    const kept = model.rawPipelines.filter((p) => !folded.has(String(p.id)))
    if (kept.length) model.rawPipelines = kept
    else delete model.rawPipelines
  }
  // 映射按域名认（一个域名只有一条），上一份的每条只认一次；编出来一样的整条留上一份（TTL、目标的写法）。停用的编出来什么都没有：JSON 里加回来
  // 就是启用了它，按内核读；没加回来的照规则的办法放回原位
  // Mappings match by domain (one mapping per domain), each previous one taken once; one that compiles alike stays the previous one entirely
  // (its TTL, how the target is written). A disabled one compiles to nothing: added back in the JSON it was enabled and reads from the kernel;
  // otherwise it goes back to its place as disabled rules do
  // 域名按写进内核的样子比：上一份写的中文，内核里是它的 punycode / Domains compare as written to the kernel: the previous model's Chinese
  // name is its punycode in the kernel
  const pairedMappings = new Map<Mapping, Mapping>()
  model.mappings.forEach((m, i) => {
    const p = prev.mappings.find((x) => !pairedMappings.has(x) && mappingKernelDomain(x) === mappingKernelDomain(m))
    if (!p) return
    const from = origin.mappings.get(m)
    model.mappings[i] = mappingLive(p) && from && sameKernel(mappingRule(p), from) ? clone(p) : Object.assign(m, { id: p.id })
    pairedMappings.set(p, model.mappings[i]!)
  })
  prev.mappings.forEach((p, i) => {
    if (mappingLive(p) || pairedMappings.has(p)) return
    const anchor = prev.mappings.slice(0, i).reverse().find((x) => pairedMappings.has(x) || !mappingLive(x))
    model.mappings.splice(anchor ? model.mappings.indexOf(pairedMappings.get(anchor) ?? anchor) + 1 : 0, 0, p)
  })
  return model
}

/**
 * 认出拦截列表的入口（写法见 model.ts 的 blocklistEntries）：自己写的拦截、列表里的重要拦截、列表里的拦截，每个都减掉自己写的放行；
 * 后两个要配置里有合成的文件。自己写的规则按上一份的原文接回（写出来一样时），否则按入口里的条件重写成规则。认不出时为 null
 * Recognises the blocklists' entries (written as blocklistEntries in model.ts): one's own blocks, the lists' important blocks and the
 * lists' blocks, each taking off one's own allows; the last two need the merged file in the config. One's own rules come back as the
 * previous text when it writes the same, otherwise rewritten from the entries' conditions. Null when they are not recognised
 */
function readBlocklistEntries(entries: KSelectorLike[], settings: Record<string, unknown>, prev: Model | undefined): { blocklists: Blocklists; file: string | null } | null {
  if (!entries.length) return null
  const bare = ({ operator: _op, ...m }: KMatcher) => m as KMatcher
  const isOwn = (m: KMatcher) => (m.type === 'domain_suffix' || m.type === 'domain_regex') && typeof m.value === 'string' && Boolean(m.value)
  const isTag = (m: KMatcher | undefined, value: string) => m?.type === 'geo_site' && m.value === value
  let ownBlocks: KMatcher[] = []
  let ownAllows: KMatcher[] | null = null
  const kinds: string[] = []
  for (const e of entries) {
    const ms = e.matchers ?? []
    const ops = effectiveOps(ms, e.matcher_operator)
    let head: number
    if (isTag(ms[0], TAG_BLOCK_IMPORTANT) && isTag(ms[1], TAG_ALLOW_IMPORTANT) && ops[1] === 'and_not') { kinds.push('important'); head = 2 }
    else if (isTag(ms[0], TAG_BLOCK) && isTag(ms[1], TAG_ALLOW) && isTag(ms[2], TAG_ALLOW_IMPORTANT) && ops[1] === 'and_not' && ops[2] === 'and_not') { kinds.push('list'); head = 3 }
    else {
      head = ms.findIndex((_, i) => i > 0 && ops[i] !== 'or')
      if (head < 0) head = ms.length
      if (!head || !ms.slice(0, head).every(isOwn)) return null
      kinds.push('own')
      ownBlocks = ms.slice(0, head).map(bare)
    }
    const allows = ms.slice(head)
    if (!allows.every((m, i) => isOwn(m) && ops[head + i] === 'and_not')) return null
    const plain = allows.map(bare)
    if (ownAllows && JSON.stringify(ownAllows) !== JSON.stringify(plain)) return null
    ownAllows = plain
  }
  const order = kinds.join(',')
  if (!['own', 'important,list', 'own,important,list'].includes(order)) return null
  // 面板合成的文件总是排在最后（见 compile）；前面还有一个的话是认不出、照原样留下的旧文件 / The panel's file always comes last (see compile); one
  // before it is an old file that could not be recognised and was kept as it was
  const file = order.endsWith('list') ? mergedFileIn(settings) : null
  if (file === undefined) return null
  // 上一份的原文写出来和入口里的一样就用原文：注释、写法和没用上的行都留着 / The previous text when it writes what the entries hold: comments, spelling and unused lines all stay
  const prevOwn = prev ? parseOwnRules(prev.blocklists.custom).rules : []
  const writes = (rules: typeof prevOwn) => JSON.stringify([rules.filter((r) => !r.allow).map((r) => ownMatcher(r.match)), rules.filter((r) => r.allow).map((r) => ownMatcher(r.match))])
  const custom = prev && writes(prevOwn) === JSON.stringify([ownBlocks, ownAllows ?? []])
    ? prev.blocklists.custom
    : [...ownBlocks.map((m) => ownRuleText(m, false)), ...(ownAllows ?? []).map((m) => ownRuleText(m, true))].join('\n')
  const subscriptions = clone(prev?.blocklists.subscriptions ?? [])
  // 配置里的文件就是按这些订阅合成的（定时更新换的文件也一样） / The config's file was built for these subscriptions (so is one the scheduled update swapped in)
  return { blocklists: { subscriptions, file: file ?? null, custom, builtFor: blocklistKey({ subscriptions }) }, file: file ?? null }
}
