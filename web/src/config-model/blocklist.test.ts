import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkSubscriptionUrl, MAX_OWN_RULES, ownMatcher, ownRuleText, parseLine, parseOwnRules, shortName, skipText, subscriptionName, type Line } from './blocklist'

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
      { line: 5, text: '||x.example^$badfilter', problem: '这里用不上 $badfilter：要放行，写成 @@||x.example^' },
    ])
  })

  it('takes no more than the limit and points out the overflow once', () => {
    const text = Array.from({ length: MAX_OWN_RULES + 3 }, (_, i) => `||n${i}.example^`).join('\n')
    const { rules, problems } = parseOwnRules(text)
    expect(rules).toHaveLength(MAX_OWN_RULES)
    expect(problems).toEqual([{ line: MAX_OWN_RULES + 1, text: `||n${MAX_OWN_RULES}.example^`, problem: '从这一行起的 3\u00a0条没用上：自己写的规则最多 1,000\u00a0条，大列表请用订阅' }])
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

it('names a subscription by the suggested list, or by file name and host', () => {
  expect(subscriptionName('https://big.oisd.nl/')).toBe('OISD big')
  expect(subscriptionName('https://lists.example.org/a/filter.txt')).toBe('filter.txt\u00a0·\u00a0lists.example.org')
  expect(subscriptionName('https://lists.example.org/a/%E5%B9%BF%E5%91%8A.txt')).toBe('广告.txt\u00a0·\u00a0lists.example.org')
  expect(subscriptionName('https://lists.example.org/')).toBe('lists.example.org')
  // 已经写着主机的地方只用文件名；起过名的照原样 / Where the host is already given only the file name is used; a name of one's own stays
  expect(shortName(subscriptionName('https://lists.example.org/a/filter.txt'), 'https://lists.example.org/a/filter.txt')).toBe('filter.txt')
  expect(shortName('HaGeZi Light', 'https://lists.example.org/a/filter.txt')).toBe('HaGeZi Light')
})

it('checks a link to subscribe to as the server does', () => {
  expect(checkSubscriptionUrl('https://BIG.oisd.nl')).toEqual({ url: 'https://big.oisd.nl/' })
  expect(checkSubscriptionUrl('http://lists.example.org/a.txt')).toEqual({ problem: '链接只能用 https://' })
  expect(checkSubscriptionUrl('https://user:secret@lists.example.org/a.txt')).toEqual({ problem: '链接不能包含用户名或密码' })
  expect(checkSubscriptionUrl('lists.example.org/a.txt')).toEqual({ problem: '链接要写全，以 https:// 开头' })
  expect(checkSubscriptionUrl('https://exa mple.org/a.txt')).toEqual({ problem: '链接写得不对' })
  expect(checkSubscriptionUrl(`https://lists.example.org/${'a'.repeat(4100)}`)).toEqual({ problem: '链接过长' })
})
