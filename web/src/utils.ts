export function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

/**
 * 紧凑数字：万、亿。窄屏用。
 *
 * 九位数在 375 宽下即使不断行，也会把旁边的单位挤掉，所以窄屏必须缩写，
 * 光靠 white-space: nowrap 不够。保留一位小数，让 12,847,392 读作
 * 1,284.7 万而不是失真的 1,285 万。
 *
 * Compact notation in the Chinese myriad scale, for narrow screens. Nine
 * digits squeeze out the adjacent unit at 375px even when they do not wrap,
 * so nowrap alone is not enough. One decimal keeps 12,847,392 readable as
 * 1,284.7 万 rather than a lossy 1,285 万.
 */
export function formatCompactNumber(value: number): string {
  const abs = Math.abs(value)
  if (abs < 10_000) return formatNumber(value)
  const [divisor, unit] = abs < 100_000_000 ? [10_000, '万'] : [100_000_000, '亿']
  const scaled = value / divisor
  // 小数位随量级递减：1,284.7 万有信息量，9,999.0 万的那位小数已经没有。
  // 阈值取 5000：再往上一位小数相对整数部分不足万分之一，读者不会用到。
  // Fewer decimals as the magnitude grows: the tenth in 1,284.7 万 carries
  // information while the one in 9,999.0 万 does not. Past 5000 the decimal
  // is under one part in ten thousand of the integer part, so it is dropped.
  const digits = Math.abs(scaled) < 5000 ? 1 : 0
  return `${new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(scaled)} ${unit}`
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
export function upstreamSuccessRate(item: { attempts: number; success: number; aborted?: number }): number {
  const settled = item.attempts - (item.aborted ?? 0)
  return settled > 0 ? Math.min(item.success / settled, 1) : 0
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

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))} 秒`
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时 ${minutes} 分钟`
}

export function shortHash(value: string | null | undefined, length = 10): string {
  return value ? value.slice(0, length) : '未记录'
}

interface KixdnsVersionIdentity {
  source: 'action' | 'release' | null
  source_id: number | null
  run_id: number | null
  release_tag: string | null
}

export function formatKixdnsVersion(version: KixdnsVersionIdentity | null | undefined): string {
  if (!version) return '未记录'
  if (version.source === 'release') return version.release_tag ?? 'Release'
  if (version.source === 'action') {
    if (version.run_id) return `Run #${version.run_id}`
    return version.source_id ? `Artifact #${version.source_id}` : 'Action'
  }
  return '未记录'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试'
}
