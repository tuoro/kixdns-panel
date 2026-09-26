import { describe, expect, it } from 'vitest'
import type { DnsTraceStep } from './api/types'
import { humanizeTraceDetail, isDnsSuccess, parseDnsAnswer, responseCodeName, traceTone, describeStep, detailParts, formatElapsed, forwardTarget, groupTrace, type TextPart } from './diagnostics'

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

describe('轨迹语气与响应码', () => {
  it.each(['miss', 'missed', 'unknown'])('%s 不是故障', (status) => expect(traceTone(status)).toBe('neutral'))
  it('明确失败才用故障状态', () => expect(traceTone('failed')).toBe('danger'))
  it.each(['No Error', 'NOERROR'])('识别响应码 %s', (code) => expect(isDnsSuccess(code)).toBe(true))
  it('不把 NXDOMAIN 画成成功应答', () => expect(isDnsSuccess('NXDOMAIN')).toBe(false))
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

const plain = (parts: TextPart[]) => parts.map((part) => (part.label ? part.label + ' ' : '') + part.text).join('')
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
    [kstep('decision', 'selected', '规则 geosite-global 转发', '目标：https://1.1.1.1/dns-query；传输：Some(Https)'), '转发给 https://1.1.1.1/dns-query', '规则 geosite-global · 传输 DoH'],
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

describe('细节里的一对键值不拆开', () => {
  it('一对「键 值」是一段，排版时整对换行', () => {
    expect(detailParts('客户端：192.168.1.23；监听器：default')).toEqual([{ label: '客户端', text: '192.168.1.23', mono: true }, { text: ' · ' }, { label: '监听器', text: 'default', mono: true }])
  })
})

describe('转发和应答不把同一个地址说三遍', () => {
  const decision = kstep('decision', 'selected', '规则 geosite-global 转发', '目标：https://1.1.1.1/dns-query；传输：Some(Https)')
  const sent = kstep('upstream', 'started', '准备转发到 https://1.1.1.1/dns-query', '规则：geosite-global；传输：Some(Https)')
  const reply = kstep('upstream', 'succeeded', 'https://1.1.1.1/dns-query', '响应码：No Error；耗时：11 ms；截断：false')

  it('规则决定转给 X、紧接着发往 X，并成一行', () => {
    const rows = groupTrace([decision, sent, reply])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ kind: 'step', step: decision, sent })
  })

  it('发往的不是规则定的那个（比如故障切换）就不并', () => {
    const other = kstep('upstream', 'started', '准备转发到 8.8.8.8:53', null)
    expect(groupTrace([decision, other])).toHaveLength(2)
  })

  it('应答来自刚转给的那个上游时只写「应答 NOERROR」，换了上游就照写地址', () => {
    expect(forwardTarget(decision)).toBe('https://1.1.1.1/dns-query')
    expect(forwardTarget(sent)).toBe('https://1.1.1.1/dns-query')
    expect(plain(describeStep(reply, { target: 'https://1.1.1.1/dns-query' }).lead)).toBe('应答 NOERROR')
    expect(plain(describeStep(reply, { target: '8.8.8.8:53' }).lead)).toBe('https://1.1.1.1/dns-query 应答 NOERROR')
    expect(plain(describeStep(kstep('upstream', 'failed', 'https://1.1.1.1/dns-query', '超时'), { target: 'https://1.1.1.1/dns-query' }).lead)).toBe('没有应答')
  })
})

describe('耗时的写法', () => {
  it.each([[0, '0 ms'], [12, '12 ms'], [999, '999 ms'], [1000, '1.0 s'], [5003, '5.0 s']])('%i → %s', (ms, text) => expect(formatElapsed(ms)).toBe(text))
})
