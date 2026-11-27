import { describe, expect, it } from 'vitest'
import { BLOCKLIST_PIPELINE, TAG_BLOCK, TAG_BLOCK_IMPORTANT } from './blocklist'
import { exportConfig, readConfig } from './document'
import { importKernel } from './importer'
import { blocklistGroups, blocklistKey, compile, emptyBlocklists, type BlockDevice, type Model, type Subscription } from './model'
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

  it('同一个链接当白名单和当拦截列表合出的文件不同；拦截列表的照旧只写链接 / one link as an allowlist and as a blocklist builds different files; a blocklist still reads as the bare link', () => {
    const list = (url: string, enabled: boolean, allow = false): Subscription => ({ id: url.length, name: url, url, enabled, ...(allow ? { allow: true as const } : {}) })
    const [a, b] = ['https://a.example/list.txt', 'https://b.example/allow.txt']
    expect(blocklistKey({ subscriptions: [list(a, true)] })).toBe(a)
    expect(blocklistKey({ subscriptions: [list(a, true, true)] })).not.toBe(blocklistKey({ subscriptions: [list(a, true)] }))
    expect(blocklistKey({ subscriptions: [list(a, true), list(b, true, true)] })).toBe(blocklistKey({ subscriptions: [list(b, true, true), list(a, true)] }))
    expect(blocklistKey({ subscriptions: [list(a, true), list(b, false, true)] })).toBe(a)
  })
})

// 不拦截的设备：withLists 里两个列表都开着，设备只跳过 AdGuard DNS filter（分组 g1，模拟数据里有 skipped.example）；lists.example 不分组
// Devices left unblocked: both lists in withLists switched on, the device skipping AdGuard DNS filter only (group g1, holding skipped.example in the
// simulated data); lists.example is not grouped
const ADGUARD = 'https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt'
function withDevice(device: Partial<BlockDevice> = {}): Model {
  const model = withLists()
  model.blocklists.subscriptions.forEach((s) => { s.enabled = true })
  model.blocklists.devices = [{ id: 960, name: '老人的手机', ips: ['192.168.1.30'], macs: ['aa:bb:cc:dd:ee:ff'], skip: [ADGUARD], ...device }]
  model.blocklists.builtFor = blocklistKey(model.blocklists)
  return model
}

describe('不拦截的设备 / devices left unblocked', () => {
  it('跳过同一组列表的设备分在一组，没人跳过的不分组 / devices skipping the same lists share a group; lists nobody skips have none', () => {
    const list = (id: number, url: string): Subscription => ({ id, name: url, url, enabled: true })
    const device = (id: number, skip: string[]): BlockDevice => ({ id, name: `d${id}`, ips: [`10.0.0.${id}`], macs: [], skip })
    const [a, b, c] = ['https://a.example/x.txt', 'https://b.example/x.txt', 'https://c.example/x.txt']
    const subscriptions = [list(1, a), list(2, b), list(3, c), { ...list(4, 'https://d.example/allow.txt'), allow: true as const }]
    const groups = blocklistGroups({ subscriptions, devices: [device(7, [a, b]), device(8, [a, b]), device(9, [b])] })
    expect(Object.fromEntries(groups)).toEqual({ [a]: 'g1', [b]: 'g2', [c]: '' })
    // 认不出来的设备（没有 IP 也没有 MAC）不算 / A device that cannot be told (no IP, no MAC) does not count
    expect(blocklistGroups({ subscriptions, devices: [{ ...device(7, [a]), ips: [] }] }).get(a)).toBe('')
    expect(blocklistKey({ subscriptions, devices: [device(7, [a])] })).toContain(`${a}\tg1`)
    expect(blocklistKey({ subscriptions })).toBe(blocklistKey({ subscriptions, devices: [] }))
  })

  it('设备按 IP 或 MAC 跳过它勾的列表，别的列表和自己写的规则照常拦 / a device known by IP or MAC skips the lists it ticks; other lists and own rules still block', () => {
    const cfg = compile(withDevice()) as KConfigLike
    const blocked = (domain: string, client: string, mac?: string) => simulate(cfg, { domain, client, qtype: 'A', ...(mac ? { mac } : {}) }, checkResponder).steps.some((s) => s.pipeline === BLOCKLIST_PIPELINE)
    expect(blocked('skipped.example', '192.168.1.20'), 'other devices still blocked').toBe(true)
    expect(blocked('skipped.example', '192.168.1.30'), 'by IP').toBe(false)
    expect(blocked('skipped.example', '192.168.1.99', 'AA-BB-CC-DD-EE-FF'), 'by MAC, whatever its IP').toBe(false)
    expect(blocked('skipped.example', '192.168.1.99', '11:22:33:44:55:66')).toBe(true)
    expect(blocked('ads.example.net', '192.168.1.30'), 'a list it does not skip').toBe(true)
    expect(blocked('nas-ads.lan', '192.168.1.30'), 'own rules hold for every device').toBe(true)
    expect(blocked('shared.example', '192.168.1.20'), 'own allows still beat the grouped lists').toBe(false)
  })

  it('分组的入口跟在后面，减掉设备的 IP 和 MAC / grouped entries follow, taking off the device\'s IPs and MACs', () => {
    const cfg = compile(withDevice()) as KConfigLike
    const blocking = (cfg.pipeline_select ?? []).filter((e) => e.pipeline === BLOCKLIST_PIPELINE)
    expect(blocking.map((e) => String((e.matchers ?? [])[0]?.value ?? (e.matchers ?? [])[0]?.type))).toEqual([
      'ok.ads.example.net', TAG_BLOCK_IMPORTANT, TAG_BLOCK, `${TAG_BLOCK_IMPORTANT}-g1`, `${TAG_BLOCK}-g1`,
    ])
    expect(blocking.at(-1)!.matchers).toContainEqual({ type: 'client_ip', cidr: '192.168.1.30/32', operator: 'and_not' })
    expect(blocking.at(-1)!.matchers).toContainEqual({ type: 'client_mac', mac: 'aa:bb:cc:dd:ee:ff', operator: 'and_not' })
    // 没有设备时和以前一模一样 / Without devices it is exactly as before
    const plain = withLists()
    plain.blocklists.subscriptions.forEach((s) => { s.enabled = true })
    expect(compile({ ...plain, blocklists: { ...plain.blocklists, devices: [] } })).toEqual(compile(plain))
  })

  it('原样读回；手改过别处时设备接回来，分组对不上时认不出 / read back as written; after a hand edit elsewhere the devices come back, and mismatched groups are not recognised', () => {
    const model = withDevice()
    const back = readConfig(JSON.parse(JSON.stringify(exportConfig(model))) as Record<string, unknown>)
    expect(back.model.blocklists).toEqual(model.blocklists)
    const cfg = compile(model) as KConfigLike
    expect(importKernel(cfg, model).model.blocklists.devices).toEqual(model.blocklists.devices)
    // 上一份的设备换了 IP：入口里的排除条件对不上，拦截列表的入口原样留成高级入口 / The previous model's device changed IP: the entries' exclusions
    // disagree, so the blocklist entries stay as advanced entries
    const moved = withDevice({ ips: ['192.168.1.31'] })
    const again = importKernel(cfg, moved).model
    expect(again.blocklists.devices).toBeUndefined()
    expect(again.entries?.length).toBeGreaterThan(0)
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

  it('编号重复的订阅读进来换一个新编号 / a repeated subscription id gets a new one on read', () => {
    const model = withLists()
    model.blocklists.subscriptions = [
      { id: 900, name: 'AdGuard DNS filter', url: 'https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt', enabled: true },
      { id: 900, name: 'anti-AD', url: 'https://anti-ad.net/easylist.txt', enabled: true },
    ]
    model.blocklists.builtFor = blocklistKey(model.blocklists)
    const back = readConfig(JSON.parse(JSON.stringify(exportConfig(model))) as Record<string, unknown>).model.blocklists.subscriptions
    expect(back.map((s) => s.name)).toEqual(['AdGuard DNS filter', 'anti-AD'])
    expect(new Set(back.map((s) => s.id)).size).toBe(2)
    expect(back[0]!.id).toBe(900)
  })

  it('没记合成给谁的旧草稿，当作文件就是按现在的订阅合成的 / an older draft without builtFor is taken as built for its subscriptions', () => {
    const model = withLists()
    const cfg = JSON.parse(JSON.stringify(exportConfig(model))) as { panel: { model: { blocklists: Record<string, unknown> } } }
    delete cfg.panel.model.blocklists.builtFor
    expect(readConfig(cfg as unknown as Record<string, unknown>).model.blocklists.builtFor).toBe(blocklistKey(model.blocklists))
  })

  it('定时更新换了文件、面板外又手改过别处：重新导入，订阅和自己写的原文接回来，不留高级入口 / a scheduled update swapped the file and something else was edited by hand: re-imported, subscriptions and the own text carried over, no advanced entries', () => {
    const model = withLists()
    const cfg = JSON.parse(JSON.stringify(exportConfig(model))) as Record<string, unknown> & { settings: { geosite_data_paths: string[] }; pipeline_select: Record<string, unknown>[] }
    cfg.settings.geosite_data_paths = cfg.settings.geosite_data_paths.map((p) => (p === FILE ? NEWER : p))
    // 只换了文件时模型原样留着、不重新导入（见 reimport.test.ts）；这里另外手改一处编回来不变的（主列表入口去掉默认的 matcher_operator），走重新导入
    // With only the file swapped the model stays and nothing is re-imported (see reimport.test.ts); here a hand edit that compiles back unchanged
    // (the main entry loses its default matcher_operator) makes it re-import
    delete cfg.pipeline_select.at(-1)!.matcher_operator
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
