export type MatchOperator = 'and' | 'or' | 'and_not' | 'or_not' | 'not'
export type MatcherScope = 'selector' | 'request' | 'response'
export type PipelineSelectMode = 'all' | 'any' | 'custom'
export type EcsMode = 'clear' | 'from_client_ip' | 'static'

export interface ConfigObject {
  [key: string]: unknown
}

export interface GlobalSettings extends ConfigObject {}

export interface EcsConfig extends ConfigObject {
  mode: EcsMode
  prefix_v4?: number
  prefix_v6?: number
  ip?: string
  prefix?: number
}

export interface MatcherConfig extends ConfigObject {
  type: string
  operator: MatchOperator
  value?: string
  cidr?: string
  expect?: boolean
  country_codes?: string[]
  mode?: string
}

export interface ActionConfig extends ConfigObject {
  type: string
  level?: string
  rcode?: string
  ip?: string
  target?: string
  text?: string | string[]
  ttl?: number
  pipeline?: string
  upstream?: string
  transport?: string
  ecs?: EcsConfig
}

export interface RuleConfig extends ConfigObject {
  name: string
  matchers: MatcherConfig[]
  matcher_operator: MatchOperator
  actions: ActionConfig[]
  response_matchers: MatcherConfig[]
  response_matcher_operator: MatchOperator
  response_actions_on_match: ActionConfig[]
  response_actions_on_miss: ActionConfig[]
}

export interface PipelineConfig extends ConfigObject {
  id: string
  ecs?: EcsConfig
  rules: RuleConfig[]
}

export interface PipelineSelectConfig extends ConfigObject {
  pipeline: string
  matchers: MatcherConfig[]
  matcher_operator: MatchOperator
}

export interface KixConfig extends ConfigObject {
  version?: string
  settings: GlobalSettings
  pipeline_select: PipelineSelectConfig[]
  pipelines: PipelineConfig[]
}

export type ConfigEditorMode = 'structured' | 'json' | 'flow'
