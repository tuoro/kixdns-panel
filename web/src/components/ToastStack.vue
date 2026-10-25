<script setup lang="ts">
import { CircleAlert, CircleCheck, Info, X } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useToast } from '../composables/useToast'
import { vLineDots } from '../line-dots'
import NameText from '../config-v2/NameText.vue'
import { toastRuns } from '../utils'

const toast = useToast()
// 提示末尾的排查命令（查看原因：journalctl …）用等宽字，按词放在一起，只在空格处换行：以前会在连字符处断开（kixdns-panel- / update.service）
// A trailing command (查看原因：journalctl …) is set in mono with each word kept whole, so it wraps only at spaces: it used to break at hyphens (kixdns-panel- / update.service)
const COMMAND = /((?:journalctl|systemctl|kixdns-panel-server)(?: \S+)+)\s*$/
// 选项和它的值连在一起（-u kixdns.service、-n 50），只在这些单位之间换行 / An option stays with its value (-u kixdns.service, -n 50); lines break only between these units
function commandUnits(command: string): string[] {
  const words = command.split(' ')
  const units: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    const value = words[i + 1]
    if (word.startsWith('-') && value !== undefined && !value.startsWith('-')) { units.push(`${word} ${value}`); i++ } else units.push(word)
  }
  return units
}
// 打开着的模态对话框（抽屉、确认框）在顶层，盖住页面上的一切，外面的东西也点不到：有它时提示放进最上面那个里，才看得见、点得到；没有时留在原处
// An open modal dialog (a drawer, a confirm) sits in the top layer above everything and makes the rest inert: while one is open the toasts go inside the
// topmost one, so they show and take clicks; otherwise they stay where they are
const modals = ref<HTMLDialogElement[]>([])
const topModal = computed(() => modals.value.at(-1) ?? null)
function trackModals(): void {
  const open = [...document.querySelectorAll('dialog')].filter((dialog) => dialog.open && dialog.matches(':modal'))
  // 先开的在前、后开的在后：叠着的时候放进最后开的那个 / Earlier ones first, later ones last: when stacked, the last one opened gets them
  modals.value = [...modals.value.filter((dialog) => open.includes(dialog)), ...open.filter((dialog) => !modals.value.includes(dialog))]
}
// 框里贴着底边的那一块（抽屉的按钮栏、手机上从底边升起的确认框）：提示放到它上面，不盖住「完成」「取消」和要回答的问题
// The part of the dialog anchored to the bottom edge (a drawer's button bar, a phone confirm rising from the bottom): the toasts sit above it, never over
// 完成 / 取消 or the question being asked
const lift = ref(0)
function measureLift(): void {
  const modal = topModal.value
  if (!modal) { lift.value = 0; return }
  const floor = window.innerHeight
  const tops = [...modal.querySelectorAll<HTMLElement>('.pdrawer__foot, .pdialog__foot, .confirm__dialog')]
    .map((el) => el.getBoundingClientRect())
    .filter((rect) => rect.height > 0 && rect.bottom >= floor - 1)
    .map((rect) => rect.top)
  lift.value = tops.length ? Math.max(0, Math.round(floor - Math.min(...tops))) : 0
}
const remeasure = () => { void nextTick(measureLift) }
let observer: MutationObserver | null = null
onMounted(() => {
  trackModals()
  observer = new MutationObserver(trackModals)
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] })
  window.addEventListener('resize', remeasure)
  // 底边升起的框动画做完才在最终位置 / A sheet rising from the bottom is in place only once its animation ends
  document.addEventListener('animationend', remeasure, true)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('resize', remeasure)
  document.removeEventListener('animationend', remeasure, true)
})
const items = computed(() => toast.messages.value.map((item) => {
  const match = item.message.match(COMMAND)
  return match?.index === undefined
    ? { ...item, text: item.message, command: [] as string[] }
    : { ...item, text: item.message.slice(0, match.index), command: commandUnits(match[1]!) }
}))
watch([topModal, () => toast.messages.value.length], remeasure)
</script>

<template>
  <Teleport :to="topModal ?? 'body'" :disabled="!topModal">
  <div class="toast-stack" aria-live="polite" :style="lift ? { bottom: `calc(${lift}px + var(--s-4))` } : undefined">
    <div v-for="item in items" :key="item.id" class="toast" :class="`toast--${item.kind}`">
      <CircleCheck v-if="item.kind === 'success'" :size="18" />
      <CircleAlert v-else-if="item.kind === 'error'" :size="18" />
      <Info v-else :size="18" />
      <span v-line-dots><template v-for="(run, j) in toastRuns(item.text)" :key="j"><NameText v-if="run.name" :name="run.name.name" quoted :suffix="run.name.suffix" /><template v-else-if="run.parts"><span :class="{ 'glue-block': !run.lead }"><template v-for="(part, k) in run.parts" :key="k"><span v-if="k" class="brk" aria-hidden="true"></span><span class="nowrap">{{ part.text }}</span></template></span><span v-if="run.breakAfter" class="brk" aria-hidden="true"></span></template><template v-else-if="run.glue"><span :class="run.long ? 'glue-block' : 'nowrap'">{{ run.text }}</span><span v-if="run.breakAfter" class="brk" aria-hidden="true"></span></template><template v-else>{{ run.text }}<span v-if="run.breakAfter" class="brk" aria-hidden="true"></span></template></template><code v-if="item.command.length" class="toast-cmd"><template v-for="(word, index) in item.command" :key="index">{{ index ? ' ' : '' }}<span class="toast-cmd__word">{{ word }}</span></template></code></span>
      <!-- 可撤销的那条右侧是撤销而不是叉：真正的撤销窗口就是它显示的这段时间，
           摆一个叉等于把唯一有用的动作藏起来。 -->
      <button v-if="item.undo" class="toast-undo" type="button" @click="toast.runUndo(item.id)">撤销</button>
      <button v-else class="icon-button icon-button--small toast-close" type="button" title="关闭" aria-label="关闭提示" @click="toast.dismiss(item.id)">
        <X :size="16" />
      </button>
    </div>
  </div>
  </Teleport>
</template>
