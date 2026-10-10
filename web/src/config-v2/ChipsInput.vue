<script setup lang="ts">
import { X } from '@lucide/vue'
import { ref, useId } from 'vue'

// 几个值写在一个框里：回车、逗号或空格把字变成一个值，粘贴一串会自动拆开，退格删最后一个。写错的值标红，不挡着继续填。
// Several values in one field: Enter, comma or space turns the text into a value, a pasted list splits itself, Backspace
// removes the last one. A bad value turns red without blocking the rest.
const props = withDefaults(defineProps<{
  modelValue: string[]
  label: string
  placeholder?: string
  suggestions?: readonly string[]
  valid?: (value: string) => boolean
  // TXT 内容里可以有空格，只按回车分开 / TXT content may hold spaces, so only Enter splits
  spaces?: boolean
  upper?: boolean
  invalid?: boolean
}>(), { placeholder: '', suggestions: () => [], valid: () => true, spaces: false, upper: false, invalid: false })
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

const id = useId()
const text = ref('')
const input = ref<HTMLInputElement | null>(null)

function add(raw: string): void {
  const parts = (props.spaces ? raw.split(/\n/) : raw.split(/[\s,，;；]+/)).map((x) => x.trim()).filter(Boolean).map((x) => (props.upper ? x.toUpperCase() : x))
  const next = [...props.modelValue]
  for (const p of parts) if (!next.includes(p)) next.push(p)
  if (next.length !== props.modelValue.length) emit('update:modelValue', next)
}
function commit(): void {
  if (!text.value.trim()) return
  add(text.value)
  text.value = ''
}
function onKey(event: KeyboardEvent): void {
  if (event.isComposing) return
  if (event.key === 'Enter' || (!props.spaces && (event.key === ',' || event.key === ' '))) {
    if (text.value.trim()) { event.preventDefault(); commit() }
    else if (event.key !== 'Enter') event.preventDefault()
  } else if (event.key === 'Backspace' && !text.value && props.modelValue.length) {
    emit('update:modelValue', props.modelValue.slice(0, -1))
  }
}
// 从建议列表里点了一项：直接变成值 / A suggestion was picked from the list: it becomes a value right away
function onInput(event: Event): void {
  if (!(event instanceof InputEvent) || event.inputType === 'insertReplacementText') commit()
}
function onPaste(event: ClipboardEvent): void {
  const pasted = event.clipboardData?.getData('text') ?? ''
  if (!/[\s,，;；]/.test(pasted.trim()) || props.spaces) return
  event.preventDefault()
  add(pasted)
}
function remove(index: number): void {
  emit('update:modelValue', props.modelValue.filter((_, i) => i !== index))
  input.value?.focus()
}
</script>

<template>
  <div class="chips ui-input" :class="{ 'chips--bad': invalid }" @click.self="input?.focus()">
    <span v-for="(value, index) in modelValue" :key="value" class="chip" :class="{ 'chip--bad': !valid(value) }" :title="valid(value) ? value : `${value}：写得不对`">
      <span class="chip__text">{{ value }}</span>
      <button class="chip__x" type="button" :aria-label="`去掉 ${value}`" @click="remove(index)"><X :size="12" aria-hidden="true" /></button>
    </span>
    <input ref="input" v-model="text" :aria-label="label" :aria-invalid="invalid || undefined" :placeholder="modelValue.length ? '' : placeholder" :list="suggestions.length ? id : undefined" autocapitalize="off" autocomplete="off" spellcheck="false" @keydown="onKey" @input="onInput" @paste="onPaste" @blur="commit">
    <datalist v-if="suggestions.length" :id="id"><option v-for="s in suggestions.filter((x) => !modelValue.includes(x))" :key="s" :value="s"></option></datalist>
  </div>
</template>
