import { sameTypeAlternatives, summarizeAction, summarizeActions, summarizeMatcher, summarizeMatchers } from './summary'
import type { ActionConfig, MatcherConfig, MatcherScope, RuleConfig } from './types'

// 句子：正文加机器值（规范 1.5）。地址、ID、域名是机器值，界面上设成等宽，而且不从中间断开；
// 分类名（GeoSite cn）、国家代码、响应码、日志级别、协议名是词，用界面字。
// 入口的名字（入口那一句条件）是例外：一句话一种字体，不标机器值。
// 列表的路线行、检查器的规则句、流程视图、自由编辑的摘要和版本比较都从这里切分，同一个值在哪儿都长一个样。
//
// Sentences: body text plus machine values (spec 1.5). Addresses, IDs and domains are machine values, set in
// mono and never split in the middle; category names (GeoSite cn), country codes, response codes, log levels
// and protocol names are words in the UI font. An entry's name (its condition sentence) is the exception: one
// sentence, one font, no machine values. The list's route lines, the inspector's rule sentences, the flow view,
// 自由编辑's summaries and the version comparison all split here, so a value looks the same everywhere.

export interface Phrase {
  text: string
  /** [在 text 里的起点, 机器值] / [start in text, machine value] */
  marks: Array<[number, string]>
}

export interface PhraseSegment {
  text: string
  code: boolean
}

/**
 * 机器值总跟在空格、顿号或句首之后，不会从「GeoSite」「Pipeline」这类词中间开始。
 * A machine value always follows a space, an enumeration comma or the start, never the middle of a
 * word such as GeoSite or Pipeline.
 */
export function locate(text: string, value: string, offset: number): number {
  if (!value) return -1
  for (let at = text.indexOf(value, offset); at >= 0; at = text.indexOf(value, at + 1)) {
    if (at === 0 || !/[A-Za-z0-9]/.test(text[at - 1]!)) return at
  }
  return -1
}

/** 在 text 里依次找候选值，找到的记成机器值；找不到的跳过。 / Finds candidates in text in order; the ones found become machine values. */
export function phrase(text: string, candidates: readonly unknown[] = []): Phrase {
  const marks: Array<[number, string]> = []
  let offset = 0
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const value = candidate.trim()
    const at = locate(text, value, offset)
    if (at < 0) continue
    marks.push([at, value])
    offset = at + value.length
  }
  return { text, marks }
}

export function join(...parts: Array<Phrase | string>): Phrase {
  let text = ''
  const marks: Array<[number, string]> = []
  for (const part of parts) {
    if (typeof part === 'string') {
      text += part
      continue
    }
    for (const [start, value] of part.marks) marks.push([start + text.length, value])
    text += part.text
  }
  return { text, marks }
}

/** 把逐项的摘要放回整句摘要里定位，句子本身仍由 summary.ts 生成。 / Places per-item summaries inside the joined summary; the sentence itself still comes from summary.ts. */
export function placeParts(text: string, parts: Phrase[]): Phrase {
  const marks: Array<[number, string]> = []
  let offset = 0
  for (const part of parts) {
    const at = text.indexOf(part.text, offset)
    if (at < 0) continue
    for (const [start, value] of part.marks) marks.push([start + at, value])
    offset = at + part.text.length
  }
  return { text, marks }
}

/** 切成「正文 / 机器值」几段，给界面设字体。 / Cut into body and machine-value segments for the UI to set. */
export function phraseSegments(value: Phrase): PhraseSegment[] {
  const segments: PhraseSegment[] = []
  let offset = 0
  for (const [start, text] of value.marks) {
    if (start < offset || value.text.slice(start, start + text.length) !== text) continue
    if (start > offset) segments.push({ text: value.text.slice(offset, start), code: false })
    segments.push({ text, code: true })
    offset = start + text.length
  }
  if (offset < value.text.length) segments.push({ text: value.text.slice(offset), code: false })
  return segments
}

function listOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

// 条件里是地址、域名或标签名的值；分类名、国家代码、查询类型这些是词，不是机器值。
// Condition values that are addresses, domains or label names; category names, country codes and query types are words.
const MACHINE_MATCHERS = new Set([
  'listener_label',
  'domain_suffix',
  'domain_regex',
  'upstream_equals',
  'request_domain_suffix',
  'request_domain_regex',
])

export function matcherValues(matcher: MatcherConfig, scope: MatcherScope): unknown[] {
  const values: unknown[] = []
  if (MACHINE_MATCHERS.has(matcher.type)) values.push(...listOf(matcher.value))
  values.push(...listOf(matcher.cidr))
  // 认不出的条件类型，摘要里写的就是类型名本身。 / An unknown matcher type is summarised by its own name.
  if (summarizeMatcher(matcher, scope) === `${scope === 'response' ? '响应条件' : '请求条件'} ${matcher.type}`) values.push(matcher.type)
  return values
}

export function actionValues(action: ActionConfig): unknown[] {
  const values: unknown[] = [...listOf(action.ip), action.target, action.pipeline]
  if (typeof action.upstream === 'string') values.push(...action.upstream.split(','))
  if (summarizeAction(action) === `执行 ${action.type}`) values.push(action.type)
  return values
}

/**
 * 入口的名字：一句话一种字体（规范 1.5），但里面的每个值整块换行，category-ads-all 不会在连字符处拆成两行。
 * 界面用 PhraseText 的 mono=false 画：标出来的只是「不拆开」，不换字体。
 * An entry's name: one sentence, one font (spec 1.5), yet each value inside wraps whole, so category-ads-all never
 * splits at a hyphen. The UI draws it with PhraseText mono=false: the marks mean "keep together", not a font change.
 */
export function entryNamePhrase(matchers: MatcherConfig[], operator: string): Phrase {
  return placeParts(summarizeMatchers(matchers, operator, 'selector'), matchers.map((matcher) => phrase(summarizeMatcher(matcher, 'selector'), [
    ...listOf(matcher.value).map((value) => (typeof value === 'string' ? value.trim().replace(/^geosite:/i, '') : value)),
    ...listOf(matcher.cidr),
    ...listOf(matcher.country_codes),
  ])))
}

/** 条件那一句。入口的条件是入口的名字，不标机器值。 / The condition sentence. An entry's condition is its name and marks nothing. */
export function conditionPhrase(matchers: MatcherConfig[], operator: string, scope: MatcherScope): Phrase {
  const text = summarizeMatchers(matchers, operator, scope)
  if (scope === 'selector') return { text, marks: [] }
  // 并成一句的「A、B 或 C」：值是不是机器值看第一项 / A merged 「A、B 或 C」: whether the values are machine values follows the first item
  const alternatives = sameTypeAlternatives(matchers, operator, scope)
  if (alternatives) return matcherValues(matchers[0]!, scope).some((value) => typeof value === 'string' && value.trim() !== '') ? phrase(text, alternatives.values) : { text, marks: [] }
  return placeParts(text, matchers.map((matcher) => phrase(summarizeMatcher(matcher, scope), matcherValues(matcher, scope))))
}

export function actionsPhrase(actions: ActionConfig[]): Phrase {
  return placeParts(summarizeActions(actions), actions.map((action) => phrase(summarizeAction(action), actionValues(action))))
}

/** 一条规则写成一句：「条件，动作」。 / One rule as one sentence: condition, then actions. */
export function rulePhrase(rule: RuleConfig): Phrase {
  return join(conditionPhrase(rule.matchers, rule.matcher_operator, 'request'), '，', actionsPhrase(rule.actions))
}
