// 照内核源码复刻的配置执行器：入口选择、规则求值、动作、回答阶段。只给测试用：验证「导入前后行为一致」。不进运行时。
// 依据（kixdns 681183c）：engine/pipeline.rs select_pipeline / evaluate_rules，engine/rules.rs 回答动作，
// matcher/mod.rs eval_match_chain 和加载时的运算符改写，config.rs compute_merged_forward。
// A config executor rebuilt from the kernel source: entry selection, rule evaluation, actions, the answer phase. It proves an
// import behaves like the original and backs the domain tester. Sources (kixdns 681183c): engine/pipeline.rs select_pipeline /
// evaluate_rules, engine/rules.rs response actions, matcher/mod.rs eval_match_chain and the load-time operator rewrite,
// config.rs compute_merged_forward.

import { effectiveOps, foldChain, mergedForward, normalizeAddress, splitAddrs, type KConfigLike, type KMatcher, type KRuleLike } from '../kernel'
export { effectiveOps, foldChain, mergedForward, normalizeAddress }
export type { KAction, KConfigLike, KMatcher, KPipelineLike, KRuleLike, KSelectorLike } from '../kernel'

export interface SimQuery { domain: string; client: string; qtype: string; qclass?: string; listener?: string; edns?: boolean }
export interface UpstreamReply { rcode: string; answers: string[]; upstream: string }
// 上游怎么回答由测试给：参数是问了哪组上游（归一化后）和带的子网 / The test decides upstream replies, given the normalized upstream set and the subnet sent
export type Responder = (upstreams: string[], ecs: string, q: SimQuery) => UpstreamReply
export interface SimStep { pipeline: string; rule: string; phase: 'request' | 'response'; decision: string }
export interface SimResult { rcode: string; answers: string[]; steps: SimStep[] }

// ---------- 示例 Geo 数据 / sample Geo data ----------
export const SIM_GEOSITE: Record<string, string[]> = {
  cn: ['baidu.com', 'qq.com', 'taobao.com', 'bilibili.com', 'apple.com.cn', 'aliyun.com', '163.com', 'cn'],
  'category-ads-all': ['doubleclick.net', 'googlesyndication.com', 'ads.example.com', 'adservice.google.com'],
  'category-porn': ['adult.example'],
  apple: ['apple.com', 'icloud.com', 'mzstatic.com'],
  google: ['google.com', 'youtube.com', 'gstatic.com'],
  'geolocation-!cn': ['google.com', 'github.com', 'wikipedia.org', 'localtest.me', 'example.com', 'example.org'],
}
const suffixOf = (domain: string, suffix: string) => { const s = suffix.toLowerCase().replace(/^\./, '').replace(/\.$/, ''); return domain === s || domain.endsWith(`.${s}`) }
export const inSimGeosite = (domain: string, cat: string) => (SIM_GEOSITE[cat.toLowerCase()] ?? []).some((s) => suffixOf(domain, s))

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const v4 = (ip: string) => { const m = IPV4.exec(ip); return m ? ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0 : null }
export function ipInCidr(ip: string, cidr: string): boolean {
  const [net, lenText] = cidr.trim().split('/')
  const a = v4(ip)
  const b = v4(net ?? '')
  if (a === null || b === null) return ip.toLowerCase() === (net ?? '').toLowerCase()
  const len = lenText === undefined ? 32 : Number(lenText)
  const mask = len === 0 ? 0 : (~0 << (32 - len)) >>> 0
  return ((a & mask) >>> 0) === ((b & mask) >>> 0)
}
export const isPrivateIp = (ip: string) => ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8'].some((c) => ipInCidr(ip, c)) || /^f[cd]/i.test(ip) || ip === '::1'
// 示例 GeoIP：内网是 private，首段为偶数的算 CN，其余算 US / Sample GeoIP: private ranges are 'private', an even first octet is CN, the rest US
export const countryOf = (ip: string) => (isPrivateIp(ip) ? 'PRIVATE' : (v4(ip) ?? 0) >>> 24 % 2 === 0 ? 'CN' : 'US')
const codes = (m: KMatcher) => (Array.isArray(m.country_codes) ? m.country_codes : String(m.country_codes ?? '').split(',')).map((c) => String(c).trim().toUpperCase())
const regexOf = (v: string) => { const ci = v.startsWith('(?i)'); try { return new RegExp(ci ? v.slice(4) : v, ci ? 'i' : '') } catch { return null } }

function requestMatch(m: KMatcher, q: SimQuery): boolean {
  const domain = q.domain.toLowerCase().replace(/\.$/, '')
  const value = String(m.value ?? '')
  switch (m.type) {
    case 'any': return true
    case 'listener_label': return (q.listener ?? 'default') === value
    case 'domain_suffix': return suffixOf(domain, value)
    case 'domain_regex': return regexOf(value)?.test(domain) ?? false
    case 'client_ip': return String(m.cidr ?? '').split(',').some((c) => c.trim() && ipInCidr(q.client, c))
    case 'geoip_country': return codes(m).includes(countryOf(q.client))
    case 'geoip_private': return isPrivateIp(q.client) === Boolean(m.expect)
    case 'qclass': return value.toUpperCase() === (q.qclass ?? 'IN')
    case 'edns_present': return (q.edns ?? true) === Boolean(m.expect)
    case 'geo_site': return inSimGeosite(domain, value)
    case 'geo_site_not': return !inSimGeosite(domain, value)
    case 'qtype': return value.toUpperCase() === q.qtype.toUpperCase()
    default: return false
  }
}
function responseMatch(m: KMatcher, q: SimQuery, r: UpstreamReply): boolean {
  const domain = q.domain.toLowerCase().replace(/\.$/, '')
  const value = String(m.value ?? '')
  const ips = r.answers.filter((a) => /^(A|AAAA) /.test(a)).map((a) => a.split(' ')[1]!)
  const cidrs = String(m.cidr ?? '').split(',').filter((c) => c.trim())
  switch (m.type) {
    case 'upstream_equals': return r.upstream === value
    case 'request_domain_suffix': return suffixOf(domain, value)
    case 'request_domain_regex': return regexOf(value)?.test(domain) ?? false
    case 'response_upstream_ip': return cidrs.some((c) => ipInCidr(r.upstream.replace(/^[a-z+_]+:/, '').split(':')[0] ?? '', c))
    case 'response_answer_ip': return ips.some((ip) => cidrs.some((c) => ipInCidr(ip, c)))
    case 'response_type': return r.answers.some((a) => a.split(' ')[0] === value.toUpperCase())
    case 'response_rcode': return r.rcode === value.toUpperCase()
    case 'response_qclass': return value.toUpperCase() === (q.qclass ?? 'IN')
    case 'response_edns_present': return true === Boolean(m.expect)
    case 'response_answer_ip_geoip_country': return ips.some((ip) => codes(m).includes(countryOf(ip)))
    case 'response_answer_ip_geoip_private': return ips.some((ip) => isPrivateIp(ip)) === Boolean(m.expect)
    case 'response_request_domain_geosite': return inSimGeosite(domain, value)
    case 'response_request_domain_geosite_not': return !inSimGeosite(domain, value)
    case 'response_txt_content': {
      const txts = r.answers.filter((a) => a.startsWith('TXT ')).map((a) => a.slice(4))
      const mode = String(m.mode ?? 'exact')
      return txts.some((t) => (mode === 'prefix' ? t.startsWith(value) : mode === 'regex' ? regexOf(value)?.test(t) ?? false : t === value))
    }
    default: return false
  }
}

// 子网按内核的缺省值补齐再比：from_client_ip 缺省 /24、/56，static 缺省 /24 / Subnets compare after the kernel's defaults: /24 and /56 for from_client_ip, /24 for static
function ecsKey(ecs: unknown): string {
  if (!ecs) return ''
  const e = ecs as Record<string, unknown>
  if (e.mode === 'from_client_ip') return `client/${Number(e.prefix_v4 ?? 24)}/${Number(e.prefix_v6 ?? 56)}`
  if (e.mode === 'static') return `static/${String(e.ip)}/${Number(e.prefix ?? 24)}`
  return String(e.mode)
}

// ---------- 执行 / execution ----------
type Decision =
  | { kind: 'static'; rcode: string; answers: string[] }
  | { kind: 'jump'; pipeline: string }
  | { kind: 'forward'; upstreams: string[]; ecs: string; rule: KRuleLike | null }

const RCODES = ['NOERROR', 'FORMERR', 'SERVFAIL', 'NXDOMAIN', 'NOTIMP', 'REFUSED', 'YXDOMAIN', 'YXRRSET', 'NXRRSET', 'NOTAUTH', 'NOTZONE']
const parseRcode = (r: string) => { const u = String(r).toUpperCase(); return RCODES.includes(u) ? u : 'NXDOMAIN' }
function staticIp(ipList: string, qtype: string): { rcode: string; answers: string[] } {
  const ips = splitAddrs(ipList)
  if (ips.some((ip) => v4(ip) === null && !ip.includes(':'))) return { rcode: 'SERVFAIL', answers: [] }
  const q = qtype.toUpperCase()
  return { rcode: 'NOERROR', answers: ips.filter((ip) => (ip.includes(':') ? q === 'AAAA' || q === 'ANY' : q === 'A' || q === 'ANY')).map((ip) => `${ip.includes(':') ? 'AAAA' : 'A'} ${ip}`) }
}

export function simulate(cfg: KConfigLike, q: SimQuery, respond: Responder): SimResult {
  const pipelines = cfg.pipelines ?? []
  const byId = new Map(pipelines.map((p) => [p.id, p]))
  const settings = cfg.settings ?? {}
  const defaultUp = String(settings.default_upstream ?? '1.1.1.1:53')
  const jumpLimit = Number(settings.response_jump_limit ?? 10)
  const steps: SimStep[] = []
  const defaultForward = (): Decision => ({ kind: 'forward', upstreams: splitAddrs(defaultUp).map((a) => normalizeAddress(a)).sort(), ecs: '', rule: null })

  // select_pipeline：第一个命中的入口；都不中就用第一个 Pipeline / the first matching entry, else the first pipeline
  let entry = pipelines[0]?.id ?? 'default'
  for (const s of cfg.pipeline_select ?? []) {
    if (foldChain(s.matchers ?? [], s.matcher_operator, (m) => requestMatch(m, q)) && byId.has(s.pipeline)) { entry = s.pipeline; break }
  }

  function decide(pid: string): Decision {
    const p = byId.get(pid)
    if (!p) return defaultForward()
    for (const rule of p.rules ?? []) {
      if (!foldChain(rule.matchers ?? [], rule.matcher_operator, (m) => requestMatch(m, q))) continue
      const actions = rule.actions ?? []
      if (actions.filter((a) => a.type === 'forward').length > 1) {
        steps.push({ pipeline: pid, rule: rule.name, phase: 'request', decision: 'forward' })
        return { kind: 'forward', upstreams: mergedForward(actions).map((a) => normalizeAddress(a)).sort(), ecs: '', rule }
      }
      for (const a of actions) {
        const done = (d: Decision): Decision => { steps.push({ pipeline: pid, rule: rule.name, phase: 'request', decision: d.kind }); return d }
        if (a.type === 'static_response') return done({ kind: 'static', rcode: parseRcode(String(a.rcode)), answers: [] })
        if (a.type === 'static_ip_response') return done({ kind: 'static', ...staticIp(String(a.ip), q.qtype) })
        if (a.type === 'static_cname_response') return done({ kind: 'static', rcode: String(a.target ?? '').trim() ? 'NOERROR' : 'SERVFAIL', answers: [`CNAME ${String(a.target).trim()} ${a.ttl ?? 300}`] })
        if (a.type === 'static_txt_response') return done({ kind: 'static', rcode: 'NOERROR', answers: [`TXT ${(a.text as string[] | string)}`] })
        if (a.type === 'jump_to_pipeline') return done({ kind: 'jump', pipeline: String(a.pipeline) })
        if (a.type === 'allow') return done(defaultForward())
        if (a.type === 'deny') return done({ kind: 'static', rcode: 'REFUSED', answers: [] })
        if (a.type === 'forward') {
          const t = String(a.transport ?? 'udp')
          const up = typeof a.upstream === 'string' && a.upstream ? splitAddrs(a.upstream) : splitAddrs(defaultUp)
          return done({ kind: 'forward', upstreams: up.map((x) => normalizeAddress(x, t)).sort(), ecs: ecsKey(a.ecs), rule })
        }
        if (a.type === 'replace_txt_response' || a.type === 'continue') break
        // log：不决定，接着看下一个动作 / log decides nothing; the next action follows
      }
    }
    return defaultForward()
  }

  function run(pid: string, jumpsLeft: number, depth: number): { rcode: string; answers: string[] } {
    if (depth > 32) return { rcode: 'SERVFAIL', answers: [] }
    const d = decide(pid)
    if (d.kind === 'static') return d
    if (d.kind === 'jump') return run(d.pipeline, jumpsLeft, depth + 1)
    let reply = respond(d.upstreams, d.ecs, q)
    const rule = d.rule
    const onMatch = rule?.response_actions_on_match ?? []
    const onMiss = rule?.response_actions_on_miss ?? []
    if (!rule || (!onMatch.length && !onMiss.length)) return reply
    const matched = foldChain(rule.response_matchers ?? [], rule.response_matcher_operator, (m) => responseMatch(m, q, reply))
    steps.push({ pipeline: pid, rule: rule.name, phase: 'response', decision: matched ? 'match' : 'miss' })
    let forwards = 0
    for (const a of matched ? onMatch : onMiss) {
      if (a.type === 'log') continue
      if (a.type === 'static_response') return { rcode: parseRcode(String(a.rcode)), answers: [] }
      if (a.type === 'static_ip_response') return staticIp(String(a.ip), q.qtype)
      if (a.type === 'static_cname_response') return { rcode: 'NOERROR', answers: [`CNAME ${String(a.target).trim()} ${a.ttl ?? 300}`] }
      if (a.type === 'static_txt_response') return { rcode: 'NOERROR', answers: [`TXT ${(a.text as string[] | string)}`] }
      if (a.type === 'deny') return { rcode: 'REFUSED', answers: [] }
      if (a.type === 'jump_to_pipeline') return jumpsLeft > 0 ? run(String(a.pipeline), jumpsLeft - 1, depth + 1) : { rcode: 'SERVFAIL', answers: [] }
      if (a.type === 'allow' || a.type === 'continue') return reply
      if (a.type === 'replace_txt_response') return { rcode: reply.rcode, answers: [`TXT ${(a.text as string[] | string)}`] }
      if (a.type === 'forward') {
        if (++forwards > 4) return { rcode: 'SERVFAIL', answers: [] }
        const t = String(a.transport ?? 'udp')
        const up = typeof a.upstream === 'string' && a.upstream ? splitAddrs(a.upstream).map((x) => normalizeAddress(x, t)).sort() : d.upstreams
        reply = respond(up, '', q)
      }
    }
    return reply
  }

  const out = run(entry, jumpLimit, 0)
  return { rcode: out.rcode, answers: [...out.answers].sort(), steps }
}

// ---------- 行为对照 / behaviour check ----------
// 同一批查询分别跑两份配置，比客户端拿到的回答。上游的回答取决于问了哪组上游、带没带子网，所以路由走错一处就对不上。
// Runs the same queries through two configs and compares what the client gets. Upstream replies depend on which upstreams were asked and
// with which subnet, so any misroute shows.
const fnvHash = (s: string) => [...s].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261)
export const checkResponder: Responder = (ups, ecs, q) => {
  const h = fnvHash(`${ups.join('|')}#${ecs}/${q.domain}/${q.qtype}`)
  const upstream = ups[0] ?? ''
  if (ups.some((u) => u.includes('10.0.0.53'))) return { rcode: 'SERVFAIL', answers: [], upstream }
  if (q.domain.startsWith('polluted.')) return { rcode: 'NOERROR', answers: ['A 0.0.0.0'], upstream }
  if (q.domain.startsWith('private.')) return { rcode: 'NOERROR', answers: ['A 10.9.8.7'], upstream }
  if (q.domain.startsWith('missing.')) return { rcode: 'NXDOMAIN', answers: [], upstream }
  if (q.qtype === 'TXT') return { rcode: 'NOERROR', answers: [`TXT v=spf1 include:${h % 97}`], upstream }
  return { rcode: 'NOERROR', answers: [q.qtype === 'AAAA' ? `AAAA 2001:db8::${h % 997}` : `A ${h % 223}.${(h >>> 8) % 255}.1.${h % 250}`], upstream }
}
export function checkQueries(cfg: KConfigLike, limit = Infinity): SimQuery[] {
  const domains = new Set<string>(['example.net', 'www.example.com', 'random.test'])
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if ((o.type === 'domain_suffix' || o.type === 'request_domain_suffix') && typeof o.value === 'string' && o.value) { domains.add(o.value); domains.add(`www.${o.value}`) }
      Object.values(o).forEach(walk)
    }
  }
  walk(cfg)
  for (const list of Object.values(SIM_GEOSITE)) for (const d of list.slice(0, 3)) { domains.add(d); domains.add(`www.${d}`) }
  for (const d of [...domains].slice(0, 12)) { domains.add(`polluted.${d}`); domains.add(`private.${d}`); domains.add(`missing.${d}`) }
  const out: SimQuery[] = []
  for (const domain of domains) for (const client of ['192.168.1.20', '192.168.1.101', '192.168.50.8', '10.0.0.5', '8.8.4.4', '1.2.3.4']) for (const qtype of ['A', 'AAAA', 'TXT', 'PTR', 'MX']) for (const listener of ['default', 'lan']) out.push({ domain, client, qtype, listener })
  out.push({ domain: 'version.bind', client: '192.168.1.20', qtype: 'TXT', qclass: 'CH' })
  return out.slice(0, limit)
}
export interface CheckResult { checked: number; mismatches: { query: SimQuery; before: string; after: string }[] }
export function behaviourCheck(original: KConfigLike, regenerated: KConfigLike, limit = Infinity): CheckResult {
  const mismatches: CheckResult['mismatches'] = []
  const qs = checkQueries(original, limit)
  for (const q of qs) {
    const a = simulate(original, q, checkResponder)
    const b = simulate(regenerated, q, checkResponder)
    if (a.rcode !== b.rcode || a.answers.join() !== b.answers.join()) mismatches.push({ query: q, before: `${a.rcode} ${a.answers.join(', ')}`, after: `${b.rcode} ${b.answers.join(', ')}` })
  }
  return { checked: qs.length, mismatches }
}
