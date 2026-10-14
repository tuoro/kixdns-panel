import type { QueryLogEntry, QueryLogItem, QueryLogOutcome, QueryLogPage, QueryLogSettings, QueryLogStep } from './types'

// 演示用的查询日志：按当前演示配置里的内核 Pipeline 生成，去向、规则名、上游地址都和配置对得上。全是演示数据，不是谁的真实查询。
// The demo query log: generated from the kernel pipelines of the current demo config, so destinations, rule names and upstream
// addresses match it. All demo data, nobody's real queries.

interface KAction { type?: unknown; upstream?: unknown; pipeline?: unknown; rcode?: unknown; ip?: unknown; target?: unknown; text?: unknown }
interface KRule { name?: unknown; actions?: unknown; response_matchers?: unknown; response_actions_on_match?: unknown }
interface KPipeline { id?: unknown; rules?: unknown }
interface KConfig { pipelines?: unknown; pipeline_select?: unknown }

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
const str = (v: unknown) => (typeof v === 'string' ? v : '')

// 固定种子的伪随机数：每次打开演示都是同一批数据 / A seeded generator: the demo shows the same data every time
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FOREIGN = ['www.google.com', 'api.github.com', 'github.com', 'www.youtube.com', 'i.ytimg.com', 'cdn.jsdelivr.net', 'registry.npmjs.org', 'www.reddit.com', 'discord.com', 'fonts.gstatic.com', 'play.googleapis.com', 'connectivitycheck.gstatic.com', 'en.wikipedia.org', 'objects.githubusercontent.com', 'dns.google', 'clients4.google.com']
const DOMESTIC = ['www.baidu.com', 'www.qq.com', 'weixin.qq.com', 'api.bilibili.com', 'i0.hdslb.com', 'www.taobao.com', 'g.alicdn.com', 'dns.weixin.qq.com', 'www.jd.com', 'mp.weixin.qq.com', 'p.music.126.net', 'www.zhihu.com', 'pic1.zhimg.com']
const APPLE = ['gateway.icloud.com', 'www.apple.com', 'is1-ssl.mzstatic.com', 'p55-caldav.icloud.com', 'gsa.apple.com']
const CORP = ['git.corp.example', 'wiki.corp.internal', 'mail.corp.example']
const ADS = ['ad.doubleclick.net', 'googleads.g.doubleclick.net', 'pagead2.googlesyndication.com', 'app-measurement.com', 'adservice.google.com', 'sdk.e.qq.com']
// 和演示的查询排行同一批客户端，从排行点进来有结果 / The same clients as the demo rankings, so a jump from there finds entries
const CLIENTS = ['192.168.1.12', '192.168.1.8', '192.168.1.27', '192.168.1.36', '192.168.1.5', 'fd00::1c']

interface Forward { id: string; addresses: string[]; checks: { rule: string; target: string }[] }
interface Destination { pipeline: string; rule: string | null; /** 规则所在的列表 / The list the rule sits in */ from: string; forward?: Forward; kind: 'forward' | 'block' | 'answer'; names: string[]; qtype?: string; answer?: string; rcode?: string; weight: number }

function destinations(config: KConfig): { entry: string; list: Destination[]; handoffs: Map<string, string> } {
  const pipelines = list<KPipeline>(config.pipelines)
  const select = list<{ pipeline?: unknown; matchers?: unknown }>(config.pipeline_select)
  const entry = str(select.find((s) => list(s.matchers).length === 0)?.pipeline) || str(pipelines[0]?.id)
  const forwards = new Map<string, Forward>()
  for (const p of pipelines) {
    const rules = list<KRule>(p.rules)
    const fwd = rules.flatMap((r) => list<KAction>(r.actions)).find((a) => str(a.type) === 'forward')
    if (!fwd) continue
    const checks = rules.flatMap((r) => list<KAction>(r.response_actions_on_match).filter((a) => str(a.type) === 'jump_to_pipeline').map((a) => ({ rule: str(r.name), target: str(a.pipeline) })))
    forwards.set(str(p.id), { id: str(p.id), addresses: str(fwd.upstream).split(',').map((a) => a.trim()).filter(Boolean), checks })
  }
  const out: Destination[] = []
  const domestic = (f: Forward) => f.addresses.some((a) => /doh\.pub|alidns|223\.5\.5\.5|119\.29/.test(a))
  const internal = (f: Forward) => f.addresses.every((a) => /(^|\/\/)(10\.|192\.168\.)/.test(a))
  for (const p of pipelines) {
    for (const r of list<KRule>(p.rules)) {
      const name = str(r.name)
      for (const a of list<KAction>(r.actions)) {
        const type = str(a.type)
        if (type === 'jump_to_pipeline' && forwards.has(str(a.pipeline))) {
          const f = forwards.get(str(a.pipeline))!
          const names = /苹果|apple/i.test(name) ? APPLE : internal(f) ? (name.includes('反查') || /router|路由/.test(f.id) ? ['23.1.168.192.in-addr.arpa', '1.1.168.192.in-addr.arpa'] : CORP) : domestic(f) ? DOMESTIC : FOREIGN
          out.push({ pipeline: f.id, rule: name, from: str(p.id), forward: f, kind: 'forward', names, qtype: names[0]!.endsWith('.arpa') ? 'PTR' : undefined, weight: name === '其余请求' ? 30 : names === DOMESTIC ? 26 : names === APPLE ? 8 : 2 })
        } else if (type === 'static_response' || type === 'deny' || (type === 'static_ip_response' && /^0\.0\.0\.0/.test(str(a.ip)))) {
          const rcode = type === 'deny' ? 'REFUSED' : type === 'static_response' ? str(a.rcode) || 'NXDOMAIN' : 'NOERROR'
          out.push({ pipeline: str(p.id), rule: name, from: str(p.id), kind: 'block', names: /doh|firefox|火狐/i.test(name) ? ['use-application-dns.net'] : ADS, rcode, answer: type === 'static_ip_response' ? '0.0.0.0' : undefined, weight: /doh|火狐/i.test(name) ? 1 : 7 })
        } else if (type === 'static_ip_response' || type === 'static_cname_response' || type === 'static_txt_response') {
          const mapped = /^域名映射 (.+)$/.exec(name)?.[1]
          const answer = type === 'static_txt_response' ? `"${list<string>(a.text)[0] ?? ''}"` : str(a.ip) || str(a.target)
          out.push({ pipeline: str(p.id), rule: name, from: str(p.id), kind: 'answer', names: mapped ? [mapped] : ['version.bind'], qtype: type === 'static_txt_response' ? 'TXT' : 'A', answer, weight: mapped ? 2 : 0.2 })
        }
      }
    }
  }
  // 入口自己就转发（旧格式的配置）：请求直接在入口那里交给上游 / The entry forwards itself (an older config): requests go to the upstream right there
  if (!out.some((d) => d.kind === 'forward') && forwards.has(entry)) out.push({ pipeline: entry, from: entry, rule: str(list<KRule>(list<KPipeline>(config.pipelines).find((p) => str(p.id) === entry)?.rules)[0]?.name) || null, forward: forwards.get(entry), kind: 'forward', names: [...FOREIGN, ...DOMESTIC], weight: 1 })
  // 入口里转去规则组的那几条：规则组里的请求先命中它们 / The entry's rules that hand off to a rule group: requests in a group hit them first
  const handoffs = new Map<string, string>()
  for (const r of list<KRule>(pipelines.find((p) => str(p.id) === entry)?.rules)) for (const a of list<KAction>(r.actions)) if (str(a.type) === 'jump_to_pipeline' && !forwards.has(str(a.pipeline))) handoffs.set(str(a.pipeline), str(r.name))
  return { entry, list: out, handoffs }
}

const host = (address: string) => address.replace(/^[a-z+]+:\/\//i, '')
const transportOf = (address: string) => (/^https:/i.test(address) ? 'DoH' : /^tls:/i.test(address) ? 'DoT' : /^quic:/i.test(address) ? 'DoQ' : /^tcp\+udp:/i.test(address) ? 'TCP+UDP' : /^tcp:/i.test(address) ? 'TCP' : 'UDP')

let cache: { key: string; items: QueryLogItem[] } | null = null

export function demoQueryLog(config: KConfig, now: number): QueryLogItem[] {
  const key = JSON.stringify(config.pipelines ?? null)
  if (cache?.key === key) return cache.items
  const rnd = random(20261014)
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!
  const { entry, list: dests, handoffs } = destinations(config)
  const total = dests.reduce((sum, d) => sum + d.weight, 0)
  const choose = () => { let x = rnd() * total; for (const d of dests) { x -= d.weight; if (x <= 0) return d } return dests[0]! }
  const items: QueryLogItem[] = []
  let time = now - 4_000
  const count = 640
  for (let i = 0; i < count; i++) {
    const seq = count - i + 1
    // 漏记的一段：面板升级重启那几秒内核的中转装满了 / A gap: the kernel's hand-over buffer filled while the panel restarted
    if (i === 420) { items.push({ seq, time_unix_ms: time, gap: 37 }); time -= 3_000; continue }
    const d = dests.length ? choose() : null
    if (!d) break
    const qname = pick(d.names)
    const qtype = d.qtype ?? (rnd() < 0.2 ? 'AAAA' : rnd() < 0.08 ? 'HTTPS' : 'A')
    const client = pick(CLIENTS)
    const transport = client.includes(':') ? 'udp' : rnd() < 0.08 ? 'doh' : rnd() < 0.06 ? 'tcp' : 'udp'
    const steps: QueryLogStep[] = [{ at_ms: 0, kind: 'pipeline', pipeline: entry }]
    const base: Omit<QueryLogEntry, 'outcome' | 'upstream' | 'rcode' | 'answers' | 'latency_ms' | 'error' | 'steps' | 'pipeline' | 'rule'> = { seq, time_unix_ms: time, client, transport, qname, qtype }
    const ip4 = () => `${pick([104, 142, 151, 172, 183, 203, 220])}.${Math.floor(rnd() * 255)}.${Math.floor(rnd() * 255)}.${Math.floor(rnd() * 254) + 1}`
    const answersFor = () => (qtype === 'AAAA' ? [`2408:8756:${Math.floor(rnd() * 9999)}::${Math.floor(rnd() * 99)}`] : qtype === 'PTR' ? ['router.home.arpa.'] : qtype === 'HTTPS' ? [] : Array.from({ length: 1 + Math.floor(rnd() * 2) }, ip4))
    let e: QueryLogEntry
    // 进到规则组：先是入口里转过去的那条规则 / Entering a rule group: first the entry rule that handed the request over
    const enterList = (to: string): QueryLogStep[] => [...(handoffs.has(to) ? [{ at_ms: 0.03, kind: 'rule' as const, pipeline: entry, rule: handoffs.get(to)!, target: to }] : []), { at_ms: 0.05, kind: 'pipeline', pipeline: to }]
    if (d.kind !== 'forward') {
      steps.push({ at_ms: 0.1, kind: 'rule', pipeline: d.pipeline, rule: d.rule ?? undefined, target: d.kind === 'block' ? 'block' : 'answer' })
      const latency = 0.1 + rnd() * 0.3
      const answers = d.kind === 'answer' ? [d.answer ?? ''] : d.answer ? [d.answer] : []
      steps.push({ at_ms: latency, kind: 'response', pipeline: d.pipeline, rcode: d.rcode ?? 'NOERROR' })
      e = { ...base, qtype: d.kind === 'answer' && d.qtype ? d.qtype : qtype, pipeline: d.pipeline, rule: d.rule, outcome: (d.kind === 'block' ? 'blocked' : 'answered') as QueryLogOutcome, upstream: null, rcode: d.rcode ?? 'NOERROR', answers, latency_ms: latency, error: null, steps }
      if (d.pipeline !== entry) steps.splice(1, 0, ...enterList(d.pipeline))
    } else {
      const f = d.forward!
      // 规则在规则组里时先进组；转到别的列表时再进那个列表 / A rule inside a rule group enters the group first; a hand-off to another list enters that list
      if (d.from !== entry) steps.push(...enterList(d.from))
      if (d.rule) steps.push({ at_ms: 0.08, kind: 'rule', pipeline: d.from, rule: d.rule, target: f.id })
      if (f.id !== d.from) steps.push({ at_ms: 0.1, kind: 'pipeline', pipeline: f.id })
      const roll = rnd()
      const domestic = d.names === DOMESTIC || d.names === APPLE
      const speed = (a: string) => (/^(10\.|192\.168\.)/.test(host(a)) ? 2 + rnd() * 4 : domestic ? 8 + rnd() * 26 : 24 + rnd() * 150)
      if (roll < 0.52) {
        const src = pick(f.addresses)
        const latency = 0.2 + rnd() * 0.8
        steps.push({ at_ms: latency * 0.6, kind: 'cache', pipeline: f.id, cache: 'fresh', upstream: host(src) }, { at_ms: latency, kind: 'response', pipeline: f.id, rcode: 'NOERROR' })
        e = { ...base, pipeline: f.id, rule: d.rule, outcome: 'cached', upstream: host(src), rcode: 'NOERROR', answers: answersFor(), latency_ms: latency, error: null, steps }
      } else if (roll < 0.535) {
        const latency = 4 + rnd() * 20
        steps.push({ at_ms: 0.3, kind: 'cache', pipeline: f.id, cache: 'miss' }, { at_ms: latency, kind: 'response', pipeline: f.id, rcode: 'NOERROR' })
        e = { ...base, pipeline: f.id, rule: d.rule, outcome: 'joined', upstream: host(f.addresses[0]!), rcode: 'NOERROR', answers: answersFor(), latency_ms: latency, error: null, steps }
      } else if (roll < 0.55) {
        // 上游全部超时：开了过期缓存先回旧结果 / Every upstream timed out: with stale serving on, the old answer goes back first
        const latency = 1800 + rnd() * 40
        steps.push({ at_ms: 0.3, kind: 'cache', pipeline: f.id, cache: 'miss' })
        for (const a of f.addresses) steps.push({ at_ms: 1800, kind: 'upstream', pipeline: f.id, upstream: host(a), transport: transportOf(a), result: 'error', error: '超时', latency_ms: 1800 })
        const stale = rnd() < 0.5
        if (stale) steps.push({ at_ms: latency, kind: 'cache', pipeline: f.id, cache: 'stale', upstream: host(f.addresses[0]!) })
        steps.push({ at_ms: latency, kind: 'response', pipeline: f.id, rcode: stale ? 'NOERROR' : 'SERVFAIL' })
        e = { ...base, pipeline: f.id, rule: d.rule, outcome: stale ? 'stale' : 'failed', upstream: stale ? host(f.addresses[0]!) : null, rcode: stale ? 'NOERROR' : 'SERVFAIL', answers: stale ? answersFor() : [], latency_ms: latency, error: stale ? null : '上游全部超时', steps }
      } else {
        steps.push({ at_ms: 0.3, kind: 'cache', pipeline: f.id, cache: 'miss' })
        const times = f.addresses.map((a) => ({ a, ms: speed(a) * (rnd() < 0.03 ? 18 : 1) })).sort((x, y) => x.ms - y.ms)
        const winner = times[0]!
        for (const t of times) steps.push({ at_ms: t.ms, kind: 'upstream', pipeline: f.id, upstream: host(t.a), transport: transportOf(t.a), result: t === winner ? 'won' : 'lost', rcode: 'NOERROR', latency_ms: t.ms })
        let final = f.id
        let upstream = host(winner.a)
        let latency = winner.ms + 0.4
        const check = f.checks[0]
        if (check) {
          // 国内组偶尔回被污染的地址：回答后检查改问备用组 / The domestic group now and then returns a polluted address; the answer check asks the fallback
          const polluted = domestic && rnd() < 0.04
          steps.push({ at_ms: latency, kind: 'check', pipeline: f.id, rule: check.rule, target: check.target, matched: polluted })
          const fb = polluted ? [...destinations(config).list].find((x) => x.forward?.id === check.target)?.forward : undefined
          if (polluted && fb) {
            const a = pick(fb.addresses)
            const ms = latency + 30 + rnd() * 120
            steps.push({ at_ms: latency + 0.1, kind: 'pipeline', pipeline: fb.id }, { at_ms: ms, kind: 'upstream', pipeline: fb.id, upstream: host(a), transport: transportOf(a), result: 'won', rcode: 'NOERROR', latency_ms: ms - latency })
            final = fb.id
            upstream = host(a)
            latency = ms + 0.3
          }
        }
        steps.push({ at_ms: latency, kind: 'response', pipeline: final, rcode: rnd() < 0.03 ? 'NXDOMAIN' : 'NOERROR' })
        const rcode = steps[steps.length - 1]!.rcode!
        e = { ...base, pipeline: final, rule: d.rule, outcome: 'forwarded', upstream, rcode, answers: rcode === 'NOERROR' ? answersFor() : [], latency_ms: latency, error: null, steps }
      }
    }
    items.push(e)
    time -= 1_000 + Math.floor(rnd() * 14_000)
  }
  cache = { key, items }
  return items
}

let settings: QueryLogSettings = { enabled: true, retention_hours: 2160, max_bytes: 500 * 1024 * 1024, anonymize_clients: false, ignored_domains: [], used_bytes: 327_155_712, oldest_unix_ms: null }

export function demoQueryLogSettings(now: number): QueryLogSettings {
  return { ...settings, oldest_unix_ms: settings.enabled ? now - 63 * 86_400_000 : settings.oldest_unix_ms }
}
export function setDemoQueryLogSettings(next: Partial<QueryLogSettings>): void {
  settings = { ...settings, ...next }
}
export function clearDemoQueryLog(): void {
  settings = { ...settings, used_bytes: 0 }
  cache = { key: cache?.key ?? '', items: [] }
}

const isGap = (item: QueryLogItem): item is Extract<QueryLogItem, { gap: number }> => 'gap' in item

// 演示「内核太旧」：localStorage 里设 kixdns:demo-querylog-unsupported = true / Demo an old kernel: set kixdns:demo-querylog-unsupported = true in localStorage
export const demoQueryLogSupported = (): boolean => typeof localStorage === 'undefined' || localStorage.getItem('kixdns:demo-querylog-unsupported') !== 'true'

export function demoQueryLogPage(config: KConfig, now: number, params: URLSearchParams): QueryLogPage {
  const supported = demoQueryLogSupported()
  if (!supported || !settings.enabled) return { protocol_version: 1, supported, enabled: settings.enabled, items: [], next_before: null, newest_seq: 0 }
  const all = demoQueryLog(config, now)
  const q = (params.get('q') ?? '').trim().toLowerCase()
  const pipelines = (params.get('pipelines') ?? '').split(',').filter(Boolean)
  const outcomes = (params.get('outcomes') ?? '').split(',').filter(Boolean)
  const client = params.get('client')
  const rule = params.get('rule')
  const rulePipeline = params.get('rule_pipeline')
  const rulePhase = params.get('rule_phase') === 'response' ? 'check' : 'rule'
  const upstream = params.get('upstream')
  const ignored = settings.ignored_domains
  const keep = (item: QueryLogItem) => {
    if (isGap(item)) return !q && !pipelines.length && !outcomes.length && !client && !rule && !upstream
    if (ignored.some((d) => item.qname === d || item.qname.endsWith(`.${d}`))) return false
    if (q && !item.qname.includes(q) && !item.client.includes(q)) return false
    if (pipelines.length && !pipelines.includes(item.pipeline)) return false
    if (outcomes.length && !outcomes.includes(item.outcome)) return false
    if (client && item.client !== client) return false
    // 规则按「哪个列表里的哪条」认，和命中数同一口径；上游按被问到的算 / A rule is matched as which rule in which list, as the hit counts are; an upstream counts when it was asked
    if (rule && !item.steps.some((st) => st.kind === rulePhase && (rulePhase === 'rule' || st.matched) && st.rule?.replace(/#\d+$/, '') === rule && (!rulePipeline || st.pipeline === rulePipeline))) return false
    if (upstream && !item.steps.some((st) => st.kind === 'upstream' && st.upstream === upstream)) return false
    return true
  }
  const before = Number(params.get('before') ?? Infinity)
  const limit = Math.min(Number(params.get('limit') ?? 200), 500)
  const matched = all.filter((item) => item.seq < before && keep(item))
  const items = matched.slice(0, limit)
  return { protocol_version: 1, supported, enabled: true, items, next_before: matched.length > limit ? items[items.length - 1]!.seq : null, newest_seq: all[0]?.seq ?? 0 }
}
