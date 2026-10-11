<script setup lang="ts">
import type { DiffBlock } from '../config-model/diff'

// 一份配置和另一份差在哪：每处一块，块里去掉的行在前、加上的行在后。历史版本的比较和保存前的检查共用。
// Where one config differs from another: one block per change, removed lines before added ones. Shared by the version
// comparison and the review before saving.
defineProps<{ blocks: DiffBlock[] }>()
</script>

<template>
  <section v-for="(b, i) in blocks" :key="i" class="diffd__block">
    <h3><span class="diffd__kind">{{ b.kind }}</span>{{ b.title }}<small v-if="b.note">{{ b.note }}</small></h3>
    <ul><li v-for="(l, j) in b.lines" :key="j" :class="l.sign === '+' ? 'is-add' : 'is-del'"><span class="diffd__sign" aria-hidden="true">{{ l.sign === '+' ? '+' : '−' }}</span><span class="visually-hidden">{{ l.sign === '+' ? '加上' : '去掉' }}</span>{{ l.text }}</li></ul>
  </section>
</template>
