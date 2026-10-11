<script setup lang="ts">
import { Check, Plus, X } from '@lucide/vue'
import UiHelp from '../components/ui/UiHelp.vue'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { apiRequest, jsonBody } from '../api/client'
import type { DnsDiagnostic } from '../api/types'
import UiSelect from '../components/ui/UiSelect.vue'
import UiTabs from '../components/ui/UiTabs.vue'
import { compile, isIp } from '../config-model/model'
import { describeStep, forwardTarget, formatElapsed, groupTrace, isDnsSuccess, parseDnsAnswer, responseCodeName, traceTone, type TextPart } from '../diagnostics'
import { errorMessage } from '../utils'
import { dirty, findRuleByName, model } from './store'
import { runtimeCapabilities } from './useConfigDocument'

// 测试域名：走一遍 KixDNS 的配置（诊断接口）。内核 p28 起可以测还没保存的草稿（子进程试跑，不碰正在用的配置），也可以假装来自
// 某个客户端 IP；内核不支持时这两样都不出现，测的就是正在用的配置。结果和诊断页同一种写法：一句结论，下面是实际走过的路径；
// 命中的规则告诉列表打勾。
// 测试域名 runs a domain through KixDNS (the diagnostics API). From kernel p28 it can test the unsaved draft (a trial in a child process
// that leaves the live config alone) and pretend to come from a client IP; on an older kernel neither shows and it tests the live config.
// The result reads like the diagnostics page: a verdict, then the path actually taken; the matched rule is reported so the list can mark it.
const emit = defineEmits<{ close: []; matched: [ruleId: number | null, mapping: boolean]; quick: [domain: string] }>()
const domain = ref('')
const qtype = ref('A')
const qtypes = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'PTR', 'HTTPS', 'SRV'].map((v) => ({ value: v, label: v }))
const running = ref(false)
const result = ref<DnsDiagnostic | null>(null)
const error = ref('')
const domainInput = ref<HTMLInputElement | null>(null)
onMounted(() => void nextTick(() => domainInput.value?.focus()))

// 客户端 IP 和草稿：内核声明了才出现 / Client IP and draft: shown only when the kernel declares them
const canClient = computed(() => runtimeCapabilities.value.includes('diagnostics_trace_client_v1'))
const canDraft = computed(() => runtimeCapabilities.value.includes('diagnostics_trace_candidate_v1'))
const clientIp = ref('')
const clientProblem = computed(() => (clientIp.value.trim() && !isIp(clientIp.value.trim()) ? '客户端 IP 写得不对' : ''))
// 有没保存的修改时默认测草稿：刚改完，想看的就是改后的样子 / With unsaved changes the draft is the default: just edited, that is what you want to see
const target = ref<'draft' | 'live'>(dirty.value ? 'draft' : 'live')
watch(dirty, (now) => { if (!now) target.value = 'live' })
const targets = [{ value: 'draft', label: '测草稿' }, { value: 'live', label: '测正在用的' }]
const testsDraft = computed(() => canDraft.value && dirty.value && target.value === 'draft')

async function run(): Promise<void> {
  const name = domain.value.trim()
  if (!name || running.value || clientProblem.value) return
  running.value = true
  error.value = ''
  const client = canClient.value ? clientIp.value.trim() : ''
  try {
    result.value = await apiRequest<DnsDiagnostic>('/api/v1/diagnostics/dns', { method: 'POST', ...jsonBody({
      domain: name,
      record_type: qtype.value,
      ...(client ? { client_ip: client } : {}),
      // 草稿发编出来的内核配置，和保存时内核收到的同一份 / The draft goes as the compiled kernel config, the same one the kernel gets on save
      ...(testsDraft.value ? { config: compile(model) } : {}),
    }) })
    const trace = result.value.trace_supported ? result.value.trace : []
    const hit = trace.find((s) => s.stage === 'rule' && s.status === 'matched')
    const rule = hit ? findRuleByName(hit.label) : undefined
    const mapping = trace.some((s) => s.stage === 'pipeline' && s.status === 'selected' && s.label === (model.mappingId ?? 'domain_mapping'))
    emit('matched', rule?.id ?? null, mapping)
  } catch (e) {
    result.value = null
    error.value = errorMessage(e)
    emit('matched', null, false)
  } finally {
    running.value = false
    domainInput.value?.focus()
  }
}
const answers = computed(() => (result.value?.answers ?? []).map((raw) => parseDnsAnswer(raw)?.data ?? raw))
const ok = computed(() => Boolean(result.value && isDnsSuccess(result.value.response_code)))
const verdict = computed(() => {
  if (!result.value) return ''
  if (!ok.value) return `回答 ${responseCodeName(result.value.response_code)}`
  return answers.value.length ? `回答 ${answers.value.join('、')}` : '回答成功，但没有记录'
})
// 执行路径的每一行，和诊断页同一种整理：连着的未命中规则并成一行，只有命中规则那一步打勾 / The path's rows, folded as on the diagnostics page: consecutive misses share a row, only the matched rule gets a check
const stepIdle = (status: string) => ['miss', 'missed', 'skipped'].includes(status)
const rows = computed(() => {
  let target: string | null = null
  return groupTrace(result.value?.trace_supported ? result.value.trace : []).map((row) => {
    if (row.kind === 'step') {
      const view = { ...describeStep(row.step, { target }), tone: traceTone(row.step.status), decides: row.step.stage === 'rule' && row.step.status === 'matched', idle: stepIdle(row.step.status), elapsed: (row.sent ?? row.step).elapsed_ms }
      target = forwardTarget(row.sent ?? row.step) ?? target
      return view
    }
    const names: TextPart[] = row.steps.flatMap((step, index) => (index ? [{ text: '、' }, { text: step.label, mono: true }] : [{ text: step.label, mono: true }]))
    return { lead: [{ text: `${row.steps.length} 条规则未命中` }], note: names, tone: 'neutral' as const, decides: false, idle: true, elapsed: row.steps[row.steps.length - 1]!.elapsed_ms }
  })
})
</script>

<template>
  <section class="ui-card tester ui-rise" aria-label="测试域名">
    <form class="tester__inputs" @submit.prevent="run">
      <label class="ui-input is-mono tester__domain"><input ref="domainInput" v-model="domain" aria-label="要测试的域名" placeholder="www.example.com" autocapitalize="off" spellcheck="false"></label>
      <UiSelect v-model="qtype" class="tester__qtype" :options="qtypes" label="查询类型" />
      <button class="ui-btn ui-btn--secondary tester__run" type="submit" :disabled="!domain.trim() || running" :aria-busy="running || undefined"><span v-if="running" class="ui-spin" aria-hidden="true"></span>测试</button>
      <UiHelp topic="tester" />
      <button class="ui-icon-btn tester__close" type="button" aria-label="收起测试" title="收起测试" @click="emit('close')"><X :size="16" /></button>
    </form>
    <!-- 第二行：客户端 IP、测哪份配置；内核不支持时不出现 / Second row: client IP and which config; absent when the kernel lacks them -->
    <div v-if="canClient || (canDraft && dirty)" class="tester__opts">
      <label v-if="canClient" class="ui-input is-mono tester__client" :class="{ 'is-bad': clientProblem }"><input v-model="clientIp" aria-label="客户端 IP，可以不填" :aria-invalid="Boolean(clientProblem) || undefined" :aria-describedby="clientProblem ? 'tester-client-err' : undefined" placeholder="客户端 IP，默认本机" autocapitalize="off" spellcheck="false" @keydown.enter.prevent="run"></label>
      <UiTabs v-if="canDraft && dirty" :model-value="target" class="tester__target" :items="targets" label="测哪份配置" variant="segment" @update:model-value="target = $event as 'draft' | 'live'" />
    </div>
    <p v-if="clientProblem" id="tester-client-err" class="ui-field-error tester__error">{{ clientProblem }}</p>
    <!-- 说清楚测的是哪份配置，免得拿结果去对另一份 / Say which config is tested, lest the result be read against the other -->
    <p class="tester__hint"><template v-if="testsDraft">测的是还没保存的草稿：会真的去问草稿里的上游，不影响正在用的配置</template><template v-else>测的是 KixDNS 正在用的配置<template v-if="dirty">；草稿还没保存，结果按上次应用的算<template v-if="!canDraft">，更新内核后可以直接测草稿</template></template></template>。</p>
    <p v-if="error" class="ui-field-error tester__error" role="alert">{{ error }}</p>
    <div v-else-if="result" class="tester__out" role="status">
      <div class="tester__result" :class="{ 'is-warn': !ok }">
        <p class="tester__verdict"><span v-if="result.source === 'draft'" class="ui-tag tester__tag">草稿</span>{{ verdict }}</p>
        <button class="ui-btn ui-btn--secondary ui-btn--sm" type="button" @click="emit('quick', domain.trim())"><Plus :size="14" aria-hidden="true" />为这个域名加一条</button>
      </div>
      <ol v-if="rows.length" class="ui-steps tester__steps">
        <li v-for="(row, i) in rows" :key="i" class="ui-step" :class="[row.tone === 'success' && row.decides ? 'ui-step--ok' : row.tone === 'danger' ? 'ui-step--err' : row.tone === 'warning' ? 'ui-step--warn' : '', { 'ui-step--idle': row.idle }]">
          <span class="ui-step__time">{{ formatElapsed(row.elapsed) }}</span>
          <span class="ui-step__mark" aria-hidden="true"><Check v-if="row.tone === 'success' && row.decides" :size="12" /><X v-else-if="row.tone === 'danger'" :size="12" /><i v-else></i></span>
          <div class="ui-step__body">
            <p class="ui-step__what"><template v-for="(part, at) in row.lead" :key="at"><code v-if="part.mono">{{ part.text }}</code><template v-else>{{ part.text }}</template></template></p>
            <p v-if="row.note.length" class="ui-step__why"><template v-for="(part, at) in row.note" :key="at"><span v-if="part.label" class="ui-step__pair">{{ part.label }} <code v-if="part.mono">{{ part.text }}</code><template v-else>{{ part.text }}</template></span><code v-else-if="part.mono">{{ part.text }}</code><template v-else>{{ part.text }}</template></template></p>
          </div>
        </li>
      </ol>
      <p v-else class="tester__hint">这个内核不回报执行路径，只有回答。</p>
      <p v-if="result.trace_truncated" class="tester__hint">执行轨迹已截断，上面只是一部分。</p>
    </div>
  </section>
</template>
