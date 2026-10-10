import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router'
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
  // 演示包（生产构建 + 演示数据）放在静态托管上，用 hash 路由，刷新和深链不落到不存在的路径；开发服务器照常用路径路由，截图脚本按 /logs 这样的路径打开
  // The demo bundle (production build with demo data) sits on static hosting and uses hash routing, so reloads and deep links never hit a missing path; the dev server keeps path routing, which the screenshot scripts open by path
  history: import.meta.env.VITE_DEMO_MODE === 'true' && import.meta.env.PROD ? createWebHashHistory() : createWebHistory(),
  routes: [
    { path: '/login', component: () => import('./views/LoginView.vue'), meta: { guest: true, title: '登录' } },
    { path: '/setup', component: () => import('./views/SetupView.vue'), meta: { guest: true, title: '初始化' } },
    {
      path: '/',
      component: AppShell,
      meta: { auth: true },
      children: [
        { path: '', name: 'dashboard', component: () => import('./views/DashboardView.vue'), meta: { auth: true, title: '运行概览' } },
        { path: 'config', name: 'config', component: () => import('./views/ConfigRoute.vue'), meta: { auth: true, title: '配置管理' } },
        { path: 'logs', name: 'logs', component: () => import('./views/LogsView.vue'), meta: { auth: true, title: '运行日志' } },
        { path: 'diagnostics', name: 'diagnostics', component: () => import('./views/DiagnosticsView.vue'), meta: { auth: true, title: 'DNS 诊断' } },
        { path: 'system', name: 'system', component: () => import('./views/SystemView.vue'), meta: { auth: true, title: '系统' } },
        // 组件清单只在开发服务器里有，正式构建里这一项整个被摇掉
        // The component sheet exists on the dev server only; the production build drops it
        ...(import.meta.env.DEV ? [{ path: 'ui', name: 'ui-kit', component: () => import('./views/UiKitView.vue'), meta: { auth: true, title: '组件' } }] : []),
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
