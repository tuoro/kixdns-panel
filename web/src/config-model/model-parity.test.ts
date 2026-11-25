import { describe, expect, it } from 'vitest'
import { readConfig } from './document'
import { importKernel } from './importer'
import { kernelKey, type KConfigLike } from './kernel'
import {
  addressProblem, compile, compileNamed, isDomain, kernelDomain, kernelPreview, kernelUpstream, mainPipelineId, newRule, ruleProblems, upstreamProblem,
  type KernelConfig, type Model, type ResponseCondition, type Rule,
} from './model'
import { behaviourCheck, checkResponder, simulate, type SimQuery } from './testing/kernel-sim'
import { sampleModel } from './testing/samples'
import { findRuleByText } from './trace-names'

// 面板写进内核的、面板从内核读回来的，要和内核自己认的一样，也要和面板自己认的一样：每一组是一种「两边对不上」的办法，
// 修的是那个办法，不是那一个例子。真内核的 config::validate 另在 CI 里跑（tools/kernel-config-check）
// What the panel writes into the kernel and reads back from it must agree with the kernel's own reading and with the panel's own: each
// group below is one way the two sides disagreed, fixed as a mechanism rather than as one example. The real kernel's config::validate runs
// in CI on top of this (tools/kernel-config-check)

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
// sampleModel 的设置里带着 Geo 文件和 0.0.0.0:53 的监听；这里只看规则 / sampleModel's settings carry Geo files and 0.0.0.0:53 listeners; only the rules matter here
const plain = (): Model => ({ ...sampleModel(), settings: { bind_udp: '127.0.0.1:5353' } })
// 主列表倒数第二条加一条带回答检查的规则（交给国外组） / A rule with an answer check, second to last in the main list (handed to 国外)
function checkedRule(m: Model, conditions: ResponseCondition[], match: 'all' | 'any', name = '回答检查'): Rule {
  const r: Rule = { ...newRule(800_000 + m.rules.length, { type: 'upstream', group: 'abroad' }), name, note: '要留着的备注' }
  r.conditions = [[{ id: 800_100 + m.rules.length, field: 'domain', negate: false, regex: false, values: ['probe.example'] }]]
  r.response = { mode: 'custom', match, conditions, then: { type: 'block', response: 'REFUSED' }, otherwise: { type: 'none' } }
  m.rules.splice(m.rules.length - 1, 0, r)
  return r
}
const mainOf = (k: KernelConfig, m: Model) => k.pipelines.find((p) => p.id === mainPipelineId(m))!
// JSON 视图里改了公司内网的第一个域名（和这一组要看的规则无关），读回草稿 / The JSON view edits 公司内网's first domain (unrelated to the rule
// looked at) and reads back into the draft
function editElsewhere(m: Model, edit: (k: KernelConfig) => void = () => {}): Model {
  const k = clone(compile(m))
  mainOf(k, m).rules.find((x) => x.name === '公司内网')!.matchers[0]!.value = 'corp.example.net'
  edit(k)
  return readConfig(k as unknown as Record<string, unknown>, clone(m)).model
}
const responseTypes = (k: KernelConfig) => k.pipelines.flatMap((p) => p.rules.flatMap((r) => r.response_matchers.map((x) => x.type)))

describe('回答后检查里的「请求域名 GeoSite」按内核的类型名写、两种写法都读得回来', () => {
  it('写成 response_request_domain_geo_site：属于、不属于都是', () => {
    const m = plain()
    checkedRule(m, [{ id: 1, field: 'request_geosite', negate: false, values: ['cn'] }, { id: 2, field: 'request_geosite', negate: true, values: ['google'] }], 'all')
    const types = responseTypes(compile(m))
    expect(types).toContain('response_request_domain_geo_site')
    expect(types.filter((t) => /geosite/.test(t))).toEqual([])
  })

  it('内核的写法和以前面板写的那种都读成「请求域名 GeoSite」，写回去是内核的写法', () => {
    for (const [yes, no] of [['response_request_domain_geo_site', 'response_request_domain_geo_site_not'], ['response_request_domain_geosite', 'response_request_domain_geosite_not']]) {
      const cfg: KConfigLike = { version: '1.0', settings: { default_upstream: '1.1.1.1:53' }, pipeline_select: [{ pipeline: 'main', matchers: [] }], pipelines: [{ id: 'main', rules: [
        { name: 'checked', matchers: [{ type: 'domain_suffix', value: 'x.example' }], actions: [{ type: 'forward', upstream: '8.8.8.8:53' }],
          response_matchers: [{ type: yes!, value: 'cn' }, { type: no!, value: 'google' }], response_actions_on_match: [{ type: 'deny' }] },
      ] }] }
      const { model } = importKernel(cfg)
      const rule = model.rules.find((r) => r.name === 'checked')!
      expect(rule.raw).toBeUndefined()
      expect(rule.response.conditions.map((c) => [c.field, c.negate, c.values])).toEqual([['request_geosite', false, ['cn']], ['request_geosite', true, ['google']]])
      expect(responseTypes(compile(model)).filter((t) => /geo/.test(t))).toEqual(['response_request_domain_geo_site', 'response_request_domain_geo_site'])
    }
  })

  it('照内核写的执行器不认的类型直接报错，不当成「不命中」', () => {
    const q: SimQuery = { domain: 'a.example', client: '192.168.1.20', qtype: 'A' }
    const reply = () => ({ rcode: 'NOERROR', answers: ['A 1.2.3.4'], upstream: 'udp:8.8.8.8:53' })
    const with_ = (rule: Record<string, unknown>): KConfigLike => ({ version: '1.0', settings: {}, pipeline_select: [{ pipeline: 'main', matchers: [] }], pipelines: [{ id: 'main', rules: [{ name: 'r', matchers: [], actions: [{ type: 'forward', upstream: '8.8.8.8:53' }], ...rule }] }] })
    expect(() => simulate(with_({ response_matchers: [{ type: 'response_request_domain_geosite', value: 'cn' }], response_actions_on_match: [{ type: 'deny' }] }), q, reply)).toThrow(/response_request_domain_geosite/)
    expect(() => simulate(with_({ matchers: [{ type: 'listener_label', value: 'lan' }] }), q, reply)).toThrow(/listener_label/)
    expect(() => simulate(with_({ actions: [{ type: 'mystery' }] }), q, reply)).toThrow(/mystery/)
    expect(() => simulate(with_({ response_matchers: [{ type: 'response_rcode', value: 'NXDOMAIN' }], response_actions_on_match: [{ type: 'mystery' }] }), q, reply)).toThrow(/mystery/)
    expect(simulate(with_({ response_matchers: [{ type: 'response_request_domain_geo_site', value: 'cn' }], response_actions_on_match: [{ type: 'deny' }] }), q, reply).rcode).toBe('NOERROR')
    // 拦截写在两个转发前面：照最新的内核是拦截，不合并成转发 / A block written before two forwards: as the latest kernel does it, the block,
    // not a merged forward
    expect(simulate(with_({ actions: [{ type: 'log' }, { type: 'deny' }, { type: 'forward', upstream: '8.8.8.8:53' }, { type: 'forward', upstream: '9.9.9.9:53' }] }), q, reply).rcode).toBe('REFUSED')
    expect(simulate(with_({ actions: [{ type: 'log' }, { type: 'forward', upstream: '8.8.8.8:53' }, { type: 'forward', upstream: '9.9.9.9:53' }] }), q, reply).rcode).toBe('NOERROR')
  })
})

describe('上游地址：没写端口的按 53 补上，编辑器查的、写进内核的、对统计的是同一个样子', () => {
  it('上游组里只写了 IP 的地址写进内核时带上 :53，编辑器不报错，内核也认', () => {
    const m = plain()
    const cn = m.groups.find((g) => g.id === 'cn')!
    expect(cn.addresses.map(addressProblem)).toEqual([null, null, null])
    const k = compile(m)
    const forwards = k.pipelines.flatMap((p) => p.rules.flatMap((r) => r.actions.filter((a) => a.type === 'forward').map((a) => String(a.upstream))))
    expect(forwards.join(', ')).toContain('tcp+udp://223.5.5.5:53')
    for (const up of forwards.flatMap((u) => u.split(',').map((x) => x.trim()))) expect([up, upstreamProblem(up)]).toEqual([up, null])
    expect(kernelUpstream({ address: '223.5.5.5', protocol: 'tcp_udp' })).toBe('tcp+udp://223.5.5.5:53')
    // 方括号里的 IPv6 写了括号没写端口也一样（真内核校验时查出来的） / An IPv6 in brackets without a port likewise (found by the real kernel's check)
    for (const a of [{ address: '[2400:3200::1]', protocol: 'tcp_udp' as const }, { address: 'udp://[2400:3200::1]', protocol: 'auto' as const }]) {
      expect([kernelUpstream(a), addressProblem(a)]).toEqual([`${a.protocol === 'auto' ? 'udp' : 'tcp+udp'}://[2400:3200::1]:53`, null])
    }
  })

  it('其余请求交给的组写成默认上游时也带上 :53', () => {
    const m = plain()
    m.rest = { type: 'upstream', group: 'cn' }
    expect(compile(m).settings.default_upstream).toBe('https://doh.pub/dns-query, tls://dns.alidns.com, tcp+udp://223.5.5.5:53')
  })

  it('其余请求拦截、设置里照写的默认上游只写了 IP：写进内核时带上 :53，读回来还是原来那样写', () => {
    const m = plain()
    m.rest = { type: 'block', response: 'default' }
    m.settings = { ...m.settings, default_upstream: '8.8.8.8, tcp://dns.example' }
    const k = compile(m)
    expect(k.settings.default_upstream).toBe('8.8.8.8:53, tcp://dns.example:53')
    const back = editElsewhere(m)
    expect(back.settings.default_upstream).toBe('8.8.8.8, tcp://dns.example')
    expect(kernelKey(compile(back).settings)).toBe(kernelKey(k.settings))
  })

  it('读进来的转发只写了 IP：和带 :53 的是同一个组', () => {
    const cfg: KConfigLike = { version: '1.0', settings: { default_upstream: '1.1.1.1:53' }, pipeline_select: [{ pipeline: 'main', matchers: [] }], pipelines: [{ id: 'main', rules: [
      { name: 'a', matchers: [{ type: 'domain_suffix', value: 'a.example' }], actions: [{ type: 'forward', upstream: '223.5.5.5', transport: 'tcp' }] },
      { name: 'b', matchers: [{ type: 'domain_suffix', value: 'b.example' }], actions: [{ type: 'forward', upstream: 'tcp://223.5.5.5:53' }] },
      { name: 'rest', matchers: [], actions: [{ type: 'forward', upstream: '8.8.8.8:53' }] },
    ] }] }
    const { model } = importKernel(cfg)
    const groupsOf = (name: string) => (model.rules.find((r) => r.name === name)!.outcome as { group: string }).group
    expect(groupsOf('a')).toBe(groupsOf('b'))
    const forwards = compile(model).pipelines.flatMap((p) => p.rules.flatMap((r) => r.actions.filter((a) => a.type === 'forward').map((a) => String(a.upstream))))
    expect(forwards).toContain('tcp://223.5.5.5:53')
    expect(forwards).not.toContain('tcp://223.5.5.5')
  })
})

describe('JSON 里改名：编号和备注跟着内容走，不跟着名字走', () => {
  it('把一条改成另一条现有的名字：两条各留各的编号和备注', () => {
    const m = sampleModel()
    const ads = m.rules.find((r) => r.name === '广告与跟踪')!
    const firefox = m.rules.find((r) => r.name === '火狐 DoH 探测')!
    ads.note = '广告规则的备注'
    const k = clone(compile(m))
    mainOf(k, m).rules.find((x) => x.name === '广告与跟踪')!.name = '火狐 DoH 探测'
    const back = readConfig(k as unknown as Record<string, unknown>, clone(m)).model
    const byContent = (field: string) => back.rules.filter((r) => r.conditions.flat()[0]?.field === field && r.outcome.type === 'block')
    expect(byContent('geosite').map((r) => ({ id: r.id, note: r.note, name: r.name }))).toEqual([{ id: ads.id, note: '广告规则的备注', name: '火狐 DoH 探测' }])
    expect(back.rules.filter((r) => r.id === firefox.id).map((r) => ({ note: r.note, values: r.conditions.flat()[0]!.values }))).toEqual([{ note: firefox.note, values: ['use-application-dns.net'] }])
  })

  it('删了一条、再把另一条改成它的名字：改名的那条留自己的编号和备注，删掉的就没了', () => {
    const m = sampleModel()
    const ads = m.rules.find((r) => r.name === '广告与跟踪')!
    const firefox = m.rules.find((r) => r.name === '火狐 DoH 探测')!
    ads.note = '广告规则的备注'
    const k = clone(compile(m))
    const main = mainOf(k, m)
    main.rules.splice(main.rules.findIndex((x) => x.name === firefox.name), 1)
    main.rules.find((x) => x.name === '广告与跟踪')!.name = firefox.name
    const back = readConfig(k as unknown as Record<string, unknown>, clone(m)).model
    expect(back.rules.filter((r) => r.name === firefox.name).map((r) => ({ id: r.id, note: r.note }))).toEqual([{ id: ads.id, note: '广告规则的备注' }])
    expect(back.rules.some((r) => r.id === firefox.id)).toBe(false)
  })

  it('两条互换名字：编号和备注跟着内容走，名字是新的', () => {
    const m = sampleModel()
    const ads = m.rules.find((r) => r.name === '广告与跟踪')!
    const firefox = m.rules.find((r) => r.name === '火狐 DoH 探测')!
    const k = clone(compile(m))
    const main = mainOf(k, m)
    const [a, b] = [main.rules.find((x) => x.name === ads.name)!, main.rules.find((x) => x.name === firefox.name)!]
    a.name = firefox.name
    b.name = ads.name
    const back = readConfig(k as unknown as Record<string, unknown>, clone(m)).model
    expect(back.rules.find((r) => r.id === ads.id)).toEqual({ ...ads, name: firefox.name })
    expect(back.rules.find((r) => r.id === firefox.id)).toEqual({ ...firefox, name: ads.name })
  })

  it('名字没变、内容改了：还是原来那条，即使另一条和它原来的内容一样', () => {
    const m = sampleModel()
    const ads = m.rules.find((r) => r.name === '广告与跟踪')!
    // 另一条和广告与跟踪编出来只差名字 / Another rule compiling like 广告与跟踪 but for its name
    const twin: Rule = { ...clone(ads), id: 9100, name: '广告（备用）', note: '备用那条', conditions: [[{ ...ads.conditions[0]![0]!, id: 9101 }]] }
    m.rules.splice(m.rules.indexOf(ads) + 1, 0, twin)
    ads.note = '广告规则的备注'
    const k = clone(compile(m))
    mainOf(k, m).rules.find((x) => x.name === ads.name)!.matchers[0]!.value = 'category-porn'
    const back = readConfig(k as unknown as Record<string, unknown>, clone(m)).model
    expect(back.rules.find((r) => r.name === ads.name)).toMatchObject({ id: ads.id, note: '广告规则的备注' })
    expect(back.rules.find((r) => r.name === twin.name)).toMatchObject({ id: twin.id, note: '备用那条' })
  })
})

describe('「全部满足」里一个条件填几个值：读回来还是这条规则，不变成高级规则', () => {
  const allMulti = (m: Model, name = '回答检查') => checkedRule(m, [
    { id: 800_501, field: 'request_domain', negate: false, regex: false, values: ['a.example', 'b.example'] },
    { id: 800_502, field: 'answer_private', negate: false, values: [] },
  ], 'all', name)

  it('JSON 里改了别处：编号、备注都在，没有原样保留的 Pipeline', () => {
    const m = sampleModel()
    const r = allMulti(m)
    expect(ruleProblems(m, r)).toEqual([])
    const back = editElsewhere(m)
    const again = back.rules.find((x) => x.name === '回答检查')!
    expect({ id: again.id, raw: Boolean(again.raw), note: again.note, response: again.response, rawPipelines: back.rawPipelines }).toEqual({ id: r.id, raw: false, note: '要留着的备注', response: r.response, rawPipelines: undefined })
  })

  it('没有上一份时也读成面板规则', () => {
    const m = sampleModel()
    const r = allMulti(m)
    const back = importKernel(clone(compile(m)) as KConfigLike).model.rules.find((x) => x.name === '回答检查')!
    expect(back.raw).toBeUndefined()
    expect(back.response.conditions.map((c) => [c.field, c.values])).toEqual(r.response.conditions.map((c) => [c.field, c.values]))
  })

  it('同名的另一条在内核里的名字不变，命中照样记到它头上', () => {
    const m = sampleModel()
    allMulti(m)
    const twin = { ...newRule(800_560, { type: 'block', response: 'NXDOMAIN' }), name: '回答检查', note: '同名的另一条' }
    twin.conditions = [[{ id: 800_561, field: 'domain' as const, negate: false, regex: false, values: ['twin.example'] }]]
    m.rules.splice(0, 0, twin)
    const running = mainOf(compile(m), m).rules[0]!.name
    const back = editElsewhere(m)
    expect(compileNamed(back).index.lookup('main', running)).toEqual({ kind: 'rule', id: back.rules.find((r) => r.note === '同名的另一条')!.id })
  })

  it('响应码填两个、再加一个条件：接回上一份时编号照旧', () => {
    const m = sampleModel()
    const r = checkedRule(m, [{ id: 800_601, field: 'rcode', negate: false, values: ['NOERROR', 'NXDOMAIN'] }, { id: 800_602, field: 'answer_private', negate: false, values: [] }], 'all')
    const back = importKernel(clone(compile(m)) as KConfigLike, clone(m)).model.rules.find((x) => x.name === '回答检查')!
    expect({ id: back.id, raw: Boolean(back.raw) }).toEqual({ id: r.id, raw: false })
  })

  it('TXT 的「等于」和「开头是」不并成一个条件', () => {
    const m = sampleModel()
    checkedRule(m, [{ id: 1, field: 'txt', negate: true, txtMode: 'exact', values: ['v=spf1'] }, { id: 2, field: 'txt', negate: true, txtMode: 'prefix', values: ['google-'] }], 'all')
    const back = importKernel(clone(compile(m)) as KConfigLike).model.rules.find((x) => x.name === '回答检查')!
    expect(back.response.conditions.map((c) => [c.txtMode, c.values])).toEqual([['exact', ['v=spf1']], ['prefix', ['google-']]])
  })
})

describe('读成高级规则的那条自带转发时：记下它跳去的那个，编号和写法都接得回来', () => {
  it('JSON 里给自带转发的规则加了一个认不出的字段、又删掉：编号、备注照旧，没有两个同名的 Pipeline', () => {
    const m = sampleModel()
    const apple = m.rules.find((r) => r.name === '苹果服务')!
    apple.note = '苹果的备注'
    const k1 = clone(compile(m))
    for (const kr of mainOf(k1, m).rules.filter((x) => x.name.startsWith('苹果服务'))) (kr as unknown as Record<string, unknown>).comment = '手写'
    const raw = readConfig(k1 as unknown as Record<string, unknown>, clone(m)).model
    const kept = raw.rules.filter((r) => r.id === apple.id)
    expect(kept.map((r) => ({ raw: Boolean(r.raw), note: r.note }))).toEqual([{ raw: true, note: '苹果的备注' }])
    const ids = (x: Model) => compile(x).pipelines.map((p) => p.id)
    expect(ids(raw).filter((id, i, all) => all.indexOf(id) !== i)).toEqual([])
    // 字段删掉：回到原来那条面板规则 / The field removed: back to the panel rule it was
    const k2 = clone(compile(raw))
    for (const kr of mainOf(k2, raw).rules) delete (kr as unknown as Record<string, unknown>).comment
    const back = readConfig(k2 as unknown as Record<string, unknown>, raw).model
    // 条件是按内核里的重新读的（中间成过高级规则，条件的编号不在了），别的都和原来一样 / The conditions are read afresh from the kernel (it was an
    // advanced rule in between, so their ids are gone); everything else is as it was
    const bare = (r: Rule) => ({ ...r, conditions: r.conditions.map((g) => g.map(({ id: _id, regex, ...c }) => ({ ...c, regex: Boolean(regex) }))) })
    expect(bare(back.rules.find((r) => r.id === apple.id)!)).toEqual(bare(apple))
    expect(back.rawPipelines).toBeUndefined()
    expect(ids(back).filter((id, i, all) => all.indexOf(id) !== i)).toEqual([])
  })
})

describe('以前读成高级规则的「全部满足」多值规则：升级以后读回来是面板规则，跳转都有去处', () => {
  it('上一份里它是高级规则、自己的转发原样保留着：读回来是面板规则，编号和备注照旧，没有跳到不存在的 Pipeline', () => {
    const m = sampleModel()
    const r = checkedRule(m, [{ id: 800_901, field: 'request_domain', negate: false, regex: false, values: ['a.example', 'b.example'] }, { id: 800_902, field: 'answer_private', negate: false, values: [] }], 'all')
    const k = clone(compile(m))
    // 以前的导入读出来的样子：高级规则原样留着跳转，它自己的转发成了原样保留的 Pipeline / What the old import read: an advanced rule keeping its
    // jump verbatim, with its own forward kept as a verbatim pipeline
    const own = k.pipelines.find((p) => p.id === `rule-${r.id}`)!
    const old: Model = { ...clone(m), rawPipelines: [clone(own) as unknown as Record<string, unknown>] }
    old.rules = old.rules.map((x) => (x.id === r.id ? { ...x, conditions: [[]], outcome: { type: 'continue' }, response: { ...x.response, mode: 'inherit' }, raw: [clone(mainOf(k, m).rules.find((kr) => kr.name === '回答检查')!) as unknown as Record<string, unknown>] } : x))
    // JSON 里改了别处，走重新导入这条路 / Something else edited in the JSON, so the re-import path is taken
    const back = editElsewhere(old)
    const again = back.rules.find((x) => x.id === r.id)!
    expect({ raw: Boolean(again.raw), note: again.note }).toEqual({ raw: false, note: '要留着的备注' })
    const out = compile(back)
    const ids = out.pipelines.map((p) => p.id)
    for (const p of out.pipelines) for (const kr of p.rules) for (const a of [...kr.actions, ...kr.response_actions_on_match, ...kr.response_actions_on_miss]) if (a.type === 'jump_to_pipeline') expect(ids).toContain(String(a.pipeline))
  })
})

describe('编辑器认可的规则写进内核、再读回来，一定还是面板规则', () => {
  it('自相矛盾的一组条件（既是又不是）编辑器当场说', () => {
    const m = sampleModel()
    const r = m.rules.find((x) => x.name === '公司内网')!
    r.conditions = [[{ id: 1, field: 'domain', negate: false, regex: false, values: ['corp.example'] }, { id: 2, field: 'domain', negate: true, regex: false, values: ['corp.example'] }]]
    expect(ruleProblems(m, r)).toEqual(['同一组里「域名」既属于又不属于 corp.example，去掉其中一个'])
    r.conditions = [[{ id: 1, field: 'client_private', negate: false, values: [] }, { id: 2, field: 'client_private', negate: true, values: [] }]]
    expect(ruleProblems(m, r)).toEqual(['同一组里「客户端网络」既是内网又不是内网，去掉其中一个'])
    // 不同的比法不算矛盾：属于 a 且不是（就是）a，是 a 的子域名 / Different comparisons do not contradict: 属于 a and 不是 (exactly) a is a's subdomains
    r.conditions = [[{ id: 1, field: 'domain', negate: false, regex: false, values: ['corp.example'] }, { id: 2, field: 'domain', negate: true, regex: false, exact: true, values: ['corp.example'] }]]
    expect(ruleProblems(m, r)).toEqual([])
    const checked = checkedRule(m, [{ id: 3, field: 'rcode', negate: false, values: ['NXDOMAIN'] }, { id: 4, field: 'rcode', negate: true, values: ['NXDOMAIN'] }], 'all')
    expect(ruleProblems(m, checked)).toEqual(['同一组里「响应码」既是又不是 NXDOMAIN，去掉其中一个'])
    checked.response.match = 'any'
    expect(ruleProblems(m, checked).filter((p) => p.startsWith('同一组里'))).toEqual([])
  })

  it('「满足任一」里「不是」填了几个值：旁边有一个不填值的「不是」也照样说', () => {
    const m = sampleModel()
    const r = checkedRule(m, [{ id: 1, field: 'answer_private', negate: true, values: [] }, { id: 2, field: 'rcode', negate: true, values: ['NOERROR', 'NXDOMAIN'] }], 'any')
    expect(ruleProblems(m, r)).toEqual(['「满足任一」时，「不是」的条件只能填一个值，几个值拆成几条'])
  })

  it('值是空白的条件算没填，编出来不会变成「所有回答」', () => {
    const m = plain()
    const all = checkedRule(m, [{ id: 1, field: 'txt', negate: false, txtMode: 'exact', values: [' '] }], 'all')
    expect(ruleProblems(m, all)).toEqual(['「TXT 内容」还没填值'])
    const own = (k: KernelConfig) => k.pipelines.find((p) => p.id === `rule-${all.id}`)!.rules[0]!
    expect(own(compile(m)).response_actions_on_match).toEqual([])
    all.response.match = 'any'
    expect(() => compile(m)).not.toThrow()
    expect(own(compile(m)).response_actions_on_match).toEqual([])
  })

  it('读进来的 TXT「等于」空字符串原样保留，写回去还是它', () => {
    const cfg: KConfigLike = { version: '1.0', settings: { default_upstream: '1.1.1.1:53' }, pipeline_select: [{ pipeline: 'main', matchers: [] }], pipelines: [{ id: 'main', rules: [
      { name: 'txt', matchers: [{ type: 'domain_suffix', value: 'x.example' }], actions: [{ type: 'forward', upstream: '8.8.8.8:53' }], response_matchers: [{ type: 'response_txt_content', mode: 'exact', value: '' }], response_actions_on_match: [{ type: 'deny' }] },
    ] }] }
    const model = importKernel(cfg).model
    expect(model.rules.find((r) => r.name === 'txt')!.raw).toBeDefined()
    expect(mainOf(compile(model), model).rules[0]!.response_matchers).toEqual([{ type: 'response_txt_content', mode: 'exact', value: '' }])
  })
})

describe('拦截列表的回应：没有上一份时照内核里的读', () => {
  it('拦截列表回 REFUSED：读回来、再写出去还是 REFUSED', () => {
    for (const block of ['REFUSED', 'zero', 'NXDOMAIN'] as const) {
      const m = plain()
      m.defaults = { block }
      m.blocklists = { ...m.blocklists, custom: '||ads.example^' }
      const k = compile(m)
      const action = (c: KernelConfig) => c.pipelines.find((p) => p.id === 'blocklist')!.rules[0]!.actions
      const back = importKernel(clone(k) as KConfigLike).model
      expect(back.defaults.block).toBe(block)
      expect(action(compile(back))).toEqual(action(k))
    }
  })

  it('JSON 里把拦截列表的回应改了：按内核里的读，「拦截 · 沿用默认」的规则跟着新的默认，写出去不变', () => {
    const m = plain()
    m.blocklists = { ...m.blocklists, custom: '||ads.example^' }
    const k = clone(compile(m))
    k.pipelines.find((p) => p.id === 'blocklist')!.rules[0]!.actions = [{ type: 'deny' }]
    const back = readConfig(k as unknown as Record<string, unknown>, clone(m)).model
    expect(back.defaults.block).toBe('REFUSED')
    const ads = (x: Model) => x.rules.find((r) => r.name === '广告与跟踪')!
    expect(ads(back).outcome).toEqual({ type: 'block', response: 'NXDOMAIN' })
    expect(kernelKey(compile(back))).toBe(kernelKey(k))
  })
})

describe('内核规则名：面板起的名字不和高级规则原样写回的名字撞', () => {
  it('高级规则原样叫 rule-3、没名字的规则编号是 3：两个名字不一样，JSON 里改了别处读回来各是各的', () => {
    const m = sampleModel()
    const raw: Rule = { ...newRule(50, { type: 'continue' }), name: '旧规则', note: '高级规则的备注', raw: [{ name: 'rule-3', matchers: [{ type: 'domain_suffix', value: 'old.example' }], actions: [{ type: 'deny' }] }] }
    const unnamed: Rule = { ...newRule(3, { type: 'block', response: 'NXDOMAIN' }), name: '', note: '没名字那条的备注', conditions: [[{ id: 4, field: 'domain', negate: false, regex: false, values: ['new.example'] }]] }
    m.rules = [raw, unnamed, ...m.rules]
    const { config, index } = compileNamed(m)
    const names = mainOf(config, m).rules.map((r) => r.name)
    expect(names.filter((n) => n === 'rule-3')).toHaveLength(1)
    expect(index.lookup('main', 'rule-3')).toEqual({ kind: 'rule', id: 50 })
    expect(index.lookup('main', names[1]!)).toEqual({ kind: 'rule', id: 3 })
    expect(kernelPreview(m, unnamed, null).rules).toEqual([mainOf(config, m).rules[1]])
    const back = editElsewhere(m)
    expect(back.rules.slice(0, 2).map((r) => ({ id: r.id, name: r.name, note: r.note, raw: Boolean(r.raw) }))).toEqual([
      { id: 50, name: '旧规则', note: '高级规则的备注', raw: true }, { id: 3, name: '', note: '没名字那条的备注', raw: false },
    ])
  })
})

describe('Pipeline 的 id 不重复：内核的校验不收，启动时照收但只有第一个生效', () => {
  const repeated = (m: Model) => { const ids = compile(m).pipelines.map((p) => p.id); return ids.filter((id, i) => ids.indexOf(id) !== i) }

  it('JSON 里有一个叫 domain_mapping 的规则列表、又加了域名映射：映射的 Pipeline 另起一个名字', () => {
    const m = plain()
    const mappings = m.mappings
    m.mappings = []
    const k = clone(compile(m))
    // 规则组的 Pipeline 改名成 domain_mapping / The rule group's pipeline renamed to domain_mapping
    const lan = k.pipelines.find((p) => p.id === 'group-lan')!
    lan.id = 'domain_mapping'
    for (const p of k.pipelines) for (const r of p.rules) for (const a of r.actions) if (a.pipeline === 'group-lan') a.pipeline = 'domain_mapping'
    const back = readConfig(k as unknown as Record<string, unknown>, clone(m)).model
    back.mappings = mappings
    expect(repeated(back)).toEqual([])
  })

  it('读进来的配置里两个 Pipeline 同名：照内核只留第一个，读出来的模型不再编出两个', () => {
    // kids 有入口又有跳转进去，读成规则组 / kids is both an entry and a jump target, so it reads as a rule group
    const cfg: KConfigLike = { version: '1.0', settings: { default_upstream: '1.1.1.1:53' }, pipeline_select: [{ pipeline: 'kids', matchers: [{ type: 'client_ip', cidr: '192.168.1.100/30' }] }, { pipeline: 'main', matchers: [] }], pipelines: [
      { id: 'main', rules: [{ name: 'to-kids', matchers: [{ type: 'domain_suffix', value: 'kids.example' }], actions: [{ type: 'jump_to_pipeline', pipeline: 'kids' }] }, { name: 'rest', matchers: [], actions: [{ type: 'forward', upstream: '8.8.8.8:53' }] }] },
      { id: 'kids', rules: [{ name: 'old', matchers: [{ type: 'domain_suffix', value: 'old.example' }], actions: [{ type: 'deny' }] }, { name: 'kids-rest', matchers: [], actions: [{ type: 'forward', upstream: '9.9.9.9:53' }] }] },
      { id: 'kids', rules: [{ name: 'new', matchers: [{ type: 'domain_suffix', value: 'new.example' }], actions: [{ type: 'deny' }] }, { name: 'kids-rest', matchers: [], actions: [{ type: 'forward', upstream: '9.9.9.9:53' }] }] },
    ] }
    const { model, notes } = importKernel(cfg)
    expect(notes.map((n) => n.text)).toContain('有几个 Pipeline 都叫「kids」，KixDNS 只有第一个生效，后面的已去掉')
    expect(repeated(model)).toEqual([])
    const again = compile(model) as KConfigLike
    expect(behaviourCheck(cfg, again).mismatches.slice(0, 3)).toEqual([])
    // 留下的是第一个：old.example 照拦，new.example 不拦 / The first stays: old.example is still denied, new.example is not
    const kids = { client: '192.168.1.101', qtype: 'A' }
    expect([simulate(again, { ...kids, domain: 'old.example' }, checkResponder).rcode, simulate(again, { ...kids, domain: 'new.example' }, checkResponder).rcode]).toEqual(['REFUSED', 'NOERROR'])
  })

  it('内核最简单的那种配置（main 里只有一条转发）：读进来再写出去，主列表不和上游组同名，其余请求不转给自己', () => {
    // 转发那条规则写成面板编出来的样子、名字就叫 main 时，上游组编出来和内核里的一字不差，接回上一份时也要按 id 再看一遍 / With the forward rule
    // written as the panel compiles it and named main, the group compiles to exactly what the kernel holds, so carrying over must look at the id as well
    const asCompiled = { matcher_operator: 'and', response_matchers: [], response_matcher_operator: 'and', response_actions_on_match: [], response_actions_on_miss: [] }
    for (const rule of [{ name: 'up' }, { name: 'main', ...asCompiled }]) {
      const cfg: KConfigLike = { version: '1.0', settings: { default_upstream: '1.1.1.1:53' }, pipeline_select: [{ pipeline: 'main', matchers: [] }], pipelines: [{ id: 'main', rules: [{ ...rule, matchers: [], actions: [{ type: 'forward', upstream: '223.5.5.5:53' }] }] }] }
      // 以前读出来的模型里这个组留着 main 这个 Pipeline id：接回上一份时也不再留 / A model read before kept main as this group's pipeline id: carried
      // over, it is not kept either
      const old = importKernel(cfg).model
      old.groups[0]!.pipelineId = 'main'
      for (const prev of [undefined, importKernel(cfg).model, old]) {
        const model = importKernel(cfg, prev && JSON.parse(JSON.stringify(prev)) as Model).model
        expect(repeated(model)).toEqual([])
        // 组还是上一份那个（编号、名字），只是不再叫 main / The group is still the previous one (id, name), only no longer called main
        if (prev) expect(model.groups.map((g) => [g.id, g.name, g.pipelineId])).toEqual(prev.groups.map((g) => [g.id, g.name, undefined]))
        const k = compile(model)
        for (const p of k.pipelines) for (const r of p.rules) for (const a of r.actions) if (a.type === 'jump_to_pipeline') expect(a.pipeline).not.toBe(p.id)
        expect(behaviourCheck(cfg, k as KConfigLike).mismatches.slice(0, 3)).toEqual([])
        // 再读一遍还是同一个组 / Read once more, it is still the same group
        const again = importKernel(clone(k) as KConfigLike, clone(model)).model
        expect(again.groups).toEqual(model.groups)
        expect(kernelKey(compile(again))).toBe(kernelKey(k))
      }
    }
  })

  it('同名的两个 Pipeline 在测试里直接报错，不悄悄写出去', () => {
    const m = plain()
    m.rawPipelines = [{ id: 'main', rules: [] }]
    expect(() => compile(m)).toThrow(/main/)
  })
})

describe('「」里的名字先认页面上的标题，再认内核里的名字', () => {
  it('叫 rule-3 的规则和编号是 3 的没名字的规则：「rule-3」指前一条', () => {
    const m = sampleModel()
    m.rules = [
      { ...newRule(3, { type: 'block', response: 'NXDOMAIN' }), name: '', conditions: [[{ id: 1001, field: 'domain', negate: false, regex: false, values: ['a.example'] }]] },
      { ...newRule(10, { type: 'block', response: 'NXDOMAIN' }), name: 'rule-3', conditions: [[{ id: 1002, field: 'domain', negate: false, regex: false, values: ['b.example'] }]] },
      ...m.rules,
    ]
    expect(findRuleByText(m, 'rule-3')?.id).toBe(10)
    // 内核报上来的名字照样认得 / A name the kernel reports is still known
    expect(findRuleByText(m, 'rule-10')?.id).toBe(10)
    expect(findRuleByText(m, '域名属于 a.example')?.id).toBe(3)
  })
})

describe('中文域名换成 punycode：换出来是 IP 的不算域名', () => {
  it('全角数字写的 127.1 不当成域名', () => {
    for (const v of ['１２７.１', '１２７.0.0.1', '0x７f.1']) {
      expect(kernelDomain(v)).toBe(v)
      expect(isDomain(v)).toBe(false)
    }
    expect(kernelDomain('中文.example')).toBe('xn--fiq228c.example')
  })
})
