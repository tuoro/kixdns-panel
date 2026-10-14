<script setup lang="ts">
import { jsonProblemText, jsonSyntaxProblem } from '../json-problem'
import { Braces, FileUp, FlaskConical, ListFilter, Plus, Search, X } from '@lucide/vue'
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, reactive, ref, toRefs } from 'vue'
import UiHelp from '../components/ui/UiHelp.vue'
import UiMenu from '../components/ui/UiMenu.vue'
import UiSelect from '../components/ui/UiSelect.vue'
import { useConfirm } from '../composables/useConfirm'
import { useToast } from '../composables/useToast'
import { GEOSITE_COMMON, geositeIssue } from '../config-model/geosite'
import { isCidr, isDomain, newRule, outcomeSentence, rawMatchersText, type Condition, type Outcome, type Rule, type RuleGroup, ruleTitle } from '../config-model/model'
import { useNarrowDesktop, usePhone } from './phone'
import RuleList from './RuleList.vue'
import Tester from './Tester.vue'
import { model, newId, ruleGroupUsers, trackDialogEdits, ui } from './store'
import { useGeositeCatalog } from './useGeosite'
import { isTyping } from '../utils'
// JSON 编辑器（CodeMirror）只在用到时才加载：配置页的首包不带它 / The JSON editor (CodeMirror) loads on first use, so the config page's first chunk leaves it out
const JsonEditor = defineAsyncComponent(() => import('../components/JsonEditor.vue'))

// 规则页：工具栏（搜索、按结果筛、新建）、快速添加、主列表、规则组、高级入口。第一次用时是起步引导。
// The rules tab: toolbar (search, filter by outcome, new), quick add, the main list, rule groups and advanced entries. On first
// use it is a getting-started guide.
// selected：右侧面板正在编辑的规则，列表里标出来 / selected: the rule open in the inspector, marked in the list
defineProps<{ selected: number | null }>()
const emit = defineEmits<{ open: [ruleId: number | null, groupId: string | null, template?: Partial<Rule>]; tab: [name: string]; editGroup: [id: string | null]; import: [] }>()
const toast = useToast()
const confirm = useConfirm()
// 两个弹层关上之前都对照一下：改过就问一句，和规则、上游组的编辑一样 / Both dialogs compare before closing: ask if anything changed, as rule and upstream group editing do
const askDiscard = (what: string) => confirm.ask({ title: `放弃${what}的修改`, body: '刚才在这里改的内容不会写进草稿。', confirmLabel: '放弃修改', cancelLabel: '继续编辑', destructive: true })
// 规则页快捷键：/ 聚焦搜索，n 新建规则；输入框里、按着修饰键、弹层开着时不抢 / Rules page shortcuts: / focuses the search, n starts a new rule; not while typing, with modifiers held, or while a dialog is open
const searchInput = ref<HTMLInputElement | null>(null)
function onPageKey(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (isTyping(event.target)) return
  if (document.querySelector('dialog[open]')) return
  if (event.key === '/') { event.preventDefault(); searchInput.value?.focus() }
  else if (event.key === 'n') { event.preventDefault(); emit('open', null, null) }
}
onMounted(() => window.addEventListener('keydown', onPageKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onPageKey))
const { query, kind } = toRefs(ui)
const kinds = [{ value: '', label: '全部结果' }, { value: 'upstream', label: '交给上游组' }, { value: 'block', label: '拦截' }, { value: 'answer', label: '自定义回答' }, { value: 'group', label: '转到规则组' }, { value: 'continue', label: '继续往下' }]
// 测试域名：问 KixDNS 正在用的配置；命中的规则（或域名映射）在列表里标出来 / 测试域名 asks the running config; the matched rule (or mapping) is marked in the list
const testing = ref(false)
const matchedRule = ref<number | null>(null)
const matchedMapping = ref(false)
const marks = computed(() => new Map<number, 'hit' | 'pass'>(matchedRule.value === null ? [] : [[matchedRule.value, 'hit']]))
function onMatched(ruleId: number | null, mapping: boolean): void { matchedRule.value = ruleId; matchedMapping.value = mapping }
function toggleTester(): void { testing.value = !testing.value; if (!testing.value) onMatched(null, false) }
async function quickFromTester(domainName: string): Promise<void> { quick.text = domainName; quickOpen.value = true; await nextTick(); quickInput.value?.focus() }

// 新建就是一条空白规则：主按钮只干一件事，带知识的预设在用得到的地方（「回答后检查」的常用、GeoSite 的候选）
// New means a blank rule: the primary button does one thing, and the presets that carry know-how live where they apply (回答后检查's 常用, GeoSite suggestions)
const cond = (field: Condition['field'], values: string[], negate = false): Condition => ({ id: newId(), field, values, negate, regex: false })

// ---------- 快速添加：一行写值，选结果，回车 / quick add: values on one line, pick an outcome, Enter ----------
const phone = usePhone()
const narrow = useNarrowDesktop()
const quick = reactive({ text: '', target: '' })
// 宽屏上快速添加藏在工具行的「快速添加」后面，点开才占一行；手机上一直在 / On wide screens quick add hides behind the toolbar's 快速添加 and takes a row only when opened; on phones it is always there
const quickOpen = ref(false)
async function toggleQuick(): Promise<void> { quickOpen.value = !quickOpen.value; if (quickOpen.value) { await nextTick(); quickInput.value?.focus() } }
const quickInput = ref<HTMLInputElement | null>(null)
const quickTargets = computed(() => [...model.groups.map((g) => ({ value: `up:${g.id}`, label: `交给「${g.name}」` })), { value: 'block', label: '拦截' }])
// 选过的组被删了或换了一份配置，就落回第一项 / If the chosen group is gone or the config changed, fall back to the first option
const quickTarget = computed({ get: () => (quickTargets.value.some((o) => o.value === quick.target) ? quick.target : quickTargets.value[0]?.value ?? 'block'), set: (v: string) => { quick.target = v } })
const quickOutcome = (): Outcome => (quickTarget.value === 'block' ? { type: 'block', response: 'default' } : { type: 'upstream', group: quickTarget.value.slice(3) })
// 认值：IP 或网段是客户端 IP，「geosite:」或 GeoSite 数据里有的分类是 GeoSite，其余是域名；数据读全时，写了数据里没有的分类直接说
// IP or range is client IP, 「geosite:」 or a category in the GeoSite data is GeoSite, the rest are domains; with the data read
// completely, a category the data lacks is said at once
const geosite = useGeositeCatalog()
const knownCategory = (t: string): boolean => geosite.value.categories.has(t.toLowerCase()) || (GEOSITE_COMMON as readonly string[]).includes(t.toLowerCase())
const parsed = computed<{ field: Condition['field']; values: string[] } | { error: string } | null>(() => {
  const tokens = quick.text.split(/[\s,，]+/).map((t) => t.trim()).filter(Boolean)
  if (!tokens.length) return null
  const kindOf = (t: string): Condition['field'] | null => (isCidr(t) ? 'client_ip' : /^geosite:/i.test(t) || knownCategory(t) ? 'geosite' : isDomain(t) ? 'domain' : null)
  const bad = tokens.find((t) => !kindOf(t))
  if (bad) return { error: `认不出「${bad}」：写域名、geosite:分类或 IP 网段` }
  const kinds = new Set(tokens.map(kindOf))
  if (kinds.size > 1) return { error: '一次只加一种：域名、GeoSite 或 IP 网段' }
  const field = [...kinds][0]!
  const values = tokens.map((t) => (field === 'geosite' ? t.replace(/^geosite:/i, '').toLowerCase() : t))
  const missing = field === 'geosite' ? values.find((v) => geositeIssue(v, geosite.value)?.kind === 'category' || geositeIssue(v, geosite.value)?.kind === 'attribute') : undefined
  if (missing) return { error: `当前 GeoSite 数据里没有「${missing}」` }
  return { field, values }
})
const ok = computed(() => (parsed.value && !('error' in parsed.value) ? parsed.value : null))
const LABEL: Record<string, string> = { domain: '域名', geosite: 'GeoSite', client_ip: '客户端 IP' }
// 已有一条只有这一个条件、结果一样的规则，就并进去 / A rule with just this one condition kind and the same outcome takes the values
const mergeInto = computed(() => {
  const p = ok.value
  if (!p) return null
  const out = JSON.stringify(quickOutcome())
  return model.rules.find((r) => r.enabled && !r.raw && r.conditions.length === 1 && r.conditions[0]!.length === 1 && r.conditions[0]![0]!.field === p.field && !r.conditions[0]![0]!.negate && !r.conditions[0]![0]!.regex
    && JSON.stringify(r.outcome) === out && !r.log.enabled && r.ecs === 'inherit' && r.response.mode === 'inherit') ?? null
})
const quickHint = computed(() => {
  if (!parsed.value) return ''
  if ('error' in parsed.value) return parsed.value.error
  const p = parsed.value
  const sentence = outcomeSentence(model, quickOutcome())
  // 「GeoSite」「客户端 IP」这类以拉丁字母结尾的名字后面空一格再接中文 / A name ending in Latin letters (GeoSite, 客户端 IP) takes a space before the Chinese that follows
  const label = /[A-Za-z]$/.test(LABEL[p.field] ?? '') ? `${LABEL[p.field]} ` : LABEL[p.field]
  return mergeInto.value ? `加到「${ruleTitle(mergeInto.value)}」里：${label}多 ${p.values.length} 个，${sentence}` : `新建一条规则：${label}是 ${p.values.join('、')}，${sentence}`
})
function quickAdd(): void {
  const p = ok.value
  if (!p) return
  const target = mergeInto.value
  if (target) {
    const c = target.conditions[0]![0]!
    const before = [...c.values]
    c.values = [...new Set([...c.values, ...p.values])]
    toast.undoable(`已加到「${ruleTitle(target)}」`, () => { c.values = before })
  } else {
    const rule: Rule = { ...newRule(newId(), quickOutcome()), conditions: [[cond(p.field, p.values)]] }
    model.rules.push(rule)
    toast.undoable(`已添加规则「${ruleTitle(rule)}」`, () => { const i = model.rules.indexOf(rule); if (i >= 0) model.rules.splice(i, 1) })
    void nextTick(() => document.querySelector(`[data-rule="${rule.id}"]`)?.scrollIntoView({ block: 'nearest' }))
  }
  quick.text = ''
  quickInput.value?.focus()
}

// ---------- 第一次用 / first use ----------
const firstRun = computed(() => !model.groups.length && !model.rules.length)
const STARTS = [
  { value: 'split', title: '国内外分流', badge: '推荐', desc: '国内域名问腾讯和阿里的 DoH，结果被污染时改问国外；其余问 Cloudflare 和 Google 的 DoH。' },
  { value: 'single', title: '全部交给一组上游', desc: '所有请求都问 Cloudflare 和 Google 的 DoH，之后再按需加规则。' },
  { value: 'blank', title: '从空白开始', desc: '先建一个上游组，写上你自己的地址。' },
]
const start = ref('split')
const START_PREVIEWS: Record<string, { groups: { name: string; note: string }[]; rules: { name: string; note: string }[] }> = {
  split: {
    groups: [{ name: '国内', note: '腾讯、阿里的 DoH，结果被污染时改问「国外」' }, { name: '国外', note: 'Cloudflare、Google 的 DoH' }],
    rules: [{ name: '国内域名', note: '域名属于 GeoSite cn 时交给「国内」' }, { name: '其余请求', note: '交给「国外」' }],
  },
  single: {
    groups: [{ name: '默认', note: 'Cloudflare、Google 的 DoH' }],
    rules: [{ name: '其余请求', note: '交给「默认」' }],
  },
  blank: {
    groups: [{ name: '新上游组', note: '接下来写上你自己的地址' }],
    rules: [{ name: '其余请求', note: '交给这个组' }],
  },
}
const startPreview = computed(() => START_PREVIEWS[start.value] ?? START_PREVIEWS.split)
function useStart(): void {
  const doh = (a: string) => ({ address: a, protocol: 'auto' as const })
  const none = { group: '', onError: false, onPolluted: false }
  if (start.value === 'blank') { emit('editGroup', null); return }
  model.groups.push({ id: 'abroad', name: start.value === 'split' ? '国外' : '默认', addresses: [doh('https://cloudflare-dns.com/dns-query'), doh('https://dns.google/dns-query')], ecs: null, fallback: none })
  if (start.value === 'split') {
    model.groups.push({ id: 'cn', name: '国内', addresses: [doh('https://doh.pub/dns-query'), doh('https://dns.alidns.com/dns-query')], ecs: { mode: 'client', v4: 24, v6: 56 }, fallback: { group: 'abroad', onError: false, onPolluted: true } })
    model.rules.push({ ...newRule(newId(), { type: 'upstream', group: 'cn' }), name: '国内域名', conditions: [[cond('geosite', ['cn'])]] })
  }
  model.rest = { type: 'upstream', group: 'abroad' }
  toast.success(start.value === 'split' ? '已建好「国内」「国外」两个上游组和一条规则，保存后生效' : '已建好上游组「默认」，保存后生效')
}

// ---------- 规则组 / rule groups ----------
const dialog = ref<HTMLDialogElement | null>(null)
const editing = reactive({ id: '', name: '', note: '', listener: '', isNew: true })
// 弹层开着时是打开那一刻的样子，关上后是 null；改过时离开页面或刷新也先问
// While the dialog is open this is how it looked when opened, null once closed; edited, leaving the page or reloading asks first too
const editingBase = ref<string | null>(null)
trackDialogEdits('这个规则组', () => editingBase.value !== null && JSON.stringify(editing) !== editingBase.value)
async function openGroup(group: RuleGroup | null): Promise<void> {
  Object.assign(editing, group ? { id: group.id, name: group.name, note: group.note, listener: group.listener, isNew: false } : { id: '', name: '', note: '', listener: '', isNew: true })
  editingBase.value = JSON.stringify(editing)
  await nextTick()
  dialog.value?.showModal()
}
async function leaveGroup(): Promise<void> {
  if (JSON.stringify(editing) !== editingBase.value && !(await askDiscard('这个规则组'))) return
  dialog.value?.close()
}
function saveGroup(): void {
  if (!editing.name.trim()) return
  if (editing.isNew) {
    const id = `g${Date.now().toString(36)}`
    model.ruleGroups.push({ id, name: editing.name.trim(), note: editing.note.trim(), listener: editing.listener.trim(), rules: [], rest: model.rest.type === 'upstream' ? { ...model.rest } : { type: 'upstream', group: model.groups[0]?.id ?? '' } })
  } else Object.assign(model.ruleGroups.find((x) => x.id === editing.id)!, { name: editing.name.trim(), note: editing.note.trim(), listener: editing.listener.trim() })
  dialog.value?.close()
}
function groupAction(group: RuleGroup, value: string): void {
  if (value === 'edit') void openGroup(group)
  else if (value === 'add') emit('open', null, group.id)
  else if (value === 'delete') {
    const at = model.ruleGroups.indexOf(group)
    model.ruleGroups.splice(at, 1)
    toast.undoable(`已删除规则组「${group.name}」`, () => model.ruleGroups.splice(at, 0, group))
  }
}
const groupMenu = (group: RuleGroup) => [
  { value: 'add', label: '在组里新建规则' },
  { value: 'edit', label: '名称和监听标签' },
  { value: 'delete', label: ruleGroupUsers(group.id).length ? '删除（先改掉转到这里的规则）' : '删除', danger: true, disabled: ruleGroupUsers(group.id).length > 0 },
]

// ---------- 高级入口 / advanced entries ----------
const entriesDialog = ref<HTMLDialogElement | null>(null)
const entriesText = ref('')
const entriesError = computed(() => {
  const problem = jsonSyntaxProblem(entriesText.value)
  if (problem) return jsonProblemText(problem)
  const v = JSON.parse(entriesText.value) as unknown
  return Array.isArray(v) && v.every((e) => e && typeof e === 'object' && typeof (e as { pipeline?: unknown }).pipeline === 'string') ? '' : '要写成入口的数组，每个入口有 pipeline'
})
const pipelineLabel = (id: string) => model.ruleGroups.find((g) => (g.pipelineId ?? `group-${g.id}`) === id)?.name ?? model.groups.find((g) => (g.pipelineId ?? `upstream-${g.id}`) === id)?.name ?? id
const entriesBase = ref<string | null>(null)
trackDialogEdits('高级入口', () => entriesBase.value !== null && entriesText.value !== entriesBase.value)
async function editEntries(): Promise<void> {
  entriesText.value = JSON.stringify(model.entries ?? [], null, 2)
  entriesBase.value = entriesText.value
  await nextTick()
  entriesDialog.value?.showModal()
}
async function leaveEntries(): Promise<void> {
  if (entriesText.value !== entriesBase.value && !(await askDiscard('高级入口'))) return
  entriesDialog.value?.close()
}
function saveEntries(): void {
  if (entriesError.value) return
  const v = JSON.parse(entriesText.value) as NonNullable<typeof model.entries>
  if (v.length) model.entries = v
  else delete model.entries
  entriesDialog.value?.close()
}
</script>

<template>
  <div class="rules">
    <section v-if="firstRun" class="ui-card onboard ui-rise" aria-labelledby="ob-title">
      <div class="onboard__main">
        <h2 id="ob-title" class="onboard__title">先定下 DNS 往哪里问</h2>
        <p class="onboard__desc">规则只决定请求交给哪个上游组，上游组里写地址。选一个起点，之后都能改。</p>
        <div class="ui-pick onboard__pick" role="radiogroup" aria-label="起点">
          <label v-for="s in STARTS" :key="s.value" class="ui-pick__opt"><input v-model="start" type="radio" name="start" :value="s.value"><b>{{ s.title }}<span v-if="s.badge" class="ui-tag onboard__badge">{{ s.badge }}</span></b><small>{{ s.desc }}</small></label>
        </div>
        <div class="onboard__acts">
          <button class="ui-btn ui-btn--primary" type="button" @click="useStart">{{ start === 'blank' ? '新建上游组' : '用这个起点' }}</button>
          <button class="ui-btn ui-btn--text onboard__import" type="button" @click="emit('import')"><FileUp :size="16" aria-hidden="true" />导入已有的配置文件</button>
        </div>
      </div>
      <!-- 右边写清楚选中的起点会建好什么：点之前就知道结果 / The right side spells out what the chosen start creates, so the result is known before the click -->
      <aside class="onboard__preview" aria-label="会建好的内容">
        <h3 class="onboard__preview-title">会建好这些</h3>
        <dl class="onboard__list">
          <dt>上游组</dt>
          <dd v-for="g in startPreview.groups" :key="g.name"><b>{{ g.name }}</b><span>{{ g.note }}</span></dd>
          <dt>规则</dt>
          <dd v-for="r in startPreview.rules" :key="r.name"><b>{{ r.name }}</b><span>{{ r.note }}</span></dd>
        </dl>
        <p class="onboard__preview-note">保存之前都不会生效，建好后每一项都能改。</p>
      </aside>
    </section>

    <template v-else>
      <!-- 手机：搜索、筛选、新建一行；宽屏：新建传送到页头，搜索和筛选进列表卡片顶上 / Phones: search, filter and new in one row; wide screens: new teleports to the page header, search and filter sit at the top of the list card -->
      <div v-if="phone" class="toolbar">
        <label class="ui-input toolbar__search"><Search :size="16" aria-hidden="true" /><input v-model="query" type="search" aria-label="搜索规则" placeholder="搜索规则" @keydown.esc="query = ''"><button v-if="query" class="ui-input__affix" type="button" aria-label="清除搜索" @click="query = ''"><X :size="14" /></button></label>
        <!-- 手机上筛选是一个图标按钮，点开是系统的选择列表；筛了以后按钮压下去 / On a phone the filter is an icon button opening the system picker; it looks pressed while filtering -->
        <label class="ui-btn ui-btn--secondary toolbar__filter" :class="{ 'is-pressed': kind }" :title="kinds.find((k) => k.value === kind)?.label"><ListFilter :size="16" aria-hidden="true" /><select v-model="kind" aria-label="按结果筛选"><option v-for="k in kinds" :key="k.value" :value="k.value">{{ k.label }}</option></select></label>
        <span class="toolbar__spacer"></span>
        <button class="ui-btn ui-btn--secondary toolbar__icon" type="button" :aria-pressed="testing" :class="{ 'is-pressed': testing }" aria-label="测试域名" @click="toggleTester"><FlaskConical :size="16" aria-hidden="true" /></button>
        <button class="ui-btn ui-btn--secondary toolbar__icon" type="button" aria-label="新建规则" @click="emit('open', null, null)"><Plus :size="16" aria-hidden="true" /></button>
      </div>
      <Teleport v-else defer to="#cfg-actions">
        <button class="ui-btn ui-btn--secondary" type="button" :aria-pressed="testing" :class="{ 'is-pressed': testing }" @click="toggleTester"><FlaskConical :size="16" aria-hidden="true" />测试域名</button>
        <button class="ui-btn ui-btn--primary" type="button" @click="emit('open', null, null)"><Plus :size="16" aria-hidden="true" />新建规则</button>
      </Teleport>

      <Tester v-if="testing" @close="toggleTester" @matched="onMatched" @quick="quickFromTester" />

      <section class="ui-card rcard" aria-label="规则列表">
        <div v-if="!phone" class="rcard__tools">
          <label class="ui-input rcard__search"><Search :size="16" aria-hidden="true" /><input ref="searchInput" v-model="query" type="search" aria-label="搜索规则" placeholder="搜索规则名、域名或 IP" @keydown.esc="query = ''"><button v-if="query" class="ui-input__affix" type="button" aria-label="清除搜索" @click="query = ''"><X :size="14" /></button></label>
          <UiSelect v-model="kind" class="rcard__kind" :options="kinds" label="按结果筛选" />
          <span class="toolbar__spacer"></span>
          <button class="ui-btn ui-btn--text rcard__quick" type="button" :aria-expanded="quickOpen" @click="toggleQuick"><Plus :size="16" aria-hidden="true" />快速添加</button>
        </div>
        <form v-if="phone || quickOpen" class="qadd" :class="{ 'is-typing': quick.text.trim() }" @submit.prevent="quickAdd">
          <Plus class="qadd__icon" :size="16" aria-hidden="true" />
          <label class="qadd__input"><input ref="quickInput" v-model="quick.text" aria-label="快速添加：域名、GeoSite 或 IP 网段" :placeholder="narrow ? '域名、geosite:分类 或网段' : '域名、geosite:分类 或网段，空格隔开'" autocapitalize="off" spellcheck="false"></label>
          <UiSelect v-model="quickTarget" class="qadd__target" :options="quickTargets" label="快速添加的结果" :size="phone ? 'md' : 'sm'" />
          <button class="ui-btn ui-btn--secondary qadd__btn" :class="{ 'ui-btn--sm': !phone }" type="submit" :disabled="!ok">{{ mergeInto ? '加进去' : '添加' }}</button>
          <p v-if="quickHint" class="qadd__hint" :class="{ 'is-err': !ok }" role="status">{{ quickHint }}</p>
        </form>
        <p class="rcard__order">从上往下判断，第一条决定结果的规则生效。</p>
        <RuleList :rules="model.rules" :owner="model" :in-group="false" :query="query" :kind="kind" :marks="marks" :selected="selected" :rest-mark="false" :mapping-mark="matchedMapping" @open="emit('open', $event, null)" @mappings="emit('tab', 'mapping')">
          <template #empty><div class="rcard__empty"><ListFilter :size="16" aria-hidden="true" /><span>{{ phone ? '还没有规则，所有请求都按最下面的「其余请求」处理。用上面一行添加，或点\u00a0+\u00a0新建规则。' : '还没有规则，所有请求都按最下面的「其余请求」处理。点「快速添加」或「新建规则」开始。' }}</span></div></template>
        </RuleList>
      </section>

      <section class="rgroups" aria-labelledby="rg-title">
        <header class="rgroups__head">
          <div><h2 id="rg-title" class="rgroups__title">规则组<UiHelp topic="groups" /></h2><p class="rgroups__desc">一组单独的规则。请求由「转到规则组」带进来，或者按<span class="nowrap">监听标签</span>直接进来。</p></div>
          <button class="ui-btn ui-btn--secondary" type="button" @click="openGroup(null)"><Plus :size="16" aria-hidden="true" />新建规则组</button>
        </header>
        <section v-if="model.entries?.length" class="ui-card rcard entries" aria-labelledby="ent-title">
          <header class="rcard__head">
            <div class="rcard__title"><h3 id="ent-title">高级入口</h3><span class="rcard__meta">带着监听标签或认不出的条件，原样保留，排在所有规则前面</span></div>
            <button class="ui-btn ui-btn--secondary ui-btn--sm ui-btn--inline" type="button" @click="editEntries"><Braces :size="14" aria-hidden="true" />编辑</button>
          </header>
          <ol class="entries__list"><li v-for="(e, i) in model.entries" :key="i"><span class="entries__ord">{{ i + 1 }}</span><span class="entries__cond">{{ rawMatchersText(e.matchers, e.matcher_operator) }}</span><span class="entries__to">进入「{{ pipelineLabel(e.pipeline) }}」</span></li></ol>
        </section>
        <div v-if="!model.ruleGroups.length && !model.entries?.length" class="rgroups__none"><ListFilter :size="16" aria-hidden="true" /><span>还没有规则组。</span></div>
        <section v-for="g in model.ruleGroups" :key="g.id" class="ui-card rcard" :aria-label="`规则组：${g.name}`">
          <header class="rcard__head">
            <div class="rcard__title"><h3>{{ g.name }}</h3><span v-if="g.note" class="rcard__meta">{{ g.note }}</span></div>
            <span class="rcard__facts">
              <span v-if="ruleGroupUsers(g.id).length || !g.listener">{{ ruleGroupUsers(g.id).length ? `从「${ruleGroupUsers(g.id).map((r) => ruleTitle(r)).join('」「')}」转进来` : '还没有规则转到这里' }}</span>
              <span v-if="g.listener" class="ui-tag ui-tag--mono">监听标签 {{ g.listener }}</span>
            </span>
            <!-- 新建在标题行，和「高级入口」的「编辑」一样；表格上面不再多一层，「其余请求」永远是最后一行
                 新建 sits in the title row like 高级入口's 编辑, so no extra strip above the table and 其余请求 stays the last row -->
            <button class="ui-btn ui-btn--secondary ui-btn--sm ui-btn--inline rcard__new" type="button" @click="emit('open', null, g.id)"><Plus :size="14" aria-hidden="true" />新建规则</button>
            <UiMenu :items="groupMenu(g)" :label="`规则组「${g.name}」的操作`" @select="groupAction(g, $event)" />
          </header>
          <RuleList :rules="g.rules" :owner="g" :in-group="true" :query="query" :kind="kind" :marks="marks" :selected="selected" :rest-mark="false" :mapping-mark="false" @open="emit('open', $event, g.id)" />
        </section>
      </section>
    </template>

    <dialog ref="dialog" class="pdialog" aria-labelledby="rgd-title" @cancel.prevent="leaveGroup" @click.self="leaveGroup" @close="editingBase = null">
      <form class="pdialog__panel" method="dialog" @submit.prevent="saveGroup">
        <header class="pdialog__head"><h2 id="rgd-title">{{ editing.isNew ? '新建规则组' : '规则组的名称和监听标签' }}</h2><button class="ui-icon-btn" type="button" aria-label="关闭" @click="leaveGroup"><X :size="16" /></button></header>
        <div class="pdialog__body">
          <label class="pfield"><span>名称</span><span class="ui-input"><input v-model="editing.name" autofocus required maxlength="30" placeholder="比如：内网解析"></span></label>
          <label class="pfield"><span>说明 <small>可选</small></span><span class="ui-input"><input v-model="editing.note" maxlength="80" placeholder="这组规则管什么"></span></label>
          <label class="pfield"><span>监听标签 <small>可选</small></span><span class="ui-input is-mono"><input v-model="editing.listener" maxlength="30" placeholder="比如 lan"></span><small class="pfield__hint">填了以后，带这个标签的监听收到的请求直接进这个组，不经过主列表（域名映射照样先生效）。留空就只能由「转到规则组」带进来。</small></label>
        </div>
        <footer class="pdialog__foot"><button class="ui-btn ui-btn--secondary" type="button" @click="leaveGroup">取消</button><button class="ui-btn ui-btn--primary" type="submit" :disabled="!editing.name.trim()">{{ editing.isNew ? '新建' : '完成' }}</button></footer>
      </form>
    </dialog>

    <dialog ref="entriesDialog" class="pdrawer pdrawer--wide" aria-labelledby="ent-d-title" @cancel.prevent="leaveEntries" @click.self="leaveEntries" @close="entriesBase = null">
      <div class="pdrawer__panel">
        <header class="pdrawer__head"><div class="pdrawer__titles"><h2 id="ent-d-title">编辑高级入口</h2><p>直接写内核的入口：pipeline 填要进的规则组 ID，matchers 填条件。按顺序看，第一个命中的生效。</p></div><button class="ui-icon-btn" type="button" aria-label="关闭" @click="leaveEntries"><X :size="16" /></button></header>
        <div class="pdrawer__body"><JsonEditor v-model="entriesText" /><p v-if="entriesError" class="ui-field-error" aria-live="polite">{{ entriesError }}</p></div>
        <footer class="pdrawer__foot"><button class="ui-btn ui-btn--secondary" type="button" @click="leaveEntries">取消</button><button class="ui-btn ui-btn--primary" type="button" :disabled="Boolean(entriesError)" @click="saveEntries">完成</button></footer>
      </div>
    </dialog>
  </div>
</template>
