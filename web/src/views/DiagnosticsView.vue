<script setup lang="ts">
import { CheckCircle2, Clock3, GitBranch, Network, Play, Server, ShieldCheck } from '@lucide/vue'
import { computed, ref } from 'vue'
import { apiRequest, jsonBody } from '../api/client'
import type { DnsDiagnostic } from '../api/types'
import { useToast } from '../composables/useToast'
import { errorMessage } from '../utils'

const domain = ref('example.com')
const recordType = ref('A')
const running = ref(false)
const result = ref<DnsDiagnostic | null>(null)
const toast = useToast()
const types = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'PTR']
const stageNames: Record<string, string> = {
  request: '请求',
  pipeline: '管线',
  response_cache: '响应缓存',
  rule_cache: '规则缓存',
  rules: '候选规则',
  rule: '规则',
  decision: '动作',
  upstream: '上游',
  response_rule: '响应规则',
}
const matchedRules = computed(() => [...new Set((result.value?.trace ?? [])
  .filter((step) => step.stage === 'rule' && step.status === 'matched')
  .map((step) => step.label))])
const selectedPipeline = computed(() => result.value?.trace
  .find((step) => step.stage === 'pipeline' && step.status === 'selected')?.label)

async function run(): Promise<void> {
  running.value = true
  result.value = null
  try {
    result.value = await apiRequest<DnsDiagnostic>('/api/v1/diagnostics/dns', {
      method: 'POST',
      ...jsonBody({ domain: domain.value.trim(), record_type: recordType.value }),
    })
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    running.value = false
  }
}
</script>

<template>
  <div class="page diagnostics-page">
    <div class="diagnostics-layout">
      <section class="panel diagnostic-form-panel">
        <header class="panel__header"><div><h2>发起 DNS 查询</h2><p>由 KixDNS 内部执行并解释实际规则路径</p></div><Network :size="20" /></header>
        <form class="diagnostic-form" @submit.prevent="run">
          <label>域名<input v-model.trim="domain" type="text" inputmode="url" maxlength="253" required placeholder="example.com" /></label>
          <fieldset><legend>记录类型</legend><div class="segmented"><label v-for="type in types" :key="type"><input v-model="recordType" type="radio" :value="type" /><span>{{ type }}</span></label></div></fieldset>
          <button class="button button--primary button--full" type="submit" :disabled="running"><Play :size="16" />{{ running ? '查询中' : '执行查询' }}</button>
        </form>
        <div class="security-note"><ShieldCheck :size="17" /><p><strong>安全诊断</strong><span>只能查询当前 KixDNS 配置，不能指定任意 DNS 服务器。</span></p></div>
      </section>

      <section class="panel diagnostic-result-panel">
        <header class="panel__header"><div><h2>响应结果</h2><p>{{ result ? `${result.domain} · ${result.record_type}` : '等待查询' }}</p></div><span v-if="result" class="tag tag--success">{{ result.response_code }}</span></header>
        <div v-if="running" class="diagnostic-running"><span></span><strong>正在等待 DNS 响应</strong></div>
        <div v-else-if="result" class="diagnostic-result">
          <div class="diagnostic-stats"><div><Server :size="17" /><span>服务器</span><strong class="mono">{{ result.server }}</strong></div><div><Clock3 :size="17" /><span>耗时</span><strong>{{ result.elapsed_ms }} ms</strong></div><div><CheckCircle2 :size="17" /><span>截断</span><strong>{{ result.truncated ? '是' : '否' }}</strong></div></div>
          <div v-if="result.trace_supported" class="diagnostic-match-summary">
            <GitBranch :size="17" />
            <div><span>命中规则</span><strong>{{ matchedRules.length ? matchedRules.join('、') : '未命中具体规则' }}</strong></div>
            <small v-if="selectedPipeline">Pipeline · {{ selectedPipeline }}</small>
          </div>
          <div class="answer-list"><h3>Answer</h3><code v-for="answer in result.answers" :key="answer">{{ answer }}</code><p v-if="result.answers.length === 0" class="empty-state">响应中没有 Answer 记录</p></div>
          <div v-if="result.trace_supported" class="trace-panel">
            <div class="trace-panel__header"><div><GitBranch :size="17" /><h3>规则执行路径</h3></div><span>{{ result.trace.length }} 步</span></div>
            <ol class="trace-list">
              <li v-for="(step, index) in result.trace" :key="`${index}-${step.stage}-${step.label}`" :class="`trace-step trace-step--${step.status}`">
                <span class="trace-step__dot"></span>
                <div class="trace-step__content"><div><span class="trace-step__stage">{{ stageNames[step.stage] ?? step.stage }}</span><strong>{{ step.label }}</strong><time>+{{ step.elapsed_ms }} ms</time></div><p v-if="step.detail">{{ step.detail }}</p></div>
              </li>
            </ol>
            <p v-if="result.trace_truncated" class="trace-note">轨迹过长，仅显示前 128 步。</p>
          </div>
          <div v-else class="trace-fallback"><GitBranch :size="17" /><p><strong>当前内核仅支持基础查询</strong><span>升级到包含 diagnostics_trace_v1 的增强版后，可查看规则命中与上游路径。</span></p></div>
        </div>
        <div v-else class="diagnostic-placeholder"><Network :size="30" /><p>查询结果会显示在这里</p></div>
      </section>
    </div>
  </div>
</template>
