<script setup lang="ts">
import {
  ArrowLeft,
  Braces,
  ChevronDown,
  CircleAlert,
  Download,
  FileUp,
  GitCompare,
  History,
  Info,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Trash2,
  Workflow,
  X,
} from '@lucide/vue'
import type { Component } from 'vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { ApiError, apiRequest, jsonBody } from '../api/client'
import type {
  ConfigApplyResult,
  ConfigDocument,
  ConfigVersion,
  ConfigVersionDetail,
  ConfigVersions,
  ConfigRuntimeApplyState,
  DeleteConfigVersionResult,
  DeleteConfigVersionsResult,
  Overview,
  ServiceStatus,
  ValidationResult,
} from '../api/types'
import ConfigFlowPreview from '../components/config/ConfigFlowPreview.vue'
import DomainMappingConfigEditor from '../components/config/DomainMappingConfigEditor.vue'
import DnsSolutionEditor from '../components/config/DnsSolutionEditor.vue'
import { readListShape, type RowShape } from '../components/config/list-shape'
import ConfigVersionDiffDialog from '../components/config/ConfigVersionDiffDialog.vue'
import StructuredConfigEditor from '../components/config/StructuredConfigEditor.vue'
import JsonEditor from '../components/JsonEditor.vue'
import RuntimeMessage, { type RuntimeTarget } from '../components/config/RuntimeMessage.vue'
import UiMenu, { type UiMenuItem } from '../components/ui/UiMenu.vue'
import UiPageHeader from '../components/ui/UiPageHeader.vue'
import UiNumber from '../components/ui/UiNumber.vue'
import UiTabs from '../components/ui/UiTabs.vue'
import { diffByIdentity } from '../config-editor/changes'
import { normalizeConfig, promoteDomainMappingSelectors, serializeConfig } from '../config-editor/model'
import { isGeoSiteMatcher } from '../config-editor/field-validation'
import { SETTING_SECTIONS, settingSupported } from '../config-editor/schema'
import type { ConfigEditorMode, KixConfig, MatcherConfig } from '../config-editor/types'
import { useConfirm } from '../composables/useConfirm'
import { useToast } from '../composables/useToast'
import { errorMessage, formatVersionTime } from '../utils'
import UiDotText from '../components/ui/UiDotText.vue'
import { vLineDots } from '../line-dots'

const document = ref<ConfigDocument | null>(null)
const config = ref<KixConfig | null>(null)
const versions = ref<ConfigVersion[]>([])
const source = ref('')
const baseline = ref('')
const message = ref('')
const mode = ref<ConfigEditorMode>('structured')
const section = ref<'pipeline' | 'mapping' | 'settings'>('pipeline')
const manualMode = ref(false)
const localDraftDirty = ref(false)
const focusedEditing = ref(false)
const workspaceKey = ref(0)
const openEntryKey = ref<string | undefined>()
// 骨架的行：同样宽的列表上次是什么样就画成什么样；没有记录时第一行是域名映射，说明一行放得下，后面的入口在窄的列表里
// 说明常要两行（--more 只在窄的列表里出现）。数据到了以后行不挪（审计第五轮 B1）
// The skeleton's rows: as a list of the same width looked last time; with no record the first row is the domain mapping, whose
// detail fits one line, and the entries after it often take two in a narrow list (--more shows only there). Rows stay put when
// the data arrives (audit round 5, B1)
const skeletonList = ref<HTMLElement | null>(null)
const rememberedRows = ref<RowShape[]>()
const skeletonRows = computed<readonly RowShape[]>(() => rememberedRows.value ?? [[1, 1], [1, 2], [1, 2], [1, 2], [1, 2]])
watch(skeletonList, (element) => { rememberedRows.value = element ? readListShape(element.getBoundingClientRect().width) : undefined }, { flush: 'post' })
// 自由编辑打开时要展开、滚到的那个 Pipeline 和规则（从检查器、出错链接进来） / The Pipeline and rule 自由编辑 opens on (from the inspector or an error link)
const manualFocus = ref<RuntimeTarget | null>(null)
// 「已加入草稿，保存后生效」这类提示在保存之后就过时了，保存成功时一并收起。
// Notices such as "added to the draft, takes effect after saving" are stale once saved and are cleared on a successful save.
const draftNoticeIds: number[] = []
function draftNotice(message: string): void {
  draftNoticeIds.push(toast.info(message))
}
const solutionEditor = ref<InstanceType<typeof DnsSolutionEditor> | null>(null)
const jsonEditor = ref<InstanceType<typeof JsonEditor> | null>(null)
const historyOpen = ref(false)
// 历史里的「选择」模式：行首出现复选框，底部是「删除所选」 / The history's select mode: checkboxes lead the rows, 删除所选 at the bottom
const historySelecting = ref(false)
// 手机上备注藏在「备注」按钮后面，保存栏矮一行（评审 N12） / On a phone the note hides behind a 备注 button, one row shorter (review N12)
const noteOpen = ref(false)
const historyDialog = ref<HTMLDialogElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const loading = ref(true)
const validating = ref(false)
const saving = ref(false)
const restoring = ref<number | null>(null)
const deleting = ref<number | null>(null)
const bulkDeleting = ref(false)
const selectedVersionIds = ref<number[]>([])
const previewing = ref<number | null>(null)
// 取版本详情期间按钮是禁用的，浏览器会把焦点从禁用的按钮上移走，所以要在点击那一刻记下来。
// The button is disabled while the version loads and the browser moves focus
// off a disabled button, so the trigger is recorded at the moment of the click.
const previewTrigger = ref<HTMLElement | null>(null)
const previewVersion = ref<ConfigVersionDetail | null>(null)
const validation = ref<ValidationResult | null>(null)
const parseError = ref('')
const loadError = ref('')
const capabilityError = ref('')
const runtimeStopped = ref(false)
// 从页头「现在应用」「校验并应用」发起、又没走到服务端记录失败的那一步时的原因（例如文件没通过校验）
// The reason when an apply started from the header failed before the server could record it (e.g. the file failed validation)
const applyError = ref('')
const runtimeCapabilities = ref<string[]>([])
const toast = useToast()
const confirm = useConfirm()
// 保存过的那份和草稿，都按编辑器读入的方式规范化。JSON 视图里草稿按正在写的文字解析，写错时没有。
// The saved config and the draft, both normalized as the editor reads them. In the JSON view the draft is
// parsed from the text being typed, and is absent while it does not parse.
function parseConfig(text: string): KixConfig | null {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? normalizeConfig(value as Record<string, unknown>) : null
  } catch {
    return null
  }
}
const savedConfig = computed(() => parseConfig(baseline.value))
const draftConfig = computed(() => (mode.value === 'json' ? parseConfig(source.value) : config.value))
// 改没改按内容算：JSON 视图里只动了空格、换行不算修改（评审交接：count 为 0 时不能写「已修改 0 处」）
// Changed means the content changed: whitespace in the JSON view is not a change (hand-off note: never 已修改 0 处)
const changed = computed(() => {
  if (mode.value !== 'json') return source.value !== baseline.value
  return (draftConfig.value ? serializeConfig(draftConfig.value) : source.value) !== baseline.value
})
const runtimeApplyState = computed<ConfigRuntimeApplyState | undefined>(() => document.value?.runtime.apply_state)
const hasApplyFailure = computed(() => runtimeApplyState.value === 'failed'
  || document.value?.runtime.status === 'failed'
  || Boolean(document.value?.runtime.pending_error)
  || Boolean(document.value?.pending?.error))
const hasPending = computed(() => !hasApplyFailure.value
  && (runtimeApplyState.value === 'pending'
    || document.value?.runtime.status === 'pending'
    || Boolean(document.value?.pending)))
const pendingVersionId = computed(() => document.value?.pending?.version_id
  ?? (runtimeApplyState.value === 'pending' ? document.value?.version_id : null)
  ?? null)
const currentVersionId = computed(() => {
  const activeSha = document.value?.runtime.active_sha256
  const applied = versions.value.find((version) => version.apply_state === 'applied'
    && (!activeSha || version.sha256 === activeSha))
  if (applied) return applied.id
  if (hasPending.value || hasApplyFailure.value) return null
  return document.value?.version_id ?? null
})
const deletableVersionIds = computed(() => versions.value
  .filter((version) => version.id !== currentVersionId.value)
  .map((version) => version.id))
const runtimeUnavailable = computed(() => document.value?.runtime.status === 'unavailable'
  && !runtimeStopped.value)
const unsupportedFields = computed(() => {
  const settings = config.value?.settings
  if (!settings) return []
  return SETTING_SECTIONS
    .flatMap((section) => section.fields)
    .filter((field) => Object.prototype.hasOwnProperty.call(settings, field.key)
      && !settingSupported(field, runtimeCapabilities.value))
    .map((field) => field.label)
})
const deferSave = computed(() => runtimeStopped.value
  || runtimeUnavailable.value
  || Boolean(capabilityError.value)
  || unsupportedFields.value.length > 0)
// 磁盘上的文件和 KixDNS 正在用的不一样（没有待应用、也没失败）：页头给「校验并应用」
// The file on disk differs from what KixDNS runs (nothing pending or failed): the header offers 校验并应用
const fileDiffers = computed(() => !hasPending.value && !hasApplyFailure.value && document.value?.runtime.status === 'different')
const canApplyNow = computed(() => (hasPending.value || hasApplyFailure.value || fileDiffers.value) && !deferSave.value)
// 检查器里没应用的修改也算：保存时一起应用（规范第 11 节） / Unapplied inspector edits count too: the save applies them (spec section 11)
const canSave = computed(() => changed.value || localDraftDirty.value || canApplyNow.value)
// 保存是一件要等几秒的事，按状态胶囊那一套走：先校验，再保存并热加载，每一步都是真的请求；
// 走到哪一步、用了多久写在保存条上，成了打勾，没成写原因并抖一下。按下之后不再只弹一条提示。
// Saving takes seconds, so it runs like a status capsule: validate, then save and hot-reload,
// each a real request; the save bar says which step it is on and for how long, ticks on
// success, and on failure states the reason with one shake, instead of only popping a toast.
type SaveStage = 'idle' | 'checking' | 'validating' | 'applying' | 'done' | 'failed'
const saveStage = ref<SaveStage>('idle')
// 这一次是保存草稿（保存栏报进度）还是应用已保存的版本（页头报进度）：系统的动作不进保存栏（规范第 8 节）
// Whether this run saves the draft (the save bar reports) or applies a saved version (the header reports):
// system actions never go in the save bar (spec section 8)
const saveOrigin = ref<'draft' | 'apply'>('draft')
const saveNote = ref('')
// 失败时的结论（「没有通过校验」「没有保存成功」），原因在 saveNote / The verdict of a failure; the reason is in saveNote
const saveVerdict = ref('')
const saveStartedAt = ref(0)
const clock = ref(0)
let clockTimer: ReturnType<typeof setInterval> | undefined
let settleTimer: ReturnType<typeof setTimeout> | undefined
const saveBusy = computed(() => ['checking', 'validating', 'applying'].includes(saveStage.value))
const saveElapsed = computed(() => {
  const seconds = (clock.value - saveStartedAt.value) / 1000
  return saveBusy.value && seconds >= 1 ? `已用 ${seconds.toFixed(1)} 秒` : ''
})
function startStage(stage: SaveStage): void {
  clearTimeout(settleTimer)
  saveStage.value = stage
  saveStartedAt.value = Date.now()
  clock.value = saveStartedAt.value
  clearInterval(clockTimer)
  clockTimer = setInterval(() => { clock.value = Date.now() }, 100)
}
function finishStage(stage: 'done' | 'failed' | 'idle', note = ''): void {
  clearInterval(clockTimer)
  saveStage.value = stage
  saveNote.value = note
  // 「已生效」停三秒再回到平常那句话；失败一直留着，直到再改或再存。
  // "Applied" stays three seconds before the usual sentence returns; a failure stays until the next edit or save.
  if (stage === 'done') settleTimer = setTimeout(() => { if (saveStage.value === 'done') saveStage.value = 'idle' }, 3000)
}
// 改了几处：按身份比出来的「一件东西」数（changes.ts）——一个入口连同只属于它的 Pipeline、一条映射、一项设置。
// Changes counted per thing by identity (changes.ts): an entry with its own Pipeline, a mapping, a setting.
const changeSet = computed(() => (changed.value && savedConfig.value && draftConfig.value ? diffByIdentity(savedConfig.value, draftConfig.value) : null))
// 检查器里有没应用的修改时，按保存时真正会写进去的样子数：那些修改会一起保存（规范第 11 节）。
// 行尾的墨点仍按草稿本身画：新加的入口还不在列表里，副本里的位置和列表对不上
// With unapplied inspector edits, count what a save would actually write, since those edits are saved too (spec section 11).
// The rows' ink dots still follow the draft itself: a new entry is not in the list yet, so positions in the copy would not match
const pendingConfig = computed(() => (localDraftDirty.value && mode.value !== 'json' ? solutionEditor.value?.pendingConfig ?? null : null))
const changeCount = computed(() => (pendingConfig.value && savedConfig.value ? diffByIdentity(savedConfig.value, pendingConfig.value).count : changeSet.value?.count ?? 0))
// 工作台行尾的墨点：改过、新加、挪过的入口；没有入口的 Pipeline 改了也点上
// The workbench's ink dots: entries changed, added or moved, and changed Pipelines that have no entry
const changedKeys = computed(() => {
  const keys = new Set<string>()
  for (const group of changeSet.value?.groups ?? []) {
    if (group.kind === 'removed' || group.afterIndex === undefined) continue
    if (group.subject === 'entry') keys.add(`selector-${group.afterIndex}`)
    else if (group.subject === 'pipeline') keys.add(`orphan-${group.afterIndex}`)
  }
  return keys
})
// 基础设置里改过的项：那一行和它所在的分组画墨点，和工作台行尾的墨点同一个意思（规范 8.1，审计第三轮 T8）
// Changed settings: the row and its group get the ink dot, the workbench's mark for a change (spec 8.1, audit round 3, T8)
const changedSettings = computed(() => new Set((changeSet.value?.groups ?? []).flatMap((group) => {
  if (group.subject === 'setting') return [group.key.replace(/^setting:/, '')]
  return group.subject === 'other' && group.key === 'other:version' ? ['version'] : []
})))
const saveLabel = computed(() => {
  if (saveBusy.value && saveOrigin.value === 'draft') return '保存中'
  if (deferSave.value) return '保存为待应用'
  return '保存并热加载'
})
const applyBusy = computed(() => saveBusy.value && saveOrigin.value === 'apply')
// 真正在保存（不是单独「校验」）时，保存栏只留步骤和保存按钮；焦点原来在栏里的，交给保存按钮，不掉到页面上
// While really saving (not a lone 校验) the bar keeps only the step and the save button; focus that was in the bar moves to the button instead of dropping to the page
const saveRunning = computed(() => saveBusy.value && saveOrigin.value === 'draft' && saveStage.value !== 'checking')
watch(saveRunning, async (running) => {
  if (!running) return
  const active = window.document.activeElement
  if (!(active instanceof HTMLElement) || !active.closest('.config-savebar')) return
  await nextTick()
  window.document.querySelector<HTMLElement>('.config-save-button')?.focus({ preventScroll: true })
})
// 页头状态行说「KixDNS 现在怎样」，需要时带一个动作（规范第 8 节）。版本号单独拿出来，变了会弹入。
// 连不上控制接口、没运行时不另起提示：有修改时保存栏会说保存后怎样（评审 N9）。
// The header's status line says how KixDNS is now, with one action when there is one (spec section 8).
// The version number is separate so it pops in when it changes. Unreachable and stopped get no notice of
// their own: with changes, the save bar says what saving will do (review N9).
// lead：版本前面的状态（「运行中」），和后面用「·」隔开 / lead: the state before the version (运行中), separated from it by a 「·」
interface HeaderStatus { tone: 'ok' | 'warn' | 'err' | 'off'; lead?: string; before: string; version?: number; after?: string }
const headerStatus = computed<HeaderStatus>(() => {
  if (hasApplyFailure.value) return { tone: 'err', before: '配置应用失败' }
  if (hasPending.value) return pendingVersionId.value ? { tone: 'warn', before: '版本 #', version: pendingVersionId.value, after: ' 待应用' } : { tone: 'warn', before: '配置待应用' }
  // 服务确实停了就说停了：配置文件里记的运行状态可能还是上一次的。
  // If the service is actually stopped, say so: the runtime state recorded with the config may be stale.
  if (runtimeStopped.value) return { tone: 'off', before: 'KixDNS 未启动' }
  if (document.value?.runtime.status === 'active') return currentVersionId.value ? { tone: 'ok', lead: '运行中', before: '版本 #', version: currentVersionId.value } : { tone: 'ok', before: '运行中' }
  if (fileDiffers.value) return { tone: 'warn', before: '文件与运行配置不同' }
  return { tone: 'off', before: '运行状态不可用' }
})
// 应用进行中时状态行只说一件事：「◌ 版本 #19 应用中 · 已用 1.2 秒」，圈替掉点，「待应用」不再同时出现（审计 S2）
// While applying, the status line says one thing: 「◌ 版本 #19 应用中 · 已用 1.2 秒」, the spinner in the dot's place
// and 待应用 gone, instead of pending and in progress at once (audit S2)
const headerLine = computed<HeaderStatus>(() => {
  if (!applyBusy.value) return headerStatus.value
  const verb = saveStage.value === 'validating' ? '校验中' : '应用中'
  return pendingVersionId.value ? { tone: 'warn', before: '版本 #', version: pendingVersionId.value, after: ` ${verb}` } : { tone: 'warn', before: verb }
})
// 页头行尾的动作：待应用时「现在应用」，文件和运行配置不同时「校验并应用」；应用失败的重试在提示里。
// 有要保存的修改（包括检查器里没应用的）时让给保存栏
// The header's action: 现在应用 when pending, 校验并应用 when the file differs; a failed apply's retry sits in its notice.
// With changes to save (inspector edits included) it gives way to the save bar
const headerAction = computed(() => {
  if (!canApplyNow.value || changed.value || localDraftDirty.value || hasApplyFailure.value) return ''
  return fileDiffers.value ? '校验并应用' : '现在应用'
})
const sectionItems = [
  { value: 'pipeline', label: '解析编排' },
  { value: 'mapping', label: '域名映射' },
  { value: 'settings', label: '基础设置' },
]
// 同一份配置的三种看法放在一个分段里；「流程」只有解析编排有。
// The three views of one config share one segment; only 解析编排 has 流程.
const modeItems = computed(() => [
  { value: 'structured', label: '表单', icon: Settings2 },
  ...(section.value === 'pipeline' ? [{ value: 'flow', label: '流程', icon: Workflow }] : []),
  { value: 'json', label: 'JSON', icon: Braces },
])
// 保存栏只说草稿（规范第 8 节）：有修改、在保存、刚保存完、出了错才出现；空闲时不在。
// The save bar speaks only for the draft (spec section 8): it appears with changes, while saving, just after,
// or on an error, and is gone when idle.
// 检查器里没应用的修改也会一起保存，所以它也叫出保存栏（规范第 11 节） / Unapplied inspector edits are saved too, so they bring up the bar (spec section 11)
const savebarVisible = computed(() => Boolean(document.value) && (changed.value || localDraftDirty.value || Boolean(jsonProblem.value)
  || (saveOrigin.value === 'draft' && saveStage.value !== 'idle')))
// 保存后会怎样：KixDNS 没运行、连不上或者能力不明时，保存只存成待应用版本
// What saving will do: with KixDNS stopped, unreachable or of unknown ability, saving only stores a pending version
const deferNote = computed(() => {
  // 页头已经说了没运行、连不上，这里只说保存的后果（审计 A18） / The header already says stopped or unreachable; this says only what saving does (audit A18)
  if (runtimeStopped.value) return '保存后等 KixDNS 启动再应用'
  if (runtimeUnavailable.value) return '保存后等连上 KixDNS 再应用'
  return deferSave.value ? '保存后先存成待应用版本' : ''
})
// JSON 视图里边写边解析：写错了保存栏马上说在哪一行，那一行画波浪线（规范 3.9）
// The JSON view parses as you type: a mistake is named in the save bar at once and its line underlined (spec 3.9)
const jsonProblem = computed(() => {
  if (mode.value !== 'json') return parseError.value
  try {
    const value: unknown = JSON.parse(source.value)
    return value === null || Array.isArray(value) || typeof value !== 'object' ? '配置根节点必须是 JSON 对象' : ''
  } catch (error) {
    return errorMessage(error)
  }
})
// JSON 写错时指到行列：浏览器的报错里带位置，换成「第 7 行第 5 列」和一句人话
// A JSON error points at its line and column: the browser's message carries the position, turned into words
const parsePosition = computed(() => {
  const found = /line (\d+) column (\d+)/.exec(jsonProblem.value)
  if (found) return { line: Number(found[1]), column: Number(found[2]) }
  const offset = /position (\d+)/.exec(jsonProblem.value)
  if (!offset) return null
  const before = source.value.slice(0, Number(offset[1])).split('\n')
  return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 }
})
const parseReason = computed(() => {
  const message = jsonProblem.value
  if (!message) return ''
  const at = parsePosition.value
  if (/double-quoted property name/.test(message) && at) {
    const offset = source.value.split('\n').slice(0, at.line - 1).join('\n').length + at.column
    // offset 是出错那个字符的下标；它前面（跳过空白）是逗号，就是多了一个逗号
    // offset indexes the offending character; a comma before it (past whitespace) means one comma too many
    if (/,\s*$/.test(source.value.slice(0, offset))) return '多余的逗号'
    return '属性名要用双引号'
  }
  if (/Unexpected end/.test(message)) return 'JSON 不完整'
  if (/Expected ',' or/.test(message)) return '少了逗号或右括号'
  if (/Unexpected token|Unexpected non-whitespace/.test(message)) return '这里多了一个字符'
  if (/根节点/.test(message)) return message
  return '格式不对'
})
let syncingConfig = false
let pendingLoad: Promise<void> | null = null

watch(source, () => {
  validation.value = null
  parseError.value = ''
  // 再改一笔，上一次保存的结果（成功或失败）就过时了。 / A new edit makes the last save's outcome stale.
  if (saveStage.value === 'done' || saveStage.value === 'failed') finishStage('idle')
})
onBeforeUnmount(() => { clearInterval(clockTimer); clearTimeout(settleTimer) })

watch(historyOpen, async (open) => {
  if (!open) return
  await nextTick()
  historyDialog.value?.showModal()
})

watch(config, (value) => {
  if (!value || syncingConfig) return
  source.value = serializeConfig(value)
}, { deep: true, flush: 'sync' })

async function confirmDiscard(): Promise<boolean> {
  if (!changed.value && !localDraftDirty.value) return true
  return confirm.ask({
    title: '放弃未保存的修改',
    body: '当前的配置草稿和入口修改会被丢弃，回到上次保存的状态。已保存的历史版本不受影响。',
    confirmLabel: '放弃修改',
    cancelLabel: '继续编辑',
    destructive: true,
  })
}

function preventAccidentalClose(event: BeforeUnloadEvent): void {
  if (!changed.value && !localDraftDirty.value) return
  event.preventDefault()
  event.returnValue = ''
}

function friendlyRuntimeError(error: unknown): string {
  return friendlyRuntimeMessage(errorMessage(error))
}

// 原因那一行只写原因：「KixDNS 拒绝操作：」这类开头和上面的结论说的是同一件事，去掉（审计第三轮 B7）
// The reason line holds only the cause: an opening such as 「KixDNS 拒绝操作：」 says what the verdict above already says, so it goes (audit round 3, B7)
function friendlyRuntimeMessage(message: string): string {
  if (/No such file|os error 2|控制接口.*不可用|控制接口.*未启动/i.test(message)) {
    return 'KixDNS 未启动，配置将保存为待应用版本'
  }
  return message.replace(/^KixDNS\s*拒绝(?:操作|了这份配置|该配置)[：:，,]\s*/, '') || message
}

function applyResultState(result: ConfigApplyResult): 'applied' | 'pending' {
  if (result.apply_state === 'pending' || !result.active_config) return 'pending'
  return 'applied'
}

function shouldRefreshAfterSaveError(error: unknown): boolean {
  return error instanceof ApiError
    && ['unsupported_config_fields', 'config_validation_failed', 'reload_failed', 'kixdns_rejected'].includes(error.code)
}

function parseSource(): Record<string, unknown> | null {
  parseError.value = ''
  try {
    const value: unknown = JSON.parse(source.value)
    if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error('配置根节点必须是 JSON 对象')
    promoteDomainMappingSelectors(value as Record<string, unknown>)
    return value as Record<string, unknown>
  } catch (error) {
    parseError.value = errorMessage(error)
    validation.value = null
    return null
  }
}

function syncStructuredFromSource(): boolean {
  const content = parseSource()
  if (!content) return false
  syncingConfig = true
  config.value = normalizeConfig(content)
  source.value = serializeConfig(config.value)
  syncingConfig = false
  return true
}

async function activateMode(nextMode: ConfigEditorMode): Promise<void> {
  if (mode.value === nextMode) return
  if (!await confirmLocalDiscard()) return
  if (mode.value === 'json' && nextMode !== 'json' && !syncStructuredFromSource()) {
    toast.error('JSON 解析失败，修正后才能切换视图')
    return
  }
  mode.value = nextMode
  resetLocalState()
}

async function confirmLocalDiscard(): Promise<boolean> {
  return solutionEditor.value?.confirmDiscard() ?? true
}

function resetLocalState(): void {
  localDraftDirty.value = false
  focusedEditing.value = false
  workspaceKey.value += 1
}

async function activateSection(nextSection: typeof section.value): Promise<void> {
  if (section.value === nextSection && mode.value === 'structured') return
  if (!await confirmLocalDiscard()) return
  if (mode.value === 'json' && !syncStructuredFromSource()) {
    toast.error('JSON 解析失败，修正后才能切换分类')
    return
  }
  resetLocalState()
  section.value = nextSection
  mode.value = 'structured'
  manualMode.value = false
}

function openManual(target?: string | RuntimeTarget): void {
  manualFocus.value = typeof target === 'string' ? { pipeline: target } : target ?? null
  manualMode.value = true
  resetLocalState()
}

// 出错信息里的对象链接：切到自由编辑，展开那个 Pipeline、滚到那条规则（规范 8.4）
// An object link in an error: switch to 自由编辑, open that Pipeline and scroll to the rule (spec 8.4)
async function navigateTo(target: RuntimeTarget): Promise<void> {
  if (!await confirmLocalDiscard()) return
  if (mode.value === 'json' && !syncStructuredFromSource()) return
  section.value = 'pipeline'
  mode.value = 'structured'
  openManual(target)
}

async function reload(): Promise<void> {
  if (await confirmDiscard()) void load()
}

// quiet：保存之后的刷新不换成骨架，编辑器不重建，人还停在刚才那一组、那一个入口。
// quiet: the refresh after a save keeps the editor mounted rather than swapping in the skeleton,
// so the person stays on the group or entry they were on.
function load(options: { quiet?: boolean } = {}): Promise<void> {
  if (pendingLoad) return pendingLoad
  if (!options.quiet) loading.value = true
  pendingLoad = (async () => {
    const [nextDocument, history, overview, service] = await Promise.all([
      apiRequest<ConfigDocument>('/api/v1/config'),
      apiRequest<ConfigVersions>('/api/v1/config/versions'),
      apiRequest<Overview>('/api/v1/overview').catch((error: unknown) => {
        capabilityError.value = friendlyRuntimeError(error)
        return null
      }),
      apiRequest<ServiceStatus>('/api/v1/service').catch(() => null),
    ])
    const declaredCapabilities = nextDocument.runtime.declared_capabilities ?? []
    if (overview) {
      runtimeStopped.value = !overview.live
        && (service?.active_state === 'inactive' || overview.service_active === false)
      runtimeCapabilities.value = overview.live ? overview.health.capabilities : declaredCapabilities
      capabilityError.value = overview.live || declaredCapabilities.length > 0 ? '' : 'KixDNS 实时能力暂不可用'
    } else {
      runtimeStopped.value = service?.active_state === 'inactive'
      runtimeCapabilities.value = declaredCapabilities
      if (!runtimeStopped.value && !capabilityError.value && declaredCapabilities.length === 0) {
        capabilityError.value = 'KixDNS 实时能力暂不可用'
      }
    }
    document.value = nextDocument
    versions.value = history.versions
    selectedVersionIds.value = []
    syncingConfig = true
    config.value = normalizeConfig(nextDocument.content)
    source.value = serializeConfig(config.value)
    baseline.value = source.value
    syncingConfig = false
    validation.value = null
    resetLocalState()
    previewVersion.value = null
    loadError.value = ''
  })().catch((error: unknown) => {
    loadError.value = errorMessage(error)
  }).finally(() => {
    loading.value = false
    pendingLoad = null
  })
  return pendingLoad
}

// 检查器里还有没应用的修改时，保存和校验先替人按一下「应用到草稿」：表单完整就接着走，缺东西就停在检查器里标出来（规范第 11 节）
// With unapplied inspector edits, save and validate first press 应用到草稿 for you: a complete form goes on, a gap stops in the inspector, marked (spec section 11)
async function applyPendingEdit(): Promise<boolean> {
  if (!localDraftDirty.value) return true
  if (!solutionEditor.value?.applyPending()) return false
  await nextTick()
  return true
}

async function validate(): Promise<ValidationResult | null> {
  if (!await applyPendingEdit()) return null
  const content = parseSource()
  if (!content) return null
  if (deferSave.value) {
    toast.info('KixDNS 当前未启动或无法确认能力，保存后将作为待应用版本保留')
    return null
  }
  validating.value = true
  saveOrigin.value = 'draft'
  startStage('checking')
  try {
    validation.value = await apiRequest<ValidationResult>('/api/v1/config/validate', {
      method: 'POST',
      ...jsonBody(content),
    })
    finishStage('idle')
    return validation.value
  } catch (error) {
    saveVerdict.value = '没有通过校验'
    finishStage('failed', friendlyRuntimeError(error))
    return null
  } finally {
    validating.value = false
  }
}

// origin：保存草稿（保存栏报进度）或应用已经保存的版本（页头报进度，出错进提示）。
// 有改动、或者要应用和运行配置不同的文件，而且 KixDNS 在运行时，先单独校验一次：没过就停在第 1 步，不写入任何版本。
// origin: saving the draft (the save bar reports) or applying a saved version (the header reports, errors go
// to a notice). With changes, or a file that differs from what runs, and KixDNS running, validate on its own
// first: a failure stops at step 1 with no version written.
async function save(origin: 'draft' | 'apply' = 'draft'): Promise<void> {
  // 按钮在忙时不禁用（保持墨色），所以这里挡住重复的一次。 / The busy button is not disabled (it stays ink), so a repeat press is stopped here.
  if (saving.value || saveBusy.value || !document.value || !canSave.value) return
  if (origin === 'draft' && !await applyPendingEdit()) return
  const content = parseSource()
  if (!content) return
  saving.value = true
  saveOrigin.value = origin
  applyError.value = ''
  const checkFirst = (changed.value || fileDiffers.value) && !deferSave.value
  let stage: SaveStage = checkFirst ? 'validating' : 'applying'
  startStage(stage)
  try {
    if (checkFirst) {
      validation.value = await apiRequest<ValidationResult>('/api/v1/config/validate', { method: 'POST', ...jsonBody(content) })
      stage = 'applying'
      saveStage.value = stage
    }
    const result = await apiRequest<ConfigApplyResult>('/api/v1/config', {
      method: 'PUT',
      ...jsonBody({ content, expected_sha256: document.value.sha256, message: message.value.trim() }),
    })
    validation.value = result.validation ?? validation.value
    const note = applyResultState(result) === 'pending'
      ? `已存成待应用版本 #${result.version_id}，KixDNS 就绪后自动应用`
      : `已生效\u00a0· 版本 #${result.version_id}`
    message.value = ''
    noteOpen.value = false
    for (const id of draftNoticeIds.splice(0)) toast.dismiss(id)
    await load({ quiet: true })
    finishStage('done', note)
  } catch (error) {
    const reason = friendlyRuntimeError(error)
    saveVerdict.value = stage === 'validating' ? '没有通过校验' : '没有保存成功'
    finishStage('failed', reason)
    if (shouldRefreshAfterSaveError(error)) await load({ quiet: true })
    // 应用失败时服务端记下了原因，提示会从运行状态里读出来；没记下的（例如文件没过校验）放进提示
    // When the server recorded the failure the notice reads it from the runtime state; otherwise (e.g. the file failed validation) it goes in the notice here
    if (origin === 'apply' && !hasApplyFailure.value) applyError.value = `${stage === 'validating' ? '磁盘上的配置没有通过校验' : '没有应用成功'}\n${reason}`
  } finally {
    saving.value = false
  }
}

function applyNow(): void {
  void save('apply')
}

// 以前的模板把 GeoSite 分类写成了 geosite:cn（PR 146）：内核照原样查标签，这样的条件永远匹配不上。
// 打开配置时数出来，提示里一键去掉前缀，改动进草稿、照常保存。
// Earlier templates wrote GeoSite categories as geosite:cn (PR 146); the kernel looks the tag up as written, so such
// conditions never match. They are counted when the config opens and the notice strips the prefix in one click,
// into the draft, saved as usual.
function prefixedGeoSite(value: KixConfig | null): MatcherConfig[] {
  if (!value) return []
  const matchers = [
    ...value.pipeline_select.flatMap((selector) => selector.matchers),
    ...value.pipelines.flatMap((pipeline) => pipeline.rules.flatMap((rule) => [...rule.matchers, ...rule.response_matchers])),
  ]
  return matchers.filter((matcher) => isGeoSiteMatcher(matcher) && typeof matcher.value === 'string' && /^geosite:/i.test(matcher.value.trim()))
}
const geoSitePrefixCount = computed(() => (mode.value === 'json' ? 0 : prefixedGeoSite(config.value).length))
function dropGeoSitePrefixes(): void {
  for (const matcher of prefixedGeoSite(config.value)) matcher.value = String(matcher.value).trim().replace(/^geosite:/i, '')
  draftNotice('已去掉 GeoSite 分类的 geosite: 前缀，保存配置后生效')
}

// 页头下面的提示一次只一条（规范第 8 节）：一句结论、一行原因、最多一个动作。
// One notice at a time under the header (spec section 8): a verdict, a reason line, at most one action.
interface Notice { tone: 'err' | 'off'; icon: Component; title: string; reason?: string; action?: string; run?: () => void }
const notice = computed<Notice | null>(() => {
  if (loadError.value && document.value) return { tone: 'err', icon: CircleAlert, title: '读取配置失败，下面是上一次读到的内容。', reason: loadError.value, action: '重试', run: () => void reload() }
  if (hasApplyFailure.value) {
    const reason = document.value?.runtime.pending_error || document.value?.pending?.error || 'KixDNS 没有给出原因。'
    return {
      tone: 'err',
      icon: CircleAlert,
      title: pendingVersionId.value ? `KixDNS 没有接受版本 #${pendingVersionId.value}，仍在用之前那份配置。` : 'KixDNS 没有接受上次保存的版本，仍在用之前那份配置。',
      reason: friendlyRuntimeMessage(reason),
      // 草稿有修改时不给「重试应用」：那时保存的是草稿，重试会把草稿当成失败的那个版本发出去
      // No retry while the draft has changes: saving then sends the draft, not the version that failed
      action: canApplyNow.value && !changed.value ? '重试应用' : undefined,
      run: applyNow,
    }
  }
  if (applyError.value) {
    const [title, ...reason] = applyError.value.split('\n')
    return { tone: 'err', icon: CircleAlert, title: `${title}。`, reason: reason.join('\n') }
  }
  if (geoSitePrefixCount.value) return { tone: 'err', icon: CircleAlert, title: `${geoSitePrefixCount.value} 个 GeoSite 条件带着 geosite: 前缀，内核照原样查分类名，这几条永远匹配不上。`, action: '去掉前缀', run: dropGeoSitePrefixes }
  // 没运行、连不上时页头已经说了，功能列表拿不到是它的结果，不另起一条（评审 N9）
  // When stopped or unreachable the header says so; the missing feature list follows from it and gets no notice of its own (review N9)
  if (capabilityError.value && !runtimeStopped.value && !runtimeUnavailable.value) return { tone: 'off', icon: Info, title: 'KixDNS 没有报告它支持哪些功能，新功能先按不支持处理。' }
  if (unsupportedFields.value.length) return { tone: 'off', icon: Info, title: `当前内核不支持：${unsupportedFields.value.join('、')}，这几项保留原样。` }
  return null
})

async function restore(version: ConfigVersion): Promise<void> {
  if (!document.value) return
  const unsaved = changed.value || localDraftDirty.value
  // 恢复是可回退的：当前配置仍留在历史里。所以不用红色主按钮。
  if (!await confirm.ask({
    title: `恢复到配置版本 #${version.id}`,
    body: `${unsaved ? '编辑器中未保存的修改会丢失。\n' : ''}当前已保存的配置仍会保留在历史记录中，随时可以再恢复回来。`,
    confirmLabel: `恢复 #${version.id}`,
  })) return
  restoring.value = version.id
  try {
    const result = await apiRequest<ConfigApplyResult>(`/api/v1/config/versions/${version.id}/restore`, {
      method: 'POST',
      ...jsonBody({ expected_sha256: document.value.sha256 }),
    })
    if (applyResultState(result) === 'pending') {
      toast.info(`版本 #${version.id} 已保存为待应用版本`)
    } else {
      toast.success(`版本 #${version.id} 已恢复，当前版本 #${result.version_id}`)
    }
    await load()
  } catch (error) {
    // 原因去掉了「KixDNS 拒绝操作：」，这里补上结论，提示才说得清是哪件事没成（审计第四轮 C5）
    // The reason has lost 「KixDNS 拒绝操作：」, so the toast carries the verdict itself and says what failed (audit round 4, C5)
    toast.error(`没有恢复版本 #${version.id}：${friendlyRuntimeError(error)}`)
  } finally {
    restoring.value = null
  }
}

async function deleteVersion(version: ConfigVersion): Promise<void> {
  if (!document.value) return
  if (version.id === currentVersionId.value) {
    toast.error('当前生效版本不能删除，请先恢复其他版本')
    return
  }
  if (!await confirm.ask({
    title: `删除配置版本 #${version.id}`,
    body: '这份配置的完整内容会被移除，之后无法恢复或对比。当前生效的版本和编辑器里的草稿都不受影响。',
    items: [`#${version.id}\u00a0· ${version.message || '未填写备注'}`],
    confirmLabel: '删除这个版本',
    destructive: true,
  })) return
  deleting.value = version.id
  try {
    const removesDesired = version.id === pendingVersionId.value
      || version.apply_state === 'pending'
      || version.apply_state === 'failed'
    await apiRequest<DeleteConfigVersionResult>(`/api/v1/config/versions/${version.id}`, {
      method: 'DELETE',
      ...jsonBody({ expected_sha256: document.value.sha256 }),
    })
    if (removesDesired) {
      await load()
    } else {
      const history = await apiRequest<ConfigVersions>('/api/v1/config/versions')
      versions.value = history.versions
      selectedVersionIds.value = selectedVersionIds.value.filter((versionId) => versionId !== version.id)
    }
    toast.success(`配置版本 #${version.id} 已删除`)
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    deleting.value = null
  }
}

function toggleVersionSelection(versionId: number): void {
  if (versionId === currentVersionId.value) return
  selectedVersionIds.value = selectedVersionIds.value.includes(versionId)
    ? selectedVersionIds.value.filter((selectedId) => selectedId !== versionId)
    : [...selectedVersionIds.value, versionId]
}

async function deleteSelectedVersions(): Promise<void> {
  if (!document.value || selectedVersionIds.value.length === 0) return
  const ids = [...selectedVersionIds.value]
  if (!await confirm.ask({
    title: `删除 ${ids.length} 个历史版本`,
    body: '这些配置的完整内容会被移除，之后无法恢复或对比。当前生效的版本和编辑器里的草稿都不受影响。',
    items: versions.value.filter((item) => ids.includes(item.id)).map((item) => `#${item.id}\u00a0· ${item.message || '未填写备注'}`),
    confirmLabel: `删除 ${ids.length} 个版本`,
    destructive: true,
  })) return
  bulkDeleting.value = true
  try {
    const removesDesired = versions.value.some((version) => ids.includes(version.id)
      && (version.id === pendingVersionId.value
        || version.apply_state === 'pending'
        || version.apply_state === 'failed'))
    const result = await apiRequest<DeleteConfigVersionsResult>('/api/v1/config/versions/bulk', {
      method: 'DELETE',
      ...jsonBody({ ids, expected_sha256: document.value.sha256 }),
    })
    selectedVersionIds.value = []
    if (removesDesired) {
      await load()
    } else {
      const history = await apiRequest<ConfigVersions>('/api/v1/config/versions')
      versions.value = history.versions
    }
    toast.success(`已删除 ${result.deleted_ids.length} 个配置版本`)
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    bulkDeleting.value = false
  }
}

async function openVersionDiff(version: ConfigVersion, event?: MouseEvent): Promise<void> {
  // 从「…」菜单进来时焦点已经回到了菜单按钮上 / From the … menu, focus is already back on its button
  const trigger = event?.currentTarget ?? window.document.activeElement
  previewTrigger.value = trigger instanceof HTMLElement ? trigger : null
  previewing.value = version.id
  try {
    // 版本历史保持打开：差异框叠在它上面，关掉后回到原来那个按钮，接着比较下一个版本。
    // The history stays open: the diff stacks on top, and closing it returns to
    // the same button, ready to compare the next version.
    previewVersion.value = await apiRequest<ConfigVersionDetail>(`/api/v1/config/versions/${version.id}`)
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    previewing.value = null
  }
}

// 比较对话框底栏的「恢复为版本 #17」：关掉比较，走和菜单里一样的恢复（先确认）
// 恢复为版本 #17 in the comparison's footer: close it and restore as the menu does (after confirming)
async function restoreFromDiff(): Promise<void> {
  const version = versions.value.find((item) => item.id === previewVersion.value?.id)
  previewVersion.value = null
  if (version) await restore(version)
}

function closeHistory(): void {
  historyOpen.value = false
  historySelecting.value = false
  selectedVersionIds.value = []
}

function toggleSelecting(): void {
  historySelecting.value = !historySelecting.value
  if (!historySelecting.value) selectedVersionIds.value = []
}

const versionBusy = computed(() => restoring.value !== null || deleting.value !== null || bulkDeleting.value || saving.value || validating.value)

// 历史里每一行的「…」：比较、恢复、删除（危险项放最后）；当前版本没有这个菜单（规范 3.8）
// Each history row's …: compare, restore, delete (destructive last); the current version has none (spec 3.8)
function versionMenu(): UiMenuItem[] {
  return [
    { value: 'compare', label: '和当前比较', icon: GitCompare, disabled: previewing.value !== null },
    { value: 'restore', label: '恢复为这个版本', icon: RotateCcw, disabled: versionBusy.value },
    { value: 'delete', label: '删除这个版本', icon: Trash2, danger: true, disabled: versionBusy.value },
  ]
}

function onVersionMenu(version: ConfigVersion, value: string): void {
  if (value === 'compare') void openVersionDiff(version)
  else if (value === 'restore') void restore(version)
  else if (value === 'delete') void deleteVersion(version)
}

// 恢复、删除要等服务端：那一行换成「恢复中 · 已用 1.2 秒」，一秒以后才写用时（规范第 8 节）
// Restore and delete wait on the server: the row becomes 恢复中 · 已用 1.2 秒, the time shown after one second (spec section 8)
const opStartedAt = ref(0)
const opClock = ref(0)
let opTimer: ReturnType<typeof setInterval> | undefined
watch(() => restoring.value ?? deleting.value, (id) => {
  clearInterval(opTimer)
  if (id === null) return
  opStartedAt.value = Date.now()
  opClock.value = opStartedAt.value
  opTimer = setInterval(() => { opClock.value = Date.now() }, 100)
})
const opLabel = computed(() => {
  const seconds = (opClock.value - opStartedAt.value) / 1000
  const verb = restoring.value !== null ? '恢复中' : '删除中'
  return seconds >= 1 ? `${verb}\u00a0· 已用 ${seconds.toFixed(1)} 秒` : verb
})

// ⌘/Ctrl+S 等于点保存栏的主要按钮；在配置页上总是拦下浏览器的「保存网页」（规范 2.11）
// ⌘/Ctrl+S presses the save bar's primary button; on this page it always stops the browser's "save page" (spec 2.11)
function onShortcut(event: KeyboardEvent): void {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's') return
  event.preventDefault()
  if (savebarVisible.value && canSave.value && !saveBusy.value && !jsonProblem.value && !focusedEditing.value) void save()
}

// 工作台和 JSON 编辑器正好填满视口：从它们在页面里的上沿量到视口底，减去页边距；保存栏出现时再减去它自己的高度。
// 两个数都是量出来的：提示、状态行换行都会改变上沿，保存栏在手机上有一行、两行、四行不等（审计 A2、S4、S8、V4）。
// The workbench and the JSON editor fill the viewport exactly: measured from their top edge in the page to the
// viewport's bottom, less the page margin, less the save bar's own height while it shows. Both numbers are measured:
// a notice or a wrapping status line moves the top edge, and the phone bar runs one to four rows (audits A2, S4, S8, V4).
const pageRoot = ref<HTMLElement | null>(null)
const workbenchDocument = ref<HTMLElement | null>(null)
let layoutObserver: ResizeObserver | undefined
function measureLayout(): void {
  const page = pageRoot.value
  const documentBox = workbenchDocument.value
  if (!page) return
  const bar = page.querySelector<HTMLElement>('.config-savebar')
  const barHeight = bar ? bar.getBoundingClientRect().height : 0
  page.style.setProperty('--savebar-h', `${Math.ceil(barHeight)}px`)
  // 刚保存完那一刻撑住的高度用带小数的原值：取整后的值会让栏高出 1 像素、上沿跳一下（审计第五轮 S1）
  // The just-saved bar holds the exact height: the rounded-up value made it 1px taller and its top edge jumped (audit round 5, S1)
  page.style.setProperty('--savebar-h-exact', `${barHeight}px`)
  if (documentBox) page.style.setProperty('--wb-top', `${Math.round(documentBox.getBoundingClientRect().top + window.scrollY)}px`)
  // 第一次量完之后才让高度变化带过渡：打开页面时不从估计值滑到实际值 / Height changes animate only after the first measurement, so the page never slides from the estimate on open
  if (!page.dataset.measured) requestAnimationFrame(() => { page.dataset.measured = 'true' })
}
watch(pageRoot, (page) => {
  layoutObserver?.disconnect()
  if (!page) return
  layoutObserver = new ResizeObserver(measureLayout)
  layoutObserver.observe(page)
  measureLayout()
})

// 保存栏出现时，滚动留白加上它的高度，正在输入的字段不能被它挡住（规范 8.2）。
// JSON 编辑器自己把光标行滚进视野，不去滚整页（审计 V4）。
// 看的是栏真正露出来：手机上检查器全屏编辑时栏收着，这时量到的高度是 0，留白会变成一整屏
// When the save bar appears, scroll padding grows by its height so the focused field is never under it (spec 8.2).
// The JSON editor keeps its own caret line in view and never scrolls the page (audit V4).
// It follows the bar actually showing: while the phone inspector edits full screen the bar is folded away, measures 0 and
// would turn the padding into a whole screen
const savebarShown = computed(() => savebarVisible.value && !focusedEditing.value)
watch(savebarShown, async (visible) => {
  await nextTick()
  const root = window.document.documentElement
  const bar = window.document.querySelector<HTMLElement>('.config-savebar')
  if (bar) layoutObserver?.observe(bar)
  measureLayout()
  if (!visible || !bar) {
    root.style.scrollPaddingBottom = ''
    return
  }
  const box = bar.getBoundingClientRect()
  root.style.scrollPaddingBottom = `${Math.ceil(window.innerHeight - box.top) + 16}px`
  const active = window.document.activeElement
  if (active instanceof HTMLElement && active !== window.document.body && !active.closest('.cm-editor') && active.getBoundingClientRect().bottom > box.top) active.scrollIntoView({ block: 'nearest' })
})

async function importFile(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    if (!await confirmDiscard()) return
    if (file.size > 4 * 1024 * 1024) throw new Error('配置文件不能超过 4 MiB')
    // 导入会整份替换掉草稿。它纯粹是本地状态，所以撤销是真能撤的——
    // 版本删除那类的「撤销」在服务端根本回不去，给了就是骗人。
    // The import replaces the whole draft. Being purely local state it really
    // can be undone, unlike something like deleting a version, where the server
    // cannot go back and offering "undo" would be a lie.
    const previous = source.value
    source.value = await file.text()
    if (!syncStructuredFromSource()) {
      mode.value = 'json'
      source.value = previous
      syncStructuredFromSource()
      throw new Error(parseError.value || 'JSON 解析失败')
    }
    mode.value = 'structured'
    resetLocalState()
    toast.undoable(`已导入 ${file.name}`, () => {
      source.value = previous
      syncStructuredFromSource()
      resetLocalState()
    })
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    input.value = ''
  }
}

function downloadJson(): void {
  if (!parseSource()) return
  const blob = new Blob([source.value], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = 'pipeline.json'
  anchor.click()
  URL.revokeObjectURL(url)
}

onBeforeRouteLeave(confirmDiscard)
onMounted(() => {
  window.addEventListener('beforeunload', preventAccidentalClose)
  window.addEventListener('keydown', onShortcut)
  void load()
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', preventAccidentalClose)
  window.removeEventListener('keydown', onShortcut)
  window.document.documentElement.style.scrollPaddingBottom = ''
  clearInterval(opTimer)
  layoutObserver?.disconnect()
})
</script>

<template>
  <div ref="pageRoot" class="page config-page workbench-page" :class="{ 'workbench-page--editing': focusedEditing, 'has-savebar': savebarVisible }">
    <UiPageHeader class="config-heading" title="配置" :inert="focusedEditing">
      <!-- 页头状态行：KixDNS 现在怎样，需要时带一个动作；应用进行中时写进度（规范第 8 节）
           The status line: how KixDNS is, with one action when needed, and progress while applying (spec section 8) -->
      <!-- 读取期间状态行先占住位置，数据回来时下面的页签和工作台不往下跳（审计 B10）
           While loading, the status line keeps its box so the tabs and workbench do not drop when data arrives (audit B10) -->
      <template #meta>
        <template v-if="document">
          <!-- 状态点和转圈共用一个 14 的格子：换成「应用中」时后面的字不挪（审计第三轮 S3） / The dot and the spinner share one 14 slot, so the words after it stay put when 应用中 starts (audit round 3, S3) -->
          <span class="config-head-mark" aria-hidden="true"><span v-if="applyBusy" class="ui-spin config-head-spin"></span><span v-else class="ui-dot" :class="headerLine.tone === 'ok' ? '' : `ui-dot--${headerLine.tone}`"></span></span>
          <!-- 一整句：分隔点跟着前一段，不会出现在行首（审计 S2、S11）；折行落在它后面时藏起来，也不挂在行尾（line-dots.ts）
               One run: the separator travels with the segment before it, so it never starts a line (audits S2, S11); when a wrap falls right after it, it is hidden, so it never ends one either (line-dots.ts) -->
          <span v-line-dots class="config-head-line" :role="applyBusy ? 'status' : undefined"><template v-if="headerLine.lead"><span class="config-head-seg">{{ headerLine.lead }}<span data-line-dot>&nbsp;·</span></span>{{ ' ' }}</template><span class="config-head-seg">{{ headerLine.before }}<UiNumber v-if="headerLine.version" :value="String(headerLine.version)" />{{ headerLine.after }}<span v-if="(applyBusy && saveElapsed) || (headerAction && !applyBusy)" data-line-dot>&nbsp;·</span></span><template v-if="applyBusy && saveElapsed">{{ ' ' }}<span class="config-head-seg">{{ saveElapsed }}</span></template><template v-else-if="headerAction && !applyBusy">{{ ' ' }}<span class="config-head-seg"><button class="config-head-action" type="button" :disabled="saveBusy || loading" @click="applyNow">{{ headerAction }}</button></span></template></span>
        </template>
        <i v-else-if="loading" class="sk config-head-sk" aria-hidden="true"></i>
      </template>
      <template #actions><button class="ui-btn ui-btn--secondary" type="button" @click="historyOpen = true"><History :size="16" aria-hidden="true" />历史版本</button></template>
    </UiPageHeader>
    <!-- 提示一次只一条：一句结论、一行原因（对象是链接）、最多一个动作 / One notice: a verdict, a reason (objects are links), at most one action -->
    <div v-if="notice" class="ui-notice config-notice" :class="`ui-notice--${notice.tone}`" :role="notice.tone === 'err' ? 'alert' : 'status'" :inert="focusedEditing">
      <component :is="notice.icon" :size="16" aria-hidden="true" />
      <span>{{ notice.title }}</span>
      <small v-if="notice.reason"><RuntimeMessage :text="notice.reason" :config="config" @navigate="navigateTo" /></small>
      <button v-if="notice.action" class="ui-btn ui-btn--secondary ui-btn--sm ui-notice__action" type="button" :disabled="saveBusy || loading" @click="notice.run?.()">{{ notice.action }}</button>
    </div>
    <!-- 区块页签在卡片外面，和其他页一样；右边是看这份配置的方式和三个文件操作。
         Section tabs sit outside the card as on the other pages; on the right, how to view the config and three file actions. -->
    <div class="config-nav" :inert="focusedEditing">
      <!-- JSON 看的是整份配置，分类页签在这里回答不了任何问题，换成一个「完整配置」；回到表单时原来那个分类还选着（审计 V6）
           JSON shows the whole config, where the section tabs answer nothing, so one 完整配置 stands in their place;
           back in the form, the previous section is still selected (audit V6) -->
      <p v-if="mode === 'json'" class="config-sections config-sections--whole"><span>完整配置</span></p>
      <UiTabs v-else class="config-sections" :model-value="section" :items="sectionItems" label="配置分类" @update:model-value="activateSection($event as typeof section)" />
      <!-- 工具栏是常规尺寸：和「历史版本」一样 36，手机上 44（规范 2.1，审计 S7） / Toolbar controls take the regular size, 36 like 历史版本, 44 on a phone (spec 2.1, audit S7) -->
      <div class="config-tools">
        <UiTabs :model-value="mode" :items="modeItems" label="配置视图" variant="segment" @update:model-value="activateMode($event as ConfigEditorMode)" />
        <input ref="fileInput" class="visually-hidden" type="file" accept=".json,application/json" @change="importFile">
        <button class="ui-icon-btn" type="button" title="导入 JSON" aria-label="导入 JSON" :disabled="loading || saving" @click="fileInput?.click()"><FileUp :size="16" /></button>
        <button class="ui-icon-btn" type="button" title="下载 JSON" aria-label="下载 JSON" :disabled="loading" @click="downloadJson"><Download :size="16" /></button>
        <button class="ui-icon-btn" type="button" title="重新读取配置" aria-label="重新读取配置" :disabled="loading || saving || restoring !== null || deleting !== null || bulkDeleting" @click="reload"><RefreshCw :size="16" :class="{ spin: loading }" /></button>
      </div>
    </div>
    <div ref="workbenchDocument" class="workbench-document">
      <section class="editor-panel workbench-document-panel">
        <nav v-if="section === 'pipeline' && mode === 'structured' && manualMode" class="workbench-manual-bar" aria-label="位置">
          <button class="ui-btn ui-btn--text ui-btn--sm workbench-manual-back" type="button" @click="manualMode = false"><ArrowLeft :size="14" aria-hidden="true" />解析编排</button>
          <span class="workbench-manual-sep" aria-hidden="true">/</span>
          <span aria-current="page">自由编辑</span>
        </nav>
        <!-- 读取失败又没有旧数据：一句原因、一个重试 / Failed with nothing to show: the reason and a retry -->
        <div v-if="!loading && !document" class="config-load-failed">
          <p class="config-load-failed__title">读取配置失败</p>
          <p v-if="loadError" class="config-load-failed__reason">{{ loadError }}</p>
          <button class="ui-btn ui-btn--secondary" type="button" @click="load()"><RefreshCw :size="16" aria-hidden="true" />重试</button>
        </div>
        <!-- 骨架按工作台的尺寸画：工具栏的搜索和两个按钮、一行说明、一行一个入口（序号加几行字，行数照上次的列表，见 list-shape.ts），
             检查器是头部加两组。每一行字的格子和真的一样高，数据到了以后东西不挪位置（规范 8、7.3，审计第三轮 B10、第五轮 B1）
             The skeleton is drawn to the workbench's measurements: the toolbar's search and two buttons, a note line, one entry per row
             (ordinal plus its lines, as many as the list had last time, see list-shape.ts), and an inspector header over two groups. Every
             text line's box is as tall as the real one, so nothing moves when the data arrives (spec 8 and 7.3, audit round 3 B10, round 5 B1) -->
        <div v-else-if="loading" class="config-skeleton" role="status" aria-label="正在读取配置">
          <div ref="skeletonList" class="config-skeleton__list">
            <div class="config-skeleton__toolbar"><i class="sk config-skeleton__search"></i><span class="config-skeleton__buttons"><i class="sk config-skeleton__button"></i><i class="sk config-skeleton__button"></i></span></div>
            <div class="config-skeleton__scroll">
              <span class="config-skeleton__line config-skeleton__note"><i class="sk"></i></span>
              <div class="config-skeleton__rows">
                <div v-for="([names, details], row) in skeletonRows" :key="row" class="config-skeleton__row">
                  <span class="config-skeleton__line config-skeleton__ord"><i class="sk"></i></span>
                  <span class="config-skeleton__body">
                    <span v-for="line in names" :key="`name-${line}`" class="config-skeleton__line config-skeleton__name"><i class="sk"></i></span>
                    <span v-for="line in details" :key="`detail-${line}`" class="config-skeleton__line config-skeleton__route" :class="{ 'config-skeleton__route--more': !rememberedRows && line > 1 }"><i class="sk"></i></span>
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div class="config-skeleton__inspector">
            <div class="config-skeleton__head"><span class="config-skeleton__line config-skeleton__title"><i class="sk"></i></span></div>
            <!-- 和打开的入口一样：一组条件、流程设置、一组动作、响应处理；窄的检查器里子项上下排，第二个框上面有字段名
                 Like an open entry: a condition group, 流程设置, an action group, 响应处理; in a narrow inspector the sub-item stacks with a label above its second box -->
            <div class="config-skeleton__form">
              <template v-for="n in 2" :key="n">
                <div class="config-skeleton__group">
                  <span class="config-skeleton__line config-skeleton__label"><i class="sk"></i></span>
                  <span class="config-skeleton__fields"><i class="sk config-skeleton__field"></i><span class="config-skeleton__line config-skeleton__vlabel"><i class="sk"></i></span><i class="sk config-skeleton__field"></i></span>
                  <span class="config-skeleton__line config-skeleton__add"><i class="sk"></i></span>
                </div>
                <span class="config-skeleton__line config-skeleton__label"><i class="sk"></i></span>
              </template>
            </div>
          </div>
        </div>
        <JsonEditor v-else-if="mode === 'json'" ref="jsonEditor" v-model="source" class="ui-fade" :error-line="parsePosition?.line" />
        <ConfigFlowPreview v-else-if="mode === 'flow' && config" class="ui-fade" :config="config" />
        <DomainMappingConfigEditor v-else-if="section === 'mapping' && config" v-model="config" class="ui-fade" :capabilities="runtimeCapabilities" />
        <StructuredConfigEditor v-else-if="config && (section === 'settings' || manualMode)" v-model="config" class="structured-editor--page ui-fade" :section="section === 'settings' ? 'settings' : 'pipeline'" :capabilities="runtimeCapabilities" :focus="manualFocus" :changed-settings="changedSettings" @notice="draftNotice($event)" />
        <DnsSolutionEditor v-else-if="config" :key="workspaceKey" ref="solutionEditor" v-model="config" class="ui-fade" :open-key="openEntryKey" :capabilities="runtimeCapabilities" :changed="changedKeys" @open="openEntryKey = $event" @manual="openManual" @mapping="activateSection('mapping')" @notice="draftNotice($event)" @dirty="localDraftDirty = $event" @editing="focusedEditing = $event" />
      </section>
    </div>

    <!-- 保存栏只说草稿：有修改才从下方升起，空闲时不在（规范 8.2）。主按钮是这一页唯一的主按钮。
         The save bar speaks only for the draft: it rises with changes and is gone when idle (spec 8.2). -->
    <Transition name="config-savebar">
      <footer v-if="savebarVisible" class="ui-savebar config-savebar" :class="{ 'ui-savebar--err': saveStage === 'failed' || Boolean(jsonProblem), 'config-savebar--reason': saveStage === 'failed', 'config-savebar--done': saveStage === 'done' }" :inert="focusedEditing">
        <p :key="saveStage === 'failed' ? `failed-${saveNote}` : 'state'" v-line-dots class="ui-savebar__status config-save-state" :class="{ 'ui-shake': saveStage === 'failed' }" :role="saveStage === 'failed' || jsonProblem ? 'alert' : 'status'">
          <svg v-if="saveStage === 'done'" class="ui-check config-save-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
          <!-- 完成的说明是「已生效 · 版本 #12」这样的一句，按「·」分段 / The done note is a sentence such as 「已生效 · 版本 #12」, split at its 「·」 -->
          <template v-if="saveStage === 'done'"><span class="ui-savebar__detail"><UiDotText :parts="saveNote.split('\u00a0· ')" /></span></template>
          <template v-else-if="saveStage === 'checking'"><span class="ui-savebar__detail">校验中</span></template>
          <template v-else-if="saveStage === 'validating'"><span class="ui-savebar__detail">第 1 步<span data-line-dot>&nbsp;·</span> 校验<span v-if="saveElapsed" class="ui-savebar__elapsed"><span data-line-dot>&nbsp;·</span> {{ saveElapsed }}</span></span></template>
          <template v-else-if="saveStage === 'applying'"><span class="ui-savebar__detail"><template v-if="deferSave">存成待应用版本</template><template v-else>第 2 步<span data-line-dot>&nbsp;·</span> 写入并热加载</template><span v-if="saveElapsed" class="ui-savebar__elapsed"><span data-line-dot>&nbsp;·</span> {{ saveElapsed }}</span></span></template>
          <template v-else-if="saveStage === 'failed'"><span class="ui-savebar__verdict">{{ saveVerdict }}</span><small><RuntimeMessage :text="saveNote" :config="config" @navigate="navigateTo" /></small></template>
          <template v-else-if="jsonProblem"><span class="ui-savebar__verdict">JSON 写错了</span><small><button v-if="parsePosition" class="ui-objlink ui-objlink--plain" type="button" @click="jsonEditor?.reveal(parsePosition.line, parsePosition.column)">第 {{ parsePosition.line }} 行第 {{ parsePosition.column }} 列</button><template v-if="parsePosition">：</template>{{ parseReason }}</small></template>
          <template v-else-if="localDraftDirty"><span class="ui-dot ui-dot--ink" aria-hidden="true"></span><span class="ui-savebar__detail"><template v-if="changeCount">已修改 <b class="ui-savebar__count"><UiNumber :value="String(changeCount)" /></b> 处</template><template v-else>有未保存的修改</template></span><small>入口的修改会一起保存</small></template>
          <template v-else-if="validation?.valid"><span class="ui-dot ui-dot--ink" aria-hidden="true"></span><span class="ui-savebar__detail">校验通过<span data-line-dot>&nbsp;·</span> {{ validation.pipeline_count }} 个 Pipeline、{{ validation.rule_count }} 条规则</span></template>
          <template v-else><span class="ui-dot ui-dot--ink" aria-hidden="true"></span><span class="ui-savebar__detail"><template v-if="changeCount">已修改 <b class="ui-savebar__count"><UiNumber :value="String(changeCount)" /></b> 处</template><template v-else>有未保存的修改</template></span><small v-if="deferNote">{{ deferNote }}</small></template>
        </p>
        <template v-if="saveStage !== 'done' && (changed || localDraftDirty)">
          <!-- 保存中只留步骤、用时和「保存中」：备注框和「校验」这时都不能用，让开；写了备注就留一行字（审计 S3）。
               手机上它们留着位置、只是看不见，保存按钮不在手指下面变宽（审计第三轮 S1）
               While saving only the step, the time and 保存中 remain: the note field and 校验 cannot be used then and step
               aside; a typed note stays as plain text (audit S3). On a phone they keep their place, only unseen, so the save
               button never widens under the finger (audit round 3, S1) -->
          <span v-if="saveRunning && message" class="config-save-note">{{ message }}</span>
          <button class="ui-btn ui-btn--text config-note-toggle" :class="{ 'is-aside': saveRunning }" type="button" :inert="saveRunning" :aria-expanded="noteOpen || Boolean(message)" @click="noteOpen = !noteOpen">备注<ChevronDown class="ui-btn__chev" :size="16" aria-hidden="true" /></button>
          <label class="ui-input ui-savebar__note config-message" :class="{ 'is-open': noteOpen || Boolean(message), 'is-aside': saveRunning }" :inert="saveRunning"><input v-model="message" aria-label="版本备注" maxlength="160" placeholder="版本备注（可选）"></label>
          <button v-if="!deferSave" class="ui-btn ui-btn--secondary" :class="{ 'is-aside': saveRunning }" type="button" :inert="saveRunning" :disabled="validating || Boolean(jsonProblem)" @click="validate"><ShieldCheck :size="16" aria-hidden="true" />校验</button>
          <button class="ui-btn ui-btn--primary config-save-button" type="button" :class="{ 'is-busy': saveBusy }" :disabled="!saveBusy && (loading || validating || !canSave || Boolean(jsonProblem))" :aria-busy="saveBusy ? 'true' : undefined" @click="save()"><span v-if="saveBusy" class="ui-spin" aria-hidden="true"></span>{{ saveLabel }}</button>
        </template>
      </footer>
    </Transition>

    <!-- 历史版本是浏览面：一行是备注加「#17 · 昨天 18:46」，点行就打开比较；恢复和删除进行尾的「…」（规范 3.8）
         History is a browse surface: a row is the note plus #17 · 昨天 18:46, a click opens the comparison; restore and delete live in the row's … (spec 3.8) -->
    <dialog v-if="historyOpen" ref="historyDialog" class="config-drawer" :class="{ 'is-covered': Boolean(previewVersion) }" aria-labelledby="config-history-title" @click.self="closeHistory" @cancel.prevent="closeHistory">
      <aside class="config-drawer__panel">
        <header class="config-drawer__head">
          <h2 id="config-history-title">历史版本</h2>
          <button v-if="deletableVersionIds.length" class="ui-btn ui-btn--text" type="button" :aria-pressed="historySelecting" @click="toggleSelecting">{{ historySelecting ? '完成' : '选择' }}</button>
          <button class="ui-icon-btn" type="button" aria-label="关闭历史版本" title="关闭历史版本" @click="closeHistory"><X :size="16" /></button>
        </header>
        <ol class="config-history" :class="{ 'is-selecting': historySelecting }">
          <!-- 当前版本只用「当前」这一个标记，不再加底色和左边线（审计 D15）；选择模式下点整行都能勾选（审计 D3）
               The current version carries the 当前 tag alone, no band or rule (audit D15); in select mode the whole row toggles (audit D3) -->
          <li v-for="version in versions" :key="version.id" class="ui-rec config-history__row" :class="{ 'is-picked': selectedVersionIds.includes(version.id) }">
            <span v-if="historySelecting && version.id !== currentVersionId" class="ui-checkbox config-history__check"><input :id="`config-version-${version.id}`" type="checkbox" :aria-label="`选择版本 #${version.id}`" :checked="selectedVersionIds.includes(version.id)" :disabled="bulkDeleting" @change="toggleVersionSelection(version.id)"><i aria-hidden="true"></i></span>
            <span v-else-if="historySelecting" class="config-history__check" aria-hidden="true"></span>
            <label v-if="historySelecting && version.id !== currentVersionId" class="config-history__main" :for="`config-version-${version.id}`">
              <span class="config-history__note">{{ version.message || '未填写备注' }}</span>
              <span v-line-dots class="config-history__meta">#{{ version.id }}<span data-line-dot>&nbsp;·</span> {{ formatVersionTime(version.created_at) }}</span>
            </label>
            <component :is="version.id === currentVersionId || historySelecting ? 'div' : 'button'" v-else class="config-history__main" :type="version.id === currentVersionId || historySelecting ? undefined : 'button'" :title="version.id === currentVersionId || historySelecting ? undefined : `比较版本 #${version.id} 和当前`" @click="version.id !== currentVersionId && !historySelecting && openVersionDiff(version, $event)">
              <span class="config-history__note">{{ version.message || '未填写备注' }}</span>
              <span v-line-dots class="config-history__meta">#{{ version.id }}<span data-line-dot>&nbsp;·</span> {{ formatVersionTime(version.created_at) }}</span>
            </component>
            <!-- 行尾一格：标签和「…」放在一起，选择模式切换时「当前」不挪位置（审计 D25） / One end cell for the tag and …, so 当前 stays put when select mode toggles (audit D25) -->
            <span class="config-history__end">
              <span v-if="(restoring ?? deleting) === version.id" class="ui-tag config-history__busy" role="status"><span class="ui-spin" aria-hidden="true"></span>{{ opLabel }}</span>
              <span v-else-if="version.id === currentVersionId" class="ui-tag ui-tag--ok">当前</span>
              <span v-else-if="version.apply_state === 'failed'" class="ui-tag ui-tag--err">失败</span>
              <span v-else-if="version.id === pendingVersionId || version.apply_state === 'pending'" class="ui-tag ui-tag--warn">待应用</span>
              <UiMenu v-if="version.id !== currentVersionId && !historySelecting" class="config-history__menu" anchor=".config-history__row" size="md" :label="`版本 #${version.id} 操作`" :title="`#${version.id} · ${version.message || '未填写备注'}`" :items="versionMenu()" @select="onVersionMenu(version, $event)" />
            </span>
            <small v-if="version.apply_error" class="config-history__error"><RuntimeMessage :text="friendlyRuntimeMessage(version.apply_error)" :config="config" @navigate="closeHistory(); navigateTo($event)" /></small>
          </li>
          <li v-if="versions.length === 0" class="config-history__empty">还没有保存过版本</li>
        </ol>
        <!-- 底栏只有一个按钮，数目写在按钮里，不再另起一句「已选 N 个」（审计 D14、D26） / One button; the count lives in its label, no separate 已选 N 个 (audits D14, D26) -->
        <footer v-if="historySelecting" class="config-drawer__foot">
          <button class="ui-btn ui-btn--danger" type="button" :disabled="selectedVersionIds.length === 0 || versionBusy" @click="deleteSelectedVersions"><Trash2 :size="16" aria-hidden="true" />{{ selectedVersionIds.length ? `删除 ${selectedVersionIds.length} 个版本` : '删除所选' }}</button>
        </footer>
      </aside>
    </dialog>
    <ConfigVersionDiffDialog v-if="previewVersion && document" :current="document.content" :version="previewVersion" :return-focus="previewTrigger" @close="previewVersion = null" @restore="restoreFromDiff" />
  </div>
</template>

<style scoped>
/* 配置页的外框只用 tokens.css 的变量。三件事各说一次（规范第 8 节）：页头状态行说 KixDNS 现在怎样，
   提示说有个问题你要知道，保存栏只说草稿。
   The page frame uses tokens only. Three things, each said once (spec section 8): the header's status
   line says how KixDNS is, a notice says there is a problem to know about, the save bar speaks only for the draft. */
.workbench-page { display: grid; gap: var(--s-4); align-content: start; }
/* 状态行里的动作：和状态同一行、同一字号的文字按钮 / The status line's action: a text button on the same line, same size */
.config-head-action { padding: 0; border: 0; background: none; color: var(--l-ink); font: inherit; font-weight: var(--w-medium); text-decoration: underline; text-decoration-color: var(--l-line-strong); text-underline-offset: 3px; cursor: pointer; }
.config-head-action:hover:not(:disabled) { text-decoration-color: var(--l-ink); }
.config-head-action:disabled { color: var(--l-ink-3); cursor: default; }
.config-head-mark { width: var(--size-icon-sm); height: var(--size-icon-sm); flex: 0 0 auto; display: inline-grid; place-items: center; translate: 0 -1px; }
.config-head-spin { width: var(--size-icon-sm); height: var(--size-icon-sm); }
.config-head-line { min-width: 0; font-variant-numeric: tabular-nums; }
/* 句子只在「·」后面断行，一段话本身不拆开；「·」不在行首，折行落在它后面时藏起来（审计第二轮 S2，line-dots.ts）
   The line breaks only after a 「·」, never inside a segment; the 「·」 never starts a line and hides when a wrap falls right after it (audit round 2, S2; line-dots.ts) */
.config-head-seg { white-space: nowrap; }
.config-head-sk { width: 8rem; height: var(--s-3); margin-block: calc((1lh - var(--s-3)) / 2); }
.config-nav { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--s-2) var(--s-4); border-bottom: 1px solid var(--l-hair); }
.config-sections.ui-tabs { border-bottom: 0; }
/* JSON 视图里代替分类页签的那一格：画成选中的页签 / Stands in for the section tabs in the JSON view, drawn as a selected tab */
.config-sections--whole { display: flex; margin: 0; }
.config-sections--whole > span { position: relative; padding-bottom: var(--s-3); color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-medium); white-space: nowrap; }
.config-sections--whole > span::after { position: absolute; right: 0; bottom: -1px; left: 0; border-top: 2px solid var(--ok-l); content: ''; }
/* 下边留 4：36 高的控件中线离那条线 22，和页签文字（下内边距 12 加半行 10）在同一条中线上（审计第二轮 S3）
   4 below: the 36px controls centre 22 above the rule, on the same line as the tab labels (12 padding plus half a 20 line) (audit round 2, S3) */
.config-tools { display: flex; align-items: center; gap: var(--s-1); padding-bottom: var(--s-1); }
/* 分段和三个文件操作都是常规尺寸，和页头的「历史版本」一样高：一行一种高度 / The segment and the three file actions are regular size, as tall as 历史版本: one height per row */
.config-tools .ui-seg { margin-right: var(--s-2); }
/* 工作台和 JSON 编辑器的高度：视口减去它们的上沿、底边 24、边框，保存栏在时再减去它（高度和上沿由脚本量好写进来）
   The workbench's and JSON editor's height: the viewport less their top edge, 24 below and the border, and the save
   bar while it shows (the script measures the top edge and the bar) */
.workbench-page { --savebar-space: 0px; }
.workbench-page.has-savebar { --savebar-space: calc(var(--savebar-h, 0px) + var(--s-4)); }
.workbench-document { display: block; min-width: 0; --view-h: calc(100dvh - var(--wb-top, 318px) - var(--s-5) - var(--savebar-space) - 2px); --workbench-h: max(560px, var(--view-h)); }
.workbench-document .json-editor { height: var(--workbench-h); min-height: 0; }
.workbench-document-panel { min-width: 0; border-color: var(--l-hair); border-radius: var(--r-3); }
/* 基础设置跟着整页滚动，不在卡片里再套一个滚动框；左边分组是粘性的。
   Settings scroll with the page rather than inside a box in the card; the group list is sticky. */
.workbench-document-panel:has(.structured-editor--page) { overflow: visible; }
.structured-editor--page { min-height: 0; max-height: none; overflow: visible; background: var(--l-surface); border-radius: var(--r-3); }
/* 自由编辑的表单最宽 52rem：面板跟着收窄，边框贴着内容，右边不留一条空白（审计 V14）
   自由编辑's form is at most 52rem wide, and the panel narrows with it so its border hugs the content instead of leaving a blank band (audit V14) */
/* 域名映射也一样：两个域名框各一半就够放下域名，「→」不会被两块空框隔开（审计第二轮 M9）
   The domain mapping too: half the width each is plenty for a domain, and the 「→」 is no longer stranded between two empty boxes (audit round 2, M9) */
.workbench-document-panel:is(:has(.manual), :has(.domain-mapping-config)) { max-width: calc(52rem + var(--s-5) * 2 + 2px); }
/* 自由编辑的位置：「← 解析编排 / 自由编辑」；斜杠两边一样宽，按钮只在自己那边留 8（审计 V18）
   Where 自由编辑 sits: ← 解析编排 / 自由编辑, with the slash centred: the button keeps only its own 8 on that side (audit V18) */
/* 「←」的按钮往回收自己的内边距：箭头落在面板内容的左边线上（桌面 24，窄屏 16；审计第二轮 V10）
   The ← button is pulled back by its own padding, so the arrow lands on the panel's content edge (24 on desktop, 16 when narrow; audit round 2, V10) */
/* 上边按字算：返回按钮看不见的上半截不算，字离面板上边 24，和最后一行字离下边一样（审计第四轮 V3）
   The top counts to the text: the back button's invisible upper part does not count, so the text sits 24 under the panel edge, as the last line sits above the bottom (audit round 4, V3) */
.workbench-manual-bar { display: flex; align-items: center; padding: calc(var(--s-5) - (var(--h-sm) - 1lh) / 2) var(--s-4) 0 calc(var(--s-5) - var(--s-2)); color: var(--l-ink-3); font-size: var(--t-2); }
.workbench-manual-back.ui-btn { padding-inline: var(--s-2); }
.workbench-manual-sep { padding-inline-end: var(--s-2); }
.workbench-manual-bar [aria-current] { color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-medium); }
.config-load-failed { display: grid; justify-items: center; gap: var(--s-3); padding: var(--s-8) var(--s-4); text-align: center; }
.config-load-failed__title { margin: 0; color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-bold); }
.config-load-failed__reason { max-width: 36em; margin: 0; color: var(--l-ink-2); font-size: var(--t-2); overflow-wrap: anywhere; }
/* 骨架照真实布局画：和工作台一样高、一样的 5 : 6，内边距、行距、控件高度都用工作台的数。一行字是一个 1lh 高的格子，
   灰条在格子里竖直居中，所以每一行和真的字一样高（审计第三轮 B10）
   The skeleton follows the real layout: the workbench's height and 5 : 6, with its paddings, row pitch and control heights. A text line
   is a 1lh box with the bar centred in it, so every line is as tall as the real text (audit round 3, B10) */
.config-skeleton { height: var(--workbench-h); display: grid; grid-template-columns: minmax(0, 5fr) minmax(26rem, 6fr); }
.config-skeleton__line { height: 1lh; display: flex; align-items: center; }
.config-skeleton__line > .sk { height: .75em; }
.config-skeleton__list { min-width: 0; border-right: 1px solid var(--l-hair); container-type: inline-size; }
.config-skeleton__toolbar { display: flex; align-items: center; gap: var(--s-2); padding: var(--s-4) var(--s-4) var(--s-2); }
.config-skeleton__search { flex: 1 1 auto; max-width: 20rem; height: var(--h-md); }
.config-skeleton__buttons { display: flex; gap: var(--s-2); margin-left: auto; }
/* 按钮和真的一样宽：「自由编辑」98、「添加入口」106，搜索框按同样的规则缩 / Buttons as wide as the real ones (自由编辑 98, 添加入口 106), so the search shrinks by the same rule */
.config-skeleton__button { width: 6.125rem; height: var(--h-md); }
.config-skeleton__button + .config-skeleton__button { width: 6.625rem; }
@container (max-width: 27rem) {
  .config-skeleton__toolbar { flex-wrap: wrap; }
  .config-skeleton__search { flex-basis: 100%; max-width: none; }
  .config-skeleton__buttons { flex-basis: 100%; justify-content: space-between; margin-left: 0; }
}
.config-skeleton__scroll { padding: var(--s-1) var(--s-2) var(--s-5); }
.config-skeleton__note { padding: 0 var(--s-2) var(--s-2); font-size: var(--t-1); box-sizing: content-box; }
.config-skeleton__note > .sk { width: 11em; }
.config-skeleton__rows { display: grid; gap: 2px; }
.config-skeleton__row { display: grid; grid-template-columns: var(--s-6) minmax(0, 1fr); gap: var(--s-2); padding: var(--s-3) var(--s-2); }
.config-skeleton__ord { padding-top: 2px; font-size: var(--t-1); box-sizing: content-box; }
.config-skeleton__ord > .sk { width: 1.4em; }
.config-skeleton__body { min-width: 0; display: grid; gap: 2px; }
.config-skeleton__name { font-size: var(--t-3); }
.config-skeleton__name > .sk { width: 64%; }
.config-skeleton__row:nth-child(2n) .config-skeleton__name > .sk { width: 48%; }
.config-skeleton__route { font-size: var(--t-2); }
.config-skeleton__route > .sk { width: 56%; }
.config-skeleton__row:nth-child(3n) .config-skeleton__route > .sk { width: 72%; }
/* 同一行里后面的几行字短一些；同一段字的几行之间没有 2 的空隙，和真的折行一样 / Later lines of the same row are shorter, with no 2 gap between lines of one text, as a real wrap has none */
.config-skeleton__name + .config-skeleton__name, .config-skeleton__route + .config-skeleton__route { margin-top: -2px; }
.config-skeleton__name + .config-skeleton__name > .sk { width: 40%; }
.config-skeleton__route + .config-skeleton__route > .sk, .config-skeleton__row:nth-child(3n) .config-skeleton__route + .config-skeleton__route > .sk { width: 44%; }
/* 没有记录时：手机宽的列表里一条路线常要两行 / With no record: in a phone-width list a route usually takes two lines */
.config-skeleton__route--more { display: none; }
@container (max-width: 24rem) {
  .config-skeleton__route--more { display: flex; }
}
.config-skeleton__inspector { min-width: 0; container-type: inline-size; }
.config-skeleton__head { padding: var(--s-4) var(--s-5); border-bottom: 1px solid var(--l-hair); }
.config-skeleton__title { height: var(--h-md); font-size: var(--t-4); }
.config-skeleton__title > .sk { width: 5em; }
.config-skeleton__form { display: grid; gap: var(--s-5); padding: var(--s-5); }
.config-skeleton__group { display: grid; gap: var(--s-3); }
.config-skeleton__label { font-size: var(--t-3); }
.config-skeleton__label > .sk { width: 7em; }
/* 子项一行：类型框、值框，行尾让出 × 那一列 / A sub-item row: type box and value box, leaving the × column free */
.config-skeleton__fields { display: flex; gap: var(--s-2); padding-inline-end: calc(var(--h-md) + var(--s-2)); }
.config-skeleton__field { height: var(--h-md); }
.config-skeleton__fields > .config-skeleton__field:first-child { flex: 0 0 var(--w-field); }
.config-skeleton__fields > .config-skeleton__field:last-child { flex: 1 1 auto; }
.config-skeleton__vlabel { display: none; }
.config-skeleton__add { font-size: var(--t-2); line-height: var(--lh-tight); }
.config-skeleton__add > .sk { width: 4.5em; }
/* 检查器窄于 34rem（表单窄于 31rem）时子项上下排，和真的一样 / Below 34rem (a form under 31rem) the sub-item stacks as the real one does */
@container (max-width: 34rem) {
  .config-skeleton__fields { flex-direction: column; gap: 0; }
  .config-skeleton__fields > .config-skeleton__field:first-child { flex: none; }
  .config-skeleton__vlabel { display: flex; margin: var(--s-3) 0 var(--s-1); font-size: var(--t-2); }
  .config-skeleton__vlabel > .sk { width: 2.5em; }
}

/* 保存栏：粘在视口底边上方 24，和页面底边一样；下面垫一条页面底色，内容不会从这条缝里透出来（规范 8.2）
   The save bar sticks 24 above the viewport's bottom, like the page's bottom margin, with a strip of page ground
   below it so content never shows through the gap (spec 8.2) */
.config-savebar { position: sticky; z-index: 20; bottom: var(--s-5); }
/* 内容比视口短的分组里，保存栏也停在视口底边上方 24：文档区至少和工作台一样高。原因多出一行时栏往上长，按钮不挪（规范 2.4、8.2，审计第七轮 S3）
   On a group shorter than the viewport the bar still rests 24 above the viewport bottom: the document is at least as tall as the workbench,
   so when the reason adds a row the bar grows upward and the button stays put (spec 2.4, 8.2, audit round 7, S3) */
@media (min-width: 861px) {
  /* --view-h 是工作台的内容高度，已经减掉了它上下两条 1 像素的边：文档区照工作台的外框算，保存栏正好停在 24（审计第八轮 S1）
     --view-h is the workbench's content height, less its two 1px borders: the document takes the workbench's outer height, so the bar rests at exactly 24 (audit round 8, S1) */
  .workbench-page.has-savebar .workbench-document { min-height: calc(var(--view-h) + 2px); }
}
.config-savebar::after { position: absolute; right: -1px; bottom: calc(var(--s-5) * -1 - 1px); left: -1px; height: var(--s-5); background: var(--l-canvas); content: ''; }
/* 结论和原因排在同一条基线上：13 号的原因不按中线对齐，否则比 14 号的结论高 1；整行还在 36 的格子里上下居中（审计第八轮 S2）
   The verdict and reason share a baseline: centred, the 13px reason sat 1 above the 14px verdict; the line stays centred in its 36 cell (audit round 8, S2) */
.config-save-state { margin: 0; align-items: baseline; align-content: center; }
/* 墨点和对勾没有字的基线：它们还是上下居中，不掉到基线上（审计第八轮 A2） / The ink dot and the tick have no text baseline: they stay centred rather than dropping onto it (audit round 8, A2) */
.config-save-state > :is(.ui-dot, svg) { align-self: center; }
/* 失败原因里的机器值不拆开；原因最多折一次 / Machine values in the reason never split; the reason wraps at most once */
.config-savebar small { text-wrap: pretty; }
/* 保存中写过的备注留一行字 / A note typed before saving stays as one line of text */
.config-save-note { min-width: 0; max-width: 14rem; overflow: hidden; color: var(--l-ink-2); font-size: var(--t-2); text-overflow: ellipsis; white-space: nowrap; }
@media (min-width: 641px) {
  .config-savebar .is-aside { display: none; }
}
/* 「备注」往回收一格：字落在状态那条竖线上。它是展开开关，和「ECS 未设置」一样带一个向下的箭头，打开时转过来；
   不带箭头时它像一行说明，不像按钮（审计第四轮 S1）
   备注 pulled back by its padding so its text sits on the status line's column. It is a disclosure, so like 「ECS 未设置」 it carries a
   down chevron that turns over while open; without one it read as a caption, not a button (audit round 4, S1) */
.config-note-toggle { margin-inline-start: calc(var(--s-2) * -1); }
.config-save-check { flex: 0 0 auto; color: var(--ok-l); }
/* 按钮在「保存并热加载」「保存为待应用」「保存中」之间换字，宽度不跳 / The button swaps labels without its width jumping */
.config-save-button { min-width: calc(var(--s-8) * 2 + var(--s-4)); }
/* 在忙不是不能按：保存进行中按钮保持墨色，只是不接受再点一次 / Busy is not disabled: the button stays ink and ignores another press */
.config-save-button.is-busy { cursor: progress; }
.config-save-button.is-busy:active { transform: none; }
.config-note-toggle { display: none; }
/* 出现时升起 8、250；收起只淡出 150；减少动效时只淡入淡出 / Rises 8px over 250ms, fades out in 150ms; fades only under reduced motion */
.config-savebar-enter-active { animation: ui-savebar-in var(--m-base) var(--ease-out); }
.config-savebar-leave-active { transition: opacity var(--m-quick) var(--ease-out); }
.config-savebar-leave-to { opacity: 0; }

/* 历史版本：右边的抽屉，一行一个版本（组件库的记录行）；当前版本和系统页的当前版本同一种标记
   History: a drawer on the right, one version per record row; the current version marked as on the system page */
.config-drawer { position: fixed; inset: 0; width: 100%; height: 100%; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; background: transparent; overflow: hidden; }
.config-drawer::backdrop { background: var(--scrim); }
/* 比较叠在历史上打开时只要比较那一层遮罩：页面和历史各暗一次，不是页面暗两次（规范 2.12，审计第六轮 D5）
   With the comparison open over the history only its scrim dims: the page and the drawer each darken once, never the page twice (spec 2.12, audit round 6, D5) */
.config-drawer.is-covered::backdrop { background: transparent; }
.config-drawer__panel { position: absolute; top: 0; right: 0; bottom: 0; width: min(28rem, 100%); display: flex; flex-direction: column; background: var(--l-surface); box-shadow: var(--shadow-float); animation: config-drawer-in var(--m-base) var(--ease-out); }
@keyframes config-drawer-in { from { opacity: 0; transform: translateX(var(--move-3)); } }
/* 头部左右和列表一样 24：关闭和每行的「…」一样大（36），圆心落在同一条竖线上（审计第二轮 D11）
   The header's inset matches the list's 24, and the close and each row's … are the same 36 box, so their centres share one line (audit round 2, D11) */
.config-drawer__head { display: flex; flex: 0 0 auto; align-items: center; gap: var(--s-2); padding: var(--s-4) var(--s-5); border-bottom: 1px solid var(--l-hair); }
.config-drawer__head h2 { flex: 1; min-width: 0; margin: 0; color: var(--l-ink); font-family: var(--f-display); font-size: var(--t-4); font-weight: var(--w-bold); line-height: var(--lh-tight); }
.config-history { flex: 1; min-height: 0; overflow-y: auto; margin: 0; padding: var(--s-2) var(--s-5) var(--s-4); list-style: none; overscroll-behavior: contain; }
.config-history__row { --rec-cols: minmax(0, 1fr) auto; gap: var(--s-1) var(--s-2); }
.config-history.is-selecting .config-history__row { --rec-cols: var(--size-check) minmax(0, 1fr) auto; }
.config-history__main { min-width: 0; display: grid; gap: 2px; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; }
:is(button, label).config-history__main { cursor: pointer; }
.config-history__end { display: flex; align-items: center; justify-content: flex-end; gap: var(--s-2); }
.config-history__end:empty { display: none; }
/* 历史是浏览面：「…」在能悬停的设备上指到那一行才出现（规范 2.10，审计 D13） / History is a browse surface: on hover devices … shows on the row under the pointer (spec 2.10, audit D13) */
@media (hover: hover) {
  .config-history__menu { opacity: 0; transition: opacity var(--m-quick) var(--ease-out); }
  .config-history__row:is(:hover, :focus-within) .config-history__menu, .config-history__menu:has([aria-expanded="true"]) { opacity: 1; }
}
button.config-history__main:hover .config-history__note { text-decoration: underline; text-decoration-color: var(--l-line-strong); text-underline-offset: 3px; }
.config-history__note { color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-medium); overflow-wrap: anywhere; }
.config-history__meta { color: var(--l-ink-2); font-size: var(--t-2); font-variant-numeric: tabular-nums; }
.config-history__busy { gap: var(--s-1); font-variant-numeric: tabular-nums; }
.config-history__busy .ui-spin { width: var(--s-3); height: var(--s-3); }
.config-history__error { grid-column: 1 / -1; color: var(--err-l); font-size: var(--t-1); overflow-wrap: anywhere; }
.config-history.is-selecting .config-history__error { grid-column: 2 / -1; }
/* 这一行的名字和时间本身是一个按钮（比较版本）：原因里的链接不往上补点按区域，免得压住它；句子里的链接本来就可以只有一行字高
   The row's name and time are a button of their own (compare versions): the link in the reason gets no extra hit area that would cover it;
   a link inside a sentence may be one line tall */
.config-history__error :deep(.ui-objlink)::before { display: none; }
.config-history__empty { padding: var(--s-6) 0; color: var(--l-ink-3); font-size: var(--t-3); text-align: center; }
.config-drawer__foot { display: flex; flex: 0 0 auto; align-items: center; justify-content: flex-end; gap: var(--s-3); padding: var(--s-3) var(--s-5) calc(var(--s-3) + env(safe-area-inset-bottom)); border-top: 1px solid var(--l-hair); }

@media (max-width: 860px) {
  .workbench-manual-bar { padding-top: var(--s-3); padding-left: var(--s-2); }
  .workbench-page--editing .config-savebar { display: none; }
  /* 手机和窄屏：保存栏贴在底部导航上面，内边距和页边距一样 16；页面只在它出现时按它量出来的高度留出底部空白（审计 S4）
     The bar sits on the bottom nav with the page's 16 inset; the page leaves room only while it shows, by its measured height (audit S4) */
  .config-savebar { position: fixed; right: 0; bottom: var(--mobile-nav-height, 0px); left: 0; padding-inline: var(--s-4); border-width: 1px 0 0; border-radius: 0; box-shadow: none; }
  .config-savebar::after { display: none; }
  /* 刚保存完，按钮那一行收起，栏仍保持保存时量到的高度直到淡出：上沿不往下跳（审计第二轮 S5）
     Just saved: the button row goes, but the bar keeps the height measured while saving until it fades, so its top edge never jumps (audit round 2, S5) */
  .config-savebar--done { min-height: var(--savebar-h-exact, var(--savebar-h, 0px)); }
  /* 留出来的正好是下面占掉的：页面底部的导航加 24 已经算在页面里，保存栏在时再加它的高度减 8，内容停在保存栏上方 16，和桌面一样；
     JSON 视图不多也不少，页面不滚（审计第二轮 V1、第三轮 V1）
     The reserve equals what sits below: the page already leaves the nav plus 24, and while the save bar shows it adds the bar's height less 8,
     so content stops 16 above the bar as on desktop; the JSON view fits exactly and the page never scrolls (audit round 2 V1, round 3 V1) */
  .workbench-page.has-savebar { --savebar-space: calc(var(--savebar-h, 0px) - var(--s-2)); padding-bottom: calc(var(--savebar-h, 0px) - var(--s-2)); }
  .workbench-document { --view-h: calc(100dvh - var(--wb-top, 300px) - var(--mobile-nav-height) - var(--s-5) - var(--savebar-space) - 2px); }
  .workbench-document .json-editor { height: max(20rem, var(--view-h)); }
  .config-skeleton { height: auto; grid-template-columns: minmax(0, 1fr); }
  .config-skeleton__list { border-right: 0; }
  .config-skeleton__scroll { padding-bottom: var(--s-3); }
  .config-skeleton__inspector { display: none; }
}
/* 失败原因要一整行：窄于 1100 时结论和原因单独一行，备注、校验、保存排到下一行靠右（审计 S1）
   The failure reason gets the full width: below 1100 the verdict and reason take their own row and the note,
   校验 and save move to the next row, right-aligned (audit S1) */
@media (max-width: 1100px) {
  /* 原因那一行只有字那么高，和按钮之间 12：栏的上下留白一样（审计第三轮 S2） / The reason row is only as tall as its text, 12 above the buttons, so the bar's insets match (audit round 3, S2) */
  /* 和别的两行保存栏一样隔 8：字到按钮都是 12 上下（审计第七轮 S2） / 8 like every other two-row bar, so text to controls reads about 12 (audit round 7, S2) */
  .config-savebar--reason { flex-wrap: wrap; justify-content: flex-end; row-gap: var(--s-2); }
  .config-savebar--reason .ui-savebar__status { flex-basis: 100%; min-height: 0; }
}
@media (max-width: 640px) {
  .config-skeleton__search, .config-skeleton__button { height: var(--h-md); }
  .workbench-manual-bar { padding-top: calc(var(--s-4) - (var(--h-md) - 1lh) / 2); }
  /* 页签单独一行、下面就是那条线，指示块落在线上；视图切换和文件操作在线下面一行（审计 V5、S6、A12）
     The tabs take a row with the rule right under them, so the indicator sits on it; the view switch and file
     actions go on the row below the rule (audits V5, S6, A12) */
  .config-nav { row-gap: var(--s-3); border-bottom: 0; }
  .config-sections { width: 100%; }
  .config-sections.ui-tabs, .config-sections--whole { border-bottom: 1px solid var(--l-hair); }
  .config-sections--whole > span { min-height: var(--h-touch); display: flex; align-items: center; padding-bottom: 0; }
  .config-tools { width: 100%; padding-bottom: 0; }
  /* 分段撑满文件操作左边那一段，三格等宽，不挤成一团；手机上只写字、不带图标，「JSON」两边也留得出 15（审计第二轮 A11、V7）
     The segment fills the room left of the file actions, three equal cells instead of a cramped cluster; on a phone the labels go
     without icons, so even 「JSON」 keeps 15 on each side (audit round 2, A11, V7) */
  .config-tools .ui-seg { flex: 1; margin-right: var(--s-2); }
  .config-tools :deep(.ui-seg__opt > svg) { display: none; }
  /* 手机上整屏的层头部一样高：上下 12，和一键添加、检查器的层一样（审计第三轮 D4） / Full-screen layer headers share one height on a phone: 12 above and below, as the rule dialog and the inspector layer (audit round 3, D4) */
  .config-drawer__head { padding: var(--s-3) var(--s-4); }
  .config-history { padding-inline: var(--s-4); }
  /* 手机上每一行的点按区也是 44：备注一行加时间一行只有 42.5（规范 2.1，审计第六轮扫查） / On a phone each row's tap area is 44 too: a note line over a time line is only 42.5 (spec 2.1, round-6 sweep) */
  .config-history__main { min-height: var(--h-touch); align-content: center; }
  .config-drawer__foot { padding-inline: var(--s-4); }
  .config-drawer__foot .ui-btn { flex: 1; }
  /* 状态行里的动作在手机上也要有 44 高的点按区域（评审 N6） / The status line's action gets a 44px tap area on a phone (review N6) */
  .config-head-action { padding-block: calc((var(--h-touch) - 1lh) / 2); margin-block: calc((var(--h-touch) - 1lh) / -2); }
  /* 44 高的「…」比两行字高 2：往回收 1，行高由字决定，切到「选择」时行不上下跳（审计第四轮 D9）
     The 44 「…」 is 2 taller than the two text lines: pulled back 1 each side so the text sets the row height and rows do not jump when 选择 toggles (audit round 4, D9) */
  .config-history__menu { margin-block: -1px; }
  /* 备注藏在「备注」按钮后面，保存栏矮一行（评审 N12） / The note hides behind 备注, one row shorter (review N12) */
  .config-note-toggle { display: inline-flex; }
  .config-message { display: none; }
  .config-message.is-open { display: flex; order: 3; flex-basis: 100%; }
  .config-savebar .config-save-button { flex: 1; min-width: 0; }
  .config-savebar .is-aside { visibility: hidden; }
  .config-save-note { display: none; }
  .config-drawer__panel { padding-bottom: env(safe-area-inset-bottom); }
}
@media (prefers-reduced-motion: reduce) {
  .config-savebar-enter-active { animation: ui-fade var(--m-quick) var(--ease-out); }
  .config-drawer__panel { animation: ui-fade var(--m-quick) var(--ease-out); }
}
</style>
