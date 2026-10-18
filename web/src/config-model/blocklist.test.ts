import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkSubscriptionUrl, coversOnly, defaultNameDepth, isDefaultName, uniqueSubscriptionName, MAX_OWN_RULES, ownBlocksFor, ownMatcher, ownRuleText, parseLine, parseOwnRules, shortName, skipText, subscriptionName, type Line } from './blocklist'

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

  it('writes out the rule meant by a $badfilter line, without modifiers', () => {
    const { problems } = parseOwnRules('@@||h.example^$badfilter\n||i.example^$important,badfilter')
    expect(problems.map((p) => p.problem)).toEqual([
      '这里用不上 $badfilter：要拦下它，写成 ||h.example^',
      '这里用不上 $badfilter：要放行，写成 @@||i.example^',
    ])
  })

  it('finds every own line blocking a name, and whether one is about exactly that name', () => {
    const text = '||ads.example.net^\nok.ads.example.net\n@@||allowed.example^\n||x.allowed.example^'
    expect(ownBlocksFor(text, 'ok.ads.example.net').map((r) => r.line)).toEqual([1, 2])
    expect(coversOnly(ownBlocksFor(text, 'ok.ads.example.net')[0]!.match, 'ok.ads.example.net')).toBe(false)
    expect(coversOnly(ownBlocksFor(text, 'OK.ads.example.net.')[1]!.match, 'OK.ads.example.net.')).toBe(true)
    // 自己写的放行管着它时，自己写的拦截拦不下 / With an own allow covering it, no own block stops it
    expect(ownBlocksFor(text, 'x.allowed.example')).toEqual([])
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
  expect(skipText({ reason: 'browser-modifier', modifier: 'third-party' })).toBe('$third-party 只对浏览器有用，DNS 用不上')
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
  // 和已有的默认名重名时带上最后一级目录，正文里也带着 / A taken default name carries its last directory, in prose too
  const second = subscriptionName('https://lists.example.org/fail/filter.txt', 2)
  expect(second).toBe('fail/filter.txt\u00a0·\u00a0lists.example.org')
  expect(shortName(second, 'https://lists.example.org/fail/filter.txt')).toBe('fail/filter.txt')
})

it('makes a default name unique: directories one level at a time, then the query string, then a number', () => {
  const j = '\u00a0·\u00a0'
  const taken = (...names: string[]) => new Set(names)
  // 最后一级目录也一样（GitHub raw 常见）：再往上带一级 / The last directory alike too (common on GitHub raw): one more level up
  const third = 'https://raw.githubusercontent.com/c/repo/master/hosts'
  expect(uniqueSubscriptionName(third, taken(`hosts${j}raw.githubusercontent.com`, `master/hosts${j}raw.githubusercontent.com`))).toBe(`repo/master/hosts${j}raw.githubusercontent.com`)
  // 只有查询串不同 / Only the query differs
  expect(uniqueSubscriptionName('https://h.example/list.txt?type=ads', taken(`list.txt${j}h.example`))).toBe(`list.txt?type=ads${j}h.example`)
  // 根目录下的同名文件：没有目录可带，加编号；编号在「·」前面，正文里也带着 / A same-named file at the root: no directory to add, so a number, before 「·」 so prose
  // keeps it
  const numbered = uniqueSubscriptionName('https://h.example/hosts.txt', taken(`hosts.txt${j}h.example`))
  expect(numbered).toBe(`hosts.txt (2)${j}h.example`)
  expect(shortName(numbered, 'https://h.example/hosts.txt')).toBe('hosts.txt (2)')
  expect(defaultNameDepth(numbered, 'https://h.example/hosts.txt')).toBe(1)
  expect(defaultNameDepth(`repo/master/hosts${j}raw.githubusercontent.com`, third)).toBe(3)
  expect(isDefaultName('HaGeZi Light', third)).toBe(false)
})

it('checks a link to subscribe to as the server does', () => {
  expect(checkSubscriptionUrl('https://BIG.oisd.nl')).toEqual({ url: 'https://big.oisd.nl/' })
  expect(checkSubscriptionUrl('http://lists.example.org/a.txt')).toEqual({ problem: '链接只能用 https://' })
  expect(checkSubscriptionUrl('https://user:secret@lists.example.org/a.txt')).toEqual({ problem: '链接不能包含用户名或密码' })
  expect(checkSubscriptionUrl('lists.example.org/a.txt')).toEqual({ problem: '链接要写全，以 https:// 开头' })
  expect(checkSubscriptionUrl('https://exa mple.org/a.txt')).toEqual({ problem: '链接写得不对' })
  expect(checkSubscriptionUrl(`https://lists.example.org/${'a'.repeat(4100)}`)).toEqual({ problem: '链接过长' })
})
