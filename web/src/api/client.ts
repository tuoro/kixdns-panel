
interface ErrorEnvelope {
  error?: {
    code?: string
    message?: string
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message)
  }
}

let csrfToken = ''
const demoMode = import.meta.env.VITE_DEMO_MODE === 'true'
export const SESSION_EXPIRED_EVENT = 'kixdns:session-expired'
// 面板没答话（断网、面板在重启、反向代理后面没人）时广播，外壳据此挂出重连横幅 / Broadcast when the panel did not answer (network down, panel restarting, nothing behind the reverse proxy); the shell shows the reconnect banner
export const PANEL_UNREACHABLE_EVENT = 'kixdns:panel-unreachable'
// 配置页写进了一个新版本（也包括离开配置页以后才落地的保存）：概览、诊断听到就重读，不和「版本 #N 已生效」对不上
// The config page wrote a new version (including a save that landed after leaving the page): the overview and diagnostics re-read on it, so they never contradict 「版本 #N 已生效」
export const CONFIG_WRITTEN_EVENT = 'kixdns:config-written'

const UNREACHABLE_MESSAGE = '连不上面板：网络断了，或者面板正在重启。稍后再试。'

function reportUnreachable(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PANEL_UNREACHABLE_EVENT))
}

/** 这个错误是不是「面板没答话」：面板自己答的错误（含它自己的 503）不算 / Whether the error means the panel did not answer; errors the panel itself returned (its own 503 included) do not count */
export function isPanelDown(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'network_unreachable' || error.code === 'panel_unavailable')
}

export function setCsrfToken(token: string): void {
  csrfToken = token
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET'
  const headers = new Headers(init.headers)
  if (init.body != null) headers.set('content-type', 'application/json')
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && csrfToken) {
    headers.set('x-csrf-token', csrfToken)
  }
  const requestInit = { ...init, method, headers }
  // 演示数据只在演示包里加载：生产包不带它，也不会执行它的顶层代码 / The demo backend loads only in the demo build: production neither ships nor runs its top-level code
  if (demoMode) {
    // kixdns:demo-panel-down：演示面板没答话，和真的 fetch 失败走同一条路（横幅、重试、连上后重读都能在演示里看到）
    // kixdns:demo-panel-down: the demo panel does not answer, taking the same path as a real fetch failure (banner, retry and the re-read after reconnecting all show in the demo)
    if (typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-panel-down') === 'true') {
      await new Promise((resolve) => setTimeout(resolve, 120))
      reportUnreachable()
      throw new ApiError(UNREACHABLE_MESSAGE, 0, 'network_unreachable')
    }
    const { mockRequest } = await import('./mock')
    // 和真的网络一样每次给一份新的数据：演示后端在原地改它的对象，原样交出去的话页面拿到的还是同一个引用，看不出变了，页头一直停在旧版本
    // A fresh copy every time, as over a real network: the demo backend mutates its objects in place, and handing them out as they are gives the page
    // the same reference again, which it cannot see has changed, so a header stayed on the old version
    const answer = await mockRequest<T>(path, requestInit)
    return answer === undefined ? answer : JSON.parse(JSON.stringify(answer)) as T
  }

  // fetch 自己失败（断网、面板在重启）时浏览器只给「Failed to fetch」「Load failed」，换成一句看得懂的话
  // When fetch itself fails (network down, the panel restarting) the browser only says "Failed to fetch" or "Load failed"; say it in words
  const response = await fetch(path, {
    ...requestInit,
    credentials: 'same-origin',
  }).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    reportUnreachable()
    throw new ApiError(UNREACHABLE_MESSAGE, 0, 'network_unreachable')
  })
  if (!response.ok) {
    if (
      response.status === 401
      && !['/api/v1/auth/login', '/api/v1/auth/session'].includes(path)
      && typeof window !== 'undefined'
    ) {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    }
    const body = await response.json().catch(() => ({})) as ErrorEnvelope
    // 没有 JSON 错误体的多半是前面的反向代理在答：面板没起来或正在重启 / No JSON error body usually means a reverse proxy answered: the panel is down or restarting
    const proxyAnswered = !body.error && [502, 503, 504].includes(response.status)
    if (proxyAnswered) reportUnreachable()
    const fallback = proxyAnswered ? `面板暂时没有响应（${response.status}），可能正在重启。稍后再试。` : `请求失败（${response.status}）`
    throw new ApiError(
      body.error?.message ?? fallback,
      response.status,
      body.error?.code ?? (proxyAnswered ? 'panel_unavailable' : 'request_failed'),
    )
  }
  return response.json() as Promise<T>
}

export function jsonBody(value: unknown): Pick<RequestInit, 'body'> {
  return { body: JSON.stringify(value) }
}
