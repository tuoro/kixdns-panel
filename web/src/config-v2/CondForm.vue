<script setup lang="ts">
import { ChevronDown, ChevronRight, Plus, Trash2, X } from '@lucide/vue'
import { computed, nextTick, ref } from 'vue'
import UiMenu from '../components/ui/UiMenu.vue'
import UiSelect from '../components/ui/UiSelect.vue'
import UiTabs from '../components/ui/UiTabs.vue'
import { newOf, opPart, SUGGEST, type AnyCond } from '../config-model/condKinds'
import { opOf, valueProblem, type FieldDef } from '../config-model/model'
import ChipsInput from './ChipsInput.vue'
import { usePhone } from './phone'
import PhoneSheet from './PhoneSheet.vue'
import { newId } from './store'

// 条件表单：一个条件一行，从左往右读成一句话——「域名　[不是 ▾]　[beta.apple.com]　×」，和邮件规则、防火墙规则一个写法。
// 有两项以上才出现顶上那句「满足以下 [全部 ▾] 条件……」；只有一项时没有可选的，不摆出来。
// 「添加条件」只列字段，每次都新加一行（同一字段可以有几行：是 apple.com、不是 beta.apple.com）；最底下是「条件组」，
// 要混着用「全部」和「任一」时才用到：一块浅底，组里的行和外面的行对在同几条竖线上，只有一层。
// The condition form: one condition per row, read left to right as a sentence — 「域名 [不是 ▾] [beta.apple.com] ×」, the way
// mail rules and firewall rules are written. The 「满足以下 [all ▾] 条件」 sentence appears only with two or more items. 添加条件
// lists fields only and always adds a new row (one field may have several: is apple.com, is not beta.apple.com); 条件组 at the
// bottom is for mixing all and any: a lightly shaded block whose rows line up with the outer rows, one level deep.
type Match = 'all' | 'any'
interface AnyGroup { id: number; group: true; match: Match; items: AnyCond[] }
type AnyItem = AnyCond | AnyGroup
interface AnyTree { match: Match; items: AnyItem[] }

const props = withDefaults(defineProps<{
  modelValue: AnyTree
  fields: Record<string, FieldDef>
  // 「添加条件」菜单里字段的顺序 / The order of fields in the 添加条件 menu
  order: string[]
  groups?: boolean
  nested?: boolean
  // 顶上那句话的前后两半，中间是「全部 / 任一」 / The two halves of the top sentence around 全部 / 任一
  lead?: [string, string]
  empty?: string
  showErrors?: boolean
}>(), { groups: true, nested: false, lead: () => ['满足以下', '条件时用这条规则'], empty: '没有条件，所有请求都会用这条规则。', showErrors: false })
const emit = defineEmits<{ 'update:modelValue': [value: AnyTree] }>()
const MATCHES = [{ value: 'all', label: '全部' }, { value: 'any', label: '任一' }]
const GROUP = '__group'
const phone = usePhone()
const root = ref<HTMLElement | null>(null)
const editing = ref<number | null>(null)
const isGroup = (item: AnyItem): item is AnyGroup => 'group' in item
const menu = computed(() => [
  ...props.order.map((f) => ({ value: f, label: props.fields[f]!.label })),
  ...(props.groups && !props.nested ? [{ value: GROUP, label: '条件组（混用全部和任一）' }] : []),
])
const editingCond = computed(() => {
  const item = editing.value === null ? null : props.modelValue.items[editing.value]
  return item && !isGroup(item) ? item : null
})

const def = (c: AnyCond) => props.fields[c.field]!
const op = (c: AnyCond) => opOf(def(c), c)
const ops = (c: AnyCond) => def(c).ops.map((o) => ({ value: o.value, label: o.label }))
// 手机行的第二行：比较在前、值在后（「不是 beta.apple.com」），和桌面那一行读法一样 / The phone row's second line: comparison then values (「不是 beta.apple.com」), read the same as the desktop row
// 手机行的名字已经是字段名，第二行只写选项本身（「属于 cn」「是内网」），不用带主语的那句 / The phone row's name is the field already, so its second line says just the option (「属于 cn」, 「是内网」), not the sentence with a subject
const opWord = (c: AnyCond) => op(c).label
const valid = (c: AnyCond) => (v: string) => !def(c).valid || def(c).valid!(v, c)
const problem = (c: AnyCond) => (props.showErrors ? valueProblem(def(c), c) : null)
const setItems = (items: AnyItem[]) => emit('update:modelValue', { ...props.modelValue, items })
const setMatch = (match: string) => emit('update:modelValue', { ...props.modelValue, match: match as Match })
function patch(i: number, part: Partial<AnyCond>): void {
  setItems(props.modelValue.items.map((c, j) => (j === i && !isGroup(c) ? { ...c, ...part } : c)))
}
function setOp(i: number, value: string): void {
  const item = props.modelValue.items[i]
  if (!item || isGroup(item)) return
  const next = def(item).ops.find((o) => o.value === value)
  if (next) patch(i, opPart(next))
}
function patchGroup(i: number, tree: AnyTree): void {
  setItems(props.modelValue.items.map((c, j) => (j === i && isGroup(c) ? { ...c, match: tree.match, items: tree.items.filter((x): x is AnyCond => !isGroup(x)) } : c)))
}
function remove(i: number): void {
  editing.value = null
  setItems(props.modelValue.items.filter((_, j) => j !== i))
}
async function focusRow(i: number): Promise<void> {
  if (phone.value) {
    editing.value = i
    await nextTick()
    document.querySelector<HTMLInputElement>('.psheet .chips input')?.focus()
    return
  }
  await nextTick()
  const row = root.value?.querySelectorAll<HTMLElement>(':scope > .cform__row')
  const index = props.modelValue.items.slice(0, i + 1).filter((x) => !isGroup(x)).length - 1
  row?.[index]?.querySelector<HTMLInputElement>('input')?.focus()
}
async function add(value: string): Promise<void> {
  if (value === GROUP) { addGroup(); return }
  const items = [...props.modelValue.items, newOf(value, newId(), props.fields)]
  setItems(items)
  await focusRow(items.length - 1)
}
// 新的条件组默认和外面相反：外面「全部」，组里「任一」，这正是要加组的原因 / A new group defaults to the opposite of the outside: all outside, any inside, which is why one adds a group
function addGroup(): void {
  setItems([...props.modelValue.items, { id: newId(), group: true, match: props.modelValue.match === 'all' ? 'any' : 'all', items: [] }])
}
</script>

<template>
  <div ref="root" class="cform" :class="{ 'cform--nested': nested, 'cform--phone': phone }">
    <p v-if="!nested && modelValue.items.length > 1" class="cform__match"><span>{{ lead[0] }}</span><UiSelect :model-value="modelValue.match" :options="MATCHES" label="满足全部还是任一条件" size="sm" @update:model-value="setMatch" /><span>{{ lead[1] }}</span></p>
    <p v-if="!modelValue.items.length && (nested || empty)" class="cform__empty">{{ nested ? '这一组还没有条件。' : empty }}</p>
    <template v-for="(item, i) in modelValue.items" :key="item.id">
      <div v-if="isGroup(item)" class="cform__group">
        <div class="cform__ghead"><span>这一组满足</span><UiSelect :model-value="item.match" :options="MATCHES" label="这一组满足全部还是任一条件" size="sm" @update:model-value="patchGroup(i, { match: $event as Match, items: item.items })" /><span>条件</span><button class="ui-icon-btn ui-icon-btn--sm cform__x cform__gx" type="button" aria-label="去掉这一组" title="去掉这一组" @click="remove(i)"><X :size="16" /></button></div>
        <CondForm nested :model-value="{ match: item.match, items: item.items }" :fields="fields" :order="order" :groups="false" :show-errors="showErrors" @update:model-value="patchGroup(i, $event)" />
      </div>
      <div v-else-if="!phone" class="cform__row">
        <span class="cform__label">{{ def(item).label }}</span>
        <UiSelect v-if="def(item).ops.length > 1" class="cform__op" :model-value="op(item).value" :options="ops(item)" :label="`${def(item).label}怎么比`" @update:model-value="setOp(i, $event)" />
        <span v-else class="cform__label cform__op">{{ op(item).label }}</span>
        <div v-if="def(item).values" class="cform__ctl">
          <ChipsInput :class="{ 'is-mono': def(item).mono }" :model-value="item.values" :label="def(item).label" :placeholder="def(item).placeholder" :suggestions="SUGGEST[item.field] ?? []" :upper="def(item).upper" :spaces="item.field === 'txt'" :valid="valid(item)" :invalid="Boolean(problem(item))" @update:model-value="patch(i, { values: $event })" />
          <p v-if="problem(item)" class="ui-field-error">{{ problem(item) }}</p>
        </div>
        <span v-else />
        <button class="ui-icon-btn ui-icon-btn--sm cform__x" type="button" :aria-label="`去掉「${def(item).label}」`" :title="`去掉「${def(item).label}」`" @click="remove(i)"><X :size="16" /></button>
      </div>
      <button v-else class="cform__row cform__prow" :class="{ 'is-bad': Boolean(problem(item)) }" type="button" @click="editing = i">
        <span><b>{{ def(item).label }}</b><span class="cform__sum"><span v-if="def(item).values && !item.values.length" class="is-empty">还没填值</span><template v-else>{{ opWord(item) }}<template v-if="def(item).values">{{ ' ' }}<span :class="{ 'is-mono': def(item).mono }">{{ item.values.join('、') }}</span></template></template></span></span>
        <ChevronRight :size="16" aria-hidden="true" />
      </button>
    </template>
    <UiMenu :items="nested ? menu.filter((m) => m.value !== GROUP) : menu" label="添加条件" align="start" :trigger-class="phone ? 'cform__padd' : 'ui-btn ui-btn--text ui-btn--sm ui-btn--inline cform__add'" @select="add"><Plus :size="14" aria-hidden="true" />添加条件<ChevronDown v-if="!phone" :size="14" aria-hidden="true" /></UiMenu>
  </div>
  <PhoneSheet v-if="phone && editingCond" :title="def(editingCond).label" @close="editing = null">
    <UiTabs v-if="!def(editingCond).values || def(editingCond).ops.length === 2" :model-value="op(editingCond).value" :items="ops(editingCond)" :label="`${def(editingCond).label}怎么比`" variant="segment" @update:model-value="setOp(editing!, $event)" />
    <UiSelect v-else :model-value="op(editingCond).value" :options="ops(editingCond)" :label="`${def(editingCond).label}怎么比`" @update:model-value="setOp(editing!, $event)" />
    <template v-if="def(editingCond).values">
      <ChipsInput :class="{ 'is-mono': def(editingCond).mono }" :model-value="editingCond.values" :label="def(editingCond).label" :placeholder="def(editingCond).placeholder" :suggestions="SUGGEST[editingCond.field] ?? []" :upper="def(editingCond).upper" :spaces="editingCond.field === 'txt'" :valid="valid(editingCond)" :invalid="Boolean(problem(editingCond))" @update:model-value="patch(editing!, { values: $event })" />
      <p class="cform__help">{{ op(editingCond).negate ? '可以填几个，全都不符合才算' : '可以填几个，符合其中一个就算' }}</p>
    </template>
    <template #foot><button class="ui-btn ui-btn--text psheet__delete" type="button" @click="remove(editing!)"><Trash2 :size="16" aria-hidden="true" />删除</button></template>
  </PhoneSheet>
</template>
