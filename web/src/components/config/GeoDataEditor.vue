<script setup lang="ts">
import {
  CircleCheck,
  Download,
  FolderOpen,
  Link2,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X,
} from '@lucide/vue'
import UiSelect from '../ui/UiSelect.vue'
import UiTabs from '../ui/UiTabs.vue'
import UiUrlField from '../ui/UiUrlField.vue'
import UiDotText from '../ui/UiDotText.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { apiRequest, jsonBody } from '../../api/client'
import type {
  GeoDataCleanupResult,
  GeoDataManifest,
  GeoDataResource,
  GeoDataSchedule,
  GeoDataSyncRequest,
} from '../../api/types'
import type { GlobalSettings } from '../../config-editor/types'
import { errorMessage, formatAgo, formatVersionTime } from '../../utils'

type GeoMode = 'remote' | 'local'

const settings = defineModel<GlobalSettings>({ required: true })
// changed：草稿里改过的设置 key，对应的那一行名字后面画墨点 / changed: setting keys the draft changed; the matching row gets an ink dot after its name
defineProps<{ changed?: ReadonlySet<string> }>()
const mode = ref<GeoMode>('remote')
const modeItems = [{ value: 'remote', label: '远程链接', icon: Link2 }, { value: 'local', label: '本地路径', icon: FolderOpen }]
const manifest = ref<GeoDataManifest>({ geoip_mmdb: null, geoip_dat: null, geosite: [] })
const schedule = ref<GeoDataSchedule>({
  interval_hours: null,
  last_attempt_at: null,
  last_success_at: null,
  last_error: null,
  next_run_at: null,
})
const mmdbUrl = ref('')
const datUrl = ref('')
const geositeUrls = ref<string[]>([''])
const loading = ref(true)
const syncing = ref(false)
const scheduleSaving = ref(false)
const cleaning = ref(false)
const statusError = ref('')
const syncNotice = ref('')
// 下载要等几秒：下载那一行写已用时间，和保存条一样。 / Downloading takes seconds: its row shows elapsed time, as the save bar does.
const syncStartedAt = ref(0)
const syncClock = ref(0)
let syncTicker: ReturnType<typeof setInterval> | undefined
watch(syncing, (on) => {
  clearInterval(syncTicker)
  if (!on) return
  syncStartedAt.value = Date.now()
  syncClock.value = syncStartedAt.value
  syncTicker = setInterval(() => { syncClock.value = Date.now() }, 100)
})
onBeforeUnmount(() => clearInterval(syncTicker))
const syncElapsed = computed(() => {
  const seconds = (syncClock.value - syncStartedAt.value) / 1000
  return syncing.value && seconds >= 1 ? `已用 ${seconds.toFixed(1)} 秒` : ''
})
let noticeTimer: number | undefined

// 一项 Geo 数据先写文件（规范 3.11）：下载过的写「文件名 · 大小 · 几天前」，填了链接还没下载的写文件名和「还没下载」。
// A Geo item leads with its file (spec 3.11): a downloaded one reads name · size · how long ago; a link not yet
// downloaded reads its file name and 还没下载.
interface FileLine { name: string; meta: string[] }
function fileName(location: string): string {
  const last = location.trim().replace(/[?#].*$/, '').split('/').filter(Boolean).at(-1) ?? ''
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}
function fileLine(resource: GeoDataResource | null | undefined, url: string): FileLine | null {
  const downloaded = resourceStatus(resource, url)
  // 名字取链接里的文件名：面板下载后按摘要改了名，那个名字认不出来 / The name comes from the link: the panel renames downloads by hash, which nobody recognises
  if (downloaded) return { name: fileName(url) || fileName(downloaded.path), meta: [formatSize(downloaded.size), formatAgo(downloaded.downloaded_at)] }
  return url.trim() ? { name: fileName(url), meta: ['还没下载'] } : null
}


function clearSyncNotice(): void {
  syncNotice.value = ''
  if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
  noticeTimer = undefined
}

function showSyncNotice(message: string): void {
  clearSyncNotice()
  syncNotice.value = message
  noticeTimer = window.setTimeout(clearSyncNotice, 6000)
}

function stringSetting(key: string): string {
  const value = settings.value[key]
  return typeof value === 'string' ? value : ''
}

function listSetting(key: string): string[] {
  const value = settings.value[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function setStringSetting(key: string, event: Event): void {
  const value = (event.currentTarget as HTMLInputElement).value
  if (value) settings.value[key] = value
  else delete settings.value[key]
}

// 链接里不会有空白：粘贴带进来的换行和空格直接去掉 / A link has no whitespace: pasted line breaks and spaces are dropped
function linkValue(value: string): string {
  return value.replace(/\s+/g, '')
}

function setRemoteUrl(target: 'mmdb' | 'dat', value: string): void {
  if (target === 'mmdb') mmdbUrl.value = linkValue(value)
  else datUrl.value = linkValue(value)
}

function setRemoteGeosite(index: number, value: string): void {
  geositeUrls.value[index] = linkValue(value)
}

function setLocalGeosite(index: number, event: Event): void {
  const next = [...listSetting('geosite_data_paths')]
  next[index] = (event.currentTarget as HTMLInputElement).value
  settings.value.geosite_data_paths = next
}

function addRemoteGeosite(): void {
  if (geositeUrls.value.length < 8) geositeUrls.value.push('')
}

function addLocalGeosite(): void {
  settings.value.geosite_data_paths = [...listSetting('geosite_data_paths'), '']
}

function removeRemoteGeosite(index: number): void {
  geositeUrls.value.splice(index, 1)
  if (geositeUrls.value.length === 0) geositeUrls.value.push('')
}

function removeLocalGeosite(index: number): void {
  settings.value.geosite_data_paths = listSetting('geosite_data_paths').filter((_, current) => current !== index)
}

function resourceStatus(resource: GeoDataResource | null | undefined, url: string): GeoDataResource | null {
  return resource?.url === url.trim() ? resource : null
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function isManagedConfiguration(next: GeoDataManifest): boolean {
  const mmdbPath = stringSetting('geoip_db_path')
  const datPath = stringSetting('geoip_dat_path')
  const sitePaths = listSetting('geosite_data_paths').filter(Boolean)
  if (!mmdbPath && !datPath && sitePaths.length === 0) return true
  return mmdbPath === (next.geoip_mmdb?.path ?? '')
    && datPath === (next.geoip_dat?.path ?? '')
    && sitePaths.length === next.geosite.length
    && sitePaths.every((path, index) => path === next.geosite[index]?.path)
}

function fillUrls(next: GeoDataManifest): void {
  mmdbUrl.value = next.geoip_mmdb?.url ?? ''
  datUrl.value = next.geoip_dat?.url ?? ''
  geositeUrls.value = next.geosite.length > 0 ? next.geosite.map((resource) => resource.url) : ['']
}

function validateUrl(value: string): void {
  if (!value) return
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Geo 数据链接格式不正确')
  }
  if (parsed.protocol !== 'https:') throw new Error('Geo 数据链接仅允许使用 HTTPS')
  if (parsed.username || parsed.password) throw new Error('Geo 数据链接不能包含用户名或密码')
}

async function loadManifest(): Promise<void> {
  loading.value = true
  statusError.value = ''
  try {
    const [next, nextSchedule] = await Promise.all([
      apiRequest<GeoDataManifest>('/api/v1/config/geo-data'),
      apiRequest<GeoDataSchedule>('/api/v1/config/geo-data/schedule'),
    ])
    manifest.value = next
    schedule.value = nextSchedule
    fillUrls(next)
    mode.value = isManagedConfiguration(next) ? 'remote' : 'local'
  } catch (error) {
    statusError.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

const scheduleOptions = [{ value: '', label: '关闭' }, { value: '24', label: '每天' }, { value: '168', label: '每周' }]

async function saveSchedule(raw: string): Promise<void> {
  statusError.value = ''
  clearSyncNotice()
  const interval = raw === '' ? null : Number(raw) as 24 | 168
  scheduleSaving.value = true
  try {
    schedule.value = await apiRequest<GeoDataSchedule>('/api/v1/config/geo-data/schedule', {
      method: 'PUT',
      ...jsonBody({ interval_hours: interval }),
    })
    showSyncNotice(interval === null ? 'Geo 自动更新已关闭' : `Geo 自动更新已设为${interval === 24 ? '每天' : '每周'}`)
  } catch (error) {
    statusError.value = errorMessage(error)
  } finally {
    scheduleSaving.value = false
  }
}

async function cleanupGeoData(): Promise<void> {
  statusError.value = ''
  clearSyncNotice()
  cleaning.value = true
  try {
    const result = await apiRequest<GeoDataCleanupResult>('/api/v1/config/geo-data/cleanup', { method: 'POST' })
    showSyncNotice(result.removed_files === 0
      ? '没有可清理的 Geo 文件'
      : `已清理 ${result.removed_files} 个文件，释放 ${formatSize(result.reclaimed_bytes)}`)
  } catch (error) {
    statusError.value = errorMessage(error)
  } finally {
    cleaning.value = false
  }
}

async function syncRemote(): Promise<void> {
  statusError.value = ''
  clearSyncNotice()
  try {
    const geosite = geositeUrls.value.map((value) => value.trim()).filter(Boolean)
    const mmdb = mmdbUrl.value.trim()
    const dat = datUrl.value.trim()
    ;[mmdb, dat, ...geosite].forEach(validateUrl)
    syncing.value = true
    const request: GeoDataSyncRequest = {
      geoip_mmdb_url: mmdb || null,
      geoip_dat_url: dat || null,
      geosite_urls: geosite,
    }
    const next = await apiRequest<GeoDataManifest>('/api/v1/config/geo-data/sync', {
      method: 'POST',
      ...jsonBody(request),
    })
    manifest.value = next
    fillUrls(next)
    if (next.geoip_mmdb) settings.value.geoip_db_path = next.geoip_mmdb.path
    else delete settings.value.geoip_db_path
    if (next.geoip_dat) settings.value.geoip_dat_path = next.geoip_dat.path
    else delete settings.value.geoip_dat_path
    settings.value.geosite_data_paths = next.geosite.map((resource) => resource.path)
    showSyncNotice('已下载，文件路径已填进草稿')
  } catch (error) {
    statusError.value = errorMessage(error)
  } finally {
    syncing.value = false
  }
}

onMounted(loadManifest)
onBeforeUnmount(clearSyncNotice)
</script>

<template>
  <!-- Geo 数据和其他设置同一种写法：一行一项，左边名字，右边这一项的值。远程链接这一栏先写文件
       （「文件名  大小 · 几天前」，× 在这一行末尾），下面是地址框，只在「/」后面换行；所有地址框右边对齐。
       Geo data in the settings form: one item per row, the name left and its value right. For remote links the file
       comes first (name, then size · how long ago, × at the end of that line) with the link box below, which breaks
       only after a "/"; every link box ends on the same line. -->
  <!-- 链接列表在读取完成时会按服务器的记录重填，所以读取期间增删按钮和输入框一样先禁用，免得刚加的一行被覆盖。
       The link list is refilled from the server when loading finishes, so add and remove stay disabled
       during loading like the inputs, lest a row just added be overwritten. -->
  <div class="geo">
    <div class="ui-setrow">
      <span class="ui-setrow__label"><span>数据来源</span><small>{{ mode === 'remote' ? '面板按链接下载文件' : '直接写路由器上已有文件的位置' }}</small></span>
      <span class="ui-setrow__control"><UiTabs :model-value="mode" :items="modeItems" label="Geo 数据来源" variant="segment" @update:model-value="mode = $event as GeoMode" /></span>
    </div>

    <template v-if="mode === 'remote'">
      <div class="ui-setrow geo-row">
        <span class="ui-setrow__label"><span>GeoIP MMDB<i v-if="changed?.has('geoip_db_path')" class="ui-dot ui-dot--ink geo-dot" aria-hidden="true"></i></span><small v-if="!mmdbUrl">国家数据库，GeoIP 条件用它</small></span>
        <span class="geo-item">
          <span v-if="fileLine(manifest.geoip_mmdb, mmdbUrl)" class="geo-file"><span class="geo-file__main"><b>{{ fileLine(manifest.geoip_mmdb, mmdbUrl)!.name }}</b><span class="geo-file__meta"><UiDotText :parts="fileLine(manifest.geoip_mmdb, mmdbUrl)!.meta" /></span></span></span>
          <label class="ui-input ui-input--area geo-link"><UiUrlField :model-value="mmdbUrl" label="GeoIP MMDB 链接" placeholder="如 https://example.com/GeoLite2-Country.mmdb" :disabled="loading || syncing" @update:model-value="setRemoteUrl('mmdb', $event)" /></label>
        </span>
      </div>
      <div class="ui-setrow geo-row">
        <span class="ui-setrow__label"><span>GeoIP DAT<i v-if="changed?.has('geoip_dat_path')" class="ui-dot ui-dot--ink geo-dot" aria-hidden="true"></i></span><small v-if="!datUrl">和 MMDB 二选一即可</small></span>
        <span class="geo-item">
          <span v-if="fileLine(manifest.geoip_dat, datUrl)" class="geo-file"><span class="geo-file__main"><b>{{ fileLine(manifest.geoip_dat, datUrl)!.name }}</b><span class="geo-file__meta"><UiDotText :parts="fileLine(manifest.geoip_dat, datUrl)!.meta" /></span></span></span>
          <label class="ui-input ui-input--area geo-link"><UiUrlField :model-value="datUrl" label="GeoIP DAT 链接" placeholder="如 https://example.com/geoip.dat" :disabled="loading || syncing" @update:model-value="setRemoteUrl('dat', $event)" /></label>
        </span>
      </div>
      <div class="ui-setrow geo-row">
        <span class="ui-setrow__label"><span>GeoSite<i v-if="changed?.has('geosite_data_paths')" class="ui-dot ui-dot--ink geo-dot" aria-hidden="true"></i></span><small v-if="!geositeUrls.some(Boolean)">域名分类数据</small></span>
        <span class="geo-list">
          <span v-for="(url, index) in geositeUrls" :key="index" class="geo-item">
            <span class="geo-file">
              <span class="geo-file__main"><template v-if="fileLine(manifest.geosite[index], url)"><b>{{ fileLine(manifest.geosite[index], url)!.name }}</b><span class="geo-file__meta"><UiDotText :parts="fileLine(manifest.geosite[index], url)!.meta" /></span></template></span>
              <button class="ui-icon-btn ui-icon-btn--sm geo-file__remove" type="button" :title="`删除 GeoSite 链接 ${index + 1}`" :aria-label="`删除 GeoSite 链接 ${index + 1}`" :disabled="loading || syncing" @click="removeRemoteGeosite(index)"><X :size="14" /></button>
            </span>
            <label class="ui-input ui-input--area geo-link"><UiUrlField :model-value="url" :label="`GeoSite 链接 ${index + 1}`" placeholder="如 https://example.com/geosite.dat" :disabled="loading || syncing" @update:model-value="setRemoteGeosite(index, $event)" /></label>
          </span>
          <button class="ui-btn ui-btn--text ui-btn--sm geo-list__add" type="button" :disabled="loading || geositeUrls.length >= 8 || syncing" @click="addRemoteGeosite"><Plus :size="14" aria-hidden="true" />添加链接</button>
        </span>
      </div>
      <!-- 下载按上面这些链接来：「数据来源」那句已经说了会做什么，这一行不再另起名字和说明（审计 T8）
           The download works from the links above; 数据来源 already says what it does, so this row has no name or note of its own (audit T8) -->
      <div class="ui-setrow geo-actions-row">
        <span class="ui-setrow__label" aria-hidden="true"></span>
        <span class="geo-actions">
          <span class="geo-actions__main">
            <button class="ui-btn ui-btn--secondary" type="button" :disabled="loading || syncing" @click="syncRemote"><RefreshCw v-if="syncing" :size="16" class="spin" aria-hidden="true" /><Download v-else :size="16" aria-hidden="true" />{{ syncing ? '下载中' : '下载并填入配置' }}</button>
            <small v-if="syncElapsed" class="geo-elapsed">{{ syncElapsed }}</small>
          </span>
          <button class="ui-btn ui-btn--text geo-clean" type="button" aria-label="清理未引用的 Geo 文件" :disabled="loading || syncing || cleaning" @click="cleanupGeoData"><RefreshCw v-if="cleaning" :size="16" class="spin" aria-hidden="true" /><Trash2 v-else :size="16" aria-hidden="true" />清理用不到的文件</button>
        </span>
      </div>
      <div class="ui-setrow">
        <span class="ui-setrow__label"><span>自动更新</span><small v-if="schedule.next_run_at || schedule.last_success_at"><UiDotText :parts="[schedule.next_run_at ? `下次 ${formatVersionTime(schedule.next_run_at)}` : '', schedule.last_success_at ? `上次成功 ${formatVersionTime(schedule.last_success_at)}` : ''].filter(Boolean)" /></small><small v-else>定时按上面的链接重新下载</small></span>
        <span class="ui-setrow__control geo-schedule"><UiSelect :model-value="String(schedule.interval_hours ?? '')" :options="scheduleOptions" label="自动更新" :disabled="loading || scheduleSaving || syncing" @update:model-value="saveSchedule" /></span>
      </div>
      <p v-if="schedule.last_error" class="geo-note geo-note--err"><TriangleAlert :size="14" aria-hidden="true" />后台更新失败：{{ schedule.last_error }}</p>
      <p v-if="syncNotice" class="geo-note geo-note--ok ui-rise" role="status" aria-live="polite"><CircleCheck :size="14" aria-hidden="true" />{{ syncNotice }}</p>
      <p v-if="statusError" :key="statusError" class="geo-note geo-note--err ui-shake" role="alert"><TriangleAlert :size="14" aria-hidden="true" />{{ statusError }}</p>
    </template>

    <template v-else>
      <label class="ui-setrow"><span class="ui-setrow__label"><span>GeoIP MMDB 文件<i v-if="changed?.has('geoip_db_path')" class="ui-dot ui-dot--ink geo-dot" aria-hidden="true"></i></span></span><span class="geo-path"><span class="ui-input"><input class="mono" type="text" :value="stringSetting('geoip_db_path')" aria-label="MMDB 文件路径" placeholder="如 /path/to/GeoLite2-Country.mmdb" @input="setStringSetting('geoip_db_path', $event)"></span><span aria-hidden="true"></span></span></label>
      <label class="ui-setrow"><span class="ui-setrow__label"><span>GeoIP DAT 文件<i v-if="changed?.has('geoip_dat_path')" class="ui-dot ui-dot--ink geo-dot" aria-hidden="true"></i></span></span><span class="geo-path"><span class="ui-input"><input class="mono" type="text" :value="stringSetting('geoip_dat_path')" aria-label="GeoIP DAT 文件路径" placeholder="如 /path/to/geoip.dat" @input="setStringSetting('geoip_dat_path', $event)"></span><span aria-hidden="true"></span></span></label>
      <div class="ui-setrow geo-row">
        <span class="ui-setrow__label"><span>GeoSite 文件<i v-if="changed?.has('geosite_data_paths')" class="ui-dot ui-dot--ink geo-dot" aria-hidden="true"></i></span></span>
        <span class="geo-list">
          <span v-for="(path, index) in listSetting('geosite_data_paths')" :key="index" class="geo-path"><span class="ui-input"><input class="mono" type="text" :value="path" placeholder="如 /path/to/geosite.dat" :aria-label="`GeoSite 文件路径 ${index + 1}`" @input="setLocalGeosite(index, $event)"></span><button class="ui-icon-btn" type="button" :title="`删除 GeoSite 路径 ${index + 1}`" :aria-label="`删除 GeoSite 路径 ${index + 1}`" @click="removeLocalGeosite(index)"><X :size="16" /></button></span>
          <button class="ui-btn ui-btn--text ui-btn--sm geo-list__add" type="button" @click="addLocalGeosite"><Plus :size="14" aria-hidden="true" />添加路径</button>
        </span>
      </div>
      <p v-if="statusError" :key="statusError" class="geo-note geo-note--err ui-shake" role="alert"><TriangleAlert :size="14" aria-hidden="true" />{{ statusError }}</p>
    </template>
    <!-- 「自动转换 MMDB」和「转换国家过滤」不再显示：锁定的内核只把这两项算进配置指纹，运行时不读（审计 T4）；配置里写了的照样保留。
         自动转换 MMDB and 转换国家过滤 are no longer shown: the locked kernel only hashes them into the config fingerprint and never
         reads them at run time (audit T4); values already in the config are kept. -->
  </div>
</template>

<style scoped>
/* Geo 数据只补设置行没有的几样：先写文件的一项、多行链接列表、两个动作和成败提示。
   Only what the setting row lacks: the file-first item, the multi-link list, the two actions and the notes. */
.geo { display: grid; gap: 2px; }
/* 文件那一行在最上面时，名字对着文件那一行（32 高）；没有文件行时和别的设置一样对着框的第一行（审计第二轮 T1）
   With a file line on top, the name lines up with it (32 tall); without one it lines up with the box's first line like any setting (audit round 2, T1) */
.geo-row:has(.geo-file) .ui-setrow__label { padding-top: calc((var(--h-sm) - 1lh) / 2); }
.geo-dot { margin-inline-start: var(--s-2); vertical-align: .1em; }
.geo-list { min-width: 0; display: grid; gap: var(--s-4); }
.geo-item { min-width: 0; display: grid; gap: var(--s-1); }
/* 文件那一行：名字（等宽、名称）后面跟「大小 · 几天前」一整块，放不下就整块挪下去，不会有哪一行以「·」开头；× 固定在这一行的末尾
   The file line: the name, then 「size · how long ago」 as one unit that moves down whole, so no line starts with 「·」; the × stays at this line's end */
.geo-file { min-height: var(--h-sm); display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--s-2); }
.geo-file__main { min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--s-2); }
.geo-file b { color: var(--l-ink); font-family: var(--f-mono); font-size: var(--t-3); font-weight: var(--w-medium); overflow-wrap: anywhere; }
.geo-file__meta { color: var(--l-ink-2); font-size: var(--t-2); white-space: nowrap; }
/* 链接框：等宽 13 号，放不下就在「/」后面换行（UiUrlField） / The link box: 13px mono, wrapping after a "/" (UiUrlField) */
.geo-link.ui-input--area { font-size: var(--t-2); }
/* 「添加链接」「清理」往回收一格：图标落在框的左边线上（规范 6.5，审计 T9） / 添加链接 and 清理 pulled back so their icons sit on the box edge (spec 6.5, audit T9) */
.geo-list__add { justify-self: start; margin-inline-start: calc(var(--s-3) * -1); }
/* 「添加链接」属于 GeoSite 的链接列表：离最后一条 8；下载和清理管所有 Geo 数据，另起一组，离上面至少 24（规范 6.2，审计第二轮 T4）
   添加链接 belongs to GeoSite's list, 8 under its last link; download and clean-up act on all Geo data and start a group at least 24 below (spec 6.2, audit round 2, T4) */
.geo-list > .geo-list__add { margin-top: calc(var(--s-2) * -1); margin-bottom: calc((1lh - var(--h-sm)) / 2); }
/* 下载和清理是另一组：它的框离上面「添加链接」的字、离下面一项的框都是 24。两行设置之间本来就有上下内边距 8 + 8 和行距 2，
   这里只补差的 6；两边的文字按钮都往回收，看不见的留白不算（规范 6.2，审计第三轮 T2 复查）
   Download and clean-up are a group of their own: its boxes sit 24 from the 添加链接 text above and from the next item below. Two setting
   rows already leave 8 + 8 of padding and a 2 gap, so only the missing 6 is added; the text buttons on either side are pulled back so
   their invisible padding does not count (spec 6.2, audit round 3, T2 re-check) */
.geo-actions-row { margin-block: calc(var(--s-5) - var(--s-2) * 2 - 2px); }
.geo-path { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) var(--h-md); gap: var(--s-1); }
.geo-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); }
.geo-actions__main { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); }
.geo-schedule { max-width: 11rem; }
.geo-note { display: flex; align-items: center; gap: var(--s-1); margin: var(--s-1) 0; font-size: var(--t-2); overflow-wrap: anywhere; }
.geo-note > svg { flex-shrink: 0; }
.geo-note--err { color: var(--err-l); }
.geo-note--ok { color: var(--ok-l); }
.geo-elapsed { color: var(--l-ink-2); font-size: var(--t-2); font-variant-numeric: tabular-nums; }
/* 上下排时：名字在文件行上面，文件行只有一行字高，× 不再把它撑高，名字到文件 8、上一项到这一项 12（审计第二轮 T3）
   Stacked: the name sits above the file line, which is one text line tall with the × no longer stretching it: 8 from name to file, 12 from the item above (audit round 2, T3) */
@container setrows (max-width: 38rem) {
  /* 上下排时那一格空的字段名不占一行：动作行上下一样远（审计第三轮 T2） / Stacked, the empty label cell takes no row, so the actions row sits evenly between its neighbours (audit round 3, T2) */
  .geo-actions-row > .ui-setrow__label { display: none; }
  /* 带文件行的那两项也清零：上面那条规则带 :has()，要写同样的选择器才压得住（审计第三轮 T6） / The two rows with a file line too: the rule above carries :has(), so the same selector is needed to win (audit round 3, T6) */
  .geo-row .ui-setrow__label, .geo-row:has(.geo-file) .ui-setrow__label { padding-top: 0; }
  .geo-file { min-height: 0; align-items: start; }
  .geo-file__remove { margin-block: calc((1lh - var(--h-sm)) / 2); }
}
@media (max-width: 640px) {
  .geo-actions-row > .ui-setrow__label { display: none; }
  .geo-row .ui-setrow__label, .geo-row:has(.geo-file) .ui-setrow__label { padding-top: 0; }
  .geo-file { min-height: 0; align-items: start; }
  /* 文件那一行是下面链接框的字段名，离框只有 4，放不下一个上下对称的 44 格子：× 的格子下沿正好落在自己的链接框上沿，
     往上长，图标仍对着文件那一行；链接之间放宽到 19，格子碰不到上一个链接框（规范 2.1，审计第六轮扫查）
     The file line labels the link box 4 below it, too close for a centred 44 cell: the ×'s cell ends right on its own link box and grows
     upward with the icon still on the file line, and links sit 19 apart so the cell never reaches the link above (spec 2.1, round-6 sweep) */
  .geo-list { gap: calc(var(--h-touch) - 1lh - var(--s-1)); }
  .geo-file__remove { place-items: start center; margin-block: calc(1lh + var(--s-1) - var(--h-touch)) calc(var(--s-1) * -1); padding-top: calc(var(--h-touch) - var(--s-1) - 1lh / 2 - var(--size-icon) / 2); }
  /* 手机上框里的字是 16，防止 iPhone 聚焦时放大整页（规范 1.8） / 16px text on a phone stops iPhone zooming (spec 1.8) */
  .geo-link.ui-input--area { font-size: var(--t-touch); }
  /* 下载和清理是一组：两个 44 的格子上下挨着不叠，清理的字离下载按钮 13 上下，比到下一项的 27 近（规范 6.2，审计第六轮 T1）
     下载 and 清理 are one group: their 44 cells touch without overlapping, so 清理's text sits about 13 under the button, nearer than the
     27 to the next item (spec 6.2, audit round 6, T1) */
  .geo-actions { display: grid; justify-items: stretch; row-gap: 0; }
  .geo-list > .geo-list__add, .geo-clean { margin-bottom: calc((1lh - var(--h-touch)) / 2); }
  /* 手机上「添加链接」的 44 格子比桌面的高 14：往上多收一半，字离最后一个链接框还是 16 上下，和桌面一样挨着自己的列表（审计第四轮 T4）
     On a phone 添加链接's 44 cell is 14 taller than on desktop: half of that is pulled up too, so its text stays about 16 under the last link box and with its list (audit round 4, T4) */
  .geo-list > .geo-list__add { margin-top: calc(var(--s-2) * -1 - (var(--h-touch) - var(--h-sm)) / 2); }
  .geo-actions__main > .ui-btn--secondary { flex: 1; }
  .geo-schedule { max-width: none; }
}
</style>
