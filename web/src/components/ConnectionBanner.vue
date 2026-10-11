<script setup lang="ts">
import { WifiOff } from '@lucide/vue'
import { ref } from 'vue'
import { useBarHeight } from '../composables/useBarHeight'
import { useConnection } from '../composables/useConnection'

// 连不上面板时内容区顶上一条横幅（手机上贴着顶栏），不随页面滚走；连上后自己收起并提示一句
// While the panel is unreachable a strip sits atop the content area (under the top bar on phones) and stays there on scroll; it folds away by itself on reconnect, with a toast
// 监听在 App 里一直开着（启动时也要），这里只负责显示 / Listening stays on in App (it is needed at start too); this only shows it
const { down, checking, booting, retry } = useConnection()
// 横幅的高度写到 --conn-h 上：同样贴着顶部的东西（宽屏的规则面板）往下让开 / The banner's height goes to --conn-h so other things stuck to the top (the wide rule inspector) move down out of its way
const inner = ref<HTMLElement | null>(null)
useBarHeight(inner, '--conn-h')
</script>

<template>
  <div class="conn" role="status">
    <div v-if="down && !booting" ref="inner" class="conn__inner">
      <WifiOff :size="16" aria-hidden="true" />
      <p><strong>连不上面板</strong><span>网络断了，或者面板正在重启。连上后自动恢复。</span></p>
      <button class="ui-btn ui-btn--secondary ui-btn--sm" type="button" :disabled="checking" @click="retry">{{ checking ? '正在重试' : '重试' }}</button>
    </div>
  </div>
</template>

<style scoped>
.conn { position: sticky; top: var(--app-header-height); z-index: 39; }
.conn__inner { display: flex; align-items: center; gap: var(--s-3); padding: var(--s-2) var(--s-4); background: var(--warn-tint-l); border-bottom: 1px solid var(--l-hair); }
.conn__inner > svg { flex: none; color: var(--warn-l); }
/* 手机上说明折成两三行：图标对着第一行字，不跑到中间 / On a phone the note folds onto two or three lines: the icon lines up with the first one instead of drifting to the middle */
@media (max-width: 640px) {
  .conn__inner > svg { align-self: flex-start; margin-top: calc((var(--t-2) * var(--lh-base) - var(--size-icon)) / 2); }
}
.conn__inner > p { display: flex; flex: 1 1 auto; flex-wrap: wrap; gap: 0 var(--s-2); min-width: 0; margin: 0; color: var(--l-ink-2); font-size: var(--t-2); line-height: var(--lh-base); }
.conn__inner > p > strong { color: var(--l-ink); font-weight: var(--w-bold); }
.conn__inner > .ui-btn { flex: none; }
/* 宽屏上侧栏不占顶部：贴着窗口顶，文字和内容左边对齐 / On wide screens the sidebar leaves the top free: the strip sits at the window's top, its text on the content's left edge */
@media (min-width: 861px) {
  .conn { top: 0; }
  .conn__inner { padding-inline: var(--s-6); }
}
</style>
