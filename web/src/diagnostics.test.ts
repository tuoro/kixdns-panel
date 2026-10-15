import { describe, expect, it } from 'vitest'
import type { DnsTraceStep } from './api/types'
import { humanizeTraceDetail, isDnsSuccess, parseDnsAnswer, responseCodeName, traceTone, describeStep, detailParts, formatElapsed, forwardTarget, groupTrace, hidePlumbing, type TextPart } from './diagnostics'

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
    // 没截断不写，也不留下多余的分号 / Not truncated is left out, without a stray separator
    ['响应码：No Error；耗时：12 ms；截断：false', '响应码：NOERROR；耗时：12\u00a0ms'],
    ['截断：false；响应码：No Error', '响应码：NOERROR'],
    ['客户端：127.0.0.1；监听器：default', '客户端：127.0.0.1；监听标签：default'],
    ['响应码：Server Failure；截断：true', '响应码：SERVFAIL；已截断'],
  ])('%s', (raw, words) => expect(humanizeTraceDetail(raw)).toBe(words))

  it('认不出的片段原样保留，不猜', () => {
    expect(humanizeTraceDetail('传输：Some(Carrier)；客户端：127.0.0.1')).toBe('传输：Some(Carrier)；客户端：127.0.0.1')
    expect(humanizeTraceDetail('保留原始说明')).toBe('保留原始说明')
  })

  it.each([['No Error', 'NOERROR'], ['Non-Existent Domain', 'NXDOMAIN'], ['NXDOMAIN', 'NXDOMAIN'], ['Query Refused', 'REFUSED'], ['BADVERS', 'BADVERS']])('响应码 %s 写成 %s', (code, name) => expect(responseCodeName(code)).toBe(name))
})

const plain = (parts: TextPart[]) => parts.map((part) => (part.label ? part.label + ' ' : '') + part.text).join('')
const literals = (parts: TextPart[]) => parts.filter((part) => part.literal).map((part) => part.text)
const kstep = (stage: string, status: string, label: string, detail: string | null = null): DnsTraceStep => ({ stage, status, label, detail, elapsed_ms: 0 })

describe('执行路径每一步写成一句话', () => {
  // 标签和细节照 p27 内核补丁的原样写法。 / Labels and details exactly as the p27 kernel patch writes them.
  it.each([
    [kstep('request', 'parsed', 'A example.com', '客户端：192.168.1.23；监听器：default'), '请求 A example.com', '客户端 192.168.1.23 · 监听标签 default'],
    [kstep('pipeline', 'selected', 'default'), '进入规则组 default', ''],
    [kstep('pipeline', 'jump', 'default -> cn'), '从规则组 default 跳到规则组 cn', ''],
    [kstep('response_cache', 'miss', '响应缓存未命中', '管线：default'), '响应缓存未命中', ''],
    [kstep('response_cache', 'fresh', '命中新鲜响应缓存', '剩余 TTL：120 秒'), '命中响应缓存', '剩余 TTL 120 秒'],
    [kstep('response_cache', 'stale', '上游失败，返回过期缓存'), '上游失败，返回过期缓存', ''],
    [kstep('rule_cache', 'miss', '管线 default 的规则缓存未命中'), '规则组 default 的规则缓存未命中', ''],
    [kstep('rule_cache', 'hit', '命中管线 default 的规则缓存', '已匹配规则：geosite-global'), '命中规则组 default 的规则缓存', '已匹配规则 geosite-global'],
    [kstep('rule', 'matched', 'geosite-global', '管线：default；匹配器数：1'), '命中规则 geosite-global', ''],
    [kstep('rule', 'missed', 'block-ads', '管线：default；匹配器数：2'), '规则 block-ads 未命中', ''],
    [kstep('decision', 'selected', '规则 geosite-global 转发', '目标：https://1.1.1.1/dns-query；传输：Some(Https)'), '转发给 https://1.1.1.1/dns-query', '传输 DoH'],
    [kstep('decision', 'selected', '静态响应 Non-Existent Domain', '答案记录数：0'), '直接返回 NXDOMAIN', ''],
    [kstep('decision', 'selected', '跳转到管线 cn'), '跳转到规则组 cn', ''],
    [kstep('upstream', 'started', '准备转发到 https://1.1.1.1/dns-query', '规则：geosite-global；传输：Some(Https)'), '发往 https://1.1.1.1/dns-query', '传输 DoH'],
    [kstep('upstream', 'succeeded', 'https://1.1.1.1/dns-query', '响应码：No Error；耗时：11 ms；截断：false'), 'https://1.1.1.1/dns-query 收到回答', ''],
    [kstep('upstream', 'succeeded', '8.8.8.8:53', '响应码：Server Failure；耗时：30 ms；截断：true'), '8.8.8.8:53 回答 SERVFAIL', '已截断'],
    [kstep('upstream', 'failed', '8.8.8.8:53', 'request timed out'), '8.8.8.8:53 没有回答', 'request timed out'],
    [kstep('upstream', 'joined', '等候正在进行的同一个查询'), '等候正在进行的同一个查询', ''],
  ])('%#', (input, lead, note) => {
    const view = describeStep(input)
    expect(plain(view.lead)).toBe(lead)
    expect(plain(view.note)).toBe(note)
  })

  it('名字和地址是字面值；响应码是助记词，不算', () => {
    expect(literals(describeStep(kstep('upstream', 'succeeded', 'https://1.1.1.1/dns-query', '响应码：No Error；耗时：11 ms；截断：false')).lead)).toEqual(['https://1.1.1.1/dns-query'])
    expect(literals(detailParts('剩余 TTL：120 秒'))).toEqual([])
    // 等候同一个查询是一句话，不是地址 / Waiting on the same query is a sentence, not an address
    expect(literals(describeStep(kstep('upstream', 'joined', '等候正在进行的同一个查询')).lead)).toEqual([])
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
    expect(detailParts('客户端：192.168.1.23；监听器：default')).toEqual([{ label: '客户端', text: '192.168.1.23', literal: true }, { text: ' · ' }, { label: '监听标签', text: 'default', literal: true }])
    // 耗时、计数和协议名是量和名称，不是要照抄的字面值 / Durations, counts and protocol names are quantities and names, not literals to copy
    expect(literals(detailParts('耗时：12 ms；匹配器数：1；传输：DoH；协议：TCP+UDP'))).toEqual([])
    expect(literals(detailParts('响应码：NXDOMAIN；回退：SERVFAIL'))).toEqual([])
    expect(literals(detailParts('规则：geosite-global；目标：1.1.1.1:53'))).toEqual(['geosite-global', '1.1.1.1:53'])
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

  it('回答来自刚转给的那个上游时只写「收到回答」，换了上游就照写地址', () => {
    expect(forwardTarget(decision)).toBe('https://1.1.1.1/dns-query')
    expect(forwardTarget(sent)).toBe('https://1.1.1.1/dns-query')
    expect(plain(describeStep(reply, { target: 'https://1.1.1.1/dns-query' }).lead)).toBe('收到回答')
    expect(plain(describeStep(reply, { target: '8.8.8.8:53' }).lead)).toBe('https://1.1.1.1/dns-query 收到回答')
    expect(plain(describeStep(kstep('upstream', 'failed', 'https://1.1.1.1/dns-query', '超时'), { target: 'https://1.1.1.1/dns-query' }).lead)).toBe('没有回答')
  })
})

describe('耗时的写法', () => {
  it.each([[0, '0 ms'], [12, '12 ms'], [999, '999 ms'], [1000, '1.0 s'], [5003, '5.0 s']])('%i → %s', (ms, text) => expect(formatElapsed(ms)).toBe(text))
})

describe('内核的名字换回配置页上的名字', () => {
  const pipeline = (id: string) => (id === 'main' ? '主列表' : id === 'group-g1' ? '规则组「内网」' : id === 'upstream-cn' ? '上游组「国内」' : null)
  const names = {
    rule: (label: string) => (label === 'rule-3' ? '域名是 example.org' : null),
    pipeline,
    entry: (id: string) => (id === 'upstream-cn' ? '主列表' : pipeline(id)),
    matched: (label: string) => (label === '其余请求' ? '没有规则命中，按「其余请求」处理' : null),
    plumbing: (label: string, at: string | null) => label === at && at === 'upstream-cn',
    ownForward: () => false,
  }
  it.each([
    [kstep('pipeline', 'selected', 'main'), '进入主列表'],
    [kstep('pipeline', 'jump', 'main -> group-g1'), '从主列表跳到规则组「内网」'],
    [kstep('pipeline', 'jump', 'main -> other'), '从主列表跳到规则组 other'],
    [kstep('rule', 'matched', 'rule-3'), '命中规则「域名是 example.org」'],
    [kstep('rule', 'missed', 'named'), '规则 named 未命中'],
    [kstep('rule_cache', 'hit', '命中管线 main 的规则缓存'), '命中主列表的规则缓存'],
    [kstep('pipeline', 'selected', 'upstream-cn'), '进入主列表'],
    [kstep('rule', 'matched', '其余请求', '管线：main'), '没有规则命中，按「其余请求」处理'],
  ])('%#', (input, lead) => expect(plain(describeStep(input, { names }).lead)).toBe(lead))

  it('认得出的名字写配置页上的叫法，认不出的写内核原名（字面值）', () => {
    expect(literals(describeStep(kstep('rule', 'matched', 'rule-3'), { names }).lead)).toEqual([])
    expect(literals(describeStep(kstep('rule', 'matched', 'named'), { names }).lead)).toEqual(['named'])
  })
})

describe('转发用的那条规则不单列', () => {
  const names = { rule: () => null, pipeline: () => null, entry: () => null, matched: () => null, plumbing: (label: string, at: string | null) => label === at && (at === 'upstream-cn' || at === 'rule-3'), ownForward: (id: string) => id === 'rule-3' }
  it('和所在 Pipeline 同名的那条去掉，用户的规则留着', () => {
    const steps = [kstep('rule', 'matched', '国内域名', '管线：main'), kstep('pipeline', 'jump', 'main -> upstream-cn'), kstep('rule', 'matched', 'upstream-cn', '管线：upstream-cn')]
    expect(hidePlumbing(steps, names).map((step) => step.label)).toEqual(['国内域名', 'main -> upstream-cn'])
    expect(hidePlumbing(steps, null)).toHaveLength(3)
  })

  it('规则自带的转发：跳进去、查缓存、里面那条都不单列，只剩命中和转发', () => {
    const steps = [
      kstep('rule', 'matched', '苹果服务', '管线：main'),
      kstep('decision', 'jump', '跳转到管线 rule-3'),
      kstep('pipeline', 'jump', 'main -> rule-3'),
      kstep('rule_cache', 'miss', '管线 rule-3 的规则缓存未命中'),
      kstep('rule', 'matched', 'rule-3', '管线：rule-3'),
      kstep('decision', 'forward', '规则 rule-3 转发', '目标：1.1.1.1:53'),
    ]
    expect(hidePlumbing(steps, names).map((step) => step.label)).toEqual(['苹果服务', '规则 rule-3 转发'])
  })
})
