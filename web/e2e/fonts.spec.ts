import { expect, test } from '@playwright/test'

// 打包的字体从本站加载、真的用在界面上；中文页面不会因此多下载任何东西。
// The bundled fonts load from this origin and are actually in use; Chinese text
// never pulls in anything beyond them.
test('打包的字体从本站加载，拉丁文字、机器值各用各的字体 @responsive', async ({ page }) => {
  const fontUrls: string[] = []
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fontUrls.push(request.url())
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: '运行概览' })).toBeVisible()
  // 标题先于数据出现；等一个看得见的机器值（上游地址）渲染出来再读它的字体。
  const machineValue = page.locator('.overview-mono:visible').first()
  await expect(machineValue).toBeVisible()

  const family = (element: Element) => getComputedStyle(element).fontFamily.split(',')[0].replace(/"/g, '').trim()
  expect(await page.locator('body').evaluate(family)).toBe('Archivo')
  expect(await page.getByRole('heading', { level: 1 }).evaluate(family)).toBe('Archivo')
  expect(await machineValue.evaluate(family)).toBe('IBM Plex Mono')

  const loaded = await page.evaluate(async () => {
    await document.fonts.ready
    const faces = async (font: string) => (await document.fonts.load(font, 'Aa1')).map((face) => `${face.family.replace(/"/g, '')} ${face.weight} ${face.status}`)
    return { archivo: await faces('400 14px Archivo'), mono: await faces('400 14px "IBM Plex Mono"') }
  })
  expect(loaded.archivo).toEqual(['Archivo 400 loaded'])
  expect(loaded.mono).toEqual(['IBM Plex Mono 400 loaded'])

  // 只从本站取 woff2，没有外链字体，也没有第八个文件：中文落到系统字体，不触发下载。
  const origin = new URL(page.url()).origin
  expect(fontUrls.length).toBeGreaterThan(0)
  for (const url of fontUrls) {
    expect(new URL(url).origin).toBe(origin)
    expect(new URL(url).pathname).toMatch(/(archivo|ibm-plex-mono)-latin-\d00-normal[^/]*\.woff2$/)
  }
  expect(new Set(fontUrls).size).toBeLessThanOrEqual(7)
})
