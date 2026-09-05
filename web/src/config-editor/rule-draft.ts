import type { RuleConfig } from './types'

export function hasResponseProcessing(rule: RuleConfig): boolean {
  return rule.response_matchers.length > 0
    || rule.response_actions_on_match.length > 0
    || rule.response_actions_on_miss.length > 0
}

export function withResponseState(rule: RuleConfig, enabled: boolean): RuleConfig {
  if (enabled) return rule
  return {
    ...rule,
    response_matchers: [],
    response_matcher_operator: 'and',
    response_actions_on_match: [],
    response_actions_on_miss: [],
  }
}

export function responseValidationErrors(rule: RuleConfig, enabled: boolean): string[] {
  if (!enabled) return []
  const errors: string[] = []
  if (!rule.actions.some((action) => action.type === 'forward')) errors.push('响应处理需要先添加转发动作')
  if (rule.response_actions_on_match.length + rule.response_actions_on_miss.length === 0) {
    errors.push('请至少配置一个响应分支动作')
  }
  return errors
}
