import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { isCnameTarget, isIp, isNet, isQclass, isQtype, isRcode, kernelRegexOk, QTYPES, upstreamFault, type UpstreamFault } from './grammar'

// 内核怎么读正则：每一条都拿内核的 config::validate 跑过，服务端和页面共用 / How the kernel reads regexes: each run through the kernel's
// config::validate, shared by the server and the page
const KERNEL_REGEXES = (JSON.parse(readFileSync(fileURLToPath(new URL('../../../testdata/kernel-regex.json', import.meta.url)), 'utf8')) as { patterns: { kind: 'domain' | 'txt'; pattern: string; error: string | null }[] }).patterns
// 服务端的回答照内核的原话写成 / The server's answer, written from the kernel's words
const tableAnswer = ({ kind, pattern }: { kind: 'domain' | 'txt'; pattern: string }) => {
  const error = KERNEL_REGEXES.find((c) => c.kind === kind && c.pattern === pattern)!.error
  if (error === null) return { verdict: 'compiles' as const }
  const cause = error.startsWith('regex pattern too long') ? 'too-long' as const : error.includes('exceeds size limit') ? 'too-big' as const : 'syntax' as const
  return { verdict: 'refused' as const, cause, error }
}

// grammar.ts 照内核的读法写：下面每一条的答案都是把这个写法放进一份最小配置、跑 kixdns 79e8fd5 的 config::validate 得到的。
// 内核收的这里也收、内核拒绝的这里也拒绝；少数几个内核收、这里查不出来的（CNAME 目标里的 IDN 域名）单独说明，宁可多拦不放过
// grammar.ts follows the kernel's reading: every answer below came from putting the form into a minimal config and running the
// config::validate of kixdns 79e8fd5. What the kernel takes is taken here and what it refuses is refused; the few the kernel takes that
// cannot be checked here (IDN names as CNAME targets) are noted apart, erring on the strict side

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

  // 正则的回答来自面板服务端照内核编译（见 regex-check.ts）：这里拿内核跑出来的那份表顶替服务端，另起一份模块，不碰下面「还没回答」的那条
  // A regex's answer comes from the panel server compiling it as the kernel does (see regex-check.ts): the table the kernel produced stands in
  // for the server here, in a fresh copy of the modules that leaves the 「not answered yet」 case below untouched
  it('正则：照 Rust 的 regex 读', async () => {
    vi.resetModules()
    const check = await import('./regex-check')
    const { kernelRegexOk } = await import('./grammar')
    const answered = (p: string) => kernelRegexOk('domain', p)
    check.setRegexChecker(async (items) => items.map(tableAnswer))
    const ok = [
      '^a\\.b$', '(?<n>a)', '(?P<n>a)', '\\d+', '[[:alpha:]]+', '(?i)abc', '(?i:abc)', '\\/', '\\-', '\\p{Han}', '\\pL', '\\u0041', '\\x41', '(?s).', '\\A', '\\z',
      '\\<', '\\>', '\\b{start}', '\\\\1', '[\\]]', '(?x) a b', '(?-i)a', '(?i)(?s)a', '(?u)a', '(?R)a', '(?U)a+', '\\a', '\\v', '[\\d\\s]',
    ]
    const refused = [
      '(?=a)', '(?!a)', '(?<=a)b', '(?<!a)b', 'a\\1', '(?P<n>a)\\k<n>', '\\0', 'a{2,1}', '\\cA', '[\\b]', '\\Z', '\\e', '\\h', '\\y', '\\K', '\\G', '\\Q',
      '[\\z]', '[\\A]', '[\\B]',
    ]
    await check.checkKernelRegexes([...ok, ...refused, 'a++'].map((pattern) => ({ kind: 'domain', pattern })))
    both(ok, refused, answered)
    // 内核收、JS 的正则读不了的写法（比如 a++）：以前宁可多拦，现在照内核收 / What the kernel takes but JS's regex cannot read (a++, say): once
    // refused to err on the strict side, now taken as the kernel takes it
    expect(answered('a++')).toBe(true)
  })

  // 面板服务端还没回答（或者连不上）时，页面上自己查的那几条只能拦内核一定不收的：内核收的写法一条都不标红
  // Before the panel server answers (or when it cannot be reached), the page's own checks may only stop what the kernel surely refuses:
  // nothing the kernel takes is marked
  it('正则：服务端还没回答时不比内核严', () => {
    expect(KERNEL_REGEXES.filter((c) => c.error === null && !kernelRegexOk(c.kind, c.pattern)).map((c) => `${c.kind} ${c.pattern}`)).toEqual([])
  })

  // 边打字边写正则时最常停在没写完的样子上：括号、方括号没配上，结尾的反斜杠，前面没东西的 *、+、?、{，没收尾的 {。这些本地就拦下，
  // 不用等服务端回答（等回答的那一下，出错提示会先消失再出来），每一条内核也确实不收
  // Typing a regex stops most often at unfinished shapes: a ( or [ not closed, a trailing backslash, a *, +, ?, { with nothing before it, a
  // { never closed. These are stopped here without waiting for the server (waiting is what made the error vanish and come back), and the
  // kernel does refuse every one
  it('正则：没写完的结构本地就拦下', () => {
    const unfinished = [
      '(', '(a', '(abc', '(abcd', '((a)', '(?:a', '(?P<n>a', '(?i)(', '(?i:', '(?<n>', 'a|(', '\\\\(', 'a)', '(a))', '|a)', '(?i))', '[(]a)',
      '[a', '[a-z', '[^a', '[]a', '[^]', '[[a]', '[a\\]', '[[:alpha:]', 'ab\\', '\\', '*a', '+a', '?a', 'a|*b', '(*a)', '(?:*a)', '(|*)', '(?i)*',
      'a(?i)*', '(?i)+a', '{1}', '{a', 'a|{1}', 'a{', 'a{1', 'a{1,2', 'a{1}{', '\\p{L',
    ]
    const missing = unfinished.filter((p) => !KERNEL_REGEXES.some((c) => c.kind === 'domain' && c.pattern === p && c.error !== null))
    expect(missing, '表里内核不收的').toEqual([])
    expect(unfinished.filter((p) => kernelRegexOk('domain', p))).toEqual([])
    expect(unfinished.filter((p) => kernelRegexOk('txt', p))).toEqual([])
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
