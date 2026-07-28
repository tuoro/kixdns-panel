<script setup lang="ts">
import { Plus, X } from '@lucide/vue'
import { createAction, createEcs, resetAction } from '../../config-editor/model'
import { ACTION_TYPES, TRANSPORT_OPTIONS } from '../../config-editor/schema'
import type { ActionConfig, PipelineConfig } from '../../config-editor/types'

defineProps<{ pipelines: PipelineConfig[]; currentPipelineId: string }>()
const actions = defineModel<ActionConfig[]>({ required: true })

function changeType(action: ActionConfig, event: Event): void {
  resetAction(action, (event.currentTarget as HTMLSelectElement).value)
}

function changeEcs(action: ActionConfig, event: Event): void {
  action.ecs = createEcs((event.currentTarget as HTMLSelectElement).value)
}

function setEcsNumber(action: ActionConfig, key: string, event: Event): void {
  if (!action.ecs) return
  const raw = (event.currentTarget as HTMLInputElement).value
  if (raw === '') delete action.ecs[key]
  else action.ecs[key] = Number(raw)
}

function textValue(action: ActionConfig): string {
  return Array.isArray(action.text) ? action.text.join(', ') : typeof action.text === 'string' ? action.text : ''
}

function setText(action: ActionConfig, event: Event): void {
  action.text = (event.currentTarget as HTMLInputElement).value.split(',').map((item) => item.trim()).filter(Boolean)
}

function setTtl(action: ActionConfig, event: Event): void {
  const raw = (event.currentTarget as HTMLInputElement).value
  if (raw === '') delete action.ttl
  else action.ttl = Number(raw)
}
</script>

<template>
  <div class="action-list">
    <div v-for="(action, index) in actions" :key="index" class="action-row">
      <select :value="action.type" :aria-label="`动作 ${index + 1} 类型`" @change="changeType(action, $event)">
        <option v-for="option in ACTION_TYPES" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>

      <select v-if="action.type === 'log'" v-model="action.level" :aria-label="`动作 ${index + 1} 日志级别`"><option v-for="level in ['trace', 'debug', 'info', 'warn', 'error']" :key="level" :value="level">{{ level }}</option></select>
      <select v-else-if="action.type === 'static_response'" v-model="action.rcode" :aria-label="`动作 ${index + 1} RCode`"><option v-for="rcode in ['NOERROR', 'NXDOMAIN', 'SERVFAIL', 'REFUSED']" :key="rcode" :value="rcode">{{ rcode }}</option></select>
      <input v-else-if="action.type === 'static_ip_response'" v-model="action.ip" type="text" :aria-label="`动作 ${index + 1} IP`" placeholder="127.0.0.1">
      <select v-else-if="action.type === 'jump_to_pipeline'" v-model="action.pipeline" :aria-label="`动作 ${index + 1} 目标 Pipeline`"><option disabled value="">选择 Pipeline</option><option v-for="pipeline in pipelines" :key="pipeline.id" :value="pipeline.id" :disabled="pipeline.id === currentPipelineId">{{ pipeline.id }}</option></select>

      <template v-else-if="action.type === 'forward'">
        <input v-model="action.upstream" class="action-row__grow" type="text" :aria-label="`动作 ${index + 1} 上游`" placeholder="1.1.1.1:53, doh://dns.google/dns-query">
        <select v-model="action.transport" :aria-label="`动作 ${index + 1} 传输协议`"><option v-for="transport in TRANSPORT_OPTIONS" :key="transport" :value="transport">{{ transport.toUpperCase() }}</option></select>
        <select :value="action.ecs?.mode ?? ''" :aria-label="`动作 ${index + 1} ECS 模式`" @change="changeEcs(action, $event)"><option value="">无 ECS</option><option value="clear">Clear</option><option value="from_client_ip">Client IP</option><option value="static">固定子网</option></select>
        <input v-if="action.ecs?.mode === 'from_client_ip'" type="number" :value="action.ecs.prefix_v4" min="0" max="32" aria-label="ECS IPv4 前缀" placeholder="24" @input="setEcsNumber(action, 'prefix_v4', $event)">
        <input v-if="action.ecs?.mode === 'from_client_ip'" type="number" :value="action.ecs.prefix_v6" min="0" max="128" aria-label="ECS IPv6 前缀" placeholder="56" @input="setEcsNumber(action, 'prefix_v6', $event)">
        <input v-if="action.ecs?.mode === 'static'" v-model="action.ecs.ip" type="text" aria-label="ECS 固定 IP" placeholder="1.2.3.0">
        <input v-if="action.ecs?.mode === 'static'" type="number" :value="action.ecs.prefix" min="0" max="128" aria-label="ECS 固定前缀" placeholder="24" @input="setEcsNumber(action, 'prefix', $event)">
      </template>

      <template v-else-if="action.type === 'static_txt_response' || action.type === 'replace_txt_response'">
        <input class="action-row__grow" type="text" :value="textValue(action)" :aria-label="`动作 ${index + 1} TXT 内容`" placeholder="逗号分隔多个 TXT 值" @input="setText(action, $event)">
        <input v-if="action.type === 'static_txt_response'" type="number" :value="action.ttl" min="1" :aria-label="`动作 ${index + 1} TTL`" placeholder="TTL" @input="setTtl(action, $event)">
      </template>

      <button class="icon-button icon-button--small" type="button" :title="`删除动作 ${index + 1}`" @click="actions.splice(index, 1)"><X :size="14" /></button>
    </div>
    <button class="inline-command" type="button" @click="actions.push(createAction())"><Plus :size="14" />添加动作</button>
  </div>
</template>
