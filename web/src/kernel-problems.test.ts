import { describe, expect, it } from 'vitest'
import type { KernelNotice } from './api/types'
import { PANEL_BLOCK_HINT, dataNote, describeProblem, describeProblems, dohNote, noticesOf, panelBlockWords, problemsNote, refusesPanelBlock, warningsNote, watchNote, type PlaceNames } from './kernel-problems'

// 内核 config::problems 说不读的键的原话 / The kernel's config::problems words for a key it does not read
const unread = (key: string) => `${key}: the kernel does not read this key, so what it says has no effect; check its spelling and where it is written`
// 旧内核只有原话 / An old kernel gives the words alone
const old = (text: string) => ({ text })
const coded = (place: string | null, code: string, args: KernelNotice['args'] = {}, english = `${code} in English`): KernelNotice => ({ place, code, args, text: place === null ? english : `${place}: ${english}` })
const names: PlaceNames = {
  pipeline: (i) => ['主列表', '规则组「内网」'][i] ?? null,
  rule: (i, j) => (i === 0 && j === 2 ? '规则「广告」' : null),
  quoted: (id) => (id === 'lan' ? '规则组「内网」' : null),
}
const RAW = 'KixDNS\u00a0的原话：'

describe('内核不认面板的配置块', () => {
  // 按原因认：逐条的原因里有这一条，或者在连成一句的原话里（更早的内核只给这一句，面板可能还在前面加了自己的说法）
  // Told by the reason: one of the listed reasons, or inside the joined words (all an earlier kernel gives, perhaps after the panel's own lead)
  it('逐条的、连成一句的、面板带着说的都认得', () => {
    expect(refusesPanelBlock(unread('panel'))).toBe(true)
    expect(refusesPanelBlock(`${unread('pipelines[0].rules[0].matcher')}; ${unread('panel')}`)).toBe(true)
    expect(refusesPanelBlock(`KixDNS 没有接受新的 Geo 数据，仍在用之前的配置：${unread('panel')}`)).toBe(true)
  })

  // 只认顶层的 panel：别处一个叫 panel 的键拼错了，是那里的事 / Only the top-level panel: a key named panel elsewhere is that place's own mistake
  it('别处叫 panel 的键不算', () => {
    expect(refusesPanelBlock(unread('pipelines[0].panel'))).toBe(false)
    expect(refusesPanelBlock(unread('settings.panel'))).toBe(false)
    expect(refusesPanelBlock('panel: something else')).toBe(false)
  })

  it('说成更新内核的那一句，别的照原样', () => {
    expect(panelBlockWords(`KixDNS 没有接受这份配置：${unread('panel')}`)).toBe(PANEL_BLOCK_HINT)
    expect(panelBlockWords('下载失败')).toBe('下载失败')
  })

  // 带着代号时按代号认，不看英文：英文改了也认得，别处不读的键照常说 / A coded one is told by its code, never by the English: it is known even
  // with other words, and a key not read elsewhere is said as usual
  it('带着代号的按代号认，旧内核的照原话认', () => {
    expect(describeProblem(coded('panel', 'key_not_read', {}, 'reworded'), names)).toBe(PANEL_BLOCK_HINT)
    expect(describeProblem(old(unread('panel')), names)).toBe(PANEL_BLOCK_HINT)
    expect(describeProblem(coded('settings.panel', 'key_not_read'), names)).toBe('设置\u00a0panel：KixDNS 不读这个键，写了也不起作用：看看是不是拼错了，或者写错了地方')
    expect(describeProblems([coded('pipelines[0].panel', 'key_not_read')], names).blocked).toBe(false)
  })
})

describe('内核说的一条换成页面上的说法', () => {
  it('带着代号的按代号说成中文，位置换成规则名、列表名、设置名，后面多的一截放括号里', () => {
    const every = coded('pipelines[0].rules[2].matchers[1]', 'matches_every_name', { matcher: 'domain_suffix', value: '.' })
    expect(describeProblem(every, names)).toBe('规则「广告」（matchers[1]）：「域名属于」写的是「.」，对每个域名都成立')
    expect(describeProblem(coded('pipelines[1]', 'pipeline_id_repeated', { times: 2, id: 'lan' }), names)).toBe('规则组「内网」：2 个列表都叫「lan」：只有第一个起作用，其余的规则从不执行；在 JSON 里改掉重名的再保存')
    expect(describeProblem(coded('settings.cache_capacity', 'cache_capacity_zero'), null)).toBe('设置\u00a0缓存容量：填大于 0 的整数：0 让缓存一条回答也存不下')
  })

  it('引号里的 Pipeline id 换成叫法；Geo 数据的话没有位置', () => {
    expect(describeProblem(coded('pipelines[0]', 'jump_cycle', { target: 'lan', back_to: 'main' }), names)).toMatch(/^主列表：转到规则组「内网」以后会绕回「main」：/)
    expect(describeProblem(coded(null, 'data_file_missing', { file: 'geosite', path: '/geo.dat' }), null)).toBe('GeoSite 文件 /geo.dat 不存在')
  })

  it('叫不出的位置照写路径，后面照样说中文', () => {
    expect(describeProblem(coded('pipeline_select[0]', 'select_pipeline_missing', { pipeline: 'gone' }), names)).toBe('pipeline_select[0]：要进的组「gone」不存在')
    expect(describeProblem(coded('pipelines[0].rules[5]', 'no_upstream'), names)).toBe('pipelines[0].rules[5]：一个上游地址都没写，问它的请求都会失败；至少填一个地址')
    expect(describeProblem(coded('pipelines[0].rules[2]', 'no_upstream'), null)).toMatch(/^pipelines\[0\]\.rules\[2\]：一个上游地址/)
  })

  // 旧内核没有代号、或者代号认不出：照原话说，标明是原话；开头的路径认得出时照样换成叫法 / An old kernel without codes, or a code not known:
  // the words are said, marked as such; the opening path is still named when known
  it('旧内核、认不出的代号照原话说，标明是原话', () => {
    expect(describeProblem(old('pipelines[0].rules[2].matchers[1]: domain_suffix "." matches every name'), names))
      .toBe(`规则「广告」（matchers[1]），${RAW}domain_suffix "." matches every name`)
    expect(describeProblem(coded('pipelines[0].rules[2]', 'a_future_code', {}, 'something new'), names)).toBe(`规则「广告」，${RAW}something new`)
    expect(describeProblem(coded('pipelines[0].rules[2]', 'cache_capacity_large', { value: 'many' }, 'many is very large'), names)).toBe(`规则「广告」，${RAW}many is very large`)
    expect(describeProblem(old('settings.bind_udp: not an address'), null)).toBe(`设置\u00a0UDP 监听地址，${RAW}not an address`)
    expect(describeProblem(old('pipelines[0]: jumping to "lan" comes back round'), names)).toBe(`主列表，${RAW}jumping to "lan"（规则组「内网」） comes back round`)
  })

  it('旧内核的路径认不出时整条照原话', () => {
    expect(describeProblem(old('pipelines[0].rules[5]: no upstream'), names)).toBe(`${RAW}pipelines[0].rules[5]: no upstream`)
    expect(describeProblem(old('pipelines[0].rules[2]: no upstream'), null)).toBe(`${RAW}pipelines[0].rules[2]: no upstream`)
    expect(describeProblem(old('3 pipelines are written with the id "x"'), names)).toBe(`${RAW}3 pipelines are written with the id "x"`)
    expect(describeProblem(old('GeoSite data file /geo.dat does not exist'), null)).toBe(`${RAW}GeoSite data file /geo.dat does not exist`)
  })

  it('几条一起说时，不认面板配置块的那条不列，由 blocked 说', () => {
    expect(describeProblems([old(unread('panel')), old('settings.bind_udp: bad')], null)).toEqual({ blocked: true, items: [`设置\u00a0UDP 监听地址，${RAW}bad`] })
    expect(describeProblems([coded('panel', 'key_not_read'), coded('settings.cache_capacity', 'cache_capacity_zero')], null)).toEqual({ blocked: true, items: ['设置\u00a0缓存容量：填大于 0 的整数：0 让缓存一条回答也存不下'] })
    expect(describeProblems([old('settings.bind_udp: bad')], null)).toEqual({ blocked: false, items: [`设置\u00a0UDP 监听地址，${RAW}bad`] })
  })

  // 有带着代号的那一份就用它，旧内核用原话 / The coded copy when there is one, the words from an old kernel
  it('一串话：带着代号的优先，旧内核照原话，都没有时为空', () => {
    const notice = coded(null, 'port_zero')
    expect(noticesOf(['port 0'], [notice])).toEqual([notice])
    expect(noticesOf(['port 0'], undefined)).toEqual([{ text: 'port 0' }])
    expect(noticesOf(undefined, undefined)).toEqual([])
  })
})

describe('启动时读的配置里要改掉的写法', () => {
  it('没有就不说', () => {
    expect(problemsNote([], names)).toBeNull()
  })

  it('说有几处、下次保存前要改掉，逐条列出', () => {
    const note = problemsNote([coded('settings.cache_capacity', 'cache_capacity_zero'), coded('pipelines[0].rules[2]', 'no_upstream')], names)!
    expect(note.title).toBe('在用的配置有\u00a02\u00a0处下次保存前要改掉')
    expect(note.items).toEqual(['设置\u00a0缓存容量：填大于 0 的整数：0 让缓存一条回答也存不下', '规则「广告」：一个上游地址都没写，问它的请求都会失败；至少填一个地址'])
    expect(note.update).toBeUndefined()
  })

  // 用户不用等到保存才知道：一启动就说要更新内核，给去更新的按钮 / Nobody has to wait for a save to find out: right from startup it says to update the kernel, with a button there
  it('不认面板配置块时先说更新内核', () => {
    const note = problemsNote([old(unread('panel'))], names)!
    expect(note).toMatchObject({ tone: 'err', title: PANEL_BLOCK_HINT, items: [], update: true })
    expect(problemsNote([coded('panel', 'key_not_read'), old('settings.bind_udp: bad')], names)!.detail).toContain('另外还有\u00a01\u00a0处下次保存前要改掉')
  })
})

// 内核报来的别几样状态：没有就不说；有就说是什么、要怎么办，逐条列着 / The kernel's other reports: nothing is said without them; with them, what it
// is and what to do, listed one by one
describe('内核报来的状态', () => {
  it('旧内核不报、内核说没事时都不说', () => {
    expect([warningsNote([], names), watchNote(null), watchNote(undefined), dohNote(null), dataNote([])]).toEqual([null, null, null, null, null])
  })

  it('提醒照样生效，不催着改，按代号说成中文', () => {
    const note = warningsNote([coded('settings.cache_capacity', 'cache_capacity_large', { value: 2_000_000 })], names)!
    expect(note).toMatchObject({ tone: 'off', title: '在用的配置有\u00a01\u00a0条提醒', detail: '照样生效，但值得知道' })
    expect(note.items).toEqual(['设置\u00a0缓存容量：2000000 条很大，可能占掉很多内存'])
  })

  it('监视不了配置文件、DoH 没起来、Geo 数据有问题：说出后果和出路', () => {
    expect(watchNote('OS file watch limit reached.')).toMatchObject({ tone: 'warn', items: ['OS file watch limit reached.'] })
    expect(watchNote('x')!.detail).toContain('10\u00a0秒')
    expect(dohNote('settings.doh_tls_cert: cannot read')!.detail).toContain('要重启\u00a0KixDNS 才会变')
    const data = dataNote([coded(null, 'geosite_tags_unprovided', { tags: ['netflix'] }), old('a')])!
    expect(data).toMatchObject({ title: 'Geo\u00a0数据有\u00a02\u00a0个问题', items: ['GeoSite 分类 netflix 哪个文件里都没有：「属于 GeoSite」永远不命中，「不属于 GeoSite」总是命中', `${RAW}a`] })
  })
})
