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
} from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { apiRequest, jsonBody } from '../../api/client'
import type { GeoDataManifest, GeoDataResource, GeoDataSyncRequest } from '../../api/types'
import type { GlobalSettings } from '../../config-editor/types'
import { errorMessage, formatDate, shortHash } from '../../utils'

type GeoMode = 'remote' | 'local'

const settings = defineModel<GlobalSettings>({ required: true })
const emit = defineEmits<{ notice: [message: string] }>()
const mode = ref<GeoMode>('remote')
const manifest = ref<GeoDataManifest>({ geoip_mmdb: null, geoip_dat: null, geosite: [] })
const mmdbUrl = ref('')
const datUrl = ref('')
const geositeUrls = ref<string[]>([''])
const loading = ref(true)
const syncing = ref(false)
const statusError = ref('')
const hasGeoIp = computed(() => Boolean(stringSetting('geoip_db_path') || stringSetting('geoip_dat_path')))

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

function setBooleanSetting(key: string, event: Event): void {
  settings.value[key] = (event.currentTarget as HTMLInputElement).checked
}

function setCountries(event: Event): void {
  settings.value.geoip_filter_countries = (event.currentTarget as HTMLInputElement).value
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean)
}

function countriesValue(): string {
  const value = settings.value.geoip_filter_countries
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').join(', ')
  return typeof value === 'string' ? value : ''
}

function setRemoteUrl(target: 'mmdb' | 'dat', event: Event): void {
  const value = (event.currentTarget as HTMLInputElement).value
  if (target === 'mmdb') mmdbUrl.value = value
  else datUrl.value = value
}

function setRemoteGeosite(index: number, event: Event): void {
  geositeUrls.value[index] = (event.currentTarget as HTMLInputElement).value
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
    const next = await apiRequest<GeoDataManifest>('/api/v1/config/geo-data')
    manifest.value = next
    fillUrls(next)
    mode.value = isManagedConfiguration(next) ? 'remote' : 'local'
  } catch (error) {
    statusError.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

async function syncRemote(): Promise<void> {
  statusError.value = ''
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
    emit('notice', 'Geo 数据已下载并写入配置，请保存并热加载')
  } catch (error) {
    statusError.value = errorMessage(error)
  } finally {
    syncing.value = false
  }
}

onMounted(loadManifest)
</script>

<template>
  <section class="config-section geo-data-section">
    <header class="config-section__header config-section__header--actions">
      <div><span class="section-mark section-mark--ink"></span><h3>GeoIP 与 GeoSite</h3></div>
      <div class="geo-mode-tabs" role="tablist" aria-label="Geo 数据来源">
        <button type="button" role="tab" :aria-selected="mode === 'remote'" :class="{ active: mode === 'remote' }" @click="mode = 'remote'"><Link2 :size="13" />远程链接</button>
        <button type="button" role="tab" :aria-selected="mode === 'local'" :class="{ active: mode === 'local' }" @click="mode = 'local'"><FolderOpen :size="13" />本地路径</button>
      </div>
    </header>

    <div v-if="mode === 'remote'" class="geo-data-editor">
      <div class="geo-resource-grid">
        <label class="setting-field geo-resource-field">
          <span>GeoIP MMDB 链接</span>
          <input type="url" inputmode="url" :value="mmdbUrl" placeholder="https://example.com/GeoLite2-Country.mmdb" :disabled="loading || syncing" @input="setRemoteUrl('mmdb', $event)">
          <small v-if="resourceStatus(manifest.geoip_mmdb, mmdbUrl)"><CircleCheck :size="12" />{{ formatSize(manifest.geoip_mmdb!.size) }} · {{ shortHash(manifest.geoip_mmdb!.sha256, 10) }} · {{ formatDate(manifest.geoip_mmdb!.downloaded_at) }}</small>
        </label>
        <label class="setting-field geo-resource-field">
          <span>GeoIP DAT 链接</span>
          <input type="url" inputmode="url" :value="datUrl" placeholder="https://example.com/geoip.dat" :disabled="loading || syncing" @input="setRemoteUrl('dat', $event)">
          <small v-if="resourceStatus(manifest.geoip_dat, datUrl)"><CircleCheck :size="12" />{{ formatSize(manifest.geoip_dat!.size) }} · {{ shortHash(manifest.geoip_dat!.sha256, 10) }} · {{ formatDate(manifest.geoip_dat!.downloaded_at) }}</small>
        </label>
        <div class="setting-field geo-resource-field geo-resource-field--wide">
          <span>GeoSite 链接</span>
          <div v-for="(url, index) in geositeUrls" :key="index" class="setting-list__row">
            <div>
              <input type="url" inputmode="url" :value="url" placeholder="https://example.com/geosite.dat" :aria-label="`GeoSite 链接 ${index + 1}`" :disabled="loading || syncing" @input="setRemoteGeosite(index, $event)">
              <small v-if="resourceStatus(manifest.geosite[index], url)"><CircleCheck :size="12" />{{ formatSize(manifest.geosite[index]!.size) }} · {{ shortHash(manifest.geosite[index]!.sha256, 10) }} · {{ formatDate(manifest.geosite[index]!.downloaded_at) }}</small>
            </div>
            <button class="icon-button icon-button--small" type="button" title="删除 GeoSite 链接" :disabled="syncing" @click="removeRemoteGeosite(index)"><Trash2 :size="14" /></button>
          </div>
          <div class="geo-resource-commands">
            <button class="inline-command" type="button" :disabled="geositeUrls.length >= 8 || syncing" @click="addRemoteGeosite"><Plus :size="14" />添加链接</button>
            <button class="button button--secondary" type="button" :disabled="loading || syncing" @click="syncRemote"><RefreshCw v-if="syncing" :size="15" class="spin" /><Download v-else :size="15" />{{ syncing ? '下载中' : '下载并写入配置' }}</button>
          </div>
          <span v-if="statusError" class="geo-data-error"><TriangleAlert :size="14" />{{ statusError }}</span>
        </div>
      </div>
    </div>

    <div v-else class="geo-data-editor">
      <div class="geo-resource-grid">
        <label class="setting-field"><span>MMDB 文件路径</span><input type="text" :value="stringSetting('geoip_db_path')" placeholder="/path/to/GeoLite2-Country.mmdb" @input="setStringSetting('geoip_db_path', $event)"></label>
        <label class="setting-field"><span>GeoIP DAT 文件路径</span><input type="text" :value="stringSetting('geoip_dat_path')" placeholder="/path/to/geoip.dat" @input="setStringSetting('geoip_dat_path', $event)"></label>
        <div class="setting-field geo-resource-field--wide setting-list">
          <span>GeoSite 数据文件</span>
          <div v-for="(path, index) in listSetting('geosite_data_paths')" :key="index" class="setting-list__row">
            <input type="text" :value="path" placeholder="/path/to/geosite.dat" :aria-label="`GeoSite 文件路径 ${index + 1}`" @input="setLocalGeosite(index, $event)">
            <button class="icon-button icon-button--small" type="button" title="删除 GeoSite 路径" @click="removeLocalGeosite(index)"><Trash2 :size="14" /></button>
          </div>
          <button class="inline-command" type="button" @click="addLocalGeosite"><Plus :size="14" />添加路径</button>
        </div>
      </div>
      <span v-if="statusError" class="geo-data-error geo-data-error--local"><TriangleAlert :size="14" />{{ statusError }}</span>
    </div>

    <div v-if="hasGeoIp" class="geo-options">
      <label class="setting-toggle">
        <span>自动转换 MMDB</span>
        <input type="checkbox" :checked="Boolean(settings.geoip_auto_convert)" @change="setBooleanSetting('geoip_auto_convert', $event)">
        <i aria-hidden="true"></i>
      </label>
      <label class="setting-field">
        <span>转换国家过滤</span>
        <input type="text" :value="countriesValue()" placeholder="CN, US, JP" @input="setCountries">
      </label>
    </div>
  </section>
</template>
