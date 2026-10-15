import { expect, test } from '@playwright/test'

// 打包的字体从本站加载、真的用在界面上；中文页面不会因此多下载任何东西。
// 拉丁文字和数字是 Inter（一个可变字重文件覆盖 400–700），域名、地址这类字面量也是；哈希和代码是 IBM Plex Mono。
// The bundled fonts load from this origin and are actually in use; Chinese text
// never pulls in anything beyond them. Latin text and digits are Inter (one
// variable-weight file covering 400–700), literals such as domains and addresses too; hashes and code are IBM Plex Mono.
test('打包的字体从本站加载，正文和字面量用 Inter，哈希用等宽 @responsive', async ({ page }) => {
  const fontUrls: string[] = []
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fontUrls.push(request.url())
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: '概览' })).toBeVisible()
  // 标题先于数据出现；等看得见的上游地址和配置摘要渲染出来再读它们的字体。
  const address = page.locator('.overview-address:visible').first()
  const hash = page.locator('.ui-mono:visible').first()
  await expect(address).toBeVisible()
  await expect(hash).toBeVisible()

  const family = (element: Element) => getComputedStyle(element).fontFamily.split(',')[0].replace(/"/g, '').trim()
  expect(await page.locator('body').evaluate(family)).toBe('Inter')
  expect(await page.getByRole('heading', { level: 1 }).evaluate(family)).toBe('Inter')
  expect(await address.evaluate(family)).toBe('Inter')
  expect(await hash.evaluate(family)).toBe('IBM Plex Mono')

  // Inter 是一个可变字重文件，400 和 700 都落到同一张「400 700」的字面 / Inter is one variable file: 400 and 700 both resolve to the single 「400 700」 face
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready
    const faces = async (font: string) => (await document.fonts.load(font, 'Aa1')).map((face) => `${face.family.replace(/"/g, '')} ${face.weight} ${face.status}`)
    return { inter: await faces('400 14px Inter'), interBold: await faces('700 14px Inter'), mono: await faces('400 14px "IBM Plex Mono"') }
  })
  expect(loaded.inter).toEqual(['Inter 400 700 loaded'])
  expect(loaded.interBold).toEqual(['Inter 400 700 loaded'])
  expect(loaded.mono).toEqual(['IBM Plex Mono 400 loaded'])

  // 只从本站取 woff2，没有外链字体，也没有第五个文件：Inter 一个、Plex Mono 最多三个，中文落到系统字体，不触发下载。
  // Only woff2 from this origin, no external fonts and no fifth file: one Inter, at most three Plex Mono; Chinese falls to system fonts and triggers no download.
  const origin = new URL(page.url()).origin
  expect(fontUrls.length).toBeGreaterThan(0)
  for (const url of fontUrls) {
    expect(new URL(url).origin).toBe(origin)
    expect(new URL(url).pathname).toMatch(/(inter-latin-wght-normal|ibm-plex-mono-latin-\d00-normal)[^/]*\.woff2$/)
  }
  expect(new Set(fontUrls).size).toBeLessThanOrEqual(4)
})
