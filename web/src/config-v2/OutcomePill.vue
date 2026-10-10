<script setup lang="ts">
import { computed } from 'vue'
import { outcomePill, type Outcome } from '../config-model/model'
import { model } from './store'

// 列表里的结果：动词加客户端实际拿到什么。拦截用红，引用断了用黄，「继续」是虚线，其余都是中性色。
// The outcome in the list: a verb and what the client actually gets. Block is red, a broken reference amber, continue dashed, the rest neutral.
const props = defineProps<{ outcome: Outcome }>()
const pill = computed(() => outcomePill(model, props.outcome))
</script>

<template>
  <span class="opill" :class="{ 'opill--block': outcome.type === 'block', 'opill--pass': outcome.type === 'continue', 'opill--broken': pill.broken }" :title="`${pill.verb} · ${pill.value}`">
    <span class="opill__verb">{{ pill.verb }}</span><span class="opill__val" :class="{ 'is-mono': pill.mono }">{{ pill.value }}</span>
  </span>
</template>
