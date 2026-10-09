import { describe, expect, it } from 'vitest'
import type { Condition } from './model'
import { isGroup, toDnf, toTree, treeText, type CondItem, type CondTree } from './condTree'

// 每个条件当成一个开关，把所有开关组合都试一遍：换算前后答案必须一样 / Treat each condition as a switch and try every combination: the answer must not change across a conversion
const cond = (id: number, value = `v${id}`): Condition => ({ id, field: 'domain', negate: false, regex: false, values: [value] })
const A = cond(1), B = cond(2), C = cond(3), D = cond(4)
const atoms = [A, B, C, D]
const worlds = Array.from({ length: 1 << atoms.length }, (_, mask) => new Set(atoms.filter((_, i) => mask & (1 << i)).map((c) => c.id)))
const holdsDnf = (dnf: Condition[][], world: Set<number>) => dnf.some((clause) => clause.every((c) => world.has(c.id)))
const holdsItem = (item: CondItem, world: Set<number>): boolean => (isGroup(item) ? (item.items.length ? (item.match === 'all' ? item.items.every((c) => world.has(c.id)) : item.items.some((c) => world.has(c.id))) : true) : world.has(item.id))
const holdsTree = (tree: CondTree, world: Set<number>) => {
  const items = tree.items.filter((i) => !isGroup(i) || i.items.length)
  if (!items.length) return true
  return tree.match === 'all' ? items.every((i) => holdsItem(i, world)) : items.some((i) => holdsItem(i, world))
}
let seq = 100
const id = () => ++seq
const group = (match: 'all' | 'any', items: Condition[]): CondItem => ({ id: id(), group: true, match, items })

const trees: [string, CondTree][] = [
  ['全部：A、B', { match: 'all', items: [A, B] }],
  ['任一：A、B、C', { match: 'any', items: [A, B, C] }],
  ['全部：A，且任一（B、C）', { match: 'all', items: [A, group('any', [B, C])] }],
  ['任一：A，或全部（B、C）', { match: 'any', items: [A, group('all', [B, C])] }],
  ['全部：任一（A、B），任一（C、D）', { match: 'all', items: [group('any', [A, B]), group('any', [C, D])] }],
  ['全部：A，空组不算', { match: 'all', items: [A, group('any', [])] }],
]

describe('条件的「全部 / 任一」和保存格式互相换算', () => {
  it.each(trees)('%s：换成保存格式后命中的情况不变', (_, tree) => {
    const dnf = toDnf(tree)
    for (const world of worlds) expect(holdsDnf(dnf, world)).toBe(holdsTree(tree, world))
  })

  it.each(trees)('%s：从保存格式读回来，命中的情况也不变', (_, tree) => {
    const back = toTree(toDnf(tree), id)
    for (const world of worlds) expect(holdsTree(back, world)).toBe(holdsTree(tree, world))
  })

  it('读回来时把每组都有的条件提到前面，写成「全部：公共条件，任一组」', () => {
    const back = toTree([[A, B], [A, C]], id)
    expect(back.match).toBe('all')
    expect(back.items[0]).toBe(A)
    const g = back.items[1]!
    expect(isGroup(g) && g.match === 'any' && g.items.map((c) => c.id)).toEqual([2, 3])
  })

  it('每组只有一个条件时读成「任一」，只有一组时读成「全部」', () => {
    expect(toTree([[A], [B]], id)).toEqual({ match: 'any', items: [A, B] })
    expect(toTree([[A, B]], id)).toEqual({ match: 'all', items: [A, B] })
    expect(toTree([[]], id)).toEqual({ match: 'all', items: [] })
  })

  it('没有条件就是匹配所有请求：保存格式里是一个空组', () => {
    expect(toDnf({ match: 'any', items: [] })).toEqual([[]])
    expect(toDnf({ match: 'all', items: [group('any', [])] })).toEqual([[]])
  })
})

describe('右栏那句话按编辑时的结构说', () => {
  const text = (c: Condition) => `域名是 ${c.values.join('、')}`
  it('全部加一个任一组：组里的条件放进括号，不展开成重复的两段', () => {
    expect(treeText({ match: 'all', items: [A, group('any', [B, C])] }, text)).toBe('域名是 v1 且（域名是 v2 或 域名是 v3）')
  })
  it('任一：条件之间用「，或」；空组不说', () => {
    expect(treeText({ match: 'any', items: [A, B, group('all', [])] }, text)).toBe('域名是 v1，或 域名是 v2')
    expect(treeText({ match: 'all', items: [] }, text)).toBe('所有请求')
  })
})
