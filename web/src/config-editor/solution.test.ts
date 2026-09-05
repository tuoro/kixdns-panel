import { describe, expect, it } from 'vitest'
import {
  cloneSolutionDraft,
  collectDnsSolutions,
  collectDomainMappingRows,
  createDraftFromSolution,
  createSolutionDrafts,
  materializeSolutionRules,
  replaceDomainMappingRows,
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
  it('映射 TTL 清空后保持待补全状态，不被默认值覆盖', () => {
    const value = config()
    const rows = [{ source: 'nas.home', target: 'storage.home.', ttl: Number.NaN }]
    replaceDomainMappingRows(value, rows)
    const [actual] = collectDomainMappingRows(value)
    expect(Number.isNaN(actual?.ttl)).toBe(true)
    expect(Number.isNaN(rows[0]!.ttl)).toBe(true)
    actual!.ttl = 0
    replaceDomainMappingRows(value, [actual!])
    expect(collectDomainMappingRows(value)[0]?.ttl).toBe(0)
  })

  it('一次创建多个方案时，流程名称不能相互冲突', () => {
    const value = config()
    const [draft] = createSolutionDrafts(value, 'domain_upstream')
    expect(solutionValidationErrors(draft!, value, undefined, [draft!.pipeline.id])).toContain('Pipeline ID 已存在')
  })

  it('域名映射方案同时创建入口条件和固定 CNAME 动作', () => {
    const [mapping] = createSolutionDrafts(config(), 'domain_mapping')

    expect(mapping?.pipeline.id).toBe('domain_mapping')
    expect(mapping?.selector.matchers[0]).toMatchObject({ type: 'domain_suffix', value: 'alias.example' })
    expect(mapping?.rule.actions[0]).toEqual({ type: 'static_cname_response', target: 'origin.example.', ttl: 300 })
    expect(mapping?.mappingRows).toEqual([{ source: 'alias.example', target: 'origin.example.', ttl: 300 }])
  })

  it('多条域名映射生成一个可往返编辑的映射组', () => {
    const value = config()
    const mapping = createSolutionDrafts(value, 'domain_mapping')[0]!
    mapping.mappingRows!.push({ source: 'alias-two.example', target: 'origin-two.example.', ttl: 120 })
    const saved = cloneSolutionDraft(mapping)
    const rules = materializeSolutionRules(saved)
    value.pipeline_select.push(saved.selector)
    value.pipelines.push({ ...saved.pipeline, rules })

    expect(saved.selector.matcher_operator).toBe('or')
    expect(rules).toHaveLength(2)
    expect(rules[1]?.matchers[0]).toMatchObject({ type: 'domain_suffix', value: 'alias-two.example' })
    expect(rules[1]?.actions[0]).toMatchObject({ type: 'static_cname_response', target: 'origin-two.example.', ttl: 120 })

    const [solution] = collectDnsSolutions(value)
    expect(solution?.kind).toBe('group')
    expect(solution?.mappingRows).toHaveLength(2)
    expect(createDraftFromSolution(solution!, value)?.mappingRows).toEqual(saved.mappingRows)
  })

  it('独立维护域名映射并始终放在入口分流最前', () => {
    const value: KixConfig = {
      settings: {},
      pipeline_select: [selector('ordinary', [{ type: 'domain_suffix', operator: 'and', value: 'example.com' }])],
      pipelines: [pipeline('ordinary')],
    }

    replaceDomainMappingRows(value, [
      { source: 'nas.home', target: 'storage.home.', ttl: 300 },
      { source: 'git.home', target: 'nas.home.', ttl: 120 },
    ])

    expect(value.pipeline_select[0]?.pipeline).toBe('domain_mapping')
    expect(value.pipeline_select[1]?.pipeline).toBe('ordinary')
    expect(collectDomainMappingRows(value)).toEqual([
      { source: 'nas.home', target: 'storage.home.', ttl: 300 },
      { source: 'git.home', target: 'nas.home.', ttl: 120 },
    ])

    replaceDomainMappingRows(value, [])
    expect(value.pipeline_select.map((item) => item.pipeline)).toEqual(['ordinary'])
    expect(value.pipelines.map((item) => item.id)).toEqual(['ordinary'])
  })

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

  it('带扩展字段的映射配置保持为自定义方案', () => {
    const mapping = createSolutionDrafts(config(), 'domain_mapping')[0]!
    const saved = cloneSolutionDraft(mapping)
    const rules = materializeSolutionRules(saved)
    rules[0]!.future_option = true
    const value: KixConfig = {
      settings: {},
      pipeline_select: [saved.selector],
      pipelines: [{ ...saved.pipeline, rules }],
    }

    const [solution] = collectDnsSolutions(value)

    expect(solution?.kind).toBe('custom')
    expect(solution?.reason).toContain('独立的请求匹配条件')
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

  it.each(['actions', 'response_actions_on_match', 'response_actions_on_miss'] as const)(
    '%s 中的跳转计入共享引用，编辑目标默认复制而不改变调用方', (actionsKey) => {
      const caller = pipeline('caller')
      caller.rules[0]![actionsKey] = [{ type: 'jump_to_pipeline', pipeline: 'shared' }]
      const value: KixConfig = {
        settings: {},
        pipeline_select: [selector('shared'), selector('caller')],
        pipelines: [pipeline('shared'), caller],
      }
      const before = JSON.stringify(value)
      const shared = collectDnsSolutions(value)[0]!

      expect(shared.referenceCount).toBe(2)
      const draft = createDraftFromSolution(shared, value)!
      expect(draft.pipelineMode).toBe('copy')
      expect(draft.pipeline.id).not.toBe('shared')
      draft.rule.actions[0]!.upstream = '9.9.9.9:53'
      expect(JSON.stringify(value)).toBe(before)
    },
  )

  it('后台刷新规则的跳转同样保护被引用的 Pipeline', () => {
    const value: KixConfig = {
      settings: {},
      pipeline_select: [selector('shared')],
      pipelines: [pipeline('shared')],
      background_refresh_rule: { actions: [{ type: 'jump_to_pipeline', pipeline: 'shared' }] },
    }

    const shared = collectDnsSolutions(value)[0]!
    expect(shared.referenceCount).toBe(2)
    expect(createDraftFromSolution(shared, value)?.pipelineMode).toBe('copy')
  })

  it.each(['actions', 'response_actions_on_match', 'response_actions_on_miss'] as const)(
    '删除映射入口时保留 %s 跳转目标，并继续展示无直接入口的流程', (actionsKey) => {
      const value: KixConfig = { settings: {}, pipeline_select: [selector('caller')], pipelines: [pipeline('caller')] }
      replaceDomainMappingRows(value, [{ source: 'alias.example', target: 'origin.example.', ttl: 300 }])
      const mapping = collectDnsSolutions(value).find((solution) => solution.groupType === 'domain_mapping')!
      const mappingId = mapping.pipeline!.id
      value.pipelines[0]!.rules[0]![actionsKey] = [{ type: 'jump_to_pipeline', pipeline: mappingId }]
      const originalMapping = JSON.stringify(mapping.pipeline)

      replaceDomainMappingRows(value, [])

      expect(value.pipeline_select.map((entry) => entry.pipeline)).toEqual(['caller'])
      expect(JSON.stringify(value.pipelines.find((item) => item.id === mappingId))).toBe(originalMapping)
      expect(collectDnsSolutions(value).find((solution) => solution.pipeline?.id === mappingId)).toMatchObject({
        kind: 'orphan', referenceCount: 1,
      })
      expect(value.pipelines[0]!.rules[0]![actionsKey][0]!.pipeline).toBe(mappingId)
    },
  )

  it('修改映射入口时保留被跳转的旧流程，新增映射使用独立 ID', () => {
    const value: KixConfig = { settings: {}, pipeline_select: [selector('caller')], pipelines: [pipeline('caller')] }
    replaceDomainMappingRows(value, [{ source: 'alias.example', target: 'origin.example.', ttl: 300 }])
    const originalMappingId = value.pipeline_select[0]!.pipeline
    value.pipelines[0]!.rules[0]!.response_actions_on_miss = [{ type: 'jump_to_pipeline', pipeline: originalMappingId }]

    replaceDomainMappingRows(value, [{ source: 'new.example', target: 'new-origin.example.', ttl: 0 }])

    expect(value.pipeline_select[0]!.pipeline).not.toBe(originalMappingId)
    expect(value.pipelines.find((item) => item.id === originalMappingId)?.rules[0]?.actions[0]?.target).toBe('origin.example.')
    expect(collectDomainMappingRows(value)).toEqual([{ source: 'new.example', target: 'new-origin.example.', ttl: 0 }])
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
