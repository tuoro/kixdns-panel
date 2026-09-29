<script setup lang="ts">
import { MoreHorizontal } from '@lucide/vue'
import type { Component } from 'vue'
import { nextTick, onBeforeUnmount, ref, useId } from 'vue'

export interface UiMenuItem {
  value: string
  label: string
  icon?: Component
  danger?: boolean
  disabled?: boolean
  // 项是机器值（地址、ID）时用等宽 / Mono when the item is a machine value (an address, an ID)
  mono?: boolean
}

// 菜单：默认的触发按钮是「…」，也可以换成自己的内容（子项行的序号就是一个「调整顺序」菜单）。
// 弹层放在顶层（popover），不会被检查器、列表这些滚动容器裁掉；打开时按按钮的位置摆放，下面放不下就往上翻。
// 上下键在项之间移动，Esc、Tab 和点外面关闭，Esc 关闭后焦点回到按钮；危险项放最后、用红字。
// 手机上（≤640）是一张贴着屏幕底边的弹层，标题是菜单的名字，每项 44 高。
// A menu whose trigger is "…" by default or custom content (a sub-item's ordinal is a reorder menu).
// The list lives in the top layer (popover) so scrolling containers never clip it, is placed against
// the trigger and flips up when there is no room below. Arrow keys move between items; Esc, Tab and
// an outside click close it, Esc returning focus to the trigger; the destructive item goes last in red.
// On a phone (≤640) it is a bottom sheet titled with the menu's name, 44px per item.
const props = withDefaults(defineProps<{
  items: readonly UiMenuItem[]
  label: string
  size?: 'md' | 'sm'
  // 弹层和按钮哪一边对齐 / Which edge of the trigger the list lines up with
  align?: 'start' | 'end'
  // 换掉默认的「…」按钮样式；按钮的内容用默认插槽给 / Replaces the default … button styling; slot content is the button's content
  triggerClass?: string
  // 手机底部弹层的标题：说点的是哪一行（「入口 02 · 域名属于 GeoSite cn」），不写「操作」；不给就用 label
  // The phone sheet's title: names the row that was tapped (「入口 02 · 域名属于 GeoSite cn」), never 「操作」; falls back to label
  title?: string
  // 弹层上下让开的那一行（选择器，找按钮最近的祖先）：菜单开在这一行的下面或上面，不盖住这一行的字（审计第二轮 A6）
  // The row the list clears vertically (a selector matched against the trigger's ancestors): the menu opens below or above that row and never covers its text (audit round 2, A6)
  anchor?: string
}>(), { size: 'sm', align: 'end', triggerClass: undefined, title: undefined, anchor: undefined })
const emit = defineEmits<{ select: [value: string] }>()

const id = useId()
const open = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const list = ref<HTMLElement | null>(null)
const phone = window.matchMedia('(max-width: 640px)')
// 按下时菜单是不是开着：点按钮本身是「关上」，不能被点外面的逻辑关掉后又打开
// Whether the menu was open on pointerdown: a click on the trigger closes it and must not reopen it
let openOnPointerDown = false

function enabledItems(): HTMLButtonElement[] {
  return [...(list.value?.querySelectorAll<HTMLButtonElement>('.ui-menu__item:not(:disabled)') ?? [])]
}

function place(): void {
  const menu = list.value
  const button = trigger.value
  if (!menu || !button || phone.matches) return
  const box = button.getBoundingClientRect()
  const row = (props.anchor ? button.closest(props.anchor) : null)?.getBoundingClientRect() ?? box
  const gap = 4
  const width = menu.offsetWidth
  const height = menu.offsetHeight
  const below = window.innerHeight - row.bottom - gap
  const top = below >= height || row.top - gap < height ? row.bottom + gap : row.top - gap - height
  const left = props.align === 'start' ? box.left : box.right - width
  menu.style.setProperty('--menu-x', `${Math.round(Math.min(Math.max(8, left), window.innerWidth - width - 8))}px`)
  menu.style.setProperty('--menu-y', `${Math.round(Math.max(8, top))}px`)
}

// 关着的时候弹层不在页面里（免得和按钮同名的菜单藏在 DOM 里）；打开时先渲染，再放进顶层
// A closed menu is not in the page (so no hidden menu shares the button's name); opening renders it, then lifts it into the top layer
async function show(focusFirst: boolean): Promise<void> {
  if (open.value) return
  open.value = true
  await nextTick()
  const menu = list.value
  if (!menu) return
  menu.showPopover()
  // 刚放进顶层还没画出来：这里同步量尺寸、定位置，第一帧就在对的地方
  // Just entered the top layer and not painted yet: measure and place synchronously so the first frame is right
  place()
  document.addEventListener('pointerdown', onOutside, true)
  document.addEventListener('keydown', onDocumentKey, true)
  window.addEventListener('resize', onViewportChange)
  document.addEventListener('scroll', onScroll, true)
  // 鼠标打开时焦点进弹层本身，上下键接着就能用 / Opened by pointer: focus the list so the arrow keys work at once
  if (focusFirst) enabledItems()[0]?.focus()
  else menu.focus({ preventScroll: true })
}

function hide(returnFocus: boolean): void {
  if (!open.value) return
  open.value = false
  if (list.value?.matches(':popover-open')) list.value.hidePopover()
  document.removeEventListener('pointerdown', onOutside, true)
  document.removeEventListener('keydown', onDocumentKey, true)
  window.removeEventListener('resize', onViewportChange)
  document.removeEventListener('scroll', onScroll, true)
  if (returnFocus) trigger.value?.focus()
}

function onTriggerPointerDown(): void {
  openOnPointerDown = open.value
}

function toggle(event: MouseEvent): void {
  const wasOpen = event.detail === 0 ? open.value : openOnPointerDown
  openOnPointerDown = false
  if (wasOpen) hide(false)
  // 用键盘按回车或空格打开时，焦点直接进第一项 / Opened by keyboard: focus goes to the first item
  else void show(event.detail === 0)
}

function onOutside(event: PointerEvent): void {
  const target = event.target as Node
  if (target === trigger.value || trigger.value?.contains(target)) return
  // 手机上点的是弹层外面的遮罩：事件落在弹层元素自己身上，但位置在它的框外
  // On a phone a tap on the backdrop lands on the popover element itself, outside its box
  if (target === list.value) {
    const box = list.value.getBoundingClientRect()
    if (event.clientY >= box.top && event.clientY <= box.bottom && event.clientX >= box.left && event.clientX <= box.right) return
  } else if (list.value?.contains(target)) return
  hide(false)
}

function onDocumentKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  hide(true)
}

// 页面或滚动容器滚动时弹层跟着按钮走；按钮滚出视口就关掉
// On a page or container scroll the list follows its button; once the button leaves the viewport the menu closes
function onViewportChange(): void {
  const box = trigger.value?.getBoundingClientRect()
  if (!box || box.bottom < 0 || box.top > window.innerHeight) hide(false)
  else place()
}

function onScroll(event: Event): void {
  if (event.target instanceof Node && list.value?.contains(event.target)) return
  onViewportChange()
}

function onKey(event: KeyboardEvent): void {
  const els = enabledItems()
  const at = els.indexOf(document.activeElement as HTMLButtonElement)
  if (event.key === 'ArrowDown') { event.preventDefault(); els[(at + 1) % els.length]?.focus() }
  else if (event.key === 'ArrowUp') { event.preventDefault(); els[(at - 1 + els.length) % els.length]?.focus() }
  else if (event.key === 'Home') { event.preventDefault(); els[0]?.focus() }
  else if (event.key === 'End') { event.preventDefault(); els.at(-1)?.focus() }
  else if (event.key === 'Tab') { event.preventDefault(); hide(true) }
}

function choose(item: UiMenuItem): void {
  hide(true)
  emit('select', item.value)
}

onBeforeUnmount(() => hide(false))
defineExpose({ close: () => hide(false) })
</script>

<template>
  <span class="ui-menu-host">
    <button ref="trigger" :class="triggerClass ?? ['ui-icon-btn', { 'ui-icon-btn--sm': size === 'sm' }]" type="button" :aria-label="label" :title="label" aria-haspopup="menu" :aria-expanded="open" :aria-controls="id" @pointerdown="onTriggerPointerDown" @click="toggle">
      <slot><MoreHorizontal :size="size === 'sm' ? 14 : 16" aria-hidden="true" /></slot>
    </button>
    <div v-if="open" :id="id" ref="list" popover="manual" class="ui-menu ui-menu--pop" role="menu" tabindex="-1" :aria-label="label" @keydown="onKey">
      <p class="ui-menu__title" aria-hidden="true">{{ title ?? label }}</p>
      <template v-for="(item, index) in items" :key="item.value">
        <div v-if="item.danger && index > 0 && !items[index - 1]?.danger" class="ui-menu__sep" role="separator"></div>
        <button class="ui-menu__item" :class="{ 'ui-menu__item--danger': item.danger, 'ui-menu__item--mono': item.mono }" type="button" role="menuitem" tabindex="-1" :disabled="item.disabled" @click="choose(item)">
          <component :is="item.icon" v-if="item.icon" :size="14" aria-hidden="true" />{{ item.label }}
        </button>
      </template>
    </div>
  </span>
</template>
