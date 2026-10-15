<script setup lang="ts">
import { ChevronDown } from '@lucide/vue'

export interface UiSelectOption {
  value: string
  label: string
  disabled?: boolean
}

// 下拉框：输入框的外框包一个原生 select，箭头自己画。系统弹层和手机滚轮选择器都保留；
// 高度、圆角、边框和输入框一样，同一行里分不出高矮。
// A native select inside the input frame with a drawn chevron. The system popup and
// phone pickers stay; height, radius and border match the input exactly.
withDefaults(defineProps<{
  // 配置里很多字段是可选的，没写时显示空选项 / Many config fields are optional; unset shows the empty option
  modelValue?: string
  options: readonly UiSelectOption[]
  label: string
  size?: 'md' | 'sm'
  disabled?: boolean
  invalid?: boolean
}>(), { size: 'md', disabled: false, invalid: false })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <label class="ui-input ui-select" :class="{ 'ui-input--sm': size === 'sm' }">
    <select :value="modelValue ?? ''" :aria-label="label" :disabled="disabled" :aria-invalid="invalid || undefined" @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)">
      <option v-for="option in options" :key="option.value" :value="option.value" :disabled="option.disabled">{{ option.label }}</option>
    </select>
    <ChevronDown :size="size === 'sm' ? 14 : 16" aria-hidden="true" />
  </label>
</template>
