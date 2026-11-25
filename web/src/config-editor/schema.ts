import { QTYPES } from '../config-model/grammar'
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
  // 数字的取值范围，页面照它查（见 settings-checks）：内核收的范围（GlobalSettings::validate、problems() 和它的整数类型），不写 max 的
  // 是 u64。只有连接池比内核严，最少 1（内核把 0 当 1）
  // A number's range, which the page checks (see settings-checks): what the kernel takes (GlobalSettings::validate, problems() and its
  // integer type), a missing max being u64. Only the pools are stricter than the kernel, at least 1 (the kernel takes 0 as 1)
  min?: number
  max?: number
  nullable?: boolean
  // 清空时照写成空的，不退回内核的默认值（别的文字框清空就是没写）：默认上游清空了要人填一个，框下说「至少填一个地址」，不悄悄换成
  // 1.1.1.1:53
  // A cleared box stays written as empty instead of falling back to the kernel's default (any other text box cleared is unset): a
  // cleared 默认上游 wants an address filled in, the box saying 「至少填一个地址」, rather than quietly becoming 1.1.1.1:53
  keepsEmpty?: boolean
  wide?: boolean
  visibleWhen?: string
  visibleWhenAny?: string[]
  // 内核有这项能力才列出；没有时配置里没写就不列，写了的照样列出、说内核不认它，好在这里清空
  // Listed only when the kernel has this capability; without it the field is left out unless the config writes it, which is still
  // listed, saying the kernel does not read it, so it can be cleared here
  requiresCapability?: string
  // 内核没有 capability 这项能力时的读法：名字、说明、默认值换成这里的；有的时候照字段本身
  // How the field reads on a kernel without `capability`: its label, note and default become these; with it the field reads as itself
  without?: { capability: string } & Pick<SettingField, 'label' | 'title' | 'default'>
}

export const CONFIG_STATIC_CNAME_RESPONSE_V1 = 'config_static_cname_response_v1'
export const CONFIG_BOOTSTRAP_V1 = 'config_bootstrap_v1'
export const CONFIG_SERVE_STALE_TTL_RESET_V2 = 'config_serve_stale_ttl_reset_v2'

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

// 内核里 u32 的设置最大多少 / The most a u32 setting in the kernel may be
const U32_MAX = 4_294_967_295
const BIND_NOTE = '不写就用内核的默认端口，内核版本不同默认也不同；要固定在哪个端口就写上'
const BOOTSTRAP_NOTE = '上游写成域名（如 tls://dns.google）时，先问这里的 DNS 要它的 IP。写成「IP:端口」，多个用逗号隔开，同时问、用先答的。' +
  '不写就交给系统解析：路由器上 KixDNS 接管了 53 端口时，系统解析会绕回 KixDNS 自己，写成域名的上游就连不上，这时一定要写'

export const SETTING_SECTIONS: SettingSection[] = [
  {
    id: 'network',
    title: '基础与监听',
    description: '监听地址和请求超时',
    tone: 'green',
    fields: [
      // 内核的默认端口 2026.11.24.9 起从 5353 换成了 5533，没有能力分得出来：不写默认是哪个，只说不写就随内核
      // The kernel's default port went from 5353 to 5533 at 2026.11.24.9, and no capability tells them apart: the form names no default,
      // saying only that an unset one follows the kernel
      { key: 'bind_udp', label: 'UDP 监听地址', type: 'text', placeholder: '内核默认', title: BIND_NOTE },
      { key: 'bind_tcp', label: 'TCP 监听地址', type: 'text', placeholder: '内核默认', title: BIND_NOTE },
      { key: 'bind_doh', label: 'DoH 监听地址', type: 'text', placeholder: '留空禁用 DoH' },
      { key: 'doh_path', label: 'DoH 查询路径', type: 'text', default: '/dns-query' },
      { key: 'doh_tls_cert', label: 'DoH TLS 证书', type: 'text', example: '/path/to/cert.pem', wide: true },
      { key: 'doh_tls_key', label: 'DoH TLS 私钥', type: 'text', example: '/path/to/key.pem', wide: true },
      // 只有带高级规则时才显示（其余时候由「其余请求」决定）：说清它管的是哪些请求 / Shown only with advanced rules (otherwise 其余请求 decides it): say which requests it serves
      { key: 'default_upstream', label: '默认上游', type: 'text', default: '1.1.1.1:53', keepsEmpty: true, wide: true, title: '高级规则里「交给默认上游」和没写地址的转发用这里的地址，多个用逗号隔开' },
      { key: 'bootstrap', label: '引导 DNS', type: 'text', example: '223.5.5.5:53, 119.29.29.29:53', wide: true, requiresCapability: CONFIG_BOOTSTRAP_V1, title: BOOTSTRAP_NOTE },
      { key: 'min_ttl', label: '最小 TTL', type: 'number', min: 0, max: U32_MAX, unit: '秒', default: 0 },
      { key: 'upstream_timeout_ms', label: '上游超时 (ms)', type: 'number', min: 1, unit: '毫秒', default: 9000 },
      { key: 'request_timeout_ms', label: '整体请求超时 (ms)', type: 'number', min: 0, unit: '毫秒', nullable: true, placeholder: '自动计算', title: '一个请求连重发、改用 TCP 在内最多等多久，不能小于上游超时；不写是上游超时的两倍半' },
      // 内核的 MAX_JUMP_LIMIT 是 64；请求阶段和回答动作的跳转各算一份 / The kernel's MAX_JUMP_LIMIT is 64; the request phase and answer
      // actions each count their own
      { key: 'response_jump_limit', label: '跳转次数上限', type: 'number', min: 0, max: 64, unit: '次', default: 10, title: '「转到另一组」最多跳几次：请求阶段最多跳这么多次，回答后检查从第一次跳转起另算这么多次，跳满还要跳就回 SERVFAIL。0 是一次也不许跳，最多 64' },
      { key: 'enable_tcp_fallback', label: 'UDP 失败改用 TCP', type: 'boolean', default: true },
    ],
  },
  {
    id: 'transport',
    title: '连接与传输',
    description: '连接池、连接存活与保活',
    tone: 'ink',
    fields: [
      { key: 'udp_pool_size', label: 'UDP 连接池', type: 'number', min: 1, max: 1024, unit: '个连接', default: 64 },
      { key: 'tcp_pool_size', label: 'TCP 连接池', type: 'number', min: 1, max: 1024, unit: '个连接', default: 64 },
      { key: 'doh_pool_size', label: 'DoH 连接池', type: 'number', min: 1, max: 1024, unit: '个连接', default: 8 },
      { key: 'dot_pool_size', label: 'DoT 连接池', type: 'number', min: 1, max: 1024, unit: '个连接', default: 64 },
      { key: 'doq_pool_size', label: 'DoQ 连接池', type: 'number', min: 1, max: 1024, unit: '个连接', default: 16 },
      { key: 'tcp_connection_max_age_seconds', label: 'TCP 最大存活 (s)', type: 'number', min: 0, unit: '秒', default: 300 },
      { key: 'tcp_connection_idle_timeout_seconds', label: 'TCP 空闲超时 (s)', type: 'number', min: 0, unit: '秒', default: 60 },
      // QUIC 的空闲超时按毫秒算、装在 2^62 以内 / QUIC counts the idle timeout in milliseconds, within 2^62
      { key: 'doq_connection_idle_timeout_seconds', label: 'DoQ 空闲超时 (s)', type: 'number', min: 0, max: 4_611_686_018_427_387, unit: '秒', default: 60 },
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
      { key: 'dashmap_shards', label: '缓存分片数', type: 'number', min: 0, max: 65536, placeholder: '自动', title: '0 是自动；要写就写 2 到 65536 之间 2 的幂（2、4、8……）' },
      { key: 'cache_background_refresh', label: '后台刷新', type: 'boolean', default: false },
      { key: 'cache_refresh_threshold_percent', label: '刷新阈值 (%)', type: 'number', min: 0, max: 99, unit: '%', default: 10, visibleWhen: 'cache_background_refresh', title: '缓存剩下的 TTL 不到原来的这么多时，在后台去上游取新的；0 是只剩 1 秒时才刷新，到 100 就每次命中都刷新了' },
      { key: 'cache_refresh_min_ttl', label: '刷新最小 TTL (s)', type: 'number', min: 0, max: U32_MAX, unit: '秒', default: 5, visibleWhen: 'cache_background_refresh' },
    ],
  },
  {
    id: 'stale',
    title: '过期缓存',
    description: '缓存过期后还能用旧结果多久，客户端等多久',
    tone: 'red',
    fields: [
      { key: 'serve_stale', label: '过期后继续用旧结果', type: 'boolean', default: false },
      { key: 'serve_stale_ttl', label: '旧结果的 TTL (s)', type: 'number', min: 0, max: U32_MAX, unit: '秒', default: 30, visibleWhen: 'serve_stale', title: '交出旧结果时写给客户端的 TTL；0 是让客户端不缓存旧结果，每次都回来问' },
      { key: 'serve_stale_expire_ttl', label: '旧结果最多用多久 (s)', type: 'number', min: 0, unit: '秒', default: 86400, visibleWhen: 'serve_stale' },
      // 2026.11.23.45 起默认关，含义改成「后台刷新失败以后才重新计时」，内核带 config_serve_stale_ttl_reset_v2；以前的默认开，每交出一次旧结果就重新计时
      // From 2026.11.23.45 it is off by default and means 「count afresh only once a background refresh fails」, the kernel declaring
      // config_serve_stale_ttl_reset_v2; before, it was on by default and every stale answer served started the time again
      {
        key: 'serve_stale_ttl_reset', label: '刷新失败后重新计时', type: 'boolean', default: false, visibleWhen: 'serve_stale',
        title: '旧结果的后台刷新失败以后，从失败时起重新算它还能用多久。上游一直取不到新的、又一直有人问的域名会一直用旧结果，不受「旧结果最多用多久」限制',
        without: {
          capability: CONFIG_SERVE_STALE_TTL_RESET_V2, label: '每用一次旧结果就重新计时', default: true,
          title: '每交出一次旧结果都重新计时：一直有人问的域名会一直用旧结果，不受「旧结果最多用多久」限制',
        },
      },
      { key: 'serve_stale_client_timeout_ms', label: '客户端等待 (ms)', type: 'number', min: 0, unit: '毫秒', default: 0, visibleWhen: 'serve_stale' },
    ],
  },
  {
    id: 'flow-control',
    title: '智能流控',
    description: '某台设备请求激增时，其他设备照常解析',
    tone: 'green',
    fields: [
      { key: 'flow_control_enabled', label: '智能流控', type: 'boolean', default: false },
    ],
  },
]

/**
 * 内核不再读的旧设置（内核 config.rs 的 RETIRED_SETTINGS）：写着照常加载、不起作用，配置每生效一次内核都提醒一次。面板原样写回，
 * 基础设置页给一个一键清掉的入口
 * The old settings the kernel no longer reads (RETIRED_SETTINGS in the kernel's config.rs): written, they load as usual to no effect,
 * and the kernel reminds of them every time the config takes effect. The panel writes them back as they are, and the settings page
 * offers to clear them in one go
 */
export const RETIRED_SETTINGS: readonly string[] = [
  'flow_control_initial_permits', 'flow_control_min_permits', 'flow_control_max_permits', 'flow_control_latency_threshold_ms',
  'flow_control_adjustment_interval_secs', 'prefetch', 'tcp_health_check_error_threshold', 'statistics_enabled',
  'statistics_anonymize_client_ip', 'geoip_auto_convert', 'geoip_filter_countries',
]

/** 设置里写着的退役旧设置，按写的顺序 / The retired settings written in settings, in the order written */
export const retiredIn = (settings: GlobalSettings): string[] => Object.keys(settings).filter((key) => RETIRED_SETTINGS.includes(key))

// 内核报来的设置名在页面上叫什么：表单里的名字去掉括号里的单位；表单里没有、只能在 JSON 里改的和退役的旧设置在这里起名，再没有的照写内核的名字。
// TCP 错误阈值不放进表单：内核的 TCP、DoT 连接一出错就重建，这一项不起作用（见内核文档）
// What a setting name the kernel reports is called on the page: the form's label without the bracketed unit; one the form lacks
// (editable in JSON only) and the retired ones are named here, and anything else keeps the kernel's name. TCP 错误阈值 stays out of the
// form: the kernel rebuilds a TCP or DoT connection on its first error, so the setting has no effect (see the kernel docs)
const JSON_ONLY_NAMES: Record<string, string> = {
  doh_health_check_error_threshold: 'DoH 错误阈值', tcp_health_check_error_threshold: 'TCP 错误阈值', prefetch: '预取',
  statistics_enabled: '查询统计', statistics_anonymize_client_ip: '客户端地址脱敏', geoip_auto_convert: 'GeoIP 自动转换', geoip_filter_countries: 'GeoIP 国家过滤',
}
const FORM_FIELDS = SETTING_SECTIONS.flatMap((section) => section.fields)
export function settingName(key: string): string {
  const field = FORM_FIELDS.find((item) => item.key === key)
  return field ? field.label.replace(/\s*\([^)]*\)$/, '') : JSON_ONLY_NAMES[key] ?? key
}

// 一串设置名，放在句末冒号后面用（名字可能以字母开头、结尾，挨着标点就不用另外隔空格）：
// - 按表单里的先后排，和人在表单里看到的一样；
// - 配置里留着的智能流控旧数字（「延迟阈值」「调整间隔」这些）离开分组标题就看不懂，和开关合成一项「智能流控」；
// - 提示条里三个以内都写出来，再多写前三个和一共几项；确认框（all）全写
// A run of setting names, for use after a colon at the end of a sentence (a name may start or end with a letter, and next to
// punctuation it needs no extra space):
// - in the form's order, as the reader sees them there;
// - the old flow-control numbers a config may still hold (延迟阈值, 调整间隔 and the like) mean nothing without their
//   group title, so they merge with the switch into one 智能流控;
// - a notice writes up to three, beyond that the first three and how many in all; the confirm dialog (all) writes every one
// 名字里不断行：空格换成不换行空格，连字符后面接一个词连接符（手机上「DoQ 0-RTT」曾被拆成「DoQ 0-」「RTT」）
// A name never breaks inside: spaces become no-break spaces and a word joiner follows each hyphen (on a phone 「DoQ 0-RTT」 was split
// into 「DoQ 0-」 and 「RTT」)
const glueName = (name: string) => name.replace(/ /g, '\u00a0').replace(/-/g, '-\u2060')
export function settingNames(keys: readonly string[], options: { all?: boolean } = {}): string {
  const order = (key: string) => { const at = FORM_FIELDS.findIndex((field) => field.key === key); return at < 0 ? FORM_FIELDS.length : at }
  const names = [...new Set([...keys].sort((a, b) => order(a) - order(b)).map((key) => (key.startsWith('flow_control_') ? '智能流控' : settingName(key))))]
    // 一个名字里不断行（手机上「UDP」和「监听地址」曾被拆到两行） / A name never breaks inside (on a phone 「UDP」 and 「监听地址」 were split across lines)
    .map(glueName)
  return names.length > 3 && !options.all ? `${names.slice(0, 3).join('、')}等\u00a0${names.length}\u00a0项` : names.join('、')
}

// 退回时说清每一项改回什么：「UDP 监听地址 0.0.0.0:53」「DoQ 保活间隔 15000 毫秒」；没写的照表单说默认是什么——有默认值的
// 「默认 10000 条」「默认开启」，没有的照占位说「自动」「留空」。智能流控合成一项：开关在名单里时说开关改回什么，只有几项数值时
// 说「智能流控的几项数值」。名字里、「数字 单位」里不断行；名字和值是一个读的单位，也粘在一起，只有长的值（路径、超过
// 16 个字符）可以和名字分开，整段换到下一行，不从中间拆
// When rolling back, say what each setting goes back to: 「UDP 监听地址 0.0.0.0:53」「DoQ 保活间隔 15000 毫秒」; an unset one says what
// the default is, as the form does — 「默认 10000 条」「默认开启」 where there is one, otherwise the placeholder's 「自动」「留空」. Flow
// control merges into one: with its switch in the list it says what the switch goes back to, with only numbers 「智能流控的几项数值」.
// No break inside a name or a 「number unit」; name and value are read as one and stay together too, and only a long value (a
// path, over 16 characters) may part from its name, moving down whole instead of splitting
export function settingValues(values: Record<string, unknown>): string {
  const glue = (text: string) => text.replace(/ /g, '\u00a0')
  const order = (key: string) => { const at = FORM_FIELDS.findIndex((field) => field.key === key); return at < 0 ? FORM_FIELDS.length : at }
  const switchWord = (on: boolean) => (on ? '开启' : '关闭')
  const valueOf = (key: string, value: unknown): string => {
    const field = FORM_FIELDS.find((item) => item.key === key)
    const unit = field?.unit ? ` ${field.unit}` : ''
    if (value === null || value === undefined) {
      if (!field) return '默认值'
      if (typeof field.default === 'boolean') return `默认${switchWord(field.default)}`
      if (field.default !== undefined) return glue(`默认 ${String(field.default)}${unit}`)
      return field.placeholder?.includes('自动') ? '自动' : field.placeholder?.includes('默认') ? '默认值' : '留空'
    }
    return typeof value === 'boolean' ? switchWord(value) : glue(`${String(value)}${unit}`)
  }
  const keys = Object.keys(values).sort((a, b) => order(a) - order(b))
  const items: string[] = []
  let flowDone = false
  for (const key of keys) {
    if (key.startsWith('flow_control_')) {
      if (flowDone) continue
      flowDone = true
      const enabled = values.flow_control_enabled
      items.push('flow_control_enabled' in values ? `智能流控\u00a0${valueOf('flow_control_enabled', enabled)}` : '智能流控的几项数值')
      continue
    }
    const value = valueOf(key, values[key])
    items.push(`${glueName(settingName(key))}${value.includes('/') || value.length > 16 ? ' ' : '\u00a0'}${value}`)
  }
  return items.join('、')
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
  { value: 'domain_suffix', label: '域名属于', fields: ['value'] },
  { value: 'domain_exact', label: '域名就是', fields: ['value'] },
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
  { value: 'request_domain_suffix', label: '请求的域名属于', fields: ['value'] },
  { value: 'request_domain_exact', label: '请求的域名就是', fields: ['value'] },
  { value: 'request_domain_regex', label: '请求的域名匹配正则', fields: ['value'] },
  { value: 'response_type', label: '回答的记录类型', fields: ['value'] },
  { value: 'response_rcode', label: '响应码', fields: ['value'] },
  { value: 'response_qclass', label: '查询类别', fields: ['value'] },
  { value: 'response_edns_present', label: '回答带 EDNS', fields: ['expect'] },
  { value: 'response_upstream_ip', label: '上游 IP', fields: ['cidr'] },
  { value: 'response_answer_ip', label: '回答的 IP', fields: ['cidr'] },
  { value: 'response_answer_ip_geoip_country', label: '回答 IP 的地区', fields: ['country_codes'] },
  { value: 'response_answer_ip_geoip_private', label: '回答的是内网地址', fields: ['expect'] },
  { value: 'response_request_domain_geo_site', label: '请求的域名属于 GeoSite', fields: ['value'] },
  { value: 'response_request_domain_geo_site_not', label: '请求的域名不属于 GeoSite', fields: ['value'] },
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

// 高级规则里的查询类型也只给内核认的那几个，和条件表单同一张表 / Advanced rules offer only the record types the kernel takes, the condition form's table
export const QTYPE_OPTIONS: readonly string[] = QTYPES
export const TRANSPORT_OPTIONS = ['udp', 'tcp', 'tcp_udp', 'doh', 'dot', 'doq']

const FIELD_DEFAULTS = new Map(SETTING_SECTIONS.flatMap((section) => section.fields).map((field) => [field.key, field.default]))

/** 这一项现在的值：配置里没写就是内核的默认值 / The setting's current value: the kernel default when the config omits it */
export function settingValue(settings: GlobalSettings, key: string): unknown {
  return settings[key] ?? FIELD_DEFAULTS.get(key)
}

/**
 * 照内核报的能力读的设置分组：没有 without.capability 的内核上换成那种读法；要能力而内核没有的，配置里没写就不列
 * The setting groups as the kernel's capabilities read them: on a kernel without without.capability a field reads that way; one
 * needing a capability the kernel lacks is left out unless the config writes it
 */
export function settingSections(capabilities: readonly string[], settings: GlobalSettings): SettingSection[] {
  const has = (capability: string) => capabilities.includes(capability)
  const read = (field: SettingField): SettingField => {
    if (!field.without || has(field.without.capability)) return field
    const { capability: _capability, ...reading } = field.without
    return { ...field, ...reading }
  }
  return SETTING_SECTIONS.map((section) => ({
    ...section,
    fields: section.fields.filter((field) => !field.requiresCapability || has(field.requiresCapability) || settings[field.key] !== undefined).map(read),
  }))
}

export function settingVisible(field: SettingField, settings: GlobalSettings): boolean {
  if (field.visibleWhen && !settingValue(settings, field.visibleWhen)) return false
  if (field.visibleWhenAny && !field.visibleWhenAny.some((key) => Boolean(settingValue(settings, key)))) return false
  return true
}


// 设置列表上「Geo 数据」那一行：GeoIP 的 MMDB 和 DAT 配了哪个都算已配置；GeoSite 只数填了的，刚点「添加链接」还空着的
// 那一行不算——外面说的要和点进去看到的一致
// The 「Geo 数据」 row on the settings list: GeoIP counts as set with either the MMDB or the DAT; GeoSite counts only the paths
// filled in, not the row 「添加链接」 has just added and left empty, so what the row says matches what opening it shows
export function geoSummary(settings: GlobalSettings): string[] {
  const filled = (value: unknown) => typeof value === 'string' && value.trim() !== ''
  const geoip = filled(settings.geoip_db_path) || filled(settings.geoip_dat_path)
  const sites = Array.isArray(settings.geosite_data_paths) ? settings.geosite_data_paths.filter(filled).length : 0
  return [geoip ? 'GeoIP 已配置' : 'GeoIP 未配置', `GeoSite ${sites} 个文件`]
}
