<script setup lang="ts">
import {
  Bell,
  Eye,
  EyeOff,
  ExternalLink,
  GitBranch,
  KeyRound,
  Play,
  RefreshCw,
  RotateCw,
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
import UiCard from '../components/ui/UiCard.vue'
import UiPageHeader from '../components/ui/UiPageHeader.vue'
import UiTabs from '../components/ui/UiTabs.vue'
import UiTask, { type UiTaskState } from '../components/ui/UiTask.vue'
import { useConfirm } from '../composables/useConfirm'
import { useToast } from '../composables/useToast'
import { useUpdateStatus } from '../composables/useUpdateStatus'
import { errorMessage, formatDate, formatKixdnsVersion, shortHash } from '../utils'
import { switchConfirmBody, switchedMessage } from '../version-switch'

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
const versionSources = [
  { value: 'action', label: 'Actions', icon: GitBranch },
  { value: 'release', label: 'Releases', icon: TagIcon },
] as const
// 在线更新从这一页开始时才知道起点，已用时间只在那时显示；刷新进来遇到正在进行的更新就不猜。
// The start of an online update is only known when this page began it, so the
// elapsed time shows only then; an update already running on reload is not guessed at.
const panelUpdateStartedAt = ref<number | null>(null)
let pendingService: Promise<void> | null = null
let versionsRequest = 0
let panelUpdateTimer: ReturnType<typeof setTimeout> | null = null
let panelUpdateDeadline = 0
let panelUpdateBaseline = ''
// 在线更新失败的原因一直留在状态文件里，直到下一次更新重写；「知道了」只在这个浏览器里记下看过的那一次。
// A failed online update stays in the status file until the next update rewrites it; "知道了" only
// remembers, in this browser, which failure was already seen.
const PANEL_UPDATE_DISMISSED_KEY = 'kixdns:panel-update-failure-dismissed'
const dismissedPanelUpdateFailure = ref(readDismissedPanelUpdateFailure())

const running = computed(() => service.value?.active_state === 'active')
// 「正在运行 · active/running」「已停止 · inactive/dead」是同一件事说两遍；只有启动中、
// 自动重启这类不寻常的状态，systemd 的原始写法才多带了信息。
// "正在运行 · active/running" and "已停止 · inactive/dead" say one thing twice; only
// unusual states such as activating or auto-restart carry information in systemd's own words.
const unusualServiceState = computed(() => {
  const state = service.value ? `${service.value.active_state}/${service.value.sub_state}` : ''
  return state && !['active/running', 'inactive/dead'].includes(state) ? state : ''
})
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

function versionIdentity(version: InstalledKixdnsVersion | RemoteKixdnsVersion): string {
  return `${version.source ?? 'action'}:${version.source_id ?? version.commit}`
}

function latestKixdnsVersion(): string {
  const notice = updateStatus.value?.kixdns
  if (!notice || notice.source_id === null) return '未检查'
  if (notice.source === 'release') return notice.release_tag ?? `Release #${notice.source_id}`
  return notice.run_id ? `Run #${notice.run_id}` : `Artifact #${notice.source_id}`
}

function panelUpdateLabel(): string {
  if (panelUpdate.value?.state === 'checking' || panelUpdate.value?.state === 'downloading') {
    return panelUpdate.value.message || '面板正在在线更新'
  }
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

function panelUpdateIdentity(status: PanelUpdateStatus): string {
  return `${status.state}:${status.target_version}:${status.updated_at}`
}

function readDismissedPanelUpdateFailure(): string {
  try {
    return window.localStorage.getItem(PANEL_UPDATE_DISMISSED_KEY) ?? ''
  } catch {
    return ''
  }
}

// 失败原因单独占一行：有可用更新时标题行显示版本变化，原来混在标题里的失败在那时根本看不到。
// The failure reason gets its own line: with an update available the title line shows the version
// change, and a failure folded into the title was never visible then.
const panelUpdateFailure = computed(() => {
  const status = panelUpdate.value
  if (status?.state !== 'failed') return ''
  if (panelUpdateIdentity(status) === dismissedPanelUpdateFailure.value) return ''
  return status.message || '面板在线更新失败，详情见 journalctl -u kixdns-panel-update.service'
})

const panelTaskState = computed<UiTaskState>(() => {
  if (panelUpdateRunning.value) return 'run'
  if (panelUpdateFailure.value) return 'fail'
  return 'idle'
})

function dismissPanelUpdateFailure(): void {
  if (!panelUpdate.value) return
  dismissedPanelUpdateFailure.value = panelUpdateIdentity(panelUpdate.value)
  try {
    window.localStorage.setItem(PANEL_UPDATE_DISMISSED_KEY, dismissedPanelUpdateFailure.value)
  } catch {
    // 本地存储不可用时，只在当前页面内隐藏。/ Without local storage, hide it for this page only.
  }
}

/**
 * 配额未知时整行换一句话，而不是给两个标签各配一句话。
 *
 * 原来写的是「API 配额 等待下次 GitHub API 请求  重置时间 尚未获取」：两个
 * 「标签 + 值」的槽位里塞的都是句子，挤在一行读成一句不知所云的长句，而且两句
 * 说的是同一件事——面板还没问过 GitHub。数值槽位就该放数值。
 *
 * When the quota is unknown the whole line becomes one sentence instead of
 * giving each label a sentence of its own. It used to read "API quota waiting
 * for the next GitHub API request  reset time not yet retrieved": two
 * label-and-value slots each filled with prose, running together into one
 * baffling line, and both saying the same thing — the panel has not asked GitHub
 * yet. A slot for a figure should hold a figure.
 */
const githubRate = computed(() => githubTokenStatus.value?.rate_limit ?? null)

const githubQuota = computed(() => {
  const rate = githubRate.value
  return rate ? `${rate.remaining.toLocaleString()} / ${rate.limit.toLocaleString()}` : ''
})

function githubRateReset(): string {
  const reset = githubRate.value?.reset_at
  return reset ? formatDate(reset) : ''
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
    const statusIdentity = panelUpdateIdentity(next)
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
    toast.error('无法确认在线更新结果，请执行 journalctl -u kixdns-panel-update.service 查看')
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
    panelUpdateBaseline = panelUpdateIdentity(previous)
    const result = await apiRequest<PanelUpdateStartResponse>('/api/v1/panel-update', { method: 'POST' })
    panelUpdate.value = {
      state: 'checking',
      message: `正在准备更新到 ${result.target_version}`,
      target_version: result.target_version,
      updated_at: Math.floor(Date.now() / 1_000),
    }
    panelUpdateDeadline = Date.now() + 30 * 60_000
    panelUpdateStartedAt.value = Date.now()
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
  if (!await confirm.ask({
    title: `安装并切换到 ${formatKixdnsVersion(version)}`,
    body: `先下载并校验这个构建。${switchConfirmBody(service.value)}`,
    confirmLabel: '安装并切换',
  })) return
  versionAction.value = { identity: versionIdentity(version), kind: 'install' }
  try {
    await apiRequest<InstalledKixdnsVersion>(`/api/v1/kixdns/versions/${version.source}/${version.source_id}/install`, { method: 'POST' })
    await Promise.all([loadVersions(true), loadService(true), refreshUpdates()])
    toast.success(switchedMessage(service.value, '已安装'))
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    versionAction.value = null
  }
}

async function activateVersion(version: InstalledKixdnsVersion | RemoteKixdnsVersion): Promise<void> {
  if (version.active) return
  if (!await confirm.ask({
    title: `切换到 ${formatKixdnsVersion(version)}`,
    body: switchConfirmBody(service.value),
    confirmLabel: '切换版本',
  })) return
  const source = version.source ?? 'action'
  const identity = version.source_id ?? version.commit
  versionAction.value = { identity: versionIdentity(version), kind: 'activate' }
  try {
    await apiRequest<InstalledKixdnsVersion>(`/api/v1/kixdns/versions/${source}/${identity}/activate`, { method: 'POST' })
    await Promise.all([loadVersions(true), loadService(true), refreshUpdates()])
    toast.success(switchedMessage(service.value, '版本已切换'))
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
    <!-- 按「要不要现在动手」排：服务状态就在页头，一行说清在不在跑、要不要动它；
         有更新时更新紧随其后，不需要动手的安装信息和凭据降到下面。整页没有黑按钮：
         这一页是看状态、偶尔操作，列表里每行的操作一律用次要按钮。
         Ordered by whether you need to act now: the service state lives in the
         page header, one line saying whether it runs and whether to touch it;
         updates follow, and what needs no action sits lower. There is no black
         button on this page: it is read and occasionally acted on, and every row
         action is a secondary button. -->
    <UiPageHeader class="service-line" title="系统" stack>
      <template #meta>
        <template v-if="service">
          <span class="ui-dot" :class="{ 'ui-dot--off': !running }"></span>
          <span class="ui-mono">{{ service.unit }}</span>
          <span>{{ running ? '正在运行' : '已停止' }}</span>
          <template v-if="service.main_pid"><span class="ui-sep">·</span><span>PID <span class="ui-mono">{{ service.main_pid }}</span></span></template>
          <template v-if="unusualServiceState"><span class="ui-sep">·</span><span class="ui-mono">{{ unusualServiceState }}</span></template>
        </template>
        <span v-else-if="loadingService" class="sk system-skeleton-meta" role="status" aria-label="读取服务状态"></span>
        <span v-else>服务状态暂不可用</span>
      </template>
      <template v-if="service" #actions>
        <button v-if="!running" class="ui-btn ui-btn--secondary" type="button" :disabled="!installed || serviceAction !== null" @click="control('start')"><Play :size="16" />启动</button>
        <template v-else>
          <button class="ui-btn ui-btn--secondary" type="button" :disabled="!installed || serviceAction !== null" @click="control('restart')"><RotateCw :size="16" :class="{ spin: serviceAction === 'restart' }" />重启</button>
          <button class="ui-btn ui-btn--danger" type="button" :disabled="serviceAction !== null" @click="control('stop')"><Square :size="15" />停止</button>
        </template>
      </template>
    </UiPageHeader>

    <UiCard class="update-panel" title="可用更新">
      <template #actions>
        <button class="ui-icon-btn" type="button" title="检查更新" aria-label="检查更新" :disabled="checkingUpdates" @click="refreshUpdatesWithQuota"><RefreshCw :size="18" :class="{ spin: checkingUpdates }" /></button>
      </template>
      <div v-if="checkingUpdates && !updateStatus" class="system-skeleton-rows" role="status" aria-label="正在检查更新"><i v-for="n in 2" :key="n" class="sk"></i></div>
      <div v-else-if="updateStatus" :class="{ 'is-refreshing': checkingUpdates }">
        <UiTask class="update-row" state="idle" title="KixDNS 增强包">
          <template #icon><GitBranch :size="15" /></template>
          <template #title><span class="ui-tag">{{ updateStatus.kixdns.source === 'release' ? 'Release 轨道' : 'Action 轨道' }}</span><span v-if="updateStatus.kixdns.available" class="ui-tag ui-tag--strong">{{ updateStatus.kixdns.security_update ? '安全更新' : '有新版本' }}</span></template>
          <template #meta>
            <span class="update-row__from-to">
              <template v-if="updateStatus.kixdns.available && updateStatus.kixdns.security_update"><span class="ui-mono">{{ formatKixdnsVersion(activeVersion) }}</span> 依赖安全升级<template v-if="updateStatus.kixdns.dependency_revision"> · <span class="ui-mono">r{{ updateStatus.kixdns.dependency_revision }}</span></template></template>
              <template v-else-if="updateStatus.kixdns.available"><span class="ui-mono">{{ formatKixdnsVersion(activeVersion) }}</span> → <span class="ui-mono">{{ latestKixdnsVersion() }}</span></template>
              <template v-else-if="updateStatus.kixdns.current_commit">当前轨道已是最新 · <span class="ui-mono">{{ formatKixdnsVersion(activeVersion) }}</span></template>
              <template v-else>尚未安装，选择一个构建开始</template>
            </span>
            <span v-if="updateStatus.kixdns.created_at">构建于 {{ buildTime(updateStatus.kixdns.created_at) }}</span>
          </template>
          <template #actions>
            <a v-if="updateStatus.kixdns.build_url" class="ui-link" :href="updateStatus.kixdns.build_url" target="_blank" rel="noopener noreferrer">构建详情<ExternalLink :size="12" /></a>
            <button class="ui-btn ui-btn--secondary ui-btn--sm" type="button" @click="viewKixdnsVersions">查看版本</button>
          </template>
        </UiTask>

        <UiTask class="update-row" :state="panelTaskState" title="KixDNS Panel" :started-at="panelUpdateStartedAt">
          <template #icon><Bell :size="15" /></template>
          <template #title><span class="ui-tag">Release 轨道</span><span v-if="updateStatus.panel.available" class="ui-tag ui-tag--strong">有新版本</span></template>
          <template #meta>
            <span class="update-row__from-to">
              <template v-if="panelUpdateRunning">{{ panelUpdateLabel() }}</template>
              <template v-else-if="updateStatus.panel.available"><span class="ui-mono">{{ updateStatus.panel.current_release ?? `v${updateStatus.panel.current_version}` }}</span> → <span class="ui-mono">v{{ updateStatus.panel.latest_version }}</span></template>
              <template v-else>{{ panelUpdateLabel() }}</template>
            </span>
            <span v-if="updateStatus.panel.published_at">发布于 {{ buildTime(updateStatus.panel.published_at) }}</span>
            <span v-if="!updateStatus.panel.release_url">首个正式 Release 发布后显示</span>
            <p v-if="panelUpdateFailure" class="ui-task__error update-row__failure" role="alert">
              <span>{{ panelUpdateFailure }}</span>
              <button class="ui-btn ui-btn--secondary ui-btn--sm" type="button" @click="dismissPanelUpdateFailure">知道了</button>
            </p>
          </template>
          <template v-if="updateStatus.panel.release_url" #actions>
            <a class="ui-link" :href="updateStatus.panel.release_url" target="_blank" rel="noopener noreferrer">发布说明<ExternalLink :size="12" /></a>
            <button v-if="updateStatus.panel.available" class="ui-btn ui-btn--secondary ui-btn--sm" type="button" :disabled="startingPanelUpdate || panelUpdateRunning" @click="startPanelUpdate">{{ panelUpdateRunning ? '更新中' : '在线更新' }}</button>
          </template>
        </UiTask>
      </div>
      <div v-else class="system-check-failed">
        <span>{{ updateError ? `检查失败：${updateError}` : '更新状态暂不可用' }}</span>
        <button class="ui-btn ui-btn--secondary" type="button" :disabled="checkingUpdates" @click="refreshUpdatesWithQuota">重新检查</button>
      </div>
      <template v-if="updateError && updateStatus" #foot><span class="system-stale">最近一次检查失败，当前显示上次结果：{{ updateError }}</span></template>
    </UiCard>

    <!-- 不需要现在动手的两块：当前装的是什么，和查更新用的凭据。 -->
    <div class="system-pair">
      <!-- 「装的是哪个版本」是这张卡唯一常看的事，做主角；补丁集和控制协议是这个版本的附注；
           三个哈希只在排查时看，收成细线下面的一行。原来七行一样轻重，读起来像一张表。
           Which version is installed is the one thing read here, so it leads; the
           patchset and control protocol qualify it; the three hashes matter only
           when troubleshooting and share one row under a hairline. Seven rows of
           equal weight used to read as a table. -->
      <UiCard class="runtime-panel" title="当前安装" desc="增强版运行时">
        <template v-if="catalog" #actions><span class="ui-tag" :class="installed ? 'ui-tag--ok' : 'ui-tag--warn'">{{ installed ? '已安装' : '尚未安装' }}</span></template>
        <div v-if="loadingVersions && !catalog" class="sk system-skeleton-panel" role="status" aria-label="读取安装状态"></div>
        <template v-else-if="catalog">
          <p class="install-version">{{ installed ? formatKixdnsVersion(activeVersion) : '尚未安装' }}</p>
          <p v-if="installed" class="install-meta">
            <span>{{ activeVersion?.source === 'release' ? 'Release 轨道' : 'Action 轨道' }}</span>
            <span class="ui-sep">·</span><span>补丁集 <span class="ui-mono">{{ activeVersion?.patchset ? `p${activeVersion.patchset}${activeVersion.dependency_revision ? `-r${activeVersion.dependency_revision}` : ''}` : '未记录' }}</span></span>
            <span class="ui-sep">·</span><span>控制协议 <span class="ui-mono">{{ activeVersion?.control_protocol ? `v${activeVersion.control_protocol}` : '未记录' }}</span></span>
          </p>
          <p v-else class="install-meta">选择下方构建进行安装</p>
          <dl class="ui-strip install-hashes">
            <div><dt>上游提交</dt><dd class="ui-mono">{{ activeVersion?.upstream_commit ? shortHash(activeVersion.upstream_commit, 12) : '未记录' }}</dd></div>
            <div><dt>增强构建</dt><dd class="ui-mono">{{ shortHash(activeVersion?.commit ?? catalog.active_commit, 12) }}</dd></div>
            <div><dt>二进制摘要</dt><dd class="ui-mono">{{ shortHash(activeVersion?.binary_sha256, 14) }}</dd></div>
          </dl>
        </template>
        <template v-if="catalog && installed" #foot>
          <span>{{ activeVersion?.source === 'release' ? '从 GitHub Release 安装' : '从 GitHub Actions 构建安装' }}</span>
          <a v-if="activeVersion?.source_url" class="ui-link" :href="activeVersion.source_url" target="_blank" rel="noopener noreferrer">上游详情<ExternalLink :size="12" /></a>
          <span v-else>来源未记录</span>
        </template>
      </UiCard>

      <UiCard class="credential-panel" title="GitHub 凭据" desc="用于版本检查和内核下载，不会发送到 nightly.link">
        <template #actions><span class="ui-tag" :class="{ 'ui-tag--ok': githubTokenStatus?.configured }">{{ githubTokenStatus?.configured ? '已配置' : '匿名' }}</span></template>
        <div class="credential-form">
          <!-- 占位符按 375 下量出来的可用宽度写：「github_pat_… 或 ghp_…」放不下，给一个写得下的例子就够了。
               The placeholder fits the width measured at 375; one example that fits is enough. -->
          <label class="ui-input credential-input">
            <KeyRound :size="16" aria-hidden="true" />
            <input v-model="githubToken" :type="githubTokenVisible ? 'text' : 'password'" :placeholder="githubTokenStatus?.configured ? '输入新 Token' : 'github_pat_…'" autocomplete="new-password" maxlength="256" aria-label="GitHub Token" :disabled="githubTokenBusy" @keyup.enter="saveGithubToken">
            <button class="credential-eye" type="button" :title="githubTokenVisible ? '隐藏 Token' : '显示 Token'" :aria-label="githubTokenVisible ? '隐藏 Token' : '显示 Token'" @click="githubTokenVisible = !githubTokenVisible"><EyeOff v-if="githubTokenVisible" :size="15" /><Eye v-else :size="15" /></button>
          </label>
          <button class="ui-btn ui-btn--secondary" type="button" :disabled="!githubToken || githubTokenBusy" @click="saveGithubToken">{{ githubTokenBusy ? '处理中' : (githubTokenStatus?.configured ? '替换' : '保存') }}</button>
          <button class="ui-icon-btn ui-icon-btn--danger" type="button" title="删除 Token" aria-label="删除 Token" :disabled="!githubTokenStatus?.configured || githubTokenBusy" @click="deleteGithubToken"><Trash2 :size="16" /></button>
        </div>
        <!-- 没配置时说清为什么要填：GitHub 对匿名请求每小时只给 60 次，带 Token 是 5000 次。
             Without a token, say why one helps: GitHub allows 60 anonymous requests an hour, 5,000 with a token. -->
        <p v-if="!githubTokenStatus?.configured" class="credential-hint"><span>匿名访问 GitHub 每小时只有 60 次请求，检查版本和下载内核容易被限速。</span><span>填一个 Token 后是每小时 5000 次。</span></p>
        <template #foot>
          <span v-if="githubRate">API 配额 <span class="ui-mono">{{ githubQuota }}</span> · 重置于 {{ githubRateReset() }}</span>
          <span v-else>面板还没向 GitHub 请求过，配额未知</span>
          <span v-if="githubTokenError" class="system-error">{{ githubTokenError }}</span>
        </template>
      </UiCard>
    </div>

    <div ref="versionPanel">
      <UiCard class="version-panel" title="KixDNS 版本" desc="远端构建与本地保存的版本；本地最多保留 8 个" flush stack>
        <template #actions>
          <UiTabs :model-value="versionSource" :items="versionSources" label="版本源" variant="segment" @update:model-value="selectVersionSource($event as KixdnsVersionSource)" />
          <button class="ui-icon-btn" type="button" title="刷新版本" aria-label="刷新版本" :disabled="loadingVersions || versionAction !== null" @click="loadVersions()"><RefreshCw :size="18" :class="{ spin: loadingVersions }" /></button>
        </template>
        <div v-if="loadingVersions && (!catalog || catalog.source !== versionSource)" class="system-skeleton-rows" role="status" aria-label="正在读取可用构建"><i v-for="n in 3" :key="n" class="sk"></i></div>
        <div v-else-if="catalog && catalog.source === versionSource" class="version-columns">
          <div class="remote-versions">
            <p class="version-heading">{{ versionSource === 'release' ? '可用发布' : '可用构建' }}</p>
            <article v-for="(version, index) in catalog.remote_versions" :key="`${version.source}-${version.source_id}`" class="ui-rec version-row">
              <div>
                <!-- 编号本身就是去上游构建的链接，「增强」哈希是去增强构建的链接：每行不再挂两个绿色文字链接。
                     The number itself links to the upstream build and the enhancement hash to the
                     enhanced build, so no row carries two green text links any more. -->
                <div class="ui-rec__name"><a class="ui-mono version-name version-link" :href="version.source_url" target="_blank" rel="noopener noreferrer" title="在 GitHub 打开上游构建">{{ formatKixdnsVersion(version) }}</a><span v-if="index === 0" class="ui-tag ui-tag--ok">{{ version.source === 'release' ? '最新发布' : '最新' }}</span><span v-if="version.active" class="ui-tag ui-tag--ok">当前</span><span v-else-if="version.installed" class="ui-tag">本地</span></div>
                <div class="ui-rec__meta"><a class="ui-mono version-link" :href="version.build_url" target="_blank" rel="noopener noreferrer" title="在 GitHub 打开增强构建">增强 {{ shortHash(version.commit, 9) }}</a><span class="ui-mono">{{ artifactArchitecture(version.artifact) }}</span><span v-if="version.patchset" class="ui-mono">p{{ version.patchset }}</span><span>{{ buildTime(version.created_at) }}</span></div>
              </div>
              <div class="ui-rec__act">
                <span v-if="version.active" class="version-current">正在使用</span>
                <button v-else-if="version.installed" class="ui-btn ui-btn--secondary ui-btn--sm" type="button" :disabled="versionAction !== null" @click="activateVersion(version)"><RotateCw v-if="actionBusy(version)" :size="14" class="spin" />{{ actionBusy(version) ? '切换中' : '切换' }}</button>
                <button v-else class="ui-btn ui-btn--secondary ui-btn--sm" type="button" :disabled="versionAction !== null" @click="installVersion(version)"><RefreshCw v-if="actionBusy(version)" :size="14" class="spin" />{{ actionBusy(version) ? '安装中' : '安装并切换' }}</button>
              </div>
            </article>
            <p v-if="catalog.remote_error" class="version-empty">远端版本暂不可用，本地安装信息不受影响：{{ catalog.remote_error }}</p>
            <p v-else-if="catalog.remote_versions.length === 0" class="version-empty">{{ versionSource === 'release' ? '尚无可用 Release' : '没有可用的成功构建' }}</p>
          </div>

          <div class="local-versions">
            <p class="version-heading">本地版本</p>
            <article v-for="version in catalog.installed_versions" :key="versionIdentity(version)" class="ui-rec local-version">
              <div>
                <div class="ui-rec__name"><a v-if="version.source_url" class="ui-mono version-name version-link" :href="version.source_url" target="_blank" rel="noopener noreferrer" title="在 GitHub 打开上游构建">{{ formatKixdnsVersion(version) }}</a><span v-else class="ui-mono version-name">{{ formatKixdnsVersion(version) }}</span><span v-if="version.active" class="ui-tag ui-tag--ok">当前</span></div>
                <div v-if="version.upstream_commit" class="ui-rec__meta"><span class="ui-mono">上游 {{ shortHash(version.upstream_commit, 9) }}</span><span class="ui-mono">p{{ version.patchset }}<template v-if="version.dependency_revision">-r{{ version.dependency_revision }}</template></span><span class="ui-mono">{{ artifactArchitecture(version.artifact) }}</span></div>
                <div v-else class="ui-rec__meta">构建身份未记录</div>
                <div class="ui-rec__meta"><a v-if="version.build_url" class="ui-mono version-link" :href="version.build_url" target="_blank" rel="noopener noreferrer" title="在 GitHub 打开增强构建">增强 {{ shortHash(version.commit, 9) }}</a><span v-else class="ui-mono">增强 {{ shortHash(version.commit, 9) }}</span><span class="ui-mono">二进制 {{ shortHash(version.binary_sha256, 12) }}</span><span>{{ formatDate(version.installed_at) }}</span></div>
              </div>
              <div v-if="!version.active" class="ui-rec__act">
                <button class="ui-icon-btn ui-icon-btn--sm" type="button" title="切换到此版本" aria-label="切换到此版本" :disabled="versionAction !== null" @click="activateVersion(version)"><RotateCw :size="15" :class="{ spin: actionBusy(version, 'activate') }" /></button>
                <button class="ui-icon-btn ui-icon-btn--sm ui-icon-btn--danger" type="button" :title="actionBusy(version, 'delete') ? '正在删除' : '删除本地版本'" aria-label="删除本地版本" :disabled="versionAction !== null" @click="deleteVersion(version)"><RefreshCw v-if="actionBusy(version, 'delete')" :size="15" class="spin" /><Trash2 v-else :size="15" /></button>
              </div>
            </article>
            <p v-if="catalog.installed_versions.length === 0" class="version-empty">尚无本地版本</p>
          </div>
        </div>
        <p v-else class="version-empty">版本目录暂不可用</p>
      </UiCard>
    </div>
  </div>
</template>
