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
import { useToast } from '../composables/useToast'
import { checkSubscriptionUrl, MAX_SUBSCRIPTIONS, parseOwnRules, PRESETS, skipText, subscriptionName, type Skip } from '../config-model/blocklist'
import { blockLabel, type Subscription } from '../config-model/model'
import { formatAgo, formatVersionTime } from '../utils'
import { usePhone } from './phone'
import { appliedModel, changedSubscriptionIds, model, newId, unsaved } from './store'
import { blocklists, loadBlocklists, rebuildBlocklists, saveBlocklistSchedule } from './useBlocklists'
import { save, saveInFlight } from './useConfigDocument'
import { fmtCount, keepTail } from './view'

// 拦截列表：订阅的列表一行一个，像域名映射那样一张卡片；下面是自己写的规则和两项设置。订阅和自己写的规则都在草稿里，
// 保存以后生效；列表下载、合并由面板服务端做，自动更新也在服务端。订阅一变，useBlocklists 就请服务端重新合成。
// Blocklists: one subscribed list per row, a card like the mapping list; under it the rules of one's own and two settings.
// Subscriptions and own rules live in the draft and take effect on save; the panel server downloads, merges and updates the lists.
// Whenever the subscriptions change, useBlocklists asks the server to build again.
const router = useRouter()
const phone = usePhone()
const toast = useToast()
onMounted(() => void loadBlocklists())

const subscriptions = computed(() => model.blocklists.subscriptions)
const host = (url: string) => { try { return new URL(url).host } catch { return url } }
const presetOf = (s: Subscription) => PRESETS.find((p) => p.url === s.url)
// 「内容」列：推荐的列表写它拦什么，自己粘贴的写链接 / The 内容 column: what a suggested list blocks, or the link one pasted
const about = (s: Subscription) => presetOf(s)?.about ?? s.url.replace(/^https:\/\//, '')
// 窄屏名字下面的来源：主机名；名字里已经有主机名时写路径 / The source under the name on narrow screens: the host, or the path once the name holds the host
function source(s: Subscription): string {
  const name = host(s.url)
  if (!s.name.includes(name)) return name
  try { return decodeURI(new URL(s.url).pathname) } catch { return s.url }
}
const statusOf = (s: Subscription) => blocklists.sources[s.url]
const held = (s: Subscription) => Boolean(statusOf(s)?.sha256)
const downloading = (s: Subscription) => blocklists.downloading.has(s.url)
// 读不到各个列表的情况时，没有记录的那些说不出下载得怎样：写「—」，不说「还没下载」
// With the statuses unreadable, a list without a record cannot say how its download went: it reads —, not 还没下载
const unknown = (s: Subscription) => blocklists.status === 'failed' && !statusOf(s)
const added = (s: Subscription) => !appliedModel.value.blocklists.subscriptions.some((x) => x.id === s.id)
// 「18.6 万条」「6,540 条」：带单位时不再隔空格 / 「18.6 万条」, 「6,540 条」: no space once a unit is there
const ruleCount = (n: number) => (n >= 1e4 ? `${fmtCount(n)}条` : `${fmtCount(n)}\u00a0条`)
// 时间都是秒；「3 天前」前面空一格，「刚刚」不空 / Times are in seconds; 「3 天前」 takes a space before it, 「刚刚」 none
const ago = (seconds: number) => formatAgo(seconds)
const spaced = (text: string) => (/^\d/.test(text) ? ` ${text}` : text)

// 没下载成功、没更新上的列表（关掉的不算，它们不在用），合成一块说：每个一行「名字：原因」，原因里已经点了名字的不再重复；
// 一份都没有的，末尾说一次怎么重新下载（没下载成功的不会自己再下）；有一份在用的，行上已经写着仍用哪份
// Lists that failed to download or update (switched-off ones not, they are not in use), said in one block: a line each of 「name: cause」,
// without repeating a name the cause already gives; for those without any copy the end says once how to download again (a failed one is
// not retried on its own); one still holding a copy already says on its row which copy it keeps
const failures = computed(() => subscriptions.value.filter((s) => s.enabled && statusOf(s)?.last_error && !downloading(s)).map((s) => {
  const cause = statusOf(s)!.last_error!.replace(/[。.]\s*$/, '')
  return { id: s.id, name: cause.includes(s.name) ? '' : s.name, cause, held: held(s) }
}))
const retryTail = computed(() => {
  if (!failures.value.some((f) => !f.held)) return null
  return keepTail(`要重新下载，点${failures.value.length === 1 ? '这' : '那'}一行「…」里的「立即更新」。`)
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
    toast.undoable(`已删除「${s.name}」`, () => {
      const now = model.blocklists.subscriptions
      const before = next ? now.indexOf(next) : -1
      now.splice(before >= 0 ? before : Math.min(at, now.length), 0, s)
    })
  }
}
const toggle = (s: Subscription, on: boolean) => { s.enabled = on }
// 只看还在的订阅：删掉的那个下完之前，「全部更新」不陪它灰着 / Only subscriptions still present count: one deleted mid-download does not keep 全部更新 grey
const busy = computed(() => subscriptions.value.some(downloading))

// 立即更新、全部更新：草稿里没有别的修改时，新的一份下好就直接保存生效，和自动更新一样；草稿里有没保存的修改时，新的一份放进草稿，跟它一起保存
// 立即更新 and 全部更新: with nothing else edited in the draft, the new copy is saved and takes effect as soon as it lands, as the automatic
// update does; with unsaved edits in the draft, the new copy goes into the draft and is saved with it
const withoutFile = () => JSON.stringify({ ...model, blocklists: { ...model.blocklists, file: null } })
async function updateNow(urls: string[]): Promise<void> {
  const direct = !unsaved.value && !saveInFlight.value
  const before = model.blocklists.file
  const rest = withoutFile()
  await rebuildBlocklists(urls)
  if (model.blocklists.file === before) {
    // 没出错、文件也没变：下载的和在用的一样 / No failure and the same file: the download matches what is in use
    if (!urls.some((url) => blocklists.sources[url]?.last_error)) toast.info(urls.length > 1 ? '列表都没有变化，不用更新' : '列表没有变化，不用更新')
    return
  }
  if (!direct || withoutFile() !== rest || saveInFlight.value) { toast.info('新的一份已放进草稿，保存后生效'); return }
  await save('draft', '手动更新拦截列表')
}
const updateAll = () => void updateNow(subscriptions.value.map((s) => s.url))

// 添加：粘贴链接，或者从推荐的里挑；加上以后马上下载，保存以后生效 / Adding: paste a link or pick suggested lists; the download starts at once and it takes effect on save
const addUrl = ref('')
const addError = ref('')
const room = computed(() => MAX_SUBSCRIPTIONS - subscriptions.value.length)
function subscribe(urls: string[]): void {
  const saved = appliedModel.value.blocklists.subscriptions
  const retry: string[] = []
  for (const url of urls.slice(0, Math.max(0, room.value))) {
    // 删掉又加回来的沿用原来的 id 和名字，不算新加的 / One removed and added back keeps its id and name, so it does not count as new
    const before = saved.find((x) => x.url === url)
    model.blocklists.subscriptions.push(before ? { ...before, enabled: true } : { id: newId(), name: subscriptionName(url), url, enabled: true })
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
  else if (subscriptions.value.some((s) => s.url === checked.url)) addError.value = '已经订阅了这个列表'
  else if (room.value <= 0) addError.value = `最多订阅 ${MAX_SUBSCRIPTIONS} 个列表`
  else { subscribe([checked.url]); addUrl.value = ''; addError.value = '' }
}
const presetDialog = ref<HTMLDialogElement | null>(null)
const picked = ref<string[]>([])
const subscribed = (url: string) => subscriptions.value.some((s) => s.url === url)
// 名额用完：没勾的不能再勾 / Out of room: items not ticked cannot be ticked
const full = (url: string) => !picked.value.includes(url) && picked.value.length >= room.value
const roomShort = computed(() => room.value < PRESETS.filter((p) => !subscribed(p.url)).length)
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
  return savedLists.value ? '' : '保存了列表以后才会开始更新'
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
      <UiEmpty v-if="!subscriptions.length" :icon="ShieldBan" title="还没有订阅拦截列表" :desc="model.blocklists.file ? '配置里还用着一份拦截列表，但没记下是哪些列表合成的；订阅以后会换成新的。' : '从推荐的列表里挑一个，或者在上面粘贴 AdGuard、Adblock 规则和 hosts 文件的链接。'">
        <button class="ui-btn ui-btn--secondary" type="button" @click="openPresets"><ListPlus :size="16" aria-hidden="true" />推荐的列表</button>
      </UiEmpty>
      <template v-else>
        <div class="bl__table">
          <div class="bl__cols" aria-hidden="true"><span>列表</span><span class="bl__col-about">内容</span><span>规则</span><span>更新</span><span>启用</span></div>
          <ul class="bl__list">
            <li v-for="s in subscriptions" :key="s.id" class="bl__row" :class="{ 'is-off': !s.enabled }">
              <span class="bl__name">
                <span class="bl__nm"><b>{{ s.name }}</b><span v-if="changedSubscriptionIds.has(s.id)" class="ui-dot ui-dot--ink bl__changed" role="img" :aria-label="added(s) ? '新加的，还没保存' : '改过，还没保存'" :title="added(s) ? '新加的，还没保存' : '改过，还没保存'"></span></span>
                <small>{{ source(s) }}</small>
              </span>
              <span class="bl__about" :title="about(s)">{{ about(s) }}</span>
              <span class="bl__rules"><span class="bl__sr">规则</span><span>{{ held(s) ? ruleCount(statusOf(s)!.summary.rules) : '—' }}</span><small v-if="held(s) && statusOf(s)!.summary.skipped">{{ fmtCount(statusOf(s)!.summary.skipped) }}&nbsp;条没用上</small></span>
              <span class="bl__when" aria-live="polite">
                <span class="bl__sr">更新</span>
                <span v-if="downloading(s)" class="bl__busy"><RefreshCw :size="14" class="spin" aria-hidden="true" />下载中</span>
                <span v-else-if="unknown(s)" title="读不到">—</span>
                <span v-else-if="statusOf(s)?.last_error" class="ui-tag ui-tag--warn" :title="statusOf(s)!.last_error!">{{ held(s) ? '没更新上' : '没下载成功' }}</span>
                <span v-else-if="statusOf(s)?.downloaded_at">{{ ago(statusOf(s)!.downloaded_at!) }}<span class="bl__updated">更新</span></span>
                <span v-else>{{ blocklists.status === 'loading' ? '…' : '还没下载' }}</span>
                <small v-if="!downloading(s) && statusOf(s)?.last_error && held(s) && statusOf(s)?.downloaded_at">仍用{{ spaced(ago(statusOf(s)!.downloaded_at!)) }}那份</small>
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
            <p v-for="f in failures" :key="f.id"><b v-if="f.name">{{ f.name }}：</b>{{ f.cause }}。</p>
            <p v-if="retryTail">{{ retryTail[0] }}<span class="nowrap">{{ retryTail[1] }}</span></p>
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
          <li v-for="p in problems" :key="p.line" class="bl__problem"><span class="bl__lineno">第 {{ p.line }} 行</span><s>{{ p.text }}</s><span>{{ p.problem }}</span></li>
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
                <span class="ui-checkbox"><input v-model="picked" type="checkbox" :value="p.url" :disabled="subscribed(p.url) || full(p.url)"><i></i></span>
                <span class="blp__main"><b>{{ p.name }}</b><small>{{ p.about }}</small></span>
                <span class="blp__meta"><template v-if="subscribed(p.url)">已订阅</template><UiDotText v-else :parts="[ruleCount(p.rules), memoryText(p.memory)]" /></span>
              </label>
            </li>
          </ul>
          <p v-if="roomShort" class="pfield__hint">最多订阅 {{ MAX_SUBSCRIPTIONS }} 个列表，还能再订阅 {{ Math.max(0, room) }} 个。</p>
          <a class="blp__more" href="https://adguard-dns.io/kb/general/dns-filtering-syntax/" target="_blank" rel="noreferrer">其他 AdGuard、Adblock 写法的列表和 hosts 文件也能用：写法说明（英文）<ExternalLink :size="14" aria-hidden="true" /></a>
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
            <li v-for="line in samples" :key="line.line" class="bl__problem"><span class="bl__lineno">第 {{ line.line }} 行</span><s>{{ line.text }}</s><span>{{ sampleText(line) }}</span></li>
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
.bl__adderr { flex: 1 0 100%; margin: 0; padding-left: calc(16px + var(--s-3)); }
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
}
.bl__note { display: flex; align-items: flex-start; gap: var(--s-2); margin: 0; padding: var(--s-3) var(--s-5); border-top: 1px solid var(--l-hair); color: var(--warn-l); font-size: var(--t-2); line-height: var(--lh-base); }
.bl__note > svg { flex-shrink: 0; margin-top: calc((1lh - 14px) / 2); }
.bl__causes { display: grid; gap: 2px; min-width: 0; }
.bl__causes p { margin: 0; overflow-wrap: anywhere; }
.bl__causes b { font-weight: var(--w-medium); }
.bl__own { display: grid; gap: var(--s-2); padding: 0 var(--s-5) var(--s-4); }
.bl__text textarea { font-family: var(--f-mono); font-size: var(--t-2); white-space: pre; overflow-x: auto; overflow-wrap: normal; }
.bl__busy { display: inline-flex; align-items: center; gap: var(--s-1); }
.bl__syntax { display: flex; flex-wrap: wrap; gap: var(--s-1) var(--s-4); margin: 0; color: var(--l-ink-3); font-size: var(--t-1); }
.bl__syntax > span { display: inline-flex; align-items: baseline; gap: var(--s-1); white-space: nowrap; }
.bl__syntax code { padding: 0 var(--s-1); border-radius: var(--r-1); background: var(--l-sunk); color: var(--l-ink-2); font-family: var(--f-mono); }
.bl__problems { display: grid; gap: var(--s-1); margin: 0; padding: 0; list-style: none; color: var(--l-ink-2); font-size: var(--t-2); }
.bl__problem { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-1) var(--s-2); }
/* 行号等宽、留够「第 1000 行」：规则文字从同一处开始 / Line numbers in even digits with room for 「第 1000 行」, so the rule text starts in one place */
.bl__lineno { min-width: 4.6em; color: var(--l-ink-3); font-variant-numeric: tabular-nums; }
.bl__problem s { color: var(--l-ink-3); font-family: var(--f-mono); font-size: var(--t-1); overflow-wrap: anywhere; }
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
.blp__item.is-done :is(b, small, .blp__meta) { color: var(--l-ink-3); }
.blp__main { display: grid; gap: 1px; min-width: 0; }
.blp__main b { color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-medium); }
.blp__main small { color: var(--l-ink-3); font-size: var(--t-1); }
/* 条数和内存是数值，按数据的字号 / Count and memory are values, set as data */
.blp__meta { color: var(--l-ink-2); font-size: var(--t-2); text-align: right; font-variant-numeric: tabular-nums; }
.blp__more { display: inline-flex; align-items: center; gap: var(--s-1); color: var(--l-ink-2); font-size: var(--t-2); }
.blp__more svg { flex: none; }
@media (max-width: 640px) {
  .bl__head { padding: var(--s-4) var(--s-4) var(--s-2); }
  .bl__tools { margin-left: calc(var(--s-2) * -1); }
  .bl__add { padding: 0 var(--s-4); min-height: var(--h-touch); }
  .bl__url input { min-height: var(--h-touch); }
  .bl__adderr { padding-bottom: var(--s-2); }
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
  /* 第二行的两段都横跨整行，一左一右：长的更新状态不再把上面「…」那一列撑宽 / Both parts of the second line span the row, one left
     and one right, so a long update state no longer widens the 「…」 column above */
  .bl__rules { grid-area: 2 / 1 / 3 / 4; justify-self: start; }
  .bl__when { grid-area: 2 / 1 / 3 / 4; justify-self: end; display: flex; gap: var(--s-2); align-items: baseline; min-width: 0; }
  .bl__rules > span, .bl__when > span:not(.ui-tag) { font-size: var(--t-2); }
  /* 没有表头，「刚刚」后面写上「更新」 / With no head, 刚刚 is followed by 更新 */
  .bl__updated { display: inline; }
  .bl__acts { display: contents; }
  .bl__acts > .ui-switch { grid-area: switch; justify-self: end; }
  .bl__acts > :deep(.ui-menu-host) { grid-area: menu; }
  .bl__note { padding-inline: var(--s-4); }
  .bl__own { padding-inline: var(--s-4); }
  /* 每条问题固定两行：第一行行号和原因，第二行划掉的原文；条与条之间空开 / Each problem keeps two lines, the line number and reason, then the struck
     text; items are spaced apart */
  .bl__problems { row-gap: var(--s-3); }
  .bl__problem { row-gap: 2px; }
  .bl__lineno { min-width: 0; }
  .bl__problem s { order: 2; flex-basis: 100%; }
  .bl__problem > span:last-child { flex: 1 1 0; min-width: 0; }
  .bl__sets { padding-inline: var(--s-4); }
  .bl__sets .ui-setrow { grid-template-columns: minmax(0, 1fr); }
  .blp__item { grid-template-columns: auto minmax(0, 1fr); row-gap: 2px; }
  .blp__meta { grid-column: 2; text-align: left; }
}
</style>
