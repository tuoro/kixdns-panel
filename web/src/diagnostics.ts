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
  skipped: '已跳过', rejected: '已拒绝', started: '已发出', jump: '跳转',
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

/** 一句话里的一段；mono 是机器值（名字、地址、响应码），用等宽。 / One run of a sentence; mono marks machine values. */
export interface TextPart { text: string; mono?: boolean }

export interface StepView {
  /** 这一步做了什么，一句话。 / What the step did, in one sentence. */
  lead: TextPart[]
  /** 补充的细节，一行，可以为空。 / Supporting detail on one line, possibly empty. */
  note: TextPart[]
}

const t = (text: string): TextPart => ({ text })
const m = (text: string): TextPart => ({ text, mono: true })
const ASCII_ONLY = /^[\x20-\x7e\u00a0]+$/

/**
 * 细节里的「键：值；键：值」写成「键 值 · 键 值」，纯 ASCII 的值用等宽；没有键的片段照原样。
 * 先经过 humanizeTraceDetail，所以 Some(Https)、false 这类写法已经翻过。
 * "key：value；key：value" becomes "key value · key value", ASCII values in mono;
 * fragments without a key stay as they are. humanizeTraceDetail runs first.
 */
export function detailParts(detail: string | null | undefined, skip: string[] = []): TextPart[] {
  if (!detail) return []
  const parts: TextPart[] = []
  for (const fragment of humanizeTraceDetail(detail).split(/[；;]/).map((item) => item.trim()).filter(Boolean)) {
    const [key, ...rest] = fragment.split('：')
    const value = rest.join('：').trim()
    if (rest.length && skip.includes(key!.trim())) continue
    if (parts.length) parts.push(t(' · '))
    if (!rest.length) parts.push(t(fragment))
    else parts.push(t(key!.trim() + ' '), ASCII_ONLY.test(value) ? m(value) : t(value))
  }
  return parts
}

function detailValue(detail: string | null | undefined, key: string): string | null {
  const match = new RegExp(`${key}：([^；;]+)`).exec(humanizeTraceDetail(detail ?? ''))
  return match ? match[1]!.trim() : null
}

/**
 * 把内核的一步写成一句人话，名字单独用等宽。内核的标签有的是名字（default、geosite-global），
 * 有的已经是一句话（准备转发到 X、管线 X 的规则缓存未命中）；以前在前面再加阶段名，就成了
 * 「上游 准备转发到 X」。认不出的写法退回「阶段名 标签」，不猜。
 * Writes one kernel step as a sentence with names in mono. Kernel labels are
 * sometimes a name and sometimes already a sentence; prefixing the stage name
 * produced stutters like "上游 准备转发到 X". Anything unrecognised falls back
 * to "stage label" rather than a guess.
 */
export function describeStep(step: DnsTraceStep): StepView {
  const { stage, status, label, detail } = step
  const note = detailParts(detail)
  let match: RegExpExecArray | null
  if (stage === 'request' && status === 'parsed') return { lead: [t('请求 '), m(label)], note }
  if (stage === 'pipeline' && status === 'selected') return { lead: [t('选中管线 '), m(label)], note }
  if (stage === 'pipeline' && status === 'jump' && (match = /^(.+?) -> (.+)$/.exec(label))) return { lead: [t('从管线 '), m(match[1]!), t(' 跳到 '), m(match[2]!)], note }
  if (stage === 'response_cache') {
    if (['miss', 'missed'].includes(status)) return { lead: [t('响应缓存未命中')], note }
    if (['fresh', 'hit'].includes(status)) return { lead: [t('命中响应缓存')], note }
    return { lead: [t(label)], note }
  }
  if (stage === 'rule_cache') {
    if ((match = /^命中管线 (.+) 的规则缓存$/.exec(label))) return { lead: [t('命中管线 '), m(match[1]!), t(' 的规则缓存')], note }
    if ((match = /^管线 (.+) 的规则缓存未命中$/.exec(label))) return { lead: [t('管线 '), m(match[1]!), t(' 的规则缓存未命中')], note }
  }
  if (stage === 'rule' && status === 'matched') return { lead: [t('命中规则 '), m(label)], note: detailParts(detail, ['管线']) }
  if (stage === 'rule' && ['missed', 'miss'].includes(status)) return { lead: [t('规则 '), m(label), t(' 未命中')], note: detailParts(detail, ['管线']) }
  if (stage === 'decision') {
    const target = detailValue(detail, '目标')
    if ((match = /^规则 (.+) 转发$/.exec(label)) && target) return { lead: [t('决定转发给 '), m(target)], note: [t('规则 '), m(match[1]!), ...prefixed(detailParts(detail, ['目标']))] }
    if ((match = /^静态响应 (.+)$/.exec(label))) return { lead: [t('直接返回 '), m(responseCodeName(match[1]!))], note }
    if ((match = /^跳转到管线 (.+)$/.exec(label))) return { lead: [t('跳转到管线 '), m(match[1]!)], note }
  }
  if (stage === 'upstream') {
    if (status === 'started' && (match = /^准备转发到 (.+)$/.exec(label))) return { lead: [t('发往 '), m(match[1]!)], note: detailParts(detail, ['规则']) }
    const code = detailValue(detail, '响应码')
    if (status === 'succeeded' && code) return { lead: [m(label), t(' 应答 '), m(code)], note: detailParts(detail, ['响应码']) }
    if (status === 'failed') return { lead: [m(label), t(' 没有应答')], note: detail ? [t(detail)] : [] }
  }
  const stageName = traceStageNames[stage]
  // 不认识的阶段把阶段标识原样写上：新内核多出来的一步不能悄悄消失。
  // An unknown stage shows its raw id: a step a newer kernel adds must not vanish quietly.
  return { lead: stageName ? [t(stageName + ' '), m(label)] : [m(stage), t(' '), m(label)], note: status in traceStatusNames ? [t(traceStatusNames[status]!), ...prefixed(note)] : note }
}

function prefixed(parts: TextPart[]): TextPart[] {
  return parts.length ? [t(' · '), ...parts] : []
}

export type TraceRow =
  | { kind: 'step'; step: DnsTraceStep }
  | { kind: 'missed-rules'; steps: DnsTraceStep[] }

/**
 * 连着的两条以上未命中规则并成一行：「3 条规则未命中」，名字都写在细节里，一个不少。
 * 真实轨迹里命中之前的规则逐条记一行，灰的一长串把命中那一步挤出第一屏。
 * Two or more consecutive missed rules fold into one row with every name in its
 * detail. Real traces log each rule tried before the match, and that grey run
 * pushed the matching step off the first screen.
 */
export function groupTrace(steps: DnsTraceStep[]): TraceRow[] {
  const rows: TraceRow[] = []
  for (const step of steps) {
    const missed = step.stage === 'rule' && ['missed', 'miss'].includes(step.status)
    const last = rows[rows.length - 1]
    if (missed && last?.kind === 'missed-rules') last.steps.push(step)
    else if (missed && last?.kind === 'step' && last.step.stage === 'rule' && ['missed', 'miss'].includes(last.step.status)) rows[rows.length - 1] = { kind: 'missed-rules', steps: [last.step, step] }
    else rows.push({ kind: 'step', step })
  }
  return rows
}
