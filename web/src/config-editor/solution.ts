import { createRule, nextPipelineId } from './model'
import { guidedRuleValidationErrors } from './guided-rule'
import { CONFIG_STATIC_CNAME_RESPONSE_V1, MATCHER_DEFINITIONS } from './schema'
import { ruleMatchesEveryRequest } from './summary'
import type { KixConfig, MatcherConfig, PipelineConfig, PipelineSelectConfig, RuleConfig } from './types'

export type SolutionTemplateId = 'domestic_global' | 'domain_upstream' | 'domain_mapping' | 'ad_block' | 'client_network' | 'blank'
export type SolutionPipelineMode = 'new' | 'reuse' | 'owned' | 'copy' | 'shared'

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
}

export interface DnsSolution {
  key: string
  selectorIndex?: number
  pipelineIndex?: number
  selector?: PipelineSelectConfig
  pipeline?: PipelineConfig
  rule?: RuleConfig
  referenceCount: number
  kind: 'simple' | 'custom' | 'orphan'
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
  return {
    selector,
    pipeline,
    rule: clone(solution.rule),
    pipelineMode: shared ? 'copy' : 'owned',
    existingPipelineId: solution.pipeline.id,
  }
}

export function collectDnsSolutions(config: KixConfig): DnsSolution[] {
  const references = new Map<string, number>()
  for (const selector of config.pipeline_select) {
    references.set(selector.pipeline, (references.get(selector.pipeline) ?? 0) + 1)
  }

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

  for (const [pipelineIndex, pipeline] of config.pipelines.entries()) {
    if ((references.get(pipeline.id) ?? 0) > 0) continue
    solutions.push({
      key: `orphan-${pipelineIndex}`,
      pipelineIndex,
      pipeline,
      referenceCount: 0,
      kind: 'orphan',
      reason: '没有入口分流指向此 Pipeline',
    })
  }
  return solutions
}

export function selectorMatchesEveryRequest(selector: PipelineSelectConfig): boolean {
  if (selector.matchers.length === 0) return true
  if (!selector.matchers.every((matcher) => matcher.operator === 'and')) return false
  if (selector.matcher_operator === 'or') return selector.matchers.some((matcher) => matcher.type === 'any')
  return selector.matcher_operator === 'and' && selector.matchers.every((matcher) => matcher.type === 'any')
}

function matcherMissingValue(matcher: MatcherConfig): boolean {
  const fields = MATCHER_DEFINITIONS.selector.find((item) => item.value === matcher.type)?.fields ?? []
  if (fields.includes('value') && !matcher.value?.trim()) return true
  if (fields.includes('cidr') && !matcher.cidr?.trim()) return true
  return fields.includes('country_codes') && (!matcher.country_codes || matcher.country_codes.length === 0)
}

export function solutionValidationErrors(
  draft: SolutionDraft,
  config: KixConfig,
  sourceSelectorIndex?: number,
  additionalPipelineIds: readonly string[] = [],
): string[] {
  const errors: string[] = []
  if (draft.selector.matchers.some(matcherMissingValue)) errors.push('请补全入口条件')
  if (draft.pipelineMode === 'new' || draft.pipelineMode === 'copy') {
    if (!draft.pipeline.id.trim()) errors.push('请填写 Pipeline ID')
    if (config.pipelines.some((pipeline) => pipeline.id === draft.pipeline.id)) {
      errors.push('Pipeline ID 已存在')
    }
  } else if (draft.pipelineMode === 'reuse' && !config.pipelines.some((pipeline) => pipeline.id === draft.selector.pipeline)) {
    errors.push('请选择现有 Pipeline')
  }
  if (draft.pipelineMode !== 'reuse') {
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
  return clone(draft)
}
