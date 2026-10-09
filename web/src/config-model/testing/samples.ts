import type { Condition, Model, Rule } from '../model'
import { inheritResponse } from '../model'
import type { KConfigLike } from '../kernel'

// 测试用的示例配置：一个家里加公司 VPN 的网络，以及几份旧格式的内核配置。都是示例，不是谁的真实数据。
// Sample configs for the tests: a home network with a company VPN, and a few older-format kernel configs. All examples, nobody's real data.

let next = 1
export const newId = () => next++
export const cond = (field: Condition['field'], values: string[], negate = false, regex = false): Condition => ({ id: newId(), field, values, negate, regex })
const rule = (r: Partial<Rule> & Pick<Rule, 'name' | 'conditions' | 'outcome'>): Rule => ({
  id: newId(), note: '', enabled: true, log: { enabled: false, level: 'info' }, ecs: 'inherit', response: inheritResponse(), edited: '3 天前', ...r,
})

// 两条规则不起名字，看没名字的规则怎么读写 / Two rules go unnamed, to see how an unnamed rule reads and writes
export function demoModel(): Model {
  const m = sampleModel()
  for (const r of m.rules) {
    if (r.name === '国内域名') r.name = ''
    else if (r.name === '版本查询') { r.name = ''; r.note = '给 dig version.bind 一个固定回答' }
  }
  return m
}

export function sampleModel(): Model {
  return {
    format: '1.0',
    // 和面板演示数据一样的全局设置 / The same global settings as the panel's demo data
    settings: {
      bind_udp: '0.0.0.0:53',
      bind_tcp: '0.0.0.0:53',
      cache_capacity: 20000,
      upstream_timeout_ms: 1800,
      statistics_enabled: true,
      statistics_anonymize_client_ip: false,
      geoip_db_path: '/var/lib/kixdns-panel/geo/geoip-mmdb-4c425e120e43.mmdb',
      geosite_data_paths: ['/var/lib/kixdns-panel/geo/geosite-67b90a027f2c.dat'],
    },
    groups: [
      { id: 'abroad', name: '国外', addresses: [{ address: 'https://dns.google/dns-query', protocol: 'auto' }, { address: 'https://cloudflare-dns.com/dns-query', protocol: 'auto' }], ecs: null, fallback: { group: '', onError: false, onPolluted: false } },
      { id: 'cn', name: '国内', addresses: [{ address: 'https://doh.pub/dns-query', protocol: 'auto' }, { address: 'tls://dns.alidns.com', protocol: 'auto' }, { address: '223.5.5.5', protocol: 'tcp_udp' }], ecs: { mode: 'client', v4: 24, v6: 56 }, fallback: { group: 'abroad', onError: false, onPolluted: true } },
      { id: 'corp', name: '公司', addresses: [{ address: '10.0.0.53:53', protocol: 'auto' }, { address: '10.0.0.54:53', protocol: 'auto' }], ecs: { mode: 'clear' }, fallback: { group: 'cn', onError: true, onPolluted: false } },
      { id: 'router', name: '路由器', addresses: [{ address: '192.168.1.1:53', protocol: 'auto' }], ecs: null, fallback: { group: '', onError: false, onPolluted: false } },
    ],
    rules: [
      rule({ name: '测试网段只记录', conditions: [[cond('client_ip', ['192.168.50.0/24'])]], outcome: { type: 'continue' }, log: { enabled: true, level: 'info' }, edited: '昨天', note: '排查测试机的解析，不改变结果' }),
      rule({ name: '公司内网', conditions: [[cond('domain', ['corp.example', 'corp.internal'])]], outcome: { type: 'upstream', group: 'corp' }, edited: '2 周前' }),
      rule({ name: '广告与跟踪', conditions: [[cond('geosite', ['category-ads-all'])]], outcome: { type: 'block', response: 'default' }, edited: '1 个月前' }),
      rule({ name: '火狐 DoH 探测', conditions: [[cond('domain', ['use-application-dns.net'])]], outcome: { type: 'block', response: 'NXDOMAIN' }, edited: '1 个月前', note: '让火狐继续用这台 DNS，不自己走 DoH' }),
      rule({ name: '苹果服务', conditions: [[cond('domain', ['apple.com', 'icloud.com', 'mzstatic.com']), cond('qtype', ['A', 'AAAA'])]], outcome: { type: 'upstream', group: 'cn' }, ecs: { mode: 'client', v4: 24, v6: 48 } }),
      rule({ name: '国内域名', conditions: [[cond('geosite', ['cn'])]], outcome: { type: 'upstream', group: 'cn' }, edited: '1 个月前' }),
      rule({ name: '内网反查', conditions: [[cond('qtype', ['PTR']), cond('client_private', [])]], outcome: { type: 'group', group: 'lan' } }),
      rule({ name: '版本查询', conditions: [[cond('qclass', ['CH']), cond('domain', ['version.bind', 'version.server'])]], outcome: { type: 'answer', kind: 'txt', value: 'kixdns', ttl: 3600 } }),
      rule({ name: '防 DNS 重绑定', conditions: [[cond('geosite', ['geolocation-!cn'])]], outcome: { type: 'upstream', group: 'abroad' }, edited: '5 天前', note: '境外域名解析出内网地址时拒绝，防止网页借 DNS 访问内网设备',
        response: { mode: 'custom', match: 'any', conditions: [{ id: newId(), field: 'answer_private', negate: false, values: [] }], then: { type: 'block', response: 'REFUSED' }, otherwise: { type: 'none' } } }),
      rule({ name: '旧统计接口', enabled: false, conditions: [[cond('domain', ['stats.old-vendor.example'])]], outcome: { type: 'block', response: 'REFUSED' }, edited: '3 个月前' }),
    ],
    ruleGroups: [
      { id: 'lan', name: '内网解析', note: '局域网设备的反向解析', listener: '', rest: { type: 'upstream', group: 'router' }, rules: [
        rule({ name: '公司网段反查', conditions: [[cond('domain', ['10.in-addr.arpa'])]], outcome: { type: 'upstream', group: 'corp' } }),
      ] },
    ],
    mappings: [
      { id: newId(), domain: 'nas.home.arpa', target: '192.168.1.10', ttl: null, enabled: true },
      { id: newId(), domain: 'router.home.arpa', target: '192.168.1.1', ttl: null, enabled: true },
      { id: newId(), domain: 'printer.home.arpa', target: '192.168.1.30, fd00::30', ttl: null, enabled: true },
      { id: newId(), domain: 'files.home.arpa', target: 'nas.home.arpa', ttl: 600, enabled: true },
      { id: newId(), domain: 'old-nas.home.arpa', target: '192.168.1.9', ttl: null, enabled: false },
    ],
    rest: { type: 'upstream', group: 'abroad' },
    defaults: { block: 'NXDOMAIN' },
  }
}


// ---------- 旧格式的样本 / older-format samples ----------

// 现在面板的模板一路点出来的样子：域名映射在最前，国内外分流、广告拒绝、客户端网段、指定域名各一个入口
// What today's panel templates produce: domain mappings first, then one entry each for 国内外分流, ads, a client range and a domain
export const LEGACY_TEMPLATES: KConfigLike = {
  version: '1.0',
  settings: { bind_udp: '0.0.0.0:53', bind_tcp: '0.0.0.0:53', default_upstream: '1.1.1.1:53', upstream_timeout_ms: 1800, cache_capacity: 20000 },
  pipeline_select: [
    { pipeline: 'domain_mapping', matcher_operator: 'or', matchers: [{ type: 'domain_suffix', value: 'nas.home.arpa' }, { type: 'domain_suffix', value: 'files.home.arpa' }] },
    { pipeline: 'cn_doh', matchers: [{ type: 'geo_site', value: 'cn' }] },
    { pipeline: 'ad_block', matchers: [{ type: 'geo_site', value: 'category-ads-all' }] },
    { pipeline: 'client_dns', matchers: [{ type: 'client_ip', cidr: '192.168.1.100/30' }] },
    { pipeline: 'domain_dns', matchers: [{ type: 'domain_suffix', value: 'corp.example' }] },
    { pipeline: 'global_doh', matchers: [] },
  ],
  pipelines: [
    { id: 'domain_mapping', rules: [
      { name: 'domain_mapping-mapping-1', matchers: [{ type: 'domain_suffix', value: 'nas.home.arpa' }], actions: [{ type: 'static_cname_response', target: 'nas.lan', ttl: 300 }] },
      { name: 'domain_mapping-mapping-2', matchers: [{ type: 'domain_suffix', value: 'files.home.arpa' }], actions: [{ type: 'static_cname_response', target: 'nas.lan', ttl: 600 }] },
    ] },
    { id: 'cn_doh', rules: [{
      name: 'cn-doh', actions: [{ type: 'forward', upstream: 'https://doh.pub/dns-query, https://dns.alidns.com/dns-query' }],
      response_matchers: [{ type: 'response_answer_ip', cidr: '0.0.0.0/32' }, { type: 'response_answer_ip', cidr: '240.0.0.0/4' }, { type: 'response_answer_ip', cidr: '255.255.255.255/32' }],
      response_matcher_operator: 'or', response_actions_on_match: [{ type: 'log', level: 'warn' }, { type: 'jump_to_pipeline', pipeline: 'global_doh' }],
    }] },
    { id: 'ad_block', rules: [{ name: 'ad_block-rule', actions: [{ type: 'deny' }] }] },
    { id: 'client_dns', rules: [{ name: 'client_dns-rule', actions: [{ type: 'forward', upstream: '1.1.1.1:53' }] }] },
    { id: 'domain_dns', rules: [{ name: 'domain_dns-rule', actions: [{ type: 'forward', upstream: '10.0.0.53:53', transport: 'tcp' }] }] },
    { id: 'global_doh', rules: [{ name: 'global-doh', actions: [{ type: 'forward', upstream: 'https://cloudflare-dns.com/dns-query, https://dns.google/dns-query' }] }] },
  ],
}

// 面板演示数据里的配置 / The config in the panel's demo data
export const LEGACY_DEMO: KConfigLike = {
  version: '1.0',
  settings: { bind_udp: '0.0.0.0:53', bind_tcp: '0.0.0.0:53', cache_capacity: 20000, default_upstream: '1.1.1.1:53', upstream_timeout_ms: 1800 },
  pipelines: [{ id: 'default', rules: [{ name: 'secure-forward', matchers: [{ type: 'any' }], actions: [{ type: 'forward', upstream: '1.1.1.1:53', transport: 'udp' }] }] }],
}

// 手写的、什么都有的一份：监听标签、带条件的入口、规则级运算符、几个转发、死动作、回答阶段的各种写法、认不出的字段
// A hand-written one with everything: listener labels, conditional entries, rule-level operators, several forwards, dead actions,
// assorted answer-phase handling and unknown fields
export const LEGACY_MESSY: KConfigLike = {
  version: '1.0',
  background_refresh_rule: { name: '后台刷新专用规则', matchers: [{ type: 'any' }], actions: [{ type: 'forward', upstream: '8.8.8.8:53', transport: 'tcp' }] },
  settings: { default_upstream: '223.5.5.5:53', bind_udp: '0.0.0.0:53' },
  pipeline_select: [
    { pipeline: 'lan', matchers: [{ type: 'listener_label', value: 'lan' }] },
    { pipeline: 'special', matchers: [{ type: 'listener_label', value: 'guest' }, { type: 'qtype', value: 'AAAA' }] },
    { pipeline: 'kids', matchers: [{ type: 'client_ip', cidr: '192.168.1.100/30' }] },
    { pipeline: 'main', matchers: [{ type: 'any' }] },
    { pipeline: 'never', matchers: [{ type: 'qtype', value: 'MX' }] },
  ],
  pipelines: [
    { id: 'main', rules: [
      { name: 'hosts', matchers: [{ type: 'domain_suffix', value: 'nas.lan' }], actions: [{ type: 'static_ip_response', ip: '192.168.1.10' }] },
      { name: 'ads', matchers: [{ type: 'geo_site', value: 'category-ads-all' }], actions: [{ type: 'log', level: 'info' }, { type: 'deny' }, { type: 'static_response', rcode: 'NXDOMAIN' }] },
      { name: 'cn', matchers: [{ type: 'geo_site', value: 'cn' }, { type: 'domain_suffix', value: 'cn', operator: 'or' }],
        actions: [{ type: 'forward', upstream: 'https://doh.pub/dns-query,223.5.5.5', ecs: { mode: 'from_client_ip' } }],
        response_matchers: [{ type: 'response_answer_ip', cidr: '0.0.0.0/32' }, { type: 'response_rcode', value: 'SERVFAIL', operator: 'or' }],
        response_actions_on_match: [{ type: 'forward', upstream: 'tls://1.1.1.1' }] },
      { name: 'two-forwards', matchers: [{ type: 'domain_suffix', value: 'example.org' }], actions: [{ type: 'forward', upstream: '8.8.8.8', transport: 'tcp' }, { type: 'forward', upstream: 'https://dns.google/dns-query', ecs: { mode: 'clear' } }] },
      { name: 'not-private-ptr', matchers: [{ type: 'qtype', value: 'PTR' }, { type: 'geoip_private', expect: true }], matcher_operator: 'and_not', actions: [{ type: 'static_response', rcode: 'nxdomain' }] },
      { name: 'chain', matchers: [{ type: 'domain_suffix', value: 'a.test' }, { type: 'domain_suffix', value: 'b.test', operator: 'or' }, { type: 'qtype', value: 'AAAA', operator: 'and' }, { type: 'client_ip', cidr: '10.0.0.0/8', operator: 'or_not' }], actions: [{ type: 'jump_to_pipeline', pipeline: 'special' }] },
      { name: 'txt-rewrite', matchers: [{ type: 'domain_suffix', value: 'spf.test' }], actions: [{ type: 'forward', upstream: '8.8.8.8' }],
        response_matchers: [{ type: 'response_txt_content', mode: 'prefix', value: 'v=spf1' }], response_actions_on_match: [{ type: 'replace_txt_response', text: ['v=spf1 -all'] }] },
      { name: 'weird-response', matchers: [{ type: 'domain_suffix', value: 'w.test' }], actions: [{ type: 'forward', upstream: '9.9.9.9' }],
        response_matchers: [{ type: 'response_rcode', value: 'NXDOMAIN' }], response_actions_on_match: [{ type: 'static_ip_response', ip: '0.0.0.0' }, { type: 'log' }] },
      { name: 'odd-field', matchers: [{ type: 'domain_suffix', value: 'odd.test' }], actions: [{ type: 'deny' }], comment: 'kept by hand' },
      { name: 'log-only', matchers: [{ type: 'client_ip', cidr: '192.168.50.0/24' }], actions: [{ type: 'log', level: 'debug' }] },
      { name: 'catch', matchers: [], actions: [{ type: 'forward', upstream: 'https://dns.google/dns-query' }] },
    ] },
    { id: 'lan', rules: [{ name: 'lan-ptr', matchers: [{ type: 'qtype', value: 'PTR' }], actions: [{ type: 'forward', upstream: '192.168.1.1' }] }] },
    { id: 'kids', rules: [{ name: 'kids-block', matchers: [{ type: 'geo_site', value: 'category-porn' }], actions: [{ type: 'static_ip_response', ip: '0.0.0.0' }] }, { name: 'kids-geo', matchers: [{ type: 'geo_site', value: 'geosite:cn' }], actions: [{ type: 'deny' }] }] },
    { id: 'special', rules: [{ name: 'sp', matchers: [{ type: 'any' }], actions: [{ type: 'allow' }] }] },
    { id: 'never', rules: [{ name: 'mx', actions: [{ type: 'deny' }] }] },
  ],
}
