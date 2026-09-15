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
})
