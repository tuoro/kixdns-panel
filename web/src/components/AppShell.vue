<script setup lang="ts">
import {
  Activity,
  Bell,
  Braces,
  Check,
  ExternalLink,
  FileText,
  Gauge,
  LogOut,
  Menu,
  Network,
  RefreshCw,
  ServerCog,
  X,
} from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { useSession } from '../composables/useSession'
import { useToast } from '../composables/useToast'
import { useUpdateNotifications, type UpdateNoticeItem } from '../composables/useUpdateNotifications'
import { errorMessage } from '../utils'

const route = useRoute()
const router = useRouter()
const session = useSession()
const toast = useToast()
const username = computed(() => session.user.value?.username ?? '')
const notifications = useUpdateNotifications(username)
const menuOpen = ref(false)
const notificationOpen = ref(false)
const menuButton = ref<HTMLButtonElement | null>(null)
const sidebar = ref<HTMLElement | null>(null)
const notificationCenter = ref<HTMLElement | null>(null)
const signingOut = ref(false)
const title = computed(() => route.meta.title ?? 'KixDNS Panel')

const navigation = [
  { to: '/', label: '概览', icon: Gauge },
  { to: '/config', label: '配置', icon: Braces },
  { to: '/logs', label: '日志', icon: FileText },
  { to: '/diagnostics', label: '诊断', icon: Network },
  { to: '/system', label: '系统', icon: ServerCog },
]

function closeMenu(restoreFocus = false): void {
  menuOpen.value = false
  if (restoreFocus) void nextTick(() => menuButton.value?.focus())
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && notificationOpen.value) {
    notificationOpen.value = false
    return
  }
  if (!menuOpen.value) return
  if (event.key === 'Escape') {
    closeMenu(true)
    return
  }
  if (event.key !== 'Tab' || !sidebar.value) return
  const focusable = [...sidebar.value.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])')]
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first || !last) return
  if (event.shiftKey && (document.activeElement === first || !sidebar.value.contains(document.activeElement))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function openMenu(): void {
  notificationOpen.value = false
  menuOpen.value = true
  void nextTick(() => sidebar.value?.querySelector<HTMLElement>('button, a[href]')?.focus())
}

function toggleNotifications(): void {
  notificationOpen.value = !notificationOpen.value
}

function handleDocumentPointerDown(event: PointerEvent): void {
  if (!notificationOpen.value || notificationCenter.value?.contains(event.target as Node)) return
  notificationOpen.value = false
}

async function openNotice(notice: UpdateNoticeItem): Promise<void> {
  notificationOpen.value = false
  await router.push(notice.target)
}

function handleViewportChange(event: MediaQueryListEvent): void {
  if (!event.matches) closeMenu()
}

async function logout(): Promise<void> {
  signingOut.value = true
  try {
    await session.logout()
    await router.replace('/login')
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    signingOut.value = false
  }
}

let mobileViewport: MediaQueryList | null = null
let updateTimer: number | undefined
const announcedUpdates = new Set<string>()

async function checkUpdates(): Promise<void> {
  await notifications.refresh()
  const fresh = notifications.unreadNotices.value.filter((notice) => !announcedUpdates.has(notice.id))
  const labels = fresh.map((notice) => notice.title)
  fresh.forEach((notice) => announcedUpdates.add(notice.id))
  if (labels.length > 0) toast.info(`${labels.join('、')} ${labels.length > 1 ? '均有更新' : '有更新'}，请前往系统页面查看`)
}

watch(menuOpen, (open) => document.body.classList.toggle('menu-open', open))
watch(() => route.fullPath, () => { notificationOpen.value = false })
onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  document.addEventListener('pointerdown', handleDocumentPointerDown)
  mobileViewport = window.matchMedia('(max-width: 860px)')
  mobileViewport.addEventListener('change', handleViewportChange)
  void checkUpdates()
  updateTimer = window.setInterval(() => void checkUpdates(), 30 * 60 * 1000)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
  mobileViewport?.removeEventListener('change', handleViewportChange)
  window.clearInterval(updateTimer)
  document.body.classList.remove('menu-open')
})
</script>

<template>
  <div class="app-shell">
    <aside id="primary-sidebar" ref="sidebar" class="sidebar" :class="{ 'sidebar--open': menuOpen }" :role="menuOpen ? 'dialog' : undefined" :aria-modal="menuOpen || undefined" aria-label="主菜单">
      <div class="brand">
        <span class="brand__mark"><Activity :size="20" /></span>
        <span><strong>KixDNS</strong><small>CONTROL PLANE</small></span>
        <button class="icon-button sidebar__close" type="button" title="关闭菜单" aria-label="关闭菜单" @click="closeMenu(true)"><X :size="20" /></button>
      </div>
      <nav class="sidebar__nav" aria-label="主导航">
        <RouterLink v-for="item in navigation" :key="item.to" :to="item.to" @click="menuOpen = false">
          <component :is="item.icon" :size="18" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>
      <div class="sidebar__footer">
        <div class="service-indicator"><span></span><div><strong>增强控制协议</strong><small>支持 v1</small></div></div>
        <button class="sidebar__logout" type="button" :disabled="signingOut" @click="logout">
          <LogOut :size="17" /><span>{{ signingOut ? '正在退出' : '退出登录' }}</span>
        </button>
      </div>
    </aside>

    <div v-if="menuOpen" class="sidebar-backdrop" aria-hidden="true" @click="closeMenu(true)"></div>

    <div class="workspace" :inert="menuOpen">
      <header class="topbar">
        <button ref="menuButton" class="icon-button menu-button" type="button" title="打开菜单" aria-label="打开菜单" aria-controls="primary-sidebar" :aria-expanded="menuOpen" @click="openMenu"><Menu :size="21" /></button>
        <div><p class="eyebrow">KixDNS Enhanced</p><h1>{{ title }}</h1></div>
        <div ref="notificationCenter" class="notification-center">
          <button class="icon-button topbar-update" type="button" :title="notifications.unreadCount.value ? `${notifications.unreadCount.value} 条未读更新通知` : '更新通知'" :aria-label="notifications.unreadCount.value ? `${notifications.unreadCount.value} 条未读更新通知` : '更新通知'" aria-haspopup="dialog" aria-controls="update-notifications" :aria-expanded="notificationOpen" @click="toggleNotifications">
            <Bell :size="18" />
            <span v-if="notifications.unreadCount.value" class="notification-badge">{{ notifications.unreadCount.value }}</span>
          </button>
          <section v-if="notificationOpen" id="update-notifications" class="notification-popover" role="dialog" aria-label="更新通知">
            <header class="notification-popover__header">
              <div><strong>更新通知</strong><span>{{ notifications.unreadCount.value ? `${notifications.unreadCount.value} 条未读` : '已全部阅读' }}</span></div>
              <div>
                <button class="icon-button icon-button--small" type="button" title="检查更新" aria-label="检查更新" :disabled="notifications.checking.value" @click="checkUpdates"><RefreshCw :size="14" :class="{ spin: notifications.checking.value }" /></button>
                <button v-if="notifications.unreadCount.value" class="notification-mark-all" type="button" @click="notifications.markAllRead"><Check :size="13" />全部已读</button>
              </div>
            </header>
            <div v-if="notifications.notices.value.length" class="notification-list">
              <article v-for="notice in notifications.notices.value" :key="notice.id" :class="{ 'notification-item--unread': !notifications.isRead(notice.id) }" class="notification-item">
                <span class="notification-item__icon" :class="{ 'notification-item__icon--panel': notice.kind === 'panel' }"><ServerCog v-if="notice.kind === 'kixdns'" :size="17" /><Bell v-else :size="17" /></span>
                <div class="notification-item__body">
                  <div class="notification-item__title"><strong>{{ notice.title }}</strong><i v-if="!notifications.isRead(notice.id)"></i></div>
                  <p>{{ notice.detail }}</p>
                  <small>{{ notice.meta }}</small>
                  <div class="notification-item__actions">
                    <a v-if="notice.external" :href="notice.target" target="_blank" rel="noopener noreferrer" @click="notificationOpen = false">查看<ExternalLink :size="12" /></a>
                    <button v-else type="button" @click="openNotice(notice)">查看</button>
                    <button v-if="!notifications.isRead(notice.id)" type="button" @click="notifications.markRead(notice.id)"><Check :size="12" />标为已读</button>
                    <span v-else><Check :size="12" />已读</span>
                  </div>
                </div>
              </article>
            </div>
            <div v-else class="notification-empty">{{ notifications.checking.value ? '正在检查更新…' : '暂无更新通知' }}</div>
            <p v-if="notifications.error.value" class="notification-error">检查失败：{{ notifications.error.value }}</p>
          </section>
        </div>
        <div class="operator"><span>{{ session.user.value?.username.slice(0, 1).toUpperCase() }}</span><div><strong>{{ session.user.value?.username }}</strong><small>管理员</small></div></div>
      </header>
      <main class="workspace__main"><RouterView /></main>
    </div>

    <nav class="mobile-nav" aria-label="移动端导航" :inert="menuOpen">
      <RouterLink v-for="item in navigation" :key="item.to" :to="item.to">
        <component :is="item.icon" :size="19" /><span>{{ item.label }}</span>
      </RouterLink>
    </nav>
  </div>
</template>
