import { describe, expect, it } from 'vitest'
import { exportConfig, kernelPart, panelHash, readConfig } from './document'
import { importKernel } from './importer'
import type { KConfigLike } from './kernel'
import { compile, conditionText, FIELD, newRule, responseConditionText, type Condition, type Model, type ResponseCondition, type Rule } from './model'
import { sampleModel } from './testing/samples'

// 域名条件的三种比较：「属于」是这个名字加它下面的所有子域名，「就是」只算这个名字本身，还有正则。
// The three ways a domain condition compares: 属于 is the name and every subdomain under it, 就是 the name itself only, and a regex.

const domain = (values: string[], part: Partial<Condition> = {}): Condition => ({ id: 900_001, field: 'domain', negate: false, regex: false, values, ...part })
const requestDomain = (values: string[], part: Partial<ResponseCondition> = {}): ResponseCondition => ({ id: 900_002, field: 'request_domain', negate: false, regex: false, values, ...part })

function withRule(conditions: Condition[], response: ResponseCondition[] = []): { model: Model; rule: Rule } {
  const model = sampleModel()
  // 回答条件只在转给上游的规则上才有 / Answer conditions exist only on a rule that forwards upstream
  const outcome = response.length ? { type: 'upstream' as const, group: 'cn' } : { type: 'block' as const, response: 'NXDOMAIN' as const }
  const rule: Rule = { ...newRule(900_000, outcome), name: 'domain-match' }
  rule.conditions = [conditions]
  if (response.length) rule.response = { ...rule.response, mode: 'custom', match: 'all', conditions: response, then: { type: 'block', response: 'NXDOMAIN' }, otherwise: { type: 'none' } }
  model.rules = [rule, ...model.rules]
  return { model, rule }
}

// 编出来的内核规则里，名字是 domain-match 的那一条 / The compiled kernel rule named domain-match
type LooseConfig = { pipelines: { id: string; rules?: Record<string, unknown>[] }[] }
const loose = (model: Model) => JSON.parse(JSON.stringify(compile(model))) as LooseConfig
function compiledRule(model: Model): Record<string, unknown> {
  return loose(model).pipelines.flatMap((p) => p.rules ?? []).find((r) => r.name === 'domain-match')!
}
// 这条规则自己的转发 Pipeline 里的回答条件 / The answer conditions in the rule's own forward pipeline
function compiledResponse(model: Model): Record<string, unknown>[] {
  const own = loose(model).pipelines.find((p) => p.id === 'rule-900000')!
  return (own.rules ?? []).flatMap((r) => (r.response_matchers ?? []) as Record<string, unknown>[])
}
const reimport = (model: Model) => importKernel(JSON.parse(JSON.stringify(compile(model))) as KConfigLike).model

describe('域名条件：属于、就是、正则 / domain conditions: 属于, 就是, regex', () => {
  it('「属于」写成 domain_suffix，*. 不写进去；「就是」写成 domain_exact / 属于 compiles to domain_suffix without *., 就是 to domain_exact', () => {
    const { model } = withRule([domain(['*.example.net', 'example.org']), domain(['api.example.com'], { exact: true })])
    const matchers = compiledRule(model).matchers as Record<string, unknown>[]
    expect(matchers).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'domain_suffix', value: 'example.net' }),
      expect.objectContaining({ type: 'domain_suffix', value: 'example.org' }),
      expect.objectContaining({ type: 'domain_exact', value: 'api.example.com' }),
    ]))
    expect(matchers.some((m) => String(m.value).startsWith('*.'))).toBe(false)
  })

  it('回答条件里的请求域名也一样 / the request domain in answer conditions works the same', () => {
    const { model } = withRule([domain(['example.org'])], [requestDomain(['*.cdn.example']), requestDomain(['one.example'], { id: 900_003, exact: true })])
    const matchers = compiledResponse(model)
    expect(matchers).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'request_domain_suffix', value: 'cdn.example' }),
      expect.objectContaining({ type: 'request_domain_exact', value: 'one.example' }),
    ]))
  })

  it('读回内核配置时认得 domain_exact，比较方式和说法都对 / reading the kernel config back knows domain_exact, with the right comparison and words', () => {
    const { model } = withRule([domain(['example.net']), domain(['api.example.com'], { exact: true }), domain(['beta.example.com'], { negate: true, exact: true })])
    const back = reimport(model).rules.find((r) => r.name === 'domain-match')!
    const texts = back.conditions.flat().map(conditionText)
    expect(texts).toEqual(expect.arrayContaining(['域名属于 example.net', '域名就是 api.example.com', '域名不是 beta.example.com']))
    expect(compile({ ...model, rules: [back, ...model.rules.slice(1)] }).pipelines).toEqual(compile(model).pipelines)
  })

  it('回答条件的 request_domain_exact 也读得回来 / request_domain_exact reads back too', () => {
    const { model } = withRule([domain(['example.org'])], [requestDomain(['one.example'], { exact: true })])
    const back = reimport(model).rules.find((r) => r.name === 'domain-match')!
    expect(back.response.conditions.map(responseConditionText)).toEqual(['请求的域名就是 one.example'])
  })

  it('「就是」不收 *.：通配符说的是子域名 / 就是 refuses *.: a wildcard speaks of subdomains', () => {
    const valid = FIELD.domain.valid!
    expect(valid('*.example.net', { exact: true })).toBe(false)
    expect(valid('api.example.com', { exact: true })).toBe(true)
    expect(valid('*.example.net', {})).toBe(true)
  })

  it('存下来的 *. 读进来就去掉，生成的内核配置不变 / a stored *. is dropped on read and the kernel config stays the same', () => {
    const { model } = withRule([domain(['*.example.net', '*.example.org'])], [requestDomain(['*.cdn.example'])])
    const cfg = JSON.parse(JSON.stringify(exportConfig(model))) as Record<string, unknown>
    const back = readConfig(cfg)
    expect(back.source).toBe('panel')
    const rule = back.model.rules.find((r) => r.name === 'domain-match')!
    expect(rule.conditions[0]![0]!.values).toEqual(['example.net', 'example.org'])
    expect(rule.response.conditions[0]!.values).toEqual(['cdn.example'])
    expect(compile(back.model)).toEqual(kernelPart(cfg))
  })

  it('旧版写下的请求域名 *.x 内核一直匹配不到：读进来去掉，再存就写 x / an old *.x request domain never matched: dropped on read, saved as x', () => {
    const { model } = withRule([domain(['example.org'])], [requestDomain(['*.cdn.example'])])
    // 旧版生成的配置：回答条件里原样写着 *.cdn.example / A config from the old panel: the answer condition keeps *.cdn.example verbatim
    const kernel = JSON.parse(JSON.stringify(compile(model)).replaceAll('"cdn.example"', '"*.cdn.example"')) as KConfigLike
    const old = { ...kernel, panel: { v: (exportConfig(model).panel as { v: number }).v, hash: panelHash(kernel), model } }
    expect(JSON.stringify(old)).toContain('"value":"*.cdn.example"')
    const back = readConfig(JSON.parse(JSON.stringify(old)) as Record<string, unknown>)
    expect(back.source).toBe('panel')
    expect(back.model.rules.find((r) => r.name === 'domain-match')!.response.conditions[0]!.values).toEqual(['cdn.example'])
    expect(compiledResponse(back.model)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'request_domain_suffix', value: 'cdn.example' })]))
  })

  it('去掉 *. 以后重复的值只留一个 / a value repeated once *. is dropped is kept once', () => {
    const { model } = withRule([domain(['*.example.net', 'example.net'])])
    const back = readConfig(JSON.parse(JSON.stringify(exportConfig(model))) as Record<string, unknown>)
    expect(back.model.rules.find((r) => r.name === 'domain-match')!.conditions[0]![0]!.values).toEqual(['example.net'])
  })
})
