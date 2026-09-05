<script setup lang="ts">
import { AlertTriangle, ArrowRight, Check, ChevronDown, Sparkles } from '@lucide/vue'
import { computed, ref } from 'vue'
import {
  GUIDED_RULE_TEMPLATES,
  cloneGuidedRule,
  createGuidedRuleFromTemplate,
  guidedRuleInsertIndexForRule,
  guidedRuleValidationErrors,
  ignoredActionsAfterTerminal,
  type GuidedRuleTemplateId,
} from '../../config-editor/guided-rule'
import { applyMatcherMode, createAction, createMatcher, inferMatcherMode } from '../../config-editor/model'
import { hasResponseProcessing, responseValidationErrors, withResponseState } from '../../config-editor/rule-draft'
import { CONFIG_STATIC_CNAME_RESPONSE_V1 } from '../../config-editor/schema'
import { analyzeRuleFlow, findBlockingRule, ruleMatchesEveryRequest, summarizeActions, summarizeMatchers, summarizeRule } from '../../config-editor/summary'
import type { PipelineConfig, PipelineSelectMode, RuleConfig } from '../../config-editor/types'
import ActionList from './ActionList.vue'
import ConfigGuideLayout from './ConfigGuideLayout.vue'
import MatcherList from './MatcherList.vue'

const props = defineProps<{
  pipeline: PipelineConfig
  pipelines: PipelineConfig[]
  capabilities: string[]
  rule?: RuleConfig
  ruleIndex?: number
}>()
const emit = defineEmits<{
  cancel: []
  save: [rule: RuleConfig, index: number]
}>()

const editing = computed(() => props.rule !== undefined)
const fallbackPipeline = computed(() => props.pipelines.find((item) => item.id !== props.pipeline.id)?.id ?? '')
const initialRule = props.rule
  ? cloneGuidedRule(props.rule)
  : createGuidedRuleFromTemplate(props.pipeline, 'domain_upstream', fallbackPipeline.value)
const draft = ref(initialRule)
const selectedTemplate = ref<GuidedRuleTemplateId>('domain_upstream')
const requestMode = ref<PipelineSelectMode>(inferMatcherMode(initialRule.matchers, initialRule.matcher_operator))
const responseMode = ref<PipelineSelectMode>(inferMatcherMode(initialRule.response_matchers, initialRule.response_matcher_operator))
const responseEnabled = ref(hasResponseProcessing(initialRule))
const responseExpanded = ref(responseEnabled.value)
const effectiveRule = computed(() => withResponseState(draft.value, responseEnabled.value))
const templates = computed(() => GUIDED_RULE_TEMPLATES.filter((template) => (
  !template.requiresCapability || props.capabilities.includes(template.requiresCapability)
)))

const hasForward = computed(() => effectiveRule.value.actions.some((action) => action.type === 'forward'))
const nameError = computed(() => {
  if (!draft.value.name.trim()) return '请填写规则名称'
  return props.pipeline.rules.some((rule, index) => rule.name === draft.value.name && index !== props.ruleIndex)
    ? '规则名称已存在'
    : ''
})
const validationErrors = computed(() => {
  const rule = effectiveRule.value
  const errors = guidedRuleValidationErrors(rule, props.pipeline.id, props.pipelines.map((pipeline) => pipeline.id))
  errors.push(...responseValidationErrors(rule, responseEnabled.value))
  if (nameError.value) errors.push(nameError.value)
  const actions = [rule.actions, rule.response_actions_on_match, rule.response_actions_on_miss].flat()
  if (actions.some((action) => action.type === 'static_cname_response')
    && !props.capabilities.includes(CONFIG_STATIC_CNAME_RESPONSE_V1)) {
    errors.push('当前 KixDNS 不支持固定 CNAME，请先更新或切换内核')
  }
  return [...new Set(errors)]
})
const preview = computed(() => summarizeRule(effectiveRule.value))
const responseCondition = computed(() => summarizeMatchers(effectiveRule.value.response_matchers, effectiveRule.value.response_matcher_operator, 'response'))
const successActions = computed(() => summarizeActions(effectiveRule.value.response_actions_on_match))
const missActions = computed(() => summarizeActions(effectiveRule.value.response_actions_on_miss))
const insertIndex = computed(() => editing.value ? (props.ruleIndex ?? 0) : guidedRuleInsertIndexForRule(props.pipeline, effectiveRule.value))
const existingFallback = computed(() => !editing.value
  && ruleMatchesEveryRequest(effectiveRule.value)
  && !['continue', 'conditional'].includes(analyzeRuleFlow(effectiveRule.value).kind)
  ? findBlockingRule(props.pipeline, props.pipeline.rules.length)
  : undefined)
const placement = computed(() => {
  if (editing.value) return `保存到当前第 ${(props.ruleIndex ?? 0) + 1} 条，规则顺序不变`
  if (existingFallback.value) return `已有第 ${existingFallback.value.index + 1} 条终止型兜底规则“${existingFallback.value.name}”`
  if (insertIndex.value === props.pipeline.rules.length) return `放在末尾，成为第 ${insertIndex.value + 1} 条规则`
  return `放在第 ${insertIndex.value + 1} 条，位于兜底规则之前`
})
const actionWarning = computed(() => ignoredActionsAfterTerminal(effectiveRule.value.actions))
const successWarning = computed(() => ignoredActionsAfterTerminal(effectiveRule.value.response_actions_on_match, 'response'))
const missWarning = computed(() => ignoredActionsAfterTerminal(effectiveRule.value.response_actions_on_miss, 'response'))
const issueCount = computed(() => validationErrors.value.length + Number(Boolean(existingFallback.value)))
const valid = computed(() => validationErrors.value.length === 0 && !existingFallback.value)

function applyTemplate(templateId: GuidedRuleTemplateId): void {
  selectedTemplate.value = templateId
  draft.value = createGuidedRuleFromTemplate(props.pipeline, templateId, fallbackPipeline.value)
  requestMode.value = inferMatcherMode(draft.value.matchers, draft.value.matcher_operator)
  responseMode.value = inferMatcherMode(draft.value.response_matchers, draft.value.response_matcher_operator)
  responseEnabled.value = hasResponseProcessing(draft.value)
  responseExpanded.value = responseEnabled.value
}

function setMatcherMode(stage: 'request' | 'response', event: Event): void {
  const mode = (event.currentTarget as HTMLSelectElement).value as PipelineSelectMode
  const matchers = stage === 'request' ? draft.value.matchers : draft.value.response_matchers
  const operator = applyMatcherMode(matchers, mode)
  if (stage === 'request') {
    requestMode.value = mode
    draft.value.matcher_operator = operator
  } else {
    responseMode.value = mode
    draft.value.response_matcher_operator = operator
  }
}

function toggleResponse(event: Event): void {
  responseEnabled.value = (event.currentTarget as HTMLInputElement).checked
  if (!responseEnabled.value) return
  responseExpanded.value = true
  if (hasResponseProcessing(draft.value)) return
  draft.value.response_matchers.push(createMatcher('response'))
  draft.value.response_actions_on_match.push(createAction('log'))
}

function save(): void {
  if (!valid.value) return
  emit('save', cloneGuidedRule(effectiveRule.value), insertIndex.value)
}
</script>

<template>
  <ConfigGuideLayout
    :title="editing ? '一键编辑规则' : '一键添加规则'"
    kicker="规则编辑器"
    description="选择起点，组合请求与动作；右侧同步预览执行路径。"
    close-label="关闭一键规则"
    :summary="`${preview.condition} → ${preview.action}`"
    :issue-count="issueCount"
    @cancel="emit('cancel')"
    @submit="save"
  >
    <template v-if="!editing" #templates>
      <section class="rule-guide__step rule-guide__step--templates">
        <header><div><strong>选择一个起点</strong><small>选择后自动填入，下面可以继续调整</small></div></header>
        <div class="rule-guide__templates">
          <button v-for="template in templates" :key="template.id" type="button" :class="{ 'is-selected': selectedTemplate === template.id }" :aria-pressed="selectedTemplate === template.id" @click="applyTemplate(template.id)"><strong>{{ template.name }}<Check v-if="selectedTemplate === template.id" :size="13" /></strong><small>{{ template.description }}</small></button>
        </div>
      </section>
    </template>

    <section class="rule-guide__step">
      <header><span>1</span><div><strong>什么请求需要处理？</strong><small>条件可组合为全部满足、任一满足或自定义关系</small></div></header>
      <label class="rule-guide__name">
        <span>规则名称</span>
        <input v-model="draft.name" aria-label="一键规则名称" :aria-invalid="Boolean(nameError)" :aria-describedby="nameError ? 'guided-rule-name-error' : undefined" type="text" placeholder="例如 cn-doh-fallback">
        <small v-if="nameError" id="guided-rule-name-error" class="rule-guide__field-error">{{ nameError }}</small>
      </label>
      <div class="rule-guide__stage-title"><strong>请求条件</strong><select v-if="draft.matchers.length > 1" :value="requestMode" aria-label="一键请求条件关系" @change="setMatcherMode('request', $event)"><option value="all">全部满足</option><option value="any">任一满足</option><option value="custom">自定义组合</option></select></div>
      <MatcherList v-model="draft.matchers" scope="request" :operator-mode="draft.matchers.length > 1 && requestMode === 'custom' ? 'custom' : 'hidden'" />
      <p v-if="draft.matchers.length === 0" class="rule-guide__hint">未添加请求条件时会匹配所有请求，适合作为末尾兜底规则。</p>
    </section>

    <section class="rule-guide__step">
      <header><span>2</span><div><strong>命中后依次做什么？</strong><small>动作严格按从上到下的顺序执行</small></div></header>
      <ActionList v-model="draft.actions" :pipelines="pipelines" :current-pipeline-id="pipeline.id" :capabilities="capabilities" />
      <p v-if="actionWarning" class="rule-guide__warning"><AlertTriangle :size="14" />终止型动作之后还有 {{ actionWarning }} 个动作，不会被执行，请调整顺序。</p>
    </section>

    <details class="rule-guide__step rule-guide__response-details" :open="responseExpanded" @toggle="responseExpanded = ($event.currentTarget as HTMLDetailsElement).open">
      <summary aria-label="响应处理设置"><span class="rule-guide__step-number">3</span><div><strong>响应处理</strong><small>{{ responseEnabled ? '已启用 · 根据返回内容进入不同分支' : '可选 · 根据返回内容继续处理' }}</small></div><ChevronDown :size="16" /></summary>
      <div class="rule-guide__response-body">
        <label class="rule-guide__response-toggle" :class="{ 'is-disabled': !hasForward && !responseEnabled }">
          <input :checked="responseEnabled" type="checkbox" :disabled="!hasForward && !responseEnabled" aria-label="启用响应处理" @change="toggleResponse">
          <span><strong>启用响应匹配与双分支</strong><small>{{ hasForward ? '配置响应条件，以及匹配成功和匹配失败后的动作' : '先在上一步添加转发动作' }}</small></span>
        </label>
        <div v-if="responseEnabled" class="rule-guide__response">
          <div class="rule-guide__stage-title"><div><strong>响应条件</strong><small>无条件时任意响应都算匹配成功</small></div><select v-if="draft.response_matchers.length > 1" :value="responseMode" aria-label="一键响应条件关系" @change="setMatcherMode('response', $event)"><option value="all">全部满足</option><option value="any">任一满足</option><option value="custom">自定义组合</option></select></div>
          <MatcherList v-model="draft.response_matchers" scope="response" :operator-mode="draft.response_matchers.length > 1 && responseMode === 'custom' ? 'custom' : 'hidden'" />
          <div class="rule-guide__branch"><header><strong>匹配成功</strong><small>{{ successActions }}</small></header><ActionList v-model="draft.response_actions_on_match" :pipelines="pipelines" :current-pipeline-id="pipeline.id" :capabilities="capabilities" /><p v-if="successWarning" class="rule-guide__warning"><AlertTriangle :size="14" />终止型动作之后还有 {{ successWarning }} 个动作不会执行。</p></div>
          <div class="rule-guide__branch"><header><strong>匹配失败</strong><small>{{ missActions }}</small></header><ActionList v-model="draft.response_actions_on_miss" :pipelines="pipelines" :current-pipeline-id="pipeline.id" :capabilities="capabilities" /><p v-if="missWarning" class="rule-guide__warning"><AlertTriangle :size="14" />终止型动作之后还有 {{ missWarning }} 个动作不会执行。</p></div>
        </div>
        <p v-else class="rule-guide__hint rule-guide__hint--neutral">关闭时按上方动作直接处理请求。再次开启可恢复本次编辑的响应设置。</p>
      </div>
    </details>

    <template #preview>
      <section class="rule-guide__inspector">
        <header class="rule-guide__inspector-title"><div><strong>实时执行路径</strong><small>跟随当前内容更新</small></div><span>{{ pipeline.id }}</span></header>
        <p class="rule-guide__preview"><span>当请求匹配</span><strong>{{ preview.condition }}</strong><ArrowRight :size="15" /><span>依次执行</span><strong>{{ preview.action }}</strong></p>
        <template v-if="responseEnabled">
          <p class="rule-guide__preview rule-guide__preview--response"><span>若响应匹配</span><strong>{{ responseCondition }}</strong><ArrowRight :size="15" /><span>匹配成功</span><strong>{{ successActions }}</strong></p>
          <p class="rule-guide__preview rule-guide__preview--miss"><span>否则 · 匹配失败</span><strong>{{ missActions }}</strong></p>
        </template>
        <div class="rule-guide__inspector-section"><strong>规则位置</strong><p class="rule-guide__placement" :class="{ 'rule-guide__placement--warning': existingFallback }">{{ placement }}</p><small>同一 Pipeline 中的规则按从上到下的顺序匹配。</small></div>
        <div class="rule-guide__inspector-section" aria-live="polite">
          <strong>配置检查 <span v-if="issueCount" class="rule-guide__issue-count">{{ issueCount }}</span></strong>
          <ul v-if="validationErrors.length" class="rule-guide__errors"><li v-for="error in validationErrors" :key="error">{{ error }}</li></ul>
          <p v-if="existingFallback" class="rule-guide__warning"><AlertTriangle :size="14" />请调整现有兜底规则，或为本规则添加请求条件。</p>
          <p v-if="valid" class="rule-guide__ready"><Check :size="14" />内容完整，可以{{ editing ? '保存' : '创建' }}规则</p>
        </div>
      </section>
    </template>

    <template #footer-status><span>加入编辑草稿，保存配置后生效</span></template>
    <template #actions><button class="button button--secondary" type="button" @click="emit('cancel')">取消</button><button class="button button--primary" type="submit" :disabled="!valid"><Sparkles :size="14" />{{ editing ? '保存规则' : '创建规则' }}</button></template>
  </ConfigGuideLayout>
</template>

<style scoped>
.rule-guide__step { min-width: 0; display: grid; gap: 13px; padding: 17px 20px; border-bottom: 1px solid var(--line); }
.rule-guide__step > header, .rule-guide__response-details > summary { display: flex; align-items: center; gap: 9px; }
.rule-guide__step > header > span, .rule-guide__step-number { width: 24px; height: 24px; display: grid; flex: 0 0 auto; place-items: center; color: #fff; background: var(--green); border-radius: 50%; font-size: 12px; font-weight: 750; }
.rule-guide__step > header > div, .rule-guide__response-details > summary > div { display: grid; gap: 2px; }
.rule-guide__step > header strong, .rule-guide__branch header strong, .rule-guide__response-details > summary strong { font-size: 12px; }
.rule-guide__step > header small, .rule-guide__branch header small, .rule-guide__response-details > summary small { color: var(--muted); font-size: 12px; line-height: 1.5; }
.rule-guide__step--templates { padding: 14px 20px; border-bottom: 0; }
.rule-guide__templates { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 7px; }
.rule-guide__templates button { display: grid; gap: 3px; padding: 10px; text-align: left; color: inherit; background: #fff; border: 1px solid var(--line); border-radius: 5px; cursor: pointer; }
.rule-guide__templates button:hover { border-color: #8db7a3; }
.rule-guide__templates button.is-selected { border-color: #8db7a3; background: var(--green-soft); }
.rule-guide__templates strong { display: flex; justify-content: space-between; align-items: center; gap: 4px; font-size: 14px; }
.rule-guide__templates strong > svg { flex-shrink: 0; color: var(--green); }
.rule-guide__templates small { color: var(--muted); font-size: 12px; line-height: 1.45; }
.rule-guide__name { display: grid; gap: 5px; }
.rule-guide__name > span { color: #59635f; font-size: 14px; font-weight: 650; }
.rule-guide__name > input[aria-invalid="true"] { border-color: #c97970; background: #fff9f8; }
.rule-guide__field-error { color: #a1453f; font-size: 12px; }
.rule-guide__stage-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.rule-guide__stage-title > div { display: grid; gap: 2px; }
.rule-guide__stage-title strong { font-size: 14px; }
.rule-guide__stage-title small { color: var(--muted); font-size: 12px; }
.rule-guide__stage-title select { min-width: 130px; }
.rule-guide__hint { padding: 9px 10px; color: #6c6250; background: #faf6ed; border-radius: 4px; font-size: 12px; line-height: 1.6; }
.rule-guide__hint--neutral { color: var(--muted); background: #f5f7f6; }
.rule-guide__response-details { display: block; }
.rule-guide__response-details > summary { cursor: pointer; list-style: none; }
.rule-guide__response-details > summary::-webkit-details-marker { display: none; }
.rule-guide__response-details > summary > svg { flex-shrink: 0; margin-left: auto; color: var(--muted); }
.rule-guide__response-details[open] > summary > svg { transform: rotate(180deg); }
.rule-guide__response-body { display: grid; gap: 13px; margin-top: 14px; }
.rule-guide__response-toggle { display: flex; align-items: flex-start; gap: 8px; padding: 10px; background: #f6faf8; border: 1px solid #d9e7e0; border-radius: 5px; cursor: pointer; }
.rule-guide__response-toggle.is-disabled { opacity: .65; cursor: default; }
.rule-guide__response-toggle > input { margin-top: 2px; }
.rule-guide__response-toggle > span { display: grid; gap: 2px; }
.rule-guide__response-toggle strong { font-size: 14px; }
.rule-guide__response-toggle small { color: var(--muted); font-size: 12px; line-height: 1.5; }
.rule-guide__response { display: grid; gap: 14px; padding: 12px; background: #fbfcfb; border-left: 2px solid #8db7a3; }
.rule-guide__branch { display: grid; gap: 8px; padding-top: 11px; border-top: 1px dashed var(--line); }
.rule-guide__branch header { display: grid; gap: 2px; }
.rule-guide__warning { display: flex; align-items: flex-start; gap: 5px; color: #9a5b25; font-size: 12px; line-height: 1.6; }
.rule-guide__warning > svg { flex-shrink: 0; margin-top: 1px; }
.rule-guide__inspector { display: grid; gap: 12px; min-width: 0; }
.rule-guide__inspector-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.rule-guide__inspector-title > div { display: grid; gap: 3px; }
.rule-guide__inspector-title strong { font-size: 12px; }
.rule-guide__inspector-title small, .rule-guide__inspector-section > small { color: var(--muted); font-size: 12px; line-height: 1.5; }
.rule-guide__inspector-title > span { max-width: 45%; overflow-wrap: anywhere; padding: 3px 6px; color: #397257; background: var(--green-soft); border-radius: 4px; font-size: 12px; }
.rule-guide__preview { display: grid; gap: 6px; padding: 14px; color: #68716d; background: #fff; border: 1px solid var(--line); border-radius: 7px; font-size: 12px; }
.rule-guide__preview strong { color: #35413c; font-size: 14px; font-weight: 650; line-height: 1.6; overflow-wrap: anywhere; }
.rule-guide__preview > svg { transform: rotate(90deg); color: #83a694; }
.rule-guide__preview--response { border-color: #d9e7e0; }
.rule-guide__preview--miss { border-color: #eadfd3; }
.rule-guide__inspector-section { display: grid; gap: 7px; padding-top: 13px; border-top: 1px solid var(--line); }
.rule-guide__inspector-section > strong { font-size: 14px; }
.rule-guide__placement { color: #397257; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.rule-guide__placement--warning { color: #9a5b25; }
.rule-guide__errors { display: grid; gap: 5px; padding-left: 16px; color: #a1453f; font-size: 12px; line-height: 1.5; }
.rule-guide__issue-count { padding: 1px 5px; margin-left: 3px; color: #a1453f; background: #faeeeb; border-radius: 4px; font-size: 12px; }
.rule-guide__ready { display: flex; align-items: center; gap: 5px; color: #397257; font-size: 12px; }
@media (max-width: 760px) {
  .rule-guide__step { padding-right: 14px; padding-left: 14px; }
  .rule-guide__templates { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rule-guide__response { padding: 10px; }
}
</style>
