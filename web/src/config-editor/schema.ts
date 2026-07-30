import type { GlobalSettings, MatcherScope } from './types'

export type SettingFieldType = 'text' | 'number' | 'boolean' | 'csv' | 'list'

export interface SettingField {
  key: string
  label: string
  type: SettingFieldType
  placeholder?: string
  title?: string
  min?: number
  max?: number
  nullable?: boolean
  wide?: boolean
  visibleWhen?: string
  visibleWhenAny?: string[]
}

export interface SettingSection {
  id: string
  title: string
  tone: 'green' | 'amber' | 'red' | 'ink'
  fields: SettingField[]
}

export interface SelectOption {
  value: string
  label: string
}

export interface MatcherDefinition extends SelectOption {
  fields: Array<'value' | 'cidr' | 'expect' | 'country_codes' | 'mode'>
}

export const SETTING_SECTIONS: SettingSection[] = [
  {
    id: 'network',
    title: '基础与监听',
    tone: 'green',
    fields: [
      { key: 'bind_udp', label: 'UDP 监听地址', type: 'text', placeholder: '0.0.0.0:5353' },
      { key: 'bind_tcp', label: 'TCP 监听地址', type: 'text', placeholder: '0.0.0.0:5353' },
      { key: 'bind_doh', label: 'DoH 监听地址', type: 'text', placeholder: '留空禁用 DoH' },
      { key: 'doh_path', label: 'DoH 查询路径', type: 'text', placeholder: '/dns-query' },
      { key: 'doh_tls_cert', label: 'DoH TLS 证书', type: 'text', placeholder: '/path/to/cert.pem', wide: true },
      { key: 'doh_tls_key', label: 'DoH TLS 私钥', type: 'text', placeholder: '/path/to/key.pem', wide: true },
      { key: 'default_upstream', label: '默认上游', type: 'text', placeholder: '1.1.1.1:53', wide: true },
      { key: 'min_ttl', label: '最小 TTL', type: 'number', min: 0, placeholder: '0' },
      { key: 'upstream_timeout_ms', label: '上游超时 (ms)', type: 'number', min: 1, placeholder: '2000' },
      { key: 'request_timeout_ms', label: '整体请求超时 (ms)', type: 'number', min: 1, nullable: true, placeholder: '自动计算' },
      { key: 'response_jump_limit', label: '响应跳转上限', type: 'number', min: 1, placeholder: '10' },
      { key: 'enable_tcp_fallback', label: 'TCP Fallback', type: 'boolean', title: 'UDP 失败后自动改用 TCP' },
    ],
  },
  {
    id: 'transport',
    title: '连接与传输',
    tone: 'ink',
    fields: [
      { key: 'udp_pool_size', label: 'UDP 连接池', type: 'number', min: 1, placeholder: '64' },
      { key: 'tcp_pool_size', label: 'TCP 连接池', type: 'number', min: 1, placeholder: '64' },
      { key: 'doh_pool_size', label: 'DoH 连接池', type: 'number', min: 1, placeholder: '8' },
      { key: 'dot_pool_size', label: 'DoT 连接池', type: 'number', min: 1, placeholder: '64' },
      { key: 'doq_pool_size', label: 'DoQ 连接池', type: 'number', min: 1, placeholder: '16' },
      { key: 'tcp_health_check_error_threshold', label: 'TCP 错误阈值', type: 'number', min: 0, placeholder: '3' },
      { key: 'tcp_connection_max_age_seconds', label: 'TCP 最大存活 (s)', type: 'number', min: 0, placeholder: '300' },
      { key: 'tcp_connection_idle_timeout_seconds', label: 'TCP 空闲超时 (s)', type: 'number', min: 0, placeholder: '60' },
      { key: 'doq_connection_idle_timeout_seconds', label: 'DoQ 空闲超时 (s)', type: 'number', min: 0, placeholder: '60' },
      { key: 'doq_keepalive_interval_ms', label: 'DoQ Keepalive (ms)', type: 'number', min: 0, placeholder: '15000' },
      { key: 'doq_enable_0rtt', label: 'DoQ 0-RTT', type: 'boolean', title: '允许 DoQ 连接使用 0-RTT' },
    ],
  },
  {
    id: 'cache',
    title: '缓存与后台刷新',
    tone: 'amber',
    fields: [
      { key: 'cache_capacity', label: '缓存容量', type: 'number', min: 1, placeholder: '10000' },
      { key: 'cache_max_ttl', label: '缓存最大 TTL (s)', type: 'number', min: 1, placeholder: '86400' },
      { key: 'dashmap_shards', label: 'DashMap Shards', type: 'number', min: 0, placeholder: '0（自动）' },
      { key: 'cache_background_refresh', label: '后台刷新', type: 'boolean' },
      { key: 'cache_refresh_threshold_percent', label: '刷新阈值 (%)', type: 'number', min: 1, max: 90, placeholder: '10', visibleWhen: 'cache_background_refresh' },
      { key: 'cache_refresh_min_ttl', label: '刷新最小 TTL (s)', type: 'number', min: 0, placeholder: '5', visibleWhen: 'cache_background_refresh' },
    ],
  },
  {
    id: 'stale',
    title: '过期缓存',
    tone: 'red',
    fields: [
      { key: 'serve_stale', label: '服务过期响应', type: 'boolean' },
      { key: 'serve_stale_ttl', label: '回复 TTL (s)', type: 'number', min: 1, placeholder: '30', visibleWhen: 'serve_stale' },
      { key: 'serve_stale_expire_ttl', label: '服务窗口 (s)', type: 'number', min: 0, placeholder: '86400', visibleWhen: 'serve_stale' },
      { key: 'serve_stale_ttl_reset', label: '重置过期 TTL', type: 'boolean', visibleWhen: 'serve_stale' },
      { key: 'serve_stale_client_timeout_ms', label: '客户端等待 (ms)', type: 'number', min: 0, placeholder: '0', visibleWhen: 'serve_stale' },
    ],
  },
  {
    id: 'flow-control',
    title: '自适应流量控制',
    tone: 'green',
    fields: [
      { key: 'flow_control_enabled', label: '启用流控', type: 'boolean' },
      { key: 'flow_control_initial_permits', label: '初始许可数', type: 'number', min: 1, placeholder: '500', visibleWhen: 'flow_control_enabled' },
      { key: 'flow_control_min_permits', label: '最小许可数', type: 'number', min: 1, placeholder: '100', visibleWhen: 'flow_control_enabled' },
      { key: 'flow_control_max_permits', label: '最大许可数', type: 'number', min: 1, placeholder: '800', visibleWhen: 'flow_control_enabled' },
      { key: 'flow_control_latency_threshold_ms', label: '延迟阈值 (ms)', type: 'number', min: 1, placeholder: '100', visibleWhen: 'flow_control_enabled' },
      { key: 'flow_control_adjustment_interval_secs', label: '调整间隔 (s)', type: 'number', min: 1, placeholder: '5', visibleWhen: 'flow_control_enabled' },
    ],
  },
  {
    id: 'statistics',
    title: '查询统计',
    tone: 'ink',
    fields: [
      { key: 'statistics_enabled', label: '启用查询排行', type: 'boolean', title: '在内存中统计客户端和请求域名排行' },
      { key: 'statistics_anonymize_client_ip', label: '客户端 IP 脱敏', type: 'boolean', title: 'IPv4 按 /24、IPv6 按 /64 聚合', visibleWhen: 'statistics_enabled' },
    ],
  },
]

export const MATCH_OPERATORS: SelectOption[] = [
  { value: 'and', label: 'AND' },
  { value: 'or', label: 'OR' },
  { value: 'and_not', label: 'AND NOT' },
  { value: 'or_not', label: 'OR NOT' },
  { value: 'not', label: 'NOT' },
]

const SELECTOR_MATCHERS: MatcherDefinition[] = [
  { value: 'listener_label', label: '监听标签', fields: ['value'] },
  { value: 'client_ip', label: '客户端 IP', fields: ['cidr'] },
  { value: 'domain_suffix', label: '域名后缀', fields: ['value'] },
  { value: 'domain_regex', label: '域名正则', fields: ['value'] },
  { value: 'any', label: '任意', fields: [] },
  { value: 'qclass', label: 'QClass', fields: ['value'] },
  { value: 'edns_present', label: '存在 EDNS', fields: ['expect'] },
  { value: 'geo_site', label: 'GeoSite', fields: ['value'] },
  { value: 'geo_site_not', label: '非 GeoSite', fields: ['value'] },
  { value: 'geoip_country', label: 'GeoIP 国家', fields: ['country_codes'] },
  { value: 'geoip_private', label: 'GeoIP 私网', fields: ['expect'] },
  { value: 'qtype', label: 'QType', fields: ['value'] },
]

const REQUEST_MATCHERS: MatcherDefinition[] = SELECTOR_MATCHERS.filter((item) => item.value !== 'listener_label')

const RESPONSE_MATCHERS: MatcherDefinition[] = [
  { value: 'upstream_equals', label: '上游等于', fields: ['value'] },
  { value: 'request_domain_suffix', label: '请求域名后缀', fields: ['value'] },
  { value: 'request_domain_regex', label: '请求域名正则', fields: ['value'] },
  { value: 'response_type', label: '响应类型', fields: ['value'] },
  { value: 'response_rcode', label: '响应 RCode', fields: ['value'] },
  { value: 'response_qclass', label: '响应 QClass', fields: ['value'] },
  { value: 'response_edns_present', label: '响应含 EDNS', fields: ['expect'] },
  { value: 'response_upstream_ip', label: '上游 IP', fields: ['cidr'] },
  { value: 'response_answer_ip', label: '应答 IP', fields: ['cidr'] },
  { value: 'response_answer_ip_geoip_country', label: '应答 IP 国家', fields: ['country_codes'] },
  { value: 'response_answer_ip_geoip_private', label: '应答 IP 私网', fields: ['expect'] },
  { value: 'response_request_domain_geosite', label: '请求域名 GeoSite', fields: ['value'] },
  { value: 'response_request_domain_geosite_not', label: '请求域名非 GeoSite', fields: ['value'] },
  { value: 'response_txt_content', label: 'TXT 内容', fields: ['mode', 'value'] },
]

export const MATCHER_DEFINITIONS: Record<MatcherScope, MatcherDefinition[]> = {
  selector: SELECTOR_MATCHERS,
  request: REQUEST_MATCHERS,
  response: RESPONSE_MATCHERS,
}

export const ACTION_TYPES: SelectOption[] = [
  { value: 'log', label: '记录日志' },
  { value: 'static_response', label: '固定 RCode' },
  { value: 'static_ip_response', label: '固定 IP' },
  { value: 'static_txt_response', label: '固定 TXT' },
  { value: 'replace_txt_response', label: '替换 TXT' },
  { value: 'jump_to_pipeline', label: '跳转 Pipeline' },
  { value: 'allow', label: '允许' },
  { value: 'deny', label: '拒绝' },
  { value: 'forward', label: '转发' },
  { value: 'continue', label: '继续匹配' },
]

export const QTYPE_OPTIONS = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'PTR', 'SOA', 'SRV', 'OPT']
export const TRANSPORT_OPTIONS = ['udp', 'tcp', 'tcp_udp', 'doh', 'dot', 'doq']

export function settingVisible(field: SettingField, settings: GlobalSettings): boolean {
  if (field.visibleWhen && !settings[field.visibleWhen]) return false
  if (field.visibleWhenAny && !field.visibleWhenAny.some((key) => Boolean(settings[key]))) return false
  return true
}
