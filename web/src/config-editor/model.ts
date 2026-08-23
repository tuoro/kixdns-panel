import { MATCHER_DEFINITIONS, SETTING_SECTIONS } from './schema'
import type {
  ActionConfig,
  ConfigObject,
  EcsConfig,
  KixConfig,
  MatcherConfig,
  MatcherScope,
  PipelineConfig,
  PipelineSelectConfig,
  PipelineSelectMode,
  RuleConfig,
} from './types'

function isObject(value: unknown): value is ConfigObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneObject(value: ConfigObject): ConfigObject {
  return JSON.parse(JSON.stringify(value)) as ConfigObject
}

const TOP_LEVEL_KEYS = ['version', 'settings', 'pipeline_select', 'pipelines', 'background_refresh_rule']
const GEO_SETTING_KEYS = [
  'geoip_db_path',
  'geoip_dat_path',
  'geosite_data_paths',
  'geoip_auto_convert',
  'geoip_filter_countries',
]
const SETTING_KEYS = [
  ...SETTING_SECTIONS.flatMap((section) => section.fields.map((field) => field.key)),
  ...GEO_SETTING_KEYS,
]
const PIPELINE_SELECT_KEYS = ['pipeline', 'matchers', 'matcher_operator']
const PIPELINE_KEYS = ['id', 'ecs', 'rules']
const RULE_KEYS = [
  'name',
  'matchers',
  'matcher_operator',
  'actions',
  'response_matchers',
  'response_matcher_operator',
  'response_actions_on_match',
  'response_actions_on_miss',
]
const MATCHER_KEYS = ['type', 'operator', 'value', 'cidr', 'expect', 'country_codes', 'mode']
const ACTION_KEYS = ['type', 'level', 'rcode', 'ip', 'target', 'text', 'ttl', 'pipeline', 'upstream', 'transport', 'ecs']
const ECS_KEYS = ['mode', 'prefix_v4', 'prefix_v6', 'ip', 'prefix']

function orderFields(value: ConfigObject, keys: readonly string[]): ConfigObject {
  const ordered: ConfigObject = {}
  const known = new Set(keys)
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) ordered[key] = value[key]
  }
  for (const [key, field] of Object.entries(value)) {
    if (!known.has(key)) ordered[key] = field
  }
  return ordered
}

function orderEcs(value: unknown): unknown {
  return isObject(value) ? orderFields(value, ECS_KEYS) : value
}

function orderMatcher(value: unknown, compactDefaults = false): unknown {
  if (!isObject(value)) return value
  if (compactDefaults && value.operator === 'and') delete value.operator
  return orderFields(value, MATCHER_KEYS)
}

function orderAction(value: unknown, compactDefaults = false): unknown {
  if (!isObject(value)) return value
  if (compactDefaults && value.transport === '') delete value.transport
  if (Object.prototype.hasOwnProperty.call(value, 'ecs')) value.ecs = orderEcs(value.ecs)
  return orderFields(value, ACTION_KEYS)
}

function orderRule(value: unknown, compactDefaults = false): unknown {
  if (!isObject(value)) return value
  if (compactDefaults && value.matcher_operator === 'and') delete value.matcher_operator
  if (compactDefaults && value.response_matcher_operator === 'and') delete value.response_matcher_operator
  if (Array.isArray(value.matchers)) value.matchers = value.matchers.map((item) => orderMatcher(item, compactDefaults))
  if (Array.isArray(value.actions)) value.actions = value.actions.map((item) => orderAction(item, compactDefaults))
  if (Array.isArray(value.response_matchers)) {
    value.response_matchers = value.response_matchers.map((item) => orderMatcher(item, compactDefaults))
  }
  if (Array.isArray(value.response_actions_on_match)) {
    value.response_actions_on_match = value.response_actions_on_match.map((item) => orderAction(item, compactDefaults))
  }
  if (Array.isArray(value.response_actions_on_miss)) {
    value.response_actions_on_miss = value.response_actions_on_miss.map((item) => orderAction(item, compactDefaults))
  }
  return orderFields(value, RULE_KEYS)
}

function orderPipeline(value: unknown, compactDefaults = false): unknown {
  if (!isObject(value)) return value
  if (Object.prototype.hasOwnProperty.call(value, 'ecs')) value.ecs = orderEcs(value.ecs)
  if (Array.isArray(value.rules)) value.rules = value.rules.map((item) => orderRule(item, compactDefaults))
  return orderFields(value, PIPELINE_KEYS)
}

function orderPipelineSelect(value: unknown, compactDefaults = false): unknown {
  if (!isObject(value)) return value
  if (compactDefaults && value.matcher_operator === 'and') delete value.matcher_operator
  if (Array.isArray(value.matchers)) value.matchers = value.matchers.map((item) => orderMatcher(item, compactDefaults))
  return orderFields(value, PIPELINE_SELECT_KEYS)
}

function orderConfig(value: ConfigObject, compactDefaults = false): KixConfig {
  if (isObject(value.settings)) value.settings = orderFields(value.settings, SETTING_KEYS)
  if (Array.isArray(value.pipeline_select)) {
    value.pipeline_select = value.pipeline_select.map((item) => orderPipelineSelect(item, compactDefaults))
  }
  if (Array.isArray(value.pipelines)) {
    value.pipelines = value.pipelines.map((item) => orderPipeline(item, compactDefaults))
  }
  if (Object.prototype.hasOwnProperty.call(value, 'background_refresh_rule')) {
    value.background_refresh_rule = orderRule(value.background_refresh_rule, compactDefaults)
  }
  return orderFields(value, TOP_LEVEL_KEYS) as KixConfig
}

function normalizeCountryCodes(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.replace(/^geoip:/i, '').split(',') : []
  return values
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean)
}

function normalizeMatcher(value: unknown, scope: MatcherScope): MatcherConfig {
  const matcher = isObject(value) ? value : {}
  const fallback = MATCHER_DEFINITIONS[scope][0]?.value ?? 'any'
  matcher.type = typeof matcher.type === 'string' ? matcher.type : fallback
  matcher.operator = typeof matcher.operator === 'string' ? matcher.operator : 'and'
  if ('country_codes' in matcher) matcher.country_codes = normalizeCountryCodes(matcher.country_codes)
  return matcher as MatcherConfig
}

function normalizeAction(value: unknown): ActionConfig {
  const action = isObject(value) ? value : {}
  action.type = typeof action.type === 'string' ? action.type : 'log'
  if (action.type === 'forward' && typeof action.transport !== 'string') action.transport = ''
  return action as ActionConfig
}

function normalizeRule(value: unknown): RuleConfig {
  const rule = isObject(value) ? value : {}
  rule.name = typeof rule.name === 'string' ? rule.name : ''
  rule.matcher_operator = typeof rule.matcher_operator === 'string' ? rule.matcher_operator : 'and'
  rule.response_matcher_operator = typeof rule.response_matcher_operator === 'string' ? rule.response_matcher_operator : 'and'
  rule.matchers = Array.isArray(rule.matchers) ? rule.matchers.map((item) => normalizeMatcher(item, 'request')) : []
  rule.actions = Array.isArray(rule.actions) ? rule.actions.map(normalizeAction) : []
  rule.response_matchers = Array.isArray(rule.response_matchers) ? rule.response_matchers.map((item) => normalizeMatcher(item, 'response')) : []
  rule.response_actions_on_match = Array.isArray(rule.response_actions_on_match) ? rule.response_actions_on_match.map(normalizeAction) : []
  rule.response_actions_on_miss = Array.isArray(rule.response_actions_on_miss) ? rule.response_actions_on_miss.map(normalizeAction) : []
  return rule as RuleConfig
}

function normalizePipeline(value: unknown): PipelineConfig {
  const pipeline = isObject(value) ? value : {}
  pipeline.id = typeof pipeline.id === 'string' ? pipeline.id : ''
  pipeline.rules = Array.isArray(pipeline.rules) ? pipeline.rules.map(normalizeRule) : []
  return pipeline as PipelineConfig
}

function normalizePipelineSelect(value: unknown): PipelineSelectConfig {
  const selector = isObject(value) ? value : {}
  selector.pipeline = typeof selector.pipeline === 'string' ? selector.pipeline : ''
  selector.matcher_operator = typeof selector.matcher_operator === 'string' ? selector.matcher_operator : 'and'
  selector.matchers = Array.isArray(selector.matchers) ? selector.matchers.map((item) => normalizeMatcher(item, 'selector')) : []
  return selector as PipelineSelectConfig
}

export function normalizeConfig(value: ConfigObject): KixConfig {
  const config = cloneObject(value)
  const settings = isObject(config.settings) ? config.settings : {}
  delete settings.geosite_enabled
  config.settings = settings
  config.pipeline_select = Array.isArray(config.pipeline_select) ? config.pipeline_select.map(normalizePipelineSelect) : []
  config.pipelines = Array.isArray(config.pipelines) ? config.pipelines.map(normalizePipeline) : []
  return orderConfig(config)
}

export function parseConfigSource(source: string): KixConfig {
  const value: unknown = JSON.parse(source)
  if (!isObject(value)) throw new Error('配置根节点必须是 JSON 对象')
  return normalizeConfig(value)
}

export function serializeConfig(config: KixConfig): string {
  return JSON.stringify(orderConfig(cloneObject(config), true), null, 2)
}

export function createMatcher(scope: MatcherScope): MatcherConfig {
  const type = MATCHER_DEFINITIONS[scope][0]?.value ?? 'any'
  return resetMatcher({ type, operator: 'and' }, type, scope)
}

export function resetMatcher(matcher: MatcherConfig, type: string, scope: MatcherScope): MatcherConfig {
  for (const key of Object.keys(matcher)) {
    if (key !== 'type' && key !== 'operator') delete matcher[key]
  }
  matcher.type = type
  matcher.operator = matcher.operator || 'and'
  const fields = MATCHER_DEFINITIONS[scope].find((item) => item.value === type)?.fields ?? []
  if (fields.includes('value')) matcher.value = type === 'qtype' ? 'A' : ''
  if (fields.includes('cidr')) matcher.cidr = ''
  if (fields.includes('expect')) matcher.expect = true
  if (fields.includes('country_codes')) matcher.country_codes = []
  if (fields.includes('mode')) matcher.mode = 'exact'
  return matcher
}

export function createAction(type = 'log'): ActionConfig {
  return resetAction({ type }, type)
}

export function resetAction(action: ActionConfig, type: string): ActionConfig {
  for (const key of Object.keys(action)) {
    if (key !== 'type') delete action[key]
  }
  action.type = type
  if (type === 'log') action.level = 'info'
  if (type === 'static_response') action.rcode = 'NXDOMAIN'
  if (type === 'static_ip_response') action.ip = '127.0.0.1'
  if (type === 'static_cname_response') {
    action.target = 'origin.example.'
    action.ttl = 300
  }
  if (type === 'static_txt_response') {
    action.text = ['v=spf1 ~all']
    action.ttl = 300
  }
  if (type === 'replace_txt_response') action.text = ['replaced']
  if (type === 'jump_to_pipeline') action.pipeline = ''
  if (type === 'forward') {
    action.upstream = ''
    action.transport = ''
  }
  return action
}

export function createEcs(mode: string): EcsConfig | undefined {
  if (mode === 'clear') return { mode: 'clear' }
  if (mode === 'from_client_ip') return { mode: 'from_client_ip', prefix_v4: 24, prefix_v6: 56 }
  if (mode === 'static') return { mode: 'static', ip: '', prefix: 24 }
  return undefined
}

export function createPipelineSelect(): PipelineSelectConfig {
  return { pipeline: '', matcher_operator: 'and', matchers: [] }
}

export function inferMatcherMode(matchers: MatcherConfig[], matcherOperator: string): PipelineSelectMode {
  if (matchers.every((matcher) => matcher.operator === 'and')) {
    if (matcherOperator === 'and') return 'all'
    if (matcherOperator === 'or') return 'any'
  }
  return 'custom'
}

export function applyMatcherMode(matchers: MatcherConfig[], mode: PipelineSelectMode): 'and' | 'or' {
  if (mode === 'custom') {
    if (matchers[0]) matchers[0].operator = 'and'
    return 'and'
  }
  for (const matcher of matchers) matcher.operator = 'and'
  return mode === 'all' ? 'and' : 'or'
}

export function inferPipelineSelectMode(selector: PipelineSelectConfig): PipelineSelectMode {
  return inferMatcherMode(selector.matchers, selector.matcher_operator)
}

export function applyPipelineSelectMode(selector: PipelineSelectConfig, mode: PipelineSelectMode): void {
  selector.matcher_operator = applyMatcherMode(selector.matchers, mode)
}

export function nextPipelineId(config: KixConfig, base = 'pipeline', except?: PipelineConfig): string {
  const normalized = base.trim() || 'pipeline'
  const used = new Set(config.pipelines.filter((item) => item !== except).map((item) => item.id))
  if (!used.has(normalized)) return normalized
  let index = 2
  while (used.has(`${normalized}-${index}`)) index += 1
  return `${normalized}-${index}`
}

export function createPipeline(config: KixConfig): PipelineConfig {
  return { id: nextPipelineId(config), rules: [] }
}

export function createRule(pipeline: PipelineConfig): RuleConfig {
  const existing = new Set(pipeline.rules.map((item) => item.name))
  let name = 'rule'
  let index = 2
  while (existing.has(name)) {
    name = `rule-${index}`
    index += 1
  }
  return {
    name,
    matchers: [],
    matcher_operator: 'and',
    actions: [],
    response_matchers: [],
    response_matcher_operator: 'and',
    response_actions_on_match: [],
    response_actions_on_miss: [],
  }
}

export function moveRule(pipeline: PipelineConfig, fromIndex: number, toIndex: number): boolean {
  if (
    fromIndex < 0
    || fromIndex >= pipeline.rules.length
    || toIndex < 0
    || toIndex >= pipeline.rules.length
    || fromIndex === toIndex
  ) return false

  const [rule] = pipeline.rules.splice(fromIndex, 1)
  if (!rule) return false
  pipeline.rules.splice(toIndex, 0, rule)
  return true
}

function visitActions(config: KixConfig, visitor: (action: ActionConfig) => void): void {
  for (const pipeline of config.pipelines) {
    for (const rule of pipeline.rules) {
      for (const actions of [rule.actions, rule.response_actions_on_match, rule.response_actions_on_miss]) {
        for (const action of actions) visitor(action)
      }
    }
  }
}

export function renamePipeline(config: KixConfig, pipeline: PipelineConfig, previousId: string): { id: string; references: number } {
  const nextId = nextPipelineId(config, pipeline.id, pipeline)
  pipeline.id = nextId
  if (!previousId || previousId === nextId) return { id: nextId, references: 0 }
  let references = 0
  for (const selector of config.pipeline_select) {
    if (selector.pipeline === previousId) {
      selector.pipeline = nextId
      references += 1
    }
  }
  visitActions(config, (action) => {
    if (action.type === 'jump_to_pipeline' && action.pipeline === previousId) {
      action.pipeline = nextId
      references += 1
    }
  })
  return { id: nextId, references }
}

export function ruleHasForward(rule: RuleConfig): boolean {
  return rule.actions.some((action) => action.type === 'forward')
}

export function pipelineHasActionEcs(pipeline: PipelineConfig): boolean {
  return pipeline.rules.some((rule) => rule.actions.some((action) => action.type === 'forward' && isObject(action.ecs)))
}

export function configRuleCount(config: KixConfig): number {
  return config.pipelines.reduce((total, pipeline) => total + pipeline.rules.length, 0)
}
