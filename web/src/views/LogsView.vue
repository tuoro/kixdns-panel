<script setup lang="ts">
import { CircleAlert, Download, RefreshCw, ScrollText, Search } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { apiRequest } from '../api/client'
import type { AuditEvent, AuditPage, LogEntry, LogsResponse } from '../api/types'
import UiDotText from '../components/ui/UiDotText.vue'
import UiEmpty from '../components/ui/UiEmpty.vue'
import UiNewItemsBanner from '../components/ui/UiNewItemsBanner.vue'
import UiPageHeader from '../components/ui/UiPageHeader.vue'
import UiTabs from '../components/ui/UiTabs.vue'
import { segmentLogMessage } from '../logs'
import { errorMessage } from '../utils'

const entries = ref<LogEntry[]>([])
const auditEvents = ref<AuditEvent[]>([])
type LogMode = 'runtime' | 'audit'
const mode = ref<LogMode>('runtime')
const query = ref('')
const auditQuery = ref('')
const level = ref('all')
const auditCategory = ref('all')
const loading = ref(false)
const requesting = ref(false)
const auditLoading = ref(false)
const auditRequesting = ref(false)
// 读者停在顶部时新日志直接进列表；往下读历史时先攒在 fresh 里，由提示条放进来。
// While the reader sits at the top new lines go straight into the list; once
// they scroll into history the newest page waits in `fresh` behind the banner.
const atTop = ref(true)
const fresh = ref<LogsResponse | null>(null)
const loadError = ref('')
const auditError = ref('')
const auditCursor = ref<number | null>(null)
const runtimeCursor = ref<string | null>(null)
const runtimeStream = ref<HTMLDivElement | null>(null)
const loadingOlder = ref(false)
const notice = ref<string | null>(null)
let timer: number | undefined
let pendingLoad: Promise<void> | null = null
let polling = false
const PAGE_SIZE = 500

// 级别筛选在 journalctl 里做，不在浏览器里：浏览器只看得到已经翻出来的几页，
// 一条老错误在读者滚到它之前都是隐身的，计数也只是「已加载里的几条」。
// 这里只剩文本筛选，它本来就只对已加载的行有意义。
// The level filter runs in journalctl, not here: the browser only sees the
// pages already loaded, so an old error stays hidden until the reader scrolls
// to it and the count means "of what happens to be loaded". Only the text
// filter stays client-side; it only ever meant "of the loaded lines".
const filtered = computed(() => entries.value.filter((entry) => {
  const needle = query.value.toLowerCase()
  return !needle || entry.message.toLowerCase().includes(needle) || entry.source.toLowerCase().includes(needle)
}))
const filteredAudit = computed(() => {
  const needle = auditQuery.value.trim().toLowerCase()
  if (!needle) return auditEvents.value
  return auditEvents.value.filter((event) =>
    event.action.toLowerCase().includes(needle)
    || event.detail.toLowerCase().includes(needle)
    || (event.actor ?? 'system').toLowerCase().includes(needle),
  )
})
// 分段跟着筛选结果算一次；放在模板里会让每次重绘都重新切一遍正文。
const lines = computed(() => filtered.value.map((entry) => ({ entry, segments: segmentLogMessage(entry.message) })))
const activeError = computed(() => mode.value === 'runtime' ? loadError.value : auditError.value)
const activeRequesting = computed(() => mode.value === 'runtime' ? requesting.value : auditRequesting.value)
const activeCount = computed(() => mode.value === 'runtime' ? entries.value.length : auditEvents.value.length)

// 事实行只写数据里有的：这是谁的记录（KixDNS 自己的日志，或面板的操作）、最近一条的时间、
// 已加载这一窗里的错误和警告。不写「已加载 N 条」：浏览器只看得到翻出来的几页，那个数字说明不了日志有多少。
// The facts row states only what the data holds: whose record this is (KixDNS's
// own log, or the panel's operations), the newest line's time, and the errors
// and warnings in the loaded window. Never 「N lines loaded」: the browser only
// sees the pages it has turned, and that number says nothing about how much log
// there is.
const newest = computed(() => {
  if (mode.value === 'runtime') {
    const first = entries.value[0]
    return first === undefined ? null : clock(first.timestamp_unix_micros)
  }
  const first = auditEvents.value[0]
  return first === undefined ? null : auditTimestamp(first.created_at)
})
const levelFacts = computed(() => {
  let errors = 0
  let warnings = 0
  for (const entry of entries.value) {
    if (entry.priority <= 3) errors += 1
    else if (entry.priority === 4) warnings += 1
  }
  const parts: string[] = []
  if (errors > 0) parts.push(`${errors} 错误`)
  if (warnings > 0) parts.push(`${warnings} 警告`)
  return parts
})
// 首屏还没回来时页头和列表都放骨架；之后事实行一直在，换页签时跟着换。
// A skeleton in the header and the list until the first page lands; after that
// the facts stay and follow the tab.
const skeletonRuntime = computed(() => loading.value && entries.value.length === 0)
const skeletonAudit = computed(() => auditLoading.value && auditEvents.value.length === 0)
const factsReady = computed(() => mode.value === 'runtime' ? !skeletonRuntime.value : !skeletonAudit.value)
const runtimeFiltered = computed(() => query.value !== '' || level.value !== 'all')
const auditFiltered = computed(() => auditQuery.value !== '' || auditCategory.value !== 'all')
// 读取失败且一行都没有：卡片收成只剩工具行。原因和重试都在上面的提示里，列表里不再说一遍。
// A load failure with no rows at all: the card shrinks to its toolbar. The
// reason and the retry sit in the notice above, and the list does not repeat them.
const blank = computed(() => activeError.value !== '' && activeCount.value === 0)

function sameEntry(left: LogEntry, right: LogEntry): boolean {
  return left.timestamp_unix_micros === right.timestamp_unix_micros
    && left.priority === right.priority
    && left.source === right.source
    && left.message === right.message
}

// 新行数 = 最新一页里排在当前第一行之前的那些。当前第一行不在这一页里，说明
// 新来的超过一整页（或日志被轮转掉了），这时不假装知道确切数目。
// New lines are those in the newest page ahead of the current first line. If
// that line is not in the page, more than a page has arrived (or the journal
// rotated it away), and the banner does not pretend to know the exact count.
const newLinesLabel = computed(() => {
  const page = fresh.value
  if (page === null) return null
  const first = entries.value[0]
  const index = first === undefined ? page.entries.length : page.entries.findIndex((entry) => sameEntry(entry, first))
  if (index === 0) return null
  if (index > 0) return `有 ${index} 条新日志，点击显示`
  return page.entries.length >= PAGE_SIZE ? `有 ${PAGE_SIZE} 条以上新日志，点击显示` : '有新日志，点击显示'
})

const auditOptions = [
  { value: 'all', label: '全部' },
  { value: 'config.', label: '配置' },
  { value: 'service.', label: '服务' },
  { value: 'kixdns.', label: 'KixDNS' },
  { value: 'auth.', label: '认证' },
  { value: 'diagnostic.', label: '诊断' },
]

const viewItems = [
  { value: 'runtime', label: '运行日志' },
  { value: 'audit', label: '操作审计' },
]
// 审计记录在取的时候类别不能切：切了也只会被正在回来的那页盖掉 / Categories cannot change while a page is being fetched: the page on its way would overwrite the switch
const auditItems = computed(() => auditOptions.map((option) => ({ ...option, disabled: auditRequesting.value })))

const levelOptions = [
  { value: 'all', label: '全部' },
  { value: 'error', label: '错误' },
  { value: 'warning', label: '警告' },
  { value: 'info', label: '信息' },
]

function label(priority: number): string {
  if (priority <= 3) return '错误'
  if (priority === 4) return '警告'
  return '信息'
}

// 级别落在行上：行首一个点，错误和警告的行另有极淡的底色。
// 徽章在密集列表里是噪音，一列点能一眼扫下来。
// The level sits on the row: a dot at its start, and error and warning rows
// carry a faint tint. Badges are noise in a dense list; a column of dots scans.
function levelClass(priority: number): string {
  return priority <= 3 ? 'log-line--error' : priority === 4 ? 'log-line--warning' : 'log-line--info'
}
function levelDot(priority: number): string {
  return priority <= 3 ? 'ui-dot--err' : priority === 4 ? 'ui-dot--warn' : 'ui-dot--off'
}

// 审计只用动作名尾巴上的 _failed 记一次失败（kixdns.kernel.replace_release_failed）；
// 别的行都是做成了的事，不另标「成功」。
// The audit records a failure only through an action name ending in _failed
// (kixdns.kernel.replace_release_failed); every other row is a thing that was
// done, and gets no 成功 tag.
function failed(action: string): boolean {
  return action.endsWith('_failed')
}

function timestamp(microseconds: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false }).format(new Date(microseconds / 1000))
}

// 事实行里的时间到秒就够了，毫秒留给行 / The facts row needs the time to the second; milliseconds stay on the rows
function clock(microseconds: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(microseconds / 1000))
}

function auditTimestamp(seconds: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(seconds * 1000))
}

function load(silent = false): Promise<void> {
  if (pendingLoad) return pendingLoad
  if (!silent) loading.value = true
  requesting.value = true
  // 请求发出后级别又被切了的话，回来的这页属于旧级别，丢掉；watch 会紧接着再取一次。
  // If the level changes while this request is in flight, the page that comes
  // back belongs to the old level: drop it, the watcher fetches again right after.
  const requestedLevel = level.value
  pendingLoad = (async () => {
    const page = await apiRequest<LogsResponse>(`/api/v1/logs?${logsParameters()}`)
    if (requestedLevel !== level.value) return
    entries.value = page.entries
    runtimeCursor.value = page.next_cursor
    notice.value = page.notice
    fresh.value = null
    loadError.value = ''
    await nextTick()
    if (runtimeStream.value) runtimeStream.value.scrollTop = 0
  })().catch((error: unknown) => {
    loadError.value = errorMessage(error)
  }).finally(() => {
    requesting.value = false
    pendingLoad = null
    loading.value = false
  })
  return pendingLoad
}

function logsParameters(before?: string): URLSearchParams {
  const parameters = new URLSearchParams({ limit: String(PAGE_SIZE) })
  if (before !== undefined) parameters.set('before', before)
  if (level.value !== 'all') parameters.set('level', level.value)
  return parameters
}

async function loadOlder(): Promise<void> {
  // 首屏还在飞就不翻页：旧一页被丢弃时 finally 已经把 requesting 放开了，
  // 只看它会拿着旧级别的游标去翻新级别的页。
  // No older page while a first page is in flight: a discarded stale page has
  // already released `requesting` in its finally, and that guard alone would
  // let a scroll page the new level with the old level's cursor.
  if (requesting.value || pendingLoad !== null || runtimeCursor.value === null) return
  requesting.value = true
  loadingOlder.value = true
  const requestedLevel = level.value
  try {
    const page = await apiRequest<LogsResponse>(`/api/v1/logs?${logsParameters(runtimeCursor.value)}`)
    if (requestedLevel !== level.value) return
    entries.value = [...entries.value, ...page.entries]
    runtimeCursor.value = page.next_cursor
    loadError.value = ''
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    requesting.value = false
    loadingOlder.value = false
  }
}

// 切级别就是换一个 journalctl 查询，已加载的行和游标都作废，从头取。
// 游标当场清掉：新首屏回来之前它属于旧级别，留着会被滚动翻页拿去用。
// 正在飞的那次请求先让它落地，否则 load() 的去重会把这次切换吞掉。
// Switching level means a different journalctl query: the loaded lines and the
// cursor are void, fetch from the top. The cursor is cleared right here: until
// the new first page lands it belongs to the old level, and a scroll would page
// with it. Let an in-flight request land first, or load()'s de-duplication
// would swallow this switch.
watch(level, () => {
  runtimeCursor.value = null
  fresh.value = null
  void (pendingLoad ?? Promise.resolve()).then(() => load())
})

function handleRuntimeScroll(event: Event): void {
  const stream = event.currentTarget as HTMLDivElement
  atTop.value = stream.scrollTop <= 24
  const remaining = stream.scrollHeight - stream.scrollTop - stream.clientHeight
  if (remaining <= 96 && runtimeCursor.value !== null && !requesting.value) void loadOlder()
}

// 每 5 秒取一次最新一页。停在顶部就直接换上；在读历史就只留着，不动读者眼前
// 的列表，也不丢掉已经翻出来的更早日志。
// Every five seconds, fetch the newest page. At the top it replaces the list;
// in history it is only kept, so neither the lines in front of the reader nor
// the older pages already loaded are disturbed.
async function poll(): Promise<void> {
  if (mode.value !== 'runtime' || polling || requesting.value || pendingLoad !== null) return
  if (atTop.value) {
    await load(true)
    return
  }
  polling = true
  const requestedLevel = level.value
  try {
    const page = await apiRequest<LogsResponse>(`/api/v1/logs?${logsParameters()}`)
    if (requestedLevel === level.value) fresh.value = page
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    polling = false
  }
}

function showNewLines(): void {
  void load()
}

async function loadAudit(reset = true): Promise<void> {
  if (auditRequesting.value) return
  auditRequesting.value = true
  auditLoading.value = true
  try {
    const parameters = new URLSearchParams({ limit: '100' })
    if (!reset && auditCursor.value !== null) parameters.set('before_id', String(auditCursor.value))
    if (auditCategory.value !== 'all') parameters.set('action_prefix', auditCategory.value)
    const page = await apiRequest<AuditPage>(`/api/v1/audit?${parameters}`)
    auditEvents.value = reset ? page.events : [...auditEvents.value, ...page.events]
    auditCursor.value = page.next_cursor
    auditError.value = ''
  } catch (error) {
    auditError.value = errorMessage(error)
  } finally {
    auditRequesting.value = false
    auditLoading.value = false
  }
}

function switchMode(next: LogMode): void {
  mode.value = next
  if (next === 'audit' && auditEvents.value.length === 0) void loadAudit()
}

function selectAuditCategory(value: string): void {
  if (auditCategory.value === value) return
  auditCategory.value = value
  void loadAudit()
}

function retry(): void {
  if (mode.value === 'runtime') void load()
  else void loadAudit()
}

function download(): void {
  const content = mode.value === 'runtime'
    ? filtered.value.map((entry) => `${timestamp(entry.timestamp_unix_micros)} [${label(entry.priority)}] ${entry.source}: ${entry.message}`).join('\n')
    : filteredAudit.value.map((event) => `${auditTimestamp(event.created_at)} [${event.actor ?? 'system'}] ${event.action}: ${event.detail}`).join('\n')
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `kixdns-${mode.value}-${new Date().toISOString().slice(0, 10)}.log`
  anchor.click()
  URL.revokeObjectURL(url)
}

onMounted(async () => {
  await load()
  timer = window.setInterval(() => { void poll() }, 5000)
})
onBeforeUnmount(() => window.clearInterval(timer))
</script>

<template>
  <div class="page logs-page">
    <!-- 页头：标题下面一排事实（来源、最近一条、级别），都是数据里有的；首屏没回来时是一条骨架
         The header: a row of facts under the title (source, newest line, levels), all from the data; a skeleton bar until the first page lands -->
    <UiPageHeader title="日志">
      <template #meta>
        <div v-if="factsReady" class="ui-facts logs-facts">
          <div><span class="ui-lbl">来源</span><b>{{ mode === 'audit' ? '面板' : 'kixdns' }}</b></div>
          <div><span class="ui-lbl">最近一条</span><b>{{ newest ?? '—' }}</b></div>
          <div v-if="mode === 'runtime'"><span class="ui-lbl">级别</span><b><UiDotText v-if="levelFacts.length" :parts="levelFacts" /><template v-else>{{ entries.length ? '无' : '—' }}</template></b></div>
        </div>
        <span v-else class="sk logs-skeleton-meta" role="status" aria-label="读取日志"></span>
      </template>
    </UiPageHeader>
    <!-- 页签在卡片外面，和概览、配置同一种区块页签；查询日志做好后排在最前面
         The tabs sit outside the card, the same section tabs as overview and config; the query log goes first once it exists -->
    <UiTabs :model-value="mode" :items="viewItems" label="日志视图" id-prefix="logs" @update:model-value="switchMode($event as LogMode)" />
    <!-- 读取失败：和概览一样一条提示——结论、原因、一个重试；已有行的话只说可能过期
         A load failure is one notice as on the overview: the verdict, the reason, one retry; with rows on screen it only says they may be stale -->
    <div v-if="activeError" class="ui-notice ui-notice--err logs-notice" role="alert">
      <CircleAlert :size="16" aria-hidden="true" />
      <span>{{ activeCount > 0 ? '数据可能已过期' : '读取失败' }}</span>
      <small>{{ activeError }}</small>
      <button class="ui-btn ui-btn--secondary ui-btn--sm ui-notice__action" type="button" :disabled="activeRequesting" @click="retry">重试</button>
    </div>
    <!-- 一张白卡：第一行是工具行，下面是列名和自己滚动的行；整页不滚
         One white card: the toolbar is its first row, then the column names and the rows, which scroll on their own; the page never does -->
    <section :id="`logs-panel-${mode}`" class="log-console ui-card" :class="{ 'log-console--blank': blank }" role="tabpanel" :aria-labelledby="`logs-tab-${mode}`">
      <!-- 工具行：搜索框、筛选分段、右端的图标按钮；手机上分段独占第二行
           The toolbar: search, the filter segment, icon buttons at the right end; on a phone the segment takes its own second row -->
      <header v-if="mode === 'runtime'" class="log-toolbar">
        <label class="ui-input log-search"><Search :size="16" aria-hidden="true" /><input v-model="query" aria-label="筛选日志" placeholder="筛选消息或来源" /></label>
        <UiTabs class="log-category-seg" v-model="level" :items="levelOptions" label="日志级别" variant="segment" />
        <!-- 运行日志没有刷新键，也没有实时开关。停在顶部时新日志每 5 秒自己进来；
             往下读历史时它们攒在列表上方的提示条里，点一下才放进来并回到顶部。
             刷新键在这两种情况下都换不来任何东西。

             The runtime log has neither a refresh button nor a live switch. At
             the top new lines arrive on their own every five seconds; in history
             they wait in the banner above the list and come in, back at the top,
             when it is pressed. A refresh button would buy nothing in either case. -->
        <div class="log-toolbar__end">
          <button class="ui-btn ui-btn--secondary ui-btn--icon" type="button" title="下载筛选结果" aria-label="下载筛选结果" :disabled="filtered.length === 0" @click="download"><Download :size="16" aria-hidden="true" /></button>
        </div>
      </header>
      <header v-else class="log-toolbar">
        <label class="ui-input log-search"><Search :size="16" aria-hidden="true" /><input v-model="auditQuery" aria-label="筛选操作审计" placeholder="筛选操作者、动作或详情" /></label>
        <!-- 六个类别在手机上排成三列两行，和运行日志一样留在第二行 / The six categories go three by two on a phone, on the second row like the runtime levels -->
        <UiTabs class="log-category-seg" :model-value="auditCategory" :items="auditItems" label="审计动作类别" variant="segment" @update:model-value="selectAuditCategory" />
        <div class="log-toolbar__end">
          <button class="ui-btn ui-btn--secondary ui-btn--icon" type="button" title="刷新审计记录" aria-label="刷新审计记录" :disabled="auditRequesting" @click="loadAudit()"><RefreshCw :size="16" :class="{ spin: auditLoading }" aria-hidden="true" /></button>
          <button class="ui-btn ui-btn--secondary ui-btn--icon" type="button" title="下载筛选结果" aria-label="下载筛选结果" :disabled="filteredAudit.length === 0" @click="download"><Download :size="16" aria-hidden="true" /></button>
        </div>
      </header>
      <!-- 常驻、不是错误：日志页本身没坏，是 journald 看不到这个 unit 的输出——
           unit 不存在，或它的输出没送到 journald。句子由服务端拼好，原样展示；
           不提示的话页面看着一切正常，只是永远没有 KixDNS 自己的一行。
           Persistent and not an error: the page is not broken, journald simply
           cannot see this unit's output — the unit is missing, or its output
           never reaches journald. The sentence is composed server-side and shown
           verbatim; without it the page looks fine and just never shows a line
           from KixDNS itself. -->
      <p v-if="mode === 'runtime' && notice !== null" class="log-notice" role="status">{{ notice }}</p>
      <div v-if="mode === 'runtime'" ref="runtimeStream" class="log-stream" @scroll="handleRuntimeScroll">
        <!-- 列名钉在列表顶上，宽屏才有；行首的点是级别，读屏念的是文字 / Column names pinned to the top of the list on wide screens only; the dot at a row's start is its level, read aloud as a word -->
        <div v-if="skeletonRuntime || lines.length" class="log-head log-head--runtime" aria-hidden="true"><span class="ui-lbl">时间</span><span class="ui-lbl">来源</span><span class="ui-lbl">消息</span></div>
        <UiNewItemsBanner v-if="newLinesLabel !== null" :label="newLinesLabel" :loading="loading" :disabled="requesting" @show="showNewLines" />
        <div v-if="skeletonRuntime" class="log-skeleton" role="status" aria-label="正在读取日志"><i v-for="n in 12" :key="n" class="sk"></i></div>
        <template v-else>
          <div v-for="({ entry, segments }, index) in lines" :key="`${entry.timestamp_unix_micros}-${index}`" class="log-line" :class="levelClass(entry.priority)">
            <i class="ui-dot" :class="levelDot(entry.priority)" aria-hidden="true"></i>
            <span class="log-sr-only">{{ label(entry.priority) }}</span>
            <time>{{ timestamp(entry.timestamp_unix_micros) }}</time>
            <strong>{{ entry.source }}</strong>
            <!-- 消息最重、键最轻、值居中：先读出发生了什么 / The message is the heaviest, keys the lightest, values in between, so what happened reads first -->
            <p><template v-for="(segment, part) in segments" :key="part"><em v-if="segment.strong">{{ segment.text }}</em><i v-else-if="segment.text.endsWith('=')" class="log-key">{{ segment.text }}</i><template v-else>{{ segment.text }}</template></template></p>
          </div>
          <button v-if="runtimeCursor !== null" class="log-more" type="button" :disabled="requesting" @click="loadOlder"><RefreshCw :size="14" :class="{ spin: loadingOlder }" aria-hidden="true" />{{ loadingOlder ? '正在加载' : '加载更早日志' }}</button>
          <UiEmpty v-if="filtered.length === 0 && !loadError" :icon="ScrollText" title="没有符合条件的日志" :desc="runtimeFiltered ? '清空搜索，或把级别切回「全部」' : undefined" />
        </template>
      </div>
      <div v-else class="log-stream">
        <!-- 宽屏上四列有列名，读起来是一张表而不是一堆原始文本 / On wide screens the four columns are named, so it reads as a table rather than a raw dump -->
        <div v-if="skeletonAudit || filteredAudit.length" class="log-head log-head--audit" aria-hidden="true"><span class="ui-lbl">时间</span><span class="ui-lbl">操作者</span><span class="ui-lbl">动作</span><span class="ui-lbl">详情</span></div>
        <div v-if="skeletonAudit" class="log-skeleton" role="status" aria-label="正在读取审计记录"><i v-for="n in 6" :key="n" class="sk"></i></div>
        <template v-else>
          <div v-for="event in filteredAudit" :key="event.id" class="log-line audit-line">
            <time>{{ auditTimestamp(event.created_at) }}</time><strong>{{ event.actor ?? 'system' }}</strong><code>{{ event.action }}</code><p><span v-if="failed(event.action)" class="ui-tag ui-tag--err">失败</span>{{ event.detail }}</p>
          </div>
          <button v-if="auditCursor !== null && !auditQuery" class="log-more" type="button" :disabled="auditRequesting" @click="loadAudit(false)"><RefreshCw :size="14" :class="{ spin: auditLoading }" aria-hidden="true" />加载更多</button>
          <UiEmpty v-if="filteredAudit.length === 0 && !auditError" :icon="ScrollText" title="没有符合条件的审计记录" :desc="auditFiltered ? '清空搜索，或把类别切回「全部」' : undefined" />
        </template>
      </div>
    </section>
  </div>
</template>

<style>
/* 日志页（商业版，标杆 Surge 的请求表）：页头下一排事实；一张白卡，第一行是工具行，下面是列名和密排的行；
   级别是行首的一个点，错误和警告的行另有极淡的底色；手机上一条记录两行字。
   这一块只覆盖 styles.css 里旧的 .log-* 规则（落地时再清），每条选择器都以 .logs-page 开头，组件页的日志样例不受影响。
   The logs page (commercial direction, benchmark Surge's request table): a row of facts under the title; one white card whose
   first row is the toolbar, then column names and dense rows; the level is a dot at the row's start, and error and warning
   rows carry a faint tint; on a phone each entry is two lines. This block only overrides the old .log-* rules in styles.css
   (cleaned up at landing); every selector starts with .logs-page, so the kit page's log sample is untouched. */
.logs-page { --log-line: calc(var(--s-5) - var(--s-1)); }  /* 行里一行字的行高 20 / one line of text in a row: 20 */
/* 侧栏壳里内容区上下是 32 和 48，没有顶栏要扣 / In the sidebar shell the content area has 32 above and 48 below, and no top bar to subtract */
@media (min-width: 861px) { .logs-page { height: calc(100dvh - var(--s-6) - var(--s-7)); } }

/* 页头事实行：标签在上、值在下，和概览同一种 / The header facts: label over value, as on the overview */
.logs-page .logs-facts { flex: 1 1 100%; margin-top: var(--s-1); }
.logs-page .logs-skeleton-meta { display: inline-block; width: 16rem; height: calc(var(--t-4) * var(--lh-base)); }

/* 卡片：白、圆角 14、浮在底色上；工具行是第一行，底下一条细线 / The card: white, radius 14, floating on the ground; the toolbar is its first row with a hairline below */
.logs-page .log-console { overflow: hidden; gap: 0; border: 0; border-radius: var(--r-3); background: var(--l-surface); box-shadow: var(--shadow-card); }
.logs-page .log-console > .log-toolbar { padding: var(--s-3) var(--s-5); border-bottom: 1px solid var(--l-hair); background: var(--l-surface); }
.logs-page .log-toolbar__end { display: flex; align-items: center; gap: var(--s-2); margin-left: auto; }
.logs-page .log-search { flex: 0 1 22rem; min-width: 10rem; max-width: 22rem; }
.logs-page .log-console > .log-notice { margin: 0; padding: var(--s-2) var(--s-5); border: 0; border-bottom: 1px solid var(--l-hair); border-radius: 0; }
.logs-page .log-console > .log-stream { padding: 0; border: 0; border-radius: 0; background: var(--l-surface); }
.logs-page .log-console:has(.audit-line) > .log-stream { padding-bottom: 0; }
/* 读取失败且一行都没有：卡片只剩工具行，不留一大块空白 / A failure with no rows: the card keeps only its toolbar, no blank slab */
.logs-page .log-console--blank { flex: 0 0 auto; }
.logs-page .log-console--blank > .log-toolbar { border-bottom: 0; }
.logs-page .log-console--blank > .log-stream { display: none; }

/* 列名行：钉在列表顶上，30 高，小标签字；新日志提示条贴在它下面 / The column-name row: pinned to the top of the list, 30 tall, in the small-label face; the new-lines banner sticks just below it */
.logs-page .log-head { position: sticky; top: 0; z-index: 1; display: grid; align-items: center; min-height: var(--h-md); padding: 0 var(--s-5); border-bottom: 1px solid var(--l-hair); background: var(--l-surface); font-family: var(--f-body); }
.logs-page .log-stream > .ui-banner { top: var(--h-md); }
.logs-page .log-head--runtime, .logs-page .log-line:not(.audit-line) { grid-template-columns: 100px 5rem minmax(0, 1fr); column-gap: var(--s-4); }

/* 行：13 号字一行 20，上下各 4，行间一条细线；级别点落在左边 24 的内边里，文字和工具行同一条左边
   Rows: 13px text on a 20 line, 4 above and below, a hairline between rows; the level dot sits inside the 24 inset on the left, so the text shares the toolbar's edge */
.logs-page .log-line { position: relative; min-width: 0; align-items: baseline; padding: var(--s-1) var(--s-5); border-bottom: 1px solid var(--l-hair); font-size: var(--t-3); line-height: var(--log-line); }
.logs-page .log-line:not(.audit-line) { padding: var(--s-1) var(--s-5); line-height: var(--log-line); }
.logs-page .log-line:last-child { border-bottom: 0; }
.logs-page .log-line > .ui-dot { position: absolute; top: calc(var(--s-2) + 2px); left: calc((var(--s-5) - var(--size-dot)) / 2); }
.logs-page .log-line time { color: var(--l-ink-3); font-variant-numeric: tabular-nums; }
.logs-page .log-line strong { color: var(--l-ink-2); font-size: inherit; font-weight: var(--w-normal); }
.logs-page .log-line p { margin: 0; color: var(--l-ink); }
.logs-page .log-line p .log-key { color: var(--l-ink-3); }
.logs-page .log-line p em { color: var(--l-ink-2); font-weight: var(--w-normal); }
/* 色条交给点；底色留着 / The bar hands over to the dot; the tint stays */
.logs-page .log-line--warning::before, .logs-page .log-line--error::before { content: none; }
.logs-page .log-console > .log-stream > .log-line:first-child { border-radius: 0; }
.logs-page .log-more { min-height: var(--h-touch); border-top: 0; color: var(--l-ink-2); font-size: var(--t-2); }
.logs-page .log-skeleton { display: grid; gap: var(--s-2); padding: var(--s-3) var(--s-5); }
.logs-page .log-skeleton > .sk { height: var(--log-line); }

/* 审计：时间、操作者是正文字体的读数，动作是等宽键，详情一档浅；失败只在动作名以 _failed 结尾时标
   Audit: time and operator are body-face readings, the action a mono key, the detail one step lighter; 失败 only on an action ending in _failed */
@media (min-width: 641px) {
  .logs-page .log-head--audit, .logs-page .audit-line { grid-template-columns: 128px 88px 14rem minmax(0, 1fr); column-gap: var(--s-5); }
  .logs-page .audit-line { min-height: 0; align-items: baseline; align-content: start; padding: var(--s-2) var(--s-5); }
  .logs-page .audit-line time, .logs-page .audit-line strong { font-family: var(--f-body); font-size: var(--t-3); }
  .logs-page .audit-line code { color: var(--l-ink); font-size: var(--t-2); }
  .logs-page .audit-line p { display: flex; align-items: center; gap: var(--s-2); color: var(--l-ink-2); font-size: var(--t-3); }
}

/* 手机：工具行第一行搜索加图标按钮、第二行分段（六个类别三列两行）；没有列名行；
   运行日志一条两行：时间、来源、行尾的级别点，然后消息；审计一条两行：动作和时间，然后「操作者 · 详情」
   Phones: the toolbar's first row is search plus icon buttons, the second the segment (six categories three by two); no column-name row;
   a runtime entry is two lines: time, source and the level dot at the line's end, then the message; an audit entry is two lines: action and time, then 「operator · detail」 */
@media (max-width: 640px) {
  .logs-page .log-console > .log-toolbar { flex-wrap: wrap; padding: var(--s-3) var(--s-4); }
  .logs-page .log-search { flex: 1 1 0; min-width: 0; max-width: none; }
  .logs-page .log-console > .log-toolbar > .ui-seg.log-category-seg { display: flex; order: 1; flex: 1 1 100%; }
  .logs-page .log-console > .log-toolbar > .ui-seg.log-category-seg:has(> :nth-child(6)) { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .logs-page .log-console > .log-notice { padding-inline: var(--s-4); }
  .logs-page .log-head { display: none; }
  .logs-page .log-stream > .ui-banner { top: 0; }
  .logs-page .log-line:not(.audit-line) { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "time src dot" "msg msg msg"; align-items: center; gap: 0 var(--s-2); padding: var(--s-2) var(--s-4); }
  .logs-page .log-line:not(.audit-line) > time { grid-area: time; font-size: var(--t-2); }
  .logs-page .log-line:not(.audit-line) > strong { grid-area: src; font-size: var(--t-2); }
  .logs-page .log-line:not(.audit-line) > .ui-dot { position: static; grid-area: dot; justify-self: end; }
  .logs-page .log-line:not(.audit-line) > p { grid-area: msg; }
  .logs-page .audit-line { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "code code time" "actor detail detail"; gap: 0; padding: var(--s-2) var(--s-4); }
  .logs-page .audit-line time { grid-area: time; padding-left: var(--s-3); font-size: var(--t-2); }
  .logs-page .audit-line code { grid-area: code; font-size: var(--t-2); }
  .logs-page .audit-line strong { grid-area: actor; color: var(--l-ink-3); font-size: var(--t-2); }
  .logs-page .audit-line p { grid-area: detail; color: var(--l-ink-2); font-size: var(--t-2); }
  .logs-page .audit-line p > .ui-tag { margin-right: var(--s-2); vertical-align: text-bottom; }
  .logs-page .log-skeleton { padding-inline: var(--s-4); }
  .logs-page .log-skeleton > .sk { height: calc(var(--log-line) * 2); }
  .logs-page .logs-facts { gap: var(--s-3) var(--s-5); }
  .logs-page .logs-facts > div { flex: 0 0 calc(50% - var(--s-5) / 2); }
}
</style>
