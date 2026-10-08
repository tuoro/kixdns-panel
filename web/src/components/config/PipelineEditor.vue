<script setup lang="ts">
import { ArrowDown, ArrowDownToLine, ArrowLeft, ArrowUp, ArrowUpToLine, ChevronDown, ChevronRight, Plus, Trash2, WandSparkles } from '@lucide/vue'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useConfirm } from '../../composables/useConfirm'
import {
  createEcs,
  createPipeline,
  createPipelineSelect,
  createRule,
  applyMatcherMode,
  applyPipelineSelectMode,
  inferMatcherMode,
  inferPipelineSelectMode,
  moveRule,
  pipelineHasActionEcs,
  renamePipeline,
  ruleHasForward,
} from '../../config-editor/model'
import { hasResponseProcessing } from '../../config-editor/rule-draft'
import { ENTRY_ORDER_NOTE, RULE_ORDER_NOTE, collectDnsSolutions, pipelineRole } from '../../config-editor/solution'
import { rulePhrase } from '../../config-editor/phrase'
import type { KixConfig, MatcherConfig, PipelineConfig, PipelineSelectConfig, PipelineSelectMode, RuleConfig } from '../../config-editor/types'
import { analyzeRuleFlow, findBlockingRule } from '../../config-editor/summary'
import ActionList from './ActionList.vue'
import DnsSolutionEditor from './DnsSolutionEditor.vue'
import MatcherList from './MatcherList.vue'
import PhraseText from './PhraseText.vue'
import RuleCreationGuide from './RuleCreationGuide.vue'
import type { RuntimeTarget } from './RuntimeMessage.vue'
import UiMenu, { type UiMenuItem } from '../ui/UiMenu.vue'
import UiSelect from '../ui/UiSelect.vue'
import UiDotText from '../ui/UiDotText.vue'
import { vLineDots } from '../../line-dots'

const confirm = useConfirm()
const config = defineModel<KixConfig>({ required: true })
// focus：从检查器的「在自由编辑里改」或出错信息的链接进来时，要展开、滚到的 Pipeline 和规则（规范 8.4）
// focus: the Pipeline and rule to open and scroll to when arriving from the inspector or an error link (spec 8.4)
const props = withDefaults(defineProps<{ capabilities: string[]; manualOnly?: boolean; focus?: RuntimeTarget | null }>(), { manualOnly: false, focus: null })
const emit = defineEmits<{ notice: [message: string] }>()
const mappingSolutions = computed(() => collectDnsSolutions(config.value)
  .filter((solution) => solution.groupType === 'domain_mapping'))
const mappingSelectorIndexes = computed(() => new Set(mappingSolutions.value
  .flatMap((solution) => solution.selectorIndex === undefined ? [] : [solution.selectorIndex])))
const mappingPipelineIds = computed(() => new Set(mappingSolutions.value
  .flatMap((solution) => solution.pipeline ? [solution.pipeline.id] : [])))
const visibleSelectors = computed(() => config.value.pipeline_select
  .map((selector, index) => ({ selector, index }))
  .filter(({ index }) => !mappingSelectorIndexes.value.has(index)))
const visiblePipelines = computed(() => config.value.pipelines
  .map((pipeline, index) => ({ pipeline, index }))
  .filter(({ pipeline }) => !mappingPipelineIds.value.has(pipeline.id)))
const pipelineIds = computed(() => visiblePipelines.value.map(({ pipeline }) => pipeline.id))
// 改名时记下原来的 ID；在这里的时候标题的说明按原来的 ID 算：引用要到离开字段才跟着改（审计第五轮 C2）
// The ID before a rename; while it is kept here the title's fact is worked out from it, since references follow only on blur (audit round 5, C2)
const previousIds = reactive(new WeakMap<PipelineConfig, string>())
const customSelectors = ref(new Set<PipelineSelectConfig>())
const customMatcherGroups = ref(new Set<MatcherConfig[]>())
const collapsedRules = ref(new Set<RuleConfig>())
const guidedSession = ref<{ pipeline: PipelineConfig; rule?: RuleConfig; ruleIndex?: number }>()
const manualMode = ref(false)

function selectorMode(selector: PipelineSelectConfig): PipelineSelectMode {
  return customSelectors.value.has(selector) ? 'custom' : inferPipelineSelectMode(selector)
}

function setSelectorMode(selector: PipelineSelectConfig, value: string): void {
  const mode = value as PipelineSelectMode
  const nextCustomSelectors = new Set(customSelectors.value)
  if (mode === 'custom') nextCustomSelectors.add(selector)
  else nextCustomSelectors.delete(selector)
  customSelectors.value = nextCustomSelectors
  applyPipelineSelectMode(selector, mode)
}

function matcherMode(matchers: MatcherConfig[], matcherOperator: string): PipelineSelectMode {
  return customMatcherGroups.value.has(matchers) ? 'custom' : inferMatcherMode(matchers, matcherOperator)
}

function setMatcherMode(rule: RuleConfig, stage: 'request' | 'response', value: string): void {
  const matchers = stage === 'request' ? rule.matchers : rule.response_matchers
  const mode = value as PipelineSelectMode
  const nextCustomGroups = new Set(customMatcherGroups.value)
  if (mode === 'custom') nextCustomGroups.add(matchers)
  else nextCustomGroups.delete(matchers)
  customMatcherGroups.value = nextCustomGroups
  const operator = applyMatcherMode(matchers, mode)
  if (stage === 'request') rule.matcher_operator = operator
  else rule.response_matcher_operator = operator
}

// Pipeline 标题后面的说明：先说它怎么被用到，再说规则数。每一段不拆开，只在「 · 」后面换行，不会把「规则」拆成两行
// （审计第五轮 V1）；折行落在「·」后面时点藏起来，手机上读成「fallback-check 未被引用」「1 条规则」
// The fact after a Pipeline's name: how it is used, then the rule count. Each piece stays whole and a line breaks only after
// 「 · 」, never splitting 规则 (audit round 5, V1); a dot a wrap falls right after is hidden, so a phone reads
// 「fallback-check 未被引用」 / 「1 条规则」
function pipelineFacts(pipeline: PipelineConfig): string[] {
  const role = pipelineRole(config.value, previousIds.get(pipeline) ?? pipeline.id, config.value.pipelines[0] === pipeline)
  return [role, `${pipeline.rules.length} 条规则`].filter((fact): fact is string => Boolean(fact))
}

function rememberId(pipeline: PipelineConfig): void {
  previousIds.set(pipeline, pipeline.id)
}

function commitId(pipeline: PipelineConfig): void {
  const previousId = previousIds.get(pipeline) ?? pipeline.id
  const requestedId = pipeline.id
  const result = renamePipeline(config.value, pipeline, previousId)
  previousIds.delete(pipeline)
  if (result.id !== requestedId || result.references > 0) emit('notice', `Pipeline 已更新为 ${result.id}，同步 ${result.references} 处引用`)
}

function setPipelineEcs(pipeline: PipelineConfig, mode: string): void {
  pipeline.ecs = createEcs(mode)
}

function setEcsNumber(pipeline: PipelineConfig, key: string, event: Event): void {
  if (!pipeline.ecs) return
  const raw = (event.currentTarget as HTMLInputElement).value
  if (raw === '') delete pipeline.ecs[key]
  else pipeline.ecs[key] = Number(raw)
}

async function removePipeline(index: number): Promise<void> {
  const pipeline = config.value.pipelines[index]
  if (!pipeline) return
  if (!await confirm.ask({
    title: `删除 Pipeline ${pipeline.id}`,
    body: '这条 Pipeline 和它下面的规则会从草稿里移除。保存配置后才会真正生效，在此之前可以放弃草稿撤回。',
    items: pipeline.rules?.length ? pipeline.rules.map((item, order) => item.name || `规则 ${order + 1}`) : undefined,
    confirmLabel: '删除这条 Pipeline',
    destructive: true,
  })) return
  config.value.pipelines.splice(index, 1)
}

async function removeRule(pipeline: PipelineConfig, index: number): Promise<void> {
  const rule = pipeline.rules[index]
  if (!rule) return
  if (!await confirm.ask({
    title: `删除规则 ${rule.name || index + 1}`,
    body: '这条规则会从草稿里移除，同一 Pipeline 下的其他规则顺次前移。保存配置后才会真正生效。',
    confirmLabel: '删除这条规则',
    destructive: true,
  })) return
  const nextCollapsedRules = new Set(collapsedRules.value)
  nextCollapsedRules.delete(rule)
  collapsedRules.value = nextCollapsedRules
  pipeline.rules.splice(index, 1)
}

function ruleCollapsed(rule: RuleConfig): boolean {
  return collapsedRules.value.has(rule)
}

function setRuleCollapsed(rule: RuleConfig, collapsed: boolean): void {
  const nextCollapsedRules = new Set(collapsedRules.value)
  if (collapsed) nextCollapsedRules.add(rule)
  else nextCollapsedRules.delete(rule)
  collapsedRules.value = nextCollapsedRules
}

function allRulesCollapsed(pipeline: PipelineConfig): boolean {
  return pipeline.rules.length > 0 && pipeline.rules.every((rule) => ruleCollapsed(rule))
}

function toggleAllRules(pipeline: PipelineConfig): void {
  const collapse = !allRulesCollapsed(pipeline)
  const nextCollapsedRules = new Set(collapsedRules.value)
  for (const rule of pipeline.rules) {
    if (collapse) nextCollapsedRules.add(rule)
    else nextCollapsedRules.delete(rule)
  }
  collapsedRules.value = nextCollapsedRules
}

function responseEnabled(rule: RuleConfig): boolean {
  return ruleHasForward(rule)
}

function blockingRuleWarning(pipeline: PipelineConfig, ruleIndex: number): string | undefined {
  const blocker = findBlockingRule(pipeline, ruleIndex)
  if (!blocker) return undefined
  const blockerFlow = analyzeRuleFlow(pipeline.rules[blocker.index]!)
  const outcome = blockerFlow.kind === 'jump' ? '跳走' : '结束'
  return `到不了这条：第 ${blocker.index + 1} 条「${blocker.name}」匹配所有请求，并在那里${outcome}`
}

function openGuidedCreate(pipeline: PipelineConfig): void {
  guidedSession.value = { pipeline }
}

function openGuidedEdit(pipeline: PipelineConfig, rule: RuleConfig, ruleIndex: number): void {
  guidedSession.value = { pipeline, rule, ruleIndex }
}

function saveGuidedRule(rule: RuleConfig, index: number): void {
  const session = guidedSession.value
  if (!session) return
  if (session.rule !== undefined && session.ruleIndex !== undefined) {
    const wasCollapsed = collapsedRules.value.has(session.rule)
    const nextCollapsedRules = new Set(collapsedRules.value)
    nextCollapsedRules.delete(session.rule)
    if (wasCollapsed) nextCollapsedRules.add(rule)
    collapsedRules.value = nextCollapsedRules
    session.pipeline.rules.splice(session.ruleIndex, 1, rule)
    emit('notice', `规则“${rule.name}”已更新`)
  } else {
    session.pipeline.rules.splice(index, 0, rule)
    emit('notice', `规则“${rule.name}”已创建在 ${session.pipeline.id} 的第 ${index + 1} 条`)
  }
  guidedSession.value = undefined
}

const relationOptions = [
  { value: 'all', label: '全部满足' },
  { value: 'any', label: '任一满足' },
  { value: 'custom', label: '自定义组合' },
]
const ecsOptions = [
  { value: '', label: '不隔离' },
  { value: 'clear', label: '清除 ECS' },
  { value: 'from_client_ip', label: '按客户端 IP' },
  { value: 'static', label: '固定子网' },
]
const pipelineOptions = computed(() => [{ value: '', label: '选择 Pipeline', disabled: true }, ...pipelineIds.value.map((id) => ({ value: id, label: id }))])
// 都没命中的请求交给第一个 Pipeline（内核 select_pipeline 的兜底）；Pipeline 怎么被用到由 pipelineRole 说
// Unmatched requests go to the first Pipeline (the kernel's select_pipeline fallback); how a Pipeline is used is pipelineRole's to say
const firstPipeline = computed(() => config.value.pipelines[0]?.id)

function ordinal(index: number): string {
  return String(index + 1).padStart(2, '0')
}

function addSelector(): void {
  config.value.pipeline_select.push(createPipelineSelect())
}

// 入口的「…」：挪位置和删除，按看得见的入口算位置（域名映射那一条不在这里）
// An entry's …: move and delete, positions counted among the visible entries (the mapping entry is not here)
function entryMenu(visibleIndex: number): UiMenuItem[] {
  const first = visibleIndex === 0
  const last = visibleIndex === visibleSelectors.value.length - 1
  return [
    { value: 'first', label: '移到最前', icon: ArrowUpToLine, disabled: first },
    { value: 'up', label: '上移', icon: ArrowUp, disabled: first },
    { value: 'down', label: '下移', icon: ArrowDown, disabled: last },
    { value: 'last', label: '移到最后', icon: ArrowDownToLine, disabled: last },
    { value: 'remove', label: '删除入口', icon: Trash2, danger: true },
  ]
}

function onEntryMenu(visibleIndex: number, value: string): void {
  const entry = visibleSelectors.value[visibleIndex]
  if (!entry) return
  if (value === 'remove') {
    config.value.pipeline_select.splice(entry.index, 1)
    return
  }
  const target = value === 'first' ? 0 : value === 'last' ? visibleSelectors.value.length - 1 : visibleIndex + (value === 'up' ? -1 : 1)
  const targetIndex = visibleSelectors.value[target]?.index
  if (targetIndex === undefined || targetIndex === entry.index) return
  const [selector] = config.value.pipeline_select.splice(entry.index, 1)
  if (selector) config.value.pipeline_select.splice(targetIndex, 0, selector)
}

// 规则的「…」：一键编辑、全套挪动和删除。宽屏上上移下移另外挂在规则头上（悬停出现，规范 2.10），
// 窄屏上只在菜单里，规则名字才有地方。
// A rule's …: guided edit, every move and delete. On wide screens up and down also sit in the rule's header
// (revealed on hover, spec 2.10); on narrow ones they live only here, leaving room for the name.
function ruleMenu(pipeline: PipelineConfig, ruleIndex: number): UiMenuItem[] {
  const first = ruleIndex === 0
  const last = ruleIndex === pipeline.rules.length - 1
  return [
    // 「一键…」用魔杖，不用四角星（四角星读成 AI；规范 5.3，审计第三轮 V4） / 「一键…」 takes the wand, not the sparkle star, which reads as AI (spec 5.3, audit round 3, V4)
    { value: 'guided', label: '一键编辑', icon: WandSparkles },
    { value: 'first', label: '移到最前', icon: ArrowUpToLine, disabled: first },
    { value: 'up', label: '上移', icon: ArrowUp, disabled: first },
    { value: 'down', label: '下移', icon: ArrowDown, disabled: last },
    { value: 'last', label: '移到最后', icon: ArrowDownToLine, disabled: last },
    { value: 'remove', label: '删除规则', icon: Trash2, danger: true },
  ]
}

function onRuleMenu(pipeline: PipelineConfig, rule: RuleConfig, ruleIndex: number, value: string): void {
  if (value === 'guided') openGuidedEdit(pipeline, rule, ruleIndex)
  else if (value === 'first') moveRule(pipeline, ruleIndex, 0)
  else if (value === 'up') moveRule(pipeline, ruleIndex, ruleIndex - 1)
  else if (value === 'down') moveRule(pipeline, ruleIndex, ruleIndex + 1)
  else if (value === 'last') moveRule(pipeline, ruleIndex, pipeline.rules.length - 1)
  else if (value === 'remove') void removeRule(pipeline, ruleIndex)
}

function ruleLabel(rule: RuleConfig, ruleIndex: number): string {
  return rule.name || String(ruleIndex + 1)
}

// 展开着的 Pipeline：按对象记，改名不影响；默认展开第一个
// Open Pipelines, kept by object so a rename does not close one; the first starts open
const openPipelines = ref(new Set<PipelineConfig>(visiblePipelines.value[0] ? [visiblePipelines.value[0].pipeline] : []))
function togglePipeline(pipeline: PipelineConfig): void {
  const next = new Set(openPipelines.value)
  if (next.has(pipeline)) next.delete(pipeline)
  else next.add(pipeline)
  openPipelines.value = next
}

// Pipeline 的「…」：顺序有意义（第一个接住其余请求），所以能上移下移；删除放最后
// A Pipeline's …: order matters (the first catches the rest), so it can move up and down; delete goes last
function pipelineMenu(visibleIndex: number): UiMenuItem[] {
  return [
    { value: 'up', label: '上移', icon: ArrowUp, disabled: visibleIndex === 0 },
    { value: 'down', label: '下移', icon: ArrowDown, disabled: visibleIndex === visiblePipelines.value.length - 1 },
    { value: 'remove', label: '删除 Pipeline', icon: Trash2, danger: true },
  ]
}

function onPipelineMenu(visibleIndex: number, value: string): void {
  const entry = visiblePipelines.value[visibleIndex]
  if (!entry) return
  if (value === 'remove') {
    void removePipeline(entry.index)
    return
  }
  const targetIndex = visiblePipelines.value[visibleIndex + (value === 'up' ? -1 : 1)]?.index
  if (targetIndex === undefined) return
  const [pipeline] = config.value.pipelines.splice(entry.index, 1)
  if (pipeline) config.value.pipelines.splice(targetIndex, 0, pipeline)
}

// 响应处理默认收起，标题行写它的现状（规范 3.4c）
// Response handling starts collapsed, its title line stating what is set (spec 3.4c)
function responseSummary(rule: RuleConfig): string[] {
  const parts = [
    rule.response_matchers.length ? `${rule.response_matchers.length} 个条件` : '',
    rule.response_actions_on_match.length ? `成功时 ${rule.response_actions_on_match.length} 个动作` : '',
    rule.response_actions_on_miss.length ? `失败时 ${rule.response_actions_on_miss.length} 个动作` : '',
  ].filter(Boolean)
  return parts.length ? parts : ['未设置']
}

const root = ref<HTMLElement | null>(null)
async function revealFocus(target: RuntimeTarget | null): Promise<void> {
  if (!target) return
  const pipeline = config.value.pipelines.find((item) => item.id === target.pipeline)
  if (!pipeline) return
  openPipelines.value = new Set([...openPipelines.value, pipeline])
  const rule = target.rule ? pipeline.rules.find((item) => item.name === target.rule) : undefined
  if (rule) setRuleCollapsed(rule, false)
  await nextTick()
  const block = root.value?.querySelector<HTMLElement>(`[data-pipeline="${CSS.escape(pipeline.id)}"]`)
  const ruleBlock = rule ? block?.querySelector<HTMLElement>(`[data-rule="${CSS.escape(rule.name)}"]`) : null
  const element = ruleBlock ?? block
  element?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  element?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true })
}
onMounted(() => void revealFocus(props.focus))
watch(() => props.focus, (target) => void revealFocus(target))
</script>

<template>
  <DnsSolutionEditor v-if="!manualMode && !manualOnly" v-model="config" :capabilities="capabilities" @manual="manualMode = true" @notice="emit('notice', $event)" />

  <!-- 自由编辑：入口和 Pipeline 两段。入口、规则、响应处理全部用同一种子项行；Pipeline 是可折叠的组；
       面板里不再套卡片，组和组之间靠留白（规范 3.2、3.4）。
       The manual editor: entries and Pipelines. Entries, rules and response handling all use the same
       sub-item rows; Pipelines are collapsible groups; no cards inside the panel, groups separated by space
       (spec 3.2, 3.4). -->
  <div v-if="manualMode || manualOnly" ref="root" class="manual">
    <div v-if="!manualOnly" class="manual__back"><button class="ui-btn ui-btn--text ui-btn--sm" type="button" @click="manualMode = false"><ArrowLeft :size="14" aria-hidden="true" />解析编排</button></div>

    <section class="manual-section" aria-labelledby="manual-entries-title">
      <header class="manual-section__head">
        <h3 id="manual-entries-title">入口</h3>
        <button class="ui-btn ui-btn--secondary ui-btn--sm" type="button" @click="addSelector"><Plus :size="14" aria-hidden="true" />添加入口</button>
      </header>
      <p class="manual-section__note">{{ ENTRY_ORDER_NOTE }}</p>
      <ol class="manual-list">
        <li v-for="({ selector, index }, visibleIndex) in visibleSelectors" :key="index" class="manual-entry ui-rows-host">
          <!-- 头一行落在子项的竖线上：「交给」在类型那一列，目标在值那一列，「…」在 × 那一格（审计 V7、V8）
               The header sits on the sub-item columns: 交给 in the type column, the target in the value column, … in the × box (audits V7, V8) -->
          <header class="manual-head manual-entry__head">
            <span class="manual-head__ord">{{ ordinal(visibleIndex) }}</span>
            <span class="manual-head__label">交给</span>
            <UiSelect v-model="selector.pipeline" mono class="manual-entry__target" :options="pipelineOptions" :label="`分流 ${index + 1} 目标 Pipeline`" />
            <UiSelect v-if="selector.matchers.length > 1" :model-value="selectorMode(selector)" class="manual-head__relation" :options="relationOptions" :label="`分流 ${index + 1} 条件关系`" @update:model-value="setSelectorMode(selector, $event)" />
            <UiMenu class="manual-head__menu manual-reveal" size="md" :label="`入口 ${ordinal(visibleIndex)} 操作`" :title="`入口 ${ordinal(visibleIndex)} · 交给 ${selector.pipeline}`" :items="entryMenu(visibleIndex)" @select="onEntryMenu(visibleIndex, $event)" />
          </header>
          <div class="manual-body">
            <MatcherList v-model="selector.matchers" scope="selector" :operator-mode="selector.matchers.length > 1 && selectorMode(selector) === 'custom' ? 'custom' : 'hidden'" />
            <p v-if="selector.matchers.length === 0" class="manual-note">没有条件时匹配所有请求，它后面的入口都到不了。</p>
          </div>
        </li>
      </ol>
      <p v-if="visibleSelectors.length === 0" class="manual-empty">没有入口时，请求都交给 <code>{{ firstPipeline ?? 'default' }}</code>。</p>
    </section>

    <section class="manual-section" aria-labelledby="manual-pipelines-title">
      <header class="manual-section__head">
        <h3 id="manual-pipelines-title">Pipeline</h3>
        <button class="ui-btn ui-btn--secondary ui-btn--sm" type="button" @click="config.pipelines.push(createPipeline(config))"><Plus :size="14" aria-hidden="true" />添加 Pipeline</button>
      </header>
      <p class="manual-section__note">{{ RULE_ORDER_NOTE }}</p>
      <div class="manual-pipelines">
        <section v-for="({ pipeline, index: pipelineIndex }, visibleIndex) in visiblePipelines" :key="pipelineIndex" class="manual-pipeline" :data-pipeline="pipeline.id">
          <header class="manual-pipeline__head">
            <button class="manual-pipeline__toggle" type="button" :aria-expanded="openPipelines.has(pipeline)" :aria-controls="`manual-pipeline-${pipelineIndex}`" @click="togglePipeline(pipeline)">
              <ChevronRight class="manual-pipeline__chev" :size="16" aria-hidden="true" />
              <!-- 名字和说明在同一个行框里，共用一条基线；说明和工作台同一句：先说它怎么被用到，再说规则数（审计第四轮 V1、V7）
                   Name and fact share one line box and baseline; the fact reads as on the workbench, how it is used, then the rule count (audit round 4, V1, V7) -->
              <span class="manual-pipeline__title"><code>{{ pipeline.id || '未命名 Pipeline' }}</code>{{ ' ' }}<span v-line-dots><template v-for="(fact, factIndex) in pipelineFacts(pipeline)" :key="factIndex">{{ factIndex ? ' ' : '' }}<span class="manual-pipeline__fact">{{ fact }}<span v-if="factIndex < pipelineFacts(pipeline).length - 1" data-line-dot>&nbsp;·</span></span></template></span></span>
            </button>
            <UiMenu class="manual-reveal" size="md" :label="`Pipeline ${pipeline.id} 操作`" :title="`Pipeline ${pipeline.id}`" :items="pipelineMenu(visibleIndex)" @select="onPipelineMenu(visibleIndex, $event)" />
          </header>
          <div v-if="openPipelines.has(pipeline)" :id="`manual-pipeline-${pipelineIndex}`" class="manual-pipeline__body ui-rise">
            <div class="manual-fields">
              <label class="manual-field"><span>Pipeline ID</span><span class="ui-input"><input v-model="pipeline.id" class="mono" type="text" :aria-label="`Pipeline ${pipelineIndex + 1} ID`" @focus="rememberId(pipeline)" @blur="commitId(pipeline)"></span></label>
              <div class="manual-field">
                <span>ECS 缓存隔离</span>
                <span class="manual-field__controls">
                  <UiSelect :model-value="pipeline.ecs?.mode ?? ''" :options="ecsOptions" :label="`Pipeline ${pipeline.id} ECS 缓存隔离`" @update:model-value="setPipelineEcs(pipeline, $event)" />
                  <template v-if="pipeline.ecs?.mode === 'from_client_ip'">
                    <label class="ui-input is-num"><input type="number" :value="pipeline.ecs.prefix_v4" min="0" max="32" aria-label="ECS 隔离 IPv4 前缀" placeholder="24" @input="setEcsNumber(pipeline, 'prefix_v4', $event)"><em class="ui-setrow__unit">IPv4</em></label>
                    <label class="ui-input is-num"><input type="number" :value="pipeline.ecs.prefix_v6" min="0" max="128" aria-label="ECS 隔离 IPv6 前缀" placeholder="56" @input="setEcsNumber(pipeline, 'prefix_v6', $event)"><em class="ui-setrow__unit">IPv6</em></label>
                  </template>
                  <template v-if="pipeline.ecs?.mode === 'static'">
                    <label class="ui-input"><input v-model="pipeline.ecs.ip" class="mono" type="text" aria-label="ECS 隔离固定 IP" placeholder="192.0.2.0"></label>
                    <label class="ui-input is-num"><input type="number" :value="pipeline.ecs.prefix" min="0" max="128" aria-label="ECS 隔离固定前缀" placeholder="24" @input="setEcsNumber(pipeline, 'prefix', $event)"><em class="ui-setrow__unit">位</em></label>
                  </template>
                </span>
              </div>
              <p v-if="pipelineHasActionEcs(pipeline) && !pipeline.ecs" class="manual-caution">动作里设置了 ECS，缓存也要按 ECS 隔离，否则不同子网会拿到同一份缓存。</p>
            </div>

            <div class="manual-rules-head">
              <h4>规则</h4>
              <button class="ui-btn ui-btn--text ui-btn--sm" type="button" :disabled="pipeline.rules.length === 0" @click="toggleAllRules(pipeline)">{{ allRulesCollapsed(pipeline) ? '全部展开' : '全部收起' }}</button>
              <button class="ui-btn ui-btn--text ui-btn--sm" type="button" @click="openGuidedCreate(pipeline)"><WandSparkles :size="14" aria-hidden="true" />一键添加</button>
              <button class="ui-btn ui-btn--text ui-btn--sm" type="button" @click="pipeline.rules.push(createRule(pipeline))"><Plus :size="14" aria-hidden="true" />手动添加</button>
            </div>
            <ol class="manual-list manual-rules">
              <li v-for="(rule, ruleIndex) in pipeline.rules" :key="ruleIndex" class="manual-rule ui-rows-host" :class="{ 'is-collapsed': ruleCollapsed(rule) }" :data-rule="rule.name">
                <header class="manual-head">
                  <button class="ui-icon-btn manual-head__toggle" type="button" :aria-expanded="!ruleCollapsed(rule)" :title="`${ruleCollapsed(rule) ? '展开' : '收起'}规则 ${ruleLabel(rule, ruleIndex)}`" :aria-label="`${ruleCollapsed(rule) ? '展开' : '收起'}规则 ${ruleLabel(rule, ruleIndex)}`" @click="setRuleCollapsed(rule, !ruleCollapsed(rule))"><ChevronRight :size="16" aria-hidden="true" /></button>
                  <span class="manual-head__ord">{{ ordinal(ruleIndex) }}</span>
                  <label class="ui-input manual-rule__name"><input v-model="rule.name" class="mono" type="text" :aria-label="`规则 ${ruleIndex + 1} 名称`" placeholder="规则名称"><em class="manual-rule__flow">{{ analyzeRuleFlow(rule).label }}</em></label>
                  <span class="manual-head__tools">
                    <button class="ui-icon-btn is-reveal" :class="{ 'is-edge': ruleIndex === 0 }" type="button" :title="`上移规则 ${ruleLabel(rule, ruleIndex)}`" :aria-label="`上移规则 ${ruleLabel(rule, ruleIndex)}`" @click="moveRule(pipeline, ruleIndex, ruleIndex - 1)"><ArrowUp :size="14" /></button>
                    <button class="ui-icon-btn is-reveal" :class="{ 'is-edge': ruleIndex === pipeline.rules.length - 1 }" type="button" :title="`下移规则 ${ruleLabel(rule, ruleIndex)}`" :aria-label="`下移规则 ${ruleLabel(rule, ruleIndex)}`" @click="moveRule(pipeline, ruleIndex, ruleIndex + 1)"><ArrowDown :size="14" /></button>
                    <UiMenu class="manual-reveal" size="md" :label="`规则 ${ruleLabel(rule, ruleIndex)} 操作`" :title="`规则 ${ruleLabel(rule, ruleIndex)}`" :items="ruleMenu(pipeline, ruleIndex)" @select="onRuleMenu(pipeline, rule, ruleIndex, $event)" />
                  </span>
                </header>
                <!-- 收起时用一句话代替各段；展开时各段自己说，不再重复这一句 / Collapsed, one sentence stands in for the stages; open, the stages speak for themselves -->
                <p v-if="ruleCollapsed(rule)" class="manual-rule__summary"><PhraseText :phrase="rulePhrase(rule)" /></p>
                <p v-if="blockingRuleWarning(pipeline, ruleIndex)" class="manual-caution manual-rule__blocked">{{ blockingRuleWarning(pipeline, ruleIndex) }}</p>
                <div v-if="!ruleCollapsed(rule)" class="manual-body manual-rule__body">
                  <div class="manual-stage">
                    <h5>匹配哪些请求<UiSelect v-if="rule.matchers.length > 1" :model-value="matcherMode(rule.matchers, rule.matcher_operator)" size="sm" class="manual-stage__relation" :options="relationOptions" label="请求条件关系" @update:model-value="setMatcherMode(rule, 'request', $event)" /></h5>
                    <MatcherList v-model="rule.matchers" scope="request" :operator-mode="rule.matchers.length > 1 && matcherMode(rule.matchers, rule.matcher_operator) === 'custom' ? 'custom' : 'hidden'" />
                  </div>
                  <div class="manual-stage">
                    <h5>如何处理请求</h5>
                    <ActionList v-model="rule.actions" :pipelines="config.pipelines" :current-pipeline-id="pipeline.id" :capabilities="capabilities" />
                  </div>
                  <!-- 响应处理只在有转发时才有意义；默认收起，标题行写现状 / Response handling only means something with a forward; collapsed by default, its title stating what is set -->
                  <details v-if="responseEnabled(rule)" class="manual-stage manual-response ui-expand" :open="hasResponseProcessing(rule)">
                    <summary class="manual-response__summary"><span>响应处理<small><UiDotText :parts="responseSummary(rule)" /></small></span><ChevronDown :size="16" aria-hidden="true" /></summary>
                    <div class="manual-response__body">
                      <h6>响应条件<UiSelect v-if="rule.response_matchers.length > 1" :model-value="matcherMode(rule.response_matchers, rule.response_matcher_operator)" size="sm" class="manual-stage__relation" :options="relationOptions" label="响应条件关系" @update:model-value="setMatcherMode(rule, 'response', $event)" /></h6>
                      <MatcherList v-model="rule.response_matchers" scope="response" :operator-mode="rule.response_matchers.length > 1 && matcherMode(rule.response_matchers, rule.response_matcher_operator) === 'custom' ? 'custom' : 'hidden'" />
                      <h6>匹配成功</h6>
                      <ActionList v-model="rule.response_actions_on_match" :pipelines="config.pipelines" :current-pipeline-id="pipeline.id" :capabilities="capabilities" />
                      <h6>匹配失败</h6>
                      <ActionList v-model="rule.response_actions_on_miss" :pipelines="config.pipelines" :current-pipeline-id="pipeline.id" :capabilities="capabilities" />
                    </div>
                  </details>
                </div>
              </li>
            </ol>
            <p v-if="pipeline.rules.length === 0" class="manual-empty">还没有规则</p>
          </div>
        </section>
      </div>
      <p v-if="visiblePipelines.length === 0" class="manual-empty">还没有 Pipeline</p>
    </section>

    <RuleCreationGuide
      v-if="guidedSession"
      :pipeline="guidedSession.pipeline"
      :pipelines="config.pipelines"
      :rule="guidedSession.rule"
      :rule-index="guidedSession.ruleIndex"
      :capabilities="capabilities"
      @cancel="guidedSession = undefined"
      @save="saveGuidedRule"
    />
  </div>
</template>

<style scoped>
/* 自由编辑只用 tokens.css 的变量。段标题 17（区块标题），段下一句注释；入口和规则的头一行是
   「序号 · 名字或目标 · 行尾操作」，下面的子项行缩进到序号之后，竖线和检查器里一样对齐。
   Tokens only. Section titles at 17 (section title role) with one note below; an entry's or rule's header
   is ordinal · name or target · row-end actions, and its sub-item rows indent past the ordinal so the
   column lines match the inspector's. */
/* 四边一样远：上边 24；下边的 24 从最后一行字算起，Pipeline 那一行 44 高的按钮自己在字下面留了一截（规范 6.4，审计第三轮 V3）
   The same inset on every side: 24 above; the 24 below counts from the last line of text, since the 44-tall Pipeline toggle already leaves part of it under its text (spec 6.4, audit round 3, V3) */
.manual { display: grid; gap: var(--s-7); padding: var(--s-5) var(--s-5) calc(var(--s-5) - (var(--h-touch) - 1lh) / 2); }
.manual__back { margin: 0 0 calc(var(--s-5) * -1) calc(var(--s-3) * -1); }
/* 表单不铺满整页：一行子项最宽和 1440 下的检查器差不多，值再短也不会孤零零地躺在一个很长的框里
   The form does not span the page: a row is at most about as wide as the inspector at 1440, so short values never sit alone in a very long box */
.manual-section { display: grid; gap: var(--s-3); min-width: 0; max-width: 52rem; }
.manual-section__head { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); }
.manual-section__head h3 { margin: 0; color: var(--l-ink); font-family: var(--f-display); font-size: var(--t-4); font-weight: var(--w-bold); line-height: var(--lh-tight); }
.manual-section__note { margin: calc(var(--s-2) * -1) 0 0; color: var(--l-ink-3); font-size: var(--t-1); }
.manual-list { display: grid; gap: var(--s-5); margin: 0; padding: 0; list-style: none; }
.manual-head { display: flex; align-items: center; gap: var(--s-2); min-height: var(--h-md); }
/* 入口头一行和它下面的条件共用竖线：序号、类型列宽的「交给」、值那一列的目标、× 那一格的「…」
   An entry's header shares its conditions' columns: ordinal, 交给 as wide as the type column, the target in the value column, … in the × box */
.manual-entry__head { display: grid; grid-template-columns: var(--s-6) var(--w-field) minmax(0, 1fr) auto auto; }
.manual-entry__head:not(:has(.manual-head__relation)) { grid-template-columns: var(--s-6) var(--w-field) minmax(0, 1fr) auto; }
.manual-head__ord { flex: 0 0 var(--s-6); color: var(--l-ink-3); font-family: var(--f-mono); font-size: var(--t-1); font-variant-numeric: tabular-nums; }
.manual-head__label { flex: 0 0 auto; color: var(--l-ink-2); font-size: var(--t-2); }
.manual-entry__target { min-width: 0; }
.manual-head__relation { flex: 0 0 var(--w-field); }
.manual-head__tools { margin-left: auto; }
.manual-head__tools { display: flex; align-items: center; }
/* 子项行缩进到序号之后：序号挂在这段缩进里 / Sub-item rows indent past the ordinal, which hangs in that indent */
.manual-body { display: grid; gap: var(--s-2); margin-top: var(--s-2); padding-left: calc(var(--s-6) + var(--s-2)); }
.manual-note { margin: 0; color: var(--l-ink-3); font-size: var(--t-1); }
.manual-empty { margin: 0; padding: var(--s-4) 0; color: var(--l-ink-2); font-size: var(--t-3); }
.manual-empty code { font-family: var(--f-mono); }
.manual-caution { margin: 0; color: var(--l-ink-2); font-size: var(--t-2); }
/* Pipeline 是可折叠的组：标题是等宽的名字加「1 条规则」，行尾「…」 / A Pipeline is a collapsible group: mono name, rule count, … at the end */
.manual-pipelines { display: grid; gap: var(--s-1); }
.manual-pipeline__head { display: flex; align-items: flex-start; gap: var(--s-2); }
/* 标题一行时按钮 44；折成两行时上下各留同样的一截，箭头和「…」留在名字那一行（审计第五轮 V1）
   One title line makes a 44 button; a two-line title keeps the same room above and below, with the chevron and … on the name line (audit round 5, V1) */
.manual-pipeline__toggle { min-width: 0; min-height: var(--h-touch); flex: 1; display: flex; align-items: flex-start; gap: var(--s-2); margin-left: calc(var(--s-2) * -1); padding: calc((var(--h-touch) - 1lh) / 2) var(--s-2); border: 0; border-radius: var(--r-2); background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.manual-pipeline__head > .manual-reveal { margin-top: calc((var(--h-touch) - var(--h-md)) / 2); }
@media (hover: hover) { .manual-pipeline__toggle:hover { background: var(--l-canvas); } }
/* Pipeline 的名字是这一组的标题：14 · 600，和里面的「规则」「匹配哪些请求」、流程里的名字同一级（规范第 1 节，审计第三轮 V6）
   A Pipeline's name titles its group: 14 · 600, the level of 规则 and 匹配哪些请求 inside it and of the name in 流程 (spec section 1, audit round 3, V6) */
.manual-pipeline__title { min-width: 0; }
.manual-pipeline__toggle code { color: var(--l-ink); font-family: var(--f-mono); font-size: var(--t-3); font-weight: var(--w-bold); }
.manual-pipeline__title > span { margin-inline-start: var(--s-1); color: var(--l-ink-2); font-size: var(--t-2); }
.manual-pipeline__chev { flex: 0 0 auto; margin-block: calc((1lh - var(--size-icon)) / 2); color: var(--l-ink-3); transition: transform var(--m-base) var(--ease-out); }
.manual-pipeline__fact { white-space: nowrap; }
/* 等宽的名字和 13 号的说明各按各的行高对齐会把这一行撑到 23.5：两者只占字那么高，行高由按钮的 1lh 定，一行的按钮还是 44（审计第六轮 C4、V2）
   The mono name and the 13px fact, each keeping its own line height, grew the line to 23.5: both take only their glyph height and the
   button's 1lh sets the line, so a one-line toggle is 44 again (audit round 6, C4, V2) */
.manual-pipeline__title code, .manual-pipeline__title > span { line-height: 1; }
.manual-pipeline__toggle[aria-expanded="true"] .manual-pipeline__chev { transform: rotate(90deg); }
/* 展开的一组下面只留一截，和下一个 Pipeline 的名字隔 36 上下：比收起的两组之间的 34 大一点，比「入口」到「Pipeline」的大段小（规范 6，审计第四轮 V2）
   An open group leaves only a little below it, about 36 from its last line to the next Pipeline's name: a touch more than the 34 between
   closed groups, less than the 入口 → Pipeline section break (spec 6, audit round 4, V2) */
.manual-pipeline__body { display: grid; gap: var(--s-5); padding: var(--s-3) 0 var(--s-3) calc(var(--s-6) + var(--s-2)); }
/* 最后一个 Pipeline 展开时，下边只留和收起时一样的一截：面板底边照样离最后一行字 24 / The last Pipeline, open, keeps only what the closed toggle leaves, so the panel's bottom stays 24 below the last line */
.manual-pipeline:last-child > .manual-pipeline__body { padding-bottom: calc((var(--h-touch) - 1lh) / 2); }
.manual-fields { display: grid; gap: var(--s-2); }
.manual-field { display: grid; grid-template-columns: var(--w-field) minmax(0, 1fr); align-items: center; gap: var(--s-2); }
.manual-field > span:first-child { color: var(--l-ink-2); font-size: var(--t-2); }
.manual-field > .ui-input { max-width: 20rem; }
.manual-field__controls { display: flex; flex-wrap: wrap; gap: var(--s-2); }
.manual-field__controls > .ui-select { flex: 0 0 11rem; }
/* 下拉框的根元素也是 .ui-input：不让它吃到输入框的规则，它按自己的 11rem、手机上撑满（审计第六轮 V1）
   A select's root is a .ui-input too: it stays out of the input rule and keeps its own 11rem, spanning the column on a phone (audit round 6, V1) */
.manual-field__controls > .ui-input:not(.is-num, .ui-select) { flex: 0 1 12rem; }
.manual-field__controls > .ui-input.is-num { flex: 0 0 var(--w-num); }
.manual-fields > .manual-caution { padding-left: calc(var(--w-field) + var(--s-2)); }
/* 「规则」离自己的列表近、离上面的字段远：上 32，下 12（规范 6.3，审计 V22） / 规则 sits nearer its own list than the fields above: 32 above, 12 below (spec 6.3, audit V22) */
.manual-rules-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-1); margin: var(--s-2) 0 calc(var(--s-3) - var(--s-5)); }
/* 标题不让出宽度，按钮放不下就整体换到下一行 / The title never gives up its width; the buttons wrap below when they do not fit */
.manual-rules-head h4 { flex: 1 0 auto; margin: 0; color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-bold); }
/* 一条规则：收起按钮挂在序号左边；名字一格；上移下移悬停出现，其余进「…」 / A rule: the collapse toggle hangs left of the ordinal; up and down on hover, the rest in … */
.manual-rule { position: relative; }
/* 规则的折叠箭头和 Pipeline 的箭头在同一条竖线上：按钮挂在规则左边的缩进里，再往外让出半个按钮减半个图标（审计第二轮 V3）
   A rule's chevron shares the Pipeline chevron's line: the button hangs in the rule's indent, pulled out by half the button less half the icon (audit round 2, V3) */
.manual-rule .manual-head__toggle { position: absolute; top: 0; left: calc((var(--s-6) + var(--s-2)) * -1 - (var(--h-md) - var(--size-icon)) / 2); }
/* 规则的箭头和 Pipeline 的箭头画法一样：16、最浅的墨色，指到时变深（规范 5.1，审计第三轮 V5） / A rule's chevron is drawn like the Pipeline's: 16 in the lightest ink, darker on hover (spec 5.1, audit round 3, V5) */
.manual-rule .manual-head__toggle { color: var(--l-ink-3); }
@media (hover: hover) { .manual-rule .manual-head__toggle:hover { color: var(--l-ink); } }
.manual-head__toggle > svg { transition: transform var(--m-base) var(--ease-out); }
.manual-head__toggle[aria-expanded="true"] > svg { transform: rotate(90deg); }
.manual-rule__name { flex: 0 1 22rem; }
.manual-rule__summary { margin: var(--s-1) 0 0; padding-left: calc(var(--s-6) + var(--s-2)); color: var(--l-ink-2); font-size: var(--t-2); overflow-wrap: anywhere; }
.manual-rule__name input { font-family: var(--f-mono); }
/* 规则怎么收尾（在此终止、继续后续规则、跳转流程）写在名字框右端，像单位一样 / How the rule ends sits at the right end of the name box, like a unit */
.manual-rule__flow { flex: 0 0 auto; color: var(--l-ink-3); font-size: var(--t-1); font-style: normal; white-space: nowrap; }
.manual-rule__blocked { margin-top: var(--s-1); padding-left: calc(var(--s-6) + var(--s-2)); }
.manual-rule__body { gap: var(--s-4); margin-top: var(--s-3); }
.manual-stage { display: grid; gap: var(--s-2); min-width: 0; }
/* 「匹配哪些请求」「如何处理请求」「响应处理」是组标题（14 · 600 · ink），和检查器一样；里面的「响应条件」「匹配成功」是次一级（13 · 600 · ink-2）（规范第 1 节，审计第二轮 V8）
   匹配哪些请求, 如何处理请求 and 响应处理 are group titles (14 · 600 · ink) as in the inspector; 响应条件 and 匹配成功 inside are the level below (13 · 600 · ink-2) (spec section 1, audit round 2, V8) */
.manual-stage h5 { margin: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--s-2); min-height: var(--h-sm); color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-bold); }
.manual-stage__relation { width: var(--w-field); }
.manual-response__summary { min-height: var(--h-sm); display: flex; align-items: center; justify-content: space-between; gap: var(--s-2); list-style: none; cursor: pointer; }
.manual-response__summary::-webkit-details-marker { display: none; }
/* 收起的 details 在 Chromium 里还给藏着的内容排一格，网格的 8 会加在摘要下面；收起时不要这 8。
   响应处理收尾一条规则时，摘要那一行多出来的高度也收回来，和「添加动作」收尾时一样只算字（审计第五轮 V2）
   A closed details still lays out its hidden slot in Chromium, adding the grid's 8 under the summary; a closed one drops it.
   When 响应处理 ends a rule, the summary row's spare height is taken back too, so only its text counts, as when 添加动作 ends it (audit round 5, V2) */
.manual-response:not([open]) { row-gap: 0; }
.manual-rule__body > .manual-response:last-child:not([open]) { margin-bottom: calc((1lh - var(--h-sm)) / 2); }
.manual-response__summary > span { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--s-2); color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-bold); }
.manual-response__summary small { color: var(--l-ink-2); font-size: var(--t-2); font-weight: var(--w-normal); }
/* 折叠箭头居中在 × 那一格里（审计 V8） / The chevron centres in the × box (audit V8) */
.manual-response__summary > svg { flex: 0 0 auto; margin-inline: calc((var(--rows-act) - var(--size-icon)) / 2); color: var(--l-ink-3); transition: transform var(--m-base) var(--ease-out); }
.manual-response[open] > .manual-response__summary > svg { transform: rotate(180deg); }
.manual-response__body { display: grid; gap: var(--s-2); padding-top: var(--s-2); }
.manual-response__body h6 { margin: var(--s-2) 0 0; display: flex; align-items: center; justify-content: space-between; gap: var(--s-2); min-height: var(--h-sm); color: var(--l-ink-2); font-size: var(--t-2); font-weight: var(--w-bold); }
/* 能悬停的设备上，上移下移和「…」指到那一行才出现；触屏上一直在（规范 2.10，审计 V10）
   On hover devices, move up/down and … appear on the row under the pointer; always shown on touch (spec 2.10, audit V10) */
@media (hover: hover) {
  .manual-head__tools .is-reveal, .manual-reveal { opacity: 0; transition: opacity var(--m-quick) var(--ease-out); }
  .manual-rule:is(:hover, :focus-within) .manual-head__tools .is-reveal,
  :is(.manual-entry, .manual-pipeline__head, .manual-rule .manual-head):is(:hover, :focus-within) .manual-reveal,
  .manual-reveal:has([aria-expanded="true"]) { opacity: 1; }
}
.manual-head__tools .is-edge { visibility: hidden; }
@media (max-width: 860px) {
  /* 「入口」和「Pipeline」两大段之间仍是最大的一级：窄屏也用 48，比展开的 Pipeline 和下一个之间的 36 上下大（审计第四轮 V2）
     The 入口 / Pipeline section break stays the largest step: 48 on narrow screens too, more than the ~36 after an open Pipeline (audit round 4, V2) */
  .manual { padding: var(--s-4) var(--s-4) calc(var(--s-4) - (var(--h-touch) - 1lh) / 2); gap: var(--s-7); }
  /* 窄屏上上移下移只在菜单里 / On narrow screens up and down live in the menu */
  .manual-head__tools .is-reveal { display: none; }
}
/* 手机：收起按钮放进这一行，序号、名字、「…」跟着；Pipeline 和规则的内容从面板边开始，规则之间 24。
   名字框里是 16 号字，放不下「在此终止」；规则到不到得了，后面的规则会另外写明（manual-rule__blocked）。
   On a phone the collapse toggle joins the row, followed by the ordinal, name and …; Pipeline and rule content start at
   the panel edge with 24 between rules. The name box uses 16px type and cannot hold the flow note; unreachable rules
   are flagged on the rules after it (manual-rule__blocked). */
@media (max-width: 640px) {
  .manual-pipeline__body { padding-left: 0; }
  .manual-body, .manual-rule__summary, .manual-rule__blocked { padding-left: 0; }
  /* 「交给」那一行和下面的条件组隔 16，比条件组里面的 12 大一级：它不会读成第一个条件的一部分（规范 6.2，审计第三轮 V9）
     The 交给 line sits 16 above the condition group, a step more than the 12 inside it, so it never reads as part of the first condition (spec 6.2, audit round 3, V9) */
  .manual-entry > .manual-body { margin-top: var(--s-4); }
  .manual-entry__head, .manual-entry__head:not(:has(.manual-head__relation)) { grid-template-columns: var(--s-6) auto minmax(0, 1fr) auto; }
  .manual-entry__head .manual-head__relation { grid-column: 2 / -2; grid-row: 2; }
  /* 按钮往回收半个按钮减半个图标：箭头落在面板内容的左边线上，和 Pipeline 的箭头对齐（审计第二轮 V3）
     The button pulls back by half itself less half the icon, so the chevron lands on the content edge under the Pipeline's (audit round 2, V3) */
  .manual-rule .manual-head__toggle { position: relative; margin-inline-start: calc((var(--size-icon) - var(--h-md)) / 2); }
  .manual-rule .manual-head { flex-wrap: nowrap; }
  /* 框里的字比旁边 12 号的序号、13 号的「交给」大，按基线对齐，不按中线：居中会让它们比框里的字高（审计第七轮 V1）；
     按钮（收起、「…」）仍然上下居中
     The field text is larger than the 12px ordinal and 13px 交给 beside it, so they align on its baseline rather than its centre, which
     sat them higher (audit round 7, V1); the buttons (collapse, …) stay centred */
  .manual-entry__head, .manual-rule .manual-head { align-items: baseline; }
  :is(.manual-entry__head, .manual-rule .manual-head) > :is(.manual-head__toggle, .manual-head__tools, .manual-reveal, .ui-menu-host) { align-self: center; }
  .manual-rule__name { flex: 1 1 8rem; }
  .manual-rule .manual-head__tools { flex: 0 0 auto; }
  /* 「规则」单独一行，三个命令在它下面一行，第一个往回收一格 / 规则 on its own line, the three commands below it, the first pulled back */
  .manual-rules-head h4 { flex-basis: 100%; }
  .manual-rules-head .ui-btn:first-of-type { margin-inline-start: calc(var(--s-3) * -1); }
  /* Pipeline 自己的字段也让出 × 那一列，和规则里的字段在同一条右边线结束；字段之间 12、字段名到框 8（规范 6.3，审计第二轮 V5）
     The Pipeline's own fields leave the × column free too, ending on the rule fields' right edge; 12 between fields, 8 from a label to its box (spec 6.3, audit round 2, V5) */
  .manual-fields { gap: var(--s-3); margin-inline-end: calc(var(--h-md) + var(--s-2)); }
  /* 字段名到自己的框 4，字段和字段之间 12：和子项里上下排的字段一样（审计第三轮 M1、第四轮 V4） / 4 from a label to its box, 12 between fields, as in stacked sub-items (audit round 3 M1, round 4 V4) */
  .manual-field { grid-template-columns: minmax(0, 1fr); gap: var(--s-1); }
  .manual-field > .ui-input { max-width: none; }
  .manual-fields > .manual-caution { padding-left: 0; }
  .manual-rule__flow { display: none; }
  /* 响应处理那一行点了会展开，手机上也是 44；多出来的高度照样在收尾时收回（审计第五轮 V3）
     Tapping 响应处理 opens it, so on a phone it is 44 too; the spare height is still taken back when it ends a rule (audit round 5, V3) */
  .manual-response__summary { min-height: var(--h-touch); }
  /* 「添加动作」的 44 格子伸到字下面 11.95（按钮行高 1.15，少收 2），两段之间是 16，剩下 4 的空：往上收掉，两个 44 格子正好挨着（审计第七轮 V3）
     添加动作's 44 cell reaches 11.95 under its text (a 1.15 button line, pulled back 2 less) and the stages are 16 apart, leaving 4 of
     slack: the row comes up by that much so the two 44 cells meet edge to edge (audit round 7, V3) */
  .manual-rule__body > .manual-response { margin-top: calc((var(--h-touch) - var(--t-3) * var(--lh-tight)) / 2 - 2px - var(--s-4)); }
  .manual-rule__body > .manual-response:last-child:not([open]) { margin-bottom: calc((1lh - var(--h-touch)) / 2); }
  /* 下拉框和上面的 Pipeline ID 一样宽，字段结束在同一条右边线上（审计第五轮 V4） / The select is as wide as Pipeline ID above, ending on the same right edge (audit round 5, V4) */
  .manual-field__controls > .ui-select { flex: 1 1 100%; }
  /* 44 高的「添加 Pipeline」比标题那一行低，说明离按钮的下边至少 8（审计第五轮 V5） / The 44 添加 Pipeline hangs below the heading line, so the note keeps at least 8 below the button (audit round 5, V5) */
  .manual-section__note { margin-top: calc(var(--s-2) - var(--s-3)); }
}
@media (prefers-reduced-motion: reduce) {
  .manual-pipeline__chev, .manual-head__toggle > svg, .manual-response__summary > svg { transition: none; }
}
</style>
