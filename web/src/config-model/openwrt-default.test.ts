import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { importKernel } from './importer'

// OpenWrt 安装包的默认内核配置：面板读进来是普通的规则和上游组，不是看不懂的高级规则；IPv4、IPv6 都听，.lan 交给 5353 上的 dnsmasq；
// 智能流控开着，路由器内存小，不开的话洪泛时内核会被系统杀掉
// The OpenWrt package's default kernel config: the panel reads it as ordinary rules and upstream groups, not unreadable
// advanced rules; it listens on IPv4 and IPv6, and .lan goes to dnsmasq on 5353; flow control is on, since a router has
// little memory and without it a flood gets the kernel killed
const read = (path: string) => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')) as Record<string, unknown>

describe('OpenWrt 的默认配置', () => {
  const cfg = read('../../../deploy/openwrt/pipeline.json')

  it('IPv4、IPv6 都听，智能流控开着，其余和 systemd 版的默认配置一样', () => {
    const settings = cfg.settings as Record<string, unknown>
    expect(settings.bind_udp).toBe('[::]:53')
    expect(settings.bind_tcp).toBe('[::]:53')
    expect(settings.flow_control_enabled).toBe(true)
    const own = { bind_udp: undefined, bind_tcp: undefined, flow_control_enabled: undefined }
    const systemd = read('../../../deploy/config/pipeline.json').settings as Record<string, unknown>
    expect({ ...settings, ...own }).toEqual({ ...systemd, ...own })
  })

  it('面板读成一条普通规则：.lan 交给 127.0.0.1:5353，其余照默认上游', () => {
    const { model } = importKernel(cfg as never)
    expect(model.rawPipelines ?? []).toHaveLength(0)
    expect(model.rules).toHaveLength(1)
    const [rule] = model.rules
    expect(rule!.name).toBe('局域网主机名交给 dnsmasq')
    expect(rule!.conditions).toEqual([[expect.objectContaining({ field: 'domain', negate: false, regex: false, values: ['lan'] })]])
    expect(rule!.outcome.type).toBe('upstream')
    const group = model.groups.find((g) => rule!.outcome.type === 'upstream' && g.id === rule!.outcome.group)
    expect(group?.addresses.map((a) => a.address)).toEqual(['127.0.0.1:5353'])
  })
})
