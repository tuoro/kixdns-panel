import { describe, expect, it } from 'vitest'
import { andChains, compile, kernelAddress, ruleProblems, type Condition, type Model } from './model'
import { cond, sampleModel } from './testing/samples'
import { foldChain } from './testing/kernel-sim'

// 用照内核源码复刻的求值（kernel.ts foldChain），不在测试里另写一套理解 / Use the fold rebuilt from the kernel source (kernel.ts), not a second reading of it
type M = Record<string, unknown> & { type: string; operator?: string }
const fold = (matchers: M[], ruleOp: string, hit: (m: M) => boolean) => foldChain(matchers, ruleOp, hit)

describe('andChains', () => {
  const terms = (c: Condition[]) => c.flatMap((x) => {
    const v = x.values
    return x.negate ? v.map((value) => ({ negative: true, any: [{ type: x.field, value }] })) : [{ negative: false, any: v.map((value) => ({ type: x.field, value })) }]
  })

  it('一个多值条件放在最前面，结果等于「其中之一且其余都满足」 / one multi-valued condition leads the chain', () => {
    const chains = andChains(terms([cond('qtype', ['A']), cond('domain', ['a', 'b', 'c']), cond('geosite', ['x'], true)]), null)
    expect(chains).toHaveLength(1)
    const cases = [['a', 'A', false], ['b', 'A', false], ['d', 'A', false], ['a', 'AAAA', false], ['c', 'A', true]] as const
    for (const [domain, qtype, inX] of cases) {
      const hit = (m: M) => (m.type === 'domain' ? m.value === domain : m.type === 'qtype' ? m.value === qtype : inX)
      expect(fold(chains[0]!.matchers, chains[0]!.operator, hit)).toBe(['a', 'b', 'c'].includes(domain) && qtype === 'A' && !inX)
    }
  })

  it('两个多值条件拆成几条，任一条命中就等于原条件 / two multi-valued conditions split into rules whose union is the condition', () => {
    const chains = andChains(terms([cond('domain', ['a', 'b']), cond('qtype', ['A', 'AAAA', 'MX'])]), null)
    expect(chains).toHaveLength(3)
    for (const domain of ['a', 'b', 'z']) for (const qtype of ['A', 'AAAA', 'MX', 'TXT']) {
      const hit = (m: M) => (m.type === 'domain' ? m.value === domain : m.value === qtype)
      expect(chains.some((c) => fold(c.matchers, c.operator, hit))).toBe(['a', 'b'].includes(domain) && ['A', 'AAAA', 'MX'].includes(qtype))
    }
  })

  it('只有否定条件时用「任意请求」起头 / only negative conditions seed with any', () => {
    const [chain] = andChains(terms([cond('domain', ['a', 'b'], true)]), { type: 'any' })
    expect(chain!.matchers[0]).toMatchObject({ type: 'any' })
    for (const domain of ['a', 'b', 'c']) expect(fold(chain!.matchers, chain!.operator, (m) => (m.type === 'any' ? true : m.value === domain))).toBe(domain === 'c')
  })
})

describe('compile', () => {
  const model = sampleModel()
  const config = compile(model)
  const pipeline = (id: string) => config.pipelines.find((p) => p.id === id)!

  it('每个上游组一个 Pipeline，备用组接在回答处理上 / one pipeline per upstream group, the fallback on its response side', () => {
    const cn = pipeline('upstream-cn').rules[0]!
    const cnEcs = { mode: 'from_client_ip', prefix_v4: 24, prefix_v6: 56 }
    expect(cn.actions).toEqual([{ type: 'forward', upstream: 'https://doh.pub/dns-query, tls://dns.alidns.com, tcp+udp://223.5.5.5', ecs: cnEcs }])
    // 缓存按 Pipeline 级的 ECS 隔开 / the cache is split by the pipeline-level ECS
    expect(pipeline('upstream-cn').ecs).toEqual(cnEcs)
    expect(pipeline('upstream-abroad').ecs).toBeUndefined()
    expect(cn.response_matcher_operator).toBe('or')
    expect(cn.response_matchers.map((m) => m.cidr)).toEqual(['0.0.0.0/32', '240.0.0.0/4', '255.255.255.255/32'])
    expect(cn.response_actions_on_match).toEqual([{ type: 'jump_to_pipeline', pipeline: 'upstream-abroad' }])
    expect(pipeline('upstream-corp').rules[0]!.response_matchers.map((m) => m.value)).toEqual(['SERVFAIL', 'REFUSED'])
    expect(pipeline('upstream-abroad').rules[0]!.response_matchers).toEqual([])
  })

  it('主列表：域名映射在前、停用的规则不出现、最后一条接住其余请求 / main: mappings first, disabled rules left out, a final catch-all', () => {
    // 域名映射是最前面的入口，停用的不写 / Domain mappings are the first entry; disabled ones are left out
    expect(config.pipeline_select[0]!.pipeline).toBe('domain_mapping')
    expect(config.pipeline_select[0]!.matchers.map((m) => m.value)).toEqual(['nas.home.arpa', 'router.home.arpa', 'printer.home.arpa', 'files.home.arpa'])
    expect(pipeline('domain_mapping').rules.map((r) => r.name)).toEqual(['域名映射 nas.home.arpa', '域名映射 router.home.arpa', '域名映射 printer.home.arpa', '域名映射 files.home.arpa'])
    const names = pipeline('main').rules.map((r) => r.name)
    expect(names[0]).toBe('测试网段只记录')
    expect(names).not.toContain('旧统计接口')
    expect(names.at(-1)).toBe('其余请求')
    expect(pipeline('main').rules.at(-1)!.actions).toEqual([{ type: 'jump_to_pipeline', pipeline: 'upstream-abroad' }])
    expect(config.pipeline_select.at(-1)).toEqual({ pipeline: 'main', matcher_operator: 'and', matchers: [] })
  })

  it('动作按内核的写法落地 / outcomes land as kernel actions', () => {
    const byName = (n: string) => pipeline('main').rules.filter((r) => r.name === n || r.name.startsWith(`${n}#`))
    expect(byName('测试网段只记录')[0]!.actions).toEqual([{ type: 'log', level: 'info' }, { type: 'continue' }])
    expect(byName('测试网段只记录')[0]!.matchers).toEqual([{ type: 'client_ip', cidr: '192.168.50.0/24', operator: 'and' }])
    expect(byName('广告与跟踪')[0]!.actions).toEqual([{ type: 'static_response', rcode: 'NXDOMAIN' }])
    expect(byName('版本查询')[0]!.actions).toEqual([{ type: 'static_txt_response', text: ['kixdns'], ttl: 3600 }])
    expect(byName('内网反查')[0]!.actions).toEqual([{ type: 'jump_to_pipeline', pipeline: 'group-lan' }])
    expect(byName('内网反查')[0]!.matchers).toEqual([{ type: 'qtype', value: 'PTR', operator: 'and' }, { type: 'geoip_private', expect: true, operator: 'and' }])
    // 苹果服务单独设了 ECS：跳到自己的转发 Pipeline，组的备用照样带上；两个多值条件拆成两条
    // 苹果服务 overrides ECS: it jumps to its own forward pipeline, keeping the group's fallback; two multi-valued conditions split in two
    const apple = byName('苹果服务')
    expect(apple.map((r) => r.name)).toEqual(['苹果服务#1', '苹果服务#2'])
    const appleId = model.rules.find((r) => r.name === '苹果服务')!.id
    expect(apple[0]!.actions).toEqual([{ type: 'jump_to_pipeline', pipeline: `rule-${appleId}` }])
    const appleEcs = { mode: 'from_client_ip', prefix_v4: 24, prefix_v6: 48 }
    expect(pipeline(`rule-${appleId}`).ecs).toEqual(appleEcs)
    expect(pipeline(`rule-${appleId}`).rules[0]!.actions[0]).toMatchObject({ type: 'forward', ecs: appleEcs })
    expect(pipeline(`rule-${appleId}`).rules[0]!.response_actions_on_match).toEqual([{ type: 'jump_to_pipeline', pipeline: 'upstream-abroad' }])
    const rebindingId = model.rules.find((r) => r.name === '防 DNS 重绑定')!.id
    const rebinding = pipeline(`rule-${rebindingId}`).rules[0]!
    expect(rebinding.response_matchers).toEqual([{ type: 'response_answer_ip_geoip_private', expect: true, operator: 'and' }])
    expect(rebinding.response_actions_on_match).toEqual([{ type: 'deny' }])
    // 主列表里一个转发都没有 / no forward anywhere in main
    expect(pipeline('main').rules.flatMap((r) => r.actions).some((a) => a.type === 'forward')).toBe(false)
  })

  it('规则组自己一个 Pipeline，最后接住组里的其余请求 / a rule group is its own pipeline with its own catch-all', () => {
    expect(pipeline('group-lan').rules.map((r) => r.name)).toEqual(['公司网段反查', '内网解析·其余'])
    expect(pipeline('group-lan').rules.at(-1)!.actions).toEqual([{ type: 'jump_to_pipeline', pipeline: 'upstream-router' }])
  })

  it('域名映射：IP 列表和 CNAME / mappings: an IP list and a CNAME', () => {
    const rules = pipeline('domain_mapping').rules
    expect(rules[2]!.actions).toEqual([{ type: 'static_ip_response', ip: '192.168.1.30,fd00::30' }])
    expect(rules[3]!.actions).toEqual([{ type: 'static_cname_response', target: 'nas.home.arpa', ttl: 600 }])
  })

  it('全局设置原样写出，默认上游跟着其余请求的组 / settings pass through; the default upstream follows the catch-all group', () => {
    expect(config.version).toBe('1.0')
    expect(config.settings.bind_udp).toBe('0.0.0.0:53')
    expect(config.settings.default_upstream).toBe('https://dns.google/dns-query, https://cloudflare-dns.com/dns-query')
    const toCn = compile({ ...model, rest: { type: 'upstream', group: 'cn' } })
    expect(toCn.settings.default_upstream).toBe('https://doh.pub/dns-query, tls://dns.alidns.com, tcp+udp://223.5.5.5')
  })

  it('拦截选空地址时 A 和 AAAA 都有回答 / blocking with a null address answers both A and AAAA', () => {
    const m: Model = { ...model, defaults: { block: 'zero' } }
    expect(compile(m).pipelines.find((p) => p.id === 'main')!.rules.find((r) => r.name === '广告与跟踪')!.actions).toEqual([{ type: 'static_ip_response', ip: '0.0.0.0,::' }])
  })
})

describe('回答检查的条件链 / answer-check chains', () => {
  const pipelineFor = (model: Model, match: 'all' | 'any', conds: { field: 'rcode' | 'answer_country'; negate: boolean; values: string[] }[]) => {
    const rule = { ...model.rules.find((r) => r.name === '国内域名')!, response: { mode: 'custom' as const, match, conditions: conds.map((c, i) => ({ id: 900 + i, ...c })), then: { type: 'block' as const, response: 'REFUSED' as const }, otherwise: { type: 'none' as const } } }
    const m: Model = { ...model, rules: [rule] }
    return compile(m).pipelines.find((p) => p.id === `rule-${rule.id}`)!.rules[0]!
  }
  const model = sampleModel()
  // 回答的样子：响应码和回答 IP 的地区 / A reply: its rcode and the region of its answer IP
  const cases = [['NOERROR', 'CN'], ['NOERROR', 'US'], ['SERVFAIL', 'CN'], ['SERVFAIL', 'US']] as const
  const truth = (r: { response_matchers: M[]; response_matcher_operator: string }, rcode: string, country: string) =>
    fold(r.response_matchers, r.response_matcher_operator, (m) => (m.type === 'response_rcode' ? m.value === rcode : (m.country_codes as string[]).includes(country)))

  it('只有一个「不是」：不是 CN 就命中 / a lone negation matches when the region is not CN', () => {
    for (const match of ['any', 'all'] as const) {
      const r = pipelineFor(model, match, [{ field: 'answer_country', negate: true, values: ['CN'] }])
      for (const [rcode, country] of cases) expect(truth(r, rcode, country)).toBe(country !== 'CN')
    }
  })
  it('任一，全是「不是」 / any, all negated', () => {
    const r = pipelineFor(model, 'any', [{ field: 'answer_country', negate: true, values: ['CN'] }, { field: 'rcode', negate: true, values: ['NOERROR'] }])
    for (const [rcode, country] of cases) expect(truth(r, rcode, country)).toBe(country !== 'CN' || rcode !== 'NOERROR')
  })
  it('全部，全是「不是」 / all, all negated', () => {
    const r = pipelineFor(model, 'all', [{ field: 'answer_country', negate: true, values: ['CN'] }, { field: 'rcode', negate: true, values: ['NOERROR'] }])
    for (const [rcode, country] of cases) expect(truth(r, rcode, country)).toBe(country !== 'CN' && rcode !== 'NOERROR')
  })
  it('任一，肯定和否定混着 / any, mixed', () => {
    const r = pipelineFor(model, 'any', [{ field: 'rcode', negate: false, values: ['SERVFAIL'] }, { field: 'answer_country', negate: true, values: ['CN'] }])
    for (const [rcode, country] of cases) expect(truth(r, rcode, country)).toBe(rcode === 'SERVFAIL' || country !== 'CN')
  })
  it('全部，肯定和否定混着 / all, mixed', () => {
    const r = pipelineFor(model, 'all', [{ field: 'rcode', negate: false, values: ['NOERROR'] }, { field: 'answer_country', negate: true, values: ['CN'] }])
    for (const [rcode, country] of cases) expect(truth(r, rcode, country)).toBe(rcode === 'NOERROR' && country !== 'CN')
  })
})

describe('kernelAddress', () => {
  it('协议写成地址前缀 / the protocol becomes the address prefix', () => {
    expect(kernelAddress({ address: '223.5.5.5', protocol: 'auto' })).toBe('223.5.5.5')
    expect(kernelAddress({ address: '223.5.5.5', protocol: 'tcp_udp' })).toBe('tcp+udp://223.5.5.5')
    expect(kernelAddress({ address: 'udp://1.1.1.1', protocol: 'dot' })).toBe('tls://1.1.1.1')
    expect(kernelAddress({ address: 'dns.google/dns-query', protocol: 'doh' })).toBe('https://dns.google/dns-query')
  })
})

describe('ruleProblems', () => {
  it('引用了删掉的组时报出来 / flags a deleted group', () => {
    const model = sampleModel()
    const rule = { ...model.rules[1]!, outcome: { type: 'upstream' as const, group: 'gone' } }
    expect(ruleProblems(model, rule)).toContain('选的上游组已经删掉了')
  })
  it('写错的值逐个报 / flags bad values', () => {
    const model = sampleModel()
    const rule = { ...model.rules[0]!, conditions: [[cond('client_ip', ['192.168.1.300'])]] }
    expect(ruleProblems(model, rule)).toEqual(['「客户端 IP」里有写错的值（标红的那个）'])
  })
})
