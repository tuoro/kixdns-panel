// 内核配置的形状，和两处加载期的语义：匹配链的运算符改写、几个转发的合并。依据 kixdns 681183c：
// matcher/mod.rs eval_match_chain 和加载时的运算符改写，config.rs compute_merged_forward，parse_upstream_addr。
// The kernel config's shape and two pieces of load-time semantics: the matcher chain's operator rewrite and the merging of several
// forwards. Sources (kixdns 681183c): matcher/mod.rs eval_match_chain and the load-time operator rewrite, config.rs
// compute_merged_forward, parse_upstream_addr.

export type KMatcher = Record<string, unknown> & { type: string; operator?: string }
export type KAction = Record<string, unknown> & { type: string }
export interface KRuleLike {
  [key: string]: unknown
  name: string
  matchers?: KMatcher[]
  matcher_operator?: string
  actions?: KAction[]
  response_matchers?: KMatcher[]
  response_matcher_operator?: string
  response_actions_on_match?: KAction[]
  response_actions_on_miss?: KAction[]
}
export interface KPipelineLike { id: string; ecs?: unknown; rules?: KRuleLike[] }
export interface KSelectorLike { pipeline: string; matchers?: KMatcher[]; matcher_operator?: string }
export interface KConfigLike { version?: string; settings?: Record<string, unknown>; pipeline_select?: KSelectorLike[]; pipelines?: KPipelineLike[]; [key: string]: unknown }

// 加载时：每项都是默认 and 而规则级不是 and，就把规则级运算符抄到每一项；求值时第一项按肯定起头，其余从左往右并入
// At load: when every item is the default and and the rule-level operator is not, that operator is copied onto each item;
// evaluation seeds with the first item as a plain positive and folds the rest left to right
export function effectiveOps(matchers: KMatcher[], ruleOp: string | undefined): string[] {
  const own = matchers.map((m) => m.operator ?? 'and')
  return own.every((o) => o === 'and') && ruleOp && ruleOp !== 'and' ? own.map(() => ruleOp) : own
}
export function foldChain(matchers: KMatcher[], ruleOp: string | undefined, hit: (m: KMatcher) => boolean): boolean {
  if (!matchers.length) return true
  const ops = effectiveOps(matchers, ruleOp)
  let acc = hit(matchers[0]!)
  for (let i = 1; i < matchers.length; i++) {
    const op = ops[i]
    if (op === 'or' || op === 'or_not') { if (!acc) acc = op === 'or' ? hit(matchers[i]!) : !hit(matchers[i]!) }
    else if (acc) acc = op === 'and' ? hit(matchers[i]!) : !hit(matchers[i]!)
  }
  return acc
}

// ---------- 上游地址 / upstream addresses ----------
const PREFIX: Record<string, string> = { tcp: 'tcp', udp: 'udp', 'tcp+udp': 'tcp_udp', 'udp+tcp': 'tcp_udp', doh: 'doh', https: 'doh', dot: 'dot', tls: 'dot', doq: 'doq', quic: 'doq' }
// parse_upstream_addr：有前缀按前缀，没有就用动作的 transport（缺省 UDP） / parse_upstream_addr: the prefix wins, else the action's transport (UDP by default)
export function normalizeAddress(addr: string, transport = 'udp'): string {
  const at = addr.indexOf('://')
  if (at < 0) return `${transport}:${addr.trim()}`
  return `${PREFIX[addr.slice(0, at).toLowerCase()] ?? transport}:${addr.slice(at + 3).trim()}`
}
export const splitAddrs = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)
// compute_merged_forward：一条规则有几个转发时合并，按 TCP、UDP、DoH、DoT、DoQ 归类，不带 ECS / compute_merged_forward: several forwards merge by class, without ECS
export function mergedForward(actions: KAction[]): string[] {
  const sets: Record<string, Set<string>> = { tcp: new Set(), udp: new Set(), doh: new Set(), dot: new Set(), doq: new Set() }
  for (const a of actions) {
    if (a.type !== 'forward' || typeof a.upstream !== 'string') continue
    const t = String(a.transport ?? 'udp')
    for (const addr of splitAddrs(a.upstream)) {
      if (addr.includes('://')) {
        const p = addr.slice(0, addr.indexOf('://')).toLowerCase()
        if (p === 'tcp') sets.tcp!.add(addr)
        else if (p === 'udp') sets.udp!.add(addr)
        else if (p === 'tcp+udp' || p === 'udp+tcp') { sets.tcp!.add(addr); sets.udp!.add(addr) }
        else if (p === 'doh' || p === 'https') sets.doh!.add(addr)
        else if (p === 'dot' || p === 'tls') sets.dot!.add(addr)
        else if (p === 'doq' || p === 'quic') sets.doq!.add(addr)
      } else if (t === 'tcp') sets.tcp!.add(`tcp://${addr}`)
      else if (t === 'tcp_udp') { sets.tcp!.add(`tcp://${addr}`); sets.udp!.add(`udp://${addr}`) }
      else if (t === 'doh') sets.doh!.add(`doh://${addr}`)
      else if (t === 'dot') sets.dot!.add(`dot://${addr}`)
      else if (t === 'doq') sets.doq!.add(`doq://${addr}`)
      else sets.udp!.add(`udp://${addr}`)
    }
  }
  return [...sets.tcp!, ...sets.udp!, ...sets.doh!, ...sets.dot!, ...sets.doq!]
}
