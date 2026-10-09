<script setup lang="ts">
import { Check, ChevronDown, ChevronRight, LoaderCircle, Network, TriangleAlert, X } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { apiRequest, jsonBody } from '../api/client'
import type { DnsDiagnostic, KixdnsKernel, Overview } from '../api/types'
import UiDotText from '../components/ui/UiDotText.vue'
import UiEmpty from '../components/ui/UiEmpty.vue'
import UiPageHeader from '../components/ui/UiPageHeader.vue'
import UiSelect from '../components/ui/UiSelect.vue'
import { useToast } from '../composables/useToast'
import { describeStep, formatElapsed, forwardTarget, groupTrace, isDnsSuccess, parseDnsAnswer, responseCodeName, traceTone, type TextPart } from '../diagnostics'
import { errorMessage, formatKixdnsVersion } from '../utils'

const domain = ref('example.com')
const recordType = ref('A')
const running = ref(false)
const result = ref<DnsDiagnostic | null>(null)
const queryError = ref('')
const toast = useToast()
const types = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'PTR']
// 记录类型用组件库的下拉框，和配置页同一个（规范 2.3） / The record type uses the kit select, the same as the config page (spec 2.3)
const typeOptions = types.map((type) => ({ value: type, label: type }))
const domainInput = ref<HTMLInputElement | null>(null)
// 页头事实行里的「上次查询」：这一页里上一次查的域名和发出的时刻。配置版本不在诊断结果里，
// 也没有页面之间共享的状态带着它，所以这里不写、不猜。
// The header's 上次查询 fact: the domain this page last queried and when it was sent. The config
// version is in neither the diagnostics result nor any state shared between pages, so it is
// neither shown nor guessed.
const lastRun = ref<{ domain: string; time: string } | null>(null)
// 事实行另外两项：正在跑的配置版本和内核版本，查一次就够；拿不到就不显示，不编造 / Two more facts: the running config version and the kernel build, fetched once; left out when unavailable, never invented
const configGeneration = ref<number | null>(null)
const kernelLabel = ref('')
onMounted(async () => {
  const [overview, kernel] = await Promise.allSettled([apiRequest<Overview>('/api/v1/overview'), apiRequest<KixdnsKernel>('/api/v1/kixdns/kernel')])
  if (overview.status === 'fulfilled') configGeneration.value = overview.value.active_config?.generation ?? null
  if (kernel.status === 'fulfilled' && kernel.value.binary_present) kernelLabel.value = formatKixdnsVersion(kernel.value.active)
})
const clock = (date: Date) => date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const steps = computed(() => result.value?.trace_supported ? result.value.trace : [])
const answers = computed(() => result.value?.answers.map((raw) => ({ raw, fields: parseDnsAnswer(raw) })) ?? [])
const successful = computed(() => result.value !== null && isDnsSuccess(result.value.response_code))
const codeName = computed(() => (result.value ? responseCodeName(result.value.response_code) : ''))
// 状态点只说结果：有应答绿，域名不存在灰，服务端出错红 / The dot speaks only of the outcome: answered green, no such domain grey, a server-side failure red
const dotClass = computed(() => (successful.value ? '' : codeName.value === 'NXDOMAIN' ? 'diag-dot--nx' : 'ui-dot--err'))
const rawOpen = ref(false)
// 记录都同一类型、同一 TTL 时只在事实行里写一次，否则跟在每条后面。
// When every record shares one type and TTL it is stated once in the facts line; otherwise after each record.
const uniformMeta = computed(() => {
  const fields = answers.value.map((answer) => answer.fields)
  if (!fields.length || fields.some((field) => !field)) return null
  const types = new Set(fields.map((field) => field!.type))
  const ttls = new Set(fields.map((field) => field!.ttl))
  return types.size === 1 && ttls.size === 1 ? { type: [...types][0]!, ttl: [...ttls][0]! } : null
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
    // 只有命中规则这一步打勾：它定下了请求怎么走；应答成功是结果栏的事，节点用普通的点
    // Only the matched-rule step gets a check, since it decides the route; a successful reply belongs to the result band, so its node is a plain dot
    const view = { ...describeStep(row.step, { target }), tone: traceTone(row.step.status), decides: row.step.stage === 'rule' && row.step.status === 'matched', idle: stepIdle(row.step.status), elapsed: (row.sent ?? row.step).elapsed_ms }
    target = forwardTarget(row.sent ?? row.step) ?? target
    return view
  }
  const names: TextPart[] = row.steps.flatMap((step, index) => (index ? [{ text: '、' }, { text: step.label, mono: true }] : [{ text: step.label, mono: true }]))
  return { lead: [{ text: `${row.steps.length} 条规则未命中` }], note: names, tone: 'neutral' as const, decides: false, idle: true, elapsed: row.steps[row.steps.length - 1]!.elapsed_ms }
  })
})

const examples = [{ domain: 'www.example.com', type: 'A' }, { domain: 'example.com', type: 'AAAA' }, { domain: 'example.org', type: 'MX' }]
function tryExample(example: { domain: string; type: string }): void {
  domain.value = example.domain
  recordType.value = example.type
  void run()
}

async function run(): Promise<void> {
  if (running.value) return
  const query = domain.value.trim()
  // 查完焦点回到域名框，改个域名就能再查。回车提交时它本来就在那里；点按钮的话桌面上也放回去，
  // 手机上不放——那会把键盘弹出来盖住结果。
  // After the run the focus returns to the domain field so the next query is one edit away. On an
  // Enter submit it is already there; after a button click it goes back on a desktop but not on a
  // phone, where that would raise the keyboard over the result.
  const keepFocus = document.activeElement === domainInput.value || !window.matchMedia('(pointer: coarse)').matches
  running.value = true
  result.value = null
  rawOpen.value = false
  queryError.value = ''
  lastRun.value = { domain: query, time: clock(new Date()) }
  try {
    result.value = await apiRequest<DnsDiagnostic>('/api/v1/diagnostics/dns', {
      method: 'POST',
      ...jsonBody({ domain: query, record_type: recordType.value }),
    })
  } catch (error) {
    queryError.value = errorMessage(error)
    toast.error(queryError.value)
  } finally {
    running.value = false
    if (keepFocus) domainInput.value?.focus()
  }
}
</script>

<template>
  <div class="page diag-page">
    <UiPageHeader class="diag-heading" title="诊断">
      <template #meta>
        <!-- 事实行只写这一页有的事实：上一次查的是什么、什么时候 / The facts row states only what this page has: what was last queried and when -->
        <div class="ui-facts diag-facts">
          <div v-if="configGeneration !== null"><span class="ui-lbl">配置版本</span><b class="ui-num">#{{ configGeneration }}</b></div>
          <div v-if="kernelLabel"><span class="ui-lbl">内核</span><b class="diag-fact-kernel">{{ kernelLabel }}</b></div>
          <div><span class="ui-lbl">上次查询</span><b v-if="lastRun"><UiDotText :parts="[lastRun.domain, lastRun.time]" /></b><b v-else>还没查过</b></div>
        </div>
      </template>
    </UiPageHeader>

    <!-- 查询条是这一页唯一的主操作；宽屏上它在一张白卡里，手机上三个 36 的白框直接放在底色上（手机的控件设计）。
         三样照旧同一行，窄屏上按钮只写「查询」。回车提交。
         The query bar is this page's one primary action; on a wide screen it sits in a white card, on a phone
         the three white 36 controls sit on the ground (the phone control design). The three stay on one row and
         the button just says 查询 on a narrow screen. Enter submits. -->
    <section class="diag-query-card">
      <form class="diag-query" aria-label="DNS 查询" @submit.prevent="run">
        <label class="ui-input diag-domain"><input ref="domainInput" v-model="domain" type="text" inputmode="url" maxlength="253" required placeholder="example.com" aria-label="域名" autocapitalize="none" :spellcheck="false" /></label>
        <UiSelect v-model="recordType" class="diag-record-type" :options="typeOptions" label="记录类型" />
        <button class="ui-btn ui-btn--primary diag-run" type="submit" :disabled="running" :aria-label="running ? '正在查询' : '执行查询'"><LoaderCircle v-if="running" class="diag-spinner" :size="16" aria-hidden="true" /><span class="diag-run-desktop">{{ running ? '正在查询…' : '执行查询' }}</span><span class="diag-run-mobile" aria-hidden="true">{{ running ? '查询中' : '查询' }}</span></button>
      </form>
    </section>

    <!-- 等待时给骨架而不是转圈：骨架的分块和结果一致，数据到达时版面不跳。 -->
    <div v-if="running" class="diag-skeleton" role="status" aria-label="正在等待 DNS 响应">
      <div class="sk diag-skeleton-verdict"></div>
      <div class="sk diag-skeleton-card"></div>
    </div>
    <div v-else-if="queryError" class="diag-error" role="alert"><TriangleAlert :size="20" /><div><h2>查询失败</h2><p>{{ queryError }}</p><small>检查域名或服务状态后可重新查询。</small></div></div>
    <div v-else-if="result" class="diagnostic-result diag-result">
      <!-- 每一块只回答一个问题：上面的结果卡回答「结果是什么」——响应码、回答、一行事实；
           下面的执行路径回答「怎么走的」。命中的规则在路径里带绿色对勾。
           Each block answers one question: the result card says what came back (code, answers,
           a line of facts); the path below says how. The path marks the matched rule with a green check. -->
      <section class="ui-card diag-outcome" aria-label="查询结果">
        <div class="diag-outcome-head">
          <!-- 结论先读：状态点加响应码，然后是回答；原始响应的开关在这一行的右端 / The verdict reads first: a status dot and the response code, then the answers; the raw-response toggle ends the line -->
          <p class="diag-status" role="status"><span class="ui-dot" :class="dotClass" aria-hidden="true"></span><code class="diag-code">{{ codeName }}</code></p>
          <div v-if="answers.length" class="diag-records" :class="{ 'diag-records--stack': !leadMode }">
            <span v-for="(answer, index) in answers" :key="index" class="diag-answer-row">
              <code :title="answer.fields ? answer.fields.owner + ' · ' + answer.fields.dnsClass : undefined">{{ answer.fields?.data ?? answer.raw }}</code>
              <span v-if="answer.fields && !uniformMeta" class="diag-record-meta"><UiDotText :parts="[answer.fields.type, `TTL ${answer.fields.ttl} 秒`]" /></span>
              <span v-else-if="!answer.fields" class="diag-record-meta">原始记录</span>
            </span>
          </div>
          <p v-else class="diag-empty-answers">没有 Answer 记录</p>
          <button type="button" class="diag-raw-toggle" :aria-expanded="rawOpen" aria-controls="diag-raw" @click="rawOpen = !rawOpen">原始响应<ChevronDown :size="16" aria-hidden="true" /></button>
        </div>
        <!-- 一行事实：耗时、类型、TTL、截断与否、服务器，用分隔点隔开 / One line of facts: time, type, TTL, truncation, server, dot-separated -->
        <p class="ui-dots diag-outcome-facts"><span>{{ formatElapsed(result.elapsed_ms) }}</span><template v-if="uniformMeta"><span>{{ uniformMeta.type }}</span><span>TTL {{ uniformMeta.ttl }} 秒</span></template><span>{{ result.truncated ? '已截断' : '未截断' }}</span><span>服务器 {{ result.server }}</span></p>
        <div v-if="rawOpen" id="diag-raw" class="diag-raw-response"><p v-if="!answers.length">没有 Answer 记录。</p><pre v-for="(answer, index) in result.answers" :key="index">{{ answer }}</pre></div>
      </section>

      <!-- 执行路径卡：概览那套小标签，下面一句说时间是累计的；读数字之前先知道这一点。
           The path card: the overview's small label, then one line saying the times are cumulative, read before the numbers. -->
      <section v-if="result.trace_supported" class="ui-card diag-trace">
        <h2 class="ui-card__label">执行路径</h2>
        <p class="diag-card-note">{{ steps.length ? '内核实际走过的步骤，时间从请求开始累计。' : '内核实际走过的步骤' }}</p>
        <!-- 每步的细节直接摊开：要点开才看得到的信息，等于没有显示。
             未命中的步骤灰掉但仍然占位——「没走缓存」本身就是信息。 -->
        <!-- 每一步是一句话，名字用等宽；以前是「阶段名 + 内核标签」，标签本身是句子时就说两遍。
             Each step is one sentence with names in mono; "stage + kernel label" said things twice when the label was already a sentence. -->
        <!-- 步骤用组件库的「结果说明」，配置页的测试域名也用同一套 / Steps use the kit's explanation, shared with the config page's tester -->
        <ol v-if="rows.length" class="ui-steps">
          <li v-for="(row, index) in rows" :key="index" class="ui-step" :class="[row.tone === 'success' && row.decides ? 'ui-step--ok' : row.tone === 'danger' ? 'ui-step--err' : row.tone === 'warning' ? 'ui-step--warn' : '', { 'ui-step--idle': row.idle }]">
            <span class="ui-step__time">{{ formatElapsed(row.elapsed) }}</span>
            <span class="ui-step__mark" aria-hidden="true"><Check v-if="row.tone === 'success' && row.decides" :size="12" /><X v-else-if="row.tone === 'danger'" :size="12" /><i v-else></i></span>
            <div class="ui-step__body">
              <p class="ui-step__what"><template v-for="(part, at) in row.lead" :key="at"><code v-if="part.mono">{{ part.text }}</code><template v-else>{{ part.text }}</template></template></p>
              <p v-if="row.note.length" class="ui-step__why"><template v-for="(part, at) in row.note" :key="at"><span v-if="part.label" class="ui-step__pair">{{ part.label }} <code v-if="part.mono">{{ part.text }}</code><template v-else>{{ part.text }}</template></span><code v-else-if="part.mono">{{ part.text }}</code><template v-else>{{ part.text }}</template></template></p>
            </div>
          </li>
        </ol>
        <p v-else class="diag-note">本次查询没有返回执行轨迹。</p>
        <p v-if="result.trace_truncated" class="diag-trace-warning">执行轨迹已截断；当前展示的是部分阶段，不代表完整解析路径。</p>
      </section>
      <section v-else class="ui-card diag-trace-unavailable">
        <UiEmpty :icon="Network" title="当前内核仅支持基础查询" desc="升级到包含 diagnostics_trace_v1 的增强版后，可查看规则命中与上游路径。" />
      </section>
    </div>
    <!-- 空页面和别的卡片一样从内容左边读起：小标签、一句说明，下面三个能直接点的例子是一行一个的列表，不是居中的一小撮
         The empty page reads from the content edge like every other card: a small label, one line, then three examples to tap as a list of rows rather than a centred cluster -->
    <section v-else class="ui-card diag-placeholder">
      <h2 class="ui-card__label">从一次查询开始</h2>
      <p class="diag-card-note">看应答、命中了哪条规则、实际走了哪条路。可以先试一个例子：</p>
      <ul class="diag-tries">
        <li v-for="example in examples" :key="example.domain + example.type"><button class="diag-try" type="button" @click="tryExample(example)"><span class="ui-mono">{{ example.domain }}</span><span class="diag-try__type">{{ example.type }}<ChevronRight :size="16" aria-hidden="true" /></span></button></li>
      </ul>
    </section>
  </div>
</template>

<style>
/* 诊断页只引用 tokens.css 的变量；零件来自 components.css，这里只管排版和三张卡片的样子。
   Tokens only; the parts come from components.css and this lays them out and draws the three cards. */
/* 和概览同一个节奏：块与块隔 24，页头下面不再另加 / The overview's rhythm: blocks 24 apart, nothing extra under the header */
.diag-page { min-width: 0; display: grid; gap: var(--s-5); align-content: start; }
.diag-page > .ui-ph { margin-bottom: 0; }
/* 事实行：标签在上、值在下，和概览一样 / The facts row: label over value, as on the overview */
.diag-facts { flex: 1 1 100%; margin-top: var(--s-1); }

/* 查询条：宽屏上在一张白卡里，左右 24、上下 12，和规则页卡片里的工具行一样 / The query bar: on a wide screen in a white card, 24 at the sides and 12 above and below, like the toolbar row in the rules page's card */
@media (min-width: 641px) { .diag-query-card { padding: var(--s-3) var(--s-5); border-radius: var(--r-3); background: var(--l-surface); box-shadow: var(--shadow-card); } }
.diag-query { display: grid; grid-template-columns: minmax(0, 1fr) 7rem auto; gap: var(--s-2); }
.diag-query input { font-family: var(--f-mono); }
.diag-run-mobile { display: none; }
.diag-spinner { animation: ui-spin var(--m-spin) linear infinite; }

/* 结果卡：第一行是结论（状态点 + 响应码）和回答，右端是原始响应的开关；下面一行事实
   The result card: the verdict (dot + code) and the answers on the first line with the raw-response toggle at its end; a line of facts below */
.diag-outcome { display: grid; gap: var(--s-2); padding: var(--s-4) var(--s-5) var(--s-5); }
.diag-outcome-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-1) var(--s-4); }
.diag-status { display: inline-flex; align-items: center; gap: var(--s-2); margin: 0; line-height: var(--lh-tight); }
.diag-code { color: var(--l-ink); font-family: var(--f-body); font-size: var(--t-4); font-weight: var(--w-bold); }
.diag-dot--nx { background: var(--l-ink-2); }
/* 解析出的记录是这一行的主角：大一号的等宽字；两条记录之间一个分隔点 / The records lead the line in a size-up mono; a separator dot between two records */
.diag-records { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-1) var(--s-2); min-width: 0; }
.diag-records:not(.diag-records--stack) .diag-answer-row + .diag-answer-row::before { content: "·"; margin: 0; color: var(--l-ink-3); font-weight: var(--w-normal); }
.diag-records--stack { flex-basis: 100%; flex-direction: column; order: 5; }
.diag-answer-row { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--s-2); min-width: 0; }
.diag-records code { max-width: 100%; color: var(--l-ink); font-family: var(--f-mono); font-size: var(--t-4); font-weight: var(--w-bold); white-space: pre-wrap; overflow-wrap: anywhere; }
.diag-records--stack code { font-size: var(--t-3); font-weight: var(--w-normal); }
.diag-record-meta { color: var(--l-ink-3); font-size: var(--t-2); }
.diag-empty-answers { margin: 0; color: var(--l-ink-2); font-size: var(--t-3); }
.diag-outcome-facts { margin: 0; color: var(--l-ink-3); font-size: var(--t-2); }
.diag-raw-toggle { display: inline-flex; align-items: center; gap: var(--s-1); min-height: var(--h-sm); margin-left: auto; padding: 0; border: 0; background: none; color: var(--l-ink-2); font: inherit; font-size: var(--t-2); cursor: pointer; }
.diag-raw-toggle svg { color: var(--l-ink-3); transition: transform var(--m-base) var(--ease-out); margin-right: -3px; } /* 向下箭头的墨迹右边对齐内容边 / The chevron's ink ends on the content edge */
.diag-raw-toggle[aria-expanded="true"] svg { transform: rotate(180deg); }
.diag-raw-response { display: grid; gap: var(--s-1); margin-top: var(--s-2); }
.diag-raw-response p { margin: 0; color: var(--l-ink-3); font-size: var(--t-2); }
.diag-raw-response pre { margin: 0; padding: var(--s-2) var(--s-3); border-radius: var(--r-2); background: var(--l-sunk); color: var(--l-ink); font-family: var(--f-mono); font-size: var(--t-2); white-space: pre-wrap; overflow-wrap: anywhere; }

/* 执行路径和空状态：概览的卡片结构——小标签、一句说明、然后是行 / The path and the empty state: the overview's card anatomy, a small label, one line, then rows */
.diag-trace, .diag-placeholder, .diag-trace-unavailable { padding: var(--s-4) var(--s-5) var(--s-5); }
.diag-card-note { margin: var(--s-1) 0 0; color: var(--l-ink-3); font-size: var(--t-2); }
.diag-trace > .ui-steps { margin-top: var(--s-3); }
.diag-note, .diag-trace-warning { margin: 0; color: var(--l-ink-3); font-size: var(--t-2); }
.diag-trace > .diag-note { margin-top: var(--s-3); }
.diag-trace-warning { margin-top: var(--s-2); color: var(--warn-l); }
/* 例子是一行一个的列表，细线隔开；最后一行自带下半截空白，卡片底边只补 8 / Examples are rows between hairlines; the last row brings its own lower blank, so the card adds only 8 below */
.diag-placeholder { padding-bottom: var(--s-2); }
.diag-tries { display: grid; margin: var(--s-2) 0 0; padding: 0; list-style: none; }
.diag-tries > li + li { border-top: 1px solid var(--l-hair); }
.diag-try { width: 100%; min-height: var(--h-touch); display: flex; align-items: center; justify-content: space-between; gap: var(--s-4); padding: 0; border: 0; background: none; color: var(--l-ink); font: inherit; text-align: left; cursor: pointer; }
.diag-try__type { display: inline-flex; align-items: center; gap: var(--s-2); color: var(--l-ink-2); font-size: var(--t-2); }
.diag-try__type svg { margin-right: -5px; }
@media (hover: hover) { .diag-try:hover .ui-mono { text-decoration: underline; text-decoration-color: var(--l-line-strong); text-underline-offset: 3px; } }

.diag-result { display: grid; gap: var(--s-5); }

.diag-error { display: flex; align-items: flex-start; gap: var(--s-3); padding: var(--s-4) var(--s-5); border: 1px solid var(--err-line-l); border-radius: var(--r-3); background: var(--err-tint-l); color: var(--err-l); }
.diag-error h2 { margin: 0; font-size: var(--t-4); }
.diag-error p { margin: var(--s-2) 0 0; font-size: var(--t-3); overflow-wrap: anywhere; }
.diag-error small { display: block; margin-top: var(--s-2); color: var(--l-ink-3); font-size: var(--t-1); }

/* 骨架的分块照抄结果：一张矮的结果卡、一张高的路径卡 / The skeleton copies the result: a short result card and a tall path card */
.diag-skeleton { display: grid; gap: var(--s-5); }
.diag-skeleton > .sk { border-radius: var(--r-3); }
.diag-skeleton-verdict { height: calc(var(--s-8) + var(--s-5)); }
.diag-skeleton-card { min-height: calc(var(--s-8) * 4); }

@media (max-width: 640px) {
  .diag-page, .diag-result, .diag-skeleton { gap: var(--s-4); }
  /* 配置版本和内核两项一行，和其它页一样；上次查询单独占满一行，域名和时刻就不用折成两行 / Config version and kernel share a line, as on the other pages; the last query takes a whole line so the domain and time need not fold onto two */
  .diag-facts { gap: var(--s-3) var(--s-5); }
  .diag-facts > div { flex: 0 0 calc(50% - var(--s-5) / 2); }
  .diag-facts > div:last-child { flex-basis: 100%; }
  /* 「Run #30231271280」刚好一格宽：不许折成两行，多出的一两像素落进列距里 / 「Run #30231271280」 is exactly a column wide: it never folds onto two lines, a pixel or two spill into the column gap */
  .diag-fact-kernel { white-space: nowrap; }
  /* 类型只有一到五个字母：下拉框 72，把宽度让给域名 / A type is one to five letters: a 72 select, the width goes to the domain */
  .diag-query { grid-template-columns: minmax(0, 1fr) 4.5rem auto; }
  /* 窄格子里收一收左右留白，AAAA、CNAME 放得下 / Tighter padding in the narrow cell so AAAA and CNAME fit */
  .diag-record-type select { padding-inline: var(--s-2) calc(var(--s-2) + var(--size-icon)); }
  .diag-record-type > svg { right: var(--s-2); }
  .diag-run { padding-inline: var(--s-3); }
  .diag-run-desktop { display: none; }
  .diag-run-mobile { display: inline; }
  /* 结果卡按手机的顺序排成一列：结论、回答（大字加一句事实）、原始响应的开关 / The result card becomes one column in phone order: verdict, answers (big, then one line of facts), the raw-response toggle */
  .diag-outcome { display: flex; flex-direction: column; gap: var(--s-2); padding: var(--s-3) var(--s-4) var(--s-2); }
  .diag-outcome-head { display: contents; }
  .diag-status { order: 1; }
  .diag-records, .diag-empty-answers { order: 2; }
  .diag-outcome-facts { order: 3; }
  .diag-raw-toggle { order: 4; position: relative; margin-left: 0; align-self: flex-start; min-height: var(--h-sm); }
  .diag-raw-toggle::before { position: absolute; inset: calc((var(--h-touch) - var(--h-sm)) / -2) 0; content: ''; }
  .diag-raw-response { order: 5; margin-top: 0; }
  .diag-trace, .diag-placeholder, .diag-trace-unavailable { padding: var(--s-3) var(--s-4) var(--s-4); }
  .diag-placeholder { padding-bottom: var(--s-1); }
}
</style>
