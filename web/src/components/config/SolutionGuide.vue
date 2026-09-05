<script setup lang="ts">
import { ArrowDown, ArrowRight, Sparkles, TriangleAlert } from '@lucide/vue'
import { computed, ref, useId, watch } from 'vue'
import {
  SOLUTION_TEMPLATES,
  cloneSolutionDraft,
  createDraftFromSolution,
  createSolutionDrafts,
  solutionIdentityErrors,
  solutionInsertIndex,
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
import { summarizeActions, summarizeMatchers } from '../../config-editor/summary'
import type { KixConfig, PipelineSelectMode } from '../../config-editor/types'
import ActionList from './ActionList.vue'
import ConfigGuideLayout from './ConfigGuideLayout.vue'
import DomainMappingTable from './DomainMappingTable.vue'
import MatcherList from './MatcherList.vue'

const props = withDefaults(defineProps<{ config: KixConfig; capabilities: string[]; solution?: DnsSolution; embedded?: boolean }>(), { embedded: false })
const emit = defineEmits<{ cancel: []; save: [drafts: SolutionDraft[]]; dirty: [value: boolean] }>()
const id = useId()

const editing = computed(() => props.solution !== undefined)
const initial = props.solution ? createDraftFromSolution(props.solution, props.config) : undefined
const drafts = ref<SolutionDraft[]>(initial ? [initial] : createSolutionDrafts(props.config, 'domestic_global'))
const selectedTemplate = ref<SolutionTemplateId>(props.solution?.groupType ?? 'domestic_global')
const activeIndex = ref(0)
const draft = computed(() => drafts.value[activeIndex.value]!)
const mappingMode = computed(() => draft.value.groupType === 'domain_mapping')
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
const draftChanged = computed(() => JSON.stringify(effectiveDrafts.value) !== initialDraftSource)
watch(draftChanged, (value) => emit('dirty', value), { immediate: true, flush: 'sync' })
const templates = computed(() => SOLUTION_TEMPLATES.filter((template) => (
  template.id !== 'domain_mapping'
  && (!template.requiresCapability || props.capabilities.includes(template.requiresCapability))
)))

function syncModes(): void {
  selectorMode.value = inferMatcherMode(draft.value.selector.matchers, draft.value.selector.matcher_operator)
  responseMode.value = inferMatcherMode(draft.value.rule.response_matchers, draft.value.rule.response_matcher_operator)
}
syncModes()

const pipelines = computed(() => {
  const result = props.config.pipelines.map((pipeline) => ({ ...pipeline }))
  for (const item of effectiveDrafts.value) {
    if (item.pipelineMode === 'reuse') continue
    const index = result.findIndex((pipeline) => pipeline.id === item.pipeline.id)
    const pipeline = item.pipeline
    if (index >= 0) result[index] = pipeline
    else result.push(pipeline)
  }
  return result
})
const errorsByDraft = computed(() => effectiveDrafts.value.map((item, index) => {
  const others = effectiveDrafts.value.filter((candidate, candidateIndex) => candidateIndex !== index && candidate.pipelineMode !== 'reuse').map((candidate) => candidate.pipeline.id)
  const errors = solutionValidationErrors(item, props.config, props.solution?.selectorIndex, others)
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
const identityErrors = computed(() => solutionIdentityErrors(draft.value, props.config,
  drafts.value.filter((item, index) => index !== activeIndex.value && item.pipelineMode !== 'reuse').map((item) => item.pipeline.id)))
const valid = computed(() => allErrors.value.length === 0)
const preview = computed(() => ({
  entry: summarizeMatchers(draft.value.selector.matchers, draft.value.selector.matcher_operator, 'selector'),
  action: summarizeActions(draft.value.rule.actions),
  response: summarizeMatchers(draft.value.rule.response_matchers, draft.value.rule.response_matcher_operator, 'response'),
}))
const canUseResponse = computed(() => draft.value.rule.actions.some((action) => action.type === 'forward'))
const sharedEdit = computed(() => editing.value && (props.solution?.referenceCount ?? 0) > 1)
const actionWarning = computed(() => ignoredActionsAfterTerminal(draft.value.rule.actions))
const placement = computed(() => {
  if (editing.value) return `保留当前第 ${(props.solution?.selectorIndex ?? 0) + 1} 个入口的位置`
  const pendingConfig = { ...props.config, pipeline_select: [...props.config.pipeline_select] }
  for (const item of effectiveDrafts.value.slice(0, activeIndex.value)) {
    pendingConfig.pipeline_select.splice(solutionInsertIndex(pendingConfig, item.selector), 0, item.selector)
  }
  const index = solutionInsertIndex(pendingConfig, draft.value.selector)
  return index < pendingConfig.pipeline_select.length ? `插入第 ${index + 1} 个入口，位于兜底方案之前` : `放在末尾，成为第 ${index + 1} 个入口`
})

function applyTemplate(templateId: SolutionTemplateId): void {
  selectedTemplate.value = templateId
  drafts.value = createSolutionDrafts(props.config, templateId)
  responseStates.value = drafts.value.map((item) => hasResponseProcessing(item.rule))
  activeIndex.value = 0
  syncModes()
}

function selectDraft(index: number): void {
  activeIndex.value = index
  syncModes()
}

function setMode(stage: 'selector' | 'response', event: Event): void {
  const mode = (event.currentTarget as HTMLSelectElement).value as PipelineSelectMode
  if (stage === 'selector') {
    selectorMode.value = mode
    draft.value.selector.matcher_operator = applyMatcherMode(draft.value.selector.matchers, mode)
  } else {
    responseMode.value = mode
    draft.value.rule.response_matcher_operator = applyMatcherMode(draft.value.rule.response_matchers, mode)
  }
}

function toggleResponse(event: Event): void {
  responseEnabled.value = (event.currentTarget as HTMLInputElement).checked
  if (!responseEnabled.value || hasResponseProcessing(draft.value.rule)) return
  draft.value.rule.response_matchers.push(createMatcher('response'))
  draft.value.rule.response_actions_on_match.push(createAction('log'))
}

function changePipelineMode(mode: SolutionPipelineMode): void {
  const item = draft.value
  if (item.pipelineMode === mode) return
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

function selectExistingPipeline(event: Event): void {
  draft.value.selector.pipeline = (event.currentTarget as HTMLSelectElement).value
}

function save(): void {
  if (!valid.value) return
  emit('save', effectiveDrafts.value.map(cloneSolutionDraft))
}
</script>

<template>
  <ConfigGuideLayout :embedded="embedded" :class="{ 'workbench-solution': embedded }" :title="embedded ? (editing ? `编辑 ${solution?.selector?.pipeline}` : '添加入口') : editing ? '一键编辑 DNS 方案' : '一键添加 DNS 方案'" :kicker="embedded ? (draftChanged || !editing ? '未应用到草稿' : '编辑草稿') : '一键方案'" :description="embedded ? '调整当前入口，应用到草稿后统一保存' : '填写条件与动作，右侧同步预览执行路径'" close-label="关闭一键方案" :summary="preview.entry" :issue-count="allErrors.length" @cancel="emit('cancel')" @submit="save">
          <template #overview><span>{{ preview.entry }}</span><ArrowRight :size="16" /><strong>{{ draft.selector.pipeline || '待选择流程' }}</strong><ArrowRight :size="16" /><span>{{ draft.pipelineMode === 'reuse' ? '复用流程' : mappingMode ? '返回 CNAME' : preview.action }}</span></template>
          <template v-if="!editing" #templates>
            <div class="solution-guide__templates">
              <button v-for="template in templates" :key="template.id" type="button" :aria-pressed="selectedTemplate === template.id" :class="{ 'is-selected': selectedTemplate === template.id }" @click="applyTemplate(template.id)"><strong>{{ template.name }}</strong><small>{{ template.description }}</small></button>
            </div>
          </template>

          <nav v-if="drafts.length > 1" class="solution-guide__tabs" aria-label="方案组成">
            <button v-for="(_, index) in drafts" :key="index" type="button" :aria-pressed="activeIndex === index" :class="{ 'is-selected': activeIndex === index }" @click="selectDraft(index)">{{ index === 0 ? '国内解析' : '全局兜底' }}<em v-if="errorsByDraft[index]?.length">{{ errorsByDraft[index]?.length }} 项待补全</em></button>
          </nav>

          <section v-if="!mappingMode" class="solution-guide__step">
            <header><span>1</span><div><strong>匹配哪些请求</strong><small>条件变化时，执行预览同步更新</small></div></header>
            <div class="solution-guide__stage-title"><strong>入口条件</strong><select v-if="draft.selector.matchers.length > 1" :value="selectorMode" aria-label="入口条件关系" @change="setMode('selector', $event)"><option value="all">全部满足</option><option value="any">任一满足</option><option value="custom">自定义组合</option></select></div>
            <MatcherList v-model="draft.selector.matchers" scope="selector" :operator-mode="draft.selector.matchers.length > 1 && selectorMode === 'custom' ? 'custom' : 'hidden'" />
            <p v-if="selectedTemplate === 'domain_upstream' || selectedTemplate === 'ad_block' || selectedTemplate === 'client_network'" class="solution-guide__hint">多个条件使用同一处理方式时，直接继续添加条件并选择“任一满足”，仍只会创建一张方案卡片。</p>
            <p v-if="draft.selector.matchers.length === 0" class="solution-guide__hint">未添加入口条件时匹配任意请求，应放在全部方案的最后作为兜底。</p>
          </section>

          <section v-else class="solution-guide__step">
            <header><span>1</span><div><strong>维护域名映射表</strong><small>一张方案可以包含多条映射</small></div></header>
            <DomainMappingTable v-model="draft.mappingRows!" />
          </section>

          <details class="solution-guide__step workbench-flow-settings" :open="!embedded || !editing || sharedEdit || Boolean(identityErrors.pipeline || identityErrors.name)">
            <summary :hidden="!embedded || !editing">流程设置 <span>{{ draft.selector.pipeline }}</span></summary>
            <header v-if="!embedded || !editing"><span>2</span><div><strong>进入哪个处理流程</strong><small>独立流程可以单独调整，复用流程会共享处理逻辑</small></div></header>
            <div v-if="!editing && !mappingMode" class="solution-guide__mode" role="group" aria-label="流程方式"><button type="button" :aria-pressed="draft.pipelineMode === 'new'" @click="changePipelineMode('new')">新建流程</button><button type="button" :aria-pressed="draft.pipelineMode === 'reuse'" @click="changePipelineMode('reuse')">复用现有流程</button></div>
            <label v-else-if="sharedEdit" class="solution-guide__field"><span>共享流程</span><select :value="draft.pipelineMode" aria-label="共享流程处理方式" @change="changePipelineMode(($event.currentTarget as HTMLSelectElement).value as SolutionPipelineMode)"><option value="copy">复制为独立 Pipeline（推荐）</option><option value="shared">修改共享 Pipeline（影响所有引用）</option><option v-if="!mappingMode" value="reuse">改用其他现有 Pipeline</option></select></label>
            <p v-if="sharedEdit && draft.pipelineMode === 'shared'" class="solution-guide__warning">当前 Pipeline 有 {{ solution?.referenceCount }} 处引用，保存会同时影响引用它的入口和规则。</p>
            <label v-if="draft.pipelineMode === 'reuse'" class="solution-guide__field"><span>现有 Pipeline</span><select :value="draft.selector.pipeline" aria-label="现有 Pipeline" :aria-invalid="Boolean(identityErrors.pipeline)" :aria-describedby="identityErrors.pipeline ? `${id}-pipeline-error` : undefined" @change="selectExistingPipeline"><option disabled value="">请选择</option><option v-for="item in config.pipelines" :key="item.id" :value="item.id">{{ item.id }}</option></select><small v-if="identityErrors.pipeline" :id="`${id}-pipeline-error`" class="field-error">{{ identityErrors.pipeline }}</small></label>
            <div v-else class="solution-guide__identity">
              <label class="solution-guide__field"><span>Pipeline ID</span><input v-model="draft.pipeline.id" :readonly="draft.pipelineMode === 'owned' || draft.pipelineMode === 'shared'" aria-label="方案 Pipeline ID" :aria-invalid="Boolean(identityErrors.pipeline)" :aria-describedby="identityErrors.pipeline ? `${id}-pipeline-error` : undefined" @input="draft.selector.pipeline = draft.pipeline.id"><small v-if="identityErrors.pipeline" :id="`${id}-pipeline-error`" class="field-error">{{ identityErrors.pipeline }}</small></label>
              <label v-if="!mappingMode" class="solution-guide__field"><span>规则名称</span><input v-model="draft.rule.name" aria-label="方案规则名称" placeholder="填写规则名称" :aria-invalid="Boolean(identityErrors.name)" :aria-describedby="identityErrors.name ? `${id}-name-error` : undefined"><small v-if="identityErrors.name" :id="`${id}-name-error`" class="field-error">{{ identityErrors.name }}</small></label>
            </div>
          </details>

          <template v-if="draft.pipelineMode !== 'reuse' && !mappingMode">
            <section class="solution-guide__step">
              <header><span>3</span><div><strong>如何处理请求</strong><small>动作按从上到下顺序执行；可从已有上游中选择</small></div></header>
              <ActionList v-model="draft.rule.actions" :pipelines="pipelines" :current-pipeline-id="draft.pipeline.id" :capabilities="capabilities" />
              <p v-if="actionWarning" class="solution-guide__warning"><TriangleAlert :size="14" />终止型动作之后还有 {{ actionWarning }} 个动作不会执行，请调整顺序。</p>
            </section>

            <section class="solution-guide__step">
              <details :key="activeIndex" class="solution-guide__advanced" :open="responseEnabled">
              <summary>响应处理 <span>{{ responseEnabled ? '已启用双分支' : '可选，按上游响应继续处理' }}</span></summary>
              <label class="solution-guide__response-toggle" :class="{ 'is-disabled': !canUseResponse && !responseEnabled }"><input :checked="responseEnabled" type="checkbox" :disabled="!canUseResponse && !responseEnabled" aria-label="启用方案响应处理" @change="toggleResponse"><span><strong>启用响应匹配与双分支</strong><small>{{ canUseResponse ? '配置响应条件及两个分支的后续动作' : '先添加转发动作' }}</small></span></label>
              <div v-if="responseEnabled" class="solution-guide__response">
                <div class="solution-guide__stage-title"><strong>响应条件</strong><select v-if="draft.rule.response_matchers.length > 1" :value="responseMode" aria-label="响应条件关系" @change="setMode('response', $event)"><option value="all">全部满足</option><option value="any">任一满足</option><option value="custom">自定义组合</option></select></div>
                <MatcherList v-model="draft.rule.response_matchers" scope="response" :operator-mode="draft.rule.response_matchers.length > 1 && responseMode === 'custom' ? 'custom' : 'hidden'" />
                <div class="solution-guide__branch"><strong>匹配成功</strong><ActionList v-model="draft.rule.response_actions_on_match" :pipelines="pipelines" :current-pipeline-id="draft.pipeline.id" :capabilities="capabilities" /></div>
                <div class="solution-guide__branch"><strong>匹配失败</strong><ActionList v-model="draft.rule.response_actions_on_miss" :pipelines="pipelines" :current-pipeline-id="draft.pipeline.id" :capabilities="capabilities" /></div>
              </div>
              </details>
            </section>
          </template>

          <template #preview>
            <div class="solution-guide__preview">
              <div><span>匹配请求</span><strong>{{ mappingMode ? `${draft.mappingRows?.length ?? 0} 条域名映射` : preview.entry }}</strong></div><ArrowDown :size="15" />
              <div><span>进入流程</span><strong>{{ draft.selector.pipeline || '待选择流程' }}</strong></div><ArrowDown :size="15" />
              <div><span>执行动作</span><strong>{{ mappingMode ? '按源域名返回对应 CNAME' : draft.pipelineMode === 'reuse' ? '按现有流程处理' : preview.action }}</strong></div>
            </div>
            <div v-if="responseEnabled && draft.pipelineMode !== 'reuse'" class="solution-guide__preview solution-guide__preview--response"><div><span>响应条件</span><strong>{{ preview.response }}</strong></div><div><span>匹配成功</span><strong>{{ summarizeActions(draft.rule.response_actions_on_match) }}</strong></div><div><span>匹配失败</span><strong>{{ summarizeActions(draft.rule.response_actions_on_miss) }}</strong></div></div>
            <div class="solution-guide__placement"><strong>匹配顺序</strong><p>{{ placement }}</p><small>域名映射优先；其余方案按顺序匹配，首个命中生效。</small></div>
            <div v-if="allErrors.length" class="solution-guide__issues" aria-label="方案待补全项"><strong>待补全项</strong><template v-for="(errors, index) in errorsByDraft" :key="index"><button v-if="errors.length && drafts.length > 1" type="button" @click="selectDraft(index)">{{ index === 0 ? '国内解析' : '全局兜底' }} · 点击编辑</button><ul v-if="errors.length"><li v-for="error in errors" :key="error">{{ error }}</li></ul></template></div>
          </template>
          <template #footer-status><small>{{ allErrors.length ? '请查看对应字段或预览中的待补全项' : '加入编辑草稿，保存配置后生效' }}</small></template>
          <template #actions><button class="button button--secondary" type="button" @click="emit('cancel')">取消</button><button class="button button--primary" type="submit" :disabled="!valid"><Sparkles :size="14" />{{ embedded ? '应用到草稿' : editing ? '保存方案' : drafts.length > 1 ? `创建 ${drafts.length} 个方案` : '创建方案' }}</button></template>
  </ConfigGuideLayout>
</template>

<style scoped>
.solution-guide__step { display: grid; min-width: 0; gap: 14px; padding: 20px; border-bottom: 1px solid var(--line); }
.solution-guide__step > header { display: flex; align-items: center; gap: 9px; }
.solution-guide__step > header > span { display: grid; flex-shrink: 0; place-items: center; width: 24px; height: 24px; border-radius: 50%; color: #fff; background: var(--green); font-size: 11px; }
.solution-guide__step > header > div { display: grid; gap: 3px; }
.solution-guide__step strong { font-size: 12px; }
.solution-guide__step small, small { color: var(--muted); font-size: 10px; line-height: 1.5; }
.solution-guide__templates { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 7px; padding: 14px 20px; }
.solution-guide__templates button { display: grid; gap: 4px; padding: 10px; text-align: left; color: inherit; background: #fff; border: 1px solid var(--line); border-radius: 5px; cursor: pointer; }
.solution-guide__templates strong { font-size: 11px; }
.solution-guide__templates button.is-selected, .solution-guide__tabs button.is-selected, .solution-guide__mode button[aria-pressed="true"] { border-color: #8db7a3; color: var(--green-dark); background: var(--green-soft); }
.solution-guide__tabs { display: flex; gap: 7px; padding: 12px 20px; border-bottom: 1px solid var(--line); }
.solution-guide__tabs button, .solution-guide__mode button { display: flex; flex-wrap: wrap; gap: 5px; padding: 8px 12px; color: inherit; background: #fff; border: 1px solid var(--line); border-radius: 5px; cursor: pointer; font-size: 11px; }
.solution-guide__tabs em { font-size: 10px; font-style: normal; color: #996425; }
.solution-guide__identity { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.solution-guide__field { display: grid; min-width: 0; gap: 6px; align-content: start; }
.solution-guide__field > span { color: #59635f; font-size: 11px; }
.solution-guide__field input, .solution-guide__field select, .solution-guide__stage-title select { width: 100%; min-width: 0; height: 36px; padding: 0 9px; color: #31393b; background: #fff; border: 1px solid #d9dfdd; border-radius: 4px; outline: 0; }
.solution-guide__field input:focus, .solution-guide__field select:focus { border-color: #7fb89a; box-shadow: 0 0 0 3px rgba(20, 125, 85, .08); }
.solution-guide__field input[readonly] { background: #f4f6f5; }
.solution-guide__field [aria-invalid="true"], .solution-guide__field [aria-invalid="true"]:focus { border-color: #b6564e; }
.solution-guide__field .field-error { color: #a1453f; }
.solution-guide__mode { display: flex; gap: 6px; }
.solution-guide__stage-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.solution-guide__stage-title select { width: auto; }
.solution-guide__hint, .solution-guide__warning { padding: 10px; color: #8a6329; background: #fff8ee; border-radius: 4px; font-size: 11px; line-height: 1.6; }
.solution-guide__advanced summary { cursor: pointer; font-size: 12px; font-weight: 650; }
.solution-guide__advanced summary span { display: inline-block; padding-left: 8px; color: var(--muted); font-size: 10px; font-weight: 400; }
.solution-guide__response-toggle { display: flex; align-items: flex-start; gap: 8px; margin-top: 14px; padding: 10px; background: #f6faf8; border: 1px solid #d9e7e0; border-radius: 5px; cursor: pointer; }
.solution-guide__response-toggle > span { display: grid; gap: 4px; }
.solution-guide__response { display: grid; gap: 14px; margin-top: 15px; }
.solution-guide__branch { display: grid; gap: 8px; padding-top: 12px; border-top: 1px dashed var(--line); }
.solution-guide__preview { display: grid; gap: 14px; }
.solution-guide__preview > div { display: grid; min-width: 0; gap: 6px; }
.solution-guide__preview span { color: var(--muted); font-size: 11px; }
.solution-guide__preview strong { overflow-wrap: anywhere; color: #35413c; font-size: 12px; line-height: 1.7; }
.solution-guide__preview > svg { color: #81a593; }
.solution-guide__preview--response, .solution-guide__placement { padding-top: 15px; border-top: 1px solid var(--line); }
.solution-guide__placement { display: grid; gap: 7px; }
.solution-guide__placement strong { font-size: 11px; }
.solution-guide__placement p { font-size: 11px; line-height: 1.6; }
.solution-guide__issues { display: grid; gap: 6px; padding: 10px 12px; color: #a1453f; background: #fff4f1; border-radius: 5px; font-size: 11px; }
.solution-guide__issues ul { padding-left: 16px; line-height: 1.7; }
.solution-guide__issues button { justify-self: start; padding: 0; color: inherit; background: transparent; border: 0; text-decoration: underline; cursor: pointer; font: inherit; }
.workbench-solution .solution-guide__step { padding: 18px 20px; gap: 12px; }
.workbench-solution .solution-guide__step > header > span { display: none; }
.workbench-solution .solution-guide__step strong, .workbench-solution .solution-guide__advanced summary { font-size: 14px; }
.workbench-solution .solution-guide__step small, .workbench-solution small { font-size: 12px; }
.workbench-solution .solution-guide__field > span { font-size: 12px; }
.workbench-solution .solution-guide__identity { grid-template-columns: 1fr; }
.workbench-solution .solution-guide__templates { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 12px 20px; }
.workbench-solution .solution-guide__templates strong { font-size: 12px; }
.workbench-solution .solution-guide__mode button { flex: 1; font-size: 12px; }
.workbench-solution .solution-guide__hint, .workbench-solution .solution-guide__warning, .workbench-solution .solution-guide__issues { font-size: 12px; }
.workbench-solution .solution-guide__preview { gap: 9px; }
.workbench-solution .solution-guide__preview strong, .workbench-solution .solution-guide__placement p { font-size: 12px; }
.workbench-solution .solution-guide__advanced summary span { padding-left: 0; font-size: 12px; }
.workbench-flow-settings > summary { cursor: pointer; font-size: 14px; font-weight: 600; }
.workbench-flow-settings > summary > span { padding-left: 8px; color: var(--muted); font-size: 12px; font-weight: 400; }
.workbench-flow-settings[open] > :not(:first-child) { margin-top: 12px; }
@media (max-width: 860px) {
  .solution-guide__step { padding: 15px 14px; }
  .solution-guide__templates { display: flex; overflow-x: auto; padding: 10px 14px; }
  .solution-guide__templates button { flex: 0 0 142px; }
  .solution-guide__tabs { padding: 10px 14px; }
  .solution-guide__identity { grid-template-columns: 1fr; }
  .workbench-solution .solution-guide__step { padding: 16px; }
  .workbench-solution .solution-guide__templates { display: grid; padding: 12px 16px; }
  .workbench-solution .solution-guide__step :deep(.matcher-row), .workbench-solution .solution-guide__step :deep(.action-row) { padding: 0; border: 0; border-radius: 0; }
  .workbench-solution .solution-guide__step :deep(.matcher-card__fields), .workbench-solution .solution-guide__step :deep(.action-card__fields) { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .workbench-solution .solution-guide__step :deep(.matcher-field), .workbench-solution .solution-guide__step :deep(.action-field) { grid-template-columns: 84px minmax(0, 1fr); align-items: center; gap: 6px 8px; }
  .workbench-solution .solution-guide__step :deep(.action-field--wide) { grid-column: 1; }
  .workbench-solution .solution-guide__step :deep(.matcher-field > small), .workbench-solution .solution-guide__step :deep(.action-field > small) { grid-column: 1 / -1; }
}
</style>
