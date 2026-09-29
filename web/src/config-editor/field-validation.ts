import { matcherHint } from './matcher-hints'
import { MATCHER_DEFINITIONS } from './schema'
import type { ActionConfig, MatcherConfig, MatcherScope } from './types'

// 必填的格子空着时，错误说出它叫什么，和这一行写的字段名一样：「请填写域名」「请选择 Pipeline」（审计第五轮 B3）
// An empty required field is named in its error as its row labels it: 请填写域名, 请选择 Pipeline (audit round 5, B3)
export function requiredFieldError(label: string, choose = false): string {
  return `${choose ? '请选择' : '请填写'}${/^[A-Za-z0-9]/.test(label) ? ' ' : ''}${label}`
}

export function isRequiredFieldError(message: string): boolean {
  return /^请(?:填写|选择)/.test(message)
}

export function validDnsName(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || /\s/.test(trimmed)) return false
  const withoutRoot = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed
  if (!withoutRoot || new TextEncoder().encode(withoutRoot).length > 253) return false
  return withoutRoot.split('.').every((label) => label.length > 0 && new TextEncoder().encode(label).length <= 63)
}

// GeoSite 条件的值是分类名本身：内核把它原样当标签去查，写成 geosite:cn 永远匹配不上。
// A GeoSite condition's value is the bare category: the kernel looks it up as the tag exactly as written, so geosite:cn never matches.
const GEOSITE_MATCHERS = new Set(['geo_site', 'geo_site_not', 'response_request_domain_geosite', 'response_request_domain_geosite_not'])
export const GEOSITE_PREFIX_ERROR = '只写分类名，去掉 geosite: 前缀'

export function isGeoSiteMatcher(matcher: MatcherConfig): boolean {
  return GEOSITE_MATCHERS.has(matcher.type)
}

export function matcherFieldErrors(matcher: MatcherConfig, scope: MatcherScope): Record<string, string> {
  const errors: Record<string, string> = {}
  const fields = MATCHER_DEFINITIONS[scope].find((item) => item.value === matcher.type)?.fields ?? []
  const required = requiredFieldError(matcherHint(matcher).label, matcher.type === 'qtype')
  for (const field of ['value', 'cidr'] as const) {
    if (fields.includes(field) && !matcher[field]?.trim()) errors[field] = required
  }
  if (!errors.value && isGeoSiteMatcher(matcher) && /^geosite:/i.test(matcher.value?.trim() ?? '')) errors.value = GEOSITE_PREFIX_ERROR
  if (fields.includes('country_codes') && !matcher.country_codes?.some((code) => code.trim())) {
    errors.country_codes = required
  }
  return errors
}

// 动作参数的名字和动作列表里写的一样；CNAME 的「目标」在这里说全，和域名映射页一样叫「目标域名」
// Action parameters are named as the action list labels them; the CNAME 目标 is spelled out as 目标域名, as the mapping tab calls it
const ACTION_REQUIRED = {
  upstream: requiredFieldError('上游'),
  pipeline: requiredFieldError('Pipeline', true),
  ip: requiredFieldError('IP'),
  target: requiredFieldError('目标域名'),
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
  if (requiredField && !action[requiredField]?.trim()) errors[requiredField] = ACTION_REQUIRED[requiredField]
  if (action.type === 'static_txt_response' || action.type === 'replace_txt_response') {
    const values = Array.isArray(action.text) ? action.text : [action.text ?? '']
    if (!values.some((value) => value.trim())) errors.text = requiredFieldError('文本')
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
