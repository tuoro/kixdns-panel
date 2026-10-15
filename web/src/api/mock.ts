import { ApiError, PANEL_UNREACHABLE_EVENT } from './client'
import { exportConfig, panelHash, PANEL_FORMAT, readConfig } from '../config-model/document'
import { compile } from '../config-model/model'
import { sampleModel } from '../config-model/testing/samples'
import type {
  ActiveConfig,
  AuditPage,
  AuthSession,
  ConfigApplyResult,
  ConfigDocument,
  ConfigVersionDetail,
  DeleteConfigVersionResult,
  DeleteConfigVersionsResult,
  ConfigVersions,
  DnsDiagnostic,
  GeoDataBuiltin,
  GeositeCategories,
  GeoDataCleanupResult,
  GeoDataManifest,
  GeoDataSchedule,
  GeoDataSyncRequest,
  GithubTokenStatus,
  LogsResponse,
  Overview,
  InstalledKixdnsVersion,
  KixdnsKernel,
  RemoteKixdnsVersion,
  RequestTrend,
  ServiceStatus,
  UpdateNotifications,
  PanelUpdateStartResponse,
  PanelUpdateStatus,
  ValidationResult,
} from './types'
import { demoGeositeCategories } from './mock-geosite'

const now = Math.floor(Date.now() / 1000)
// 演示里已经「到来」的新日志行数，只在 kixdns:demo-log-growing 下增长。
// New log lines that have "arrived" in the demo; grows only under kixdns:demo-log-growing.
let demoLogArrivals = 0
const auditEvents = [
  { id: 18, actor: 'admin', action: 'config.save', detail: '版本 #18', created_at: now - 430 },
  { id: 17, actor: 'admin', action: 'config.geo_data.sync', detail: 'GeoIP\u00a0MMDB\u00a01\u00a0个、GeoIP\u00a0DAT\u00a00\u00a0个、GeoSite\u00a01\u00a0个', created_at: now - 7200 },
  { id: 16, actor: null, action: 'kixdns.kernel.replace_legacy', detail: '原来的内核已停止更新，自动从构建 #36374613990 换成 2026.10.13', created_at: now - 86400 },
  { id: 15, actor: 'admin', action: 'service.restart', detail: '服务状态：正在运行', created_at: now - 86520 },
  { id: 14, actor: 'admin', action: 'diagnostic.dns', detail: '执行 A 查询', created_at: now - 172800 },
  { id: 13, actor: 'admin', action: 'auth.login', detail: '', created_at: now - 173100 },
  { id: 12, actor: null, action: 'config.geo_data.schedule.apply', detail: '生成配置版本 #17', created_at: now - 604800 },
]
let config: ConfigDocument = {
  content: {
    version: '1.0',
    settings: {
      bind_udp: '0.0.0.0:53',
      bind_tcp: '0.0.0.0:53',
      cache_capacity: 20000,
      default_upstream: '1.1.1.1:53',
      upstream_timeout_ms: 1800,
      geoip_db_path: '/var/lib/kixdns-panel/geo/geoip-mmdb-4c425e120e43.mmdb',
      geosite_data_paths: ['/var/lib/kixdns-panel/geo/geosite-67b90a027f2c.dat'],
    },
    pipelines: [
      {
        id: 'default',
        rules: [
          {
            name: 'secure-forward',
            matchers: [{ type: 'any' }],
            actions: [{ type: 'forward', upstream: '1.1.1.1:53', transport: 'udp' }],
          },
        ],
      },
    ],
  },
  sha256: '45b9a1c0c7b55138a73d9d42ed9750e4532667c22eb79f74de2ca63619a5ce11',
  modified_at: now - 430,
  version_id: 18,
  pending: null,
  runtime: {
    status: 'active',
    active_sha256: '45b9a1c0c7b55138a73d9d42ed9750e4532667c22eb79f74de2ca63619a5ce11',
    generation: 18,
    apply_state: 'active',
    pending_error: null,
    declared_capabilities: ['config_query_stats_v1', 'config_static_cname_response_v1'],
  },
}

const activeConfig: ActiveConfig = {
  protocol_version: 1,
  generation: 18,
  sha256: config.sha256,
  loaded_at_unix: now - 430,
  reload_sequence: 24,
  last_reload: { success: true, error: null },
}

let geoData: GeoDataManifest = {
  geoip_mmdb: {
    url: 'https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-Country.mmdb',
    path: '/var/lib/kixdns-panel/geo/geoip-mmdb-4c425e120e43.mmdb',
    sha256: '4c425e120e43eaf45383ee0bf12302f83fd247bd4b421f7ecda38ab76e95f3e1',
    size: 6_438_912,
    downloaded_at: now - 7200,
  },
  geoip_dat: null,
  geosite: [{
    url: 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat',
    path: '/var/lib/kixdns-panel/geo/geosite-67b90a027f2c.dat',
    sha256: '67b90a027f2ce03cb94371723eec95bfb4ea7646691ba75e4b42a8b99f1465ee',
    size: 5_904_224,
    downloaded_at: now - 7200,
  }],
}

// 安装包自带的 GeoSite / The GeoSite the package brings along
const builtinGeosite: GeoDataBuiltin = {
  url: 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat',
  release: '202610122207',
  release_url: 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/tag/202610122207',
  published_at: '2026-10-12T22:08:31Z',
  sha256: '032108de31922356df8fea422323bca7ada1ffcf3b73064ecd8e86e520a241cf',
  size: 11_182_961,
}

// 以前装的、从没配过 GeoSite 的主机：Geo 设置里给出「导入」（kixdns:demo-geosite-empty）
// A host installed earlier that never configured GeoSite: the Geo settings offer 导入 (kixdns:demo-geosite-empty)
let geositeEmptied = false
function geositeEmptyIfAsked(): void {
  if (geositeEmptied || typeof localStorage === 'undefined' || localStorage.getItem('kixdns:demo-geosite-empty') !== 'true') return
  geositeEmptied = true
  geoData = { ...geoData, geosite: [] }
  delete (config.content.settings as Record<string, unknown>).geosite_data_paths
}

// 配置里另有一个面板读不到的 GeoSite 文件（kixdns:demo-geosite-unreadable）：分类照列，「分类不存在」的提醒停掉并说明原因
// The config names one more GeoSite file the panel cannot read (kixdns:demo-geosite-unreadable): categories still list, and the missing-category warning stops with the reason given
const unreadableGeosite = '/etc/kixdns/geosite-extra.dat'
let geositeUnreadableAdded = false
function geositeUnreadableIfAsked(): void {
  if (geositeUnreadableAdded || typeof localStorage === 'undefined' || localStorage.getItem('kixdns:demo-geosite-unreadable') !== 'true') return
  geositeUnreadableAdded = true
  const settings = config.content.settings as Record<string, unknown>
  const paths = Array.isArray(settings.geosite_data_paths) ? settings.geosite_data_paths : []
  settings.geosite_data_paths = [...paths, unreadableGeosite]
}

let geoDataSchedule: GeoDataSchedule = {
  interval_hours: 168,
  last_attempt_at: now - 7200,
  last_success_at: now - 7195,
  last_error: null,
  next_run_at: now + 168 * 3600 - 7200,
}

const session: AuthSession = {
  user: { id: 1, username: 'admin' },
  csrf_token: 'demo-csrf-token',
  expires_at: now + 36000,
}

/**
 * 演示用的 24 小时请求曲线：凌晨低谷、白天抬升、晚间见顶，
 * 和真实住宅网络的 DNS 负载形状一致。
 *
 * 合计 383.5 万，是按「运行 289420 秒、累计 1284.7 万次」折算出来的日均量。
 * 这两个数必须对得上：曲线旁写着「近 24 小时 X 次」，而同一条带子上就是累计值和
 * 运行时长，对不上的话一眼就能算出矛盾。
 *
 * The demo's 24-hour curve: a small-hours trough, a daytime rise and an evening
 * peak, the shape a real residential network's DNS load takes. It sums to
 * 3,835,000, derived from the demo's own 289,420 seconds of uptime and
 * 12,847,392 cumulative requests. The two have to agree: the curve is captioned
 * with its own 24-hour total on the same band as the lifetime figure and the
 * uptime, so a mismatch is one division away from being obvious.
 */
const trendShape = [
  89, 69, 56, 49, 46, 51, 73, 111, 149, 173, 183, 190, 199, 194, 187, 191, 203,
  226, 251, 270, 280, 259, 203, 133,
]

const requestTrend: RequestTrend = {
  bucket_seconds: 3600,
  points: trendShape.map((weight, index) => ({
    start_unix: now - (trendShape.length - index) * 3600,
    requests: weight * 1000,
  })),
  total: trendShape.reduce((sum, weight) => sum + weight, 0) * 1000,
}

const overview: Overview = {
  live: true,
  service_active: true,
  captured_at_unix: now,
  trend: requestTrend,
  health: {
    protocol_version: 1,
    status: 'ok',
    pid: 1428,
    version: '0.1.0',
    release_version: '2026.10.13',
    release_commit: '351d490c7bc05bc2638e5e70177bd9d9375e9028',
    upstream_commit: '42981abe52ce53271be50b430594e02601e8b615',
    patchset: 'unknown',
    started_at_unix: now - 289420,
    uptime_seconds: 289420,
    config_generation: 18,
    capabilities: ['stats_top_v1', 'config_static_cname_response_v1', 'metrics_upstream_precision_v1', 'diagnostics_trace_v1', 'diagnostics_trace_client_v1', 'diagnostics_trace_candidate_v1'],
  },
  active_config: activeConfig,
  metrics: {
    requests_total: 12_847_392,
    requests_inflight: 7,
    cache_lookups_total: 12_221_750,
    cache_hits_fresh: 10_083_118,
    cache_hits_stale: 139_422,
    cache_entries: 18_642,
    config_generation: 18,
    reload_success: 17,
    reload_failure: 1,
    pipelines: [
      { name: 'default', count: 8_914_380 },
      { name: 'domestic', count: 2_773_104 },
      { name: 'blocked', count: 1_159_908 },
    ],
    rules: [
      { pipeline: 'default', rule: 'secure-forward', phase: 'request', count: 7_902_414 },
      { pipeline: 'domestic', rule: 'cn-direct', phase: 'request', count: 2_773_104 },
      { pipeline: 'blocked', rule: 'deny-malware', phase: 'request', count: 1_159_908 },
      { pipeline: 'default', rule: 'accept-noerror', phase: 'response', count: 7_664_009 },
    ],
    upstreams: [
      { upstream: '1.1.1.1:53', transport: 'udp', attempts: 5_932_118, success: 5_901_774, errors: 28_230, rejected: 2_114, aborted: 0, avg_latency_ms: 12.4, rcodes: [{ name: 'NoError', count: 5_301_774 }, { name: 'NXDomain', count: 588_620 }, { name: 'ServFail', count: 11_380 }, { name: 'Refused', count: 2_114 }], tcp_fallbacks: 17_796, recent: { attempts: 18_320, success: 18_240, errors: 52, rejected: 28, aborted: 0, tcp_fallbacks: 61, avg_latency_ms: 11.9 } },
      { upstream: '223.5.5.5:53', transport: 'tcp_udp', attempts: 3_008_779, success: 1_491_664, errors: 15_909, rejected: 1_206, aborted: 1_500_000, avg_latency_ms: 9.1, rcodes: [{ name: 'NoError', count: 1_340_012 }, { name: 'NXDomain', count: 151_652 }, { name: 'Refused', count: 1_206 }], tcp_fallbacks: 0, recent: { attempts: 9_410, success: 4_690, errors: 21, rejected: 3, aborted: 4_696, tcp_fallbacks: 0, avg_latency_ms: 8.7 } },
      { upstream: 'dns.google/dns-query', transport: 'doh', attempts: 1_114_083, success: 1_104_572, errors: 8_780, rejected: 731, aborted: 0, avg_latency_ms: 28.6, rcodes: [{ name: 'NoError', count: 1_060_120 }, { name: 'NXDomain', count: 42_452 }, { name: 'Refused', count: 731 }], tcp_fallbacks: 0, recent: { attempts: 34, success: 32, errors: 1, rejected: 1, aborted: 0, tcp_fallbacks: 0, avg_latency_ms: 31.2 } },
    ],
    requests_finished: { completed: 12_796_002, failed: 38_541, cancelled: 12_849 },
    request_latency: { samples: 12_847_392, avg_ms: 13.8, within_10ms: 10_021_000, within_100ms: 12_501_318, within_1s: 12_790_000 },
    request_latency_recent: { samples: 58_210, avg_ms: 12.6, within_10ms: 47_558, within_100ms: 56_406, within_1s: 57_978 },
    cache_stale: { expired: 128_904, client_timeout: 9_314, upstream_failure: 1_204 },
    recent_window_seconds: 3_540,
  },
}

const queryStats = {
  protocol_version: 1,
  enabled: true,
  anonymized_clients: false,
  window_seconds: 86_400,
  retention_seconds: 86_400,
  generated_at_unix: now,
  requests_observed: 2_481_930,
  dropped_updates: 0,
  clients: [
    { name: '192.168.1.12', count: 692_481 },
    { name: '192.168.1.8', count: 514_932 },
    { name: '192.168.1.27', count: 388_104 },
    { name: '192.168.1.36', count: 247_681 },
    { name: '192.168.1.5', count: 194_206 },
  ],
  domains: [
    { name: 'api.github.com', count: 188_942 },
    { name: 'dns.google', count: 164_773 },
    { name: 'connectivitycheck.gstatic.com', count: 139_308 },
    { name: 'gateway.icloud.com', count: 108_621 },
    { name: 'clients4.google.com', count: 91_447 },
  ],
  live: true,
  captured_at_unix: now,
}

const versions: ConfigVersions = {
  versions: [
    { id: 18, sha256: config.sha256, message: '调整上游超时', actor: 'admin', created_at: now - 430, apply_state: 'applied', apply_error: null },
    { id: 17, sha256: 'cc5da21d', message: '新增国内解析管线', actor: 'admin', created_at: now - 86400, apply_state: 'applied', apply_error: null },
    { id: 16, sha256: '982ca084', message: '更新恶意域名规则', actor: 'admin', created_at: now - 172800, apply_state: 'applied', apply_error: null },
    { id: 15, sha256: '193bf884', message: '导入启动时配置', actor: 'system', created_at: now - 604800, apply_state: 'applied', apply_error: null },
  ],
}
let nextConfigVersionId = Math.max(...versions.versions.map((version) => version.id))
const configVersionContents = new Map(
  versions.versions.map((version) => [version.id, demoConfigVersion(version.id)]),
)

// 拿一个旧版本的内容存成新版本并生效：恢复版本，和演示里「别处恢复了一个版本」都走这里
// Store an old version's content as a new, active version: used by restore and by the demo's "someone elsewhere restored a version"
function activateCopy(sourceId: number, content: Record<string, unknown>, message: string): ConfigApplyResult {
  const sourceVersion = versions.versions.find((version) => version.id === sourceId)!
  const versionId = ++nextConfigVersionId
  config = {
    content: structuredClone(content),
    sha256: sourceVersion.sha256,
    modified_at: Math.floor(Date.now() / 1000),
    version_id: versionId,
    pending: null,
    runtime: {
      status: 'active',
      active_sha256: sourceVersion.sha256,
      generation: activeConfig.generation + 1,
      apply_state: 'active',
      pending_error: null,
      declared_capabilities: ['config_query_stats_v1', 'config_static_cname_response_v1'],
    },
  }
  activeConfig.sha256 = config.sha256
  activeConfig.generation += 1
  activeConfig.reload_sequence += 1
  versions.versions.unshift({
    id: versionId,
    sha256: config.sha256,
    message,
    actor: 'admin',
    created_at: config.modified_at,
    apply_state: 'applied',
    apply_error: null,
  })
  configVersionContents.set(versionId, structuredClone(content))
  return { version_id: versionId, sha256: config.sha256, apply_state: 'applied', active_config: activeConfig } as ConfigApplyResult
}

// kixdns:demo-changed-elsewhere：下一次读配置或「现在应用」之前，另一处（别的浏览器、别的管理员）恢复了一个旧版本，演示「这份配置在别处改过了」
// kixdns:demo-changed-elsewhere: just before the next config read or 现在应用, someone elsewhere (another browser, another admin) restored an older version,
// to show 这份配置在别处改过了
// kixdns:demo-apply-overtaken 只在「现在应用」到达时起作用（页面每 5 秒的读不会先用掉它）/ kixdns:demo-apply-overtaken acts only when 现在应用 arrives (the page's 5-second reads do not use it up first)
function changeElsewhereIfAsked(flag = 'kixdns:demo-changed-elsewhere'): void {
  if (typeof localStorage === 'undefined' || localStorage.getItem(flag) !== 'true') return
  localStorage.removeItem(flag)
  const source = versions.versions.find((version) => version.sha256 !== config.sha256 && configVersionContents.has(version.id))
  if (source) activateCopy(source.id, configVersionContents.get(source.id)!, `另一处恢复了版本 #${source.id}`)
}

// 旧版面板留下的一对组（kixdns:demo-old-copy）：编辑被两处共用的「global」时，旧面板复制出「global-copy」只改了其余请求，
// 国内回答被污染时的改问还指着原来的「global」。地址都是公共 DNS
// A pair the old panel left behind (kixdns:demo-old-copy): editing 「global」, used in two places, made it copy 「global-copy」 for the
// catch-all only, while the re-ask on a polluted domestic answer still points at the original. Every address is a public resolver
let oldCopyApplied = false
function oldCopyIfAsked(): void {
  if (oldCopyApplied || typeof localStorage === 'undefined' || localStorage.getItem('kixdns:demo-old-copy') !== 'true') return
  oldCopyApplied = true
  const forward = (id: string, upstream: string, extra: Record<string, unknown> = {}) => ({ id, rules: [{ name: `${id}_parallel`, matchers: [{ type: 'any' }], actions: [{ type: 'forward', upstream }], ...extra }] })
  config = {
    ...config,
    content: {
      ...config.content,
      pipeline_select: [
        { pipeline: 'cn', matchers: [{ type: 'geo_site', value: 'cn' }] },
        { pipeline: 'global-copy', matchers: [{ type: 'any' }] },
      ],
      pipelines: [
        forward('cn', 'https://doh.pub/dns-query, https://dns.alidns.com/dns-query', {
          response_matchers: [{ type: 'response_answer_ip', cidr: '0.0.0.0/32' }, { type: 'response_answer_ip', cidr: '240.0.0.0/4' }],
          response_matcher_operator: 'or',
          response_actions_on_match: [{ type: 'jump_to_pipeline', pipeline: 'global' }],
          response_actions_on_miss: [],
        }),
        forward('global', 'https://dns.quad9.net/dns-query'),
        forward('global-copy', 'https://dns.google/dns-query, https://cloudflare-dns.com/dns-query'),
      ],
    },
  }
}

// 请求分布按去向（kixdns:demo-destinations）：样本配置写成面板格式，概览的计数照它一步步走出来——
// 映射 2,140；主列表里拦截和自定义回答 9,620；公司 1,830、苹果服务 11,250（转发自带 ECS）、国内域名 41,900、内网反查 2,150（组里转公司 410、
// 其余转路由器 1,740）、防 DNS 重绑定 18,400（自带检查拦下 12），其余 41,180 去国外；回答后检查：公司转国内 36，国内污染转国外 260，
// 苹果服务的转发沿用国内的检查转国外 84。各去向合起来正好是总请求数，主列表和规则组只是路过
// Request destinations (kixdns:demo-destinations): the sample config in the panel's format, with overview counts walked through it step by
// step (the numbers above). The destinations add up to the total; the main list and the rule group are only passed through
let destinationsApplied = false
function destinationsIfAsked(): void {
  if (destinationsApplied || typeof localStorage === 'undefined' || localStorage.getItem('kixdns:demo-destinations') !== 'true') return
  destinationsApplied = true
  const model = sampleModel()
  config = { ...config, content: exportConfig(model) }
  const own = (name: string) => `rule-${model.rules.find((r) => r.name === name)!.id}`
  const [apple, rebind] = [own('苹果服务'), own('防 DNS 重绑定')]
  const answered = (pipeline: string, count: number) => ({ pipeline, rule: pipeline, phase: 'response' as const, count })
  const hit = (rule: string, count: number, pipeline = 'main') => ({ pipeline, rule, phase: 'request' as const, count })
  overview.metrics.requests_total = 128_470
  overview.metrics.pipelines = [
    { name: 'domain_mapping', count: 2_140 }, { name: 'main', count: 126_330 }, { name: 'group-lan', count: 2_150 },
    { name: 'upstream-corp', count: 2_240 }, { name: 'upstream-cn', count: 41_936 }, { name: apple, count: 11_250 },
    { name: 'upstream-router', count: 1_740 }, { name: rebind, count: 18_400 }, { name: 'upstream-abroad', count: 41_524 },
  ]
  overview.metrics.rules = [
    hit('国内域名', 41_900), hit('其余请求', 41_180), hit('防 DNS 重绑定', 18_400), hit('苹果服务', 11_250), hit('广告与跟踪', 9_100),
    hit('内网反查', 2_150), hit('公司内网', 1_830), hit('火狐 DoH 探测', 480), hit('版本查询', 40), hit('公司网段反查', 410, 'group-lan'),
    answered('upstream-cn', 260), answered(apple, 84), answered('upstream-corp', 36), answered(rebind, 12),
  ]
}

// v4.0.0 写出来的、规则组带监听标签的配置（kixdns:demo-listener-group）：读进来时监听标签挪成高级入口，规则组照常显示
// A config as v4.0.0 wrote it, with a listener label on a rule group (kixdns:demo-listener-group): on read the label becomes an advanced entry and the group shows as usual
let listenerGroupApplied = false
function listenerGroupIfAsked(): void {
  if (listenerGroupApplied || typeof localStorage === 'undefined' || localStorage.getItem('kixdns:demo-listener-group') !== 'true') return
  listenerGroupApplied = true
  const model = sampleModel()
  const kernel = compile(model) as unknown as Record<string, unknown> & { pipeline_select: { pipeline: string }[] }
  kernel.pipeline_select.splice(kernel.pipeline_select.findIndex((s) => s.pipeline !== 'domain_mapping'), 0, { pipeline: 'group-lan', matcher_operator: 'and', matchers: [{ type: 'listener_label', value: 'lan' }] } as { pipeline: string })
  const legacy = { ...model, ruleGroups: model.ruleGroups.map((g) => ({ ...g, listener: g.id === 'lan' ? 'lan' : '' })) }
  config = { ...config, content: { ...kernel, panel: { v: PANEL_FORMAT, hash: panelHash(kernel), model: legacy } } }
}

// 让待应用的版本原地生效：「现在应用」和演示里的「后台那一遍」都走这里 / Put the pending version into effect in place: used by 现在应用 and by the demo's "background pass"
function applyPendingInPlace(id: number): void {
  config = {
    ...config,
    pending: null,
    runtime: { ...config.runtime, status: 'active', active_sha256: config.sha256, generation: activeConfig.generation + 1, apply_state: 'active', pending_error: null },
  }
  activeConfig.sha256 = config.sha256
  activeConfig.generation += 1
  activeConfig.reload_sequence += 1
  versions.versions = versions.versions.map((v) => (v.id === id ? { ...v, apply_state: 'applied' } : v.apply_state === 'applied' ? { ...v, apply_state: 'superseded' } : v))
}

async function saveSlowIfAsked(): Promise<void> {
  const slow = typeof localStorage === 'undefined' ? null : localStorage.getItem('kixdns:demo-save-slow')
  if (slow === 'true' || Number(slow) > 0) await new Promise((resolve) => setTimeout(resolve, slow === 'true' ? 1500 : Number(slow)))
}

// 把一份内容存成待应用的新版本：KixDNS 在运行，只是还没接 / Store content as a new pending version: KixDNS runs and has just not taken it yet
function storePending(content: Record<string, unknown>, sha: string, versionId: number, createdAt: number, message: string): ConfigApplyResult {
  config = {
    ...config,
    content,
    sha256: sha,
    modified_at: createdAt,
    version_id: versionId,
    pending: { version_id: versionId, sha256: sha, message, actor: 'admin', created_at: createdAt, error: null },
    runtime: { ...config.runtime, status: 'pending', apply_state: 'pending', pending_error: null },
  }
  versions.versions.unshift({ id: versionId, sha256: sha, message, actor: 'admin', created_at: createdAt, apply_state: 'pending', apply_error: null })
  configVersionContents.set(versionId, structuredClone(content))
  return { version_id: versionId, sha256: sha, apply_state: 'pending' } as ConfigApplyResult
}

// kixdns:demo-elsewhere-pending：下一次读配置之前，另一处用面板存了一个待应用的新版本（面板的格式块完整，和真面板写的一样）：第一个上游组多了一个地址
// kixdns:demo-elsewhere-pending: just before the next config read, someone elsewhere stored a new pending version through the panel (its panel block intact,
// as a real panel writes it): the first upstream group has one more address
function elsewherePendingIfAsked(): void {
  if (typeof localStorage === 'undefined' || localStorage.getItem('kixdns:demo-elsewhere-pending') !== 'true') return
  localStorage.removeItem('kixdns:demo-elsewhere-pending')
  const model = readConfig(structuredClone(config.content)).model
  const group = model.groups[0]
  if (!group) return
  group.addresses.push({ address: '203.0.113.53', protocol: 'auto' })
  storePending(exportConfig(model), `else${Date.now().toString(16)}`.padEnd(64, '0').slice(0, 64), ++nextConfigVersionId, Math.floor(Date.now() / 1000), '另一处加了一个上游地址')
}

// kixdns:demo-background-applies：下一次读配置之前，面板后台那一遍（真面板每 5 秒）让待应用的版本生效了
// kixdns:demo-background-applies: just before the next config read, the panel's background pass (every 5 s on a real panel) put the pending version into effect
function backgroundAppliesIfAsked(): void {
  if (typeof localStorage === 'undefined' || localStorage.getItem('kixdns:demo-background-applies') !== 'true') return
  if (!config.pending || config.pending.error) return
  localStorage.removeItem('kixdns:demo-background-applies')
  applyPendingInPlace(config.pending.version_id!)
}

function demoConfigVersion(id: number): Record<string, unknown> {
  const content = structuredClone(config.content)
  const settings = content.settings as Record<string, unknown>
  const pipelines = content.pipelines as Array<Record<string, unknown>>
  if (id === 17) {
    settings.upstream_timeout_ms = 2200
    pipelines.push({ id: 'domestic', rules: [] })
  } else if (id === 16) {
    settings.upstream_timeout_ms = 2500
    pipelines.push({ id: 'blocked', rules: [{ name: 'deny-malware', matchers: [], actions: [] }] })
  } else if (id === 15) {
    settings.upstream_timeout_ms = 3000
    delete settings.geoip_db_path
    delete settings.geosite_data_paths
  }
  return content
}

function currentConfigVersionId(): number | null {
  const formalVersion = versions.versions.find((version) => version.apply_state === 'applied')
  return config.pending?.version_id
    ? formalVersion?.id ?? null
    : formalVersion?.id ?? config.version_id
}

function removeConfigVersions(ids: number[], unavailable: boolean): void {
  const removesPending = ids.includes(config.pending?.version_id ?? -1)
  versions.versions = versions.versions.filter((version) => !ids.includes(version.id))
  ids.forEach((id) => configVersionContents.delete(id))
  if (!removesPending) return

  const formalVersion = versions.versions.find((version) => version.apply_state === 'applied')
  const formalContent = formalVersion ? configVersionContents.get(formalVersion.id) : undefined
  if (!formalVersion || !formalContent) return
  config = {
    ...config,
    content: structuredClone(formalContent),
    sha256: formalVersion.sha256,
    modified_at: formalVersion.created_at,
    version_id: formalVersion.id,
    pending: null,
    runtime: {
      ...config.runtime,
      status: unavailable ? 'unavailable' : 'active',
      active_sha256: formalVersion.sha256,
      apply_state: unavailable ? 'unavailable' : 'active',
      pending_error: null,
    },
  }
}

let serviceRunning = true
// 在线更新失败只在置上这个标记时演示，和 kixdns:demo-empty-first-install 是同一套做法。
// A failed online update is shown only under this flag, mirroring kixdns:demo-empty-first-install.
let panelUpdateStatus: PanelUpdateStatus = typeof localStorage !== 'undefined'
  && localStorage.getItem('kixdns:demo-panel-update-failed') === 'true'
  ? {
      state: 'failed',
      message: '在线更新失败：下载安装包失败，面板还是原来的版本。检查网络后再点一次在线更新',
      target_version: 'v1.0.1',
      updated_at: 1_789_000_000,
    }
  : {
      state: 'idle',
      message: '',
      target_version: '',
      updated_at: 0,
    }
let githubTokenConfigured = false
const binarySha256 = '8943ba8bd01409a89ef3279b6ed06364d6867512c75ad693f75e52428718c1c6'
const forkUpstreamCommit = '42981abe52ce53271be50b430594e02601e8b615'

function forkVersion(
  sourceId: number,
  tag: string,
  commit: string,
  digest: string,
  createdAt: string,
  configCapabilities: string[],
): RemoteKixdnsVersion {
  const artifact = `kixdns-${tag}-linux-x86_64.zip`
  return {
    source: 'fork',
    source_id: sourceId,
    commit,
    release_tag: tag,
    upstream_commit: forkUpstreamCommit,
    created_at: createdAt,
    source_url: `https://github.com/olicesx/kixdns/commit/${forkUpstreamCommit}`,
    build_url: `https://github.com/tuoro/kixdns/releases/tag/${tag}`,
    artifact,
    artifact_digest: digest,
    download_url: `https://github.com/tuoro/kixdns/releases/download/${tag}/${artifact}`,
    control_protocol: 1,
    config_capabilities: configCapabilities,
  }
}

// 演示状态要自洽：在用的是上一个日期版本，最新的还没装，所以「有更新」成立，系统页「从哪到哪」两端是不同的值；
// 最新版本比在装的多认一项配置，更新之后才拿得到。本机还留着面板改用 fork 发布之前的 p28 内核，回退才有去处。
// The demo state has to be self-consistent: the previous date version is in use and the newest is not installed, so
// "update available" holds and the system page's from → to has two different ends; the newest version knows one more
// config field, gained only by updating. The p28 kernel from before the panel moved to fork releases is still kept on the
// host, so a rollback has somewhere to go.
const latestKixdnsVersion = forkVersion(
  637381241,
  '2026.10.13.2',
  '527ae0a023c81094d80c949d844dbc7d1da85b32',
  'sha256:e704a45cfda8e009e1d13d2cc516ad88a7fdfa9a9d11f46712947de8e9e19913',
  '2026-10-13T09:12:40Z',
  ['config_query_stats_v1', 'config_static_cname_response_v1'],
)
const installedForkVersion = forkVersion(
  637165884,
  '2026.10.13',
  '351d490c7bc05bc2638e5e70177bd9d9375e9028',
  'sha256:688d377d1421990e2ec54e7675fbebb3b0d11203f798599b4855e1aa26c60a12',
  '2026-10-13T04:40:07Z',
  ['config_query_stats_v1'],
)

function installedFromRelease(remote: RemoteKixdnsVersion, active: boolean, installedAt: number): InstalledKixdnsVersion {
  return {
    source: remote.source,
    source_id: remote.source_id,
    commit: remote.commit,
    run_id: null,
    release_tag: remote.release_tag,
    created_at: remote.created_at,
    source_url: remote.source_url,
    build_url: remote.build_url,
    artifact: remote.artifact,
    artifact_digest: remote.artifact_digest,
    upstream_repository: 'olicesx/kixdns',
    upstream_commit: remote.upstream_commit,
    patchset: null,
    dependency_revision: null,
    control_protocol: remote.control_protocol,
    config_capabilities: [...remote.config_capabilities],
    binary_sha256: binarySha256,
    installed_at: installedAt,
    active,
  }
}

// 面板以前自己按补丁集构建的内核：只会是本机装过的，远端不再提供。
// The kernel the panel used to build itself from a patchset: only ever one installed here, never offered remotely.
const legacyActionKernel: InstalledKixdnsVersion = {
  source: 'action',
  source_id: 4521730188,
  commit: '681d813a73f4525dfe97bf3123894b8b714d35d9',
  run_id: 36374613990,
  release_tag: null,
  created_at: '2026-10-06T21:14:03Z',
  source_url: 'https://github.com/olicesx/kixdns/actions/runs/36374613990',
  build_url: 'https://github.com/tuoro/kixdns-panel/actions/runs/37492061459',
  artifact: 'kixdns-enhanced-action-36374613990-p28-f6c68944ce5c-linux-x86_64',
  artifact_digest: 'sha256:fbab891acbe0dcc377893694f92a52b0cf3602915e69bca436b067a28e2c0dfc',
  upstream_repository: 'olicesx/kixdns',
  upstream_commit: forkUpstreamCommit,
  patchset: 28,
  dependency_revision: 1,
  control_protocol: 1,
  config_capabilities: ['config_query_stats_v1'],
  binary_sha256: '1d4339431769964db35fb895b96dff743ad60109ea10133eb193e3c3d650d60b',
  installed_at: now - 86_400,
  active: false,
}

let activeKixdnsVersion: InstalledKixdnsVersion = installedFromRelease(installedForkVersion, true, now)
let previousKixdnsVersion: InstalledKixdnsVersion | null = legacyActionKernel

const activeIsLatest = () => activeKixdnsVersion.source_id === latestKixdnsVersion.source_id

// 内核检查失败只在置上这个标记时演示，和 kixdns:demo-empty-first-install 是同一套做法：
// 匿名配额用完时读不到最新内核，面板的更新照样能查到。
// A failed kernel check is shown only under this flag, mirroring kixdns:demo-empty-first-install:
// with the anonymous quota spent the newest kernel cannot be read, while the panel update still can.
const KERNEL_CHECK_ERROR = 'GitHub 匿名访问次数用完了'

function traceJoins(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-trace-joined') === 'true'
}

function kernelCheckFails(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-kernel-check-failed') === 'true'
}

function demoKernel(): KixdnsKernel {
  const failed = kernelCheckFails()
  return {
    binary_present: true,
    active: { ...activeKixdnsVersion, active: true },
    previous: previousKixdnsVersion ? { ...previousKixdnsVersion, active: false } : null,
    latest: failed ? null : latestKixdnsVersion,
    remote_error: failed ? KERNEL_CHECK_ERROR : null,
  }
}

async function mockDraftTrial(domain: string, recordType: string, client: string, config: Record<string, unknown>): Promise<DnsDiagnostic> {
  const { simulate } = await import('../config-model/testing/kernel-sim')
  const sim = simulate(config as Parameters<typeof simulate>[0], { domain: domain.toLowerCase().replace(/\.$/, ''), client, qtype: recordType }, (upstreams) => ({
    rcode: 'NOERROR', answers: [`${domain}. 300 IN A 104.18.26.120`], upstream: upstreams[0] ?? '',
  }))
  const trace: DnsDiagnostic['trace'] = [
    { stage: 'request', status: 'parsed', label: `${recordType} ${domain}`, detail: `客户端：${client}；监听器：default`, elapsed_ms: 0 },
  ]
  let pipeline = ''
  for (const step of sim.steps.filter((one) => one.phase === 'request')) {
    if (step.pipeline !== pipeline) { pipeline = step.pipeline; trace.push({ stage: 'pipeline', status: 'selected', label: pipeline, detail: null, elapsed_ms: 0 }) }
    trace.push({ stage: 'rule', status: 'matched', label: step.rule, detail: `管线：${step.pipeline}；匹配器数：1`, elapsed_ms: 1 })
    // 和真内核同一种写法：转发写目标，其余写静态响应 / Worded as the real kernel: a forward names its target, anything else is a static response
    trace.push(step.decision.startsWith('forward')
      ? { stage: 'decision', status: 'selected', label: `规则 ${step.rule} 转发`, detail: `目标：${step.decision.replace(/^forward:?\s*/, '') || '上游'}`, elapsed_ms: 1 }
      : { stage: 'decision', status: 'selected', label: `静态响应 ${sim.rcode}`, detail: `答案记录数：${sim.answers.length}`, elapsed_ms: 1 })
  }
  const rcode = sim.rcode === 'NOERROR' ? 'No Error' : sim.rcode === 'NXDOMAIN' ? 'Non-Existent Domain' : sim.rcode === 'REFUSED' ? 'Query Refused' : sim.rcode
  return {
    server: 'KixDNS 草稿试跑', domain, record_type: recordType, response_code: rcode, elapsed_ms: 14, truncated: false,
    answers: sim.answers.map((a) => (a.includes(' IN ') ? a : `${domain}. 300 IN A ${a}`)),
    trace_supported: true, trace_truncated: false, trace, client_ip: client, source: 'draft',
  }
}

// kixdns:demo-read-slow：读取的回答要 1.5 秒才到，读到的是发出时面板上的样子（和真的慢网络一样：中途别的写入落地了，这次读到的仍是旧的）；
// 用来演示各页读完之前的占位，也用来测读回来时文件已经变了的情况
// kixdns:demo-read-slow: a read's answer takes 1.5 s to arrive and holds what the panel had when it was sent (as on a real slow network: a write landing
// meanwhile does not change it); shows each page's placeholder before the read lands, and tests a read that returns after the file moved
export async function mockRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET'
  const slowRead = method === 'GET' && typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-read-slow') === 'true'
  await new Promise((resolve) => setTimeout(resolve, 120))
  const answer = await mockAnswer<T>(path, init)
  if (slowRead) await new Promise((resolve) => setTimeout(resolve, 1380))
  return answer
}

async function mockAnswer<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET'
  const url = new URL(path, 'http://panel.local')
  const pathname = url.pathname
  // 同上：让初始化页也能在演示里看到，否则它的用例只能永远跳过。
  if (path === '/api/v1/setup' && method === 'GET') {
    const required = typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-setup-required') === 'true'
    return { required } as T
  }
  // 演示模式默认已登录。置上这个标记可以看到认证页本身，
  // 和 kixdns:demo-empty-first-install 是同一套做法。
  // The demo is signed in by default; this flag exposes the auth pages
  // themselves, mirroring how kixdns:demo-empty-first-install works.
  if (path === '/api/v1/auth/session') {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-signed-out') === 'true') {
      throw new ApiError('会话已失效', 401, 'unauthorized')
    }
    return session as T
  }
  if (path === '/api/v1/auth/login' || path === '/api/v1/setup') return session as T
  if (path === '/api/v1/auth/logout') return { ok: true } as T
  const emptyFirstInstall = typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-empty-first-install') === 'true'
  if (path === '/api/v1/overview') {
    if (emptyFirstInstall) throw new Error('KixDNS 已停止')
    destinationsIfAsked()
    return overview as T
  }
  if (pathname === '/api/v1/stats/top' && method === 'GET') {
    queryStats.window_seconds = Number(url.searchParams.get('window')) || 86_400
    // 旧内核、配置里没打开排行（kixdns:demo-stats-off）：新内核开了控制通道就一直统计，只有旧内核会这样回
    // An older kernel with rankings off in its config (kixdns:demo-stats-off): newer kernels always rank once the control socket is open
    if (typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-stats-off') === 'true') return { ...queryStats, enabled: false, requests_observed: 0, dropped_updates: 0, clients: [], domains: [] } as T
    return queryStats as T
  }
  if (path === '/api/v1/stats/clear' && method === 'POST') {
    queryStats.requests_observed = 0
    queryStats.clients = []
    queryStats.domains = []
    return { protocol_version: 1, cleared: true } as T
  }
  if (path === '/api/v1/service' && method === 'GET') {
    if (emptyFirstInstall) return { unit: 'kixdns.service', active_state: 'inactive', sub_state: 'dead', main_pid: 0 } as T
    return { unit: 'kixdns.service', active_state: serviceRunning ? 'active' : 'inactive', sub_state: serviceRunning ? 'running' : 'dead', main_pid: serviceRunning ? 1428 : 0 } as T
  }
  if (path.startsWith('/api/v1/service/') && method === 'POST') {
    serviceRunning = !path.endsWith('/stop')
    return { unit: 'kixdns.service', active_state: serviceRunning ? 'active' : 'inactive', sub_state: serviceRunning ? 'running' : 'dead', main_pid: serviceRunning ? 1428 : 0 } as T
  }
  if (path === '/api/v1/kixdns/kernel' && method === 'GET') {
    return demoKernel() as T
  }
  // 与服务端一致：只装界面上看到的那个最新版本，换内核保持原来的启停状态。
  // Matches the server: only the newest version the page showed is installed, and
  // switching keeps the service's running state.
  if (path === '/api/v1/kixdns/kernel/update' && method === 'POST') {
    const body = JSON.parse(String(init?.body)) as { source_id: number }
    if (body.source_id !== latestKixdnsVersion.source_id) {
      throw new ApiError('没有更新内核：又发布了更新的版本，点「检查更新」看过后再更新', 409, 'update_conflict')
    }
    if (!activeIsLatest()) {
      previousKixdnsVersion = activeKixdnsVersion
      activeKixdnsVersion = installedFromRelease(latestKixdnsVersion, true, Math.floor(Date.now() / 1000))
    }
    return demoKernel() as T
  }
  if (path === '/api/v1/kixdns/kernel/rollback' && method === 'POST') {
    if (!previousKixdnsVersion) throw new ApiError('本机没有上一个内核', 409, 'update_conflict')
    const current = activeKixdnsVersion
    activeKixdnsVersion = previousKixdnsVersion
    previousKixdnsVersion = current
    return demoKernel() as T
  }
  if (path === '/api/v1/config' && method === 'GET') {
    oldCopyIfAsked()
    destinationsIfAsked()
    listenerGroupIfAsked()
    geositeEmptyIfAsked()
    geositeUnreadableIfAsked()
    changeElsewhereIfAsked()
    backgroundAppliesIfAsked()
    elsewherePendingIfAsked()
    return config as T
  }
  if (path === '/api/v1/config/geo-data' && method === 'GET') {
    geositeEmptyIfAsked()
    return geoData as T
  }
  if (path === '/api/v1/config/geo-data/builtin' && method === 'GET') return builtinGeosite as T
  // 和服务端一样：读配置和清单里的文件，没读到的给原因；内置那份另给。分类都用同一份演示数据
  // Like the server: the config's and the manifest's files, unread ones with a reason, and the built-in one apart; every file shares the demo categories
  if (path === '/api/v1/config/geo-data/geosite-categories' && method === 'GET') {
    geositeEmptyIfAsked()
    geositeUnreadableIfAsked()
    const known = new Map(geoData.geosite.map((resource) => [resource.path, resource.sha256]))
    const configured = (config.content.settings as Record<string, unknown>).geosite_data_paths
    const paths = [...new Set([...(Array.isArray(configured) ? configured.filter((p): p is string => typeof p === 'string') : []), ...known.keys()])]
    const files = paths.map((p) => (known.has(p) ? { path: p, sha256: known.get(p)!, error: null } : { path: p, sha256: null, error: p === unreadableGeosite ? '面板没有权限读这个文件' : '文件不存在' }))
    const digests = new Set([...files.map((file) => file.sha256).filter((sha): sha is string => Boolean(sha)), builtinGeosite.sha256])
    return {
      files,
      builtin: { path: '/usr/share/kixdns-panel/geo/geosite.dat', sha256: builtinGeosite.sha256, error: null },
      catalogs: Object.fromEntries([...digests].map((sha) => [sha, demoGeositeCategories])),
    } satisfies GeositeCategories as T
  }
  // 和服务端一样：只在还没有 GeoSite 数据时导入，用户自己选的来源不被换掉
  // Matches the server: import only while there is no GeoSite data, so a source the user chose is never replaced
  if (path === '/api/v1/config/geo-data/builtin' && method === 'POST') {
    if (geoData.geosite.length > 0) throw new ApiError('已经有 GeoSite 数据了：要换成内置的那份，先删掉现有的链接并保存', 400, 'geo_data_invalid')
    geoData = {
      ...geoData,
      geosite: [{
        url: builtinGeosite.url,
        path: `/var/lib/kixdns-panel/geo/geosite-${builtinGeosite.sha256}.dat`,
        sha256: builtinGeosite.sha256,
        size: builtinGeosite.size,
        downloaded_at: Math.floor(Date.now() / 1000),
      }],
    }
    return geoData as T
  }
  if (path === '/api/v1/config/geo-data/cleanup' && method === 'POST') {
    return { scanned_files: 4, removed_files: 1, reclaimed_bytes: 5_904_224 } as GeoDataCleanupResult as T
  }
  if (path === '/api/v1/config/geo-data/schedule' && method === 'GET') return geoDataSchedule as T
  if (path === '/api/v1/config/geo-data/schedule' && method === 'PUT') {
    const body = JSON.parse(String(init?.body)) as { interval_hours: number | null }
    if (![null, 24, 168].includes(body.interval_hours)) throw new Error('Geo 自动更新仅支持每天或每周')
    if (body.interval_hours !== null && !geoData.geoip_mmdb && !geoData.geoip_dat && geoData.geosite.length === 0) {
      throw new Error('请先配置并下载至少一个远程 Geo 数据源')
    }
    if (geoDataSchedule.interval_hours !== body.interval_hours) {
      geoDataSchedule = {
        ...geoDataSchedule,
        interval_hours: body.interval_hours as 24 | 168 | null,
        last_attempt_at: null,
        last_error: null,
        next_run_at: body.interval_hours === null ? null : Math.floor(Date.now() / 1000),
      }
    }
    return geoDataSchedule as T
  }
  if (path === '/api/v1/config/geo-data/sync' && method === 'POST') {
    const body = JSON.parse(String(init?.body)) as GeoDataSyncRequest
    const resource = (url: string, prefix: string, extension: string, index = 0) => ({
      url,
      path: `/var/lib/kixdns-panel/geo/${prefix}-demo${Date.now().toString(16)}${index}.${extension}`,
      sha256: `demo${Date.now().toString(16)}${index}`.padEnd(64, '0').slice(0, 64),
      size: 5_904_224 + index * 1024,
      downloaded_at: Math.floor(Date.now() / 1000),
    })
    geoData = {
      geoip_mmdb: body.geoip_mmdb_url ? resource(body.geoip_mmdb_url, 'geoip-mmdb', 'mmdb') : null,
      geoip_dat: body.geoip_dat_url ? resource(body.geoip_dat_url, 'geoip-dat', body.geoip_dat_url.endsWith('.json') ? 'json' : 'dat') : null,
      geosite: body.geosite_urls.map((url, index) => resource(url, 'geosite', url.endsWith('.json') ? 'json' : 'dat', index)),
    }
    return geoData as T
  }
  if (path === '/api/v1/config/versions' && method === 'GET') return versions as T
  if (path === '/api/v1/config/versions/bulk' && method === 'DELETE') {
    const body = JSON.parse(String(init?.body)) as { ids: number[]; expected_sha256: string }
    if (body.expected_sha256 !== config.sha256) throw new Error('这份配置在别处改过了，先重新读取')
    const ids = [...new Set(body.ids)].sort((left, right) => left - right)
    if (ids.length === 0) throw new Error('还没选要删除的版本')
    if (ids.length > 100 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
      throw new Error('配置版本 ID 无效')
    }
    if (ids.includes(currentConfigVersionId() ?? -1)) {
      throw new Error('正在用的版本不能删除：先恢复别的版本')
    }
    if (ids.some((id) => !versions.versions.some((version) => version.id === id))) {
      throw new Error('配置文件不存在')
    }
    removeConfigVersions(ids, emptyFirstInstall)
    return { deleted_ids: ids } as DeleteConfigVersionsResult as T
  }
  const configVersionMatch = pathname.match(/^\/api\/v1\/config\/versions\/(\d+)$/)
  if (configVersionMatch && method === 'GET') {
    const id = Number(configVersionMatch[1])
    const version = versions.versions.find((item) => item.id === id)
    const content = configVersionContents.get(id)
    if (!version || !content) throw new Error('配置文件不存在')
    return { ...version, content: structuredClone(content) } as ConfigVersionDetail as T
  }
  if (configVersionMatch && method === 'DELETE') {
    const body = JSON.parse(String(init?.body)) as { expected_sha256: string }
    // 与后端 ConfigStore::delete_version 保持一致：待应用时校验编辑中的候选 SHA。
    if (body.expected_sha256 !== config.sha256) throw new Error('这份配置在别处改过了，先重新读取')
    const id = Number(configVersionMatch[1])
    if (id === currentConfigVersionId()) throw new Error('正在用的版本不能删除：先恢复别的版本')
    const index = versions.versions.findIndex((version) => version.id === id)
    if (index < 0) throw new Error('配置文件不存在')
    removeConfigVersions([id], emptyFirstInstall)
    return { deleted_id: id } as DeleteConfigVersionResult as T
  }
  if (path === '/api/v1/config/validate') {
    // kixdns:demo-validate-slow：校验要 1.5 秒，演示校验途中按保存、离开页面 / kixdns:demo-validate-slow: validation takes 1.5 s, to show saving or leaving while it runs
    if (typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-validate-slow') === 'true') await new Promise((resolve) => setTimeout(resolve, 1500))
    // kixdns:demo-validate-stopped：下一次校验撞上 KixDNS 刚停掉（控制接口不在了），演示保存时才发现停了的样子
    // kixdns:demo-validate-stopped: the next validation finds KixDNS just stopped (the control socket is gone), showing a stop discovered while saving
    if (typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-validate-stopped') === 'true') {
      localStorage.removeItem('kixdns:demo-validate-stopped')
      throw new ApiError('KixDNS 已停止', 503, 'kixdns_unavailable')
    }
    // kixdns:demo-validate-reject：下一次校验被内核拒绝（真内核对它不接受的配置回 422 kixdns_rejected）
    // kixdns:demo-validate-reject: the next validation is rejected by the kernel (a real kernel answers 422 kixdns_rejected for a config it refuses)
    if (typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-validate-reject') === 'true') {
      localStorage.removeItem('kixdns:demo-validate-reject')
      throw new ApiError('pipeline "main" references unknown upstream group "fast"', 422, 'kixdns_rejected')
    }
    const content = JSON.parse(String(init?.body)) as Record<string, unknown>
    const pipelines = Array.isArray(content.pipelines) ? content.pipelines : []
    return { protocol_version: 1, valid: true, pipeline_count: pipelines.length, rule_count: 1 } as T
  }
  if (path === '/api/v1/config' && method === 'PUT') {
    const body = JSON.parse(String(init?.body)) as { content: Record<string, unknown>; expected_sha256: string; message?: string }
    // 和真服务一样带 config_conflict，页面才认得出是别处先存了；kixdns:demo-save-conflict 让下一次保存撞上，演示这个状态
    // Carries config_conflict as the real server does, so the page knows someone else saved first; kixdns:demo-save-conflict makes
    // the next save hit it, to show that state
    // kixdns:demo-save-slow：写入要 1.5 秒（写个数字就是那么多毫秒），演示保存途中还能改 / kixdns:demo-save-slow: writing takes 1.5 s (or that many ms when a number), to show editing while a save is in flight
    await saveSlowIfAsked()
    const forcedConflict = typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-save-conflict') === 'true'
    if (forcedConflict) localStorage.removeItem('kixdns:demo-save-conflict')
    if (forcedConflict || body.expected_sha256 !== config.sha256) throw new ApiError('这份配置在别处改过了，先重新读取', 409, 'config_conflict')
    const nextSha = `demo${Date.now().toString(16)}`.padEnd(64, '0').slice(0, 64)
    const versionId = ++nextConfigVersionId
    const createdAt = Math.floor(Date.now() / 1000)
    const message = body.message?.trim() || '更新配置'
    // kixdns:demo-apply-failed：写进去了，KixDNS 却没接受（真面板会放回旧文件、把这个版本记成没有生效，回 422 reload_failed）
    // kixdns:demo-apply-failed: written, but KixDNS did not take it (a real panel puts the old file back, records the version as failed and answers 422 reload_failed)
    if (typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-apply-failed') === 'true') {
      localStorage.removeItem('kixdns:demo-apply-failed')
      const error = 'KixDNS 没有接受这份配置：upstream "fast" did not answer the health check，仍在用之前的配置'
      // 真面板读回来的版本号是这个没生效的版本（desired() 返回它） / A real panel reads back the failed version's id (desired() returns it)
      config = {
        ...config,
        content: body.content,
        sha256: nextSha,
        modified_at: createdAt,
        version_id: versionId,
        pending: { version_id: versionId, sha256: nextSha, message, actor: 'admin', created_at: createdAt, error },
        runtime: { ...config.runtime, status: 'failed', apply_state: 'failed', pending_error: error },
      }
      versions.versions.unshift({ id: versionId, sha256: nextSha, message, actor: 'admin', created_at: createdAt, apply_state: 'failed', apply_error: error })
      configVersionContents.set(versionId, structuredClone(body.content))
      throw new ApiError(error, 422, 'reload_failed')
    }
    // kixdns:demo-save-pending：KixDNS 在运行，这次保存时却没及时回应，先存成待应用（真面板后台每 5 秒会自己补上；演示里留着，好按「现在应用」）
    // kixdns:demo-save-pending: KixDNS is running but did not answer in time for this save, so it is stored as pending (a real panel's background
    // pass applies it within 5 seconds; the demo leaves it, so 现在应用 can be pressed)
    if (typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-save-pending') === 'true') {
      localStorage.removeItem('kixdns:demo-save-pending')
      return storePending(body.content, nextSha, versionId, createdAt, message) as T
    }
    if (emptyFirstInstall) {
      config = {
        ...config,
        content: body.content,
        sha256: nextSha,
        modified_at: createdAt,
        version_id: versionId,
        pending: {
          version_id: versionId,
          sha256: nextSha,
          message,
          actor: 'admin',
          created_at: createdAt,
          error: null,
        },
        runtime: {
          status: 'unavailable',
          active_sha256: config.runtime.active_sha256,
          generation: config.runtime.generation,
          apply_state: 'pending',
          pending_error: null,
          declared_capabilities: ['config_query_stats_v1', 'config_static_cname_response_v1'],
        },
      }
      versions.versions.unshift({
        id: versionId,
        sha256: nextSha,
        message,
        actor: 'admin',
        created_at: createdAt,
        apply_state: 'pending',
        apply_error: null,
      })
      configVersionContents.set(versionId, structuredClone(body.content))
      return { version_id: versionId, sha256: nextSha, apply_state: 'pending' } as ConfigApplyResult as T
    }
    config = {
      ...config,
      content: body.content,
      sha256: nextSha,
      modified_at: createdAt,
      version_id: versionId,
      pending: null,
      runtime: {
        status: 'active',
        active_sha256: nextSha,
        generation: activeConfig.generation + 1,
        apply_state: 'active',
        pending_error: null,
        declared_capabilities: ['config_query_stats_v1', 'config_static_cname_response_v1'],
      },
    }
    activeConfig.sha256 = nextSha
    activeConfig.generation += 1
    activeConfig.reload_sequence += 1
    versions.versions.unshift({
      id: versionId,
      sha256: nextSha,
      message,
      actor: 'admin',
      created_at: config.modified_at,
      apply_state: 'applied',
      apply_error: null,
    })
    configVersionContents.set(versionId, structuredClone(body.content))
    // kixdns:demo-put-answer-lost：写进去了、也生效了，回应却没回来（面板在保存途中重启那样） / Written and applied, but the answer never arrives (as when the panel restarts mid-save)
    if (typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-put-answer-lost') === 'true') {
      localStorage.removeItem('kixdns:demo-put-answer-lost')
      window.dispatchEvent(new Event(PANEL_UNREACHABLE_EVENT))
      throw new ApiError('连不上面板：网络断了，或者面板正在重启。稍后再试。', 0, 'network_unreachable')
    }
    return { version_id: versionId, sha256: config.sha256, apply_state: 'applied', active_config: activeConfig } as ConfigApplyResult as T
  }
  // 让待应用的版本原地生效：不新建版本，编号和备注都不变；已经生效了照实回，待应用的换了就是冲突（和真面板一样）
  // Put the pending version into effect in place: no new version, its number and note stay; already in effect answers so, and a changed pending
  // version is a conflict (as on the real panel)
  const applyMatch = pathname.match(/^\/api\/v1\/config\/versions\/(\d+)\/apply$/)
  if (applyMatch && method === 'POST') {
    const id = Number(applyMatch[1])
    changeElsewhereIfAsked()
    changeElsewhereIfAsked('kixdns:demo-apply-overtaken')
    await saveSlowIfAsked()
    // kixdns:demo-apply-error：下一次「现在应用」面板内部出错（什么都没写） / kixdns:demo-apply-error: the next 现在应用 meets an internal panel error (nothing written)
    if (typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-apply-error') === 'true') {
      localStorage.removeItem('kixdns:demo-apply-error')
      throw new ApiError('面板内部出错', 500, 'internal_error')
    }
    if (!config.pending && config.version_id === id) return { version_id: id, sha256: config.sha256, apply_state: 'applied', active_config: activeConfig } as ConfigApplyResult as T
    // 刚试过、没有生效的这一版：照它记下的原因说（和真面板一样），不说别处改过 / This version just tried and refused: say why, as the real panel does, not 别处改过
    if (config.pending?.version_id === id && config.pending.error) throw new ApiError(config.pending.error, 422, 'reload_failed')
    if (config.pending?.version_id !== id) throw new ApiError('这份配置在别处改过了，先重新读取', 409, 'config_conflict')
    if (typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-apply-failed') === 'true') {
      localStorage.removeItem('kixdns:demo-apply-failed')
      const error = 'KixDNS 没有接受这份配置：upstream "fast" did not answer the health check，仍在用之前的配置'
      config = { ...config, pending: { ...config.pending, error }, runtime: { ...config.runtime, status: 'failed', apply_state: 'failed', pending_error: error } }
      versions.versions = versions.versions.map((v) => (v.id === id ? { ...v, apply_state: 'failed', apply_error: error } : v))
      throw new ApiError(error, 422, 'reload_failed')
    }
    applyPendingInPlace(id)
    // kixdns:demo-put-answer-lost 对这里也管用：生效了，回应却没回来 / kixdns:demo-put-answer-lost applies here too: in effect, but the answer never arrives
    if (typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-put-answer-lost') === 'true') {
      localStorage.removeItem('kixdns:demo-put-answer-lost')
      window.dispatchEvent(new Event(PANEL_UNREACHABLE_EVENT))
      throw new ApiError('连不上面板：网络断了，或者面板正在重启。稍后再试。', 0, 'network_unreachable')
    }
    return { version_id: id, sha256: config.sha256, apply_state: 'applied', active_config: activeConfig } as ConfigApplyResult as T
  }
  const restoreMatch = pathname.match(/^\/api\/v1\/config\/versions\/(\d+)\/restore$/)
  if (restoreMatch && method === 'POST') {
    const body = JSON.parse(String(init?.body)) as { expected_sha256: string }
    if (body.expected_sha256 !== config.sha256) throw new Error('这份配置在别处改过了，先重新读取')
    const sourceId = Number(restoreMatch[1])
    const sourceVersion = versions.versions.find((version) => version.id === sourceId)
    const content = configVersionContents.get(sourceId)
    if (!sourceVersion || !content) throw new Error('配置文件不存在')
    return activateCopy(sourceId, content, `恢复为版本 #${sourceId}`) as T
  }
  if (path === '/api/v1/cache/flush') {
    return { protocol_version: 1, response_entries_before: 18642, response_entries_after: 0, rule_entries_before: 712, rule_entries_after: 0 } as T
  }
  if (pathname === '/api/v1/logs') {
    // 级别筛选和真实后端一样在「服务端」做：journalctl 的 --priority 桶是
    // <=3 错误、==4 警告、>=5 信息。演示里若忽略这个参数，筛选器看起来就是坏的。
    // The level filter runs "server-side" as the real backend does: journalctl's
    // --priority buckets are <=3 error, ==4 warning, >=5 info. Ignoring the
    // parameter here would make the filter look broken in the demo.
    const level = url.searchParams.get('level')
    const inLevel = (priority: number): boolean =>
      level === null || (level === 'error' ? priority <= 3 : level === 'warning' ? priority === 4 : priority >= 5)
    // 分页且响应慢，只在置上这个标记时演示：e2e 用它复现「切级别时旧游标翻页」
    // 的竞态——带 before 的请求 300ms 回来，带 level 的 1500ms，让首屏还在飞时
    // 旧级别的翻页已经落地。游标和 journalctl 的一样是最后一行在日志里的位置，
    // 与级别无关：拿「全部」的游标去翻「警告」，翻出来的正是警告首屏已经有的行。
    // Paged and slow, only under this flag: the e2e uses it to reproduce the
    // "older page with a stale cursor after a level switch" race — requests
    // with `before` answer in 300ms, requests with `level` in 1500ms, so the
    // stale older page lands while the new first page is still in flight. The
    // cursor is, like journalctl's, the last line's position in the journal and
    // independent of the level: paging "warning" with the "all" cursor returns
    // lines the warning first page already holds.
    const pagedSlow = typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-log-paged-slow') === 'true'
    if (pagedSlow) {
      await new Promise((resolve) => setTimeout(resolve, url.searchParams.has('level') ? 1500 : url.searchParams.has('before') ? 300 : 0))
    }
    // 新日志持续到来，只在置上这个标记时演示：每取一次首屏就多出三行更新的日志，
    // 位置记成负数，排在最新的一行之前。e2e 用它验证读历史时新日志先攒进提示条。
    // Lines keep arriving only under this flag: every first-page fetch adds three
    // newer lines at negative positions, ahead of the newest one. The e2e uses it
    // to check that new lines wait in the banner while the reader is in history.
    const growing = typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-log-growing') === 'true'
    if (growing && !url.searchParams.has('before')) demoLogArrivals += 3
    const total = pagedSlow ? 120 : 80
    const pageSize = 80
    const before = Number(url.searchParams.get('before'))
    const after = Number.isFinite(before) && url.searchParams.has('before') ? before : -Infinity
    const matching = Array.from({ length: total + demoLogArrivals }, (_, index) => index - demoLogArrivals).map((position) => ({
      position,
      entry: {
        timestamp_unix_micros: (now - position * 18) * 1_000_000,
        priority: position >= 0 && position % 17 === 0 ? 4 : 6,
        source: 'kixdns',
        message: position < 0
          ? `request completed pipeline=default transport=tcp elapsed_ms=${6 + (-position % 5)}`
          : position % 17 === 0
            ? 'upstream request timed out, continuing with next configured resolver'
            : `request completed pipeline=default transport=udp elapsed_ms=${8 + (position % 14)}`,
      },
    })).filter(({ position, entry }) => position > after && inLevel(entry.priority))
    const pageItems = matching.slice(0, pageSize)
    const entries = pageItems.map(({ entry }) => entry)
    const nextCursor = matching.length > pageSize ? String(pageItems.at(-1)?.position ?? 0) : null
    // 输出被改到 journald 之外的 unit 只在置上这个标记时演示，和 kixdns:demo-empty-first-install 是同一套做法。
    // 句子由服务端拼好，这里给的就是它会给的那一句。
    // A unit whose output bypasses journald is shown only under this flag, mirroring kixdns:demo-empty-first-install.
    // The sentence is composed server-side; this is the one it would send.
    const notice = typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-log-output-redirected') === 'true'
      ? '这个 unit 的输出没有送到 journald（StandardOutput=append:/var/log/kixdns.log），这里只会看到 systemd 自己的启停记录'
      : null
    return { entries, next_cursor: nextCursor, notice } as LogsResponse as T
  }
  if (pathname === '/api/v1/audit' && method === 'GET') {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50))
    const beforeId = Number(url.searchParams.get('before_id')) || Number.POSITIVE_INFINITY
    const prefix = url.searchParams.get('action_prefix') ?? ''
    const matching = auditEvents.filter((event) => event.id < beforeId && event.action.startsWith(prefix))
    const events = matching.slice(0, limit)
    return {
      events,
      next_cursor: matching.length > limit ? events.at(-1)?.id ?? null : null,
    } as AuditPage as T
  }
  if (path === '/api/v1/diagnostics/dns') {
    const body = JSON.parse(String(init?.body)) as { domain: string; record_type: string; client_ip?: string; config?: Record<string, unknown> }
    const client = body.client_ip ?? '127.0.0.1'
    // 演示里的草稿试跑：用测试用的内核模拟器按草稿算一遍（单独一个包，只在演示里加载）
    // The demo's draft trial: evaluate the draft with the tests' kernel simulator (its own chunk, loaded only in the demo)
    if (body.config) return (await mockDraftTrial(body.domain, body.record_type, client, body.config)) as T
    return {
      server: 'KixDNS 内部执行链',
      domain: body.domain,
      record_type: body.record_type,
      response_code: 'No Error',
      elapsed_ms: 12,
      truncated: false,
      answers: [`${body.domain}. 300 IN A 104.18.26.120`, `${body.domain}. 300 IN A 104.18.27.120`],
      trace_supported: true,
      trace_truncated: false,
      trace: [
        { stage: 'request', status: 'parsed', label: `${body.record_type} ${body.domain}`, detail: `客户端：${client}；监听器：default`, elapsed_ms: 0 },
        { stage: 'pipeline', status: 'selected', label: 'default', detail: null, elapsed_ms: 0 },
        { stage: 'response_cache', status: 'miss', label: '响应缓存未命中', detail: '管线：default', elapsed_ms: 0 },
        { stage: 'rule', status: 'matched', label: 'geosite-global', detail: '管线：default；匹配器数：1', elapsed_ms: 1 },
        { stage: 'decision', status: 'selected', label: '规则 geosite-global 转发', detail: '目标：https://1.1.1.1/dns-query；传输：Some(Https)', elapsed_ms: 1 },
        // 同一个查询正好在问上游时，这次不另发，等那一次的回答（kixdns:demo-trace-joined）
        // When the same query is already out upstream this one sends nothing and waits for that answer (kixdns:demo-trace-joined)
        traceJoins()
          ? { stage: 'upstream', status: 'joined', label: '等候正在进行的同一个查询', detail: null, elapsed_ms: 12 }
          : { stage: 'upstream', status: 'succeeded', label: 'https://1.1.1.1/dns-query', detail: '响应码：No Error；耗时：12 ms；截断：false', elapsed_ms: 12 },
      ],
      client_ip: client,
      source: 'live',
    } as DnsDiagnostic as T
  }
  if (pathname === '/api/v1/settings/github-token') {
    if (method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as { token?: string }
      if (!body.token) throw new Error('GitHub Token 不能为空')
      githubTokenConfigured = true
    } else if (method === 'DELETE') {
      githubTokenConfigured = false
    }
    return {
      configured: githubTokenConfigured,
      rate_limit: githubTokenConfigured
        ? { limit: 5_000, remaining: 4_998, reset_at: now + 2_400 }
        : null,
    } as GithubTokenStatus as T
  }
  if (path === '/api/v1/updates/status') {
    const kernelFailed = kernelCheckFails()
    return {
      kixdns: kernelFailed ? null : {
        available: !activeIsLatest(),
        current_commit: activeKixdnsVersion.commit,
        latest_commit: latestKixdnsVersion.commit,
        source_id: latestKixdnsVersion.source_id,
        release_tag: latestKixdnsVersion.release_tag,
        created_at: latestKixdnsVersion.created_at,
        release_url: latestKixdnsVersion.build_url,
      },
      kixdns_error: kernelFailed ? KERNEL_CHECK_ERROR : null,
      panel: {
        available: true,
        current_version: '1.0.0',
        current_commit: '23f70420a74f229aa9755c93b0e0e1ae0c7d3316',
        current_release: null,
        latest_version: '1.0.1',
        published_at: '2026-08-01T08:00:00Z',
        release_url: 'https://github.com/tuoro/kixdns-panel/releases/tag/v1.0.1',
        artifact: 'kixdns-panel-linux-x86_64.zip',
        artifact_digest: 'sha256:9280ba270e01d774e6944efdc435a685250e99f98c36a8cf406507a036c01ba4',
        download_url: 'https://github.com/tuoro/kixdns-panel/releases/download/v1.0.1/kixdns-panel-linux-x86_64.zip',
      },
      panel_error: null,
    } satisfies UpdateNotifications as T
  }
  if (path === '/api/v1/panel-update' && method === 'GET') {
    return panelUpdateStatus as T
  }
  if (path === '/api/v1/panel-update' && method === 'POST') {
    panelUpdateStatus = {
      state: 'downloading',
      message: '正在下载并校验 v1.0.1',
      target_version: 'v1.0.1',
      updated_at: now,
    }
    return { accepted: true, target_version: 'v1.0.1' } as PanelUpdateStartResponse as T
  }
  throw new Error(`未实现的演示接口：${method} ${path}`)
}

export type { ValidationResult, ServiceStatus }
