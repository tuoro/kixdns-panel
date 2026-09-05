import { createRule, nextPipelineId } from './model'
import { guidedRuleValidationErrors } from './guided-rule'
import { matcherFieldErrors } from './field-validation'
import { CONFIG_STATIC_CNAME_RESPONSE_V1 } from './schema'
import { ruleMatchesEveryRequest } from './summary'
import type { ConfigObject, KixConfig, PipelineConfig, PipelineSelectConfig, RuleConfig } from './types'

export type SolutionTemplateId = 'domestic_global' | 'domain_upstream' | 'domain_mapping' | 'ad_block' | 'client_network' | 'blank'
export type SolutionPipelineMode = 'new' | 'reuse' | 'owned' | 'copy' | 'shared'
export type SolutionGroupType = 'domain_mapping'

export interface DomainMappingRow {
  source: string
  target: string
  ttl: number
}

export interface SolutionTemplate {
  id: SolutionTemplateId
  name: string
  description: string
  requiresCapability?: string
}

export interface SolutionDraft {
  selector: PipelineSelectConfig
  pipeline: PipelineConfig
  rule: RuleConfig
  pipelineMode: SolutionPipelineMode
  existingPipelineId?: string
  groupType?: SolutionGroupType
  mappingRows?: DomainMappingRow[]
}

export interface DnsSolution {
  key: string
  selectorIndex?: number
  pipelineIndex?: number
  selector?: PipelineSelectConfig
  pipeline?: PipelineConfig
  rule?: RuleConfig
  groupType?: SolutionGroupType
  mappingRows?: DomainMappingRow[]
  referenceCount: number
  kind: 'simple' | 'group' | 'custom' | 'orphan'
  reason?: string
}

export const SOLUTION_TEMPLATES: SolutionTemplate[] = [
  { id: 'domestic_global', name: '国内外 DNS 分流', description: '一次创建国内解析与全局兜底' },
  { id: 'domain_upstream', name: '指定域名上游', description: '指定域名使用独立 DNS' },
  { id: 'domain_mapping', name: '域名映射', description: '把查询域名映射到另一个域名', requiresCapability: CONFIG_STATIC_CNAME_RESPONSE_V1 },
  { id: 'ad_block', name: '广告域名拒绝', description: '拒绝广告分类中的域名' },
  { id: 'client_network', name: '客户端网段分流', description: '指定客户端使用独立流程' },
  { id: 'blank', name: '空白方案', description: '从空白条件和动作开始' },
]

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function makeRule(pipeline: PipelineConfig, name: string): RuleConfig {
  const rule = createRule(pipeline)
  rule.name = name
  return rule
}

function makeDraft(config: KixConfig, id: string): SolutionDraft {
  const pipeline: PipelineConfig = { id: nextPipelineId(config, id), rules: [] }
  return {
    selector: { pipeline: pipeline.id, matcher_operator: 'and', matchers: [] },
    pipeline,
    rule: makeRule(pipeline, `${pipeline.id}-rule`),
    pipelineMode: 'new',
  }
}

export function createSolutionDrafts(config: KixConfig, templateId: SolutionTemplateId): SolutionDraft[] {
  if (templateId === 'domestic_global') {
    const domestic = makeDraft(config, 'cn_doh')
    const withDomestic = { ...config, pipelines: [...config.pipelines, domestic.pipeline] }
    const global = makeDraft(withDomestic, 'global_doh')
    domestic.selector.matchers = [{ type: 'geo_site', operator: 'and', value: 'geosite:cn' }]
    domestic.rule.name = 'cn-doh'
    domestic.rule.actions = [{
      type: 'forward',
      upstream: 'https://doh.pub/dns-query, https://dns.alidns.com/dns-query',
      transport: '',
    }]
    domestic.rule.response_matchers = [
      { type: 'response_answer_ip', operator: 'and', cidr: '0.0.0.0/32' },
      { type: 'response_answer_ip', operator: 'and', cidr: '240.0.0.0/4' },
      { type: 'response_answer_ip', operator: 'and', cidr: '255.255.255.255/32' },
    ]
    domestic.rule.response_matcher_operator = 'or'
    domestic.rule.response_actions_on_match = [
      { type: 'log', level: 'warn' },
      { type: 'jump_to_pipeline', pipeline: global.pipeline.id },
    ]
    global.selector.matchers = []
    global.rule.name = 'global-doh'
    global.rule.actions = [{
      type: 'forward',
      upstream: 'https://cloudflare-dns.com/dns-query, https://dns.google/dns-query',
      transport: '',
    }]
    return [domestic, global]
  }

  const base = templateId === 'domain_upstream'
    ? 'domain_dns'
    : templateId === 'domain_mapping'
      ? 'domain_mapping'
      : templateId === 'ad_block'
        ? 'ad_block'
        : templateId === 'client_network'
          ? 'client_dns'
          : 'dns_solution'
  const draft = makeDraft(config, base)
  if (templateId === 'domain_upstream') {
    draft.selector.matchers = [{ type: 'domain_suffix', operator: 'and', value: 'example.com' }]
    draft.rule.actions = [{ type: 'forward', upstream: '1.1.1.1:53', transport: '' }]
  } else if (templateId === 'domain_mapping') {
    draft.selector.matchers = [{ type: 'domain_suffix', operator: 'and', value: 'alias.example' }]
    draft.rule.actions = [{ type: 'static_cname_response', target: 'origin.example.', ttl: 300 }]
    draft.groupType = 'domain_mapping'
    draft.mappingRows = [{ source: 'alias.example', target: 'origin.example.', ttl: 300 }]
  } else if (templateId === 'ad_block') {
    draft.selector.matchers = [{ type: 'geo_site', operator: 'and', value: 'geosite:category-ads-all' }]
    draft.rule.actions = [{ type: 'deny' }]
  } else if (templateId === 'client_network') {
    draft.selector.matchers = [{ type: 'client_ip', operator: 'and', cidr: '192.168.1.0/24' }]
    draft.rule.actions = [{ type: 'forward', upstream: '1.1.1.1:53', transport: '' }]
  }
  return [draft]
}

export function createDraftFromSolution(solution: DnsSolution, config: KixConfig): SolutionDraft | undefined {
  if (!solution.selector || !solution.pipeline || !solution.rule || solution.selectorIndex === undefined) return undefined
  const shared = solution.referenceCount > 1
  const pipeline = clone(solution.pipeline)
  if (shared) pipeline.id = nextPipelineId(config, `${solution.pipeline.id}-copy`)
  const selector = clone(solution.selector)
  selector.pipeline = pipeline.id
  const draft: SolutionDraft = {
    selector,
    pipeline,
    rule: clone(solution.rule),
    pipelineMode: shared ? 'copy' : 'owned',
    existingPipelineId: solution.pipeline.id,
  }
  if (solution.groupType === 'domain_mapping' && solution.mappingRows) {
    draft.groupType = solution.groupType
    draft.mappingRows = clone(solution.mappingRows)
  }
  return draft
}

function isPlainMappingRule(rule: RuleConfig): boolean {
  const ruleKeys = new Set(['name', 'matchers', 'matcher_operator', 'actions', 'response_matchers', 'response_matcher_operator', 'response_actions_on_match', 'response_actions_on_miss'])
  const action = rule.actions[0]
  const matcher = rule.matchers[0]
  return Object.keys(rule).every((key) => ruleKeys.has(key))
    && rule.actions.length === 1
    && rule.actions[0]?.type === 'static_cname_response'
    && action !== undefined
    && Object.keys(action).every((key) => ['type', 'target', 'ttl'].includes(key))
    && rule.response_matchers.length === 0
    && rule.response_actions_on_match.length === 0
    && rule.response_actions_on_miss.length === 0
    && (rule.matchers.length === 0 || (
      rule.matchers.length === 1
      && rule.matcher_operator === 'and'
      && matcher?.type === 'domain_suffix'
      && matcher.operator === 'and'
      && typeof matcher.value === 'string'
      && Object.keys(matcher).every((key) => ['type', 'operator', 'value'].includes(key))
    ))
}

function collectMappingRows(selector: PipelineSelectConfig, pipeline: PipelineConfig): DomainMappingRow[] | undefined {
  if (pipeline.rules.length === 0 || !pipeline.rules.every(isPlainMappingRule)) return undefined
  if (!Object.keys(selector).every((key) => ['pipeline', 'matchers', 'matcher_operator'].includes(key))) return undefined
  const selectorSources = selector.matchers.every((matcher) => (
    matcher.type === 'domain_suffix'
    && matcher.operator === 'and'
    && typeof matcher.value === 'string'
    && Object.keys(matcher).every((key) => ['type', 'operator', 'value'].includes(key))
  ))
    ? selector.matchers.map((matcher) => matcher.value!.trim())
    : []
  if (selectorSources.length === 0) return undefined
  if (selector.matcher_operator !== (selectorSources.length > 1 ? 'or' : 'and')) return undefined

  if (pipeline.rules.length === 1 && pipeline.rules[0]?.matchers.length === 0) {
    if (selectorSources.length !== 1) return undefined
    const action = pipeline.rules[0].actions[0]!
    return [{ source: selectorSources[0]!, target: String(action.target ?? ''), ttl: Number(action.ttl ?? 300) }]
  }

  const rows = pipeline.rules.map((rule) => {
    const matcher = rule.matchers[0]!
    const action = rule.actions[0]!
    return { source: matcher.value!.trim(), target: String(action.target ?? ''), ttl: Number(action.ttl ?? 300) }
  })
  const expected = [...new Set(selectorSources)].sort()
  const actual = [...new Set(rows.map((row) => row.source))].sort()
  return expected.length === actual.length && expected.every((source, index) => source === actual[index]) ? rows : undefined
}

function collectPipelineReferences(config: KixConfig): Map<string, number> {
  const references = new Map<string, number>()
  const addReference = (pipelineId: string) => references.set(pipelineId, (references.get(pipelineId) ?? 0) + 1)
  for (const selector of config.pipeline_select) {
    addReference(selector.pipeline)
  }
  const rules: ConfigObject[] = config.pipelines.flatMap((pipeline) => pipeline.rules)
  const background = config.background_refresh_rule
  // 后台规则按原始 JSON 保留，不依赖表单规范化后的动作数组。
  if (background !== null && typeof background === 'object' && !Array.isArray(background)) rules.push(background as ConfigObject)
  for (const rule of rules) {
    for (const key of ['actions', 'response_actions_on_match', 'response_actions_on_miss']) {
      const actions = rule[key]
      if (!Array.isArray(actions)) continue
      for (const action of actions) {
        if (action?.type === 'jump_to_pipeline' && typeof action.pipeline === 'string') addReference(action.pipeline)
      }
    }
  }
  return references
}

export function collectDnsSolutions(config: KixConfig): DnsSolution[] {
  const references = collectPipelineReferences(config)

  const solutions = config.pipeline_select.map((selector, selectorIndex): DnsSolution => {
    const pipelineIndex = config.pipelines.findIndex((pipeline) => pipeline.id === selector.pipeline)
    const pipeline = pipelineIndex >= 0 ? config.pipelines[pipelineIndex] : undefined
    const referenceCount = references.get(selector.pipeline) ?? 0
    if (!pipeline) {
      return {
        key: `selector-${selectorIndex}`,
        selectorIndex,
        selector,
        referenceCount,
        kind: 'custom',
        reason: '目标 Pipeline 不存在',
      }
    }
    const mappingRows = collectMappingRows(selector, pipeline)
    if (mappingRows) {
      return {
        key: `selector-${selectorIndex}`,
        selectorIndex,
        pipelineIndex,
        selector,
        pipeline,
        rule: pipeline.rules[0],
        groupType: 'domain_mapping',
        mappingRows,
        referenceCount,
        kind: 'group',
      }
    }
    if (pipeline.rules.length !== 1) {
      return {
        key: `selector-${selectorIndex}`,
        selectorIndex,
        pipelineIndex,
        selector,
        pipeline,
        referenceCount,
        kind: 'custom',
        reason: pipeline.rules.length === 0 ? 'Pipeline 尚无规则' : `Pipeline 包含 ${pipeline.rules.length} 条内部规则`,
      }
    }
    const rule = pipeline.rules[0]!
    if (!ruleMatchesEveryRequest(rule)) {
      return {
        key: `selector-${selectorIndex}`,
        selectorIndex,
        pipelineIndex,
        selector,
        pipeline,
        rule,
        referenceCount,
        kind: 'custom',
        reason: 'Pipeline 内还有独立的请求匹配条件',
      }
    }
    return {
      key: `selector-${selectorIndex}`,
      selectorIndex,
      pipelineIndex,
      selector,
      pipeline,
      rule,
      referenceCount,
      kind: 'simple',
    }
  })

  const selectedPipelineIds = new Set(config.pipeline_select.map((selector) => selector.pipeline))
  for (const [pipelineIndex, pipeline] of config.pipelines.entries()) {
    if (selectedPipelineIds.has(pipeline.id)) continue
    solutions.push({
      key: `orphan-${pipelineIndex}`,
      pipelineIndex,
      pipeline,
      referenceCount: references.get(pipeline.id) ?? 0,
      kind: 'orphan',
      reason: '没有入口分流指向此 Pipeline',
    })
  }
  return solutions
}

export function collectDomainMappingRows(config: KixConfig): DomainMappingRow[] {
  return collectDnsSolutions(config)
    .filter((solution) => solution.groupType === 'domain_mapping')
    .flatMap((solution) => (solution.mappingRows ?? []).map((row) => ({ ...row })))
}

export function replaceDomainMappingRows(config: KixConfig, rows: DomainMappingRow[]): void {
  const mappings = collectDnsSolutions(config).filter((solution) => solution.groupType === 'domain_mapping')
  const selectorIndexes = mappings
    .flatMap((solution) => solution.selectorIndex === undefined ? [] : [solution.selectorIndex])
    .sort((left, right) => right - left)
  const mappingPipelineIds = new Set(mappings.flatMap((solution) => solution.pipeline ? [solution.pipeline.id] : []))

  for (const index of selectorIndexes) config.pipeline_select.splice(index, 1)
  const references = collectPipelineReferences(config)
  config.pipelines = config.pipelines.filter((pipeline) => (
    !mappingPipelineIds.has(pipeline.id) || references.has(pipeline.id)
  ))
  if (rows.length === 0) return

  const draft = createSolutionDrafts(config, 'domain_mapping')[0]!
  draft.mappingRows = rows
  const materialized = cloneSolutionDraft(draft)
  config.pipeline_select.unshift(materialized.selector)
  config.pipelines.push({ ...materialized.pipeline, rules: materializeSolutionRules(materialized) })
}

export function selectorMatchesEveryRequest(selector: PipelineSelectConfig): boolean {
  if (selector.matchers.length === 0) return true
  if (!selector.matchers.every((matcher) => matcher.operator === 'and')) return false
  if (selector.matcher_operator === 'or') return selector.matchers.some((matcher) => matcher.type === 'any')
  return selector.matcher_operator === 'and' && selector.matchers.every((matcher) => matcher.type === 'any')
}

export function solutionIdentityErrors(draft: SolutionDraft, config: KixConfig, additionalPipelineIds: readonly string[] = []): Record<string, string> {
  const errors: Record<string, string> = {}
  if (draft.pipelineMode === 'new' || draft.pipelineMode === 'copy') {
    if (!draft.pipeline.id.trim()) errors.pipeline = '请填写 Pipeline ID'
    else if (config.pipelines.some((pipeline) => pipeline.id === draft.pipeline.id) || additionalPipelineIds.includes(draft.pipeline.id)) errors.pipeline = 'Pipeline ID 已存在'
  } else if (draft.pipelineMode === 'reuse' && !config.pipelines.some((pipeline) => pipeline.id === draft.selector.pipeline)) {
    errors.pipeline = '请选择现有 Pipeline'
  }
  if (draft.pipelineMode !== 'reuse' && draft.groupType !== 'domain_mapping' && !draft.rule.name.trim()) errors.name = '请填写规则名称'
  return errors
}

export function solutionValidationErrors(
  draft: SolutionDraft,
  config: KixConfig,
  sourceSelectorIndex?: number,
  additionalPipelineIds: readonly string[] = [],
): string[] {
  const errors: string[] = []
  if (draft.groupType === 'domain_mapping') {
    const rows = draft.mappingRows ?? []
    if (rows.length === 0) errors.push('请至少添加一条域名映射')
    if (rows.some((row) => !row.source.trim() || !row.target.trim())) errors.push('请补全域名映射')
    const sources = rows.map((row) => row.source.trim()).filter(Boolean)
    if (new Set(sources).size !== sources.length) errors.push('源域名不能重复')
    const pipelineIds = [...config.pipelines.map((pipeline) => pipeline.id), draft.pipeline.id, ...additionalPipelineIds]
    for (const [index, row] of rows.entries()) {
      const rule = mappingRule(draft.pipeline, row, index)
      errors.push(...guidedRuleValidationErrors(rule, draft.pipeline.id, pipelineIds))
    }
  } else if (draft.selector.matchers.some((matcher) => Object.keys(matcherFieldErrors(matcher, 'selector')).length > 0)) errors.push('请补全入口条件')
  errors.push(...Object.values(solutionIdentityErrors(draft, config, additionalPipelineIds)))
  if (draft.pipelineMode !== 'reuse' && draft.groupType !== 'domain_mapping') {
    const pipelineIds = [...config.pipelines.map((pipeline) => pipeline.id), draft.pipeline.id, ...additionalPipelineIds]
    errors.push(...guidedRuleValidationErrors(draft.rule, draft.pipeline.id, pipelineIds))
  }
  if (sourceSelectorIndex === undefined && selectorMatchesEveryRequest(draft.selector)) {
    const fallbackExists = config.pipeline_select.some(selectorMatchesEveryRequest)
    if (fallbackExists) errors.push('已经存在任意请求兜底方案')
  }
  return [...new Set(errors)]
}

export function solutionInsertIndex(config: KixConfig, selector: PipelineSelectConfig): number {
  if (selectorMatchesEveryRequest(selector)) return config.pipeline_select.length
  const fallbackIndex = config.pipeline_select.findIndex(selectorMatchesEveryRequest)
  return fallbackIndex < 0 ? config.pipeline_select.length : fallbackIndex
}

export function cloneSolutionDraft(draft: SolutionDraft): SolutionDraft {
  const result = clone(draft)
  if (result.groupType === 'domain_mapping') {
    // 编辑中的空 TTL 用 NaN 表示，JSON 克隆会将它变成 null 并误用默认值。
    result.mappingRows = draft.mappingRows?.map((row) => ({ ...row }))
    syncMappingSelector(result)
  }
  return result
}

function mappingRule(pipeline: PipelineConfig, row: DomainMappingRow, index: number): RuleConfig {
  const rule = makeRule(pipeline, `${pipeline.id}-mapping-${index + 1}`)
  rule.matchers = [{ type: 'domain_suffix', operator: 'and', value: row.source.trim() }]
  rule.actions = [{ type: 'static_cname_response', target: row.target.trim(), ttl: row.ttl }]
  return rule
}

function syncMappingSelector(draft: SolutionDraft): void {
  const rows = draft.mappingRows ?? []
  draft.selector.pipeline = draft.pipeline.id
  draft.selector.matchers = rows.map((row) => ({
    type: 'domain_suffix',
    operator: 'and',
    value: row.source.trim(),
  }))
  draft.selector.matcher_operator = rows.length > 1 ? 'or' : 'and'
}

export function materializeSolutionRules(draft: SolutionDraft): RuleConfig[] {
  if (draft.groupType === 'domain_mapping') {
    return (draft.mappingRows ?? []).map((row, index) => mappingRule(draft.pipeline, row, index))
  }
  return [clone(draft.rule)]
}
