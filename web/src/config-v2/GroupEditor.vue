<script setup lang="ts">
import { Info, Plus, Trash2, X } from '@lucide/vue'
import UiHelp from '../components/ui/UiHelp.vue'
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import UiSelect from '../components/ui/UiSelect.vue'
import { detectProtocol, PROTOCOL_LABEL, POLLUTED_CIDRS, type Ecs, type Protocol, type UpstreamGroup } from '../config-model/model'
import { groupUsers, model } from './store'

// 上游组的抽屉：名称、地址（每个地址自动认协议，可改）、客户端子网、备用组。被用着的组不能删，说清楚是谁在用。
// The upstream group drawer: name, addresses (protocol detected per address, overridable), client subnet, fallback.
// A group in use cannot be deleted, and the drawer says who uses it.
const props = defineProps<{ groupId: string | null }>()
const emit = defineEmits<{ close: []; saved: [group: UpstreamGroup, isNew: boolean]; deleted: [group: UpstreamGroup, index: number] }>()

const original = props.groupId ? model.groups.find((g) => g.id === props.groupId) ?? null : null
const draft = reactive<UpstreamGroup>(original ? JSON.parse(JSON.stringify(original)) as UpstreamGroup : { id: `u${Date.now().toString(36)}`, name: '', addresses: [{ address: '', protocol: 'auto' }], ecs: null, fallback: { group: '', onError: false, onPolluted: false } })
const showErrors = ref(false)
const dialog = ref<HTMLDialogElement | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)
onMounted(() => {
  dialog.value?.showModal()
  if (!original) void nextTick(() => nameInput.value?.focus())
})

const protocolOptions = (address: string) => [
  { value: 'auto', label: `自动 · ${PROTOCOL_LABEL[detectProtocol(address)]}` },
  ...(['udp', 'tcp', 'tcp_udp', 'doh', 'dot', 'doq'] as Protocol[]).map((p) => ({ value: p, label: PROTOCOL_LABEL[p] })),
]
const ecsChoice = computed(() => (draft.ecs === null ? 'none' : draft.ecs.mode))
const ecsOptions = [{ value: 'none', label: '不处理，原样转发' }, { value: 'clear', label: '不发送客户端子网' }, { value: 'client', label: '发送客户端所在子网' }, { value: 'static', label: '发送固定的子网' }]
function setEcs(choice: string): void {
  const next: Ecs = choice === 'none' ? null : choice === 'clear' ? { mode: 'clear' } : choice === 'client' ? { mode: 'client', v4: 24, v6: 56 } : { mode: 'static', subnet: '' }
  draft.ecs = next
}
const otherGroups = computed(() => model.groups.filter((g) => g.id !== draft.id).map((g) => ({ value: g.id, label: g.name })))
const fallbackOn = computed({
  get: () => draft.fallback.onError || draft.fallback.onPolluted,
  set: (on: boolean) => {
    draft.fallback.onError = on
    draft.fallback.onPolluted = false
    if (on && !draft.fallback.group) draft.fallback.group = otherGroups.value[0]?.value ?? ''
  },
})
const users = computed(() => (original ? groupUsers(original.id) : []))
const problems = computed(() => {
  const out: string[] = []
  if (!draft.name.trim()) out.push('组要有名字')
  else if (model.groups.some((g) => g.id !== draft.id && g.name === draft.name.trim())) out.push('已经有同名的组')
  if (!draft.addresses.some((a) => a.address.trim())) out.push('至少填一个地址')
  if (draft.ecs?.mode === 'static' && !/^[\d.:a-f]+\/\d{1,3}$/i.test(draft.ecs.subnet.trim())) out.push('固定子网写成 203.0.113.0/24 这样')
  if (fallbackOn.value && !draft.fallback.group) out.push('选一个备用组')
  return out
})

function done(): void {
  if (problems.value.length) { showErrors.value = true; return }
  draft.name = draft.name.trim()
  draft.addresses = draft.addresses.filter((a) => a.address.trim()).map((a) => ({ ...a, address: a.address.trim() }))
  if (!fallbackOn.value) draft.fallback = { group: '', onError: false, onPolluted: false }
  const saved = JSON.parse(JSON.stringify(draft)) as UpstreamGroup
  if (original) model.groups.splice(model.groups.indexOf(original), 1, saved)
  else model.groups.push(saved)
  emit('saved', saved, !original)
}
function remove(): void {
  if (!original || users.value.length) return
  const index = model.groups.indexOf(original)
  model.groups.splice(index, 1)
  emit('deleted', original, index)
}
</script>

<template>
  <dialog ref="dialog" class="pdrawer" aria-labelledby="ge-title" @cancel.prevent="emit('close')" @click.self="emit('close')">
    <form class="pdrawer__panel" @submit.prevent="done">
      <header class="pdrawer__head">
        <h2 id="ge-title">{{ original ? `编辑上游组` : '新建上游组' }}</h2>
        <button class="ui-icon-btn" type="button" aria-label="关闭" title="关闭" @click="emit('close')"><X :size="16" /></button>
      </header>
      <div class="pdrawer__body">
        <label class="pfield"><span>名称</span><span class="ui-input"><input ref="nameInput" v-model="draft.name" maxlength="20" placeholder="比如：国内、公司" :aria-invalid="(showErrors && !draft.name.trim()) || undefined"></span></label>

        <div class="pfield">
          <span>地址</span>
          <ul class="addrs">
            <li v-for="(a, i) in draft.addresses" :key="i" class="addr">
              <!-- 手机上每个地址一行小标题，删除放在标题右端，输入框都占满整宽 / On phones each address gets a small header with remove at its right end, so every field is full width -->
              <div class="addr__head"><span>地址 {{ i + 1 }}</span><button class="ui-icon-btn ui-icon-btn--sm" type="button" :aria-label="`删除第 ${i + 1} 个地址`" title="删除地址" :disabled="draft.addresses.length === 1" @click="draft.addresses.splice(i, 1)"><Trash2 :size="16" /></button></div>
              <label class="ui-input is-mono addr__value"><input v-model="a.address" :aria-label="`第 ${i + 1} 个地址`" placeholder="https://dns.example/dns-query 或 223.5.5.5" autocapitalize="off" spellcheck="false"></label>
              <UiSelect v-model="a.protocol" class="addr__proto" :options="protocolOptions(a.address)" :label="`第 ${i + 1} 个地址的协议`" />
              <button class="ui-icon-btn addr__x" type="button" :aria-label="`删除第 ${i + 1} 个地址`" title="删除地址" :disabled="draft.addresses.length === 1" @click="draft.addresses.splice(i, 1)"><Trash2 :size="16" /></button>
            </li>
          </ul>
          <button class="ui-btn ui-btn--text ui-btn--sm addrs__add" type="button" @click="draft.addresses.push({ address: '', protocol: 'auto' })"><Plus :size="14" aria-hidden="true" />添加地址</button>
          <small class="pfield__hint">同时问组里所有地址，用最先回来的回答。协议默认按地址前缀认：https:// 是 DoH，tls:// 是 DoT，quic:// 是 DoQ，没写就是 UDP。</small>
        </div>

        <div class="pfield">
          <span>客户端子网（ECS）</span>
          <div class="pfield__row">
            <UiSelect class="pfield__grow" :model-value="ecsChoice" :options="ecsOptions" label="客户端子网" @update:model-value="setEcs" />
            <template v-if="draft.ecs?.mode === 'client'">
              <label class="ui-input erow__num"><i>IPv4 /</i><input v-model.number="draft.ecs.v4" type="number" min="0" max="32" aria-label="IPv4 前缀长度"></label>
              <label class="ui-input erow__num"><i>IPv6 /</i><input v-model.number="draft.ecs.v6" type="number" min="0" max="128" aria-label="IPv6 前缀长度"></label>
            </template>
          </div>
          <label v-if="draft.ecs?.mode === 'static'" class="ui-input is-mono"><input v-model="draft.ecs.subnet" aria-label="固定子网" placeholder="203.0.113.0/24"></label>
          <small class="pfield__hint">发送子网能让国内 CDN 回离客户端近的地址；内网客户端不会发送。</small>
        </div>

        <div class="pfield">
          <label class="pswitch"><span><b>备用组<UiHelp topic="fallback" /></b><small>这个组的回答不能用时，改问另一个组</small></span><span class="ui-switch"><input v-model="fallbackOn" type="checkbox" aria-label="使用备用组"><i></i></span></label>
          <div v-if="fallbackOn" class="fallback ui-rise">
            <label class="ui-checkbox"><input v-model="draft.fallback.onError" type="checkbox"><i></i>上游回 SERVFAIL 或 REFUSED</label>
            <label class="ui-checkbox"><input v-model="draft.fallback.onPolluted" type="checkbox"><i></i><span>结果被污染 <small class="is-mono">{{ POLLUTED_CIDRS.join('、') }}</small></span></label>
            <div class="pfield__row"><span class="fallback__k">改问</span><UiSelect v-model="draft.fallback.group" class="pfield__grow" :options="otherGroups" label="备用组" /></div>
            <p class="ui-notice ui-notice--off"><Info :size="16" aria-hidden="true" /><span>上游全部超时或连不上时，KixDNS 直接回 SERVFAIL，不会改问备用组。</span></p>
          </div>
        </div>
        <!-- 不能删除的原因写在内容最后，底栏只放动作（手机）/ Why it cannot be deleted closes the content; the footer holds only actions (phone) -->
        <p v-if="original && users.length" class="pdrawer__uses-body">这个组有 {{ users.length }} 处在用，先把它们改到别的组才能删除。</p>
      </div>
      <footer class="pdrawer__foot">
        <template v-if="original">
          <button class="ui-btn ui-btn--text pdrawer__delete" :class="{ 'is-locked': users.length > 0 }" type="button" :disabled="users.length > 0" :title="users.length ? `在用：${users.join('、')}` : ''" @click="remove"><Trash2 :size="16" aria-hidden="true" />删除</button>
        </template>
        <p v-if="showErrors && problems.length" class="pdrawer__problem" role="alert">{{ problems[0] }}</p>
        <p v-else-if="original && users.length" class="pdrawer__uses">{{ users.length }} 处在用，不能删除</p>
        <span class="editor__spacer"></span>
        <button class="ui-btn ui-btn--secondary" type="button" @click="emit('close')">取消</button>
        <button class="ui-btn ui-btn--primary" type="submit">{{ original ? '完成' : '新建' }}</button>
      </footer>
    </form>
  </dialog>
</template>
