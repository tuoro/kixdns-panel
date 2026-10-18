<script setup lang="ts">
import type { DiffBlock } from '../config-model/diff'
import GlueText from './GlueText.vue'

// 一份配置和另一份差在哪：每处一块，块里去掉的行在前、加上的行在后。历史版本的比较和保存前的检查共用。
// Where one config differs from another: one block per change, removed lines before added ones. Shared by the version
// comparison and the review before saving.
defineProps<{ blocks: DiffBlock[] }>()
</script>

<template>
  <template v-for="(b, i) in blocks" :key="i">
  <!-- 说明不是一处不同：不写「改了」，只是一句话 / A note is not a difference: no 改了, just a sentence -->
  <p v-if="b.aside" class="diffd__aside">{{ b.title }}：{{ b.note }}</p>
  <section v-else class="diffd__block">
    <h3><span class="diffd__kind">{{ b.kind }}</span><span><GlueText :text="b.title" /></span><small v-if="b.note">{{ b.note }}</small></h3>
    <ul><li v-for="(l, j) in b.lines" :key="j" :class="l.sign === '+' ? 'is-add' : 'is-del'"><span class="diffd__sign" aria-hidden="true">{{ l.sign === '+' ? '+' : '−' }}</span><span class="visually-hidden">{{ l.sign === '+' ? '加上' : '去掉' }}</span>{{ l.text }}</li></ul>
  </section>
  </template>
</template>
