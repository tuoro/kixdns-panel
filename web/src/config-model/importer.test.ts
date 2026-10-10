import { describe, expect, it } from 'vitest'
import { importKernel } from './importer'
import { compile } from './model'
import { behaviourCheck, type KConfigLike } from './testing/kernel-sim'
import { demoModel, LEGACY_DEMO, LEGACY_MESSY, LEGACY_TEMPLATES, sampleModel } from './testing/samples'

// 迁移前后行为一致：testing/kernel-sim.ts behaviourCheck 用同一批查询分别跑原配置和「导入再生成」的配置，客户端拿到的回答必须一样。
// 模拟器只在这里用，不进运行时。
// Behaviour survives migration: testing/kernel-sim.ts behaviourCheck runs the same queries through the original and the
// imported-then-generated config, and the client must get the same answers. The simulator is used here only, never at runtime.
function expectSameBehaviour(original: KConfigLike, regenerated: KConfigLike) {
  const r = behaviourCheck(original, regenerated)
  expect(r.mismatches.slice(0, 3)).toEqual([])
  return r.checked
}

describe('迁移：行为一致 / migration keeps behaviour', () => {
  for (const [name, cfg] of [['现在面板的模板 / today\'s templates', LEGACY_TEMPLATES], ['演示配置 / demo', LEGACY_DEMO], ['手写的复杂配置 / messy', LEGACY_MESSY]] as const) {
    it(name, () => {
      const { model } = importKernel(cfg)
      expect(expectSameBehaviour(cfg, compile(model) as KConfigLike)).toBeGreaterThan(1000)
    })
  }
  it('新格式生成的配置读回来再生成，行为不变 / a new-format config read back and regenerated behaves the same', () => {
    const cfg = compile(sampleModel()) as KConfigLike
    const { model } = importKernel(cfg)
    expect(expectSameBehaviour(cfg, compile(model) as KConfigLike)).toBeGreaterThan(1000)
  })
})

describe('迁移：读成什么样 / migration: what it reads as', () => {
  it('现在面板的模板全部变成普通规则，没有高级规则 / today\'s templates become plain rules, no advanced ones', () => {
    const { model, stats, notes } = importKernel(LEGACY_TEMPLATES)
    expect(stats.raw).toBe(0)
    expect(model.entries).toBeUndefined()
    expect(model.mappings.map((m) => `${m.domain}>${m.target}`)).toEqual(['nas.home.arpa>nas.lan', 'files.home.arpa>nas.lan'])
    expect(model.rules.map((r) => r.name)).toEqual(['cn-doh', 'ad_block-rule', 'client_dns', 'domain_dns'])
    const cn = model.rules[0]!
    expect(cn.conditions).toEqual([[expect.objectContaining({ field: 'geosite', negate: false, values: ['cn'] })]])
    expect(cn.response).toMatchObject({ mode: 'custom', match: 'any', thenLog: 'warn', then: { type: 'upstream', group: 'global_doh' } })
    expect(cn.response.conditions).toEqual([expect.objectContaining({ field: 'answer_ip', values: ['0.0.0.0/32', '240.0.0.0/4', '255.255.255.255/32'] })])
    expect(model.rules[1]!.outcome).toEqual({ type: 'block', response: 'REFUSED' })
    expect(model.rest).toEqual({ type: 'upstream', group: 'global_doh' })
    expect(model.groups.map((g) => g.name)).toEqual(['client_dns', 'domain_dns', 'global_doh', 'doh.pub 等 2 个'])
    expect(model.groups.find((g) => g.id === 'domain_dns')!.addresses).toEqual([{ address: '10.0.0.53:53', protocol: 'tcp' }])
    expect(notes.filter((n) => n.level === 'warn')).toEqual([])
  })
  it('新格式读回来和原来的样子一样 / a new-format config reads back as it was written', () => {
    const before = sampleModel()
    const { model, stats } = importKernel(compile(before) as KConfigLike, before)
    expect(stats.raw).toBe(0)
    const shape = (m: typeof before) => ({
      groups: m.groups.map((g) => [g.id, g.name, g.addresses, g.ecs, g.fallback]),
      rules: m.rules.map((r) => [r.name, r.enabled, r.outcome, r.ecs, r.log, r.response.mode, r.conditions.map((g) => g.map((c) => [c.field, c.negate, Boolean(c.regex), [...c.values].sort()]))]),
      ruleGroups: m.ruleGroups.map((g) => [g.id, g.name, g.rest, g.listener, g.rules.map((r) => r.name)]),
      mappings: m.mappings.map((x) => [x.domain, x.target, x.ttl, x.enabled]),
      rest: m.rest,
    })
    expect(shape(model)).toEqual(shape(before))
  })
  it('没起名字的规则读回来还是没有名字，相邻的两条也不会合成一条 / unnamed rules read back unnamed, and two neighbours stay apart', () => {
    const before = demoModel()
    // 苹果服务有两个多值条件，编出来拆成 #1、#2；复制成两条相邻、都没名字、去向一样的规则
    // 苹果服务 has two multi-value conditions and compiles to #1, #2; copy it into two adjacent unnamed rules with the same outcome
    const at = before.rules.findIndex((r) => r.name === '苹果服务')
    const twin = (id: number) => ({ ...JSON.parse(JSON.stringify(before.rules[at])), id, name: '' })
    before.rules.splice(at, 1, twin(9001), twin(9002))
    const { model } = importKernel(compile(before) as KConfigLike, before)
    expect(model.rules.map((r) => r.name)).toEqual(before.rules.map((r) => r.name))
    expect(model.rules.filter((r) => !r.name && r.conditions.length === before.rules[at]!.conditions.length).length).toBeGreaterThanOrEqual(2)
  })
  it('复杂配置：放不进的原样保留，每一处改动都有说明 / messy: what does not fit is kept verbatim and every change is explained', () => {
    const { model, notes, stats } = importKernel(LEGACY_MESSY)
    const text = notes.map((n) => n.text).join('\n')
    expect(model.extra).toEqual({ background_refresh_rule: LEGACY_MESSY.background_refresh_rule })
    expect(model.ruleGroups.find((g) => g.id === 'lan')!.listener).toBe('lan')
    // 监听标签加别的条件的入口原样保留，排在它后面的带条件入口照样变成规则 / A listener-plus-condition entry stays verbatim; a conditional entry after it still becomes a rule
    expect(model.entries).toEqual([{ pipeline: 'special', matchers: [{ type: 'listener_label', value: 'guest' }, { type: 'qtype', value: 'AAAA' }] }])
    expect(model.rules[0]!.name).toBe('kids-block')
    // 永远轮不到的入口原样留在最后；几个转发、决定结果后还有动作的规则原样保留成高级规则，不替用户整理
    // An entry that never runs stays verbatim at the end; rules with several forwards or with actions after the deciding one are kept verbatim as advanced rules, not tidied
    expect(text).toContain('入口「never」排在接住所有请求的入口后面，永远轮不到，原样保留在最后')
    expect(model.trailingEntries).toEqual([{ pipeline: 'never', matchers: [{ type: 'qtype', value: 'MX' }] }])
    expect(text).toContain('「ads」放不进新的规则格式（决定结果的动作后面还有 1 个动作）')
    expect(text).toContain('「two-forwards」放不进新的规则格式（一条规则里有 2 个转发）')
    expect(text).toContain('「odd-field」放不进新的规则格式')
    expect(text).toContain('「weird-response」放不进新的规则格式')
    expect(text).toContain('geosite:分类')
    expect(stats.raw).toBe(4)
    const messy = compile(model) as KConfigLike
    expect(messy.pipeline_select!.at(-1)).toEqual({ pipeline: 'never', matcher_operator: 'and', matchers: [{ type: 'qtype', value: 'MX' }] })
    expect(messy.pipelines!.find((p) => p.id === 'main')!.rules!.find((r) => r.name === 'two-forwards')).toEqual(LEGACY_MESSY.pipelines![0]!.rules!.find((r) => r.name === 'two-forwards'))
    // 规则级 and_not：第一项肯定，其余否定 / rule-level and_not: the first item positive, the rest negated
    const ptr = model.rules.find((r) => r.name === 'not-private-ptr')!
    expect(ptr.conditions).toEqual([[expect.objectContaining({ field: 'qtype', negate: false, values: ['PTR'] }), expect.objectContaining({ field: 'client_private', negate: true })]])
  })
})
