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
const upstreamCommit = '374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25'
const artifactName = 'kixdns-enhanced-linux-x86_64'
const binarySha256 = 'ee714ecae2d9f93e1ee8e242b1e351be4671ad53b4adc4dc3e70d20472a9c27a'
const actionVersions: RemoteKixdnsVersion[] = [
  {
    source: 'action',
    source_id: 30361560969,
    commit: 'ec507c47896d958e6d17efc755b03340c10bf98e',
    run_id: 30361560969,
    release_tag: null,
    created_at: '2026-07-28T13:01:32Z',
    source_url: 'https://github.com/tuoro/kixdns-panel/actions/runs/30361560969',
    artifact: artifactName,
    artifact_digest: 'sha256:7d0eb465fcc4735ef9586b0b6f724e136d944cfcc424129650661cadeb1bf38c',
    download_url: `https://nightly.link/tuoro/kixdns-panel/actions/runs/30361560969/${artifactName}.zip`,
    installed: false,
    active: false,
  },
  {
    source: 'action',
    source_id: 30353958253,
    commit: '4e8002d08a56afc08be335d0d5ed337c7690f9af',
    run_id: 30353958253,
    release_tag: null,
    created_at: '2026-07-28T11:14:01Z',
    source_url: 'https://github.com/tuoro/kixdns-panel/actions/runs/30353958253',
    artifact: artifactName,
    artifact_digest: 'sha256:c0cb5c7015fee516ccbfe88ba62b31e9cdfaa542a48a75e48c572f3e31e03576',
    download_url: `https://nightly.link/tuoro/kixdns-panel/actions/runs/30353958253/${artifactName}.zip`,
    installed: false,
    active: false,
  },
  {
    source: 'action',
    source_id: 30344337649,
    commit: 'c459982f2c705e4ef81069fec38882324c5faf0d',
    run_id: 30344337649,
    release_tag: null,
    created_at: '2026-07-28T08:54:55Z',
    source_url: 'https://github.com/tuoro/kixdns-panel/actions/runs/30344337649',
    artifact: artifactName,
    artifact_digest: 'sha256:98aa2dd5567b1fd9516af058c7b9900a45d615438e64543d0010b995078eb1bf',
    download_url: `https://nightly.link/tuoro/kixdns-panel/actions/runs/30344337649/${artifactName}.zip`,
    installed: false,
    active: false,
  },
]

const releaseVersions: RemoteKixdnsVersion[] = [
  {
    source: 'release',
    source_id: 361095213,
    commit: actionVersions[0].commit,
    run_id: null,
    release_tag: 'kixdns-374d63ccfdde-p5-r1',
    created_at: '2026-07-28T13:15:32Z',
    source_url: 'https://github.com/tuoro/kixdns-panel/releases/tag/kixdns-374d63ccfdde-p5-r1',
    artifact: artifactName,
    artifact_digest: 'sha256:e5680835c2705c231a1a12792ca278c49ebc658af833c9e8d919a2317e512905',
    download_url: `https://github.com/tuoro/kixdns-panel/releases/download/kixdns-374d63ccfdde-p5-r1/${artifactName}.zip`,
    installed: false,
    active: false,
  },
]

const demoRemoteVersions: Record<KixdnsVersionSource, RemoteKixdnsVersion[]> = {
  action: actionVersions,
  release: releaseVersions,
}
let activeKixdnsCommit = actionVersions[1].commit
const installedKixdnsVersions = new Map<string, RemoteKixdnsVersion>([
  [activeKixdnsCommit, actionVersions[1]],
  [actionVersions[2].commit, actionVersions[2]],
])

function demoVersionCatalog(source: KixdnsVersionSource): KixdnsVersionCatalog {
  const remoteVersions = demoRemoteVersions[source]
  return {
    source,
    active_commit: activeKixdnsCommit,
    binary_present: true,
    remote_versions: remoteVersions.map((version) => ({
      ...version,
      installed: installedKixdnsVersions.has(version.commit),
      active: version.commit === activeKixdnsCommit,
    })),
    installed_versions: [...installedKixdnsVersions].map(([commit, remote], index) => {
      return {
        source: remote.source,
        source_id: remote.source_id,
        commit,
        run_id: remote.run_id,
        release_tag: remote.release_tag,
        created_at: remote.created_at,
        source_url: remote.source_url,
        artifact: remote.artifact,
        artifact_digest: remote.artifact_digest,
        upstream_repository: 'olicesx/kixdns',
        upstream_commit: upstreamCommit,
        patchset: 5,
        build_revision: remote.source === 'release' ? 1 : null,
        control_protocol: 1,
        binary_sha256: binarySha256,
        installed_at: now - index * 86400,
        active: commit === activeKixdnsCommit,
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
    let commit = parts[5]
    if (pathname.endsWith('/install')) {
      const source = parts[5] as KixdnsVersionSource
      const sourceId = Number(parts[6])
      const remote = demoRemoteVersions[source]?.find((version) => version.source_id === sourceId)
      if (!remote) throw new Error('演示版本来源不存在')
      commit = remote.commit
      installedKixdnsVersions.set(commit, remote)
    }
    activeKixdnsCommit = commit
    serviceRunning = true
    const version = demoVersionCatalog('action').installed_versions.find((item) => item.commit === commit)
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
    return { installed_commit: updateAvailable ? activeKixdnsCommit : latest.commit, latest_commit: latest.commit, run_id: latest.run_id ?? latest.source_id, created_at: latest.created_at, run_url: latest.source_url, artifact: latest.artifact, artifact_digest: latest.artifact_digest, download_url: latest.download_url, available: updateAvailable } as UpdateInfo as T
  }
  throw new Error(`未实现的演示接口：${method} ${path}`)
}

export type { ValidationResult, ServiceStatus }
