<script setup lang="ts">
import { CheckCircle2, Clock3, Network, Play, Server, ShieldCheck } from '@lucide/vue'
import { ref } from 'vue'
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
        <header class="panel__header"><div><h2>发起 DNS 查询</h2><p>请求固定发送到面板启动参数指定的服务器</p></div><Network :size="20" /></header>
        <form class="diagnostic-form" @submit.prevent="run">
          <label>域名<input v-model.trim="domain" type="text" inputmode="url" maxlength="253" required placeholder="example.com" /></label>
          <fieldset><legend>记录类型</legend><div class="segmented"><label v-for="type in types" :key="type"><input v-model="recordType" type="radio" :value="type" /><span>{{ type }}</span></label></div></fieldset>
          <button class="button button--primary button--full" type="submit" :disabled="running"><Play :size="16" />{{ running ? '查询中' : '执行查询' }}</button>
        </form>
        <div class="security-note"><ShieldCheck :size="17" /><p><strong>固定目标</strong><span>API 无法指定任意 DNS 服务器，避免面板成为网络探测入口。</span></p></div>
      </section>

      <section class="panel diagnostic-result-panel">
        <header class="panel__header"><div><h2>响应结果</h2><p>{{ result ? `${result.domain} · ${result.record_type}` : '等待查询' }}</p></div><span v-if="result" class="tag tag--success">{{ result.response_code }}</span></header>
        <div v-if="running" class="diagnostic-running"><span></span><strong>正在等待 DNS 响应</strong></div>
        <div v-else-if="result" class="diagnostic-result">
          <div class="diagnostic-stats"><div><Server :size="17" /><span>服务器</span><strong class="mono">{{ result.server }}</strong></div><div><Clock3 :size="17" /><span>耗时</span><strong>{{ result.elapsed_ms }} ms</strong></div><div><CheckCircle2 :size="17" /><span>截断</span><strong>{{ result.truncated ? '是' : '否' }}</strong></div></div>
          <div class="answer-list"><h3>Answer</h3><code v-for="answer in result.answers" :key="answer">{{ answer }}</code><p v-if="result.answers.length === 0" class="empty-state">响应中没有 Answer 记录</p></div>
        </div>
        <div v-else class="diagnostic-placeholder"><Network :size="30" /><p>查询结果会显示在这里</p></div>
      </section>
    </div>
  </div>
</template>
