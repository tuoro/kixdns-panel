import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }))
vi.mock('./api/client', () => ({ apiRequest, CONFIG_WRITTEN_EVENT: 'kixdns:config-written' }))

import { clientRegionText, forgetRegions, knownRegions, lookupRegions, regionText } from './ip-region'

beforeEach(() => {
  forgetRegions()
  apiRequest.mockReset()
})

describe('地区的写法', () => {
  it('内网写「内网」，代码照写，几个国家用「/」连起来', () => {
    expect(regionText(undefined)).toBe('')
    expect(regionText(null)).toBe('')
    expect(regionText({ local: true })).toBe('内网')
    expect(regionText({ codes: ['US'] })).toBe('US')
    expect(regionText({ codes: ['GOOGLE'] })).toBe('GOOGLE')
    expect(regionText({ codes: ['CN', 'HK'] })).toBe('CN/HK')
  })

  it('客户端只在公网地址上写，内网客户端是常态', () => {
    expect(clientRegionText({ local: true })).toBe('')
    expect(clientRegionText({ codes: ['CN'] })).toBe('CN')
    expect(clientRegionText(undefined)).toBe('')
  })
})

describe('去问面板', () => {
  it('只问地址，一个地址问一次，问过的记住', async () => {
    apiRequest.mockResolvedValueOnce({ regions: [{ codes: ['CN'] }, { local: true }] })
    const found = await lookupRegions(['1.2.3.4', 'cdn.example.net.', '1.2.3.4', '10.0.0.1'])
    expect(apiRequest).toHaveBeenCalledTimes(1)
    expect(apiRequest).toHaveBeenCalledWith('/api/v1/geoip/regions?ips=1.2.3.4%2C10.0.0.1')
    expect(found).toEqual(new Map([['1.2.3.4', { codes: ['CN'] }], ['10.0.0.1', { local: true }]]))
    expect(knownRegions(['10.0.0.1', '8.8.8.8'])).toEqual(new Map([['10.0.0.1', { local: true }]]))

    apiRequest.mockResolvedValueOnce({ regions: [null] })
    const again = await lookupRegions(['1.2.3.4', '8.8.8.8'])
    expect(apiRequest).toHaveBeenLastCalledWith('/api/v1/geoip/regions?ips=8.8.8.8')
    expect(again).toEqual(new Map([['1.2.3.4', { codes: ['CN'] }], ['8.8.8.8', null]]))
  })

  it('问不到就不标，下次再问', async () => {
    apiRequest.mockRejectedValueOnce(new Error('panel down'))
    expect(await lookupRegions(['1.2.3.4'])).toEqual(new Map())
    apiRequest.mockResolvedValueOnce({ regions: [{ codes: ['CN'] }] })
    expect(await lookupRegions(['1.2.3.4'])).toEqual(new Map([['1.2.3.4', { codes: ['CN'] }]]))
    expect(apiRequest).toHaveBeenCalledTimes(2)
  })

  it('一次最多问 32 个，和面板的上限一样', async () => {
    const many = Array.from({ length: 40 }, (_, at) => `1.2.3.${at}`)
    apiRequest.mockImplementation(async (path: string) => ({ regions: decodeURIComponent(path.split('ips=')[1]!).split(',').map(() => null) }))
    await lookupRegions(many)
    expect(decodeURIComponent((apiRequest.mock.calls[0]![0] as string).split('ips=')[1]!).split(',')).toHaveLength(32)
  })
})
