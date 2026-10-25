import type { GlobalSettings, MatcherScope } from './types'

export type SettingFieldType = 'text' | 'number' | 'boolean' | 'csv' | 'list'

export interface SettingField {
  key: string
  label: string
  type: SettingFieldType
  // 内核的默认值（锁定的内核提交里 config.rs 的 default_*）：没写这一项时内核按它跑。开关没写时按它画，占位写「默认 …」。
  // The kernel's default (config.rs default_* at the locked commit), what the kernel runs with when the key is absent.
  // An unset switch is drawn in this position and the placeholder says 「默认 …」.
  default?: boolean | number | string
  // 没有默认值时给的一个例子，占位写「如 …」 / An example for a field without a default; the placeholder says 「如 …」
  example?: string
  placeholder?: string
  title?: string
  unit?: string
  min?: number
  max?: number
  nullable?: boolean
  wide?: boolean
  visibleWhen?: string
  visibleWhenAny?: string[]
}

export const CONFIG_STATIC_CNAME_RESPONSE_V1 = 'config_static_cname_response_v1'

export interface SettingSection {
  id: string
  title: string
  description: string
  tone: 'green' | 'amber' | 'red' | 'ink'
  fields: SettingField[]
}

export interface SelectOption {
  value: string
  label: string
}

export interface ActionDefinition extends SelectOption {
  requiresCapability?: string
}

export interface MatcherDefinition extends SelectOption {
  fields: Array<'value' | 'cidr' | 'expect' | 'country_codes' | 'mode'>
}

export const SETTING_SECTIONS: SettingSection[] = [
  {
    id: 'network',
    title: '基础与监听',
    description: '监听地址和请求超时',
    tone: 'green',
    fields: [
      { key: 'bind_udp', label: 'UDP 监听地址', type: 'text', default: '0.0.0.0:5353' },
      { key: 'bind_tcp', label: 'TCP 监听地址', type: 'text', default: '0.0.0.0:5353' },
      { key: 'bind_doh', label: 'DoH 监听地址', type: 'text', placeholder: '留空禁用 DoH' },
      { key: 'doh_path', label: 'DoH 查询路径', type: 'text', default: '/dns-query' },
      { key: 'doh_tls_cert', label: 'DoH TLS 证书', type: 'text', example: '/path/to/cert.pem', wide: true },
      { key: 'doh_tls_key', label: 'DoH TLS 私钥', type: 'text', example: '/path/to/key.pem', wide: true },
      // 只有带高级规则时才显示（其余时候由「其余请求」决定）：说清它管的是哪些请求 / Shown only with advanced rules (otherwise 其余请求 decides it): say which requests it serves
      { key: 'default_upstream', label: '默认上游', type: 'text', default: '1.1.1.1:53', wide: true, title: '高级规则里「交给默认上游」和没写地址的转发用这里的地址，多个用逗号隔开' },
      { key: 'min_ttl', label: '最小 TTL', type: 'number', min: 0, unit: '秒', default: 0 },
      { key: 'upstream_timeout_ms', label: '上游超时 (ms)', type: 'number', min: 1, unit: '毫秒', default: 9000 },
      { key: 'request_timeout_ms', label: '整体请求超时 (ms)', type: 'number', min: 1, unit: '毫秒', nullable: true, placeholder: '自动计算' },
      { key: 'response_jump_limit', label: '回答后改问次数上限', type: 'number', min: 1, unit: '次', default: 10 },
      { key: 'enable_tcp_fallback', label: 'UDP 失败改用 TCP', type: 'boolean', default: true },
    ],
  },
  {
    id: 'transport',
    title: '连接与传输',
    description: '连接池、健康检查与连接保活',
    tone: 'ink',
    fields: [
      { key: 'udp_pool_size', label: 'UDP 连接池', type: 'number', min: 1, unit: '个连接', default: 64 },
      { key: 'tcp_pool_size', label: 'TCP 连接池', type: 'number', min: 1, unit: '个连接', default: 64 },
      { key: 'doh_pool_size', label: 'DoH 连接池', type: 'number', min: 1, unit: '个连接', default: 8 },
      { key: 'dot_pool_size', label: 'DoT 连接池', type: 'number', min: 1, unit: '个连接', default: 64 },
      { key: 'doq_pool_size', label: 'DoQ 连接池', type: 'number', min: 1, unit: '个连接', default: 16 },
      { key: 'tcp_health_check_error_threshold', label: 'TCP 错误阈值', type: 'number', min: 0, unit: '次', default: 3 },
      { key: 'tcp_connection_max_age_seconds', label: 'TCP 最大存活 (s)', type: 'number', min: 0, unit: '秒', default: 300 },
      { key: 'tcp_connection_idle_timeout_seconds', label: 'TCP 空闲超时 (s)', type: 'number', min: 0, unit: '秒', default: 60 },
      { key: 'doq_connection_idle_timeout_seconds', label: 'DoQ 空闲超时 (s)', type: 'number', min: 0, unit: '秒', default: 60 },
      { key: 'doq_keepalive_interval_ms', label: 'DoQ 保活间隔 (ms)', type: 'number', min: 0, unit: '毫秒', default: 15000 },
      { key: 'doq_enable_0rtt', label: 'DoQ 0-RTT', type: 'boolean', default: true },
    ],
  },
  {
    id: 'cache',
    title: '缓存与后台刷新',
    description: '缓存容量、有效期与后台刷新策略',
    tone: 'amber',
    fields: [
      { key: 'cache_capacity', label: '缓存容量', type: 'number', min: 1, unit: '条', default: 10000 },
      { key: 'cache_max_ttl', label: '缓存最大 TTL (s)', type: 'number', min: 1, unit: '秒', default: 86400 },
      { key: 'dashmap_shards', label: '缓存分片数', type: 'number', min: 0, placeholder: '自动' },
      { key: 'cache_background_refresh', label: '后台刷新', type: 'boolean', default: false },
      { key: 'cache_refresh_threshold_percent', label: '刷新阈值 (%)', type: 'number', min: 1, max: 90, unit: '%', default: 10, visibleWhen: 'cache_background_refresh' },
      { key: 'cache_refresh_min_ttl', label: '刷新最小 TTL (s)', type: 'number', min: 0, unit: '秒', default: 5, visibleWhen: 'cache_background_refresh' },
    ],
  },
  {
    id: 'stale',
    title: '过期缓存',
    description: '缓存过期后还能用旧结果多久，客户端等多久',
    tone: 'red',
    fields: [
      { key: 'serve_stale', label: '过期后继续用旧结果', type: 'boolean', default: false },
      { key: 'serve_stale_ttl', label: '旧结果的 TTL (s)', type: 'number', min: 1, unit: '秒', default: 30, visibleWhen: 'serve_stale' },
      { key: 'serve_stale_expire_ttl', label: '旧结果最多用多久 (s)', type: 'number', min: 0, unit: '秒', default: 86400, visibleWhen: 'serve_stale' },
      { key: 'serve_stale_ttl_reset', label: '每用一次旧结果就重新计时', type: 'boolean', default: true, visibleWhen: 'serve_stale' },
      { key: 'serve_stale_client_timeout_ms', label: '客户端等待 (ms)', type: 'number', min: 0, unit: '毫秒', default: 0, visibleWhen: 'serve_stale' },
    ],
  },
  {
    id: 'flow-control',
    title: '自动限流',
    description: '同时处理的请求数、延迟阈值和调整间隔',
    tone: 'green',
    fields: [
      { key: 'flow_control_enabled', label: '自动限流', type: 'boolean', default: false },
      { key: 'flow_control_initial_permits', label: '同时处理的请求数（初始）', type: 'number', min: 1, unit: '个', default: 500, visibleWhen: 'flow_control_enabled' },
      { key: 'flow_control_min_permits', label: '同时处理的请求数（最少）', type: 'number', min: 1, unit: '个', default: 100, visibleWhen: 'flow_control_enabled' },
      { key: 'flow_control_max_permits', label: '同时处理的请求数（最多）', type: 'number', min: 1, unit: '个', default: 800, visibleWhen: 'flow_control_enabled' },
      { key: 'flow_control_latency_threshold_ms', label: '延迟阈值 (ms)', type: 'number', min: 1, unit: '毫秒', default: 100, visibleWhen: 'flow_control_enabled' },
      { key: 'flow_control_adjustment_interval_secs', label: '调整间隔 (s)', type: 'number', min: 1, unit: '秒', default: 5, visibleWhen: 'flow_control_enabled' },
    ],
  },
]

// 内核报来的设置名在页面上叫什么：表单里的名字去掉括号里的单位；表单里没有、只能在 JSON 里改的，照「TCP 错误阈值」那样起名，
// 再没有的照写内核的名字
// What a setting name the kernel reports is called on the page: the form's label without the bracketed unit; one the form lacks
// (editable in JSON only) is named like TCP 错误阈值, and anything else keeps the kernel's name
const JSON_ONLY_NAMES: Record<string, string> = { doh_health_check_error_threshold: 'DoH 错误阈值' }
const FORM_FIELDS = SETTING_SECTIONS.flatMap((section) => section.fields)
export function settingName(key: string): string {
  const field = FORM_FIELDS.find((item) => item.key === key)
  return field ? field.label.replace(/\s*\([^)]*\)$/, '') : JSON_ONLY_NAMES[key] ?? key
}

// 一串设置名，放在句末冒号后面用（名字可能以字母开头、结尾，挨着标点就不用另外隔空格）：
// - 按表单里的先后排，和人在表单里看到的一样；
// - 自动限流那几项离开分组标题就看不懂（「延迟阈值」「调整间隔」），合成一项「自动限流」；
// - 提示条里三个以内都写出来，再多写前三个和一共几项；确认框（all）全写
// A run of setting names, for use after a colon at the end of a sentence (a name may start or end with a letter, and next to
// punctuation it needs no extra space):
// - in the form's order, as the reader sees them there;
// - the flow-control ones mean nothing without their group title (延迟阈值, 调整间隔), so they merge into one 自动限流;
// - a notice writes up to three, beyond that the first three and how many in all; the confirm dialog (all) writes every one
export function settingNames(keys: readonly string[], options: { all?: boolean } = {}): string {
  const order = (key: string) => { const at = FORM_FIELDS.findIndex((field) => field.key === key); return at < 0 ? FORM_FIELDS.length : at }
  const names = [...new Set([...keys].sort((a, b) => order(a) - order(b)).map((key) => (key.startsWith('flow_control_') ? '自动限流' : settingName(key))))]
    // 一个名字里不断行（手机上「UDP」和「监听地址」曾被拆到两行） / A name never breaks inside (on a phone 「UDP」 and 「监听地址」 were split across lines)
    .map((name) => name.replace(/ /g, '\u00a0'))
  return names.length > 3 && !options.all ? `${names.slice(0, 3).join('、')}等\u00a0${names.length}\u00a0项` : names.join('、')
}

// 退回时说清每一项改回什么，带上表单里的单位：「UDP 监听地址 0.0.0.0:53」「DoQ 保活间隔 15000 毫秒」；没写的说默认是多少
// （「缓存容量 默认 10000 条」），表单里没有默认值的说「默认值」；自动限流照样合成一项，只说改回
// When rolling back, say what each setting goes back to, with the form's unit: 「UDP 监听地址 0.0.0.0:53」「DoQ 保活间隔 15000 毫秒」;
// an unset one says its default (「缓存容量 默认 10000 条」), or 「默认值」 when the form has none; flow control merges into one as
// above and just goes back
export function settingValues(values: Record<string, unknown>): string {
  const order = (key: string) => { const at = FORM_FIELDS.findIndex((field) => field.key === key); return at < 0 ? FORM_FIELDS.length : at }
  const shown = (key: string, value: unknown) => {
    const field = FORM_FIELDS.find((item) => item.key === key)
    const unit = field?.unit ? ` ${field.unit}` : ''
    if (value === null || value === undefined) return field?.default === undefined ? '（默认值）' : ` 默认 ${String(field.default)}${unit}`
    return typeof value === 'boolean' ? ` ${value ? '开启' : '关闭'}` : ` ${String(value)}${unit}`
  }
  const items = [...new Set(Object.keys(values).sort((a, b) => order(a) - order(b)).map((key) => (key.startsWith('flow_control_') ? '自动限流' : `${settingName(key)}${shown(key, values[key])}`)))]
  // 一项里不断行 / No break inside an item
  return items.map((item) => item.replace(/ /g, '\u00a0')).join('、')
}

// 高级规则的表单也说面板的话：和规则卡片的读法、普通规则的条件同一套叫法；内核的写法留在 JSON 里
// The advanced-rule form speaks the panel's words too: the same names as the rule reading and plain conditions; the kernel's spelling stays in the JSON tab
export const MATCH_OPERATORS: SelectOption[] = [
  { value: 'and', label: '且' },
  { value: 'or', label: '或' },
  { value: 'and_not', label: '且不是' },
  { value: 'or_not', label: '或不是' },
  { value: 'not', label: '不是' },
]

const SELECTOR_MATCHERS: MatcherDefinition[] = [
  { value: 'listener_label', label: '监听标签', fields: ['value'] },
  { value: 'client_ip', label: '客户端 IP', fields: ['cidr'] },
  { value: 'domain_suffix', label: '域名（含子域名）', fields: ['value'] },
  { value: 'domain_regex', label: '域名匹配正则', fields: ['value'] },
  { value: 'any', label: '所有请求', fields: [] },
  { value: 'qclass', label: '查询类别', fields: ['value'] },
  { value: 'edns_present', label: '带 EDNS', fields: ['expect'] },
  { value: 'geo_site', label: '属于 GeoSite', fields: ['value'] },
  { value: 'geo_site_not', label: '不属于 GeoSite', fields: ['value'] },
  { value: 'geoip_country', label: '客户端地区', fields: ['country_codes'] },
  { value: 'geoip_private', label: '客户端是内网', fields: ['expect'] },
  { value: 'qtype', label: '查询类型', fields: ['value'] },
]

const REQUEST_MATCHERS: MatcherDefinition[] = SELECTOR_MATCHERS.filter((item) => item.value !== 'listener_label')

const RESPONSE_MATCHERS: MatcherDefinition[] = [
  { value: 'upstream_equals', label: '回答来自', fields: ['value'] },
  { value: 'request_domain_suffix', label: '请求的域名（含子域名）', fields: ['value'] },
  { value: 'request_domain_regex', label: '请求的域名匹配正则', fields: ['value'] },
  { value: 'response_type', label: '回答的记录类型', fields: ['value'] },
  { value: 'response_rcode', label: '响应码', fields: ['value'] },
  { value: 'response_qclass', label: '查询类别', fields: ['value'] },
  { value: 'response_edns_present', label: '回答带 EDNS', fields: ['expect'] },
  { value: 'response_upstream_ip', label: '上游 IP', fields: ['cidr'] },
  { value: 'response_answer_ip', label: '回答的 IP', fields: ['cidr'] },
  { value: 'response_answer_ip_geoip_country', label: '回答 IP 的地区', fields: ['country_codes'] },
  { value: 'response_answer_ip_geoip_private', label: '回答的是内网地址', fields: ['expect'] },
  { value: 'response_request_domain_geosite', label: '请求的域名属于 GeoSite', fields: ['value'] },
  { value: 'response_request_domain_geosite_not', label: '请求的域名不属于 GeoSite', fields: ['value'] },
  { value: 'response_txt_content', label: 'TXT 内容', fields: ['mode', 'value'] },
]

export const MATCHER_DEFINITIONS: Record<MatcherScope, MatcherDefinition[]> = {
  selector: SELECTOR_MATCHERS,
  request: REQUEST_MATCHERS,
  response: RESPONSE_MATCHERS,
}

export const ACTION_TYPES: ActionDefinition[] = [
  { value: 'log', label: '记录日志' },
  { value: 'static_response', label: '固定响应码' },
  { value: 'static_ip_response', label: '固定 IP' },
  { value: 'static_cname_response', label: '固定 CNAME', requiresCapability: CONFIG_STATIC_CNAME_RESPONSE_V1 },
  { value: 'static_txt_response', label: '固定 TXT' },
  { value: 'replace_txt_response', label: '替换 TXT' },
  { value: 'jump_to_pipeline', label: '转到另一组' },
  { value: 'allow', label: '交给默认上游' },
  { value: 'deny', label: '拦截（REFUSED）' },
  { value: 'forward', label: '转发' },
  { value: 'continue', label: '继续往下' },
]

export const QTYPE_OPTIONS = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'PTR', 'SOA', 'SRV', 'OPT']
export const TRANSPORT_OPTIONS = ['udp', 'tcp', 'tcp_udp', 'doh', 'dot', 'doq']

const FIELD_DEFAULTS = new Map(SETTING_SECTIONS.flatMap((section) => section.fields).map((field) => [field.key, field.default]))

/** 这一项现在的值：配置里没写就是内核的默认值 / The setting's current value: the kernel default when the config omits it */
export function settingValue(settings: GlobalSettings, key: string): unknown {
  return settings[key] ?? FIELD_DEFAULTS.get(key)
}

export function settingVisible(field: SettingField, settings: GlobalSettings): boolean {
  if (field.visibleWhen && !settingValue(settings, field.visibleWhen)) return false
  if (field.visibleWhenAny && !field.visibleWhenAny.some((key) => Boolean(settingValue(settings, key)))) return false
  return true
}

