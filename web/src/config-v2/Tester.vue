<script setup lang="ts">
import { Check, Plus, X } from '@lucide/vue'
import UiHelp from '../components/ui/UiHelp.vue'
import { computed, nextTick, onMounted, ref } from 'vue'
import { apiRequest, jsonBody } from '../api/client'
import type { DnsDiagnostic } from '../api/types'
import UiSelect from '../components/ui/UiSelect.vue'
import { describeStep, forwardTarget, formatElapsed, groupTrace, isDnsSuccess, parseDnsAnswer, responseCodeName, traceTone, type TextPart } from '../diagnostics'
import { errorMessage } from '../utils'
import { dirty, findRuleByName, model } from './store'

// 测试域名：问 KixDNS 正在用的配置（诊断接口），不是草稿——草稿要先保存。结果和诊断页同一种写法：一句结论，下面是实际走过的路径；
// 命中的规则告诉列表打勾。
// 测试域名 asks the config KixDNS is running (the diagnostics API), never the draft, which must be saved first. The result reads like the
// diagnostics page: a verdict, then the path actually taken; the matched rule is reported so the list can mark it.
const emit = defineEmits<{ close: []; matched: [ruleId: number | null, mapping: boolean]; quick: [domain: string] }>()
const domain = ref('')
const qtype = ref('A')
const qtypes = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'PTR', 'HTTPS', 'SRV'].map((v) => ({ value: v, label: v }))
const running = ref(false)
const result = ref<DnsDiagnostic | null>(null)
const error = ref('')
const domainInput = ref<HTMLInputElement | null>(null)
onMounted(() => void nextTick(() => domainInput.value?.focus()))

async function run(): Promise<void> {
  const name = domain.value.trim()
  if (!name || running.value) return
  running.value = true
  error.value = ''
  try {
    result.value = await apiRequest<DnsDiagnostic>('/api/v1/diagnostics/dns', { method: 'POST', ...jsonBody({ domain: name, record_type: qtype.value }) })
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
    <!-- 测的是正在用的配置：草稿没保存时说清楚，免得拿结果去对草稿 / It tests the running config: with an unsaved draft, say so, lest the result be read against the draft -->
    <p class="tester__hint">测的是 KixDNS 正在用的配置<template v-if="dirty">；草稿还没保存，结果按上次应用的算</template>。</p>
    <p v-if="error" class="ui-field-error tester__error" role="alert">{{ error }}</p>
    <div v-else-if="result" class="tester__out" role="status">
      <div class="tester__result" :class="{ 'is-warn': !ok }">
        <p class="tester__verdict">{{ verdict }}</p>
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
