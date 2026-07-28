<script setup lang="ts">
import {
  Archive,
  CircleCheck,
  Download,
  ExternalLink,
  GitBranch,
  HardDrive,
  Package,
  Play,
  RefreshCw,
  RotateCw,
  ServerCog,
  Square,
  Tag as TagIcon,
} from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { apiRequest } from '../api/client'
import type {
  InstalledKixdnsVersion,
  KixdnsVersionCatalog,
  KixdnsVersionSource,
  RemoteKixdnsVersion,
  ServiceAction,
  ServiceStatus,
} from '../api/types'
import StatusBanner from '../components/StatusBanner.vue'
import { useToast } from '../composables/useToast'
import { errorMessage, formatDate, shortHash } from '../utils'

type VersionAction = { identity: string; kind: 'install' | 'activate' }

const service = ref<ServiceStatus | null>(null)
const catalog = ref<KixdnsVersionCatalog | null>(null)
const versionSource = ref<KixdnsVersionSource>('release')
const loadingService = ref(true)
const loadingVersions = ref(true)
const serviceAction = ref<ServiceAction | null>(null)
const versionAction = ref<VersionAction | null>(null)
const serviceError = ref('')
const versionsError = ref('')
const toast = useToast()
let pendingService: Promise<void> | null = null
let versionsRequest = 0

const running = computed(() => service.value?.active_state === 'active')
const installed = computed(() => catalog.value?.binary_present === true)
const activeVersion = computed(() => catalog.value?.installed_versions.find((item) => item.active) ?? null)
const loadError = computed(() => [serviceError.value, versionsError.value].filter(Boolean).join('；'))

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

function artifactArchitecture(artifact: string): string {
  return artifact.match(/-(x86_64|arm64|aarch64)$/)?.[1] ?? artifact
}

function artifactDigest(digest: string | null | undefined): string {
  return shortHash(digest?.replace(/^sha256:/, ''), 12)
}

function sourceLabel(version: InstalledKixdnsVersion | RemoteKixdnsVersion): string {
  if (version.source === 'release') return version.release_tag ?? 'Release'
  if (version.source === 'action') return version.run_id ? `Run #${version.run_id}` : 'Action'
  return '未记录'
}

function remoteVersionLabel(version: RemoteKixdnsVersion): string {
  return version.release_tag ?? `Run #${version.run_id ?? version.source_id}`
}

function versionIdentity(version: InstalledKixdnsVersion | RemoteKixdnsVersion): string {
  return `${version.source ?? 'action'}:${version.source_id ?? version.commit}`
}

function loadService(silent = false): Promise<void> {
  if (pendingService) return pendingService
  loadingService.value = true
  pendingService = (async () => {
    service.value = await apiRequest<ServiceStatus>('/api/v1/service')
    serviceError.value = ''
  })().catch((error: unknown) => {
    serviceError.value = `服务状态：${errorMessage(error)}`
    if (!silent && service.value) toast.error(serviceError.value)
  }).finally(() => {
    loadingService.value = false
    pendingService = null
  })
  return pendingService
}

function loadVersions(silent = false): Promise<void> {
  const request = ++versionsRequest
  const source = versionSource.value
  loadingVersions.value = true
  return (async () => {
    const next = await apiRequest<KixdnsVersionCatalog>(`/api/v1/kixdns/versions?source=${source}`)
    if (request !== versionsRequest) return
    catalog.value = next
    versionsError.value = ''
  })().catch((error: unknown) => {
    if (request !== versionsRequest) return
    versionsError.value = `版本目录：${errorMessage(error)}`
    if (!silent && catalog.value) toast.error(versionsError.value)
  }).finally(() => {
    if (request !== versionsRequest) return
    loadingVersions.value = false
  })
}

function selectVersionSource(source: KixdnsVersionSource): void {
  if (source === versionSource.value) return
  versionSource.value = source
  void loadVersions()
}

async function refreshAll(): Promise<void> {
  await Promise.all([loadService(true), loadVersions(true)])
}

async function control(action: ServiceAction): Promise<void> {
  const names: Record<ServiceAction, string> = { start: '启动', stop: '停止', restart: '重启' }
  if ((action === 'stop' || action === 'restart') && !window.confirm(`${names[action]} KixDNS 服务？`)) return
  serviceAction.value = action
  try {
    service.value = await apiRequest<ServiceStatus>(`/api/v1/service/${action}`, { method: 'POST' })
    serviceError.value = ''
    toast.success(`KixDNS 服务已${names[action]}`)
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    serviceAction.value = null
  }
}

async function installVersion(version: RemoteKixdnsVersion): Promise<void> {
  if (!window.confirm(`安装并启用 ${remoteVersionLabel(version)}？KixDNS 服务会重启。`)) return
  versionAction.value = { identity: versionIdentity(version), kind: 'install' }
  try {
    await apiRequest<InstalledKixdnsVersion>(`/api/v1/kixdns/versions/${version.source}/${version.source_id}/install`, { method: 'POST' })
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
  const source = version.source ?? 'action'
  const identity = version.source_id ?? version.commit
  versionAction.value = { identity: versionIdentity(version), kind: 'activate' }
  try {
    await apiRequest<InstalledKixdnsVersion>(`/api/v1/kixdns/versions/${source}/${identity}/activate`, { method: 'POST' })
    toast.success('KixDNS 版本已切换并通过健康检查')
    await Promise.all([loadVersions(true), loadService(true)])
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    versionAction.value = null
  }
}

function actionBusy(version: InstalledKixdnsVersion | RemoteKixdnsVersion): boolean {
  return versionAction.value?.identity === versionIdentity(version)
}

onMounted(refreshAll)
</script>

<template>
  <div class="page system-page">
    <StatusBanner v-if="loadError" :message="loadError" :stale="Boolean(service || catalog)" :busy="loadingService || loadingVersions" @retry="refreshAll" />
    <div class="system-layout">
      <section class="panel service-panel">
        <header class="panel__header"><div><h2>宿主机服务</h2><p>kixdns.service</p></div><ServerCog :size="20" /></header>
        <div v-if="loadingService && !service" class="inline-loading">读取服务状态…</div>
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
        <div v-else class="inline-loading">服务状态暂不可用</div>
      </section>

      <section class="panel runtime-panel">
        <header class="panel__header"><div><h2>安装状态</h2><p>增强版运行时</p></div><Package :size="20" /></header>
        <div v-if="loadingVersions && !catalog" class="inline-loading">读取安装状态…</div>
        <template v-else-if="catalog">
          <div :class="installed ? 'runtime-state' : 'runtime-state runtime-state--missing'">
            <span><HardDrive :size="22" /></span>
            <div><strong>{{ installed ? 'KixDNS 已安装' : 'KixDNS 尚未安装' }}</strong><p class="mono">{{ installed ? (activeVersion?.upstream_commit ? `上游 ${shortHash(activeVersion.upstream_commit, 12)} · 补丁集 v${activeVersion.patchset}` : '构建身份未记录') : '选择下方构建进行安装' }}</p></div>
          </div>
          <dl class="detail-list runtime-details">
            <div><dt>当前构建</dt><dd class="mono">{{ catalog.active_source === 'release' ? 'Release' : 'Action' }} · {{ shortHash(catalog.active_commit, 12) }}</dd></div>
            <div><dt>控制协议</dt><dd>{{ activeVersion?.control_protocol ? `v${activeVersion.control_protocol}` : '未记录' }}</dd></div>
            <div><dt>安装来源</dt><dd><a v-if="activeVersion?.source_url" :href="activeVersion.source_url" target="_blank" rel="noopener noreferrer">{{ sourceLabel(activeVersion) }}<ExternalLink :size="13" /></a><span v-else>未记录</span></dd></div>
            <div><dt>二进制摘要</dt><dd class="mono">{{ shortHash(activeVersion?.binary_sha256, 14) }}</dd></div>
          </dl>
        </template>
      </section>
    </div>

    <section class="panel version-panel">
      <header class="panel__header version-panel__header">
        <div><h2>KixDNS 版本</h2><p>远端版本源与本地版本库存</p></div>
        <div class="version-panel__tools">
          <div class="version-source-tabs" role="tablist" aria-label="版本源">
            <button type="button" role="tab" :aria-selected="versionSource === 'release'" :class="{ 'version-source-tab--active': versionSource === 'release' }" @click="selectVersionSource('release')"><TagIcon :size="14" />Releases</button>
            <button type="button" role="tab" :aria-selected="versionSource === 'action'" :class="{ 'version-source-tab--active': versionSource === 'action' }" @click="selectVersionSource('action')"><GitBranch :size="14" />Actions</button>
          </div>
          <button class="icon-button" type="button" title="刷新版本" :disabled="loadingVersions || versionAction !== null" @click="loadVersions()"><RefreshCw :size="18" :class="{ spin: loadingVersions }" /></button>
        </div>
      </header>
      <div v-if="loadingVersions && (!catalog || catalog.source !== versionSource)" class="version-loading">正在读取可用构建…</div>
      <div v-else-if="catalog && catalog.source === versionSource" class="version-columns">
        <div class="remote-versions">
          <div class="version-section-title"><div><Download :size="16" /><strong>{{ versionSource === 'release' ? '可用发布' : '可用构建' }}</strong></div><span>{{ catalog.remote_versions.length }} 个</span></div>
          <div class="version-list">
            <article v-for="(version, index) in catalog.remote_versions" :key="`${version.source}-${version.source_id}`" class="version-row">
              <div class="version-identity">
                <div><span class="identity-label">增强构建</span><code>{{ shortHash(version.commit, 12) }}</code><span v-if="index === 0" class="tag tag--success">{{ version.source === 'release' ? '最新发布' : '最新' }}</span><span v-else-if="version.active" class="tag tag--success">当前</span><span v-else-if="version.installed" class="tag tag--muted">本地</span></div>
                <p><span>{{ artifactArchitecture(version.artifact) }}</span><span v-if="version.patchset">p{{ version.patchset }}</span><a :href="version.source_url" target="_blank" rel="noopener noreferrer">上游 {{ remoteVersionLabel(version) }}<ExternalLink :size="12" /></a><a :href="version.build_url" target="_blank" rel="noopener noreferrer">增强 Action<ExternalLink :size="12" /></a><span class="mono">包 {{ artifactDigest(version.artifact_digest) }}</span><span>{{ buildTime(version.created_at) }}</span></p>
              </div>
              <button v-if="version.active" class="button button--secondary version-action" type="button" disabled><CircleCheck :size="15" />当前版本</button>
              <button v-else-if="version.installed" class="button button--secondary version-action" type="button" :disabled="versionAction !== null" @click="activateVersion(version)"><RotateCw :size="15" :class="{ spin: actionBusy(version) }" />{{ actionBusy(version) ? '切换中' : '切换' }}</button>
              <button v-else class="button button--primary version-action" type="button" :disabled="versionAction !== null" @click="installVersion(version)"><Download :size="15" />{{ actionBusy(version) ? '安装中' : '安装并启用' }}</button>
            </article>
            <div v-if="catalog.remote_versions.length === 0" class="version-empty">{{ versionSource === 'release' ? '尚无可用 Release' : '没有可用的成功构建' }}</div>
          </div>
        </div>

        <aside class="local-versions">
          <div class="version-section-title"><div><Archive :size="16" /><strong>本地版本</strong></div><span>最多保留 8 个</span></div>
          <div class="local-version-list">
            <article v-for="version in catalog.installed_versions" :key="versionIdentity(version)" :class="version.active ? 'local-version local-version--active' : 'local-version'">
              <div><span class="identity-label">{{ version.source === 'release' ? 'Release' : 'Action' }}</span><code>{{ shortHash(version.commit, 12) }}</code><span v-if="version.active" class="tag tag--success">当前</span></div>
              <p v-if="version.upstream_commit"><span class="mono">上游 {{ shortHash(version.upstream_commit, 9) }}</span><span>p{{ version.patchset }}</span><span>{{ artifactArchitecture(version.artifact) }}</span><a v-if="version.source_url" :href="version.source_url" target="_blank" rel="noopener noreferrer">{{ sourceLabel(version) }}</a><a v-if="version.build_url" :href="version.build_url" target="_blank" rel="noopener noreferrer">增强 Action</a></p>
              <p v-else>构建身份未记录</p>
              <p><span class="mono">二进制 {{ shortHash(version.binary_sha256, 12) }}</span><span>{{ formatDate(version.installed_at) }}</span></p>
              <button v-if="!version.active" class="icon-button icon-button--small" type="button" title="切换到此版本" :disabled="versionAction !== null" @click="activateVersion(version)"><RotateCw :size="14" :class="{ spin: actionBusy(version) }" /></button>
            </article>
            <div v-if="catalog.installed_versions.length === 0" class="version-empty">尚无本地版本</div>
          </div>
        </aside>
      </div>
      <div v-else class="version-empty">版本目录暂不可用</div>
    </section>
  </div>
</template>
