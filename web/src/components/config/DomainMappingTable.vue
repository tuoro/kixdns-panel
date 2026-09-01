<script setup lang="ts">
import { ArrowDown, ArrowUp, ClipboardPaste, Plus, X } from '@lucide/vue'
import { ref } from 'vue'
import type { DomainMappingRow } from '../../config-editor/solution'

const rows = defineModel<DomainMappingRow[]>({ required: true })
const bulkSource = ref('')
const bulkError = ref('')
const showBulk = ref(false)

function addRow(): void {
  rows.value = [...rows.value, { source: '', target: '', ttl: 300 }]
}

function move(index: number, offset: -1 | 1): void {
  const target = index + offset
  if (target < 0 || target >= rows.value.length) return
  const next = [...rows.value]
  const [row] = next.splice(index, 1)
  if (row) next.splice(target, 0, row)
  rows.value = next
}

function updateText(index: number, key: 'source' | 'target', event: Event): void {
  const value = (event.currentTarget as HTMLInputElement).value
  rows.value = rows.value.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row)
}

function setTtl(index: number, event: Event): void {
  const raw = (event.currentTarget as HTMLInputElement).value
  rows.value = rows.value.map((row, rowIndex) => (
    rowIndex === index ? { ...row, ttl: raw === '' ? Number.NaN : Number(raw) } : row
  ))
}

function remove(index: number): void {
  rows.value = rows.value.filter((_, rowIndex) => rowIndex !== index)
}

function parseBulkLine(line: string): DomainMappingRow | undefined {
  const parts = line.replace(/\s*(?:->|=>|→|,|，)\s*/g, ' ').trim().split(/\s+/)
  if (parts.length < 2 || parts.length > 3) return undefined
  const ttl = parts[2] === undefined ? 300 : Number(parts[2])
  if (!parts[0] || !parts[1] || !Number.isInteger(ttl) || ttl < 0 || ttl > 4_294_967_295) return undefined
  return { source: parts[0], target: parts[1], ttl }
}

function importBulk(): void {
  const lines = bulkSource.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const parsed = lines.map(parseBulkLine)
  if (lines.length === 0 || parsed.some((row) => row === undefined)) {
    bulkError.value = '每行请填写“源域名 目标域名”，可在末尾附加 TTL'
    return
  }
  rows.value = [...rows.value, ...parsed as DomainMappingRow[]]
  bulkSource.value = ''
  bulkError.value = ''
  showBulk.value = false
}
</script>

<template>
  <div class="mapping-editor">
    <div class="mapping-editor__head"><span>源域名</span><span>目标域名</span><span>TTL</span><span></span></div>
    <div v-for="(row, index) in rows" :key="index" class="mapping-editor__row">
      <input :value="row.source" type="text" :aria-label="`映射 ${index + 1} 源域名`" placeholder="alias.example" @input="updateText(index, 'source', $event)">
      <input :value="row.target" type="text" :aria-label="`映射 ${index + 1} 目标域名`" placeholder="origin.example." @input="updateText(index, 'target', $event)">
      <input type="number" :value="Number.isNaN(row.ttl) ? '' : row.ttl" min="0" max="4294967295" :aria-label="`映射 ${index + 1} TTL`" placeholder="300" @input="setTtl(index, $event)">
      <div>
        <button class="icon-button icon-button--small" type="button" :disabled="index === 0" :title="`上移映射 ${index + 1}`" @click="move(index, -1)"><ArrowUp :size="14" /></button>
        <button class="icon-button icon-button--small" type="button" :disabled="index === rows.length - 1" :title="`下移映射 ${index + 1}`" @click="move(index, 1)"><ArrowDown :size="14" /></button>
        <button class="icon-button icon-button--small" type="button" :title="`删除映射 ${index + 1}`" @click="remove(index)"><X :size="14" /></button>
      </div>
    </div>
    <div class="mapping-editor__commands">
      <button class="inline-command" type="button" @click="addRow"><Plus :size="14" />添加映射</button>
      <button class="inline-command" type="button" @click="showBulk = !showBulk"><ClipboardPaste :size="14" />批量粘贴</button>
    </div>
    <div v-if="showBulk" class="mapping-editor__bulk">
      <textarea v-model="bulkSource" aria-label="批量域名映射" rows="4" placeholder="alias.example origin.example. 300"></textarea>
      <p>每行一条，支持空格、逗号或 → 分隔；TTL 不填时使用 300。</p>
      <p v-if="bulkError" class="mapping-editor__error">{{ bulkError }}</p>
      <button class="button button--secondary" type="button" @click="importBulk">导入到映射表</button>
    </div>
  </div>
</template>

<style scoped>
.mapping-editor { display: grid; gap: 8px; }
.mapping-editor__head, .mapping-editor__row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 100px auto; align-items: center; gap: 7px; }
.mapping-editor__head { padding: 0 2px; color: var(--muted); font-size: 8px; font-weight: 700; }
.mapping-editor__row > div { display: flex; gap: 3px; }
.mapping-editor__commands { display: flex; flex-wrap: wrap; gap: 12px; }
.mapping-editor__bulk { display: grid; gap: 7px; padding: 10px; background: #f7faf8; border: 1px solid var(--line); border-radius: 5px; }
.mapping-editor__bulk textarea { min-height: 88px; resize: vertical; }
.mapping-editor__bulk p { color: var(--muted); font-size: 8px; }
.mapping-editor__bulk .mapping-editor__error { color: #a1453f; }
.mapping-editor__bulk .button { justify-self: start; }
@media (max-width: 760px) {
  .mapping-editor__head { display: none; }
  .mapping-editor__row { grid-template-columns: 1fr 78px auto; padding: 9px; border: 1px solid var(--line); border-radius: 5px; }
  .mapping-editor__row > input:first-child { grid-column: 1 / -1; }
  .mapping-editor__row > input:nth-child(2) { grid-column: 1 / 2; }
  .mapping-editor__row > div { justify-content: flex-end; }
}
</style>
