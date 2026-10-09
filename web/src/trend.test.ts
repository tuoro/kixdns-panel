import { describe, expect, it } from 'vitest'
import { sparkline } from './trend'

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

