<script setup lang="ts">
import { vLineDots } from '../../line-dots'

// 一句「甲 · 乙 · 丙」：各段照常折行，「·」贴在前一段末尾，折行落在它后面时藏起来（见 line-dots.ts）
// A sentence 「甲 · 乙 · 丙」: the parts wrap as usual, each 「·」 holds on to the part before it and hides when a wrap
// falls right after it (see line-dots.ts)
defineProps<{ parts: readonly string[] }>()
</script>

<template>
  <span v-line-dots class="ui-dot-text"><template v-for="(part, index) in parts" :key="index"><template v-if="index > 0">{{ ' ' }}</template><span>{{ part }}<span v-if="index < parts.length - 1" data-line-dot>&nbsp;·</span></span></template></span>
</template>
