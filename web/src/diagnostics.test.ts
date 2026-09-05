import { describe, expect, it } from 'vitest'
import type { DnsTraceStep } from './api/types'
import { isDnsSuccess, parseDnsAnswer, summarizeTrace, traceTone } from './diagnostics'

describe('DNS 应答台账', () => {
  it.each([
    ['example.com. 300 IN A 104.18.26.120', 'A', '104.18.26.120'],
    ['example.com.\t0\tIN\tAAAA\t2606:4700::6812:1a78', 'AAAA', '2606:4700::6812:1a78'],
    ['example.com. 3600 IN MX 10 mail.example.com.', 'MX', '10 mail.example.com.'],
    ['example.com. 60 IN TXT "a  b" "escaped\\\"quote"', 'TXT', '"a  b" "escaped\\\"quote"'],
    ['example.com. 60 IN TYPE65280 \\# 2 0000', 'TYPE65280', '\\# 2 0000'],
  ])('只拆记录头，保留 %s 的值', (raw, type, data) => {
    expect(parseDnsAnswer(raw)).toMatchObject({ type, data })
  })

  it('保留长 TXT、换行和尾部空白，不按字段截断 RDATA', () => {
    const data = `"${'long '.repeat(200)}\\032  value"\n"second"  `
    expect(parseDnsAnswer(`example.com. 300 IN TXT ${data}`)?.data).toBe(data)
  })

  it.each(['', '104.18.26.120', 'example.com. IN A 1.1.1.1', 'example.com. -1 IN A 1.1.1.1', 'example.com. 4294967296 IN A 1.1.1.1', 'example.com. 30 IN A', 'escaped\\ name. 30 IN TXT "value"'])('无法明确拆分时交还原串：%s', (raw) => {
    expect(parseDnsAnswer(raw)).toBeNull()
  })
})

const step = (stage: string, status: string, label: string): DnsTraceStep => ({ stage, status, label, detail: null, elapsed_ms: 0 })

describe('诊断轨迹摘要', () => {
  it('不假定六步，保留多个命中规则并定位首个命中', () => {
    const trace = [step('pipeline', 'selected', 'default'), step('rule', 'matched', 'first'), step('rule', 'matched', 'second'), step('rule', 'matched', 'first')]
    expect(summarizeTrace(trace)).toMatchObject({ matchedRules: ['first', 'second'], pipelines: ['default'], initialStep: 1 })
  })

  it('响应缓存命中但没有规则时不编造规则', () => {
    expect(summarizeTrace([step('response_cache', 'fresh', 'cached')])).toMatchObject({ matchedRules: [], emptyMatchLabel: '响应缓存命中，未记录规则匹配', initialStep: 0 })
  })

  it('规则缓存命中不等同于应答由缓存直接返回', () => {
    expect(summarizeTrace([step('rule_cache', 'hit', 'cached')]).emptyMatchLabel).toBe('未记录规则匹配')
  })

  it('空轨迹不选择不存在的步骤', () => {
    expect(summarizeTrace([])).toMatchObject({ matchedRules: [], pipelines: [], initialStep: null })
  })

  it.each(['miss', 'missed', 'unknown'])('%s 不是故障', (status) => expect(traceTone(status)).toBe('neutral'))
  it('明确失败才用故障状态', () => expect(traceTone('failed')).toBe('danger'))
  it.each(['No Error', 'NOERROR'])('识别响应码 %s', (code) => expect(isDnsSuccess(code)).toBe(true))
  it('不把 NXDOMAIN 画成成功应答', () => expect(isDnsSuccess('NXDOMAIN')).toBe(false))
})
