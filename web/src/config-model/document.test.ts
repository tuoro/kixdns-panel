import { describe, expect, it } from 'vitest'
import { exportConfig, kernelPart, PANEL_FORMAT, readConfig } from './document'
import { compile } from './model'
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
