<script setup lang="ts">
// 区块：只是展示的数据。标题行加一条细线，没有边框和底色。
// A section holds data that is only shown: a title row over a hairline, no border or fill.
defineProps<{ title: string; aside?: string }>()
</script>

<template>
  <section class="ui-section">
    <div class="ui-section__head">
      <h2 class="ui-section__title">{{ title }}</h2>
      <span v-if="aside || $slots.aside" class="ui-section__aside"><slot name="aside">{{ aside }}</slot></span>
    </div>
    <slot />
  </section>
</template>
