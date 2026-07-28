<script setup lang="ts">
import { ArrowRight, CornerDownRight } from '@lucide/vue'
import { computed } from 'vue'
import { configRuleCount } from '../../config-editor/model'
import type { ActionConfig, KixConfig, MatcherConfig } from '../../config-editor/types'

const props = defineProps<{ config: KixConfig }>()
const ruleCount = computed(() => configRuleCount(props.config))

function summarizeMatchers(matchers: MatcherConfig[]): string {
  if (matchers.length === 0) return '任意请求'
  return matchers.map((matcher, index) => {
    const operator = index === 0 ? '' : `${matcher.operator.toUpperCase()} `
    const countryCodes = Array.isArray(matcher.country_codes) ? matcher.country_codes.join(', ') : matcher.country_codes
    const value = matcher.value ?? matcher.cidr ?? countryCodes ?? (typeof matcher.expect === 'boolean' ? String(matcher.expect) : '')
    return `${operator}${matcher.type}${value ? `:${value}` : ''}`
  }).join(' · ')
}

function actionLabel(action: ActionConfig): string {
  if (action.type === 'forward') return `forward:${action.upstream || '默认上游'}`
  if (action.type === 'jump_to_pipeline') return `jump:${action.pipeline || '未选择'}`
  if (action.type === 'static_response') return `rcode:${action.rcode}`
  if (action.type === 'static_ip_response') return `ip:${action.ip}`
  return action.type
}

function jumpActions(actions: ActionConfig[]): ActionConfig[] {
  return actions.filter((action) => action.type === 'jump_to_pipeline')
}
</script>

<template>
  <div class="flow-preview">
    <header class="flow-summary"><div><strong>{{ config.pipelines.length }}</strong><span>Pipeline</span></div><div><strong>{{ ruleCount }}</strong><span>规则</span></div><div><strong>{{ config.pipeline_select.length }}</strong><span>入口分流</span></div></header>

    <section v-if="config.pipeline_select.length" class="flow-routes">
      <h3>入口路由</h3>
      <div v-for="(selector, index) in config.pipeline_select" :key="index" class="flow-route">
        <span>#{{ index + 1 }}</span><code>{{ summarizeMatchers(selector.matchers) }}</code><ArrowRight :size="16" /><strong>{{ selector.pipeline || '未选择' }}</strong>
      </div>
    </section>

    <div class="flow-pipelines">
      <section v-for="pipeline in config.pipelines" :key="pipeline.id" class="flow-pipeline">
        <header><div><strong>{{ pipeline.id || '未命名 Pipeline' }}</strong><span v-if="pipeline.ecs">ECS · {{ pipeline.ecs.mode }}</span></div><em>{{ pipeline.rules.length }} 条规则</em></header>
        <ol>
          <li v-for="(rule, index) in pipeline.rules" :key="index">
            <span class="flow-step">{{ index + 1 }}</span>
            <div class="flow-rule">
              <strong>{{ rule.name || `Rule ${index + 1}` }}</strong>
              <code>{{ summarizeMatchers(rule.matchers) }}</code>
              <div class="flow-actions"><span v-for="(action, actionIndex) in rule.actions" :key="actionIndex">{{ actionLabel(action) }}</span><em v-if="rule.actions.length === 0">无动作</em></div>
              <div v-for="(action, jumpIndex) in jumpActions([...rule.actions, ...rule.response_actions_on_match, ...rule.response_actions_on_miss])" :key="jumpIndex" class="flow-jump"><CornerDownRight :size="14" />{{ action.pipeline || '未选择目标' }}</div>
            </div>
          </li>
        </ol>
        <p v-if="pipeline.rules.length === 0" class="config-empty">空 Pipeline</p>
      </section>
      <p v-if="config.pipelines.length === 0" class="config-empty">没有可预览的 Pipeline</p>
    </div>
  </div>
</template>
