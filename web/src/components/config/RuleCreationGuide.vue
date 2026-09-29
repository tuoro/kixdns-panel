<script setup lang="ts">
import { ChevronDown } from '@lucide/vue'
import { computed, nextTick, ref } from 'vue'
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
import { actionsPhrase, conditionPhrase, phrase } from '../../config-editor/phrase'
import { analyzeRuleFlow, findBlockingRule, ruleMatchesEveryRequest } from '../../config-editor/summary'
import type { PipelineConfig, PipelineSelectMode, RuleConfig } from '../../config-editor/types'
import UiSelect from '../ui/UiSelect.vue'
import ActionList from './ActionList.vue'
import ConfigGuideLayout from './ConfigGuideLayout.vue'
import MatcherList from './MatcherList.vue'
import PhraseText from './PhraseText.vue'

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
const initialRule = props.rule
  ? cloneGuidedRule(props.rule)
  : createGuidedRuleFromTemplate(props.pipeline, 'domain_upstream')
const draft = ref(initialRule)
const selectedTemplate = ref<GuidedRuleTemplateId | null>(null)
const picking = ref(!props.rule)
const showErrors = ref(false)
const body = ref<HTMLElement | null>(null)
const relationOptions = [{ value: 'all', label: '全部满足' }, { value: 'any', label: '任一满足' }, { value: 'custom', label: '自定义组合' }]
const requestMode = ref<PipelineSelectMode>(inferMatcherMode(initialRule.matchers, initialRule.matcher_operator))
const responseMode = ref<PipelineSelectMode>(inferMatcherMode(initialRule.response_matchers, initialRule.response_matcher_operator))
const responseEnabled = ref(hasResponseProcessing(initialRule))
const responseExpanded = ref(responseEnabled.value)
const effectiveRule = computed(() => withResponseState(draft.value, responseEnabled.value))
const templates = computed(() => GUIDED_RULE_TEMPLATES.filter((template) => (
  !template.requiresCapability || props.capabilities.includes(template.requiresCapability)
)))
const templateName = computed(() => GUIDED_RULE_TEMPLATES.find((template) => template.id === selectedTemplate.value)?.name ?? '')

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
// 执行路径里的地址、Pipeline ID 等宽，和别处同一个值长一个样（审计 D5） / Addresses and Pipeline IDs on the path are mono, as the same values are everywhere else (audit D5)
const preview = computed(() => ({
  condition: conditionPhrase(effectiveRule.value.matchers, effectiveRule.value.matcher_operator, 'request'),
  action: actionsPhrase(effectiveRule.value.actions),
}))
const responseCondition = computed(() => conditionPhrase(effectiveRule.value.response_matchers, effectiveRule.value.response_matcher_operator, 'response'))
const successActions = computed(() => actionsPhrase(effectiveRule.value.response_actions_on_match))
const missActions = computed(() => actionsPhrase(effectiveRule.value.response_actions_on_miss))
const insertIndex = computed(() => editing.value ? (props.ruleIndex ?? 0) : guidedRuleInsertIndexForRule(props.pipeline, effectiveRule.value))
const existingFallback = computed(() => !editing.value
  && ruleMatchesEveryRequest(effectiveRule.value)
  && !['continue', 'conditional'].includes(analyzeRuleFlow(effectiveRule.value).kind)
  ? findBlockingRule(props.pipeline, props.pipeline.rules.length)
  : undefined)
// 规则放到哪儿，一句话说完：哪个 Pipeline、第几条（审计 D6）。折起来时这一句就是执行路径那一行的摘要。
// Where the rule goes, in one line: which Pipeline and which position (audit D6). Folded, this line is the path bar's summary.
const placement = computed(() => {
  const id = props.pipeline.id
  if (editing.value) return `留在 ${id} 第 ${(props.ruleIndex ?? 0) + 1} 条`
  if (existingFallback.value) return `${id} 第 ${existingFallback.value.index + 1} 条「${existingFallback.value.name}」已经接住所有请求`
  return `插入到 ${id} 第 ${insertIndex.value + 1} 条`
})
const placementPhrase = computed(() => phrase(placement.value, [props.pipeline.id]))
// 没有字段可标的错误写在它那一组下面，底栏只留「还差 N 项」（和添加入口一样） / Errors with no field to mark sit under their group; the footer keeps only 还差 N 项 (as in 添加入口)
const groupErrors = computed(() => {
  const pick = (...messages: string[]): string[] => validationErrors.value.filter((error) => messages.some((message) => error.startsWith(message)))
  return {
    actions: pick('至少要一个动作', '当前 KixDNS 不支持固定 CNAME'),
    response: pick('响应处理需要先添加转发动作', '匹配成功或匹配失败至少要一个动作'),
  }
})
const actionWarning = computed(() => ignoredActionsAfterTerminal(effectiveRule.value.actions))
const successWarning = computed(() => ignoredActionsAfterTerminal(effectiveRule.value.response_actions_on_match, 'response'))
const missWarning = computed(() => ignoredActionsAfterTerminal(effectiveRule.value.response_actions_on_miss, 'response'))
const issueCount = computed(() => validationErrors.value.length + Number(Boolean(existingFallback.value)))
const valid = computed(() => validationErrors.value.length === 0 && !existingFallback.value)

function applyTemplate(templateId: GuidedRuleTemplateId): void {
  selectedTemplate.value = templateId
  picking.value = false
  showErrors.value = false
  draft.value = createGuidedRuleFromTemplate(props.pipeline, templateId)
  requestMode.value = inferMatcherMode(draft.value.matchers, draft.value.matcher_operator)
  responseMode.value = inferMatcherMode(draft.value.response_matchers, draft.value.response_matcher_operator)
  responseEnabled.value = hasResponseProcessing(draft.value)
  responseExpanded.value = responseEnabled.value
}

function setMatcherMode(stage: 'request' | 'response', value: string): void {
  const mode = value as PipelineSelectMode
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

// 提交时没填完：标出缺的字段并聚焦第一个（规范 8.4） / Incomplete on submit: mark and focus the first gap (spec 8.4)
async function revealErrors(): Promise<void> {
  showErrors.value = true
  await nextTick()
  const target = body.value?.querySelector<HTMLElement>('[aria-invalid="true"], .rule-guide__group-error')
  if (!target) return
  // 出错的字段在收起的响应处理里：先打开，焦点才落得上去 / The field sits in the folded 响应处理: open it first, or focus cannot land
  const folded = target.closest('details')
  if (folded && !folded.open) {
    folded.open = true
    await nextTick()
  }
  if (target.matches('[aria-invalid="true"]')) target.focus()
  target.scrollIntoView({ block: 'nearest' })
}

function save(): void {
  if (!valid.value) {
    void revealErrors()
    return
  }
  emit('save', cloneGuidedRule(effectiveRule.value), insertIndex.value)
}
</script>

<template>
  <ConfigGuideLayout :title="editing ? '一键编辑规则' : '一键添加规则'" close-label="关闭一键规则" :summary="placement" :show-preview="!picking" :show-footer="!picking" :compact="picking" @cancel="emit('cancel')" @submit="save">
    <div ref="body" class="rule-guide">
      <!-- 起点：先不选，选了收成一行（规范 3.6） / The start: nothing chosen at first, one line once chosen (spec 3.6) -->
      <section v-if="!editing" class="rule-guide__group">
        <div v-if="picking" class="ui-pick" role="radiogroup" aria-label="起点">
          <label v-for="template in templates" :key="template.id" class="ui-pick__opt">
            <input type="radio" name="rule-guide-template" :checked="selectedTemplate === template.id" @change="applyTemplate(template.id)">
            <b>{{ template.name }}</b><small><PhraseText :phrase="phrase(template.description, template.values ?? [])" /></small>
          </label>
        </div>
        <div v-else class="ui-picked">起点<b>{{ templateName }}</b><button class="ui-btn ui-btn--text ui-btn--sm ui-picked__change" type="button" @click="picking = true">更换</button></div>
      </section>

      <template v-if="!picking">
        <div class="rule-guide__field">
          <span>规则名称</span>
          <label class="ui-input"><input v-model="draft.name" class="mono" aria-label="一键规则名称" :aria-invalid="showErrors && Boolean(nameError) || undefined" :aria-describedby="showErrors && nameError ? 'guided-rule-name-error' : undefined" type="text" placeholder="cn-doh-fallback"></label>
          <p v-if="showErrors && nameError" id="guided-rule-name-error" class="ui-field-error field-error">{{ nameError }}</p>
        </div>

        <section class="rule-guide__group">
          <h3 class="rule-guide__title">匹配哪些请求<UiSelect v-if="draft.matchers.length > 1" :model-value="requestMode" size="sm" class="rule-guide__relation" :options="relationOptions" label="一键请求条件关系" @update:model-value="setMatcherMode('request', $event)" /></h3>
          <MatcherList v-model="draft.matchers" scope="request" :show-errors="showErrors" :operator-mode="draft.matchers.length > 1 && requestMode === 'custom' ? 'custom' : 'hidden'" />
          <p v-if="draft.matchers.length === 0" class="rule-guide__note">没有条件时匹配所有请求，适合放在最后兜底。</p>
        </section>

        <section class="rule-guide__group">
          <h3 class="rule-guide__title">如何处理请求</h3>
          <ActionList v-model="draft.actions" :pipelines="pipelines" :current-pipeline-id="pipeline.id" :capabilities="capabilities" :show-errors="showErrors" />
          <p v-if="actionWarning" class="ui-field-error">终止型动作后面还有 {{ actionWarning }} 个动作不会执行，请调整顺序。</p>
          <p v-for="error in showErrors ? groupErrors.actions : []" :key="error" class="ui-field-error rule-guide__group-error">{{ error }}</p>
        </section>

        <details class="rule-guide__group rule-guide__response-details ui-expand" :open="responseExpanded" @toggle="responseExpanded = ($event.currentTarget as HTMLDetailsElement).open">
          <summary class="rule-guide__title rule-guide__summary" aria-label="响应处理设置"><span>响应处理<small>{{ responseEnabled ? (draft.response_matchers.length ? `${draft.response_matchers.length} 个条件` : '已启用') : '未设置' }}</small></span><ChevronDown :size="16" aria-hidden="true" /></summary>
          <div class="rule-guide__fields">
            <label class="rule-guide__switch">
              <span>按上游的响应继续处理<small v-if="!hasForward && !responseEnabled">先添加一个转发动作</small></span>
              <span class="ui-switch"><input :checked="responseEnabled" type="checkbox" role="switch" :disabled="!hasForward && !responseEnabled" aria-label="启用响应处理" @change="toggleResponse"><i aria-hidden="true"></i></span>
            </label>
            <div v-if="responseEnabled" class="rule-guide__response">
              <h4 class="rule-guide__subtitle">响应条件<UiSelect v-if="draft.response_matchers.length > 1" :model-value="responseMode" size="sm" class="rule-guide__relation" :options="relationOptions" label="一键响应条件关系" @update:model-value="setMatcherMode('response', $event)" /></h4>
              <MatcherList v-model="draft.response_matchers" scope="response" :show-errors="showErrors" :operator-mode="draft.response_matchers.length > 1 && responseMode === 'custom' ? 'custom' : 'hidden'" />
              <h4 class="rule-guide__subtitle">匹配成功</h4>
              <ActionList v-model="draft.response_actions_on_match" :pipelines="pipelines" :current-pipeline-id="pipeline.id" :capabilities="capabilities" :show-errors="showErrors" />
              <p v-if="successWarning" class="ui-field-error">终止型动作后面还有 {{ successWarning }} 个动作不会执行。</p>
              <h4 class="rule-guide__subtitle">匹配失败</h4>
              <ActionList v-model="draft.response_actions_on_miss" :pipelines="pipelines" :current-pipeline-id="pipeline.id" :capabilities="capabilities" :show-errors="showErrors" />
              <p v-if="missWarning" class="ui-field-error">终止型动作后面还有 {{ missWarning }} 个动作不会执行。</p>
            </div>
            <p v-for="error in showErrors ? groupErrors.response : []" :key="error" class="ui-field-error rule-guide__group-error">{{ error }}</p>
          </div>
        </details>
      </template>
    </div>

    <!-- 收起的执行路径那一行也用同一句：default 等宽（审计第二轮 D7） / The folded path line uses the same phrase, default in mono (audit round 2, D7) -->
    <template #summary><PhraseText :phrase="placementPhrase" /></template>
    <template #preview>
      <section class="rule-guide__path" aria-live="polite">
        <h3 class="rule-guide__subtitle">执行路径</h3>
        <ol class="rule-guide__steps">
          <li><span>当请求匹配</span><strong><PhraseText :phrase="preview.condition" /></strong></li>
          <li><span>依次执行</span><strong><PhraseText :phrase="preview.action" /></strong></li>
          <template v-if="responseEnabled">
            <li><span>若响应匹配</span><strong><PhraseText :phrase="responseCondition" /></strong></li>
            <li><span>匹配成功</span><strong><PhraseText :phrase="successActions" /></strong></li>
            <li><span>匹配失败</span><strong><PhraseText :phrase="missActions" /></strong></li>
          </template>
        </ol>
        <p class="rule-guide__placement" :class="{ 'rule-guide__placement--blocked': existingFallback }"><PhraseText :phrase="placementPhrase" /></p>
        <p v-if="existingFallback" class="rule-guide__caution">先调整那条兜底规则，或者给这条规则加上请求条件。</p>
      </section>
    </template>

    <template #status>
      <button v-if="issueCount" class="ui-tag ui-tag--strong rule-guide__missing" type="button" @click="revealErrors">还差 {{ issueCount }} 项</button>
    </template>
    <template #actions><button class="ui-btn ui-btn--text" type="button" @click="emit('cancel')">取消</button><button class="ui-btn ui-btn--primary" type="submit">{{ editing ? '保存规则' : '创建规则' }}</button></template>
  </ConfigGuideLayout>
</template>

<style scoped>
/* 一键规则对话框：和检查器同一种组（规范 3.4–3.6），右边一栏是执行路径和规则位置。只用 tokens.css 的变量。
   The one-click rule dialog: the inspector's groups (spec 3.4–3.6) with the path and placement on the right. Tokens only. */
.rule-guide { display: grid; gap: var(--s-5); padding: var(--s-5); }
.rule-guide__group { display: grid; gap: var(--s-3); min-width: 0; }
.rule-guide__title { margin: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--s-2); color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-bold); }
.rule-guide__title small { color: var(--l-ink-2); font-size: var(--t-2); font-weight: var(--w-normal); line-height: 1; }
.rule-guide__subtitle { margin: var(--s-2) 0 0; display: flex; align-items: center; justify-content: space-between; gap: var(--s-2); color: var(--l-ink-2); font-size: var(--t-2); font-weight: var(--w-bold); }
.rule-guide__subtitle code { color: var(--l-ink-2); font-size: var(--t-1); font-weight: var(--w-normal); }
.rule-guide__relation { width: 8rem; }
/* 带「任一满足」的标题行也让出 × 那一列：选择框和上下的字段、开关在同一条右边线结束（审计第二轮 D5）
   A title row holding 任一满足 leaves the × column free too, so the select ends on the fields' and switch's right edge (audit round 2, D5) */
:is(.rule-guide__title, .rule-guide__subtitle):has(> .rule-guide__relation) { padding-inline-end: calc(var(--rows-act) + var(--s-2)); }
/* 规则名称和子项的字段在同一条右边线结束：让出 × 那一列（审计 D9） / The rule name ends on the sub-item fields' right edge, leaving the × column free (audit D9) */
.rule-guide__field { display: grid; gap: var(--s-2); padding-inline-end: calc(var(--rows-act) + var(--s-2)); }
.rule-guide__field > span:first-child { color: var(--l-ink-2); font-size: var(--t-2); }
/* 字段名离自己的框 4 近，和检查器的「规则名称」、子项里上下排的「分类」「上游」一样；框和它的错误之间还是 8（审计第五轮 A1、第六轮 D1）
   The label comes 4 closer to its box, as the inspector's 规则名称 and the stacked 分类 and 上游; a box keeps 8 to its error (audit round 5 A1, round 6 D1) */
.rule-guide__field > span:first-child { margin-bottom: calc(var(--s-1) - var(--s-2)); }
.rule-guide__summary { list-style: none; cursor: pointer; }
.rule-guide__summary::-webkit-details-marker { display: none; }
.rule-guide__summary > span { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--s-2); min-width: 0; }
/* 折叠箭头居中在 × 那一列里 / The chevron centres in the × column */
.rule-guide__summary > svg { flex: 0 0 auto; margin-inline: calc((var(--rows-act) - var(--size-icon)) / 2); color: var(--l-ink-3); transition: transform var(--m-base) var(--ease-out); }
details[open] > .rule-guide__summary > svg { transform: rotate(180deg); }
details.rule-guide__group { gap: 0; }
details.rule-guide__group[open] > .rule-guide__fields { margin-top: var(--s-3); }
.rule-guide__fields { display: grid; gap: var(--s-3); }
.rule-guide__switch { padding-inline-end: calc(var(--rows-act) + var(--s-2)); }
.rule-guide__switch { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); color: var(--l-ink); font-size: var(--t-3); cursor: pointer; }
.rule-guide__switch small { display: block; color: var(--l-ink-3); font-size: var(--t-1); }
.rule-guide__response { display: grid; gap: var(--s-3); }
.rule-guide__note { margin: 0; color: var(--l-ink-3); font-size: var(--t-1); }
.rule-guide__path { display: grid; gap: var(--s-3); min-width: 0; }
/* 「执行路径」和左边的「起点」行都只有一行字高、从同一条上边开始，两栏第一行对齐（审计第三轮 D5、B2：「更换」往回收以后起点行不再是 30 高）
   执行路径 and the 起点 row on the left are both one line tall from the same top edge, so both columns' first lines align
   (audit round 3, D5 and B2: with 更换 pulled back the 起点 row is no longer 30 tall) */
/* 「执行路径」是这一栏的组标题：14 · 600 · 墨色，和左边的「匹配哪些请求」一样，不比下面的值还浅（规范第 1 节，审计第四轮 D7）
   执行路径 titles this column: 14 · 600 · ink like 匹配哪些请求 on the left, never lighter than the values under it (spec section 1, audit round 4, D7) */
.rule-guide__path > .rule-guide__subtitle { margin: 0; color: var(--l-ink); font-size: var(--t-3); }
.rule-guide__steps { display: grid; gap: var(--s-2); margin: 0; padding: 0; list-style: none; }
.rule-guide__steps li { display: grid; gap: 2px; }
/* 只选步骤名那一格：写成 span 会连执行路径里的句子（PhraseText 的 span）一起变成注释（审计第三轮 D1）
   Only the step-name cell: a bare span would also catch the path's sentences (PhraseText's spans) and turn them into notes (audit round 3, D1) */
.rule-guide__steps li > span { color: var(--l-ink-3); font-size: var(--t-1); }
.rule-guide__steps strong { color: var(--l-ink); font-size: var(--t-2); font-weight: var(--w-medium); overflow-wrap: anywhere; }
.rule-guide__placement { margin: 0; color: var(--l-ink-2); font-size: var(--t-2); }
.rule-guide__placement--blocked { color: var(--err-l); }
.rule-guide__caution { margin: 0; color: var(--l-ink-2); font-size: var(--t-2); }
.rule-guide__missing { cursor: pointer; }
/* 中文只在标点和空格处换行（审计第三轮 B6） / CJK breaks only at punctuation and spaces (audit round 3, B6) */
.rule-guide__group-error { margin: 0; word-break: keep-all; overflow-wrap: anywhere; }
/* 对话框在 641–860 仍是浮起的一栏，内边距 24；16 只给手机（规范 6.4，审计第二轮 D6） / The dialog still floats at 641–860 with a 24 inset; 16 is for phones only (spec 6.4, audit round 2, D6) */
@media (max-width: 640px) {
  .rule-guide { padding: var(--s-4); }
  /* 「响应处理」这个折叠行手机上也是 44，多出来的上下收回去，字不动（规范 2.1，审计第六轮 A4） / The 响应处理 fold row is 44 on a phone too, pulled back so the text stays put (spec 2.1, audit round 6, A4) */
  .rule-guide__summary { min-height: var(--h-touch); margin-block: calc((1lh - var(--h-touch)) / 2); }
}
@media (prefers-reduced-motion: reduce) { .rule-guide__summary > svg { transition: none; } }
</style>
