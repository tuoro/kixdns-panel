<script setup lang="ts">
// 页头：标题就是导航上的名字，下面一行写事实，右边放操作、最多一个主按钮。
// stack：手机上操作换到标题下面一行并各占一份宽度（系统页的重启、停止）。
// Page header: the title is the navigation label, one line of facts below,
// actions on the right with at most one primary button. `stack` moves the
// actions under the title on a phone, each taking an equal share of the width.
defineProps<{ title: string; stack?: boolean }>()
</script>

<template>
  <header class="ui-ph" :class="{ 'ui-ph--stack': stack }">
    <div>
      <h1 class="ui-ph__title">{{ title }}</h1>
      <div v-if="$slots.meta" class="ui-ph__meta"><slot name="meta" /></div>
    </div>
    <div v-if="$slots.actions" class="ui-ph__actions"><slot name="actions" /></div>
  </header>
</template>
