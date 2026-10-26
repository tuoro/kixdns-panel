import { createApp } from 'vue'
import App from './App.vue'
import { SESSION_EXPIRED_EVENT } from './api/client'
import { probePanel, untilReachable } from './composables/useConnection'
import { useConfirm } from './composables/useConfirm'
import { useHelp } from './composables/useHelp'
import { leaveWithoutAsking, takeAgreement } from './composables/useLeaveGuard'
import { useSession } from './composables/useSession'
import { useToast } from './composables/useToast'
import './composables/useTheme'
import router from './router'
import { startFocusRescue } from './focus-rescue'
import { stopIosFocusZoom } from './ios-zoom'
import { createStaleChunkRecovery } from './stale-chunk-recovery'
import './styles.css'

stopIosFocusZoom(document.querySelector<HTMLMetaElement>('meta[name="viewport"]'), navigator)

const session = useSession()
// 会话过期就回登录页，登录后回到这一页。不再问「放弃修改」：会话已经没了，留下也存不了；没保存的修改留不住，登录页照实说
// An expired session goes straight to the login page and comes back to this page after signing in. 放弃修改 is not asked: with the
// session gone, staying could save nothing; unsaved work cannot be kept, and the login page says so
window.addEventListener(SESSION_EXPIRED_EVENT, () => {
  const route = router.currentRoute.value
  const signedIn = session.user.value !== null
  session.expire()
  if (!route.meta.auth) {
    if (route.path !== '/login') void router.replace({ path: '/login' })
    return
  }
  // 同时回来的几个 401 只走一次 / Several 401s arriving together leave only once
  if (!signedIn) return
  // 开着的确认框按取消收掉、帮助抽屉关上：留着的话会盖在登录页上，按了还会带着失效的会话去做（比如停止服务），登录后帮助又冒出来
  // An open confirm is settled as cancelled and help closes: left open they sit over the login page, a press would still act with the dead session
  // (stopping the service, say), and help would pop up again after signing in
  useConfirm().settle(false)
  useHelp().hide()
  const lost = leaveWithoutAsking()
  void router.replace({ path: '/login', query: { redirect: route.fullPath, expired: lost || '1' } }).finally(() => { takeAgreement() })
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
router.onError(async (error, to) => {
  // 分块加载不到也可能是面板正在重启：先问一次面板，没答话就挂出横幅、等它回来再打开那一页，不刷新到浏览器的错误页
  // A chunk failing to load can also mean the panel is restarting: ask the panel once; with no answer the banner goes up and the page opens once it is back, instead of reloading onto the browser's error page
  if (staleChunks.isPreloadError(error) && !(await probePanel())) {
    await untilReachable()
    void router.push(to.fullPath)
    return
  }
  if (staleChunks.handleRouterError(error, router.resolve(to.fullPath).href)) return
  // 刷新过仍然加载不到，或者浏览器记不住刷新过：说清楚，让用户自己刷新。
  // Still failing after a reload, or unable to remember reloading: say so and
  // leave the refresh to the user.
  if (staleChunks.isPreloadError(error)) {
    useToast().error('页面文件加载失败，面板可能刚更新过。刷新浏览器再试')
  }
})

createApp(App).use(router).mount('#app')
startFocusRescue()
