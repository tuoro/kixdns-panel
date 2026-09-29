// 骨架照上一次读完配置时列表的样子画：每一行的名字几行、下面的说明几行，连同列表的宽度一起记下（审计第五轮 B1）。
// 这只是这位访客自己的方便：读写都包在 try/catch 里；存不了、读不出、记录坏了或者宽度不一样，就按默认的样子画。
// The skeleton is drawn as the list looked after the last load: how many lines each row's name and detail took, recorded with the
// list's width (audit round 5, B1). A per-viewer convenience only: reads and writes sit in try/catch, and with no record, an
// unreadable or damaged one, or another width, the default shape is drawn.

export type RowShape = readonly [name: number, detail: number]

const KEY = 'kixdns:config-list-shape'
// 一屏工作台放得下的行数；再往下的行骨架不画 / The rows one workbench screen holds; the skeleton draws none below them
const MAX_ROWS = 6
const MAX_LINES = 4

function lineCount(element: Element | null): number {
  if (!(element instanceof HTMLElement)) return 1
  const line = parseFloat(getComputedStyle(element).lineHeight)
  return line > 0 ? Math.min(MAX_LINES, Math.max(1, Math.round(element.getBoundingClientRect().height / line))) : 1
}

export function rememberListShape(list: HTMLElement): void {
  const rows = [...list.querySelectorAll('.workbench-mapping-row, .workbench-entry')].slice(0, MAX_ROWS)
    .map((row): RowShape => [lineCount(row.querySelector('.workbench-entry-condition')), lineCount(row.querySelector('.workbench-entry-route'))])
  if (rows.length === 0) return
  try {
    localStorage.setItem(KEY, JSON.stringify({ width: Math.round(list.getBoundingClientRect().width), rows }))
  } catch {
    // 存不了就不记：下次按默认的样子画 / Nothing is recorded when storage refuses; the default shape is drawn next time
  }
}

export function readListShape(width: number): RowShape[] | undefined {
  try {
    const record: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (!record || typeof record !== 'object') return undefined
    const { width: recorded, rows } = record as { width?: unknown; rows?: unknown }
    if (recorded !== Math.round(width) || !Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS) return undefined
    const lines = (count: unknown) => Number.isInteger(count) && (count as number) >= 1 && (count as number) <= MAX_LINES
    return rows.every((row) => Array.isArray(row) && row.length === 2 && row.every(lines)) ? rows as RowShape[] : undefined
  } catch {
    return undefined
  }
}
