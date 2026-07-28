<script setup lang="ts">
import { AlertTriangle, Plus, Trash2 } from '@lucide/vue'
import { computed } from 'vue'
import {
  createEcs,
  createPipeline,
  createPipelineSelect,
  createRule,
  pipelineHasActionEcs,
  renamePipeline,
  ruleHasForward,
} from '../../config-editor/model'
import { MATCH_OPERATORS } from '../../config-editor/schema'
import type { KixConfig, PipelineConfig, RuleConfig } from '../../config-editor/types'
import ActionList from './ActionList.vue'
import MatcherList from './MatcherList.vue'

const config = defineModel<KixConfig>({ required: true })
const emit = defineEmits<{ notice: [message: string] }>()
const pipelineIds = computed(() => config.value.pipelines.map((item) => item.id))
const previousIds = new WeakMap<PipelineConfig, string>()

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
  pipeline.rules.splice(index, 1)
}

function responseEnabled(rule: RuleConfig): boolean {
  return ruleHasForward(rule)
}
</script>

<template>
  <section class="config-section">
    <header class="config-section__header config-section__header--actions">
      <div><span class="section-mark section-mark--amber"></span><h3>分流规则</h3><em>{{ config.pipeline_select.length }}</em></div>
      <button class="button button--secondary" type="button" @click="config.pipeline_select.push(createPipelineSelect())"><Plus :size="15" />添加分流</button>
    </header>
    <div class="selector-list">
      <div v-for="(selector, index) in config.pipeline_select" :key="index" class="selector-block">
        <div class="selector-block__header">
          <strong>#{{ index + 1 }}</strong>
          <select v-model="selector.pipeline" :aria-label="`分流 ${index + 1} 目标 Pipeline`"><option disabled value="">选择 Pipeline</option><option v-for="id in pipelineIds" :key="id" :value="id">{{ id }}</option></select>
          <select v-model="selector.matcher_operator" :aria-label="`分流 ${index + 1} 默认逻辑`"><option v-for="operator in MATCH_OPERATORS" :key="operator.value" :value="operator.value">{{ operator.label }}</option></select>
          <button class="icon-button icon-button--small" type="button" :title="`删除分流 ${index + 1}`" @click="config.pipeline_select.splice(index, 1)"><Trash2 :size="14" /></button>
        </div>
        <MatcherList v-model="selector.matchers" scope="selector" />
      </div>
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

          <div class="rules-heading"><div><strong>规则</strong><span>{{ pipeline.rules.length }}</span></div><button class="inline-command" type="button" @click="pipeline.rules.push(createRule(pipeline))"><Plus :size="14" />添加规则</button></div>
          <div class="rule-list">
            <section v-for="(rule, ruleIndex) in pipeline.rules" :key="ruleIndex" class="rule-block">
              <header><span>{{ ruleIndex + 1 }}</span><input v-model="rule.name" type="text" :aria-label="`规则 ${ruleIndex + 1} 名称`" placeholder="规则名称"><button class="icon-button icon-button--small" type="button" title="删除规则" @click="removeRule(pipeline, ruleIndex)"><Trash2 :size="14" /></button></header>

              <div class="rule-stage">
                <div class="rule-stage__title"><strong>请求匹配</strong><select v-model="rule.matcher_operator" aria-label="请求匹配默认逻辑"><option v-for="operator in MATCH_OPERATORS" :key="operator.value" :value="operator.value">{{ operator.label }}</option></select></div>
                <MatcherList v-model="rule.matchers" scope="request" />
              </div>
              <div class="rule-stage"><div class="rule-stage__title"><strong>执行动作</strong></div><ActionList v-model="rule.actions" :pipelines="config.pipelines" :current-pipeline-id="pipeline.id" /></div>

              <template v-if="responseEnabled(rule)">
                <div class="rule-stage rule-stage--response">
                  <div class="rule-stage__title"><strong>响应匹配</strong><select v-model="rule.response_matcher_operator" aria-label="响应匹配默认逻辑"><option v-for="operator in MATCH_OPERATORS" :key="operator.value" :value="operator.value">{{ operator.label }}</option></select></div>
                  <MatcherList v-model="rule.response_matchers" scope="response" />
                </div>
                <div class="response-actions">
                  <div class="rule-stage"><div class="rule-stage__title"><strong>匹配成功</strong></div><ActionList v-model="rule.response_actions_on_match" :pipelines="config.pipelines" :current-pipeline-id="pipeline.id" /></div>
                  <div class="rule-stage"><div class="rule-stage__title"><strong>匹配失败</strong></div><ActionList v-model="rule.response_actions_on_miss" :pipelines="config.pipelines" :current-pipeline-id="pipeline.id" /></div>
                </div>
              </template>
            </section>
            <p v-if="pipeline.rules.length === 0" class="config-empty">此 Pipeline 尚无规则</p>
          </div>
        </div>
      </details>
      <p v-if="config.pipelines.length === 0" class="config-empty">尚未创建 Pipeline</p>
    </div>
  </section>
</template>
