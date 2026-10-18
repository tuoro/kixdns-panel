import { describe, expect, it } from 'vitest'
import { BLOCKLIST_PIPELINE, TAG_BLOCK_IMPORTANT } from './blocklist'
import { exportConfig, readConfig } from './document'
import { importKernel } from './importer'
import { blocklistKey, compile, emptyBlocklists, type Model, type Subscription } from './model'
import { behaviourCheck, checkResponder, simulate, type KConfigLike } from './testing/kernel-sim'
import { sampleModel } from './testing/samples'

const FILE = `/var/lib/kixdns-panel/geo/blocklist-${'a'.repeat(64)}.json`
const NEWER = `/var/lib/kixdns-panel/geo/blocklist-${'b'.repeat(64)}.json`
const OWN = '! 自己加的\n||ok.ads.example.net^\n@@||shared.example^\nnas-ads.lan\n||x.example^$client=10.0.0.1'

function withLists(file: string | null = FILE, custom = OWN): Model {
  const model = sampleModel()
  model.blocklists = {
    subscriptions: [
      { id: 900, name: 'AdGuard DNS filter', url: 'https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt', enabled: true },
      { id: 901, name: 'lists.example', url: 'https://lists.example/hosts', enabled: false },
    ],
    file,
    custom,
    builtFor: '',
  }
  model.blocklists.builtFor = blocklistKey(model.blocklists)
  return model
}
const answer = (cfg: KConfigLike, domain: string) => simulate(cfg, { domain, client: '192.168.1.20', qtype: 'A' }, checkResponder)

describe('拦截列表写进配置 / blocklists in the config', () => {
  it('生效顺序：域名映射、自己写的放行、自己写的拦截、重要拦截、列表里的拦截减去放行 / the order: mappings, own allows, own blocks, important blocks, list blocks less allows', () => {
    const model = withLists()
    model.mappings.push({ id: 950, domain: 'tracker.example', target: '10.0.0.9', ttl: null, enabled: true })
    const cfg = compile(model) as KConfigLike
    const blocked = (domain: string) => answer(cfg, domain).steps.some((s) => s.pipeline === BLOCKLIST_PIPELINE)
    expect(blocked('ads.example.net')).toBe(true)
    expect(blocked('cdn.ads.example.net')).toBe(true)
    expect(blocked('shared.example'), 'own allow beats the lists').toBe(false)
    expect(blocked('ok.ads.example.net'), 'own block beats a list allow').toBe(true)
    expect(blocked('nas-ads.lan'), 'own exact block').toBe(true)
    expect(blocked('sub.nas-ads.lan'), 'exact means the name only').toBe(false)
    expect(blocked('force.example'), 'important beats a plain allow').toBe(true)
    expect(blocked('vip.force.example'), 'an important allow beats it').toBe(false)
    expect(blocked('x.example'), 'unused line').toBe(false)
    expect(answer(cfg, 'tracker.example').answers, 'mappings first').toEqual(['A 10.0.0.9'])
    expect(blocked('baidu.com')).toBe(false)
  })

  it('拦截时按「拦截时怎么回应」回答，文件排在 GeoSite 后面 / blocked answers follow the default block response; the file follows GeoSite', () => {
    const model = withLists()
    model.defaults.block = 'zero'
    const cfg = compile(model) as KConfigLike & { settings: Record<string, unknown> }
    expect(answer(cfg, 'ads.example.net').answers).toEqual(['A 0.0.0.0'])
    expect(cfg.settings.geosite_data_paths).toEqual(['/var/lib/kixdns-panel/geo/geosite-67b90a027f2c.dat', FILE])
    expect(cfg.pipeline_select?.map((s) => s.pipeline).slice(0, 4)).toEqual(['domain_mapping', BLOCKLIST_PIPELINE, BLOCKLIST_PIPELINE, BLOCKLIST_PIPELINE])
  })

  it('没有订阅也没有自己写的规则时什么都不写 / nothing is written without subscriptions or own rules', () => {
    const model = withLists(null, '! 只有注释')
    expect(compile(model)).toEqual(compile({ ...model, blocklists: emptyBlocklists() }))
  })

  it('合成的文件只看启用了哪些链接，不看先后 / the merged file depends on which links are on, not their order', () => {
    const list = (url: string, enabled: boolean): Subscription => ({ id: url.length, name: url, url, enabled })
    const [a, b] = ['https://a.example/list.txt', 'https://b.example/hosts']
    expect(blocklistKey({ subscriptions: [list(a, true), list(b, true)] })).toBe(blocklistKey({ subscriptions: [list(b, true), list(a, true)] }))
    expect(blocklistKey({ subscriptions: [list(a, true), list(b, false)] })).toBe(blocklistKey({ subscriptions: [list(a, true)] }))
    expect(blocklistKey({ subscriptions: [list(a, true)] })).not.toBe(blocklistKey({ subscriptions: [list(a, false)] }))
  })
})

describe('拦截列表读回来 / blocklists read back', () => {
  it('原样读回 / read back as written', () => {
    const model = withLists()
    const back = readConfig(JSON.parse(JSON.stringify(exportConfig(model))) as Record<string, unknown>)
    expect(back.source).toBe('panel')
    expect(back.model.blocklists).toEqual(model.blocklists)
  })

  it('同一个链接两种写法只留一个：第一个的位置和名字，有一个启用就启用，不用重新合成 / one link in two spellings keeps one: the first\'s place and name, enabled if either is, needing no new build', () => {
    const model = withLists()
    model.blocklists.subscriptions = [
      { id: 900, name: 'OISD big', url: 'https://big.oisd.nl/', enabled: false },
      { id: 901, name: 'lists.example', url: 'https://lists.example/hosts', enabled: false },
      { id: 902, name: 'big.oisd.nl', url: 'https://big.oisd.nl', enabled: true },
    ]
    model.blocklists.builtFor = blocklistKey(model.blocklists)
    const back = readConfig(JSON.parse(JSON.stringify(exportConfig(model))) as Record<string, unknown>).model.blocklists
    expect(back.subscriptions).toEqual([
      { id: 900, name: 'OISD big', url: 'https://big.oisd.nl', enabled: true },
      { id: 901, name: 'lists.example', url: 'https://lists.example/hosts', enabled: false },
    ])
    expect(blocklistKey(back)).toBe(back.builtFor)
  })

  it('没记合成给谁的旧草稿，当作文件就是按现在的订阅合成的 / an older draft without builtFor is taken as built for its subscriptions', () => {
    const model = withLists()
    const cfg = JSON.parse(JSON.stringify(exportConfig(model))) as { panel: { model: { blocklists: Record<string, unknown> } } }
    delete cfg.panel.model.blocklists.builtFor
    expect(readConfig(cfg as unknown as Record<string, unknown>).model.blocklists.builtFor).toBe(blocklistKey(model.blocklists))
  })

  it('定时更新换了文件：重新导入，订阅和自己写的原文接回来，不留高级入口 / a scheduled update swapped the file: re-imported, subscriptions and the own text carried over, no advanced entries', () => {
    const model = withLists()
    const cfg = JSON.parse(JSON.stringify(exportConfig(model))) as Record<string, unknown> & { settings: { geosite_data_paths: string[] } }
    cfg.settings.geosite_data_paths = cfg.settings.geosite_data_paths.map((p) => (p === FILE ? NEWER : p))
    const back = readConfig(cfg)
    expect(back.source).toBe('imported')
    expect(back.report?.stats.raw).toBe(0)
    expect(back.model.entries).toBeUndefined()
    expect(back.model.blocklists).toEqual({ ...model.blocklists, file: NEWER })
    expect(back.model.settings.geosite_data_paths).toEqual(['/var/lib/kixdns-panel/geo/geosite-67b90a027f2c.dat'])
    expect(compile(back.model)).toEqual(compile({ ...model, blocklists: { ...model.blocklists, file: NEWER } }))
  })

  it('没有上一份时按入口重写自己写的规则 / without a previous model the own rules are rewritten from the entries', () => {
    const { model, notes } = importKernel(compile(withLists()) as KConfigLike)
    expect(model.blocklists).toEqual({ subscriptions: [], file: FILE, custom: '||ok.ads.example.net^\nnas-ads.lan\n@@||shared.example^', builtFor: '' })
    expect(notes.some((n) => n.level === 'warn' && n.text.includes('拦截列表'))).toBe(true)
    expect(model.entries).toBeUndefined()
  })

  it('都关着时内核里没有痕迹，重新导入照样接回来 / all switched off leaves no trace in the kernel and still comes back on re-import', () => {
    const model = withLists(null, '')
    model.blocklists.subscriptions.forEach((s) => { s.enabled = false })
    const cfg = JSON.parse(JSON.stringify(exportConfig(model))) as Record<string, unknown> & { settings: Record<string, unknown> }
    cfg.settings.cache_capacity = 50_000
    expect(readConfig(cfg).model.blocklists).toEqual(model.blocklists)
  })

  it('手改过的入口认不出时照普通入口读，行为不变 / hand-edited entries that are not recognised read as ordinary entries, behaving the same', () => {
    const cfg = compile(withLists()) as KConfigLike
    // 去掉重要拦截那一项里「不在重要放行里」的条件 / Drop 不在重要放行里 from the important entry
    cfg.pipeline_select!.find((s) => s.matchers?.[0]?.value === TAG_BLOCK_IMPORTANT)!.matchers!.splice(1, 1)
    const { model, notes } = importKernel(cfg)
    expect(model.blocklists.file).toBeNull()
    expect(model.settings.geosite_data_paths).toContain(FILE)
    expect(behaviourCheck(cfg, compile(model) as KConfigLike).mismatches).toEqual([])
    expect(notes.some((n) => n.level === 'warn' && n.text.includes('拦截列表的入口在面板外改过'))).toBe(true)

    // 这时再订阅：新的拦截列表换个不重名的 Pipeline，存下再读回来照样认得 / Subscribing now: the new blocklists take a pipeline id nothing
    // else uses, and still read back once saved
    model.blocklists = withLists(NEWER, '').blocklists
    const again = compile(model)
    const ids = again.pipelines.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    const back = importKernel(again as KConfigLike, model).model
    expect(back.blocklists).toEqual(model.blocklists)
    expect(behaviourCheck(again as KConfigLike, compile(back) as KConfigLike).mismatches).toEqual([])
  })
})
