<script setup lang="ts">
import { computed } from 'vue'
import SettingsEditor from '../components/config/SettingsEditor.vue'
import UiSelect from '../components/ui/UiSelect.vue'
import UiTabs from '../components/ui/UiTabs.vue'
import { groupName } from '../config-model/model'
import { changedSettingKeys, model } from './store'
import { runtimeCapabilities } from './useConfigDocument'

// 基础设置就是现在面板的那一页（监听、连接、缓存、过期缓存、流控、统计、Geo 数据），最前面多一组「规则默认值」。
// 「默认上游」不再单独出现：它由「其余请求」决定，生成配置时写成那个组的地址。
// The settings tab is today's page (listeners, connections, cache, stale cache, flow control, stats, Geo data) with a 规则默认值
// group in front. 默认上游 no longer appears on its own: 其余请求 decides it, written as that group's addresses.
const capabilities = computed(() => runtimeCapabilities.value)
// 有高级规则时「默认上游」照原样留着、能改：高级规则里的「允许」还按它走 / With advanced rules 默认上游 stays visible and editable: their allow still uses it
const hidden = computed(() => ([...model.rules, ...model.ruleGroups.flatMap((g) => g.rules)].some((r) => r.raw) || model.rawPipelines?.length ? [] : ['default_upstream']))
const blockItems = [{ value: 'NXDOMAIN', label: 'NXDOMAIN' }, { value: 'REFUSED', label: 'REFUSED' }, { value: 'zero', label: '空地址' }]
const blockNote: Record<string, string> = {
  NXDOMAIN: '告诉客户端域名不存在，大多数设备立刻放弃，不再重试',
  REFUSED: '告诉客户端拒绝回答，有的设备会换一台 DNS 再问',
  zero: '回答 0.0.0.0 和 ::，浏览器连不上，但能看出是被拦了',
}
const restOptions = computed(() => [...model.groups.map((g) => ({ value: `up:${g.id}`, label: g.name })), { value: 'block', label: '拦截' }])
const restValue = computed(() => (model.rest.type === 'upstream' ? `up:${model.rest.group}` : 'block'))
const setRest = (v: string) => { model.rest = v === 'block' ? { type: 'block', response: 'default' } : { type: 'upstream', group: v.slice(3) } }
const restText = computed(() => (model.rest.type === 'upstream' ? `其余交给「${groupName(model, model.rest.group) ?? '已删除的组'}」` : '其余拦截'))
const lead = computed(() => ({
  id: 'rules',
  title: '规则默认值',
  description: '拦截怎么回应、其余请求交给谁',
  summary: [`拦截回 ${model.defaults.block === 'zero' ? '空地址' : model.defaults.block}`, restText.value],
}))
</script>

<template>
  <section class="ui-card sets__card" aria-label="基础设置">
    <SettingsEditor v-model="model.settings" v-model:version="model.format" :capabilities="capabilities" :changed="changedSettingKeys" :hidden-keys="hidden" :lead="lead">
      <template #lead>
        <div class="ui-setrow">
          <span class="ui-setrow__label"><span>拦截时怎么回应</span><small>规则选「拦截 · 沿用默认」时用这个。{{ blockNote[model.defaults.block] }}</small></span>
          <div class="ui-setrow__control sets__stack">
            <UiTabs :model-value="model.defaults.block" :items="blockItems" label="拦截时怎么回应" variant="segment" @update:model-value="model.defaults.block = $event as typeof model.defaults.block" />
          </div>
        </div>
        <div class="ui-setrow">
          <span class="ui-setrow__label"><span>其余请求</span><small>一条规则都没命中的请求交给哪里。KixDNS 的默认上游也跟着它，和规则列表最下面那行是同一个设置</small></span>
          <div class="ui-setrow__control"><UiSelect :model-value="restValue" :options="restOptions" label="其余请求" @update:model-value="setRest" /></div>
        </div>
      </template>
    </SettingsEditor>
  </section>
</template>
