<script setup lang="ts">
import { ArrowUpDown, Plus, X } from '@lucide/vue'
import { computed, reactive, ref, useId } from 'vue'
import UiMenu from '../ui/UiMenu.vue'
import UiSelect from '../ui/UiSelect.vue'
import { moveItems, moveTarget, useRowFocus } from './row-list'
import { isGeoSiteMatcher, matcherFieldErrors } from '../../config-editor/field-validation'
import { matcherHint as hint } from '../../config-editor/matcher-hints'
import { createMatcher, resetMatcher } from '../../config-editor/model'
import { MATCHER_DEFINITIONS, MATCH_OPERATORS, QTYPE_OPTIONS } from '../../config-editor/schema'
import type { MatcherConfig, MatcherScope } from '../../config-editor/types'

// 条件列表：一行一个条件，四格——运算 · 类型 · 参数 · 操作（规范 3.4）。
// 运算、序号（兼「调整顺序」菜单）只在「自定义组合」出现，因为只有那时顺序才有意义；参数按类型的 schema 排，
// 字段名不每行重复，占位符和无障碍名称说明它是什么。出错信息在离开字段或父组件要求时才出现。
// Conditions, one per row in four cells: operator · type · params · actions (spec 3.4). The operator,
// ordinal and reordering appear only in a custom combination, the one case where order matters. Params
// follow the type's schema; field names are not repeated per row. Errors show after blur or on request.
const props = withDefaults(defineProps<{
  scope: MatcherScope
  operatorMode?: 'hidden' | 'custom'
  // 父组件提交过一次后传 true：所有出错的字段都标出来 / Parent passes true after a submit attempt
  showErrors?: boolean
}>(), {
  operatorMode: 'custom',
  showErrors: false,
})
const matchers = defineModel<MatcherConfig[]>({ required: true })
const definitions = computed(() => MATCHER_DEFINITIONS[props.scope])
const errors = computed(() => matchers.value.map((matcher) => matcherFieldErrors(matcher, props.scope)))
const custom = computed(() => props.operatorMode === 'custom')
const ordered = computed(() => custom.value && matchers.value.length > 1)
const instanceId = useId()
const touched = reactive(new Set<string>())
const root = ref<HTMLElement | null>(null)
const { focusRow } = useRowFocus(root)

const expectLabels: Record<string, [string, string]> = {
  edns_present: ['有 EDNS', '没有'],
  response_edns_present: ['有 EDNS', '没有'],
  geoip_private: ['是私网', '不是'],
  response_answer_ip_geoip_private: ['是私网', '不是'],
}

function fields(matcher: MatcherConfig): string[] {
  return definitions.value.find((item) => item.value === matcher.type)?.fields ?? []
}

function typeOptions(matcher: MatcherConfig) {
  const known = definitions.value.map((definition) => ({ value: definition.value, label: definition.label }))
  return known.some((option) => option.value === matcher.type) ? known : [{ value: matcher.type, label: matcher.type }, ...known]
}

function operatorOptions() {
  return MATCH_OPERATORS.map((operator) => ({ value: operator.value, label: operator.label }))
}

function qtypeOptions(matcher: MatcherConfig) {
  const options = QTYPE_OPTIONS.map((qtype) => ({ value: qtype, label: qtype }))
  return matcher.value && !QTYPE_OPTIONS.includes(matcher.value) ? [{ value: matcher.value, label: matcher.value }, ...options] : options
}

function modeOptions(matcher: MatcherConfig) {
  const options = [{ value: 'exact', label: '精确' }, { value: 'prefix', label: '前缀' }, { value: 'regex', label: '正则' }]
  return matcher.mode && !options.some((option) => option.value === matcher.mode) ? [{ value: matcher.mode, label: matcher.mode }, ...options] : options
}

function fieldId(index: number, field: string): string {
  return `${instanceId}-matcher-${index}-${field}`
}

function touch(index: number, field: string): void {
  touched.add(`${index}:${field}`)
}

function visibleError(index: number, field: string): string | undefined {
  const error = errors.value[index]?.[field]
  return error && (props.showErrors || touched.has(`${index}:${field}`)) ? error : undefined
}

function describedBy(index: number, field: string, matcher: MatcherConfig): string | undefined {
  return [hint(matcher).help ? fieldId(index, 'help') : '', visibleError(index, field) ? fieldId(index, `${field}-error`) : ''].filter(Boolean).join(' ') || undefined
}

function changeType(matcher: MatcherConfig, type: string): void {
  resetMatcher(matcher, type, props.scope)
}

function add(): void {
  matchers.value.push(createMatcher(props.scope))
  void focusRow(matchers.value.length - 1, 'type')
}

function remove(index: number): void {
  matchers.value.splice(index, 1)
  touched.clear()
  if (custom.value && matchers.value[0]) matchers.value[0].operator = 'and'
  void focusRow(index, 'type')
}

// 粘贴进来的 geosite:cn 离开输入框时去掉前缀，和国家代码去掉 geoip: 一样：内核按原样查标签，带前缀就匹配不上
// A pasted geosite:cn loses its prefix on blur, as country codes lose geoip:; the kernel looks the tag up as written, so a prefix never matches
function leaveValue(matcher: MatcherConfig, index: number): void {
  if (isGeoSiteMatcher(matcher) && typeof matcher.value === 'string') matcher.value = matcher.value.trim().replace(/^geosite:/i, '')
  touch(index, 'value')
}

function countryCodesValue(matcher: MatcherConfig): string {
  return Array.isArray(matcher.country_codes) ? matcher.country_codes.join(', ') : ''
}

function setCountryCodes(matcher: MatcherConfig, event: Event): void {
  matcher.country_codes = [...new Set((event.currentTarget as HTMLInputElement).value
    .replace(/^geoip:/i, '')
    .split(/[\s,，;；]+/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean))]
}

function move(index: number, direction: string): void {
  const target = moveTarget(index, matchers.value.length, direction)
  if (target === undefined) return
  const [matcher] = matchers.value.splice(index, 1)
  if (matcher) matchers.value.splice(target, 0, matcher)
  if (custom.value && matchers.value[0]) matchers.value[0].operator = 'and'
  touched.clear()
  void focusRow(target, 'handle')
}
</script>

<template>
  <div ref="root" class="matcher-list ui-rows-host">
    <div class="ui-rows" :class="{ 'ui-rows--op': custom }">
      <div v-for="(matcher, index) in matchers" :key="index" class="ui-rows__row matcher-row">
        <span class="ui-rows__lead">
          <UiMenu v-if="ordered" class="ui-rows__ord" trigger-class="ui-rows__handle" align="start" :label="`调整条件 ${index + 1} 的顺序`" :items="moveItems(index, matchers.length)" @select="move(index, $event)"><span class="ui-rows__num">{{ index + 1 }}</span><ArrowUpDown class="ui-rows__grip" :size="14" aria-hidden="true" /></UiMenu>
          <template v-if="custom">
            <span v-if="index === 0" class="ui-rows__none ui-rows__op">首个条件</span>
            <UiSelect v-else v-model="matcher.operator" class="ui-rows__op" :options="operatorOptions()" :label="`条件 ${index + 1} 逻辑运算符`" />
          </template>
          <UiSelect class="ui-rows__type" :model-value="matcher.type" :options="typeOptions(matcher)" :label="`条件 ${index + 1} 类型`" @update:model-value="changeType(matcher, $event)" />
        </span>
        <div class="ui-rows__params">
          <template v-if="fields(matcher).includes('mode')">
            <span class="ui-rows__plabel">模式</span>
            <UiSelect v-model="matcher.mode" class="is-enum" :options="modeOptions(matcher)" :label="`条件 ${index + 1} 匹配模式`" />
          </template>
          <template v-if="fields(matcher).includes('value')">
            <span class="ui-rows__plabel">{{ hint(matcher).label }}</span>
            <UiSelect v-if="matcher.type === 'qtype'" v-model="matcher.value" class="is-enum" :options="qtypeOptions(matcher)" :label="`条件 ${index + 1} QType`" />
            <label v-else class="ui-input"><input v-model="matcher.value" class="mono" type="text" :aria-label="`条件 ${index + 1} 值`" :placeholder="hint(matcher).example" :aria-invalid="Boolean(visibleError(index, 'value')) || undefined" :aria-describedby="describedBy(index, 'value', matcher)" @blur="leaveValue(matcher, index)"></label>
          </template>
          <template v-if="fields(matcher).includes('cidr')">
            <span class="ui-rows__plabel">{{ hint(matcher).label }}</span>
            <label class="ui-input"><input v-model="matcher.cidr" class="mono" type="text" :aria-label="`条件 ${index + 1} CIDR`" :placeholder="hint(matcher).example" :aria-invalid="Boolean(visibleError(index, 'cidr')) || undefined" :aria-describedby="describedBy(index, 'cidr', matcher)" @blur="touch(index, 'cidr')"></label>
          </template>
          <template v-if="fields(matcher).includes('country_codes')">
            <span class="ui-rows__plabel">国家</span>
            <label class="ui-input"><input class="mono" type="text" :value="countryCodesValue(matcher)" :aria-label="`条件 ${index + 1} 国家代码`" :placeholder="hint(matcher).example" :aria-invalid="Boolean(visibleError(index, 'country_codes')) || undefined" :aria-describedby="describedBy(index, 'country_codes', matcher)" @input="setCountryCodes(matcher, $event)" @blur="touch(index, 'country_codes')"></label>
          </template>
          <template v-if="fields(matcher).includes('expect')">
            <span class="ui-rows__plabel">期望</span>
            <span class="ui-seg" role="group" :aria-label="`条件 ${index + 1} 期望存在`">
              <button class="ui-seg__opt" type="button" :aria-pressed="matcher.expect !== false" @click="matcher.expect = true">{{ (expectLabels[matcher.type] ?? ['有', '没有'])[0] }}</button>
              <button class="ui-seg__opt" type="button" :aria-pressed="matcher.expect === false" @click="matcher.expect = false">{{ (expectLabels[matcher.type] ?? ['有', '没有'])[1] }}</button>
            </span>
          </template>
          <span v-if="fields(matcher).length === 0" class="ui-rows__none">匹配所有请求</span>
        </div>
        <span class="ui-rows__act"><button class="ui-icon-btn" type="button" :title="`删除条件 ${index + 1}`" :aria-label="`删除条件 ${index + 1}`" @click="remove(index)"><X :size="16" /></button></span>
        <template v-for="field in ['value', 'cidr', 'country_codes']" :key="field">
          <p v-if="visibleError(index, field)" :id="fieldId(index, `${field}-error`)" class="ui-field-error ui-rows__error">{{ visibleError(index, field) }}</p>
        </template>
        <p v-if="hint(matcher).help" :id="fieldId(index, 'help')" class="matcher-help ui-rows__error">{{ hint(matcher).help }}</p>
      </div>
    </div>
    <button class="ui-btn ui-btn--text ui-btn--sm ui-rows__add" type="button" @click="add"><Plus :size="14" />添加条件</button>
  </div>
</template>

<style scoped>
/* 列表和「添加条件」之间 12（审计第三轮 B3） / 12 between the list and 添加条件 (audit round 3, B3) */
.matcher-list { display: grid; gap: var(--s-3); }
.matcher-help { margin: 0; color: var(--l-ink-3); font-size: var(--t-1); }
</style>
