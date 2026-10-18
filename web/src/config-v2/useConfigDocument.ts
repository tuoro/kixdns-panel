import { computed, ref, watch } from 'vue'
import { ApiError, CONFIG_WRITTEN_EVENT, apiRequest, isPanelDown, jsonBody } from '../api/client'
import { useConfirm } from '../composables/useConfirm'
import { registerHeldDraft } from '../composables/useLeaveGuard'
import type { ConfigApplyResult, ConfigDocument, ConfigRuntimeApplyState, ConfigVersion, ConfigVersionDetail, ConfigVersions, DeleteConfigVersionResult, DeleteConfigVersionsResult, Overview, ServiceStatus, ValidationResult } from '../api/types'
import { normalUrl } from '../config-model/blocklist'
import { exportConfig, readConfig } from '../config-model/document'
import { blocklistKey, type Model, type Rule } from '../config-model/model'
import { traceNames } from '../config-model/trace-names'
import { useConnection } from '../composables/useConnection'
import { useSession } from '../composables/useSession'
import { dismissUndoable, toastMark, useToast } from '../composables/useToast'
import { errorMessage } from '../utils'
import { dismissBuildToast, needsBuild, sayDrafted, settleBlocklists, type BuildProblem } from './useBlocklists'
import { appliedModel, appliedSnapshot, changesBesidesFile, replaceOnLeave, findRuleByName, applyHits, applyUpstreamStats, changeCount, dialogEdits, dirty, draftGeneration, editorEdited, importReport, importSource, jsonEdited, loadContent, model, rebaseApplied, replaceModel, reportOpen, unsaved } from './store'

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
// 「KixDNS 已停止」那条提示在它又跑起来以后就过时了 / The 「KixDNS 已停止」 notice is stale once it runs again
watch(runtimeStopped, (now, was) => { if (was && !now && applyError.value.startsWith('KixDNS 已停止')) applyError.value = '' })
// 待应用的版本后来生效了（后台每 5 秒那次、或者别的页面），或者换成了别处存的另一个：「版本 #N …没有应用」那条提示就过时了
// The pending version took effect later (the background pass, another page), or another writer's version replaced it: the 「版本 #N …没有应用」 notice is stale
watch(() => doc.value?.pending?.version_id ?? null, (now, was) => { if (was !== null && now !== was && !hasApplyFailure.value) { applyError.value = ''; applyFailedDown = false } })
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
// 回答写成域名的是哪几条规则（规则自己的回答、回答后检查的自定义回答，规则组里的也算）：在写出的配置里找，再认回草稿里的规则。
// 规则自带的转发 Pipeline（rule-编号）按编号认，不管规则起没起名字；一条规则拆成几条（name#N）只算一次；域名映射另外数（有「去域名映射」）；
// 认不回来的（高级规则里别的、后台刷新规则）照样算一处。提示条的「有 N 处」和下面点名的对得上
// Which rules answer with a domain (a rule's own answer, a post-reply check's custom answer, rule groups included): found in the export and traced back to the
// draft's rules. A rule's own forward pipeline (rule-<id>) is traced by its id whether or not the rule is named; a rule split into several (name#N) counts once;
// mappings are counted apart (they have 去域名映射); anything that does not trace back (other raw rules, the background-refresh rule) still counts as one place.
// So the notice's 「有 N 处」 matches what it names below
export const cnameUse = computed((): { rules: Rule[]; untraced: number } => {
  if (!cnameInUse.value) return { rules: [], untraced: 0 }
  const content = exportConfig(model) as Record<string, unknown>
  const pipelines = Array.isArray(content.pipelines) ? content.pipelines : []
  const mappingPipeline = model.mappingId ?? 'domain_mapping'
  const everyRule = [...model.rules, ...model.ruleGroups.flatMap((g) => g.rules)]
  const found = new Map<number, Rule>()
  let untraced = ruleUsesAction(content.background_refresh_rule, 'static_cname_response') ? 1 : 0
  for (const pipeline of pipelines) {
    if (!isRecord(pipeline) || pipeline.id === mappingPipeline) continue
    const own = typeof pipeline.id === 'string' ? /^rule-(\d+)$/.exec(pipeline.id)?.[1] : undefined
    const owner = own === undefined ? undefined : everyRule.find((r) => r.id === Number(own))
    const rules = Array.isArray(pipeline.rules) ? pipeline.rules : []
    for (const kernelRule of rules) {
      if (!ruleUsesAction(kernelRule, 'static_cname_response') || !isRecord(kernelRule)) continue
      // 拆开的几条叫 name#N，合回一条 / Split parts are named name#N and fold back into one
      const rule = owner ?? (typeof kernelRule.name === 'string' ? findRuleByName(kernelRule.name.replace(/#\d+$/, '')) : undefined)
      if (rule) found.set(rule.id, rule)
      else untraced += 1
    }
  }
  return { rules: [...found.values()], untraced }
})
// 内核报了自己支持什么、草稿里却有它不支持的 CNAME 回答：服务端不收这份配置，所以先不让保存
// The kernel reported what it supports and the draft has CNAME answers it lacks: the server refuses the config, so saving waits
export const cnameBlocked = computed(() => !runtimeStopped.value && !runtimeUnavailable.value && !capabilityError.value && !canCname.value && cnameInUse.value)
// KixDNS 没启动、连不上、没报能力时，保存只存成待应用版本 / Saving only stores a pending version when KixDNS is down, unreachable or silent about capabilities
export const deferSave = computed(() => runtimeStopped.value || runtimeUnavailable.value || Boolean(capabilityError.value))
export const fileDiffers = computed(() => !hasPending.value && !hasApplyFailure.value && doc.value?.runtime.status === 'different')
// 草稿里有内核不支持的 CNAME 回答时，现在应用 / 重试应用也只会被拒：不给这两个按钮 / With CNAME answers the kernel does not support in the draft, 现在应用 and 重试应用 would only be refused: neither is offered
// 被挡住时按一下说一句，只留一条；CNAME 都改掉了就收起 / A press while blocked says so, one copy only, cleared once no CNAME answer blocks any more
let blockedToast: number | null = null
export function sayBlocked(): void {
  blockedToast = useToast().info('当前内核不支持 CNAME 回答，先改成 IP 再保存')
}
watch(cnameBlocked, (blocked) => { if (!blocked && blockedToast !== null) { useToast().dismiss(blockedToast); blockedToast = null } })
export const canApplyNow = computed(() => (hasPending.value || hasApplyFailure.value || fileDiffers.value) && !deferSave.value && !cnameBlocked.value)
export const canSave = computed(() => (dirty.value || canApplyNow.value) && !cnameBlocked.value)

// ---------- 保存的几步 / the save's stages ----------
// building：保存的第 0 步，等拦截列表按这份草稿的订阅合成好 / building: a save's step 0, waiting for the blocklists to be built for this draft's subscriptions
export type SaveStage = 'idle' | 'building' | 'checking' | 'validating' | 'applying' | 'done' | 'failed'
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
export const busy = computed(() => ['building', 'checking', 'validating', 'applying'].includes(stage.value))
// 单独的「校验」还没回来时按了保存：这一下排在校验后面，从按下起就算一次保存 / Save pressed while a lone 校验 is out: it waits behind the check and counts as a save from the press
export const queued = ref(false)
// 真的在保存（校验、写入，或者排在单独的「校验」后面），不是单独点的「校验」：这时换掉草稿的操作要等它做完
// A save really running (validate, then write, or queued behind a lone 校验), not a lone 校验: actions that replace the draft wait for it
// 保存的第 0 步或校验之前在等拦截列表合成：保存条照实写在等什么 / A save's step 0 or a check is waiting for the blocklists' build: the save bar says what it waits for
export const waitingForBuild = ref(false)
export const saveInFlight = computed(() => queued.value || stage.value === 'building' || stage.value === 'validating' || stage.value === 'applying')
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
// 草稿整份换过（放弃、撤销放弃、导入、离开时放弃、退出时放下）也算：上一份草稿的结论过时了，哪怕只差一份合成的文件。放在这里而不是保存条里：
// 离开时放弃那会儿保存条正在卸下，回来时不能还挂着旧的失败。同步跑：换完紧接着说的新结论不会被它冲掉
// A wholesale replacement (a discard, its undo, an import, a discard on leaving, a draft let go at sign-out) counts too: the previous draft's verdict is
// stale, even when only a built file differed. It lives here rather than in the save bar: during a discard on leaving the bar is unmounting, and the
// old failure must not greet the return. It runs synchronously, so a verdict set right after a replacement is not wiped by it
watch(draftGeneration, () => editTouched(), { flush: 'sync' })

// ---------- 页头 / header ----------
// wide：宽屏「状态」标签下面写的（缺省是 lead，再缺省是整句）；手机上没有标签，写 lead 和整句
// wide: what sits under the 状态 label on wide screens (lead by default, else the whole line); phones have no label and show lead plus the line
export interface HeaderStatus { tone: 'ok' | 'warn' | 'err' | 'off'; lead?: string; before: string; version?: number; after?: string; wide?: string[] }
export const headerStatus = computed<HeaderStatus>(() => {
  // 应用失败、KixDNS 又停着：先说停了，旁边的「启动」读作启动 KixDNS，不是启动那份失败的配置 / Failed and KixDNS stopped: the stop comes first, so 启动 beside it reads as starting KixDNS, not the failed config
  if (hasApplyFailure.value) return runtimeStopped.value ? { tone: 'off', lead: 'KixDNS 已停止', before: '应用失败', wide: ['已停止', '应用失败'] } : { tone: 'err', before: '配置应用失败' }
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
  // 恢复、重新读取、删除版本、保存还在收尾时也不给：别的操作都在等它们，按了只会撞上它们，或者什么都不发生（保存途中按下会被吞掉）；冲突时先重新读取
  // Nor during a restore, a re-read, a version delete or a save still finishing: everything else waits for those, and a press would collide with them or do
  // nothing at all (a press during a save is swallowed); in a conflict, re-read first
  if (!canApplyNow.value || unsaved.value || hasApplyFailure.value || panelDown.value || conflict.value || busy.value || rereading.value || deleting.value !== null || bulkDeleting.value) return ''
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
  return `KixDNS\u00a0的原话：${message.replace(/"([\w.-]+)"/g, (whole, id: string) => { const name = names.pipeline(id); return name ? `${whole}（${name}）` : whole })}`
}
const friendlyRuntimeError = (error: unknown) => friendlyRuntimeMessage(errorMessage(error))
/** 没生效的原因本身：去掉句尾「仍在用之前的配置」，给已经说了这件事的提示条用 / Just why it did not take, without the trailing 仍在用之前的配置, for a notice that already says so */
// 版本没生效是因为 KixDNS 在确认新配置之前停了：这个版本已经记成没有生效，不会等它启动再自己应用，不能说成「启动后再应用」
// A version that did not take because KixDNS stopped before confirming the new config: it is recorded as not taken and will not apply by itself on start, so
// it must not read 启动后再应用
export const failureCause = (message: string): string => (STOPPED.test(message) ? 'KixDNS 在确认新配置前停了' : friendlyRuntimeMessage(message)).replace(/[，,]\s*仍在用之前的配置。?$/, '')
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
// 草稿有没保存的修改，面板上的文件却在别处换了：马上说出来（下载草稿 / 重新读取），不等保存撞上才知道；草稿、对照的那份和文件散列都不动
// The draft has unsaved edits but the file on the panel was changed elsewhere: say so now (下载草稿 / 重新读取) instead of waiting for a save to hit it;
// the draft, the baseline and the file hash all stay
function enterStaleBase(): void {
  origin.value = 'draft'
  conflict.value = true
  verdict.value = '这份配置在别处改过了'
  // 后面紧跟着「下载草稿」「重新读取」两个链接：说明不再复述它们 / The 下载草稿 and 重新读取 links follow right after: the note does not restate them
  finishStage('failed', '现在的草稿是基于旧版本的')
}
export async function refreshRuntime(): Promise<void> {
  const writesAtStart = writeCount
  const [nextDoc, overview, service] = await Promise.all([
    apiRequest<ConfigDocument>('/api/v1/config'),
    apiRequest<Overview>('/api/v1/overview').catch(overviewFailed),
    apiRequest<ServiceStatus>('/api/v1/service').catch(() => null),
  ])
  applyRuntime(nextDoc, overview, service)
  // 只刷新运行状态的时候（有修改时连上、启动 KixDNS）也看一眼文件：别处换过了就和静默重读一样马上说
  // A runtime-only refresh (a reconnect or 启动 KixDNS with edits) still looks at the file: changed elsewhere, it says so at once, as the quiet re-read does
  // 读的时候这一页写过（保存、应用、恢复）或者正在写：读到的是写之前的样子，只当没读 / This page wrote (or is writing) while it read: what came back predates the write, so it is dropped
  if (writeCount !== writesAtStart || busy.value || restoring.value !== null || deleting.value !== null || bulkDeleting.value) return
  const moved = doc.value !== null && nextDoc.sha256 !== doc.value.sha256
  // 待应用的版本生效了、失败了或换了：历史里的标签跟着变（只刷新运行状态时以前不重读历史，失败的版本还挂着「待应用」）
  // The pending version applied, failed or changed: the history tags follow (a runtime-only refresh used not to re-read the history, leaving 待应用 on a failed version)
  const pendingMoved = doc.value !== null && (doc.value.pending?.version_id !== nextDoc.pending?.version_id || Boolean(doc.value.pending?.error) !== Boolean(nextDoc.pending?.error))
  if (doc.value) doc.value = { ...doc.value, runtime: nextDoc.runtime, pending: nextDoc.pending }
  if (pendingMoved) {
    const list = (await apiRequest<ConfigVersions>('/api/v1/config/versions').catch(() => ({ versions: versions.value }))).versions
    // 读列表的时候这一页写过：写的那一方已经记下了新列表，不拿旧的盖掉 / This page wrote while the list was read: the write already recorded the newer list, so the old one does not overwrite it
    if (writeCount === writesAtStart) versions.value = list
  }
  if (moved && unsaved.value && !busy.value && !conflict.value) enterStaleBase()
  applyHits(overview?.metrics?.rules ?? [])
  applyUpstreamStats(overview?.metrics?.upstreams ?? [], overview?.metrics?.recent_window_seconds ?? null)
}

let pendingLoad: Promise<void> | null = null
// 排在路上那次读后面的「要显示读取中」的读（重新读取）：前一次读完时不把「读取中」撤掉 / Loud reads (重新读取) queued behind the read in flight: when that read ends, 读取中 stays up
let loudWaiting = 0
// 上一次读取失败是不是因为连不上面板：连上后运行状态读得到，这条失败就过时了 / Whether the last read failed because the panel was unreachable: once the runtime reads again, that failure is stale
let loadFailedDown = false
// quiet：保存之后的刷新不换成骨架 / quiet: the refresh after a save keeps the page mounted
// keepDraft：草稿里有没保存的修改（保存途中又改的、右侧规则没点完成的、删版本时草稿里的）就留着草稿，只把对照的那份换成读到的文件；
// sent 是保存时发出去的草稿，读回来和它一样、又没有别的没保存的修改时照常整份换上（换成文件里的写法）
// keepDraft: with unsaved edits in the draft (made during a save, an unfinished panel edit, the draft while a version is deleted) the draft stays and only
// the baseline becomes the file just read; sent is the draft a save sent, and when nothing changed since and nothing else is unsaved the file replaces it as usual
// fresh：调用的人要整份换上读到的文件（恢复版本：确认时已经说了没保存的修改会丢），不走「保留这边的修改」
// fresh: the caller replaces the draft with the file read, whatever was edited (a restore: its confirm said unsaved edits would be lost), never the keep-edits path
// own：文件是这一页自己挪的（写进去了却没生效、删了待应用的版本），留着的草稿换到新文件上；没有 own 时文件变了就是别处改的，进冲突状态
// own: this page moved the file itself (written but not taken, a pending version deleted), so a kept draft moves onto the new file; without own a changed
// file was changed elsewhere and the conflict state follows
// returning: 回到配置页时的那次读：读的途中开始了一次保存（立即更新落地后直接存），读到的就不拿来换草稿
// returning: the read on coming back to the config page: when a save began while it was out (立即更新 landing and saving at once), what it read does not
// replace the draft
export function load(options: { quiet?: boolean; keepDraft?: boolean; sent?: string; fresh?: boolean; own?: boolean; returning?: boolean } = {}): Promise<void> {
  // 已经有一次读在路上：只有同样静默的读才等它就算数；保存（sent）、要保留草稿的、要整份换上的（恢复版本）和「重新读取」都得看到之后的文件——
  // 那次读是之前发的，等它回来再读一次（以前恢复版本拿到的是之前那次读，页面停在恢复前的文件上，提示却说恢复好了）
  // A read is already out: only another plain quiet read counts it as its own; a save's read (sent), a keep-draft read, a fresh read (a restore) and 重新读取
  // must see the file as it is after them — that read left earlier, so wait for it and read again (a restore used to get the earlier read: the page stayed on
  // the pre-restore file while the toast said it was restored)
  if (pendingLoad) {
    if (options.sent === undefined && !options.keepDraft && !options.fresh && options.quiet) return pendingLoad
    if (!options.quiet) { loudWaiting += 1; loading.value = true }
    return pendingLoad.catch(() => undefined).then(() => { if (!options.quiet) loudWaiting -= 1; return load(options) })
  }
  if (!options.quiet) loading.value = true
  const unsavedAtStart = unsaved.value
  // 读之前草稿里已经有一份没存上的合成文件（立即更新没存上）：「重新读取」问过要丢掉，会话结束时说过没留下 / Before the read the draft already held a built
  // file not saved (立即更新 that did not save): 重新读取 asked to drop it, and a session end said it was not kept
  const fileUnsavedAtStart = model.blocklists.file !== appliedModel.value.blocklists.file
  // 发出时文件的散列：读回来之前有一次写（保存落地）把它挪了，这次读到的就是旧的，不拿它盖掉 / The file hash when sent: if a write (a landed save) moved it before this read returns, what was read is stale and must not overwrite it
  const shaAtStart = doc.value?.sha256
  const writesAtStart = writeCount
  const savesAtStart = saveStarts
  pendingLoad = (async () => {
    const [nextDoc, history, overview, service] = await Promise.all([
      apiRequest<ConfigDocument>('/api/v1/config'),
      apiRequest<ConfigVersions>('/api/v1/config/versions'),
      apiRequest<Overview>('/api/v1/overview').catch(overviewFailed),
      apiRequest<ServiceStatus>('/api/v1/service').catch(() => null),
    ])
    // 读的时候文件已经被这边的一次写挪过了：读到的是旧文件，只当没读（写的那一方会自己再读） / The file was moved by a write from this page while reading: what came back is stale, so it is dropped (the writer reads again itself)
    // 原地生效不挪散列：再按写的次数看一眼 / An in-place apply does not move the hash, so the write count is checked too
    // 回到配置页的那次读，途中开始了一次保存（立即更新落地后直接保存）也一样：那次保存发出的草稿比读到的新，这次读到的不拿来换草稿。
    // 只管这一种读：恢复版本、重新读取这些自己要换草稿的读，不能因为别的保存开始了就作废（保存在写入前停下时不会再读）
    // Likewise for the read on returning to the config page when a save started meanwhile (立即更新 landing and saving at once): the draft it sent is
    // newer than what was read, so the read does not replace the draft. Only this read: reads meant to replace the draft (a restore, 重新读取) must not be
    // voided by another save starting, since a save that stops before writing reads nothing again
    if (options.sent === undefined && doc.value && ((shaAtStart !== undefined && doc.value.sha256 !== shaAtStart) || writeCount !== writesAtStart || (options.returning && saveStarts !== savesAtStart))) return
    docWrites = writesAtStart
    applyRuntime(nextDoc, overview, service)
    const previous = doc.value
    const previousSha = previous?.sha256
    // 静默重读发出去时草稿还没改、读回来之前这边改了，而面板上的文件又变了：不拿文件把这些修改冲掉，只更新运行状态（和有修改时连上一样）；
    // 下次保存会撞上「别处改过了」，再重新读取
    // The quiet re-read left with no edits, edits were made before it came back, and the file changed on the panel: the edits are not wiped by the file,
    // only the runtime moves (as on a reconnect with edits); the next save meets 别处改过了 and re-reads then
    // 回到留着的草稿（keepDraft、不是自己挪的文件）时文件变了也一样：以前悄悄换到新文件上，下次保存就把别处的改动当成自己的删掉了
    // The same on returning to a held draft (keepDraft, a file this page did not move): it used to rebase silently, and the next save then removed the other
    // writer's change as if it were one's own
    const keepEdits = previous !== null && options.sent === undefined && !options.fresh && nextDoc.sha256 !== previousSha && unsaved.value
      && ((options.quiet === true && !options.keepDraft && !unsavedAtStart) || (options.keepDraft === true && !options.own))
    doc.value = keepEdits ? { ...previous, runtime: nextDoc.runtime, pending: nextDoc.pending } : nextDoc
    versions.value = history.versions
    // 读进草稿：散列对得上就是面板写的那份；对不上（手改过）会重新导入并给报告 / Into the draft: the hash matching means the panel wrote it; otherwise it is re-imported with a report
    // 重新读进来的是另一份草稿：上一份草稿的失败和冲突不再适用 / What is read in is a different draft: the previous draft's failure and conflict no longer apply
    // 整份换上（fresh，恢复版本）也一样：之前那次读刚说的「别处改过了」随草稿一起换掉 / A fresh read (a restore) likewise: a 别处改过了 just raised by the earlier read goes with the draft it was about
    // 「…没有应用」那条提示说的是刚换掉的那份文件，人在页上时保存条报不到的那条结果提示（立即更新不知道存上没有、被别处盖掉）说的是刚换掉的草稿：
    // 读进来的是另一份了，一起收起。不在页上时那条提示由核对它的那条路自己换掉
    // The 「…没有应用」 notice was about the file just replaced, and on the page the outcome toast the save bar cannot speak for (立即更新 not known to have
    // saved, or overwritten elsewhere) was about the draft just replaced: what is read in is another, so they go too. Away from the page that toast is
    // replaced by the path that checks it
    if (!options.quiet || options.fresh) { conflict.value = false; applyError.value = ''; applyFailedDown = false; if (viewing) dismissAwayToast(); if (stage.value === 'failed' || stage.value === 'done') finishStage('idle') }
    // 保存之后（sent）一律只换对照的那份：草稿里的对象不换，开着的抽屉、规则面板拿着的还是同一个对象（以前整份换掉，保存途中打开的上游组抽屉会改到别的组）。
    // 写进文件再读回来和草稿一样（store.test 里有往返测试），所以没再改过时「已修改」归零
    // After a save (sent) only the baseline moves: the draft's objects stay, so an open drawer or rule panel still holds the same object (replacing them
    // made an upstream-group drawer opened during a save write to another group). Writing and reading back equals the draft (round-trip test in store.test), so with no edits since, the count returns to zero
    if (keepEdits) enterStaleBase()
    else if (options.sent !== undefined || (options.keepDraft && unsaved.value)) {
      // 文件没变就什么都不动；变了（保存成功、别处改过）把对照的那份换成它，草稿里的修改照旧算修改
      // File unchanged: nothing moves; changed (a save went through, an edit elsewhere): the baseline becomes it and the draft's edits still count as edits
      if (options.sent !== undefined || nextDoc.sha256 !== previousSha) rebaseApplied(readConfig(nextDoc.content, model).model)
    } else if (options.quiet && nextDoc.sha256 === previousSha) {
      // 文件没变（连上后的静默重读）：不把草稿整份换掉，开着的规则编辑不会自己关上 / The file is unchanged (the quiet re-read after a reconnect): the draft is not replaced, so an open rule editor does not close by itself
    } else if (!options.quiet && !options.fresh && !fileUnsavedAtStart && nextDoc.sha256 === previousSha && changesBesidesFile(appliedModel.value, model) === 0
      && model.blocklists.file !== appliedModel.value.blocklists.file) {
      // 回到配置页、或者点了「重新读取」，读的途中立即更新落地，草稿和面板上的只差这份新合成的文件：面板上的文件没变，读到的那份比草稿旧，不拿它换，
      // 那次立即更新照常存成版本。读之前文件就没存上（立即更新没存上）：「重新读取」问过要丢掉、会话结束时说过没留下，照常换掉
      // Returning to the config page, or 重新读取 pressed, with 立即更新 landing during the read so the draft differs from the panel only by that newly built
      // file: the file on the panel did not change and what was read is older than the draft, so it does not replace it and that 立即更新 is saved as usual.
      // With the file already unsaved before the read (立即更新 that did not save), 重新读取 asked to drop it and a session end said it was not kept, so it
      // is replaced as usual
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
  })().catch((error: unknown) => { loadError.value = errorMessage(error); loadFailedDown = isPanelDown(error) }).finally(() => { loading.value = loudWaiting > 0; pendingLoad = null })
  return pendingLoad
}

// ---------- 校验、保存、应用 / validate, save, apply ----------
// 单独点的「校验」还没回来时按了保存：等它回来再保存，不吞掉这一下 / Save pressed while a lone 校验 is still out: the save waits for it instead of swallowing the press
let checkRun: Promise<ValidationResult | null> | null = null
let checkedContent: string | null = null
// 排着的保存遇上的、单独校验等合成时没成的原因：离开以后的提示按它说 / Why the build a lone check waited on failed, for a save queued behind it: the away toast
// is worded by it
let checkBuildProblem: BuildProblem | null = null
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
  checkBuildProblem = null
  // 校验一份旧的拦截列表文件没有意义：先等它按现在的订阅合成好；没合成好时说的是校验没做成，不是配置没通过
  // Checking a stale blocklist file means nothing: wait for it to be built for the current subscriptions first; when that fails the check did not run,
  // which is not the config failing it
  if (needsBuild()) {
    dismissBuildToast()
    let problem: BuildProblem | null
    waitingForBuild.value = true
    try { problem = await settleBlocklists() } finally { waitingForBuild.value = false }
    // 等的时候先前排着的合成失败了，那条提示也收起：保存条接着说 / A build queued before that failed while waiting: its toast goes too, the save bar takes over
    dismissBuildToast()
    if (problem) {
      // 有保存排在后面：它按的是保存，按保存来说（和第 0 步一样） / A save queued behind: it was a save that was pressed, so it is told as a save (as in step 0)
      const asSave = queued.value
      checkBuildProblem = asSave ? problem : null
      verdict.value = problem.down ? '连不上面板' : asSave ? (problem.changed ? '没有保存' : '没有保存成功') : '没有校验'
      finishStage('failed', buildProblemNote(problem, asSave ? '保存' : '校验'))
      return null
    }
  }
  // 记下校验的是哪一份：排在后面的保存要写的正是这一份时，不再校验第二遍 / Note which content is checked: a save queued behind it that writes exactly this need not check it twice
  const checked = JSON.stringify(exportConfig(model))
  checkedContent = null
  // 校验途中草稿整份换过（重新读取、导入、放弃修改）：结论说的是已经不在的那份，丢掉，不挂到新草稿上
  // The draft was replaced wholesale while checking (重新读取, an import, 放弃修改): the verdict is about a draft that is gone, so it is dropped, not hung on the new one
  const generation = draftGeneration()
  // 校验途中又改了草稿（加了一条、改了一处）也一样：结论说的不是现在这份，丢掉，免得把没校验过的说成「校验通过」
  // An edit made to the draft while checking counts too: the verdict is not about the draft as it is now, so it is dropped rather than calling an unchecked
  // change 校验通过
  // JSON 视图里又打了字（还没收进草稿）也算：校验收进去的是开始那一刻的 JSON / Typing in the JSON view (not yet folded into the draft) counts too: the check folded the JSON as it was at the start
  const stale = () => draftGeneration() !== generation || JSON.stringify(exportConfig(model)) !== checked || jsonEdited.value
  try {
    const result = await apiRequest<ValidationResult>('/api/v1/config/validate', { method: 'POST', body: checked })
    if (stale()) { finishStage('idle'); return null }
    validation.value = result
    checkedContent = checked
    finishStage('idle')
    return validation.value
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) { finishStage('idle'); return null }
    if (stale()) { finishStage('idle'); return null }
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
// 这一页写过几次（保存、应用、恢复、删除版本）：写之前发出的读回来时认得出自己过时了 / How many writes this page made (save, apply, restore, delete): a read sent before a write knows it is stale when it lands
let writeCount = 0
// 开始过几次保存：读回来时用来认出读的途中开始的保存 / How many saves have started: lets a returning read spot a save that began while it was out
let saveStarts = 0
// 页面上的文件是这一页写到第几次以后读的：写进去以后那次重读失败了，它就落在后面，这时文件「变了」可能是自己写的，不说「别处改过了」
// After how many of this page's writes the file on the page was read: when the re-read after a write failed it lags behind, and a file that 「moved」 may be
// this page's own write, so 别处改过了 is not said
let docWrites = 0
function recordWrite(result: ConfigApplyResult, message: string): void {
  writeCount += 1
  const applied = applyResultState(result) === 'applied'
  if (doc.value) {
    doc.value = applied
      ? { ...doc.value, pending: null, runtime: { ...doc.value.runtime, status: 'active', active_sha256: result.sha256, apply_state: 'active', pending_error: null } }
      : { ...doc.value, pending: { version_id: result.version_id, sha256: result.sha256, message }, runtime: { ...doc.value.runtime, status: 'pending', apply_state: 'pending' } }
  }
  const entry: ConfigVersion = { id: result.version_id, sha256: result.sha256, message, actor: '', created_at: Math.floor(Date.now() / 1000), apply_state: applied ? 'applied' : 'pending' }
  versions.value = [entry, ...versions.value.filter((v) => v.id !== result.version_id).map((v) => (applied && v.apply_state === 'applied' ? { ...v, apply_state: 'superseded' as const } : v))]
}
// 服务端说了生效没有就照它说的：已经生效、KixDNS 这会儿连不上时 active_config 是空的，那也是生效了
// The server's own word decides: an apply already in effect while KixDNS is unreachable comes without active_config, and is still in effect
function applyResultState(result: ConfigApplyResult): 'applied' | 'pending' {
  return result.apply_state === 'pending' ? 'pending' : 'applied'
}

// 保存途中离开配置页：保存照常做完，结果用提示说；没保存成功时草稿留在内存里，回到配置页时接着用它
// Leaving the config page mid-save: the save still finishes and its outcome is told in a toast; if it failed, the draft stays in memory and the page picks it up on return
let viewing = false
let keepOnReturn = false
let inFlight: string | null = null
// 保存条报不到的那条结果提示：离开以后的失败，或者面板替人做的保存（立即更新）在页上回应丢了时的「不知道存上没有」。回到配置页时保存条接着说，
// 它就收起；核对完换成结果
// The outcome toast the save bar cannot speak for: a failure after leaving, or 不知道存上没有 when a save made on the user's behalf (立即更新) lost its
// answer on the page. It goes when the config page reopens and the save bar takes over, and the check replaces it with the result
let awayToast: number | null = null
// 那条提示说的是「这份配置在别处改过了」 / That toast says 这份配置在别处改过了
let awayConflict = false
// 回应丢了的那次保存（写进去没有不知道）：连上以后、或者下一次保存撞上「别处改过了」时，拿面板上的配置和它比一比
// The save whose answer was lost (written or not, unknown): once reconnected, or when the next save meets 别处改过了, compare the panel's config with it
// from / pending：丢的是保存还是「现在应用」，当时待应用的是哪个版本——核对的结果按它来说 / from / pending: whether the lost request was a save or 现在应用, and which version was pending — the result is worded by it
// version：发出时文件的版本号——「现在应用」发的就是待应用的那份文件，比内容认不出写没写进去，要看版本号动没动
// version: the file's version when sent — 现在应用 sends the pending file itself, so the content cannot tell whether it was written; the version number moving can
// inPlace：丢的是让待应用版本原地生效的那次（编号不动），写没写进去看待应用的还在不在 / inPlace: the lost request put the pending version into effect in place (the number does not move), so whether it landed is read from whether that version is still pending
// words：这次保存是面板替人做的（立即更新）时它的说法，核对以后照它说 / words: how a save made on the user's behalf (立即更新) is worded, so the check
// afterwards says it that way
let unanswered: { content: unknown; sent: string; base: string; generation: number; sentAt: number; from: 'draft' | 'apply'; pending: number | null; version: number | null; inPlace: boolean; words?: SaveWords } | null = null
const announceWritten = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event(CONFIG_WRITTEN_EVENT)) }
// 不在配置页时草稿还在内存里（正在保存，或者没保存成功留着）：刷新、关掉浏览器先问一句；配置页开着时由它自己问
// Away from the config page with a draft still in memory (a save in flight, or one that failed and is kept): reloading or closing the browser asks first; while
// the config page is open it asks itself
// 「现在应用」不算：它没有草稿，什么都丢不了，结果在服务端照样落下 / 现在应用 does not count: it has no draft and nothing can be lost; its outcome lands on the server regardless
export const draftHeldAway = (): boolean => !viewing && ((busy.value && origin.value === 'draft') || keepOnReturn)
if (typeof window !== 'undefined') window.addEventListener('beforeunload', (event) => { if (draftHeldAway()) { event.preventDefault(); event.returnValue = '' } })
// 会话过期跳到登录页时，不在配置页的这份草稿也算丢了：登录页照实说，回来时不再拿它充数（两种时机结果一样）
// When the session expires and the app goes to the login page, a draft held away from the config page counts as lost too: the login page says so, and it
// is not brought back on return (both timings end the same)
// 会话过期或退出登录时放下这份草稿：离开那条提示一起收起；还在路上的那次保存不再把草稿留下、也不再弹「草稿留在配置页」
// Let go of the held draft on session expiry or sign-out: its away toast goes too, and a save still on its way no longer keeps the draft or says 草稿留在配置页
let abandoned = false
// 同意放下草稿退出登录：会话真的结束了才放下（不再报那次保存的结果、回来时整份重读、丢掉内存里的修改）；退出没成功时草稿和在路上的保存都照旧，
// 和在配置页上退出一样。会话已经结束了（过期）就马上放下
// Agreed to let the draft go and sign out: it is let go once the session has really ended (no result reported for the save under way, a full re-read on
// return, the edits in memory dropped); a failed sign-out leaves the draft and the save under way as they were, as when signing out on the config page.
// With the session already over (expired) it is let go at once
let dropOnSessionEnd = false
function letDraftGo(): void {
  keepOnReturn = false
  dismissAwayToast()
  if (inFlight !== null) abandoned = true
  replaceOnLeave(appliedModel.value)
}
watch(() => useSession().authenticated.value, (now) => {
  if (now || !dropOnSessionEnd) return
  dropOnSessionEnd = false
  letDraftGo()
})
registerHeldDraft(draftHeldAway, () => inFlight !== null && origin.value === 'draft', () => { if (useSession().authenticated.value) dropOnSessionEnd = true; else letDraftGo() }, () => {
  // 每问一次重新算：上一次退出没成功时留下的记号不算数 / Each ask starts afresh: a mark left by an earlier failed sign-out no longer counts
  dropOnSessionEnd = false
  return useConfirm().ask({
    title: '放弃配置页的草稿',
    body: busy.value ? '配置页的保存还没做完。退出登录以后不再告诉你结果，没存上的修改也会丢掉。' : '配置页有一份没保存成功的修改，还没存到面板上，退出登录以后就没了。',
    confirmLabel: '放弃并退出',
    cancelLabel: '先不退出',
    destructive: true,
  })
})
function keepDraftForReturn(): void {
  keepOnReturn = true
}
function dropKeptDraft(): void {
  keepOnReturn = false
}
/** 离开时同意丢掉保存开始以后改的：草稿退回正在保存的那一份，保存没成功时回来看到的就是它 / Agreed to drop the edits made after the save began: the draft goes back to the one being saved, which is what a failed save brings back */
export function dropEditsAfterSave(): void {
  // 「现在应用」不是保存草稿：没有「正在保存的那一份」可以退回 / 现在应用 is not a draft save: there is no 「the one being saved」 to go back to
  // 记作离开时的换草稿：在路上的立即更新照样认它 / Counted as a replacement on leaving: a 立即更新 under way still takes it as its draft
  if (inFlight !== null && origin.value === 'draft') replaceOnLeave(JSON.parse(inFlight) as Model)
}
/** 人不在配置页时，草稿里有要留到回来的东西（立即更新放进去的新文件）：回来时不重读掉它 / With the user off the config page, the draft holds something
 * to keep for the return (a new file 立即更新 put in): the return does not re-read it away */
export function keepDraftWhileAway(): void {
  if (away()) keepDraftForReturn()
}
/** 正在做的保存、「现在应用」、恢复版本、删除版本和重新读取都做完（成没成都算） / Resolves once the save, 现在应用, version restore, version delete
 * and re-read under way have all finished (either way) */
export function whenDraftSettles(): Promise<void> {
  return new Promise((resolve) => {
    if (!draftBusy.value) { resolve(); return }
    const stop = watch(draftBusy, (running) => { if (!running) { stop(); resolve() } })
  })
}
/** 人不在配置页时说的结果记成那条提示：回到配置页、会话结束时一起收起（退出时确认框说过不再告诉你结果） / A result told away from the config page becomes
 * that toast, so returning to the page or a session end clears it (the sign-out confirm said no result would follow) */
function tellAway(id: number): void {
  if (!away()) return
  // 同一句已经开着时提示条给回的是同一个编号：不能先把它收掉 / With the same sentence already up the toast hands back the same id: it must not be cleared first
  if (awayToast !== id) dismissAwayToast()
  awayToast = id
  awayConflict = false
}
function dismissAwayToast(): void {
  if (awayToast !== null) useToast().dismiss(awayToast)
  awayToast = null
  awayConflict = false
}
/** 配置页打开（true）或离开（false）；打开时返回要不要留着草稿 / The config page opened (true) or left (false); on open, returns whether to keep the draft */
export function setViewing(open: boolean): boolean {
  viewing = open
  // 「现在应用」断线时还在配置页、随后离开：这时就挂上「不知道…应用了没有」，连上后的核对才有一条可以换掉（以前离开后什么都不说）
  // 现在应用 was cut off on the page and the user then leaves: raise 「不知道…应用了没有」 now, so the check after reconnecting has a toast to replace (nothing was said away before)
  if (!open && unanswered?.from === 'apply' && awayToast === null && signedIn()) awayToast = useToast().error(`不知道${unanswered.pending ? `版本 #${unanswered.pending} ` : '配置'}应用了没有：连不上面板。连上后会自己核对`)
  const keep = open && keepOnReturn
  if (open) {
    leftDuringSave = false
    dropKeptDraft()
    dismissAwayToast()
  }
  return keep
}
/** 草稿里没保存的就是正在保存的那一份：离开不用问 / Everything unsaved is the draft being saved right now: leaving need not ask */
// 比的是用户自己改的部分：等合成时面板填进去的文件和标题不算「之后改的」 / Compares the user's own edits: the file and titles the panel fills in while
// waiting for a build are not 「edits made after」
export const onlySaving = (): boolean => busy.value && origin.value === 'draft' && inFlight !== null && changesBesidesFile(JSON.parse(inFlight) as Model, model) === 0
  && !editorEdited.value && !jsonEdited.value && dialogEdits.size === 0
// 保存途中、没再改过，离开已经放行（页面还没卸下）：之后的结果照「人已经走了」处理 / A leave let through during a save with nothing edited since (the page not yet
// unmounted): what follows is handled as if the user were gone
let leftDuringSave = false
export function leavingDuringSave(): void { leftDuringSave = true }
// 换页没成（被取消、被别的换页顶掉）：人还在配置页上，记号清掉 / The page change did not happen (cancelled, or overtaken by another): the user is still on
// the config page and the mark goes
export function stayedDuringSave(): void { leftDuringSave = false }
const away = (): boolean => !viewing || leftDuringSave
/** 人已经不在配置页上（或者正要离开）：保存的结果由提示说 / The user is off the config page (or on the way out): a save's outcome is told by a toast */
export const pageAway = (): boolean => away()
const sentence = (text: string) => text.replace(/[。.]\s*$/, '')

// origin：保存草稿（保存栏报进度）或应用已经保存的版本（页头报进度，出错进提示）。有改动、或者要应用和运行配置不同的文件，
// 而且 KixDNS 在运行时，先单独校验一次：没过就停在第 1 步，不写入任何版本。versionNote 给面板自己发起的保存（手动更新拦截列表）
// 带上版本备注，不动备注栏里写着的
// origin: saving the draft (the save bar reports) or applying a saved version (the header reports, errors go to a notice). With
// changes, or a file that differs from what runs, and KixDNS running, validate on its own first: a failure stops at step 1 with no version written.
// versionNote gives a save the panel starts itself (a manual blocklist update) its version note, leaving the note field as it is
// 最近一次写入的结果：生效了还是存成待应用 / How the latest write ended: applied, or stored as pending
let lastWrite: { version: number; state: 'applied' | 'pending' } | null = null
export const lastSaveWrite = () => lastWrite
// 最近一次保存写入时回应丢了（存没存上不知道，连上后核对） / The latest save lost its answer while writing (landed or not is unknown, checked once back)
let lastLost = false
export const lastSaveLost = () => lastLost
/** 离开以后已经有一条提示说了「这份配置在别处改过了」，还开着 / A toast raised away from the page already says 这份配置在别处改过了 and is still up */
export const conflictToldAway = (): boolean => awayConflict && conflict.value && useToast().messages.value.some((m) => m.id === awayToast)
/**
 * 人不在配置页时，这次保存的结果怎么说。默认说「版本 #N 已生效」「配置没有保存：…草稿留在配置页」；立即更新这类面板替人做的保存说清是什么
 * How this save's outcome is told with the user off the config page. By default 「版本 #N 已生效」 and 「配置没有保存：…草稿留在配置页」; a save the panel makes on
 * the user's behalf (立即更新) says what it was
 */
// subject：没存上、存了没生效时句子的主语（默认「配置」）；conflict：离开以后撞上「别处改过了」时整句的说法；kept：草稿留在哪儿；again：别处改过了、
// 重新读取以后要再做什么；conflictHere、overwrittenHere：撞上冲突、核对出被别处盖掉时在配置页上的说法；returnTo：离开以后说了冲突时交给它页上的那句，
// 回到配置页、冲突还在时由它换上（用户定的）；madeUp：草稿换过以后还有没有补存来说结果（离开时放弃的有，在页上放弃的没有）
// subject: the subject of the not-saved and saved-not-applied sentences (by default 配置); conflict: the whole sentence for 别处改过了 away from the page;
// kept: where the draft stays; again: what to do once more after re-reading a config changed elsewhere; conflictHere, overwrittenHere: the on-page
// wording for meeting a conflict and for being found overwritten elsewhere; returnTo: given the on-page sentence when a conflict was told away, to put it
// up on returning to the config page while the conflict stays (the user's call); madeUp: whether a make-up save will still tell the result after the
// draft was replaced (a discard on leaving), as against a discard on the page with nothing to follow
export interface SaveWords {
  done?: (version: number) => string
  pending?: (version: number) => string
  subject?: string
  conflict?: string
  kept?: string
  again?: string
  conflictHere?: string
  overwrittenHere?: string
  returnTo?: (text: string) => void
  madeUp?: () => boolean
}
export async function save(from: 'draft' | 'apply' = 'draft', versionNote?: string, words?: SaveWords): Promise<void> {
  lastWrite = null
  lastLost = false
  // 排着的那次已经算数：再按一下不另起一次 / A queued save already counts: another press starts nothing new
  if (queued.value) return
  const waiting = checkRun
  if ((busy.value && !waiting) || !doc.value) return
  // 被内核不支持的 CNAME 回答挡住时说一句，不默默不动 / Blocked by unsupported CNAME answers: say so instead of doing nothing
  if (cnameBlocked.value) { sayBlocked(); return }
  if (!canSave.value) return
  // 要写入的草稿在按下这一刻定下来，复制一份：导出的结果和草稿共用数组，写入的请求要等校验完才打包，校验途中的修改会混进去、没校验就写进文件
  // The draft to write is fixed at the press, as a copy: the export shares arrays with the draft and the write request is only built after validation,
  // so an edit made during validation would slip in and be written unvalidated
  let draft = JSON.parse(JSON.stringify(model)) as Model
  // 对照的版本也定在这一刻：等候和校验途中文件换了（比如恢复了一个版本），写入照样按冲突处理，不悄悄盖在上面
  // The version written against is fixed now too: if the file changed while waiting or validating (a version restored, say), the write still meets a conflict instead of landing on top
  const expected = doc.value.sha256
  // 保存前对照的那份：回应丢了以后草稿只是被整份放弃时，草稿跟着落地的那一份走 / The baseline before the save: if the answer is lost and the draft is then simply discarded, the draft follows the version that landed
  const base = appliedSnapshot()
  // 发出去的草稿定在这一刻：之后的修改（校验途中的也算）不在这次保存里，它们的撤销保存后照样留着 / The draft sent is fixed at this moment: edits after it (during validation too) are not in this save, and their undos stay after it lands
  const sentAt = toastMark()
  const settledBefore = settledCount
  inFlight = JSON.stringify(draft)
  saveStarts += 1
  const kept = words?.kept ?? '草稿留在配\u2060置\u2060页'
  // 按完就离开了、这次没存成：草稿留着等回来，用提示说为什么没存 / Left right after pressing and this save failed: the draft is kept for the return and a
  // toast says why nothing was saved
  const sayAway = (said: string) => {
    if (!away() || abandoned) return
    const text = words?.subject ? said.replace(/^配置没有保存：/, `${words.subject}没能存上：`) : said
    keepDraftForReturn()
    dismissAwayToast()
    awayToast = useToast().error(text)
  }
  if (waiting) {
    // 单独的「校验」还没回来时按的保存：从这一刻起就是一次保存（按钮写「保存中」、换掉草稿的操作停用、离开时照保存途中问），等校验回来接着存
    // Save pressed while a lone 校验 is out: from now on it is a save (the button reads 保存中, draft-replacing actions are disabled, leaving asks as
    // during a save), and it carries on once the check returns
    queued.value = true
    try { await waiting } finally { queued.value = false }
    // 校验没过（被拒、KixDNS 停了、连不上）：停在那句结论上，不接着存；退出登录时放下了这份草稿也不存
    // The check failed (rejected, KixDNS stopped, unreachable): stop at that verdict instead of saving; nor save a draft let go at sign-out
    if (stage.value === 'failed') {
      // 校验在等拦截列表合成时就停了：和第 0 步没成一样说 / The check stopped while waiting for the blocklists' build: told as a failed step 0
      sayAway(checkBuildProblem ? buildAwayText(checkBuildProblem, kept)
        : verdict.value === 'KixDNS 已停止' ? `配置没有保存：KixDNS\u00a0已停止。${kept}，可以先存成待应用版本`
          : verdict.value === '连不上面板' ? `配置没有保存：连不上面板。${kept}，连上后再保存`
            : `配置没有保存：没有通过校验。${kept}。${note.value}`)
    }
    if (stage.value === 'failed' || abandoned || busy.value || !doc.value) { inFlight = null; abandoned = false; return }
  }
  // 第 0 步：拦截列表的文件还没按这份草稿的订阅合成好时，先等它落地，再只把文件换进按下时的草稿。等的时候就算保存途中：按钮写「保存中」，
  // 离开不问、回来不重读，这时改的照样算「之后改的」；订阅在等的时候又变了就停下说一句，不写入一个对不上的文件。排在单独的「校验」后面时，
  // 等校验回来再进这一步，中间不会有一段不算保存的空档
  // Step 0: when the blocklists' file is not yet built for this draft's subscriptions, wait for it to land, then swap only the file into the draft as
  // pressed. The wait already counts as the save under way: the button reads 保存中, leaving does not ask and returning does not re-read, and edits made
  // meanwhile count as made after it; if the subscriptions change while waiting it stops and says so, rather than writing a file that does not match.
  // Queued behind a lone 校验, it starts once the check is back, leaving no gap where the save does not count as under way
  const key = blocklistKey(draft.blocklists)
  if (from === 'draft' && draft.blocklists.builtFor !== key) {
    origin.value = 'draft'
    startStage('building')
    dismissBuildToast()
    let problem: BuildProblem | null
    waitingForBuild.value = true
    try { problem = await settleBlocklists() } finally { waitingForBuild.value = false }
    dismissBuildToast()
    if (!problem && (blocklistKey(model.blocklists) !== key || model.blocklists.builtFor !== key)) problem = { reason: '', down: false, changed: true }
    if (abandoned || problem) {
      inFlight = null
      if (abandoned) { abandoned = false; finishStage('idle'); return }
      verdict.value = problem!.down ? '连不上面板' : problem!.changed ? '没有保存' : '没有保存成功'
      finishStage('failed', buildProblemNote(problem!, '保存'))
      sayAway(buildAwayText(problem!, kept))
      return
    }
    // 名字在页面上改不了：等的时候变了，是下载带来的标题，跟着文件一起存 / Names cannot be edited on the page: one that changed while waiting is the
    // title the download brought, saved along with the file
    // 按规整后的链接对名字，和改动数一个口径：编号重了也不会把一个列表的名字换成另一个的 / Names are matched by normal link, as the change count is: a
    // repeated id can never give one list another's name
    const names = new Map(model.blocklists.subscriptions.map((s) => [normalUrl(s.url), s.name]))
    const subscriptions = draft.blocklists.subscriptions.map((s) => ({ ...s, name: names.get(normalUrl(s.url)) ?? s.name }))
    draft = { ...draft, blocklists: { ...draft.blocklists, subscriptions, file: model.blocklists.file, builtFor: key } }
  }
  const content: unknown = JSON.parse(JSON.stringify(exportConfig(draft)))
  const sent = JSON.stringify(draft)
  inFlight = sent
  // 单独校验过的正是要写的这一份：不再校验第二遍 / What the lone check validated is exactly what will be written: no second check
  const prechecked = waiting !== null && checkedContent === JSON.stringify(content)
  origin.value = from
  // 按之前提示条上已经挂着「没有生效」：这一下是重试；结果用重试的话说（等失败以后再看，那时运行状态已经换成这一次的了）
  // 没有生效 was already showing when this was pressed: it is a retry, and its outcome is worded as one (looking after the failure would see this run's state)
  const retrying = from === 'apply' && hasApplyFailure.value
  const failedBefore = pendingVersionId.value
  // 「现在应用」一个待应用的版本：让它原地生效（服务端和后台每 5 秒做的一样），不另存一个内容相同的新版本；编号、备注都不变。
  // 「重试应用」（应用失败过的）和「校验并应用」（手改过、没有对应版本的文件）照旧写一个新版本
  // 现在应用 on a pending version puts it into effect in place (as the server's background pass does every 5 seconds) instead of storing an identical
  // new version, so its number and note stay. 重试应用 (a failed version) and 校验并应用 (a hand-edited file with no version) still write a new version
  const inPlace = from === 'apply' && !retrying && !fileDiffers.value && !dirty.value && failedBefore !== null
  applyError.value = ''
  conflict.value = false
  const checkFirst = (dirty.value || fileDiffers.value) && !deferSave.value && !prechecked && !inPlace
  let step: SaveStage = checkFirst ? 'validating' : 'applying'
  startStage(step)
  try {
    if (checkFirst) {
      validation.value = await apiRequest<ValidationResult>('/api/v1/config/validate', { method: 'POST', ...jsonBody(content) })
      step = 'applying'
      stage.value = step
    }
    // 「现在应用」没有备注栏：原地生效的版本备注本来就在；另存新版本时带上待应用版本的备注，生效的那个版本照样写着它是什么
    // 现在应用 has no note field: a version put into effect in place keeps its own note; a new version carries the pending one's note, so the version that runs still says what it is
    const message = inPlace ? pendingNote(failedBefore) : versionNote ?? (saveMessage.value.trim() || (from === 'apply' ? pendingNote(failedBefore) : ''))
    const result = inPlace
      ? await apiRequest<ConfigApplyResult>(`/api/v1/config/versions/${failedBefore}/apply`, { method: 'POST' })
      : await apiRequest<ConfigApplyResult>('/api/v1/config', { method: 'PUT', ...jsonBody({ content, expected_sha256: expected, message }) })
    if (versionNote === undefined) saveMessage.value = ''
    // 写入成功就先记下：文件的散列和版本换成这次的，对照的那份换成发出去的草稿。之后的重读失败了，也不会把已保存的算成修改、下次保存也不会撞上自己
    // Record the write at once: the file hash and version become this save's, and the baseline becomes the draft that was sent. If the re-read after it fails,
    // nothing saved counts as a change and the next save does not collide with itself
    if (doc.value) doc.value = { ...doc.value, sha256: result.sha256, version_id: result.version_id }
    recordWrite(result, message)
    // 这次保存落地了：之前回应丢了的那次已经被它盖过，记录不再有用（留着会在以后哪次连上时冒出一句不相干的提示）；说它「不知道存上没有」的那条也过时了
    // This save landed: an earlier lost-answer save is superseded, so its record goes (kept, it would surface at some later unrelated reconnect), and so
    // does the toast saying whether it landed is unknown
    if (unanswered) { unanswered = null; dismissAwayToast() }
    rebaseApplied(JSON.parse(sent) as Model)
    validation.value = null
    // 保存落地后，草稿定下来之前的「撤销」都过时了：撤回去会改掉刚保存的东西；保存途中又改的那几处，撤销照样管用，留着
    // Once a save lands, undos raised before it was sent are stale: undoing would change what was just saved; those for edits made during the save still apply and stay
    dismissUndoable(sentAt)
    await load({ quiet: true, keepDraft: true, sent })
    // 「就绪后 / 启动后」看读回来以后的运行状态，不看按下时的 / 就绪后 / 启动后 follows the runtime as read back, not as it was at the press
    const pendingText = `已存成待应用版本 #${result.version_id}，${pendingWhen()}自\u2060动\u2060应\u2060用`
    // 保存途中又改了的：说一句那几处还没保存，不让「已生效」盖过它们 / Edits made during the save: say they are not saved yet, so 已生效 does not cover them
    const later = changeCount.value ? ` · 之后改的 ${changeCount.value} 处还没保存` : jsonEdited.value ? ' · JSON 里之后改的还没保存' : ''
    lastWrite = { version: result.version_id, state: applyResultState(result) }
    finishStage('done', `${applyResultState(result) === 'pending' ? pendingText : `已生效 · 版本 #${result.version_id}`}${later}`)
    // 从提示条按的「重试应用」没有保存条报结果：成功了说一句，不让提示条悄悄消失 / 重试应用 from the notice has no save bar to report: say it worked instead of the notice just vanishing
    // 每次写入都存成新版本：「现在应用」按的是 #18，生效的是 #19，用恢复版本的说法交代一句 / Every write is stored as a new version: 现在应用 was pressed on #18 and #19 took effect, said in the restore wording
    // 原地生效时服务端先存着没动（KixDNS 连不上或停了）：没有应用，照实说，不说「已存成」（它本来就是待应用的）
    // An in-place apply the server only kept (KixDNS unreachable or stopped): it was not applied, and is said so rather than 已存成 (it was pending already)
    // 「重试应用」被服务端先存着（KixDNS 这会儿没回应）：提示条一下子没了，说一句它存成了哪个待应用版本
    // 重试应用 kept by the server (KixDNS not answering just now): the notice simply vanishes, so say which pending version it became
    // 「版本 #N 的内容」连成一块，后面可以断开 / 「版本 #N 的内容」 is one block, with a break allowed after it
    const retriedPending = `版本\u00a0#${failedBefore}\u00a0的内容\u200b存成了待应用版本\u00a0#${result.version_id}，${pendingWhen()}自\u2060动\u2060应\u2060用`
    if (retrying && applyResultState(result) === 'pending' && viewing) useToast().info(retriedPending)
    else if (inPlace && applyResultState(result) === 'pending') {
      const notYet = `版本 #${result.version_id} 还没有应用：${runtimeStopped.value ? 'KixDNS\u00a0已停止，启动后自动应用' : 'KixDNS\u00a0没有回应，就绪后自动应用'}`
      // 后台几秒内就会补上：离开后也用会自己收起的提示，不挂一条很快就过时的红色提示 / The background pass catches up within seconds: away too it is a self-dismissing info toast, not a red one that soon goes stale
      if (viewing) useToast().info(notYet)
      else if (signedIn()) { dismissAwayToast(); awayToast = useToast().info(notYet) }
    }
    // 退出登录或会话过期以后，「现在应用」的结果不再报（应用没有草稿可丢，确认框也不问它） / After sign-out or expiry the outcome of 现在应用 is not reported (an apply has no draft to lose, and the confirm does not ask about it)
    else if (from === 'apply' && applyResultState(result) === 'applied') { if (signedIn()) tellAway(useToast().success(failedBefore && failedBefore !== result.version_id ? `已应用版本 #${failedBefore} 的内容，当前版本\u00a0#${result.version_id}` : `版本 #${result.version_id} 已生效`)) }
    // 保存途中离开了配置页：没有保存条报结果，用提示说；退出登录时放下了这份草稿就不说（确认框说过「不再告诉你结果」）
    // Left the config page mid-save: no save bar reports it, so a toast does; not after sign-out let the draft go (the confirm said no result would follow)
    // 离开以后重试应用被先存着：同样说出存的是哪一版的内容 / A retry kept as pending while away: say whose content it stored, as on the page
    // 给了说法的待应用用 info，和在页上一样 / A pending result with given words is an info toast, as on the page
    else if (away() && !abandoned && applyResultState(result) === 'pending' && words?.pending && !retrying) tellAway(useToast().info(words.pending(result.version_id)))
    else if (away() && !abandoned) tellAway(useToast().success(applyResultState(result) === 'pending' ? (retrying ? retriedPending : pendingText) : words?.done?.(result.version_id) ?? `版本 #${result.version_id} 已生效`))
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
    if (isConflict(error) && (await settleUnanswered(false) || settledCount !== settledBefore)) { finishStage('idle'); return save(from, versionNote, words) }
    // 原地生效撞上别处的版本：没什么要保存的（「现在应用」只在没有修改时给），直接读入并说一句；途中又改了的，冲突归保存条说
    // An in-place apply met another writer's version: nothing needs saving (现在应用 is offered only without edits), so read it in and say so; with edits made
    // meanwhile the save bar owns the conflict
    if (inPlace && isConflict(error)) {
      finishStage('idle')
      if (unsaved.value) { enterStaleBase(); return }
      await load({ quiet: true, fresh: true })
      const text = `版本 #${failedBefore} 没有应用：这份配置在别处改\u2060过\u2060了，${doc.value?.version_id ? `已读入版本\u00a0#${doc.value.version_id}` : '已重新读取'}`
      if (viewing) useToast().info(text)
      else if (signedIn()) { dismissAwayToast(); awayToast = useToast().error(text); awayConflict = true }
      return
    }
    const reason = friendlyRuntimeError(error)
    const down = isPanelDown(error)
    if (down && step === 'applying') {
      unanswered = { content, sent, base, generation: draftGeneration(), sentAt, from, pending: pendingVersionId.value ?? null, version: doc.value?.version_id ?? null, inPlace, words }
      lastLost = true
      // 面板替人做的保存（立即更新）在页上回应丢了：人是在某一行的「…」里点的，离保存条远，说一句不知道存上没有，连上后核对完换成结果（和离开以后一样）
      // A save made on the user's behalf (立即更新) lost its answer on the page: it was pressed in a row's 「…」, far from the save bar, so a toast says
      // whether it landed is unknown, and the check after reconnecting replaces it with the result (as away from the page)
      if (words?.subject && !away() && signedIn()) { dismissAwayToast(); awayToast = useToast().error(`${words.subject}：不知道存上没有，连不上面板。连上后会自己核对`) }
    }
    // 写进文件以后 KixDNS 没接受：版本已经存下了，只是没生效 / KixDNS refused after the write: the version is stored, it just did not take
    // 原地生效时服务端自己校验：没过、不支持、协议出错也会把这个版本记成没有生效，和写进去却没被接受一样说
    // An in-place apply is validated by the server: a refusal, an unsupported CNAME answer or a protocol error also marks the version as not taken, so it is
    // worded like a write that KixDNS refused
    const failedInPlace = inPlace && error instanceof ApiError && ['config_validation_failed', 'unsupported_config_fields', 'kixdns_protocol_error'].includes(error.code)
    const writtenNotApplied = step === 'applying' && error instanceof ApiError && (['reload_failed', 'kixdns_rejected'].includes(error.code) || failedInPlace)
    // 版本写进去了、KixDNS 在确认前停了：那是「没有生效」，不是「停着、存成待应用」 / Written, then KixDNS stopped before confirming: that is 没有生效, not 停着、存成待应用
    const stopped = stoppedError(error) && !writtenNotApplied
    // 写进去了（只是没生效）：和保存落地一样，草稿定下来之前的「撤销」过时了 / Written (just not applied): as when a save lands, undos from before the draft was fixed are stale
    if (writtenNotApplied) dismissUndoable(sentAt)
    verdict.value = stopped ? 'KixDNS 已停止' : down ? '连不上面板' : writtenNotApplied ? '保存了，没有生效' : step === 'validating' ? '没有通过校验' : '没有保存成功'
    conflict.value = isConflict(error)
    finishStage('failed', conflict.value ? '这份配置在别处改过了，现在的草稿是基于旧版本的' : stopped ? STOPPED_NOTE : down ? (step === 'applying' ? '不知道存上没有，连上后会自己核对' : '草稿还在，连上后再保存') : writtenNotApplied ? failureCause(reason) : reason)
    // 校验这一步没写入任何东西：只刷新运行状态，草稿和失败的说法都留着；写入以后失败才重读文件（草稿照样留着）
    // Nothing was written at the validation step: refresh the runtime only, keeping the draft and the verdict; only a failure after writing re-reads the file (the draft still stays)
    if (step === 'validating' || stopped) await refreshRuntime().catch(() => undefined)
    else if (shouldRefreshAfterSaveError(error) || failedInPlace) await load({ quiet: true, keepDraft: true, own: true })
    // 写进去了却没生效、草稿也没有别的修改：这件事交给页面上方的提示条（那里有「重试应用」），保存条退下，不再给第二个重试
    // Written but not applied and nothing else in the draft: the notice above owns it (with 重试应用); the save bar steps aside instead of offering a second retry
    if (writtenNotApplied && changeCount.value === 0 && from === 'draft') finishStage('idle')
    if (from === 'apply') {
      // 「现在应用」的结果：页面上由提示条说，离开了用提示说；开头都是「版本 #N …」，原因单独成句（服务端的原因自己带冒号）
      // The outcome of 现在应用: the notice says it on the page, a toast when away; both open with 「版本 #N …」 and the cause is its own sentence (the server's
      // causes carry their own colon)
      const which = (id: number | null | undefined) => (id ? `版本 #${id} ` : '配置')
      if (retrying) {
        // 已经挂着「没有生效」时按的「重试应用」：提示条的话和刚才一样，所以另说一句这次重试的结果；重试存成了新版本时说出新编号
        // 撞上冲突时提示条已经换成「重新读取」并写明原因，不再另弹一条说同一句
        // 重试应用 pressed while 没有生效 already shows: the notice reads as before, so this retry's outcome is said separately, naming the new version when the retry
        // was stored as one; on a conflict the notice already offers 重新读取 with the reason, so no toast repeats it
        const stored = writtenNotApplied && pendingVersionId.value && pendingVersionId.value !== failedBefore ? `，存成了版本 #${pendingVersionId.value}` : ''
        // 写入时断线：不知道重试写进去没有，连上后的核对会换掉这一条 / Cut off while writing: whether the retry landed is unknown, and the check after reconnecting replaces this
        if (!conflict.value && signedIn()) retryToast = useToast().error(writtenNotApplied ? `重试也没有生效${stored}。${failureCause(reason)}` : down && step === 'applying' ? '不知道重试应用了没有：连不上面板。连上后会自己核对' : step === 'validating' ? `重试没有通过校验。${reason}` : `重试没有成功。${reason}`)
      } else {
        // 写进去了却没生效：提示条的「版本 #N 没有生效」管这件事，不再另挂一条 / Written but not taken: the notice's 版本 #N 没有生效 owns it, no second notice
        if (!writtenNotApplied) {
          // 「校验并应用」的是手改过的文件，没有待应用的版本：停着时说启动后会读这份文件 / 校验并应用 is for a hand-edited file with no pending version: stopped, it says KixDNS reads the file on start
          applyError.value = stopped ? `KixDNS 已停止\n${failedBefore === null ? '启动后会读这份文件' : '启动后自动应用待应用的版本'}` : `${which(failedBefore)}没有应用\n${step === 'validating' ? `配置文件没有通过校验。${reason}` : reason}`
          applyFailedDown = down
        }
        // 按完「现在应用」就离开了：配置页的提示条看不见，用提示说；写入时断线不知道应用了没有，连上后核对的结果会换掉这一条
        // Left right after 现在应用: the notice is out of sight, so a toast says it; an outage during the write leaves it unknown, and the check after reconnecting replaces this toast
        if (!viewing && signedIn()) {
          dismissAwayToast()
          awayToast = useToast().error(stopped ? `KixDNS 已停止：${failedBefore === null ? '启动后会读这份文件' : '待应用的版本启动后自动应用'}`
            : writtenNotApplied ? `${failedBefore && pendingVersionId.value && pendingVersionId.value !== failedBefore ? `存成了版本 #${pendingVersionId.value}，` : which(pendingVersionId.value)}没有生效。${sentence(failureCause(reason))}。回到配\u2060置\u2060页可以重试应用`
              : down && step === 'applying' ? `不知道${which(failedBefore)}应用了没有：连不上面板。连上后会自己核对`
                : down ? `${which(failedBefore)}没有应用：连不上面板。连上后回配\u2060置\u2060页再应用`
                  : step === 'validating' ? `${which(failedBefore)}没有应用。配置文件没有通过校验。${reason}` : `${which(failedBefore)}没有应用。${reason}`)
        }
      }
    }
    else if (away() && !abandoned) {
      // 动词跟着实际发生了什么走（和保存条的判定一样），不跟着停在哪一步；内核的原话放最后
      // The verb follows what actually happened (as the save bar's verdict does), not the step it stopped at; the kernel's own words go last
      if (!writtenNotApplied) keepDraftForReturn()
      dismissAwayToast()
      // 给了说法（立即更新这类面板替人做的保存）：主语换成它，冲突时用它自己的那句 / With words given (a save the panel makes on the user's behalf, such
      // as 立即更新): the subject becomes it, and a conflict uses its own sentence
      const lead = words?.subject ? `${words.subject}没能存上：` : '配置没有保存：'
      const stored = pendingVersionId.value
      const notApplied = words?.subject ? `${words.subject}：存成了${stored ? `版本 #${stored}` : '新版本'}，没有生效` : `${stored ? `版本 #${stored} ` : '配置'}保存了，没有生效`
      awayToast = useToast().error(writtenNotApplied ? `${notApplied}。${sentence(failureCause(reason))}。回到配\u2060置\u2060页可以重试应用`
        : conflict.value ? words?.conflict ?? `${lead}这份配置在别处改\u2060过\u2060了。${kept}，回去重新读取后再改`
          : stopped ? `${lead}KixDNS\u00a0已停止。${kept}，可以先存成待应用版本`
            : down && step === 'applying' ? (words?.subject ? `${words.subject}：不知道存上没有，连不上面板。${kept}，连上后会自己核对` : `不知道配置存上没有：连不上面板。${kept}，连上后会自己核对`)
              : down ? `${lead}连不上面板。${kept}，连上后再保存`
                : step === 'validating' ? `${lead}没有通过校验。${kept}。${reason}` : `${lead}${sentence(reason)}。${kept}`)
      awayConflict = conflict.value && !writtenNotApplied
      if (awayConflict && words?.conflictHere) words.returnTo?.(words.conflictHere)
    }
  } finally {
    inFlight = null
    abandoned = false
  }
}
export const applyNow = () => void save('apply')
/** 等拦截列表合成没成、人已经离开配置页时那条提示 / The toast when waiting for the blocklists' build failed with the user away from the config page */
function buildAwayText(problem: BuildProblem, kept: string): string {
  if (problem.down) return `配置没有保存：连不上面板。${kept}，连上后再保存`
  if (problem.changed) return `配置没有保存：等合成的时候订阅又变了。${kept}，回去再保存一次`
  // 被拒的是某一个列表：原因里已经点了它的名字，说删掉这个列表 / One list was refused: the reason already names it, so it says to remove that list
  if (problem.remove) return `配置没有保存：${problem.reason}。${kept}，删掉这个列表再保存`
  return `配置没有保存：拦截列表没有合成好（${problem.reason}）。${kept}，${problem.fixable ? '改好再保存' : '回去再保存一次'}`
}
/** 等拦截列表合成没成时保存条下面那句 / The line under the save bar when waiting for the blocklists' build failed */
function buildProblemNote(problem: BuildProblem, what: '保存' | '校验'): string {
  if (problem.down) return `拦截列表还没合成好，连上后再${what}`
  if (problem.changed) return `等合成的时候订阅又变了，再${what}一次`
  // 服务端拒绝了这组订阅：再试一样，要先改好 / The server refused these subscriptions: trying again changes nothing until they are fixed
  if (problem.remove) return `${problem.reason}，删掉这个列表再${what}`
  if (problem.fixable) return `拦截列表没有合成好（${problem.reason}），改好再${what}`
  return `拦截列表没有合成好（${problem.reason}），再${what}一次会重新合成`
}
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
  // 「不知道重试应用了没有」那条由下面核对的结果换掉 / The 「不知道重试应用了没有」 toast is replaced by the result below
  if (lost.from === 'apply' && retryToast !== null) { useToast().dismiss(retryToast); retryToast = null }
  // 草稿整份换过（放弃又撤销、导入）也照样比：面板上的文件和对照的那份跟草稿是怎么来的无关；只有「已经保存过了」这句要草稿还是那一份
  // Compared even after the draft was replaced wholesale (discard then undo, an import): the file on the panel and the baseline do not depend on how the
  // draft came about; only the 已经保存过了 line needs the draft to be the same one
  const sameDraft = lost.generation === draftGeneration()
  // 面板替人做的保存（立即更新）照它的说法说 / A save made on the user's behalf (立即更新) is told in its own words
  const words = lost.words
  const lostSave = words?.subject ?? '刚才那次保存'
  // 它在页上丢了回应时挂着「不知道存上没有」：结果出来了就收起，下面在页上也说出结果（保存条离点的那一行远） / With its answer lost on the page it put
  // up 不知道存上没有: now the result is in, that goes, and the result is said on the page below too (the save bar is far from the row pressed)
  const toldHere = viewing && words?.subject !== undefined
  if (toldHere) dismissAwayToast()
  // 丢的是「现在应用」：结果按应用说，不说「保存」（那时没有保存条，也没有要保存的东西） / The lost request was 现在应用: the result is worded as an apply, not a save (there was no save bar and nothing to save)
  const applying = lost.from === 'apply'
  const pendingName = lost.pending ? `版本 #${lost.pending} ` : '待应用的版本'
  // 「现在应用」没写进去时文件还是那份待应用的，内容和发出去的一模一样：版本号没动就是没写进去（以前当成写进去了，还说「待应用，就绪后自动应用」）
  // When 现在应用 was not written the file is still the pending one, identical to what was sent: an unmoved version number means it was not written (it used to
  // count as written and even said 待应用, 就绪后自动应用)
  // 原地生效的那次编号本来就不动：待应用的还是它、也没有失败记录，就是没写进去（后台先一步让它生效了也算写进去了，结果一样）
  // An in-place apply never moves the number: the version still pending with no failure means it was not written (the background putting it into
  // effect first counts as written: the outcome is the same)
  const notWritten = applying && (lost.inPlace
    ? lost.pending !== null && current.pending?.version_id === lost.pending && !current.pending.error
    : lost.version !== null && current.version_id === lost.version)
  if (notWritten || canonical(current.content) !== canonical(lost.content)) {
    // 面板上的文件还是草稿的底子：那次保存没有存上。文件变了又不是自己那次：别处改过了（可能是存上以后又被改掉），按冲突处理，
    // 免得回去一按保存就悄悄盖掉别处的版本
    // The file on the panel is still the draft's base: the save did not land. The file changed and is not one's own save: it was changed elsewhere
    // (perhaps after it landed), so it is handled as a conflict, or saving on return would silently overwrite the other version
    // 版本号动过也算：别处恢复成原来那一版时散列回到原样，可那次保存可能存上过、又被它换掉，照「没有存上」再存会盖掉别处那次恢复
    // A moved version number counts too: when another writer restores the earlier version the hash comes back, yet the save may have landed and been
    // replaced, and saving again as if it never landed would overwrite that restore
    const changedElsewhere = Boolean(doc.value) && (current.sha256 !== doc.value!.sha256 || current.version_id !== doc.value!.version_id)
    // 这时页面上正有一次保存在跑：结论交给它自己说（它会撞上同一个冲突），这里不抢着改保存条 / A save is running on the page: it reports for itself (it meets the same conflict), so the bar is not changed here
    // 丢的是「现在应用」、草稿里也没有要保存的：没什么可丢的，直接读入别处的版本并说一句（以前进了冲突状态，可保存条不为应用显示，页面上一声不响）
    // The lost request was 现在应用 and nothing in the draft is unsaved: nothing can be lost, so read the other version in and say so (it used to enter the
    // conflict state, which the save bar does not show for an apply, so the page stayed silent)
    if (changedElsewhere && inFlight === null && applying && !unsaved.value) {
      await load({ quiet: true, fresh: true })
      const read = doc.value?.version_id ? `，已读入版本\u00a0#${doc.value.version_id}` : '，已重新读取'
      if (viewing && announce) useToast().info(`刚才那次应用不在现在的配置里：这份配置在别处改\u2060过\u2060了${read}`)
      else if (!viewing && awayToast !== null) { dismissAwayToast(); awayToast = useToast().error(`刚才那次应用不在现在的配置里：这份配置在别处改\u2060过\u2060了${read}`); awayConflict = true }
      return false
    }
    if (changedElsewhere && inFlight === null) {
      conflict.value = true
      // 草稿里还有没保存的修改：冲突归保存条说（「现在应用」的结果保存条不显示） / Unsaved edits remain: the save bar owns the conflict (it does not show 现在应用's outcomes)
      origin.value = 'draft'
      // 那次保存可能存上过、又被别处盖掉：不说「没有保存」，只说它不在现在的配置里 / The save may have landed and then been overwritten: say it is not in the current config, not that it was never saved
      verdict.value = applying ? '刚才那次应用不在现在的配置里' : `${lostSave}不在现在的配置里`
      finishStage('failed', '这份配置在别处改过了，现在的草稿是基于旧版本的')
    }
    // 在配置页上、那次保存就是没存上：保存条接着说「校验通过」，另说一句没存上 / On the config page with the save simply not landed: the bar goes on to 校验通过, so say it did not land
    // 草稿里又有修改时页头不给「现在应用」（让给保存条）：说保存会带上它，不指一个看不见的按钮
    // With edits in the draft the header offers no 现在应用 (it gives way to the save bar): say a save takes it along instead of pointing at a missing button
    const applyAgain = unsaved.value ? '；它的内容会和你的修改一起保存生效' : '，可以再点「现在应用」'
    // 面板替人做的保存（立即更新），草稿之后整份换过（离开时、在页上放弃）：那份草稿不在了，不说「它留在草稿里」「可以再保存」，只收起「不知道存上没有」；
    // 离开时放弃的，补存会自己说结果；在页上放弃的，是人自己不要了
    // A save made on the user's behalf (立即更新) whose draft was since replaced wholesale (a discard on leaving or on the page): that draft is gone, so
    // nothing says 「it stays in the draft」 or 「save again」, only 不知道存上没有 goes; after a discard on leaving the make-up save tells its own result,
    // and one discarded on the page was the user's own choice
    const gone = words !== undefined && !sameDraft
    // 没有补存来说结果：是在页上放弃的（放弃又撤销、再离开时放弃的，补存照样会来，和补存那边一个口径） / No make-up save will tell the result: it was
    // discarded on the page (a discard undone and then dropped on leaving still gets its make-up save, judged as the make-up side judges it)
    const pageDiscarded = gone && !(words?.madeUp?.() ?? false)
    if (viewing && announce && !changedElsewhere && !gone) useToast().info(applying ? `${pendingName}还没有应用${applyAgain}` : `${lostSave}没有存上，可以再保存`)
    // 面板替人做的保存被别处盖掉：冲突和原因由保存条说，这里只说保存条没说的那一步（用户定的） / A save made on the user's behalf was overwritten
    // elsewhere: the bar says the conflict and why, so this only gives the step the bar lacks (the user's call)
    // 放在拦截列表那一格里：冲突过去、离开时放弃、会话结束时都收起 / Said in the blocklist slot: it goes once the conflict is over, on a discard on leaving,
    // and at a session end
    if (toldHere && announce && changedElsewhere && inFlight === null && words?.overwrittenHere && !gone) sayDrafted(words.overwrittenHere, true)
    // 在页上放弃了修改、其实又没写进去：说「不知道」时许过会核对，照实回一句，人走了也一样（离开时放弃的，补存会自己说结果）
    // Discarded on the page and in fact not written: 不知道 promised a check, so it answers plainly, away too (one discarded on leaving has its make-up save
    // tell the result)
    if (toldHere && announce && pageDiscarded && !changedElsewhere) useToast().info(`${lostSave}没有存上`)
    // 不在配置页时，「不知道存上没有」那条提示换成核对的结果 / Away from the config page, the 不知道存上没有 toast is replaced by the result
    if (!viewing && awayToast !== null && gone) {
      dismissAwayToast()
      if (pageDiscarded && !changedElsewhere) tellAway(useToast().info(`${lostSave}没有存上`))
    } else if (!viewing && awayToast !== null) {
      dismissAwayToast()
      awayConflict = changedElsewhere
      if (changedElsewhere && words?.overwrittenHere) words.returnTo?.(words.overwrittenHere)
      awayToast = useToast().error(applying
        ? (changedElsewhere ? '刚才那次应用不在现在的配置里：这份配置在别处改\u2060过\u2060了，回到配\u2060置\u2060页重新读取' : `${pendingName}还没有应用，${unsaved.value ? '回到配\u2060置\u2060页保存时，它的内容会和你的修改一起生效' : '回到配\u2060置\u2060页可以再点「现在应用」'}`)
        : changedElsewhere ? (words?.again ? `${lostSave}：不在现在的配置里，这份配置在别处改过了；回到配置页重新读取，${words.again}` : `${lostSave}不在现在的配置里：这份配置在别处改\u2060过\u2060了。草稿留在配\u2060置\u2060页，回去重新读取后再改`)
          : `${lostSave}没有存上。${words?.kept ?? '草稿留在配\u2060置\u2060页'}，回去再保存`)
    }
    return false
  }
  // 回应丢了以后草稿只是整份放弃了（回到保存前的样子）：草稿跟着落地的那一份走，不然保存条会留一处「修改」把刚存上的删掉
  // After the lost answer the draft was simply discarded (back to the pre-save baseline): it follows the version that landed, or the bar would keep a
  // 「change」 that deletes what was just saved
  if (!sameDraft && canonical(model) === canonical(JSON.parse(lost.base))) replaceModel(JSON.parse(lost.sent) as Model)
  rebaseApplied(JSON.parse(lost.sent) as Model)
  validation.value = null
  // 和保存落地一样：发出去之前的「撤销」过时了 / As when a save lands: undos raised before it was sent are stale
  dismissUndoable(lost.sentAt)
  // 读回来、文件散列换成那次保存的以后才算核对完：这时按下的保存拿到的对照版本已经是新的；读回来之前按下的，撞上冲突时看到计数变了就接着存
  // The check counts as done only once the file is read back and the hash is the landed save's: a save pressed after that writes against the new version;
  // one pressed before it sees the count change when it meets the conflict, and carries on
  try { await load({ quiet: true, keepDraft: true, sent: lost.sent }) } finally { settledCount += 1 }
  announceWritten()
  const version = current.version_id ? `版本 #${current.version_id}` : ''
  // 页面上正有一次保存在跑：保存条交给它说；存上了却没生效：页面上方的提示条（有「重试应用」）管这件事，保存条退下，不在红色提示下面打勾
  // 「现在应用」没有保存条，结果用提示说
  // A save is running on the page: the bar is left to it; landed but not taken: the notice above (with 重试应用) owns it and the bar steps aside instead of
  // showing a tick under a red notice; 现在应用 has no save bar, so a toast says its result
  if (announce && sameDraft && inFlight === null && !applying) {
    const later = changeCount.value ? ` · 之后改的 ${changeCount.value} 处还没保存` : ''
    if (hasApplyFailure.value && !changeCount.value) finishStage('idle')
    else finishStage('done', `${version ? `已经保存过了 · ${version}` : '已经保存过了'}${later}`)
  }
  if (applying && inFlight === null && stage.value === 'failed' && origin.value === 'apply') finishStage('idle')
  // 不在配置页，或者在页上但草稿已经整份换过（保存条说不了「已经保存过了」），或者丢的是「现在应用」：用提示说
  // Away from the page, or on it with the draft replaced wholesale (the bar cannot say 已经保存过了), or the lost request was 现在应用: a toast says it
  if (!viewing || (announce && (!sameDraft || applying || toldHere))) {
    dismissAwayToast()
    // 说出它现在生效了没有（核对时已经读过一遍运行状态） / Say whether it is in effect now (the runtime was just read during the check)
    // 应用存成了新版本：开头就说出新编号，后面只说结果（和恢复版本、重试应用一样交代编号）；原地生效的编号没变，照常说「版本 #N …」
    // An apply stored as a new version: the opening names it and the rest says the outcome (numbers are accounted for as restore and retry do); an
    // in-place apply kept its number, so it reads 版本 #N … as usual
    const stored = applying && !lost.inPlace
    const opening = stored ? (version ? `刚才那次应用存成了${version}` : '刚才那次应用存上了') : applying ? '刚才那次应用' : `${lostSave}已经存上了`
    const which = stored || !version ? '' : `${version} `
    const said = hasApplyFailure.value ? useToast().error(`${opening}：${which}没有生效，${viewing ? '可以重试应用' : '回到配\u2060置\u2060页可以重试应用'}`)
      : hasPending.value ? useToast().success(`${opening}：${which}待应用，${pendingWhen()}自\u2060动\u2060应\u2060用`)
      : useToast().success(stored ? `${opening}：已生效` : version ? `${opening}：${version} 已生效` : applying ? `${opening}已经生效` : opening)
    tellAway(said)
    // 草稿里没有别的修改了：不用再留着、也不用拦着刷新 / Nothing else is unsaved in the draft: no need to keep it or to guard reloads
    if (!unsaved.value) dropKeptDraft()
  }
  return true
}
// 「重试应用」撞上冲突时的提示：重新读取以后它说的就过时了 / The toast from a 重试应用 that met a conflict: stale once the config is re-read
let retryToast: number | null = null
// 退出登录或会话过期：配置页留在别处的结果提示一起收起，登录页上不再挂着它们（以前只收起草稿那条）
// Sign-out or expiry: the config page's outcome toasts left on other pages go too, so none hangs on the login page (only the held-draft one used to)
watch(useSession().authenticated, (now) => {
  if (now) return
  dismissAwayToast()
  if (retryToast !== null) { useToast().dismiss(retryToast); retryToast = null }
})
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
  // 断线期间后台让待应用的版本生效了、或者别处换了文件：和每 5 秒那次看一样说一句（以前只有「已重新连上面板」）
  // The background put the pending version into effect during the outage, or the file was changed elsewhere: said as the 5-second look says it (only 已重新连上面板 used to show)
  if (unsaved.value || conflict.value) {
    // 有没保存的修改时不重读文件，但运行状态读到了：因为连不上而挂着的「读取配置失败」收起 / With unsaved edits the file is not re-read, but the runtime did read: a 读取配置失败 left by the outage goes
    const refreshed = await rereadAndSay(true).then(() => true, () => false)
    if (refreshed && loadFailedDown) { loadError.value = ''; loadFailedDown = false }
  } else await rereadAndSay(false)
}
// 连上面板后自己接着做（配置页开着没有都一样），不等人点重试 / Once the panel answers again, carry on by itself (whether or not the config page is open) instead of waiting for 重试
watch(panelDown, (now, before) => { if (before && !now) void panelBack() })
// 还登录着：退出登录或会话过期以后，配置页的结果不再报 / Still signed in: after sign-out or expiry the config page reports no outcome
const signedIn = (): boolean => useSession().authenticated.value
/**
 * 读一遍再说读到了什么：有修改（edited）只刷新运行状态（文件换了马上进冲突），没有就整份静默重读。别处换了文件、读了进来，说「别处改过了」；
 * 等着的待应用版本生效了，说「版本 #N 已生效」——用户被告诉过「就绪后自动应用」，等的就是这个。每 5 秒那次看、连上面板、启动 KixDNS 都走这里
 * Read, then say what was found: with edits only the runtime is refreshed (a changed file enters the conflict state at once), otherwise a whole quiet re-read.
 * A file changed elsewhere and read in is said with 别处改过了; the awaited pending version taking effect with 「版本 #N 已生效」 — the user was told
 * 「就绪后自动应用」 and is waiting for exactly that. The 5-second look, a reconnect and 启动 KixDNS all come through here
 */
export async function rereadAndSay(edited: boolean): Promise<void> {
  // 已经有一次读在路上：它是别人发的，结果由发的那一方说，这里跟着读就不再说一遍 / A read is already out: it belongs to whoever sent it, who reports it, so joining it says nothing twice
  const joined = pendingLoad !== null
  const before = doc.value?.sha256
  const waited = pendingVersionId.value
  const writesAtStart = writeCount
  // 页面上的文件读在这一页最近一次写之后：否则文件「变了」可能是自己写的 / The file on the page was read after this page's latest write: otherwise a 「moved」 file may be its own write
  const caughtUp = docWrites === writesAtStart
  if (edited) await refreshRuntime()
  else await load({ quiet: true })
  // 读的时候这一页自己写过（删除版本、保存、应用、恢复）：结果由那次写自己说，这里不说「别处改过了」
  // This page wrote while it read (a version delete, save, apply, restore): that write reports its own outcome, so no 别处改过了 here
  if (writeCount !== writesAtStart || !doc.value || busy.value) return
  // 只刷新了运行状态、修改却在途中没了（放弃修改）：整份读一遍再下结论 / Only the runtime was refreshed and the edits went away meanwhile (放弃修改): read the whole file before concluding
  if (edited && !unsaved.value && !conflict.value) {
    await load({ quiet: true })
    if (writeCount !== writesAtStart || !doc.value || busy.value) return
  }
  // 配置页不开着、或者已经退出登录、会话过期：什么都不说，回来时页头会说 / Away from the config page, signed out or expired: nothing is said; the header says it on return
  if (joined || !caughtUp || !viewing || !signedIn()) return
  // 读进来的文件没有对应的版本号时不写半截编号 / A file read in with no version number does not get half a number
  if (before !== undefined && doc.value.sha256 !== before && !unsaved.value) useToast().info(`这份配置在别处改\u2060过\u2060了，${doc.value.version_id ? `已读入版本\u00a0#${doc.value.version_id}` : '已重新读取'}`)
  else if (waited !== null && !hasPending.value && !hasApplyFailure.value && !conflict.value && doc.value.sha256 === before) useToast().success(`版本 #${waited} 已生效`)
}
/** 等待应用的版本时每 5 秒看一眼 / The 5-second look while a version is pending */
export async function checkPending(): Promise<void> {
  // 有一次读在路上（删除版本、恢复、连上后的重读）：这一下跳过，下一次再看 / A read is out (a version delete, a restore, a reconnect read): skip this tick and look next time
  if (pendingLoad) return
  await rereadAndSay(unsaved.value)
}
// 待应用版本的备注：文档里带着就用它，否则到历史里找 / The pending version's note: from the document when it carries one, otherwise from the history
function pendingNote(id: number | null): string {
  return doc.value?.pending?.message || (id ? versions.value.find((v) => v.id === id)?.message ?? '' : '')
}
/** 待应用的版本什么时候自动应用：说出等的是什么 / When a pending version applies by itself: name what it waits for */
export function pendingWhen(): string {
  // 主语和「后」连住：手机上不拆成「连上 KixDNS / 后自动应用」 / The subject stays glued to 后, so phones never split 「连上 KixDNS / 后自动应用」
  if (runtimeStopped.value) return 'KixDNS\u00a0启动后'
  if (runtimeUnavailable.value) return '连上\u00a0KixDNS\u00a0后'
  return 'KixDNS\u00a0就绪后'
}

// ---------- 历史版本 / history ----------
export const restoring = ref<number | null>(null)
// 恢复落地的次数：页面自己看着它收尾（JSON 视图换成恢复后的文字），历史抽屉在恢复途中关掉了也照样做
// How many restores have landed: the page watches it to finish up (the JSON view takes the restored text), even when the history drawer was closed mid-restore
export const restoredCount = ref(0)
// 重新读取或恢复版本正在读：页面先不让改，读回来的会整份换掉草稿，这时改的会悄悄丢掉 / A re-read or a restore is reading: the page takes no edits, since what comes back replaces the draft and edits made now would vanish
export const rereading = computed(() => (loading.value && doc.value !== null) || restoring.value !== null)
export const deleting = ref<number | null>(null)
export const bulkDeleting = ref(false)
/** 有会改面板上那份文件、或者换掉草稿的事在做：保存、「现在应用」、恢复版本、删除版本、重新读取 / Something that moves the file on the panel or replaces the
 * draft is under way: a save, 现在应用, a restore, a version delete, a re-read */
export const draftBusy = computed(() => saveInFlight.value || rereading.value || deleting.value !== null || bulkDeleting.value)
// 版本的完整内容（比较用） / A version's full content (for comparing)
export const versionDetail = (id: number) => apiRequest<ConfigVersionDetail>(`/api/v1/config/versions/${id}`)
// 恢复：用那个版本的内容生成一个新版本并应用；回来重读整页 / Restore: a new version from that content, applied; the page reloads after
export async function restoreVersion(id: number): Promise<{ state: 'applied' | 'pending'; versionId: number }> {
  if (!doc.value) throw new Error('配置还没读进来')
  restoring.value = id
  try {
    const result = await apiRequest<ConfigApplyResult>(`/api/v1/config/versions/${id}/restore`, { method: 'POST', ...jsonBody({ expected_sha256: doc.value.sha256 }) })
    writeCount += 1
    await load({ quiet: true, fresh: true })
    restoredCount.value += 1
    return { state: applyResultState(result), versionId: result.version_id }
  } finally {
    restoring.value = null
  }
}
async function refreshVersions(removesDesired: boolean): Promise<void> {
  if (removesDesired) { await load({ quiet: true, keepDraft: true, own: true }); return }
  versions.value = (await apiRequest<ConfigVersions>('/api/v1/config/versions')).versions
}
const desired = (v: ConfigVersion) => v.id === pendingVersionId.value || v.apply_state === 'pending' || v.apply_state === 'failed'
export async function deleteVersion(v: ConfigVersion): Promise<void> {
  if (!doc.value) return
  deleting.value = v.id
  try {
    await apiRequest<DeleteConfigVersionResult>(`/api/v1/config/versions/${v.id}`, { method: 'DELETE', ...jsonBody({ expected_sha256: doc.value.sha256 }) })
    writeCount += 1
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
    writeCount += 1
    await refreshVersions(versions.value.some((v) => ids.includes(v.id) && desired(v)))
    return result.deleted_ids.length
  } finally {
    bulkDeleting.value = false
  }
}
export { friendlyRuntimeError }
