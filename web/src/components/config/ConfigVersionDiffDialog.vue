<script setup lang="ts">
import { X } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ConfigVersionDetail } from '../../api/types'
import { diffConfig, type ConfigDiffKind } from '../../config-editor/diff'

const props = defineProps<{
  current: Record<string, unknown>
  version: ConfigVersionDetail
}>()
const emit = defineEmits<{ close: [] }>()
const closeButton = ref<HTMLButtonElement | null>(null)
const result = computed(() => diffConfig(props.current, props.version.content))

const kindLabels: Record<ConfigDiffKind, string> = {
  added: '新增',
  removed: '删除',
  changed: '修改',
}

function formatValue(value: unknown): string {
  if (value === undefined) return '不存在'
  return JSON.stringify(value, null, 2) ?? String(value)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  closeButton.value?.focus()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div class="config-diff-backdrop" @click.self="$emit('close')">
      <section class="config-diff-dialog" role="dialog" aria-modal="true" aria-labelledby="config-diff-title">
        <header class="config-diff-dialog__header">
          <div>
            <span>配置版本 #{{ version.id }}</span>
            <h2 id="config-diff-title">{{ version.message || '未填写备注' }}</h2>
          </div>
          <button ref="closeButton" class="icon-button" type="button" title="关闭差异预览" @click="$emit('close')"><X :size="17" /></button>
        </header>

        <div class="config-diff-summary">
          <strong>{{ result.entries.length }} 处差异</strong>
          <span>所选版本与当前文件的字段级比较</span>
          <span v-if="result.truncated" class="config-diff-summary__warning">仅显示前 200 处</span>
        </div>

        <div v-if="result.entries.length" class="config-diff-list">
          <article v-for="entry in result.entries" :key="entry.path">
            <header><code>{{ entry.path }}</code><span :class="`config-diff-kind--${entry.kind}`">{{ kindLabels[entry.kind] }}</span></header>
            <div class="config-diff-values">
              <div><small>当前文件</small><pre>{{ formatValue(entry.current) }}</pre></div>
              <div><small>所选版本</small><pre>{{ formatValue(entry.selected) }}</pre></div>
            </div>
          </article>
        </div>
        <div v-else class="config-diff-empty">该版本与当前文件内容一致</div>

        <footer><button class="button button--secondary" type="button" @click="$emit('close')">关闭</button></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.config-diff-backdrop { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 24px; background: rgba(18, 24, 22, .55); }
.config-diff-dialog { width: min(880px, 100%); max-height: min(820px, calc(100vh - 48px)); display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; overflow: hidden; color: #30383a; background: #fff; border: 1px solid #d9dfdc; border-radius: 7px; box-shadow: 0 24px 70px rgba(13, 20, 17, .24); }
.config-diff-dialog__header { min-height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px 12px 18px; border-bottom: 1px solid var(--line); }
.config-diff-dialog__header > div { min-width: 0; display: grid; gap: 3px; }
.config-diff-dialog__header span { color: var(--green); font-size: 12px; font-weight: 700; }
.config-diff-dialog__header h2 { overflow: hidden; color: #28302e; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.config-diff-summary { min-height: 46px; display: flex; align-items: center; gap: 10px; padding: 9px 18px; color: #75807c; background: #f7f9f8; border-bottom: 1px solid var(--line); font-size: 12px; }
.config-diff-summary strong { color: #36403c; font-size: 14px; }
.config-diff-summary__warning { margin-left: auto; color: var(--amber); }
.config-diff-list { min-height: 0; overflow: auto; }
.config-diff-list article { padding: 13px 18px; border-bottom: 1px solid #e7ebe9; }
.config-diff-list article:last-child { border-bottom: 0; }
.config-diff-list article > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.config-diff-list code { min-width: 0; overflow-wrap: anywhere; color: #45514c; font-size: 12px; }
.config-diff-list article > header span { padding: 2px 5px; border-radius: 3px; font-size: 12px; font-weight: 700; }
.config-diff-kind--added { color: #176d4d; background: var(--green-soft); }
.config-diff-kind--removed { color: #9a3737; background: var(--red-soft); }
.config-diff-kind--changed { color: #8b5b18; background: var(--amber-soft); }
.config-diff-values { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 9px; }
.config-diff-values > div { min-width: 0; }
.config-diff-values small { display: block; margin-bottom: 4px; color: #8b9591; font-size: 12px; }
.config-diff-values pre { min-height: 34px; margin: 0; padding: 8px 9px; overflow: auto; color: #36403c; background: #f5f7f6; border: 1px solid #e2e7e4; border-radius: 4px; font: 9px/1.45 "SFMono-Regular", Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.config-diff-empty { min-height: 180px; display: grid; place-items: center; color: #8b9591; font-size: 12px; }
.config-diff-dialog > footer { min-height: 58px; display: flex; align-items: center; justify-content: flex-end; padding: 10px 16px; border-top: 1px solid var(--line); }
@media (max-width: 640px) {
  .config-diff-backdrop { padding: 10px; }
  .config-diff-dialog { max-height: calc(100vh - 20px); }
  .config-diff-values { grid-template-columns: 1fr; }
  .config-diff-summary > span:not(.config-diff-summary__warning) { display: none; }
}
</style>
