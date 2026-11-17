import { beforeEach, describe, expect, it } from 'vitest'
import type { RuleCount } from '../api/types'
import { compile, kernelRuleCount, mainPipelineId, ruleGroupPipelineId, type Model, type Rule } from '../config-model/model'
import { demoModel } from '../config-model/testing/samples'
import { appliedModel, applyHits, hitsOf, model, resetTo, ruleLogQuery } from './store'
import { rulesAnswering } from './useConfigDocument'

const named = (m: Model, name: string): Rule => [...m.rules, ...m.ruleGroups.flatMap((g) => g.rules)].find((r) => r.name === name)!

// 内核按「列表 + 规则名」计数，同名的合在一个计数器里。每条内核规则真正命中的次数各不相同（按全局顺序取 2 的幂，不超过 2^53），合错了看得出来
// The kernel counts per list and rule name, so equal names share one counter. Every kernel rule's true count differs (a power of 2 by global
// order, below 2^53), so a wrong merge shows
function truths(m: Model): Map<string, number[]> {
  const out = new Map<string, number[]>()
  let next = 0
  for (const p of compile(m).pipelines) out.set(p.id, p.rules.map(() => 2 ** next++))
  return out
}
function kernelCounts(m: Model): RuleCount[] {
  const truth = truths(m)
  const totals = new Map<string, RuleCount>()
  for (const p of compile(m).pipelines) {
    p.rules.forEach((r, at) => {
      const key = `${p.id}\n${r.name}`
      totals.set(key, { pipeline: p.id, rule: r.name, phase: 'request', count: (totals.get(key)?.count ?? 0) + truth.get(p.id)![at]! })
    })
  }
  return [...totals.values()]
}

// 一条规则真正命中了多少：它在内核里按顺序占着几段（kernelRuleCount），每段各自的数加起来。和名字无关
// What a rule really matched: it holds its parts in order in the kernel (kernelRuleCount), and their own counts add up. Independent of names
function ownCount(m: Model, rule: Rule): number {
  const group = m.ruleGroups.find((g) => g.rules.some((r) => r.id === rule.id))
  const list = group ? group.rules : m.rules
  const truth = truths(m).get(group ? ruleGroupPipelineId(m, group.id) : mainPipelineId(m))!
  let at = 0
  for (const r of list.filter((x) => x.enabled)) {
    const n = kernelRuleCount(r)
    if (r.id === rule.id) return truth.slice(at, at + n).reduce((a, b) => a + b, 0)
    at += n
  }
  return 0
}

describe('命中数按规则在内核里的名字认，各算各的', () => {
  beforeEach(() => resetTo(demoModel()))

  const apply = (edit: (m: Model) => void) => {
    const m = demoModel()
    edit(m)
    resetTo(m)
    applyHits(kernelCounts(appliedModel.value))
  }

  it('两条规则重名：各是各的数，不是两条加起来', () => {
    apply((m) => { named(m, '公司内网').name = '重名'; named(m, '广告与跟踪').name = '重名' })
    const [a, b] = model.rules.filter((r) => r.name === '重名')
    expect(hitsOf(a!)).not.toBe(hitsOf(b!))
    expect(hitsOf(a!)).toBe(ownCount(appliedModel.value, a!))
    expect(hitsOf(b!)).toBe(ownCount(appliedModel.value, b!))
  })

  it('规则叫「测试#1」、还有一条叫「测试」：「测试#1」不是 0，也不算进「测试」', () => {
    apply((m) => { named(m, '公司内网').name = '测试#1'; named(m, '广告与跟踪').name = '测试' })
    const hash = model.rules.find((r) => r.name === '测试#1')!
    const plain = model.rules.find((r) => r.name === '测试')!
    expect(hitsOf(hash)).toBeGreaterThan(0)
    expect(hitsOf(hash)).toBe(ownCount(appliedModel.value, hash))
    expect(hitsOf(plain)).toBe(ownCount(appliedModel.value, plain))
  })

  it('规则叫「其余请求」：不把兜底的命中算到它头上', () => {
    apply((m) => { named(m, '公司内网').name = '其余请求' })
    const rest = model.rules.find((r) => r.name === '其余请求')!
    expect(hitsOf(rest)).toBe(ownCount(appliedModel.value, rest))
  })

  it('规则叫 rule-编号、正好是一条没起名字的规则的编号：两条不串数', () => {
    apply((m) => { const unnamed = m.rules.find((r) => !r.name && r.enabled)!; named(m, '公司内网').name = `rule-${unnamed.id}` })
    const unnamed = model.rules.find((r) => !r.name && r.enabled)!
    const shaped = model.rules.find((r) => r.name === `rule-${unnamed.id}`)!
    expect(hitsOf(shaped)).toBe(ownCount(appliedModel.value, shaped))
    expect(hitsOf(unnamed)).toBe(ownCount(appliedModel.value, unnamed))
  })

  it('草稿里改了名字还没保存：命中数照旧（内核跑的还是保存的那份）', () => {
    apply(() => {})
    const office = model.rules.find((r) => r.name === '公司内网')!
    const before = hitsOf(office)
    expect(before).toBeGreaterThan(0)
    office.name = '公司内网（新）'
    applyHits(kernelCounts(appliedModel.value))
    expect(hitsOf(office)).toBe(before)
  })

  it('命中数点进查询日志：筛选条件挑出来的正好是这条规则在内核里的几段', () => {
    apply((m) => { named(m, '公司内网').name = '重名'; named(m, '广告与跟踪').name = '重名' })
    const base = (name: string) => name.replace(/#\d+$/, '')
    for (const rule of model.rules.filter((r) => r.enabled)) {
      const query = ruleLogQuery(rule)
      if (!query) continue
      const m = appliedModel.value
      const pipeline = compile(m).pipelines.find((p) => p.id === query.in)!
      const truth = truths(m).get(query.in)!
      // 服务端按基名在这个列表里挑；挑出来的几段的真实命中加起来要等于这条规则的 / The server picks by base name in this list; the parts it picks must add up to this rule's own count
      const picked = pipeline.rules.map((r, at) => (base(r.name) === query.rule ? truth[at]! : 0)).reduce((a, b) => a + b, 0)
      expect(picked, rule.name || `rule-${rule.id}`).toBe(ownCount(m, rule))
    }
  })
})

describe('回答写成域名的是哪几条规则：按编译时的对照表认', () => {
  it('两条重名、一条叫「测试#1」，都回 CNAME：三条都认得出，没有认不回来的', () => {
    const m = demoModel()
    const cname = { type: 'answer' as const, kind: 'cname' as const, value: 'target.example', ttl: null }
    const picked = [named(m, '公司内网'), named(m, '广告与跟踪'), named(m, '火狐 DoH 探测')]
    picked[0]!.name = '重名'
    picked[1]!.name = '重名'
    picked[2]!.name = '测试#1'
    for (const r of picked) r.outcome = cname
    const used = rulesAnswering(m, 'static_cname_response')
    expect(used.rules.map((r) => r.id).sort()).toEqual(picked.map((r) => r.id).sort())
    expect(used.untraced).toBe(0)
  })

  it('两条高级规则一条写回「foo#2」、一条写回「foo」：各认各的', () => {
    const m = demoModel()
    const kernel = (name: string) => ({ name, matchers: [{ type: 'any' }], matcher_operator: 'and', actions: [{ type: 'static_cname_response', target: 'target.example' }] })
    const a = named(m, '公司内网')
    const b = named(m, '广告与跟踪')
    a.raw = [kernel('foo#2')]
    b.raw = [kernel('foo')]
    const used = rulesAnswering(m, 'static_cname_response')
    expect(used.rules.map((r) => r.id).sort()).toEqual([a.id, b.id].sort())
    expect(used.untraced).toBe(0)
  })
})
