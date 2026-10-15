import type { NamedCount, RuleCount } from './api/types'
import { normalizeAddress, splitAddrs } from './config-model/kernel'
import { kernelAddress, mainPipelineId, upstreamPipelineId, type Model, type Outcome, type Remedy, type UpstreamGroup } from './config-model/model'
import type { TraceNames } from './config-model/trace-names'

// 概览的「请求分布」：每个请求最后去了哪。
// 内核按 Pipeline 计数：请求进入时记一次，之后每跳一次再记一次，所以主列表、规则组这种只负责转交的列表会把请求再算一遍。
// 这里只数请求最后停下的地方：
// - 上游组：进到它的次数，减去它的回答后检查把请求转走或直接回应的次数（内核按规则单独计了这一步）；
// - 规则单独设了 ECS 或回答检查时自带的转发，并进它用的那个上游组（按地址认）；
// - 域名映射：进到映射的请求都在那里回答；
// - 剩下的就是没交给上游、在规则里直接回应的（拦截、自定义回答），用总请求数减出来。
// 回答后检查的「否则」内核不计数：这样转走的请求会在两个去向里各算一次，卡片上照实说明。
// The overview's request distribution: where each request finally went.
// The kernel counts per pipeline, once on entry and once more on every jump, so lists that only hand requests on (the main list,
// rule groups) count them a second time. Only the place a request stops is counted here:
// - an upstream group: requests that entered it, less those its answer check sent elsewhere or answered itself (the kernel counts that
//   step per rule);
// - a rule's own forward (when it sets ECS or an answer check) joins the upstream group it uses, recognised by its addresses;
// - domain mappings: every request entering them is answered there;
// - the rest were answered by the rules without an upstream (blocked, custom answers): the total less everything above.
// The kernel does not count an answer check's 「否则」: requests it sends elsewhere count in both places, and the card says so.

export interface KernelAction { type?: unknown; upstream?: unknown }
export interface KernelRule { name?: unknown; actions?: unknown; response_actions_on_match?: unknown; response_actions_on_miss?: unknown }
export interface KernelPipeline { id?: unknown; rules?: unknown }

export interface DestinationRow { key: string; label: string; mono: boolean; count: number; share: number }
export interface Destinations { rows: DestinationRow[]; caveats: string[] }

const STATIC = new Set(['static_response', 'static_ip_response', 'static_cname_response', 'static_txt_response', 'deny'])
const actionsOf = (list: unknown): KernelAction[] => (Array.isArray(list) ? list.filter((a): a is KernelAction => Boolean(a) && typeof a === 'object') : [])
const typeOf = (action: KernelAction) => (typeof action.type === 'string' ? action.type : '')
const jumps = (list: unknown) => actionsOf(list).some((a) => typeOf(a) === 'jump_to_pipeline')
// 回答后检查把请求带离这个组：跳到别处，或者直接给出回应 / An answer check takes the request out of this group: a jump, or an answer of its own
const leaves = (list: unknown) => actionsOf(list).some((a) => typeOf(a) === 'jump_to_pipeline' || STATIC.has(typeOf(a)))
const forwardOf = (list: unknown) => actionsOf(list).find((a) => typeOf(a) === 'forward' || typeOf(a) === 'allow')
const rulesOf = (pipeline: KernelPipeline | undefined): KernelRule[] => (Array.isArray(pipeline?.rules) ? pipeline.rules.filter((r): r is KernelRule => Boolean(r) && typeof r === 'object') : [])

// 一组地址的指纹：协议加地址，不分顺序 / A fingerprint for a set of addresses: protocol and address, order ignored
const fingerprint = (addresses: string[]) => [...new Set(addresses.map((a) => normalizeAddress(a).toLowerCase()))].sort().join('|')

// 在规则里直接回应的那些叫什么：看配置里实际用到了拦截、自定义回答中的哪几种 / What to call requests the rules answered themselves: the kinds of block and custom answer the config actually uses
export function directLabel(model: Model): string {
  const kinds = new Set<string>()
  const note = (o: Outcome | Remedy) => { if (o.type === 'block' || o.type === 'answer') kinds.add(o.type) }
  for (const r of [...model.rules, ...model.ruleGroups.flatMap((g) => g.rules)]) {
    note(r.outcome)
    if (r.response.mode === 'custom') { note(r.response.then); note(r.response.otherwise) }
  }
  note(model.rest)
  for (const g of model.ruleGroups) note(g.rest)
  if (kinds.has('block') && kinds.has('answer')) return '拦截和自定义回答'
  if (kinds.has('block')) return '拦截'
  if (kinds.has('answer')) return '自定义回答'
  return '直接回应'
}

/**
 * 认出一个内核 Pipeline 转发给的是哪个上游组：先按组自己的 Pipeline，再按转发地址（规则自带的转发、导入的旧配置）。
 * 概览的请求分布和查询日志用同一套认法，两边说的组一样。
 * Which upstream group a kernel pipeline forwards to: by the group's own pipeline first, then by forward addresses (a rule's own
 * forward, an imported old config). The overview's distribution and the query log share it, so both name the same group.
 */
export function forwardGroups(pipelines: readonly KernelPipeline[], model: Model): (pipelineId: string) => UpstreamGroup | undefined {
  const byId = new Map(pipelines.filter((p) => typeof p.id === 'string').map((p) => [p.id as string, p]))
  const groupByAddresses = new Map(model.groups.filter((g) => g.addresses.length).map((g) => [fingerprint(g.addresses.map(kernelAddress)), g]))
  return (pipelineId) => {
    const own = model.groups.find((g) => upstreamPipelineId(model, g.id) === pipelineId)
    if (own) return own
    const forward = rulesOf(byId.get(pipelineId)).map((r) => forwardOf(r.actions)).find(Boolean)
    return forward && typeof forward.upstream === 'string' ? groupByAddresses.get(fingerprint(splitAddrs(forward.upstream))) : undefined
  }
}

/** 不属于任何上游组、自己转发的列表：概览上各占一行，查询日志的去向筛选也列出来 / Lists that forward on their own, outside any upstream group: a row each on the overview, and options in the query log's destination filter */
export function ownForwards(pipelines: readonly KernelPipeline[], model: Model): string[] {
  const groupOf = forwardGroups(pipelines, model)
  const mapping = model.mappingId ?? 'domain_mapping'
  return pipelines.flatMap((p) => {
    if (typeof p.id !== 'string' || p.id === mapping || groupOf(p.id)) return []
    const rules = rulesOf(p)
    return rules.some((r) => forwardOf(r.actions)) && !rules.some((r) => jumps(r.actions)) ? [p.id] : []
  })
}

/** 只转发、不属于上游组的列表叫什么：主列表说「主列表直接转发」，和概览一致 / What a list that forwards outside any group is called: the main list reads 主列表直接转发, as on the overview */
export function ownForwardLabel(id: string, model: Model, names: TraceNames): { label: string; mono: boolean } {
  if (id === mainPipelineId(model)) return { label: '主列表直接转发', mono: false }
  const said = names.pipeline(id)
  return { label: said ?? id, mono: !said }
}

export function requestDestinations(input: {
  /** 启动以来的请求数（不含后台刷新，和 Pipeline 计数同一口径） / Requests since start (background refreshes excluded, as in the pipeline counts) */
  total: number
  hits: readonly NamedCount[]
  matches: readonly RuleCount[]
  /** 配置文件里的内核 Pipeline / The kernel pipelines in the config file */
  pipelines: readonly KernelPipeline[]
  model: Model
  names: TraceNames
}): Destinations {
  const { total, hits, matches, pipelines, model, names } = input
  const byId = new Map(pipelines.filter((p) => typeof p.id === 'string').map((p) => [p.id as string, p]))
  const groupOf = forwardGroups(pipelines, model)
  const direct = directLabel(model)
  const caveats = new Set<string>()
  const rows = new Map<string, DestinationRow>()
  const place = (key: string, label: string, mono: boolean, count: number) => {
    const row = rows.get(key) ?? { key, label, mono, count: 0, share: 0 }
    row.count += count
    rows.set(key, row)
  }
  let placed = 0
  for (const hit of hits) {
    const pipeline = byId.get(hit.name)
    const rules = rulesOf(pipeline)
    const said = names.pipeline(hit.name)
    // 只负责转交的列表：请求算在它转去的地方 / A list that hands requests on: they count where it sent them
    if (pipeline && rules.some((r) => jumps(r.actions))) {
      if (rules.some((r) => forwardOf(r.actions))) caveats.add(`「${said ?? hit.name}」里直接转发的请求算进了「${direct}」`)
      continue
    }
    // 回答后检查转走或直接回应的，从这里减掉；同名的几条规则内核合在一起计数，只减一次
    // Requests an answer check sent elsewhere or answered are taken off here; same-named rules share one count, so it is taken once
    const leaving = new Set(rules.filter((r) => typeof r.name === 'string' && leaves(r.response_actions_on_match)).map((r) => r.name as string))
    const sentOn = matches.filter((m) => m.pipeline === hit.name && m.phase === 'response' && leaving.has(m.rule)).reduce((sum, m) => sum + m.count, 0)
    if (rules.some((r) => leaves(r.response_actions_on_miss))) caveats.add('回答后检查的「否则」转走或直接回应的请求，仍算在原来的上游组')
    const count = Math.max(0, hit.count - sentOn)
    if (hit.name === (model.mappingId ?? 'domain_mapping')) { place('mapping', '域名映射', false, count); placed += count; continue }
    const forward = rules.map((r) => forwardOf(r.actions)).find(Boolean)
    // 只有直接回应、不转发的列表：算进「直接回应」，由总数减出来 / A list that only answers and never forwards: it lands in the direct row, which the total works out
    if (pipeline && !forward) continue
    const group = groupOf(hit.name)
    if (group) place(`group:${group.id}`, `上游组「${group.name}」`, false, count)
    else { const own = ownForwardLabel(hit.name, model, names); place(hit.name, own.label, own.mono, count) }
    placed += count
  }
  const rest = Math.max(0, total - placed)
  if (rest > 0) place('direct', direct, false, rest)
  const base = Math.max(total, placed)
  const list = [...rows.values()].filter((row) => row.count > 0).sort((a, b) => b.count - a.count)
  for (const row of list) row.share = base > 0 ? row.count / base : 0
  return { rows: list, caveats: [...caveats] }
}
