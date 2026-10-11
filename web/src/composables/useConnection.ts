import { readonly, ref, watch } from 'vue'
import { PANEL_UNREACHABLE_EVENT, apiRequest, isPanelDown } from '../api/client'
import { useToast } from './useToast'

// 连不上面板时每 5 秒问一次会话接口，面板答了话（哪怕是会话过期）就算连上
// While the panel is unreachable the session endpoint is asked every 5 seconds; any answer from the panel (even an expired session) counts as reconnected
export const RETRY_MS = 5000

const down = ref(false)
const checking = ref(false)
// 刚打开页面就连不上：外壳还没挂上，横幅也就没有，由启动时的等待页说 / Unreachable right at start: the shell has not mounted and neither has the banner, so the boot wait page says it
const booting = ref(false)
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

/** 等到面板又答话；本来就连得上时立刻返回 / Resolves once the panel answers again; at once when it is reachable already */
export function untilReachable(): Promise<void> {
  if (!down.value) return Promise.resolve()
  return new Promise((resolve) => {
    const stop = watch(down, (now) => { if (!now) { stop(); resolve() } })
  })
}

/** 现在问一次面板：答了话（哪怕是会话过期）就是连得上；没答话会挂出横幅 / Ask the panel once now: any answer (even an expired session) means reachable; no answer raises the banner */
export async function probePanel(): Promise<boolean> {
  try {
    await apiRequest('/api/v1/auth/session')
    return true
  } catch (error) {
    if (!isPanelDown(error)) return true
    markDown()
    return false
  }
}

/** 启动时的会话读取：面板没答话就等它回来再读，期间页面写「连不上面板」 / The session read at start: when the panel does not answer, wait for it and read again, the page saying 连不上面板 meanwhile */
export async function whenPanelAnswers<T>(read: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      const value = await read()
      booting.value = false
      return value
    } catch (error) {
      if (!isPanelDown(error)) { booting.value = false; throw error }
      booting.value = true
      markDown()
      await untilReachable()
    }
  }
}

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

// 重试：浏览器自己报断网时请求注定失败，说一句再等联网 / Retry: while the browser itself reports offline a request would fail anyway, so say so and wait for the network
function retry(): Promise<void> {
  if (!browserOnline()) {
    useToast().info('浏览器显示没有联网，联网后会自动重连')
    return Promise.resolve()
  }
  return check()
}

export function useConnection() {
  return { down: readonly(down), checking: readonly(checking), booting: readonly(booting), retry }
}
