<script setup lang="ts">
import { CircleAlert, WifiOff } from '@lucide/vue'
import { onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useConnection } from '../composables/useConnection'

// 刚打开页面时就连不上面板：外壳还没挂上，这里占满页面说清楚，连上后路由接着打开要去的那一页
// The panel is unreachable right as the page opens: the shell has not mounted, so this fills the page and says so; once it answers the router carries on to the page asked for
const { booting, bootError, checking, retry } = useConnection()
const reload = () => window.location.reload()
// 网慢时（隧道、VPN）打开页面要先等会话读回来：过了 0.3 秒还没打开，先转个圈，不留一张白页；局域网里一般等不到它出现
// On a slow link (a tunnel, a VPN) opening the page waits for the session read: after 0.3 s a spinner shows instead of a blank page; on a LAN it rarely appears
const slow = ref(false)
const timer = setTimeout(() => { slow.value = true }, 300)
void useRouter().isReady().finally(() => { clearTimeout(timer); slow.value = false })
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <main v-if="booting" class="boot" role="status">
    <section class="boot__card">
      <WifiOff :size="20" aria-hidden="true" />
      <h1>连不上面板</h1>
      <p>网络断了，或者面板正在重启。连上后会自动打开。</p>
      <button class="ui-btn ui-btn--secondary" type="button" :disabled="checking" @click="retry">{{ checking ? '正在重试' : '重试' }}</button>
    </section>
  </main>
  <div v-else-if="slow && !bootError" class="boot" role="status" aria-label="正在打开面板"><span class="ui-spin boot__spin" aria-hidden="true"></span></div>
  <main v-else-if="bootError" class="boot" role="alert">
    <section class="boot__card">
      <CircleAlert :size="20" aria-hidden="true" />
      <h1>打不开面板</h1>
      <p>{{ bootError }}</p>
      <button class="ui-btn ui-btn--secondary" type="button" @click="reload">重试</button>
    </section>
  </main>
</template>

<style scoped>
.boot { min-height: 100dvh; display: grid; place-items: center; padding: var(--s-5) var(--s-4); background: var(--l-canvas); }
.boot__card { width: min(26rem, 100%); display: grid; justify-items: start; gap: var(--s-2); padding: var(--s-5); border-radius: var(--r-3); background: var(--l-surface); box-shadow: var(--shadow-card); }
.boot__card > svg { color: var(--warn-l); }
.boot__spin { width: var(--s-5); height: var(--s-5); }
.boot__card > h1 { margin: 0; color: var(--l-ink); font-size: var(--t-4); font-weight: var(--w-bold); }
.boot__card > p { margin: 0 0 var(--s-2); color: var(--l-ink-2); font-size: var(--t-3); line-height: var(--lh-base); }
</style>
