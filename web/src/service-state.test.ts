import { describe, expect, it } from 'vitest'
import { serviceLabel, serviceTone } from './service-state'

const status = (active_state: string, sub_state: string) => ({ unit: 'kixdns.service', active_state, sub_state, main_pid: 0 })

describe('服务状态的说法', () => {
  it('起不来、systemd 正在重试和放弃了一样是「启动失败」；真在启动才是「正在启动」', () => {
    expect(serviceLabel(status('activating', 'auto-restart'))).toBe('启动失败')
    expect(serviceTone(status('activating', 'auto-restart'))).toBe('err')
    expect(serviceLabel(status('activating', 'start'))).toBe('正在启动')
    expect(serviceLabel(status('failed', 'failed'))).toBe('启动失败')
    expect(serviceLabel(status('active', 'running'))).toBe('运行中')
    expect(serviceLabel(status('inactive', 'dead'))).toBe('已停止')
    expect(serviceLabel(status('deactivating', 'stop-sigterm'))).toBe('正在停止')
    expect(serviceLabel(null)).toBe('已停止')
    // 服务端看出它起不来时，systemd 重试那一下的 active 也照「启动失败」说 / When the server sees it not coming up, even the
    // active of a systemd retry reads 启动失败
    expect(serviceLabel({ ...status('active', 'running'), did_not_come_up: true })).toBe('启动失败')
  })
})
