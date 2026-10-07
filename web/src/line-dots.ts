import type { Directive } from 'vue'

// 句子里的「·」：写在前一段末尾、用不换行空格贴住（不会出现在一行之首）；折行正好落在它后面时把它藏起来，
// 不会挂在上一行的末尾。藏用 visibility，不改排版，不会引起再一次折行。
// 用法：分隔点写成 <span data-line-dot>&nbsp;·</span>，外面的元素加 v-line-dots。
// A 「·」 inside a sentence: written at the end of the segment before it and held there by a no-break space, so it never
// starts a line; when a wrap falls right after it, it is hidden so it is not left at the end of the line above either.
// Hiding uses visibility, which leaves the layout alone and cannot cause another wrap.
// Usage: write the separator as <span data-line-dot>&nbsp;·</span> and put v-line-dots on an element around it.

// 这一行所在的块：最近的不是行内的祖先 / The line's block: the nearest ancestor that is not inline
function blockOf(element: Element): Element | null {
  let box = element.parentElement
  while (box) {
    const display = getComputedStyle(box).display
    if (!display.startsWith('inline') && display !== 'contents') return box
    box = box.parentElement
  }
  return null
}

// 一个节点第一处画出来的位置：文字取第一个非空白字，元素取第一个有大小的片段
// Where a node is first drawn: a text node's first non-space character, an element's first fragment with a size
function firstRect(node: Node): DOMRect | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? ''
    const start = text.search(/\S/)
    if (start < 0) return null
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + 1)
    return range.getClientRects()[0] ?? null
  }
  if (node instanceof Element) {
    for (const rect of node.getClientRects()) if (rect.width > 0 && rect.height > 0) return rect
  }
  return null
}

// 点后面紧接着的内容从哪儿开始画（不出这一行所在的块） / Where the content right after the dot starts, within the line's block
function nextRect(dot: Element, scope: Element): DOMRect | null {
  let node: Node | null = dot
  while (node && node !== scope) {
    for (let next = node.nextSibling; next; next = next.nextSibling) {
      const rect = firstRect(next)
      if (rect) return rect
    }
    node = node.parentNode
  }
  return null
}

export function markLineEndDots(root: Element): void {
  for (const dot of root.querySelectorAll<HTMLElement>('[data-line-dot]')) {
    if (!dot.getClientRects().length) continue
    const own = dot.getBoundingClientRect()
    const next = nextRect(dot, blockOf(dot) ?? root)
    // 后面没有东西，或者后面的内容从下一行开始：点在行尾 / Nothing follows, or what follows starts on a later line: the dot ends a line
    dot.toggleAttribute('data-line-end', !next || next.top >= own.top + own.height / 2)
  }
}

const observers = new WeakMap<HTMLElement, ResizeObserver>()

// 挂上时、组件更新后、所在的块变宽变窄时、字体加载完时各量一次
// Measured on mount, after each update, whenever the line's block resizes, and once the fonts load
export const vLineDots: Directive<HTMLElement> = {
  mounted(element) {
    const mark = () => markLineEndDots(element)
    const observer = new ResizeObserver(mark)
    observer.observe(blockOf(element) ?? element)
    observers.set(element, observer)
    mark()
    void document.fonts?.ready.then(mark)
  },
  updated(element) {
    markLineEndDots(element)
  },
  unmounted(element) {
    observers.get(element)?.disconnect()
    observers.delete(element)
  },
}
