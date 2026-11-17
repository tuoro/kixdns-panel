import { describe, expect, it } from 'vitest'
import { importKernel } from './importer'
import { blocklistPipelineId, compile, kernelPreview, kernelRuleIndex, mainPipelineId, ruleGroupPipelineId, upstreamPipelineId, type Model, type Rule } from './model'
import { exportConfig, readConfig } from './document'
import { LEGACY_DEMO, LEGACY_MESSY, LEGACY_TEMPLATES, demoModel, sampleModel } from './testing/samples'
import { findKernelRule, traceNames } from './trace-names'

const named = (m: Model, name: string): Rule => [...m.rules, ...m.ruleGroups.flatMap((g) => g.rules)].find((r) => r.name === name)!
const kernelNamesIn = (m: Model, pipeline: string): string[] => compile(m).pipelines.find((p) => p.id === pipeline)!.rules.map((r) => r.name)
// 改名前的起名办法：名字，没名字用 rule-编号，拆开的加 #N / The naming before this change: the name, rule-<id> when unnamed, #N on split parts
const oldNames = (m: Model, pipeline: string, rules: Rule[], rest: string): string[] => {
  const here = kernelNamesIn(m, pipeline)
  return [...rules.filter((r) => r.enabled).flatMap((r) => {
    if (r.raw) return r.raw.map((k) => String(k.name))
    const base = r.name.trim() || `rule-${r.id}`
    const parts = here.filter((n) => new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#\\d+$`).test(n))
    return parts.length ? parts : [base]
  }), rest]
}

describe('内核规则名由编译端起，同一个列表里认不错', () => {
  it('两条规则重名：两条都用 rule-编号，各算各的', () => {
    const m = demoModel()
    named(m, '公司内网').name = '重名'
    named(m, '广告与跟踪').name = '重名'
    const [a, b] = m.rules.filter((r) => r.name === '重名')
    const names = kernelNamesIn(m, mainPipelineId(m))
    expect(names).not.toContain('重名')
    expect(names).toContain(`rule-${a!.id}`)
    expect(names).toContain(`rule-${b!.id}`)
  })

  it('名字以 #数字 结尾、形如 rule-数字、和本列表的其余请求同名：都用 rule-编号', () => {
    const m = demoModel()
    const hash = named(m, '公司内网')
    hash.name = '测试#1'
    const shaped = named(m, '广告与跟踪')
    shaped.name = 'rule-999'
    const rest = named(m, '火狐 DoH 探测')
    rest.name = '其余请求'
    const group = m.ruleGroups[0]!
    const inGroup = group.rules[0]!
    inGroup.name = `${group.name}·其余`
    const main = kernelNamesIn(m, mainPipelineId(m))
    expect(main).toContain(`rule-${hash.id}`)
    expect(main).toContain(`rule-${shaped.id}`)
    expect(main).toContain(`rule-${rest.id}`)
    expect(main.filter((n) => n === '其余请求')).toHaveLength(1)
    expect(main.some((n) => n.startsWith('测试#'))).toBe(false)
    const groupNames = kernelNamesIn(m, ruleGroupPipelineId(m, group.id))
    expect(groupNames).toContain(`rule-${inGroup.id}`)
    expect(groupNames.filter((n) => n === `${group.name}·其余`)).toHaveLength(1)
  })

  it('不同列表里同名不算撞：照旧用名字', () => {
    const m = demoModel()
    const group = m.ruleGroups[0]!
    group.rules[0]!.name = '公司内网'
    expect(kernelNamesIn(m, mainPipelineId(m))).toContain('公司内网')
    expect(kernelNamesIn(m, ruleGroupPipelineId(m, group.id))).toContain('公司内网')
  })

  it('重名的几条一起改用编号：调整顺序以后内核名不变', () => {
    const m = demoModel()
    named(m, '公司内网').name = '重名'
    named(m, '广告与跟踪').name = '重名'
    const before = new Set(kernelNamesIn(m, mainPipelineId(m)))
    m.rules.reverse()
    expect(new Set(kernelNamesIn(m, mainPipelineId(m)))).toEqual(before)
  })

  it('停用的规则不占名字：只有一条启用时它照旧用名字', () => {
    const m = demoModel()
    named(m, '公司内网').name = '重名'
    const off = named(m, '广告与跟踪')
    off.name = '重名'
    off.enabled = false
    expect(kernelNamesIn(m, mainPipelineId(m))).toContain('重名')
  })

  it('没有撞名的配置，内核名和以前一模一样', () => {
    for (const m of [sampleModel(), demoModel(), importKernel(LEGACY_TEMPLATES).model, importKernel(LEGACY_DEMO).model, importKernel(LEGACY_MESSY).model]) {
      expect(kernelNamesIn(m, mainPipelineId(m))).toEqual(oldNames(m, mainPipelineId(m), m.rules, '其余请求'))
      for (const g of m.ruleGroups) expect(kernelNamesIn(m, ruleGroupPipelineId(m, g.id))).toEqual(oldNames(m, ruleGroupPipelineId(m, g.id), g.rules, `${g.name}·其余`))
    }
  })
})

describe('对照表：列表 + 内核名 → 面板里的哪一样', () => {
  it('规则、拆开的几段、它们的基名都指向同一条规则；其余请求、拦截列表、域名映射、转发规则各有归属', () => {
    const m = sampleModel()
    const index = kernelRuleIndex(m)
    const main = mainPipelineId(m)
    const apple = named(m, '苹果服务')
    expect(kernelNamesIn(m, main)).toContain('苹果服务#2')
    expect(index.lookup(main, '苹果服务#1')).toEqual({ kind: 'rule', id: apple.id })
    expect(index.lookup(main, '苹果服务#2')).toEqual({ kind: 'rule', id: apple.id })
    expect(index.lookup(main, '苹果服务')).toEqual({ kind: 'rule', id: apple.id })
    expect(index.lookup(main, '其余请求')).toEqual({ kind: 'rest' })
    const group = m.ruleGroups[0]!
    expect(index.lookup(ruleGroupPipelineId(m, group.id), `${group.name}·其余`)).toEqual({ kind: 'groupRest', group: group.id })
    const mapping = m.mappings.find((x) => x.enabled)!
    expect(index.lookup(m.mappingId ?? 'domain_mapping', `域名映射 ${mapping.domain.trim()}`)).toEqual({ kind: 'mapping', domain: mapping.domain.trim() })
    const g = m.groups[0]!
    const up = upstreamPipelineId(m, g.id)
    expect(index.lookup(up, up)).toEqual({ kind: 'forward', group: g.id })
    // 不在那个列表里的名字认不出 / A name outside its list is not recognised
    expect(index.lookup(up, '其余请求')).toBeNull()
    expect(index.lookup(main, '没有这条')).toBeNull()
  })

  it('一个名字被两样东西认领时谁也不归：宁可认不出，不认错', () => {
    const m = demoModel()
    const adv = named(m, '公司内网')
    adv.raw = [{ name: '其余请求', matchers: [{ type: 'any' }], matcher_operator: 'and', actions: [{ type: 'deny' }] }]
    expect(kernelRuleIndex(m).lookup(mainPipelineId(m), '其余请求')).toBeNull()
  })

  it('高级规则原样写回的名字认回那条高级规则；用户的名字撞上它的基名时改用编号', () => {
    const m = demoModel()
    const adv = named(m, '公司内网')
    adv.raw = [{ name: '老规则#2', matchers: [{ type: 'any' }], matcher_operator: 'and', actions: [{ type: 'deny' }] }]
    const plain = named(m, '广告与跟踪')
    plain.name = '老规则'
    const main = mainPipelineId(m)
    expect(kernelNamesIn(m, main)).toContain(`rule-${plain.id}`)
    expect(kernelRuleIndex(m).lookup(main, '老规则#2')).toEqual({ kind: 'rule', id: adv.id })
    expect(kernelRuleIndex(m).lookup(main, `rule-${plain.id}`)).toEqual({ kind: 'rule', id: plain.id })
  })

  it('不知道是哪个列表时：只在一个列表里有的名字照样认得，几个列表都有的认不出', () => {
    const m = demoModel()
    const group = m.ruleGroups[0]!
    group.rules[0]!.name = '公司内网'
    const index = kernelRuleIndex(m)
    expect(index.lookup(null, '公司内网')).toBeNull()
    expect(index.lookup(null, '广告与跟踪')).toEqual({ kind: 'rule', id: named(m, '广告与跟踪').id })
  })

  it('规则在内核里的名字：命中数和查询日志链接用它', () => {
    const m = demoModel()
    const dup = named(m, '公司内网')
    dup.name = '重名'
    named(m, '广告与跟踪').name = '重名'
    const index = kernelRuleIndex(m)
    expect(index.nameOf(dup.id)).toEqual({ pipeline: mainPipelineId(m), name: `rule-${dup.id}` })
    expect(index.nameOf(named(m, '苹果服务').id)).toEqual({ pipeline: mainPipelineId(m), name: '苹果服务' })
    expect(index.nameOf(-1)).toBeNull()
  })
  it('高级规则写回的几条没有共同的基名：认得出每一条，但没有一个名字能代表它', () => {
    const m = demoModel()
    const adv = named(m, '公司内网')
    adv.raw = [
      { name: '甲', matchers: [{ type: 'any' }], matcher_operator: 'and', actions: [{ type: 'continue' }] },
      { name: '乙', matchers: [{ type: 'any' }], matcher_operator: 'and', actions: [{ type: 'deny' }] },
    ]
    const index = kernelRuleIndex(m)
    expect(index.lookup(mainPipelineId(m), '乙')).toEqual({ kind: 'rule', id: adv.id })
    expect(index.nameOf(adv.id)).toBeNull()
  })

  it('高级规则写回「foo#2」、另一条写回「foo」：确切的名字各认各的；基名两条都用着，谁也不拿它当名字', () => {
    const m = demoModel()
    const kernel = (name: string) => ({ name, matchers: [{ type: 'any' }], matcher_operator: 'and', actions: [{ type: 'deny' }] })
    const a = named(m, '公司内网')
    const b = named(m, '广告与跟踪')
    a.raw = [kernel('foo#2')]
    b.raw = [kernel('foo')]
    const index = kernelRuleIndex(m)
    const main = mainPipelineId(m)
    expect(index.lookup(main, 'foo#2')).toEqual({ kind: 'rule', id: a.id })
    expect(index.lookup(main, 'foo')).toEqual({ kind: 'rule', id: b.id })
    expect(index.nameOf(a.id)).toBeNull()
    expect(index.nameOf(b.id)).toBeNull()
  })

  it('规则自带的转发（单独设了 ECS）：里面那条是内部步骤，认回这条规则', () => {
    const m = demoModel()
    const rule = m.rules.find((r) => r.enabled && !r.raw && r.outcome.type === 'upstream')!
    rule.ecs = { mode: 'clear' } as Rule['ecs']
    const own = compile(m).pipelines.find((p) => p.id === `rule-${rule.id}`)!
    expect(kernelRuleIndex(m).lookup(own.id, own.rules[0]!.name)).toEqual({ kind: 'ownForward', id: rule.id })
    expect(traceNames(m).plumbing(own.rules[0]!.name, own.id)).toBe(true)
    expect(traceNames(m).plumbing(own.rules[0]!.name, mainPipelineId(m))).toBe(false)
  })
})

describe('执行路径按列表认名字', () => {
  it('用户的规则叫「拦截列表」「域名映射 x」「其余请求」：在主列表里命中时说的是这条规则', () => {
    const m = demoModel()
    named(m, '公司内网').name = '拦截列表'
    named(m, '广告与跟踪').name = '域名映射 nas'
    const rest = named(m, '火狐 DoH 探测')
    rest.name = '其余请求'
    // 自己写一条拦截，拦截列表那个列表才会写进内核 / One block of one's own, so the blocklists' list is written to the kernel
    m.blocklists.custom = 'ads.example'
    const names = traceNames(m)
    const main = mainPipelineId(m)
    expect(names.matched('拦截列表', main)).toBeNull()
    expect(names.rule('拦截列表', main)).toBe('拦截列表')
    expect(names.matched('域名映射 nas', main)).toBeNull()
    expect(names.matched(`rule-${rest.id}`, main)).toBeNull()
    expect(names.rule(`rule-${rest.id}`, main)).toBe('其余请求')
    // 面板自己生成的那几条照旧整句说 / The panel's own generated rules still read as whole sentences
    expect(names.matched('其余请求', main)).toBe('没有规则命中，按「其余请求」处理')
    expect(names.matched('拦截列表', blocklistPipelineId(m))).toBe('要拦截的域名里有它')
  })

  it('规则叫「测试#1」、还有一条叫「测试」：各认各的', () => {
    const m = demoModel()
    const hash = named(m, '公司内网')
    hash.name = '测试#1'
    const plain = named(m, '广告与跟踪')
    plain.name = '测试'
    const main = mainPipelineId(m)
    const kernel = kernelNamesIn(m, main)
    expect(findKernelRule(m, `rule-${hash.id}`, main)?.id).toBe(hash.id)
    expect(kernel).toContain('测试')
    expect(findKernelRule(m, '测试', main)?.id).toBe(plain.id)
  })

  it('规则组的「组名·其余」只在那个组里是兜底：主列表里同名的规则说的是规则本身', () => {
    const m = sampleModel()
    const group = m.ruleGroups[0]!
    const rule = m.rules.find((r) => r.enabled && !r.raw)!
    rule.name = `${group.name}·其余`
    const names = traceNames(m)
    expect(names.matched(`${group.name}·其余`, mainPipelineId(m))).toBeNull()
    expect(names.rule(`${group.name}·其余`, mainPipelineId(m))).toBe(`${group.name}·其余`)
    expect(names.matched(`${group.name}·其余`, ruleGroupPipelineId(m, group.id))).toBe(`规则组「${group.name}」里没有规则命中，按「其余请求」处理`)
  })
})

describe('JSON 视图改过以后读回来：名字、备注、编号都接得回', () => {
  it('重名、以 #数字 结尾的规则在内核里是 rule-编号，读回来还是原来的名字和备注', () => {
    const m = demoModel()
    const a = named(m, '公司内网')
    a.name = '重名'
    a.note = '甲'
    const b = named(m, '广告与跟踪')
    b.name = '重名'
    b.note = '乙'
    const c = named(m, '火狐 DoH 探测')
    c.name = '测试#1'
    c.note = '丙'
    const cfg = exportConfig(m)
    // 手改一处设置，散列对不上；只改了设置时模型原样留着（见 reimport.test.ts），所以再手改一处结构（路由器组多一个地址），按内核部分重新导入
    // A hand edit to a setting breaks the hash; with settings alone changed the model stays as it was (see reimport.test.ts), so a structural
    // hand edit as well (one more address on the router group) makes the kernel part re-import
    const edited = { ...cfg, settings: { ...(cfg.settings as Record<string, unknown>), cache_capacity: 4321 } }
    const router = (cfg.pipelines as { id: string; rules: { actions: { upstream?: string }[] }[] }[]).find((p) => p.id === 'upstream-router')!
    router.rules[0]!.actions[0]!.upstream += ', 192.168.1.2:53'
    const back = readConfig(edited, m)
    expect(back.source).toBe('imported')
    for (const r of [a, b, c]) {
      const again = back.model.rules.find((x) => x.id === r.id)
      expect(again && { name: again.name, note: again.note }).toEqual({ name: r.name, note: r.note })
    }
  })

  it('没起名字的规则在 JSON 里改了条件：编号和备注照样接回来', () => {
    const m = demoModel()
    const unnamed = m.rules.find((r) => !r.name && !r.raw && r.enabled)!
    unnamed.note = '没名字的这条'
    const cfg = exportConfig(m)
    const main = (cfg.pipelines as { id: string; rules: { name: string; matchers: unknown[] }[] }[]).find((p) => p.id === mainPipelineId(m))!
    const own = main.rules.find((r) => r.name === `rule-${unnamed.id}`)!
    own.matchers = [{ type: 'domain_suffix', value: 'changed.example', operator: 'and' }]
    const back = readConfig(cfg, m)
    expect(back.source).toBe('imported')
    expect(back.model.rules.find((x) => x.id === unnamed.id)?.note).toBe('没名字的这条')
  })
})

describe('编辑器里「生成的内核规则」按规则所在的列表起名', () => {
  it('草稿和列表里另一条重名：预览里是 rule-编号；改回不撞的名字就用名字', () => {
    const m = demoModel()
    const other = named(m, '广告与跟踪')
    const draft = { ...named(m, '公司内网'), name: other.name }
    const preview = (rule: Rule) => (kernelPreview(m, rule, null).rules as { name: string }[]).map((r) => r.name)
    expect(preview(draft).every((n) => n === `rule-${draft.id}` || n.startsWith(`rule-${draft.id}#`))).toBe(true)
    expect(preview({ ...draft, name: '不撞的名字' }).every((n) => n === '不撞的名字' || n.startsWith('不撞的名字#'))).toBe(true)
    // 停用着的草稿按启用起名 / A switched-off draft is named as if enabled
    expect(preview({ ...draft, name: '不撞的名字', enabled: false }).every((n) => n.startsWith('不撞的名字'))).toBe(true)
  })

  it('规则组里的新规则叫「组名·其余」：预览里是 rule-编号', () => {
    const m = demoModel()
    const group = m.ruleGroups[0]!
    const fresh = { ...group.rules[0]!, id: 987_654, name: `${group.name}·其余` }
    expect((kernelPreview(m, fresh, group.id).rules as { name: string }[]).every((r) => r.name.startsWith('rule-987654'))).toBe(true)
  })
})
