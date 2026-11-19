import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { computed } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegexAnswer, RegexItem, RegexKind } from './regex-check'

// 编辑器里的正则照内核读：面板服务端拿内核用的那个 regex 库、同样的上限编译一遍（POST /api/v1/config/regex-check），页面按 (用在哪儿, 正则)
// 记下回答。编译出来都限 1 MB，TXT 的内核还先看长度（超过 1000 字节不收）。回答来之前、服务端连不上时，页面只拦内核一定不收的那几种（前后断言、反向引用、
// Rust 不认的转义、没写完的括号……），别的不标红，保存时内核自己还会再查一遍
// The editor reads regexes as the kernel does: the panel server compiles them with the regex library and limits the kernel uses (POST
// /api/v1/config/regex-check) and the page keeps the answers by (where it is used, regex). Both compile within 1 MB, and the kernel refuses a
// TXT one over 1000 bytes long first. Before an answer, or while the server cannot be reached, the page stops only what the kernel surely refuses
// (lookaround, backreferences, escapes Rust does not know, unclosed brackets…) and marks nothing else; the kernel checks once more on save

interface Case { kind: RegexKind; pattern: string; error: string | null }
const KERNEL = (JSON.parse(readFileSync(fileURLToPath(new URL('../../../testdata/kernel-regex.json', import.meta.url)), 'utf8')) as { patterns: Case[] }).patterns
// 服务端的回答照内核的原话写成 / The server's answer, written from the kernel's words
const answerOf = (error: string | null): RegexAnswer => {
  if (error === null) return { verdict: 'compiles' }
  const cause = error.startsWith('regex pattern too long') ? 'too-long' : error.includes('exceeds size limit') ? 'too-big' : 'syntax'
  return { verdict: 'refused', cause, error }
}
const kernelAnswer = ({ kind, pattern }: RegexItem): RegexAnswer => {
  const known = KERNEL.find((c) => c.kind === kind && c.pattern === pattern)
  if (!known) throw new Error(`表里没有 ${kind} ${pattern}`)
  return answerOf(known.error)
}
const SYNTAX = '正则写得不对，或者用了 KixDNS 不认的写法，比如前后断言、反向引用'

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
  it('服务端回答以后，每一条的结果都是内核的，TXT 的先看长度', async () => {
    const { check, grammar } = await load()
    check.setRegexChecker(async (items) => items.map(kernelAnswer))
    await check.checkKernelRegexes(KERNEL.map(({ kind, pattern }) => ({ kind, pattern })))
    expect(KERNEL.filter((c) => grammar.kernelRegexOk(c.kind, c.pattern) !== (c.error === null)).map((c) => `${c.kind} ${c.pattern}`)).toEqual([])
    // 编译的上限一样：.*、\d+ 两处都收；1001 字节的正则域名里收，TXT 里不收 / The same compile limit: .* and \d+ are taken in both; a
    // regex of 1001 bytes is taken for names and refused for TXT
    expect(['google-site-verification=.*', '\\d+', '.*'].flatMap((p) => [grammar.kernelRegexOk('domain', p), grammar.kernelRegexOk('txt', p)]).every(Boolean)).toBe(true)
    expect([grammar.kernelRegexOk('domain', 'a'.repeat(1001)), grammar.kernelRegexOk('txt', 'a'.repeat(1001))]).toEqual([true, false])
  })

  it('规则条件、回答条件、TXT、高级规则、拦截列表自己写的规则都用这个回答，各问各的那一种', async () => {
    const { check, grammar, model, blocklist, fields } = await load()
    const asked: RegexItem[] = []
    check.setRegexChecker(async (items) => {
      asked.push(...items)
      return items.map(({ kind, pattern }): RegexAnswer => {
        if (pattern.includes('a-\\d')) return { verdict: 'refused', cause: 'syntax', error: 'invalid range boundary' }
        if (pattern === '\\w{60}') return { verdict: 'refused', cause: 'too-big', error: 'Compiled regex exceeds size limit of 1000000 bytes.' }
        // 只是个替身：按种类回答得不一样，看得出每一处问的是哪一种 / Only a stand-in: answering by kind shows which kind each place asks with
        if (kind === 'txt' && pattern === '\\w+') return { verdict: 'refused', cause: 'syntax', error: 'stand-in for a TXT refusal' }
        return { verdict: 'compiles' }
      })
    })
    // 内核收、JS 读不了的 a++；内核不收、JS 收的 [a-\d] / a++ the kernel takes and JS cannot read; [a-\d] the kernel refuses and JS takes
    await check.checkKernelRegexes(['a++', '[a-\\d]', '(?i)^Ads[a-\\d]', '\\w+', '\\w{60}'].flatMap((pattern) => [{ kind: 'domain' as const, pattern }, { kind: 'txt' as const, pattern }]))
    const regex = { regex: true }
    expect([model.FIELD.domain.valid!('a++', regex), model.FIELD.domain.valid!('[a-\\d]', regex), model.FIELD.domain.valid!('\\w+', regex)]).toEqual([true, false, true])
    expect([model.RESPONSE_FIELD.request_domain.valid!('a++', regex), model.RESPONSE_FIELD.request_domain.valid!('[a-\\d]', regex)]).toEqual([true, false])
    // TXT 的条件问的是 TXT 的那一种 / A TXT condition asks with the TXT kind
    const txt = { txtMode: 'regex' }
    expect([model.RESPONSE_FIELD.txt.valid!('a++', txt), model.RESPONSE_FIELD.txt.valid!('[a-\\d]', txt), model.RESPONSE_FIELD.txt.valid!('\\w+', txt)]).toEqual([true, false, false])
    for (const [type, scope] of [['domain_regex', 'request'], ['domain_regex', 'selector'], ['request_domain_regex', 'response']] as const) {
      expect(fields.matcherFieldErrors({ type, operator: 'and', value: 'a++' }, scope)).toEqual({})
      expect(fields.matcherFieldErrors({ type, operator: 'and', value: '[a-\\d]' }, scope)).toEqual({ value: SYNTAX })
      expect(fields.matcherFieldErrors({ type, operator: 'and', value: '\\w+' }, scope)).toEqual({})
      // 编译后太大说的是大小，不是写法 / Too big once compiled is said as size, not syntax
      expect(fields.matcherFieldErrors({ type, operator: 'and', value: '\\w{60}' }, scope)).toEqual({ value: grammar.regexCauseText('too-big') })
    }
    const txtField = (value: string) => fields.matcherFieldErrors({ type: 'response_txt_content', operator: 'and', mode: 'regex', value }, 'response')
    expect(txtField('[a-\\d]')).toEqual({ value: SYNTAX })
    expect(txtField('\\w+')).toEqual({ value: SYNTAX })
    // TXT 编译后太大说的也是 1 MB / Too big once compiled is 1 MB for TXT too
    expect(txtField('\\w{60}')).toEqual({ value: grammar.regexCauseText('too-big') })
    expect(grammar.regexCauseText('too-big')).toContain('1 MB')
    // TXT 先看长度，和内核一样 / A TXT regex's length comes first, as in the kernel
    expect(txtField(`(?=x)${'a'.repeat(1000)}`)).toEqual({ value: 'TXT 的正则最长 1000 字节' })
    // 不是正则模式的 TXT 不问 / A TXT condition not in regex mode is not asked about
    expect(fields.matcherFieldErrors({ type: 'response_txt_content', operator: 'and', mode: 'exact', value: '\\w+' }, 'response')).toEqual({})
    // 自己写的规则问的是写进内核的那个（带大写字母的加了 (?i)），原因分写法和太大 / One's own rule asks about what reaches the kernel (with (?i) for a
    // capital letter), the reason being syntax or size
    expect(blocklist.parseOwnRules('/^Ads[a-\\d]/').problems.map((p) => p.problem)).toEqual([blocklist.skipText({ reason: 'bad-regex' })])
    expect(blocklist.parseOwnRules('/\\w{60}/').problems.map((p) => p.problem)).toEqual([blocklist.skipText({ reason: 'regex-too-large' })])
    expect(blocklist.parseOwnRules('/a++/').rules.map((r) => r.match)).toEqual([{ kind: 'regex', value: 'a++' }])
    expect(asked.filter((i) => i.pattern === '\\w+').map((i) => i.kind)).toEqual(['domain', 'txt'])
  })

  it('回答来了，用到它的地方跟着变', async () => {
    const { check, grammar } = await load()
    let answer: (found: RegexAnswer[]) => void = () => {}
    check.setRegexChecker((items) => new Promise((resolve) => { answer = resolve; expect(items).toEqual([{ kind: 'domain', pattern: '[a-\\d]' }]) }))
    const ok = computed(() => grammar.kernelRegexOk('domain', '[a-\\d]'))
    // 还没回答：本地查不出毛病，不标红 / Not answered yet: the local checks find nothing, so nothing is marked
    expect(ok.value).toBe(true)
    const done = check.checkKernelRegexes([{ kind: 'domain', pattern: '[a-\\d]' }])
    answer([{ verdict: 'refused', cause: 'syntax', error: 'invalid range boundary' }])
    await done
    expect(ok.value).toBe(false)
  })

  it('一会儿里要问的合成一次请求，一次最多 200 个、写成 JSON 不超过服务端的请求体上限，问过的不再问', async () => {
    vi.useFakeTimers()
    const { check, grammar } = await load()
    const asked: RegexItem[][] = []
    check.setRegexChecker(async (items) => { asked.push(items); return items.map(() => ({ verdict: 'compiles' })) })
    const patterns = Array.from({ length: 250 }, (_, i) => `^host${i}\\.`)
    for (const p of patterns) grammar.kernelRegexOk('domain', p)
    expect(asked).toEqual([])
    await vi.runAllTimersAsync()
    expect(asked.map((a) => a.length)).toEqual([200, 50])
    expect(asked.flat().map((i) => i.pattern)).toEqual(patterns)
    for (const p of patterns) grammar.kernelRegexOk('domain', p)
    await vi.runAllTimersAsync()
    expect(asked.length).toBe(2)
    // 上限长度、满是要转义的反斜杠的正则：按写成 JSON 的字节数分批，一批不超过 REGEX_CHECK_BODY_BYTES / Regexes at the length cap full of
    // backslashes to escape: batched by their bytes as JSON, no batch over REGEX_CHECK_BODY_BYTES
    asked.length = 0
    const heavy = Array.from({ length: 200 }, (_, i) => `${i}${'\\'.repeat(check.REGEX_CHECK_MAX_BYTES - 6)}.`)
    for (const p of heavy) grammar.kernelRegexOk('domain', p)
    await vi.runAllTimersAsync()
    const sizes = asked.map((batch) => new TextEncoder().encode(JSON.stringify({ patterns: batch })).length)
    expect(asked.length).toBeGreaterThan(1)
    expect(sizes.every((size) => size <= check.REGEX_CHECK_BODY_BYTES + 64 * 1024)).toBe(true)
    expect(asked.flat().map((i) => i.pattern)).toEqual(heavy)
  })

  it('同一个正则用在两处，各问各的、各记各的', async () => {
    vi.useFakeTimers()
    const { check, grammar } = await load()
    const asked: RegexItem[][] = []
    check.setRegexChecker(async (items) => { asked.push(items); return items.map(({ kind }) => (kind === 'txt' ? { verdict: 'refused', cause: 'too-big', error: 'too big' } : { verdict: 'compiles' })) })
    grammar.kernelRegexOk('domain', '\\d+')
    grammar.kernelRegexOk('txt', '\\d+')
    await vi.runAllTimersAsync()
    expect(asked).toEqual([[{ kind: 'domain', pattern: '\\d+' }, { kind: 'txt', pattern: '\\d+' }]])
    expect([grammar.kernelRegexOk('domain', '\\d+'), grammar.kernelRegexOk('txt', '\\d+')]).toEqual([true, false])
  })

  it('16 KiB 以上的不问，不下结论：只按本地查得出的拦', async () => {
    vi.useFakeTimers()
    const { check, grammar, fields } = await load()
    const asked: RegexItem[][] = []
    check.setRegexChecker(async (items) => { asked.push(items); return items.map(() => ({ verdict: 'unchecked' })) })
    const long = 'a'.repeat(check.REGEX_CHECK_MAX_BYTES + 1)
    expect(check.kernelRegexVerdict('domain', long)).toEqual({ verdict: 'unchecked' })
    expect(grammar.kernelRegexOk('domain', long)).toBe(true)
    expect(grammar.kernelRegexOk('domain', `(?=x)${long}`)).toBe(false)
    expect(fields.matcherValueChecking({ type: 'domain_regex', operator: 'and', value: long })).toBe(false)
    await vi.runAllTimersAsync()
    expect(asked).toEqual([])
    // 正好到上限的照问；服务端回答「不下结论」也记下，不一直问 / One right at the cap is asked; a 「no verdict」 answer is kept too, not asked
    // over and over
    const atCap = 'a'.repeat(check.REGEX_CHECK_MAX_BYTES)
    expect(grammar.kernelRegexOk('domain', atCap)).toBe(true)
    await vi.runAllTimersAsync()
    expect(asked.map((a) => a.length)).toEqual([1])
    expect(check.kernelRegexVerdict('domain', atCap)).toEqual({ verdict: 'unchecked' })
    expect(grammar.kernelRegexOk('domain', atCap)).toBe(true)
    await vi.runAllTimersAsync()
    expect(asked.length).toBe(1)
  })

  it('在路上的不再问一遍：回答来了才用上；在问的时候算「在查」，回答来了就不是', async () => {
    vi.useFakeTimers()
    const { check, grammar, fields } = await load()
    const asked: RegexItem[][] = []
    let answer: (found: RegexAnswer[]) => void = () => {}
    check.setRegexChecker((items) => { asked.push(items); return new Promise((resolve) => { answer = resolve }) })
    const matcher = { type: 'domain_regex', operator: 'and' as const, value: '[a-\\d]' }
    const checking = computed(() => fields.matcherValueChecking(matcher))
    expect(checking.value).toBe(true)
    await vi.runAllTimersAsync()
    expect(grammar.kernelRegexOk('domain', '[a-\\d]')).toBe(true)
    expect(checking.value).toBe(true)
    await vi.runAllTimersAsync()
    expect(asked).toEqual([[{ kind: 'domain', pattern: '[a-\\d]' }]])
    answer([{ verdict: 'refused', cause: 'syntax', error: 'invalid range boundary' }])
    await vi.runAllTimersAsync()
    expect(grammar.kernelRegexOk('domain', '[a-\\d]')).toBe(false)
    expect(checking.value).toBe(false)
    expect(asked).toEqual([[{ kind: 'domain', pattern: '[a-\\d]' }]])
    // 本地就看得出不对的不算「在查」：结论已经有了 / One the page can tell is wrong is not 「checking」: the conclusion is in
    expect(fields.matcherValueChecking({ type: 'domain_regex', operator: 'and', value: '(abc' })).toBe(false)
  })

  it('服务端连不上：只按本地的几条拦，不算「在查」，过一会儿再问', async () => {
    vi.useFakeTimers()
    const { check, grammar, fields } = await load()
    let calls = 0
    check.setRegexChecker(async () => { calls++; throw new Error('连不上面板') })
    expect([grammar.kernelRegexOk('domain', 'a++'), grammar.kernelRegexOk('domain', '(?=a)'), grammar.kernelRegexOk('domain', '(a)\\1'), grammar.kernelRegexOk('domain', '\\k<n>'), grammar.kernelRegexOk('domain', '(a')]).toEqual([true, false, false, false, false])
    const checking = computed(() => fields.matcherValueChecking({ type: 'domain_regex', operator: 'and', value: 'a++' }))
    expect(checking.value).toBe(true)
    await vi.runAllTimersAsync()
    expect(calls).toBe(1)
    expect(checking.value).toBe(false)
    expect(grammar.kernelRegexOk('domain', 'a++')).toBe(true)
    await vi.runAllTimersAsync()
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(check.REGEX_RETRY_MS)
    grammar.kernelRegexOk('domain', 'a++')
    await vi.runAllTimersAsync()
    expect(calls).toBe(2)
  })

  it('回答的条数、写法对不上就当没问成', async () => {
    vi.useFakeTimers()
    const { check, grammar } = await load()
    check.setRegexChecker(async () => [{ verdict: 'nonsense' } as unknown as RegexAnswer])
    expect(grammar.kernelRegexOk('domain', '[a-\\d]')).toBe(true)
    await vi.runAllTimersAsync()
    expect(check.kernelRegexVerdict('domain', '[a-\\d]')).toBeUndefined()
  })

  it('自己写的规则：正则还在问的那几行记在 checking 里，本地看得出不对的直接给原因', async () => {
    vi.useFakeTimers()
    const { check, blocklist } = await load()
    check.setRegexChecker(() => new Promise(() => {}))
    const read = blocklist.parseOwnRules('||ads.example^\n/[a-\\d]x/\n/(ads/\n')
    expect(read.checking).toEqual([2])
    expect(read.problems.map((p) => [p.line, p.problem])).toEqual([[3, blocklist.skipText({ reason: 'bad-regex' })]])
  })
})
