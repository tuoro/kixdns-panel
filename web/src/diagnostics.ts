import type { DnsTraceStep } from './api/types'
import type { TraceNames } from './config-model/trace-names'

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
  request: '请求', pipeline: '规则组', response_cache: '响应缓存', rule_cache: '规则缓存',
  rules: '候选规则', rule: '规则', decision: '动作', upstream: '上游', response_rule: '回答后检查',
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
    // 没截断是常态，不值得写；截断了才说 / Not truncated is the normal case and not worth a word; only truncation is said
    .replace(/[；;]\s*截断：false/g, '')
    .replace(/截断：false\s*[；;]?/g, '')
    .replace(/截断：true/g, '已截断')
    // 内核叫它监听器，配置页里填的是监听标签 / The kernel calls it the listener; the config page fills in a listener tag
    .replace(/监听器：/g, '监听标签：')
    .replace(/响应码：([^；;]+)/g, (_, code: string) => `响应码：${responseCodeName(code.trim())}`)
    // 数字和单位之间换成不断行空格：窄屏上「12」和「ms」曾被折到两行。
    // A no-break space between a number and its unit: a phone once folded "12" and "ms" onto two lines.
    .replace(/(\d) ms\b/g, '$1\u00a0ms')
}

/**
 * 一句话里的一段；mono 是机器值（名字、地址、响应码），用等宽。带 label 的是一对「键 值」，排版时整对一起换行。
 * One run of a sentence; mono marks machine values. A part with a label is a
 * "key value" pair that wraps as one unit.
 */
export interface TextPart { text: string; mono?: boolean; label?: string }

export interface StepView {
  /** 这一步做了什么，一句话。 / What the step did, in one sentence. */
  lead: TextPart[]
  /** 补充的细节，一行，可以为空。 / Supporting detail on one line, possibly empty. */
  note: TextPart[]
}

const t = (text: string): TextPart => ({ text })
const m = (text: string): TextPart => ({ text, mono: true })
const ASCII_ONLY = /^[\x20-\x7e\u00a0]+$/
// 量和协议名不是字面值：「12 ms」「1」「DoH」用正文字，和结果栏、时间列一样；地址、名字、键才用等宽
// Quantities and protocol names are not literals: 「12 ms」, 「1」 and 「DoH」 use the body face like the result bar and time column; addresses, names and keys stay mono
const MEASURE = /^\d+(\.\d+)?(\s*(ms|s|秒|个|条|次))?$/
const PROTOCOL = /^(UDP|TCP|DoT|DoH|DoQ|DoH3|TLS|HTTPS)(\+(UDP|TCP))?$|^(NOERROR|NXDOMAIN|SERVFAIL|REFUSED|FORMERR|NOTIMP|NOTAUTH|NOTZONE|YXDOMAIN|YXRRSET|NXRRSET)$/i
const isLiteral = (value: string) => ASCII_ONLY.test(value) && !MEASURE.test(value) && !PROTOCOL.test(value)

/**
 * 细节里的「键：值；键：值」写成「键 值 · 键 值」，纯 ASCII 的字面值用等宽（量和协议名不算）；没有键的片段照原样。
 * 先经过 humanizeTraceDetail，所以 Some(Https)、false 这类写法已经翻过。
 * "key：value；key：value" becomes "key value · key value", ASCII literals in mono (not quantities or protocol names);
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
    // 键和值是一对，整对换行：窄屏上「监听器」和「default」曾被折到两行。
    // Key and value are one pair that wraps whole: a phone once split 监听器 and default across lines.
    else parts.push({ label: key!.trim(), text: value, mono: isLiteral(value) })
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
/** 这一步把查询转给了谁：动作里的「目标」或「准备转发到 X」；别的步骤返回 null。 / Where this step sends the query, if anywhere. */
export function forwardTarget(step: DnsTraceStep): string | null {
  if (step.stage === 'decision' && /^规则 .+ 转发$/.test(step.label)) return detailValue(step.detail, '目标')
  if (step.stage === 'upstream' && step.status === 'started') return /^准备转发到 (.+)$/.exec(step.label)?.[1] ?? null
  return null
}

/**
 * context.target 是上一次转发的目标：上游应答的正是它时不再重复地址，只写「应答 NOERROR」。
 * context.target is the last forward target: when the reply comes from it, the address is not repeated.
 */
// 规则和规则组：认得出就写配置页上的名字（「」括起来的正文字），认不出才写内核的名字（等宽）
// Rules and rule groups: the config page's name when recognised (body text in 「」), the kernel's name in mono otherwise
export function ruleName(label: string, names?: TraceNames | null): TextPart[] {
  const title = names?.rule(label)
  return title ? [t(`「${title}」`)] : [m(label)]
}
function pipelineName(id: string, names?: TraceNames | null): TextPart[] {
  const said = names?.pipeline(id)
  return said ? [t(said)] : [t('规则组 '), m(id)]
}
// 等宽的名字和前后的中文之间留一个空格，正文字之间不留 / A space between a mono name and the text around it, none between runs of body text
// 空格放在正文字那一边，等宽的名字里不带空格（复制出来是干净的名字） / The space goes on the body-text side, so a mono name never carries one (it copies clean)
function sentence(...runs: (TextPart | TextPart[])[]): TextPart[] {
  const parts = runs.flat().map((part) => ({ ...part }))
  const out: TextPart[] = []
  parts.forEach((part, i) => {
    out.push(part)
    const next = parts[i + 1]
    if (!next || !(part.mono || next.mono) || /\s$/.test(part.text) || /^\s/.test(next.text)) return
    if (!part.mono) part.text += ' '
    else if (!next.mono) next.text = ` ${next.text}`
    else out.push(t(' '))
  })
  return out
}

export interface TraceContext {
  /** 上一次转发的目标 / The last forward target */
  target?: string | null
  /** 内核名字换回配置页名字的办法；没有就照原样 / How to turn kernel names back into the config page's; as they are without it */
  names?: TraceNames | null
}

export function describeStep(step: DnsTraceStep, context: TraceContext = {}): StepView {
  const { stage, status, label, detail } = step
  const names = context.names
  const note = detailParts(detail)
  let match: RegExpExecArray | null
  if (stage === 'request' && status === 'parsed') return { lead: sentence(t('请求'), m(label)), note }
  if (stage === 'pipeline' && status === 'selected') return { lead: sentence(t('进入'), pipelineName(label, names)), note }
  if (stage === 'pipeline' && status === 'jump' && (match = /^(.+?) -> (.+)$/.exec(label))) return { lead: sentence(t('从'), pipelineName(match[1]!, names), t('跳到'), pipelineName(match[2]!, names)), note }
  // 「管线 X」在上一步刚说过，细节里不再重复 / The pipeline was just named one step up, so the detail drops it
  if (stage === 'response_cache') {
    const rest = detailParts(detail, ['管线'])
    if (['miss', 'missed'].includes(status)) return { lead: [t('响应缓存未命中')], note: rest }
    if (['fresh', 'hit'].includes(status)) return { lead: [t('命中响应缓存')], note: rest }
    return { lead: [t(label)], note: rest }
  }
  if (stage === 'rule_cache') {
    if ((match = /^命中管线 (.+) 的规则缓存$/.exec(label))) return { lead: sentence(t('命中'), pipelineName(match[1]!, names), t('的规则缓存')), note }
    if ((match = /^管线 (.+) 的规则缓存未命中$/.exec(label))) return { lead: sentence(pipelineName(match[1]!, names), t('的规则缓存未命中')), note }
  }
  // 匹配器数、答案记录数是内核的计数，读路径的人用不上 / Matcher and answer-record counts are kernel bookkeeping a reader of the path has no use for
  if (stage === 'rule' && status === 'matched') return { lead: sentence(t('命中规则'), ruleName(label, names)), note: detailParts(detail, ['管线', '匹配器数']) }
  if (stage === 'rule' && ['missed', 'miss'].includes(status)) return { lead: sentence(t('规则'), ruleName(label, names), t('未命中')), note: detailParts(detail, ['管线', '匹配器数']) }
  if (stage === 'decision') {
    const target = detailValue(detail, '目标')
    // 转发是紧接着命中的那条规则做的，规则名上一行刚写过 / The forward is done by the rule matched one row up, already named there
    if ((match = /^规则 (.+) 转发$/.exec(label)) && target) return { lead: sentence(t('转发给'), m(target)), note: detailParts(detail, ['目标', '规则']) }
    // 响应码和协议名一样是助记词，不是要照抄的字面值：正文字体，和概览的响应码分布一致
    // Response codes are mnemonics like protocol names, not literals to copy: the body face, matching the overview's response-code distribution
    if ((match = /^静态响应 (.+)$/.exec(label))) return { lead: [t(`直接返回 ${responseCodeName(match[1]!)}`)], note: detailParts(detail, ['答案记录数']) }
    if ((match = /^跳转到管线 (.+)$/.exec(label))) return { lead: sentence(t('跳转到'), pipelineName(match[1]!, names)), note }
  }
  if (stage === 'upstream') {
    if (status === 'started' && (match = /^准备转发到 (.+)$/.exec(label))) return { lead: sentence(t('发往'), m(match[1]!)), note: detailParts(detail, ['规则']) }
    const code = detailValue(detail, '响应码')
    const same = context.target === label
    // 回答本身和总耗时在结果栏和右边的时间列里，这一行只说收到了；不是 NOERROR 才写出响应码
    // The answer and the total time live in the result bar and the time column, so this row only says a reply came; the code is named only when it is not NOERROR
    const heard = code && isDnsSuccess(code) ? [t('收到回答')] : [t(`回答 ${code}`)]
    if (status === 'succeeded' && code) return { lead: same ? heard : sentence(m(label), heard), note: detailParts(detail, ['响应码', '耗时']) }
    if (status === 'failed') return { lead: same ? [t('没有回答')] : sentence(m(label), t('没有回答')), note: detail ? [t(detail)] : [] }
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
  | { kind: 'step'; step: DnsTraceStep; sent?: DnsTraceStep }
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
    // 规则决定转给 X、紧接着真的发往 X，是同一件事说两遍：并成一行，时刻取真正发出的那一刻。
    // A rule deciding to forward to X straight followed by the send to X is one event told twice: one row, timed at the send.
    if (step.stage === 'upstream' && step.status === 'started' && last?.kind === 'step' && !last.sent && last.step.stage === 'decision' && forwardTarget(last.step) === forwardTarget(step)) last.sent = step
    else if (missed && last?.kind === 'missed-rules') last.steps.push(step)
    else if (missed && last?.kind === 'step' && last.step.stage === 'rule' && ['missed', 'miss'].includes(last.step.status)) rows[rows.length - 1] = { kind: 'missed-rules', steps: [last.step, step] }
    else rows.push({ kind: 'step', step })
  }
  return rows
}

/** 一秒以内写毫秒，超过一秒写到一位小数的秒：5003 ms 读起来不如 5.0 s。 / Milliseconds under a second, seconds to one decimal above. */
export function formatElapsed(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}
