import { describe, expect, it } from 'vitest'
import { readConfig } from './document'
import { importKernel } from './importer'
import { kernelKey, type KConfigLike } from './kernel'
import { compile, compileNamed, repeatedPipelineIds, ruleKernel, ruleProblems, upstreamListProblem, upstreamProblem, type KernelConfig, type Model, type Rule } from './model'
import { generateModel } from './testing/generate'
import { behaviourCheck, refuseUnknownTypes } from './testing/kernel-sim'

// 按种子生成的模型走一遍编配置、读回来、JSON 里改几笔：每一条都是对所有模型成立的性质，不是某一个例子。种子数在 CI 上要便宜，
// 本地想多跑几个就设 MODEL_SEEDS（比如 MODEL_SEEDS=2000）
// Seeded models through compile, read back and a few JSON edits: each test is a property holding for every model, not one example. The seed
// count stays cheap for CI; set MODEL_SEEDS (MODEL_SEEDS=2000, say) to run more locally
const SEEDS = Number(process.env.MODEL_SEEDS ?? 120)
const seeds = Array.from({ length: SEEDS }, (_, i) => i + 1)
// 种子多的时候慢的几项要多等一会儿 / With many seeds the slow ones need longer
const SLOW = 5_000 + SEEDS * 40
// 内核里叫 rule-数字 的规则读回来没有名字（面板给没起名字的规则就这么起名），JSON 里改成这样的名字也一样
// A rule called rule-<digits> in the kernel reads back unnamed (the panel names unnamed rules so), a name changed to one in the JSON too
const readsAs = (name: string) => (/^rule-\d+$/.test(name) ? '' : name)
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const allRules = (m: Model): Rule[] => [...m.rules, ...m.ruleGroups.flatMap((g) => g.rules)]
// 编出来的样子，不带内核规则名 / What a rule compiles to, without kernel rule names
const unnamedKernel = (m: Model, r: Rule) => { const k = ruleKernel(m, { ...r, enabled: true }, ''); return kernelKey([(k.rules as Record<string, unknown>[]).map(({ name: _n, ...x }) => x), k.pipeline ?? null]) }
const identity = (m: Model) => ({
  main: m.rules.map((r) => ({ id: r.id, name: r.name, note: r.note, enabled: r.enabled })),
  groups: m.ruleGroups.map((g) => ({ id: g.id, rules: g.rules.map((r) => ({ id: r.id, name: r.name, note: r.note, enabled: r.enabled })) })),
  mappings: m.mappings.map((x) => ({ id: x.id, domain: x.domain, enabled: x.enabled })),
})
const readBack = (k: KernelConfig, m: Model) => readConfig(k as unknown as Record<string, unknown>, clone(m)).model

describe('编出来的配置内核认：类型名、上游地址、Pipeline 的 id', () => {
  it('每份都只用内核认的类型名，每个上游内核都用得了，Pipeline 的 id 不重复', () => {
    const bad: string[] = []
    for (const s of seeds) {
      const k = compile(generateModel(s))
      try { refuseUnknownTypes(k as KConfigLike) } catch (e) { bad.push(`种子 ${s}：${String(e)}`) }
      for (const p of k.pipelines) for (const r of p.rules) for (const a of [...r.actions, ...r.response_actions_on_match, ...r.response_actions_on_miss]) {
        if (a.type !== 'forward' || typeof a.upstream !== 'string') continue
        for (const up of a.upstream.split(',').map((x) => x.trim())) { const p2 = upstreamProblem(up); if (p2) bad.push(`种子 ${s}：${up} ${p2}`) }
      }
      if (typeof k.settings.default_upstream === 'string') { const p2 = upstreamListProblem(k.settings.default_upstream); if (p2) bad.push(`种子 ${s}：默认上游 ${p2}`) }
      if (repeatedPipelineIds(k).length) bad.push(`种子 ${s}：重名的 Pipeline ${repeatedPipelineIds(k).join('、')}`)
    }
    expect(bad.slice(0, 5)).toEqual([])
  })
})

describe('编配置 → 读回来（有上一份）→ 再编：一模一样，每样东西还是原来那样', () => {
  it('内核配置一样，编号、名字、备注、启用与否都一样', () => {
    const bad: string[] = []
    for (const s of seeds) {
      const m = generateModel(s)
      const k = compile(m)
      const back = importKernel(clone(k) as KConfigLike, clone(m)).model
      if (kernelKey(compile(back)) !== kernelKey(k)) bad.push(`种子 ${s}：内核配置不一样`)
      else if (JSON.stringify(identity(back)) !== JSON.stringify(identity(m))) bad.push(`种子 ${s}：编号、名字或备注变了`)
    }
    expect(bad.slice(0, 5)).toEqual([])
  })

  it('规则、映射、上游组、其余请求、设置都整个是上一份的', () => {
    const bad: string[] = []
    const shape = (r: Rule) => JSON.stringify({ ...r, edited: '' })
    for (const s of seeds) {
      const m = generateModel(s)
      const back = importKernel(clone(compile(m)) as KConfigLike, clone(m)).model
      for (const r of allRules(m)) {
        const b = allRules(back).find((x) => x.id === r.id)
        if (!b) bad.push(`种子 ${s}：规则 ${r.id} 没了`)
        else if (shape(b) !== shape(r)) bad.push(`种子 ${s}：规则 ${r.id} 写法变了\n${shape(r)}\n${shape(b)}`)
      }
      if (JSON.stringify(back.mappings) !== JSON.stringify(m.mappings)) bad.push(`种子 ${s}：映射变了`)
      if (JSON.stringify(back.groups) !== JSON.stringify(m.groups)) bad.push(`种子 ${s}：上游组变了`)
      if (JSON.stringify([back.rest, back.defaults, back.ruleGroups.map((g) => [g.id, g.rest, g.note, g.name])]) !== JSON.stringify([m.rest, m.defaults, m.ruleGroups.map((g) => [g.id, g.rest, g.note, g.name])])) bad.push(`种子 ${s}：其余请求或规则组变了`)
      if (JSON.stringify(back.settings) !== JSON.stringify(m.settings)) bad.push(`种子 ${s}：设置变了 ${JSON.stringify(m.settings)} → ${JSON.stringify(back.settings)}`)
    }
    expect(bad.slice(0, 5)).toEqual([])
  })

  it('编辑器认可的规则读回来不会变成高级规则（有没有上一份都一样）', () => {
    const bad: string[] = []
    for (const s of seeds) {
      const m = generateModel(s)
      const k = compile(m)
      for (const [how, back] of [['没有上一份', importKernel(clone(k) as KConfigLike).model], ['有上一份', importKernel(clone(k) as KConfigLike, clone(m)).model]] as const) {
        const raw = allRules(back).filter((r) => r.raw).map((r) => r.name || r.id)
        if (raw.length) bad.push(`种子 ${s}（${how}）：读成了高级规则 ${raw.join('、')}`)
        if (back.rawPipelines?.length) bad.push(`种子 ${s}（${how}）：原样保留了 Pipeline ${back.rawPipelines.map((p) => String(p.id)).join('、')}`)
      }
      for (const r of allRules(m)) if (ruleProblems(m, r).length) bad.push(`种子 ${s}：生成的规则 ${r.id} 编辑器不收`)
    }
    expect(bad.slice(0, 5)).toEqual([])
  })

  it('没有上一份时（导入文件）行为一样', { timeout: SLOW }, () => {
    const bad: string[] = []
    for (const s of seeds) {
      const k = compile(generateModel(s)) as KConfigLike
      const check = behaviourCheck(k, compile(importKernel(clone(k)).model) as KConfigLike, 300)
      if (check.mismatches.length) bad.push(`种子 ${s}：${JSON.stringify(check.mismatches[0])}`)
    }
    expect(bad.slice(0, 5)).toEqual([])
  })
})

describe('内核规则名：同一个列表里不重名，对照表不指错', () => {
  it('每个名字指向编出它的那条规则，nameOf 的名字只归这一条', () => {
    const bad: string[] = []
    for (const s of seeds) {
      const m = generateModel(s)
      const { config, index } = compileNamed(m)
      for (const p of config.pipelines) {
        const names = p.rules.map((r) => r.name)
        const dup = names.filter((x, i) => names.indexOf(x) !== i)
        if (dup.length) bad.push(`种子 ${s}：${p.id} 里重名 ${dup.join('、')}`)
        for (const kr of p.rules) {
          const ref = index.lookup(p.id, kr.name)
          if (ref?.kind === 'rule') {
            const r = allRules(m).find((x) => x.id === ref.id)!
            const mine = (ruleKernel(m, r, 'X').rules as Record<string, unknown>[]).map(({ name: _n, ...x }) => kernelKey(x))
            const { name: _n, ...plain } = kr as unknown as Record<string, unknown>
            if (!mine.includes(kernelKey(plain))) bad.push(`种子 ${s}：${p.id}/${kr.name} 指向规则 ${ref.id}，内容却不是它的`)
          }
          const loose = index.lookup(null, kr.name)
          if (loose && ref && JSON.stringify(loose) !== JSON.stringify(ref)) bad.push(`种子 ${s}：不带列表查 ${kr.name} 结果不一样`)
        }
      }
      for (const r of allRules(m)) {
        const at = index.nameOf(r.id)
        if (!at) continue
        const p = config.pipelines.find((x) => x.id === at.pipeline)!
        const others = p.rules.filter((k) => k.name.replace(/#\d+$/, '') === at.name).filter((k) => { const ref = index.lookup(p.id, k.name); return !(ref?.kind === 'rule' && ref.id === r.id) })
        if (others.length) bad.push(`种子 ${s}：nameOf(${r.id}) = ${at.name} 还盖着 ${others.map((k) => k.name).join('、')}`)
      }
    }
    expect(bad.slice(0, 5)).toEqual([])
  })
})

// ---------- JSON 里改几笔 / JSON edits ----------
type KRules = KernelConfig['pipelines'][number]['rules']
// 主列表里一条一条的规则（拆开的几段算一条） / The main list's rules one by one (split parts count as one)
function blocks(m: Model, k: KernelConfig): { id: number; rules: KRules }[] {
  const { index } = compileNamed(m)
  const out: { id: number; rules: KRules }[] = []
  for (const kr of k.pipelines.find((x) => x.id === 'main')!.rules) {
    const ref = index.lookup('main', kr.name)
    if (ref?.kind !== 'rule') continue
    const last = out.at(-1)
    if (last?.id === ref.id) last.rules.push(kr)
    else out.push({ id: ref.id, rules: [kr] })
  }
  return out
}
function rewrite(k: KernelConfig, bs: { rules: KRules }[]) {
  const p = k.pipelines.find((x) => x.id === 'main')!
  p.rules = [...bs.flatMap((b) => b.rules), p.rules.at(-1)!]
}
const rename = (b: { rules: KRules }, name: string) => { b.rules.forEach((kr, i) => { kr.name = b.rules.length > 1 ? `${name}#${i + 1}` : name }) }
const baseOf = (b: { rules: KRules }) => b.rules[0]!.name.replace(/#\d+$/, '')

describe('JSON 里改名、挪位置、删、复制：编号和备注跟着内容走', () => {
  for (const edit of ['改名', '挪位置', '改名又挪位置', '删一条', '复制一条', '改成另一条的名字', '两条互换名字', '删一条再把另一条改成它的名字'] as const) {
    it(edit, { timeout: SLOW }, () => {
      const bad: string[] = []
      let tried = 0
      for (const s of seeds) {
        const m = generateModel(s)
        const k = clone(compile(m))
        const bs = blocks(m, k)
        if (bs.length < 2) continue
        const i = s % bs.length
        const j = (s * 7 + 3) % bs.length === i ? (i + 1) % bs.length : (s * 7 + 3) % bs.length
        const A = bs[i]!
        const B = bs[j]!
        const ruleA = m.rules.find((r) => r.id === A.id)!
        const ruleB = m.rules.find((r) => r.id === B.id)!
        // 改完以后 A 的内容应该在哪个编号上，名字叫什么 / Where A's content should be afterwards, by id, and under which name
        let expectA: { id: number; note: string; name: string } | null = null
        if (edit === '改名') { rename(A, `renamed-${s}`); expectA = { id: ruleA.id, note: ruleA.note, name: `renamed-${s}` } }
        if (edit === '挪位置') { bs.splice(i, 1); bs.splice(j, 0, A); rewrite(k, bs); expectA = { id: ruleA.id, note: ruleA.note, name: ruleA.name } }
        if (edit === '改名又挪位置') { rename(A, `renamed-${s}`); bs.splice(i, 1); bs.splice(j, 0, A); rewrite(k, bs); expectA = { id: ruleA.id, note: ruleA.note, name: `renamed-${s}` } }
        if (edit === '删一条') { bs.splice(i, 1); rewrite(k, bs) }
        // 把跳去自己那个转发的规则复制一份，那个转发就成了两条共用的（读成上游组），是另一件事 / Copying a rule that jumps to its own forward makes that
        // forward shared by two (read as an upstream group), which is another matter
        if (edit === '复制一条' && JSON.stringify(A.rules).includes(`"rule-${A.id}"`)) continue
        if (edit === '复制一条') { const copy = { rules: clone(A.rules) }; rename(copy, `copy-${s}`); bs.splice(i + 1, 0, { id: -1, ...copy }); rewrite(k, bs); expectA = { id: ruleA.id, note: ruleA.note, name: ruleA.name } }
        const namedB = Boolean(ruleB.name) && baseOf(B) === ruleB.name
        if (edit === '改成另一条的名字') { if (!namedB) continue; rename(A, ruleB.name) }
        if (edit === '两条互换名字') {
          if (!namedB || !ruleA.name || baseOf(A) !== ruleA.name) continue
          rename(A, ruleB.name)
          rename(B, ruleA.name)
          expectA = { id: ruleA.id, note: ruleA.note, name: readsAs(ruleB.name) }
        }
        if (edit === '删一条再把另一条改成它的名字') {
          if (!namedB) continue
          rename(A, ruleB.name)
          bs.splice(j, 1)
          rewrite(k, bs)
          expectA = { id: ruleA.id, note: ruleA.note, name: readsAs(ruleB.name) }
        }
        tried++
        let after: Model
        try { after = readBack(k, m) } catch (e) { bad.push(`种子 ${s}：读回来报错 ${String(e)}`); continue }
        const ids = allRules(after).map((r) => r.id)
        if (ids.some((x, n) => ids.indexOf(x) !== n)) bad.push(`种子 ${s}：编号重复`)
        for (const r of allRules(after)) {
          const p = allRules(m).find((x) => x.id === r.id)
          if (p && r.name !== p.name && unnamedKernel(after, r) !== unnamedKernel(m, p)) bad.push(`种子 ${s}：规则 ${r.id} 名字和内容都换了，编号和备注还在`)
        }
        if (expectA) {
          const got = allRules(after).find((r) => r.id === expectA!.id)
          if (!got || got.note !== expectA.note || got.name !== expectA.name) bad.push(`种子 ${s}：规则 ${expectA.id} 应为 ${JSON.stringify(expectA)}，读回来是 ${JSON.stringify(got && { id: got.id, name: got.name, note: got.note })}`)
        }
        if (edit === '复制一条') {
          const copies = allRules(after).filter((r) => r.name === `copy-${s}`)
          if (copies.length !== 1 || allRules(m).some((r) => r.id === copies[0]!.id)) bad.push(`种子 ${s}：复制的那条拿了已有的编号`)
        }
        if (edit === '删一条' && allRules(after).some((r) => r.id === ruleA.id && r.enabled)) bad.push(`种子 ${s}：删掉的规则还启用着`)
        if (edit === '改成另一条的名字') {
          const withB = allRules(after).find((r) => r.id === ruleB.id)
          if (withB && unnamedKernel(after, withB) !== unnamedKernel(m, ruleB)) bad.push(`种子 ${s}：B 的编号和备注跑到了 A 的内容上`)
        }
        if (edit === '删一条再把另一条改成它的名字' && allRules(after).some((r) => r.id === ruleB.id && r.enabled)) bad.push(`种子 ${s}：删掉的 B 还在`)
      }
      expect({ tried: tried > 0, bad: bad.slice(0, 5) }).toEqual({ tried: true, bad: [] })
    })
  }
})

describe('JSON 里把上游组改成规则列表、规则组改成转发：Pipeline 的 id 不重复，跳转都有去处', () => {
  const faults = (k: KernelConfig): string[] => {
    const ids = k.pipelines.map((p) => p.id)
    const out = repeatedPipelineIds(k).map((id) => `重名的 ${id}`)
    for (const p of k.pipelines) for (const r of p.rules) for (const a of [...r.actions, ...r.response_actions_on_match, ...r.response_actions_on_miss]) {
      if (a.type === 'jump_to_pipeline' && !ids.includes(String(a.pipeline))) out.push(`${p.id}/${r.name} 跳到没有的 ${String(a.pipeline)}`)
      if (a.type === 'jump_to_pipeline' && String(a.pipeline) === p.id) out.push(`${p.id}/${r.name} 跳回自己`)
    }
    for (const s of k.pipeline_select) if (!ids.includes(s.pipeline)) out.push(`入口指向没有的 ${s.pipeline}`)
    return out
  }
  it('成立', { timeout: SLOW }, () => {
    const bad: string[] = []
    for (const s of seeds) {
      const m = generateModel(s)
      for (const g of m.groups) {
        const k = clone(compile(m))
        const p = k.pipelines.find((x) => x.id === (g.pipelineId ?? `upstream-${g.id}`))!
        p.rules.unshift({ name: 'jsonblock', matchers: [{ type: 'domain_suffix', value: 'blocked.example', operator: 'and' }], matcher_operator: 'and', actions: [{ type: 'deny' }], response_matchers: [], response_matcher_operator: 'and', response_actions_on_match: [], response_actions_on_miss: [] })
        try { for (const f of faults(compile(readBack(k, m)))) bad.push(`种子 ${s} 组 ${g.id} 改成列表：${f}`) } catch (e) { bad.push(`种子 ${s} 组 ${g.id} 改成列表：报错 ${String(e)}`) }
      }
      for (const rg of m.ruleGroups) {
        const k = clone(compile(m))
        const id = rg.pipelineId ?? `group-${rg.id}`
        k.pipelines.find((x) => x.id === id)!.rules = [{ name: id, matchers: [], matcher_operator: 'and', actions: [{ type: 'forward', upstream: '9.9.9.9:53' }], response_matchers: [], response_matcher_operator: 'and', response_actions_on_match: [], response_actions_on_miss: [] }]
        try { for (const f of faults(compile(readBack(k, m)))) bad.push(`种子 ${s} 规则组 ${rg.id} 改成转发：${f}`) } catch (e) { bad.push(`种子 ${s} 规则组 ${rg.id} 改成转发：报错 ${String(e)}`) }
      }
    }
    expect(bad.slice(0, 5)).toEqual([])
  })
})
