import { createRouter, createWebHistory } from 'vue-router'
import AppShell from './components/AppShell.vue'
import { useSession } from './composables/useSession'

declare module 'vue-router' {
  interface RouteMeta {
    auth?: boolean
    guest?: boolean
    title?: string
  }
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('./views/LoginView.vue'), meta: { guest: true, title: '登录' } },
    { path: '/setup', component: () => import('./views/SetupView.vue'), meta: { guest: true, title: '初始化' } },
    {
      path: '/',
      component: AppShell,
      meta: { auth: true },
      children: [
        { path: '', name: 'dashboard', component: () => import('./views/DashboardView.vue'), meta: { auth: true, title: '运行概览' } },
        { path: 'config', name: 'config', component: () => import('./views/ConfigView.vue'), meta: { auth: true, title: '配置管理' } },
        { path: 'logs', name: 'logs', component: () => import('./views/LogsView.vue'), meta: { auth: true, title: '运行日志' } },
        { path: 'diagnostics', name: 'diagnostics', component: () => import('./views/DiagnosticsView.vue'), meta: { auth: true, title: 'DNS 诊断' } },
        { path: 'system', name: 'system', component: () => import('./views/SystemView.vue'), meta: { auth: true, title: '系统与更新' } },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach(async (to) => {
  const session = useSession()
  await session.initialize()
  if (session.setupRequired.value && to.path !== '/setup') return '/setup'
  if (!session.setupRequired.value && to.path === '/setup') return session.user.value ? '/' : '/login'
  if (to.meta.auth && !session.user.value) return `/login?redirect=${encodeURIComponent(to.fullPath)}`
  if (to.meta.guest && session.user.value) return '/'
  return true
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · KixDNS Panel` : 'KixDNS Panel'
})

export default router
