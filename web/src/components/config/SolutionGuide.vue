<script setup lang="ts">
import { ChevronDown } from '@lucide/vue'
import { computed, nextTick, ref, useId, watch } from 'vue'
import {
  SOLUTION_TEMPLATES,
  cloneSolutionDraft,
  createDraftFromSolution,
  createSolutionDrafts,
  entryNumberAt,
  entryPosition,
  selectorMatchesEveryRequest,
  solutionIdentityErrors,
  solutionInsertIndex,
  solutionTemplateDescription,
  solutionValidationErrors,
  type DnsSolution,
  type SolutionDraft,
  type SolutionPipelineMode,
  type SolutionTemplateId,
} from '../../config-editor/solution'
import { applyMatcherMode, createAction, createMatcher, inferMatcherMode, nextPipelineId } from '../../config-editor/model'
import { hasResponseProcessing, responseValidationErrors, withResponseState } from '../../config-editor/rule-draft'
import { ignoredActionsAfterTerminal } from '../../config-editor/guided-rule'
import { CONFIG_STATIC_CNAME_RESPONSE_V1 } from '../../config-editor/schema'
import { summarizeMatchers } from '../../config-editor/summary'
import type { KixConfig, PipelineSelectMode } from '../../config-editor/types'
import { useConfirm } from '../../composables/useConfirm'
import UiSelect from '../ui/UiSelect.vue'
import ActionList from './ActionList.vue'
import ConfigGuideLayout from './ConfigGuideLayout.vue'
import DomainMappingTable from './DomainMappingTable.vue'
import MatcherList from './MatcherList.vue'

// 检查器里的入口编辑（规范 3.4–3.6）：添加时先选起点，选完收成一行；编辑时直接是四组——
// 匹配哪些请求、流程设置、如何处理请求、响应处理。底栏只在有没应用的修改时出现；按「应用到草稿」时
// 表单没填完，就把缺的字段标出来并聚焦第一个，而不是让按钮一直灰着。
// The inspector's entry editor (spec 3.4–3.6): adding starts with a starting point that folds into
// one line once chosen; editing shows four groups. The footer appears only with unapplied changes;
// submitting an incomplete form marks and focuses the missing fields instead of a greyed button.
// start：从工作台上直接点了哪个起点（窄屏首次安装时起点就列在列表里），打开时已经选好 / start: a starting point chosen on the workbench itself (narrow first install lists them there), already picked on open
// canReveal：列表就在旁边（桌面），错误里提到的入口可以点过去 / canReveal: the list sits alongside (desktop), so an entry named in an error can be jumped to
// pageSaves：页面的保存栏就在下面、保存时会带上这里的修改。这时「应用到草稿」退成次要按钮，一屏只有「保存并热加载」一个主按钮（规范第 11 节）
// pageSaves: the page's save bar sits below and a save takes these edits along. 应用到草稿 then steps down to a secondary button,
// leaving 保存并热加载 the one primary on screen (spec section 11)
const props = withDefaults(defineProps<{ config: KixConfig; capabilities: string[]; solution?: DnsSolution; embedded?: boolean; entryLabel?: string; closable?: boolean; start?: SolutionTemplateId; canReveal?: boolean; pageSaves?: boolean }>(), { embedded: true, entryLabel: undefined, closable: true, start: undefined, canReveal: false, pageSaves: false })
const emit = defineEmits<{ cancel: []; save: [drafts: SolutionDraft[]]; dirty: [value: boolean]; reveal: [selectorIndex: number] }>()
const id = useId()
const confirm = useConfirm()

const editing = computed(() => props.solution !== undefined)
const initial = props.solution ? createDraftFromSolution(props.solution, props.config) : undefined
const drafts = ref<SolutionDraft[]>(initial ? [initial] : [])
const selectedTemplate = ref<SolutionTemplateId | null>(props.solution?.groupType ?? null)
const picking = ref(!editing.value)
const activeIndex = ref(0)
const draft = computed<SolutionDraft | undefined>(() => drafts.value[activeIndex.value])
const mappingMode = computed(() => draft.value?.groupType === 'domain_mapping')
const selectorMode = ref<PipelineSelectMode>('all')
const responseMode = ref<PipelineSelectMode>('all')
const responseStates = ref(drafts.value.map((item) => hasResponseProcessing(item.rule)))
const responseEnabled = computed({
  get: () => responseStates.value[activeIndex.value] ?? false,
  set: (enabled: boolean) => { responseStates.value[activeIndex.value] = enabled },
})
const effectiveDrafts = computed(() => drafts.value.map((item, index) => ({
  ...item, rule: withResponseState(item.rule, responseStates.value[index] ?? false),
})))
const initialDraftSource = JSON.stringify(effectiveDrafts.value)
let templateSource = initialDraftSource
const draftChanged = computed(() => JSON.stringify(effectiveDrafts.value) !== initialDraftSource)
watch(draftChanged, (value) => emit('dirty', value), { immediate: true, flush: 'sync' })
const templates = computed(() => SOLUTION_TEMPLATES.filter((template) => (
  template.id !== 'domain_mapping'
  && (!template.requiresCapability || props.capabilities.includes(template.requiresCapability))
)).map((template) => ({ ...template, description: solutionTemplateDescription(props.config, template) })))
const templateName = computed(() => SOLUTION_TEMPLATES.find((template) => template.id === selectedTemplate.value)?.name ?? '')
const showErrors = ref(false)
const body = ref<HTMLElement | null>(null)

function syncModes(): void {
  if (!draft.value) return
  selectorMode.value = inferMatcherMode(draft.value.selector.matchers, draft.value.selector.matcher_operator)
  responseMode.value = inferMatcherMode(draft.value.rule.response_matchers, draft.value.rule.response_matcher_operator)
}
syncModes()

const pipelines = computed(() => {
  const result = props.config.pipelines.map((pipeline) => ({ ...pipeline }))
  for (const item of effectiveDrafts.value) {
    if (item.pipelineMode === 'reuse') continue
    const index = result.findIndex((pipeline) => pipeline.id === item.pipeline.id)
    if (index >= 0) result[index] = item.pipeline
    else result.push(item.pipeline)
  }
  return result
})
const errorsByDraft = computed(() => effectiveDrafts.value.map((item, index) => {
  const others = effectiveDrafts.value.filter((candidate, candidateIndex) => candidateIndex !== index && candidate.pipelineMode !== 'reuse').map((candidate) => candidate.pipeline.id)
  const errors = solutionValidationErrors(item, props.config, props.solution?.selectorIndex, others)
  if (selectorMatchesEveryRequest(item.selector) && laterCatchAllPart(index) >= 0) errors.push('已经存在任意请求兜底方案')
  if (item.pipelineMode !== 'reuse') {
    errors.push(...responseValidationErrors(item.rule, responseStates.value[index] ?? false))
    if ([...item.rule.actions, ...item.rule.response_actions_on_match, ...item.rule.response_actions_on_miss]
      .some((action) => action.type === 'static_cname_response') && !props.capabilities.includes(CONFIG_STATIC_CNAME_RESPONSE_V1)) {
      errors.push('当前 KixDNS 不支持固定 CNAME，请先更新或切换内核')
    }
  }
  return [...new Set(errors)]
}))
const allErrors = computed(() => errorsByDraft.value.flat())
const identityErrors = computed(() => draft.value ? solutionIdentityErrors(draft.value, props.config,
  drafts.value.filter((item, index) => index !== activeIndex.value && item.pipelineMode !== 'reuse').map((item) => item.pipeline.id)) : {})
const valid = computed(() => allErrors.value.length === 0)
const canUseResponse = computed(() => draft.value?.rule.actions.some((action) => action.type === 'forward') ?? false)
const sharedEdit = computed(() => editing.value && (props.solution?.referenceCount ?? 0) > 1)
const actionWarning = computed(() => draft.value ? ignoredActionsAfterTerminal(draft.value.rule.actions) : 0)
const responseSummary = computed(() => {
  if (!draft.value || !responseEnabled.value) return '未设置'
  const count = draft.value.rule.response_matchers.length
  return count ? `${count} 个条件` : '已启用'
})
// 已经有一个接住所有请求的入口，这一段又没有条件：它永远轮不到。错误写在「匹配哪些请求」下面，不只在底栏（审计 B2）。
// 编辑时不算它自己：把别的入口的条件删光也会撞上（审计第三轮）
// An entry already catches every request and this part has no condition, so it would never be reached. The error sits
// under 匹配哪些请求, not only in the footer (audit B2). When editing, the entry itself does not count: clearing another
// entry's conditions hits the same conflict (audit round 3)
const catchAllIndex = computed(() => props.config.pipeline_select.findIndex((selector, index) => index !== props.solution?.selectorIndex && selectorMatchesEveryRequest(selector)))
const catchAllNumber = computed(() => (catchAllIndex.value < 0 ? undefined : entryNumberAt(props.config, catchAllIndex.value)))
// 错误里用和放置那句一样的叫法：「入口 04「任意请求」」（审计第二轮 B3） / The error names the entry as the placement line does (audit round 2, B3)
const catchAllSummary = computed(() => {
  const selector = props.config.pipeline_select[catchAllIndex.value]
  return selector ? summarizeMatchers(selector.matchers, selector.matcher_operator, 'selector') : ''
})
// 同一个起点里后面还有一段也没有条件：两段都接住所有请求，后面那段永远轮不到；错误写在前面这一段（审计第四轮 C2）
// A later part of the same start has no condition either: both would catch every request and the later part would never be reached; the error goes on this earlier part (audit round 4, C2)
function laterCatchAllPart(index: number): number {
  return effectiveDrafts.value.findIndex((item, other) => other > index && selectorMatchesEveryRequest(item.selector))
}
const siblingCatchAll = computed(() => (draft.value && selectorMatchesEveryRequest(draft.value.selector) ? laterCatchAllPart(activeIndex.value) : -1))
const catchAllConflict = computed(() => Boolean(draft.value && selectorMatchesEveryRequest(draft.value.selector)) && (catchAllNumber.value !== undefined || siblingCatchAll.value >= 0))
const partLabel = (index: number): string => (index === 0 ? '国内解析' : '全局兜底')
// 规则位置是界面上看不出来的事实，保留成一句注释（规范 4.4）。编号和工作台列表一样，不算域名映射（审计 B1）。
// 这个起点的每一段都先放进去再数：国内解析和全局兜底一起建时，兜底在最后，两段说的位置都是真的（审计第三轮 B1）。
// Placement is a fact the UI can't show; kept as one note (spec 4.4). Numbered as the workbench list numbers entries, mappings excluded (audit B1).
// Every part of the start is inserted before counting: when 国内解析 and 全局兜底 are added together the fallback goes last, and
// both parts state a true position (audit round 3, B1).
const placement = computed(() => {
  if (editing.value || !draft.value || catchAllConflict.value) return ''
  const pendingConfig = { ...props.config, pipeline_select: [...props.config.pipeline_select] }
  for (const item of effectiveDrafts.value) {
    pendingConfig.pipeline_select.splice(solutionInsertIndex(pendingConfig, item.selector), 0, item.selector)
  }
  const { number, next, total } = entryPosition(pendingConfig, pendingConfig.pipeline_select.indexOf(draft.value.selector))
  const label = String(number).padStart(2, '0')
  // 列表里只有它时不说「放在最后」；紧跟着的是同一个起点的另一段时，那一段自己会说它在哪
  // Alone in the list it is not 「放在最后」; when the next entry is another part of this start, that part states its own place
  if (!next) return total > 1 ? `放在最后，成为入口 ${label}` : `成为入口 ${label}`
  if (drafts.value.some((item) => item.selector === next)) return `成为入口 ${label}`
  const before = `成为入口 ${label}，排在「${summarizeMatchers(next.matchers, next.matcher_operator, 'selector')}」前面`
  // 分流模板沿用已有的兜底入口，就在同一句里说（审计第二轮 B2、第三轮 B8） / When the split start reuses the existing catch-all, the same sentence says so (audit round 2, B2; round 3, B8)
  return selectedTemplate.value === 'domestic_global' && drafts.value.length === 1 && selectorMatchesEveryRequest(next) ? `${before}，由它继续兜底` : before
})
// 没有字段可标的错误写在它所在的那一组下面：底栏只留「还差 N 项」，不再列一串红字（审计 B2）
// Errors with no field to mark sit under their group; the footer keeps only 还差 N 项, no red list (audit B2)
const groupErrors = computed(() => {
  const errors = errorsByDraft.value[activeIndex.value] ?? []
  const pick = (...messages: string[]): string[] => errors.filter((error) => messages.some((message) => error.startsWith(message)))
  return {
    mapping: pick('至少要一条域名映射', '源域名不能重复'),
    actions: pick('至少要一个动作', '当前 KixDNS 不支持固定 CNAME'),
    response: pick('响应处理需要先添加转发动作', '匹配成功或匹配失败至少要一个动作'),
  }
})
// 两个折叠组：添加时都收着，标题上已经写了现在的状态（规范 3.4c，审计 B7、B13）；出错时打开，改好了也不会在手里收回去
// Both folding groups start closed when adding, their titles already state what is set (spec 3.4c, audits B7, B13);
// they open on an error and never fold back while being fixed
const flowOpen = ref(sharedEdit.value)
const responseOpen = ref(false)
watch([showErrors, identityErrors], () => {
  if (showErrors.value && (identityErrors.value.pipeline || identityErrors.value.name)) flowOpen.value = true
}, { deep: true })
watch([showErrors, () => groupErrors.value.response.length], () => {
  if (showErrors.value && groupErrors.value.response.length) responseOpen.value = true
})
function openOf(event: Event): boolean {
  return (event.currentTarget as HTMLDetailsElement).open
}
const showFooter = computed(() => !picking.value && drafts.value.length > 0 && (!editing.value || draftChanged.value || showErrors.value))

async function pickTemplate(templateId: SolutionTemplateId): Promise<void> {
  if (templateId === selectedTemplate.value && drafts.value.length) {
    picking.value = false
    return
  }
  // 已经填了东西再换起点，先问一声（规范 3.6） / Changing the start after filling fields asks first (spec 3.6)
  if (drafts.value.length && JSON.stringify(effectiveDrafts.value) !== templateSource) {
    const name = SOLUTION_TEMPLATES.find((template) => template.id === templateId)?.name ?? ''
    const ok = await confirm.ask({ title: `换成「${name}」？`, body: '已经填的条件和动作会被清掉，换成这个起点的默认内容。', confirmLabel: `换成「${name}」`, cancelLabel: '留在当前' })
    if (!ok) return
  }
  selectedTemplate.value = templateId
  drafts.value = createSolutionDrafts(props.config, templateId)
  responseStates.value = drafts.value.map((item) => hasResponseProcessing(item.rule))
  activeIndex.value = 0
  showErrors.value = false
  templateSource = JSON.stringify(effectiveDrafts.value)
  picking.value = false
  syncModes()
}

function selectDraft(index: number): void {
  activeIndex.value = index
  syncModes()
}

function setMode(stage: 'selector' | 'response', mode: string): void {
  if (!draft.value) return
  if (stage === 'selector') {
    selectorMode.value = mode as PipelineSelectMode
    draft.value.selector.matcher_operator = applyMatcherMode(draft.value.selector.matchers, mode as PipelineSelectMode)
  } else {
    responseMode.value = mode as PipelineSelectMode
    draft.value.rule.response_matcher_operator = applyMatcherMode(draft.value.rule.response_matchers, mode as PipelineSelectMode)
  }
}

function toggleResponse(event: Event): void {
  if (!draft.value) return
  responseEnabled.value = (event.currentTarget as HTMLInputElement).checked
  if (!responseEnabled.value || hasResponseProcessing(draft.value.rule)) return
  draft.value.rule.response_matchers.push(createMatcher('response'))
  draft.value.rule.response_actions_on_match.push(createAction('log'))
}

function changePipelineMode(mode: SolutionPipelineMode): void {
  const item = draft.value
  if (!item || item.pipelineMode === mode) return
  const original = props.solution?.pipeline
  if (mode === 'reuse') {
    item.pipelineMode = mode
    item.selector.pipeline = props.config.pipelines[0]?.id ?? ''
    return
  }
  if (!editing.value && mode === 'new') {
    item.pipelineMode = mode
    item.selector.pipeline = item.pipeline.id
    return
  }
  if (!original || !sharedEdit.value) return
  item.pipelineMode = mode
  item.pipeline.id = mode === 'copy' ? nextPipelineId(props.config, `${original.id}-copy`) : original.id
  item.selector.pipeline = item.pipeline.id
}

const relationOptions = [{ value: 'all', label: '全部满足' }, { value: 'any', label: '任一满足' }, { value: 'custom', label: '自定义组合' }]
const sharedOptions = computed(() => [
  { value: 'copy', label: '复制为独立 Pipeline（推荐）' },
  { value: 'shared', label: '修改共享 Pipeline（影响所有引用）' },
  ...(mappingMode.value ? [] : [{ value: 'reuse', label: '改用其他现有 Pipeline' }]),
])
const existingPipelineOptions = computed(() => [{ value: '', label: '请选择', disabled: true }, ...props.config.pipelines.map((item) => ({ value: item.id, label: item.id }))])

// 「还差 N 项」和提交时：标出缺的字段，切到有缺项的那一段，聚焦第一个；没有字段可聚焦时滚到那一组的错误（规范 8.4）。
// "N missing" and submit: mark missing fields, switch to the part that has them and focus the first; with no field
// to focus, scroll to that group's error (spec 8.4).
async function revealErrors(): Promise<void> {
  showErrors.value = true
  const first = errorsByDraft.value.findIndex((errors) => errors.length > 0)
  if (first >= 0 && first !== activeIndex.value) selectDraft(first)
  await nextTick()
  const target = body.value?.querySelector<HTMLElement>('[aria-invalid="true"], .solution-guide__group-error')
  if (!target) return
  // 出错的字段在收起的组里（响应处理、流程设置）：先把那一组打开，焦点才落得上去
  // The field sits in a folded group (响应处理, 流程设置): open that group first, or focus cannot land
  const folded = target.closest('details')
  if (folded && !folded.open) {
    folded.open = true
    await nextTick()
  }
  if (target.matches('[aria-invalid="true"]')) target.focus()
  target.scrollIntoView({ block: 'nearest' })
}

// 提交：表单完整就把草稿交出去，返回 true；缺东西就标出来、焦点落上去，返回 false（规范 8.4）。
// 页面底部的「保存并热加载」也走这一步：检查器里没应用的修改和配置一起保存（规范第 11 节：一步保存）
// Submit: a complete form hands its drafts over and returns true; a gap is marked and focused and it returns false (spec 8.4).
// The page's 保存并热加载 goes through this too, so unapplied inspector edits are saved with the config (spec section 11: one step)
function save(): boolean {
  if (!valid.value) {
    void revealErrors()
    return false
  }
  emit('save', effectiveDrafts.value.map(cloneSolutionDraft))
  return true
}

defineExpose({ submit: save, pendingDrafts: effectiveDrafts })

function cancel(): void {
  emit('cancel')
}

// 「还原」：字段回到这个入口已应用的样子，检查器留在这个入口上；底栏随之收起，焦点回到第一个字段。
// 「取消」只在添加入口时出现，关掉检查器。
// 还原 puts the fields back as the entry was applied and keeps the inspector on it; the footer folds away
// and focus returns to the first field. 取消 appears only when adding an entry and closes the inspector.
if (props.start && !editing.value) void pickTemplate(props.start)

async function revert(): Promise<void> {
  if (!props.solution) return
  const restored = createDraftFromSolution(props.solution, props.config)
  if (!restored) return
  drafts.value = [restored]
  responseStates.value = drafts.value.map((item) => hasResponseProcessing(item.rule))
  activeIndex.value = 0
  showErrors.value = false
  syncModes()
  await nextTick()
  body.value?.querySelector<HTMLElement>('select, input')?.focus()
}
</script>

<template>
  <ConfigGuideLayout :embedded="embedded" :closable="closable" class="workbench-solution" :title="editing ? (entryLabel ?? `编辑 ${solution?.selector?.pipeline}`) : '添加入口'" close-label="关闭一键方案" :show-footer="showFooter" @cancel="cancel" @submit="save">
    <div ref="body" class="solution-guide">
      <!-- 起点：选之前一列单选行，选之后收成一行 / The start: radio rows before choosing, one line after -->
      <section v-if="!editing" class="solution-guide__group">
        <div v-if="picking" class="ui-pick solution-guide__templates" role="radiogroup" aria-label="起点">
          <label v-for="template in templates" :key="template.id" class="ui-pick__opt">
            <input type="radio" :name="`${id}-template`" :checked="selectedTemplate === template.id" @change="pickTemplate(template.id)">
            <b>{{ template.name }}</b><small>{{ template.description }}</small>
          </label>
        </div>
        <template v-else>
          <div class="ui-picked">
            起点<b>{{ templateName }}</b>
            <span v-if="drafts.length > 1" class="ui-seg ui-seg--sm solution-guide__tabs" role="group" aria-label="方案组成">
              <button v-for="(_, index) in drafts" :key="index" class="ui-seg__opt" type="button" :aria-pressed="activeIndex === index" @click="selectDraft(index)">{{ index === 0 ? '国内解析' : '全局兜底' }}<i v-if="errorsByDraft[index]?.length" class="solution-guide__part-dot" aria-hidden="true"></i></button>
            </span>
            <button class="ui-btn ui-btn--text ui-btn--sm ui-picked__change" type="button" @click="picking = true">更换</button>
          </div>
          <p v-if="placement" class="solution-guide__note solution-guide__placement">{{ placement }}</p>
        </template>
      </section>

      <template v-if="draft && !picking">
        <section v-if="!mappingMode" class="solution-guide__group">
          <h3 class="solution-guide__title">匹配哪些请求<UiSelect v-if="draft.selector.matchers.length > 1" :model-value="selectorMode" size="sm" class="solution-guide__relation" :options="relationOptions" label="入口条件关系" @update:model-value="setMode('selector', $event)" /></h3>
          <MatcherList v-model="draft.selector.matchers" scope="selector" :show-errors="showErrors" :operator-mode="draft.selector.matchers.length > 1 && selectorMode === 'custom' ? 'custom' : 'hidden'" />
          <p v-if="catchAllConflict && catchAllNumber === undefined" class="solution-guide__group-error" :class="{ 'is-shown': showErrors }">{{ partLabel(siblingCatchAll) }}已经接住所有请求，这里至少要一个条件</p>
          <p v-else-if="catchAllConflict" class="solution-guide__group-error" :class="{ 'is-shown': showErrors }">入口 <button v-if="canReveal" class="ui-objlink ui-objlink--plain" type="button" :title="`在列表里找到入口 ${String(catchAllNumber).padStart(2, '0')}`" @click="emit('reveal', catchAllIndex)">{{ String(catchAllNumber).padStart(2, '0') }}</button><span v-else class="solution-guide__number">{{ String(catchAllNumber).padStart(2, '0') }}</span>「{{ catchAllSummary }}」已经接住所有请求，这里至少要一个条件</p>
          <!-- 起点那一行已经写了它放在哪，这句不再重复；编辑时没有那一行，这句才说（审计第三轮 B1） / The start line already says where it goes; only when editing, with no such line, does this one say it (audit round 3, B1) -->
          <p v-else-if="draft.selector.matchers.length === 0 && !placement" class="solution-guide__note">没有条件时匹配所有请求，这个入口会放在最后兜底。</p>
        </section>

        <section v-else class="solution-guide__group">
          <h3 class="solution-guide__title">域名映射</h3>
          <DomainMappingTable v-model="draft.mappingRows!" :show-errors="showErrors" />
          <p v-for="error in showErrors ? groupErrors.mapping : []" :key="error" class="solution-guide__group-error is-shown">{{ error }}</p>
        </section>

        <details class="solution-guide__group workbench-flow-settings ui-expand" :open="flowOpen" @toggle="flowOpen = openOf($event)">
          <summary class="solution-guide__title solution-guide__summary"><span>流程设置<code>{{ draft.selector.pipeline }}</code></span><ChevronDown :size="16" aria-hidden="true" /></summary>
          <div class="solution-guide__fields">
            <div v-if="!editing && !mappingMode" class="solution-guide__field">
              <span>进入哪个流程</span>
              <span class="ui-seg ui-seg--sm solution-guide__mode" role="group" aria-label="流程方式"><button class="ui-seg__opt" type="button" :aria-pressed="draft.pipelineMode === 'new'" @click="changePipelineMode('new')">新建</button><button class="ui-seg__opt" type="button" :aria-pressed="draft.pipelineMode === 'reuse'" @click="changePipelineMode('reuse')">复用</button></span>
            </div>
            <div v-else-if="sharedEdit" class="solution-guide__field">
              <span>共享流程</span>
              <UiSelect :model-value="draft.pipelineMode" :options="sharedOptions" label="共享流程处理方式" @update:model-value="changePipelineMode($event as SolutionPipelineMode)" />
            </div>
            <p v-if="sharedEdit && draft.pipelineMode === 'shared'" class="solution-guide__caution">改的是共享的 Pipeline，引用它的 {{ solution?.referenceCount }} 处都会跟着变。</p>
            <div v-if="draft.pipelineMode === 'reuse'" class="solution-guide__field">
              <span>现有 Pipeline</span>
              <UiSelect v-model="draft.selector.pipeline" mono :options="existingPipelineOptions" label="现有 Pipeline" :invalid="showErrors && Boolean(identityErrors.pipeline)" />
              <p v-if="showErrors && identityErrors.pipeline" class="ui-field-error">{{ identityErrors.pipeline }}</p>
            </div>
            <template v-else>
              <div class="solution-guide__field">
                <span>Pipeline ID</span>
                <label class="ui-input"><input v-model="draft.pipeline.id" class="mono" :readonly="draft.pipelineMode === 'owned' || draft.pipelineMode === 'shared'" aria-label="方案 Pipeline ID" :aria-invalid="showErrors && Boolean(identityErrors.pipeline) || undefined" @input="draft.selector.pipeline = draft.pipeline.id"></label>
                <p v-if="showErrors && identityErrors.pipeline" class="ui-field-error">{{ identityErrors.pipeline }}</p>
              </div>
              <div v-if="!mappingMode" class="solution-guide__field">
                <span>规则名称</span>
                <label class="ui-input"><input v-model="draft.rule.name" class="mono" aria-label="方案规则名称" placeholder="规则名称" :aria-invalid="showErrors && Boolean(identityErrors.name) || undefined"></label>
                <p v-if="showErrors && identityErrors.name" class="ui-field-error">{{ identityErrors.name }}</p>
              </div>
            </template>
          </div>
        </details>

        <template v-if="draft.pipelineMode !== 'reuse' && !mappingMode">
          <section class="solution-guide__group">
            <h3 class="solution-guide__title">如何处理请求</h3>
            <ActionList v-model="draft.rule.actions" :pipelines="pipelines" :current-pipeline-id="draft.pipeline.id" :capabilities="capabilities" :show-errors="showErrors" />
            <p v-if="actionWarning" class="ui-field-error">终止型动作后面还有 {{ actionWarning }} 个动作不会执行，请调整顺序。</p>
            <p v-for="error in showErrors ? groupErrors.actions : []" :key="error" class="solution-guide__group-error is-shown">{{ error }}</p>
          </section>

          <details :key="activeIndex" class="solution-guide__group solution-guide__advanced ui-expand" :open="responseOpen" @toggle="responseOpen = openOf($event)">
            <summary class="solution-guide__title solution-guide__summary"><span>响应处理<small>{{ responseSummary }}</small></span><ChevronDown :size="16" aria-hidden="true" /></summary>
            <div class="solution-guide__fields">
              <label class="solution-guide__switch">
                <span>按上游的响应继续处理<small v-if="!canUseResponse && !responseEnabled">先添加一个转发动作</small></span>
                <span class="ui-switch"><input :checked="responseEnabled" type="checkbox" role="switch" :disabled="!canUseResponse && !responseEnabled" aria-label="启用方案响应处理" @change="toggleResponse"><i aria-hidden="true"></i></span>
              </label>
              <div v-if="responseEnabled" class="solution-guide__response">
                <h4 class="solution-guide__subtitle">响应条件<UiSelect v-if="draft.rule.response_matchers.length > 1" :model-value="responseMode" size="sm" class="solution-guide__relation" :options="relationOptions" label="响应条件关系" @update:model-value="setMode('response', $event)" /></h4>
                <MatcherList v-model="draft.rule.response_matchers" scope="response" :show-errors="showErrors" :operator-mode="draft.rule.response_matchers.length > 1 && responseMode === 'custom' ? 'custom' : 'hidden'" />
                <h4 class="solution-guide__subtitle">匹配成功</h4>
                <ActionList v-model="draft.rule.response_actions_on_match" :pipelines="pipelines" :current-pipeline-id="draft.pipeline.id" :capabilities="capabilities" :show-errors="showErrors" />
                <h4 class="solution-guide__subtitle">匹配失败</h4>
                <ActionList v-model="draft.rule.response_actions_on_miss" :pipelines="pipelines" :current-pipeline-id="draft.pipeline.id" :capabilities="capabilities" :show-errors="showErrors" />
              </div>
              <p v-for="error in showErrors ? groupErrors.response : []" :key="error" class="solution-guide__group-error is-shown">{{ error }}</p>
            </div>
          </details>
        </template>
      </template>
    </div>

    <template #status>
      <button v-if="allErrors.length" class="ui-tag ui-tag--strong solution-guide__missing" type="button" @click="revealErrors">还差 {{ allErrors.length }} 项</button>
    </template>
    <template #actions>
      <button v-if="editing" class="ui-btn ui-btn--text" type="button" @click="revert">还原</button>
      <button v-else class="ui-btn ui-btn--text" type="button" @click="cancel">取消</button>
      <button class="ui-btn" :class="pageSaves ? 'ui-btn--secondary' : 'ui-btn--primary'" type="submit">应用到草稿</button>
    </template>
  </ConfigGuideLayout>
</template>

<style scoped>
/* 检查器里的表单：组和组之间 24，不画横线；组标题 14 · 600；字段名在上、控件在下（手机上字段名在左）。
   The inspector form: 24 between groups, no rules; group titles 14/600; labels above controls (beside them on a phone). */
.solution-guide { display: grid; gap: var(--s-5); padding: var(--s-5); }
.solution-guide__group { display: grid; gap: var(--s-3); min-width: 0; }
.solution-guide__title { margin: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--s-2); color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-bold); }
/* 标题后面 13 号的说明只占字那么高：按自己的行高对齐会把标题那一行撑高半个像素（审计第六轮扫查）
   The 13px fact after a title takes only its glyph height; aligned on its own line height it grew the title line by half a pixel (round-6 sweep) */
.solution-guide__title code { color: var(--l-ink-2); font-size: var(--t-2); font-weight: var(--w-normal); line-height: 1; }
.solution-guide__title small { color: var(--l-ink-2); font-size: var(--t-2); font-weight: var(--w-normal); line-height: 1; }
/* 折叠组的标题和它现在的状态隔 8：「流程设置 blocked」「响应处理 未设置」一个样（审计 A7） / A folding group's title and its current state sit 8 apart, the same in both groups (audit A7) */
.solution-guide__summary > span { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--s-2); min-width: 0; }
.solution-guide__subtitle { margin: var(--s-2) 0 0; display: flex; align-items: center; justify-content: space-between; gap: var(--s-2); color: var(--l-ink-2); font-size: var(--t-2); font-weight: var(--w-bold); }
.solution-guide__relation { width: 8rem; }
.solution-guide__summary { list-style: none; cursor: pointer; }
.solution-guide__summary::-webkit-details-marker { display: none; }
/* 折叠箭头居中在 × 那一列里：行尾的控件落在同一条竖线上（审计 A13） / The chevron centres in the × column, so row-end controls share one line (audit A13) */
.solution-guide__summary > svg { flex: 0 0 auto; margin-inline: calc((var(--rows-act) - var(--size-icon)) / 2); color: var(--l-ink-3); transition: transform var(--m-base) var(--ease-out); }
details[open] > .solution-guide__summary > svg { transform: rotate(180deg); }
details.solution-guide__group { gap: 0; }
details.solution-guide__group[open] > .solution-guide__fields { margin-top: var(--s-3); }
/* 单独的字段也让出 × 那一列：整个检查器的字段只有一条右边线（审计 A23） / Standalone fields leave the × column free too, so the inspector has one field edge (audit A23) */
.solution-guide__fields { display: grid; gap: var(--s-3); min-width: 0; padding-inline-end: calc(var(--rows-act) + var(--s-2)); }
/* 字段名在上、控件在下，每个宽度都一样：这几项是单独的设置，不是重复的子项（规范 3.4，审计 A11、B8） / Label above, control below, at every width: these are single settings, not repeated sub-items (spec 3.4, audits A11, B8) */
.solution-guide__field { display: grid; gap: var(--s-2); min-width: 0; }
.solution-guide__field > span:first-child { color: var(--l-ink-2); font-size: var(--t-2); }
/* 字段名只离自己的控件近 4：和子项里上下排的「分类」「上游」一样，字离框约 9、离上一个框约 16；控件和它的错误之间还是 8（审计第五轮 A1）
   Only the label comes 4 closer to its control: like the stacked 分类 and 上游 in the sub-items, about 9 to its box and 16 below the
   previous one, while a control keeps 8 to its error (audit round 5, A1) */
.solution-guide__field > span:first-child { margin-bottom: calc(var(--s-1) - var(--s-2)); }
.solution-guide__mode { justify-self: start; }
.solution-guide__switch { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); color: var(--l-ink); font-size: var(--t-3); cursor: pointer; }
.solution-guide__switch small { display: block; color: var(--l-ink-3); font-size: var(--t-1); }
.solution-guide__response { display: grid; gap: var(--s-3); }
.solution-guide__note { margin: 0; color: var(--l-ink-3); font-size: var(--t-1); }
/* 放置那句挂在起点那一行下面 4：它说的是起点，不是下面一组（审计第三轮 B2） / The placement note hangs 4 under the start line: it speaks of the start, not the group below (audit round 3, B2) */
.solution-guide__placement { margin-top: calc(var(--s-1) - var(--s-3)); }
.solution-guide__caution { margin: 0; color: var(--l-ink-2); font-size: var(--t-2); }
.solution-guide__part-dot { width: var(--size-dot); height: var(--size-dot); margin-left: var(--s-1); display: inline-block; border-radius: var(--r-full); background: var(--l-ink); }
.solution-guide__missing { cursor: pointer; }
/* 一组的错误：提交前是一句灰色的提醒，提交后变红（规范 2.5） / A group's error: a grey caution before submit, red after (spec 2.5) */
/* 中文只在标点和空格处换行，「条件」不会单独掉到下一行（审计第三轮 B6） / CJK breaks only at punctuation and spaces, so 条件 never drops to a line of its own (audit round 3, B6) */
.solution-guide__group-error { margin: 0; color: var(--l-ink-3); font-size: var(--t-1); word-break: keep-all; overflow-wrap: anywhere; }
.solution-guide__group-error code { font-family: var(--f-mono); }
/* 句子里说到的入口号用界面字、数字等宽，和「成为入口 04」一样；只有左边那一列的编号是等宽字（规范 1.5，审计第七轮 B2）
   An entry number inside a sentence uses the UI font with tabular digits, as in 成为入口 04; only the numbering column is mono (spec 1.5, audit round 7, B2) */
.solution-guide__number, .solution-guide__group-error .ui-objlink { font-variant-numeric: tabular-nums; }
/* 一组的错误和字段的错误一样是 12：提交前是注释色的一句提醒，提交后只变红，不换字号、不重排；里面的入口链接跟着变红，下划线还在
   （规范 2.5，审计第六轮 B2） / A group error is 12 like a field error: a note-coloured caution before submit that only turns red after,
   never changing size or reflowing; an entry link inside turns red with it and keeps its underline (spec 2.5, audit round 6, B2) */
.solution-guide__group-error.is-shown { color: var(--err-l); }
/* 句子里的入口链接跟着句子的颜色：提交前是注释色，提交后变红，下划线还在（审计第六轮 B2、第八轮 B1） / An entry link takes its sentence's colour: note-coloured before submit, red after, underline kept (audit round 6 B2, round 8 B1) */
.solution-guide__group-error .ui-objlink { color: inherit; }
/* 窄的检查器里，两段方案的分段单独一行撑满，「更换」留在起点那一行的末尾（审计 B6）
   In a narrow inspector the two-part segment takes its own full row and 更换 stays at the end of the start line (audit B6) */
@container (max-width: 31rem) {
  /* 两格平分，分段在字段的右边线结束、让出 × 那一列（审计第二轮 B5） / The two cells split evenly and the segment ends on the fields' right edge, leaving the × column free (audit round 2, B5) */
  .solution-guide__tabs { order: 1; flex-basis: 100%; max-width: calc(100% - var(--rows-act) - var(--s-2)); }
  .solution-guide__tabs .ui-seg__opt { flex: 1 1 0; justify-content: center; }
}
@media (max-width: 860px) {
  .solution-guide { padding: var(--s-4); }
}
/* 手机上「流程设置」「响应处理」这两个折叠行也是 44 高，多出来的上下各收回去，字的位置不变（规范 2.1，审计第六轮 A4）
   On a phone the 流程设置 and 响应处理 fold rows are 44 tall too, with the extra pulled back above and below so the text stays put (spec 2.1, audit round 6, A4) */
@media (max-width: 640px) {
  .solution-guide__summary { min-height: var(--h-touch); margin-block: calc((1lh - var(--h-touch)) / 2); }
}
@media (prefers-reduced-motion: reduce) { .solution-guide__summary > svg { transition: none; } }
</style>
