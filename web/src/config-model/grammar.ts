import { PREFIX } from './kernel'
import { kernelRegexVerdict, type RegexCause, type RegexKind } from './regex-check'

// 内核读配置时认的写法：编辑器查一个值写没写对都看这里，读法和内核加载配置时一样，内核拒绝的这里也不认，内核会悄悄另作解释的这里也不放过。
// 依据 kixdns 79e8fd5：matcher/mod.rs parse_dns_type、parse_dns_class、client_net、cidr_list、domain_regex、ResponseRcode、ResponseTxtContent；
// engine/response.rs static_ips、static_cname_target、txt_size_problem；engine/upstream.rs upstream_problem；engine/transport.rs
// check_upstream_address；config.rs 里 ttl（u32）和 ecs 前缀（u8）的类型。网段照 ipnet 2.12 读，IP 和端口照 Rust 标准库读，服务器名照
// rustls-pki-types 1.15 读。每一条都拿内核的 config::validate 跑过（见 kernel-grammar.test.ts）
// What the kernel accepts when it reads a config: every check of whether a value is written right looks here, reading it as the kernel
// does at load, so what the kernel refuses is refused here too and what the kernel would quietly read some other way is caught. Sources
// (kixdns 79e8fd5): matcher/mod.rs parse_dns_type, parse_dns_class, client_net, cidr_list, domain_regex, ResponseRcode, ResponseTxtContent;
// engine/response.rs static_ips, static_cname_target, txt_size_problem; engine/upstream.rs upstream_problem; engine/transport.rs
// check_upstream_address; the types config.rs gives ttl (u32) and the ecs prefixes (u8). Networks read as ipnet 2.12 reads them, IPs and
// ports as Rust's standard library does, server names as rustls-pki-types 1.15 does. Each was run through the kernel's config::validate
// (see kernel-grammar.test.ts)

// ---------- 记录类型、类别、响应码 / record types, classes, rcodes ----------
// 顺序是输入时建议的顺序，常用的在前 / The order is the order suggested while typing, common ones first
/** parse_dns_type 认的记录类型，别的整份配置存不进去 / The record types parse_dns_type takes; any other and the whole config is refused */
export const QTYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'PTR', 'SRV', 'SOA', 'OPT'] as const
/** parse_dns_class 认的类别（CHAOS 是 CH 的另一个写法） / The classes parse_dns_class takes (CHAOS is another spelling of CH) */
export const QCLASSES = ['IN', 'CH', 'HS'] as const
/** 响应码条件认得出的六个；写别的不报错，内核当成「这六个以外的任何响应码」，明写就是 OTHER / The six rcodes a condition knows; any other
 * is not refused but read as 「any code but these six」, which is written OTHER */
export const RCODES = ['NOERROR', 'SERVFAIL', 'NXDOMAIN', 'REFUSED', 'FORMERR', 'NOTIMP'] as const
const oneOf = (list: readonly string[]) => (v: string): boolean => list.includes(v.trim().toUpperCase())
export const isQtype = oneOf(QTYPES)
export const isQclass = oneOf([...QCLASSES, 'CHAOS'])
export const isRcode = oneOf([...RCODES, 'OTHER'])

// ---------- IP 和网段 / IPs and networks ----------
// 两种读法：Rust 标准库（固定回答的 IP、子网的 IP、上游的「IP:端口」）不认 IPv4 的前导零，「::」至少顶一组 0；ipnet（网段）认前导零，
// 「::」前后还能排满 8 组
// Two readings: Rust's standard library (fixed answer IPs, subnet IPs, upstream 「IP:port」) refuses IPv4 leading zeros and makes 「::」
// stand for at least one zero group; ipnet (networks) takes leading zeros and lets the groups around 「::」 fill all eight
type Reading = 'std' | 'ipnet'
function ipv4(text: string, reading: Reading): boolean {
  const parts = text.split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) < 256 && (reading === 'ipnet' || p === '0' || !p.startsWith('0')))
}
function ipv6(text: string, reading: Reading): boolean {
  const halves = text.split('::')
  if (halves.length > 2) return false
  const groups = (half: string) => (half === '' ? [] : half.split(':'))
  let count = 0
  // IPv4 的写法只能放在整个地址的最后，占两组 / The IPv4 form can only end the whole address, taking two groups
  const read = (list: string[], endsAddress: boolean) => list.every((g, i) => {
    if (endsAddress && i === list.length - 1 && g.includes('.')) { count += 2; return ipv4(g, reading) }
    count += 1
    return /^[0-9a-f]{1,4}$/i.test(g)
  })
  if (halves.length === 1) return read(groups(halves[0]!), true) && count === 8
  if (!read(groups(halves[0]!), false)) return false
  const head = count
  return read(groups(halves[1]!), true) && head < 8 && count <= (reading === 'std' ? 7 : 8)
}
/** 一个 IP，照 Rust 标准库读 / One IP, read as Rust's standard library does */
export const isIp = (v: string): boolean => ipv4(v, 'std') || ipv6(v, 'std')
/** 单个 IP 补上整段的前缀 / A single IP takes its full-length prefix */
export const cidrOf = (v: string): string => (v.includes('/') ? v : `${v}/${v.includes(':') ? 128 : 32}`)
/** 内核配置里的一个网段，照 ipnet 读：一定带前缀，IPv4 不超过 32、IPv6 不超过 128 / One network as a kernel config writes it, read as ipnet does:
 * always with a prefix, at most 32 for IPv4 and 128 for IPv6 */
export function isNet(text: string): boolean {
  const [ip = '', prefix, ...rest] = text.split('/')
  if (prefix === undefined || rest.length) return false
  if (ipv4(ip, 'ipnet')) return /^\d{1,2}$/.test(prefix) && Number(prefix) <= 32
  return ipv6(ip, 'ipnet') && /^\d{1,3}$/.test(prefix) && Number(prefix) <= 128
}
/** 面板里写的一个网段，单个 IP 也算（写进内核时补上前缀） / One network as written in the panel, a single IP included (it takes its prefix
 * when written to the kernel) */
export const isCidr = (v: string): boolean => isNet(cidrOf(v))

// ---------- 域名 / names ----------
const ASCII_NAME = /^(\*\.)?[a-z0-9_-]+(\.[a-z0-9_-]+)*\.?$/i
/**
 * 规则和映射里的域名写进内核的样子：内核拿查询名的每一级照原样比，查询名到内核时是 punycode，所以中文这样的级换成 punycode（IDNA，和浏览器
 * 地址栏一样，顺带变成小写）；全是 ASCII 的一个字不动。开头的 *. 照样留着；换不了（带空格、冒号、斜杠这类）的原样，isDomain 不收它
 * A rule's or mapping's name as written to the kernel: the kernel compares each label of the query name as written and query names arrive in
 * punycode, so labels such as Chinese ones become punycode (IDNA, as a browser's address bar does, lower-cased on the way); an all-ASCII
 * name is left exactly as it is. A leading *. stays as it is; one that cannot convert (with a space, colon, slash and the like) stays as
 * written, and isDomain refuses it
 */
export function kernelDomain(name: string): string {
  if (!/[^\x00-\x7f]/.test(name) || /[\s/:?#@[\]\\%]/.test(name)) return name
  try { return new URL(`http://${name}`).hostname } catch { return name }
}
/** 规则和映射里的域名：中文这样的域名照收，换成 punycode 以后看写得对不对 / A name in a rule or mapping: Chinese and other Unicode names are
 * taken, checked once converted to punycode */
export const isDomain = (v: string): boolean => ASCII_NAME.test(kernelDomain(v))
/** CNAME 的目标照 hickory 的域名读：每一级最长 63 字节，不能以横线开头，整个名字不超过 253 字节 / A CNAME target read as hickory reads
 * names: each label at most 63 bytes and not starting with a hyphen, the whole name at most 253 bytes */
export const isCnameTarget = (v: string): boolean =>
  ASCII_NAME.test(v) && v.replace(/\.$/, '').length <= 253 && v.replace(/\.$/, '').split('.').every((label) => label.length <= 63 && !label.startsWith('-'))

// ---------- 正则 / regexes ----------
// Rust 正则认的字母转义：哪儿都能用的，和只能在字符组外面用的；别的字母、数字（反向引用，连 \0）都不认，标点随便转义
// The letter escapes Rust regexes know: those allowed anywhere, and those allowed outside a class only; any other letter, and digits
// (backreferences, \0 included), are refused, while punctuation may always be escaped
const ESCAPES = 'afnrtvdDsSwWpPxuU'
const OUTSIDE_CLASS = 'bBAz'
/**
 * 内核一定不收、页面自己就看得出的写法：前后断言、反向引用（连 \0）、Rust 不认的字母转义（\k、\c、\Z、字符组里的 \b……），还有没写完的
 * 结构——括号、方括号没配上，结尾一个孤零零的反斜杠，*、+、?、{ 前面没有要重复的（开头、| 后面、( 后面、(?i) 这样的标志后面），
 * { 后面再没有 }。边打字边写正则时停在这些样子上最多，本地就拦下，不用等服务端回答。字符组照 Rust 读：紧跟在 [ 或 [^ 后面的 ] 是字符本身，
 * 字符组里的 [ 开一个嵌套的字符组。带 x 标志的不在这里查：x 模式里 # 后面是注释，那里写什么内核都收。只查这些，绝不比内核严（每一条都拿内核
 * 跑过的用例对过，见 testdata/kernel-regex.json）；别的（范围写错、{} 里写错、编译后太大……）等服务端照内核编译一遍再说
 * What the kernel surely refuses and the page can tell itself: lookaround, backreferences (\0 included), letter escapes Rust does not know
 * (\k, \c, \Z, \b inside a class…), and structure left unfinished — a ( or [ never closed or a ) never opened, a lone backslash at the
 * end, *, +, ?, { with nothing to repeat (at the start, after |, after (, after a flag group such as (?i)), a { with no } after it.
 * Typing a regex stops at these shapes most, so they are stopped here without waiting for the server. Classes are read as Rust reads them:
 * a ] right after [ or [^ is the character itself, and a [ inside a class opens a nested one. A pattern with the x flag is not checked
 * here: in x mode a # starts a comment, where the kernel takes anything. Only these, so never stricter than the kernel (each checked
 * against cases run through the kernel, see testdata/kernel-regex.json); the rest (a bad range, a wrong {}, too large compiled…) waits
 * for the server to compile it as the kernel does
 */
export function regexSurelyRefused(regex: string): boolean {
  if (/\(\?[A-Za-z-]*x/.test(regex)) return false
  let depth = 0
  let groups = 0
  // 这里没有可以重复的：开头、| 后面、开一个组以后、标志组以后 / Nothing here to repeat: at the start, after |, after opening a group, after
  // a flag group
  let bare = true
  for (let i = 0; i < regex.length; i++) {
    const c = regex[i]!
    if (c === '\\') {
      if (i + 1 === regex.length) return true
      const next = regex[i + 1]!
      if (/[0-9]/.test(next) || (/[A-Za-z]/.test(next) && !ESCAPES.includes(next) && (depth > 0 || !OUTSIDE_CLASS.includes(next)))) return true
      i++
      bare = false
    } else if (c === '[') {
      depth++
      if (regex[i + 1] === '^') i++
      if (regex[i + 1] === ']') i++
      bare = false
    } else if (c === ']' && depth > 0) depth--
    else if (depth > 0) continue
    else if (/^\(\?<?[=!]/.test(regex.slice(i, i + 4))) return true
    else if (c === '(') {
      // (?i) 只改标志、不开组；(?i:、(?:、(?P<n>、(?<n> 开组 / (?i) only sets flags and opens no group; (?i:, (?:, (?P<n>, (?<n> open one
      const named = /^\(\?P?<[^>]*>/.exec(regex.slice(i))
      const flags = named ? null : /^\(\?[A-Za-z-]*([:)])/.exec(regex.slice(i))
      const opener = named?.[0] ?? flags?.[0] ?? '('
      if (flags?.[1] !== ')') groups++
      i += opener.length - 1
      bare = true
    } else if (c === ')') {
      if (--groups < 0) return true
      bare = false
    } else if (c === '|') bare = true
    else if (c === '*' || c === '+' || c === '?' || c === '{') {
      if (bare) return true
      if (c === '{' && !regex.includes('}', i)) return true
    } else bare = false
  }
  return depth > 0 || groups > 0
}
/**
 * 内核为什么不收这个正则（域名的、TXT 内容的）；收、或者还说不上时为 null。面板服务端照内核编译过的就用它的回答（见 regex-check.ts）；
 * 还没回答、连不上、太长不查时只拦本地看得出的：TXT 的长度，和 regexSurelyRefused 那几种，别的先不标红，保存时内核自己还会再查一遍
 * Why the kernel refuses this regex (for names, for TXT content); null when it takes it or nothing can be said yet. Once the panel server
 * has compiled it as the kernel does, its answer is used (see regex-check.ts); before that, while it cannot be reached, or for one too long
 * to check, only what the page can tell is stopped: a TXT regex's length, and what regexSurelyRefused finds, nothing else being marked
 * yet, the kernel checking once more on save
 */
export function kernelRegexCause(kind: RegexKind, regex: string): RegexCause | null {
  const verdict = kernelRegexVerdict(kind, regex)
  if (verdict?.verdict === 'refused') return verdict.cause
  if (verdict?.verdict === 'compiles') return null
  if (kind === 'txt' && byteLength(regex) > TXT_REGEX_BYTES) return 'too-long'
  return regexSurelyRefused(regex) ? 'syntax' : null
}
/** 内核读不读得了这个正则 / Whether the kernel can read this regex */
export const kernelRegexOk = (kind: RegexKind, regex: string): boolean => kernelRegexCause(kind, regex) === null
/** 编辑器里怎么说内核为什么不收：域名的和 TXT 的正则编译的上限一样，都是 1 MB；只有 TXT 另有 1000 字节的长度上限 / How the editor says
 * why the kernel refuses a regex: name and TXT regexes compile within the same 1 MB; only a TXT one also has a 1000-byte length limit */
export function regexCauseText(cause: RegexCause): string {
  if (cause === 'too-long') return `TXT 的正则最长 ${TXT_REGEX_BYTES} 字节`
  if (cause === 'too-big') return '正则编译出来超过 KixDNS 的 1 MB 上限：\\w、\\pL 配上 {n} 最占地方'
  return '正则写得不对，或者用了 KixDNS 不认的写法，比如前后断言、反向引用'
}
/** TXT 内容的正则最长 1000 字节（内核先看长度，再按 1 MB 编译） / A TXT content regex is at most 1000 bytes (the kernel looks at the
 * length first, then compiles within 1 MB) */
export const TXT_REGEX_BYTES = 1000

// ---------- 长度和数 / lengths and numbers ----------
export const byteLength = (text: string): number => new TextEncoder().encode(text).length
/** 一段 TXT 最长 255 字节；面板只写一段 / A TXT segment is at most 255 bytes, and the panel writes one */
export const TXT_SEGMENT_BYTES = 255
/** TTL 是 u32：0 到 4294967295 的整数 / A TTL is a u32: a whole number from 0 to 4294967295 */
export const isTtl = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 4_294_967_295
export const TTL_PROBLEM = 'TTL 填 0 到 4294967295 之间的整数'
/** 子网前缀：0 到地址的位数（内核读得进 255 以内的数，超过位数的悄悄截掉） / A subnet prefix: 0 up to the address's bits (the kernel reads
 * any number up to 255 and quietly cuts one beyond the bits) */
export const isPrefix = (n: unknown, bits: number): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= bits

// ---------- 上游地址 / upstream addresses ----------
/** 上游地址哪里不对：前缀、UDP 要「IP:端口」、端口、TCP 的主机、DoH 链接、DoT / DoQ 的路径和服务器名、DoQ 用 IP 时要 sni / What is wrong with an
 * upstream: the prefix, UDP's 「IP:port」, the port, TCP's host, the DoH link, the DoT / DoQ path and server name, DoQ's sni for an IP */
export type UpstreamFault = 'prefix' | 'ip-port' | 'port' | 'host-port' | 'host' | 'url' | 'path' | 'server-name' | 'sni'

const port = (digits: string): number | null => (Number(digits) <= 65535 ? Number(digits) : null)
// SocketAddr 的写法：「IPv4:端口」或「[IPv6]:端口」，IPv6 可以带「%数字」的作用域 / A SocketAddr: 「IPv4:port」 or 「[IPv6]:port」, the IPv6 may carry a 「%number」 scope
function socketPort(address: string): number | null {
  const v4 = /^([^:[\]]+):(\d+)$/.exec(address)
  if (v4 && ipv4(v4[1]!, 'std')) return port(v4[2]!)
  const v6 = /^\[([^\]%]+)(?:%(\d+))?\]:(\d+)$/.exec(address)
  if (v6 && ipv6(v6[1]!, 'std') && (v6[2] === undefined || Number(v6[2]) <= 4_294_967_295)) return port(v6[3]!)
  return null
}
// rustls 的服务器名：IP，或者每一级 1 到 63 个字母、数字、下划线、横线（不以横线开头结尾），最后一级不全是数字
// A rustls server name: an IP, or labels of 1 to 63 letters, digits, underscores and hyphens (no hyphen at either end), the last not all digits
function serverName(name: string): boolean {
  if (isIp(name)) return true
  const labels = (name.endsWith('.') ? name.slice(0, -1) : name).split('.')
  return name.length <= 253 && labels.every((l) => /^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/.test(l) && !l.endsWith('-')) && !/^\d+$/.test(labels.at(-1)!)
}
const url = (text: string): URL | null => { try { return new URL(text) } catch { return null } }

/** 一个上游（写进内核的样子，带不带前缀都行）内核用不用得了，照 upstream_problem 读；用得了为 null。没写前缀时按 transport（转发动作的
 * transport，缺省 UDP） / Whether the kernel can use one upstream (as written to the kernel, with or without a prefix), read as upstream_problem
 * does; null when it can. Without a prefix it is read as transport (the forward action's, UDP by default) */
export function upstreamFault(upstream: string, transport = 'udp'): UpstreamFault | null {
  const at = parseUpstream(upstream, transport)
  return at.transport ? addressFault(at.address, at.transport) : 'prefix'
}
/** 上游地址读的是哪种传输：前缀说了算，没写前缀就是 transport / Which transport an upstream is read as: its prefix, or transport without one */
export const upstreamTransport = (upstream: string, transport = 'udp'): string => parseUpstream(upstream, transport).transport ?? transport
// parse_upstream_addr：前缀和后面的地址分开，前缀认不出时传输为 null / parse_upstream_addr: the prefix apart from the address, the transport null
// for an unknown prefix
function parseUpstream(upstream: string, transport: string): { transport: string | null; address: string } {
  const text = upstream.trim()
  const at = text.indexOf('://')
  return at < 0 ? { transport, address: text } : { transport: PREFIX[text.slice(0, at).toLowerCase()] ?? null, address: text.slice(at + 3) }
}
function addressFault(address: string, transport: string): UpstreamFault | null {
  if (transport === 'udp' || transport === 'tcp_udp') {
    const p = socketPort(address)
    return p === null ? 'ip-port' : p === 0 ? 'port' : null
  }
  if (transport === 'tcp') {
    const p = socketPort(address)
    if (p !== null) return p === 0 ? 'port' : null
    const cut = address.lastIndexOf(':')
    if (cut < 0) return 'host-port'
    const digits = address.slice(cut + 1)
    if (!/^\+?\d+$/.test(digits) || port(digits.replace('+', '')) === null || Number(digits) === 0) return 'port'
    return /^[A-Za-z0-9.-]+$/.test(address.slice(0, cut)) ? null : 'host'
  }
  if (transport === 'doh') return url(/^https?:\/\//.test(address) ? address : `https://${address}`)?.hostname ? null : 'url'
  // DoT、DoQ：主机、端口（缺省 853），不能带路径，sni / servername 参数（空的不算，几个取最后一个） / DoT and DoQ: host, port (853 by
  // default), no path, the sni / servername parameter (an empty one does not count, the last of several wins)
  const u = url(`${transport}://${address}`)
  const host = u?.hostname.replace(/^\[(.*)\]$/, '$1')
  if (!u || !host) return 'url'
  if (u.pathname !== '' && u.pathname !== '/') return 'path'
  const sni = [...u.searchParams].filter(([k, v]) => /^(sni|servername)$/i.test(k) && v !== '').at(-1)?.[1]
  if (transport === 'doq' && sni === undefined && isIp(host)) return 'sni'
  return serverName(sni ?? host) ? null : 'server-name'
}
