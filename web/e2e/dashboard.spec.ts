import { expect, test, type Page } from '@playwright/test'
import { acceptConfirm, cancelConfirm } from './confirm'

/**
 * 查询量卡上的大数字是自启动以来的累计请求数，卡名写明「启动以来」——它和卡里的成功率、缓存命中
 * 算的是同一段账（运行时长挪进了页头）。延迟是小计里唯一看最近一小时的，所以它自己写时段。
 * 曲线另说：它自带「近 24 小时 X 次」的说明，只替自己说话。两个数字都断言，因为让大数字跟着曲线走过一次，
 * 结果「近 1 小时请求」底下紧跟着一行按累计算出来的完成率，两个口径挤在同一处，读者看不出来。
 *
 * 演示数据的 24 个整点桶合计 383.5 万，是按演示里的运行时长和累计请求折算出来的
 * 日均量，所以两个数放在一起怎么除都对得上。
 *
 * 两个视口显示同一个字符串：查询量卡让累计值独占一行，375 宽下放得下完整数字，
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
  // 查询量卡写明时段；右上角那句只替曲线说话 / The volume card names its period; the note at its top right speaks for the curve only
  await expect(page.locator('.overview-card--volume .ui-card__label')).toContainText('启动以来')
  await expect(page.locator('.overview-trend-label')).toHaveText(EXPECTED_TREND)
  // 三项小计：成功率和缓存命中跟着卡的时段，只有延迟看最近一小时、自己写时段（审计：每个数字都写明时段）
  // Three sub-figures: success and cache hits follow the card's period; only latency covers the last hour and names it
  const subs = page.locator('.overview-subs dt')
  await expect(subs).toHaveCount(3)
  await expect(subs.nth(0)).toHaveText('成功率')
  await expect(subs.nth(1)).toHaveText('缓存命中')
  await expect(subs.nth(2)).toContainText('平均延迟')
  await expect(subs.nth(2)).toContainText('最近一小时')
  // 平均 12.6 ms 按上游状态的写法取整 / The 12.6 ms average rounds as upstream status does
  await expect(page.locator('.overview-subs dd')).toHaveText(['99.6%', '83.6%', '13 ms'])
  // 上游状态一行一个：地址、耗时、成功率和响应次数；有一个上游退回了累计，整卡仍按最近一小时写
  // Upstream status, one row each: address, latency, success rate and responses; one upstream fell back to its lifetime total, the card still names the last hour
  const upstreams = page.locator('.overview-card--upstreams .overview-row')
  await expect(upstreams).toHaveCount(3)
  await expect(upstreams.first()).toContainText('1.1.1.1:53')
  await expect(upstreams.first().locator('.overview-row-value')).toHaveText('12 ms')
  await expect(upstreams.first().locator('.overview-row-sub')).toContainText('99.7%')
  await expect(page.locator('.overview-card--upstreams .overview-card-note')).toHaveText('最近一小时')
  // 分布卡一行一个：名字、「次数 · 占比」、细条；三张都写「启动以来」 / Distribution cards, one row each: name, 「count · share」, bar; all three say 启动以来
  const distribution = page.locator('.overview-card--share').first()
  await expect(distribution.locator('.ui-card__label')).toHaveText('请求分布')
  await expect(distribution.locator('.overview-row')).toHaveCount(3)
  await expect(distribution.locator('.overview-row').first()).toContainText('default')
  await expect(distribution.locator('.overview-row').first().locator('.overview-row-value')).toHaveText('8,914,380 · 69.4%')
  await expect(page.locator('.overview-card--share .overview-card-note')).toHaveCount(3)
  for (const note of await page.locator('.overview-card--share .overview-card-note').allTextContents()) expect(note).toMatch(/^启动以来/)
  // 趋势线画得出来，且不是一条 NaN 路径；柱图 24 根，最后一根是正在进行的这一小时，横轴右端写「现在」
  // The curve draws and is no NaN path; 24 bars, the last being the hour in progress, and the axis ends with 现在
  const path = await page.locator('.overview-spark-line').first().getAttribute('d')
  expect(path).toMatch(/^M[\d.]+,[\d.]+( C[\d., -]+)+$/)
  await expect(page.locator('.overview-bars-cols > i')).toHaveCount(24)
  await expect(page.locator('.overview-bars-cols > i').last()).toHaveClass(/is-live/)
  await expect(page.locator('.overview-bars-axis .is-end')).toContainText('现在')

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
  await expect(page.getByRole('heading', { name: '上游状态' })).toBeVisible()
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
  await expect(page.locator('.overview-config-hashes')).toContainText('#24')
  // 补丁集按 pN 写，和系统页一致 / The patchset reads pN, as on the system page
  await expect(page.locator('.overview-config-hashes')).toContainText(/补丁集p\d+/)
  await expect(page.locator('.overview-config-state')).toHaveText('已生效')
  await page.getByRole('button', { name: '清空内部缓存', exact: true }).click()
  await acceptConfirm(page)
  await expect(page.getByText('已清理 19,354 个缓存条目', { exact: true })).toBeVisible()
})

test('首次未启动保留空态视图但禁止运行时操作', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-empty-first-install', 'true'))
  await openOverview(page)
  // 页头写「已停止」，提示也说「已停止」：面板确认不了「从没启动过」这段历史 / Header and notice both say 已停止: the panel cannot confirm a never-started history
  await expect(page.getByText('KixDNS 已停止', { exact: true })).toBeVisible()
  await expect(page.locator('.overview-notice small')).toHaveText('还没有运行数据；启动 KixDNS 后概览会自动更新。')
  await expect(page.getByText('数据可能已过期')).toHaveCount(0)
  // 没有数时名称不带时段；空卡也不写时段和口径；两张图卡都只写「尚无数据」 / With no figures the names carry no period; empty cards drop their period notes; both chart cards read 尚无数据
  await expect(page.locator('.overview-card--volume .ui-card__label')).toHaveText('查询量')
  await expect(page.locator('.overview-subs dt')).toHaveText(['成功率', '缓存命中', '平均延迟'])
  await expect(page.locator('.overview-card--upstreams .overview-card-note')).toHaveCount(0)
  await expect(page.locator('.overview-card--share .overview-card-note')).toHaveCount(0)
  await expect(page.locator('.overview-spark-pending')).toHaveText(['尚无数据', '尚无数据'])
  await expect(page.locator('.overview-runtime-note')).toHaveText('KixDNS 运行后才能清空缓存')
  // 从没启动过就没有「启动以来」可数，大数字和下面三张卡一样写「—」 / Never started: nothing counted since start, so the figure reads — like the tiles
  await expect(page.locator('.overview-total-value')).toHaveText('—')
  // 从没启动过，列表卡也只写「尚无数据」（「还没有请求…」那两句留给运行中但没流量的时候）
  // Never started, the list cards read 尚无数据 too (the 还没有请求… sentences are for a running kernel with no traffic)
  await expect(page.locator('.overview-card--share .overview-empty')).toHaveText('尚无数据')
  await expect(page.locator('.overview-card--upstreams .overview-empty')).toHaveText('尚无数据')
  await expect(page.getByRole('button', { name: '清空内部缓存', exact: true })).toBeDisabled()
  await expect(page.locator('.overview-config-state')).toHaveText('未运行')
  await page.getByRole('tab', { name: '查询排行' }).click()
  // 两张表留着，各写「尚无数据」；没有窗口和总量可说，工具行不出 / Both tables stay, each reading 尚无数据; no window or volume to state, so no toolbar
  await expect(page.locator('.overview-ranking .overview-empty')).toHaveText(['尚无数据', '尚无数据'])
  await expect(page.locator('#overview-panel-stats .overview-toolbar')).toHaveCount(0)
  await page.getByRole('tab', { name: '规则命中' }).click()
  await expect(page.getByText('还没有规则执行过', { exact: true })).toBeVisible()
  // 空表不带「累计执行次数」那行说明 / An empty table carries no caption about execution counts
  await expect(page.getByText('请求与响应阶段的累计执行次数')).toHaveCount(0)
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
    await expect(page.getByRole('heading', { name: '日志', exact: true })).toBeVisible()
    await page.getByRole('link', { name: '概览', exact: true }).click()

    await expect(page.getByText(stopped ? 'KixDNS 已停止' : '实时数据暂不可用', { exact: true })).toBeVisible()
    // 服务还在跑却没有错误文字时，原因照样说出发生了什么，不只剩「显示快照」
    // With the service up and no error text, the reason still says what happened, not only that a snapshot is shown
    // 已停止也说接下来会怎样，不说「不再更新」 / Stopped also says what comes next, never 不再更新
    await expect(page.locator('.overview-notice small')).toHaveText(stopped
      ? /^显示停止前 \d{2}:\d{2} 的快照；启动 KixDNS 后概览会自动更新。$/
      : /^KixDNS 暂时没有应答；显示 \d{2}:\d{2} 的快照，恢复后会自动更新。$/)
    // 底栏只说按钮什么时候能用，不再复述状态 / The foot says only when the button becomes usable, without restating the state
    await expect(page.locator('.overview-runtime-note')).toHaveText(stopped ? 'KixDNS 运行后才能清空缓存' : '实时数据恢复后才能清空缓存')
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

test('上游状态一行一个上游，错误和拒绝数收进这一行的提示里、跟着这一行的时段，桌面和手机同一套行且无页面溢出 @responsive', async ({ page }, testInfo) => {
  await openOverview(page)
  const card = page.locator('.overview-card--upstreams')
  const rows = card.locator('.overview-row')
  await expect(rows).toHaveCount(3)
  // 卡的右上角写时段，两种宽度都看得见 / The card's note names its period, visible at both widths
  await expect(card.locator('.overview-card-note')).toBeVisible()
  await expect(card.locator('.overview-card-note')).toHaveText('最近一小时')
  // 错误、拒绝、TCP 兜底是排查时才看的数：不摆在行里，收进这一行的悬停提示
  // Errors, refusals and TCP fallback are troubleshooting figures: not in the row, but in its hover title
  await expect(rows.first()).not.toContainText('52')
  // 提示跟随这一行的依据：1.1.1.1 最近一小时 52 次错误、28 次拒绝，不是启动以来的 28,230 / 2,114
  // The title follows the row's basis: 52 errors and 28 refusals in the last hour, not the lifetime 28,230 / 2,114
  const title = await rows.first().getAttribute('title')
  expect(title).toContain('错误 52')
  expect(title).toContain('拒绝 28')
  expect(title).not.toContain('28,230')
  // 每行同样四样东西：地址、耗时、「成功率 · 次响应」、细条；手机不换成另一套行
  // Every row shows the same four things: address, latency, 「success rate · responses」, a bar; a phone does not switch to another row design
  for (const row of [rows.nth(0), rows.nth(1), rows.nth(2)]) {
    await expect(row.locator('.overview-address')).toBeVisible()
    await expect(row.locator('.overview-row-value')).toBeVisible()
    await expect(row.locator('.overview-row-sub')).toBeVisible()
    await expect(row.locator('.overview-row-bar')).toBeVisible()
  }
  // 地址不挤耗时：名字那格的右边在耗时左边 / The address never runs into the latency: the name cell ends before the value begins
  const squeezed = await rows.evaluateAll((items) => items
    .filter((row) => row.querySelector('.overview-row-name')!.getBoundingClientRect().right > row.querySelector('.overview-row-value')!.getBoundingClientRect().left)
    .map((row) => row.textContent!.trim()))
  expect(squeezed).toEqual([])
  if (testInfo.project.name === 'mobile') {
    // 卡与卡之间、栏与栏之间都是整页那一个间距，不另起一套 / Cards and columns keep the page's one gap, not a second scale
    const gaps = await page.evaluate(() => ['.overview-view', '.overview-grid', '.overview-col', '.overview-trio']
      .map((selector) => getComputedStyle(document.querySelector(selector)!).rowGap))
    expect(new Set(gaps).size).toBe(1)
    // 大数字按 --t-7 那一档的字号写全，375 下放得下、不出卡 / The figure is set at the --t-7 step in full and fits inside the card at 375
    const figure = await page.locator('.overview-total-value').evaluate((element) => {
      const host = element.closest('.overview-card')!
      return {
        size: getComputedStyle(element).fontSize,
        token: getComputedStyle(document.documentElement).getPropertyValue('--t-7').trim(),
        right: element.getBoundingClientRect().right,
        edge: host.getBoundingClientRect().right - parseFloat(getComputedStyle(host).paddingRight),
      }
    })
    expect(figure.size).toBe(figure.token)
    expect(figure.right).toBeLessThanOrEqual(figure.edge)
  }
  // dns.google 退回了累计（最近一小时响应不足），两种宽度都不逐行加注
  // dns.google fell back to its lifetime total (too few responses in the last hour); neither width marks the row
  await expect(rows.nth(2)).not.toContainText('启动以来')
  const sizes = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client)
})

test('中等宽度：1160 时上游状态还在 360 宽的右栏、地址不挤耗时；1159 起一栏到底；规则表 899 起换成两行式且无页面溢出', async ({ page }) => {
  // 两栏的最窄处是 1160：侧栏 232 + 页边 64 + 右栏 380 之后左栏才够 480 放下三项小计 / The two-column layout's narrowest point is 1160: after the sidebar 232, gutters 64 and the right column 380, the left column keeps the 480 its three sub-figures need
  await page.setViewportSize({ width: 1160, height: 900 })
  await openOverview(page)
  const layout = () => page.evaluate(() => {
    const volume = document.querySelector('.overview-card--volume')!.getBoundingClientRect()
    const upstreams = document.querySelector('.overview-card--upstreams')!.getBoundingClientRect()
    return { volume: { left: volume.left, right: volume.right, top: volume.top, bottom: volume.bottom, width: volume.width }, upstreams: { left: upstreams.left, top: upstreams.top, width: upstreams.width } }
  })
  // 1160：两栏的最窄处，右栏收到 360，上游状态和查询量卡同一条顶边 / At 1160, the narrowest two-column layout: the right column is 360, upstreams level with the volume card
  const wide = await layout()
  expect(wide.upstreams.left).toBeGreaterThan(wide.volume.right)
  expect(Math.round(wide.upstreams.top)).toBe(Math.round(wide.volume.top))
  expect(Math.round(wide.upstreams.width)).toBe(360)
  // 360 里地址不挤耗时：每行名字那格的右边都在耗时左边 / Inside 360 no address runs into its latency: every name cell ends before its value begins
  const squeezed = await page.locator('.overview-card--upstreams .overview-row').evaluateAll((rows) => rows
    .filter((row) => row.querySelector('.overview-row-name')!.getBoundingClientRect().right > row.querySelector('.overview-row-value')!.getBoundingClientRect().left)
    .map((row) => row.textContent!.trim()))
  expect(squeezed).toEqual([])
  // 1159：一栏到底，上游状态落到查询量卡下面，同一条左边、同一个宽 / From 1159 one column: upstreams below the volume card, on the same left edge at the same width
  await page.setViewportSize({ width: 1159, height: 900 })
  const narrow = await layout()
  expect(narrow.upstreams.top).toBeGreaterThan(narrow.volume.bottom)
  expect(Math.round(narrow.upstreams.left)).toBe(Math.round(narrow.volume.left))
  expect(Math.round(narrow.upstreams.width)).toBe(Math.round(narrow.volume.width))
  // 规则表有自己的断点：900 还是四列，899 起换成两行式 / The rules table keeps its own breakpoint: four columns at 900, two-line rows from 899
  await page.setViewportSize({ width: 900, height: 900 })
  await page.getByRole('tab', { name: '规则命中', exact: true }).click()
  await expect(page.locator('.overview-rules .ui-rec-head')).toBeVisible()
  await expect(page.locator('.overview-rule-line').first()).toBeHidden()
  await page.setViewportSize({ width: 899, height: 900 })
  await expect(page.locator('.overview-rules .ui-rec-head')).toBeHidden()
  await expect(page.locator('.overview-rule-line').first()).toBeVisible()
  const sizes = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client)
})

test('手机上窗口分段每格可点满 44：点按区域越过外框上下补齐 @responsive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '只量手机宽度 / Phone width only')
  await openOverview(page)
  await page.getByRole('tab', { name: '查询排行' }).click()
  const option = page.getByRole('button', { name: '1 小时', exact: true })
  // 外框看起来 36；手指落在外框上下各 4 的地方也算这一格 / The frame looks 36; a tap up to 4 past it above or below still lands on the option
  const hits = await option.evaluate((element) => {
    const frame = element.parentElement!.getBoundingClientRect()
    const box = element.getBoundingClientRect()
    const x = box.left + box.width / 2
    return { top: element.contains(document.elementFromPoint(x, frame.top - 3.5)), bottom: element.contains(document.elementFromPoint(x, frame.bottom + 3.5)), reach: frame.height + 8 }
  })
  expect(hits.reach).toBeGreaterThanOrEqual(44)
  expect(hits).toMatchObject({ top: true, bottom: true })
})

test('「·」不在行首，也不挂在行尾：折行处的点被裁掉，露出来的点前后两项都在同一行', async ({ page }) => {
  await openOverview(page)
  await expect(page.locator('.ui-sep')).toHaveCount(0)
  // 每种版式取它最宽的视口，把页面逐像素收窄到这种版式最窄时的宽度，扫过每一处折行点
  // For each layout take its widest viewport and narrow the page pixel by pixel down to that layout's narrowest width, passing every wrap point
  for (const [widest, narrowest] of [[640, 320], [899, 641], [1280, 900]]) {
    await page.setViewportSize({ width: widest, height: 900 })
    await expect(page.locator('.overview-total-value')).toBeVisible()
    const stranded = await page.evaluate(([viewport, floor]) => {
      const root = document.querySelector<HTMLElement>('.overview-page')!
      const gutter = viewport - root.getBoundingClientRect().width
      const found = new Set<string>()
      for (let size = viewport - gutter; size >= floor - gutter; size -= 1) {
        root.style.maxWidth = `${size}px`
        for (const run of document.querySelectorAll<HTMLElement>('.overview-page .ui-dots')) {
          if (!run.getClientRects().length) continue
          // 裁剪从左边界算起：左边有内边距或没有裁剪，行首的点就会露出来
          // The clip starts at the left edge: left padding, or no clip at all, would expose a line-start dot
          const style = getComputedStyle(run)
          if (style.paddingLeft !== '0px' || style.clipPath === 'none') found.add(`裁剪 ${run.textContent}`)
          const edge = run.getBoundingClientRect().left
          const items = [...run.children].filter((item) => item.getClientRects().length)
          items.forEach((item, index) => {
            const box = item.getBoundingClientRect()
            // 贴着左边界的项在行首，它的点在边界外、被裁掉 / An item flush with the left edge starts a line; its dot is outside the edge, clipped
            if (box.left - edge < 1) return
            // 其余项的点露在外面：前一项必须在同一行、在它左边，点才是夹在两项中间
            // Any other item shows its dot, so the item before it must sit on the same line to its left, with the dot between them
            const previous = items[index - 1]?.getBoundingClientRect()
            if (!previous || previous.right > box.left + 1 || previous.bottom <= box.top || previous.top >= box.bottom) found.add(`${size}px ${run.textContent}`)
          })
        }
      }
      root.style.maxWidth = ''
      return [...found]
    }, [widest, narrowest])
    expect(stranded, `视口 ${narrowest}–${widest}`).toEqual([])
  }
})

test('宽屏上底下一排三张卡同高，运行配置的代次做主项、摘要条在它下面、按钮落在卡的底边；规则命中的 Pipeline 从中线开始', async ({ page }) => {
  await openOverview(page)
  // 1440：响应码分布、缓存构成、运行配置从左到右一排，三张同高 / At 1440 response codes, cache composition and the running configuration run left to right on one row, three of one height
  const trio = page.locator('.overview-trio > section')
  await expect(trio).toHaveCount(3)
  const boxes = await trio.evaluateAll((cards) => cards.map((card) => { const box = card.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height } }))
  expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x + boxes[0]!.width)
  expect(boxes[2]!.x).toBeGreaterThan(boxes[1]!.x + boxes[1]!.width)
  expect(new Set(boxes.map((box) => Math.round(box.y))).size).toBe(1)
  expect(new Set(boxes.map((box) => Math.round(box.height))).size).toBe(1)
  // 运行配置：代次做主项在上，四项摘要条在它下面的细线下；手机上那一行小字不出；按钮贴着卡的底边（内边距以内）
  // The running configuration: the generation leads, the four-item strip sits under the hairline below it; the phone's one-line version is not shown; the buttons sit on the card's bottom edge inside its padding
  const card = page.locator('.overview-runtime')
  const lead = await card.locator('.overview-config-lead').boundingBox()
  const hashes = await card.locator('.overview-config-hashes').boundingBox()
  await expect(card.locator('.overview-config-line')).toBeHidden()
  expect(hashes!.y).toBeGreaterThanOrEqual(lead!.y + lead!.height)
  expect(Math.round(hashes!.x)).toBe(Math.round(lead!.x))
  const foot = await card.locator('.overview-runtime-foot').evaluate((element) => {
    const host = element.closest('.overview-card')!
    return { bottom: element.getBoundingClientRect().bottom, edge: host.getBoundingClientRect().bottom - parseFloat(getComputedStyle(host).paddingBottom) }
  })
  expect(Math.round(foot.bottom)).toBe(Math.round(foot.edge))
  // 规则和 Pipeline 平分宽度：次数不再和规则名隔着一整段空白 / Rule and pipeline split the width, so no single long gap separates a rule from its count
  await page.getByRole('tab', { name: '规则命中' }).click()
  const table = await page.locator('.overview-rules').boundingBox()
  const pipeline = await page.locator('.overview-rule-pipeline').first().boundingBox()
  expect(pipeline!.x - table!.x).toBeGreaterThan(table!.width * 0.4)
})

// 概览的演示端点交回的是同一个对象：改完它，离开再回来让概览重新挂载、重新读一遍
// The overview's demo endpoint hands back one shared object: after changing it, leave and come back so the overview remounts and re-reads
async function remountOverview(page: Page): Promise<void> {
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect(page.getByRole('heading', { name: '日志', exact: true })).toBeVisible()
  await page.getByRole('link', { name: '概览', exact: true }).click()
  await expect(page.locator('.overview-total-value')).toBeVisible()
}

test('页头按服务状态写事实：运行中写运行时长和更新时刻，停止后只写快照时刻', async ({ page }) => {
  await openOverview(page)
  // 事实行一项一件事：小标签在上、值在下；按标签取值，不靠整行文字里的空格
  // The facts row: one thing per item, label over value; read a value by its label rather than by spacing in the row's text
  const facts = page.locator('.overview-heading .ui-facts > div')
  const fact = (label: string) => facts.filter({ has: page.locator('.ui-lbl', { hasText: label }) }).locator('b')
  await expect(fact('状态')).toHaveText('运行中')
  await expect(fact('已运行')).toHaveText(/\d+ 天 \d+ 小时/)
  await expect(fact('更新于')).toHaveText(/^\d{2}:\d{2}:\d{2}$/)
  await expect(page.locator('.overview-heading .ui-ph__meta')).not.toContainText('running')
  await page.evaluate(async () => {
    const { mockRequest } = await import('/src/api/mock.ts')
    const snapshot = await mockRequest('/api/v1/overview')
    snapshot.live = false
    snapshot.service_active = false
    await mockRequest('/api/v1/service/stop', { method: 'POST' })
  })
  await remountOverview(page)
  await expect(fact('状态')).toHaveText('已停止')
  await expect(fact('快照')).toHaveText(/\d{2}:\d{2}$/)
  // 停了就没有「已运行」「更新于」可言 / Once stopped there is no uptime or refresh time to report
  await expect(fact('已运行')).toHaveCount(0)
  await expect(fact('更新于')).toHaveCount(0)
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
  // 标题已经说了是实时数据，原因行不再以「运行数据：」开头 / The title already names the data, so the reason does not start with 运行数据：
  await expect(notice.locator('small')).not.toContainText('运行数据：')
  await expect(notice.getByRole('button', { name: '重试', exact: true })).toBeVisible()
  // 旧数据还在 / The old data stays
  await expect(page.locator('.overview-total-value')).toHaveText(EXPECTED_TOTAL)
  await page.evaluate(() => { (globalThis as { __failOverview?: boolean }).__failOverview = false })
  await notice.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.locator('.ui-notice:visible')).toHaveCount(0)
})

test('上游健康的分母是全部上游：观察中的也算，页头的上游事实先说有问题的再说观察中的', async ({ page }) => {
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
  // 页头的上游事实：个数算上观察中的那个，后面先说异常再说观察中，不再写「全部正常」
  // The header's upstream fact: the count includes the one still observed, then unhealthy before observed, and no 全部正常
  const upstreamFact = page.locator('.overview-heading .ui-facts > div').filter({ has: page.locator('.ui-lbl', { hasText: '上游' }) }).locator('b')
  await expect(upstreamFact).toContainText('3 个')
  await expect(upstreamFact).toContainText('1 个异常')
  await expect(upstreamFact).toContainText('1 个观察中')
  await expect(upstreamFact).not.toContainText('全部正常')
  const fact = await upstreamFact.textContent()
  expect(fact!.indexOf('异常')).toBeLessThan(fact!.indexOf('观察中'))
  // 行里：2.48 秒的上游判为异常，状态点、成功率和细条跟着判定；耗时写成 2.5 s；观察中的那行状态点读作「观察中」
  // In the rows: the 2.48 s upstream is unhealthy, and its dot, success rate and bar follow the verdict; the latency reads 2.5 s; the observed row's dot reads 观察中
  const rows = page.locator('.overview-card--upstreams .overview-row')
  const slow = rows.filter({ hasText: '2.5 s' })
  await expect(slow).toHaveCount(1)
  await expect(slow.locator('.overview-dot')).toHaveAttribute('aria-label', '异常')
  await expect(slow.locator('.overview-row-sub b')).toHaveClass(/overview-text--unhealthy/)
  await expect(slow.locator('.overview-row-bar > i')).toHaveClass(/overview-bar--unhealthy/)
  await expect(page.getByText('2480 ms')).toHaveCount(0)
  await expect(rows.locator('.overview-dot[aria-label="观察中"]')).toHaveCount(1)
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

test('耗时慢了：平均延迟取整写 212 ms；上游状态里 999.6 ms 写成 1.0 s，耗时本身不染色', async ({ page }) => {
  await openOverview(page)
  await page.evaluate(async () => {
    const { mockRequest } = await import('/src/api/mock.ts')
    const snapshot = await mockRequest('/api/v1/overview')
    snapshot.metrics.request_latency_recent = { samples: 1000, avg_ms: 212.4, within_10ms: 250, within_100ms: 700, within_1s: 900 }
    snapshot.metrics.upstreams[0].recent.avg_latency_ms = 999.6
  })
  await remountOverview(page)
  // 查询量卡的平均延迟：212.4 ms 取整、仍写最近一小时 / The volume card's average latency: 212.4 ms rounded, still named as the last hour
  await expect(page.locator('.overview-subs dt').nth(2)).toContainText('最近一小时')
  await expect(page.locator('.overview-subs dd').nth(2)).toHaveText('212 ms')
  // 先取整再定单位：999.6 ms 写成 1.0 s，不写「1000 ms」 / Round before choosing the unit: 999.6 ms reads 1.0 s, never 1000 ms
  const first = page.locator('.overview-card--upstreams .overview-row').first()
  await expect(first.locator('.overview-row-value')).toHaveText('1.0 s')
  await expect(page.getByText('1000 ms')).toHaveCount(0)
  // 一行里只有一个告警色：成功率染色、细条按判定上色，耗时本身永远是次要墨色
  // One warning colour per row: the success rate is coloured and the bar follows the verdict; the latency itself stays secondary ink
  const resolve = (token: string) => page.evaluate((name) => {
    const probe = document.createElement('i')
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    document.body.append(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  }, token)
  const latencyColour = await first.locator('.overview-row-value').evaluate((element) => getComputedStyle(element).color)
  expect(latencyColour).toBe(await resolve('--l-ink-2'))
  expect(latencyColour).not.toBe(await resolve('--warn-l'))
  expect(latencyColour).not.toBe(await resolve('--err-l'))
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
  // 启动失败指去日志，并给出去日志页的动作 / A failure points to the logs and offers the way there
  await expect(notice.locator('small')).toHaveText(/^显示停止前 \d{2}:\d{2} 的快照；查看日志了解启动失败的原因。$/)
  await expect(notice.getByRole('link', { name: '查看日志', exact: true })).toHaveAttribute('href', '/logs')
})

test('快照期间服务正在停止：提示照实说正在停止，不许诺「运行后会自动更新」', async ({ page }) => {
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('stopping-original')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?stopping-original';
      import { apiRequest as original } from '/src/api/client.ts?stopping-original';
      export async function apiRequest(path, init) {
        const result = await original(path, init);
        if (path === '/api/v1/service') return { ...result, active_state: 'deactivating', sub_state: 'stop-sigterm' };
        if (path === '/api/v1/overview') return { ...result, live: false, service_active: false };
        return result;
      }
    ` })
  })
  await page.goto('/')
  const notice = page.locator('.ui-notice:visible')
  await expect(notice).toHaveCount(1)
  await expect(notice.locator('span').first()).toHaveText('KixDNS 正在停止')
  await expect(notice.locator('small')).toHaveText(/^显示停止前 \d{2}:\d{2} 的快照。$/)
})

test('旧增强版不提供精确数据：平均延迟写「—」，上游行右端改写成功率、不画细条，状态点读作「不支持判定」，页头只写上游个数', async ({ page }) => {
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
  // 没有延迟可说：小计写「—」，名称不带时段 / No latency to report: the sub-figure reads — and its name carries no period
  await expect(page.locator('.overview-subs dt').nth(2)).toHaveText('平均延迟')
  await expect(page.locator('.overview-subs dd').nth(2)).toHaveText('—')
  // 上游行：整列没有耗时，右端改写成功率，不画细条，第二行也不再重复成功率；状态点读作「不支持判定」
  // Upstream rows: with no latency in the whole column the right end shows the success rate, no bar is drawn and the second line does not repeat the rate; the dot reads 不支持判定
  const card = page.locator('.overview-card--upstreams')
  const rows = card.locator('.overview-row')
  await expect(rows).toHaveCount(3)
  await expect(rows.first().locator('.overview-row-value')).toHaveText(/^\d+(\.\d+)?%$/)
  await expect(rows.first().locator('.overview-row-sub')).not.toContainText('成功率')
  await expect(card.locator('.overview-row-bar')).toHaveCount(0)
  await expect(card.locator('.overview-dot').first()).toHaveAttribute('aria-label', '不支持判定')
  // 判定不了就不汇总：页头的上游事实只写个数 / Nothing to judge, nothing to summarise: the header's upstream fact gives only the count
  const upstreamFact = page.locator('.overview-heading .ui-facts > div').filter({ has: page.locator('.ui-lbl', { hasText: '上游' }) }).locator('b')
  await expect(upstreamFact).toHaveText('3 个')
})

test('第一次启动就失败、还没有任何数据：提示说启动失败，不说读不到数据', async ({ page }) => {
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('first-failed-original')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?first-failed-original';
      import { apiRequest as original } from '/src/api/client.ts?first-failed-original';
      export async function apiRequest(path, init) {
        if (path === '/api/v1/overview') throw new Error('控制通道没有应答');
        const result = await original(path, init);
        if (path === '/api/v1/service') return { ...result, active_state: 'failed', sub_state: 'failed', main_pid: 0 };
        return result;
      }
    ` })
  })
  await page.goto('/')
  const notice = page.locator('.ui-notice:visible')
  await expect(notice).toHaveCount(1)
  await expect(notice).toContainText('KixDNS 启动失败')
  await expect(notice).not.toContainText('读不到运行数据')
  await expect(page.locator('.overview-heading .ui-ph__meta')).toContainText('启动失败')
  // 和首次安装一样保留完整布局：页签、配置卡和去配置页的入口都在，提示给出去日志页的动作
  // The full layout stays as on first install: tabs, the config card and its way to the config page, plus a way to the logs in the notice
  await expect(notice.locator('small')).toHaveText('还没有运行数据；查看日志了解启动失败的原因。')
  await expect(notice.getByRole('link', { name: '查看日志', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: '运行情况', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '运行配置', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '管理配置', exact: true })).toBeVisible()
})
