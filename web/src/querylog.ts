import type { QueryLogEntry, QueryLogItem, QueryLogStep } from './api/types'
import { ruleGroupPipelineId, type Model } from './config-model/model'
import type { TraceNames } from './config-model/trace-names'
import type { TextPart } from './diagnostics'
import { directLabel, forwardGroups, ownForwardLabel, ownForwards, type KernelPipeline } from './request-destinations'

// 查询日志一条记录怎么说：去向和概览的「请求分布」同一套（上游组、拦截、自定义回答、域名映射、失败），处理过程一步一句，
// 名字用配置页上的叫法。
// How a query-log entry reads: the destination uses the overview distribution's terms (upstream group, blocked, custom answer, domain
// mapping, failed), the handling reads one sentence per step, and names are the config page's.

export interface QueryLogContext { model: Model; names: TraceNames; pipelines: KernelPipeline[] }

export const isGap = (item: QueryLogItem): item is Extract<QueryLogItem, { gap: number }> => 'gap' in item

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
  if (entry.answers.length) return { text: entry.answers[0]!, more: entry.answers.length - 1, literal: true, tone: '' }
  // 拦截回的 NXDOMAIN 不是「域名不存在」，照写响应码 / A block's NXDOMAIN is not 「the domain does not exist」: the code is written as is
  if (entry.outcome === 'blocked') return { text: entry.rcode, more: 0, literal: false, tone: 'muted' }
  if (entry.rcode === 'NXDOMAIN') return { text: '域名不存在', more: 0, literal: false, tone: 'muted' }
  if (entry.rcode !== 'NOERROR') return { text: entry.rcode, more: 0, literal: false, tone: 'muted' }
  return { text: '没有记录', more: 0, literal: false, tone: 'muted' }
}

/** 表格的来源一格：答案从哪来——缓存、合并，或回答的那个上游；规则直接回应的空着 / The table's source cell: cache, joined, or the upstream that answered; empty when a rule answered */
export function sourceOf(entry: QueryLogEntry): { text: string; literal: boolean; tone: '' | 'warn' } | null {
  if (entry.outcome === 'cached') return { text: '缓存', literal: false, tone: '' }
  if (entry.outcome === 'stale') return { text: '过期缓存', literal: false, tone: 'warn' }
  if (entry.outcome === 'joined') return { text: '合并', literal: false, tone: '' }
  if (entry.outcome === 'forwarded' && entry.upstream) return { text: entry.upstream, literal: true, tone: '' }
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
  const polluted = entry.steps.find((st) => st.kind === 'check' && st.matched)
  let who: DetailFact
  if (entry.outcome === 'cached') who = { key: 'who', label: '谁回答的', lead: [[t('缓存')]], sub: entry.upstream ? [t('答案原先来自 '), m(entry.upstream)] : [], tone: '' }
  else if (entry.outcome === 'stale') who = { key: 'who', label: '谁回答的', lead: [[t('过期缓存')]], sub: [t('上游都没回，先回了过期的旧结果')], tone: 'warn' }
  else if (entry.outcome === 'joined') who = { key: 'who', label: '谁回答的', lead: [[t('合并')]], sub: [t('同一时刻有相同的查询，共用了它问上游的结果')], tone: '' }
  else if (entry.outcome === 'failed') who = { key: 'who', label: '谁回答的', lead: [[t('没有上游回答')]], sub: [t(asked.length ? `问了 ${asked.length} 个上游：${entry.error ?? '都没回'}` : entry.error ?? '')], tone: 'err' }
  else if (entry.outcome === 'forwarded' && won) {
    const late = asked.filter((st) => st.result === 'lost' && st.pipeline === won.pipeline).length
    const sub: TextPart[] = [t([won.transport, won.latency_ms !== undefined ? latencyText(won.latency_ms) : null].filter(Boolean).join(' · '))]
    if (polluted) sub.push(t(`；先回的结果被判为污染，改问${polluted.target ? place(polluted.target) : '别的组'}`))
    else if (late) sub.push(t(`；另外 ${late} 个晚一步`))
    who = { key: 'who', label: '谁回答的', lead: [[m(won.upstream ?? entry.upstream ?? '')]], sub, tone: '' }
  } else who = { key: 'who', label: '谁回答的', lead: [[t('规则直接回应')]], sub: [t('没有问上游')], tone: '' }
  // 回答了什么 / what came back
  const records = entry.answers.slice(0, 4).map((a) => [m(a)])
  const what: DetailFact = entry.outcome === 'failed'
    ? { key: 'what', label: '回答', lead: [[t('SERVFAIL')]], sub: [t('客户端收到服务器失败')], tone: 'err' }
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

/** 处理过程：一步一句，按时间排 / The handling, one sentence a step, in time order */
export function stepRows(entry: QueryLogEntry, ctx: QueryLogContext | null): StepRow[] {
  const groupOf = ctx ? forwardGroups(ctx.pipelines, ctx.model) : () => undefined
  const place = (pipeline: string) => {
    const g = groupOf(pipeline)
    if (g) return `上游组「${g.name}」`
    return ctx?.names.pipeline(pipeline) ?? pipeline
  }
  const rows: StepRow[] = []
  const row = (step: QueryLogStep, lead: TextPart[], note: TextPart[] = [], tone: StepRow['tone'] = '', extra: Partial<StepRow> = {}) => rows.push({ at: step.at_ms, tone, idle: false, decides: false, lead, note, ...extra })
  // 按时间排：回答后检查紧跟在先回的那个后面，晚到的回答排在它之后，时间列一路往上走 / In time order: the answer check follows the first answer at once, later answers come after it, and the time column only climbs
  const steps = entry.steps.map((step, index) => ({ step, index })).sort((a, b) => a.step.at_ms - b.step.at_ms || a.index - b.index).map(({ step }) => step)
  let firstAnswer = -1
  for (const step of steps) {
    if (step.kind === 'pipeline') {
      // 每个查询都从主列表进来，第一步不单说；上游组自己的那段也不说（上一步已经说了交给谁）
      // Every query enters at the main list, so the first step goes unsaid; an upstream group's own list neither (the step before says where it went)
      if (step === steps[0] || groupOf(step.pipeline)) continue
      row(step, [t(`进入${place(step.pipeline)}`)])
    } else if (step.kind === 'rule') {
      const said = step.rule ? ctx?.names.matched(step.rule) : null
      const title = step.rule ? (ctx?.names.rule(step.rule) ?? step.rule) : ''
      const head = said ?? `命中规则「${title}」`
      // 规则就在这个列表里转发、又认不出上游组时说「直接转发」，不说「交给」它自己 / A rule forwarding inside its own list with no group recognised reads 直接转发, not a hand-off to itself
      // 转去规则组用规则列表里的动词「转到」 / A hand-off to a rule group uses the rule list's verb 转到
      const toRuleGroup = (target: string) => Boolean(ctx?.model.ruleGroups.some((g) => ruleGroupPipelineId(ctx.model, g.id) === target))
      const tail = step.target === 'block' ? '，拦截' : step.target === 'answer' ? '，直接回答' : !step.target ? '' : step.target === step.pipeline && !groupOf(step.target) ? '，直接转发' : `，${toRuleGroup(step.target) ? '转到' : '交给'}${place(step.target)}`
      row(step, [t(`${head}${tail}`)], [], step.target === 'block' ? 'err' : '')
    } else if (step.kind === 'cache') {
      if (step.cache === 'fresh') row(step, [t('缓存里有，直接回')], step.upstream ? [t('答案来自 '), m(step.upstream)] : [], 'ok', { decides: true })
      else if (step.cache === 'stale') row(step, [t('上游都没回，先回过期的旧结果')], step.upstream ? [t('答案来自 '), m(step.upstream)] : [], 'warn', { decides: true })
      else row(step, [t('缓存里没有，去问上游')], [], '', { idle: true })
    } else if (step.kind === 'upstream') {
      const where = m(step.upstream ?? '')
      // 右边的时间已经是累计耗时，这里只写协议和响应码 / The time column already carries the cumulative latency, so this says only the protocol and code
      const facts: TextPart[] = [t([step.transport, step.result === 'error' ? null : step.rcode].filter(Boolean).join(' · '))]
      if (step.result === 'won') { firstAnswer = rows.length; row(step, [where, t(' 先回')], facts, 'ok', { decides: true }) }
      else if (step.result === 'lost') row(step, [where, t(' 也回了，晚一步没用上')], facts, '', { idle: true })
      else row(step, [where, t(` ${step.error ?? '出错'}`)], [t(step.transport ?? '')].filter((p) => p.text), 'err')
    } else if (step.kind === 'check') {
      if (step.matched) {
        // 先回的那个答案被检查否掉了：它不再是定下结果的一步，不打勾 / The first answer was rejected by the check: no longer the deciding step, so no tick
        if (firstAnswer >= 0) rows[firstAnswer] = { ...rows[firstAnswer]!, tone: '', decides: false }
        row(step, [t(`回答后检查：结果被污染，改问${step.target ? place(step.target) : '别的组'}`)], [], 'warn')
      }
      else row(step, [t('回答后检查：没发现问题')], [], '', { idle: true })
    } else if (step.kind === 'response') {
      const ok = step.rcode !== 'SERVFAIL' && entry.outcome !== 'failed'
      const records = entry.answers.length ? `，${entry.answers.length} 条记录` : ''
      // 响应码和协议名是读数，不用等宽（和诊断页一样） / Response codes and protocol names are readings, not mono (as on the diagnostics page)
      row(step, [t(`${ok ? '回给客户端' : '回'} ${step.rcode ?? ''}${ok ? records : entry.error ? `：${entry.error}` : ''}`)], [], ok ? '' : 'err')
    }
  }
  return rows
}
