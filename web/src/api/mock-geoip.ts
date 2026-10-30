import type { IpRegion } from './types'

// 演示的回答地址和它们的地区。网段挑的是这些站常见的那类；地区照 Loyalsoldier 的 geoip.dat 和 Country.mmdb（2026-10-29 版）查过，写死在这里——
// 演示里没有 GeoIP 数据，地址也不是谁的真实查询。localStorage 的 kixdns:demo-geoip 换一种情况：mmdb 像配了 MMDB，none 像没配 GeoIP；默认像配了 DAT。
// The demo's answer addresses and their regions. The networks are the kind these sites commonly use; the regions were looked up in
// Loyalsoldier's geoip.dat and Country.mmdb (the 2026-10-29 builds) and are fixed here — the demo has no GeoIP data, and the addresses are
// nobody's real queries. kixdns:demo-geoip in localStorage switches the case: mmdb as with an MMDB, none as without GeoIP; DAT otherwise.

interface Pool { v4: string[]; v6: string[] }
const POOLS: Array<[RegExp, Pool]> = [
  [/^dns\.google$/, { v4: ['8.8.8.', '8.8.4.'], v6: ['2001:4860:4860::'] }],
  [/wikipedia/, { v4: ['103.102.166.'], v6: ['2001:df2:e500:ed1a::'] }],
  [/google|youtube|ytimg|gstatic|doubleclick|googlesyndication|app-measurement/, { v4: ['142.250.66.', '172.217.24.', '142.251.42.'], v6: ['2404:6800:4005:80e::'] }],
  // GitHub 没有 IPv6：AAAA 回 NOERROR、没有记录 / GitHub has no IPv6: AAAA gets NOERROR and no records
  [/github/, { v4: ['20.205.243.'], v6: [] }],
  [/jsdelivr|npmjs|discord/, { v4: ['104.16.'], v6: ['2606:4700::6810:'] }],
  [/reddit/, { v4: ['151.101.'], v6: ['2a04:4e42::'] }],
  [/^www\.apple\.com$/, { v4: ['23.59.250.'], v6: ['2600:1406:3a00::'] }],
  [/apple|icloud|mzstatic/, { v4: ['17.253.144.', '17.248.144.'], v6: ['2403:300:a42::'] }],
  [/corp\./, { v4: ['10.20.0.'], v6: ['fd10:20::'] }],
  [/qq\.com|weixin/, { v4: ['183.3.226.', '109.244.23.', '8.210.'], v6: ['240e:e9:6002:1fd::'] }],
]
const DOMESTIC: Pool = { v4: ['110.242.68.', '36.152.44.', '120.232.145.', '111.13.149.', '59.82.122.'], v6: ['2408:8756:3cf7::'] }

/** 网段 → DAT 给的、MMDB 给的 / Network → what the DAT says, what the MMDB says */
const REGIONS: Array<[string, string[], string[]]> = [
  ['142.250.66.', ['US'], ['GOOGLE']], ['172.217.24.', ['US'], ['GOOGLE']], ['142.251.42.', ['US'], ['GOOGLE']], ['2404:6800:', ['HK'], ['GOOGLE']],
  ['8.8.8.', ['US'], ['GOOGLE']], ['8.8.4.', ['US'], ['GOOGLE']], ['2001:4860:', ['US'], ['GOOGLE']],
  ['103.102.166.', ['US'], ['US']], ['2001:df2:e500:', ['US'], ['US']],
  ['20.205.243.', ['SG'], ['SG']],
  ['104.16.', ['US'], ['CLOUDFLARE']], ['104.18.', ['US'], ['CLOUDFLARE']], ['2606:4700:', ['US'], ['CLOUDFLARE']],
  ['151.101.', ['US'], ['FASTLY']], ['2a04:4e42:', ['US'], ['FASTLY']], ['2600:1406:', ['US'], ['US']], ['2403:300:', ['SG'], ['SG']],
  ['23.59.250.', ['US'], ['US']], ['17.253.144.', ['US'], ['US']], ['17.248.144.', ['GB'], ['GB']],
  // 阿里云香港：DAT 同时列在 CN 和 HK 下，MMDB 说 CN / Alibaba Cloud Hong Kong: the DAT lists it under both CN and HK, the MMDB says CN
  ['8.210.', ['CN', 'HK'], ['CN']],
  ['183.3.226.', ['CN'], ['CN']], ['109.244.23.', ['CN'], ['CN']], ['110.242.68.', ['CN'], ['CN']], ['36.152.44.', ['CN'], ['CN']],
  ['120.232.145.', ['CN'], ['CN']], ['111.13.149.', ['CN'], ['CN']], ['59.82.122.', ['CN'], ['CN']], ['117.136.', ['CN'], ['CN']],
  ['240e:', ['CN'], ['CN']], ['2408:', ['CN'], ['CN']],
]

export const demoGeoip = (): 'dat' | 'mmdb' | 'none' => {
  try {
    const value = typeof localStorage === 'undefined' ? null : localStorage.getItem('kixdns:demo-geoip')
    return value === 'mmdb' || value === 'none' ? value : 'dat'
  } catch {
    return 'dat'
  }
}

// 这些站的回答先是一两条 CNAME，地址在后面——内核照原样记下 / These sites answer one or two CNAMEs before the addresses, and the kernel records them as they come
const CNAMES: Record<string, string[]> = {
  'www.youtube.com': ['youtube-ui.l.google.com.'],
  'www.reddit.com': ['reddit.map.fastly.net.'],
  'cdn.jsdelivr.net': ['cdn.jsdelivr.net.cdn.cloudflare.net.'],
  'www.apple.com': ['www.apple.com.edgekey.net.', 'e6858.dscx.akamaiedge.net.'],
  'www.qq.com': ['ins-r23tsuuf.ias.tencent-cloud.net.'],
  'www.taobao.com': ['www.taobao.com.danuoyi.tbcache.com.'],
  'www.jd.com': ['www.jd.com.gslb.qianxun.com.'],
  'www.baidu.com': ['www.a.shifen.com.'],
  'api.bilibili.com': ['a.w.bilicdn1.com.'],
}
export const demoChain = (qname: string): string[] => CNAMES[qname] ?? []

/** 演示认得这个名字（有它那一类的网段） / Whether the demo knows the name (has networks of its kind) */
export const demoKnows = (qname: string): boolean => POOLS.some(([match]) => match.test(qname)) || qname in CNAMES

/** 这个名字在演示里解析到的一个地址；没有这一类地址时为空 / One address the name resolves to in the demo; empty when it has none of this kind */
export function demoAddress(qname: string, qtype: string, rnd: () => number): string {
  const pool = POOLS.find(([match]) => match.test(qname))?.[1] ?? DOMESTIC
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!
  const n = () => Math.floor(rnd() * 254) + 1
  if (qtype === 'AAAA') return pool.v6.length ? `${pick(pool.v6)}${n().toString(16)}` : ''
  const prefix = pick(pool.v4)
  const parts = prefix.split('.').length - 1
  return `${prefix}${Array.from({ length: 4 - parts }, n).join('.')}`
}

// 和内核「回答的是内网地址」一个判断 / As the kernel's 回答的是内网地址 judges it
const isLocal = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|255\.255\.255\.255$)/.test(ip) || /^(f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|::1?$)/i.test(ip)
const isIp = (text: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(text) || (text.includes(':') && /^[0-9a-f:]+$/i.test(text))

export function demoRegion(ip: string): IpRegion | null {
  if (!isIp(ip)) return null
  if (isLocal(ip)) return { local: true }
  const found = REGIONS.find(([prefix]) => ip.startsWith(prefix))
  if (!found) return null
  return { codes: demoGeoip() === 'mmdb' ? found[2] : found[1] }
}

/** 面板的 /api/v1/geoip/regions：内网总认得出；没配 GeoIP 时其余都是 null / The panel's /api/v1/geoip/regions: local addresses are always known; without GeoIP the rest are null */
export function demoRegionsOf(ips: string[]): Array<IpRegion | null> {
  return ips.map((ip) => {
    const region = demoRegion(ip.trim())
    return region && 'codes' in region && demoGeoip() === 'none' ? null : region
  })
}
