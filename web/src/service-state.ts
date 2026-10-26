import type { ServiceStatus } from './api/types'

export type ServiceTone = 'ok' | 'warn' | 'err' | 'off'

// 服务状态怎么说，概览、系统页、配置页同一套：起不来、systemd 正在隔几秒重试，和 systemd 放弃了一样是「启动失败」，
// 不是「正在启动」（那样像是等一会儿就好）；「正在启动」只留给真在启动的时候
// How the service state is told, the same on the overview, the system page and the config page: one that does not come up
// while systemd retries every few seconds is 启动失败, as when systemd gave up, not 正在启动 (which suggests it will be fine
// shortly); 正在启动 is kept for a start really under way
export function serviceTone(status: ServiceStatus | null | undefined): ServiceTone {
  if (!status) return 'off'
  // 服务端看出它起不来时照它说：systemd 重试的那一下服务是 active，只看当下的状态会在「运行中」和「启动失败」之间跳
  // When the server sees it not coming up, that wins: during a systemd retry the service reads active, and the state of the
  // moment alone would jump between 运行中 and 启动失败
  if (status.did_not_come_up || status.active_state === 'failed' || status.sub_state === 'auto-restart') return 'err'
  if (status.active_state === 'active') return 'ok'
  if (['activating', 'reloading', 'deactivating'].includes(status.active_state)) return 'warn'
  return 'off'
}

export function serviceLabel(status: ServiceStatus | null | undefined): string {
  if (status?.active_state === 'deactivating') return '正在停止'
  return { ok: '运行中', warn: '正在启动', err: '启动失败', off: '已停止' }[serviceTone(status)]
}
