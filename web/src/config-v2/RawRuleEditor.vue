<script setup lang="ts">
import { Plus, Trash2 } from '@lucide/vue'
import { ref } from 'vue'
import ActionList from '../components/config/ActionList.vue'
import MatcherList from '../components/config/MatcherList.vue'
import UiSelect from '../components/ui/UiSelect.vue'
import { applyMatcherMode, inferMatcherMode } from '../config-editor/model'
import type { MatcherConfig, PipelineConfig, PipelineSelectMode, RuleConfig } from '../config-editor/types'

// 高级规则的结构化编辑：面板模型放不下的内核规则，按内核自己的字段改——条件链（带运算符）、动作列表、回答阶段的条件和动作。
// 用的是配置页一直有的两个底层编辑器（MatcherList、ActionList），不是只给一段 JSON；JSON 在旁边仍可切换。
// Structured editing of an advanced rule: kernel rules the panel model cannot hold, edited by the kernel's own fields — the matcher
// chain with operators, the action list, the answer phase's matchers and actions. Built from the config page's two low-level editors
// (MatcherList, ActionList) rather than a JSON blob; JSON stays available as the other view.
const rules = defineModel<RuleConfig[]>({ required: true })
defineProps<{ pipelines: PipelineConfig[]; currentPipelineId: string; capabilities: string[]; showErrors?: boolean }>()
const relationOptions = [{ value: 'all', label: '全部满足' }, { value: 'any', label: '任一满足' }, { value: 'custom', label: '自定义组合' }]
// 选过「自定义组合」的条件链记在这里：切回「全部 / 任一」时清掉 / Chains set to 自定义组合 are remembered here and forgotten when set back to 全部 / 任一
const custom = ref(new Set<MatcherConfig[]>())
const mode = (matchers: MatcherConfig[], operator: string): PipelineSelectMode => (custom.value.has(matchers) ? 'custom' : inferMatcherMode(matchers, operator))
function setMode(rule: RuleConfig, stage: 'request' | 'response', value: string): void {
  const matchers = stage === 'request' ? rule.matchers : rule.response_matchers
  const next = new Set(custom.value)
  if (value === 'custom') next.add(matchers)
  else next.delete(matchers)
  custom.value = next
  const operator = applyMatcherMode(matchers, value as PipelineSelectMode)
  if (stage === 'request') rule.matcher_operator = operator
  else rule.response_matcher_operator = operator
}
const operatorMode = (matchers: MatcherConfig[], operator: string) => (matchers.length > 1 && mode(matchers, operator) === 'custom' ? 'custom' : 'hidden')
function addRule(): void {
  rules.value.push({ name: `rule-${rules.value.length + 1}`, matchers: [], matcher_operator: 'and', actions: [], response_matchers: [], response_matcher_operator: 'and', response_actions_on_match: [], response_actions_on_miss: [] })
}
function removeRule(index: number): void { rules.value.splice(index, 1) }
</script>

<template>
  <div class="rawed">
    <article v-for="(rule, i) in rules" :key="i" class="rawed__rule" :aria-label="`内核规则 ${rule.name}`">
      <header class="rawed__head">
        <label class="ui-input is-mono rawed__name"><input v-model="rule.name" :aria-label="`第 ${i + 1} 条内核规则的名字`" placeholder="规则名" spellcheck="false"></label>
        <button v-if="rules.length > 1" class="ui-icon-btn" type="button" :aria-label="`去掉第 ${i + 1} 条内核规则`" :title="`去掉第 ${i + 1} 条内核规则`" @click="removeRule(i)"><Trash2 :size="16" /></button>
      </header>
      <section class="rawed__stage">
        <h3 class="rawed__title">匹配哪些请求<UiSelect v-if="rule.matchers.length > 1" class="rawed__relation" size="sm" :model-value="mode(rule.matchers, rule.matcher_operator)" :options="relationOptions" label="请求条件关系" @update:model-value="setMode(rule, 'request', $event)" /></h3>
        <MatcherList v-model="rule.matchers" scope="request" :operator-mode="operatorMode(rule.matchers, rule.matcher_operator)" :show-errors="showErrors" />
      </section>
      <section class="rawed__stage">
        <h3 class="rawed__title">怎么处理</h3>
        <ActionList v-model="rule.actions" :pipelines="pipelines" :current-pipeline-id="currentPipelineId" :capabilities="capabilities" :show-errors="showErrors" />
      </section>
      <details class="ui-expand rawed__response" :open="rule.response_matchers.length > 0 || rule.response_actions_on_match.length > 0 || rule.response_actions_on_miss.length > 0">
        <summary>回答阶段<small class="rawed__sum">上游回答后再检查一次；没条件就不检查</small></summary>
        <section class="rawed__stage">
          <h3 class="rawed__title">回答满足<UiSelect v-if="rule.response_matchers.length > 1" class="rawed__relation" size="sm" :model-value="mode(rule.response_matchers, rule.response_matcher_operator)" :options="relationOptions" label="回答条件关系" @update:model-value="setMode(rule, 'response', $event)" /></h3>
          <MatcherList v-model="rule.response_matchers" scope="response" :operator-mode="operatorMode(rule.response_matchers, rule.response_matcher_operator)" :show-errors="showErrors" />
        </section>
        <section class="rawed__stage">
          <h3 class="rawed__title">满足时</h3>
          <ActionList v-model="rule.response_actions_on_match" :pipelines="pipelines" :current-pipeline-id="currentPipelineId" :capabilities="capabilities" :show-errors="showErrors" />
        </section>
        <section class="rawed__stage">
          <h3 class="rawed__title">不满足时</h3>
          <ActionList v-model="rule.response_actions_on_miss" :pipelines="pipelines" :current-pipeline-id="currentPipelineId" :capabilities="capabilities" :show-errors="showErrors" />
        </section>
      </details>
    </article>
    <button class="ui-btn ui-btn--text ui-btn--sm" type="button" @click="addRule"><Plus :size="14" aria-hidden="true" />再加一条内核规则</button>
  </div>
</template>
