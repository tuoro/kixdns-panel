import { createRule, nextPipelineId } from './model'
import { SHARED_TEMPLATE_COPY, guidedRuleValidationErrors } from './guided-rule'
import { matcherFieldErrors } from './field-validation'
import { CONFIG_STATIC_CNAME_RESPONSE_V1 } from './schema'
import { ruleMatchesEveryRequest, summarizeMatchers } from './summary'
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
  { id: 'domain_upstream', ...SHARED_TEMPLATE_COPY.domain_upstream },
  { id: 'domain_mapping', ...SHARED_TEMPLATE_COPY.domain_mapping, requiresCapability: CONFIG_STATIC_CNAME_RESPONSE_V1 },
  { id: 'ad_block', ...SHARED_TEMPLATE_COPY.ad_block },
  { id: 'client_network', name: '客户端网段分流', description: '指定客户端使用独立流程' },
  { id: 'blank', ...SHARED_TEMPLATE_COPY.blank },
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

/**
 * 能沿用的兜底入口：第一个匹配所有请求的入口，且它指向的 Pipeline 真的存在。指向不存在的 Pipeline 的兜底不能沿用，
 * 跳过去就是一个坏掉的跳转（审计第三轮 C3）。
 * The catch-all that can be reused: the first entry matching every request, and only when its Pipeline exists. A
 * catch-all pointing at a missing Pipeline cannot be reused; jumping there would be a broken jump (audit round 3, C3).
 */
export function reusableCatchAll(config: KixConfig): PipelineSelectConfig | undefined {
  const first = config.pipeline_select.find(selectorMatchesEveryRequest)
  return first && config.pipelines.some((pipeline) => pipeline.id === first.pipeline) ? first : undefined
}

/**
 * 起点的说明按这份配置写：已经有兜底入口时，国内外分流只建国内解析，说明不能再说「一次创建国内解析与全局兜底」（审计第三轮 B8）。
 * 兜底入口用它的名字称呼，不用编号：新入口插在它前面，它的编号会变，选完以后放置那一句里的编号说的是新入口。
 * A start's description follows this config: with a catch-all already there the split start creates only 国内解析, so it must
 * not promise 「一次创建国内解析与全局兜底」 (audit round 3, B8). The catch-all is named by its summary, not its number: the new
 * entry goes in front of it and shifts that number, and the placement line's number then means the new entry.
 */
export function solutionTemplateDescription(config: KixConfig, template: SolutionTemplate): string {
  if (template.id !== 'domestic_global') return template.description
  const fallback = reusableCatchAll(config)
  if (!fallback) return template.description
  return `创建国内解析，其余请求仍由「${summarizeMatchers(fallback.matchers, fallback.matcher_operator, 'selector')}」兜底`
}

export function createSolutionDrafts(config: KixConfig, templateId: SolutionTemplateId): SolutionDraft[] {
  if (templateId === 'domestic_global') {
    const domestic = makeDraft(config, 'cn_doh')
    const withDomestic = { ...config, pipelines: [...config.pipelines, domestic.pipeline] }
    const global = makeDraft(withDomestic, 'global_doh')
    // 已经有接住所有请求的入口时，全局兜底就用它：只建国内解析，异常响应跳到那个入口的流程，不再另建一个永远轮不到的兜底（审计第二轮 B2）
    // With a catch-all entry already there, it is the global fallback: only 国内解析 is created and a bad response jumps to that
    // entry's flow, instead of adding a second fallback that could never be reached (audit round 2, B2)
    const fallback = reusableCatchAll(config)
    // 分类名本身：内核按原样查 GeoSite 标签，写成 geosite:cn 永远匹配不上 / The bare category: the kernel looks the tag up as written, so geosite:cn never matches
    domestic.selector.matchers = [{ type: 'geo_site', operator: 'and', value: 'cn' }]
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
      { type: 'jump_to_pipeline', pipeline: fallback?.pipeline ?? global.pipeline.id },
    ]
    if (fallback) return [domestic]
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
  // 要用户自己填的值（域名、映射）留空，示例只在占位符里：模板不会一键加进 example.com 这种假数据（审计第二轮 B1）
  // Values only the user can supply (domains, mappings) start empty with the example in the placeholder, so a start never
  // adds fake data such as example.com in one click (audit round 2, B1)
  if (templateId === 'domain_upstream') {
    draft.selector.matchers = [{ type: 'domain_suffix', operator: 'and', value: '' }]
    draft.rule.actions = [{ type: 'forward', upstream: '1.1.1.1:53', transport: '' }]
  } else if (templateId === 'domain_mapping') {
    draft.selector.matchers = [{ type: 'domain_suffix', operator: 'and', value: '' }]
    draft.rule.actions = [{ type: 'static_cname_response', target: '', ttl: 300 }]
    draft.groupType = 'domain_mapping'
    draft.mappingRows = [{ source: '', target: '', ttl: 300 }]
  } else if (templateId === 'ad_block') {
    draft.selector.matchers = [{ type: 'geo_site', operator: 'and', value: 'category-ads-all' }]
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

// 三处（工作台列表、自由编辑、流程视图）同一句话说同一件事（审计 V17） / One sentence per fact across the list, 自由编辑 and the flow view (audit V17)
export const ENTRY_ORDER_NOTE = '从上往下匹配，第一个命中的生效。'
export const RULE_ORDER_NOTE = '每个 Pipeline 里的规则也从上往下执行。'

/**
 * Pipeline 是怎么被用到的，工作台列表、浏览检查器和流程视图用同一个说法（审计 V11）：配置里第一个 Pipeline 在
 * 没有兜底入口时「接住其余请求」（内核 select_pipeline 的退路）；有入口指向的不另说；其余的「由规则跳转进来」或「未被引用」。
 * How a Pipeline gets used, worded the same in the workbench list, the browse inspector and the flow view (audit V11):
 * the first Pipeline catches the rest when no entry catches everything (the kernel's select_pipeline fallback); one
 * with an entry needs no note; the rest are reached by a rule's jump or referenced by nothing.
 */
// first：它是不是第一个 Pipeline。平时按 ID 看；改名途中 ID 已经是新打的字，调用方按对象另外告诉它（审计第六轮 C2）
// first: whether it is the first Pipeline. Usually judged by ID; mid-rename the ID already holds the typed text, so the caller says so by object (audit round 6, C2)
export function pipelineRole(
  config: KixConfig,
  pipelineId: string,
  first = config.pipelines[0]?.id === pipelineId,
): '接住其余请求' | '由规则跳转进来' | '未被引用' | undefined {
  if (first && !config.pipeline_select.some(selectorMatchesEveryRequest)) return '接住其余请求'
  if (config.pipeline_select.some((selector) => selector.pipeline === pipelineId)) return undefined
  return (collectPipelineReferences(config).get(pipelineId) ?? 0) > 0 ? '由规则跳转进来' : '未被引用'
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
  // 映射 Pipeline 原来在哪，改完放回哪：没有入口命中时内核交给第一个 Pipeline，
  // 挪到末尾会悄悄换掉这个兜底。
  // Put the mapping Pipeline back where it was: with no entry matching, the kernel hands
  // the request to the first Pipeline, and moving this one to the end silently swaps it.
  const originalIndex = config.pipelines.findIndex((pipeline) => mappingPipelineIds.has(pipeline.id))
  const originalId = originalIndex >= 0 ? config.pipelines[originalIndex]!.id : undefined

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
  const pipeline = { ...materialized.pipeline, rules: materializeSolutionRules(materialized) }
  // 旧的还被跳转引用、没有删掉时，新的只能加在末尾，不能插到它前面去。
  // If the old one is still referenced by a jump and stayed, the new one goes last rather than ahead of it.
  const removed = originalId !== undefined && !config.pipelines.some((item) => item.id === originalId)
  if (removed) config.pipelines.splice(originalIndex, 0, pipeline)
  else config.pipelines.push(pipeline)
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
    if (rows.length === 0) errors.push('至少要一条域名映射')
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
  // 编辑时也查：把一个入口的条件删光，它就和已有的兜底抢同一批请求，其中一个永远轮不到（审计第三轮）
  // Editing is checked too: removing an entry's last condition makes it compete with the existing catch-all, and one of the two would never be reached (audit round 3)
  if (selectorMatchesEveryRequest(draft.selector)
    && config.pipeline_select.some((selector, index) => index !== sourceSelectorIndex && selectorMatchesEveryRequest(selector))) {
    errors.push('已经存在任意请求兜底方案')
  }
  return [...new Set(errors)]
}

export function solutionInsertIndex(config: KixConfig, selector: PipelineSelectConfig): number {
  if (selectorMatchesEveryRequest(selector)) return config.pipeline_select.length
  const fallbackIndex = config.pipeline_select.findIndex(selectorMatchesEveryRequest)
  return fallbackIndex < 0 ? config.pipeline_select.length : fallbackIndex
}

/**
 * 新入口会排在第几个，按工作台列表的编号数（不算域名映射，从 1 数），以及排到它后面的那个入口（兜底入口）。
 * Where a new entry lands, numbered as the workbench list numbers entries (domain mappings excluded, 1-based),
 * and the entry that ends up after it (the catch-all).
 */
export function entryPlacement(config: KixConfig, selector: PipelineSelectConfig): { number: number; next?: PipelineSelectConfig } {
  const index = solutionInsertIndex(config, selector)
  const mappings = mappingSelectorIndexes(config)
  const counted = (at: number): boolean => !mappings.has(at)
  let number = 1
  for (let at = 0; at < index; at += 1) if (counted(at)) number += 1
  const nextIndex = config.pipeline_select.findIndex((_, at) => at >= index && counted(at))
  return nextIndex < 0 ? { number } : { number, next: config.pipeline_select[nextIndex] }
}

/**
 * 已经在列表里的入口排第几、后面紧跟哪个入口、一共几个入口；编号和工作台列表一样，不算域名映射。
 * 一次建好几段的起点先把每一段都放进去再问，每一段说的位置才都是真的（审计第三轮 B1）。
 * Where an entry already in the list stands, the entry right after it and how many entries there are, numbered as the workbench
 * list numbers them (domain mappings excluded). A start that adds several parts inserts all of them first, so every part states a
 * true position (audit round 3, B1).
 */
export function entryPosition(config: KixConfig, index: number): { number: number; next?: PipelineSelectConfig; total: number } {
  const mappings = mappingSelectorIndexes(config)
  const counted = (at: number): boolean => !mappings.has(at)
  const nextIndex = config.pipeline_select.findIndex((_, at) => at > index && counted(at))
  return {
    number: entryNumberAt(config, index, mappings),
    next: nextIndex < 0 ? undefined : config.pipeline_select[nextIndex],
    total: config.pipeline_select.filter((_, at) => counted(at)).length,
  }
}

function mappingSelectorIndexes(config: KixConfig): Set<number | undefined> {
  return new Set(collectDnsSolutions(config).filter((solution) => solution.groupType === 'domain_mapping').map((solution) => solution.selectorIndex))
}

/** 第 index 个选择器在工作台列表里的编号（不算域名映射，从 1 数） / The workbench number of selector index (mappings excluded, 1-based) */
export function entryNumberAt(config: KixConfig, index: number, mappings = mappingSelectorIndexes(config)): number {
  let number = 1
  for (let at = 0; at < index; at += 1) if (!mappings.has(at)) number += 1
  return number
}

/** 已有的兜底入口在工作台列表里的编号 / The existing catch-all's number in the workbench list */
export function catchAllEntryNumber(config: KixConfig): number | undefined {
  const index = config.pipeline_select.findIndex(selectorMatchesEveryRequest)
  return index < 0 ? undefined : entryNumberAt(config, index)
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
