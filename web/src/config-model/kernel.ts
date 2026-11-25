// 内核配置的形状，和两处加载期的语义：匹配链的运算符改写、几个转发的合并。依据 kixdns d2b5fc3：matcher/mod.rs eval_match_chain、
// apply_rule_operator，config.rs 的 MatchOperator（连同别名）、Rule 的 request_decision、forwards、merges、merged_forward，
// GlobalSettings::forward_target，parse_upstream_addr、Transport::from_label、Transport::label。
// The kernel config's shape and two pieces of load-time semantics: the matcher chain's operator rewrite and the merging of several
// forwards. Sources (kixdns d2b5fc3): matcher/mod.rs eval_match_chain and apply_rule_operator; config.rs's MatchOperator (with its
// aliases), Rule's request_decision, forwards, merges and merged_forward, GlobalSettings::forward_target, parse_upstream_addr,
// Transport::from_label and Transport::label.

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

// 两份内核 JSON 是不是同一份：数组的先后算，键的先后不算——内核按键名读，面板服务端改配置时（Geo 数据、拦截列表）也会挪动 settings 里键的位置
// Whether two kernel JSON values are the same: array order counts, key order does not — the kernel reads by key name, and the panel server
// moves keys within settings when it edits a config (Geo data, blocklists)
const sortedKeys = (_key: string, v: unknown): unknown => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v)
/** 一份内核 JSON 写成一个键，sameKernel 一样的键也一样 / One kernel JSON value as a key, equal whenever sameKernel says equal */
export const kernelKey = (v: unknown): string => JSON.stringify(v ?? null, sortedKeys)
export const sameKernel = (a: unknown, b: unknown): boolean => kernelKey(a) === kernelKey(b)

// MatchOperator 的别名：not、and-not、andnot 都是 and_not，or-not、ornot 是 or_not；认不出的原样（内核读都读不进来）
// MatchOperator's aliases: not, and-not and andnot are and_not, or-not and ornot are or_not; anything else stays as written (the kernel
// cannot even read it)
const OPERATOR: Record<string, string> = { not: 'and_not', 'and-not': 'and_not', andnot: 'and_not', 'or-not': 'or_not', ornot: 'or_not' }
export const matchOperator = (op: string | undefined): string => (op === undefined ? 'and' : (OPERATOR[op] ?? op))
// 加载时：每项都是默认 and 而规则级不是 and，就把规则级运算符抄到每一项；求值时第一项按肯定起头，其余从左往右并入。给出的是去掉别名的写法
// At load: when every item is the default and and the rule-level operator is not, that operator is copied onto each item;
// evaluation seeds with the first item as a plain positive and folds the rest left to right. What is given is free of aliases
export function effectiveOps(matchers: KMatcher[], ruleOp: string | undefined): string[] {
  const own = matchers.map((m) => matchOperator(m.operator))
  const rule = matchOperator(ruleOp)
  return own.every((o) => o === 'and') && rule !== 'and' ? own.map(() => rule) : own
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
// Transport::from_label：地址前缀对应的传输，大小写不论，udp+tcp、https、tls、quic 是别名 / Transport::from_label: the transport an address
// prefix names, in any case, udp+tcp, https, tls and quic being aliases
export const PREFIX: Record<string, string> = { tcp: 'tcp', udp: 'udp', 'tcp+udp': 'tcp_udp', 'udp+tcp': 'tcp_udp', doh: 'doh', https: 'doh', dot: 'dot', tls: 'dot', doq: 'doq', quic: 'doq' }
// parse_upstream_addr：有认得的前缀按前缀，没有或认不出就用动作的 transport（缺省 UDP）；给出传输和去掉前缀的地址
// parse_upstream_addr: a known prefix wins, else the action's transport (UDP by default); gives the transport and the address short of
// its prefix
export function parseUpstreamAddr(addr: string, transport = 'udp'): [transport: string, address: string] {
  const at = addr.indexOf('://')
  return at < 0 ? [transport, addr.trim()] : [PREFIX[addr.slice(0, at).toLowerCase()] ?? transport, addr.slice(at + 3).trim()]
}
export function normalizeAddress(addr: string, transport = 'udp'): string {
  const [kind, address] = parseUpstreamAddr(addr, transport)
  return `${kind}:${address}`
}
export const splitAddrs = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

// ---------- 规则的动作 / a rule's actions ----------
// Rule::request_decision：请求阶段作决定的那个动作，第一个不是 log、replace_txt_response 的（请求时手上没有回答可换，它什么都不做）
// Rule::request_decision: the action deciding the request phase, the first that is neither log nor replace_txt_response (with no answer
// in hand to replace, it does nothing in the request phase)
export const requestDecision = <A extends { type: string }>(actions: readonly A[]): A | undefined => actions.find((a) => a.type !== 'log' && a.type !== 'replace_txt_response')
// Action::response_decision：回答阶段一串动作里作决定的那个，第一个不是 log、forward 的 / Action::response_decision: the action deciding an
// answer-phase list, the first that is neither log nor forward
export const responseDecision = <A extends { type: string }>(actions: readonly A[]): A | undefined => actions.find((a) => a.type !== 'log' && a.type !== 'forward')
// GlobalSettings::forward_target：forward 写了上游就问它们（写成数组的连成一串），没写（不写、null、[]）问 default_upstream；空字符串不算没写，
// 它一个上游也没有
// GlobalSettings::forward_target: a forward writing upstreams asks them (an array joined into one list), one writing none (absent, null or
// []) asks default_upstream; an empty string is not none written, it names no upstream at all
export function forwardTarget(upstream: unknown, defaultUpstream: string): string {
  if (upstream === undefined || upstream === null || (Array.isArray(upstream) && !upstream.length)) return defaultUpstream
  return Array.isArray(upstream) ? upstream.join(',') : String(upstream)
}
// Rule::forwards：每个 forward 问的上游、传输（没写是 UDP）和 ecs，按写的顺序 / Rule::forwards: what each forward asks, its transport (UDP when
// not written) and its ecs, in the order written
export function forwardsOf(actions: KAction[], defaultUpstream: string): { upstreams: string[]; transport: string; ecs: unknown }[] {
  return actions.filter((a) => a.type === 'forward').map((a) => ({ upstreams: splitAddrs(forwardTarget(a.upstream, defaultUpstream)), transport: String(a.transport ?? 'udp'), ecs: a.ecs }))
}
// 合并后的列表按这个顺序排传输（Transport::ALL） / The merged list orders transports so (Transport::ALL)
const MERGE_ORDER = ['tcp', 'udp', 'tcp_udp', 'doh', 'dot', 'doq']
/**
 * Rule::merged_forward：规则写了不止一个 forward、而且作决定的是 forward（Rule::merges）时，合成的那一次转发问的上游。每个 forward 问的
 * 上游（forwardTarget，没写的问 default_upstream）照单个转发那样认前缀，没有前缀的按它自己的 transport，写成「传输://地址」（https:// 成了
 * doh://，tcp+udp 记一份、照样双发），同一种传输里去重，各组按 TCP、UDP、TCP+UDP、DoH、DoT、DoQ 排（组里的先后内核不定）。不合并、或者一个
 * 地址也问不到时为 null。合并以后只发一个 ECS，几个 forward 的 ecs 写得一样时是它（见 forwardsOf，写得不一样时内核不收）
 * Rule::merged_forward: the upstreams of the one forward a rule's forwards merge into, when it writes more than one and a forward decides
 * (Rule::merges). The upstreams each forward asks (forwardTarget, default_upstream for one writing none) have their prefix read as for a
 * single forward, the forward's own transport for one without, written 「transport://address」 (https:// becoming doh://, tcp+udp kept once
 * and still asked both ways), deduplicated within a transport, the groups ordered TCP, UDP, TCP+UDP, DoH, DoT, DoQ (the kernel leaves the
 * order within one open). null when they do not merge or ask no address at all. The merge sends one ECS, the forwards' ecs when all write
 * the same (see forwardsOf; the kernel refuses them differing)
 */
export function mergedForward(actions: KAction[], defaultUpstream: string): string[] | null {
  if (requestDecision(actions)?.type !== 'forward' || actions.filter((a) => a.type === 'forward').length < 2) return null
  const groups = new Map(MERGE_ORDER.map((transport) => [transport, new Set<string>()]))
  for (const f of forwardsOf(actions, defaultUpstream)) {
    for (const addr of f.upstreams) {
      const [transport, address] = parseUpstreamAddr(addr, f.transport)
      // 前缀是 Transport::label：只有 TCP+UDP 和传输的名字不一样 / The prefix is Transport::label, differing from the transport's name for
      // TCP+UDP only
      groups.get(transport)?.add(`${transport === 'tcp_udp' ? 'tcp+udp' : transport}://${address}`)
    }
  }
  const merged = [...groups.values()].flatMap((g) => [...g])
  return merged.length ? merged : null
}
