import { expect, test, type Page } from '@playwright/test'

// kixdns:demo-panel-down 让演示面板不答话，和真的 fetch 失败走同一条路：横幅挂出，每 5 秒问一次，去掉开关后下一次就连上
// kixdns:demo-panel-down makes the demo panel stop answering, the same path as a real fetch failure: the banner goes up, asks every 5 seconds, and reconnects on the next ask once the flag is gone
const panelDown = (page: Page, down: boolean) => page.evaluate((on) => {
  if (on) localStorage.setItem('kixdns:demo-panel-down', 'true')
  else localStorage.removeItem('kixdns:demo-panel-down')
}, down)
const banner = (page: Page) => page.locator('.conn__inner')

test('连不上面板时按了保存：连上以后保存条回到原样，不变成「保存为待应用」，也不怪 KixDNS @responsive', async ({ page }, testInfo) => {
  await page.goto('/config')
  if (testInfo.project.name !== 'mobile') await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('down.example.org')
  await quick.press('Enter')
  const bar = page.locator('.cfg__savebar')
  await panelDown(page, true)
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('连不上面板')
  await expect(banner(page)).toBeVisible()
  await panelDown(page, false)
  await expect(banner(page)).toHaveCount(0, { timeout: 10_000 })
  // 连上以后：「连不上面板」收起，按钮还是「保存并应用」，没有「KixDNS 没有报告它支持哪些功能」 / Reconnected: the verdict goes, the button is still 保存并应用, and no 没有报告能力 notice
  await expect(bar).not.toContainText('连不上面板')
  await expect(bar.getByRole('button', { name: '保存并应用' })).toBeVisible()
  await expect(page.getByText('KixDNS 没有报告它支持哪些功能', { exact: false })).toHaveCount(0)
  await expect(page.locator('[data-rule]', { hasText: 'down.example.org' })).toBeVisible()
  // 再按一次照常先校验再写入 / Pressed again it validates before writing as usual
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('已生效')
})

test('连不上面板时打开的配置页和系统页，连上以后自己读出来 @responsive', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await page.goto('/logs')
  await expect(page.locator('main h1')).toHaveText('日志')
  await panelDown(page, true)
  await page.getByRole('link', { name: mobile ? '配置' : '规则', exact: true }).first().click()
  await expect(page.locator('.cfg__failed')).toBeVisible()
  // 没读到配置时页头不写规则数、上游组数 / Without a config read the header shows no rule or group counts
  await expect(page.locator('.cfg__facts')).toHaveCount(0)
  await panelDown(page, false)
  await expect(page.locator('.cfg__panel')).toBeVisible({ timeout: 10_000 })

  await panelDown(page, true)
  await page.getByRole('link', { name: '系统', exact: true }).first().click()
  await expect(banner(page)).toBeVisible()
  await panelDown(page, false)
  await expect(banner(page)).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('.system-heading')).toContainText(mobile ? '运行中' : 'kixdns.service')
})
