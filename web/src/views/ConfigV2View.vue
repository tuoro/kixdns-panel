<script setup lang="ts">
import { Braces, Download, FileUp, History, RefreshCw, Settings2 } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import JsonEditor from '../components/JsonEditor.vue'
import UiDotText from '../components/ui/UiDotText.vue'
import UiMenu from '../components/ui/UiMenu.vue'
import UiPageHeader from '../components/ui/UiPageHeader.vue'
import UiTabs from '../components/ui/UiTabs.vue'
import { useConfirm } from '../composables/useConfirm'
import { useToast } from '../composables/useToast'
import { exportConfig, readConfig } from '../config-model/document'
import { compile, ruleTitle, type Model, type Rule, type UpstreamGroup } from '../config-model/model'
import GroupEditor from '../config-v2/GroupEditor.vue'
import HistoryDrawer from '../config-v2/HistoryDrawer.vue'
import ImportReportDialog from '../config-v2/ImportReportDialog.vue'
import MappingTab from '../config-v2/MappingTab.vue'
import RuleEditor from '../config-v2/RuleEditor.vue'
import RulesTab from '../config-v2/RulesTab.vue'
import RuleText from '../config-v2/RuleText.vue'
import SaveBar from '../config-v2/SaveBar.vue'
import SettingsTab from '../config-v2/SettingsTab.vue'
import UpstreamsTab from '../config-v2/UpstreamsTab.vue'
import { usePhone, useWide } from '../config-v2/phone'
import { dirty, importReport, importSource, model, replaceModel, reportOpen, ui } from '../config-v2/store'
import {
  applyBusy, applyError, applyNow, canApplyNow, canCname, capabilityError, currentVersionId, doc, friendlyRuntimeMessage, hasApplyFailure, headerAction, headerLine,
  load, loadError, loading, pendingVersionId, runtimeStopped, runtimeUnavailable, unsupportedFields,
} from '../config-v2/useConfigDocument'
import '../styles/config-v2.css'

// 新配置页（③）：侧栏里的「规则 · 上游组 · 域名映射 · 基础设置」各是一页，这个文件是它们共用的外壳——页头的事实行、通知条、
// JSON 视图、导入导出、历史版本、保存条。草稿在 config-v2/store.ts，文件和运行状态在 config-v2/useConfigDocument.ts。
// The new config page (③): the sidebar's 规则 · 上游组 · 域名映射 · 基础设置 are each a page, and this file is their shared shell — the
// header's facts row, the notice strip, the JSON view, import/export, the save bar. The draft lives in config-v2/store.ts, the file and
// runtime in config-v2/useConfigDocument.ts.
const route = useRoute()
const router = useRouter()
const toast = useToast()
const confirm = useConfirm()
const phone = usePhone()
const wide = useWide()
const tabs = [{ value: 'rules', label: '规则' }, { value: 'upstreams', label: '上游组' }, { value: 'mapping', label: '域名映射' }, { value: 'settings', label: '基础设置' }]
const section = computed(() => (tabs.some((t) => t.value === route.query.section) ? String(route.query.section) : 'rules'))
watch(section, (s) => { ui.tab = s }, { immediate: true })
const pageTitle = computed(() => (phone.value || ui.mode === 'json' ? '配置' : tabs.find((t) => t.value === section.value)?.label ?? '配置'))
function setTab(t: string): void {
  if (ui.mode === 'json' && !leaveJson()) return
  void router.replace({ query: { ...route.query, section: t === 'rules' ? undefined : t } })
}
const ready = computed(() => !loading.value && Boolean(doc.value))
const firstRun = computed(() => ready.value && ui.mode === 'form' && !model.groups.length && !model.rules.length)
// 宽屏上规则在右侧面板里编辑，列表留在左边；窄屏和手机仍是整页编辑 / On wide screens a rule is edited in the right-hand inspector with the list on the left; narrow screens and phones keep the full-page editor
const editor = ref<{ ruleId: number | null; groupId: string | null; template?: Partial<Rule> } | null>(null)
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
function openRule(ruleId: number | null, groupId: string | null, template?: Partial<Rule>): void {
  if (ui.mode === 'json' && !leaveJson()) return
  editor.value = { ruleId, groupId, template }
  window.scrollTo({ top: 0 })
}
function closeRule(): void {
  const id = editor.value?.ruleId
  editor.value = null
  if (id !== null && id !== undefined) requestAnimationFrame(() => { const row = document.querySelector<HTMLElement>(`[data-rule="${id}"]`); row?.scrollIntoView({ block: 'center' }); row?.querySelector<HTMLElement>('.rrow__main')?.focus() })
}
function ruleSaved(rule: Rule, isNew: boolean): void {
  editor.value = null
  // 手机上编辑器占整页，完成时保存条还看不见：提示里说一句还要保存；桌面上保存条就在旁边，不重复
  // On a phone the editor fills the page and the save bar is not in view at 完成, so the toast says a save is still due; on desktop the bar sits right there
  toast.success(`${isNew ? '已添加' : '已更新'}「${ruleTitle(rule)}」${phone.value ? '，保存后生效' : ''}`)
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(`[data-rule="${rule.id}"]`)
    row?.scrollIntoView({ block: 'center' })
    row?.classList.add('is-fresh')
    setTimeout(() => row?.classList.remove('is-fresh'), 1600)
  })
}
function ruleDeleted(rule: Rule, index: number, list: Rule[]): void {
  editor.value = null
  toast.undoable(`已删除「${ruleTitle(rule)}」`, () => list.splice(Math.min(index, list.length), 0, rule))
}
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
const cnameInUse = computed(() => model.mappings.some((m) => m.enabled && !/^[\d.:a-f, ]+$/i.test(m.target)) || model.rules.some((r) => r.outcome.type === 'answer' && r.outcome.kind === 'cname'))
interface Notice { tone: 'err' | 'warn' | 'off'; text: string; detail?: string; action?: string; run?: () => void }
const notice = computed<Notice | null>(() => {
  if (loadError.value && doc.value) return { tone: 'err', text: '读取配置失败，下面是上一次读到的内容。', detail: loadError.value, action: '重试', run: () => void reload(false) }
  if (hasApplyFailure.value) {
    const reason = doc.value?.runtime.pending_error || doc.value?.pending?.error || 'KixDNS 没有给出原因。'
    // 草稿有修改时不给「重试应用」：那时保存的是草稿，重试会把草稿当成失败的那个版本发出去 / No retry while the draft has changes: saving then sends the draft, not the version that failed
    return { tone: 'err', text: pendingVersionId.value ? `KixDNS 没有接受版本 #${pendingVersionId.value}，仍在用之前那份配置。` : 'KixDNS 没有接受上次保存的版本，仍在用之前那份配置。', detail: friendlyRuntimeMessage(reason), action: canApplyNow.value && !dirty.value ? '重试应用' : undefined, run: applyNow }
  }
  if (applyError.value) { const [text, ...detail] = applyError.value.split('\n'); return { tone: 'err', text: `${text}。`, detail: detail.join('\n') } }
  if (importReport.value && !reportOpen.value && importReport.value.stats.raw) return { tone: 'off', text: `这份配置是按内核格式读进来的，${importReport.value.stats.raw} 条规则原样保留为高级规则。`, action: '查看导入说明', run: () => { reportOpen.value = true } }
  if (geoPrefixed.value) return { tone: 'warn', text: `${geoPrefixed.value} 个 GeoSite 条件写成了「geosite:分类」，内核照原样查，这几条永远匹配不上。`, action: '去掉前缀', run: stripPrefix }
  // 没运行、连不上时页头已经说了，功能列表拿不到是它的结果，不另起一条 / When stopped or unreachable the header says so; the missing feature list follows from it
  if (capabilityError.value && !runtimeStopped.value && !runtimeUnavailable.value) return { tone: 'off', text: 'KixDNS 没有报告它支持哪些功能，新功能先按不支持处理。' }
  if (!canCname.value && cnameInUse.value && !capabilityError.value) return { tone: 'warn', text: '当前 KixDNS 不支持固定 CNAME：已有的域名映射和规则会保留，先更新或切换内核再应用。' }
  if (unsupportedFields.value.length) return { tone: 'off', text: `当前内核不支持：${unsupportedFields.value.join('、')}，这几项保留原样。` }
  return null
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
const jsonEditor = ref<InstanceType<typeof JsonEditor> | null>(null)
const jsonError = computed(() => (ui.mode === 'json' ? parseProblem(jsonText.value) : null))
function parseProblem(text: string): { line: number; column: number; reason: string } | null {
  try {
    const v = JSON.parse(text) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { line: 1, column: 1, reason: '配置根节点必须是 JSON 对象' }
    return null
  } catch (e) {
    const msg = String((e as Error).message)
    const pos = Number(/position (\d+)/.exec(msg)?.[1] ?? NaN)
    const lc = /line (\d+) column (\d+)/.exec(msg)
    const at = Number.isNaN(pos) ? null : pos
    const before = at === null ? text : text.slice(0, at)
    const line = lc ? Number(lc[1]) : before.split('\n').length
    const column = lc ? Number(lc[2]) : before.length - before.lastIndexOf('\n')
    const rest = at === null ? '' : text.slice(at)
    const reason = /^\s*[}\]]/.test(rest) && /,\s*$/.test(before) ? '多余的逗号' : /^\s*[A-Za-z_]/.test(rest) && /[{,]\s*$/.test(before) ? '属性名要用双引号' : /end of JSON|Unexpected end/i.test(msg) ? 'JSON 不完整' : /Expected ',' or/i.test(msg) ? '少了逗号或右括号' : '这里多了一个字符'
    return { line, column, reason }
  }
}
function enterJson(): void {
  jsonText.value = JSON.stringify(compile(model), null, 2)
  jsonBase.value = jsonText.value
  ui.mode = 'json'
}
function leaveJson(): boolean {
  if (jsonError.value) { toast.info('JSON 写错了，改好才能切换'); return false }
  if (jsonText.value !== jsonBase.value) {
    const { model: next, report } = readConfig(JSON.parse(jsonText.value) as Record<string, unknown>, model)
    replaceModel(next)
    if (report && (report.stats.raw || report.notes.some((n) => n.level === 'warn'))) { importReport.value = report; importSource.value = 'JSON 视图里的修改'; reportOpen.value = true }
  }
  ui.mode = 'form'
  return true
}
function setMode(m: string): void { if (m === 'json') enterJson(); else leaveJson() }
const modes = [{ value: 'form', label: '表单', icon: Settings2 }, { value: 'json', label: 'JSON', icon: Braces }]
const moreItems = computed(() => [
  { value: 'history', label: '历史版本', icon: History, disabled: !ready.value },
  { value: 'mode', label: ui.mode === 'json' ? '回到表单' : '查看 JSON', icon: ui.mode === 'json' ? Settings2 : Braces, disabled: !ready.value },
  { value: 'import', label: '导入 JSON', icon: FileUp, disabled: !ready.value },
  { value: 'download', label: '下载 JSON', icon: Download, disabled: !ready.value },
  { value: 'reload', label: '重新读取配置', icon: RefreshCw, disabled: loading.value },
])
function pickMore(value: string): void {
  if (value === 'history') historyOpen.value = { compare: null }
  else if (value === 'mode') setMode(ui.mode === 'json' ? 'form' : 'json')
  else if (value === 'import') fileInput.value?.click()
  else if (value === 'download') downloadJson()
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
  try { parsed = JSON.parse(await file.text()) as Record<string, unknown> } catch (e) { toast.error(`${file.name} 不是合法的 JSON：${(e as Error).message}`); return }
  if (dirty.value && !(await confirm.ask({ title: '放弃未保存的修改', body: '导入的文件会替换编辑器里的草稿，没保存的修改会丢失。', confirmLabel: '放弃修改并导入' }))) return
  const before = JSON.parse(JSON.stringify(model)) as Model
  const { model: next, report } = readConfig(parsed, model)
  replaceModel(next)
  ui.mode = 'form'
  toast.undoable(`已导入 ${file.name}`, () => replaceModel(before))
  if (report) { importReport.value = report; importSource.value = file.name; reportOpen.value = report.notes.length > 0 }
}
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
  if (ask && dirty.value && !(await confirm.ask({ title: '放弃未保存的修改', body: '重新读取会丢掉编辑器里没保存的修改。', confirmLabel: '放弃修改并重新读取' }))) return
  editor.value = null
  ui.mode = 'form'
  await load()
}

// ---------- 进出页面 / entering and leaving ----------
onMounted(() => { void load(); window.addEventListener('beforeunload', beforeUnload) })
const beforeUnload = (e: BeforeUnloadEvent) => { if (dirty.value) { e.preventDefault(); e.returnValue = '' } }
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
onBeforeRouteLeave(async () => {
  if (!dirty.value) return true
  return confirm.ask({ title: '放弃未保存的修改', body: '当前的配置草稿会被丢弃，已经生效的配置不受影响。', confirmLabel: '放弃修改', cancelLabel: '继续编辑', destructive: true })
})
watch(section, () => { editor.value = null; void nextTick(() => window.scrollTo({ top: 0 })) })
const versionLabel = computed(() => { const id = pendingVersionId.value ?? currentVersionId.value ?? doc.value?.version_id; return id === null || id === undefined ? '—' : `#${id}` })
</script>

<template>
  <RuleEditor v-if="editor && !inspector" :key="`${editor.ruleId}-${editor.groupId}`" :rule-id="editor.ruleId" :group-id="editor.groupId" :template="editor.template" @close="closeRule" @saved="ruleSaved" @deleted="ruleDeleted" @edit-group="groupEditor = { id: $event }" />
  <div v-else class="page cfg">
    <UiPageHeader :title="pageTitle">
      <template #meta>
        <span v-if="!ready && !loadError" class="cfg__status-sk"><i class="sk"></i></span>
        <!-- 宽屏：标题下一排事实（状态、配置版本、规则数、上游组数）；手机：一行状态 / Wide: a facts row under the title (state, config version, rule count, upstream groups); phones: one status line -->
        <span v-else-if="!phone && !firstRun" class="ui-facts cfg__facts" :role="applyBusy ? 'status' : undefined">
          <span><span class="ui-lbl">状态</span><b><span v-if="applyBusy" class="ui-spin cfg__spin" aria-hidden="true"></span><span v-else class="ui-dot" :class="headerLine.tone === 'ok' ? '' : `ui-dot--${headerLine.tone}`" aria-hidden="true"></span>{{ headerLine.lead ?? `${headerLine.before}${headerLine.version ?? ''}${headerLine.after ?? ''}` }}<button v-if="headerAction && ready" class="cfg__head-action" type="button" @click="applyNow">{{ headerAction }}</button></b></span>
          <span><span class="ui-lbl">配置版本</span><b>{{ versionLabel }}</b></span>
          <span><span class="ui-lbl">规则</span><b>{{ model.rules.length }} 条</b></span>
          <span><span class="ui-lbl">上游组</span><b>{{ model.groups.length }} 个</b></span>
        </span>
        <span v-else class="ui-ph__lead" :role="applyBusy ? 'status' : undefined">
          <span v-if="applyBusy" class="ui-spin cfg__spin" aria-hidden="true"></span>
          <span v-else class="ui-dot" :class="headerLine.tone === 'ok' ? '' : `ui-dot--${headerLine.tone}`" aria-hidden="true"></span>
          <UiDotText :parts="[headerLine.lead ?? '', `${headerLine.before}${headerLine.version ?? ''}${headerLine.after ?? ''}`].filter(Boolean)" />
          <button v-if="headerAction && ready" class="cfg__head-action" type="button" @click="applyNow">{{ headerAction }}</button>
        </span>
      </template>
      <template v-if="!firstRun" #actions>
        <!-- 当前页签自己的操作（规则页的「新建规则」）从页签组件传送到这里 / The current tab's own actions (the rules tab's 新建规则) teleport here from the tab component -->
        <span id="cfg-actions" class="cfg__page-acts"></span>
        <UiTabs v-if="ui.mode === 'json'" class="cfg__mode" :model-value="ui.mode" :items="modes" label="配置视图" variant="segment" @update:model-value="setMode" />
        <UiMenu class="cfg__more" :items="moreItems" label="更多配置操作" title="配置" @select="pickMore" />
      </template>
    </UiPageHeader>

    <div v-if="notice && ready" class="ui-notice cfg__notice" :class="notice.tone === 'err' ? 'ui-notice--err' : notice.tone === 'off' ? 'ui-notice--off' : ''" :role="notice.tone === 'err' ? 'alert' : 'status'">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></svg>
      <span>{{ notice.text }}</span>
      <small v-if="notice.detail"><RuleText :text="notice.detail" @rule="openRule($event, null)" @group="groupEditor = { id: $event }" /></small>
      <button v-if="notice.action" class="ui-btn ui-btn--secondary ui-btn--sm ui-notice__action" type="button" :disabled="applyBusy" @click="notice.run?.()">{{ notice.action }}</button>
    </div>

    <input ref="fileInput" class="visually-hidden" type="file" accept=".json,application/json" @change="importFile">
    <!-- 手机上页签在这一行；桌面上页签在侧栏里，这一行只在 JSON 视图时出现 / Phones keep the tabs on this row; on desktop they live in the sidebar and the row appears only in the JSON view -->
    <div v-if="!firstRun && (phone || ui.mode === 'json')" class="cfg__nav">
      <p v-if="ui.mode === 'json'" class="cfg__whole"><span>完整配置</span><button class="ui-btn ui-btn--text ui-btn--sm ui-btn--inline cfg__to-form" type="button" @click="setMode('form')">回到表单</button></p>
      <UiTabs v-else class="cfg__tabs" :model-value="section" :items="tabs" label="配置分类" id-prefix="cfg" @update:model-value="setTab" />
    </div>

    <div v-if="loading && !doc" class="cfg__skeleton" role="status" aria-label="正在读取配置">
      <div class="cfg__sk-tools"><i class="sk"></i><i class="sk"></i><span></span><i class="sk"></i><i class="sk"></i></div>
      <div class="ui-card cfg__sk-list"><div v-for="n in 7" :key="n" class="cfg__sk-row"><i class="sk"></i><span><i class="sk"></i><i class="sk"></i></span><i class="sk"></i><i class="sk"></i></div></div>
    </div>
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
        <RuleEditor v-if="inspector && editor" :key="`${editor.ruleId}-${editor.groupId}`" inspector :rule-id="editor.ruleId" :group-id="editor.groupId" :template="editor.template" @close="closeRule" @saved="ruleSaved" @deleted="ruleDeleted" @edit-group="groupEditor = { id: $event }" />
      </div>
      <UpstreamsTab v-else-if="section === 'upstreams'" @edit="groupEditor = { id: $event }" @rules="showGroupRules" />
      <MappingTab v-else-if="section === 'mapping'" />
      <SettingsTab v-else />
    </div>
    <SaveBar v-if="ready" :json-error="jsonError" @rule="openRule($event, null)" @group="groupEditor = { id: $event }" @reveal="(l: number, c: number) => jsonEditor?.reveal(l, c)" @reload="reload(false)" />
  </div>
  <GroupEditor v-if="groupEditor" :key="groupEditor.id ?? 'new'" :group-id="groupEditor.id" @close="groupEditor = null" @saved="groupSaved" @deleted="groupDeleted" />
  <HistoryDrawer v-if="historyOpen" :compare-with="historyOpen.compare" @close="historyOpen = null" @rule="historyOpen = null; openRule($event, null)" />
  <ImportReportDialog v-if="reportOpen && importReport" @close="reportOpen = false" />
</template>
