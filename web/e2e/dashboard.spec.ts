import { expect, test, type Page } from '@playwright/test'

async function openOverview(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '运行概览', exact: true })).toBeVisible()
  await expect(page.locator('.overview-total-value')).toBeVisible()
}

test('首页展示精确分布，页签可用键盘切换且完整保留三个视图', async ({ page }) => {
  await openOverview(page)
  await expect(page.locator('.overview-total-value')).toHaveText('12,847,392')
  await expect(page.locator('.overview-pipeline-list li')).toHaveCount(3)
  const shares = await page.locator('.overview-distribution-segment').evaluateAll((segments) =>
    segments.map((segment) => Number.parseFloat((segment as HTMLElement).style.width)),
  )
  expect(shares[0]).toBeCloseTo(8_914_380 / 12_847_392 * 100, 4)
  expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(100, 3)

  const runtimeTab = page.getByRole('tab', { name: '运行情况' })
  await runtimeTab.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: '查询排行' })).toBeFocused()
  await expect(page.getByRole('heading', { name: '客户端排行' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '请求域名排行' })).toBeVisible()
  await page.keyboard.press('End')
  await expect(page.getByRole('tab', { name: '规则命中' })).toBeFocused()
  await expect(page.locator('.overview-rule')).toHaveCount(4)
  await expect(page.locator('.overview-rule').filter({ hasText: 'accept-noerror' })).toContainText('响应')
  await page.keyboard.press('Home')
  await expect(runtimeTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('heading', { name: '上游请求' })).toBeVisible()
})

test('查询排行保留时间窗口与带确认的清理操作', async ({ page }) => {
  await openOverview(page)
  await page.getByRole('tab', { name: '查询排行' }).click()
  await expect(page.locator('.overview-ranking-list li')).toHaveCount(10)
  await page.getByRole('button', { name: '1 小时', exact: true }).click()
  await expect(page.getByRole('button', { name: '1 小时', exact: true })).toHaveAttribute('aria-pressed', 'true')

  page.once('dialog', (dialog) => dialog.dismiss())
  await page.getByRole('button', { name: '清空查询排行', exact: true }).click()
  await expect(page.locator('.overview-ranking-list li')).toHaveCount(10)
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '清空查询排行', exact: true }).click()
  await expect(page.getByText('查询排行已清空', { exact: true })).toBeVisible()
  await expect(page.getByText('当前窗口暂无客户端数据', { exact: true })).toBeVisible()
  await expect(page.getByText('当前窗口暂无域名数据', { exact: true })).toBeVisible()
})

test('运行配置与缓存清理保持可用', async ({ page }) => {
  await openOverview(page)
  await expect(page.locator('.overview-runtime-ledger')).toContainText('#18')
  await expect(page.locator('.overview-runtime-ledger')).toContainText('#24')
  await expect(page.locator('.overview-config-state')).toHaveText('已生效')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '清空内部缓存', exact: true }).click()
  await expect(page.getByText('已清理 19,354 个缓存条目', { exact: true })).toBeVisible()
})

test('首次未启动保留空态视图但禁止运行时操作', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-empty-first-install', 'true'))
  await openOverview(page)
  await expect(page.getByText('KixDNS 未启动', { exact: true })).toBeVisible()
  await expect(page.getByText('数据可能已过期')).toHaveCount(0)
  await expect(page.locator('.overview-total-value')).toHaveText('0')
  await expect(page.getByText('尚无 Pipeline 命中数据', { exact: true })).toBeVisible()
  await expect(page.getByText('尚无上游请求数据', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '清空内部缓存', exact: true })).toBeDisabled()
  await expect(page.locator('.overview-config-state')).toHaveText('未运行')
  await page.getByRole('tab', { name: '查询排行' }).click()
  await expect(page.getByText('当前窗口暂无客户端数据', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '1 小时', exact: true })).toBeDisabled()
  await page.getByRole('tab', { name: '规则命中' }).click()
  await expect(page.getByText('尚无规则命中数据', { exact: true })).toBeVisible()
})

for (const stopped of [true, false]) {
  test(`${stopped ? '已停止' : '实时不可用'}快照保留数据并禁用运行时操作`, async ({ page }) => {
    await openOverview(page)
    // 仅调整演示端点的内存快照，再重新挂载概览模拟服务返回的状态。
    await page.evaluate(async (isStopped) => {
      const moduleUrl = '/src/api/mock.ts'
      const { mockRequest } = await import(moduleUrl)
      const snapshot = await mockRequest('/api/v1/overview')
      snapshot.live = false
      snapshot.service_active = isStopped ? false : null
      if (isStopped) await mockRequest('/api/v1/service/stop', { method: 'POST' })
    }, stopped)
    await page.getByRole('link', { name: '日志', exact: true }).click()
    await page.getByRole('link', { name: '概览', exact: true }).click()

    await expect(page.getByText(stopped ? 'KixDNS 已停止' : '实时数据暂不可用', { exact: true })).toBeVisible()
    await expect(page.locator('.overview-total-value')).toHaveText('12,847,392')
    await expect(page.locator('.overview-config-state')).toHaveText('运行快照')
    await expect(page.getByRole('heading', { name: '最后运行配置', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '清空内部缓存', exact: true })).toBeDisabled()
    await page.getByRole('tab', { name: '查询排行' }).click()
    await expect(page.getByRole('button', { name: '1 小时', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '清空查询排行', exact: true })).toBeDisabled()
  })
}

test('手机上游逐级展开，桌面保留完整台账且无页面溢出', async ({ page }, testInfo) => {
  await openOverview(page)
  if (testInfo.project.name === 'mobile') {
    await expect(page.locator('.overview-upstream-desktop')).toBeHidden()
    const details = page.locator('.overview-upstream-detail')
    await expect(details).toHaveCount(3)
    await expect(details.first().locator('.overview-upstream-counts')).toBeHidden()
    await details.first().locator('summary').click()
    await expect(details.first().locator('.overview-upstream-counts')).toContainText('28,230')
    await expect(details.first().locator('.overview-upstream-counts')).toContainText('2,114')
    const typeScale = await page.locator('.overview-total-value').evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
    expect(typeScale).toBeGreaterThanOrEqual(28)
    expect(typeScale).toBeLessThanOrEqual(32)
  } else {
    await expect(page.locator('.overview-upstream-mobile')).toBeHidden()
    await expect(page.locator('.overview-table tbody tr')).toHaveCount(3)
    await expect(page.locator('.overview-table')).toContainText('28,230')
  }
  const sizes = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client)
})
