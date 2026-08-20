import { describe, expect, it } from 'vitest'
import {
  collectDnsSolutions,
  createDraftFromSolution,
  createSolutionDrafts,
  selectorMatchesEveryRequest,
  solutionInsertIndex,
  solutionValidationErrors,
} from './solution'
import type { KixConfig, PipelineConfig, PipelineSelectConfig, RuleConfig } from './types'

function rule(name = 'default'): RuleConfig {
  return {
    name,
    matchers: [],
    matcher_operator: 'and',
    actions: [{ type: 'forward', upstream: '1.1.1.1:53', transport: '' }],
    response_matchers: [],
    response_matcher_operator: 'and',
    response_actions_on_match: [],
    response_actions_on_miss: [],
  }
}

function pipeline(id: string, rules = [rule()]): PipelineConfig {
  return { id, rules }
}

function selector(pipelineId: string, matchers: PipelineSelectConfig['matchers'] = []): PipelineSelectConfig {
  return { pipeline: pipelineId, matcher_operator: 'and', matchers }
}

function config(): KixConfig {
  return { settings: {}, pipeline_select: [], pipelines: [] }
}

describe('DNS 处理方案', () => {
  it('一次生成国内解析、响应回退和全局兜底完整链路', () => {
    const drafts = createSolutionDrafts(config(), 'domestic_global')

    expect(drafts).toHaveLength(2)
    expect(drafts[0]?.selector.matchers[0]).toMatchObject({ type: 'geo_site', value: 'geosite:cn' })
    expect(drafts[0]?.rule.actions[0]).toMatchObject({ type: 'forward' })
    expect(drafts[0]?.rule.response_matcher_operator).toBe('or')
    expect(drafts[0]?.rule.response_actions_on_match.at(-1)).toMatchObject({ type: 'jump_to_pipeline', pipeline: drafts[1]?.pipeline.id })
    expect(selectorMatchesEveryRequest(drafts[1]!.selector)).toBe(true)
  })

  it('区分完整方案、自定义方案和孤立 Pipeline', () => {
    const value: KixConfig = {
      settings: {},
      pipeline_select: [selector('simple', [{ type: 'domain_suffix', operator: 'and', value: 'example.com' }]), selector('custom')],
      pipelines: [pipeline('simple'), pipeline('custom', [rule('one'), rule('two')]), pipeline('orphan')],
    }

    const solutions = collectDnsSolutions(value)

    expect(solutions.map((item) => item.kind)).toEqual(['simple', 'custom', 'orphan'])
    expect(solutions[1]?.reason).toContain('2 条内部规则')
    expect(solutions[2]?.reason).toContain('没有入口分流')
  })

  it('共享 Pipeline 默认复制成独立流程并保留扩展字段', () => {
    const shared = pipeline('shared')
    shared.extension = { enabled: true }
    const value: KixConfig = { settings: {}, pipeline_select: [selector('shared'), selector('shared')], pipelines: [shared] }
    const solution = collectDnsSolutions(value)[0]!

    const draft = createDraftFromSolution(solution, value)!

    expect(draft.pipelineMode).toBe('copy')
    expect(draft.pipeline.id).not.toBe('shared')
    expect(draft.pipeline.extension).toEqual({ enabled: true })
    expect(value.pipelines[0]?.id).toBe('shared')
    draft.pipeline.id = 'shared'
    expect(solutionValidationErrors(draft, value, 0)).toContain('Pipeline ID 已存在')
  })

  it('把具体方案插入兜底之前，并阻止创建第二个兜底', () => {
    const value: KixConfig = { settings: {}, pipeline_select: [selector('fallback')], pipelines: [pipeline('fallback')] }
    const specific = createSolutionDrafts(value, 'domain_upstream')[0]!
    const fallback = createSolutionDrafts(value, 'blank')[0]!

    expect(solutionInsertIndex(value, specific.selector)).toBe(0)
    expect(solutionInsertIndex(value, fallback.selector)).toBe(1)
    expect(solutionValidationErrors(fallback, value)).toContain('已经存在任意请求兜底方案')
  })
})
