import { conditionsText, ecsText, fallbackSentence, outcomeSentence, PROTOCOL_LABEL, effectiveProtocol, rawMatchersText, remedySentence, responseConditionText, withShi, type Blocklists, type Model, type Rule, type Subscription, type UpstreamGroup, ruleTitle } from './model'
import { SETTING_SECTIONS, type SettingField } from '../config-editor/schema'
import { normalUrl, shortName } from './blocklist'

// 设置的改动写基础设置页上的名字和单位（「上游超时」「1800 毫秒」），认不出的键才照原样写
// A settings change uses the name and unit from the settings page (上游超时, 1800 毫秒); only an unknown key is written as it is
const SETTING_FIELDS = new Map(SETTING_SECTIONS.flatMap((section) => section.fields.map((field) => [field.key, field] as const)))
const settingLabel = (field: SettingField) => field.label.replace(/\s*[(（][^)）]*[)）]$/, '')
// Geo 数据的路径不在设置表里，用 Geo 数据页上的叫法 / Geo data paths are not in the settings schema; they take the Geo data page's names
const GEO_LABELS: Record<string, string> = { geoip_db_path: 'GeoIP MMDB 文件', geoip_dat_path: 'GeoIP DAT 文件', geosite_data_paths: 'GeoSite 文件' }
function settingText(value: unknown, field: SettingField | undefined): string {
  if (typeof value === 'boolean') return value ? '开' : '关'
  if (Array.isArray(value)) return value.length ? value.map(String).join('、') : '（空）'
  if (typeof value === 'number' && field?.unit) return `${value.toLocaleString('en-US')} ${field.unit}`
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return JSON.stringify(value)
}

// 两份配置差在哪：按页面上的说法写（规则「x」：结果从…改成…），不写 JSON。方向是「恢复这个版本会发生什么」：从现在的 → 那个版本。
// What differs between two configs, in the page's own words (规则「x」：结果从…改成…), never JSON. The direction is "what restoring that
// version does": from the current one to that version.
export interface DiffLine { sign: '-' | '+'; text: string }
// aside：只是一句说明，不是一处不同，不算进「N 处不同」，排在所有块后面；code：行是规则原文，用等宽字 / aside: a note only, not a difference, so it is not
// counted in 「N 处不同」 and goes after every block; code: the lines are rule text, set in mono
export interface DiffBlock { kind: '加上' | '去掉' | '改了' | '移动'; title: string; lines: DiffLine[]; note?: string; aside?: boolean; code?: boolean }
/** 真正的不同有几处：说明不算 / How many real differences: notes do not count */
export const differences = (blocks: DiffBlock[]): number => blocks.filter((b) => !b.aside).length

// 高级规则读它的内核条件，和规则列表里那一行一样；JSON 只用来比较，不给人看 / An advanced rule reads as its kernel conditions, like its row in the rule list; the JSON is compared, never shown
function rawSummary(r: Rule): string {
  const raw = r.raw ?? []
  const first = raw[0] as { matchers?: Record<string, unknown>[]; matcher_operator?: string } | undefined
  return `${first ? rawMatchersText(first.matchers, first.matcher_operator) : '没有内核规则'}${raw.length > 1 ? `，另有 ${raw.length - 1} 条内核规则` : ''}（按内核写法保留）`
}
// 对比里写页面上的叫法，不写内核取值（debug、zero） / The diff uses the page's words, not kernel values (debug, zero)
const LEVEL_NAME: Record<string, string> = { trace: '跟踪', debug: '调试', info: '信息', warn: '警告', error: '错误' }
const BLOCK_NAME: Record<string, string> = { NXDOMAIN: 'NXDOMAIN', REFUSED: 'REFUSED', zero: '空地址' }
function ruleFacts(m: Model, r: Rule): Record<string, string> {
  if (r.raw) return { 高级规则: rawSummary(r), 状态: r.enabled ? '启用' : '已停用', ...(r.note ? { 备注: r.note } : {}) }
  const facts: Record<string, string> = { 条件: conditionsText(r.conditions), 结果: outcomeSentence(m, r.outcome), 状态: r.enabled ? '启用' : '已停用' }
  if (r.log.enabled) facts.日志 = `记录（${LEVEL_NAME[r.log.level] ?? r.log.level}）`
  // 客户端子网和回答后检查只在交给上游组时生效，别的结果下不列 / Client subnet and the response check apply only when handing off to an upstream group, so other outcomes do not list them
  const forwards = r.outcome.type === 'upstream'
  if (forwards && r.ecs !== 'inherit') facts.客户端子网 = ecsText(r.ecs)
  if (forwards && r.response.mode === 'off') facts.回答后检查 = '不检查'
  if (forwards && r.response.mode === 'custom') facts.回答后检查 = `${withShi(r.response.conditions.map(responseConditionText).join(r.response.match === 'all' ? ' 且 ' : '，或 '))}${remedySentence(m, r.response.then)}${r.response.otherwise.type === 'none' ? '' : `，否则${remedySentence(m, r.response.otherwise)}`}`
  if (r.note) facts.备注 = r.note
  return facts
}
function groupFacts(m: Model, g: UpstreamGroup): Record<string, string> {
  return {
    名称: g.name,
    地址: g.addresses.map((a) => `${PROTOCOL_LABEL[effectiveProtocol(a)]} ${a.address.replace(/^[a-z+]+:\/\//i, '')}`).join('、'),
    客户端子网: ecsText(g.ecs),
    备用: fallbackSentence(m, g) ?? '没有备用组',
  }
}
function changed(a: Record<string, string>, b: Record<string, string>): DiffLine[] {
  const out: DiffLine[] = []
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] === b[k]) continue
    if (a[k] !== undefined) out.push({ sign: '-', text: `${k}：${a[k]}` })
    if (b[k] !== undefined) out.push({ sign: '+', text: `${k}：${b[k]}` })
  }
  return out
}
/**
 * 真正挪过的那几条：两边共有的规则按先后排，最长的一段相同顺序之外的才算挪过。只挪了一条时只报那一条，不把被它顶开的都算上
 * The rules actually moved: of the rules on both sides, those outside the longest run kept in the same order. Moving one rule reports that one, not every rule it pushed along
 */
function movedIds(a: Rule[], b: Rule[]): Set<number> {
  const before = a.filter((x) => b.some((y) => y.id === x.id)).map((x) => x.id)
  const after = b.filter((x) => a.some((y) => y.id === x.id)).map((x) => x.id)
  const n = before.length
  const m = after.length
  const len = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) len[i]![j] = before[i] === after[j] ? len[i + 1]![j + 1]! + 1 : Math.max(len[i + 1]![j]!, len[i]![j + 1]!)
  const kept = new Set<number>()
  for (let i = 0, j = 0; i < n && j < m;) {
    if (before[i] === after[j]) { kept.add(before[i]!); i++; j++ } else if (len[i + 1]![j]! >= len[i]![j + 1]!) i++; else j++
  }
  return new Set(after.filter((id) => !kept.has(id)))
}

function listDiff(blocks: DiffBlock[], now: Model, then: Model, a: Rule[], b: Rule[], where: string): void {
  const moved = movedIds(a, b)
  for (const r of a) if (!b.some((x) => x.id === r.id)) blocks.push({ kind: '去掉', title: `${where}规则「${ruleTitle(r)}」`, lines: Object.entries(ruleFacts(now, r)).map(([k, v]) => ({ sign: '-', text: `${k}：${v}` })) })
  for (const [i, r] of b.entries()) {
    const old = a.find((x) => x.id === r.id)
    if (!old) { blocks.push({ kind: '加上', title: `${where}规则「${ruleTitle(r)}」`, lines: Object.entries(ruleFacts(then, r)).map(([k, v]) => ({ sign: '+', text: `${k}：${v}` })) }); continue }
    const lines = [...(old.name !== r.name ? [{ sign: '-' as const, text: `名称：${old.name || '（没有名字）'}` }, { sign: '+' as const, text: `名称：${r.name || '（没有名字）'}` }] : []), ...changed(ruleFacts(now, old), ruleFacts(then, r))]
    // 内核写法改了、读出来的条件却一样（比如只改了动作）：照样列出来，说明是写法变了 / The kernel rules changed but read the same (say only an action changed): still listed, saying the wording changed
    if (old.raw && r.raw && JSON.stringify(old.raw) !== JSON.stringify(r.raw) && rawSummary(old) === rawSummary(r)) lines.push({ sign: '-', text: `高级规则：${rawSummary(old)}` }, { sign: '+', text: `高级规则：${rawSummary(r)}，内核写法有改动` })
    if (lines.length) blocks.push({ kind: '改了', title: `${where}规则「${ruleTitle(r)}」`, lines })
    if (moved.has(r.id) && !lines.length) blocks.push({ kind: '移动', title: `${where}规则「${ruleTitle(r)}」`, lines: [], note: `从第 ${a.indexOf(old) + 1} 条移到第 ${i + 1} 条` })
  }
}

export function diffModels(now: Model, then: Model, toward: 'save' | 'restore' = 'save'): DiffBlock[] {
  const blocks: DiffBlock[] = []
  listDiff(blocks, now, then, now.rules, then.rules, '')
  if (JSON.stringify(now.rest) !== JSON.stringify(then.rest)) blocks.push({ kind: '改了', title: '其余请求', lines: [{ sign: '-', text: outcomeSentence(now, now.rest) }, { sign: '+', text: outcomeSentence(then, then.rest) }] })
  for (const g of now.groups) if (!then.groups.some((x) => x.id === g.id)) blocks.push({ kind: '去掉', title: `上游组「${g.name}」`, lines: Object.entries(groupFacts(now, g)).map(([k, v]) => ({ sign: '-', text: `${k}：${v}` })) })
  for (const g of then.groups) {
    const old = now.groups.find((x) => x.id === g.id)
    if (!old) { blocks.push({ kind: '加上', title: `上游组「${g.name}」`, lines: Object.entries(groupFacts(then, g)).map(([k, v]) => ({ sign: '+', text: `${k}：${v}` })) }); continue }
    const lines = changed(groupFacts(now, old), groupFacts(then, g))
    if (lines.length) blocks.push({ kind: '改了', title: `上游组「${g.name}」`, lines })
  }
  for (const rg of now.ruleGroups) if (!then.ruleGroups.some((x) => x.id === rg.id)) blocks.push({ kind: '去掉', title: `规则组「${rg.name}」`, lines: [{ sign: '-', text: `连同里面 ${rg.rules.length} 条规则` }] })
  for (const rg of then.ruleGroups) {
    const old = now.ruleGroups.find((x) => x.id === rg.id)
    if (!old) { blocks.push({ kind: '加上', title: `规则组「${rg.name}」`, lines: rg.rules.map((r) => ({ sign: '+', text: `规则「${ruleTitle(r)}」：${conditionsText(r.conditions)} → ${outcomeSentence(then, r.outcome)}` })) }); continue }
    // 规则组自己的名称和说明 / The rule group's own name and note
    const meta = (g: typeof rg) => ({ 名称: g.name, 说明: g.note || '（没有）' })
    const metaLines = changed(meta(old), meta(rg))
    if (metaLines.length) blocks.push({ kind: '改了', title: `规则组「${rg.name}」`, lines: metaLines })
    if (JSON.stringify(old.extra ?? null) !== JSON.stringify(rg.extra ?? null)) blocks.push({ kind: '改了', title: `规则组「${rg.name}」的其他内核设置`, lines: kernelLines(old.extra, rg.extra) })
    listDiff(blocks, now, then, old.rules, rg.rules, `规则组「${rg.name}」的`)
    if (JSON.stringify(old.rest) !== JSON.stringify(rg.rest)) blocks.push({ kind: '改了', title: `规则组「${rg.name}」的其余请求`, lines: [{ sign: '-', text: outcomeSentence(now, old.rest) }, { sign: '+', text: outcomeSentence(then, rg.rest) }] })
  }
  const mapping = (x: Model['mappings'][number]) => `${x.domain} → ${x.target}${x.ttl === null ? '' : ` · ${x.ttl} 秒`}${x.enabled ? '' : '（停用）'}`
  for (const x of now.mappings) if (!then.mappings.some((y) => y.domain === x.domain)) blocks.push({ kind: '去掉', title: `域名映射 ${x.domain}`, lines: [{ sign: '-', text: mapping(x) }] })
  for (const x of then.mappings) {
    const old = now.mappings.find((y) => y.domain === x.domain)
    if (!old) blocks.push({ kind: '加上', title: `域名映射 ${x.domain}`, lines: [{ sign: '+', text: mapping(x) }] })
    else if (mapping(old) !== mapping(x)) blocks.push({ kind: '改了', title: `域名映射 ${x.domain}`, lines: [{ sign: '-', text: mapping(old) }, { sign: '+', text: mapping(x) }] })
  }
  blocklistDiff(blocks, now.blocklists, then.blocklists, toward)
  for (const k of new Set([...Object.keys(now.settings), ...Object.keys(then.settings)])) {
    const a = now.settings[k]
    const b = then.settings[k]
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    const field = SETTING_FIELDS.get(k)
    blocks.push({ kind: a === undefined ? '加上' : b === undefined ? '去掉' : '改了', title: field ? settingLabel(field) : GEO_LABELS[k] ?? `设置 ${k}`, lines: [...(a === undefined ? [] : [{ sign: '-' as const, text: settingText(a, field) }]), ...(b === undefined ? [] : [{ sign: '+' as const, text: settingText(b, field) }])] })
  }
  if (JSON.stringify(now.defaults) !== JSON.stringify(then.defaults)) blocks.push({ kind: '改了', title: '拦截时怎么回应', lines: [{ sign: '-', text: BLOCK_NAME[now.defaults.block] ?? now.defaults.block }, { sign: '+', text: BLOCK_NAME[then.defaults.block] ?? then.defaults.block }] })
  // 映射只换了顺序：先后决定哪条先命中 / Mappings only reordered: the order decides which matches first
  const shared = (a: Model['mappings'], b: Model['mappings']) => a.filter((x) => b.some((y) => y.id === x.id)).map((x) => x.id).join()
  if (shared(now.mappings, then.mappings) !== shared(then.mappings, now.mappings)) blocks.push({ kind: '移动', title: '域名映射的顺序', lines: [], note: then.mappings.map((x) => x.domain).join('、') })
  if (now.format !== then.format) blocks.push({ kind: '改了', title: '配置格式版本', lines: [{ sign: '-', text: now.format }, { sign: '+', text: then.format }] })
  // 高级入口按内核写法读：条件和要进的规则组 / Advanced entries read in kernel terms: the conditions and the rule group entered
  for (const key of ['entries', 'trailingEntries'] as const) {
    const a = now[key] ?? []
    const b = then[key] ?? []
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    const entry = (e: (typeof a)[number]) => `${rawMatchersText(e.matchers, e.matcher_operator)}时进入 ${e.pipeline}`
    blocks.push({ kind: '改了', title: key === 'entries' ? '高级入口' : '主列表之后的高级入口', lines: [...a.map((e) => ({ sign: '-' as const, text: entry(e) })), ...b.map((e) => ({ sign: '+' as const, text: entry(e) }))] })
  }
  // 表单里没有的内核部分（JSON 视图里加的顶层键、原样保留的 Pipeline）：照内核的 JSON 写，至少看得见 / Kernel parts the form does not model (top-level keys added in the JSON view, pipelines kept verbatim): written as the kernel's JSON, so they are at least visible
  for (const key of ['extra', 'rawPipelines', 'mainExtra', 'mainId', 'mappingId'] as const) {
    if (JSON.stringify(now[key] ?? null) === JSON.stringify(then[key] ?? null)) continue
    blocks.push({ kind: '改了', title: '其他内核设置', lines: kernelLines(now[key], then[key]) })
  }
  // 说明排在所有块后面，不夹在两处不同中间读成下一块的引子 / Notes go after every block, rather than sit between two differences and read as the
  // next one's lead-in
  return [...blocks.filter((b) => !b.aside), ...blocks.filter((b) => b.aside)]
}
// 拦截列表：订阅按规整后的链接比（标题已经写着名字，事实里不再写），自己写的规则按行比；只换了合成的文件说一句是重新下载的
// Blocklists: subscriptions compare by normal link (the title already gives the name, so the facts leave it out) and the rules of one's own by line; a
// different merged file alone says the lists were downloaded again
function blocklistDiff(blocks: DiffBlock[], now: Blocklists, then: Blocklists, toward: 'save' | 'restore'): void {
  const facts = (x: Subscription) => ({ 链接: x.url, 状态: x.enabled ? '启用' : '已停用' })
  // 标题里默认名只写文件名：下一行就是完整链接 / A default name shows its file part in the title: the full link is on the next line
  const title = (x: Subscription) => `拦截列表「${shortName(x.name, x.url)}」`
  const same = (a: Subscription, b: Subscription) => normalUrl(a.url) === normalUrl(b.url)
  for (const x of now.subscriptions) if (!then.subscriptions.some((y) => same(x, y))) blocks.push({ kind: '去掉', title: title(x), lines: Object.entries(facts(x)).map(([k, v]) => ({ sign: '-', text: `${k}：${v}` })) })
  for (const x of then.subscriptions) {
    const old = now.subscriptions.find((y) => same(x, y))
    if (!old) { blocks.push({ kind: '加上', title: title(x), lines: Object.entries(facts(x)).map(([k, v]) => ({ sign: '+', text: `${k}：${v}` })) }); continue }
    // 两边都有的只比开关：链接写法不同（大小写、末尾的 /）还是同一个列表 / One on both sides compares on/off only: a link spelt differently (case, a
    // trailing /) is still the same list
    const lines = changed({ 状态: facts(old).状态 }, { 状态: facts(x).状态 })
    if (lines.length) blocks.push({ kind: '改了', title: title(x), lines })
  }
  const links = (b: Blocklists) => b.subscriptions.map((x) => `${normalUrl(x.url)}${x.enabled}`).sort().join()
  // 保存草稿时换上的是新下载的那份，恢复旧版本时换回的是那时下载的。订阅也变了时，恢复的方向照样说两边都启用的那几个换回当时的内容
  // Saving the draft brings in the newer download, restoring an old version brings back the one of its day. With the subscriptions changed too, the
  // restore direction still says the lists enabled on both sides go back to that day's contents
  const shared = now.subscriptions.some((x) => x.enabled && then.subscriptions.some((y) => y.enabled && same(x, y)))
  if (now.file !== then.file && links(now) === links(then)) blocks.push({ kind: '改了', title: '拦截列表', lines: [], note: toward === 'restore' ? '列表内容换回这个版本当时下载的那份' : '列表重新下载过，保存后换成新的那份' })
  // 订阅也变了：两边都启用的那几个有没有重新下载过分不出来，只在拦截列表那几块最后说一句，不算一处不同
  // The subscriptions changed too: whether the lists on both sides were downloaded again cannot be told, so it is one note after the blocklist blocks,
  // not a difference
  const aside: DiffBlock | null = now.file !== then.file && links(now) !== links(then) && toward === 'restore' && shared
    ? { kind: '改了', title: '拦截列表', lines: [], note: '两边都启用的列表，之后重新下载过的，内容也换回这个版本当时下载的那份', aside: true } : null
  const rows = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean)
  const before = rows(now.custom)
  const after = rows(then.custom)
  const lines = [...before.filter((l) => !after.includes(l)).map((text) => ({ sign: '-' as const, text })), ...after.filter((l) => !before.includes(l)).map((text) => ({ sign: '+' as const, text }))]
  if (lines.length) blocks.push({ kind: '改了', title: '拦截列表 · 自己写的规则', lines, code: true })
  // 只挪了行、加减了空行：拦的不变，可原文变了，照样要存 / Lines only moved, or blank lines added or removed: nothing blocked changes, but the text did
  // and is still saved
  else if (now.custom !== then.custom) blocks.push({ kind: '改了', title: '拦截列表 · 自己写的规则', lines: [], note: '只调了顺序或空行，拦截的不变' })
  if (aside) blocks.push(aside)
}
function kernelLines(a: unknown, b: unknown): DiffLine[] {
  return [...(a === undefined || a === null ? [] : [{ sign: '-' as const, text: JSON.stringify(a) }]), ...(b === undefined || b === null ? [] : [{ sign: '+' as const, text: JSON.stringify(b) }])]
}
