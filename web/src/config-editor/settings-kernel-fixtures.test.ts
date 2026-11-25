import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CONFIG_BOOTSTRAP_V1, RETIRED_SETTINGS } from './schema'
import { hostNamedUpstream, settingProblems } from './settings-checks'
import type { KernelConfig } from '../config-model/model'

// 设置页说不收的、和内核说不收的一一对上：每一行是一份设置和页面认为有问题的那几项。这里先断言页面这样说；CI 里设了
// KERNEL_SETTINGS_FIXTURES 时把它们写成一个 JSON 数组，tools/kernel-config-check 拿最新的内核（main）逐份校验，内核拒的原因里说到的
// 设置要正好是这几项（没有问题的要收下）。没写引导 DNS 时的主机名上游也一样，对的是内核的警告。值尽量用内核测试里的那一组
// （settings_errors_start_with_the_setting_and_its_value、validate_rejects_configs_the_server_cannot_bind、
// settings_over_their_limits_start_held_to_them、a_named_upstream_without_bootstrap_is_a_warning）
// What the settings page refuses matches what the kernel refuses one for one: each row is a set of settings with the ones the page
// finds wrong. The page is asserted to say so here; with KERNEL_SETTINGS_FIXTURES set (in CI) the rows are written as one JSON array,
// and tools/kernel-config-check checks each with the latest kernel (main): the settings its reasons speak of must be exactly these
// (one with none must be accepted). Host-named upstreams without bootstrap likewise, against the kernel's warning. The values are those
// of the kernel's tests where they can be

const ALL = [CONFIG_BOOTSTRAP_V1]
type Row = [name: string, settings: Record<string, unknown>, refused: string[]]

const ROWS: Row[] = [
  ['默认值', {}, []],
  // 监听地址 / Listen addresses
  ['UDP 写成主机名', { bind_udp: 'localhost:53' }, ['bind_udp']],
  ['TCP 没写端口', { bind_tcp: '0.0.0.0' }, ['bind_tcp']],
  ['TCP 不是 IP', { bind_tcp: '999.999.999.999:53' }, ['bind_tcp']],
  ['UDP 端口超出', { bind_udp: '127.0.0.1:99999' }, ['bind_udp']],
  ['UDP 带前缀', { bind_udp: 'udp://0.0.0.0:53' }, ['bind_udp']],
  ['UDP 前面有空格', { bind_udp: ' 0.0.0.0:53' }, ['bind_udp']],
  ['监听端口 0 内核收', { bind_udp: '127.0.0.1:0', bind_tcp: '[::]:0' }, []],
  ['IPv6 监听', { bind_udp: '[::]:53', bind_tcp: '[::1]:5353' }, []],
  ['DoH 地址写错，证书私钥都有', { bind_doh: ':443', doh_tls_cert: 'c.pem', doh_tls_key: 'k.pem' }, ['bind_doh']],
  ['DoH 没写证书', { bind_doh: '0.0.0.0:443', doh_tls_key: 'k.pem' }, ['doh_tls_cert']],
  ['DoH 没写私钥', { bind_doh: '0.0.0.0:443', doh_tls_cert: 'c.pem' }, ['doh_tls_key']],
  ['DoH 都没写', { bind_doh: '127.0.0.1:8443' }, ['doh_tls_cert', 'doh_tls_key']],
  ['DoH 地址写错又没证书', { bind_doh: '::not::an::ip::' }, ['bind_doh', 'doh_tls_cert', 'doh_tls_key']],
  ['DoH 齐全', { bind_doh: '127.0.0.1:8443', doh_tls_cert: 'c.pem', doh_tls_key: 'k.pem' }, []],
  ['DoH 关着', { bind_doh: null }, []],
  ['证书路径写成空的也算写了', { bind_doh: '127.0.0.1:8443', doh_tls_cert: '', doh_tls_key: '' }, []],
  ['DoH 路径不以 / 开头', { doh_path: 'dns-query' }, ['doh_path']],
  ['DoH 路径', { doh_path: '/secret-path' }, []],
  // 数字的范围 / Number ranges
  ['缓存容量 0', { cache_capacity: 0 }, ['cache_capacity']],
  ['缓存最大 TTL 0', { cache_max_ttl: 0 }, ['cache_max_ttl']],
  ['上游超时 0', { upstream_timeout_ms: 0 }, ['upstream_timeout_ms']],
  ['刷新阈值 100', { cache_refresh_threshold_percent: 100 }, ['cache_refresh_threshold_percent']],
  ['刷新阈值 99 和 0', { cache_refresh_threshold_percent: 99 }, []],
  ['刷新阈值 0', { cache_refresh_threshold_percent: 0 }, []],
  ['分片 3', { dashmap_shards: 3 }, ['dashmap_shards']],
  ['分片 1', { dashmap_shards: 1 }, ['dashmap_shards']],
  ['分片 131072', { dashmap_shards: 131_072 }, ['dashmap_shards']],
  ['分片 0、2、65536', { dashmap_shards: 65_536 }, []],
  ['分片 2', { dashmap_shards: 2 }, []],
  ['连接池超过 1024', { tcp_pool_size: 2048, dot_pool_size: 1025 }, ['dot_pool_size', 'tcp_pool_size']],
  ['连接池 1024', { udp_pool_size: 1024, tcp_pool_size: 1024, doh_pool_size: 1024, dot_pool_size: 1024, doq_pool_size: 1024 }, []],
  ['跳转上限 65', { response_jump_limit: 65 }, ['response_jump_limit']],
  ['跳转上限五百万', { response_jump_limit: 5_000_000 }, ['response_jump_limit']],
  ['跳转上限 64 和 0', { response_jump_limit: 64 }, []],
  ['跳转上限 0', { response_jump_limit: 0 }, []],
  ['旧结果 TTL 0', { serve_stale_ttl: 0 }, []],
  ['DoQ 空闲超时 QUIC 装得下的最大值', { doq_connection_idle_timeout_seconds: 4_611_686_018_427_387 }, []],
  ['DoQ 空闲超时 QUIC 装不下', { doq_connection_idle_timeout_seconds: 4_611_686_018_427_388 }, ['doq_connection_idle_timeout_seconds']],
  // 相互关系：没写上游超时按默认的 9000 比 / How they relate: an unset upstream timeout compares as the default 9000
  ['整体超时比上游超时短', { upstream_timeout_ms: 2000, request_timeout_ms: 1000 }, ['request_timeout_ms']],
  ['整体超时比默认的上游超时短', { request_timeout_ms: 5000 }, ['request_timeout_ms']],
  ['整体超时等于上游超时', { upstream_timeout_ms: 2000, request_timeout_ms: 2000 }, []],
  ['整体超时自动', { request_timeout_ms: null }, []],
  // 整数类型：读配置时就不收，没有逐条的原因，所以一行只放一项 / Integer types: refused as the config is read, with no reasons one by one,
  // so one setting a row
  ['最小 TTL 是小数', { min_ttl: 1.5 }, ['min_ttl']],
  ['最小 TTL 是负数', { min_ttl: -1 }, ['min_ttl']],
  ['最小 TTL 超出 u32', { min_ttl: 4_294_967_296 }, ['min_ttl']],
  ['最小 TTL u32 最大值', { min_ttl: 4_294_967_295 }, []],
  ['缓存容量写成空', { cache_capacity: null }, ['cache_capacity']],
  ['刷新阈值超出 u8', { cache_refresh_threshold_percent: 256 }, ['cache_refresh_threshold_percent']],
  // 引导 DNS（内核测试里的 dns.google:53） / Bootstrap (dns.google:53 from the kernel's test)
  ['引导 DNS', { bootstrap: '223.5.5.5:53, [2400:3200::1]:53' }, []],
  ['引导 DNS 写成空的', { bootstrap: ' , ' }, []],
  ['引导 DNS 里有主机名', { bootstrap: '223.5.5.5:53, dns.google:53' }, ['bootstrap']],
  ['引导 DNS 带前缀', { bootstrap: 'udp://223.5.5.5:53' }, ['bootstrap']],
  ['引导 DNS 端口 0', { bootstrap: '223.5.5.5:0' }, ['bootstrap']],
  ['几项一起', { cache_capacity: 0, doh_path: 'x', response_jump_limit: 99, bind_doh: '0.0.0.0:443' }, ['cache_capacity', 'doh_path', 'doh_tls_cert', 'doh_tls_key', 'response_jump_limit']],
]

// 没写引导 DNS 时的主机名上游（内核的值）：转发动作的上游，和它会不会让内核警告
// Host-named upstreams without bootstrap (the kernel's values): a forward's upstream, and whether the kernel warns of it
const NAMED: [upstream: string, warned: boolean][] = [
  ['tcp://dns.example:53', true], ['tls://dns.example', true], ['https://dns.example/dns-query', true], ['quic://dns.example?sni=dns.example', true],
  ['1.1.1.1:53', false], ['tcp://1.1.1.1:53', false], ['tcp://[2606:4700::1111]:53', false], ['tls://1.1.1.1?sni=one.one.one.one', false],
  ['https://1.1.1.1/dns-query', false], ['https://[2606:4700::1111]/dns-query', false],
]
const forwarding = (upstream: string): KernelConfig => ({
  version: '1.0', settings: { default_upstream: '1.1.1.1:53' }, pipeline_select: [],
  pipelines: [{ id: 'main', rules: [{ name: 'r', matchers: [{ type: 'any' }], matcher_operator: 'and', actions: [{ type: 'forward', upstream }], response_matchers: [], response_matcher_operator: 'and', response_actions_on_match: [], response_actions_on_miss: [] }] }],
})

describe('设置的检查和内核一一对上', () => {
  it.each(ROWS)('%s', (_name, settings, refused) => {
    expect(Object.keys(settingProblems(settings, ALL)).sort()).toEqual([...refused].sort())
  })
  it.each(NAMED)('上游 %s：没写引导 DNS 时内核警告 %s', (upstream, warned) => {
    expect(hostNamedUpstream(forwarding(upstream)) !== null).toBe(warned)
  })
  // 退役的旧设置：内核照常收下，每一项警告一次，正好是面板一键清掉的那几项 / Retired settings: the kernel accepts them with one
  // warning each, exactly the ones the panel clears in one go
  const retired = Object.fromEntries(RETIRED_SETTINGS.map((key) => [key, 1]))
  it('交给真内核校验', () => {
    const out = process.env.KERNEL_SETTINGS_FIXTURES
    if (!out) return
    const fixtures = [
      ...ROWS.map(([name, settings, refused]) => ({ name, config: { settings }, ...(refused.length ? { refuses: refused.map((key) => `settings.${key}`) } : {}) })),
      ...NAMED.map(([upstream, warned]) => ({ name: `上游 ${upstream}`, config: forwarding(upstream), warns: warned ? ['settings.bootstrap'] : [] })),
      { name: '退役的旧设置', config: { settings: retired }, warns: RETIRED_SETTINGS.map((key) => `settings.${key}`) },
    ]
    writeFileSync(out, JSON.stringify(fixtures))
  })
})
