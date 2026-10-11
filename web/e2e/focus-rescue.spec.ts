import { expect, test, type Page } from '@playwright/test'

// 拿着焦点的东西被删掉或停用时，焦点不掉回 <body>：键盘用户不用从页头重新 Tab
// When whatever holds focus is removed or disabled, focus does not fall back to <body>: a keyboard user need not Tab from the header again
const activeIsBody = (page: Page) => page.evaluate(() => document.activeElement === document.body || document.activeElement === null)

test('提示里的「撤销」、横幅的「重试」用掉以后，焦点不掉到页面最外层', async ({ page }) => {
  await page.goto('/config')
  await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('undo.example.org')
  await quick.press('Enter')
  const undo = page.locator('.toast').getByRole('button', { name: '撤销' })
  await undo.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.toast', { hasText: 'undo.example.org' })).toHaveCount(0)
  await expect.poll(() => activeIsBody(page)).toBe(false)

  await page.evaluate(() => localStorage.setItem('kixdns:demo-panel-down', 'true'))
  await page.evaluate(() => window.dispatchEvent(new Event('kixdns:panel-unreachable')))
  const retry = page.locator('.conn__inner').getByRole('button', { name: '重试' })
  await retry.focus()
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-panel-down'))
  await page.keyboard.press('Enter')
  await expect(page.locator('.conn__inner')).toHaveCount(0)
  await expect.poll(() => activeIsBody(page)).toBe(false)
})

test('保存完保存条收起，焦点不掉到页面最外层', async ({ page }) => {
  await page.goto('/config')
  await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('bar.example.org')
  await quick.press('Enter')
  const save = page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' })
  await save.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.cfg__savebar')).toHaveCount(0, { timeout: 10_000 })
  await expect.poll(() => activeIsBody(page)).toBe(false)
})
