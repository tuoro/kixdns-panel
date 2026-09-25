import { describe, expect, it } from 'vitest'
import type { DnsTraceStep } from './api/types'
import { describeResolution, humanizeTraceDetail, isDnsSuccess, parseDnsAnswer, responseCodeName, summarizeTrace, traceTone, describeStep, detailParts, groupTrace, type TextPart } from './diagnostics'

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
  it('不假定六步，保留多个命中规则', () => {
    const trace = [step('pipeline', 'selected', 'default'), step('rule', 'matched', 'first'), step('rule', 'matched', 'second'), step('rule', 'matched', 'first')]
    expect(summarizeTrace(trace)).toMatchObject({ matchedRules: ['first', 'second'], pipelines: ['default'] })
  })

  it('响应缓存命中但没有规则时不编造规则', () => {
    expect(summarizeTrace([step('response_cache', 'fresh', 'cached')])).toMatchObject({ matchedRules: [], emptyMatchLabel: '响应缓存命中，未记录规则匹配' })
  })

  it('规则缓存命中不等同于应答由缓存直接返回', () => {
    expect(summarizeTrace([step('rule_cache', 'hit', 'cached')]).emptyMatchLabel).toBe('未记录规则匹配')
  })

  it('空轨迹不选择不存在的步骤', () => {
    expect(summarizeTrace([])).toMatchObject({ matchedRules: [], pipelines: [], upstreams: [] })
  })

  it.each(['miss', 'missed', 'unknown'])('%s 不是故障', (status) => expect(traceTone(status)).toBe('neutral'))
  it('明确失败才用故障状态', () => expect(traceTone('failed')).toBe('danger'))
  it.each(['No Error', 'NOERROR'])('识别响应码 %s', (code) => expect(isDnsSuccess(code)).toBe(true))
  it('不把 NXDOMAIN 画成成功应答', () => expect(isDnsSuccess('NXDOMAIN')).toBe(false))
})

describe('结论带的那句话', () => {
  const summarize = (...steps: DnsTraceStep[]) => summarizeTrace(steps)

  it('同时说清走了哪条规则和由谁应答', () => {
    const summary = summarize(step('pipeline', 'selected', 'domestic'), step('rule', 'matched', 'cn-direct'), step('upstream', 'succeeded', '223.5.5.5:53'))
    expect(describeResolution(summary)).toBe('命中 domestic 的规则 cn-direct，由 223.5.5.5:53 应答')
  })

  it('没有管线时只说规则，不硬凑「的」', () => {
    expect(describeResolution(summarize(step('rule', 'matched', 'cn-direct')))).toBe('命中规则 cn-direct')
  })

  it('缓存直接应答时不提上游，因为本次根本没走', () => {
    expect(describeResolution(summarize(step('response_cache', 'fresh', '响应缓存命中')))).toBe('响应缓存命中')
  })

  it('上游失败不算「由它应答」', () => {
    const summary = summarize(step('rule', 'matched', 'cn-direct'), step('upstream', 'failed', '8.8.8.8:53'))
    expect(describeResolution(summary)).toBe('命中规则 cn-direct')
  })

  it('命中很多条时只点前三条，说明一共几条', () => {
    const summary = summarize(...['a', 'b', 'c', 'd', 'e'].map((name) => step('rule', 'matched', name)))
    expect(describeResolution(summary)).toBe('命中 a、b、c 等 5 条规则')
  })

  it('什么都没记下来时交回空串，让结论带只写响应码', () => {
    expect(describeResolution(summarize())).toBe('')
    expect(describeResolution(summarize(step('request', 'parsed', 'A example.com')))).toBe('')
  })
})

describe('把轨迹里的程序写法翻成人话', () => {
  it.each([
    ['目标：https://1.1.1.1/dns-query；传输：Some(Https)', '目标：https://1.1.1.1/dns-query；传输：DoH'],
    ['传输：Some(Udp)', '传输：UDP'],
    ['传输：Some(TcpUdp)', '传输：TCP+UDP'],
    ['传输：None', '传输：自动'],
    ['响应码：No Error；耗时：12 ms；截断：false', '响应码：NOERROR；耗时：12\u00a0ms；未截断'],
    ['响应码：Server Failure；截断：true', '响应码：SERVFAIL；已截断'],
  ])('%s', (raw, words) => expect(humanizeTraceDetail(raw)).toBe(words))

  it('认不出的片段原样保留，不猜', () => {
    expect(humanizeTraceDetail('传输：Some(Carrier)；客户端：127.0.0.1')).toBe('传输：Some(Carrier)；客户端：127.0.0.1')
    expect(humanizeTraceDetail('保留原始说明')).toBe('保留原始说明')
  })

  it.each([['No Error', 'NOERROR'], ['Non-Existent Domain', 'NXDOMAIN'], ['NXDOMAIN', 'NXDOMAIN'], ['Query Refused', 'REFUSED'], ['BADVERS', 'BADVERS']])('响应码 %s 写成 %s', (code, name) => expect(responseCodeName(code)).toBe(name))
})

const plain = (parts: TextPart[]) => parts.map((part) => part.text).join('')
const monos = (parts: TextPart[]) => parts.filter((part) => part.mono).map((part) => part.text)
const kstep = (stage: string, status: string, label: string, detail: string | null = null): DnsTraceStep => ({ stage, status, label, detail, elapsed_ms: 0 })

describe('执行路径每一步写成一句话', () => {
  // 标签和细节照 p27 内核补丁的原样写法。 / Labels and details exactly as the p27 kernel patch writes them.
  it.each([
    [kstep('request', 'parsed', 'A example.com', '客户端：192.168.1.23；监听器：default'), '请求 A example.com', '客户端 192.168.1.23 · 监听器 default'],
    [kstep('pipeline', 'selected', 'default'), '选中管线 default', ''],
    [kstep('pipeline', 'jump', 'default -> cn'), '从管线 default 跳到 cn', ''],
    [kstep('response_cache', 'miss', '响应缓存未命中', '管线：default'), '响应缓存未命中', '管线 default'],
    [kstep('response_cache', 'fresh', '命中新鲜响应缓存', '剩余 TTL：120 秒'), '命中响应缓存', '剩余 TTL 120 秒'],
    [kstep('response_cache', 'stale', '上游失败，返回过期缓存'), '上游失败，返回过期缓存', ''],
    [kstep('rule_cache', 'miss', '管线 default 的规则缓存未命中'), '管线 default 的规则缓存未命中', ''],
    [kstep('rule_cache', 'hit', '命中管线 default 的规则缓存', '已匹配规则：geosite-global'), '命中管线 default 的规则缓存', '已匹配规则 geosite-global'],
    [kstep('rule', 'matched', 'geosite-global', '管线：default；匹配器数：1'), '命中规则 geosite-global', '匹配器数 1'],
    [kstep('rule', 'missed', 'block-ads', '管线：default；匹配器数：2'), '规则 block-ads 未命中', '匹配器数 2'],
    [kstep('decision', 'selected', '规则 geosite-global 转发', '目标：https://1.1.1.1/dns-query；传输：Some(Https)'), '决定转发给 https://1.1.1.1/dns-query', '规则 geosite-global · 传输 DoH'],
    [kstep('decision', 'selected', '静态响应 Non-Existent Domain', '答案记录数：0'), '直接返回 NXDOMAIN', '答案记录数 0'],
    [kstep('decision', 'selected', '跳转到管线 cn'), '跳转到管线 cn', ''],
    [kstep('upstream', 'started', '准备转发到 https://1.1.1.1/dns-query', '规则：geosite-global；传输：Some(Https)'), '发往 https://1.1.1.1/dns-query', '传输 DoH'],
    [kstep('upstream', 'succeeded', 'https://1.1.1.1/dns-query', '响应码：No Error；耗时：11 ms；截断：false'), 'https://1.1.1.1/dns-query 应答 NOERROR', '耗时 11\u00a0ms · 未截断'],
    [kstep('upstream', 'failed', '8.8.8.8:53', 'request timed out'), '8.8.8.8:53 没有应答', 'request timed out'],
  ])('%#', (input, lead, note) => {
    const view = describeStep(input)
    expect(plain(view.lead)).toBe(lead)
    expect(plain(view.note)).toBe(note)
  })

  it('名字、地址和响应码用等宽，中文不用', () => {
    expect(monos(describeStep(kstep('upstream', 'succeeded', 'https://1.1.1.1/dns-query', '响应码：No Error；耗时：11 ms；截断：false')).lead)).toEqual(['https://1.1.1.1/dns-query', 'NOERROR'])
    expect(monos(detailParts('剩余 TTL：120 秒'))).toEqual([])
  })

  it('认不出的阶段和写法退回「阶段名 标签」，状态照翻', () => {
    const view = describeStep(kstep('future_stage', 'matched', 'rule-0', '保留原始说明'))
    expect(plain(view.lead)).toBe('future_stage rule-0')
    expect(plain(view.note)).toBe('命中 · 保留原始说明')
    expect(plain(describeStep(kstep('decision', 'selected', '以后的新动作')).lead)).toBe('动作 以后的新动作')
  })
})

describe('连着的未命中规则并成一行', () => {
  it('两条以上才并，命中那条单独一行', () => {
    const rows = groupTrace([kstep('pipeline', 'selected', 'default'), kstep('rule', 'missed', 'a'), kstep('rule', 'missed', 'b'), kstep('rule', 'missed', 'c'), kstep('rule', 'matched', 'd'), kstep('rule', 'missed', 'e')])
    expect(rows.map((row) => (row.kind === 'step' ? row.step.label : row.steps.map((item) => item.label).join('+')))).toEqual(['default', 'a+b+c', 'd', 'e'])
  })
})
