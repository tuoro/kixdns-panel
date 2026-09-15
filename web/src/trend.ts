export interface Sparkline {
  /** 折线路径 */
  line: string
  /** 折线下方的填充区域，用于给曲线一点重量 */
  area: string
  /** 末端点，强调「现在在哪」 */
  lastX: number
  lastY: number
}

/**
 * 把一串数值折算成定宽定高的折线。
 *
 * 三处不照顾就会画出错的图：只有一个点时没有横向跨度，除以 0 会得到 NaN 路径；
 * 所有值相等时纵向跨度为 0，同样除以 0；点数为零时不该画一条假的平线，而该
 * 什么都不画，由调用方决定显示什么。
 *
 * Folds a series into a fixed-size polyline. Three cases would otherwise draw
 * something wrong: a single point has no horizontal span and dividing by zero
 * yields a NaN path; a flat series has no vertical span and divides by zero the
 * same way; and an empty series must draw nothing at all rather than a
 * fabricated flat line, leaving the caller to decide what to show.
 */
export function sparkline(values: number[], width: number, height: number): Sparkline | null {
  if (values.length === 0) return null

  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min
  // 全平的序列画在中线上：贴着顶边或底边都会读成「一直最高」或「一直最低」。
  // A flat series sits on the mid-line: pinning it to an edge would read as
  // permanently at maximum or minimum.
  const y = (value: number) => span === 0 ? height / 2 : height - ((value - min) / span) * height

  // 单点没有横向跨度，放在正中；这是本文件里唯一一处需要区分点数的地方。
  // A single point has no horizontal span and sits in the middle; this is the
  // only place in this file that needs to care how many points there are.
  const points = values.map((value, index) => [
    values.length > 1 ? (width / (values.length - 1)) * index : width / 2,
    y(value),
  ] as const)
  const line = points.map(([x, py], index) => `${index === 0 ? 'M' : 'L'}${round(x)},${round(py)}`).join(' ')
  const [lastX, lastY] = points[points.length - 1]!
  const [firstX] = points[0]!
  const area = `${line} L${round(lastX)},${height} L${round(firstX)},${height} Z`
  return { line, area, lastX: round(lastX), lastY: round(lastY) }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
