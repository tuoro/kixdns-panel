<script setup lang="ts">
import { ArrowRight, CornerDownRight, Zap } from '@lucide/vue'
import { computed } from 'vue'
import { entryNamePhrase, rulePhrase } from '../../config-editor/phrase'
import { ENTRY_ORDER_NOTE, RULE_ORDER_NOTE, collectDnsSolutions, collectDomainMappingRows, pipelineRole, selectorMatchesEveryRequest } from '../../config-editor/solution'
import type { ActionConfig, KixConfig } from '../../config-editor/types'
import PhraseText from './PhraseText.vue'
import { vLineDots } from '../../line-dots'

const props = defineProps<{ config: KixConfig }>()
const mappingSolutions = computed(() => collectDnsSolutions(props.config)
  .filter((solution) => solution.groupType === 'domain_mapping'))
const mappingSelectorIndexes = computed(() => new Set(mappingSolutions.value
  .flatMap((solution) => solution.selectorIndex === undefined ? [] : [solution.selectorIndex])))
const mappingPipelineIds = computed(() => new Set(mappingSolutions.value
  .flatMap((solution) => solution.pipeline ? [solution.pipeline.id] : [])))
const mappingCount = computed(() => collectDomainMappingRows(props.config).length)
const selectors = computed(() => props.config.pipeline_select
  .filter((_, index) => !mappingSelectorIndexes.value.has(index)))
const pipelines = computed(() => props.config.pipelines
  .filter((pipeline) => !mappingPipelineIds.value.has(pipeline.id)))
// 没命中任何入口的请求交给配置里第一个 Pipeline（内核 select_pipeline 的兜底），有入口接住所有请求时就到不了这里。
// Requests matching no entry go to the first Pipeline (the kernel's select_pipeline fallback), unless an entry catches everything.
const fallback = computed(() => props.config.pipelines[0]?.id)
const catchAll = computed(() => props.config.pipeline_select.some(selectorMatchesEveryRequest))

// 规则句子里已经写了主动作的跳转；这里只另起一行写响应阶段的跳转 / The rule sentence already names main-action jumps; only response-stage jumps get their own line
function responseJumps(actions: ActionConfig[]): ActionConfig[] {
  return actions.filter((action) => action.type === 'jump_to_pipeline')
}
</script>

<template>
  <!-- 整份配置的走向，只读：左边入口（和工作台列表同一个顺序、同样的说法），右边每个 Pipeline 里的规则，
       一条规则先写名字、再写「条件，动作」，和浏览检查器一样（审计 V11、V13、V17）。
       The whole config at a glance, read-only: the entries on the left (the workbench list's order and wording), each
       Pipeline's rules on the right, a rule as its name then 「condition, action」 as in the browse inspector (audits V11, V13, V17). -->
  <div class="flow-preview">
    <section class="flow-col">
      <h3>入口</h3>
      <p class="flow-note">{{ ENTRY_ORDER_NOTE }}</p>
      <ol v-if="selectors.length || mappingCount" class="flow-list">
        <li v-if="mappingCount" class="flow-route">
          <span class="flow-num"><Zap :size="14" aria-hidden="true" /></span>
          <span class="flow-body"><span v-line-dots>域名映射<span data-line-dot>&nbsp;·</span> {{ mappingCount }} 条</span><small>最先匹配，命中直接返回 CNAME</small></span>
        </li>
        <li v-for="(selector, index) in selectors" :key="index" class="flow-route">
          <span class="flow-num">{{ String(index + 1).padStart(2, '0') }}</span>
          <span class="flow-body"><span><PhraseText :phrase="entryNamePhrase(selector.matchers, selector.matcher_operator)" :mono="false" /></span><small><ArrowRight :size="14" aria-hidden="true" /><code v-if="selector.pipeline">{{ selector.pipeline }}</code><template v-else>还没选 Pipeline</template></small></span>
        </li>
        <li v-if="fallback && !catchAll && selectors.length" class="flow-route flow-route--rest">
          <span class="flow-num" aria-hidden="true"></span>
          <span class="flow-body"><small>其余请求 <ArrowRight :size="14" aria-hidden="true" /><code>{{ fallback }}</code></small></span>
        </li>
      </ol>
      <p v-if="!selectors.length" class="flow-empty">没有入口时，请求都交给 <code>{{ fallback ?? 'default' }}</code>。</p>
    </section>

    <section class="flow-col">
      <h3>Pipeline</h3>
      <p class="flow-note">{{ RULE_ORDER_NOTE }}</p>
      <div v-for="pipeline in pipelines" :key="pipeline.id" class="flow-pipeline">
        <header><code>{{ pipeline.id || '未命名 Pipeline' }}</code><small v-if="pipelineRole(config, pipeline.id)">{{ pipelineRole(config, pipeline.id) }}</small><small v-if="pipeline.ecs" v-line-dots>ECS<span data-line-dot>&nbsp;·</span> {{ pipeline.ecs.mode }}</small></header>
        <ol v-if="pipeline.rules.length" class="flow-list">
          <li v-for="(rule, index) in pipeline.rules" :key="index" class="flow-rule">
            <span class="flow-num">{{ String(index + 1).padStart(2, '0') }}</span>
            <span class="flow-body">
              <code class="flow-rule__name">{{ rule.name || `规则 ${index + 1}` }}</code>
              <small><PhraseText :phrase="rulePhrase(rule)" /></small>
              <small v-for="(action, jumpIndex) in responseJumps([...rule.response_actions_on_match, ...rule.response_actions_on_miss])" :key="jumpIndex" class="flow-jump"><CornerDownRight :size="14" aria-hidden="true" />响应后跳到 <code v-if="action.pipeline">{{ action.pipeline }}</code><template v-else>（还没选）</template></small>
            </span>
          </li>
        </ol>
        <p v-else class="flow-empty">空 Pipeline</p>
      </div>
      <p v-if="pipelines.length === 0" class="flow-empty">没有可预览的 Pipeline</p>
    </section>
  </div>
</template>

<style scoped>
/* 两栏一样宽（审计 V21） / Two equal columns (audit V21) */
/* 四边一样远：24，下边减掉最后一行自己的 8（规范 6.4，审计第三轮 V3） / The same inset on every side: 24, less the last row's own 8 at the bottom (spec 6.4, audit round 3, V3) */
.flow-preview { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-6); min-height: 0; max-height: none; overflow: visible; padding: var(--s-5) var(--s-5) calc(var(--s-5) - var(--s-2)); background: var(--l-surface); border-radius: var(--r-3); }
.flow-col { min-width: 0; }
.flow-col h3 { margin: 0; color: var(--l-ink); font-size: var(--t-4); font-weight: var(--w-bold); }
.flow-note { margin: var(--s-1) 0 var(--s-3); color: var(--l-ink-3); font-size: var(--t-1); text-wrap: pretty; }
.flow-list { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.flow-route, .flow-rule { display: grid; grid-template-columns: var(--s-6) minmax(0, 1fr); gap: var(--s-2); padding: var(--s-2) 0; }
.flow-num { padding-top: 2px; color: var(--l-ink-3); font-family: var(--f-mono); font-size: var(--t-1); font-variant-numeric: tabular-nums; }
.flow-body { min-width: 0; display: grid; gap: 2px; }
/* 名字一行取整行高 20：两栏第一行的基线不随正文 1.5 倍行高的小数走（审计第八轮 V2） / Name lines take a whole 20 line height, so the two columns' first baselines do not ride the body's fractional 1.5 line (audit round 8, V2) */
.flow-body > span { color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-medium); line-height: calc(var(--s-4) + var(--s-1)); }
.flow-body small { display: block; color: var(--l-ink-2); font-size: var(--t-2); text-wrap: pretty; }
.flow-body small > svg { margin-right: var(--s-1); color: var(--l-ink-3); vertical-align: -2px; }
.flow-body code, .flow-pipeline header code { font-family: var(--f-mono); }
.flow-rule__name { color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-medium); line-height: calc(var(--s-4) + var(--s-1)); overflow-wrap: anywhere; }
.flow-route--rest { padding-top: var(--s-1); }
.flow-pipeline + .flow-pipeline { margin-top: var(--s-5); }
/* 第一个 Pipeline 也离说明 8 多一截，和左栏第一行自己的上内边距一样：两栏的第一行落在同一条基线上（审计第五轮 V6）。
   用内边距不用外边距：说明的下外边距会把外边距吞掉。正好 8，不再减 2：Inter 和 Plex Mono 在同一行高里的基线位置一样（量过），
   以前那 2 是旧字体的差，换字后留着反而差 2（审计第八轮 V2）
   The first Pipeline sits the same 8 further from the note as the left column's first row, whose own top padding sets it there, so both first
   lines share a baseline. Padding, not margin: the note's bottom margin would swallow a margin (audit round 5, V6). Exactly 8, no 2 taken off:
   Inter and Plex Mono put the baseline at the same offset in one line height (measured); the old 2 was the previous fonts' difference and
   kept the lines 2 apart after the change (audit round 8, V2) */
.flow-note + .flow-pipeline { padding-top: var(--s-2); }
/* 名字和说明隔 8，和自由编辑里同一个 Pipeline 的标题一样（审计第八轮 V3） / 8 between the name and its fact, as the same Pipeline's title in 自由编辑 (audit round 8, V3) */
.flow-pipeline header { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-1) var(--s-2); margin-bottom: var(--s-1); }
.flow-pipeline header code { color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-bold); line-height: calc(var(--s-4) + var(--s-1)); }
/* 说明只占字那么高：带说明的标题和只有名字的一样高（审计第六轮 V2） / The fact takes only its glyph height, so a header with one is as tall as a bare name (audit round 6, V2) */
.flow-pipeline header small { color: var(--l-ink-2); font-size: var(--t-2); line-height: 1; }
.flow-empty { margin: 0; padding: var(--s-2) 0; color: var(--l-ink-2); font-size: var(--t-2); }
@media (max-width: 860px) {
  /* 上下排时「入口」和「Pipeline」两大块隔 32，比 Pipeline 之间的 24 大一级，和自由编辑一样（规范 6.2，审计第二轮 V11）
     Stacked, the 入口 and Pipeline regions sit 32 apart, a level above the 24 between Pipelines, as in 自由编辑 (spec 6.2, audit round 2, V11) */
  .flow-preview { grid-template-columns: minmax(0, 1fr); gap: var(--s-6); padding: var(--s-4) var(--s-4) calc(var(--s-4) - var(--s-2)); }
}
</style>
