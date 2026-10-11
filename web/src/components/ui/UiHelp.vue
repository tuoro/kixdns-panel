<script setup lang="ts">
import { CircleHelp } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useHelp } from '../../composables/useHelp'
import { helpTopic } from '../../help/topics'

// 概念旁边的「?」：点开一个小弹层，三四句说清楚这是什么、什么时候用、内核实际怎么做；底部一行直通帮助抽屉。
// 弹层和 UiMenu 一样放进顶层（不会被右栏的滚动区裁掉，也能盖在抽屉上），按按钮的位置摆，出不了屏；手机上从底部升起，带遮罩。
// The 「?」 beside a concept: a small popover saying what it is, when to use it and what the kernel does; a line at the bottom opens the help drawer.
// Like UiMenu the popover lives in the top layer (never clipped by the inspector's scroll area, and above an open drawer), placed by the button and kept on screen; on phones it rises from the bottom over a scrim.
const props = defineProps<{ topic: string }>()
const route = useRoute()
const help = useHelp()
const topic = computed(() => helpTopic(props.topic))
const open = ref(false)
const button = ref<HTMLButtonElement | null>(null)
const pop = ref<HTMLElement | null>(null)

function place(): void {
  const el = pop.value, b = button.value
  if (!el || !b || window.matchMedia('(max-width: 640px)').matches) return
  const box = b.getBoundingClientRect()
  const gap = 8, edge = 16
  const width = el.offsetWidth, height = el.offsetHeight
  const below = window.innerHeight - box.bottom - gap
  const top = below >= height + edge || box.top - gap < height + edge ? box.bottom + gap : box.top - gap - height
  const left = Math.min(Math.max(edge, box.left - gap), window.innerWidth - width - edge)
  el.style.setProperty('--help-x', `${Math.round(left)}px`)
  el.style.setProperty('--help-y', `${Math.round(Math.max(edge, top))}px`)
}

async function show(): Promise<void> {
  if (open.value) return
  open.value = true
  await nextTick()
  if (!pop.value) return
  pop.value.showPopover()
  place()
  pop.value.focus({ preventScroll: true })
  document.addEventListener('pointerdown', onOutside, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', place)
  document.addEventListener('scroll', place, true)
}
function hide(returnFocus: boolean): void {
  if (!open.value) return
  if (pop.value?.matches(':popover-open')) pop.value.hidePopover()
  open.value = false
  document.removeEventListener('pointerdown', onOutside, true)
  document.removeEventListener('keydown', onKey, true)
  window.removeEventListener('resize', place)
  document.removeEventListener('scroll', place, true)
  if (returnFocus) button.value?.focus()
}
function toggle(): void { if (open.value) hide(false); else void show() }
function onOutside(event: PointerEvent): void {
  const target = event.target as Node
  if (button.value?.contains(target)) return
  // 手机上点遮罩：事件落在弹层元素自己身上，但位置在它的框外 / On a phone a tap on the scrim lands on the popover element, outside its box
  if (target === pop.value) {
    const r = pop.value.getBoundingClientRect()
    if (event.clientY >= r.top && event.clientY <= r.bottom && event.clientX >= r.left && event.clientX <= r.right) return
  } else if (pop.value?.contains(target)) return
  hide(false)
}
function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  hide(true)
}
function more(): void {
  hide(false)
  help.show(route.path.startsWith('/config') ? 'config' : 'overview', 'topics', props.topic)
}
onBeforeUnmount(() => hide(false))
</script>

<template>
  <span v-if="topic" class="ui-help">
    <button ref="button" class="ui-help__btn" type="button" :aria-label="`什么是${topic.title}`" aria-haspopup="dialog" :aria-expanded="open" @click.stop.prevent="toggle"><CircleHelp :size="14" aria-hidden="true" /></button>
    <div v-if="open" ref="pop" popover="manual" class="ui-help__pop" role="dialog" :aria-label="topic.title" tabindex="-1">
      <strong class="ui-help__title">{{ topic.title }}</strong>
      <p v-for="(line, i) in topic.body" :key="i">{{ line }}</p>
      <button class="ui-help__more" type="button" @click="more">全部说明和快捷键</button>
    </div>
  </span>
</template>
