<script setup lang="ts">
import { ChevronDown, X } from '@lucide/vue'
import { nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'

// 编辑面的外壳：检查器（嵌在工作台里）和一键添加（对话框）共用。头部是区块标题和关闭，
// 中间是表单，底栏只在有东西要提交时出现（规范 3.3、3.5）。对话框在宽屏上右边多一栏执行路径；
// 手机上对话框占满整屏，执行路径收成底栏上方的一行，点开再看。
// The edit-surface shell shared by the workbench inspector and the one-click dialog: a section title
// and close in the header, the form in the middle, and a footer only when there is something to
// submit (spec 3.3, 3.5). The dialog adds an execution-path column on wide screens; on a phone it
// fills the screen and the path folds into one line above the footer.
const props = withDefaults(defineProps<{
  title: string
  closeLabel: string
  embedded?: boolean
  // 执行路径那一栏的一句话总结（手机上折叠时显示） / One-line path summary shown when folded on a phone
  summary?: string
  showPreview?: boolean
  showFooter?: boolean
  // 首次安装时检查器就是起点列表，没有「关上」可言 / On first install the inspector is the start picker and has nothing to close to
  closable?: boolean
  // 对话框里只有一列起点时按内容收小，不撑成一大块空白（审计 D10） / A dialog holding only the start list shrinks to its content instead of a blank expanse (audit D10)
  compact?: boolean
}>(), { embedded: false, summary: '', showPreview: false, showFooter: true, closable: true, compact: false })
const emit = defineEmits<{ cancel: []; submit: [] }>()
defineOptions({ inheritAttrs: false })
const id = useId()
const dialog = ref<HTMLElement | null>(null)
const wide = window.matchMedia('(min-width: 861px)')
const isWide = ref(wide.matches)
let returnFocus: HTMLElement | null = null
let previousOverflow = ''

function resize(event: MediaQueryListEvent): void {
  isWide.value = event.matches
}

// 底栏一出现，表单那一格就矮了一截：正在输入的字段要留在看得见的地方，不能被挤到底栏后面（审计 A1）。
// 滚的是它所在的整条子项（连同协议、ECS 那一行），再保证字段本身看得见（审计第二轮 A7）
// When the footer appears the form area loses its height; the field being typed in must stay in view rather than slip behind it
// (audit A1). The whole sub-item it belongs to (its protocol and ECS line included) scrolls in, then the field itself (audit round 2, A7)
// 表单末尾临时补的高度（像素）：内容比视口只高一点、滚不到最近一组的开头时补上，底栏收起就去掉（审计第四轮 A1）
// Room added at the end of the form (px) when the content is only a little taller than the view and cannot scroll to the nearest group's start; removed when the footer goes (audit round 4, A1)
const room = ref(0)
watch(() => props.showFooter, async (shown) => {
  if (!shown) {
    room.value = 0
    return
  }
  await nextTick()
  const active = document.activeElement
  const editor = active instanceof HTMLElement && dialog.value?.contains(active) ? active.closest<HTMLElement>('.config-guide__editor') : null
  if (editor && active instanceof HTMLElement) await revealEdited(editor, active)
})

// 露出来的是正在改的整张列表，连同它末尾的「添加动作」，底栏的线不会切过字；滚动停下时上沿落在两块之间 24 的空白里
// （一组的开头，或上下排的一条子项的开头），不切字、不贴着头部的线（审计第三轮 A1）
// What comes into view is the whole list being edited, its trailing 添加动作 included, so the footer's rule never cuts through
// text; the scroll then settles with the top edge in a 24 gap between blocks (a group's start, or a stacked sub-item's), so
// nothing is sliced and nothing crowds the header rule (audit round 3, A1)
async function revealEdited(editor: HTMLElement, active: HTMLElement): Promise<void> {
  const pad = parseFloat(getComputedStyle(editor).scrollPaddingTop) || 0
  const view = editor.clientHeight
  const origin = editor.getBoundingClientRect().top - editor.scrollTop
  const top = (element: Element): number => element.getBoundingClientRect().top - origin
  const bottom = (element: Element): number => element.getBoundingClientRect().bottom - origin
  // 露出能放下的最大的一块：整张列表，放不下就这一条子项，这一条也比视口高时就是字段本身（审计第四轮 C6）
  // Reveal the largest block that fits: the whole list, else this sub-item, and the field itself when even the sub-item is taller than the view (audit round 4, C6)
  const fitsView = (element: Element | null): element is HTMLElement => Boolean(element) && bottom(element!) - top(element!) <= view - 2 * pad
  const list = active.closest<HTMLElement>('.ui-rows-host:not(.config-guide__editor)')
  const row = active.closest<HTMLElement>('.ui-rows__row')
  // 能放下的几块从大到小排：最大的一块停不干净（比如整张列表只比视口矮几像素，两条边总切到东西）时，换下一块再找
  // The blocks that fit, largest first: when the largest cannot settle cleanly (say the whole list is only a few pixels shorter than the
  // view, so both edges always cut something), the next one is tried
  const targets = [...new Set([list, row].filter(fitsView)), active]
  const showsOf = (target: Element) => (scroll: number): boolean => top(target) >= scroll + pad - 1 && bottom(target) <= scroll + view - pad + 1
  const current = editor.scrollTop
  if (showsOf(targets[0]!)(current)) return
  const anchorOf = (target: Element): number => (bottom(target) > current + view - pad ? bottom(target) - view + pad : top(target) - pad)
  // 视口的上下沿不从一行字中间切过去，也不从一个按钮的点按格、一个框中间切过去：底栏那条线切着半行字像坏了；
  // 边上露出的一条空白要是还能点（手机上 44 的格子比字高出 12），点了就在看不见的地方加了东西；框里的字（上游框一行一个地址）也是字
  // （审计第六轮 A1、第七轮 A1、第八轮 C2–C4）。只算画出来的：收起的「流程设置」「响应处理」里的东西 Chrome 照样排版、给出位置（审计第七轮 C1）
  // Neither edge of the view may cut through a line of text, a button's tap box or a field: the footer's rule slicing half a line looks
  // broken; a blank strip at an edge that still responds (a phone's 44 box reaches 12 past its text) adds things out of sight; and the text
  // in a field (an upstream box, one address per line) is text too (audit round 6 A1, round 7 A1, round 8 C2–C4). Only what is drawn counts:
  // Chrome still lays out and places the content of a collapsed 流程设置 or 响应处理 (audit round 7, C1)
  const drawn = (element: Element | null): boolean => {
    if (!element) return false
    // Safari 17.4 以前没有 checkVisibility / Safari before 17.4 has no checkVisibility
    if (typeof element.checkVisibility === 'function') return element.checkVisibility()
    return element.getClientRects().length > 0 && !element.closest('details:not([open]) > :not(summary)')
  }
  // 三种东西：字（连同框里的字：多行的上游框整个算，单行的框算中间那一行）；看不见的点按格（按钮、折叠行）；框本身
  // Three kinds: text (with the text in fields: a multi-line upstream box counts whole, a one-line field its middle line); invisible tap
  // boxes (buttons, fold rows); and the fields' frames
  const texts: Array<readonly [number, number]> = []
  const taps: Array<readonly [number, number]> = []
  const frames: Array<readonly [number, number]> = []
  const range = document.createRange()
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim() || !drawn(node.parentElement)) continue
    range.selectNodeContents(node)
    for (const rect of range.getClientRects()) if (rect.height > 0) texts.push([rect.top - origin, rect.bottom - origin])
  }
  for (const control of editor.querySelectorAll('button, summary, [role="button"]')) {
    const rect = control.getBoundingClientRect()
    if (rect.height > 0 && drawn(control)) taps.push([rect.top - origin, rect.bottom - origin])
  }
  for (const field of editor.querySelectorAll('.ui-input')) {
    const rect = field.getBoundingClientRect()
    if (!(rect.height > 0) || !drawn(field)) continue
    frames.push([rect.top - origin, rect.bottom - origin])
    const area = field.querySelector('textarea')
    if (area) {
      texts.push([rect.top - origin, rect.bottom - origin])
    } else {
      const line = parseFloat(getComputedStyle(field).lineHeight) || 21
      const middle = (rect.top + rect.bottom) / 2 - origin
      texts.push([middle - line / 2, middle + line / 2])
    }
  }
  const crosses = (spans: typeof texts, edge: number): boolean => spans.some(([from, to]) => from < edge - 1 && to > edge + 1)
  const both = (spans: typeof texts, scroll: number): boolean => !crosses(spans, scroll) && !crosses(spans, scroll + view)
  // 最好：什么都不切；其次：不切字、不切看不见的点按格（框露一半还看得出是框）；再次：只保证不切字
  // Best: cut nothing; next: cut no text and no invisible tap box (a half-shown field still reads as a field); last: only cut no text
  const clean = (scroll: number): boolean => both(texts, scroll) && both(taps, scroll) && both(frames, scroll)
  const tidy = (scroll: number): boolean => both(texts, scroll) && both(taps, scroll)
  const readable = (scroll: number): boolean => both(texts, scroll)
  const cuts = (edge: number): boolean => crosses(texts, edge) || crosses(taps, edge) || crosses(frames, edge)
  const limit = editor.scrollHeight - view
  // 给一个目标找停的位置：返回滚动位置和要补的高度；只剩「至少不切字」时返回 null，让下一个目标先试
  // Finds where to settle for one target: the scroll and any height to add; returns null when only "cuts no text" is left, so the next target is tried first
  const plan = (target: Element): { scroll: number; room: number } | null => {
    const shows = showsOf(target)
    const next = anchorOf(target)
    const nearest = (scrolls: number[]): number => scrolls.reduce((best, scroll) => (Math.abs(scroll - next) < Math.abs(best - next) ? scroll : best))
    // 1. 上沿先停在各组的开头，以及上一条和它隔着 24 以上的子项（手机上一条子项是一组）。开头上面留出的空白从 24 往下试，
    //    取上下两条边都干净、又露得出要看的那一块的最大的那个：手机上上一组的「添加条件」格子伸进这段空白，上沿就停在两个格子相接的地方
    // 1. The top edge first tries each group's start, and sub-items at least 24 below the previous one (a stacked sub-item on a phone). The
    //    space above a start is tried from 24 down, taking the largest whose two edges are both clean and which still shows the target: on a
    //    phone the previous group's 添加条件 box reaches into that space, so the edge settles where the two boxes meet
    const starts = [...(editor.firstElementChild?.children ?? [])].filter(drawn).map(top)
    for (const item of editor.querySelectorAll('.ui-rows__row')) {
      const previous = item.previousElementSibling
      if (previous && drawn(item) && top(item) - bottom(previous) >= 23) starts.push(top(item))
    }
    const spaces = [pad, 16, 12, 8].filter((space) => space <= pad)
    const atStarts = starts.flatMap((start) => {
      const scroll = spaces.map((space) => start - space).find((candidate) => candidate >= 0 && candidate <= limit && shows(candidate) && clean(candidate))
      return scroll === undefined ? [] : [scroll]
    })
    // 2. 开头都不行时，在最少要滚到的位置附近逐像素找一个两条边都干净的位置 / 2. With no start, search pixel by pixel near the least scroll for a position whose two edges are clean
    const around = (test: (scroll: number) => boolean): number[] => {
      const found: number[] = []
      const from = Math.max(0, Math.floor(next) - 160)
      const to = Math.min(Math.floor(limit), Math.ceil(next) + 160)
      for (let scroll = from; scroll <= to; scroll += 1) if (shows(scroll) && test(scroll)) found.push(scroll)
      return found
    }
    // 3. 最近的一组开头只差一点滚不到，或者正在改的那一组的开头停不下：在表单末尾补上差的高度，下沿落在补上的空白里
    // 3. The nearest start is just out of reach, or the edited group's own start cannot settle: add the missing height at the end of the form, so the lower edge falls in that blank
    const reachable = starts.flatMap((start) => spaces.map((space) => start - space))
      .filter((scroll) => scroll > limit && scroll - limit <= 2 * pad + 48 && shows(scroll) && !cuts(scroll))
    const own = [...(editor.firstElementChild?.children ?? [])].find((group) => group.contains(active))
    const ownStart = own ? spaces.map((space) => top(own) - space).find((scroll) => scroll > limit && shows(scroll) && !cuts(scroll)) : undefined
    // 先后：开头；只差一点的开头（补一点高度）；附近任何干净的位置；正在改的那一组的开头（补高度）
    // Order: a start; a start just out of reach (a little added height); any clean position nearby; the edited group's start (added height)
    const clear = around(clean)
    const neat = clear.length ? clear : around(tidy)
    if (atStarts.length) return { scroll: nearest(atStarts), room: 0 }
    if (reachable.length) { const scroll = nearest(reachable); return { scroll, room: Math.ceil(scroll - limit) } }
    if (neat.length) return { scroll: nearest(neat), room: 0 }
    if (ownStart !== undefined) return { scroll: ownStart, room: Math.ceil(ownStart - limit) }
    return null
  }
  const found = targets.map(plan).find((settle) => settle !== null)
  let next = anchorOf(targets[0]!)
  if (found) {
    next = found.scroll
    if (found.room > 0) {
      room.value = found.room
      await nextTick()
    }
  } else {
    // 哪一块都停不干净：最大的那一块，至少不切字 / No block settles cleanly: the largest one, cutting no text at least
    const shows = showsOf(targets[0]!)
    const soft: number[] = []
    for (let scroll = Math.max(0, Math.floor(next) - 160); scroll <= Math.min(Math.floor(limit), Math.ceil(next) + 160); scroll += 1) if (shows(scroll) && readable(scroll)) soft.push(scroll)
    if (soft.length) next = soft.reduce((best, scroll) => (Math.abs(scroll - next) < Math.abs(best - next) ? scroll : best))
  }
  editor.scrollTop = next
}

function trapFocus(event: KeyboardEvent): void {
  const controls = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], summary, [tabindex]') ?? [])
    .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0)
  const first = controls[0]
  const last = controls.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

function closeBackdrop(event: MouseEvent): void {
  if (event.target !== dialog.value || !dialog.value) return
  const bounds = dialog.value.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) emit('cancel')
}

function onKeydown(event: KeyboardEvent): void {
  // Esc 关闭检查器，焦点交还给打开它的那一行（对话框的 Esc 由 dialog 的 cancel 事件处理）
  // Esc closes the inspector; focus goes back to the row that opened it (the dialog handles Esc via cancel)
  if (props.embedded && props.closable && event.key === 'Escape' && !event.defaultPrevented) {
    event.preventDefault()
    emit('cancel')
  }
  if (!props.embedded && event.key === 'Tab') trapFocus(event)
}

onMounted(() => {
  wide.addEventListener('change', resize)
  if (props.embedded) return
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  if (dialog.value instanceof HTMLDialogElement) dialog.value.showModal()
})

onBeforeUnmount(() => {
  wide.removeEventListener('change', resize)
  if (props.embedded) return
  if (dialog.value instanceof HTMLDialogElement) dialog.value.close()
  document.body.style.overflow = previousOverflow
  returnFocus?.focus({ preventScroll: true })
})
</script>

<template>
  <Teleport to="body" :disabled="embedded">
    <component :is="embedded ? 'section' : 'dialog'" ref="dialog" v-bind="$attrs" class="config-guide" :class="{ 'workbench-guide': embedded, 'config-guide--compact': compact && !embedded }" :aria-labelledby="`${id}-title`" @cancel.prevent="emit('cancel')" @click="!embedded && closeBackdrop($event)" @keydown="onKeydown">
      <header class="config-guide__header">
        <h2 :id="`${id}-title`">{{ title }}</h2>
        <button v-if="closable" class="ui-icon-btn" type="button" :aria-label="closeLabel" :title="closeLabel" @click="emit('cancel')"><X :size="16" /></button>
      </header>
      <form class="config-guide__form" novalidate @submit.prevent="emit('submit')">
        <div class="config-guide__workspace">
          <div class="config-guide__editor ui-rows-host"><slot /><div v-if="room" :style="{ height: `${room}px` }" aria-hidden="true"></div></div>
          <aside v-if="showPreview && isWide" class="config-guide__preview" aria-label="执行路径"><slot name="preview" /></aside>
        </div>
        <details v-if="showPreview && !isWide" class="config-guide__path ui-expand">
          <summary><span>执行路径</span><small><slot name="summary">{{ summary }}</slot></small><ChevronDown :size="16" aria-hidden="true" /></summary>
          <div class="config-guide__path-body"><slot name="preview" /></div>
        </details>
        <footer v-if="showFooter" class="config-guide__footer">
          <div class="config-guide__status" aria-live="polite"><slot name="status" /></div>
          <div class="config-guide__actions"><slot name="actions" /></div>
        </footer>
      </form>
    </component>
  </Teleport>
</template>

<style scoped>
/* 对话框：浮起的面板，头部区块标题；手机上占满整屏（规范 3.5）。只用 tokens.css 的变量。
   Dialog: a floating panel with a section title; full screen on a phone (spec 3.5). Tokens only. */
.config-guide { --rows-act: var(--h-md); width: min(1120px, calc(100vw - var(--s-7))); height: min(920px, calc(100dvh - var(--s-7))); max-width: none; max-height: none; margin: auto; padding: 0; overflow: hidden; border: 0; border-radius: var(--r-3); background: var(--l-surface); color: var(--l-ink); box-shadow: var(--shadow-float); }
.config-guide[open] { display: flex; flex-direction: column; }
/* 选起点的一步只有一列选项：对话框和内容一样高，底下不留一大块白（模态对话框上下都贴着视口，height: auto 会撑满，要写 fit-content；审计第二轮 D4）
   Picking a start is one column of options, so the dialog is as tall as its content with no white slab below (a modal dialog is pinned to
   both viewport edges and height: auto would stretch, hence fit-content; audit round 2, D4) */
.config-guide--compact { width: min(36rem, calc(100vw - var(--s-7))); height: fit-content; max-height: min(920px, calc(100dvh - var(--s-7))); }
.config-guide::backdrop { background: var(--scrim); }
/* 头部左右和表单一样宽：关闭按钮和子项行的 × 落在同一条竖线上（审计 A13） / The header's inset matches the form's, so its close lines up with the rows' × (audit A13) */
.config-guide__header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: var(--s-3); padding: var(--s-4) var(--s-5); border-bottom: 1px solid var(--l-hair); }
/* 标题行和关闭按钮一样高：有没有关闭按钮，头部都一样高，下面的内容不会上下跳（审计 B18） / The title row is as tall as the close button, so the header keeps its height with or without it (audit B18) */
.config-guide__header h2 { min-width: 0; min-height: var(--h-md); display: flex; align-items: center; margin: 0; font-family: var(--f-display); font-size: var(--t-4); font-weight: var(--w-bold); line-height: var(--lh-tight); overflow-wrap: anywhere; }
.config-guide__form { display: flex; flex: 1; flex-direction: column; min-height: 0; }
.config-guide__workspace { display: flex; flex: 1; min-height: 0; }
.config-guide__editor { flex: 1 1 auto; min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scroll-padding-block: var(--s-5); }
/* 手机上窗格自己的内边距是 16：滚动停下时第一行离上沿也是 16，和没滚的时候一样（审计第八轮 A1）
   On a phone the pane's own inset is 16, so a settled scroll keeps its first line 16 under the edge, as when unscrolled (audit round 8, A1) */
@media (max-width: 640px) {
  .config-guide__editor { scroll-padding-block: var(--s-4); }
}
.config-guide__preview { flex: 0 0 20rem; min-width: 0; overflow: auto; padding: var(--s-5); border-left: 1px solid var(--l-hair); background: var(--l-canvas); overscroll-behavior: contain; }
.config-guide__path { flex: 0 0 auto; border-top: 1px solid var(--l-hair); background: var(--l-canvas); }
.config-guide__path > summary { display: flex; align-items: center; gap: var(--s-2); min-height: var(--h-touch); padding: 0 var(--s-5); list-style: none; cursor: pointer; }
.config-guide__path > summary::-webkit-details-marker { display: none; }
.config-guide__path > summary span { flex: 0 0 auto; color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-bold); }
.config-guide__path > summary small { min-width: 0; flex: 1; overflow: hidden; color: var(--l-ink-2); font-size: var(--t-2); text-overflow: ellipsis; white-space: nowrap; }
/* 折叠箭头居中在 × 那一列里，和子项行的 ×、对话框的关闭在同一条竖线上（审计第二轮 D8）
   The chevron centres in the × column, on one line with the rows' × and the dialog's close (audit round 2, D8) */
.config-guide__path > summary svg { flex: 0 0 auto; margin-inline: calc((var(--rows-act) - var(--size-icon)) / 2); color: var(--l-ink-3); transition: transform var(--m-base) var(--ease-out); }
.config-guide__path[open] > summary svg { transform: rotate(180deg); }
.config-guide__path-body { max-height: 45dvh; overflow: auto; padding: 0 var(--s-5) var(--s-4); }
.config-guide__footer { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: var(--s-3); padding: var(--s-3) var(--s-5); border-top: 1px solid var(--l-hair); background: var(--l-surface); }
.config-guide__status { min-width: 0; display: flex; align-items: center; gap: var(--s-2); color: var(--l-ink-2); font-size: var(--t-2); }
.config-guide__actions { display: flex; flex-shrink: 0; gap: var(--s-2); margin-left: auto; }
/* 嵌在工作台里的检查器：没有阴影和圆角，占满右边那一栏。 / The inspector: no shadow or radius, fills its column. */
.workbench-guide { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; margin: 0; border: 0; border-radius: 0; box-shadow: none; }
/* 641–860：对话框仍是浮起的一栏，内边距仍是 24，执行路径收成一行；底栏按钮保持本来的宽度靠右，和保存栏一样。
   嵌在检查器里的那一份在这个宽度已经是整屏的层，和页面一样用 16。整屏和拉宽的按钮只给手机（≤640，规范 3.5、6.4，审计 D7、A22、B17，第二轮 D6）。
   641–860: the dialog still floats as one column with its 24 inset and the path folded into a line; footer buttons keep their
   width on the right, as in the save bar. The copy inside the inspector is already a full-screen layer at these widths and uses
   the page's 16. Full screen and stretched buttons are for phones only (≤640, spec 3.5, 6.4, audits D7, A22, B17, round 2 D6). */
@media (max-width: 860px) {
  .workbench-guide .config-guide__header { padding: var(--s-3) var(--s-4); }
  .workbench-guide :is(.config-guide__footer, .config-guide__path > summary, .config-guide__path-body) { padding-inline: var(--s-4); }
  .config-guide__footer { flex-wrap: wrap; padding-bottom: calc(var(--s-3) + env(safe-area-inset-bottom)); }
  .config-guide__status:empty { display: none; }
}
@media (max-width: 640px) {
  /* 手机上整屏：选起点那一步也是，max-height 不再按浮起的面板算（审计第二轮 D1） / Full screen on a phone, the start picker too: max-height no longer follows the floating panel (audit round 2, D1) */
  .config-guide:not(.workbench-guide) { width: 100vw; height: 100dvh; max-height: none; border-radius: 0; }
  .config-guide { --rows-act: var(--h-md); }
  .config-guide__header { padding: var(--s-3) var(--s-4); }
  :is(.config-guide__footer, .config-guide__path > summary, .config-guide__path-body) { padding-inline: var(--s-4); }
  .config-guide__header h2 { min-height: var(--h-touch); }
  .config-guide__actions { width: 100%; }
  .config-guide__actions > :deep(button) { flex: 1; }
  .config-guide__actions > :deep(.ui-btn--primary) { flex: 2; }
}
@media (prefers-reduced-motion: reduce) { .config-guide__path > summary svg { transition: none; } }
</style>
