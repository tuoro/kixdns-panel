import { PRESETS } from '../config-model/blocklist'
import { ApiError } from './client'
import type { BlocklistBuildRequest, BlocklistBuildResult, BlocklistSource, BlocklistState, BlocklistSummary, GeoDataSchedule } from './types'

// 演示用的拦截列表：和服务端一样按链接记每个列表的情况，合成文件按启用的列表取名。推荐的列表用实测的条数，别的链接给一个整数；
// 链接里带 fail 的装作下载失败。全是演示数据。
// The demo blocklists: like the server, each list's status is kept by link and the merged file is named after the enabled lists.
// Suggested lists take their measured counts and any other link a round number; a link containing fail pretends its download
// failed. All demo data.

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
  return { rules: preset?.rules ?? 52_318, skipped: 0, samples: [] }
}

export function demoBlocklists(): BlocklistState {
  if (flag('kixdns:demo-blocklists-unreadable')) throw new ApiError('读不到拦截列表的情况，稍后再试', 503, 'blocklist_unavailable')
  if (flag('kixdns:demo-blocklist-schedule-failed') && schedule.interval_hours !== null) {
    const now = Math.floor(Date.now() / 1000)
    return { sources: Object.fromEntries(sources), schedule: { ...schedule, last_attempt_at: now - 3 * 3600, last_error: '1\u00a0个列表没更新上，接着用上一份' } }
  }
  return { sources: Object.fromEntries(sources), schedule }
}

export async function demoBuildBlocklists(request: BlocklistBuildRequest): Promise<BlocklistBuildResult> {
  const urls = [...new Set(request.subscriptions.map((s) => s.url.trim()))]
  const bad = urls.find((url) => !url.startsWith('https://'))
  if (bad !== undefined) throw new ApiError('拦截列表链接只能用 https://', 400, 'blocklist_invalid')
  for (const url of [...sources.keys()]) if (!urls.includes(url)) sources.delete(url)
  const refresh = new Set(request.refresh)
  // 和服务端一样：从没试过的才自己下载，试过没成功的等点名 / As on the server: only lists never tried download on their own; failed ones wait to be named
  const fetch = urls.filter((url) => refresh.has(url) || !sources.has(url))
  // 有要下载的就慢一点，好看清「下载中」 / Slower when something downloads, so 下载中 shows
  await new Promise((resolve) => setTimeout(resolve, fetch.length ? 1600 : 300))
  const now = Math.floor(Date.now() / 1000)
  let failed = 0
  for (const url of fetch) {
    const held = sources.get(url)
    if (url.includes('fail') || (refresh.has(url) && flag('kixdns:demo-blocklist-refresh-fails'))) {
      failed += 1
      sources.set(url, { ...(held ?? { sha256: null, downloaded_at: null, summary: { rules: 0, skipped: 0, samples: [] }, rejected_sha256: null }), last_error: `连不上 ${new URL(url).host}，拦截列表没下载成功，稍后再试`, last_attempt_at: now })
      continue
    }
    sources.set(url, { sha256: digest(`${url}@${now}`), downloaded_at: now, summary: summaryOf(url), last_error: null, last_attempt_at: now, rejected_sha256: null })
  }
  const used = request.subscriptions.filter((s) => s.enabled).map((s) => sources.get(s.url.trim())?.sha256).filter((sha): sha is string => Boolean(sha))
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
    schedule = { interval_hours: hours as 24 | 168 | null, last_attempt_at: null, last_success_at: schedule.last_success_at, last_error: null, next_run_at: hours === null ? null : now + hours * 3600 }
  }
  return schedule
}
