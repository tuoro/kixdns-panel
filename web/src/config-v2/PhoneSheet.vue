<script setup lang="ts">
import { X } from '@lucide/vue'
import { onMounted, ref } from 'vue'

// 手机上的编辑弹层：贴着屏幕底边，标题、内容、「完成」。改动当场写进草稿，「完成」、点外面或 Esc 都只是收起。
// 只在要编辑时挂上，挂上就打开。
// The phone edit sheet: pinned to the bottom edge with a title, content and 完成. Edits land in the draft as they are made, so
// 完成, a tap outside and Esc all just close it. Mounted only while editing, and opens as it mounts.
defineProps<{ title: string }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const panel = ref<HTMLElement | null>(null)
// 打开时浏览器会把焦点给第一个能聚焦的框，框就显出聚焦的样子；没写 autofocus 的弹层把焦点放在弹层本身
// On open the browser focuses the first focusable field, which then looks focused; a sheet with no autofocus field takes focus itself
onMounted(() => {
  dialog.value?.showModal()
  if (!dialog.value?.querySelector('[autofocus]')) panel.value?.focus({ preventScroll: true })
})
</script>

<template>
  <!-- 所有手机弹层同一种头尾：抓手、左边标题、右边关闭；动作都在底栏，删除在左、完成在右
       Every phone sheet shares one head and foot: grabber, title left, close right; every action sits in the footer, delete left and 完成 right -->
  <dialog ref="dialog" class="psheet" :aria-label="title" @cancel.prevent="emit('close')" @click.self="emit('close')">
    <div ref="panel" class="psheet__panel" tabindex="-1">
      <span class="psheet__grab" aria-hidden="true"></span>
      <header class="psheet__head"><h2>{{ title }}</h2><button class="ui-icon-btn psheet__close" type="button" aria-label="关闭" title="关闭" @click="emit('close')"><X :size="16" /></button></header>
      <div class="psheet__body"><slot /></div>
      <footer class="psheet__foot"><slot name="foot" /><button class="ui-btn ui-btn--primary psheet__done" type="button" @click="emit('close')">完成</button></footer>
    </div>
  </dialog>
</template>
