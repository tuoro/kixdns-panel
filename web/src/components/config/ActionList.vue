<script setup lang="ts">
import { ArrowDown, ArrowUp, Plus, X } from '@lucide/vue'
import { computed, useId } from 'vue'
import { actionFieldErrors } from '../../config-editor/field-validation'
import { createAction, createEcs, resetAction } from '../../config-editor/model'
import { ACTION_TYPES, TRANSPORT_OPTIONS } from '../../config-editor/schema'
import { summarizeAction } from '../../config-editor/summary'
import type { ActionConfig, PipelineConfig } from '../../config-editor/types'

const props = withDefaults(defineProps<{
  pipelines: PipelineConfig[]
  currentPipelineId: string
  capabilities?: string[]
}>(), {
  capabilities: () => [],
})
const actions = defineModel<ActionConfig[]>({ required: true })
const supportedActionTypes = computed(() => ACTION_TYPES.filter((option) => (
  !option.requiresCapability || props.capabilities.includes(option.requiresCapability)
)))
const errors = computed(() => actions.value.map((action) => actionFieldErrors(
  action, props.currentPipelineId, props.pipelines.map((pipeline) => pipeline.id),
)))
const instanceId = useId()
const logLevels = ['trace', 'debug', 'info', 'warn', 'error']
const responseCodes = ['NOERROR', 'NXDOMAIN', 'SERVFAIL', 'REFUSED']
const existingUpstreams = computed(() => {
  const upstreams = new Map<string, { upstream: string; transport: string }>()
  for (const pipeline of props.pipelines) {
    for (const rule of pipeline.rules) {
      for (const action of [...rule.actions, ...rule.response_actions_on_match, ...rule.response_actions_on_miss]) {
        if (action.type !== 'forward' || !action.upstream?.trim()) continue
        const upstream = action.upstream.trim()
        const transport = action.transport ?? ''
        upstreams.set(JSON.stringify([upstream, transport]), { upstream, transport })
      }
    }
  }
  return [...upstreams.values()]
})

function fieldId(index: number, field: string): string {
  return `${instanceId}-action-${index}-${field}`
}

function fieldErrorId(index: number, field: string): string | undefined {
  return errors.value[index]?.[field] ? fieldId(index, `${field}-error`) : undefined
}

function useUpstream(action: ActionConfig, upstream: { upstream: string; transport: string }): void {
  action.upstream = upstream.upstream
  action.transport = upstream.transport
}

function actionTypes(action: ActionConfig) {
  if (supportedActionTypes.value.some((option) => option.value === action.type)) return supportedActionTypes.value
  const current = ACTION_TYPES.find((option) => option.value === action.type)
  return [...supportedActionTypes.value, current ?? { value: action.type, label: action.type }]
}

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

function move(index: number, offset: -1 | 1): void {
  const target = index + offset
  if (target < 0 || target >= actions.value.length) return
  const [action] = actions.value.splice(index, 1)
  if (action) actions.value.splice(target, 0, action)
}
</script>

<template>
  <div class="action-list">
    <div v-for="(action, index) in actions" :key="index" class="action-row">
      <header class="action-card__header">
        <span>动作 {{ index + 1 }}</span>
        <div class="action-row__controls">
          <button class="icon-button icon-button--small" type="button" :disabled="index === 0" :title="`上移动作 ${index + 1}`" @click="move(index, -1)"><ArrowUp :size="14" /></button>
          <button class="icon-button icon-button--small" type="button" :disabled="index === actions.length - 1" :title="`下移动作 ${index + 1}`" @click="move(index, 1)"><ArrowDown :size="14" /></button>
          <button class="icon-button icon-button--small" type="button" :title="`删除动作 ${index + 1}`" @click="actions.splice(index, 1)"><X :size="14" /></button>
        </div>
      </header>
      <div class="action-card__fields">
        <label class="action-field">
          <span>执行方式</span>
          <select :value="action.type" :aria-label="`动作 ${index + 1} 类型`" @change="changeType(action, $event)">
            <option v-for="option in actionTypes(action)" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <label v-if="action.type === 'log'" class="action-field">
          <span>日志级别</span>
          <select v-model="action.level" :aria-label="`动作 ${index + 1} 日志级别`">
            <option v-if="action.level && !logLevels.includes(action.level)" :value="action.level">{{ action.level }}</option>
            <option v-for="level in logLevels" :key="level" :value="level">{{ level }}</option>
          </select>
        </label>
        <label v-else-if="action.type === 'static_response'" class="action-field">
          <span>返回响应码</span>
          <select v-model="action.rcode" :aria-label="`动作 ${index + 1} RCode`">
            <option v-if="action.rcode && !responseCodes.includes(action.rcode)" :value="action.rcode">{{ action.rcode }}</option>
            <option v-for="rcode in responseCodes" :key="rcode" :value="rcode">{{ rcode }}</option>
          </select>
        </label>
        <label v-else-if="action.type === 'static_ip_response'" class="action-field">
          <span>返回 IP 地址</span>
          <input v-model="action.ip" type="text" :aria-label="`动作 ${index + 1} IP`" placeholder="例如 192.168.1.10" :aria-invalid="Boolean(errors[index]?.ip)" :aria-describedby="fieldErrorId(index, 'ip')">
          <small v-if="errors[index]?.ip" :id="fieldErrorId(index, 'ip')" class="action-field__error">{{ errors[index]?.ip }}</small>
        </label>
        <template v-else-if="action.type === 'static_cname_response'">
          <label class="action-field">
            <span>CNAME 目标域名</span>
            <input v-model="action.target" type="text" :aria-label="`动作 ${index + 1} CNAME 目标`" placeholder="origin.example." :aria-invalid="Boolean(errors[index]?.target)" :aria-describedby="fieldErrorId(index, 'target')">
            <small v-if="errors[index]?.target" :id="fieldErrorId(index, 'target')" class="action-field__error">{{ errors[index]?.target }}</small>
          </label>
          <label class="action-field">
            <span>缓存时间 TTL（秒）</span>
            <input type="number" :value="action.ttl" min="0" max="4294967295" :aria-label="`动作 ${index + 1} CNAME TTL`" placeholder="300" :aria-invalid="Boolean(errors[index]?.ttl)" :aria-describedby="fieldErrorId(index, 'ttl')" @input="setTtl(action, $event)">
            <small v-if="errors[index]?.ttl" :id="fieldErrorId(index, 'ttl')" class="action-field__error">{{ errors[index]?.ttl }}</small>
          </label>
        </template>
        <label v-else-if="action.type === 'jump_to_pipeline'" class="action-field">
          <span>接着执行哪个 Pipeline</span>
          <select v-model="action.pipeline" :aria-label="`动作 ${index + 1} 目标 Pipeline`" :aria-invalid="Boolean(errors[index]?.pipeline)" :aria-describedby="fieldErrorId(index, 'pipeline')">
            <option disabled value="">选择 Pipeline</option>
            <option v-if="action.pipeline && !pipelines.some((pipeline) => pipeline.id === action.pipeline)" :value="action.pipeline">{{ action.pipeline }}（不存在）</option>
            <option v-for="pipeline in pipelines" :key="pipeline.id" :value="pipeline.id" :disabled="pipeline.id === currentPipelineId">{{ pipeline.id }}</option>
          </select>
          <small v-if="errors[index]?.pipeline" :id="fieldErrorId(index, 'pipeline')" class="action-field__error">{{ errors[index]?.pipeline }}</small>
        </label>
        <template v-else-if="action.type === 'forward'">
          <label class="action-field">
            <span>传输协议</span>
            <select v-model="action.transport" :aria-label="`动作 ${index + 1} 传输协议`">
              <option value="">自动（按上游）</option>
              <option v-if="action.transport && !TRANSPORT_OPTIONS.includes(action.transport)" :value="action.transport">{{ action.transport }}</option>
              <option v-for="transport in TRANSPORT_OPTIONS" :key="transport" :value="transport">{{ transport.toUpperCase() }}</option>
            </select>
          </label>
          <label class="action-field action-field--wide">
            <span>交给这些上游解析</span>
            <input v-model="action.upstream" type="text" :aria-label="`动作 ${index + 1} 上游`" placeholder="192.168.1.1:53, https://dns.example/dns-query" :aria-invalid="Boolean(errors[index]?.upstream)" :aria-describedby="[fieldId(index, 'upstream-help'), fieldErrorId(index, 'upstream')].filter(Boolean).join(' ')">
            <small :id="fieldId(index, 'upstream-help')" class="action-field__help">多个地址用逗号分隔，也可以选用当前配置中的上游。</small>
            <small v-if="errors[index]?.upstream" :id="fieldErrorId(index, 'upstream')" class="action-field__error">{{ errors[index]?.upstream }}</small>
          </label>
        </template>
        <template v-else-if="action.type === 'static_txt_response' || action.type === 'replace_txt_response'">
          <label class="action-field">
            <span>TXT 文本内容</span>
            <input type="text" :value="textValue(action)" :aria-label="`动作 ${index + 1} TXT 内容`" placeholder="逗号分隔多个 TXT 值" :aria-invalid="Boolean(errors[index]?.text)" :aria-describedby="fieldErrorId(index, 'text')" @input="setText(action, $event)">
            <small v-if="errors[index]?.text" :id="fieldErrorId(index, 'text')" class="action-field__error">{{ errors[index]?.text }}</small>
          </label>
          <label v-if="action.type === 'static_txt_response'" class="action-field">
            <span>缓存时间 TTL（秒）</span>
            <input type="number" :value="action.ttl" min="1" :aria-label="`动作 ${index + 1} TTL`" placeholder="300" @input="setTtl(action, $event)">
          </label>
        </template>
      </div>
      <div v-if="action.type === 'forward' && existingUpstreams.length" class="existing-upstreams">
        <span>已有上游</span>
        <div class="existing-upstreams__options">
          <button v-for="upstream in existingUpstreams" :key="JSON.stringify(upstream)" type="button" :aria-label="`使用已有上游 ${upstream.upstream}${upstream.transport ? `（${upstream.transport.toUpperCase()}）` : ''}`" :aria-pressed="action.upstream === upstream.upstream && (action.transport ?? '') === upstream.transport" @click="useUpstream(action, upstream)">
            {{ upstream.upstream }}<small v-if="upstream.transport">{{ upstream.transport.toUpperCase() }}</small>
          </button>
        </div>
      </div>
      <details v-if="action.type === 'forward'" class="action-advanced" :open="Boolean(action.ecs)">
        <summary>高级选项 · ECS <small>{{ action.ecs ? '已配置' : '未单独设置' }}</small></summary>
        <div class="action-card__fields">
          <label class="action-field action-field--wide">
            <span>客户端子网信息</span>
            <select :value="action.ecs?.mode ?? ''" :aria-label="`动作 ${index + 1} ECS 模式`" @change="changeEcs(action, $event)">
              <option value="">不单独设置</option><option value="clear">清除 ECS（Clear）</option><option value="from_client_ip">使用客户端 IP</option><option value="static">固定子网</option>
            </select>
          </label>
          <template v-if="action.ecs?.mode === 'from_client_ip'">
            <label class="action-field"><span>IPv4 前缀长度</span><input type="number" :value="action.ecs.prefix_v4" min="0" max="32" aria-label="ECS IPv4 前缀" placeholder="24" @input="setEcsNumber(action, 'prefix_v4', $event)"></label>
            <label class="action-field"><span>IPv6 前缀长度</span><input type="number" :value="action.ecs.prefix_v6" min="0" max="128" aria-label="ECS IPv6 前缀" placeholder="56" @input="setEcsNumber(action, 'prefix_v6', $event)"></label>
          </template>
          <template v-if="action.ecs?.mode === 'static'">
            <label class="action-field"><span>固定 IP 地址</span><input v-model="action.ecs.ip" type="text" aria-label="ECS 固定 IP" placeholder="192.168.1.0"></label>
            <label class="action-field"><span>前缀长度</span><input type="number" :value="action.ecs.prefix" min="0" max="128" aria-label="ECS 固定前缀" placeholder="24" @input="setEcsNumber(action, 'prefix', $event)"></label>
          </template>
        </div>
      </details>
      <p class="action-card__summary">{{ summarizeAction(action) }}</p>
    </div>
    <button class="inline-command" type="button" @click="actions.push(createAction())"><Plus :size="14" />添加动作</button>
  </div>
</template>

<style scoped>
.action-list { display: grid; gap: 10px; }
.action-list .action-row { display: flex; flex-direction: column; align-items: stretch; gap: 12px; padding: 12px; border: 1px solid #e0e7e3; border-radius: 7px; background: #fff; }
.action-card__header { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: #506159; font-size: 14px; font-weight: 600; }
.action-card__header .action-row__controls { margin: 0; }
.action-card__fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 10px 12px; }
.action-field { display: grid; min-width: 0; gap: 5px; color: #606b65; font-size: 14px; }
.action-field--wide { grid-column: 1 / -1; }
.action-field input, .action-field select { font-size: 14px; }
.action-field [aria-invalid="true"] { border-color: #d48370; background: #fffaf8; }
.action-field__error { color: #ae4d36; font-size: 12px; }
.action-field__help { color: #7a857e; font-size: 12px; line-height: 1.6; }
.existing-upstreams { display: grid; min-width: 0; gap: 6px; color: #7a857e; font-size: 14px; }
.existing-upstreams__options { display: flex; min-width: 0; flex-wrap: wrap; gap: 6px; max-height: 120px; overflow: auto; }
.existing-upstreams button { min-width: 0; max-width: 100%; padding: 6px 8px; color: #53675a; text-align: left; overflow-wrap: anywhere; border: 1px solid #dce6df; border-radius: 5px; background: #f8faf9; font-size: 14px; line-height: 1.5; }
.existing-upstreams button[aria-pressed="true"] { color: #147d55; border-color: #89b9a0; background: #edf6f0; }
.existing-upstreams button small { margin-left: 5px; font-size: 12px; }
.action-advanced { min-width: 0; padding: 10px; border: 1px solid #e9edea; border-radius: 5px; background: #fbfcfb; }
.action-advanced summary { color: #617066; cursor: pointer; font-size: 14px; }
.action-advanced summary small { margin-left: 8px; color: #829087; font-size: 12px; }
.action-advanced[open] > summary { margin-bottom: 12px; }
.action-card__summary { margin: 0; color: #397653; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
@media (max-width: 600px) { .action-card__fields { grid-template-columns: minmax(0, 1fr); } }
</style>
