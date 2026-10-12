export function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/**
 * 小到一位小数显示不出来、但确实发生过的占比，写成「低于 0.1%」。
 *
 * 1,204 次除以 1,284 万是 0.0094%，`formatPercent` 会写成 0.0%——那和「一次也没
 * 有」在屏幕上长得一模一样。发生过和没发生过是两件事，不能显示成同一个字符串。
 *
 * A share too small to show at one decimal but which did happen reads as
 * "below 0.1%". 1,204 out of 12.8M is 0.0094%, which formatPercent writes as
 * 0.0% — indistinguishable on screen from never having happened. Having
 * occurred and not having occurred must not render identically.
 */
export function formatSmallPercent(value: number): string {
  if (value > 0 && value * 100 < 0.05) return '低于 0.1%'
  return formatPercent(value)
}

/**
 * 上游成功率：成功次数除以真正得到结果的尝试数。
 * 并发竞争里被取消的尝试（aborted）既不是成功也不是失败，不计入分母；
 * 否则同一条规则下的几个上游会按"谁先应答"瓜分成功率。
 */
/**
 * 成功率只看超时和连接错误。SERVFAIL、REFUSED 也算拿到了响应（坏掉的域名所有上游都会这样回），
 * 在响应码分布里看；并发竞争中被取消的尝试既不算成功也不算失败。
 */
export function upstreamSuccessRate(item: { success: number; errors: number }): number {
  const judged = item.success + item.errors
  return judged > 0 ? item.success / judged : 0
}

export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp * 1000))
}

// 历史版本的时间：今天、昨天写字，今年只写月日，更早的写年月日；都不写秒。
// A version's time: 今天 and 昨天 in words, month and day within the year, the full date before that; never seconds.
export function formatVersionTime(timestamp: number, now: number = Date.now()): string {
  const date = new Date(timestamp * 1000)
  const today = new Date(now)
  const pad = (value: number) => String(value).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const day = 86_400_000
  if (date.getTime() >= startOfToday && date.getTime() < startOfToday + day) return `今天 ${time}`
  if (date.getTime() >= startOfToday - day && date.getTime() < startOfToday) return `昨天 ${time}`
  if (date.getFullYear() === today.getFullYear()) return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${time}`
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
}

// 多久以前：刚刚、N 分钟前、N 小时前、N 天前（Geo 文件下载时间用） / How long ago, for Geo file download times
export function formatAgo(timestamp: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor(now / 1000 - timestamp))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86_400)} 天前`
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))} 秒`
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  // 零的单位不写：「0 小时 21 分钟」读成「21 分钟」 / Zero units are left out: 0 小时 21 分钟 reads 21 分钟
  if (days > 0) return hours ? `${days} 天 ${hours} 小时` : `${days} 天`
  if (!hours) return `${minutes} 分钟`
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`
}

export function shortHash(value: string | null | undefined, length = 10): string {
  return value ? value.slice(0, length) : '未记录'
}

interface KixdnsVersionIdentity {
  source: 'action' | 'release' | null
  source_id: number | null
  run_id: number | null
  release_tag?: string | null
}

export function formatKixdnsVersion(version: KixdnsVersionIdentity | null | undefined): string {
  if (!version) return '未记录'
  if (version.source === 'release') return version.release_tag ?? 'Release'
  if (version.source === 'action') {
    if (version.run_id) return `构建 #${version.run_id}`
    return version.source_id ? `构建产物 #${version.source_id}` : '构建'
  }
  return '未记录'
}

/** 操作者：面板自己做的（定时更新、自动退回）写「自动」，不写英文的 system / The actor: what the panel did on its own (schedules, automatic fallback) reads 自动, not the English system */
export function actorName(actor: string | null | undefined): string {
  return !actor || actor === 'system' ? '自动' : actor
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试'
}

// 快捷键（? n /）要不要让路：焦点在能打字的地方（输入框、多行框、下拉、可编辑区）时让；开关、单选框、文件框不打字，照样响应
// Whether keyboard shortcuts (? n /) step aside: they do while focus is somewhere text goes (a text field, textarea, select, editable region); switches,
// radios and file pickers take no text, so shortcuts still work there
const TYPING = 'textarea, select, [contenteditable="true"], input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="range"], [type="color"], [type="file"])'
export const isTyping = (target: EventTarget | null): boolean => target instanceof HTMLElement && Boolean(target.closest(TYPING))
