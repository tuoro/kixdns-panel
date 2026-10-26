<script setup lang="ts">
import { computed } from 'vue'
import { hyphenRuns, withBreaks, type GlueRun } from '../utils'

// 一句话里带连字符的词（列表名、主机名）连成一块，不在连字符后面断开 / Hyphenated words in a sentence (list names, hosts) stay whole instead of
// breaking after the hyphen
// breaks：普通字在「，：；。、」后面切开、放一个断点（显示成生成的零宽空格，见 styles.css 的 .brk，复制出来是原文；见 withBreaks）
// breaks: plain text is split after 「，：；。、」 with a break point (shown as a generated zero-width space, see .brk in styles.css, so a
// copy reads as the original; see withBreaks)
const props = defineProps<{ text: string; breaks?: boolean }>()
const runs = computed((): GlueRun[] => {
  const all = hyphenRuns(props.text)
  return props.breaks ? withBreaks(all) : all
})
</script>

<template><template v-for="(run, i) in runs" :key="i"><span v-if="run.glue" :class="run.long ? 'glue-block' : 'nowrap'">{{ run.text }}</span><template v-else>{{ run.text }}<span v-if="run.breakAfter" class="brk" aria-hidden="true"></span></template></template></template>
