<script setup lang="ts">
import { ArrowLeft, ChevronDown, CircleCheck, Sparkles, TriangleAlert, X } from '@lucide/vue'
import { onBeforeUnmount, onMounted, ref, useId } from 'vue'

const props = withDefaults(defineProps<{
  title: string
  kicker?: string
  description?: string
  closeLabel: string
  summary: string
  issueCount: number
  embedded?: boolean
}>(), { embedded: false })
const emit = defineEmits<{ cancel: []; submit: [] }>()
defineOptions({ inheritAttrs: false })
const id = useId()
const dialog = ref<HTMLElement | null>(null)
const desktop = window.matchMedia('(min-width: 861px)')
const isDesktop = ref(desktop.matches)
const previewOpen = ref(!props.embedded && desktop.matches)
let returnFocus: HTMLElement | null = null
let previousOverflow = ''

function resize(event: MediaQueryListEvent): void {
  isDesktop.value = event.matches
  previewOpen.value = !props.embedded && event.matches
}

function togglePreview(event: Event): void {
  const panel = event.currentTarget as HTMLDetailsElement
  previewOpen.value = (!props.embedded && desktop.matches) || panel.open
  panel.open = previewOpen.value
}

function trapFocus(event: KeyboardEvent): void {
  const controls = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], summary, [tabindex]') ?? [])
    .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0)
  const first = controls[0]
  const last = controls.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

function closeBackdrop(event: MouseEvent): void {
  if (event.target !== dialog.value || !dialog.value) return
  const bounds = dialog.value.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) emit('cancel')
}

onMounted(() => {
  desktop.addEventListener('change', resize)
  if (props.embedded) return
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  if (dialog.value instanceof HTMLDialogElement) dialog.value.showModal()
})

onBeforeUnmount(() => {
  desktop.removeEventListener('change', resize)
  if (props.embedded) return
  if (dialog.value instanceof HTMLDialogElement) dialog.value.close()
  document.body.style.overflow = previousOverflow
  returnFocus?.focus({ preventScroll: true })
})
</script>

<template>
  <Teleport to="body" :disabled="embedded">
    <component :is="embedded ? 'section' : 'dialog'" ref="dialog" v-bind="$attrs" class="config-guide" :class="{ 'workbench-guide': embedded }" :aria-labelledby="`${id}-title`" @cancel.prevent="emit('cancel')" @click="!embedded && closeBackdrop($event)" @keydown.tab="!embedded && trapFocus($event)">
      <header class="config-guide__header">
        <button v-if="embedded" class="icon-button workbench-guide-back" type="button" aria-label="返回解析编排" @click="emit('cancel')"><ArrowLeft :size="18" /></button>
        <div><span v-if="kicker" class="config-guide__kicker"><Sparkles :size="14" />{{ kicker }}</span><h2 :id="`${id}-title`">{{ title }}</h2><p v-if="description">{{ description }}</p></div>
        <button class="icon-button" type="button" :aria-label="closeLabel" @click="emit('cancel')"><X :size="18" /></button>
      </header>
      <div v-if="embedded" class="workbench-guide-overview"><slot name="overview">{{ summary }}</slot></div>
      <form class="config-guide__form" novalidate @submit.prevent="emit('submit')">
        <div v-if="$slots.templates" class="config-guide__templates"><slot name="templates" /></div>
        <div class="config-guide__workspace">
          <div class="config-guide__editor"><slot /></div>
          <details class="config-guide__preview" :open="previewOpen" @toggle="togglePreview">
            <summary :tabindex="isDesktop && !embedded ? -1 : 0"><div><strong>配置效果预览</strong><span>{{ summary }}</span></div><ChevronDown :size="16" /></summary>
            <div class="config-guide__preview-body"><slot name="preview" /><p class="config-guide__disclaimer">根据当前填写生成，尚未应用</p></div>
          </details>
        </div>
        <footer class="config-guide__footer">
          <div class="config-guide__status" :class="{ 'config-guide__status--incomplete': issueCount > 0 }" aria-live="polite">
            <TriangleAlert v-if="issueCount" :size="16" /><CircleCheck v-else :size="16" />
            <div><strong>{{ issueCount ? `还有 ${issueCount} 项待补全` : '表单已补全' }}</strong><slot name="footer-status" /></div>
          </div>
          <div class="config-guide__actions"><slot name="actions" /></div>
        </footer>
      </form>
    </component>
  </Teleport>
</template>

<style scoped>
.config-guide { width: min(1120px, calc(100vw - 48px)); height: min(920px, calc(100dvh - 48px)); max-width: none; max-height: none; padding: 0; margin: auto; color: #30383a; background: #fff; border: 1px solid #d9dfdc; border-radius: 8px; box-shadow: 0 24px 70px rgba(13, 20, 17, .24); overflow: hidden; }
.config-guide[open] { display: flex; flex-direction: column; }
.config-guide::backdrop { background: rgba(18, 25, 22, .48); }
.config-guide__header { display: flex; flex: 0 0 auto; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 17px 20px; border-bottom: 1px solid var(--line); }
.config-guide__header > div { display: grid; gap: 4px; }
.config-guide__header h2 { font-size: 18px; }
.config-guide__header p { color: var(--muted); font-size: 11px; }
.config-guide__kicker { display: flex; align-items: center; gap: 5px; color: var(--green); font-size: 10px; font-weight: 700; }
.config-guide__form { display: flex; flex: 1; flex-direction: column; min-height: 0; }
.config-guide__templates { flex: 0 0 auto; max-height: 26%; overflow: auto; border-bottom: 1px solid var(--line); }
.config-guide__workspace { display: grid; grid-template-columns: minmax(0, 1fr) 310px; flex: 1; min-height: 0; }
.config-guide__editor { min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scroll-padding-block: 16px; }
.config-guide__preview { display: flex; flex-direction: column; min-width: 0; overflow: auto; padding: 20px; background: #f6faf8; border-left: 1px solid var(--line); overscroll-behavior: contain; }
.config-guide__preview > summary { display: flex; justify-content: space-between; gap: 10px; list-style: none; cursor: pointer; }
.config-guide__preview > summary::-webkit-details-marker { display: none; }
.config-guide__preview > summary > div { display: grid; min-width: 0; gap: 5px; }
.config-guide__preview > summary strong { font-size: 13px; }
.config-guide__preview > summary span { color: var(--muted); font-size: 10px; overflow-wrap: anywhere; }
.config-guide__preview > summary svg { flex-shrink: 0; }
.config-guide__preview[open] > summary svg { transform: rotate(180deg); }
.config-guide__preview-body { display: flex; flex-direction: column; gap: 14px; padding-top: 22px; }
.config-guide__disclaimer { color: var(--muted); font-size: 10px; line-height: 1.6; }
.config-guide__footer { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 20px; border-top: 1px solid var(--line); background: #fff; }
.config-guide__status { display: flex; gap: 8px; align-items: center; color: var(--green); min-width: 0; }
.config-guide__status > svg { flex-shrink: 0; }
.config-guide__status > div { display: grid; gap: 3px; min-width: 0; }
.config-guide__status strong { font-size: 11px; }
.config-guide__status--incomplete { color: #996425; }
.config-guide__actions { display: flex; flex-shrink: 0; gap: 8px; }
.config-guide :deep(input:not([type="checkbox"])), .config-guide :deep(select), .config-guide :deep(textarea) { font: inherit; font-size: 12px; }
.config-guide :deep(input:not([type="checkbox"])), .config-guide :deep(select) { min-height: 36px; }
.workbench-guide { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; margin: 0; border: 0; border-radius: 0; box-shadow: none; background: var(--surface, #fff); }
.workbench-guide .config-guide__header { align-items: center; padding: 18px 20px; }
.workbench-guide .config-guide__header > div { flex: 1; min-width: 0; }
.workbench-guide .config-guide__header h2 { overflow-wrap: anywhere; font-size: 18px; }
.workbench-guide .config-guide__header p, .workbench-guide .config-guide__kicker { font-size: 12px; }
.workbench-guide .config-guide__workspace { display: flex; flex-direction: column; overflow-y: auto; }
.workbench-guide .config-guide__editor { flex: 0 0 auto; overflow: visible; }
.workbench-guide .config-guide__preview { display: block; flex: 0 0 auto; overflow: visible; max-height: none; order: 0; margin: 16px 20px; padding: 14px; border: 1px solid var(--line); border-radius: 6px; background: #f4f9f2; }
.workbench-guide .config-guide__preview > summary { pointer-events: auto; }
.workbench-guide .config-guide__preview > summary > svg { display: block; }
.workbench-guide .config-guide__preview > summary span, .workbench-guide .config-guide__disclaimer { font-size: 12px; line-height: 1.5; }
.workbench-guide .config-guide__footer { flex-wrap: wrap; padding: 14px 20px; }
.workbench-guide .config-guide__status { flex: 1 1 100%; }
.workbench-guide .config-guide__status strong { font-size: 12px; }
.workbench-guide .config-guide__actions { justify-content: flex-end; width: 100%; }
.workbench-guide :deep(input:not([type="checkbox"])), .workbench-guide :deep(select), .workbench-guide :deep(textarea) { font-size: 14px; }
.workbench-guide-back { display: none; }
.workbench-guide-overview { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; min-width: 0; padding: 12px 20px; color: #fff; background: var(--ink); font-size: 12px; }
.workbench-guide-overview :deep(span), .workbench-guide-overview :deep(strong) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.workbench-guide-overview :deep(svg) { flex: 0 0 auto; color: var(--lime); }
@media (min-width: 861px) {
  .config-guide__preview > summary { pointer-events: none; }
  .config-guide__preview > summary > svg { display: none; }
}
@media (max-width: 860px) {
  .config-guide { width: calc(100vw - 20px); height: calc(100dvh - 20px); border-radius: 7px; }
  .config-guide__header { padding: 12px 14px; }
  .config-guide__header h2 { font-size: 16px; }
  .config-guide__header p { font-size: 10px; }
  .config-guide__workspace { display: flex; flex-direction: column; }
  .config-guide__editor { flex: 1; }
  .config-guide__preview { order: -1; flex: 0 0 auto; max-height: 42%; padding: 10px 14px; border-left: 0; border-bottom: 1px solid var(--line); }
  .config-guide__preview > summary span { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
  .config-guide__preview-body { padding-top: 14px; }
  .config-guide__footer { flex-wrap: wrap; gap: 9px; padding: 10px 14px; }
  .config-guide__status { flex: 1 1 100%; }
  .config-guide__actions { width: 100%; justify-content: flex-end; }
  .workbench-guide { width: 100%; height: 100%; border-radius: 0; }
  .workbench-guide .config-guide__header { padding: 12px 16px; gap: 10px; }
  .workbench-guide .config-guide__header h2 { font-size: 18px; }
  .workbench-guide .config-guide__header p { display: none; }
  .workbench-guide .config-guide__preview { margin: 12px 16px; }
  .workbench-guide .config-guide__footer { padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); }
  .workbench-guide .config-guide__actions > :deep(button) { flex: 1; }
  .workbench-guide-back { display: inline-flex; }
  .workbench-guide :deep(input:not([type="checkbox"])), .workbench-guide :deep(select) { min-height: 44px; }
}
</style>
