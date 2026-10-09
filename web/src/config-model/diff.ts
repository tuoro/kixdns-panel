import { conditionsText, ecsText, fallbackSentence, outcomeSentence, PROTOCOL_LABEL, effectiveProtocol, remedySentence, responseConditionText, withShi, type Model, type Rule, type UpstreamGroup, ruleTitle } from './model'

// 两份配置差在哪：按页面上的说法写（规则「x」：结果从…改成…），不写 JSON。方向是「恢复这个版本会发生什么」：从现在的 → 那个版本。
// What differs between two configs, in the page's own words (规则「x」：结果从…改成…), never JSON. The direction is "what restoring that
// version does": from the current one to that version.
export interface DiffLine { sign: '-' | '+'; text: string }
export interface DiffBlock { kind: '加上' | '去掉' | '改了' | '移动'; title: string; lines: DiffLine[]; note?: string }

function ruleFacts(m: Model, r: Rule): Record<string, string> {
  if (r.raw) return { 内核规则: JSON.stringify(r.raw) }
  const facts: Record<string, string> = { 条件: conditionsText(r.conditions), 结果: outcomeSentence(m, r.outcome), 状态: r.enabled ? '启用' : '已停用' }
  if (r.log.enabled) facts.日志 = `记录（${r.log.level}）`
  if (r.ecs !== 'inherit') facts.客户端子网 = ecsText(r.ecs)
  if (r.response.mode === 'off') facts.上游回答后 = '不检查'
  if (r.response.mode === 'custom') facts.上游回答后 = `${withShi(r.response.conditions.map(responseConditionText).join(r.response.match === 'all' ? ' 且 ' : '，或 '))}${remedySentence(m, r.response.then)}${r.response.otherwise.type === 'none' ? '' : `，否则${remedySentence(m, r.response.otherwise)}`}`
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
function listDiff(blocks: DiffBlock[], now: Model, then: Model, a: Rule[], b: Rule[], where: string): void {
  for (const r of a) if (!b.some((x) => x.id === r.id)) blocks.push({ kind: '去掉', title: `${where}规则「${ruleTitle(r)}」`, lines: Object.entries(ruleFacts(now, r)).map(([k, v]) => ({ sign: '-', text: `${k}：${v}` })) })
  for (const [i, r] of b.entries()) {
    const old = a.find((x) => x.id === r.id)
    if (!old) { blocks.push({ kind: '加上', title: `${where}规则「${ruleTitle(r)}」`, lines: Object.entries(ruleFacts(then, r)).map(([k, v]) => ({ sign: '+', text: `${k}：${v}` })) }); continue }
    const lines = [...(old.name !== r.name ? [{ sign: '-' as const, text: `名称：${old.name || '（没有名字）'}` }, { sign: '+' as const, text: `名称：${r.name || '（没有名字）'}` }] : []), ...changed(ruleFacts(now, old), ruleFacts(then, r))]
    if (lines.length) blocks.push({ kind: '改了', title: `${where}规则「${ruleTitle(r)}」`, lines })
    const from = a.filter((x) => b.some((y) => y.id === x.id)).indexOf(old)
    const to = b.filter((x) => a.some((y) => y.id === x.id)).indexOf(r)
    if (from !== to && !lines.length) blocks.push({ kind: '移动', title: `${where}规则「${ruleTitle(r)}」`, lines: [], note: `从第 ${a.indexOf(old) + 1} 条移到第 ${i + 1} 条` })
  }
}

export function diffModels(now: Model, then: Model): DiffBlock[] {
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
  for (const k of new Set([...Object.keys(now.settings), ...Object.keys(then.settings)])) {
    const a = now.settings[k]
    const b = then.settings[k]
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    blocks.push({ kind: a === undefined ? '加上' : b === undefined ? '去掉' : '改了', title: `设置 ${k}`, lines: [...(a === undefined ? [] : [{ sign: '-' as const, text: JSON.stringify(a) }]), ...(b === undefined ? [] : [{ sign: '+' as const, text: JSON.stringify(b) }])] })
  }
  if (JSON.stringify(now.defaults) !== JSON.stringify(then.defaults)) blocks.push({ kind: '改了', title: '拦截时怎么回应', lines: [{ sign: '-', text: now.defaults.block }, { sign: '+', text: then.defaults.block }] })
  return blocks
}
