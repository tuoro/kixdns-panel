import { describe, expect, it } from 'vitest'
import { changedEntryIndexes, diffByIdentity, lineSegments } from './changes'
import { normalizeConfig, renamePipeline, serializeConfig } from './model'
import { collectDomainMappingRows, replaceDomainMappingRows, type DomainMappingRow } from './solution'
import type { ActionConfig, KixConfig, MatcherConfig, PipelineConfig, PipelineSelectConfig, RuleConfig } from './types'

function rule(name: string, actions: ActionConfig[], matchers: MatcherConfig[] = []): RuleConfig {
  return {
    name,
    matchers,
    matcher_operator: 'and',
    actions,
    response_matchers: [],
    response_matcher_operator: 'and',
    response_actions_on_match: [],
    response_actions_on_miss: [],
  }
}

function forward(upstream: string): ActionConfig {
  return { type: 'forward', upstream, transport: '' }
}

function geoSite(value: string): MatcherConfig {
  return { type: 'geo_site', operator: 'and', value }
}

function pipeline(id: string, ...rules: RuleConfig[]): PipelineConfig {
  return { id, rules }
}

function entry(pipelineId: string, ...matchers: MatcherConfig[]): PipelineSelectConfig {
  return { pipeline: pipelineId, matcher_operator: 'and', matchers }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 四个入口，各自独占一个 Pipeline；default 没有入口，接住没命中任何入口的请求。
// Four entries, each with a Pipeline of its own; default has no entry and takes what no entry matched.
function baseConfig(): KixConfig {
  return {
    settings: { cache_capacity: 10000 },
    pipeline_select: [
      entry('domestic', geoSite('geosite:cn')),
      entry('blocked', geoSite('geosite:category-ads-all')),
      entry('office', { type: 'client_ip', operator: 'and', cidr: '192.168.1.0/24' }),
      entry('global'),
    ],
    pipelines: [
      pipeline('default', rule('default', [forward('1.1.1.1:53')])),
      pipeline('domestic', rule('domestic-rule', [forward('223.5.5.5:53')])),
      pipeline('blocked', rule('blocked-rule', [{ type: 'deny' }])),
      pipeline('office', rule('office-rule', [forward('192.168.1.1:53')])),
      pipeline('global', rule('global-rule', [forward('8.8.8.8:53')])),
    ],
  }
}

/** office 入口改用 domestic，两个入口共用它。 / The office entry switches to domestic, so two entries share it. */
function sharedConfig(): KixConfig {
  const value = baseConfig()
  value.pipeline_select[2]!.pipeline = 'domestic'
  value.pipelines = value.pipelines.filter((item) => item.id !== 'office')
  return value
}

const NAS: DomainMappingRow = { source: 'nas.home.arpa', target: 'storage.home.arpa.', ttl: 300 }
const GIT: DomainMappingRow = { source: 'git.home.arpa', target: 'nas.home.arpa.', ttl: 120 }

describe('按身份比较配置改动', () => {
  it('在最前面插入一个 Pipeline 只算一处新增，其余 Pipeline 不算改动', () => {
    const before = baseConfig()
    const after = clone(before)
    after.pipelines.unshift(pipeline('fresh', rule('fresh-rule', [forward('9.9.9.9:53')])))

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups).toEqual([{
      key: 'pipeline:fresh',
      unit: 'pipeline:fresh',
      subject: 'pipeline',
      kind: 'added',
      title: 'Pipeline fresh',
      afterIndex: 0,
      lines: [{ mark: '+', text: 'fresh-rule · 任意请求 → 转发至 9.9.9.9:53', code: ['fresh-rule', '9.9.9.9:53'] }],
    }])
  })

  it('把域名映射 Pipeline 从第一个挪到最后，只报一处挪动', () => {
    const before = baseConfig()
    before.pipeline_select.splice(2, 1)
    before.pipelines = before.pipelines.filter((item) => item.id !== 'office')
    replaceDomainMappingRows(before, [NAS])
    before.pipelines.unshift(before.pipelines.pop()!)
    expect(before.pipelines.map((item) => item.id)).toEqual(['domain_mapping', 'default', 'domestic', 'blocked', 'global'])
    const after = clone(before)
    after.pipelines.push(after.pipelines.shift()!)

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups).toEqual([{
      key: 'pipeline:domain_mapping',
      unit: 'pipeline:domain_mapping',
      subject: 'pipeline',
      kind: 'moved',
      title: 'Pipeline domain_mapping',
      afterIndex: 4,
      from: 1,
      to: 5,
      lines: [],
    }])
  })

  it('新增一条域名映射只算一处；新加的空行不算改动', () => {
    const before = baseConfig()
    replaceDomainMappingRows(before, [NAS])
    const after = clone(before)
    replaceDomainMappingRows(after, [...collectDomainMappingRows(after), GIT])

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups).toEqual([{
      key: 'mapping:git.home.arpa',
      unit: 'mapping:git.home.arpa',
      subject: 'mapping',
      kind: 'added',
      title: '映射 git.home.arpa',
      afterIndex: 1,
      lines: [{ mark: '+', text: '→ nas.home.arpa. · 120 秒（2 分钟）', code: ['nas.home.arpa.'] }],
    }])

    const withEmptyRow = clone(before)
    replaceDomainMappingRows(withEmptyRow, [...collectDomainMappingRows(withEmptyRow), { source: '', target: '', ttl: 300 }])
    expect(diffByIdentity(before, withEmptyRow)).toEqual({ groups: [], count: 0 })
  })

  it('第一条域名映射插在所有入口前面，仍只算一处（按下标比较时是「已修改 6 处」）', () => {
    const before = baseConfig()
    const after = clone(before)
    replaceDomainMappingRows(after, [NAS])
    // 映射入口插在 pipeline_select 最前，四个入口的下标全部后移一位，映射 Pipeline 追加在末尾。
    // The mapping selector goes first, shifting all four entries by one; its Pipeline is appended.
    expect(after.pipeline_select.map((item) => item.pipeline)).toEqual(['domain_mapping', 'domestic', 'blocked', 'office', 'global'])

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups.map((group) => [group.key, group.kind])).toEqual([['mapping:nas.home.arpa', 'added']])
    expect(changedEntryIndexes(before, after).size).toBe(0)

    const onlyEmptyRow = clone(before)
    replaceDomainMappingRows(onlyEmptyRow, [{ source: '', target: '', ttl: 300 }])
    expect(diffByIdentity(before, onlyEmptyRow)).toEqual({ groups: [], count: 0 })
  })

  it('改映射表时映射 Pipeline 留在原位；旧面板把它挪到末尾的草稿也不另算一处', () => {
    const before = baseConfig()
    replaceDomainMappingRows(before, [NAS])
    // 先建映射、后加入口时，映射 Pipeline 夹在中间。 / Mappings made before later entries leave their Pipeline in the middle.
    before.pipelines.splice(2, 0, before.pipelines.pop()!)
    const after = clone(before)
    replaceDomainMappingRows(after, [...collectDomainMappingRows(after), GIT])
    expect(after.pipelines[2]?.id).toBe('domain_mapping')
    expect(diffByIdentity(before, after).groups.map((group) => group.key)).toEqual(['mapping:git.home.arpa'])

    // 以前的面板改映射表会把映射 Pipeline 挪到末尾；这种草稿里的挪动是改映射行的副作用
    // Older panels moved the mapping Pipeline to the end on every table edit; in such a draft the move is a side effect of the row edits
    after.pipelines.push(...after.pipelines.splice(2, 1))
    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups.map((group) => group.key)).toEqual(['mapping:git.home.arpa'])
  })

  // 源域名在组标题里写着，没变时行从箭头写起，不复述（审计第五轮 D1） / With the source in the group title and unchanged, lines start at the arrow (audit round 5, D1)
  it('只改了映射的目标：行里不再重复组标题里的源域名', () => {
    const before = baseConfig()
    replaceDomainMappingRows(before, [NAS, GIT])
    const after = clone(before)
    replaceDomainMappingRows(after, [{ ...NAS, target: 'files.home.arpa.' }, GIT])

    const [group] = diffByIdentity(before, after).groups

    expect(group?.title).toBe('映射 nas.home.arpa')
    expect(group?.lines).toEqual([
      { mark: '-', text: '→ storage.home.arpa. · 300 秒（5 分钟）', code: ['storage.home.arpa.'] },
      { mark: '+', text: '→ files.home.arpa. · 300 秒（5 分钟）', code: ['files.home.arpa.'] },
    ])
  })

  it('源域名只改了大小写或结尾的根点：两行都写出源域名，− 和 + 不会一模一样（审计第六轮 C3）', () => {
    for (const source of ['NAS.home.arpa', 'nas.home.arpa.']) {
      const before = baseConfig()
      replaceDomainMappingRows(before, [NAS, GIT])
      const after = clone(before)
      replaceDomainMappingRows(after, [{ ...NAS, source }, GIT])

      const [group] = diffByIdentity(before, after).groups

      expect(group?.lines.map((line) => line.text)).toEqual([
        'nas.home.arpa → storage.home.arpa. · 300 秒（5 分钟）',
        `${source} → storage.home.arpa. · 300 秒（5 分钟）`,
      ])
    }
  })

  it('改了映射的源域名算一处改动，不是删一条加一条', () => {
    const before = baseConfig()
    replaceDomainMappingRows(before, [NAS, GIT])
    const after = clone(before)
    replaceDomainMappingRows(after, [{ ...NAS, source: 'nas.home.lan' }, GIT])

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups).toEqual([{
      key: 'mapping:nas.home.lan',
      unit: 'mapping:nas.home.lan',
      subject: 'mapping',
      kind: 'changed',
      title: '映射 nas.home.lan',
      afterIndex: 0,
      lines: [
        { mark: '-', text: 'nas.home.arpa → storage.home.arpa. · 300 秒（5 分钟）', code: ['nas.home.arpa', 'storage.home.arpa.'] },
        { mark: '+', text: 'nas.home.lan → storage.home.arpa. · 300 秒（5 分钟）', code: ['nas.home.lan', 'storage.home.arpa.'] },
      ],
    }])
  })

  it('改入口条件的同时它的 Pipeline 改了名：入口和 Pipeline 合成一处', () => {
    const before = baseConfig()
    const after = clone(before)
    const renamed = after.pipelines.find((item) => item.id === 'domestic')!
    renamed.id = 'cn-dns'
    renamePipeline(after, renamed, 'domestic')
    after.pipeline_select[0]!.matchers[0]!.value = 'geosite:geolocation-cn'

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups).toEqual([
      {
        key: 'entry:1',
        unit: 'entry:1',
        subject: 'entry',
        kind: 'changed',
        title: '入口 01',
        afterIndex: 0,
        lines: [
          { mark: '-', text: '域名属于 GeoSite cn' },
          { mark: '+', text: '域名属于 GeoSite geolocation-cn' },
          { mark: '-', text: '→ domestic · 转发至 223.5.5.5:53', code: ['domestic', '223.5.5.5:53'] },
          { mark: '+', text: '→ cn-dns · 转发至 223.5.5.5:53', code: ['cn-dns', '223.5.5.5:53'] },
        ],
      },
      {
        key: 'pipeline:cn-dns',
        unit: 'entry:1',
        subject: 'pipeline',
        kind: 'changed',
        title: 'Pipeline cn-dns',
        afterIndex: 1,
        lines: [
          { mark: '-', text: 'Pipeline domestic', code: ['domestic'] },
          { mark: '+', text: 'Pipeline cn-dns', code: ['cn-dns'] },
        ],
      },
    ])
    expect(changedEntryIndexes(before, after)).toEqual(new Set([0]))
  })

  it('改入口条件的同时把共享 Pipeline 复制成独立的：仍是一处', () => {
    const before = sharedConfig()
    const after = clone(before)
    // 引导里编辑共享入口，默认把 Pipeline 复制成 domestic-copy，再改条件和上游。
    // Editing a shared entry in the guide copies its Pipeline to domestic-copy by default; the condition and upstream change too.
    after.pipeline_select[2]!.pipeline = 'domestic-copy'
    after.pipeline_select[2]!.matchers[0]!.cidr = '192.168.2.0/24'
    after.pipelines.push(pipeline('domestic-copy', rule('domestic-rule', [forward('192.168.2.1:53')])))

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups.map(({ key, unit, kind }) => ({ key, unit, kind }))).toEqual([
      { key: 'entry:3', unit: 'entry:3', kind: 'changed' },
      { key: 'pipeline:domestic-copy', unit: 'entry:3', kind: 'added' },
    ])
    expect(changes.groups[0]?.lines.map((item) => `${item.mark} ${item.text}`)).toEqual([
      '- 客户端 IP 属于 192.168.1.0/24',
      '+ 客户端 IP 属于 192.168.2.0/24',
      '- → domestic · 转发至 223.5.5.5:53',
      '+ → domestic-copy · 转发至 192.168.2.1:53',
    ])
    expect(changedEntryIndexes(before, after)).toEqual(new Set([2]))
  })

  // 共享 Pipeline 改了，是 Pipeline 自己的一处改动；引用它的两个入口本身没变，不加未保存圆点，
  // 否则两个圆点对着「已修改 1 处」。
  // A changed shared Pipeline is one change of its own; the two entries using it did not change and get
  // no dirty dot, or two dots would sit next to 已修改 1 处.
  it('共享 Pipeline 改了只算一处，引用它的入口不加圆点', () => {
    const before = sharedConfig()
    const after = clone(before)
    after.pipelines[1]!.rules[0]!.actions = [forward('119.29.29.29:53')]

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups).toEqual([{
      key: 'pipeline:domestic',
      unit: 'pipeline:domestic',
      subject: 'pipeline',
      kind: 'changed',
      title: 'Pipeline domestic',
      afterIndex: 1,
      lines: [
        { mark: '-', text: 'domestic-rule · 任意请求 → 转发至 223.5.5.5:53', code: ['domestic-rule', '223.5.5.5:53'] },
        { mark: '+', text: 'domestic-rule · 任意请求 → 转发至 119.29.29.29:53', code: ['domestic-rule', '119.29.29.29:53'] },
      ],
    }])
    expect(changedEntryIndexes(before, after).size).toBe(0)
  })

  it('改一项设置算一处', () => {
    const before = baseConfig()
    const after = clone(before)
    after.settings.cache_capacity = 20000

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups).toEqual([{
      key: 'setting:cache_capacity',
      unit: 'setting:cache_capacity',
      subject: 'setting',
      kind: 'changed',
      title: '设置 cache_capacity',
      lines: [{ mark: '-', text: '缓存容量 10000' }, { mark: '+', text: '缓存容量 20000' }],
    }])
  })

  it('交换两个入口是两处挪动，不是改动，两个都加圆点', () => {
    const before = baseConfig()
    const after = clone(before)
    const [first, , third] = after.pipeline_select
    after.pipeline_select[0] = third!
    after.pipeline_select[2] = first!

    const changes = diffByIdentity(before, after)

    // 夹在中间的 02 没动，不报。 / Entry 02 in between stayed put and is not reported.
    expect(changes.groups).toEqual([
      { key: 'entry:1', unit: 'entry:1', subject: 'entry', kind: 'moved', title: '入口 01', afterIndex: 0, from: 3, to: 1, lines: [] },
      { key: 'entry:3', unit: 'entry:3', subject: 'entry', kind: 'moved', title: '入口 03', afterIndex: 2, from: 1, to: 3, lines: [] },
    ])
    expect(changes.count).toBe(2)
    expect(changedEntryIndexes(before, after)).toEqual(new Set([0, 2]))
  })

  it('把入口 03 移到最前，只标它自己，不标被它越过的两个', () => {
    const before = baseConfig()
    const after = clone(before)
    after.pipeline_select.unshift(after.pipeline_select.splice(2, 1)[0]!)

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups.map(({ key, kind, from, to }) => ({ key, kind, from, to }))).toEqual([{ key: 'entry:1', kind: 'moved', from: 3, to: 1 }])
    expect(changedEntryIndexes(before, after)).toEqual(new Set([0]))
  })

  it('相邻两个入口互换时，标往前挪的那个', () => {
    const before = baseConfig()
    const after = clone(before)
    after.pipeline_select.splice(0, 0, after.pipeline_select.splice(1, 1)[0]!)

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups.map(({ key, kind, from, to }) => ({ key, kind, from, to }))).toEqual([{ key: 'entry:1', kind: 'moved', from: 2, to: 1 }])
  })

  it('两份相同的配置没有改动，编辑器写出再读回的也一样', () => {
    const before = baseConfig()
    replaceDomainMappingRows(before, [NAS, GIT])

    expect(diffByIdentity(before, clone(before))).toEqual({ groups: [], count: 0 })
    // 写出时会省掉 and、空 transport 这些默认值，读回来再比也不算改动。
    // Serializing drops defaults such as and and an empty transport; reading it back is still no change.
    const written = JSON.parse(serializeConfig(normalizeConfig(before))) as KixConfig
    expect(diffByIdentity(before, written)).toEqual({ groups: [], count: 0 })
    expect(changedEntryIndexes(before, written).size).toBe(0)
  })

  it('原地改入口条件是一处改动，列出前后的条件', () => {
    const before = baseConfig()
    const after = clone(before)
    after.pipeline_select[1]!.matchers[0]!.value = 'geosite:category-ads'

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups).toEqual([{
      key: 'entry:2',
      unit: 'entry:2',
      subject: 'entry',
      kind: 'changed',
      title: '入口 02',
      afterIndex: 1,
      lines: [
        { mark: '-', text: '域名属于 GeoSite category-ads-all' },
        { mark: '+', text: '域名属于 GeoSite category-ads' },
      ],
    }])
    expect(changedEntryIndexes(before, after)).toEqual(new Set([1]))
  })

  it('多条件入口只列出增删的那一条', () => {
    const before = baseConfig()
    before.pipeline_select[0]!.matchers.push({ type: 'qtype', operator: 'and', value: 'A' })
    const after = clone(before)
    after.pipeline_select[0]!.matchers[1]!.value = 'AAAA'

    expect(diffByIdentity(before, after).groups[0]?.lines).toEqual([
      { mark: '-', text: '查询类型为 A' },
      { mark: '+', text: '查询类型为 AAAA' },
    ])
  })

  it('入口独占的 Pipeline 改了：入口算改了，和 Pipeline 合成一处', () => {
    const before = baseConfig()
    const after = clone(before)
    after.pipelines[3]!.rules[0]!.actions = [forward('192.168.1.2:53')]

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups.map(({ key, unit, kind, lines }) => ({ key, unit, kind, lines: lines.map((item) => `${item.mark} ${item.text}`) }))).toEqual([
      { key: 'entry:3', unit: 'entry:3', kind: 'changed', lines: ['- → office · 转发至 192.168.1.1:53', '+ → office · 转发至 192.168.1.2:53'] },
      { key: 'pipeline:office', unit: 'entry:3', kind: 'changed', lines: ['- office-rule · 任意请求 → 转发至 192.168.1.1:53', '+ office-rule · 任意请求 → 转发至 192.168.1.2:53'] },
    ])
    expect(changedEntryIndexes(before, after)).toEqual(new Set([2]))
  })

  it('入口改了条件又挪了位置，靠独占的 Pipeline 认出是同一个', () => {
    const before = baseConfig()
    const after = clone(before)
    const [office] = after.pipeline_select.splice(2, 1)
    office!.matchers[0]!.cidr = '10.0.0.0/8'
    after.pipeline_select.unshift(office!)

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups.map(({ key, kind, from, to }) => ({ key, kind, from, to }))).toEqual([{ key: 'entry:1', kind: 'changed', from: 3, to: 1 }])
  })

  it('删掉入口连同它独占的 Pipeline 算一处', () => {
    const before = baseConfig()
    const after = clone(before)
    after.pipeline_select.splice(1, 1)
    after.pipelines = after.pipelines.filter((item) => item.id !== 'blocked')

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups).toEqual([
      {
        key: 'entry:removed:2',
        unit: 'entry:removed:2',
        subject: 'entry',
        kind: 'removed',
        title: '入口 02',
        // 动作写在下面「连同」的 Pipeline 里，入口这一行只写到 Pipeline 的名字（审计第六轮 D4）
        // The action is in the 连同 Pipeline below, so the entry line stops at the Pipeline's name (audit round 6, D4)
        lines: [{ mark: '-', text: '域名属于 GeoSite category-ads-all → blocked', code: ['blocked'] }],
      },
      {
        key: 'pipeline:blocked',
        unit: 'entry:removed:2',
        subject: 'pipeline',
        kind: 'removed',
        title: 'Pipeline blocked',
        lines: [{ mark: '-', text: 'blocked-rule · 任意请求 → 拒绝请求', code: ['blocked-rule'] }],
      },
    ])
    expect(changedEntryIndexes(before, after).size).toBe(0)
  })

  it('方向固定为 from → to：反过来比，新增变删除，+ 变 -', () => {
    const before = baseConfig()
    const after = clone(before)
    after.pipelines.unshift(pipeline('fresh', rule('fresh-rule', [forward('9.9.9.9:53')])))

    const [group] = diffByIdentity(after, before).groups

    expect(group).toMatchObject({ key: 'pipeline:fresh', kind: 'removed' })
    expect(group?.afterIndex).toBeUndefined()
    expect(group?.lines.map((item) => item.mark)).toEqual(['-'])
  })

  it('Pipeline 内的规则按名称对齐：挪动只报被挪的那条，改名按位置配对', () => {
    const before = baseConfig()
    before.pipelines[0]!.rules = [
      rule('first', [{ type: 'deny' }]),
      rule('second', [forward('1.1.1.1:53')]),
      rule('third', [{ type: 'allow' }]),
    ]
    const moved = clone(before)
    moved.pipelines[0]!.rules.unshift(moved.pipelines[0]!.rules.pop()!)

    expect(diffByIdentity(before, moved).groups.map((group) => group.lines.map((item) => `${item.mark} ${item.text}`))).toEqual([
      ['- third · 第 3 条', '+ third · 第 1 条'],
    ])

    // 带响应阶段：配成一对时只列变了的主句；当成删一条加一条，两行都会带上「含响应阶段」。
    // With a response stage: a pair lists only the main sentence that changed; a removal plus an
    // addition would carry 含响应阶段 on both lines.
    before.pipelines[0]!.rules[1]!.response_actions_on_match = [{ type: 'log', level: 'warn' }]
    const renamed = clone(before)
    renamed.pipelines[0]!.rules[1]!.name = 'second-renamed'
    renamed.pipelines[0]!.rules[1]!.actions = [forward('1.0.0.1:53')]
    const changes = diffByIdentity(before, renamed)

    expect(changes.count).toBe(1)
    expect(changes.groups[0]?.lines).toEqual([
      { mark: '-', text: 'second · 任意请求 → 转发至 1.1.1.1:53', code: ['second', '1.1.1.1:53'] },
      { mark: '+', text: 'second-renamed · 任意请求 → 转发至 1.0.0.1:53', code: ['second-renamed', '1.0.0.1:53'] },
    ])
  })

  it('只改了响应阶段的规则列出响应条件和分支', () => {
    const before = baseConfig()
    const withResponse = (target: string): RuleConfig => ({
      ...rule('domestic-rule', [forward('223.5.5.5:53')]),
      response_matchers: [{ type: 'response_answer_ip', operator: 'and', cidr: '0.0.0.0/32' }],
      response_actions_on_match: [{ type: 'jump_to_pipeline', pipeline: target }],
    })
    before.pipelines[1]!.rules = [withResponse('global')]
    const after = clone(before)
    after.pipelines[1]!.rules = [withResponse('default')]

    const pipelineGroup = diffByIdentity(before, after).groups.find((group) => group.subject === 'pipeline')

    expect(pipelineGroup?.lines).toEqual([
      { mark: '-', text: 'domestic-rule · 响应条件 应答 IP 属于 0.0.0.0/32 · 匹配成功 跳转至 Pipeline global · 匹配失败 未配置动作', code: ['domestic-rule', '0.0.0.0/32', 'global'] },
      { mark: '+', text: 'domestic-rule · 响应条件 应答 IP 属于 0.0.0.0/32 · 匹配成功 跳转至 Pipeline default · 匹配失败 未配置动作', code: ['domestic-rule', '0.0.0.0/32', 'default'] },
    ])
  })

  it('摘要里看不出的改动逐个字段写出来', () => {
    const before = sharedConfig()
    const after = clone(before)
    after.pipelines[1]!.rules[0]!.actions[0]!.ecs = { mode: 'clear' }

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups[0]?.lines.map((item) => `${item.mark} ${item.text}`)).toEqual([
      '- domestic-rule · actions [{"type":"forward","upstream":"223.5.5.5:53","transport":""}]',
      '+ domestic-rule · actions [{"type":"forward","upstream":"223.5.5.5:53","transport":"","ecs":{"mode":"clear"}}]',
    ])
  })

  it('映射 Pipeline 被改成普通流程时，映射行、入口和 Pipeline 合成一处', () => {
    const before = baseConfig()
    replaceDomainMappingRows(before, [NAS, GIT])
    const after = clone(before)
    after.pipelines.find((item) => item.id === 'domain_mapping')!.rules.push(rule('extra', [{ type: 'deny' }]))

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups.map(({ key, unit, kind }) => ({ key, unit, kind }))).toEqual([
      { key: 'mapping:nas.home.arpa', unit: 'pipeline:domain_mapping', kind: 'removed' },
      { key: 'mapping:git.home.arpa', unit: 'pipeline:domain_mapping', kind: 'removed' },
      { key: 'entry:1', unit: 'pipeline:domain_mapping', kind: 'added' },
      { key: 'pipeline:domain_mapping', unit: 'pipeline:domain_mapping', kind: 'changed' },
    ])
    expect(changedEntryIndexes(before, after)).toEqual(new Set([0]))
  })

  it('增删设置和其余顶层字段按键比较', () => {
    const before = { ...baseConfig(), version: '1' }
    const after = clone(before)
    after.version = '2'
    after.settings.bind_udp = '0.0.0.0:5353'
    delete after.settings.cache_capacity

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(3)
    expect(changes.groups.map(({ key, kind, title, lines }) => ({ key, kind, title, lines }))).toEqual([
      { key: 'setting:bind_udp', kind: 'added', title: '设置 bind_udp', lines: [{ mark: '+', text: 'UDP 监听地址 0.0.0.0:5353', code: ['0.0.0.0:5353'] }] },
      { key: 'setting:cache_capacity', kind: 'removed', title: '设置 cache_capacity', lines: [{ mark: '-', text: '缓存容量 10000' }] },
      { key: 'other:version', kind: 'changed', title: 'version', lines: [{ mark: '-', text: '1', code: ['1'] }, { mark: '+', text: '2', code: ['2'] }] },
    ])
  })

  it('很长的映射表也只标被挪动的那一条', () => {
    const rows = Array.from({ length: 600 }, (_, index) => ({ source: `host-${index}.home.arpa`, target: 'nas.home.arpa.', ttl: 300 }))
    const before = baseConfig()
    replaceDomainMappingRows(before, rows)
    const after = clone(before)
    replaceDomainMappingRows(after, [rows.at(-1)!, ...rows.slice(0, -1)])

    const changes = diffByIdentity(before, after)

    expect(changes.count).toBe(1)
    expect(changes.groups.map(({ key, kind, from, to }) => ({ key, kind, from, to }))).toEqual([{ key: 'mapping:host-599.home.arpa', kind: 'moved', from: 600, to: 1 }])
  })

  it('lineSegments 切出机器值，不会切到 Pipeline 这类词中间', () => {
    expect(lineSegments({ mark: '-', text: '→ domestic · 转发至 223.5.5.5:53', code: ['domestic', '223.5.5.5:53'] })).toEqual([
      { text: '→ ', code: false },
      { text: 'domestic', code: true },
      { text: ' · 转发至 ', code: false },
      { text: '223.5.5.5:53', code: true },
    ])

    const before = baseConfig()
    const after = clone(before)
    const renamed = after.pipelines.find((item) => item.id === 'default')!
    renamed.id = 'line'
    renamePipeline(after, renamed, 'default')
    const [line] = diffByIdentity(before, after).groups[0]!.lines.filter((item) => item.mark === '+')

    expect(lineSegments(line!)).toEqual([{ text: 'Pipeline ', code: false }, { text: 'line', code: true }])
  })
})
