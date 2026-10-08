// iPhone 和 iPad 上，字小于 16 的输入框一聚焦，Safari 就把整页放大，离开后也不缩回去。
// 框里的字和正文一样是 14，所以在这些设备上给 viewport 加 maximum-scale=1：iOS 10 起它只挡住聚焦放大，
// 用户自己双指缩放照样能用。别的平台不加，安卓上这一条会连双指缩放一起关掉。
// On iPhone and iPad, Safari zooms the whole page when a field with text under 16px gains focus, and stays zoomed.
// Field text is 14 like body text, so these devices get maximum-scale=1 on the viewport: since iOS 10 it only stops
// the focus zoom and pinch-zoom keeps working. Other platforms are left alone, since on Android it would also turn off pinch-zoom.

export interface NavigatorLike { userAgent: string; platform?: string; maxTouchPoints?: number }

export function isIos(nav: NavigatorLike): boolean {
  if (/iPad|iPhone|iPod/.test(nav.userAgent)) return true
  // iPadOS 13 起自称 Mac：桌面版 Safari 的 UA，但有多点触摸 / iPadOS 13+ reports a Mac user agent but has multi-touch
  return nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1
}

// viewport 是页面里那个 <meta name="viewport"> / viewport is the page's <meta name="viewport">
export function stopIosFocusZoom(viewport: { content: string } | null, nav: NavigatorLike): void {
  if (!viewport || !isIos(nav) || /maximum-scale/.test(viewport.content)) return
  viewport.content = `${viewport.content}, maximum-scale=1`
}
