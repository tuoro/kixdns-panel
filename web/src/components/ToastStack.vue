<script setup lang="ts">
import { CircleAlert, CircleCheck, Info, X } from '@lucide/vue'
import { computed } from 'vue'
import { useToast } from '../composables/useToast'

const toast = useToast()
// 提示末尾的排查命令（查看原因：journalctl …）用等宽字，按词放在一起，只在空格处换行：以前会在连字符处断开（kixdns-panel- / update.service）
// A trailing command (查看原因：journalctl …) is set in mono with each word kept whole, so it wraps only at spaces: it used to break at hyphens (kixdns-panel- / update.service)
const COMMAND = /((?:journalctl|systemctl|kixdns-panel-server)(?: \S+)+)\s*$/
const items = computed(() => toast.messages.value.map((item) => {
  const match = item.message.match(COMMAND)
  return match?.index === undefined
    ? { ...item, text: item.message, command: [] as string[] }
    : { ...item, text: item.message.slice(0, match.index), command: match[1]!.split(' ') }
}))
</script>

<template>
  <div class="toast-stack" aria-live="polite">
    <div v-for="item in items" :key="item.id" class="toast" :class="`toast--${item.kind}`">
      <CircleCheck v-if="item.kind === 'success'" :size="18" />
      <CircleAlert v-else-if="item.kind === 'error'" :size="18" />
      <Info v-else :size="18" />
      <span>{{ item.text }}<code v-if="item.command.length" class="toast-cmd"><template v-for="(word, index) in item.command" :key="index">{{ index ? ' ' : '' }}<span class="toast-cmd__word">{{ word }}</span></template></code></span>
      <!-- 可撤销的那条右侧是撤销而不是叉：真正的撤销窗口就是它显示的这段时间，
           摆一个叉等于把唯一有用的动作藏起来。 -->
      <button v-if="item.undo" class="toast-undo" type="button" @click="toast.runUndo(item.id)">撤销</button>
      <button v-else class="icon-button icon-button--small toast-close" type="button" title="关闭" aria-label="关闭提示" @click="toast.dismiss(item.id)">
        <X :size="16" />
      </button>
    </div>
  </div>
</template>
