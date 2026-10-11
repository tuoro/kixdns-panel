<script setup lang="ts">
import { ArrowDown, ArrowLeft, Ban, ChevronDown, ChevronRight, CornerDownRight, Info, MessageSquareText, Server, Trash2 } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import JsonEditor from '../components/JsonEditor.vue'
import UiSelect from '../components/ui/UiSelect.vue'
import { useConfirm } from '../composables/useConfirm'
import UiTabs from '../components/ui/UiTabs.vue'
import UiHelp from '../components/ui/UiHelp.vue'
import { REQUEST_ORDER, RESPONSE_ORDER } from '../config-model/condKinds'
import { toDnf, toTree, treeText, type CondTree } from '../config-model/condTree'
import { actionFieldErrors, matcherFieldErrors } from '../config-editor/field-validation'
import type { PipelineConfig, RuleConfig } from '../config-editor/types'
import {
  compile, conditionText, ecsText, fallbackSentence, FIELD, kernelPreview, mainPipelineId, newRule, ruleGroupPipelineId, rawMatchersText, withShi, outcomeSentence, remedySentence, RESPONSE_FIELD, responseConditionText,
  ruleProblems, type Ecs, type Outcome, type Remedy, type ResponseCondition, type Rule,
  ruleTitle,
} from '../config-model/model'
import CondForm from './CondForm.vue'
import OutcomeParams from './OutcomeParams.vue'
import { usePhone } from './phone'
import PhoneSheet from './PhoneSheet.vue'
import RawRuleEditor from './RawRuleEditor.vue'
import { hitsOf, listOf, model, newId } from './store'
import { runtimeCapabilities } from './useConfigDocument'
import { editedText, groupBrief } from './view'

// 编辑一条规则：左边是「如果 / 那么 / 上游回答后 / 其他」，右边随时读出这条规则会做什么。
// 改的是一份副本，点「完成」才写回草稿；写错的地方在原处标出来。
// Editing one rule: 如果 / 那么 / 上游回答后 / 其他 on the left, and on the right a live reading of what the rule does.
// Edits go to a copy that 完成 writes back to the draft; mistakes are marked where they are.
// inspector：宽屏上在列表右边的面板里编辑，没有面包屑和右栏，各区块收成一列 / inspector: on wide screens the rule is edited in the panel beside the list, without crumbs or the aside, sections stacked in one column
const props = withDefaults(defineProps<{ ruleId: number | null; groupId: string | null; template?: Partial<Rule>; inspector?: boolean }>(), { inspector: false })
const emit = defineEmits<{ close: []; saved: [rule: Rule, isNew: boolean]; deleted: [rule: Rule, index: number, list: Rule[]]; editGroup: [id: string] }>()

const list = computed(() => (props.ruleId !== null ? listOf(props.ruleId).rules : props.groupId ? model.ruleGroups.find((g) => g.id === props.groupId)!.rules : model.rules))
const original = props.ruleId !== null ? list.value.find((r) => r.id === props.ruleId)! : null
// 空白规则就是空的：不预填一行「域名」逼人先填域名，条件从「添加条件」里按需加 / A blank rule is blank: no pre-filled 域名 row demanding a domain first; conditions come from 添加条件 as needed
const draft = reactive<Rule>(original ? JSON.parse(JSON.stringify(original)) as Rule : { ...newRule(newId(), { type: 'upstream', group: model.rest.type === 'upstream' ? model.rest.group : model.groups[0]?.id ?? '' }), ...JSON.parse(JSON.stringify(props.template ?? {})) as Partial<Rule> })
// 离开前对照：改过就先问一句 / Compared on leaving: ask first if anything changed
const initial = JSON.stringify(draft)
const confirm = useConfirm()
async function leave(): Promise<void> {
  if (JSON.stringify(draft) !== initial && !(await confirm.ask({ title: '放弃这条规则的修改', body: '刚才在这里改的内容不会写进草稿。', confirmLabel: '放弃修改', cancelLabel: '继续编辑' }))) return
  emit('close')
}
// Esc 返回、Ctrl/Cmd+Enter 完成；对话框开着时不抢 / Esc goes back, Ctrl/Cmd+Enter finishes; not while a dialog is open
function onKey(event: KeyboardEvent): void {
  if (document.querySelector('dialog[open]')) return
  if (event.key === 'Escape' && !(event.target instanceof HTMLElement && event.target.closest('[role="menu"]'))) { event.preventDefault(); void leave() }
  else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); done() }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
// 高级规则：直接改内核规则的 JSON / An advanced rule: edit the kernel rules' JSON directly
// 高级规则有两种改法：按内核字段的表单（RawRuleEditor，条件表 + 动作表）和 JSON；来回切换时同步，JSON 写错了切不回表单
// An advanced rule is edited two ways: a form by the kernel's fields (RawRuleEditor: matcher and action lists) or JSON; the two sync on switching, and broken JSON cannot return to the form
const asRuleConfig = (r: Record<string, unknown>): RuleConfig => ({ matchers: [], matcher_operator: 'and', actions: [], response_matchers: [], response_matcher_operator: 'and', response_actions_on_match: [], response_actions_on_miss: [], ...r, name: String(r.name ?? '') } as RuleConfig)
const rawRules = reactive<RuleConfig[]>((draft.raw ?? []).map(asRuleConfig))
const rawMode = ref<'form' | 'json'>('form')
const rawModes = [{ value: 'form', label: '表单' }, { value: 'json', label: 'JSON' }]
const rawText = ref('')
const rawError = computed(() => {
  if (!draft.raw || rawMode.value !== 'json') return ''
  try {
    const v = JSON.parse(rawText.value) as unknown
    if (!Array.isArray(v) || !v.length || !v.every((r) => r && typeof r === 'object' && typeof (r as { name?: unknown }).name === 'string')) return '要写成内核规则的数组，每条都有 name'
    return ''
  } catch (e) { return (e as Error).message }
})
function setRawMode(next: string): void {
  if (next === rawMode.value) return
  if (next === 'json') { rawText.value = JSON.stringify(rawRules, null, 2); rawMode.value = 'json'; return }
  if (rawError.value) return
  rawRules.splice(0, rawRules.length, ...(JSON.parse(rawText.value) as Record<string, unknown>[]).map(asRuleConfig))
  rawMode.value = 'form'
}
// 当前这一种写法里的内核规则 / The kernel rules as the active view holds them
const currentRaw = (): Record<string, unknown>[] => (rawMode.value === 'form' ? JSON.parse(JSON.stringify(rawRules)) as Record<string, unknown>[] : JSON.parse(rawText.value) as Record<string, unknown>[])
// 表单里写错的字段由条件表 / 动作表自己标红，这里只数出来给底栏 / The lists mark bad fields themselves; this only counts them for the footer
const kernelPipelines = computed<PipelineConfig[]>(() => compile(model).pipelines.map((p) => ({ id: p.id, rules: [] })))
const ownPipelineId = computed(() => { const g = props.groupId ?? (props.ruleId !== null ? listOf(props.ruleId).group?.id ?? null : null); return g ? ruleGroupPipelineId(model, g) : mainPipelineId(model) })
const rawFieldProblems = computed(() => {
  if (!draft.raw || rawMode.value !== 'form') return 0
  const ids = kernelPipelines.value.map((p) => p.id)
  return rawRules.reduce((n, r) => n
    + r.matchers.filter((m) => Object.keys(matcherFieldErrors(m, 'request')).length).length
    + r.response_matchers.filter((m) => Object.keys(matcherFieldErrors(m, 'response')).length).length
    + [...r.actions, ...r.response_actions_on_match, ...r.response_actions_on_miss].filter((a) => Object.keys(actionFieldErrors(a, ownPipelineId.value, ids)).length).length
    + (r.name.trim() ? 0 : 1), 0)
})
const position = ref(original ? list.value.indexOf(original) : list.value.length)
const showErrors = ref(false)
const problems = computed(() => [...ruleProblems(model, draft), ...(rawError.value ? [`内核规则写错了：${rawError.value}`] : []), ...(rawFieldProblems.value ? [`内核规则里有 ${rawFieldProblems.value} 处没填对（标红的那些）`] : [])])
const nameInput = ref<HTMLInputElement | null>(null)
onMounted(() => { if (!original) void nextTick(() => nameInput.value?.focus()) })

// ---------- 如果 / conditions ----------
// 条件表单编辑的是「全部 / 任一 + 一层条件组」，每次改动都换算回保存格式（几组条件，组间为或）；打开编辑页时从保存格式读一次
// The condition form edits 「all / any plus one level of groups」, converted back to the saved format (groups joined by OR) on
// every change; opening the editor reads the saved format once
const condTree = ref<CondTree>(toTree(draft.conditions, newId))
function setTree(tree: CondTree): void {
  condTree.value = tree
  draft.conditions = toDnf(tree)
}
const phone = usePhone()
// 面板里「回答后检查」「更多」平时收着，标题行写一句摘要 / In the inspector 回答后检查 and 更多 stay folded with a one-line summary in the title row
const open = reactive({ after: false, more: false })
const afterSummary = computed(() => {
  const r = draft.response
  if (r.mode === 'off') return '不检查'
  if (r.mode === 'custom') return r.conditions.length ? `${r.conditions.map(responseConditionText).join(r.match === 'all' ? ' 且 ' : '，或 ')}时${remedySentence(model, r.then)}` : '单独设置，还没写条件'
  const f = upstreamGroup.value ? fallbackSentence(model, upstreamGroup.value) : ''
  return f ? `沿用上游组：${f}` : '沿用上游组'
})
const moreSummary = computed(() => [draft.log.enabled ? `日志${levelLabel(draft.log.level)}` : '日志关', ...(draft.outcome.type === 'upstream' ? [draft.ecs === 'inherit' ? 'ECS 沿用' : ecsText(draft.ecs)] : []), positions.value[position.value]?.label.replace(/ · .*$/, '') ?? '', draft.note ? '有备注' : '无备注'].filter(Boolean).join(' · '))

// ---------- 那么 / outcome ----------
const OUTCOMES = [
  { type: 'upstream', title: '交给上游组', desc: '按组里的设置解析', icon: Server },
  { type: 'block', title: '拦截', desc: '不解析，直接回应', icon: Ban },
  { type: 'answer', title: '自定义回答', desc: '回答指定的记录', icon: MessageSquareText },
  { type: 'group', title: '转到规则组', desc: '交给另一组规则', icon: CornerDownRight },
  { type: 'continue', title: '继续往下', desc: '只记录，不做决定', icon: ArrowDown },
] as const
// 切换类型时记住之前填的，切回来还在 / Switching type remembers what was filled, so switching back restores it
const remembered: Partial<Record<Outcome['type'], Outcome>> = { [draft.outcome.type]: draft.outcome }
// 手机上「那么」「然后」「否则」是一行字，点开在弹层里选 / On a phone 那么, 然后 and 否则 are lines of text that open a sheet
const sheet = ref<'outcome' | 'then' | 'otherwise' | 'ecs' | 'note' | null>(null)
const outcomeNote = computed(() => {
  const o = draft.outcome
  if (o.type === 'upstream') { const g = model.groups.find((x) => x.id === o.group); return g ? groupBrief(g) : '这个组已经删掉了，选一个现有的组' }
  if (o.type === 'continue') return '常和「记录日志」一起用，只记录某些请求'
  return ''
})
function pickOutcome(type: Outcome['type']): void {
  if (type === draft.outcome.type) return
  remembered[draft.outcome.type] = draft.outcome
  draft.outcome = remembered[type] ?? (
    type === 'upstream' ? { type, group: model.rest.type === 'upstream' ? model.rest.group : model.groups[0]?.id ?? '' }
      : type === 'block' ? { type, response: 'default' }
        : type === 'answer' ? { type, kind: 'ip', value: '', ttl: null }
          : type === 'group' ? { type, group: model.ruleGroups[0]?.id ?? '' }
            : { type })
}

// ---------- 上游回答后 / answer check ----------
const upstreamGroup = computed(() => (draft.outcome.type === 'upstream' ? model.groups.find((g) => g.id === (draft.outcome as { group: string }).group) : undefined))
const responseModes = [{ value: 'inherit', label: '沿用上游组' }, { value: 'custom', label: '单独设置' }, { value: 'off', label: '不检查' }]
const thenKinds = [{ value: 'upstream', label: '改问上游组' }, { value: 'block', label: '拦截' }, { value: 'answer', label: '自定义回答' }, { value: 'group', label: '转到规则组' }, { value: 'rewrite_txt', label: '替换 TXT 内容' }]
const elseKinds = [{ value: 'none', label: '照常返回' }, ...thenKinds]
function remedyOf(type: string): Remedy {
  if (type === 'upstream') return { type, group: model.groups.find((g) => g.id !== upstreamGroup.value?.id)?.id ?? '' }
  if (type === 'block') return { type, response: 'default' }
  if (type === 'answer') return { type, kind: 'ip', value: '', ttl: null }
  if (type === 'group') return { type, group: model.ruleGroups[0]?.id ?? '' }
  if (type === 'rewrite_txt') return { type, value: '' }
  return { type: 'none' }
}
// 常用的几种检查，一点就填好 / Common checks, filled in with one click
const PRESETS: { label: string; apply: () => void }[] = [
  { label: '结果被污染', apply: () => { draft.response.match = 'any'; draft.response.conditions = [{ id: newId(), field: 'answer_ip', negate: false, values: ['0.0.0.0/32', '240.0.0.0/4', '255.255.255.255/32'] }]; draft.response.then = remedyOf('upstream') } },
  { label: '回答了内网地址（防 DNS 重绑定）', apply: () => { draft.response.match = 'any'; draft.response.conditions = [{ id: newId(), field: 'answer_private', negate: false, values: [] }]; draft.response.then = { type: 'block', response: 'REFUSED' } } },
  { label: '上游出错', apply: () => { draft.response.match = 'any'; draft.response.conditions = [{ id: newId(), field: 'rcode', negate: false, values: ['SERVFAIL', 'REFUSED'] }]; draft.response.then = remedyOf('upstream') } },
  { label: '回答的不是国内地址', apply: () => { draft.response.match = 'any'; draft.response.conditions = [{ id: newId(), field: 'answer_country', negate: true, values: ['CN'] }]; draft.response.then = remedyOf('upstream') } },
]

// ---------- 其他 / options ----------
const levels = [{ value: 'info', label: '信息' }, { value: 'debug', label: '调试' }, { value: 'warn', label: '警告' }, { value: 'error', label: '错误' }, { value: 'trace', label: '跟踪' }]
const ecsChoice = computed(() => (draft.ecs === 'inherit' ? 'inherit' : draft.ecs === null ? 'none' : draft.ecs.mode))
const ecsOptions = computed(() => [
  { value: 'inherit', label: `沿用上游组（${upstreamGroup.value ? ecsText(upstreamGroup.value.ecs).replace(/（.*）/, '') : '—'}）` },
  { value: 'none', label: '不处理，原样转发' },
  { value: 'clear', label: '不发送客户端子网' },
  { value: 'client', label: '发送客户端所在子网' },
  { value: 'static', label: '发送固定的子网' },
])
const ecsRow = computed(() => (draft.ecs === 'inherit' ? ecsOptions.value[0]!.label : ecsText(draft.ecs)))
const levelLabel = (level: string | null | undefined): string => levels.find((l) => l.value === level)?.label ?? ''
function setEcs(choice: string): void {
  const next: Ecs | 'inherit' = choice === 'inherit' ? 'inherit' : choice === 'none' ? null : choice === 'clear' ? { mode: 'clear' } : choice === 'client' ? { mode: 'client', v4: 24, v6: 56 } : { mode: 'static', subnet: '' }
  draft.ecs = next
}
const positions = computed(() => {
  const n = original ? list.value.length : list.value.length + 1
  return Array.from({ length: n }, (_, i) => ({ value: String(i), label: i === 0 ? '第 1 条 · 最先判断' : i === n - 1 ? `第 ${i + 1} 条 · 最后` : `第 ${i + 1} 条` }))
})

// ---------- 读出来 / the reading ----------
const reading = computed(() => {
  if (draft.raw) {
    try {
      const list = currentRaw() as { matchers?: Record<string, unknown>[]; matcher_operator?: string; actions?: { type: string }[] }[]
      const ACT: Record<string, string> = { forward: '转发', allow: '交给默认上游', deny: '拒绝', static_response: '固定响应码', static_ip_response: '固定 IP', static_cname_response: '固定 CNAME', static_txt_response: '固定 TXT', replace_txt_response: '替换 TXT', jump_to_pipeline: '转到', log: '记录日志', continue: '继续往下' }
      return list.map((r, i) => ({ k: `第 ${i + 1} 条`, v: `${rawMatchersText(r.matchers, r.matcher_operator)} → ${(r.actions ?? []).map((a) => ACT[a.type] ?? a.type).join('、') || '没有动作'}` }))
    } catch { return [{ k: '内核规则', v: 'JSON 还没写对' }] }
  }
  const rows: { k: string; v: string }[] = [{ k: '如果', v: treeText(condTree.value, conditionText) }, { k: '那么', v: outcomeSentence(model, draft.outcome) }]
  if (draft.outcome.type === 'upstream') {
    if (draft.ecs !== 'inherit') rows.push({ k: '子网', v: ecsText(draft.ecs) })
    const r = draft.response
    if (r.mode === 'custom' && r.conditions.length) {
      const when = r.conditions.map(responseConditionText).join(r.match === 'all' ? ' 且 ' : '，或 ')
      rows.push({ k: '回答后', v: `${withShi(when)}${remedySentence(model, r.then)}${r.otherwise.type === 'none' ? '' : `，否则${remedySentence(model, r.otherwise)}`}` })
    } else if (r.mode === 'off') rows.push({ k: '回答后', v: '不检查，原样返回' })
    else if (upstreamGroup.value) {
      const f = fallbackSentence(model, upstreamGroup.value)
      if (f) rows.push({ k: '回答后', v: f })
    }
  }
  if (draft.log.enabled) rows.push({ k: '另外', v: `记录日志（${levels.find((l) => l.value === draft.log.level)!.label}级）` })
  return rows
})
// 名字框空着时显示列表里会用的标题，就是条件本身 / An empty name field shows the title the list will use: the condition itself
// 新规则还没条件时，占位别写「所有请求」——那像个填好的名字；写清楚这格是名字、可以不填 / A new rule without conditions does not show 「所有请求」 as its placeholder (it reads like a filled-in name); say what the field is and that it is optional
const namePlaceholder = computed(() => (!original && !draft.conditions.some((g) => g.length) ? '规则名称，可以不填' : ruleTitle({ ...draft, name: '' } as Rule)))
const readingLead = computed(() => `${withShi(reading.value[0]?.v ?? '')}，${reading.value[1]?.v ?? ''}`)
const readingMore = computed(() => reading.value.slice(2).map((row) => `${row.k}：${row.v}`))

const kernelJson = computed(() => JSON.stringify(kernelPreview(model, draft), null, 2))

// ---------- 完成 / done ----------
// 跳到第一处要改的地方并把光标放进去 / Jump to the first thing to fix and put the caret there
function revealProblem(): void {
  void nextTick(() => {
    const el = document.querySelector<HTMLElement>('.editor [aria-invalid="true"], .editor .is-bad, .editor .chips--bad input, .editor .ui-field-error')
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    // 手机上出错的是一整行按钮，光标就放在这一行 / On phones the bad item is a whole row button, so the caret goes to that row
    const focusable = el?.matches('input, textarea, select, button') ? el : el?.closest('li, .ecard')?.querySelector<HTMLElement>('input, textarea, select')
    focusable?.focus({ preventScroll: true })
  })
}
function done(): void {
  if (problems.value.length) {
    showErrors.value = true
    revealProblem()
    return
  }
  if (draft.raw) draft.raw = currentRaw()
  draft.conditions = draft.conditions.filter((g) => g.length).length ? draft.conditions.filter((g) => g.length) : [[]]
  draft.name = draft.name.trim()
  draft.edited = new Date().toISOString()
  const target = list.value
  const saved = JSON.parse(JSON.stringify(draft)) as Rule
  if (original) target.splice(target.indexOf(original), 1)
  target.splice(Math.min(Number(position.value), target.length), 0, saved)
  emit('saved', saved, !original)
}
function remove(): void {
  if (!original) return
  const target = list.value
  const index = target.indexOf(original)
  target.splice(index, 1)
  emit('deleted', original, index, target)
}
watch(() => draft.outcome.type, (type) => { if (type !== 'upstream') showErrors.value = showErrors.value && problems.value.length > 0 })
</script>

<template>
  <div class="editor ui-fade" :class="{ 'editor--inspector': inspector }" data-config-editing="true">
    <nav v-if="!inspector" class="editor__crumbs" aria-label="位置">
      <button class="ui-btn ui-btn--text ui-btn--sm editor__back" type="button" @click="leave"><ArrowLeft :size="14" aria-hidden="true" />规则</button>
      <template v-if="groupId || (ruleId !== null && listOf(ruleId).group)"><span class="editor__sep" aria-hidden="true">/</span><span>{{ (ruleId !== null ? listOf(ruleId).group : model.ruleGroups.find((g) => g.id === groupId))?.name }}</span></template>
      <span class="editor__sep" aria-hidden="true">/</span><span aria-current="page">{{ original ? '编辑规则' : '新建规则' }}</span>
    </nav>
    <div class="editor__title">
      <button class="ui-icon-btn editor__back-icon" type="button" aria-label="回到规则列表" @click="leave"><ArrowLeft :size="16" /></button>
      <!-- 名字可以不填：不填就用条件当标题 / The name is optional: left empty, the condition becomes the title -->
      <input ref="nameInput" v-model="draft.name" class="editor__name" aria-label="规则名称，可以不填，不填就用条件当名字" title="名字可以不填，列表里用条件当标题" :placeholder="namePlaceholder" maxlength="40">
      <label class="ui-switch editor__enabled"><input v-model="draft.enabled" type="checkbox" aria-label="启用这条规则"><i></i><small>{{ draft.enabled ? '启用' : '已停用' }}</small></label>
    </div>
    <!-- 面板：名字下面一行事实，再一句这条规则会做什么（整页编辑时这句在右栏） / Inspector: a facts line under the name, then what the rule does (the full-page editor says it in the aside) -->
    <template v-if="inspector">
      <p class="editor__meta">{{ original ? `第 ${Number(position) + 1} 条 · 命中 ${hitsOf(original).toLocaleString('en-US')} 次 · ${Number.isNaN(Date.parse(original.edited)) ? '从配置文件读进来的' : `${editedText(original.edited)}改过`}` : `新规则 · 会排在第 ${Number(position) + 1} 条` }}</p>
      <p v-if="!draft.raw" class="editor__say">{{ readingLead }}<template v-for="line in readingMore" :key="line">；{{ line }}</template></p>
    </template>

    <div class="editor__grid">
      <div class="editor__main">
        <section v-if="draft.raw" class="ecard" :class="{ 'ui-card': !inspector }" aria-labelledby="ec-raw">
          <header class="ecard__head ecard__head--raw"><div><h2 id="ec-raw" class="ecard__title">内核规则<UiHelp topic="raw" /></h2><p class="ecard__desc">这条规则放不进上面那些写法（比如回答阶段先记日志再接着匹配），原样保留。这里改的就是 KixDNS 直接读的规则，保存前会校验。</p></div><UiTabs class="ecard__rawmode" :model-value="rawMode" :items="rawModes" label="内核规则的写法" variant="segment" @update:model-value="setRawMode" /></header>
          <div class="ecard__body">
            <RawRuleEditor v-if="rawMode === 'form'" v-model="rawRules" :pipelines="kernelPipelines" :current-pipeline-id="ownPipelineId" :capabilities="runtimeCapabilities" :show-errors="showErrors" />
            <template v-else><JsonEditor v-model="rawText" :error-line="undefined" /><p v-if="rawError" class="ui-field-error" aria-live="polite">{{ rawError }}</p></template>
          </div>
        </section>
        <section v-if="!draft.raw" class="ecard" :class="{ 'ui-card': !inspector }" aria-labelledby="ec-if">
          <header class="ecard__head"><h2 id="ec-if" class="ecard__title">条件</h2></header>
          <div class="ecard__body">
            <CondForm :model-value="condTree" :order="REQUEST_ORDER" :fields="FIELD" :lead="inspector ? ['满足以下', '条件'] : undefined" :empty="original ? '没有条件，所有请求都会用这条规则。' : '还没有条件。不加的话，这条规则对所有请求生效。'" :show-errors="showErrors" @update:model-value="setTree($event as CondTree)" />
          </div>
        </section>

        <section v-if="!draft.raw" class="ecard" :class="{ 'ui-card': !inspector }" aria-labelledby="ec-then">
          <header class="ecard__head"><h2 id="ec-then" class="ecard__title">结果</h2><p v-if="!inspector" class="ecard__desc">命中这条规则的请求怎么处理。</p></header>
          <div class="ecard__body">
            <template v-if="phone">
              <button class="crow" :class="{ 'is-bad': showErrors && outcomeNote.startsWith('这个组') }" type="button" aria-label="修改结果" @click="sheet = 'outcome'">
                <span class="crow__text"><span class="crow__head"><b>{{ outcomeSentence(model, draft.outcome) }}</b></span><span v-if="outcomeNote" class="crow__vals">{{ outcomeNote }}</span></span>
                <ChevronRight class="crow__chev" :size="16" aria-hidden="true" />
              </button>
              <PhoneSheet v-if="sheet === 'outcome'" title="那么" @close="sheet = null">
                <div class="ui-pick" role="radiogroup" aria-label="那么">
                  <label v-for="o in OUTCOMES" :key="o.type" class="ui-pick__opt"><input type="radio" name="outcome-sheet" :checked="draft.outcome.type === o.type" @change="pickOutcome(o.type)"><b>{{ o.title }}</b><small>{{ o.desc }}</small></label>
                </div>
                <OutcomeParams v-if="draft.outcome.type !== 'continue'" :key="draft.outcome.type" v-model="draft.outcome as Outcome" :show-errors="showErrors" label="那么" @edit-group="sheet = null; emit('editGroup', $event)" />
              </PhoneSheet>
            </template>
            <template v-else>
            <div class="tiles" role="radiogroup" aria-labelledby="ec-then">
              <label v-for="o in OUTCOMES" :key="o.type" class="tile" :class="{ 'is-on': draft.outcome.type === o.type, 'is-block': o.type === 'block' }">
                <input class="visually-hidden" type="radio" name="outcome" :checked="draft.outcome.type === o.type" @change="pickOutcome(o.type)">
                <b>{{ o.title }}</b><small class="visually-hidden">{{ o.desc }}</small>
              </label>
            </div>
            <OutcomeParams v-if="draft.outcome.type !== 'continue'" :key="draft.outcome.type" v-model="draft.outcome as Outcome" class="tiles__params" :show-errors="showErrors" label="那么" @edit-group="emit('editGroup', $event)" />
            <p v-else class="oparams__note tiles__params">这条规则不决定结果，请求接着往下走。常和下面的「记录日志」一起用，只记录某些请求。</p>
            </template>
          </div>
        </section>

        <section v-if="!draft.raw && draft.outcome.type === 'upstream'" class="ecard" :class="{ 'ui-card': !inspector, 'is-folded': inspector && !open.after }" aria-labelledby="ec-after">
          <header v-if="inspector" class="ecard__head ecard__head--fold ecard__head--stretch" :class="{ 'is-open': open.after }"><h2 id="ec-after" class="ecard__title"><button class="ecard__fold-btn" type="button" :aria-expanded="open.after" aria-controls="ec-after-body" aria-describedby="ec-after-sum" @click="open.after = !open.after">回答后检查</button></h2><UiHelp topic="after" /><span id="ec-after-sum" class="ecard__sum">{{ afterSummary }}</span><ChevronRight class="ecard__chev" :size="16" aria-hidden="true" /></header>
          <header v-else class="ecard__head"><h2 id="ec-after" class="ecard__title">回答后检查<UiHelp topic="after" /></h2><p class="ecard__desc">回答发出前再检查一次，比如被污染时改问别的组。</p></header>
          <div v-show="!inspector || open.after" id="ec-after-body" class="ecard__body">
            <UiTabs v-model="draft.response.mode" :items="responseModes" label="上游回答后" variant="segment" />
            <div v-if="draft.response.mode === 'inherit'" class="after__inherit">
              <p v-if="upstreamGroup && fallbackSentence(model, upstreamGroup)">「{{ upstreamGroup.name }}」组：{{ fallbackSentence(model, upstreamGroup) }}</p>
              <p v-else-if="upstreamGroup">「{{ upstreamGroup.name }}」组没设备用，上游回什么就返回什么。</p>
              <button v-if="upstreamGroup" class="ui-link" type="button" @click="emit('editGroup', upstreamGroup.id)">在上游组里修改</button>
            </div>
            <div v-else-if="draft.response.mode === 'off'" class="after__inherit"><p>不检查，上游回什么就返回什么{{ upstreamGroup && fallbackSentence(model, upstreamGroup) ? `；「${upstreamGroup.name}」组的备用对这条规则也不生效` : '' }}。</p></div>
            <div v-else class="after__custom">
              <div v-if="!draft.response.conditions.length" class="presets">
                <span class="presets__label">常用</span>
                <button v-for="p in PRESETS" :key="p.label" class="ui-btn ui-btn--secondary ui-btn--sm" type="button" @click="p.apply">{{ p.label }}</button>
              </div>
              <!-- 回答条件用同一种表单，只是不能分组：内核在这里只认一层「全部 / 任一」 / Answer conditions use the same form without groups: the kernel reads a single all / any level here -->
              <CondForm :model-value="{ match: draft.response.match, items: draft.response.conditions }" :order="RESPONSE_ORDER" :fields="RESPONSE_FIELD" :groups="false" :lead="['回答满足以下', '条件时']" empty="" :show-errors="showErrors" @update:model-value="draft.response.match = $event.match; draft.response.conditions = $event.items as ResponseCondition[]" />
              <template v-if="phone">
                <button class="crow" type="button" aria-label="修改满足时怎么做" @click="sheet = 'then'"><span class="crow__text"><span class="crow__head"><i class="crow__join">然后</i><b>{{ remedySentence(model, draft.response.then) }}</b></span><span v-if="draft.response.thenLog" class="crow__vals">同时记一条{{ levelLabel(draft.response.thenLog) }}日志</span></span><ChevronRight class="crow__chev" :size="16" aria-hidden="true" /></button>
                <PhoneSheet v-if="sheet === 'then'" title="满足时" @close="sheet = null">
                  <div class="pfield"><span>怎么做</span><UiSelect :model-value="draft.response.then.type" :options="thenKinds" label="满足时怎么做" @update:model-value="draft.response.then = remedyOf($event)" /></div>
                  <OutcomeParams v-model="draft.response.then" :show-errors="showErrors" label="然后" @edit-group="sheet = null; emit('editGroup', $event)" />
                  <div class="after__log">
                    <label class="ui-checkbox"><input type="checkbox" :checked="Boolean(draft.response.thenLog)" @change="draft.response.thenLog = ($event.target as HTMLInputElement).checked ? 'warn' : null"><i></i>同时记一条日志</label>
                    <UiSelect v-if="draft.response.thenLog" v-model="draft.response.thenLog" class="erow__level" :options="levels" label="回答检查的日志级别" size="sm" />
                  </div>
                </PhoneSheet>
              </template>
              <div v-else class="after__then">
                <span class="after__k">然后</span>
                <UiSelect class="after__kind" :model-value="draft.response.then.type" :options="thenKinds" label="满足时怎么做" @update:model-value="draft.response.then = remedyOf($event)" />
                <OutcomeParams v-model="draft.response.then" class="after__params" :show-errors="showErrors" label="然后" @edit-group="emit('editGroup', $event)" />
              </div>
              <div v-if="!phone" class="after__log">
                <label class="ui-checkbox"><input type="checkbox" :checked="Boolean(draft.response.thenLog)" @change="draft.response.thenLog = ($event.target as HTMLInputElement).checked ? 'warn' : null"><i></i>同时记一条日志</label>
                <UiSelect v-if="draft.response.thenLog" v-model="draft.response.thenLog" class="erow__level" :options="levels" label="回答检查的日志级别" size="sm" />
              </div>
              <template v-if="phone">
                <button class="crow" type="button" aria-label="修改不满足时怎么做" @click="sheet = 'otherwise'"><span class="crow__text"><span class="crow__head"><i class="crow__join">否则</i><b>{{ remedySentence(model, draft.response.otherwise) }}</b></span></span><ChevronRight class="crow__chev" :size="16" aria-hidden="true" /></button>
                <PhoneSheet v-if="sheet === 'otherwise'" title="不满足时" @close="sheet = null">
                  <div class="pfield"><span>怎么做</span><UiSelect :model-value="draft.response.otherwise.type" :options="elseKinds" label="不满足时怎么做" @update:model-value="draft.response.otherwise = remedyOf($event)" /></div>
                  <OutcomeParams v-if="draft.response.otherwise.type !== 'none'" v-model="draft.response.otherwise" :show-errors="showErrors" label="否则" @edit-group="sheet = null; emit('editGroup', $event)" />
                </PhoneSheet>
              </template>
              <div v-else class="after__then">
                <span class="after__k">否则</span>
                <UiSelect class="after__kind" :model-value="draft.response.otherwise.type" :options="elseKinds" label="不满足时怎么做" @update:model-value="draft.response.otherwise = remedyOf($event)" />
                <OutcomeParams v-if="draft.response.otherwise.type !== 'none'" v-model="draft.response.otherwise" class="after__params" :show-errors="showErrors" label="否则" @edit-group="emit('editGroup', $event)" />
              </div>
            </div>
            <p class="ui-notice ui-notice--off after__limit"><Info :size="16" aria-hidden="true" /><span>上游全部超时或连不上时不会走到这一步，KixDNS 直接回 SERVFAIL。</span></p>
          </div>
        </section>

        <section class="ecard" :class="{ 'ui-card': !inspector, 'is-folded': inspector && !open.more }" aria-labelledby="ec-more">
          <header v-if="inspector" class="ecard__head ecard__head--fold"><button class="ecard__fold" type="button" :aria-expanded="open.more" aria-controls="ec-more-body" @click="open.more = !open.more"><h2 id="ec-more" class="ecard__title">更多</h2><span class="ecard__sum">{{ moreSummary }}</span><ChevronRight class="ecard__chev" :size="16" aria-hidden="true" /></button></header>
          <header v-else class="ecard__head"><h2 id="ec-more" class="ecard__title">更多</h2></header>
          <div v-if="phone" class="ecard__body crowlist">
            <div v-if="!draft.raw" class="crow crow--static">
              <span class="crow__text"><span class="crow__head"><b>记录日志</b></span><span class="crow__vals">命中时写一条日志，在「日志」页能看到</span></span>
              <label class="ui-switch"><input v-model="draft.log.enabled" type="checkbox" aria-label="记录日志"><i></i></label>
            </div>
            <label v-if="!draft.raw && draft.log.enabled" class="crow crow--pick">
              <span class="crow__text"><span class="crow__head"><b>日志级别</b></span></span><span class="crow__value">{{ levelLabel(draft.log.level) }}</span><ChevronRight class="crow__chev" :size="16" aria-hidden="true" />
              <select v-model="draft.log.level" class="crow__select" aria-label="日志级别"><option v-for="l in levels" :key="l.value" :value="l.value">{{ l.label }}</option></select>
            </label>
            <button v-if="!draft.raw && draft.outcome.type === 'upstream'" class="crow" type="button" aria-label="修改客户端子网" @click="sheet = 'ecs'">
              <span class="crow__text"><span class="crow__head"><b>客户端子网（ECS）</b></span><span class="crow__vals">{{ ecsRow }}</span></span><ChevronRight class="crow__chev" :size="16" aria-hidden="true" />
            </button>
            <label class="crow crow--pick">
              <span class="crow__text"><span class="crow__head"><b>顺序</b></span></span><span class="crow__value">{{ positions[position]?.label }}</span><ChevronRight class="crow__chev" :size="16" aria-hidden="true" />
              <select :value="String(position)" class="crow__select" aria-label="顺序" @change="position = Number(($event.target as HTMLSelectElement).value)"><option v-for="o in positions" :key="o.value" :value="o.value">{{ o.label }}</option></select>
            </label>
            <button class="crow" type="button" aria-label="修改备注" @click="sheet = 'note'">
              <span class="crow__text"><span class="crow__head"><b>备注</b></span><span class="crow__vals" :class="{ 'is-empty': !draft.note }">{{ draft.note || '只给自己看，还没写' }}</span></span><ChevronRight class="crow__chev" :size="16" aria-hidden="true" />
            </button>
            <PhoneSheet v-if="sheet === 'ecs' && draft.outcome.type === 'upstream'" title="客户端子网（ECS）" @close="sheet = null">
              <p class="oparams__note">告诉上游客户端在哪个网段，让它回就近的地址</p>
              <div class="erow erow--wrap">
                <UiSelect class="erow__ecs" :model-value="ecsChoice" :options="ecsOptions" label="客户端子网" @update:model-value="setEcs" />
                <template v-if="draft.ecs && draft.ecs !== 'inherit' && draft.ecs.mode === 'client'">
                  <label class="ui-input erow__num"><i>IPv4 /</i><input v-model.number="draft.ecs.v4" type="number" min="0" max="32" aria-label="IPv4 前缀长度"></label>
                  <label class="ui-input erow__num"><i>IPv6 /</i><input v-model.number="draft.ecs.v6" type="number" min="0" max="128" aria-label="IPv6 前缀长度"></label>
                </template>
                <label v-else-if="draft.ecs && draft.ecs !== 'inherit' && draft.ecs.mode === 'static'" class="ui-input is-mono erow__subnet"><input v-model="draft.ecs.subnet" aria-label="固定子网" placeholder="203.0.113.0/24"></label>
              </div>
            </PhoneSheet>
            <PhoneSheet v-if="sheet === 'note'" title="备注" @close="sheet = null">
              <label class="pfield"><span>备注 <small>只给自己看</small></span><span class="ui-input"><input v-model="draft.note" aria-label="备注" placeholder="这条规则为什么存在" maxlength="120" autofocus></span></label>
            </PhoneSheet>
          </div>
          <div v-else v-show="!inspector || open.more" id="ec-more-body" class="ecard__body ecard__rows">
            <div v-if="!draft.raw" class="ui-setrow ui-setrow--toggle erow-log">
              <span class="ui-setrow__label"><span>记录日志</span><small>命中时写一条日志，在「日志」页能看到</small></span>
              <div class="ui-setrow__control erow">
                <label class="ui-switch"><input v-model="draft.log.enabled" type="checkbox" aria-label="记录日志"><i></i></label>
                <UiSelect v-if="draft.log.enabled" v-model="draft.log.level" class="erow__level" :options="levels" label="日志级别" size="sm" />
              </div>
            </div>
            <div v-if="!draft.raw && draft.outcome.type === 'upstream'" class="ui-setrow">
              <span class="ui-setrow__label"><span>客户端子网（ECS）<UiHelp topic="ecs" /></span><small>告诉上游客户端在哪个网段，让它回就近的地址</small></span>
              <div class="ui-setrow__control erow erow--wrap">
                <UiSelect class="erow__ecs" :model-value="ecsChoice" :options="ecsOptions" label="客户端子网" @update:model-value="setEcs" />
                <template v-if="draft.ecs && draft.ecs !== 'inherit' && draft.ecs.mode === 'client'">
                  <label class="ui-input erow__num"><i>IPv4 /</i><input v-model.number="draft.ecs.v4" type="number" min="0" max="32" aria-label="IPv4 前缀长度"></label>
                  <label class="ui-input erow__num"><i>IPv6 /</i><input v-model.number="draft.ecs.v6" type="number" min="0" max="128" aria-label="IPv6 前缀长度"></label>
                </template>
                <label v-else-if="draft.ecs && draft.ecs !== 'inherit' && draft.ecs.mode === 'static'" class="ui-input is-mono erow__subnet"><input v-model="draft.ecs.subnet" aria-label="固定子网" placeholder="203.0.113.0/24"></label>
              </div>
            </div>
            <div class="ui-setrow">
              <span class="ui-setrow__label"><span>顺序</span><small>从上往下判断，第一条决定结果的规则生效</small></span>
              <div class="ui-setrow__control"><UiSelect :model-value="String(position)" :options="positions" label="顺序" @update:model-value="position = Number($event)" /></div>
            </div>
            <div class="ui-setrow">
              <span class="ui-setrow__label"><span>备注</span><small>只给自己看</small></span>
              <div class="ui-setrow__control"><label class="ui-input"><input v-model="draft.note" aria-label="备注" placeholder="这条规则为什么存在" maxlength="120"></label></div>
            </div>
          </div>
        </section>
      </div>

      <aside v-if="!inspector" class="editor__aside">
        <section class="ui-card ecard ecard--aside" aria-labelledby="ec-read">
          <header class="ecard__head"><h2 id="ec-read" class="ecard__title">这条规则会</h2></header>
          <div class="ecard__body">
            <!-- 先用一句话说结果，子网和回答后的检查收成一行小字，不再是一张等重的键值表 / One sentence states the outcome first; subnet and post-answer checks fold into one line of small text instead of an equal-weight key-value table -->
            <template v-if="!draft.raw">
              <p class="reading__lead">{{ readingLead }}</p>
              <!-- 补充的几项一项一行：「回答后：…」这种带名字的句子挤在一句里会把名字折断 / One supporting fact per line: named facts such as 回答后：… break their names when run into one sentence -->
              <div v-if="readingMore.length" class="reading__mores"><p v-for="line in readingMore" :key="line" class="reading__more">{{ line }}</p></div>
            </template>
            <dl v-else class="reading"><div v-for="row in reading" :key="row.k"><dt>{{ row.k }}</dt><dd>{{ row.v }}</dd></div></dl>
          </div>
          <details class="ui-expand kjson">
            <summary>生成的内核规则<ChevronDown :size="14" aria-hidden="true" /></summary>
            <pre>{{ kernelJson }}</pre>
          </details>
        </section>
      </aside>
    </div>

    <!-- 手机上删除不放在「取消」旁边，放在内容最后一行 / On phones delete never sits beside 取消; it closes the content instead -->
    <button v-if="original" class="ui-btn ui-btn--text editor__delete-row" type="button" @click="remove"><Trash2 :size="16" aria-hidden="true" />删除这条规则</button>
    <footer class="editor__foot">
      <button v-if="original" class="ui-btn ui-btn--text editor__delete" type="button" @click="remove"><Trash2 :size="16" aria-hidden="true" />删除规则</button>
      <button v-if="showErrors && problems.length" class="editor__problem" type="button" role="alert" @click="revealProblem">还有 {{ problems.length }} 处要改：{{ problems[0] }}</button>
      <span class="editor__spacer"></span>
      <span v-if="!inspector" class="editor__keys" aria-hidden="true">Ctrl+Enter 完成 · Esc 返回</span>
      <button class="ui-btn ui-btn--secondary" type="button" @click="leave">取消</button>
      <button class="ui-btn ui-btn--primary" type="button" @click="done">{{ inspector ? '保存' : original ? '完成' : '添加规则' }}</button>
    </footer>
  </div>
</template>
