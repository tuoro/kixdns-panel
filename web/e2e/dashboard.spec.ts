import { expect, test, type Page } from '@playwright/test'
import { acceptConfirm, cancelConfirm } from './confirm'

/**
 * 信号带上的大数字是自启动以来的累计请求数，名称写明「启动以来请求」——它和紧挨着的完成率
 * 算的是同一段账（运行时长挪进了页头）。耗时不在这里：它挪进了「响应速度」卡，那张卡看最近一小时，
 * 标题写明时段，不和信号带的累计数挤在一处。曲线另说：它自带「近 24 小时 X 次」的说明，只替自己
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
 * start — the same period as the completion rate and uptime beside it. Latency
 * is not here: it moved to the response-speed tile, which covers the last hour
 * and names that period in its title rather than sitting beside a lifetime
 * figure. The curve is separate: it carries its own "last 24 hours, N
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
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible()
  await expect(page.locator('.overview-total-value')).toBeVisible()
}

test('首页展示精确分布，页签可用键盘切换且完整保留三个视图 @responsive', async ({ page }) => {
  await openOverview(page)
  await expect(page.locator('.overview-total-value')).toHaveText(EXPECTED_TOTAL)
  await expect(page.locator('.overview-signal-label')).toHaveText('启动以来请求')
  await expect(page.locator('.overview-trend-label')).toHaveText(EXPECTED_TREND)
  await expect(page.locator('.overview-signal-sub')).not.toContainText('ms')
  // 三张体征卡，名称都写时段：速度看最近一小时，缓存命中是启动以来（审计：每个数字都写明时段）
  // Three vital tiles, each naming its period: speed covers the last hour, cache hits the whole run
  const vitals = page.locator('.overview-vital')
  await expect(vitals).toHaveCount(3)
  await expect(vitals.nth(0).locator('.overview-vital-label')).toHaveText('响应速度 · 最近一小时')
  await expect(vitals.nth(1).locator('.overview-vital-label')).toHaveText('缓存命中率 · 启动以来')
  await expect(vitals.nth(2).locator('.overview-vital-label')).toHaveText('上游健康 · 最近一小时')
  const speed = vitals.nth(0)
  // 平均 12.6 ms 按台账的写法取整；四段不重叠的区间写在细条的读屏名称里，触屏也读得到
  await expect(speed.locator('.overview-vital-figure strong')).toHaveText('13')
  const bands = await speed.locator('.overview-meter').getAttribute('aria-label')
  for (const band of ['10 ms 内 81.7%', '10–100 ms 15.2%', '100 ms–1 s 2.7%', '1 s 以上 0.4%']) expect(bands).toContain(band)
  await expect(speed.locator('.overview-vital-foot')).toContainText('10 ms 内 81.7%')
  await expect(speed.locator('.overview-vital-foot')).toContainText('100 ms 内 96.9%')
  // 主项做大、其余列表：占比最高的那条独占一行，其余进列表；三栏都写「启动以来」
  const distribution = page.locator('.overview-distribution').first()
  await expect(distribution.locator('.overview-lead-share')).toHaveText('69.4%')
  await expect(distribution.locator('.overview-lead-name')).toHaveText('default')
  await expect(distribution.locator('.overview-shares li')).toHaveCount(2)
  await expect(distribution.locator('.overview-shares li').first()).toContainText('domestic')
  await expect(page.locator('.overview-distribution .ui-section__aside')).toHaveCount(3)
  for (const aside of await page.locator('.overview-distribution .ui-section__aside').allTextContents()) expect(aside).toMatch(/^启动以来 · /)
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
  // 按执行次数降序 / Sorted by count, highest first
  const counts = (await page.locator('.overview-rule-count').allTextContents()).map((text) => Number(text.replace(/,/g, '')))
  expect(counts).toEqual([...counts].sort((left, right) => right - left))
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
  await expect(page.locator('.overview-config-lead')).toContainText('#18')
  await expect(page.locator('.overview-config-meta')).toContainText('#24')
  // 补丁集按 pN 写，和系统页一致 / The patchset reads pN, as on the system page
  await expect(page.locator('.overview-config-meta')).toContainText(/补丁集 p\d+/)
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
    // 已停止才叫「最后运行配置」；服务还在跑、只是读不到实时数据时仍是「当前运行配置」
    await expect(page.getByRole('heading', { name: stopped ? '最后运行配置' : '当前运行配置', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '清空内部缓存', exact: true })).toBeDisabled()
    await page.getByRole('tab', { name: '查询排行' }).click()
    await expect(page.getByRole('button', { name: '1 小时', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '清空查询排行', exact: true })).toBeDisabled()
  })
}

test('台账逐行展开，明细跟着这一行的时段，桌面和手机同一套行且无页面溢出 @responsive', async ({ page }, testInfo) => {
  await openOverview(page)
  const rows = page.locator('.overview-upstream')
  await expect(rows).toHaveCount(3)
  // 台账说明写时段，两种宽度都看得见 / The ledger's note names its period at both widths
  await expect(page.locator('.overview-ledger .ui-section__aside')).toContainText('最近一小时')
  await expect(page.locator('.overview-upstream-counts')).toHaveCount(0)
  // 错误、拒绝、TCP 兜底收进每行的展开里，平时不摆出来
  await expect(rows.first()).not.toContainText('52')
  await rows.first().locator('.overview-expand').click()
  // 明细跟随这一行的依据：1.1.1.1 最近一小时 52 次错误、28 次拒绝，不是启动以来的 28,230 / 2,114
  await expect(page.locator('.overview-upstream-counts')).toHaveCount(1)
  await expect(page.locator('.overview-upstream-counts')).toContainText('错误52')
  await expect(page.locator('.overview-upstream-counts')).toContainText('拒绝28')
  if (testInfo.project.name === 'mobile') {
    // 手机上每行两行：第二行写数字，最近一小时响应不够的上游标明退回了累计
    await expect(rows.first().locator('.overview-upstream-line')).toBeVisible()
    await expect(rows.first().locator('.overview-upstream-line')).not.toContainText('启动以来')
    await expect(rows.nth(2).locator('.overview-upstream-line')).toContainText('启动以来')
    await expect(page.locator('.ui-rec-head').first()).toBeHidden()
    // 展开按钮手机上 44 / The expand button is 44 on a phone
    const box = await rows.first().locator('.overview-expand').boundingBox()
    expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44)
    const typeScale = await page.locator('.overview-total-value').evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
    expect(typeScale).toBeGreaterThanOrEqual(28)
    expect(typeScale).toBeLessThanOrEqual(32)
  } else {
    await expect(rows.first().locator('.overview-upstream-line')).toBeHidden()
    // 退回累计的那一行，地址下面写明整行都是启动以来的累计（原来只挂在次数下面）
    await expect(rows.first().locator('.overview-basis')).toHaveCount(0)
    await expect(rows.nth(2).locator('.overview-basis')).toHaveText('启动以来的累计')
  }
  const sizes = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client)
})

// 概览的演示端点交回的是同一个对象：改完它，离开再回来让概览重新挂载、重新读一遍
// The overview's demo endpoint hands back one shared object: after changing it, leave and come back so the overview remounts and re-reads
async function remountOverview(page: Page): Promise<void> {
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect(page.getByRole('heading', { name: '运行日志', exact: true })).toBeVisible()
  await page.getByRole('link', { name: '概览', exact: true }).click()
  await expect(page.locator('.overview-total-value')).toBeVisible()
}

test('页头按服务状态写事实：运行中写运行时长和更新时刻，停止后只写快照时刻', async ({ page }) => {
  await openOverview(page)
  const meta = page.locator('.overview-heading .ui-ph__meta')
  await expect(meta).toContainText('运行中')
  await expect(meta).toContainText('已运行')
  await expect(meta).toContainText(/更新于 \d{2}:\d{2}:\d{2}/)
  await expect(meta).not.toContainText('running')
  await page.evaluate(async () => {
    const { mockRequest } = await import('/src/api/mock.ts')
    const snapshot = await mockRequest('/api/v1/overview')
    snapshot.live = false
    snapshot.service_active = false
    await mockRequest('/api/v1/service/stop', { method: 'POST' })
  })
  await remountOverview(page)
  await expect(meta).toContainText('已停止')
  await expect(meta).toContainText(/快照 \S+/)
  // 停了就没有「已运行」「更新于」可言 / Once stopped there is no uptime or refresh time to report
  await expect(meta).not.toContainText('已运行')
  await expect(meta).not.toContainText('更新于')
})

test('页级提示一次只出一条：刷新失败时读取错误写进同一条的原因里，旧数据留着', async ({ page }) => {
  // 只在测试里替换 API 模块边界：打开 __failOverview 之后，读运行数据会失败
  // Swap the API module boundary in the test only: once __failOverview is set, reading runtime data fails
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('notice-original')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?notice-original';
      import { apiRequest as original } from '/src/api/client.ts?notice-original';
      export async function apiRequest(path, init) {
        if (path === '/api/v1/overview' && globalThis.__failOverview) throw new Error('连接增强控制通道超时（5 秒）');
        return original(path, init);
      }
    ` })
  })
  await openOverview(page)
  await expect(page.locator('.ui-notice:visible')).toHaveCount(0)
  await page.evaluate(() => { (globalThis as { __failOverview?: boolean }).__failOverview = true })
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  const notice = page.locator('.ui-notice:visible')
  await expect(notice).toHaveCount(1)
  await expect(notice).toContainText('实时数据暂不可用')
  await expect(notice).toContainText('连接增强控制通道超时')
  await expect(notice.getByRole('button', { name: '重试', exact: true })).toBeVisible()
  // 旧数据还在 / The old data stays
  await expect(page.locator('.overview-total-value')).toHaveText(EXPECTED_TOTAL)
  await page.evaluate(() => { (globalThis as { __failOverview?: boolean }).__failOverview = false })
  await notice.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.locator('.ui-notice:visible')).toHaveCount(0)
})

test('上游健康的分母是全部上游：观察中的也算，注脚先说有问题的再说观察中的', async ({ page }) => {
  await openOverview(page)
  await page.evaluate(async () => {
    const { mockRequest } = await import('/src/api/mock.ts')
    const snapshot = await mockRequest('/api/v1/overview')
    // 第三个上游：最近一小时和启动以来都不到 50 次可判断的响应 / Third upstream: under 50 judged responses in both periods
    const third = snapshot.metrics.upstreams[2]
    Object.assign(third, { attempts: 20, success: 19, errors: 1, rejected: 0, aborted: 0 })
    third.recent = { ...third.recent, attempts: 12, success: 12, errors: 0, rejected: 0, aborted: 0 }
    // 第二个上游耗时 2.48 秒：2 秒以上判为异常，耗时按秒写 / Second upstream at 2.48 s: 2 s or more is unhealthy, latency written in seconds
    snapshot.metrics.upstreams[1].recent.avg_latency_ms = 2480
  })
  await remountOverview(page)
  const health = page.locator('.overview-vital').nth(2)
  await expect(health.locator('.overview-vital-figure')).toContainText('/ 3 健康')
  await expect(health.locator('.overview-vital-foot')).toContainText('1 个异常')
  await expect(health.locator('.overview-vital-foot')).toContainText('1 个观察中')
  const foot = await health.locator('.overview-vital-foot').textContent()
  expect(foot!.indexOf('异常')).toBeLessThan(foot!.indexOf('观察中'))
  await expect(page.locator('.overview-upstream').filter({ hasText: '2.5 s' })).toHaveCount(1)
  await expect(page.getByText('2480 ms')).toHaveCount(0)
})

test('查询排行的时段跟着手上的数据走：定时刷新还在路上时切窗口，旧结果回来也不会盖掉新窗口', async ({ page }) => {
  // 按窗口给出不同的数据；打开 __slowStats 之后，24 小时那档的请求要 1.5 秒才回来（页面时钟）
  // Different data per window; once __slowStats is set, the 24-hour request takes 1.5 s of page time to return
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('window-original')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?window-original';
      import { apiRequest as original } from '/src/api/client.ts?window-original';
      export async function apiRequest(path, init) {
        if (!path.startsWith('/api/v1/stats/top')) return original(path, init);
        const seconds = Number(new URL(path, location.origin).searchParams.get('window'));
        const result = await original(path, init);
        if (seconds === 86400 && globalThis.__slowStats) await new Promise((resolve) => setTimeout(resolve, 1500));
        return { ...result, window_seconds: seconds, requests_observed: seconds / 36 };
      }
    ` })
  })
  await page.clock.install()
  await openOverview(page)
  await page.getByRole('tab', { name: '查询排行', exact: true }).click()
  const line = page.locator('.overview-toolbar p').first()
  await expect(line).toContainText('近 24 小时')
  await expect(line).toContainText('已观察 2,400 次请求')
  // 60 秒一次的定时刷新发出一个慢的 24 小时请求；它还在路上，就切到 1 小时
  await page.evaluate(() => { (globalThis as { __slowStats?: boolean }).__slowStats = true })
  await page.clock.runFor(60_000)
  await page.getByRole('button', { name: '1 小时', exact: true }).click()
  await expect(line).toContainText('近 1 小时')
  await expect(line).toContainText('已观察 100 次请求')
  // 旧的 24 小时结果回来了，也不能盖掉 / The old 24-hour result arrives and must not overwrite anything
  await page.clock.runFor(2_000)
  await expect(line).toContainText('近 1 小时')
  await expect(line).toContainText('已观察 100 次请求')
  await expect(page.getByRole('button', { name: '1 小时', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('耗时慢了：注脚换成 100 ms 内和 1 s 以上，染色的是数值；台账里 999.6 ms 写成 1.0 s', async ({ page }) => {
  await openOverview(page)
  await page.evaluate(async () => {
    const { mockRequest } = await import('/src/api/mock.ts')
    const snapshot = await mockRequest('/api/v1/overview')
    snapshot.metrics.request_latency_recent = { samples: 1000, avg_ms: 212.4, within_10ms: 250, within_100ms: 700, within_1s: 900 }
    snapshot.metrics.upstreams[0].recent.avg_latency_ms = 999.6
  })
  await remountOverview(page)
  const foot = page.locator('.overview-vital').first().locator('.overview-vital-foot')
  await expect(foot).toContainText('100 ms 内 70.0%')
  await expect(foot).toContainText('1 s 以上 10.0%')
  // 70% 在 100 ms 内是异常，数值本身染红 / 70% within 100 ms is unhealthy, and the value itself turns red
  const colour = await foot.locator('b').first().evaluate((element) => getComputedStyle(element).color)
  const red = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--err-l').trim())
  expect(colour).toBe(await page.evaluate((hex) => { const probe = document.createElement('i'); probe.style.color = hex; document.body.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value }, red))
  await expect(page.locator('.overview-upstream').first()).toContainText('1.0 s')
  await expect(page.getByText('1000 ms')).toHaveCount(0)
})

test('配置重载失败提到页顶：旧配置照常服务，是降级，给出去配置页的动作', async ({ page }) => {
  await openOverview(page)
  await page.evaluate(async () => {
    const { mockRequest } = await import('/src/api/mock.ts')
    const snapshot = await mockRequest('/api/v1/overview')
    snapshot.active_config.last_reload = { success: false, error: 'pipeline "cdn" references unknown upstream group "fast"' }
  })
  await remountOverview(page)
  const notice = page.locator('.ui-notice:visible')
  await expect(notice).toHaveCount(1)
  await expect(notice).toContainText('配置重载失败')
  await expect(notice).toContainText('仍按配置代次 #18 运行')
  await expect(notice.getByRole('link', { name: '管理配置', exact: true })).toBeVisible()
  await expect(page.locator('.overview-config-state')).toHaveText('重载失败')
  await expect(page.locator('.overview-reload-error')).toContainText('unknown upstream group')
})

test('服务启动失败时，页级提示和页头说同一件事，不说「已停止」', async ({ page }) => {
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('failed-original')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?failed-original';
      import { apiRequest as original } from '/src/api/client.ts?failed-original';
      export async function apiRequest(path, init) {
        const result = await original(path, init);
        if (path === '/api/v1/service') return { ...result, active_state: 'failed', sub_state: 'failed', main_pid: 0 };
        if (path === '/api/v1/overview') return { ...result, live: false, service_active: false };
        return result;
      }
    ` })
  })
  await page.goto('/')
  await expect(page.locator('.overview-total-value')).toBeVisible()
  await expect(page.locator('.overview-heading .ui-ph__meta')).toContainText('启动失败')
  const notice = page.locator('.ui-notice:visible')
  await expect(notice).toHaveCount(1)
  await expect(notice).toContainText('KixDNS 启动失败')
  await expect(notice).not.toContainText('已停止')
  await expect(notice).toHaveClass(/ui-notice--err/)
})

test('旧增强版不提供精确数据：两张卡写「—」，状态点读作「不支持判定」，没有耗时这一列', async ({ page }) => {
  await openOverview(page)
  await page.evaluate(async () => {
    const { mockRequest } = await import('/src/api/mock.ts')
    const snapshot = await mockRequest('/api/v1/overview')
    snapshot.health.capabilities = snapshot.health.capabilities.filter((item: string) => item !== 'metrics_upstream_precision_v1')
    snapshot.metrics.request_latency_recent = null
    snapshot.metrics.request_latency = { samples: 0, avg_ms: 0, within_10ms: 0, within_100ms: 0, within_1s: 0 }
    for (const upstream of snapshot.metrics.upstreams) { upstream.recent = null; upstream.avg_latency_ms = null }
  })
  await remountOverview(page)
  const vitals = page.locator('.overview-vital')
  await expect(vitals.nth(0).locator('.overview-vital-figure')).toHaveText('—')
  await expect(vitals.nth(2).locator('.overview-vital-figure')).toHaveText('—')
  await expect(vitals.nth(0).locator('.overview-vital-foot')).toContainText('当前增强版不提供耗时数据')
  await expect(page.locator('.overview-upstream .overview-dot').first()).toHaveAttribute('aria-label', '不支持判定')
  await expect(page.locator('.overview-ledger .ui-rec-head')).not.toContainText('平均耗时')
})
