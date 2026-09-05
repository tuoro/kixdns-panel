<script setup lang="ts">
import { CheckCircle2, ChevronDown, ChevronRight, LoaderCircle, Network, Play, TriangleAlert } from '@lucide/vue'
import { computed, ref, useId } from 'vue'
import { apiRequest, jsonBody } from '../api/client'
import type { DnsDiagnostic } from '../api/types'
import { useToast } from '../composables/useToast'
import { isDnsSuccess, parseDnsAnswer, summarizeTrace, traceStageNames, traceStatusNames, traceTone } from '../diagnostics'
import { errorMessage } from '../utils'

const domain = ref('example.com')
const recordType = ref('A')
const running = ref(false)
const result = ref<DnsDiagnostic | null>(null)
const queryError = ref('')
const selectedStep = ref<number | null>(null)
const toast = useToast()
const id = useId()
const types = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'PTR']
const steps = computed(() => result.value?.trace_supported ? result.value.trace : [])
const traceSummary = computed(() => summarizeTrace(steps.value))
const answers = computed(() => result.value?.answers.map((raw) => ({ raw, fields: parseDnsAnswer(raw) })) ?? [])
const successful = computed(() => result.value !== null && isDnsSuccess(result.value.response_code))

function toggleStep(index: number): void {
  selectedStep.value = selectedStep.value === index ? null : index
}

async function run(): Promise<void> {
  if (running.value) return
  running.value = true
  result.value = null
  queryError.value = ''
  selectedStep.value = null
  try {
    result.value = await apiRequest<DnsDiagnostic>('/api/v1/diagnostics/dns', {
      method: 'POST',
      ...jsonBody({ domain: domain.value.trim(), record_type: recordType.value }),
    })
    // 窄屏先展示完整轨迹，详情按需展开；两种布局仍共享同一选择状态。
    selectedStep.value = window.matchMedia('(max-width: 700px)').matches ? null : traceSummary.value.initialStep
  } catch (error) {
    queryError.value = errorMessage(error)
    toast.error(queryError.value)
  } finally {
    running.value = false
  }
}
</script>

<template>
  <div class="page diag-page">
    <header class="page-heading diag-heading">
      <div><h1>DNS 诊断</h1><p>查看一次请求的真实执行路径</p></div>
      <span>当前 KixDNS</span>
    </header>
    <form class="diag-query" aria-label="DNS 查询" @submit.prevent="run">
      <label class="diag-domain"><span class="diag-sr-only">域名</span><input v-model="domain" type="text" inputmode="url" maxlength="253" required placeholder="example.com" autocapitalize="none" :spellcheck="false" :aria-describedby="id + '-scope'" /></label>
      <label class="diag-record-type"><span class="diag-sr-only">记录类型</span><select v-model="recordType" aria-label="记录类型"><option v-for="type in types" :key="type" :value="type">{{ type }}</option></select></label>
      <button class="diag-run" type="submit" :disabled="running" :aria-label="running ? '查询中' : '执行查询'"><LoaderCircle v-if="running" class="diag-spinner" :size="16" /><Play v-else :size="15" /><span class="diag-run-desktop">{{ running ? '查询中' : '执行查询' }}</span><span class="diag-run-mobile" aria-hidden="true">{{ running ? '查询中' : '查询' }}</span></button>
      <p :id="id + '-scope'" class="diag-scope">仅查询当前 KixDNS，使用当前运行配置</p>
    </form>

    <div v-if="running" class="diag-placeholder" role="status"><LoaderCircle class="diag-spinner" :size="24" /><strong>正在等待 DNS 响应</strong></div>
    <div v-else-if="queryError" class="diag-error" role="alert"><TriangleAlert :size="20" /><div><h2>查询失败</h2><p>{{ queryError }}</p><small>检查域名或服务状态后可重新查询。</small></div></div>
    <div v-else-if="result" class="diagnostic-result diag-result">
      <section class="diag-outcome" aria-label="本次 DNS 应答">
        <header class="diag-status" role="status" :class="{ 'diag-status--notice': !successful }">
          <span class="diag-status-label"><CheckCircle2 v-if="successful" :size="16" /><TriangleAlert v-else :size="16" />{{ successful ? '查询完成' : '收到 DNS 响应' }}</span>
          <span class="diag-query-label">{{ result.domain }} · {{ result.record_type }}</span>
          <strong>{{ result.response_code }}</strong><span class="diag-elapsed">{{ result.elapsed_ms }} ms</span>
        </header>
        <div class="diag-summary">
          <section class="diag-answers" aria-label="应答记录">
            <header><h2>应答</h2><span>{{ answers.length }} 条记录 · {{ result.truncated ? '已截断' : '未截断' }}</span></header>
            <div v-if="answers.length" class="diag-answer-ledger">
              <div class="diag-answer-columns" aria-hidden="true"><span>类型</span><span>记录</span><span>TTL · 秒</span></div>
              <div v-for="(answer, index) in answers" :key="index" class="diag-answer-row" :class="{ 'diag-answer-row--raw': !answer.fields }">
                <template v-if="answer.fields"><span class="diag-answer-type">{{ answer.fields.type }}</span><code :class="{ 'diag-address': ['A', 'AAAA'].includes(answer.fields.type) }" :title="answer.fields.owner + ' · ' + answer.fields.dnsClass">{{ answer.fields.data }}</code><span class="diag-ttl">{{ answer.fields.ttl }}</span></template>
                <template v-else><span class="diag-raw-label">原始记录</span><code>{{ answer.raw }}</code></template>
              </div>
            </div>
            <p v-else class="diag-empty-answers">响应中没有 Answer 记录</p>
          </section>
          <section class="diagnostic-match-summary diag-match" aria-label="实际命中规则">
            <div class="diag-match-main"><span>命中规则</span><ul v-if="traceSummary.matchedRules.length"><li v-for="rule in traceSummary.matchedRules" :key="rule"><i aria-hidden="true"></i><strong>{{ rule }}</strong></li></ul><strong v-else class="diag-no-match">{{ result.trace_supported ? traceSummary.emptyMatchLabel : '当前内核未提供规则轨迹' }}</strong></div>
            <small v-if="traceSummary.pipelines.length">Pipeline · {{ traceSummary.pipelines.join('、') }}</small>
          </section>
        </div>
      </section>

      <section v-if="result.trace_supported" class="diag-trace" aria-label="实际执行轨迹">
        <header class="diag-section-heading"><h2>规则执行路径</h2><span>{{ steps.length }} 个实际阶段</span></header>
        <ol v-if="steps.length" class="diag-trace-list" :style="{ '--diag-columns': Math.min(steps.length, 6) }">
          <li v-for="(step, index) in steps" :key="index" class="diag-step-item">
            <button :id="id + '-step-' + index" class="diag-step" :class="[{ 'diag-step--active': selectedStep === index, 'diag-step--matched': step.stage === 'rule' && step.status === 'matched' }, 'diag-step--' + traceTone(step.status)]" type="button" :aria-expanded="selectedStep === index" :aria-controls="id + '-detail-' + index" @click="toggleStep(index)">
              <span class="diag-step-index">{{ String(index + 1).padStart(2, '0') }}</span><span class="diag-step-stage">{{ traceStageNames[step.stage] ?? step.stage }}</span><span class="diag-step-label">{{ step.label }}</span><ChevronDown v-if="selectedStep === index" class="diag-step-chevron" :size="15" /><ChevronRight v-else class="diag-step-chevron" :size="15" />
            </button>
            <div v-show="selectedStep === index" :id="id + '-detail-' + index" class="diag-step-detail" role="region" :aria-labelledby="id + '-step-' + index">
              <header><span>{{ String(index + 1).padStart(2, '0') }} / {{ traceStageNames[step.stage] ?? step.stage }}阶段</span><span class="diag-step-status" :class="'diag-step-status--' + traceTone(step.status)">{{ traceStatusNames[step.status] ?? step.status }}</span></header>
              <h3>{{ step.label }}</h3><p v-if="step.detail" class="diag-step-description">{{ step.detail }}</p>
              <dl><div><dt>执行状态</dt><dd>{{ step.status }}</dd></div><div><dt>内核记录时间</dt><dd>{{ step.elapsed_ms }} ms</dd></div></dl>
              <p class="diag-time-note">时间值由内核记录，不表示该阶段的独立耗时。</p>
            </div>
          </li>
        </ol>
        <p v-else class="diag-note">本次查询没有返回执行轨迹。</p>
        <p v-if="result.trace_truncated" class="diag-trace-warning">执行轨迹已截断；当前展示的是部分阶段，不代表完整解析路径。</p>
      </section>
      <section v-else class="diag-trace-unavailable"><Network :size="18" /><div><h2>当前内核仅支持基础查询</h2><p>升级到包含 diagnostics_trace_v1 的增强版后，可查看规则命中与上游路径。</p></div></section>
      <details class="diag-raw-response"><summary><ChevronRight :size="16" /><strong>原始响应</strong><span>{{ answers.length }} 条 DNS 记录</span></summary><div><p v-if="!answers.length">没有 Answer 记录。</p><pre v-for="(answer, index) in result.answers" :key="index">{{ answer }}</pre></div></details>
      <footer class="diag-result-footer"><span>服务器 <code>{{ result.server }}</code></span><span>{{ result.trace_supported ? '轨迹来自本次实际执行' : '基础 DNS 查询结果' }}</span></footer>
    </div>
    <div v-else class="diag-placeholder"><Network :size="28" /><h2>从一次查询开始</h2><p>查看应答、命中规则与实际执行路径。</p></div>
  </div>
</template>

<style scoped>
.diag-page { min-width: 0; display: block; color: var(--ink); }
.diag-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.diag-heading h1 { font-size: 28px; line-height: 1.2; letter-spacing: -.04em; }
.diag-heading p, .diag-heading > span { color: var(--muted); font-size: 14px; }
.diag-heading p { margin-top: 8px; }
.diag-query { display: grid; grid-template-columns: minmax(0, 1fr) 116px 168px; gap: 8px 12px; margin-bottom: 20px; }
.diag-query label { min-width: 0; }
.diag-query input, .diag-query select { width: 100%; height: 44px; padding: 0 12px; border: 1px solid var(--line); border-radius: 4px; color: var(--ink); background: var(--surface); font: inherit; font-size: 15px; }
.diag-query :is(input, select, button):focus-visible, .diag-step:focus-visible, .diag-raw-response summary:focus-visible { outline: 2px solid var(--green); outline-offset: 3px; }
.diag-run { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 0 12px; border: 0; border-radius: 4px; background: var(--ink); color: #fff; font-weight: 650; font-size: 14px; cursor: pointer; }
.diag-run svg { color: var(--lime); }
.diag-run:disabled { cursor: wait; opacity: .65; }
.diag-run-mobile { display: none; }
.diag-scope { grid-column: 1 / -1; color: var(--muted); font-size: 12px; }
.diag-result { min-width: 0; padding: 0; }
.diag-outcome { overflow: hidden; color: #fff; background: var(--ink); border-radius: 4px; }
.diag-status { display: flex; align-items: center; gap: 16px; padding: 20px 28px 0; font-size: 14px; }
.diag-status-label { display: flex; align-items: center; gap: 6px; }
.diag-status-label svg { color: var(--lime); }
.diag-status--notice .diag-status-label svg { color: #e8b566; }
.diag-query-label { color: #bcc4bf; overflow-wrap: anywhere; }
.diag-status > strong { margin-left: auto; font-weight: 500; }
.diag-elapsed { white-space: nowrap; font-family: var(--mono); }
.diag-summary { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 28px; padding: 22px 28px 26px; }
.diag-answers, .diag-match { min-width: 0; }
.diag-answers > header { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.diag-answers h2 { font-size: 14px; font-weight: 600; }
.diag-answers > header > span { color: #bcc4bf; font-size: 12px; }
.diag-answer-columns { display: none; }
.diag-answer-row { display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; align-items: baseline; gap: 12px; padding: 8px 0; }
.diag-answer-row code { min-width: 0; font: 15px/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.diag-answer-row code.diag-address { font-size: clamp(20px, 2.2vw, 32px); line-height: 1.3; }
.diag-answer-type, .diag-ttl { font: 13px var(--mono); overflow-wrap: anywhere; }
.diag-ttl::before { content: 'TTL '; color: #bcc4bf; }
.diag-answer-row--raw { grid-template-columns: 1fr; gap: 4px; }
.diag-raw-label { color: #bcc4bf; font-size: 12px; }
.diag-empty-answers { padding: 18px 0; color: #bcc4bf; font-size: 14px; }
.diag-match { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 18px; margin: 0; padding: 0 0 0 28px; background: none; border: 0; border-left: 1px solid #46504a; }
.diag-match-main { min-width: 0; display: grid; gap: 12px; }
.diag-match-main > span, .diag-match small { color: #bcc4bf; font-size: 13px; white-space: normal; }
.diag-match ul { display: grid; gap: 10px; padding: 0; margin: 0; list-style: none; }
.diag-match li { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.diag-match i { flex: 0 0 auto; width: 0; height: 0; border-top: 6px solid transparent; border-bottom: 6px solid transparent; border-left: 9px solid var(--lime); }
.diag-match strong { min-width: 0; color: #fff; font: 600 clamp(19px, 2vw, 28px)/1.4 var(--mono); overflow-wrap: anywhere; }
.diag-match strong.diag-no-match { font-family: inherit; font-size: 17px; font-weight: 500; }
.diag-trace { margin-top: 24px; }
.diag-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.diag-section-heading h2 { font-size: 17px; font-weight: 650; }
.diag-section-heading > span { color: var(--muted); font-size: 13px; }
.diag-trace-list { display: grid; grid-template-columns: repeat(var(--diag-columns), minmax(0, 1fr)); margin: 0; padding: 0; list-style: none; }
.diag-step-item { display: contents; }
.diag-step { position: relative; min-width: 0; display: grid; justify-items: center; align-content: start; gap: 8px; padding: 8px 12px 20px; border: 0; border-bottom: 2px solid transparent; color: var(--ink); background: none; cursor: pointer; }
.diag-step::before { content: ''; position: absolute; top: 27px; left: 0; right: 0; height: 1px; background: var(--line); }
.diag-step-index { position: relative; z-index: 1; display: grid; place-items: center; width: 38px; height: 38px; border: 1px solid var(--line); border-radius: 50%; background: var(--canvas); font: 14px var(--mono); }
.diag-step-stage { max-width: 100%; overflow-wrap: anywhere; font-size: 14px; font-weight: 600; }
.diag-step-label { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px/1.4 var(--mono); }
.diag-step--active { border-bottom-color: var(--green); }
.diag-step--active .diag-step-index, .diag-step--matched .diag-step-index { color: var(--lime); background: var(--green); border-color: var(--green); }
.diag-step--danger .diag-step-index { color: #b23c36; background: #fff4f2; border-color: #b23c36; }
.diag-step-chevron { display: none; }
.diag-step-detail { order: 1; grid-column: 1 / -1; min-width: 0; padding: 20px 24px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.diag-step-detail > header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.diag-step-status { padding: 2px 6px; border: 1px solid var(--line); border-radius: 3px; }
.diag-step-status--success { color: var(--green); border-color: var(--green); }
.diag-step-status--warning { color: #9b6a22; }
.diag-step-status--danger { color: #b23c36; }
.diag-step-detail h3 { margin-top: 12px; font: 600 20px/1.4 var(--mono); overflow-wrap: anywhere; }
.diag-step-description { margin-top: 12px; color: var(--muted); font-size: 14px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.diag-step-detail dl { display: flex; flex-wrap: wrap; gap: 16px 48px; margin-top: 16px; }
.diag-step-detail dt { margin-bottom: 4px; color: var(--muted); font-size: 12px; }
.diag-step-detail dd { margin: 0; font: 14px var(--mono); }
.diag-time-note { margin-top: 12px; color: var(--muted); font-size: 12px; }
.diag-note, .diag-trace-warning { padding: 12px 0; color: var(--muted); font-size: 13px; }
.diag-trace-warning { color: #946b2c; }
.diag-trace-unavailable { display: flex; align-items: flex-start; gap: 10px; margin-top: 24px; padding: 16px 0; color: var(--muted); border-bottom: 1px solid var(--line); }
.diag-trace-unavailable svg { flex: 0 0 auto; }
.diag-trace-unavailable h2 { margin-bottom: 5px; color: var(--ink); font-size: 15px; }
.diag-trace-unavailable p { font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.diag-raw-response { border-bottom: 1px solid var(--line); }
.diag-raw-response summary { display: flex; align-items: center; gap: 12px; min-height: 52px; cursor: pointer; list-style: none; font-size: 14px; }
.diag-raw-response summary::-webkit-details-marker { display: none; }
.diag-raw-response[open] summary > svg { transform: rotate(90deg); }
.diag-raw-response summary > span { color: var(--muted); font-size: 12px; }
.diag-raw-response > div { padding-bottom: 16px; }
.diag-raw-response pre { margin: 8px 0; padding: 10px 12px; color: var(--ink); background: var(--surface); white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.6 var(--mono); }
.diag-result-footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 16px; padding: 12px 0; color: var(--muted); font-size: 12px; }
.diag-result-footer span { min-width: 0; overflow-wrap: anywhere; }
.diag-result-footer code { margin-left: 6px; font-family: var(--mono); }
.diag-placeholder { min-height: 280px; display: grid; justify-items: center; align-content: center; gap: 12px; color: var(--muted); border-block: 1px solid var(--line); }
.diag-placeholder h2, .diag-placeholder strong { color: var(--ink); font-size: 16px; font-weight: 600; }
.diag-placeholder p { font-size: 14px; }
.diag-error { display: flex; align-items: flex-start; gap: 12px; padding: 20px 0; color: #b23c36; border-block: 1px solid var(--line); }
.diag-error h2 { font-size: 17px; }
.diag-error p { margin-top: 8px; font-size: 14px; overflow-wrap: anywhere; }
.diag-error small { display: block; margin-top: 8px; color: var(--muted); font-size: 12px; }
.diag-spinner { animation: diag-spin 1s linear infinite; }
.diag-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@keyframes diag-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .diag-spinner { animation: none; } }
@media (max-width: 700px) {
  .diag-heading { gap: 8px; margin-bottom: 14px; }
  .diag-heading h1 { font-size: 20px; }
  .diag-heading p { display: none; }
  .diag-heading > span { font-size: 12px; }
  .diag-query { grid-template-columns: minmax(0, 1fr) 58px 76px; gap: 7px; margin-bottom: 16px; }
  .diag-query input, .diag-query select { padding-inline: 9px; font-size: 14px; }
  .diag-run { padding: 0 6px; gap: 5px; font-size: 13px; }
  .diag-run-desktop { display: none; }
  .diag-run-mobile { display: inline; }
  .diag-scope { font-size: 12px; }
  .diag-outcome { display: contents; }
  .diag-status { gap: 10px; min-height: 38px; padding: 0; margin-bottom: 12px; border-bottom: 1px solid var(--line); color: var(--ink); font-size: 12px; }
  .diag-status-label { font-size: 13px; }
  .diag-status-label svg { color: var(--green); }
  .diag-status > strong { overflow-wrap: anywhere; }
  .diag-query-label { display: none; }
  .diag-summary { display: flex; flex-direction: column; gap: 16px; padding: 0; }
  .diag-match { order: -1; flex-direction: row; align-items: center; justify-content: space-between; gap: 14px; padding: 12px; border: 0; border-radius: 4px; background: var(--ink); }
  .diag-match-main { gap: 5px; }
  .diag-match-main > span, .diag-match small { font-size: 12px; }
  .diag-match small { flex: 0 1 95px; text-align: right; overflow-wrap: anywhere; }
  .diag-match ul { gap: 5px; }
  .diag-match li { gap: 7px; }
  .diag-match strong { font-size: 15px; line-height: 1.4; }
  .diag-match strong.diag-no-match { font-size: 13px; }
  .diag-match i { border-top-width: 4px; border-bottom-width: 4px; border-left-width: 6px; }
  .diag-answers { color: var(--ink); }
  .diag-answers > header { margin-bottom: 8px; }
  .diag-answers > header > span { color: var(--muted); font-size: 12px; }
  .diag-answer-columns, .diag-answer-row { display: grid; grid-template-columns: 42px minmax(0, 1fr) 57px; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--line); }
  .diag-answer-columns { padding-top: 5px; color: var(--muted); font-size: 12px; }
  .diag-answer-row code, .diag-answer-row code.diag-address { font-size: 14px; line-height: 1.5; }
  .diag-answer-type, .diag-ttl { font-size: 12px; }
  .diag-ttl { text-align: right; }
  .diag-ttl::before { content: none; }
  .diag-answer-columns > :last-child { text-align: right; }
  .diag-answer-row--raw { grid-template-columns: 1fr; }
  .diag-raw-label, .diag-empty-answers { color: var(--muted); }
  .diag-trace { margin-top: 20px; }
  .diag-section-heading { margin-bottom: 8px; }
  .diag-section-heading h2 { font-size: 15px; }
  .diag-section-heading > span { font-size: 12px; }
  .diag-trace-list { display: block; }
  .diag-step-item { display: block; }
  .diag-step { width: 100%; min-height: 44px; grid-template-columns: 23px 68px minmax(0, 1fr) 15px; align-items: center; align-content: center; justify-items: start; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--line); text-align: left; }
  .diag-step::before { top: 0; bottom: 0; left: 11px; right: auto; width: 1px; height: auto; }
  .diag-step-index { width: 23px; height: 23px; font-size: 11px; }
  .diag-step-stage { font-size: 12px; font-weight: 500; }
  .diag-step-label { width: 100%; font-size: 14px; }
  .diag-step-chevron { display: block; color: var(--muted); }
  .diag-step--matched, .diag-step--active { background: color-mix(in srgb, var(--green) 5%, var(--canvas)); }
  .diag-step-detail { padding: 10px 10px 12px 31px; border-top: 0; }
  .diag-step-detail > header { font-size: 11px; }
  .diag-step-detail h3 { margin-top: 8px; font-size: 14px; font-weight: 500; }
  .diag-step-description { margin-top: 6px; font-size: 12px; }
  .diag-step-detail dl { gap: 10px 24px; margin-top: 10px; }
  .diag-step-detail dd, .diag-step-detail dt, .diag-time-note { font-size: 11px; }
  .diag-time-note { margin-top: 8px; }
  .diag-raw-response summary { min-height: 44px; gap: 8px; font-size: 14px; }
  .diag-raw-response summary > span { margin-left: auto; }
  .diag-result-footer { font-size: 11px; }
}
</style>
