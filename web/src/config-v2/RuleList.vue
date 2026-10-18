<script setup lang="ts">
import { ArrowDownToLine, ChevronRight, CornerDownRight } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import UiSelect from '../components/ui/UiSelect.vue'
import { useToast } from '../composables/useToast'
import RuleRow from './RuleRow.vue'
import { parseOwnRules } from '../config-model/blocklist'
import { blockLabel, blocklistEntries, conditionsText, outcomePill, mappingIsIp, type Outcome, type Rule, ruleTitle } from '../config-model/model'
import { model, newId } from './store'
import { blocklists, loadBlocklists } from './useBlocklists'

// 一列规则：主列表或一个规则组。最上面是先生效的域名映射（只在主列表），最下面钉着「其余请求」。
// 拖手柄或用菜单调整顺序；筛选时不能拖，免得把看不见的规则挤乱。
// One list of rules: the main list or a rule group. Local mappings, which act first, sit on top (main list only) and
// 其余请求 is pinned at the bottom. Reorder by the grip or the menu; dragging is off while filtered so hidden rules stay put.
const props = defineProps<{
  rules: Rule[]
  owner: { rest: Outcome }
  inGroup: boolean
  query: string
  kind: string
  marks: Map<number, 'hit' | 'pass'>
  restMark: boolean
  mappingMark: boolean
  blocklistMark?: boolean
  selected?: number | null
}>()
const emit = defineEmits<{ open: [id: number]; mappings: []; blocklists: [] }>()
const toast = useToast()

const filtered = computed(() => props.query.trim() !== '' || props.kind !== '')
const visible = computed(() => props.rules.map((rule, i) => ({ rule, index: i + 1 })).filter(({ rule }) => {
  if (props.kind && rule.outcome.type !== props.kind) return false
  const q = props.query.trim().toLowerCase()
  if (!q) return true
  const hay = [rule.name, rule.note, conditionsText(rule.conditions), ...rule.conditions.flat().flatMap((c) => c.values), outcomePill(model, rule.outcome).value, rule.raw ? JSON.stringify(rule.raw) : ''].join(' ').toLowerCase()
  return hay.includes(q)
}))
const liveMappings = computed(() => model.mappings.filter((r) => r.enabled))
// 拦截列表排在域名映射后面、所有规则前面：启用了的订阅（已经合成了文件）和用得上的自己写的规则
// The blocklists come after the mappings and before every rule: the enabled subscriptions (once a file is built) and the own rules in use
// 下载没成功、没进合成文件的不算；还不知道各列表情况时按开着的算 / Lists that never downloaded are not in the file and do not count; before the statuses are known every enabled one does
const liveLists = computed(() => (model.blocklists.file ? model.blocklists.subscriptions.filter((s) => s.enabled && (blocklists.status !== 'ok' || blocklists.sources[s.url]?.sha256)) : []))
onMounted(() => { if (model.blocklists.subscriptions.length) void loadBlocklists() })
const ownRules = computed(() => parseOwnRules(model.blocklists.custom).rules.length)
// 内核里真有拦截列表的入口才显示这一行：只写了放行、又没有列表时什么也不拦 / The row shows only when the kernel really gets blocklist entries: allows
// alone, with no list, block nothing
const blocking = computed(() => blocklistEntries(model).length > 0)
// 列表名之间用顿号，和自己写的规则之间用逗号，不让「自己写的」读成又一个列表 / 顿号 between list names and a comma before the own rules, so they do not read as one more list
const listSummary = computed(() => {
  const names = liveLists.value.map((s) => s.name)
  const lists = names.length <= 2 ? names.join('、') : `${names.slice(0, 2).join('、')} 等 ${names.length} 个列表`
  return [lists, ownRules.value ? `自己写的规则 ${ownRules.value} 条` : ''].filter(Boolean).join('，')
})
const listShort = computed(() => [liveLists.value.length ? `${liveLists.value.length} 个列表` : '', ownRules.value ? `自己写的规则 ${ownRules.value} 条` : ''].filter(Boolean).join('，'))
const mappingSummary = computed(() => {
  const names = liveMappings.value.map((r) => r.domain)
  return names.length <= 2 ? names.join('、') : `${names.slice(0, 2).join('、')} 等 ${names.length} 个域名`
})

// 其余请求：交给哪个上游组，或者拦截 / The catch-all: which upstream group, or block
const restOptions = computed(() => [...model.groups.map((g) => ({ value: `up:${g.id}`, label: `交给「${g.name}」` })), { value: 'block', label: '拦截' }])
const restValue = computed(() => (props.owner.rest.type === 'upstream' ? `up:${props.owner.rest.group}` : 'block'))
function setRest(value: string): void {
  props.owner.rest = value === 'block' ? { type: 'block', response: 'default' } : { type: 'upstream', group: value.slice(3) }
}

function act(rule: Rule, value: string): void {
  const list = props.rules
  const at = list.indexOf(rule)
  const move = (to: number) => { list.splice(at, 1); list.splice(to, 0, rule) }
  if (value === 'edit') emit('open', rule.id)
  else if (value === 'duplicate') {
    const copy = { ...JSON.parse(JSON.stringify(rule)) as Rule, id: newId(), name: rule.name.trim() ? `${rule.name} 副本` : '', edited: new Date().toISOString() }
    list.splice(at + 1, 0, copy)
    toast.success(rule.name.trim() ? `已复制为「${copy.name}」` : '已复制一条，排在它下面')
  } else if (value === 'up') move(at - 1)
  else if (value === 'down') move(at + 1)
  else if (value === 'top') move(0)
  else if (value === 'bottom') move(list.length - 1)
  else if (value === 'delete') {
    list.splice(at, 1)
    toast.undoable(`已删除「${ruleTitle(rule)}」`, () => list.splice(Math.min(at, list.length), 0, rule))
  }
}

// 到不了的规则：前面有一条启用的、接住所有请求又决定结果的规则 / Unreachable rules: an earlier enabled catch-all that decides comes first
const shadow = computed(() => {
  const out = new Map<number, number>()
  let by: number | null = null
  props.rules.forEach((r, i) => {
    if (by !== null && r.enabled) out.set(r.id, by)
    if (by === null && r.enabled && !r.raw && r.conditions.every((g) => !g.length) && r.outcome.type !== 'continue') by = i + 1
  })
  return out
})

// ---------- 拖动排序 / drag to reorder ----------
const dragging = ref<number | null>(null)
const dropAt = ref<number | null>(null)
const listEl = ref<HTMLElement | null>(null)
function startDrag(rule: Rule, event: PointerEvent): void {
  if (filtered.value || event.button !== 0) return
  event.preventDefault()
  dragging.value = rule.id
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', endDrag, { once: true })
}
function onMove(event: PointerEvent): void {
  const rows = [...(listEl.value?.querySelectorAll<HTMLElement>('.rrow') ?? [])]
  let at = rows.length
  for (const [i, row] of rows.entries()) {
    const box = row.getBoundingClientRect()
    if (event.clientY < box.top + box.height / 2) { at = i; break }
  }
  dropAt.value = at
}
function endDrag(): void {
  window.removeEventListener('pointermove', onMove)
  const id = dragging.value
  const to = dropAt.value
  dragging.value = null
  dropAt.value = null
  if (id === null || to === null) return
  const list = props.rules
  const from = list.findIndex((r) => r.id === id)
  const rule = list[from]!
  const target = to > from ? to - 1 : to
  if (target === from) return
  list.splice(from, 1)
  list.splice(target, 0, rule)
}
onBeforeUnmount(() => window.removeEventListener('pointermove', onMove))
</script>

<template>
  <div class="rlist" :class="{ 'is-dragging': dragging !== null }">
    <div class="rlist__head" aria-hidden="true"><span>#</span><span>规则<span v-if="!inGroup" class="rlist__order">从上往下判断，第一条决定结果的规则生效</span></span><span>结果</span><span class="rlist__hits">命中</span><span>启用</span><span></span></div>
    <div v-if="!inGroup && liveMappings.length && !filtered" class="rpin" :class="{ 'is-hit': mappingMark }">
      <span class="rrow__num"><CornerDownRight :size="14" aria-hidden="true" /></span>
      <button class="rrow__main" type="button" @click="emit('mappings')">
        <span class="rrow__name"><b>域名映射</b><span v-if="mappingMark" class="ui-tag ui-tag--ok">命中</span></span>
        <span class="rrow__cond"><span class="rpin__long">{{ mappingSummary }}，先于下面所有规则</span><span class="rpin__short">{{ liveMappings.length }} 个域名，先于下面所有规则</span></span>
      </button>
      <ChevronRight class="rpin__chev" :size="16" aria-hidden="true" />
      <span class="rrow__pill"><span class="opill"><span class="opill__verb">回答</span><span class="opill__val">{{ liveMappings.every(mappingIsIp) ? '固定 IP' : '固定 IP 或域名' }}</span></span></span>
      <span class="rpin__link"><button class="ui-link" type="button" @click="emit('mappings')">管理域名映射</button></span>
    </div>
    <div v-if="!inGroup && blocking && !filtered" class="rpin" :class="{ 'is-hit': blocklistMark }">
      <span class="rrow__num"><CornerDownRight :size="14" aria-hidden="true" /></span>
      <button class="rrow__main" type="button" @click="emit('blocklists')">
        <span class="rrow__name"><b>拦截列表</b><span v-if="blocklistMark" class="ui-tag ui-tag--ok">命中</span></span>
        <span class="rrow__cond"><span class="rpin__long">{{ listSummary }}，先于下面所有规则</span><span class="rpin__short">{{ listShort }}，先于下面所有规则</span></span>
      </button>
      <ChevronRight class="rpin__chev" :size="16" aria-hidden="true" />
      <span class="rrow__pill"><span class="opill opill--block"><span class="opill__verb">拦截</span><span class="opill__val">{{ blockLabel(model, 'default') }}</span></span></span>
      <span class="rpin__link"><button class="ui-link" type="button" @click="emit('blocklists')">管理拦截列表</button></span>
    </div>
    <ol ref="listEl" class="rlist__rows">
      <template v-for="(item, i) in visible" :key="item.rule.id">
        <li v-if="dropAt === i" class="rlist__drop" aria-hidden="true"></li>
        <RuleRow :rule="item.rule" :index="item.index" :count="rules.length" :mark="marks.get(item.rule.id) ?? null" :shadowed-by="shadow.get(item.rule.id) ?? null" :selected="item.rule.id === selected" :draggable="!filtered" :class="{ 'is-lifted': dragging === item.rule.id }"
          @open="emit('open', item.rule.id)" @action="act(item.rule, $event)" @grip="startDrag(item.rule, $event)" />
      </template>
      <li v-if="dropAt === visible.length" class="rlist__drop" aria-hidden="true"></li>
    </ol>
    <p v-if="filtered && !visible.length" class="rlist__none">没有符合的规则</p>
    <!-- 一条规则都没有时的说明放在表头下面、「其余请求」上面，和规则排在同一处 / With no rules at all, the note sits under the header and above 其余请求, where rules would be -->
    <slot v-if="!rules.length" name="empty" />
    <div class="rpin rpin--rest" :class="{ 'is-hit': restMark }">
      <span class="rrow__num"><ArrowDownToLine :size="14" aria-hidden="true" /></span>
      <span class="rrow__main rrow__main--static">
        <span class="rrow__name"><b>其余请求</b><span v-if="restMark" class="ui-tag ui-tag--ok">命中</span></span>
        <span class="rrow__cond">{{ inGroup ? '这个组里一条都没命中的请求' : '上面一条都没命中的请求' }}</span>
      </span>
      <span class="rrow__pill rpin__rest"><UiSelect :model-value="restValue" :options="restOptions" label="其余请求怎么处理" size="sm" @update:model-value="setRest" /></span>
    </div>
  </div>
</template>
