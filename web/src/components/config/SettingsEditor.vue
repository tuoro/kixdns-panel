<script setup lang="ts">
import { ChevronLeft, ChevronRight, Plus, Search, X } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { SETTING_SECTIONS, settingShouldRender, settingSupported, settingValue, settingVisible, type SettingField, type SettingSection } from '../../config-editor/schema'
import type { GlobalSettings } from '../../config-editor/types'
import GeoDataEditor from './GeoDataEditor.vue'
import UiDotText from '../ui/UiDotText.vue'

const settings = defineModel<GlobalSettings>({ required: true })
// 配置格式版本不在 settings 里；它只有一项，放在「基础与监听」最后，不单独成组。
// The config format version lives outside settings; being a single field it closes 基础与监听 rather than forming a group of its own.
const version = defineModel<string | undefined>('version')
// changed：草稿里改过的设置 key（格式版本是 version），那一行和它的分组画墨点 / changed: setting keys the draft changed (the format version is version); the row and its group get an ink dot
const props = defineProps<{ capabilities: string[]; changed?: ReadonlySet<string> }>()
const search = ref('')
const searchInput = ref<HTMLInputElement>()
// 左边一列分组、右边一组设置，和解析编排的「左列表、右检查器」同一种版式；手机上先看分组列表，点进去看一组。
// Groups on the left and one group's settings on the right, the same layout as 解析编排's list and
// inspector; a phone shows the group list first and opens one group at a time.
const current = ref('network')
const mobileOpen = ref(false)
const mobileViewport = window.matchMedia('(max-width: 860px)')
const isMobile = ref(mobileViewport.matches)
function resize(event: MediaQueryListEvent): void { isMobile.value = event.matches }
onMounted(() => mobileViewport.addEventListener('change', resize))
onBeforeUnmount(() => mobileViewport.removeEventListener('change', resize))
const query = computed(() => search.value.trim().toLowerCase())
const allFields = SETTING_SECTIONS.flatMap((section) => section.fields)

const visibleSections = computed(() => SETTING_SECTIONS.map((section) => {
  const available = section.fields.filter((field) => supported(field) || Object.hasOwn(settings.value, field.key))
  const matches = available.filter((field) => `${section.title} ${field.label} ${field.key}`.toLowerCase().includes(query.value))
  const relatedKeys = new Set(matches.flatMap((field) => [field.key, ...dependencyKeys(field)]))
  const fields = query.value
    ? available.filter((field) => relatedKeys.has(field.key))
    : available.filter((field) => settingShouldRender(field, settings.value, props.capabilities))
  return { ...section, fields, matchCount: matches.length }
}).filter((section) => section.fields.length > 0))


function dependencyKeys(field: SettingField): string[] {
  return field.visibleWhen ? [field.visibleWhen] : field.visibleWhenAny ?? []
}

function open(id: string): void {
  current.value = id
  search.value = ''
  mobileOpen.value = true
}
function clearSearch(): void {
  search.value = ''
  searchInput.value?.focus()
}

function summary(section: SettingSection): string[] {
  const values = section.fields.filter((field) => settingVisible(field, settings.value) && Object.hasOwn(settings.value, field.key))
  const entries = values.slice(0, 2).map((field) => {
    const value = settings.value[field.key]
    const label = field.label.replace(/\s*\([^)]*\)$/, '')
    if (typeof value === 'boolean') return `${label} ${value ? '已开启' : '已关闭'}`
    if (value === null) return `${label} ${field.nullable ? '自动' : '未设置'}`
    if (Array.isArray(value)) return `${label} ${value.length} 项`
    return `${label} ${value === '' ? '留空' : String(value)}${field.unit ? ` ${field.unit}` : ''}`
  })
  return entries.length ? entries : [section.description]
}

const GEO_GROUP = { id: 'geo', title: 'Geo 数据', description: 'GeoIP 与 GeoSite 数据的来源、自动更新和 MMDB 转换' }
const GEO_KEYS = ['geoip_db_path', 'geoip_dat_path', 'geosite_data_paths']
function changedAny(keys: string[]): boolean {
  return keys.some((key) => props.changed?.has(key))
}
const groups = computed(() => [
  // 分组列表不随搜索变：它是导航，搜索只影响右边。 / The group list ignores the search: it is navigation; search only changes the pane.
  ...navSections.value.map((section) => ({
    id: section.id,
    title: section.title,
    description: section.description,
    summary: summary(section),
    // 按这一组的全部设置算，不只算现在显示的：开关关着时藏起来的那几项改过了，分组上也要有点（审计第四轮 C7）
    // Counted over every setting of the group, not only the ones shown: a changed setting hidden behind a switch that is off still marks its group (audit round 4, C7)
    changed: changedAny([...(SETTING_SECTIONS.find((item) => item.id === section.id)?.fields ?? []).map((field) => field.key), ...(section.id === 'network' ? ['version'] : [])]),
  })),
  { ...GEO_GROUP, summary: geoSummary(), changed: changedAny(GEO_KEYS) },
])
// 格式版本在搜索「版本」「version」时也要找得到 / The format version must turn up when searching 版本 or version
const versionMatches = computed(() => !query.value || '格式版本 version 配置文件'.includes(query.value))
const currentGroup = computed(() => groups.value.find((group) => group.id === current.value) ?? groups.value[0]!)
const navSections = computed(() => SETTING_SECTIONS.map((section) => ({
  ...section,
  fields: section.fields.filter((field) => (supported(field) || Object.hasOwn(settings.value, field.key)) && settingShouldRender(field, settings.value, props.capabilities)),
})).filter((section) => section.fields.length > 0))
const currentSection = computed(() => navSections.value.find((section) => section.id === current.value))
const paneSections = computed(() => (query.value ? visibleSections.value : currentSection.value ? [currentSection.value] : []))
function geoSummary(): string[] {
  const sites = Array.isArray(settings.value.geosite_data_paths) ? settings.value.geosite_data_paths.length : 0
  return [settings.value.geoip_db_path ? 'GeoIP 已配置' : 'GeoIP 未配置', `GeoSite ${sites} 个文件`]
}
// 标签去掉括号里的单位（单位写进输入框里了）；说明只留真正有话说的：字段自己的说明和「要先打开谁」。
// Labels drop the bracketed unit (it sits inside the input now); the note keeps only what matters:
// the field's own description and which switch it depends on.
function labelFor(field: SettingField): string {
  return field.label.replace(/\s*\([^)]*\)$/, '')
}
function noteFor(field: SettingField): string {
  return [field.title, dependencyHint(field)].filter(Boolean).join(' ')
}
// 占位写清楚它是什么：内核默认值写「默认 …」，例子写「如 …」，两样都不是时写原来那句（「留空禁用 DoH」「自动」）（审计 T15）
// The placeholder says what it is: a kernel default reads 「默认 …」, an example 「如 …」, otherwise the field's own words (audit T15)
function placeholderFor(field: SettingField): string {
  if (field.default !== undefined && typeof field.default !== 'boolean') return `默认 ${field.default}`
  if (field.example) return `如 ${field.example}`
  return field.placeholder ?? ''
}
function booleanState(field: SettingField): string {
  const value = settings.value[field.key]
  return typeof value === 'boolean' ? '' : '默认'
}

function disabled(field: SettingField): boolean {
  return !supported(field) || !settingVisible(field, settings.value)
}

function dependencyHint(field: SettingField): string {
  if (settingVisible(field, settings.value)) return ''
  const labels = dependencyKeys(field).map((key) => allFields.find((item) => item.key === key)?.label ?? key)
  return `先打开「${labels.join('」或「')}」`
}

// 内核不支持的设置只读：值写成文字，旁边一个「内核不支持」标签（规范第 8 节）
// A setting the kernel does not support is read-only: its value as text beside a 内核不支持 tag (spec section 8)
function readonlyValue(field: SettingField): string {
  const value = settings.value[field.key]
  if (typeof value === 'boolean') return value ? '已开启' : '已关闭'
  if (Array.isArray(value)) return value.join(', ') || '留空'
  if (value === null || value === undefined || value === '') return field.nullable ? '自动' : '未设置'
  return `${String(value)}${field.unit ? ` ${field.unit}` : ''}`
}

function setValue(key: string, value: unknown): void {
  settings.value = { ...settings.value, [key]: value }
}

function scalarValue(field: SettingField): string | number {
  const value = settings.value[field.key]
  return typeof value === 'string' || typeof value === 'number' ? value : ''
}

function csvValue(field: SettingField): string {
  const value = settings.value[field.key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join(', ') : typeof value === 'string' ? value : ''
}

function listValue(field: SettingField): string[] {
  const value = settings.value[field.key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function setText(field: SettingField, event: Event): void {
  setValue(field.key, (event.currentTarget as HTMLInputElement).value)
}

function setNumber(field: SettingField, event: Event): void {
  const raw = (event.currentTarget as HTMLInputElement).value
  if (raw === '') {
    if (field.nullable) setValue(field.key, null)
    else {
      const next = { ...settings.value }
      delete next[field.key]
      settings.value = next
    }
    return
  }
  setValue(field.key, Number(raw))
}

function setBoolean(field: SettingField, event: Event): void {
  setValue(field.key, (event.currentTarget as HTMLInputElement).checked)
}

function setCsv(field: SettingField, event: Event): void {
  setValue(field.key, (event.currentTarget as HTMLInputElement).value
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean))
}

function addListItem(field: SettingField): void {
  setValue(field.key, [...listValue(field), ''])
}

function setListItem(field: SettingField, index: number, event: Event): void {
  const next = [...listValue(field)]
  next[index] = (event.currentTarget as HTMLInputElement).value
  setValue(field.key, next)
}

function removeListItem(field: SettingField, index: number): void {
  setValue(field.key, listValue(field).filter((_, itemIndex) => itemIndex !== index))
}

function supported(field: SettingField): boolean {
  return settingSupported(field, props.capabilities)
}
</script>

<template>
  <div class="settings" :class="{ 'settings--open': mobileOpen || Boolean(query), 'settings--searching': Boolean(query) }">
    <nav class="settings-nav" aria-label="设置分组">
      <!-- 清除按钮和解析编排的搜索框同一个零件：框里的点按格，手机上 44 宽、和框里面一样高（审计第三轮 T5） / The clear button is the same part as in 解析编排's search: a cell inside the field, 44 wide and as tall as the inside on a phone (audit round 3, T5) -->
      <label class="ui-input settings-search"><Search :size="16" aria-hidden="true" /><input ref="searchInput" v-model="search" type="search" aria-label="搜索基础设置" placeholder="搜索设置或配置 key" @keydown.esc.prevent="clearSearch"><button v-if="search" class="ui-input__affix" type="button" aria-label="清除设置搜索" title="清除设置搜索" @click.prevent="clearSearch"><X :size="14" aria-hidden="true" /></button></label>
      <button v-for="group in groups" :key="group.id" type="button" class="settings-nav__item" :aria-current="!query && current === group.id ? 'true' : undefined" :aria-description="group.changed ? '有修改' : undefined" @click="open(group.id)">
        <span class="settings-nav__title">{{ group.title }}<i v-if="group.changed" class="ui-dot ui-dot--ink settings-dot" aria-hidden="true"></i></span>
        <small class="settings-nav__summary"><UiDotText :parts="group.summary" /></small>
        <ChevronRight class="settings-nav__chevron" :size="16" aria-hidden="true" />
      </button>
    </nav>

    <div class="settings-pane">
      <button v-if="isMobile && !query" class="ui-btn ui-btn--text settings-back" type="button" @click="mobileOpen = false"><ChevronLeft :size="16" />全部设置</button>
      <div v-if="query && !visibleSections.length" class="settings-empty"><strong>没有找到匹配的设置</strong><p>试试「缓存」「超时」或配置 key。</p><button class="ui-btn ui-btn--secondary ui-btn--sm" type="button" @click="clearSearch">清除搜索</button></div>

      <!-- 搜索时列出所有分组里的匹配，一个分组一段；平时只显示选中的那一组。
           While searching, every group's matches, one block per group; otherwise only the selected group. -->
      <section v-for="section in paneSections" :key="section.id" class="settings-group" :class="{ 'ui-rise': !query }">
        <!-- 搜索结果里每组的标题也是区块标题，和平时一组的标题一样：和下面的设置名差了字号，不只差字重（规范 1.7，审计 T10）
             Each group heading in search results is a section title, as for a single group: it differs from the setting names in size, not only weight (spec 1.7, audit T10) -->
        <header class="settings-group__head settings-group__head--lead"><h3>{{ section.title }}</h3></header>
        <div class="settings-rows">
          <!-- 一个设置一行：左边名字和一句说明，右边控件。数字的单位写在输入框里，占位写默认值。
               One setting per row: name and a one-line note on the left, the control on the right; a number's unit sits in the input and the placeholder states the default. -->
          <template v-for="field in section.fields" :key="field.key">
            <div v-if="!supported(field)" class="ui-setrow ui-setrow--off">
              <span class="ui-setrow__label"><span>{{ labelFor(field) }}<i v-if="changed?.has(field.key)" class="ui-dot ui-dot--ink settings-dot" aria-hidden="true"></i></span><code v-if="query" class="settings-row__key">{{ field.key }}</code></span>
              <span class="settings-row__readonly"><code>{{ readonlyValue(field) }}</code><span class="ui-tag">内核不支持</span></span>
            </div>
            <label v-else-if="field.type === 'boolean'" class="ui-setrow ui-setrow--toggle" :class="{ 'ui-setrow--off': disabled(field) }">
              <span class="ui-setrow__label"><span>{{ labelFor(field) }}<i v-if="changed?.has(field.key)" class="ui-dot ui-dot--ink settings-dot" aria-hidden="true"></i></span><small v-if="noteFor(field)">{{ noteFor(field) }}</small><code v-if="query" class="settings-row__key">{{ field.key }}</code></span>
              <span class="ui-switch"><small v-if="booleanState(field)">{{ booleanState(field) }}</small><input type="checkbox" role="switch" :checked="Boolean(settingValue(settings, field.key))" :aria-label="field.label" :aria-description="changed?.has(field.key) ? '已修改' : undefined" :disabled="disabled(field)" @change="setBoolean(field, $event)"><i aria-hidden="true"></i></span>
            </label>
            <div v-else-if="field.type === 'list'" class="ui-setrow" :class="{ 'ui-setrow--off': disabled(field) }">
              <span class="ui-setrow__label"><span>{{ labelFor(field) }}<i v-if="changed?.has(field.key)" class="ui-dot ui-dot--ink settings-dot" aria-hidden="true"></i></span><small v-if="noteFor(field)">{{ noteFor(field) }}</small><code v-if="query" class="settings-row__key">{{ field.key }}</code></span>
              <span class="settings-list">
                <span v-for="(item, index) in listValue(field)" :key="index" class="settings-list__row"><span class="ui-input"><input type="text" :value="item" :placeholder="field.placeholder" :aria-label="`${field.label} ${index + 1}`" :disabled="disabled(field)" @input="setListItem(field, index, $event)"></span><button class="ui-icon-btn" type="button" :title="`删除${field.label} ${index + 1}`" :aria-label="`删除${field.label} ${index + 1}`" :disabled="disabled(field)" @click="removeListItem(field, index)"><X :size="16" /></button></span>
                <button class="ui-btn ui-btn--text ui-btn--sm settings-list__add" type="button" :disabled="disabled(field)" @click="addListItem(field)"><Plus :size="14" aria-hidden="true" />添加路径</button>
              </span>
            </div>
            <label v-else class="ui-setrow" :class="{ 'ui-setrow--off': disabled(field) }">
              <span class="ui-setrow__label"><span>{{ labelFor(field) }}<i v-if="changed?.has(field.key)" class="ui-dot ui-dot--ink settings-dot" aria-hidden="true"></i></span><small v-if="noteFor(field)">{{ noteFor(field) }}</small><code v-if="query" class="settings-row__key">{{ field.key }}</code></span>
              <span class="ui-input ui-setrow__control">
                <input v-if="field.type === 'text'" class="mono" type="text" :value="scalarValue(field)" :placeholder="placeholderFor(field)" :aria-label="field.label" :aria-description="changed?.has(field.key) ? '已修改' : undefined" :disabled="disabled(field)" @input="setText(field, $event)">
                <input v-else-if="field.type === 'number'" type="number" :value="scalarValue(field)" :placeholder="placeholderFor(field)" :aria-label="field.label" :aria-description="changed?.has(field.key) ? '已修改' : undefined" :min="field.min" :max="field.max" :disabled="disabled(field)" @input="setNumber(field, $event)">
                <input v-else class="mono" type="text" :value="csvValue(field)" :placeholder="placeholderFor(field)" :aria-label="field.label" :aria-description="changed?.has(field.key) ? '已修改' : undefined" :disabled="disabled(field)" @input="setCsv(field, $event)">
                <em v-if="field.unit" class="ui-setrow__unit">{{ field.unit }}</em>
              </span>
            </label>
          </template>
          <label v-if="section.id === 'network' && versionMatches" class="ui-setrow"><span class="ui-setrow__label"><span>格式版本<i v-if="changed?.has('version')" class="ui-dot ui-dot--ink settings-dot" aria-hidden="true"></i></span><small>KixDNS 按它判断配置的写法</small><code v-if="query" class="settings-row__key">version</code></span><span class="ui-input ui-setrow__control"><input v-model="version" class="mono" type="text" aria-label="配置格式版本" :aria-description="changed?.has('version') ? '已修改' : undefined" placeholder="1.0"></span></label>
        </div>
      </section>

      <div v-if="!query && current === 'geo'" :key="current" class="ui-rise">
        <header class="settings-group__head settings-group__head--lead"><h3>{{ currentGroup.title }}</h3></header>
        <GeoDataEditor v-model="settings" :changed="changed" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 基础设置只用 tokens.css 的变量：左边分组、右边一行一个设置，不画分隔线、不用装饰色条。
   Tokens only: groups on the left, one setting per row on the right; no rules and no decorative colour bars. */
/* 高度由内容决定：一组只有几项时卡片就矮，不撑出一块空白。 / Content sets the height: a short group makes a short card, not a block of blank space. */
.settings { display: grid; grid-template-columns: 240px minmax(0, 1fr); }
/* 设置窗格是一个容器：窄于 38rem 时设置行上下排（components.css 的 setrows） / The pane is a container: below 38rem the setting rows stack (setrows in components.css) */
.settings-pane { container: setrows / inline-size; }
/* 四边都是 16：搜索框和选中那一项的底色离卡片边、离分隔线一样远，和工作台的列表一样（规范 6.4，审计第六轮 T2）
   16 on every side: the search box and the selected item's fill sit as far from the divider as from the card edge, as in the workbench list (spec 6.4, audit round 6, T2) */
.settings-nav { position: sticky; top: calc(var(--app-header-height, 64px) + var(--s-4)); align-self: start; display: grid; gap: 2px; padding: var(--s-4); }
.settings-search { margin-bottom: var(--s-3); }
.settings-search > svg { flex-shrink: 0; color: var(--l-ink-3); }
.settings-search input::-webkit-search-cancel-button { display: none; }
/* 上下内边距按 36 高和一行字算：导航项正好 36，和上面的搜索框一样高（规范 2.1，审计第三轮 T4） / The block padding comes from the 36 height and one line, so an item is exactly 36 like the search box (spec 2.1, audit round 3, T4) */
.settings-nav__item { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0 var(--s-2); min-height: var(--h-md); padding: calc((var(--h-md) - 1lh) / 2) var(--s-3); border: 0; border-radius: var(--r-2); background: transparent; color: var(--l-ink-2); font: inherit; font-size: var(--t-3); text-align: left; cursor: pointer; }
@media (hover: hover) { .settings-nav__item:hover { background: var(--l-canvas); color: var(--l-ink); } }
/* 选中只换底色和颜色，不改字重（规范 1.6，审计 T12） / Selection changes fill and colour, never weight (spec 1.6, audit T12) */
.settings-nav__item[aria-current="true"] { background: var(--l-sunk); color: var(--l-ink); }
.settings-nav__summary, .settings-nav__chevron { display: none; }
/* 改过的设置：名字后面一个墨点，和工作台的一样（规范 8.1，审计第三轮 T8） / A changed setting: an ink dot after its name, as on the workbench (spec 8.1, audit round 3, T8) */
.settings-dot { margin-inline-start: var(--s-2); vertical-align: .1em; }
/* 下边 16 加最后一行自己的 8 是 24，和左右一样（规范 6.4，审计第二轮 T2） / 16 plus the last row's own 8 makes 24, the side inset (spec 6.4, audit round 2, T2) */
.settings-pane { min-width: 0; padding: var(--s-4) var(--s-5); border-left: 1px solid var(--l-hair); }
.settings-back { display: none; }
.settings-group + .settings-group { margin-top: var(--s-6); }
.settings-group__head { margin: 0 0 var(--s-2); }
.settings-group__head h3 { margin: 0; color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-bold); }
.settings-group__head--lead { margin-bottom: var(--s-4); }
.settings-group__head--lead h3 { font-size: var(--t-4); }
/* 导航在旁边时，窗格的第一个标题和导航的搜索框在同一条中线上；下面少留 4，第一个字段还和第一个导航项齐平（审计第七轮 T3）
   With the nav alongside, the pane's first title shares the nav search box's centre line; 4 less below keeps the first field level with the first nav item (audit round 7, T3) */
@media (min-width: 861px) {
  /* 每个标题下面都是 16：少的那 4 从导航的搜索框下面拿，第一个导航项和第一个字段还是齐平（审计第八轮 T2）
     16 under every heading: the 4 comes from under the nav search box instead, so the first nav item and the first field stay level (audit round 8, T2) */
  .settings-search { margin-bottom: var(--s-4); }
  .settings-pane > :first-child .settings-group__head--lead h3 { padding-top: calc((var(--h-md) - 1lh) / 2); }
}
.settings-rows { display: grid; gap: 2px; }
/* 开关上下各补 6 凑成 36 的格子，只为行和行之间一样高；最后一行下面不补，卡片底边离它和离一个输入框一样远（审计第四轮 T1）
   The 6 above and below a switch makes the 36 slot only for the pitch between rows; not under the last row, so the card's bottom sits as far from it as from a field (audit round 4, T1) */
.settings-rows > .ui-setrow--toggle:last-child :deep(.ui-switch) { margin-bottom: 0; }
.settings-list { min-width: 0; display: grid; gap: var(--s-2); }
.settings-list__row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--s-1); }
.settings-list__row input { font-family: var(--mono); }
.settings-list__add { justify-self: start; }
.settings-empty { display: grid; justify-items: center; gap: var(--s-2); padding: var(--s-7) var(--s-4); text-align: center; }
.settings-empty strong { color: var(--l-ink); font-size: var(--t-3); }
.settings-empty p { margin: 0; color: var(--l-ink-3); font-size: var(--t-2); }
.settings-row__readonly { min-width: 0; min-height: var(--h-md); display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2); color: var(--l-ink-2); font-size: var(--t-2); }
.settings-row__readonly code { font-family: var(--f-mono); overflow-wrap: anywhere; }
.settings-row__key { color: var(--l-ink-3); font-family: var(--mono); font-size: var(--t-1); overflow-wrap: anywhere; }
/* 12 号的等宽 key 字身矮、行框高，看起来在名字和框的正中间：只把画出来的字往上提 2，和名字下的说明一样离名字近（审计第八轮 T3）
   The 12px mono key has short glyphs in a tall line box and looked centred between its name and the box: only the drawn text rises 2, as
   near its name as a note (audit round 8, T3) */
.settings-row__key { position: relative; top: calc(var(--s-1) / -2); }
@media (max-width: 860px) {
  /* 手机：先是分组列表（像系统设置），点进一组再看它的设置，搜索时直接看结果。
     A phone: the group list first, like system settings; a tap opens one group; searching shows results directly. */
  .settings { display: block; min-height: 0; }
  /* 搜索框和结果同一条左右边线：导航的左右内边距和窗格一样 16（审计 T11）；上边也是 16，四边一样（审计第三轮 T7）
     The search box shares the results' edges: the nav's inline padding matches the pane's 16 (audit T11); 16 at the top too, the same on every side (audit round 3, T7) */
  .settings-nav { position: static; padding: var(--s-4) var(--s-4) var(--s-3); }
  .settings-nav__item { min-height: var(--h-touch); grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto auto; }
  .settings-nav__summary { display: block; grid-column: 1; color: var(--l-ink-3); font-size: var(--t-1); font-weight: var(--w-normal); overflow-wrap: anywhere; }
  .settings-nav__chevron { display: block; grid-column: 2; grid-row: 1 / 3; color: var(--l-ink-3); }
  .settings-nav__item[aria-current="true"] { background: transparent; }
  /* 下边 8 加最后一行自己的 8 是 16，和左右一样（规范 6.4，审计第二轮 T2） / 8 plus the last row's own 8 makes 16, the side inset (spec 6.4, audit round 2, T2) */
  .settings-pane { display: none; padding: var(--s-4) var(--s-4) var(--s-2); border-left: 0; }
  /* 搜索时结果紧跟在搜索框下面：框下 12 加导航下边 12，第一组标题离框 24（审计第三轮 T7） / Search results follow the box: 12 under it plus the nav's 12 puts the first heading 24 below (audit round 3, T7) */
  /* 搜索结果的第一个标题离搜索框和后面的标题离上一组一样远：它是结果的开头，不是搜索框的说明（规范 6.2，审计第七轮 T1）
     The first result heading sits as far below the search box as later headings sit below the group before: it starts the results, it does not caption the box (spec 6.2, audit round 7, T1) */
  .settings--searching .settings-pane { padding-top: var(--s-4); }
  .settings--open .settings-nav > :not(.settings-search) { display: none; }
  /* 打开一组时手机上只留「全部设置」返回，搜索框在分组列表里 / An open group keeps only the back link; search lives with the group list */
  .settings--open:not(.settings--searching) .settings-nav { display: none; }
  .settings--open .settings-pane { display: block; }
  /* 「全部设置」往上收：按钮看不见的留白不算，字离卡片上边 16，和列表里搜索框的上边一样（审计第三轮 T7）
     全部设置 is pulled up: the button's invisible padding does not count, so its text sits 16 under the card edge like the search box in the list (audit round 3, T7) */
  .settings-back { display: inline-flex; margin: calc((1lh - var(--h-md)) / 2) 0 var(--s-2) calc(var(--s-2) * -1); }
}
@media (max-width: 640px) {
  .settings-back { margin-top: calc((1lh - var(--h-md)) / 2); }
  /* 只有名字一行的开关放在最后一行时，44 高的行比开关多出 2：收回来，卡片底边离它和离一个输入框一样远（审计第五轮 T1）
     A single-line switch row that ends the pane is 2 taller than its switch in the 44 row: taken back, so the card's bottom sits as far from it as from a field (audit round 5, T1) */
  .settings-rows > .ui-setrow--toggle:last-child:not(:has(.ui-setrow__label > :nth-child(2))) { margin-bottom: calc((var(--s-5) + var(--s-2) * 2 - var(--h-touch)) / 2); }
}
@container setrows (max-width: 38rem) {
  .settings-rows > .ui-setrow--toggle:last-child:not(:has(.ui-setrow__label > :nth-child(2))) { margin-bottom: calc((var(--s-5) + var(--s-2) * 2 - var(--h-touch)) / 2); }
}
</style>
