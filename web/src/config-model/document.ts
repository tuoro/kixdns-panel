import { mergedFileIn, normalUrl } from './blocklist'
import { importKernel, type ImportNote } from './importer'
import { sameKernel, type KConfigLike } from './kernel'
import { blocklistKey, compile, emptyBlocklists, nextId, ruleGroupPipelineId, settingsFromKernel, withoutWildcard, type Model, type RawEntry, type Rule, type RuleGroup } from './model'

// 配置文件里存的样子：内核配置 + 顶层 panel 键。内核怎么对待 panel 看版本：2026.11.23.11 以前的内核不读它，也不拒绝（不认的键一概不管）；
// 2026.11.23.11 到 2026.11.25.27 的内核把它当作不读的键，启动时记成一条问题，校验和重载都拒绝，面板按这条拒绝的原因认出来，提示把内核
// 更新到最新版（见 kernel-problems.ts 的 PANEL_BLOCK_HINT）；之后的内核接受它，声明能力 config_panel_block_v1。面板服务原样转发、原样落盘，
// 不剥掉它：剥掉就丢了面板的模型。panel 里放整份模型和一个指向内核部分的散列：打开时散列对得上就直接用模型，
// 对不上时：只有 settings 不一样（面板服务端的系统写入只改 settings、不更新散列）就留着模型只换 settings；别处也改过（有人手改过 JSON）
// 就按内核部分重新导入，再从上一份模型接回编号、备注、停用的规则，编出来和内核里一样的东西留上一份的写法。
// What the config file holds: the kernel config plus a top-level panel key. How the kernel treats panel depends on its version: kernels
// before 2026.11.23.11 neither read nor refuse it (they pay no heed to keys they do not know); kernels 2026.11.23.11 to 2026.11.25.27 take
// it for a key they do not read, logging it as a problem at startup and refusing it on validation and reload, and the panel recognises
// that refusal by its reason and asks for the kernel to be updated to the latest (see PANEL_BLOCK_HINT in kernel-problems.ts); later
// kernels take it and declare the capability config_panel_block_v1. The panel server passes it on and stores it as it is, never
// stripping it: that would lose the panel's model. panel carries the whole model and a hash of the kernel part: when the hash matches
// the model is used as is. When it does not: with only settings
// differing (the panel server's system writes change settings and leave the hash) the model stays and takes the new settings; with
// other parts changed too (the JSON was edited by hand) the kernel part is re-imported, ids, notes and disabled rules come over from the
// previous model, and whatever compiles to what the kernel holds keeps the previous model's form.

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

// 以前域名「属于」的值能写成 *.example.com，生成配置时才去掉 *.，界面上却一直显示着，看着像只管子域名。读进来就去掉，界面上看到的
// 就是实际匹配的范围：规则的条件生成的内核配置不变，只是同一个值写了两遍（*.x 和 x）的只留一个。回答条件里的请求域名以前原样写 *.x，
// 内核按字面比后缀，一直匹配不到；现在和规则一样写 x，下次保存起按 x 和它的子域名算
// The 域名 属于 values used to keep *.example.com, dropped only when the config was built, so the page showed a wildcard
// that read as subdomains only. It is dropped on read, so the page shows what actually matches: the kernel config built from a
// rule's conditions is unchanged, except that a value written twice (*.x and x) is kept once. The request domain in answer
// conditions used to be written as *.x, which the kernel compares as a literal suffix and so never matched; it is now written
// as x like the rules, covering x and its subdomains from the next save
function withoutWildcards(model: Model): Model {
  const plain = <C extends { field: string; regex?: boolean; exact?: boolean; values: string[] }>(c: C): C =>
    (c.field === 'domain' || c.field === 'request_domain') && !c.regex && !c.exact && c.values.some((v) => v.startsWith('*.'))
      ? { ...c, values: [...new Set(c.values.map(withoutWildcard))] }
      : c
  const rule = (r: Rule): Rule => ({ ...r, conditions: r.conditions.map((g) => g.map(plain)), response: { ...r.response, conditions: r.response.conditions.map(plain) } })
  return { ...model, rules: model.rules.map(rule), ruleGroups: model.ruleGroups.map((g) => ({ ...g, rules: g.rules.map(rule) })) }
}

// 拦截列表之前的模型没有这一项：读进来补一份空的。没记 builtFor 的，当作文件就是按现在的订阅合成的
// Models from before the blocklists lack them: an empty one is added on read. One without builtFor is taken as built for its current subscriptions
const withBlocklists = (model: Model): Model => {
  if (!model.blocklists) return { ...model, blocklists: emptyBlocklists() }
  // 同一个链接订阅了两次（以前的撤销能做出来，或者写法不同，比如末尾多一个 /）只留一个：位置、编号和名字是第一个的；有一个启用就算启用，链接也用启用的
  // 那个的写法，和合成的文件对得上，读进来不用重新合成
  // A link subscribed twice (an earlier undo could make that, or two spellings such as a trailing /) keeps one: the first's place, id and name; it is
  // enabled when any of them is, with the enabled one's spelling, so it matches the merged file and reading it in needs no new build
  const all = model.blocklists.subscriptions
  // 编号重复的（以前的撤销能做出来）换一个新的：同编号的两个会互相标「改过」，保存时还会对错名字 / A repeated id (an earlier undo could make one) gets a new
  // one: two with one id mark each other as edited, and a save could match the wrong name
  const seen = new Set<number>()
  let next = nextId(model)
  const subscriptions = all.filter((s, i) => all.findIndex((x) => normalUrl(x.url) === normalUrl(s.url)) === i).map((s) => {
    const on = all.find((x) => x.enabled && normalUrl(x.url) === normalUrl(s.url))
    const one = on && on !== s ? { ...s, url: on.url, enabled: true } : s
    const id = seen.has(one.id) ? next++ : one.id
    seen.add(id)
    return id === one.id ? one : { ...one, id }
  })
  // 没有设备时不写 devices：空的一项和没有这一项是同一份配置 / Without devices, devices is left out: an empty one and none are the same config
  const { devices, ...rest } = model.blocklists
  const blocklists = { ...rest, subscriptions, ...(devices?.length ? { devices } : {}) }
  return { ...model, blocklists: typeof blocklists.builtFor === 'string' ? blocklists : { ...blocklists, builtFor: blocklistKey(blocklists) } }
}

/**
 * 内核部分只有 settings 和上一份模型编出来的不一样（面板服务端的系统写入：导入内置 GeoSite、同步 Geo 数据、定时更新拦截列表；JSON 视图里只改了设置）：
 * 上一份模型原样留着，只换 settings 和拦截列表合成的文件。换完再编一遍，和内核部分逐项一样才算，否则为 null，照常重新导入
 * The kernel part differs from what the previous model compiles to in settings only (the panel server's system writes: importing the built-in
 * GeoSite, Geo sync, the scheduled blocklist update; or the JSON view with only settings edited): the previous model stays as it was, with
 * the settings and the blocklists' merged file swapped in. Compiled again it must equal the kernel part item by item, otherwise null and the
 * kernel part is re-imported as usual
 */
function withKernelSettings(kernel: KConfigLike, was: Model): Model | null {
  const settings = kernel.settings ?? {}
  // 服务端定时更新拦截列表时换掉的是文件，订阅没变 / The scheduled blocklist update swaps the file; the subscriptions stay
  const file = was.blocklists.file ? mergedFileIn(settings) ?? null : null
  const next: Model = { ...was, blocklists: { ...was.blocklists, file } }
  next.settings = settingsFromKernel(next, settings, was.settings)
  return sameKernel(compile(next), kernel) ? next : null
}

export function readConfig(cfg: Record<string, unknown>, prev?: Model): ReadResult {
  const panel = cfg.panel as Partial<PanelBlock> | undefined
  const kernel = kernelPart(cfg)
  const stored = panel && panel.v === PANEL_FORMAT && panel.model ? withoutWildcards(withBlocklists(withoutListeners(panel.model))) : undefined
  if (stored && panel!.hash === panelHash(kernel)) return { model: stored, source: 'panel', report: null }
  // 上一份：文件自己带的模型，没有（或认不出格式版本）时是草稿，原样用，只补上拦截列表，和重新导入一样
  // The previous model: the file's own, or else the draft taken as it is, only given its blocklists, as the re-import does
  const was = stored ?? (prev && withBlocklists(prev))
  const same = was && withKernelSettings(kernel, was)
  if (same) return { model: same, source: 'panel', report: null }
  const base = panel?.model ?? prev
  const result = importKernel(kernel, base && withBlocklists(base))
  return { model: result.model, source: 'imported', report: { notes: result.notes, stats: result.stats } }
}
