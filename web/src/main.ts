import { createApp } from 'vue'
import App from './App.vue'
import { SESSION_EXPIRED_EVENT } from './api/client'
import { useSession } from './composables/useSession'
import router from './router'
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

createApp(App).use(router).mount('#app')
