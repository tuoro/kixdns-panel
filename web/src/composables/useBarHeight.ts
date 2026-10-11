import { onBeforeUnmount, watch, type Ref } from 'vue'

// 吸底的条（保存条、编辑页底栏）把自己的实际高度写到根元素的变量上，提示条按它抬高。
// 失败时保存条会变成两行，按固定高度算就会被提示条盖住原因和按钮。
// A bar docked at the bottom (the save bar, the editor footer) writes its real height to a variable on the root element, and toasts
// lift by it. A failed save bar grows to two lines; a fixed height would let toasts cover the reason and its buttons.
export function useBarHeight(el: Ref<HTMLElement | null>, name: string): void {
  const root = document.documentElement
  let observer: ResizeObserver | null = null
  const stop = () => { observer?.disconnect(); observer = null; root.style.removeProperty(name) }
  watch(el, (node) => {
    stop()
    if (!node || typeof ResizeObserver === 'undefined') return
    observer = new ResizeObserver(() => root.style.setProperty(name, `${Math.ceil(node.getBoundingClientRect().height)}px`))
    observer.observe(node)
  }, { immediate: true })
  onBeforeUnmount(stop)
}
