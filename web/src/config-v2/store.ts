import { computed, onBeforeUnmount, reactive, ref, shallowReactive, watch } from 'vue'
import type { RuleCount, UpstreamCount } from '../api/types'
import { dismissUndoable, useToast } from '../composables/useToast'
import { writtenSettings } from '../config-editor/schema'
import { recentWindowLabel, settledAttempts, upstreamBasis } from '../dashboard-presentation'
import { readConfig, type ImportReport, type ReadResult } from '../config-model/document'
import { normalizeAddress } from '../config-model/kernel'
import { findKernelRule } from '../config-model/trace-names'
import { kernelAddress, mainPipelineId, nextId, ruleGroupPipelineId, type Model, type Outcome, type Rule, type RuleGroup, type UpstreamGroup } from '../config-model/model'

// 配置页的草稿：一份模型加上「上次读进来 / 保存成功时」的那份，改动按两者比出来。运行状态、保存流程在 useConfigDocument.ts。
// The config page's draft: one model plus the one last loaded or saved, with changes computed between them. Runtime state and the
// save flow live in useConfigDocument.ts.

export function emptyModel(): Model {
  return { format: '1.0', settings: {}, groups: [], rules: [], ruleGroups: [], mappings: [], rest: { type: 'upstream', group: '' }, defaults: { block: 'NXDOMAIN' } }
}
export const model = reactive<Model>(emptyModel())
const applied = ref(JSON.stringify(model))
export const appliedModel = computed(() => JSON.parse(applied.value) as Model)

// ---------- 改动 / changes ----------
/**
 * 比较规则时只看看得见、会写进配置的部分：改动时间、条件的内部编号、关着的日志的级别、没打开的回答后检查里留着的内容都不算
 * Rules compare by what is shown and written: the edit time, condition ids, the level of a log that is off and whatever an unused response check still holds do not count
 */
export function ruleShape(rule: Rule): string {
  const plain = <C extends { id: number }>(c: C) => ({ ...c, id: 0 })
  // 客户端子网和回答后检查只在交给上游组时写进配置；别的结果下留着的值不算 / Client subnet and the response check are written only when the rule hands off to an upstream group; values left behind under other outcomes do not count
  const forwards = rule.outcome.type === 'upstream'
  return JSON.stringify({
    ...rule,
    edited: '',
    conditions: rule.conditions.map((group) => group.map(plain)),
    log: rule.log.enabled ? rule.log : { enabled: false },
    ecs: forwards ? rule.ecs : 'inherit',
    response: !forwards ? { mode: 'inherit' } : rule.response.mode === 'custom' ? { ...rule.response, conditions: rule.response.conditions.map(plain) } : { mode: rule.response.mode },
  })
}
const plainShape = (x: unknown) => JSON.stringify(x)
const byId = <T extends { id: string | number }>(xs: T[], shape: (x: T) => string) => new Map(xs.map((x) => [x.id, shape(x)]))
function changedIn<T extends { id: string | number }>(before: T[], after: T[], shape: (x: T) => string = plainShape): Set<T['id']> {
  const old = byId(before, shape)
  return new Set(after.filter((x) => old.get(x.id) !== shape(x)).map((x) => x.id))
}
export const changedRuleIds = computed(() => {
  const before = appliedModel.value
  return new Set<number>([...changedIn(before.rules, model.rules, ruleShape), ...model.ruleGroups.flatMap((g) => [...changedIn(before.ruleGroups.find((b) => b.id === g.id)?.rules ?? [], g.rules, ruleShape)])])
})
export const changedGroupIds = computed(() => changedIn(appliedModel.value.groups, model.groups))
export const changedMappingIds = computed(() => changedIn(appliedModel.value.mappings, model.mappings))
// 按实际写给内核的比（关着的、按能力开的开关不写）：JSON 视图读回来少了一个「关」不算改了一处 / Compared as actually written for the kernel (off capability-gated switches are not written): a JSON round trip dropping an 「off」 is not a change
export const changedSettingKeys = computed(() => {
  const before = writtenSettings(appliedModel.value.settings)
  const after = writtenSettings(model.settings)
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const out = new Set([...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])))
  if (appliedModel.value.format !== model.format) out.add('version')
  return out
})
// 改了几处：按对象数，改一条规则算一处，删掉的也算 / How many places changed: per object, one edited rule is one place, deletions count too
export const changeCount = computed(() => {
  const before = appliedModel.value
  const diff = <T extends { id: string | number }>(a: T[], b: T[], shape?: (x: T) => string) => changedIn(a, b, shape).size + a.filter((x) => !b.some((y) => y.id === x.id)).length
  // 顺序只比两边都有的那些：删一条再加一条不算挪过，和「改了哪些」一致 / Order compares only items on both sides: deleting one and adding another is not a move, matching the review
  const shared = (x: { id: string | number }[], y: { id: string | number }[]) => x.filter((i) => y.some((j) => j.id === i.id)).map((i) => i.id).join()
  const order = (a: { id: string | number }[], b: { id: string | number }[]) => (shared(a, b) !== shared(b, a) ? 1 : 0)
  const rgRules = model.ruleGroups.reduce((n, g) => { const p = before.ruleGroups.find((x) => x.id === g.id); return n + diff(p?.rules ?? [], g.rules, ruleShape) + order(p?.rules ?? [], g.rules) }, 0)
  const rgMeta = diff(before.ruleGroups.map((g) => ({ ...g, rules: [] })), model.ruleGroups.map((g) => ({ ...g, rules: [] })))
  return changedSettingKeys.value.size + diff(before.rules, model.rules, ruleShape) + order(before.rules, model.rules) + rgRules + rgMeta
    + diff(before.groups, model.groups) + diff(before.mappings, model.mappings) + order(before.mappings, model.mappings)
    + (JSON.stringify(before.rest) !== JSON.stringify(model.rest) ? 1 : 0) + (JSON.stringify(before.defaults) !== JSON.stringify(model.defaults) ? 1 : 0)
    + (JSON.stringify(before.entries ?? null) !== JSON.stringify(model.entries ?? null) ? 1 : 0)
    + (JSON.stringify(before.trailingEntries ?? null) !== JSON.stringify(model.trailingEntries ?? null) ? 1 : 0)
    // 表单里没有的内核部分（JSON 视图里改的顶层键、原样保留的 Pipeline 等）也算：不算的话改了不提示，下次保存悄悄带出去
    // Kernel parts the form does not model (top-level keys edited in the JSON view, pipelines kept verbatim and so on) count too: otherwise
    // the change raises nothing and ships silently with the next save
    + UNMODELLED.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(model[k] ?? null)).length
})
export const dirty = computed(() => changeCount.value > 0)
// 还没进草稿的修改也算「没保存」：规则编辑里没点「完成」的、JSON 视图里还没读回的。离开、刷新、重新读取、导入、保存条都只看 unsaved 这一个值
// Edits not yet in the draft count as unsaved too: a rule edit not yet 完成 and JSON text not yet read back. Leaving, reloading,
// re-reading, importing and the save bar all read this one value
export const editorEditedBy = ref<symbol | null>(null)
export const editorEdited = computed(() => editorEditedBy.value !== null)
export const jsonEdited = ref(false)
// 抽屉和弹层（上游组、规则组、高级入口）里还没写进草稿的修改；值是离开时问话里的称呼
// Unfinished edits in drawers and dialogs (upstream group, rule group, advanced entries); the value names it in the leave question
export const dialogEdits = shallowReactive(new Map<symbol, string>())
// 跟着分区一起卸下的那些（规则组、高级入口、域名映射）：换分区前要问；上游组抽屉不跟分区走，换分区它还在，不问
// The ones unmounted with their section (rule groups, 高级入口, domain mappings): a section change asks first; the upstream-group drawer outlives the section and does not ask
export const sectionEdits = shallowReactive(new Set<symbol>())
export const unsaved = computed(() => dirty.value || editorEdited.value || jsonEdited.value || dialogEdits.size > 0)
/** 在组件 setup 里调用：改过就登记，改回去或卸下就注销 / Call in a component's setup: registered while edited, released when reverted or unmounted */
export function trackDialogEdits(what: string, edited: () => boolean, options: { outlivesSection?: boolean } = {}): void {
  const me = Symbol(what)
  watch(edited, (now) => {
    if (now) { dialogEdits.set(me, what); if (!options.outlivesSection) sectionEdits.add(me) } else { dialogEdits.delete(me); sectionEdits.delete(me) }
  }, { immediate: true })
  onBeforeUnmount(() => { dialogEdits.delete(me); sectionEdits.delete(me) })
}
const OPTIONAL = ['mainId', 'mappingId', 'mainExtra', 'entries', 'trailingEntries', 'rawPipelines', 'extra'] as const
export const UNMODELLED = ['mainId', 'mappingId', 'mainExtra', 'rawPipelines', 'extra'] as const
export function replaceModel(next: Model): void {
  // 草稿整份换掉，旧草稿上的撤销提示一起收起 / The draft is replaced wholesale, so undo messages about the old one go too
  dismissUndoable()
  const copy = JSON.parse(JSON.stringify(next)) as Model
  for (const k of OPTIONAL) if (copy[k] === undefined) delete model[k]
  Object.assign(model, copy)
}
export function markApplied(): void { applied.value = JSON.stringify(model) }
export function discardDraft(): void { replaceModel(appliedModel.value) }
// 放弃草稿，提示里能撤销：保存条和手机页头的「…」都走这里 / Discard the draft with an undo in the toast: used by the save bar and the phone header's 「…」
export function discardWithUndo(onlyUnfolded?: string): void {
  const draft = JSON.stringify(model)
  const count = changeCount.value
  discardDraft()
  // 草稿本身没改过（只有面板或 JSON 里的）：没有可撤销的东西 / The draft itself was unchanged (only panel or JSON edits): nothing to undo
  if (!count) { useToast().success(onlyUnfolded ?? '没有要放弃的修改'); return }
  useToast().undoable(`已放弃 ${count} 处修改`, () => replaceModel(JSON.parse(draft) as Model))
}
export function resetTo(next: Model): void { replaceModel(next); markApplied() }
/** 只换「对照的那份」（已保存的配置），草稿不动：文件在别处变了、草稿里还有没保存的修改时用 / Replace only the baseline (the saved config) and leave the draft: for when the file changed while the draft still holds unsaved edits */
export function rebaseApplied(next: Model): void { applied.value = JSON.stringify(next) }
// 从配置文件的内容读进来，当作已保存的那份 / Read from a config file's content and take it as the saved one
export function loadContent(content: Record<string, unknown>, prev?: Model): ReadResult {
  const result = readConfig(content, prev)
  resetTo(result.model)
  return result
}
export const importReport = ref<ImportReport | null>(null)
// 导入报告说的是哪份内容：配置文件、JSON 视图里的修改、导入的文件名 / What the import report is about: the config file, edits in the JSON view, an imported file's name
export const importSource = ref('')
export const reportOpen = ref(false)

// ---------- 编号 / ids ----------
// 模型里现有编号之后往上数；读进新的一份时重新对齐 / Counts up from the model's existing ids, realigned whenever a new model is read
let counter = 0
export function newId(): number {
  counter = Math.max(counter, nextId(model))
  return counter++
}

// ---------- 命中数 / hit counts ----------
// 概览统计按内核里的 pipeline 和规则名计数；规则在内核里叫 name 或 rule-编号，拆开的几条叫 name#N，这里合回一条
// The overview counts by kernel pipeline and rule name; a rule's kernel name is its name or rule-<id>, split parts are name#N, folded back here
export const hits = ref<Map<number, number>>(new Map())
export function applyHits(counts: RuleCount[]): void {
  const map = new Map<number, number>()
  const lists: [string, Rule[]][] = [[mainPipelineId(model), model.rules], ...model.ruleGroups.map((g): [string, Rule[]] => [ruleGroupPipelineId(model, g.id), g.rules])]
  for (const [pipeline, rules] of lists) {
    for (const r of rules) {
      const kname = r.name.trim() || `rule-${r.id}`
      const n = counts.filter((c) => c.phase === 'request' && c.pipeline === pipeline && c.rule.replace(/#\d+$/, '') === kname).reduce((s, c) => s + c.count, 0)
      if (n) map.set(r.id, n)
    }
  }
  hits.value = map
}
export const hitsOf = (rule: Rule): number => hits.value.get(rule.id) ?? 0

// ---------- 上游组的健康 / group health ----------
// 概览按每个上游地址计数；一个组的数字是它所有地址的合计，算法和概览的上游状态一样：每个地址先按它的依据（最近一小时够 50 次可判断的响应就看最近，
// 否则看启动以来）取数，成功率 = 成功 ÷（成功 + 错误），延迟按响应次数加权，次数是拿到结果的尝试。以前这里用累计数和旧分母，同一个上游两页写两个成功率
// The overview counts per upstream address; a group sums its addresses with the overview's upstream-status rule: each address takes its basis (the last hour
// when it has 50 judged responses, otherwise since start), success = success ÷ (success + errors), latency weighted by responses, the count is settled attempts.
// This used lifetime counts and the old denominator, so one upstream showed two success rates on two pages
export interface GroupHealth { success: number; latency: number | null; queries: number; period: string }
export const groupHealth = ref<Map<string, GroupHealth>>(new Map())
export function applyUpstreamStats(counts: UpstreamCount[], windowSeconds: number | null = null): void {
  const map = new Map<string, GroupHealth>()
  const key = (address: string, transport = 'udp') => normalizeAddress(address, transport)
  for (const g of model.groups) {
    const wanted = new Set(g.addresses.map((a) => key(kernelAddress(a))))
    const bases = counts.filter((c) => wanted.has(key(c.upstream, c.transport))).map(upstreamBasis)
    if (!bases.length) continue
    const tallies = bases.map((basis) => basis.tally)
    const success = tallies.reduce((n, t) => n + t.success, 0)
    const judged = success + tallies.reduce((n, t) => n + t.errors, 0)
    const timed = tallies.filter((t) => t.avg_latency_ms !== null)
    const weight = timed.reduce((n, t) => n + settledAttempts(t), 0)
    const latency = weight ? Math.round(timed.reduce((n, t) => n + (t.avg_latency_ms ?? 0) * settledAttempts(t), 0) / weight) : null
    const queries = tallies.reduce((n, t) => n + settledAttempts(t), 0)
    const period = bases.every((basis) => !basis.recent) ? '启动以来' : recentWindowLabel(windowSeconds)
    if (judged) map.set(g.id, { success: Math.round((success / judged) * 1000) / 10, latency, queries, period })
  }
  groupHealth.value = map
}
export const healthOf = (group: UpstreamGroup): GroupHealth | undefined => groupHealth.value.get(group.id)

// ---------- 视图 / view ----------
// settingsGroup：基础设置打开时先显示哪一组（从「去基础设置」过来时指到出问题的那一组） / settingsGroup: which settings group opens first (the one with the problem when arriving from 去基础设置)
export const ui = reactive({ query: '', kind: '', tab: 'rules', mode: 'form' as 'form' | 'json', settingsGroup: '' })

// ---------- 引用 / references ----------
export interface RuleList { rules: Rule[]; rest: Outcome; group: RuleGroup | null }
export function listOf(ruleId: number): RuleList {
  if (model.rules.some((r) => r.id === ruleId)) return { rules: model.rules, rest: model.rest, group: null }
  const group = model.ruleGroups.find((g) => g.rules.some((r) => r.id === ruleId))
  return group ? { rules: group.rules, rest: group.rest, group } : { rules: model.rules, rest: model.rest, group: null }
}
// 内核规则名找回草稿里的规则：名字、没起名字时的 rule-编号、高级规则里的名字 / The draft rule behind a kernel rule name: its name, the rule-id of an unnamed rule, or a name inside an advanced rule
export function findRuleByName(name: string): Rule | undefined {
  return findKernelRule(model, name)
}
// 一个上游组被谁用着：规则、其余请求、别的组的备用、高级规则和入口 / Who uses an upstream group: rules, catch-alls, other groups' fallbacks, advanced rules and entries
export function groupUsers(groupId: string): string[] {
  const out: string[] = []
  const scan = (rules: Rule[], where: string) => {
    for (const r of rules) {
      const uses = (r.outcome.type === 'upstream' && r.outcome.group === groupId)
        || (r.response.mode === 'custom' && [r.response.then, r.response.otherwise].some((x) => x.type === 'upstream' && x.group === groupId))
      if (uses) out.push(`${where}「${r.name}」`)
    }
  }
  scan(model.rules, '规则')
  if (model.rest.type === 'upstream' && model.rest.group === groupId) out.push('其余请求')
  for (const rg of model.ruleGroups) {
    scan(rg.rules, `规则组「${rg.name}」里的`)
    if (rg.rest.type === 'upstream' && rg.rest.group === groupId) out.push(`规则组「${rg.name}」的其余请求`)
  }
  for (const g of model.groups) if (g.id !== groupId && g.fallback.group === groupId && (g.fallback.onError || g.fallback.onPolluted)) out.push(`上游组「${g.name}」的备用`)
  const pid = model.groups.find((g) => g.id === groupId)?.pipelineId ?? `upstream-${groupId}`
  if (JSON.stringify([model.entries ?? [], model.trailingEntries ?? [], [...model.rules, ...model.ruleGroups.flatMap((g) => g.rules)].filter((r) => r.raw).map((r) => r.raw)]).includes(`"${pid}"`)) out.push('高级规则或高级入口')
  return out
}
export function ruleGroupUsers(groupId: string): Rule[] {
  return [...model.rules, ...model.ruleGroups.flatMap((g) => g.rules)].filter((r) => r.outcome.type === 'group' && r.outcome.group === groupId)
}
