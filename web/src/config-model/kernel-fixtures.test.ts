import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { actionFieldErrors, matcherFieldErrors } from '../config-editor/field-validation'
import { createAction, kernelRuleOf } from '../config-editor/model'
import { ACTION_TYPES, MATCHER_DEFINITIONS } from '../config-editor/schema'
import type { MatcherConfig, RuleConfig } from '../config-editor/types'
import {
  addressProblem, compile, emptyBlocklists, FIELD, inheritResponse, newRule, RESPONSE_FIELD, ruleProblems, type Condition, type ConditionField, type Ecs, type KernelConfig, type Model,
  type Outcome, type Protocol, type Remedy, type ResponseCondition, type ResponseField, type Rule,
} from './model'
import { generateModel } from './testing/generate'
import { refuseUnknownTypes, type KConfigLike } from './testing/kernel-sim'
import { demoModel, sampleModel } from './testing/samples'

// 交给真内核校验的配置：示例配置、每一种条件和结果、每一种上游写法、高级规则编辑器里每一种类型，再加按种子生成的一批。CI 里设了
// KERNEL_FIXTURES 时写成一个 JSON 数组，tools/kernel-config-check 拿最新的内核（main）的 config::validate 逐份校验，有一份不收就失败。
// 面板和测试用的执行器（testing/kernel-sim.ts）都是照内核写的，两边一起写错时只有真内核看得出来（回答条件的 GeoSite 类型名就是这样漏掉的）
// Configs handed to the real kernel: the samples, every condition and outcome kind, every way of writing an upstream, every type of the
// advanced rule editor, and a seeded batch. With KERNEL_FIXTURES set (in CI) they are written as one JSON array, which
// tools/kernel-config-check validates one by one with the latest kernel's (main) config::validate, failing on any refusal. The panel and the
// test executor (testing/kernel-sim.ts) are both written after the kernel, and when they share a mistake only the real kernel can tell
// (the answer check's GeoSite type name slipped through so)

const SEEDS = Number(process.env.KERNEL_FIXTURE_SEEDS ?? 200)
const SETTINGS = { bind_udp: '127.0.0.1:5353' }
interface Fixture { name: string; config: KernelConfig | Record<string, unknown> }

// 每个字段一个内核认的值；不填值的字段为空 / One kernel-accepted value per field; empty for fields without values
const REQUEST_VALUE: Record<ConditionField, (o: { regex?: boolean; exact?: boolean }) => string[]> = {
  domain: (o) => (o.regex ? ['^ads\\.'] : o.exact ? ['api.example.com'] : ['example.com', '中文.example']),
  geosite: () => ['cn'], client_ip: () => ['192.168.1.0/24', '10.0.0.5'], client_country: () => ['CN', 'HK'], client_private: () => [],
  qtype: () => ['A', 'AAAA'], qclass: () => ['IN'], edns: () => [],
}
const RESPONSE_VALUE: Record<ResponseField, (o: { regex?: boolean; exact?: boolean; txtMode?: string }) => string[]> = {
  rcode: () => ['SERVFAIL'], answer_ip: () => ['0.0.0.0/32', '240.0.0.0/4'], answer_country: () => ['CN'], answer_private: () => [], answer_type: () => ['A'],
  upstream: () => ['10.0.0.53:53'], upstream_ip: () => ['10.0.0.0/8'], request_domain: (o) => (o.regex ? ['^ads\\.'] : o.exact ? ['api.example.com'] : ['example.com']),
  request_geosite: () => ['cn'], txt: (o) => (o.txtMode === 'regex' ? ['^v=spf1'] : ['v=spf1']), qclass: () => ['IN'], edns: () => [],
}

function base(rules: Rule[], patch: Partial<Model> = {}): Model {
  const m = sampleModel()
  return { ...m, settings: SETTINGS, rules: [...rules, ...m.rules], ...patch }
}
let next = 900_000
const id = () => next++
const blockRule = (name: string, conditions: Condition[][], outcome: Outcome = { type: 'block', response: 'NXDOMAIN' }): Rule => ({ ...newRule(id(), outcome), name, conditions })
const probe = (): Condition[][] => [[{ id: id(), field: 'domain', negate: false, regex: false, values: ['probe.example'] }]]
const checked = (name: string, match: 'all' | 'any', conditions: ResponseCondition[], then: Remedy = { type: 'block', response: 'REFUSED' }, otherwise: Remedy = { type: 'none' }): Rule => ({
  ...blockRule(name, probe(), { type: 'upstream', group: 'abroad' }), response: { mode: 'custom', match, conditions, then, otherwise },
})

function conditionKinds(): Model {
  const rules: Rule[] = []
  for (const [field, def] of Object.entries(FIELD) as [ConditionField, (typeof FIELD)[ConditionField]][]) {
    for (const op of def.ops) rules.push(blockRule(`条件 ${field} ${op.value}`, [[{ id: id(), field, negate: op.negate, regex: op.regex, exact: op.exact, values: REQUEST_VALUE[field](op) }]]))
  }
  // 两组「或」、一组里几个多值条件（拆成几条） / Two OR groups, and one group with several multi-valued conditions (split into several)
  rules.push(blockRule('两组', [[{ id: id(), field: 'domain', negate: false, values: ['a.example', 'b.example'] }], [{ id: id(), field: 'qtype', negate: false, values: ['A', 'AAAA'] }, { id: id(), field: 'client_ip', negate: true, values: ['10.0.0.0/8', '192.168.1.0/24'] }]]))
  rules.push(blockRule('几个多值', [[{ id: id(), field: 'domain', negate: false, values: ['a.example', 'b.example'] }, { id: id(), field: 'qtype', negate: false, values: ['A', 'AAAA'] }, { id: id(), field: 'geosite', negate: true, values: ['cn', 'google'] }]]))
  return base(rules)
}

function responseKinds(): Model {
  const rules: Rule[] = []
  for (const [field, def] of Object.entries(RESPONSE_FIELD) as [ResponseField, (typeof RESPONSE_FIELD)[ResponseField]][]) {
    for (const op of def.ops) {
      const c = (): ResponseCondition => ({ id: id(), field, negate: op.negate, regex: op.regex, exact: op.exact, txtMode: op.txtMode, values: RESPONSE_VALUE[field](op).slice(0, op.negate ? 1 : undefined) })
      rules.push(checked(`回答 ${field} ${op.value} 全部`, 'all', [c()]))
      rules.push(checked(`回答 ${field} ${op.value} 任一`, 'any', [c(), { id: id(), field: 'rcode', negate: false, values: ['NXDOMAIN'] }]))
    }
  }
  // 「全部满足」里一个条件填几个值、全是「不是」的「全部」和「任一」 / 「全部满足」 with one multi-valued condition, all-negated 全部 and 任一
  rules.push(checked('全部 多值', 'all', [{ id: id(), field: 'request_domain', negate: false, values: ['a.example', 'b.example'] }, { id: id(), field: 'answer_private', negate: false, values: [] }]))
  rules.push(checked('全部 全否', 'all', [{ id: id(), field: 'rcode', negate: true, values: ['NOERROR', 'NXDOMAIN'] }, { id: id(), field: 'request_geosite', negate: true, values: ['cn'] }]))
  rules.push(checked('任一 全否', 'any', [{ id: id(), field: 'rcode', negate: true, values: ['NOERROR'] }, { id: id(), field: 'answer_country', negate: true, values: ['CN'] }]))
  return base(rules)
}

function outcomeKinds(): Model {
  const outcomes: Outcome[] = [
    { type: 'upstream', group: 'cn' }, ...(['default', 'NXDOMAIN', 'REFUSED', 'SERVFAIL', 'NOERROR', 'zero'] as const).map((response): Outcome => ({ type: 'block', response })),
    { type: 'answer', kind: 'ip', value: '192.168.1.10, fd00::10', ttl: null }, { type: 'answer', kind: 'cname', value: 'target.example', ttl: null }, { type: 'answer', kind: 'cname', value: 'nas.home.arpa.', ttl: 600 },
    { type: 'answer', kind: 'txt', value: 'kixdns', ttl: null }, { type: 'answer', kind: 'txt', value: '中文 TXT', ttl: 3600 }, { type: 'group', group: 'lan' }, { type: 'continue' },
  ]
  const rules = outcomes.map((o, i) => ({ ...blockRule(`结果 ${i}`, probe(), o), log: { enabled: i % 2 === 0, level: (['info', 'debug', 'warn', 'error', 'trace'] as const)[i % 5]! } }))
  const remedies: Remedy[] = [
    { type: 'none' }, { type: 'rewrite_txt', value: 'v=spf1 -all' }, { type: 'upstream', group: 'cn' }, { type: 'block', response: 'default' }, { type: 'block', response: 'zero' },
    { type: 'answer', kind: 'ip', value: '0.0.0.0', ttl: null }, { type: 'answer', kind: 'cname', value: 'target.example', ttl: 60 }, { type: 'answer', kind: 'txt', value: 'x', ttl: null }, { type: 'group', group: 'lan' },
  ]
  for (const [i, then] of remedies.entries()) {
    const r = checked(`回答后 ${i}`, 'any', [{ id: id(), field: 'rcode', negate: false, values: ['SERVFAIL'] }], then, remedies[(i + 3) % remedies.length]!)
    r.response.thenLog = i % 2 ? 'warn' : null
    r.response.otherwiseLog = i % 3 ? null : 'info'
    rules.push(r)
  }
  // 客户端子网：沿用、不处理、不发送、按客户端、固定 / Client subnet: inherit, leave alone, clear, from client, static
  for (const [i, ecs] of (['inherit', null, { mode: 'clear' }, { mode: 'client', v4: 24, v6: 56 }, { mode: 'static', subnet: '203.0.113.0/24' }] as (Ecs | 'inherit')[]).entries()) {
    rules.push({ ...blockRule(`子网 ${i}`, probe(), { type: 'upstream', group: 'router' }), ecs })
  }
  rules.push({ ...blockRule('不检查', probe(), { type: 'upstream', group: 'cn' }), response: { ...inheritResponse(), mode: 'off' } })
  return base(rules)
}

// 每一种协议、写端口和不写端口的、备用的两种 / Every protocol, with and without a port, both kinds of fallback
function upstreamKinds(): Model {
  const addresses: [Protocol, string][] = [
    ['auto', '223.5.5.5'], ['auto', '223.5.5.5:53'], ['auto', '2400:3200::1'], ['auto', '[2400:3200::1]:5353'], ['udp', '119.29.29.29'], ['tcp', '119.29.29.29'], ['tcp', 'dns.example'],
    ['tcp_udp', '223.6.6.6'], ['tcp_udp', '[2400:3200::1]'], ['auto', 'tcp://dns.example'], ['auto', 'tcp+udp://223.5.5.5'], ['auto', 'udp://1.1.1.1'], ['doh', 'dns.alidns.com/dns-query'],
    ['auto', 'https://dns.google/dns-query'], ['dot', 'dns.alidns.com'], ['auto', 'tls://1.1.1.1?sni=cloudflare-dns.com'], ['doq', 'dns.alidns.com'], ['auto', 'quic://dns.alidns.com:853'],
  ]
  const m = base([])
  m.groups = [
    ...m.groups,
    ...addresses.map(([protocol, address], i) => ({ id: `p${i}`, name: `协议 ${i}`, addresses: [{ address, protocol }], ecs: null, fallback: { group: 'abroad', onError: i % 2 === 0, onPolluted: i % 3 === 0 } })),
  ]
  m.rules = [...m.groups.slice(4).map((g, i) => blockRule(`转发 ${i}`, probe(), { type: 'upstream', group: g.id })), ...m.rules]
  m.rest = { type: 'upstream', group: 'p0' }
  return m
}

function blocklistKinds(): Model[] {
  return (['NXDOMAIN', 'REFUSED', 'zero'] as const).map((block) => base([], {
    defaults: { block },
    blocklists: { ...emptyBlocklists(), subscriptions: [{ id: id(), name: '广告', url: 'https://lists.example/ads.txt', enabled: true }], builtFor: 'https://lists.example/ads.txt',
      file: `/var/lib/kixdns-panel/geo/blocklist-${'d'.repeat(64)}.json`, custom: '||ads.example^\n@@||ok.ads.example^\n/^track[0-9]+\\./\n||中文广告.example^' },
  }))
}

// 其余请求拦截时，设置里照写的默认上游（没写端口的写进内核时补上 53） / With 其余请求 blocking, the default upstream as written in the settings (a
// missing port takes 53 when written to the kernel)
const restBlocks = (): Model => base([], { rest: { type: 'block', response: 'default' }, settings: { ...SETTINGS, default_upstream: '9.9.9.9, tcp://dns.example, 2400:3200::1' } })

// 高级规则编辑器（config-editor/schema.ts）里能选的每一种类型，填上它要的字段：编辑器写出来的类型名内核得认
// Every type the advanced rule editor (config-editor/schema.ts) offers, with the fields it takes: the type names the editor writes must be
// ones the kernel knows
function advancedKinds(): Model {
  const field = (f: string): Record<string, unknown> => (f === 'cidr' ? { cidr: '10.0.0.0/8' } : f === 'country_codes' ? { country_codes: ['CN'] } : f === 'expect' ? { expect: true } : f === 'mode' ? { mode: 'exact' } : { value: 'cn' })
  const matcher = (type: string, fields: readonly string[]) => Object.assign({ type }, ...fields.map(field)) as Record<string, unknown>
  const actions: Record<string, Record<string, unknown>> = {
    log: { level: 'info' }, static_response: { rcode: 'NXDOMAIN' }, static_ip_response: { ip: '192.168.1.10' }, static_cname_response: { target: 'target.example', ttl: 60 },
    static_txt_response: { text: ['kixdns'] }, replace_txt_response: { text: ['v=spf1 -all'] }, jump_to_pipeline: { pipeline: 'group-lan' }, forward: { upstream: '1.1.1.1:53' },
  }
  const raw = (name: string, rule: Record<string, unknown>): Rule => ({ ...newRule(id(), { type: 'continue' }), name, raw: [{ name, matchers: [], actions: [{ type: 'deny' }], ...rule }] })
  const rules = [
    ...MATCHER_DEFINITIONS.request.map((d) => raw(`请求 ${d.value}`, { matchers: [{ ...matcher(d.value, d.fields), ...(d.value === 'domain_regex' ? { value: '^ads\\.' } : d.value.startsWith('domain') ? { value: 'example.com' } : d.value === 'qtype' ? { value: 'A' } : d.value === 'qclass' ? { value: 'IN' } : {}) }] })),
    ...MATCHER_DEFINITIONS.response.map((d) => raw(`回答 ${d.value}`, {
      actions: [{ type: 'forward', upstream: '1.1.1.1:53' }], response_actions_on_match: [{ type: 'deny' }],
      response_matchers: [{ ...matcher(d.value, d.fields), ...(d.value === 'request_domain_regex' ? { value: '^ads\\.' } : d.value.startsWith('request_domain') ? { value: 'example.com' } : d.value === 'response_type' ? { value: 'A' } : d.value === 'response_rcode' ? { value: 'SERVFAIL' } : d.value === 'response_qclass' ? { value: 'IN' } : d.value === 'upstream_equals' ? { value: '1.1.1.1:53' } : d.value === 'response_txt_content' ? { value: 'v=spf1' } : {}) }],
    })),
    ...ACTION_TYPES.map((d) => raw(`动作 ${d.value}`, { matchers: [{ type: 'domain_suffix', value: `${d.value.replace(/_/g, '-')}.example` }], actions: [{ type: d.value, ...actions[d.value] }] })),
    ...[...FORWARDS, ...LENIENT].map(([name, rule]) => raw(name, { matchers: [{ type: 'domain_suffix', value: `${name}.example` }], ...rule })),
  ]
  const m = base(rules)
  m.entries = MATCHER_DEFINITIONS.selector.map((d) => ({ pipeline: 'group-lan', matchers: [{ ...matcher(d.value, d.fields), ...(d.value === 'listener_label' ? { value: 'lan' } : d.value === 'domain_regex' ? { value: '^ads\\.' } : d.value.startsWith('domain') ? { value: 'example.com' } : d.value === 'qtype' ? { value: 'A' } : d.value === 'qclass' ? { value: 'IN' } : {}) }] }))
  return m
}

// 高级规则里的转发：不写上游（问默认上游，经它自己的 transport）、几个转发合并（没写上游的也在里面）、回答后不写上游的，和表单新加一个转发、
// 上游和协议都空着时写出去的样子（kernelRuleOf）
// Forwards in advanced rules: writing no upstream (the default upstream asked over its own transport), several merged (one writing none
// among them), one in the answer phase writing none, and what the form writes for a new forward with upstream and transport left empty
// (kernelRuleOf)
function formForward(): Record<string, unknown> {
  const rule: RuleConfig = { name: 'form', matchers: [], matcher_operator: 'and', actions: [createAction('forward'), createAction('forward')], response_matchers: [], response_matcher_operator: 'and', response_actions_on_match: [], response_actions_on_miss: [] }
  rule.actions[1]!.upstream = '9.9.9.9:53'
  return { actions: kernelRuleOf(rule).actions }
}
const FORWARDS: [string, Record<string, unknown>][] = [
  ['forward-none', { actions: [{ type: 'forward' }] }],
  ['forward-none-tcp', { actions: [{ type: 'forward', upstream: null, transport: 'tcp' }] }],
  ['forward-merged', { actions: [{ type: 'log', level: 'info' }, { type: 'replace_txt_response', text: ['x'] }, { type: 'forward', upstream: [] }, { type: 'forward', upstream: 'tcp://9.9.9.9:53, https://dns.example/dns-query' }] }],
  ['forward-answer-none', { actions: [{ type: 'forward', upstream: '1.1.1.1:53' }], response_matchers: [{ type: 'response_rcode', value: 'SERVFAIL' }], response_actions_on_match: [{ type: 'forward', transport: 'tcp' }] }],
  ['forward-form', formForward()],
]

// 内核照收、面板以前拦着的写法：转到自己所在的组（内核只提醒）、固定响应码 FORMERR 和 NOTIMP、一段空的 TXT、TTL 0、TXT 内容「等于」空的
// What the kernel takes and the panel used to stop: a jump to its own group (the kernel only warns), the fixed rcodes FORMERR and NOTIMP,
// one empty TXT segment, a TTL of 0, TXT content 「等于」 empty
const LENIENT: [string, Record<string, unknown>][] = [
  ['self-jump', { actions: [{ type: 'jump_to_pipeline', pipeline: 'main' }] }],
  ['formerr', { actions: [{ type: 'static_response', rcode: 'FORMERR' }] }],
  ['notimp', { actions: [{ type: 'static_response', rcode: 'NOTIMP' }] }],
  ['empty-txt', { actions: [{ type: 'static_txt_response', text: [''], ttl: 0 }] }],
  ['empty-txt-match', { actions: [{ type: 'forward' }], response_matchers: [{ type: 'response_txt_content', operator: 'and', mode: 'exact', value: '' }], response_actions_on_match: [{ type: 'replace_txt_response', text: [''] }] }],
]

function fixtures(): Fixture[] {
  const models: [string, Model][] = [
    ['示例配置', sampleModel()], ['演示配置', demoModel()], ['每种条件', conditionKinds()], ['每种回答条件', responseKinds()], ['每种结果', outcomeKinds()],
    ['每种上游', upstreamKinds()], ...blocklistKinds().map((m, i): [string, Model] => [`拦截列表 ${i}`, m]), ['其余请求拦截', restBlocks()], ['高级规则', advancedKinds()],
    ...Array.from({ length: SEEDS }, (_, i): [string, Model] => [`种子 ${i + 1}`, generateModel(i + 1)]),
  ]
  return models.map(([name, model]) => ({ name, config: compile(model) }))
}

describe('交给真内核校验的配置', () => {
  it('都是编辑器认可的、只用内核认的类型名；设了 KERNEL_FIXTURES 时写出去', () => {
    // 自己拼的规则也得是编辑器认可的：编辑器不收的，内核不收也不算面板的错 / The hand-built rules must be editor-valid too: what the editor refuses,
    // the kernel refusing is no fault of the panel's
    for (const m of [conditionKinds(), responseKinds(), outcomeKinds(), upstreamKinds(), restBlocks()]) {
      const bad = [...m.rules, ...m.ruleGroups.flatMap((g) => g.rules)].flatMap((r) => ruleProblems(m, r).map((p) => `${r.name}：${p}`))
      for (const g of m.groups) for (const a of g.addresses) { const p = addressProblem(a); if (p) bad.push(`${g.name} 的 ${a.address}：${p}`) }
      expect(bad).toEqual([])
    }
    // 高级规则里的这几条编辑器都认（没写上游的问编出来的默认上游，没编出来时内核用 1.1.1.1:53） / These advanced rules are all editor-valid
    // (one writing no upstream asking the compiled default upstream, 1.1.1.1:53 from the kernel when none is compiled)
    const advanced = advancedKinds()
    const defaultUpstream = String(compile(advanced).settings.default_upstream ?? '1.1.1.1:53')
    const ids = compile(advanced).pipelines.map((p) => p.id)
    for (const [name, rule] of [...FORWARDS, ...LENIENT]) {
      for (const list of ['actions', 'response_actions_on_match']) {
        for (const a of (rule[list] ?? []) as RuleConfig['actions']) expect(actionFieldErrors(a, ids, defaultUpstream), `${name} ${a.type}`).toEqual({})
      }
      for (const m of (rule.response_matchers ?? []) as MatcherConfig[]) expect(matcherFieldErrors(m, 'response'), `${name} ${m.type}`).toEqual({})
    }
    // 先写出去再查：这里和内核意见不一样时，CI 里照样看得到真内核怎么说 / Written before checking: should this disagree with the kernel, CI still
    // shows what the real kernel says
    const all = fixtures()
    const out = process.env.KERNEL_FIXTURES
    if (out) writeFileSync(out, JSON.stringify(all))
    expect(all.length).toBe(11 + SEEDS)
    for (const f of all) refuseUnknownTypes(f.config as KConfigLike)
  })
})
