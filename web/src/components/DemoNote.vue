<script setup lang="ts">
import { ExternalLink, MonitorPlay } from '@lucide/vue'

// 公开的在线演示（只在编演示站时打开）：内容区顶上一条灰色说明，告诉来看的人这是示例数据、修改刷新后还原，以及去哪里看安装说明。
// 跟着页面滚走，不像「连不上面板」那样钉在顶上：这是一次性的说明，不是要处理的状态
// The public online demo (only in the demo-site build): a grey note atop the content area telling visitors the data is a sample,
// edits reset on reload, and where the install guide is. It scrolls with the page instead of sticking like 连不上面板: it is a one-off
// explanation, not a state to deal with
</script>

<template>
  <aside class="demo-note" aria-label="在线演示">
    <MonitorPlay :size="16" aria-hidden="true" />
    <p><strong>在线演示</strong><span>页面里是示例数据，修改会<span class="demo-note__tail">在刷新后还原。</span></span></p>
    <a class="ui-link" href="https://github.com/tuoro/kixdns-panel#安装" target="_blank" rel="noopener noreferrer">安装说明<ExternalLink :size="12" aria-hidden="true" /></a>
  </aside>
</template>

<style scoped>
.demo-note { display: flex; align-items: center; gap: var(--s-3); padding: var(--s-2) var(--s-4); background: var(--l-sunk); border-bottom: 1px solid var(--l-hair); }
.demo-note > svg { flex: none; color: var(--l-ink-2); }
.demo-note > p { display: flex; flex: 1 1 auto; flex-wrap: wrap; gap: 0 var(--s-2); min-width: 0; margin: 0; color: var(--l-ink-2); font-size: var(--t-2); line-height: var(--lh-base); }
.demo-note > p > strong { color: var(--l-ink); font-weight: var(--w-bold); }
.demo-note > .ui-link { flex: none; }
/* 「在刷新后还原。」不拆开：折行时不会只剩「原。」落在下一行 / 在刷新后还原。 stays whole: a fold never leaves 原。 alone on the next line */
.demo-note__tail { white-space: nowrap; }
/* 手机上链接另起一行放在说明下面，说明用满整行；图标对着第一行字 / On a phone the link drops below the note so the note gets the full width;
   the icon lines up with the first line */
@media (max-width: 640px) {
  .demo-note { display: grid; grid-template-columns: var(--size-icon) minmax(0, 1fr); gap: var(--s-1) var(--s-3); align-items: start; }
  .demo-note > svg { margin-top: calc((var(--t-2) * var(--lh-base) - var(--size-icon)) / 2); }
  .demo-note > .ui-link { grid-column: 2; justify-self: start; }
}
/* 宽屏上文字和内容左边对齐，和「连不上面板」那条一样 / On wide screens the text lines up with the content's left edge, as the 连不上面板 strip does */
@media (min-width: 861px) {
  .demo-note { padding-inline: var(--s-6); }
}
</style>
