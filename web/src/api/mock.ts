import type {
  ActiveConfig,
  AuditPage,
  AuthSession,
  ConfigApplyResult,
  ConfigDocument,
  ConfigVersionDetail,
  DeleteConfigVersionResult,
  ConfigVersions,
  DnsDiagnostic,
  GeoDataCleanupResult,
  GeoDataManifest,
  GeoDataSchedule,
  GeoDataSyncRequest,
  GithubTokenStatus,
  LogsResponse,
  Overview,
  KixdnsVersionCatalog,
  KixdnsVersionSource,
  RemoteKixdnsVersion,
  ServiceStatus,
  UpdateInfo,
  UpdateNotifications,
  PanelUpdateStartResponse,
  PanelUpdateStatus,
  ValidationResult,
} from './types'

const now = Math.floor(Date.now() / 1000)
const auditEvents = [
  { id: 18, actor: 'admin', action: 'config.save', detail: '保存配置版本 #18', created_at: now - 430 },
  { id: 17, actor: 'admin', action: 'config.geo_data.sync', detail: '同步 Geo 数据：MMDB 1，GeoIP 0，GeoSite 1 个', created_at: now - 7200 },
  { id: 16, actor: 'admin', action: 'kixdns.version.activate', detail: '切换增强构建 45b9a1c0c7b5', created_at: now - 86400 },
  { id: 15, actor: 'admin', action: 'service.restart', detail: '服务状态：active/running', created_at: now - 86520 },
  { id: 14, actor: 'admin', action: 'diagnostic.dns', detail: '执行 A 查询', created_at: now - 172800 },
  { id: 13, actor: 'admin', action: 'auth.login', detail: '登录成功', created_at: now - 173100 },
  { id: 12, actor: null, action: 'config.geo_data.schedule.apply', detail: '定时更新 Geo 数据并生成配置版本 #17', created_at: now - 604800 },
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
      statistics_enabled: true,
      statistics_anonymize_client_ip: false,
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
    declared_capabilities: ['config_query_stats_v1'],
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

const overview: Overview = {
  live: true,
  service_active: true,
  captured_at_unix: now,
  health: {
    protocol_version: 1,
    status: 'ok',
    pid: 1428,
    version: '0.1.0',
    upstream_commit: '374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25',
    patchset: '6',
    started_at_unix: now - 289420,
    uptime_seconds: 289420,
    config_generation: 18,
    capabilities: ['stats_top_v1'],
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
      { upstream: '1.1.1.1:53', transport: 'udp', attempts: 5_932_118, success: 5_901_774, errors: 28_230, rejected: 2_114 },
      { upstream: '223.5.5.5:53', transport: 'tcp_udp', attempts: 3_008_779, success: 2_991_664, errors: 15_909, rejected: 1_206 },
      { upstream: 'dns.google/dns-query', transport: 'doh', attempts: 1_114_083, success: 1_102_572, errors: 10_780, rejected: 731 },
    ],
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
    delete settings.statistics_enabled
    delete settings.statistics_anonymize_client_ip
    delete settings.geoip_db_path
    delete settings.geosite_data_paths
  }
  return content
}

let serviceRunning = true
let updateAvailable = true
let panelUpdateStatus: PanelUpdateStatus = {
  state: 'idle',
  message: '',
  target_version: '',
  updated_at: 0,
}
let githubTokenConfigured = false
const panelBuildCommit = '82c88791869153884f361b1ea3cf123b727fadee'
const legacyBuildCommit = '05f51503219e77849517596b7392cff919437c8b'
const actionBuildCommit = '681d813a73f4525dfe97bf3123894b8b714d35d9'
const actionBuildRunId = 30565639501
const legacyActionBuildRunId = 30376438766
const releaseBuildRunId = 30568119141
const actionUpstreamCommits: Record<number, string> = {
  30235703570: '374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25',
  30231271280: '647c5b1d2af6963176d7f8da6c3ed031e6b58497',
  30229870401: 'f59d6f800a20228235d37324cdd8f9517ca27855',
  30228238557: '58dec64326fda73daf8b21f97a42c97248e9b42a',
}
const releaseUpstreamCommit = '647c5b1d2af6963176d7f8da6c3ed031e6b58497'
const binarySha256: Record<KixdnsVersionSource, string> = {
  action: '8943ba8bd01409a89ef3279b6ed06364d6867512c75ad693f75e52428718c1c6',
  release: '5588a87a7331fea0feb6eb86c5d79b56cb925d42c4ddfcfeed6e95e61ee4fc29',
}
function actionVersion(
  sourceId: number,
  runId: number,
  fingerprint: string,
  digest: string,
  patchset = 5,
  buildRunId = legacyActionBuildRunId,
  buildCommit = legacyBuildCommit,
): RemoteKixdnsVersion {
  return {
    source: 'action',
    source_id: sourceId,
    commit: buildCommit,
    run_id: runId,
    release_tag: null,
    patchset,
    created_at: buildRunId === actionBuildRunId ? '2026-07-30T17:31:38Z' : '2026-07-28T16:03:48Z',
    source_url: `https://github.com/olicesx/kixdns/actions/runs/${runId}`,
    build_url: `https://github.com/tuoro/kixdns-panel/actions/runs/${buildRunId}`,
    artifact: `kixdns-enhanced-action-${runId}-p${patchset}-${fingerprint}-linux-x86_64`,
    artifact_digest: digest,
    download_url: `https://nightly.link/tuoro/kixdns-panel/actions/runs/${buildRunId}/kixdns-enhanced-action-${runId}-p${patchset}-${fingerprint}-linux-x86_64.zip`,
    installed: false,
    active: false,
  }
}

const actionVersions: RemoteKixdnsVersion[] = [
  actionVersion(
    8768967538,
    30235703570,
    '46ac788fc96c',
    'sha256:fbab891acbe0dcc377893694f92a52b0cf3602915e69bca436b067a28e2c0dfc',
    8,
    actionBuildRunId,
    actionBuildCommit,
  ),
  actionVersion(8695589205, 30231271280, 'e662fc842875', 'sha256:c43352d24182a5ac74af457af67bca18bb8fcf2189ba29da6fc2fbc0eed388a7'),
  actionVersion(8695597834, 30229870401, '869e5ef84b1b', 'sha256:1d4339431769964db35fb895b96dff743ad60109ea10133eb193e3c3d650d60b'),
  actionVersion(8695686119, 30228238557, '584dd80d891b', 'sha256:a33ebe3cd7cdd175221ac751af082d434a848d3548a9ac4bb6eccfe56cc5080b'),
]

const releaseVersions: RemoteKixdnsVersion[] = [
  {
    source: 'release',
    source_id: 8769934664,
    commit: panelBuildCommit,
    run_id: null,
    release_tag: 'v0.1.1',
    patchset: 8,
    created_at: '2026-07-30T18:05:21Z',
    source_url: 'https://github.com/olicesx/kixdns/releases/tag/v0.1.1',
    build_url: `https://github.com/tuoro/kixdns-panel/actions/runs/${releaseBuildRunId}`,
    artifact: 'kixdns-enhanced-release-v0.1.1-p8-1598ba62c01f-linux-x86_64',
    artifact_digest: 'sha256:135efadc330313f185a6b33ef53523e888b887ff0a5c2532b3e368d0bf6159fe',
    download_url: `https://nightly.link/tuoro/kixdns-panel/actions/runs/${releaseBuildRunId}/kixdns-enhanced-release-v0.1.1-p8-1598ba62c01f-linux-x86_64.zip`,
    installed: false,
    active: false,
  },
]
const configCapabilitiesByArtifact = new Map<string, string[]>([
  [actionVersions[0].artifact, ['config_query_stats_v1']],
  [releaseVersions[0].artifact, ['config_query_stats_v1']],
])

const demoRemoteVersions: Record<KixdnsVersionSource, RemoteKixdnsVersion[]> = {
  action: actionVersions,
  release: releaseVersions,
}
const kixdnsVersionKey = (version: Pick<RemoteKixdnsVersion, 'source' | 'source_id' | 'commit'>): string => `${version.source}:${version.source_id}:${version.commit}`
let activeKixdnsVersion = kixdnsVersionKey(actionVersions[0])
const installedKixdnsVersions = new Map<string, RemoteKixdnsVersion>([
  [activeKixdnsVersion, actionVersions[1]],
  [kixdnsVersionKey(actionVersions[0]), actionVersions[0]],
])

function demoVersionCatalog(source: KixdnsVersionSource): KixdnsVersionCatalog {
  const remoteVersions = demoRemoteVersions[source]
  const activeRemote = installedKixdnsVersions.get(activeKixdnsVersion)
  return {
    source,
    management_enabled: true,
    active_source: activeRemote?.source ?? null,
    active_commit: activeRemote?.commit ?? null,
    binary_present: true,
    remote_error: null,
    remote_versions: remoteVersions.map((version) => ({
      ...version,
      installed: installedKixdnsVersions.has(kixdnsVersionKey(version)),
      active: kixdnsVersionKey(version) === activeKixdnsVersion,
    })),
    installed_versions: [...installedKixdnsVersions.values()].map((remote, index) => {
      return {
        source: remote.source,
        source_id: remote.source_id,
        commit: remote.commit,
        run_id: remote.run_id,
        release_tag: remote.release_tag,
        created_at: remote.created_at,
        source_url: remote.source_url,
        build_url: remote.build_url,
        artifact: remote.artifact,
        artifact_digest: remote.artifact_digest,
        upstream_repository: 'olicesx/kixdns',
        upstream_commit: remote.source === 'release'
          ? releaseUpstreamCommit
          : actionUpstreamCommits[remote.run_id ?? 0] ?? null,
        patchset: remote.patchset,
        control_protocol: 1,
        config_capabilities: [...(configCapabilitiesByArtifact.get(remote.artifact) ?? [])],
        binary_sha256: binarySha256[remote.source],
        installed_at: now - index * 86400,
        active: kixdnsVersionKey(remote) === activeKixdnsVersion,
      }
    }),
  }
}

export async function mockRequest<T>(path: string, init?: RequestInit): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 120))
  const method = init?.method ?? 'GET'
  const url = new URL(path, 'http://panel.local')
  const pathname = url.pathname
  if (path === '/api/v1/setup' && method === 'GET') return { required: false } as T
  if (path === '/api/v1/auth/session') return session as T
  if (path === '/api/v1/auth/login' || path === '/api/v1/setup') return session as T
  if (path === '/api/v1/auth/logout') return { ok: true } as T
  const emptyFirstInstall = typeof localStorage !== 'undefined' && localStorage.getItem('kixdns:demo-empty-first-install') === 'true'
  if (path === '/api/v1/overview') {
    if (emptyFirstInstall) throw new Error('KixDNS 控制接口不可用')
    return overview as T
  }
  if (pathname === '/api/v1/stats/top' && method === 'GET') {
    queryStats.window_seconds = Number(url.searchParams.get('window')) || 86_400
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
  if (pathname === '/api/v1/kixdns/versions' && method === 'GET') {
    const source = url.searchParams.get('source') === 'action' ? 'action' : 'release'
    return demoVersionCatalog(source) as T
  }
  if (pathname.startsWith('/api/v1/kixdns/versions/') && method === 'POST') {
    const parts = pathname.split('/')
    const source = parts[5] as KixdnsVersionSource
    let remote: RemoteKixdnsVersion | undefined
    if (pathname.endsWith('/install')) {
      const sourceId = Number(parts[6])
      remote = demoRemoteVersions[source]?.find((version) => version.source_id === sourceId)
      if (!remote) throw new Error('演示版本来源不存在')
      installedKixdnsVersions.set(kixdnsVersionKey(remote), remote)
    } else if (pathname.endsWith('/activate')) {
      const identity = parts[6]
      remote = [...installedKixdnsVersions.values()].find((version) =>
        version.source === source && (String(version.source_id) === identity || version.commit === identity),
      )
      if (!remote) throw new Error('演示版本尚未安装')
    } else if (pathname.endsWith('/delete')) {
      const identity = parts[6]
      const entry = [...installedKixdnsVersions.entries()].find(([, version]) =>
        version.source === source && (String(version.source_id) === identity || version.commit === identity),
      )
      if (!entry) throw new Error('演示版本尚未安装')
      if (entry[0] === activeKixdnsVersion) throw new Error('当前运行版本不能删除，请先切换版本')
      const version = demoVersionCatalog(source).installed_versions.find((item) =>
        item.source === source && item.source_id === entry[1].source_id,
      )
      installedKixdnsVersions.delete(entry[0])
      return version as T
    }
    if (!remote) throw new Error('演示版本操作无效')
    activeKixdnsVersion = kixdnsVersionKey(remote)
    serviceRunning = true
    const version = demoVersionCatalog(source).installed_versions.find((item) => item.source === source && item.commit === remote.commit)
    return version as T
  }
  if (path === '/api/v1/config' && method === 'GET') return config as T
  if (path === '/api/v1/config/geo-data' && method === 'GET') return geoData as T
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
    const formalVersion = versions.versions.find((version) => version.apply_state === 'applied')
    // 与后端 ConfigStore::delete_version 保持一致：待应用时校验编辑中的候选 SHA。
    if (body.expected_sha256 !== config.sha256) throw new Error('配置已被其他操作修改，请刷新后重试')
    const id = Number(configVersionMatch[1])
    const currentId = config.pending?.version_id
      ? formalVersion?.id ?? null
      : formalVersion?.id ?? config.version_id
    if (id === currentId) throw new Error('当前生效版本不能删除，请先恢复其他版本')
    const index = versions.versions.findIndex((version) => version.id === id)
    if (index < 0) throw new Error('配置文件不存在')
    const removesPending = config.pending?.version_id === id
    versions.versions.splice(index, 1)
    configVersionContents.delete(id)
    if (removesPending) {
      const formalVersion = versions.versions.find((version) => version.apply_state === 'applied')
      const formalContent = formalVersion ? configVersionContents.get(formalVersion.id) : undefined
      if (formalVersion && formalContent) {
        const unavailable = emptyFirstInstall
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
    }
    return { deleted_id: id } as DeleteConfigVersionResult as T
  }
  if (path === '/api/v1/config/validate') {
    const content = JSON.parse(String(init?.body)) as Record<string, unknown>
    const pipelines = Array.isArray(content.pipelines) ? content.pipelines : []
    return { protocol_version: 1, valid: true, pipeline_count: pipelines.length, rule_count: 1 } as T
  }
  if (path === '/api/v1/config' && method === 'PUT') {
    const body = JSON.parse(String(init?.body)) as { content: Record<string, unknown>; expected_sha256: string; message?: string }
    if (body.expected_sha256 !== config.sha256) throw new Error('配置已被其他操作修改，请刷新后重试')
    const nextSha = `demo${Date.now().toString(16)}`.padEnd(64, '0').slice(0, 64)
    const versionId = ++nextConfigVersionId
    const createdAt = Math.floor(Date.now() / 1000)
    const message = body.message?.trim() || '更新配置'
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
          declared_capabilities: ['config_query_stats_v1'],
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
        declared_capabilities: ['config_query_stats_v1'],
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
    return { version_id: versionId, sha256: config.sha256, apply_state: 'applied', active_config: activeConfig } as ConfigApplyResult as T
  }
  const restoreMatch = pathname.match(/^\/api\/v1\/config\/versions\/(\d+)\/restore$/)
  if (restoreMatch && method === 'POST') {
    const body = JSON.parse(String(init?.body)) as { expected_sha256: string }
    if (body.expected_sha256 !== config.sha256) throw new Error('配置已被其他操作修改，请刷新后重试')
    const sourceId = Number(restoreMatch[1])
    const sourceVersion = versions.versions.find((version) => version.id === sourceId)
    const content = configVersionContents.get(sourceId)
    if (!sourceVersion || !content) throw new Error('配置文件不存在')
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
        declared_capabilities: ['config_query_stats_v1'],
      },
    }
    activeConfig.sha256 = config.sha256
    activeConfig.generation += 1
    activeConfig.reload_sequence += 1
    versions.versions.unshift({
      id: versionId,
      sha256: config.sha256,
      message: `回滚至版本 #${sourceId}`,
      actor: 'admin',
      created_at: config.modified_at,
      apply_state: 'applied',
      apply_error: null,
    })
    configVersionContents.set(versionId, structuredClone(content))
    return { version_id: versionId, sha256: config.sha256, apply_state: 'applied', active_config: activeConfig } as ConfigApplyResult as T
  }
  if (path === '/api/v1/cache/flush') {
    return { protocol_version: 1, response_entries_before: 18642, response_entries_after: 0, rule_entries_before: 712, rule_entries_after: 0 } as T
  }
  if (path.startsWith('/api/v1/logs')) {
    const entries = Array.from({ length: 80 }, (_, index) => ({
      timestamp_unix_micros: (now - index * 18) * 1_000_000,
      priority: index % 17 === 0 ? 4 : 6,
      source: 'kixdns',
      message: index % 17 === 0
        ? 'upstream request timed out, continuing with next configured resolver'
        : `request completed pipeline=default transport=udp elapsed_ms=${8 + (index % 14)}`,
    }))
    return { entries } as LogsResponse as T
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
    const body = JSON.parse(String(init?.body)) as { domain: string; record_type: string }
    return { server: '127.0.0.1:53', domain: body.domain, record_type: body.record_type, response_code: 'No Error', elapsed_ms: 12, truncated: false, answers: [`${body.domain}. 300 IN A 104.18.26.120`, `${body.domain}. 300 IN A 104.18.27.120`] } as DnsDiagnostic as T
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
    return {
      kixdns: {
        management_enabled: true,
        available: true,
        source: 'action',
        current_commit: panelBuildCommit,
        latest_commit: panelBuildCommit,
        source_id: actionVersions[0].source_id,
        run_id: actionVersions[0].run_id,
        release_tag: null,
        created_at: actionVersions[0].created_at,
        build_url: actionVersions[0].build_url,
      },
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
    } as UpdateNotifications as T
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
  if (path === '/api/v1/updates/apply') updateAvailable = false
  if (path === '/api/v1/updates' || path === '/api/v1/updates/apply') {
    const latest = actionVersions[0]
    return { installed_commit: updateAvailable ? installedKixdnsVersions.get(activeKixdnsVersion)?.commit ?? null : latest.commit, latest_commit: latest.commit, run_id: latest.source_id, created_at: latest.created_at, run_url: latest.source_url, artifact: latest.artifact, artifact_digest: latest.artifact_digest, download_url: latest.download_url, available: updateAvailable } as UpdateInfo as T
  }
  throw new Error(`未实现的演示接口：${method} ${path}`)
}

export type { ValidationResult, ServiceStatus }
