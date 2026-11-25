import { describe, expect, it } from 'vitest'
import { effectiveOps, foldChain, forwardTarget, mergedForward, requestDecision, responseDecision, type KAction, type KMatcher } from './kernel'

// kernel.ts 照内核写的加载期语义。合并转发的几条照抄 kixdns d2b5fc3 config.rs 的 merged_forward_tests，内核自己的测试怎么说这里就怎么说
// The load-time semantics kernel.ts writes after the kernel. The merged-forward cases are copied from merged_forward_tests in kixdns
// d2b5fc3's config.rs: what the kernel's own tests say, these say

// 合并出的上游排好序（组里的先后内核不定） / The merged upstreams sorted (the kernel leaves the order within a group open)
const merged = (actions: KAction[], defaultUpstream = '1.1.1.1:53') => mergedForward(actions, defaultUpstream)?.slice().sort() ?? null
const forward = (upstream?: unknown, transport?: string): KAction => ({ type: 'forward', ...(upstream === undefined ? {} : { upstream }), ...(transport ? { transport } : {}) })

describe('没写上游的转发问默认上游（GlobalSettings::forward_target）', () => {
  it('不写、null、[] 都是没写；数组连成一串；空字符串不算没写', () => {
    expect([undefined, null, []].map((u) => forwardTarget(u, '9.9.9.9:53'))).toEqual(['9.9.9.9:53', '9.9.9.9:53', '9.9.9.9:53'])
    expect(forwardTarget(['1.1.1.1:53', 'tcp://8.8.8.8:53'], '9.9.9.9:53')).toBe('1.1.1.1:53,tcp://8.8.8.8:53')
    expect(forwardTarget('', '9.9.9.9:53')).toBe('')
  })
})

describe('作决定的动作（Rule::request_decision、Action::response_decision）', () => {
  it('请求阶段跳过 log 和 replace_txt_response，回答阶段跳过 log 和 forward', () => {
    const actions: KAction[] = [{ type: 'log' }, { type: 'replace_txt_response', text: ['t'] }, forward('1.1.1.1:53'), { type: 'continue' }]
    expect(requestDecision(actions)?.type).toBe('forward')
    expect(responseDecision(actions)?.type).toBe('replace_txt_response')
    expect(responseDecision([{ type: 'log' }, forward('1.1.1.1:53'), forward('8.8.8.8:53'), { type: 'continue' }])?.type).toBe('continue')
    expect(requestDecision([{ type: 'log' }])).toBeUndefined()
  })
})

describe('几个转发合成一次（Rule::merged_forward）', () => {
  it('没写上游的转发问默认上游，照它自己的传输读，和别的一起按传输去重', () => {
    expect(merged([forward(), forward([], 'tcp'), forward('192.0.2.1:53, 192.0.2.3:53')], '192.0.2.1:53, tcp://192.0.2.2:53'))
      .toEqual(['tcp://192.0.2.1:53', 'tcp://192.0.2.2:53', 'udp://192.0.2.1:53', 'udp://192.0.2.3:53'])
  })

  it('写在前面的 log、replace_txt_response 不挡着合并；前面有别的作决定的动作就不合并', () => {
    expect(merged([{ type: 'log' }, { type: 'replace_txt_response', text: 't' }, forward('1.1.1.1:53'), forward('8.8.8.8:53')])).toEqual(['udp://1.1.1.1:53', 'udp://8.8.8.8:53'])
    for (const first of [{ type: 'static_response', rcode: 'NXDOMAIN' }, { type: 'jump_to_pipeline', pipeline: 'p' }, { type: 'deny' }, { type: 'continue' }, { type: 'allow' }]) {
      expect(merged([first, forward('1.1.1.1:53'), forward('8.8.8.8:53')]), first.type).toBeNull()
    }
  })

  it('只有一个转发、或者一个地址也问不到时不合并', () => {
    expect(merged([forward('1.1.1.1:53')])).toBeNull()
    expect(merged([forward(''), forward(' , ')])).toBeNull()
    // 写成空的那个只是被跳过 / One written empty is only skipped
    expect(merged([forward(''), forward('8.8.8.8:53')])).toEqual(['udp://8.8.8.8:53'])
  })

  it('按传输分组：tcp、udp、tcp+udp、doh、dot、doq', () => {
    const list = mergedForward([
      forward('doq://192.0.2.6:853, dot://192.0.2.5:853'), forward('doh://dns.example/dns-query'), forward('192.0.2.3:53, 192.0.2.4:53', 'tcp_udp'),
      forward('udp://192.0.2.2:53, 192.0.2.7:53'), forward('tcp://192.0.2.1:53, tcp://192.0.2.8:53'),
    ], '1.1.1.1:53')!
    expect([...new Set(list.map((u) => u.split('://')[0]))]).toEqual(['tcp', 'udp', 'tcp+udp', 'doh', 'dot', 'doq'])
    expect([...list].sort()).toEqual([
      'doh://dns.example/dns-query', 'doq://192.0.2.6:853', 'dot://192.0.2.5:853', 'tcp+udp://192.0.2.3:53', 'tcp+udp://192.0.2.4:53', 'tcp://192.0.2.1:53',
      'tcp://192.0.2.8:53', 'udp://192.0.2.2:53', 'udp://192.0.2.7:53',
    ])
  })

  it('TCP 和 UDP 双发的只记一份；前缀不分大小写，别名归成一种写法', () => {
    expect(merged([forward('tcp+udp://192.0.2.1:53'), forward('udp+tcp://192.0.2.1:53'), forward('192.0.2.2:53', 'tcp_udp')])).toEqual(['tcp+udp://192.0.2.1:53', 'tcp+udp://192.0.2.2:53'])
    expect(merged([forward('TCP://192.0.2.1:53'), forward('Udp://192.0.2.2:53')])).toEqual(['tcp://192.0.2.1:53', 'udp://192.0.2.2:53'])
    expect(merged([forward('https://dns.example/q, tls://dns.example'), forward('doh://dns.example/q, quic://dns.example, dot://dns.example')]))
      .toEqual(['doh://dns.example/q', 'doq://dns.example', 'dot://dns.example'])
  })
})

describe('运算符的别名（MatchOperator）', () => {
  const m = (operator?: string): KMatcher => ({ type: 'x', ...(operator ? { operator } : {}) })
  it('not、and-not、andnot 是 and_not，or-not、ornot 是 or_not，规则级的也一样', () => {
    expect(effectiveOps([m(), m('not'), m('and-not'), m('andnot'), m('or-not'), m('ornot')], 'and')).toEqual(['and', 'and_not', 'and_not', 'and_not', 'or_not', 'or_not'])
    expect(effectiveOps([m(), m()], 'not')).toEqual(['and_not', 'and_not'])
    // 第一项真、第二项真：「或不是」不看第二项，「且不是」看了取反 / First true, second true: or-not skips the second, and-not negates it
    expect(foldChain([m(), m('or-not')], 'and', () => true)).toBe(true)
    expect(foldChain([m(), m('andnot')], 'and', () => true)).toBe(false)
    // 第一项假：「或不是」看第二项取反 / First false: or-not looks at the second, negated
    expect(foldChain([m(), m('ornot')], 'and', () => false)).toBe(true)
  })
})
