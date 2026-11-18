import { describe, expect, it } from 'vitest'
import { isCnameTarget, isIp, isNet, isQclass, isQtype, isRcode, kernelRegexOk, QTYPES, upstreamFault, type UpstreamFault } from './grammar'

// grammar.ts 照内核的读法写：下面每一条的答案都是把这个写法放进一份最小配置、跑 kixdns 79e8fd5 的 config::validate 得到的。
// 内核收的这里也收、内核拒绝的这里也拒绝；少数几个内核收、这里查不出来的（JS 的正则、IDN 域名）单独说明，宁可多拦不放过
// grammar.ts follows the kernel's reading: every answer below came from putting the form into a minimal config and running the
// config::validate of kixdns 79e8fd5. What the kernel takes is taken here and what it refuses is refused; the few the kernel takes that
// cannot be checked here (JS regexes, IDN names) are noted apart, erring on the strict side

const both = <T>(ok: T[], refused: T[], check: (v: T) => boolean) => {
  expect(ok.filter((v) => !check(v)), '内核收的').toEqual([])
  expect(refused.filter(check), '内核拒绝的').toEqual([])
}

describe('内核的读法', () => {
  it('规则的 client_ip 和回答的网段：照 ipnet 读，一定带前缀', () => {
    both([
      '10.0.0.0/8', '10.0.0.0/32', '10.0.0.0/08', '010.0.0.0/8', '01.2.3.4/32', '::1/128', '::/0', '1:2:3:4:5:6:7::8/128', '1:2:3:4:5:6:7:8/128',
      '::ffff:1.2.3.4/128', '::1.2.3.4/128', '1:2:3:4:5:6::1.2.3.4/128', '1:2:3:4:5::1.2.3.4/128', '1:2:3:4:5:6:1.2.3.4/128', '2001:DB8::/32',
    ], [
      '10.0.0.0/8,192.168.0.0/16', '10.0.0.1', '10.0.0.0/33', '10.0.0.0/99', '10.0.0.0/008', '256.0.0.0/8', '1:::2/128', '1:2:3:4:5:6:7:8:9/128',
      '1.2.3.4::/128', '2001:db8::/129', '00001::/16', ' 10.0.0.0/8', '10.0.0.0/8 ', '1::2::3/64', ':1/128', '1:/128', 'fe80::1%eth0/64',
    ], isNet)
  })

  it('固定回答的 IP 和子网的 IP：照 Rust 标准库读', () => {
    both(
      ['1.2.3.4', '0.0.0.0', '255.255.255.255', '::1', '::', '1::', '1:2:3:4:5::1.2.3.4', '::ffff:1.2.3.4', '1:2:3:4:5:6:7::', '::1:2:3:4:5:6:7', '1:2:3:4:5:6:1.2.3.4'],
      ['01.2.3.4', '1.2.3.04', '1:::2', '1:2:3:4:5:6:7::8', '1:2:3:4:5:6::1.2.3.4', '1.2.3.4::', 'fe80::1%2', '1.2.3.4/32'],
      isIp,
    )
  })

  it('记录类型、类别、响应码', () => {
    both(['A', 'aaaa', 'CNAME', 'MX', 'TXT', 'NS', 'PTR', 'SOA', 'SRV', 'OPT'], ['HTTPS', 'SVCB', 'CAA', 'ANY', 'SPF', 'DS'], isQtype)
    expect([...QTYPES].sort()).toEqual(['A', 'AAAA', 'CNAME', 'MX', 'NS', 'OPT', 'PTR', 'SOA', 'SRV', 'TXT'])
    both(['IN', 'in', 'CH', 'CHAOS', 'HS'], ['ANY', 'NONE'], isQclass)
    // 认不出的响应码内核照收，只是当成「其余的响应码」：这里只收它认得出的六个和明写的 OTHER
    // The kernel takes an unknown rcode and reads it as 「any other code」: only the six it knows and an explicit OTHER are taken here
    both(['NOERROR', 'FORMERR', 'SERVFAIL', 'servfail', 'NXDOMAIN', 'NOTIMP', 'REFUSED', 'OTHER'], ['NOTAUTH', 'YXDOMAIN', 'BADVERS', 'nonsense'], isRcode)
  })

  it('正则：照 Rust 的 regex 读', () => {
    both([
      '^a\\.b$', '(?<n>a)', '(?P<n>a)', '\\d+', '[[:alpha:]]+', '(?i)abc', '(?i:abc)', '\\/', '\\-', '\\p{Han}', '\\pL', '\\u0041', '\\x41', '(?s).', '\\A', '\\z',
      '\\<', '\\>', '\\b{start}', '\\\\1', '[\\]]', '(?x) a b', '(?-i)a', '(?i)(?s)a', '(?u)a', '(?R)a', '(?U)a+', '\\a', '\\v', '[\\d\\s]',
    ], [
      '(?=a)', '(?!a)', '(?<=a)b', '(?<!a)b', 'a\\1', '(?P<n>a)\\k<n>', '\\0', 'a{2,1}', '\\cA', '[\\b]', '\\Z', '\\e', '\\h', '\\y', '\\K', '\\G', '\\Q',
      '[\\z]', '[\\A]', '[\\B]',
    ], kernelRegexOk)
    // 内核收、JS 的正则读不了的写法这里不收（比如 a++）：宁可多拦 / What the kernel takes but JS's regex cannot read is refused here (a++, say):
    // the strict side
    expect(kernelRegexOk('a++')).toBe(false)
  })

  it('CNAME 的目标：照 hickory 的域名读', () => {
    both(
      ['a.example', 'a-.example', '_a.example', `${'a'.repeat(63)}.example`, '*.example', '1.2.3.4', 'a.example.', '_dmarc.example'],
      ['a.-b', '-a.example', 'a b.example', `${'a'.repeat(64)}.example`, 'a.example..', '.a.example', 'a*.example', 'a/b.example', 'a:b.example'],
      isCnameTarget,
    )
    // 内核收、面板的域名写法不收的：IDN、中间的 *、根名 / Taken by the kernel, refused by the panel's name syntax: IDN, a * inside, the root
    expect(['中文.example', 'a.*.example', '.'].filter(isCnameTarget)).toEqual([])
  })

  it('上游地址：照 upstream_problem 读', () => {
    const ok = [
      '223.5.5.5:53', '223.5.5.5:053', 'udp://223.5.5.5:53', 'tcp+udp://223.5.5.5:53', 'udp+tcp://223.5.5.5:53', 'tcp://dns.example:53', '[2001:db8::1]:53',
      'tcp://[2001:db8::1]:53', '[fe80::1%2]:53', 'https://dns.example/dns-query', 'https://dns.example', 'doh://dns.example/dns-query', 'tls://dns.alidns.com',
      'tls://dns.alidns.com:853', 'tls://1.1.1.1', 'tls://[2001:db8::1]', 'tls://dns.example?sni=x.example', 'dot://dns.example', 'quic://223.5.5.5?sni=alidns.com',
      'quic://dns.alidns.com', 'doq://dns.alidns.com:853', 'TCP://223.5.5.5:53', 'HTTPS://dns.example/dns-query', 'tls://dns_x.example', 'tls://xn--fiq228c.example',
    ]
    expect(ok.filter((u) => upstreamFault(u) !== null)).toEqual([])
    const refused: [string, UpstreamFault][] = [
      ['223.5.5.5', 'ip-port'], ['223.5.5.5:0', 'port'], ['223.5.5.5:65536', 'ip-port'], ['udp://223.5.5.5', 'ip-port'], ['tcp+udp://223.5.5.5', 'ip-port'],
      ['tcp://223.5.5.5', 'host-port'], ['tcp://dns.example', 'host-port'], ['tcp://dns_x.example:53', 'host'], ['udp://dns.example:53', 'ip-port'], ['2001:db8::1', 'ip-port'],
      ['tcp://2001:db8::1', 'host'], ['https://', 'url'], ['https://dns example/q', 'url'], ['http://dns.example/dns-query', 'prefix'], ['tls://dns.example/path', 'path'],
      ['tls://1.1.1.1?sni=-bad', 'server-name'], ['quic://223.5.5.5', 'sni'], ['foo://x', 'prefix'], ['tls://a..b', 'server-name'], ['tls://中文.example', 'server-name'],
      ['tcp://中文.example:53', 'host'],
    ]
    expect(refused.map(([u]) => [u, upstreamFault(u)])).toEqual(refused)
  })
})
