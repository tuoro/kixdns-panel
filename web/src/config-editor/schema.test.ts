import { describe, expect, it } from 'vitest'
import { SETTING_SECTIONS, settingName, settingNames, settingValues } from './schema'

// 查询排行一直开着、客户端地址照原样记：基础设置里没有这两个开关
// Rankings are always on with whole client addresses: the settings carry neither switch
describe('查询排行没有开关', () => {
  it('基础设置里没有统计和脱敏', () => {
    const keys = SETTING_SECTIONS.flatMap((section) => section.fields.map((field) => field.key))
    expect(keys).not.toContain('statistics_enabled')
    expect(keys).not.toContain('statistics_anonymize_client_ip')
  })
})

describe('高级规则的选项说面板的话', () => {
  // 允许留下的英文：协议、记录类型、响应码这些本来就这么叫的 / English allowed to stay: names that are spelled this way anyway
  const ALLOWED = new Set(['GeoSite', 'GeoIP', 'EDNS', 'TXT', 'CNAME', 'REFUSED', 'NXDOMAIN', 'TTL', 'MMDB', 'DAT'])
  it('条件、动作、组合方式的名字里没有内核的英文', async () => {
    const { ACTION_TYPES, MATCHER_DEFINITIONS, MATCH_OPERATORS } = await import('./schema')
    const labels = [...ACTION_TYPES, ...MATCH_OPERATORS, ...Object.values(MATCHER_DEFINITIONS).flat()].map((item) => item.label)
    const english = labels.flatMap((label) => label.match(/[A-Za-z]{3,}/g) ?? []).filter((word) => !ALLOWED.has(word))
    expect(english).toEqual([])
  })
})

describe('提示条里的设置名', () => {
  it('用表单里的名字、去掉单位；只能在 JSON 里改的照表单的叫法起名', () => {
    expect(settingName('tcp_connection_max_age_seconds')).toBe('TCP 最大存活')
    expect(settingName('doh_health_check_error_threshold')).toBe('DoH 错误阈值')
    expect(settingName('some_future_setting')).toBe('some_future_setting')
  })
  it('三个以内都写出来，再多写前三个和一共几项；一个名字里不断行', () => {
    expect(settingNames(['bind_udp', 'cache_capacity'])).toBe('UDP\u00a0监听地址、缓存容量')
    expect(settingNames(['bind_udp', 'bind_tcp', 'cache_capacity', 'tcp_pool_size']))
      .toBe('UDP\u00a0监听地址、TCP\u00a0监听地址、TCP\u00a0连接池等\u00a04\u00a0项')
  })
  it('按表单里的先后排；自动限流那几项合成一项；确认框全写', () => {
    // 内核的顺序是证书、私钥、路径，表单里路径在前 / The kernel lists cert, key, path; the form has the path first
    expect(settingNames(['doh_tls_cert', 'doh_tls_key', 'doh_path'])).toBe('DoH\u00a0查询路径、DoH\u00a0TLS\u00a0证书、DoH\u00a0TLS\u00a0私钥')
    expect(settingNames(['flow_control_latency_threshold_ms', 'bind_udp', 'flow_control_enabled'])).toBe('UDP\u00a0监听地址、自动限流')
    const five = ['bind_udp', 'bind_tcp', 'cache_capacity', 'tcp_pool_size', 'doq_pool_size']
    expect(settingNames(five, { all: true })).toBe('UDP\u00a0监听地址、TCP\u00a0监听地址、TCP\u00a0连接池、DoQ\u00a0连接池、缓存容量')
  })
  it('退回时写出每一项改回的值，带单位；没写的照表单说默认是什么；自动限流合成一项', () => {
    expect(settingValues({ bind_udp: '0.0.0.0:53', cache_capacity: null, doq_keepalive_interval_ms: 15000, doq_enable_0rtt: null, bind_doh: null, dashmap_shards: null }))
      .toBe('UDP\u00a0监听地址 0.0.0.0:53、DoH\u00a0监听地址 留空、DoQ\u00a0保活间隔 15000\u00a0毫秒、DoQ\u00a00-RTT 默认开启、缓存容量 默认\u00a010000\u00a0条、缓存分片数 自动')
    expect(settingValues({ flow_control_enabled: null, flow_control_max_permits: 512 })).toBe('自动限流 关闭')
    expect(settingValues({ flow_control_max_permits: 512 })).toBe('自动限流的几项数值')
    expect(settingValues({ doh_health_check_error_threshold: null })).toBe('DoH\u00a0错误阈值 默认值')
  })
})
