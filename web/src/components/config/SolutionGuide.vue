<script setup lang="ts">
import { ArrowRight, Sparkles, X } from '@lucide/vue'
import { computed, ref } from 'vue'
import {
  SOLUTION_TEMPLATES,
  cloneSolutionDraft,
  createDraftFromSolution,
  createSolutionDrafts,
  solutionValidationErrors,
  type DnsSolution,
  type SolutionDraft,
  type SolutionPipelineMode,
  type SolutionTemplateId,
} from '../../config-editor/solution'
import { applyMatcherMode, createAction, createMatcher, inferMatcherMode, nextPipelineId } from '../../config-editor/model'
import { CONFIG_STATIC_CNAME_RESPONSE_V1 } from '../../config-editor/schema'
import { summarizeActions, summarizeMatchers } from '../../config-editor/summary'
import type { KixConfig, PipelineSelectMode } from '../../config-editor/types'
import ActionList from './ActionList.vue'
import DomainMappingTable from './DomainMappingTable.vue'
import MatcherList from './MatcherList.vue'

const props = defineProps<{ config: KixConfig; capabilities: string[]; solution?: DnsSolution }>()
const emit = defineEmits<{ cancel: []; save: [drafts: SolutionDraft[]] }>()

const editing = computed(() => props.solution !== undefined)
const initial = props.solution ? createDraftFromSolution(props.solution, props.config) : undefined
const drafts = ref<SolutionDraft[]>(initial ? [initial] : createSolutionDrafts(props.config, 'domestic_global'))
const selectedTemplate = ref<SolutionTemplateId>(props.solution?.groupType ?? 'domestic_global')
const activeIndex = ref(0)
const draft = computed(() => drafts.value[activeIndex.value]!)
const mappingMode = computed(() => draft.value.groupType === 'domain_mapping')
const selectorMode = ref<PipelineSelectMode>('all')
const responseMode = ref<PipelineSelectMode>('all')
const responseEnabled = ref(false)
const templates = computed(() => SOLUTION_TEMPLATES.filter((template) => (
  template.id !== 'domain_mapping'
  && (!template.requiresCapability || props.capabilities.includes(template.requiresCapability))
)))

function syncModes(): void {
  selectorMode.value = inferMatcherMode(draft.value.selector.matchers, draft.value.selector.matcher_operator)
  responseMode.value = inferMatcherMode(draft.value.rule.response_matchers, draft.value.rule.response_matcher_operator)
  responseEnabled.value = draft.value.rule.response_matchers.length > 0
    || draft.value.rule.response_actions_on_match.length > 0
    || draft.value.rule.response_actions_on_miss.length > 0
}
syncModes()

const pipelines = computed(() => {
  const result = props.config.pipelines.map((pipeline) => ({ ...pipeline }))
  for (const item of drafts.value) {
    if (item.pipelineMode === 'reuse') continue
    const index = result.findIndex((pipeline) => pipeline.id === item.pipeline.id)
    if (index >= 0) result[index] = item.pipeline
    else result.push(item.pipeline)
  }
  return result
})
const allErrors = computed(() => drafts.value.flatMap((item, index) => solutionValidationErrors(
  item,
  props.config,
  props.solution?.selectorIndex,
  drafts.value.filter((_, candidate) => candidate !== index).map((candidate) => candidate.pipeline.id),
)).concat(drafts.value.some((item) => [
  ...item.rule.actions,
  ...item.rule.response_actions_on_match,
  ...item.rule.response_actions_on_miss,
].some((action) => action.type === 'static_cname_response'))
  && !props.capabilities.includes(CONFIG_STATIC_CNAME_RESPONSE_V1)
  ? ['当前 KixDNS 不支持固定 CNAME，请先更新或切换内核']
  : []))
const valid = computed(() => allErrors.value.length === 0)
const preview = computed(() => ({
  entry: summarizeMatchers(draft.value.selector.matchers, draft.value.selector.matcher_operator, 'selector'),
  action: summarizeActions(draft.value.rule.actions),
  response: summarizeMatchers(draft.value.rule.response_matchers, draft.value.rule.response_matcher_operator, 'response'),
}))
const canUseResponse = computed(() => draft.value.rule.actions.some((action) => action.type === 'forward'))
const sharedEdit = computed(() => editing.value && (props.solution?.referenceCount ?? 0) > 1)

function applyTemplate(templateId: SolutionTemplateId): void {
  selectedTemplate.value = templateId
  drafts.value = createSolutionDrafts(props.config, templateId)
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
  if (!responseEnabled.value) return
  if (draft.value.rule.response_matchers.length === 0) draft.value.rule.response_matchers.push(createMatcher('response'))
  if (draft.value.rule.response_actions_on_match.length === 0) draft.value.rule.response_actions_on_match.push(createAction('log'))
}

function changePipelineMode(event: Event): void {
  const mode = (event.currentTarget as HTMLSelectElement).value as SolutionPipelineMode
  const item = draft.value
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
  item.pipeline = JSON.parse(JSON.stringify(original))
  item.rule = JSON.parse(JSON.stringify(props.solution?.rule))
  item.pipelineMode = mode
  if (mode === 'copy') item.pipeline.id = nextPipelineId(props.config, `${original.id}-copy`)
  item.selector.pipeline = item.pipeline.id
}

function selectExistingPipeline(event: Event): void {
  draft.value.selector.pipeline = (event.currentTarget as HTMLSelectElement).value
}

function save(): void {
  if (!valid.value) return
  const result = drafts.value.map(cloneSolutionDraft)
  for (const item of result) {
    if (!responseEnabled.value && result.length === 1) {
      item.rule.response_matchers = []
      item.rule.response_matcher_operator = 'and'
      item.rule.response_actions_on_match = []
      item.rule.response_actions_on_miss = []
    }
  }
  emit('save', result)
}
</script>

<template>
  <Teleport to="body">
    <div class="solution-guide-overlay" @click.self="emit('cancel')">
      <section class="solution-guide" role="dialog" aria-modal="true" aria-labelledby="solution-guide-title" @keydown.esc="emit('cancel')">
        <header class="solution-guide__header">
          <div><span><Sparkles :size="14" />一键方案</span><h2 id="solution-guide-title">{{ editing ? '一键编辑 DNS 方案' : '一键添加 DNS 方案' }}</h2><p>在一处完成入口条件、处理动作和响应分支，保存后按方案顺序生效。</p></div>
          <button class="icon-button" type="button" aria-label="关闭一键方案" @click="emit('cancel')"><X :size="17" /></button>
        </header>

        <form class="solution-guide__body" @submit.prevent="save">
          <section v-if="!editing" class="solution-guide__step">
            <header><span>1</span><div><strong>选择常用方案</strong><small>模板只负责预填，下面每一项仍可修改</small></div></header>
            <div class="solution-guide__templates">
              <button v-for="template in templates" :key="template.id" type="button" :class="{ 'is-selected': selectedTemplate === template.id }" @click="applyTemplate(template.id)"><strong>{{ template.name }}</strong><small>{{ template.description }}</small></button>
            </div>
          </section>

          <nav v-if="drafts.length > 1" class="solution-guide__tabs" aria-label="方案组成">
            <button v-for="(item, index) in drafts" :key="item.pipeline.id" type="button" :class="{ 'is-selected': activeIndex === index }" @click="selectDraft(index)">{{ index === 0 ? '国内解析' : '全局兜底' }}</button>
          </nav>

          <section v-if="!mappingMode" class="solution-guide__step">
            <header><span>{{ editing ? 1 : 2 }}</span><div><strong>哪些请求进入这个方案？</strong><small>多个方案仍按页面中的顺序匹配，首个命中生效</small></div></header>
            <div class="solution-guide__stage-title"><strong>入口条件</strong><select v-if="draft.selector.matchers.length > 1" :value="selectorMode" aria-label="入口条件关系" @change="setMode('selector', $event)"><option value="all">全部满足</option><option value="any">任一满足</option><option value="custom">自定义组合</option></select></div>
            <MatcherList v-model="draft.selector.matchers" scope="selector" :operator-mode="draft.selector.matchers.length > 1 && selectorMode === 'custom' ? 'custom' : 'hidden'" />
            <p v-if="selectedTemplate === 'domain_upstream' || selectedTemplate === 'ad_block' || selectedTemplate === 'client_network'" class="solution-guide__hint">多个条件使用同一处理方式时，直接继续添加条件并选择“任一满足”，仍只会创建一张方案卡片。</p>
            <p v-if="draft.selector.matchers.length === 0" class="solution-guide__hint">未添加入口条件时匹配任意请求，应放在全部方案的最后作为兜底。</p>
          </section>

          <section v-else class="solution-guide__step">
            <header><span>{{ editing ? 1 : 2 }}</span><div><strong>维护域名映射表</strong><small>一张方案可以包含多条映射，面板会自动生成入口条件和内部规则</small></div></header>
            <DomainMappingTable v-model="draft.mappingRows!" />
          </section>

          <section class="solution-guide__step">
            <header><span>{{ editing ? 2 : 3 }}</span><div><strong>进入哪个处理流程？</strong><small>默认创建独立 Pipeline；也可以明确复用现有流程</small></div></header>
            <label v-if="!editing && !mappingMode" class="solution-guide__field"><span>流程方式</span><select :value="draft.pipelineMode" aria-label="流程方式" @change="changePipelineMode"><option value="new">创建独立 Pipeline</option><option value="reuse">复用现有 Pipeline</option></select></label>
            <label v-else-if="sharedEdit" class="solution-guide__field"><span>共享流程</span><select :value="draft.pipelineMode" aria-label="共享流程处理方式" @change="changePipelineMode"><option value="copy">复制为独立 Pipeline（推荐）</option><option value="shared">修改共享 Pipeline（影响其他方案）</option><option v-if="!mappingMode" value="reuse">改用其他现有 Pipeline</option></select></label>
            <p v-if="sharedEdit && draft.pipelineMode === 'shared'" class="solution-guide__warning">当前 Pipeline 被 {{ solution?.referenceCount }} 个方案共用，保存会同时改变它们。</p>
            <label v-if="draft.pipelineMode === 'reuse'" class="solution-guide__field"><span>现有 Pipeline</span><select :value="draft.selector.pipeline" aria-label="现有 Pipeline" @change="selectExistingPipeline"><option disabled value="">请选择</option><option v-for="item in config.pipelines" :key="item.id" :value="item.id">{{ item.id }}</option></select></label>
            <template v-else>
              <label class="solution-guide__field"><span>Pipeline ID</span><input v-model="draft.pipeline.id" :readonly="draft.pipelineMode === 'owned' || draft.pipelineMode === 'shared'" aria-label="方案 Pipeline ID" @input="draft.selector.pipeline = draft.pipeline.id"></label>
              <label class="solution-guide__field"><span>规则名称</span><input v-model="draft.rule.name" aria-label="方案规则名称"></label>
            </template>
          </section>

          <template v-if="draft.pipelineMode !== 'reuse' && !mappingMode">
            <section class="solution-guide__step">
              <header><span>{{ editing ? 3 : 4 }}</span><div><strong>依次执行什么动作？</strong><small>动作严格按从上到下的顺序执行</small></div></header>
              <ActionList v-model="draft.rule.actions" :pipelines="pipelines" :current-pipeline-id="draft.pipeline.id" :capabilities="capabilities" />
            </section>

            <section class="solution-guide__step">
              <header><span>{{ editing ? 4 : 5 }}</span><div><strong>是否根据响应继续处理？</strong><small>转发后可按响应内容分别执行成功与失败分支</small></div></header>
              <label class="solution-guide__response-toggle" :class="{ 'is-disabled': !canUseResponse }"><input :checked="responseEnabled" type="checkbox" :disabled="!canUseResponse" aria-label="启用方案响应处理" @change="toggleResponse"><span><strong>启用响应匹配与双分支</strong><small>{{ canUseResponse ? '配置响应条件及两个分支的后续动作' : '先添加转发动作' }}</small></span></label>
              <div v-if="responseEnabled" class="solution-guide__response">
                <div class="solution-guide__stage-title"><strong>响应条件</strong><select v-if="draft.rule.response_matchers.length > 1" :value="responseMode" aria-label="响应条件关系" @change="setMode('response', $event)"><option value="all">全部满足</option><option value="any">任一满足</option><option value="custom">自定义组合</option></select></div>
                <MatcherList v-model="draft.rule.response_matchers" scope="response" :operator-mode="draft.rule.response_matchers.length > 1 && responseMode === 'custom' ? 'custom' : 'hidden'" />
                <div class="solution-guide__branch"><strong>匹配成功</strong><ActionList v-model="draft.rule.response_actions_on_match" :pipelines="pipelines" :current-pipeline-id="draft.pipeline.id" :capabilities="capabilities" /></div>
                <div class="solution-guide__branch"><strong>匹配失败</strong><ActionList v-model="draft.rule.response_actions_on_miss" :pipelines="pipelines" :current-pipeline-id="draft.pipeline.id" :capabilities="capabilities" /></div>
              </div>
            </section>
          </template>

          <section class="solution-guide__step solution-guide__step--confirm">
            <header><span>{{ editing ? 5 : 6 }}</span><div><strong>确认完整路径</strong><small>{{ drafts.length > 1 ? `当前查看第 ${activeIndex + 1} 个，共 ${drafts.length} 个` : '保存后仍可一键编辑或进入自由编辑' }}</small></div></header>
            <p v-if="mappingMode" class="solution-guide__preview"><strong>{{ draft.mappingRows?.length ?? 0 }} 条域名映射</strong><ArrowRight :size="14" /><strong>{{ draft.pipeline.id }}</strong><ArrowRight :size="14" /><strong>按源域名返回对应 CNAME</strong></p>
            <p v-else class="solution-guide__preview"><strong>{{ preview.entry }}</strong><ArrowRight :size="14" /><strong>{{ draft.selector.pipeline }}</strong><ArrowRight :size="14" /><strong>{{ draft.pipelineMode === 'reuse' ? '复用该流程' : preview.action }}</strong></p>
            <p v-if="responseEnabled && draft.pipelineMode !== 'reuse'" class="solution-guide__preview"><span>响应：</span><strong>{{ preview.response }}</strong><ArrowRight :size="14" /><strong>{{ summarizeActions(draft.rule.response_actions_on_match) }}</strong><span>；否则</span><strong>{{ summarizeActions(draft.rule.response_actions_on_miss) }}</strong></p>
            <ul v-if="allErrors.length" class="solution-guide__errors"><li v-for="error in [...new Set(allErrors)]" :key="error">{{ error }}</li></ul>
          </section>

          <footer><button class="button button--secondary" type="button" @click="emit('cancel')">取消</button><button class="button button--primary" type="submit" :disabled="!valid"><Sparkles :size="14" />{{ editing ? '保存方案' : drafts.length > 1 ? `创建 ${drafts.length} 个方案` : '创建方案' }}</button></footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.solution-guide-overlay { position: fixed; z-index: 120; inset: 0; display: grid; place-items: center; padding: 24px; background: rgba(18, 25, 22, .48); }
.solution-guide { width: min(920px, 100%); max-height: calc(100vh - 48px); overflow: auto; color: #30383a; background: #fff; border: 1px solid #d9dfdc; border-radius: 8px; box-shadow: 0 24px 70px rgba(13, 20, 17, .24); }
.solution-guide__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 18px 20px; border-bottom: 1px solid var(--line); }
.solution-guide__header > div { display: grid; gap: 4px; }
.solution-guide__header span { display: flex; align-items: center; gap: 5px; color: var(--green); font-size: 9px; font-weight: 750; }
.solution-guide__header h2 { font-size: 17px; }
.solution-guide__header p, .solution-guide__step small { color: var(--muted); font-size: 9px; }
.solution-guide__body { display: grid; }
.solution-guide__step { min-width: 0; display: grid; gap: 13px; padding: 17px 20px; border-bottom: 1px solid var(--line); }
.solution-guide__step > header { display: flex; align-items: center; gap: 9px; }
.solution-guide__step > header > span { width: 24px; height: 24px; display: grid; flex: 0 0 auto; place-items: center; color: #fff; background: var(--green); border-radius: 50%; font-size: 10px; font-weight: 750; }
.solution-guide__step > header > div { display: grid; gap: 1px; }
.solution-guide__step strong { font-size: 10px; }
.solution-guide__templates { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 7px; }
.solution-guide__templates button { display: grid; gap: 3px; padding: 10px; text-align: left; color: inherit; background: #fff; border: 1px solid var(--line); border-radius: 5px; cursor: pointer; }
.solution-guide__templates button.is-selected, .solution-guide__tabs button.is-selected { border-color: #8db7a3; background: var(--green-soft); }
.solution-guide__templates small { line-height: 1.35; }
.solution-guide__tabs { display: flex; gap: 6px; padding: 10px 20px; border-bottom: 1px solid var(--line); }
.solution-guide__tabs button { padding: 7px 12px; color: inherit; background: #fff; border: 1px solid var(--line); border-radius: 5px; cursor: pointer; }
.solution-guide__field { display: grid; grid-template-columns: 120px minmax(0, 1fr); align-items: center; gap: 8px; }
.solution-guide__field > span { color: #59635f; font-size: 9px; font-weight: 650; }
.solution-guide__stage-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.solution-guide__hint { padding: 9px 10px; color: #6c6250; background: #faf6ed; border-radius: 4px; font-size: 9px; }
.solution-guide__warning { padding: 9px 10px; color: #9a5b25; background: #fff8ee; border-radius: 4px; font-size: 9px; }
.solution-guide__response-toggle { display: flex; align-items: flex-start; gap: 8px; padding: 10px; background: #f6faf8; border: 1px solid #d9e7e0; border-radius: 5px; cursor: pointer; }
.solution-guide__response-toggle.is-disabled { opacity: .65; cursor: default; }
.solution-guide__response-toggle > span { display: grid; gap: 2px; }
.solution-guide__response { display: grid; gap: 14px; padding: 12px; background: #fbfcfb; border-left: 2px solid #8db7a3; }
.solution-guide__branch { display: grid; gap: 8px; padding-top: 11px; border-top: 1px dashed var(--line); }
.solution-guide__step--confirm { background: #fbfcfb; }
.solution-guide__preview { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 10px; color: #68716d; background: #fff; border: 1px solid var(--line); border-radius: 5px; font-size: 9px; }
.solution-guide__preview strong { color: #35413c; }
.solution-guide__errors { display: grid; gap: 3px; padding-left: 18px; color: #a1453f; font-size: 9px; }
.solution-guide__body > footer { display: flex; justify-content: flex-end; gap: 8px; padding: 13px 20px; }
@media (max-width: 760px) {
  .solution-guide-overlay { padding: 10px; }
  .solution-guide { max-height: calc(100vh - 20px); }
  .solution-guide__header, .solution-guide__step { padding-right: 14px; padding-left: 14px; }
  .solution-guide__templates { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .solution-guide__field { grid-template-columns: 1fr; }
}
</style>
