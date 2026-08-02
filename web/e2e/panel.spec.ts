import { expect, test, type Page } from '@playwright/test'

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await expect(page.locator('.app-shell')).toBeVisible()
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const sizes = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.clientWidth)
}

test('首次未启动时保留完整概览布局', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-empty-first-install', 'true'))
  await open(page, '/')

  await expect(page.getByText('KixDNS 未启动', { exact: true })).toBeVisible()
  await expect(page.getByText('数据可能已过期')).toHaveCount(0)
  await expect(page.locator('.metric')).toHaveCount(4)
  await expect(page.locator('.metric').first().getByText('0', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Pipeline 命中' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '运行时配置' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '客户端排行' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '请求域名排行' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '上游请求' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '规则命中' })).toBeVisible()
  await expect(page.getByRole('button', { name: '清空内部缓存' })).toBeDisabled()
})

test('配置历史支持差异、恢复和受保护删除', async ({ page }) => {
  await open(page, '/config')
  const history = page.locator('.history-list')
  await expect(history.locator('article')).toHaveCount(4)

  await history.getByTitle('比较此版本').first().click()
  const diff = page.locator('.config-diff-dialog')
  await expect(diff).toBeVisible()
  await expect(diff.getByText(/处差异/)).toBeVisible()
  await diff.getByRole('button', { name: '关闭', exact: true }).click()

  page.once('dialog', (dialog) => dialog.accept())
  await history.getByTitle('恢复此版本').first().click()
  await expect(page.locator('.toast--success')).toContainText('已恢复')
  await expect(history.locator('article')).toHaveCount(5)
  await expect(history.locator('.history-item--current').getByTitle('删除此版本')).toHaveCount(0)

  page.once('dialog', (dialog) => dialog.accept())
  await history.getByTitle('删除此版本').first().click()
  await expect(page.locator('.toast--success').filter({ hasText: '已删除' })).toBeVisible()
  await expect(history.locator('article')).toHaveCount(4)
})

test('Geo 维护结果离开页面后销毁', async ({ page }) => {
  await open(page, '/config')
  const geo = page.locator('.geo-data-section')
  await geo.scrollIntoViewIfNeeded()
  await geo.locator('.geo-schedule-control select').selectOption('24')
  await expect(geo.locator('.geo-schedule-control select')).toHaveValue('24')
  await geo.getByRole('button', { name: '清理未引用的 Geo 文件' }).click()
  await expect(geo.locator('.geo-data-success')).toContainText('已清理')

  await page.goto('/logs')
  await page.goto('/config')
  await expect(page.locator('.geo-data-success')).toHaveCount(0)
})

test('增强版本可安装、切换并删除非活动库存', async ({ page }) => {
  await open(page, '/system')
  const panel = page.locator('.version-panel')
  await expect(panel.locator('.remote-versions .version-row')).not.toHaveCount(0)
  await panel.locator('.remote-versions .version-row').first().getByRole('button', { name: '安装并启用' }).click()
  await expect(page.locator('.toast--success').filter({ hasText: '已安装' })).toBeVisible()

  await panel.getByTitle('切换到此版本').first().click()
  await expect(page.locator('.toast--success').filter({ hasText: '已切换' })).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept())
  await panel.getByRole('button', { name: '删除本地版本' }).first().click()
  await expect(page.locator('.toast--success').filter({ hasText: '已删除' })).toBeVisible()
})

test('更新通知可标记已读并在刷新后保持', async ({ page }) => {
  await open(page, '/')
  const bell = page.locator('.topbar-update')
  await expect(bell.locator('.notification-badge')).toHaveText('2')
  await bell.dispatchEvent('click')
  const popover = page.locator('.notification-popover')
  await expect(popover).toBeVisible()
  await popover.getByRole('button', { name: '全部已读' }).click()
  await expect(bell.locator('.notification-badge')).toHaveCount(0)
  await expect(popover).toContainText('已全部阅读')

  await page.reload()
  await expect(bell.locator('.notification-badge')).toHaveCount(0)
})

test('操作审计可按动作筛选', async ({ page }) => {
  await open(page, '/logs')
  await page.locator('.log-view-tabs button').nth(1).click()
  await expect(page.locator('.audit-line')).toHaveCount(7)
  await page.locator('.log-toolbar select').selectOption('config.')
  await expect(page.locator('.audit-line')).toHaveCount(3)
  await page.getByLabel('筛选操作审计').fill('schedule')
  await expect(page.locator('.audit-line')).toHaveCount(1)
  await expect(page.locator('.audit-line')).toContainText('config.geo_data.schedule.apply')
})

test('主页面不会产生视口级横向溢出', async ({ page }) => {
  for (const path of ['/', '/config', '/logs', '/diagnostics', '/system']) {
    await open(page, path)
    await expectNoPageOverflow(page)
  }
})
