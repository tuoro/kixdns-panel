import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MAX_OWN_RULES, ownMatcher, ownRuleText, parseLine, parseOwnRules, skipText, subscriptionName, type Line } from './blocklist'

interface Case {
  line: string
  rules?: { allow: boolean; important: boolean; match: string; value: string }[]
  skip?: string
  modifier?: string
  badfilter?: string
}
const cases = (JSON.parse(readFileSync(fileURLToPath(new URL('../../../testdata/blocklist-syntax.json', import.meta.url)), 'utf8')) as { lines: Case[] }).lines

// 服务端用同一份用例测 crates/panel-server/src/blocklist.rs：两边读同一行必须一样 / The server tests the same cases, so both sides read every line alike
describe('blocklist lines read as the server reads them', () => {
  it.each(cases.map((c) => [c.line, c] as const))('%j', (_, c) => {
    const got: Line = parseLine(c.line)
    if (c.rules) {
      const rules = got.kind === 'rules' ? got.rules.map((r) => ({ allow: r.allow, important: r.important, match: r.match.kind, value: r.match.value })) : got.kind === 'ignored' ? [] : got
      expect(rules).toEqual(c.rules)
    } else if (c.skip) {
      expect(got).toEqual({ kind: 'skipped', skip: c.modifier ? { reason: c.skip, modifier: c.modifier } : { reason: c.skip } })
    } else {
      expect(got).toEqual({ kind: 'badfilter', rule: c.badfilter })
    }
  })
})

describe('rules of one\'s own', () => {
  it('lists the rules in use and says why the other lines went unused', () => {
    const { rules, problems } = parseOwnRules('! 自己加的\n||ad.example.com^\n@@||s.example.com^\n||t.example^$client=192.168.1.20\n||x.example^$badfilter\nnas.lan\n')
    expect(rules).toEqual([
      { line: 2, allow: false, match: { kind: 'suffix', value: 'ad.example.com' } },
      { line: 3, allow: true, match: { kind: 'suffix', value: 's.example.com' } },
      { line: 6, allow: false, match: { kind: 'exact', value: 'nas.lan' } },
    ])
    expect(problems).toEqual([
      { line: 4, text: '||t.example^$client=192.168.1.20', problem: '还不支持 $client' },
      { line: 5, text: '||x.example^$badfilter', problem: '这里用不上 $badfilter：要放行，写一行 @@ 开头的' },
    ])
  })

  it('takes no more than the limit', () => {
    const text = Array.from({ length: MAX_OWN_RULES + 1 }, (_, i) => `||n${i}.example^`).join('\n')
    const { rules, problems } = parseOwnRules(text)
    expect(rules).toHaveLength(MAX_OWN_RULES)
    expect(problems.map((p) => p.line)).toEqual([MAX_OWN_RULES + 1])
  })

  it('writes each kind as an entry condition and reads it back', () => {
    for (const line of ['||ads.example.com^', 'nas.lan', '/^ad[0-9]+\\./', '@@||ok.example^', '@@_dmarc.example.com']) {
      const parsed = parseLine(line)
      if (parsed.kind !== 'rules') throw new Error(line)
      const rule = parsed.rules[0]!
      expect(ownRuleText(ownMatcher(rule.match), rule.allow)).toBe(line)
    }
    expect(ownMatcher({ kind: 'exact', value: 'a.b-c.example' })).toEqual({ type: 'domain_regex', value: '^a\\.b-c\\.example$' })
    expect(ownRuleText({ type: 'geo_site', value: 'cn' }, false)).toBeNull()
  })
})

it('says why a list line went unused', () => {
  expect(skipText({ reason: 'unsupported-modifier', modifier: 'dnstype' })).toBe('还不支持 $dnstype')
  expect(skipText({ reason: 'too-many-patterns' })).toContain('1000')
})

it('names a subscription by the suggested list or the link host', () => {
  expect(subscriptionName('https://big.oisd.nl/')).toBe('OISD big')
  expect(subscriptionName('https://lists.example.org/a/filter.txt')).toBe('lists.example.org')
})
