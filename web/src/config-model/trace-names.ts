import { mainPipelineId, ruleGroupPipelineId, ruleTitle, upstreamPipelineId, type Model, type Rule } from './model'

// 执行路径里内核用的名字（rule-12、main、group-g1、upstream-cn）换回配置页上看到的名字。认不出的返回 null，照原样显示。
// Turns the kernel's names in a trace (rule-12, main, group-g1, upstream-cn) back into the names the config page shows. Anything not
// recognised returns null and is shown as it came.
export interface TraceNames {
  /** 内核规则名对应的规则标题 / The rule title behind a kernel rule name */
  rule: (label: string) => string | null
  /** 内核 Pipeline id 对应的说法，比如「主列表」「规则组「内网」」 / How to say a kernel pipeline id, e.g. 主列表 or 规则组「内网」 */
  pipeline: (id: string) => string | null
  /** 请求最先进入的 Pipeline：上游组自己的那条也说成主列表（导入的配置在第一次保存前就是这样） / The pipeline a request enters first: an upstream group's own one reads as the main list too (an imported config looks like that until its first save) */
  entry: (id: string) => string | null
  /** 面板自己生成的规则命中时的整句（其余请求、规则组的其余请求、域名映射），不是这些就 null / The whole sentence for a rule the panel generates (the catch-all, a rule group's catch-all, a mapping); null otherwise */
  matched: (label: string) => string | null
  /**
   * 转发用的那条规则（上游组的、规则单独设了 ECS 或回答检查时自带的）：它和所在的 Pipeline 同名，上一步已经说了进了哪里，这一步不必单列。
   * pipeline 是这一步细节里的「管线」，没有时只认上游组的。
   * The rule a forward pipeline holds (an upstream group's, or a rule's own when it sets ECS or an answer check): it is named after its
   * pipeline, and the step before already says where the request went, so it need not be listed. pipeline is the step's 管线 detail;
   * without it only upstream groups' are recognised.
   */
  plumbing: (label: string, pipeline: string | null) => boolean
  /** 规则单独设了 ECS 或回答检查时自带的转发 Pipeline（rule-编号）：跳进去、在里面查缓存都是内部步骤 / A rule's own forward pipeline (rule-N, when it sets ECS or an answer check): jumping in and checking caches there are internal steps */
  ownForward: (id: string) => boolean
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
  const upstreamIds = new Set(model.groups.map((g) => upstreamPipelineId(model, g.id)))
  const ownRule = (id: string): Rule | undefined => {
    const own = /^rule-(\d+)$/.exec(id)?.[1]
    return own === undefined ? undefined : allRules(model).find((r) => r.id === Number(own))
  }
  const pipeline = (id: string): string | null => {
    if (id === mainPipelineId(model)) return '主列表'
    if (id === (model.mappingId ?? 'domain_mapping')) return '域名映射'
    const group = model.ruleGroups.find((g) => ruleGroupPipelineId(model, g.id) === id)
    if (group) return `规则组「${group.name}」`
    const upstream = model.groups.find((g) => upstreamPipelineId(model, g.id) === id)
    if (upstream) return `上游组「${upstream.name}」`
    const rule = ownRule(id)
    return rule ? `规则「${ruleTitle(rule)}」的转发` : null
  }
  return {
    pipeline,
    entry: (id) => (upstreamIds.has(id) ? '主列表' : pipeline(id)),
    matched: (label) => {
      if (label === '其余请求') return '没有规则命中，按「其余请求」处理'
      const group = model.ruleGroups.find((g) => label === `${g.name}·其余`)
      if (group) return `规则组「${group.name}」里没有规则命中，按「其余请求」处理`
      const mapped = /^域名映射 (.+)$/.exec(label)?.[1]
      return mapped ? `命中域名映射「${mapped}」` : null
    },
    plumbing: (label, at) => (at ? label === at && (upstreamIds.has(at) || /^rule-\d+$/.test(at)) : upstreamIds.has(label) && !findKernelRule(model, label)),
    ownForward: (id) => ownRule(id) !== undefined,
    rule: (label) => {
      const rule = findKernelRule(model, label)
      return rule ? ruleTitle(rule) : null
    },
  }
}
