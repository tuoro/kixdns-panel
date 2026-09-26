<script setup lang="ts">
import { Check, ChevronDown, LoaderCircle, Network, Play, TriangleAlert, X } from '@lucide/vue'
import { computed, ref } from 'vue'
import { apiRequest, jsonBody } from '../api/client'
import type { DnsDiagnostic } from '../api/types'
import UiCard from '../components/ui/UiCard.vue'
import UiEmpty from '../components/ui/UiEmpty.vue'
import UiPageHeader from '../components/ui/UiPageHeader.vue'
import { useToast } from '../composables/useToast'
import { describeStep, formatElapsed, forwardTarget, groupTrace, isDnsSuccess, parseDnsAnswer, responseCodeName, traceTone, type TextPart } from '../diagnostics'
import { errorMessage } from '../utils'

const domain = ref('example.com')
const recordType = ref('A')
const running = ref(false)
const result = ref<DnsDiagnostic | null>(null)
const queryError = ref('')
const toast = useToast()
const types = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'PTR']
const steps = computed(() => result.value?.trace_supported ? result.value.trace : [])
const answers = computed(() => result.value?.answers.map((raw) => ({ raw, fields: parseDnsAnswer(raw) })) ?? [])
const successful = computed(() => result.value !== null && isDnsSuccess(result.value.response_code))
const codeName = computed(() => (result.value ? responseCodeName(result.value.response_code) : ''))
const rawOpen = ref(false)
// 记录都同一类型、同一 TTL 时只写一次，否则跟在每条后面。
// When every record shares one type and TTL it is stated once; otherwise after each record.
const uniformMeta = computed(() => {
  const fields = answers.value.map((answer) => answer.fields)
  if (!fields.length || fields.some((field) => !field)) return ''
  const types = new Set(fields.map((field) => field!.type))
  const ttls = new Set(fields.map((field) => field!.ttl))
  return types.size === 1 && ttls.size === 1 ? `${[...types][0]} · TTL ${[...ttls][0]} 秒` : ''
})
// 值都不长时横排成大字；有长 TXT 或认不出的原串时竖排、正常字号。
// Short values flow in large type; a long TXT or an unparsed record stacks at normal size.
const leadMode = computed(() => answers.value.every((answer) => answer.fields && answer.fields.data.length <= 45))
const stepIdle = (status: string) => ['miss', 'missed', 'skipped'].includes(status)
// 执行路径的每一行：一句话、一行细节、语气和时刻。连着的未命中规则并成一行。
// Each row of the path: a sentence, a detail line, a tone and a time. Consecutive missed rules share one row.
const rows = computed(() => {
  // 记着上一次转给了谁，上游应答时就不用再写一遍地址。 / Remember the last forward target so the reply need not repeat the address.
  let target: string | null = null
  return groupTrace(steps.value).map((row) => {
  if (row.kind === 'step') {
    const view = { ...describeStep(row.step, { target }), tone: traceTone(row.step.status), idle: stepIdle(row.step.status), elapsed: (row.sent ?? row.step).elapsed_ms }
    target = forwardTarget(row.sent ?? row.step) ?? target
    return view
  }
  const names: TextPart[] = row.steps.flatMap((step, index) => (index ? [{ text: '、' }, { text: step.label, mono: true }] : [{ text: step.label, mono: true }]))
  return { lead: [{ text: `${row.steps.length} 条规则未命中` }], note: names, tone: 'neutral' as const, idle: true, elapsed: row.steps[row.steps.length - 1]!.elapsed_ms }
  })
})

async function run(): Promise<void> {
  if (running.value) return
  running.value = true
  result.value = null
  rawOpen.value = false
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
      <!-- 每一块只回答一个问题：上面的结果栏回答「结果是什么」——响应码、耗时、解析出的记录；
           下面的执行路径回答「怎么走的」。原来结果栏里那句「命中哪条规则、由谁应答」和执行路径重复，去掉了；
           命中的规则和应答的上游在路径里带绿色对勾。
           Each block answers one question: the result bar says what came back (code, time,
           records); the path below says how. The bar's old "matched rule X, answered by Y"
           sentence repeated the path and is gone; the path marks both with a green check. -->
      <section class="diag-outcome" :class="{ 'diag-outcome--notice': !successful }" aria-label="查询结果">
        <div class="diag-outcome-row">
          <p class="diag-status" role="status"><span class="ui-tag" :class="successful ? 'ui-tag--ok' : 'ui-tag--warn'">{{ codeName }}</span><span class="diag-elapsed">{{ formatElapsed(result.elapsed_ms) }}</span></p>
          <div v-if="answers.length" class="diag-records" :class="{ 'diag-records--stack': !leadMode }">
            <span v-for="(answer, index) in answers" :key="index" class="diag-answer-row">
              <code :title="answer.fields ? answer.fields.owner + ' · ' + answer.fields.dnsClass : undefined">{{ answer.fields?.data ?? answer.raw }}</code>
              <span v-if="answer.fields && !uniformMeta" class="diag-record-meta">{{ answer.fields.type }} · TTL {{ answer.fields.ttl }} 秒</span>
              <span v-else-if="!answer.fields" class="diag-record-meta">原始记录</span>
            </span>
          </div>
          <p v-else class="diag-empty-answers">没有 Answer 记录</p>
          <p class="diag-outcome-facts">{{ uniformMeta ? uniformMeta + ' · ' : '' }}{{ result.truncated ? '已截断' : '未截断' }} · 服务器 {{ result.server }}</p>
          <button type="button" class="diag-raw-toggle" :aria-expanded="rawOpen" aria-controls="diag-raw" @click="rawOpen = !rawOpen">原始响应<ChevronDown :size="16" aria-hidden="true" /></button>
        </div>
        <div v-if="rawOpen" id="diag-raw" class="diag-raw-response"><p v-if="!answers.length">没有 Answer 记录。</p><pre v-for="(answer, index) in result.answers" :key="index">{{ answer }}</pre></div>
      </section>

      <div class="diag-cards">
        <!-- 时间的说明写在卡片说明里：读数字之前先知道它是累计时刻；也省掉底栏那条线。
             The note on the times is in the card description, read before the numbers, which also drops the foot and its line. -->
        <UiCard v-if="result.trace_supported" class="diag-trace" title="执行路径" :desc="steps.length ? '这一次请求在内核里实际走过的步骤。左边的时间从请求开始累计，不表示该阶段的独立耗时。' : '这一次请求在内核里实际走过的步骤'">
          <!-- 每步的细节直接摊开：要点开才看得到的信息，等于没有显示。
               未命中的步骤灰掉但仍然占位——「没走缓存」本身就是信息。 -->
          <!-- 每一步是一句话，名字用等宽；以前是「阶段名 + 内核标签」，标签本身是句子时就说两遍。
               Each step is one sentence with names in mono; "stage + kernel label" said things twice when the label was already a sentence. -->
          <ol v-if="rows.length" class="diag-steps">
            <li v-for="(row, index) in rows" :key="index" class="diag-step" :class="['diag-step--' + row.tone, { 'diag-step--idle': row.idle }]">
              <span class="diag-step-time">{{ formatElapsed(row.elapsed) }}</span>
              <span class="diag-step-mark" aria-hidden="true"><Check v-if="row.tone === 'success'" :size="12" /><X v-else-if="row.tone === 'danger'" :size="12" /><i v-else></i></span>
              <div class="diag-step-body">
                <p class="diag-step-what"><template v-for="(part, at) in row.lead" :key="at"><code v-if="part.mono">{{ part.text }}</code><template v-else>{{ part.text }}</template></template></p>
                <p v-if="row.note.length" class="diag-step-why"><template v-for="(part, at) in row.note" :key="at"><span v-if="part.label" class="diag-pair">{{ part.label }} <code v-if="part.mono">{{ part.text }}</code><template v-else>{{ part.text }}</template></span><code v-else-if="part.mono">{{ part.text }}</code><template v-else>{{ part.text }}</template></template></p>
              </div>
            </li>
          </ol>
          <p v-else class="diag-note">本次查询没有返回执行轨迹。</p>
          <p v-if="result.trace_truncated" class="diag-trace-warning">执行轨迹已截断；当前展示的是部分阶段，不代表完整解析路径。</p>
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

.diag-outcome { display: grid; gap: var(--s-3); padding: var(--s-3) var(--s-4); border-radius: var(--r-3); background: var(--ok-tint-l); }
.diag-outcome--notice { background: var(--warn-tint-l); }
.diag-outcome-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-5); }
.diag-status { display: flex; align-items: center; gap: var(--s-2); margin: 0; }
.diag-status .ui-tag { font-family: var(--mono); }
/* 解析出的记录是这一栏的主角：大一号的等宽字 / The records lead the bar, in a size-up mono */
.diag-records { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-1) var(--s-4); min-width: 0; }
.diag-records--stack { flex-basis: 100%; flex-direction: column; order: 5; }
.diag-answer-row { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--s-2); min-width: 0; }
.diag-records code { max-width: 100%; color: var(--l-ink); font-family: var(--mono); font-size: var(--t-4); font-weight: var(--w-medium); white-space: pre-wrap; overflow-wrap: anywhere; }
.diag-records--stack code { font-size: var(--t-3); font-weight: var(--w-normal); }
.diag-record-meta, .diag-outcome-facts { margin: 0; color: var(--l-ink-3); font-size: var(--t-2); }
.diag-raw-toggle { display: inline-flex; align-items: center; gap: var(--s-1); min-height: var(--h-sm); margin-left: auto; padding: 0; border: 0; background: none; color: var(--l-ink-2); font: inherit; font-size: var(--t-2); cursor: pointer; }
.diag-raw-toggle svg { color: var(--l-ink-3); transition: transform var(--m-base) var(--ease-out); }
.diag-raw-toggle[aria-expanded="true"] svg { transform: rotate(180deg); }
.diag-elapsed { color: var(--l-ink-2); font-family: var(--mono); font-size: var(--t-2); }

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
/* 一对「键 值」整对换行 / A key-value pair wraps as one unit */
.diag-pair { display: inline-block; max-width: 100%; }
.diag-step-why code { color: var(--l-ink-2); }
.diag-step--idle .diag-step-what { color: var(--l-ink-3); font-weight: var(--w-normal); }
.diag-step--danger .diag-step-what { color: var(--err-l); }
.diag-step--warning .diag-step-what { color: var(--warn-l); }
.diag-step-time, .diag-step-body { align-self: baseline; }
.diag-step-time { color: var(--l-ink-3); font-family: var(--mono); font-size: var(--t-1); text-align: right; white-space: nowrap; }
.diag-note, .diag-trace-warning { margin: 0; color: var(--l-ink-3); font-size: var(--t-2); }
.diag-trace-warning { margin-top: var(--s-2); color: var(--warn-l); }

/* 应答卡里只留一条线（原始响应上面）：去掉表头行、行与行之间的线和底栏。两条记录原来配了五条横线。
   The answer card keeps one line, above the raw response: no header row, no rules
   between records, no foot. Two records used to come with five horizontal lines. */
.diag-empty-answers { margin: 0; color: var(--l-ink-2); font-size: var(--t-3); }
.diag-raw-response { display: grid; gap: var(--s-1); }
.diag-raw-response p { margin: 0; color: var(--l-ink-3); font-size: var(--t-2); }
.diag-raw-response pre { margin: 0; padding: var(--s-2) var(--s-3); border-radius: var(--r-2); background: var(--l-surface); color: var(--l-ink); font-family: var(--mono); font-size: var(--t-2); white-space: pre-wrap; overflow-wrap: anywhere; }

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
  .diag-outcome { padding: var(--s-3) var(--s-4) var(--s-1); }
  /* 宽屏上一步一行（这句话 | 细节），手机上细节回到下一行。
     A wide screen gives each step one row (sentence | detail); a phone puts the detail back underneath. */
  .diag-step-body { grid-template-columns: minmax(0, 1fr); }
  /* 组件库在窄屏把记录行收成两栏；应答行三格都要留在一行 / The kit folds rows to two columns on a phone; an answer keeps all three */
  /* 手机：记录独占一行，原始响应的开关回到左边 / A phone: records take their own line, the raw toggle returns to the left */
  .diag-records { flex-basis: 100%; }
  .diag-raw-toggle { min-height: var(--h-touch); margin-left: 0; }
}
</style>
