import type {
  ActiveConfig,
  AuthSession,
  ConfigApplyResult,
  ConfigDocument,
  ConfigVersions,
  DnsDiagnostic,
  LogsResponse,
  Overview,
  KixdnsVersionCatalog,
  KixdnsVersionSource,
  RemoteKixdnsVersion,
  ServiceStatus,
  UpdateInfo,
  ValidationResult,
} from './types'

const now = Math.floor(Date.now() / 1000)
let config: ConfigDocument = {
  content: {
    version: '1.0',
    settings: {
      bind_udp: '0.0.0.0:53',
      bind_tcp: '0.0.0.0:53',
      cache_capacity: 20000,
      default_upstream: '1.1.1.1:53',
      upstream_timeout_ms: 1800,
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
}

const activeConfig: ActiveConfig = {
  protocol_version: 1,
  generation: 18,
  sha256: config.sha256,
  loaded_at_unix: now - 430,
  reload_sequence: 24,
  last_reload: { success: true, error: null },
}

const session: AuthSession = {
  user: { id: 1, username: 'admin' },
  csrf_token: 'demo-csrf-token',
  expires_at: now + 36000,
}

const overview: Overview = {
  health: {
    protocol_version: 1,
    status: 'ok',
    pid: 1428,
    version: '0.1.0',
    upstream_commit: '374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25',
    patchset: '5',
    started_at_unix: now - 289420,
    uptime_seconds: 289420,
    config_generation: 18,
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

const versions: ConfigVersions = {
  versions: [
    { id: 18, sha256: config.sha256, message: '调整上游超时', actor: 'admin', created_at: now - 430 },
    { id: 17, sha256: 'cc5da21d', message: '新增国内解析管线', actor: 'admin', created_at: now - 86400 },
    { id: 16, sha256: '982ca084', message: '更新恶意域名规则', actor: 'admin', created_at: now - 172800 },
    { id: 15, sha256: '193bf884', message: '导入启动时配置', actor: 'system', created_at: now - 604800 },
  ],
}

let serviceRunning = true
let updateAvailable = true
const panelBuildCommit = '05f51503219e77849517596b7392cff919437c8b'
const actionBuildRunId = 30376438766
const releaseBuildRunId = 30376438414
const actionUpstreamCommits: Record<number, string> = {
  30235703570: '374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25',
  30231271280: '647c5b1d2af6963176d7f8da6c3ed031e6b58497',
  30229870401: 'f59d6f800a20228235d37324cdd8f9517ca27855',
  30228238557: '58dec64326fda73daf8b21f97a42c97248e9b42a',
}
const releaseUpstreamCommit = '647c5b1d2af6963176d7f8da6c3ed031e6b58497'
const binarySha256: Record<KixdnsVersionSource, string> = {
  action: 'ee714ecae2d9f93e1ee8e242b1e351be4671ad53b4adc4dc3e70d20472a9c27a',
  release: '5dff4bbcc579f2882678f5aab0074601f4790770771430b09bb75d7a51057c4d',
}
function actionVersion(sourceId: number, runId: number, fingerprint: string, digest: string): RemoteKixdnsVersion {
  return {
    source: 'action',
    source_id: sourceId,
    commit: panelBuildCommit,
    run_id: runId,
    release_tag: null,
    patchset: 5,
    created_at: '2026-07-28T16:03:48Z',
    source_url: `https://github.com/olicesx/kixdns/actions/runs/${runId}`,
    build_url: `https://github.com/tuoro/kixdns-panel/actions/runs/${actionBuildRunId}`,
    artifact: `kixdns-enhanced-action-${runId}-p5-${fingerprint}-linux-x86_64`,
    artifact_digest: digest,
    download_url: `https://nightly.link/tuoro/kixdns-panel/actions/runs/${actionBuildRunId}/kixdns-enhanced-action-${runId}-p5-${fingerprint}-linux-x86_64.zip`,
    installed: false,
    active: false,
  }
}

const actionVersions: RemoteKixdnsVersion[] = [
  actionVersion(8695590365, 30235703570, '10844244cec4', 'sha256:d6ea8edd8c9de8f1eaa5da58899c238102402ea380bbd7e93de813b89c9b15a0'),
  actionVersion(8695589205, 30231271280, 'e662fc842875', 'sha256:c43352d24182a5ac74af457af67bca18bb8fcf2189ba29da6fc2fbc0eed388a7'),
  actionVersion(8695597834, 30229870401, '869e5ef84b1b', 'sha256:1d4339431769964db35fb895b96dff743ad60109ea10133eb193e3c3d650d60b'),
  actionVersion(8695686119, 30228238557, '584dd80d891b', 'sha256:a33ebe3cd7cdd175221ac751af082d434a848d3548a9ac4bb6eccfe56cc5080b'),
]

const releaseVersions: RemoteKixdnsVersion[] = [
  {
    source: 'release',
    source_id: 8695402611,
    commit: panelBuildCommit,
    run_id: null,
    release_tag: 'v0.1.1',
    patchset: 5,
    created_at: '2026-07-28T16:03:47Z',
    source_url: 'https://github.com/olicesx/kixdns/releases/tag/v0.1.1',
    build_url: `https://github.com/tuoro/kixdns-panel/actions/runs/${releaseBuildRunId}`,
    artifact: 'kixdns-enhanced-release-v0.1.1-p5-b05f496186fa-linux-x86_64',
    artifact_digest: 'sha256:0e208928be027b3123c34678ca9a43dda2419c8269d0e3c3d2669ad3f89e1cb1',
    download_url: `https://nightly.link/tuoro/kixdns-panel/actions/runs/${releaseBuildRunId}/kixdns-enhanced-release-v0.1.1-p5-b05f496186fa-linux-x86_64.zip`,
    installed: false,
    active: false,
  },
]

const demoRemoteVersions: Record<KixdnsVersionSource, RemoteKixdnsVersion[]> = {
  action: actionVersions,
  release: releaseVersions,
}
const kixdnsVersionKey = (version: Pick<RemoteKixdnsVersion, 'source' | 'source_id' | 'commit'>): string => `${version.source}:${version.source_id}:${version.commit}`
let activeKixdnsVersion = kixdnsVersionKey(actionVersions[0])
const installedKixdnsVersions = new Map<string, RemoteKixdnsVersion>([
  [activeKixdnsVersion, actionVersions[0]],
])

function demoVersionCatalog(source: KixdnsVersionSource): KixdnsVersionCatalog {
  const remoteVersions = demoRemoteVersions[source]
  const activeRemote = installedKixdnsVersions.get(activeKixdnsVersion)
  return {
    source,
    active_source: activeRemote?.source ?? null,
    active_commit: activeRemote?.commit ?? null,
    binary_present: true,
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
        patchset: 5,
        control_protocol: 1,
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
  if (path === '/api/v1/overview') return overview as T
  if (path === '/api/v1/service' && method === 'GET') {
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
    }
    if (!remote) throw new Error('演示版本操作无效')
    activeKixdnsVersion = kixdnsVersionKey(remote)
    serviceRunning = true
    const version = demoVersionCatalog(source).installed_versions.find((item) => item.source === source && item.commit === remote.commit)
    return version as T
  }
  if (path === '/api/v1/config' && method === 'GET') return config as T
  if (path === '/api/v1/config/versions') return versions as T
  if (path === '/api/v1/config/validate') {
    const content = JSON.parse(String(init?.body)) as Record<string, unknown>
    const pipelines = Array.isArray(content.pipelines) ? content.pipelines : []
    return { protocol_version: 1, valid: true, pipeline_count: pipelines.length, rule_count: 1 } as T
  }
  if (path === '/api/v1/config' && method === 'PUT') {
    const body = JSON.parse(String(init?.body)) as { content: Record<string, unknown> }
    const nextSha = `demo${Date.now().toString(16)}`.padEnd(64, '0').slice(0, 64)
    config = { ...config, content: body.content, sha256: nextSha, modified_at: Math.floor(Date.now() / 1000) }
    activeConfig.sha256 = nextSha
    activeConfig.generation += 1
    activeConfig.reload_sequence += 1
    return { version_id: 19, sha256: config.sha256, active_config: activeConfig } as ConfigApplyResult as T
  }
  if (path.includes('/restore')) return { version_id: 19, sha256: config.sha256, active_config: activeConfig } as T
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
  if (path === '/api/v1/diagnostics/dns') {
    const body = JSON.parse(String(init?.body)) as { domain: string; record_type: string }
    return { server: '127.0.0.1:53', domain: body.domain, record_type: body.record_type, response_code: 'No Error', elapsed_ms: 12, truncated: false, answers: [`${body.domain}. 300 IN A 104.18.26.120`, `${body.domain}. 300 IN A 104.18.27.120`] } as DnsDiagnostic as T
  }
  if (path === '/api/v1/updates/apply') updateAvailable = false
  if (path === '/api/v1/updates' || path === '/api/v1/updates/apply') {
    const latest = actionVersions[0]
    return { installed_commit: updateAvailable ? installedKixdnsVersions.get(activeKixdnsVersion)?.commit ?? null : latest.commit, latest_commit: latest.commit, run_id: latest.source_id, created_at: latest.created_at, run_url: latest.source_url, artifact: latest.artifact, artifact_digest: latest.artifact_digest, download_url: latest.download_url, available: updateAvailable } as UpdateInfo as T
  }
  throw new Error(`未实现的演示接口：${method} ${path}`)
}

export type { ValidationResult, ServiceStatus }
