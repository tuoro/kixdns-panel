import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, PANEL_UNREACHABLE_EVENT, SESSION_EXPIRED_EVENT, apiRequest, isPanelDown, jsonBody, setCsrfToken } from './client'

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

  it('登录凭据错误只保留错误提示，不广播会话失效', async () => {
    const eventTarget = new EventTarget()
    const expired = vi.fn()
    eventTarget.addEventListener(SESSION_EXPIRED_EVENT, expired)
    vi.stubGlobal('window', eventTarget)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '{"error":{"code":"invalid_credentials","message":"用户名或密码错误"}}',
      { status: 401, headers: { 'content-type': 'application/json' } },
    )))

    const error: unknown = await apiRequest('/api/v1/auth/login', {
      method: 'POST',
      ...jsonBody({ username: 'admin', password: 'wrong-password' }),
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 401,
      code: 'invalid_credentials',
      message: '用户名或密码错误',
    })
    expect(expired).not.toHaveBeenCalled()
  })

  it('面板没答话时广播连不上：断网、反向代理的 502–504', async () => {
    const eventTarget = new EventTarget()
    const unreachable = vi.fn()
    eventTarget.addEventListener(PANEL_UNREACHABLE_EVENT, unreachable)
    vi.stubGlobal('window', eventTarget)

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const offline: unknown = await apiRequest('/api/v1/overview').catch((caught: unknown) => caught)
    expect(offline).toMatchObject({ status: 0, code: 'network_unreachable' })
    expect(isPanelDown(offline)).toBe(true)

    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 })))
    const proxied: unknown = await apiRequest('/api/v1/overview').catch((caught: unknown) => caught)
    expect(proxied).toMatchObject({ status: 502, code: 'panel_unavailable' })
    expect(isPanelDown(proxied)).toBe(true)
    expect(unreachable).toHaveBeenCalledTimes(2)
  })

  it('面板自己答的 503 不算连不上', async () => {
    const eventTarget = new EventTarget()
    const unreachable = vi.fn()
    eventTarget.addEventListener(PANEL_UNREACHABLE_EVENT, unreachable)
    vi.stubGlobal('window', eventTarget)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '{"error":{"code":"kixdns_unavailable","message":"KixDNS 没有运行"}}',
      { status: 503, headers: { 'content-type': 'application/json' } },
    )))

    const error: unknown = await apiRequest('/api/v1/overview').catch((caught: unknown) => caught)
    expect(error).toMatchObject({ status: 503, code: 'kixdns_unavailable' })
    expect(isPanelDown(error)).toBe(false)
    expect(unreachable).not.toHaveBeenCalled()
  })
})
