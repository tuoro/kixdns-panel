import { createAction, createRule, resetMatcher } from './model'
import { analyzeRuleFlow, ruleMatchesEveryRequest } from './summary'
import type { MatcherConfig, PipelineConfig, RuleConfig } from './types'

export type GuidedRuleScope = 'all' | 'domain_suffix' | 'geo_site' | 'client_ip' | 'qtype'
export type GuidedRuleIntent = 'forward' | 'deny' | 'static_ip_response' | 'jump_to_pipeline'

export interface GuidedRuleDraft {
  name: string
  scope: GuidedRuleScope
  scopeValue: string
  intent: GuidedRuleIntent
  targetValue: string
  transport: string
}

export function createGuidedRuleDraft(): GuidedRuleDraft {
  return {
    name: '',
    scope: 'geo_site',
    scopeValue: '',
    intent: 'forward',
    targetValue: '',
    transport: '',
  }
}

function safeNamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/^geosite:/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function uniqueRuleName(pipeline: PipelineConfig, requested: string): string {
  const base = requested.trim() || 'guided-rule'
  const used = new Set(pipeline.rules.map((rule) => rule.name))
  if (!used.has(base)) return base
  let index = 2
  while (used.has(`${base}-${index}`)) index += 1
  return `${base}-${index}`
}

function suggestedRuleName(draft: GuidedRuleDraft): string {
  const scope = draft.scope === 'all'
    ? 'fallback'
    : `${draft.scope.replace('_', '-')}-${safeNamePart(draft.scopeValue) || 'rule'}`
  const intent = draft.intent === 'static_ip_response' ? 'static-ip' : draft.intent.replaceAll('_', '-')
  return `${scope}-${intent}`
}

function createGuidedMatcher(draft: GuidedRuleDraft): MatcherConfig | undefined {
  if (draft.scope === 'all') return undefined
  const matcher = resetMatcher({ type: draft.scope, operator: 'and' }, draft.scope, 'request')
  if (draft.scope === 'client_ip') matcher.cidr = draft.scopeValue.trim()
  else matcher.value = draft.scopeValue.trim()
  return matcher
}

export function buildGuidedRule(pipeline: PipelineConfig, draft: GuidedRuleDraft): RuleConfig {
  const rule = createRule(pipeline)
  rule.name = uniqueRuleName(pipeline, draft.name.trim() || suggestedRuleName(draft))
  const matcher = createGuidedMatcher(draft)
  rule.matchers = matcher ? [matcher] : []

  const action = createAction(draft.intent)
  if (draft.intent === 'forward') {
    action.upstream = draft.targetValue.trim()
    action.transport = draft.transport
  } else if (draft.intent === 'static_ip_response') {
    action.ip = draft.targetValue.trim()
  } else if (draft.intent === 'jump_to_pipeline') {
    action.pipeline = draft.targetValue
  }
  rule.actions = [action]
  return rule
}

export function guidedRuleInsertIndex(pipeline: PipelineConfig, scope: GuidedRuleScope): number {
  if (scope === 'all') return pipeline.rules.length
  const blockerIndex = pipeline.rules.findIndex((rule) => {
    const flow = analyzeRuleFlow(rule)
    return ruleMatchesEveryRequest(rule) && flow.kind !== 'continue'
  })
  return blockerIndex < 0 ? pipeline.rules.length : blockerIndex
}
