<script setup lang="ts">
import { Check, CircleAlert, Clock, Download, FileSearch, Search, SlidersHorizontal, X } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { apiRequest } from '../../api/client'
import type { ConfigDocument, QueryLogEntry, QueryLogItem, QueryLogPage, QueryLogSettings } from '../../api/types'
import { useConfirm } from '../../composables/useConfirm'
import { useConnection } from '../../composables/useConnection'
import { useToast } from '../../composables/useToast'
import { readConfig } from '../../config-model/document'
import { traceNames } from '../../config-model/trace-names'
import { answerOf, destinationOptions, detailFacts, isGap, itemOf, latencyText, requestLine, routeOf, SLOW_MS, sourceOf, statusOf, stepRows, timeText, type QueryLogContext } from '../../querylog'
import type { KernelPipeline } from '../../request-destinations'
import { softBreakParts } from '../../ui/soft-breaks'
import { errorMessage } from '../../utils'
// 设置抽屉沿用配置页的抽屉样式（正式落地时挪进组件库） / The settings drawer uses the config page's drawer styles (moved into the kit when this lands)
import '../../styles/config-v2.css'
import UiDotText from '../ui/UiDotText.vue'
import UiEmpty from '../ui/UiEmpty.vue'
import UiNewItemsBanner from '../ui/UiNewItemsBanner.vue'
import UiSelect from '../ui/UiSelect.vue'
import UiTabs from '../ui/UiTabs.vue'
import { usePhone } from '../../config-v2/phone'

// 查询日志：每次查询一行，按时间倒序，一条也不折叠。点开一行看处理过程，旁边能直接去建规则、去诊断再测、只看这个客户端、
// 不再记录这个域名。筛选写在地址栏里，概览、规则列表跳过来时带着它们。新查询照运行日志的办法：停在顶部时直接进来，
// 往下读时攒在提示条里。
// The query log: one row per query, newest first, never folded. Opening a row shows how it was handled, with actions right there:
// create a rule, test again in diagnostics, show only this client, stop recording this domain. Filters live in the address bar, so the
// overview and the rule list can jump in with them. New queries work as in the runtime log: at the top they come straight in, while
// reading further down they wait in the banner.
// facts：页头事实；'loading' 是第一次还没读完（页头放骨架），null 是没有可说的（内核太旧、读不到）
// facts: the header facts; 'loading' until the first read lands (the header shows a skeleton), null when there is nothing to say (old kernel, unreadable)
const emit = defineEmits<{ facts: [parts: string[] | 'loading' | null] }>()
const route = useRoute()
const router = useRouter()
const toast = useToast()
const confirm = useConfirm()

const PAGE = 200
const items = ref<QueryLogItem[]>([])
const supported = ref(true)
const nextBefore = ref<number | null>(null)
// 一次往前找有上限：上一次读在这一刻停下、还没凑满一页时，列表末尾说找到哪儿了，给一个「继续往前找」
// A read searches only so far back: when the last read stopped here before the page filled, the list's end says how far it got and
// offers 继续往前找
const stoppedAt = ref<number | null>(null)
const loading = ref(false)
const loadingOlder = ref(false)
const loadError = ref('')
const fresh = ref<QueryLogItem[] | null>(null)
const atTop = ref(true)
const stream = ref<HTMLDivElement | null>(null)
// 选中的那一条：宽屏在表格下方的详情里看，手机从底边升起整屏详情 / The selected entry: on wide screens in the detail under the table, on phones in a full sheet rising from the bottom
const selected = ref<number | null>(null)
const settings = ref<QueryLogSettings | null>(null)
const loaded = ref(false)
let timer: number | undefined
// 连不上面板：和运行日志一样，什么都没读到时只留一句「连上面板后自动打开」；连上后马上重读，重读回来之前不闪红字
// The panel unreachable: as in the runtime log, with nothing read only 连上面板后自动打开 stays; once connected it re-reads at
// once, and no red notice flashes before that read answers
const { down: panelDown } = useConnection()
const reconnecting = ref(false)
watch(panelDown, (now, before) => {
  if (!before || now) return
  reconnecting.value = true
  void Promise.all([ctx.value ? null : loadContext(), load()]).finally(() => { reconnecting.value = false })
})
const waitingForPanel = computed(() => loadError.value !== '' && (panelDown.value || reconnecting.value) && items.value.length === 0)

// 名字和去向要对上配置：读一次配置 / Names and destinations follow the config: read it once
const ctx = shallowRef<QueryLogContext | null>(null)
async function loadContext(): Promise<void> {
  try {
    const content = (await apiRequest<ConfigDocument>('/api/v1/config')).content
    const model = readConfig(content).model
    ctx.value = { model, names: traceNames(model), pipelines: Array.isArray(content.pipelines) ? (content.pipelines as KernelPipeline[]) : [] }
  } catch { ctx.value = null }
}

// ---------- 筛选：都在地址栏里 / filters, all in the address bar ----------
const q = ref(String(route.query.q ?? ''))
const dest = computed(() => String(route.query.dest ?? ''))
const client = computed(() => (route.query.client ? String(route.query.client) : ''))
const rule = computed(() => (route.query.rule ? String(route.query.rule) : ''))
// 规则所在的列表：同名规则可以分别在主列表和规则组里，命中数也是分开数的 / The list the rule sits in: rules of the same name can live in the main list and in a rule group, and their hits are counted apart
const ruleIn = computed(() => (route.query.rule && route.query.in ? String(route.query.in) : ''))
// 回答后检查的命中：概览「规则命中」里「回答后」那几行带过来，认的是检查那一步 / An answer-check hit: brought from the 回答后 rows of the overview's rule hits, matched on the check step
const rulePhase = computed(() => (route.query.rule && route.query.phase === 'response' ? 'response' : ''))
const upstream = computed(() => (route.query.upstream ? String(route.query.upstream) : ''))
const options = computed(() => destinationOptions(ctx.value))
function setQuery(patch: Record<string, string | undefined>): void {
  const next = { ...route.query, ...patch }
  for (const [k, v] of Object.entries(next)) if (v === undefined || v === '') delete next[k]
  void router.replace({ query: next })
}
let typing: number | undefined
watch(q, (value) => { window.clearTimeout(typing); typing = window.setTimeout(() => setQuery({ q: value.trim() || undefined }), 250) })
const ruleTitle = computed(() => (rule.value ? (ctx.value?.names.rule(rule.value) ?? rule.value) : ''))
const filtered = computed(() => Boolean(q.value.trim() || dest.value || client.value || rule.value || upstream.value))
function params(extra: Record<string, string> = {}): string {
  const p = new URLSearchParams({ limit: String(PAGE), ...extra })
  if (q.value.trim()) p.set('q', q.value.trim())
  for (const [k, v] of Object.entries(options.value.find((o) => o.value === dest.value)?.params ?? {})) if (v) p.set(k, v)
  if (client.value) p.set('client', client.value)
  if (rule.value) p.set('rule', rule.value)
  if (ruleIn.value) p.set('rule_pipeline', ruleIn.value)
  if (rulePhase.value) p.set('rule_phase', rulePhase.value)
  if (upstream.value) p.set('upstream', upstream.value)
  return p.toString()
}

// ---------- 读取 / loading ----------
async function load(): Promise<void> {
  loading.value = true
  try {
    const page = await apiRequest<QueryLogPage>(`/api/v1/querylog?${params()}`)
    supported.value = page.supported
    items.value = page.items.map(itemOf)
    nextBefore.value = page.next_before
    stoppedAt.value = stoppedOf(page)
    fresh.value = null
    loadError.value = ''
    selected.value = null
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    loading.value = false
    loaded.value = true
  }
}
async function loadOlder(): Promise<void> {
  if (nextBefore.value === null || loadingOlder.value) return
  loadingOlder.value = true
  try {
    const page = await apiRequest<QueryLogPage>(`/api/v1/querylog?${params({ before: String(nextBefore.value) })}`)
    items.value = [...items.value, ...page.items.map(itemOf)]
    nextBefore.value = page.next_before
    stoppedAt.value = stoppedOf(page)
  } catch (error) {
    toast.error(`没能读到更早的查询：${errorMessage(error)}`)
  } finally {
    loadingOlder.value = false
  }
}
/** 这一页是不是因为看到上限才停下的：还有更早的，却没凑满一页 / Whether this page stopped at the read limit: more is older, yet the page is not full */
const stoppedOf = (page: QueryLogPage) => (page.next_before !== null && page.items.length < PAGE ? page.scanned_to_unix_ms : null)
// 停在顶部时新查询直接进来；往下读时攒着，由提示条放进来 / At the top new queries come straight in; further down they wait for the banner
async function poll(): Promise<void> {
  if (loading.value || !supported.value || document.hidden) return
  try {
    const page = await apiRequest<QueryLogPage>(`/api/v1/querylog?${params()}`)
    const first = items.value[0]?.id ?? 0
    const newer = page.items.filter((item) => item.id > first).map(itemOf)
    if (!newer.length) return
    if (atTop.value && selected.value === null) { items.value = [...newer, ...items.value]; return }
    fresh.value = newer
  } catch { /* 下一轮再试；连不上由顶上的横幅说 / Try again next round; an unreachable panel is the top banner's to say */ }
}
const freshLabel = computed(() => (fresh.value?.length ? `有 ${fresh.value.length >= PAGE ? `${PAGE} 条以上` : `${fresh.value.length} 条`}新查询，点击显示` : null))
// 手机上列表不另开滚动框，整页滚：点开一行的处理过程比半屏高，套两层滚动看不全；顶部、到底都按页面算。
// 宽屏照运行日志，列表自己滚，工具行一直在。
// On phones the list has no scroller of its own and the page scrolls: an opened row's steps run taller than half a screen, and two
// nested scrollers would never show them whole; the top and the bottom are measured on the page. Wider screens follow the runtime
// log: the list scrolls by itself and the toolbar stays.
const PHONE = '(max-width: 640px)'
const pageScrolls = () => window.matchMedia(PHONE).matches
const headerBottom = () => document.querySelector('.app-header')?.getBoundingClientRect().bottom ?? 0
function showFresh(): void {
  void load().then(() => {
    const el = stream.value
    if (!el) return
    if (!pageScrolls()) { el.scrollTo({ top: 0 }); return }
    const above = el.getBoundingClientRect().top - headerBottom()
    if (above < 0) window.scrollBy({ top: above })
  })
}
function onScroll(): void {
  const el = stream.value
  if (!el) return
  if (pageScrolls()) {
    atTop.value = el.getBoundingClientRect().top >= headerBottom() - 8
    if (document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 400) void loadOlder()
    return
  }
  atTop.value = el.scrollTop < 8
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) void loadOlder()
}

// ---------- 行 / rows ----------
const entries = computed(() => items.value)
const now = Date.now()
const routeCell = (entry: QueryLogEntry) => routeOf(entry, ctx.value)
// 手机第二行：去向、来源（缓存这类）、耗时、客户端 / The phone's second line: destination, source (cache and the like), latency, client
const phoneLine = (entry: QueryLogEntry) => {
  const source = sourceOf(entry)
  return [routeCell(entry).where, ...(source && !source.literal ? [source.text] : []), latencyText(entry.latency_ms), entry.client]
}

// ---------- 选中和详情 / selection and the detail ----------
const phone = usePhone()
const current = computed(() => (selected.value === null ? null : items.value.find((item): item is QueryLogEntry => !isGap(item) && item.id === selected.value) ?? null))
const detailTab = ref<'summary' | 'steps'>('summary')
const DETAIL_TABS = [{ value: 'summary', label: '概况' }, { value: 'steps', label: '处理过程' }]
const sheet = ref<HTMLDialogElement | null>(null)
function select(id: number): void {
  selected.value = selected.value === id ? null : id
  if (selected.value === null) return
  if (phone.value) { void nextTick(() => sheet.value?.showModal()); return }
  // 详情升起来以后，选中的行不能被它盖住 / Once the detail rises, the selected row must not sit under it
  void nextTick(() => stream.value?.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' }))
}
function closeDetail(): void {
  if (sheet.value?.open) sheet.value.close()
  selected.value = null
}
// 上下键在行之间移动，Esc 关掉详情（和 Surge 的请求列表一样） / Up and down move between rows and Esc closes the detail, as in Surge's request list
function onRowKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && selected.value !== null) { event.preventDefault(); closeDetail(); return }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const list = items.value.filter((item): item is QueryLogEntry => !isGap(item))
  const at = list.findIndex((item) => item.id === selected.value)
  const next = list[at < 0 ? 0 : Math.min(list.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))]
  if (!next) return
  event.preventDefault()
  selected.value = next.id
  void nextTick(() => {
    const row = stream.value?.querySelector<HTMLButtonElement>(`[data-id="${next.id}"]`)
    row?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: 'nearest' })
  })
}
const rowsOf = (entry: QueryLogEntry) => stepRows(entry, ctx.value)
const factsOf = (entry: QueryLogEntry) => detailFacts(entry, ctx.value)

function onlyClient(entry: QueryLogEntry): void { setQuery({ client: entry.client }) }
// 手机详情里点「只看这个客户端」：先收起详情再筛 / 只看这个客户端 in the phone detail: close the sheet first, then filter
function onlyClientFromSheet(entry: QueryLogEntry): void { const at = entry.client; closeDetail(); setQuery({ client: at }) }
// 规则：打开规则页的快速添加，域名填好 / A rule: opens quick add on the rules page with the domain filled in
const ruleLink = (entry: QueryLogEntry) => ({ path: '/config', query: { quick: entry.qname } })
const diagLink = (entry: QueryLogEntry) => ({ path: '/diagnostics', query: { domain: entry.qname, type: entry.qtype, client: entry.client } })
async function ignoreDomain(entry: QueryLogEntry): Promise<void> {
  const current = settings.value ?? await apiRequest<QueryLogSettings>('/api/v1/querylog/settings')
  if (current.ignored_domains.includes(entry.qname)) return
  const before = current.ignored_domains
  settings.value = await apiRequest<QueryLogSettings>('/api/v1/querylog/settings', { method: 'PUT', body: JSON.stringify({ ignored_domains: [...before, entry.qname] }) })
  toast.undoable(`不再记录 ${entry.qname}，以后的查询不进日志`, () => { void apiRequest<QueryLogSettings>('/api/v1/querylog/settings', { method: 'PUT', body: JSON.stringify({ ignored_domains: before }) }).then((s) => { settings.value = s }) })
}

function download(): void {
  const lines = items.value.filter((item) => !isGap(item)).map((item) => JSON.stringify(item))
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'application/x-ndjson;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `kixdns-querylog-${new Date().toISOString().slice(0, 10)}.jsonl`
  a.click()
  URL.revokeObjectURL(url)
}

// ---------- 设置 / settings ----------
const drawer = ref<HTMLDialogElement | null>(null)
// 数字和单位之间是不断行空格：页头事实按第一个普通空格分出标签和值 / A no-break space between number and unit: the header facts split label from value at the first ordinary space
const RETENTIONS = [{ value: '6', label: '6\u00a0小时' }, { value: '24', label: '1\u00a0天' }, { value: '168', label: '7\u00a0天' }, { value: '720', label: '30\u00a0天' }, { value: '2160', label: '90\u00a0天' }, { value: 'custom', label: '自定义' }]
const draft = ref({ retention: '2160', customHours: '', maxMb: '500', ignored: '' })
const draftProblem = computed(() => {
  if (draft.value.retention === 'custom' && !(Number(draft.value.customHours) >= 1 && Number(draft.value.customHours) <= 8760 && Number.isInteger(Number(draft.value.customHours)))) return '保存时长填 1 到 8760 之间的整数小时'
  if (!(Number(draft.value.maxMb) >= 10)) return '空间上限至少 10 MB'
  return ''
})
const mb = (bytes: number) => `${Math.round(bytes / 1048576)}\u00a0MB`
async function openSettings(): Promise<void> {
  const s = await apiRequest<QueryLogSettings>('/api/v1/querylog/settings')
  settings.value = s
  const preset = RETENTIONS.some((r) => r.value === String(s.retention_hours))
  draft.value = { retention: preset ? String(s.retention_hours) : 'custom', customHours: preset ? '' : String(s.retention_hours), maxMb: String(Math.round(s.max_bytes / 1048576)), ignored: s.ignored_domains.join('\n') }
  await nextTick()
  drawer.value?.showModal()
}
async function saveSettings(): Promise<void> {
  if (draftProblem.value) return
  const d = draft.value
  settings.value = await apiRequest<QueryLogSettings>('/api/v1/querylog/settings', { method: 'PUT', body: JSON.stringify({
    retention_hours: d.retention === 'custom' ? Number(d.customHours) : Number(d.retention),
    max_bytes: Math.round(Number(d.maxMb) * 1048576),
    ignored_domains: d.ignored.split(/\s+/).map((x) => x.trim().toLowerCase()).filter(Boolean),
  }) })
  drawer.value?.close()
  toast.success('查询日志设置已保存')
  void load()
}
async function clearAll(): Promise<void> {
  const ok = await confirm.ask({ title: '清空查询日志', body: '已经记下的查询全部删掉，找不回来。之后的查询照常记录。', confirmLabel: '清空查询日志', destructive: true })
  if (!ok) return
  settings.value = await apiRequest<QueryLogSettings>('/api/v1/querylog/clear', { method: 'POST' })
  drawer.value?.close()
  toast.success('查询日志已清空')
  void load()
}

// 页头事实：最近一条、保存多久、已用多少 / Header facts: the newest entry, how long it keeps, how much it uses
watch([items, settings, supported, loaded, loadError], () => {
  if (!loaded.value) { emit('facts', 'loading'); return }
  if ((!supported.value || loadError.value) && !items.value.length) { emit('facts', null); return }
  const first = items.value.find((item) => !isGap(item))
  // 保存多久、已用多少是设置里的事，页头只说最近一条 / Retention and space used belong to the settings; the header says only the newest entry
  emit('facts', [`最近一条 ${first ? timeText(first.time_unix_ms) : '—'}`])
}, { immediate: true })

watch(() => [route.query.q, route.query.dest, route.query.client, route.query.rule, route.query.in, route.query.phase, route.query.upstream], () => { void load() })
onMounted(async () => {
  // 配置、日志、设置一起读：日志先到就先画，名字等配置到了再换成配置页上的叫法；慢网络上少等两趟
  // The config, the log and the settings are read together: the log is drawn as soon as it lands and its names switch to the config
  // page's once the config arrives; on a slow network that saves two round trips
  void apiRequest<QueryLogSettings>('/api/v1/querylog/settings').then((s) => { settings.value = s }, () => { /* 页头少一项，不影响列表 / The header loses a fact, the list is unaffected */ })
  await Promise.all([loadContext(), load()])
  timer = window.setInterval(() => { void poll() }, 5000)
  window.addEventListener('scroll', onScroll, { passive: true })
})
onBeforeUnmount(() => { window.clearInterval(timer); window.clearTimeout(typing); window.removeEventListener('scroll', onScroll) })
</script>

<template>
  <!-- 内核太旧、也没有记下过什么：说清要做什么 / A kernel too old and nothing recorded: say what to do -->
  <section v-if="!supported && loaded && !entries.length" class="ui-card qlog-state">
    <UiEmpty :icon="FileSearch" title="当前内核不支持查询日志" desc="把 KixDNS 内核更新到最新版本后可用，更新在系统页。">
      <RouterLink class="ui-btn ui-btn--secondary" to="/system">去系统页</RouterLink>
    </UiEmpty>
  </section>
  <!-- 读取失败：和运行日志一样一条提示，有行时只说可能过期 / A load failure: one notice as in the runtime log; with rows on screen it only says they may be stale -->
  <!-- 连不上面板时由顶上的横幅说，这里不复述 / With the panel unreachable the top banner says it; no second copy here -->
  <div v-else-if="loadError && !panelDown && !reconnecting" class="ui-notice ui-notice--err logs-notice" role="alert">
    <CircleAlert :size="16" aria-hidden="true" />
    <span>{{ entries.length ? '数据可能已过期' : '读取失败' }}</span>
    <small>{{ loadError }}</small>
    <button class="ui-btn ui-btn--secondary ui-btn--sm ui-notice__action" type="button" :disabled="loading" @click="load">重试</button>
  </div>
  <p v-else-if="waitingForPanel" class="ui-notice ui-notice--off logs-notice" role="status"><Clock :size="16" aria-hidden="true" /><span>连上面板后自动打开</span></p>
  <!-- 换成了不支持查询日志的内核：以前记下的照样能看，上面说一句 / Switched to a kernel without the query log: what was recorded before can still be read, with a line above -->
  <p v-if="!supported && entries.length" class="ui-notice ui-notice--off logs-notice" role="status"><FileSearch :size="16" aria-hidden="true" /><span>当前内核不支持查询日志，下面是以前记下的；新的查询要更新内核后才会记录</span><RouterLink class="ui-btn ui-btn--secondary ui-btn--sm ui-notice__action" to="/system">去系统页</RouterLink></p>
  <section v-if="(supported || entries.length) && !waitingForPanel" class="log-console ui-card qlog" role="tabpanel" aria-labelledby="logs-tab-query">
    <!-- 工具行：搜索、去向、右端设置和下载 / The toolbar: search, destination, settings and download at the right end -->
    <header class="log-toolbar">
      <label class="ui-input log-search"><Search :size="16" aria-hidden="true" /><input v-model="q" aria-label="搜索域名或客户端" placeholder="搜索域名或客户端" autocapitalize="off" spellcheck="false" /></label>
      <UiSelect class="qlog-dest" :model-value="dest" :options="options" label="按去向筛选" @update:model-value="setQuery({ dest: $event || undefined })" />
      <div class="log-toolbar__end">
        <button class="ui-btn ui-btn--secondary ui-btn--icon" type="button" title="查询日志设置" aria-label="查询日志设置" @click="openSettings"><SlidersHorizontal :size="16" aria-hidden="true" /></button>
        <button class="ui-btn ui-btn--secondary ui-btn--icon" type="button" title="下载筛选结果" aria-label="下载筛选结果" :disabled="!entries.length" @click="download"><Download :size="16" aria-hidden="true" /></button>
      </div>
    </header>
    <!-- 从别处带进来、或点「只看这个客户端」加上的筛选，一个一个能去掉 / Filters brought in from elsewhere or added by 只看这个客户端, each removable -->
    <div v-if="client || rule || upstream" class="qlog-filters">
      <span v-if="client" class="qlog-filter">客户端 <code>{{ client }}</code><button type="button" :aria-label="`去掉筛选：客户端 ${client}`" @click="setQuery({ client: undefined })"><X :size="14" aria-hidden="true" /></button></span>
      <span v-if="rule" class="qlog-filter">{{ rulePhase ? '回答后检查' : '规则' }}「{{ ruleTitle }}」<button type="button" :aria-label="`去掉筛选：规则 ${ruleTitle}`" @click="setQuery({ rule: undefined, in: undefined, phase: undefined })"><X :size="14" aria-hidden="true" /></button></span>
      <span v-if="upstream" class="qlog-filter">问过上游 <code>{{ upstream }}</code><button type="button" :aria-label="`去掉筛选：上游 ${upstream}`" @click="setQuery({ upstream: undefined })"><X :size="14" aria-hidden="true" /></button></span>
    </div>
    <!-- 表格和详情：宽屏上详情在表格下方，表格不变形；手机上详情从底边升起 / The table and the detail: on wide screens the detail sits under the table, which keeps its shape; on phones it rises from the bottom -->
    <div class="qlog-body">
      <div ref="stream" class="qlog-stream" @scroll.passive="onScroll" @keydown="onRowKey">
        <div v-if="entries.length" class="qlog-head" aria-hidden="true"><span></span><span class="ui-lbl">时间</span><span class="ui-lbl">客户端</span><span class="ui-lbl">域名</span><span class="ui-lbl">类型</span><span class="ui-lbl">去向</span><span class="ui-lbl qlog-c-answer">回答</span><span class="ui-lbl qlog-c-source">来源</span><span class="ui-lbl qlog-num">耗时</span></div>
        <UiNewItemsBanner v-if="freshLabel" :label="freshLabel" :loading="loading" @show="showFresh" />
        <div v-if="loading && !entries.length" class="log-skeleton" role="status" aria-label="正在读取查询日志"><i v-for="n in 12" :key="n" class="sk"></i></div>
        <template v-for="item in entries" :key="item.id">
          <!-- 漏记的一段：照实说，不悄悄缺 / A gap: said plainly, never a silent hole -->
          <p v-if="isGap(item)" class="qlog-gap" role="note">这里漏记了 {{ item.gap }} 条：面板没能从内核取到</p>
          <button v-else class="qlog-row" :class="{ 'is-selected': selected === item.id }" type="button" :data-id="item.id" :aria-current="selected === item.id ? 'true' : undefined" @click="select(item.id)">
            <i class="ui-dot qlog-dot" :class="`qlog-dot--${statusOf(item).tone}`" role="img" :aria-label="statusOf(item).label"></i>
            <time class="qlog-c-time">{{ timeText(item.time_unix_ms, now) }}</time>
            <span class="qlog-c-client qlog-lit">{{ item.client }}</span>
            <span class="qlog-c-name"><span class="qlog-lit">{{ item.qname }}</span><span class="qlog-phone-type">{{ item.qtype === 'A' ? '' : item.qtype }}</span></span>
            <span class="qlog-c-type">{{ item.qtype }}</span>
            <span class="qlog-c-dest"><span :class="{ 'qlog-lit': routeCell(item).mono }">{{ routeCell(item).where }}</span><span v-if="routeCell(item).rule" class="qlog-c-rule"> · {{ routeCell(item).rule }}</span></span>
            <span class="qlog-c-answer" :class="`is-${answerOf(item).tone || 'plain'}`"><span :class="{ 'qlog-lit': answerOf(item).literal }">{{ answerOf(item).text }}</span><span v-if="answerOf(item).more" class="qlog-more-n"> +{{ answerOf(item).more }}</span></span>
            <span class="qlog-c-source" :class="{ 'is-warn': sourceOf(item)?.tone === 'warn' }"><span v-if="sourceOf(item)" :class="{ 'qlog-lit': sourceOf(item)!.literal }" :title="sourceOf(item)!.full">{{ sourceOf(item)!.text }}</span></span>
            <span class="qlog-num qlog-c-latency" :class="{ 'is-slow': item.latency_ms >= SLOW_MS && item.outcome !== 'failed' }">{{ latencyText(item.latency_ms) }}</span>
            <!-- 手机：第二行，只在手机上画（和下面的 640 断点一致），宽屏一页少画上千个元素 / phones: the second line, drawn on phones only (the
                 640 breakpoint below), sparing wide screens a thousand elements a page -->
            <span v-if="phone" class="qlog-phone"><UiDotText :parts="phoneLine(item)" /></span>
          </button>
        </template>
        <p v-if="loadingOlder" class="qlog-more" role="status">正在读取更早的查询</p>
        <!-- 一次只往前找那么多：没凑满一页时说找到哪儿了，接着找由人决定，不悄悄扫完几十天 / A read searches only so far: when the page is short, say how far it got and let the reader decide to go on, instead of quietly scanning weeks -->
        <p v-else-if="stoppedAt !== null && nextBefore !== null" class="qlog-more qlog-stopped" role="status"><span>{{ entries.length ? '' : '没找到符合条件的查询，' }}已经找到 {{ timeText(stoppedAt, now) }}</span><button class="ui-btn ui-btn--secondary ui-btn--sm" type="button" @click="loadOlder">继续往前找</button></p>
        <UiEmpty v-if="!loading && !entries.length && !loadError && stoppedAt === null" :icon="FileSearch" :title="filtered ? '没有符合条件的查询' : '还没有查询'" :desc="filtered ? '清空搜索，或把去向、客户端的筛选去掉' : '有设备来解析域名，就会出现在这里。'" />
      </div>
      <!-- 宽屏的详情：页头（域名、谁在什么时候问的、状态），一行页签和四个去处，下面是概况或处理过程 / The wide-screen detail: a head (domain, who asked and when, status), a bar with tabs and four actions, then the summary or the steps -->
      <section v-if="current && !phone" class="qlog-pane" aria-label="查询详情">
        <header class="qlog-pane__head">
          <div class="qlog-pane__titles">
            <h2><span class="qlog-lit">{{ current.qname }}</span><span class="qlog-pane__type">{{ current.qtype }}</span></h2>
            <p><UiDotText :parts="requestLine(current)" /></p>
          </div>
          <span class="ui-tag" :class="{ 'ui-tag--ok': statusOf(current).tone === 'ok', 'ui-tag--warn': statusOf(current).tone === 'warn', 'ui-tag--err': statusOf(current).tone === 'err' }">{{ statusOf(current).label }}</span>
          <button class="ui-icon-btn" type="button" aria-label="关闭详情" title="关闭详情（Esc）" @click="closeDetail"><X :size="16" aria-hidden="true" /></button>
        </header>
        <div class="qlog-pane__bar">
          <UiTabs v-model="detailTab" :items="DETAIL_TABS" label="详情内容" variant="segment" size="sm" />
          <div class="qlog-pane__actions">
            <RouterLink class="ui-btn ui-btn--text ui-btn--sm" :to="ruleLink(current)">为这个域名建规则</RouterLink>
            <RouterLink class="ui-btn ui-btn--text ui-btn--sm" :to="diagLink(current)">用诊断再测一次</RouterLink>
            <button v-if="client !== current.client" class="ui-btn ui-btn--text ui-btn--sm" type="button" @click="onlyClient(current)">只看这个客户端</button>
            <button class="ui-btn ui-btn--text ui-btn--sm" type="button" @click="ignoreDomain(current)">不再记录这个域名</button>
          </div>
        </div>
        <div class="qlog-pane__body">
          <div v-if="detailTab === 'summary'" class="qlog-facts">
            <div v-for="fact in factsOf(current)" :key="fact.key" class="qlog-fact" :class="fact.tone && `is-${fact.tone}`">
              <span class="ui-lbl">{{ fact.label }}</span>
              <p v-for="(line, at) in fact.lead" :key="at" class="qlog-fact__lead"><template v-for="(part, i) in line" :key="i"><span v-if="part.mono" class="qlog-lit">{{ part.text }}</span><template v-else>{{ part.text }}</template></template></p>
              <p v-if="fact.sub.length" class="qlog-fact__sub"><template v-for="(part, i) in fact.sub" :key="i"><span v-if="part.mono" class="qlog-lit">{{ part.text }}</span><template v-else>{{ part.text }}</template></template></p>
            </div>
          </div>
          <ol v-else class="ui-steps qlog-steps">
            <li v-for="(row, index) in rowsOf(current)" :key="index" class="ui-step" :class="[row.tone === 'ok' && row.decides ? 'ui-step--ok' : row.tone === 'err' ? 'ui-step--err' : row.tone === 'warn' ? 'ui-step--warn' : '', { 'ui-step--idle': row.idle }]">
              <span class="ui-step__time">{{ latencyText(row.at) }}</span>
              <span class="ui-step__mark" aria-hidden="true"><Check v-if="row.tone === 'ok' && row.decides" :size="12" /><X v-else-if="row.tone === 'err'" :size="12" /><i v-else></i></span>
              <div class="ui-step__body">
                <p class="ui-step__what"><template v-for="(part, at) in row.lead" :key="at"><span v-if="part.mono" class="qlog-lit qlog-literal"><template v-for="(seg, i) in softBreakParts(part.text)" :key="i"><wbr v-if="i" /><span>{{ seg }}</span></template></span><template v-else>{{ part.text }}</template></template></p>
                <p v-if="row.note.length" class="ui-step__why"><template v-for="(part, at) in row.note" :key="at"><span v-if="part.mono" class="qlog-lit qlog-literal"><template v-for="(seg, i) in softBreakParts(part.text)" :key="i"><wbr v-if="i" /><span>{{ seg }}</span></template></span><template v-else>{{ part.text }}</template></template></p>
              </div>
            </li>
          </ol>
        </div>
      </section>
    </div>
  </section>

  <!-- 手机的详情：从底边升起，概况三块、处理过程依次往下，四个去处在底部 / The phone detail: rises from the bottom; the three summary blocks, then the steps, the four actions at the foot -->
  <dialog v-if="phone" ref="sheet" class="pdrawer qlog-sheet" aria-labelledby="ql-detail-title" @close="selected = null" @click.self="closeDetail">
    <div v-if="current" class="pdrawer__panel">
      <header class="pdrawer__head">
        <div class="pdrawer__titles">
          <h2 id="ql-detail-title"><span class="qlog-lit">{{ current.qname }}</span><span class="qlog-pane__type">{{ current.qtype }}</span></h2>
          <p><UiDotText :parts="requestLine(current)" /></p>
        </div>
        <span class="ui-tag" :class="{ 'ui-tag--ok': statusOf(current).tone === 'ok', 'ui-tag--warn': statusOf(current).tone === 'warn', 'ui-tag--err': statusOf(current).tone === 'err' }">{{ statusOf(current).label }}</span>
        <button class="ui-icon-btn" type="button" aria-label="关闭" title="关闭" @click="closeDetail"><X :size="16" /></button>
      </header>
      <div class="pdrawer__body qlog-sheet__body">
        <div class="qlog-facts">
          <div v-for="fact in factsOf(current)" :key="fact.key" class="qlog-fact" :class="fact.tone && `is-${fact.tone}`">
            <span class="ui-lbl">{{ fact.label }}</span>
            <p v-for="(line, at) in fact.lead" :key="at" class="qlog-fact__lead"><template v-for="(part, i) in line" :key="i"><span v-if="part.mono" class="qlog-lit">{{ part.text }}</span><template v-else>{{ part.text }}</template></template></p>
            <p v-if="fact.sub.length" class="qlog-fact__sub"><template v-for="(part, i) in fact.sub" :key="i"><span v-if="part.mono" class="qlog-lit">{{ part.text }}</span><template v-else>{{ part.text }}</template></template></p>
          </div>
        </div>
        <span class="ui-lbl qlog-sheet__label">处理过程</span>
        <ol class="ui-steps qlog-steps">
          <li v-for="(row, index) in rowsOf(current)" :key="index" class="ui-step" :class="[row.tone === 'ok' && row.decides ? 'ui-step--ok' : row.tone === 'err' ? 'ui-step--err' : row.tone === 'warn' ? 'ui-step--warn' : '', { 'ui-step--idle': row.idle }]">
            <span class="ui-step__time">{{ latencyText(row.at) }}</span>
            <span class="ui-step__mark" aria-hidden="true"><Check v-if="row.tone === 'ok' && row.decides" :size="12" /><X v-else-if="row.tone === 'err'" :size="12" /><i v-else></i></span>
            <div class="ui-step__body">
              <p class="ui-step__what"><template v-for="(part, at) in row.lead" :key="at"><span v-if="part.mono" class="qlog-lit qlog-literal"><template v-for="(seg, i) in softBreakParts(part.text)" :key="i"><wbr v-if="i" /><span>{{ seg }}</span></template></span><template v-else>{{ part.text }}</template></template></p>
              <p v-if="row.note.length" class="ui-step__why"><template v-for="(part, at) in row.note" :key="at"><span v-if="part.mono" class="qlog-lit qlog-literal"><template v-for="(seg, i) in softBreakParts(part.text)" :key="i"><wbr v-if="i" /><span>{{ seg }}</span></template></span><template v-else>{{ part.text }}</template></template></p>
            </div>
          </li>
        </ol>
      </div>
      <footer class="pdrawer__foot qlog-sheet__foot">
        <RouterLink class="ui-btn ui-btn--secondary" :to="ruleLink(current)">为这个域名建规则</RouterLink>
        <RouterLink class="ui-btn ui-btn--secondary" :to="diagLink(current)">用诊断再测一次</RouterLink>
        <button v-if="client !== current.client" class="ui-btn ui-btn--secondary" type="button" @click="onlyClientFromSheet(current)">只看这个客户端</button>
        <button class="ui-btn ui-btn--secondary" type="button" @click="ignoreDomain(current)">不再记录这个域名</button>
      </footer>
    </div>
  </dialog>

  <dialog ref="drawer" class="pdrawer" aria-labelledby="ql-settings-title" @click.self="drawer?.close()">
    <form class="pdrawer__panel" @submit.prevent="saveSettings">
      <header class="pdrawer__head">
        <h2 id="ql-settings-title">查询日志设置</h2>
        <button class="ui-icon-btn" type="button" aria-label="关闭" title="关闭" @click="drawer?.close()"><X :size="16" /></button>
      </header>
      <div class="pdrawer__body qlog-settings">
        <div class="pfield">
          <span>保存多久</span>
          <UiTabs v-model="draft.retention" :items="RETENTIONS" label="保存多久" variant="segment" />
          <label v-if="draft.retention === 'custom'" class="ui-input qlog-hours"><input v-model="draft.customHours" inputmode="numeric" aria-label="保存多少小时" placeholder="1–8760"><span>小时</span></label>
        </div>
        <label class="pfield">
          <span>最多占用</span>
          <span class="ui-input qlog-mb"><input v-model="draft.maxMb" inputmode="numeric" aria-label="最多占用多少 MB"><span>MB</span></span>
          <small class="pfield__hint">{{ settings ? `已用 ${mb(settings.used_bytes)}${settings.oldest_unix_ms ? `，最早一条是 ${timeText(settings.oldest_unix_ms, 0)}` : ''}。` : '' }}超过上限时先删最早的。</small>
        </label>
        <label class="pfield">
          <span>不记录的域名 <small>可选</small></span>
          <textarea v-model="draft.ignored" class="ui-input qlog-ignored" rows="4" placeholder="一行一个，连子域名一起不记" spellcheck="false" autocapitalize="off"></textarea>
        </label>
        <p v-if="draftProblem" class="ui-field-error">{{ draftProblem }}</p>
        <div class="qlog-danger">
          <button class="ui-btn ui-btn--danger ui-btn--sm" type="button" @click="clearAll">清空查询日志</button>
          <small>已经记下的全部删掉，之后照常记录</small>
        </div>
      </div>
      <footer class="pdrawer__foot">
        <button class="ui-btn ui-btn--secondary" type="button" @click="drawer?.close()">取消</button>
        <button class="ui-btn ui-btn--primary" type="submit" :disabled="Boolean(draftProblem)">保存</button>
      </footer>
    </form>
  </dialog>
</template>

<style>
/* 查询日志照 Surge 的请求列表：上面一张表，选中一行，详情在表格下方（原型也有放右侧的一版）；表格不变形，上下键逐条看。
   一行九列：状态点、时间、客户端、域名、类型、去向（上游组 · 定下它的规则）、回答、来源、耗时；数字等宽对齐，隔行浅底。
   列宽按内容排，表格变窄时先收起来源，再收回答。手机一条两行，点开从底边升起整屏详情。
   The query log follows Surge's request list: one table on top; a selected row opens its detail under the table (the prototype also has
   a beside-the-table version); the table keeps its shape and the arrow keys step through rows. Nine columns: status dot, time, client,
   domain, type, destination (group · the rule that decided), answer, source, latency; tabular digits, alternate rows tinted. Columns
   are sized by their content; as the table narrows the source column folds first, then the answer. On phones an entry is two lines
   and opening one raises a full sheet from the bottom. */
.logs-page .qlog-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.logs-page .qlog-stream { position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; overflow: auto; container-type: inline-size; font-family: var(--f-body); }
.logs-page .qlog-head, .logs-page .qlog-row { display: grid; grid-template-columns: var(--size-dot) 4.25rem 7.25rem minmax(9rem, 1.6fr) 3rem minmax(8rem, 1.1fr) minmax(7rem, 1fr) minmax(6rem, .8fr) 3.75rem; column-gap: var(--s-4); align-items: center; padding: 0 var(--s-5); }
.logs-page .qlog-head { position: sticky; top: 0; z-index: 2; min-height: var(--h-md); border-bottom: 1px solid var(--l-hair); background: var(--l-surface); }
@container (max-width: 1000px) {
  .logs-page .qlog-head, .logs-page .qlog-row { grid-template-columns: var(--size-dot) 4.25rem 7.25rem minmax(9rem, 1.6fr) 3rem minmax(8rem, 1.1fr) minmax(7rem, 1fr) 3.75rem; }
  .logs-page .qlog-c-source { display: none; }
}
@container (max-width: 780px) {
  .logs-page .qlog-head, .logs-page .qlog-row { grid-template-columns: var(--size-dot) 4.25rem 7.25rem minmax(8rem, 1fr) 3rem minmax(7rem, 1fr) 3.75rem; }
  .logs-page .qlog-c-answer { display: none; }
}
.logs-page .qlog-num { text-align: right; }
/* 行：32 高，13 号字，隔行浅底；悬停一档灰，选中是品牌色的浅底加左边一条（隔行的底和选中的底不会混） / Rows: 32 tall, 13px, alternate rows tinted; hover one grey step, selected the accent tint plus a bar on the left (so it never blends with the stripes) */
.logs-page .qlog-row { width: 100%; min-height: var(--s-6); border: 0; background: none; color: var(--l-ink-2); font-family: var(--f-body); font-size: var(--t-3); font-variant-numeric: tabular-nums; line-height: var(--log-line); text-align: left; cursor: pointer; }
.logs-page .qlog-row:nth-child(even of .qlog-row) { background: var(--l-canvas); }
.logs-page .qlog-row.is-selected { background: var(--accent-tint); box-shadow: inset 2px 0 0 var(--accent); }
/* 品牌色浅底上浅一档的灰只有 4.5 上下：选中行里的灰字都提一档 / The lightest grey sits right at 4.5 on the accent tint: in the selected row the greys step up one */
.logs-page .qlog-row.is-selected :is(.qlog-c-time, .qlog-c-type, .qlog-c-rule, .qlog-more-n, .qlog-c-answer.is-muted) { color: var(--l-ink-2); }
.logs-page .qlog-row:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
@media (hover: hover) { .logs-page .qlog-row:not(.is-selected):hover { background: var(--l-sunk); } }
.logs-page .qlog-row > :not(.qlog-dot) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.logs-page .qlog-dot--off { background: var(--l-ink-3); }
.logs-page .qlog-dot--warn { background: var(--warn-l); }
.logs-page .qlog-dot--err { background: var(--err-l); }
.logs-page .qlog-c-time { color: var(--l-ink-3); }
.logs-page .qlog-c-name { color: var(--l-ink); }
.logs-page .qlog-c-type { color: var(--l-ink-3); font-size: var(--t-2); }
.logs-page .qlog-c-dest { color: var(--l-ink); }
.logs-page .qlog-c-rule, .logs-page .qlog-more-n, .logs-page .qlog-c-answer.is-muted { color: var(--l-ink-3); }
.logs-page .qlog-c-answer.is-err { color: var(--err-l); }
.logs-page .qlog-c-source.is-warn { color: var(--warn-l); }
.logs-page .qlog-c-latency.is-slow { color: var(--warn-l); font-weight: var(--w-medium); }
/* 一行只有一个告警色：失败的行回答已经是红的，慢不再标琥珀 / One warning colour per row: a failed row's answer is red already, so its latency is not amber too */
.logs-page .qlog-phone, .logs-page .qlog-phone-type { display: none; }
.logs-page .qlog-gap { margin: 0; padding: var(--s-2) var(--s-5); background: var(--l-sunk); color: var(--l-ink-2); font-size: var(--t-2); }
.logs-page .qlog-more { margin: 0; padding: var(--s-3) var(--s-5); color: var(--l-ink-3); font-size: var(--t-2); }
/* 找到哪儿了、接着找：一行字后面跟按钮，窄了按钮换到下一行 / How far it got and going on: a line of text with the button after it, wrapping on narrow screens */
.logs-page .qlog-stopped { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); }
.logs-page .qlog-stream > .ui-banner { top: var(--h-md); }

/*
 * 详情在表格下方：页头、页签和四个去处一行、内容。占列表区一半多一点（16rem 到 28rem）：900 高的屏幕上处理过程常见的五步一屏放下，
 * 再长的在里面滚；矮屏至少放下概况
 * The detail under the table: a head, one bar of tabs and four actions, the content. A little over half the list area (16rem to
 * 28rem): on a 900-tall screen the usual five steps fit, longer ones scroll inside; short screens still fit the summary
 */
.logs-page .qlog-pane { flex: 0 0 auto; height: clamp(16rem, 55%, 28rem); min-height: 0; display: flex; flex-direction: column; border-top: 1px solid var(--l-hair); background: var(--l-surface); }
.qlog-pane__head { display: flex; align-items: flex-start; gap: var(--s-3); padding: var(--s-4) var(--s-5) var(--s-3); }
.qlog-pane__titles { flex: 1 1 auto; min-width: 0; }
.qlog-pane__titles h2, .qlog-sheet h2 { margin: 0; display: flex; align-items: baseline; gap: var(--s-2); color: var(--l-ink); font-size: var(--t-4); font-weight: var(--w-bold); line-height: var(--lh-tight); }
.qlog-pane__titles h2 > .qlog-lit { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qlog-sheet h2 > .qlog-lit { min-width: 0; overflow-wrap: anywhere; }
.qlog-pane__type { flex: 0 0 auto; color: var(--l-ink-3); font-size: var(--t-2); font-weight: var(--w-medium); }
.qlog-pane__titles p { margin: var(--s-1) 0 0; color: var(--l-ink-3); font-size: var(--t-2); }
.qlog-pane__head > .ui-tag { flex: 0 0 auto; }
.qlog-pane__head > .ui-icon-btn { margin: calc(var(--s-1) * -1) calc(var(--s-2) * -1) 0 0; }
.qlog-pane__bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s-2) var(--s-3); padding: 0 var(--s-5) var(--s-3); }
/* 文字按钮自带 8 的左右内边：往外让 8，最后一个字和页头的关闭按钮对齐 / Text buttons carry 8 of side padding: step 8 outward so the last glyph lines up with the head's close button */
.qlog-pane__actions { display: flex; flex-wrap: wrap; gap: 0 var(--s-1); margin-right: calc(var(--s-2) * -1); }
.qlog-pane__body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 0 var(--s-5) var(--s-4); }
.qlog-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-3); }
/* 每块先说一件事（15 号），下面一行小字补充 / Each block leads with one fact at 15px, then one smaller line */
.qlog-fact { display: grid; align-content: start; gap: var(--s-1); padding: var(--s-3) var(--s-4); border-radius: var(--r-2); background: var(--l-canvas); }
.qlog-fact > .ui-lbl { margin-bottom: 2px; }
.qlog-fact__lead { margin: 0; color: var(--l-ink); font-size: var(--t-4); font-weight: var(--w-medium); line-height: var(--lh-tight); overflow-wrap: anywhere; }
.qlog-fact__sub { margin: 0; color: var(--l-ink-3); font-size: var(--t-2); line-height: var(--lh-base); }
.qlog-fact.is-err .qlog-fact__lead { color: var(--err-l); }
.qlog-fact.is-warn .qlog-fact__lead { color: var(--warn-l); }
.qlog-steps { max-width: 44rem; }
/* 步骤里的地址只在目录边界的「/」后面断，不在连字符处断 / An address in a step wraps only after a directory 「/」, never at a hyphen */
.qlog-literal > span { white-space: nowrap; }

.logs-page .qlog-filters { display: flex; flex-wrap: wrap; gap: var(--s-2); padding: var(--s-2) var(--s-5); border-bottom: 1px solid var(--l-hair); }
.logs-page .qlog-filter { display: inline-flex; align-items: center; gap: var(--s-1); padding-left: var(--s-2); border-radius: var(--r-1); background: var(--l-sunk); color: var(--l-ink); font-size: var(--t-2); }
.logs-page .qlog-filter > button { display: inline-grid; place-items: center; width: var(--h-sm); height: var(--h-sm); border: 0; background: none; color: var(--l-ink-3); cursor: pointer; }
.logs-page .qlog-dest { flex: 0 1 13rem; min-width: 9rem; }
.qlog-state { padding: var(--s-6) var(--s-5); }
.qlog-settings { display: grid; gap: var(--s-5); }
.qlog-hours, .qlog-mb { max-width: 12rem; }
.qlog-hours > span, .qlog-mb > span { color: var(--l-ink-3); font-size: var(--t-2); }
.qlog-ignored { width: 100%; min-height: calc(var(--h-md) * 3); padding: var(--s-2) var(--s-3); font-family: var(--f-mono); font-size: var(--t-2); resize: vertical; }
.qlog-danger { display: grid; justify-items: start; gap: var(--s-1); padding-top: var(--s-4); border-top: 1px solid var(--l-hair); }
.qlog-danger small { color: var(--l-ink-3); font-size: var(--t-1); }

/* 手机：整页滚动（不套内层滚动框），一条两行——域名和时间，状态点加「去向 · 来源 · 耗时 · 客户端」；行之间细线，不隔行着色。
   点开一条从底边升起整屏详情：页头、状态、三块概况、处理过程，四个去处在底部两两一行。
   Phones: the page scrolls (no inner scroller); an entry is two lines — the domain and time, then the status dot with 「destination ·
   source · latency · client」; hairlines between rows, no stripes. Opening one raises a full sheet: the head, the status, the three
   summary blocks, the steps, and the four actions two by two at the foot. */
@media (max-width: 640px) {
  .logs-page:has(.qlog-stream) { height: auto; min-height: 0; }
  .logs-page .log-console.qlog { flex: 0 0 auto; overflow: clip; }
  .logs-page .qlog-body { display: block; }
  .logs-page .qlog-stream { overflow: visible; container-type: normal; }
  .logs-page .qlog-head { display: none; }
  .logs-page .qlog-row { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "name name time" "dot phone phone"; column-gap: var(--s-2); row-gap: 2px; padding: var(--s-2) var(--s-4); border-bottom: 1px solid var(--l-hair); }
  .logs-page .qlog-row:nth-child(even of .qlog-row) { background: none; }
  .logs-page .qlog-row.is-selected { background: var(--accent-tint); box-shadow: none; }
  .logs-page .qlog-dot { grid-area: dot; align-self: center; }
  .logs-page .qlog-c-name { grid-area: name; display: flex; align-items: baseline; gap: var(--s-2); }
  .logs-page .qlog-c-name > .qlog-lit { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .logs-page .qlog-phone-type { display: inline; flex: 0 0 auto; color: var(--l-ink-3); font-size: var(--t-1); }
  .logs-page .qlog-c-time { grid-area: time; font-size: var(--t-2); }
  .logs-page .qlog-row > :is(.qlog-c-client, .qlog-c-type, .qlog-c-dest, .qlog-c-answer, .qlog-c-source, .qlog-c-latency) { display: none; }
  .logs-page .qlog-phone { grid-area: phone; display: block; color: var(--l-ink-2); font-size: var(--t-2); }
  .logs-page .qlog-gap, .logs-page .qlog-filters, .logs-page .qlog-more { padding-inline: var(--s-4); }
  .logs-page .qlog-dest { flex: 1 1 100%; order: 1; max-width: none; }
  .logs-page .qlog-stream > .ui-banner { top: var(--app-header-height); }
  .qlog-sheet .pdrawer__panel { height: calc(100% - var(--s-8)); }
  .qlog-sheet__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: grid; align-content: start; gap: var(--s-3); padding: var(--s-4); }
  /* 页头：标题、状态、关闭一行，状态和标题第一行对齐 / The head: title, status and close on one row, the status level with the title's first line */
  .qlog-sheet .pdrawer__head { display: flex; align-items: flex-start; gap: var(--s-2); }
  .qlog-sheet .pdrawer__head > .ui-tag { flex: 0 0 auto; margin-top: 1px; }
  /* 三块概况并成一块，中间细线分开：手机上不再三个大框 / The three summary blocks become one, split by hairlines: no three big boxes on a phone */
  .qlog-sheet .qlog-facts { grid-template-columns: minmax(0, 1fr); gap: 0; border-radius: var(--r-2); background: var(--l-canvas); }
  .qlog-sheet .qlog-fact { border-radius: 0; background: none; }
  .qlog-sheet .qlog-fact + .qlog-fact { border-top: 1px solid var(--l-hair); }
  .qlog-sheet__label { margin-top: var(--s-2); }
  .qlog-sheet__foot { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
