import type { QueryLogGap, QueryLogOutcome, QueryLogPage, QueryLogRecord, QueryLogSettings, QueryLogStepRecord } from './types'

// 演示用的查询日志：按当前演示配置里的内核 Pipeline 生成，去向、规则名、上游地址都和配置对得上；格式和面板接口一样（内核的说法），
// 页面照样先换成显示用的记录。全是演示数据，不是谁的真实查询。
// The demo query log: generated from the kernel pipelines of the current demo config, so destinations, rule names and upstream
// addresses match it; shaped like the panel API (the kernel's terms), so the page converts it to display records as it would real
// data. All demo data, nobody's real queries.

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

interface Forward { id: string; rule: string; addresses: string[]; checks: { rule: string; target: string }[] }
interface Destination { pipeline: string; rule: string | null; /** 规则所在的列表 / The list the rule sits in */ from: string; forward?: Forward; kind: 'forward' | 'block' | 'answer'; names: string[]; qtype?: string; answer?: string; rcode?: string; weight: number }

function destinations(config: KConfig): { entry: string; list: Destination[]; handoffs: Map<string, string> } {
  const pipelines = list<KPipeline>(config.pipelines)
  const select = list<{ pipeline?: unknown; matchers?: unknown }>(config.pipeline_select)
  const entry = str(select.find((s) => list(s.matchers).length === 0)?.pipeline) || str(pipelines[0]?.id)
  const forwards = new Map<string, Forward>()
  for (const p of pipelines) {
    const rules = list<KRule>(p.rules)
    const owner = rules.find((r) => list<KAction>(r.actions).some((a) => str(a.type) === 'forward'))
    const fwd = list<KAction>(owner?.actions).find((a) => str(a.type) === 'forward')
    if (!owner || !fwd) continue
    const checks = rules.flatMap((r) => list<KAction>(r.response_actions_on_match).filter((a) => str(a.type) === 'jump_to_pipeline').map((a) => ({ rule: str(r.name), target: str(a.pipeline) })))
    forwards.set(str(p.id), { id: str(p.id), rule: str(owner.name), addresses: str(fwd.upstream).split(',').map((a) => a.trim()).filter(Boolean), checks })
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

// 内核记的协议名 / The protocol names the kernel records
const protocolOf = (address: string) => (/^https:/i.test(address) ? 'doh' : /^tls:/i.test(address) ? 'dot' : /^quic:/i.test(address) ? 'doq' : /^tcp\+udp:/i.test(address) ? 'tcp_udp' : /^tcp:/i.test(address) ? 'tcp' : 'udp')
const us = (ms: number) => Math.round(ms * 1000)

type Item = QueryLogRecord | QueryLogGap
let cache: { key: string; items: Item[] } | null = null

export function demoQueryLog(config: KConfig, now: number): Item[] {
  const key = JSON.stringify(config.pipelines ?? null)
  if (cache?.key === key) return cache.items
  const rnd = random(20261014)
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!
  const { entry, list: dests, handoffs } = destinations(config)
  const total = dests.reduce((sum, d) => sum + d.weight, 0)
  const choose = () => { let x = rnd() * total; for (const d of dests) { x -= d.weight; if (x <= 0) return d } return dests[0]! }
  const items: Item[] = []
  let time = now - 4_000
  const count = 640
  for (let i = 0; i < count; i++) {
    const id = count - i + 1
    // 漏记的一段：面板升级重启那几秒内核的交接区装满了 / A gap: the kernel's hand-over ring filled while the panel restarted
    if (i === 420) { items.push({ id, time_unix_ms: time, gap: 37 }); time -= 3_000; continue }
    const d = dests.length ? choose() : null
    if (!d) break
    const qname = pick(d.names)
    const qtype = d.qtype ?? (rnd() < 0.2 ? 'AAAA' : rnd() < 0.08 ? 'HTTPS' : 'A')
    const client = pick(CLIENTS)
    const transport = client.includes(':') ? 'udp' : rnd() < 0.08 ? 'doh' : rnd() < 0.06 ? 'tcp' : 'udp'
    const steps: QueryLogStepRecord[] = [{ at_us: 0, kind: 'pipeline', pipeline: entry }]
    const base = { id, seq: 90_000 + id, time_unix_ms: time, client, transport, qname, qtype } as const
    const ip4 = () => `${pick([104, 142, 151, 172, 183, 203, 220])}.${Math.floor(rnd() * 255)}.${Math.floor(rnd() * 255)}.${Math.floor(rnd() * 254) + 1}`
    const answersFor = () => (qtype === 'AAAA' ? [`2408:8756:${Math.floor(rnd() * 9999)}::${Math.floor(rnd() * 99)}`] : qtype === 'PTR' ? ['router.home.arpa.'] : qtype === 'HTTPS' ? [] : Array.from({ length: 1 + Math.floor(rnd() * 2) }, ip4))
    let e: QueryLogRecord
    // 进到规则组：先是入口里转过去的那条规则 / Entering a rule group: first the entry rule that handed the request over
    const enterList = (to: string): QueryLogStepRecord[] => [...(handoffs.has(to) ? [{ at_us: 30, kind: 'rule' as const, pipeline: entry, rule: handoffs.get(to)!, phase: 'request' as const, decision: 'jump' as const, target: to }] : []), { at_us: 50, kind: 'pipeline' as const, pipeline: to }]
    if (d.kind !== 'forward') {
      if (d.pipeline !== entry) steps.push(...enterList(d.pipeline))
      steps.push({ at_us: 100, kind: 'rule', pipeline: d.pipeline, rule: d.rule ?? undefined, phase: 'request', decision: 'static' })
      const latency = 0.1 + rnd() * 0.3
      // 「空地址」只回 A、AAAA 的地址，别的类型是 NOERROR、没有记录 / 空地址 answers addresses for A and AAAA only; other types get NOERROR and no records
      const answers = d.kind === 'answer' ? [d.answer ?? ''] : d.answer && qtype === 'A' ? [d.answer] : []
      e = { ...base, qtype: d.kind === 'answer' && d.qtype ? d.qtype : qtype, latency_us: us(latency), status: 'completed', pipeline: d.pipeline, rule: d.rule ?? undefined, outcome: (d.kind === 'block' ? 'blocked' : 'answered') as QueryLogOutcome, rcode: d.rcode ?? 'NOERROR', answers, steps }
    } else {
      const f = d.forward!
      // 规则在规则组里时先进组；转到别的列表时再进那个列表 / A rule inside a rule group enters the group first; a hand-off to another list enters that list
      if (d.from !== entry) steps.push(...enterList(d.from))
      if (d.rule) steps.push({ at_us: 80, kind: 'rule', pipeline: d.from, rule: d.rule, phase: 'request', decision: 'jump', target: f.id })
      if (f.id !== d.from) steps.push({ at_us: 100, kind: 'pipeline', pipeline: f.id })
      // 上游组自己的那条转发规则：面板生成的，页面不单说 / The group's own forwarding rule: generated by the panel, not said on the page
      steps.push({ at_us: 120, kind: 'rule', pipeline: f.id, rule: f.rule, phase: 'request', decision: 'forward', target: f.addresses.join(',') })
      const roll = rnd()
      const domestic = d.names === DOMESTIC || d.names === APPLE
      const speed = (a: string) => (/^(10\.|192\.168\.)/.test(a) ? 2 + rnd() * 4 : domestic ? 8 + rnd() * 26 : 24 + rnd() * 150)
      const asked = (a: string, at: number, result: QueryLogStepRecord['result'], extra: Partial<QueryLogStepRecord> = {}): QueryLogStepRecord => ({ at_us: us(at), kind: 'upstream', upstream: a, transport: protocolOf(a), via: protocolOf(a) === 'tcp_udp' ? 'udp' : protocolOf(a), result, latency_us: us(at), ...extra })
      if (roll < 0.52) {
        const src = pick(f.addresses)
        const latency = 0.2 + rnd() * 0.8
        steps.push({ at_us: us(latency * 0.6), kind: 'cache', result: 'fresh', source: src })
        e = { ...base, latency_us: us(latency), status: 'completed', pipeline: f.id, rule: d.rule ?? undefined, outcome: 'cached', upstream: src, rcode: 'NOERROR', answers: answersFor(), steps }
      } else if (roll < 0.535) {
        const latency = 4 + rnd() * 20
        steps.push({ at_us: 300, kind: 'cache', result: 'miss' }, { at_us: us(latency * 0.9), kind: 'joined' })
        e = { ...base, latency_us: us(latency), status: 'completed', pipeline: f.id, rule: d.rule ?? undefined, outcome: 'joined', rcode: 'NOERROR', answers: answersFor(), steps }
      } else if (roll < 0.55) {
        // 上游全部超时：开了过期缓存先回旧结果 / Every upstream timed out: with stale serving on, the old answer goes back first
        const latency = 1800 + rnd() * 40
        steps.push({ at_us: 300, kind: 'cache', result: 'miss' })
        for (const a of f.addresses) steps.push(asked(a, 1800, 'error', { error: '超时' }))
        const stale = rnd() < 0.5
        if (stale) steps.push({ at_us: us(latency), kind: 'cache', result: 'stale_timeout', source: f.addresses[0]! })
        e = { ...base, latency_us: us(latency), status: 'completed', pipeline: f.id, rule: d.rule ?? undefined, outcome: stale ? 'stale' : 'failed', ...(stale ? { upstream: f.addresses[0]! } : { error: '上游全部超时' }), rcode: stale ? 'NOERROR' : 'SERVFAIL', answers: stale ? answersFor() : [], steps }
      } else if (roll < 0.553) {
        // 客户端等不及先走了 / The client gave up waiting
        const latency = 900 + rnd() * 400
        steps.push({ at_us: 300, kind: 'cache', result: 'miss' })
        e = { ...base, latency_us: us(latency), status: 'cancelled', pipeline: f.id, rule: d.rule ?? undefined, outcome: 'cancelled', answers: [], steps }
      } else {
        steps.push({ at_us: 300, kind: 'cache', result: 'miss' })
        const times = f.addresses.map((a) => ({ a, ms: speed(a) * (rnd() < 0.03 ? 18 : 1) })).sort((x, y) => x.ms - y.ms)
        const winner = times[0]!
        // 先回的那个用上，其余的不再等（内核把它们记成 aborted，没有响应码） / The first answer is used and the rest are not waited for (the kernel records them as aborted, with no code)
        for (const t of times) steps.push(t === winner ? asked(t.a, t.ms, 'success', { rcode: 'NOERROR' }) : asked(t.a, winner.ms + 0.05, 'aborted', { latency_us: us(winner.ms + 0.05) }))
        let final = f.id
        let upstream = winner.a
        let latency = winner.ms + 0.4
        const check = f.checks[0]
        if (check) {
          // 国内组偶尔回被污染的地址：回答后检查改问备用组 / The domestic group now and then returns a polluted address; the answer check asks the fallback
          const polluted = domestic && rnd() < 0.04
          steps.push({ at_us: us(latency), kind: 'rule', pipeline: f.id, rule: check.rule, phase: 'response', matched: polluted, ...(polluted ? { decision: 'jump' as const, target: check.target } : {}) })
          const fb = polluted ? [...destinations(config).list].find((x) => x.forward?.id === check.target)?.forward : undefined
          if (polluted && fb) {
            const a = pick(fb.addresses)
            const ms = latency + 30 + rnd() * 120
            steps.push({ at_us: us(latency + 0.1), kind: 'pipeline', pipeline: fb.id }, { at_us: us(latency + 0.12), kind: 'rule', pipeline: fb.id, rule: fb.rule, phase: 'request', decision: 'forward', target: fb.addresses.join(',') }, asked(a, ms, 'success', { rcode: 'NOERROR', latency_us: us(ms - latency) }))
            final = fb.id
            upstream = a
            latency = ms + 0.3
          }
        }
        const rcode = rnd() < 0.03 ? 'NXDOMAIN' : 'NOERROR'
        e = { ...base, latency_us: us(latency), status: 'completed', pipeline: final, rule: d.rule ?? undefined, outcome: 'forwarded', upstream, rcode, answers: rcode === 'NOERROR' ? answersFor() : [], steps }
      }
    }
    items.push(e)
    time -= 1_000 + Math.floor(rnd() * 14_000)
  }
  cache = { key, items }
  return items
}

let settings = { retention_hours: 2160, max_bytes: 500 * 1024 * 1024, ignored_domains: [] as string[], used_bytes: 327_155_712 }

// 演示「内核太旧」：localStorage 里设 kixdns:demo-querylog-unsupported = true / Demo an old kernel: set kixdns:demo-querylog-unsupported = true in localStorage
export const demoQueryLogSupported = (): boolean => typeof localStorage === 'undefined' || localStorage.getItem('kixdns:demo-querylog-unsupported') !== 'true'

export function demoQueryLogSettings(now: number): QueryLogSettings {
  return { ...settings, oldest_unix_ms: settings.used_bytes ? now - 63 * 86_400_000 : null, supported: demoQueryLogSupported() }
}
/** 和服务端一样：只改给了的那几项，域名小写、去掉两头的点 / As the server does: only the given fields change, domains lowercased with the dots at both ends dropped */
export function setDemoQueryLogSettings(next: Partial<QueryLogSettings>): void {
  const domains = next.ignored_domains?.map((d) => d.trim().replace(/^\*\./, '').replace(/^\.+|\.+$/g, '').toLowerCase()).filter(Boolean)
  settings = { ...settings, ...(next.retention_hours === undefined ? {} : { retention_hours: next.retention_hours }), ...(next.max_bytes === undefined ? {} : { max_bytes: next.max_bytes }), ...(domains ? { ignored_domains: [...new Set(domains)] } : {}) }
}
export function clearDemoQueryLog(): void {
  settings = { ...settings, used_bytes: 0 }
  cache = { key: cache?.key ?? '', items: [] }
}

const isGap = (item: Item): item is QueryLogGap => 'gap' in item
const ignored = (qname: string) => settings.ignored_domains.some((d) => qname === d || qname.endsWith(`.${d}`))

/**
 * 和服务端同样的筛选：q 不分大小写找域名或客户端；规则按「哪个列表里的哪条」认，回答后检查只算命中的那一步，内核拆开的
 * 「名字#N」算同一条；上游按被问到的算；有筛选时不出漏记行。kixdns:demo-querylog-scan-limit 演示一次只看那么多条、没凑满就交回
 * 看到哪儿。
 * The same filtering as the server: q finds the domain or client regardless of case; a rule is matched as which rule in which list, an
 * answer check counts only the step that matched, and the kernel's split 「name#N」 counts as one; an upstream counts when it was asked;
 * gap rows are left out under any filter. kixdns:demo-querylog-scan-limit plays a read that looks at only so many records and hands
 * back how far it got.
 */
export function demoQueryLogPage(config: KConfig, now: number, params: URLSearchParams): QueryLogPage {
  const supported = demoQueryLogSupported()
  const all = demoQueryLog(config, now)
  const newest_id = all[0]?.id ?? null
  const q = (params.get('q') ?? '').trim().toLowerCase()
  const pipelines = (params.get('pipelines') ?? '').split(',').filter(Boolean)
  const outcomes = (params.get('outcomes') ?? '').split(',').filter(Boolean)
  const client = params.get('client')
  const rule = params.get('rule')
  const rulePipeline = params.get('rule_pipeline')
  const response = params.get('rule_phase') === 'response'
  const upstream = params.get('upstream')
  const filtered = Boolean(q || pipelines.length || outcomes.length || client || rule || upstream)
  const keep = (item: Item) => {
    if (isGap(item)) return !filtered
    if (ignored(item.qname)) return false
    if (q && !item.qname.toLowerCase().includes(q) && !item.client.toLowerCase().includes(q)) return false
    if (pipelines.length && !pipelines.includes(item.pipeline ?? '')) return false
    if (outcomes.length && !outcomes.includes(item.outcome)) return false
    if (client && item.client !== client) return false
    if (rule && !item.steps.some((st) => st.kind === 'rule' && st.phase === (response ? 'response' : 'request') && (!response || st.matched) && st.rule?.replace(/#\d+$/, '') === rule && (!rulePipeline || st.pipeline === rulePipeline))) return false
    if (upstream && !item.steps.some((st) => st.kind === 'upstream' && st.upstream === upstream)) return false
    return true
  }
  const before = Number(params.get('before') ?? Infinity)
  const limit = Math.min(Number(params.get('limit') ?? 200), 500)
  const budget = Number((typeof localStorage === 'undefined' ? null : localStorage.getItem('kixdns:demo-querylog-scan-limit')) ?? Infinity)
  const items: Item[] = []
  let scanned = 0
  let scannedTo: number | null = null
  let lastScanned: number | null = null
  for (const item of all.filter((x) => x.id < before)) {
    if (scanned >= budget) return { items, next_before: lastScanned, newest_id, scanned_to_unix_ms: scannedTo, supported }
    scanned += 1
    scannedTo = item.time_unix_ms
    lastScanned = item.id
    if (!keep(item)) continue
    if (items.length === limit) return { items, next_before: items[items.length - 1]!.id, newest_id, scanned_to_unix_ms: scannedTo, supported }
    items.push(item)
  }
  return { items, next_before: null, newest_id, scanned_to_unix_ms: scannedTo, supported }
}
