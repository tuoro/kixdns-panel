<script setup lang="ts">
import { ArrowRight, ArrowUpDown, ChevronDown, ClipboardPaste, Plus, X } from '@lucide/vue'
import { computed, nextTick, reactive, ref, useId } from 'vue'
import UiMenu from '../ui/UiMenu.vue'
import { moveItems, moveTarget } from './row-list'
import { DEFAULT_DOMAIN_MAPPING_TTL, domainMappingFieldErrors, duplicateDomainMappingSources, parseDomainMappingBulk } from '../../config-editor/domain-mapping'
import type { DomainMappingRow } from '../../config-editor/solution'
import { vLineDots } from '../../line-dots'

const rows = defineModel<DomainMappingRow[]>({ required: true })
// 父组件提交过一次后传 true：所有出错的字段都标出来；平时离开字段才报 / Parent passes true after a submit attempt; otherwise errors show on blur
const props = withDefaults(defineProps<{ showErrors?: boolean }>(), { showErrors: false })
const touched = reactive(new Set<string>())
const root = ref<HTMLElement | null>(null)
const id = useId()
const bulkSource = ref('')
const showBulk = ref(false)
const bulkInput = ref<HTMLTextAreaElement>()
const fieldErrors = computed(() => rows.value.map(domainMappingFieldErrors))
const duplicateSources = computed(() => duplicateDomainMappingSources(rows.value))
const bulkPreview = computed(() => parseDomainMappingBulk(bulkSource.value))
const canImport = computed(() => bulkPreview.value.rows.length > 0 && bulkPreview.value.errorCount === 0)
// 「追加到映射表」灰着时旁边写为什么：哪几行要先改好（规范 2.4） / Beside a disabled 追加到映射表, the reason: which lines need fixing (spec 2.4)
const importBlocker = computed(() => {
  const failing = bulkPreview.value.lines.filter((line) => line.errors.length).map((line) => line.lineNumber)
  if (!failing.length) return ''
  return failing.length === 1 ? `第 ${failing[0]} 行要先改好` : `第 ${failing.slice(0, 3).join('、')}${failing.length > 3 ? ' 等' : ''} 行要先改好`
})
// 批量框跟着行数长高：不折行，每行一条完整地摆在一行里（审计 M5） / The bulk box grows with its lines and never soft-wraps, one entry per line (audit M5)
const bulkRows = computed(() => Math.min(12, Math.max(3, bulkSource.value.split('\n').length)))

// 焦点跟着行走（规范 2.11）：加一行落在它的源域名，删一行落到接替它的那一行，挪一行落在它的序号上
// Focus follows the row (spec 2.11): a new row's source, the row that takes a removed one's place, a moved row's ordinal
async function focusRow(index: number, target: 'source' | 'handle'): Promise<void> {
  await nextTick()
  const items = root.value?.querySelectorAll<HTMLElement>('.mapping-editor__item') ?? []
  const item = items.length ? items[Math.min(index, items.length - 1)] : undefined
  const element = item?.querySelector<HTMLElement>(target === 'handle' ? '.ui-rows__handle' : '.mapping-editor__source input')
    ?? root.value?.querySelector<HTMLElement>('.mapping-editor__add')
  element?.focus()
}

// 新行的下标按刚写进去的那份数组算：v-model 要等父组件传回来才更新，读 rows.value 会指到原来的最后一行（审计 M2）
// The new row's index comes from the array just written: the v-model only updates once the parent passes it back, so rows.value would still point at the old last row (audit M2)
function addRow(): void {
  const next = [...rows.value, { source: '', target: '', ttl: DEFAULT_DOMAIN_MAPPING_TTL }]
  rows.value = next
  void focusRow(next.length - 1, 'source')
}

function move(index: number, direction: string): void {
  const target = moveTarget(index, rows.value.length, direction)
  if (target === undefined) return
  const next = [...rows.value]
  const [row] = next.splice(index, 1)
  if (row) next.splice(target, 0, row)
  rows.value = next
  touched.clear()
  void focusRow(target, 'handle')
}

function touch(index: number, field: string): void {
  touched.add(`${index}:${field}`)
}

function visibleError(index: number, field: 'source' | 'target' | 'ttl'): string | undefined {
  const error = fieldErrors.value[index]?.[field]
  return error && (props.showErrors || touched.has(`${index}:${field}`)) ? error : undefined
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
  touched.clear()
  void focusRow(index, 'source')
}

// 批量框不折行（审计 M5）：粘贴或一次填进好几行后，浏览器把横向滚动停在光标所在的末尾，每行都从半截开始。
// 这种输入之后滚回行首；逐字输入不动，光标一直看得见（审计第二轮 M1）
// The bulk box never wraps (audit M5): after a paste or a multi-line insert the browser leaves it scrolled to the caret
// at the end, so every line starts mid-word. Scroll back to the line starts after such input; typing leaves it alone,
// so the caret stays in view (audit round 2, M1)
function showLineStarts(event: Event): void {
  const input = event as InputEvent
  const element = event.target as HTMLTextAreaElement
  const multiLine = input.inputType === 'insertFromPaste' || input.inputType === 'insertFromDrop' || (input.data ?? '').includes('\n')
  if (!multiLine) return
  element.scrollLeft = 0
  requestAnimationFrame(() => { element.scrollLeft = 0 })
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
  <!-- 一条映射一行：源域名 → 目标域名、TTL、×；字段名只在表头写一次。序号挂在左边，顺序有意义，
       所以它同时是「调整顺序」菜单（和条件、动作一样）。容器窄（检查器、手机）时一条变成一组：
       第一行是序号和 ×，下面源域名、目标域名各占一行、字段名在上，TTL 字段名在左（规范 3.4，审计 M3）。
       One mapping per row: source → target, TTL, ×; field names appear once in the header. The ordinal hangs
       on the left and, since order matters, doubles as the reorder menu (as conditions and actions do). A narrow
       container (the inspector, a phone) turns each mapping into a group: the ordinal and × lead, source and
       target take a line each under their names, TTL keeps its name beside it (spec 3.4, audit M3). -->
  <div ref="root" class="mapping-editor">
    <div class="mapping-editor__bar">
      <!-- 它排在所有入口前面、命中返回 CNAME，解析编排的列表第一行已经写了；这里只说它怎么匹配（规范第 4 节，审计 M8）
           That it ranks before every entry and answers with a CNAME is on the workbench list's first row; this says only how it matches (spec section 4, audit M8) -->
      <p class="mapping-editor__order">源域名连同子域名一起映射<template v-if="rows.length > 1">，<span class="mapping-editor__clause">从上往下第一条命中的生效。</span></template><template v-else>。</template></p>
      <span class="mapping-editor__commands">
        <button class="ui-btn ui-btn--text ui-btn--sm" type="button" :aria-expanded="showBulk" :aria-controls="`${id}-bulk`" @click="showBulk = !showBulk"><ClipboardPaste :size="14" aria-hidden="true" />批量粘贴<ChevronDown class="ui-btn__chev" :size="14" aria-hidden="true" /></button>
        <button class="ui-btn ui-btn--secondary ui-btn--sm mapping-editor__add" type="button" @click="addRow"><Plus :size="14" aria-hidden="true" />添加映射</button>
      </span>
    </div>

    <div v-if="showBulk" :id="`${id}-bulk`" class="mapping-editor__bulk">
      <!-- 框和内边距在外面那一层上：点在那一圈上不让文字框失焦，光标不会跳回上一次的位置（审计第八轮 C7）
           The frame and padding sit on the wrapper: a press on that strip never blurs the text box, so the caret does not jump back to its last place (audit round 8, C7) -->
      <label class="mapping-editor__bulk-input"><span>一行一条：源域名 目标域名 [TTL 秒]</span><span class="mapping-editor__bulk-box" @mousedown.self.prevent><textarea ref="bulkInput" v-model="bulkSource" aria-label="批量域名映射" @input="showLineStarts" @blur="($event.target as HTMLTextAreaElement).scrollLeft = 0" :aria-describedby="`${id}-bulk-format`" :rows="bulkRows" wrap="off" spellcheck="false" placeholder="alias.example origin.example 300"></textarea></span></label>
      <p :id="`${id}-bulk-format`" class="visually-hidden">每行一条，用空格、逗号或 → 分隔；TTL 不填就是 300 秒。</p>
      <!-- 预览：每行写读出来的结果；只有读不懂的行才把原文和原因摆出来，行号能点回去（审计 M7、M9）
           The preview states what each line reads as; only a line that fails shows its raw text and reason, its number linking back (audits M7, M9) -->
      <ol v-if="bulkPreview.lines.length" class="mapping-editor__preview">
        <li v-for="line in bulkPreview.lines" :key="line.lineNumber" :class="{ 'has-error': line.errors.length }">
          <button v-if="line.errors.length" type="button" class="ui-objlink ui-objlink--plain mapping-editor__line-number" :title="`定位到第 ${line.lineNumber} 行`" @click="focusBulkLine(line.lineNumber)">第 {{ line.lineNumber }} 行</button>
          <span v-else class="mapping-editor__line-number">第 {{ line.lineNumber }} 行</span>
          <span v-if="!line.errors.length && line.row" v-line-dots class="mapping-editor__parsed"><code>{{ line.row.source }}</code> <span class="mapping-editor__nowrap"><ArrowRight class="mapping-editor__to" :size="14" aria-hidden="true" /><code>{{ line.row.target }}</code><small data-line-dot>&nbsp;·</small></span> <small class="mapping-editor__nowrap">{{ line.row.ttl }} 秒</small></span>
          <span v-else class="mapping-editor__failed"><code>{{ line.input }}</code><span v-for="error in line.errors" :key="error" class="mapping-editor__error">{{ error }}</span></span>
        </li>
      </ol>
      <p class="visually-hidden" role="status">{{ bulkPreview.lines.length ? (bulkPreview.errorCount ? `${bulkPreview.errorCount} 行要先改好` : `${bulkPreview.validCount} 条都能追加`) : '' }}</p>
      <div class="mapping-editor__import-row">
        <button class="ui-btn ui-btn--secondary ui-btn--sm mapping-editor__import" type="button" :disabled="!canImport" @click="importBulk">追加到映射表</button>
        <small v-if="importBlocker" class="mapping-editor__blocker">{{ importBlocker }}</small>
      </div>
    </div>

    <p v-if="!rows.length" class="mapping-editor__empty">还没有域名映射，请求直接交给入口。</p>
    <div v-else class="mapping-editor__list">
      <div class="mapping-editor__head" aria-hidden="true"><span>源域名</span><span></span><span>目标域名</span><span>TTL</span><span></span></div>
      <article v-for="(row, index) in rows" :key="index" class="mapping-editor__item ui-reorder">
        <div class="mapping-editor__row">
          <UiMenu v-if="rows.length > 1" class="mapping-editor__ord" trigger-class="ui-rows__handle" align="start" :label="`调整映射 ${index + 1} 的顺序`" :items="moveItems(index, rows.length)" @select="move(index, $event)"><span class="ui-rows__num">{{ index + 1 }}</span><ArrowUpDown class="ui-rows__grip" :size="14" aria-hidden="true" /></UiMenu>
          <span class="mapping-editor__label mapping-editor__label--source" aria-hidden="true">源域名</span>
          <label class="ui-input mapping-editor__source"><input :value="row.source" class="mono" type="text" :aria-label="`映射 ${index + 1} 源域名`" :aria-invalid="Boolean(visibleError(index, 'source')) || undefined" :aria-describedby="visibleError(index, 'source') ? `${id}-source-${index}` : undefined" placeholder="alias.example" @input="updateText(index, 'source', $event)" @blur="touch(index, 'source')"></label>
          <ArrowRight class="mapping-editor__arrow" :size="16" aria-hidden="true" />
          <span class="mapping-editor__label mapping-editor__label--target" aria-hidden="true">目标域名</span>
          <label class="ui-input mapping-editor__target"><input :value="row.target" class="mono" type="text" :aria-label="`映射 ${index + 1} 目标域名`" :aria-invalid="Boolean(visibleError(index, 'target')) || undefined" :aria-describedby="visibleError(index, 'target') ? `${id}-target-${index}` : undefined" placeholder="origin.example" @input="updateText(index, 'target', $event)" @blur="touch(index, 'target')"></label>
          <span class="mapping-editor__label mapping-editor__label--ttl" aria-hidden="true">TTL</span>
          <label class="ui-input mapping-editor__ttl"><input type="number" :value="Number.isNaN(row.ttl) ? '' : row.ttl" min="0" max="4294967295" :aria-label="`映射 ${index + 1} TTL`" :aria-invalid="Boolean(visibleError(index, 'ttl')) || undefined" :aria-describedby="visibleError(index, 'ttl') ? `${id}-ttl-${index}` : undefined" placeholder="300" @input="setTtl(index, $event)" @blur="touch(index, 'ttl')"><em class="ui-setrow__unit">秒</em></label>
          <button class="ui-icon-btn mapping-editor__remove" type="button" :title="`删除映射 ${index + 1}`" :aria-label="`删除映射 ${index + 1}`" @click="remove(index)"><X :size="16" /></button>
        </div>
        <p v-if="visibleError(index, 'source') || visibleError(index, 'target') || visibleError(index, 'ttl')" class="mapping-editor__errors"><small v-if="visibleError(index, 'source')" :id="`${id}-source-${index}`" class="ui-field-error">{{ visibleError(index, 'source') }}</small><small v-if="visibleError(index, 'target')" :id="`${id}-target-${index}`" class="ui-field-error">{{ visibleError(index, 'target') }}</small><small v-if="visibleError(index, 'ttl')" :id="`${id}-ttl-${index}`" class="ui-field-error">{{ visibleError(index, 'ttl') }}</small></p>
        <p v-if="duplicateSources.has(index)" class="mapping-editor__note">和第 {{ duplicateSources.get(index)! + 1 }} 条的源域名相同，只有前面那条会生效。</p>
      </article>
    </div>
  </div>
</template>

<style scoped>
/* 映射表只用 tokens.css 的变量：一行一条，不画卡片框；表头只写一次；序号挂在左边的内边距里。
   Tokens only: one mapping per row, no card frames; the header appears once; the ordinal hangs in the left padding. */
.mapping-editor { container: mapping / inline-size; display: grid; gap: var(--s-3); --rows-handle: var(--h-md); --rows-act: var(--h-md); }
.mapping-editor__bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s-2) var(--s-4); }
.mapping-editor__order { margin: 0; color: var(--l-ink-3); font-size: var(--t-1); text-wrap: pretty; }
/* 窄的时候只在逗号后换行：「生效。」不会一个人落到第二行（审计第二轮 M2） / When narrow, break only after the comma, so 生效。 never lands alone on line 2 (audit round 2, M2) */
.mapping-editor__clause { white-space: nowrap; }
/* 同一组按钮隔 8（规范第 6 节，审计 M13） / Buttons in one group sit 8 apart (spec section 6, audit M13) */
.mapping-editor__commands { display: flex; align-items: center; gap: var(--s-2); margin-left: auto; }
.mapping-editor__list { display: grid; gap: var(--s-2); }
.mapping-editor__head, .mapping-editor__row { display: grid; grid-template-columns: minmax(0, 1fr) var(--s-4) minmax(0, 1fr) var(--w-num) var(--rows-act); align-items: center; gap: var(--s-2); }
/* 表头是字段名：次要（13 · ink-2），不是注释（审计 M15） / The header holds field names: the secondary role (13 · ink-2), not a note (audit M15) */
.mapping-editor__head { margin-bottom: calc(var(--s-1) * -1); color: var(--l-ink-2); font-size: var(--t-2); }
.mapping-editor__item { display: grid; gap: var(--s-1); }
.mapping-editor__row { position: relative; min-height: var(--h-md); }
.mapping-editor__label { display: none; }
.mapping-editor__ord { position: absolute; top: 0; left: calc(var(--s-5) * -1); width: var(--s-5); }
.mapping-editor__arrow { color: var(--l-ink-3); }
/* 占位符和值同一种字体：这两个框里只有域名（审计 M16） / Placeholders share the values' typeface, since these two boxes only ever hold domains (audit M16) */
:is(.mapping-editor__source, .mapping-editor__target) input::placeholder { font-family: var(--f-mono); }
.mapping-editor__errors { display: flex; flex-wrap: wrap; gap: var(--s-1) var(--s-3); margin: 0; }
.mapping-editor__note { margin: 0; color: var(--l-ink-2); font-size: var(--t-1); }
/* 空的时候一句正文：没有映射会怎样（审计 M14）。上面 12 的间距加 12，下面是面板的 24，上下一样（审计第二轮 M7）
   Empty: one line of body text saying what happens with no mappings (audit M14). The 12 gap plus 12 above, the panel's 24 below: even (audit round 2, M7) */
.mapping-editor__empty { margin: 0; padding-block: var(--s-3) 0; color: var(--l-ink); font-size: var(--t-3); }
/* 批量粘贴是面板里的一组，不是一张卡片：不画底色和圆角，和下面的表隔一个组间距（规范 3.2，审计第三轮 M7）
   Bulk paste is a group in the panel, not a card: no fill or radius, one group gap above the table (spec 3.2, audit round 3, M7) */
.mapping-editor__bulk { display: grid; gap: var(--s-3); margin-bottom: var(--s-3); }
/* 字段名离自己的框近 4、离上面的东西远：和手机上映射那一组的字段名一样（规范 6.3，审计第六轮 M2）
   A label sits 4 closer to its own box than to what is above it, as the phone groups' labels do (spec 6.3, audit round 6, M2) */
.mapping-editor__bulk-input { display: grid; gap: var(--s-1); }
.mapping-editor__bulk-input > span { color: var(--l-ink-2); font-size: var(--t-2); }
/* 框跟着行数长高（最多 12 行），不要浏览器的拖拽角：那个灰色的斜纹不在色板里，别的多行框也都没有（审计第四轮 M4）
   The box grows with its lines (up to 12) and has no resize grip: its grey hatching is outside the palette and no other multi-line box has one (audit round 4, M4) */
/* 框和内边距画在外面一层上：行不折，超出的部分在离右边线 12 的地方裁掉，和左边一样，不贴着边线切字（审计第七轮 M2）
   The frame and padding sit on a wrapper: lines do not wrap, and what overflows is clipped 12 inside the right border like on the left,
   never cut against the border itself (audit round 7, M2) */
.mapping-editor__bulk-box { display: block; min-width: 0; padding: var(--s-2) var(--s-3); border: 1px solid var(--l-line-strong); border-radius: var(--r-2); background: var(--l-surface); }
.mapping-editor__bulk-box:focus-within { border-color: var(--l-ink); }
.mapping-editor__bulk textarea { display: block; width: 100%; min-width: 0; padding: 0; border: 0; border-radius: 0; background: transparent; color: var(--l-ink); font-family: var(--f-mono); font-size: var(--t-2); line-height: var(--lh-base); white-space: pre; overflow-x: auto; resize: none; }
.mapping-editor__bulk textarea:focus { outline: 0; }
.mapping-editor__preview { display: grid; gap: var(--s-1); margin: 0; padding: 0; list-style: none; }
.mapping-editor__preview li { display: grid; grid-template-columns: 4.5rem minmax(0, 1fr); align-items: baseline; gap: var(--s-2); color: var(--l-ink); font-size: var(--t-2); }
/* 出错的行号只用红字和下划线标出来，不加图标：行号一列从同一条竖线开始，基线跟着字走（审计第二轮 M6）
   A failing line's number is marked by red text and its underline alone, no icon: the numbers share one left edge and the text sets the baseline (audit round 2, M6) */
.mapping-editor__line-number { justify-self: start; color: var(--l-ink-3); font-size: var(--t-1); text-align: start; white-space: nowrap; }
.mapping-editor__preview li.has-error .mapping-editor__line-number { color: var(--err-l); }
.mapping-editor__parsed code, .mapping-editor__failed code { font-family: var(--f-mono); overflow-wrap: anywhere; }
.mapping-editor__parsed small { color: var(--l-ink-2); font-size: var(--t-2); }
/* 和下面映射表同一个箭头（审计第二轮 M10） / The same arrow as the table below (audit round 2, M10) */
.mapping-editor__to { margin-inline: var(--s-1); color: var(--l-ink-3); vertical-align: -2px; }
/* 「→ 目标 ·」和「TTL」各是一块，换行只在块之间；「·」不在行首，折行落在它后面时藏起来（line-dots.ts）
   「→ target ·」 and 「TTL」 are units and lines break only between them; the 「·」 never starts a line and hides when a wrap falls right after it (line-dots.ts) */
.mapping-editor__nowrap { white-space: nowrap; }
.mapping-editor__failed { display: grid; gap: 2px; min-width: 0; }
.mapping-editor__error { color: var(--err-l); font-size: var(--t-1); }
.mapping-editor__import-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); }
.mapping-editor__blocker { color: var(--l-ink-2); font-size: var(--t-2); }
/* 窄容器：一条变成一组——第一行序号和 ×；源域名、目标域名各一行、字段名在上、让出 × 那一列；TTL 字段名在左。
   组和组之间 24、组内 8，不画底色（规范 3.4，审计 M3、M6）。
   Narrow: each mapping becomes a group. The ordinal and × lead; source and target take a line each under their names,
   leaving the × column free; TTL keeps its name beside it. 24 between groups, 8 within, no fill (spec 3.4, audits M3, M6). */
@container mapping (max-width: 31rem) {
  .mapping-editor__list { gap: var(--s-5); }
  .mapping-editor__head { display: none; }
  .mapping-editor__row {
    grid-template-columns: 5.5rem minmax(0, 1fr) var(--rows-act);
    grid-template-areas: "ord ord del" "slab slab ." "src src ." "tlab tlab ." "tgt tgt ." "ttlab ttl .";
    row-gap: var(--s-1);
  }
  .mapping-editor__row:not(:has(.mapping-editor__ord)) { grid-template-areas: ". . del" "slab slab ." "src src ." "tlab tlab ." "tgt tgt ." "ttlab ttl ."; }
  .mapping-editor__ord { position: static; grid-area: ord; justify-self: start; width: var(--rows-handle); }
  .mapping-editor__label { display: block; color: var(--l-ink-2); font-size: var(--t-2); }
  .mapping-editor__label--source { grid-area: slab; }
  .mapping-editor__label--target { grid-area: tlab; }
  .mapping-editor__label--ttl { grid-area: ttlab; }
  .mapping-editor__source { grid-area: src; }
  .mapping-editor__target { grid-area: tgt; }
  .mapping-editor__arrow { display: none; }
  .mapping-editor__remove { grid-area: del; justify-self: end; }
  .mapping-editor__ttl { grid-area: ttl; justify-self: start; width: var(--w-num); }
  /* 「TTL」和它框里的数字、「秒」在同一条基线上（审计第五轮 M1） / 「TTL」 shares the baseline of the number and 秒 in its box (audit round 5, M1) */
  :is(.mapping-editor__label--ttl, .mapping-editor__ttl) { align-self: baseline; }
  /* 量的是字，不是行框：字段名到自己的框约 8（隔 4），上一个框到下一个字段名约 12（隔 12），字段名跟着它下面的框读（规范 6.3，审计第二轮 M4、第三轮 M1）
     Measured to the glyphs, not the line box: about 8 from a label to its box (4 apart) and 12 from a box to the next label (12 apart),
     so each label reads with the box under it (spec 6.3, audit round 2 M4, round 3 M1) */
  .mapping-editor__label--source { margin-top: var(--s-1); }
  :is(.mapping-editor__label--target, .mapping-editor__label--ttl, .mapping-editor__ttl) { margin-top: var(--s-2); }
  /* 触屏上序号和 ↕ 都写：序号说第几条（重复提示里写「和第 N 条」），↕ 说它能点（审计第二轮 M3）
     On touch show the number and the ↕: the number says which mapping (the duplicate note refers to 第 N 条), the ↕ that it can be tapped (audit round 2, M3) */
  @media (hover: none) {
    /* 往回收按钮的内边距：「1」落在字段的左边线上（审计第三轮 M2） / Pulled back by its padding so 「1」 sits on the fields' left edge (audit round 3, M2) */
    .mapping-editor__ord { width: auto; min-width: var(--rows-handle); margin-inline-start: calc(var(--s-2) * -1); }
    .mapping-editor__ord :deep(.ui-rows__handle) { grid-auto-flow: column; gap: var(--s-1); padding-inline: var(--s-2); }
    .mapping-editor__ord .ui-rows__num { display: inline; }
    .mapping-editor__ord .ui-rows__grip { width: var(--size-icon); height: var(--size-icon); }
  }
}
@media (max-width: 640px) {
  .mapping-editor { --rows-handle: var(--h-md); --rows-act: var(--h-md); }
  /* 手机上先是命令，再是规则的说明，最后是列表：说明挨着它说的列表，「批量粘贴」落在内容左边线上、「添加映射」靠右，
     和解析编排的「自由编辑 · 添加入口」同一个排法（审计第五轮 M2）
     On a phone the commands come first, then the rule note, then the list: the note sits next to the list it describes, with 批量粘贴 on
     the content edge and 添加映射 on the right, the arrangement of 解析编排's 自由编辑 · 添加入口 (audit round 5, M2) */
  .mapping-editor__commands { order: -1; flex-basis: 100%; justify-content: space-between; margin-left: 0; }
  .mapping-editor__commands > .ui-btn--text { margin-inline-start: calc(var(--s-3) * -1); }
  /* 手机上源域名单独一行，「→ 目标 · 300 秒」是第二行：箭头总在行首，不留左边距；秒数不会单独掉到第三行（审计第三轮 M5、第四轮 M1）
     On a phone the source takes a line of its own and 「→ target · 300 秒」 is the second: the arrow always starts it, with no margin before it,
     and the seconds never drop to a third line alone (audit round 3 M5, round 4 M1) */
  .mapping-editor__parsed > code:first-child { display: block; }
  .mapping-editor__to { margin-inline-start: 0; }
  /* 一条读出来的结果占三行，条和条之间 12、条内 2，一眼看出哪几行是一条（规范 6.2，审计第二轮 M5）
     Each parsed entry takes three lines: 12 between entries and 2 within, so the entries read apart (spec 6.2, audit round 2, M5) */
  .mapping-editor__preview { gap: var(--s-3); }
  .mapping-editor__preview li { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .mapping-editor__empty { padding-bottom: var(--s-2); }
  /* 工具栏下面隔 24，和组与组之间一样：下面那一块（批量框的说明、第一条映射）离自己的内容更近（规范 6.2，审计第四轮 M2）
     24 under the toolbar, as between groups: the block below (the bulk hint, the first mapping) sits nearer its own content (spec 6.2, audit round 4, M2) */
  .mapping-editor { row-gap: var(--s-5); }
  /* 手机上的顺序：命令、批量框（展开时紧跟在它的按钮下面）、规则的说明、列表。说明挨着它说的列表：离命令 12，离第一条映射的格子只有 4，
     按字算上 14、下 25，和解析编排的说明一样（规范 2.2、6.3，审计第七轮 M1、第八轮 M1、M2）
     On a phone the order is: commands, the bulk box (right under its trigger when open), the rule note, the list. The note sits with the list
     it describes: 12 under the commands and only 4 above the first mapping's cell, which reads 14 above and 25 below by ink, as 解析编排's
     note does (spec 2.2, 6.3, audit round 7 M1, round 8 M1, M2) */
  .mapping-editor__bar { display: contents; }
  .mapping-editor__order { order: 1; }
  :is(.mapping-editor__list, .mapping-editor__empty) { order: 2; }
  .mapping-editor:not(:has(.mapping-editor__bulk)) .mapping-editor__order { margin-top: calc(var(--s-3) - var(--s-5)); }
  .mapping-editor__list { margin-top: calc(var(--s-1) - var(--s-5)); }
  .mapping-editor__bulk { margin-bottom: 0; }
  .mapping-editor__empty { padding-top: 0; }
}
</style>
