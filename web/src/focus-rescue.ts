// 焦点兜底：拿着焦点的东西被删掉、挪动或停用时，浏览器把焦点丢回 <body>，键盘用户就得从页头重新 Tab。这里只在焦点真的丢了时接住它：
// 按钮停用（做事期间）就等它恢复再回去；被挪动（列表上移下移）就回到它；弹层、保存条关掉回到进去之前的控件；被删掉就落到原地换上来的那一行、
// 下一行或上一行，再不行落到最近还在的那一块里第一个能聚焦的东西，最后才是页面标题。人自己点页面空白处时焦点也会回到 <body>，那时不去动它。
//
// A focus safety net: when whatever holds focus is removed, moved or disabled, the browser drops focus back to <body> and a keyboard user starts
// over from the header. This catches focus only when it was truly lost: a disabled button (busy) gets it back once enabled again; a moved one
// (a list row moved up or down) gets it back at once; a closed dialog or save bar returns it to where focus came from; a removed one hands it to
// the row re-rendered in its place, the next row or the previous one, else the first focusable thing in the nearest container still on the page,
// and only then the page heading. Clicking blank page space also sends focus to <body>; that is left alone.

// 只落在按钮和链接上：落进输入框的话，接着按的快捷键（? n /）会变成打字 / Land on buttons and links only: in a field, the next shortcut (? n /) would become typing
const LANDING = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]):not(input):not(textarea):not(select)'
// 焦点「进去又出来」的地方：弹层、提示条、保存条 / Places focus enters and leaves: dialogs, the toast stack, the save bar
const BOUNDARY = 'dialog, .toast-stack, .cfg__savebar'
const ROW = 'li, [data-rule], [data-rw], tr'

// 焦点在过的一个位置：元素本身、它的祖先、它那一行和前后两行（元素没了以后靠这些找落点）
// One place focus has been: the element, its ancestors, its row and the rows around it (what finds a landing once the element is gone)
interface Spot { element: HTMLElement; ancestors: HTMLElement[]; row: Element | null; next: Element | null; previous: Element | null }

let last: Spot | null = null
let waiting: HTMLElement | null = null
// 焦点是人自己按鼠标或手指放掉的（点了空白处），之后不再去接 / Focus was let go by the user's own press (blank space): do not catch it afterwards
let droppedByUser = false
let pressing = false
// 每次焦点从外面进到弹层、提示条或保存条，都记下是从哪进去的 / Each time focus enters a dialog, the toast stack or the save bar from outside, remember where it came from
const openers = new WeakMap<Element, Spot>()

const disabled = (element: HTMLElement) => element.matches(':disabled') || element.closest('[inert]') !== null
const shown = (element: HTMLElement) => element.getClientRects().length > 0
const usable = (element: HTMLElement) => element.isConnected && !disabled(element) && shown(element)
// 提示条永远算「出来了」：绝不落到另一条提示的「撤销」上（再按一次回车就又撤掉一处）
// The toast stack always counts as left: never land on another toast's 撤销 (one more Enter would silently undo another edit)
const stillOpen = (boundary: Element) => !boundary.matches('.toast-stack') && boundary.isConnected
  && (boundary instanceof HTMLDialogElement ? boundary.open : shown(boundary as HTMLElement))

function spotOf(element: HTMLElement): Spot {
  const ancestors: HTMLElement[] = []
  for (let node = element.parentElement; node; node = node.parentElement) ancestors.push(node)
  const row = element.closest(ROW)
  return { element, ancestors, row, next: row?.nextElementSibling ?? null, previous: row?.previousElementSibling ?? null }
}

function remember(element: HTMLElement): void {
  const boundary = element.closest(BOUNDARY)
  const fromOutside = boundary && !(last && (last.element === boundary || last.ancestors.includes(boundary as HTMLElement)))
  if (boundary && fromOutside) {
    if (last) openers.set(boundary, last)
    else openers.delete(boundary)
  }
  last = spotOf(element)
  waiting = null
  droppedByUser = false
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

// 同一个控件重画了一份（保存后重新读取，整个列表换成新的元素）：按无障碍名字找回来，只认页面上唯一的那一个
// The same control re-rendered (a save re-reads the config and the whole list gets new elements): find it again by its accessible name, only when unique
function twin(element: HTMLElement): HTMLElement | null {
  const label = element.getAttribute('aria-label')
  if (!label) return null
  const found = [...document.querySelectorAll<HTMLElement>(`${element.tagName}[aria-label="${CSS.escape(label)}"]`)]
  return found.length === 1 ? found[0]! : null
}

// 返回要落的地方；还在等一个停用的按钮时返回 'wait' / Returns where to land, or 'wait' while a disabled button is awaited
function landing(spot: Spot, depth = 0): HTMLElement | 'wait' | null {
  const boundary = spot.ancestors.find((node) => node.matches(BOUNDARY))
  if (boundary && !stillOpen(boundary)) {
    // 弹层、保存条已经关了，或者是提示条：回到进去之前的地方（输入框也行，那是人原来在的地方）；那个控件正在做事、暂时停用就等它；
    // 它也没了，就按它原来的位置找落点
    // The dialog or save bar has closed, or this is the toast stack: back to where focus came from (a field is fine, that is where the user was);
    // wait while that control is busy and disabled; if it is gone too, find a landing from where it was
    const opener = openers.get(boundary)
    if (!opener || depth > 3) return pageHeading()
    const element = opener.element.isConnected ? opener.element : twin(opener.element)
    if (element && shown(element)) {
      if (disabled(element)) { waiting = element; return 'wait' }
      return element
    }
    return landing(opener, depth + 1)
  }
  // 那一行没了：原地重画出来的那一行（比如编辑完换回显示），否则下一行，没有就上一行；行还在就交给下面按祖先找，落回这一行
  // The row is gone: the row re-rendered in its place (an edit form swapped back for the display), else the next row, else the previous;
  // a row still there is left to the ancestor walk below, which lands back in it
  if (spot.row && !spot.row.isConnected) {
    const inPlace = spot.previous?.isConnected ? spot.previous.nextElementSibling : spot.next?.isConnected ? spot.next.previousElementSibling : null
    const replaced = inPlace && inPlace !== spot.next && inPlace.matches(ROW) ? inPlace : null
    for (const row of [replaced, spot.next, spot.previous]) {
      if (row?.isConnected) { const target = firstLanding(row); if (target) return target }
    }
  }
  for (const node of spot.ancestors) {
    if (!node.isConnected || node === spot.element) continue
    // 还开着的弹层或保存条里丢的：留在里面，不落到弹层后面（那里不能聚焦，焦点会留在 <body>）
    // Lost inside a dialog or save bar still open: stay inside, never behind a modal (nothing there takes focus, so it would stay on <body>)
    if (node === boundary) return firstLanding(node) ?? pageHeading()
    if (node.matches('main, body, #app, .page, [role="dialog"]')) break
    const inside = firstLanding(node)
    if (inside) return inside
  }
  return pageHeading()
}

function check(): void {
  if (document.activeElement && document.activeElement !== document.body) { waiting = null; return }
  if (droppedByUser && !waiting) return
  const element = waiting ?? last?.element
  if (!element || !last) return
  if (usable(element)) {
    // 停用的按钮恢复了，或者元素被挪了个位置（人什么也没按）：焦点回去；挪动的跟着滚到看得见
    // A disabled button came back, or the element was moved (the user pressed nothing): focus returns; a moved one is scrolled into view
    const moved = !waiting
    waiting = null
    element.focus({ preventScroll: true })
    if (moved) element.scrollIntoView({ block: 'nearest' })
    return
  }
  if (element.isConnected && disabled(element) && shown(element)) { waiting = element; return }
  const target = landing(last)
  if (target === 'wait') return
  waiting = null
  if (target) {
    if (!target.matches(LANDING) && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
    // 落下去时 focusin 会把这里记成新的位置；记着丢的那个才知道是不是从弹层外面进来的，所以落稳之前不清
    // Landing fires focusin, which records the new place; it needs the lost one to tell whether focus came from outside a dialog, so keep it until then
    target.focus({ preventScroll: true })
  }
  if (document.activeElement !== target) last = null
}

let scheduled = false
function schedule(): void {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => { scheduled = false; check() })
}


export function startFocusRescue(): void {
  document.addEventListener('focusin', (event) => { if (event.target instanceof HTMLElement) remember(event.target) })
  // 鼠标或手指按着没松开时焦点丢了，是人自己点了空白处；点击触发的删除、挪动发生在松开以后，不算
  // Focus lost while a mouse button or finger is still down is the user clicking blank space; removals and moves a click causes happen after release
  for (const type of ['pointerdown', 'mousedown']) document.addEventListener(type, () => { pressing = true }, true)
  for (const type of ['pointerup', 'pointercancel', 'mouseup']) document.addEventListener(type, () => { pressing = false }, true)
  document.addEventListener('focusout', (event) => {
    if (event.relatedTarget !== null) return
    droppedByUser = pressing
    schedule()
  })
  new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'inert', 'open', 'hidden'] })
}
