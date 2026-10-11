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
let waiting: HTMLElement | null = null
const openers = new WeakMap<Element, HTMLElement>()

const disabled = (element: HTMLElement) => element.matches(':disabled') || element.closest('[inert]') !== null
const shown = (element: HTMLElement) => element.getClientRects().length > 0

function remember(element: HTMLElement): void {
  const dialog = element.closest('dialog')
  // 焦点从外面进到一个弹层：记下是谁打开的 / Focus moving into a dialog from outside: remember who opened it
  if (dialog && last && !dialog.contains(last) && !openers.has(dialog)) openers.set(dialog, last)
  last = element
  ancestors = []
  for (let node = element.parentElement; node; node = node.parentElement) ancestors.push(node)
  waiting = null
}

function pageHeading(): HTMLElement | null {
  const heading = document.querySelector<HTMLElement>('main h1')
  if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
  return heading
}

function landing(lost: HTMLElement): HTMLElement | null {
  const dialog = ancestors.find((node) => node.tagName === 'DIALOG')
  const opener = dialog ? openers.get(dialog) : undefined
  if (opener?.isConnected && !disabled(opener) && shown(opener)) return opener
  for (const node of ancestors) {
    if (!node.isConnected || node === lost) continue
    if (node.matches('main, body, .page, [role="dialog"]')) break
    const inside = [...node.querySelectorAll<HTMLElement>(LANDING)].find((element) => shown(element) && !disabled(element))
    if (inside) return inside
  }
  return pageHeading()
}

function check(): void {
  if (document.activeElement && document.activeElement !== document.body) { waiting = null; return }
  const element = waiting ?? last
  if (!element) return
  if (element.isConnected && !disabled(element) && shown(element)) {
    // 停用的按钮恢复了：焦点回去；没停用过的就是人自己点了空白处，不动 / A disabled button came back: focus returns; one never disabled means the user clicked blank space, so leave it
    if (waiting) { waiting = null; element.focus({ preventScroll: true }) }
    return
  }
  if (element.isConnected && disabled(element)) { waiting = element; return }
  waiting = null
  last = null
  landing(element)?.focus({ preventScroll: true })
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
