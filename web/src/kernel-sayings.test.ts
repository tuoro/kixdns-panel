import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { KernelArg, KernelSaying } from './api/types'
import { SAYINGS, kernelSaid, sayKernel } from './kernel-sayings'

// 内核每种话的一条：参数和面板说出来的中文 / One of each kind of thing the kernel says: the arguments and the Chinese the panel makes of it
const said = (code: string, args: Record<string, KernelArg> = {}, text = `${code} in English`): KernelSaying => ({ code, args, text })
const PORT_ZERO = said('port_zero', {}, 'port 0')
const CASES: Record<string, [Record<string, KernelArg>, string]> = {
  no_upstream: [{}, '一个上游地址都没写，问它的请求都会失败；至少填一个地址'],
  upstream_unknown_prefix: [{ upstream: 'foo://1.1.1.1', prefix: 'foo' }, '上游 foo://1.1.1.1 的前缀「foo://」认不出：DoH 写 https://，DoT 写 tls://，DoQ 写 quic://，TCP 写 tcp://'],
  upstream_unusable: [{ upstream: '1.1.1.1:0', reason: PORT_ZERO }, '上游 1.1.1.1:0 用不了：端口要在 1 到 65535 之间'],
  default_upstream_over: [{ transport: 'dot', problem: said('upstream_unusable', { upstream: '1.1.1.1:53', reason: said('tls_path_given', { transport: 'dot' }) }) }, '没写上游，问的是默认上游；经 DoT 问时，上游 1.1.1.1:53 用不了：DoT 的地址不能带路径'],
  bootstrap_server_unusable: [{ server: 'dns.google:53', reason: said('address_not_ip_port', { error: 'invalid socket address syntax' }) }, '引导 DNS dns.google:53 用不了：要写成「IP:端口」，比如 223.5.5.5:53（原因：invalid socket address syntax）'],

  address_not_ip_port: [{ error: 'invalid socket address syntax' }, '要写成「IP:端口」，比如 223.5.5.5:53（原因：invalid socket address syntax）'],
  port_zero: [{}, '端口要在 1 到 65535 之间'],
  address_not_host_port: [{}, 'TCP 写成 主机:端口，比如 dns.example:53'],
  port_invalid: [{ error: 'invalid digit found in string' }, '端口要在 1 到 65535 之间（原因：invalid digit found in string）'],
  host_invalid: [{ host: 'dns_x!' }, '主机名只能有字母、数字、点和横线，写的是「dns_x!」'],
  doh_second_prefix: [{ prefix: 'http' }, '前缀后面又写了一个前缀，只留一个（DoH 一律走 https），写的是「http://」'],
  doh_url_invalid: [{ error: 'empty host' }, '不是 KixDNS 读得懂的 DoH 地址（原因：empty host）'],
  tls_server_name_invalid: [{ error: 'invalid dns name' }, '服务器名写得不对（原因：invalid dns name）'],
  second_prefix: [{ prefix: 'tcp' }, '前缀后面又写了一个前缀，只留一个，写的是「tcp://」'],
  tls_url_invalid: [{ transport: 'doq', error: 'invalid port number' }, '不是 KixDNS 读得懂的 DoQ 地址（原因：invalid port number）'],
  tls_host_missing: [{ transport: 'dot' }, 'DoT 的地址没写主机'],
  tls_path_given: [{ transport: 'doq' }, 'DoQ 的地址不能带路径'],
  zero_rtt_invalid: [{ key: 'enable_0rtt', value: 'maybe' }, '0rtt 只能写 true、false、1、0、yes、no、on 或 off，写的是 enable_0rtt=maybe'],
  tls_parameter_unknown: [{ transport: 'dot', key: '0rtt' }, 'DoT 只认 sni、servername 这两个参数，不认「0rtt」'],
  doq_ip_needs_sni: [{}, 'DoQ 用 IP 时要写 ?sni=服务器名，比如 quic://223.5.5.5?sni=dns.alidns.com'],

  doh_path_without_slash: [{ path: 'dns-query' }, '要以 / 开头：不以它开头的路径谁也对不上，DoH 每个请求都回 404，写的是「dns-query」'],
  setting_over_limit: [{ value: 100, most: 64 }, '最多 64，写的是「100」；KixDNS 启动时按 64 用，保存时不收'],
  listen_address_invalid: [{ value: '0.0.0.0', error: 'invalid socket address syntax' }, '要写成「IP:端口」，比如 0.0.0.0:53 或 [::]:53，写的是「0.0.0.0」（原因：invalid socket address syntax）'],
  doh_setting_missing: [{ bind_doh: '0.0.0.0:443' }, '写了 DoH 监听地址（0.0.0.0:443）就要写这一项'],
  cache_capacity_zero: [{}, '填大于 0 的整数：0 让缓存一条回答也存不下'],
  cache_max_ttl_zero: [{}, '填大于 0 的整数：0 把缓存的每条回答的 TTL 都压成 0，缓存等于没用'],
  refresh_threshold_too_high: [{ value: 100 }, '填 0 到 99 之间的整数：100 让每次命中缓存都去上游刷新'],
  upstream_timeout_zero: [{}, '填大于 0 的整数：0 让每个上游请求一发出就超时'],
  dashmap_shards_invalid: [{ value: 3, most: 65536 }, '填 0（自动），或者 2 到 65536 之间 2 的幂（2、4、8……），写的是「3」'],
  doq_idle_timeout_too_long: [{ value: 9_000_000_000_000_000 }, '9000000000000000 秒超过了 QUIC 装得下的上限'],
  request_timeout_below_upstream: [{ value: 1000, upstream: 9000 }, '不能小于上游超时（9000 毫秒），写的是「1000 毫秒」'],

  select_pipeline_missing: [{ pipeline: 'gone' }, '要进的组「gone」不存在'],
  negation_on_first: [{ operator: 'and_not', matchers: 'matchers' }, '第一个条件前面没有东西可合，写的「且不是」不起作用，KixDNS 不收；要排除它，前面先加一个「所有请求」条件'],
  pipeline_id_repeated: [{ times: 3, id: 'main' }, '3 个列表都叫「main」：只有第一个起作用，其余的规则从不执行；在 JSON 里改掉重名的再保存'],
  key_not_read: [{}, 'KixDNS 不读这个键，写了也不起作用：看看是不是拼错了，或者写错了地方'],
  forward_ecs_differ: [{}, '这条规则的几个转发合成一次转发、只发一个 ECS，可它们的 ECS 设置不一样，结果哪个都不发；每个写一样的 ECS，或者拆成几条规则'],
  ecs_ip_not_ip: [{ ip: '1.2.3' }, '固定子网的 IP「1.2.3」不是 IP 地址：不设子网，客户端自己带的 ECS（有的话）照样发给上游；固定子网写成 203.0.113.0/24 这样'],
  rcode_unknown: [{ rcode: 'NXDOMIAN' }, '固定响应码「NXDOMIAN」不对：KixDNS 只认 NOERROR、SERVFAIL、NXDOMAIN、REFUSED、FORMERR、NOTIMP'],
  static_ip_invalid: [{ ip: '1.2.3.4;5.6.7.8' }, '固定 IP「1.2.3.4;5.6.7.8」写得不对，几个 IP 用逗号隔开'],
  cname_target_invalid: [{ target: 'a..b' }, 'CNAME 目标域名「a..b」写得不对'],
  txt_no_string: [{}, 'TXT 至少要有一段，空的也行'],
  txt_segment_too_long: [{ bytes: 300, most: 255 }, '每段 TXT 最长 255 字节，有一段 300 字节'],
  txt_too_long: [{ bytes: 70000, most: 65000 }, 'TXT 内容在记录里占 70000 字节（每段另算一个长度字节），一份回答最多放得下 65000 字节'],
  log_level_unknown: [{ level: 'WARN' }, '日志级别「WARN」不对：KixDNS 只认 trace、debug、info、warn、error'],
  jump_target_missing: [{ pipeline: 'gone' }, '要转到的组「gone」不存在'],

  matches_every_name: [{ matcher: 'domain_suffix', value: '.' }, '「域名属于」写的是「.」，对每个域名都成立'],
  matches_only_root: [{ matcher: 'request_domain_exact' }, '「请求的域名就是」空着只命中根域名；要指根域名就写「.」'],
  txt_empty_matches_every_answer: [{ mode: 'prefix' }, '「TXT 内容」「开头是」空着，对每份带 TXT 记录的回答都成立'],
  response_rcode_unknown: [{ rcode: 'NODATA' }, '响应码「NODATA」不对：KixDNS 只认 NOERROR、SERVFAIL、NXDOMAIN、REFUSED、FORMERR、NOTIMP，其余的响应码写 OTHER'],
  never_matches: [{ matcher: 'geo_site', value: '' }, '「属于 GeoSite」写的是「」，永远不命中'],
  no_country_code: [{ matcher: 'response_answer_ip_geoip_country' }, '「回答 IP 的地区」一个国家代码也没写，永远不命中'],
  regex_capitals: [{ matcher: 'domain_regex', pattern: '^Ads\\.Example', capitals: ['A', 'E'] }, '「域名匹配正则」的正则「^Ads\\.Example」里，「A」、「E」永远命不中：规则看到的域名都是小写；改成小写，或者放在 (?i) 后面'],

  listener_label_outside_select: [{}, '「监听标签」只能用在入口上，规则里用不了'],
  network_invalid: [{ value: '10.0.0.0/33', error: 'invalid IP address syntax' }, '「10.0.0.0/33」不是网段，网段写成 192.168.1.0/24 这样（原因：invalid IP address syntax）'],
  mac_invalid: [{ value: 'aa:bb:cc:dd:ee' }, '「aa:bb:cc:dd:ee」不是 MAC 地址，MAC 写成 aa:bb:cc:dd:ee:ff 这样'],
  regex_too_long: [{ bytes: 20000, most: 16384 }, '正则最长 16384 字节，这个有 20000 字节'],
  regex_invalid: [{ error: 'look-around is not supported' }, '正则写得不对，或者编译出来太大（原因：look-around is not supported）'],
  txt_regex_invalid: [{ error: 'unclosed group' }, '「TXT 内容」的正则写得不对，或者编译出来太大（原因：unclosed group）'],
  qclass_unknown: [{ qclass: 'XX' }, '查询类别「XX」不对：KixDNS 只认 IN、CH、HS'],
  qtype_unknown: [{ qtype: 'AAA' }, '记录类型「AAA」不对：KixDNS 只认 A、AAAA、CNAME、MX、TXT、NS、PTR、SRV、SOA、OPT'],
  txt_mode_unknown: [{ mode: 'suffix' }, '「TXT 内容」的比较方式「suffix」不对：只认 exact（等于）、prefix（开头是）、regex（匹配正则）'],

  background_refresh_rule_unused: [{}, '不起作用：后台刷新照原来的请求重走它自己的规则；这一项可以删掉'],
  setting_retired: [{}, '不再起作用的旧设置：KixDNS 照常加载，只是不起作用；清掉再保存就不提醒了'],
  cache_capacity_large: [{ value: 2_000_000 }, '2000000 条很大，可能占掉很多内存'],
  request_timeout_short: [{ value: 3000, upstream: 9000 }, '3000 毫秒不到上游超时（9000 毫秒）的两倍半，可能来不及重发和改用 TCP'],
  jump_cycle: [{ target: 'group-g1', back_to: 'main' }, '转到「group-g1」以后会绕回「main」：一直绕圈的请求跳满「跳转次数上限」就回 SERVFAIL，回答阶段每跳一次还要再问一次上游'],
  geosite_tags_without_data: [{ tags: ['netflix', 'disney'] }, '没写，GeoSite 分类 netflix、disney 没有数据可比：「属于 GeoSite」永远不命中，「不属于 GeoSite」总是命中'],
  geoip_tags_without_data: [{ tags: ['cn'] }, '没写，GeoIP MMDB 文件也没写，GeoIP 标签 cn 没有数据可比：「客户端地区」永远不命中'],
  geoip_tags_beyond_mmdb: [{ tags: ['telegram'] }, '没写，GeoIP MMDB 文件只有两个字母的国家代码，GeoIP 标签 telegram 没有数据可比：「客户端地区」永远不命中'],
  host_names_without_bootstrap: [{ host: 'dns.google' }, '上游 dns.google 写成了域名，没写引导 DNS 时交给系统解析；KixDNS 接管了本机的 53 端口时会绕回它自己，连不上'],

  data_file_missing: [{ file: 'geosite', path: '/geo/geosite.dat' }, 'GeoSite 文件 /geo/geosite.dat 不存在'],
  data_file_unreadable: [{ file: 'mmdb', path: '/geo/country.mmdb', error: 'Permission denied (os error 13)' }, 'GeoIP MMDB 文件 /geo/country.mmdb 读不了（原因：Permission denied (os error 13)）'],
  data_file_tags_gone: [{ file: 'geoip', path: '/geo/geoip.dat', tags: ['cn', 'private'] }, 'GeoIP DAT 文件 /geo/geoip.dat 里已经没有规则用到的标签了；之前从它读到的 cn、private 的数据接着用，等它再变'],
  data_watch_failed: [{ file: 'geosite', error: 'OS file watch limit reached.' }, 'GeoSite 文件监视不了：改了要等 KixDNS 重启，或者重载改了要读的文件、规则用到的标签，才读进来（原因：OS file watch limit reached.）'],
  data_file_partly_watched: [{ file: 'geoip', path: '/geo/geoip.dat', error: 'No such file or directory (os error 2)' }, 'GeoIP DAT 文件 /geo/geoip.dat 有些地方监视不了，改在那里的要等 KixDNS 每\u00a010\u00a0秒一次的核对才读进来（原因：No such file or directory (os error 2)）'],
  geosite_tags_unprovided: [{ tags: ['netflix'] }, 'GeoSite 分类 netflix 哪个文件里都没有：「属于 GeoSite」永远不命中，「不属于 GeoSite」总是命中'],
  geoip_tags_unprovided: [{ tags: ['telegram'] }, 'GeoIP 标签 telegram 哪份 GeoIP 数据里都没有：「客户端地区」永远不命中'],
}

// 换掉一个参数：说法里要看得出来（参数都用上了）。说「是不是回答条件」的那个换成另一种；套着的原因换成另一种原因
// One argument changed: the words have to show it (every argument is used). The one telling answer conditions apart becomes the other kind;
// a reason within becomes another reason
function changed(value: KernelArg): KernelArg {
  if (typeof value === 'number') return value + 1
  if (Array.isArray(value)) return [...value, 'more']
  if (typeof value === 'object') return said('doq_ip_needs_sni')
  return value === 'matchers' ? 'response_matchers' : `${value}~`
}

describe('内核每种话的中文', () => {
  it('每个代号都有一条用例，参数名和表里的一样', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(SAYINGS).sort())
    for (const [code, [args]] of Object.entries(CASES)) expect(Object.keys(args).sort(), code).toEqual(Object.keys(SAYINGS[code]!.args).sort())
  })

  for (const [code, [args, words]] of Object.entries(CASES)) {
    it(code, () => {
      expect(sayKernel(said(code, args))).toBe(words)
      for (const name of Object.keys(args)) {
        expect(sayKernel(said(code, { ...args, [name]: changed(args[name]!) })), `${code} uses ${name}`).not.toBe(words)
      }
    })
  }
})

describe('认不出、对不上的', () => {
  it('认不出的代号、参数缺了或者样子不对时不说，由调用的照原话说', () => {
    expect(sayKernel(said('a_future_code', { value: 1 }))).toBeNull()
    expect(sayKernel(said('constructor'))).toBeNull()
    expect(sayKernel(said('cache_capacity_large', {}))).toBeNull()
    expect(sayKernel(said('cache_capacity_large', { value: '2000000' }))).toBeNull()
    expect(sayKernel(said('geosite_tags_unprovided', { tags: 'netflix' }))).toBeNull()
    expect(sayKernel(said('upstream_unusable', { upstream: 'x', reason: 'port 0' }))).toBeNull()
  })

  // 套着的原因一样按代号说，认不出时照它的原话，标明是原话 / A reason within is said by its code just the same, by its words when unknown,
  // marked as such
  it('套着的原因递归地说，认不出的照它的原话', () => {
    const deep = said('default_upstream_over', { transport: 'tcp+udp', problem: said('upstream_unusable', { upstream: 'dns.google', reason: said('address_not_ip_port', { error: 'invalid socket address syntax' }) }) })
    expect(sayKernel(deep)).toBe('没写上游，问的是默认上游；经 TCP+UDP 问时，上游 dns.google 用不了：要写成「IP:端口」，比如 223.5.5.5:53（原因：invalid socket address syntax）')
    const unknown = said('upstream_unusable', { upstream: '1.1.1.1:53', reason: said('a_future_reason', {}, 'something new') })
    expect(sayKernel(unknown)).toBe('上游 1.1.1.1:53 用不了：KixDNS\u00a0的原话：something new')
  })

  it('Pipeline id 照页面上的叫法说，叫不出时照写 id', () => {
    const names = (id: string) => ({ main: '主列表', 'group-g1': '规则组「内网」' })[id] ?? null
    expect(sayKernel(said('jump_cycle', { target: 'group-g1', back_to: 'main' }), names)).toMatch(/^转到规则组「内网」以后会绕回主列表：/)
    expect(sayKernel(said('jump_cycle', { target: 'group-x', back_to: 'main' }), names)).toMatch(/^转到「group-x」以后会绕回主列表：/)
  })

  it('原话标明是 KixDNS 的原话，引号里的 Pipeline id 补上叫法', () => {
    expect(kernelSaid('jumping to "lan" comes back round')).toBe('KixDNS\u00a0的原话：jumping to "lan" comes back round')
    expect(kernelSaid('jumping to "lan" comes back round', (id) => (id === 'lan' ? '规则组「内网」' : null))).toBe('KixDNS\u00a0的原话：jumping to "lan"（规则组「内网」） comes back round')
  })
})

// CI 里设了 KERNEL_MESSAGE_CODES：那是最新的内核（main）的代号清单（tools/kernel-config-check --message-codes 写出的 kixdns::notice::CODES，
// [[代号, [参数名…]]…]）。面板的表要正好是这些代号，参数名一样，多了少了都不行
// With KERNEL_MESSAGE_CODES set (in CI): the code list of the latest kernel (main) (kixdns::notice::CODES as written by
// tools/kernel-config-check --message-codes, [[code, [argument names…]]…]). The panel's table must hold exactly these codes with the same
// argument names, none more and none fewer
const kernelCodes = process.env.KERNEL_MESSAGE_CODES
describe.runIf(kernelCodes)('和最新的内核对一遍', () => {
  it('面板的表正好覆盖内核的每个代号，参数名对得上', () => {
    const kernel = JSON.parse(readFileSync(kernelCodes!, 'utf8')) as [string, string[]][]
    const byCode = (list: [string, readonly string[]][]) => Object.fromEntries(list.map(([code, args]) => [code, [...args].sort()]))
    expect(kernel.length).toBeGreaterThan(0)
    expect(byCode(Object.entries(SAYINGS).map(([code, saying]) => [code, Object.keys(saying.args)]))).toEqual(byCode(kernel))
  })
})
