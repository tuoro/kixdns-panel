<script setup lang="ts">
import { FileText, GripVertical, ShieldCheck } from '@lucide/vue'
import { computed } from 'vue'
import UiMenu from '../components/ui/UiMenu.vue'
import OutcomePill from './OutcomePill.vue'
import { conditionsText, rawMatchersText, ruleProblems, ruleTitle, type Rule } from '../config-model/model'
import { changedRuleIds, hitsOf, model } from './store'
import { fmtCount } from './view'

// 列表里的一条规则：序号、名字和条件、结果、命中次数、开关、菜单。点名字那一块打开编辑。
// One rule in the list: ordinal, name and conditions, outcome, hits, switch, menu. Clicking the name block opens the editor.
// shadowedBy：前面接住所有请求、又决定了结果的那条的序号，这条就永远到不了 / shadowedBy: the ordinal of an earlier catch-all that decides, so this rule is never reached
// selected：这条正开在右侧面板里 / selected: this rule is open in the inspector
const props = defineProps<{ rule: Rule; index: number; count: number; mark: 'hit' | 'pass' | null; draggable: boolean; shadowedBy?: number | null; selected?: boolean }>()
const emit = defineEmits<{ open: []; action: [value: string]; grip: [event: PointerEvent] }>()

// 高级规则读它原样的内核条件 / An advanced rule reads its verbatim kernel conditions
const summary = computed(() => {
  const raw = props.rule.raw
  if (!raw) return conditionsText(props.rule.conditions)
  const first = raw[0] as { matchers?: Record<string, unknown>[]; matcher_operator?: string }
  return `${rawMatchersText(first.matchers, first.matcher_operator)}${raw.length > 1 ? `，另有 ${raw.length - 1} 条内核规则` : ''}`
})
const broken = computed(() => ruleProblems(model, props.rule).length > 0)
const menu = computed(() => [
  { value: 'edit', label: '编辑' },
  { value: 'duplicate', label: '复制一份' },
  { value: 'up', label: '上移', disabled: props.index === 1 },
  { value: 'down', label: '下移', disabled: props.index === props.count },
  { value: 'top', label: '移到最前', disabled: props.index === 1 },
  { value: 'bottom', label: '移到最后', disabled: props.index === props.count },
  { value: 'delete', label: '删除', danger: true },
])
const named = computed(() => Boolean(props.rule.name.trim()) || Boolean(props.rule.raw))
const hits = computed(() => hitsOf(props.rule))
const title = computed(() => ruleTitle(props.rule))
</script>

<template>
  <li class="rrow" :class="{ 'is-off': !rule.enabled, 'is-hit': mark === 'hit', 'is-pass': mark === 'pass', 'ui-selected': selected }" :data-rule="rule.id" :aria-current="selected ? 'true' : undefined">
    <span class="rrow__num">
      <span class="rrow__ord">{{ index }}</span>
      <button v-if="draggable" class="rrow__grip" type="button" tabindex="-1" aria-hidden="true" title="拖动调整顺序" @pointerdown="emit('grip', $event)"><GripVertical :size="14" /></button>
    </span>
    <button class="rrow__main" type="button" :aria-label="`编辑规则：${title}`" @click="emit('open')">
      <span class="rrow__name">
        <!-- 没起名字时条件就是标题，下一行只放备注（同 Surge：规则本身就是条件和去向）/ Without a name the condition is the title and the next line holds only the note (as in Surge, a rule is its condition and target) -->
        <b :class="{ 'is-untitled': !named }">{{ title }}</b>
        <!-- 顺序固定：标题、图标、状态标签、最后是「改过」的点 / A fixed order: title, icons, state tags, the unsaved dot last -->
        <span v-if="rule.log.enabled" class="rrow__icon" role="img" aria-label="记录日志" title="记录日志"><FileText :size="14" aria-hidden="true" /></span>
        <span v-if="rule.outcome.type === 'upstream' && rule.response.mode === 'custom'" class="rrow__icon" role="img" aria-label="单独检查上游回答" title="单独检查上游回答"><ShieldCheck :size="14" aria-hidden="true" /></span>
        <span v-if="mark === 'hit'" class="ui-tag ui-tag--ok">命中</span>
        <span v-else-if="mark === 'pass'" class="ui-tag">经过</span>
        <span v-if="rule.raw" class="ui-tag">高级</span>
        <span v-if="!rule.enabled" class="ui-tag">已停用</span>
        <span v-else-if="broken" class="ui-tag ui-tag--warn">要修改</span>
        <span v-else-if="shadowedBy" class="ui-tag ui-tag--warn" :title="`第 ${shadowedBy} 条接住了所有请求，这条永远轮不到`">到不了</span>
        <span v-if="changedRuleIds.has(rule.id)" class="ui-dot ui-dot--ink rrow__changed" role="img" aria-label="改过，还没保存" title="改过，还没保存"></span>
      </span>
      <span class="rrow__line"><span class="rrow__pill rrow__pill--inline" aria-hidden="true"><span v-if="rule.raw" class="opill opill--pass"><span class="opill__verb">高级</span></span><OutcomePill v-else :outcome="rule.outcome" /></span><span v-if="named" class="rrow__cond" :title="summary">{{ summary }}</span><span v-else-if="rule.note" class="rrow__cond rrow__note">{{ rule.note }}</span></span>
    </button>
    <span class="rrow__pill"><span v-if="rule.raw" class="opill opill--pass" title="原样保留的内核规则"><span class="opill__verb">高级</span><span class="opill__val">原样保留的内核规则</span></span><OutcomePill v-else :outcome="rule.outcome" /></span>
    <span class="rrow__hits" :title="`启动以来命中 ${hits.toLocaleString('en-US')} 次`">{{ hits ? fmtCount(hits) : '—' }}</span>
    <label class="ui-switch rrow__switch"><input v-model="rule.enabled" type="checkbox" :aria-label="`启用规则：${title}`"><i></i></label>
    <span class="rrow__menu"><UiMenu :items="menu" :label="`规则「${title}」的操作`" :title="`第 ${index} 条 · ${title}`" anchor=".rrow" @select="emit('action', $event)" /></span>
  </li>
</template>
