<script setup lang="ts">
import {
  Archive,
  CircleCheck,
  Download,
  ExternalLink,
  HardDrive,
  Package,
  Play,
  RefreshCw,
  RotateCw,
  ServerCog,
  Square,
} from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { apiRequest } from '../api/client'
import type {
  InstalledKixdnsVersion,
  KixdnsVersionCatalog,
  RemoteKixdnsVersion,
  ServiceAction,
  ServiceStatus,
} from '../api/types'
import { useToast } from '../composables/useToast'
import { errorMessage, formatDate, shortHash } from '../utils'

type VersionAction = { commit: string; kind: 'install' | 'activate' }

const service = ref<ServiceStatus | null>(null)
const catalog = ref<KixdnsVersionCatalog | null>(null)
const loadingService = ref(true)
const loadingVersions = ref(true)
const serviceAction = ref<ServiceAction | null>(null)
const versionAction = ref<VersionAction | null>(null)
const toast = useToast()

const running = computed(() => service.value?.active_state === 'active')
const installed = computed(() => catalog.value?.binary_present === true)
const activeVersion = computed(() => catalog.value?.installed_versions.find((item) => item.active) ?? null)

function buildTime(value: string | null): string {
  if (!value) return '构建时间未记录'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

async function loadService(silent = false): Promise<void> {
  loadingService.value = true
  try {
    service.value = await apiRequest<ServiceStatus>('/api/v1/service')
  } catch (error) {
    if (!silent) toast.error(errorMessage(error))
  } finally {
    loadingService.value = false
  }
}

async function loadVersions(silent = false): Promise<void> {
  loadingVersions.value = true
  try {
    catalog.value = await apiRequest<KixdnsVersionCatalog>('/api/v1/kixdns/versions')
  } catch (error) {
    if (!silent) toast.error(errorMessage(error))
  } finally {
    loadingVersions.value = false
  }
}

async function refreshAll(): Promise<void> {
  await Promise.all([loadService(true), loadVersions(true)])
  if (!service.value || !catalog.value) toast.error('部分系统状态读取失败')
}

async function control(action: ServiceAction): Promise<void> {
  const names: Record<ServiceAction, string> = { start: '启动', stop: '停止', restart: '重启' }
  if ((action === 'stop' || action === 'restart') && !window.confirm(`${names[action]} KixDNS 服务？`)) return
  serviceAction.value = action
  try {
    service.value = await apiRequest<ServiceStatus>(`/api/v1/service/${action}`, { method: 'POST' })
    toast.success(`KixDNS 服务已${names[action]}`)
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    serviceAction.value = null
  }
}

async function installVersion(version: RemoteKixdnsVersion): Promise<void> {
  if (!window.confirm(`安装并启用构建 ${shortHash(version.commit, 12)}？KixDNS 服务会重启。`)) return
  versionAction.value = { commit: version.commit, kind: 'install' }
  try {
    await apiRequest<InstalledKixdnsVersion>(`/api/v1/kixdns/versions/${version.commit}/install`, { method: 'POST' })
    toast.success('KixDNS 已安装并通过健康检查')
    await Promise.all([loadVersions(true), loadService(true)])
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    versionAction.value = null
  }
}

async function activateVersion(version: InstalledKixdnsVersion | RemoteKixdnsVersion): Promise<void> {
  if (version.active || !window.confirm(`切换到构建 ${shortHash(version.commit, 12)}？KixDNS 服务会重启。`)) return
  versionAction.value = { commit: version.commit, kind: 'activate' }
  try {
    await apiRequest<InstalledKixdnsVersion>(`/api/v1/kixdns/versions/${version.commit}/activate`, { method: 'POST' })
    toast.success('KixDNS 版本已切换并通过健康检查')
    await Promise.all([loadVersions(true), loadService(true)])
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    versionAction.value = null
  }
}

function actionBusy(commit: string): boolean {
  return versionAction.value?.commit === commit
}

onMounted(refreshAll)
</script>

<template>
  <div class="page system-page">
    <div class="system-layout">
      <section class="panel service-panel">
        <header class="panel__header"><div><h2>宿主机服务</h2><p>kixdns.service</p></div><ServerCog :size="20" /></header>
        <div v-if="loadingService" class="inline-loading">读取服务状态…</div>
        <template v-else-if="service">
          <div class="service-state">
            <span :class="running ? 'service-state__icon' : 'service-state__icon service-state__icon--stopped'"><CircleCheck :size="24" /></span>
            <div><small>{{ service.unit }}</small><strong>{{ running ? '正在运行' : '已停止' }}</strong></div>
          </div>
          <dl class="detail-list service-details">
            <div><dt>活动状态</dt><dd class="mono">{{ service.active_state }}</dd></div>
            <div><dt>运行状态</dt><dd class="mono">{{ service.sub_state }}</dd></div>
            <div><dt>主进程</dt><dd class="mono">{{ service.main_pid ? `PID ${service.main_pid}` : '—' }}</dd></div>
          </dl>
          <div class="service-actions">
            <button class="button button--secondary" type="button" :disabled="!installed || running || serviceAction !== null" @click="control('start')"><Play :size="16" />启动</button>
            <button class="button button--secondary" type="button" :disabled="!installed || !running || serviceAction !== null" @click="control('restart')"><RotateCw :size="16" :class="{ spin: serviceAction === 'restart' }" />重启</button>
            <button class="button button--danger-quiet" type="button" :disabled="!running || serviceAction !== null" @click="control('stop')"><Square :size="15" />停止</button>
          </div>
        </template>
      </section>

      <section class="panel runtime-panel">
        <header class="panel__header"><div><h2>安装状态</h2><p>增强版运行时</p></div><Package :size="20" /></header>
        <div v-if="loadingVersions && !catalog" class="inline-loading">读取安装状态…</div>
        <template v-else-if="catalog">
          <div :class="installed ? 'runtime-state' : 'runtime-state runtime-state--missing'">
            <span><HardDrive :size="22" /></span>
            <div><strong>{{ installed ? 'KixDNS 已安装' : 'KixDNS 尚未安装' }}</strong><p class="mono">{{ installed ? shortHash(catalog.active_commit, 16) : '选择下方构建进行安装' }}</p></div>
          </div>
          <dl class="detail-list runtime-details">
            <div><dt>当前构建</dt><dd class="mono">{{ shortHash(catalog.active_commit, 12) }}</dd></div>
            <div><dt>本地版本</dt><dd>{{ catalog.installed_versions.length }} 个</dd></div>
            <div><dt>Action Run</dt><dd><a v-if="activeVersion?.run_url" :href="activeVersion.run_url" target="_blank" rel="noopener noreferrer">#{{ activeVersion.run_id }}<ExternalLink :size="13" /></a><span v-else>未记录</span></dd></div>
            <div><dt>二进制摘要</dt><dd class="mono">{{ shortHash(activeVersion?.binary_sha256, 14) }}</dd></div>
          </dl>
        </template>
      </section>
    </div>

    <section class="panel version-panel">
      <header class="panel__header version-panel__header">
        <div><h2>KixDNS 版本</h2><p>成功 Action 构建与本地版本库存</p></div>
        <button class="icon-button" type="button" title="刷新版本" :disabled="loadingVersions || versionAction !== null" @click="loadVersions()"><RefreshCw :size="18" :class="{ spin: loadingVersions }" /></button>
      </header>
      <div v-if="loadingVersions && !catalog" class="version-loading">正在读取可用构建…</div>
      <div v-else-if="catalog" class="version-columns">
        <div class="remote-versions">
          <div class="version-section-title"><div><Download :size="16" /><strong>可用构建</strong></div><span>{{ catalog.remote_versions.length }} 个</span></div>
          <div class="version-list">
            <article v-for="(version, index) in catalog.remote_versions" :key="version.commit" class="version-row">
              <div class="version-identity"><div><code>{{ shortHash(version.commit, 12) }}</code><span v-if="index === 0" class="tag tag--success">最新</span><span v-else-if="version.active" class="tag tag--success">当前</span><span v-else-if="version.installed" class="tag tag--muted">本地</span></div><p>{{ buildTime(version.created_at) }} · <a :href="version.run_url" target="_blank" rel="noopener noreferrer">Run #{{ version.run_id }}<ExternalLink :size="12" /></a></p></div>
              <button v-if="version.active" class="button button--secondary version-action" type="button" disabled><CircleCheck :size="15" />当前版本</button>
              <button v-else-if="version.installed" class="button button--secondary version-action" type="button" :disabled="versionAction !== null" @click="activateVersion(version)"><RotateCw :size="15" :class="{ spin: actionBusy(version.commit) }" />{{ actionBusy(version.commit) ? '切换中' : '切换' }}</button>
              <button v-else class="button button--primary version-action" type="button" :disabled="versionAction !== null" @click="installVersion(version)"><Download :size="15" />{{ actionBusy(version.commit) ? '安装中' : '安装并启用' }}</button>
            </article>
            <div v-if="catalog.remote_versions.length === 0" class="version-empty">没有可用的成功构建</div>
          </div>
        </div>

        <aside class="local-versions">
          <div class="version-section-title"><div><Archive :size="16" /><strong>本地版本</strong></div><span>最多保留 8 个</span></div>
          <div class="local-version-list">
            <article v-for="version in catalog.installed_versions" :key="version.commit" :class="version.active ? 'local-version local-version--active' : 'local-version'">
              <div><code>{{ shortHash(version.commit, 12) }}</code><span v-if="version.active" class="tag tag--success">当前</span></div>
              <p>{{ formatDate(version.installed_at) }}</p>
              <button v-if="!version.active" class="icon-button icon-button--small" type="button" title="切换到此版本" :disabled="versionAction !== null" @click="activateVersion(version)"><RotateCw :size="14" :class="{ spin: actionBusy(version.commit) }" /></button>
            </article>
            <div v-if="catalog.installed_versions.length === 0" class="version-empty">尚无本地版本</div>
          </div>
        </aside>
      </div>
    </section>
  </div>
</template>
