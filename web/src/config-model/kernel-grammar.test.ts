import { afterEach, describe, expect, it } from 'vitest'
import { SUGGEST } from './condKinds'
import { CONFIG_QTYPE_NAMES_V1, QTYPE_NAMES, setKernelCapabilities } from './grammar'
import { importKernel } from './importer'
import { compile, newRule, ruleProblems, type Condition, type ConditionField, type Ecs, type Model, type Outcome, type Remedy, type ResponseCondition, type ResponseField, type Rule } from './model'
import { behaviourCheck, checkResponder, foldChain, simulate, type KConfigLike, type KMatcher } from './testing/kernel-sim'
import { sampleModel } from './testing/samples'

// 编辑器认的写法要和内核认的一样：内核拒绝的，保存前就在页面上报出来；内核另作解释的，不能悄悄写出去。
// 下面「内核认不认」的答案都是拿 kixdns d2b5fc3 的 config::validate 一条条跑出来的（旧内核只认的十种记录类型照 a5126b9 之前的
// parse_dns_type）
// The editor must accept what the kernel accepts: what the kernel refuses is raised on the page before saving, and what the kernel
// would read some other way is never written out silently. Every "does the kernel take it" answer below was run through the
// config::validate of kixdns d2b5fc3 (the ten record types older kernels take follow parse_dns_type before a5126b9)

// parse_dns_type、parse_dns_class 认的记录类型和类别，response_rcode 认的响应码（另外还有明写的 OTHER）。新内核的记录类型照
// hickory-proto 0.26.3 RecordType::from_str 抄（* 是 ANY 的另一个写法），旧内核的是 a5126b9 之前 parse_dns_type 的十种
// The record types and classes parse_dns_type and parse_dns_class take, and the rcodes response_rcode takes (an explicit OTHER besides).
// A new kernel's record types are copied from hickory-proto 0.26.3's RecordType::from_str (* being another spelling of ANY), an older
// kernel's are the ten of parse_dns_type before a5126b9
const HICKORY_QTYPES = [
  'A', 'AAAA', 'ANAME', 'AXFR', 'CAA', 'CDNSKEY', 'CERT', 'CDS', 'CNAME', 'CSYNC', 'DNAME', 'DNSKEY', 'DS', 'HINFO', 'HTTPS', 'KEY', 'MX', 'NAPTR', 'NSEC',
  'NSEC3', 'NSEC3PARAM', 'NS', 'NULL', 'OPENPGPKEY', 'PTR', 'RRSIG', 'SIG', 'SMIMEA', 'SOA', 'SRV', 'SSHFP', 'SVCB', 'TLSA', 'TXT', 'TSIG', 'ANY',
]
const LEGACY_QTYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'PTR', 'SOA', 'SRV', 'OPT']
const KERNEL_QCLASSES = ['IN', 'CH', 'CHAOS', 'HS']
const KERNEL_RCODES = ['NOERROR', 'FORMERR', 'SERVFAIL', 'NXDOMAIN', 'NOTIMP', 'REFUSED']

let ids = 50_000
const id = () => ids++
const cond = (field: ConditionField, values: string[], negate = false, extra: Partial<Condition> = {}): Condition => ({ id: id(), field, values, negate, ...extra })
const rcond = (field: ResponseField, values: string[], negate = false, extra: Partial<ResponseCondition> = {}): ResponseCondition => ({ id: id(), field, values, negate, ...extra })
const ruleWith = (conditions: Condition[][], outcome: Outcome = { type: 'block', response: 'NXDOMAIN' }): Rule => ({ ...newRule(id(), outcome), conditions })
const modelWith = (rules: Rule[]): Model => ({ ...sampleModel(), rules })
const checked = (response: Partial<Rule['response']>): Rule => ({ ...ruleWith([[]], { type: 'upstream', group: 'cn' }), response: { mode: 'custom', match: 'any', conditions: [], then: { type: 'block', response: 'REFUSED' }, otherwise: { type: 'none' }, ...response } })
const problemsOf = (rule: Rule) => ruleProblems(modelWith([rule]), rule)
const mainRules = (m: Model) => compile(m).pipelines.find((p) => p.id === 'main')!.rules
const blocked = (cfg: KConfigLike, client: string, domain = 'www.example.com') => simulate(cfg, { domain, client, qtype: 'A' }, checkResponder).rcode === 'NXDOMAIN'

describe('客户端 IP 填几个网段', () => {
  // 规则里的 client_ip 只认一个网段（matcher/mod.rs client_net），写成「a,b」整份配置都存不进去
  // A rule's client_ip takes one network only (matcher/mod.rs client_net); written as 「a,b」 the whole config is refused
  const nets = ['192.168.1.0/24', '10.0.0.0/8']
  const cidrs = (m: Model) => mainRules(m).flatMap((r) => r.matchers).filter((x) => x.type === 'client_ip').map((x) => String(x.cidr))

  it('「在」几个网段：每个网段一个 client_ip，客户端在其中一个就命中', () => {
    const m = modelWith([ruleWith([[cond('client_ip', nets)]])])
    expect(cidrs(m)).toEqual(nets)
    const cfg = compile(m) as KConfigLike
    expect([blocked(cfg, '192.168.1.20'), blocked(cfg, '10.0.0.5'), blocked(cfg, '8.8.4.4')]).toEqual([true, true, false])
  })

  it('「不在」几个网段：每个网段一个「且不是」，哪个都不在才命中', () => {
    const m = modelWith([ruleWith([[cond('client_ip', nets, true)]])])
    expect(cidrs(m)).toEqual(nets)
    const cfg = compile(m) as KConfigLike
    expect([blocked(cfg, '192.168.1.20'), blocked(cfg, '10.0.0.5'), blocked(cfg, '8.8.4.4')]).toEqual([false, false, true])
  })

  it('导入内核认的写法（两个 client_ip「或」起来、两个「且不是」），写回去还是内核认的，行为不变', () => {
    for (const [first, second] of [['and', 'or'], ['and', 'and_not']]) {
      const matchers = second === 'or' ? [{ type: 'client_ip', cidr: nets[0], operator: first }, { type: 'client_ip', cidr: nets[1], operator: second }] : [{ type: 'any', operator: 'and' }, { type: 'client_ip', cidr: nets[0], operator: 'and_not' }, { type: 'client_ip', cidr: nets[1], operator: 'and_not' }]
      const original: KConfigLike = { version: '1.0', settings: { default_upstream: '1.1.1.1:53' }, pipeline_select: [{ pipeline: 'main', matchers: [] }], pipelines: [{ id: 'main', rules: [{ name: 'lan', matchers, actions: [{ type: 'static_response', rcode: 'NXDOMAIN' }] }] }] }
      const again = compile(importKernel(original).model) as KConfigLike
      expect(again.pipelines!.flatMap((p) => p.rules ?? []).flatMap((r) => r.matchers ?? []).filter((x) => x.type === 'client_ip').map((x) => String(x.cidr))).toEqual(nets)
      expect(behaviourCheck(original, again).mismatches.slice(0, 3)).toEqual([])
    }
  })

  it('模拟器和内核一样只认一个网段：写成「a,b」就当内核拒绝', () => {
    const cfg: KConfigLike = { version: '1.0', settings: {}, pipeline_select: [{ pipeline: 'main', matchers: [] }], pipelines: [{ id: 'main', rules: [{ name: 'lan', matchers: [{ type: 'client_ip', cidr: nets.join(',') }], actions: [{ type: 'deny' }] }] }] }
    expect(() => simulate(cfg, { domain: 'a.example', client: '10.0.0.5', qtype: 'A' }, checkResponder)).toThrow()
    // 回答阶段的网段是列表（cidr_list），每一项都要是网段 / Answer-phase networks are a list (cidr_list), every item a network
    const answers: KConfigLike = { version: '1.0', settings: {}, pipeline_select: [{ pipeline: 'main', matchers: [] }], pipelines: [{ id: 'main', rules: [{ name: 'up', matchers: [], actions: [{ type: 'forward', upstream: '1.1.1.1:53' }], response_matchers: [{ type: 'response_answer_ip', cidr: '0.0.0.0/32,10.0.0.0/33' }], response_actions_on_match: [{ type: 'deny' }] }] }] }
    expect(() => simulate(answers, { domain: 'a.example', client: '10.0.0.5', qtype: 'A' }, checkResponder)).toThrow()
  })
})

// 条件表单答应的意思：「是 / 在 / 属于」几个值里中一个就算，「不是 / 不在 / 不属于」几个值全都不符合才算；「全部」每个条件都要算，「任一」中一个就行。
// 编出来的内核条件链（照 eval_match_chain 从左往右折）在每一种情形下都要和它一样；做不到的写法，ruleProblems 要先拦下来
// What the condition form promises: 是 / 在 / 属于 holds when one of the values does, 不是 / 不在 / 不属于 only when none does; 全部 needs every
// condition and 任一 one of them. The compiled kernel chain (folded left to right as eval_match_chain does) must agree in every case;
// what it cannot express, ruleProblems must stop first
const holds = (m: KMatcher, world: Set<string>): boolean => {
  if (m.type === 'any') return true
  if (m.type === 'client_ip' && String(m.cidr).includes(',')) throw new Error('内核不认：client_ip 只能写一个网段')
  const listed = m.cidr !== undefined ? String(m.cidr).split(',') : Array.isArray(m.country_codes) ? m.country_codes.map(String) : [String(m.value)]
  const hit = listed.some((v) => world.has(v.trim()))
  return m.type.endsWith('_not') ? !hit : hit
}
const promise = (c: { negate: boolean; values: string[] }, world: Set<string>) => c.values.some((v) => world.has(v)) !== c.negate
const worldsOf = (tokens: string[]) => Array.from({ length: 2 ** tokens.length }, (_, n) => new Set(tokens.filter((_, i) => n & (1 << i))))

describe('编出来的条件链和表单说的一样', () => {
  const REQUEST: [ConditionField, string[]][] = [['domain', ['a.example', 'b.example']], ['geosite', ['cn', 'google']], ['client_ip', ['10.0.0.0/8', '192.168.0.0/16']], ['client_country', ['CN', 'US']], ['qtype', ['A', 'AAAA']], ['qclass', ['IN', 'CH']]]
  it.each(REQUEST)('请求条件 %s', (field, values) => {
    for (const [n1, n2] of [[false, false], [false, true], [true, false], [true, true]] as const) {
      const groups = [[cond(field, values, n1), cond('domain', ['y.example'], n2)]]
      const rule = ruleWith(groups)
      const chains = mainRules(modelWith([rule])).filter((r) => r.name.startsWith(`rule-${rule.id}`))
      for (const world of worldsOf([...values, 'y.example'])) {
        const want = groups.some((g) => g.every((c) => promise(c, world)))
        expect(chains.some((r) => foldChain(r.matchers, r.matcher_operator, (m) => holds(m, world))), `${n1 ? '不' : ''}${field} ${n2 ? '不' : ''}y [${[...world]}]`).toBe(want)
      }
    }
  })

  const RESPONSE: [ResponseField, string[], Partial<ResponseCondition>?][] = [
    ['rcode', ['SERVFAIL', 'REFUSED']], ['answer_type', ['A', 'AAAA']], ['upstream', ['10.0.0.53:53', '10.0.0.54:53']], ['qclass', ['IN', 'CH']],
    ['request_domain', ['a.example', 'b.example']], ['request_geosite', ['cn', 'google']], ['txt', ['v=spf1', 'v=dkim1'], { txtMode: 'exact' }],
    ['answer_ip', ['10.0.0.0/8', '192.168.0.0/16']], ['upstream_ip', ['10.0.0.0/8', '192.168.0.0/16']], ['answer_country', ['CN', 'US']],
  ]
  const GUARDS = ['「全部满足」时只能有一个条件填多个值，其余的拆成单独的条件或改成「满足任一」', '「满足任一」时，「不是」的条件只能填一个值，几个值拆成几条']
  it.each(RESPONSE)('回答条件 %s', (field, values, extra = {}) => {
    for (const match of ['all', 'any'] as const) {
      for (const pair of [[false], [true], [false, false], [false, true], [true, false], [true, true]]) {
        const conditions = [rcond(field, values, pair[0], extra), ...(pair.length > 1 ? [rcond('rcode', ['NXDOMAIN'], pair[1])] : [])]
        const rule = checked({ match, conditions })
        const problems = problemsOf(rule)
        if (problems.length) { expect(GUARDS).toContain(problems[0]); continue }
        const k = compile(modelWith([rule])).pipelines.find((p) => p.id === `rule-${rule.id}`)!.rules[0]!
        for (const world of worldsOf([...values, 'NXDOMAIN'])) {
          const want = match === 'all' ? conditions.every((c) => promise(c, world)) : conditions.some((c) => promise(c, world))
          expect(foldChain(k.response_matchers, k.response_matcher_operator, (m) => holds(m, world)), `${match} ${pair.map((n) => (n ? '不' : '是')).join('/')} [${[...world]}]`).toBe(want)
        }
      }
    }
  })
})

describe('内核不认的值，编辑器也不认', () => {
  afterEach(() => setKernelCapabilities([]))

  it('记录类型、类别、响应码的建议都是内核认的', () => {
    for (const field of ['qtype', 'answer_type']) expect([...SUGGEST[field]!].sort()).toEqual([...LEGACY_QTYPES].sort())
    expect(SUGGEST.qclass!.filter((v) => !KERNEL_QCLASSES.includes(v))).toEqual([])
    expect(SUGGEST.rcode!.filter((v) => !KERNEL_RCODES.includes(v))).toEqual([])
  })

  // 有 config_qtype_names_v1 的内核：hickory 认的类型名一个不少、一个不多，建议的就是这些 / A kernel with config_qtype_names_v1: exactly the
  // type names hickory knows, none missing and none extra, and those are what is suggested
  it('新内核认 hickory 的全部类型名，建议也是这些', () => {
    expect([...QTYPE_NAMES].sort()).toEqual([...HICKORY_QTYPES].sort())
    setKernelCapabilities([CONFIG_QTYPE_NAMES_V1])
    for (const field of ['qtype', 'answer_type']) expect([...SUGGEST[field]!].sort()).toEqual([...HICKORY_QTYPES].sort())
    expect(problemsOf(ruleWith([[cond('qtype', ['HTTPS', 'svcb', 'TYPE65', '*'])]]))).toEqual([])
    expect(problemsOf(checked({ conditions: [rcond('answer_type', ['CAA', 'type4321'])] }))).toEqual([])
    // OPT 不在 hickory 的名字里，只能写成 TYPE41；说的是能写什么 / OPT is no hickory name and is written TYPE41; what may be written is said
    expect(problemsOf(ruleWith([[cond('qtype', ['OPT', 'HTTPSS', 'TYPE70000'])]]))).toEqual(['「查询类型」里标红的 KixDNS 不认，能用的是 HTTPS、SVCB、CAA 这样的记录类型名，或 TYPE65 这样的数字写法'])
    setKernelCapabilities([])
    expect(problemsOf(ruleWith([[cond('qtype', ['HTTPS'])]]))).toEqual(['「查询类型」里标红的 KixDNS 不认，能用的是 A、AAAA、CNAME、MX、TXT、NS、PTR、SRV、SOA、OPT'])
  })

  it.each([
    ['查询类型 HTTPS', [cond('qtype', ['A', 'HTTPS'])]],
    ['查询类型 ANY', [cond('qtype', ['ANY'], true)]],
    ['查询类别 ANY', [cond('qclass', ['ANY'])]],
    ['域名正则带前向断言', [cond('domain', ['^(?=ads)'], false, { regex: true })]],
    ['域名正则带反向引用', [cond('domain', ['(a)\\1'], false, { regex: true })]],
    ['域名正则带 \\0', [cond('domain', ['a\\0'], true, { regex: true })]],
    ['网段前缀超过 32', [cond('client_ip', ['10.0.0.0/99'])]],
    ['IPv6 前缀超过 128', [cond('client_ip', ['2001:db8::/129'])]],
    ['IPv6 里三个冒号', [cond('client_ip', ['1:::2'])]],
    ['IPv6 两个 ::', [cond('client_ip', ['1::2::3'])]],
  ])('请求条件：%s', (_, conditions) => {
    expect(problemsOf(ruleWith([conditions]))).not.toEqual([])
  })

  it.each([
    ['响应码 NOTAUTH（不是六个之一，也不是 OTHER）', [rcond('rcode', ['NOTAUTH'])]],
    ['回答的记录类型 CAA', [rcond('answer_type', ['CAA'])]],
    ['查询类别 NONE', [rcond('qclass', ['NONE'])]],
    ['回答的 IP 前缀 33', [rcond('answer_ip', ['10.0.0.0/33'])]],
    ['TXT 正则超过 1000 字节', [rcond('txt', ['a'.repeat(1001)], false, { txtMode: 'regex' })]],
    ['TXT 正则带后向断言', [rcond('txt', ['(?<=v)x'], false, { txtMode: 'regex' })]],
    ['请求域名正则带断言', [rcond('request_domain', ['(?!x)'], false, { regex: true })]],
  ])('回答条件：%s', (_, conditions) => {
    expect(problemsOf(checked({ conditions }))).not.toEqual([])
  })

  it('内核认的照样能用：小写、CHAOS、OTHER、IPv4 前导零、:: 只占一组、IPv6 里带 IPv4', () => {
    // OPT 只有旧内核认，新内核要写成 TYPE41（见上面「新内核」那条） / Only older kernels take OPT; a new kernel needs TYPE41 (see 新内核 above)
    expect(problemsOf(ruleWith([[cond('qtype', ['aaaa', 'OPT']), cond('qclass', ['CHAOS'])]]))).toEqual([])
    expect(problemsOf(ruleWith([[cond('client_ip', ['010.0.0.0/8', '1:2:3:4:5:6:7::8', '::ffff:1.2.3.4/128', '2001:DB8::/32'])]]))).toEqual([])
    expect(problemsOf(checked({ conditions: [rcond('rcode', ['OTHER', 'servfail'])] }))).toEqual([])
    expect(problemsOf(ruleWith([[cond('domain', ['(?i)^ads\\.', '(?P<x>a)'], false, { regex: true })]]))).toEqual([])
  })

  const answer = (kind: 'ip' | 'cname' | 'txt', value: string, ttl: number | null = null): Outcome => ({ type: 'answer', kind, value, ttl })
  it.each([
    ['回答的 IP 有三个冒号', answer('ip', '1:::2')],
    ['回答的 IP 带前导零（内核按 std 读 IP，不认）', answer('ip', '01.2.3.4')],
    ['回答的 IP 里 :: 什么都没占（std 不认）', answer('ip', '1:2:3:4:5:6:7::8')],
    ['回答的 CNAME 标签以横线开头', answer('cname', '-a.example')],
    ['回答的 CNAME 标签超过 63 字节', answer('cname', `${'a'.repeat(64)}.example`)],
    ['TXT 超过 255 字节', answer('txt', 'a'.repeat(256))],
    ['TXT 的汉字超过 255 字节', answer('txt', '中'.repeat(86))],
    ['TTL 是负数', answer('cname', 'a.example', -1)],
    ['TTL 带小数', answer('txt', 'x', 1.5)],
    ['TTL 超过 u32', answer('cname', 'a.example', 4_294_967_296)],
  ])('结果：%s', (_, outcome) => {
    expect(problemsOf(ruleWith([[]], outcome))).not.toEqual([])
  })

  it.each([
    ['「然后」改写的 TXT 超过 255 字节', { then: { type: 'rewrite_txt', value: 'a'.repeat(256) } as Remedy }],
    ['「否则」回答还没填', { conditions: [rcond('rcode', ['SERVFAIL'])], otherwise: { type: 'answer', kind: 'ip', value: '', ttl: null } as Remedy }],
    ['「否则」回答的 TTL 是负数', { conditions: [rcond('rcode', ['SERVFAIL'])], otherwise: { type: 'answer', kind: 'txt', value: 'x', ttl: -5 } as Remedy }],
  ])('回答后检查：%s', (_, response) => {
    expect(problemsOf(checked({ conditions: [rcond('rcode', ['SERVFAIL'])], ...response }))).not.toEqual([])
  })

  it('内核认的回答照样能用：85 个汉字正好 255 字节，TTL 0 和 4294967295，CNAME 带下划线', () => {
    for (const outcome of [answer('txt', '中'.repeat(85), 0), answer('cname', '_dmarc.example', 4_294_967_295), answer('ip', '192.168.1.10, fd00::10')]) expect(problemsOf(ruleWith([[]], outcome))).toEqual([])
  })

  const withEcs = (ecs: Ecs): Rule => ({ ...ruleWith([[]], { type: 'upstream', group: 'cn' }), ecs })
  it.each([
    ['固定子网空着', { mode: 'static', subnet: '' }],
    ['固定子网不是 IP', { mode: 'static', subnet: 'example/24' }],
    ['固定子网前缀超过 32（内核悄悄截成 32）', { mode: 'static', subnet: '203.0.113.0/40' }],
    ['固定子网前缀写成 999', { mode: 'static', subnet: '203.0.113.0/999' }],
    ['发送客户端子网，IPv4 前缀框空着', { mode: 'client', v4: '' as unknown as number, v6: 56 }],
    ['发送客户端子网，IPv6 前缀 200', { mode: 'client', v4: 24, v6: 200 }],
    ['发送客户端子网，前缀带小数', { mode: 'client', v4: 24.5, v6: 56 }],
  ] as [string, Ecs][])('规则单独的子网：%s', (_, ecs) => {
    expect(problemsOf(withEcs(ecs))).not.toEqual([])
  })

  it('规则单独的子网写对了不报', () => {
    for (const ecs of [{ mode: 'static', subnet: '203.0.113.0/24' }, { mode: 'static', subnet: '2001:db8::/56' }, { mode: 'client', v4: 0, v6: 128 }, { mode: 'clear' }, null] as Ecs[]) expect(problemsOf(withEcs(ecs))).toEqual([])
  })
})

describe('域名映射写了 *.', () => {
  // 映射本来就连同子域名：「*.home.arpa」写进内核成了后缀「*.home.arpa」，什么都不命中
  // A mapping covers subdomains already: 「*.home.arpa」 reached the kernel as the suffix 「*.home.arpa」 and matched nothing
  it('写进内核时去掉 *.，子域名照样命中', () => {
    const m = { ...sampleModel(), mappings: [{ id: id(), domain: '*.home.arpa', target: '192.168.1.10', ttl: null, enabled: true }] }
    const cfg = compile(m) as KConfigLike
    expect(cfg.pipeline_select![0]!.matchers!.map((x) => x.value)).toEqual(['home.arpa'])
    expect(simulate(cfg, { domain: 'nas.home.arpa', client: '192.168.1.20', qtype: 'A' }, checkResponder).answers).toEqual(['A 192.168.1.10'])
  })
})
