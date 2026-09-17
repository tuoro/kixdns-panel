/**
 * 面板更新后，开着的旧标签页切换页面时加载不到分块，自动重新加载一次。
 *
 * 安装脚本会整目录换掉前端文件，旧版本带哈希的分块随之删除。一个在更新前打开的
 * 标签页仍然持有旧的 index.html，下一次懒加载路由时去取已经不存在的文件，导航
 * 就此失败、页面停在原地没有任何说明。重新加载一次就能拿到新的 index.html。
 *
 * After a panel update, an old tab that fails to load a chunk on its next route
 * change reloads itself once. The installer swaps the whole web directory and
 * the old hashed chunks are deleted with it. A tab opened before the update
 * still holds the old index.html, so its next lazy route fetches a file that is
 * gone and the navigation dies silently. One reload fetches the new index.html.
 */

export const STALE_CHUNK_RELOAD_KEY = 'kixdns:stale-chunk-reload-at'

/**
 * 上一次自动重新加载之后这段时间内再失败，就不再刷新。重新加载之后仍然加载不到，
 * 说明原因不是旧页面，继续刷只会陷入死循环。用时间而不是一次性标记：同一个标签页
 * 几小时后遇上下一次更新，仍然应该能自己恢复。
 *
 * A failure within this long of the last automatic reload does not reload
 * again. Still failing after a reload means a stale page was not the cause, and
 * reloading more would only loop. A time rather than a one-shot flag, so the
 * same tab can still recover from the next update hours later.
 */
const RELOAD_GUARD_MS = 30_000

interface RecoveryEnvironment {
  storage: () => Storage | null
  now: () => number
  navigate: (href: string) => void
}

export function createStaleChunkRecovery(environment: RecoveryEnvironment) {
  // 只认 Vite 报告过的加载失败。router.onError 也会收到守卫里接口请求的失败，
  // 那种情况刷新无济于事，而且接口一直挂着时会反复刷新。
  // Only failures Vite reported count. router.onError also receives failed API
  // calls from guards, which a reload does not fix and which would reload
  // repeatedly while the API stays down.
  const preloadErrors = new WeakSet<object>()

  function markPreloadError(error: unknown): void {
    if (typeof error === 'object' && error !== null) preloadErrors.add(error)
  }

  function isPreloadError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && preloadErrors.has(error)
  }

  function handleRouterError(error: unknown, href: string): boolean {
    if (!isPreloadError(error)) return false
    try {
      const storage = environment.storage()
      if (!storage) return false
      const last = Number(storage.getItem(STALE_CHUNK_RELOAD_KEY))
      const now = environment.now()
      if (Number.isFinite(last) && last > 0 && now - last < RELOAD_GUARD_MS) return false
      storage.setItem(STALE_CHUNK_RELOAD_KEY, String(now))
    } catch {
      // 记不住刷新过就不刷：没有这道保护，真正坏掉的分块会让页面无限重新加载。
      // Without a record of having reloaded, do not reload: a genuinely broken
      // chunk would otherwise reload the page forever.
      return false
    }
    environment.navigate(href)
    return true
  }

  return { markPreloadError, isPreloadError, handleRouterError }
}
