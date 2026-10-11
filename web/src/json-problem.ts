// JSON 写错时的位置和原因，用中文说；浏览器自带的英文报错（Expected double-quoted property name…）不进页面
// Where JSON is broken and why, said in Chinese; the browser's English parser message (Expected double-quoted property name…) never reaches the page
export interface JsonProblem { line: number; column: number; reason: string }

/**
 * 第一个写错的字符在哪：浏览器对「Unexpected token」一类错误不给位置，只能自己走一遍。按 JSON 的语法读，读不下去的地方就是答案
 * Where the first broken character is: browsers give no position for "Unexpected token" errors, so the text is walked here. It reads by JSON's grammar; where reading stops is the answer
 */
export function scanJsonError(text: string): number | null {
  let i = 0
  const space = () => { while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++ }
  const fail = (): never => { throw i }
  const literal = (word: string) => { if (text.startsWith(word, i)) i += word.length; else fail() }
  const string = () => {
    i++
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i += 2
      else if (text.charCodeAt(i) < 0x20) fail()
      else i++
    }
    if (i >= text.length) fail()
    i++
  }
  const number = () => {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i))
    if (!match) fail()
    i += match![0].length
  }
  const value = (): void => {
    space()
    const c = text[i]
    if (c === '{') {
      i++; space()
      if (text[i] === '}') { i++; return }
      for (;;) {
        space(); if (text[i] !== '"') fail(); string(); space()
        if (text[i] !== ':') fail(); i++; value(); space()
        if (text[i] === ',') { i++; continue }
        if (text[i] === '}') { i++; return }
        fail()
      }
    }
    if (c === '[') {
      i++; space()
      if (text[i] === ']') { i++; return }
      for (;;) {
        value(); space()
        if (text[i] === ',') { i++; continue }
        if (text[i] === ']') { i++; return }
        fail()
      }
    }
    if (c === '"') return string()
    if (c === 't') return literal('true')
    if (c === 'f') return literal('false')
    if (c === 'n') return literal('null')
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return number()
    fail()
  }
  try {
    value(); space()
    return i < text.length ? i : null
  } catch (at) {
    return typeof at === 'number' ? Math.min(at, text.length) : null
  }
}

export function jsonSyntaxProblem(text: string): JsonProblem | null {
  try {
    JSON.parse(text)
    return null
  } catch (e) {
    const msg = String((e as Error).message)
    const pos = Number(/position (\d+)/.exec(msg)?.[1] ?? scanJsonError(text) ?? NaN)
    const lc = /line (\d+) column (\d+)/.exec(msg)
    const at = Number.isNaN(pos) ? null : pos
    const before = at === null ? text : text.slice(0, at)
    const line = lc ? Number(lc[1]) : before.split('\n').length
    const column = lc ? Number(lc[2]) : before.length - before.lastIndexOf('\n')
    const rest = at === null ? '' : text.slice(at)
    const reason = /^\s*[}\]]/.test(rest) && /,\s*$/.test(before) ? '多余的逗号' : /^\s*[A-Za-z_]/.test(rest) && /[{,]\s*$/.test(before) ? '属性名要用双引号' : /end of JSON|Unexpected end/i.test(msg) ? 'JSON 不完整' : /Expected ',' or/i.test(msg) ? '少了逗号或右括号' : '这里多了一个字符'
    return { line, column, reason }
  }
}

/** 「第 3 行第 5 列 · 多余的逗号」 / 「第 3 行第 5 列 · 多余的逗号」 */
export const jsonProblemText = (problem: JsonProblem): string => `第 ${problem.line} 行第 ${problem.column} 列 · ${problem.reason}`
