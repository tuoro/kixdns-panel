<script setup lang="ts">
import { X } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ConfigVersionDetail } from '../../api/types'
import { diffByIdentity, lineSegments, type ChangeGroup, type ChangeKind } from '../../config-editor/changes'
import { normalizeConfig } from '../../config-editor/model'
import type { PhraseSegment } from '../../config-editor/phrase'
import { shortHash } from '../../utils'
import PhraseText from './PhraseText.vue'

const props = defineProps<{
  current: Record<string, unknown>
  version: ConfigVersionDetail
  /** 关闭后接回焦点的元素，缺省时取打开那一刻的焦点。/ Where focus goes on close; defaults to whatever held it on open. */
  returnFocus?: HTMLElement | null
}>()
const emit = defineEmits<{ close: []; restore: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
// 比较的方向固定（评审 N11）：从当前配置到这个版本，也就是「恢复它会对当前配置做什么」。
// − 是恢复会去掉的，+ 是恢复会加上的。按身份对齐（规范第 9 节），入口和它独占的 Pipeline 并成一块。
// The direction is fixed (review N11): from the current config to this version, i.e. what restoring
// it would do. − is what restoring removes, + what it adds. Aligned by identity (spec section 9), with
// an entry and the Pipeline only it uses merged into one block.
const result = computed(() => diffByIdentity(normalizeConfig(props.current), normalizeConfig(props.version.content)))
const blocks = computed(() => {
  const units = new Map<string, ChangeGroup[]>()
  for (const group of result.value.groups) units.set(group.unit, [...(units.get(group.unit) ?? []), group])
  return [...units.values()]
})

// 和图例同一套词：恢复会「去掉」「加上」「改了」「移动」 / The legend's words: restoring removes, adds, changes, moves
const kindLabels: Record<ChangeKind, string> = {
  added: '加上',
  removed: '去掉',
  changed: '改了',
  moved: '移动',
}

// 标题里的 Pipeline ID 和源域名是机器值，和下面那几行一样等宽（审计 D5） / Pipeline IDs and source domains in titles are machine values, mono like the lines below (audit D5)
function titleSegments(group: ChangeGroup): PhraseSegment[] {
  const found = /^(Pipeline |映射 )(.+)$/.exec(group.title)
  return found && (group.subject === 'pipeline' || group.subject === 'mapping')
    ? [{ text: found[1]!, code: false }, { text: found[2]!, code: true }]
    : [{ text: group.title, code: false }]
}

function moveNote(group: ChangeGroup): string {
  return group.from !== undefined && group.to !== undefined ? `从第 ${group.from} 位移到第 ${group.to} 位` : ''
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
          <h2 id="config-diff-title">#{{ version.id }}&nbsp;· {{ version.message || '未填写备注' }}</h2>
          <p>{{ result.count ? `和当前比，${result.count} 处不同` : '和当前一样' }}&nbsp;· {{ version.actor }}&nbsp;· <code>{{ shortHash(version.sha256, 8) }}</code></p>
        </div>
        <button ref="closeButton" class="ui-icon-btn" type="button" aria-label="关闭" title="关闭比较" @click="$emit('close')"><X :size="16" /></button>
      </header>

      <!-- 一件东西一块：标题是它的身份和怎么变了，下面是 − / + 行；机器值等宽。不用红绿，用左边的记号。
           One block per thing: its identity and how it changed, then − / + lines, machine values in mono.
           No red or green; the mark on the left carries it. -->
      <div v-if="blocks.length" class="config-diff-list">
        <p class="config-diff-legend">恢复这个版本：<span><i class="ui-diff__mark">−</i>去掉</span><span><i class="ui-diff__mark">+</i>加上</span></p>
        <article v-for="block in blocks" :key="block[0]!.unit" class="config-diff-block">
          <!-- 只属于这个入口的 Pipeline 缩进挂在入口下面，标题写「连同」：一块只有一个主标题（审计 D24）
               A Pipeline only this entry uses hangs indented under the entry, titled 「连同」: one block, one main title (audit D24) -->
          <section v-for="(group, index) in block" :key="group.key" class="config-diff-group" :class="{ 'is-sub': index > 0 }">
            <header><span class="config-diff-block__title"><template v-if="index > 0">连同 </template><PhraseText :phrase="titleSegments(group)" /></span><span class="config-diff-block__kind">{{ kindLabels[group.kind] }}<template v-if="moveNote(group)">&nbsp;· {{ moveNote(group) }}</template></span></header>
            <!-- 每行按「·」分段、机器值整块换行：手机上「300」和「秒」、「→」和目标不会分在两行（审计 D2）
                 Lines split into runs at 「·」 with machine values whole, so on a phone 「300」 and 「秒」 or 「→」 and its target never part (audit D2) -->
            <div v-if="group.lines.length" class="ui-diff">
              <div v-for="(line, lineIndex) in group.lines" :key="lineIndex" :class="line.mark === '-' ? 'is-del' : 'is-add'">
                <i class="ui-diff__mark" :aria-label="line.mark === '-' ? '去掉' : '加上'">{{ line.mark === '-' ? '−' : '+' }}</i>
                <span class="ui-diff__text"><PhraseText :phrase="lineSegments(line)" /></span>
              </div>
            </div>
          </section>
        </article>
      </div>
      <div v-else class="config-diff-empty">这个版本和当前的配置一样，恢复它不会改变什么。</div>

      <footer v-if="blocks.length" class="config-diff-dialog__footer">
        <button class="ui-btn ui-btn--primary" type="button" @click="$emit('restore')">恢复为版本 #{{ version.id }}</button>
      </footer>
    </section>
  </dialog>
</template>

<style scoped>
/* 版本比较只用 tokens.css 的变量；关闭只有右上角一个。 / Tokens only; one close control at the top right. */
.config-diff { width: 100%; max-width: 100vw; height: 100dvh; max-height: 100dvh; margin: 0; padding: var(--s-5); display: flex; overflow: hidden; border: 0; background: transparent; }
.config-diff:not([open]) { display: none; }
.config-diff::backdrop { background: var(--scrim); }
.config-diff-dialog { width: min(46rem, 100%); max-height: min(820px, calc(100dvh - var(--s-7))); margin: auto; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden; border-radius: var(--r-3); background: var(--l-surface); color: var(--l-ink); box-shadow: var(--shadow-float); }
.config-diff-dialog__header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s-4); padding: var(--s-4) var(--s-5); border-bottom: 1px solid var(--l-hair); }
.config-diff-dialog__header > div { min-width: 0; display: grid; gap: var(--s-1); }
.config-diff-dialog__header h2 { margin: 0; font-family: var(--f-display); font-size: var(--t-4); font-weight: var(--w-bold); line-height: var(--lh-tight); overflow-wrap: anywhere; }
.config-diff-dialog__header code { font-family: var(--f-mono); }
.config-diff-dialog__header p { margin: 0; color: var(--l-ink-2); font-size: var(--t-2); }
/* 行里等宽的摘要只占字那么高，这一行还是 1lh（审计第六轮扫查） / The mono hash in the line takes only its glyph height, so the line stays 1lh (round-6 sweep) */
.config-diff-dialog__header p code { line-height: 1; }
/* 关闭按钮的中线对着标题那一行，和别的层一样，不对着标题加副标题的整块（审计第四轮 D5）
   The close button centres on the title's line, as in every other layer, not on the title-plus-subtitle block (audit round 4, D5) */
.config-diff-dialog__header > .ui-icon-btn { margin-block: calc((var(--t-4) * var(--lh-tight) - var(--h-md)) / 2); }
/* 四边 24，和一键添加的对话框一样；手机上 16（规范 6.4，审计第四轮 D6） / 24 on every side like the rule dialog; 16 on a phone (spec 6.4, audit round 4, D6) */
.config-diff-list { min-height: 0; overflow: auto; display: grid; align-content: start; gap: var(--s-5); padding: var(--s-5); overscroll-behavior: contain; }
/* 全角冒号收成半角宽：冒号后面和两个记号之间一样隔 12（审计第二轮 D14） / The full-width colon set half width, so the gap after it matches the 12 between the keys (audit round 2, D14) */
.config-diff-legend { display: flex; gap: var(--s-3); margin: 0; color: var(--l-ink-3); font-size: var(--t-1); font-feature-settings: "halt"; }
.config-diff-legend span { font-variant-numeric: tabular-nums; }
/* 图例里的 − / + 就是下面每一行用的那个记号，一样大；等宽字的数学轴比中文的中线低，往上提 0.125em 才落在「去掉」「加上」的中线上（审计第七轮 D2）
   The legend's − / + are the very marks the lines use, the same size; the mono math axis sits below the Chinese centre, so they rise 0.125em onto the labels' centre line (audit round 7, D2) */
.config-diff-legend .ui-diff__mark { position: relative; top: -0.125em; margin-inline-end: var(--s-1); font-size: var(--t-2); line-height: 1; }
.config-diff-block { display: grid; gap: var(--s-3); }
.config-diff-group { display: grid; gap: var(--s-2); }
.config-diff-group > header { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-1) var(--s-2); }
/* 缩进和 − / + 那一列一样宽：「连同」那一块的标题和字对着上面几行的正文 / Indented by the − / + column, so the 「连同」 block's title lines up with the text above */
.config-diff-group.is-sub { padding-left: calc(var(--s-2) + 1.25rem); }
.config-diff-block__title { color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-medium); }
.config-diff-group.is-sub .config-diff-block__title { color: var(--l-ink-2); }
/* 划掉的线是整行的背景，画在字下面，行内块照样压在线上面，不用再单独划（审计第四轮 D2）
   The strike is the line's background, drawn under the glyphs, so inline blocks sit on it too and need no strike of their own (audit round 4, D2) */
/* 全角括号收成半宽：删除线不会拖到「）」外面半个字（审计 D12） / Full-width brackets set half-width, so the strike never runs half a character past 「）」 (audit D12) */
.ui-diff__text { font-feature-settings: "halt"; }
.config-diff-block__kind { color: var(--l-ink-2); font-size: var(--t-2); }
.config-diff-block code { font-family: var(--f-mono); }
.config-diff-empty { min-height: calc(var(--s-8) * 3); display: grid; place-items: center; padding: var(--s-5); color: var(--l-ink-2); font-size: var(--t-3); text-align: center; }
.config-diff-dialog__footer { display: flex; justify-content: flex-end; padding: var(--s-3) var(--s-5); border-top: 1px solid var(--l-hair); }
@media (max-width: 640px) {
  .config-diff { padding: 0; }
  .config-diff-dialog { width: 100%; max-height: none; height: 100dvh; border-radius: 0; }
  /* 手机上整层的左右都是 16（审计 D16） / On a phone the whole layer is inset 16 on both sides (audit D16) */
  .config-diff-dialog__header, .config-diff-list { padding-inline: var(--s-4); }
  .config-diff-dialog__header { padding-block: var(--s-3); }
  .config-diff-dialog__header > .ui-icon-btn { margin-block: calc((var(--t-4) * var(--lh-tight) - var(--h-touch)) / 2); }
  .config-diff-list { padding-block: var(--s-4); }
  .config-diff-dialog__footer { padding: var(--s-3) var(--s-4) calc(var(--s-3) + env(safe-area-inset-bottom)); }
  .config-diff-dialog__footer .ui-btn { flex: 1; }
}
</style>
