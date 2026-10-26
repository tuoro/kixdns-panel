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
import BlocklistTab from '../config-v2/BlocklistTab.vue'
import MappingTab from '../config-v2/MappingTab.vue'
import RuleEditor, { type EditorResume } from '../config-v2/RuleEditor.vue'
import RulesTab from '../config-v2/RulesTab.vue'
import RuleText from '../config-v2/RuleText.vue'
import SaveBar from '../config-v2/SaveBar.vue'
import SettingsTab from '../config-v2/SettingsTab.vue'
import UpstreamsTab from '../config-v2/UpstreamsTab.vue'
import { useCompact, usePhone, useWide } from '../config-v2/phone'
import { dialogEdits, dirty, discardOnLeave, sectionEdits, discardWithUndo, editorEdited, importReport, importSource, jsonEdited, model, replaceModel, reportOpen, ui, unsaved } from '../config-v2/store'
import { applyBusy, bulkDeleting, busy, checkFirst, checkInstead, checkPending, heldLostSave, leaveMark, promiseDraftKept, lostWrite, lostWriteWhy, pageLocked, refuseWhileLocked, whenSettledOrLocked, deleting, deferSave, hasPending, origin, rereading, restoredCount, conflict, dropEditsAfterSave, saveInFlight, onlySaving, leavingDuringSave, stayedDuringSave, setViewing, applyError, applyNow, canApplyNow, canCname, capabilityError, currentVersionId, doc, failureCause, hasApplyFailure, headerAction, headerLine, load, loadError, save, loading, pendingVersionId, refreshRuntime, beginOwnWrite, readAfterOwnWrite, readFresh, readQuietly, restartPending, restartRollback, runtimeDown, runtimeStopped, runtimeUnavailable, cnameInUse, cnameUse } from '../config-v2/useConfigDocument'
import { dismissBlocklistToasts } from '../config-v2/useBlocklists'
import { carryUpdate, refreshLanded, returnedToPage } from '../config-v2/updateCarry'
import { useHelp } from '../composables/useHelp'
import { useSession } from '../composables/useSession'
import { backUnconfirmed, dismissRefused, downShownHere, nameWith, readBeforeTelling, restartingKixdns, rollingBackKixdns, startingKixdns, useServiceRestart, useServiceStart, versionName } from '../composables/useServiceStart'
import { settingNames, settingValues } from '../config-editor/schema'
import { noticeRuns } from '../utils'
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
const session = useSession()
const toast = useToast()
const confirm = useConfirm()
const phone = usePhone()
const compact = useCompact()
const wide = useWide()
const tabs = [{ value: 'rules', label: '规则' }, { value: 'upstreams', label: '上游组' }, { value: 'mapping', label: '域名映射' }, { value: 'blocklists', label: '拦截列表' }, { value: 'settings', label: '基础设置' }]
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
// nonce：同一条规则重新打开（重读以后换成读进来的那条）时换个 key，让编辑重新装上 / nonce: a new key when the same rule reopens (on the rule just read), so the editor mounts afresh
const editor = ref<{ ruleId: number | null; groupId: string | null; template?: Partial<Rule>; resume?: EditorResume | null; nonce?: number } | null>(null)
// 重读以后接着开着同一条规则：焦点原来在编辑里的，回到规则名上，不掉到页面开头 / Reopening the same rule after a re-read: focus that was in the editor returns to the rule name instead of dropping to the page start
function reopenRule(): void {
  if (!editor.value) return
  const hadFocus = Boolean(document.activeElement?.closest('.editor'))
  editor.value = { ...editor.value, resume: null, nonce: (editor.value.nonce ?? 0) + 1 }
  if (hadFocus) void nextTick(() => document.querySelector<HTMLElement>('.editor .editor__name')?.focus({ preventScroll: true }))
}
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
  // 重新读取、恢复版本还在读：读回来的会整份换掉草稿，这时打开的编辑会落在旧的上面（快捷键 n、提示条里的规则名都走这里） / A re-read or restore is reading: what comes back replaces the draft, so an editor opened now would sit on the old one (the n shortcut and the notice's rule names come through here)
  if (rereading.value) return
  // 页面锁着（回应丢了的写入还没核对）：不打开编辑（窄屏的整页编辑器在锁住的区域外面，快捷键 n 也走这里） / The page is locked (a lost write
  // unchecked): no editor opens (the narrow full-page editor sits outside the locked area, and the n shortcut comes here too)
  if (pageLocked.value) return
  if (ui.mode === 'json' && !leaveJson()) return
  if (editor.value && (ruleId === null || editor.value.ruleId !== ruleId) && !(await editorRef.value?.confirmDiscard() ?? true)) return
  // 确认框开着时锁住了：不开新的编辑 / Locked while the confirm was open: no new editor opens
  if (pageLocked.value) return
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
// 打开上游组抽屉：锁着时不开新的，说一句（锁住以前开着的整页编辑器里还点得到「在上游组里修改」） / Open the upstream group drawer: no new one
// while locked, and a line says why (the full-page editor open since before the lock still offers 在上游组里修改)
function openGroup(id: string | null): void {
  if (!refuseWhileLocked('打开上游组')) groupEditor.value = { id }
}
function groupDeleted(group: UpstreamGroup, index: number): void {
  groupEditor.value = null
  toast.undoable(`已删除上游组「${group.name}」`, () => model.groups.splice(index, 0, group))
}

// ---------- 通知条：一次只说一件事 / the notice strip: one thing at a time ----------
const geoPrefixed = computed(() => [...model.rules, ...model.ruleGroups.flatMap((g) => g.rules)].flatMap((r) => r.conditions.flat()).filter((c) => c.field === 'geosite' && c.values.some((v) => /^geosite:/i.test(v))).length)
// links：说明里「」中的显示名对到规则编号（CNAME 提示点名的规则） / links: display titles in 「」 within the detail mapped to rule ids (the rules the CNAME notice names)
// down：这一条在说 KixDNS 起不来，别处带来的「启动失败」提示就不另说 / down: this one says KixDNS does not come up, so a 启动失败 toast
// brought from elsewhere is not said again
// failure：这一条在说某一版没有生效 / failure: this one says a version did not take
// held：按钮这时按住（停用的样子），位置照留 / held: the button is held for now (looks disabled), keeping its place
interface Notice { tone: 'err' | 'warn' | 'off'; text: string; detail?: string; links?: Record<string, number>; action?: string; run?: () => void | Promise<void>; down?: boolean; failure?: boolean; held?: boolean }
const notice = computed<Notice | null>(() => {
  // 连不上面板时由顶上的横幅说，这里不复述 / With the panel unreachable the banner says it; no second copy here
  // 一次写入（保存、现在应用、校验并应用、重试应用）回应丢了、还没核对：页面锁着，只由这里说不知道，断线时也说（「连不上面板」由横幅说，这里
  // 只说连上后会核对）；读不到配置时原因跟着它，不另说「读取配置失败」
  // A write (a save, 现在应用, 校验并应用, 重试应用) lost its answer and is unchecked: the page is locked and only this says it is unknown,
  // during the outage too (the banner says 连不上面板, so this only says it is checked once back); with the config unreadable the cause goes
  // with it rather than a separate 读取配置失败
  if (lostWrite.value && doc.value) {
    const why = lostWriteWhy.value
    const cause = loadError.value.replace(/[。.]\s*$/, '')
    const detail = why === 'down' ? '连上后会自己核对' : why === 'checking' ? '正在核对' : cause ? `读不到配置：${cause}。读到后会自己核对` : '读不到配置。读到后会自己核对'
    // 连上以后都有「重试」，提示条的高度不随原因变；只有读不到配置时能按（再核对一次），正在核对时按住。连不上时不放：横幅上有同一个，它收起
    // 的那一帧提示条才变高，人只看到一次变动 / Once back, 重试 shows for every reason, so the notice keeps its height; it can be pressed only
    // with the config unreadable (to check once more), and is held while checking. Not while unreachable: the banner has the same one, and
    // the notice grows in the very frame the banner goes, a single change to see
    return { tone: 'err', text: `${lostWrite.value.head}。`, detail, action: why === 'down' ? undefined : '重试', run: () => reload(true), held: why === 'checking' }
  }
  if (loadError.value && doc.value && !panelDown.value) return { tone: 'err', text: '读取配置失败，下面是上一次读到的内容。', detail: loadError.value, action: '重试', run: () => reload(true) }
  // 起不来：多半是改过的设置让它起不来（新的监听地址被占着），退回它们上次正常启动时的值再重启。状态由页头说（「启动失败」），
  // 这里只说原因和出路；草稿有没保存的修改时先保存或放弃：退回改的是存下的那份，不动草稿
  // Not coming up: most likely a changed setting keeps it down (a new listen address is taken), so put them back to the values it
  // last started with and restart. The header says the state (启动失败); this says only the cause and the way out; with unsaved
  // edits, save or discard first: the rollback changes the saved config, not the draft
  if (restartRollback.value && !panelDown.value) {
    const keys = Object.keys(restartRollback.value)
    const text = `可能是改过的设置让 KixDNS\u00a0起不来：${settingNames(keys)}。`
    return unsaved.value && !rollingBackKixdns.value ? { tone: 'err', text, detail: '先保存或放弃草稿里的修改，再退回这些设置', down: true } : { tone: 'err', text, action: '退回原来的设置并重启', run: rollbackSettings, down: true }
  }
  // 回应丢了的那次写入还没核对时轮不到这里（第一支说「不知道」），不照断线前读到的说没有生效 / A lost write still unchecked never gets
  // here (the first branch says 「不知道」), so nothing calls it not taken from what was read before the outage
  if (hasApplyFailure.value) {
    const reason = doc.value?.runtime.pending_error || doc.value?.pending?.error || 'KixDNS 没有给出原因。'
    // 草稿有修改时不给「重试应用」：那时保存的是草稿，重试会把草稿当成失败的那个版本发出去 / No retry while the draft has changes: saving then sends the draft, not the version that failed
    const retry = canApplyNow.value && !unsaved.value && !panelDown.value && !conflict.value
    // 重试撞上「别处改过了」：再重试还是撞上，按钮换成重新读取 / A retry that met 别处改过了 would meet it again: the button becomes 重新读取
    const reread = conflict.value && !panelDown.value
    const cause = failureCause(reason).replace(/。$/, '')
    // KixDNS 还停着：没有哪份配置「在用」，照实说停了；原因说它在确认前停了，启动后用之前那份 / KixDNS still stopped: no config is in use, so the stop is said; the cause says it stopped before confirming and the previous config runs on start
    // 退回写下的版本不报编号：没有生效的只会是带上的那笔修改 / A version a rollback wrote has no number: if it did not take,
    // it can only be the edits carried along
    const origin = doc.value?.pending?.from_rollback
    const which = origin && pendingVersionId.value ? versionName(pendingVersionId.value, origin, true) : pendingVersionId.value ? `版本 #${pendingVersionId.value} ` : '上次保存的版本'
    // KixDNS 起不来时没有哪份配置「在用」，状态由页头说（「启动失败」）；只有真停着才说停了
    // With KixDNS not coming up no config is in use, and the header says the state (启动失败); only a real stop is said as stopped
    const downNow = runtimeDown.value
    const stoppedNow = runtimeStopped.value && !downNow
    const why = cause === 'KixDNS 在确认新配置前停了' ? '它在确认新配置前停了' : cause
    // 起不来时重试不了（应用要 KixDNS 在），出路是看日志 / Not coming up there is nothing to retry (applying needs KixDNS), and the
    // way out is the logs
    if (downNow) return { tone: 'err', text: `${which}没有生效。`, detail: `${why}；KixDNS 启动后会用之前那份配置`, action: '查看日志', run: openLogs, down: true, failure: true }
    return { tone: 'err', text: stoppedNow ? `${which}没有生效，KixDNS\u00a0已停止。` : `${which}没有生效，仍在用之前那份配置。`, detail: stoppedNow ? `${why}；启动后会用之前那份配置` : reread ? `${cause}。这份配置在别处改过了，先重新读取。` : cause, action: reread ? '重新读取' : retry ? '重试应用' : undefined, run: reread ? () => reload() : retry ? () => save('apply') : undefined, failure: true }
  }
  // 连不上面板时由顶上的横幅说；连上以后核对的结果再说应用了没有 / While the panel is unreachable the banner speaks; once back, the check says whether it applied
  if (applyError.value && !panelDown.value) { const [text, ...detail] = applyError.value.split('\n'); return { tone: 'err', text: `${text}。`, detail: detail.join('\n') } }
  // 起不来、又没有可以退回的设置：状态由页头说（「启动失败」）。存了还没写进配置文件的待应用版本时给出路——KixDNS 启动时读的
  // 是配置文件，起不来就轮不到待应用的版本，直接写进去再重启（KixDNS 不在，没法先校验，确认框照实说）；草稿有修改时先保存或
  // 放弃，写完整份重读。没有、或者已经写进去了（退回、写进去以后还是起不来）时指到日志
  // Not coming up with nothing to put back: the header says the state (启动失败). With a pending version stored that is not in
  // the config file yet there is a way out — KixDNS reads the file when it starts, so while it does not come up the pending
  // version never gets its turn, and this writes it in before a restart (KixDNS is not there to check it first, and the confirm
  // says so); with edits in the draft, save or discard first, as the page is read again whole afterwards. Without one, or with
  // it in the file already (still down after a rollback or a write), it points to the logs
  if (runtimeDown.value && !panelDown.value) {
    const waiting = hasPending.value ? doc.value?.runtime.pending_writable ?? null : null
    if (!waiting) return { tone: 'err', text: '起不来的原因在运行日志里。', action: '查看日志', run: openLogs, down: true }
    // 一句写前写后都成立的话：按下以前说出路，写的途中读作正在做的事，按下时不换字；只说启动那一刻读的是文件，不和保存条的
    // 「启动后自动应用」打架 / One sentence true before and after the write: before the press it names the way out, midway it reads
    // as what is being done, and no words change at the press; it says only that the start reads the file, without contradicting
    // the save bar's 启动后自动应用
    const text = `版本\u00a0#${waiting}\u00a0要写进配置文件，KixDNS\u00a0启动时才读得到它。`
    return unsaved.value && !rollingBackKixdns.value ? { tone: 'err', text, detail: '先保存或放弃草稿里的修改，再写进配置文件', down: true } : { tone: 'err', text, action: '写进配置文件并重启', run: writePendingIn, down: true }
  }
  // 警告排在说明前面：永远不命中的规则比导入说明要紧 / Warnings rank above information: a rule that never matches matters more than the import notes
  if (geoPrefixed.value) return { tone: 'warn', text: `${geoPrefixed.value} 个 GeoSite 条件多写了「geosite:」前缀，内核找不到对应的分类，永远不会命中。`, action: '去掉前缀', run: stripPrefix }
  // 改过、要重启才生效的设置：KixDNS 还在用启动时的值，按钮就地重启（连不上面板时由横幅说） / Settings that take a restart: KixDNS still runs
  // the values it started with, and the button restarts it right here (with the panel unreachable the banner speaks)
  if (restartPending.value.length && !panelDown.value) return { tone: 'warn', text: `改过的设置要重启 KixDNS\u00a0才生效：${settingNames(restartPending.value)}。`, action: '重启 KixDNS', run: restartForSettings }
  if (importReport.value && !reportOpen.value && importReport.value.stats.raw) return { tone: 'off', text: `这份配置是按内核格式读进来的，${importReport.value.stats.raw} 条规则原样保留为高级规则。`, action: '查看导入说明', run: () => { reportOpen.value = true } }
  // 没运行、连不上时页头已经说了，功能列表拿不到是它的结果，不另起一条 / When stopped or unreachable the header says so; the missing feature list follows from it
  if (capabilityError.value && !runtimeStopped.value && !runtimeUnavailable.value) return { tone: 'off', text: 'KixDNS 没有报告它支持哪些功能：新功能先按不支持处理，保存后先存成待应用版本。' }
  // 说出有几处，域名映射里有的就给去那里的按钮 / Say how many places, with a button to the domain mappings when some are there
  if (!canCname.value && cnameInUse.value && !capabilityError.value) {
    const them = cnamePlaces.value.total > 1 ? '它们' : '它'
    return { tone: 'warn', text: `当前内核不支持 CNAME\u00a0回答：有\u00a0${cnamePlaces.value.total}\u00a0处回答写的是域名，KixDNS 不会接受这份配置。把${them}改成 IP，或者更新内核。`, ...cnameWhere.value, action: cnamePlaces.value.mappings && section.value !== 'mapping' ? '去域名映射' : undefined, run: () => setTab('mapping') }
  }
  return null
})
// 写成域名的回答有几处：按看得见的东西数——认回来的规则、开着的写成域名的映射、认不回来的几处——和下面点名的对得上
// How many answers are domains: counted in what the user sees — the rules traced back, enabled mappings answering with a domain, the places that do not trace
// back — so it matches what is named below
const cnamePlaces = computed(() => {
  const mappings = model.mappings.filter((m) => m.enabled && !mappingIsIp(m)).length
  return { mappings, total: cnameUse.value.rules.length + mappings + cnameUse.value.untraced }
})
// 规则名太长时截在一整项后面：先找「、」「且」，没有才找空格，都没有才截在字中间；截掉的地方写「…」
// A long rule title is cut after a whole item: at 、 or 且 first, then a space, and mid-word only without either; the cut is marked 「…」
function cutTitle(full: string): string {
  if (full.length <= 36) return full
  const head = full.slice(0, 35)
  const list = head.lastIndexOf('、')
  const and = head.lastIndexOf(' 且 ')
  if (list > 8 || and > 8) return list > and ? `${head.slice(0, list)}…` : `${head.slice(0, and + 2)}…`
  const space = head.lastIndexOf(' ')
  return `${(space > 8 ? head.slice(0, space) : head).replace(/[\s.\-_]+$/, '')}…`
}
// 说出写成域名的是哪几条规则：点名前两条（点了打开那条规则），多的写「等 N 条」，域名映射只数条数（有「去域名映射」），认不回规则的几处说只能在 JSON 里改；
// 只有映射时不另起一行
// Name the rules whose answers are domains: the first two by name (a click opens that rule), the rest as 「等 N 条」, mappings only counted (they have 去域名映射),
// and places that trace back to no rule as editable only in JSON; with mappings alone no extra line
const cnameWhere = computed((): { detail?: string; links?: Record<string, number> } => {
  const rules = cnameUse.value.rules
  const untraced = cnameUse.value.untraced
  // 没有认得回的规则：全是只能在 JSON 里改的就直说「这处 / 这 N 处」，还有映射时说「其中 N 处」 / No rule traced back: when every place is JSON-only say 这处 / 这 N 处, with mappings too say 其中 N 处
  if (!rules.length) {
    if (!untraced) return {}
    if (untraced < cnamePlaces.value.total) return { detail: `其中\u00a0${untraced}\u00a0处只能在 JSON 里改` }
    return { detail: untraced === 1 ? '这处回答只能在 JSON 里改' : `这\u00a0${untraced}\u00a0处回答都只能在 JSON 里改` }
  }
  const links: Record<string, number> = {}
  for (const rule of rules.slice(0, 2)) {
    const title = cutTitle(ruleTitle(rule).replace(/[「」]/g, ''))
    if (!(title in links)) links[title] = rule.id
  }
  const named = Object.keys(links).map((title) => `「${title}」`).join('')
  const more = rules.length > Object.keys(links).length ? `等\u00a0${rules.length}\u00a0条` : ''
  const mappings = cnamePlaces.value.mappings ? `、域名映射\u00a0${cnamePlaces.value.mappings}\u00a0条` : ''
  const json = untraced ? `，另有\u00a0${untraced}\u00a0处只能在 JSON 里改` : ''
  return { detail: `写成域名的有：规则${named}${more}${mappings}${json}`, links }
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
// 页面自己看着恢复落地，不靠抽屉转告：恢复途中关掉抽屉，JSON 里同意丢掉的修改以前会留下来，切回表单又把恢复改回去
// The page watches the restore land itself instead of relying on the drawer: closing the drawer mid-restore used to keep the JSON edits the user agreed to
// drop, and going back to the form then reverted the restore
watch(restoredCount, afterRestore)
function leaveJson(): boolean {
  if (jsonError.value) { toast.info('JSON 写错了，改好才能切换'); return false }
  foldJson()
  ui.mode = 'form'
  return true
}
// 保存、校验之前（save）：面板里没点「完成」的修改和 JSON 里的修改先收进草稿；放弃和查看之前（fold）只收 JSON 里的
// Before save or validate (save): the panel's edits not yet 完成 and the JSON edits go into the draft first; before discard or review (fold) only the JSON ones
function flush(purpose: 'save' | 'fold'): boolean {
  if (purpose === 'save' && editor.value && editorRef.value && !editorRef.value.commit(inspector.value)) return false
  if (jsonDirty.value) {
    if (jsonError.value) return false
    foldJson()
  }
  return true
}
function setMode(m: string): void { if (m === 'json') void enterJson(); else leaveJson() }
// 从 JSON 回到表单要重新读一遍文字：读配置、退回设置、页面锁着时都不行，三处入口（切换、「回到表单」、菜单）一个条件
// Going back from JSON to the form re-reads the text: not while reading, rolling back or locked, one condition for all three ways (the
// switch, 回到表单 and the menu)
const jsonExitBlocked = computed(() => rereading.value || rollingBack.value || pageLocked.value)
const modes = computed(() => [{ value: 'form', label: '表单', icon: Settings2, disabled: jsonExitBlocked.value }, { value: 'json', label: 'JSON', icon: Braces }])
// 重新读取、恢复版本还在读：会换掉草稿、读草稿的几项都等它读完（以前恢复途中还能导入，读回来悄悄盖掉；「重试应用」会让恢复撞上自己写的版本）
// While 重新读取 or a restore is reading, the items that replace or read the draft wait for it (an import during a restore used to be silently overwritten
// when the read landed, and 重试应用 made the restore collide with the version this page had just written)
// 页面锁着时，会改草稿、换草稿、写入的几项都停用（历史里也写不了）；下载照常 / While the page is locked the items that change, replace or write
// the draft are disabled (the history cannot write either); downloading stays
const moreItems = computed(() => [
  { value: 'history', label: '历史版本', icon: History, disabled: !ready.value || rereading.value || pageLocked.value },
  { value: 'mode', label: ui.mode === 'json' ? '回到表单' : '查看 JSON', icon: ui.mode === 'json' ? Settings2 : Braces, disabled: !ready.value || (ui.mode === 'json' ? jsonExitBlocked.value : rereading.value || pageLocked.value) },
  // 保存途中不导入：导入会换掉草稿，和重新读取一样等保存做完 / No import during a save: it replaces the draft, so it waits for the save like 重新读取
  { value: 'import', label: '导入 JSON', icon: FileUp, disabled: !ready.value || saveInFlight.value || rereading.value || pageLocked.value },
  { value: 'download', label: '下载 JSON', icon: Download, disabled: !ready.value },
  // 连不上面板时读不到，按了只会失败 / Unreachable panel: the read can only fail
  // 保存途中也不重新读取：读进来的会被那次保存覆盖，「之后改的」就成了撤回刚保存的 / Not during a save either: the read would be overtaken by that save, and 之后改的 would become a revert of what was just saved
  { value: 'reload', label: '重新读取配置', icon: RefreshCw, disabled: loading.value || panelDown.value || saveInFlight.value || rereading.value || pageLocked.value },
  // 手机的保存条放不下「放弃修改」，放在这里；桌面的保存条上有（冲突时那里只有「重新读取」） / The phone save bar has no room for 放弃修改, so it lives here; the desktop bar shows it (in a conflict it offers 重新读取 instead)
  ...(phone.value && unsaved.value ? [{ value: 'discard', label: '放弃修改', icon: Undo2, disabled: saveInFlight.value || rereading.value || pageLocked.value }] : []),
  { value: 'help', label: '帮助', icon: CircleHelp },
])
function pickMore(value: string): void {
  if (value === 'history') historyOpen.value = { compare: null }
  else if (value === 'mode') setMode(ui.mode === 'json' ? 'form' : 'json')
  else if (value === 'import') fileInput.value?.click()
  else if (value === 'download') downloadJson()
  else if (value === 'help') help.show('config')
  // 文件在别处改过了：放弃修改就是重新读取面板上现在的那份 / The file was changed elsewhere: discarding means re-reading what the panel holds now
  else if (value === 'discard' && conflict.value) void reload()
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
  if (file.size > 4 * 1024 * 1024) { toast.error('配置文件不能超过 4\u00a0MiB'); return }
  let parsed: Record<string, unknown>
  const text = await file.text()
  const problem = jsonSyntaxProblem(text)
  if (problem) { toast.error(`${file.name} 不是合法的 JSON：${jsonProblemText(problem)}`); return }
  parsed = JSON.parse(text) as Record<string, unknown>
  // 合法的 JSON 不一定是 KixDNS 配置：最外层要是对象，至少有 settings、pipelines 这类内核认的键 / Valid JSON is not necessarily a KixDNS config: the top level must be an object with at least one key the kernel reads
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { toast.error(`${file.name} 不是 KixDNS 配置：最外层要是 { … }`); return }
  if (!['version', 'settings', 'pipelines', 'pipeline_select'].some((key) => key in parsed)) { toast.error(`${file.name} 不是 KixDNS 配置：里面没有 settings、pipelines 这些内容`); return }
  // 选文件、确认的时候页面可能锁住了、开始了保存或重新读取（菜单里的导入这时停用）：到这一步不导入，说一句
  // The page may have locked, or a save or re-read begun, while the file was being picked or the confirm was open (the menu's import is
  // disabled then): nothing is imported at this point, and a line says why
  const held = (): boolean => {
    if (refuseWhileLocked(`导入 ${file.name}`)) return true
    if (saveInFlight.value || rereading.value) toast.info(`没有导入 ${file.name}：${saveInFlight.value ? '保存还没做完，做完再导入' : '正在读取配置，读完再导入'}`)
    return saveInFlight.value || rereading.value
  }
  if (held()) return
  if (unsaved.value && !(await confirm.ask({ title: '放弃未保存的修改', body: '导入的文件会替换现在的草稿，没保存的修改会丢失。', confirmLabel: '放弃修改并导入', destructive: true }))) return
  if (held()) return
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
// 说明开着时页面锁住了：撤销会整份换掉草稿，不做，说一句；核对说完还能撤销 / The page locked with the report open: an undo would replace the
// draft wholesale, so it is not done and a line says why; it can still be undone once checked
function undoImportNow(): void {
  if (!refuseWhileLocked('撤销导入')) undoImport.value?.()
}
function downloadJson(): void {
  if (ui.mode === 'json' && jsonError.value) { toast.error('JSON 写错了，改好再下载'); return }
  // 右侧规则里没点「完成」的修改也是草稿的一部分：先收进来再下载（冲突时下载完就要重新读取，漏掉它就丢了）；写得不完整就先说
  // Edits in the side panel not yet 完成 are part of the draft too: fold them in before downloading (in a conflict the download is followed by 重新读取, which
  // would lose them); when the rule is incomplete, say so first
  // 页面锁着时右栏也锁着：不替它收，下载的是草稿现在的样子 / With the page locked the side panel is locked too: it is not folded in, and the
  // download is the draft as it stands
  if (ui.mode !== 'json' && editor.value && editorRef.value && !pageLocked.value && !editorRef.value.commit(inspector.value, '下载')) return
  const data = ui.mode === 'json' ? jsonText.value : JSON.stringify(exportConfig(model), null, 2)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
  a.download = 'kixdns-config.json'
  a.click()
  URL.revokeObjectURL(a.href)
}
async function reload(ask = true): Promise<void> {
  // 回应丢了的那次写入还没核对：「重试」「重新读取」就是去核对，结果由核对说，不问要不要丢掉修改（见 checkInstead）
  // A lost write is still unchecked: 重试 and 重新读取 are the check, which tells the result, and nothing asks to drop the edits (see
  // checkInstead)
  if (await checkInstead()) return
  if (ask && unsaved.value && !(await confirm.ask({ title: '放弃未保存的修改', body: '重新读取会丢掉没保存的修改。', confirmLabel: '放弃修改并重新读取', destructive: true }))) return
  // 确认框开着时又有一次写入的回应丢了：这一按就是去核对，不整份重读 / Another write lost its answer while the confirm was open: the press
  // becomes the check, with no whole re-read
  if (await checkInstead()) return
  editor.value = null
  ui.mode = 'form'
  await load()
}

// ---------- 进出页面 / entering and leaving ----------
// JSON 文本只活在这一页里：回到配置页总是从表单开始，免得 JSON 视图空着又切不回表单
// The JSON text lives only on this page: coming back always starts in the form, so the JSON view never reopens empty and stuck
// 只有规则编辑里没点「完成」的、或开着的抽屉里的修改时，问的是那一样；草稿或 JSON 有修改时问整份草稿
// With only a rule edit not yet 完成, or an open drawer's edits, the question names that one thing; with draft or JSON edits it is about the whole draft
// purpose 是 signout 时按钮写「放弃并退出 / 先不退出」，和在别处退出登录时一样 / With purpose signout the buttons read 放弃并退出 / 先不退出, as when signing out from elsewhere
const askLeave = async (purpose?: 'signout'): Promise<boolean> => {
  // 每问一次重新算：上一次退出登录没成功时留下的不算数 / Each ask starts afresh: what a failed sign-out left behind no longer counts
  signoutDrop = false
  const labels = purpose === 'signout' ? { confirmLabel: '放弃并退出', cancelLabel: '先不退出' } : { confirmLabel: '放弃修改', cancelLabel: '继续编辑' }
  // 正在保存、之后没再改：保存照常做完，结果会用提示说，不问「放弃」（问了也放弃不了） / Saving with nothing changed since: the save finishes and a toast tells its outcome, so no 放弃 question (it could not discard anyway)
  if (!unsaved.value) return true
  // 记下是因为保存在跑才放行的：页面卸下之前保存就失败了，也照「人已经走了」留草稿、说原因 / Note that the save let this leave through: a failure before
  // the page unmounts still keeps the draft and says why, as for someone already gone
  if (onlySaving()) { leavingDuringSave(); return true }
  if (!dirty.value && !jsonDirty.value) return confirm.ask({ title: `放弃${editorEdited.value ? '这条规则' : [...dialogEdits.values()][0] ?? '这条规则'}的修改`, body: '刚才在这里改的内容不会写进草稿。', ...labels, destructive: true })
  // 正在保存时又改过：正在保存的那份照常落地，丢掉的只是之后改的 / Edited again during a save: the part being saved still lands, only the later edits are dropped
  // 同意了就把草稿退回正在保存的那一份：保存没成功时回来看到的正是它，不会冒出说好丢掉的那几处 / On agreement the draft goes back to the one being saved: a failed save brings back exactly that, not the edits agreed to drop
  // 只有保存草稿才有「正在保存的那份」；「现在应用」途中改的，问的就是整份草稿 / Only a draft save has 「the one being saved」; edits during 现在应用 are asked about as the whole draft
  if (saveInFlight.value && origin.value === 'draft') {
    const agreed = await confirm.ask({ title: '放弃保存开始后改的内容', body: '正在保存的那份照常保存；保存开始以后改的会丢掉。', ...labels, destructive: true })
    if (agreed && purpose !== 'signout') agreedDrop = dropEditsAfterSave
    return agreed
  }
  // 回应丢了的那次保存还没核对（页面锁着）：存没存上不知道，不说成「未保存」；离开不问，草稿留到回来，离开以后由提示说核对的结果。
  // 退出登录照实说不再告诉结果
  // The lost save still unchecked (the page is locked): whether it landed is unknown, so it is not called unsaved; leaving asks nothing,
  // the draft is kept for the return and a toast tells the check's result away. Signing out says plainly that no result will follow
  if (heldLostSave() && purpose === 'signout') {
    // 头一句照提示条说（立即更新替人做的保存说「新下载的拦截列表…」） / The first sentence as the notice says it (a save 立即更新 made reads
    // 新下载的拦截列表…)
    const agreed = await confirm.ask({ title: '放弃这份草稿', body: `${lostWrite.value?.head ?? '刚才那次保存不知道存上没有'}。退出登录以后不再告诉你结果，没存上的修改也会丢掉。`, ...labels, destructive: true })
    if (agreed) signoutDrop = true
    return agreed
  }
  // 只有还没收进草稿的修改（JSON 里的、右栏没点完成的、对话框里的）会丢：问那一样 / Only edits not yet in the draft (in the JSON view, an
  // unfinished side panel, a dialog) would be lost: ask about those
  if (heldLostSave()) {
    if (!jsonDirty.value && !editorEdited.value && dialogEdits.size === 0) return true
    const what = jsonDirty.value ? ' JSON 里' : editorEdited.value ? '这条规则' : [...dialogEdits.values()][0] ?? '这条规则'
    const mark = leaveMark()
    const agreed = await confirm.ask({ title: `放弃${what}的修改`, body: '刚才在这里改的内容不会写进草稿。草稿留着，核对完会说结果。', ...labels, destructive: true })
    // 问着的时候核对可能说完了：照说过的「草稿留着」，离开时把草稿留到回来（见 promiseDraftKept） / The check may finish while this is
    // asked: as promised, the draft is kept for the return on leaving (see promiseDraftKept)
    if (agreed) promiseDraftKept(mark)
    return agreed
  }
  const agreed = await confirm.ask({ title: '放弃未保存的修改', body: '当前的配置草稿会被丢弃，已经生效的配置不受影\u2060响。', ...labels, destructive: true })
  // 同意了就丢掉，不等回来时重读：「现在应用」还在做时回来不会重读，应用自己的重读又留着修改；在路上的「立即更新」落地时看到的也是干净的草稿，
  // 照没有修改时那样直接生效。等换页真的成了再丢（见下面的 afterEach），没成就留着
  // 退出登录不丢：会话一结束，再进配置页那次读本来就会换掉草稿；退出没成功时修改还在。只有「现在应用」还在做时马上丢，它做完的重读会留着修改
  // On agreement the edits go without waiting for the return's read: with 现在应用 still running a return skips its read and the apply's own re-read
  // keeps edits; and a 立即更新 under way lands on a clean draft and takes effect directly, as with no edits. They go once the page change has really
  // happened (see afterEach below), and stay if it does not. Signing out drops nothing: once the session ends the next visit's read replaces the draft
  // anyway, and a failed sign-out keeps the edits. Only with 现在应用 still running do they go at once, since its re-read would keep them
  // 退出登录：等会话真的结束了再丢（见下面的 watch），退出没成功时修改还在
  // Signing out: the edits go once the session has really ended (see the watch below), and stay if the sign-out fails
  if (agreed && purpose === 'signout') { if (applyBusy.value) discardOnLeave(); else signoutDrop = true }
  else if (agreed) agreedDrop = discardOnLeave
  return agreed
}
let signoutDrop = false
watch(() => session.authenticated.value, (now) => {
  if (now || !signoutDrop) return
  signoutDrop = false
  discardOnLeave()
})
// 同意离开时要丢掉的修改，等换页成了再丢 / Edits agreed to drop on leaving, dropped once the page change succeeds
let agreedDrop: (() => void) | null = null
const releaseGuard = registerLeaveGuard(askLeave, () => unsaved.value)
// 换页成了：丢掉同意丢掉的修改，拦截列表那几条说这份草稿的提示一起收起（afterEach 在页面卸下之前跑，在路上的下载落地时看到的已经是丢过的草稿）。
// 换页没成（取消、被顶掉、被拦下、页面文件加载失败）：什么都不丢，保存途中放行的记号也清掉，人还在这一页
// The page change succeeded: the edits agreed to drop go, and with them the blocklist toasts about this draft (afterEach runs before the page unmounts,
// so a download landing later sees the draft already dropped). It did not (cancelled, overtaken, blocked, its page file failed to load): nothing is
// dropped and the mark set by a leave let through during a save goes, the user still being on this page
const stopAfterEach = router.afterEach((_to, _from, failure) => {
  const drop = agreedDrop
  agreedDrop = null
  if (failure) { stayedDuringSave(); return }
  // 放弃的是用户自己的修改，不是立即更新：下好、还没存上的那份照样直接生效（updateCarry.ts） / What was dropped are the user's own edits, not 立即更新:
  // a download that landed and is not saved yet still takes effect (updateCarry.ts)
  if (drop) { refreshLanded(); drop(); dismissBlocklistToasts(); void carryUpdate() }
})
const stopOnError = router.onError(() => { agreedDrop = null; stayedDuringSave() })
// 提示条的按钮做事期间停用，焦点跟着掉到页面上：做完没人接住焦点时，回到这个按钮（还在的话），不在了就落在提示条上
// The notice's button is disabled while it works and focus falls to the page: when nothing caught it afterwards, it returns to the button if still there, else to the notice
// 人按了提示条的按钮、它还在做：按住（后台每 5 秒那次核对不算，按钮不跟着它一灰一灰） / The notice's button was pressed and its work
// runs: held meanwhile (the background check every 5 seconds does not count, so the button does not flicker with it)
// 记的是按下的那一条（按钮和那一句）：提示条换成别的一条以后，新的按钮不接着按住；确认框开着时也不按住，背后的按钮不跟着变灰
// What is kept is the notice pressed (its button and sentence): once the notice turns into another one, the new button is not held; nor
// is it held while a confirm is open, so the button behind does not grey out
const noticePressed = ref<string | null>(null)
const noticeKey = computed(() => (notice.value ? `${notice.value.action ?? ''}|${notice.value.text}` : ''))
async function runNotice(): Promise<void> {
  noticePressed.value = noticeKey.value
  try { await notice.value?.run?.() } finally { noticePressed.value = null }
  await nextTick()
  if (document.activeElement && document.activeElement !== document.body) return
  // 焦点挪过去时不滚动页面（锁着时按的，解开以后提示条回到页顶原位）；提示条没了就落在页头的状态上 / Moving the focus never scrolls the
  // page (pressed while locked, the notice is back in place at the top once unlocked); with the notice gone it lands on the header's state
  const box = document.querySelector<HTMLElement>('.cfg__notice')
  ;(box?.querySelector<HTMLElement>('.ui-notice__action:not(:disabled)') ?? box ?? document.querySelector<HTMLElement>('.cfg__facts, .cfg .ui-ph__lead'))?.focus({ preventScroll: true })
}
// 页面锁住那一刻：保存条收起，按下的按钮跟着没了，焦点交给提示条（锁着时它吸顶，滚到哪里都看得到，见 cfg__notice--stuck）
// The moment the page locks: the save bar folds away with the button just pressed, and the focus goes to the notice (stuck to the top
// while locked, so it shows wherever the page is scrolled, see cfg__notice--stuck)
// 锁住、解开、提示条变高变矮、断线横幅进出：内容区上面的高度变了，正看着的内容不跟着跳。变之前记下内容区在页面里的位置，之后 0.6 秒里它
// 每一帧一动，就把滚动补回同样的差；这段时间关掉浏览器自己的滚动锚定，两个引擎一个做法（WebKit 没有，Chromium 的在这里补不全）。在页顶时
// 不补 / Locking, unlocking, the notice growing or shrinking and the outage banner coming or going change the height above the content,
// and what is being looked at does not jump: the content area's place in the page is noted first, and for 0.6 s every frame it moves
// the scroll follows by the same amount, with the browser's own scroll anchoring off meanwhile so both engines behave alike (WebKit has
// none, and Chromium's does not cover this). Not at the top of the page
// 已经在补的时候又来一次（横幅先出来、紧接着锁住）：只往后延，不重记位置，不然头一次还没补的那一截就丢了 / Another change while one is
// being held (the banner first, the lock right after): the window is only extended, the place is not noted again, or the part not yet
// made up for would be lost
let holding: { content: HTMLElement; until: number } | null = null
let holdFrame = 0
function holdContent(): void {
  const content = document.querySelector<HTMLElement>('.cfg__panel, .cfg__json')
  if (!content) return
  if (holding?.content === content) { holding.until = performance.now() + 600; return }
  const hold = { content, until: performance.now() + 600 }
  holding = hold
  const place = () => content.getBoundingClientRect().top + window.scrollY
  let last = place()
  // 补完以后的滚动位置：浏览器自己挪过的（滚到底时页面变短被夹住）不再补一遍，人自己滚的照样算 / The scroll position after each
  // adjustment: what the browser already moved (clamped as the page shrinks at the bottom) is not made up for twice, and the user's own
  // scrolling still counts
  let lastY = window.scrollY
  const root = document.documentElement
  cancelAnimationFrame(holdFrame)
  root.style.overflowAnchor = 'none'
  const look = (): void => {
    const now = content.isConnected ? place() : last
    if (Math.abs(now - last) >= 0.5 && lastY > 0) window.scrollTo(0, lastY + now - last)
    last = now
    lastY = window.scrollY
    // 浮不浮起来也在这几帧里看：锁住那一刻就画对，不晚两帧 / Floating is checked in these frames too, so it is right the moment it locks
    lookFloating()
    if (content.isConnected && performance.now() < hold.until) { holdFrame = requestAnimationFrame(look); return }
    holding = null
    root.style.removeProperty('overflow-anchor')
  }
  holdFrame = requestAnimationFrame(look)
}
watch([pageLocked, lostWriteWhy, useConnection().down], holdContent, { flush: 'sync' })
onBeforeUnmount(() => { cancelAnimationFrame(holdFrame); holding = null; document.documentElement.style.removeProperty('overflow-anchor') })
// 吸顶的提示条真浮在内容上面时（到了吸顶的位置、不在原位）才画下沿，见 cfg__notice--floating；滚动时看一眼 / The stuck notice gets its lower
// edge only while it really floats (at its sticky place, not in place), see cfg__notice--floating; checked on scroll
const noticeEl = ref<HTMLElement | null>(null)
const noticeFloating = ref(false)
let floatFrame = 0
function lookFloating(): void {
  floatFrame = 0
  const box = noticeEl.value
  noticeFloating.value = Boolean(box && pageLocked.value && box.getBoundingClientRect().top <= parseFloat(getComputedStyle(box).top) + 0.5)
}
const onFloatScroll = (): void => { if (!floatFrame) floatFrame = requestAnimationFrame(lookFloating) }
// 进页面时也看：锁着时离开、还锁着时回来 / Also on entering the page: left while locked and back while still locked
watch(pageLocked, (locked) => {
  if (locked) { window.addEventListener('scroll', onFloatScroll, { passive: true }); window.addEventListener('resize', onFloatScroll); void nextTick(lookFloating) }
  else { window.removeEventListener('scroll', onFloatScroll); window.removeEventListener('resize', onFloatScroll); noticeFloating.value = false }
}, { immediate: true })
onBeforeUnmount(() => { window.removeEventListener('scroll', onFloatScroll); window.removeEventListener('resize', onFloatScroll); cancelAnimationFrame(floatFrame) })
watch(pageLocked, (locked) => {
  if (!locked) return
  void nextTick(() => {
    const box = document.querySelector<HTMLElement>('.cfg__notice')
    box?.focus({ preventScroll: true })
  })
})
onMounted(() => {
  ui.mode = 'form'
  // 刷新后编辑器不在了，地址里的 ?rule= 也去掉 / After a reload the editor is gone, so ?rule= leaves the address too
  if (route.query.rule) void router.replace({ query: { ...route.query, rule: undefined } })
  // 离开时还在保存：那次保存做完会自己重读，这里不读，免得把旧文件换进草稿；离开后没保存成功的草稿留着，保存条上失败的说法也留着
  // Still saving from before leaving: that save re-reads when done, so no read here (it would put the old file into the draft); a draft whose save failed
  // after leaving stays, and so does what the save bar said about the failure
  const keep = setViewing(true)
  // 留着的草稿撞上过「别处改过了」：只刷新运行状态，文件散列和对照的那份等「重新读取」再换（和在页面上撞上时一样），
  // 否则「放弃修改」会把别处的改动也算成自己的
  // A kept draft that met 别处改过了: refresh the runtime only and leave the file hash and baseline for 重新读取 (as when it happens on the page);
  // otherwise 放弃修改 would count the other writer's change as one's own
  // 离开以后说过「存不上」的立即更新：冲突还在，提示换成页上的说法 / A 立即更新 told 存不上 away: the conflict is still there, so the toast takes the on-page wording
  // 这次进来的那次读结束了（成功、失败都算）：红色提示交棒要等它，见下面 dismissRefused 那段 / This mount's read is over (landed or
  // failed): the red toast's hand-over waits for it, see dismissRefused below
  const readOver = () => { mountReadOver.value = true }
  // 回应丢了的那次写入还没核对：先核对，核对出存上了或核对不了，这次读交给它（见 checkFirst）；有没有冲突照核对以后的说
  // A lost write still unchecked: check it first, and when it was found landed or could not be checked, leave this read to it (see
  // checkFirst); whether there is a conflict is judged after the check
  const read = (): Promise<unknown> | undefined => {
    if (keep && conflict.value) { returnedToPage(); return refreshRuntime().catch(() => undefined) }
    return load(keep ? { quiet: true, keepDraft: true } : { returning: true })
  }
  if ((keep && conflict.value) || !busy.value) void checkFirst().then((checked) => (checked ? undefined : read())).then(readOver, readOver)
  window.addEventListener('beforeunload', beforeUnload)
})
const beforeUnload = (e: BeforeUnloadEvent) => { if (unsaved.value) { e.preventDefault(); e.returnValue = '' } }
// 带「撤销」的提示只对这一页的草稿有用：离开时一起收起（会话过期跳到登录页时也不会留着） / Undo toasts only make sense for this page's draft: they go when it unmounts (including a jump to the login page on session expiry)
onBeforeUnmount(() => { setViewing(false); window.removeEventListener('beforeunload', beforeUnload); releaseGuard(); stopAfterEach(); stopOnError(); dismissUndoable(); ui.mode = 'form'; jsonEdited.value = false })
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
// 放在 panelDown 声明之后：watch 立刻就跑，放在前面会在声明前读到它（回到配置页时整页空白）。
// 有待应用的版本、KixDNS 又在运行：面板后台每 5 秒会自己让它生效（或者发现它不行）。页面跟着每 5 秒看一眼运行状态，直到它不再是待应用的，
// 免得页头一直挂着过时的「待应用 · 现在应用」，失败了也藏在「待应用」后面
// Declared after panelDown: the watcher runs at once and would read it before its declaration (a blank page on return).
// A pending version with KixDNS running again: the panel's background pass puts it into effect (or finds it refused) every 5 seconds. The page looks at the
// runtime every 5 seconds too until it is no longer pending, so the header does not keep a stale 「待应用 · 现在应用」 and a failure does not hide behind 待应用
// KixDNS 连不上、又没停着时也这样看（systemd 下一次重试可能就起来了，页头、提示条不该一直说它起不来）；刚连上的那一次也接着看
// （起不来的循环里新进程会短暂应答，要连着两次读到才算回来）
// Also while KixDNS is unreachable and not stopped (the next systemd retry may bring it up, and the header and notice must not keep
// saying it cannot), and on past the first read that finds it (in a loop that never comes up a new process answers briefly, so
// back takes two reads in a row)
const watchingPending = computed(() => ready.value && ((hasPending.value && !deferSave.value) || runtimeUnavailable.value || backUnconfirmed.value) && !busy.value && !panelDown.value && !rereading.value && deleting.value === null && !bulkDeleting.value)
let pendingTimer: number | undefined
watch(watchingPending, (on) => {
  window.clearInterval(pendingTimer)
  // 没有修改就整份静默重读（别处换了文件也跟着换，不把新运行状态贴到旧文件上）；有修改只刷新运行状态，文件换了会马上进冲突
  // With no edits, a whole quiet re-read (a file changed elsewhere is followed, rather than pinning the new runtime onto the old file); with edits, only the
  // runtime, and a changed file enters the conflict state at once
  pendingTimer = on ? window.setInterval(() => { void checkPending().catch(() => undefined) }, 5000) : undefined
}, { immediate: true })
onBeforeUnmount(() => window.clearInterval(pendingTimer))
const { restart } = useServiceRestart()
// 重启、退回的按钮在保存还没做完时按不下：保存途中重启，KixDNS 会在确认新配置前断开，好好的版本被记成没有生效
// The restart and rollback buttons hold while a save is still finishing: a restart mid-save drops KixDNS before it confirms the new
// config, and a sound version would be recorded as not taken
const restarts = () => [restartForSettings, rollbackSettings, writePendingIn].includes(notice.value?.run as never)
// 响应式：提示条的按钮只在这一页发起的那次转圈，别处发起的重启只让它停用 / Reactive: the notice's button spins only for an action this
// page sent; a restart sent elsewhere only holds it
// 按计数：套着发起时，里面那次结束不提前清掉 / Counted: when nested, the inner one ending does not clear it early
const actingCount = ref(0)
const actingHere = computed(() => actingCount.value > 0)
const noticeRestarting = computed(() => restartingKixdns.value && actingHere.value && restarts())
const noticeHeld = computed(() => applyBusy.value || rereading.value || Boolean(notice.value?.held) || (noticePressed.value === noticeKey.value && !confirm.pending.value) || restartingKixdns.value || startingKixdns.value || (restarts() && (saveInFlight.value || busy.value)))
// 退回期间页面不能改：回来以后整份换上退回后的文件，途中改的会悄悄丢掉（和「重新读取」时一样）
// The page cannot be edited during a rollback: on return the rolled-back file replaces the page, and edits made meanwhile
// would be lost silently (as during 重新读取)
const rollingBack = rollingBackKixdns
// 提示条在说起不来：从别处带过来的「启动失败」提示收起，这一页等出来的也不另弹。同步记下：重启回来读完紧接着就要看它
// The notice says it does not come up: a 启动失败 toast brought from elsewhere is dismissed, and one this page waited out is not
// raised. Kept in sync: right after the read on return from a restart it is looked at
watch(() => ready.value && Boolean(notice.value?.down), (shown) => { downShownHere.value = shown }, { immediate: true, flush: 'sync' })
// 提示条在说某一版没有生效：别处带来的「…没有生效，到配置页看原因」提示交棒，收起 / The notice says a version did not take: the
// 「…没有生效，到配置页看原因」 toast brought from elsewhere hands over and goes
// 那一版已经不算失败（别处另存并应用了新的）也收起：这时配置页上没有失败可看 / Also once that version no longer counts as failed
// (another writer stored and applied a new one): the config page then has no failure to show
// 交棒要等这次进来的那次读结束：进页那一刻 ready 还是上次留下的，紧接着那次读又把提示条藏起来，按那一刻判断就会先收起、提示条过一会儿
// 才出来。读结束以后，提示条在说没有生效就交棒（读不到时它说的是上次读到的，照样算）；「已经没有失败」只按这次读到的说，读失败时不因此收
// The hand-over waits for this mount's read to end: at mount ready is still the last visit's, and the read right after hides the
// notice, so judging then would dismiss first and show the notice later. Once the read is over, the toast hands over if the
// notice says it did not take (when the read failed it says what was read last time, which still counts); 「no failure any more」
// is judged only on what this read brought, so a failed read does not dismiss on that ground
const mountReadOver = ref(false)
const readSinceMount = ref(false)
watch(doc, () => { readSinceMount.value = true; mountReadOver.value = true }, { flush: 'sync' })
watch(() => mountReadOver.value && ready.value && (Boolean(notice.value?.failure) || (readSinceMount.value && !hasApplyFailure.value)), (stale) => { if (stale) dismissRefused() }, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { downShownHere.value = false })
// 函数声明：提示条在声明之前就可能读到它（回到配置页时已经读好） / A declaration: the notice may read it before this line (on return,
// with the page already read)
function openLogs(): void { void router.push('/logs?view=runtime') }
// 照系统页的「重启」先确认再重启，确认框写全要重启的设置（提示条只写前三项），待应用版本那句也照系统页说；等 KixDNS 回来、整份读完
// 才说已重启，提示条随之消失
// Confirmed first as on the system page, with every setting waiting for the restart in the dialog (the notice names only three) and the
// system page's words for a pending version; 已重启 is said once KixDNS is back and the page is read again, and the notice goes with it
// 别的页发起的启动、重启、退回结束时，这一页也先安静地重读再说结果（有修改时只刷新运行状态）；这一页自己发起的由它的 afterBack
// 读，不读两遍 / When a start, restart or rollback sent from another page ends, this page also reads again quietly before the
// outcome is said (only the runtime with edits); one this page sent is read by its own afterBack, not twice
async function ownAction<T>(work: () => Promise<T>): Promise<T> {
  actingCount.value += 1
  try { return await work() } finally { actingCount.value -= 1 }
}
const stopReading = readBeforeTelling(async () => { if (!actingHere.value) await readFresh().catch(() => undefined) })
onBeforeUnmount(stopReading)
// 确认框开着时草稿又有了修改：不发，照实说一句，提示条已经换回「先保存或放弃」 / The draft gained edits while the confirm was
// open: nothing is sent, and a line says so; the notice is back to 「先保存或放弃」
function draftChangedMeanwhile(what: string): void {
  toast.info(`没有${what}：草稿里还有修改没保存`)
}
async function restartForSettings(): Promise<void> {
  // KixDNS 还在：服务端重启前先应用待应用的版本，一次重启就全用上 / KixDNS is still there: the server applies the pending version
  // before the restart, so one restart brings it all in
  const origin = doc.value?.pending?.from_rollback
  // 这个确认框只在 KixDNS 在时出现：退回的设置已经在用，先应用的只有带上的修改 / This confirm shows only while KixDNS runs: the
  // settings put back are in use, so only the carried edits are applied first
  const waiting = hasPending.value && pendingVersionId.value ? `重启前先应用${origin ? versionName(pendingVersionId.value, origin, true) : `待应用的版本\u00a0#${pendingVersionId.value}`}。` : ''
  // 草稿里没保存的修改不在这次重启里 / Unsaved edits in the draft are not part of this restart
  const draft = unsaved.value ? '草稿里没保存的修改不算在内。' : ''
  if (!await confirm.ask({
    title: '重启 KixDNS 服务',
    body: `服务会短暂中断，缓存会清空。${waiting}重启后生效的设置：${settingNames(restartPending.value, { all: true })}。${draft}`,
    confirmLabel: '重启服务',
  })) return
  // 确认框开着时开始的保存（立即更新的补存）先做完：保存途中重启，KixDNS 会在确认新配置前断开。页面锁住了（那次写入的回应丢了）就不发，
  // 说一句；退回、写进文件也一样 / A save begun while the confirm was open (立即更新's make-up save) finishes first: restarting mid-save
  // would lose KixDNS before it confirms the config. Once the page has locked (that write lost its answer) nothing is sent and a line says
  // why; rolling back and writing the file alike
  await whenSettledOrLocked()
  if (refuseWhileLocked('重启')) return
  await ownAction(() => restart({ afterBack: readQuietly, wasAlive: true }))
}
// 退回：只把那几项改回 KixDNS 上次正常启动时的值，写进文件再重启；文件是这一页改的，读回来不说「别处改过了」
// Rolling back: only those settings go back to the values KixDNS last started with, written to the file before a restart; this page
// changed the file, so the read-back does not say 别处改过了
async function rollbackSettings(): Promise<void> {
  const values = restartRollback.value
  if (!values) return
  // 待应用的版本里这几项也一起改回（服务端改好再另存）；没有生效的版本不跟着写回（它被内核拒过）：都说一句
  // The pending version gets the same settings put back (the server changes and stores it again); a version that was refused is
  // not written back with it: both are said
  const one = new Set(Object.keys(values).map((key) => (key.startsWith('flow_control_') ? 'flow_control' : key))).size === 1
  const rest = hasPending.value && pendingVersionId.value ? `待应用的版本\u00a0#${pendingVersionId.value}\u00a0里${one ? '这一项' : '这几项'}也改回，其他修改都保留。`
    : hasApplyFailure.value && pendingVersionId.value ? (doc.value?.pending?.from_rollback ? '其他修改都保留；没有生效的那笔修改不算在内。' : `其他修改都保留；${nameWith(versionName(pendingVersionId.value, null, true), '没有生效')}，里面的修改不算在内。`)
    : '其他修改都保留。'
  if (!await confirm.ask({
    title: '退回原来的设置',
    body: `改回 KixDNS 上次正常启动时的值：${settingValues(values)}。${rest}`,
    confirmLabel: '退回并重启',
  })) return
  // 确认框开着时草稿又有了修改（点了提示里的「撤销」）：不发，提示条换回「先保存或放弃」，不悄悄冲掉那笔修改
  // The draft gained edits while the confirm was open (an 撤销 in a toast): nothing is sent and the notice turns back to
  // 「先保存或放弃」, rather than the edits being silently wiped
  await whenSettledOrLocked()
  if (refuseWhileLocked('退回')) return
  if (unsaved.value) { draftChangedMeanwhile('退回'); return }
  await ownAction(() => restart({ rollback: { hadPending: hasPending.value }, beforeSend: beginOwnWrite, afterBack: readAfterOwnWrite }))
}
// 把待应用的版本写进配置文件再重启：KixDNS 不在，没法先校验，确认框照实说；文件是这一页改的，读回来不说「别处改过了」
// Write the pending version into the config file and restart: KixDNS is not there to check it first, and the confirm says so; this
// page changed the file, so the read-back does not say 别处改过了
async function writePendingIn(): Promise<void> {
  const id = pendingVersionId.value
  if (!id) return
  if (!await confirm.ask({
    title: `把版本\u00a0#${id}\u00a0写进配置文件`,
    body: 'KixDNS 不在，没法先校验这份配置：直接写进配置文件，再重启。还是起不来的话，改好再写一次。',
    confirmLabel: '写进并重启',
  })) return
  await whenSettledOrLocked()
  if (refuseWhileLocked('写进配置文件')) return
  if (unsaved.value) { draftChangedMeanwhile('写进配置文件'); return }
  await ownAction(() => restart({ writePending: id, beforeSend: beginOwnWrite, afterBack: readAfterOwnWrite }))
}
async function startKixdns(): Promise<void> {
  // 按下以后页头换成转圈的「正在启动」，按钮收起：焦点移到状态那一格，不掉到页面上 / Once pressed the header turns to a spinning
  // 正在启动 and the button goes: focus moves to the status cell instead of falling to the page
  void nextTick(() => document.querySelector<HTMLElement>('.cfg__facts, .cfg .ui-ph__lead')?.focus({ preventScroll: true }))
  // 草稿有修改时只刷新运行状态，不重读文件，免得把草稿换掉；启动时应用了的待应用版本由启动那条提示说，这里不再说。读在说结果之前：
  // 起不来时提示条先说 / With edits in the draft only the runtime state is refreshed, so the draft is not replaced; a pending version
  // applied on start is told by the start's toast, so nothing more is said here. The read comes before the outcome is said: not
  // coming up, the notice says it first
  await ownAction(() => start({ afterBack: readQuietly }))
}
const versionLabel = computed(() => { const id = pendingVersionId.value ?? currentVersionId.value ?? doc.value?.version_id; return id === null || id === undefined ? '—' : `#${id}` })
</script>

<template>
  <RuleEditor v-if="editor && !inspector" ref="editorRef" :key="`${editor.ruleId}-${editor.groupId}-${editor.nonce ?? 0}`" :rule-id="editor.ruleId" :group-id="editor.groupId" :template="editor.template" :resume="editor.resume" @close="closeRule" @reopen="reopenRule" @saved="ruleSaved" @deleted="ruleDeleted" @edit-group="openGroup($event)" />
  <div v-else class="page cfg">
    <UiPageHeader :title="pageTitle">
      <template #meta>
        <span v-if="!ready && !loadError" class="sk ui-ph__sk cfg__status-sk"></span>
        <!-- 宽屏：标题下一排事实（状态、配置版本、规则数、上游组数）；手机：一行状态 / Wide: a facts row under the title (state, config version, rule count, upstream groups); phones: one status line -->
        <!-- 没读到配置时宽屏也是这一排，只写状态；版本、规则数、上游组数等读到再写 / Without a config read the wide header keeps this row with the state only; version, rule and group counts wait for the read -->
        <span v-else-if="!phone && !firstRun" class="ui-facts cfg__facts" :class="{ 'cfg__facts--long': (headerLine.wide?.length ?? 0) > 1, 'cfg__facts--fail': hasApplyFailure && !lostWrite }" tabindex="-1" :role="applyBusy || restartingKixdns || startingKixdns ? 'status' : undefined">
          <span><span class="ui-lbl">状态</span><b><span v-if="applyBusy || ((restartingKixdns || startingKixdns) && !panelDown)" class="ui-spin cfg__spin" aria-hidden="true"></span><span v-else class="ui-dot" :class="headerLine.tone === 'ok' ? '' : `ui-dot--${headerLine.tone}`" aria-hidden="true"></span><UiDotText :parts="headerLine.wide ?? [headerLine.lead ?? `${headerLine.before}${headerLine.version ?? ''}${headerLine.after ?? ''}`]" /><button v-if="headerAction && ready && !applyBusy" class="cfg__head-action" type="button" @click="applyNow">{{ headerAction }}</button><span v-else-if="applyBusy && ready" class="cfg__head-action is-held" aria-hidden="true">现在应用</span><button v-else-if="runtimeStopped && ready && !panelDown && !lostWrite && !restartRollback && !startingKixdns" class="ui-btn ui-btn--secondary ui-btn--sm ui-btn--inline cfg__head-start" type="button" :disabled="starting" @click="startKixdns">启动</button></b></span>
          <template v-if="doc">
          <span><span class="ui-lbl">配置版本</span><b>{{ versionLabel }}</b></span>
          <span class="cfg__fact-rules"><span class="ui-lbl">规则</span><b>{{ ruleCount }} 条</b></span>
          <span class="cfg__fact-groups"><span class="ui-lbl">上游组</span><b>{{ model.groups.length }} 个</b></span>
          </template>
        </span>
        <span v-else class="ui-ph__lead" tabindex="-1" :role="applyBusy || restartingKixdns || startingKixdns ? 'status' : undefined">
          <span v-if="applyBusy || ((restartingKixdns || startingKixdns) && !panelDown)" class="ui-spin cfg__spin" aria-hidden="true"></span>
          <span v-else class="ui-dot" :class="headerLine.tone === 'ok' ? '' : `ui-dot--${headerLine.tone}`" aria-hidden="true"></span>
          <UiDotText :parts="[headerLine.lead ?? '', `${headerLine.before}${headerLine.version ?? ''}${headerLine.after ?? ''}`].filter(Boolean)" />
          <button v-if="headerAction && ready && !applyBusy" class="cfg__head-action" type="button" @click="applyNow">{{ headerAction }}</button><span v-else-if="applyBusy && ready" class="cfg__head-action is-held" aria-hidden="true">现在应用</span>
          <button v-else-if="runtimeStopped && ready && !panelDown && !lostWrite && !restartRollback && !startingKixdns" class="ui-btn ui-btn--secondary ui-btn--sm ui-btn--inline cfg__head-start" type="button" :disabled="starting" @click="startKixdns">启动</button>
        </span>
      </template>
      <template v-if="!firstRun" #actions>
        <!-- 当前页签自己的操作（规则页的「新建规则」）从页签组件传送到这里 / The current tab's own actions (the rules tab's 新建规则) teleport here from the tab component -->
        <span id="cfg-actions" class="cfg__page-acts" :inert="rereading || rollingBack || pageLocked || undefined"></span>
        <UiTabs v-if="ui.mode === 'json'" class="cfg__mode" :model-value="ui.mode" :items="modes" label="配置视图" variant="segment" @update:model-value="setMode" />
        <UiMenu class="cfg__more" :items="moreItems" label="更多配置操作" title="配置" @select="pickMore" />
      </template>
    </UiPageHeader>

    <div v-if="notice && ready" ref="noticeEl" class="ui-notice cfg__notice" tabindex="-1" :class="[notice.tone === 'err' ? 'ui-notice--err' : notice.tone === 'off' ? 'ui-notice--off' : '', { 'cfg__notice--stuck': pageLocked, 'cfg__notice--floating': noticeFloating }]" :role="notice.tone === 'err' ? 'alert' : 'status'">
      <!-- 红色的用带叉的圆圈，和概览、诊断页一样 / The red one takes the crossed circle, as on the overview and diagnostics -->
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path v-if="notice.tone === 'err'" d="m15 9-6 6M9 9l6 6" /><path v-else d="M12 8v4M12 16h.01" /></svg>
      <span><template v-for="(run, k) in noticeRuns(notice.text)" :key="k"><span v-if="run.glue" class="nowrap">{{ run.text }}</span><template v-else>{{ run.text }}<span v-if="run.breakAfter" class="brk" aria-hidden="true"></span></template></template></span>
      <small v-if="notice.detail"><RuleText :text="notice.detail" :links="notice.links" breaks @rule="openRule($event, null)" @group="openGroup($event)" /></small>
      <button v-if="notice.action" class="ui-btn ui-btn--secondary ui-btn--sm ui-notice__action" type="button" :disabled="noticeHeld" :aria-busy="noticeRestarting || undefined" @click="runNotice"><span v-if="noticeRestarting" class="ui-spin" aria-hidden="true"></span>{{ notice.action }}</button>
    </div>

    <!-- 只由菜单里的「导入 JSON」打开：不进 Tab 顺序，读屏也不念一个没名字的「选择文件」 / Opened only by 导入 JSON in the menu: out of the Tab order, and screen readers do not announce a nameless "choose file" -->
    <input ref="fileInput" class="visually-hidden" type="file" accept=".json,application/json" tabindex="-1" aria-hidden="true" @change="importFile">
    <!-- 侧栏收起时（≤860）分区页签在这一行；宽屏上分区在侧栏里，这一行只在 JSON 视图时出现（≥861 由 CSS 藏起页签）
         With the sidebar folded (≤860) the section tabs sit on this row; on wide screens sections live in the sidebar and the row shows only in the JSON view (CSS hides the tabs at ≥861) -->
    <div v-if="!firstRun && (compact || ui.mode === 'json')" class="cfg__nav" :class="{ 'cfg__nav--json': ui.mode === 'json' }">
      <div v-if="ui.mode === 'json'" class="cfg__whole"><h2>完整配置</h2><button class="ui-btn ui-btn--text ui-btn--sm ui-btn--inline cfg__to-form" type="button" :disabled="jsonExitBlocked" @click="setMode('form')">回到表单</button></div>
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
    <div v-else-if="ui.mode === 'json'" class="cfg__json ui-fade" :inert="rereading || rollingBack || pageLocked || undefined" :aria-busy="rereading || rollingBack || pageLocked || undefined">
      <p class="cfg__json-note">这里是 KixDNS 读的配置，可以直接改。切回表单时会重新读一遍；规则名、备注、停用的规则这些面板自己的信息另外保存，不在这里。</p>
      <JsonEditor ref="jsonEditor" v-model="jsonText" class="cfg__json-editor" :error-line="jsonError?.line" />
    </div>
    <!-- 重新读取、恢复版本读回来之前不让改：读回来的会整份换掉草稿；回应丢了的写入还没核对时也不让改（页面锁着） / No edits until a re-read or restore comes
         back: what comes back replaces the draft; nor while a lost write is unchecked (the page is locked) -->
    <div v-else :id="`cfg-panel-${section}`" class="cfg__panel" role="tabpanel" :aria-labelledby="`cfg-tab-${section}`" :inert="rereading || rollingBack || pageLocked || undefined" :aria-busy="rereading || rollingBack || pageLocked || undefined">
      <div v-if="section === 'rules'" class="rules-split" :class="{ 'is-open': inspector }">
        <RulesTab :selected="editor?.ruleId ?? null" @open="openRule" @tab="setTab" @edit-group="openGroup($event)" @import="!saveInFlight && fileInput?.click()" />
        <RuleEditor v-if="inspector && editor" ref="editorRef" :key="`${editor.ruleId}-${editor.groupId}-${editor.nonce ?? 0}`" inspector :rule-id="editor.ruleId" :group-id="editor.groupId" :template="editor.template" :resume="editor.resume" @close="closeRule" @reopen="reopenRule" @saved="ruleSaved" @deleted="ruleDeleted" @edit-group="openGroup($event)" />
      </div>
      <UpstreamsTab v-else-if="section === 'upstreams'" @edit="openGroup($event)" @rules="showGroupRules" />
      <MappingTab v-else-if="section === 'mapping'" />
      <BlocklistTab v-else-if="section === 'blocklists'" />
      <SettingsTab v-else />
    </div>
    <SaveBar v-if="ready" :json-error="jsonError" :json-dirty="jsonDirty" :flush="flush" @rule="openRule($event, null)" @group="openGroup($event)" @reveal="(l: number, c: number) => jsonEditor?.reveal(l, c)" @reload="reload()" @download="downloadJson" @discarded="afterDiscard" />
  </div>
  <GroupEditor v-if="groupEditor" :key="groupEditor.id ?? 'new'" :group-id="groupEditor.id" @close="groupEditor = null" @saved="groupSaved" @deleted="groupDeleted" />
  <HistoryDrawer v-if="historyOpen" :compare-with="historyOpen.compare" @close="historyOpen = null" @rule="historyOpen = null; openRule($event, null)" />
  <ImportReportDialog v-if="reportOpen && importReport" :undo="Boolean(undoImport)" @close="reportOpen = false; undoImport = null" @undo="undoImportNow" />
</template>
