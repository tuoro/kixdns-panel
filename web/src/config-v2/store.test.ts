import { beforeEach, describe, expect, it } from 'vitest'
import { diffModels, differences } from '../config-model/diff'
import { blocklistKey, compile, ruleTitle, type Model, type Rule } from '../config-model/model'
import { exportConfig, readConfig } from '../config-model/document'
import { LEGACY_MESSY, LEGACY_TEMPLATES, demoModel, sampleModel } from '../config-model/testing/samples'
import { appliedModel, applyUpstreamStats, changeCount, groupHealth, changesBesidesFile, newId, placeBack, copyReplaceBlocker, discardOnLeave, draftGeneration, groupUsers, model, oldPanelCopies, rebaseApplied, replaceModel, replaceWithCopy, resetTo, sameDraftSince } from './store'

// 保存条数出来的每一处修改，「改了哪些」里都要看得到：以前改监听标签时保存条说改了 1 处，对比却说「一样」
// Every change the save bar counts must show in the review: setting a listener tag once read 「已修改 1 处」 while the review said nothing changed
const mutations: [string, (m: Model) => void][] = [
  ['规则名称', (m) => { m.rules[1]!.name = '改过的名字' }],
  ['规则顺序', (m) => { m.rules.push(m.rules.shift()!) }],
  ['删除一条规则', (m) => { m.rules.pop() }],
  ['其余请求', (m) => { m.rest = { type: 'block', response: 'default' } }],
  ['上游组地址', (m) => { m.groups[0]!.addresses.push({ address: '9.9.9.9', protocol: 'auto' }) }],
  ['规则组名称', (m) => { m.ruleGroups[0]!.name = '改过的组名' }],
  ['规则组说明', (m) => { m.ruleGroups[0]!.note = '新的说明' }],
  ['映射顺序', (m) => { m.mappings.push(m.mappings.shift()!) }],
  ['映射目标', (m) => { m.mappings[0]!.target = '192.168.1.99' }],
  ['设置', (m) => { m.settings.cache_capacity = 30000 }],
  ['Geo 文件路径', (m) => { m.settings.geoip_db_path = '/tmp/other.mmdb' }],
  ['拦截时怎么回应', (m) => { m.defaults.block = m.defaults.block === 'NXDOMAIN' ? 'REFUSED' : 'NXDOMAIN' }],
  ['高级入口', (m) => { m.entries = [{ pipeline: 'main', matcher_operator: 'and', matchers: [{ type: 'any' }] }] as Model['entries'] }],
  ['JSON 视图里加的顶层键', (m) => { m.extra = { note_from_json: 1 } }],
]

describe('上游组的健康按写进内核的地址对', () => {
  // 国内组的 223.5.5.5 没写端口，写进内核是 tcp+udp://223.5.5.5:53，KixDNS 也按这个报计数：组里要认得它
  // 国内's 223.5.5.5 has no port; it reaches the kernel as tcp+udp://223.5.5.5:53, and KixDNS reports counts under that: the group must know it
  it('没写端口的地址认得带 :53 的计数', () => {
    resetTo(sampleModel())
    const count = (upstream: string, transport: string) => ({ upstream, transport, attempts: 100, success: 90, errors: 10, rejected: 0, aborted: 0, throttled: 0, avg_latency_ms: 20, rcodes: [], tcp_fallbacks: 0, recent: null })
    applyUpstreamStats([count('tcp+udp://223.5.5.5:53', 'tcp_udp')])
    expect(groupHealth.value.get('cn')).toMatchObject({ success: 90, queries: 100 })
  })
})

describe('新编号不和别的 Pipeline 撞名', () => {
  // 编号定下规则自己那个转发的名字（rule-编号）：配置里原样保留的 Pipeline、读成上游组或规则组的已经叫 rule-n 时，新规则拿到 n，以后单独设子网就编出两个同名的
  // An id names the rule's own forward (rule-<id>): when a verbatim pipeline, or one read as an upstream group or rule group, is already called
  // rule-n, a new rule given n compiles to two of one name once it sets its own subnet
  it('配置里已经有 rule-n 时，新规则不拿 n', () => {
    const m = demoModel()
    const next = Math.max(...[...m.rules, ...m.ruleGroups.flatMap((g) => g.rules)].flatMap((r) => [r.id, ...r.conditions.flat().map((c) => c.id), ...r.response.conditions.map((c) => c.id)]), ...m.mappings.map((x) => x.id)) + 1
    m.rawPipelines = [{ id: `rule-${next}`, rules: [] }, { id: `rule-${next + 1}`, rules: [] }]
    m.groups = [...m.groups, { id: 'kept', pipelineId: `rule-${next + 2}`, name: '原样', addresses: [{ address: '9.9.9.9:53', protocol: 'auto' }], ecs: null, fallback: { group: '', onError: false, onPolluted: false } }]
    resetTo(m)
    const ids = [newId(), newId()]
    expect(ids.some((id) => id >= next && id <= next + 2)).toBe(false)
    // 拿到的编号单独设子网：编出来没有同名的 Pipeline / A taken id with its own subnet: nothing compiles to one name twice
    const rule = { ...model.rules.find((r) => r.outcome.type === 'upstream')!, id: ids[0]!, ecs: { mode: 'clear' } as const }
    model.rules.unshift(rule)
    expect(() => compile(model)).not.toThrow()
  })
})

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

// 一条规则改了哪里，「改了哪些」就写哪里：以前 TXT、CNAME 回答的 TTL、回答后检查的「同时记一条日志」改了，保存条说已修改 1 处，「改了哪些」
// 却说和上次保存的一样。保存条按规则数，「改了哪些」按规则写块，只改规则时两个数一样
// Whatever part of a rule changed, the review says so: the TTL of a TXT or CNAME answer and the answer check's 「同时记一条日志」 used to read
// 「已修改 1 处」 on the save bar while the review said nothing changed. The bar counts rules and the review writes a block per rule, so with
// rule edits only the two numbers agree
describe('规则改了哪里，「改了哪些」就写哪里', () => {
  beforeEach(() => {
    const start = demoModel()
    const company = start.rules.find((r) => r.name === '公司内网')!
    company.conditions[0]![0]!.values = ['a.corp', 'b.corp', 'c.corp', 'd.corp', 'e.corp']
    start.rules.push({ ...start.rules[1]!, id: 9100, name: 'CNAME 回答', outcome: { type: 'answer', kind: 'cname', value: 'nas.home.arpa', ttl: null } })
    start.rules.push({ ...start.rules[1]!, id: 9101, name: 'IP 回答', outcome: { type: 'answer', kind: 'ip', value: '192.168.1.10, fd00::10', ttl: null } })
    const rebind = start.rules.find((r) => r.name === '防 DNS 重绑定')!
    rebind.response = { ...rebind.response, then: { type: 'answer', kind: 'txt', value: 'blocked', ttl: null }, otherwise: { type: 'answer', kind: 'cname', value: 'safe.example', ttl: null } }
    start.rules.push({ ...rebind, id: 9102, name: '否则照常', response: { ...rebind.response, otherwise: { type: 'none' } } })
    resetTo(start)
  })
  const rule = (name: string) => model.rules.find((r) => r.name === name)!
  const answerOf = (o: Rule['outcome'] | Rule['response']['then']) => o as Extract<Rule['outcome'], { type: 'answer' }>
  // 第三项是「改了哪些」里看得到的那句：改的东西本身要写出来，不是只落到「写法有改动」那句兜底上
  // The third item is what the review must show: the change itself is written out, not left to the 「写法有改动」 fallback
  const edits: [string, () => void, string][] = [
    ['TXT 回答的 TTL', () => { answerOf(model.rules.find((r) => r.outcome.type === 'answer' && r.outcome.kind === 'txt')!.outcome).ttl = 60 }, '+ 结果：直接回答 TXT「kixdns」，TTL 60 秒'],
    ['CNAME 回答的 TTL', () => { answerOf(rule('CNAME 回答').outcome).ttl = 600 }, '+ 结果：直接回答 CNAME nas.home.arpa，TTL 600 秒'],
    ['回答后检查「然后」回答的 TTL', () => { answerOf(rule('防 DNS 重绑定').response.then).ttl = 30 }, '直接回答 TXT「blocked」，TTL 30 秒，否则'],
    ['回答后检查「否则」回答的 TTL', () => { answerOf(rule('防 DNS 重绑定').response.otherwise).ttl = 30 }, '否则直接回答 CNAME safe.example，TTL 30 秒'],
    ['回答后检查同时记一条日志', () => { rule('防 DNS 重绑定').response.thenLog = 'warn' }, '直接回答 TXT「blocked」，同时记一条警告日志，否则'],
    ['回答后检查「否则」记日志', () => { rule('防 DNS 重绑定').response.otherwiseLog = 'info' }, 'safe.example，同时记一条信息日志'],
    ['「否则」照常返回、只记日志', () => { rule('否则照常').response.otherwiseLog = 'info' }, '，否则照常返回，同时记一条信息日志'],
    ['多值条件里排在后面的值', () => { rule('公司内网').conditions[0]![0]!.values[3] = 'x.corp' }, '+ 条件：域名属于 a.corp、b.corp、c.corp、x.corp、e.corp'],
    ['回答的几个 IP 之间换了写法', () => { answerOf(rule('IP 回答').outcome).value = '192.168.1.10,fd00::10' }, '写法有改动，读出来和原来一样'],
  ]
  it.each(edits)('%s', (_, edit, shown) => {
    edit()
    expect(changeCount.value).toBe(1)
    const blocks = diffModels(appliedModel.value, model)
    expect(differences(blocks)).toBe(1)
    expect([...blocks[0]!.lines.map((l) => `${l.sign} ${l.text}`), blocks[0]!.note ?? ''].join('\n')).toContain(shown)
  })
})

// 挪动规则：保存条和「改了哪些」按同一份「哪几条挪过」数（两边共有的规则里最长的一段相同顺序之外的那几条），挪过又改过的一条算一处、写成一块
// Moving rules: the save bar and the review count the same set of moved rules (those outside the longest run kept in order), and a rule both
// moved and edited is one place and one block
describe('挪动规则：保存条和「改了哪些」一样数', () => {
  beforeEach(() => resetTo(demoModel()))

  it('第一条和最后一条对调：挪了两条，两处、两块', () => {
    const first = model.rules.shift()!
    const last = model.rules.pop()!
    model.rules.unshift(last)
    model.rules.push(first)
    expect(changeCount.value).toBe(2)
    expect(differences(diffModels(appliedModel.value, model))).toBe(2)
  })

  it('挪过又改过的一条：一处、一块，块里说从第几条挪到第几条', () => {
    const moved = model.rules.shift()!
    moved.note = '挪到最后'
    model.rules.push(moved)
    expect(changeCount.value).toBe(1)
    const blocks = diffModels(appliedModel.value, model)
    expect(differences(blocks)).toBe(1)
    expect(blocks[0]!.note).toBe(`从第 1 条移到第 ${model.rules.length} 条`)
  })
})

// 订阅按规整后的链接认：另一台面板导出的配置里编号、名字、链接写法不同，不算修改；开关、增删才算，计数和「改了哪些」一致
// Subscriptions are matched by normal link: different ids, names or link spellings in a config exported by another panel are no change; on/off and
// adding or removing are, with the count and the review agreeing
describe('订阅的改动按链接认 / subscription changes go by link', () => {
  const withLists = (): Model => {
    const m = demoModel()
    m.blocklists = { ...m.blocklists, subscriptions: [
      { id: 1, name: 'OISD big', url: 'https://big.oisd.nl/', enabled: true },
      { id: 2, name: 'anti-AD', url: 'https://anti-ad.net/easylist.txt', enabled: true },
    ] }
    return m
  }
  beforeEach(() => resetTo(withLists()))

  it('编号、名字、链接写法不同不算修改', () => {
    model.blocklists.subscriptions = [
      { id: 7, name: 'anti-AD 列表', url: 'https://ANTI-AD.net/easylist.txt', enabled: true },
      { id: 8, name: 'big.oisd.nl', url: 'https://big.oisd.nl', enabled: true },
    ]
    expect(changeCount.value).toBe(0)
    expect(diffModels(appliedModel.value, model)).toEqual([])
  })

  it('「除了合成文件还改了几处」和保存条一个口径：删了又加回来、改了又改回都算没改，只换文件也不算', () => {
    const [a, b] = model.blocklists.subscriptions
    model.blocklists.subscriptions = [b!, a!]
    model.rules[0]!.edited = '2030-01-01T00:00:00Z'
    model.blocklists.file = '/var/lib/kixdns-panel/geo/blocklist-new.json'
    expect(changesBesidesFile(appliedModel.value, model)).toBe(0)
    model.blocklists.custom = '||x.example^'
    expect(changesBesidesFile(appliedModel.value, model)).toBe(1)
  })

  it('离开时放弃：草稿退回已保存的那份，在路上的下载照样认这份草稿；别的换草稿就不认', () => {
    const then = draftGeneration()
    model.blocklists.custom = '||x.example^'
    model.blocklists.file = '/var/lib/kixdns-panel/geo/blocklist-new.json'
    model.blocklists.builtFor = blocklistKey(model.blocklists)
    discardOnLeave()
    expect(JSON.stringify(model)).toBe(JSON.stringify(appliedModel.value))
    expect(sameDraftSince(then)).toBe(true)
    replaceModel({ ...appliedModel.value, blocklists: { ...appliedModel.value.blocklists, custom: '||y.example^' } })
    expect(sameDraftSince(then)).toBe(false)
  })

  it('删掉全配置里编号最大的那个再加新的：新编号不和已保存的撞，撤销时不会两个同编号', () => {
    const m = withLists()
    m.blocklists.subscriptions[1]!.id = 99999
    resetTo(m)
    const removed = model.blocklists.subscriptions.pop()!
    expect(newId()).toBeGreaterThan(removed.id)
  })

  it('放回去的订阅编号或名字被占了就换一个：不会两行同编号、同名', () => {
    const [a, b] = model.blocklists.subscriptions
    // 编号被占：换新编号 / Id taken: a fresh id
    const sameId = placeBack({ id: b!.id, name: 'AdAway', url: 'https://adaway.org/hosts.txt', enabled: true })
    expect(sameId.id).not.toBe(b!.id)
    expect(sameId.name).toBe('AdAway')
    // 带标题的名字被占：前面加主机 / A title taken: the host goes in front
    const sameTitle = placeBack({ id: 777, name: a!.name, url: 'https://mirror.example.org/oisd.txt', enabled: true })
    expect(sameTitle.name).toBe(`mirror.example.org\u00a0·\u00a0${a!.name}`)
    // 默认名被占：照起名的规矩往上带目录 / A default name taken: directories go up by the naming rule
    model.blocklists.subscriptions.push({ id: 778, name: 'hosts.txt\u00a0·\u00a0lists.example.org', url: 'https://lists.example.org/c/hosts.txt', enabled: true })
    const sameDefault = placeBack({ id: 779, name: 'hosts.txt\u00a0·\u00a0lists.example.org', url: 'https://lists.example.org/a/hosts.txt', enabled: true })
    expect(sameDefault.name).toBe('a/hosts.txt\u00a0·\u00a0lists.example.org')
    // 都没被占：原样放回 / Nothing taken: put back as it was
    const free = { id: 780, name: 'free.txt\u00a0·\u00a0lists.example.org', url: 'https://lists.example.org/free.txt', enabled: true }
    expect(placeBack(free)).toBe(free)
  })

  it('停用一个、加一个各算一处，「改了哪些」也列出来', () => {
    model.blocklists.subscriptions[1]!.enabled = false
    model.blocklists.subscriptions.push({ id: 3, name: 'AdAway', url: 'https://adaway.org/hosts.txt', enabled: true })
    expect(changeCount.value).toBe(2)
    expect(diffModels(appliedModel.value, model).map((b) => b.kind)).toEqual(['改了', '加上'])
  })

  it('恢复方向：订阅也变了、文件不同时，说明不算一处不同 / restore direction: with subscriptions changed too the note is not a difference', () => {
    const then = JSON.parse(JSON.stringify(model)) as Model
    then.blocklists.subscriptions = then.blocklists.subscriptions.slice(0, 1)
    then.blocklists.file = '/var/lib/kixdns-panel/geo/blocklist-old.json'
    model.blocklists.file = '/var/lib/kixdns-panel/geo/blocklist-new.json'
    const blocks = diffModels(model, then, 'restore')
    expect(blocks.some((b) => b.aside)).toBe(true)
    expect(differences(blocks)).toBe(1)
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
    expect(said.startsWith('KixDNS\u00a0的原话：')).toBe(true)
    expect(said).toContain('"main"（主列表）')
    expect(said).toContain('"fast"')
    expect(kernelWords('KixDNS 已停止')).toBe('KixDNS 已停止')
  })

  it('旧内核不认识「就是」：说清楚怎么办，不只给原话', async () => {
    const { kernelWords } = await import('./useConfigDocument')
    // 2026.10.27.19 的原话 / Kernel 2026.10.27.19's own words
    const raw = 'parse config JSON: unknown variant `domain_exact`, expected one of `any`, `domain_suffix`, `domain_regex` at line 1 column 225'
    expect(kernelWords(raw)).toBe('这个版本的 KixDNS 内核还不认识「就是」：到系统页更新内核，或者把「就是」改回「属于」')
    expect(kernelWords(raw.replace('`domain_exact`', '`request_domain_exact`'))).toContain('还不认识「就是」')
    expect(kernelWords(raw.replace('`domain_exact`', '`domain_exacts`'))).toContain('KixDNS\u00a0的原话')
  })

  // 2026.11.23.11 到 2026.11.25.27 的内核不认面板的配置块：不管服务端在前面加了什么、原因里还有什么，都说成同一句（提示、保存条、提示条
  // 都经过这里），不说英文原话 / Kernels 2026.11.23.11 to 2026.11.25.27 do not take the panel's block: whatever the server put before it and
  // whatever else the reasons say, it reads as one sentence (toasts, the save bar and the notice all pass through here), never the English words
  it('不认面板配置块的内核：说成更新内核的那一句', async () => {
    const { kernelWords } = await import('./useConfigDocument')
    const { PANEL_BLOCK_HINT } = await import('../kernel-problems')
    const raw = 'panel: the kernel does not read this key, so what it says has no effect; check its spelling and where it is written'
    expect(kernelWords(raw)).toBe(PANEL_BLOCK_HINT)
    expect(kernelWords(`KixDNS 没有接受这份配置：pipelines[0].rules[0].matcher: the kernel does not read this key; ${raw}`)).toBe(PANEL_BLOCK_HINT)
  })
})

// KixDNS 逐条列出了原因：保存条一条条列出来，路径换成这份草稿里的叫法；一条时就说那一条
// KixDNS listed its reasons one by one: the save bar lists them, paths in this draft's names; a single one is said as it is
describe('被拒的原因逐条列出', () => {
  beforeEach(() => resetTo(demoModel()))

  it('几条时结论下面一条条列，规则的路径换成规则名', async () => {
    const { refusalLines } = await import('./useConfigDocument')
    const { ApiError } = await import('../api/client')
    const draft = demoModel()
    const at = compile(draft).pipelines.findIndex((p) => p.rules.some((r) => r.name === '公司内网'))
    const j = compile(draft).pipelines[at]!.rules.findIndex((r) => r.name === '公司内网')
    const details = [`pipelines[${at}].rules[${j}].matchers[0]: domain_suffix "." matches every name`, 'settings.cache_capacity: must be at least 1']
    const lines = refusalLines(new ApiError(details.join('; '), 422, 'kixdns_rejected', details), draft)!
    expect(lines.note).toBe('KixDNS\u00a0列出了\u00a02\u00a0处要改：')
    expect(lines.list[0]).toBe('规则「公司内网」（matchers[0]）：domain_suffix "." matches every name')
    expect(lines.list[1]).toMatch(/^设置\u00a0缓存容量：/)
    expect(refusalLines(new ApiError(details[1]!, 422, 'kixdns_rejected', [details[1]!]), draft)).toEqual({ note: lines.list[1], list: [] })
    // 没有逐条的原因（更早的内核）时照原话说 / Without listed reasons (an earlier kernel) the words are said as they came
    expect(refusalLines(new ApiError('bad', 422, 'kixdns_rejected'), draft)).toBeNull()
  })

  it('不认面板配置块时先说更新内核，其余的跟在后面', async () => {
    const { refusalLines } = await import('./useConfigDocument')
    const { ApiError } = await import('../api/client')
    const { PANEL_BLOCK_HINT } = await import('../kernel-problems')
    const panel = 'panel: the kernel does not read this key, so what it says has no effect; check its spelling and where it is written'
    expect(refusalLines(new ApiError(panel, 422, 'kixdns_rejected', [panel]), demoModel())).toEqual({ note: PANEL_BLOCK_HINT, list: [] })
    const both = refusalLines(new ApiError('', 422, 'kixdns_rejected', [panel, 'settings.cache_capacity: must be at least 1']), demoModel())!
    expect(both.note).toBe(`${PANEL_BLOCK_HINT}。另外还有\u00a01\u00a0处要改：`)
    expect(both.list).toHaveLength(1)
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

// 表单里没有的设置照样留在配置里，对比里用它的名字 / A setting the form lacks stays in the config, and the diff names it
describe('只能在 JSON 里改的设置', () => {
  it('TCP 错误阈值读进来、写出去都原样保留，对比里叫它的名字', () => {
    const base = demoModel()
    base.settings = { ...base.settings, tcp_health_check_error_threshold: 5 }
    const back = readConfig(JSON.parse(JSON.stringify(exportConfig(base))) as Record<string, unknown>).model
    expect(back.settings.tcp_health_check_error_threshold).toBe(5)
    expect((exportConfig(back).settings as Record<string, unknown>).tcp_health_check_error_threshold).toBe(5)
    const then = { ...back, settings: { ...back.settings, tcp_health_check_error_threshold: 2 } }
    expect(diffModels(back, then).map((b) => b.title)).toEqual(['TCP 错误阈值'])
  })
})

// JSON 视图里只改一个设置、切回表单：草稿读回来以后，保存条和「改了哪些」只有这一处。以前按内核部分重新导入，
// 多出「加上 默认上游」「移动 域名映射的顺序」，还有两条没动过的规则标着改过、却列不出改了什么
// Only one setting edited in the JSON view, then back to the form: with the draft read back, the save bar and the review show that one
// change. A re-import from the kernel part used to add 「加上 默认上游」 and 「移动 域名映射的顺序」, and mark two untouched rules
// changed with nothing to list
describe('JSON 视图里只改了一个设置', () => {
  it('保存条算 1 处，「改了哪些」只有缓存容量', () => {
    const start = demoModel()
    start.mappings[1]!.enabled = false
    resetTo(start)
    const kernel = JSON.parse(JSON.stringify(compile(model))) as Record<string, unknown> & { settings: Record<string, unknown> }
    kernel.settings.cache_capacity = 50000
    replaceModel(readConfig(kernel, model).model)
    expect(diffModels(appliedModel.value, model).map((b) => `${b.kind} ${b.title}`)).toEqual(['改了 缓存容量'])
    expect(changeCount.value).toBe(1)
  })
})
