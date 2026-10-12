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

// 侧栏版里最窄的一档（861–1023）：输入框窄，换更短的占位文字 / The narrowest sidebar band (861–1023): inputs are narrow, so placeholders get shorter
export function useNarrowDesktop(): Ref<boolean> {
  const query = window.matchMedia('(min-width: 861px) and (max-width: 1023px)')
  const narrow = ref(query.matches)
  const update = (): void => { narrow.value = query.matches }
  query.addEventListener('change', update)
  onBeforeUnmount(() => query.removeEventListener('change', update))
  return narrow
}

// 保存条一行放不下「校验通过 · 可以保存」的宽度（手机，和侧栏版最窄的 861–909），只写「校验通过」，「保存并应用」不被挤出屏幕；641–860 的保存条状态独占一行，放得下
// Widths where the one-row save bar cannot fit 校验通过 · 可以保存 (phones, and the narrowest sidebar band 861–909): it says just 校验通过, so 保存并应用 stays on screen; at 641–860 the status has its own row and fits
export function useTightSaveBar(): Ref<boolean> {
  const query = window.matchMedia('(max-width: 640px), (min-width: 861px) and (max-width: 909px)')
  const tight = ref(query.matches)
  const update = (): void => { tight.value = query.matches }
  query.addEventListener('change', update)
  onBeforeUnmount(() => query.removeEventListener('change', update))
  return tight
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
