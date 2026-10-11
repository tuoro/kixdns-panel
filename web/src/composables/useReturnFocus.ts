import { nextTick, onBeforeUnmount } from 'vue'

/**
 * 抽屉、弹层关上（卸下）后，焦点回到打开它的那个控件：Esc、点遮罩、× 关上时不再掉到页面开头。打开它的控件已经不在了（比如菜单项）就不管
 * When a drawer or dialog closes (unmounts), focus returns to the control that opened it, so Esc, a scrim tap or × no longer drop it to the page start.
 * If that control is gone (a menu item, say) nothing is done
 */
export function useReturnFocus(): void {
  const opener = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
  onBeforeUnmount(() => {
    void nextTick(() => {
      const lost = !document.activeElement || document.activeElement === document.body
      if (lost && opener?.isConnected) opener.focus()
    })
  })
}
