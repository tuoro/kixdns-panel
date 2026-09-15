<script setup lang="ts">
import { LoaderCircle, Network, Play, TriangleAlert } from '@lucide/vue'
import { computed, ref, useId } from 'vue'
import { apiRequest, jsonBody } from '../api/client'
import type { DnsDiagnostic } from '../api/types'
import { useToast } from '../composables/useToast'
import { describeResolution, isDnsSuccess, parseDnsAnswer, summarizeTrace, traceStageNames, traceStatusNames, traceTone } from '../diagnostics'
import { errorMessage } from '../utils'

const domain = ref('example.com')
const recordType = ref('A')
const running = ref(false)
const result = ref<DnsDiagnostic | null>(null)
const queryError = ref('')
const toast = useToast()
const id = useId()
const types = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'PTR']
const steps = computed(() => result.value?.trace_supported ? result.value.trace : [])
const traceSummary = computed(() => summarizeTrace(steps.value))
const resolution = computed(() => describeResolution(traceSummary.value))
const answers = computed(() => result.value?.answers.map((raw) => ({ raw, fields: parseDnsAnswer(raw) })) ?? [])
const successful = computed(() => result.value !== null && isDnsSuccess(result.value.response_code))

async function run(): Promise<void> {
  if (running.value) return
  running.value = true
  result.value = null
  queryError.value = ''
  try {
    result.value = await apiRequest<DnsDiagnostic>('/api/v1/diagnostics/dns', {
      method: 'POST',
      ...jsonBody({ domain: domain.value.trim(), record_type: recordType.value }),
    })
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
      <button class="diag-run" type="submit" :disabled="running" :aria-label="running ? '正在查询' : '执行查询'"><LoaderCircle v-if="running" class="diag-spinner" :size="16" /><Play v-else :size="15" /><span class="diag-run-desktop">{{ running ? '正在查询…' : '执行查询' }}</span><span class="diag-run-mobile" aria-hidden="true">{{ running ? '查询中' : '查询' }}</span></button>
      <p :id="id + '-scope'" class="diag-scope">仅查询当前 KixDNS，使用当前运行配置</p>
    </form>

    <!-- 等待时给骨架而不是转圈：骨架的分块和结果一致，数据到达时版面不跳。 -->
    <div v-if="running" class="diag-skeleton" role="status" aria-label="正在等待 DNS 响应">
      <div class="sk diag-skeleton-verdict"></div>
      <div class="diag-skeleton-trace">
        <div class="diag-skeleton-rail"><i v-for="n in 5" :key="n" class="sk"></i></div>
        <div class="sk diag-skeleton-detail"></div>
      </div>
    </div>
    <div v-else-if="queryError" class="diag-error" role="alert"><TriangleAlert :size="20" /><div><h2>查询失败</h2><p>{{ queryError }}</p><small>检查域名或服务状态后可重新查询。</small></div></div>
    <div v-else-if="result" class="diagnostic-result diag-result">
      <!-- 结论带一行回答「成了没有、走了谁、多久」，这是这页最先要看到的东西。 -->
      <p class="diag-status" role="status" :class="{ 'diag-status--notice': !successful }">
        <strong>{{ result.response_code }}</strong>
        <span v-if="resolution" class="diag-resolution">{{ resolution }}</span>
        <span v-else class="diag-resolution diag-resolution--bare">{{ result.domain }} · {{ result.record_type }}</span>
        <span class="diag-elapsed">{{ result.elapsed_ms }} ms</span>
      </p>

      <div class="diag-trace-layout">
        <section v-if="result.trace_supported" class="diag-trace" aria-label="实际执行轨迹">
          <header class="diag-section-heading"><h2>规则执行路径</h2><span>{{ steps.length }} 个实际阶段</span></header>
          <!-- 每步的细节直接摊开：要点开才看得到的信息，等于没有显示。
               未命中的步骤灰掉但仍然占位——「没走缓存」本身就是信息。 -->
          <ol v-if="steps.length" class="diag-trace-list">
            <li v-for="(step, index) in steps" :key="index" class="diag-step" :class="['diag-step--' + traceTone(step.status), { 'diag-step--idle': ['miss', 'missed', 'skipped'].includes(step.status) }]">
              <span class="diag-step-stage">{{ traceStageNames[step.stage] ?? step.stage }}</span>
              <span class="diag-step-label">{{ step.label }}</span>
              <span class="diag-step-meta"><span class="diag-step-status">{{ traceStatusNames[step.status] ?? step.status }}</span><span class="diag-step-time">{{ step.elapsed_ms }} ms</span></span>
              <span v-if="step.detail" class="diag-step-detail">{{ step.detail }}</span>
            </li>
          </ol>
          <p v-else class="diag-note">本次查询没有返回执行轨迹。</p>
          <p v-if="result.trace_truncated" class="diag-trace-warning">执行轨迹已截断；当前展示的是部分阶段，不代表完整解析路径。</p>
          <p v-if="steps.length" class="diag-time-note">时间值由内核记录，不表示该阶段的独立耗时。</p>
        </section>
        <section v-else class="diag-trace-unavailable"><Network :size="18" /><div><h2>当前内核仅支持基础查询</h2><p>升级到包含 diagnostics_trace_v1 的增强版后，可查看规则命中与上游路径。</p></div></section>

        <div class="diag-detail">
          <dl class="diag-kv">
            <dt>查询名</dt><dd>{{ result.domain }}</dd>
            <dt>类型 / 类</dt><dd>{{ result.record_type }} / IN</dd>
            <dt>命中规则</dt>
            <dd class="diagnostic-match-summary diag-match">
              <ul v-if="traceSummary.matchedRules.length"><li v-for="rule in traceSummary.matchedRules" :key="rule"><i aria-hidden="true"></i><strong>{{ rule }}</strong></li></ul>
              <strong v-else class="diag-no-match">{{ result.trace_supported ? traceSummary.emptyMatchLabel : '当前内核未提供规则轨迹' }}</strong>
              <small v-if="traceSummary.pipelines.length">Pipeline · {{ traceSummary.pipelines.join('、') }}</small>
            </dd>
            <dt>上游</dt><dd>{{ traceSummary.upstreams.length ? traceSummary.upstreams.join('、') : '本次未走上游' }}</dd>
          </dl>

          <section class="diag-answers" aria-label="应答记录">
            <header><h2>应答</h2><span>{{ answers.length }} 条记录 · {{ result.truncated ? '已截断' : '未截断' }}</span></header>
            <div v-if="answers.length" class="diag-answer-ledger">
              <div class="diag-answer-columns" aria-hidden="true"><span>记录</span><span>类型</span><span>TTL · 秒</span></div>
              <div v-for="(answer, index) in answers" :key="index" class="diag-answer-row" :class="{ 'diag-answer-row--raw': !answer.fields }">
                <template v-if="answer.fields"><code :class="{ 'diag-address': ['A', 'AAAA'].includes(answer.fields.type) }" :title="answer.fields.owner + ' · ' + answer.fields.dnsClass">{{ answer.fields.data }}</code><span class="diag-answer-type">{{ answer.fields.type }}</span><span class="diag-ttl">{{ answer.fields.ttl }}</span></template>
                <template v-else><code>{{ answer.raw }}</code><span class="diag-raw-label">原始记录</span></template>
              </div>
            </div>
            <p v-else class="diag-empty-answers">响应中没有 Answer 记录</p>
          </section>
        </div>
      </div>

      <details class="diag-raw-response"><summary><strong>原始响应</strong><span>{{ answers.length }} 条 DNS 记录</span></summary><div><p v-if="!answers.length">没有 Answer 记录。</p><pre v-for="(answer, index) in result.answers" :key="index">{{ answer }}</pre></div></details>
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
.diag-run:disabled { cursor: wait; opacity: .65; }
.diag-run-mobile { display: none; }
.diag-scope { grid-column: 1 / -1; color: var(--muted); font-size: 12px; }
.diag-result { min-width: 0; padding: 0; }
/* 结果区的块共用同一个圆角，集中声明一次，不在每条规则里各写一遍。
   The blocks in the result area share one radius, declared once here rather
   than repeated in every rule. */
.diag-status, .diag-kv, .diag-answer-ledger, .diag-empty-answers,
.diag-trace-unavailable { border-radius: 4px; }

/* 结论带：一行回答「成了没有、走了谁、多久」，这页最先要看到的东西。 */
.diag-status { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; padding: 14px 18px; background: var(--green-soft); box-shadow: inset 3px 0 var(--green); font-size: 14px; }
.diag-status > strong { color: var(--green); font: 600 17px/1.2 var(--mono); }
.diag-status--notice { background: var(--amber-soft); box-shadow: inset 3px 0 var(--amber); }
.diag-status--notice > strong { color: var(--amber); }
.diag-resolution { min-width: 0; color: var(--ink); overflow-wrap: anywhere; }
.diag-resolution--bare { font-family: var(--mono); font-size: 13px; }
.diag-elapsed { margin-left: auto; color: var(--muted); font: 14px var(--mono); }

/* 左轨右详情。轨道 260px 是窄到不浪费、宽到装得下上游地址的折中。 */
.diag-trace-layout { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 28px; margin-top: 20px; }
.diag-trace, .diag-detail { min-width: 0; }
.diag-section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.diag-section-heading h2 { font-size: 14px; font-weight: 600; }
.diag-section-heading > span { color: var(--muted); font-size: 12px; }

.diag-trace-list { margin: 0; padding: 0; list-style: none; }
/* 每步的细节直接摊开，不藏在点击后面；未命中的步骤灰掉但照样占位。 */
.diag-step { position: relative; display: grid; gap: 2px; padding: 10px 0 10px 20px; }
.diag-step::before { content: ''; position: absolute; top: 15px; left: 0; width: 9px; height: 9px; border-radius: 50%; background: var(--green); }
.diag-step::after { content: ''; position: absolute; top: 28px; bottom: -4px; left: 4px; width: 1px; background: var(--line); }
.diag-step:last-child::after { display: none; }
.diag-step--idle::before, .diag-step--neutral::before { background: var(--line); }
.diag-step--danger::before { background: var(--red); }
.diag-step--warning::before { background: var(--amber); }
.diag-step-stage { font-size: 13px; font-weight: 600; }
.diag-step--idle .diag-step-stage { color: var(--muted); font-weight: 500; }
.diag-step-label { min-width: 0; font: 12px/1.5 var(--mono); overflow-wrap: anywhere; }
.diag-step-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--muted); font-size: 12px; }
.diag-step-time { font-family: var(--mono); }
.diag-step--danger .diag-step-status { color: var(--red); }
.diag-step--warning .diag-step-status { color: var(--amber); }
.diag-step-detail { color: var(--muted); font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }

.diag-kv { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 8px 16px; padding: 14px 16px; background: var(--surface); font-size: 13px; }
.diag-kv dt { color: var(--muted); }
.diag-kv dd { margin: 0; min-width: 0; font-family: var(--mono); overflow-wrap: anywhere; }
.diag-match ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
.diag-match li { display: flex; align-items: center; gap: 7px; min-width: 0; }
.diag-match i { flex: 0 0 auto; width: 0; height: 0; border-top: 5px solid transparent; border-bottom: 5px solid transparent; border-left: 8px solid var(--ink); }
.diag-match strong { min-width: 0; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.diag-no-match { color: var(--muted); font-family: var(--mono); font-weight: 400; }
.diag-match small { display: block; margin-top: 6px; color: var(--muted); font-family: var(--mono); font-size: 12px; }

.diag-answers { margin-top: 20px; min-width: 0; }
.diag-answers > header { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.diag-answers h2 { font-size: 14px; font-weight: 600; }
.diag-answers > header > span { color: var(--muted); font-size: 12px; }
.diag-answer-ledger { background: var(--surface); overflow: hidden; }
.diag-answer-columns, .diag-answer-row { display: grid; grid-template-columns: minmax(0, 1fr) 68px 78px; gap: 12px; align-items: baseline; padding: 8px 14px; }
.diag-answer-columns { color: var(--muted); font-size: 11px; border-bottom: 1px solid var(--line); }
.diag-answer-row + .diag-answer-row { border-top: 1px solid var(--line); }
.diag-answer-row code { min-width: 0; font: 13px/1.6 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.diag-address { font-size: 14px; }
.diag-answer-type, .diag-ttl { color: var(--muted); font: 12px var(--mono); }
.diag-answer-row--raw { grid-template-columns: minmax(0, 1fr) auto; }
.diag-raw-label { color: var(--muted); font-size: 11px; }
.diag-empty-answers { padding: 14px; background: var(--surface); color: var(--muted); font-size: 13px; }

.diag-note, .diag-trace-warning, .diag-time-note { padding: 10px 0 0; color: var(--muted); font-size: 12px; line-height: 1.55; }
.diag-trace-warning { color: var(--amber); }
.diag-trace-unavailable { display: flex; align-items: flex-start; gap: 10px; padding: 14px 16px; background: var(--surface); color: var(--muted); }
.diag-trace-unavailable svg { flex: 0 0 auto; }
.diag-trace-unavailable h2 { margin-bottom: 5px; color: var(--ink); font-size: 14px; }
.diag-trace-unavailable p { font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }

/* 骨架的分块和结果一致，数据到达时版面不跳。 */
.diag-skeleton { display: grid; gap: 20px; }
.diag-skeleton-verdict { height: 52px; }
.diag-skeleton-trace { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 28px; }
.diag-skeleton-rail { display: grid; gap: 14px; align-content: start; }
.diag-skeleton-rail i { height: 44px; }
.diag-skeleton-detail { min-height: 260px; }

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
  .diag-status { gap: 6px 12px; padding: 11px 13px; font-size: 13px; }
  .diag-status > strong { font-size: 15px; }
  .diag-elapsed { font-size: 13px; }
  /* 窄屏一列：详情排在轨道之前，因为「解析到了什么」比「怎么走的」更常被查。
     The single narrow column puts the detail above the rail: what resolved is
     looked up more often than how it got there. */
  .diag-trace-layout, .diag-skeleton-trace { grid-template-columns: minmax(0, 1fr); gap: 20px; margin-top: 16px; }
  .diag-detail { order: -1; }
  .diag-kv { grid-template-columns: 72px minmax(0, 1fr); gap: 7px 12px; padding: 12px 13px; font-size: 12px; }
  .diag-match strong { font-size: 13px; }
  .diag-answers { margin-top: 16px; }
  .diag-answer-columns, .diag-answer-row { grid-template-columns: minmax(0, 1fr) 46px 54px; gap: 8px; padding: 8px 12px; }
  .diag-answer-row code, .diag-answer-row code.diag-address { font-size: 13px; line-height: 1.5; }
  .diag-answer-type, .diag-ttl { font-size: 11px; }
  .diag-ttl { text-align: right; }
  .diag-answer-columns > :last-child { text-align: right; }
  .diag-answer-row--raw { grid-template-columns: minmax(0, 1fr) auto; }
  .diag-section-heading { margin-bottom: 8px; }
  .diag-step { padding: 9px 0 9px 18px; }
  .diag-step-label { font-size: 12px; }
  .diag-skeleton-rail i { height: 38px; }
  .diag-skeleton-detail { min-height: 200px; }
  .diag-raw-response summary { min-height: 44px; gap: 8px; font-size: 14px; }
  .diag-raw-response summary > span { margin-left: auto; }
  .diag-result-footer { font-size: 11px; }
}
</style>
