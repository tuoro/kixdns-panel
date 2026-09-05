import { describe, expect, it } from 'vitest'
import { pipelineDistribution } from './dashboard-presentation'

describe('概览 Pipeline 分布', () => {
  it('按命中次数排序，并以计数总和计算真实占比', () => {
    const distribution = pipelineDistribution([
      { name: 'domestic', count: 2_773_104 },
      { name: 'default', count: 8_914_380 },
      { name: 'blocked', count: 1_159_908 },
    ])

    expect(distribution.map((item) => item.name)).toEqual(['default', 'domestic', 'blocked'])
    expect(distribution[0]?.share).toBe(8_914_380 / 12_847_392)
    expect(distribution.reduce((sum, item) => sum + item.share, 0)).toBeCloseTo(1)
  })

  it('不通过最小宽度放大小流量，也不隐藏零命中条目', () => {
    const distribution = pipelineDistribution([
      { name: 'large', count: 999 },
      { name: 'small', count: 1 },
      { name: 'zero', count: 0 },
    ])

    expect(distribution.map((item) => item.share)).toEqual([0.999, 0.001, 0])
  })

  it('空数据和全部零计数不会生成无效比例', () => {
    expect(pipelineDistribution([])).toEqual([])
    expect(pipelineDistribution([{ name: 'waiting', count: 0 }])).toEqual([
      { name: 'waiting', count: 0, share: 0 },
    ])
  })

  it('不修改传入的顺序和条目', () => {
    const items = Object.freeze([
      Object.freeze({ name: 'small', count: 1 }),
      Object.freeze({ name: 'large', count: 2 }),
    ])

    expect(pipelineDistribution(items)[0]?.name).toBe('large')
    expect(items[0]?.name).toBe('small')
  })
})
