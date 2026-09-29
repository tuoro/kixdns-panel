<script setup lang="ts">
import { ArrowUpDown, ChevronDown, Plus, X } from '@lucide/vue'
import { computed, reactive, ref, toRaw, useId } from 'vue'
import UiMenu from '../ui/UiMenu.vue'
import UiSelect from '../ui/UiSelect.vue'
import UiUrlField from '../ui/UiUrlField.vue'
import { moveItems, moveTarget, useRowFocus } from './row-list'
import { actionFieldErrors } from '../../config-editor/field-validation'
import { createAction, createEcs, resetAction } from '../../config-editor/model'
import { ACTION_TYPES, TRANSPORT_OPTIONS } from '../../config-editor/schema'
import { transportLabel } from '../../config-editor/summary'
import type { ActionConfig, PipelineConfig } from '../../config-editor/types'

// 动作列表：和条件同一种子项行（规范 3.4）。动作按顺序执行，所以两个以上时编号，序号兼「调整顺序」菜单。
// 转发的上游独占参数格，右端的 ▾ 选用已有上游；协议和 ECS 是次一级的，放在下面一行（规范 3.4b）。
// Actions use the same sub-item row as conditions (spec 3.4). Actions run in order, so with two or
// more they are numbered and the ordinal doubles as the reorder menu. A forward's upstream has the
// params cell to itself, with a ▾ at its end for upstreams used elsewhere; transport and ECS are
// secondary and sit on the line below (spec 3.4b).
const props = withDefaults(defineProps<{
  pipelines: PipelineConfig[]
  currentPipelineId: string
  capabilities?: string[]
  showErrors?: boolean
}>(), {
  capabilities: () => [],
  showErrors: false,
})
const actions = defineModel<ActionConfig[]>({ required: true })
const supportedActionTypes = computed(() => ACTION_TYPES.filter((option) => (
  !option.requiresCapability || props.capabilities.includes(option.requiresCapability)
)))
const errors = computed(() => actions.value.map((action) => actionFieldErrors(
  action, props.currentPipelineId, props.pipelines.map((pipeline) => pipeline.id),
)))
const ordered = computed(() => actions.value.length > 1)
const instanceId = useId()
const touched = reactive(new Set<string>())
const root = ref<HTMLElement | null>(null)
const { focusRow } = useRowFocus(root)
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

function upstreamLabel(upstream: { upstream: string; transport: string }): string {
  return `${upstream.upstream}${upstream.transport ? ` (${transportLabel(upstream.transport)})` : ''}`
}

// 已经在别处用过的上游：上游输入框右端的 ▾ 打开，选中同时填上游和协议
// Upstreams already used elsewhere: the ▾ at the end of the upstream field opens them; picking one fills upstream and transport
const existingItems = computed(() => existingUpstreams.value.map((upstream, index) => ({ value: String(index), label: upstreamLabel(upstream), mono: true })))

function useUpstream(action: ActionConfig, index: string): void {
  const upstream = existingUpstreams.value[Number(index)]
  if (!upstream) return
  action.upstream = upstream.upstream
  action.transport = upstream.transport
}

function typeOptions(action: ActionConfig) {
  const known = supportedActionTypes.value.map((option) => ({ value: option.value, label: option.label }))
  if (known.some((option) => option.value === action.type)) return known
  const current = ACTION_TYPES.find((option) => option.value === action.type)
  return [...known, { value: action.type, label: current?.label ?? action.type }]
}

function enumOptions(values: readonly string[], current: string | undefined) {
  const options = values.map((value) => ({ value, label: value }))
  return current && !values.includes(current) ? [{ value: current, label: current }, ...options] : options
}

function transportOptions(action: ActionConfig) {
  // 放在次一行、没有字段名，所以默认项自己说明它是什么 / On the secondary line with no label, so the default names itself
  const options = [{ value: '', label: '自动识别协议' }, ...TRANSPORT_OPTIONS.map((transport) => ({ value: transport, label: transportLabel(transport) }))]
  return action.transport && !TRANSPORT_OPTIONS.includes(action.transport) ? [...options, { value: action.transport, label: action.transport }] : options
}

function pipelineOptions(action: ActionConfig) {
  const options = [{ value: '', label: '选择 Pipeline', disabled: true }, ...props.pipelines.map((pipeline) => ({ value: pipeline.id, label: pipeline.id, disabled: pipeline.id === props.currentPipelineId }))]
  return action.pipeline && !props.pipelines.some((pipeline) => pipeline.id === action.pipeline) ? [...options, { value: action.pipeline, label: `${action.pipeline}（不存在）` }] : options
}

// ECS 默认收起、设置过就展开；点一下切换。按动作对象记，挪动顺序时跟着动作走。
// ECS starts collapsed, or open when set; a click toggles it. Kept per action object so it follows reordering.
const ecsToggled = reactive(new WeakMap<object, boolean>())
function ecsOpen(action: ActionConfig): boolean {
  return ecsToggled.get(toRaw(action)) ?? Boolean(action.ecs)
}
function toggleEcs(action: ActionConfig): void {
  ecsToggled.set(toRaw(action), !ecsOpen(action))
}
const ecsOptions = [
  { value: '', label: '不单独设置' },
  { value: 'clear', label: '清除 ECS' },
  { value: 'from_client_ip', label: '使用客户端 IP' },
  { value: 'static', label: '固定子网' },
]

function fieldId(index: number, field: string): string {
  return `${instanceId}-action-${index}-${field}`
}

function touch(index: number, field: string): void {
  touched.add(`${index}:${field}`)
}

function visibleError(index: number, field: string): string | undefined {
  const error = errors.value[index]?.[field]
  return error && (props.showErrors || touched.has(`${index}:${field}`)) ? error : undefined
}

function errorId(index: number, field: string): string | undefined {
  return visibleError(index, field) ? fieldId(index, `${field}-error`) : undefined
}

function changeType(action: ActionConfig, type: string): void {
  resetAction(action, type)
}

function changeEcs(action: ActionConfig, mode: string): void {
  action.ecs = createEcs(mode)
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

function add(): void {
  actions.value.push(createAction())
  void focusRow(actions.value.length - 1, 'type')
}

function remove(index: number): void {
  actions.value.splice(index, 1)
  touched.clear()
  void focusRow(index, 'type')
}

function move(index: number, direction: string): void {
  const target = moveTarget(index, actions.value.length, direction)
  if (target === undefined) return
  const [action] = actions.value.splice(index, 1)
  if (action) actions.value.splice(target, 0, action)
  touched.clear()
  void focusRow(target, 'handle')
}
</script>

<template>
  <div ref="root" class="action-list ui-rows-host">
    <div class="ui-rows">
      <div v-for="(action, index) in actions" :key="index" class="ui-rows__row action-row">
        <span class="ui-rows__lead">
          <UiMenu v-if="ordered" class="ui-rows__ord" trigger-class="ui-rows__handle" align="start" :label="`调整动作 ${index + 1} 的顺序`" :items="moveItems(index, actions.length)" @select="move(index, $event)"><span class="ui-rows__num">{{ index + 1 }}</span><ArrowUpDown class="ui-rows__grip" :size="14" aria-hidden="true" /></UiMenu>
          <UiSelect class="ui-rows__type" :model-value="action.type" :options="typeOptions(action)" :label="`动作 ${index + 1} 类型`" @update:model-value="changeType(action, $event)" />
        </span>
        <div class="ui-rows__params">
          <template v-if="action.type === 'log'">
            <span class="ui-rows__plabel">级别</span>
            <UiSelect v-model="action.level" class="is-enum" :options="enumOptions(logLevels, action.level)" :label="`动作 ${index + 1} 日志级别`" />
          </template>
          <template v-else-if="action.type === 'static_response'">
            <span class="ui-rows__plabel">响应码</span>
            <UiSelect v-model="action.rcode" class="is-enum" :options="enumOptions(responseCodes, action.rcode)" :label="`动作 ${index + 1} RCode`" />
          </template>
          <template v-else-if="action.type === 'static_ip_response'">
            <span class="ui-rows__plabel">IP</span>
            <label class="ui-input"><input v-model="action.ip" class="mono" type="text" :aria-label="`动作 ${index + 1} IP`" placeholder="192.168.1.10" :aria-invalid="Boolean(visibleError(index, 'ip')) || undefined" :aria-describedby="errorId(index, 'ip')" @blur="touch(index, 'ip')"></label>
          </template>
          <template v-else-if="action.type === 'static_cname_response'">
            <span class="ui-rows__plabel">目标</span>
            <label class="ui-input"><input v-model="action.target" class="mono" type="text" :aria-label="`动作 ${index + 1} CNAME 目标`" placeholder="origin.example" :aria-invalid="Boolean(visibleError(index, 'target')) || undefined" :aria-describedby="errorId(index, 'target')" @blur="touch(index, 'target')"></label>
            <span class="ui-rows__plabel">TTL</span>
            <label class="ui-input is-num"><input type="number" :value="action.ttl" min="0" max="4294967295" :aria-label="`动作 ${index + 1} CNAME TTL`" placeholder="300" :aria-invalid="Boolean(visibleError(index, 'ttl')) || undefined" :aria-describedby="errorId(index, 'ttl')" @input="setTtl(action, $event)" @blur="touch(index, 'ttl')"><em class="ui-setrow__unit">秒</em></label>
          </template>
          <template v-else-if="action.type === 'jump_to_pipeline'">
            <span class="ui-rows__plabel">Pipeline</span>
            <UiSelect v-model="action.pipeline" mono :options="pipelineOptions(action)" :label="`动作 ${index + 1} 目标 Pipeline`" :invalid="Boolean(visibleError(index, 'pipeline'))" />
          </template>
          <template v-else-if="action.type === 'forward'">
            <span class="ui-rows__plabel is-top">上游</span>
            <!-- 上游可能是一串网址：框会换行、长高，只在「/」「,」后面断，几个上游和很长的地址都看得全（审计 B4、V16）
                 An upstream may be a list of URLs: the field wraps and grows, breaking only after "/" and ",", so several upstreams and long addresses stay readable (audits B4, V16) -->
            <label class="ui-input ui-input--area is-long"><UiUrlField v-model="action.upstream" :label="`动作 ${index + 1} 上游`" placeholder="192.168.1.1:53, https://dns.example/dns-query" :invalid="Boolean(visibleError(index, 'upstream'))" :describedby="errorId(index, 'upstream')" @blur="touch(index, 'upstream')" /><UiMenu v-if="existingItems.length" trigger-class="ui-input__affix" :label="`动作 ${index + 1} 选用已有上游`" :items="existingItems" @select="useUpstream(action, $event)"><ChevronDown :size="16" aria-hidden="true" /></UiMenu></label>
          </template>
          <template v-else-if="action.type === 'static_txt_response' || action.type === 'replace_txt_response'">
            <span class="ui-rows__plabel">文本</span>
            <label class="ui-input"><input class="mono" type="text" :value="textValue(action)" :aria-label="`动作 ${index + 1} TXT 内容`" placeholder="多个值用逗号分隔" :aria-invalid="Boolean(visibleError(index, 'text')) || undefined" :aria-describedby="errorId(index, 'text')" @input="setText(action, $event)" @blur="touch(index, 'text')"></label>
            <template v-if="action.type === 'static_txt_response'">
              <span class="ui-rows__plabel">TTL</span>
              <label class="ui-input is-num"><input type="number" :value="action.ttl" min="1" :aria-label="`动作 ${index + 1} TTL`" placeholder="300" @input="setTtl(action, $event)"><em class="ui-setrow__unit">秒</em></label>
            </template>
          </template>
        </div>
        <span class="ui-rows__act"><button class="ui-icon-btn" type="button" :title="`删除动作 ${index + 1}`" :aria-label="`删除动作 ${index + 1}`" @click="remove(index)"><X :size="16" /></button></span>
        <template v-for="field in ['ip', 'target', 'ttl', 'pipeline', 'upstream', 'text']" :key="field">
          <p v-if="visibleError(index, field)" :id="fieldId(index, `${field}-error`)" class="ui-field-error ui-rows__error">{{ visibleError(index, field) }}</p>
        </template>
        <div v-if="action.type === 'forward'" class="ui-rows__sub">
          <UiSelect v-model="action.transport" size="sm" class="action-transport" :options="transportOptions(action)" :label="`动作 ${index + 1} 传输协议`" />
          <button class="ui-btn ui-btn--text ui-btn--sm action-ecs-toggle" type="button" :aria-expanded="ecsOpen(action)" :aria-controls="fieldId(index, 'ecs')" @click="toggleEcs(action)">ECS {{ action.ecs ? '已设置' : '未设置' }}<ChevronDown class="ui-btn__chev" :size="14" aria-hidden="true" /></button>
          <div v-if="ecsOpen(action)" :id="fieldId(index, 'ecs')" class="action-ecs ui-rise">
            <UiSelect :model-value="action.ecs?.mode ?? ''" :options="ecsOptions" :label="`动作 ${index + 1} ECS 模式`" @update:model-value="changeEcs(action, $event)" />
            <template v-if="action.ecs?.mode === 'from_client_ip'">
              <label class="ui-input is-num"><input type="number" :value="action.ecs.prefix_v4" min="0" max="32" aria-label="ECS IPv4 前缀" placeholder="24" @input="setEcsNumber(action, 'prefix_v4', $event)"><em class="ui-setrow__unit">IPv4</em></label>
              <label class="ui-input is-num"><input type="number" :value="action.ecs.prefix_v6" min="0" max="128" aria-label="ECS IPv6 前缀" placeholder="56" @input="setEcsNumber(action, 'prefix_v6', $event)"><em class="ui-setrow__unit">IPv6</em></label>
            </template>
            <template v-if="action.ecs?.mode === 'static'">
              <label class="ui-input"><input v-model="action.ecs.ip" class="mono" type="text" aria-label="ECS 固定 IP" placeholder="192.168.1.0"></label>
              <label class="ui-input is-num"><input type="number" :value="action.ecs.prefix" min="0" max="128" aria-label="ECS 固定前缀" placeholder="24" @input="setEcsNumber(action, 'prefix', $event)"><em class="ui-setrow__unit">位</em></label>
            </template>
          </div>
        </div>
      </div>
    </div>
    <button class="ui-btn ui-btn--text ui-btn--sm ui-rows__add" type="button" @click="add"><Plus :size="14" />添加动作</button>
  </div>
</template>

<style scoped>
/* 列表和「添加动作」之间 12：按钮上下往回收以后，字离最后一个字段 12（审计第三轮 B3） / 12 between the list and 添加动作: with the button pulled back its text sits 12 under the last field (audit round 3, B3) */
.action-list { display: grid; gap: var(--s-3); }
/* 协议下拉框按最长的选项定宽：手机上 16 号字时「自动识别协议」也放得下；ECS 是文字按钮，展开后字段换到下一行
   The transport select sizes to its longest option, so 自动识别协议 fits even at a phone's 16px; ECS is a text button whose fields wrap onto the next line */
.action-transport { flex: 0 0 auto; min-width: 8rem; }
.action-ecs { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: var(--s-2); }
.action-ecs > .ui-select { flex: 0 0 11rem; }
.action-ecs > .ui-input:not(.is-num) { flex: 1 1 10rem; }
.action-ecs > .ui-input.is-num { flex: 0 0 var(--w-num); }
/* 手机上协议和 ECS 各占一行，和组里别的字段一样一行一个；ECS 往回收一格，字从竖线开始，不会在窄处掉到下一行又缩进（审计第二轮 V6）
   On a phone the transport and ECS take a line each like every other field in the group; ECS is pulled back so its text starts on the
   column line, instead of wrapping onto an indented second line where the row is narrow (audit round 2, V6) */
@media (max-width: 640px) {
  .ui-rows__sub { flex-direction: column; align-items: flex-start; gap: var(--s-3); }
  /* ECS 的 44 高按钮往上收：字离协议框 12，和组里别的字段一样；下边不收，它的点按区域不和下面的「添加动作」叠在一起（审计第三轮 A4、B3）
     The 44-tall ECS button is pulled up so its text sits 12 under the transport box like any field; not below, so its hit area never overlaps 添加动作 under it (audit round 3, A4, B3) */
  /* 少收 2：44 的格子和上面的协议框挨着不叠（审计第六轮 A4） / Pulled back 2 less, so its 44 cell touches the transport box above without overlapping (audit round 6, A4) */
  .action-ecs-toggle { margin-inline-start: calc(var(--s-3) * -1); margin-block-start: calc((1lh - var(--h-touch)) / 2 + 2px); }
  .action-ecs { flex-basis: auto; align-self: stretch; }
}
</style>
