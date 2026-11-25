import { afterEach, describe, expect, it } from 'vitest'
import { CONFIG_QTYPE_NAMES_V1, setKernelCapabilities } from '../config-model/grammar'
import { actionFieldErrors, GEOSITE_PREFIX_ERROR, isRequiredFieldError, matcherFieldErrors, negationProblem, validDnsName } from './field-validation'
import { matcherHint } from './matcher-hints'
import { MATCHER_DEFINITIONS } from './schema'
import type { ActionConfig, MatcherConfig } from './types'

describe('配置字段共享校验', () => {
  it('按条件的实际字段检查必填值，错误说出字段名，并保留未知类型', () => {
    expect(matcherFieldErrors({ type: 'domain_suffix', operator: 'and', value: '  ' }, 'request'))
      .toEqual({ value: '还没填域名' })
    expect(matcherFieldErrors({ type: 'response_answer_ip', operator: 'and' }, 'response'))
      .toEqual({ cidr: '还没填网段' })
    expect(matcherFieldErrors({ type: 'geoip_country', operator: 'and', country_codes: [' '] }, 'selector'))
      .toEqual({ country_codes: '还没填地区代码' })
    expect(matcherFieldErrors({ type: 'geo_site', operator: 'and', value: '' }, 'selector')).toEqual({ value: '还没填分类' })
    expect(matcherFieldErrors({ type: 'qtype', operator: 'and', value: '' }, 'request')).toEqual({ value: '还没选类型' })
    expect(matcherFieldErrors({ type: 'edns_present', operator: 'and', expect: false }, 'request')).toEqual({})
    expect(matcherFieldErrors({ type: 'future_matcher', operator: 'and' }, 'request')).toEqual({})
  })

  it('GeoSite 分类带 geosite: 前缀时报错：内核按原样查标签，匹配不上', () => {
    for (const type of ['geo_site', 'geo_site_not']) {
      expect(matcherFieldErrors({ type, operator: 'and', value: 'geosite:cn' }, 'selector')).toEqual({ value: GEOSITE_PREFIX_ERROR })
      expect(matcherFieldErrors({ type, operator: 'and', value: 'GeoSite:category-ads-all' }, 'request')).toEqual({ value: GEOSITE_PREFIX_ERROR })
      expect(matcherFieldErrors({ type, operator: 'and', value: 'cn' }, 'request')).toEqual({})
    }
    for (const type of ['response_request_domain_geo_site', 'response_request_domain_geo_site_not']) {
      expect(matcherFieldErrors({ type, operator: 'and', value: 'geosite:cn' }, 'response')).toEqual({ value: GEOSITE_PREFIX_ERROR })
    }
    // 别的条件里的 geosite: 字样不算 / geosite: in any other condition is left alone
    expect(matcherFieldErrors({ type: 'domain_suffix', operator: 'and', value: 'geosite:cn' }, 'request')).toEqual({})
  })


  it('缺失 CNAME 目标只报告必填错误，非法目标报告格式错误', () => {
    expect(actionFieldErrors({ type: 'static_cname_response', target: ' ' }))
      .toEqual({ target: '还没填目标域名' })
    expect(actionFieldErrors({ type: 'static_cname_response', target: 'bad target' }))
      .toEqual({ target: 'CNAME 目标域名写得不对' })
  })

  it('动作的必填参数按动作列表里的字段名报错，拉丁字母前留一个空格（审计第五轮 B3）', () => {
    expect(actionFieldErrors({ type: 'jump_to_pipeline', pipeline: '' })).toEqual({ pipeline: '还没选要转到的组' })
    expect(actionFieldErrors({ type: 'static_ip_response', ip: ' ' })).toEqual({ ip: '还没填 IP' })
    // 必填错误靠开头的「还没填」「还没选」认出来，别的错误不算 / Required errors are told by their 还没填 / 还没选 opening; no other error is
    expect(['还没填域名', '还没选要转到的组'].every(isRequiredFieldError)).toBe(true)
    expect([GEOSITE_PREFIX_ERROR, 'CNAME 目标域名写得不对', '要转到的组不存在'].some(isRequiredFieldError)).toBe(false)
  })

  it('DNS 名称按 UTF-8 字节检查标签与总长度，支持结尾根点', () => {
    expect(validDnsName(' origin.example. ')).toBe(true)
    expect(validDnsName('a..example')).toBe(false)
    expect(validDnsName('.')).toBe(false)
    expect(validDnsName(`${'a'.repeat(63)}.example`)).toBe(true)
    expect(validDnsName(`${'a'.repeat(64)}.example`)).toBe(false)
    expect(validDnsName(`${'中'.repeat(21)}.example`)).toBe(true)
    expect(validDnsName(`${'中'.repeat(22)}.example`)).toBe(false)
    expect(validDnsName([63, 63, 63, 61].map((length) => 'a'.repeat(length)).join('.'))).toBe(true)
    expect(validDnsName([63, 63, 63, 62].map((length) => 'a'.repeat(length)).join('.'))).toBe(false)
  })

  it.each([undefined, 0, 300, 4_294_967_295])('CNAME TTL 接受有效边界 %s', (ttl) => {
    expect(actionFieldErrors({ type: 'static_cname_response', target: 'origin.example.', ttl })).toEqual({})
  })

  it.each([-1, 1.5, 4_294_967_296, Number.NaN, Number.POSITIVE_INFINITY])('CNAME TTL 拒绝无效值 %s', (ttl) => {
    expect(actionFieldErrors({ type: 'static_cname_response', target: 'origin.example.', ttl }))
      .toEqual({ ttl: 'TTL 填 0 到 4294967295 之间的整数' })
  })

  // 转到自己所在的这一组内核照收（只提醒跳转绕了圈），这里也不拦 / A jump to its own group the kernel takes (warning only that the jumps go
  // round), so it is not stopped here
  it('区分未选择、目标不存在；转到自己所在的组照收；省略列表时不猜测目标是否存在', () => {
    expect(actionFieldErrors({ type: 'jump_to_pipeline', pipeline: '' }, ['default']))
      .toEqual({ pipeline: '还没选要转到的组' })
    expect(actionFieldErrors({ type: 'jump_to_pipeline', pipeline: 'default' }, ['default'])).toEqual({})
    expect(actionFieldErrors({ type: 'jump_to_pipeline', pipeline: 'removed' }, ['default']))
      .toEqual({ pipeline: '要转到的组不存在' })
    expect(actionFieldErrors({ type: 'jump_to_pipeline', pipeline: 'fallback' })).toEqual({})
  })

  // 内核认一段空的 TXT（[""]），一段也没有的不认（[]、没写 text）；TTL 0 也行 / The kernel takes one empty TXT segment ([""]) but not none
  // ([], text not written); a TTL of 0 too
  it('TXT 至少一段，空的那段也算；TTL 0 照收；未知动作不被前端误判', () => {
    for (const text of [[''], [' ', ''], '', 'v=spf1']) expect(actionFieldErrors({ type: 'static_txt_response', text, ttl: 0 })).toEqual({})
    for (const text of [[], undefined]) expect(actionFieldErrors({ type: 'replace_txt_response', text })).toEqual({ text: 'TXT 至少要有一段，空的也行' })
    expect(actionFieldErrors({ type: 'static_txt_response', text: ['x'], ttl: -1 })).toEqual({ ttl: 'TTL 填 0 到 4294967295 之间的整数' })
    expect(actionFieldErrors({ type: 'future_action', future_field: 'keep' })).toEqual({})
  })

  // 固定响应码六个都能用，大小写不论；OTHER 和别的写法内核不收 / All six fixed rcodes, in any case; OTHER and anything else the kernel refuses
  it('固定响应码照 parse_rcode 读', () => {
    for (const rcode of ['NOERROR', 'FORMERR', 'SERVFAIL', 'NXDOMAIN', 'NOTIMP', 'refused']) expect(actionFieldErrors({ type: 'static_response', rcode })).toEqual({})
    for (const rcode of ['OTHER', 'NOTAUTH', ' NXDOMAIN', '']) expect(actionFieldErrors({ type: 'static_response', rcode }).rcode).toBe('KixDNS 只认 NOERROR、SERVFAIL、NXDOMAIN、REFUSED、FORMERR、NOTIMP')
  })

})

// 高级规则、高级入口里直接写内核的字段：内核整份配置不收的写法，这里当场标出来，读法和条件表单一样（config-model/grammar.ts）
// Advanced rules and entries write kernel fields directly: what makes the kernel refuse the whole config is marked at once, by the same reading
// as the condition form (config-model/grammar.ts)
describe('高级规则的字段照内核的读法查', () => {
  it.each([
    ['client_ip 写了两个网段', { type: 'client_ip', operator: 'and', cidr: '10.0.0.0/8,192.168.0.0/16' }, 'request', 'cidr'],
    ['入口的 client_ip 没写前缀', { type: 'client_ip', operator: 'and', cidr: '10.0.0.1' }, 'selector', 'cidr'],
    ['回答的网段前缀 33', { type: 'response_answer_ip', operator: 'and', cidr: '0.0.0.0/32, 10.0.0.0/33' }, 'response', 'cidr'],
    ['查询类型 HTTPS', { type: 'qtype', operator: 'and', value: 'HTTPS' }, 'request', 'value'],
    ['回答的记录类型 ANY', { type: 'response_type', operator: 'and', value: 'ANY' }, 'response', 'value'],
    ['查询类别 ANY', { type: 'qclass', operator: 'and', value: 'ANY' }, 'selector', 'value'],
    ['响应码 NOTAUTH', { type: 'response_rcode', operator: 'and', value: 'NOTAUTH' }, 'response', 'value'],
    ['域名正则带断言', { type: 'domain_regex', operator: 'and', value: '(?=ads)' }, 'request', 'value'],
    ['TXT 正则超过 1000 字节', { type: 'response_txt_content', operator: 'and', mode: 'regex', value: 'a'.repeat(1001) }, 'response', 'value'],
  ] as const)('条件：%s', (_, matcher, scope, field) => {
    expect(Object.keys(matcherFieldErrors({ ...matcher }, scope))).toEqual([field])
  })

  // 照 config.rs ignored_negation（kixdns a5126b9 的 a_negation_on_the_first_matcher_is_a_problem）：第一个条件上的「不是」，只有一个条件时
  // 规则级的「不是」，都白写，内核不收；第一个上的「或」、规则级的「不是」配几个条件照常
  // As config.rs ignored_negation (a_negation_on_the_first_matcher_is_a_problem of kixdns a5126b9): not on the first condition, or a
  // chain-level not with a single condition, is written for nothing and refused; or on the first, and a chain-level not over several
  // conditions, pass
  it('白写的「不是」：第一个条件上的、只有一个条件时规则级的', () => {
    const m = (operator: MatcherConfig['operator'] | string = 'and'): MatcherConfig => ({ type: 'domain_suffix', operator: operator as MatcherConfig['operator'], value: 'cn' })
    for (const [matchers, chain] of [[[m()], 'not'], [[m()], 'or_not'], [[m('not')], 'and'], [[m('and-not'), m()], 'and'], [[m('ornot'), m()], 'or']] as const) {
      expect(negationProblem(matchers, chain, 'request'), `${JSON.stringify(matchers)} ${chain}`).toBe('第一个条件前面没有东西可合，写的「不是」不起作用，KixDNS 不收；要排除它，前面先加一个「所有请求」条件')
    }
    for (const [matchers, chain] of [[[m(), m()], 'not'], [[m()], 'or'], [[m()], 'and'], [[m('or'), m('not')], 'and'], [[], 'not']] as const) {
      expect(negationProblem(matchers, chain, 'request'), `${JSON.stringify(matchers)} ${chain}`).toBeNull()
    }
    expect(negationProblem([{ type: 'response_rcode', operator: 'or_not', value: 'NOERROR' }], 'and', 'response')).toBe('第一个回答条件前面没有东西可合，写的「不是」不起作用，KixDNS 不收；要在它不成立时处理，把动作写到「不满足或没有回答时」')
  })

  // TXT 内容「等于」空的只命中空的 TXT，内核照收；「开头是」「匹配正则」空着内核不收 / TXT content 「等于」 empty matches an empty TXT and the
  // kernel takes it; 「开头是」 or 「匹配正则」 empty the kernel refuses
  it('TXT 内容「等于」可以是空的', () => {
    expect(matcherFieldErrors({ type: 'response_txt_content', operator: 'and', mode: 'exact', value: '' }, 'response')).toEqual({})
    for (const mode of ['prefix', 'regex']) expect(Object.keys(matcherFieldErrors({ type: 'response_txt_content', operator: 'and', mode, value: '' }, 'response'))).toEqual(['value'])
  })

  it('内核认的条件照样不报', () => {
    for (const [matcher, scope] of [
      [{ type: 'client_ip', operator: 'and', cidr: '10.0.0.0/8' }, 'request'], [{ type: 'response_answer_ip', operator: 'and', cidr: '0.0.0.0/32, 240.0.0.0/4' }, 'response'],
      [{ type: 'qtype', operator: 'and', value: 'aaaa' }, 'request'], [{ type: 'response_rcode', operator: 'and', value: 'OTHER' }, 'response'],
      [{ type: 'response_txt_content', operator: 'and', mode: 'exact', value: 'a'.repeat(1001) }, 'response'], [{ type: 'domain_regex', operator: 'and', value: '(?P<x>ads)\\.' }, 'request'],
    ] as const) expect(matcherFieldErrors({ ...matcher }, scope)).toEqual({})
  })

  it.each([
    ['固定 IP 有前导零', { type: 'static_ip_response', ip: '01.2.3.4' }, 'ip'],
    ['固定 IP 末尾多一个逗号', { type: 'static_ip_response', ip: '1.2.3.4,' }, 'ip'],
    ['TXT 一段超过 255 字节', { type: 'static_txt_response', text: ['ok', 'a'.repeat(256)] }, 'text'],
    ['改写的 TXT 超过 255 字节', { type: 'replace_txt_response', text: '中'.repeat(86) }, 'text'],
    ['UDP 上游没写端口', { type: 'forward', upstream: 'https://dns.example/dns-query, 223.5.5.5' }, 'upstream'],
    ['TCP 转发的上游没写端口', { type: 'forward', upstream: 'dns.example', transport: 'tcp' }, 'upstream'],
    ['DoQ 用 IP 没写 sni', { type: 'forward', upstream: 'quic://223.5.5.5' }, 'upstream'],
    ['DoH 前缀后面又写了一个前缀', { type: 'forward', upstream: 'doh://https://dns.example/dns-query' }, 'upstream'],
    ['DoT 写了 0rtt', { type: 'forward', upstream: 'tls://dns.example?0rtt=true' }, 'upstream'],
    ['DoQ 的 0rtt 写成 2', { type: 'forward', upstream: 'quic://dns.example?0rtt=2' }, 'upstream'],
  ] as [string, ActionConfig, string][])('动作：%s', (_, action, field) => {
    expect(Object.keys(actionFieldErrors({ ...action }))).toEqual([field])
  })

  it('字段旁边的例子照抄进去，内核也认', () => {
    for (const scope of ['selector', 'request', 'response'] as const) {
      for (const def of MATCHER_DEFINITIONS[scope]) {
        const { example } = matcherHint({ type: def.value, operator: 'and' })
        const matcher: MatcherConfig = { type: def.value, operator: 'and', ...(def.fields.includes('cidr') ? { cidr: example } : {}), ...(def.fields.includes('value') ? { value: example } : {}), ...(def.fields.includes('country_codes') ? { country_codes: example.split(',').map((c) => c.trim()) } : {}) }
        expect(matcherFieldErrors(matcher, scope), `${scope} ${def.value}`).toEqual({})
      }
    }
  })

  // 转发不写上游就问默认上游，经它自己的 transport（「自动识别协议」是没写，按 UDP）：默认上游经 UDP 用得了、经这个 transport 用不了时才报
  // A forward writing no upstream asks the default upstream over its own transport (自动识别协议 writes none, so UDP): only a default upstream
  // usable over UDP yet not over this transport is raised
  it('转发不写上游：问默认上游，经它自己的 transport', () => {
    for (const upstream of [undefined, '', ' , ']) {
      expect(actionFieldErrors({ type: 'forward', upstream, transport: '' })).toEqual({})
      expect(actionFieldErrors({ type: 'forward', upstream, transport: 'doh' }, [], '223.5.5.5:53, tcp://dns.example:53')).toEqual({})
    }
    expect(actionFieldErrors({ type: 'forward', transport: 'doq' }, [], '9.9.9.9:53, quic://dns.example').upstream)
      .toBe('没写上游，问的是默认上游 9.9.9.9:53：DoQ 用 IP 时要写 ?sni=服务器名，比如 quic://223.5.5.5?sni=dns.alidns.com')
    // 经 UDP 就用不了的默认上游设置里会说，这里不重复 / A default upstream unusable over UDP is the settings' to say, not repeated here
    expect(actionFieldErrors({ type: 'forward', transport: 'doq' }, [], 'dns.example:53')).toEqual({})
    // 「自动识别协议」下没写前缀的地址按 UDP 读 / Under 自动识别协议 an address without a prefix reads as UDP
    expect(actionFieldErrors({ type: 'forward', upstream: '223.5.5.5:53', transport: '' })).toEqual({})
  })

  it('内核认的动作照样不报，上游的说法带上是哪个地址', () => {
    for (const action of [
      { type: 'static_ip_response', ip: '1.2.3.4, ::1' }, { type: 'static_txt_response', text: ['中'.repeat(85)] }, { type: 'forward', upstream: '223.5.5.5:53, https://dns.example/dns-query' },
      { type: 'forward', upstream: 'dns.example:53', transport: 'tcp' }, { type: 'forward', upstream: 'quic://223.5.5.5?sni=dns.alidns.com' },
    ]) expect(actionFieldErrors({ ...action })).toEqual({})
    expect(actionFieldErrors({ type: 'forward', upstream: '223.5.5.5' }).upstream).toBe('上游 223.5.5.5：UDP 只能写 IP 和端口，比如 223.5.5.5:53；域名要用 TCP、DoH、DoT 或 DoQ')
    // 照内核的话说清哪儿不对 / Says what is wrong as the kernel does
    const said = (upstream: string) => actionFieldErrors({ type: 'forward', upstream }).upstream
    expect(said('doh://https://dns.example')).toBe('上游 doh://https://dns.example：前缀后面又写了一个前缀，只留一个（DoH 一律走 https）')
    expect(said('tls://tcp://dns.example')).toBe('上游 tls://tcp://dns.example：前缀后面又写了一个前缀，只留一个')
    expect(said('tls://dns.example?sin=a.example')).toBe('上游 tls://dns.example?sin=a.example：DoT 只认 sni、servername 这两个参数')
    expect(said('quic://dns.example?foo=1')).toBe('上游 quic://dns.example?foo=1：DoQ 只认 sni、servername、0rtt、enable_0rtt 这几个参数')
    expect(said('quic://dns.example?0rtt=maybe')).toBe('上游 quic://dns.example?0rtt=maybe：0rtt 只能写 true、false、1、0、yes、no、on 或 off')
  })

  // 有 config_qtype_names_v1 的内核认全部类型名和 TYPEnnn；没有的只认十种，说的也是那十种 / A kernel with config_qtype_names_v1 takes every type
  // name and TYPEnnn; one without takes ten, and those ten are what is said
  describe('记录类型照运行中的内核读', () => {
    afterEach(() => setKernelCapabilities([]))
    const qtype = (value: string) => matcherFieldErrors({ type: 'qtype', operator: 'and', value }, 'request').value
    const answer = (value: string) => matcherFieldErrors({ type: 'response_type', operator: 'and', value }, 'response').value
    it('旧内核', () => {
      expect([qtype('HTTPS'), answer('TYPE65')]).toEqual(['KixDNS 只认 A、AAAA、CNAME、MX、TXT、NS、PTR、SRV、SOA、OPT', 'KixDNS 只认 A、AAAA、CNAME、MX、TXT、NS、PTR、SRV、SOA、OPT'])
      expect(qtype('opt')).toBeUndefined()
    })
    it('新内核', () => {
      setKernelCapabilities([CONFIG_QTYPE_NAMES_V1])
      expect([qtype('HTTPS'), qtype('svcb'), qtype('OPT'), answer('TYPE65'), answer('*')]).toEqual([undefined, undefined, undefined, undefined, undefined])
      expect([qtype('HTTPSS'), answer(' A')]).toEqual(['KixDNS 只认 HTTPS、SVCB、CAA 这样的记录类型名，或 TYPE65 这样的数字写法', 'KixDNS 只认 HTTPS、SVCB、CAA 这样的记录类型名，或 TYPE65 这样的数字写法'])
    })
  })
})
