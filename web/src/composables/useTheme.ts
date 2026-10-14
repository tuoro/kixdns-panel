import { computed, ref } from 'vue'

// 外观：跟随系统（默认）、浅色、深色。记在本机，启动时就写到 <html data-theme>，页面还没画就定下来，不会先亮后暗。
// Appearance: follow the system (default), light or dark. Kept on this device and stamped on <html data-theme> at startup,
// before the first paint, so the page never flashes light before turning dark.
export type ThemeChoice = 'system' | 'light' | 'dark'
export const THEME_KEY = 'kixdns-panel.theme'
export const THEME_CHOICES: { value: ThemeChoice; label: string }[] = [{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]

function readChoice(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(THEME_KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch { return 'system' }
}
const choice = ref<ThemeChoice>(readChoice())
function stamp(value: ThemeChoice): void {
  const root = document.documentElement
  if (value === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', value)
  paintAddressBar(value)
}
// 手机浏览器地址栏的颜色：index.html 里两条 theme-color 按系统偏好各管一种。跟随系统时各自用回自己的颜色；选了浅色或深色，
// 两条都写成那一种，系统偏好和页面不一致时地址栏也和顶栏同色。颜色只写在 index.html 里，这里只是挪用
// The phone browser's address bar: index.html holds two theme-color tags, one per system preference. Following the system, each keeps its
// own colour; once light or dark is chosen both take that one, so the bar matches the header even against the system preference. The
// colours live only in index.html; this just moves them around
function paintAddressBar(value: ThemeChoice): void {
  const tags = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"][media]')]
  for (const tag of tags) tag.dataset.own ??= tag.content
  const own = (scheme: 'light' | 'dark') => tags.find((tag) => tag.media.includes(scheme))?.dataset.own
  for (const tag of tags) tag.content = (value === 'system' ? tag.dataset.own : own(value)) ?? tag.content
}
stamp(choice.value)

export function useTheme() {
  function set(value: ThemeChoice): void {
    choice.value = value
    stamp(value)
    try { if (value === 'system') window.localStorage.removeItem(THEME_KEY); else window.localStorage.setItem(THEME_KEY, value) } catch { /* 私密窗口等情况记不住，本次会话照样生效 / cannot be remembered (private window etc.); still applies for this session */ }
  }
  const label = computed(() => THEME_CHOICES.find((c) => c.value === choice.value)?.label ?? '跟随系统')
  return { choice, set, label }
}
