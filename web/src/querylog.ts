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
 * 接口给的是内核的说法：耗时是微秒，回答后检查是 phase 为 response 的规则，上游的结果是 success / aborted / rejected / error。
 * 这里换成页面画的样子；内核单记的决定（没有规则命中时列表的默认去处、回答后检查没命中时的去处）并到对应的那一步上，
 * 最后补上回给客户端的那一步。
 * The API speaks the kernel's terms: latencies in microseconds, answer checks as rules whose phase is response, upstream results as
 * success / aborted / rejected / error. This turns them into what the page draws; decisions the kernel records on their own (a list's
 * default when no rule matched, where an unmatched answer check goes) join their step, and the reply to the client is added last.
 */
export function entryOf(record: QueryLogRecord): QueryLogEntry {
  const outcome = record.outcome
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
      steps.push({ at_ms, kind: 'cache', pipeline: here, cache, ...(step.source ? { upstream: step.source } : {}) })
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

export interface Destination {
  /** 去向筛选用的键 / The key the destination filter uses */
  key: string
  label: string
  /** 认不出时是内核原名，用等宽 / A raw kernel name when not recognised, in mono */
  mono: boolean
}

export function destinationOf(entry: QueryLogEntry, ctx: QueryLogContext | null): Destination {
  if (entry.outcome === 'failed') return { key: 'failed', label: '失败', mono: false }
  if (entry.outcome === 'blocked') return { key: 'blocked', label: '拦截', mono: false }
  if (entry.outcome === 'answered') {
    const mapping = ctx ? (ctx.model.mappingId ?? 'domain_mapping') : 'domain_mapping'
    return entry.pipeline === mapping ? { key: 'mapped', label: '域名映射', mono: false } : { key: 'answered', label: '自定义回答', mono: false }
  }
  const group = ctx ? forwardGroups(ctx.pipelines, ctx.model)(entry.pipeline) : undefined
  if (group) return { key: `group:${group.id}`, label: `上游组「${group.name}」`, mono: false }
  if (!ctx) return { key: `pipeline:${entry.pipeline}`, label: entry.pipeline, mono: true }
  return { key: `pipeline:${entry.pipeline}`, ...ownForwardLabel(entry.pipeline, ctx.model, ctx.names) }
}

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
  if (entry.outcome === 'joined') return '合并'
  return null
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
  if (ctx) for (const id of ownForwards(ctx.pipelines, ctx.model)) options.push({ value: `pipeline:${id}`, label: ownForwardLabel(id, ctx.model, ctx.names).label, params: { pipelines: id, outcomes: forwarded } })
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
  if (entry.outcome === 'cancelled') return { tone: 'warn', label: '已取消' }
  if (entry.outcome === 'stale') return { tone: 'warn', label: '过期缓存' }
  if (entry.outcome === 'blocked') return { tone: 'off', label: '拦截' }
  if (entry.rcode === 'NXDOMAIN') return { tone: 'off', label: '域名不存在' }
  if (entry.rcode !== 'NOERROR') return { tone: 'warn', label: entry.rcode }
  return { tone: 'ok', label: '成功' }
}

/** 定下去向的那条规则叫什么：其余请求就叫其余请求，域名映射不单说 / The deciding rule's name: the catch-all reads 其余请求, a mapping is not named */
function ruleLabel(entry: QueryLogEntry, ctx: QueryLogContext | null): string | null {
  if (!entry.rule) return null
  const base = entry.rule.replace(/#\d+$/, '')
  if (/^域名映射 /.test(base)) return null
  if (base === '其余请求' || (ctx && ctx.model.ruleGroups.some((g) => base === `${g.name}·其余`))) return '其余请求'
  return ctx?.names.rule(entry.rule) ?? base
}

/**
 * 表格的去向一格：去了哪，后面跟着定下它的规则（和 Surge 的「DIRECT (DOMAIN-SUFFIX apple.com)」一个意思）。
 * 上游组只写组名，列名已经说了是去向；失败的照样写它去的那个组，失败由行首的红点说。
 * The table's destination cell: where it went, followed by the rule that decided it (the idea of Surge's
 * 「DIRECT (DOMAIN-SUFFIX apple.com)」). An upstream group is just its name, the column says it is a destination; a failed query still
 * names the group it went to, and the red dot says it failed.
 */
export function routeOf(entry: QueryLogEntry, ctx: QueryLogContext | null): { where: string; mono: boolean; rule: string | null } {
  const rule = ruleLabel(entry, ctx)
  if (entry.outcome === 'blocked') return { where: '拦截', mono: false, rule }
  if (entry.outcome === 'answered') {
    const mapping = ctx?.model.mappingId ?? 'domain_mapping'
    return entry.pipeline === mapping ? { where: '域名映射', mono: false, rule: null } : { where: '自定义回答', mono: false, rule }
  }
  const group = ctx ? forwardGroups(ctx.pipelines, ctx.model)(entry.pipeline) : undefined
  if (group) return { where: group.name, mono: false, rule }
  if (!ctx) return { where: entry.pipeline, mono: true, rule }
  const own = ownForwardLabel(entry.pipeline, ctx.model, ctx.names)
  return { where: own.label, mono: own.mono, rule }
}

/** 表格的回答一格：第一条记录加「+N」；没有记录时说为什么 / The table's answer cell: the first record plus 「+N」; without records, why */
export function answerOf(entry: QueryLogEntry): { text: string; more: number; literal: boolean; tone: '' | 'muted' | 'err' } {
  if (entry.outcome === 'failed') return { text: entry.error ?? '没有回答', more: 0, literal: false, tone: 'err' }
  if (entry.outcome === 'cancelled') return { text: '没有回答', more: 0, literal: false, tone: 'muted' }
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
  if (entry.outcome === 'stale') return { text: '过期缓存', literal: false, tone: 'warn' }
  if (entry.outcome === 'joined') return { text: '合并', literal: false, tone: '' }
  if (entry.outcome === 'forwarded' && entry.upstream) return { text: upstreamHost(entry.upstream), full: entry.upstream, literal: true, tone: '' }
  return null
}

const TRANSPORTS: Record<string, string> = { udp: 'UDP', tcp: 'TCP', doh: 'DoH' }
/** 详情页头第二行：客户端、协议、完整时间、耗时 / The detail head's second line: client, protocol, full time, latency */
export function requestLine(entry: QueryLogEntry): string[] {
  const d = new Date(entry.time_unix_ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  const when = `${d.getMonth() + 1}\u00a0月\u00a0${d.getDate()}\u00a0日 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
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
  const said = entry.rule ? ctx?.names.matched(entry.rule.replace(/#\d+$/, '')) : null
  const viaGroup = ctx ? entry.steps.find((st) => st.kind === 'pipeline' && ctx.model.ruleGroups.some((g) => ruleGroupPipelineId(ctx.model, g.id) === st.pipeline)) : undefined
  const whereSub = said ?? (route.rule ? `命中规则「${route.rule}」${viaGroup ? `（在${place(viaGroup.pipeline)}里）` : ''}` : '')
  // 谁回答的 / who answered
  const asked = entry.steps.filter((st) => st.kind === 'upstream')
  const won = [...asked].reverse().find((st) => st.result === 'won')
  // 回答后检查把先回的结果否掉、改问别的列表 / An answer check rejected the first answer and asked another list
  const polluted = entry.steps.find((st) => st.kind === 'check' && st.matched && st.target !== undefined && !DIRECT.has(st.target))
  let who: DetailFact
  if (entry.outcome === 'cached') who = { key: 'who', label: '谁回答的', lead: [[t('缓存')]], sub: entry.upstream ? [t('答案原先来自 '), m(entry.upstream)] : [], tone: '' }
  else if (entry.outcome === 'stale') who = { key: 'who', label: '谁回答的', lead: [[t('过期缓存')]], sub: [t('上游都没回，先回了过期的旧结果')], tone: 'warn' }
  else if (entry.outcome === 'joined') who = { key: 'who', label: '谁回答的', lead: [[t('合并')]], sub: [t('同一时刻有相同的查询，共用了它问上游的结果')], tone: '' }
  else if (entry.outcome === 'failed') who = { key: 'who', label: '谁回答的', lead: [[t('没有上游回答')]], sub: [t(asked.length ? `问了 ${asked.length} 个上游：${entry.error ?? '都没回'}` : entry.error ?? '')], tone: 'err' }
  else if (entry.outcome === 'cancelled') who = { key: 'who', label: '谁回答的', lead: [[t('没有回答')]], sub: [t('回答之前请求就没了：客户端不再等，或者 KixDNS 停了')], tone: 'warn' }
  else if (entry.outcome === 'forwarded' && won) {
    const late = asked.filter((st) => st.result === 'lost' && st.pipeline === won.pipeline).length
    const sub: TextPart[] = [t([won.transport, won.latency_ms !== undefined ? latencyText(won.latency_ms) : null].filter(Boolean).join(' · '))]
    if (polluted) sub.push(t(`；先回的结果没通过回答后检查，改问${polluted.target && polluted.target !== 'continue' ? place(polluted.target) : '别的组'}`))
    else if (late) sub.push(t(`；同时问的另外 ${late} 个就不再等`))
    who = { key: 'who', label: '谁回答的', lead: [[m(won.upstream ?? entry.upstream ?? '')]], sub, tone: '' }
  } else who = { key: 'who', label: '谁回答的', lead: [[t('规则直接回应')]], sub: [t('没有问上游')], tone: '' }
  // 回答了什么 / what came back
  const records = entry.answers.slice(0, 4).map((a) => [m(a)])
  const what: DetailFact = entry.outcome === 'failed'
    ? { key: 'what', label: '回答', lead: [[t('SERVFAIL')]], sub: [t('客户端收到服务器失败')], tone: 'err' }
    : entry.outcome === 'cancelled'
      ? { key: 'what', label: '回答', lead: [[t('没有回答')]], sub: [], tone: '' }
    : { key: 'what', label: '回答', lead: records.length ? records : [[t(answerOf(entry).text)]], sub: whatSub(entry) ? [t(whatSub(entry))] : [], tone: '' }
  return [{ key: 'where', label: '去向', lead: [[t(whereLead)]], sub: whereSub ? [t(whereSub)] : [], tone: '' }, who, what]
}

// 回答那块的小字：只补大字没说的——有记录时是响应码和条数，拦截时说这是拦截的回应，其余是响应码（大字已经是它时不重复）
// The answer block's small line adds only what the large line has not said: the code and count with records, that it is the block's
// response for a block, otherwise the code (never repeated when the large line is the code already)
function whatSub(entry: QueryLogEntry): string {
  if (entry.answers.length) return [entry.rcode, `${entry.answers.length} 条记录`, entry.answers.length > 4 ? '只列前 4 条' : null].filter(Boolean).join(' · ')
  if (entry.outcome === 'blocked') return '规则拦截时回的响应'
  return answerOf(entry).text === entry.rcode ? '' : entry.rcode
}

/** 耗时：1 毫秒以下保留一位小数，1 秒以上用秒 / Latency: one decimal under a millisecond, seconds from one second up */
export function latencyText(ms: number): string {
  if (ms < 1) return `${ms.toFixed(1)} ms`
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}
export const SLOW_MS = 1000

/** 时间：今天的只写时分秒，更早的带上日期 / Time: today's entries show the clock only, older ones the date too */
export function timeText(unixMs: number, now: number = Date.now()): string {
  const d = new Date(unixMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return new Date(now).toDateString() === d.toDateString() ? clock : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock}`
}

export interface StepRow { at: number; tone: 'ok' | 'err' | 'warn' | ''; idle: boolean; decides: boolean; lead: TextPart[]; note: TextPart[] }
const t = (text: string): TextPart => ({ text })
const m = (text: string): TextPart => ({ text, mono: true })

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
    if (step.target === 'continue') return [t('，接着往下')]
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
      else if (step.cache === 'stale') row(step, [t('上游都没回，先回过期的旧结果')], step.upstream ? [t('答案来自 '), m(step.upstream)] : [], 'warn', { decides: true })
      else row(step, [t('缓存里没有，去问上游')], [], '', { idle: true })
    } else if (step.kind === 'joined') {
      row(step, [t('同一时刻有相同的查询，共用它问上游的结果')], [], 'ok', { decides: true })
    } else if (step.kind === 'upstream') {
      const where = m(step.upstream ?? '')
      // 右边的时间已经是累计耗时，这里只写协议和响应码 / The time column already carries the cumulative latency, so this says only the protocol and code
      const facts: TextPart[] = [t([step.transport, step.result === 'error' ? null : step.rcode].filter(Boolean).join(' · '))]
      if (step.result === 'won') { firstAnswer = rows.length; row(step, [where, t(' 先回')], facts, 'ok', { decides: true }) }
      // 别的上游先回了，不再等它：它没回，也就没有响应码 / Another upstream answered first, so this one was not waited for: it did not reply, and has no code
      else if (step.result === 'lost') row(step, [where, t(' 没等它回，另一个先回了')], [t(step.transport ?? '')].filter((p) => p.text), '', { idle: true })
      else if (step.result === 'rejected') row(step, [where, t(` 回了 ${step.rcode ?? '错误'}，这个回答没用`)], [t(step.transport ?? '')].filter((p) => p.text), 'warn')
      else row(step, [where, t(` ${step.error ?? '出错'}`)], [t(step.transport ?? '')].filter((p) => p.text), 'err')
    } else if (step.kind === 'check') {
      const action = then(step)
      const named = step.rule && !generated(step.pipeline) ? `「${ctx?.names.rule(step.rule) ?? step.rule}」` : ''
      if (step.matched && step.target && !DIRECT.has(step.target)) {
        // 先回的那个答案被检查否掉了：它不再是定下结果的一步，不打勾 / The first answer was rejected by the check: no longer the deciding step, so no tick
        if (firstAnswer >= 0) rows[firstAnswer] = { ...rows[firstAnswer]!, tone: '', decides: false }
        row(step, [t(`回答后检查${named}：这个回答不能用，改问${place(step.target)}`)], [], 'warn')
      } else if (step.matched || action.length) {
        row(step, [t(`回答后检查${named}${step.matched ? '命中' : '没命中'}`), ...(step.forward ? [t('，照用这个回答')] : action)], [], step.target === 'block' ? 'err' : '')
      } else row(step, [t(`回答后检查${named}：没发现问题`)], [], '', { idle: true })
    } else if (step.kind === 'response') {
      const ok = step.rcode !== 'SERVFAIL' && entry.outcome !== 'failed'
      const records = entry.answers.length ? `，${entry.answers.length} 条记录` : ''
      // 响应码和协议名是读数，不用等宽（和诊断页一样） / Response codes and protocol names are readings, not mono (as on the diagnostics page)
      row(step, [t(`${ok ? '回给客户端' : '回'} ${step.rcode ?? ''}${ok ? records : entry.error ? `：${entry.error}` : ''}`)], [], ok ? '' : 'err')
    }
  }
  // 回答之前请求就没了：照实说，不编一个响应 / The request was gone before an answer: said plainly, no reply is made up
  if (entry.outcome === 'cancelled') rows.push({ at: entry.latency_ms, tone: 'warn', idle: false, decides: false, lead: [t('回答之前请求就没了')], note: [t('客户端不再等，或者 KixDNS 停了')] })
  if (entry.steps_truncated) rows.push({ at: entry.latency_ms, tone: '', idle: true, decides: false, lead: [t('后面的步骤太多，没有记下')], note: [] })
  return rows
}
