import type { RequestTrend } from './api/types'

/** 面板每分钟采样一次（服务端的 METRIC_SAMPLE_INTERVAL_SECONDS） / The panel samples once a minute (the server's METRIC_SAMPLE_INTERVAL_SECONDS) */
const SAMPLE_INTERVAL_SECONDS = 60

/**
 * 曲线画到哪一刻：最后一次采样。桶是从读取那一刻往回切的，最后一个桶的末尾总是「现在」，拿它当「截至」会每分钟往后挪一格，
 * 说出并不存在的数据。服务端没报这一项（没有数据点）时退回最后一个桶的末尾
 * The moment the curve runs to: the last sample. Buckets are cut back from the moment of the read, so the last bucket always ends
 * "now"; taking that as 截至 moves it forward every minute and claims data that do not exist. Without the server's figure (no points)
 * it falls back to the last bucket's end
 */
export function trendEnd(trend: RequestTrend): number | null {
  const last = trend.points.at(-1)
  if (!last) return null
  return trend.sampled_until_unix ?? last.start_unix + (trend.bucket_seconds || 3600)
}

/**
 * 趋势还在往前走吗：手上是实时数据（KixDNS 在跑），而且最后一次采样就在这次读取之前（漏一次也还算）。缺一样，曲线就停在最后一次
 * 采样那一刻：时段写「截至」，最后一个桶不当成正在进行的那一小时，右端不写「现在」。不按最后一个桶离现在多远判断：桶从读取那一刻往
 * 回切，停了以后最后一个桶还会「新」上一个半桶宽。readAtUnix 是服务端读到这份数据的时刻，和采样同一只钟
 * Whether the trend is still moving: the data in hand is live (KixDNS runs) and the last sample came just before this read (one missed
 * sample still counts). Lacking either, the curve stops at its last sample: the period reads 截至, the last bucket is not the hour in
 * progress, and the right end does not say 现在. Not judged by how old the last bucket is: buckets are cut back from the read, so after
 * a stop the last one still looks recent for a bucket and a half. readAtUnix is when the server read this data, on the samples' clock
 */
export function trendIsLive(trend: RequestTrend, live: boolean, readAtUnix: number): boolean {
  const until = trend.sampled_until_unix
  return live && until != null && readAtUnix - until <= 3 * SAMPLE_INTERVAL_SECONDS
}

/**
 * 最后一个桶是不是还没攒满：还在采时它就是正在进行的那一小时；停了以后最后一次采样落在它中间，它只有停下之前那一段。两种都照没攒满
 * 画（柱子淡、曲线最后一段虚线），不读成流量骤降；停下那一刻正好在桶的末尾时它是满的
 * Whether the last bucket is not yet full: while sampling it is the hour in progress; after a stop the last sample falls inside it and
 * it holds only the part before the stop. Both are drawn as not yet full (a faint bar, a dashed last curve segment), never read as a
 * drop; a stop right at the bucket's end leaves it full
 */
export function lastBucketUnfinished(trend: RequestTrend, live: boolean): boolean {
  const last = trend.points.at(-1)
  if (!last) return false
  if (live) return true
  const until = trend.sampled_until_unix
  return until != null && until < last.start_unix + (trend.bucket_seconds || 3600)
}

export interface Sparkline {
  /** 折线路径 */
  line: string
  /** 折线下方的填充区域，用于给曲线一点重量 */
  area: string
  /** 穿过同样这些点的平滑曲线（单调三次插值，不会冲出相邻两点的高低） */
  curve: string
  /** 平滑曲线下方的填充区域 */
  curveArea: string
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
  // 纵轴从 0 起（数据有负数时从最小值起）：夜里的低谷不会画成贴着底边、读成「没有请求」。
  // The vertical scale starts at 0 (or the minimum when data go negative), so a night-time trough is not drawn on the
  // bottom edge and read as "no requests".
  const floor = Math.min(0, min)
  const span = max === min ? 0 : max - floor
  // 全平的序列画在中线上：贴着顶边或底边都会读成「一直最高」或「一直最低」。
  // A flat series sits on the mid-line: pinning it to an edge would read as
  // permanently at maximum or minimum.
  const y = (value: number) => span === 0 ? height / 2 : height - ((value - floor) / span) * height

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
  const curve = monotoneCurve(points)
  const curveArea = `${curve} L${round(lastX)},${height} L${round(firstX)},${height} Z`
  return { line, area, curve, curveArea, lastX: round(lastX), lastY: round(lastY) }
}

/**
 * 单调三次插值（Fritsch–Carlson，与 d3 的 curveMonotoneX 同一种）：曲线穿过每个点，每一段都只在两端点的高低之间，
 * 不会为了圆滑画出数据里没有的峰和谷。
 *
 * Monotone cubic interpolation (Fritsch–Carlson, as in d3's curveMonotoneX): the curve passes through every point and each
 * segment stays between its two end heights, so smoothing never draws a peak or trough the data do not have.
 */
function monotoneCurve(points: ReadonlyArray<readonly [number, number]>): string {
  const [x0, y0] = points[0]!
  if (points.length === 1) return `M${round(x0)},${round(y0)}`
  if (points.length === 2) return `M${round(x0)},${round(y0)} L${round(points[1]![0])},${round(points[1]![1])}`
  const slopes = points.slice(1).map(([x, y], index) => (y - points[index]![1]) / (x - points[index]![0]))
  const tangents = points.map((_, index) => {
    if (index === 0 || index === points.length - 1) return Number.NaN
    const before = slopes[index - 1]!, after = slopes[index]!
    const h0 = points[index]![0] - points[index - 1]![0], h1 = points[index + 1]![0] - points[index]![0]
    const mean = (before * h1 + after * h0) / (h0 + h1)
    return (Math.sign(before) + Math.sign(after)) * Math.min(Math.abs(before), Math.abs(after), Math.abs(mean) / 2) || 0
  })
  // 两端只有一边的斜率：按旁边的切线推一个，仍然不越过这一段的高低 / The ends have one slope only: derive it from the neighbouring tangent, still within the segment's range
  tangents[0] = (3 * slopes[0]! - tangents[1]!) / 2
  tangents[points.length - 1] = (3 * slopes.at(-1)! - tangents[points.length - 2]!) / 2
  let path = `M${round(x0)},${round(y0)}`
  for (let index = 0; index < points.length - 1; index += 1) {
    const [ax, ay] = points[index]!, [bx, by] = points[index + 1]!
    const third = (bx - ax) / 3
    path += ` C${round(ax + third)},${round(ay + third * tangents[index]!)} ${round(bx - third)},${round(by - third * tangents[index + 1]!)} ${round(bx)},${round(by)}`
  }
  return path
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
