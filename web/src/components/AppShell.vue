<script setup lang="ts">
import { Activity, ArrowRightLeft, Bell, Check, Cpu, FileText, Keyboard, LayoutGrid, List, LogOut, Monitor, Moon, PanelsTopLeft, RefreshCw, Server, Settings, SlidersHorizontal, Stethoscope, Sun } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { useHelp } from '../composables/useHelp'
import { useSession } from '../composables/useSession'
import HelpDrawer from './HelpDrawer.vue'
import type { HelpPage } from '../help/topics'
import { useToast } from '../composables/useToast'
import { THEME_CHOICES, useTheme, type ThemeChoice } from '../composables/useTheme'
import { useUpdateNotifications, type UpdateNoticeItem } from '../composables/useUpdateNotifications'
import { errorMessage } from '../utils'

const route = useRoute()
const router = useRouter()
const session = useSession()
const toast = useToast()
const theme = useTheme()
const help = useHelp()
// 当前页在帮助里叫什么 / Which help page the current route maps to
const helpPage = computed<HelpPage>(() => (route.path.startsWith('/config') ? 'config' : route.path.startsWith('/logs') ? 'logs' : route.path.startsWith('/diagnostics') ? 'diagnostics' : route.path.startsWith('/system') ? 'system' : 'overview'))
const username = computed(() => session.user.value?.username ?? '')
const notifications = useUpdateNotifications(username)
type PopoverKind = 'notifications' | 'account' | 'theme'
const activePopover = ref<PopoverKind | null>(null)
const notificationCenter = ref<HTMLElement | null>(null)
const accountCenter = ref<HTMLElement | null>(null)
const notificationButton = ref<HTMLButtonElement | null>(null)
const accountButton = ref<HTMLButtonElement | null>(null)
const themeCenter = ref<HTMLElement | null>(null)
const themeButton = ref<HTMLButtonElement | null>(null)
// 外观按钮的图标跟着当前选择走：显示器、太阳、月亮 / The appearance button's icon follows the current choice: monitor, sun, moon
const THEME_ICONS: Record<ThemeChoice, Component> = { system: Monitor, light: Sun, dark: Moon }
const themeIcon = computed(() => THEME_ICONS[theme.choice.value])
const signingOut = ref(false)
const title = computed(() => route.meta.title ?? 'KixDNS Panel')
// 侧栏底部的版本行：面板版本，有更新时上面多一行 / The sidebar's version line: the panel version, with an update line above it when one is available
const panelVersion = computed(() => notifications.status.value?.panel?.current_version ?? '')
const updateLine = computed(() => {
  const u = notifications.status.value
  if (u?.panel?.available && u.panel.latest_version) return `有新版本 v${u.panel.latest_version}`
  if (u?.kixdns?.available) return '内核有新构建'
  return ''
})
const hasPageHeading = computed(() => ['dashboard', 'config', 'logs', 'diagnostics', 'system', 'ui-kit'].includes(String(route.name)))

// 手机底栏：五个页面各一项 / The phone's bottom bar: one item per page
const navigation = [
  { to: '/', label: '概览', icon: LayoutGrid },
  { to: '/config', label: '配置', icon: SlidersHorizontal },
  { to: '/logs', label: '日志', icon: FileText },
  { to: '/diagnostics', label: '诊断', icon: Stethoscope },
  { to: '/system', label: '系统', icon: Settings },
]
// 桌面侧栏分组：配置的四个子页从侧栏直达，?section= 说是哪一页；规则是默认页，不带参数
// The desktop sidebar's groups: the four config sub-pages open from the sidebar, ?section= names the page; 规则 is the default and carries no parameter
type NavItem = { to: string; label: string; icon: Component; section?: string }
const navGroups: Array<{ label: string; items: NavItem[] }> = [
  { label: '', items: [{ to: '/', label: '概览', icon: LayoutGrid }] },
  { label: '配置', items: [
    { to: '/config', label: '规则', icon: List },
    { to: '/config', label: '上游组', icon: Server, section: 'upstreams' },
    { to: '/config', label: '域名映射', icon: ArrowRightLeft, section: 'mapping' },
    { to: '/config', label: '基础设置', icon: SlidersHorizontal, section: 'settings' },
  ] },
  { label: '观察', items: [{ to: '/logs', label: '日志', icon: FileText }, { to: '/diagnostics', label: '诊断', icon: Stethoscope }] },
  { label: '系统', items: [{ to: '/system', label: '系统', icon: Settings }] },
]
function navTarget(item: NavItem) { return item.section ? { path: item.to, query: { section: item.section } } : item.to }
function isCurrent(item: NavItem): boolean {
  if (route.path !== item.to) return false
  const section = typeof route.query.section === 'string' ? route.query.section : ''
  return item.section ? section === item.section : item.to !== '/config' || section === '' || section === 'rules'
}

function togglePopover(kind: PopoverKind): void {
  activePopover.value = activePopover.value === kind ? null : kind
}

// ? 打开帮助抽屉（输入框里和弹层开着时不抢）/ ? opens the help drawer, not while typing or while a dialog is open
function typing(event: KeyboardEvent): boolean { const t = event.target; return t instanceof HTMLElement && Boolean(t.closest('input, textarea, select, [contenteditable="true"]')) }
function handleKeydown(event: KeyboardEvent): void {
  if (event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey && !typing(event) && !document.querySelector('dialog[open]')) { event.preventDefault(); activePopover.value = null; help.show(helpPage.value, 'shortcuts'); return }
  if (event.key !== 'Escape' || !activePopover.value) return
  const trigger = activePopover.value === 'account' ? accountButton : activePopover.value === 'theme' ? themeButton : notificationButton
  activePopover.value = null
  void nextTick(() => trigger.value?.focus())
}

function handleDocumentPointerDown(event: PointerEvent): void {
  const target = event.target as Node
  if (notificationCenter.value?.contains(target) || accountCenter.value?.contains(target) || themeCenter.value?.contains(target)) return
  activePopover.value = null
}

// 选完就收起，焦点回到按钮 / Picking closes the popover and returns focus to the button
function pickTheme(value: ThemeChoice): void {
  theme.set(value)
  activePopover.value = null
  void nextTick(() => themeButton.value?.focus())
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
  // v2 预览：有更新只在铃铛上出角标，不再弹提示盖住页头 / v2 preview: updates show as the bell's badge only, no toast over the page header
  void labels
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
      <!-- 手机上打开头部菜单时，下面的页面压暗，点一下暗处收起 / On a phone an open header menu dims the page below; a tap on the dim area closes it -->
      <div v-if="activePopover" class="popover-scrim" aria-hidden="true"></div>
      <RouterLink class="app-brand" to="/" aria-label="KixDNS 首页"><Activity :size="32" /><strong>KixDNS</strong></RouterLink>
      <nav class="desktop-nav" aria-label="主导航">
        <template v-for="group in navGroups" :key="group.label || 'top'">
          <span v-if="group.label" class="nav-label">{{ group.label }}</span>
          <!-- 自己写 a：配置的四项共用一条路由，RouterLink 的当前态分不出来 / Our own anchors: the four config items share one route, so RouterLink's current state cannot tell them apart -->
          <RouterLink v-for="item in group.items" :key="item.label" :to="navTarget(item)" custom v-slot="{ href, navigate }">
            <a :href="href" :aria-current="isCurrent(item) ? 'page' : undefined" @click="navigate"><component :is="item.icon" :size="16" aria-hidden="true" /><span>{{ item.label }}</span></a>
          </RouterLink>
        </template>
      </nav>
      <div class="app-header__actions">
        <div v-if="panelVersion || updateLine" class="app-version">
          <span v-if="updateLine" class="app-version__new"><span class="ui-dot ui-dot--warn" aria-hidden="true"></span>{{ updateLine }}</span>
          <span v-if="panelVersion" class="app-version__now">面板 v{{ panelVersion }}</span>
        </div>
        <div ref="notificationCenter" class="notification-center">
          <button ref="notificationButton" class="header-button topbar-update" type="button" :title="notifications.unreadCount.value ? `${notifications.unreadCount.value} 条未读更新通知` : '更新通知'" :aria-label="notifications.unreadCount.value ? `${notifications.unreadCount.value} 条未读更新通知` : '更新通知'" aria-haspopup="dialog" aria-controls="update-notifications" :aria-expanded="activePopover === 'notifications'" @click="togglePopover('notifications')">
            <Bell :size="18" /><span v-if="notifications.unreadCount.value" class="notification-badge">{{ notifications.unreadCount.value }}</span>
          </button>
          <section v-if="activePopover === 'notifications'" id="update-notifications" class="notification-popover" role="dialog" aria-label="更新通知">
            <header class="notification-popover__header">
              <!-- 未读数铃铛角标上已经有了，这里不再写一遍 / The unread count is already on the bell's badge and is not repeated here -->
              <div><strong>更新通知</strong></div>
              <div>
                <button class="ui-btn ui-btn--secondary ui-btn--icon ui-btn--compact" type="button" title="检查更新" aria-label="检查更新" :disabled="notifications.checking.value" @click="checkUpdates"><RefreshCw :size="14" :class="{ spin: notifications.checking.value }" /></button>
                <button v-if="notifications.unreadCount.value" class="notification-mark-all" type="button" @click="notifications.markAllRead"><Check :size="13" />全部已读</button>
              </div>
            </header>
            <div v-if="notifications.notices.value.length" class="notification-list">
              <article v-for="notice in notifications.notices.value" :key="notice.id" :class="{ 'notification-item--unread': !notifications.isRead(notice.id) }" class="notification-item">
                <!-- 内核和面板各用一个固定图标，和系统页同一套：铃铛只留给通知本身 / Kernel and panel keep one icon each, shared with the system page; the bell stays the notifications' own -->
                <span class="notification-item__icon"><Cpu v-if="notice.kind === 'kixdns'" :size="16" /><PanelsTopLeft v-else :size="16" /></span>
                <div class="notification-item__body">
                  <!-- 动作放在标题行右端，一条通知三行：标题、说明、版本 / Actions sit at the end of the title line, so a notice is three lines: title, detail, version -->
                  <div class="notification-item__title">
                    <strong>{{ notice.title }}</strong><i v-if="!notifications.isRead(notice.id)"></i>
                    <div class="notification-item__actions">
                      <!-- 两行的「查看」长一个样：去 GitHub 的那条在新标签页打开，提示写在 title 里 / Both rows' 查看 look alike; the GitHub one opens a new tab, said in its title -->
                      <a v-if="notice.external" :href="notice.target" target="_blank" rel="noopener noreferrer" title="在 GitHub 查看（新标签页）" @click="activePopover = null">查看</a>
                      <a v-else :href="notice.target" @click.prevent="openNotice(notice)">查看</a>
                    </div>
                  </div>
                  <p>{{ notice.detail }}</p>
                  <small>{{ notice.meta }}</small>
                </div>
              </article>
            </div>
            <div v-else class="notification-empty">{{ notifications.checking.value ? '正在检查更新…' : '暂无更新通知' }}</div>
            <p v-if="notifications.error.value" class="notification-error">检查失败：{{ notifications.error.value }}</p>
          </section>
        </div>
        <!-- 外观：铃铛旁一个图标，点开选跟随系统 / 浅色 / 深色，记在本机 / Appearance: an icon beside the bell opens follow-system / light / dark; kept on this device -->
        <div ref="themeCenter" class="theme-center">
          <button ref="themeButton" class="header-button theme-button" type="button" :title="`外观：${theme.label.value}`" :aria-label="`外观：${theme.label.value}`" aria-haspopup="dialog" aria-controls="theme-popover" :aria-expanded="activePopover === 'theme'" @click="togglePopover('theme')">
            <component :is="themeIcon" :size="18" aria-hidden="true" />
          </button>
          <section v-if="activePopover === 'theme'" id="theme-popover" class="theme-popover" role="dialog" aria-label="外观">
            <span class="ui-lbl">外观</span>
            <div class="theme-popover__list" role="radiogroup" aria-label="外观">
              <button v-for="item in THEME_CHOICES" :key="item.value" type="button" role="radio" :aria-checked="theme.choice.value === item.value" @click="pickTheme(item.value)">
                <component :is="THEME_ICONS[item.value]" :size="16" aria-hidden="true" /><span>{{ item.label }}</span><Check v-if="theme.choice.value === item.value" class="theme-popover__check" :size="14" aria-hidden="true" />
              </button>
            </div>
          </section>
        </div>
        <div ref="accountCenter" class="account-center">
          <button ref="accountButton" class="header-button account-button" type="button" :aria-label="`账户：${username}`" aria-haspopup="dialog" aria-controls="account-popover" :aria-expanded="activePopover === 'account'" @click="togglePopover('account')">
            <span>{{ username.slice(0, 1).toUpperCase() }}</span>
          </button>
          <section v-if="activePopover === 'account'" id="account-popover" class="account-popover" role="dialog" aria-label="账户">
            <strong>{{ username }}</strong><small>管理员</small>
            <button class="account-keys" type="button" @click="activePopover = null; help.show(helpPage, 'shortcuts')"><Keyboard :size="16" />键盘快捷键</button>
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
    <HelpDrawer v-if="help.request.value" />
    <nav class="mobile-nav" aria-label="移动端导航">
      <RouterLink v-for="item in navigation" :key="item.to" :to="item.to"><component :is="item.icon" :size="22" /><span>{{ item.label }}</span></RouterLink>
    </nav>
  </div>
</template>
