import { readonly, ref } from 'vue'

export interface ConfirmRequest {
  /** 标题就写要做的事，不写「确认操作」这种空话。 */
  title: string
  /** 会发生什么；尽量连「不会发生什么」一起说清楚——那往往才是对方真正担心的。 */
  body: string
  /** 主按钮写动词和数量（「删除 3 个版本」），不写「确定」——读者不必回头确认自己点的是哪一项。 */
  confirmLabel: string
  cancelLabel?: string
  /** 一份逐条列出的清单，让人看清到底动了哪些。 */
  items?: string[]
  /** 不可撤销时用红色主按钮；可回退的操作不该占用红色。 */
  destructive?: boolean
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (confirmed: boolean) => void
}

const pending = ref<PendingConfirm | null>(null)

/**
 * 替代 window.confirm 的确认框。
 *
 * 原生对话框有三个改不动的问题：按钮永远是「确定 / 取消」，所以读者必须回头去
 * 想自己刚点了什么；样式完全在设计体系之外；也没法逐条列出将要被改动的东西。
 *
 * The replacement for window.confirm. The native dialog has three problems that
 * cannot be fixed from here: its buttons are always "OK / Cancel", so the reader
 * has to recall what they just clicked; its appearance sits entirely outside the
 * design system; and it cannot list the things about to change.
 */
export function useConfirm() {
  return {
    pending: readonly(pending),
    ask(request: ConfirmRequest): Promise<boolean> {
      // 同一时刻只允许一个确认框。前一个还没答复时直接拒掉新的请求，
      // 而不是把它挤掉——挤掉会让前一个的调用方永远等不到答复。
      // Only one dialog at a time. A new request while one is unanswered is
      // refused rather than replacing it: replacing would leave the earlier
      // caller waiting on a promise that never settles.
      if (pending.value) return Promise.resolve(false)
      return new Promise<boolean>((resolve) => {
        pending.value = { ...request, resolve }
      })
    },
    settle(confirmed: boolean): void {
      const current = pending.value
      pending.value = null
      current?.resolve(confirmed)
    },
  }
}
