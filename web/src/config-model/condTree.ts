import type { Condition } from './model'

// 编辑页里条件的样子：顶上一句「满足下面全部 / 任一条件」，下面是条件，可以再放一层条件组（组里也有自己的全部 / 任一）。
// 内核和保存的格式仍是「几组条件，组内都满足、组间满足一组」（析取范式），这里两边互相换算，换算前后命中的请求一样。
// How conditions look in the editor: one 「match all / any of these」 on top, then the conditions, with at most one level of
// condition groups that carry their own all / any. The kernel and the saved format stay 「several groups, every condition in a
// group, any one group」 (disjunctive normal form); this file converts both ways, and a conversion never changes which requests match.
export type Match = 'all' | 'any'
export interface CondGroup { id: number; group: true; match: Match; items: Condition[] }
export type CondItem = Condition | CondGroup
export interface CondTree { match: Match; items: CondItem[] }

export const isGroup = (item: CondItem): item is CondGroup => 'group' in item

const same = (a: Condition, b: Condition) => a.field === b.field && a.negate === b.negate && Boolean(a.regex) === Boolean(b.regex) && a.values.length === b.values.length && a.values.every((v, i) => v === b.values[i])

// 组里一个条件也没有就当它不存在：空组不会让整条规则什么都匹配不上 / An empty group counts as absent, so it never makes the whole rule match nothing
function clausesOf(item: CondItem): Condition[][] {
  if (!isGroup(item)) return [[item]]
  if (!item.items.length) return []
  return item.match === 'all' ? [item.items] : item.items.map((c) => [c])
}

export function toDnf(tree: CondTree): Condition[][] {
  const parts = tree.items.map(clausesOf).filter((p) => p.length)
  if (!parts.length) return [[]]
  if (tree.match === 'any') return parts.flat()
  // 全部满足：每一部分挑一个分支拼起来（展开成「或」的几组） / All: pick one branch from every part and join them (expanding into OR groups)
  return parts.reduce<Condition[][]>((acc, part) => acc.flatMap((clause) => part.map((branch) => [...clause, ...branch])), [[]])
}

export function toTree(dnf: Condition[][], newId: () => number): CondTree {
  const groups = dnf.filter((g) => g.length)
  if (groups.length <= 1) return { match: 'all', items: [...(groups[0] ?? [])] }
  if (groups.every((g) => g.length === 1)) return { match: 'any', items: groups.map((g) => g[0]!) }
  // 每组都有的条件提出来，剩下的各只有一条时写成「全部：公共条件 + 任一组」 / Conditions shared by every group come out front; when each remainder is a single condition this reads 「all: the shared ones + an any-group」
  const common = groups[0]!.filter((c) => groups.every((g) => g.some((d) => same(c, d))))
  if (common.length) {
    const rests = groups.map((g) => g.filter((c) => !common.some((d) => same(c, d))))
    if (rests.every((r) => r.length === 1)) return { match: 'all', items: [...common, { id: newId(), group: true, match: 'any', items: rests.map((r) => r[0]!) }] }
  }
  return { match: 'any', items: groups.map((g) => (g.length === 1 ? g[0]! : { id: newId(), group: true, match: 'all', items: [...g] })) }
}

// 右栏那句话按编辑时的结构说：组里的条件放进括号，不把「全部 + 任一组」展开成重复的几段
// The rail sentence follows the structure being edited: a group's conditions go in parentheses instead of expanding 「all + an any-group」 into repeated clauses
export function treeText(tree: CondTree, text: (c: Condition) => string): string {
  const parts = tree.items.filter((i) => !isGroup(i) || i.items.length).map((i) => {
    if (!isGroup(i)) return text(i)
    const inner = i.items.map(text).join(i.match === 'all' ? ' 且 ' : ' 或 ')
    return i.items.length > 1 ? `（${inner}）` : inner
  })
  if (!parts.length) return '所有请求'
  // 全角括号自带空白，挨着它的空格去掉（「且（…）」不写成「且 （…）」） / Full-width parentheses carry their own space, so the spaces next to them go
  return parts.join(tree.match === 'all' ? ' 且 ' : '，或 ').replace(/ （/g, '（').replace(/） /g, '）')
}
