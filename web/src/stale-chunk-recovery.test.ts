import { describe, expect, it } from 'vitest'
import { STALE_CHUNK_RELOAD_KEY, createStaleChunkRecovery } from './stale-chunk-recovery'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

function setup(storage: () => Storage = memoryStorage) {
  const store = storage()
  let clock = 1_000_000
  const visits: string[] = []
  const recovery = createStaleChunkRecovery({
    storage: () => store,
    now: () => clock,
    navigate: (href) => visits.push(href),
  })
  return { recovery, visits, store, advance: (ms: number) => { clock += ms } }
}

describe('stale chunk recovery', () => {
  it('reloads once into the page the user was heading to', () => {
    const { recovery, visits } = setup()
    const error = new TypeError('Failed to fetch dynamically imported module: /assets/LogsView-old.js')
    recovery.markPreloadError(error)

    expect(recovery.handleRouterError(error, '/logs')).toBe(true)
    expect(visits).toEqual(['/logs'])
  })

  it('does not reload again while the previous reload is still recent', () => {
    // 重新加载之后仍然失败，说明不是旧页面的问题；再刷只会陷入死循环。
    // Still failing after a reload means the old page was not the cause, and
    // reloading again would only loop.
    const { recovery, visits, advance } = setup()
    const first = new TypeError('first')
    recovery.markPreloadError(first)
    recovery.handleRouterError(first, '/logs')

    advance(2_000)
    const second = new TypeError('second')
    recovery.markPreloadError(second)
    expect(recovery.handleRouterError(second, '/logs')).toBe(false)
    expect(visits).toEqual(['/logs'])
  })

  it('recovers again from a later update in the same tab', () => {
    const { recovery, visits, advance } = setup()
    const first = new TypeError('first')
    recovery.markPreloadError(first)
    recovery.handleRouterError(first, '/logs')

    advance(60 * 60 * 1000)
    const later = new TypeError('later')
    recovery.markPreloadError(later)
    expect(recovery.handleRouterError(later, '/config')).toBe(true)
    expect(visits).toEqual(['/logs', '/config'])
  })

  it('leaves other navigation errors alone', () => {
    // 守卫里的接口请求失败也会走到 router.onError，那种情况刷新无济于事。
    // A failed API call inside a guard also reaches router.onError, and a
    // reload would not help it.
    const { recovery, visits, store } = setup()
    expect(recovery.handleRouterError(new Error('network down'), '/logs')).toBe(false)
    expect(visits).toEqual([])
    expect(store.getItem(STALE_CHUNK_RELOAD_KEY)).toBeNull()
  })

  it('does not reload when it cannot remember having done so', () => {
    const { recovery, visits } = setup(() => {
      const broken = memoryStorage()
      broken.setItem = () => { throw new DOMException('blocked', 'SecurityError') }
      return broken
    })
    const error = new TypeError('stale')
    recovery.markPreloadError(error)
    expect(recovery.handleRouterError(error, '/logs')).toBe(false)
    expect(visits).toEqual([])
  })
})
