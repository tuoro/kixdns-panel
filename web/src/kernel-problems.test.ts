import { describe, expect, it } from 'vitest'
import { PANEL_BLOCK_HINT, dataNote, describeProblem, describeProblems, dohNote, panelBlockWords, problemsNote, refusesPanelBlock, warningsNote, watchNote, type PlaceNames } from './kernel-problems'

// 内核 config::problems 说不读的键的原话 / The kernel's config::problems words for a key it does not read
const unread = (key: string) => `${key}: the kernel does not read this key, so what it says has no effect; check its spelling and where it is written`
const setting = (key: string) => ({ bind_udp: 'UDP 监听地址' })[key] ?? key
const names: PlaceNames = {
  pipeline: (i) => ['主列表', '规则组「内网」'][i] ?? null,
  rule: (i, j) => (i === 0 && j === 2 ? '规则「广告」' : null),
  quoted: (id) => (id === 'lan' ? '规则组「内网」' : null),
}

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
})

describe('内核说的一条问题换成页面上的说法', () => {
  it('规则的路径换成规则名，后面多的一截放括号里', () => {
    expect(describeProblem('pipelines[0].rules[2].matchers[1]: domain_suffix "." matches every name', names, setting))
      .toBe('规则「广告」（matchers[1]）：domain_suffix "." matches every name')
    expect(describeProblem('pipelines[0].rules[2]: log level "WARN" is none of trace, debug', names, setting))
      .toBe('规则「广告」：log level "WARN" is none of trace, debug')
  })

  it('列表和设置换成它们的叫法，引号里的 Pipeline id 注上叫法', () => {
    expect(describeProblem('pipelines[1].ecs.prefix: the kernel does not read this key', names, setting)).toBe('规则组「内网」（ecs.prefix）：the kernel does not read this key')
    expect(describeProblem('settings.bind_udp: not an address', null, setting)).toBe('设置 UDP 监听地址：not an address')
    expect(describeProblem('pipelines[0]: jumping to "lan" comes back round', names, setting)).toBe('主列表：jumping to "lan"（规则组「内网」） comes back round')
  })

  it('认不出的整条照原样', () => {
    expect(describeProblem('pipelines[0].rules[5]: no upstream', names, setting)).toBe('pipelines[0].rules[5]: no upstream')
    expect(describeProblem('pipelines[0].rules[2]: no upstream', null, setting)).toBe('pipelines[0].rules[2]: no upstream')
    expect(describeProblem('3 pipelines are written with the id "x"', names, setting)).toBe('3 pipelines are written with the id "x"')
    expect(describeProblem(unread('panel'), names, setting)).toBe(PANEL_BLOCK_HINT)
  })

  it('几条一起说时，不认面板配置块的那条不列，由 blocked 说', () => {
    expect(describeProblems([unread('panel'), 'settings.bind_udp: bad'], null, setting)).toEqual({ blocked: true, items: ['设置 UDP 监听地址：bad'] })
    expect(describeProblems(['settings.bind_udp: bad'], null, setting)).toEqual({ blocked: false, items: ['设置 UDP 监听地址：bad'] })
  })
})

describe('启动时读的配置里要改掉的写法', () => {
  it('没有就不说', () => {
    expect(problemsNote([], names, setting)).toBeNull()
  })

  it('说有几处、下次保存前要改掉，逐条列出', () => {
    const note = problemsNote(['settings.bind_udp: bad', 'pipelines[0].rules[2]: no upstream'], names, setting)!
    expect(note.title).toBe('在用的配置有 2 处下次保存前要改掉')
    expect(note.items).toEqual(['设置 UDP 监听地址：bad', '规则「广告」：no upstream'])
    expect(note.update).toBeUndefined()
  })

  // 用户不用等到保存才知道：一启动就说要更新内核，给去更新的按钮 / Nobody has to wait for a save to find out: right from startup it says to update the kernel, with a button there
  it('不认面板配置块时先说更新内核', () => {
    const note = problemsNote([unread('panel')], names, setting)!
    expect(note).toMatchObject({ tone: 'err', title: PANEL_BLOCK_HINT, items: [], update: true })
    expect(problemsNote([unread('panel'), 'settings.bind_udp: bad'], names, setting)!.detail).toContain('另外还有 1 处下次保存前要改掉')
  })
})

// 内核报来的别几样状态：没有就不说；有就说是什么、要怎么办，原话逐条列着 / The kernel's other reports: nothing is said without them; with them,
// what it is and what to do, the kernel's words listed one by one
describe('内核报来的状态', () => {
  it('旧内核不报、内核说没事时都不说', () => {
    expect([warningsNote([], names, setting), watchNote(null), watchNote(undefined), dohNote(null), dataNote(undefined), dataNote([])]).toEqual([null, null, null, null, null, null])
  })

  it('提醒照样生效，不催着改，路径换成页面上的叫法', () => {
    const note = warningsNote(['pipelines[0].rules[2]: jumping to "lan" comes back round'], names, setting)!
    expect(note).toMatchObject({ tone: 'off', title: '在用的配置有\u00a01\u00a0条提醒', detail: '照样生效，但值得知道' })
    expect(note.items).toEqual(['规则「广告」：jumping to "lan"（规则组「内网」） comes back round'])
  })

  it('监视不了配置文件、DoH 没起来、Geo 数据有问题：说出后果和出路', () => {
    expect(watchNote('OS file watch limit reached.')).toMatchObject({ tone: 'warn', items: ['OS file watch limit reached.'] })
    expect(watchNote('x')!.detail).toContain('10\u00a0秒')
    expect(dohNote('settings.doh_tls_cert: cannot read')!.detail).toContain('要重启\u00a0KixDNS 才会变')
    expect(dataNote(['a', 'b'])).toMatchObject({ title: 'Geo\u00a0数据有\u00a02\u00a0个问题', items: ['a', 'b'] })
  })
})
