import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, SESSION_EXPIRED_EVENT, apiRequest, jsonBody, setCsrfToken } from './client'

afterEach(() => {
  setCsrfToken('')
  vi.unstubAllGlobals()
})

describe('API 客户端', () => {
  it('为写请求附加同源凭据、JSON 类型与 CSRF 令牌', async () => {
    setCsrfToken('csrf-token')
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(init?.credentials).toBe('same-origin')
      expect(headers.get('content-type')).toBe('application/json')
      expect(headers.get('x-csrf-token')).toBe('csrf-token')
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiRequest<{ ok: boolean }>('/api/v1/cache/flush', {
      method: 'POST',
      ...jsonBody({}),
    })).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('保留结构化错误并广播受保护接口的会话失效', async () => {
    const eventTarget = new EventTarget()
    const expired = vi.fn()
    eventTarget.addEventListener(SESSION_EXPIRED_EVENT, expired)
    vi.stubGlobal('window', eventTarget)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '{"error":{"code":"unauthorized","message":"会话已失效"}}',
      { status: 401, headers: { 'content-type': 'application/json' } },
    )))

    const error: unknown = await apiRequest('/api/v1/config').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 401,
      code: 'unauthorized',
      message: '会话已失效',
    })
    expect(expired).toHaveBeenCalledOnce()
  })
})
