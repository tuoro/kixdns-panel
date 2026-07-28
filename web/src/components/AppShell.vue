<script setup lang="ts">
import {
  Activity,
  Braces,
  FileText,
  Gauge,
  LogOut,
  Menu,
  Network,
  ServerCog,
  X,
} from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { useSession } from '../composables/useSession'
import { useToast } from '../composables/useToast'
import { errorMessage } from '../utils'

const route = useRoute()
const router = useRouter()
const session = useSession()
const toast = useToast()
const menuOpen = ref(false)
const menuButton = ref<HTMLButtonElement | null>(null)
const sidebar = ref<HTMLElement | null>(null)
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
  menuOpen.value = true
  void nextTick(() => sidebar.value?.querySelector<HTMLElement>('button, a[href]')?.focus())
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
watch(menuOpen, (open) => document.body.classList.toggle('menu-open', open))
onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  mobileViewport = window.matchMedia('(max-width: 860px)')
  mobileViewport.addEventListener('change', handleViewportChange)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  mobileViewport?.removeEventListener('change', handleViewportChange)
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
