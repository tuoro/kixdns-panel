import { expect, test, type Locator } from '@playwright/test'

// 标志「块面 K」：侧栏、手机顶栏和登录页都是不带底色方块的双色 K，竖条跟文字色、「<」是品牌色，深色模式跟着换；
// 浏览器标签的图标和它是同一个图形，「添加到主屏幕」另有一张白底的图
// The block K: the sidebar, the phone header and the sign-in page show the two-tone K with no tile behind it, the stem in the text
// colour and the 「<」 in the accent, both following dark mode; the tab icon draws the same shape, and the home screen gets a white-tile image

// 竖条、「<」、整个标志的底色 / The stem, the 「<」 and the mark's own background
const colours = (mark: Locator) => mark.evaluate((svg) => [svg.querySelector('rect')!, svg.querySelector('path')!, svg].map((el, i) => (i < 2 ? getComputedStyle(el).fill : getComputedStyle(el).backgroundColor)))
const LIGHT = ['rgb(21, 23, 29)', 'rgb(91, 91, 214)', 'rgba(0, 0, 0, 0)']
const DARK = ['rgb(232, 234, 240)', 'rgb(140, 140, 240)', 'rgba(0, 0, 0, 0)']

test('侧栏和手机顶栏的标志：不带底的双色 K，深色模式跟着换 @responsive', async ({ page }) => {
  await page.goto('/')
  const mark = page.locator('.app-brand .brand-mark')
  await expect(mark).toBeVisible()
  expect(await colours(mark)).toEqual(LIGHT)
  expect((await mark.boundingBox())!.width).toBe(22)
  await page.emulateMedia({ colorScheme: 'dark' })
  expect(await colours(mark)).toEqual(DARK)
})

test('登录页的标志和侧栏同一个 @responsive', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-signed-out', 'true'))
  await page.goto('/login')
  const mark = page.locator('.auth-brand .brand-mark')
  await expect(mark).toBeVisible()
  expect(await colours(mark)).toEqual(LIGHT)
  await page.emulateMedia({ colorScheme: 'dark' })
  expect(await colours(mark)).toEqual(DARK)
})

test('浏览器标签的图标是同一个图形，「添加到主屏幕」有自己的图', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.svg')
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/apple-touch-icon.png')
  // 两处各写了一遍图形：改了一处没改另一处，这里会对不上 / The shape is written in two places: changing one without the other fails here
  const shape = await page.locator('.app-brand .brand-mark path').getAttribute('d')
  const favicon = await page.request.get('/favicon.svg')
  expect(favicon.ok()).toBe(true)
  expect(await favicon.text()).toContain(`d="${shape}"`)
  const touch = await page.request.get('/apple-touch-icon.png')
  expect(touch.ok()).toBe(true)
  expect(touch.headers()['content-type']).toBe('image/png')
})
