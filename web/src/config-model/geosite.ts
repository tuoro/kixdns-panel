import type { GeositeCategories, GeositeCategory } from '../api/types'
import type { Rule } from './model'

// GeoSite 分类：从面板读出的数据文件里挑，按内核的规矩比对——名字不分大小写，「分类@属性」按字面找属性名，
// 几个文件有同名分类时后面的为准。这里只放算法，界面在 config-v2/GeositeInput.vue。
// GeoSite categories: picked from the data files the panel reads, compared by the kernel's rules — names ignore case,
// 「category@attr」 looks the attribute key up literally, and when several files share a category the later wins. Only the
// logic lives here; the UI is config-v2/GeositeInput.vue.

// 常用分类的中文说明，按 Loyalsoldier 和 v2fly 的说明写；品牌只写中文名，没有通行中文名的不写
// Chinese notes for common categories, following the Loyalsoldier and v2fly docs; brands get their Chinese name only, and none when there is no common one
export const GEOSITE_NOTES: Readonly<Record<string, string>> = {
  cn: '中国大陆常用域名',
  'geolocation-cn': '中国大陆网站',
  'geolocation-!cn': '中国大陆以外的网站',
  'china-list': '国内加速域名（dnsmasq-china-list）',
  gfw: 'GFWList 收录的域名',
  'category-ads-all': '广告域名，多个来源合并',
  'category-ads': '广告域名',
  private: '局域网和保留用途的域名',
  'tld-cn': '中国大陆的顶级域名，如 .cn',
  'tld-!cn': '中国大陆以外的顶级域名',
  apple: '苹果',
  'apple-cn': '在中国大陆可直连的苹果域名',
  google: '谷歌',
  'google-cn': '在中国大陆可直连的谷歌域名',
  microsoft: '微软',
  amazon: '亚马逊',
  'win-update': 'Windows 更新，拦截会停掉自动更新',
  'win-spy': 'Windows 隐私跟踪',
  'win-extra': 'Windows 其他跟踪',
  'category-games': '游戏厂商和平台',
  'category-dev': '开发者服务',
  'category-ai-!cn': '中国大陆以外的 AI 服务',
  'category-scholar-!cn': '中国大陆以外的学术网站',
  bilibili: '哔哩哔哩',
  tiktok: 'TikTok（抖音国际版）',
}

// 属性只有这几种（v2fly 的定义；telemetry 没写进文档，照字面） / The attributes in use (v2fly's definitions; telemetry is undocumented, so read literally)
export const ATTRIBUTE_NOTES: Readonly<Record<string, string>> = {
  cn: '在中国大陆有接入点',
  ads: '广告',
  '!cn': '被排除出国内列表',
  telemetry: '遥测，上报使用数据',
}

// 还没输入时列出的常用分类，顺序就是展示顺序 / The common categories listed before anything is typed, in display order
export const GEOSITE_COMMON = ['cn', 'geolocation-!cn', 'geolocation-cn', 'category-ads-all', 'private', 'gfw', 'apple', 'google', 'microsoft', 'github', 'netflix', 'telegram', 'youtube', 'openai', 'category-games', 'steam'] as const

/**
 * 面板现在知道的分类，和这份知道能不能拿来下结论：
 * - ready：草稿里的每个文件都读到了，写了数据里没有的分类可以直接指出来；
 * - partial：有的文件读不到或还没保存，列表照用，但不说「没有」；
 * - builtin / none：草稿里没有 GeoSite 文件，GeoSite 条件都不会命中；builtin 时先用安装包里那份列出分类；
 * - loading / failed：还没拿到或拿不到，只能手写。
 * What the panel knows about categories and whether it is enough to conclude anything:
 * ready — every file in the draft read, so a category the data lacks can be pointed out; partial — some files did not
 * read or are not saved yet, so the list is used but nothing is called missing; builtin / none — the draft names no
 * GeoSite file, so no GeoSite condition can match, and with builtin the package's file lists the categories meanwhile;
 * loading / failed — nothing yet or nothing at all, so values are typed by hand.
 */
export type CatalogState = 'ready' | 'partial' | 'builtin' | 'none' | 'loading' | 'failed'

export interface Catalog {
  state: CatalogState
  categories: ReadonlyMap<string, GeositeCategory>
  /** 读不到的文件和原因；reason 为 null 是还没保存 / Files that did not read, with the reason; a null reason means not saved yet */
  gaps: { path: string; reason: string | null }[]
}

/** 和内核的 split_tag_attr 一样：第一个「@」两边都不空才算带属性 / As the kernel's split_tag_attr: only a first 「@」 with text on both sides makes an attribute */
export function splitTag(value: string): { base: string; attr: string | null } {
  const at = value.indexOf('@')
  return at > 0 && at < value.length - 1 ? { base: value.slice(0, at), attr: value.slice(at + 1) } : { base: value, attr: null }
}

/** 把接口给的文件按草稿里的顺序合起来；同名分类后面的文件为准，和内核加载顺序一致 / Merges the API's files in draft order; for a shared category the later file wins, matching the kernel's load order */
export function mergeCatalog(response: GeositeCategories | null, paths: readonly string[], status: 'loading' | 'failed' | 'ok'): Catalog {
  const empty = new Map<string, GeositeCategory>()
  if (status !== 'ok' || !response) return { state: status === 'ok' ? 'loading' : status, categories: empty, gaps: [] }
  const used = paths.map((path) => path.trim()).filter(Boolean)
  if (!used.length) {
    const builtin = response.builtin?.sha256 ? response.catalogs[response.builtin.sha256] : undefined
    return builtin ? { state: 'builtin', categories: new Map(builtin.map((c) => [c.name, c])), gaps: [] } : { state: 'none', categories: empty, gaps: [] }
  }
  const categories = new Map<string, GeositeCategory>()
  const gaps: Catalog['gaps'] = []
  for (const path of used) {
    const file = response.files.find((f) => f.path === path)
    const catalog = file?.sha256 ? response.catalogs[file.sha256] : undefined
    if (!catalog) {
      gaps.push({ path, reason: file ? file.error ?? '读不出内容' : null })
      continue
    }
    for (const category of catalog) categories.set(category.name, category)
  }
  return { state: gaps.length ? 'partial' : 'ready', categories, gaps }
}

export type GeositeIssue =
  | { kind: 'no-data' }
  | { kind: 'category'; base: string }
  | { kind: 'attribute'; base: string; attr: string }

/** 这个值在当前数据里能不能命中；拿不准时不说 / Whether a value can match in the current data; nothing is said when unsure */
export function geositeIssue(value: string, catalog: Catalog): GeositeIssue | null {
  if (/^geosite:/i.test(value)) return null
  if (catalog.state === 'builtin' || catalog.state === 'none') return { kind: 'no-data' }
  if (catalog.state !== 'ready') return null
  const { base, attr } = splitTag(value.toLowerCase())
  const category = catalog.categories.get(base)
  if (!category) return { kind: 'category', base }
  if (attr !== null && !category.attributes.some((a) => a.key === attr)) return { kind: 'attribute', base, attr }
  return null
}

/** 一个条件里第一处问题，写成一句话；「不属于」时后果反过来 / The first problem in a condition as one sentence; 不属于 turns the consequence around */
export function geositeWarning(values: readonly string[], negate: boolean, catalog: Catalog): string | null {
  for (const value of values) {
    const issue = geositeIssue(value, catalog)
    if (!issue) continue
    if (issue.kind === 'no-data') return `还没有 GeoSite 数据，${negate ? '「不属于」对所有域名都成立' : '这个条件不会命中'}。到「基础设置 › Geo 数据」导入或填写`
    const what = issue.kind === 'category' ? `当前 GeoSite 数据里没有 ${issue.base}` : `${issue.base} 里没有标 ${issue.attr} 的域名`
    return `${what}，${negate ? '「不属于」对所有域名都成立' : '这个值不会命中'}`
  }
  return null
}

/**
 * 拿不准的时候说一句为什么不检查：有文件读不到、还没保存，或者整个没拿到分类。不说的话，「分类不存在」的提醒悄悄停了，
 * 用户会以为写的都对。
 * When unsure, say why nothing is checked: a file did not read, is not saved yet, or no categories came at all. Otherwise
 * the missing-category warning would stop silently and everything would look right.
 */
export function uncheckedNote(catalog: Catalog): string | null {
  if (catalog.state === 'failed') return '没拿到 GeoSite 分类，这里只能手写，也不检查分类在不在'
  if (catalog.state !== 'partial') return null
  const gap = catalog.gaps[0]!
  // 路径是拉丁字母，后面接中文要空一格 / The path is Latin text, so a space precedes the Chinese after it
  const more = catalog.gaps.length > 1 ? ` 等 ${catalog.gaps.length} 个文件` : ''
  return gap.reason === null ? `${gap.path}${more || ' '}还没保存，保存后才检查分类在不在` : `读不到 ${gap.path}${more}：${gap.reason}。这里不检查分类在不在`
}

/** `@!` 在 V2Ray 和这里都是属性名本身；旧内核把它当「不带」，所以写了就提醒一次 / `@!` names the attribute itself, here as in V2Ray; old kernels read it as 「without」, so it is explained once */
export function bangNote(values: readonly string[]): string | null {
  const value = values.find((v) => splitTag(v).attr?.startsWith('!'))
  if (!value) return null
  const { base, attr } = splitTag(value)
  return `${value} 指标了 ${attr} 的域名（和 V2Ray 一样）。要「${base} 里不带 ${attr!.slice(1)} 的」，再加一个条件：不属于 ${base}@${attr!.slice(1)}`
}

export interface GeositeOption {
  /** 选中后写进条件的值 / The value written into the condition when picked */
  value: string
  base: string
  attr: string | null
  note: string
  domains: number
  /** 分类带属性，可以再细分 / The category has attributes and can be narrowed */
  refinable: boolean
}

function optionOf(category: GeositeCategory): GeositeOption {
  return { value: category.name, base: category.name, attr: null, note: GEOSITE_NOTES[category.name] ?? '', domains: category.domains, refinable: category.attributes.length > 0 }
}

/** 一个分类可以细分成的几项：「全部」在前，属性按域名数从多到少 / The ways to narrow a category: 全部 first, then attributes by domain count */
export function refineOptions(category: GeositeCategory): GeositeOption[] {
  return [
    { ...optionOf(category), note: '全部' },
    ...[...category.attributes].sort((a, b) => b.domains - a.domains || a.key.localeCompare(b.key)).map((a) => ({
      value: `${category.name}@${a.key}`, base: category.name, attr: a.key, note: ATTRIBUTE_NOTES[a.key] ?? '', domains: a.domains, refinable: false,
    })),
  ]
}

/**
 * 按输入找分类：没输入时列常用的；带「@」时列这个分类的属性；其余先完全相同、再开头相同、再包含（中文说明也算），每一档域名多的在前。
 * 已经选了的不再列；「geosite:」前缀照内核的规矩去掉再找。
 * Finds categories for what was typed: the common ones when nothing is; the category's attributes when 「@」 is; otherwise
 * exact, then prefix, then substring matches (notes included), larger categories first within each. Values already chosen are left out;
 * a 「geosite:」 prefix is dropped before searching.
 */
export function searchGeosite(catalog: Catalog, query: string, chosen: readonly string[] = []): GeositeOption[] {
  const taken = new Set(chosen.map((v) => v.toLowerCase()))
  const q = query.trim().toLowerCase().replace(/^geosite:/, '')
  if (!q) return GEOSITE_COMMON.map((name) => catalog.categories.get(name)).filter((c): c is GeositeCategory => Boolean(c) && !taken.has(c!.name)).map(optionOf)
  const at = q.indexOf('@')
  if (at > 0) {
    const category = catalog.categories.get(q.slice(0, at))
    const attr = q.slice(at + 1)
    return category ? refineOptions(category).filter((o) => o.attr !== null && o.attr.startsWith(attr) && !taken.has(o.value)) : []
  }
  const tiers: GeositeCategory[][] = [[], [], []]
  for (const category of catalog.categories.values()) {
    if (taken.has(category.name)) continue
    // 中文说明也能搜：输入「苹果」找到 apple / Notes are searchable too: 「苹果」 finds apple
    const tier = category.name === q ? 0 : category.name.startsWith(q) ? 1 : category.name.includes(q) || GEOSITE_NOTES[category.name]?.includes(q) ? 2 : -1
    if (tier >= 0) tiers[tier]!.push(category)
  }
  return tiers.flatMap((tier) => tier.sort((a, b) => b.domains - a.domains || a.name.localeCompare(b.name))).map(optionOf)
}

/**
 * 规则列表上的标记：这条规则里有 GeoSite 值在当前数据里命中不了（请求条件，和单独检查回答时的「请求域名 GeoSite」）。
 * 只在数据读全了或者干脆没有数据时说；写成短标签，整句放在提示里。
 * The rule list's tag: a GeoSite value in this rule cannot match in the current data (request conditions, and 请求域名 GeoSite
 * when the rule checks answers itself). Said only when the data read completely or there is none; a short tag, the full
 * sentence as its tooltip.
 */
export function ruleGeositeTag(rule: Rule, catalog: Catalog): { label: string; title: string } | null {
  if (rule.raw) return null
  const conditions = [
    ...rule.conditions.flat().filter((c) => c.field === 'geosite'),
    ...(rule.response.mode === 'custom' ? rule.response.conditions.filter((c) => c.field === 'request_geosite') : []),
  ]
  for (const c of conditions) {
    const title = geositeWarning(c.values, c.negate, catalog)
    if (!title) continue
    // 短标签：手机上规则名和标签挤在一行 / Short tags: on a phone the rule name and its tags share one line
    return { label: catalog.state === 'ready' ? '无此分类' : '缺 GeoSite', title }
  }
  return null
}
