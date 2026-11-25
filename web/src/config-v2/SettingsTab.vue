<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { apiRequest } from '../api/client'
import type { QueryLogSettings } from '../api/types'
import SettingsEditor from '../components/config/SettingsEditor.vue'
import { CONFIG_BOOTSTRAP_V1 } from '../config-editor/schema'
import { hasBootstrap, hostNamedUpstream, settingProblems } from '../config-editor/settings-checks'
import QueryLogSettingsForm from '../components/logs/QueryLogSettingsForm.vue'
import UiSelect from '../components/ui/UiSelect.vue'
import UiTabs from '../components/ui/UiTabs.vue'
import { useToast } from '../composables/useToast'
import { compile, defaultUpstreamFromRest, groupName, outcomeProblem, upstreamListProblem, withDefaultPorts } from '../config-model/model'
import { retentionText } from '../querylog'
import { errorMessage } from '../utils'
import { changedSettingKeys, model } from './store'
import { capabilityError, runtimeCapabilities } from './useConfigDocument'

// 基础设置就是现在面板的那一页（监听、连接、缓存、过期缓存、流控、Geo 数据），最前面多一组「规则默认值」。
// 「默认上游」一般不单独出现：它由「其余请求」决定，生成配置时写成那个组的地址。
// The settings tab is today's page (listeners, connections, cache, stale cache, flow control, Geo data) with a 规则默认值
// group in front. 默认上游 does not usually appear on its own: 其余请求 decides it, written as that group's addresses.
// 写进内核的是设置里照写的那个时（有高级规则：它们里面的「允许」还按它走；其余请求拦截时没有组可写），「默认上游」照原样显示、能改、查得出错
// When what reaches the kernel is the setting as written (with advanced rules, whose allow still uses it; when 其余请求 blocks, with no group to
// write), 默认上游 is shown as it is, editable and checked
const hasRaw = computed(() => [...model.rules, ...model.ruleGroups.flatMap((g) => g.rules)].some((r) => r.raw) || Boolean(model.rawPipelines?.length))
const hidden = computed(() => (defaultUpstreamFromRest(model) ? ['default_upstream'] : []))
// 显示出来的「默认上游」照内核读一遍，查的是写进内核的那样（没写端口的补上 53），说法和上游组的地址一样；没写这一项时内核用它的默认值，不查
// The 默认上游 shown is read as the kernel reads it, checking what is written to the kernel (53 for a missing port), worded as an upstream
// group's addresses; absent, the kernel uses its default and nothing is checked
// 别的设置照内核的检查说（见 settings-checks）；KixDNS 没报能力时不按能力说
// The other settings are told as the kernel checks them (see settings-checks); nothing is said by capability while KixDNS reports none
const problems = computed((): Record<string, string> => {
  const value = model.settings.default_upstream
  const problem = hidden.value.length || value === undefined ? null : upstreamListProblem(withDefaultPorts(String(value)))
  return { ...settingProblems(model.settings, capabilityError.value ? null : runtimeCapabilities.value), ...(problem ? { default_upstream: problem } : {}) }
})
// 内核认引导 DNS、却没写，又有上游写成了主机名：保存以后内核会提醒的那件事，在框下面先说一句
// The kernel reads bootstrap, none is written and an upstream is written with a host name: what the kernel will warn about after a
// save is said under the box first
const warnings = computed((): Record<string, string> => {
  if (!runtimeCapabilities.value.includes(CONFIG_BOOTSTRAP_V1) || hasBootstrap(model.settings)) return {}
  const host = hostNamedUpstream(compile(model))
  return host ? { bootstrap: `上游 ${host} 写成了域名，没写引导 DNS 时交给系统解析；KixDNS 接管了本机的 53 端口时会绕回它自己，连不上` } : {}
})
// 默认上游写完（离开这一格、按回车、在框里按 Ctrl+S）时和上游组的地址按「完成」时一样，只写 IP、TCP 主机的按 53 补上端口；写到一半不动它，也不说错
// 默认上游 once written (leaving the box, pressing Enter, Ctrl+S inside it) is treated as an upstream group's addresses on 完成: an IP or TCP
// host alone takes port 53; mid-typing it is left alone, and no mistake is said
const commit = { default_upstream: withDefaultPorts }
const blockItems = [{ value: 'NXDOMAIN', label: 'NXDOMAIN' }, { value: 'REFUSED', label: 'REFUSED' }, { value: 'zero', label: '空地址' }]
const blockNote: Record<string, string> = {
  // 词不拆到两行：「不存在」「放弃」 / Words are not split across lines: 不存在, 放弃
  NXDOMAIN: '告诉客户端域名不\u2060存\u2060在，大多数设备立刻放\u2060弃，不再重\u2060试',
  REFUSED: '告诉客户端拒绝回答，有的设备会换一台 DNS 再问',
  zero: '回答 0.0.0.0 和 ::，浏览器连不上，但能看出是被拦了',
}
const restValue = computed(() => (model.rest.type === 'upstream' ? `up:${model.rest.group}` : 'block'))
// 选的组没了：和规则编辑里一样，框里写已删除的组、标红，下面说怎么改（规则列表最下面那行同时标「要修改」）
// The chosen group is gone: as in the rule editor, the box reads the deleted group in red with what to do below it (the rule list's last row
// is marked 要修改 meanwhile)
const restBroken = computed(() => outcomeProblem(model, model.rest) !== null)
const restOptions = computed(() => [
  ...(restBroken.value && model.rest.type === 'upstream' ? [{ value: restValue.value, label: '已删除的组' }] : []),
  ...model.groups.map((g) => ({ value: `up:${g.id}`, label: g.name })), { value: 'block', label: '拦截' },
])
const setRest = (v: string) => { model.rest = v === 'block' ? { type: 'block', response: 'default' } : { type: 'upstream', group: v.slice(3) } }
const restText = computed(() => (model.rest.type === 'upstream' ? `其余交给「${groupName(model, model.rest.group) ?? '已删除的组'}」` : '其余拦截'))
const lead = computed(() => ({
  id: 'rules',
  title: '规则默认值',
  help: 'defaults',
  description: '拦截怎么回应、其余请求交给谁',
  summary: [`拦截回 ${model.defaults.block === 'zero' ? '空地址' : model.defaults.block}`, restText.value],
}))

// 查询日志是面板自己的设置，不在配置里：读、存都直接走它的接口，保存就生效，不经过「应用配置」。日志页的「设置」是同一份
// The query log is the panel's own setting, not part of the config: it is read and saved through its own endpoint and
// takes effect on saving, without 应用配置. The logs page's 设置 is the same one
const toast = useToast()
const querylog = ref<QueryLogSettings | null>(null)
const querylogError = ref('')
const querylogForm = ref<InstanceType<typeof QueryLogSettingsForm> | null>(null)
async function loadQueryLog(): Promise<void> {
  querylogError.value = ''
  try {
    const s = await apiRequest<QueryLogSettings>('/api/v1/querylog/settings')
    querylog.value = s
    querylogForm.value?.reset(s)
  } catch (error) {
    querylogError.value = `没能读到查询日志设置：${errorMessage(error)}`
  }
}
onMounted(() => { void loadQueryLog() })
const tail = computed(() => {
  const s = querylog.value
  return {
    id: 'querylog',
    title: '查询日志',
    description: '面板自己的设置：保存后立即生效，不用应用配置',
    search: '查询日志 保存多久 保留 最多占用 空间 不记录的域名 清空 querylog',
    summary: s ? [`保存 ${retentionText(s.retention_hours)}`, `最多 ${Math.round(s.max_bytes / 1048576)} MB`, ...(s.storage ? [s.storage.memory ? '存在内存里' : '存在磁盘上'] : [])] : ['保存多久、最多占用'],
  }
})
async function saveQueryLog(): Promise<void> {
  const outcome = await querylogForm.value?.save()
  if (outcome?.status === 'saved') toast.success('查询日志设置已保存')
  else if (outcome?.status === 'unchanged') toast.success('查询日志设置没有改动')
}
</script>

<template>
  <section class="ui-card sets__card" aria-label="基础设置">
    <SettingsEditor v-model="model.settings" v-model:version="model.format" :changed="changedSettingKeys" :hidden-keys="hidden" :lead="lead" :tail="tail" :problems="problems" :warnings="warnings" :commit="commit" :capabilities="runtimeCapabilities">
      <template #lead>
        <div class="ui-setrow">
          <span class="ui-setrow__label"><span>拦截时怎么回应</span><small>规则选「拦截 · 沿用默认」时用这个。{{ blockNote[model.defaults.block] }}。</small></span>
          <div class="ui-setrow__control sets__stack">
            <UiTabs :model-value="model.defaults.block" :items="blockItems" label="拦截时怎么回应" variant="segment" @update:model-value="model.defaults.block = $event as typeof model.defaults.block" />
          </div>
        </div>
        <div class="ui-setrow">
          <span class="ui-setrow__label"><span>其余请求</span><small>{{ hidden.length ? '一条规则都没命中的请求交给哪里。KixDNS 的默认上游也跟\u2060着它，和规则列表最\u2060下\u2060面那行是同一个设置。' : `一条规则都没命中的请求交给哪里，和规则列表最\u2060下\u2060面那行是同一个设置。${hasRaw ? '有高级规则时' : model.rest.type === 'block' ? '选拦截时' : '交给的组没有地址时'}，KixDNS 的默认上游在「基础与监听」里单独设。` }}</small></span>
          <div class="ui-setrow__control sets__stack">
            <UiSelect :model-value="restValue" :options="restOptions" label="其余请求" :invalid="restBroken" @update:model-value="setRest" />
            <p v-if="restBroken" class="ui-field-error">这个组已经删掉了，选一个现有的组</p>
          </div>
        </div>
      </template>
      <template #tail>
        <p v-if="querylogError" class="ui-field-error" role="alert">{{ querylogError }} <button class="ui-btn ui-btn--text ui-btn--sm" type="button" @click="loadQueryLog">重试</button></p>
        <template v-else>
          <QueryLogSettingsForm ref="querylogForm" v-model:settings="querylog" id-prefix="sets-ql" @cleared="toast.success('查询日志已清空')" />
        </template>
      </template>
      <template #tail-actions>
        <button v-if="!querylogError" class="ui-btn ui-btn--primary" type="button" :disabled="!querylog || querylogForm?.busy" :aria-busy="querylogForm?.busy || undefined" @click="saveQueryLog">保存查询日志设置</button>
      </template>
    </SettingsEditor>
  </section>
</template>
