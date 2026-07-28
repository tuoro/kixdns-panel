<script setup lang="ts">
import { Plus, X } from '@lucide/vue'
import { computed } from 'vue'
import { createMatcher, resetMatcher } from '../../config-editor/model'
import { MATCHER_DEFINITIONS, MATCH_OPERATORS, QTYPE_OPTIONS } from '../../config-editor/schema'
import type { MatcherConfig, MatcherScope } from '../../config-editor/types'

const props = defineProps<{ scope: MatcherScope }>()
const matchers = defineModel<MatcherConfig[]>({ required: true })
const definitions = computed(() => MATCHER_DEFINITIONS[props.scope])

function fields(matcher: MatcherConfig): string[] {
  return definitions.value.find((item) => item.value === matcher.type)?.fields ?? []
}

function changeType(matcher: MatcherConfig, event: Event): void {
  resetMatcher(matcher, (event.currentTarget as HTMLSelectElement).value, props.scope)
}

function remove(index: number): void {
  matchers.value.splice(index, 1)
}

function countryCodesValue(matcher: MatcherConfig): string {
  return Array.isArray(matcher.country_codes) ? matcher.country_codes.join(', ') : ''
}

function setCountryCodes(matcher: MatcherConfig, event: Event): void {
  matcher.country_codes = (event.currentTarget as HTMLInputElement).value
    .replace(/^geoip:/i, '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean)
}
</script>

<template>
  <div class="matcher-list">
    <div v-for="(matcher, index) in matchers" :key="index" class="matcher-row">
      <select v-model="matcher.operator" :aria-label="`条件 ${index + 1} 逻辑运算符`">
        <option v-for="operator in MATCH_OPERATORS" :key="operator.value" :value="operator.value">{{ operator.label }}</option>
      </select>
      <select :value="matcher.type" :aria-label="`条件 ${index + 1} 类型`" @change="changeType(matcher, $event)">
        <option v-for="definition in definitions" :key="definition.value" :value="definition.value">{{ definition.label }}</option>
      </select>

      <select v-if="matcher.type === 'qtype'" v-model="matcher.value" :aria-label="`条件 ${index + 1} QType`">
        <option v-for="qtype in QTYPE_OPTIONS" :key="qtype" :value="qtype">{{ qtype }}</option>
      </select>
      <input v-else-if="fields(matcher).includes('value')" v-model="matcher.value" type="text" :aria-label="`条件 ${index + 1} 值`" :placeholder="matcher.type.includes('geo_site') ? 'cn 或 geosite:cn' : '匹配值'">
      <input v-if="fields(matcher).includes('cidr')" v-model="matcher.cidr" type="text" :aria-label="`条件 ${index + 1} CIDR`" placeholder="127.0.0.0/8, 10.0.0.0/8">
      <input v-if="fields(matcher).includes('country_codes')" type="text" :value="countryCodesValue(matcher)" :aria-label="`条件 ${index + 1} 国家代码`" placeholder="CN, US 或 geoip:CN" @input="setCountryCodes(matcher, $event)">
      <select v-if="fields(matcher).includes('mode')" v-model="matcher.mode" :aria-label="`条件 ${index + 1} 匹配模式`">
        <option value="exact">精确</option>
        <option value="prefix">前缀</option>
        <option value="regex">正则</option>
      </select>
      <label v-if="fields(matcher).includes('expect')" class="compact-check"><input v-model="matcher.expect" type="checkbox"><span>期望存在</span></label>
      <button class="icon-button icon-button--small" type="button" :title="`删除条件 ${index + 1}`" @click="remove(index)"><X :size="14" /></button>
    </div>
    <button class="inline-command" type="button" @click="matchers.push(createMatcher(scope))"><Plus :size="14" />添加条件</button>
  </div>
</template>
