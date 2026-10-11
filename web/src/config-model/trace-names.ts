import { mainPipelineId, ruleGroupPipelineId, ruleTitle, upstreamPipelineId, type Model, type Rule } from './model'

// 执行路径里内核用的名字（rule-12、main、group-g1、upstream-cn）换回配置页上看到的名字。认不出的返回 null，照原样显示。
// Turns the kernel's names in a trace (rule-12, main, group-g1, upstream-cn) back into the names the config page shows. Anything not
// recognised returns null and is shown as it came.
export interface TraceNames {
  /** 内核规则名对应的规则标题 / The rule title behind a kernel rule name */
  rule: (label: string) => string | null
  /** 内核 Pipeline id 对应的说法，比如「主列表」「规则组「内网」」 / How to say a kernel pipeline id, e.g. 主列表 or 规则组「内网」 */
  pipeline: (id: string) => string | null
}

const allRules = (model: Model): Rule[] => [...model.rules, ...model.ruleGroups.flatMap((g) => g.rules)]

/**
 * 内核规则名找回面板的规则：先按名字（一条规则展开成几条时带 #N），再按没起名字时的 rule-编号，最后找高级规则里同名的那条。
 * Finds the panel rule behind a kernel rule name: by name first (with #N when one rule expands into several), then by the rule-id
 * an unnamed rule gets, then an advanced rule containing a kernel rule of that name.
 */
export function findKernelRule(model: Model, label: string): Rule | undefined {
  const base = label.replace(/#\d+$/, '')
  const rules = allRules(model)
  const byName = rules.find((r) => r.name.trim() && r.name.trim() === base)
  if (byName) return byName
  const id = /^rule-(\d+)$/.exec(base)?.[1]
  const byId = id === undefined ? undefined : rules.find((r) => !r.name.trim() && r.id === Number(id))
  if (byId) return byId
  return rules.find((r) => r.raw?.some((k) => (k as { name?: unknown }).name === label))
}

export function traceNames(model: Model): TraceNames {
  return {
    rule: (label) => {
      const rule = findKernelRule(model, label)
      return rule ? ruleTitle(rule) : null
    },
    pipeline: (id) => {
      if (id === mainPipelineId(model)) return '主列表'
      if (id === (model.mappingId ?? 'domain_mapping')) return '域名映射'
      const group = model.ruleGroups.find((g) => ruleGroupPipelineId(model, g.id) === id)
      if (group) return `规则组「${group.name}」`
      const upstream = model.groups.find((g) => upstreamPipelineId(model, g.id) === id)
      if (upstream) return `上游组「${upstream.name}」`
      const own = /^rule-(\d+)$/.exec(id)?.[1]
      const rule = own === undefined ? undefined : allRules(model).find((r) => r.id === Number(own))
      return rule ? `规则「${ruleTitle(rule)}」的转发` : null
    },
  }
}
