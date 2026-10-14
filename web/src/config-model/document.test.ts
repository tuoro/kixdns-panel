import { describe, expect, it, vi } from 'vitest'
import { exportConfig, kernelPart, PANEL_FORMAT, panelHash, readConfig } from './document'
import type { KConfigLike } from './kernel'
import { compile, mainPipelineId, newRule, type Model } from './model'
import { mockRequest } from '../api/mock'
import type { ConfigDocument } from '../api/types'
import { LEGACY_TEMPLATES, sampleModel } from './testing/samples'

describe('配置文件的存取 / storing and loading the config file', () => {
  it('写出去的是内核配置加 panel 键，内核部分和 compile 一样 / what is written is the kernel config plus panel, the kernel part equal to compile', () => {
    const model = sampleModel()
    const cfg = exportConfig(model)
    expect(kernelPart(cfg)).toEqual(compile(model))
    expect(cfg.panel).toMatchObject({ v: PANEL_FORMAT, model })
    expect(typeof (cfg.panel as { hash: string }).hash).toBe('string')
  })

  it('原样读回来：散列对得上就直接用模型，没有导入报告 / read back unchanged: the hash matches, the model is used as is, no report', () => {
    const model = sampleModel()
    const back = readConfig(JSON.parse(JSON.stringify(exportConfig(model))) as Record<string, unknown>)
    expect(back.source).toBe('panel')
    expect(back.report).toBeNull()
    expect(back.model).toEqual(model)
  })

  it('内核部分被手改过：按内核部分重新导入，编号、备注和停用的规则从 panel 里接回来 / kernel part edited by hand: re-imported, with ids, notes and disabled rules carried over from panel', () => {
    const model = sampleModel()
    const cfg = JSON.parse(JSON.stringify(exportConfig(model))) as Record<string, unknown> & { settings: Record<string, unknown> }
    cfg.settings.cache_capacity = 50000
    const back = readConfig(cfg)
    expect(back.source).toBe('imported')
    expect(back.report?.stats.raw).toBe(0)
    expect(back.model.settings.cache_capacity).toBe(50000)
    const firefox = back.model.rules.find((r) => r.name === '火狐 DoH 探测')!
    const before = model.rules.find((r) => r.name === '火狐 DoH 探测')!
    expect(firefox.id).toBe(before.id)
    expect(firefox.note).toBe(before.note)
    expect(back.model.rules.find((r) => r.name === '旧统计接口')).toMatchObject({ enabled: false })
  })

  it('内核部分被手改过：没起名字的规则各自接回自己的编号，不会全接到第一条上 / kernel part edited by hand: unnamed rules each get their own id back, not all the first one\'s', () => {
    const model = sampleModel()
    const shape = model.rules.find((r) => !r.raw && r.conditions[0]?.length && r.outcome.type === 'upstream')!
    for (const [i, domain] of ['a.example.com', 'b.example.com', 'c.example.com'].entries()) {
      const rule = JSON.parse(JSON.stringify(shape)) as typeof shape
      rule.id = 901 + i
      rule.name = ''
      rule.note = `第 ${i + 1} 条`
      rule.conditions = [[{ ...rule.conditions[0]![0]!, field: 'domain', values: [domain], negate: false, regex: false }]]
      model.rules.push(rule)
    }
    const cfg = JSON.parse(JSON.stringify(exportConfig(model))) as Record<string, unknown> & { settings: Record<string, unknown> }
    cfg.settings.cache_capacity = 50000
    const back = readConfig(cfg)
    expect(back.source).toBe('imported')
    const unnamed = back.model.rules.filter((r) => !r.name && r.conditions[0]?.some((c) => c.values.some((v) => v.endsWith('.example.com'))))
    expect(unnamed.map((r) => [r.id, r.note, r.conditions[0]![0]!.values[0]])).toEqual([[901, '第 1 条', 'a.example.com'], [902, '第 2 条', 'b.example.com'], [903, '第 3 条', 'c.example.com']])
    const ids = back.model.rules.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('页面重开以后再导入手改过的配置：新加的规则编号不和接回来的旧编号撞 / after a page reload, re-importing a hand-edited config gives new rules ids that never collide with carried-over ones', async () => {
    // 第一次：内核格式的配置导进来，编号从导入器的计数开始 / First load: a kernel-format config is imported, ids come from the importer's counter
    vi.resetModules()
    const first = await import('./document')
    const imported = first.readConfig(JSON.parse(JSON.stringify(LEGACY_TEMPLATES)) as Record<string, unknown>).model
    const cfg = JSON.parse(JSON.stringify(first.exportConfig(imported))) as Record<string, unknown> & { pipelines: { id: string; rules: Record<string, unknown>[] }[] }
    // 手改：主列表最前面加两条规则 / By hand: two rules at the top of the main list
    const main = cfg.pipelines.find((p) => p.id === mainPipelineId(imported))!
    const template = main.rules[0]!
    main.rules.unshift({ ...JSON.parse(JSON.stringify(template)), name: 'by-hand-1', matchers: [{ type: 'domain_suffix', value: 'hand-1.example.com', operator: 'and' }] }, { ...JSON.parse(JSON.stringify(template)), name: 'by-hand-2', matchers: [{ type: 'domain_suffix', value: 'hand-2.example.com', operator: 'and' }] })
    // 第二次：页面重开，导入器的计数从头来 / Second load: the page reloads and the importer's counter starts over
    vi.resetModules()
    const second = await import('./document')
    const back = second.readConfig(cfg)
    expect(back.source).toBe('imported')
    const rules = [...back.model.rules, ...back.model.ruleGroups.flatMap((g) => g.rules)]
    const ids = [...rules.map((r) => r.id), ...rules.flatMap((r) => r.conditions.flat().map((c) => c.id)), ...back.model.mappings.map((m) => m.id)]
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('内核部分被手改过：停用的没名字规则放回原来的位置 / kernel part edited by hand: a disabled unnamed rule goes back to its own place', () => {
    const model: Model = sampleModel()
    model.rules = []
    const add = (domain: string, enabled = true) => {
      const rule = newRule(800 + model.rules.length, { type: 'block', response: 'default' })
      rule.enabled = enabled
      rule.conditions = [[{ id: 900 + model.rules.length, field: 'domain', values: [domain], negate: false, regex: false }]]
      model.rules.push(rule)
    }
    add('u1.example.com')
    add('u2.example.com')
    add('off.example.com', false)
    add('u3.example.com')
    const cfg = JSON.parse(JSON.stringify(exportConfig(model))) as Record<string, unknown> & { settings: Record<string, unknown> }
    cfg.settings.cache_capacity = 50000
    const back = readConfig(cfg)
    expect(back.source).toBe('imported')
    expect(back.model.rules.map((r) => r.conditions[0]![0]!.values[0])).toEqual(['u1.example.com', 'u2.example.com', 'off.example.com', 'u3.example.com'])
  })

  it('内核部分被手改过：连着的几条停用规则保持原来的先后 / kernel part edited by hand: consecutive disabled rules keep their order', () => {
    const model: Model = sampleModel()
    model.rules = []
    const add = (domain: string, enabled = true) => {
      const rule = newRule(800 + model.rules.length, { type: 'block', response: 'default' })
      rule.enabled = enabled
      rule.conditions = [[{ id: 900 + model.rules.length, field: 'domain', values: [domain], negate: false, regex: false }]]
      model.rules.push(rule)
    }
    add('off1.example.com', false)
    add('off2.example.com', false)
    add('u1.example.com')
    add('offa.example.com', false)
    add('offb.example.com', false)
    add('u2.example.com')
    const order = ['off1.example.com', 'off2.example.com', 'u1.example.com', 'offa.example.com', 'offb.example.com', 'u2.example.com']
    const cfg = JSON.parse(JSON.stringify(exportConfig(model))) as Record<string, unknown> & { settings: Record<string, unknown> }
    cfg.settings.cache_capacity = 50000
    const back = readConfig(cfg)
    expect(back.source).toBe('imported')
    expect(back.model.rules.map((r) => r.conditions[0]![0]!.values[0])).toEqual(order)
    // 再手改一次也不来回换 / A second hand edit does not swap them back and forth either
    const again = JSON.parse(JSON.stringify(exportConfig(back.model))) as Record<string, unknown> & { settings: Record<string, unknown> }
    again.settings.cache_capacity = 60000
    expect(readConfig(again).model.rules.map((r) => r.conditions[0]![0]!.values[0])).toEqual(order)
  })

  it('v4.0.0 及更早的模型里规则组带的监听标签：读进来挪成高级入口，内核里的入口和原来一样 / a listener label on a rule group in a v4.0.0-or-older model becomes an advanced entry on read, and the kernel entries stay as they were', () => {
    const model = sampleModel()
    model.entries = [{ pipeline: 'group-lan', matchers: [{ type: 'qtype', value: 'PTR' }] }]
    // v4.0.0 写出来的样子：域名映射之后、高级入口之前是「监听标签 → 规则组」 / As v4.0.0 wrote it: listener → rule group after the mappings and before the advanced entries
    const kernel = compile(model) as unknown as KConfigLike & { pipeline_select: { pipeline: string }[] }
    const legacy = { pipeline: 'group-lan', matcher_operator: 'and', matchers: [{ type: 'listener_label', value: 'lan' }] }
    kernel.pipeline_select.splice(kernel.pipeline_select.findIndex((s) => s.pipeline !== 'domain_mapping'), 0, legacy)
    const legacyModel = { ...model, ruleGroups: model.ruleGroups.map((g) => ({ ...g, listener: g.id === 'lan' ? ' lan ' : '' })) }
    const back = readConfig(JSON.parse(JSON.stringify({ ...kernel, panel: { v: PANEL_FORMAT, hash: panelHash(kernel), model: legacyModel } })) as Record<string, unknown>)
    expect(back.source).toBe('panel')
    expect(back.model.ruleGroups.some((g) => 'listener' in g)).toBe(false)
    expect(back.model.entries).toEqual([legacy, ...model.entries])
    // 键的先后不算，入口的顺序和内容一样 / Key order aside, the entries are the same and in the same order
    const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)])) : v)
    expect(sorted(compile(back.model).pipeline_select)).toEqual(sorted(kernel.pipeline_select))
  })

  it('panel 格式版本不认识时也按内核部分重新导入 / an unknown panel format version is re-imported from the kernel part too', () => {
    const cfg = exportConfig(sampleModel()) as Record<string, unknown> & { panel: { v: number } }
    cfg.panel.v = PANEL_FORMAT + 1
    expect(readConfig(cfg).source).toBe('imported')
  })

  it('没有 panel 键的旧配置直接导入 / an older config without panel imports directly', () => {
    const back = readConfig(LEGACY_TEMPLATES as Record<string, unknown>)
    expect(back.source).toBe('imported')
    expect(back.report?.stats).toMatchObject({ raw: 0, mappings: 2 })
    // 再写出去就带上 panel，读第二遍就不再导入 / Written out it carries panel, and a second read no longer imports
    expect(readConfig(JSON.parse(JSON.stringify(exportConfig(back.model))) as Record<string, unknown>).source).toBe('panel')
  })

  it('演示模式的配置导进来没有高级规则，写出去再读是同一份 / the demo config imports with no advanced rules and reads back as written', async () => {
    const doc = await mockRequest<ConfigDocument>('/api/v1/config')
    const back = readConfig(doc.content as Record<string, unknown>)
    expect(back.source).toBe('imported')
    expect(back.report?.stats.raw).toBe(0)
    expect(back.model.groups.length).toBeGreaterThan(0)
    const again = readConfig(JSON.parse(JSON.stringify(exportConfig(back.model))) as Record<string, unknown>)
    expect(again.source).toBe('panel')
    expect(again.model).toEqual(back.model)
  })
})
