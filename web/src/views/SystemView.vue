<script setup lang="ts">
import {
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  PanelsTopLeft,
  Play,
  RefreshCw,
  RotateCw,
  Square,
  Trash2,
} from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { apiRequest, jsonBody } from '../api/client'
import type {
  GithubTokenStatus,
  KixdnsKernel,
  PanelUpdateStartResponse,
  PanelUpdateStatus,
  ServiceAction,
  ServiceStatus,
} from '../api/types'
import StatusBanner from '../components/StatusBanner.vue'
import UiPageHeader from '../components/ui/UiPageHeader.vue'
import UiTask, { type UiTaskState } from '../components/ui/UiTask.vue'
import { useConfirm } from '../composables/useConfirm'
import { useToast } from '../composables/useToast'
import { useUpdateStatus } from '../composables/useUpdateStatus'
import { errorMessage, formatDate, formatKixdnsVersion, shortHash } from '../utils'
import { switchConfirmBody, switchedMessage } from '../version-switch'

type KernelAction = 'update' | 'rollback'

const service = ref<ServiceStatus | null>(null)
const kernel = ref<KixdnsKernel | null>(null)
const loadingService = ref(true)
const loadingKernel = ref(true)
const serviceAction = ref<ServiceAction | null>(null)
const kernelAction = ref<KernelAction | null>(null)
// 更新从这一页开始时才知道起点，已用时间只在那时显示。
// An update's start is only known when this page began it, so the elapsed time shows only then.
const kernelUpdateStartedAt = ref<number | null>(null)
const serviceError = ref('')
const kernelError = ref('')
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
// 在线更新从这一页开始时才知道起点，已用时间只在那时显示；刷新进来遇到正在进行的更新就不猜。
// The start of an online update is only known when this page began it, so the
// elapsed time shows only then; an update already running on reload is not guessed at.
const panelUpdateStartedAt = ref<number | null>(null)
let pendingService: Promise<void> | null = null
let kernelRequest = 0
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
const installed = computed(() => kernel.value?.binary_present === true)
const activeVersion = computed(() => kernel.value?.active ?? null)
const loadError = computed(() => [serviceError.value, kernelError.value].filter(Boolean).join('；'))

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

// 内核和面板的更新各查各的：一边为空时那一行写出原因，另一行照常。
// Kernel and panel updates are checked separately: a missing side states its reason in its
// own row while the other row carries on.
const kixdnsNotice = computed(() => updateStatus.value?.kixdns ?? null)
const panelNotice = computed(() => updateStatus.value?.panel ?? null)

function latestKixdnsVersion(): string {
  return kixdnsNotice.value ? `Run #${kixdnsNotice.value.run_id}` : '未检查'
}

const kernelTaskState = computed<UiTaskState>(() => (kernelAction.value === 'update' ? 'run' : 'idle'))

function panelUpdateLabel(): string {
  if (panelUpdate.value?.state === 'checking' || panelUpdate.value?.state === 'downloading') {
    return panelUpdate.value.message || '面板正在在线更新'
  }
  const notice = panelNotice.value
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

// 在线更新分两段：检查、下载并校验，然后面板重启。进度条按段走，不猜百分比。
// An online update has two stages, checking and download-and-verify, then the panel restarts.
// The bar advances by stage and never guesses a percentage.
const panelUpdateProgress = computed(() => (
  panelUpdate.value?.state === 'checking' ? 1 / 3 : panelUpdate.value?.state === 'downloading' ? 2 / 3 : null
))

// 面板自己的版本只有更新检查的结果里带着：正式版用它的标签，否则是包里的版本号。
// The panel's own version comes only with the update check: a release by its tag, otherwise the package version.
const panelVersion = computed(() => (
  panelNotice.value ? panelNotice.value.current_release ?? `v${panelNotice.value.current_version}` : ''
))

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
    await Promise.all([loadKernel(true), refreshUpdates()])
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
    await Promise.all([loadKernel(true), refreshUpdates()])
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
  const version = panelNotice.value?.latest_version
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

function loadKernel(silent = false): Promise<void> {
  const request = ++kernelRequest
  loadingKernel.value = true
  return (async () => {
    const next = await apiRequest<KixdnsKernel>('/api/v1/kixdns/kernel')
    if (request !== kernelRequest) return
    kernel.value = next
    kernelError.value = ''
  })().catch((error: unknown) => {
    if (request !== kernelRequest) return
    kernelError.value = `内核：${errorMessage(error)}`
    if (!silent && kernel.value) toast.error(kernelError.value)
  }).finally(() => {
    if (request !== kernelRequest) return
    loadingKernel.value = false
  })
}

async function refreshAll(): Promise<void> {
  await Promise.all([loadService(true), loadKernel(true)])
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

// 更新只装这一页看到的那个最新构建：确认框里写的版本就是要装的版本，期间上游又有新构建时服务端会拒绝。
// An update installs only the newest build this page showed, so the version in the
// confirmation is the one installed; the server refuses if upstream moved on meanwhile.
async function updateKernel(): Promise<void> {
  const latest = kernel.value?.latest
  if (!latest || kernelAction.value) return
  const verb = installed.value ? '更新' : '安装'
  if (!await confirm.ask({
    title: `${verb}内核到 ${formatKixdnsVersion(latest)}`,
    body: `先下载并校验这个构建。${switchConfirmBody(service.value)}`,
    confirmLabel: `${verb}内核`,
  })) return
  kernelAction.value = 'update'
  kernelUpdateStartedAt.value = Date.now()
  try {
    kernel.value = await apiRequest<KixdnsKernel>('/api/v1/kixdns/kernel/update', {
      method: 'POST',
      ...jsonBody({ source_id: latest.source_id }),
    })
    await Promise.all([loadService(true), refreshUpdates()])
    toast.success(switchedMessage(service.value, `内核已${verb}`))
  } catch (error) {
    toast.error(errorMessage(error))
    await loadKernel(true)
  } finally {
    kernelAction.value = null
    kernelUpdateStartedAt.value = null
  }
}

async function rollbackKernel(): Promise<void> {
  const previous = kernel.value?.previous
  if (!previous || kernelAction.value) return
  if (!await confirm.ask({
    title: `回退到 ${formatKixdnsVersion(previous)}`,
    body: switchConfirmBody(service.value),
    confirmLabel: '回退内核',
  })) return
  kernelAction.value = 'rollback'
  try {
    kernel.value = await apiRequest<KixdnsKernel>('/api/v1/kixdns/kernel/rollback', { method: 'POST' })
    await Promise.all([loadService(true), refreshUpdates()])
    toast.success(switchedMessage(service.value, '已回退到上一个内核'))
  } catch (error) {
    toast.error(errorMessage(error))
    await loadKernel(true)
  } finally {
    kernelAction.value = null
  }
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
    <StatusBanner v-if="loadError" :message="loadError" :stale="Boolean(service || kernel)" :busy="loadingService || loadingKernel" @retry="refreshAll" />
    <!-- 按「要不要现在动手」排：服务状态就在页头的事实行里，在不在跑、要不要动它一眼可知；
         有更新时更新紧随其后，不需要动手的安装信息和凭据降到下面。整页没有黑按钮：
         这一页是看状态、偶尔操作，列表里每行的操作一律用次要按钮。
         Ordered by whether you need to act now: the service state lives in the
         header's facts row, so whether it runs and whether to touch it is read at
         a glance; updates follow, and what needs no action sits lower. There is no
         black button on this page: it is read and occasionally acted on, and every
         row action is a secondary button. -->
    <UiPageHeader class="service-line system-heading" title="系统" stack>
      <template #meta>
        <!-- 事实行：服务（状态点说在不在跑，停了才多写一个词）、PID、面板版本、装着的内核
             The facts row: the service (the dot says whether it runs; a word is added only when stopped), PID, panel version, the installed kernel -->
        <div v-if="service || kernel || panelVersion" class="ui-facts system-facts">
          <div v-if="service">
            <span class="ui-lbl">服务</span>
            <b :title="running ? '正在运行' : '已停止'"><span class="ui-dot" :class="{ 'ui-dot--off': !running }" aria-hidden="true"></span>{{ service.unit }}<small v-if="!running">已停止</small><small v-if="unusualServiceState" class="ui-mono">{{ unusualServiceState }}</small></b>
          </div>
          <div v-if="service?.main_pid"><span class="ui-lbl">PID</span><b>{{ service.main_pid }}</b></div>
          <div v-if="panelVersion"><span class="ui-lbl">面板版本</span><b>{{ panelVersion }}</b></div>
          <div v-if="kernel"><span class="ui-lbl">内核</span><b>{{ installed ? formatKixdnsVersion(activeVersion) : '尚未安装' }}</b></div>
        </div>
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

    <!-- 卡片都是概览那套：小标签一行，右端一个标签或按钮；内容是细线隔开的行 / Every card follows the overview: a small label line with a tag or button at its end; rows between hairlines -->
    <section class="ui-card system-card update-panel" aria-labelledby="system-updates-label">
      <div class="system-card__head">
        <h2 id="system-updates-label" class="ui-card__label">可用更新</h2>
        <button class="ui-btn ui-btn--secondary ui-btn--icon ui-btn--compact" type="button" title="检查更新" aria-label="检查更新" :disabled="checkingUpdates" @click="refreshUpdatesWithQuota"><RefreshCw :size="14" :class="{ spin: checkingUpdates }" /></button>
      </div>
      <div v-if="checkingUpdates && !updateStatus" class="system-skeleton-rows" role="status" aria-label="正在检查更新"><i v-for="n in 2" :key="n" class="sk"></i></div>
      <div v-else-if="updateStatus" class="system-tasks" :class="{ 'is-refreshing': checkingUpdates }">
        <UiTask class="update-row" :state="kernelTaskState" title="KixDNS 内核" :started-at="kernelUpdateStartedAt" indeterminate>
          <template #icon><Cpu :size="16" /></template>
          <template v-if="kixdnsNotice?.available" #title><span class="ui-tag ui-tag--strong">{{ kixdnsNotice.security_update ? '安全更新' : '有新版本' }}</span></template>
          <template #meta>
            <span class="update-row__from-to">
              <template v-if="kernelAction === 'update'">正在下载、校验并切换内核</template>
              <span v-else-if="!kixdnsNotice" class="system-stale">检查失败：{{ updateStatus.kixdns_error ?? '原因未知' }}</span>
              <!-- 只在新旧版本之间断行，「→」「·」跟着后一段走：不会挂在行尾 / Lines break only between the two versions, and 「→」/「·」 travel with what follows, so neither is left at a line end -->
              <template v-else-if="kixdnsNotice.available && kixdnsNotice.security_update"><span class="ui-num">{{ formatKixdnsVersion(activeVersion) }}</span> <span class="update-row__keep">依赖安全升级<template v-if="kixdnsNotice.dependency_revision"> · <span class="ui-num">r{{ kixdnsNotice.dependency_revision }}</span></template></span></template>
              <template v-else-if="kixdnsNotice.available"><span class="ui-num">{{ formatKixdnsVersion(activeVersion) }}</span> <span class="update-row__keep">→ <span class="ui-num">{{ latestKixdnsVersion() }}</span></span></template>
              <template v-else-if="kixdnsNotice.current_commit"><span class="update-row__keep">已是最新 · <span class="ui-num">{{ formatKixdnsVersion(activeVersion) }}</span></span></template>
              <template v-else>尚未安装</template>
            </span>
            <span v-if="kixdnsNotice">构建于 {{ buildTime(kixdnsNotice.created_at) }}</span>
          </template>
          <template v-if="kixdnsNotice || !installed" #actions>
            <a v-if="kixdnsNotice" class="ui-link" :href="kixdnsNotice.build_url" target="_blank" rel="noopener noreferrer">构建详情<ExternalLink :size="12" /></a>
            <button v-if="kixdnsNotice?.available || !installed" class="ui-btn ui-btn--secondary ui-btn--sm ui-btn--inline" type="button" :disabled="!kernel?.latest || kernelAction !== null" @click="updateKernel">{{ kernelAction === 'update' ? '更新中' : (installed ? '更新' : '安装') }}</button>
          </template>
        </UiTask>

        <UiTask class="update-row" :state="panelTaskState" title="KixDNS Panel" :started-at="panelUpdateStartedAt" :progress="panelUpdateProgress">
          <template #icon><PanelsTopLeft :size="16" /></template>
          <template v-if="panelNotice?.available" #title><span class="ui-tag ui-tag--strong">有新版本</span></template>
          <template #meta>
            <span class="update-row__from-to">
              <template v-if="panelUpdateRunning">{{ panelUpdateLabel() }}</template>
              <span v-else-if="!panelNotice" class="system-stale">检查失败：{{ updateStatus.panel_error ?? '原因未知' }}</span>
              <template v-else-if="panelNotice.available"><span class="ui-num">{{ panelNotice.current_release ?? `v${panelNotice.current_version}` }}</span> <span class="update-row__keep">→ <span class="ui-num">v{{ panelNotice.latest_version }}</span></span></template>
              <template v-else>{{ panelUpdateLabel() }}</template>
            </span>
            <span v-if="panelNotice?.published_at">发布于 {{ buildTime(panelNotice.published_at) }}</span>
            <span v-if="panelNotice && !panelNotice.release_url">首个正式 Release 发布后显示</span>
            <p v-if="panelUpdateFailure" class="ui-task__error update-row__failure" role="alert">
              <span>{{ panelUpdateFailure }}</span>
              <button class="ui-btn ui-btn--secondary ui-btn--sm" type="button" @click="dismissPanelUpdateFailure">知道了</button>
            </p>
          </template>
          <template v-if="panelNotice?.release_url" #actions>
            <a class="ui-link" :href="panelNotice.release_url" target="_blank" rel="noopener noreferrer">发布说明<ExternalLink :size="12" /></a>
            <button v-if="panelNotice.available" class="ui-btn ui-btn--secondary ui-btn--sm ui-btn--inline" type="button" :disabled="startingPanelUpdate || panelUpdateRunning" @click="startPanelUpdate">{{ panelUpdateRunning ? '更新中' : '在线更新' }}</button>
          </template>
        </UiTask>
      </div>
      <div v-else class="system-check-failed">
        <span>{{ updateError ? `检查失败：${updateError}` : '更新状态暂不可用' }}</span>
        <button class="ui-btn ui-btn--secondary" type="button" :disabled="checkingUpdates" @click="refreshUpdatesWithQuota">重新检查</button>
      </div>
      <p v-if="updateError && updateStatus" class="system-card__row system-stale">最近一次检查失败，当前显示上次结果：{{ updateError }}</p>
    </section>

    <!-- 不需要现在动手的两块：当前装的是什么，和查更新用的凭据。两张卡一样高，底下那行都贴着卡片底边。
         The two blocks that need no action now: what is installed, and the credential used to check. The pair shares one height, with each bottom row on the card's lower edge. -->
    <div class="system-pair">
      <!-- 「装的是哪个版本」是这张卡唯一常看的事，做主角；补丁集和控制协议是这个版本的附注；
           三个哈希只在排查时看，收成细线下面的一行。原来七行一样轻重，读起来像一张表。
           Which version is installed is the one thing read here, so it leads; the
           patchset and control protocol qualify it; the three hashes matter only
           when troubleshooting and share one row under a hairline. Seven rows of
           equal weight used to read as a table. -->
      <section class="ui-card system-card runtime-panel" aria-labelledby="system-install-label">
        <div class="system-card__head">
          <h2 id="system-install-label" class="ui-card__label">当前安装</h2>
          <span v-if="kernel" class="ui-tag" :class="installed ? 'ui-tag--ok' : 'ui-tag--warn'">{{ installed ? '已安装' : '尚未安装' }}</span>
        </div>
        <div class="system-card__main">
          <div v-if="loadingKernel && !kernel" class="sk system-skeleton-panel" role="status" aria-label="读取安装状态"></div>
          <template v-else-if="kernel">
            <p class="install-version">{{ installed ? formatKixdnsVersion(activeVersion) : '尚未安装' }}</p>
            <p v-if="installed" class="ui-dots install-meta">
              <span>增强版运行时</span>
              <span>补丁集 <span class="ui-num">{{ activeVersion?.patchset ? `p${activeVersion.patchset}${activeVersion.dependency_revision ? `-r${activeVersion.dependency_revision}` : ''}` : '未记录' }}</span></span>
              <span>控制协议 <span class="ui-num">{{ activeVersion?.control_protocol ? `v${activeVersion.control_protocol}` : '未记录' }}</span></span>
              <!-- 链接本身是 inline-flex，套一层再让 ui-dots 画点 / The link is inline-flex, so it is wrapped before ui-dots draws the dot -->
              <span v-if="activeVersion?.source_url"><a class="ui-link" :href="activeVersion.source_url" target="_blank" rel="noopener noreferrer">上游详情<ExternalLink :size="12" /></a></span>
            </p>
            <p v-else class="install-meta">在上方「可用更新」里安装最新构建</p>
            <dl class="ui-strip install-hashes">
              <div><dt>上游提交</dt><dd class="ui-mono">{{ activeVersion?.upstream_commit ? shortHash(activeVersion.upstream_commit, 12) : '未记录' }}</dd></div>
              <div><dt>增强构建</dt><dd class="ui-mono">{{ shortHash(activeVersion?.commit, 12) }}</dd></div>
              <div><dt>二进制摘要</dt><dd class="ui-mono">{{ shortHash(activeVersion?.binary_sha256, 14) }}</dd></div>
            </dl>
          </template>
        </div>
        <!-- 本机只留当前和上一个内核：回退只有一步，就放在当前安装的底行。
             Only the current and the previous kernel stay on this host, so a rollback is
             one step and sits on the installed card's bottom row. -->
        <div v-if="installed" class="system-card__row install-previous">
          <template v-if="kernel?.previous">
            <span>上一个版本 <span class="ui-num">{{ formatKixdnsVersion(kernel.previous) }}</span></span>
            <button class="ui-btn ui-btn--secondary ui-btn--sm ui-btn--inline" type="button" :disabled="kernelAction !== null" @click="rollbackKernel"><RotateCw v-if="kernelAction === 'rollback'" :size="14" class="spin" />{{ kernelAction === 'rollback' ? '回退中' : '回退' }}</button>
          </template>
          <!-- 没有上一个版本时这一行照样在：卡片底部不留空，两张卡的底行对齐 / Without a previous build the row stays, so the card's bottom is never blank and the pair's bottom rows line up -->
          <span v-else class="install-previous__none">没有可回退的版本，更新一次后会留下上一个</span>
        </div>
      </section>

      <section class="ui-card system-card credential-panel" aria-labelledby="system-credential-label">
        <div class="system-card__head">
          <h2 id="system-credential-label" class="ui-card__label">GitHub 凭据</h2>
          <span class="ui-tag" :class="{ 'ui-tag--ok': githubTokenStatus?.configured }">{{ githubTokenStatus?.configured ? '已配置' : '匿名' }}</span>
        </div>
        <div class="system-card__main">
          <div class="credential-form">
            <!-- 占位符按 375 下量出来的可用宽度写：「github_pat_… 或 ghp_…」放不下，给一个写得下的例子就够了。
                 The placeholder fits the width measured at 375; one example that fits is enough. -->
            <label class="ui-input credential-input">
              <KeyRound :size="16" aria-hidden="true" />
              <input v-model="githubToken" :type="githubTokenVisible ? 'text' : 'password'" :placeholder="githubTokenStatus?.configured ? '输入新 Token' : 'github_pat_…'" autocomplete="new-password" maxlength="256" aria-label="GitHub Token" :disabled="githubTokenBusy" @keyup.enter="saveGithubToken">
              <button class="credential-eye" type="button" :title="githubTokenVisible ? '隐藏 Token' : '显示 Token'" :aria-label="githubTokenVisible ? '隐藏 Token' : '显示 Token'" @click="githubTokenVisible = !githubTokenVisible"><EyeOff v-if="githubTokenVisible" :size="15" /><Eye v-else :size="15" /></button>
            </label>
            <button class="ui-btn ui-btn--secondary" type="button" :disabled="!githubToken || githubTokenBusy" @click="saveGithubToken">{{ githubTokenBusy ? '处理中' : (githubTokenStatus?.configured ? '替换' : '保存') }}</button>
            <button class="ui-btn ui-btn--danger ui-btn--icon" type="button" title="删除 Token" aria-label="删除 Token" :disabled="!githubTokenStatus?.configured || githubTokenBusy" @click="deleteGithubToken"><Trash2 :size="16" /></button>
          </div>
          <!-- 先说它只用在哪、不去哪；没配置时再说清为什么要填：GitHub 对匿名请求每小时只给 60 次，带 Token 是 5000 次。
               First where it is used and where it never goes; without a token, also why one helps: GitHub allows 60 anonymous requests an hour, 5,000 with a token. -->
          <p class="credential-hint"><span>只用于版本检查和内核下载，不会发送到 nightly.link。</span><template v-if="!githubTokenStatus?.configured"><span>匿名访问 GitHub 每小时只有 60 次请求，检查版本和下载内核容易被限速。</span><span>填一个 Token 后是每小时 <span class="nowrap">5,000 次</span>。</span></template></p>
        </div>
        <div class="system-card__row credential-quota">
          <span v-if="githubRate" class="ui-dots"><span>API 配额 <span class="ui-num">{{ githubQuota }}</span></span><span>重置于 {{ githubRateReset() }}</span></span>
          <span v-else>面板还没向 GitHub 请求过，配额未知</span>
          <span v-if="githubTokenError" class="system-error">{{ githubTokenError }}</span>
        </div>
      </section>
    </div>

  </div>
</template>

<style>
/* 系统页只引用 tokens.css 的变量；零件来自 components.css，这里只管页头的事实行和三张卡片的结构。
   旧的 .system-* / .install-* / .credential-* 规则还在 styles.css 里，落地时清理；这里覆盖到的以这里为准。
   Tokens only; the parts come from components.css and this lays out the header's facts row and the three cards.
   The old .system-* / .install-* / .credential-* rules still sit in styles.css and are cleaned up at landing; what is
   overridden here wins. */
/* 和概览同一个节奏：块与块隔 24，页头下面不再另加 / The overview's rhythm: blocks 24 apart, nothing extra under the header */
.system-page { display: grid; gap: var(--s-5); align-content: start; }
.system-page > .ui-ph { margin-bottom: 0; }
/* 事实行：标签在上、值在下；状态点和它的值之间 4，和概览一样 / The facts row: label over value; 4 between the dot and its value, as on the overview */
.system-facts { flex: 1 1 100%; margin-top: var(--s-1); }
.system-facts b > .ui-dot { margin-right: calc(var(--s-1) - var(--s-2)); }
/* 「已停止」整词换到下一行，不拆成一个字一行（手机上一格只有半行宽） / 已停止 moves to the next line as a whole word, never one character per line (a phone cell is half a line wide) */
.system-facts b { flex-wrap: wrap; }
.system-facts b > small { color: var(--l-ink-3); font-weight: var(--w-normal); white-space: nowrap; }

/* 卡片：上 16、左右下 24；第一行是小标签，右端的标签或按钮用负外边距收进标签的行高，不把头部撑高
   Cards: 16 above, 24 at the sides and below; the first line is the small label, and the tag or button at its end tucks into
   the label's line height with a negative margin instead of raising the head */
.system-card { padding: var(--s-4) var(--s-5) var(--s-5); }
/* 组件库让卡片里的 div 都伸展；这里只有正文那一块伸展，头和底行保持自己的高度 / The kit lets every div in a card grow; here only the main block grows, and the head and bottom row keep their own height */
.system-card > div, .system-card > p, .system-card > dl { flex: 0 0 auto; }
.system-card > .system-card__main { flex: 1 1 auto; }
.system-card__head { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); }
.system-card__head > .ui-btn--compact { margin-block: calc((var(--t-1) * var(--lh-base) - var(--h-sm)) / 2); }
.system-card__head > .ui-tag { margin-block: calc((var(--t-1) * var(--lh-base) - var(--h-tag)) / 2); }
.system-card__main { flex: 1 1 auto; }
/* 底行：细线上面 16、下面 12，贴着卡片底边；两张并排的卡一样高，底行就在同一条线上
   The bottom row: 16 above its hairline, 12 below, on the card's lower edge; the paired cards share a height, so the rows align */
.system-card__row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s-2) var(--s-4); margin: var(--s-4) 0 0; padding-top: var(--s-3); border-top: 1px solid var(--l-hair); color: var(--l-ink-3); font-size: var(--t-2); }
.system-card__row > .ui-dots { min-width: 0; }

/* 更新行：第一行贴着标签下面 12，最后一行不画线、不留底 / Update rows: the first sits 12 under the label, the last draws no line and keeps no bottom */
.system-tasks { margin-top: var(--s-2); }
.system-tasks > .ui-task:first-child { padding-top: var(--s-1); }
.system-tasks > .ui-task:last-child { padding-bottom: 0; border-bottom: 0; }
.system-page .system-skeleton-rows { margin-top: var(--s-3); padding-bottom: 0; }
.system-page .system-check-failed { margin-top: var(--s-3); padding-bottom: 0; }

/* 当前安装：大数字 32 · 700 是这张卡的主角，附注一行，哈希在细线下面 / The installed build: the 32 · 700 figure leads the card, one line of notes, the hashes under a hairline */
.system-page .install-version { margin: var(--s-2) 0 0; font-family: var(--f-display); font-size: var(--t-6); font-weight: var(--w-heavy); font-variant-numeric: tabular-nums; letter-spacing: -.02em; line-height: var(--lh-tight); overflow-wrap: anywhere; }
.system-page .install-meta { margin-top: var(--s-2); color: var(--l-ink-2); font-size: var(--t-2); }
.system-page .install-hashes { margin-top: var(--s-4); padding-top: var(--s-3); border-top: 1px solid var(--l-hair); }
.system-page .system-skeleton-panel { margin-top: var(--s-2); }

/* GitHub 凭据：表单在标签下面 12，说明在表单下面 12 / The credential: the form 12 under the label, the note 12 under the form */
.system-page .credential-form { margin-top: var(--s-3); }
.system-page .credential-hint { margin: var(--s-3) 0 0; max-width: none; }

@media (max-width: 640px) {
  .system-page { gap: var(--s-4); }
  .system-facts { gap: var(--s-3) var(--s-5); }
  .system-facts > div { flex: 0 0 calc(50% - var(--s-5) / 2); }
  .system-card { padding: var(--s-3) var(--s-4) var(--s-4); }
}
/* 没有可回退版本时底行的一句说明 / The bottom row's note when there is nothing to roll back to */
.install-previous__none { color: var(--l-ink-3); font-size: var(--t-2); }
</style>
