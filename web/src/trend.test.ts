import { describe, expect, it } from 'vitest'
import type { RequestTrend } from './api/types'
import { lastBucketUnfinished, sparkline, trendEnd, trendIsLive } from './trend'

describe('趋势采到哪一刻、还在不在采', () => {
  // 读取在 READ；桶从 READ 往回切，最后一个桶的末尾就是 READ / Read at READ; buckets are cut back from it, so the last one ends at READ
  const READ = 1_800_000_000
  const trend = (sampledAgo: number | null): RequestTrend => ({
    bucket_seconds: 3600,
    points: [{ start_unix: READ - 7200, requests: 10 }, { start_unix: READ - 3600, requests: 20 }],
    total: 30,
    sampled_until_unix: sampledAgo === null ? null : READ - sampledAgo,
  })

  it('「截至」是最后一次采样，不是最后一个桶的末尾', () => {
    expect(trendEnd(trend(20 * 60))).toBe(READ - 20 * 60)
    expect(trendEnd({ ...trend(null), points: [] })).toBeNull()
  })

  it('KixDNS 在跑、刚采过：还在采', () => {
    expect(trendIsLive(trend(30), true, READ)).toBe(true)
    // 漏了一次采样也还算 / One missed sample still counts
    expect(trendIsLive(trend(150), true, READ)).toBe(true)
  })

  it('停了、读不到：哪怕最后一个桶还「新」，也不算在采', () => {
    expect(trendIsLive(trend(20 * 60), false, READ)).toBe(false)
    expect(trendIsLive(trend(30), false, READ)).toBe(false)
  })

  it('KixDNS 刚回来、面板还没采到新样本：曲线还停在上次采样那一刻', () => {
    expect(trendIsLive(trend(3 * 3600), true, READ)).toBe(false)
    expect(trendIsLive(trend(20 * 60), true, READ)).toBe(false)
  })

  it('没有采样就谈不上在采', () => {
    expect(trendIsLive(trend(null), true, READ)).toBe(false)
  })

  // 最后一个桶 [READ - 3600, READ) / The last bucket is [READ - 3600, READ)
  it('停了以后最后一个桶只采到一部分：和正在进行的那一小时一样画成没攒满', () => {
    expect(lastBucketUnfinished(trend(20 * 60), false)).toBe(true)
    expect(lastBucketUnfinished(trend(59 * 60), false)).toBe(true)
  })

  it('最后一个桶采满了才画成实的', () => {
    expect(lastBucketUnfinished(trend(0), false)).toBe(false)
    expect(lastBucketUnfinished({ ...trend(0), points: trend(0).points.slice(0, 1) }, false)).toBe(false)
  })

  it('还在采时最后一个桶照旧是正在进行的那一小时', () => {
    expect(lastBucketUnfinished(trend(30), true)).toBe(true)
    expect(lastBucketUnfinished(trend(0), true)).toBe(true)
  })

  it('不知道采到哪一刻、没有数据点时不说没攒满', () => {
    expect(lastBucketUnfinished(trend(null), false)).toBe(false)
    expect(lastBucketUnfinished({ ...trend(20 * 60), points: [] }, false)).toBe(false)
  })
})

describe('趋势折线', () => {
  it('把首尾铺满整个宽度，最大值贴顶、最小值贴底', () => {
    const result = sparkline([0, 5, 10], 100, 40)!
    expect(result.line).toBe('M0,40 L50,20 L100,0')
    expect(result.lastX).toBe(100)
    expect(result.lastY).toBe(0)
  })

  it('填充区域回落到底边并闭合，不是另画一条线', () => {
    const result = sparkline([0, 10], 100, 40)!
    expect(result.area).toBe('M0,40 L100,0 L100,40 L0,40 Z')
  })

  it('全平的序列画在中线上，而不是贴着某一条边', () => {
    // 除以 0 会得到 NaN 路径；贴顶或贴底则会读成「一直最高」或「一直最低」。
    const result = sparkline([7, 7, 7], 100, 40)!
    expect(result.line).toBe('M0,20 L50,20 L100,20')
    expect(result.line).not.toContain('NaN')
  })

  it('只有一个点时落在中间，不横向除以零', () => {
    const result = sparkline([42], 100, 40)!
    expect(result.line).toBe('M50,20')
    expect(result.line).not.toContain('NaN')
    expect(result.lastX).toBe(50)
  })

  it('空序列交回 null，由调用方决定显示什么', () => {
    expect(sparkline([], 100, 40)).toBeNull()
  })

  it('负值和零一起出现时仍然按实际跨度铺开', () => {
    const result = sparkline([-10, 0, 10], 100, 40)!
    expect(result.line).toBe('M0,40 L50,20 L100,0')
  })

  it('坐标保留两位小数，路径不带长尾浮点', () => {
    const result = sparkline([0, 1, 2, 5, 3, 8, 13], 260, 74)!
    expect(result.line).not.toMatch(/\d\.\d{3}/)
  })

  it('starts the vertical scale at zero so a trough is not drawn as no traffic', () => {
    const result = sparkline([50, 100], 100, 40)!
    expect(result.line).toBe('M0,20 L100,0')
  })

  it('平滑曲线穿过每个点，每段的控制点都不越出两端的高低', () => {
    const values = [0, 1, 2, 5, 3, 8, 13, 13, 4]
    const result = sparkline(values, 240, 60)!
    const numbers = (text: string) => text.replace(/[MC]/g, ' ').trim().split(/[\s,]+/).map(Number)
    const segments = result.curve.split(' C').slice(1).map(numbers)
    const anchors = [numbers(result.curve.split(' C')[0]!), ...segments.map((segment) => segment.slice(4))]
    const line = result.line.split(' ').map((step) => step.slice(1).split(',').map(Number))
    expect(anchors).toEqual(line)
    segments.forEach((segment, index) => {
      const [from, to] = [anchors[index]![1]!, anchors[index + 1]![1]!]
      for (const y of [segment[1]!, segment[3]!]) {
        expect(y).toBeGreaterThanOrEqual(Math.min(from, to) - 0.01)
        expect(y).toBeLessThanOrEqual(Math.max(from, to) + 0.01)
      }
    })
  })

  it('全平的序列平滑后还是一条平线', () => {
    const result = sparkline([7, 7, 7, 7], 90, 40)!
    expect(result.curve).toBe('M0,20 C10,20 20,20 30,20 C40,20 50,20 60,20 C70,20 80,20 90,20')
    expect(result.curveArea).toBe(`${result.curve} L90,40 L0,40 Z`)
  })

  it('一两个点时平滑曲线和折线一样', () => {
    expect(sparkline([42], 100, 40)!.curve).toBe('M50,20')
    expect(sparkline([0, 10], 100, 40)!.curve).toBe('M0,40 L100,0')
  })
})

