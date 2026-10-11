import { readonly, ref } from 'vue'

export interface ToastMessage {
  id: number
  kind: 'success' | 'error' | 'info'
  message: string
  /** 可撤销时提供；点了就执行它并收起这一条。 */
  undo?: () => void
}

/**
 * 成功 4.5 秒后自己消失；失败不自动消失。
 *
 * 一条没人看见就溜走的错误等于没报过——出错时用户的注意力往往还在刚才那个
 * 操作上，四秒钟根本来不及回到屏幕角落。成功则相反：它只是确认「刚才那下生效了」，
 * 留在屏幕上反而是噪音。
 *
 * A success clears itself after 4.5 seconds; a failure never does. An error
 * nobody saw is an error never reported — when something fails the user's
 * attention is usually still on the action they just took, and four seconds is
 * not enough to get back to the corner of the screen. A success is the
 * opposite: it only confirms that the last thing worked, and lingering is noise.
 */
const AUTO_DISMISS_MS: Record<ToastMessage['kind'], number | null> = {
  success: 4500,
  info: 4500,
  error: null,
}

/** 可撤销的那条停久一点：撤销窗口就是它显示的这段时间，太短等于没给。 */
const UNDOABLE_MS = 8000

/**
 * 同时最多三条。超出时挤掉最旧的**非错误**那条——错误不该被后来的成功顶掉，
 * 那正是它需要被看见的时候。
 *
 * At most three at once. Going over drops the oldest non-error message: an
 * error must not be pushed out by a later success, which is precisely when it
 * needs to be seen.
 */
const MAX_VISIBLE = 3

const messages = ref<ToastMessage[]>([])
let sequence = 0

function dismiss(id: number): void {
  messages.value = messages.value.filter((message) => message.id !== id)
}

function runUndo(id: number): void {
  const target = messages.value.find((message) => message.id === id)
  target?.undo?.()
  dismiss(id)
}

function push(message: string, kind: ToastMessage['kind'] = 'info', undo?: () => void): number {
  // 同一句提示已经开着：不叠第二条（连按两次保存、按钮和 Ctrl+S 各按一次） / The same message already showing: no second copy (save pressed twice, the button and Ctrl+S)
  const same = !undo ? messages.value.find((item) => item.message === message && item.kind === kind && !item.undo) : undefined
  if (same) return same.id
  const id = ++sequence
  messages.value.push({ id, kind, message, undo })

  while (messages.value.length > MAX_VISIBLE) {
    const evictable = messages.value.find((item) => item.kind !== 'error')
    // 三条全是错误时谁也不挤掉：宁可多显示一条，也不吞掉一条没人看过的错误。
    if (!evictable) break
    dismiss(evictable.id)
  }

  const timeout = undo ? UNDOABLE_MS : AUTO_DISMISS_MS[kind]
  // 用裸 setTimeout 而不是 window.setTimeout：这个模块不依赖 DOM，
  // 挂上 window 只会让它在浏览器之外无法直接测。
  // Bare setTimeout rather than window.setTimeout: this module needs no DOM,
  // and reaching for window only makes it untestable outside a browser.
  if (timeout !== null) setTimeout(() => dismiss(id), timeout)
  return id
}

/**
 * 收起所有还开着的撤销提示。撤销记住的是旧草稿里的对象，草稿整份换掉（保存、放弃、重新读取、导入）以后它们就指不到东西了，
 * 留着只会让人点了没反应。
 *
 * Clear every open undo message. An undo holds objects from the old draft; once the draft is replaced wholesale (save, discard,
 * reload, import) they point at nothing, and leaving them up only invites a click that does nothing.
 */
export function dismissUndoable(before = Number.POSITIVE_INFINITY): void {
  messages.value = messages.value.filter((message) => !message.undo || message.id >= before)
}

/**
 * 现在这一刻的记号：之后发出的提示 id 都不小于它。保存发出去时记一下，落地后只收起这之前的撤销（保存途中又改的，撤销还管用）
 * A mark for this moment: every message raised after it has an id at least this large. A save records it when it sends, and once it
 * lands clears only the undos from before (an edit made during the save keeps its undo, which still applies)
 */
export function toastMark(): number {
  return sequence + 1
}

export function useToast() {
  return {
    messages: readonly(messages),
    dismiss,
    runUndo,
    // 返回这一条的 id：发出提示的页面可以在它过时的时候自己收起（比如草稿已经保存）。
    // Returns the id so the page that raised a message can clear it once stale (a draft that has been saved).
    success: (message: string) => push(message, 'success'),
    error: (message: string) => push(message, 'error'),
    info: (message: string) => push(message, 'info'),
    /** 带撤销的提示：右侧是撤销而不是叉，因为真正的撤销窗口就是它显示的这段时间。 */
    undoable: (message: string, undo: () => void) => push(message, 'success', undo),
  }
}
