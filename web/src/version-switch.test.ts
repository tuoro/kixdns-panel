import { describe, expect, it } from 'vitest'
import type { ServiceStatus } from './api/types'
import { switchConfirmBody, switchedMessage } from './version-switch'

function service(active_state: string): ServiceStatus {
  return { unit: 'kixdns.service', active_state, sub_state: 'running', main_pid: 1428 }
}

describe('版本切换文案', () => {
  // 服务端把 activating、reloading 也算作在运行并重启它，文案不能说「不会启动」。
  // The server counts activating and reloading as running and restarts the service.
  it.each(['active', 'activating', 'reloading'])('%s 的服务按在运行说明会重启', (state) => {
    expect(switchConfirmBody(service(state))).toContain('会用新版本重启')
    expect(switchedMessage(service(state), '版本已切换')).toBe('KixDNS 版本已切换并通过健康检查')
  })

  it.each(['inactive', 'failed', 'deactivating'])('%s 的服务按已停止说明只替换程序', (state) => {
    expect(switchConfirmBody(service(state))).toContain('不会启动服务')
    expect(switchedMessage(service(state), '已安装')).toBe('KixDNS 已安装，服务仍停止，下次启动时生效')
  })

  it('状态未知时两种情况都说', () => {
    expect(switchConfirmBody(null)).toContain('正在运行则用新版本重启')
  })
})
