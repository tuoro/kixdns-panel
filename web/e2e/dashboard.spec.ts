import { expect, test, type Page } from '@playwright/test'

/**
 * 信号带上的大数字是「趋势覆盖的那段时间的请求数」，不是自启动以来的累计值——
 * 标题写的是「近 24 小时请求」，配累计总数就是文不对题。演示数据的 24 个整点桶
 * 合计 383.5 万，是按演示里的运行时长和累计请求折算出来的日均量。
 *
 * 窄屏缩写成万/亿：九位数在手机上即使不断行也会挤掉旁边的单位，所以断言跟着
 * 视口走而不是写死一个字符串。
 *
 * The figure on the signal band is the request count over the period the trend
 * covers, not the cumulative total since start: the label reads "last 24 hours",
 * and pairing that with a lifetime total would not be the same statement. The
 * demo's 24 hourly buckets sum to 3,835,000, derived from its own uptime and
 * cumulative request count.
 */
function expectedTotal(page: Page): string {
  const width = page.viewportSize()?.width ?? 0
  return width <= 700 ? '383.5 万' : '3,835,000'
}

async function openOverview(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '运行概览', exact: true })).toBeVisible()
  await expect(page.locator('.overview-total-value')).toBeVisible()
}

test('首页展示精确分布，页签可用键盘切换且完整保留三个视图 @responsive', async ({ page }) => {
  await openOverview(page)
  await expect(page.locator('.overview-total-value')).toHaveText(expectedTotal(page))
  // 堆叠条换成「主项做大、小项列表」：占比最高的那条独占一行，其余进列表。
  await expect(page.locator('.overview-distribution .overview-dist-share')).toHaveText('69.4%')
  await expect(page.locator('.overview-distribution .overview-dist-name')).toHaveText('default')
  await expect(page.locator('.overview-pipeline-list li')).toHaveCount(2)
  await expect(page.locator('.overview-pipeline-list li').first()).toContainText('domestic')
  // 趋势线画得出来，且不是一条 NaN 路径。
  const path = await page.locator('.overview-spark-line').getAttribute('d')
  expect(path).toMatch(/^M[\d.]+,[\d.]+( L[\d.]+,[\d.]+){23}$/)

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
  await expect(page.getByRole('heading', { name: '上游台账' })).toBeVisible()
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
  test(`${stopped ? '已停止' : '实时不可用'}快照保留数据并禁用运行时操作 @responsive`, async ({ page }) => {
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
    await expect(page.locator('.overview-total-value')).toHaveText(expectedTotal(page))
    await expect(page.locator('.overview-config-state')).toHaveText('运行快照')
    await expect(page.getByRole('heading', { name: '最后运行配置', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '清空内部缓存', exact: true })).toBeDisabled()
    await page.getByRole('tab', { name: '查询排行' }).click()
    await expect(page.getByRole('button', { name: '1 小时', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '清空查询排行', exact: true })).toBeDisabled()
  })
}

test('手机上游逐级展开，桌面保留完整台账且无页面溢出 @responsive', async ({ page }, testInfo) => {
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
    // 台账收成四列用于扫读，错误 / 拒绝 / TCP 兜底收进每行的展开里。
    // 「完整台账」仍然成立，只是次要的三列要点开——它们是排查时才看的数。
    await expect(page.locator('.overview-table')).not.toContainText('28,230')
    await page.locator('.overview-expand').first().click()
    await expect(page.locator('.overview-table-detail')).toHaveCount(1)
    await expect(page.locator('.overview-table-detail')).toContainText('28,230')
    await expect(page.locator('.overview-table-detail')).toContainText('2,114')
  }
  const sizes = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client)
})
