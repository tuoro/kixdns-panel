import { MAX_SUBSCRIPTIONS, PRESETS } from '../config-model/blocklist'
import { ApiError } from './client'
import type { BlocklistBuildRequest, BlocklistBuildResult, BlocklistSource, BlocklistState, BlocklistSummary, GeoDataSchedule } from './types'

// 演示用的拦截列表：和服务端一样按链接记每个列表的情况（不在请求里的也留着，服务端要到清理时才删），合成文件按启用的列表取名，
// 不论先后。推荐的列表用实测的条数，别的链接给一个整数，几个常见的自己粘贴的列表带着标题；链接里带 fail 的装作连不上，带 missing 的装作 404。全是演示数据。
// The demo blocklists: like the server, each list's status is kept by link (those outside the request too, which the server drops only at
// cleanup), and the merged file is named after the enabled lists in any order. Suggested lists take their measured counts, any other link a
// round number, and a few commonly pasted lists carry titles; a link containing fail pretends it cannot connect and one containing missing pretends a 404. All demo data.

// 演示别的情况（localStorage 里设成 true）/ Other states for the demo (set to true in localStorage):
// - kixdns:demo-blocklists-unreadable：读不到各个列表的情况 / the list statuses cannot be read
// - kixdns:demo-blocklist-refresh-fails：点名重新下载的都没下载成功，下载过的接着用原来那份 / every named re-download fails, and a list
//   downloaded before keeps its copy
// - kixdns:demo-blocklist-schedule-failed：开着自动更新时，上次有一个列表没更新上 / with automatic updates on, one list failed to update last time
const flag = (name: string): boolean => typeof localStorage !== 'undefined' && localStorage.getItem(name) === 'true'

const sources = new Map<string, BlocklistSource>()
let schedule: GeoDataSchedule = { interval_hours: null, last_attempt_at: null, last_success_at: null, last_error: null, next_run_at: null }

// 摘要用的伪散列：同样的输入总是同样的 64 位十六进制 / A stand-in digest: the same input always gives the same 64 hex digits
function digest(text: string): string {
  let out = ''
  for (let round = 0; out.length < 64; round++) {
    const h = [...`${round}:${text}`].reduce((acc, c) => Math.imul(acc ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261)
    out += h.toString(16).padStart(8, '0')
  }
  return out.slice(0, 64)
}

// anti-AD 真有这几行没用上的（2026-10-17 下载的那份） / anti-AD really holds these unused lines (the copy downloaded 2026-10-17)
function summaryOf(url: string): BlocklistSummary {
  const preset = PRESETS.find((p) => p.url === url)
  if (preset?.name === 'anti-AD') {
    return {
      rules: preset.rules,
      skipped: 4,
      samples: [
        { line: 10, text: '||doubleclick.net^$dnstype=AAAA', reason: 'unsupported-modifier', modifier: 'dnstype' },
        { line: 11, text: '||googleadservices.com^$dnstype=AAAA', reason: 'unsupported-modifier', modifier: 'dnstype' },
        { line: 12, text: '*$denyallow=cn|com.cn', reason: 'unsupported-modifier', modifier: 'denyallow' },
        { line: 13, text: '||ad.qq.com^$dnstype=HTTPS', reason: 'unsupported-modifier', modifier: 'dnstype' },
      ],
    }
  }
  const title = Object.entries(TITLES).find(([path]) => url.endsWith(path))?.[1]
  return { rules: preset?.rules ?? 52_318, skipped: 0, samples: [], ...(title ? { title } : {}) }
}
// 几个常见列表开头写的标题 / The titles a few common lists open with
const TITLES: Record<string, string> = {
  '/hagezi/dns-blocklists/main/adblock/light.txt': "HaGeZi's Light DNS Blocklist",
  '/hagezi/dns-blocklists/main/adblock/tif.txt': "HaGeZi's Threat Intelligence Feeds DNS Blocklist",
  '/badmojr/1Hosts/master/Lite/adblock.txt': '1Hosts (Lite)',
}

export function demoBlocklists(): BlocklistState {
  if (flag('kixdns:demo-blocklists-unreadable')) throw new ApiError('读不到拦截列表的情况，稍后再试', 503, 'blocklist_unavailable')
  if (flag('kixdns:demo-blocklist-schedule-failed') && schedule.interval_hours !== null) {
    const now = Math.floor(Date.now() / 1000)
    return { sources: Object.fromEntries(sources), schedule: { ...schedule, last_attempt_at: now - 3 * 3600, last_error: '1\u00a0个列表没更新上，仍用原来那份' } }
  }
  return { sources: Object.fromEntries(sources), schedule }
}

export async function demoBuildBlocklists(request: BlocklistBuildRequest): Promise<BlocklistBuildResult> {
  const urls = [...new Set(request.subscriptions.map((s) => s.url.trim()))]
  if (urls.length > MAX_SUBSCRIPTIONS) throw new ApiError(`拦截列表最多订阅 ${MAX_SUBSCRIPTIONS} 个`, 400, 'blocklist_invalid')
  const bad = urls.find((url) => !url.startsWith('https://'))
  if (bad !== undefined) throw new ApiError(`拦截列表「${bad}」：链接只能用 https://`, 400, 'blocklist_invalid')
  const refresh = new Set(request.refresh)
  // 和服务端一样：从没试过的才自己下载，试过没成功的等点名 / As on the server: only lists never tried download on their own; failed ones wait to be named
  const fetch = urls.filter((url) => refresh.has(url) || !sources.has(url))
  // 有要下载的就慢一点，好看清「下载中」；kixdns:demo-download-slow 给出毫秒数时按它 / Slower when something downloads, so 下载中 shows;
  // kixdns:demo-download-slow sets the milliseconds when given
  const slow = typeof localStorage !== 'undefined' ? Number(localStorage.getItem('kixdns:demo-download-slow')) || 1600 : 1600
  await new Promise((resolve) => setTimeout(resolve, fetch.length ? slow : 300))
  const now = Math.floor(Date.now() / 1000)
  let failed = 0
  for (const url of fetch) {
    const held = sources.get(url)
    // 链接里带 missing 的装作 404：重下也没用 / A link containing missing pretends a 404: downloading again will not help
    const missing = url.includes('missing')
    if (missing || url.includes('fail') || (refresh.has(url) && flag('kixdns:demo-blocklist-refresh-fails'))) {
      failed += 1
      const cause = missing ? '服务器返回 HTTP 404，链接可能失效了' : `连不上 ${new URL(url).host}`
      sources.set(url, { ...(held ?? { sha256: null, downloaded_at: null, summary: { rules: 0, skipped: 0, samples: [] }, rejected_sha256: null }), last_error: cause, retryable: !missing, last_attempt_at: now })
      continue
    }
    sources.set(url, { sha256: digest(`${url}@${now}`), downloaded_at: now, summary: summaryOf(url), last_error: null, retryable: false, last_attempt_at: now, rejected_sha256: null })
  }
  const used = request.subscriptions.filter((s) => s.enabled).map((s) => s.url.trim()).sort().map((url) => sources.get(url)?.sha256).filter((sha): sha is string => Boolean(sha))
  return {
    path: used.length ? `/var/lib/kixdns-panel/geo/blocklist-${digest(used.join(','))}.json` : null,
    sources: Object.fromEntries(urls.flatMap((url) => { const s = sources.get(url); return s ? [[url, s] as const] : [] })),
    failed,
  }
}

export function setDemoBlocklistSchedule(hours: number | null): GeoDataSchedule {
  if (![null, 24, 168].includes(hours)) throw new ApiError('拦截列表的自动更新只能每天或每周', 400, 'blocklist_invalid')
  if (schedule.interval_hours !== hours) {
    const now = Math.floor(Date.now() / 1000)
    // 和服务端一样：刚开时还没更新过，下一轮（十几分钟内）就更新 / As on the server: just switched on, it has not run yet and updates on the next
    // round, within a quarter of an hour
    schedule = { interval_hours: hours as 24 | 168 | null, last_attempt_at: null, last_success_at: schedule.last_success_at, last_error: null, next_run_at: hours === null ? null : now }
  }
  return schedule
}
