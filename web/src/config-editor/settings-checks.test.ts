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

// 每一项照内核的范围和相互关系说，说法写清要怎么改；哪些项不收和内核对得上，见 settings-kernel-fixtures.test.ts
// Each setting is told by the kernel's range and relations, saying what to write instead; which ones are refused matches the kernel,
// see settings-kernel-fixtures.test.ts
describe('设置的范围和相互关系', () => {
  const problem = (settings: Record<string, unknown>, key: string) => settingProblems(settings, WITH)[key]
  it('数字按内核的范围说，没写上限的是 u64', () => {
    expect(problem({ response_jump_limit: 65 }, 'response_jump_limit')).toBe('填 0 到 64 之间的整数')
    expect(problem({ cache_refresh_threshold_percent: 100 }, 'cache_refresh_threshold_percent')).toBe('填 0 到 99 之间的整数')
    expect(problem({ udp_pool_size: 1025 }, 'udp_pool_size')).toBe('填 1 到 1024 之间的整数')
    expect(problem({ cache_capacity: 0 }, 'cache_capacity')).toBe('填大于 0 的整数')
    expect(problem({ serve_stale_expire_ttl: -1 }, 'serve_stale_expire_ttl')).toBe('填 0 或更大的整数')
    expect(problem({ serve_stale_expire_ttl: 2 ** 64 }, 'serve_stale_expire_ttl')).toBe('填 0 或更大的整数')
    expect(problem({ serve_stale_expire_ttl: 2 ** 64 - 2048 }, 'serve_stale_expire_ttl')).toBeUndefined()
    expect(problem({ min_ttl: 1.5 }, 'min_ttl')).toBe('填 0 到 4294967295 之间的整数')
  })
  it('以前比内核严的放宽：刷新阈值到 99、可以是 0，旧结果的 TTL 和跳转上限可以是 0', () => {
    expect(settingProblems({ cache_refresh_threshold_percent: 0, serve_stale_ttl: 0, response_jump_limit: 0 }, WITH)).toEqual({})
    expect(settingProblems({ cache_refresh_threshold_percent: 99, response_jump_limit: 64 }, WITH)).toEqual({})
  })
  it('分片数要 0 或 2 到 65536 之间 2 的幂', () => {
    for (const shards of [1, 3, 131_072, 2.5]) expect(problem({ dashmap_shards: shards }, 'dashmap_shards'), String(shards)).toBe('填 0（自动），或者 2 到 65536 之间 2 的幂（2、4、8……）')
    for (const shards of [0, 2, 1024, 65_536]) expect(problem({ dashmap_shards: shards }, 'dashmap_shards'), String(shards)).toBeUndefined()
  })
  it('整体超时不能小于上游超时，没写上游超时按默认的 9000 比；自动的不比', () => {
    expect(problem({ upstream_timeout_ms: 2000, request_timeout_ms: 1000 }, 'request_timeout_ms')).toBe('不能小于上游超时（2000 毫秒）')
    expect(problem({ request_timeout_ms: 5000 }, 'request_timeout_ms')).toBe('不能小于上游超时（9000 毫秒）')
    expect(problem({ request_timeout_ms: null }, 'request_timeout_ms')).toBeUndefined()
    // 上游超时本身写错时只说它 / With the upstream timeout itself wrong only it is told
    expect(settingProblems({ upstream_timeout_ms: 0, request_timeout_ms: 0 }, WITH)).toEqual({ upstream_timeout_ms: '填大于 0 的整数' })
  })
  it('监听地址、DoH 路径、证书和私钥', () => {
    expect(problem({ bind_udp: 'localhost:53' }, 'bind_udp')).toBe('要写成「IP:端口」，比如 0.0.0.0:53 或 [::]:53')
    expect(problem({ doh_path: 'dns-query' }, 'doh_path')).toBe('要以 / 开头：不以它开头的路径谁也对不上，DoH 每个请求都回 404')
    expect(settingProblems({ bind_doh: '0.0.0.0:443' }, WITH)).toEqual({ doh_tls_cert: '写了 DoH 监听地址就要写证书', doh_tls_key: '写了 DoH 监听地址就要写私钥' })
  })
})
