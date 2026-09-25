<script setup lang="ts">
import { X } from '@lucide/vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

export type UiTaskState = 'idle' | 'run' | 'done' | 'fail'

// 状态胶囊：要等几秒的操作（安装并切换、在线更新、保存并热加载）。
// 图标位依次是待开始、进行中、完成、失败；进行中自动写已用时间，给了进度就画进度条。
// A status capsule for operations that take a few seconds. The icon slot
// goes idle, running, done, failed; while running it adds the elapsed time,
// and draws a progress bar when a progress value is given.
const props = defineProps<{
  state: UiTaskState
  title: string
  startedAt?: number | null
  progress?: number | null
}>()

const now = ref(Date.now())
let timer: number | undefined
const elapsed = computed(() => (props.startedAt ? Math.max(0, Math.round((now.value - props.startedAt) / 1000)) : null))

watch(() => props.state, (state) => {
  window.clearInterval(timer)
  timer = undefined
  if (state === 'run') {
    now.value = Date.now()
    timer = window.setInterval(() => { now.value = Date.now() }, 1000)
  }
}, { immediate: true })
onBeforeUnmount(() => window.clearInterval(timer))
</script>

<template>
  <div class="ui-task" :data-state="state">
    <span class="ui-task__icon" aria-hidden="true">
      <span v-if="state === 'run'" class="ui-spin"></span>
      <svg v-else-if="state === 'done'" class="ui-check" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
      <X v-else-if="state === 'fail'" :size="15" />
      <slot v-else name="icon" />
    </span>
    <div>
      <div class="ui-task__title">{{ title }}<slot name="title" /></div>
      <div class="ui-task__meta" role="status"><slot name="meta" /><span v-if="state === 'run' && elapsed !== null">已用 {{ elapsed }} 秒</span></div>
    </div>
    <div v-if="$slots.actions" class="ui-task__actions"><slot name="actions" /></div>
    <div v-if="state === 'run' && progress != null" class="ui-task__bar" role="progressbar" :aria-valuenow="Math.round(progress * 100)" aria-valuemin="0" aria-valuemax="100">
      <i :style="{ width: `${Math.round(progress * 100)}%` }"></i>
    </div>
  </div>
</template>
