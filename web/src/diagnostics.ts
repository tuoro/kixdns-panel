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
    // 结论带是一行话：命中很多条时只点前三条，其余在执行路径里逐条可见。
    // The verdict is one line: with many matches it names the first three, and the path lists them all.
    const named = summary.matchedRules.slice(0, 3).join('、')
    const rules = summary.matchedRules.length > 3 ? `${named} 等 ${summary.matchedRules.length} 条规则` : named
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

// 内核用 hickory 的 Display 写响应码（「No Error」「Server Failure」）；面板其余地方
// 都用 DNS 的写法（NOERROR、SERVFAIL），这里统一过来。不认识的原样交还。
// The kernel writes response codes with hickory's Display ("No Error", "Server
// Failure"); the rest of the panel uses the DNS mnemonics (NOERROR, SERVFAIL),
// so this aligns them. Anything unknown is returned as it came.
const RESPONSE_CODE_NAMES: Record<string, string> = {
  noerror: 'NOERROR', formerror: 'FORMERR', formerr: 'FORMERR',
  serverfailure: 'SERVFAIL', servfail: 'SERVFAIL',
  nonexistentdomain: 'NXDOMAIN', nxdomain: 'NXDOMAIN',
  notimplemented: 'NOTIMP', notimp: 'NOTIMP',
  queryrefused: 'REFUSED', refused: 'REFUSED',
}

export function responseCodeName(code: string): string {
  return RESPONSE_CODE_NAMES[code.replace(/[\s-]/g, '').toLowerCase()] ?? code
}

const TRANSPORT_NAMES: Record<string, string> = {
  Udp: 'UDP', Tcp: 'TCP', TcpUdp: 'TCP+UDP', Doh: 'DoH', Https: 'DoH', Dot: 'DoT', Tls: 'DoT', Doq: 'DoQ', Quic: 'DoQ',
}

/**
 * 把执行轨迹细节里程序内部的写法翻成人话，其余一字不动。
 *
 * 轨迹细节由内核补丁拼出来，有几处是 Rust 值的原样输出：传输写成
 * 「Some(Https)」「None」，截断写成「false」，响应码是 hickory 的 Display。
 * 只替换这几种认得出的片段；认不出的照原样显示，不猜。
 *
 * Turns the program-internal spellings in a trace detail into words and
 * leaves the rest untouched. The kernel patch builds these details, and a few
 * are raw Rust values: the transport as "Some(Https)" or "None", truncation as
 * "false", the response code as hickory's Display. Only those recognisable
 * fragments are replaced; anything else is shown as it came, never guessed at.
 */
export function humanizeTraceDetail(detail: string): string {
  return detail
    .replace(/传输：Some\((\w+)\)/g, (whole, name: string) => (TRANSPORT_NAMES[name] ? `传输：${TRANSPORT_NAMES[name]}` : whole))
    .replace(/传输：None/g, '传输：自动')
    .replace(/截断：false/g, '未截断')
    .replace(/截断：true/g, '已截断')
    .replace(/响应码：([^；;]+)/g, (_, code: string) => `响应码：${responseCodeName(code.trim())}`)
    // 数字和单位之间换成不断行空格：窄屏上「12」和「ms」曾被折到两行。
    // A no-break space between a number and its unit: a phone once folded "12" and "ms" onto two lines.
    .replace(/(\d) ms\b/g, '$1\u00a0ms')
}

const STATUS_WORDS = new Set(Object.values(traceStatusNames))

/**
 * 步骤标题里的标签：内核给缓存一类步骤的标签常常是「阶段名 + 结果词」（响应缓存未命中），
 * 和前面的阶段名、下面的结果行各重复一次，这种情况只留阶段名；多出别的内容就照原样留着。
 * The label in a step's title: the kernel often labels cache-like steps as
 * stage name plus outcome word ("响应缓存未命中"), repeating both the stage
 * name before it and the outcome line below; then only the stage name stays.
 * A label that carries anything more is kept as it came.
 */
export function traceStepLabel(step: Pick<DnsTraceStep, 'stage' | 'label'>): string {
  const stage = traceStageNames[step.stage]
  if (!stage || !step.label.startsWith(stage)) return step.label
  const rest = step.label.slice(stage.length).trim()
  return rest === '' || STATUS_WORDS.has(rest) ? '' : step.label
}
