
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
    const { mockRequest } = await import('./mock')
    return mockRequest<T>(path, requestInit)
  }

  // fetch 自己失败（断网、面板在重启）时浏览器只给「Failed to fetch」「Load failed」，换成一句看得懂的话
  // When fetch itself fails (network down, the panel restarting) the browser only says "Failed to fetch" or "Load failed"; say it in words
  const response = await fetch(path, {
    ...requestInit,
    credentials: 'same-origin',
  }).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError('连不上面板：网络断开了，或者面板正在重启。稍后再试。', 0, 'network_unreachable')
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
    const fallback = [502, 503, 504].includes(response.status) ? `面板暂时没有响应（${response.status}），可能正在重启。稍后再试。` : `请求失败（${response.status}）`
    throw new ApiError(
      body.error?.message ?? fallback,
      response.status,
      body.error?.code ?? 'request_failed',
    )
  }
  return response.json() as Promise<T>
}

export function jsonBody(value: unknown): Pick<RequestInit, 'body'> {
  return { body: JSON.stringify(value) }
}
