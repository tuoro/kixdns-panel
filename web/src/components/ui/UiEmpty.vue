<script setup lang="ts">
import type { Component } from 'vue'

// 空状态：标题说现在是什么情况，说明说接下来能做什么，最多一个次要按钮。
// Empty state: the title says what the situation is, the description what
// can be done next, and at most one secondary button follows.
defineProps<{ icon: Component; title: string; desc?: string }>()
</script>

<template>
  <div class="ui-empty">
    <span class="ui-empty__icon" aria-hidden="true"><component :is="icon" :size="18" /></span>
    <p class="ui-empty__title">{{ title }}</p>
    <p v-if="desc" class="ui-empty__desc">{{ desc }}</p>
    <slot />
  </div>
</template>
