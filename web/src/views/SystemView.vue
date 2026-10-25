<script setup lang="ts">
import {
  CircleX,
  Clock,
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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { apiRequest, jsonBody } from '../api/client'
import type {
  ConfigDocument,
  GithubTokenStatus,
  KixdnsKernel,
  PanelUpdateStartResponse,
  PanelUpdateStatus,
  ServiceAction,
  ServiceStatus,
} from '../api/types'
import StatusBanner from '../components/StatusBanner.vue'
import UiPageHeader from '../components/ui/UiPageHeader.vue'
import UiDotText from '../components/ui/UiDotText.vue'
import UiTask, { type UiTaskState } from '../components/ui/UiTask.vue'
import { useConfirm } from '../composables/useConfirm'
import { useConnection } from '../composables/useConnection'
import { backUnconfirmed, downShownHere, nameWith, noteRead, readBeforeTelling, restartingKixdns, startingKixdns, useServiceRestart, useServiceStart, versionName } from '../composables/useServiceStart'
import { useToast } from '../composables/useToast'
import { useUpdateStatus } from '../composables/useUpdateStatus'
import { errorMessage, formatDate, formatKixdnsVersion, shortHash } from '../utils'
import { switchConfirmBody, switchedMessage } from '../version-switch'
import { settingNames } from '../config-editor/schema'
import { serviceLabel as labelOfService, serviceTone as toneOfService } from '../service-state'

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
// 检查失败是因为 GitHub 限了匿名访问或 Token 失效时，原因旁边给一个直接去填 Token 的按钮
// When a check failed because GitHub limited anonymous access or the token went bad, the reason carries a button straight to the token field
const tokenInput = ref<HTMLInputElement | null>(null)
const needsToken = (error: string | null | undefined) => Boolean(error && /GitHub Token|GitHub 匿名/.test(error))
function focusToken(): void {
  tokenInput.value?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  tokenInput.value?.focus({ preventScroll: true })
}
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

// 服务端看出它起不来时不算在运行（systemd 重试的那一下服务是 active） / Not running when the server sees it not coming up (during
// a systemd retry the service reads active)
const running = computed(() => service.value?.active_state === 'active' && !service.value.did_not_come_up)
// 和概览同一套说法：systemd 正在重试是「正在启动」，不是「已停止」 / The overview's words: a service systemd is retrying is
// 正在启动, not 已停止
const serviceTone = computed(() => toneOfService(service.value))
// 等 KixDNS 从重启回来（这一页或配置页发起的）：和配置页页头一样转圈、写「正在重启」，PID 先不写
// Waiting for KixDNS to come back from a restart (sent from this page or the config page): a spinner and 正在重启 as in the
// config page's header, with no PID yet
// 这一页按的「启动」等它回来时也一样转圈、写「正在启动」，不写还停着 / While a 启动 pressed here waits for it, likewise a spinner
// and 正在启动 rather than still stopped
const waitingBack = computed(() => restartingKixdns.value || startingKixdns.value)
const serviceWords = computed(() => (restartingKixdns.value ? '正在重启' : startingKixdns.value ? '正在启动' : labelOfService(service.value)))
// systemd 正在启动它（包括起不来、隔几秒重试）：给「重启」「停止」（停止能打断重试），不给「启动」
// systemd is starting it (including retries every few seconds when it does not come up): 重启 and 停止 (stopping ends the
// retries), not 启动
const startable = computed(() => !running.value && !['active', 'activating', 'reloading'].includes(service.value?.active_state ?? ''))
// 起不来时和概览、诊断页一样在页头下面放一条提示：可能的原因和出路（能退回去配置页，不能就看日志）
// Not coming up, a notice under the header as on the overview and diagnostics: the likely cause and the way out (the config
// page when settings can go back, the logs otherwise)
const downFix = ref<{ rollback: boolean; writable: number | null }>({ rollback: false, writable: null })
// 连不上面板时，上次读到的服务状态不能当真：点变灰，写「状态未知」，连上后恢复（同概览）
// While the panel is unreachable the last service state read cannot be trusted: the dot turns grey and reads 状态未知, restored on reconnect (as on the overview)
const { down: panelDown } = useConnection()
// 接在汉字后面：日期版本、Release 标签这类字母数字开头的名字前空一格（「到 2026.10.13」），「构建 #N」紧接（「到构建 #N」），和服务端同一个规则
// After Chinese text: a name starting with a Latin letter or digit takes a space (到 2026.10.13), 构建 #N follows directly (到构建 #N), the server's rule
const afterCjk = (name: string) => (/^[A-Za-z0-9]/.test(name) ? ` ${name}` : name)
const waitingForPanel = computed(() => panelDown.value && !service.value && !kernel.value)
// 「正在运行 · active/running」「已停止 · inactive/dead」是同一件事说两遍；只有启动中、
// 自动重启这类不寻常的状态，systemd 的原始写法才多带了信息。
// "正在运行 · active/running" and "已停止 · inactive/dead" say one thing twice; only
// unusual states such as activating or auto-restart carry information in systemd's own words.
// 服务端看出它起不来时不写 systemd 的原话：重试那一下它是 active/running，跟着闪只会添乱 / Not systemd's own words when the server
// sees it not coming up: during a retry it reads active/running, and flickering along only confuses
const unusualServiceState = computed(() => {
  if (service.value?.did_not_come_up) return ''
  const state = service.value ? `${service.value.active_state}/${service.value.sub_state}` : ''
  return state && !['active/running', 'inactive/dead'].includes(state) ? state : ''
})
const installed = computed(() => kernel.value?.binary_present === true)
const activeVersion = computed(() => kernel.value?.active ?? null)
// 内核信息还在读：现在的构建先用灰块占着，不写「未记录」（那不是真的） / The kernel is still being read: the current build is held by a grey slab instead of 「未记录」 (which would be false)
const kernelPending = computed(() => !kernel.value && loadingKernel.value)
// 大字只写编号，「构建」「构建产物」作小标签放在上面；日期版本和 Release 写「版本」和版本号本身 / The big figure is the number alone, with 构建 or 构建产物 as a small label above; a date version or a Release shows 版本 and the version itself
const versionLead = computed(() => {
  const text = formatKixdnsVersion(activeVersion.value)
  const match = /^(构建产物|构建) (#\d+)$/.exec(text)
  const source = activeVersion.value?.source
  return match ? { label: match[1]!, value: match[2]! } : { label: source === 'fork' || source === 'release' ? '版本' : '', value: text }
})
// 手机上页头只有一行字、没有「内核」这个标签：日期版本单写一串数字读不出是什么，前面带上「内核」；「构建 #N」自己说得清
// On phones the header is one line with no 内核 label: a bare date version does not say what it is, so 内核 goes before it; 构建 #N says so itself
const kernelPhoneLabel = computed(() => {
  if (!installed.value) return '内核还没安装'
  const name = formatKixdnsVersion(activeVersion.value)
  return /^[A-Za-z0-9]/.test(name) ? `内核\u00a0${name}` : name.replace(' ', '\u00a0')
})
const loadError = computed(() => [serviceError.value, kernelError.value].filter(Boolean).join('；'))

function buildTime(value: string | null): string {
  if (!value) return '时间未记录'
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
  return kixdnsNotice.value?.release_tag ?? '未检查'
}

const kernelTaskState = computed<UiTaskState>(() => (kernelAction.value === 'update' ? 'run' : 'idle'))

function panelUpdateLabel(): string {
  if (panelUpdate.value?.state === 'checking' || panelUpdate.value?.state === 'downloading') {
    return panelUpdate.value.message || '面板正在在线更新'
  }
  const notice = panelNotice.value
  if (!notice?.latest_version) return '正式版还没发布'
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
      body: '之后检查更新不带 Token，GitHub 每小时只让查 60 次。需要时再填一个就行。',
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
    toast.error('没能确认在线更新的结果。查看原因：journalctl -u kixdns-panel-update.service -n 50 --no-pager')
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
    body: '更新时面板会重启，期间页面会提示连不上，重启完自动恢复。KixDNS 不受影响，配置不变。',
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
    const next = await apiRequest<ServiceStatus>('/api/v1/service')
    // 起不来时服务状态带着出路：可以退回的设置、可以写进配置文件的待应用版本，提示条照它指去配置页或日志
    // Not coming up, the service state carries the way out: settings that can go back or a pending version that can be written
    // into the file, and the notice points to the config page or the logs by it
    downFix.value = { rollback: Boolean(next.restart_rollback), writable: next.pending_writable ?? null }
    service.value = next
    serviceError.value = ''
    // 服务在跑只能大致说明它活着：重启途中新进程还在加载时也是在跑，那时由等重启的那一边认 / A running service only roughly
    // says it is alive: during a restart the loading process runs too, and then the side waiting on the restart decides
    // systemd 放弃了（failed）也不会再起来，和停着一样算 / systemd giving up (failed) will not come back either, so it counts as
    // stopped
    if (!waitingBack.value) noteRead(next.active_state === 'active' && !next.did_not_come_up, ['inactive', 'failed'].includes(next.active_state))
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
  // 重启以后面板只接着应用还在等的版本；应用失败过的不会再试（旧配置已经放回去了），那时说清楚，指到配置页的「重试应用」（读不到配置就不提）
  // After a restart the panel applies only a version still waiting; one that failed is not retried (the old file was put back), so say that and point to 重试应用 on the config page (left out if the config cannot be read)
  // 改过、要重启才生效的设置也说出来，和配置页的重启同一句；KixDNS 还在时服务端重启前先应用待应用的版本，连不上时回来再应用
  // The settings waiting for a restart are named too, in the config page's words; with KixDNS still there the server applies the
  // pending version before the restart, and when it is unreachable the version is applied once it is back
  // 起不来时服务本来就断着：不说「短暂中断」，重启是再试一次，停止是让 systemd 别再重试；能退回改过的设置时指到配置页；
  // 待应用的版本 KixDNS 起来就应用，不能退回、又还没写进配置文件的，再说一句可以到配置页写进去
  // Not coming up, the service is down already: no 「短暂中断」; a restart tries once more and a stop has systemd stop retrying;
  // with changed settings that can go back it points to the config page; a pending version applies once KixDNS is up, and
  // without a rollback, when it is not in the file yet, a clause says it can be written there on the config page
  const down = serviceTone.value === 'err'
  const config = action === 'restart' ? await apiRequest<ConfigDocument>('/api/v1/config').catch(() => null) : null
  const pending = config?.pending
  const pendingId = pending?.version_id
  const rollback = config?.runtime.restart_rollback
  const restartNames = config?.runtime.restart_pending?.length ? `重启后生效的设置：${settingNames(config.runtime.restart_pending, { all: true })}。` : ''
  // 退回写下的版本不报编号 / A version a rollback wrote goes without its number
  const origin = pending?.from_rollback
  const waitingName = pendingId ? (origin ? versionName(pendingId, origin) : `待应用的版本\u00a0#${pendingId}`) : ''
  const failedNote = pendingId && pending?.error ? `${nameWith(versionName(pendingId, origin, true), '没有生效')}，重启后仍用之前那份配置${down ? '' : '；要再试，到配置页点\u2060「重试应用」'}。` : ''
  const waitingNote = !pendingId || pending?.error ? ''
    : down ? (config?.runtime.pending_writable ? `起来以后就用上${waitingName}；还是不行的话，可以到配置页把它写进配置文件。` : rollback ? `起来以后就用上${waitingName}。` : '')
    : config?.runtime.active_sha256 ? `重启前先应用${waitingName}。` : `重启后应用${waitingName}。`
  const restartBody = down
    ? `KixDNS\u00a0现在起不来，重启会再试一次。${rollback ? `可能是改过的设置导致的，可以到配置页退回：${settingNames(Object.keys(rollback))}。` : ''}${waitingNote}${failedNote}`
    : `服务会短暂中断，缓存会清空。${waitingNote}${restartNames}${failedNote}`
  if ((action === 'stop' || action === 'restart') && !await confirm.ask({
    title: `${names[action]} KixDNS 服务`,
    body: action === 'stop'
      ? (down ? '停止后 systemd 不再重试启动 KixDNS。配置不变。' : '停止期间，用 KixDNS 解析的设备都查不到域名，直到重新启动。配置不变，缓存会清空。')
      : restartBody,
    confirmLabel: `${names[action]}服务`,
    destructive: action === 'stop',
  })) return
  serviceAction.value = action
  try {
    // 启动、重启和别处同一个做法：等 KixDNS 回来再说结果，起不来的不说成已经启动；重启期间配置页也知道在重启
    // A start or restart works as everywhere else: the outcome is told once KixDNS is back, so one that never comes up is not called
    // started, and while it restarts the config page knows
    // 等完先读服务状态再说结果（见下面登记的重读）：起不来时这一页的提示条先说，不另弹提示 / The service state is read after the
    // wait, before the outcome is said (the read registered below): not coming up, this page's notice says it first with no toast
    if (action === 'restart') await restart()
    else if (action === 'start') await start()
    else {
      service.value = await apiRequest<ServiceStatus>('/api/v1/service/stop', { method: 'POST' })
      toast.success('KixDNS 服务已停止')
    }
    serviceError.value = ''
    await loadService(true)
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    serviceAction.value = null
  }
}
const { restart } = useServiceRestart()
const { start } = useServiceStart()

// 更新只装这一页看到的那个最新版本：确认框里写的版本就是要装的版本，期间又发布了新版本时服务端会拒绝。
// An update installs only the newest version this page showed, so the version in the
// confirmation is the one installed; the server refuses if a newer one was released meanwhile.
async function updateKernel(): Promise<void> {
  const latest = kernel.value?.latest
  if (!latest || kernelAction.value) return
  const verb = installed.value ? '更新' : '安装'
  if (!await confirm.ask({
    title: `${verb}内核到${afterCjk(formatKixdnsVersion(latest))}`,
    body: `先下载并校验这个版本。${switchConfirmBody(service.value)}`,
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
    title: `回退到${afterCjk(formatKixdnsVersion(previous))}`,
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

function loadPage(): void {
  void Promise.all([refreshAll(), refreshUpdates()]).then(() => loadGithubTokenStatus())
  void loadPanelUpdateStatus()
}
onMounted(loadPage)
// 连上面板后整页重读一次，不用人去点重试 / Once the panel answers again the whole page re-reads, with nobody pressing 重试
watch(panelDown, (now, before) => { if (before && !now) loadPage() })

const downNotice = computed(() => (service.value && serviceTone.value === 'err' && !panelDown.value && !waitingBack.value ? downFix.value : null))
// 提示条在说起不来：别处带来的「启动失败」提示收起，这一页等出来的也不另弹
// The notice says it does not come up: a 启动失败 toast brought from elsewhere is dismissed, and one this page waited out is not
// raised
watch(() => downNotice.value !== null, (shown) => { downShownHere.value = shown }, { immediate: true, flush: 'sync' })
// 起不来、或者刚连上还没连着两次读到时每 5 秒看一次服务：systemd 哪次重试起来了提示条跟着收，起不来的循环里碰上一次短暂应答也
// 不就此停下 / While it does not come up, or is reachable but not yet seen twice in a row, the service is looked at every 5
// seconds: the notice goes once a systemd retry comes up, and one brief answer inside a loop that never comes up does not stop it
let downTimer: ReturnType<typeof setInterval> | undefined
watch(() => downNotice.value !== null || backUnconfirmed.value, (watching) => {
  clearInterval(downTimer)
  downTimer = watching ? setInterval(() => { void loadService(true) }, 5000) : undefined
}, { immediate: true })
// 别的页面发起的启动、重启、退回结束时，这一页也先重读再说结果 / When a start, restart or rollback sent from another page ends,
// this page also reads again before the outcome is said
// 不搭还在路上的那次读：它可能是在服务端看出起不来之前发的 / Not riding on a read still out: it may have been sent before the
// server saw it not coming up
const stopReading = readBeforeTelling(async () => { await pendingService?.catch(() => undefined); await loadService(true) })

onBeforeUnmount(() => {
  if (panelUpdateTimer) clearTimeout(panelUpdateTimer)
  clearInterval(downTimer)
  stopReading()
  downShownHere.value = false
})
</script>

<template>
  <div class="page system-page">
    <!-- 连不上面板时顶上的横幅已经说了为什么、也有重试：这一页不再复述，什么都没读到时只写一句连上后会自己打开 / With the panel unreachable the banner says why and offers the retry: this page does not repeat it, and with nothing read it only says it opens by itself once connected -->
    <StatusBanner v-if="loadError && !panelDown" :message="loadError" :stale="Boolean(service || kernel)" :busy="loadingService || loadingKernel" @retry="refreshAll" />
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
            <b :title="panelDown ? '状态未知' : running && !waitingBack ? '正在运行' : serviceWords"><span v-if="waitingBack && !panelDown" class="ui-spin system-spin" aria-hidden="true"></span><span v-else class="ui-dot" :class="panelDown ? 'ui-dot--off' : serviceTone === 'ok' ? '' : `ui-dot--${serviceTone}`" aria-hidden="true"></span>{{ service.unit }}<small v-if="panelDown">状态未知</small><template v-else><small v-if="!running || waitingBack">{{ serviceWords }}</small><small v-if="unusualServiceState" class="ui-mono">{{ unusualServiceState }}</small></template></b>
          </div>
          <div v-if="service?.main_pid && !panelDown && !waitingBack" class="system-fact-pid"><span class="ui-lbl">PID</span><b>{{ service.main_pid }}</b></div>
          <div v-if="panelVersion"><span class="ui-lbl">面板版本</span><b>{{ panelVersion }}</b></div>
          <div v-if="kernel"><span class="ui-lbl">内核</span><b>{{ installed ? formatKixdnsVersion(activeVersion) : '还没安装' }}</b></div>
        </div>
        <span v-if="service || kernel || panelVersion" class="ui-ph__lead ui-ph__phone"><span v-if="service && waitingBack && !panelDown" class="ui-spin system-spin" aria-hidden="true"></span><span v-else-if="service" class="ui-dot" :class="panelDown ? 'ui-dot--off' : serviceTone === 'ok' ? '' : `ui-dot--${serviceTone}`" aria-hidden="true"></span><UiDotText :parts="[...(service ? [panelDown ? '状态未知' : serviceWords] : []), ...(panelVersion ? [`面板 ${panelVersion}`] : []), ...(kernel ? [kernelPhoneLabel] : [])]" /></span>
        <span v-else-if="loadingService" class="sk ui-ph__sk system-skeleton-meta" role="status" aria-label="读取服务状态"></span>
        <span v-else>服务状态暂不可用</span>
      </template>
      <!-- 服务状态读回来之前，手机上先留出按钮那一行（灰块），读到以后内容不往下跳 / Before the service status arrives, phones keep the button row's place (a grey slab), so the content does not jump when it lands -->
      <template v-if="service || loadingService" #actions>
        <template v-if="!service"><span class="sk system-actions-sk" aria-hidden="true"></span><span class="sk system-actions-sk" aria-hidden="true"></span></template>
        <button v-else-if="startable" class="ui-btn ui-btn--secondary" type="button" :disabled="!installed || serviceAction !== null || panelDown || waitingBack" @click="control('start')"><span v-if="serviceAction === 'start'" class="ui-spin" aria-hidden="true"></span><Play v-else :size="16" />启动</button>
        <template v-else>
          <button class="ui-btn ui-btn--secondary" type="button" :disabled="!installed || serviceAction !== null || panelDown || waitingBack" @click="control('restart')"><RotateCw :size="16" :class="{ spin: serviceAction === 'restart' }" />重启</button>
          <button class="ui-btn ui-btn--danger" type="button" :disabled="serviceAction !== null || panelDown || waitingBack" @click="control('stop')"><Square :size="16" />停止</button>
        </template>
      </template>
    </UiPageHeader>

    <!-- 什么都没读到就连不上了：标题下面一句，卡片先不画（缓存的更新卡读不到内核会写成「还没安装」，那是错的）
         Nothing read before the panel went away: one line under the title and no cards yet (the cached update card, without the kernel, would say 还没安装, which is wrong) -->
    <!-- 和诊断页同一条：说状态、可能的原因和出路 / The same notice as on diagnostics: the state, the likely cause and the way out -->
    <div v-if="downNotice" class="ui-notice ui-notice--err" role="status"><CircleX :size="16" aria-hidden="true" /><span>KixDNS 启动失败</span><small>{{ downNotice.rollback ? '可能是改过的设置让 KixDNS\u00a0起不来，可以退回。' : downNotice.writable ? `版本\u00a0#${downNotice.writable}\u00a0还没写进配置文件，可以到配置页写进去。` : '起不来的原因在运行日志里。' }}</small><RouterLink class="ui-btn ui-btn--secondary ui-btn--sm ui-notice__action" :to="downNotice.rollback || downNotice.writable ? '/config?section=settings' : '/logs?view=runtime'">{{ downNotice.rollback || downNotice.writable ? '去配置页' : '查看日志' }}</RouterLink></div>
    <p v-if="waitingForPanel" class="ui-notice ui-notice--off system-wait" role="status"><Clock :size="16" aria-hidden="true" /><span>连上面板后自动打开</span></p>
    <template v-else>
    <!-- 卡片都是概览那套：小标签一行，右端一个标签或按钮；内容是细线隔开的行 / Every card follows the overview: a small label line with a tag or button at its end; rows between hairlines -->
    <section class="ui-card system-card update-panel" aria-labelledby="system-updates-label">
      <div class="system-card__head">
        <h2 id="system-updates-label" class="ui-card__label">可用更新</h2>
        <button class="ui-btn ui-btn--secondary ui-btn--icon ui-btn--compact" type="button" title="检查更新" aria-label="检查更新" :disabled="checkingUpdates || panelDown" @click="refreshUpdatesWithQuota"><RefreshCw :size="14" :class="{ spin: checkingUpdates }" /></button>
      </div>
      <div v-if="checkingUpdates && !updateStatus" class="system-skeleton-rows" role="status" aria-label="正在检查更新"><i v-for="n in 2" :key="n" class="sk"></i></div>
      <div v-else-if="updateStatus" class="system-tasks" :class="{ 'is-refreshing': checkingUpdates }">
        <UiTask class="update-row" :state="kernelTaskState" title="KixDNS 内核" :started-at="kernelUpdateStartedAt" indeterminate>
          <template #icon><Cpu :size="16" /></template>
          <template v-if="kixdnsNotice?.available" #title><span class="ui-tag ui-tag--strong">有新版本</span></template>
          <template #meta>
            <span class="update-row__from-to">
              <template v-if="kernelAction === 'update'">正在下载、校验并切换内核</template>
              <span v-else-if="!kixdnsNotice" class="system-stale">检查失败：{{ updateStatus.kixdns_error ?? '原因未知' }}</span>
              <!-- 只在新旧版本之间断行，「→」「·」跟着后一段走：不会挂在行尾 / Lines break only between the two versions, and 「→」/「·」 travel with what follows, so neither is left at a line end -->
              <template v-else-if="kixdnsNotice.available"><span v-if="kernelPending" class="sk update-row__cur-sk" aria-hidden="true"></span><span v-else class="ui-num">{{ formatKixdnsVersion(activeVersion) }}</span> <span class="update-row__keep">→ <span class="ui-num">{{ latestKixdnsVersion() }}</span></span></template>
              <template v-else-if="kixdnsNotice.current_commit"><span class="update-row__keep">已是最新 · <span class="ui-num">{{ formatKixdnsVersion(activeVersion) }}</span></span></template>
              <template v-else>还没安装</template>
            </span>
            <span v-if="kixdnsNotice?.created_at">发布于 {{ buildTime(kixdnsNotice.created_at) }}</span>
          </template>
          <!-- 检查失败是 GitHub 的访问次数或 Token 的事：去填 Token 的按钮放在这一行的按钮位，和「更新」同一个位置、同一个样子
               When a check failed over GitHub's access limit or the token, the button to fill in a token sits in the row's action slot, where and how 更新 sits -->
          <template v-if="kixdnsNotice || !installed || needsToken(updateStatus.kixdns_error)" #actions>
            <button v-if="!kixdnsNotice && needsToken(updateStatus.kixdns_error)" class="ui-btn ui-btn--secondary ui-btn--sm ui-btn--inline" type="button" @click="focusToken">填写 Token</button>
            <!-- 和面板那一行同一个说法：链到这一版的发布页 / The same wording as the panel row: a link to this version's release page -->
            <a v-if="kixdnsNotice" class="ui-link" :href="kixdnsNotice.release_url" target="_blank" rel="noopener noreferrer">发布说明<ExternalLink :size="12" /></a>
            <button v-if="kixdnsNotice?.available || !installed" class="ui-btn ui-btn--secondary ui-btn--sm ui-btn--inline" type="button" :disabled="!kernel?.latest || kernelAction !== null || panelDown" @click="updateKernel">{{ kernelAction === 'update' ? '更新中' : (installed || kernelPending ? '更新' : '安装') }}</button>
          </template>
        </UiTask>

        <UiTask class="update-row" :state="panelTaskState" title="KixDNS 面板" :started-at="panelUpdateStartedAt" :progress="panelUpdateProgress">
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
            <span v-if="panelNotice && !panelNotice.release_url">首个正式版发布后显示</span>
            <p v-if="panelUpdateFailure" class="ui-task__error update-row__failure" role="alert">
              <span>{{ panelUpdateFailure }}</span>
              <button class="ui-btn ui-btn--secondary ui-btn--sm" type="button" @click="dismissPanelUpdateFailure">知道了</button>
            </p>
          </template>
          <template v-if="panelNotice?.release_url || (!panelNotice && needsToken(updateStatus.panel_error))" #actions>
            <button v-if="!panelNotice && needsToken(updateStatus.panel_error)" class="ui-btn ui-btn--secondary ui-btn--sm ui-btn--inline" type="button" @click="focusToken">填写 Token</button>
            <a v-if="panelNotice?.release_url" class="ui-link" :href="panelNotice.release_url" target="_blank" rel="noopener noreferrer">发布说明<ExternalLink :size="12" /></a>
            <button v-if="panelNotice?.available" class="ui-btn ui-btn--secondary ui-btn--sm ui-btn--inline" type="button" :disabled="startingPanelUpdate || panelUpdateRunning || panelDown" @click="startPanelUpdate">{{ panelUpdateRunning ? '更新中' : '在线更新' }}</button>
          </template>
        </UiTask>
      </div>
      <div v-else class="system-check-failed">
        <span>{{ updateError ? `检查失败：${updateError}` : '更新状态暂不可用' }}</span>
        <button class="ui-btn ui-btn--secondary" type="button" :disabled="checkingUpdates || panelDown" @click="refreshUpdatesWithQuota">重新检查</button>
      </div>
      <p v-if="updateError && updateStatus && !panelDown" class="system-card__row system-stale">最近一次检查失败，当前显示上次结果：{{ updateError }}</p>
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
          <span v-if="kernel" class="ui-tag" :class="installed ? 'ui-tag--ok' : 'ui-tag--warn'">{{ installed ? '已安装' : '还没安装' }}</span>
          <span v-else-if="loadingKernel" class="ui-tag install-sk__tag" aria-hidden="true">已安装</span>
        </div>
        <div class="system-card__main">
          <!-- 占位照读完后的样子排：小标签、大编号、一行附注、细线下三行哈希，用同样的类所以行高和间距一致；以前是一整块灰板，像一张没加载的图
               The placeholder is laid out like the loaded card (small label, big number, one note line, three hashes under the hairline) with the same
               classes, so line heights and gaps match; it used to be one grey slab that read like an image that had not loaded -->
          <div v-if="loadingKernel && !kernel" class="install-sk" role="status" aria-label="读取安装状态">
            <p class="install-version" aria-hidden="true"><span class="install-version__label"><i class="sk install-sk__label"></i></span><b><i class="sk install-sk__big"></i></b></p>
            <p class="install-meta" aria-hidden="true"><span><i class="sk install-sk__meta"></i></span></p>
            <dl class="ui-strip install-hashes" aria-hidden="true"><div v-for="n in 3" :key="n"><dt><i class="sk install-sk__dt"></i></dt><dd class="ui-mono"><i class="sk install-sk__dd"></i></dd></div></dl>
          </div>
          <template v-else-if="kernel">
            <p class="install-version"><span v-if="installed && versionLead.label" class="install-version__label">{{ versionLead.label }}</span><b>{{ installed ? versionLead.value : '还没安装' }}</b></p>
            <p v-if="installed" class="ui-dots install-meta">
              <!-- 补丁集只有旧的 Action 内核有；fork 发布没有这一项，不写「未记录」 / Only old Action kernels have a patchset; a fork release has none, so 未记录 is not written -->
              <span v-if="activeVersion?.patchset">补丁集 <span class="ui-num">p{{ activeVersion.patchset }}{{ activeVersion.dependency_revision ? `-r${activeVersion.dependency_revision}` : '' }}</span></span>
              <span>控制协议 <span class="ui-num">{{ activeVersion?.control_protocol ? `v${activeVersion.control_protocol}` : '未记录' }}</span></span>
              <!-- 链接本身是 inline-flex，套一层再让 ui-dots 画点 / The link is inline-flex, so it is wrapped before ui-dots draws the dot -->
              <!-- fork 发布的内核链到它所在的发布页，和「可用更新」里的「发布说明」同一个去处；旧轨道的内核是上游的构建，仍链到上游
                   A fork release links to the release it came from, the same place as 发布说明 under 可用更新; an old-track kernel was upstream's build and still links upstream -->
              <span v-if="activeVersion?.source === 'fork' && activeVersion.build_url"><a class="ui-link" :href="activeVersion.build_url" target="_blank" rel="noopener noreferrer">发布说明<ExternalLink :size="12" /></a></span>
              <span v-else-if="activeVersion?.source_url"><a class="ui-link" :href="activeVersion.source_url" target="_blank" rel="noopener noreferrer">原版源码<ExternalLink :size="12" /></a></span>
            </p>
            <p v-else class="install-meta">在上方「可用更新」里安装最新版本</p>
            <dl class="ui-strip install-hashes">
              <div><dt>原版提交</dt><dd class="ui-mono">{{ activeVersion?.upstream_commit ? shortHash(activeVersion.upstream_commit, 12) : '未记录' }}</dd></div>
              <!-- fork 发布记的是内核仓库的提交；旧的 Action 内核记的是面板仓库构建它的那次提交 / A fork release records the kernel repository's commit; an old Action kernel records the panel repository commit that built it -->
              <div><dt>{{ activeVersion?.source === 'fork' ? '内核提交' : '增强构建' }}</dt><dd class="ui-mono">{{ shortHash(activeVersion?.commit, 12) }}</dd></div>
              <div><dt>二进制摘要</dt><dd class="ui-mono">{{ shortHash(activeVersion?.binary_sha256, 14) }}</dd></div>
            </dl>
          </template>
        </div>
        <!-- 本机只留当前和上一个内核：回退只有一步，就放在当前安装的底行。
             Only the current and the previous kernel stay on this host, so a rollback is
             one step and sits on the installed card's bottom row. -->
        <!-- 读取时底行也先占着（装好的内核都有这一行），读完卡片不长高、下面的卡不往下跳 / While reading, the bottom row is held too (an installed kernel always has it), so the card does not grow and the card below does not jump -->
        <div v-if="loadingKernel && !kernel" class="system-card__row install-sk" aria-hidden="true"><span><i class="sk install-sk__row"></i></span></div>
        <div v-if="installed" class="system-card__row install-previous">
          <template v-if="kernel?.previous">
            <span>上一个版本 <span class="ui-num">{{ formatKixdnsVersion(kernel.previous) }}</span></span>
            <button class="ui-btn ui-btn--secondary ui-btn--sm ui-btn--inline" type="button" :disabled="kernelAction !== null || panelDown" @click="rollbackKernel"><RotateCw v-if="kernelAction === 'rollback'" :size="14" class="spin" />{{ kernelAction === 'rollback' ? '回退中' : '回退' }}</button>
          </template>
          <!-- 没有上一个版本时这一行照样在：卡片底部不留空，两张卡的底行对齐 / Without a previous build the row stays, so the card's bottom is never blank and the pair's bottom rows line up -->
          <span v-else class="install-previous__none">没有可回退的版本，更新一次后会留下上一个</span>
        </div>
      </section>

      <section class="ui-card system-card credential-panel" aria-labelledby="system-credential-label">
        <div class="system-card__head">
          <h2 id="system-credential-label" class="ui-card__label ui-card__label--as-is">GitHub Token</h2>
          <span class="ui-tag" :class="{ 'ui-tag--ok': githubTokenStatus?.configured }">{{ githubTokenStatus?.configured ? '已配置' : '匿名' }}</span>
        </div>
        <div class="system-card__main">
          <div class="credential-form">
            <!-- 占位符按 375 下量出来的可用宽度写：「github_pat_… 或 ghp_…」放不下，给一个写得下的例子就够了。
                 The placeholder fits the width measured at 375; one example that fits is enough. -->
            <label class="ui-input credential-input">
              <KeyRound :size="16" aria-hidden="true" />
              <input ref="tokenInput" v-model="githubToken" :type="githubTokenVisible ? 'text' : 'password'" :placeholder="githubTokenStatus?.configured ? '输入新 Token' : 'github_pat_…'" autocomplete="new-password" maxlength="256" aria-label="GitHub Token" :disabled="githubTokenBusy" @keyup.enter="saveGithubToken">
              <button class="credential-eye" type="button" :title="githubTokenVisible ? '隐藏 Token' : '显示 Token'" :aria-label="githubTokenVisible ? '隐藏 Token' : '显示 Token'" @click="githubTokenVisible = !githubTokenVisible"><EyeOff v-if="githubTokenVisible" :size="16" /><Eye v-else :size="16" /></button>
            </label>
            <button class="ui-btn ui-btn--secondary" type="button" :disabled="!githubToken || githubTokenBusy || panelDown" @click="saveGithubToken">{{ githubTokenBusy ? '处理中' : (githubTokenStatus?.configured ? '替换' : '保存') }}</button>
            <button class="ui-btn ui-btn--danger ui-btn--icon" type="button" title="删除 Token" aria-label="删除 Token" :disabled="!githubTokenStatus?.configured || githubTokenBusy || panelDown" @click="deleteGithubToken"><Trash2 :size="16" /></button>
          </div>
          <!-- 先说它只用在哪、不去哪；没配置时再说清为什么要填：GitHub 对匿名请求每小时只给 60 次，带 Token 是 5000 次。
               First where it is used and where it never goes; without a token, also why one helps: GitHub allows 60 anonymous requests an hour, 5,000 with a token. -->
          <p class="credential-hint"><span>只在检查新版本时发给 GitHub，下载不用它。</span><template v-if="!githubTokenStatus?.configured"><span>匿名访问 GitHub 每小时只有 <span class="nowrap">60 次请求</span>，常检查更新容易被限速。</span><span>填一个 Token 后是每小时 <span class="nowrap">5,000 次</span>。</span></template></p>
        </div>
        <div class="system-card__row credential-quota">
          <span v-if="githubRate" class="ui-dots"><span>剩余次数 <span class="ui-num">{{ githubQuota }}</span></span><span>{{ githubRateReset() }} 重置</span></span>
          <span v-else>面板还没访问过 GitHub，剩余次数未知</span>
          <span v-if="githubTokenError && !panelDown" class="system-error">{{ githubTokenError }}</span>
        </div>
      </section>
    </div>
    </template>

  </div>
</template>

<style>
/* 等重启时页头的转圈：和配置页页头同一个尺寸、同一个间距 / The header spinner while a restart is awaited: the config page header's size and spacing */
.system-spin { width: var(--size-icon-sm); height: var(--size-icon-sm); }
:is(.ui-facts b, .ui-ph__lead) > .system-spin { margin-right: calc(var(--s-1) - var(--s-2)); align-self: center; }
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
/* 侧栏版 861–959、641–679（横放的手机、小平板）页头放不下四项加两个按钮：PID 收起，内核不再单独占一行 / At 861–959 with the sidebar, and at 641–679 (landscape phones, small tablets), the header cannot hold four facts and two buttons: PID folds away so 内核 no longer takes its own row */
@media (min-width: 641px) and (max-width: 679px), (min-width: 861px) and (max-width: 959px) { .system-facts > .system-fact-pid { display: none; } }
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
/* 底行一样高：一张卡底行有「回退」小按钮、另一张只有一行字，按按钮的高度留，两张卡底行的细线才对齐
   Bottom rows share a height: one holds the small 回退 button, the other only a line of text; sized to the button, the two cards' bottom hairlines line up */
.system-card__row { min-height: calc(var(--h-sm) + var(--s-3) + 1px); }

/* 更新行：第一行贴着标签下面 12，最后一行不画线、不留底 / Update rows: the first sits 12 under the label, the last draws no line and keeps no bottom */
.system-tasks { margin-top: var(--s-2); }
.system-tasks > .ui-task:first-child { padding-top: var(--s-1); }
.system-tasks > .ui-task:last-child { padding-bottom: 0; border-bottom: 0; }
.system-page .system-skeleton-rows { margin-top: var(--s-3); padding-bottom: 0; }
.system-page .system-check-failed { margin-top: var(--s-3); padding-bottom: 0; }

/* 当前安装：大数字 32 · 700 是这张卡的主角，附注一行，哈希在细线下面 / The installed build: the 32 · 700 figure leads the card, one line of notes, the hashes under a hairline */
.system-page .install-version { display: grid; gap: var(--s-1); margin: var(--s-2) 0 0; }
/* 「构建」是小标签，大字只写编号：360 宽、侧栏版 900 宽时「构建 #30231271280」整串放大字会折成两行（和概览的「配置版本 / #18」同一种写法）
   「构建」 is a small label and the big figure is the number alone: as one big string 「构建 #30231271280」 folded onto two lines at 360 and at 900 (the overview's 配置版本 / #18 pattern) */
.system-page .install-version__label { color: var(--l-ink-3); font-size: var(--t-1); }
.system-page .install-version > b { font-family: var(--f-display); font-size: var(--t-6); font-weight: var(--w-heavy); font-variant-numeric: tabular-nums; letter-spacing: -.02em; line-height: var(--lh-tight); white-space: nowrap; }
.system-page .install-meta { margin-top: var(--s-2); color: var(--l-ink-2); font-size: var(--t-2); }
.system-page .install-hashes { margin-top: var(--s-4); padding-top: var(--s-3); border-top: 1px solid var(--l-hair); }
/* 当前安装的占位：灰条比文字矮，竖直居中在各自那一行里，行高来自真正的类 / The installed card's placeholder: bars shorter than the text, centred in their own lines, whose heights come from the real classes */
.system-page .install-sk .sk { display: inline-block; height: .7em; vertical-align: middle; }
.system-page .install-sk__label { width: 2.5em; }
.system-page .install-sk__big { width: 5.5em; }
.system-page .install-sk__meta { width: 16em; max-width: 100%; }
.system-page .install-sk__dt { width: 4em; }
.system-page .install-sk__dd { width: 8em; max-width: 100%; }
.system-page .install-sk__row { width: 12em; max-width: 100%; }
/* 标签的位置也先占着：同样大小的灰块，字透明 / The tag's place is held too: a grey block of the same size with the text transparent */
.system-page .install-sk__tag { color: transparent; background: var(--l-hair); }

/* GitHub 凭据：表单在标签下面 12，说明在表单下面 12 / The credential: the form 12 under the label, the note 12 under the form */
.system-page .credential-form { margin-top: var(--s-3); }
.system-page .credential-hint { margin: var(--s-3) 0 0; max-width: none; }

@media (max-width: 640px) {
  .system-page { gap: var(--s-4); }
  .system-card { padding: var(--s-3) var(--s-4) var(--s-4); }
}
/* 没有可回退版本时底行的一句说明 / The bottom row's note when there is nothing to roll back to */
.install-previous__none { color: var(--l-ink-3); font-size: var(--t-2); }
</style>
