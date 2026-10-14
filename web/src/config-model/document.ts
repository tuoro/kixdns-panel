import { importKernel, type ImportNote } from './importer'
import type { KConfigLike } from './kernel'
import { compile, ruleGroupPipelineId, type Model, type RawEntry, type RuleGroup } from './model'

// 配置文件里存的样子：内核配置 + 顶层 panel 键。内核和面板服务都不认 panel 这个键，也不会拒绝它（内核的 PipelineConfig 没开
// deny_unknown_fields，面板服务只按内核能力校验）。panel 里放整份模型和一个指向内核部分的散列：打开时散列对得上就直接用模型，
// 对不上（有人手改过 JSON）就按内核部分重新导入，再从上一份模型接回编号、备注、停用的规则。
// What the config file holds: the kernel config plus a top-level panel key. Neither the kernel nor the panel server knows the key, and
// neither rejects it (the kernel's PipelineConfig has no deny_unknown_fields; the panel server checks capabilities only). panel carries the
// whole model and a hash of the kernel part: when the hash matches the model is used as is; when it does not (the JSON was edited by
// hand) the kernel part is re-imported and ids, notes and disabled rules come over from the previous model.

export const PANEL_FORMAT = 1
export interface PanelBlock { v: number; hash: string; model: Model }
export interface ImportReport { notes: ImportNote[]; stats: { rules: number; raw: number; groups: number; mappings: number } }

// FNV-1a，够用来判断「内核部分还是不是面板写出去的那份」 / FNV-1a, enough to tell whether the kernel part is still what the panel wrote
const fnv = (s: string) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261).toString(16)
const stable = (v: unknown) => JSON.stringify(v)
/** panel 里记的散列：内核部分是不是面板写出去的那份 / The hash panel records: whether the kernel part is still what the panel wrote */
export const panelHash = (kernel: unknown): string => fnv(stable(kernel))

export function kernelPart(cfg: Record<string, unknown>): KConfigLike {
  const { panel: _panel, ...kernel } = cfg
  return kernel as KConfigLike
}

export function exportConfig(model: Model): Record<string, unknown> {
  const kernel = compile(model)
  const panel: PanelBlock = { v: PANEL_FORMAT, hash: panelHash(kernel), model }
  return { ...kernel, panel }
}

export type ReadSource = 'panel' | 'imported'
export interface ReadResult { model: Model; source: ReadSource; report: ImportReport | null }

// v4.0.0 及更早的模型里规则组可以带监听标签：读进来时挪成高级入口，排在原来的高级入口前面——内核里入口的先后和以前一样，行为不变
// Models from v4.0.0 and earlier could put a listener label on a rule group: on read it becomes an advanced entry ahead of the existing
// ones, so the kernel sees its entries in the same order as before and nothing changes in behaviour
type LegacyGroup = RuleGroup & { listener?: unknown }
function withoutListeners(model: Model): Model {
  const groups = model.ruleGroups as LegacyGroup[]
  if (!groups.some((g) => 'listener' in g)) return model
  const label = (g: LegacyGroup) => (typeof g.listener === 'string' ? g.listener.trim() : '')
  const moved: RawEntry[] = groups.filter((g) => label(g)).map((g) => ({ pipeline: ruleGroupPipelineId(model, g.id), matcher_operator: 'and', matchers: [{ type: 'listener_label', value: label(g) }] }))
  const ruleGroups = groups.map(({ listener: _listener, ...g }) => g)
  return { ...model, ruleGroups, ...(moved.length ? { entries: [...moved, ...(model.entries ?? [])] } : {}) }
}

export function readConfig(cfg: Record<string, unknown>, prev?: Model): ReadResult {
  const panel = cfg.panel as Partial<PanelBlock> | undefined
  const kernel = kernelPart(cfg)
  if (panel && panel.v === PANEL_FORMAT && panel.model && panel.hash === panelHash(kernel)) return { model: withoutListeners(panel.model), source: 'panel', report: null }
  const result = importKernel(kernel, panel?.model ?? prev)
  return { model: result.model, source: 'imported', report: { notes: result.notes, stats: result.stats } }
}
