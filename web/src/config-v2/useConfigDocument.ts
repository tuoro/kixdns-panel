import { computed, ref } from 'vue'
import { ApiError, apiRequest, jsonBody } from '../api/client'
import type { ConfigApplyResult, ConfigDocument, ConfigRuntimeApplyState, ConfigVersion, ConfigVersions, Overview, ServiceStatus, ValidationResult } from '../api/types'
import { SETTING_SECTIONS, settingSupported } from '../config-editor/schema'
import { exportConfig } from '../config-model/document'
import { errorMessage } from '../utils'
import { applyHits, dirty, importReport, importSource, loadContent, model, reportOpen } from './store'

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
  .filter((f) => Object.prototype.hasOwnProperty.call(model.settings, f.key) && !settingSupported(f, runtimeCapabilities.value))
  .map((f) => f.label))
// KixDNS 没启动、连不上、没报能力、有不支持的设置时，保存只存成待应用版本 / Saving only stores a pending version when KixDNS is down, unreachable, silent about capabilities, or has unsupported settings
export const deferSave = computed(() => runtimeStopped.value || runtimeUnavailable.value || Boolean(capabilityError.value) || unsupportedFields.value.length > 0)
export const fileDiffers = computed(() => !hasPending.value && !hasApplyFailure.value && doc.value?.runtime.status === 'different')
export const canApplyNow = computed(() => (hasPending.value || hasApplyFailure.value || fileDiffers.value) && !deferSave.value)
export const canSave = computed(() => dirty.value || canApplyNow.value)

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
// 再改一笔，上一次保存的结果就过时了 / A new edit makes the last save's outcome stale
export function editTouched(): void { if (stage.value === 'done' || stage.value === 'failed') finishStage('idle') }

// ---------- 页头 / header ----------
export interface HeaderStatus { tone: 'ok' | 'warn' | 'err' | 'off'; lead?: string; before: string; version?: number; after?: string }
export const headerStatus = computed<HeaderStatus>(() => {
  if (hasApplyFailure.value) return { tone: 'err', before: '配置应用失败' }
  if (hasPending.value) return pendingVersionId.value ? { tone: 'warn', before: '版本 #', version: pendingVersionId.value, after: ' 待应用' } : { tone: 'warn', before: '配置待应用' }
  if (runtimeStopped.value) return { tone: 'off', before: 'KixDNS 未启动' }
  if (doc.value?.runtime.status === 'active') return currentVersionId.value ? { tone: 'ok', lead: '运行中', before: '版本 #', version: currentVersionId.value } : { tone: 'ok', before: '运行中' }
  if (fileDiffers.value) return { tone: 'warn', before: '文件与运行配置不同' }
  return { tone: 'off', before: '运行状态不可用' }
})
export const headerLine = computed<HeaderStatus>(() => {
  if (!applyBusy.value) return headerStatus.value
  const verb = stage.value === 'validating' ? '校验中' : '应用中'
  return pendingVersionId.value ? { tone: 'warn', before: '版本 #', version: pendingVersionId.value, after: ` ${verb}` } : { tone: 'warn', before: verb }
})
// 待应用时「现在应用」，文件和运行配置不同时「校验并应用」；有要保存的修改时让给保存栏 / 现在应用 when pending, 校验并应用 when the file differs; with changes to save it gives way to the save bar
export const headerAction = computed(() => {
  if (!canApplyNow.value || dirty.value || hasApplyFailure.value) return ''
  return fileDiffers.value ? '校验并应用' : '现在应用'
})
export const deferNote = computed(() => {
  if (runtimeStopped.value) return '保存后等 KixDNS 启动再应用'
  if (runtimeUnavailable.value) return '保存后等连上 KixDNS 再应用'
  return deferSave.value ? '保存后先存成待应用版本' : ''
})

// ---------- 错误的说法 / wording of errors ----------
export function friendlyRuntimeMessage(message: string): string {
  if (/No such file|os error 2|控制接口.*不可用|控制接口.*未启动/i.test(message)) return 'KixDNS 未启动，配置将保存为待应用版本'
  return message.replace(/^KixDNS\s*拒绝(?:操作|了这份配置|该配置)[：:，,]\s*/, '') || message
}
const friendlyRuntimeError = (error: unknown) => friendlyRuntimeMessage(errorMessage(error))
const shouldRefreshAfterSaveError = (error: unknown) => error instanceof ApiError && ['unsupported_config_fields', 'config_validation_failed', 'reload_failed', 'kixdns_rejected'].includes(error.code)
const isConflict = (error: unknown) => error instanceof ApiError && error.code === 'config_conflict'

// ---------- 读 / load ----------
let pendingLoad: Promise<void> | null = null
// quiet：保存之后的刷新不换成骨架 / quiet: the refresh after a save keeps the page mounted
export function load(options: { quiet?: boolean } = {}): Promise<void> {
  if (pendingLoad) return pendingLoad
  if (!options.quiet) loading.value = true
  pendingLoad = (async () => {
    const [nextDoc, history, overview, service] = await Promise.all([
      apiRequest<ConfigDocument>('/api/v1/config'),
      apiRequest<ConfigVersions>('/api/v1/config/versions'),
      apiRequest<Overview>('/api/v1/overview').catch((error: unknown) => { capabilityError.value = friendlyRuntimeError(error); return null }),
      apiRequest<ServiceStatus>('/api/v1/service').catch(() => null),
    ])
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
    doc.value = nextDoc
    versions.value = history.versions
    // 读进草稿：散列对得上就是面板写的那份；对不上（手改过）会重新导入并给报告 / Into the draft: the hash matching means the panel wrote it; otherwise it is re-imported with a report
    const read = loadContent(nextDoc.content, model)
    if (read.source === 'imported' && read.report && (read.report.stats.raw || read.report.notes.some((n) => n.level === 'warn'))) {
      importReport.value = read.report
      importSource.value = '配置文件'
      reportOpen.value = false
    }
    applyHits(overview?.metrics?.rules ?? [])
    validation.value = null
    loadError.value = ''
  })().catch((error: unknown) => { loadError.value = errorMessage(error) }).finally(() => { loading.value = false; pendingLoad = null })
  return pendingLoad
}

// ---------- 校验、保存、应用 / validate, save, apply ----------
export async function validate(): Promise<ValidationResult | null> {
  if (deferSave.value) return null
  origin.value = 'draft'
  startStage('checking')
  try {
    validation.value = await apiRequest<ValidationResult>('/api/v1/config/validate', { method: 'POST', ...jsonBody(exportConfig(model)) })
    finishStage('idle')
    return validation.value
  } catch (error) {
    verdict.value = '没有通过校验'
    finishStage('failed', friendlyRuntimeError(error))
    return null
  }
}

function applyResultState(result: ConfigApplyResult): 'applied' | 'pending' {
  return result.apply_state === 'pending' || !result.active_config ? 'pending' : 'applied'
}

// origin：保存草稿（保存栏报进度）或应用已经保存的版本（页头报进度，出错进提示）。有改动、或者要应用和运行配置不同的文件，
// 而且 KixDNS 在运行时，先单独校验一次：没过就停在第 1 步，不写入任何版本。
// origin: saving the draft (the save bar reports) or applying a saved version (the header reports, errors go to a notice). With
// changes, or a file that differs from what runs, and KixDNS running, validate on its own first: a failure stops at step 1 with no version written.
export async function save(from: 'draft' | 'apply' = 'draft'): Promise<void> {
  if (busy.value || !doc.value || !canSave.value) return
  const content = exportConfig(model)
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
    const result = await apiRequest<ConfigApplyResult>('/api/v1/config', { method: 'PUT', ...jsonBody({ content, expected_sha256: doc.value.sha256, message: saveMessage.value.trim() }) })
    validation.value = result.validation ?? validation.value
    const text = applyResultState(result) === 'pending' ? `已存成待应用版本 #${result.version_id}，KixDNS 就绪后自动应用` : `已生效 · 版本 #${result.version_id}`
    saveMessage.value = ''
    await load({ quiet: true })
    finishStage('done', text)
  } catch (error) {
    const reason = friendlyRuntimeError(error)
    verdict.value = step === 'validating' ? '没有通过校验' : '没有保存成功'
    conflict.value = isConflict(error)
    finishStage('failed', conflict.value ? '这份配置在别处改过了，现在的草稿是基于旧版本的' : reason)
    if (shouldRefreshAfterSaveError(error)) await load({ quiet: true })
    if (from === 'apply' && !hasApplyFailure.value) applyError.value = `${step === 'validating' ? '磁盘上的配置没有通过校验' : '没有应用成功'}\n${reason}`
  }
}
export const applyNow = () => void save('apply')
