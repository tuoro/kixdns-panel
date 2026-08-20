<script setup lang="ts">
import { ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, ArrowUpToLine, GitBranch, Pencil, Plus, Settings2, Sparkles, Trash2 } from '@lucide/vue'
import { computed, ref } from 'vue'
import { collectDnsSolutions, solutionInsertIndex, type DnsSolution, type SolutionDraft } from '../../config-editor/solution'
import { summarizeActions, summarizeMatchers } from '../../config-editor/summary'
import type { KixConfig, PipelineConfig } from '../../config-editor/types'
import SolutionGuide from './SolutionGuide.vue'

const props = defineProps<{ manualActive: boolean }>()
const config = defineModel<KixConfig>({ required: true })
const emit = defineEmits<{ manual: []; notice: [message: string] }>()
const session = ref<DnsSolution | 'create'>()
const solutions = computed(() => collectDnsSolutions(config.value))

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function solutionEntry(solution: DnsSolution): string {
  if (!solution.selector) return '无入口分流'
  return summarizeMatchers(solution.selector.matchers, solution.selector.matcher_operator, 'selector')
}

function solutionAction(solution: DnsSolution): string {
  if (!solution.pipeline) return solution.reason ?? '目标 Pipeline 不存在'
  if (solution.kind !== 'simple' || !solution.rule) return solution.reason ?? '需要手动配置'
  return summarizeActions(solution.rule.actions)
}

function moveSelector(index: number, target: number): void {
  if (target < 0 || target >= config.value.pipeline_select.length || target === index) return
  const [selector] = config.value.pipeline_select.splice(index, 1)
  if (selector) config.value.pipeline_select.splice(target, 0, selector)
}

function removeSolution(solution: DnsSolution): void {
  if (solution.selectorIndex === undefined || !solution.selector) return
  if (!window.confirm(`删除方案“${solution.selector.pipeline}”？`)) return
  const pipelineId = solution.selector.pipeline
  config.value.pipeline_select.splice(solution.selectorIndex, 1)
  if (solution.referenceCount === 1 && solution.pipelineIndex !== undefined) config.value.pipelines.splice(solution.pipelineIndex, 1)
  emit('notice', solution.referenceCount === 1 ? `方案及独立 Pipeline “${pipelineId}”已删除` : `方案已删除，共享 Pipeline “${pipelineId}”已保留`)
}

function materializePipeline(draft: SolutionDraft): PipelineConfig {
  const pipeline = clone(draft.pipeline)
  pipeline.rules = [clone(draft.rule)]
  return pipeline
}

function insertNewDraft(draft: SolutionDraft): void {
  const selector = clone(draft.selector)
  if (draft.pipelineMode !== 'reuse') {
    const pipeline = materializePipeline(draft)
    selector.pipeline = pipeline.id
    config.value.pipelines.push(pipeline)
  }
  const index = solutionInsertIndex(config.value, selector)
  config.value.pipeline_select.splice(index, 0, selector)
}

function saveDrafts(drafts: SolutionDraft[]): void {
  const editing = session.value !== 'create' ? session.value : undefined
  if (!editing) {
    for (const draft of drafts) insertNewDraft(draft)
    emit('notice', drafts.length > 1 ? `已创建 ${drafts.length} 个完整 DNS 方案` : 'DNS 方案已创建')
    session.value = undefined
    return
  }

  const draft = drafts[0]
  if (!draft || editing.selectorIndex === undefined) return
  const selector = clone(draft.selector)
  if (draft.pipelineMode === 'owned' || draft.pipelineMode === 'shared') {
    const pipelineIndex = config.value.pipelines.findIndex((pipeline) => pipeline.id === draft.existingPipelineId)
    if (pipelineIndex >= 0) {
      const pipeline = materializePipeline(draft)
      pipeline.id = draft.existingPipelineId ?? pipeline.id
      selector.pipeline = pipeline.id
      config.value.pipelines.splice(pipelineIndex, 1, pipeline)
    }
  } else if (draft.pipelineMode === 'copy') {
    const pipeline = materializePipeline(draft)
    config.value.pipelines.push(pipeline)
    selector.pipeline = pipeline.id
  }
  config.value.pipeline_select.splice(editing.selectorIndex, 1, selector)
  if (draft.pipelineMode === 'reuse' && editing.referenceCount === 1 && editing.pipelineIndex !== undefined) {
    config.value.pipelines.splice(editing.pipelineIndex, 1)
  }
  emit('notice', draft.pipelineMode === 'shared' ? '共享 Pipeline 及方案已更新' : 'DNS 方案已更新')
  session.value = undefined
}

function openManual(): void {
  emit('manual')
}
</script>

<template>
  <section class="config-section solution-section">
    <header class="config-section__header config-section__header--actions">
      <div><span class="section-mark section-mark--green"></span><h3>DNS 处理方案</h3><em>{{ solutions.length }}</em></div>
      <div class="solution-section__actions">
        <button class="button button--primary" type="button" @click="session = 'create'"><Sparkles :size="15" />一键添加方案</button>
        <button class="button button--secondary" type="button" @click="openManual"><Settings2 :size="15" />{{ manualActive ? '收起手动配置' : '手动配置' }}</button>
      </div>
    </header>
    <p class="solution-section__intro">每个方案从入口条件一直展示到处理动作和响应分支；方案仍按从上到下顺序匹配，首个命中生效。</p>

    <div class="solution-list">
      <article v-for="(solution, cardIndex) in solutions" :key="solution.key" class="solution-card" :class="`solution-card--${solution.kind}`">
        <header>
          <div class="solution-card__identity"><span><GitBranch :size="15" /></span><div><strong>{{ solution.kind === 'orphan' ? solution.pipeline?.id : `DNS 方案 #${(solution.selectorIndex ?? cardIndex) + 1}` }}</strong><small>{{ solution.kind === 'simple' ? '完整方案' : solution.kind === 'orphan' ? '未接入入口的 Pipeline' : '自定义方案' }}<template v-if="solution.referenceCount > 1"> · {{ solution.referenceCount }} 个方案共享 Pipeline</template></small></div></div>
          <div class="solution-card__tools">
            <template v-if="solution.selectorIndex !== undefined">
              <button class="icon-button icon-button--small" type="button" title="移到最前" :disabled="solution.selectorIndex === 0" @click="moveSelector(solution.selectorIndex, 0)"><ArrowUpToLine :size="14" /></button>
              <button class="icon-button icon-button--small" type="button" title="上移方案" :disabled="solution.selectorIndex === 0" @click="moveSelector(solution.selectorIndex, solution.selectorIndex - 1)"><ArrowUp :size="14" /></button>
              <button class="icon-button icon-button--small" type="button" title="下移方案" :disabled="solution.selectorIndex === config.pipeline_select.length - 1" @click="moveSelector(solution.selectorIndex, solution.selectorIndex + 1)"><ArrowDown :size="14" /></button>
              <button class="icon-button icon-button--small" type="button" title="移到最后" :disabled="solution.selectorIndex === config.pipeline_select.length - 1" @click="moveSelector(solution.selectorIndex, config.pipeline_select.length - 1)"><ArrowDownToLine :size="14" /></button>
            </template>
          </div>
        </header>

        <div class="solution-card__flow">
          <div><span>入口条件</span><strong>{{ solutionEntry(solution) }}</strong></div><ArrowRight :size="15" />
          <div><span>处理流程</span><strong>{{ solution.pipeline?.id ?? solution.selector?.pipeline }}</strong></div><ArrowRight :size="15" />
          <div><span>执行动作</span><strong>{{ solutionAction(solution) }}</strong></div>
        </div>
        <div v-if="solution.kind === 'simple' && solution.rule && (solution.rule.response_matchers.length || solution.rule.response_actions_on_match.length || solution.rule.response_actions_on_miss.length)" class="solution-card__response">
          <span>响应处理</span><strong>{{ summarizeMatchers(solution.rule.response_matchers, solution.rule.response_matcher_operator, 'response') }}</strong><ArrowRight :size="13" /><span>成功：</span><strong>{{ summarizeActions(solution.rule.response_actions_on_match) }}</strong><span>失败：</span><strong>{{ summarizeActions(solution.rule.response_actions_on_miss) }}</strong>
        </div>
        <p v-if="solution.reason" class="solution-card__reason">{{ solution.reason }}。配置会原样保留，请在手动配置中编辑。</p>
        <footer>
          <button v-if="solution.kind === 'simple'" class="button button--secondary" type="button" @click="session = solution"><Pencil :size="14" />一键编辑</button>
          <button v-else class="button button--secondary" type="button" @click="openManual"><Settings2 :size="14" />手动编辑</button>
          <button v-if="solution.selectorIndex !== undefined" class="button button--danger" type="button" @click="removeSolution(solution)"><Trash2 :size="14" />删除方案</button>
        </footer>
      </article>
      <button class="solution-list__add" type="button" @click="session = 'create'"><Plus :size="16" />一键添加 DNS 方案</button>
    </div>

    <SolutionGuide v-if="session" :config="config" :solution="session === 'create' ? undefined : session" @cancel="session = undefined" @save="saveDrafts" />
  </section>
</template>

<style scoped>
.solution-section__actions { display: flex; flex-wrap: wrap; gap: 7px; }
.solution-section__intro { padding: 0 20px 14px; color: var(--muted); font-size: 9px; line-height: 1.5; }
.solution-list { display: grid; gap: 10px; padding: 0 20px 20px; }
.solution-card { overflow: hidden; background: #fff; border: 1px solid var(--line); border-radius: 7px; }
.solution-card--simple { border-left: 3px solid var(--green); }
.solution-card--custom, .solution-card--orphan { border-left: 3px solid #bf8b36; }
.solution-card > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 12px; background: #fbfcfb; border-bottom: 1px solid var(--line); }
.solution-card__identity { display: flex; align-items: center; gap: 8px; }
.solution-card__identity > span { width: 29px; height: 29px; display: grid; place-items: center; color: var(--green); background: var(--green-soft); border-radius: 5px; }
.solution-card__identity > div { display: grid; gap: 2px; }
.solution-card__identity strong { font-size: 11px; }
.solution-card__identity small { color: var(--muted); font-size: 8px; }
.solution-card__tools { display: flex; gap: 4px; }
.solution-card__flow { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, .7fr) auto minmax(0, 1.4fr); align-items: center; gap: 9px; padding: 13px 12px; }
.solution-card__flow > div { display: grid; gap: 3px; min-width: 0; }
.solution-card__flow span, .solution-card__response span { color: var(--muted); font-size: 8px; }
.solution-card__flow strong, .solution-card__response strong { min-width: 0; overflow-wrap: anywhere; color: #35413c; font-size: 9px; font-weight: 650; }
.solution-card__response { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 0 12px 12px; padding: 9px; background: #f6faf8; border-left: 2px solid #8db7a3; }
.solution-card__reason { margin: 0 12px 12px; padding: 8px 9px; color: #8a6329; background: #fff8ee; font-size: 9px; }
.solution-card > footer { display: flex; justify-content: flex-end; gap: 7px; padding: 9px 12px; border-top: 1px solid var(--line); }
.solution-list__add { min-height: 44px; display: flex; align-items: center; justify-content: center; gap: 6px; color: var(--green); background: #fff; border: 1px dashed #a9c8b9; border-radius: 6px; cursor: pointer; font-size: 10px; font-weight: 700; }
@media (max-width: 760px) {
  .solution-section__intro, .solution-list { padding-right: 12px; padding-left: 12px; }
  .solution-card__flow { grid-template-columns: 1fr; }
  .solution-card__flow > svg { transform: rotate(90deg); }
  .solution-card > header { align-items: flex-start; }
  .solution-card__tools { display: grid; grid-template-columns: repeat(2, 1fr); }
}
</style>
