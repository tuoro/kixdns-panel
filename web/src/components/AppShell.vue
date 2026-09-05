<script setup lang="ts">
import { Activity, Bell, Check, ExternalLink, FileText, LayoutGrid, LogOut, RefreshCw, ServerCog, Settings, SlidersHorizontal } from '@lucide/vue'
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
const activePopover = ref<'notifications' | 'account' | null>(null)
const notificationCenter = ref<HTMLElement | null>(null)
const accountCenter = ref<HTMLElement | null>(null)
const notificationButton = ref<HTMLButtonElement | null>(null)
const accountButton = ref<HTMLButtonElement | null>(null)
const signingOut = ref(false)
const title = computed(() => route.meta.title ?? 'KixDNS Panel')
const hasPageHeading = computed(() => ['dashboard', 'config', 'diagnostics'].includes(String(route.name)))

const navigation = [
  { to: '/', label: '概览', icon: LayoutGrid },
  { to: '/config', label: '配置', icon: SlidersHorizontal },
  { to: '/logs', label: '日志', icon: FileText },
  { to: '/diagnostics', label: '诊断', icon: Activity },
  { to: '/system', label: '系统', icon: Settings },
]

function togglePopover(kind: 'notifications' | 'account'): void {
  activePopover.value = activePopover.value === kind ? null : kind
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !activePopover.value) return
  const trigger = activePopover.value === 'account' ? accountButton : notificationButton
  activePopover.value = null
  void nextTick(() => trigger.value?.focus())
}

function handleDocumentPointerDown(event: PointerEvent): void {
  const target = event.target as Node
  if (notificationCenter.value?.contains(target) || accountCenter.value?.contains(target)) return
  activePopover.value = null
}

async function openNotice(notice: UpdateNoticeItem): Promise<void> {
  activePopover.value = null
  await router.push(notice.target)
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

let updateTimer: number | undefined
const announcedUpdates = new Set<string>()

async function checkUpdates(): Promise<void> {
  await notifications.refresh()
  const fresh = notifications.unreadNotices.value.filter((notice) => !announcedUpdates.has(notice.id))
  const labels = fresh.map((notice) => notice.title)
  fresh.forEach((notice) => announcedUpdates.add(notice.id))
  if (labels.length > 0) toast.info(`${labels.join('、')} ${labels.length > 1 ? '均有更新' : '有更新'}，请前往系统页面查看`)
}

watch(() => route.fullPath, () => { activePopover.value = null })
onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  document.addEventListener('pointerdown', handleDocumentPointerDown)
  void checkUpdates()
  updateTimer = window.setInterval(() => void checkUpdates(), 30 * 60 * 1000)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
  window.clearInterval(updateTimer)
})
</script>

<template>
  <div class="app-shell">
    <a class="skip-link" href="#main-content">跳至内容</a>
    <header class="app-header">
      <RouterLink class="app-brand" to="/" aria-label="KixDNS 首页"><Activity :size="32" /><strong>KixDNS</strong></RouterLink>
      <nav class="desktop-nav" aria-label="主导航">
        <RouterLink v-for="item in navigation" :key="item.to" :to="item.to"><span>{{ item.label }}</span></RouterLink>
      </nav>
      <div class="app-header__actions">
        <div ref="notificationCenter" class="notification-center">
          <button ref="notificationButton" class="header-button topbar-update" type="button" :title="notifications.unreadCount.value ? `${notifications.unreadCount.value} 条未读更新通知` : '更新通知'" :aria-label="notifications.unreadCount.value ? `${notifications.unreadCount.value} 条未读更新通知` : '更新通知'" aria-haspopup="dialog" aria-controls="update-notifications" :aria-expanded="activePopover === 'notifications'" @click="togglePopover('notifications')">
            <Bell :size="18" /><span v-if="notifications.unreadCount.value" class="notification-badge">{{ notifications.unreadCount.value }}</span>
          </button>
          <section v-if="activePopover === 'notifications'" id="update-notifications" class="notification-popover" role="dialog" aria-label="更新通知">
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
                    <a v-if="notice.external" :href="notice.target" target="_blank" rel="noopener noreferrer" @click="activePopover = null">查看<ExternalLink :size="12" /></a>
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
        <div ref="accountCenter" class="account-center">
          <button ref="accountButton" class="header-button account-button" type="button" :aria-label="`账户：${username}`" aria-haspopup="dialog" aria-controls="account-popover" :aria-expanded="activePopover === 'account'" @click="togglePopover('account')">
            <span>{{ username.slice(0, 1).toUpperCase() }}</span>
          </button>
          <section v-if="activePopover === 'account'" id="account-popover" class="account-popover" role="dialog" aria-label="账户">
            <strong>{{ username }}</strong><small>管理员</small>
            <button type="button" :disabled="signingOut" @click="logout"><LogOut :size="16" />{{ signingOut ? '正在退出' : '退出登录' }}</button>
          </section>
        </div>
      </div>
    </header>
    <div class="workspace">
      <main id="main-content" class="workspace__main" tabindex="-1">
        <div v-if="!hasPageHeading" class="page-heading"><h1>{{ title }}</h1></div>
        <RouterView />
      </main>
    </div>
    <nav class="mobile-nav" aria-label="移动端导航">
      <RouterLink v-for="item in navigation" :key="item.to" :to="item.to"><component :is="item.icon" :size="20" /><span>{{ item.label }}</span></RouterLink>
    </nav>
  </div>
</template>
