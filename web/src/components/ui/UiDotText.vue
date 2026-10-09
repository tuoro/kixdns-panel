<script setup lang="ts">
import { vLineDots } from '../../line-dots'

// 一句「甲 · 乙 · 丙」：各段照常折行，「·」贴在前一段末尾，折行落在它后面时藏起来（见 line-dots.ts）
// A sentence 「甲 · 乙 · 丙」: the parts wrap as usual, each 「·」 holds on to the part before it and hides when a wrap
// falls right after it (see line-dots.ts)
defineProps<{ parts: readonly string[] }>()
// 一段以「」）】》这类收尾标点结束时，标点自带半个字的空白，点前面不再加空格，只用不占宽的连接符贴住（不让点跑到下一行开头）
// When a part ends in a closing mark such as 」 or ）, the mark already carries half a character of blank, so the dot takes no
// space before it, only a zero-width joiner that keeps it from starting the next line
const CLOSING = /[\u300d\u300f\uff09\u3011\u300b\u3009]$/
// 十个字以内的一段整段换行：「不」不会被留在上一行的点后面 / A part of ten characters or fewer wraps whole, so 不 is never left behind after a dot
const SHORT = 10
const dot = (part: string) => (CLOSING.test(part) ? '\u2060\u00b7' : '\u00a0\u00b7')
</script>

<template>
  <span v-line-dots class="ui-dot-text"><template v-for="(part, index) in parts" :key="index"><template v-if="index > 0">{{ ' ' }}</template><span :class="{ nowrap: part.length <= SHORT }">{{ part }}<span v-if="index < parts.length - 1" data-line-dot>{{ dot(part) }}</span></span></template></span>
</template>
