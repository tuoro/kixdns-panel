import type { DnsTraceStep } from './api/types'

const MAX_DNS_TTL = 4_294_967_295

export interface DnsAnswerFields {
  owner: string
  ttl: string
  dnsClass: string
  type: string
  data: string
}

// 只拆分明确的记录头；RDATA 保留引号、转义和内部空白，未知格式始终展示原串。
export function parseDnsAnswer(raw: string): DnsAnswerFields | null {
  const match = /^(\S+)[\t ]+(\d+)[\t ]+(IN|CH|HS)[\t ]+([A-Z][A-Z0-9-]*)[\t ]+([^\r\n][\s\S]*)$/.exec(raw)
  if (!match || Number(match[2]) > MAX_DNS_TTL) return null
  return { owner: match[1]!, ttl: match[2]!, dnsClass: match[3]!, type: match[4]!, data: match[5]! }
}

export const traceStageNames: Record<string, string> = {
  request: '请求', pipeline: '管线', response_cache: '响应缓存', rule_cache: '规则缓存',
  rules: '候选规则', rule: '规则', decision: '动作', upstream: '上游', response_rule: '响应规则',
}

export const traceStatusNames: Record<string, string> = {
  parsed: '已解析', selected: '已选择', matched: '命中', missed: '未命中', miss: '未命中',
  hit: '命中', fresh: '缓存命中', stale: '过期缓存', succeeded: '成功', failed: '失败', error: '错误',
  skipped: '已跳过', rejected: '已拒绝',
}

export function traceTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (['matched', 'hit', 'fresh', 'succeeded'].includes(status)) return 'success'
  if (['failed', 'error'].includes(status)) return 'danger'
  if (status === 'stale') return 'warning'
  return 'neutral'
}

export function summarizeTrace(steps: DnsTraceStep[]) {
  const matchedRules = [...new Set(steps.filter((step) => step.stage === 'rule' && step.status === 'matched').map((step) => step.label))]
  const pipelines = [...new Set(steps.filter((step) => step.stage === 'pipeline' && step.status === 'selected').map((step) => step.label))]
  const responseCacheHit = steps.some((step) => step.stage === 'response_cache' && ['hit', 'fresh', 'stale'].includes(step.status))
  const firstMatch = steps.findIndex((step) => step.stage === 'rule' && step.status === 'matched')
  return {
    matchedRules,
    pipelines,
    emptyMatchLabel: responseCacheHit ? '响应缓存命中，未记录规则匹配' : '未记录规则匹配',
    initialStep: firstMatch >= 0 ? firstMatch : steps.length ? steps.length - 1 : null,
  }
}

export function isDnsSuccess(code: string): boolean {
  return code.replace(/\s/g, '').toUpperCase() === 'NOERROR'
}
