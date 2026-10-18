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
  // 下次自动更新这类将来的时间 / Times ahead, such as the next automatic update
  if (date.getTime() >= startOfToday + day && date.getTime() < startOfToday + 2 * day) return `明天 ${time}`
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
  source: 'action' | 'release' | 'fork' | null
  source_id: number | null
  run_id?: number | null
  release_tag?: string | null
}

/** fork 发布写日期版本，更早的 Release 写标签，旧的 Action 内核写「构建 #上游 Run」，和服务端的 label() 一致。 / A fork release reads as its date version, an earlier Release as its tag, an old Action kernel as 构建 # and the upstream run, as the server's label() does. */
export function formatKixdnsVersion(version: KixdnsVersionIdentity | null | undefined): string {
  if (!version) return '未记录'
  if (version.source === 'fork') return version.release_tag ?? '未记录'
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
  return error instanceof Error ? error.message : '没有成功，过一会儿再试'
}

// 快捷键（? n /）要不要让路：焦点在能打字的地方（输入框、多行框、下拉、可编辑区）时让；开关、单选框、文件框不打字，照样响应
// Whether keyboard shortcuts (? n /) step aside: they do while focus is somewhere text goes (a text field, textarea, select, editable region); switches,
// radios and file pickers take no text, so shortcuts still work there
const TYPING = 'textarea, select, [contenteditable="true"], input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="range"], [type="color"], [type="file"])'
export const isTyping = (target: EventTarget | null): boolean => target instanceof HTMLElement && Boolean(target.closest(TYPING))

// 句子最后几个字绑在一起不折行：中文折行时末行不会只剩一两个字 / Binds a sentence's last few characters so a Chinese wrap never leaves one or two alone on the last line
export function keepTail(text: string, size = 5): [string, string] {
  if (text.length <= size * 2) return [text, '']
  return [text.slice(0, -size), text.slice(-size)]
}

// 帮助段落按「整块」排：段尾几个字连在一起（同 keepTail），10 个字以内的「…」也连在一起，不把「公司内网」「转到规则组」拆到两行；
// 引号跨在段尾的切口上时，切口挪到引号前面。这是面板自己给名字、引号加的连接规则，不是分词
// A help paragraph is laid out in glued runs: its last few characters stay together (as keepTail does), and so does every 「…」 of up to 10 characters, so
// 「公司内网」 or 「转到规则组」 never splits across lines; a quote straddling the tail cut moves the cut to the quote's start. This is the panel's own glue
// rule for names and quotes, not segmentation
export function helpRuns(text: string, size = 5): Array<{ text: string; glue: boolean }> {
  const quotes = [...text.matchAll(/「[^「」]{1,10}」/g)].map((m) => [m.index, m.index + m[0].length] as const)
  let cut = text.length > size * 2 ? text.length - size : text.length
  for (const [start, end] of quotes) if (start < cut && end > cut) cut = start
  const runs: Array<{ text: string; glue: boolean }> = []
  let at = 0
  for (const [start, end] of quotes) {
    if (end > cut) break
    if (start > at) runs.push({ text: text.slice(at, start), glue: false })
    runs.push({ text: text.slice(start, end), glue: true })
    at = end
  }
  if (cut > at) runs.push({ text: text.slice(at, cut), glue: false })
  if (cut < text.length) runs.push({ text: text.slice(cut), glue: true })
  return runs
}
