import type { KMatcher } from './kernel'

// 拦截列表：AdGuard、Adblock 语法和 hosts 文件里 DNS 用得上的那部分，写法照 https://adguard-dns.io/kb/general/dns-filtering-syntax/。
// 订阅的列表由面板服务端解析、合并成一个 GeoSite 文件（crates/panel-server/src/blocklist.rs）；这里解析页面上自己写的规则，
// 规则和服务端完全一样，两边都拿 testdata/blocklist-syntax.json 的用例测。
// Blocklists: the part of the AdGuard and Adblock syntax and of hosts files that DNS can use, as
// https://adguard-dns.io/kb/general/dns-filtering-syntax/ describes it. Subscribed lists are parsed and merged into one GeoSite file
// by the panel server (crates/panel-server/src/blocklist.rs); this parses the rules written on the page, by exactly the server's rules,
// and both sides are tested on the cases in testdata/blocklist-syntax.json.

/** 合并文件里四个分类的名字 / The four category names in the merged file */
export const TAG_BLOCK = 'kixdns-panel-block'
export const TAG_ALLOW = 'kixdns-panel-allow'
export const TAG_BLOCK_IMPORTANT = 'kixdns-panel-block-important'
export const TAG_ALLOW_IMPORTANT = 'kixdns-panel-allow-important'
/** 拦下的请求进的 Pipeline，只回拦截 / The pipeline blocked requests enter, which only blocks */
export const BLOCKLIST_PIPELINE = 'blocklist'
/** 内核里那条规则的名字：命中数和查询日志按它认 / The kernel rule's name, by which hit counts and the query log know it */
export const BLOCKLIST_RULE = '拦截列表'
/** 自己写的规则最多这么多条，再多请用订阅 / The most rules of one's own; beyond that, use a subscription */
export const MAX_OWN_RULES = 1000
/** 最多订阅这么多个列表，和服务端一样 / The most lists one can subscribe to, as on the server */
export const MAX_SUBSCRIPTIONS = 32

export type MatchKind = 'suffix' | 'exact' | 'regex'
/** 一条规则管哪些域名：域名和子域名、只有域名本身、按正则匹配整个域名 / Which names a rule covers: a name and its subdomains, the name only, or a regex over the whole name */
export interface Match { kind: MatchKind; value: string }
export interface ListRule { allow: boolean; important: boolean; match: Match }
export type Skip =
  | { reason: 'cosmetic' | 'hosts-address' | 'bad-regex' | 'too-many-patterns' | 'url-path' | 'unreadable' }
  | { reason: 'unsupported-modifier' | 'unknown-modifier'; modifier: string }
export type Line =
  | { kind: 'ignored' }
  | { kind: 'rules'; rules: ListRule[] }
  // 停用写法完全相同的那条规则 / Disables the rule written exactly so
  | { kind: 'badfilter'; rule: string }
  | { kind: 'skipped'; skip: Skip }

// hosts 文件里的本机条目：不是拦截规则 / Local entries in hosts files: no blocking rules
const LOCAL_NAMES = new Set(['localhost', 'localhost.localdomain', 'local', 'broadcasthost', 'ip6-localhost', 'ip6-loopback', 'ip6-localnet', 'ip6-mcastprefix', 'ip6-allnodes', 'ip6-allrouters', 'ip6-allhosts', '0.0.0.0'])
// 认识、但还不支持的修饰符 / Modifiers known but not yet supported
const UNSUPPORTED_MODIFIERS = new Set(['client', 'ctag', 'dnstype', 'dnsrewrite', 'denyallow', 'respgeo'])
const COSMETIC_MARKS = ['##', '#@#', '#?#', '#$#', '#%#', '$$']

/** 读一行规则 / Reads one line */
export function parseLine(raw: string): Line {
  const line = raw.trim()
  if (!line || line.startsWith('!') || line.startsWith('#') || line.startsWith('[')) return { kind: 'ignored' }
  const hosts = parseHosts(line)
  if (hosts) return hosts
  if (COSMETIC_MARKS.some((mark) => line.includes(mark))) return { kind: 'skipped', skip: { reason: 'cosmetic' } }
  const allow = line.startsWith('@@')
  const body = allow ? line.slice(2) : line
  const split = splitModifiers(body)
  if (!split) return { kind: 'skipped', skip: { reason: 'unreadable' } }
  const [pattern, modifiers] = split
  let important = false
  let badfilter = false
  const kept: string[] = []
  for (const modifier of modifiers.map((m) => m.trim())) {
    const name = (modifier.replace(/^~+/, '').split('=')[0] ?? '').toLowerCase()
    if (name === 'badfilter') { badfilter = true; continue }
    if (name === 'important') important = true
    else if (!name) return { kind: 'skipped', skip: { reason: 'unreadable' } }
    else if (UNSUPPORTED_MODIFIERS.has(name)) return { kind: 'skipped', skip: { reason: 'unsupported-modifier', modifier: name } }
    else return { kind: 'skipped', skip: { reason: 'unknown-modifier', modifier: name } }
    kept.push(modifier)
  }
  if (badfilter) return { kind: 'badfilter', rule: `${allow ? '@@' : ''}${pattern}${kept.length ? `$${kept.join(',')}` : ''}` }
  const match = parsePattern(pattern)
  return 'reason' in match ? { kind: 'skipped', skip: match } : { kind: 'rules', rules: [{ allow, important, match }] }
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
/** hosts 一行开头的地址：拦截用的（0.0.0.0、::、本机地址）、别的地址，或者根本不是地址 / The address leading a hosts line: a blocking one (0.0.0.0, ::, loopback), another one, or no address at all */
function hostsAddress(token: string): 'block' | 'other' | null {
  // 带网卡的 IPv6（fe80::1%lo0）：网卡不算地址 / An IPv6 address with a zone (fe80::1%lo0): the zone is no part of it
  const address = token.split('%')[0] ?? ''
  if (IPV4.test(address)) return address === '0.0.0.0' || address.startsWith('127.') ? 'block' : 'other'
  if (!address.includes(':') || /[^0-9a-f:.]/i.test(address)) return null
  try {
    const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1)
    return canonical === '::' || canonical === '::1' ? 'block' : 'other'
  } catch {
    return null
  }
}

/** hosts 文件的一行（「地址 域名…」）；不是这种写法时为 null / A hosts-file line (「address name…」); null when the line is not written so */
function parseHosts(line: string): Line | null {
  const [address, ...tokens] = line.split(/\s+/)
  const kind = hostsAddress(address ?? '')
  if (!kind) return null
  const end = tokens.findIndex((t) => t.startsWith('#'))
  const names = (end < 0 ? tokens : tokens.slice(0, end)).filter((name) => !LOCAL_NAMES.has(name.toLowerCase()))
  if (!names.length) return { kind: 'ignored' }
  if (kind === 'other') return { kind: 'skipped', skip: { reason: 'hosts-address' } }
  const rules: ListRule[] = []
  for (const name of names) {
    const value = normalizeDomain(name)
    if (!value) return { kind: 'skipped', skip: { reason: 'unreadable' } }
    rules.push({ allow: false, important: false, match: { kind: 'exact', value } })
  }
  return { kind: 'rules', rules }
}

/** 把规则和修饰符分开：正则（`/…/`）自己可能带 `$`，修饰符只认最后一个 `/` 后面的 / Splits a rule from its modifiers: a regex (`/…/`) may hold a `$`, so its modifiers are only what follows its last `/` */
function splitModifiers(body: string): [string, string[]] | null {
  if (body.startsWith('/')) {
    const end = body.lastIndexOf('/')
    if (end <= 0) return null
    const tail = body.slice(end + 1)
    if (tail && !tail.startsWith('$')) return null
    return [body.slice(0, end + 1), tail ? tail.slice(1).split(',') : []]
  }
  const at = body.lastIndexOf('$')
  return at < 0 ? [body, []] : [body.slice(0, at), body.slice(at + 1).split(',')]
}

/** 规则本身（去掉 `@@` 和修饰符以后）管哪些域名 / Which names the rule itself covers (once `@@` and modifiers are off) */
function parsePattern(pattern: string): Match | Skip {
  if (pattern.length > 1 && pattern.startsWith('/') && pattern.endsWith('/')) {
    const regex = pattern.slice(1, -1)
    if (!regex) return { reason: 'unreadable' }
    return kernelRegexOk(regex) ? { kind: 'regex', value: ignoringCase(regex) } : { reason: 'bad-regex' }
  }
  let lower = pattern.toLowerCase()
  // AdGuard 拿「http://域名」去匹配 DNS 查询，所以开头的 `://` 和 `|` 一样是域名的开头
  // AdGuard matches a DNS query as 「http://name」, so a leading `://` marks the start of the name as `|` does
  if (lower.startsWith('://')) lower = `|${lower.slice(3)}`
  const stripEnd = (p: string, ends: string[]) => { const end = ends.find((e) => p.endsWith(e)); return end === undefined ? null : p.slice(0, -end.length) }
  if (lower.startsWith('||')) {
    const name = stripEnd(lower.slice(2), ['^|', '^'])
    const value = name === null ? null : normalizeDomain(name)
    if (value) return { kind: 'suffix', value }
  }
  if (lower.startsWith('|') && !lower.startsWith('||')) {
    const name = stripEnd(lower.slice(1), ['^|', '^', '|'])
    const value = name === null ? null : normalizeDomain(name)
    if (value) return { kind: 'exact', value }
  }
  const exact = normalizeDomain(lower)
  if (exact) return { kind: 'exact', value: exact }
  const regex = patternRegex(lower)
  // 带网址路径的（`||example.com/ads.js`）只对浏览器有用：DNS 查询里没有路径 / One with a URL path (`||example.com/ads.js`) is for browsers only: a DNS query carries no path
  if (regex === null) return { reason: lower.includes('/') ? 'url-path' : 'unreadable' }
  return { kind: 'regex', value: regex }
}

/** 内核按 Rust 的正则读：前后断言、反向引用这些写法它不认 / The kernel reads Rust regex syntax, which has no lookaround or backreferences */
function kernelRegexOk(regex: string): boolean {
  if (/\(\?<?[=!]|\\[1-9]|\\k</.test(regex)) return false
  try {
    new RegExp(regex.replace(/^\(\?i\)/, ''))
    return true
  } catch {
    return false
  }
}

/** AdGuard 的规则不分大小写，内核拿小写的域名去比：写了大写字母（转义里的不算）的正则加上 `(?i)` / AdGuard rules ignore case and the kernel compares lower-cased names, so a regex with a capital letter (outside escapes) gets `(?i)` */
function ignoringCase(regex: string): string {
  let escaped = false
  const capital = [...regex].some((c) => {
    const hit = !escaped && c >= 'A' && c <= 'Z'
    escaped = !escaped && c === '\\'
    return hit
  })
  return capital ? `(?i)${regex}` : regex
}

/** 带通配符或锚点的写法换成整个域名上的正则；中间的 `^`、`|` 什么都匹配不上，算看不懂 / A pattern with wildcards or anchors as a regex over the whole name; a `^` or `|` in the middle could never match and counts as unreadable */
function patternRegex(pattern: string): string | null {
  const [start, rest] = pattern.startsWith('||') ? ['^(?:.*\\.)?', pattern.slice(2)] : pattern.startsWith('|') ? ['^', pattern.slice(1)] : ['', pattern]
  const end = ['^|', '^', '|'].find((e) => rest.endsWith(e))
  const body = end === undefined ? rest : rest.slice(0, -end.length)
  if (!/[a-z0-9]/i.test(body)) return null
  // 锚定的开头是点、或者中间空着一级（`||.example^`、`ads..example`），永远匹配不上 / A dot at an anchored start, or an empty label inside (`||.example^`, `ads..example`), could never match
  if (body.includes('..') || (start && body.startsWith('.'))) return null
  let regex = start
  for (const c of body) {
    if (c === '*') regex += '.*'
    else if (c === '.') regex += '\\.'
    else if (/^[a-z0-9_-]$/.test(c)) regex += c
    else return null
  }
  return regex + (end === undefined ? '' : '$')
}

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/
/** 规整成内核比较用的写法：小写、去掉末尾的点、中文等域名换成 punycode；不像域名时为 null / The form the kernel compares: lower case, no trailing dot, non-ASCII names in punycode; null when it is no name */
function normalizeDomain(raw: string): string | null {
  let name = raw.endsWith('.') ? raw.slice(0, -1) : raw
  if (/[^\x00-\x7f]/.test(name)) {
    if (/[\s/:?#@[\]\\%]/.test(name)) return null
    try { name = new URL(`http://${name}`).hostname } catch { return null }
  } else name = name.toLowerCase()
  return name.length <= 253 && name.split('.').every((label) => LABEL.test(label)) ? name : null
}

// ---------- 自己写的规则 / rules of one's own ----------

export interface OwnRule { line: number; allow: boolean; match: Match }
export interface OwnProblem { line: number; text: string; problem: string }

/** 一行没用上的原因，页面上的说法 / Why a line went unused, in the page's words */
export function skipText(skip: Skip): string {
  switch (skip.reason) {
    case 'cosmetic': return '只对浏览器有用，DNS 用不上'
    case 'hosts-address': return '写的是别的地址：要回答这个地址，用「域名映射」'
    case 'unsupported-modifier': return `还不支持 $${skip.modifier}`
    case 'unknown-modifier': return `认不出 $${skip.modifier}`
    case 'bad-regex': return 'KixDNS 的正则不支持这种写法（前后断言、反向引用等）'
    case 'too-many-patterns': return '这个列表的通配符和正则规则超过 1000 条，多的没用上'
    case 'url-path': return '带网址路径，只对浏览器有用，DNS 用不上'
    case 'unreadable': return '看不懂这一行'
  }
}

/** 读自己写的规则：用得上的一条条给出来，用不上的行说出原因 / Reads the rules of one's own: those in use one by one, and why each other line went unused */
export function parseOwnRules(text: string): { rules: OwnRule[]; problems: OwnProblem[] } {
  const rules: OwnRule[] = []
  const problems: OwnProblem[] = []
  // 超过上限的只指出第一行，后面的一起算进那一条：贴进一个大列表时不刷出几千行一样的原因 / Past the limit only the first line is pointed out and
  // the rest are counted into it, so pasting a big list does not flood thousands of identical reasons
  let over: OwnProblem | null = null
  let overCount = 0
  for (const [index, raw] of text.split('\n').entries()) {
    const line = index + 1
    const parsed = parseLine(raw)
    if (parsed.kind === 'ignored') continue
    const problem = (text: string) => problems.push({ line, text: raw.trim(), problem: text })
    if (parsed.kind === 'skipped') { problem(skipText(parsed.skip)); continue }
    // 照着这一行写出放行的那条；本来就是放行的，不想放行就删掉它 / The allow rule is written out from this line; one that already allows is simply removed
    if (parsed.kind === 'badfilter') { problem(parsed.rule.startsWith('@@') ? '这里用不上 $badfilter：不想放行它，删掉这一行' : `这里用不上 $badfilter：要放行，写成 @@${parsed.rule}`); continue }
    if (over || rules.length + parsed.rules.length > MAX_OWN_RULES) {
      overCount += parsed.rules.length
      if (!over) { over = { line, text: raw.trim(), problem: '' }; problems.push(over) }
      continue
    }
    for (const r of parsed.rules) rules.push({ line, allow: r.allow, match: r.match })
  }
  if (over) over.problem = `从这一行起的 ${overCount.toLocaleString('en-US')}\u00a0条没用上：自己写的规则最多 ${MAX_OWN_RULES.toLocaleString('en-US')}\u00a0条，大列表请用订阅`
  return { rules, problems }
}

/** 一条规则管不管这个域名（已经是小写、去掉末尾点的） / Whether a rule covers this name (already lower-cased, no trailing dot) */
function covers(match: Match, name: string): boolean {
  if (match.kind === 'suffix') return name === match.value || name.endsWith(`.${match.value}`)
  if (match.kind === 'exact') return name === match.value
  try { return new RegExp(match.value.replace(/^\(\?i\)/, ''), 'i').test(name) } catch { return false }
}

/** 自己写的规则里拦下这个域名的那一条（同时有放行管着它时为 null：放行优先） / The rule of one's own that blocks this name (null when an allow also covers it: allows come first) */
export function ownBlockFor(text: string, domain: string): OwnRule | null {
  const name = domain.trim().toLowerCase().replace(/\.$/, '')
  const rules = parseOwnRules(text).rules
  if (rules.some((r) => r.allow && covers(r.match, name))) return null
  return rules.find((r) => !r.allow && covers(r.match, name)) ?? null
}

/** 自己写的一条规则在入口里的条件 / One rule of one's own as an entry condition */
export function ownMatcher(match: Match): KMatcher {
  if (match.kind === 'suffix') return { type: 'domain_suffix', value: match.value }
  if (match.kind === 'exact') return { type: 'domain_regex', value: `^${match.value.replace(/\./g, '\\.')}$` }
  return { type: 'domain_regex', value: match.value }
}

/** 入口里的条件写回成规则的一行（导入时没有上一份可接时用） / An entry condition written back as a rule line (on import, when there is no previous copy to take over) */
export function ownRuleText(matcher: KMatcher, allow: boolean): string | null {
  const value = typeof matcher.value === 'string' ? matcher.value : ''
  if (!value) return null
  const prefix = allow ? '@@' : ''
  if (matcher.type === 'domain_suffix') return `${prefix}||${value}^`
  if (matcher.type !== 'domain_regex') return null
  const exact = /^\^((?:[a-z0-9_-]+\\\.)*[a-z0-9_-]+)\$$/.exec(value)?.[1]
  return `${prefix}${exact ? exact.replace(/\\\./g, '.') : `/${value}/`}`
}

// ---------- 推荐的列表 / suggested lists ----------

/** 推荐的列表：条数和内核多占的内存是 2026-10-17 实测 / Suggested lists: rule counts and the kernel's extra memory measured on 2026-10-17 */
export interface Preset { name: string; url: string; about: string; rules: number; memory: number }
export const PRESETS: Preset[] = [
  { name: 'AdGuard DNS filter', url: 'https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt', about: 'AdGuard 官方维护，广告和跟踪', rules: 185_803, memory: 17 },
  { name: 'HaGeZi Pro', url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt', about: '广告、跟踪、恶意网站，误拦少', rules: 201_519, memory: 12 },
  { name: 'OISD big', url: 'https://big.oisd.nl/', about: '广告、跟踪、恶意网站，收得最全', rules: 234_173, memory: 14 },
  { name: 'anti-AD', url: 'https://anti-ad.net/easylist.txt', about: '中文网站和应用的广告', rules: 96_734, memory: 10 },
  { name: 'StevenBlack hosts', url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts', about: '广告和恶意网站，hosts 格式', rules: 73_633, memory: 9 },
  { name: 'AdAway', url: 'https://adaway.org/hosts.txt', about: '手机应用里的广告，hosts 格式', rules: 6_540, memory: 1 },
]

/**
 * 订阅的名字：推荐的列表用它的名字，别的先用「文件名 · 主机」（链接没有路径时只用主机）；下载下来带着标题时页面再换成标题
 * A subscription's name: a suggested list's own, otherwise 「file name · host」 (the host alone when the link has no path); once the download
 * brings a title the page switches to it
 */
export function subscriptionName(url: string): string {
  const preset = PRESETS.find((p) => p.url === url)
  if (preset) return preset.name
  try {
    const link = new URL(url)
    const last = link.pathname.split('/').filter(Boolean).pop() ?? ''
    let file = last
    try { file = decodeURIComponent(last) } catch { /* 写坏的百分号转义照原样用 / a malformed percent escape is used as written */ }
    // 「·」两边不折行：整个名字要折就一起折到下一行，「·」不挂在行尾 / No break around 「·」: the whole name wraps together, never leaving 「·」 at a line end
    return file ? `${file}${NAME_JOIN}${link.host}` : link.host
  } catch {
    return url
  }
}

const NAME_JOIN = '\u00a0·\u00a0'
/** 默认名「文件名 · 主机」里的文件名，用在已经写着主机的地方；起过名、带标题的照原样 / The file part of a default 「file name · host」 name, for places
 * that already give the host; a name with a title or of one's own stays as it is */
export function shortName(name: string, url: string): string {
  return name === subscriptionName(url) && name.includes(NAME_JOIN) ? name.slice(0, name.indexOf(NAME_JOIN)) : name
}

/** 检查要订阅的链接，和服务端的规矩一样；通过时给出规整的写法（主机名小写，没写路径补上 `/`） / Checks a link to subscribe to by the server's rules; on success gives its normal form (host lower-cased, a missing path filled in as `/`) */
export function checkSubscriptionUrl(raw: string): { url: string } | { problem: string } {
  let link: URL
  try { link = new URL(raw) } catch {
    // 没写协议、补上 https:// 就对的，照实说 / One with no scheme that reads once https:// is added is told so
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return { problem: '链接写得不对' }
    try { new URL(`https://${raw}`); return { problem: '链接要写全，以 https:// 开头' } } catch { return { problem: '链接写得不对' } }
  }
  if (link.protocol !== 'https:') return { problem: '链接只能用 https://' }
  if (link.username || link.password) return { problem: '链接不能包含用户名或密码' }
  if (!link.hostname) return { problem: '链接缺少主机名' }
  if (new TextEncoder().encode(link.href).length > 4096) return { problem: '链接过长' }
  // 页内的 #片段 和空的 ? 不改下载的内容：去掉，同一个列表才认得出来 / A #fragment or an empty ? does not change what downloads: dropped, so the same list is recognised
  link.hash = ''
  return { url: link.href.replace(/\?$/, '') }
}

/** 订阅链接规整以后的写法，用来认出同一个列表；读不懂的照原样 / A subscription link in its normal form, to recognise the same list; one that does not parse stays as it is */
export function normalUrl(raw: string): string {
  const checked = checkSubscriptionUrl(raw)
  return 'url' in checked ? checked.url : raw
}
