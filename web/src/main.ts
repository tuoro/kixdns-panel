import { createApp } from 'vue'
import App from './App.vue'
import { SESSION_EXPIRED_EVENT } from './api/client'
import { useSession } from './composables/useSession'
import { useToast } from './composables/useToast'
import router from './router'
import { createStaleChunkRecovery } from './stale-chunk-recovery'
import './styles.css'

const session = useSession()
window.addEventListener(SESSION_EXPIRED_EVENT, () => {
  const route = router.currentRoute.value
  // 已经在认证页上，没有页面状态可保，照旧清掉会话。
  if (!route.meta.auth) {
    session.expire()
    if (route.path !== '/login') void router.replace({ path: '/login' })
    return
  }
  // 在受保护页面上过期：只标记，由模态盖在原页上重新验证。
  // 跳转会把当前页卸载，配置草稿随之消失。
  //
  // Expiring on a protected page only raises the flag; a modal covers the page
  // for re-authentication. Navigating away would unmount it and take the config
  // draft with it.
  session.markExpired()
})

const staleChunks = createStaleChunkRecovery({
  storage: () => window.sessionStorage,
  now: () => Date.now(),
  navigate: (href) => window.location.assign(href),
})
// 不调用 preventDefault：让错误照常抛到 router.onError，那里知道用户要去哪一页。
// No preventDefault: the error still reaches router.onError, which knows the
// page the user was heading to.
window.addEventListener('vite:preloadError', (event) => staleChunks.markPreloadError(event.payload))
router.onError((error, to) => {
  if (staleChunks.handleRouterError(error, router.resolve(to.fullPath).href)) return
  // 刷新过仍然加载不到，或者浏览器记不住刷新过：说清楚，让用户自己刷新。
  // Still failing after a reload, or unable to remember reloading: say so and
  // leave the refresh to the user.
  if (staleChunks.isPreloadError(error)) {
    useToast().error('页面文件加载失败，面板可能刚更新过。请刷新浏览器后重试')
  }
})

createApp(App).use(router).mount('#app')
