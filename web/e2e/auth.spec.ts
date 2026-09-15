import { expect, test } from '@playwright/test'

/**
 * 演示模式默认已登录，置上这个标记才停得住在认证页上。
 * The demo is signed in by default; this flag is what keeps us on the auth pages.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-signed-out', 'true'))
})

test('登录页在认证前不暴露任何机器状态 @responsive', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: '登录控制台', exact: true })).toBeVisible()
  const main = page.locator('.auth-page')
  await expect(main).toBeVisible()

  // 控制协议版本、会话保护方式、更新通道都不该给还没通过认证的人看。
  for (const leak of ['控制协议', '会话保护', '更新通道', 'Enhanced Control', 'Verified Action']) {
    await expect(main).not.toContainText(leak)
  }
  await expect(page.locator('.auth-status')).toHaveCount(0)

  // 省掉一次徒劳的点击：面板根本没有找回功能，说清楚比让人去找强。
  await expect(page.locator('.auth-security')).toContainText('面板不提供密码找回')

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})

test('初始化页说明接下来会发生什么并承诺不覆盖已有配置 @responsive', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-setup-required', 'true'))
  await page.goto('/setup')
  await expect(page.getByRole('heading', { name: '创建管理员', exact: true })).toBeVisible()
  const steps = page.locator('.auth-next')
  await expect(steps).toContainText('此时 KixDNS 还未被改动')
  await expect(steps).toContainText('不会覆盖你已有的 KixDNS 配置')
  // 规则前置：不必等提交后才知道密码要 12 位。
  await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('placeholder', '至少 12 位')
})
