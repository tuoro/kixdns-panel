<script setup lang="ts">
import { CircleX, Info, TriangleAlert } from '@lucide/vue'
import { computed, ref } from 'vue'
import { KERNEL_UPDATE, KERNEL_UPDATE_LABEL, type KernelNote } from '../kernel-problems'

// 内核报来的一件事（启动时读的配置里要改的写法这类）：一句标题、一句说明，下面逐条列出；条数多时先列三条，其余的点开再看。
// 每条怎么写由插槽决定（配置页让规则名能点）；要更新内核时右侧给去系统页的按钮。和页上别的提示条同一个样子
// One thing the kernel reports (what the config read at startup writes that must change, and the like): a title, a line of
// explanation, then the items one by one; with many, three show and the rest open on a click. The slot decides how each item reads
// (the config page makes rule names links); when the kernel needs updating a button to the system page sits on the right. It looks
// like every other notice on the page
const props = defineProps<{ note: KernelNote }>()
const SHOWN = 3
const open = ref(false)
const items = computed(() => (open.value ? props.note.items : props.note.items.slice(0, SHOWN)))
const hidden = computed(() => props.note.items.length - SHOWN)
</script>

<template>
  <div class="ui-notice kernel-notes" :class="note.tone === 'err' ? 'ui-notice--err' : note.tone === 'off' ? 'ui-notice--off' : ''" :role="note.tone === 'err' ? 'alert' : 'status'">
    <CircleX v-if="note.tone === 'err'" :size="16" aria-hidden="true" />
    <TriangleAlert v-else-if="note.tone === 'warn'" :size="16" aria-hidden="true" />
    <Info v-else :size="16" aria-hidden="true" />
    <span>{{ note.title }}</span>
    <small v-if="note.detail">{{ note.detail }}</small>
    <ul v-if="note.items.length" class="kernel-notes__items">
      <li v-for="(item, i) in items" :key="i"><slot name="item" :text="item">{{ item }}</slot></li>
    </ul>
    <button v-if="hidden > 0" class="ui-btn ui-btn--text ui-btn--sm kernel-notes__more" type="button" :aria-expanded="open" @click="open = !open">{{ open ? '收起' : `其余 ${hidden} 条` }}</button>
    <RouterLink v-if="note.update" class="ui-btn ui-btn--secondary ui-btn--sm ui-notice__action" :to="KERNEL_UPDATE">{{ KERNEL_UPDATE_LABEL }}</RouterLink>
  </div>
</template>

<style>
/* 条目在标题那一栏里，比说明再缩进一点，读得出是一条条的；长的英文原话在哪里都能折行 / The items sit in the title's column, indented a
   little past the explanation so they read as a list; the kernel's long English words wrap anywhere */
.kernel-notes__items { display: grid; gap: var(--s-1); grid-column: 2; margin: var(--s-1) 0 0; padding-left: var(--s-4); color: var(--l-ink-2); font-size: var(--t-2); overflow-wrap: anywhere; }
.kernel-notes__more { grid-column: 2; justify-self: start; margin-left: calc(var(--s-2) * -1); }
</style>
