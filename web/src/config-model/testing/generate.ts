import {
  addressProblem, ecsProblem, emptyBlocklists, inheritResponse, outcomeProblem, ruleProblems, type Condition, type ConditionField, type Ecs, type Mapping, type Model, type Outcome,
  type Remedy, type ResponseCondition, type ResponseField, type Rule, type RuleGroup, type UpstreamAddress, type UpstreamGroup,
} from '../model'

// 按种子生成编辑器认可的模型（每条规则 ruleProblems 为空、每个地址 addressProblem 为空），名字专挑容易撞的。只给测试用：性质测试
// （properties.test.ts）和交给真内核校验的配置（kernel-fixtures.test.ts）都从这里来，种子一样生成的就一样
// Editor-valid models from a seed (every rule clean under ruleProblems, every address under addressProblem), with names picked to collide.
// For tests only: the property tests (properties.test.ts) and the configs handed to the real kernel (kernel-fixtures.test.ts) both come from
// here, and one seed always gives one model

// mulberry32：小、快、够匀，种子一样序列就一样 / mulberry32: small, fast, even enough, one seed one sequence
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
interface Gen { pick: <T>(xs: readonly T[]) => T; int: (lo: number, hi: number) => number; chance: (p: number) => boolean; id: () => number }
function gen(seed: number): Gen {
  const r = rng(seed)
  let next = 1
  return { pick: (xs) => xs[Math.floor(r() * xs.length)]!, int: (lo, hi) => lo + Math.floor(r() * (hi - lo + 1)), chance: (p) => r() < p, id: () => next++ }
}

const DOMAINS = ['example.com', 'a.example.org', 'corp.internal', '中文.example', 'Bücher.example', '*.wild.example', 'xn--fiq228c.example', '例子。测试', 'ｅｘａｍｐｌｅ.net', 'trailing.example.', 'UPPER.Example.COM', 'cn', 'apple.com']
const EXACT_DOMAINS = ['api.example.com', '中文.example', 'Bücher.example', 'host.lan']
const REGEXES = ['^ads\\.', '\\.cn$', '(?i)tracker', '^[a-z]+\\.example$']
const GEOSITES = ['cn', 'category-ads-all', 'geolocation-!cn', 'google']
const CIDRS = ['192.168.1.0/24', '10.0.0.0/8', 'fd00::/8', '192.168.50.7', '2001:db8::1']
const COUNTRIES = ['CN', 'US', 'HK']
const QTYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'PTR', 'SRV']
const QCLASSES = ['IN', 'CH', 'HS']
const RCODES = ['NOERROR', 'SERVFAIL', 'NXDOMAIN', 'REFUSED', 'OTHER']
const TXTS = ['v=spf1', 'hello world']
const TXT_REGEXES = ['^v=spf1', 'spf1']
// 撞名的：重名、和其余请求同名、形如 rule-数字、带 #数字、像 Pipeline 名字 / Colliding names: repeats, the catch-all's, rule-digits, #digits, pipeline-like
const NAMES = ['', '', '', 'a', 'b', 'dup', 'dup', '国内', 'rule-3', 'rule-3-2', 'x#2', '其余请求', 'foo bar', 'upstream-cn']

function values(g: Gen, pool: readonly string[], max = 3): string[] {
  const n = g.int(1, max)
  const out = new Set<string>()
  for (let i = 0; i < n; i++) out.add(g.pick(pool))
  return [...out]
}

function requestCondition(g: Gen): Condition {
  const field = g.pick<ConditionField>(['domain', 'domain', 'domain', 'geosite', 'client_ip', 'client_country', 'client_private', 'qtype', 'qclass', 'edns'])
  const negate = g.chance(0.3)
  const id = g.id()
  switch (field) {
    case 'domain': {
      const kind = g.pick(['suffix', 'suffix', 'exact', 'regex'])
      if (kind === 'exact') return { id, field, negate, regex: false, exact: true, values: values(g, EXACT_DOMAINS, 2) }
      if (kind === 'regex') return { id, field, negate, regex: true, values: values(g, REGEXES, 2) }
      return { id, field, negate, regex: false, values: values(g, DOMAINS) }
    }
    case 'geosite': return { id, field, negate, values: values(g, GEOSITES, 2) }
    case 'client_ip': return { id, field, negate, values: values(g, CIDRS, 2) }
    case 'client_country': return { id, field, negate, values: values(g, COUNTRIES, 2) }
    case 'client_private': return { id, field, negate, values: [] }
    case 'qtype': return { id, field, negate, values: values(g, QTYPES, 2) }
    case 'qclass': return { id, field, negate, values: values(g, QCLASSES, 1) }
    case 'edns': return { id, field, negate, values: [] }
  }
}

function responseCondition(g: Gen): ResponseCondition {
  const field = g.pick<ResponseField>(['rcode', 'answer_ip', 'answer_country', 'answer_private', 'answer_type', 'upstream', 'upstream_ip', 'request_domain', 'request_geosite', 'txt', 'qclass', 'edns'])
  const negate = g.chance(0.3)
  const id = g.id()
  switch (field) {
    case 'rcode': return { id, field, negate, values: values(g, RCODES, 2) }
    case 'answer_ip': return { id, field, negate, values: values(g, CIDRS, 2) }
    case 'answer_country': return { id, field, negate, values: values(g, COUNTRIES, 2) }
    case 'answer_private': return { id, field, negate, values: [] }
    case 'answer_type': return { id, field, negate, values: values(g, QTYPES, 2) }
    case 'upstream': return { id, field, negate, values: values(g, ['10.0.0.53:53', 'https://dns.google/dns-query'], 1) }
    case 'upstream_ip': return { id, field, negate, values: values(g, CIDRS, 2) }
    case 'request_domain': {
      const kind = g.pick(['suffix', 'exact', 'regex'])
      if (kind === 'exact') return { id, field, negate, regex: false, exact: true, values: values(g, EXACT_DOMAINS, 1) }
      if (kind === 'regex') return { id, field, negate, regex: true, values: values(g, REGEXES, 1) }
      return { id, field, negate, regex: false, values: values(g, DOMAINS, 2) }
    }
    case 'request_geosite': return { id, field, negate, values: values(g, GEOSITES, 2) }
    case 'txt': {
      const mode = g.pick(['exact', 'prefix', 'regex'] as const)
      return { id, field, negate, txtMode: mode, values: values(g, mode === 'regex' ? TXT_REGEXES : TXTS, 1) }
    }
    case 'qclass': return { id, field, negate, values: values(g, QCLASSES, 1) }
    case 'edns': return { id, field, negate, values: [] }
  }
}

// 没写端口的几个（223.5.5.5、TCP 主机）也在里面：编辑器认它们，写进内核时补上 53 / Portless ones (223.5.5.5, a TCP host) are in there too: the
// editor takes them, and they take 53 when written to the kernel
const ADDRESSES: UpstreamAddress[] = [
  { address: '223.5.5.5:53', protocol: 'auto' }, { address: '223.5.5.5:53', protocol: 'tcp_udp' }, { address: '[2400:3200::1]:53', protocol: 'auto' },
  { address: 'https://dns.alidns.com/dns-query', protocol: 'auto' }, { address: 'tls://dns.alidns.com', protocol: 'auto' }, { address: 'quic://dns.alidns.com', protocol: 'auto' },
  { address: 'tcp://dns.example:53', protocol: 'auto' }, { address: '10.0.0.53:53', protocol: 'auto' }, { address: '192.168.1.1:53', protocol: 'auto' },
  { address: 'dns.google/dns-query', protocol: 'doh' }, { address: '8.8.8.8:853', protocol: 'dot' },
  { address: '119.29.29.29', protocol: 'auto' }, { address: '223.6.6.6', protocol: 'tcp_udp' }, { address: 'dns.example', protocol: 'tcp' }, { address: '2400:3200::1', protocol: 'auto' },
]
const ecs = (g: Gen): Ecs => g.pick<Ecs>([null, null, { mode: 'clear' }, { mode: 'client', v4: 24, v6: 56 }, { mode: 'static', subnet: '1.2.3.0/24' }])

function outcome(g: Gen, groups: UpstreamGroup[], ruleGroups: RuleGroup[] | null): Outcome {
  const kind = g.pick(['upstream', 'upstream', 'upstream', 'block', 'block', 'answer', 'group', 'continue'])
  if (kind === 'upstream') return { type: 'upstream', group: g.pick(groups).id }
  if (kind === 'block') return { type: 'block', response: g.pick(['default', 'NXDOMAIN', 'REFUSED', 'SERVFAIL', 'NOERROR', 'zero'] as const) }
  if (kind === 'answer') {
    const k = g.pick(['ip', 'cname', 'txt'] as const)
    if (k === 'ip') return { type: 'answer', kind: 'ip', value: g.pick(['1.2.3.4', '1.2.3.4, ::1', '192.168.1.10']), ttl: null }
    if (k === 'cname') return { type: 'answer', kind: 'cname', value: g.pick(['target.example', 'nas.home.arpa.']), ttl: g.pick([null, 60, 3600]) }
    return { type: 'answer', kind: 'txt', value: g.pick(['kixdns', 'hello']), ttl: g.pick([null, 300]) }
  }
  if (kind === 'group' && ruleGroups?.length) return { type: 'group', group: g.pick(ruleGroups).id }
  return { type: 'continue' }
}
function remedy(g: Gen, groups: UpstreamGroup[]): Remedy {
  const kind = g.pick(['none', 'block', 'upstream', 'rewrite', 'answer'])
  if (kind === 'none') return { type: 'none' }
  if (kind === 'block') return { type: 'block', response: g.pick(['default', 'REFUSED', 'NXDOMAIN'] as const) }
  if (kind === 'upstream') return { type: 'upstream', group: g.pick(groups).id }
  if (kind === 'rewrite') return { type: 'rewrite_txt', value: 'v=spf1 -all' }
  return { type: 'answer', kind: 'ip', value: '0.0.0.0', ttl: null }
}

// 一组里同一个不填值的条件写两遍（客户端是内网 且 客户端是内网）：导入时并成一个，不是编辑器要管的错，这里不生成
// One valueless condition twice in a group (客户端是内网 and 客户端是内网): the import folds them into one, which is no mistake for the editor
// to flag, so none are generated
const repeatsValueless = (conds: { field: string; negate: boolean; values: string[] }[]) => conds.some((a, i) => !a.values.length && conds.some((b, j) => j !== i && b.field === a.field && b.negate === a.negate))

function rule(g: Gen, model: Model, ruleGroups: RuleGroup[] | null): Rule {
  for (let attempt = 0; attempt < 50; attempt++) {
    const groupsN = g.chance(0.15) ? 0 : g.int(1, g.chance(0.2) ? 2 : 1)
    const conditions: Condition[][] = groupsN === 0 ? [[]] : Array.from({ length: groupsN }, () => Array.from({ length: g.int(1, 3) }, () => requestCondition(g)))
    if (conditions.some(repeatsValueless)) continue
    const o = outcome(g, model.groups, ruleGroups)
    const r: Rule = {
      id: g.id(), name: g.pick(NAMES), note: g.chance(0.5) ? `note-${g.int(1, 1e6)}` : '', enabled: g.chance(0.85), conditions, outcome: o,
      log: g.chance(0.2) ? { enabled: true, level: g.pick(['info', 'warn', 'debug'] as const) } : { enabled: false, level: 'info' },
      ecs: 'inherit', response: inheritResponse(), edited: '导入',
    }
    if (o.type === 'upstream') {
      if (g.chance(0.2)) r.ecs = ecs(g)
      const mode = g.pick(['inherit', 'inherit', 'off', 'custom'] as const)
      if (mode === 'off') r.response = { ...inheritResponse(), mode: 'off' }
      if (mode === 'custom') {
        r.response = {
          mode: 'custom', match: g.pick(['all', 'any'] as const), conditions: Array.from({ length: g.int(1, 3) }, () => responseCondition(g)),
          then: remedy(g, model.groups), otherwise: g.chance(0.7) ? { type: 'none' } : remedy(g, model.groups),
          thenLog: g.chance(0.2) ? 'warn' : null, otherwiseLog: null,
        }
        if (repeatsValueless(r.response.conditions)) continue
      }
    }
    // 编辑器不收的（矛盾的一组、「全部满足」里两个多值条件……）重来 / Whatever the editor refuses (a contradictory group, two multi-valued
    // conditions under 「全部满足」…) is drawn again
    if (!ruleProblems({ ...model, ruleGroups: ruleGroups ?? model.ruleGroups }, r).length) return r
  }
  throw new Error('50 次都没生成出编辑器认可的规则')
}

const BLOCKLIST_FILE = `/var/lib/kixdns-panel/geo/blocklist-${'c'.repeat(64)}.json`

export function generateModel(seed: number): Model {
  const g = gen(seed)
  const groupIds = ['cn', 'abroad', 'corp', 'router', 'x-1']
  const groups: UpstreamGroup[] = []
  const groupCount = g.int(1, 4)
  for (let i = 0; i < groupCount; i++) {
    const addresses = values(g, ADDRESSES.map((_, n) => String(n)), 2).map((n) => ({ ...ADDRESSES[Number(n)]! }))
    groups.push({ id: groupIds[i]!, name: g.pick(['国内', '国外', '公司', '路由器', 'grp']) + (i ? `-${i}` : ''), addresses, ecs: ecs(g), fallback: { group: '', onError: false, onPolluted: false } })
  }
  for (const grp of groups) {
    if (groups.length > 1 && g.chance(0.3)) grp.fallback = { group: g.pick(groups.filter((x) => x !== grp)).id, onError: g.chance(0.5), onPolluted: g.chance(0.6) }
    if (groups.length > 1 && g.chance(0.05)) grp.fallback = { group: g.pick(groups.filter((x) => x !== grp)).id, onError: false, onPolluted: false }
  }
  for (const grp of groups) for (const a of grp.addresses) if (addressProblem(a)) throw new Error(`生成了编辑器不收的地址 ${a.address}`)
  for (const grp of groups) if (ecsProblem(grp.ecs)) throw new Error('生成了编辑器不收的子网')
  const model: Model = {
    format: '1.0', settings: { bind_udp: '127.0.0.1:5353', cache_capacity: 1000, ...(g.chance(0.5) ? { default_upstream: g.pick(['1.1.1.1:53', '9.9.9.9', '1.1.1.1, tcp://dns.example']) } : {}) },
    groups, rules: [], ruleGroups: [], mappings: [],
    rest: g.chance(0.8) ? { type: 'upstream', group: g.pick(groups).id } : { type: 'block', response: g.pick(['default', 'NXDOMAIN'] as const) },
    defaults: { block: g.pick(['NXDOMAIN', 'REFUSED', 'zero'] as const) }, blocklists: emptyBlocklists(),
  }
  const ruleGroups: RuleGroup[] = []
  const rgCount = g.chance(0.4) ? g.int(1, 2) : 0
  for (let i = 0; i < rgCount; i++) ruleGroups.push({ id: ['lan', 'kids'][i]!, name: ['内网', 'kids'][i]!, note: g.chance(0.5) ? 'rg-note' : '', rules: [], rest: g.pick<Outcome>([{ type: 'block', response: 'default' }, { type: 'upstream', group: g.pick(groups).id }, { type: 'block', response: 'NXDOMAIN' }]) })
  model.ruleGroups = ruleGroups
  for (const rg of ruleGroups) { const n = g.int(0, 3); for (let i = 0; i < n; i++) rg.rules.push(rule(g, model, null)) }
  const n = g.int(0, 8)
  for (let i = 0; i < n; i++) model.rules.push(rule(g, model, ruleGroups))
  const seen = new Set<string>()
  const mappingCount = g.chance(0.5) ? g.int(1, 3) : 0
  for (let i = 0; i < mappingCount; i++) {
    const domain = g.pick(['nas.home.arpa', '中文.example', '*.files.home.arpa', 'Printer.Home.Arpa', '例子。测试'])
    if (seen.has(domain)) continue
    seen.add(domain)
    const ip = g.chance(0.6)
    const m: Mapping = { id: g.id(), domain, target: ip ? g.pick(['192.168.1.10', '192.168.1.30, fd00::30']) : 'nas.home.arpa', ttl: ip ? null : g.pick([null, 600]), enabled: g.chance(0.85) }
    model.mappings.push(m)
  }
  if (g.chance(0.2)) model.blocklists = { ...emptyBlocklists(), custom: g.pick(['||ads.example^', '||ads.example^\n@@||ok.ads.example^', '/^track[0-9]+\\./\n||中文广告.example^']) }
  if (g.chance(0.15)) {
    const sub = { id: g.id(), name: '广告', url: 'https://lists.example/ads.txt', enabled: true }
    model.blocklists = { ...model.blocklists, subscriptions: [sub], file: BLOCKLIST_FILE, builtFor: sub.url }
  }
  if (outcomeProblem(model, model.rest)) throw new Error('生成的其余请求编辑器不收')
  return model
}
