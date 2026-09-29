import { formatDomainMappingTtl } from './domain-mapping'
import { normalizeConfig } from './model'
import { hasResponseProcessing } from './rule-draft'
import { SETTING_SECTIONS, type SettingField } from './schema'
import { collectDnsSolutions, type DnsSolution, type DomainMappingRow } from './solution'
import { actionsPhrase, conditionPhrase, join, locate, phrase, type Phrase } from './phrase'
import type {
  ConfigObject,
  KixConfig,
  PipelineConfig,
  PipelineSelectConfig,
  RuleConfig,
} from './types'

// 按身份比较两份配置，不按数组下标：在前面插一个 Pipeline，后面的不会跟着都算「改了」。
// 入口按目标 Pipeline 加条件做最长公共子序列对齐，Pipeline 按 ID，规则按名称，域名映射按源域名，设置按键。
// Compares two configs by identity, not by array index: inserting a Pipeline at the front no
// longer makes every later one look changed. Entries are aligned by a longest common subsequence
// over target Pipeline plus conditions, Pipelines by ID, rules by name, domain mappings by source,
// settings by key.

export type ChangeKind = 'added' | 'removed' | 'changed' | 'moved'
export type ChangeSubject = 'entry' | 'pipeline' | 'mapping' | 'setting' | 'other'

/**
 * 一行改动。方向固定为 from → to：'-' 是它在 from 里的样子，'+' 是它在 to 里的样子。
 * text 是给人读的一句话；code 是句中的机器值（Pipeline ID、地址、域名、分类名），
 * 按在 text 里出现的顺序排列，用 lineSegments 切出来设成等宽字。
 *
 * One line of a change, always in the from → to direction: '-' is how the thing reads in
 * `from`, '+' how it reads in `to`. text is the human sentence; code holds the machine values
 * inside it (Pipeline IDs, addresses, domains, category names) in the order they occur in text;
 * lineSegments cuts them out for the UI to set in mono.
 */
export interface ChangeLine {
  mark: '+' | '-'
  text: string
  code?: string[]
}

export interface ChangeSegment {
  text: string
  code: boolean
}

export interface ChangeGroup {
  /** 同一次比较里唯一，例如 entry:2、pipeline:domestic、mapping:nas.home.arpa、setting:cache_capacity。 / Unique within one diff. */
  key: string
  /**
   * 计数单位：unit 相同的几组算「一处」。入口和只有它在用的 Pipeline 共用入口的 key，界面可以按 unit 把它们并成一块。
   * The count unit: groups sharing a unit are one change. An entry and the Pipeline only it uses share the
   * entry's key, so the UI can render them as one block.
   */
  unit: string
  subject: ChangeSubject
  kind: ChangeKind
  /** 入口用 to 里的编号（被删的用 from 里的编号），与工作台左侧的编号一致。 / Entries use their number in `to` (removed ones their number in `from`), as the workbench shows it. */
  title: string
  /**
   * 在 to 里的下标，给未保存圆点用：入口是 pipeline_select 下标（即 DnsSolution.selectorIndex），
   * 映射是 collectDomainMappingRows 里的下标，Pipeline 是 pipelines 下标。被删的没有。
   * Index in `to`, for dirty dots: entries index pipeline_select (DnsSolution.selectorIndex), mappings
   * index collectDomainMappingRows, Pipelines index pipelines. Absent for removed things.
   */
  afterIndex?: number
  /**
   * 相对顺序变了时才有：from 是它在 from 里的位置，to 是在 to 里的位置，都从 1 数。
   * 'moved' 一定有；'changed' 同时挪了位置也有。界面写「从第 from 位移到第 to 位」。
   * Present only when the thing's order relative to the others changed: from is its position in
   * `from`, to its position in `to`, both 1-based. Always set on 'moved'; set on 'changed' that also
   * moved. The UI writes 「从第 from 位移到第 to 位」.
   */
  from?: number
  to?: number
  /** 'changed' 是 '-' 与 '+' 成对；'added' 只有 '+'；'removed' 只有 '-'；'moved' 没有。 / 'changed' pairs '-' with '+'; 'added' only '+'; 'removed' only '-'; 'moved' none. */
  lines: ChangeLine[]
}

export interface ChangeSet {
  groups: ChangeGroup[]
  /** 「已修改 N 处」的 N：不同 unit 的个数。 / The N in 已修改 N 处: the number of distinct units. */
  count: number
}

/**
 * 比较 from 和 to，列出从 from 变到 to 的改动。
 * - 保存条和未保存圆点：from = 已保存的配置，to = 草稿。
 * - 版本对比（「恢复 #N 会对当前配置做什么」）：from = 当前配置，to = 版本 #N；'-' 即恢复会去掉，'+' 即恢复会加上。
 * 两边都先按编辑器读入时的方式规范化，所以 JSON.parse 的原样结果和编辑器里的对象都可以直接传。
 *
 * Lists the changes that turn `from` into `to`.
 * - Save bar and dirty dots: from = the saved config, to = the draft.
 * - Version diff ("what restoring #N does to the current config"): from = the current config,
 *   to = version #N; '-' means restoring removes it, '+' means restoring adds it.
 * Both sides are normalized the way the editor reads them, so raw JSON.parse output and the
 * editor's own object can both be passed.
 */
export function diffByIdentity(from: KixConfig, to: KixConfig): ChangeSet {
  return analyze(from, to)
}

/**
 * to 里需要未保存圆点的入口（pipeline_select 下标）：新增、改动、挪动的入口，以及独占 Pipeline 改了的入口。
 * 共享 Pipeline 改了不给引用它的入口加点：那是 Pipeline 自己的一处改动，给每个入口都点上，
 * 圆点的个数就和「已修改 N 处」对不上了。
 *
 * Entries in `to` (pipeline_select indexes) that get a dirty dot: added, changed or moved entries, and
 * entries whose own Pipeline changed. A changed shared Pipeline does not dot the entries that use it:
 * it is one change of its own, and dotting every entry would make the dots disagree with 已修改 N 处.
 */
export function changedEntryIndexes(from: KixConfig, to: KixConfig): Set<number> {
  return new Set(diffByIdentity(from, to).groups.flatMap((group) => (
    group.subject === 'entry' && group.kind !== 'removed' && group.afterIndex !== undefined ? [group.afterIndex] : []
  )))
}

/**
 * 把一行切成正文段和机器值段：从左往右，每个机器值取上一个之后、不在拉丁单词或数字中间开头的第一处。
 * Cuts a line into body text and machine-value segments: left to right, each machine value is the
 * first occurrence after the previous one that does not start inside a Latin word or number.
 */
export function lineSegments(line: ChangeLine): ChangeSegment[] {
  const segments: ChangeSegment[] = []
  let offset = 0
  for (const value of line.code ?? []) {
    const at = locate(line.text, value, offset)
    if (at < 0) continue
    if (at > offset) segments.push({ text: line.text.slice(offset, at), code: false })
    segments.push({ text: value, code: true })
    offset = at + value.length
  }
  if (offset < line.text.length) segments.push({ text: line.text.slice(offset), code: false })
  return segments
}

// ---------------------------------------------------------------------------------------------
// 通用小工具 / Small helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isRecord(value)) return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key])
  return sorted
}

/** 与键顺序无关的比较用字符串。 / A comparison string that ignores key order. */
function stable(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? ''
}

function omit(value: ConfigObject, key: string): ConfigObject {
  const rest: ConfigObject = {}
  for (const [name, field] of Object.entries(value)) {
    if (name !== key) rest[name] = field
  }
  return rest
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '')
}

function queueBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, number[]> {
  const queues = new Map<string, number[]>()
  items.forEach((item, index) => {
    const key = keyOf(item)
    const queue = queues.get(key)
    if (queue) queue.push(index)
    else queues.set(key, [index])
  })
  return queues
}

// ---------------------------------------------------------------------------------------------
// 句子：正文加机器值 / Sentences: body text plus machine values

/**
 * 只保留按 lineSegments 的找法能落回原位的机器值，切分时就不会标错位置。
 * Keeps only the machine values that lineSegments' search lands back on, so splitting never marks the wrong spot.
 */
function toLine(mark: '+' | '-', value: Phrase): ChangeLine {
  const code: string[] = []
  let offset = 0
  for (const [start, text] of value.marks) {
    if (locate(value.text, text, offset) !== start) continue
    code.push(text)
    offset = start + text.length
  }
  return code.length ? { mark, text: value.text, code } : { mark, text: value.text }
}

function jsonPhrase(value: unknown): Phrase {
  const json = JSON.stringify(value) ?? '未设置'
  return phrase(json, [json])
}

// ---------------------------------------------------------------------------------------------
// 序列对齐 / Sequence alignment

type Pair = [number, number]

/** 超过这个格子数就不用带平局规则的动态规划，改用最长递增子序列。 / Above this many cells the tie-breaking table gives way to a longest increasing subsequence. */
const TABLE_LIMIT = 250_000

/**
 * 最长公共子序列，返回按顺序的 [from 下标, to 下标]。长度相同时先选位置变动小的，再选 from 里靠前的：
 * 1、3 互换时留下没动的 2；相邻两个互换时，标出往前挪的那一个（上移比下移常见）。
 *
 * Longest common subsequence as ordered [from index, to index] pairs. Among equally long ones it
 * prefers the least displacement, then anchors that come earlier in `from`: swapping 1 and 3 keeps 2
 * in place, and an adjacent swap flags the entry that moved up (moving up is the commoner action).
 */
function commonSubsequence(a: readonly string[], b: readonly string[]): Pair[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  const middleA = a.slice(head, a.length - tail)
  const middleB = b.slice(head, b.length - tail)
  const middle = middleA.length * middleB.length <= TABLE_LIMIT ? commonByTable(middleA, middleB) : commonByLis(middleA, middleB)
  const pairs: Pair[] = []
  for (let index = 0; index < head; index += 1) pairs.push([index, index])
  for (const [i, j] of middle) pairs.push([head + i, head + j])
  for (let index = tail; index > 0; index -= 1) pairs.push([a.length - index, b.length - index])
  return pairs
}

function ranks(sequence: readonly string[], other: ReadonlySet<string>): Int32Array {
  const result = new Int32Array(sequence.length)
  let rank = 0
  sequence.forEach((key, index) => {
    result[index] = rank
    if (other.has(key)) rank += 1
  })
  return result
}

function commonByTable(a: readonly string[], b: readonly string[]): Pair[] {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return []
  // 位移只在两边都有的元素之间算，免得别处的增删把平局规则带偏。
  // Displacement counts only elements present on both sides, so unrelated additions and removals do not skew ties.
  const rankA = ranks(a, new Set(b))
  const rankB = ranks(b, new Set(a))
  const width = m + 1
  const length = new Int32Array((n + 1) * width)
  const cost = new Int32Array((n + 1) * width)
  const step = new Uint8Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const here = i * width + j
      const right = here + 1
      const down = here + width
      let bestLength = length[right]!
      let bestCost = cost[right]!
      let bestStep = 1
      if (length[down]! > bestLength || (length[down] === bestLength && cost[down]! < bestCost)) {
        bestLength = length[down]!
        bestCost = cost[down]!
        bestStep = 2
      }
      if (a[i] === b[j]) {
        const matchLength = length[down + 1]! + 1
        const matchCost = cost[down + 1]! + Math.abs(rankA[i]! - rankB[j]!)
        if (matchLength > bestLength || (matchLength === bestLength && matchCost <= bestCost)) {
          bestLength = matchLength
          bestCost = matchCost
          bestStep = 0
        }
      }
      length[here] = bestLength
      cost[here] = bestCost
      step[here] = bestStep
    }
  }
  const pairs: Pair[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const move = step[i * width + j]
    if (move === 0) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (move === 1) {
      j += 1
    } else {
      i += 1
    }
  }
  return pairs
}

function commonByLis(a: readonly string[], b: readonly string[]): Pair[] {
  const waiting = queueBy(b, (key) => key)
  const candidates: Pair[] = []
  a.forEach((key, i) => {
    const j = waiting.get(key)?.shift()
    if (j !== undefined) candidates.push([i, j])
  })
  const tails: number[] = []
  const previous = new Int32Array(candidates.length).fill(-1)
  candidates.forEach(([, j], index) => {
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (candidates[tails[middle]!]![1] < j) low = middle + 1
      else high = middle
    }
    if (low > 0) previous[index] = tails[low - 1]!
    tails[low] = index
  })
  const pairs: Pair[] = []
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]!) pairs.push(candidates[index]!)
  return pairs.reverse()
}

interface Paired {
  from: number
  to: number
  /** 跨过了对齐锚点，即相对顺序变了。 / Crosses an alignment anchor: its relative order changed. */
  moved: boolean
}

interface Pairing {
  pairs: Paired[]
  removed: number[]
  added: number[]
}

interface PairingOptions {
  /** 在任意位置都算同一个的额外身份。 / An extra identity that pairs anywhere. */
  link?: (from: number, to: number) => boolean
  /** 同一段空隙里优先配对的条件，之后按位置配。 / Which pairs to prefer inside a gap before pairing by position. */
  prefer?: (from: number, to: number) => boolean
  /** 是否在锚点之间的空隙里按位置配对（默认是）。 / Whether leftovers between anchors pair by position (default yes). */
  gaps?: boolean
}

function countBelow(sorted: readonly number[], value: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (sorted[middle]! < value) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * 对齐两串东西：
 * 1. 按键做最长公共子序列，成对的就是没动的锚点；
 * 2. 不在子序列里、键相同的，在哪儿都配成一对，是挪了位置；
 * 3. link 认定的也配成一对；
 * 4. 剩下的在两个锚点之间的同一段空隙里，先按 prefer、再按位置配成一对，是改了；
 * 5. 仍剩下的，from 里的是删了，to 里的是加了。
 *
 * Aligns two sequences:
 * 1. a longest common subsequence by key gives the anchors, which stayed put;
 * 2. equal keys outside it pair wherever they are: those moved;
 * 3. pairs accepted by link pair too;
 * 4. leftovers in the same gap between two anchors pair by prefer, then by position: those changed;
 * 5. what is still left was removed (from) or added (to).
 */
function pairSequences(fromKeys: readonly string[], toKeys: readonly string[], options: PairingOptions = {}): Pairing {
  const anchors = commonSubsequence(fromKeys, toKeys)
  const anchorFrom = anchors.map(([from]) => from)
  const anchorTo = anchors.map(([, to]) => to)
  const fromTaken = fromKeys.map(() => false)
  const toTaken = toKeys.map(() => false)
  const pairs: Paired[] = anchors.map(([from, to]) => ({ from, to, moved: false }))
  for (const [from, to] of anchors) {
    fromTaken[from] = true
    toTaken[to] = true
  }
  const pair = (from: number, to: number): void => {
    fromTaken[from] = true
    toTaken[to] = true
    pairs.push({ from, to, moved: countBelow(anchorFrom, from) !== countBelow(anchorTo, to) })
  }

  const waiting = queueBy(toKeys, (key) => key)
  for (const queue of waiting.values()) {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (toTaken[queue[index]!]) queue.splice(index, 1)
    }
  }
  fromKeys.forEach((key, from) => {
    if (fromTaken[from]) return
    const to = waiting.get(key)?.shift()
    if (to !== undefined) pair(from, to)
  })

  if (options.link) {
    for (let from = 0; from < fromKeys.length; from += 1) {
      if (fromTaken[from]) continue
      const to = toKeys.findIndex((_, index) => !toTaken[index] && options.link!(from, index))
      if (to >= 0) pair(from, to)
    }
  }

  if (options.gaps !== false) {
    const gapsOf = (taken: readonly boolean[], anchorsOnSide: readonly number[]): Map<number, number[]> => {
      const gaps = new Map<number, number[]>()
      taken.forEach((isTaken, index) => {
        if (isTaken) return
        const gap = countBelow(anchorsOnSide, index)
        const members = gaps.get(gap)
        if (members) members.push(index)
        else gaps.set(gap, [index])
      })
      return gaps
    }
    const fromGaps = gapsOf(fromTaken, anchorFrom)
    const toGaps = gapsOf(toTaken, anchorTo)
    for (const [gap, froms] of fromGaps) {
      const tos = toGaps.get(gap) ?? []
      if (options.prefer) {
        for (const from of froms) {
          const to = tos.find((candidate) => !toTaken[candidate] && options.prefer!(from, candidate))
          if (to !== undefined) pair(from, to)
        }
      }
      const restFrom = froms.filter((from) => !fromTaken[from])
      const restTo = tos.filter((to) => !toTaken[to])
      for (let index = 0; index < Math.min(restFrom.length, restTo.length); index += 1) pair(restFrom[index]!, restTo[index]!)
    }
  }

  return {
    pairs: pairs.sort((left, right) => left.to - right.to),
    removed: fromKeys.flatMap((_, from) => fromTaken[from] ? [] : [from]),
    added: toKeys.flatMap((_, to) => toTaken[to] ? [] : [to]),
  }
}

/**
 * 被删的东西排在 from 里它前面那个没挪动的东西在 to 里的位置之后：在 to 里排第 n 位的取 2n，被删的取奇数插在中间。
 * Removed things sort right after the position, in `to`, of the unmoved thing before them in `from`;
 * a thing at position n in `to` sorts at 2n and removed ones take the odd slots between.
 */
function removedOrders(pairing: Pairing, fromCount: number, positionOfTo: (to: number) => number): Map<number, number> {
  const toOfFrom = new Map(pairing.pairs.filter((pair) => !pair.moved).map((pair) => [pair.from, pair.to]))
  const orders = new Map<number, number>()
  let last = 0
  for (let from = 0; from < fromCount; from += 1) {
    const to = toOfFrom.get(from)
    if (to !== undefined) last = positionOfTo(to)
    else orders.set(from, last * 2 + 1)
  }
  return orders
}

// ---------------------------------------------------------------------------------------------
// 读出一边的配置 / Reading one side

interface EntryInfo {
  /** pipeline_select 下标 / pipeline_select index */
  index: number
  /** 工作台里的编号：不算域名映射，从 1 数。 / The workbench number: domain mappings excluded, 1-based. */
  number: number
  selector: PipelineSelectConfig
  solution: DnsSolution
}

interface RowInfo {
  row: DomainMappingRow
  pipelineId: string
  /** collectDomainMappingRows 里的下标 / Index in collectDomainMappingRows */
  index: number
}

interface Side {
  config: KixConfig
  entries: EntryInfo[]
  rows: RowInfo[]
  mappingIds: Set<string>
  pipelineAt: Map<string, number>
}

function readSide(input: unknown): Side {
  const config = normalizeConfig(isRecord(input) ? input : {})
  const entries: EntryInfo[] = []
  const rows: RowInfo[] = []
  const mappingIds = new Set<string>()
  for (const solution of collectDnsSolutions(config)) {
    const selector = solution.selector
    if (!selector || solution.selectorIndex === undefined) continue
    if (solution.groupType === 'domain_mapping') {
      mappingIds.add(selector.pipeline)
      for (const row of solution.mappingRows ?? []) rows.push({ row, pipelineId: selector.pipeline, index: rows.length })
    } else {
      entries.push({ index: solution.selectorIndex, number: entries.length + 1, selector, solution })
    }
  }
  const pipelineAt = new Map<string, number>()
  config.pipelines.forEach((pipeline, index) => {
    if (!pipelineAt.has(pipeline.id)) pipelineAt.set(pipeline.id, index)
  })
  return { config, entries, rows, mappingIds, pipelineAt }
}

/** 入口只有它自己在引用目标 Pipeline（没有别的入口，也没有跳转）。 / The entry is the only reference to its Pipeline (no other entry, no jump). */
function ownsPipeline(side: Side, entry: EntryInfo): boolean {
  return entry.solution.referenceCount === 1 && side.pipelineAt.has(entry.selector.pipeline)
}

function isEmptyRow(row: DomainMappingRow): boolean {
  return !row.source.trim() && !row.target.trim()
}

// ---------------------------------------------------------------------------------------------
// Pipeline 对应关系 / Pipeline correspondence

interface PipelineMatch {
  fromMatch: Array<number | undefined>
  toMatch: Array<number | undefined>
}

/**
 * 先按 ID 对上；剩下的普通 Pipeline 里，内容完全相同的、或者被条件完全相同的入口引用的，算改了名。
 * Matches by ID first; among the remaining ordinary Pipelines, identical content or being referenced
 * by entries with identical conditions counts as a rename.
 */
function matchPipelines(a: Side, b: Side, managed: (id: string) => boolean): PipelineMatch {
  const before = a.config.pipelines
  const after = b.config.pipelines
  const fromMatch: Array<number | undefined> = before.map(() => undefined)
  const toMatch: Array<number | undefined> = after.map(() => undefined)
  const link = (from: number, to: number): void => {
    fromMatch[from] = to
    toMatch[to] = from
  }

  const waiting = queueBy(after, (pipeline) => pipeline.id)
  before.forEach((pipeline, from) => {
    const to = waiting.get(pipeline.id)?.shift()
    if (to !== undefined) link(from, to)
  })

  const conditions = (side: Side, id: string): string => side.entries
    .filter((entry) => entry.selector.pipeline === id)
    .map((entry) => stable(omit(entry.selector, 'pipeline')))
    .sort()
    .join('\n')
  const beforeContent = before.map((pipeline) => stable(omit(pipeline, 'id')))
  const afterContent = after.map((pipeline) => stable(omit(pipeline, 'id')))
  const beforeConditions = before.map((pipeline) => conditions(a, pipeline.id))
  const afterConditions = after.map((pipeline) => conditions(b, pipeline.id))
  const renames: Array<(from: number, to: number) => boolean> = [
    (from, to) => beforeContent[from] === afterContent[to],
    (from, to) => beforeConditions[from] !== '' && beforeConditions[from] === afterConditions[to],
  ]
  for (const same of renames) {
    before.forEach((pipeline, from) => {
      if (fromMatch[from] !== undefined || managed(pipeline.id)) return
      const to = after.findIndex((candidate, index) => toMatch[index] === undefined && !managed(candidate.id) && same(from, index))
      if (to >= 0) link(from, to)
    })
  }
  return { fromMatch, toMatch }
}

// ---------------------------------------------------------------------------------------------
// 文字：入口、规则、Pipeline、映射、设置 / Wording: entries, rules, Pipelines, mappings, settings

function entryCondition(entry: EntryInfo): Phrase {
  return conditionPhrase(entry.selector.matchers, entry.selector.matcher_operator, 'selector')
}

/** 与工作台入口第二行相同：→ Pipeline · 动作。 / The same as the workbench row's second line: → Pipeline · action. */
function entryRoute(entry: EntryInfo): Phrase {
  const id = entry.selector.pipeline
  const { solution } = entry
  const action = !solution.pipeline
    ? phrase(solution.reason ?? '目标 Pipeline 不存在')
    : solution.kind !== 'simple' || !solution.rule
      ? phrase(`${solution.pipeline.rules.length} 条规则 · 自定义流程`)
      : actionsPhrase(solution.rule.actions)
  return join('→ ', phrase(id || '未选择', [id]), ' · ', action)
}

function entrySummary(entry: EntryInfo): Phrase {
  return join(entryCondition(entry), ' ', entryRoute(entry))
}

/** 条件 → Pipeline，不带动作：动作写在下面「连同」的那个 Pipeline 里。 / Condition → Pipeline without the action, which the 连同 Pipeline below shows. */
function entryBrief(entry: EntryInfo): Phrase {
  const id = entry.selector.pipeline
  return join(entryCondition(entry), ' → ', phrase(id || '未选择', [id]))
}

function selectorConditions(selector: PipelineSelectConfig): string {
  return stable(omit(selector, 'pipeline'))
}

function textsOf(phrases: Phrase[]): string {
  return phrases.map((item) => item.text).sort().join('\n')
}

/**
 * 条件级的 −/+：条件关系没变时逐条列出增删的条件，关系变了就整句对比；字面看不出差别时退回 JSON。
 * Condition-level −/+: with the same combination, list the conditions added and removed; when the
 * combination changed, compare whole sentences; fall back to JSON when the wording shows no difference.
 */
function conditionChangeLines(before: PipelineSelectConfig, after: PipelineSelectConfig): ChangeLine[] {
  const lines: ChangeLine[] = []
  const plain = (selector: PipelineSelectConfig): boolean => selector.matchers.length > 0 && selector.matchers.every((matcher) => matcher.operator === 'and')
  const sameShape = plain(before) && plain(after) && before.matcher_operator === after.matcher_operator
  if (stable([before.matchers, before.matcher_operator]) !== stable([after.matchers, after.matcher_operator])) {
    if (sameShape) {
      const common = commonSubsequence(before.matchers.map(stable), after.matchers.map(stable))
      const keptBefore = new Set(common.map(([from]) => from))
      const keptAfter = new Set(common.map(([, to]) => to))
      const removed = before.matchers.flatMap((matcher, index) => keptBefore.has(index) ? [] : [matcher])
      const added = after.matchers.flatMap((matcher, index) => keptAfter.has(index) ? [] : [matcher])
      const removedPhrases = removed.map((matcher) => conditionPhrase([matcher], 'and', 'selector'))
      const addedPhrases = added.map((matcher) => conditionPhrase([matcher], 'and', 'selector'))
      const visible = textsOf(removedPhrases) !== textsOf(addedPhrases)
      lines.push(
        ...(visible ? removedPhrases : removed.map(jsonPhrase)).map((item) => toLine('-', item)),
        ...(visible ? addedPhrases : added.map(jsonPhrase)).map((item) => toLine('+', item)),
      )
    } else {
      const beforeText = conditionPhrase(before.matchers, before.matcher_operator, 'selector')
      const afterText = conditionPhrase(after.matchers, after.matcher_operator, 'selector')
      const visible = beforeText.text !== afterText.text
      lines.push(
        toLine('-', visible ? beforeText : jsonPhrase({ matchers: before.matchers, matcher_operator: before.matcher_operator })),
        toLine('+', visible ? afterText : jsonPhrase({ matchers: after.matchers, matcher_operator: after.matcher_operator })),
      )
    }
  }
  lines.push(...fieldChangeLines(before, after, ['pipeline', 'matchers', 'matcher_operator'], ''))
  return lines
}

function entryChangeLines(before: EntryInfo, after: EntryInfo): ChangeLine[] {
  const lines = selectorConditions(before.selector) === selectorConditions(after.selector)
    ? []
    : conditionChangeLines(before.selector, after.selector)
  const routeBefore = entryRoute(before)
  const routeAfter = entryRoute(after)
  if (routeBefore.text !== routeAfter.text) lines.push(toLine('-', routeBefore), toLine('+', routeAfter))
  return lines
}

/** 其余字段逐个对比，用 JSON 写出来。 / Any other fields, compared one by one and written as JSON. */
function fieldChangeLines(before: ConfigObject, after: ConfigObject, known: readonly string[], prefix: Phrase | string): ChangeLine[] {
  const lines: ChangeLine[] = []
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !known.includes(key))
  for (const key of keys) {
    if (stable(before[key]) === stable(after[key])) continue
    const label = key === 'ecs' ? 'ECS' : key
    if (before[key] !== undefined) lines.push(toLine('-', join(prefix, `${label} `, jsonPhrase(before[key]))))
    if (after[key] !== undefined) lines.push(toLine('+', join(prefix, `${label} `, jsonPhrase(after[key]))))
  }
  return lines
}

function ruleLabel(rule: RuleConfig, index: number): Phrase {
  return rule.name ? phrase(rule.name, [rule.name]) : phrase(`规则 ${index + 1}`)
}

/** 与流程预览一致：规则名 · 条件 → 动作。 / As in the flow preview: rule name · condition → action. */
function ruleMain(rule: RuleConfig, index: number): Phrase {
  return join(
    ruleLabel(rule, index),
    ' · ',
    conditionPhrase(rule.matchers, rule.matcher_operator, 'request'),
    ' → ',
    actionsPhrase(rule.actions),
  )
}

function ruleSummary(rule: RuleConfig, index: number): Phrase {
  return hasResponseProcessing(rule) ? join(ruleMain(rule, index), ' · 含响应阶段') : ruleMain(rule, index)
}

/** 响应阶段，不带规则名，比较时不受改名影响。 / The response stage without the rule name, so a rename does not make it differ. */
function ruleResponse(rule: RuleConfig): Phrase | undefined {
  if (!hasResponseProcessing(rule)) return undefined
  return join(
    '响应条件 ',
    conditionPhrase(rule.response_matchers, rule.response_matcher_operator, 'response'),
    ' · 匹配成功 ',
    actionsPhrase(rule.response_actions_on_match),
    ' · 匹配失败 ',
    actionsPhrase(rule.response_actions_on_miss),
  )
}

function ruleChangeLines(before: RuleConfig, fromIndex: number, after: RuleConfig, toIndex: number): ChangeLine[] {
  const lines: ChangeLine[] = []
  const mainBefore = ruleMain(before, fromIndex)
  const mainAfter = ruleMain(after, toIndex)
  if (mainBefore.text !== mainAfter.text) lines.push(toLine('-', mainBefore), toLine('+', mainAfter))
  const responseBefore = ruleResponse(before)
  const responseAfter = ruleResponse(after)
  if (responseBefore?.text !== responseAfter?.text) {
    if (responseBefore) lines.push(toLine('-', join(ruleLabel(before, fromIndex), ' · ', responseBefore)))
    if (responseAfter) lines.push(toLine('+', join(ruleLabel(after, toIndex), ' · ', responseAfter)))
  }
  if (lines.length === 0) {
    // 摘要里看不出的改动（例如转发动作上的 ECS），逐个字段写出来。
    // Changes the summary does not show (such as ECS on a forward action) are written field by field.
    lines.push(...fieldChangeLines(before, after, ['name'], join(ruleLabel(after, toIndex), ' · ')))
  }
  return lines
}

/** 规则按名称对齐，改了名的在空隙里按位置配对。 / Rules align by name; renamed ones pair by position within a gap. */
function rulesChangeLines(before: RuleConfig[], after: RuleConfig[]): ChangeLine[] {
  const beforeContent = before.map((rule) => stable(omit(rule, 'name')))
  const afterContent = after.map((rule) => stable(omit(rule, 'name')))
  const pairing = pairSequences(before.map((rule) => rule.name), after.map((rule) => rule.name), {
    prefer: (from, to) => beforeContent[from] === afterContent[to],
  })
  const items: Array<{ order: number; lines: ChangeLine[] }> = []
  for (const pair of pairing.pairs) {
    const ruleBefore = before[pair.from]!
    const ruleAfter = after[pair.to]!
    const lines = stable(ruleBefore) === stable(ruleAfter) ? [] : ruleChangeLines(ruleBefore, pair.from, ruleAfter, pair.to)
    if (pair.moved) {
      lines.push(
        toLine('-', join(ruleLabel(ruleBefore, pair.from), ` · 第 ${pair.from + 1} 条`)),
        toLine('+', join(ruleLabel(ruleAfter, pair.to), ` · 第 ${pair.to + 1} 条`)),
      )
    }
    if (lines.length) items.push({ order: (pair.to + 1) * 2, lines })
  }
  const orders = removedOrders(pairing, before.length, (to) => to + 1)
  for (const from of pairing.removed) items.push({ order: orders.get(from) ?? 0, lines: [toLine('-', ruleSummary(before[from]!, from))] })
  for (const to of pairing.added) items.push({ order: (to + 1) * 2, lines: [toLine('+', ruleSummary(after[to]!, to))] })
  return items.sort((left, right) => left.order - right.order).flatMap((item) => item.lines)
}

function pipelineChangeLines(before: PipelineConfig, after: PipelineConfig): ChangeLine[] {
  const lines: ChangeLine[] = []
  if (before.id !== after.id) {
    lines.push(toLine('-', join('Pipeline ', phrase(before.id, [before.id]))), toLine('+', join('Pipeline ', phrase(after.id, [after.id]))))
  }
  lines.push(...fieldChangeLines(before, after, ['id', 'rules'], ''))
  lines.push(...rulesChangeLines(before.rules, after.rules))
  return lines
}

function pipelineContentLines(mark: '+' | '-', pipeline: PipelineConfig): ChangeLine[] {
  const lines: ChangeLine[] = []
  for (const [key, value] of Object.entries(pipeline)) {
    if (key !== 'id' && key !== 'rules') lines.push(toLine(mark, join(`${key === 'ecs' ? 'ECS' : key} `, jsonPhrase(value))))
  }
  pipeline.rules.forEach((rule, index) => lines.push(toLine(mark, ruleSummary(rule, index))))
  if (pipeline.rules.length === 0) lines.push(toLine(mark, phrase('空 Pipeline')))
  return lines
}

/**
 * 与批量导入预览一致：源 → 目标 · TTL。源域名已经在这一组的标题「映射 nas.home.arpa」里时，行从箭头写起，不复述；
 * 只有源域名本身改了（− 和 + 的源不同）才两行都写上源（审计第五轮 D1）。
 * As in the bulk-import preview: source → target · TTL. When the source is already in the group title 「映射 nas.home.arpa」 the line starts at
 * the arrow instead of restating it; only when the source itself changed (the − and + sources differ) do both lines carry it (audit round 5, D1).
 */
function mappingSummary(row: DomainMappingRow, withSource = false): Phrase {
  const source = row.source.trim()
  const target = row.target.trim()
  const ttl = Number.isFinite(row.ttl) ? formatDomainMappingTtl(row.ttl) : '未设置'
  const rest = join(phrase(target || '未设置', [target]), ` · ${ttl}`)
  return withSource ? join(phrase(source || '未设置', [source]), ' → ', rest) : join('→ ', rest)
}

function sameMapping(before: DomainMappingRow, after: DomainMappingRow): boolean {
  return before.source.trim() === after.source.trim() && before.target.trim() === after.target.trim() && Object.is(before.ttl, after.ttl)
}

const SETTING_FIELDS = new Map<string, SettingField>(SETTING_SECTIONS.flatMap((section) => section.fields.map((field) => [field.key, field] as const)))
const SETTING_ORDER = [...SETTING_FIELDS.keys()]
const ENTRY_AND_PIPELINE_KEYS = new Set(['settings', 'pipeline_select', 'pipelines'])

function valuePhrase(value: unknown): Phrase {
  if (value === null || value === undefined || value === '') return phrase('未设置')
  if (typeof value === 'boolean') return phrase(value ? '开启' : '关闭')
  if (typeof value === 'number') return phrase(String(value))
  if (typeof value === 'string') return phrase(value, [value])
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.length ? phrase(value.join('、'), value) : phrase('未设置')
  }
  return jsonPhrase(value)
}

function settingPhrase(key: string, value: unknown): Phrase {
  const label = SETTING_FIELDS.get(key)?.label
  return label ? join(`${label} `, valuePhrase(value)) : valuePhrase(value)
}

// ---------------------------------------------------------------------------------------------
// 汇总 / Putting it together

interface Draft extends ChangeGroup {
  order: number
  // 入口连同它独占的 Pipeline 一起列出时用的短行：只写到 Pipeline 的名字 / The short line used when an entry is listed with the Pipeline only it uses: up to the Pipeline's name
  brief?: ChangeLine[]
}

function analyze(fromInput: KixConfig, toInput: KixConfig): ChangeSet {
  const a = readSide(fromInput)
  const b = readSide(toInput)
  const before = a.config.pipelines
  const after = b.config.pipelines

  // 域名映射的 Pipeline 交给映射行去比；一边是映射、另一边成了普通 Pipeline 的（「降级」），两边都当普通的比，
  // 映射行、入口和 Pipeline 的改动合成一处。
  // Domain-mapping Pipelines are compared through their rows. One that is a mapping on one side and an
  // ordinary Pipeline on the other ("demoted") is compared as ordinary on both, and its rows, entry and
  // Pipeline changes count as one.
  const demoted = new Set<string>()
  for (const id of a.mappingIds) if (b.pipelineAt.has(id) && !b.mappingIds.has(id)) demoted.add(id)
  for (const id of b.mappingIds) if (a.pipelineAt.has(id) && !a.mappingIds.has(id)) demoted.add(id)
  const managed = (id: string): boolean => !demoted.has(id) && (a.mappingIds.has(id) || b.mappingIds.has(id))
  const demotedUnit = (id: string): string => `pipeline:${id}`

  const match = matchPipelines(a, b, managed)
  const fromTarget = (id: string): string => {
    const from = a.pipelineAt.get(id)
    if (from === undefined) return `?${id}`
    const to = match.fromMatch[from]
    return to === undefined ? `<${id}` : `=${after[to]!.id}`
  }
  const toTarget = (id: string): string => {
    const to = b.pipelineAt.get(id)
    if (to === undefined) return `?${id}`
    return match.toMatch[to] === undefined ? `>${id}` : `=${id}`
  }

  const pipelineLines = new Map<number, ChangeLine[]>()
  after.forEach((pipeline, to) => {
    const from = match.toMatch[to]
    if (from === undefined || managed(pipeline.id)) return
    const lines = pipelineChangeLines(before[from]!, pipeline)
    if (lines.length) pipelineLines.set(to, lines)
  })

  const drafts: Draft[] = []
  const usedKeys = new Set<string>()
  const uniqueKey = (key: string): string => {
    let candidate = key
    for (let suffix = 2; usedKeys.has(candidate); suffix += 1) candidate = `${key}#${suffix}`
    usedKeys.add(candidate)
    return candidate
  }

  // --- 入口 / Entries ---------------------------------------------------------------------
  const fromEntries = a.entries.filter((entry) => !demoted.has(entry.selector.pipeline))
  const toEntries = b.entries.filter((entry) => !demoted.has(entry.selector.pipeline))
  const fromTargets = fromEntries.map((entry) => fromTarget(entry.selector.pipeline))
  const toTargets = toEntries.map((entry) => toTarget(entry.selector.pipeline))
  const fromSignatures = fromEntries.map((entry, index) => `${fromTargets[index]}\n${selectorConditions(entry.selector)}`)
  const toSignatures = toEntries.map((entry, index) => `${toTargets[index]}\n${selectorConditions(entry.selector)}`)
  const sharedOwnTarget = (from: number, to: number): boolean => fromTargets[from] === toTargets[to]
    && fromTargets[from]!.startsWith('=')
    && ownsPipeline(a, fromEntries[from]!)
    && ownsPipeline(b, toEntries[to]!)
  const entryPairing = pairSequences(fromSignatures, toSignatures, {
    // 独占的 Pipeline 是入口的身份：同一个 Pipeline 两边都只被一个入口用，这两个入口就是同一个，哪怕改了条件又挪了位置。
    // An owned Pipeline is the entry's identity: when each side has exactly one entry using it, those
    // entries are the same one, even if its conditions changed and it moved.
    link: sharedOwnTarget,
    prefer: (from, to) => fromTargets[from] === toTargets[to],
  })
  const entryKeyFrom = new Map<EntryInfo, string>()
  const entryKeyTo = new Map<EntryInfo, string>()
  for (const pair of entryPairing.pairs) {
    const entryBefore = fromEntries[pair.from]!
    const entryAfter = toEntries[pair.to]!
    const pipelineAt = b.pipelineAt.get(entryAfter.selector.pipeline)
    // 入口和只有它在用的 Pipeline 是一件东西：Pipeline 改了，入口就算改了。
    // An entry and the Pipeline only it uses are one thing: when that Pipeline changed, the entry changed.
    const ownPipelineChanged = sharedOwnTarget(pair.from, pair.to) && pipelineAt !== undefined && pipelineLines.has(pipelineAt)
    const same = fromSignatures[pair.from] === toSignatures[pair.to]
    if (same && !ownPipelineChanged && !pair.moved) continue
    const key = uniqueKey(`entry:${entryAfter.number}`)
    entryKeyFrom.set(entryBefore, key)
    entryKeyTo.set(entryAfter, key)
    const kind: ChangeKind = same && !ownPipelineChanged ? 'moved' : 'changed'
    drafts.push({
      key,
      unit: key,
      subject: 'entry',
      kind,
      title: `入口 ${pad(entryAfter.number)}`,
      afterIndex: entryAfter.index,
      ...(pair.moved ? { from: entryBefore.number, to: entryAfter.number } : {}),
      lines: kind === 'moved' ? [] : entryChangeLines(entryBefore, entryAfter),
      order: entryAfter.number * 2,
    })
  }
  const removedEntryOrders = removedOrders(entryPairing, fromEntries.length, (to) => toEntries[to]!.number)
  for (const from of entryPairing.removed) {
    const entry = fromEntries[from]!
    const key = uniqueKey(`entry:removed:${entry.number}`)
    entryKeyFrom.set(entry, key)
    drafts.push({ key, unit: key, subject: 'entry', kind: 'removed', title: `入口 ${pad(entry.number)}`, lines: [toLine('-', entrySummary(entry))], brief: [toLine('-', entryBrief(entry))], order: removedEntryOrders.get(from) ?? 0 })
  }
  for (const to of entryPairing.added) {
    const entry = toEntries[to]!
    const key = uniqueKey(`entry:${entry.number}`)
    entryKeyTo.set(entry, key)
    drafts.push({ key, unit: key, subject: 'entry', kind: 'added', title: `入口 ${pad(entry.number)}`, afterIndex: entry.index, lines: [toLine('+', entrySummary(entry))], brief: [toLine('+', entryBrief(entry))], order: entry.number * 2 })
  }
  for (const entry of a.entries.filter((item) => demoted.has(item.selector.pipeline))) {
    const key = uniqueKey(`entry:removed:${entry.number}`)
    drafts.push({ key, unit: demotedUnit(entry.selector.pipeline), subject: 'entry', kind: 'removed', title: `入口 ${pad(entry.number)}`, lines: [toLine('-', entrySummary(entry))], order: entry.number * 2 - 1 })
  }
  for (const entry of b.entries.filter((item) => demoted.has(item.selector.pipeline))) {
    const key = uniqueKey(`entry:${entry.number}`)
    drafts.push({ key, unit: demotedUnit(entry.selector.pipeline), subject: 'entry', kind: 'added', title: `入口 ${pad(entry.number)}`, afterIndex: entry.index, lines: [toLine('+', entrySummary(entry))], order: entry.number * 2 })
  }

  // --- 域名映射 / Domain mappings ------------------------------------------------------------
  // 源域名和目标域名都空着的行（刚点「添加映射」）不算改动。 / A row with neither source nor target (just added) is not a change.
  const fromRows = a.rows.filter((item) => !isEmptyRow(item.row) && !demoted.has(item.pipelineId))
  const toRows = b.rows.filter((item) => !isEmptyRow(item.row) && !demoted.has(item.pipelineId))
  const rowPairing = pairSequences(fromRows.map((item) => normalizeDomain(item.row.source)), toRows.map((item) => normalizeDomain(item.row.source)), {
    prefer: (from, to) => normalizeDomain(fromRows[from]!.row.target) === normalizeDomain(toRows[to]!.row.target),
  })
  const mappingTitle = (row: DomainMappingRow): string => `映射 ${row.source.trim() || '未设置'}`
  for (const pair of rowPairing.pairs) {
    const rowBefore = fromRows[pair.from]!
    const rowAfter = toRows[pair.to]!
    const same = sameMapping(rowBefore.row, rowAfter.row)
    if (same && !pair.moved) continue
    const key = uniqueKey(`mapping:${normalizeDomain(rowAfter.row.source)}`)
    drafts.push({
      key,
      unit: key,
      subject: 'mapping',
      kind: same ? 'moved' : 'changed',
      title: mappingTitle(rowAfter.row),
      afterIndex: rowAfter.index,
      ...(pair.moved ? { from: rowBefore.index + 1, to: rowAfter.index + 1 } : {}),
      lines: same ? [] : (() => {
        // 和 sameMapping 一样按写出来的字比：只改了大小写或结尾的根点，两行也要写出源域名，不然 − 和 + 一模一样（审计第六轮 C3）
        // Compared as written, like sameMapping: a source changed only in case or by a root dot still shows in both lines, or − and + would read the same (audit round 6, C3)
        const renamed = rowBefore.row.source.trim() !== rowAfter.row.source.trim()
        return [toLine('-', mappingSummary(rowBefore.row, renamed)), toLine('+', mappingSummary(rowAfter.row, renamed))]
      })(),
      order: (rowAfter.index + 1) * 2,
    })
  }
  const removedRowOrders = removedOrders(rowPairing, fromRows.length, (to) => toRows[to]!.index + 1)
  for (const from of rowPairing.removed) {
    const row = fromRows[from]!.row
    const key = uniqueKey(`mapping:${normalizeDomain(row.source)}`)
    drafts.push({ key, unit: key, subject: 'mapping', kind: 'removed', title: mappingTitle(row), lines: [toLine('-', mappingSummary(row))], order: removedRowOrders.get(from) ?? 0 })
  }
  for (const to of rowPairing.added) {
    const item = toRows[to]!
    const key = uniqueKey(`mapping:${normalizeDomain(item.row.source)}`)
    drafts.push({ key, unit: key, subject: 'mapping', kind: 'added', title: mappingTitle(item.row), afterIndex: item.index, lines: [toLine('+', mappingSummary(item.row))], order: (item.index + 1) * 2 })
  }
  for (const item of a.rows.filter((row) => !isEmptyRow(row.row) && demoted.has(row.pipelineId))) {
    const key = uniqueKey(`mapping:${normalizeDomain(item.row.source)}`)
    drafts.push({ key, unit: demotedUnit(item.pipelineId), subject: 'mapping', kind: 'removed', title: mappingTitle(item.row), lines: [toLine('-', mappingSummary(item.row))], order: item.index * 2 + 1 })
  }
  for (const item of b.rows.filter((row) => !isEmptyRow(row.row) && demoted.has(row.pipelineId))) {
    const key = uniqueKey(`mapping:${normalizeDomain(item.row.source)}`)
    drafts.push({ key, unit: demotedUnit(item.pipelineId), subject: 'mapping', kind: 'added', title: mappingTitle(item.row), afterIndex: item.index, lines: [toLine('+', mappingSummary(item.row))], order: (item.index + 1) * 2 })
  }
  const mappingsChanged = drafts.some((draft) => draft.subject === 'mapping')

  // --- Pipeline ------------------------------------------------------------------------------
  const ownerFrom = new Map<string, EntryInfo>()
  const ownerTo = new Map<string, EntryInfo>()
  for (const entry of fromEntries) if (ownsPipeline(a, entry)) ownerFrom.set(entry.selector.pipeline, entry)
  for (const entry of toEntries) if (ownsPipeline(b, entry)) ownerTo.set(entry.selector.pipeline, entry)
  const pipelineUnit = (key: string, fromId: string | undefined, toId: string | undefined): string => {
    const id = toId ?? fromId!
    if (demoted.has(id)) return demotedUnit(id)
    const fromOwner = fromId === undefined ? undefined : ownerFrom.get(fromId)
    const toOwner = toId === undefined ? undefined : ownerTo.get(toId)
    const fromKey = fromOwner && entryKeyFrom.get(fromOwner)
    const toKey = toOwner && entryKeyTo.get(toOwner)
    if (fromId !== undefined && toId !== undefined) return fromKey && fromKey === toKey ? fromKey : key
    return fromKey || toKey || key
  }

  const positionOrder = pairSequences(
    before.map((_, from) => match.fromMatch[from] === undefined ? `<${from}` : `=${match.fromMatch[from]}`),
    after.map((_, to) => match.toMatch[to] === undefined ? `>${to}` : `=${to}`),
    { gaps: false },
  )
  const movedPipelines = new Set(positionOrder.pairs.filter((pair) => pair.moved).map((pair) => pair.to))
  after.forEach((pipeline, to) => {
    const from = match.toMatch[to]
    if (from === undefined) return
    const lines = pipelineLines.get(to)
    const moved = movedPipelines.has(to)
    if (!lines && !moved) return
    if (!lines && managed(pipeline.id)) {
      // 以前的面板改映射表时会把映射 Pipeline 放到末尾，这是改映射行的副作用，不另算一处；
      // 但它挪到或挪出第一位时要报：第一个 Pipeline 接住没命中任何入口的请求。
      // Older panels re-appended the mapping Pipeline on every table edit; that is a side effect of the row
      // edits, not a change of its own. Moving into or out of first place is still reported: the first
      // Pipeline takes every request no entry matched.
      if (mappingsChanged && from !== 0 && to !== 0) return
    }
    const key = uniqueKey(`pipeline:${pipeline.id}`)
    drafts.push({
      key,
      unit: lines ? pipelineUnit(key, before[from]!.id, pipeline.id) : key,
      subject: 'pipeline',
      kind: lines ? 'changed' : 'moved',
      title: `Pipeline ${pipeline.id}`,
      afterIndex: to,
      ...(moved ? { from: from + 1, to: to + 1 } : {}),
      lines: lines ?? [],
      order: (to + 1) * 2,
    })
  })
  const removedPipelineOrders = removedOrders(positionOrder, before.length, (to) => to + 1)
  before.forEach((pipeline, from) => {
    if (match.fromMatch[from] !== undefined || managed(pipeline.id)) return
    const key = uniqueKey(`pipeline:${pipeline.id}`)
    drafts.push({ key, unit: pipelineUnit(key, pipeline.id, undefined), subject: 'pipeline', kind: 'removed', title: `Pipeline ${pipeline.id}`, lines: pipelineContentLines('-', pipeline), order: removedPipelineOrders.get(from) ?? 0 })
  })
  after.forEach((pipeline, to) => {
    if (match.toMatch[to] !== undefined || managed(pipeline.id)) return
    const key = uniqueKey(`pipeline:${pipeline.id}`)
    drafts.push({ key, unit: pipelineUnit(key, undefined, pipeline.id), subject: 'pipeline', kind: 'added', title: `Pipeline ${pipeline.id}`, afterIndex: to, lines: pipelineContentLines('+', pipeline), order: (to + 1) * 2 })
  })

  // --- 设置与其余顶层字段 / Settings and other top-level fields --------------------------------
  const settingsBefore = a.config.settings
  const settingsAfter = b.config.settings
  const settingKeys = [...new Set([...SETTING_ORDER, ...Object.keys(settingsAfter), ...Object.keys(settingsBefore)])]
  settingKeys.forEach((name, order) => {
    const inBefore = Object.prototype.hasOwnProperty.call(settingsBefore, name)
    const inAfter = Object.prototype.hasOwnProperty.call(settingsAfter, name)
    if (!inBefore && !inAfter) return
    if (inBefore && inAfter && stable(settingsBefore[name]) === stable(settingsAfter[name])) return
    const key = uniqueKey(`setting:${name}`)
    drafts.push({
      key,
      unit: key,
      subject: 'setting',
      kind: !inBefore ? 'added' : !inAfter ? 'removed' : 'changed',
      title: `设置 ${name}`,
      lines: [
        ...(inBefore ? [toLine('-', settingPhrase(name, settingsBefore[name]))] : []),
        ...(inAfter ? [toLine('+', settingPhrase(name, settingsAfter[name]))] : []),
      ],
      order,
    })
  })
  const otherKeys = [...new Set([...Object.keys(b.config), ...Object.keys(a.config)])].filter((name) => !ENTRY_AND_PIPELINE_KEYS.has(name))
  otherKeys.forEach((name, order) => {
    const inBefore = Object.prototype.hasOwnProperty.call(a.config, name)
    const inAfter = Object.prototype.hasOwnProperty.call(b.config, name)
    if (inBefore && inAfter && stable(a.config[name]) === stable(b.config[name])) return
    const key = uniqueKey(`other:${name}`)
    drafts.push({
      key,
      unit: key,
      subject: 'other',
      kind: !inBefore ? 'added' : !inAfter ? 'removed' : 'changed',
      title: name,
      lines: [
        ...(inBefore ? [toLine('-', valuePhrase(a.config[name]))] : []),
        ...(inAfter ? [toLine('+', valuePhrase(b.config[name]))] : []),
      ],
      order,
    })
  })

  return { groups: arrange(drafts), count: new Set(drafts.map((draft) => draft.unit)).size }
}

/**
 * 顺序：域名映射、入口（只有它在用的 Pipeline 紧跟在后面）、其余 Pipeline、设置、其余字段。
 * Order: domain mappings, entries (each followed by the Pipeline only it uses), other Pipelines,
 * settings, other fields.
 */
function arrange(drafts: Draft[]): ChangeGroup[] {
  const bySubject = (subject: ChangeSubject): Draft[] => drafts
    .filter((draft) => draft.subject === subject)
    .sort((left, right) => left.order - right.order)
  const pipelines = bySubject('pipeline')
  // 入口连同它独占的 Pipeline 一起去掉或加上时，入口那一行只写到 Pipeline 的名字：动作在下面 Pipeline 的规则里，不说两遍（规范 4.3，审计第六轮 D4）
  // When an entry is removed or added together with the Pipeline only it uses, its line stops at the Pipeline's name: the action is in
  // that Pipeline's rules below and is not said twice (spec 4.3, audit round 6, D4)
  const ownPipelineUnits = new Set(pipelines.map((pipeline) => pipeline.unit))
  const entries = bySubject('entry').map((entry) => (entry.brief && ownPipelineUnits.has(entry.unit) ? { ...entry, lines: entry.brief } : entry))
  const entryKeys = new Set(entries.map((entry) => entry.key))
  const ordered = [
    ...bySubject('mapping'),
    ...entries.flatMap((entry) => [entry, ...pipelines.filter((pipeline) => pipeline.unit === entry.key)]),
    ...pipelines.filter((pipeline) => !entryKeys.has(pipeline.unit)),
    ...bySubject('setting'),
    ...bySubject('other'),
  ]
  return ordered.map(({ order: _order, brief: _brief, ...group }) => group)
}
