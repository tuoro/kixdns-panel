import { onBeforeUnmount, ref, type Ref } from 'vue'

// 手机宽度（≤640，和组件库的断点一样）：只用来换更短的占位文字，布局都在 CSS 里
// Phone width (≤640, the kit's breakpoint): only for shorter placeholder text; layout stays in CSS
export function usePhone(): Ref<boolean> {
  const query = window.matchMedia('(max-width: 640px)')
  const phone = ref(query.matches)
  const update = (): void => { phone.value = query.matches }
  query.addEventListener('change', update)
  onBeforeUnmount(() => query.removeEventListener('change', update))
  return phone
}

// 侧栏收起（≤860，底部有页签栏）：配置的分区不在侧栏里了，页面自己要给出分区页签 / The sidebar folded away (≤860, the bottom tab bar shows): config sections are no longer in the sidebar, so the page shows its own section tabs
export function useCompact(): Ref<boolean> {
  const query = window.matchMedia('(max-width: 860px)')
  const compact = ref(query.matches)
  const update = (): void => { compact.value = query.matches }
  query.addEventListener('change', update)
  onBeforeUnmount(() => query.removeEventListener('change', update))
  return compact
}

// 1280 以下（含 1024 一档）：输入框窄，占位字换短的，免得被截在半个字上 / Below 1280 (the 1024 step included): inputs are narrow, so placeholders take their short form instead of being cut mid-character
export function useNarrow(): Ref<boolean> {
  const query = window.matchMedia('(max-width: 1279px)')
  const narrow = ref(query.matches)
  const update = (): void => { narrow.value = query.matches }
  query.addEventListener('change', update)
  onBeforeUnmount(() => query.removeEventListener('change', update))
  return narrow
}

// 宽屏（≥1360）：列表要留够六列（名字至少 150）加 27rem 的面板，再窄就回到整页编辑 / Wide screens (≥1360): the list needs its six columns (a name of at least 150) beside a 27rem inspector; narrower goes back to the full-page editor
export function useWide(): Ref<boolean> {
  const query = window.matchMedia('(min-width: 1360px)')
  const wide = ref(query.matches)
  const update = (): void => { wide.value = query.matches }
  query.addEventListener('change', update)
  onBeforeUnmount(() => query.removeEventListener('change', update))
  return wide
}
