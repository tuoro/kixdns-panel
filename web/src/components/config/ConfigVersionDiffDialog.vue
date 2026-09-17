<script setup lang="ts">
import { X } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ConfigVersionDetail } from '../../api/types'
import { diffConfig, type ConfigDiffKind } from '../../config-editor/diff'

const props = defineProps<{
  current: Record<string, unknown>
  version: ConfigVersionDetail
  /** 关闭后接回焦点的元素，缺省时取打开那一刻的焦点。/ Where focus goes on close; defaults to whatever held it on open. */
  returnFocus?: HTMLElement | null
}>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const result = computed(() => diffConfig(props.current, props.version.content))

const kindLabels: Record<ConfigDiffKind, string> = {
  added: '新增',
  removed: '删除',
  changed: '修改',
}

function formatValue(value: unknown): string {
  if (value === undefined) return '不存在'
  return JSON.stringify(value, null, 2) ?? String(value)
}

/**
 * 与确认框同一套模态行为：原生 <dialog> 加 showModal。
 *
 * 原来是 Teleport 出去的一个 div 加 aria-modal，Tab 照样能走到框后面的页面，
 * Esc 靠 window 上的 keydown 监听，关掉之后焦点掉在 body 上。showModal 把框放进顶层：
 * 后面的页面整个变成惰性，一次 Esc 只关最上面一层，而且压得住同样是原生 <dialog> 的版本历史
 * ——所以差异框可以直接叠在历史上打开，关掉回到历史里原来那个按钮。
 *
 * The same modal behaviour as the confirmation dialog: a native <dialog> with
 * showModal. It used to be a teleported div with aria-modal, so Tab still
 * walked into the page behind it, Esc relied on a window keydown listener,
 * and closing dropped focus on the body. showModal puts it in the top layer:
 * the page behind turns inert, one Esc closes only the topmost layer, and it
 * rises above the version history, itself a native <dialog> — so the diff opens
 * on top of the history and closing it lands back on the button that opened it.
 */
let returnFocus: HTMLElement | null = null
/** 见 ConfirmDialog：打开它的那次 Esc 不能顺手把它关掉。/ See ConfirmDialog: the Esc that opened it must not close it. */
let justOpened = false
let unmounting = false

function onCancel(): void {
  if (!justOpened) emit('close')
}

/**
 * 浏览器在两次 Esc 之间没有用户操作时会跳过 cancel、直接关掉框，
 * 这时只剩 close 事件能让父组件知道。
 * A browser skips cancel and closes the dialog outright when two Esc presses
 * arrive with no user activation between them; then only close tells the parent.
 */
function onClose(): void {
  if (!unmounting) emit('close')
}

/**
 * Tab 在框内首尾相接。模态 <dialog> 只让框外的页面变成惰性，从最后一个元素再按 Tab，
 * 焦点会跑到浏览器地址栏上，键盘用户就此离开了框。
 *
 * Tab wraps between the first and last controls. A modal <dialog> only makes
 * the page behind it inert; tabbing past the last control sends focus out to
 * the browser's own toolbar and the keyboard user leaves the dialog.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || !dialog.value) return
  const focusable = [...dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first || !last) return
  const active = document.activeElement
  if (event.shiftKey && (active === first || !dialog.value.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || !dialog.value.contains(active))) {
    event.preventDefault()
    first.focus()
  }
}

onMounted(() => {
  returnFocus = props.returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
  justOpened = true
  dialog.value?.showModal()
  setTimeout(() => { justOpened = false })
  closeButton.value?.focus()
})

onBeforeUnmount(() => {
  unmounting = true
  if (dialog.value?.open) dialog.value.close()
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
})
</script>

<template>
  <!-- 结构照 ConfirmDialog：<dialog> 铺满视口、自身透明，遮罩交给 ::backdrop，
       点在面板外就是点在 <dialog> 自己身上。
       Laid out like ConfirmDialog: the <dialog> fills the viewport and stays
       transparent, ::backdrop draws the scrim, and a click outside the panel
       lands on the <dialog> itself. -->
  <dialog ref="dialog" class="config-diff" aria-labelledby="config-diff-title" @cancel.prevent="onCancel" @close="onClose" @keydown="onKeydown" @click.self="$emit('close')">
    <section class="config-diff-dialog">
      <header class="config-diff-dialog__header">
        <div>
          <span>配置版本 #{{ version.id }}</span>
          <h2 id="config-diff-title">{{ version.message || '未填写备注' }}</h2>
        </div>
        <button ref="closeButton" class="icon-button" type="button" title="关闭差异预览" @click="$emit('close')"><X :size="17" /></button>
      </header>

      <div class="config-diff-summary">
        <strong>{{ result.entries.length }} 处差异</strong>
        <span>所选版本与当前文件的字段级比较</span>
        <span v-if="result.truncated" class="config-diff-summary__warning">仅显示前 200 处</span>
      </div>

      <div v-if="result.entries.length" class="config-diff-list">
        <article v-for="entry in result.entries" :key="entry.path">
          <header><code>{{ entry.path }}</code><span :class="`config-diff-kind--${entry.kind}`">{{ kindLabels[entry.kind] }}</span></header>
          <div class="config-diff-values">
            <div><small>当前文件</small><pre>{{ formatValue(entry.current) }}</pre></div>
            <div><small>所选版本</small><pre>{{ formatValue(entry.selected) }}</pre></div>
          </div>
        </article>
      </div>
      <div v-else class="config-diff-empty">该版本与当前文件内容一致</div>

      <footer><button class="button button--secondary" type="button" @click="$emit('close')">关闭</button></footer>
    </section>
  </dialog>
</template>

<style scoped>
.config-diff { width: 100%; max-width: 100vw; height: 100dvh; max-height: 100dvh; margin: 0; padding: 24px; display: flex; overflow: hidden; border: 0; background: transparent; }
.config-diff:not([open]) { display: none; }
.config-diff::backdrop { background: rgba(18, 24, 22, .55); }
.config-diff-dialog { width: min(880px, 100%); margin: auto; max-height: min(820px, calc(100vh - 48px)); display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; overflow: hidden; color: #30383a; background: #fff; border: 1px solid #d9dfdc; border-radius: 7px; box-shadow: 0 24px 70px rgba(13, 20, 17, .24); }
.config-diff-dialog__header { min-height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px 12px 18px; border-bottom: 1px solid var(--line); }
.config-diff-dialog__header > div { min-width: 0; display: grid; gap: 3px; }
.config-diff-dialog__header span { color: var(--green); font-size: 12px; font-weight: 700; }
.config-diff-dialog__header h2 { overflow: hidden; color: #28302e; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.config-diff-summary { min-height: 46px; display: flex; align-items: center; gap: 10px; padding: 9px 18px; color: #75807c; background: #f7f9f8; border-bottom: 1px solid var(--line); font-size: 12px; }
.config-diff-summary strong { color: #36403c; font-size: 14px; }
.config-diff-summary__warning { margin-left: auto; color: var(--amber); }
.config-diff-list { min-height: 0; overflow: auto; }
.config-diff-list article { padding: 13px 18px; border-bottom: 1px solid #e7ebe9; }
.config-diff-list article:last-child { border-bottom: 0; }
.config-diff-list article > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.config-diff-list code { min-width: 0; overflow-wrap: anywhere; color: #45514c; font-size: 12px; }
.config-diff-list article > header span { padding: 2px 5px; border-radius: 3px; font-size: 12px; font-weight: 700; }
.config-diff-kind--added { color: #176d4d; background: var(--green-soft); }
.config-diff-kind--removed { color: #9a3737; background: var(--red-soft); }
.config-diff-kind--changed { color: #8b5b18; background: var(--amber-soft); }
.config-diff-values { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 9px; }
.config-diff-values > div { min-width: 0; }
.config-diff-values small { display: block; margin-bottom: 4px; color: #8b9591; font-size: 12px; }
.config-diff-values pre { min-height: 34px; margin: 0; padding: 8px 9px; overflow: auto; color: #36403c; background: #f5f7f6; border: 1px solid #e2e7e4; border-radius: 4px; font: 9px/1.45 "SFMono-Regular", Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.config-diff-empty { min-height: 180px; display: grid; place-items: center; color: #8b9591; font-size: 12px; }
.config-diff-dialog > footer { min-height: 58px; display: flex; align-items: center; justify-content: flex-end; padding: 10px 16px; border-top: 1px solid var(--line); }
@media (max-width: 640px) {
  .config-diff { padding: 10px; }
  .config-diff-dialog { max-height: calc(100vh - 20px); }
  .config-diff-values { grid-template-columns: 1fr; }
  .config-diff-summary > span:not(.config-diff-summary__warning) { display: none; }
}
</style>
