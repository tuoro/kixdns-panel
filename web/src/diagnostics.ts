import type { DnsTraceStep } from './api/types'
import type { TraceNames } from './config-model/trace-names'
import { errorWord, STALE_SHORT } from './querylog'

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
  parsed: '已解析', selected: '已选择', matched: '命中', missed: '没命中', miss: '没命中',
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
 * 一句话里的一段；literal 是机器写法的值（名字、地址），和前后的中文之间留空格。带 label 的是一对「键 值」，排版时整对一起换行。
 * One run of a sentence; literal marks a machine-written value (a name, an address), spaced from the words around it. A part
 * with a label is a "key value" pair that wraps as one unit.
 */
export interface TextPart { text: string; literal?: boolean; label?: string }

export interface StepView {
  /** 这一步做了什么，一句话。 / What the step did, in one sentence. */
  lead: TextPart[]
  /** 补充的细节，一行，可以为空。 / Supporting detail on one line, possibly empty. */
  note: TextPart[]
}

const t = (text: string): TextPart => ({ text })
const m = (text: string): TextPart => ({ text, literal: true })
const ASCII_ONLY = /^[\x20-\x7e\u00a0]+$/
// 量和协议名不是字面值：「12 ms」「1」「DoH」是读数，和结果栏、时间列一样；地址、名字、键才是
// Quantities and protocol names are not literals: 「12 ms」, 「1」 and 「DoH」 are readings like the result bar and time column; addresses, names and keys are
const MEASURE = /^\d+(\.\d+)?(\s*(ms|s|秒|个|条|次))?$/
const PROTOCOL = /^(UDP|TCP|DoT|DoH|DoQ|DoH3|TLS|HTTPS)(\+(UDP|TCP))?$|^(NOERROR|NXDOMAIN|SERVFAIL|REFUSED|FORMERR|NOTIMP|NOTAUTH|NOTZONE|YXDOMAIN|YXRRSET|NXRRSET)$/i
const isLiteral = (value: string) => ASCII_ONLY.test(value) && !MEASURE.test(value) && !PROTOCOL.test(value)

/**
 * 细节里的「键：值；键：值」写成「键 值 · 键 值」，纯 ASCII 的值算字面值（量和协议名不算）；没有键的片段照原样。
 * 先经过 humanizeTraceDetail，所以 Some(Https)、false 这类写法已经翻过。
 * "key：value；key：value" becomes "key value · key value", ASCII values marked as literals (not quantities or protocol names);
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
    else parts.push({ label: key!.trim(), text: value, literal: isLiteral(value) })
  }
  return parts
}

function detailValue(detail: string | null | undefined, key: string): string | null {
  const match = new RegExp(`${key}：([^；;]+)`).exec(humanizeTraceDetail(detail ?? ''))
  return match ? match[1]!.trim() : null
}

/**
 * 把内核的一步写成一句人话，名字单独标成字面值。内核的标签有的是名字（default、geosite-global），
 * 有的已经是一句话（准备转发到 X、管线 X 的规则缓存未命中）；以前在前面再加阶段名，就成了
 * 「上游 准备转发到 X」。认不出的写法退回「阶段名 标签」，不猜。
 * Writes one kernel step as a sentence with names marked as literals. Kernel labels are
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
// 规则和规则组：认得出就写配置页上的名字（「」括起来），认不出才写内核的名字（字面值）
// Rules and rule groups: the config page's name when recognised (in 「」), the kernel's name as a literal otherwise
export function ruleName(label: string, names?: TraceNames | null): TextPart[] {
  const title = names?.rule(label)
  return title ? [t(`「${title}」`)] : [m(label)]
}
function pipelineName(id: string, names?: TraceNames | null): TextPart[] {
  const said = names?.pipeline(id)
  return said ? [t(said)] : [t('规则组 '), m(id)]
}
// 字面值和前后的中文之间留一个空格，中文之间不留 / A space between a literal and the text around it, none between runs of words
// 空格放在中文那一边，字面值里不带空格（复制出来是干净的名字） / The space goes on the words' side, so a literal never carries one (it copies clean)
function sentence(...runs: (TextPart | TextPart[])[]): TextPart[] {
  const parts = runs.flat().map((part) => ({ ...part }))
  const out: TextPart[] = []
  parts.forEach((part, i) => {
    out.push(part)
    const next = parts[i + 1]
    if (!next || !(part.literal || next.literal) || /\s$/.test(part.text) || /^\s/.test(next.text)) return
    if (!part.literal) part.text += ' '
    else if (!next.literal) next.text = ` ${next.text}`
    else out.push(t(' '))
  })
  return out
}

export interface TraceContext {
  /** 上一次转发的目标 / The last forward target */
  target?: string | null
  /** 内核名字换回配置页名字的办法；没有就照原样 / How to turn kernel names back into the config page's; as they are without it */
  names?: TraceNames | null
  /** 这次查询后来有没有问上游（或者等着同样的查询问） / Whether this query went on to ask upstreams (or waited on the same query asking) */
  asksUpstream?: boolean
}

/** 后来有没有问上游：缓存没命中那一步据此说「去问上游」 / Whether upstreams were asked later: the cache-miss step says 「去问上游」 by it */
export const asksUpstream = (steps: readonly DnsTraceStep[]): boolean => steps.some((step) => step.stage === 'upstream')
/** 连着几条没命中的规则并成的一行 / The row that several consecutive unmatched rules fold into */
export const missedRulesText = (count: number): string => `${count} 条规则没命中`
// 内核写过期缓存的三种说法，换成查询日志里的那三句 / The kernel's three stale-cache labels, turned into the query log's three sentences
const STALE_LABELS: Record<string, string> = {
  命中过期响应缓存: STALE_SHORT.now,
  '客户端等待超时，返回过期缓存': STALE_SHORT.timeout,
  '上游失败，返回过期缓存': STALE_SHORT.failure,
}

export function describeStep(step: DnsTraceStep, context: TraceContext = {}): StepView {
  const { stage, status, label, detail } = step
  const names = context.names
  const note = detailParts(detail)
  let match: RegExpExecArray | null
  if (stage === 'request' && status === 'parsed') return { lead: sentence(t('请求'), m(label)), note }
  if (stage === 'pipeline' && status === 'selected') {
    const said = names?.entry(label)
    return { lead: said ? [t(`进入${said}`)] : sentence(t('进入'), pipelineName(label, names)), note }
  }
  // 步骤的说法和查询日志一样：从「用诊断再测一次」过来，同一件事是同一句话 / Steps read as in the query log: arriving from
  // 用诊断再测一次, the same event is the same sentence
  if (stage === 'pipeline' && status === 'jump' && (match = /^(.+?) -> (.+)$/.exec(label))) return { lead: sentence(pipelineName(match[1]!, names), t('交给'), pipelineName(match[2]!, names)), note }
  // 「管线 X」在上一步刚说过，细节里不再重复 / The pipeline was just named one step up, so the detail drops it
  if (stage === 'response_cache') {
    const rest = detailParts(detail, ['管线'])
    // 内核在看规则之前就查缓存：被规则拦下的也先记一笔没命中，所以后面真的问了上游才说「去问上游」
    // The kernel checks the cache before the rules, so a query a rule blocks logs a miss first: 「去问上游」 only when upstreams were asked
    if (['miss', 'missed'].includes(status)) return { lead: [t(context.asksUpstream ? '缓存里没有，去问上游' : '缓存里没有')], note: rest }
    if (['fresh', 'hit'].includes(status)) return { lead: [t('缓存里有，直接回')], note: rest }
    return { lead: [t(STALE_LABELS[label] ?? label)], note: rest }
  }
  if (stage === 'rule_cache') {
    if ((match = /^命中管线 (.+) 的规则缓存$/.exec(label))) return { lead: sentence(t('命中'), pipelineName(match[1]!, names), t('的规则缓存')), note }
    if ((match = /^管线 (.+) 的规则缓存未命中$/.exec(label))) return { lead: sentence(pipelineName(match[1]!, names), t('的规则缓存没命中')), note }
  }
  // 匹配器数、答案记录数是内核的计数，读路径的人用不上 / Matcher and answer-record counts are kernel bookkeeping a reader of the path has no use for
  if (stage === 'rule' && status === 'matched') {
    // 面板自己生成的规则（其余请求、域名映射）写成整句，不写它们在内核里的名字 / Rules the panel generates (catch-alls, mappings) read as whole sentences, not by their kernel names
    const said = names?.matched(label)
    return { lead: said ? [t(said)] : sentence(t('命中规则'), ruleName(label, names)), note: detailParts(detail, ['管线', '匹配器数']) }
  }
  if (stage === 'rule' && ['missed', 'miss'].includes(status)) return { lead: sentence(t('规则'), ruleName(label, names), t('没命中')), note: detailParts(detail, ['管线', '匹配器数']) }
  // 回答后检查：内核写「响应匹配器 命中 / 未命中」和匹配器数，读的人只要知道结果 / An answer check: the kernel writes 「响应匹配器 命中 /
  // 未命中」 and the matcher count; the reader needs only the outcome
  if (stage === 'response_rule' && status === 'matched') return { lead: [t('回答后检查命中')], note: detailParts(detail, ['匹配器数']) }
  if (stage === 'response_rule' && ['missed', 'miss'].includes(status)) return { lead: [t('回答后检查没命中，照用这个回答')], note: detailParts(detail, ['匹配器数']) }
  if (stage === 'decision') {
    const target = detailValue(detail, '目标')
    // 转发是紧接着命中的那条规则做的，规则名上一行刚写过 / The forward is done by the rule matched one row up, already named there
    if ((match = /^规则 (.+) 转发$/.exec(label)) && target) return { lead: sentence(t('转发给'), m(target)), note: detailParts(detail, ['目标', '规则']) }
    // 响应码和协议名一样是助记词，不是要照抄的字面值：正文字体，和概览的响应码分布一致
    // Response codes are mnemonics like protocol names, not literals to copy: the body face, matching the overview's response-code distribution
    if ((match = /^静态响应 (.+)$/.exec(label))) return { lead: [t(`直接回 ${responseCodeName(match[1]!)}`)], note: detailParts(detail, ['答案记录数']) }
    if ((match = /^跳转到管线 (.+)$/.exec(label))) return { lead: sentence(t('交给'), pipelineName(match[1]!, names)), note }
  }
  if (stage === 'upstream') {
    if (status === 'started' && (match = /^准备转发到 (.+)$/.exec(label))) return { lead: sentence(t('转发给'), m(match[1]!)), note: detailParts(detail, ['规则']) }
    const code = detailValue(detail, '响应码')
    const same = context.target === label
    // 回答本身和总耗时在结果栏和右边的时间列里，这一行只说收到了；不是 NOERROR 才写出响应码
    // The answer and the total time live in the result bar and the time column, so this row only says a reply came; the code is named only when it is not NOERROR
    // 刚转给的就是它：说「上游回了」，不再重复地址 / The one just forwarded to: 「上游回了」, without repeating the address
    const heard = code && isDnsSuccess(code) ? '回了' : `回了 ${responseCodeName(code ?? '')}`
    if (status === 'succeeded' && code) return { lead: same ? [t(`上游${heard}`)] : sentence(m(label), t(heard)), note: detailParts(detail, ['响应码', '耗时']) }
    if (status === 'failed') {
      // 失败说原因（超时、连不上……），内核的英文原文放在下面一行；本来就是中文的照原话 / A failure names its cause (timeout, no
      // connection…) with the kernel's English below; text already in Chinese is used as it is
      const known = detail ? errorWord(detail) : null
      const word = known ?? (detail && !/[a-z]/i.test(detail) ? detail : '出错')
      return { lead: same ? [t(word)] : sentence(m(label), t(word)), note: detail && word !== detail ? [m(detail)] : [] }
    }
    // 同样的查询正在问上游：这次不另发，等它的回答。内核的说法本身就是一句中文，照原话写，不当成地址
    // The same query is already out upstream: this one sends nothing and waits for that answer. The kernel's wording is a Chinese sentence, so it stays words, not an address literal
    if (status === 'joined') return { lead: [t('同样的查询正在问上游，等它的结果')], note }
  }
  const stageName = traceStageNames[stage]
  // 不认识的阶段把阶段标识原样写上：新内核多出来的一步不能悄悄消失。
  // An unknown stage shows its raw id: a step a newer kernel adds must not vanish quietly.
  return { lead: stageName ? [t(stageName + ' '), m(label)] : [m(stage), t(' '), m(label)], note: status in traceStatusNames ? [t(traceStatusNames[status]!), ...prefixed(note)] : note }
}

function prefixed(parts: TextPart[]): TextPart[] {
  return parts.length ? [t(' · '), ...parts] : []
}

/**
 * 去掉内部步骤：转发用的那条规则（和所在的 Pipeline 同名，路径里上一步已经说了进了哪里），以及跳进规则自带的转发 Pipeline、在那里查规则缓存——读者看到的是「命中规则 X，转发给 Y」
 * Drop internal steps: the forward pipelines' own rules (each named after its pipeline, and the path already says where the request went), plus the jump into a
 * rule's own forward pipeline and the rule-cache check there; the reader sees 「命中规则 X，转发给 Y」
 */
export function hidePlumbing(steps: DnsTraceStep[], names?: TraceNames | null): DnsTraceStep[] {
  if (!names) return steps
  const intoOwn = (step: DnsTraceStep): boolean => {
    const target = step.stage === 'decision' ? /^跳转到管线 (.+)$/.exec(step.label)?.[1]
      : step.stage === 'pipeline' && step.status === 'jump' ? /^.+? -> (.+)$/.exec(step.label)?.[1]
        : step.stage === 'rule_cache' ? (/^命中管线 (.+) 的规则缓存$/.exec(step.label) ?? /^管线 (.+) 的规则缓存未命中$/.exec(step.label))?.[1]
          : undefined
    return target !== undefined && names.ownForward(target)
  }
  return steps.filter((step) => !(step.stage === 'rule' && names.plumbing(step.label, detailValue(step.detail, '管线'))) && !intoOwn(step))
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
