import { BLOCKLIST_PIPELINE, BLOCKLIST_RULE, ownMatcher, ownRuleText, parseOwnRules, TAG_ALLOW, TAG_ALLOW_IMPORTANT, TAG_BLOCK, TAG_BLOCK_IMPORTANT } from './blocklist'
import { effectiveOps, normalizeAddress, type KAction, type KConfigLike, type KMatcher, type KPipelineLike, type KRuleLike, type KSelectorLike } from './kernel'
import {
  blocklistEntries, blocklistKey, emptyBlocklists, isIp, kernelAddress, POLLUTED_CIDRS, splitList,
  type Blocklists, type BlockResponse, type Condition, type Ecs, type Mapping, type Model, type Outcome, type Protocol, type Remedy, type ResponseCondition,
  type ResponseHandling, type Rule, type RuleGroup, type UpstreamAddress, type UpstreamGroup, nextId as nextFreeId } from './model'

// 把任何一份内核配置读成模型，不丢东西：能放进规则、上游组、域名映射的就放进去，放不进的原样保留成高级规则 / 高级入口，
// 写回去和原来一样。每一处改动都记一条说明给用户看。依据的内核行为见 kernel.ts 顶上的出处。
// Reads any kernel config into the new model without losing anything: what fits rules, upstream groups and domain mappings goes
// there, and what does not is kept verbatim as advanced rules / entries that write back unchanged. Every change is reported to the
// user. The kernel behaviour relied on is cited at the top of kernel-sim.ts.

export interface ImportNote { level: 'info' | 'warn'; text: string }
export interface ImportResult { model: Model; notes: ImportNote[]; stats: { rules: number; raw: number; groups: number; mappings: number } }

const RULE_KEYS = new Set(['name', 'matchers', 'matcher_operator', 'actions', 'response_matchers', 'response_matcher_operator', 'response_actions_on_match', 'response_actions_on_miss'])
const PIPELINE_KEYS = new Set(['id', 'rules', 'ecs'])
const TOP_KEYS = new Set(['version', 'settings', 'pipeline_select', 'pipelines', 'panel'])
const BLOCK_RCODES: Record<string, BlockResponse> = { NXDOMAIN: 'NXDOMAIN', REFUSED: 'REFUSED', SERVFAIL: 'SERVFAIL', NOERROR: 'NOERROR' }
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
const addrKey = (addrs: UpstreamAddress[]) => addrs.map((a) => normalizeAddress(kernelAddress(a))).sort().join('|')
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
function requestCondition(l: Lit): Condition {
  const { m, neg } = l
  const v = String(m.value ?? '')
  switch (m.type) {
    case 'domain_suffix': return { id: cid(), field: 'domain', negate: neg, regex: false, values: [v] }
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
  const { m, neg } = l
  const v = String(m.value ?? '')
  const c = (field: ResponseCondition['field'], vals: string[], extra: Partial<ResponseCondition> = {}): ResponseCondition => ({ id: cid(), field, negate: neg, values: vals, ...extra })
  switch (m.type) {
    case 'response_rcode': return c('rcode', [v.toUpperCase()])
    case 'response_type': return c('answer_type', [v.toUpperCase()])
    case 'upstream_equals': return c('upstream', [v])
    case 'response_qclass': return c('qclass', [v.toUpperCase()])
    case 'request_domain_suffix': return c('request_domain', [v])
    case 'request_domain_regex': return c('request_domain', [v], { regex: true })
    case 'response_request_domain_geosite': return c('request_geosite', [v])
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
const condsKey = (c: Condition[][]) => c.map((g) => g.map(fullKey).sort().join('&')).sort().join('|')
const condKey = (c: { field: string; negate: boolean; regex?: boolean }) => `${c.field}|${c.negate}|${Boolean(c.regex)}`
const fullKey = (c: { field: string; negate: boolean; regex?: boolean; values: string[] }) => `${condKey(c)}|${[...c.values].sort().join(',')}`
function mergeNegatives<C extends { field: string; negate: boolean; regex?: boolean; values: string[] }>(conds: C[]): C[] {
  const out: C[] = []
  for (const c of conds) {
    const same = c.negate && c.values.length ? out.find((o) => o.negate && o.values.length && condKey(o) === condKey(c)) : undefined
    if (same) same.values = [...new Set([...same.values, ...c.values])]
    else out.push({ ...c, values: [...c.values] })
  }
  return out
}
function mergeGroups(groups: Condition[][]): Condition[][] {
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
      if (x.negate || y.negate || !x.values.length || condKey(x) !== condKey(y) || x.field === 'client_private' || x.field === 'edns') continue
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
  // 新规则的编号从上一份用过的编号之后开始：页面重开以后计数从头来，会和接回来的旧编号撞上（点一条开的是另一条）
  // New rules number from above every id the previous model used: after a page reload the counter starts over and would collide with carried-over ids
  // (clicking one rule opened another)
  if (prev) nextId = Math.max(nextId, nextFreeId(prev))
  const pipelines = (cfg.pipelines ?? []) as KPipelineLike[]
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
  const slug = (base: string) => {
    let id = base.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'group'
    for (let n = 2; usedGroupIds.has(id) || (pipelineIds.has(`upstream-${id}`) && !groupIds.has(`upstream-${id}`)); n++) id = `${base}-${n}`
    usedGroupIds.add(id)
    return id
  }
  const hostLabel = (addrs: UpstreamAddress[]) => {
    const host = (a: UpstreamAddress) => a.address.replace(/^[a-z+]+:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '')
    return addrs.length > 1 ? `${host(addrs[0]!)} 等 ${addrs.length} 个` : host(addrs[0]!)
  }
  const uniqueName = (name: string) => { let n = name; for (let i = 2; groups.some((g) => g.name === n); i++) n = `${name}（${i}）`; return n }
  const groupOfPipeline = new Map<string, UpstreamGroup>()
  for (const p of pipelines) {
    if (!groupIds.has(p.id)) continue
    const f = fwd.get(p.id)!
    const prevG = prev?.groups.find((g) => (g.pipelineId ?? `upstream-${g.id}`) === p.id)
    const id = prevG?.id ?? slug(p.id.startsWith('upstream-') ? p.id.slice(9) : p.id)
    usedGroupIds.add(id)
    const g: UpstreamGroup = { id, name: uniqueName(prevG?.name ?? (p.id.startsWith('upstream-') ? p.id.slice(9) : p.id)), addresses: f.addrs, ecs: f.ecs, fallback: { group: '', onError: false, onPolluted: false } }
    if (p.id !== `upstream-${id}`) g.pipelineId = p.id
    groups.push(g)
    groupOfPipeline.set(p.id, g)
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
    const created: UpstreamGroup = { id: prevG && !usedGroupIds.has(prevG.id) ? prevG.id : slug(name === '默认上游' ? 'default' : hostLabel(addrs).split(' ')[0]!), name: uniqueName(prevG?.name ?? name ?? hostLabel(addrs)), addresses: addrs, ecs, fallback: { group: '', onError: false, onPolluted: false } }
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
      for (const r of rows) mappings.push({ id: cid(), domain: r!.domain, target: r!.target, ttl: r!.ttl, enabled: true })
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
  if (blRule && blRule.name === BLOCKLIST_RULE && isTrueChain(blRule.matchers) && blockAction?.type === 'block' && Object.keys(blRule).every((k) => RULE_KEYS.has(k))
    && !(blRule.response_actions_on_match ?? []).length && !(blRule.response_actions_on_miss ?? []).length
    && Object.keys(blp!).every((k) => k === 'id' || k === 'rules') && (refs.get(blId) ?? []).every((r) => r.from === 'entry')) {
    const count = pre.findIndex((e) => e.pipeline !== blId)
    const leading = count < 0 ? pre : pre.slice(0, count)
    const found = readBlocklistEntries(leading, settings, prev)
    if (found && leading.length === (refs.get(blId) ?? []).length) {
      blocklists = found.blocklists
      blocklistPipeline = blId
      pre = pre.slice(leading.length)
      if (found.file) settings.geosite_data_paths = (settings.geosite_data_paths as unknown[]).filter((p) => p !== found.file)
      if (found.file && !prev) note('配置里用着一个拦截列表文件，但没记下是哪些列表合成的；在「拦截列表」重新订阅以后才能更新它', 'warn')
    }
  }
  // 拦截列表的入口在 JSON 里改过、认不出来：照原样读成别的，说一句，不让拦截列表页像是什么都没开
  // The blocklist entries were edited in the JSON and cannot be recognised: they are read as something else, and a note says so, so the
  // blocklist page does not look as if nothing were on
  if (!blocklistPipeline && blp && blRule?.name === BLOCKLIST_RULE) note('拦截列表的入口在别处改过，认不出来，已照原样读成规则；要在「拦截列表」里管理，先删掉这些规则', 'warn')
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
        const same = !c.negate && c.values.length ? conds.find((o) => !o.negate && o.values.length && condKey(o) === condKey(c) && o.txtMode === c.txtMode) : undefined
        if (same) same.values = [...new Set([...same.values, ...c.values])]
        else conds.push(c)
      }
    } else return raw('回答条件既有「且」又有「或」')
    const then = remedyOf(onMatch)
    const otherwise = remedyOf(onMiss)
    return { mode: 'custom', match, conditions: conds, then: then.remedy, otherwise: otherwise.remedy, thenLog: then.log, otherwiseLog: otherwise.log }
  }
  const base = (name: string) => name.replace(/#\d+$/, '')
  function convertRule(kr: KRuleLike, where: string): Rule {
    // 面板给没起名字的规则编的内核名（rule-编号）读回来时还原成不带名字 / The kernel name the panel made up for an unnamed rule (rule-<id>) reads back as no name
    const rule: Rule = { id: cid(), name: /^rule-\d+$/.test(base(kr.name)) ? '' : base(kr.name), note: '', enabled: true, conditions: [[]], outcome: { type: 'continue' }, log: { enabled: false, level: 'info' }, ecs: 'inherit', response: { mode: 'inherit', match: 'any', conditions: [], then: { type: 'none' }, otherwise: { type: 'none' } }, edited: '导入' }
    try {
      if (Object.keys(kr).some((k) => !RULE_KEYS.has(k))) raw('规则里有认不出的字段')
      rule.conditions = mergeGroups(dnf(kr.matchers, kr.matcher_operator).map((g) => g.map(requestCondition)))
      if (!rule.conditions.length) raw('条件永远不成立')
      const actions = kr.actions ?? []
      const hasResponse = (kr.response_actions_on_match ?? []).length + (kr.response_actions_on_miss ?? []).length > 0
      const forwards = actions.filter((a) => a.type === 'forward')
      let forwardedHere = false
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
          else if (inline.has(t) && (consumed.get(t) ?? rule.name) === rule.name) { const f = fwd.get(t)!; setForward(f.addrs, f.ecs, f.rule); consumed.set(t, rule.name) }
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
      return rule
    } catch (e) {
      if (!(e instanceof Raw)) throw e
      rawCount++
      note(`「${base(kr.name)}」${where}放不进面板的写法（${e.message}），原样保留为高级规则`, 'warn')
      return { ...rule, conditions: [[]], outcome: { type: 'continue' }, response: { ...rule.response, mode: 'inherit' }, ecs: 'inherit', raw: [clone(kr) as unknown as Record<string, unknown>] }
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
      if (last && !last.raw && !r.raw && /#\d+$/.test(kr.name) && lastKernel === base(kr.name) && sameBehaviour(last, r)) last.conditions = mergeGroups([...last.conditions, ...r.conditions])
      else rules.push(r)
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
    const plain = (outcome: Outcome): Rule => ({ id: cid(), name: t, note: '', enabled: true, conditions: when, outcome, log: { enabled: false, level: 'info' }, ecs: 'inherit', response: { mode: 'inherit', match: 'any', conditions: [], then: { type: 'none' }, otherwise: { type: 'none' } }, edited: '导入' })
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
    defaults: prev?.defaults ?? { block: 'NXDOMAIN' },
    blocklists,
    ...(mainId ? { mainId } : {}),
    ...(mappingId ? { mappingId } : {}),
    ...(mainExtra ? { mainExtra } : {}),
    ...(entries ? { entries } : {}),
    ...(trailing.length ? { trailingEntries: trailing } : {}),
    ...(rawPipelines.length ? { rawPipelines } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  }
  if (prev) model = carryOver(model, prev)
  return { model, notes, stats: { rules: allRules.length, raw: rawCount, groups: finalGroups.length, mappings: mappings.length } }
}

// 内核里没有的东西从上一份接回来：规则的编号、备注、停用的规则和映射 / What the kernel does not hold comes from the previous model:
// rule ids, notes, disabled rules and mappings
function carryOver(model: Model, prev: Model): Model {
  // 「拦截 · 沿用默认」写进内核就是具体的响应码，读回来按上一份认回「沿用默认」 / 拦截 · 沿用默认 reaches the kernel as a concrete code; the previous model restores it
  const resolved = (o: Outcome) => (o.type === 'block' && o.response === 'default' ? prev.defaults.block : o.type === 'block' ? o.response : null)
  const sameBlock = (p: Outcome, r: Outcome) => p.type === 'block' && p.response === 'default' && r.type === 'block' && resolved(p) === resolved(r)
  if (sameBlock(prev.rest, model.rest)) model.rest = prev.rest
  for (const rg of model.ruleGroups) { const p = prev.ruleGroups.find((x) => x.id === rg.id); if (p && sameBlock(p.rest, rg.rest)) rg.rest = p.rest }
  const lists: [Rule[], Rule[]][] = [[model.rules, prev.rules], ...model.ruleGroups.map((g): [Rule[], Rule[]] => [g.rules, prev.ruleGroups.find((p) => p.id === g.id)?.rules ?? []])]
  // 没起名字的规则名字都是空的：只按名字找会全接到第一条上（编号重复、备注抄错）。没名字的再要条件一样，上一份的每条只接一次
  // Unnamed rules all have an empty name: matching on the name alone gave every one the first one's id and note. Unnamed ones must also have the same
  // conditions, and each previous rule is taken once
  const sameShape = (a: Rule, b: Rule) => (a.raw || b.raw ? JSON.stringify(a.raw ?? null) === JSON.stringify(b.raw ?? null) : condsKey(a.conditions) === condsKey(b.conditions))
  for (const [now, before] of lists) {
    // 上一份的每条认回了现在的哪一条：停用的规则按它前面那条认回来的规则放回去（没起名字的规则名字都一样，按名字找会放错位置）
    // Which current rule each previous rule was matched to: a disabled rule goes back after the matched rule before it (unnamed rules share one name, so
    // finding the anchor by name put it in the wrong place)
    const paired = new Map<Rule, Rule>()
    for (const r of now) {
      const p = before.find((x) => x.enabled && !paired.has(x) && x.name === r.name && (r.name !== '' || sameShape(x, r)))
      if (!p) continue
      paired.set(p, r)
      Object.assign(r, { id: p.id, note: p.note, edited: p.edited, outcome: sameBlock(p.outcome, r.outcome) ? p.outcome : r.outcome })
      // 条件一样只是顺序不同（内核要求多值的条件排最前）：用上一份的顺序 / Same conditions in another order (the kernel wants a multi-valued one first): keep the previous order
      if (!r.raw && !p.raw && condsKey(r.conditions) === condsKey(p.conditions)) r.conditions = p.conditions
      if (!r.raw && !p.raw && r.response.mode === 'custom' && p.response.mode === 'custom' && JSON.stringify({ ...r.response, conditions: r.response.conditions.map(fullKey).sort() }) === JSON.stringify({ ...p.response, conditions: p.response.conditions.map(fullKey).sort() })) r.response = p.response
    }
    // 前面那条也是停用的（已经放回去了）就接在它后面：只看认回来的规则时，连着的几条停用规则会倒过来，每手改一次换一次
    // When the rule before is disabled too (already put back) it anchors there: looking at matched rules only, consecutive disabled rules came back reversed
    // and swapped on every hand edit
    before.forEach((p, i) => {
      if (p.enabled) return
      const anchor = before.slice(0, i).reverse().find((x) => paired.has(x) || !x.enabled)
      const at = anchor ? now.indexOf(paired.get(anchor) ?? anchor) + 1 : 0
      now.splice(at, 0, p)
    })
  }
  for (const m of model.mappings) { const p = prev.mappings.find((x) => x.domain === m.domain); if (p) m.id = p.id }
  prev.mappings.forEach((p) => { if (!p.enabled) model.mappings.push(p) })
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
  const paths = Array.isArray(settings.geosite_data_paths) ? (settings.geosite_data_paths as unknown[]) : []
  // 面板合成的文件总是排在最后（见 compile）；前面还有一个的话是认不出、照原样留下的旧文件 / The panel's file always comes last (see compile); one
  // before it is an old file that could not be recognised and was kept as it was
  const file = order.endsWith('list') ? [...paths].reverse().find((p): p is string => typeof p === 'string' && /(^|\/)blocklist-[0-9a-f]{64}\.json$/.test(p)) : null
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
