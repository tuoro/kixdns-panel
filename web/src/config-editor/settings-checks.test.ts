import { describe, expect, it } from 'vitest'
import type { KernelConfig } from '../config-model/model'
import { CONFIG_BOOTSTRAP_V1 } from './schema'
import { hasBootstrap, hostNamedUpstream, settingProblems } from './settings-checks'

const WITH = [CONFIG_BOOTSTRAP_V1]

// 引导 DNS 照内核的 problems() 查：逗号分开、去掉空白和空的，每个都要是不带前缀的「IP:端口」，端口不为 0
// Bootstrap is checked as the kernel's problems() checks it: split by commas, trimmed, empty parts dropped, each a prefix-free 「IP:port」
// whose port is not 0
describe('引导 DNS 的写法', () => {
  it('IP 和端口都收，IPv6 带方括号，空的就是没写', () => {
    for (const bootstrap of ['223.5.5.5:53', '223.5.5.5:53, 119.29.29.29:53', '[2400:3200::1]:53', ' 223.5.5.5:53 , ', '', ' , ']) {
      expect(settingProblems({ bootstrap }, WITH), bootstrap).toEqual({})
    }
  })
  it('主机名、前缀、没写端口、端口 0、IPv4 前导零都不收，说出是哪一个', () => {
    // dns.google:53 是内核测试 problems_name_what_would_silently_do_something_else 里的那个 / dns.google:53 is the one in the kernel's test
    for (const [bootstrap, wrong] of [['223.5.5.5:53, dns.google:53', 'dns.google:53'], ['udp://223.5.5.5:53', 'udp://223.5.5.5:53'], ['223.5.5.5', '223.5.5.5'], ['223.5.5.5:0', '223.5.5.5:0'], ['223.005.5.5:53', '223.005.5.5:53'], ['2400:3200::1:53', '2400:3200::1:53']]) {
      expect(settingProblems({ bootstrap }, WITH).bootstrap, bootstrap).toBe(`「${wrong}」不是「IP:端口」：引导 DNS 只能写成 IP 和端口，比如 223.5.5.5:53`)
    }
  })
  it('内核不认引导 DNS 时，写了就说，空的也说；不知道内核认什么时只查写法', () => {
    for (const bootstrap of ['223.5.5.5:53', '']) {
      expect(settingProblems({ bootstrap }, []).bootstrap).toBe('当前内核不认引导 DNS：清空它，或者先把内核更新到最新')
    }
    expect(settingProblems({}, [])).toEqual({})
    expect(settingProblems({ bootstrap: '223.5.5.5:53' }, null)).toEqual({})
    expect(settingProblems({ bootstrap: 'dns.google:53' }, null).bootstrap).toContain('「dns.google:53」')
  })
  it('写了至少一个地址才算写了', () => {
    expect(hasBootstrap({ bootstrap: '223.5.5.5:53' })).toBe(true)
    expect(hasBootstrap({ bootstrap: ' , ' })).toBe(false)
    expect(hasBootstrap({})).toBe(false)
  })
})

// 没写引导 DNS、上游写成主机名时内核给一条 warning（host_names_without_bootstrap）：值和内核的测试
// a_named_upstream_without_bootstrap_is_a_warning 一样
// Without bootstrap an upstream written with a host name earns a kernel warning (host_names_without_bootstrap): the values are those of
// the kernel's test a_named_upstream_without_bootstrap_is_a_warning
describe('写成主机名的上游', () => {
  const config = (settings: Record<string, unknown>, actions: Record<string, unknown>[], answer: Record<string, unknown>[] = []): KernelConfig => ({
    version: '1.0', settings, pipeline_select: [],
    pipelines: [{ id: 'main', rules: [{ name: 'r', matchers: [{ type: 'any' }], matcher_operator: 'and', actions, response_matchers: [], response_matcher_operator: 'and', response_actions_on_match: [], response_actions_on_miss: answer }] }],
  })
  const udp = { default_upstream: '1.1.1.1:53' }
  const forward = (upstream: string) => [{ type: 'forward', upstream }]
  it('TCP、DoT、DoH、DoQ 写成主机名的都算，请求和回答阶段的转发都看', () => {
    for (const named of ['tcp://dns.example:53', 'tls://dns.example', 'https://dns.example/dns-query', 'quic://dns.example?sni=dns.example']) {
      expect(hostNamedUpstream(config(udp, forward(named))), named).toBe('dns.example')
      expect(hostNamedUpstream(config(udp, [{ type: 'allow' }], forward(named))), `${named} 回答阶段`).toBe('dns.example')
    }
  })
  it('默认上游也算；不写 upstream 的转发按它自己的传输连默认上游', () => {
    expect(hostNamedUpstream(config({ default_upstream: 'tls://dns.example' }, [{ type: 'allow' }]))).toBe('dns.example')
    expect(hostNamedUpstream(config({ default_upstream: 'dns.example:53' }, [{ type: 'forward', transport: 'tcp' }]))).toBe('dns.example')
    expect(hostNamedUpstream(config({ default_upstream: 'dns.example:53' }, [{ type: 'forward', upstream: '', transport: 'tcp' }]))).toBe('dns.example')
    // 经 UDP 问的只认 IP，没有要解析的名字 / Asked over UDP it takes IPs only, with no name to resolve
    expect(hostNamedUpstream(config({ default_upstream: 'dns.example:53' }, [{ type: 'allow' }]))).toBeNull()
  })
  it('都写成 IP 时没有', () => {
    for (const ip of ['1.1.1.1:53', 'tcp://1.1.1.1:53', 'tcp://[2606:4700::1111]:53', 'tls://1.1.1.1?sni=one.one.one.one', 'https://1.1.1.1/dns-query', 'https://[2606:4700::1111]/dns-query']) {
      expect(hostNamedUpstream(config(udp, forward(ip))), ip).toBeNull()
    }
  })
  it('一串上游里说第一个写成主机名的', () => {
    expect(hostNamedUpstream(config(udp, forward('1.1.1.1:53, tls://dns.alidns.com, https://doh.pub/dns-query')))).toBe('dns.alidns.com')
  })
})
