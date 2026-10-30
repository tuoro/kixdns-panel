import { CONFIG_WRITTEN_EVENT, apiRequest } from './api/client'
import type { IpRegion, IpRegionsResponse } from './api/types'
import { isIp } from './config-model/model'

// 地址的地区：查询详情和诊断给回答的地址、客户端标上 US、CN 这样的代码。面板按配好的 GeoIP 数据现查（一次几十毫秒），
// 这里记住查过的，同一页里再打开不再问；配置一保存就清掉，GeoIP 文件可能换了。
// An address's region: the query detail and the diagnostics mark the answer's addresses and the client with codes such as US
// or CN. The panel looks them up in the configured GeoIP data when asked (tens of milliseconds a time); this remembers what was
// looked up, so reopening on the same page asks nothing, and forgets it once the config is saved, as the GeoIP files may change.

/** 某个地址的地区；还没查到、查不到的是 undefined 或 null / An address's region; undefined or null while unknown or unplaced */
export type RegionOf = (ip: string) => IpRegion | null | undefined

/**
 * 地址的地区怎么写：内网写「内网」，其余照 GeoIP 数据给的代码写（规则里填的也是它）；DAT 里列在几个国家下的用「/」连起来，都写出来，因为这几个国家的规则都会命中它
 * How an address's region reads: 内网 for a local one, otherwise the codes as the GeoIP data gives them (what a rule is written with); a DAT
 * address listed under several countries joins them with 「/」 and shows all, since a rule for any of them matches it
 */
export function regionText(region: IpRegion | null | undefined): string {
  if (!region) return ''
  return 'local' in region ? '内网' : region.codes.join('/')
}

/** 客户端的地区只在公网地址上写：内网客户端是常态，不用说 / A client's region is written for a public address only: a local client is the norm */
export const clientRegionText = (region: IpRegion | null | undefined): string => (region && 'codes' in region ? regionText(region) : '')

/** 面板一次最多查这么多个 / The most addresses the panel looks up at once */
const MAX_ASK = 32
/** 记住的地址到这么多就从头记 / Remembered addresses are dropped once there are this many */
const MAX_KNOWN = 2000
const known = new Map<string, IpRegion | null>()
if (typeof window !== 'undefined') window.addEventListener(CONFIG_WRITTEN_EVENT, () => known.clear())

/** 已经知道的那些，马上就有 / The ones already known, at once */
export function knownRegions(ips: readonly string[]): Map<string, IpRegion | null> {
  return new Map(ips.filter((ip) => known.has(ip)).map((ip) => [ip, known.get(ip)!]))
}

/** 还不知道的去问面板，连同已经知道的一起给回来；问不到就当没有，标签只是说明，不报错 / Asks the panel for the ones not known yet and gives them back with the known ones; a failed ask counts as none, since the labels are only an explanation */
export async function lookupRegions(ips: readonly string[]): Promise<Map<string, IpRegion | null>> {
  const missing = [...new Set(ips)].filter((ip) => isIp(ip) && !known.has(ip)).slice(0, MAX_ASK)
  if (missing.length) {
    try {
      const { regions } = await apiRequest<IpRegionsResponse>(`/api/v1/geoip/regions?ips=${encodeURIComponent(missing.join(','))}`)
      if (known.size + missing.length > MAX_KNOWN) known.clear()
      missing.forEach((ip, at) => known.set(ip, regions[at] ?? null))
    } catch {
      // 下次打开再问 / Asked again on the next opening
    }
  }
  return knownRegions(ips)
}

/** 只给测试用：忘掉记住的 / For tests only: forget what was remembered */
export const forgetRegions = (): void => known.clear()
