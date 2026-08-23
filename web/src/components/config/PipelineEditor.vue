<script setup lang="ts">
import { AlertTriangle, ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, ArrowUpToLine, ChevronDown, ChevronUp, FoldVertical, GitBranch, Plus, Sparkles, Trash2, UnfoldVertical } from '@lucide/vue'
import { computed, ref } from 'vue'
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
import type { KixConfig, MatcherConfig, PipelineConfig, PipelineSelectConfig, PipelineSelectMode, RuleConfig } from '../../config-editor/types'
import { analyzeRuleFlow, findBlockingRule, summarizeRule } from '../../config-editor/summary'
import ActionList from './ActionList.vue'
import DnsSolutionEditor from './DnsSolutionEditor.vue'
import MatcherList from './MatcherList.vue'
import RuleCreationGuide from './RuleCreationGuide.vue'

const config = defineModel<KixConfig>({ required: true })
defineProps<{ capabilities: string[] }>()
const emit = defineEmits<{ notice: [message: string] }>()
const pipelineIds = computed(() => config.value.pipelines.map((item) => item.id))
const previousIds = new WeakMap<PipelineConfig, string>()
const customSelectors = ref(new Set<PipelineSelectConfig>())
const customMatcherGroups = ref(new Set<MatcherConfig[]>())
const collapsedRules = ref(new Set<RuleConfig>())
const guidedSession = ref<{ pipeline: PipelineConfig; rule?: RuleConfig; ruleIndex?: number }>()
const manualMode = ref(false)

function selectorMode(selector: PipelineSelectConfig): PipelineSelectMode {
  return customSelectors.value.has(selector) ? 'custom' : inferPipelineSelectMode(selector)
}

function setSelectorMode(selector: PipelineSelectConfig, event: Event): void {
  const mode = (event.currentTarget as HTMLSelectElement).value as PipelineSelectMode
  const nextCustomSelectors = new Set(customSelectors.value)
  if (mode === 'custom') nextCustomSelectors.add(selector)
  else nextCustomSelectors.delete(selector)
  customSelectors.value = nextCustomSelectors
  applyPipelineSelectMode(selector, mode)
}

function matcherMode(matchers: MatcherConfig[], matcherOperator: string): PipelineSelectMode {
  return customMatcherGroups.value.has(matchers) ? 'custom' : inferMatcherMode(matchers, matcherOperator)
}

function setMatcherMode(rule: RuleConfig, stage: 'request' | 'response', event: Event): void {
  const matchers = stage === 'request' ? rule.matchers : rule.response_matchers
  const mode = (event.currentTarget as HTMLSelectElement).value as PipelineSelectMode
  const nextCustomGroups = new Set(customMatcherGroups.value)
  if (mode === 'custom') nextCustomGroups.add(matchers)
  else nextCustomGroups.delete(matchers)
  customMatcherGroups.value = nextCustomGroups
  const operator = applyMatcherMode(matchers, mode)
  if (stage === 'request') rule.matcher_operator = operator
  else rule.response_matcher_operator = operator
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

function setPipelineEcs(pipeline: PipelineConfig, event: Event): void {
  pipeline.ecs = createEcs((event.currentTarget as HTMLSelectElement).value)
}

function setEcsNumber(pipeline: PipelineConfig, key: string, event: Event): void {
  if (!pipeline.ecs) return
  const raw = (event.currentTarget as HTMLInputElement).value
  if (raw === '') delete pipeline.ecs[key]
  else pipeline.ecs[key] = Number(raw)
}

function removePipeline(index: number): void {
  const pipeline = config.value.pipelines[index]
  if (!pipeline || !window.confirm(`删除 Pipeline “${pipeline.id}”？`)) return
  config.value.pipelines.splice(index, 1)
}

function removeRule(pipeline: PipelineConfig, index: number): void {
  const rule = pipeline.rules[index]
  if (!rule || !window.confirm(`删除规则“${rule.name || index + 1}”？`)) return
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
  const outcome = blockerFlow.kind === 'jump' ? '跳转' : '终止'
  return `前面的 #${blocker.index + 1}“${blocker.name}”匹配任意请求并${outcome}，此规则按当前顺序不会执行`
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
</script>

<template>
  <DnsSolutionEditor v-if="!manualMode" v-model="config" :capabilities="capabilities" @manual="manualMode = true" @notice="emit('notice', $event)" />

  <template v-if="manualMode">
  <section class="config-section">
    <header class="config-section__header config-section__header--actions">
      <div><span class="section-mark section-mark--green"></span><h3>自由编辑</h3></div>
      <button class="button button--secondary" type="button" @click="manualMode = false"><ArrowLeft :size="15" />返回快捷编辑</button>
    </header>
  </section>
  <section class="config-section">
    <header class="config-section__header config-section__header--actions">
      <div><span class="section-mark section-mark--amber"></span><h3>分流规则</h3><em>{{ config.pipeline_select.length }}</em></div>
      <button class="button button--secondary" type="button" @click="config.pipeline_select.push(createPipelineSelect())"><Plus :size="15" />添加分流</button>
    </header>
    <div class="selector-list">
      <article v-for="(selector, index) in config.pipeline_select" :key="index" class="selector-block">
        <header class="selector-block__header">
          <div class="selector-block__identity">
            <span><GitBranch :size="15" /></span>
            <div><strong>入口分流 #{{ index + 1 }}</strong><small>按顺序匹配，首个命中生效</small></div>
          </div>
          <button class="icon-button icon-button--small" type="button" :title="`删除分流 ${index + 1}`" @click="config.pipeline_select.splice(index, 1)"><Trash2 :size="14" /></button>
        </header>
        <div class="selector-block__controls" :class="{ 'selector-block__controls--single': selector.matchers.length < 2 }">
          <label><span>目标 Pipeline</span><select v-model="selector.pipeline" :aria-label="`分流 ${index + 1} 目标 Pipeline`"><option disabled value="">选择 Pipeline</option><option v-for="id in pipelineIds" :key="id" :value="id">{{ id }}</option></select></label>
          <label v-if="selector.matchers.length > 1"><span>条件关系</span><select :value="selectorMode(selector)" :aria-label="`分流 ${index + 1} 条件关系`" @change="setSelectorMode(selector, $event)"><option value="all">全部满足</option><option value="any">任一满足</option><option value="custom">自定义组合</option></select></label>
        </div>
        <div class="selector-block__conditions">
          <div class="selector-block__conditions-title"><div><strong>匹配条件</strong><small>{{ selector.matchers.length < 2 ? '满足此条件时分流' : selectorMode(selector) === 'custom' ? '从第二条开始设置与前一结果的关系' : selectorMode(selector) === 'all' ? '所有条件均成立时分流' : '任一条件成立时分流' }}</small></div><em>{{ selector.matchers.length }}</em></div>
          <MatcherList v-model="selector.matchers" scope="selector" :operator-mode="selector.matchers.length > 1 && selectorMode(selector) === 'custom' ? 'custom' : 'hidden'" />
          <p v-if="selector.matchers.length === 0" class="selector-block__warning"><AlertTriangle :size="14" />未添加条件，这条分流会匹配所有请求</p>
        </div>
      </article>
      <p v-if="config.pipeline_select.length === 0" class="config-empty">未配置入口分流，将使用 KixDNS 默认选择行为</p>
    </div>
  </section>

  <section class="config-section pipeline-section">
    <header class="config-section__header config-section__header--actions">
      <div><span class="section-mark section-mark--green"></span><h3>处理流程</h3><em>{{ config.pipelines.length }}</em></div>
      <button class="button button--secondary" type="button" @click="config.pipelines.push(createPipeline(config))"><Plus :size="15" />添加 Pipeline</button>
    </header>

    <div class="pipeline-list">
      <details v-for="(pipeline, pipelineIndex) in config.pipelines" :key="pipelineIndex" class="pipeline-block" :open="pipelineIndex === 0">
        <summary><span>{{ pipeline.id || '未命名 Pipeline' }}</span><em>{{ pipeline.rules.length }} 条规则</em></summary>
        <div class="pipeline-body">
          <div class="pipeline-identity">
            <label><span>Pipeline ID</span><input v-model="pipeline.id" type="text" @focus="rememberId(pipeline)" @blur="commitId(pipeline)"></label>
            <button class="button button--danger-quiet" type="button" @click="removePipeline(pipelineIndex)"><Trash2 :size="15" />删除 Pipeline</button>
          </div>

          <section class="ecs-editor">
            <header><div><strong>Pipeline ECS</strong><span>RFC 7871 缓存隔离</span></div><span v-if="pipelineHasActionEcs(pipeline)" class="tag tag--danger"><AlertTriangle :size="12" />动作已配置 ECS</span></header>
            <div class="ecs-editor__fields">
              <label><span>模式</span><select :value="pipeline.ecs?.mode ?? ''" @change="setPipelineEcs(pipeline, $event)"><option value="">不隔离</option><option value="clear">Clear</option><option value="from_client_ip">按客户端 IP</option><option value="static">固定子网</option></select></label>
              <label v-if="pipeline.ecs?.mode === 'from_client_ip'"><span>IPv4 前缀</span><input type="number" :value="pipeline.ecs.prefix_v4" min="0" max="32" @input="setEcsNumber(pipeline, 'prefix_v4', $event)"></label>
              <label v-if="pipeline.ecs?.mode === 'from_client_ip'"><span>IPv6 前缀</span><input type="number" :value="pipeline.ecs.prefix_v6" min="0" max="128" @input="setEcsNumber(pipeline, 'prefix_v6', $event)"></label>
              <label v-if="pipeline.ecs?.mode === 'static'"><span>固定 IP</span><input v-model="pipeline.ecs.ip" type="text" placeholder="1.2.3.0"></label>
              <label v-if="pipeline.ecs?.mode === 'static'"><span>前缀</span><input type="number" :value="pipeline.ecs.prefix" min="0" max="128" @input="setEcsNumber(pipeline, 'prefix', $event)"></label>
            </div>
            <p v-if="pipelineHasActionEcs(pipeline) && !pipeline.ecs" class="inline-warning"><AlertTriangle :size="14" />动作注入 ECS 时应同时设置 Pipeline 缓存隔离维度</p>
          </section>

          <div class="rules-heading">
            <div><strong>规则</strong><span>{{ pipeline.rules.length }}</span></div>
            <div class="rules-heading__actions">
              <button class="inline-command" type="button" :disabled="pipeline.rules.length === 0" @click="toggleAllRules(pipeline)"><UnfoldVertical v-if="allRulesCollapsed(pipeline)" :size="14" /><FoldVertical v-else :size="14" />{{ allRulesCollapsed(pipeline) ? '全部展开' : '全部收起' }}</button>
              <button class="inline-command inline-command--primary" type="button" @click="openGuidedCreate(pipeline)"><Sparkles :size="14" />一键添加</button>
              <button class="inline-command" type="button" @click="pipeline.rules.push(createRule(pipeline))"><Plus :size="14" />手动添加</button>
            </div>
          </div>
          <div class="rule-list">
            <section v-for="(rule, ruleIndex) in pipeline.rules" :key="ruleIndex" class="rule-block" :class="{ 'rule-block--collapsed': ruleCollapsed(rule) }">
              <header>
                <span>{{ ruleIndex + 1 }}</span>
                <input v-model="rule.name" type="text" :aria-label="`规则 ${ruleIndex + 1} 名称`" placeholder="规则名称">
                <div class="rule-order-actions" role="group" :aria-label="`调整规则 ${rule.name || ruleIndex + 1} 的顺序`">
                  <button class="icon-button icon-button--small" type="button" :title="`一键编辑规则 ${rule.name || ruleIndex + 1}`" :aria-label="`一键编辑规则 ${rule.name || ruleIndex + 1}`" @click="openGuidedEdit(pipeline, rule, ruleIndex)"><Sparkles :size="14" /></button>
                  <button class="icon-button icon-button--small rule-collapse-toggle" type="button" :title="`${ruleCollapsed(rule) ? '展开' : '收起'}规则 ${rule.name || ruleIndex + 1}`" :aria-label="`${ruleCollapsed(rule) ? '展开' : '收起'}规则 ${rule.name || ruleIndex + 1}`" @click="setRuleCollapsed(rule, !ruleCollapsed(rule))"><ChevronDown v-if="ruleCollapsed(rule)" :size="14" /><ChevronUp v-else :size="14" /></button>
                  <button class="icon-button icon-button--small" type="button" :disabled="ruleIndex === 0" :title="`置顶规则 ${rule.name || ruleIndex + 1}`" :aria-label="`置顶规则 ${rule.name || ruleIndex + 1}`" @click="moveRule(pipeline, ruleIndex, 0)"><ArrowUpToLine :size="14" /></button>
                  <button class="icon-button icon-button--small" type="button" :disabled="ruleIndex === 0" :title="`上移规则 ${rule.name || ruleIndex + 1}`" :aria-label="`上移规则 ${rule.name || ruleIndex + 1}`" @click="moveRule(pipeline, ruleIndex, ruleIndex - 1)"><ArrowUp :size="14" /></button>
                  <button class="icon-button icon-button--small" type="button" :disabled="ruleIndex === pipeline.rules.length - 1" :title="`下移规则 ${rule.name || ruleIndex + 1}`" :aria-label="`下移规则 ${rule.name || ruleIndex + 1}`" @click="moveRule(pipeline, ruleIndex, ruleIndex + 1)"><ArrowDown :size="14" /></button>
                  <button class="icon-button icon-button--small" type="button" :disabled="ruleIndex === pipeline.rules.length - 1" :title="`置底规则 ${rule.name || ruleIndex + 1}`" :aria-label="`置底规则 ${rule.name || ruleIndex + 1}`" @click="moveRule(pipeline, ruleIndex, pipeline.rules.length - 1)"><ArrowDownToLine :size="14" /></button>
                  <button class="icon-button icon-button--small icon-button--danger" type="button" :title="`删除规则 ${rule.name || ruleIndex + 1}`" :aria-label="`删除规则 ${rule.name || ruleIndex + 1}`" @click="removeRule(pipeline, ruleIndex)"><Trash2 :size="14" /></button>
                </div>
              </header>
              <p class="rule-summary">
                <span>当</span><strong>{{ summarizeRule(rule).condition }}</strong>
                <ArrowRight :size="13" />
                <span>执行</span><strong>{{ summarizeRule(rule).action }}</strong>
                <em v-if="responseEnabled(rule)">含响应阶段</em>
                <b class="rule-flow" :class="`rule-flow--${analyzeRuleFlow(rule).kind}`">{{ analyzeRuleFlow(rule).label }}</b>
              </p>
              <p v-if="blockingRuleWarning(pipeline, ruleIndex)" class="rule-order-warning">
                <AlertTriangle :size="14" />{{ blockingRuleWarning(pipeline, ruleIndex) }}
              </p>

              <template v-if="!ruleCollapsed(rule)">
                <div class="rule-stage">
                  <div class="rule-stage__title">
                    <div><strong>请求匹配</strong><small>{{ rule.matchers.length === 0 ? '未添加条件时匹配所有请求' : rule.matchers.length === 1 ? '满足此条件时执行' : matcherMode(rule.matchers, rule.matcher_operator) === 'custom' ? '从第二条开始设置与前一结果的关系' : matcherMode(rule.matchers, rule.matcher_operator) === 'all' ? '所有条件均成立时执行' : '任一条件成立时执行' }}</small></div>
                    <select v-if="rule.matchers.length > 1" :value="matcherMode(rule.matchers, rule.matcher_operator)" aria-label="请求条件关系" @change="setMatcherMode(rule, 'request', $event)"><option value="all">全部满足</option><option value="any">任一满足</option><option value="custom">自定义组合</option></select>
                  </div>
                  <MatcherList v-model="rule.matchers" scope="request" :operator-mode="rule.matchers.length > 1 && matcherMode(rule.matchers, rule.matcher_operator) === 'custom' ? 'custom' : 'hidden'" />
                </div>
                <div class="rule-stage"><div class="rule-stage__title"><strong>执行动作</strong></div><ActionList v-model="rule.actions" :pipelines="config.pipelines" :current-pipeline-id="pipeline.id" :capabilities="capabilities" /></div>

                <template v-if="responseEnabled(rule)">
                  <div class="rule-stage rule-stage--response">
                    <div class="rule-stage__title">
                      <div><strong>响应匹配</strong><small>{{ rule.response_matchers.length === 0 ? '未添加条件时直接判定匹配成功' : rule.response_matchers.length === 1 ? '满足此条件时执行匹配成功动作' : matcherMode(rule.response_matchers, rule.response_matcher_operator) === 'custom' ? '从第二条开始设置与前一结果的关系' : matcherMode(rule.response_matchers, rule.response_matcher_operator) === 'all' ? '所有条件均成立时判定成功' : '任一条件成立时判定成功' }}</small></div>
                      <select v-if="rule.response_matchers.length > 1" :value="matcherMode(rule.response_matchers, rule.response_matcher_operator)" aria-label="响应条件关系" @change="setMatcherMode(rule, 'response', $event)"><option value="all">全部满足</option><option value="any">任一满足</option><option value="custom">自定义组合</option></select>
                    </div>
                    <MatcherList v-model="rule.response_matchers" scope="response" :operator-mode="rule.response_matchers.length > 1 && matcherMode(rule.response_matchers, rule.response_matcher_operator) === 'custom' ? 'custom' : 'hidden'" />
                  </div>
                  <div class="response-actions">
                    <div class="rule-stage"><div class="rule-stage__title"><strong>匹配成功</strong></div><ActionList v-model="rule.response_actions_on_match" :pipelines="config.pipelines" :current-pipeline-id="pipeline.id" :capabilities="capabilities" /></div>
                    <div class="rule-stage"><div class="rule-stage__title"><strong>匹配失败</strong></div><ActionList v-model="rule.response_actions_on_miss" :pipelines="config.pipelines" :current-pipeline-id="pipeline.id" :capabilities="capabilities" /></div>
                  </div>
                </template>
              </template>
            </section>
            <p v-if="pipeline.rules.length === 0" class="config-empty">此 Pipeline 尚无规则</p>
          </div>
        </div>
      </details>
      <p v-if="config.pipelines.length === 0" class="config-empty">尚未创建 Pipeline</p>
    </div>
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
  </template>
</template>
