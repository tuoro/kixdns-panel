<script setup lang="ts">
import { Check, CircleAlert, Clock, Download, FileSearch, Search, SlidersHorizontal, X } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ApiError, apiRequest, isPanelDown } from '../../api/client'
import type { ConfigDocument, QueryLogEntry, QueryLogItem, QueryLogPage, QueryLogSettings } from '../../api/types'
import { useConfirm } from '../../composables/useConfirm'
import { useConnection } from '../../composables/useConnection'
import { useToast } from '../../composables/useToast'
import { readConfig } from '../../config-model/document'
import { traceNames } from '../../config-model/trace-names'
import { answerOf, capProblem, clockText, dayText, destinationOptions, detailFacts, domainParts, glueText, hoursProblem, ignoredDomains, isGap, itemOf, latencyText, literalParts, requestLine, routeOf, sinceText, SLOW_MS, sourceOf, statusOf, stepRows, timeText, type QueryLogContext } from '../../querylog'
import type { KernelPipeline } from '../../request-destinations'
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
/** 停在顶部一直开着时，列表最多留几页：新查询一直进来也不会越积越多 / How many pages the list keeps while left open at the top: new queries keep arriving without piling up */
const KEEP = PAGE * 3
const items = ref<QueryLogItem[]>([])
const supported = ref(true)
const nextBefore = ref<number | null>(null)
// 一次往前找有上限：上一次读在这一刻停下、还没凑满一页时，列表末尾说查到哪儿了，给一个「继续往前查」
// A read searches only so far back: when the last read stopped here before the page filled, the list's end says how far it got and
// offers 继续往前查
const stoppedAt = ref<number | null>(null)
const loading = ref(false)
const loadingOlder = ref(false)
const loadError = ref('')
// 查询日志的目录打不开（503 querylog_unavailable）：重启面板前重试没用，也不再轮询
// The query log's directory cannot be opened (503 querylog_unavailable): retrying is no use before the panel restarts, and polling stops
const unavailable = ref(false)
const fresh = ref<QueryLogItem[] | null>(null)
// 新查询多过一页：不往列表里塞，提示条说「200 条以上」，点了整个重读 / More new queries than a page: nothing is pushed into the list,
// the banner says 200 条以上 and a click reloads
const freshMore = ref(false)
// 整个日志最新一条的时间，不管筛选（页头的「最近一条」） / When the log's newest record was written, whatever the filter (the header's 最近一条)
const newestMs = ref<number | null>(null)
// 今天是哪天：跨过午夜也跟着变，分日期的那一行和时间的写法按它算 / Which day it is, following midnight, for the date rows and how times are written
const today = ref(Date.now())
const atTop = ref(true)
const stream = ref<HTMLDivElement | null>(null)
// 选中的那一条：宽屏在表格下方的详情里看，手机从底边升起整屏详情 / The selected entry: on wide screens in the detail under the table, on phones in a full sheet rising from the bottom
const selected = ref<number | null>(null)
const settings = ref<QueryLogSettings | null>(null)
const loaded = ref(false)
let timer: number | undefined
// 每次重读拿一个新代号：晚到的旧回答（往前翻、轮询的也算）对不上就丢掉，不盖住新的
// Each reload takes a new generation: a late answer from before (older pages and polls too) that does not match is dropped instead of
// covering the new one
let generation = 0
// 服务端说过的最新编号：轮询只要比它新的，带筛选也只扫这之后的 / The newest id the server has reported: a poll asks only for newer
// ones, so even a filtered poll scans only what came after it
let seenId = 0
// 离开日志页以后还在路上的读取：回来了也不再动列表和地址栏 / Reads still on the way after leaving the page: when they land they no
// longer touch the list or the address bar
let alive = true
// 连不上面板：和运行日志一样，什么都没读到时只留一句「连上面板后自动打开」；连上后马上重读，重读回来之前不闪红字
// The panel unreachable: as in the runtime log, with nothing read only 连上面板后自动打开 stays; once connected it re-reads at
// once, and no red notice flashes before that read answers
const { down: panelDown } = useConnection()
const reconnecting = ref(false)
watch(panelDown, (now, before) => {
  if (!before || now) return
  reconnecting.value = true
  void loadWithDest().finally(() => { reconnecting.value = false })
})
// 地址栏里带着去向时先读配置：上游组这类去向要靠配置才认得出来；认不出的（比如删掉的组）从地址栏去掉，不在空的下拉框下面悄悄列出全部
// With a destination in the address bar the config is read first, since destinations such as an upstream group are recognised only
// through it; one not recognised (a deleted group, say) leaves the address bar, rather than everything being listed under an empty select
async function loadWithDest(): Promise<void> {
  if (!dest.value) { await Promise.all([ctx.value ? null : loadContext(), load()]); return }
  if (!ctx.value) await loadContext()
  if (!alive) return
  // 去掉去向以后由筛选的监听重读 / With the destination dropped, the filter watcher reads again
  if (ctx.value && !options.value.some((o) => o.value === dest.value)) setQuery({ dest: undefined })
  else await load()
}
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
// 地址栏的搜索变了（点侧栏的「日志」、前进后退）：搜索框跟着变 / The address bar's search changed (the sidebar's 日志, back and forward): the box follows
watch(() => route.query.q, (value) => {
  const said = String(value ?? '')
  if (said === q.value.trim()) return
  window.clearTimeout(typing)
  q.value = said
})
const ruleTitle = computed(() => (rule.value ? (ctx.value?.names.rule(rule.value) ?? rule.value) : ''))
const filtered = computed(() => Boolean(q.value.trim() || dest.value || client.value || rule.value || upstream.value))
const searchInput = ref<HTMLInputElement | null>(null)
function clearFilters(): void {
  q.value = ''
  setQuery({ q: undefined, dest: undefined, client: undefined, rule: undefined, in: undefined, phase: undefined, upstream: undefined })
  // 按钮跟着空状态一起没了：焦点放进搜索框 / The button leaves with the empty state: focus goes to the search box
  void nextTick(() => searchInput.value?.focus())
}
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
// 列表里的行是按哪套筛选读的：和现在的对不上（换了筛选、那次读失败了）时行一直淡着、点不了，提示说这是筛选前的结果
// Which filters the listed rows were read with: while they differ from the current ones (filters changed and that read failed), the rows
// stay faded and cannot be clicked, and the notice says they are from before the filter
const rowsFor = ref('')
const staleRows = computed(() => items.value.length > 0 && rowsFor.value !== params())
async function load(): Promise<void> {
  const mine = ++generation
  loading.value = true
  // 换了筛选：旧的往前翻的位置、停在哪、攒着的新查询都作废 / New filters: the old paging position, the stop point and the waiting
  // queries are void
  nextBefore.value = null
  stoppedAt.value = null
  fresh.value = null
  freshMore.value = false
  try {
    const page = await apiRequest<QueryLogPage>(`/api/v1/querylog?${params()}`)
    if (mine !== generation) return
    supported.value = page.supported
    items.value = page.items.map(itemOf)
    nextBefore.value = page.next_before
    stoppedAt.value = stoppedOf(page)
    newestMs.value = page.newest_unix_ms
    seenId = page.newest_id ?? 0
    rowsFor.value = params()
    loadError.value = ''
    unavailable.value = false
    keepSelection()
  } catch (error) {
    if (mine !== generation) return
    loadError.value = errorMessage(error)
    unavailable.value = error instanceof ApiError && error.code === 'querylog_unavailable'
  } finally {
    if (mine === generation) {
      loading.value = false
      loaded.value = true
    }
  }
}
async function loadOlder(): Promise<void> {
  if (nextBefore.value === null || loadingOlder.value || loading.value) return
  const mine = generation
  loadingOlder.value = true
  try {
    const page = await apiRequest<QueryLogPage>(`/api/v1/querylog?${params({ before: String(nextBefore.value) })}`)
    if (mine !== generation) return
    items.value = [...items.value, ...page.items.map(itemOf)]
    nextBefore.value = page.next_before
    stoppedAt.value = stoppedOf(page)
  } catch (error) {
    // 连不上面板由顶上的横幅说，连上以后整个重读 / An unreachable panel is the top banner's to say; reconnecting reloads everything
    if (mine === generation && !isPanelDown(error)) toast.error(`没能读到更早的查询：${errorMessage(error)}`)
  } finally {
    loadingOlder.value = false
  }
}
// 「继续往前查」：读完把焦点放在新读到的第一条上，没有就还在这个按钮上 / 继续往前查: once read, focus goes to the first new entry, or
// stays on the button when there is none
async function continueOlder(): Promise<void> {
  const known = new Set(items.value.map((item) => item.id))
  await loadOlder()
  await nextTick()
  const first = items.value.find((item) => !known.has(item.id) && !isGap(item))
  // 这次什么也没读到、按钮也没了（成了空卡）：焦点放到空卡的按钮上，没有就放进搜索框 / Nothing read and the button gone (an empty card
  // now): focus goes to the card's button, or else the search box
  ;(first ? rowEl(first.id) : stream.value?.querySelector<HTMLElement>('.qlog-continue, .ui-empty .ui-btn') ?? searchInput.value)?.focus()
}
/** 这一页是不是因为看到上限才停下的：还有更早的，却没凑满一页 / Whether this page stopped at the read limit: more is older, yet the page is not full */
const stoppedOf = (page: QueryLogPage) => (page.next_before !== null && page.items.length < PAGE ? page.scanned_to_unix_ms : null)
// 轮询只要比列表最上面那条新的（after），服务端扫到它就停，不必把整个筛选再扫一遍。停在顶部、没有选中时直接进来；
// 往下读、选着一条，或者新的多过一页时攒在提示条里。
// A poll asks only for records newer than the top of the list (after), so the server stops there instead of running the whole filter
// again. At the top with nothing selected they come straight in; while reading further down, with a row selected, or with more than a
// page of them, they wait in the banner.
async function poll(): Promise<void> {
  // 跨了天才换「今天」：每次都换会让整张表每 5 秒重画一遍 / 「Today」 changes only across midnight: changing it every time would
  // redraw the whole table every 5 seconds
  const now = Date.now()
  if (new Date(now).toDateString() !== new Date(today.value).toDateString()) today.value = now
  if (loading.value || !loaded.value || !supported.value || unavailable.value || document.hidden) return
  const mine = generation
  try {
    const page = await apiRequest<QueryLogPage>(`/api/v1/querylog?${params({ after: String(seenId) })}`)
    if (mine !== generation || loading.value) return
    newestMs.value = page.newest_unix_ms
    seenId = Math.max(seenId, page.newest_id ?? 0)
    const newer = page.items.map(itemOf)
    // 还有没取完的（多过一页，或者扫到上限）：不往列表里塞，免得中间留洞 / More than was taken (over a page, or the scan limit): nothing
    // goes into the list, so no hole is left in it
    const more = page.next_before !== null
    if (!newer.length && !more) return
    if (!more && !fresh.value && atTop.value && selected.value === null) { prepend(newer); return }
    const waiting = [...newer, ...(fresh.value ?? [])]
    fresh.value = waiting.slice(0, PAGE)
    freshMore.value = freshMore.value || more || waiting.length > PAGE
  } catch { /* 下一轮再试；连不上由顶上的横幅说 / Try again next round; an unreachable panel is the top banner's to say */ }
}
function prepend(newer: QueryLogItem[]): void {
  const next = [...newer, ...items.value]
  if (next.length <= KEEP) { items.value = next; return }
  // 只留最新的几页，往前翻从留下的最后一条接着 / Only the newest pages stay, and paging back continues from the last one kept
  items.value = next.slice(0, KEEP)
  nextBefore.value = items.value[items.value.length - 1]!.id
  stoppedAt.value = null
}
const freshCount = computed(() => (fresh.value ?? []).filter((item) => !isGap(item)).length)
const freshLabel = computed(() => {
  if (freshMore.value) return freshCount.value >= PAGE ? `有 ${PAGE} 条以上新查询，点击显示` : '有新查询，点击显示'
  return freshCount.value ? `有 ${freshCount.value} 条新查询，点击显示` : null
})
// 手机上列表不另开滚动框，整页滚：点开一行的处理过程比半屏高，套两层滚动看不全；顶部、到底都按页面算。
// 宽屏照运行日志，列表自己滚，工具行一直在。
// On phones the list has no scroller of its own and the page scrolls: an opened row's steps run taller than half a screen, and two
// nested scrollers would never show them whole; the top and the bottom are measured on the page. Wider screens follow the runtime
// log: the list scrolls by itself and the toolbar stays.
const PHONE = '(max-width: 640px)'
const pageScrolls = () => window.matchMedia(PHONE).matches
const headerBottom = () => document.querySelector('.app-header')?.getBoundingClientRect().bottom ?? 0
function showFresh(): void {
  void load().then(async () => {
    const el = stream.value
    if (!el) return
    if (!pageScrolls()) el.scrollTo({ top: 0 })
    else {
      const above = el.getBoundingClientRect().top - headerBottom()
      if (above < 0) window.scrollBy({ top: above })
    }
    await nextTick()
    // 选中的那条还开着：焦点回到它，上下键接着从它走；没有选中才放在第一条 / With the selection still open, focus returns to it and the
    // arrow keys go on from there; only without one does focus go to the first entry
    const first = entries.value.find((item) => !isGap(item))
    const target = selected.value !== null && listed(selected.value) ? selected.value : first?.id
    if (target !== undefined) rowEl(target)?.focus({ preventScroll: true })
  })
}
function onScroll(): void {
  const el = stream.value
  if (!el) return
  // 查到上限停下的地方要人点「继续往前查」，滚到底不自己接着找 / Where a read stopped at its limit, 继续往前查 is the reader's to press;
  // scrolling to the end does not go on by itself
  const more = stoppedAt.value === null
  if (pageScrolls()) {
    atTop.value = el.getBoundingClientRect().top >= headerBottom() - 8
    if (more && document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 400) void loadOlder()
    return
  }
  atTop.value = el.scrollTop < 8
  if (more && el.scrollHeight - el.scrollTop - el.clientHeight < 400) void loadOlder()
}

// ---------- 行 / rows ----------
const entries = computed(() => items.value)
const firstEntry = computed(() => entries.value.find((item): item is QueryLogEntry => !isGap(item)) ?? null)
// 键盘：整张表只有一个 Tab 停点（选中的那行，没选中时第一行），行之间用上下键 / Keyboard: the table is one Tab stop (the selected
// row, or the first one), and up and down move between rows
const tabStop = computed(() => (selected.value !== null && listed(selected.value) ? selected.value : firstEntry.value?.id ?? null))
const routeCell = (entry: QueryLogEntry) => routeOf(entry, ctx.value)
// 手机第二行：去向、来源（缓存这类）、耗时、客户端 / The phone's second line: destination, source (cache and the like), latency, client
const phoneLine = (entry: QueryLogEntry) => {
  const source = sourceOf(entry)
  // 按客户端筛选时每行都是同一个地址：不再重复（和宽屏收起客户端一列一样） / Filtered by client, every row has the same address: it is
  // not repeated (as the wide table folds its client column)
  return [routeCell(entry).where, ...(source && !source.literal ? [source.text] : []), latencyText(entry.latency_ms), ...(client.value ? [] : [entry.client])]
}
// 日期分隔：时间列只写时分秒，跨了天的地方插一行日期（最上面一条不是今天的也先写日期）
// Date rows: the time column holds the clock only, and a row with the date goes where the day changes (above the first entry too when it
// is not today's)
function dayBreak(index: number): string | null {
  const item = entries.value[index]!
  const before = index > 0 ? entries.value[index - 1]! : null
  const day = new Date(item.time_unix_ms).toDateString()
  if (before ? new Date(before.time_unix_ms).toDateString() === day : day === new Date(today.value).toDateString()) return null
  return dayText(item.time_unix_ms)
}

// ---------- 选中和详情 / selection and the detail ----------
const phone = usePhone()
// 开着的那条单独留一份：重读以后它不在读到的这几页里（比如在第二页），详情照旧开着，等人自己关
// The open entry is kept on its own: when a reload no longer lists it (it was on page two, say), the detail stays open until the reader
// closes it
const held = shallowRef<QueryLogEntry | null>(null)
const current = computed(() => {
  if (selected.value === null) return null
  return items.value.find((item): item is QueryLogEntry => !isGap(item) && item.id === selected.value) ?? (held.value?.id === selected.value ? held.value : null)
})
const detailTab = ref<'summary' | 'steps'>('summary')
const DETAIL_TABS = [{ value: 'summary', label: '概况' }, { value: 'steps', label: '处理过程' }]
const sheet = ref<HTMLDialogElement | null>(null)
const rowEl = (id: number) => stream.value?.querySelector<HTMLButtonElement>(`.qlog-row[data-id="${id}"]`) ?? null
const listed = (id: number) => items.value.some((item) => !isGap(item) && item.id === id)
// 选中的那一条写在地址栏里（id）：从规则页、诊断页回来或者刷新，详情还开着 / The selected entry lives in the address bar (id): coming back
// from the rules or diagnostics page, or reloading, finds the detail still open
function writeId(id: number | null): void {
  const said = route.query.id ? String(route.query.id) : null
  if (said === (id === null ? null : String(id))) return
  void router.replace({ query: { ...route.query, id: id === null ? undefined : String(id) } })
}
// 手机上点开详情在浏览历史里多记一步：返回手势（iPhone 左滑也一样）先关详情，再返回才离开页面
// On phones opening the detail adds a history step: the back gesture (iPhone swipe-back too) closes the detail first, and only the next
// one leaves the page
let pushedSheet = false
// 从地址栏打开的（刷新、从别的页回来、前进）：上一步历史正好是不带这个参数的这一页，就当是打开时记的那一步，关的时候退回去
// Opened from the address bar (a reload, coming back from another page, forward): when the history step behind is this same page
// without the parameter, it is taken as the step added on opening, and closing goes back over it
function stepBehind(param: 'id' | 'settings'): boolean {
  const back = (window.history.state as { back?: unknown } | null)?.back
  return typeof back === 'string' && back === router.resolve({ query: { ...route.query, [param]: undefined } }).fullPath
}
function open(id: number, how: { push?: boolean; focus?: boolean } = {}): void {
  selected.value = id
  held.value = items.value.find((item): item is QueryLogEntry => !isGap(item) && item.id === id) ?? held.value
  if (phone.value && how.push) {
    pushedSheet = true
    void router.push({ query: { ...route.query, id: String(id) } })
  } else {
    writeId(id)
    if (phone.value && !pushedSheet && route.query.id === String(id)) pushedSheet = stepBehind('id')
  }
  if (phone.value) { void nextTick(() => { if (sheet.value && !sheet.value.open) sheet.value.showModal() }); return }
  // 详情升起来以后，选中的行不能被它盖住 / Once the detail rises, the selected row must not sit under it
  void nextTick(() => {
    const row = rowEl(id)
    row?.scrollIntoView({ block: 'nearest' })
    if (how.focus) row?.focus({ preventScroll: true })
  })
}
function select(id: number): void {
  if (selected.value === id) closeDetail()
  else open(id, { push: true })
}
// 收起以后把地址栏里的 id 去掉：打开时记过一步历史的退回去，不然原地换掉 / After closing, the id leaves the address bar: a history step
// added on opening is gone back over, otherwise the address is replaced in place
function forget(): void {
  if (pushedSheet) { pushedSheet = false; router.back() }
  else writeId(null)
}
// 手机详情被 Esc、安卓的返回关掉：选中跟着清掉，焦点回到那一行 / The phone sheet closed by Esc or Android's back: the selection
// clears with it and focus returns to the row
function onSheetClose(): void {
  const was = selected.value
  if (was === null) return
  selected.value = null
  forget()
  void nextTick(() => rowEl(was)?.focus({ preventScroll: true }))
}
function closeDetail(restoreFocus = true): void {
  const was = selected.value
  // 先清选中：关掉整屏详情时触发的 close 就不再重复收一遍 / The selection clears first, so the close event the sheet fires does nothing more
  selected.value = null
  if (sheet.value?.open) sheet.value.close()
  if (was !== null) forget()
  if (restoreFocus && was !== null) void nextTick(() => rowEl(was)?.focus({ preventScroll: true }))
}
// 返回手势、浏览器后退把 id 退掉了：详情跟着关，不再动地址栏 / The back gesture or the browser's back took the id away: the detail
// closes with it and the address bar is left alone
watch(() => route.query.id, (id) => {
  // 前进键回到带 id 的地址：详情跟着开，地址栏和详情两头一致 / Forward onto an address with an id: the detail opens with it, so the
  // address bar and the detail agree both ways
  if (id !== undefined) {
    const wanted = Number(id)
    if (!Number.isNaN(wanted) && wanted !== selected.value && loaded.value && listed(wanted)) open(wanted, { focus: true })
    return
  }
  if (selected.value === null) return
  const was = selected.value
  pushedSheet = false
  selected.value = null
  if (sheet.value?.open) sheet.value.close()
  void nextTick(() => rowEl(was)?.focus({ preventScroll: true }))
})
// 手机和宽屏之间转过来（转屏）：选中的那条在手机上要有整屏详情 / Turning between phone and wide layouts: on a phone the selected entry
// needs its sheet
watch(phone, (now) => {
  if (now && selected.value !== null) void nextTick(() => { if (sheet.value && !sheet.value.open) sheet.value.showModal() })
})
// 重读以后：选中的那条还在就接着开着，不在了才收起；地址栏里带着的那条第一次读到时打开，比第一页早的往前多读几页找它
// After a reload: the selected entry stays open while it is still listed and closes only when it is gone; the one named in the address
// bar opens the first time it is read, and one older than the first page is looked for a few pages back
function keepSelection(): void {
  const fromUrl = selected.value === null
  const wanted = selected.value ?? (route.query.id ? Number(route.query.id) : null)
  if (wanted === null || Number.isNaN(wanted)) return
  if (listed(wanted)) { if (fromUrl) open(wanted, { focus: true }); return }
  if (fromUrl) { const mine = generation; void nextTick(() => reveal(wanted, mine)); return }
  // 开着的那条不在这几页里：读到了最早一条还没有，就是删掉了，收起；不然照旧开着（多读几页去找太费，带筛选时每页都要扫）
  // The open entry is not on these pages: when the oldest has been read and it is not there, it was deleted, so the detail closes;
  // otherwise it stays open (reading more pages to find it costs too much, a filtered page being a full scan each)
  if (nextBefore.value === null) closeDetail(false)
}
async function reveal(wanted: number, mine: number): Promise<void> {
  for (let page = 0; page < 5 && mine === generation && !listed(wanted) && nextBefore.value !== null; page++) {
    const last = items.value[items.value.length - 1]
    if (last && last.id < wanted) break
    await loadOlder()
  }
  if (mine !== generation) return
  if (listed(wanted)) open(wanted, { focus: true })
  else writeId(null)
}
// 上下键在行之间移动，Esc 在表格和详情里任何地方都能关掉详情（和 Surge 的请求列表一样）
// Up and down move between rows, and Esc closes the detail from anywhere in the table or the detail (as in Surge's request list)
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && selected.value !== null) { event.preventDefault(); closeDetail(); return }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  if (!(event.target as HTMLElement | null)?.closest('.qlog-row')) return
  const list = items.value.filter((item): item is QueryLogEntry => !isGap(item))
  // 从选中的那行走；没有选中时从有焦点的那行走（关掉详情、继续往前查以后） / Move from the selected row, or from the focused one when
  // nothing is selected (after closing the detail or 继续往前查)
  const focused = Number((event.target as HTMLElement).closest('.qlog-row')?.getAttribute('data-id'))
  const base = selected.value ?? (Number.isNaN(focused) ? null : focused)
  const at = list.findIndex((item) => item.id === base)
  const next = list[at < 0 ? 0 : Math.min(list.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))]
  if (!next) return
  event.preventDefault()
  open(next.id)
  void nextTick(() => {
    const row = rowEl(next.id)
    row?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: 'nearest' })
  })
}
const rowsOf = (entry: QueryLogEntry) => stepRows(entry, ctx.value)
const factsOf = (entry: QueryLogEntry) => detailFacts(entry, ctx.value)
// 手机断行：短的「名字」和几个常用词不拆开，最后一个字不单独落一行 / Phone line breaks: short 「names」 and a few common words stay
// whole, and the last character never sits alone on a line
const glued = glueText
// 漏记的一段：数和「条」之间是不断行空格 / A gap: a no-break space between the number and 条
const gapText = (n: number) => `这里漏记了\u00a0${n}\u00a0条：KixDNS 当时太忙没记下，或者面板没来得及取走`
// 去掉一个筛选：按钮马上就没了，焦点先放到选中的那行上，没有选中就放进搜索框 / Removing a filter: the button is about to go, so focus moves
// first to the selected row, or to the search box when nothing is selected
function dropFilter(patch: Record<string, undefined>): void {
  ;(selected.value !== null ? rowEl(selected.value) : searchInput.value)?.focus({ preventScroll: true })
  setQuery(patch)
}

function onlyClient(entry: QueryLogEntry): void {
  // 按钮马上就不在了：焦点先放回这一行 / The button is about to go: focus moves back to the row first
  rowEl(entry.id)?.focus({ preventScroll: true })
  setQuery({ client: entry.client })
}
// 手机详情里点「只看这个客户端」：先收起详情再筛 / 只看这个客户端 in the phone detail: close the sheet first, then filter
function onlyClientFromSheet(entry: QueryLogEntry): void {
  const at = entry.client
  // 打开时记的那一步历史不退回，直接换成筛过的地址：返回就回到没筛的列表 / The history step added on opening is not gone back over but
  // replaced with the filtered address, so back returns to the unfiltered list
  pushedSheet = false
  selected.value = null
  if (sheet.value?.open) sheet.value.close()
  setQuery({ client: at, id: undefined })
}
// 规则：打开规则页的快速添加，域名填好 / A rule: opens quick add on the rules page with the domain filled in
const ruleLink = (entry: QueryLogEntry) => ({ path: '/config', query: { quick: entry.qname } })
const diagLink = (entry: QueryLogEntry) => ({ path: '/diagnostics', query: { domain: entry.qname, type: entry.qtype, client: entry.client } })
// 这个域名（或它的上级）已经不记录了 / This domain (or a parent of it) is no longer recorded
const notRecorded = (qname: string) => Boolean(settings.value?.ignored_domains.some((d) => qname === d || qname.endsWith(`.${d}`)))
// 不再记录：先读一遍最新的设置再加，别处刚改过的不会被盖掉；撤销也只去掉这一个
// Stop recording: the latest settings are read first and the domain added to them, so a change made elsewhere is not overwritten;
// undo removes only this one
// 连点两下只算一次 / A double click counts once
let ignoring = false
async function ignoreDomain(entry: QueryLogEntry): Promise<void> {
  if (ignoring) return
  ignoring = true
  try {
    const latest = await apiRequest<QueryLogSettings>('/api/v1/querylog/settings')
    settings.value = latest
    if (notRecorded(entry.qname)) { toast.info(`已经不记录 ${entry.qname}`); return }
    settings.value = await putSettings({ ignored_domains: [...latest.ignored_domains, entry.qname] })
    toast.undoable(`以后不再记录 ${entry.qname} 和它的子域名`, () => { void undoIgnore(entry.qname) })
    // 按钮变成停用的「已不记录」：焦点挪到详情的关闭按钮上，Esc 照样能关 / The button turns into the disabled 已不记录: focus moves to
    // the detail's close button, so Esc still closes it
    void nextTick(() => {
      if (document.activeElement && document.activeElement !== document.body) return
      document.querySelector<HTMLElement>('.qlog-pane__head .ui-icon-btn, dialog.qlog-sheet[open] .pdrawer__head .ui-icon-btn')?.focus()
    })
  } catch (error) {
    toast.error(`没能改设置：${errorMessage(error)}`)
  } finally {
    ignoring = false
  }
}
async function undoIgnore(qname: string): Promise<void> {
  try {
    const latest = await apiRequest<QueryLogSettings>('/api/v1/querylog/settings')
    settings.value = await putSettings({ ignored_domains: latest.ignored_domains.filter((d) => d !== qname) })
  } catch (error) {
    toast.error(`没能撤销：${errorMessage(error)}`)
  }
}
const putSettings = (patch: Partial<QueryLogSettings>) => apiRequest<QueryLogSettings>('/api/v1/querylog/settings', { method: 'PUT', body: JSON.stringify(patch) })

// 下载已经列出来的这些（往下翻读到的都算），文件名用本地日期 / Downloads what is listed (everything paged in so far), named with the local date
function download(): void {
  const lines = items.value.filter((item) => !isGap(item)).map((item) => JSON.stringify(item))
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'application/x-ndjson;charset=utf-8' }))
  const a = document.createElement('a')
  const d = new Date()
  a.href = url
  a.download = `kixdns-querylog-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`
  a.click()
  URL.revokeObjectURL(url)
}

// ---------- 设置 / settings ----------
const drawer = ref<HTMLDialogElement | null>(null)
// 数字和单位之间是不断行空格：页头事实按第一个普通空格分出标签和值 / A no-break space between number and unit: the header facts split label from value at the first ordinary space
const RETENTIONS = [{ value: '6', label: '6 小时' }, { value: '24', label: '1 天' }, { value: '168', label: '7 天' }, { value: '720', label: '30 天' }, { value: '2160', label: '90 天' }, { value: 'custom', label: '自定义' }]
const draft = ref({ retention: '2160', customHours: '', maxMb: '500', ignored: '' })
// 出错提示在填完（离开那个框）或按了保存以后才出来，不在刚选「自定义」时就红 / A problem shows once the field is left or 保存 is
// pressed, not the moment 自定义 is chosen
const touched = ref({ hours: false, mb: false, ignored: false, submitted: false })
const settingsBusy = ref(false)
// 服务端回来的错，按说的是哪一项放在那个框下面 / A server error goes under the field it is about
const serverProblem = ref<{ field: 'hours' | 'mb' | 'ignored' | 'form'; text: string } | null>(null)
const problems = computed(() => {
  const d = draft.value
  const shown = (field: 'hours' | 'mb' | 'ignored') => touched.value[field] || touched.value.submitted
  const said = (field: 'hours' | 'mb' | 'ignored') => (serverProblem.value?.field === field ? serverProblem.value.text : '')
  return {
    hours: (d.retention === 'custom' && shown('hours') ? hoursProblem(d.customHours) : '') || said('hours'),
    mb: (shown('mb') ? capProblem(d.maxMb) : '') || said('mb'),
    ignored: (shown('ignored') ? ignoredDomains(d.ignored).problem : '') || said('ignored'),
    form: serverProblem.value?.field === 'form' ? serverProblem.value.text : '',
  }
})
const draftValid = () => (draft.value.retention !== 'custom' || !hoursProblem(draft.value.customHours)) && !capProblem(draft.value.maxMb) && !ignoredDomains(draft.value.ignored).problem
const mb = (bytes: number) => `${Math.round(bytes / 1048576)} MB`
async function openSettings(): Promise<void> {
  let s: QueryLogSettings
  try {
    s = await apiRequest<QueryLogSettings>('/api/v1/querylog/settings')
  } catch (error) {
    toast.error(`没能读到查询日志设置：${errorMessage(error)}`)
    return
  }
  settings.value = s
  const preset = RETENTIONS.some((r) => r.value === String(s.retention_hours))
  draft.value = { retention: preset ? String(s.retention_hours) : 'custom', customHours: preset ? '' : String(s.retention_hours), maxMb: String(Math.round(s.max_bytes / 1048576)), ignored: s.ignored_domains.join('\n') }
  touched.value = { hours: false, mb: false, ignored: false, submitted: false }
  serverProblem.value = null
  await nextTick()
  drawer.value?.showModal()
  // 手机上同详情一样记一步历史：返回手势先关设置 / On phones, as for the detail, a history step: the back gesture closes the settings first
  if (phone.value) {
    pushedDrawer = true
    void router.push({ query: { ...route.query, settings: '1' } })
  }
}
let pushedDrawer = false
function onDrawerClose(): void {
  if (!pushedDrawer) return
  pushedDrawer = false
  router.back()
}
// 正在保存时 Esc 不关：关了就看不到保存失败的提示 / Esc does not close while saving: closed, a failed save would go unseen
function onDrawerCancel(event: Event): void { if (settingsBusy.value) event.preventDefault() }
watch(() => route.query.settings, (value) => {
  if (value !== undefined || !drawer.value?.open) return
  pushedDrawer = false
  drawer.value.close()
})
// 改了框里的内容，服务端上次说的错就不算了 / Editing a field clears what the server said about the last attempt
watch(draft, () => { serverProblem.value = null }, { deep: true })
// 保存没通过：焦点放到第一个有错的框上，读屏器接着读它下面的错 / A save that did not go through: focus goes to the first wrong field,
// and a screen reader reads the error under it
function focusProblem(): void {
  void nextTick(() => drawer.value?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
}
async function saveSettings(): Promise<void> {
  touched.value.submitted = true
  serverProblem.value = null
  if (settingsBusy.value) return
  if (!draftValid()) { focusProblem(); return }
  const d = draft.value
  const next = {
    retention_hours: d.retention === 'custom' ? Number(d.customHours) : Number(d.retention),
    max_bytes: Math.round(Number(d.maxMb)) * 1048576,
    ignored_domains: ignoredDomains(d.ignored).domains,
  }
  const before = settings.value
  // 什么都没改：关上就好，不写、不重读，开着的详情也不动 / Nothing changed: just close, with no write and no reload, and an open detail stays
  if (before && before.retention_hours === next.retention_hours && before.max_bytes === next.max_bytes && before.ignored_domains.join('\n') === next.ignored_domains.join('\n')) {
    drawer.value?.close()
    return
  }
  settingsBusy.value = true
  try {
    settings.value = await putSettings(next)
  } catch (error) {
    const text = errorMessage(error)
    // 保存途中设置已经关了（手机的返回手势）：失败用提示条说，不留在看不见的框里 / The settings closed while saving (a phone's back
    // gesture): the failure is said in a toast, not left in a drawer nobody sees
    if (!drawer.value?.open) { toast.error(`查询日志设置没保存：${text}`); return }
    serverProblem.value = { field: text.startsWith('保存多久') ? 'hours' : text.startsWith('最多占用') ? 'mb' : /域名/.test(text) ? 'ignored' : 'form', text }
    focusProblem()
    return
  } finally {
    settingsBusy.value = false
  }
  drawer.value?.close()
  toast.success('查询日志设置已保存')
  // 保存时间变短、上限变小会删掉旧的：重读一遍 / A shorter retention or a smaller cap deletes old records: read again
  if (before && (next.retention_hours < before.retention_hours || next.max_bytes < before.max_bytes)) void load()
}
async function clearAll(): Promise<void> {
  const ok = await confirm.ask({ title: '清空查询日志', body: '已经记下的查询全部删掉，找不回来。之后的查询照常记录。', confirmLabel: '清空查询日志', destructive: true })
  if (!ok) return
  try {
    settings.value = await apiRequest<QueryLogSettings>('/api/v1/querylog/clear', { method: 'POST' })
  } catch (error) {
    serverProblem.value = { field: 'form', text: `没能清空：${errorMessage(error)}` }
    return
  }
  drawer.value?.close()
  toast.success('查询日志已清空')
  void load()
}
// 只有按下和松开都在遮罩上才关：从框里拖选文字拖到外面不算点了遮罩 / Close only when the press and the release are both on the backdrop:
// dragging a text selection out of a field is not a click on the backdrop
let pressedOn: EventTarget | null = null
const onPress = (event: PointerEvent) => { pressedOn = event.target }
function onBackdrop(event: MouseEvent, close: () => void): void {
  if (event.target === event.currentTarget && pressedOn === event.currentTarget) close()
}

// 页头事实：最近一条（整个日志的，不跟着筛选变）；内核不支持、读不到时也留着这一项，换页签时页头高度不跳
// Header facts: the newest entry (of the whole log, whatever the filter); kept with an old kernel or nothing read, so the header height
// does not jump between tabs
watch([newestMs, today, loaded, loadError, items], () => {
  if (!loaded.value) { emit('facts', 'loading'); return }
  emit('facts', [`最近一条 ${newestMs.value ? timeText(newestMs.value, today.value) : '—'}`])
}, { immediate: true })

// 每个筛选各看各的：写 id、settings 这类不是筛选的参数不会触发重读 / Each filter is watched on its own, so writing a parameter that is
// not a filter (id, settings) never triggers a reload
watch([() => route.query.q, () => route.query.dest, () => route.query.client, () => route.query.rule, () => route.query.in, () => route.query.phase, () => route.query.upstream], () => { void load() })
onMounted(async () => {
  // 配置、日志、设置一起读：日志先到就先画，名字等配置到了再换成配置页上的叫法；慢网络上少等两趟。地址栏里带着去向时先等配置，
  // 上游组这类去向要靠配置才认得出来
  // The config, the log and the settings are read together: the log is drawn as soon as it lands and its names switch to the config
  // page's once the config arrives; on a slow network that saves two round trips. With a destination in the address bar the config comes
  // first, since destinations such as an upstream group are recognised only through it
  void apiRequest<QueryLogSettings>('/api/v1/querylog/settings').then((s) => { settings.value = s }, () => { /* 设置抽屉打开时再读 / Read again when the drawer opens */ })
  // 刷新时地址栏里还挂着设置那一步：去掉，不自己打开；后面一步历史正是去掉它的这一页时退回去，不留两个一样的
  // A reload with the settings step still in the address bar: it is dropped, not reopened; when the history step behind is that same page
  // without it, it is gone back over, so no two identical entries remain
  if (route.query.settings !== undefined) {
    if (stepBehind('settings')) router.back()
    else setQuery({ settings: undefined })
  }
  // 轮询和滚动先挂上：第一次读取还在路上就离开时，卸载能把它们摘掉（轮询在读到之前什么也不做）
  // Polling and scrolling are attached first: leaving while the first read is on its way still removes them on unmount (polls do nothing
  // until that read lands)
  timer = window.setInterval(() => { void poll() }, 5000)
  window.addEventListener('scroll', onScroll, { passive: true })
  await loadWithDest()
})
onBeforeUnmount(() => {
  alive = false
  // 还在路上的读取一律作废 / Any read still on its way is void
  generation++
  window.clearInterval(timer)
  window.clearTimeout(typing)
  window.removeEventListener('scroll', onScroll)
})
</script>

<template>
  <!-- 内核太旧、也没有记下过什么：说清要做什么 / A kernel too old and nothing recorded: say what to do -->
  <section v-if="!supported && loaded && !entries.length" class="ui-card qlog-state">
    <UiEmpty :icon="FileSearch" title="当前内核不支持查询日志" desc="更新内核后，每次查询怎么处理的都会记在这里。">
      <RouterLink class="ui-btn ui-btn--secondary" to="/system">去系统页</RouterLink>
    </UiEmpty>
  </section>
  <!-- 读取失败：和运行日志一样一条提示，有行时只说可能过期 / A load failure: one notice as in the runtime log; with rows on screen it only says they may be stale -->
  <!-- 连不上面板时由顶上的横幅说，这里不复述 / With the panel unreachable the top banner says it; no second copy here -->
  <div v-else-if="loadError && !panelDown && !reconnecting" class="ui-notice ui-notice--err logs-notice" role="alert">
    <CircleAlert :size="16" aria-hidden="true" />
    <span>{{ !entries.length ? '读取失败' : staleRows ? '下面还是换筛选之前的结果' : '数据可能已过期' }}</span>
    <small><template v-for="(run, k) in glued(loadError)" :key="k"><span v-if="run.keep" class="qlog-keep">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></small>
    <!-- 目录打不开时重试没用，要重启面板 / With the directory unusable a retry cannot help; the panel needs a restart -->
    <button v-if="!unavailable" class="ui-btn ui-btn--secondary ui-btn--sm ui-notice__action" type="button" :disabled="loading" @click="load">重试</button>
  </div>
  <p v-else-if="waitingForPanel" class="ui-notice ui-notice--off logs-notice" role="status"><Clock :size="16" aria-hidden="true" /><span>连上面板后自动打开</span></p>
  <!-- 换成了不支持查询日志的内核：以前记下的照样能看，上面说一句 / Switched to a kernel without the query log: what was recorded before can still be read, with a line above -->
  <p v-if="!supported && entries.length" class="ui-notice ui-notice--off logs-notice" role="status"><FileSearch :size="16" aria-hidden="true" /><span>当前内核不支持查询日志，下面是以前记下的；新的查询要更新内核后才会记录</span><RouterLink class="ui-btn ui-btn--secondary ui-btn--sm ui-notice__action" to="/system">去系统页</RouterLink></p>
  <!-- 目录打不开、一条也没有：只留上面那条提示，不摆一排用不了的工具 / The directory unusable and nothing listed: only the notice above
       stays, with no row of tools that cannot work -->
  <section v-if="(supported || entries.length) && !waitingForPanel && !(unavailable && !entries.length)" class="log-console ui-card qlog" role="tabpanel" aria-labelledby="logs-tab-query">
    <!-- 工具行：搜索、去向、右端设置和下载 / The toolbar: search, destination, settings and download at the right end -->
    <header class="log-toolbar">
      <label class="ui-input log-search"><Search :size="16" aria-hidden="true" /><input ref="searchInput" v-model="q" aria-label="搜索域名或客户端" placeholder="搜索域名或客户端" maxlength="253" autocapitalize="off" spellcheck="false" /></label>
      <UiSelect class="qlog-dest" :model-value="dest" :options="options" label="按去向筛选" @update:model-value="setQuery({ dest: $event || undefined })" />
      <div class="log-toolbar__end">
        <button class="ui-btn ui-btn--secondary ui-btn--icon" type="button" title="查询日志设置" aria-label="查询日志设置" @click="openSettings"><SlidersHorizontal :size="16" aria-hidden="true" /></button>
        <button class="ui-btn ui-btn--secondary ui-btn--icon" type="button" title="下载已列出的查询" aria-label="下载已列出的查询" :disabled="!entries.length" @click="download"><Download :size="16" aria-hidden="true" /></button>
      </div>
    </header>
    <!-- 从别处带进来、或点「只看这个客户端」加上的筛选，一个一个能去掉 / Filters brought in from elsewhere or added by 只看这个客户端, each removable -->
    <div v-if="client || rule || upstream" class="qlog-filters">
      <span v-if="client" class="qlog-filter">客户端 <span class="qlog-lit">{{ client }}</span><button type="button" :aria-label="`去掉筛选：客户端 ${client}`" @click="dropFilter({ client: undefined })"><X :size="14" aria-hidden="true" /></button></span>
      <span v-if="rule" class="qlog-filter">{{ rulePhase ? '回答后检查' : '规则' }}「{{ ruleTitle }}」<button type="button" :aria-label="`去掉筛选：${rulePhase ? '回答后检查' : '规则'}「${ruleTitle}」`" @click="dropFilter({ rule: undefined, in: undefined, phase: undefined })"><X :size="14" aria-hidden="true" /></button></span>
      <span v-if="upstream" class="qlog-filter">问过上游 <span class="qlog-lit">{{ upstream }}</span><button type="button" :aria-label="`去掉筛选：问过上游 ${upstream}`" @click="dropFilter({ upstream: undefined })"><X :size="14" aria-hidden="true" /></button></span>
    </div>
    <!-- 表格和详情：宽屏上详情在表格下方，表格不变形；手机上详情从底边升起 / The table and the detail: on wide screens the detail sits under the table, which keeps its shape; on phones it rises from the bottom -->
    <div class="qlog-body" @keydown="onKey">
      <!-- 换筛选读回来之前旧的行变淡、点不了 / Until a filter change's read lands, the old rows fade and cannot be clicked -->
      <div ref="stream" class="qlog-stream" :class="{ 'is-loading': (loading && entries.length) || staleRows, 'is-one-client': Boolean(client), 'is-empty': !entries.length && !loading, 'has-banner': Boolean(freshLabel) }" :aria-busy="loading || undefined" @scroll.passive="onScroll">
        <div v-if="entries.length" class="qlog-head" aria-hidden="true"><span></span><span class="ui-lbl">时间</span><span class="ui-lbl qlog-head-client">客户端</span><span class="ui-lbl">域名</span><span class="ui-lbl qlog-head-type">类型</span><span class="ui-lbl">去向</span><span class="ui-lbl qlog-c-answer">回答</span><span class="ui-lbl qlog-c-source">来源</span><span class="ui-lbl qlog-num">耗时</span></div>
        <UiNewItemsBanner v-if="freshLabel" :label="freshLabel" :loading="loading" @show="showFresh" />
        <div v-if="loading && !entries.length" class="log-skeleton" role="status" aria-label="正在读取查询日志"><i v-for="n in 12" :key="n" class="sk"></i></div>
        <!-- 只有用到的东西变了的那几行才重画：选中一行只动两行，不是整张表 / Only rows whose inputs changed are redrawn: selecting a row
             touches two rows, not the whole table -->
        <template v-for="(item, index) in entries" :key="item.id" v-memo="[item, dayBreak(index), selected === item.id, tabStop === item.id, ctx, phone, client]">
          <p v-if="dayBreak(index)" class="qlog-day"><span>{{ dayBreak(index) }}</span></p>
          <!-- 漏记的一段：照实说，不悄悄缺 / A gap: said plainly, never a silent hole -->
          <p v-if="isGap(item)" class="qlog-gap" role="note"><span><template v-for="(run, k) in glued(gapText(item.gap))" :key="k"><span v-if="run.keep" class="qlog-keep">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></span></p>
          <button v-else class="qlog-row" :class="{ 'is-selected': selected === item.id }" type="button" :data-id="item.id" :tabindex="tabStop === item.id ? 0 : -1" :aria-current="selected === item.id ? 'true' : undefined" @click="select(item.id)">
            <i class="ui-dot qlog-dot" :class="`qlog-dot--${statusOf(item).tone}`" role="img" :aria-label="statusOf(item).label"></i>
            <time class="qlog-c-time">{{ clockText(item.time_unix_ms) }}</time>
            <span class="qlog-c-client qlog-lit">{{ item.client }}</span>
            <span class="qlog-c-name"><span class="qlog-lit">{{ item.qname }}</span><span class="qlog-phone-type">{{ item.qtype === 'A' ? '' : item.qtype }}</span></span>
            <span class="qlog-c-type">{{ item.qtype }}</span>
            <span class="qlog-c-dest"><span>{{ routeCell(item).where }}</span><span v-if="routeCell(item).rule" class="qlog-c-rule"> · {{ routeCell(item).rule }}</span></span>
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
        <p v-else-if="stoppedAt !== null && nextBefore !== null && entries.length" class="qlog-more qlog-stopped" role="status"><span>只往前查到 {{ timeText(stoppedAt, today) }}</span><button class="ui-btn ui-btn--secondary ui-btn--sm qlog-continue" type="button" @click="continueOlder">继续往前查</button></p>
        <!-- 一条也还没找到就停下：整张空卡说清楚，按钮在里面 / Stopped before finding any: the empty card says so, with the button inside -->
        <UiEmpty v-else-if="stoppedAt !== null && nextBefore !== null && !loading" :icon="FileSearch" title="还没找到符合条件的查询" :desc="`往前查到 ${timeText(stoppedAt, today)}，更早的还没查`">
          <button class="ui-btn ui-btn--secondary qlog-continue" type="button" @click="continueOlder">继续往前查</button>
        </UiEmpty>
        <!-- 清空以后日志本来就是空的：不管有没有筛选，都说还没有查询 / After a clear the log is empty: whatever the filters, it says there are no queries yet -->
        <UiEmpty v-if="!loading && !entries.length && !loadError && stoppedAt === null" :icon="FileSearch" :title="filtered && newestMs !== null ? '没有符合条件的查询' : '还没有查询'" :desc="filtered && newestMs !== null ? (q.trim() ? '换个搜索词，或者清除筛选' : '清除筛选就能看到全部查询') : '有设备来解析域名，就会出现在这里。'">
          <button v-if="filtered && newestMs !== null" class="ui-btn ui-btn--secondary" type="button" @click="clearFilters">清除筛选</button>
        </UiEmpty>
      </div>
      <!-- 宽屏的详情：页头（域名、谁在什么时候问的、状态），一行页签和四个去处，下面是概况或处理过程 / The wide-screen detail: a head (domain, who asked and when, status), a bar with tabs and four actions, then the summary or the steps -->
      <section v-if="current && !phone" class="qlog-pane" aria-label="查询详情">
        <header class="qlog-pane__head">
          <div class="qlog-pane__titles">
            <h2><span class="qlog-lit">{{ current.qname }}</span><span class="qlog-pane__type">{{ current.qtype }}</span></h2>
            <p><UiDotText :parts="requestLine(current)" /></p>
          </div>
          <span class="ui-tag" :class="{ 'ui-tag--ok': statusOf(current).tone === 'ok', 'ui-tag--warn': statusOf(current).tone === 'warn', 'ui-tag--err': statusOf(current).tone === 'err' }">{{ statusOf(current).label }}</span>
          <button class="ui-icon-btn" type="button" aria-label="关闭详情" title="关闭详情（Esc）" @click="closeDetail()"><X :size="16" aria-hidden="true" /></button>
        </header>
        <div class="qlog-pane__bar">
          <UiTabs v-model="detailTab" :items="DETAIL_TABS" label="详情内容" variant="segment" size="sm" />
          <div class="qlog-pane__actions">
            <RouterLink class="ui-btn ui-btn--text ui-btn--sm" :to="ruleLink(current)">为这个域名建规则</RouterLink>
            <RouterLink class="ui-btn ui-btn--text ui-btn--sm" :to="diagLink(current)">用诊断再测一次</RouterLink>
            <button v-if="client !== current.client" class="ui-btn ui-btn--text ui-btn--sm" type="button" @click="onlyClient(current)">只看这个客户端</button>
            <button class="ui-btn ui-btn--text ui-btn--sm" type="button" :disabled="notRecorded(current.qname)" @click="ignoreDomain(current)">{{ notRecorded(current.qname) ? '已不记录这个域名' : '不再记录这个域名' }}</button>
          </div>
        </div>
        <div class="qlog-pane__body">
          <div v-if="detailTab === 'summary'" class="qlog-facts">
            <div v-for="fact in factsOf(current)" :key="fact.key" class="qlog-fact" :class="fact.tone && `is-${fact.tone}`">
              <span class="ui-lbl">{{ fact.label }}</span>
              <p v-for="(line, at) in fact.lead" :key="at" class="qlog-fact__lead"><template v-for="(part, i) in line" :key="i"><span v-if="part.literal" class="qlog-lit qlog-literal"><template v-for="(seg, j) in literalParts(part.text)" :key="j"><wbr v-if="j" /><span :class="{ 'qlog-keep': seg.keep }">{{ seg.text }}</span></template></span><template v-else><template v-for="(run, k) in glued(part.text)" :key="`g${k}`"><span v-if="run.keep" class="qlog-keep">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></template></template></p>
              <p v-if="fact.sub.length" class="qlog-fact__sub"><template v-for="(part, i) in fact.sub" :key="i"><span v-if="part.literal" class="qlog-lit qlog-literal"><template v-for="(seg, j) in literalParts(part.text)" :key="j"><wbr v-if="j" /><span :class="{ 'qlog-keep': seg.keep }">{{ seg.text }}</span></template></span><template v-else><template v-for="(run, k) in glued(part.text)" :key="`g${k}`"><span v-if="run.keep" class="qlog-keep">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></template></template></p>
            </div>
          </div>
          <ol v-else class="ui-steps qlog-steps">
            <li v-for="(row, index) in rowsOf(current)" :key="index" class="ui-step" :class="[row.tone === 'ok' && row.decides ? 'ui-step--ok' : row.tone === 'err' ? 'ui-step--err' : row.tone === 'warn' ? 'ui-step--warn' : '', { 'ui-step--idle': row.idle }]">
              <span class="ui-step__time">{{ latencyText(row.at) }}</span>
              <span class="ui-step__mark" aria-hidden="true"><Check v-if="row.tone === 'ok' && row.decides" :size="12" /><X v-else-if="row.tone === 'err'" :size="12" /><i v-else></i></span>
              <div class="ui-step__body">
                <p class="ui-step__what"><template v-for="(part, at) in row.lead" :key="at"><span v-if="part.literal" class="qlog-lit qlog-literal"><template v-for="(seg, i) in literalParts(part.text)" :key="i"><wbr v-if="i" /><span :class="{ 'qlog-keep': seg.keep }">{{ seg.text }}</span></template></span><template v-else><template v-for="(run, k) in glued(part.text)" :key="`g${k}`"><span v-if="run.keep" class="qlog-keep">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></template></template></p>
                <p v-if="row.note.length" class="ui-step__why"><template v-for="(part, at) in row.note" :key="at"><span v-if="part.literal" class="qlog-lit qlog-literal"><template v-for="(seg, i) in literalParts(part.text)" :key="i"><wbr v-if="i" /><span :class="{ 'qlog-keep': seg.keep }">{{ seg.text }}</span></template></span><template v-else><template v-for="(run, k) in glued(part.text)" :key="`g${k}`"><span v-if="run.keep" class="qlog-keep">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></template></template></p>
              </div>
            </li>
          </ol>
        </div>
      </section>
    </div>
  </section>

  <!-- 手机的详情：从底边升起，概况三块、处理过程依次往下，四个去处在底部 / The phone detail: rises from the bottom; the three summary blocks, then the steps, the four actions at the foot -->
  <dialog v-if="phone" ref="sheet" class="pdrawer qlog-sheet" aria-labelledby="ql-detail-title" @close="onSheetClose" @pointerdown="onPress" @click="onBackdrop($event, closeDetail)">
    <div v-if="current" class="pdrawer__panel">
      <header class="pdrawer__head">
        <div class="pdrawer__titles">
          <h2 id="ql-detail-title"><span class="qlog-lit"><template v-for="(seg, i) in domainParts(current.qname)" :key="i"><wbr v-if="i" /><span :class="{ 'qlog-keep': seg.keep }">{{ seg.text }}</span></template></span><span class="qlog-pane__type">{{ current.qtype }}</span></h2>
          <p><UiDotText :parts="requestLine(current)" /></p>
        </div>
        <span class="ui-tag" :class="{ 'ui-tag--ok': statusOf(current).tone === 'ok', 'ui-tag--warn': statusOf(current).tone === 'warn', 'ui-tag--err': statusOf(current).tone === 'err' }">{{ statusOf(current).label }}</span>
        <button class="ui-icon-btn" type="button" aria-label="关闭" title="关闭" @click="closeDetail()"><X :size="16" /></button>
      </header>
      <div class="pdrawer__body qlog-sheet__body">
        <div class="qlog-facts">
          <div v-for="fact in factsOf(current)" :key="fact.key" class="qlog-fact" :class="fact.tone && `is-${fact.tone}`">
            <span class="ui-lbl">{{ fact.label }}</span>
            <p v-for="(line, at) in fact.lead" :key="at" class="qlog-fact__lead"><template v-for="(part, i) in line" :key="i"><span v-if="part.literal" class="qlog-lit qlog-literal"><template v-for="(seg, j) in literalParts(part.text)" :key="j"><wbr v-if="j" /><span :class="{ 'qlog-keep': seg.keep }">{{ seg.text }}</span></template></span><template v-else><template v-for="(run, k) in glued(part.text)" :key="`g${k}`"><span v-if="run.keep" class="qlog-keep">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></template></template></p>
            <p v-if="fact.sub.length" class="qlog-fact__sub"><template v-for="(part, i) in fact.sub" :key="i"><span v-if="part.literal" class="qlog-lit qlog-literal"><template v-for="(seg, j) in literalParts(part.text)" :key="j"><wbr v-if="j" /><span :class="{ 'qlog-keep': seg.keep }">{{ seg.text }}</span></template></span><template v-else><template v-for="(run, k) in glued(part.text)" :key="`g${k}`"><span v-if="run.keep" class="qlog-keep">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></template></template></p>
          </div>
        </div>
        <span class="ui-lbl qlog-sheet__label">处理过程</span>
        <ol class="ui-steps qlog-steps">
          <li v-for="(row, index) in rowsOf(current)" :key="index" class="ui-step" :class="[row.tone === 'ok' && row.decides ? 'ui-step--ok' : row.tone === 'err' ? 'ui-step--err' : row.tone === 'warn' ? 'ui-step--warn' : '', { 'ui-step--idle': row.idle }]">
            <span class="ui-step__time">{{ latencyText(row.at) }}</span>
            <span class="ui-step__mark" aria-hidden="true"><Check v-if="row.tone === 'ok' && row.decides" :size="12" /><X v-else-if="row.tone === 'err'" :size="12" /><i v-else></i></span>
            <div class="ui-step__body">
              <p class="ui-step__what"><template v-for="(part, at) in row.lead" :key="at"><span v-if="part.literal" class="qlog-lit qlog-literal"><template v-for="(seg, i) in literalParts(part.text)" :key="i"><wbr v-if="i" /><span :class="{ 'qlog-keep': seg.keep }">{{ seg.text }}</span></template></span><template v-else><template v-for="(run, k) in glued(part.text)" :key="`g${k}`"><span v-if="run.keep" class="qlog-keep">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></template></template></p>
              <p v-if="row.note.length" class="ui-step__why"><template v-for="(part, at) in row.note" :key="at"><span v-if="part.literal" class="qlog-lit qlog-literal"><template v-for="(seg, i) in literalParts(part.text)" :key="i"><wbr v-if="i" /><span :class="{ 'qlog-keep': seg.keep }">{{ seg.text }}</span></template></span><template v-else><template v-for="(run, k) in glued(part.text)" :key="`g${k}`"><span v-if="run.keep" class="qlog-keep">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></template></template></p>
            </div>
          </li>
        </ol>
      </div>
      <footer class="pdrawer__foot qlog-sheet__foot">
        <RouterLink class="ui-btn ui-btn--secondary" :to="ruleLink(current)">为这个域名建规则</RouterLink>
        <RouterLink class="ui-btn ui-btn--secondary" :to="diagLink(current)">用诊断再测一次</RouterLink>
        <button v-if="client !== current.client" class="ui-btn ui-btn--secondary" type="button" @click="onlyClientFromSheet(current)">只看这个客户端</button>
        <button class="ui-btn ui-btn--secondary" type="button" :disabled="notRecorded(current.qname)" @click="ignoreDomain(current)">{{ notRecorded(current.qname) ? '已不记录这个域名' : '不再记录这个域名' }}</button>
      </footer>
    </div>
  </dialog>

  <dialog ref="drawer" class="pdrawer qlog-drawer" aria-labelledby="ql-settings-title" @close="onDrawerClose" @cancel="onDrawerCancel" @pointerdown="onPress" @click="onBackdrop($event, () => { if (!settingsBusy) drawer?.close() })">
    <form class="pdrawer__panel" novalidate @submit.prevent="saveSettings">
      <header class="pdrawer__head">
        <h2 id="ql-settings-title">查询日志设置</h2>
        <button class="ui-icon-btn" type="button" aria-label="关闭" title="关闭" :disabled="settingsBusy" @click="drawer?.close()"><X :size="16" /></button>
      </header>
      <div class="pdrawer__body qlog-settings">
        <!-- 每个框的问题写在它自己下面，框也标红 / Each field's problem sits under it, and the field turns red -->
        <div class="pfield">
          <span>保存多久</span>
          <UiTabs v-model="draft.retention" :items="RETENTIONS" label="保存多久" variant="segment" />
          <label v-if="draft.retention === 'custom'" class="ui-input qlog-hours"><input v-model="draft.customHours" inputmode="numeric" aria-label="保存多少小时" placeholder="1–8760" :aria-invalid="Boolean(problems.hours) || undefined" :aria-describedby="problems.hours ? 'ql-hours-err' : undefined" @blur="touched.hours = true"><span>小时</span></label>
          <p v-if="problems.hours" id="ql-hours-err" class="ui-field-error" role="alert"><template v-for="(run, k) in glued(problems.hours)" :key="k"><span v-if="run.keep" class="qlog-keep">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></p>
        </div>
        <label class="pfield">
          <span>最多占用</span>
          <span class="ui-input qlog-mb"><input v-model="draft.maxMb" inputmode="numeric" aria-label="最多占用多少 MB" :aria-invalid="Boolean(problems.mb) || undefined" :aria-describedby="problems.mb ? 'ql-mb-err' : 'ql-mb-hint'" @blur="touched.mb = true"><span>MB</span></span>
          <p v-if="problems.mb" id="ql-mb-err" class="ui-field-error" role="alert"><template v-for="(run, k) in glued(problems.mb)" :key="k"><span v-if="run.keep" class="qlog-keep">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></p>
          <small id="ql-mb-hint" class="pfield__hint">{{ settings ? `已用 ${mb(settings.used_bytes)}${settings.oldest_unix_ms ? `，记录从 ${sinceText(settings.oldest_unix_ms)} 起` : ''}。` : '' }}超过上限时先删最早的。</small>
        </label>
        <label class="pfield">
          <span>不记录的域名 <small>可选</small></span>
          <span class="ui-input ui-input--area qlog-ignored"><textarea v-model="draft.ignored" rows="4" aria-label="不记录的域名" placeholder="一行一个，也可以用逗号隔开；连子域名一起不记" spellcheck="false" autocapitalize="off" :aria-invalid="Boolean(problems.ignored) || undefined" :aria-describedby="problems.ignored ? 'ql-ignored-err' : undefined" @blur="touched.ignored = true"></textarea></span>
          <p v-if="problems.ignored" id="ql-ignored-err" class="ui-field-error" role="alert"><template v-for="(run, k) in glued(problems.ignored)" :key="k"><span v-if="run.keep" class="qlog-keep">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></p>
        </label>
        <div class="qlog-danger">
          <button class="ui-btn ui-btn--danger ui-btn--sm" type="button" @click="clearAll">清空查询日志</button>
          <small>已经记下的全部删掉，之后照常记录</small>
        </div>
        <p v-if="problems.form" class="ui-field-error" role="alert"><template v-for="(run, k) in glued(problems.form)" :key="k"><span v-if="run.keep" class="qlog-keep">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></p>
      </div>
      <footer class="pdrawer__foot">
        <button class="ui-btn ui-btn--secondary" type="button" :disabled="settingsBusy" @click="drawer?.close()">取消</button>
        <button class="ui-btn ui-btn--primary" type="submit" :disabled="settingsBusy" :aria-busy="settingsBusy || undefined">保存</button>
      </footer>
    </form>
  </dialog>
</template>

<style>
/* 查询日志照 Surge 的请求列表：上面一张表，选中一行，详情在表格下方（原型也有放右侧的一版）；表格不变形，上下键逐条看。
   一行九列：状态点、时间、客户端、域名、类型、去向（上游组 · 定下它的规则）、回答、来源、耗时；数字等宽对齐，隔行浅底。
   列宽按内容排，表格变窄时先收起来源，再收回答，再把类型并进域名一格；每一档的断点都在这一组列放得下的宽度上，耗时一列不会被挤出去。
   手机一条两行，点开从底边升起整屏详情。
   The query log follows Surge's request list: one table on top; a selected row opens its detail under the table (the prototype also has
   a beside-the-table version); the table keeps its shape and the arrow keys step through rows. Nine columns: status dot, time, client,
   domain, type, destination (group · the rule that decided), answer, source, latency; tabular digits, alternate rows tinted. Columns
   are sized by their content; as the table narrows the source column folds first, then the answer, then the type joins the domain
   cell. Each band switches where its column set still fits, so the latency column is never pushed out. On phones an entry is two lines
   and opening one raises a full sheet from the bottom. */
.logs-page .qlog-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
/* 键盘逐条往上时，选中的行停在吸顶的表头下面，不被它盖住 / Stepping up with the keyboard parks the selected row below the sticky head, not under it */
.logs-page .qlog-stream { position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; overflow: auto; container-type: inline-size; scroll-padding-top: calc(var(--h-md) + 1px); font-family: var(--f-body); }
.logs-page .qlog-head, .logs-page .qlog-row { display: grid; grid-template-columns: var(--size-dot) 4.25rem 7.25rem minmax(9rem, 1.6fr) 3rem minmax(8rem, 1fr) minmax(8.5rem, 1fr) minmax(8rem, .8fr) 3.75rem; column-gap: var(--s-4); align-items: center; padding: 0 var(--s-5); }
.logs-page .qlog-head { position: sticky; top: 0; z-index: 2; min-height: var(--h-md); border-bottom: 1px solid var(--l-hair); background: var(--l-surface); }
@container (max-width: 1100px) {
  .logs-page .qlog-head, .logs-page .qlog-row { grid-template-columns: var(--size-dot) 4.25rem 7.25rem minmax(9rem, 1.6fr) 3rem minmax(8rem, 1.1fr) minmax(8.5rem, 1fr) 3.75rem; }
  .logs-page .qlog-stream:not(.is-one-client) .qlog-c-source { display: none; }
}
@container (max-width: 900px) {
  .logs-page .qlog-head, .logs-page .qlog-row { grid-template-columns: var(--size-dot) 4.25rem 7.25rem minmax(8rem, 1.6fr) 3rem minmax(7.5rem, 1fr) 3.75rem; }
  .logs-page .qlog-stream:not(.is-one-client) .qlog-c-answer { display: none; }
}
/* 再窄：类型并进域名一格（和手机一样），时间、客户端收窄 / Narrower still: the type joins the domain cell (as on phones), time and client narrow */
@container (max-width: 700px) {
  .logs-page .qlog-head, .logs-page .qlog-row { grid-template-columns: var(--size-dot) 3.5rem 6rem minmax(0, 1.25fr) minmax(0, 1fr) 3.75rem; column-gap: var(--s-3); }
  .logs-page :is(.qlog-c-type, .qlog-head-type) { display: none; }
  .logs-page .qlog-c-name { display: flex; align-items: baseline; gap: var(--s-2); }
  .logs-page .qlog-c-name > .qlog-lit { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .logs-page .qlog-row .qlog-phone-type { display: inline; flex: 0 0 auto; color: var(--l-ink-3); font-size: var(--t-1); }
}
/* 按客户端筛选时客户端一列每行都一样：收起来，让出的宽度（132）给别的列，来源、回答也晚 132 才收。只管表格：手机的两行不受影响
   Filtered by client, the client column repeats one address: it folds, and the room it frees (132) lets the source and the answer stay
   132 narrower. Tables only: the phone's two-line rows are left alone */
@media (min-width: 641px) {
  .logs-page .qlog-stream.is-one-client :is(.qlog-head, .qlog-row) { grid-template-columns: var(--size-dot) 4.25rem minmax(9rem, 1.6fr) 3rem minmax(8rem, 1fr) minmax(8.5rem, 1fr) minmax(8rem, .8fr) 3.75rem; }
  .logs-page .qlog-stream.is-one-client :is(.qlog-c-client, .qlog-head-client) { display: none; }
  @container (max-width: 968px) {
    .logs-page .qlog-stream.is-one-client :is(.qlog-head, .qlog-row) { grid-template-columns: var(--size-dot) 4.25rem minmax(9rem, 1.6fr) 3rem minmax(8rem, 1.1fr) minmax(8.5rem, 1fr) 3.75rem; }
    .logs-page .qlog-stream.is-one-client .qlog-c-source { display: none; }
  }
  @container (max-width: 768px) {
    .logs-page .qlog-stream.is-one-client :is(.qlog-head, .qlog-row) { grid-template-columns: var(--size-dot) 4.25rem minmax(8rem, 1.6fr) 3rem minmax(7.5rem, 1fr) 3.75rem; }
    .logs-page .qlog-stream.is-one-client .qlog-c-answer { display: none; }
  }
  @container (max-width: 700px) { .logs-page .qlog-stream.is-one-client :is(.qlog-head, .qlog-row) { grid-template-columns: var(--size-dot) 3.5rem minmax(0, 1.25fr) minmax(0, 1fr) 3.75rem; } }
}
.logs-page .qlog-num { text-align: right; }
/* 行：32 高，13 号字，隔行浅底；悬停一档灰，选中是品牌色的浅底加左边一条（隔行的底和选中的底不会混） / Rows: 32 tall, 13px, alternate rows tinted; hover one grey step, selected the accent tint plus a bar on the left (so it never blends with the stripes) */
/* 看不见的行不排版：手机上打开详情时整页重算样式，几百行要几百毫秒。占位高度是内容框的高（不含内边距、边框），也不记上一次量到的：
   转屏以后不留着另一种布局的高度
   Rows out of view skip layout: opening the phone sheet restyles the whole page, which costs hundreds of milliseconds over hundreds of
   rows. The placeholder height is the content box's (without padding or border), and the last measured size is not remembered, so a
   rotation never keeps the other layout's height */
.logs-page .qlog-row { content-visibility: auto; contain-intrinsic-block-size: var(--s-6); }
.logs-page .qlog-row { width: 100%; min-height: var(--s-6); border: 0; background: none; color: var(--l-ink-2); font-family: var(--f-body); font-size: var(--t-3); font-variant-numeric: tabular-nums; line-height: var(--log-line); text-align: left; cursor: pointer; }
.logs-page .qlog-row:nth-child(even of .qlog-row) { background: var(--l-canvas); }
.logs-page .qlog-row.is-selected { background: var(--accent-tint); box-shadow: inset 2px 0 0 var(--accent); }
/* 品牌色浅底上浅一档的灰只有 4.5 上下：选中行里的灰字都提一档 / The lightest grey sits right at 4.5 on the accent tint: in the selected row the greys step up one */
.logs-page .qlog-row.is-selected :is(.qlog-c-time, .qlog-c-type, .qlog-c-rule, .qlog-more-n, .qlog-c-answer.is-muted) { color: var(--l-ink-2); }
.logs-page .qlog-row:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
/* 换了筛选、新的还没读回来：旧的行变淡、点不了 / Filters changed and the new rows not back yet: the old rows fade and cannot be clicked */
/* 吸在顶上的日期行只淡字不淡底：底一淡，下面滚过的行就透出来了 / The sticky date row fades its text, not its ground: a faded ground would show the
   rows scrolling under it */
.logs-page .qlog-stream.is-loading :is(.qlog-row, .qlog-gap, .qlog-day > span) { opacity: .5; pointer-events: none; }
/* 新查询的提示条也吸在顶上：逐行往上时行停在表头和提示条下面 / The new-queries banner sticks too: stepping up parks the row below both the head and the banner */
.logs-page .qlog-stream.has-banner { scroll-padding-top: calc(var(--h-md) * 2 + 1px); }
/* 列表里有日期行（往前翻到了更早的一天）：行还要停在吸住的日期行下面 / With date rows in the list (an earlier day reached), rows also park below the
   stuck date row */
.logs-page .qlog-stream:has(> .qlog-day) { scroll-padding-top: calc(var(--h-md) + var(--s-6) + 1px); }
.logs-page .qlog-stream.has-banner:has(> .qlog-day) { scroll-padding-top: calc(var(--h-md) * 2 + var(--s-6) + 1px); }
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
/* 漏记的一段和日期分隔：和行一样 32 高 / A gap and a date divider: 32 tall like a row */
.logs-page .qlog-gap { display: flex; align-items: center; min-height: var(--s-6); margin: 0; padding: var(--s-1) var(--s-5); background: var(--l-sunk); color: var(--l-ink-2); font-size: var(--t-2); }
/* 日期行吸在表头下面：往前翻到更早的一天时一直看得到是哪天，下一天的日期行上来就把它盖过去。今天的记录上面没有日期行，看今天时什么也不吸
   The date row sticks under the column head: reading an earlier day keeps the day in view until the next day's row slides over it.
   Today's entries have no date row, so nothing sticks while reading today */
.logs-page .qlog-day { position: sticky; top: var(--h-md); z-index: 1; display: flex; align-items: center; min-height: var(--s-6); margin: 0; padding: 0 var(--s-5); border-bottom: 1px solid var(--l-hair); background: var(--l-surface); color: var(--l-ink-3); font-size: var(--t-2); font-weight: var(--w-medium); }
.logs-page .qlog-stream.has-banner > .qlog-day { top: calc(var(--h-md) * 2); }
.logs-page .qlog-more { margin: 0; padding: var(--s-3) var(--s-5); color: var(--l-ink-3); font-size: var(--t-2); }
/* 找到哪儿了、接着找：一行字后面跟按钮，窄了按钮换到下一行 / How far it got and going on: a line of text with the button after it, wrapping on narrow screens */
.logs-page .qlog-stopped { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); }
.logs-page .qlog-stream > .ui-banner { top: var(--h-md); z-index: 2; }
/* 一条也没有（还没找到、没有符合条件的、还没有查询）：说明在整块列表区里上下居中，不贴在顶上 / Nothing listed (none found yet, no
   match, no queries yet): the message sits in the middle of the list area, not stuck to its top */
@media (min-width: 641px) { .logs-page .qlog-stream.is-empty { display: flex; flex-direction: column; justify-content: center; } }

/*
 * 详情在表格下方：页头、页签和四个去处一行、内容。占列表区一半多一点（16rem 到 28rem）：900 高的屏幕上处理过程常见的五步一屏放下，
 * 再长的在里面滚；矮屏至少放下概况
 * The detail under the table: a head, one bar of tabs and four actions, the content. A little over half the list area (16rem to
 * 28rem): on a 900-tall screen the usual five steps fit, longer ones scroll inside; short screens still fit the summary
 */
.logs-page .qlog-pane { flex: 0 0 auto; height: clamp(16rem, 55%, 28rem); min-height: 0; display: flex; flex-direction: column; border-top: 1px solid var(--l-hair); background: var(--l-surface); container: qlog-pane / inline-size; }
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
/* 步骤里的地址只在目录边界的「/」后面断，不在连字符处断 / An address in a step wraps only after a directory 「/」, never at a hyphen */
/* 显示时不拆开的那几段（名字、常用词、句末两个字） / Runs kept whole on display (names, common words, the last two characters) */
.qlog-keep { white-space: nowrap; }
/* 详情窄（侧栏版 861–935、641–700）：三块概况并成一块，四个去处占满一行、两端对齐 / A narrow detail (861–935 and 641–700 with the
   sidebar): the three blocks become one, and the four actions take a full row, flush at both ends */
@container qlog-pane (max-width: 650px) {
  .qlog-facts { grid-template-columns: minmax(0, 1fr); gap: 0; border-radius: var(--r-2); background: var(--l-canvas); }
  .qlog-fact { border-radius: 0; background: none; }
  .qlog-fact + .qlog-fact { border-top: 1px solid var(--l-hair); }
  .qlog-pane__actions { flex: 1 1 100%; justify-content: space-between; margin-inline: calc(var(--s-2) * -1); }
}

/* 筛选标签那一行只占自己的高度：卡片里的 div 默认会被拉伸，列表短时会撑成一大块灰底 / The chip row takes only its own height: a div
   in the card stretches by default, and with a short list it became a tall grey slab */
.logs-page .qlog-filters { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: var(--s-2); padding: var(--s-2) var(--s-5); border-bottom: 1px solid var(--l-hair); }
.logs-page .qlog-filter { display: inline-flex; align-items: center; gap: var(--s-1); padding-left: var(--s-2); border-radius: var(--r-1); background: var(--l-sunk); color: var(--l-ink); font-size: var(--t-2); }
.logs-page .qlog-filter > button { position: relative; display: inline-grid; place-items: center; width: var(--h-sm); height: var(--h-sm); border: 0; border-radius: var(--r-1); background: none; color: var(--l-ink-3); cursor: pointer; }
.logs-page .qlog-dest { flex: 0 1 13rem; min-width: 9rem; }
/* 详情、设置开着时背后的页面不跟着滚 / With the detail sheet or the settings open, the page behind does not scroll */
:root:has(.qlog-sheet[open], .qlog-drawer[open]) { overflow: hidden; }
.qlog-state { padding: var(--s-6) var(--s-5); }
.qlog-settings { display: grid; gap: var(--s-5); }
.qlog-hours, .qlog-mb { max-width: 12rem; }
.qlog-hours > span, .qlog-mb > span { color: var(--l-ink-3); font-size: var(--t-2); }
/* 不记录的域名用组件库的多行框：字是墨色 13 号，焦点只有框自己的一圈 / The ignored domains use the kit's multi-line field: ink at
   13px, with only the field's own focus ring */
.qlog-ignored.ui-input--area textarea { min-height: calc(var(--h-md) * 3 - var(--s-4)); overflow: auto; resize: vertical; }
/* 选项条只占选项那么宽，不拖一截空灰底（手机上照旧占满一行） / The segmented track is as wide as its options, with no empty grey tail (full width on phones as before) */
@media (min-width: 641px) { .qlog-settings .ui-seg { justify-self: start; } }
.qlog-danger { display: grid; justify-items: start; gap: var(--s-1); padding-top: var(--s-4); border-top: 1px solid var(--l-hair); }
.qlog-danger small { color: var(--l-ink-3); font-size: var(--t-1); }
/* 成段的说明从 641 起是 12 号，和上面的提示一样 / Sentences are 12px from 641 up, like the hints above */
@media (min-width: 641px) { .qlog-danger small { font-size: var(--t-2); } }

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
  /* 59 高的行减去上下 8 的内边距和 1 的底边 / A 59-tall row less 8 of padding above and below and its 1px bottom border */
  .logs-page .qlog-row { contain-intrinsic-block-size: 42px; }
  .logs-page .qlog-row:nth-child(even of .qlog-row) { background: none; }
  .logs-page .qlog-row.is-selected { background: var(--accent-tint); box-shadow: none; }
  .logs-page .qlog-dot { grid-area: dot; align-self: center; }
  .logs-page .qlog-c-name { grid-area: name; display: flex; align-items: baseline; gap: var(--s-2); }
  .logs-page .qlog-c-name > .qlog-lit { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  /* 类型小字的行高压成 1：有没有类型，行都是一样高 / The type's line height is 1: rows are one height with or without a type */
  .logs-page .qlog-phone-type { display: inline; flex: 0 0 auto; color: var(--l-ink-3); font-size: var(--t-1); line-height: 1; }
  .logs-page .qlog-c-time { grid-area: time; font-size: var(--t-2); }
  .logs-page .qlog-row > :is(.qlog-c-client, .qlog-c-type, .qlog-c-dest, .qlog-c-answer, .qlog-c-source, .qlog-c-latency) { display: none; }
  .logs-page .qlog-phone { grid-area: phone; display: block; color: var(--l-ink-2); font-size: var(--t-2); }
  .logs-page .qlog-gap, .logs-page .qlog-day, .logs-page .qlog-filters, .logs-page .qlog-more { padding-inline: var(--s-4); }
  /* 漏记的一段折成两行时上下留 8，和行的留白一样 / A gap wrapped onto two lines keeps 8 above and below, like a row */
  .logs-page .qlog-gap { padding-block: var(--s-2); }
  /* 筛选的去掉按钮 30 见方，外面一圈看不见的 44 点按区 / A filter's remove button is 30 square inside an invisible 44 hit area */
  .logs-page .qlog-filter > button::before { position: absolute; inset: calc((var(--h-sm) - var(--h-touch)) / 2); content: ''; }
  .logs-page .qlog-dest { flex: 1 1 100%; order: 1; max-width: none; }
  .logs-page .qlog-stream > .ui-banner { top: var(--app-header-height); }
  .logs-page .qlog-day { top: var(--app-header-height); }
  .logs-page .qlog-stream.has-banner > .qlog-day { top: calc(var(--app-header-height) + var(--h-touch)); }
  .qlog-sheet .pdrawer__panel { height: calc(100% - var(--s-8)); }
  .qlog-sheet__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; display: grid; align-content: start; gap: var(--s-3); padding: var(--s-4); }
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
