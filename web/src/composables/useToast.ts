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

function push(message: string, kind: ToastMessage['kind'] = 'info', undo?: () => void): void {
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
}

export function useToast() {
  return {
    messages: readonly(messages),
    dismiss,
    runUndo,
    success: (message: string) => push(message, 'success'),
    error: (message: string) => push(message, 'error'),
    info: (message: string) => push(message, 'info'),
    /** 带撤销的提示：右侧是撤销而不是叉，因为真正的撤销窗口就是它显示的这段时间。 */
    undoable: (message: string, undo: () => void) => push(message, 'success', undo),
  }
}
