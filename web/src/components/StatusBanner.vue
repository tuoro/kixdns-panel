<script setup lang="ts">
import { CircleAlert, RefreshCw } from '@lucide/vue'

defineProps<{
  message: string
  stale?: boolean
  busy?: boolean
}>()

defineEmits<{ retry: [] }>()
</script>

<template>
  <section class="status-banner" role="alert">
    <CircleAlert :size="18" />
    <div><strong>{{ stale ? '数据可能已过期' : '读取失败' }}</strong><p>{{ message }}</p></div>
    <button class="icon-button icon-button--small" type="button" title="重试" aria-label="重试" :disabled="busy" @click="$emit('retry')"><RefreshCw :size="15" :class="{ spin: busy }" /></button>
  </section>
</template>
