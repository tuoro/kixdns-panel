import { describe, expect, it } from 'vitest'
import { serviceLabel, serviceTone } from './service-state'

const status = (active_state: string, sub_state: string) => ({ unit: 'kixdns.service', active_state, sub_state, main_pid: 0 })

describe('服务状态的说法', () => {
  it('起不来、systemd 正在重试是「正在启动」，放弃了是「启动失败」', () => {
    expect(serviceLabel(status('activating', 'auto-restart'))).toBe('正在启动')
    expect(serviceTone(status('activating', 'auto-restart'))).toBe('warn')
    expect(serviceLabel(status('failed', 'failed'))).toBe('启动失败')
    expect(serviceLabel(status('active', 'running'))).toBe('运行中')
    expect(serviceLabel(status('inactive', 'dead'))).toBe('已停止')
    expect(serviceLabel(status('deactivating', 'stop-sigterm'))).toBe('正在停止')
    expect(serviceLabel(null)).toBe('已停止')
  })
})
