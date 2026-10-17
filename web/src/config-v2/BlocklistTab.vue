<script setup lang="ts">
import { ExternalLink, ListPlus, Plus, RefreshCw, ShieldBan, TriangleAlert, X } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { BlocklistSkippedLine } from '../api/types'
import UiDotText from '../components/ui/UiDotText.vue'
import UiEmpty from '../components/ui/UiEmpty.vue'
import UiHelp from '../components/ui/UiHelp.vue'
import UiMenu from '../components/ui/UiMenu.vue'
import UiSelect from '../components/ui/UiSelect.vue'
import { useToast } from '../composables/useToast'
import { parseOwnRules, PRESETS, skipText, subscriptionName, type Skip } from '../config-model/blocklist'
import { blockLabel, type Subscription } from '../config-model/model'
import { formatAgo, formatVersionTime } from '../utils'
import { usePhone } from './phone'
import { appliedModel, changedSubscriptionIds, model, newId } from './store'
import { blocklists, loadBlocklists, rebuildBlocklists, saveBlocklistSchedule } from './useBlocklists'
import { fmtCount } from './view'

// 拦截列表：订阅的列表一行一个，像域名映射那样一张卡片；下面是自己写的规则和两项设置。订阅和自己写的规则都在草稿里，
// 保存以后生效；列表下载、合并由面板服务端做，自动更新也在服务端。
// Blocklists: one subscribed list per row, a card like the mapping list; under it the rules of one's own and two settings.
// Subscriptions and own rules live in the draft and take effect on save; the panel server downloads, merges and updates the lists.
const router = useRouter()
const phone = usePhone()
const toast = useToast()
onMounted(() => void loadBlocklists())

const MAX_SUBSCRIPTIONS = 32
const subscriptions = computed(() => model.blocklists.subscriptions)
const host = (url: string) => { try { return new URL(url).host } catch { return url } }
const statusOf = (s: Subscription) => blocklists.sources[s.url]
const held = (s: Subscription) => Boolean(statusOf(s)?.sha256)
const downloading = (s: Subscription) => blocklists.downloading.has(s.url)
const added = (s: Subscription) => !appliedModel.value.blocklists.subscriptions.some((x) => x.id === s.id)
// 「18.6 万条」「6,540 条」：带单位时不再隔空格 / 「18.6 万条」, 「6,540 条」: no space once a unit is there
const ruleCount = (n: number) => (n >= 1e4 ? `${fmtCount(n)}条` : `${fmtCount(n)}\u00a0条`)
const failed = computed(() => subscriptions.value.filter((s) => statusOf(s)?.last_error && !downloading(s)))
// 原因是服务端的话，已经说了哪里没成功；这里补一句还在用哪天的那份（少了一半没换上的，原因里已经说了在用上一份），
// 一份都没有的说怎么再试：没下载成功的不会自己再下
// The reason is the server's sentence and says what failed; this adds which copy is still in use (one held back for shrinking says so
// in its reason), or, with no copy at all, how to try again: a failed download is not retried on its own
function failNote(s: Subscription): string {
  const status = statusOf(s)!
  const held = status.sha256 && status.downloaded_at
  const tail = !held ? '点这一行「…」里的「立即更新」重新下载。' : status.rejected_sha256 ? '' : `还在用 ${formatAgo(status.downloaded_at! * 1000)}下载的那份。`
  return `${s.name}：${status.last_error}。${tail}`
}

const rowMenu = (s: Subscription) => {
  const skipped = statusOf(s)?.summary.skipped ?? 0
  return [
    { value: 'update', label: '立即更新', disabled: downloading(s) },
    { value: 'skipped', label: skipped ? `查看没用上的 ${fmtCount(skipped)} 条` : '没有没用上的规则', disabled: !skipped },
    { value: 'open', label: '打开链接' },
    { value: 'delete', label: '删除', danger: true },
  ]
}
const skippedOf = ref<Subscription | null>(null)
const skippedDialog = ref<HTMLDialogElement | null>(null)
const samples = computed(() => (skippedOf.value ? statusOf(skippedOf.value)?.summary.samples ?? [] : []))
const sampleText = (line: BlocklistSkippedLine) => skipText({ reason: line.reason, modifier: line.modifier } as Skip)
function act(s: Subscription, value: string): void {
  if (value === 'update') void rebuildBlocklists([s.url])
  else if (value === 'skipped') { skippedOf.value = s; skippedDialog.value?.showModal() }
  else if (value === 'open') window.open(s.url, '_blank', 'noopener,noreferrer')
  else if (value === 'delete') {
    const at = model.blocklists.subscriptions.indexOf(s)
    model.blocklists.subscriptions.splice(at, 1)
    void rebuildBlocklists()
    toast.undoable(`已删除「${s.name}」`, () => { model.blocklists.subscriptions.splice(at, 0, s); void rebuildBlocklists() })
  }
}
function toggle(s: Subscription, on: boolean): void {
  s.enabled = on
  void rebuildBlocklists()
}
const updateAll = () => void rebuildBlocklists(subscriptions.value.map((s) => s.url))
const busy = computed(() => blocklists.downloading.size > 0)

// 添加：粘贴链接，或者从推荐的里挑；加上以后马上下载，保存以后生效 / Adding: paste a link or pick suggested lists; the download starts at once and it takes effect on save
const addUrl = ref('')
const addError = ref('')
function subscribe(urls: string[]): void {
  for (const url of urls) model.blocklists.subscriptions.push({ id: newId(), name: subscriptionName(url), url, enabled: true })
  void rebuildBlocklists()
}
function addFromUrl(): void {
  const url = addUrl.value.trim()
  if (!url) return
  let parsed: URL
  try { parsed = new URL(url) } catch { addError.value = '链接写得不对'; return }
  if (parsed.protocol !== 'https:') addError.value = '链接只能用 https://'
  else if (subscriptions.value.some((s) => s.url === url)) addError.value = '已经订阅了这个列表'
  else if (subscriptions.value.length >= MAX_SUBSCRIPTIONS) addError.value = `最多订阅 ${MAX_SUBSCRIPTIONS} 个列表`
  else { subscribe([url]); addUrl.value = ''; addError.value = '' }
}
const presetDialog = ref<HTMLDialogElement | null>(null)
const picked = ref<string[]>([])
const subscribed = (url: string) => subscriptions.value.some((s) => s.url === url)
const memoryText = (mib: number) => (mib < 1 ? '内存不到 1\u00a0MiB' : `内存约 ${mib}\u00a0MiB`)
function openPresets(): void {
  picked.value = []
  presetDialog.value?.showModal()
}
function addPicked(): void {
  subscribe(PRESETS.filter((p) => picked.value.includes(p.url) && !subscribed(p.url)).map((p) => p.url))
  presetDialog.value?.close()
}

// 「拦不下」三个字不拆开：手机上一行放不下时整个挪到下一行 / 拦不下 stays together: when a phone line runs out it moves down whole
const ownLead = '比订阅的列表优先：这里放行的域名，哪个列表都拦\u2060不\u2060下'
// 自己写的规则：只把没用上的行指出来，写对了就不打扰 / Own rules: only the lines left unused are pointed out; correct ones stay quiet
const problems = computed(() => parseOwnRules(model.blocklists.custom).problems)
const customRows = computed(() => Math.min(12, Math.max(5, model.blocklists.custom.split('\n').length + 1)))

const scheduleOptions = [{ value: '0', label: '关闭' }, { value: '24', label: '每天' }, { value: '168', label: '每周' }]
const schedule = computed(() => blocklists.schedule)
const scheduleParts = computed(() => {
  const s = schedule.value
  if (!s?.interval_hours) return []
  return [s.next_run_at ? `下次 ${formatVersionTime(s.next_run_at)}` : '', s.last_success_at ? `上次成功 ${formatAgo(s.last_success_at * 1000)}` : ''].filter(Boolean)
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
        <label class="rw__field bl__url"><input v-model="addUrl" aria-label="列表的链接" :placeholder="phone ? '添加列表：粘贴链接' : '添加列表：粘贴链接，如 https://example.com/filter.txt'" autocapitalize="off" spellcheck="false" @input="addError = ''"></label>
        <button class="ui-btn ui-btn--secondary rw__submit" :class="{ 'ui-btn--sm': !phone }" type="submit" :disabled="!addUrl.trim()">添加</button>
      </form>
      <p v-if="addError" class="bl__error" role="alert">{{ addError }}</p>
      <UiEmpty v-if="!subscriptions.length" :icon="ShieldBan" title="还没有订阅拦截列表" desc="从推荐的列表里挑一个，或者在上面粘贴 AdGuard、Adblock 规则和 hosts 文件的链接。">
        <button class="ui-btn ui-btn--secondary" type="button" @click="openPresets"><ListPlus :size="16" aria-hidden="true" />推荐的列表</button>
      </UiEmpty>
      <template v-else>
        <div class="bl__cols" aria-hidden="true"><span>列表</span><span>规则</span><span>更新</span><span>启用</span><span></span></div>
        <ul class="bl__list">
          <li v-for="s in subscriptions" :key="s.id" class="bl__row" :class="{ 'is-off': !s.enabled }">
            <span class="bl__name"><b>{{ s.name }}<span v-if="changedSubscriptionIds.has(s.id)" class="ui-dot ui-dot--ink bl__changed" role="img" :aria-label="added(s) ? '新加的，还没保存' : '改过，还没保存'" :title="added(s) ? '新加的，还没保存' : '改过，还没保存'"></span></b><small>{{ host(s.url) }}</small></span>
            <span class="bl__rules"><span>{{ held(s) ? ruleCount(statusOf(s)!.summary.rules) : '—' }}</span><small v-if="held(s) && statusOf(s)!.summary.skipped">{{ fmtCount(statusOf(s)!.summary.skipped) }}&nbsp;条没用上</small></span>
            <span class="bl__when">
              <span v-if="downloading(s)" class="bl__busy"><RefreshCw :size="14" class="spin" aria-hidden="true" />下载中</span>
              <span v-else-if="statusOf(s)?.last_error" class="ui-tag ui-tag--warn" :title="statusOf(s)!.last_error!">{{ held(s) ? '更新失败' : '没下载成功' }}</span>
              <span v-else-if="statusOf(s)?.downloaded_at">{{ formatAgo(statusOf(s)!.downloaded_at! * 1000) }}</span>
              <span v-else>{{ blocklists.status === 'loading' ? '…' : '还没下载' }}</span>
              <small v-if="!downloading(s) && statusOf(s)?.last_error && statusOf(s)?.downloaded_at">在用 {{ formatAgo(statusOf(s)!.downloaded_at! * 1000) }}的</small>
            </span>
            <label class="ui-switch"><input :checked="s.enabled" type="checkbox" :aria-label="`启用 ${s.name}`" @change="toggle(s, ($event.target as HTMLInputElement).checked)"><i></i></label>
            <UiMenu :items="rowMenu(s)" :label="`${s.name} 的操作`" anchor=".bl__row" @select="act(s, $event)" />
          </li>
        </ul>
        <p v-for="s in failed" :key="s.id" class="bl__note"><TriangleAlert :size="14" aria-hidden="true" />{{ failNote(s) }}</p>
        <p v-if="blocklists.status === 'failed'" class="bl__note"><TriangleAlert :size="14" aria-hidden="true" />读不到各个列表下载得怎么样；订阅照常保存，稍后刷新页面再看。</p>
      </template>
    </section>

    <section class="ui-card bl__card" aria-labelledby="bl-own">
      <header class="bl__head">
        <span class="bl__titles"><h2 id="bl-own">自己写的规则</h2><p>{{ ownLead }}</p></span>
      </header>
      <div class="bl__own">
        <label class="ui-input ui-input--area bl__text"><textarea v-model="model.blocklists.custom" :rows="customRows" aria-label="自己写的规则，一行一条" spellcheck="false" autocapitalize="off" placeholder="||ads.example.com^&#10;@@||cdn.example.com^"></textarea></label>
        <p class="bl__syntax"><span><code>||example.com^</code>拦截它和子域名</span><span><code>@@||example.com^</code>放行它和子域名</span><span><code>example.com</code>只管它本身</span></p>
        <ul v-if="problems.length" class="bl__problems" aria-label="没用上的行">
          <li v-for="p in problems" :key="p.line" class="bl__problem"><span class="bl__lineno">第 {{ p.line }} 行</span><s>{{ p.text }}</s><span>{{ p.problem }}</span></li>
        </ul>
      </div>
    </section>

    <section class="ui-card bl__card bl__sets" aria-label="拦截列表的设置">
      <div class="ui-setrow">
        <span class="ui-setrow__label"><span>自动更新</span><small v-if="schedule?.last_error" class="bl__warn">上次没更新完：{{ schedule.last_error }}</small><small v-else-if="scheduleParts.length"><UiDotText :parts="scheduleParts" /></small><small v-else>只在点「立即更新」「全部更新」时下载</small></span>
        <span class="ui-setrow__control bl__schedule"><UiSelect :model-value="String(schedule?.interval_hours ?? 0)" :options="scheduleOptions" label="自动更新" :disabled="!schedule" @update:model-value="saveBlocklistSchedule($event === '0' ? null : Number($event))" /></span>
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
              <label class="blp__item" :class="{ 'is-done': subscribed(p.url) }">
                <input v-model="picked" type="checkbox" :value="p.url" :disabled="subscribed(p.url)">
                <span class="blp__main"><b>{{ p.name }}</b><small>{{ p.about }}</small></span>
                <span class="blp__meta"><template v-if="subscribed(p.url)">已订阅</template><UiDotText v-else :parts="[ruleCount(p.rules), memoryText(p.memory)]" /></span>
              </label>
            </li>
          </ul>
          <a class="blp__more" href="https://adguard-dns.io/kb/general/dns-filtering-syntax/" target="_blank" rel="noreferrer">其他列表也能用：看支持哪些写法<ExternalLink :size="14" aria-hidden="true" /></a>
        </div>
        <footer class="pdialog__foot"><button class="ui-btn ui-btn--secondary" type="button" @click="presetDialog?.close()">取消</button><button class="ui-btn ui-btn--primary" type="submit" :disabled="!picked.length">{{ picked.length ? `订阅 ${picked.length} 个` : '订阅' }}</button></footer>
      </form>
    </dialog>

    <dialog ref="skippedDialog" class="pdialog" aria-labelledby="bls-title" @click.self="skippedDialog?.close()">
      <div class="pdialog__panel bl__dialog">
        <header class="pdialog__head"><h2 id="bls-title">{{ skippedOf?.name }} 没用上的规则</h2><button class="ui-icon-btn" type="button" aria-label="关闭" @click="skippedDialog?.close()"><X :size="16" /></button></header>
        <div class="pdialog__body">
          <p class="pfield__hint">这些行 DNS 用不上或者还不支持，整条跳过；其余的照常生效。<template v-if="skippedOf && (statusOf(skippedOf)?.summary.skipped ?? 0) > samples.length">下面只列出前 {{ samples.length }} 行。</template></p>
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
.bl__add { display: flex; align-items: center; gap: var(--s-3); padding: var(--s-3) var(--s-5); border-block: 1px solid var(--l-hair); }
.bl__url { flex: 1 1 auto; min-width: 0; }
.bl__url input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--l-ink); font-size: var(--t-3); }
.bl__url input::placeholder { color: var(--l-ink-3); }
.bl__error { margin: 0; padding: var(--s-2) var(--s-5); border-bottom: 1px solid var(--l-hair); color: var(--err-l); font-size: var(--t-2); }
.bl__list { margin: 0; padding: 0; list-style: none; }
.bl__cols, .bl__row { display: grid; grid-template-columns: minmax(0, 1fr) 8rem 9rem var(--s-7) var(--h-sm); column-gap: var(--s-4); align-items: center; padding-inline: var(--s-5); }
.bl__cols { min-height: var(--h-md); color: var(--l-ink-3); font-size: var(--t-1); border-bottom: 1px solid var(--l-hair); }
.bl__cols > :nth-child(4) { text-align: center; }
.bl__row { min-height: var(--h-touch); padding-block: var(--s-2); border-bottom: 1px solid var(--l-hair); }
.bl__row:last-child { border-bottom: 0; }
.bl__row:hover { background: var(--l-canvas); }
.bl__row > .ui-switch { justify-self: center; }
.bl__name, .bl__rules, .bl__when { min-width: 0; display: grid; gap: 1px; }
.bl__name b { overflow: hidden; color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-medium); text-overflow: ellipsis; white-space: nowrap; }
.bl__name small, .bl__rules small, .bl__when small { overflow: hidden; color: var(--l-ink-3); font-size: var(--t-1); text-overflow: ellipsis; white-space: nowrap; }
.bl__rules > span, .bl__when > span:not(.ui-tag) { color: var(--l-ink-2); font-size: var(--t-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.bl__when > .ui-tag { justify-self: start; }
.bl__row.is-off :is(.bl__name b, .bl__rules > span, .bl__when > span) { color: var(--l-ink-3); }
.bl__note { display: flex; align-items: flex-start; gap: var(--s-2); margin: 0; padding: var(--s-3) var(--s-5); border-top: 1px solid var(--l-hair); color: var(--warn-l); font-size: var(--t-2); line-height: var(--lh-base); }
.bl__note > svg { flex-shrink: 0; margin-top: calc((1lh - 14px) / 2); }
.bl__own { display: grid; gap: var(--s-2); padding: 0 var(--s-5) var(--s-4); }
.bl__text textarea { font-family: var(--f-mono); font-size: var(--t-2); white-space: pre; overflow-x: auto; overflow-wrap: normal; }
.bl__changed { display: inline-block; margin-left: var(--s-2); vertical-align: middle; }
.bl__busy { display: inline-flex; align-items: center; gap: var(--s-1); }
.bl__syntax { display: flex; flex-wrap: wrap; gap: var(--s-1) var(--s-4); margin: 0; color: var(--l-ink-3); font-size: var(--t-1); }
.bl__syntax > span { display: inline-flex; align-items: baseline; gap: var(--s-1); white-space: nowrap; }
.bl__syntax code { padding: 0 var(--s-1); border-radius: var(--r-1); background: var(--l-sunk); color: var(--l-ink-2); font-family: var(--f-mono); }
.bl__problems { display: grid; gap: var(--s-1); margin: 0; padding: 0; list-style: none; color: var(--l-ink-2); font-size: var(--t-2); }
.bl__problem { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-1) var(--s-2); }
.bl__lineno { color: var(--l-ink-3); }
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
.blp__item:hover { background: var(--l-canvas); }
.blp__item.is-done { cursor: default; }
.blp__item.is-done :is(b, small) { color: var(--l-ink-3); }
.blp__main { display: grid; gap: 1px; min-width: 0; }
.blp__main b { color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-medium); }
.blp__main small { color: var(--l-ink-3); font-size: var(--t-1); }
/* 条数和内存是数值，按数据的字号 / Count and memory are values, set as data */
.blp__meta { color: var(--l-ink-2); font-size: var(--t-2); text-align: right; font-variant-numeric: tabular-nums; }
.blp__more { display: inline-flex; align-items: center; gap: var(--s-1); color: var(--l-ink-2); font-size: var(--t-2); }
@media (max-width: 640px) {
  .bl__head { padding: var(--s-4) var(--s-4) var(--s-2); }
  .bl__tools { margin-left: calc(var(--s-2) * -1); }
  .bl__add { padding: var(--s-2) var(--s-4); }
  .bl__error { padding-inline: var(--s-4); }
  .bl__cols { display: none; }
  /* 第一行名字、「…」和开关并排，第二行规则数和更新时间 / Name, 「…」 and the switch first, then the rule count and update time */
  .bl__row { grid-template-columns: minmax(0, 1fr) auto auto; grid-template-areas: "n menu switch"; row-gap: var(--s-1); padding: var(--s-2) var(--s-4); }
  .bl__name { grid-area: n; }
  /* 手机上不写来源网址：每个列表两行，名字一行，条数和更新时间一行 / No source host on phones: two lines per list, the name, then the count and update time */
  .bl__name small { display: none; }
  /* 第二行的两段都横跨整行，一左一右：长的更新状态不再把上面「…」那一列撑宽 / Both parts of the second line span the row, one left
     and one right, so a long update state no longer widens the 「…」 column above */
  .bl__rules { grid-area: 2 / 1 / 3 / 4; justify-self: start; display: flex; gap: var(--s-2); align-items: baseline; }
  .bl__when { grid-area: 2 / 1 / 3 / 4; justify-self: end; display: flex; gap: var(--s-2); align-items: baseline; }
  .bl__rules > span, .bl__when > span:not(.ui-tag) { font-size: var(--t-2); }
  .bl__row > .ui-switch { grid-area: switch; justify-self: end; }
  .bl__row > :deep(.ui-menu-host) { grid-area: menu; }
  .bl__note { padding-inline: var(--s-4); }
  .bl__own { padding-inline: var(--s-4); }
  .bl__sets { padding-inline: var(--s-4); }
  .bl__sets .ui-setrow { grid-template-columns: minmax(0, 1fr); }
  .blp__item { grid-template-columns: auto minmax(0, 1fr); row-gap: 2px; }
  .blp__meta { grid-column: 2; text-align: left; }
}
</style>
