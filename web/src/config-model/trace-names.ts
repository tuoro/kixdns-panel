import type { PlaceNames } from '../kernel-problems'
import { blocklistPipelineId, kernelRuleIndex, mainPipelineId, mappingPipelineId, ruleGroupPipelineId, ruleTitle, upstreamPipelineId, type KernelRuleIndex, type KernelRuleRef, type Model, type Rule } from './model'

// 执行路径里内核用的名字（rule-12、main、group-g1、upstream-cn）换回配置页上看到的名字。认不出的返回 null，照原样显示。
// 规则名按所在的列表查编译时的对照表；不知道列表时，只在一个列表里出现的名字照样认得
// Turns the kernel's names in a trace (rule-12, main, group-g1, upstream-cn) back into the names the config page shows. Anything not
// recognised returns null and is shown as it came. Rule names are looked up in the compile's index by their list; without the list, a
// name found in one list only is still known
export interface TraceNames {
  /** 内核规则名对应的规则标题 / The rule title behind a kernel rule name */
  rule: (label: string, pipeline?: string | null) => string | null
  /** 内核规则名指向面板里的哪一样，认不出为 null / What a kernel rule name stands for in the panel; null when unknown */
  ref: (label: string, pipeline?: string | null) => KernelRuleRef | null
  /** 内核 Pipeline id 对应的说法，比如「主列表」「规则组「内网」」 / How to say a kernel pipeline id, e.g. 主列表 or 规则组「内网」 */
  pipeline: (id: string) => string | null
  /** 请求最先进入的 Pipeline：上游组自己的那条也说成主列表（导入的配置在第一次保存前就是这样） / The pipeline a request enters first: an upstream group's own one reads as the main list too (an imported config looks like that until its first save) */
  entry: (id: string) => string | null
  /** 面板自己生成的规则命中时的整句（其余请求、规则组的其余请求、拦截列表、域名映射），不是这些就 null / The whole sentence for a rule the panel generates (the catch-all, a rule group's catch-all, the blocklists, a mapping); null otherwise */
  matched: (label: string, pipeline?: string | null) => string | null
  /**
   * 转发用的那条规则（上游组的、规则单独设了 ECS 或回答检查时自带的）：上一步已经说了进了哪里，这一步不必单列。
   * pipeline 是这一步细节里的「管线」，没有时只认只出现在一个列表里的名字。
   * The rule a forward pipeline holds (an upstream group's, or a rule's own when it sets ECS or an answer check): the step before already
   * says where the request went, so it need not be listed. pipeline is the step's 管线 detail; without it only a name found in one list
   * is recognised.
   */
  plumbing: (label: string, pipeline: string | null) => boolean
  /** 规则单独设了 ECS 或回答检查时自带的转发 Pipeline（rule-编号）：跳进去、在里面查缓存都是内部步骤 / A rule's own forward pipeline (rule-N, when it sets ECS or an answer check): jumping in and checking caches there are internal steps */
  ownForward: (id: string) => boolean
}

const allRules = (model: Model): Rule[] => [...model.rules, ...model.ruleGroups.flatMap((g) => g.rules)]

/**
 * 内核规则名找回面板的规则：查编译时的对照表（列表 + 名字），规则自带的转发里那条也算这条规则。认不出、或者名字不只指向它时找不到
 * Finds the panel rule behind a kernel rule name through the compile's index (list + name); the rule inside a rule's own forward counts as
 * that rule. Nothing is found when the name is unknown or does not lead to one rule only
 */
export function findKernelRule(model: Model, label: string, pipeline: string | null = null, index: KernelRuleIndex = kernelRuleIndex(model)): Rule | undefined {
  const ref = index.lookup(pipeline, label)
  const id = ref?.kind === 'rule' || ref?.kind === 'ownForward' ? ref.id : null
  return id === null ? undefined : allRules(model).find((r) => r.id === id)
}

/**
 * 一句话里「」中的名字找回规则：先认规则在页面上的标题（面板自己写的句子说的是标题，只认一条时才算），再认内核里的规则名（内核报上来的原因）。
 * 叫 rule-3 的规则和编号是 3 的没名字的规则同时在时，「rule-3」是前一条
 * The rule behind a name written in 「」 in a sentence: first the title it shows on the page (the panel's own sentences speak of titles; it
 * counts only when one rule has it), then the kernel's rule name (a reason the kernel reported). With a rule named rule-3 and an unnamed rule
 * of id 3 side by side, 「rule-3」 is the former
 */
export function findRuleByText(model: Model, text: string, index: KernelRuleIndex = kernelRuleIndex(model)): Rule | undefined {
  const titled = allRules(model).filter((r) => ruleTitle(r) === text)
  if (titled.length) return titled.length === 1 ? titled[0] : undefined
  return findKernelRule(model, text, null, index)
}

export function traceNames(model: Model): TraceNames {
  const index = kernelRuleIndex(model)
  const ownRule = (id: string): Rule | undefined => {
    const own = /^rule-(\d+)$/.exec(id)?.[1]
    return own === undefined ? undefined : allRules(model).find((r) => r.id === Number(own))
  }
  const upstreamIds = new Set(model.groups.map((g) => upstreamPipelineId(model, g.id)))
  const blocklistId = blocklistPipelineId(model)
  const pipeline = (id: string): string | null => {
    if (id === mainPipelineId(model)) return '主列表'
    if (id === mappingPipelineId(model)) return '域名映射'
    if (id === blocklistId) return '拦截列表'
    const group = model.ruleGroups.find((g) => ruleGroupPipelineId(model, g.id) === id)
    if (group) return `规则组「${group.name}」`
    const upstream = model.groups.find((g) => upstreamPipelineId(model, g.id) === id)
    if (upstream) return `上游组「${upstream.name}」`
    const rule = ownRule(id)
    return rule ? `规则「${ruleTitle(rule)}」的转发` : null
  }
  const ref = (label: string, at?: string | null) => index.lookup(at ?? null, label)
  return {
    pipeline,
    ref,
    entry: (id) => (upstreamIds.has(id) ? '主列表' : pipeline(id)),
    matched: (label, at) => {
      const said = ref(label, at)
      switch (said?.kind) {
        case 'rest': return '没有规则命中，按「其余请求」处理'
        // 上一步已经写着「进入拦截列表」，这一步不再重复名字 / The step before already reads 进入拦截列表, so this one does not repeat the name
        case 'blocklist': return '要拦截的域名里有它'
        case 'groupRest': {
          const group = model.ruleGroups.find((g) => g.id === said.group)
          return group ? `规则组「${group.name}」里没有规则命中，按「其余请求」处理` : null
        }
        case 'mapping': return `命中域名映射「${said.domain}」`
        default: return null
      }
    },
    plumbing: (label, at) => {
      const said = ref(label, at)
      return said?.kind === 'forward' || said?.kind === 'ownForward'
    },
    ownForward: (id) => ownRule(id) !== undefined,
    rule: (label, at) => {
      const rule = findKernelRule(model, label, at ?? null, index)
      return rule ? ruleTitle(rule) : null
    },
  }
}

/**
 * 内核按位置说的几处（pipelines[i]、pipelines[i].rules[j]）在页面上的叫法：位置在 config（内核读的那份配置：被拒的那份草稿写出的、在用的
 * 那个文件）里数，名字照 model 认。认回面板规则的说规则的标题；面板自己生成的（拦截列表、域名映射这些）说所在的列表和第几条
 * What the places the kernel names by position (pipelines[i], pipelines[i].rules[j]) are called on the page: positions are counted in config
 * (the config the kernel read: what the refused draft writes, the file in use), names traced through model. A place traced back to a panel
 * rule reads as that rule's title; one the panel generates (the blocklists, the mappings and so on) as its list and which rule it is there
 */
export function placeNames(model: Model, config: { pipelines?: readonly { id: string; rules?: readonly { name: string }[] }[] }): PlaceNames {
  const pipelines = config.pipelines ?? []
  const names = traceNames(model)
  return {
    pipeline: (i) => { const at = pipelines[i]; return at ? names.pipeline(at.id) : null },
    rule: (i, j) => {
      const at = pipelines[i]
      const kernelRule = at?.rules?.[j]
      if (!at || !kernelRule) return null
      const title = names.rule(kernelRule.name, at.id)
      if (title) return `规则「${title}」`
      const list = names.pipeline(at.id)
      return list ? `${list}的第\u00a0${j + 1}\u00a0条规则` : null
    },
    quoted: names.pipeline,
  }
}
