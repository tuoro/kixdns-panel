import { createApp } from 'vue'
import App from './App.vue'
import { SESSION_EXPIRED_EVENT } from './api/client'
import { useSession } from './composables/useSession'
import router from './router'
import './styles.css'

const session = useSession()
window.addEventListener(SESSION_EXPIRED_EVENT, () => {
  const route = router.currentRoute.value
  session.expire()
  if (route.path === '/login') return
  const query = route.meta.auth ? { redirect: route.fullPath } : undefined
  void router.replace({ path: '/login', query })
})

createApp(App).use(router).mount('#app')
