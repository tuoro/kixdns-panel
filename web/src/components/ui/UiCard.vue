<script setup lang="ts">
// 卡片只给能作为一个整体操作的东西（有自己的按钮或状态）；只是展示的数据用 UiSection。卡片不套卡片。
// A card is for something acted on as a whole (it has its own actions or
// state); data that is only shown goes in a UiSection. Cards never nest.
defineProps<{ title?: string; desc?: string; flush?: boolean }>()
</script>

<template>
  <section class="ui-card">
    <header v-if="title || $slots.title || $slots.actions" class="ui-card__head">
      <div>
        <h2 class="ui-card__title">{{ title }}<slot name="title" /></h2>
        <p v-if="desc" class="ui-card__desc">{{ desc }}</p>
      </div>
      <div v-if="$slots.actions" class="ui-card__actions"><slot name="actions" /></div>
    </header>
    <div :class="{ 'ui-card__body': !flush }"><slot /></div>
    <footer v-if="$slots.foot" class="ui-card__foot"><slot name="foot" /></footer>
  </section>
</template>
