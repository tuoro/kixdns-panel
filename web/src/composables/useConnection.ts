import { readonly, ref } from 'vue'
import { PANEL_UNREACHABLE_EVENT, apiRequest, isPanelDown } from '../api/client'
import { useToast } from './useToast'

// 连不上面板时每 5 秒问一次会话接口，面板答了话（哪怕是会话过期）就算连上
// While the panel is unreachable the session endpoint is asked every 5 seconds; any answer from the panel (even an expired session) counts as reconnected
export const RETRY_MS = 5000

const down = ref(false)
const checking = ref(false)
let timer: ReturnType<typeof setInterval> | undefined

// 浏览器自己知道断网时，不靠请求结果收起横幅 / While the browser itself reports offline, no request result takes the banner down
const browserOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false

function markDown(): void {
  down.value = true
  timer ??= setInterval(() => void check(), RETRY_MS)
}

function markUp(): void {
  if (timer !== undefined) clearInterval(timer)
  timer = undefined
  if (!down.value) return
  down.value = false
  useToast().success('已重新连上面板')
}

async function check(): Promise<void> {
  if (checking.value || !browserOnline()) return
  checking.value = true
  try {
    await apiRequest('/api/v1/auth/session')
    markUp()
  } catch (error) {
    if (!isPanelDown(error)) markUp()
  } finally {
    checking.value = false
  }
}

const onOnline = () => void check()

/** 外壳挂上时开始听，卸下时停 / Starts listening when the shell mounts, stops when it unmounts */
export function startConnectionWatch(): void {
  window.addEventListener(PANEL_UNREACHABLE_EVENT, markDown)
  window.addEventListener('offline', markDown)
  window.addEventListener('online', onOnline)
  if (!browserOnline()) markDown()
}

export function stopConnectionWatch(): void {
  window.removeEventListener(PANEL_UNREACHABLE_EVENT, markDown)
  window.removeEventListener('offline', markDown)
  window.removeEventListener('online', onOnline)
  if (timer !== undefined) clearInterval(timer)
  timer = undefined
  down.value = false
}

export function useConnection() {
  return { down: readonly(down), checking: readonly(checking), retry: check }
}
