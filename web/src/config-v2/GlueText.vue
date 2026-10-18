<script setup lang="ts">
import { computed } from 'vue'
import { hyphenRuns } from '../utils'

// 一句话里带连字符的词（列表名、主机名）连成一块，不在连字符后面断开 / Hyphenated words in a sentence (list names, hosts) stay whole instead of
// breaking after the hyphen
const props = defineProps<{ text: string }>()
const runs = computed(() => hyphenRuns(props.text))
</script>

<template><template v-for="(run, i) in runs" :key="i"><span v-if="run.glue" class="nowrap">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></template>
