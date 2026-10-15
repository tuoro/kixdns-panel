import { describe, expect, it } from 'vitest'
import type { QueryLogRecord, QueryLogStepRecord } from './api/types'
import { compile, upstreamPipelineId } from './config-model/model'
import { sampleModel } from './config-model/testing/samples'
import { traceNames } from './config-model/trace-names'
import { answerOf, entryOf, sourceOf, statusOf, stepRows, upstreamHost, type QueryLogContext } from './querylog'
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

  it('失败的回 SERVFAIL；取消的什么也没回，也不编一个响应', () => {
    const failed = entryOf(record([], { outcome: 'failed', status: 'failed', rcode: undefined, answers: [], error: '上游全部超时' }))
    expect(failed.rcode).toBe('SERVFAIL')
    expect(failed.steps.at(-1)).toMatchObject({ kind: 'response', rcode: 'SERVFAIL' })
    const cancelled = entryOf(record([], { outcome: 'cancelled', status: 'cancelled', rcode: undefined, answers: [], upstream: undefined }))
    expect(cancelled.rcode).toBe('')
    expect(cancelled.steps.some((step) => step.kind === 'response')).toBe(false)
    expect(statusOf(cancelled)).toEqual({ tone: 'warn', label: '已取消' })
    expect(answerOf(cancelled).text).toBe('没有回答')
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

  it('回答后检查否掉先回的结果时，先回的那一步不再打勾', () => {
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
    expect(rows.map((row) => text(row.lead))).toContain('回答后检查：这个回答不能用，改问上游组「国外」')
  })

  it('回了 SERVFAIL 没用上、没有规则命中、检查没发现问题、取消、步骤太多都照实说', () => {
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
      '回答后检查「check」：没发现问题',
      '回答之前请求就没了',
      '后面的步骤太多，没有记下',
    ])
  })
})
