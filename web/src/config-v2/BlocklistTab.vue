<script setup lang="ts">
import { ExternalLink, ListPlus, Plus, RefreshCw, ShieldBan, TriangleAlert, X } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { BlocklistSkippedLine } from '../api/types'
import UiDotText from '../components/ui/UiDotText.vue'
import UiEmpty from '../components/ui/UiEmpty.vue'
import UiHelp from '../components/ui/UiHelp.vue'
import UiMenu from '../components/ui/UiMenu.vue'
import UiSelect from '../components/ui/UiSelect.vue'
import { useSession } from '../composables/useSession'
import { useToast } from '../composables/useToast'
import { checkSubscriptionUrl, MAX_SUBSCRIPTIONS, normalUrl, parseOwnRules, PRESETS, shortName, skipText, uniqueSubscriptionName, type Skip } from '../config-model/blocklist'
import { blockLabel, type Subscription } from '../config-model/model'
import { formatAgo, formatVersionTime } from '../utils'
import GlueText from './GlueText.vue'
import { usePhone } from './phone'
import { appliedModel, changedSubscriptionIds, draftGeneration, model, newId, placeBack } from './store'
import { blocklists, loadBlocklists, rebuildBlocklists, saveBlocklistSchedule, sayDrafted } from './useBlocklists'
import { carryUpdate, noteLanded } from './updateCarry'
import { fmtCount } from './view'

// 拦截列表：订阅的列表一行一个，像域名映射那样一张卡片；下面是自己写的规则和两项设置。订阅和自己写的规则都在草稿里，
// 保存以后生效；列表下载、合并由面板服务端做，自动更新也在服务端。订阅一变，useBlocklists 就请服务端重新合成。
// Blocklists: one subscribed list per row, a card like the mapping list; under it the rules of one's own and two settings.
// Subscriptions and own rules live in the draft and take effect on save; the panel server downloads, merges and updates the lists.
// Whenever the subscriptions change, useBlocklists asks the server to build again.
const router = useRouter()
const phone = usePhone()
const toast = useToast()
const session = useSession()
onMounted(() => void loadBlocklists())

const subscriptions = computed(() => model.blocklists.subscriptions)
const host = (url: string) => { try { return new URL(url).host } catch { return url } }
const presetOf = (s: Subscription) => PRESETS.find((p) => p.url === s.url)
// 「内容」列：推荐的列表写它拦什么；自己粘贴的补上名字里没有的：名字是标题时，写链接的最后两段在前、主机在后（和默认名「文件名 · 主机」一个写法），
// 截短时截掉的是大家一样的主机，能区分各行的尾巴留着；名字里已经有主机时（默认名），和窄屏名字下面那行一样只写目录，没有目录写「—」。完整的链接在悬停提示里
// The 内容 column: what a suggested list blocks; for a pasted one, what its name leaves out: under a title, the link's last two segments first and the
// host after (as the default 「file name · host」 name reads), so cutting short drops the host all rows share and keeps the tail that tells them
// apart; once the name holds the host (a default name), only the directory, as under the name on narrow screens, or — without one. The whole link is
// in the hover tip
const link = (s: Subscription) => s.url.replace(/^https:\/\//, '')
function about(s: Subscription): string {
  const preset = presetOf(s)
  if (preset) return preset.about
  if (s.name.includes(host(s.url))) return source(s) || '—'
  try {
    const url = new URL(s.url)
    const tail = url.pathname.split('/').filter(Boolean).slice(-2).join('/')
    return tail ? `${decodeURI(tail)}\u00a0·\u00a0${url.host}` : url.host
  } catch { return link(s) }
}
// 窄屏名字下面的来源：主机名；名字里已经有主机名时写完整的目录，只有一级文件名、或者没有路径时不写。同名时名字里带了几级目录也照样写完整的：
// 这一列（和「内容」列）的意思不随行变，永远是「它在哪个目录」，同名的几行差在哪里一眼对得上
// The source under the name on narrow screens: the host; once the name holds the host, the whole directory, or nothing for a bare file name or no path.
// A default name made unique with some directories still gets the whole directory: the column (and 内容) always means 「which directory it is in」, so
// same-named rows differ where the eye looks
function source(s: Subscription): string {
  const name = host(s.url)
  if (!s.name.includes(name)) return name
  try {
    const url = new URL(s.url)
    const path = decodeURI(url.pathname)
    const dir = path.slice(0, path.lastIndexOf('/') + 1)
    // 链接带查询串、名字里又没写的，跟在目录后面：只差查询串的两个列表也分得开 / A query string the name leaves out follows the directory, so two lists
    // differing only by it can be told apart
    let query = url.search
    try { query = decodeURIComponent(query) } catch { /* 写坏的百分号转义照原样用 / a malformed percent escape is used as written */ }
    return `${dir === '/' ? '' : dir}${query && !s.name.includes(query) ? query : ''}`
  } catch { return '' }
}
const statusOf = (s: Subscription) => blocklists.sources[s.url]
const held = (s: Subscription) => Boolean(statusOf(s)?.sha256)
const downloading = (s: Subscription) => blocklists.downloading.has(s.url)
// 读不到各个列表的情况时，没有记录的那些说不出下载得怎样：写「—」，不说「还没下载」
// With the statuses unreadable, a list without a record cannot say how its download went: it reads —, not 还没下载
const unknown = (s: Subscription) => blocklists.status === 'failed' && !statusOf(s)
// 按规整后的链接认，和改动数一个口径 / Matched by normal link, as the change count is
const added = (s: Subscription) => !appliedModel.value.blocklists.subscriptions.some((x) => normalUrl(x.url) === normalUrl(s.url))
// 「18.6 万条」「6,540 条」：带单位时不再隔空格 / 「18.6 万条」, 「6,540 条」: no space once a unit is there
const ruleCount = (n: number) => (n >= 1e4 ? `${fmtCount(n)}条` : `${fmtCount(n)}\u00a0条`)
// 时间都是秒；「3 天前」前面空一格，「刚刚」不空 / Times are in seconds; 「3 天前」 takes a space before it, 「刚刚」 none
const ago = (seconds: number) => formatAgo(seconds)
const spaced = (text: string) => (/^\d/.test(text) ? ` ${text}` : text)

// 没下载成功、没更新上的列表合成一块说：每个一行「名字：原因」，原因里已经点了名字的不再重复；有一份在用的，行上已经写着仍用哪份
// Lists that failed to download or update, said in one block: a line each of 「name: cause」, without repeating a name the cause already gives; one
// still holding a copy already says on its row which copy it keeps
// 默认名「文件名 · 主机」而原因里已经有这个主机时，只写文件名 / A default 「file name · host」 name whose cause already gives the host shows the file name only
// 停用的列表也列着，排在后面、颜色淡下去，名字后面标「已停用」：它们不在用，但下载出了什么问题照样要找得到
// Disabled lists are listed too, after the others and dimmed, marked 已停用 after the name: they are not in use, but what went wrong with their
// download should still be findable
// stuck：重新下载也是一样的（链接失效、打开的是网页、文件太大或是空的），下载过的也算；规则少了一半那种不算，下次还是这样就会换上
// stuck: downloading again gets the same (a dead link, a web page, a file too big or empty), held copies included; not a list that shrank by half,
// which goes in if the next download looks the same
const failures = computed(() => subscriptions.value.filter((s) => statusOf(s)?.last_error && !downloading(s)).map((s) => {
  const status = statusOf(s)!
  const cause = status.last_error!.replace(/[。.]\s*$/, '')
  const short = shortName(s.name, s.url)
  const label = short !== s.name && cause.includes(host(s.url)) ? short : s.name
  const off = !s.enabled
  return { id: s.id, name: cause.includes(s.name) && !off ? '' : label, label, off, cause, held: held(s), retryable: Boolean(status.retryable), stuck: !status.retryable && !status.rejected_sha256 }
}).sort((a, b) => Number(a.off) - Number(b.off)))
// 末尾按怎么办分两句，可以同时出现：先说重下也没用、要换链接的那几个，再说一份都没有、重下可能就好的那几个（没下载成功的不会自己再下）。
// 只有一个列表出错时说「这一行」「它」，五个以内点名，再多时说个数或者指那几行的标签。说到的列表都已停用时，这一句也淡下去
// The end says what to do in two sentences that may both appear: first those downloading again will not fix, which need another link, then those
// with no copy where downloading again may help (a failed one is not retried on its own). With one failing list it says 「this row」 and 「it」, up to
// five it names them, beyond that it counts them or points at the rows' tag. A sentence about disabled lists only is dimmed like them
const NAMED = 5
const names = (list: { label: string }[]) => list.map((f) => `「${f.label}」`).join('')
const stuckLine = computed(() => {
  const stuck = failures.value.filter((f) => f.stuck)
  if (!stuck.length) return null
  const them = stuck.length === 1 ? '它' : '它们'
  const who = stuck.length === failures.value.length ? '' : stuck.length <= NAMED ? names(stuck) : `其中 ${stuck.length}\u00a0个`
  return { text: `${who}重新下载也是一样：要换链接，先删掉${them}，再粘贴新的。`, off: stuck.every((f) => f.off) }
})
const retryLead = computed(() => {
  const retry = failures.value.filter((f) => !f.held && f.retryable)
  if (!retry.length) return null
  const rows = ['', '那一行', '那两行', '那三行', '那四行', '那五行']
  const row = failures.value.length === 1 ? '这一行' : retry.length <= NAMED ? `${names(retry)}${rows[retry.length]}`
    : stuckLine.value ? '其余标着「没下载成功」的那几行' : '标着「没下载成功」的那几行'
  return { text: `要重新下载，点${row}「…」里的`, off: retry.every((f) => f.off) }
})

const rowMenu = (s: Subscription) => {
  const skipped = statusOf(s)?.summary.skipped ?? 0
  return [
    { value: 'update', label: '立即更新', disabled: downloading(s) },
    { value: 'skipped', label: unknown(s) ? '读不到没用上的规则' : skipped ? `查看没用上的 ${fmtCount(skipped)} 条` : '没有没用上的规则', disabled: !skipped },
    { value: 'open', label: '打开链接' },
    { value: 'delete', label: '删除', danger: true },
  ]
}
const skippedOf = ref<Subscription | null>(null)
const skippedDialog = ref<HTMLDialogElement | null>(null)
const samples = computed(() => (skippedOf.value ? statusOf(skippedOf.value)?.summary.samples ?? [] : []))
const sampleText = (line: BlocklistSkippedLine) => skipText({ reason: line.reason, modifier: line.modifier } as Skip)
// 原因里的 $修饰符、@@ 写法和「写成」后面给出的规则按代码的样子写，和写法提示一致；短的代码不折开；「DNS 用不上」连在一起，不单剩「用不上」一行
// A $modifier, an @@ rule and the rule given after 写成 in a reason are set as code, as in the syntax hints; short code stays whole; 「DNS 用不上」 stays
// together, so 用不上 never sits alone on a line
const REASON_PARTS = /\$[a-z0-9_-]+|@@\S+|(?<=写成 )\S+|DNS 用不上/g
function reasonParts(text: string): Array<{ text: string; code: boolean; whole: boolean }> {
  const parts: Array<{ text: string; code: boolean; whole: boolean }> = []
  let at = 0
  for (const m of text.matchAll(REASON_PARTS)) {
    if (m.index > at) parts.push({ text: text.slice(at, m.index), code: false, whole: false })
    const code = m[0] !== 'DNS 用不上'
    parts.push({ text: m[0], code, whole: !code || m[0].length <= 24 })
    at = m.index + m[0].length
  }
  if (at < text.length) parts.push({ text: text.slice(at), code: false, whole: false })
  return parts
}
function act(s: Subscription, value: string): void {
  if (value === 'update') void updateNow([s.url])
  else if (value === 'skipped') { skippedOf.value = s; skippedDialog.value?.showModal() }
  else if (value === 'open') window.open(s.url, '_blank', 'noopener,noreferrer')
  else if (value === 'delete') {
    const list = model.blocklists.subscriptions
    const at = list.indexOf(s)
    // 撤销时插回删除时排在它后面的那一个前面：连删几个再先后撤销，顺序照旧 / Undo puts it back before the one that followed it: deleting
    // several and undoing them in turn keeps the order
    const next = list[at + 1]
    list.splice(at, 1)
    // 正文里默认名只写文件名：刚点的就是这一行，主机不带新东西 / In prose a default name shows its file part: the row was just pressed, the host adds nothing
    deleteToasts.set(s.url, toast.undoable(`已删除「${shortName(s.name, s.url)}」`, () => {
      deleteToasts.delete(s.url)
      const now = model.blocklists.subscriptions
      // 删掉以后又加了回来：不再插第二个 / Added back since the delete: no second copy goes in
      if (now.some((x) => normalUrl(x.url) === normalUrl(s.url))) { toast.info(`「${shortName(s.name, s.url)}」已经在列表里了`); return }
      const before = next ? now.indexOf(next) : -1
      now.splice(before >= 0 ? before : Math.min(at, now.length), 0, placeBack(s))
    }))
  }
}
// 删除提示还开着的链接：加回来时收起那条提示，它的撤销已经没有意义 / Links whose delete toast is still up: adding one back clears that toast, its undo
// no longer makes sense
const deleteToasts = new Map<string, number>()
const toggle = (s: Subscription, on: boolean) => { s.enabled = on }
// 只看还在的订阅：删掉的那个下完之前，「全部更新」不陪它灰着 / Only subscriptions still present count: one deleted mid-download does not keep 全部更新 grey
const busy = computed(() => subscriptions.value.some(downloading))

// 立即更新、全部更新：草稿里没有别的修改时，新的一份下好就直接保存生效，和自动更新一样；草稿里有没保存的修改时，新的一份放进草稿，跟它一起保存。
// 有没有别的修改看的是落地那一刻：按下时有、离开配置页时同意放弃了的，这时已经是干净的草稿
// 立即更新 and 全部更新: with nothing else edited in the draft, the new copy is saved and takes effect as soon as it lands, as the automatic
// update does; with unsaved edits in the draft, the new copy goes into the draft and is saved with it. Other edits are judged when it lands: edits
// present at the press but agreed away on leaving the config page leave a clean draft by then
async function updateNow(urls: string[], button: '立即更新' | '全部更新' = '立即更新'): Promise<void> {
  const before = model.blocklists.file
  const generation = draftGeneration()
  const result = await rebuildBlocklists(urls)
  // 下载途中会话过期了：已经在登录页上，不再保存，也不说话 / The session expired during the download: the login page is up, so nothing is saved or said
  if (!session.authenticated.value) return
  // 没下成的，合成那边已经说了原因；点名的列表在下载途中都删掉了，删除提示已经说过 / One that did not download already had its reason said by the build;
  // when every list named was removed while downloading, the delete toast has said all there is
  if (result.outcome === 'failed' || !urls.some((url) => subscriptions.value.some((s) => s.url === url))) return
  // 下载途中放弃了修改、或者恢复了别的版本 / The edits were discarded, or another version restored, while it downloaded
  if (result.outcome === 'dropped') { toast.info(`下载途中草稿换掉了，这次下载的没有放进草稿；要用新的一份，再点一次「${button}」`); return }
  // 订阅在途中变了。还是这份草稿：新的一份跟着刚才的修改一起放进草稿（接着那次合成会把它填进来）；草稿只隔着离开时的放弃（放弃的修改里有订阅的
  // 增删开关）：照常收场，下面会按放弃以后的订阅再合成一次
  // The subscriptions changed meanwhile. Still the same draft: the new copy goes in along with the edits just made (the build that follows fills it in);
  // only a discard on leaving lies between (the dropped edits added, removed or switched lists): it ends as usual, building once more below for the
  // subscriptions left after the discard
  if (result.outcome === 'superseded') {
    noteLanded()
    if (draftGeneration() === generation) { sayDrafted('新的一份会和刚才的修改一起放进草稿，保存后生效'); return }
    await carryUpdate(button, true)
    return
  }
  if (model.blocklists.file === before) {
    if (urls.some((url) => blocklists.sources[url]?.last_error)) return
    // 停用的列表不进合成的文件：下好了也不变 / A disabled list stays out of the merged file: a fresh download changes nothing
    const named = subscriptions.value.filter((s) => urls.includes(s.url))
    const off = named.length === 1 && !named[0]!.enabled ? named[0] : undefined
    toast.info(off ? `新的一份已下载；「${shortName(off.name, off.url)}」已停用，启用后用上`
      : named.length > 1 && named.every((s) => !s.enabled) ? '新的一份已下载；列表都已停用，启用后用上'
        : named.length > 1 ? '下载的都和在用的一样，已经是最新的' : '下载的和在用的一样，已经是最新的')
    return
  }
  // 新的一份进了草稿：存不存、怎么说，和离开时放弃以后走同一处（updateCarry.ts） / The new copy is in the draft: whether it is saved and what is said goes
  // through the same place as after a discard on leaving (updateCarry.ts)
  noteLanded()
  await carryUpdate(button, true)
}
const updateAll = () => void updateNow(subscriptions.value.map((s) => s.url), '全部更新')

// 添加：粘贴链接，或者从推荐的里挑；加上以后马上下载，保存以后生效 / Adding: paste a link or pick suggested lists; the download starts at once and it takes effect on save
const addUrl = ref('')
const addError = ref('')
const room = computed(() => MAX_SUBSCRIPTIONS - subscriptions.value.length)
function subscribe(urls: string[]): void {
  const saved = appliedModel.value.blocklists.subscriptions
  const retry: string[] = []
  for (const url of urls.slice(0, Math.max(0, room.value))) {
    const pending = deleteToasts.get(url)
    if (pending !== undefined) { toast.dismiss(pending); deleteToasts.delete(url) }
    // 删掉又加回来的沿用原来的 id 和名字，不算新加的 / One removed and added back keeps its id and name, so it does not count as new
    const before = saved.find((x) => normalUrl(x.url) === url)
    // 默认名和已有的重名（同一个主机、同名文件）时一级一级往上带目录，正文和提示里分得出 / A default name already taken (same host, same file name)
    // carries directories one level at a time, so prose and toasts can tell them apart
    const name = uniqueSubscriptionName(url, new Set(model.blocklists.subscriptions.map((x) => x.name)))
    // 加回来的沿用原来的编号和名字；被草稿里别的订阅占了就换一个（见 placeBack） / One added back keeps its id and name, replaced when another
    // subscription in the draft holds them (see placeBack)
    model.blocklists.subscriptions.push(before ? placeBack({ ...before, enabled: true }) : { id: newId(), name, url, enabled: true })
    // 以前没下载成功过的，加回来时再下载一次 / One that never downloaded downloads again when added back
    const status = blocklists.sources[url]
    if (status?.last_error && !status.sha256) retry.push(url)
  }
  if (retry.length) void rebuildBlocklists(retry)
}
function addFromUrl(): void {
  const raw = addUrl.value.trim()
  if (!raw) return
  const checked = checkSubscriptionUrl(raw)
  if ('problem' in checked) addError.value = checked.problem
  else if (subscriptions.value.some((s) => normalUrl(s.url) === checked.url)) addError.value = '已经订阅了这个列表'
  else if (room.value <= 0) addError.value = `已经订阅了 ${MAX_SUBSCRIPTIONS} 个列表，先删掉一个再加`
  else { subscribe([checked.url]); addUrl.value = ''; addError.value = '' }
}
const presetDialog = ref<HTMLDialogElement | null>(null)
const picked = ref<string[]>([])
const subscribed = (url: string) => subscriptions.value.some((s) => normalUrl(s.url) === url)
// 已订阅的勾着、不能改，用共用复选框「勾着又禁用」的样子 / Subscribed ones are ticked and fixed, in the shared checkbox's ticked-and-disabled look
const pick = (url: string, on: boolean) => { picked.value = on ? [...picked.value, url] : picked.value.filter((u) => u !== url) }
// 名额用完：没勾的不能再勾 / Out of room: items not ticked cannot be ticked
const full = (url: string) => !picked.value.includes(url) && picked.value.length >= room.value
const roomShort = computed(() => room.value < PRESETS.filter((p) => !subscribed(p.url)).length)
// 名额提示跟着勾选变：还能选几个，满了说怎么办 / The room hint follows the ticks: how many more can be picked, and what to do once full
const roomHint = computed(() => (room.value <= 0 ? `已经订阅了 ${MAX_SUBSCRIPTIONS} 个列表，要加新的，先删掉一个。`
  : room.value - picked.value.length <= 0 ? `最多订阅 ${MAX_SUBSCRIPTIONS} 个列表，这次的名额已经选满。` : `最多订阅 ${MAX_SUBSCRIPTIONS} 个列表，这次还能选 ${room.value - picked.value.length} 个。`))
const memoryText = (mib: number) => (mib < 1 ? '内存不到 1\u00a0MiB' : `内存约 ${mib}\u00a0MiB`)
function openPresets(): void {
  picked.value = []
  presetDialog.value?.showModal()
}
function addPicked(): void {
  subscribe(PRESETS.filter((p) => picked.value.includes(p.url) && !subscribed(p.url)).map((p) => p.url))
  presetDialog.value?.close()
}

// 自己写的规则：只把没用上的行指出来，写对了就不打扰 / Own rules: only the lines left unused are pointed out; correct ones stay quiet
const problems = computed(() => parseOwnRules(model.blocklists.custom).problems)
const customRows = computed(() => Math.min(12, Math.max(5, model.blocklists.custom.split('\n').length + 1)))

// 自动更新：下拉框先显示新选的，没改成就退回去；请求途中不能再改 / The automatic update: the select shows the new choice at once and goes back if
// the change fails; it cannot change again while the request is out
const schedule = computed(() => blocklists.schedule)
const scheduleValue = ref('')
watch(() => blocklists.schedule?.interval_hours, () => { scheduleValue.value = blocklists.schedule ? String(blocklists.schedule.interval_hours ?? 0) : '' }, { immediate: true })
const scheduleSaving = ref(false)
async function setSchedule(value: string): Promise<void> {
  const before = scheduleValue.value
  scheduleValue.value = value
  scheduleSaving.value = true
  const ok = await saveBlocklistSchedule(value === '0' ? null : Number(value))
  scheduleSaving.value = false
  if (!ok) scheduleValue.value = before
}
const scheduleOptions = computed(() => [...(schedule.value ? [] : [{ value: '', label: '—' }]), { value: '0', label: '关闭' }, { value: '24', label: '每天' }, { value: '168', label: '每周' }])
// 自动更新只更新保存了的配置里在用的列表 / The automatic update only updates the lists the saved config uses
const savedLists = computed(() => Boolean(appliedModel.value.blocklists.file))
const scheduleParts = computed(() => {
  const s = schedule.value
  if (!s?.interval_hours || !savedLists.value) return []
  // 刚开的时候服务端在下一轮（十几分钟内）就更新一次 / Right after it is switched on the server updates on its next round, within a quarter of an hour
  const soon = s.next_run_at !== null && s.next_run_at * 1000 <= Date.now() + 60_000
  return [s.next_run_at ? (soon ? '下次 几分钟内' : `下次 ${formatVersionTime(s.next_run_at)}`) : '', s.last_success_at ? `上次成功 ${formatVersionTime(s.last_success_at)}` : ''].filter(Boolean)
})
const scheduleHint = computed(() => {
  const s = schedule.value
  if (!s) return blocklists.status === 'failed' ? '读不到自动更新的设置，稍后刷新页面再看' : ''
  if (!s.interval_hours) return '开了以后按时更新已保存的列表'
  return savedLists.value ? '' : '保存了启用的列表以后才会开始更新'
})
const blockText = computed(() => blockLabel(model, 'default'))
</script>

<template>
  <div class="bl">
    <section class="ui-card bl__card" aria-labelledby="bl-subs">
      <header class="bl__head">
        <span class="bl__titles"><h2 id="bl-subs">订阅的列表</h2><p>先于所有规则生效，域名映射除外</p></span>
        <span class="bl__tools">
          <template v-if="subscriptions.length">
            <button class="ui-btn ui-btn--text" type="button" @click="openPresets"><ListPlus :size="16" aria-hidden="true" />推荐的列表</button>
            <button class="ui-btn ui-btn--text" type="button" :disabled="busy" @click="updateAll"><RefreshCw :size="16" aria-hidden="true" />全部更新</button>
          </template>
          <UiHelp topic="blocklists" />
        </span>
      </header>
      <form class="rw__add bl__add" :class="{ 'is-typing': addUrl.trim() }" @submit.prevent="addFromUrl">
        <Plus class="rw__addicon" :size="16" aria-hidden="true" />
        <label class="rw__field bl__url"><input v-model="addUrl" aria-label="列表的链接" :aria-invalid="Boolean(addError) || undefined" :aria-describedby="addError ? 'bl-add-err' : undefined" :placeholder="phone ? '添加列表：粘贴链接' : '添加列表：粘贴链接，如 https://example.com/filter.txt'" autocapitalize="off" spellcheck="false" @input="addError = ''"></label>
        <button class="ui-btn ui-btn--secondary rw__submit" :class="{ 'ui-btn--sm': !phone }" type="submit" :disabled="!addUrl.trim()">添加</button>
        <p v-if="addError" id="bl-add-err" class="ui-field-error bl__adderr" role="alert">{{ addError }}</p>
      </form>
      <!-- 配置里用着一份拦截列表、却没记下是哪些列表合成的（从别处读进来的）：照实说，不像是什么都没开 / The config uses a blocklist file but did not record
           which lists built it (read in from elsewhere): say so, rather than look as if nothing were on -->
      <UiEmpty v-if="!subscriptions.length" :icon="ShieldBan" title="还没有订阅拦截列表" :desc="model.blocklists.file ? '配置里还用着一份拦截列表，但没记下是哪些列表合成的；订阅列表并保存以后，会换成新合成的。' : '从推荐的列表里挑一个，或者在上面粘贴 AdGuard、Adblock 规则和 hosts\u00a0文件的链接。'">
        <button class="ui-btn ui-btn--secondary" type="button" @click="openPresets"><ListPlus :size="16" aria-hidden="true" />推荐的列表</button>
      </UiEmpty>
      <template v-else>
        <div class="bl__table">
          <div class="bl__cols" aria-hidden="true"><span>列表</span><span class="bl__col-about">内容</span><span>规则</span><span>更新</span><span>启用</span></div>
          <ul class="bl__list">
            <li v-for="s in subscriptions" :key="s.id" class="bl__row" :class="{ 'is-off': !s.enabled }">
              <span class="bl__name">
                <span class="bl__nm"><b :title="s.name">{{ s.name }}</b><span v-if="changedSubscriptionIds.has(s.id)" class="ui-dot ui-dot--ink bl__changed" role="img" :aria-label="added(s) ? '新加的，还没保存' : '改过，还没保存'" :title="added(s) ? '新加的，还没保存' : '改过，还没保存'"></span></span>
                <small v-if="source(s)">{{ source(s) }}</small>
              </span>
              <span class="bl__about" :title="presetOf(s) ? about(s) : link(s)">{{ about(s) }}</span>
              <span class="bl__meta">
              <span class="bl__rules"><span class="bl__sr">规则</span><span>{{ held(s) ? ruleCount(statusOf(s)!.summary.rules) : '—' }}</span><small v-if="held(s) && statusOf(s)!.summary.skipped">{{ fmtCount(statusOf(s)!.summary.skipped) }}&nbsp;条没用上</small></span>
              <span class="bl__when" aria-live="polite">
                <span class="bl__sr">更新</span>
                <span v-if="downloading(s)" class="bl__busy"><RefreshCw :size="14" class="spin" aria-hidden="true" />下载中</span>
                <span v-else-if="unknown(s)" title="读不到">—</span>
                <span v-else-if="statusOf(s)?.last_error" class="ui-tag ui-tag--warn" :title="statusOf(s)!.last_error!">{{ held(s) ? '没更新上' : '没下载成功' }}</span>
                <span v-else-if="statusOf(s)?.downloaded_at">{{ ago(statusOf(s)!.downloaded_at!) }}<span class="bl__updated">更新</span></span>
                <span v-else>{{ blocklists.status === 'loading' ? '…' : '还没下载' }}</span>
                <small v-if="s.enabled && !downloading(s) && statusOf(s)?.last_error && held(s) && statusOf(s)?.downloaded_at">仍用{{ spaced(ago(statusOf(s)!.downloaded_at!)) }}那份</small>
              </span>
              </span>
              <span class="bl__acts">
                <label class="ui-switch"><input :checked="s.enabled" type="checkbox" :aria-label="`启用 ${s.name}`" @change="toggle(s, ($event.target as HTMLInputElement).checked)"><i></i></label>
                <UiMenu :items="rowMenu(s)" :label="`${s.name} 的操作`" anchor=".bl__row" @select="act(s, $event)" />
              </span>
            </li>
          </ul>
        </div>
        <div v-if="failures.length" class="bl__note">
          <TriangleAlert :size="14" aria-hidden="true" />
          <div class="bl__causes">
            <p v-for="f in failures" :key="f.id" :class="{ 'is-off': f.off }"><b v-if="f.name"><GlueText :text="f.name" /></b><template v-if="f.off">（已停用）</template><template v-if="f.name">：</template><GlueText :text="`${f.cause}。`" /></p>
            <p v-if="stuckLine" class="bl__todo" :class="{ 'is-off': stuckLine.off }"><GlueText :text="stuckLine.text" /></p>
            <p v-if="retryLead" class="bl__todo" :class="{ 'is-off': retryLead.off }"><GlueText :text="retryLead.text" /><span class="nowrap">「立即更新」。</span></p>
          </div>
        </div>
        <p v-if="blocklists.status === 'failed' && subscriptions.some(unknown)" class="bl__note"><TriangleAlert :size="14" aria-hidden="true" />读不到各个列表下载得怎么样；订阅照常保存，稍后刷新页面再看。</p>
      </template>
    </section>

    <section class="ui-card bl__card" aria-labelledby="bl-own">
      <header class="bl__head">
        <span class="bl__titles"><h2 id="bl-own">自己写的规则</h2><p>比订阅的列表优先：这里放行的域名，哪个列表都<span class="nowrap">拦不下</span></p></span>
      </header>
      <div class="bl__own">
        <label class="ui-input ui-input--area bl__text"><textarea v-model="model.blocklists.custom" :rows="customRows" aria-label="自己写的规则，一行一条" spellcheck="false" autocapitalize="off" placeholder="||ads.example.com^&#10;@@||cdn.example.com^"></textarea></label>
        <p class="bl__syntax"><span><code>||example.com^</code>拦截它和子域名</span><span><code>@@||example.com^</code>放行它和子域名</span><span><code>example.com</code>只拦它本身</span></p>
        <ul v-if="problems.length" class="bl__problems" aria-label="没用上的行">
          <li v-for="p in problems" :key="p.line" class="bl__problem"><span class="bl__lineno">第 {{ p.line }} 行</span><span class="bl__what"><s>{{ p.text }}</s> <span><template v-for="(part, i) in reasonParts(p.problem)" :key="i"><code v-if="part.code" :class="{ nowrap: part.whole }">{{ part.text }}</code><span v-else-if="part.whole" class="nowrap">{{ part.text }}</span><template v-else>{{ part.text }}</template></template></span></span></li>
        </ul>
      </div>
    </section>

    <section class="ui-card bl__card bl__sets" aria-label="拦截列表的设置">
      <div class="ui-setrow">
        <span class="ui-setrow__label">
          <span>自动更新</span>
          <small v-if="scheduleParts.length"><UiDotText :parts="scheduleParts" /></small>
          <small v-else-if="scheduleHint">{{ scheduleHint }}</small>
          <small v-if="schedule?.last_error" class="bl__warn">上次自动更新：{{ schedule.last_error }}</small>
        </span>
        <span class="ui-setrow__control bl__schedule"><UiSelect :model-value="scheduleValue" :options="scheduleOptions" label="自动更新" :disabled="!schedule || scheduleSaving" @update:model-value="setSchedule" /></span>
      </div>
      <div class="ui-setrow">
        <span class="ui-setrow__label"><span>拦截时怎么回应</span><small>和规则的「拦截 · 沿用默认」一样</small></span>
        <span class="ui-setrow__control bl__answer"><b>{{ blockText }}</b><button class="ui-btn ui-btn--text ui-btn--sm" type="button" @click="router.push({ query: { section: 'settings' } })">到基础设置里改</button></span>
      </div>
    </section>

    <dialog ref="presetDialog" class="pdialog" aria-labelledby="blp-title" @click.self="presetDialog?.close()">
      <form class="pdialog__panel bl__dialog" @submit.prevent="addPicked">
        <header class="pdialog__head"><h2 id="blp-title">推荐的列表</h2><button class="ui-icon-btn" type="button" aria-label="关闭" @click="presetDialog?.close()"><X :size="16" /></button></header>
        <div class="pdialog__body">
          <ul class="blp">
            <li v-for="p in PRESETS" :key="p.url" class="blp__row">
              <label class="blp__item" :class="{ 'is-done': subscribed(p.url), 'is-full': full(p.url) && !subscribed(p.url) }">
                <span class="ui-checkbox"><input type="checkbox" :checked="subscribed(p.url) || picked.includes(p.url)" :disabled="subscribed(p.url) || full(p.url)" @change="pick(p.url, ($event.target as HTMLInputElement).checked)"><i></i></span>
                <span class="blp__main"><b>{{ p.name }}</b><small>{{ p.about }}</small></span>
                <span class="blp__meta"><template v-if="subscribed(p.url)">已订阅</template><UiDotText v-else :parts="[ruleCount(p.rules), memoryText(p.memory)]" /></span>
              </label>
            </li>
          </ul>
          <p v-if="roomShort" class="pfield__hint">{{ roomHint }}</p>
          <p class="blp__more">其他 AdGuard、Adblock 写法的列表和 hosts&nbsp;文件也能用：<a class="ui-link" href="https://adguard-dns.io/kb/general/dns-filtering-syntax/" target="_blank" rel="noreferrer">AdGuard 写法说明（英文）<ExternalLink :size="14" aria-hidden="true" /></a></p>
        </div>
        <footer class="pdialog__foot"><button class="ui-btn ui-btn--secondary" type="button" @click="presetDialog?.close()">取消</button><button class="ui-btn ui-btn--primary" type="submit" :disabled="!picked.length">{{ picked.length ? `订阅 ${picked.length} 个` : '订阅' }}</button></footer>
      </form>
    </dialog>

    <dialog ref="skippedDialog" class="pdialog" aria-labelledby="bls-title" @click.self="skippedDialog?.close()">
      <div class="pdialog__panel bl__dialog">
        <header class="pdialog__head"><h2 id="bls-title">{{ skippedOf?.name }} 没用上的规则</h2><button class="ui-icon-btn" type="button" aria-label="关闭" @click="skippedDialog?.close()"><X :size="16" /></button></header>
        <div class="pdialog__body">
          <p class="pfield__hint">这些规则 DNS 用不上或者还不支持，整条跳过；其余的照常生效。<template v-if="skippedOf && (statusOf(skippedOf)?.summary.skipped ?? 0) > samples.length">下面只列出前 {{ samples.length }} 条。</template></p>
          <ul class="bl__problems">
            <li v-for="line in samples" :key="line.line" class="bl__problem"><span class="bl__lineno">第 {{ line.line }} 行</span><span class="bl__what"><s>{{ line.text }}</s> <span><template v-for="(part, i) in reasonParts(sampleText(line))" :key="i"><code v-if="part.code" :class="{ nowrap: part.whole }">{{ part.text }}</code><span v-else-if="part.whole" class="nowrap">{{ part.text }}</span><template v-else>{{ part.text }}</template></template></span></span></li>
          </ul>
        </div>
        <footer class="pdialog__foot"><button class="ui-btn ui-btn--secondary" type="button" @click="skippedDialog?.close()">关闭</button></footer>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.bl { display: grid; gap: var(--s-4); }
.bl__card { overflow: clip; }
.bl__head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--s-2) var(--s-4); padding: var(--s-4) var(--s-5) var(--s-3); }
.bl__titles { display: grid; gap: 2px; min-width: 0; }
.bl__titles h2 { margin: 0; color: var(--l-ink); font-family: var(--f-display); font-size: var(--t-4); font-weight: var(--w-bold); line-height: var(--lh-tight); }
.bl__titles p { margin: 0; color: var(--l-ink-3); font-size: var(--t-2); line-height: var(--lh-base); }
.bl__tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-1); margin-right: calc(var(--s-2) * -1); }
/* 添加栏和域名映射的一样高（26 + 8 × 2 + 横线），出错的话写在栏里 / The add bar is as tall as the mapping one (26 + 8 × 2 + rules), with an error inside it */
.bl__add { display: flex; flex-wrap: wrap; align-items: center; gap: 0 var(--s-3); padding: var(--s-2) var(--s-5); border-block: 1px solid var(--l-hair); }
.bl__url { flex: 1 1 0; min-width: 0; }
.bl__url input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--l-ink); font-size: var(--t-3); }
.bl__url input::placeholder { color: var(--l-ink-3); }
.bl__adderr { flex: 1 0 100%; margin: 0; }
/* 表头和每一行共用一套列（subgrid）：每列宽到这一列最宽的内容，剩下的宽度平均分到列与列之间。开关和「…」都是对这一行的操作，
   合成最后一列，挨在一起靠右
   The head and every row share one set of columns (subgrid): each column is as wide as its widest content, and what is left is
   split evenly between the columns. The switch and 「…」 both act on the row, so they make up the last column together, side by
   side at the right */
.bl__table { display: grid; grid-template-columns: minmax(0, max-content) repeat(3, max-content); justify-content: space-between; column-gap: var(--s-6); }
.bl__list { margin: 0; padding: 0; list-style: none; }
.bl__cols, .bl__list, .bl__row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; }
.bl__cols, .bl__row { align-items: center; padding-inline: var(--s-5); }
.bl__cols { min-height: var(--h-md); color: var(--l-ink-3); font-size: var(--t-1); border-bottom: 1px solid var(--l-hair); }
.bl__row { min-height: var(--h-touch); padding-block: var(--s-2); border-bottom: 1px solid var(--l-hair); }
.bl__row:last-child { border-bottom: 0; }
@media (hover: hover) { .bl__row:hover { background: var(--l-canvas); } }
.bl__acts { display: flex; align-items: center; gap: var(--s-4); }
/* 「…」的三个点和上面「添加」按钮的右边对齐，和域名映射一样 / The three dots line up with the right edge of 添加 above, as in the mapping list */
.bl__acts :deep(.ui-icon-btn) { margin-right: calc((var(--h-sm) - var(--size-icon)) / -2 - 3px); }
/* 条数和更新两格：宽屏上各占表格的一列，手机上是第二行 / The count and update cells: a table column each when wide, the second line on phones */
.bl__meta { display: contents; }
.bl__name, .bl__when { min-width: 0; display: grid; gap: 1px; }
/* 名字截短时，表示还没保存的小圆点照样在 / When the name is cut short, the unsaved dot still shows */
.bl__nm { display: flex; align-items: center; gap: var(--s-2); min-width: 0; }
.bl__nm b { min-width: 0; overflow: hidden; color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-medium); text-overflow: ellipsis; white-space: nowrap; }
.bl__changed { flex: none; }
/* 没用上的条数跟在条数后面，同一行：每行一样高 / The unused count follows the count on the same line, so every row is the same height */
.bl__rules { display: flex; align-items: baseline; gap: var(--s-2); min-width: 0; }
.bl__name small, .bl__rules small, .bl__when small { overflow: hidden; color: var(--l-ink-3); font-size: var(--t-1); text-overflow: ellipsis; white-space: nowrap; }
.bl__rules > span, .bl__when > span:not(.ui-tag) { color: var(--l-ink-2); font-size: var(--t-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
/* 更新列留出最宽的状态那么宽：「全部更新」时列不横移 / The update column keeps room for its widest state, so 全部更新 does not shift the columns */
.bl__when { min-width: 4.5rem; }
.bl__when > .ui-tag { justify-self: start; }
/* 关着的列表不在用：出错的标签也淡一档 / A switched-off list is not in use: its failure tag dims too */
.bl__row.is-off .bl__when > .ui-tag { background: var(--l-sunk); color: var(--l-ink-3); }
.bl__updated { display: none; }
.bl__row.is-off :is(.bl__nm b, .bl__about, .bl__rules > span, .bl__when > span) { color: var(--l-ink-3); }
/* 读屏用的列名：表头对读屏是隐藏的 / Column names for screen readers, to whom the head is hidden */
/* 整个裁掉、不占位置：看不见，读屏照样读 / Clipped away whole and out of the flow: unseen, yet still read aloud */
.bl__sr { position: absolute; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
/* 宽屏中间放「内容」列：推荐的列表拦什么、自己粘贴的链接；名字下面就不再写来源网址。窄一些放不下，名字下面写来源网址
   On wide screens the middle holds the 内容 column, what a suggested list blocks or the pasted link, and the name drops its host line;
   narrower ones have no room for it and keep the host under the name */
.bl__about, .bl__col-about { display: none; }
.bl__about { overflow: hidden; color: var(--l-ink-2); font-size: var(--t-3); text-overflow: ellipsis; white-space: nowrap; }
/* 特别长的名字和链接截短，不把别的列挤走 / Very long names and links are cut short rather than squeezing the other columns */
.bl__name { max-width: 18rem; }
.bl__about { max-width: 24rem; }
@media (min-width: 1180px) {
  .bl__table { grid-template-columns: minmax(0, max-content) minmax(0, max-content) repeat(3, max-content); }
  .bl__about, .bl__col-about { display: block; }
  .bl__name small { display: none; }
  /* 和「4 条没用上」一样：「没更新上」和「仍用…那份」写在同一行，每行一样高 / As with 「4 条没用上」: 没更新上 and 仍用…那份 share a line, so every row is the same height */
  .bl__when { display: flex; align-items: baseline; gap: var(--s-2); }
}
.bl__note { display: flex; align-items: flex-start; gap: var(--s-2); margin: 0; padding: var(--s-3) var(--s-5); border-top: 1px solid var(--l-hair); color: var(--warn-l); font-size: var(--t-2); line-height: var(--lh-base); }
.bl__note > svg { flex-shrink: 0; margin-top: calc((1lh - 14px) / 2); }
.bl__causes { display: grid; gap: 2px; min-width: 0; }
.bl__causes p { max-width: 60em; margin: 0; overflow-wrap: anywhere; }
.bl__causes b { font-weight: var(--w-medium); }
.bl__causes p.is-off { color: var(--l-ink-3); }
/* 「怎么办」那两句和上面各条「出了什么事」分开一点 / The 「what to do」 sentences sit a little apart from the 「what happened」 lines above */
.bl__causes p:not(.bl__todo) + .bl__todo { margin-top: var(--s-1); }
.bl__own { display: grid; gap: var(--s-2); padding: 0 var(--s-5) var(--s-4); }
.bl__text textarea { font-family: var(--f-mono); font-size: var(--t-2); white-space: pre; overflow-x: auto; overflow-wrap: normal; }
.bl__busy { display: inline-flex; align-items: center; gap: var(--s-1); }
.bl__syntax { display: flex; flex-wrap: wrap; gap: var(--s-1) var(--s-4); margin: 0; color: var(--l-ink-3); font-size: var(--t-1); }
.bl__syntax > span { display: inline-flex; align-items: baseline; gap: var(--s-1); white-space: nowrap; }
.bl__syntax code { padding: 0 var(--s-1); border-radius: var(--r-1); background: var(--l-sunk); color: var(--l-ink-2); font-family: var(--f-mono); }
.bl__problems { display: grid; gap: var(--s-1); margin: 0; padding: 0; list-style: none; color: var(--l-ink-2); font-size: var(--t-2); }
/* 整张清单共用一列行号（多少位都对齐），规则和原因挂在后面那一列，折行也不掉到行号底下
   The whole list shares one column of line numbers (aligned however many digits), with the rule and its reason in the next column, so a wrap never
   drops under the line number */
.bl__problems { grid-template-columns: max-content minmax(0, 1fr); column-gap: var(--s-2); }
.bl__problem { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: baseline; }
.bl__lineno { color: var(--l-ink-3); font-variant-numeric: tabular-nums; }
.bl__what > span { word-break: keep-all; overflow-wrap: anywhere; }
.bl__what code { -webkit-box-decoration-break: clone; box-decoration-break: clone; padding: 0 var(--s-1); border-radius: var(--r-1); background: var(--l-sunk); color: var(--l-ink-2); font-family: var(--f-mono); font-size: var(--t-1); }
.bl__problem s { margin-right: var(--s-1); color: var(--l-ink-3); font-family: var(--f-mono); font-size: var(--t-1); overflow-wrap: anywhere; }
.bl__warn { color: var(--warn-l) !important; white-space: normal !important; }
.bl__sets { padding: var(--s-2) var(--s-5); }
.bl__sets .ui-setrow { grid-template-columns: minmax(0, 300px) minmax(0, 320px); }
.bl__sets .ui-setrow + .ui-setrow { border-top: 1px solid var(--l-hair); }
.bl__answer { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-1) var(--s-3); min-height: var(--h-md); }
.bl__answer b { color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-medium); }
@media (min-width: 641px) { .bl__dialog { width: min(36rem, calc(100% - var(--s-6))); } }
.blp { display: grid; margin: 0; padding: 0; list-style: none; border: 1px solid var(--l-hair); border-radius: var(--r-2); }
.blp__row + .blp__row { border-top: 1px solid var(--l-hair); }
.blp__item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--s-3); min-height: var(--h-touch); padding: var(--s-2) var(--s-3); cursor: pointer; }
@media (hover: hover) { .blp__item:hover { background: var(--l-canvas); } }
.blp__item:is(.is-done, .is-full) { cursor: default; }
.blp__item:is(.is-done, .is-full) :is(b, small, .blp__meta) { color: var(--l-ink-3); }
/* 已订阅的画成灰色的「已勾」：它已经在里面了 / A subscribed one is drawn as a grey tick: it is already in */
.blp__main { display: grid; gap: 1px; min-width: 0; }
.blp__main b { color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-medium); }
.blp__main small { color: var(--l-ink-3); font-size: var(--t-1); }
/* 条数和内存是数值，按数据的字号 / Count and memory are values, set as data */
.blp__meta { color: var(--l-ink-2); font-size: var(--t-2); text-align: right; font-variant-numeric: tabular-nums; }
.blp__more { margin: 0; color: var(--l-ink-2); font-size: var(--t-2); }
/* 图标跟在链接的字后面，折行时不单独挂到最右边 / The icon follows the link text and never hangs alone at the far right when it wraps */
.blp__more svg { display: inline; margin-left: var(--s-1); vertical-align: -2px; }
@media (max-width: 640px) {
  .bl__head { padding: var(--s-4) var(--s-4) var(--s-2); }
  .bl__tools { margin-left: calc(var(--s-2) * -1); }
  .bl__add { padding: 0 var(--s-4); min-height: var(--h-touch); }
  /* 整栏 44 都点得中（全站给输入框的 36 写得更具体，这里也要写到那么具体） / The whole 44 bar takes the tap (the site-wide 36 for inputs is more
     specific, so this has to be as specific) */
  .bl__card .bl__add .bl__url input { min-height: var(--h-touch); }
  /* 手机上「+」图标在：出错的话和输入的字对齐 / On phones the 「+」 icon shows: an error lines up with the typed text */
  .bl__adderr { padding: 0 0 var(--s-2) calc(16px + var(--s-3)); }
  .bl__cols { display: none; }
  .bl__table, .bl__list { display: block; }
  /* 第一行名字、「…」和开关并排，第二行规则数和更新时间；上下留白和域名映射一样，「…」不把第一行撑高
     Name, 「…」 and the switch first, then the rule count and update time; the padding matches the mapping list, and 「…」 does not make the
     first line taller */
  .bl__row { grid-template-columns: minmax(0, 1fr) auto auto; grid-template-areas: "n menu switch"; row-gap: var(--s-1); padding: var(--s-3) var(--s-4); }
  .bl__acts :deep(.ui-icon-btn) { margin-block: calc((var(--s-5) - var(--h-md)) / 2); margin-right: 0; }
  .bl__name { grid-area: n; }
  /* 手机上不写来源网址：每个列表两行，名字一行，条数和更新时间一行 / No source host on phones: two lines per list, the name, then the count and update time */
  .bl__name small { display: none; }
  /* 第二行横跨整行，条数靠左、更新状态靠右：长的更新状态不再把上面「…」那一列撑宽；两段放不下时更新状态整段换到下一行靠右，不叠在一起
     The second line spans the row, the count on the left and the update state on the right, so a long update state no longer widens the 「…」
     column above; when the two do not fit, the update state moves whole to a line of its own on the right instead of overlapping */
  .bl__meta { grid-area: 2 / 1 / 3 / 4; display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; column-gap: var(--s-3); row-gap: var(--s-1); min-width: 0; }
  .bl__when { display: flex; gap: var(--s-2); align-items: baseline; min-width: 0; margin-left: auto; }
  .bl__rules > span, .bl__when > span:not(.ui-tag) { font-size: var(--t-2); }
  /* 没有表头，「刚刚」后面写上「更新」 / With no head, 刚刚 is followed by 更新 */
  .bl__updated { display: inline; }
  .bl__acts { display: contents; }
  .bl__acts > .ui-switch { grid-area: switch; justify-self: end; }
  .bl__acts > :deep(.ui-menu-host) { grid-area: menu; }
  .bl__note { padding-inline: var(--s-4); }
  /* 一条折成两行时，条与条之间空开一点，分得出哪段是哪条 / With an item over two lines, items are spaced a little apart so each reads as one */
  .bl__causes { gap: var(--s-1); }
  .bl__own { padding-inline: var(--s-4); }
  /* 每条问题固定两行：第一行行号和原因，第二行划掉的原文；条与条之间空开 / Each problem keeps two lines, the line number and reason, then the struck
     text; items are spaced apart */
  .bl__problems { display: grid; grid-template-columns: minmax(0, 1fr); row-gap: var(--s-3); }
  .bl__problem { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--s-2); grid-column: auto; }
  .bl__what { display: contents; }
  .bl__problem s { order: 2; flex-basis: 100%; margin-right: 0; }
  .bl__what > span { flex: 1 1 0; min-width: 0; }
  .bl__sets { padding-inline: var(--s-4); }
  .bl__sets .ui-setrow { grid-template-columns: minmax(0, 1fr); }
  /* 三行一项时复选框对着名字那一行，不对着中间 / With three lines an item's checkbox faces the name line, not the middle */
  .blp__item { grid-template-columns: auto minmax(0, 1fr); row-gap: 2px; align-items: start; }
  .blp__item .ui-checkbox { margin-top: calc((var(--t-3) * var(--lh-base) - var(--size-check)) / 2); }
  .blp__meta { grid-column: 2; text-align: left; }
}
</style>
