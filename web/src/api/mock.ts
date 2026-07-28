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
const demoRemoteVersions: RemoteKixdnsVersion[] = [
  {
    commit: 'bf0d53fb4b2a0434fa1b35ce1a76f75085137927',
    run_id: 30347922634,
    created_at: '2026-07-28T09:45:22Z',
    run_url: 'https://github.com/tuoro/kixdns-panel/actions/runs/30347922634',
    artifact: artifactName,
    artifact_digest: 'sha256:326199a1d72bf5430b06f945ebc9b60b3933139215b14ff24d770538cdf979be',
    download_url: `https://nightly.link/tuoro/kixdns-panel/actions/runs/30347922634/${artifactName}.zip`,
    installed: false,
    active: false,
  },
  {
    commit: '30e90607685c3a780e2b1005457ff13c57f7a5f7',
    run_id: 30347062884,
    created_at: '2026-07-28T09:33:09Z',
    run_url: 'https://github.com/tuoro/kixdns-panel/actions/runs/30347062884',
    artifact: artifactName,
    artifact_digest: 'sha256:ada39cf50e54d4d095e56aa379cb5e3e8b88b5b4185d4428c2a3900242b26db2',
    download_url: `https://nightly.link/tuoro/kixdns-panel/actions/runs/30347062884/${artifactName}.zip`,
    installed: false,
    active: false,
  },
  {
    commit: 'c459982f2c705e4ef81069fec38882324c5faf0d',
    run_id: 30344337649,
    created_at: '2026-07-28T08:54:55Z',
    run_url: 'https://github.com/tuoro/kixdns-panel/actions/runs/30344337649',
    artifact: artifactName,
    artifact_digest: 'sha256:98aa2dd5567b1fd9516af058c7b9900a45d615438e64543d0010b995078eb1bf',
    download_url: `https://nightly.link/tuoro/kixdns-panel/actions/runs/30344337649/${artifactName}.zip`,
    installed: false,
    active: false,
  },
]
let activeKixdnsCommit = demoRemoteVersions[1].commit
const installedKixdnsCommits = new Set([activeKixdnsCommit, demoRemoteVersions[2].commit])

function demoVersionCatalog(): KixdnsVersionCatalog {
  return {
    active_commit: activeKixdnsCommit,
    binary_present: true,
    remote_versions: demoRemoteVersions.map((version) => ({
      ...version,
      installed: installedKixdnsCommits.has(version.commit),
      active: version.commit === activeKixdnsCommit,
    })),
    installed_versions: [...installedKixdnsCommits].map((commit, index) => {
      const remote = demoRemoteVersions.find((version) => version.commit === commit)
      return {
        commit,
        run_id: remote?.run_id ?? null,
        created_at: remote?.created_at ?? null,
        run_url: remote?.run_url ?? null,
        artifact: remote?.artifact ?? artifactName,
        artifact_digest: remote?.artifact_digest ?? null,
        upstream_repository: 'olicesx/kixdns',
        upstream_commit: upstreamCommit,
        patchset: 5,
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
  if (path === '/api/v1/kixdns/versions' && method === 'GET') return demoVersionCatalog() as T
  if (path.startsWith('/api/v1/kixdns/versions/') && method === 'POST') {
    const commit = path.split('/')[5]
    if (path.endsWith('/install')) installedKixdnsCommits.add(commit)
    activeKixdnsCommit = commit
    serviceRunning = true
    const version = demoVersionCatalog().installed_versions.find((item) => item.commit === commit)
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
    const latest = demoRemoteVersions[0]
    return { installed_commit: updateAvailable ? activeKixdnsCommit : latest.commit, latest_commit: latest.commit, run_id: latest.run_id, created_at: latest.created_at, run_url: latest.run_url, artifact: latest.artifact, artifact_digest: latest.artifact_digest, download_url: latest.download_url, available: updateAvailable } as UpdateInfo as T
  }
  throw new Error(`未实现的演示接口：${method} ${path}`)
}

export type { ValidationResult, ServiceStatus }
