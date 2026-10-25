import type { ServiceStatus } from './api/types'

export type ServiceTone = 'ok' | 'warn' | 'err' | 'off'

// 服务状态怎么说，概览和系统页同一套：起不来、systemd 正在隔几秒重试时是「正在启动」，不是「已停止」；systemd 放弃了是「启动失败」
// How the service state is told, the same on the overview and the system page: one that does not come up while systemd retries
// every few seconds is 正在启动, not 已停止; one systemd gave up on is 启动失败
export function serviceTone(status: ServiceStatus | null | undefined): ServiceTone {
  if (!status) return 'off'
  if (status.active_state === 'active') return 'ok'
  if (status.active_state === 'failed') return 'err'
  if (['activating', 'reloading', 'deactivating'].includes(status.active_state) || status.sub_state === 'auto-restart') return 'warn'
  return 'off'
}

export function serviceLabel(status: ServiceStatus | null | undefined): string {
  if (status?.active_state === 'deactivating') return '正在停止'
  return { ok: '运行中', warn: '正在启动', err: '启动失败', off: '已停止' }[serviceTone(status)]
}
