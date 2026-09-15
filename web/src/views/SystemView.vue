<script setup lang="ts">
import {
  Archive,
  Bell,
  CircleCheck,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  GitBranch,
  HardDrive,
  KeyRound,
  Package,
  Play,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Square,
  Tag as TagIcon,
  Trash2,
} from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { apiRequest, jsonBody } from '../api/client'
import type {
  GithubTokenStatus,
  InstalledKixdnsVersion,
  KixdnsVersionCatalog,
  KixdnsVersionSource,
  PanelUpdateStartResponse,
  PanelUpdateStatus,
  RemoteKixdnsVersion,
  ServiceAction,
  ServiceStatus,
} from '../api/types'
import StatusBanner from '../components/StatusBanner.vue'
import { useConfirm } from '../composables/useConfirm'
import { useToast } from '../composables/useToast'
import { useUpdateStatus } from '../composables/useUpdateStatus'
import { errorMessage, formatDate, formatKixdnsVersion, shortHash } from '../utils'

type VersionAction = { identity: string; kind: 'install' | 'activate' | 'delete' }

const service = ref<ServiceStatus | null>(null)
const catalog = ref<KixdnsVersionCatalog | null>(null)
// 默认停在 action 轨道：面板实际装的就是 action 打包出来的增强版，
// release 轨道要等上游打新 tag 才会前进，开箱看到的应该是常用的那一条。
// The action track is the default: what the panel actually installs is the
// enhanced build packaged from actions, while the release track only advances
// when upstream tags a new version. The one in daily use is the one to open on.
const versionSource = ref<KixdnsVersionSource>('action')
const loadingService = ref(true)
const loadingVersions = ref(true)
const serviceAction = ref<ServiceAction | null>(null)
const versionAction = ref<VersionAction | null>(null)
const serviceError = ref('')
const versionsError = ref('')
const panelUpdate = ref<PanelUpdateStatus | null>(null)
const startingPanelUpdate = ref(false)
const githubTokenStatus = ref<GithubTokenStatus | null>(null)
const githubToken = ref('')
const githubTokenVisible = ref(false)
const githubTokenBusy = ref(false)
const githubTokenError = ref('')
const toast = useToast()
const confirm = useConfirm()
const {
  status: updateStatus,
  checking: checkingUpdates,
  error: updateError,
  refresh: refreshUpdates,
} = useUpdateStatus()
const versionPanel = ref<HTMLElement | null>(null)
let pendingService: Promise<void> | null = null
let versionsRequest = 0
let panelUpdateTimer: ReturnType<typeof setTimeout> | null = null
let panelUpdateDeadline = 0
let panelUpdateBaseline = ''

const running = computed(() => service.value?.active_state === 'active')
const installed = computed(() => catalog.value?.binary_present === true)
const managed = computed(() => catalog.value?.management_enabled !== false)
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

function versionIdentity(version: InstalledKixdnsVersion | RemoteKixdnsVersion): string {
  return `${version.source ?? 'action'}:${version.source_id ?? version.commit}`
}

function latestKixdnsVersion(): string {
  const notice = updateStatus.value?.kixdns
  if (!notice?.management_enabled || notice.source_id === null) return '未检查'
  if (notice.source === 'release') return notice.release_tag ?? `Release #${notice.source_id}`
  return notice.run_id ? `Run #${notice.run_id}` : `Artifact #${notice.source_id}`
}

function panelUpdateLabel(): string {
  if (panelUpdate.value?.state === 'checking' || panelUpdate.value?.state === 'downloading') {
    return panelUpdate.value.message || '面板正在在线更新'
  }
  if (panelUpdate.value?.state === 'failed') return panelUpdate.value.message
  const notice = updateStatus.value?.panel
  if (!notice?.latest_version) return '正式版通道尚未发布'
  if (notice.available) return '发现正式版更新'
  if (!notice.artifact) return '最新正式版暂无当前架构安装包'
  if (notice.current_release) return '当前正式版已是最新'
  return '当前开发构建不低于正式版'
}

const panelUpdateRunning = computed(() => (
  panelUpdate.value?.state === 'checking' || panelUpdate.value?.state === 'downloading'
))

const githubQuota = computed(() => {
  const rate = githubTokenStatus.value?.rate_limit
  return rate ? `${rate.remaining.toLocaleString()} / ${rate.limit.toLocaleString()}` : '等待下次 GitHub API 请求'
})

function githubRateReset(): string {
  const reset = githubTokenStatus.value?.rate_limit?.reset_at
  return reset ? formatDate(reset) : '尚未获取'
}

async function loadGithubTokenStatus(): Promise<void> {
  try {
    githubTokenStatus.value = await apiRequest<GithubTokenStatus>('/api/v1/settings/github-token')
    githubTokenError.value = ''
  } catch (error) {
    githubTokenError.value = errorMessage(error)
  }
}

async function refreshUpdatesWithQuota(): Promise<void> {
  await refreshUpdates()
  await loadGithubTokenStatus()
}

async function saveGithubToken(): Promise<void> {
  if (!githubToken.value || githubTokenBusy.value) return
  githubTokenBusy.value = true
  try {
    githubTokenStatus.value = await apiRequest<GithubTokenStatus>('/api/v1/settings/github-token', {
      method: 'PUT',
      ...jsonBody({ token: githubToken.value }),
    })
    githubToken.value = ''
    githubTokenVisible.value = false
    githubTokenError.value = ''
    toast.success('GitHub Token 已验证并保存')
    await Promise.all([loadVersions(true), refreshUpdates()])
    await loadGithubTokenStatus()
  } catch (error) {
    githubTokenError.value = errorMessage(error)
    toast.error(githubTokenError.value)
  } finally {
    githubTokenBusy.value = false
  }
}

async function deleteGithubToken(): Promise<void> {
  if (!githubTokenStatus.value?.configured || githubTokenBusy.value
    || !await confirm.ask({
      title: '删除 GitHub Token',
      body: '版本与更新检查会退回匿名访问，受更严格的速率限制。随时可以重新填一个新的。',
      confirmLabel: '删除 Token',
      destructive: true,
    })) return
  githubTokenBusy.value = true
  try {
    githubTokenStatus.value = await apiRequest<GithubTokenStatus>('/api/v1/settings/github-token', { method: 'DELETE' })
    githubToken.value = ''
    githubTokenError.value = ''
    toast.success('GitHub Token 已删除')
    await Promise.all([loadVersions(true), refreshUpdates()])
    await loadGithubTokenStatus()
  } catch (error) {
    githubTokenError.value = errorMessage(error)
    toast.error(githubTokenError.value)
  } finally {
    githubTokenBusy.value = false
  }
}

function schedulePanelUpdatePoll(delay = 2_000): void {
  if (panelUpdateTimer) clearTimeout(panelUpdateTimer)
  panelUpdateTimer = setTimeout(() => void pollPanelUpdate(), delay)
}

async function panelServerHealthy(): Promise<boolean> {
  try {
    await apiRequest<{ status: string }>('/api/v1/health')
    return true
  } catch {
    return false
  }
}

async function pollPanelUpdate(): Promise<void> {
  try {
    const next = await apiRequest<PanelUpdateStatus>('/api/v1/panel-update')
    const statusIdentity = `${next.state}:${next.target_version}:${next.updated_at}`
    if (panelUpdateBaseline && statusIdentity === panelUpdateBaseline) {
      schedulePanelUpdatePoll()
      return
    }
    panelUpdateBaseline = ''
    panelUpdate.value = next
    if (next.state === 'complete') {
      if (await panelServerHealthy()) {
        toast.success(next.message || '面板在线更新完成')
        window.location.reload()
        return
      }
    } else if (next.state === 'failed') {
      toast.error(next.message || '面板在线更新失败')
      return
    }
  } catch {
    // 面板更新会重启服务，短暂断线属于预期流程。
  }
  if (Date.now() < panelUpdateDeadline) {
    schedulePanelUpdatePoll()
  } else {
    toast.error('无法确认在线更新结果，请查看 kixdns-panel-update.service 日志')
  }
}

async function loadPanelUpdateStatus(): Promise<void> {
  try {
    panelUpdate.value = await apiRequest<PanelUpdateStatus>('/api/v1/panel-update')
    if (panelUpdateRunning.value) {
      panelUpdateDeadline = Date.now() + 30 * 60_000
      schedulePanelUpdatePoll()
    }
  } catch {
    panelUpdate.value = null
  }
}

async function startPanelUpdate(): Promise<void> {
  const version = updateStatus.value?.panel.latest_version
  if (!version || !await confirm.ask({
    title: `在线更新面板到 v${version}`,
    body: '面板会短暂重启，这期间控制台暂时打不开。KixDNS 服务、配置和当前运行状态都保持不变。',
    confirmLabel: `更新到 v${version}`,
  })) return
  startingPanelUpdate.value = true
  try {
    const previous = await apiRequest<PanelUpdateStatus>('/api/v1/panel-update')
    panelUpdateBaseline = `${previous.state}:${previous.target_version}:${previous.updated_at}`
    const result = await apiRequest<PanelUpdateStartResponse>('/api/v1/panel-update', { method: 'POST' })
    panelUpdate.value = {
      state: 'checking',
      message: `正在准备更新到 ${result.target_version}`,
      target_version: result.target_version,
      updated_at: Math.floor(Date.now() / 1_000),
    }
    panelUpdateDeadline = Date.now() + 30 * 60_000
    toast.info('在线更新已开始，面板将短暂重启')
    schedulePanelUpdatePoll(1_000)
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    startingPanelUpdate.value = false
  }
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

async function viewKixdnsVersions(): Promise<void> {
  selectVersionSource(updateStatus.value?.kixdns.source ?? 'action')
  await nextTick()
  versionPanel.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function refreshAll(): Promise<void> {
  await Promise.all([loadService(true), loadVersions(true)])
}

async function control(action: ServiceAction): Promise<void> {
  const names: Record<ServiceAction, string> = { start: '启动', stop: '停止', restart: '重启' }
  if ((action === 'stop' || action === 'restart') && !await confirm.ask({
    title: `${names[action]} KixDNS 服务`,
    body: action === 'stop'
      ? '停止期间这台机器上的 DNS 解析会中断，直到重新启动。配置和缓存都保留。'
      : '服务会短暂中断，随后按当前运行配置重新提供解析。配置不受影响。',
    confirmLabel: `${names[action]}服务`,
    destructive: action === 'stop',
  })) return
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
  versionAction.value = { identity: versionIdentity(version), kind: 'install' }
  try {
    await apiRequest<InstalledKixdnsVersion>(`/api/v1/kixdns/versions/${version.source}/${version.source_id}/install`, { method: 'POST' })
    toast.success('KixDNS 已安装并通过健康检查')
    await Promise.all([loadVersions(true), loadService(true), refreshUpdates()])
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    versionAction.value = null
  }
}

async function activateVersion(version: InstalledKixdnsVersion | RemoteKixdnsVersion): Promise<void> {
  if (version.active) return
  const source = version.source ?? 'action'
  const identity = version.source_id ?? version.commit
  versionAction.value = { identity: versionIdentity(version), kind: 'activate' }
  try {
    await apiRequest<InstalledKixdnsVersion>(`/api/v1/kixdns/versions/${source}/${identity}/activate`, { method: 'POST' })
    toast.success('KixDNS 版本已切换并通过健康检查')
    await Promise.all([loadVersions(true), loadService(true), refreshUpdates()])
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    versionAction.value = null
  }
}

async function deleteVersion(version: InstalledKixdnsVersion): Promise<void> {
  if (version.active) return
  if (!await confirm.ask({
    title: `删除本地版本 ${formatKixdnsVersion(version)}`,
    body: '这份构建会从本地库存移除，之后要用得重新下载。当前正在运行的版本不受影响。',
    confirmLabel: '删除这个版本',
    destructive: true,
  })) return
  const source = version.source ?? 'action'
  const identity = version.source_id ?? version.commit
  versionAction.value = { identity: versionIdentity(version), kind: 'delete' }
  try {
    await apiRequest<InstalledKixdnsVersion>(`/api/v1/kixdns/versions/${source}/${identity}/delete`, { method: 'POST' })
    toast.success('本地 KixDNS 版本已删除')
    await loadVersions(true)
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    versionAction.value = null
  }
}

function actionBusy(version: InstalledKixdnsVersion | RemoteKixdnsVersion, kind?: VersionAction['kind']): boolean {
  return versionAction.value?.identity === versionIdentity(version)
    && (!kind || versionAction.value.kind === kind)
}

onMounted(() => {
  void Promise.all([refreshAll(), refreshUpdates()]).then(() => loadGithubTokenStatus())
  void loadPanelUpdateStatus()
})

onBeforeUnmount(() => {
  if (panelUpdateTimer) clearTimeout(panelUpdateTimer)
})
</script>

<template>
  <div class="page system-page">
    <StatusBanner v-if="loadError" :message="loadError" :stale="Boolean(service || catalog)" :busy="loadingService || loadingVersions" @retry="refreshAll" />
    <!-- 按「要不要现在动手」排：服务状态在最上且只有一行，
         有更新时更新块紧随其后，不需要动手的安装信息和凭据降到下面。 -->
    <section class="panel service-panel">
      <div v-if="loadingService && !service" class="inline-loading">读取服务状态…</div>
      <template v-else-if="service">
        <div class="service-line">
          <span :class="running ? 'service-dot' : 'service-dot service-dot--stopped'"></span>
          <strong class="mono">{{ service.unit }}</strong>
          <span class="service-line__state">{{ running ? '正在运行' : '已停止' }}</span>
          <span class="service-line__meta mono">{{ service.main_pid ? `PID ${service.main_pid} · ` : '' }}{{ service.active_state }}/{{ service.sub_state }}</span>
          <div class="service-actions">
            <button class="button button--secondary" type="button" :disabled="!installed || running || serviceAction !== null" @click="control('start')"><Play :size="16" />启动</button>
            <button class="button button--secondary" type="button" :disabled="!installed || !running || serviceAction !== null" @click="control('restart')"><RotateCw :size="16" :class="{ spin: serviceAction === 'restart' }" />重启</button>
            <button class="button button--danger-quiet" type="button" :disabled="!running || serviceAction !== null" @click="control('stop')"><Square :size="15" />停止</button>
          </div>
        </div>
      </template>
      <div v-else class="inline-loading">服务状态暂不可用</div>
    </section>

    <section class="panel update-panel">
      <header class="panel__header">
        <div><h2>可用更新</h2><p>KixDNS 增强包与面板正式版</p></div>
        <button class="icon-button" type="button" title="检查更新" aria-label="检查更新" :disabled="checkingUpdates" @click="refreshUpdatesWithQuota"><RefreshCw :size="18" :class="{ spin: checkingUpdates }" /></button>
      </header>
      <div v-if="checkingUpdates && !updateStatus" class="inline-loading update-loading">正在检查更新…</div>
      <div v-else-if="updateStatus" class="update-rows">
        <!-- 每项真正有用的只有「从哪到哪」和一个按钮，压成一行。 -->
        <article class="update-row" :class="{ 'update-row--ready': updateStatus.kixdns.available }">
          <span class="update-row__mark"><GitBranch :size="17" /></span>
          <div class="update-row__body">
            <strong>KixDNS 增强包</strong>
            <p class="update-row__from-to">
              <template v-if="updateStatus.kixdns.management_enabled && updateStatus.kixdns.available"><span class="mono">{{ formatKixdnsVersion(activeVersion) }}</span> → <span class="mono">{{ latestKixdnsVersion() }}</span></template>
              <template v-else-if="!updateStatus.kixdns.management_enabled">版本管理由用户保留，面板不替换二进制</template>
              <template v-else-if="updateStatus.kixdns.current_commit">当前轨道已是最新 · <span class="mono">{{ formatKixdnsVersion(activeVersion) }}</span></template>
              <template v-else>尚未安装，选择一个构建开始</template>
            </p>
            <p class="update-row__note">{{ updateStatus.kixdns.source === 'release' ? 'RELEASES' : 'ACTIONS' }} 轨道<template v-if="updateStatus.kixdns.created_at"> · 构建于 {{ buildTime(updateStatus.kixdns.created_at) }}</template></p>
          </div>
          <div v-if="updateStatus.kixdns.management_enabled" class="update-row__actions">
            <button class="button button--primary" type="button" @click="viewKixdnsVersions"><Download :size="15" />查看版本</button>
            <a v-if="updateStatus.kixdns.build_url" class="button button--secondary" :href="updateStatus.kixdns.build_url" target="_blank" rel="noopener noreferrer">构建详情<ExternalLink :size="14" /></a>
          </div>
          <span v-else class="update-row__note update-row__note--aside">迁移需重新运行安装程序</span>
        </article>

        <article class="update-row" :class="{ 'update-row--ready': updateStatus.panel.available }">
          <span class="update-row__mark"><Bell :size="17" /></span>
          <div class="update-row__body">
            <strong>KixDNS Panel</strong>
            <p class="update-row__from-to">
              <template v-if="updateStatus.panel.available"><span class="mono">{{ updateStatus.panel.current_release ?? `v${updateStatus.panel.current_version}` }}</span> → <span class="mono">v{{ updateStatus.panel.latest_version }}</span></template>
              <template v-else>{{ panelUpdateLabel() }}</template>
            </p>
            <p class="update-row__note">RELEASE 轨道<template v-if="updateStatus.panel.published_at"> · 发布于 {{ buildTime(updateStatus.panel.published_at) }}</template></p>
          </div>
          <div v-if="updateStatus.panel.release_url" class="update-row__actions">
            <button v-if="updateStatus.panel.available" class="button button--primary" type="button" :disabled="startingPanelUpdate || panelUpdateRunning" @click="startPanelUpdate"><RefreshCw :size="15" :class="{ spin: startingPanelUpdate || panelUpdateRunning }" />{{ panelUpdateRunning ? '更新中' : '在线更新' }}</button>
            <a class="button button--secondary" :href="updateStatus.panel.release_url" target="_blank" rel="noopener noreferrer">发布说明<ExternalLink :size="14" /></a>
          </div>
          <span v-else class="update-row__note update-row__note--aside">首个正式 Release 发布后显示</span>
        </article>
      </div>
      <div v-else class="update-check-failed">
        <span>{{ updateError ? `检查失败：${updateError}` : '更新状态暂不可用' }}</span>
        <button class="button button--secondary" type="button" :disabled="checkingUpdates" @click="refreshUpdatesWithQuota">重新检查</button>
      </div>
      <div v-if="updateError && updateStatus" class="update-stale">最近一次检查失败，当前显示上次结果：{{ updateError }}</div>
    </section>


    <!-- 不需要现在动手的两块：当前装的是什么，和查更新用的凭据。 -->
    <div class="system-layout">
    <section class="panel runtime-panel">
      <header class="panel__header"><div><h2>安装状态</h2><p>增强版运行时</p></div><Package :size="20" /></header>
      <div v-if="loadingVersions && !catalog" class="inline-loading">读取安装状态…</div>
      <template v-else-if="catalog">
        <div :class="installed ? 'runtime-state' : 'runtime-state runtime-state--missing'">
          <span><ShieldCheck v-if="!managed" :size="22" /><HardDrive v-else :size="22" /></span>
          <div><strong>{{ !managed ? '外部 KixDNS 已保留' : (installed ? 'KixDNS 已安装' : 'KixDNS 尚未安装') }}</strong><p class="mono">{{ !managed ? '面板未接管二进制和版本' : (installed ? (activeVersion?.upstream_commit ? `${formatKixdnsVersion(activeVersion)} · 上游 ${shortHash(activeVersion.upstream_commit, 12)} · p${activeVersion.patchset}` : '构建身份未记录') : '选择下方构建进行安装') }}</p></div>
        </div>
        <dl v-if="managed" class="detail-list runtime-details">
          <div><dt>当前版本</dt><dd class="mono">{{ formatKixdnsVersion(activeVersion) }}</dd></div>
          <div><dt>增强构建</dt><dd class="mono">{{ shortHash(activeVersion?.commit ?? catalog.active_commit, 12) }}</dd></div>
          <div><dt>控制协议</dt><dd>{{ activeVersion?.control_protocol ? `v${activeVersion.control_protocol}` : '未记录' }}</dd></div>
          <div><dt>安装来源</dt><dd><a v-if="activeVersion?.source_url" :href="activeVersion.source_url" target="_blank" rel="noopener noreferrer">上游详情<ExternalLink :size="13" /></a><span v-else>未记录</span></dd></div>
          <div><dt>二进制摘要</dt><dd class="mono">{{ shortHash(activeVersion?.binary_sha256, 14) }}</dd></div>
        </dl>
        <dl v-else class="detail-list runtime-details">
          <div><dt>部署模式</dt><dd>外部安装</dd></div>
          <div><dt>版本管理</dt><dd>已禁用</dd></div>
          <div><dt>服务控制</dt><dd>按权限提供</dd></div>
          <div><dt>增强协议</dt><dd>按运行版本提供</dd></div>
        </dl>
      </template>
    </section>

      <section class="panel credential-panel">
        <header class="panel__header"><div><h2>凭据</h2><p>用于版本与更新检查</p></div><KeyRound :size="20" /></header>
      <div class="github-credential">
        <div class="github-credential__summary">
          <span><KeyRound :size="18" /></span>
          <div><strong>GitHub API 凭据</strong><p>用于版本与更新检查，不会发送到 nightly.link</p></div>
          <span :class="githubTokenStatus?.configured ? 'tag tag--success' : 'tag tag--muted'">{{ githubTokenStatus?.configured ? '已配置' : '匿名' }}</span>
        </div>
        <div class="github-credential__form">
          <label class="github-token-input">
            <input v-model="githubToken" :type="githubTokenVisible ? 'text' : 'password'" :placeholder="githubTokenStatus?.configured ? '输入新 Token 以替换' : 'github_pat_… 或 ghp_…'" autocomplete="new-password" maxlength="256" :disabled="githubTokenBusy" @keyup.enter="saveGithubToken">
            <button type="button" :title="githubTokenVisible ? '隐藏 Token' : '显示 Token'" :aria-label="githubTokenVisible ? '隐藏 Token' : '显示 Token'" @click="githubTokenVisible = !githubTokenVisible"><EyeOff v-if="githubTokenVisible" :size="15" /><Eye v-else :size="15" /></button>
          </label>
          <button class="button button--primary" type="button" :disabled="!githubToken || githubTokenBusy" @click="saveGithubToken">{{ githubTokenBusy ? '处理中' : (githubTokenStatus?.configured ? '替换' : '保存') }}</button>
          <button class="icon-button icon-button--danger" type="button" title="删除 Token" aria-label="删除 Token" :disabled="!githubTokenStatus?.configured || githubTokenBusy" @click="deleteGithubToken"><Trash2 :size="16" /></button>
        </div>
        <div class="github-credential__meta">
          <span>API 配额 <strong class="mono">{{ githubQuota }}</strong></span>
          <span>重置时间 <strong>{{ githubRateReset() }}</strong></span>
          <span v-if="githubTokenError" class="github-credential__error">{{ githubTokenError }}</span>
        </div>
      </div>
      </section>
    </div>

    <section ref="versionPanel" class="panel version-panel">
      <header class="panel__header version-panel__header">
        <div><h2>KixDNS 版本</h2><p>{{ managed ? '远端版本源与本地版本库存' : '外部安装未纳入面板版本管理' }}</p></div>
        <div v-if="managed" class="version-panel__tools">
          <div class="version-source-tabs" role="tablist" aria-label="版本源">
            <button type="button" role="tab" :aria-selected="versionSource === 'action'" :class="{ 'version-source-tab--active': versionSource === 'action' }" @click="selectVersionSource('action')"><GitBranch :size="14" />Actions</button>
            <button type="button" role="tab" :aria-selected="versionSource === 'release'" :class="{ 'version-source-tab--active': versionSource === 'release' }" @click="selectVersionSource('release')"><TagIcon :size="14" />Releases</button>
          </div>
          <button class="icon-button" type="button" title="刷新版本" :disabled="loadingVersions || versionAction !== null" @click="loadVersions()"><RefreshCw :size="18" :class="{ spin: loadingVersions }" /></button>
        </div>
      </header>
      <div v-if="loadingVersions && (!catalog || catalog.source !== versionSource)" class="version-loading">正在读取可用构建…</div>
      <div v-else-if="catalog && !catalog.management_enabled" class="external-mode-notice">
        <span><ShieldCheck :size="20" /></span>
        <div><strong>现有 KixDNS 保持原样</strong><p>面板不会下载、替换或删除其二进制。需要迁移时，请重新运行安装程序并明确选择“迁移替换”。</p></div>
      </div>
      <div v-else-if="catalog && catalog.source === versionSource" class="version-columns">
        <div class="remote-versions">
          <div class="version-section-title"><div><Download :size="16" /><strong>{{ versionSource === 'release' ? '可用发布' : '可用构建' }}</strong></div><span>{{ catalog.remote_versions.length }} 个</span></div>
          <div class="version-list">
            <article v-for="(version, index) in catalog.remote_versions" :key="`${version.source}-${version.source_id}`" class="version-row">
              <div class="version-identity">
                <div><span class="identity-label">{{ version.source === 'release' ? 'Release' : 'Action' }}</span><code>{{ formatKixdnsVersion(version) }}</code><span v-if="index === 0" class="tag tag--success">{{ version.source === 'release' ? '最新发布' : '最新' }}</span><span v-if="version.active" class="tag tag--success">当前</span><span v-else-if="version.installed" class="tag tag--muted">本地</span></div>
                <p><span class="mono">增强 {{ shortHash(version.commit, 9) }}</span><span>{{ artifactArchitecture(version.artifact) }}</span><span v-if="version.patchset">p{{ version.patchset }}</span><a :href="version.source_url" target="_blank" rel="noopener noreferrer">上游详情<ExternalLink :size="12" /></a><a :href="version.build_url" target="_blank" rel="noopener noreferrer">增强 Action<ExternalLink :size="12" /></a><span class="mono">包 {{ artifactDigest(version.artifact_digest) }}</span><span>{{ buildTime(version.created_at) }}</span></p>
              </div>
              <button v-if="version.active" class="button button--secondary version-action" type="button" disabled><CircleCheck :size="15" />当前版本</button>
              <button v-else-if="version.installed" class="button button--secondary version-action" type="button" :disabled="versionAction !== null" @click="activateVersion(version)"><RotateCw :size="15" :class="{ spin: actionBusy(version) }" />{{ actionBusy(version) ? '切换中' : '切换' }}</button>
              <button v-else class="button button--primary version-action" type="button" :disabled="versionAction !== null" @click="installVersion(version)"><Download :size="15" />{{ actionBusy(version) ? '安装中' : '安装并启用' }}</button>
            </article>
            <div v-if="catalog.remote_error" class="version-empty">远端版本暂不可用，本地安装信息不受影响：{{ catalog.remote_error }}</div>
            <div v-else-if="catalog.remote_versions.length === 0" class="version-empty">{{ versionSource === 'release' ? '尚无可用 Release' : '没有可用的成功构建' }}</div>
          </div>
        </div>

        <aside class="local-versions">
          <div class="version-section-title"><div><Archive :size="16" /><strong>本地版本</strong></div><span>最多保留 8 个</span></div>
          <div class="local-version-list">
            <article v-for="version in catalog.installed_versions" :key="versionIdentity(version)" :class="version.active ? 'local-version local-version--active' : 'local-version'">
              <div><span class="identity-label">{{ version.source === 'release' ? 'Release' : 'Action' }}</span><code>{{ formatKixdnsVersion(version) }}</code><span v-if="version.active" class="tag tag--success">当前</span></div>
              <p v-if="version.upstream_commit"><span class="mono">上游 {{ shortHash(version.upstream_commit, 9) }}</span><span>p{{ version.patchset }}</span><span>{{ artifactArchitecture(version.artifact) }}</span><a v-if="version.source_url" :href="version.source_url" target="_blank" rel="noopener noreferrer">上游详情</a><a v-if="version.build_url" :href="version.build_url" target="_blank" rel="noopener noreferrer">增强 Action</a></p>
              <p v-else>构建身份未记录</p>
              <p><span class="mono">增强 {{ shortHash(version.commit, 9) }}</span><span class="mono">二进制 {{ shortHash(version.binary_sha256, 12) }}</span><span>{{ formatDate(version.installed_at) }}</span></p>
              <div v-if="!version.active" class="local-version-actions">
                <button class="icon-button icon-button--small" type="button" title="切换到此版本" aria-label="切换到此版本" :disabled="versionAction !== null" @click="activateVersion(version)"><RotateCw :size="14" :class="{ spin: actionBusy(version, 'activate') }" /></button>
                <button class="icon-button icon-button--small icon-button--danger" type="button" :title="actionBusy(version, 'delete') ? '正在删除' : '删除本地版本'" aria-label="删除本地版本" :disabled="versionAction !== null" @click="deleteVersion(version)"><RefreshCw v-if="actionBusy(version, 'delete')" :size="14" class="spin" /><Trash2 v-else :size="14" /></button>
              </div>
            </article>
            <div v-if="catalog.installed_versions.length === 0" class="version-empty">尚无本地版本</div>
          </div>
        </aside>
      </div>
      <div v-else class="version-empty">版本目录暂不可用</div>
    </section>
  </div>
</template>
