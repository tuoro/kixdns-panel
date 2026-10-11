<script setup lang="ts">
import { WifiOff } from '@lucide/vue'
import { useConnection } from '../composables/useConnection'

// 刚打开页面时就连不上面板：外壳还没挂上，这里占满页面说清楚，连上后路由接着打开要去的那一页
// The panel is unreachable right as the page opens: the shell has not mounted, so this fills the page and says so; once it answers the router carries on to the page asked for
const { booting, checking, retry } = useConnection()
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
</template>

<style scoped>
.boot { min-height: 100dvh; display: grid; place-items: center; padding: var(--s-5) var(--s-4); background: var(--l-canvas); }
.boot__card { width: min(26rem, 100%); display: grid; justify-items: start; gap: var(--s-2); padding: var(--s-5); border-radius: var(--r-3); background: var(--l-surface); box-shadow: var(--shadow-card); }
.boot__card > svg { color: var(--warn-l); }
.boot__card > h1 { margin: 0; color: var(--l-ink); font-size: var(--t-4); font-weight: var(--w-bold); }
.boot__card > p { margin: 0 0 var(--s-2); color: var(--l-ink-2); font-size: var(--t-3); line-height: var(--lh-base); }
</style>
