import type { ServiceStatus } from './api/types'

/**
 * 与服务端 LiveServiceHost::service_running 同一组状态：正在启动、正在重载
 * 的服务切换时同样会被重启，文案必须一致。
 *
 * The same set of states as the server's LiveServiceHost::service_running:
 * a service that is activating or reloading is restarted by a switch too, so
 * the wording must agree.
 */
export function serviceRunsForSwitch(service: ServiceStatus | null): boolean {
  return ['active', 'activating', 'reloading'].includes(service?.active_state ?? '')
}

/**
 * 切换前说清会发生什么。服务端按切换那一刻的状态决定：在运行就重启一次，
 * 停着就只换程序、不启动，两种情况都不改开机自启。这里按页面已读到的服务
 * 状态提前告诉用户是哪一种；状态未知时两种都说。
 *
 * Say what a switch will do before it happens. The server decides from the
 * state at switch time: a running service restarts once, a stopped one only
 * gets the new binary and is not started, and neither changes boot behaviour.
 * The page tells the user which one from the service state it already has,
 * and names both when that state is unknown.
 */
export function switchConfirmBody(service: ServiceStatus | null): string {
  const effect = !service
    ? 'KixDNS 正在运行则用新版本重启，DNS 短暂中断；已停止则只替换程序，不会启动。'
    : serviceRunsForSwitch(service)
      ? 'KixDNS 会用新版本重启，DNS 解析短暂中断；健康检查不通过会自动换回当前版本。'
      : 'KixDNS 当前已停止，这次只替换程序，不会启动服务，下次启动时使用新版本。'
  return `${effect}开机自启设置保持不变。`
}

/**
 * 切换后重新读过服务状态：服务在跑说明新版本已通过健康检查，停着说明还没生效。
 *
 * The service state is re-read after the switch: running means the new
 * version passed its health check, stopped means it is not in effect yet.
 */
export function switchedMessage(service: ServiceStatus | null, done: string): string {
  return serviceRunsForSwitch(service)
    ? `KixDNS ${done}并通过健康检查`
    : `KixDNS ${done}，服务仍停止，下次启动时生效`
}
