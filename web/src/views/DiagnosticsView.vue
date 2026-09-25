<script setup lang="ts">
import { Check, ChevronDown, LoaderCircle, Network, Play, TriangleAlert, X } from '@lucide/vue'
import { computed, ref } from 'vue'
import { apiRequest, jsonBody } from '../api/client'
import type { DnsDiagnostic } from '../api/types'
import UiCard from '../components/ui/UiCard.vue'
import UiEmpty from '../components/ui/UiEmpty.vue'
import UiPageHeader from '../components/ui/UiPageHeader.vue'
import { useToast } from '../composables/useToast'
import { describeStep, groupTrace, isDnsSuccess, parseDnsAnswer, responseCodeName, resolutionParts, summarizeTrace, traceTone, type TextPart } from '../diagnostics'
import { errorMessage } from '../utils'

const domain = ref('example.com')
const recordType = ref('A')
const running = ref(false)
const result = ref<DnsDiagnostic | null>(null)
const queryError = ref('')
const toast = useToast()
const types = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'PTR']
const steps = computed(() => result.value?.trace_supported ? result.value.trace : [])
const traceSummary = computed(() => summarizeTrace(steps.value))
const resolution = computed(() => resolutionParts(traceSummary.value))
const answers = computed(() => result.value?.answers.map((raw) => ({ raw, fields: parseDnsAnswer(raw) })) ?? [])
const successful = computed(() => result.value !== null && isDnsSuccess(result.value.response_code))
const codeName = computed(() => (result.value ? responseCodeName(result.value.response_code) : ''))
// 结论带那句话：走了哪条规则、由谁应答；轨迹里没记下命中的规则时照实说「未记录规则匹配」，
// 不编一条。原来这句提醒在下面那块明细表里，明细表和结论重复，去掉了。
// The verdict: which rule, which upstream; when the trace recorded no matched
// rule it says so rather than inventing one. That caveat used to sit in the
// detail table below, which repeated the verdict and is gone.
const verdict = computed<TextPart[]>(() => {
  if (!result.value) return []
  const caveat = result.value.trace_supported && traceSummary.value.matchedRules.length === 0 ? '未记录规则匹配' : ''
  if (!resolution.value.length) return caveat ? [{ text: caveat }] : [{ text: result.value.domain, mono: true }, { text: ' · ' }, { text: result.value.record_type, mono: true }]
  return caveat ? [...resolution.value, { text: '，' + caveat }] : resolution.value
})
const stepIdle = (status: string) => ['miss', 'missed', 'skipped'].includes(status)
// 执行路径的每一行：一句话、一行细节、语气和时刻。连着的未命中规则并成一行。
// Each row of the path: a sentence, a detail line, a tone and a time. Consecutive missed rules share one row.
const rows = computed(() => groupTrace(steps.value).map((row) => {
  if (row.kind === 'step') return { ...describeStep(row.step), tone: traceTone(row.step.status), idle: stepIdle(row.step.status), elapsed: row.step.elapsed_ms }
  const names: TextPart[] = row.steps.flatMap((step, index) => (index ? [{ text: '、' }, { text: step.label, mono: true }] : [{ text: step.label, mono: true }]))
  return { lead: [{ text: `${row.steps.length} 条规则未命中` }], note: names, tone: 'neutral' as const, idle: true, elapsed: row.steps[row.steps.length - 1]!.elapsed_ms }
}))

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
    <UiPageHeader class="diag-heading" title="诊断">
      <template #meta><span>用当前运行配置解析一次请求，看它走了哪条路</span></template>
    </UiPageHeader>

    <!-- 查询条是这一页唯一的主操作；窄屏上三样照旧同一行，按钮只写「查询」。
         The query bar is this page's one primary action; on a narrow screen the
         three controls still share one row and the button just says 查询. -->
    <form class="diag-query" aria-label="DNS 查询" @submit.prevent="run">
      <label class="ui-input diag-domain"><span class="diag-sr-only">域名</span><input v-model="domain" type="text" inputmode="url" maxlength="253" required placeholder="example.com" autocapitalize="none" :spellcheck="false" /></label>
      <label class="ui-input diag-record-type"><span class="diag-sr-only">记录类型</span><select v-model="recordType" aria-label="记录类型"><option v-for="type in types" :key="type" :value="type">{{ type }}</option></select><ChevronDown :size="16" aria-hidden="true" /></label>
      <button class="ui-btn ui-btn--primary diag-run" type="submit" :disabled="running" :aria-label="running ? '正在查询' : '执行查询'"><LoaderCircle v-if="running" class="diag-spinner" :size="16" /><Play v-else :size="15" /><span class="diag-run-desktop">{{ running ? '正在查询…' : '执行查询' }}</span><span class="diag-run-mobile" aria-hidden="true">{{ running ? '查询中' : '查询' }}</span></button>
    </form>

    <!-- 等待时给骨架而不是转圈：骨架的分块和结果一致，数据到达时版面不跳。 -->
    <div v-if="running" class="diag-skeleton" role="status" aria-label="正在等待 DNS 响应">
      <div class="sk diag-skeleton-verdict"></div>
      <div class="diag-cards"><div class="sk diag-skeleton-card"></div><div class="sk diag-skeleton-card"></div></div>
    </div>
    <div v-else-if="queryError" class="diag-error" role="alert"><TriangleAlert :size="20" /><div><h2>查询失败</h2><p>{{ queryError }}</p><small>检查域名或服务状态后可重新查询。</small></div></div>
    <div v-else-if="result" class="diagnostic-result diag-result">
      <!-- 结论带一行回答「成了没有、走了谁、多久」，这是这页最先要看到的东西。 -->
      <p class="diag-status" role="status" :class="{ 'diag-status--notice': !successful }">
        <span class="ui-tag" :class="successful ? 'ui-tag--ok' : 'ui-tag--warn'">{{ codeName }}</span>
        <span class="diag-resolution diagnostic-match-summary"><template v-for="(part, at) in verdict" :key="at"><code v-if="part.mono">{{ part.text }}</code><template v-else>{{ part.text }}</template></template></span>
        <span class="diag-elapsed">{{ result.elapsed_ms }} ms</span>
      </p>

      <!-- 应答在上、执行路径在下，宽窄屏同一个顺序：「解析到了什么」比「怎么走的」更常被查。
           两张卡不再并排，也就没有一张短一张长、短的那张留一大块空白。
           Answer above, path below, at every width: what resolved is looked up more
           often than how. The cards no longer sit side by side, so there is no short
           card left with a block of empty space. -->
      <div class="diag-cards">
        <UiCard class="diag-answers" title="应答" :desc="`${answers.length} 条记录 · ${result.truncated ? '已截断' : '未截断'}`">
          <template v-if="answers.length">
            <div class="ui-rec-head diag-answer-columns" aria-hidden="true"><span>记录</span><span>类型</span><span>TTL</span></div>
            <div v-for="(answer, index) in answers" :key="index" class="ui-rec diag-answer-row" :class="{ 'diag-answer-row--raw': !answer.fields }">
              <template v-if="answer.fields"><code :title="answer.fields.owner + ' · ' + answer.fields.dnsClass">{{ answer.fields.data }}</code><span class="ui-tag ui-tag--mono diag-answer-type">{{ answer.fields.type }}</span><span class="diag-ttl-cell"><span class="diag-ttl">{{ answer.fields.ttl }}</span> 秒</span></template>
              <template v-else><code>{{ answer.raw }}</code><span class="diag-raw-label">原始记录</span></template>
            </div>
          </template>
          <p v-else class="diag-empty-answers">响应中没有 Answer 记录</p>
          <details class="diag-raw-response"><summary><span>原始响应</span><span class="diag-raw-count">{{ answers.length }} 条 DNS 记录</span><ChevronDown :size="16" aria-hidden="true" /></summary><div><p v-if="!answers.length">没有 Answer 记录。</p><pre v-for="(answer, index) in result.answers" :key="index">{{ answer }}</pre></div></details>
          <!-- 谁应答的写在应答卡的脚上：两张卡等高，两条脚落在同一条线上。
               Who answered sits in the answer card's foot: the two cards are equal
               height and their feet share one line. -->
          <template #foot><span class="diag-server">服务器 <code>{{ result.server }}</code></span></template>
        </UiCard>
        <UiCard v-if="result.trace_supported" class="diag-trace" title="执行路径" desc="这一次请求在内核里实际走过的步骤">
          <!-- 每步的细节直接摊开：要点开才看得到的信息，等于没有显示。
               未命中的步骤灰掉但仍然占位——「没走缓存」本身就是信息。 -->
          <!-- 每一步是一句话，名字用等宽；以前是「阶段名 + 内核标签」，标签本身是句子时就说两遍。
               Each step is one sentence with names in mono; "stage + kernel label" said things twice when the label was already a sentence. -->
          <ol v-if="rows.length" class="diag-steps">
            <li v-for="(row, index) in rows" :key="index" class="diag-step" :class="['diag-step--' + row.tone, { 'diag-step--idle': row.idle }]">
              <span class="diag-step-time">{{ row.elapsed }} ms</span>
              <span class="diag-step-mark" aria-hidden="true"><Check v-if="row.tone === 'success'" :size="12" /><X v-else-if="row.tone === 'danger'" :size="12" /><i v-else></i></span>
              <div class="diag-step-body">
                <p class="diag-step-what"><template v-for="(part, at) in row.lead" :key="at"><code v-if="part.mono">{{ part.text }}</code><template v-else>{{ part.text }}</template></template></p>
                <p v-if="row.note.length" class="diag-step-why"><template v-for="(part, at) in row.note" :key="at"><code v-if="part.mono">{{ part.text }}</code><template v-else>{{ part.text }}</template></template></p>
              </div>
            </li>
          </ol>
          <p v-else class="diag-note">本次查询没有返回执行轨迹。</p>
          <p v-if="result.trace_truncated" class="diag-trace-warning">执行轨迹已截断；当前展示的是部分阶段，不代表完整解析路径。</p>
          <template v-if="steps.length" #foot><span class="diag-time-note">左边的时间是从请求开始累计的时刻，不表示该阶段的独立耗时。</span></template>
        </UiCard>
        <UiCard v-else class="diag-trace-unavailable">
          <UiEmpty :icon="Network" title="当前内核仅支持基础查询" desc="升级到包含 diagnostics_trace_v1 的增强版后，可查看规则命中与上游路径。" />
        </UiCard>

      </div>
    </div>
    <UiCard v-else class="diag-placeholder"><UiEmpty :icon="Network" title="从一次查询开始" desc="查看应答、命中规则与实际执行路径。" /></UiCard>
  </div>
</template>

<style scoped>
/* 诊断页只引用 tokens.css 的变量；零件来自 components.css，这里只管排版和执行路径的样子。
   Tokens only; the parts come from components.css and this lays them out and draws the path. */
.diag-page { min-width: 0; display: grid; gap: var(--s-5); align-content: start; }
.diag-query { display: grid; grid-template-columns: minmax(0, 1fr) 112px auto; gap: var(--s-2); }
.diag-query input { font-family: var(--mono); }
.diag-record-type select { min-width: 0; flex: 1; padding: 0; border: 0; outline: 0; background: transparent; color: var(--l-ink); font-size: var(--t-3); appearance: none; cursor: pointer; }
.diag-record-type { position: relative; }
.diag-record-type:focus-within { border-color: var(--l-ink); }
.diag-run-mobile { display: none; }
.diag-spinner { animation: ui-spin var(--m-spin) linear infinite; }
.diag-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

.diag-status { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); margin: 0; padding: var(--s-3) var(--s-4); border-radius: var(--r-3); background: var(--ok-tint-l); color: var(--l-ink); font-size: var(--t-3); }
.diag-status--notice { background: var(--warn-tint-l); }
.diag-status .ui-tag { font-family: var(--mono); }
.diag-resolution { min-width: 0; flex: 1; font-size: var(--t-3); overflow-wrap: anywhere; }
/* 结论里的名字和地址用等宽，和执行路径一致 / Names and addresses in the verdict are mono, as in the path */
.diag-resolution code { font-family: var(--mono); }
.diag-elapsed { margin-left: auto; color: var(--l-ink-2); font-family: var(--mono); font-size: var(--t-2); }

.diag-cards { display: grid; gap: var(--s-4); }

.diag-steps { display: grid; margin: 0; padding: 0; list-style: none; }
.diag-step { --time-w: calc(var(--s-7) + var(--s-2)); position: relative; display: grid; grid-template-columns: var(--time-w) var(--s-5) minmax(0, 1fr); gap: var(--s-3); padding: var(--s-2) 0; }
/* 时刻在左、像日志的时间戳；竖线穿过圆点那一栏 / Time on the left like a log timestamp; the rail runs through the mark column */
.diag-step::before { position: absolute; top: calc(var(--s-2) + var(--s-5)); bottom: calc(var(--s-2) * -1); left: calc(var(--time-w) + var(--s-3) + var(--s-5) / 2); border-left: 1px solid var(--l-hair); content: ''; }
.diag-step:last-child::before { display: none; }
.diag-step-mark { position: relative; z-index: 1; width: var(--s-5); height: var(--s-5); display: grid; place-items: center; border-radius: var(--r-full); background: var(--l-sunk); color: var(--l-ink-3); }
.diag-step-mark i { width: var(--size-dot); height: var(--size-dot); border-radius: var(--r-full); background: var(--l-ink-3); }
.diag-step--success .diag-step-mark { background: var(--ok-tint-l); color: var(--ok-l); }
.diag-step--danger .diag-step-mark { background: var(--err-tint-l); color: var(--err-l); }
.diag-step--warning .diag-step-mark i { background: var(--warn-l); }
.diag-step-body { min-width: 0; display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 2px var(--s-5); align-items: baseline; }
.diag-step-what { margin: 0; color: var(--l-ink); font-size: var(--t-2); font-weight: var(--w-medium); overflow-wrap: anywhere; }
.diag-step-why { margin: 0; color: var(--l-ink-3); font-size: var(--t-1); white-space: pre-wrap; overflow-wrap: anywhere; }
.diag-step-what code, .diag-step-why code { font-family: var(--mono); font-weight: var(--w-normal); }
/* 名字是一个整体：放不下就整个换到下一行，比一行还长才从中间断，不在连字符处拆开 lan-hosts。
   A name moves as a whole: it wraps to the next line when it does not fit and
   only breaks inside when longer than a line, so lan-hosts is not split at the hyphen. */
.diag-step-what code, .diag-step-why code, .diag-resolution code { display: inline-block; max-width: 100%; overflow-wrap: anywhere; }
.diag-step-why code { color: var(--l-ink-2); }
.diag-step--idle .diag-step-what { color: var(--l-ink-3); font-weight: var(--w-normal); }
.diag-step--danger .diag-step-what { color: var(--err-l); }
.diag-step--warning .diag-step-what { color: var(--warn-l); }
.diag-step-time, .diag-step-body { align-self: baseline; }
.diag-step-time { color: var(--l-ink-3); font-family: var(--mono); font-size: var(--t-1); text-align: right; white-space: nowrap; }
.diag-note, .diag-trace-warning { margin: 0; color: var(--l-ink-3); font-size: var(--t-2); }
.diag-trace-warning { margin-top: var(--s-2); color: var(--warn-l); }

.diag-answer-row, .diag-answer-columns { --rec-cols: minmax(0, 1fr) auto 72px; }
.diag-answer-row { min-height: var(--h-md); }
.diag-answer-row code { min-width: 0; color: var(--l-ink); font-family: var(--mono); font-size: var(--t-3); white-space: pre-wrap; overflow-wrap: anywhere; }
.diag-answer-row--raw { --rec-cols: minmax(0, 1fr) auto; }
.diag-ttl-cell { color: var(--l-ink-3); font-size: var(--t-1); text-align: right; white-space: nowrap; }
.diag-ttl { color: var(--l-ink-2); font-family: var(--mono); font-size: var(--t-2); }
.diag-raw-label { color: var(--l-ink-3); font-size: var(--t-1); }
.diag-empty-answers { margin: 0; padding: var(--s-3) 0; color: var(--l-ink-3); font-size: var(--t-2); }
.diag-raw-response { margin-top: var(--s-2); border-top: 1px solid var(--l-hair); }
.diag-raw-response summary { min-height: var(--h-touch); display: flex; align-items: center; gap: var(--s-2); color: var(--l-ink); font-size: var(--t-3); list-style: none; cursor: pointer; }
.diag-raw-response summary::-webkit-details-marker { display: none; }
.diag-raw-response summary > svg { color: var(--l-ink-3); transition: transform var(--m-base) var(--ease-out); }
.diag-raw-response[open] summary > svg { transform: rotate(180deg); }
.diag-raw-count { margin-left: auto; color: var(--l-ink-3); font-size: var(--t-1); }
.diag-raw-response pre { margin: 0 0 var(--s-2); padding: var(--s-2) var(--s-3); border-radius: var(--r-2); background: var(--l-canvas); color: var(--l-ink); font-family: var(--mono); font-size: var(--t-2); white-space: pre-wrap; overflow-wrap: anywhere; }

.diag-server { min-width: 0; overflow-wrap: anywhere; }
.diag-server code { margin-left: var(--s-1); color: var(--l-ink-2); font-family: var(--mono); }
.diag-result { display: grid; gap: var(--s-4); }

.diag-error { display: flex; align-items: flex-start; gap: var(--s-3); padding: var(--s-4) var(--s-5); border: 1px solid var(--err-line-l); border-radius: var(--r-3); background: var(--err-tint-l); color: var(--err-l); }
.diag-error h2 { margin: 0; font-size: var(--t-4); }
.diag-error p { margin: var(--s-2) 0 0; font-size: var(--t-3); overflow-wrap: anywhere; }
.diag-error small { display: block; margin-top: var(--s-2); color: var(--l-ink-3); font-size: var(--t-1); }

.diag-skeleton { display: grid; gap: var(--s-4); }
.diag-skeleton-verdict { height: var(--s-7); }
.diag-skeleton-card { min-height: calc(var(--s-8) * 4); }

@media (max-width: 640px) {
  .diag-query { grid-template-columns: minmax(0, 1fr) 76px auto; }
  .diag-record-type { padding-inline: var(--s-2); }
  .diag-run { padding-inline: var(--s-3); }
  .diag-run-desktop { display: none; }
  .diag-run-mobile { display: inline; }
  .diag-status { padding: var(--s-3); font-size: var(--t-2); }
  .diag-resolution { flex-basis: 100%; order: 3; font-size: var(--t-2); }
  /* 宽屏上一步一行（这句话 | 细节），手机上细节回到下一行。
     A wide screen gives each step one row (sentence | detail); a phone puts the detail back underneath. */
  .diag-step-body { grid-template-columns: minmax(0, 1fr); }
  /* 组件库在窄屏把记录行收成两栏；应答行三格都要留在一行 / The kit folds rows to two columns on a phone; an answer keeps all three */
  .diag-answer-row { --rec-cols: minmax(0, 1fr) auto auto; }
  .diag-answer-row--raw { --rec-cols: minmax(0, 1fr) auto; }
}
</style>
