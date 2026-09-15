import { expect, test, type Page } from '@playwright/test'
import { acceptConfirm, cancelConfirm } from './confirm'

/**
 * 信号带上的大数字是自启动以来的累计请求数——它和紧挨着的完成率、平均耗时、
 * 运行时长算的是同一段账。曲线另说：它自带「近 24 小时 X 次」的说明，只替自己
 * 说话。两个数字都断言，因为让大数字跟着曲线走过一次，结果「近 1 小时请求」
 * 底下紧跟着一行按累计算出来的完成率，两个口径挤在同一处，读者看不出来。
 *
 * 演示数据的 24 个整点桶合计 383.5 万，是按演示里的运行时长和累计请求折算出来的
 * 日均量，所以两个数放在一起怎么除都对得上。
 *
 * 两个视口显示同一个字符串：信号带让累计值独占一行，375 宽下放得下完整数字，
 * 不再缩写成万/亿。
 *
 * The headline figure on the signal band is the cumulative request count since
 * start — the same period as the completion rate, average latency and uptime
 * beside it. The curve is separate: it carries its own "last 24 hours, N
 * requests" caption and speaks only for itself. Both are asserted because the
 * headline followed the curve once, which put "requests in the last hour"
 * directly above a completion rate computed over the whole run — two periods in
 * one place, with nothing to tell the reader they differ.
 *
 * The demo's 24 hourly buckets sum to 3,835,000, derived from its own uptime and
 * cumulative request count, so the two figures survive any division a reader
 * tries. Both viewports show the same string: the band gives the lifetime figure
 * a line of its own, which fits in full at 375.
 */
const EXPECTED_TOTAL = '12,847,392'
const EXPECTED_TREND = '近 24 小时 3,835,000 次'

async function openOverview(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '运行概览', exact: true })).toBeVisible()
  await expect(page.locator('.overview-total-value')).toBeVisible()
}

test('首页展示精确分布，页签可用键盘切换且完整保留三个视图 @responsive', async ({ page }) => {
  await openOverview(page)
  await expect(page.locator('.overview-total-value')).toHaveText(EXPECTED_TOTAL)
  await expect(page.locator('.overview-trend-label')).toHaveText(EXPECTED_TREND)
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

  await page.getByRole('button', { name: '清空查询排行', exact: true }).click()
  await cancelConfirm(page)
  await expect(page.locator('.overview-ranking-list li')).toHaveCount(10)
  await page.getByRole('button', { name: '清空查询排行', exact: true }).click()
  await acceptConfirm(page)
  await expect(page.getByText('查询排行已清空', { exact: true })).toBeVisible()
  await expect(page.getByText('当前窗口暂无客户端数据', { exact: true })).toBeVisible()
  await expect(page.getByText('当前窗口暂无域名数据', { exact: true })).toBeVisible()
})

test('运行配置与缓存清理保持可用', async ({ page }) => {
  await openOverview(page)
  await expect(page.locator('.overview-runtime-ledger')).toContainText('#18')
  await expect(page.locator('.overview-runtime-ledger')).toContainText('#24')
  await expect(page.locator('.overview-config-state')).toHaveText('已生效')
  await page.getByRole('button', { name: '清空内部缓存', exact: true }).click()
  await acceptConfirm(page)
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
    // 这一趟离开再回来是为了让概览重新挂载——演示端点交回的是同一个对象，
    // 上面那次改写不会触发响应式更新，只有重新挂载才会重新读一遍。
    // 必须等日志页真的渲染出来再点回去：两次点击连着发，路由可能还没换，
    // 概览就根本没卸载过，断言等的是一个永远不会出现的横幅。
    //
    // The round trip exists to remount the overview: the demo endpoint hands
    // back the same object, so the mutation above triggers no reactive update
    // and only a remount re-reads it. Waiting for the logs page to actually
    // render is what makes that happen — two clicks back to back can land
    // before the route changes, leaving the overview never unmounted and the
    // assertion waiting on a banner that will never appear.
    await page.getByRole('link', { name: '日志', exact: true }).click()
    await expect(page.getByRole('heading', { name: '运行日志', exact: true })).toBeVisible()
    await page.getByRole('link', { name: '概览', exact: true }).click()

    await expect(page.getByText(stopped ? 'KixDNS 已停止' : '实时数据暂不可用', { exact: true })).toBeVisible()
    await expect(page.locator('.overview-total-value')).toHaveText(EXPECTED_TOTAL)
    await expect(page.locator('.overview-trend-label')).toHaveText(EXPECTED_TREND)
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
