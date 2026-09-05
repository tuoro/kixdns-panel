import { MATCHER_DEFINITIONS } from './schema'
import type { ActionConfig, MatcherConfig, MatcherScope } from './types'

export const REQUIRED_FIELD_ERROR = '请填写此项'

export function validDnsName(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || /\s/.test(trimmed)) return false
  const withoutRoot = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed
  if (!withoutRoot || new TextEncoder().encode(withoutRoot).length > 253) return false
  return withoutRoot.split('.').every((label) => label.length > 0 && new TextEncoder().encode(label).length <= 63)
}

export function matcherFieldErrors(matcher: MatcherConfig, scope: MatcherScope): Record<string, string> {
  const errors: Record<string, string> = {}
  const fields = MATCHER_DEFINITIONS[scope].find((item) => item.value === matcher.type)?.fields ?? []
  for (const field of ['value', 'cidr'] as const) {
    if (fields.includes(field) && !matcher[field]?.trim()) errors[field] = REQUIRED_FIELD_ERROR
  }
  if (fields.includes('country_codes') && !matcher.country_codes?.some((code) => code.trim())) {
    errors.country_codes = REQUIRED_FIELD_ERROR
  }
  return errors
}

export function actionFieldErrors(
  action: ActionConfig,
  currentPipelineId: string,
  pipelineIds: readonly string[] = [],
): Record<string, string> {
  const errors: Record<string, string> = {}
  const requiredFields: Record<string, 'upstream' | 'pipeline' | 'ip' | 'target'> = {
    forward: 'upstream',
    jump_to_pipeline: 'pipeline',
    static_ip_response: 'ip',
    static_cname_response: 'target',
  }
  const requiredField = requiredFields[action.type]
  if (requiredField && !action[requiredField]?.trim()) errors[requiredField] = REQUIRED_FIELD_ERROR
  if (action.type === 'static_txt_response' || action.type === 'replace_txt_response') {
    const values = Array.isArray(action.text) ? action.text : [action.text ?? '']
    if (!values.some((value) => value.trim())) errors.text = REQUIRED_FIELD_ERROR
  }
  if (action.type === 'static_cname_response') {
    if (!errors.target && !validDnsName(action.target ?? '')) errors.target = 'CNAME 目标域名格式无效'
    if (action.ttl !== undefined && (!Number.isInteger(action.ttl) || action.ttl < 0 || action.ttl > 4_294_967_295)) {
      errors.ttl = 'CNAME TTL 必须是 0 到 4294967295 的整数'
    }
  }
  if (action.type === 'jump_to_pipeline' && !errors.pipeline) {
    if (action.pipeline === currentPipelineId) errors.pipeline = '不能跳转到当前 Pipeline'
    else if (pipelineIds.length > 0 && !pipelineIds.includes(action.pipeline ?? '')) errors.pipeline = '目标 Pipeline 不存在'
  }
  return errors
}
