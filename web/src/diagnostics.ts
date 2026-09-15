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
  hit: '命中', fresh: '缓存命中', stale: '续用旧结果', succeeded: '成功', failed: '失败', error: '错误',
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
  const upstreams = [...new Set(steps.filter((step) => step.stage === 'upstream' && step.status === 'succeeded').map((step) => step.label))]
  return {
    matchedRules,
    pipelines,
    upstreams,
    responseCacheHit,
    emptyMatchLabel: responseCacheHit ? '响应缓存命中，未记录规则匹配' : '未记录规则匹配',
  }
}

export type TraceSummary = ReturnType<typeof summarizeTrace>

/**
 * 结论带上那句话：响应码之外还要回答「走了谁」。
 *
 * 没有轨迹、或轨迹里既没有命中规则也没有上游时返回空串——
 * 这时结论带只写响应码和耗时，不编一句听起来像知道内情的话。
 *
 * The sentence on the verdict strip: besides the response code, it answers
 * which path the query took. Returns an empty string when there is no trace, or
 * when the trace records neither a matched rule nor an upstream: the strip then
 * carries only the code and the elapsed time rather than inventing a sentence
 * that sounds better informed than the data is.
 */
export function describeResolution(summary: TraceSummary): string {
  const parts: string[] = []
  if (summary.matchedRules.length) {
    const rules = summary.matchedRules.join('、')
    parts.push(summary.pipelines.length ? `命中 ${summary.pipelines.join('、')} 的 ${rules}` : `命中 ${rules}`)
  } else if (summary.responseCacheHit) {
    parts.push('响应缓存命中')
  }
  if (summary.upstreams.length) parts.push(`由 ${summary.upstreams.join('、')} 应答`)
  return parts.join('，')
}

export function isDnsSuccess(code: string): boolean {
  return code.replace(/\s/g, '').toUpperCase() === 'NOERROR'
}
