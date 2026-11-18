import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { computed } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 编辑器里的正则照内核读：面板服务端拿内核用的那个 regex 库、同样的大小上限编译一遍（POST /api/v1/config/regex-check），页面记下回答。
// 回答来之前、服务端连不上时，页面只拦内核一定不收的那几种（前后断言、反向引用、Rust 不认的转义），别的不标红，保存时内核自己还会再查一遍
// The editor reads regexes as the kernel does: the panel server compiles them with the regex library and size limits the kernel uses
// (POST /api/v1/config/regex-check) and the page keeps the answers. Before an answer, or while the server cannot be reached, the page stops
// only what the kernel surely refuses (lookaround, backreferences, escapes Rust does not know) and marks nothing else; the kernel checks once
// more on save

interface Case { pattern: string; error: string | null }
const KERNEL = (JSON.parse(readFileSync(fileURLToPath(new URL('../../../testdata/kernel-regex.json', import.meta.url)), 'utf8')) as { patterns: Case[] }).patterns
const kernelAnswer = (pattern: string): string | null => {
  const known = KERNEL.find((c) => c.pattern === pattern)
  if (!known) throw new Error(`表里没有 ${pattern}`)
  return known.error
}

// 每条用例一份新的模块：记下的回答不带到下一条 / Fresh modules for every case, so no answer carries over
async function load() {
  vi.resetModules()
  const check = await import('./regex-check')
  const grammar = await import('./grammar')
  const model = await import('./model')
  const blocklist = await import('./blocklist')
  const fields = await import('../config-editor/field-validation')
  return { check, grammar, model, blocklist, fields }
}
afterEach(() => { vi.useRealTimers() })

describe('正则照内核读 / regexes read as the kernel reads them', () => {
  it('服务端回答以后，每一条的结果都是内核的', async () => {
    const { check, grammar } = await load()
    check.setRegexChecker(async (patterns) => patterns.map(kernelAnswer))
    await check.checkKernelRegexes(KERNEL.map((c) => c.pattern))
    expect(KERNEL.filter((c) => grammar.kernelRegexOk(c.pattern) !== (c.error === null)).map((c) => c.pattern)).toEqual([])
  })

  it('规则条件、回答条件、TXT、高级规则、拦截列表自己写的规则都用这个回答', async () => {
    const { check, grammar, model, blocklist, fields } = await load()
    check.setRegexChecker(async (patterns) => patterns.map((p) => (p.includes('a-\\d') ? 'invalid range boundary' : null)))
    // 内核收、JS 读不了的 a++；内核不收、JS 收的 [a-\d] / a++ the kernel takes and JS cannot read; [a-\d] the kernel refuses and JS takes
    await check.checkKernelRegexes(['a++', '[a-\\d]', '(?i)^Ads[a-\\d]'])
    const regex = { regex: true }
    expect([model.FIELD.domain.valid!('a++', regex), model.FIELD.domain.valid!('[a-\\d]', regex)]).toEqual([true, false])
    expect([model.RESPONSE_FIELD.request_domain.valid!('a++', regex), model.RESPONSE_FIELD.request_domain.valid!('[a-\\d]', regex)]).toEqual([true, false])
    expect([model.RESPONSE_FIELD.txt.valid!('a++', { txtMode: 'regex' }), model.RESPONSE_FIELD.txt.valid!('[a-\\d]', { txtMode: 'regex' })]).toEqual([true, false])
    for (const [type, scope] of [['domain_regex', 'request'], ['domain_regex', 'selector'], ['request_domain_regex', 'response']] as const) {
      expect(fields.matcherFieldErrors({ type, operator: 'and', value: 'a++' }, scope)).toEqual({})
      expect(fields.matcherFieldErrors({ type, operator: 'and', value: '[a-\\d]' }, scope)).toEqual({ value: '正则写得不对：KixDNS 不认前后断言、反向引用这些写法' })
    }
    expect(fields.matcherFieldErrors({ type: 'response_txt_content', operator: 'and', mode: 'regex', value: '[a-\\d]' }, 'response')).toEqual({ value: '正则写得不对：KixDNS 不认前后断言、反向引用这些写法' })
    // 自己写的规则问的是写进内核的那个（带大写字母的加了 (?i)） / One's own rule asks about what reaches the kernel (with (?i) for a capital letter)
    expect(blocklist.parseOwnRules('/^Ads[a-\\d]/').problems.map((p) => p.problem)).toEqual([blocklist.skipText({ reason: 'bad-regex' })])
    expect(blocklist.parseOwnRules('/a++/').rules.map((r) => r.match)).toEqual([{ kind: 'regex', value: 'a++' }])
    expect(grammar.kernelRegexOk('a++')).toBe(true)
  })

  it('回答来了，用到它的地方跟着变', async () => {
    const { check, grammar } = await load()
    let answer: (errors: (string | null)[]) => void = () => {}
    check.setRegexChecker((patterns) => new Promise((resolve) => { answer = resolve; expect(patterns).toEqual(['[a-\\d]']) }))
    const ok = computed(() => grammar.kernelRegexOk('[a-\\d]'))
    // 还没回答：本地查不出毛病，不标红 / Not answered yet: the local checks find nothing, so nothing is marked
    expect(ok.value).toBe(true)
    const done = check.checkKernelRegexes(['[a-\\d]'])
    answer(['invalid range boundary'])
    await done
    expect(ok.value).toBe(false)
  })

  it('一会儿里要问的合成一次请求，一次最多 200 个，问过的不再问', async () => {
    vi.useFakeTimers()
    const { check, grammar } = await load()
    const asked: string[][] = []
    check.setRegexChecker(async (patterns) => { asked.push(patterns); return patterns.map(() => null) })
    const patterns = Array.from({ length: 250 }, (_, i) => `^host${i}\\.`)
    for (const p of patterns) grammar.kernelRegexOk(p)
    expect(asked).toEqual([])
    await vi.runAllTimersAsync()
    expect(asked.map((a) => a.length)).toEqual([200, 50])
    expect(asked.flat()).toEqual(patterns)
    for (const p of patterns) grammar.kernelRegexOk(p)
    await vi.runAllTimersAsync()
    expect(asked.length).toBe(2)
  })

  it('在路上的不再问一遍：回答来了才用上', async () => {
    vi.useFakeTimers()
    const { check, grammar } = await load()
    const asked: string[][] = []
    let answer: (errors: (string | null)[]) => void = () => {}
    check.setRegexChecker((patterns) => { asked.push(patterns); return new Promise((resolve) => { answer = resolve }) })
    grammar.kernelRegexOk('[a-\\d]')
    await vi.runAllTimersAsync()
    expect(grammar.kernelRegexOk('[a-\\d]')).toBe(true)
    await vi.runAllTimersAsync()
    expect(asked).toEqual([['[a-\\d]']])
    answer(['invalid range boundary'])
    await vi.runAllTimersAsync()
    expect(grammar.kernelRegexOk('[a-\\d]')).toBe(false)
    expect(asked).toEqual([['[a-\\d]']])
  })

  it('服务端连不上：只按本地的几条拦，过一会儿再问', async () => {
    vi.useFakeTimers()
    const { check, grammar } = await load()
    let calls = 0
    check.setRegexChecker(async () => { calls++; throw new Error('连不上面板') })
    expect([grammar.kernelRegexOk('a++'), grammar.kernelRegexOk('(?=a)'), grammar.kernelRegexOk('(a)\\1'), grammar.kernelRegexOk('\\k<n>')]).toEqual([true, false, false, false])
    await vi.runAllTimersAsync()
    expect(calls).toBe(1)
    expect(grammar.kernelRegexOk('a++')).toBe(true)
    await vi.runAllTimersAsync()
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(check.REGEX_RETRY_MS)
    grammar.kernelRegexOk('a++')
    await vi.runAllTimersAsync()
    expect(calls).toBe(2)
  })
})
