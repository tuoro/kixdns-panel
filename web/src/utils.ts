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
