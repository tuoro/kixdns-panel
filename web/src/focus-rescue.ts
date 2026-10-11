// 焦点兜底：拿着焦点的东西被删掉或停用时，浏览器把焦点丢回 <body>，键盘用户就得从页头重新 Tab。这里只在焦点真的丢了时接住它：
// 按钮停用（做事期间）就等它恢复再回去；弹层关掉回到打开它的控件；被删掉就落到最近还在的那一块里第一个能聚焦的东西，找不到就落到页面标题。
// 人自己点页面空白处时焦点也会回到 <body>，那时原来的元素还在、可用，不去动它。
//
// A focus safety net: when whatever holds focus is removed or disabled, the browser drops focus back to <body> and a keyboard user starts over
// from the header. This catches focus only when it was truly lost: a disabled button (busy) gets it back once enabled again; a closed dialog returns
// it to the control that opened it; a removed element hands it to the first focusable thing in the nearest container still on the page, else the
// page heading. Clicking blank page space also sends focus to <body>, but the element is still there and enabled, so it is left alone.

// 只落在按钮和链接上：落进输入框的话，接着按的快捷键（? n /）会变成打字 / Land on buttons and links only: in a field, the next shortcut (? n /) would become typing
const LANDING = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]):not(input):not(textarea):not(select)'

let last: HTMLElement | null = null
let ancestors: HTMLElement[] = []
// 这个元素所在的那一行前后两行：删掉一行后落到下一行，没有就上一行 / The rows before and after this element's row: a deleted row hands focus to the next, else the previous
let rowNeighbours: { next: Element | null; previous: Element | null } = { next: null, previous: null }
let waiting: HTMLElement | null = null
// 弹层和提示条都是「进去又出来」的地方：记下焦点是从哪进去的 / Dialogs and the toast stack are places focus enters and leaves: remember where it came from
const openers = new WeakMap<Element, HTMLElement>()
const BOUNDARY = 'dialog, .toast-stack'
const ROW = 'li, [data-rule], [data-rw], tr'

const disabled = (element: HTMLElement) => element.matches(':disabled') || element.closest('[inert]') !== null
const shown = (element: HTMLElement) => element.getClientRects().length > 0
const usable = (element: HTMLElement) => element.isConnected && !disabled(element) && shown(element)

function remember(element: HTMLElement): void {
  const boundary = element.closest(BOUNDARY)
  // 焦点从外面进到弹层或提示条：记下是谁 / Focus moving into a dialog or the toast stack from outside: remember who
  if (boundary && last && !boundary.contains(last) && !openers.has(boundary)) openers.set(boundary, last)
  last = element
  ancestors = []
  for (let node = element.parentElement; node; node = node.parentElement) ancestors.push(node)
  const row = element.closest(ROW)
  rowNeighbours = { next: row?.nextElementSibling ?? null, previous: row?.previousElementSibling ?? null }
  waiting = null
}

function pageHeading(): HTMLElement | null {
  const heading = document.querySelector<HTMLElement>('main h1')
  if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
  return heading
}

const firstLanding = (node: Element) => {
  const marked = node.querySelector<HTMLElement>('[data-focus-landing]')
  if (marked && marked.isConnected && shown(marked)) return marked
  return [...node.querySelectorAll<HTMLElement>(LANDING)].find((element) => shown(element) && !disabled(element)) ?? null
}

// 返回要落的地方；还在等一个停用的按钮时返回 'wait' / Returns where to land, or 'wait' while a disabled button is awaited
function landing(lost: HTMLElement): HTMLElement | 'wait' | null {
  const boundary = ancestors.find((node) => node.matches(BOUNDARY))
  if (boundary) {
    // 从弹层或提示条里丢的：回到进去之前的地方（输入框也行，那是人原来在的地方）；那个控件正在做事、暂时停用就等它；都不行就落到页面标题，
    // 绝不落进提示条里（下一条的「撤销」再按一次就又撤掉一处）
    // Lost inside a dialog or the toast stack: back to where focus came from (a field is fine, that is where the user was); wait while that control is
    // busy and disabled; otherwise the page heading, never another toast (pressing the next 撤销 would silently undo another edit)
    const opener = openers.get(boundary)
    if (opener?.isConnected && disabled(opener) && shown(opener)) { waiting = opener; return 'wait' }
    if (opener?.isConnected && shown(opener)) return opener
    return pageHeading()
  }
  // 删掉的是列表里的一行：下一行，没有就上一行 / A list row went away: the next row, else the previous
  for (const row of [rowNeighbours.next, rowNeighbours.previous]) {
    if (row?.isConnected) { const target = firstLanding(row); if (target) return target }
  }
  for (const node of ancestors) {
    if (!node.isConnected || node === lost) continue
    if (node.matches('main, body, #app, .page, [role="dialog"]')) break
    const inside = firstLanding(node)
    if (inside) return inside
  }
  return pageHeading()
}

function check(): void {
  if (document.activeElement && document.activeElement !== document.body) { waiting = null; return }
  const element = waiting ?? last
  if (!element) return
  if (usable(element)) {
    // 停用的按钮恢复了：焦点回去；没停用过的就是人自己点了空白处，不动 / A disabled button came back: focus returns; one never disabled means the user clicked blank space, so leave it
    if (waiting) { waiting = null; element.focus({ preventScroll: true }) }
    return
  }
  if (element.isConnected && disabled(element)) { waiting = element; return }
  const target = landing(element)
  if (target === 'wait') return
  waiting = null
  last = null
  if (target) {
    if (!target.matches(LANDING) && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
    target.focus({ preventScroll: true })
  }
}

let scheduled = false
function schedule(): void {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => { scheduled = false; check() })
}

export function startFocusRescue(): void {
  document.addEventListener('focusin', (event) => { if (event.target instanceof HTMLElement) remember(event.target) })
  new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'inert', 'open', 'hidden'] })
}
