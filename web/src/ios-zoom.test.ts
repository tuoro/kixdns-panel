import { describe, expect, it } from 'vitest'
import { isIos, stopIosFocusZoom } from './ios-zoom'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'

const viewport = () => ({ content: 'width=device-width, initial-scale=1.0' })

describe('iPhone 聚焦放大', () => {
  it('认出 iPhone 和自称 Mac 的 iPad，安卓和真正的 Mac 不算', () => {
    expect(isIos({ userAgent: IPHONE })).toBe(true)
    expect(isIos({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true)
    expect(isIos({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false)
    expect(isIos({ userAgent: ANDROID, platform: 'Linux armv8l', maxTouchPoints: 5 })).toBe(false)
  })

  it('只在 iOS 上给 viewport 加 maximum-scale=1，加过不重复加', () => {
    const ios = viewport()
    stopIosFocusZoom(ios, { userAgent: IPHONE })
    stopIosFocusZoom(ios, { userAgent: IPHONE })
    expect(ios.content).toBe('width=device-width, initial-scale=1.0, maximum-scale=1')
    const android = viewport()
    stopIosFocusZoom(android, { userAgent: ANDROID })
    expect(android.content).toBe('width=device-width, initial-scale=1.0')
    expect(() => stopIosFocusZoom(null, { userAgent: IPHONE })).not.toThrow()
  })
})
