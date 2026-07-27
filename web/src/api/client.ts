import { mockRequest } from './mock'

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
  if (demoMode) return mockRequest<T>(path, requestInit)

  const response = await fetch(path, {
    ...requestInit,
    credentials: 'same-origin',
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
    throw new ApiError(
      body.error?.message ?? `请求失败 (${response.status})`,
      response.status,
      body.error?.code ?? 'request_failed',
    )
  }
  return response.json() as Promise<T>
}

export function jsonBody(value: unknown): Pick<RequestInit, 'body'> {
  return { body: JSON.stringify(value) }
}
