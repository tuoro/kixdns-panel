import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PANEL_UNREACHABLE_EVENT } from '../api/client'
import { RETRY_MS, startConnectionWatch, stopConnectionWatch, useConnection } from './useConnection'
import { useToast } from './useToast'

const session = () => new Response('{"user":{"username":"admin"},"csrf_token":"t"}', { status: 200, headers: { 'content-type': 'application/json' } })

let online = true
beforeEach(() => {
  vi.useFakeTimers()
  online = true
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('navigator', { get onLine() { return online } })
})
afterEach(() => {
  stopConnectionWatch()
  useToast().messages.value.forEach((message) => useToast().dismiss(message.id))
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('连不上面板的横幅', () => {
  it('请求连不上时挂出，下一次问会话接口答了话就收起并提示一句', async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => { throw new TypeError('Failed to fetch') })
    vi.stubGlobal('fetch', fetchMock)
    startConnectionWatch()
    const { down } = useConnection()
    window.dispatchEvent(new Event(PANEL_UNREACHABLE_EVENT))
    expect(down.value).toBe(true)

    await vi.advanceTimersByTimeAsync(RETRY_MS)
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/session', expect.anything())
    expect(down.value).toBe(true)

    fetchMock.mockImplementation(async () => session())
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    expect(down.value).toBe(false)
    expect(useToast().messages.value.map((message) => message.message)).toContain('已重新连上面板')
  })

  it('会话过期的 401 也是面板答了话，算连上', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"unauthorized","message":"会话已失效"}}', { status: 401, headers: { 'content-type': 'application/json' } })))
    startConnectionWatch()
    const { down, retry } = useConnection()
    window.dispatchEvent(new Event(PANEL_UNREACHABLE_EVENT))
    await retry()
    expect(down.value).toBe(false)
  })

  it('浏览器报断网时一直挂着，联网后再问一次', async () => {
    const fetchMock = vi.fn(async () => session())
    vi.stubGlobal('fetch', fetchMock)
    startConnectionWatch()
    const { down } = useConnection()
    online = false
    window.dispatchEvent(new Event('offline'))
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2)
    expect(down.value).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()

    online = true
    window.dispatchEvent(new Event('online'))
    await vi.runOnlyPendingTimersAsync()
    expect(down.value).toBe(false)
  })
})
