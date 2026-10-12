import { computed, ref, watch } from 'vue'
import { ApiError, CONFIG_WRITTEN_EVENT, apiRequest, isPanelDown, jsonBody } from '../api/client'
import { useConfirm } from '../composables/useConfirm'
import { registerHeldDraft } from '../composables/useLeaveGuard'
import type { ConfigApplyResult, ConfigDocument, ConfigRuntimeApplyState, ConfigVersion, ConfigVersionDetail, ConfigVersions, DeleteConfigVersionResult, DeleteConfigVersionsResult, Overview, ServiceStatus, ValidationResult } from '../api/types'
import { SETTING_SECTIONS, settingNeedsCapability, settingSupported } from '../config-editor/schema'
import { exportConfig, readConfig } from '../config-model/document'
import type { Model } from '../config-model/model'
import { traceNames } from '../config-model/trace-names'
import { useConnection } from '../composables/useConnection'
import { dismissUndoable, toastMark, useToast } from '../composables/useToast'
import { errorMessage } from '../utils'
import { applyHits, applyUpstreamStats, changeCount, dialogEdits, dirty, draftGeneration, editorEdited, importReport, importSource, jsonEdited, loadContent, model, rebaseApplied, replaceModel, reportOpen, unsaved } from './store'

// 配置页和面板服务之间的事：读配置和历史、KixDNS 的运行状态和能力、校验、保存并热加载、现在应用。
// 草稿本身在 store.ts；这里只管「文件」和「运行」。所有状态是模块级的，页面和保存条共用同一份。
// What lies between the config page and the panel server: loading the config and its history, KixDNS's runtime state and
// capabilities, validating, saving with hot reload, applying now. The draft itself lives in store.ts; this file owns the file and the
// runtime. All state is module-level, shared by the page and the save bar.

export const doc = ref<ConfigDocument | null>(null)
export const versions = ref<ConfigVersion[]>([])
export const loading = ref(true)
export const loadError = ref('')
export const capabilityError = ref('')
export const runtimeStopped = ref(false)
export const runtimeCapabilities = ref<string[]>([])
// 从页头「现在应用」「校验并应用」发起、又没走到服务端记录失败的那一步时的原因 / The reason when an apply from the header failed before the server could record it
export const applyError = ref('')
export const validation = ref<ValidationResult | null>(null)
export const canCname = computed(() => runtimeCapabilities.value.includes('config_static_cname_response_v1'))

const runtimeApplyState = computed<ConfigRuntimeApplyState | undefined>(() => doc.value?.runtime.apply_state)
export const hasApplyFailure = computed(() => runtimeApplyState.value === 'failed' || doc.value?.runtime.status === 'failed' || Boolean(doc.value?.runtime.pending_error) || Boolean(doc.value?.pending?.error))
export const hasPending = computed(() => !hasApplyFailure.value && (runtimeApplyState.value === 'pending' || doc.value?.runtime.status === 'pending' || Boolean(doc.value?.pending)))
export const pendingVersionId = computed(() => doc.value?.pending?.version_id ?? (runtimeApplyState.value === 'pending' ? doc.value?.version_id : null) ?? null)
export const currentVersionId = computed(() => {
  const activeSha = doc.value?.runtime.active_sha256
  const applied = versions.value.find((v) => v.apply_state === 'applied' && (!activeSha || v.sha256 === activeSha))
  if (applied) return applied.id
  if (hasPending.value || hasApplyFailure.value) return null
  return doc.value?.version_id ?? null
})
export const runtimeUnavailable = computed(() => doc.value?.runtime.status === 'unavailable' && !runtimeStopped.value)
export const unsupportedFields = computed(() => SETTING_SECTIONS.flatMap((s) => s.fields)
  .filter((f) => settingNeedsCapability(f, model.settings) && !settingSupported(f, runtimeCapabilities.value))
  .map((f) => f.label))
// 内核报了自己支持什么、草稿里却开着它没有的功能：服务端不收这份配置（开着也不起作用），所以先不让保存
// The kernel reported what it supports and the draft switches on a feature it lacks: the server refuses the config (the switch would do nothing), so saving waits
// 写出去的配置里有几条规则用到某种动作：和服务端 config_uses_action 同一个判断（后台刷新规则和每条规则的动作，含回答后检查的两组）。
// 按写出的配置数，停用的规则（不写出）不算，回答后检查、高级规则、域名映射里的都算
// How many rules in the exported config use an action type: the same test as the server's config_uses_action (the background refresh rule and every
// rule's actions, both post-reply groups included). Counted on the export, so disabled rules (not written) do not count, while post-reply checks,
// advanced rules and mappings do
const ACTION_FIELDS = ['actions', 'response_actions_on_match', 'response_actions_on_miss']
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const ruleUsesAction = (rule: unknown, type: string) => isRecord(rule) && ACTION_FIELDS.some((field) => {
  const actions = rule[field]
  return Array.isArray(actions) && actions.some((action) => isRecord(action) && action.type === type)
})
export function rulesUsingAction(content: Record<string, unknown>, type: string): number {
  const pipelines = Array.isArray(content.pipelines) ? content.pipelines : []
  const rules = pipelines.flatMap((pipeline) => (isRecord(pipeline) && Array.isArray(pipeline.rules) ? pipeline.rules : []))
  return [content.background_refresh_rule, ...rules].filter((rule) => ruleUsesAction(rule, type)).length
}
// 草稿里有几处 CNAME 回答（域名映射写成域名、规则或回答后检查的自定义回答是 CNAME）；只在内核不支持时才会读到它，那时才导出一次
// How many CNAME answers the draft has (a mapping answering with a domain, a rule's or post-reply check's custom answer); read only when the kernel lacks support, so only then is it exported
export const cnameAnswers = computed(() => rulesUsingAction(exportConfig(model) as Record<string, unknown>, 'static_cname_response'))
export const cnameInUse = computed(() => cnameAnswers.value > 0)
export const blockedFields = computed(() => (!runtimeStopped.value && !runtimeUnavailable.value && !capabilityError.value
  ? [...unsupportedFields.value, ...(!canCname.value && cnameInUse.value ? ['CNAME 回答'] : [])]
  : []))
// 不支持的设置在哪一组：「去基础设置」直接打开那一组 / Which group holds the unsupported settings, so 去基础设置 opens it directly
export const unsupportedSection = computed(() => SETTING_SECTIONS.find((s) => s.fields.some((f) => settingNeedsCapability(f, model.settings) && !settingSupported(f, runtimeCapabilities.value)))?.id ?? '')
// KixDNS 没启动、连不上、没报能力时，保存只存成待应用版本 / Saving only stores a pending version when KixDNS is down, unreachable or silent about capabilities
export const deferSave = computed(() => runtimeStopped.value || runtimeUnavailable.value || Boolean(capabilityError.value))
export const fileDiffers = computed(() => !hasPending.value && !hasApplyFailure.value && doc.value?.runtime.status === 'different')
// 草稿里有内核不支持的东西时，现在应用 / 重试应用也只会被拒：不给这两个按钮 / With something the kernel does not support in the draft, 现在应用 and 重试应用 would only be refused: neither is offered
// 被挡住时按一下说什么：设置要关掉，CNAME 要改成 IP / What a press says while blocked: settings are switched off, CNAME becomes an IP
export const blockedHint = computed(() => {
  const settings = blockedFields.value.filter((field) => field !== 'CNAME 回答')
  const cname = settings.length < blockedFields.value.length
  if (!settings.length) return '当前内核不支持 CNAME 回答，先改成 IP 再保存'
  if (!cname) return `当前内核不支持：${settings.join('、')}，先关掉再保存`
  return `当前内核不支持：${blockedFields.value.join('、')}。先关掉${settings.length > 1 ? '这些设置' : '这一项设置'}、CNAME 改成 IP，再保存`
})
// 被挡住时的那句提示只留一条，挡住的东西都处理掉了就收起 / Only one copy of the blocked hint, cleared once nothing blocks any more
let blockedToast: number | null = null
export function sayBlocked(): void {
  blockedToast = useToast().info(blockedHint.value)
}
watch(() => blockedFields.value.length, (n) => { if (!n && blockedToast !== null) { useToast().dismiss(blockedToast); blockedToast = null } })
export const canApplyNow = computed(() => (hasPending.value || hasApplyFailure.value || fileDiffers.value) && !deferSave.value && blockedFields.value.length === 0)
export const canSave = computed(() => (dirty.value || canApplyNow.value) && blockedFields.value.length === 0)

// ---------- 保存的几步 / the save's stages ----------
export type SaveStage = 'idle' | 'checking' | 'validating' | 'applying' | 'done' | 'failed'
export const stage = ref<SaveStage>('idle')
// 这一次是保存草稿（保存栏报进度）还是应用已保存的版本（页头报进度） / Whether this run saves the draft (the save bar reports) or applies a saved version (the header reports)
export const origin = ref<'draft' | 'apply'>('draft')
export const note = ref('')
export const verdict = ref('')
// 冲突时记下服务端现在的版本，保存栏给「重新读取」 / On a conflict the save bar offers 重新读取
export const conflict = ref(false)
export const saveMessage = ref('')
const startedAt = ref(0)
const clock = ref(0)
let clockTimer: ReturnType<typeof setInterval> | undefined
let settleTimer: ReturnType<typeof setTimeout> | undefined
export const busy = computed(() => ['checking', 'validating', 'applying'].includes(stage.value))
// 真的在保存（校验、写入），不是单独点的「校验」：这时换掉草稿的操作要等它做完 / A save really running (validate, then write), not a lone 校验: actions that replace the draft wait for it
export const saveInFlight = computed(() => stage.value === 'validating' || stage.value === 'applying')
export const elapsed = computed(() => {
  const seconds = (clock.value - startedAt.value) / 1000
  return busy.value && seconds >= 1 ? `已用 ${seconds.toFixed(1)} 秒` : ''
})
export const applyBusy = computed(() => busy.value && origin.value === 'apply')
function startStage(next: SaveStage): void {
  clearTimeout(settleTimer)
  stage.value = next
  startedAt.value = Date.now()
  clock.value = startedAt.value
  clearInterval(clockTimer)
  clockTimer = setInterval(() => { clock.value = Date.now() }, 100)
}
export function finishStage(next: 'done' | 'failed' | 'idle', text = ''): void {
  clearInterval(clockTimer)
  stage.value = next
  note.value = text
  // 「已生效」停三秒再回到平常；失败一直留着，直到再改或再存 / "Applied" stays three seconds; a failure stays until the next edit or save
  if (next === 'done') settleTimer = setTimeout(() => { if (stage.value === 'done') stage.value = 'idle' }, 3000)
}
// 再改一笔，上一次保存的结果就过时了；冲突除外：草稿还是基于旧版本，再存也一样失败，要等重新读取
// A new edit makes the last save's outcome stale, except a conflict: the draft is still based on the old version and would fail again until re-read
export function editTouched(): void {
  if (conflict.value) return
  if (stage.value === 'done' || stage.value === 'failed') finishStage('idle')
}

// ---------- 页头 / header ----------
// wide：宽屏「状态」标签下面写的（缺省是 lead，再缺省是整句）；手机上没有标签，写 lead 和整句
// wide: what sits under the 状态 label on wide screens (lead by default, else the whole line); phones have no label and show lead plus the line
export interface HeaderStatus { tone: 'ok' | 'warn' | 'err' | 'off'; lead?: string; before: string; version?: number; after?: string; wide?: string[] }
export const headerStatus = computed<HeaderStatus>(() => {
  if (hasApplyFailure.value) return { tone: 'err', before: '配置应用失败' }
  if (hasPending.value) {
    const waiting = pendingVersionId.value ? { before: '版本 #', version: pendingVersionId.value, after: ' 待应用' } : { before: '配置待应用' }
    if (!runtimeStopped.value) return { tone: 'warn', ...waiting }
    // KixDNS 停着时先说停了，再说哪个版本在等：后面的「启动」读作启动 KixDNS，不是启动这个版本（宽屏版本号已经在旁边的「配置版本」里）
    // With KixDNS stopped, say so first and then which version waits: the 启动 after it reads as starting KixDNS, not this version
    return { tone: 'off', lead: 'KixDNS 已停止', ...waiting, wide: ['已停止', '待应用'] }
  }
  // 宽屏「状态」标签下面写「已停止」，和「运行中」「未知」一样不带主语，900 宽左右那一排才放得下 / Under the wide 状态 label it reads 已停止, without a subject like 运行中 and 未知, so the row fits around 900
  if (runtimeStopped.value) return { tone: 'off', before: 'KixDNS 已停止', wide: ['已停止'] }
  if (doc.value?.runtime.status === 'active') return currentVersionId.value ? { tone: 'ok', lead: '运行中', before: '版本 #', version: currentVersionId.value } : { tone: 'ok', before: '运行中' }
  if (fileDiffers.value) return { tone: 'warn', before: '文件与运行配置不同' }
  return { tone: 'off', before: '运行状态不可用' }
})
// 连不上面板时，上次读到的运行状态不能当真：点变灰，写「状态未知」，连上后恢复（同概览）
// While the panel is unreachable the last runtime state read cannot be trusted: the dot turns grey and reads 状态未知, restored on reconnect (as on the overview)
const { down: panelDown } = useConnection()
export const headerLine = computed<HeaderStatus>(() => {
  // 宽屏的「状态」标签下面只写「未知」，不说两遍「状态」 / Under the wide 状态 label it reads 未知 only, not 状态 twice
  if (!applyBusy.value) return panelDown.value ? { tone: 'off', before: '状态未知', wide: ['未知'] } : headerStatus.value
  const verb = stage.value === 'validating' ? '校验中' : '应用中'
  return pendingVersionId.value ? { tone: 'warn', before: '版本 #', version: pendingVersionId.value, after: ` ${verb}` } : { tone: 'warn', before: verb }
})
// 待应用时「现在应用」，文件和运行配置不同时「校验并应用」；有要保存的修改时让给保存栏 / 现在应用 when pending, 校验并应用 when the file differs; with changes to save it gives way to the save bar
export const headerAction = computed(() => {
  // 有任何没保存的修改（包括右侧规则没点完成的）都让给保存栏：应用会重读文件，丢掉那些修改 / Any unsaved edit (an unfinished panel edit included) gives way to the save bar: applying re-reads the file and would drop it
  if (!canApplyNow.value || unsaved.value || hasApplyFailure.value || panelDown.value) return ''
  return fileDiffers.value ? '校验并应用' : '现在应用'
})
export const deferNote = computed(() => {
  if (runtimeStopped.value) return '保存后等 KixDNS 启动再应用'
  if (runtimeUnavailable.value) return '保存后等连上 KixDNS 再应用'
  if (capabilityError.value) return 'KixDNS 没有报告它支持哪些功能，保存后先存成待应用版本'
  return deferSave.value ? '保存后先存成待应用版本' : ''
})

// ---------- 错误的说法 / wording of errors ----------
// 控制接口的套接字不在：KixDNS 停了（面板还没发现）。只认这几种说法；连接超时、没及时确认新配置这类不算停了
// The control socket is gone: KixDNS has stopped (before the panel noticed). Only these wordings count; a timeout or a late confirmation is not a stop
const STOPPED = /No such file|os error 2|找不到指定的文件|^KixDNS 已停止/
const stoppedError = (error: unknown) => STOPPED.test(errorMessage(error))
// 保存或校验时才发现停了：标题说停了，不说「没有通过校验」；草稿不动，读一次运行状态，保存键换成「保存为待应用」
// Found stopped while saving or validating: the title says so rather than 没有通过校验; the draft stays, the runtime is re-read and the button becomes 保存为待应用
const STOPPED_NOTE = '草稿还在，可以先存成待应用版本'
export function friendlyRuntimeMessage(message: string): string {
  if (STOPPED.test(message)) return 'KixDNS 已停止，保存后等它启动再应用'
  return kernelWords(message.replace(/^KixDNS\s*拒绝(?:操作|了这份配置|该配置)[：:，,]\s*/, '') || message)
}
/**
 * 内核给的英文原因（pipeline "main" references unknown upstream group "fast"）照原话给，但标明是 KixDNS 的原话，引号里的内核 id 换成页面上的叫法
 * The kernel's English reason (pipeline "main" references unknown upstream group "fast") is kept verbatim but marked as KixDNS's own words, with quoted kernel ids turned into the page's names
 */
export function kernelWords(message: string): string {
  if (/[\u4e00-\u9fff]/.test(message) || !/[A-Za-z]{3,}/.test(message)) return message
  const names = traceNames(model)
  return `KixDNS 的原话：${message.replace(/"([\w.-]+)"/g, (whole, id: string) => { const name = names.pipeline(id); return name ? `${whole}（${name}）` : whole })}`
}
const friendlyRuntimeError = (error: unknown) => friendlyRuntimeMessage(errorMessage(error))
/** 没生效的原因本身：去掉句尾「仍在用之前的配置」，给已经说了这件事的提示条用 / Just why it did not take, without the trailing 仍在用之前的配置, for a notice that already says so */
export const failureCause = (message: string): string => friendlyRuntimeMessage(message).replace(/[，,]\s*仍在用之前的配置。?$/, '')
const shouldRefreshAfterSaveError = (error: unknown) => error instanceof ApiError && ['unsupported_config_fields', 'config_validation_failed', 'reload_failed', 'kixdns_rejected'].includes(error.code)
const isConflict = (error: unknown) => error instanceof ApiError && error.code === 'config_conflict'

// ---------- 读 / load ----------
function applyRuntime(nextDoc: ConfigDocument, overview: Overview | null, service: ServiceStatus | null): void {
  const declared = nextDoc.runtime.declared_capabilities ?? []
  if (overview) {
    runtimeStopped.value = !overview.live && (service?.active_state === 'inactive' || overview.service_active === false)
    runtimeCapabilities.value = overview.live ? overview.health.capabilities : declared
    capabilityError.value = overview.live || declared.length > 0 ? '' : 'KixDNS 实时能力暂不可用'
  } else {
    runtimeStopped.value = service?.active_state === 'inactive'
    runtimeCapabilities.value = declared
    if (!runtimeStopped.value && !capabilityError.value && declared.length === 0) capabilityError.value = 'KixDNS 实时能力暂不可用'
  }
}
// 只刷新运行状态，不碰草稿和文件的散列：草稿有修改时（比如在页头启动 KixDNS 之后）用它，保存时照样能发现别处的改动
// Refresh only the runtime state, leaving the draft and the file hash alone: used while the draft has edits (after starting KixDNS from
// the header, say), so a later save still notices changes made elsewhere
// 运行数据读不到：KixDNS 那边的原因记成「没有报告能力」；连不上面板不是 KixDNS 的事，照样抛出去（横幅会说）
// The runtime data failed: a cause on the KixDNS side counts as 没有报告能力; an unreachable panel is not KixDNS's doing and is rethrown (the banner says it)
function overviewFailed(error: unknown): null {
  if (isPanelDown(error)) throw error
  capabilityError.value = friendlyRuntimeError(error)
  return null
}
export async function refreshRuntime(): Promise<void> {
  const [nextDoc, overview, service] = await Promise.all([
    apiRequest<ConfigDocument>('/api/v1/config'),
    apiRequest<Overview>('/api/v1/overview').catch(overviewFailed),
    apiRequest<ServiceStatus>('/api/v1/service').catch(() => null),
  ])
  applyRuntime(nextDoc, overview, service)
  if (doc.value) doc.value = { ...doc.value, runtime: nextDoc.runtime, pending: nextDoc.pending }
  applyHits(overview?.metrics?.rules ?? [])
  applyUpstreamStats(overview?.metrics?.upstreams ?? [], overview?.metrics?.recent_window_seconds ?? null)
}

let pendingLoad: Promise<void> | null = null
// 上一次读取失败是不是因为连不上面板：连上后运行状态读得到，这条失败就过时了 / Whether the last read failed because the panel was unreachable: once the runtime reads again, that failure is stale
let loadFailedDown = false
// quiet：保存之后的刷新不换成骨架 / quiet: the refresh after a save keeps the page mounted
// keepDraft：草稿里有没保存的修改（保存途中又改的、右侧规则没点完成的、删版本时草稿里的）就留着草稿，只把对照的那份换成读到的文件；
// sent 是保存时发出去的草稿，读回来和它一样、又没有别的没保存的修改时照常整份换上（换成文件里的写法）
// keepDraft: with unsaved edits in the draft (made during a save, an unfinished panel edit, the draft while a version is deleted) the draft stays and only
// the baseline becomes the file just read; sent is the draft a save sent, and when nothing changed since and nothing else is unsaved the file replaces it as usual
export function load(options: { quiet?: boolean; keepDraft?: boolean; sent?: string } = {}): Promise<void> {
  if (pendingLoad) return pendingLoad
  if (!options.quiet) loading.value = true
  pendingLoad = (async () => {
    const [nextDoc, history, overview, service] = await Promise.all([
      apiRequest<ConfigDocument>('/api/v1/config'),
      apiRequest<ConfigVersions>('/api/v1/config/versions'),
      apiRequest<Overview>('/api/v1/overview').catch(overviewFailed),
      apiRequest<ServiceStatus>('/api/v1/service').catch(() => null),
    ])
    applyRuntime(nextDoc, overview, service)
    const previousSha = doc.value?.sha256
    doc.value = nextDoc
    versions.value = history.versions
    // 读进草稿：散列对得上就是面板写的那份；对不上（手改过）会重新导入并给报告 / Into the draft: the hash matching means the panel wrote it; otherwise it is re-imported with a report
    // 重新读进来的是另一份草稿：上一份草稿的失败和冲突不再适用 / What is read in is a different draft: the previous draft's failure and conflict no longer apply
    if (!options.quiet) { conflict.value = false; if (stage.value === 'failed' || stage.value === 'done') finishStage('idle') }
    // 保存之后（sent）一律只换对照的那份：草稿里的对象不换，开着的抽屉、规则面板拿着的还是同一个对象（以前整份换掉，保存途中打开的上游组抽屉会改到别的组）。
    // 写进文件再读回来和草稿一样（store.test 里有往返测试），所以没再改过时「已修改」归零
    // After a save (sent) only the baseline moves: the draft's objects stay, so an open drawer or rule panel still holds the same object (replacing them
    // made an upstream-group drawer opened during a save write to another group). Writing and reading back equals the draft (round-trip test in store.test), so with no edits since, the count returns to zero
    if (options.sent !== undefined || (options.keepDraft && unsaved.value)) {
      // 文件没变就什么都不动；变了（保存成功、别处改过）把对照的那份换成它，草稿里的修改照旧算修改
      // File unchanged: nothing moves; changed (a save went through, an edit elsewhere): the baseline becomes it and the draft's edits still count as edits
      if (options.sent !== undefined || nextDoc.sha256 !== previousSha) rebaseApplied(readConfig(nextDoc.content, model).model)
    } else if (options.quiet && nextDoc.sha256 === previousSha) {
      // 文件没变（连上后的静默重读）：不把草稿整份换掉，开着的规则编辑不会自己关上 / The file is unchanged (the quiet re-read after a reconnect): the draft is not replaced, so an open rule editor does not close by itself
    } else {
      const read = loadContent(nextDoc.content, model)
      if (read.source === 'imported' && read.report && (read.report.stats.raw || read.report.notes.some((n) => n.level === 'warn'))) {
        importReport.value = read.report
        importSource.value = '配置文件'
        reportOpen.value = false
      }
    }
    applyHits(overview?.metrics?.rules ?? [])
    applyUpstreamStats(overview?.metrics?.upstreams ?? [], overview?.metrics?.recent_window_seconds ?? null)
    validation.value = null
    loadError.value = ''
    loadFailedDown = false
    // 重新读取成功：「重试没有成功：…先重新读取」那条提示说的事已经办了 / Re-read done: the 「重试没有成功：…先重新读取」 toast's advice has been taken
    if (!options.quiet && retryToast !== null) { useToast().dismiss(retryToast); retryToast = null }
  })().catch((error: unknown) => { loadError.value = errorMessage(error); loadFailedDown = isPanelDown(error) }).finally(() => { loading.value = false; pendingLoad = null })
  return pendingLoad
}

// ---------- 校验、保存、应用 / validate, save, apply ----------
// 单独点的「校验」还没回来时按了保存：等它回来再保存，不吞掉这一下 / Save pressed while a lone 校验 is still out: the save waits for it instead of swallowing the press
let checkRun: Promise<ValidationResult | null> | null = null
export async function validate(): Promise<ValidationResult | null> {
  if (checkRun) return checkRun
  checkRun = runCheck()
  try { return await checkRun } finally { checkRun = null }
}
async function runCheck(): Promise<ValidationResult | null> {
  // 冲突时校验没有意义，还会把冲突的提示盖掉：先重新读取 / Validating during a conflict means nothing and would wipe the conflict line: re-read first
  if (deferSave.value || conflict.value) return null
  origin.value = 'draft'
  startStage('checking')
  try {
    validation.value = await apiRequest<ValidationResult>('/api/v1/config/validate', { method: 'POST', ...jsonBody(exportConfig(model)) })
    finishStage('idle')
    return validation.value
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) { finishStage('idle'); return null }
    const stopped = stoppedError(error)
    const down = isPanelDown(error)
    verdict.value = stopped ? 'KixDNS 已停止' : down ? '连不上面板' : '没有通过校验'
    finishStage('failed', stopped ? STOPPED_NOTE : down ? '草稿还在，连上后再校验' : friendlyRuntimeError(error))
    if (stopped) await refreshRuntime().catch(() => undefined)
    return null
  }
}

// 写入的结果先记进运行状态和版本列表：之后的重读失败了，页头也和保存条说同一个版本（以前页头还按旧列表写上一个版本）
// The write's outcome goes into the runtime state and the version list at once: if the re-read after it fails, the header still names the same version
// as the save bar (it used to name the previous one from the stale list)
function recordWrite(result: ConfigApplyResult, message: string): void {
  const applied = applyResultState(result) === 'applied'
  if (doc.value) {
    doc.value = applied
      ? { ...doc.value, pending: null, runtime: { ...doc.value.runtime, status: 'active', active_sha256: result.sha256, apply_state: 'active', pending_error: null } }
      : { ...doc.value, pending: { version_id: result.version_id, sha256: result.sha256, message }, runtime: { ...doc.value.runtime, status: 'pending', apply_state: 'pending' } }
  }
  const entry: ConfigVersion = { id: result.version_id, sha256: result.sha256, message, actor: '', created_at: Math.floor(Date.now() / 1000), apply_state: applied ? 'applied' : 'pending' }
  versions.value = [entry, ...versions.value.filter((v) => v.id !== result.version_id).map((v) => (applied && v.apply_state === 'applied' ? { ...v, apply_state: 'superseded' as const } : v))]
}
function applyResultState(result: ConfigApplyResult): 'applied' | 'pending' {
  return result.apply_state === 'pending' || !result.active_config ? 'pending' : 'applied'
}

// 保存途中离开配置页：保存照常做完，结果用提示说；没保存成功时草稿留在内存里，回到配置页时接着用它
// Leaving the config page mid-save: the save still finishes and its outcome is told in a toast; if it failed, the draft stays in memory and the page picks it up on return
let viewing = false
let keepOnReturn = false
let inFlight: string | null = null
// 离开以后报保存结果的那条失败提示：回到配置页时保存条接着说，它就收起 / The failure toast raised after leaving: it goes when the config page reopens and the save bar takes over
let awayToast: number | null = null
// 回应丢了的那次保存（写进去没有不知道）：连上以后、或者下一次保存撞上「别处改过了」时，拿面板上的配置和它比一比
// The save whose answer was lost (written or not, unknown): once reconnected, or when the next save meets 别处改过了, compare the panel's config with it
let unanswered: { content: unknown; sent: string; generation: number; sentAt: number } | null = null
const announceWritten = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event(CONFIG_WRITTEN_EVENT)) }
// 不在配置页时草稿还在内存里（正在保存，或者没保存成功留着）：刷新、关掉浏览器先问一句；配置页开着时由它自己问
// Away from the config page with a draft still in memory (a save in flight, or one that failed and is kept): reloading or closing the browser asks first; while
// the config page is open it asks itself
export const draftHeldAway = (): boolean => !viewing && (busy.value || keepOnReturn)
if (typeof window !== 'undefined') window.addEventListener('beforeunload', (event) => { if (draftHeldAway()) { event.preventDefault(); event.returnValue = '' } })
// 会话过期跳到登录页时，不在配置页的这份草稿也算丢了：登录页照实说，回来时不再拿它充数（两种时机结果一样）
// When the session expires and the app goes to the login page, a draft held away from the config page counts as lost too: the login page says so, and it
// is not brought back on return (both timings end the same)
// 会话过期或退出登录时放下这份草稿：离开那条提示一起收起；还在路上的那次保存不再把草稿留下、也不再弹「草稿留在配置页」
// Let go of the held draft on session expiry or sign-out: its away toast goes too, and a save still on its way no longer keeps the draft or says 草稿留在配置页
let abandoned = false
registerHeldDraft(draftHeldAway, () => { keepOnReturn = false; dismissAwayToast(); if (inFlight !== null) abandoned = true }, () => useConfirm().ask({
  title: '放弃配置页的草稿',
  body: busy.value ? '配置页的保存还没做完。退出登录以后不再告诉你结果，没存上的修改也会丢掉。' : '配置页有一份没保存成功的修改，还没存到面板上，退出登录以后就没了。',
  confirmLabel: '放弃并退出',
  cancelLabel: '先不退出',
  destructive: true,
}))
function keepDraftForReturn(): void {
  keepOnReturn = true
}
function dropKeptDraft(): void {
  keepOnReturn = false
}
/** 离开时同意丢掉保存开始以后改的：草稿退回正在保存的那一份，保存没成功时回来看到的就是它 / Agreed to drop the edits made after the save began: the draft goes back to the one being saved, which is what a failed save brings back */
export function dropEditsAfterSave(): void {
  if (inFlight !== null) replaceModel(JSON.parse(inFlight) as Model)
}
function dismissAwayToast(): void {
  if (awayToast !== null) useToast().dismiss(awayToast)
  awayToast = null
}
/** 配置页打开（true）或离开（false）；打开时返回要不要留着草稿 / The config page opened (true) or left (false); on open, returns whether to keep the draft */
export function setViewing(open: boolean): boolean {
  viewing = open
  const keep = open && keepOnReturn
  if (open) {
    dropKeptDraft()
    dismissAwayToast()
  }
  return keep
}
/** 草稿里没保存的就是正在保存的那一份：离开不用问 / Everything unsaved is the draft being saved right now: leaving need not ask */
export const onlySaving = (): boolean => busy.value && origin.value === 'draft' && inFlight === JSON.stringify(model)
  && !editorEdited.value && !jsonEdited.value && dialogEdits.size === 0
const sentence = (text: string) => text.replace(/[。.]\s*$/, '')

// origin：保存草稿（保存栏报进度）或应用已经保存的版本（页头报进度，出错进提示）。有改动、或者要应用和运行配置不同的文件，
// 而且 KixDNS 在运行时，先单独校验一次：没过就停在第 1 步，不写入任何版本。
// origin: saving the draft (the save bar reports) or applying a saved version (the header reports, errors go to a notice). With
// changes, or a file that differs from what runs, and KixDNS running, validate on its own first: a failure stops at step 1 with no version written.
export async function save(from: 'draft' | 'apply' = 'draft'): Promise<void> {
  if (checkRun) await checkRun
  if (busy.value || !doc.value) return
  // 被内核不支持的设置挡住时说一句，不默默不动 / Blocked by unsupported settings: say so instead of doing nothing
  if (blockedFields.value.length) { sayBlocked(); return }
  if (!canSave.value) return
  // 要写入的配置在这一刻定下来，复制一份：导出的结果和草稿共用数组，写入的请求要等校验完才打包，校验途中的修改会混进去、没校验就写进文件
  // The config to write is fixed now, as a copy: the export shares arrays with the draft and the write request is only built after validation,
  // so an edit made during validation would slip in and be written unvalidated
  const content: unknown = JSON.parse(JSON.stringify(exportConfig(model)))
  const sent = JSON.stringify(model)
  // 发出去的草稿定在这一刻：之后的修改（校验途中的也算）不在这次保存里，它们的撤销保存后照样留着 / The draft sent is fixed at this moment: edits after it (during validation too) are not in this save, and their undos stay after it lands
  const sentAt = toastMark()
  const settledBefore = settledCount
  inFlight = sent
  origin.value = from
  applyError.value = ''
  conflict.value = false
  const checkFirst = (dirty.value || fileDiffers.value) && !deferSave.value
  let step: SaveStage = checkFirst ? 'validating' : 'applying'
  startStage(step)
  try {
    if (checkFirst) {
      validation.value = await apiRequest<ValidationResult>('/api/v1/config/validate', { method: 'POST', ...jsonBody(content) })
      step = 'applying'
      stage.value = step
    }
    const message = saveMessage.value.trim()
    const result = await apiRequest<ConfigApplyResult>('/api/v1/config', { method: 'PUT', ...jsonBody({ content, expected_sha256: doc.value.sha256, message }) })
    const pendingText = `已存成待应用版本 #${result.version_id}，${pendingWhen()}自\u2060动\u2060应\u2060用`
    saveMessage.value = ''
    // 写入成功就先记下：文件的散列和版本换成这次的，对照的那份换成发出去的草稿。之后的重读失败了，也不会把已保存的算成修改、下次保存也不会撞上自己
    // Record the write at once: the file hash and version become this save's, and the baseline becomes the draft that was sent. If the re-read after it fails,
    // nothing saved counts as a change and the next save does not collide with itself
    if (doc.value) doc.value = { ...doc.value, sha256: result.sha256, version_id: result.version_id }
    recordWrite(result, message)
    // 这次保存落地了：之前回应丢了的那次已经被它盖过，记录不再有用（留着会在以后哪次连上时冒出一句不相干的提示）
    // This save landed: an earlier lost-answer save is superseded, so its record goes (kept, it would surface at some later unrelated reconnect)
    unanswered = null
    rebaseApplied(JSON.parse(sent) as Model)
    validation.value = null
    // 保存落地后，草稿定下来之前的「撤销」都过时了：撤回去会改掉刚保存的东西；保存途中又改的那几处，撤销照样管用，留着
    // Once a save lands, undos raised before it was sent are stale: undoing would change what was just saved; those for edits made during the save still apply and stay
    dismissUndoable(sentAt)
    await load({ quiet: true, keepDraft: true, sent })
    // 保存途中又改了的：说一句那几处还没保存，不让「已生效」盖过它们 / Edits made during the save: say they are not saved yet, so 已生效 does not cover them
    const later = changeCount.value ? ` · 之后改的 ${changeCount.value} 处还没保存` : jsonEdited.value ? ' · JSON 里之后改的还没保存' : ''
    finishStage('done', `${applyResultState(result) === 'pending' ? pendingText : `已生效 · 版本 #${result.version_id}`}${later}`)
    // 从提示条按的「重试应用」没有保存条报结果：成功了说一句，不让提示条悄悄消失 / 重试应用 from the notice has no save bar to report: say it worked instead of the notice just vanishing
    if (from === 'apply' && applyResultState(result) === 'applied') useToast().success(`版本 #${result.version_id} 已生效`)
    // 保存途中离开了配置页：没有保存条报结果，用提示说；退出登录时放下了这份草稿就不说（确认框说过「不再告诉你结果」）
    // Left the config page mid-save: no save bar reports it, so a toast does; not after sign-out let the draft go (the confirm said no result would follow)
    else if (!viewing && !abandoned) useToast().success(applyResultState(result) === 'pending' ? pendingText : `版本 #${result.version_id} 已生效`)
    announceWritten()
  } catch (error) {
    // 会话过期：页面会回到登录页，这里不挂「没通过校验」 / Session expired: the page goes back to the login page; no 没有通过校验 here
    if (error instanceof ApiError && error.status === 401) { finishStage('idle'); return }
    // 说「别处改过了」之前先看一眼：面板上现在的配置就是这次要存的（上一次写进去了、只是回应丢了），那就是已经保存过了，不是冲突
    // Before calling it a conflict, look once: if the panel already holds exactly what this save sends (an earlier write landed and only its answer
    // was lost), it is already saved, not a conflict
    if (isConflict(error) && await alreadySaved(content, sent)) return
    // 撞上的「别处」其实是自己回应丢了的那次保存：把对照的那份换成它，再接着存这次多改的 / The 别处 met is this page's own save whose answer was lost: rebase onto it and go on saving what changed since
    // 保存途中连上、后台的核对先一步认出了那次保存（文件散列已经换成它）：同样接着存 / Reconnected mid-save and the background check got there first (the file hash already moved to it): carry on saving all the same
    if (isConflict(error) && (await settleUnanswered(false) || settledCount !== settledBefore)) { finishStage('idle'); return save(from) }
    const reason = friendlyRuntimeError(error)
    const stopped = stoppedError(error)
    const down = isPanelDown(error)
    if (down && step === 'applying') unanswered = { content, sent, generation: draftGeneration(), sentAt }
    // 写进文件以后 KixDNS 没接受：版本已经存下了，只是没生效 / KixDNS refused after the write: the version is stored, it just did not take
    const writtenNotApplied = step === 'applying' && error instanceof ApiError && ['reload_failed', 'kixdns_rejected'].includes(error.code)
    // 写进去了（只是没生效）：和保存落地一样，草稿定下来之前的「撤销」过时了 / Written (just not applied): as when a save lands, undos from before the draft was fixed are stale
    if (writtenNotApplied) dismissUndoable(sentAt)
    verdict.value = stopped ? 'KixDNS 已停止' : down ? '连不上面板' : writtenNotApplied ? '保存了，没有生效' : step === 'validating' ? '没有通过校验' : '没有保存成功'
    conflict.value = isConflict(error)
    finishStage('failed', conflict.value ? '这份配置在别处改过了，现在的草稿是基于旧版本的' : stopped ? STOPPED_NOTE : down ? '草稿还在，连上后再保存' : writtenNotApplied ? failureCause(reason) : reason)
    // 校验这一步没写入任何东西：只刷新运行状态，草稿和失败的说法都留着；写入以后失败才重读文件（草稿照样留着）
    // Nothing was written at the validation step: refresh the runtime only, keeping the draft and the verdict; only a failure after writing re-reads the file (the draft still stays)
    if (step === 'validating' || stopped) await refreshRuntime().catch(() => undefined)
    else if (shouldRefreshAfterSaveError(error)) await load({ quiet: true, keepDraft: true })
    // 写进去了却没生效、草稿也没有别的修改：这件事交给页面上方的提示条（那里有「重试应用」），保存条退下，不再给第二个重试
    // Written but not applied and nothing else in the draft: the notice above owns it (with 重试应用); the save bar steps aside instead of offering a second retry
    if (writtenNotApplied && changeCount.value === 0 && from === 'draft') finishStage('idle')
    if (from === 'apply' && !hasApplyFailure.value) {
      applyError.value = stopped ? 'KixDNS 已停止\n启动后自动应用待应用的版本' : `${step === 'validating' ? '磁盘上的配置没有通过校验' : '没有应用成功'}\n${reason}`
      applyFailedDown = down
      // 按完「现在应用」就离开了：配置页的提示条看不见，用提示说 / Left right after 现在应用: the config page's notice is out of sight, so a toast says it
      // 一个开头：「版本 #N 没有应用：」，后面是原因 / One opening, 版本 #N 没有应用：, then the cause
      const which = pendingVersionId.value ? `版本 #${pendingVersionId.value} ` : '配置'
      if (!viewing) useToast().error(stopped ? 'KixDNS 已停止：待应用的版本启动后自动应用' : step === 'validating' ? `${which}没有应用：磁盘上的配置没有通过校验。${reason}` : down ? `${which}没有应用：连不上面板。连上后回配\u2060置\u2060页再应用` : `${which}没有应用：${sentence(reason)}`)
    }
    // 已经挂着「没有生效」时按的「重试应用」：提示条的话和刚才一样，所以另说一句这次重试的结果，不让它悄无声息
    // 重试应用 pressed while 没有生效 already shows: the notice reads as before, so this retry's outcome is said separately instead of passing silently
    // 撞上冲突时提示条已经换成「重新读取」并写明原因，不再另弹一条说同一句 / On a conflict the notice already offers 重新读取 with the reason, so no toast repeats it
    else if (from === 'apply') { if (!conflict.value) retryToast = useToast().error(writtenNotApplied ? `重试也没有生效：${failureCause(reason)}` : step === 'validating' ? `重试没有通过校验：${reason}` : `重试没有成功：${reason}`) }
    else if (!viewing && !abandoned) {
      // 动词跟着实际发生了什么走（和保存条的判定一样），不跟着停在哪一步；内核的原话放最后
      // The verb follows what actually happened (as the save bar's verdict does), not the step it stopped at; the kernel's own words go last
      if (!writtenNotApplied) keepDraftForReturn()
      dismissAwayToast()
      const kept = '草稿留在配\u2060置\u2060页'
      awayToast = useToast().error(writtenNotApplied ? `${pendingVersionId.value ? `版本 #${pendingVersionId.value} ` : '配置'}保存了，没有生效：${sentence(failureCause(reason))}。回到配\u2060置\u2060页可以重试应用`
        : conflict.value ? `配置没有保存：这份配置在别处改\u2060过\u2060了。${kept}，回去重新读取后再改`
          : stopped ? `配置没有保存：KixDNS 已停止。${kept}，可以先存成待应用版本`
            : down && step === 'applying' ? `不知道配置存上没有：连不上面板。${kept}，连上后会自己核对`
              : down ? `配置没有保存：连不上面板。${kept}，连上后再保存`
                : step === 'validating' ? `配置没有保存：没有通过校验。${kept}。${reason}` : `配置没有保存：${sentence(reason)}。${kept}`)
    }
  } finally {
    inFlight = null
    abandoned = false
  }
}
export const applyNow = () => void save('apply')
// 键排好序再比，存进去和读出来的键顺序不同也算一样 / Compared with keys sorted, so a different key order on the way back still counts as the same
const canonical = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item))
async function alreadySaved(content: unknown, sent: string): Promise<boolean> {
  const current = await apiRequest<ConfigDocument>('/api/v1/config').catch(() => null)
  if (!current || canonical(current.content) !== canonical(content)) return false
  rebaseApplied(JSON.parse(sent) as Model)
  validation.value = null
  await load({ quiet: true, keepDraft: true, sent })
  finishStage('done', current.version_id ? `已经保存过了 · 版本 #${current.version_id}` : '已经保存过了')
  return true
}
/**
 * 回应丢了的那次保存其实写进去了：对照的那份换成它，之后又改的照样算修改；announce 时保存条说「已经保存过了」。
 * 读不到面板就留着下次再比；草稿整份换过（放弃、重新读取、导入）就不再比
 * The save whose answer was lost did land: the baseline becomes it and later edits still count as edits; with announce the save bar says 已经保存过了.
 * When the panel cannot be read it is kept for next time; once the draft was replaced wholesale (discard, reload, import) it is dropped
 */
// 同一时刻只核对一次：连上时后台在核对，人这时按了保存、撞上冲突，就等那次核对的结果，不另起一次（记录已经被它取走，另起一次会说成「别处改过了」）
// One check at a time: if the reconnect is checking in the background when a save meets a conflict, the save waits for that check instead of starting another
// (the record has already been taken by it, so a second check would call it 别处改过了)
let settling: Promise<boolean> | null = null
// 「现在应用」因为连不上面板没成功：连上以后那条提示就不对了 / 现在应用 failed because the panel was unreachable: once back, that notice is stale
let applyFailedDown = false
let settledCount = 0
// 核对成功过几次：保存发出去以后才核对完的，撞上的冲突就是那次核对已经认出来的自己的保存 / How many checks have succeeded: one finishing after a save was sent means the conflict it meets is one's own save, already recognised
function settleUnanswered(announce: boolean): Promise<boolean> {
  if (settling) return settling
  if (!unanswered) return Promise.resolve(false)
  settling = settleOnce(announce).finally(() => { settling = null })
  return settling
}
async function settleOnce(announce: boolean): Promise<boolean> {
  const lost = unanswered
  if (!lost) return false
  const current = await apiRequest<ConfigDocument>('/api/v1/config').catch(() => null)
  if (!current) return false
  unanswered = null
  // 草稿整份换过（放弃又撤销、导入）也照样比：面板上的文件和对照的那份跟草稿是怎么来的无关；只有「已经保存过了」这句要草稿还是那一份
  // Compared even after the draft was replaced wholesale (discard then undo, an import): the file on the panel and the baseline do not depend on how the
  // draft came about; only the 已经保存过了 line needs the draft to be the same one
  const sameDraft = lost.generation === draftGeneration()
  if (canonical(current.content) !== canonical(lost.content)) {
    // 面板上的文件还是草稿的底子：那次保存没有存上。文件变了又不是自己那次：别处改过了（可能是存上以后又被改掉），按冲突处理，
    // 免得回去一按保存就悄悄盖掉别处的版本
    // The file on the panel is still the draft's base: the save did not land. The file changed and is not one's own save: it was changed elsewhere
    // (perhaps after it landed), so it is handled as a conflict, or saving on return would silently overwrite the other version
    const changedElsewhere = Boolean(doc.value) && current.sha256 !== doc.value!.sha256
    if (changedElsewhere) {
      conflict.value = true
      // 那次保存可能存上过、又被别处盖掉：不说「没有保存」，只说它不在现在的配置里 / The save may have landed and then been overwritten: say it is not in the current config, not that it was never saved
      verdict.value = '刚才那次保存不在现在的配置里'
      finishStage('failed', '这份配置在别处改过了，现在的草稿是基于旧版本的')
    }
    // 在配置页上、那次保存就是没存上：保存条接着说「校验通过」，另说一句没存上 / On the config page with the save simply not landed: the bar goes on to 校验通过, so say it did not land
    if (viewing && announce && !changedElsewhere) useToast().info('刚才那次保存没有存上，可以再保存')
    // 不在配置页时，「不知道存上没有」那条提示换成核对的结果 / Away from the config page, the 不知道存上没有 toast is replaced by the result
    if (!viewing && awayToast !== null) {
      dismissAwayToast()
      awayToast = useToast().error(changedElsewhere ? '刚才那次保存不在现在的配置里：这份配置在别处改\u2060过\u2060了。草稿留在配\u2060置\u2060页，回去重新读取后再改' : '刚才那次保存没有存上。草稿留在配\u2060置\u2060页，回去再保存')
    }
    return false
  }
  settledCount += 1
  rebaseApplied(JSON.parse(lost.sent) as Model)
  validation.value = null
  // 和保存落地一样：发出去之前的「撤销」过时了 / As when a save lands: undos raised before it was sent are stale
  dismissUndoable(lost.sentAt)
  await load({ quiet: true, keepDraft: true, sent: lost.sent })
  announceWritten()
  const version = current.version_id ? `版本 #${current.version_id}` : ''
  if (announce && sameDraft) {
    const later = changeCount.value ? ` · 之后改的 ${changeCount.value} 处还没保存` : ''
    finishStage('done', `${version ? `已经保存过了 · ${version}` : '已经保存过了'}${later}`)
  }
  // 不在配置页，或者在页上但草稿已经整份换过（保存条说不了「已经保存过了」）：用提示说 / Away from the page, or on it with the draft replaced wholesale (the bar cannot say 已经保存过了): a toast says it
  if (!viewing || (announce && !sameDraft)) {
    dismissAwayToast()
    // 说出它现在生效了没有（核对时已经读过一遍运行状态） / Say whether it is in effect now (the runtime was just read during the check)
    if (hasApplyFailure.value) useToast().error(`刚才那次保存已经存上了：${version ? `${version} ` : ''}没有生效，回到配\u2060置\u2060页可以重试应用`)
    else if (hasPending.value) useToast().success(`刚才那次保存已经存上了：${version ? `${version} 待应用，` : ''}${pendingWhen()}自\u2060动\u2060应\u2060用`)
    else useToast().success(version ? `刚才那次保存已经存上了：${version} 已生效` : '刚才那次保存已经存上了')
    // 草稿里没有别的修改了：不用再留着、也不用拦着刷新 / Nothing else is unsaved in the draft: no need to keep it or to guard reloads
    if (!unsaved.value) dropKeptDraft()
  }
  return true
}
// 「重试应用」撞上冲突时的提示：重新读取以后它说的就过时了 / The toast from a 重试应用 that met a conflict: stale once the config is re-read
let retryToast: number | null = null
/**
 * 重新连上面板以后：「连不上面板」那句已经不对了，收起；没读到配置的整页重读；有没保存的修改时只刷新运行状态（草稿和文件散列不动，
 * 别处的改动照样在保存时发现），没有就整份重读
 * Back in touch with the panel: the 连不上面板 verdict is stale and goes; a page that never read the config reads it; with unsaved edits only the
 * runtime is refreshed (the draft and the file hash stay, so changes made elsewhere still surface at save), otherwise the whole document is re-read
 */
export async function panelBack(): Promise<void> {
  // 「连不上面板」那句等回应丢了的那次保存核对完再撤：先撤的话，中间会闪一下「校验通过 · 可以保存」（上次校验的结果），再变成「已经保存过了」
  // The 连不上面板 verdict goes only after a lost save has been checked: clearing it first flashed 「校验通过 · 可以保存」 (the last validation) before 已经保存过了
  const clearStale = () => { if (stage.value === 'failed' && verdict.value === '连不上面板') finishStage('idle') }
  // 不在配置页时也做：离开期间连上的，回来时保存条不再说「连不上面板」，回应丢了的那次保存照样核对；配置页从没打开过就什么都不读
  // Done away from the config page too: after a reconnect while away the save bar no longer says 连不上面板 on return, and a lost save is still checked;
  // nothing is read when the config page was never opened
  if ((!viewing && !doc.value) || busy.value) { clearStale(); return }
  if (!doc.value) { clearStale(); await load(); return }
  const settled = await settleUnanswered(true)
  clearStale()
  if (applyFailedDown) { applyError.value = ''; applyFailedDown = false }
  if (settled) return
  if (unsaved.value || conflict.value) {
    // 有没保存的修改时不重读文件，但运行状态读到了：因为连不上而挂着的「读取配置失败」收起 / With unsaved edits the file is not re-read, but the runtime did read: a 读取配置失败 left by the outage goes
    const refreshed = await refreshRuntime().then(() => true, () => false)
    if (refreshed && loadFailedDown) { loadError.value = ''; loadFailedDown = false }
  } else await load({ quiet: true })
}
// 连上面板后自己接着做（配置页开着没有都一样），不等人点重试 / Once the panel answers again, carry on by itself (whether or not the config page is open) instead of waiting for 重试
watch(panelDown, (now, before) => { if (before && !now) void panelBack() })
/** 待应用的版本什么时候自动应用：说出等的是什么 / When a pending version applies by itself: name what it waits for */
export function pendingWhen(): string {
  if (runtimeStopped.value) return 'KixDNS 启动后'
  if (runtimeUnavailable.value) return '连上 KixDNS 后'
  return 'KixDNS 就绪后'
}

// ---------- 历史版本 / history ----------
export const restoring = ref<number | null>(null)
export const deleting = ref<number | null>(null)
export const bulkDeleting = ref(false)
// 版本的完整内容（比较用） / A version's full content (for comparing)
export const versionDetail = (id: number) => apiRequest<ConfigVersionDetail>(`/api/v1/config/versions/${id}`)
// 恢复：用那个版本的内容生成一个新版本并应用；回来重读整页 / Restore: a new version from that content, applied; the page reloads after
export async function restoreVersion(id: number): Promise<{ state: 'applied' | 'pending'; versionId: number }> {
  if (!doc.value) throw new Error('配置还没读进来')
  restoring.value = id
  try {
    const result = await apiRequest<ConfigApplyResult>(`/api/v1/config/versions/${id}/restore`, { method: 'POST', ...jsonBody({ expected_sha256: doc.value.sha256 }) })
    await load({ quiet: true })
    return { state: applyResultState(result), versionId: result.version_id }
  } finally {
    restoring.value = null
  }
}
async function refreshVersions(removesDesired: boolean): Promise<void> {
  if (removesDesired) { await load({ quiet: true, keepDraft: true }); return }
  versions.value = (await apiRequest<ConfigVersions>('/api/v1/config/versions')).versions
}
const desired = (v: ConfigVersion) => v.id === pendingVersionId.value || v.apply_state === 'pending' || v.apply_state === 'failed'
export async function deleteVersion(v: ConfigVersion): Promise<void> {
  if (!doc.value) return
  deleting.value = v.id
  try {
    await apiRequest<DeleteConfigVersionResult>(`/api/v1/config/versions/${v.id}`, { method: 'DELETE', ...jsonBody({ expected_sha256: doc.value.sha256 }) })
    await refreshVersions(desired(v))
  } finally {
    deleting.value = null
  }
}
export async function deleteVersions(ids: number[]): Promise<number> {
  if (!doc.value) return 0
  bulkDeleting.value = true
  try {
    const result = await apiRequest<DeleteConfigVersionsResult>('/api/v1/config/versions/bulk', { method: 'DELETE', ...jsonBody({ ids, expected_sha256: doc.value.sha256 }) })
    await refreshVersions(versions.value.some((v) => ids.includes(v.id) && desired(v)))
    return result.deleted_ids.length
  } finally {
    bulkDeleting.value = false
  }
}
export { friendlyRuntimeError }
