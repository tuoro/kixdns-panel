import { isIp, upstreamFault } from '../config-model/grammar'
import { normalizeAddress } from '../config-model/kernel'
import type { KernelConfig } from '../config-model/model'
import { CONFIG_BOOTSTRAP_V1 } from './schema'
import type { GlobalSettings } from './types'

// 设置页在框下面说的话：内核拒收的写法（problems），和照样能用、却值得知道的（warnings）。都照内核的读法：
// settings 的 problems() 和 warnings()（内核 src/config.rs）
// What the settings page says under a box: writings the kernel refuses (problems), and ones that work yet are worth knowing about
// (warnings). Both read as the kernel reads them: problems() and warnings() for settings (kernel src/config.rs)

/** 逗号分开的一串地址，去掉空白和空的几段（内核的 split_upstreams） / A comma-separated list, trimmed with empty parts dropped (the kernel's split_upstreams) */
export const splitAddresses = (text: string): string[] => text.split(',').map((part) => part.trim()).filter(Boolean)

/**
 * 设置里内核不收的写法，key 对一句说法。capabilities 是内核报的配置能力，null 时不知道（KixDNS 没报），不按能力说
 * The settings the kernel refuses as written, key to one sentence. capabilities are the kernel's config capabilities, null when unknown
 * (KixDNS reported none), when nothing is said by capability
 */
export function settingProblems(settings: GlobalSettings, capabilities: readonly string[] | null): Record<string, string> {
  const problems: Record<string, string> = {}
  const bootstrap = settings.bootstrap
  if (bootstrap !== undefined && capabilities && !capabilities.includes(CONFIG_BOOTSTRAP_V1)) {
    problems.bootstrap = '当前内核不认引导 DNS：清空它，或者先把内核更新到最新'
  } else if (typeof bootstrap === 'string') {
    // 引导 DNS 自己就是解析上游名字的：只能写成 IP 和端口，经 UDP 问，不带前缀 / Bootstrap is what resolves upstream names: an IP and a
    // port only, asked over UDP, with no prefix
    const wrong = splitAddresses(bootstrap).find((server) => server.includes('://') || upstreamFault(server, 'udp') !== null)
    if (wrong !== undefined) problems.bootstrap = `「${wrong}」不是「IP:端口」：引导 DNS 只能写成 IP 和端口，比如 223.5.5.5:53`
  }
  return problems
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
