<script setup lang="ts">
import { ArrowDown, ArrowRight, ArrowUp, Check, ClipboardPaste, Plus, TriangleAlert, X } from '@lucide/vue'
import { computed, ref, useId } from 'vue'
import { DEFAULT_DOMAIN_MAPPING_TTL, domainMappingFieldErrors, duplicateDomainMappingSources, formatDomainMappingTtl, parseDomainMappingBulk } from '../../config-editor/domain-mapping'
import type { DomainMappingRow } from '../../config-editor/solution'

const rows = defineModel<DomainMappingRow[]>({ required: true })
const id = useId()
const bulkSource = ref('')
const showBulk = ref(false)
const bulkInput = ref<HTMLTextAreaElement>()
const fieldErrors = computed(() => rows.value.map(domainMappingFieldErrors))
const duplicateSources = computed(() => duplicateDomainMappingSources(rows.value))
const bulkPreview = computed(() => parseDomainMappingBulk(bulkSource.value))
const canImport = computed(() => bulkPreview.value.rows.length > 0 && bulkPreview.value.errorCount === 0)

function addRow(): void {
  rows.value = [...rows.value, { source: '', target: '', ttl: DEFAULT_DOMAIN_MAPPING_TTL }]
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

function focusBulkLine(lineNumber: number): void {
  const lines = bulkSource.value.split('\n')
  const start = lines.slice(0, lineNumber - 1).reduce((offset, line) => offset + line.length + 1, 0)
  bulkInput.value?.focus()
  bulkInput.value?.setSelectionRange(start, start + (lines[lineNumber - 1]?.length ?? 0))
}

function importBulk(): void {
  if (!canImport.value) return
  rows.value = [...rows.value, ...bulkPreview.value.rows]
  bulkSource.value = ''
  showBulk.value = false
}
</script>

<template>
  <div class="mapping-editor">
    <p class="mapping-editor__order">每条映射匹配源域名及其子域名；按从上到下的顺序，首个命中生效。</p>
    <div v-if="!rows.length" class="mapping-editor__empty"><ArrowRight :size="22" /><strong>把域名指向你指定的目标</strong><span>添加一条映射，或批量粘贴已有列表。</span></div>
    <article v-for="(row, index) in rows" :key="index" class="mapping-editor__item">
      <div class="mapping-editor__row">
        <label class="mapping-editor__field"><span>源域名</span><input :value="row.source" type="text" :aria-label="`映射 ${index + 1} 源域名`" :aria-invalid="Boolean(fieldErrors[index]?.source)" :aria-describedby="`${id}-source-${index}`" placeholder="alias.example" @input="updateText(index, 'source', $event)"><small :id="`${id}-source-${index}`" class="mapping-editor__error">{{ fieldErrors[index]?.source }}</small></label>
        <label class="mapping-editor__field"><span>目标域名</span><input :value="row.target" type="text" :aria-label="`映射 ${index + 1} 目标域名`" :aria-invalid="Boolean(fieldErrors[index]?.target)" :aria-describedby="`${id}-target-${index}`" placeholder="origin.example." @input="updateText(index, 'target', $event)"><small :id="`${id}-target-${index}`" class="mapping-editor__error">{{ fieldErrors[index]?.target }}</small></label>
        <label class="mapping-editor__field"><span>TTL · 秒</span><input type="number" :value="Number.isNaN(row.ttl) ? '' : row.ttl" min="0" max="4294967295" :aria-label="`映射 ${index + 1} TTL`" :aria-invalid="Boolean(fieldErrors[index]?.ttl)" :aria-describedby="`${id}-ttl-${index}`" placeholder="300" @input="setTtl(index, $event)"><small :id="`${id}-ttl-${index}`" class="mapping-editor__error">{{ fieldErrors[index]?.ttl }}</small></label>
        <div class="mapping-editor__actions">
          <button class="icon-button icon-button--small" type="button" :disabled="index === 0" :title="`上移映射 ${index + 1}`" @click="move(index, -1)"><ArrowUp :size="14" /></button>
          <button class="icon-button icon-button--small" type="button" :disabled="index === rows.length - 1" :title="`下移映射 ${index + 1}`" @click="move(index, 1)"><ArrowDown :size="14" /></button>
          <button class="icon-button icon-button--small" type="button" :title="`删除映射 ${index + 1}`" @click="remove(index)"><X :size="14" /></button>
        </div>
      </div>
      <div class="mapping-editor__result"><span class="mapping-editor__index">{{ index + 1 }}</span><span><strong>{{ row.source.trim() || '源域名' }}</strong> 及其子域名</span><ArrowRight :size="13" /><strong>{{ row.target.trim() || '目标域名' }}</strong><small v-if="!fieldErrors[index]?.ttl">{{ formatDomainMappingTtl(row.ttl) }}</small></div>
      <p v-if="duplicateSources.has(index)" class="mapping-editor__warning"><TriangleAlert :size="13" />源域名与第 {{ duplicateSources.get(index)! + 1 }} 条重复；按从上到下命中，前面的映射优先生效。</p>
    </article>
    <div class="mapping-editor__commands">
      <button class="inline-command" type="button" @click="addRow"><Plus :size="14" />添加映射</button>
      <button class="inline-command" type="button" :aria-expanded="showBulk" :aria-controls="`${id}-bulk`" @click="showBulk = !showBulk"><ClipboardPaste :size="14" />批量粘贴</button>
    </div>
    <div v-if="showBulk" :id="`${id}-bulk`" class="mapping-editor__bulk">
      <header><strong>粘贴后先预览</strong><span>通过检查后追加到现有映射末尾</span></header>
      <textarea ref="bulkInput" v-model="bulkSource" aria-label="批量域名映射" :aria-describedby="`${id}-bulk-format`" rows="4" placeholder="alias.example origin.example. 300"></textarea>
      <p :id="`${id}-bulk-format`">每行一条，支持空格、逗号或 → 分隔；TTL 不填时使用 300 秒（5 分钟）。</p>
      <div v-if="bulkPreview.lines.length" class="mapping-editor__preview">
        <p class="mapping-editor__preview-count" role="status">{{ bulkPreview.validCount }} 条有效<span v-if="bulkPreview.errorCount">，{{ bulkPreview.errorCount }} 行需要修正后才能统一导入</span><span v-else>，可全部导入</span></p>
        <ol>
          <li v-for="line in bulkPreview.lines" :key="line.lineNumber" :class="{ 'has-error': line.errors.length }">
            <button type="button" class="mapping-editor__line-number" :title="`定位到第 ${line.lineNumber} 行`" @click="focusBulkLine(line.lineNumber)">第 {{ line.lineNumber }} 行</button>
            <div><code>{{ line.input }}</code><span v-for="error in line.errors" :key="error" class="mapping-editor__error">{{ error }}</span><small v-if="!line.errors.length && line.row">{{ line.row.source }} 及其子域名 → {{ line.row.target }} · {{ formatDomainMappingTtl(line.row.ttl) }}</small></div>
            <TriangleAlert v-if="line.errors.length" :size="14" aria-label="需要修正" /><Check v-else :size="14" aria-label="格式有效" />
          </li>
        </ol>
      </div>
      <p v-else>粘贴映射后，将逐行显示解析结果。</p>
      <button class="button button--secondary" type="button" :disabled="!canImport" @click="importBulk">导入到映射表</button>
    </div>
  </div>
</template>

<style scoped>
.mapping-editor { display: grid; gap: 12px; min-width: 0; }
.mapping-editor p { margin: 0; }
.mapping-editor__order { color: #728178; font-size: 12px; line-height: 1.6; }
.mapping-editor__empty { display: grid; justify-items: center; gap: 8px; padding: 28px 14px; border: 1px dashed #d6e2da; border-radius: 6px; color: #7c8e80; text-align: center; }
.mapping-editor__empty strong { font-size: 14px; color: #435d4b; }
.mapping-editor__empty span { font-size: 14px; }
.mapping-editor__item { min-width: 0; padding: 13px; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
.mapping-editor__row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 110px auto; align-items: start; gap: 9px; }
.mapping-editor__field { display: grid; align-content: start; gap: 6px; min-width: 0; }
.mapping-editor__field > span { color: #6b786f; font-size: 14px; font-weight: 650; }
.mapping-editor input, .mapping-editor textarea { box-sizing: border-box; min-width: 0; width: 100%; padding: 8px 9px; border: 1px solid #d9dfdd; border-radius: 5px; outline: 0; background: #fff; color: #31393b; font: inherit; font-size: 14px; }
.mapping-editor input { min-height: 35px; }
.mapping-editor input:focus, .mapping-editor textarea:focus { border-color: #7fb89a; box-shadow: 0 0 0 3px rgba(20, 125, 85, .08); }
.mapping-editor input[aria-invalid="true"] { border-color: #d5a49b; background: #fffafa; }
.mapping-editor__actions { display: flex; gap: 3px; padding-top: 23px; }
.mapping-editor__result { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 11px; padding-top: 9px; border-top: 1px solid #edf2ee; color: #738277; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.mapping-editor__result > span, .mapping-editor__result > strong, .mapping-editor__result > small { min-width: 0; }
.mapping-editor__result > svg { flex: 0 0 auto; }
.mapping-editor__result strong { font-weight: 600; color: #45624e; }
.mapping-editor__result small { margin-left: auto; font-size: 12px; }
.mapping-editor__index { display: grid; place-items: center; min-width: 20px; height: 20px; border-radius: 4px; background: #edf3ef; color: #6c8272; font-size: 12px; }
.mapping-editor .mapping-editor__warning { display: flex; align-items: start; gap: 5px; margin-top: 8px; color: #956c2e; font-size: 12px; line-height: 1.55; }
.mapping-editor__warning > svg { flex: 0 0 auto; margin-top: 1px; }
.mapping-editor__commands { display: flex; flex-wrap: wrap; gap: 16px; }
.mapping-editor__bulk { display: grid; min-width: 0; gap: 10px; padding: 14px; background: #f7faf8; border: 1px solid var(--line); border-radius: 6px; }
.mapping-editor__bulk header { display: grid; gap: 5px; }
.mapping-editor__bulk header strong { color: #435d4b; font-size: 14px; }
.mapping-editor__bulk header span { color: #829087; font-size: 14px; }
.mapping-editor__bulk textarea { min-height: 104px; resize: vertical; line-height: 1.8; }
.mapping-editor__bulk p { color: var(--muted); font-size: 12px; line-height: 1.6; }
.mapping-editor .mapping-editor__error { color: #ac5146; font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
.mapping-editor__error:empty { display: none; }
.mapping-editor__bulk .button { justify-self: start; }
.mapping-editor__preview { min-width: 0; border: 1px solid #dce6df; border-radius: 5px; overflow: hidden; background: #fff; }
.mapping-editor__preview .mapping-editor__preview-count { padding: 10px; color: #456d51; border-bottom: 1px solid #e6eee9; }
.mapping-editor__preview-count span { color: #7b887f; }
.mapping-editor__preview ol { display: grid; gap: 0; max-height: 250px; overflow: auto; margin: 0; padding: 0; list-style: none; }
.mapping-editor__preview li { display: grid; grid-template-columns: auto minmax(0, 1fr) 14px; align-items: start; gap: 9px; padding: 10px; border-bottom: 1px solid #edf2ee; color: #63876e; }
.mapping-editor__preview li:last-child { border-bottom: 0; }
.mapping-editor__preview li.has-error { background: #fffbfa; color: #b77365; }
.mapping-editor__preview li > div { display: grid; min-width: 0; gap: 5px; }
.mapping-editor__preview code { color: #415449; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.mapping-editor__preview small { color: #809086; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.mapping-editor__line-number { padding: 2px 0; border: 0; background: transparent; color: #78897d; font-size: 12px; white-space: nowrap; text-decoration: underline; text-underline-offset: 3px; }
.mapping-editor__line-number:focus-visible { outline: 2px solid #279367; outline-offset: 3px; }
@media (max-width: 760px) {
  .mapping-editor__item { padding: 10px; }
  .mapping-editor__row { grid-template-columns: minmax(0, 1fr) 110px; }
  .mapping-editor__field:first-child, .mapping-editor__field:nth-child(2) { grid-column: 1 / -1; }
  .mapping-editor__actions { justify-content: flex-end; }
  .mapping-editor__result small { flex-basis: 100%; margin-left: 26px; }
  .mapping-editor__bulk { padding: 11px; }
}
</style>
