<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import { useRoute } from 'vue-router'

// 配置页的门口：带 ?v2=1 走新配置页（③ 改版，还在逐步接上），否则是现有的配置页。③d 切换默认后这一层去掉。
// The config page's door: ?v2=1 opens the new config page (the ③ redesign, still being wired up), otherwise the current one. Removed once ③d makes the new page the default.
const ConfigView = defineAsyncComponent(() => import('./ConfigView.vue'))
const ConfigV2View = defineAsyncComponent(() => import('./ConfigV2View.vue'))
const route = useRoute()
const v2 = computed(() => route.query.v2 !== undefined && route.query.v2 !== '0')
</script>

<template>
  <component :is="v2 ? ConfigV2View : ConfigView" />
</template>
