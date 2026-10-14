import { beforeEach, describe, expect, it } from 'vitest'
import { diffModels } from '../config-model/diff'
import { ruleTitle, type Model } from '../config-model/model'
import { exportConfig, readConfig } from '../config-model/document'
import { LEGACY_MESSY, LEGACY_TEMPLATES, demoModel, sampleModel } from '../config-model/testing/samples'
import { appliedModel, changeCount, copyReplaceBlocker, groupUsers, model, oldPanelCopies, rebaseApplied, replaceWithCopy, resetTo } from './store'

// 保存条数出来的每一处修改，「改了哪些」里都要看得到：以前改监听标签时保存条说改了 1 处，对比却说「一样」
// Every change the save bar counts must show in the review: setting a listener tag once read 「已修改 1 处」 while the review said nothing changed
const mutations: [string, (m: Model) => void][] = [
  ['规则名称', (m) => { m.rules[1]!.name = '改过的名字' }],
  ['规则顺序', (m) => { m.rules.push(m.rules.shift()!) }],
  ['删除一条规则', (m) => { m.rules.pop() }],
  ['其余请求', (m) => { m.rest = { type: 'block', response: 'default' } }],
  ['上游组地址', (m) => { m.groups[0]!.addresses.push({ address: '9.9.9.9', protocol: 'auto' }) }],
  ['规则组监听标签', (m) => { m.ruleGroups[0]!.listener = 'lan' }],
  ['规则组说明', (m) => { m.ruleGroups[0]!.note = '新的说明' }],
  ['映射顺序', (m) => { m.mappings.push(m.mappings.shift()!) }],
  ['映射目标', (m) => { m.mappings[0]!.target = '192.168.1.99' }],
  ['设置', (m) => { m.settings.cache_capacity = 30000 }],
  ['Geo 文件路径', (m) => { m.settings.geoip_db_path = '/tmp/other.mmdb' }],
  ['拦截时怎么回应', (m) => { m.defaults.block = m.defaults.block === 'NXDOMAIN' ? 'REFUSED' : 'NXDOMAIN' }],
  ['高级入口', (m) => { m.entries = [{ pipeline: 'main', matcher_operator: 'and', matchers: [{ type: 'any' }] }] as Model['entries'] }],
  ['JSON 视图里加的顶层键', (m) => { m.extra = { note_from_json: 1 } }],
]

describe('保存条的计数和「改了哪些」说的是同一件事', () => {
  beforeEach(() => resetTo(demoModel()))

  it.each(mutations)('%s', (_, mutate) => {
    mutate(model)
    expect(changeCount.value).toBeGreaterThan(0)
    expect(diffModels(appliedModel.value, model).length).toBeGreaterThan(0)
  })

  it('没改就两边都是 0', () => {
    expect(changeCount.value).toBe(0)
    expect(diffModels(appliedModel.value, model)).toEqual([])
  })
})

// 看不见、也不写进配置的字段变了不算修改：关着的日志的级别、没打开的回答后检查、条件的内部编号、改动时间
// Fields that are neither shown nor written do not count: the level of a log that is off, an unused response check, condition ids, the edit time
const invisible: [string, (m: Model) => void][] = [
  ['关着的日志换了级别', (m) => { const r = m.rules[1]!; r.log = { enabled: false, level: r.log.level === 'debug' ? 'warn' : 'debug' } }],
  ['没打开的回答后检查里留着条件', (m) => { const r = m.rules[1]!; r.response = { ...r.response, mode: r.response.mode === 'custom' ? 'inherit' : r.response.mode, conditions: [{ id: 999, field: 'rcode', negate: false, values: ['SERVFAIL'] }] } }],
  ['条件重新编号', (m) => { m.rules.forEach((r) => r.conditions.forEach((g) => g.forEach((c) => { c.id += 1000 }))) }],
  ['改动时间', (m) => { m.rules[1]!.edited = '2030-01-01T00:00:00Z' }],
]

describe('看不见的字段不算修改', () => {
  beforeEach(() => {
    const start = demoModel()
    // 让第二条规则的日志和回答后检查都是关着的 / Make sure the second rule's log and response check are off
    start.rules[1]!.log = { enabled: false, level: 'info' }
    start.rules[1]!.response = { ...start.rules[1]!.response, mode: 'inherit' }
    resetTo(start)
  })

  it.each(invisible)('%s', (_, mutate) => {
    mutate(model)
    expect(changeCount.value).toBe(0)
    expect(diffModels(appliedModel.value, model)).toEqual([])
  })
})

describe('「改了哪些」写页面上的叫法', () => {
  beforeEach(() => resetTo(demoModel()))

  it('拦截回应和日志级别不写内核取值', () => {
    model.defaults.block = 'zero'
    model.rules[1]!.log = { enabled: true, level: 'debug' }
    const text = diffModels(appliedModel.value, model).flatMap((block) => block.lines.map((line) => line.text)).join('\n')
    expect(text).toContain('空地址')
    expect(text).toContain('记录（调试）')
    expect(text).not.toMatch(/\bzero\b|\bdebug\b/)
  })
})

// 保存以后把读回来的文件当作对照、草稿留着：写进文件再读回来不能多出「修改」，否则保存成功后还挂着「已修改 N 处」
// After a save the file read back becomes the baseline while the draft stays: writing and reading back must not invent changes, or a successful save would still show 已修改 N 处
describe('保存后读回来的文件当作对照', () => {
  it.each([
    ['演示配置', () => demoModel()],
    ['完整样例', () => sampleModel()],
    ['导入的乱配置（有高级规则）', () => readConfig(LEGACY_MESSY as unknown as Record<string, unknown>).model],
    ['导入的旧模板', () => readConfig(LEGACY_TEMPLATES as unknown as Record<string, unknown>).model],
  ])('%s', (_, make) => {
    resetTo(make())
    model.rules.push({ ...model.rules[0]!, id: 9999, name: '保存时加的' })
    rebaseApplied(readConfig(exportConfig(model), model).model)
    expect(changeCount.value).toBe(0)
  })
})

describe('拦截规则上留着的客户端子网和回答后检查不算修改', () => {
  beforeEach(() => {
    const start = demoModel()
    start.rules[1]!.outcome = { type: 'block', response: 'default' }
    start.rules[1]!.ecs = 'inherit'
    start.rules[1]!.response = { ...start.rules[1]!.response, mode: 'inherit' }
    resetTo(start)
  })

  it('改成上游、设了子网又改回拦截', () => {
    model.rules[1]!.ecs = { mode: 'clear' }
    model.rules[1]!.response = { ...model.rules[1]!.response, mode: 'off' }
    expect(changeCount.value).toBe(0)
    expect(diffModels(appliedModel.value, model)).toEqual([])
  })
})

describe('「改了哪些」只报真正挪过的规则', () => {
  beforeEach(() => resetTo(demoModel()))

  it('把第一条移到最后：只有这一条是「移动」', () => {
    expect(model.rules.length).toBeGreaterThan(2)
    const first = model.rules[0]!
    model.rules.push(model.rules.shift()!)
    const moves = diffModels(appliedModel.value, model).filter((block) => block.kind === '移动')
    expect(moves).toHaveLength(1)
    expect(moves[0]!.title).toContain(ruleTitle(first))
  })
})

// 只由 a–f 组成的域名（cafe.de）也是域名：写出来是 CNAME，内核不支持 CNAME 时要挡住，和写出的配置一致
// A domain made only of a–f letters (cafe.de) is still a domain: it is written as CNAME, so a kernel without CNAME support must block it, matching the export
describe('写成域名的回答', () => {
  beforeEach(() => resetTo(demoModel()))

  // 按写出的配置数：停用的规则不写出，不算；回答后检查里的 CNAME 写出了，算 / Counted on the export: a disabled rule is not written and does not count; a CNAME in a post-reply check is written and counts
  it('停用的 CNAME 规则不算，回答后检查里的 CNAME 算', async () => {
    const { cnameAnswers, cnameInUse } = await import('./useConfigDocument')
    model.mappings = []
    const plain = model.rules.filter((r) => !(r.outcome.type === 'answer' && r.outcome.kind === 'cname'))
    model.ruleGroups = model.ruleGroups.map((g) => ({ ...g, rules: g.rules.filter((r) => !(r.outcome.type === 'answer' && r.outcome.kind === 'cname')) }))
    model.rules = plain
    expect(cnameInUse.value).toBe(false)
    const rule = model.rules[0]!
    rule.outcome = { type: 'answer', kind: 'cname', value: 'target.example.net', ttl: null } as typeof rule.outcome
    rule.enabled = false
    expect(cnameInUse.value).toBe(false)
    rule.enabled = true
    expect(cnameAnswers.value).toBe(1)
    // 回答后检查只跟在转发的规则后面 / Post-reply checks follow forwarding rules only
    rule.outcome = { type: 'upstream', group: model.groups[0]!.id }
    expect(cnameInUse.value).toBe(false)
    rule.response = { mode: 'custom', match: 'any', conditions: [{ id: 9101, field: 'rcode', values: ['SERVFAIL'], negate: false }], then: { type: 'answer', kind: 'cname', value: 'fallback.example.net', ttl: null } as typeof rule.response.then, otherwise: { type: 'none' } }
    expect(cnameInUse.value).toBe(true)
    expect(cnameAnswers.value).toBe(1)
  })

  it('cafe.de 这种域名算 CNAME，不当成 IP', async () => {
    const { cnameInUse } = await import('./useConfigDocument')
    model.mappings = [{ id: 9001, domain: 'nas.home', target: 'cafe.de', ttl: null, enabled: true }]
    model.rules = model.rules.filter((r) => !(r.outcome.type === 'answer' && r.outcome.kind === 'cname'))
    model.ruleGroups = model.ruleGroups.map((g) => ({ ...g, rules: g.rules.filter((r) => !(r.outcome.type === 'answer' && r.outcome.kind === 'cname')) }))
    expect(JSON.stringify(exportConfig(model))).toContain('cafe.de')
    expect(cnameInUse.value).toBe(true)
    model.mappings = [{ id: 9001, domain: 'nas.home', target: '192.168.1.2, fd00::2', ttl: null, enabled: true }]
    expect(cnameInUse.value).toBe(false)
  })
})

describe('内核给的英文原因', () => {
  beforeEach(() => resetTo(demoModel()))

  it('标明是 KixDNS 的原话，内核 id 后面注上页面上的叫法', async () => {
    const { kernelWords } = await import('./useConfigDocument')
    const said = kernelWords('pipeline "main" references unknown upstream group "fast"')
    expect(said.startsWith('KixDNS 的原话：')).toBe(true)
    expect(said).toContain('"main"（主列表）')
    expect(said).toContain('"fast"')
    expect(kernelWords('KixDNS 已停止')).toBe('KixDNS 已停止')
  })

  // 按能力开的开关关掉：「改了哪些」读作「开 → 关」，不读作「去掉」；只算一处 / A capability-gated switch turned off reads as 开 → 关 in the review, not as removed, and counts once
  it('按能力开的开关关掉读作「开 → 关」', () => {
    const base = sampleModel()
    base.settings = { ...base.settings, statistics_enabled: true }
    resetTo(base)
    model.settings = { ...model.settings, statistics_enabled: false }
    expect(changeCount.value).toBe(1)
    const blocks = diffModels(appliedModel.value, model)
    const block = blocks.find((b) => b.title.includes('启用查询排行'))!
    expect(block.kind).toBe('改了')
    expect(block.lines.map((line) => line.sign)).toEqual(['-', '+'])
  })
})

// 旧版面板编辑被两处共用的组时复制出「原名-copy」，只改了其余请求；回答后检查还指着原来的组
// The old panel copied a group used in two places to 「name-copy」 for the catch-all only; the answer check still points at the original
describe('旧版面板留下的副本', () => {
  const forward = (id: string, upstream: string, extra: Record<string, unknown> = {}) => ({ id, rules: [{ name: `${id}_parallel`, matchers: [{ type: 'any' }], actions: [{ type: 'forward', upstream }], ...extra }] })
  // withOriginal 为 false 时没有原来的组，也没有指向它的回答后检查 / Without withOriginal there is no original group and no answer check pointing at it
  const kernel = (copyId: string, withOriginal = true) => ({
    version: '1.0',
    settings: {},
    pipeline_select: [
      { pipeline: 'cn', matchers: [{ type: 'geo_site', value: 'cn' }] },
      { pipeline: copyId, matchers: [{ type: 'any' }] },
    ],
    pipelines: [
      forward('cn', 'https://doh.pub/dns-query', withOriginal ? {
        response_matchers: [{ type: 'response_answer_ip', cidr: '0.0.0.0/32' }],
        response_actions_on_match: [{ type: 'jump_to_pipeline', pipeline: 'global' }],
        response_actions_on_miss: [],
      } : {}),
      ...(withOriginal ? [forward('global', 'https://dns.quad9.net/dns-query')] : []),
      forward(copyId, 'https://dns.google/dns-query'),
    ],
  })

  it('认出原组和副本，原来那组写明只在回答后检查里用到', () => {
    resetTo(readConfig(kernel('global-copy')).model)
    const pairs = oldPanelCopies()
    expect(pairs.map((p) => [p.copy.name, p.original.name])).toEqual([['global-copy', 'global']])
    expect(groupUsers(pairs[0]!.original.id)).toEqual(['规则「cn_parallel」的回答后检查'])
    expect(groupUsers(pairs[0]!.copy.id)).toEqual(['其余请求'])
  })

  it('重名时旧面板加的编号也认', () => {
    resetTo(readConfig(kernel('global-copy-2')).model)
    expect(oldPanelCopies().map((p) => [p.copy.name, p.original.name])).toEqual([['global-copy-2', 'global']])
  })

  it('名字碰巧带 -copy、原来的组并不存在时不算', () => {
    resetTo(readConfig(kernel('global-copy', false)).model)
    expect(oldPanelCopies()).toEqual([])
  })

  // 写出来的内核配置里所有跳转目标 / Every jump target in the kernel config written out
  const jumps = (x: unknown): string[] => {
    if (Array.isArray(x)) return x.flatMap(jumps)
    if (!x || typeof x !== 'object') return []
    const o = x as Record<string, unknown>
    return [...(o.type === 'jump_to_pipeline' && typeof o.pipeline === 'string' ? [o.pipeline] : []), ...Object.values(o).flatMap(jumps)]
  }

  it('用副本替换原来那组：原来那组换成副本的上游，回答后检查和其余请求都走它，副本删掉', () => {
    resetTo(readConfig(kernel('global-copy')).model)
    const { copy, original } = oldPanelCopies()[0]!
    expect(copyReplaceBlocker(copy, original)).toBeNull()
    const before = JSON.stringify(model)
    const undo = replaceWithCopy(copy, original)

    expect(model.groups.map((g) => g.name)).not.toContain('global-copy')
    expect(original.addresses.map((a) => a.address)).toEqual(['https://dns.google/dns-query'])
    expect(groupUsers(original.id)).toEqual(['规则「cn_parallel」的回答后检查', '其余请求'])
    expect(oldPanelCopies()).toEqual([])
    // 写出来的配置：没有副本、没有旧上游，Pipeline ID 照旧是 global，每个跳转都落在存在的 Pipeline 上
    // Written out: no copy, no old upstream, the pipeline ID is still global, and every jump lands on a pipeline that exists
    const out = exportConfig(model)
    const kernelText = JSON.stringify({ ...out, panel: undefined })
    expect(kernelText).not.toContain('global-copy')
    expect(kernelText).not.toContain('quad9')
    const ids = (out.pipelines as { id: string }[]).map((p) => p.id)
    expect(ids).toContain('global')
    expect(jumps(out).every((id) => ids.includes(id))).toBe(true)
    expect(jumps(out)).toContain('global')

    undo()
    expect(JSON.stringify(model)).toBe(before)
  })

  it('原来那组已经没人用时照样能替换，结果只剩一组', () => {
    const k = kernel('global-copy')
    k.pipelines[0] = forward('cn', 'https://doh.pub/dns-query')
    resetTo(readConfig(k).model)
    const { copy, original } = oldPanelCopies()[0]!
    expect(groupUsers(original.id)).toEqual([])
    replaceWithCopy(copy, original)
    expect(model.groups.filter((g) => g.addresses.some((a) => a.address.includes('dns.google')))).toEqual([original])
    expect(groupUsers(original.id)).toEqual(['其余请求'])
  })

  it('副本的备用就是原来那组、或者高级入口写着副本时不能一键替换', () => {
    resetTo(readConfig(kernel('global-copy')).model)
    const { copy, original } = oldPanelCopies()[0]!
    copy.fallback = { group: original.id, onError: true, onPolluted: false }
    expect(copyReplaceBlocker(copy, original)).toBe('它的备用组就是「global」')
    // 备用那一格关着、只是留着 ID：可以替换，替换后不会自己备用自己 / The fallback slot is off and merely keeps the ID: replaceable, and the result never falls back to itself
    copy.fallback = { group: original.id, onError: false, onPolluted: false }
    expect(copyReplaceBlocker(copy, original)).toBeNull()
    replaceWithCopy(copy, original)
    expect(original.fallback.group).toBe('')

    resetTo(readConfig(kernel('global-copy')).model)
    const pair = oldPanelCopies()[0]!
    model.entries = [{ pipeline: 'global-copy', matchers: [{ type: 'any' }] }]
    expect(copyReplaceBlocker(pair.copy, pair.original)).toBe('高级规则或高级入口里引用了它')
  })
})
