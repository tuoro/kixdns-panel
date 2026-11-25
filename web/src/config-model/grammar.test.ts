import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_QTYPE_NAMES_V1, isCnameTarget, isIp, isNet, isQclass, isQtype, isRcode, kernelRegexOk, QTYPE_NAMES, QTYPES, setKernelCapabilities, upstreamFault, type UpstreamFault } from './grammar'

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

// grammar.ts 照内核的读法写：下面每一条的答案都是把这个写法放进一份最小配置、跑 kixdns d2b5fc3 的 config::validate 得到的（记录类型照
// 2851950，#563 起 OPT、IXFR、ZERO 也认；只认十种的旧内核是 a5126b9 之前的）。内核收的这里也收、内核拒绝的这里也拒绝；少数几个内核收、这里
// 查不出来的（CNAME 目标里的 IDN 域名）单独说明，宁可多拦不放过
// grammar.ts follows the kernel's reading: every answer below came from putting the form into a minimal config and running the
// config::validate of kixdns d2b5fc3 (record types by 2851950, which since #563 takes OPT, IXFR and ZERO too; the older kernel taking ten is
// one before a5126b9). What the kernel takes is taken here and what it refuses is refused; the few the kernel takes that cannot be checked
// here (IDN names as CNAME targets) are noted apart, erring on the strict side

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

  // 只有 ASCII 字母换成大写，不去空白：「 A」、土耳其的无点 ı、长 s「ſ」、全角字母内核都不认
  // Only ASCII letters are upper-cased and no whitespace is trimmed: 「 A」, the Turkish dotless ı, the long s 「ſ」 and full-width letters
  // are all refused by the kernel
  const NOT_ASCII = [' A', 'A ', 'hınfo', 'ſrv', 'ＡＡＡＡ']
  it('记录类型：旧内核只认十种', () => {
    both(['A', 'aaaa', 'CNAME', 'MX', 'TXT', 'NS', 'PTR', 'SOA', 'SRV', 'OPT', 'opt'], ['HTTPS', 'SVCB', 'CAA', 'ANY', 'SPF', 'DS', 'TYPE65', ...NOT_ASCII], isQtype)
    expect([...QTYPES].sort()).toEqual(['A', 'AAAA', 'CNAME', 'MX', 'NS', 'OPT', 'PTR', 'SOA', 'SRV', 'TXT'])
  })

  describe('记录类型：有 config_qtype_names_v1 的内核', () => {
    afterEach(() => setKernelCapabilities([]))
    it('认 hickory Display 写得出的全部类型名和 TYPEnnn', () => {
      setKernelCapabilities([CONFIG_QTYPE_NAMES_V1])
      both(
        [...QTYPE_NAMES, 'a', 'https', 'Https', 'svcb', 'opt', 'ixfr', '*', 'any', 'TYPE65', 'type65', 'Type65', 'TYPE+65', 'TYPE065', 'TYPE0', 'TYPE41', 'TYPE251', 'TYPE65535', 'type4321'],
        ['SPF', 'HTTPSS', 'UNKNOWN', 'CH', 'TYPE65536', 'TYPE70000', 'TYPE', 'TYPE-1', 'TYPE 65', 'TYPE٦٥', ...NOT_ASCII],
        isQtype,
      )
    })
  })

  it('类别、响应码', () => {
    both(['IN', 'in', 'CH', 'CHAOS', 'chaos', 'HS'], ['ANY', 'NONE', ' IN', 'ın'], isQclass)
    // 内核只认六个响应码和明写的 OTHER，写别的整份配置都不收 / The kernel takes the six rcodes and an explicit OTHER only, anything else having
    // the whole config refused
    both(['NOERROR', 'FORMERR', 'SERVFAIL', 'servfail', 'NXDOMAIN', 'NOTIMP', 'REFUSED', 'OTHER', 'other'], ['NOTAUTH', 'YXDOMAIN', 'BADVERS', 'nonsense', ' SERVFAIL'], isRcode)
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
      // DoH 的参数原样带给上游（host 除外）；DoT 认 sni、servername，DoQ 再认 0rtt、enable_0rtt，键和值大小写不论，空的 sni 不算
      // DoH passes its parameters on (but host); DoT takes sni and servername, DoQ 0rtt and enable_0rtt too, keys and values in any case, an
      // empty sni not counting
      'https://dns.example?host=x', 'https://dns.example/dns-query?foo=bar', 'https://dns.example#x', 'tls://dns.example?servername=a.example', 'tls://dns.example?SNI=a.example',
      'tls://dns.example?sni=', 'tls://dns.example?sni', 'tls://dns.example?', 'tls://dns.example?&', 'tls://dns.example?sni=a.example&sni=', 'tls://dns.example#x',
      'tls://dns.example?%73ni=a.example', 'tls://user@dns.example', 'quic://dns.example?0rtt=true', 'quic://dns.example?0rtt=TRUE', 'quic://dns.example?enable_0rtt=off',
      'quic://dns.example?ENABLE_0RTT=Yes', 'quic://dns.example?0rtt=%74rue', 'quic://1.1.1.1?sni=a.example&0rtt=no', 'quic://dns.example?0rtt=1&0rtt=0',
    ]
    expect(ok.filter((u) => upstreamFault(u) !== null)).toEqual([])
    const refused: [string, UpstreamFault][] = [
      ['223.5.5.5', 'ip-port'], ['223.5.5.5:0', 'port'], ['223.5.5.5:65536', 'ip-port'], ['udp://223.5.5.5', 'ip-port'], ['tcp+udp://223.5.5.5', 'ip-port'],
      ['tcp://223.5.5.5', 'host-port'], ['tcp://dns.example', 'host-port'], ['tcp://dns_x.example:53', 'host'], ['udp://dns.example:53', 'ip-port'], ['2001:db8::1', 'ip-port'],
      ['tcp://2001:db8::1', 'host'], ['https://', 'url'], ['https://dns example/q', 'url'], ['http://dns.example/dns-query', 'prefix'], ['tls://dns.example/path', 'path'],
      ['tls://1.1.1.1?sni=-bad', 'server-name'], ['quic://223.5.5.5', 'sni'], ['foo://x', 'prefix'], ['tls://a..b', 'server-name'], ['tls://中文.example', 'server-name'],
      ['tcp://中文.example:53', 'host'],
      // 前缀后面又写了一个前缀：去掉前缀以后哪儿还有「://」都算，路径和参数里的也算 / A second prefix after the first: a 「://」 anywhere once
      // the prefix is gone counts, in the path or the parameters too
      ['doh://https://dns.example/dns-query', 'second-prefix'], ['https://https://dns.example', 'second-prefix'], ['https://http://dns.example', 'second-prefix'],
      ['doh://dns.example/q?x=https://a', 'second-prefix'], ['https://dns.example/a://b', 'second-prefix'], ['tls://tcp://dns.example', 'second-prefix'],
      ['quic://doq://dns.example', 'second-prefix'], ['tls://a://b', 'second-prefix'],
      // DoT 只认 sni、servername；DoQ 另外认 0rtt、enable_0rtt，值只认 true、false、1、0、yes、no、on、off / DoT takes sni and servername only; DoQ
      // 0rtt and enable_0rtt too, valued true, false, 1, 0, yes, no, on or off only
      ['tls://dns.example?0rtt=true', 'param'], ['tls://dns.example?foo=1', 'param'], ['tls://dns.example?sin=a.example', 'param'], ['tls://dns.example?=x', 'param'],
      ['quic://dns.example?foo=1', 'param'], ['tls://dns.example?sni=-bad&foo=1', 'param'], ['quic://dns.example?0rtt=2', '0rtt'], ['quic://dns.example?0rtt=', '0rtt'],
      ['quic://dns.example?0rtt', '0rtt'], ['quic://dns.example?0rtt=on&0rtt=bad', '0rtt'], ['quic://1.1.1.1?0rtt=1', 'sni'],
    ]
    expect(refused.map(([u]) => [u, upstreamFault(u)])).toEqual(refused)
  })
})
