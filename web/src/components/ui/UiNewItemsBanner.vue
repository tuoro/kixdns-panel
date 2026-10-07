<script setup lang="ts">
import { ArrowUp, RefreshCw } from '@lucide/vue'

// 新数据提示条：读者在读别处时新数据先攒着，吸在列表顶端，点了才放进来。
// New-data banner: while the reader is elsewhere new data waits here, stuck
// to the top of the list, and comes in only when pressed.
// disabled：有请求在路上时不能再点，免得两次加载互相覆盖 / disabled: not pressable while a request is in flight, so two loads never overwrite each other
defineProps<{ label: string; loading?: boolean; disabled?: boolean }>()
defineEmits<{ show: [] }>()
</script>

<template>
  <button class="ui-banner" type="button" :disabled="loading || disabled" @click="$emit('show')">
    <RefreshCw v-if="loading" :size="14" class="spin" aria-hidden="true" /><ArrowUp v-else :size="14" aria-hidden="true" />{{ loading ? '正在加载' : label }}
  </button>
</template>
