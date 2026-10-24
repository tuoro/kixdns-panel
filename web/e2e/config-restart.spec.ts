import { expect, test, type Page } from '@playwright/test'

// 只在 KixDNS 启动时读取的设置：改了照常保存、重载，但要重启才生效。保存后配置页的提示条说清是哪些，就地重启；表单里不提重启
// （改过的每一项、整组的标题下都挂一句太吵）
// Settings KixDNS reads only at startup: a change saves and reloads as usual but takes a restart. After the save the config page's
// notice says which and restarts in place; the form itself says nothing about restarts (a line under every edit or group title was noise)

async function openGroup(page: Page, group: string): Promise<void> {
  await page.goto('/config?section=settings')
  await page.getByRole('button', { name: new RegExp(group) }).locator('visible=true').first().click()
  await expect(page.getByRole('heading', { name: group, exact: true })).toBeVisible()
}

test('改了监听地址：保存后提示要重启，就地重启以后提示消失 @responsive', async ({ page }) => {
  await openGroup(page, '基础与监听')
  await page.getByLabel('UDP 监听地址', { exact: true }).fill('0.0.0.0:5300')
  // 改过的单项下面不挂「重启后生效」：每一项都挂一句太吵，保存后提示条会说 / No restart note under the edited setting: one under
  // every edit was noise, and the notice says it after the save
  await expect(page.getByText('重启 KixDNS 后生效', { exact: true })).toHaveCount(0)

  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  const notice = page.locator('.cfg__notice')
  await expect(notice).toContainText(/改过的设置要重启 KixDNS 才生效：UDP\s监听地址。/)
  // 保存条不说「已生效」：上面刚说了要重启 / The save bar does not say 已生效 right under a notice saying a restart is due
  await expect(page.locator('.cfg__savebar')).toContainText(/已应用\s·\s版本 #\d+/)
  await expect(page.locator('.cfg__savebar')).not.toContainText('已生效')
  await expect(page.getByText('重启 KixDNS 后生效', { exact: true })).toHaveCount(0)

  await notice.getByRole('button', { name: '重启 KixDNS', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText(/重启后生效的设置：UDP\s监听地址。/)
  await confirm.getByRole('button', { name: '重启服务', exact: true }).click()
  await expect(page.getByText('KixDNS 服务已重启')).toBeVisible()
  await expect(notice).toHaveCount(0)
})

test('表单里不提重启：整组都要重启才生效的，组标题下也不说 @responsive', async ({ page }) => {
  await openGroup(page, '连接与传输')
  await page.getByLabel('TCP 连接池', { exact: true }).fill('32')
  await expect(page.locator('.settings-group').getByText(/重启/)).toHaveCount(0)
})

test('改重载即生效的设置：不提示重启，保存条照常说已生效 @responsive', async ({ page }) => {
  await openGroup(page, '基础与监听')
  await page.getByLabel('上游超时 (ms)', { exact: true }).fill('2500')
  await expect(page.getByText('重启 KixDNS 后生效', { exact: true })).toHaveCount(0)
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__savebar')).toContainText(/已生效\s·\s版本 #\d+/)
  await expect(page.locator('.cfg__notice')).toHaveCount(0)
})

async function saveListenerChange(page: Page): Promise<void> {
  await openGroup(page, '基础与监听')
  await page.getByLabel('UDP 监听地址', { exact: true }).fill('0.0.0.0:5300')
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__notice')).toContainText('改过的设置要重启 KixDNS 才生效')
}

test('概览的运行配置：有设置等着重启时说「待重启」，重启以后回到「已生效」 @responsive', async ({ page }) => {
  await saveListenerChange(page)
  // 演示数据只在这一页的内存里：用页内导航去概览，不重新加载 / Demo data lives in this page's memory: navigate in-app, no reload
  await page.getByRole('link', { name: '概览', exact: true }).locator('visible=true').first().click()
  const tag = page.locator('.overview-config-state')
  await expect(tag).toHaveText('待重启')
  await page.getByRole('link', { name: '管理配置' }).click()
  await page.locator('.cfg__notice').getByRole('button', { name: '重启 KixDNS', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '重启服务', exact: true }).click()
  await expect(page.locator('.cfg__notice')).toHaveCount(0)
  await page.getByRole('link', { name: '概览', exact: true }).locator('visible=true').first().click()
  await expect(tag).toHaveText('已生效')
})

test('重启以后 KixDNS 没起来：不说「已重启」，等一阵以后说没有回应 @responsive', async ({ page }) => {
  await page.clock.install()
  await saveListenerChange(page)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-restart-no-answer', 'true'))
  const notice = page.locator('.cfg__notice')
  await notice.getByRole('button', { name: '重启 KixDNS', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '重启服务', exact: true }).click()
  // 等它回来的时候按钮一直按不下 / While waiting for it to come back the button stays held
  await expect(notice.getByRole('button', { name: '重启 KixDNS', exact: true })).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByText('KixDNS 服务已重启')).toHaveCount(0)
  // 一直往前拨钟，直到等满十五秒说出结果 / Keep moving the clock on until the fifteen-second wait ends and the outcome is said
  const silent = page.locator('.toast', { hasText: 'KixDNS 重启后没有回应，查看日志了解原因' })
  await expect(async () => {
    await page.clock.fastForward(2_000)
    await expect(silent).toBeVisible({ timeout: 300 })
  }).toPass()
  await expect(page.getByText('KixDNS 服务已重启')).toHaveCount(0)
  await expect(notice).toHaveCount(0)
})
