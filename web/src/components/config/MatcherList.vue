<script setup lang="ts">
import { ArrowDown, ArrowUp, Plus, X } from '@lucide/vue'
import { computed, useId } from 'vue'
import { matcherFieldErrors } from '../../config-editor/field-validation'
import { createMatcher, resetMatcher } from '../../config-editor/model'
import { MATCHER_DEFINITIONS, MATCH_OPERATORS, QTYPE_OPTIONS } from '../../config-editor/schema'
import type { MatcherConfig, MatcherScope } from '../../config-editor/types'

const props = withDefaults(defineProps<{
  scope: MatcherScope
  operatorMode?: 'hidden' | 'custom'
}>(), {
  operatorMode: 'custom',
})
const matchers = defineModel<MatcherConfig[]>({ required: true })
const definitions = computed(() => MATCHER_DEFINITIONS[props.scope])
const errors = computed(() => matchers.value.map((matcher) => matcherFieldErrors(matcher, props.scope)))
const instanceId = useId()

const matcherHelp: Record<string, { label: string; example: string; help: string }> = {
  listener_label: { label: '监听标签', example: '填写实际监听标签', help: '只接收指定监听入口的请求。填写实际配置中的监听标签。' },
  domain_suffix: { label: '域名后缀', example: '例如 example.com', help: '匹配该域名及它的子域名，例如 www.example.com。' },
  request_domain_suffix: { label: '请求域名后缀', example: '例如 example.com', help: '根据本次请求的域名匹配，也包含它的子域名。' },
  domain_regex: { label: '域名正则', example: '^api\\.example\\.com\\.?$', help: '使用正则表达式匹配查询域名。点号需要写作 \\.。' },
  request_domain_regex: { label: '请求域名正则', example: '^api\\.example\\.com\\.?$', help: '使用正则表达式匹配本次请求的域名。' },
  qtype: { label: '查询类型', example: 'A', help: 'A 表示 IPv4 地址，AAAA 表示 IPv6 地址；每个条件选择一种类型。' },
  qclass: { label: '查询类别', example: '例如 IN', help: '按 DNS 查询类别匹配；常见的互联网查询使用 IN。' },
  response_qclass: { label: '响应查询类别', example: '例如 IN', help: '按响应中的 DNS 查询类别匹配。' },
  upstream_equals: { label: '上游地址', example: '例如 192.168.1.1:53', help: '匹配实际处理本次请求的上游地址。' },
  response_type: { label: '响应类型', example: '例如 A', help: '按响应记录类型匹配。' },
  response_rcode: { label: '响应码', example: '例如 NXDOMAIN', help: 'NOERROR 表示查询成功，NXDOMAIN 表示域名不存在。' },
  response_txt_content: { label: 'TXT 内容', example: '例如 v=spf1', help: '按所选模式匹配响应中的 TXT 文本。' },
  client_ip: { label: '客户端网段', example: '192.168.1.0/24, 10.0.0.0/8', help: '按客户端 IP 所在网段匹配，多个 CIDR 用逗号分隔。' },
  response_upstream_ip: { label: '上游网段', example: '192.168.1.0/24', help: '按实际上游 IP 所在网段匹配。' },
  response_answer_ip: { label: '应答网段', example: '0.0.0.0/32, 240.0.0.0/4', help: '检查响应中的 IP 地址是否落在指定网段。' },
  any: { label: '任意请求', example: '', help: '这个条件匹配所有请求，无需填写额外参数。' },
  edns_present: { label: 'EDNS', example: '', help: '勾选时匹配包含 EDNS 的请求；取消勾选时匹配不包含 EDNS 的请求。' },
  response_edns_present: { label: 'EDNS', example: '', help: '勾选时匹配包含 EDNS 的响应；取消勾选时匹配不包含 EDNS 的响应。' },
  geoip_private: { label: '私网地址', example: '', help: '勾选时匹配私网客户端；取消勾选时匹配非私网客户端。' },
  response_answer_ip_geoip_private: { label: '私网地址', example: '', help: '勾选时匹配私网应答 IP；取消勾选时匹配非私网应答 IP。' },
}

function hint(matcher: MatcherConfig) {
  if (matcher.type.includes('geo_site') || matcher.type.includes('geosite')) {
    return { label: 'GeoSite 分类', example: 'cn 或 geosite:cn', help: '填写已导入 GeoSite 数据中的分类名称。' }
  }
  if (matcher.type.includes('geoip_country')) {
    return { label: '国家代码', example: 'CN, US 或 geoip:CN', help: '填写两位国家代码，多个国家用逗号分隔；需要对应的 GeoIP 数据。' }
  }
  return matcherHelp[matcher.type] ?? { label: '匹配值', example: '填写匹配值', help: '' }
}

function fieldId(index: number, field: string): string {
  return `${instanceId}-matcher-${index}-${field}`
}

function fieldDescription(index: number, field: string): string {
  return `${fieldId(index, 'help')}${errors.value[index]?.[field] ? ` ${fieldId(index, `${field}-error`)}` : ''}`
}

function fields(matcher: MatcherConfig): string[] {
  return definitions.value.find((item) => item.value === matcher.type)?.fields ?? []
}

function changeType(matcher: MatcherConfig, event: Event): void {
  resetMatcher(matcher, (event.currentTarget as HTMLSelectElement).value, props.scope)
}

function remove(index: number): void {
  matchers.value.splice(index, 1)
  if (props.operatorMode === 'custom' && matchers.value[0]) matchers.value[0].operator = 'and'
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

function move(index: number, offset: -1 | 1): void {
  const target = index + offset
  if (target < 0 || target >= matchers.value.length) return
  const [matcher] = matchers.value.splice(index, 1)
  if (matcher) matchers.value.splice(target, 0, matcher)
  if (props.operatorMode === 'custom' && matchers.value[0]) matchers.value[0].operator = 'and'
}
</script>

<template>
  <div class="matcher-list">
    <div v-for="(matcher, index) in matchers" :key="index" class="matcher-row" :class="{ 'matcher-row--simple': operatorMode === 'hidden' }">
      <header class="matcher-card__header">
        <span>条件 {{ index + 1 }}<small v-if="operatorMode === 'custom' && index === 0">首个条件</small></span>
        <div class="matcher-row__controls">
          <button class="icon-button icon-button--small" type="button" :disabled="index === 0" :title="`上移条件 ${index + 1}`" @click="move(index, -1)"><ArrowUp :size="14" /></button>
          <button class="icon-button icon-button--small" type="button" :disabled="index === matchers.length - 1" :title="`下移条件 ${index + 1}`" @click="move(index, 1)"><ArrowDown :size="14" /></button>
          <button class="icon-button icon-button--small" type="button" :title="`删除条件 ${index + 1}`" @click="remove(index)"><X :size="14" /></button>
        </div>
      </header>
      <div class="matcher-card__fields">
        <label v-if="operatorMode === 'custom' && index > 0" class="matcher-field">
          <span>与前面条件的关系</span>
          <select v-model="matcher.operator" :aria-label="`条件 ${index + 1} 逻辑运算符`">
            <option v-for="operator in MATCH_OPERATORS" :key="operator.value" :value="operator.value">{{ operator.label }}</option>
          </select>
        </label>
        <label class="matcher-field">
          <span>匹配方式</span>
          <select :value="matcher.type" :aria-label="`条件 ${index + 1} 类型`" :aria-describedby="fieldId(index, 'help')" @change="changeType(matcher, $event)">
            <option v-if="!definitions.some((definition) => definition.value === matcher.type)" :value="matcher.type">{{ matcher.type }}</option>
            <option v-for="definition in definitions" :key="definition.value" :value="definition.value">{{ definition.label }}</option>
          </select>
        </label>
        <label v-if="fields(matcher).includes('value')" class="matcher-field">
          <span>{{ hint(matcher).label }}</span>
          <select v-if="matcher.type === 'qtype'" v-model="matcher.value" :aria-label="`条件 ${index + 1} QType`" :aria-invalid="Boolean(errors[index]?.value)" :aria-describedby="fieldDescription(index, 'value')">
            <option v-if="matcher.value && !QTYPE_OPTIONS.includes(matcher.value)" :value="matcher.value">{{ matcher.value }}</option>
            <option v-for="qtype in QTYPE_OPTIONS" :key="qtype" :value="qtype">{{ qtype }}</option>
          </select>
          <input v-else v-model="matcher.value" type="text" :aria-label="`条件 ${index + 1} 值`" :placeholder="hint(matcher).example" :aria-invalid="Boolean(errors[index]?.value)" :aria-describedby="fieldDescription(index, 'value')">
          <small v-if="errors[index]?.value" :id="fieldId(index, 'value-error')" class="matcher-field__error">{{ errors[index]?.value }}</small>
        </label>
        <label v-if="fields(matcher).includes('cidr')" class="matcher-field">
          <span>{{ hint(matcher).label }}（CIDR）</span>
          <input v-model="matcher.cidr" type="text" :aria-label="`条件 ${index + 1} CIDR`" :placeholder="hint(matcher).example" :aria-invalid="Boolean(errors[index]?.cidr)" :aria-describedby="fieldDescription(index, 'cidr')">
          <small v-if="errors[index]?.cidr" :id="fieldId(index, 'cidr-error')" class="matcher-field__error">{{ errors[index]?.cidr }}</small>
        </label>
        <label v-if="fields(matcher).includes('country_codes')" class="matcher-field">
          <span>国家代码</span>
          <input type="text" :value="countryCodesValue(matcher)" :aria-label="`条件 ${index + 1} 国家代码`" :placeholder="hint(matcher).example" :aria-invalid="Boolean(errors[index]?.country_codes)" :aria-describedby="fieldDescription(index, 'country_codes')" @input="setCountryCodes(matcher, $event)">
          <small v-if="errors[index]?.country_codes" :id="fieldId(index, 'country_codes-error')" class="matcher-field__error">{{ errors[index]?.country_codes }}</small>
        </label>
        <label v-if="fields(matcher).includes('mode')" class="matcher-field">
          <span>文本匹配模式</span>
          <select v-model="matcher.mode" :aria-label="`条件 ${index + 1} 匹配模式`">
            <option v-if="matcher.mode && !['exact', 'prefix', 'regex'].includes(matcher.mode)" :value="matcher.mode">{{ matcher.mode }}</option>
            <option value="exact">精确</option>
            <option value="prefix">前缀</option>
            <option value="regex">正则</option>
          </select>
        </label>
        <label v-if="fields(matcher).includes('expect')" class="compact-check matcher-expect"><input v-model="matcher.expect" type="checkbox" :aria-describedby="fieldId(index, 'help')"><span>期望存在</span></label>
      </div>
      <p :id="fieldId(index, 'help')" class="matcher-card__help">{{ hint(matcher).help }}</p>
    </div>
    <button class="inline-command" type="button" @click="matchers.push(createMatcher(scope))"><Plus :size="14" />添加条件</button>
  </div>
</template>

<style scoped>
.matcher-list { display: grid; gap: 10px; }
.matcher-list .matcher-row { display: flex; flex-direction: column; align-items: stretch; gap: 10px; padding: 12px; border: 1px solid #e0e7e3; border-radius: 7px; background: #fff; }
.matcher-card__header { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: #506159; font-size: 14px; font-weight: 600; }
.matcher-card__header small { margin-left: 8px; color: #84918a; font-size: 12px; font-weight: 400; }
.matcher-card__header .matcher-row__controls { margin: 0; }
.matcher-card__fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 10px 12px; }
.matcher-field { display: grid; min-width: 0; gap: 5px; color: #606b65; font-size: 14px; }
.matcher-field input, .matcher-field select { font-size: 14px; }
.matcher-field [aria-invalid="true"] { border-color: #d48370; background: #fffaf8; }
.matcher-field__error { color: #ae4d36; font-size: 12px; }
.matcher-card__help { margin: 0; color: #7a857e; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.matcher-expect { align-self: center; }
.matcher-expect input { width: 14px; height: 14px; }
@media (max-width: 600px) { .matcher-card__fields { grid-template-columns: minmax(0, 1fr); } }
</style>
