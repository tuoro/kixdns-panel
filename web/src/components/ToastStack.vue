<script setup lang="ts">
import { CircleAlert, CircleCheck, Info, X } from '@lucide/vue'
import { useToast } from '../composables/useToast'

const toast = useToast()
</script>

<template>
  <div class="toast-stack" aria-live="polite">
    <div v-for="item in toast.messages.value" :key="item.id" class="toast" :class="`toast--${item.kind}`">
      <CircleCheck v-if="item.kind === 'success'" :size="18" />
      <CircleAlert v-else-if="item.kind === 'error'" :size="18" />
      <Info v-else :size="18" />
      <span>{{ item.message }}</span>
      <!-- 可撤销的那条右侧是撤销而不是叉：真正的撤销窗口就是它显示的这段时间，
           摆一个叉等于把唯一有用的动作藏起来。 -->
      <button v-if="item.undo" class="toast-undo" type="button" @click="toast.runUndo(item.id)">撤销</button>
      <button v-else class="icon-button icon-button--small" type="button" title="关闭" @click="toast.dismiss(item.id)">
        <X :size="15" />
      </button>
    </div>
  </div>
</template>
