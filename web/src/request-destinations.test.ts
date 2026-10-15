import { describe, expect, it } from 'vitest'
import type { NamedCount, RuleCount } from './api/types'
import { compile, type Model } from './config-model/model'
import { sampleModel } from './config-model/testing/samples'
import { traceNames } from './config-model/trace-names'
import { requestDestinations, type KernelPipeline } from './request-destinations'

// 样本配置一路走下来，每一步给一个数，看最后各去向的次数和总请求数对得上，而且主列表、规则组这种转交的列表不出现
// Walk the sample config with a count at every step: each destination's total must add up to the requests, and lists that only hand
// requests on (the main list, rule groups) never show
function setup(edit?: (m: Model) => void) {
  const model = sampleModel()
  edit?.(model)
  const pipelines = compile(model).pipelines as KernelPipeline[]
  // 用例可能删掉了这条规则 / A case may have removed the rule
  const ruleId = (name: string) => { const rule = model.rules.find((r) => r.name === name); return rule ? `rule-${rule.id}` : '' }
  return { model, pipelines, apple: ruleId('苹果服务'), rebind: ruleId('防 DNS 重绑定') }
}
const run = (s: ReturnType<typeof setup>, total: number, hits: NamedCount[], matches: RuleCount[]) =>
  requestDestinations({ total, hits, matches, pipelines: s.pipelines, model: s.model, names: traceNames(s.model) })
const response = (pipeline: string, count: number): RuleCount => ({ pipeline, rule: pipeline, phase: 'response', count })

describe('请求最后去了哪', () => {
  it('每个请求只算在它停下的地方，合起来就是总请求数', () => {
    const s = setup()
    // 10,000 个请求：300 个进域名映射，其余进主列表。主列表里 960 个被拦截或自定义回答；公司 100、苹果服务 800（转发自带 ECS）、
    // 国内域名 3,000、内网反查 200（规则组里转公司 50、其余转路由器 150）、防 DNS 重绑定 1,500（自带回答检查，3 个被拦），其余 3,140 去国外。
    // 回答后检查：公司失败转国内 5，国内污染转国外 40，苹果服务的转发沿用国内的检查、污染转国外 20
    // 10,000 requests: 300 into the mappings, the rest into the main list. There 960 are blocked or answered; 公司 100, 苹果服务 800 (its forward
    // carries ECS), 国内域名 3,000, 内网反查 200 (in the group 50 to 公司 and the rest 150 to 路由器), 防 DNS 重绑定 1,500 (its own check blocks 3),
    // and the remaining 3,140 go abroad. Answer checks: 公司 failures to 国内 5, 国内 polluted to 国外 40, 苹果服务's forward inheriting 国内's check 20
    const hits: NamedCount[] = [
      { name: 'domain_mapping', count: 300 },
      { name: 'main', count: 9_700 },
      { name: 'group-lan', count: 200 },
      { name: 'upstream-corp', count: 150 },
      { name: 'upstream-cn', count: 3_005 },
      { name: s.apple, count: 800 },
      { name: 'upstream-router', count: 150 },
      { name: s.rebind, count: 1_500 },
      { name: 'upstream-abroad', count: 3_200 },
    ]
    const matches: RuleCount[] = [
      response('upstream-corp', 5), response('upstream-cn', 40), response(s.apple, 20), response(s.rebind, 3),
      // 请求阶段的命中不参与：后台刷新也会算进去，和 Pipeline 计数口径不同 / Request-phase hits take no part: background refreshes count there, unlike the pipeline counts
      { pipeline: 'main', rule: '广告与跟踪', phase: 'request', count: 99_999 },
    ]
    const { rows, caveats } = run(s, 10_000, hits, matches)
    expect(rows.map((r) => [r.label, r.count])).toEqual([
      ['上游组「国外」', 3_200 + 1_500 - 3],
      ['上游组「国内」', 3_005 - 40 + 800 - 20],
      ['拦截和自定义回答', 960 + 3],
      ['域名映射', 300],
      ['上游组「路由器」', 150],
      ['上游组「公司」', 150 - 5],
    ])
    expect(rows.reduce((sum, r) => sum + r.count, 0)).toBe(10_000)
    // 传进来的计数原样不动 / The counts passed in are left untouched
    expect(hits[0]).toEqual({ name: 'domain_mapping', count: 300 })
    expect(rows[0]!.share).toBeCloseTo(4_697 / 10_000)
    expect(caveats).toEqual([])
  })

  it('回答后检查的「否则」转走的请求数不出来，照实说明', () => {
    const s = setup((m) => { m.rules.find((r) => r.name === '防 DNS 重绑定')!.response.otherwise = { type: 'upstream', group: 'cn' } })
    const { caveats } = run(s, 10, [{ name: 'main', count: 10 }, { name: s.rebind, count: 10 }], [])
    expect(caveats).toEqual(['回答后检查的「否则」转走或直接回应的请求，仍算在原来的上游组'])
  })

  it('只用到拦截时直接回应那一行就叫「拦截」', () => {
    const s = setup((m) => {
      m.rules = m.rules.filter((r) => r.outcome.type !== 'answer' && r.response.mode !== 'custom')
    })
    const { rows } = run(s, 100, [{ name: 'main', count: 100 }, { name: 'upstream-abroad', count: 60 }], [])
    expect(rows.map((r) => [r.label, r.count])).toEqual([['上游组「国外」', 60], ['拦截', 40]])
  })

  it('导入的旧配置：主列表既直接转发又转到别处时说明，转发去的旧 Pipeline 按地址认出上游组', () => {
    const s = setup()
    const pipelines: KernelPipeline[] = [
      { id: 'main', rules: [
        { name: 'cn', actions: [{ type: 'jump_to_pipeline', pipeline: 'cn_doh' }] },
        { name: 'rest', actions: [{ type: 'forward', upstream: 'https://dns.google/dns-query, https://cloudflare-dns.com/dns-query' }] },
      ] },
      { id: 'cn_doh', rules: [{ name: 'cn_doh', actions: [{ type: 'forward', upstream: 'https://doh.pub/dns-query, tls://dns.alidns.com, tcp+udp://223.5.5.5' }] }] },
    ]
    const { rows, caveats } = requestDestinations({ total: 100, hits: [{ name: 'main', count: 100 }, { name: 'cn_doh', count: 30 }], matches: [], pipelines, model: s.model, names: traceNames(s.model) })
    expect(rows.map((r) => [r.label, r.count])).toEqual([['拦截和自定义回答', 70], ['上游组「国内」', 30]])
    expect(caveats).toEqual(['「主列表」里直接转发的请求算进了「拦截和自定义回答」'])
  })

  it('配置里已经没有的 Pipeline 照原名单列；没有请求时一行都没有', () => {
    const s = setup()
    const { rows } = run(s, 50, [{ name: 'main', count: 50 }, { name: 'gone', count: 50 }], [])
    expect(rows.map((r) => [r.label, r.count])).toEqual([['gone', 50]])
    expect(run(s, 0, [], []).rows).toEqual([])
  })
})
