import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRequest, jsonBody } from '../api/client'
import { useSession } from './useSession'

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CSRF 令牌', () => {
  // 另一个标签页登录会换掉两个 Cookie：这个标签页的读照样能用（服务端只认会话 Cookie），写要带上新的令牌，
  // 不能一直用登录那一刻记下的旧令牌，否则保存、退出都是 403，只有刷新（丢掉没存的草稿）才能好
  // A sign-in in another tab replaces both cookies: this tab's reads keep working (the server checks only the session
  // cookie), and its writes must carry the new token rather than the one noted at its own sign-in; otherwise saving and
  // signing out get 403 until a reload, which loses an unsaved draft
  it('另一个标签页重新登录以后，写请求带上新的令牌', async () => {
    const browser = { cookie: 'kixdns_csrf=first-tab' }
    vi.stubGlobal('document', browser)
    const sent: Array<string | null> = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/v1/auth/login') return json({ user: { id: 1, username: 'admin' }, csrf_token: 'first-tab', expires_at: 0 })
      sent.push(new Headers(init?.headers).get('x-csrf-token'))
      return json({ ok: true })
    }))

    await useSession().login('admin', 'a-secure-password')
    await apiRequest('/api/v1/cache/flush', { method: 'POST', ...jsonBody({}) })
    // 另一个标签页登录：浏览器里的 Cookie 换成了新会话的 / Another tab signs in: the browser now holds the new session's cookies
    browser.cookie = 'kixdns_csrf=second-tab'
    await apiRequest('/api/v1/cache/flush', { method: 'POST', ...jsonBody({}) })

    expect(sent).toEqual(['first-tab', 'second-tab'])
  })
})
