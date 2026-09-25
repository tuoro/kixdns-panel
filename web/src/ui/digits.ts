export interface DigitCell {
  char: string
  changed: boolean
}

/**
 * 按右对齐逐位比较两次显示的数字，标出变了的那几位。
 *
 * 数字刷新时只让变了的位弹入，没变的不动；右对齐是因为数字从个位开始变，
 * 位数增加时左边多出来的位一律算变了。第一次显示没有「上一次」，一位都不动。
 *
 * Compare two renderings of a number right-aligned and mark the positions
 * that changed. On refresh only the changed positions pop in; alignment is
 * from the right because numbers change from the units up, and positions
 * added on the left when the number grows all count as changed. The first
 * rendering has nothing to compare against, so nothing moves.
 */
export function diffDigits(previous: string | null, next: string): DigitCell[] {
  if (previous === null) return [...next].map((char) => ({ char, changed: false }))
  const before = [...previous]
  const after = [...next]
  const offset = before.length - after.length
  return after.map((char, index) => ({ char, changed: before[index + offset] !== char }))
}
