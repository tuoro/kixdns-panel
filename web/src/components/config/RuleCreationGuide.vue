<script setup lang="ts">
import { AlertTriangle, ArrowRight, Sparkles, X } from '@lucide/vue'
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
import { analyzeRuleFlow, findBlockingRule, ruleMatchesEveryRequest, summarizeActions, summarizeMatchers, summarizeRule } from '../../config-editor/summary'
import type { PipelineConfig, PipelineSelectMode, RuleConfig } from '../../config-editor/types'
import ActionList from './ActionList.vue'
import MatcherList from './MatcherList.vue'

const props = defineProps<{
  pipeline: PipelineConfig
  pipelines: PipelineConfig[]
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
const responseEnabled = ref(
  initialRule.response_matchers.length > 0
  || initialRule.response_actions_on_match.length > 0
  || initialRule.response_actions_on_miss.length > 0,
)

const hasForward = computed(() => draft.value.actions.some((action) => action.type === 'forward'))
const validationErrors = computed(() => {
  const errors = guidedRuleValidationErrors(draft.value, props.pipeline.id, props.pipelines.map((pipeline) => pipeline.id))
  if (responseEnabled.value && !hasForward.value) errors.push('响应处理需要先添加转发动作')
  if (responseEnabled.value && draft.value.response_actions_on_match.length + draft.value.response_actions_on_miss.length === 0) {
    errors.push('请至少配置一个响应分支动作')
  }
  const duplicate = props.pipeline.rules.some((rule, index) => rule.name === draft.value.name && index !== props.ruleIndex)
  if (duplicate) errors.push('规则名称已存在')
  return [...new Set(errors)]
})
const preview = computed(() => summarizeRule(draft.value))
const responseCondition = computed(() => summarizeMatchers(draft.value.response_matchers, draft.value.response_matcher_operator, 'response'))
const successActions = computed(() => summarizeActions(draft.value.response_actions_on_match))
const missActions = computed(() => summarizeActions(draft.value.response_actions_on_miss))
const insertIndex = computed(() => editing.value ? (props.ruleIndex ?? 0) : guidedRuleInsertIndexForRule(props.pipeline, draft.value))
const existingFallback = computed(() => !editing.value
  && ruleMatchesEveryRequest(draft.value)
  && !['continue', 'conditional'].includes(analyzeRuleFlow(draft.value).kind)
  ? findBlockingRule(props.pipeline, props.pipeline.rules.length)
  : undefined)
const placement = computed(() => {
  if (editing.value) return `保存到当前第 ${(props.ruleIndex ?? 0) + 1} 条，规则顺序不变`
  if (existingFallback.value) return `已有第 ${existingFallback.value.index + 1} 条终止型兜底规则“${existingFallback.value.name}”`
  if (insertIndex.value === props.pipeline.rules.length) return `放在末尾，成为第 ${insertIndex.value + 1} 条规则`
  return `放在第 ${insertIndex.value + 1} 条，位于兜底规则之前`
})
const actionWarning = computed(() => ignoredActionsAfterTerminal(draft.value.actions))
const successWarning = computed(() => ignoredActionsAfterTerminal(draft.value.response_actions_on_match, 'response'))
const missWarning = computed(() => ignoredActionsAfterTerminal(draft.value.response_actions_on_miss, 'response'))
const valid = computed(() => validationErrors.value.length === 0 && !existingFallback.value)

function applyTemplate(templateId: GuidedRuleTemplateId): void {
  selectedTemplate.value = templateId
  draft.value = createGuidedRuleFromTemplate(props.pipeline, templateId, fallbackPipeline.value)
  requestMode.value = inferMatcherMode(draft.value.matchers, draft.value.matcher_operator)
  responseMode.value = inferMatcherMode(draft.value.response_matchers, draft.value.response_matcher_operator)
  responseEnabled.value = draft.value.response_matchers.length > 0
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
  if (draft.value.response_matchers.length === 0) draft.value.response_matchers.push(createMatcher('response'))
  if (draft.value.response_actions_on_match.length === 0) draft.value.response_actions_on_match.push(createAction('log'))
}

function save(): void {
  if (!valid.value) return
  const result = cloneGuidedRule(draft.value)
  if (!responseEnabled.value) {
    result.response_matchers = []
    result.response_matcher_operator = 'and'
    result.response_actions_on_match = []
    result.response_actions_on_miss = []
  }
  emit('save', result, insertIndex.value)
}
</script>

<template>
  <Teleport to="body">
    <div class="rule-guide-overlay" @click.self="emit('cancel')">
      <section class="rule-guide" role="dialog" aria-modal="true" aria-labelledby="rule-guide-title" @keydown.esc="emit('cancel')">
        <header class="rule-guide__header">
          <div><span><Sparkles :size="14" />一键规则</span><h2 id="rule-guide-title">{{ editing ? '一键编辑规则' : '一键添加规则' }}</h2><p>从常用模板开始，也可以组合 KixDNS 支持的全部条件、动作和响应分支。</p></div>
          <button class="icon-button" type="button" aria-label="关闭一键规则" @click="emit('cancel')"><X :size="17" /></button>
        </header>

        <form class="rule-guide__body" @submit.prevent="save">
          <section v-if="!editing" class="rule-guide__step">
            <header><span>1</span><div><strong>选择一个起点</strong><small>模板只负责预填，所有内容都能继续修改</small></div></header>
            <div class="rule-guide__templates">
              <button v-for="template in GUIDED_RULE_TEMPLATES" :key="template.id" type="button" :class="{ 'is-selected': selectedTemplate === template.id }" @click="applyTemplate(template.id)"><strong>{{ template.name }}</strong><small>{{ template.description }}</small></button>
            </div>
          </section>

          <section class="rule-guide__step">
            <header><span>{{ editing ? 1 : 2 }}</span><div><strong>什么请求需要处理？</strong><small>条件可组合为全部满足、任一满足或自定义关系</small></div></header>
            <label class="rule-guide__name"><span>规则名称</span><input v-model="draft.name" aria-label="一键规则名称" type="text" placeholder="例如 cn-doh-fallback"></label>
            <div class="rule-guide__stage-title"><strong>请求条件</strong><select v-if="draft.matchers.length > 1" :value="requestMode" aria-label="一键请求条件关系" @change="setMatcherMode('request', $event)"><option value="all">全部满足</option><option value="any">任一满足</option><option value="custom">自定义组合</option></select></div>
            <MatcherList v-model="draft.matchers" scope="request" :operator-mode="draft.matchers.length > 1 && requestMode === 'custom' ? 'custom' : 'hidden'" />
            <p v-if="draft.matchers.length === 0" class="rule-guide__hint">未添加请求条件时会匹配所有请求，适合作为末尾兜底规则。</p>
          </section>

          <section class="rule-guide__step">
            <header><span>{{ editing ? 2 : 3 }}</span><div><strong>命中后依次做什么？</strong><small>动作严格按从上到下的顺序执行</small></div></header>
            <ActionList v-model="draft.actions" :pipelines="pipelines" :current-pipeline-id="pipeline.id" />
            <p v-if="actionWarning" class="rule-guide__warning"><AlertTriangle :size="14" />终止型动作之后还有 {{ actionWarning }} 个动作，不会被执行，请调整顺序。</p>
          </section>

          <section class="rule-guide__step">
            <header><span>{{ editing ? 3 : 4 }}</span><div><strong>是否根据响应继续处理？</strong><small>转发后可按响应内容分别执行成功和失败分支</small></div></header>
            <label class="rule-guide__response-toggle" :class="{ 'is-disabled': !hasForward }">
              <input :checked="responseEnabled" type="checkbox" :disabled="!hasForward" aria-label="启用响应处理" @change="toggleResponse">
              <span><strong>启用响应匹配与双分支</strong><small>{{ hasForward ? '配置响应条件，以及匹配成功和匹配失败后的动作' : '先在上一步添加转发动作' }}</small></span>
            </label>
            <div v-if="responseEnabled" class="rule-guide__response">
              <div class="rule-guide__stage-title"><div><strong>响应条件</strong><small>无条件时任意响应都算匹配成功</small></div><select v-if="draft.response_matchers.length > 1" :value="responseMode" aria-label="一键响应条件关系" @change="setMatcherMode('response', $event)"><option value="all">全部满足</option><option value="any">任一满足</option><option value="custom">自定义组合</option></select></div>
              <MatcherList v-model="draft.response_matchers" scope="response" :operator-mode="draft.response_matchers.length > 1 && responseMode === 'custom' ? 'custom' : 'hidden'" />
              <div class="rule-guide__branch"><header><strong>匹配成功</strong><small>{{ successActions }}</small></header><ActionList v-model="draft.response_actions_on_match" :pipelines="pipelines" :current-pipeline-id="pipeline.id" /><p v-if="successWarning" class="rule-guide__warning"><AlertTriangle :size="14" />终止型动作之后还有 {{ successWarning }} 个动作不会执行。</p></div>
              <div class="rule-guide__branch"><header><strong>匹配失败</strong><small>{{ missActions }}</small></header><ActionList v-model="draft.response_actions_on_miss" :pipelines="pipelines" :current-pipeline-id="pipeline.id" /><p v-if="missWarning" class="rule-guide__warning"><AlertTriangle :size="14" />终止型动作之后还有 {{ missWarning }} 个动作不会执行。</p></div>
            </div>
          </section>

          <section class="rule-guide__step rule-guide__step--confirm">
            <header><span>{{ editing ? 4 : 5 }}</span><div><strong>确认完整流程</strong><small>保存后仍可用一键编辑或手动编辑继续调整</small></div></header>
            <p class="rule-guide__preview"><span>当</span><strong>{{ preview.condition }}</strong><ArrowRight :size="14" /><span>执行</span><strong>{{ preview.action }}</strong></p>
            <template v-if="responseEnabled">
              <p class="rule-guide__preview rule-guide__preview--response"><span>若</span><strong>{{ responseCondition }}</strong><ArrowRight :size="14" /><span>匹配成功</span><strong>{{ successActions }}</strong></p>
              <p class="rule-guide__preview rule-guide__preview--miss"><span>否则</span><ArrowRight :size="14" /><span>匹配失败</span><strong>{{ missActions }}</strong></p>
            </template>
            <p class="rule-guide__placement" :class="{ 'rule-guide__placement--warning': existingFallback }">{{ placement }}</p>
            <ul v-if="validationErrors.length" class="rule-guide__errors"><li v-for="error in validationErrors" :key="error">{{ error }}</li></ul>
          </section>

          <footer><button class="button button--secondary" type="button" @click="emit('cancel')">取消</button><button class="button button--primary" type="submit" :disabled="!valid"><Sparkles :size="14" />{{ editing ? '保存规则' : '创建规则' }}</button></footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.rule-guide-overlay { position: fixed; z-index: 120; inset: 0; display: grid; place-items: center; padding: 24px; background: rgba(18, 25, 22, .48); }
.rule-guide { width: min(900px, 100%); max-height: calc(100vh - 48px); overflow: auto; color: #30383a; background: #fff; border: 1px solid #d9dfdc; border-radius: 8px; box-shadow: 0 24px 70px rgba(13, 20, 17, .24); }
.rule-guide__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 18px 20px; border-bottom: 1px solid var(--line); }
.rule-guide__header > div { display: grid; gap: 4px; }
.rule-guide__header span { display: flex; align-items: center; gap: 5px; color: var(--green); font-size: 9px; font-weight: 750; }
.rule-guide__header h2 { font-size: 17px; }
.rule-guide__header p { color: var(--muted); font-size: 10px; }
.rule-guide__body { display: grid; }
.rule-guide__step { min-width: 0; display: grid; gap: 13px; padding: 17px 20px; border-bottom: 1px solid var(--line); }
.rule-guide__step > header { display: flex; align-items: center; gap: 9px; }
.rule-guide__step > header > span { width: 24px; height: 24px; display: grid; flex: 0 0 auto; place-items: center; color: #fff; background: var(--green); border-radius: 50%; font-size: 10px; font-weight: 750; }
.rule-guide__step > header > div { display: grid; gap: 1px; }
.rule-guide__step > header strong, .rule-guide__branch header strong { font-size: 11px; }
.rule-guide__step > header small, .rule-guide__branch header small { color: var(--muted); font-size: 9px; }
.rule-guide__templates { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 7px; }
.rule-guide__templates button { display: grid; gap: 3px; padding: 10px; text-align: left; color: inherit; background: #fff; border: 1px solid var(--line); border-radius: 5px; cursor: pointer; }
.rule-guide__templates button.is-selected { border-color: #8db7a3; background: var(--green-soft); }
.rule-guide__templates strong { font-size: 10px; }
.rule-guide__templates small { color: var(--muted); font-size: 8px; line-height: 1.35; }
.rule-guide__name { display: grid; gap: 5px; }
.rule-guide__name > span { color: #59635f; font-size: 9px; font-weight: 650; }
.rule-guide__stage-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.rule-guide__stage-title > div { display: grid; gap: 2px; }
.rule-guide__stage-title strong { font-size: 10px; }
.rule-guide__stage-title small { color: var(--muted); font-size: 8px; }
.rule-guide__stage-title select { min-width: 130px; }
.rule-guide__hint { padding: 9px 10px; color: #6c6250; background: #faf6ed; border-radius: 4px; font-size: 9px; }
.rule-guide__response-toggle { display: flex; align-items: flex-start; gap: 8px; padding: 10px; background: #f6faf8; border: 1px solid #d9e7e0; border-radius: 5px; cursor: pointer; }
.rule-guide__response-toggle.is-disabled { opacity: .65; cursor: default; }
.rule-guide__response-toggle > input { margin-top: 2px; }
.rule-guide__response-toggle > span { display: grid; gap: 2px; }
.rule-guide__response-toggle strong { font-size: 10px; }
.rule-guide__response-toggle small { color: var(--muted); font-size: 9px; line-height: 1.4; }
.rule-guide__response { display: grid; gap: 14px; padding: 12px; background: #fbfcfb; border-left: 2px solid #8db7a3; }
.rule-guide__branch { display: grid; gap: 8px; padding-top: 11px; border-top: 1px dashed var(--line); }
.rule-guide__branch header { display: grid; gap: 2px; }
.rule-guide__warning { display: flex; align-items: center; gap: 5px; color: #9a5b25; font-size: 9px; }
.rule-guide__step--confirm { background: #fbfcfb; }
.rule-guide__preview { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 10px; color: #68716d; background: #fff; border: 1px solid var(--line); border-radius: 5px; font-size: 9px; }
.rule-guide__preview strong { color: #35413c; font-size: 10px; }
.rule-guide__preview--response { border-color: #d9e7e0; }
.rule-guide__preview--miss { border-color: #eadfd3; }
.rule-guide__placement { color: #397257; font-size: 9px; }
.rule-guide__placement--warning { color: #9a5b25; }
.rule-guide__errors { display: grid; gap: 3px; padding-left: 18px; color: #a1453f; font-size: 9px; }
.rule-guide__body > footer { display: flex; justify-content: flex-end; gap: 8px; padding: 13px 20px; }
@media (max-width: 760px) {
  .rule-guide-overlay { padding: 10px; }
  .rule-guide { max-height: calc(100vh - 20px); }
  .rule-guide__header, .rule-guide__step { padding-right: 14px; padding-left: 14px; }
  .rule-guide__templates { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
