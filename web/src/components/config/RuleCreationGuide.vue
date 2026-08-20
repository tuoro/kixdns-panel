<script setup lang="ts">
import { ArrowRight, Sparkles, X } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import {
  buildGuidedRule,
  createGuidedRuleDraft,
  guidedRuleInsertIndex,
  type GuidedRuleIntent,
  type GuidedRuleScope,
} from '../../config-editor/guided-rule'
import { QTYPE_OPTIONS, TRANSPORT_OPTIONS } from '../../config-editor/schema'
import { findBlockingRule, summarizeRule } from '../../config-editor/summary'
import type { PipelineConfig, RuleConfig } from '../../config-editor/types'

const props = defineProps<{ pipeline: PipelineConfig; pipelines: PipelineConfig[] }>()
const emit = defineEmits<{
  cancel: []
  create: [rule: RuleConfig, index: number]
}>()

const draft = ref(createGuidedRuleDraft())
const scopeOptions: Array<{ value: GuidedRuleScope; label: string }> = [
  { value: 'geo_site', label: 'GeoSite 分类' },
  { value: 'domain_suffix', label: '域名后缀' },
  { value: 'client_ip', label: '客户端网段' },
  { value: 'qtype', label: '查询类型' },
  { value: 'all', label: '其他所有请求（兜底）' },
]
const intentOptions: Array<{ value: GuidedRuleIntent; label: string; description: string }> = [
  { value: 'forward', label: '转发到指定 DNS', description: '把命中的请求交给指定上游解析' },
  { value: 'deny', label: '拒绝请求', description: '阻止命中的 DNS 请求继续处理' },
  { value: 'static_ip_response', label: '返回固定 IP', description: '直接返回指定 IP 地址' },
  { value: 'jump_to_pipeline', label: '交给其他 Pipeline', description: '跳转到另一个处理流程' },
]

const targetPipelines = computed(() => props.pipelines.filter((pipeline) => pipeline.id !== props.pipeline.id))
const previewRule = computed(() => buildGuidedRule(props.pipeline, draft.value))
const preview = computed(() => summarizeRule(previewRule.value))
const insertIndex = computed(() => guidedRuleInsertIndex(props.pipeline, draft.value.scope))
const existingFallback = computed(() => draft.value.scope === 'all'
  ? findBlockingRule(props.pipeline, props.pipeline.rules.length)
  : undefined)
const placement = computed(() => {
  if (existingFallback.value) return `已有第 ${existingFallback.value.index + 1} 条兜底规则“${existingFallback.value.name}”，请直接编辑或调整它`
  if (insertIndex.value === props.pipeline.rules.length) return `放在末尾，成为第 ${insertIndex.value + 1} 条规则`
  return `放在第 ${insertIndex.value + 1} 条，位于兜底规则之前`
})
const valid = computed(() => {
  const scopeReady = draft.value.scope === 'all' || draft.value.scopeValue.trim().length > 0
  const targetReady = draft.value.intent === 'deny' || draft.value.targetValue.trim().length > 0
  return scopeReady && targetReady && !existingFallback.value
})

watch(() => draft.value.scope, (scope) => {
  draft.value.scopeValue = scope === 'qtype' ? 'A' : ''
})

watch(() => draft.value.intent, () => {
  draft.value.targetValue = ''
  draft.value.transport = ''
})

function create(): void {
  if (!valid.value) return
  emit('create', previewRule.value, insertIndex.value)
}
</script>

<template>
  <Teleport to="body">
    <div class="rule-guide-overlay" @click.self="emit('cancel')">
      <section class="rule-guide" role="dialog" aria-modal="true" aria-labelledby="rule-guide-title" @keydown.esc="emit('cancel')">
        <header class="rule-guide__header">
          <div><span><Sparkles :size="14" />引导创建</span><h2 id="rule-guide-title">新增一条规则</h2><p>说明想处理的请求和结果，面板会生成标准 KixDNS 规则。</p></div>
          <button class="icon-button" type="button" aria-label="关闭规则向导" @click="emit('cancel')"><X :size="17" /></button>
        </header>

        <form class="rule-guide__body" @submit.prevent="create">
          <section class="rule-guide__step">
            <header><span>1</span><div><strong>处理哪些请求？</strong><small>先选择匹配范围</small></div></header>
            <div class="rule-guide__fields">
              <label><span>请求范围</span><select v-model="draft.scope" aria-label="向导请求范围"><option v-for="option in scopeOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
              <label v-if="draft.scope === 'geo_site'"><span>GeoSite 分类</span><input v-model="draft.scopeValue" aria-label="向导 GeoSite 分类" type="text" placeholder="cn 或 geosite:cn"></label>
              <label v-else-if="draft.scope === 'domain_suffix'"><span>域名后缀</span><input v-model="draft.scopeValue" aria-label="向导域名后缀" type="text" placeholder="example.com"></label>
              <label v-else-if="draft.scope === 'client_ip'"><span>客户端 CIDR</span><input v-model="draft.scopeValue" aria-label="向导客户端 CIDR" type="text" placeholder="192.168.1.0/24"></label>
              <label v-else-if="draft.scope === 'qtype'"><span>查询类型</span><select v-model="draft.scopeValue" aria-label="向导查询类型"><option disabled value="">选择类型</option><option v-for="qtype in QTYPE_OPTIONS" :key="qtype" :value="qtype">{{ qtype }}</option></select></label>
              <p v-else class="rule-guide__hint">兜底规则会匹配此前未结束处理的所有请求，并自动放在规则末尾。</p>
            </div>
          </section>

          <section class="rule-guide__step">
            <header><span>2</span><div><strong>命中后做什么？</strong><small>选择想要的处理结果</small></div></header>
            <div class="rule-guide__intent-grid">
              <label v-for="option in intentOptions" :key="option.value" :class="{ 'is-selected': draft.intent === option.value }">
                <input v-model="draft.intent" type="radio" name="guided-intent" :value="option.value">
                <span><strong>{{ option.label }}</strong><small>{{ option.description }}</small></span>
              </label>
            </div>
            <div class="rule-guide__fields rule-guide__fields--target">
              <template v-if="draft.intent === 'forward'">
                <label class="rule-guide__wide"><span>上游地址</span><input v-model="draft.targetValue" aria-label="向导上游地址" type="text" placeholder="223.5.5.5:53 或 doh://dns.example/dns-query"></label>
                <label><span>传输协议</span><select v-model="draft.transport" aria-label="向导传输协议"><option value="">自动（按上游）</option><option v-for="transport in TRANSPORT_OPTIONS" :key="transport" :value="transport">{{ transport.toUpperCase() }}</option></select></label>
              </template>
              <label v-else-if="draft.intent === 'static_ip_response'"><span>返回 IP</span><input v-model="draft.targetValue" aria-label="向导返回 IP" type="text" placeholder="192.0.2.1"></label>
              <label v-else-if="draft.intent === 'jump_to_pipeline'"><span>目标 Pipeline</span><select v-model="draft.targetValue" aria-label="向导目标 Pipeline"><option disabled value="">选择 Pipeline</option><option v-for="pipeline in targetPipelines" :key="pipeline.id" :value="pipeline.id">{{ pipeline.id }}</option></select></label>
            </div>
          </section>

          <section class="rule-guide__step rule-guide__step--confirm">
            <header><span>3</span><div><strong>确认规则</strong><small>创建后仍可使用高级编辑器调整</small></div></header>
            <label class="rule-guide__name"><span>规则名称（可选）</span><input v-model="draft.name" aria-label="向导规则名称" type="text" :placeholder="previewRule.name"></label>
            <p class="rule-guide__preview"><span>当</span><strong>{{ preview.condition }}</strong><ArrowRight :size="14" /><span>执行</span><strong>{{ preview.action }}</strong></p>
            <p class="rule-guide__placement" :class="{ 'rule-guide__placement--warning': existingFallback }">{{ placement }}</p>
          </section>

          <footer>
            <button class="button button--secondary" type="button" @click="emit('cancel')">取消</button>
            <button class="button button--primary" type="submit" :disabled="!valid"><Sparkles :size="14" />创建规则</button>
          </footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.rule-guide-overlay { position: fixed; z-index: 120; inset: 0; display: grid; place-items: center; padding: 24px; background: rgba(18, 25, 22, .48); }
.rule-guide { width: min(720px, 100%); max-height: calc(100vh - 48px); overflow: auto; color: #30383a; background: #fff; border: 1px solid #d9dfdc; border-radius: 8px; box-shadow: 0 24px 70px rgba(13, 20, 17, .24); }
.rule-guide__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 18px 20px; border-bottom: 1px solid var(--line); }
.rule-guide__header > div { display: grid; gap: 4px; }
.rule-guide__header span { display: flex; align-items: center; gap: 5px; color: var(--green); font-size: 9px; font-weight: 750; }
.rule-guide__header h2 { font-size: 17px; }
.rule-guide__header p { color: var(--muted); font-size: 10px; }
.rule-guide__body { display: grid; }
.rule-guide__step { display: grid; gap: 13px; padding: 17px 20px; border-bottom: 1px solid var(--line); }
.rule-guide__step > header { display: flex; align-items: center; gap: 9px; }
.rule-guide__step > header > span { width: 24px; height: 24px; display: grid; place-items: center; color: #fff; background: var(--green); border-radius: 50%; font-size: 10px; font-weight: 750; }
.rule-guide__step > header > div { display: grid; gap: 1px; }
.rule-guide__step > header strong { font-size: 11px; }
.rule-guide__step > header small { color: var(--muted); font-size: 9px; }
.rule-guide__fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.rule-guide__fields label, .rule-guide__name { display: grid; gap: 5px; }
.rule-guide__fields label > span, .rule-guide__name > span { color: #59635f; font-size: 9px; font-weight: 650; }
.rule-guide__wide { grid-column: 1 / -1; }
.rule-guide__hint { grid-column: 1 / -1; padding: 9px 10px; color: #6c6250; background: #faf6ed; border-radius: 4px; font-size: 9px; }
.rule-guide__intent-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.rule-guide__intent-grid label { display: flex; align-items: flex-start; gap: 8px; padding: 10px; border: 1px solid var(--line); border-radius: 5px; cursor: pointer; }
.rule-guide__intent-grid label.is-selected { border-color: #8db7a3; background: var(--green-soft); }
.rule-guide__intent-grid input { margin-top: 2px; }
.rule-guide__intent-grid span { display: grid; gap: 2px; }
.rule-guide__intent-grid strong { font-size: 10px; }
.rule-guide__intent-grid small { color: var(--muted); font-size: 9px; line-height: 1.4; }
.rule-guide__fields--target { margin-top: 1px; }
.rule-guide__step--confirm { background: #fbfcfb; }
.rule-guide__preview { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 10px; color: #68716d; background: #fff; border: 1px solid var(--line); border-radius: 5px; font-size: 9px; }
.rule-guide__preview strong { color: #35413c; font-size: 10px; }
.rule-guide__placement { color: #397257; font-size: 9px; }
.rule-guide__placement--warning { color: #9a5b25; }
.rule-guide__body > footer { display: flex; justify-content: flex-end; gap: 8px; padding: 13px 20px; }
@media (max-width: 640px) {
  .rule-guide-overlay { padding: 10px; }
  .rule-guide { max-height: calc(100vh - 20px); }
  .rule-guide__header, .rule-guide__step { padding-right: 14px; padding-left: 14px; }
  .rule-guide__fields, .rule-guide__intent-grid { grid-template-columns: 1fr; }
  .rule-guide__wide { grid-column: auto; }
}
</style>
