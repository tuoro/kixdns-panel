import { computed, reactive, ref } from 'vue'
import type { RuleCount, UpstreamCount } from '../api/types'
import { readConfig, type ImportReport, type ReadResult } from '../config-model/document'
import { normalizeAddress } from '../config-model/kernel'
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
const byId = <T extends { id: string | number }>(xs: T[]) => new Map(xs.map((x) => [x.id, JSON.stringify(x)]))
function changedIn<T extends { id: string | number }>(before: T[], after: T[]): Set<T['id']> {
  const old = byId(before)
  return new Set(after.filter((x) => old.get(x.id) !== JSON.stringify(x)).map((x) => x.id))
}
export const changedRuleIds = computed(() => {
  const before = appliedModel.value
  return new Set<number>([...changedIn(before.rules, model.rules), ...model.ruleGroups.flatMap((g) => [...changedIn(before.ruleGroups.find((b) => b.id === g.id)?.rules ?? [], g.rules)])])
})
export const changedGroupIds = computed(() => changedIn(appliedModel.value.groups, model.groups))
export const changedMappingIds = computed(() => changedIn(appliedModel.value.mappings, model.mappings))
export const changedSettingKeys = computed(() => {
  const before = appliedModel.value.settings
  const keys = new Set([...Object.keys(before), ...Object.keys(model.settings)])
  const out = new Set([...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(model.settings[k])))
  if (appliedModel.value.format !== model.format) out.add('version')
  return out
})
// 改了几处：按对象数，改一条规则算一处，删掉的也算 / How many places changed: per object, one edited rule is one place, deletions count too
export const changeCount = computed(() => {
  const before = appliedModel.value
  const diff = <T extends { id: string | number }>(a: T[], b: T[]) => changedIn(a, b).size + a.filter((x) => !b.some((y) => y.id === x.id)).length
  const order = (a: { id: string | number }[], b: { id: string | number }[]) => (a.length === b.length && a.map((x) => x.id).join() !== b.map((x) => x.id).join() ? 1 : 0)
  const rgRules = model.ruleGroups.reduce((n, g) => { const p = before.ruleGroups.find((x) => x.id === g.id); return n + diff(p?.rules ?? [], g.rules) + order(p?.rules ?? [], g.rules) }, 0)
  const rgMeta = diff(before.ruleGroups.map((g) => ({ ...g, rules: [] })), model.ruleGroups.map((g) => ({ ...g, rules: [] })))
  return changedSettingKeys.value.size + diff(before.rules, model.rules) + order(before.rules, model.rules) + rgRules + rgMeta
    + diff(before.groups, model.groups) + diff(before.mappings, model.mappings) + order(before.mappings, model.mappings)
    + (JSON.stringify(before.rest) !== JSON.stringify(model.rest) ? 1 : 0) + (JSON.stringify(before.defaults) !== JSON.stringify(model.defaults) ? 1 : 0)
    + (JSON.stringify(before.entries ?? null) !== JSON.stringify(model.entries ?? null) ? 1 : 0)
    + (JSON.stringify(before.trailingEntries ?? null) !== JSON.stringify(model.trailingEntries ?? null) ? 1 : 0)
})
export const dirty = computed(() => changeCount.value > 0)
const OPTIONAL = ['mainId', 'mappingId', 'mainExtra', 'entries', 'trailingEntries', 'rawPipelines', 'extra'] as const
export function replaceModel(next: Model): void {
  const copy = JSON.parse(JSON.stringify(next)) as Model
  for (const k of OPTIONAL) if (copy[k] === undefined) delete model[k]
  Object.assign(model, copy)
}
export function markApplied(): void { applied.value = JSON.stringify(model) }
export function discardDraft(): void { replaceModel(appliedModel.value) }
export function resetTo(next: Model): void { replaceModel(next); markApplied() }
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
// 概览按每个上游地址计数；一个组的数字是它所有地址的合计：成功率按拿到结果的尝试算（取消的不算分母），延迟按次数加权，近一小时取 recent
// The overview counts per upstream address; a group's figures sum its addresses: success over attempts that got a result (aborted ones leave the denominator), latency weighted by attempts, the last hour from recent
export interface GroupHealth { success: number; latency: number | null; queries: number }
export const groupHealth = ref<Map<string, GroupHealth>>(new Map())
export function applyUpstreamStats(counts: UpstreamCount[]): void {
  const map = new Map<string, GroupHealth>()
  const key = (address: string, transport = 'udp') => normalizeAddress(address, transport)
  for (const g of model.groups) {
    const wanted = new Set(g.addresses.map((a) => key(kernelAddress(a))))
    const rows = counts.filter((c) => wanted.has(key(c.upstream, c.transport)))
    if (!rows.length) continue
    const attempts = rows.reduce((n, c) => n + c.attempts - c.aborted, 0)
    const success = rows.reduce((n, c) => n + c.success, 0)
    const timed = rows.filter((c) => c.avg_latency_ms !== null)
    const weight = timed.reduce((n, c) => n + c.attempts - c.aborted, 0)
    const latency = weight ? Math.round(timed.reduce((n, c) => n + (c.avg_latency_ms ?? 0) * (c.attempts - c.aborted), 0) / weight) : null
    const queries = rows.reduce((n, c) => n + (c.recent?.attempts ?? 0), 0)
    if (attempts) map.set(g.id, { success: Math.round((success / attempts) * 1000) / 10, latency, queries })
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
export function findRuleByName(name: string): Rule | undefined {
  return [...model.rules, ...model.ruleGroups.flatMap((g) => g.rules)].find((r) => r.name === name.replace(/#\d+$/, ''))
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
