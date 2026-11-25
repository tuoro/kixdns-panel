import { isIp, upstreamFault } from '../config-model/grammar'
import { normalizeAddress } from '../config-model/kernel'
import type { KernelConfig } from '../config-model/model'
import { CONFIG_BOOTSTRAP_V1, SETTING_SECTIONS, settingValue } from './schema'
import type { GlobalSettings } from './types'

// 设置页在框下面说的话：内核拒收的写法（problems），和照样能用、却值得知道的（warnings）。都照内核的读法：
// settings 的 problems() 和 warnings()（内核 src/config.rs）
// What the settings page says under a box: writings the kernel refuses (problems), and ones that work yet are worth knowing about
// (warnings). Both read as the kernel reads them: problems() and warnings() for settings (kernel src/config.rs)

/** 逗号分开的一串地址，去掉空白和空的几段（内核的 split_upstreams） / A comma-separated list, trimmed with empty parts dropped (the kernel's split_upstreams) */
export const splitAddresses = (text: string): string[] => text.split(',').map((part) => part.trim()).filter(Boolean)

/**
 * 设置里内核不收的写法，key 对一句说法，和内核一一对上：数字的类型和范围（读配置时的整数类型、GlobalSettings::validate、
 * 超过上限的 over_limits），相互关系（整体超时不小于上游超时），problems() 里的 doh_path 和 bootstrap，以及
 * GlobalSettings::listeners 的监听地址和 DoH 要的证书、私钥。没写的照内核的默认值算。capabilities 是内核报的配置能力，null 时不知道
 * （KixDNS 没报），不按能力说
 * The settings the kernel refuses as written, key to one sentence, matching the kernel one for one: numbers' types and ranges (the integer
 * types the config is read into, GlobalSettings::validate, over_limits past a limit), how they relate (the overall timeout no less than the
 * upstream one), doh_path and bootstrap from problems(), and the listen addresses with the certificate and key DoH needs from
 * GlobalSettings::listeners. An unset one counts as the kernel's default. capabilities are the kernel's config capabilities, null when
 * unknown (KixDNS reported none), when nothing is said by capability
 */
export function settingProblems(settings: GlobalSettings, capabilities: readonly string[] | null): Record<string, string> {
  const problems: Record<string, string> = {}
  for (const field of SETTING_SECTIONS.flatMap((section) => section.fields)) {
    const value = settings[field.key]
    if (field.type !== 'number' || value === undefined || (value === null && field.nullable)) continue
    const problem = field.key === 'dashmap_shards' ? shardsProblem(value) : wholeNumberProblem(value, field.min ?? 0, field.max)
    if (problem) problems[field.key] = problem
  }
  const upstream = settingValue(settings, 'upstream_timeout_ms')
  const request = settings.request_timeout_ms
  if (!problems.request_timeout_ms && !problems.upstream_timeout_ms && typeof request === 'number' && typeof upstream === 'number' && request < upstream) {
    problems.request_timeout_ms = `不能小于上游超时（${upstream} 毫秒）`
  }
  const doh = settings.doh_path
  if (doh !== undefined && (typeof doh !== 'string' || !doh.startsWith('/'))) problems.doh_path = '要以 / 开头：不以它开头的路径谁也对不上，DoH 每个请求都回 404'
  for (const key of ['bind_udp', 'bind_tcp', 'bind_doh']) {
    const bind = settings[key]
    if (bind === undefined || (bind === null && key === 'bind_doh')) continue
    if (!isSocketAddress(bind)) problems[key] = '要写成「IP:端口」，比如 0.0.0.0:53 或 [::]:53'
  }
  // 写了 DoH 监听地址（写错的也算）就要证书和私钥，空的字符串也算写了 / A DoH listen address written (a wrong one too) needs the
  // certificate and key, an empty string counting as written
  if (settings.bind_doh !== undefined && settings.bind_doh !== null) {
    if (settings.doh_tls_cert === undefined || settings.doh_tls_cert === null) problems.doh_tls_cert = '写了 DoH 监听地址就要写证书'
    if (settings.doh_tls_key === undefined || settings.doh_tls_key === null) problems.doh_tls_key = '写了 DoH 监听地址就要写私钥'
  }
  const bootstrap = settings.bootstrap
  if (bootstrap !== undefined && capabilities && !capabilities.includes(CONFIG_BOOTSTRAP_V1)) {
    problems.bootstrap = '当前内核不认引导 DNS：清空它，或者先把内核更新到最新'
  } else if (bootstrap !== undefined) {
    // 引导 DNS 自己就是解析上游名字的：只能写成 IP 和端口，经 UDP 问，不带前缀 / Bootstrap is what resolves upstream names: an IP and a
    // port only, asked over UDP, with no prefix
    const wrong = typeof bootstrap === 'string' ? splitAddresses(bootstrap).find((server) => server.includes('://') || upstreamFault(server, 'udp') !== null) : String(bootstrap)
    if (wrong !== undefined) problems.bootstrap = `「${wrong}」不是「IP:端口」：引导 DNS 只能写成 IP 和端口，比如 223.5.5.5:53`
  }
  return problems
}

// 不写 max 的数字是 u64：小于 2^64（2^64 以下的双精度数都在 u64 以内） / A number without a max is a u64: below 2^64 (every double below
// 2^64 is within u64)
const U64_LIMIT = 2 ** 64
function wholeNumberProblem(value: unknown, min: number, max: number | undefined): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && (max === undefined ? value < U64_LIMIT : value <= max)) return null
  if (max !== undefined) return `填 ${min} 到 ${max} 之间的整数`
  return min > 0 ? `填大于 ${min - 1} 的整数` : '填 0 或更大的整数'
}

// DashMap 的分片数：0（自动），或者 2 到 MAX_DASHMAP_SHARDS（65536）之间 2 的幂 / DashMap's shards: 0 (auto), or a power of two from 2
// to MAX_DASHMAP_SHARDS (65536)
function shardsProblem(value: unknown): string | null {
  const ok = typeof value === 'number' && Number.isInteger(value) && (value === 0 || (value >= 2 && value <= 65536 && (value & (value - 1)) === 0))
  return ok ? null : '填 0（自动），或者 2 到 65536 之间 2 的幂（2、4、8……）'
}

// 内核的 SocketAddr：「IPv4:端口」或「[IPv6]:端口」，不带前缀、前后不留空白，端口可以是 0 / The kernel's SocketAddr: 「IPv4:port」 or
// 「[IPv6]:port」, no prefix, nothing around it, port 0 allowed
function isSocketAddress(value: unknown): boolean {
  if (typeof value !== 'string' || value !== value.trim() || value.includes('://')) return false
  const fault = upstreamFault(value, 'udp')
  return fault === null || fault === 'port'
}

/** 写了引导 DNS（至少一个地址） / Whether bootstrap is written (one address at least) */
export const hasBootstrap = (settings: GlobalSettings): boolean => typeof settings.bootstrap === 'string' && splitAddresses(settings.bootstrap).length > 0

/**
 * 配置里第一个写成主机名、要先解析的上游，没有为 null：没写引导 DNS 时它交给系统解析（内核 host_names_without_bootstrap 的那条
 * warning）。上游和内核转发时一样算：默认上游，加上每个转发动作写的上游（没写就是默认上游），按动作的传输读，前缀说了算；UDP 只认 IP
 * The first upstream in the config written with a host name, to be resolved first, null when there is none: with no bootstrap written it
 * goes to the system resolver (the warning of the kernel's host_names_without_bootstrap). Upstreams count as a forward does: the default
 * upstream and the upstream each forward action writes (the default one when it writes none), read by the action's transport, the prefix
 * winning; UDP takes IPs only
 */
export function hostNamedUpstream(config: KernelConfig): string | null {
  const fallback = typeof config.settings.default_upstream === 'string' ? config.settings.default_upstream : ''
  const forwards = config.pipelines
    .flatMap((pipeline) => pipeline.rules)
    .flatMap((rule) => [...(rule.actions ?? []), ...(rule.response_actions_on_match ?? []), ...(rule.response_actions_on_miss ?? [])])
    .filter((action) => action.type === 'forward')
    .map((action) => ({ upstream: typeof action.upstream === 'string' && action.upstream.trim() ? action.upstream : fallback, transport: typeof action.transport === 'string' ? action.transport : 'udp' }))
  for (const { upstream, transport } of [{ upstream: fallback, transport: 'udp' }, ...forwards]) {
    for (const address of splitAddresses(upstream)) {
      const host = hostName(address, transport)
      if (host) return host
    }
  }
  return null
}

// 连一个上游之前要解析的主机名，读法和内核的 host_name 一样；写成 IP 的、UDP 的没有
// The host name to resolve before connecting to an upstream, read as the kernel's host_name reads it; none for an IP or for UDP
function hostName(upstream: string, transport: string): string | null {
  const normal = normalizeAddress(upstream, transport)
  const cut = normal.indexOf(':')
  const kind = normal.slice(0, cut)
  const address = normal.slice(cut + 1)
  let host: string | undefined
  if (kind === 'tcp') host = address.includes(':') ? address.slice(0, address.lastIndexOf(':')) : undefined
  else if (kind === 'doh') host = hostOf(/^https?:\/\//i.test(address) ? address : `https://${address}`)
  else if (kind === 'dot' || kind === 'doq') host = hostOf(`${kind}://${address}`)
  if (!host) return null
  const bare = host.replace(/^\[(.*)\]$/, '$1')
  return isIp(bare) ? null : host
}

function hostOf(text: string): string | undefined {
  try {
    return new URL(text).hostname || undefined
  } catch {
    return undefined
  }
}
