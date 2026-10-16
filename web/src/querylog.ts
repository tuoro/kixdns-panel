import type { QueryLogEntry, QueryLogGap, QueryLogItem, QueryLogRecord, QueryLogStep, QueryLogStepRecord } from './api/types'
import { ruleGroupPipelineId, type Model } from './config-model/model'
import type { TraceNames } from './config-model/trace-names'
import type { TextPart } from './diagnostics'
import { directLabel, forwardGroups, ownForwardLabel, ownForwards, type KernelPipeline } from './request-destinations'

// 查询日志一条记录怎么说：去向和概览的「请求分布」同一套（上游组、拦截、自定义回答、域名映射、失败），处理过程一步一句，
// 名字用配置页上的叫法。
// How a query-log entry reads: the destination uses the overview distribution's terms (upstream group, blocked, custom answer, domain
// mapping, failed), the handling reads one sentence per step, and names are the config page's.

export interface QueryLogContext { model: Model; names: TraceNames; pipelines: KernelPipeline[] }

export const isGap = (item: QueryLogItem): item is QueryLogGap => 'gap' in item

// ---------- 接口记录换成显示用的记录 / API records into display records ----------

const TRANSPORT_NAMES: Record<string, string> = { udp: 'UDP', tcp: 'TCP', tcp_udp: 'TCP+UDP', doh: 'DoH', dot: 'DoT', doq: 'DoQ' }
const ms = (us: number | undefined) => (us ?? 0) / 1000

/**
 * 内核的出错原文是英文（anyhow 的一串原因），按关键词换成一句中文；认不出的返回 null，页面照原文写。
 * The kernel's error text is English (an anyhow chain of causes); known ones become a Chinese phrase, anything else returns null and the
 * page shows the original.
 */
const ERROR_WORDS: [RegExp, string][] = [
  [/the upstream answered (\w+)/i, '上游回了 $1'],
  [/parse upstream response/i, '上游的回答读不懂'],
  [/all upstreams failed/i, '上游都失败了'],
  // 只说 UDP 没回：这句也出现在双发和同批有 TCP 时，那时是内核自己不改用 TCP，不是设置没开
  // Only that UDP got no answer: the same text appears with dual send and with TCP in the same batch, where the kernel itself skips TCP,
  // not because the setting is off
  [/all udp attempts failed/i, 'UDP 没有回答'],
  [/invalid (?:upstream address|doh url|dot upstream url|doq upstream|tls server name)|missing host|should not contain path/i, '上游地址有误'],
  // 证书不对也是在连接时报的：先认它 / A bad certificate is also reported while connecting: it is recognised first
  [/certificate/i, '上游的证书不对'],
  [/connect (?:failed|timeout|error)|client error \(connect\)|dns error|resolve (?:failed|returned no addresses)/i, '连不上上游'],
  [/timeout|timed out/i, '超时'],
  [/connection limit exceeded|no available dns ids/i, '连接上的请求满了'],
  [/tls handshake failed/i, 'TLS 握手失败'],
  [/closed|broken pipe|reset by peer/i, '连接断了'],
  [/(?:read|write|send)\b.*failed|packet too short|response body/i, '收发出错'],
  [/engine failed/i, 'KixDNS 内部出错'],
]
/**
 * 双发（UDP 和 TCP 同时发出）两路都没成时内核的几种写法：一路失败、另一路失败 / 出错 / 超时，或者一路失败时已经没时间等另一路。
 * 返回说得出来的那一路的原因（都说不出时为 null）；不是双发的写法时为 undefined
 * The kernel's shapes when both legs of a dual send (UDP and TCP sent at once) came to nothing: one leg failed and the other failed,
 * errored or timed out, or one failed with no time left to wait for the other. Returns the cause from the leg that names one (null when
 * neither does); undefined when the text is not a dual-send shape
 */
function dualCause(raw: string): string | null | undefined {
  const head = /^(?:udp|tcp) (?:failed|task error)( and no time left for (?:udp|tcp))?: /i.exec(raw)
  if (!head) return undefined
  const rest = raw.slice(head[0].length)
  const other = /; (?:udp|tcp) (?:(?:failed|task error): (.*)|(timed out))$/is.exec(rest)
  if (!other && !head[1]) return undefined
  const legs = [other ? rest.slice(0, other.index) : rest, other?.[1] ?? '']
  // 「UDP 都没回」只说明那一路没回，不是原因 / 「all udp attempts failed」 only says that leg got nothing; it is not a cause
  const said = legs.filter((leg) => leg && !/all udp attempts failed/i.test(leg)).map((leg) => errorWord(leg)).find(Boolean)
  return said ?? (other?.[2] ? '超时' : null)
}
/** 内核的英文出错原因换成中文；short 时双发只给原因，列表那一格放得下 / The kernel's English error in Chinese; with short, a dual send
 * gives only the cause, which fits the list's cell */
export function errorWord(raw: string, short = false): string | null {
  const dual = dualCause(raw)
  // 原因用逗号接：放进「问了 N 个上游：…」「原因：…」里也不会两个冒号连着 / The cause follows a comma, so inside 「问了 N 个上游：…」 or
  // 「原因：…」 no two colons stack
  if (dual !== undefined) return short && dual ? dual : `UDP 和 TCP 都没回${dual ? `，${dual}` : ''}`
  for (const [pattern, word] of ERROR_WORDS) {
    const found = pattern.exec(raw)
    if (found) return word.replace('$1', found[1] ?? '')
  }
  return null
}
/** 内核一次最多记 8 条回答 / The kernel keeps at most 8 answers per record */
const MAX_ANSWERS = 8
// ---------- 设置的检查：和服务端同一套规则，页面先说，不等保存失败 / settings checks: the server's rules, said before a save fails ----------

/** 保存多久（小时）：1 到 8760 的整数 / Retention in hours: an integer from 1 to 8760 */
export function hoursProblem(text: string): string {
  return /^\d+$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= 8760 ? '' : '保存多久填 1 到 8760 之间的整数小时'
}
/** 最多占用（MB）：10 MB 到 100 GB / The cap in MB: 10 MB to 100 GB */
export function capProblem(text: string): string {
  return /^\d+$/.test(text.trim()) && Number(text) >= 10 && Number(text) <= 102_400 ? '' : '最多占用填 10 到 102400 之间的整数 MB'
}
/**
 * 不记录的域名：按空白、逗号、顿号分开，去掉「*.」和两头的点、转小写、去重；只认 ASCII 的域名，最多 1000 个
 * Ignored domains: split on blanks, commas and enumeration commas; 「*.」 and dots at both ends dropped, lowercased, deduplicated;
 * ASCII domain names only, at most 1000
 */
export function ignoredDomains(text: string): { domains: string[]; problem: string } {
  const domains: string[] = []
  // 全角的字母、数字和句号（中文输入法常打出来的）先换成半角 / Full-width letters, digits and stops (easily typed with a Chinese input
  // method) become half-width first
  for (const raw of text.normalize('NFKC').replace(/。/g, '.').split(/[\s,，、]+/)) {
    const domain = raw.trim().replace(/^\*\./, '').replace(/^\.+|\.+$/g, '').toLowerCase()
    if (!domain) continue
    if (domain.length > 253 || !/^[a-z0-9._-]+$/.test(domain)) {
      // 按错在哪给提示：贴了网址、写了中文、或者混进了别的字符 / The hint follows the mistake: a pasted URL, Chinese, or other characters
      const shown = raw.trim()
      const hint = /[:/]/.test(shown) ? '只填域名，不带 https:// 和路径'
        : /\p{Script=Han}/u.test(shown) ? '中文域名要先转成 xn-- 开头的写法'
          : /[^\x00-\x7f]/.test(shown) ? '带非英文字母的域名要先转成 xn-- 开头的写法'
            : '域名只能有字母、数字、点、连字符和下划线'
      return { domains, problem: `「${shown}」不是域名：${hint}` }
    }
    if (!domains.includes(domain)) domains.push(domain)
  }
  return domains.length > 1000 ? { domains, problem: '不记录的域名最多 1000 个' } : { domains, problem: '' }
}

/** 回 SERVFAIL、REFUSED 这类的应答用不上；NXDOMAIN 是正常的回答 / Replies such as SERVFAIL and REFUSED are not usable; NXDOMAIN is a normal answer */
const usable = (rcode: string | undefined) => !rcode || rcode === 'NOERROR' || rcode === 'NXDOMAIN'

/**
 * 接口给的是内核的说法：耗时是微秒，回答后检查是 phase 为 response 的规则，上游的结果是 success / aborted / rejected / error。
 * 这里换成页面画的样子；内核单记的决定（没有规则命中时列表的默认去处、回答后检查没命中时的去处）并到对应的那一步上，
 * 最后补上回给客户端的那一步。
 * The API speaks the kernel's terms: latencies in microseconds, answer checks as rules whose phase is response, upstream results as
 * success / aborted / rejected / error. This turns them into what the page draws; decisions the kernel records on their own (a list's
 * default when no rule matched, where an unmatched answer check goes) join their step, and the reply to the client is added last.
 */
export function entryOf(record: QueryLogRecord): QueryLogEntry {
  // 拦截时回 SERVFAIL：内核记成失败，面板服务端写入时按规则认回拦截；认不出规则（配置对不上）时这里照样当拦截——面板自己的配置里，
  // 固定回 SERVFAIL 只来自拦截
  // A block answering SERVFAIL: the kernel records it as failed and the panel server turns it back into a block by its rule when writing;
  // when the rule cannot be found (the configs differ) it is still read as a block here, since in the panel's own configs a fixed SERVFAIL
  // comes only from a block
  const outcome = record.outcome === 'failed' && !record.error && record.steps.some((step) => step.decision === 'static') ? 'blocked' : record.outcome
  const fixed = outcome === 'blocked' ? 'block' : 'answer'
  const steps: QueryLogStep[] = []
  let here = record.steps.find((step) => step.kind === 'pipeline')?.pipeline ?? record.pipeline ?? ''
  // 一条决定在页面上怎么说：跳去的列表、转发的上游，或者直接回应（拦截、直接回答） / How a decision reads on the page: the list
  // jumped to, the upstream forwarded to, or a direct reply (block, answer)
  const decided = (step: QueryLogStepRecord): Pick<QueryLogStep, 'target' | 'forward'> => {
    if (step.decision === 'static') return { target: fixed }
    if (step.decision === 'forward') return { forward: step.target }
    if (step.decision === 'continue') return { target: 'continue' }
    return step.target ? { target: step.target } : {}
  }
  for (const step of record.steps) {
    const at_ms = ms(step.at_us)
    if (step.kind === 'pipeline') {
      here = step.pipeline ?? here
      steps.push({ at_ms, kind: 'pipeline', pipeline: here })
    } else if (step.kind === 'rule' && step.phase === 'response') {
      steps.push({ at_ms, kind: 'check', pipeline: step.pipeline ?? here, rule: step.rule, matched: step.matched ?? false, ...(step.decision ? decided(step) : {}) })
    } else if (step.kind === 'rule') {
      steps.push({ at_ms, kind: 'rule', pipeline: step.pipeline ?? here, rule: step.rule, ...decided(step) })
    } else if (step.kind === 'decision' && step.phase === 'response') {
      // 回答后检查没命中时的去处：并到这条检查上 / Where an unmatched answer check goes: joined to that check
      const check = [...steps].reverse().find((s) => s.kind === 'check' && s.rule === step.rule && s.pipeline === (step.pipeline ?? here) && s.target === undefined && s.forward === undefined)
      if (check) Object.assign(check, decided(step))
      else steps.push({ at_ms, kind: 'check', pipeline: step.pipeline ?? here, rule: step.rule, matched: true, ...decided(step) })
    } else if (step.kind === 'decision') {
      // 没有规则命中，列表的默认去处 / No rule matched: the list's default
      steps.push({ at_ms, kind: 'rule', pipeline: step.pipeline ?? here, rule: step.rule, ...decided(step) })
    } else if (step.kind === 'cache') {
      const cache = step.result === 'fresh' ? 'fresh' : step.result === 'miss' ? 'miss' : 'stale'
      const stale = step.result === 'stale_timeout' ? 'timeout' : step.result === 'stale_failure' ? 'failure' : 'now'
      steps.push({ at_ms, kind: 'cache', pipeline: here, cache, ...(cache === 'stale' ? { stale } : {}), ...(step.source ? { upstream: step.source } : {}) })
    } else if (step.kind === 'joined') {
      steps.push({ at_ms, kind: 'joined', pipeline: here })
    } else if (step.kind === 'upstream') {
      const result = step.result === 'success' ? 'won' : step.result === 'aborted' ? 'lost' : step.result === 'rejected' ? 'rejected' : 'error'
      const protocol = step.via ?? step.transport
      steps.push({ at_ms, kind: 'upstream', pipeline: here, upstream: step.upstream, transport: protocol ? (TRANSPORT_NAMES[protocol] ?? protocol) : undefined, result, rcode: step.rcode, latency_ms: ms(step.latency_us), error: step.error })
    }
  }
  const latency = ms(record.latency_us)
  // 回给客户端的那一步：取消的什么也没回 / The reply to the client: a cancelled query got none
  if (outcome !== 'cancelled') steps.push({ at_ms: latency, kind: 'response', pipeline: here, rcode: record.rcode ?? 'SERVFAIL' })
  return {
    id: record.id,
    time_unix_ms: record.time_unix_ms,
    client: record.client,
    transport: record.transport ?? null,
    qname: record.qname,
    qtype: record.qtype,
    pipeline: record.pipeline ?? here,
    rule: record.rule ?? null,
    outcome,
    upstream: record.upstream ?? null,
    rcode: record.rcode ?? (record.status === 'failed' ? 'SERVFAIL' : ''),
    answers: record.answers,
    latency_ms: latency,
    error: record.error ?? null,
    steps,
    steps_truncated: record.steps_truncated ?? false,
  }
}

export const itemOf = (item: QueryLogRecord | QueryLogGap): QueryLogItem => ('gap' in item ? item : entryOf(item))

/** 概览「请求分布」的一行在查询日志里对应哪个去向 / Which query-log destination a row of the overview's 请求分布 stands for */
export function destinationOfRow(key: string, model: Model): string {
  if (key === 'mapping') return 'mapped'
  if (key === 'direct') {
    const label = directLabel(model)
    return label === '拦截' ? 'blocked' : label === '自定义回答' ? 'answered' : 'direct'
  }
  return key.startsWith('group:') ? key : `pipeline:${key}`
}

/** 去向旁边的小标记：答案不是这次现问上游拿到的 / The small tag beside the destination: the answer did not come from asking an upstream just now */
export function sourceTag(entry: QueryLogEntry): string | null {
  if (entry.outcome === 'cached') return '缓存'
  if (entry.outcome === 'stale') return '过期缓存'
  if (entry.outcome === 'joined' || joinedFailure(entry)) return '共用'
  return null
}
/** 共用了同样的查询的结果、那次失败了：内核把失败的结果交给每个等着的，记成失败 / Shared another query's result and that one failed: the
 * kernel hands its failure to everyone waiting, recorded as failed */
function joinedFailure(entry: QueryLogEntry): boolean {
  return entry.outcome === 'failed' && entry.steps.some((st) => st.kind === 'joined')
}

/** 去向筛选：选项和对应的接口参数 / The destination filter: options and the API parameters they map to */
export interface DestinationOption { value: string; label: string; params: Record<string, string> }
export function destinationOptions(ctx: QueryLogContext | null): DestinationOption[] {
  const groups = ctx ? ctx.model.groups : []
  const groupOf = ctx ? forwardGroups(ctx.pipelines, ctx.model) : () => undefined
  const pipelineIds = ctx ? ctx.pipelines.map((p) => p.id).filter((id): id is string => typeof id === 'string') : []
  const options: DestinationOption[] = [{ value: '', label: '全部去向', params: {} }]
  const forwarded = 'forwarded,cached,stale,joined'
  for (const g of groups) {
    const ids = pipelineIds.filter((id) => groupOf(id)?.id === g.id)
    if (ids.length) options.push({ value: `group:${g.id}`, label: `上游组「${g.name}」`, params: { pipelines: ids.join(','), outcomes: forwarded } })
  }
  if (ctx) for (const id of ownForwards(ctx.pipelines, ctx.model)) options.push({ value: `pipeline:${id}`, label: ownForwardLabel(id, ctx.model, ctx.names), params: { pipelines: id, outcomes: forwarded } })
  const mapping = ctx?.model.mappingId ?? 'domain_mapping'
  const unmapped = pipelineIds.filter((id) => id !== mapping).join(',')
  options.push(
    { value: 'blocked', label: '拦截', params: { outcomes: 'blocked' } },
    { value: 'answered', label: '自定义回答', params: { outcomes: 'answered', pipelines: unmapped } },
  )
  // 概览把拦截和自定义回答并成一行时（或者认不出是哪种），从那一行跳过来要有对应的一项 / When the overview folds blocks and custom answers into one row (or cannot tell which), a jump from that row needs a matching option
  const direct = ctx ? directLabel(ctx.model) : ''
  if (direct && direct !== '拦截' && direct !== '自定义回答') options.push({ value: 'direct', label: direct, params: { outcomes: 'blocked,answered', pipelines: unmapped } })
  options.push({ value: 'mapped', label: '域名映射', params: { outcomes: 'answered', pipelines: mapping } }, { value: 'failed', label: '失败', params: { outcomes: 'failed' } })
  return options
}

// ---------- 表格的一行：状态点、去向、回答、来源 / a table row: status dot, destination, answer, source ----------

/** 一条查询的状态：行首的点和详情里的标签 / A query's status: the dot at the row's start and the tag in the detail */
export interface QueryStatus { tone: 'ok' | 'off' | 'warn' | 'err'; label: string }
export function statusOf(entry: QueryLogEntry): QueryStatus {
  if (entry.outcome === 'failed') return { tone: 'err', label: '失败' }
  if (entry.outcome === 'cancelled') return { tone: 'warn', label: '没处理完' }
  // 过期就先回旧结果是开了过期缓存后的正常用法，不算异常；上游没回、都失败才回旧结果的才提醒
  // Serving an expired answer at once is the normal use of stale serving, not a problem; only falling back after the upstreams missed
  // or failed is flagged
  if (entry.outcome === 'stale' && staleKind(entry) !== 'now') return { tone: 'warn', label: '过期缓存' }
  if (entry.outcome === 'blocked') return { tone: 'off', label: '拦截' }
  if (entry.rcode === 'NXDOMAIN') return { tone: 'off', label: '域名不存在' }
  if (entry.rcode !== 'NOERROR') return { tone: 'warn', label: entry.rcode }
  return { tone: 'ok', label: '成功' }
}

/**
 * 定下去向的规则：记录里的是最后一次决定的那条，经过上游组时那是组里面板生成的转发规则，这时往前找用户自己的那条
 * The deciding rule: the record holds the last decision's, which through an upstream group is the group's generated forward rule; then
 * the user's own rule is found further back
 */
function decidingRule(entry: QueryLogEntry, ctx: QueryLogContext | null): string | null {
  if (!entry.rule || !ctx) return entry.rule
  const generated = (rule: string, pipeline: string) => ctx.names.plumbing(rule.replace(/#\d+$/, ''), pipeline)
  if (!generated(entry.rule, entry.pipeline)) return entry.rule
  return [...entry.steps].reverse().find((step) => step.kind === 'rule' && step.rule && !generated(step.rule, step.pipeline))?.rule ?? null
}

/** 定下去向的那条规则叫什么：其余请求就叫其余请求，域名映射不单说 / The deciding rule's name: the catch-all reads 其余请求, a mapping is not named */
function ruleLabel(entry: QueryLogEntry, ctx: QueryLogContext | null): string | null {
  const deciding = decidingRule(entry, ctx)
  if (!deciding) return null
  const base = deciding.replace(/#\d+$/, '')
  if (/^域名映射 /.test(base)) return null
  if (base === '其余请求' || (ctx && ctx.model.ruleGroups.some((g) => base === `${g.name}·其余`))) return '其余请求'
  return ctx?.names.rule(deciding) ?? base
}

/** 回了过期结果的原因 / Why an expired answer went back */
export function staleKind(entry: QueryLogEntry): 'now' | 'timeout' | 'failure' {
  return entry.steps.find((step) => step.kind === 'cache' && step.cache === 'stale')?.stale ?? 'timeout'
}
const STALE_SHORT = { now: '缓存过期了，先回旧结果', timeout: '上游在「客户端等待」时间内没回，先回过期的旧结果', failure: '上游都失败了，回了过期的旧结果' }
const STALE_LONG = { now: '缓存过期了，没等上游，先回了旧结果', timeout: '上游在「客户端等待」时间内没回，先回了过期的旧结果', failure: '上游都失败了，回了过期的旧结果' }

/**
 * 失败的原因：记录上有就用它（KixDNS 自己出的错），不然看问过的上游各自怎么失败的；内核只把自己的错写在记录上
 * Why it failed: the record's own error when there is one (KixDNS's own failure), otherwise how each upstream asked failed; the kernel
 * puts only its own errors on the record
 */
function failureCause(entry: QueryLogEntry, asked: QueryLogStep[] = entry.steps): { word: string; raw: string[] } {
  // 认不出的原文不放进句子里：只在回给客户端那一步下面原样列出，查问题时能搜 / Original text that is not recognised stays out of the
  // sentences: it is listed as it is only under the reply step, where it can be searched for
  if (entry.error) {
    const word = errorWord(entry.error)
    return word ? { word, raw: [] } : { word: '', raw: [entry.error] }
  }
  const words = new Set<string>()
  const raw = new Set<string>()
  for (const st of asked) {
    if (st.kind !== 'upstream' || st.result !== 'error') continue
    const word = st.error ? errorWord(st.error) : '出错'
    if (word) words.add(word)
    else raw.add(st.error!)
  }
  return { word: [...words].join('、'), raw: [...raw] }
}
/** 列表里写得下的原因：认得出、又只有一个时写它，不然写响应码 / A cause short enough for the list: written when recognised and single, otherwise the code */
function failureWord(entry: QueryLogEntry): string {
  const known = entry.error ? [errorWord(entry.error, true)] : [...new Set(entry.steps.filter((st) => st.kind === 'upstream' && st.result === 'error').map((st) => (st.error ? errorWord(st.error, true) : null)))]
  return (known.length === 1 && known[0]) || entry.rcode || 'SERVFAIL'
}

/**
 * 表格的去向一格：去了哪，后面跟着定下它的规则（和 Surge 的「DIRECT (DOMAIN-SUFFIX apple.com)」一个意思）。
 * 上游组只写组名，列名已经说了是去向；失败的照样写它去的那个组，失败由行首的红点说。
 * The table's destination cell: where it went, followed by the rule that decided it (the idea of Surge's
 * 「DIRECT (DOMAIN-SUFFIX apple.com)」). An upstream group is just its name, the column says it is a destination; a failed query still
 * names the group it went to, and the red dot says it failed.
 */
export function routeOf(entry: QueryLogEntry, ctx: QueryLogContext | null): { where: string; rule: string | null } {
  const rule = ruleLabel(entry, ctx)
  if (entry.outcome === 'blocked') return { where: '拦截', rule }
  if (entry.outcome === 'answered') {
    const mapping = ctx?.model.mappingId ?? 'domain_mapping'
    return entry.pipeline === mapping ? { where: '域名映射', rule: null } : { where: '自定义回答', rule }
  }
  const group = ctx ? forwardGroups(ctx.pipelines, ctx.model)(entry.pipeline) : undefined
  if (group) return { where: group.name, rule }
  if (!ctx) return { where: entry.pipeline, rule }
  return { where: ownForwardLabel(entry.pipeline, ctx.model, ctx.names), rule }
}

/** 表格的回答一格：第一条记录加「+N」；没有记录时说为什么 / The table's answer cell: the first record plus 「+N」; without records, why */
export function answerOf(entry: QueryLogEntry): { text: string; more: number; literal: boolean; tone: '' | 'muted' | 'err' } {
  if (entry.outcome === 'failed') return { text: failureWord(entry), more: 0, literal: false, tone: 'err' }
  if (entry.outcome === 'cancelled') return { text: '没处理完', more: 0, literal: false, tone: 'muted' }
  if (entry.answers.length) return { text: entry.answers[0]!, more: entry.answers.length - 1, literal: true, tone: '' }
  // 拦截回的 NXDOMAIN 不是「域名不存在」，照写响应码 / A block's NXDOMAIN is not 「the domain does not exist」: the code is written as is
  if (entry.outcome === 'blocked') return { text: entry.rcode, more: 0, literal: false, tone: 'muted' }
  if (entry.rcode === 'NXDOMAIN') return { text: '域名不存在', more: 0, literal: false, tone: 'muted' }
  if (entry.rcode !== 'NOERROR') return { text: entry.rcode, more: 0, literal: false, tone: 'muted' }
  return { text: '没有记录', more: 0, literal: false, tone: 'muted' }
}

/** 上游地址只留主机和端口，去掉协议头和路径 / An upstream address down to its host and port, without the scheme or the path */
export function upstreamHost(address: string): string {
  return address.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '') || address
}

/**
 * 表格的来源一格：答案从哪来——缓存、合并，或回答的那个上游（只写主机，完整地址在 full 里）；规则直接回应的空着
 * The table's source cell: cache, joined, or the upstream that answered (the host only, the whole address in full); empty when a
 * rule answered
 */
export function sourceOf(entry: QueryLogEntry): { text: string; full?: string; literal: boolean; tone: '' | 'warn' } | null {
  if (entry.outcome === 'cached') return { text: '缓存', literal: false, tone: '' }
  if (entry.outcome === 'stale') return { text: '过期缓存', literal: false, tone: staleKind(entry) === 'now' ? '' : 'warn' }
  if (entry.outcome === 'joined' || joinedFailure(entry)) return { text: '共用', literal: false, tone: '' }
  if (entry.outcome === 'forwarded' && entry.upstream) return { text: upstreamHost(entry.upstream), full: entry.upstream, literal: true, tone: '' }
  return null
}

const TRANSPORTS: Record<string, string> = { udp: 'UDP', tcp: 'TCP', doh: 'DoH' }
/** 详情页头第二行：客户端、协议、完整时间、耗时 / The detail head's second line: client, protocol, full time, latency */
export function requestLine(entry: QueryLogEntry, now: number = Date.now()): string[] {
  // 日期和列表的日期行一个写法（不是今年的带上年）；日期和时间之间是不断行空格，窄处不把时间单独挤到下一行
  // The date is written as in the list's date rows (with the year when not this year's); a no-break space between date and time keeps
  // the clock from being pushed alone onto the next line
  const when = `${dayText(entry.time_unix_ms, now)}\u00a0${clockText(entry.time_unix_ms)}`
  return [entry.client, ...(entry.transport ? [TRANSPORTS[entry.transport] ?? entry.transport] : []), when, `耗时\u00a0${latencyText(entry.latency_ms).replace(' ', '\u00a0')}`]
}

/**
 * 详情的概况：三块，每块先说一件事（大一号），下面一行小字补充——去了哪、谁回答的、回答了什么。
 * The detail's summary: three blocks, each leading with one fact and a smaller line under it — where it went, who answered, what came back.
 */
export interface DetailFact { key: string; label: string; lead: TextPart[][]; sub: TextPart[]; tone: '' | 'warn' | 'err' }
export function detailFacts(entry: QueryLogEntry, ctx: QueryLogContext | null): DetailFact[] {
  const route = routeOf(entry, ctx)
  const place = (pipeline: string) => {
    const g = ctx ? forwardGroups(ctx.pipelines, ctx.model)(pipeline) : undefined
    return g ? `上游组「${g.name}」` : ctx?.names.pipeline(pipeline) ?? pipeline
  }
  // 去向：上游组写全称；下面说哪条规则定的，经过规则组的话说在哪个组里 / Where: the full group name; below, which rule decided, and the rule group it sat in
  const whereLead = entry.outcome === 'blocked' || entry.outcome === 'answered' ? route.where : place(entry.pipeline)
  const deciding = decidingRule(entry, ctx)
  const said = deciding ? ctx?.names.matched(deciding.replace(/#\d+$/, '')) : null
  const viaGroup = ctx ? entry.steps.find((st) => st.kind === 'pipeline' && ctx.model.ruleGroups.some((g) => ruleGroupPipelineId(ctx.model, g.id) === st.pipeline)) : undefined
  const whereSub = said ?? (route.rule ? `命中规则「${route.rule}」${viaGroup ? `（在${place(viaGroup.pipeline)}里）` : ''}` : '')
  // 谁回答的 / who answered
  const asked = entry.steps.filter((st) => st.kind === 'upstream')
  const won = [...asked].reverse().find((st) => st.result === 'won')
  // 回答后检查把先回的结果否掉、改问别的列表 / An answer check rejected the first answer and asked another list
  const polluted = entry.steps.find((st) => st.kind === 'check' && st.matched && st.target !== undefined && !DIRECT.has(st.target))
  // 上游组自己的检查是它的备用组（配置页这么叫），规则自带的才是回答后检查 / A check in an upstream group's own list is its 备用组 (as the
  // config page calls it); only a rule's own check is a 回答后检查
  const fallback = Boolean(polluted && ctx && forwardGroups(ctx.pipelines, ctx.model)(polluted.pipeline))
  let who: DetailFact
  if (entry.outcome === 'cached') who = { key: 'who', label: '谁回答的', lead: [[t('缓存')]], sub: entry.upstream ? [t('答案原先来自 '), m(entry.upstream)] : [], tone: '' }
  else if (entry.outcome === 'stale') who = { key: 'who', label: '谁回答的', lead: [[t('过期缓存')]], sub: [t(STALE_LONG[staleKind(entry)])], tone: staleKind(entry) === 'now' ? '' : 'warn' }
  else if (entry.outcome === 'joined') who = { key: 'who', label: '谁回答的', lead: [[t('共用')]], sub: [t('同样的查询正在问上游，共用了它的结果')], tone: '' }
  else if (entry.outcome === 'failed') {
    // 回答后检查否掉先回的结果、改问了别处：只看改问以后问的上游 / An answer check rejected the first answer and asked elsewhere: only
    // the upstreams asked after it count
    const after = polluted ? asked.filter((st) => st.at_ms >= polluted.at_ms) : asked
    const redirected = polluted ? (fallback ? '先回的结果不能用，按备用组改问；' : '先回的结果没通过回答后检查；') : ''
    const n = `${polluted ? '改问的' : '问了'} ${after.length} 个上游`
    // 上游回了、可回的是 SERVFAIL 这类用不上的，和上游根本没回分开说 / Upstreams that replied with something unusable (SERVFAIL and the
    // like) are told apart from upstreams that never replied
    const codes = [...new Set(after.filter((st) => st.result !== 'lost' && st.rcode && !usable(st.rcode)).map((st) => st.rcode!))]
    const { word, raw } = failureCause(entry, after)
    // 只有记录上写了错才是 KixDNS 自己出错：内核只把自己的错写在记录上 / Only an error on the record is KixDNS's own: the kernel puts
    // nothing else there
    if (entry.error) {
      const replied = asked.some((st) => st.result === 'won') ? '上游回了，' : ''
      who = { key: 'who', label: '谁回答的', lead: [[t('KixDNS 出错')]], sub: [t(`${replied}${word ? `处理时出错：${word}` : 'KixDNS 处理时出错'}`)], tone: 'err' }
    } else if (joinedFailure(entry) && !after.length) who = { key: 'who', label: '谁回答的', lead: [[t('共用')]], sub: [t('同样的查询正在问上游，那次没拿到能用的回答')], tone: 'err' }
    else if (codes.length) who = { key: 'who', label: '谁回答的', lead: [[t(`上游回了 ${codes.join('、')}`)]], sub: [t(`${redirected}${n}，没有能用的回答`)], tone: 'err' }
    else if (after.length) {
      const replied = after.some((st) => st.result === 'won')
      const lead = polluted ? '改问后没有上游回答' : replied ? '没有能用的回答' : '没有上游回答'
      // 有上游回了就不说「没回」 / With an upstream that replied, 「没回」 is never said
      // 认得出的原因和认不出的「出错」一起说 / Recognised causes and an unrecognised 出错 are said together
      const said = [...new Set([...(word ? word.split('、') : []), ...(raw.length ? ['出错'] : [])])].join('、')
      const tail = said || (replied ? '' : after.length > 1 ? '都没回' : '没回')
      who = { key: 'who', label: '谁回答的', lead: [[t(lead)]], sub: [t(`${redirected}${n}${tail ? `：${tail}` : ''}`)], tone: 'err' }
    } else who = { key: 'who', label: '谁回答的', lead: [[t(polluted ? '改问后没有回答' : '没有回答')]], sub: polluted ? [t(fallback ? '先回的结果不能用，按备用组改问' : '先回的结果没通过回答后检查')] : word ? [t(word)] : [], tone: 'err' }
  } else if (entry.outcome === 'cancelled') who = { key: 'who', label: '谁回答的', lead: [[t('没处理完')]], sub: [t('多半是到了整体请求超时')], tone: 'warn' }
  else if (entry.outcome === 'forwarded' && won) {
    const late = asked.filter((st) => st.result === 'lost' && st.pipeline === won.pipeline).length
    const sub: TextPart[] = [t([won.transport, won.latency_ms !== undefined ? latencyText(won.latency_ms) : null].filter(Boolean).join(' · '))]
    const elsewhere = polluted?.target && polluted.target !== 'continue' ? place(polluted.target) : '别的组'
    if (polluted) sub.push(t(fallback ? `；先回的结果不能用，按备用组改问${elsewhere}` : `；先回的结果没通过回答后检查，改问${elsewhere}`))
    else if (late) sub.push(t(`；没再等同时问的另外\u00a0${late}\u00a0个上游`))
    who = { key: 'who', label: '谁回答的', lead: [[m(won.upstream ?? entry.upstream ?? '')]], sub, tone: '' }
  } else if (won) {
    // 上游回了，回答后检查把它拦下或换掉：回应来自那条检查 / An upstream answered and an answer check blocked or replaced it: the reply
    // came from that check
    who = { key: 'who', label: '谁回答的', lead: [[t('回答后检查')]], sub: [t(`上游回了，回答后检查${entry.outcome === 'blocked' ? '把它拦下了' : '换成了自定义回答'}`)], tone: '' }
  } else who = { key: 'who', label: '谁回答的', lead: [[t('规则直接回应')]], sub: [t('没有问上游')], tone: '' }
  // 回答了什么 / what came back
  const records = entry.answers.slice(0, 4).map((a) => [m(a)])
  const what: DetailFact = entry.outcome === 'failed'
    ? { key: 'what', label: '回答', lead: [[t(entry.rcode || 'SERVFAIL')]], sub: [t('服务器出错')], tone: 'err' }
    : entry.outcome === 'cancelled'
      ? { key: 'what', label: '回答', lead: [[t('SERVFAIL')]], sub: [t('超时时 KixDNS 回的；客户端断开或 KixDNS 停止时什么也没回')], tone: '' }
    : { key: 'what', label: '回答', lead: records.length ? records : [[t(answerOf(entry).text)]], sub: whatSub(entry) ? [t(whatSub(entry))] : [], tone: '' }
  return [{ key: 'where', label: '去向', lead: [[t(whereLead)]], sub: whereSub ? [t(whereSub)] : [], tone: '' }, who, what]
}

// 回答那块的小字：只补大字没说的——有记录时是响应码和条数，拦截时说这是拦截的回应，其余是响应码（大字已经是它时不重复）
// The answer block's small line adds only what the large line has not said: the code and count with records, that it is the block's
// response for a block, otherwise the code (never repeated when the large line is the code already)
function whatSub(entry: QueryLogEntry): string {
  if (entry.answers.length) return [entry.rcode, recordCount(entry), entry.answers.length > 4 ? '只列前 4 条' : null].filter(Boolean).join(' · ')
  if (entry.outcome === 'blocked') return '规则拦截时回的响应'
  return answerOf(entry).text === entry.rcode ? '' : entry.rcode
}

/** 记录条数：到了内核的上限就说「至少」 / The record count: at the kernel's limit it says 至少 */
const recordCount = (entry: QueryLogEntry) => `${entry.answers.length >= MAX_ANSWERS ? '至少 ' : ''}${entry.answers.length} 条记录`

/** 耗时：1 毫秒以下保留一位小数（不到 0.1 毫秒写「<0.1」），1 秒以上用秒 / Latency: one decimal under a millisecond (「<0.1」 below 0.1 ms), seconds from one second up */
export function latencyText(ms: number): string {
  if (ms < 0.05) return '<0.1 ms'
  // 按四舍五入后的值挑单位：0.96 写「1 ms」，999.6 写「1.0 s」 / The unit follows the rounded value: 0.96 reads 「1 ms」, 999.6 reads 「1.0 s」
  if (ms < 0.95) return `${ms.toFixed(1)} ms`
  if (ms < 999.5) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}
export const SLOW_MS = 1000

const pad = (n: number) => String(n).padStart(2, '0')
/** 时分秒 / The clock time */
export function clockText(unixMs: number): string {
  const d = new Date(unixMs)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
/** 日期，和详情页头一个写法：「10 月 15 日」；不是今年的带上年 / The date, written as in the detail head: 「10 月 15 日」, with the year when it is not this year's */
export function dayText(unixMs: number, now: number = Date.now()): string {
  const d = new Date(unixMs)
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : `${d.getFullYear()}\u00a0年\u00a0`
  return `${year}${d.getMonth() + 1}\u00a0月\u00a0${d.getDate()}\u00a0日`
}
/** 时间：今天的只写时分秒，更早的带上日期 / Time: today's entries show the clock only, older ones the date too */
export function timeText(unixMs: number, now: number = Date.now()): string {
  return new Date(now).toDateString() === new Date(unixMs).toDateString() ? clockText(unixMs) : `${dayText(unixMs, now)}\u00a0${clockText(unixMs)}`
}
/** 从哪一刻起（到整点）：设置里说保留着从什么时候起的记录 / From when, to the hour: the settings say from when records are kept */
export function sinceText(unixMs: number, now: number = Date.now()): string {
  return `${dayText(unixMs, now)}\u00a0${pad(new Date(unixMs).getHours())}:00`
}

/** 显示时的一段：keep 的不在中间断行 / A run for display: one marked keep never breaks inside */
export interface GlueRun { text: string; keep: boolean }
// 括号里的一小句（「（在规则组「内网解析」里）」）整个不拆，「（在」不落在行尾 / A short aside in brackets stays whole, so 「（在」 never ends a line
const KEEP_PATTERNS = [/（[^（）]{1,16}）/g, /「[^「」]{1,10}」/g, /回答后检查|上游组|规则组|备用组|连不上|上游|另一个|另外|客户端|直接回答|没等它回|先回了|共用了|没通过|都没回|没有|不能用|能用|失败|结果|改问|过期|交给|面板|来得及|来不及|收不到|连字符|不带|xn--|journalctl -u [\w.-]+/g]
/** 句末：最后一个字连同前一个字（和后面的括号、句号）不拆开 / A sentence's end: the last character stays with the one before it (and any closing bracket or stop) */
const TAIL = /\S\p{Script=Han}[」。）]*$/u
/**
 * 句子在窄处怎么断：10 个字以内的「名字」连同括号不拆开，几个常用词不拆开，最后两个字连着（最后一个字不单独落一行）。
 * 只在显示时切成几段、不拆的那段不换行；文字本身不加看不见的字符，复制和查找照常。
 * Where a sentence may break on narrow screens: a 「name」 of up to 10 characters stays whole with its brackets, a few common words stay
 * whole, and the last two characters stay together (so the last never sits alone on a line). Only the display is cut into runs, the
 * kept ones never wrapping; no invisible characters are added, so copying and finding work as usual.
 */
export function glueText(text: string): GlueRun[] {
  const kept: [number, number][] = []
  for (const pattern of KEEP_PATTERNS) {
    for (const found of text.matchAll(pattern)) {
      const start = found.index
      const end = start + found[0].length
      if (!kept.some(([a, b]) => start < b && end > a)) kept.push([start, end])
    }
  }
  kept.sort((x, y) => x[0] - y[0])
  // 句末那两个字压在别的不拆段上时，把那一段延到句末（「（在规则组「内网解析」里）」不留「里）」单独一行）
  // When the end overlaps another kept run, that run is extended to the end (so 「里）」 never sits alone after a name)
  const tail = TAIL.exec(text)
  if (tail) {
    const last = kept.at(-1)
    if (last && tail.index < last[1]) last[1] = text.length
    else kept.push([tail.index, text.length])
  }
  const runs: GlueRun[] = []
  let at = 0
  for (const [start, end] of kept) {
    if (start > at) runs.push({ text: text.slice(at, start), keep: false })
    runs.push({ text: text.slice(start, end), keep: true })
    at = end
  }
  if (at < text.length) runs.push({ text: text.slice(at), keep: false })
  return runs
}
/**
 * 标题里的域名只在点后面断，最后两段（gstatic.com）连着不留「com」单独一行；太长的一段才放开，免得撑出去
 * A domain in a title breaks only after a dot, the last two labels (gstatic.com) staying together so 「com」 never sits alone; only an
 * over-long label is let go, so it cannot overflow
 */
export function domainParts(name: string): GlueRun[] {
  const labels = name.split(/(?<=\.)/)
  if (labels.length > 1) labels.splice(-2, 2, labels.slice(-2).join(''))
  return labels.map((label) => ({ text: label, keep: label.length <= 24 }))
}
/**
 * 字面量（地址、回答、出错原文）在窄处怎么断：「/」「.」「:」「,」「_」和空格后面可以断（「://」中间不断），24 个字以内的一段不在中间断，
 * 更长的放开，免得撑出去
 * Where a literal (an address, an answer, a raw error) may break: after 「/」「.」「:」「,」「_」 and blanks (never inside 「://」); a
 * piece of up to 24 characters never breaks inside, and a longer one is let go so it cannot overflow
 */
export function literalParts(text: string): GlueRun[] {
  // 只在一串分隔符的后面断：「://」「::」「. 」不从中间拆开 / Break only after a run of separators: 「://」, 「::」 and 「. 」 never split inside
  return text.split(/(?<=[.,_\s:/])(?![.,_\s:/])/).filter(Boolean).map((part) => ({ text: part, keep: part.length <= 24 }))
}

export interface StepRow { at: number; tone: 'ok' | 'err' | 'warn' | ''; idle: boolean; decides: boolean; lead: TextPart[]; note: TextPart[] }
const t = (text: string): TextPart => ({ text })
const m = (text: string): TextPart => ({ text, literal: true })

/** 规则直接回应、不再去别处的几种去向 / The destinations of a rule that replies itself instead of going elsewhere */
const DIRECT = new Set(['block', 'answer', 'continue'])

/** 处理过程：一步一句，按时间排 / The handling, one sentence a step, in time order */
export function stepRows(entry: QueryLogEntry, ctx: QueryLogContext | null): StepRow[] {
  const groupOf = ctx ? forwardGroups(ctx.pipelines, ctx.model) : () => undefined
  // 上游组和规则自带的转发列表是面板替用户生成的：里面那条转发规则不单说，上一步已经说了交给谁
  // Upstream groups and a rule's own forward list are generated by the panel: their forwarding rule goes unsaid, the step before already said where the query went
  const plumbing = new Set(ctx ? ownForwards(ctx.pipelines, ctx.model) : [])
  const generated = (pipeline: string) => Boolean(groupOf(pipeline)) || plumbing.has(pipeline)
  const place = (pipeline: string) => {
    const g = groupOf(pipeline)
    if (g) return `上游组「${g.name}」`
    return ctx?.names.pipeline(pipeline) ?? pipeline
  }
  const toRuleGroup = (target: string) => Boolean(ctx?.model.ruleGroups.some((g) => ruleGroupPipelineId(ctx.model, g.id) === target))
  // 一条决定接在句子后面怎么说 / How a decision continues the sentence
  const then = (step: QueryLogStep): TextPart[] => {
    if (step.forward) return [t('，转发给 '), m(step.forward)]
    if (step.target === 'block') return [t('，拦截')]
    if (step.target === 'answer') return [t('，直接回答')]
    if (step.target === 'continue') return [t('，继续往下')]
    if (!step.target) return []
    // 规则就在这个列表里转发、又认不出上游组时说「直接转发」，不说「交给」它自己 / A rule forwarding inside its own list with no group recognised reads 直接转发, not a hand-off to itself
    if (step.target === step.pipeline && !groupOf(step.target)) return [t('，直接转发')]
    // 转去规则组用规则列表里的动词「转到」 / A hand-off to a rule group uses the rule list's verb 转到
    return [t(`，${toRuleGroup(step.target) ? '转到' : '交给'}${place(step.target)}`)]
  }
  const rows: StepRow[] = []
  const row = (step: QueryLogStep, lead: TextPart[], note: TextPart[] = [], tone: StepRow['tone'] = '', extra: Partial<StepRow> = {}) => rows.push({ at: step.at_ms, tone, idle: false, decides: false, lead, note, ...extra })
  // 按时间排：回答后检查紧跟在先回的那个后面，晚到的回答排在它之后，时间列一路往上走 / In time order: the answer check follows the first answer at once, later answers come after it, and the time column only climbs
  const steps = entry.steps.map((step, index) => ({ step, index })).sort((a, b) => a.step.at_ms - b.step.at_ms || a.index - b.index).map(({ step }) => step)
  let firstAnswer = -1
  // 同一个列表里同时问了几个上游 / How many upstreams the same list asked at once
  const raced = (step: QueryLogStep) => entry.steps.filter((st) => st.kind === 'upstream' && st.pipeline === step.pipeline).length > 1
  // 步骤太多、后面的没记下：说在回给客户端之前 / Too many steps and the rest unrecorded: said before the reply to the client
  let truncatedSaid = false
  const truncated = () => {
    if (!entry.steps_truncated || truncatedSaid) return
    truncatedSaid = true
    rows.push({ at: entry.latency_ms, tone: '', idle: true, decides: false, lead: [t('再往后的步骤太多，没有记下')], note: [] })
  }
  for (const step of steps) {
    if (step.kind === 'pipeline') {
      // 每个查询都从主列表进来，第一步不单说；面板生成的转发列表也不说（上一步已经说了交给谁）
      // Every query enters at the main list, so the first step goes unsaid; a generated forward list neither (the step before says where it went)
      if (step === steps[0] || generated(step.pipeline)) continue
      row(step, [t(`进入${place(step.pipeline)}`)])
    } else if (step.kind === 'rule') {
      if (generated(step.pipeline)) continue
      const said = step.rule ? ctx?.names.matched(step.rule) : null
      const title = step.rule ? (ctx?.names.rule(step.rule) ?? step.rule) : ''
      const head = said ?? (step.rule ? `命中规则「${title}」` : '没有规则命中')
      row(step, [t(head), ...then(step)], [], step.target === 'block' ? 'err' : '')
    } else if (step.kind === 'cache') {
      if (step.cache === 'fresh') row(step, [t('缓存里有，直接回')], step.upstream ? [t('答案来自 '), m(step.upstream)] : [], 'ok', { decides: true })
      else if (step.cache === 'stale') row(step, [t(STALE_SHORT[step.stale ?? 'timeout'])], step.upstream ? [t('答案来自 '), m(step.upstream)] : [], step.stale === 'now' ? 'ok' : 'warn', { decides: true })
      else row(step, [t('缓存里没有，去问上游')], [], '', { idle: true })
    } else if (step.kind === 'joined') {
      // 共用的那次失败了：不打勾 / The shared query failed: no tick
      if (entry.outcome === 'failed') row(step, [t('同样的查询正在问上游，共用了它的结果：失败了')], [], 'warn')
      else row(step, [t('同样的查询正在问上游，共用了它的结果')], [], 'ok', { decides: true })
    } else if (step.kind === 'upstream') {
      const where = m(step.upstream ?? '')
      // 右边的时间已经是累计耗时，这里只写协议和响应码 / The time column already carries the cumulative latency, so this says only the protocol and code
      const facts: TextPart[] = [t([step.transport, step.result === 'error' ? null : step.rcode].filter(Boolean).join(' · '))]
      // 回了 SERVFAIL 这类用不上的：照实说，不打勾 / A reply that cannot be used (SERVFAIL and the like): said as it is, no tick
      if (step.result === 'won' && !usable(step.rcode)) row(step, [where, t(` 回了 ${step.rcode}`)], [t(step.transport ?? '')].filter((p) => p.text), 'warn')
      // 只问了它一个就不说「先回」 / With nobody else asked, it is not 「first」
      // 整条失败了：回了的那个也不是结果，不打勾 / The query failed as a whole: the one that answered is not the result either, so no tick
      else if (step.result === 'won') { firstAnswer = rows.length; row(step, [where, t(raced(step) ? ' 先回' : ' 回了')], facts, 'ok', { decides: entry.outcome !== 'failed' }) }
      // 别的上游先回了，不再等它：它没回，也就没有响应码 / Another upstream answered first, so this one was not waited for: it did not reply, and has no code
      else if (step.result === 'lost') row(step, [where, t(' 没等它回，另一个先回了')], [t(step.transport ?? '')].filter((p) => p.text), '', { idle: true })
      else if (step.result === 'rejected') row(step, [where, t(` 回了 ${step.rcode ?? '错误'}，这个回答没用`)], [t(step.transport ?? '')].filter((p) => p.text), 'warn')
      else {
        // 出错原因换成中文，原文留在下面一行，查问题时能搜 / The cause in Chinese, with the original below for searching
        const word = step.error ? errorWord(step.error) : null
        // 原文单独一行，不和协议名用「·」接在一起（原文换行时点不落在行尾） / The original goes alone on the line, not joined to the protocol
        // with 「·」 (so no dot ends a line when it wraps)
        // 认不出的原文不当一句话说：写「出错」，原文放在下面 / An unrecognised original is not used as the sentence: it says 出错, with the
        // original below
        row(step, [where, t(` ${word ?? '出错'}`)], step.error ? [m(step.error)] : step.transport ? [t(step.transport)] : [], 'err')
      }
    } else if (step.kind === 'check') {
      const action = then(step)
      const named = step.rule && !generated(step.pipeline) ? `「${ctx?.names.rule(step.rule) ?? step.rule}」` : ''
      // 上游组自己的检查是它的备用组（配置页这么叫），命中没命中都这么叫 / A check in an upstream group's own list is its 备用组 (as the
      // config page calls it), matched or not
      const fallback = Boolean(groupOf(step.pipeline))
      const checker = fallback ? '备用组' : `回答后检查${named}`
      if (step.matched && step.target && !DIRECT.has(step.target)) {
        // 先回的那个答案被检查否掉了：它不再是定下结果的一步，不打勾 / The first answer was rejected by the check: no longer the deciding step, so no tick
        if (firstAnswer >= 0) rows[firstAnswer] = { ...rows[firstAnswer]!, tone: '', decides: false }
        row(step, [t(`${checker}：这个回答不能用，改问${place(step.target)}`)], [], 'warn')
      } else if (fallback && !step.matched) row(step, [t('备用组：这个回答能用，不用改问')], [], '', { idle: true })
      else if (step.matched || action.length) {
        // 检查把先回的答案拦下或换掉：那个答案不再是结果，不打勾 / The check blocked or replaced the first answer: that answer is no longer
        // the result, so no tick
        if (step.matched && (step.target === 'block' || step.target === 'answer') && firstAnswer >= 0) rows[firstAnswer] = { ...rows[firstAnswer]!, tone: '', decides: false }
        row(step, [t(`${checker}${step.matched ? '命中' : '没命中'}`), ...(step.forward ? [t('，照用这个回答')] : action)], [], step.target === 'block' ? 'err' : '')
      } else row(step, [t(`${checker}没命中，照用这个回答`)], [], '', { idle: true })
    } else if (step.kind === 'response') {
      truncated()
      const ok = step.rcode !== 'SERVFAIL' && entry.outcome !== 'failed'
      const records = entry.answers.length ? `，${recordCount(entry)}` : ''
      const cause = ok ? { word: '', raw: [] } : failureCause(entry)
      const why: TextPart[] = cause.word ? [t(`原因：${cause.word}`)] : cause.raw.length ? [t('原因：')] : []
      cause.raw.forEach((raw, i) => why.push(...(i || cause.word ? [t('；')] : []), m(raw)))
      // 响应码和协议名是读数，不算字面值（和诊断页一样） / Response codes and protocol names are readings, not literals (as on the diagnostics page)
      row(step, [t(`回给客户端 ${step.rcode ?? ''}${ok ? records : ''}`)], why, ok ? '' : 'err')
    }
  }
  // 到了整体请求超时还没处理完（或者连接断了、KixDNS 停了）：内核记成取消，不编一个响应
  // Unfinished at the overall request timeout (or the connection dropped, or KixDNS stopped): the kernel records it as cancelled, and no
  // reply is made up
  if (entry.outcome === 'cancelled') {
    truncated()
    // 为什么、客户端收到了什么，概况里各说一次，这里不再重复 / Why, and what the client got, are each said once in the summary, not again here
    rows.push({ at: entry.latency_ms, tone: 'warn', idle: false, decides: false, lead: [t('没处理完就结束了')], note: [] })
  }
  return rows
}
