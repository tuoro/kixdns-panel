import { describe, expect, it } from 'vitest'
import { compile, ruleTitle } from './model'
import { demoModel } from './testing/samples'
import { findKernelRule, traceNames } from './trace-names'

describe('执行路径里的内核名字找回配置页的名字', () => {
  // demoModel 里「国内域名」和「版本查询」没起名字 / In demoModel 国内域名 and 版本查询 go unnamed
  const model = demoModel()
  const names = traceNames(model)
  const kernelNames = compile(model).pipelines.flatMap((p) => p.rules.map((r) => r.name))

  it('有名字的规则按名字找，展开出来的 #N 也认得', () => {
    expect(findKernelRule(model, '公司内网')?.name).toBe('公司内网')
    expect(kernelNames).toContain('苹果服务#2')
    expect(findKernelRule(model, '苹果服务#2')?.name).toBe('苹果服务')
  })

  it('没起名字的规则按内核里的 rule-编号找回来，标题是它的条件', () => {
    const unnamed = model.rules.find((r) => !r.name && r.outcome.type === 'upstream')!
    expect(kernelNames).toContain(`rule-${unnamed.id}`)
    expect(names.rule(`rule-${unnamed.id}`)).toBe(ruleTitle(unnamed))
  })

  it('认不出的名字返回 null，照原样显示', () => {
    expect(names.rule('没有这条')).toBeNull()
    expect(names.pipeline('nowhere')).toBeNull()
  })

  it('Pipeline 写成主列表、规则组、上游组', () => {
    const said = compile(model).pipelines.map((p) => names.pipeline(p.id))
    expect(names.pipeline('main')).toBe('主列表')
    expect(said).toContain('规则组「内网解析」')
    expect(said).toContain('上游组「国内」')
  })

  it('面板自己生成的规则写成整句，上游组的转发规则算「转发用的」', () => {
    expect(names.matched('其余请求')).toBe('没有规则命中，按「其余请求」处理')
    expect(names.matched('内网解析·其余')).toBe('规则组「内网解析」里没有规则命中，按其余请求处理')
    expect(names.matched('域名映射 nas.home.arpa')).toBe('命中域名映射「nas.home.arpa」')
    expect(names.matched('公司内网')).toBeNull()
    const upstream = compile(model).pipelines.find((p) => p.rules.length === 1 && p.rules[0]!.name === p.id && !p.id.startsWith('rule-'))!
    expect(names.plumbing(upstream.id, upstream.id)).toBe(true)
    expect(names.plumbing('公司内网', 'main')).toBe(false)
    expect(names.entry(upstream.id)).toBe('主列表')
  })
})
