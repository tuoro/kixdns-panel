import { describe, expect, it } from 'vitest'
import type { QueryLogRecord, QueryLogStepRecord } from './api/types'
import { compile, upstreamPipelineId } from './config-model/model'
import { sampleModel } from './config-model/testing/samples'
import { traceNames } from './config-model/trace-names'
import { answerOf, capProblem, dayText, detailFacts, domainParts, entryOf, errorWord, glueText, hoursProblem, ignoredDomains, latencyText, literalParts, requestLine, routeOf, sourceOf, statusOf, stepRows, timeText, upstreamHost, type QueryLogContext } from './querylog'
import type { KernelPipeline } from './request-destinations'

function record(steps: QueryLogStepRecord[], extra: Partial<QueryLogRecord> = {}): QueryLogRecord {
  return {
    id: 7, seq: 41, time_unix_ms: 1_792_065_600_000, client: '192.168.1.9', transport: 'udp', qname: 'www.example.com', qtype: 'A',
    latency_us: 23_400, status: 'completed', outcome: 'forwarded', rcode: 'NOERROR', answers: ['93.184.215.14'], pipeline: 'main',
    rule: 'forward-all', upstream: '1.1.1.1:53', steps, ...extra,
  }
}

function context(): { ctx: QueryLogContext; abroad: string; cn: string } {
  const model = sampleModel()
  const pipelines = compile(model).pipelines as KernelPipeline[]
  return { ctx: { model, names: traceNames(model), pipelines }, abroad: upstreamPipelineId(model, 'abroad'), cn: upstreamPipelineId(model, 'cn') }
}

const text = (parts: { text: string }[]) => parts.map((part) => part.text).join('')

describe('接口记录换成显示用的记录', () => {
  it('微秒换成毫秒，协议用实际走的那个，最后补上回给客户端的那一步', () => {
    const entry = entryOf(record([
      { at_us: 10, kind: 'pipeline', pipeline: 'main' },
      { at_us: 500, kind: 'cache', result: 'miss' },
      { at_us: 21_000, kind: 'upstream', upstream: '223.5.5.5', transport: 'tcp_udp', via: 'udp', result: 'success', latency_us: 20_500, rcode: 'NOERROR' },
    ]))
    expect(entry.latency_ms).toBe(23.4)
    expect(entry.id).toBe(7)
    expect(entry.steps.map((step) => step.kind)).toEqual(['pipeline', 'cache', 'upstream', 'response'])
    expect(entry.steps[2]).toMatchObject({ at_ms: 21, result: 'won', transport: 'UDP', latency_ms: 20.5, pipeline: 'main' })
    expect(entry.steps[3]).toMatchObject({ at_ms: 23.4, kind: 'response', rcode: 'NOERROR' })
  })

  it('上游的四种结果、缓存的过期命中和合并都有对应的说法', () => {
    const entry = entryOf(record([
      { at_us: 0, kind: 'pipeline', pipeline: 'main' },
      { at_us: 1, kind: 'upstream', upstream: 'a', result: 'aborted', latency_us: 1 },
      { at_us: 2, kind: 'upstream', upstream: 'b', result: 'rejected', rcode: 'SERVFAIL', latency_us: 2 },
      { at_us: 3, kind: 'upstream', upstream: 'c', result: 'error', error: '超时', latency_us: 3 },
      { at_us: 4, kind: 'cache', result: 'stale_timeout', source: 'c' },
      { at_us: 5, kind: 'joined' },
    ], { outcome: 'stale' }))
    expect(entry.steps.slice(1, 6).map((step) => step.result ?? step.cache ?? step.kind)).toEqual(['lost', 'rejected', 'error', 'stale', 'joined'])
    expect(entry.steps[4]).toMatchObject({ upstream: 'c' })
  })

  it('规则的决定：跳去的列表、转发的上游、直接回应按结果分拦截和回答', () => {
    const steps: QueryLogStepRecord[] = [
      { at_us: 0, kind: 'pipeline', pipeline: 'main' },
      { at_us: 1, kind: 'rule', pipeline: 'main', rule: 'ads', phase: 'request', decision: 'static' },
    ]
    expect(entryOf(record(steps, { outcome: 'blocked' })).steps[1]).toMatchObject({ kind: 'rule', rule: 'ads', target: 'block' })
    expect(entryOf(record(steps, { outcome: 'answered' })).steps[1]).toMatchObject({ target: 'answer' })
    const forward = entryOf(record([{ at_us: 0, kind: 'rule', pipeline: 'main', rule: 'x', phase: 'request', decision: 'forward', target: '1.1.1.1:53' }]))
    expect(forward.steps[0]).toMatchObject({ forward: '1.1.1.1:53' })
    expect(forward.steps[0]!.target).toBeUndefined()
  })

  it('回答后检查：命中时带着去处；没命中时内核单记的去处并回这条检查；没有规则命中时是列表的默认', () => {
    const entry = entryOf(record([
      { at_us: 0, kind: 'pipeline', pipeline: 'up' },
      { at_us: 1, kind: 'rule', pipeline: 'up', rule: 'poison', phase: 'response', matched: true, decision: 'jump', target: 'fallback' },
      { at_us: 2, kind: 'rule', pipeline: 'up', rule: 'retry', phase: 'response', matched: false },
      { at_us: 3, kind: 'decision', pipeline: 'up', rule: 'retry', phase: 'response', decision: 'static' },
      { at_us: 4, kind: 'decision', pipeline: 'up', phase: 'request', decision: 'forward', target: '9.9.9.9:53' },
    ], { outcome: 'blocked' }))
    expect(entry.steps[1]).toMatchObject({ kind: 'check', matched: true, target: 'fallback' })
    expect(entry.steps[2]).toMatchObject({ kind: 'check', rule: 'retry', matched: false, target: 'block' })
    expect(entry.steps[3]).toMatchObject({ kind: 'rule', forward: '9.9.9.9:53' })
    expect(entry.steps[3]!.rule).toBeUndefined()
    expect(entry.steps).toHaveLength(5)
  })

  it('列表的来源一格只写上游的主机和端口，完整地址留给悬停', () => {
    expect(upstreamHost('https://dns.google/dns-query')).toBe('dns.google')
    expect(upstreamHost('tls://dns.alidns.com:853')).toBe('dns.alidns.com:853')
    expect(upstreamHost('tcp+udp://223.5.5.5')).toBe('223.5.5.5')
    expect(upstreamHost('1.1.1.1:53')).toBe('1.1.1.1:53')
    expect(upstreamHost('[2606:4700::1111]:53')).toBe('[2606:4700::1111]:53')
    expect(sourceOf(entryOf(record([], { upstream: 'https://dns.google/dns-query' })))).toMatchObject({ text: 'dns.google', full: 'https://dns.google/dns-query' })
  })

  it('失败的回 SERVFAIL；没处理完的（内核记成取消）不编一个响应', () => {
    const failed = entryOf(record([], { outcome: 'failed', status: 'failed', rcode: undefined, answers: [], error: '上游全部超时' }))
    expect(failed.rcode).toBe('SERVFAIL')
    expect(failed.steps.at(-1)).toMatchObject({ kind: 'response', rcode: 'SERVFAIL' })
    const cancelled = entryOf(record([], { outcome: 'cancelled', status: 'cancelled', rcode: undefined, answers: [], upstream: undefined }))
    expect(cancelled.rcode).toBe('')
    expect(cancelled.steps.some((step) => step.kind === 'response')).toBe(false)
    expect(statusOf(cancelled)).toEqual({ tone: 'warn', label: '没处理完' })
    expect(answerOf(cancelled).text).toBe('没处理完')
  })
})

describe('处理过程一步一句', () => {
  it('上游组里面板生成的那条转发规则不单说；别的上游先回时不说它也回了', () => {
    const { ctx, abroad } = context()
    const rows = stepRows(entryOf(record([
      { at_us: 0, kind: 'pipeline', pipeline: 'main' },
      { at_us: 10, kind: 'rule', pipeline: 'main', rule: '谷歌', phase: 'request', decision: 'jump', target: abroad },
      { at_us: 20, kind: 'pipeline', pipeline: abroad },
      { at_us: 30, kind: 'rule', pipeline: abroad, rule: `${abroad}-forward`, phase: 'request', decision: 'forward', target: 'https://dns.google/dns-query' },
      { at_us: 9_000, kind: 'upstream', upstream: 'https://dns.google/dns-query', transport: 'doh', via: 'doh', result: 'success', latency_us: 8_900, rcode: 'NOERROR' },
      { at_us: 9_050, kind: 'upstream', upstream: 'https://cloudflare-dns.com/dns-query', transport: 'doh', via: 'doh', result: 'aborted', latency_us: 9_000 },
    ], { pipeline: abroad, latency_us: 9_400 })), ctx)
    const said = rows.map((row) => text(row.lead))
    expect(said).toHaveLength(4)
    expect(said[0]).toContain('交给上游组「国外」')
    expect(said[1]).toBe('https://dns.google/dns-query 先回')
    expect(said[2]).toBe('https://cloudflare-dns.com/dns-query 没等它回，另一个先回了')
    expect(said[3]).toBe('回给客户端 NOERROR，1 条记录')
  })

  it('上游组的备用组否掉先回的结果时，先回的那一步不再打勾；这一步叫备用组，和配置页一样', () => {
    const { ctx, abroad, cn } = context()
    const rows = stepRows(entryOf(record([
      { at_us: 0, kind: 'pipeline', pipeline: cn },
      { at_us: 5_000, kind: 'upstream', upstream: '223.5.5.5', via: 'udp', result: 'success', latency_us: 5_000, rcode: 'NOERROR' },
      { at_us: 5_100, kind: 'rule', pipeline: cn, rule: 'cn-forward', phase: 'response', matched: true, decision: 'jump', target: abroad },
      { at_us: 5_200, kind: 'pipeline', pipeline: abroad },
      { at_us: 40_000, kind: 'upstream', upstream: 'https://dns.google/dns-query', via: 'doh', result: 'success', latency_us: 34_800, rcode: 'NOERROR' },
    ], { pipeline: abroad, latency_us: 40_300 })), ctx)
    const first = rows.find((row) => text(row.lead).startsWith('223.5.5.5'))!
    expect(first.decides).toBe(false)
    expect(rows.map((row) => text(row.lead))).toContain('备用组：这个回答不能用，改问上游组「国外」')
    // 没命中时也叫备用组：一个机制一个名字 / Unmatched, it is still 备用组: one mechanism, one name
    const kept = stepRows(entryOf(record([
      { at_us: 0, kind: 'pipeline', pipeline: cn },
      { at_us: 5_000, kind: 'upstream', upstream: '223.5.5.5', via: 'udp', result: 'success', latency_us: 5_000, rcode: 'NOERROR' },
      { at_us: 5_100, kind: 'rule', pipeline: cn, rule: 'cn-forward', phase: 'response', matched: false },
    ], { pipeline: cn })), ctx)
    expect(kept.map((row) => text(row.lead))).toContain('备用组：这个回答能用，不用改问')
    expect(kept.find((row) => text(row.lead).startsWith('223.5.5.5'))!.decides).toBe(true)
  })

  it('规则自带的列表：回答处理沿用上游组的叫备用组，单独设置的仍叫回答后检查', () => {
    const { ctx } = context()
    const rules = [...ctx.model.rules, ...ctx.model.ruleGroups.flatMap((g) => g.rules)]
    const list = (name: string) => `rule-${rules.find((r) => r.name === name)!.id}`
    const checked = (pipeline: string, check: Partial<QueryLogStepRecord>, extra: Partial<QueryLogRecord> = {}) => stepRows(entryOf(record([
      { at_us: 0, kind: 'pipeline', pipeline },
      { at_us: 5_000, kind: 'upstream', upstream: '1.1.1.1:53', via: 'udp', result: 'success', latency_us: 5_000, rcode: 'NOERROR' },
      { at_us: 5_100, kind: 'rule', pipeline, rule: 'check', phase: 'response', ...check },
    ], { pipeline, ...extra })), ctx).map((row) => text(row.lead))
    // 苹果服务：单独设了 ECS、回答处理沿用上游组「国内」，自带的列表里抄着国内的备用组 / 苹果服务 sets its own ECS and keeps the group's
    // answer handling, so its own list carries a copy of 国内's 备用组
    expect(checked(list('苹果服务'), { matched: false })).toContain('备用组：这个回答能用，不用改问')
    // 防 DNS 重绑定：回答后检查单独设置，转发给「国外」的地址也不算备用组 / 防 DNS 重绑定 sets its own answer check: forwarding to 国外's
    // addresses does not make it a 备用组
    const own = list('防 DNS 重绑定')
    expect(checked(own, { matched: false })).toContain('回答后检查没命中，照用这个回答')
    expect(checked(own, { matched: true, decision: 'static' }, { outcome: 'blocked', rcode: 'REFUSED', answers: [] })).toContain('回答后检查命中，拦截')
  })

  it('回了 SERVFAIL 没用上、没有规则命中、检查没命中、没处理完、步骤太多都照实说', () => {
    const rows = stepRows(entryOf(record([
      { at_us: 0, kind: 'pipeline', pipeline: 'main' },
      { at_us: 1, kind: 'pipeline', pipeline: 'second' },
      { at_us: 2, kind: 'decision', pipeline: 'second', phase: 'request', decision: 'forward', target: '9.9.9.9:53' },
      { at_us: 3, kind: 'upstream', upstream: '9.9.9.9:53', via: 'udp', result: 'rejected', rcode: 'SERVFAIL', latency_us: 3 },
      { at_us: 4, kind: 'rule', pipeline: 'second', rule: 'check', phase: 'response', matched: false },
    ], { outcome: 'cancelled', status: 'cancelled', rcode: undefined, answers: [], steps_truncated: true })), null)
    const said = rows.map((row) => text(row.lead))
    expect(said).toEqual([
      '进入second',
      '没有规则命中，转发给 9.9.9.9:53',
      '9.9.9.9:53 回了 SERVFAIL，这个回答没用',
      '回答后检查「check」没命中，照用这个回答',
      '再往后的步骤太多，没有记下',
      '没处理完就结束了',
    ])
  })

  it('过期缓存分三种说：过期就先回不算异常，上游没回、都失败才提醒', () => {
    const stale = (result: 'stale' | 'stale_timeout' | 'stale_failure') => entryOf(record([{ at_us: 300, kind: 'cache', result, source: '1.1.1.1:53' }], { outcome: 'stale' }))
    expect(statusOf(stale('stale'))).toEqual({ tone: 'ok', label: '成功' })
    expect(sourceOf(stale('stale'))).toMatchObject({ text: '过期缓存', tone: '' })
    expect(text(stepRows(stale('stale'), null)[0]!.lead)).toBe('缓存过期了，先回旧结果')
    expect(statusOf(stale('stale_timeout'))).toEqual({ tone: 'warn', label: '过期缓存' })
    expect(text(stepRows(stale('stale_timeout'), null)[0]!.lead)).toBe('上游在「客户端等待」时间内没回，先回过期的旧结果')
    expect(text(detailFacts(stale('stale_failure'), null)[1]!.sub)).toBe('上游都失败了，回了过期的旧结果')
  })

  it('只问了一个上游、它回了 SERVFAIL：不说没有上游回答，也不打勾', () => {
    const entry = entryOf(record([
      { at_us: 0, kind: 'pipeline', pipeline: 'main' },
      { at_us: 9_000, kind: 'upstream', upstream: '1.1.1.1:53', via: 'udp', result: 'success', rcode: 'SERVFAIL', latency_us: 9_000 },
    ], { outcome: 'failed', status: 'failed', rcode: 'SERVFAIL', answers: [], error: undefined }))
    expect(answerOf(entry)).toMatchObject({ text: 'SERVFAIL', tone: 'err' })
    const who = detailFacts(entry, null)[1]!
    expect(text(who.lead[0]!)).toBe('上游回了 SERVFAIL')
    expect(text(who.sub)).toBe('问了 1 个上游，没有能用的回答')
    const rows = stepRows(entry, null)
    expect(rows.map((row) => text(row.lead))).toEqual(['1.1.1.1:53 回了 SERVFAIL', '回给客户端 SERVFAIL'])
    expect(rows.some((row) => row.decides)).toBe(false)
  })

  it('内核的英文出错原因换成中文，认不出的照原文；详情里留着原文', () => {
    expect(errorWord('upstream timeout')).toBe('超时')
    expect(errorWord('all upstreams failed')).toBe('上游都失败了')
    expect(errorWord('tcp connect timeout after 2000ms')).toBe('连不上上游')
    expect(errorWord('the upstream answered REFUSED')).toBe('上游回了 REFUSED')
    expect(errorWord('something new')).toBeNull()
    const entry = entryOf(record([
      { at_us: 0, kind: 'pipeline', pipeline: 'main' },
      { at_us: 9_000, kind: 'upstream', upstream: '1.1.1.1:53', via: 'udp', result: 'error', error: 'upstream timeout', latency_us: 9_000 },
    ], { outcome: 'failed', status: 'failed', rcode: undefined, answers: [], error: 'upstream timeout' }))
    expect(answerOf(entry).text).toBe('超时')
    const failed = stepRows(entry, null)[0]!
    expect(text(failed.lead)).toBe('1.1.1.1:53 超时')
    // 原文单独一行，不和协议名用「·」接着 / The original alone on its line, not joined to the protocol with 「·」
    expect(text(failed.note)).toBe('upstream timeout')
    expect(answerOf({ ...entry, error: 'something new' }).text).toBe('SERVFAIL')
  })

  it('上游失败时内核不在记录上写原因：原因从问过的上游的步骤里取', () => {
    const entry = entryOf(record([
      { at_us: 0, kind: 'pipeline', pipeline: 'main' },
      { at_us: 9_000, kind: 'upstream', upstream: 'a', via: 'udp', result: 'error', error: 'upstream timeout', latency_us: 9_000 },
      { at_us: 9_000, kind: 'upstream', upstream: 'b', via: 'udp', result: 'error', error: 'upstream timeout', latency_us: 9_000 },
    ], { outcome: 'failed', status: 'failed', rcode: undefined, answers: [], error: undefined }))
    expect(answerOf(entry).text).toBe('超时')
    expect(text(detailFacts(entry, null)[1]!.sub)).toBe('问了 2 个上游：超时')
    const one = entryOf(record([{ at_us: 0, kind: 'upstream', upstream: 'a', via: 'udp', result: 'error', latency_us: 9_000 }], { outcome: 'failed', status: 'failed', rcode: undefined, answers: [], error: undefined }))
    expect(text(detailFacts(one, null)[1]!.sub)).toBe('问了 1 个上游：出错')
  })

  it('上游回了、KixDNS 自己处理时出错：不说没有上游回答，回了的那个不打勾', () => {
    const entry = entryOf(record([
      { at_us: 0, kind: 'upstream', upstream: 'a', via: 'udp', result: 'success', rcode: 'NOERROR', latency_us: 5_000 },
    ], { outcome: 'failed', status: 'failed', rcode: 'SERVFAIL', answers: [], error: 'engine failed' }))
    const who = detailFacts(entry, null)[1]!
    expect(text(who.lead[0]!)).toBe('KixDNS 出错')
    expect(text(who.sub)).toBe('上游回了，处理时出错：KixDNS 内部出错')
    expect(stepRows(entry, null).some((row) => row.decides)).toBe(false)
    // 认不出的内部错误：句子里只说 KixDNS 处理时出错，原文在回给客户端那一步下面 / An unrecognised internal error: the sentence says only
    // that KixDNS failed, and the original sits under the reply step
    const odd = entryOf(record([], { outcome: 'failed', status: 'failed', rcode: 'SERVFAIL', answers: [], error: 'unresolved pipeline jump' }))
    expect(text(detailFacts(odd, null)[1]!.sub)).toBe('KixDNS 处理时出错')
    const reply = stepRows(odd, null).at(-1)!
    expect(reply.note.map((part) => [part.text, Boolean(part.literal)])).toEqual([['原因：', false], ['unresolved pipeline jump', true]])
  })

  it('备用组改问的上游失败了：不说 KixDNS 出错，只算改问以后的上游', () => {
    const { ctx, abroad, cn } = context()
    const entry = entryOf(record([
      { at_us: 0, kind: 'pipeline', pipeline: cn },
      { at_us: 5_000, kind: 'upstream', upstream: '223.5.5.5', via: 'udp', result: 'success', latency_us: 5_000, rcode: 'NOERROR' },
      { at_us: 5_100, kind: 'rule', pipeline: cn, rule: 'cn-forward', phase: 'response', matched: true, decision: 'jump', target: abroad },
      { at_us: 5_200, kind: 'pipeline', pipeline: abroad },
      { at_us: 40_000, kind: 'upstream', upstream: 'https://dns.google/dns-query', via: 'doh', result: 'error', error: 'upstream timeout', latency_us: 34_800 },
    ], { pipeline: abroad, outcome: 'failed', status: 'failed', rcode: 'SERVFAIL', answers: [], error: undefined }))
    const who = detailFacts(entry, ctx)[1]!
    expect(text(who.lead[0]!)).toBe('改问后没有上游回答')
    expect(text(who.sub)).toBe('先回的结果不能用，按备用组改问；改问的 1 个上游：超时')
    // 认不出是哪个组的检查（没有配置）：照回答后检查说 / A check whose group cannot be told (no config): said as an answer check
    expect(text(detailFacts(entry, null)[1]!.sub)).toBe('先回的结果没通过回答后检查；改问的 1 个上游：超时')
  })

  it('共用的那次查询失败了：共用那一步不打勾，谁回答的说共用的那次没有上游回答', () => {
    const entry = entryOf(record([
      { at_us: 300, kind: 'cache', result: 'miss' },
      { at_us: 1_800_000, kind: 'joined' },
    ], { outcome: 'failed', status: 'failed', rcode: 'SERVFAIL', answers: [], error: undefined, upstream: undefined }))
    const who = detailFacts(entry, null)[1]!
    expect(text(who.lead[0]!)).toBe('共用')
    expect(text(who.sub)).toBe('同样的查询正在问上游，那次没拿到能用的回答')
    expect(sourceOf(entry)?.text).toBe('共用')
    const joined = stepRows(entry, null).find((row) => text(row.lead).startsWith('同样的查询'))!
    expect(joined).toMatchObject({ tone: 'warn', decides: false })
    expect(text(joined.lead)).toBe('同样的查询正在问上游，共用了它的结果：失败了')
  })

  it('没处理完：为什么、客户端收到了什么各说一次，不在三处重复', () => {
    const entry = entryOf(record([], { outcome: 'cancelled', status: 'cancelled', rcode: undefined, answers: [] }))
    const facts = detailFacts(entry, null)
    expect(text(facts[1]!.sub)).toBe('多半是到了整体请求超时')
    expect(text(facts[2]!.sub)).toBe('超时时 KixDNS 回的；客户端断开或 KixDNS 停止时什么也没回')
    expect(stepRows(entry, null).at(-1)).toMatchObject({ note: [] })
  })

  it('UDP、TCP 双发和连接、证书、读不懂的回答这几种错误说对原因，不叫人去开已经开着的设置', () => {
    expect(errorWord('all udp attempts failed and tcp fallback disabled')).toBe('UDP 没有回答')
    expect(errorWord('udp failed: all udp attempts failed and tcp fallback disabled; tcp failed: tcp connect timeout after 2000ms')).toBe('UDP 和 TCP 都没回，连不上上游')
    expect(errorWord('tcp failed: connection reset by peer; udp failed: all udp attempts failed and tcp fallback disabled')).toBe('UDP 和 TCP 都没回，连接断了')
    // 两路是同时发的：一路失败时没时间等另一路，也是两路都没回，不说「来不及再试」 / Both legs were sent at once: one failing with no time
    // left for the other is still both coming to nothing, never 「too late to retry」
    expect(errorWord('tcp failed and no time left for udp: tcp connect timeout after 2000ms')).toBe('UDP 和 TCP 都没回，连不上上游')
    expect(errorWord('udp failed and no time left for tcp: all udp attempts failed and tcp fallback disabled')).toBe('UDP 和 TCP 都没回')
    expect(errorWord('udp failed: all udp attempts failed and tcp fallback disabled; tcp timed out')).toBe('UDP 和 TCP 都没回，超时')
    // 列表那一格只放原因 / The list's cell holds just the cause
    expect(errorWord('udp failed: all udp attempts failed and tcp fallback disabled; tcp failed: tcp connect timeout after 2000ms', true)).toBe('连不上上游')
    expect(errorWord('doh request send failed: error sending request for url (https://x/dns-query): client error (Connect): tcp connect error: Connection refused')).toBe('连不上上游')
    expect(errorWord('doh request send failed: error sending request for url (https://x/dns-query): client error (Connect): dns error: failed to lookup address information')).toBe('连不上上游')
    expect(errorWord('doh request send failed: error sending request for url (https://x/dns-query): client error (Connect): invalid peer certificate: UnknownIssuer')).toBe('上游的证书不对')
    expect(errorWord('parse upstream response: unexpected end of input reached')).toBe('上游的回答读不懂')
  })

  it('拦截规则回 SERVFAIL：内核记成失败，页面照样当拦截说，不说没有回答', () => {
    const entry = entryOf(record([
      { at_us: 0, kind: 'pipeline', pipeline: 'main' },
      { at_us: 50, kind: 'rule', pipeline: 'main', rule: 'ads', phase: 'request', matched: true, decision: 'static' },
    ], { outcome: 'failed', status: 'completed', rcode: 'SERVFAIL', answers: [], error: undefined, upstream: undefined }))
    expect(entry.outcome).toBe('blocked')
    expect(routeOf(entry, null).where).toBe('拦截')
    expect(stepRows(entry, null).map((row) => text(row.lead))).toEqual(['命中规则「ads」，拦截', '回给客户端 SERVFAIL'])
    expect(text(detailFacts(entry, null)[1]!.lead[0]!)).toBe('规则直接回应')
    // KixDNS 自己出错的不算 / KixDNS's own failure does not count
    expect(entryOf(record([{ at_us: 50, kind: 'rule', pipeline: 'main', rule: 'ads', phase: 'request', matched: true, decision: 'static' }], { outcome: 'failed', status: 'failed', rcode: 'SERVFAIL', answers: [], error: 'engine failed' })).outcome).toBe('failed')
  })

  it('认不出的上游错误：这一步说「出错」、原文放在下面；回给客户端那一步只列原文', () => {
    const entry = entryOf(record([
      { at_us: 9_000, kind: 'upstream', upstream: 'tcp://1.1.1.1:53', via: 'tcp', result: 'error', error: 'TCP response canceled for upstream 1.1.1.1:53', latency_us: 9_000 },
    ], { outcome: 'failed', status: 'failed', rcode: undefined, answers: [], error: undefined }))
    const [step, reply] = stepRows(entry, null)
    expect(text(step!.lead)).toBe('tcp://1.1.1.1:53 出错')
    expect(step!.note).toEqual([{ text: 'TCP response canceled for upstream 1.1.1.1:53', literal: true }])
    expect(reply!.note.map((part) => part.text)).toEqual(['原因：', 'TCP response canceled for upstream 1.1.1.1:53'])
    expect(text(detailFacts(entry, null)[1]!.sub)).toBe('问了 1 个上游：出错')
    // 认得出的和认不出的一起：两样都说 / Recognised and unrecognised together: both are said
    const mixed = entryOf(record([
      { at_us: 9_000, kind: 'upstream', upstream: 'tcp://1.1.1.1:53', via: 'tcp', result: 'error', error: 'reader failed', latency_us: 9_000 },
      { at_us: 9_000, kind: 'upstream', upstream: '8.8.8.8:53', via: 'udp', result: 'error', error: 'upstream timeout', latency_us: 9_000 },
    ], { outcome: 'failed', status: 'failed', rcode: undefined, answers: [], error: undefined }))
    expect(text(detailFacts(mixed, null)[1]!.sub)).toBe('问了 2 个上游：超时、出错')
  })

  it('回答后检查把上游的回答拦下：谁回答的是那条检查，先回的不打勾', () => {
    const entry = entryOf(record([
      { at_us: 0, kind: 'pipeline', pipeline: 'main' },
      { at_us: 5_000, kind: 'upstream', upstream: '1.1.1.1:53', via: 'udp', result: 'success', rcode: 'NOERROR', latency_us: 5_000 },
      { at_us: 5_100, kind: 'rule', pipeline: 'main', rule: 'bad-ip', phase: 'response', matched: true, decision: 'static' },
    ], { outcome: 'blocked', rcode: 'NXDOMAIN', answers: [] }))
    expect(text(detailFacts(entry, null)[1]!.lead[0]!)).toBe('回答后检查')
    expect(stepRows(entry, null).some((row) => row.decides)).toBe(false)
  })

  it('记录里的规则是上游组生成的转发规则时，去向写用户自己那条规则', () => {
    const { ctx, abroad } = context()
    const entry = entryOf(record([
      { at_us: 0, kind: 'pipeline', pipeline: 'main' },
      { at_us: 10, kind: 'rule', pipeline: 'main', rule: '谷歌', phase: 'request', decision: 'jump', target: abroad },
      { at_us: 20, kind: 'pipeline', pipeline: abroad },
      { at_us: 30, kind: 'rule', pipeline: abroad, rule: abroad, phase: 'request', decision: 'forward', target: 'https://dns.google/dns-query' },
    ], { pipeline: abroad, rule: abroad }))
    expect(routeOf(entry, ctx)).toEqual({ where: '国外', rule: '谷歌' })
    expect(text(detailFacts(entry, ctx)[0]!.sub)).toBe('命中规则「谷歌」')
  })

  it('只问了一个上游说「回了」，同时问了几个才说「先回」', () => {
    const one = stepRows(entryOf(record([{ at_us: 5_000, kind: 'upstream', upstream: 'a', via: 'udp', result: 'success', rcode: 'NOERROR', latency_us: 5_000 }])), null)
    expect(text(one[0]!.lead)).toBe('a 回了')
  })

  it('不到 0.1 毫秒写「<0.1 ms」；记录到了内核的上限说「至少」', () => {
    expect(latencyText(0.03)).toBe('<0.1 ms')
    expect(latencyText(0.06)).toBe('0.1 ms')
    const eight = entryOf(record([], { answers: Array.from({ length: 8 }, (_, i) => `10.0.0.${i}`) }))
    expect(text(stepRows(eight, null).at(-1)!.lead)).toBe('回给客户端 NOERROR，至少 8 条记录')
  })
})

describe('设置的检查和服务端一样', () => {
  it('保存多久只认 1 到 8760 的整数小时，十六进制、科学计数、小数都不行', () => {
    expect(hoursProblem('12')).toBe('')
    for (const bad of ['0', '8761', '1.5', '0x10', '1e3', '']) expect(hoursProblem(bad)).not.toBe('')
  })

  it('最多占用在 10 MB 到 100 GB 之间', () => {
    expect(capProblem('500')).toBe('')
    for (const bad of ['9', '102401', 'abc', '']) expect(capProblem(bad)).not.toBe('')
  })

  it('不记录的域名按空白和逗号分开、整理、去重；中文域名要写成 xn-- 的形式', () => {
    expect(ignoredDomains('a.com, B.com，*.c.com、 a.com.\n d.com')).toEqual({ domains: ['a.com', 'b.com', 'c.com', 'd.com'], problem: '' })
    expect(ignoredDomains('例子.中国').problem).toContain('xn--')
    // 贴了网址：说只填域名，不提中文域名 / A pasted URL: the hint says domain only, not the Chinese-domain one
    expect(ignoredDomains('https://ads.example.com/x').problem).toBe('「https://ads.example.com/x」不是域名：只填域名，不带 https:// 和路径')
    // 下划线本来就认；不是中文的非英文字母不说「中文域名」 / Underscores are accepted; non-English letters that are not Chinese are not called Chinese
    expect(ignoredDomains('_dmarc.example.com').problem).toBe('')
    expect(ignoredDomains('ads!.com').problem).toBe('「ads!.com」不是域名：域名只能有字母、数字、点、连字符和下划线')
    expect(ignoredDomains('äds.com').problem).toBe('「äds.com」不是域名：带非英文字母的域名要先转成 xn-- 开头的写法')
    // 中文输入法打出来的全角字母和句号先换成半角 / Full-width letters and stops from a Chinese input method become half-width first
    expect(ignoredDomains('ａｄｓ.example.com ads。example。org')).toEqual({ domains: ['ads.example.com', 'ads.example.org'], problem: '' })
    expect(ignoredDomains(Array.from({ length: 1001 }, (_, i) => `d${i}.com`).join(' ')).problem).toBe('不记录的域名最多 1000 个')
  })
})

describe('显示时的断行和时间', () => {
  const kept = (text: string) => glueText(text).filter((run) => run.keep).map((run) => run.text)
  it('短的「名字」和常用词不拆开，最后一个字不单独落一行；文字本身不变', () => {
    expect(kept('交给上游组「国内」')).toEqual(['交给', '上游组', '「国内」'])
    // 句末两个字压在名字上时，名字一直延到句末，「里）」不单独落一行 / A sentence end overlapping a name extends it to the end
    // 括号里的一小句整个不拆，「（在」不落在行尾 / A short aside in brackets stays whole, so 「（在」 never ends a line
    expect(kept('命中规则「国内」（在规则组「内网解析」里）')).toEqual(['「国内」', '（在规则组「内网解析」里）'])
    expect(kept('先回的结果没通过回答后检查，改问上游组「国外」')).toEqual(['结果', '没通过', '回答后检查', '改问', '上游组', '「国外」'])
    expect(kept('问了 2 个上游：连不上上游')).toEqual(['上游', '连不上', '上游'])
    expect(kept('问了 1 个上游：UDP 和 TCP 都没回，超时')).toEqual(['上游', '都没回', '超时'])
    expect(kept('先回的结果不能用，按备用组改问')).toEqual(['结果', '不能用', '备用组', '改问'])
    expect(kept('没等它回，另一个先回了')).toEqual(['没等它回', '另一个', '先回了'])
    expect(kept('缓存里有，直接回')).toEqual(['接回'])
    expect(kept('「这是一个超过十个字的很长的规则名」')).toEqual(['则名」'])
    expect(glueText('交给上游组「国内」').map((run) => run.text).join('')).toBe('交给上游组「国内」')
  })

  it('标题里的域名只在点后面断，太长的一段才放开', () => {
    expect(domainParts('use-application-dns.net')).toEqual([{ text: 'use-application-dns.net', keep: true }])
    // 最后两段连着：「com」不单独落一行 / The last two labels together: 「com」 never alone on a line
    expect(domainParts('connectivitycheck.gstatic.com').map((part) => part.text)).toEqual(['connectivitycheck.', 'gstatic.com'])
    expect(domainParts('a1b2c3d4e5f6a7b8c9d0e1f2a3b4.example')[0]!.keep).toBe(false)
  })

  it('今天的只写时分秒，更早的带上「10 月 15 日」', () => {
    const now = new Date(2026, 9, 16, 2, 10).getTime()
    expect(timeText(new Date(2026, 9, 16, 1, 2, 3).getTime(), now)).toBe('01:02:03')
    expect(timeText(new Date(2026, 9, 15, 23, 59, 58).getTime(), now)).toBe('10\u00a0月\u00a015\u00a0日\u00a023:59:58')
    // 不是今年的带上年：保存一年时去年的记录不会读成今年 / Another year carries the year: with a year of retention, last year's never reads as this one's
    expect(dayText(new Date(2025, 11, 20).getTime(), now)).toBe('2025\u00a0年\u00a012\u00a0月\u00a020\u00a0日')
    // 详情页头也带上年 / The detail head carries the year too
    expect(requestLine(entryOf(record([], { time_unix_ms: new Date(2025, 11, 20, 8, 5, 9).getTime() })), now)[2]).toBe('2025\u00a0年\u00a012\u00a0月\u00a020\u00a0日\u00a008:05:09')
  })

  it('字面量在一串「/」「.」「:」「,」和空格的后面才断，「://」「::」中间不断；24 个字以内的一段不拆', () => {
    expect(literalParts('https://dns.google/dns-query').map((part) => part.text)).toEqual(['https://', 'dns.', 'google/', 'dns-query'])
    expect(literalParts('2408:8756::14').map((part) => part.text)).toEqual(['2408:', '8756::', '14'])
    expect(literalParts('1 . alpn=h2,h3').map((part) => part.text)).toEqual(['1 . ', 'alpn=h2,', 'h3'])
    expect(literalParts('a'.repeat(30))[0]!.keep).toBe(false)
    expect(literalParts('https://dns.google/dns-query').map((part) => part.text).join('')).toBe('https://dns.google/dns-query')
  })

  it('耗时按四舍五入后的值挑单位', () => {
    expect(latencyText(0.96)).toBe('1 ms')
    expect(latencyText(0.94)).toBe('0.9 ms')
    expect(latencyText(999.6)).toBe('1.0 s')
    expect(latencyText(999.4)).toBe('999 ms')
  })
})
