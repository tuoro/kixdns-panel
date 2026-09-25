<script setup lang="ts">
import type { Component } from 'vue'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

export interface UiTabItem {
  value: string
  label: string
  icon?: Component
  disabled?: boolean
}

// 两种用法一个组件：区块页签换一整块内容（下划线），筛选分段换同一份列表的条件（下沉轨道）。
// 选中的指示块滑过去；系统开了「减少动态效果」时样式表把过渡关掉，直接到位。
// One component for both: section tabs swap a whole block (underline), a
// segmented filter changes the condition on the same list (sunk track). The
// indicator slides; under reduced motion the stylesheet drops the transition.
const props = withDefaults(defineProps<{
  modelValue: string
  items: readonly UiTabItem[]
  label: string
  variant?: 'tabs' | 'segment'
  // 分段放进列表行或状态胶囊时用 sm，和同一行的行内按钮一样高
  // Use sm for a segmented control inside a list row or capsule, matching the inline buttons beside it
  size?: 'md' | 'sm'
  idPrefix?: string
}>(), { variant: 'tabs', size: 'md', idPrefix: '' })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const root = ref<HTMLElement | null>(null)
const indicator = ref<HTMLElement | null>(null)
let observer: ResizeObserver | undefined

function selected(): HTMLElement | null {
  return root.value?.querySelector<HTMLElement>(props.variant === 'tabs' ? '[aria-selected="true"]' : '[aria-pressed="true"]') ?? null
}

function place(animate: boolean): void {
  const ind = indicator.value
  if (!ind) return
  const target = selected()
  if (!animate) ind.style.transition = 'none'
  ind.style.width = target ? `${target.offsetWidth}px` : '0px'
  ind.style.transform = `translateX(${target ? target.offsetLeft : 0}px)`
  if (!animate) {
    void ind.offsetWidth
    ind.style.transition = ''
  }
}

function select(value: string): void {
  if (value !== props.modelValue) emit('update:modelValue', value)
}

function moveFocus(event: KeyboardEvent, index: number): void {
  const enabled = props.items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0)
  const at = enabled.indexOf(index)
  let next: number | undefined
  if (event.key === 'ArrowRight') next = enabled[(at + 1) % enabled.length]
  else if (event.key === 'ArrowLeft') next = enabled[(at + enabled.length - 1) % enabled.length]
  else if (event.key === 'Home') next = enabled[0]
  else if (event.key === 'End') next = enabled[enabled.length - 1]
  if (next === undefined) return
  event.preventDefault()
  select(props.items[next]!.value)
  root.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
}

watch(() => props.modelValue, () => { void nextTick(() => place(true)) })
watch(() => props.items, () => { void nextTick(() => place(false)) })
onMounted(() => {
  place(false)
  if (root.value) {
    observer = new ResizeObserver(() => place(false))
    observer.observe(root.value)
  }
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div v-if="variant === 'tabs'" ref="root" class="ui-tabs" role="tablist" :aria-label="label">
    <button v-for="(item, index) in items" :id="idPrefix ? `${idPrefix}-tab-${item.value}` : undefined" :key="item.value" type="button"
      role="tab" class="ui-tabs__tab" :aria-selected="modelValue === item.value" :aria-controls="idPrefix ? `${idPrefix}-panel-${item.value}` : undefined"
      :tabindex="modelValue === item.value ? 0 : -1" :disabled="item.disabled" @click="select(item.value)" @keydown="moveFocus($event, index)">{{ item.label }}</button>
    <i ref="indicator" class="ui-tabs__ind" aria-hidden="true"></i>
  </div>
  <div v-else ref="root" class="ui-seg" :class="{ 'ui-seg--sm': size === 'sm' }" role="group" :aria-label="label">
    <button v-for="item in items" :key="item.value" type="button" class="ui-seg__opt" :aria-pressed="modelValue === item.value"
      :disabled="item.disabled" @click="select(item.value)"><component :is="item.icon" v-if="item.icon" :size="14" aria-hidden="true" />{{ item.label }}</button>
    <i ref="indicator" class="ui-seg__ind" aria-hidden="true"></i>
  </div>
</template>
