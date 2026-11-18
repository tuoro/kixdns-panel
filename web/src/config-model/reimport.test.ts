import { describe, expect, it } from 'vitest'
import { newOf } from './condKinds'
import { exportConfig, readConfig, type ReadResult } from './document'
import { compile, FIELD, newRule, nextId, RESPONSE_FIELD, type Condition, type KernelConfig, type Model, type Outcome, type ResponseCondition, type Rule } from './model'
import { sampleModel } from './testing/samples'

// 配置文件里的内核部分改了、panel 的散列对不上时怎么读回来。两种来路：
// - 服务端的系统写入（导入内置 GeoSite、定时同步 Geo 数据、定时更新拦截列表）只改内核的 settings，panel 原样带着；
// - JSON 视图里改了内核部分，读回草稿时没有 panel，上一份就是草稿。
// 面板里好几种写法编出来是同一份内核配置，读回来时不能悄悄换成另一种：意思会跟着变（以后改默认、改组的备用和子网时，这条规则跟不跟）。
// How the config reads back when its kernel part changed and panel's hash no longer matches. Two ways in:
// - the server's system writes (importing the built-in GeoSite, Geo sync, the scheduled blocklist update) change the kernel settings only
//   and carry panel along unchanged;
// - the JSON view edited the kernel part, read back into the draft with no panel, the draft being the previous model.
// Several panel forms compile to the same kernel config, and reading back must not swap one for another silently: the meaning moves
// with it (whether the rule follows a later change of the default, the group's fallback or its subnet).

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const GEO_NEW = '/var/lib/kixdns-panel/geo/geosite-0a1b2c3d4e5f.dat'
const BLOCKLIST_OLD = `/var/lib/kixdns-panel/geo/blocklist-${'a'.repeat(64)}.json`
const BLOCKLIST_NEW = `/var/lib/kixdns-panel/geo/blocklist-${'b'.repeat(64)}.json`
const isBlocklistPath = (p: unknown) => typeof p === 'string' && /(^|\/)blocklist-[0-9a-f]{64}\.json$/.test(p)

type Cfg = Record<string, unknown> & { settings: Record<string, unknown> }
// Geo 同步（geo_data.rs apply_manifest_paths）：GeoSite 换成清单里的文件，拦截列表合成的文件原样排在后面
// Geo sync (geo_data.rs apply_manifest_paths): GeoSite becomes the manifest's files, the blocklists' merged file stays after them
function geoSync(m: Model): ReadResult {
  const cfg = clone(exportConfig(m)) as Cfg
  const paths = Array.isArray(cfg.settings.geosite_data_paths) ? cfg.settings.geosite_data_paths : []
  cfg.settings.geosite_data_paths = [GEO_NEW, ...paths.filter(isBlocklistPath)]
  return readConfig(cfg)
}
// JSON 视图里改了别的规则（公司内网的第一个域名）再读回草稿 / The JSON view edits another rule (公司内网's first domain) and reads back into the draft
function jsonEditElsewhere(m: Model): ReadResult {
  const k = clone(compile(m))
  const corp = k.pipelines.find((p) => p.id === 'main')!.rules.find((r) => r.name === '公司内网')!
  corp.matchers[0]!.value = 'corp.example.net'
  return readConfig(k as unknown as Record<string, unknown>, m)
}
const PATHS = [['系统写入只改了 settings', geoSync], ['JSON 视图里改了别的规则', jsonEditElsewhere]] as const
// JSON 视图里改了内核部分再读回草稿 / The JSON view edits the kernel part and reads back into the draft
const editKernel = (m: Model, edit: (k: KernelConfig) => void) => {
  const k = clone(compile(m))
  edit(k)
  return readConfig(k as unknown as Record<string, unknown>, m).model
}

// 按页面的做法加一条规则：newRule 起空壳，条件用编辑器的 newOf / A rule added as the page adds one: newRule for the shell, the editor's newOf for conditions
function addRule(m: Model, name: string, outcome: Outcome, domain: string, patch: (r: Rule, id: () => number) => void = () => {}): Rule {
  let next = nextId(m)
  const id = () => next++
  const r = newRule(id(), outcome)
  r.name = name
  r.conditions = [[{ ...newOf('domain', id(), FIELD), values: [domain] } as Condition]]
  patch(r, id)
  m.rules.splice(m.rules.length - 1, 0, r)
  return r
}
const responseCond = (field: ResponseCondition['field'], id: number, values: string[]): ResponseCondition => ({ ...newOf(field, id, RESPONSE_FIELD), values } as ResponseCondition)
const ruleNamed = (m: Model, name: string) => [...m.rules, ...m.ruleGroups.flatMap((g) => g.rules)].find((r) => r.name === name)

describe('重新读入：编出来一样的写法不换成另一种 / reading back keeps a form that compiles alike', () => {
  for (const [path, read] of PATHS) {
    describe(path, () => {
      it('回答后检查里的「拦截（沿用默认）」还是沿用默认，以后改「拦截时怎么回应」照样跟着变', () => {
        const m = sampleModel()
        // 编辑器「拦截」的默认就是沿用默认（RuleEditor remedyOf） / The editor's 拦截 defaults to 沿用默认 (RuleEditor remedyOf)
        addRule(m, '国外结果查内网', { type: 'upstream', group: 'abroad' }, 'example.org', (r, id) => {
          r.response = { ...r.response, mode: 'custom', match: 'all', conditions: [responseCond('answer_private', id(), [])], then: { type: 'block', response: 'default' } }
        })
        const back = read(m).model
        expect(ruleNamed(back, '国外结果查内网')!.response.then).toEqual({ type: 'block', response: 'default' })
      })

      it('明说的「不检查」和「不处理客户端子网」不变成沿用上游组', () => {
        const m = sampleModel()
        // 路由器组没有备用、国外组不处理子网：现在写法编出来和沿用一样，以后组加了备用、改了子网就不一样了
        // 路由器 has no fallback and 国外 leaves the subnet alone: compiled alike today, they part once the group gains a fallback or a subnet
        addRule(m, '路由器不检查', { type: 'upstream', group: 'router' }, 'lan.example', (r) => { r.response = { ...r.response, mode: 'off' } })
        addRule(m, '国外不处理子网', { type: 'upstream', group: 'abroad' }, 'example.net', (r) => { r.ecs = null })
        const back = read(m).model
        expect(ruleNamed(back, '路由器不检查')!.response.mode).toBe('off')
        expect(ruleNamed(back, '国外不处理子网')!.ecs).toBeNull()
      })

      it('两个组地址一样时，单独设了子网的规则还指向原来的组，不换成另一个组再抄一份备用', () => {
        const m = sampleModel()
        const cn = m.groups.find((g) => g.id === 'cn')!
        m.groups.push({ id: 'cn-plain', name: '国内（不带备用）', addresses: clone(cn.addresses), ecs: null, fallback: { group: '', onError: false, onPolluted: false } })
        addRule(m, '国内固定子网', { type: 'upstream', group: 'cn' }, 'example.cn', (r) => { r.ecs = { mode: 'static', subnet: '203.0.113.0/24' } })
        const back = read(m).model
        const r = ruleNamed(back, '国内固定子网')!
        expect([r.outcome, r.ecs, r.response.mode]).toEqual([{ type: 'upstream', group: 'cn' }, { mode: 'static', subnet: '203.0.113.0/24' }, 'inherit'])
      })

      it('停用的域名映射放回原来的位置，映射的先后不变', () => {
        const m = sampleModel()
        m.mappings[1]!.enabled = false
        const back = read(m).model
        expect(back.mappings.map((x) => [x.domain, x.enabled])).toEqual(m.mappings.map((x) => [x.domain, x.enabled]))
      })

      it('编配置时按其余请求写的默认上游不收进设置', () => {
        const m = sampleModel()
        expect(compile(m).settings.default_upstream).toBeDefined()
        expect(Object.keys(read(m).model.settings)).not.toContain('default_upstream')
      })

      it('「0.0.0.0, ::」的自定义回答、IP 映射的 TTL、只有一个条件的「满足任一」、日志、回答条件的编号都照旧', () => {
        const m = sampleModel()
        addRule(m, '回答空地址', { type: 'answer', kind: 'ip', value: '0.0.0.0, ::', ttl: null }, 'sink.example')
        m.mappings[0]!.ttl = 300
        const rebind = ruleNamed(m, '防 DNS 重绑定')!
        expect([rebind.response.match, rebind.response.conditions.length, 'thenLog' in rebind.response]).toEqual(['any', 1, false])
        const back = read(m).model
        expect(ruleNamed(back, '回答空地址')!.outcome).toEqual({ type: 'answer', kind: 'ip', value: '0.0.0.0, ::', ttl: null })
        expect(back.mappings[0]).toEqual(m.mappings[0])
        expect(ruleNamed(back, '防 DNS 重绑定')).toEqual(rebind)
      })

      it('拆成几段写进内核的规则（#1、#2）也整条留着', () => {
        const m = sampleModel()
        // 两个多值条件：内核里拆成两段 / Two multi-valued conditions: split into two parts in the kernel
        const r = addRule(m, '路由器两段不检查', { type: 'upstream', group: 'router' }, 'a.lan.example', (x, id) => {
          x.conditions[0]![0]!.values = ['a.lan.example', 'b.lan.example']
          x.conditions[0]!.push({ ...newOf('qtype', id(), FIELD), values: ['A', 'AAAA'] } as Condition)
          x.response = { ...x.response, mode: 'off' }
        })
        expect(compile(m).pipelines.find((p) => p.id === 'main')!.rules.filter((k) => k.name.startsWith('路由器两段不检查#')).length).toBe(2)
        expect(ruleNamed(read(m).model, '路由器两段不检查')).toEqual(r)
      })

      it('设置里留着的默认上游（被其余请求的组盖住、页面上不显示）照旧留着', () => {
        const m = sampleModel()
        m.settings.default_upstream = '8.8.8.8:53'
        expect(read(m).model.settings.default_upstream).toBe('8.8.8.8:53')
      })

      it('上游组地址的写法和固定子网的写法照旧', () => {
        const m = sampleModel()
        const router = m.groups.find((g) => g.id === 'router')!
        router.addresses = [{ address: '192.168.1.1:53', protocol: 'udp' }, { address: 'tcp://192.168.1.2:53', protocol: 'auto' }]
        router.ecs = { mode: 'static', subnet: '192.168.1.0' }
        const back = read(m).model
        expect(back.groups.find((g) => g.id === 'router')).toEqual(router)
      })
    })
  }

  it('系统写入只改了 settings：模型原样留着，只换 settings，不出导入说明', () => {
    const m = sampleModel()
    const back = geoSync(m)
    expect([back.source, back.report]).toEqual(['panel', null])
    expect(back.model).toEqual({ ...m, settings: { ...m.settings, geosite_data_paths: [GEO_NEW] } })
  })

  it('定时更新拦截列表换了合成的文件：模型原样留着，只换文件', () => {
    const m = sampleModel()
    m.blocklists = { subscriptions: [{ id: nextId(m), name: 'OISD big', url: 'https://big.oisd.nl/', enabled: true }], file: BLOCKLIST_OLD, custom: '', builtFor: 'https://big.oisd.nl/' }
    // blocklist.rs：服务端把 geosite_data_paths 里旧的文件换成新的 / blocklist.rs: the server swaps the old file for the new one in geosite_data_paths
    const cfg = clone(exportConfig(m)) as Cfg
    cfg.settings.geosite_data_paths = (cfg.settings.geosite_data_paths as string[]).map((p) => (p === BLOCKLIST_OLD ? BLOCKLIST_NEW : p))
    const back = readConfig(cfg)
    expect([back.source, back.report]).toEqual(['panel', null])
    expect(back.model).toEqual({ ...m, blocklists: { ...m.blocklists, file: BLOCKLIST_NEW } })
  })

  it('Geo 同步去掉了 GeoIP MMDB、加了 GeoIP DAT，服务端挪动了设置里键的位置：照样只换 settings', () => {
    const m = sampleModel()
    const cfg = clone(exportConfig(m)) as Cfg
    // serde_json（preserve_order）删键是 swap_remove：最后一个键挪到删掉的位置；新键排在最后
    // serde_json (preserve_order) removes a key by swap_remove: the last key moves into its place; a new key goes last
    const entries = Object.entries(cfg.settings)
    const at = entries.findIndex(([k]) => k === 'geoip_db_path')
    entries[at] = entries.pop()!
    cfg.settings = Object.fromEntries([...entries, ['geoip_dat_path', '/var/lib/kixdns-panel/geo/geoip-dat-1a2b3c.dat']])
    cfg.settings.geosite_data_paths = [GEO_NEW]
    expect(Object.keys(cfg.settings).at(-2)).not.toBe('default_upstream')
    const back = readConfig(cfg)
    const { geoip_db_path: _gone, ...kept } = m.settings
    expect([back.source, back.report]).toEqual(['panel', null])
    expect(back.model).toEqual({ ...m, settings: { ...kept, geosite_data_paths: [GEO_NEW], geoip_dat_path: '/var/lib/kixdns-panel/geo/geoip-dat-1a2b3c.dat' } })
  })

  it('JSON 里把停用着的映射加回来：就是启用了它，编号和位置照旧，不多出一条同域名的', () => {
    const m = sampleModel()
    m.mappings[1]!.enabled = false
    const router = m.mappings[1]!
    const k = clone(compile(m)) as KernelConfig
    k.pipelines.find((p) => p.id === 'domain_mapping')!.rules.splice(1, 0, { ...clone(k.pipelines.find((p) => p.id === 'domain_mapping')!.rules[0]!), name: `域名映射 ${router.domain}`, matchers: [{ type: 'domain_suffix', value: router.domain, operator: 'and' }], actions: [{ type: 'static_ip_response', ip: router.target }] })
    k.pipeline_select[0]!.matchers.splice(1, 0, { type: 'domain_suffix', value: router.domain, operator: 'or' })
    const back = readConfig(k as unknown as Record<string, unknown>, m).model
    expect(back.mappings).toEqual(m.mappings.map((x) => (x === router ? { ...x, enabled: true } : x)))
  })

  it('JSON 里多写了一条同域名的映射：多出的那条是新映射，编号不重复', () => {
    const m = sampleModel()
    const k = clone(compile(m)) as KernelConfig
    const rules = k.pipelines.find((p) => p.id === 'domain_mapping')!.rules
    rules.push({ ...clone(rules[0]!), actions: [{ type: 'static_ip_response', ip: '192.168.1.99' }] })
    k.pipeline_select[0]!.matchers.push({ type: 'domain_suffix', value: m.mappings[0]!.domain, operator: 'or' })
    const back = readConfig(k as unknown as Record<string, unknown>, m).model
    expect(back.mappings.filter((x) => x.domain === m.mappings[0]!.domain).length).toBe(2)
    const ids = back.mappings.map((x) => x.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(back.mappings[0]).toEqual(m.mappings[0])
  })

  it('设置里本来没有 GeoSite 文件、只有拦截列表合成的那个：读回来不多出一个空的 GeoSite 列表', () => {
    const m = sampleModel()
    delete m.settings.geosite_data_paths
    m.blocklists = { subscriptions: [{ id: nextId(m), name: 'OISD big', url: 'https://big.oisd.nl/', enabled: true }], file: BLOCKLIST_OLD, custom: '', builtFor: 'https://big.oisd.nl/' }
    const cfg = clone(exportConfig(m)) as Cfg
    cfg.settings.geosite_data_paths = [BLOCKLIST_NEW]
    expect(readConfig(cfg).model).toEqual({ ...m, blocklists: { ...m.blocklists, file: BLOCKLIST_NEW } })
    const back = jsonEditElsewhere(m).model
    expect(Object.keys(back.settings)).not.toContain('geosite_data_paths')
    expect(back.blocklists.file).toBe(BLOCKLIST_OLD)
  })

  it('JSON 视图里改了一条规则：别的规则、组、映射、其余请求都还是原来的那份', () => {
    const m = sampleModel()
    const back = jsonEditElsewhere(m).model
    const untouched = (x: Model) => ({ ...x, rules: x.rules.filter((r) => r.name !== '公司内网'), settings: {} })
    expect(untouched(back)).toEqual(untouched(m))
  })

  it('JSON 视图里给规则改了名字：编号、备注、改动时间跟着这条规则走', () => {
    const m = sampleModel()
    const firefox = ruleNamed(m, '火狐 DoH 探测')!
    // 没起名字的规则在内核里叫 rule-编号，在 JSON 里给它起了名字也一样 / An unnamed rule is rule-<id> in the kernel; naming it in the JSON is a rename too
    const unnamed = ruleNamed(m, '版本查询')!
    unnamed.name = ''
    unnamed.note = '给 dig version.bind 一个固定回答'
    const k = clone(compile(m)) as KernelConfig
    const main = k.pipelines.find((p) => p.id === 'main')!
    main.rules.find((r) => r.name === '火狐 DoH 探测')!.name = '火狐探测'
    main.rules.find((r) => r.name === `rule-${unnamed.id}`)!.name = '版本'
    const back = readConfig(k as unknown as Record<string, unknown>, m).model
    expect(ruleNamed(back, '火狐探测')).toEqual({ ...firefox, name: '火狐探测' })
    expect(ruleNamed(back, '版本')).toEqual({ ...unnamed, name: '版本' })
  })

  // 认改名不只看同一位置：除了名字编出来一样的，在列表里哪儿都认；只差名字的有好几条时才按位置挑
  // A rename is not found at the same place only: one that compiles alike but for the name is found anywhere in the list; only when several
  // differ in the name alone does the place decide
  it('JSON 视图里给规则改了名字、又挪了位置：编号、备注、改动时间照样跟着它', () => {
    const m = sampleModel()
    const firefox = ruleNamed(m, '火狐 DoH 探测')!
    const k = clone(compile(m)) as KernelConfig
    const main = k.pipelines.find((p) => p.id === 'main')!
    const [moved] = main.rules.splice(main.rules.findIndex((r) => r.name === firefox.name), 1)
    main.rules.unshift({ ...moved!, name: '火狐探测' })
    const back = readConfig(k as unknown as Record<string, unknown>, m).model
    expect(back.rules[0]).toEqual({ ...firefox, name: '火狐探测' })
    expect(back.rules.filter((r) => r.id === firefox.id).length).toBe(1)
  })

  it('只差名字的几条一起改了名：按位置认，编号不串', () => {
    const m = sampleModel()
    const a = addRule(m, '甲', { type: 'block', response: 'NXDOMAIN' }, 'twin.example')
    const b = addRule(m, '乙', { type: 'block', response: 'NXDOMAIN' }, 'twin.example')
    const back = editKernel(m, (k) => {
      const main = k.pipelines.find((p) => p.id === 'main')!
      main.rules.find((r) => r.name === '甲')!.name = '甲二'
      main.rules.find((r) => r.name === '乙')!.name = '乙二'
    })
    expect([ruleNamed(back, '甲二')!.id, ruleNamed(back, '乙二')!.id]).toEqual([a.id, b.id])
  })

  it('只差名字的两条：删了前一条、改了后一条的名字，后一条按位置认回自己的编号', () => {
    const m = sampleModel()
    const a = addRule(m, '甲', { type: 'block', response: 'NXDOMAIN' }, 'twin.example')
    const b = addRule(m, '乙', { type: 'block', response: 'NXDOMAIN' }, 'twin.example')
    const back = editKernel(m, (k) => {
      const main = k.pipelines.find((p) => p.id === 'main')!
      const at = main.rules.findIndex((r) => r.name === '甲')
      main.rules[at] = { ...main.rules[at]!, name: '新的', matchers: [{ type: 'domain_suffix', value: 'new.example', operator: 'and' }] }
      main.rules.find((r) => r.name === '乙')!.name = '乙二'
    })
    expect(ruleNamed(back, '乙二')!.id).toBe(b.id)
    expect(back.rules.some((r) => r.id === a.id)).toBe(false)
  })

  it('启用的和停用的只差名字：JSON 里给启用的改名、挪位置，认回的是启用的那条，停用的照旧停用', () => {
    const m = sampleModel()
    const off = addRule(m, '停用的', { type: 'block', response: 'NXDOMAIN' }, 'same.example', (r) => { r.enabled = false })
    const on = addRule(m, '启用的', { type: 'block', response: 'NXDOMAIN' }, 'same.example')
    const back = editKernel(m, (k) => {
      const main = k.pipelines.find((p) => p.id === 'main')!
      const [moved] = main.rules.splice(main.rules.findIndex((r) => r.name === on.name), 1)
      main.rules.unshift({ ...moved!, name: '改了名的' })
    })
    expect(back.rules[0]).toEqual({ ...on, name: '改了名的' })
    expect(back.rules.find((r) => r.id === off.id)).toEqual(off)
  })

  it('几条停用的只差名字：JSON 里加回来哪一条，启用的就是名字（没名字的按编号）对得上的那条', () => {
    const m = sampleModel()
    const x = addRule(m, '甲停用', { type: 'block', response: 'NXDOMAIN' }, 'off.example', (r) => { r.enabled = false })
    const y = addRule(m, '乙停用', { type: 'block', response: 'NXDOMAIN' }, 'off.example', (r) => { r.enabled = false })
    const u = addRule(m, '', { type: 'block', response: 'REFUSED' }, 'off.example', (r) => { r.enabled = false })
    const v = addRule(m, '', { type: 'block', response: 'REFUSED' }, 'off.example', (r) => { r.enabled = false })
    const enabled = (ids: number[]) => ({ ...m, rules: m.rules.map((r) => (ids.includes(r.id) ? { ...r, enabled: true } : r)) })
    const back = readConfig(clone(compile(enabled([y.id, v.id]))) as unknown as Record<string, unknown>, m).model
    expect([x, y, u, v].map((r) => back.rules.find((b) => b.id === r.id)!.enabled)).toEqual([false, true, false, true])
    expect(back.rules.length).toBe(m.rules.length)
  })

  it('名字和内容都改了：是一条新规则', () => {
    const m = sampleModel()
    const firefox = ruleNamed(m, '火狐 DoH 探测')!
    const back = editKernel(m, (k) => {
      const main = k.pipelines.find((p) => p.id === 'main')!
      const r = main.rules.find((x) => x.name === firefox.name)!
      r.name = '火狐探测'
      r.matchers[0]!.value = 'use-application-dns.example'
    })
    expect(ruleNamed(back, '火狐探测')!.id).not.toBe(firefox.id)
    expect(ruleNamed(back, '火狐探测')!.note).toBe('')
  })

  // 停用的规则编出来什么都没有：JSON 里把它（照它启用时编出来的样子）加回来，就是启用了它，和停用的映射一样
  // A disabled rule compiles to nothing: added back in the JSON (as it compiles when enabled) it was enabled, as with a disabled mapping
  it('JSON 里把停用着的规则加回来：就是启用了它，编号、备注、位置照旧，不多出一条', () => {
    const m = sampleModel()
    const old = m.rules.find((r) => !r.enabled)!
    old.note = '供应商已经下线'
    const enabled = { ...m, rules: m.rules.map((r) => (r === old ? { ...r, enabled: true } : r)) }
    const back = readConfig(clone(compile(enabled)) as unknown as Record<string, unknown>, m).model
    expect(back.rules).toEqual(enabled.rules)
  })

  it('JSON 里把停用着的规则换了名字加回来：启用它，名字用新的', () => {
    const m = sampleModel()
    const old = m.rules.find((r) => !r.enabled)!
    const k = clone(compile({ ...m, rules: m.rules.map((r) => (r === old ? { ...r, enabled: true } : r)) }))
    k.pipelines.find((p) => p.id === 'main')!.rules.find((r) => r.name === old.name)!.name = '统计接口'
    const back = readConfig(k as unknown as Record<string, unknown>, m).model
    expect(back.rules.filter((r) => r.id === old.id)).toEqual([{ ...old, enabled: true, name: '统计接口' }])
    expect(back.rules.length).toBe(m.rules.length)
  })

  // 中文域名写进内核是 punycode：读回来按编出来的样子认，页面上还是写的中文 / A Chinese name reaches the kernel as punycode: read back it is
  // matched by what it compiles to, and the page still shows the Chinese
  it('中文域名的规则和映射：系统写入、JSON 里改了别处，读回来还是写的中文', () => {
    for (const read of [geoSync, jsonEditElsewhere]) {
      const m = sampleModel()
      const r = addRule(m, '中文站', { type: 'block', response: 'NXDOMAIN' }, '中文.example')
      const unnamed = addRule(m, '', { type: 'block', response: 'REFUSED' }, '例子.测试')
      m.mappings.push({ id: nextId(m), domain: '例子.测试', target: '192.168.1.20', ttl: null, enabled: true })
      const back = read(m).model
      expect(ruleNamed(back, '中文站')).toEqual(r)
      expect(back.rules.find((x) => x.id === unnamed.id)).toEqual(unnamed)
      expect(back.mappings).toEqual(m.mappings)
    }
  })

  it('高级规则后面那条在 JSON 里改了名字：编号、备注照样跟着它', () => {
    const m = sampleModel()
    // 内核规则里多一个认不出的字段：读进来是高级规则，原样写回 / An unknown field in the kernel rule: read in as an advanced rule and written back verbatim
    const odd = newRule(nextId(m), { type: 'continue' })
    odd.raw = [{ name: '手写的', matchers: [{ type: 'domain_suffix', value: 'odd.example', operator: 'and' }], matcher_operator: 'and', actions: [{ type: 'deny' }], comment: '手写' }]
    m.rules.unshift(odd)
    const firefox = ruleNamed(m, '火狐 DoH 探测')!
    const k = clone(compile(m)) as KernelConfig
    k.pipelines.find((p) => p.id === 'main')!.rules.find((r) => r.name === firefox.name)!.name = '火狐探测'
    const back = readConfig(k as unknown as Record<string, unknown>, m).model
    expect(ruleNamed(back, '火狐探测')).toEqual({ ...firefox, name: '火狐探测' })
  })

  it('高级规则在 JSON 里改了名字：编号、备注跟着它，写回去是新名字', () => {
    const m = sampleModel()
    const odd = newRule(nextId(m), { type: 'continue' })
    odd.raw = [{ name: '手写的', matchers: [{ type: 'domain_suffix', value: 'odd.example', operator: 'and' }], matcher_operator: 'and', actions: [{ type: 'deny' }], comment: '手写' }]
    odd.note = '手写的规则'
    m.rules.unshift(odd)
    const back = editKernel(m, (k) => { k.pipelines.find((p) => p.id === 'main')!.rules.find((r) => r.name === '手写的')!.name = '手写改名' })
    expect(back.rules.find((r) => r.id === odd.id)).toMatchObject({ name: '手写改名', note: '手写的规则' })
    expect(compile(back).pipelines.find((p) => p.id === 'main')!.rules.map((r) => r.name)).toContain('手写改名')
  })

  it('重名的两条在 JSON 里改掉一条的名字：另一条在内核里的名字跟着变回自己的名字，意思照旧', () => {
    const m = sampleModel()
    // 两条都叫「不检查」，内核里都是 rule-编号 / Both are called 不检查, so both are rule-<id> in the kernel
    const a = addRule(m, '不检查', { type: 'upstream', group: 'router' }, 'a.lan.example', (r) => { r.response = { ...r.response, mode: 'off' } })
    const b = addRule(m, '不检查', { type: 'upstream', group: 'router' }, 'b.lan.example', (r) => { r.response = { ...r.response, mode: 'off' } })
    const k = clone(compile(m)) as KernelConfig
    k.pipelines.find((p) => p.id === 'main')!.rules.find((r) => r.name === `rule-${a.id}`)!.name = '甲不检查'
    const back = readConfig(k as unknown as Record<string, unknown>, m).model
    expect(back.rules.find((r) => r.id === a.id)).toEqual({ ...a, name: '甲不检查' })
    expect(back.rules.find((r) => r.id === b.id)).toEqual(b)
  })
})

describe('重新读入的保护：只有编出来逐项一样才留上一份 / the guard: the previous form stays only when it compiles to exactly the same', () => {
  it('JSON 里把拦截列表的文件从 GeoSite 里删了：不把剩下的 Geo 文件当成拦截列表的文件', () => {
    const m = sampleModel()
    m.blocklists = { subscriptions: [{ id: nextId(m), name: 'OISD big', url: 'https://big.oisd.nl/', enabled: true }], file: BLOCKLIST_OLD, custom: '', builtFor: 'https://big.oisd.nl/' }
    const k = clone(compile(m))
    k.settings.geosite_data_paths = (k.settings.geosite_data_paths as string[]).filter((p) => p !== BLOCKLIST_OLD)
    const back = readConfig(k as unknown as Record<string, unknown>, m)
    expect(back.source).toBe('imported')
    expect(back.model.blocklists.file).toBeNull()
    expect(back.model.settings.geosite_data_paths).toEqual(m.settings.geosite_data_paths)
  })

  it('JSON 里把默认上游改成别的：编出来对不上，按内核部分重新导入', () => {
    const m = sampleModel()
    const k = clone(compile(m))
    k.settings.default_upstream = '9.9.9.9:53'
    expect(readConfig(k as unknown as Record<string, unknown>, m).source).toBe('imported')
  })

  it('JSON 里改了规则的条件：这条规则按内核里现在的样子读，不留上一份', () => {
    const m = sampleModel()
    const back = jsonEditElsewhere(m).model
    expect(ruleNamed(back, '公司内网')!.conditions[0]![0]!.values).toEqual(['corp.example.net', 'corp.internal'])
  })

  const forwardOf = (k: KernelConfig, id: string) => k.pipelines.find((p) => p.id === id)!.rules[0]!.actions[0]! as Record<string, unknown>

  it('JSON 里给上游组加了地址：这个组按内核里现在的样子读', () => {
    const back = editKernel(sampleModel(), (k) => { forwardOf(k, 'upstream-router').upstream = '192.168.1.1:53, 192.168.1.2:53' })
    expect(back.groups.find((g) => g.id === 'router')!.addresses).toEqual([{ address: '192.168.1.1:53', protocol: 'auto' }, { address: '192.168.1.2:53', protocol: 'auto' }])
  })

  it('JSON 里改了规则自己那个转发的子网：这条规则按内核里现在的子网读', () => {
    const m = sampleModel()
    const apple = ruleNamed(m, '苹果服务')!
    const back = editKernel(m, (k) => {
      const own = k.pipelines.find((p) => p.id === `rule-${apple.id}`)!
      const ecs = { mode: 'from_client_ip', prefix_v4: 24, prefix_v6: 64 }
      own.ecs = ecs
      forwardOf(k, own.id).ecs = ecs
    })
    expect(ruleNamed(back, '苹果服务')!.ecs).toEqual({ mode: 'client', v4: 24, v6: 64 })
  })

  it('JSON 里把上游组的 Pipeline 改成了规则列表：指向它的规则读成转到规则组，不留着指向已经没有的组', () => {
    const m = sampleModel()
    addRule(m, '交给路由器', { type: 'upstream', group: 'router' }, 'r.lan.example')
    const back = editKernel(m, (k) => {
      const router = k.pipelines.find((p) => p.id === 'upstream-router')!
      const rule = (name: string, matchers: { type: string; value: string; operator: string }[], rcode: string) => ({ ...router.rules[0]!, name, matchers, actions: [{ type: 'static_response', rcode }], response_matchers: [], response_actions_on_match: [] })
      router.rules = [rule('路由器拦一个', [{ type: 'domain_suffix', value: 'x.lan', operator: 'and' }], 'NXDOMAIN'), rule('路由器其余', [], 'REFUSED')]
    })
    expect(back.groups.some((g) => g.id === 'router')).toBe(false)
    expect(ruleNamed(back, '交给路由器')!.outcome.type).toBe('group')
  })

  // 编出来不止一个的 Pipeline 名字：内核遇到同名的 Pipeline 整份配置都不收 / Pipeline ids compiled more than once: the kernel refuses a config
  // holding two pipelines of one id
  const repeatedPipelines = (m: Model) => { const ids = compile(m).pipelines.map((p) => p.id); return ids.filter((id, i) => ids.indexOf(id) !== i) }

  it('JSON 里把上游组的 Pipeline 改成了规则列表、里面照旧转发到原来的地址：为这个转发整理出的组不和这个规则列表同名', () => {
    const m = sampleModel()
    addRule(m, '交给路由器', { type: 'upstream', group: 'router' }, 'r.lan.example')
    const back = editKernel(m, (k) => {
      const router = k.pipelines.find((p) => p.id === 'upstream-router')!
      const forward = router.rules[0]!
      router.rules = [
        { ...forward, name: '路由器拦一个', matchers: [{ type: 'domain_suffix', value: 'x.lan', operator: 'and' }], actions: [{ type: 'static_response', rcode: 'NXDOMAIN' }] },
        { ...forward, name: '路由器其余' },
      ]
    })
    expect(repeatedPipelines(back)).toEqual([])
    // 规则列表的其余请求照旧交给 192.168.1.1:53 / The list's catch-all still goes to 192.168.1.1:53
    const list = back.ruleGroups.find((g) => g.pipelineId === 'upstream-router')!
    const rest = list.rest as Extract<Outcome, { type: 'upstream' }>
    expect(back.groups.find((g) => g.id === rest.group)!.addresses).toEqual([{ address: '192.168.1.1:53', protocol: 'auto' }])
  })

  it('JSON 里加了一个 upstream-router、原来的路由器组的 Pipeline 另有名字：两个组编号不同，路由器还是原来的编号', () => {
    const m = sampleModel()
    m.groups.find((g) => g.id === 'router')!.pipelineId = 'lan-dns'
    const back = editKernel(m, (k) => {
      const lan = k.pipelines.find((p) => p.id === 'lan-dns')!
      // 排在最前，比原来那个组先读到 / First in the list, read before the original group
      k.pipelines.unshift({ id: 'upstream-router', rules: [{ ...clone(lan.rules[0]!), name: 'upstream-router', actions: [{ type: 'forward', upstream: '192.168.1.2:53' }] }] })
    })
    expect(repeatedPipelines(back)).toEqual([])
    const ids = back.groups.map((g) => g.id)
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
    expect(back.groups.find((g) => g.id === 'router')!.pipelineId).toBe('lan-dns')
  })

  it('上一份里国外组的 Pipeline 叫 upstream-dns-google：JSON 里新写的、只问 dns.google 的转发整理出的组不和它同名', () => {
    const m = sampleModel()
    m.groups.find((g) => g.id === 'abroad')!.pipelineId = 'upstream-dns-google'
    const back = editKernel(m, (k) => {
      const main = k.pipelines.find((p) => p.id === 'main')!
      main.rules.unshift({ ...clone(main.rules[0]!), name: '只问谷歌', matchers: [{ type: 'domain_suffix', value: 'g.example', operator: 'and' }], actions: [{ type: 'forward', upstream: 'https://dns.google/dns-query' }] })
    })
    expect(repeatedPipelines(back)).toEqual([])
    expect(back.groups.find((g) => g.id === 'abroad')!.pipelineId).toBe('upstream-dns-google')
  })

  it('JSON 里把规则自己那个转发写回规则里、原来的 rule-编号 留着：留下的那个读成上游组，规则不再用这个编号', () => {
    const m = sampleModel()
    const apple = ruleNamed(m, '苹果服务')!
    const back = editKernel(m, (k) => {
      const own = k.pipelines.find((p) => p.id === `rule-${apple.id}`)!.rules[0]!
      for (const r of k.pipelines.find((p) => p.id === 'main')!.rules.filter((x) => x.name.replace(/#\d+$/, '') === '苹果服务')) {
        Object.assign(r, { actions: own.actions, response_matchers: own.response_matchers, response_matcher_operator: own.response_matcher_operator, response_actions_on_match: own.response_actions_on_match, response_actions_on_miss: own.response_actions_on_miss })
      }
    })
    expect(repeatedPipelines(back)).toEqual([])
    expect(back.groups.some((g) => g.pipelineId === `rule-${apple.id}`)).toBe(true)
    // 名字和备注照旧跟着这条规则 / Its name and note still come along
    expect(ruleNamed(back, '苹果服务')!.note).toBe(apple.note)
  })

  it('JSON 里手写了一个和某条规则同编号的 rule-编号：这条规则不再用这个编号，以后单独设子网也不撞名', () => {
    const m = sampleModel()
    const corp = ruleNamed(m, '公司内网')!
    const back = editKernel(m, (k) => {
      const forward = { ...k.pipelines.find((p) => p.id === 'upstream-router')!.rules[0]!, name: `rule-${corp.id}`, actions: [{ type: 'forward', upstream: '192.168.1.2:53' }] }
      k.pipelines.push({ id: `rule-${corp.id}`, rules: [forward] })
    })
    expect(back.groups.some((g) => g.pipelineId === `rule-${corp.id}`)).toBe(true)
    // 读回来以后在编辑器里给它单独设子网：它自己的转发 Pipeline 和留下的那个不同名 / Given its own subnet in the editor after the read: its own
    // forward pipeline is not named like the one kept
    ruleNamed(back, '公司内网')!.ecs = { mode: 'client', v4: 24, v6: 56 }
    expect(repeatedPipelines(back)).toEqual([])
    expect(ruleNamed(back, '公司内网')!.note).toBe(corp.note)
  })

  it('JSON 里删了一条、又加了一条和后面那条只差名字的：加的那条是新规则，不顶替已经认回来的那条', () => {
    const m = sampleModel()
    const a = addRule(m, '甲', { type: 'block', response: 'NXDOMAIN' }, 'a.block.example')
    const b = addRule(m, '乙', { type: 'block', response: 'NXDOMAIN' }, 'b.block.example')
    const back = editKernel(m, (k) => {
      const main = k.pipelines.find((p) => p.id === 'main')!
      const at = main.rules.findIndex((r) => r.name === a.name)
      main.rules.splice(at, 1)
      main.rules.splice(at + 1, 0, { ...clone(main.rules[at]!), name: '丙' })
    })
    expect(ruleNamed(back, '乙')!.id).toBe(b.id)
    expect(ruleNamed(back, '丙')!.id).not.toBe(b.id)
    const ids = back.rules.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('JSON 里改了映射的目标：这条映射按内核里现在的目标读', () => {
    const back = editKernel(sampleModel(), (k) => {
      const nas = k.pipelines.find((p) => p.id === 'domain_mapping')!.rules.find((r) => r.name === '域名映射 nas.home.arpa')!
      nas.actions = [{ type: 'static_ip_response', ip: '192.168.1.11' }]
    })
    expect(back.mappings.find((x) => x.domain === 'nas.home.arpa')!.target).toBe('192.168.1.11')
  })
})
