<script setup lang="ts">
import { jsonProblemText, jsonSyntaxProblem, type JsonProblem } from '../json-problem'
import { Braces, CircleHelp, Clock, Download, FileUp, History, RefreshCw, Settings2, Undo2 } from '@lucide/vue'
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import type JsonEditorType from '../components/JsonEditor.vue'
import UiDotText from '../components/ui/UiDotText.vue'
import UiMenu from '../components/ui/UiMenu.vue'
import UiPageHeader from '../components/ui/UiPageHeader.vue'
import UiTabs from '../components/ui/UiTabs.vue'
import { useConfirm } from '../composables/useConfirm'
import { useConnection } from '../composables/useConnection'
import { dismissUndoable, useToast } from '../composables/useToast'
import { exportConfig, readConfig } from '../config-model/document'
import { compile, mappingIsIp, ruleTitle, type Model, type Rule, type UpstreamGroup } from '../config-model/model'
import GroupEditor from '../config-v2/GroupEditor.vue'
import HistoryDrawer from '../config-v2/HistoryDrawer.vue'
import ImportReportDialog from '../config-v2/ImportReportDialog.vue'
import MappingTab from '../config-v2/MappingTab.vue'
import RuleEditor, { type EditorResume } from '../config-v2/RuleEditor.vue'
import RulesTab from '../config-v2/RulesTab.vue'
import RuleText from '../config-v2/RuleText.vue'
import SaveBar from '../config-v2/SaveBar.vue'
import SettingsTab from '../config-v2/SettingsTab.vue'
import UpstreamsTab from '../config-v2/UpstreamsTab.vue'
import { useCompact, usePhone, useWide } from '../config-v2/phone'
import { dialogEdits, dirty, sectionEdits, discardWithUndo, editorEdited, importReport, importSource, jsonEdited, model, replaceModel, reportOpen, ui, unsaved } from '../config-v2/store'
import { applyBusy, busy, conflict, onlySaving, setViewing, applyError, applyNow, canApplyNow, canCname, capabilityError, currentVersionId, doc, failureCause, hasApplyFailure, headerAction, headerLine, load, loadError, panelBack, save, loading, pendingVersionId, refreshRuntime, runtimeStopped, runtimeUnavailable, unsupportedFields, cnameInUse, unsupportedSection } from '../config-v2/useConfigDocument'
import { useHelp } from '../composables/useHelp'
import { useServiceStart } from '../composables/useServiceStart'
import { registerLeaveGuard, takeAgreement } from '../composables/useLeaveGuard'
import '../styles/config-v2.css'
// JSON 编辑器（CodeMirror）只在用到时才加载：配置页的首包不带它 / The JSON editor (CodeMirror) loads on first use, so the config page's first chunk leaves it out
const JsonEditor = defineAsyncComponent(() => import('../components/JsonEditor.vue'))

// 配置页：侧栏里的「规则 · 上游组 · 域名映射 · 基础设置」各是一页，这个文件是它们共用的外壳——页头的事实行、通知条、
// JSON 视图、导入导出、历史版本、保存条。草稿在 config-v2/store.ts，文件和运行状态在 config-v2/useConfigDocument.ts。
// The config page: the sidebar's 规则 · 上游组 · 域名映射 · 基础设置 are each a page, and this file is their shared shell — the
// header's facts row, the notice strip, the JSON view, import/export, the save bar. The draft lives in config-v2/store.ts, the file and
// runtime in config-v2/useConfigDocument.ts.
const route = useRoute()
const help = useHelp()
const router = useRouter()
const toast = useToast()
const confirm = useConfirm()
const phone = usePhone()
const compact = useCompact()
const wide = useWide()
const tabs = [{ value: 'rules', label: '规则' }, { value: 'upstreams', label: '上游组' }, { value: 'mapping', label: '域名映射' }, { value: 'settings', label: '基础设置' }]
const section = computed(() => (tabs.some((t) => t.value === route.query.section) ? String(route.query.section) : 'rules'))
watch(section, (s) => { ui.tab = s }, { immediate: true })
const pageTitle = computed(() => (compact.value || ui.mode === 'json' ? '配置' : tabs.find((t) => t.value === section.value)?.label ?? '配置'))
function setTab(t: string): void {
  if (ui.mode === 'json' && !leaveJson()) return
  void router.replace({ query: { ...route.query, section: t === 'rules' ? undefined : t, rule: undefined } })
}
const ready = computed(() => !loading.value && Boolean(doc.value))
const firstRun = computed(() => ready.value && ui.mode === 'form' && !model.groups.length && !model.rules.length)
// 页头的规则数连同规则组里的，和导入说明数的一样 / The header's rule count includes rule groups' rules, as the import report counts them
const ruleCount = computed(() => model.rules.length + model.ruleGroups.reduce((n, group) => n + group.rules.length, 0))
// 宽屏上规则在右侧面板里编辑，列表留在左边；窄屏和手机仍是整页编辑 / On wide screens a rule is edited in the right-hand inspector with the list on the left; narrow screens and phones keep the full-page editor
const editor = ref<{ ruleId: number | null; groupId: string | null; template?: Partial<Rule>; resume?: EditorResume | null } | null>(null)
const inspector = computed(() => editor.value !== null && wide.value && section.value === 'rules' && ui.mode === 'form')
const groupEditor = ref<{ id: string | null } | null>(null)
const historyOpen = ref<{ compare: number | null } | null>(null)
// 上游组卡片上的「N 处在用」：跳到规则页，按这个组筛 / A group card's 「N 处在用」: go to the rules page filtered by that group
function showGroupRules(groupId: string): void {
  ui.query = model.groups.find((g) => g.id === groupId)?.name ?? ''
  ui.kind = 'upstream'
  setTab('rules')
}

// ---------- 规则编辑 / editing rules ----------
// 宽屏面板和整页编辑共用一个 ref：换规则、换分区、开 JSON 之前先问还没点「完成」的修改
// The wide panel and the full-page editor share one ref: switching rule, section or to JSON first asks about edits not yet 完成
const editorRef = ref<InstanceType<typeof RuleEditor> | null>(null)
// 整页编辑记进浏览器历史（?rule=）：手机上的返回手势回到列表，而不是直接离开配置页；面板不进历史，换行不会堆一串记录
// The full-page editor goes into browser history (?rule=): a phone's back gesture returns to the list instead of leaving the config
// page; the panel stays out of history, so switching rows does not pile up entries
async function openRule(ruleId: number | null, groupId: string | null, template?: Partial<Rule>): Promise<void> {
  if (ui.mode === 'json' && !leaveJson()) return
  if (editor.value && (ruleId === null || editor.value.ruleId !== ruleId) && !(await editorRef.value?.confirmDiscard() ?? true)) return
  editor.value = { ruleId, groupId, template }
  // 宽屏的面板贴在列表旁边，不跳回页顶，列表停在原处 / On wide screens the panel sits beside the list, so the list keeps its place
  if (!(wide.value && section.value === 'rules')) {
    // 先记进历史再回页顶：浏览器给列表那一条记下的是现在的位置，返回时列表回到原处 / Into history first, then to the top: the browser records the list's current position for its entry, so back returns the list to where it was
    if (!route.query.rule) await router.push({ query: { ...route.query, rule: ruleId === null ? 'new' : String(ruleId) } })
    window.scrollTo({ top: 0 })
  }
}
// 关掉整页编辑时把那条历史退掉，地址回到列表；等返回走完（浏览器恢复了列表位置）再交回去 / Closing the full-page editor steps back out of its history entry; resolves once that back has settled and the browser has restored the list position
function leaveEditorHistory(): Promise<void> {
  if (!route.query.rule) return Promise.resolve()
  return new Promise((resolve) => {
    const off = router.afterEach(() => { off(); resolve() })
    router.back()
  })
}
// 回到列表后，那一行在视野里并拿到焦点 / Back on the list, the row is in view and has the focus
function revealRow(id: number | null | undefined, fresh = false): void {
  if (id === null || id === undefined) return
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(`[data-rule="${id}"]`)
    if (!row) return
    const box = row.getBoundingClientRect()
    if (box.top < 0 || box.bottom > window.innerHeight) row.scrollIntoView({ block: 'center' })
    row.querySelector<HTMLElement>('.rrow__main')?.focus({ preventScroll: true })
    if (fresh) { row.classList.add('is-fresh'); setTimeout(() => row.classList.remove('is-fresh'), 1600) }
  })
}
async function closeRule(): Promise<void> {
  const id = editor.value?.ruleId
  editor.value = null
  await leaveEditorHistory()
  revealRow(id)
}
async function ruleSaved(rule: Rule, isNew: boolean): Promise<void> {
  editor.value = null
  await leaveEditorHistory()
  // 手机上编辑器占整页，完成时保存条还看不见：提示里说一句还要保存；桌面上保存条就在旁边，不重复
  // On a phone the editor fills the page and the save bar is not in view at 完成, so the toast says a save is still due; on desktop the bar sits right there
  toast.success(`${isNew ? '已添加' : '已更新'}「${ruleTitle(rule)}」${phone.value ? '，保存后生效' : ''}`)
  // 焦点回到这一行，键盘接着往下走，不掉到页面开头 / Focus returns to the row so the keyboard carries on from there instead of dropping to the page start
  revealRow(rule.id, true)
}
async function ruleDeleted(rule: Rule, index: number, list: Rule[]): Promise<void> {
  editor.value = null
  await leaveEditorHistory()
  toast.undoable(`已删除「${ruleTitle(rule)}」`, () => list.splice(Math.min(index, list.length), 0, rule))
  // 删掉以后焦点落在提示里的「撤销」上 / After the delete, focus lands on the toast's 撤销
  void nextTick(() => [...document.querySelectorAll<HTMLButtonElement>('.toast-undo')].pop()?.focus())
}
// 宽窄切换会把面板换成整页编辑（或反过来），换之前把没点「完成」的修改交给下一个
// A width change swaps the panel for the full-page editor (or back); before the swap the edits not yet 完成 are handed over
// 宽窄切换去掉 ?rule 不是「返回」：修改已经交给下一个编辑器，换地址时不问 / The layout swap dropping ?rule is not a back-out: the edits went to the next editor, so the address change asks nothing
let layoutSwap = false
watch(inspector, (now, before) => {
  if (!editor.value || now === before || !editorRef.value) return
  editor.value = { ...editor.value, resume: editorRef.value.capture() }
  // 换成整页编辑时也记进历史，返回手势回到列表；换回面板时把 ?rule 去掉 / Switching to the full page goes into history too, so back returns to the list; switching back to the panel drops ?rule
  if (!now && !route.query.rule) void router.push({ query: { ...route.query, rule: editor.value.ruleId === null ? 'new' : String(editor.value.ruleId) } })
  else if (now && route.query.rule) {
    layoutSwap = true
    void router.replace({ query: { ...route.query, rule: undefined } }).finally(() => { layoutSwap = false })
  }
}, { flush: 'pre' })
function groupSaved(group: UpstreamGroup, isNew: boolean): void {
  groupEditor.value = null
  toast.success(isNew ? `已新建上游组「${group.name}」` : `已更新「${group.name}」`)
}
function groupDeleted(group: UpstreamGroup, index: number): void {
  groupEditor.value = null
  toast.undoable(`已删除上游组「${group.name}」`, () => model.groups.splice(index, 0, group))
}

// ---------- 通知条：一次只说一件事 / the notice strip: one thing at a time ----------
const geoPrefixed = computed(() => [...model.rules, ...model.ruleGroups.flatMap((g) => g.rules)].flatMap((r) => r.conditions.flat()).filter((c) => c.field === 'geosite' && c.values.some((v) => /^geosite:/i.test(v))).length)
interface Notice { tone: 'err' | 'warn' | 'off'; text: string; detail?: string; action?: string; run?: () => void | Promise<void> }
const notice = computed<Notice | null>(() => {
  // 连不上面板时由顶上的横幅说，这里不复述 / With the panel unreachable the banner says it; no second copy here
  if (loadError.value && doc.value && !panelDown.value) return { tone: 'err', text: '读取配置失败，下面是上一次读到的内容。', detail: loadError.value, action: '重试', run: () => void reload(true) }
  if (hasApplyFailure.value) {
    const reason = doc.value?.runtime.pending_error || doc.value?.pending?.error || 'KixDNS 没有给出原因。'
    // 草稿有修改时不给「重试应用」：那时保存的是草稿，重试会把草稿当成失败的那个版本发出去 / No retry while the draft has changes: saving then sends the draft, not the version that failed
    const retry = canApplyNow.value && !unsaved.value && !panelDown.value && !conflict.value
    // 重试撞上「别处改过了」：再重试还是撞上，按钮换成重新读取 / A retry that met 别处改过了 would meet it again: the button becomes 重新读取
    const reread = conflict.value && !panelDown.value
    // 挡住重试的是内核不支持的设置时，这一条也说清它和出路（不支持的那条提示排在后面，这时显示不出来） / When unsupported settings block the retry, this notice names them and the way out too (the unsupported notice ranks below and cannot show)
    const blocked = !retry && unsupportedFields.value.length > 0
    const cause = failureCause(reason).replace(/。$/, '')
    return { tone: 'err', text: pendingVersionId.value ? `版本 #${pendingVersionId.value} 没有生效，仍在用之前那份配置。` : '上次保存的版本没有生效，仍在用之前那份配置。', detail: blocked ? `${cause}。当前内核不支持：${unsupportedFields.value.join('、')}，先在基础设置里关掉。` : cause, action: reread ? '重新读取' : retry ? '重试应用' : blocked && section.value !== 'settings' ? '去基础设置' : undefined, run: reread ? () => reload() : retry ? () => save('apply') : goUnsupported }
  }
  if (applyError.value) { const [text, ...detail] = applyError.value.split('\n'); return { tone: 'err', text: `${text}。`, detail: detail.join('\n') } }
  // 警告排在说明前面：永远不命中的规则比导入说明要紧 / Warnings rank above information: a rule that never matches matters more than the import notes
  if (geoPrefixed.value) return { tone: 'warn', text: `${geoPrefixed.value} 个 GeoSite 条件多写了「geosite:」前缀，内核找不到对应的分类，永远不会命中。`, action: '去掉前缀', run: stripPrefix }
  if (importReport.value && !reportOpen.value && importReport.value.stats.raw) return { tone: 'off', text: `这份配置是按内核格式读进来的，${importReport.value.stats.raw} 条规则原样保留为高级规则。`, action: '查看导入说明', run: () => { reportOpen.value = true } }
  // 没运行、连不上时页头已经说了，功能列表拿不到是它的结果，不另起一条 / When stopped or unreachable the header says so; the missing feature list follows from it
  if (capabilityError.value && !runtimeStopped.value && !runtimeUnavailable.value) return { tone: 'off', text: 'KixDNS 没有报告它支持哪些功能：新功能先按不支持处理，保存后先存成待应用版本。' }
  // 说出有几处，域名映射里有的就给去那里的按钮 / Say how many places, with a button to the domain mappings when some are there
  if (!canCname.value && cnameInUse.value && !capabilityError.value) {
    const them = cnamePlaces.value.total > 1 ? '它们' : '它'
    // 同时还有开着的不支持的设置：一条提示把两件事都说了，保存条说的「有 N 项」和这里对得上 / Unsupported settings switched on as well: one notice says both, so the bar's 「有 N 项」 matches it
    if (unsupportedFields.value.length) return { tone: 'warn', text: `当前内核不支持：${unsupportedFields.value.join('、')}、CNAME 回答。在基础设置里关掉${unsupportedFields.value.map((f) => `「${f}」`).join('、')}，把 ${cnamePlaces.value.total}\u00a0处写成域名的回答改成 IP，或者更新内核。`, action: section.value === 'settings' ? (cnamePlaces.value.mappings ? '去域名映射' : undefined) : '去基础设置', run: () => (section.value === 'settings' ? setTab('mapping') : goUnsupported()) }
    return { tone: 'warn', text: `当前内核不支持 CNAME 回答：有 ${cnamePlaces.value.total}\u00a0处回答写的是域名，KixDNS 不会接受这份配置。把${them}改成 IP，或者更新内核。`, action: cnamePlaces.value.mappings && section.value !== 'mapping' ? '去域名映射' : undefined, run: () => setTab('mapping') }
  }
  // KixDNS 不接受带着它不支持的设置的配置：说清这一点和两条出路，按钮直接去基础设置 / KixDNS refuses a config carrying settings it does not support: say so with the two ways out, the button going straight to the settings
  if (unsupportedFields.value.length) { const many = unsupportedFields.value.length > 1; return { tone: 'warn', text: `当前内核不支持：${unsupportedFields.value.join('、')}。开着也不起作用，关掉才能保存：在基础设置里点${many ? '' : '它旁边的'}「关掉」，或者更新内核。`, action: section.value === 'settings' ? undefined : '去基础设置', run: goUnsupported } }
  return null
})
function goUnsupported(): void {
  ui.settingsGroup = unsupportedSection.value
  setTab('settings')
}
// 写成域名的回答有几处：域名映射和规则（含规则组）分开数 / How many answers are domains: mappings and rules (rule groups included) counted apart
const cnamePlaces = computed(() => {
  const mappings = model.mappings.filter((m) => m.enabled && !mappingIsIp(m)).length
  const rules = [...model.rules, ...model.ruleGroups.flatMap((g) => g.rules)].filter((r) => r.outcome.type === 'answer' && r.outcome.kind === 'cname').length
  return { mappings, total: mappings + rules }
})
function stripPrefix(): void {
  let n = 0
  for (const r of [...model.rules, ...model.ruleGroups.flatMap((g) => g.rules)]) for (const c of r.conditions.flat()) if (c.field === 'geosite') c.values = c.values.map((v) => { if (/^geosite:/i.test(v)) { n++; return v.replace(/^geosite:/i, '') } return v })
  toast.info(`已去掉 ${n} 个 geosite: 前缀，保存后生效`)
}

// ---------- JSON 视图 / JSON view ----------
// 这里给人看、给人改的是内核读的那份（不带 panel）；切回表单按内核配置重新读，名字、备注、停用的规则从草稿接回
// What is shown and edited here is the kernel's part (without panel); switching back re-reads it as a kernel config and carries names, notes and disabled rules over from the draft
const jsonText = ref('')
const jsonBase = ref('')
const jsonEditor = ref<InstanceType<typeof JsonEditorType> | null>(null)
const jsonError = computed(() => (ui.mode === 'json' ? parseProblem(jsonText.value) : null))
function parseProblem(text: string): JsonProblem | null {
  const syntax = jsonSyntaxProblem(text)
  if (syntax) return syntax
  const v = JSON.parse(text) as unknown
  return !v || typeof v !== 'object' || Array.isArray(v) ? { line: 1, column: 1, reason: '配置根节点必须是 JSON 对象' } : null
}
// JSON 里改过还没读回表单的部分也算草稿：保存条升起、离开要问、保存前先读回来
// JSON edits not yet read back into the form count as draft too: the save bar rises, leaving asks, and a save reads them back first
const jsonDirty = computed(() => ui.mode === 'json' && jsonText.value !== jsonBase.value)
watch(jsonDirty, (now) => { jsonEdited.value = now }, { immediate: true })
const compiledText = (): string => JSON.stringify(compile(model), null, 2)
// JSON 文本按草稿重写一遍：放弃、撤销之后，JSON 视图里也是草稿现在的样子 / Rewrite the JSON text from the draft: after discard or undo the JSON view shows the draft as it now is
function resetJsonText(): void {
  jsonText.value = compiledText()
  jsonBase.value = jsonText.value
}
// 打开 JSON 视图之前，规则编辑里没点「完成」的修改先问一句，再关掉编辑 / Before opening the JSON view, ask about rule edits not yet 完成, then close the editor
async function enterJson(): Promise<void> {
  if (editor.value) {
    if (!(await editorRef.value?.confirmDiscard() ?? true)) return
    editor.value = null
    leaveEditorHistory()
  }
  resetJsonText()
  ui.mode = 'json'
}
// 放弃草稿以后：JSON 视图里改了一半或写错的文字一起丢掉 / After a discard, half-made or broken edits in the JSON view go too
function afterDiscard(): void {
  if (ui.mode === 'json') resetJsonText()
}
// 把 JSON 里的修改读回草稿 / Read the JSON edits back into the draft
function foldJson(): void {
  if (!jsonDirty.value) return
  const { model: next, report } = readConfig(JSON.parse(jsonText.value) as Record<string, unknown>, model)
  jsonBase.value = jsonText.value
  replaceModel(next)
  if (report && (report.stats.raw || report.notes.some((n) => n.level === 'warn'))) { importReport.value = report; importSource.value = 'JSON 视图里的修改'; reportOpen.value = true }
}
// 草稿在 JSON 视图外被换掉（放弃、撤销、重新读取）：JSON 里没有新修改就跟着刷新 / The draft changed outside the JSON view (discard, undo, reload): refresh the text unless it has edits of its own
watch(() => (ui.mode === 'json' ? JSON.stringify(model) : ''), (now) => { if (now && !jsonDirty.value) { jsonText.value = compiledText(); jsonBase.value = jsonText.value } })
// 恢复历史版本是问过「没保存的修改会丢失」的：JSON 视图里的文字也换成恢复后的草稿 / A restore was confirmed with 没保存的修改会丢失, so the JSON view's text becomes the restored draft too
function afterRestore(): void {
  if (ui.mode !== 'json') return
  jsonText.value = compiledText()
  jsonBase.value = jsonText.value
}
function leaveJson(): boolean {
  if (jsonError.value) { toast.info('JSON 写错了，改好才能切换'); return false }
  foldJson()
  ui.mode = 'form'
  return true
}
// 保存、校验之前（save）：面板里没点「完成」的修改和 JSON 里的修改先收进草稿；放弃和查看之前（fold）只收 JSON 里的
// Before save or validate (save): the panel's edits not yet 完成 and the JSON edits go into the draft first; before discard or review (fold) only the JSON ones
function flush(purpose: 'save' | 'fold'): boolean {
  if (purpose === 'save' && editor.value && editorRef.value && !editorRef.value.commit()) return false
  if (jsonDirty.value) {
    if (jsonError.value) return false
    foldJson()
  }
  return true
}
function setMode(m: string): void { if (m === 'json') void enterJson(); else leaveJson() }
const modes = [{ value: 'form', label: '表单', icon: Settings2 }, { value: 'json', label: 'JSON', icon: Braces }]
const moreItems = computed(() => [
  { value: 'history', label: '历史版本', icon: History, disabled: !ready.value },
  { value: 'mode', label: ui.mode === 'json' ? '回到表单' : '查看 JSON', icon: ui.mode === 'json' ? Settings2 : Braces, disabled: !ready.value },
  { value: 'import', label: '导入 JSON', icon: FileUp, disabled: !ready.value },
  { value: 'download', label: '下载 JSON', icon: Download, disabled: !ready.value },
  // 连不上面板时读不到，按了只会失败 / Unreachable panel: the read can only fail
  { value: 'reload', label: '重新读取配置', icon: RefreshCw, disabled: loading.value || panelDown.value },
  // 手机的保存条放不下「放弃修改」，放在这里；桌面的保存条上一直有 / The phone save bar has no room for 放弃修改, so it lives here; the desktop bar always shows it
  ...(phone.value && unsaved.value ? [{ value: 'discard', label: '放弃修改', icon: Undo2 }] : []),
  { value: 'help', label: '帮助', icon: CircleHelp },
])
function pickMore(value: string): void {
  if (value === 'history') historyOpen.value = { compare: null }
  else if (value === 'mode') setMode(ui.mode === 'json' ? 'form' : 'json')
  else if (value === 'import') fileInput.value?.click()
  else if (value === 'download') downloadJson()
  else if (value === 'help') help.show('config')
  else if (value === 'discard') { const what = jsonDirty.value ? '已放弃 JSON 里的修改' : undefined; if (!jsonError.value) flush('fold'); discardWithUndo(what); afterDiscard() }
  else void reload()
}

// ---------- 导入、下载、重新读取 / import, download, reload ----------
const fileInput = ref<HTMLInputElement | null>(null)
async function importFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 4 * 1024 * 1024) { toast.error('配置文件不能超过 4 MiB'); return }
  let parsed: Record<string, unknown>
  const text = await file.text()
  const problem = jsonSyntaxProblem(text)
  if (problem) { toast.error(`${file.name} 不是合法的 JSON：${jsonProblemText(problem)}`); return }
  parsed = JSON.parse(text) as Record<string, unknown>
  // 合法的 JSON 不一定是 KixDNS 配置：最外层要是对象，至少有 settings、pipelines 这类内核认的键 / Valid JSON is not necessarily a KixDNS config: the top level must be an object with at least one key the kernel reads
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { toast.error(`${file.name} 不是 KixDNS 配置：最外层要是 { … }`); return }
  if (!['version', 'settings', 'pipelines', 'pipeline_select'].some((key) => key in parsed)) { toast.error(`${file.name} 不是 KixDNS 配置：里面没有 settings、pipelines 这些内容`); return }
  if (unsaved.value && !(await confirm.ask({ title: '放弃未保存的修改', body: '导入的文件会替换现在的草稿，没保存的修改会丢失。', confirmLabel: '放弃修改并导入', destructive: true }))) return
  const before = JSON.parse(JSON.stringify(model)) as Model
  const { model: next, report } = readConfig(parsed, model)
  replaceModel(next)
  ui.mode = 'form'
  const undo = () => { replaceModel(before); importReport.value = null; reportOpen.value = false; undoImport.value = null }
  toast.undoable(`已导入 ${file.name}`, undo)
  undoImport.value = report?.notes.length ? undo : null
  if (report) { importReport.value = report; importSource.value = file.name; reportOpen.value = report.notes.length > 0 }
}
// 刚导入的文件能在随后弹出的导入说明里撤销；关掉说明后再打开就不提供了，那时撤销会连带丢掉之后的修改
// The file just imported can be undone from the report that follows; reopened later it is not offered, since undo would also drop the edits made since
const undoImport = ref<(() => void) | null>(null)
function downloadJson(): void {
  if (ui.mode === 'json' && jsonError.value) { toast.error('JSON 写错了，改好再下载'); return }
  const data = ui.mode === 'json' ? jsonText.value : JSON.stringify(exportConfig(model), null, 2)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
  a.download = 'kixdns-config.json'
  a.click()
  URL.revokeObjectURL(a.href)
}
async function reload(ask = true): Promise<void> {
  if (ask && unsaved.value && !(await confirm.ask({ title: '放弃未保存的修改', body: '重新读取会丢掉没保存的修改。', confirmLabel: '放弃修改并重新读取', destructive: true }))) return
  editor.value = null
  ui.mode = 'form'
  await load()
}

// ---------- 进出页面 / entering and leaving ----------
// JSON 文本只活在这一页里：回到配置页总是从表单开始，免得 JSON 视图空着又切不回表单
// The JSON text lives only on this page: coming back always starts in the form, so the JSON view never reopens empty and stuck
// 只有规则编辑里没点「完成」的、或开着的抽屉里的修改时，问的是那一样；草稿或 JSON 有修改时问整份草稿
// With only a rule edit not yet 完成, or an open drawer's edits, the question names that one thing; with draft or JSON edits it is about the whole draft
const askLeave = async (): Promise<boolean> => {
  // 正在保存、之后没再改：保存照常做完，结果会用提示说，不问「放弃」（问了也放弃不了） / Saving with nothing changed since: the save finishes and a toast tells its outcome, so no 放弃 question (it could not discard anyway)
  if (!unsaved.value || onlySaving()) return true
  if (!dirty.value && !jsonDirty.value) return confirm.ask({ title: `放弃${editorEdited.value ? '这条规则' : [...dialogEdits.values()][0] ?? '这条规则'}的修改`, body: '刚才在这里改的内容不会写进草稿。', confirmLabel: '放弃修改', cancelLabel: '继续编辑', destructive: true })
  return confirm.ask({ title: '放弃未保存的修改', body: '当前的配置草稿会被丢弃，已经生效的配置不受影响。', confirmLabel: '放弃修改', cancelLabel: '继续编辑', destructive: true })
}
const releaseGuard = registerLeaveGuard(askLeave, () => unsaved.value)
// 提示条的按钮做事期间停用，焦点跟着掉到页面上：做完没人接住焦点时，回到这个按钮（还在的话），不在了就落在提示条上
// The notice's button is disabled while it works and focus falls to the page: when nothing caught it afterwards, it returns to the button if still there, else to the notice
async function runNotice(): Promise<void> {
  await notice.value?.run?.()
  await nextTick()
  if (document.activeElement && document.activeElement !== document.body) return
  const box = document.querySelector<HTMLElement>('.cfg__notice')
  ;(box?.querySelector<HTMLElement>('.ui-notice__action:not(:disabled)') ?? box)?.focus()
}
onMounted(() => {
  ui.mode = 'form'
  // 刷新后编辑器不在了，地址里的 ?rule= 也去掉 / After a reload the editor is gone, so ?rule= leaves the address too
  if (route.query.rule) void router.replace({ query: { ...route.query, rule: undefined } })
  // 离开时还在保存：那次保存做完会自己重读，这里不读，免得把旧文件换进草稿；离开后没保存成功的草稿留着，保存条上失败的说法也留着
  // Still saving from before leaving: that save re-reads when done, so no read here (it would put the old file into the draft); a draft whose save failed
  // after leaving stays, and so does what the save bar said about the failure
  const keep = setViewing(true)
  if (!busy.value) void load(keep ? { quiet: true, keepDraft: true } : {})
  window.addEventListener('beforeunload', beforeUnload)
})
const beforeUnload = (e: BeforeUnloadEvent) => { if (unsaved.value) { e.preventDefault(); e.returnValue = '' } }
// 带「撤销」的提示只对这一页的草稿有用：离开时一起收起（会话过期跳到登录页时也不会留着） / Undo toasts only make sense for this page's draft: they go when it unmounts (including a jump to the login page on session expiry)
onBeforeUnmount(() => { setViewing(false); window.removeEventListener('beforeunload', beforeUnload); releaseGuard(); dismissUndoable(); ui.mode = 'form'; jsonEdited.value = false })
onBeforeRouteLeave(async () => takeAgreement() || askLeave())
// 换分区、或者从整页编辑按返回：规则编辑里没点「完成」的修改先问一句；同意了就关掉编辑
// Switching section, or pressing back out of the full-page editor: first ask about rule edits not yet 完成; once agreed the editor closes
onBeforeRouteUpdate(async (to, from) => {
  if (layoutSwap) return true
  // 换分区会卸下规则组、高级入口的弹层：里面有没写进草稿的修改就先问（浏览器返回也走这里） / Changing section unmounts the rule-group and 高级入口 dialogs: ask first when they hold unwritten edits (browser back comes through here too)
  if (to.query.section !== from.query.section && sectionEdits.size && !(await confirm.ask({ title: `放弃${dialogEdits.get([...sectionEdits][0]!) ?? '这里'}的修改`, body: '刚才在这里改的内容不会写进草稿。', confirmLabel: '放弃修改', cancelLabel: '继续编辑', destructive: true }))) return false
  const backOut = Boolean(from.query.rule) && !to.query.rule
  if (!editor.value || (to.query.section === from.query.section && !backOut)) return true
  if (!(await editorRef.value?.confirmDiscard() ?? true)) return false
  const id = editor.value.ruleId
  editor.value = null
  if (backOut) void router.isReady().then(() => nextTick(() => revealRow(id)))
  return true
})
// 地址里还带着 ?rule、编辑却已经关了（前进到旧的记录、从编辑里切到别的分区）：把它去掉，地址和页面一致
// The address still carries ?rule while no editor is open (forward onto an old entry, switching section from the editor): drop it so the address matches the page
watch(() => route.query.rule, (rule) => { if (rule && !editor.value) void router.replace({ query: { ...route.query, rule: undefined } }) })
watch(section, () => { editor.value = null; void nextTick(() => window.scrollTo({ top: 0 })) })
// 页头说「KixDNS 未启动」时就地启动；启动后重读运行状态，有待应用的版本页头会换成「现在应用」
// Start KixDNS where the header says it is stopped; afterwards the runtime state is reread, and a pending version turns the header action into 现在应用
const { starting, start } = useServiceStart()
// 连不上面板时页头写「状态未知」，「启动」也收起：按了也只会失败 / While the panel is unreachable the header reads 状态未知 and 启动 is withdrawn: pressing it could only fail
const { down: panelDown } = useConnection()
// 连上面板后自己重读，不等人点重试 / Once the panel answers again the page re-reads by itself instead of waiting for 重试
watch(panelDown, (now, before) => { if (before && !now) void panelBack() })
async function startKixdns(): Promise<void> {
  if (!(await start())) return
  // 草稿有修改时只刷新运行状态，不重读文件，免得把草稿换掉 / With edits in the draft only the runtime state is refreshed, so the draft is not replaced
  try { await (unsaved.value ? refreshRuntime() : load({ quiet: true })) } catch { /* 页头下次读取时再更新 / the header updates on the next read */ }
}
const versionLabel = computed(() => { const id = pendingVersionId.value ?? currentVersionId.value ?? doc.value?.version_id; return id === null || id === undefined ? '—' : `#${id}` })
</script>

<template>
  <RuleEditor v-if="editor && !inspector" ref="editorRef" :key="`${editor.ruleId}-${editor.groupId}`" :rule-id="editor.ruleId" :group-id="editor.groupId" :template="editor.template" :resume="editor.resume" @close="closeRule" @saved="ruleSaved" @deleted="ruleDeleted" @edit-group="groupEditor = { id: $event }" />
  <div v-else class="page cfg">
    <UiPageHeader :title="pageTitle">
      <template #meta>
        <span v-if="!ready && !loadError" class="cfg__status-sk"><i class="sk"></i></span>
        <!-- 宽屏：标题下一排事实（状态、配置版本、规则数、上游组数）；手机：一行状态 / Wide: a facts row under the title (state, config version, rule count, upstream groups); phones: one status line -->
        <!-- 没读到配置时宽屏也是这一排，只写状态；版本、规则数、上游组数等读到再写 / Without a config read the wide header keeps this row with the state only; version, rule and group counts wait for the read -->
        <span v-else-if="!phone && !firstRun" class="ui-facts cfg__facts" :class="{ 'cfg__facts--long': (headerLine.wide?.length ?? 0) > 1 }" :role="applyBusy ? 'status' : undefined">
          <span><span class="ui-lbl">状态</span><b><span v-if="applyBusy" class="ui-spin cfg__spin" aria-hidden="true"></span><span v-else class="ui-dot" :class="headerLine.tone === 'ok' ? '' : `ui-dot--${headerLine.tone}`" aria-hidden="true"></span><UiDotText :parts="headerLine.wide ?? [headerLine.lead ?? `${headerLine.before}${headerLine.version ?? ''}${headerLine.after ?? ''}`]" /><button v-if="headerAction && ready" class="cfg__head-action" type="button" @click="applyNow">{{ headerAction }}</button><button v-else-if="runtimeStopped && ready && !panelDown" class="ui-btn ui-btn--secondary ui-btn--sm ui-btn--inline cfg__head-start" type="button" :disabled="starting" @click="startKixdns">启动</button></b></span>
          <template v-if="doc">
          <span><span class="ui-lbl">配置版本</span><b>{{ versionLabel }}</b></span>
          <span class="cfg__fact-rules"><span class="ui-lbl">规则</span><b>{{ ruleCount }} 条</b></span>
          <span class="cfg__fact-groups"><span class="ui-lbl">上游组</span><b>{{ model.groups.length }} 个</b></span>
          </template>
        </span>
        <span v-else class="ui-ph__lead" :role="applyBusy ? 'status' : undefined">
          <span v-if="applyBusy" class="ui-spin cfg__spin" aria-hidden="true"></span>
          <span v-else class="ui-dot" :class="headerLine.tone === 'ok' ? '' : `ui-dot--${headerLine.tone}`" aria-hidden="true"></span>
          <UiDotText :parts="[headerLine.lead ?? '', `${headerLine.before}${headerLine.version ?? ''}${headerLine.after ?? ''}`].filter(Boolean)" />
          <button v-if="headerAction && ready" class="cfg__head-action" type="button" @click="applyNow">{{ headerAction }}</button>
          <button v-else-if="runtimeStopped && ready && !panelDown" class="ui-btn ui-btn--secondary ui-btn--sm ui-btn--inline cfg__head-start" type="button" :disabled="starting" @click="startKixdns">启动</button>
        </span>
      </template>
      <template v-if="!firstRun" #actions>
        <!-- 当前页签自己的操作（规则页的「新建规则」）从页签组件传送到这里 / The current tab's own actions (the rules tab's 新建规则) teleport here from the tab component -->
        <span id="cfg-actions" class="cfg__page-acts"></span>
        <UiTabs v-if="ui.mode === 'json'" class="cfg__mode" :model-value="ui.mode" :items="modes" label="配置视图" variant="segment" @update:model-value="setMode" />
        <UiMenu class="cfg__more" :items="moreItems" label="更多配置操作" title="配置" @select="pickMore" />
      </template>
    </UiPageHeader>

    <div v-if="notice && ready" class="ui-notice cfg__notice" tabindex="-1" :class="notice.tone === 'err' ? 'ui-notice--err' : notice.tone === 'off' ? 'ui-notice--off' : ''" :role="notice.tone === 'err' ? 'alert' : 'status'">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></svg>
      <span>{{ notice.text }}</span>
      <small v-if="notice.detail"><RuleText :text="notice.detail" @rule="openRule($event, null)" @group="groupEditor = { id: $event }" /></small>
      <button v-if="notice.action" class="ui-btn ui-btn--secondary ui-btn--sm ui-notice__action" type="button" :disabled="applyBusy" @click="runNotice">{{ notice.action }}</button>
    </div>

    <input ref="fileInput" class="visually-hidden" type="file" accept=".json,application/json" @change="importFile">
    <!-- 侧栏收起时（≤860）分区页签在这一行；宽屏上分区在侧栏里，这一行只在 JSON 视图时出现（≥861 由 CSS 藏起页签）
         With the sidebar folded (≤860) the section tabs sit on this row; on wide screens sections live in the sidebar and the row shows only in the JSON view (CSS hides the tabs at ≥861) -->
    <div v-if="!firstRun && (compact || ui.mode === 'json')" class="cfg__nav" :class="{ 'cfg__nav--json': ui.mode === 'json' }">
      <div v-if="ui.mode === 'json'" class="cfg__whole"><h2>完整配置</h2><button class="ui-btn ui-btn--text ui-btn--sm ui-btn--inline cfg__to-form" type="button" @click="setMode('form')">回到表单</button></div>
      <UiTabs v-else class="cfg__tabs" :model-value="section" :items="tabs" label="配置分类" id-prefix="cfg" @update:model-value="setTab" />
    </div>

    <div v-if="loading && !doc" class="cfg__skeleton" role="status" aria-label="正在读取配置">
      <div class="cfg__sk-tools"><i class="sk"></i><i class="sk"></i><span></span><i class="sk"></i><i class="sk"></i></div>
      <div class="ui-card cfg__sk-list"><div v-for="n in 7" :key="n" class="cfg__sk-row"><i class="sk"></i><span><i class="sk"></i><i class="sk"></i></span><i class="sk"></i><i class="sk"></i></div></div>
    </div>
    <!-- 连不上面板时什么都没读到：只写一句连上后会自己打开，原因和重试交给顶上的横幅 / Nothing read with the panel unreachable: one line saying it opens by itself once connected; the cause and the retry belong to the banner above -->
    <p v-else-if="loadError && !doc && panelDown" class="ui-notice ui-notice--off cfg__wait" role="status"><Clock :size="16" aria-hidden="true" /><span>连上面板后自动打开</span></p>
    <div v-else-if="loadError && !doc" class="cfg__failed">
      <p class="cfg__failed-title">读取配置失败</p>
      <p class="cfg__failed-reason">{{ loadError }}</p>
      <button class="ui-btn ui-btn--secondary" type="button" @click="reload(false)"><RefreshCw :size="16" aria-hidden="true" />重试</button>
    </div>
    <div v-else-if="ui.mode === 'json'" class="cfg__json ui-fade">
      <p class="cfg__json-note">这里是 KixDNS 读的配置，可以直接改。切回表单时会重新读一遍；规则名、备注、停用的规则这些面板自己的信息另外保存，不在这里。</p>
      <JsonEditor ref="jsonEditor" v-model="jsonText" class="cfg__json-editor" :error-line="jsonError?.line" />
    </div>
    <div v-else :id="`cfg-panel-${section}`" class="cfg__panel" role="tabpanel" :aria-labelledby="`cfg-tab-${section}`">
      <div v-if="section === 'rules'" class="rules-split" :class="{ 'is-open': inspector }">
        <RulesTab :selected="editor?.ruleId ?? null" @open="openRule" @tab="setTab" @edit-group="groupEditor = { id: $event }" @import="fileInput?.click()" />
        <RuleEditor v-if="inspector && editor" ref="editorRef" :key="`${editor.ruleId}-${editor.groupId}`" inspector :rule-id="editor.ruleId" :group-id="editor.groupId" :template="editor.template" :resume="editor.resume" @close="closeRule" @saved="ruleSaved" @deleted="ruleDeleted" @edit-group="groupEditor = { id: $event }" />
      </div>
      <UpstreamsTab v-else-if="section === 'upstreams'" @edit="groupEditor = { id: $event }" @rules="showGroupRules" />
      <MappingTab v-else-if="section === 'mapping'" />
      <SettingsTab v-else />
    </div>
    <SaveBar v-if="ready" :json-error="jsonError" :json-dirty="jsonDirty" :flush="flush" @rule="openRule($event, null)" @group="groupEditor = { id: $event }" @reveal="(l: number, c: number) => jsonEditor?.reveal(l, c)" @reload="reload()" @download="downloadJson" @discarded="afterDiscard" />
  </div>
  <GroupEditor v-if="groupEditor" :key="groupEditor.id ?? 'new'" :group-id="groupEditor.id" @close="groupEditor = null" @saved="groupSaved" @deleted="groupDeleted" />
  <HistoryDrawer v-if="historyOpen" :compare-with="historyOpen.compare" @close="historyOpen = null" @rule="historyOpen = null; openRule($event, null)" @restored="afterRestore" />
  <ImportReportDialog v-if="reportOpen && importReport" :undo="Boolean(undoImport)" @close="reportOpen = false; undoImport = null" @undo="undoImport?.()" />
</template>
