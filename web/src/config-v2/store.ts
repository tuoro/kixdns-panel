import { computed, onBeforeUnmount, reactive, ref, shallowReactive, watch } from 'vue'
import type { RuleCount, UpstreamCount } from '../api/types'
import { dismissUndoable, useToast } from '../composables/useToast'
import { recentWindowLabel, settledAttempts, upstreamBasis } from '../dashboard-presentation'
import { readConfig, type ImportReport, type ReadResult } from '../config-model/document'
import { normalizeAddress } from '../config-model/kernel'
import { findKernelRule } from '../config-model/trace-names'
import { emptyBlocklists, kernelAddress, mainPipelineId, nextId, ruleGroupPipelineId, ruleTitle, type Model, type Outcome, type Remedy, type Rule, type RuleGroup, type UpstreamGroup } from '../config-model/model'

// 配置页的草稿：一份模型加上「上次读进来 / 保存成功时」的那份，改动按两者比出来。运行状态、保存流程在 useConfigDocument.ts。
// The config page's draft: one model plus the one last loaded or saved, with changes computed between them. Runtime state and the
// save flow live in useConfigDocument.ts.

export function emptyModel(): Model {
  return { format: '1.0', settings: {}, groups: [], rules: [], ruleGroups: [], mappings: [], rest: { type: 'upstream', group: '' }, defaults: { block: 'NXDOMAIN' }, blocklists: emptyBlocklists() }
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
export const changedSubscriptionIds = computed(() => changedIn(appliedModel.value.blocklists.subscriptions, model.blocklists.subscriptions))
export const changedSettingKeys = computed(() => {
  const before = appliedModel.value.settings
  const after = model.settings
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
    + blocklistChanges(before.blocklists, model.blocklists, diff, order)
    + (JSON.stringify(before.rest) !== JSON.stringify(model.rest) ? 1 : 0) + (JSON.stringify(before.defaults) !== JSON.stringify(model.defaults) ? 1 : 0)
    + (JSON.stringify(before.entries ?? null) !== JSON.stringify(model.entries ?? null) ? 1 : 0)
    + (JSON.stringify(before.trailingEntries ?? null) !== JSON.stringify(model.trailingEntries ?? null) ? 1 : 0)
    // 表单里没有的内核部分（JSON 视图里改的顶层键、原样保留的 Pipeline 等）也算：不算的话改了不提示，下次保存悄悄带出去
    // Kernel parts the form does not model (top-level keys edited in the JSON view, pipelines kept verbatim and so on) count too: otherwise
    // the change raises nothing and ships silently with the next save
    + UNMODELLED.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(model[k] ?? null)).length
})
// 拦截列表：每个订阅算一处，自己写的规则算一处；只换了合成的文件（立即更新）也算一处
// Blocklists: each subscription is one place and the rules of one's own one more; a new merged file alone (立即更新) counts as one
function blocklistChanges(before: Model['blocklists'], after: Model['blocklists'], diff: <T extends { id: number }>(a: T[], b: T[]) => number, order: (a: { id: number }[], b: { id: number }[]) => number): number {
  const subscriptions = diff(before.subscriptions, after.subscriptions) + order(before.subscriptions, after.subscriptions)
  return subscriptions + (before.custom !== after.custom ? 1 : 0) + (!subscriptions && before.file !== after.file ? 1 : 0)
}
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
// 草稿整份换掉过几次：换过以后，之前发出去的那份就不再是这份草稿的底子；开着的抽屉、对话框也看着它，拿着的副本跟着换
// How often the draft was replaced wholesale: after one, a draft sent earlier no longer underlies this one; open drawers and dialogs watch it too, so the copies they hold follow
const generation = ref(0)
export const draftGeneration = (): number => generation.value
export function replaceModel(next: Model): void {
  // 草稿整份换掉，旧草稿上的撤销提示一起收起 / The draft is replaced wholesale, so undo messages about the old one go too
  dismissUndoable()
  generation.value += 1
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
/** 对照的那份（已保存的配置）现在的样子，保存时记下来 / The baseline (the saved config) as it is now, recorded when a save starts */
export const appliedSnapshot = (): string => applied.value
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
      const kname = kernelRuleName(r)
      const n = counts.filter((c) => c.phase === 'request' && c.pipeline === pipeline && c.rule.replace(/#\d+$/, '') === kname).reduce((s, c) => s + c.count, 0)
      if (n) map.set(r.id, n)
    }
  }
  hits.value = map
}
export const hitsOf = (rule: Rule): number => hits.value.get(rule.id) ?? 0
const kernelRuleName = (rule: Rule) => rule.name.trim() || `rule-${rule.id}`
/** 查询日志里这条规则的查询：按内核里的名字和所在列表筛，和命中数同一口径 / This rule's queries in the query log: by its kernel name and list, as the hit count is */
export function ruleLogQuery(rule: Rule): { rule: string; in: string } {
  const group = model.ruleGroups.find((g) => g.rules.some((r) => r.id === rule.id))
  return { rule: kernelRuleName(rule), in: group ? ruleGroupPipelineId(model, group.id) : mainPipelineId(model) }
}

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
export const ui = reactive({ query: '', kind: '', tab: 'rules', mode: 'form' as 'form' | 'json' })

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
  // 只在「回答后检查」里用到时点明这一点：这一处平时不走，最容易被忘掉（旧面板的副本就是这样留下来的）
  // A use only in 回答后检查 says so: it is rarely taken and the easiest to forget (the old panel's copies were left behind this way)
  const scan = (rules: Rule[], where: string) => {
    for (const r of rules) {
      const direct = r.outcome.type === 'upstream' && r.outcome.group === groupId
      const checked = r.response.mode === 'custom' && [r.response.then, r.response.otherwise].some((x) => x.type === 'upstream' && x.group === groupId)
      if (direct) out.push(`${where}「${ruleTitle(r)}」`)
      else if (checked) out.push(`${where}「${ruleTitle(r)}」的回答后检查`)
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
// 旧版面板（v3.4.0 及更早）编辑被几处共用的组时，会复制一份「原名-copy」（重名再加 -2、-3），只改当时编辑的那一处，原来的组照旧
// 被其余几处用着。升级后两份一起摆出来，看着像删掉的东西又回来了：认出这一对，页面上说清楚
// The old panel (v3.4.0 and earlier) copied a group used in several places to 「name-copy」 (then -2, -3) when one place was edited, leaving the
// original in use elsewhere. After an upgrade both show up and look like something deleted came back: spot the pair so the page can explain it
export function oldPanelCopies(): { copy: UpstreamGroup; original: UpstreamGroup }[] {
  const pid = (g: UpstreamGroup) => g.pipelineId ?? `upstream-${g.id}`
  return model.groups.flatMap((copy) => {
    const base = /^(.+)-copy(?:-\d+)?$/.exec(pid(copy))?.[1]
    const original = base === undefined ? undefined : model.groups.find((g) => g !== copy && pid(g) === base)
    return original ? [{ copy, original }] : []
  })
}
// 什么时候不能一键用副本替换原来那组：副本的备用就是原来那组（替换后自己备用自己）；高级规则、高级入口或原样保留的 Pipeline 里
// 写着副本的 ID（面板不改手写的内容，删掉副本会让它们指空）
// When a copy cannot replace its original in one step: the copy falls back to the original (it would fall back to itself), or an advanced
// rule, advanced entry or verbatim pipeline names the copy's ID (the panel does not edit hand-written content, and removing the copy would leave it dangling)
export function copyReplaceBlocker(copy: UpstreamGroup, original: UpstreamGroup): string | null {
  if (copy.fallback.group === original.id && (copy.fallback.onError || copy.fallback.onPolluted)) return `它的备用组就是「${original.name}」`
  const pid = copy.pipelineId ?? `upstream-${copy.id}`
  const raw = [model.entries ?? [], model.trailingEntries ?? [], model.rawPipelines ?? [], [...model.rules, ...model.ruleGroups.flatMap((g) => g.rules)].filter((r) => r.raw).map((r) => r.raw)]
  return JSON.stringify(raw).includes(`"${pid}"`) ? '高级规则或高级入口里引用了它' : null
}
// 用旧版面板的副本替换原来那组：原来那组留下名字和 Pipeline ID，地址、客户端子网和备用换成副本的；用副本的地方改用原来那组，副本删掉。
// 原来那组还用着的地方（比如回答后检查）跟着改走副本的上游——旧版面板当时本该做到的。返回撤销：只还原这里动过的地方
// Replace the original with the old panel's copy: the original keeps its name and pipeline ID and takes the copy's addresses, client subnet and
// fallback; whatever used the copy now uses the original, and the copy goes. Places still on the original (an answer check, say) follow the
// copy's upstreams, which is what the old panel should have done at the time. Returns an undo that restores only what was touched here
export function replaceWithCopy(copy: UpstreamGroup, original: UpstreamGroup): () => void {
  const clone = (g: UpstreamGroup) => JSON.parse(JSON.stringify({ addresses: g.addresses, ecs: g.ecs, fallback: g.fallback })) as Pick<UpstreamGroup, 'addresses' | 'ecs' | 'fallback'>
  const kept = clone(original)
  const undo: (() => void)[] = [() => Object.assign(original, kept)]
  Object.assign(original, clone(copy))
  // 备用组那一格关着时可能还留着原来那组的 ID：清掉，免得写成自己备用自己 / An unused fallback slot may still hold the original's ID: clear it rather than point the group at itself
  if (original.fallback.group === original.id) original.fallback = { group: '', onError: false, onPolluted: false }
  const repoint = (o: { group: string }) => { o.group = original.id; undo.push(() => { o.group = copy.id }) }
  const uses = (o: Outcome | Remedy): o is Extract<Outcome, { type: 'upstream' }> => o.type === 'upstream' && o.group === copy.id
  for (const r of [...model.rules, ...model.ruleGroups.flatMap((g) => g.rules)]) for (const o of [r.outcome, r.response.then, r.response.otherwise]) if (uses(o)) repoint(o)
  for (const o of [model.rest, ...model.ruleGroups.map((g) => g.rest)]) if (uses(o)) repoint(o)
  for (const g of model.groups) if (g !== copy && g.fallback.group === copy.id) repoint(g.fallback)
  const at = model.groups.indexOf(copy)
  model.groups.splice(at, 1)
  undo.push(() => model.groups.splice(Math.min(at, model.groups.length), 0, copy))
  return () => { for (const step of undo.reverse()) step() }
}
export function ruleGroupUsers(groupId: string): Rule[] {
  return [...model.rules, ...model.ruleGroups.flatMap((g) => g.rules)].filter((r) => r.outcome.type === 'group' && r.outcome.group === groupId)
}
