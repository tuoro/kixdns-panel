<script setup lang="ts">
import { computed, useId } from 'vue'
import UiSelect from '../components/ui/UiSelect.vue'
import UiTabs from '../components/ui/UiTabs.vue'
import { isDomain, isIp, splitList, type Outcome, type Remedy } from '../config-model/model'
import { model } from './store'
import { canCname } from './useConfigDocument'
import { blockOptions, groupBrief } from './view'

// 一个结果要填的东西：上游组、拦截怎么回、自定义回答的内容……规则的「那么」和回答检查的「然后/否则」共用
// What an outcome needs filled in: the group, how a block answers, a custom answer's content… shared by a rule's outcome and the answer check's then/otherwise
const props = defineProps<{ modelValue: Outcome | Remedy; showErrors: boolean; label: string }>()
const answerErrId = `${useId()}-answer-err`
const emit = defineEmits<{ 'update:modelValue': [value: Outcome | Remedy]; editGroup: [id: string] }>()

const set = (change: Record<string, unknown>) => emit('update:modelValue', { ...props.modelValue, ...change } as Outcome | Remedy)
const groupOptions = computed(() => model.groups.map((g) => ({ value: g.id, label: g.name })))
const ruleGroupOptions = computed(() => model.ruleGroups.map((g) => ({ value: g.id, label: g.name })))
// 内核不支持固定 CNAME 时这一项灰掉（现在已经选了的不动） / CNAME greys out when the kernel lacks it (an existing choice stays)
const kindItems = computed(() => [{ value: 'ip', label: 'IP' }, { value: 'cname', label: 'CNAME', disabled: !canCname.value && !(props.modelValue.type === 'answer' && props.modelValue.kind === 'cname') }, { value: 'txt', label: 'TXT' }])
const group = computed(() => (props.modelValue.type === 'upstream' ? model.groups.find((g) => g.id === (props.modelValue as { group: string }).group) : undefined))
const answerProblem = computed(() => {
  const o = props.modelValue
  if (o.type !== 'answer') return null
  if (!o.value.trim()) return '还没填回答的内容'
  if (o.kind === 'ip' && !splitList(o.value).every(isIp)) return 'IP 写得不对，几个 IP 用逗号隔开'
  if (o.kind === 'cname' && !isDomain(o.value.trim())) return '域名写得不对'
  return null
})
</script>

<template>
  <div class="oparams" :class="{ 'oparams--up': modelValue.type === 'upstream' }">
    <template v-if="modelValue.type === 'upstream'">
      <div class="oparams__line">
        <UiSelect class="oparams__main" :model-value="modelValue.group" :options="group ? groupOptions : [{ value: modelValue.group, label: '已删除的组' }, ...groupOptions]" :label="`${label}：上游组`" :invalid="!group" @update:model-value="set({ group: $event })" />
        <button v-if="group" class="ui-link oparams__edit" type="button" @click="emit('editGroup', modelValue.group)">编辑这个组</button>
      </div>
      <p v-if="group" class="oparams__note">{{ groupBrief(group) }}</p>
      <p v-else class="ui-field-error">这个组已经删掉了，选一个现有的组</p>
    </template>
    <template v-else-if="modelValue.type === 'block'">
      <UiSelect class="oparams__main" :model-value="modelValue.response" :options="blockOptions(model)" :label="`${label}：怎么回应`" @update:model-value="set({ response: $event })" />
    </template>
    <template v-else-if="modelValue.type === 'answer'">
      <div class="oparams__line">
        <UiTabs :model-value="modelValue.kind" :items="kindItems" :label="`${label}：记录类型`" variant="segment" @update:model-value="set({ kind: $event, value: '', ttl: null })" />
        <label class="ui-input oparams__value" :class="{ 'is-mono': modelValue.kind !== 'txt' }">
          <input :value="modelValue.value" :aria-label="`${label}：回答内容`" :aria-invalid="(showErrors && Boolean(answerProblem)) || undefined" :aria-describedby="showErrors && answerProblem ? answerErrId : undefined" :placeholder="modelValue.kind === 'ip' ? '192.168.1.10, fd00::10' : modelValue.kind === 'cname' ? 'target.example.com' : '要回答的文字'" autocapitalize="off" spellcheck="false" @input="set({ value: ($event.target as HTMLInputElement).value })">
        </label>
        <label v-if="modelValue.kind !== 'ip'" class="ui-input oparams__ttl">
          <input type="number" min="0" :value="modelValue.ttl ?? ''" :aria-label="`${label}：TTL`" placeholder="300" @input="set({ ttl: ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value) })"><i>秒</i>
        </label>
      </div>
      <p v-if="showErrors && answerProblem" :id="answerErrId" class="ui-field-error">{{ answerProblem }}</p>

      <p v-else class="oparams__note">{{ modelValue.kind === 'ip' ? '几个地址用逗号隔开，按查询类型回 A 或 AAAA，TTL 固定 300 秒' : modelValue.kind === 'cname' ? '回答一条 CNAME，客户端再去解析目标域名' : '常用于 CH 类的 version.bind 这类查询' }}</p>
      <p v-if="!canCname" class="oparams__note is-warn">当前 KixDNS 不支持固定 CNAME，更新或切换内核后才能选{{ modelValue.kind === 'cname' ? '；这里已经选了，保存时会被内核拒绝' : '' }}</p>
    </template>
    <template v-else-if="modelValue.type === 'group'">
      <UiSelect v-if="ruleGroupOptions.length" class="oparams__main" :model-value="modelValue.group" :options="ruleGroupOptions" :label="`${label}：规则组`" @update:model-value="set({ group: $event })" />
      <p v-else class="oparams__note">还没有规则组。在规则页底部新建一个，再回来选。</p>
    </template>
    <template v-else-if="modelValue.type === 'rewrite_txt'">
      <label class="ui-input oparams__main">
        <input :value="modelValue.value" :aria-label="`${label}：新的 TXT 内容`" placeholder="新的 TXT 内容" @input="set({ value: ($event.target as HTMLInputElement).value })">
      </label>
    </template>
  </div>
</template>
