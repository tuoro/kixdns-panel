import { expect, test } from '@playwright/test'

// 外观：跟随系统（默认）、浅色、深色。选了就记在本机，刷新还在；令牌换值，页面不用改。
// Appearance: follow the system (default), light or dark. A choice is kept on this device across reloads; tokens take new values, pages stay as they are.
test('外观跟随系统：系统偏好深色时底色是深的，没有选过就不写 data-theme @responsive', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.locator('main h1')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull()
  const dark = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--l-canvas').trim())
  expect(dark).toBe('#0f1117')
  await page.emulateMedia({ colorScheme: 'light' })
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--l-canvas').trim())).toBe('#f3f4f8')
})

test('铃铛旁的外观按钮：选深色立刻生效、图标跟着变、刷新还在，选回跟随系统就去掉 @responsive', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('main h1')).toBeVisible()
  const button = page.getByRole('button', { name: /^外观：/ })
  await expect(button).toHaveAccessibleName('外观：跟随系统')
  await button.click()
  const popover = page.getByRole('dialog', { name: '外观', exact: true })
  await expect(popover.getByRole('radio', { name: '跟随系统' })).toHaveAttribute('aria-checked', 'true')
  await popover.getByRole('radio', { name: '深色' }).click()
  await expect(popover).toBeHidden()
  await expect(button).toHaveAccessibleName('外观：深色')
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark')
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--l-canvas').trim())).toBe('#0f1117')
  await page.reload()
  await expect(page.locator('main h1')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark')
  await expect(button).toHaveAccessibleName('外观：深色')
  await button.click()
  await popover.getByRole('radio', { name: '跟随系统' }).click()
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull()
  expect(await page.evaluate(() => localStorage.getItem('kixdns-panel.theme'))).toBeNull()
})

// 提示条全站一个位置：桌面右下、手机底部导航上方；配置页有保存条时抬到它上面，不盖页头的主按钮
// Toasts sit in one place everywhere: desktop bottom right, phones above the bottom navigation; lifted over the save bar on the config page, never over the header's primary button
test('提示条在右下 / 底部导航上方，保存条在时抬到它上面 @responsive', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await page.goto('/config')
  await expect(page.locator('main h1')).toBeVisible()
  if (!mobile) await page.getByRole('button', { name: '快速添加' }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('example.org')
  await quick.press('Enter')
  await expect(page.locator('.toast')).toHaveCount(1)
  const box = await page.evaluate(() => {
    const t = document.querySelector('.toast-stack')!.getBoundingClientRect()
    const bar = document.querySelector('.cfg__savebar')!.getBoundingClientRect()
    const header = document.querySelector('.ui-ph')!.getBoundingClientRect()
    return { toastBottom: t.bottom, toastTop: t.top, toastRight: innerWidth - t.right, barTop: bar.top, headerBottom: header.bottom, vh: innerHeight }
  })
  // 在保存条上方、不碰页头 / Above the save bar, clear of the header
  expect(box.toastBottom).toBeLessThanOrEqual(box.barTop)
  expect(box.toastTop).toBeGreaterThan(box.headerBottom)
  if (!mobile) expect(box.toastRight).toBeGreaterThanOrEqual(24)
  if (mobile) return
  // 桌面打开检查器：提示条让到它左边 / Desktop with the inspector open: the toast moves left of it
  await page.locator('.rrow__name').first().click()
  const inspector = page.locator('.rules-split > .editor--inspector')
  await expect(inspector).toBeVisible()
  const side = await page.evaluate(() => {
    const t = document.querySelector('.toast-stack')!.getBoundingClientRect()
    const i = document.querySelector('.rules-split > .editor--inspector')!.getBoundingClientRect()
    return { toastRight: t.right, inspectorLeft: i.left }
  })
  expect(side.toastRight).toBeLessThanOrEqual(side.inspectorLeft)
})
