// JSON 写错时的位置和原因，用中文说；浏览器自带的英文报错（Expected double-quoted property name…）不进页面
// Where JSON is broken and why, said in Chinese; the browser's English parser message (Expected double-quoted property name…) never reaches the page
export interface JsonProblem { line: number; column: number; reason: string }

export function jsonSyntaxProblem(text: string): JsonProblem | null {
  try {
    JSON.parse(text)
    return null
  } catch (e) {
    const msg = String((e as Error).message)
    const pos = Number(/position (\d+)/.exec(msg)?.[1] ?? NaN)
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
