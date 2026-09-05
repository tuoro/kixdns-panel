<script setup lang="ts">
import { ChevronDown, Plus, Search, Trash2, TriangleAlert, X } from '@lucide/vue'
import { computed, ref } from 'vue'
import { SETTING_SECTIONS, settingShouldRender, settingSupported, settingVisible, type SettingField, type SettingSection } from '../../config-editor/schema'
import type { GlobalSettings } from '../../config-editor/types'
import GeoDataEditor from './GeoDataEditor.vue'

const settings = defineModel<GlobalSettings>({ required: true })
const props = defineProps<{ capabilities: string[] }>()
const search = ref('')
const searchInput = ref<HTMLInputElement>()
const expandedSections = ref<string[]>(['network'])
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

const matchCount = computed(() => visibleSections.value.reduce((count, section) => count + section.matchCount, 0))

function dependencyKeys(field: SettingField): string[] {
  return field.visibleWhen ? [field.visibleWhen] : field.visibleWhenAny ?? []
}

function expanded(id: string): boolean {
  return Boolean(query.value) || expandedSections.value.includes(id)
}

function toggleSection(id: string): void {
  expandedSections.value = expandedSections.value.includes(id)
    ? expandedSections.value.filter((current) => current !== id)
    : [...expandedSections.value, id]
}

function clearSearch(): void {
  search.value = ''
  searchInput.value?.focus()
}

function summary(section: SettingSection): string {
  const values = section.fields.filter((field) => settingVisible(field, settings.value) && Object.hasOwn(settings.value, field.key))
  const entries = values.slice(0, 2).map((field) => {
    const value = settings.value[field.key]
    const label = field.label.replace(/\s*\([^)]*\)$/, '')
    if (typeof value === 'boolean') return `${label} ${value ? '已开启' : '已关闭'}`
    if (value === null) return `${label} ${field.nullable ? '自动' : '未设置'}`
    if (Array.isArray(value)) return `${label} ${value.length} 项`
    return `${label} ${value === '' ? '留空' : String(value)}${field.unit ? ` ${field.unit}` : ''}`
  })
  return entries.join(' · ') || section.description
}

function booleanState(field: SettingField): string {
  const value = settings.value[field.key]
  return typeof value === 'boolean' ? value ? '已开启' : '已关闭' : '使用默认'
}

function disabled(field: SettingField): boolean {
  return !supported(field) || !settingVisible(field, settings.value)
}

function dependencyHint(field: SettingField): string {
  if (settingVisible(field, settings.value)) return ''
  const labels = dependencyKeys(field).map((key) => allFields.find((item) => item.key === key)?.label ?? key)
  return `启用「${labels.join('」或「')}」后可调整；已有值保留。`
}

function numberHint(field: SettingField): string {
  const range = field.min !== undefined && field.max !== undefined
    ? `${field.min}–${field.max}`
    : field.min !== undefined ? `至少 ${field.min}` : field.max !== undefined ? `至多 ${field.max}` : ''
  return [[range, field.unit].filter(Boolean).join(' '), field.nullable ? '留空自动计算' : '留空使用默认值'].filter(Boolean).join(' · ')
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
  <div class="settings-tools">
    <div class="settings-search">
      <Search :size="16" aria-hidden="true" />
      <input ref="searchInput" v-model="search" type="search" aria-label="搜索基础设置" aria-describedby="settings-search-scope" placeholder="搜索设置名称或配置 key" @keydown.esc.prevent="clearSearch">
      <button v-if="search" type="button" aria-label="清除设置搜索" @click="clearSearch"><X :size="15" /></button>
    </div>
    <p id="settings-search-scope">仅搜索基础设置，Geo 数据、域名映射与 Pipeline 不受影响。</p>
    <p v-if="query" class="settings-search-result" role="status">找到 {{ matchCount }} 项设置，相关分组已展开。</p>
  </div>
  <div v-if="query && !visibleSections.length" class="settings-empty">
    <Search :size="22" aria-hidden="true" />
    <strong>没有找到匹配的设置</strong>
    <p>试试「缓存」「超时」或配置 key。</p>
    <button class="inline-command" type="button" @click="clearSearch">清除搜索</button>
  </div>
  <section v-for="section in visibleSections" :key="section.id" class="config-section settings-section">
    <header class="settings-section__header">
      <h3>
        <button type="button" class="settings-section__toggle" :aria-label="section.title" :aria-expanded="expanded(section.id)" :aria-controls="`settings-${section.id}`" :disabled="Boolean(query)" @click="toggleSection(section.id)">
          <span class="section-mark" :class="`section-mark--${section.tone}`"></span>
          <span class="settings-section__heading"><span>{{ section.title }}</span><small>{{ summary(section) }}</small></span>
          <span v-if="section.id !== 'network'" class="settings-section__category">高级</span>
          <ChevronDown :size="16" class="settings-section__chevron" :class="{ 'is-expanded': expanded(section.id) }" aria-hidden="true" />
        </button>
      </h3>
    </header>
    <div v-show="expanded(section.id)" :id="`settings-${section.id}`" class="settings-grid">
      <template v-for="field in section.fields" :key="field.key">
        <label v-if="field.type !== 'boolean' && field.type !== 'list'" class="setting-field" :class="{ 'setting-field--wide': field.wide, 'setting-field--unsupported': disabled(field) }">
          <span>{{ field.label }}</span>
          <input v-if="field.type === 'text'" type="text" :value="scalarValue(field)" :placeholder="field.placeholder" :aria-label="field.label" :aria-describedby="`setting-hint-${field.key}`" :disabled="disabled(field)" @input="setText(field, $event)">
          <input v-else-if="field.type === 'number'" type="number" :value="scalarValue(field)" :placeholder="field.placeholder" :aria-label="field.label" :aria-describedby="`setting-hint-${field.key}`" :min="field.min" :max="field.max" :disabled="disabled(field)" @input="setNumber(field, $event)">
          <input v-else type="text" :value="csvValue(field)" :placeholder="field.placeholder" :aria-label="field.label" :aria-describedby="`setting-hint-${field.key}`" :disabled="disabled(field)" @input="setCsv(field, $event)">
          <small :id="`setting-hint-${field.key}`" class="setting-hint"><span v-if="field.title">{{ field.title }}</span><span v-if="field.type === 'number'">{{ numberHint(field) }}</span><span v-if="dependencyHint(field)">{{ dependencyHint(field) }}</span></small>
          <code v-if="query" class="setting-key">{{ field.key }}</code>
          <small v-if="!supported(field)" class="setting-compatibility"><TriangleAlert :size="12" />当前版本不支持，原值已保留</small>
        </label>

        <label v-else-if="field.type === 'boolean'" class="setting-toggle" :class="{ 'setting-toggle--unsupported': disabled(field) }">
          <span>{{ field.label }}</span>
          <small class="setting-toggle__state">{{ booleanState(field) }}</small>
          <input type="checkbox" :checked="Boolean(settings[field.key])" :aria-label="field.label" :aria-describedby="`setting-hint-${field.key}`" :disabled="disabled(field)" @change="setBoolean(field, $event)">
          <i aria-hidden="true"></i>
          <small :id="`setting-hint-${field.key}`" class="setting-hint"><span v-if="field.title">{{ field.title }}</span><span v-if="dependencyHint(field)">{{ dependencyHint(field) }}</span></small>
          <code v-if="query" class="setting-key">{{ field.key }}</code>
          <small v-if="!supported(field)" class="setting-compatibility"><TriangleAlert :size="12" />当前版本不支持，原值已保留</small>
        </label>

        <div v-else class="setting-field setting-field--wide setting-list" :class="{ 'setting-field--unsupported': disabled(field) }">
          <span>{{ field.label }}</span>
          <div v-for="(item, index) in listValue(field)" :key="index" class="setting-list__row">
            <input type="text" :value="item" :placeholder="field.placeholder" :aria-label="`${field.label} ${index + 1}`" :disabled="disabled(field)" @input="setListItem(field, index, $event)">
            <button class="icon-button icon-button--small" type="button" :title="`删除${field.label}`" :disabled="disabled(field)" @click="removeListItem(field, index)"><Trash2 :size="14" /></button>
          </div>
          <button class="inline-command" type="button" :disabled="disabled(field)" @click="addListItem(field)"><Plus :size="14" />添加路径</button>
          <small v-if="field.title || dependencyHint(field)" class="setting-hint">{{ field.title }} {{ dependencyHint(field) }}</small>
          <code v-if="query" class="setting-key">{{ field.key }}</code>
          <small v-if="!supported(field)" class="setting-compatibility"><TriangleAlert :size="12" />当前版本不支持，原值已保留</small>
        </div>
      </template>
    </div>
  </section>
  <GeoDataEditor v-model="settings" />
</template>

<style scoped>
.settings-tools { display: grid; gap: 8px; padding: 17px; border-bottom: 1px solid var(--line); background: #fff; }
.settings-search { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 0 11px; color: #7a8580; border: 1px solid #d9dfdd; border-radius: 6px; background: #fafcfb; }
.settings-search:focus-within { border-color: #7fb89a; box-shadow: 0 0 0 3px rgba(20, 125, 85, .08); }
.settings-search > svg, .settings-search button { flex: 0 0 auto; }
.settings-search input { width: 100%; min-width: 0; height: 38px; padding: 0; border: 0; outline: 0; background: transparent; color: #31393b; font: inherit; font-size: 14px; }
.settings-search input::-webkit-search-cancel-button { display: none; }
.settings-search button { display: grid; place-items: center; width: 27px; height: 27px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: #67756d; }
.settings-search button:hover { background: #eaf1ed; }
.settings-tools p { margin: 0; color: #7a8580; font-size: 12px; line-height: 1.5; }
.settings-tools .settings-search-result { color: var(--green-dark); }
.settings-section__header { background: #fafbfa; }
.settings-section__header h3 { margin: 0; }
.settings-section__toggle { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; min-height: 70px; padding: 14px 17px; border: 0; background: transparent; text-align: left; color: #303739; }
.settings-section__toggle:not(:disabled):hover { background: #f0f5f2; }
.settings-section__toggle:disabled { cursor: default; opacity: 1; }
.settings-section__toggle > .section-mark { flex: 0 0 4px; }
.settings-section__heading { display: grid; flex: 1; min-width: 0; gap: 5px; font-size: 14px; font-weight: 700; }
.settings-section__heading small { overflow-wrap: anywhere; color: #76817b; font-size: 12px; font-weight: 400; line-height: 1.5; }
.settings-section__category { flex: 0 0 auto; padding: 3px 6px; border-radius: 4px; background: #edf1ef; color: #7c8781; font-size: 12px; font-weight: 500; }
.settings-section__chevron { flex: 0 0 auto; color: #8a958f; transform: rotate(-90deg); transition: transform .15s; }
.settings-section__chevron.is-expanded { transform: rotate(0); }
.settings-section .settings-grid { border-top: 1px solid #edf0ef; }
.setting-hint { display: grid; gap: 3px; margin: 0; color: #7c8781; font-size: 12px; line-height: 1.55; font-weight: 400; overflow-wrap: anywhere; }
.setting-hint:empty { display: none; }
.setting-key { color: #7d8982; font-size: 12px; font-weight: 400; overflow-wrap: anywhere; }
.setting-toggle { grid-template-rows: auto 22px; align-content: start; }
.setting-toggle > .setting-hint, .setting-toggle > .setting-key, .setting-toggle > .setting-compatibility { grid-column: 1 / -1; }
.setting-toggle__state { grid-column: 1; grid-row: 2; color: #7c8781; font-size: 12px; font-weight: 400; }
.setting-toggle i { grid-row: 2; }
.settings-empty { display: grid; justify-items: center; gap: 8px; padding: 30px 17px; color: #849088; text-align: center; }
.settings-empty strong { color: #4b5950; font-size: 14px; }
.settings-empty p { margin: 0; font-size: 14px; }
.settings-search button:focus-visible, .settings-section__toggle:focus-visible { outline: 2px solid #279367; outline-offset: -2px; }
@media (max-width: 700px) {
  .settings-tools, .settings-section__toggle { padding-inline: 13px; }
  .settings-section__heading small { font-size: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .settings-section__chevron { transition: none; }
}
</style>
