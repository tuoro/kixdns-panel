import { expect, test, type Page } from '@playwright/test'
import { acceptConfirm } from './confirm'

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

  await expect(page.getByText('KixDNS 已停止', { exact: true })).toBeVisible()
  await expect(page.getByText('数据可能已过期')).toHaveCount(0)
  await expect(page.locator('.overview-total-value')).toHaveText('—')
  await expect(page.getByRole('heading', { name: '请求分布' })).toBeVisible()
  // 没运行过：卡片叫「运行配置」，标签写「未运行」，不自相矛盾 / Never run: the card is 运行配置 with the tag 未运行, not a contradiction
  await expect(page.getByRole('heading', { name: '运行配置', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '上游状态' })).toBeVisible()
  await expect(page.getByRole('button', { name: '清空内部缓存' })).toBeDisabled()
  await page.getByRole('tab', { name: '查询排行', exact: true }).click()
  await expect(page.getByRole('heading', { name: '客户端排行' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '请求域名排行' })).toBeVisible()
  // 页签已经写了「规则命中」，下面不再重复同名标题；页签内容照样在 / The tab names 规则命中, so no repeated heading below; the panel is still there
  await page.getByRole('tab', { name: '规则命中', exact: true }).click()
  await expect(page.getByRole('tabpanel', { name: '规则命中' })).toBeVisible()
  await expect(page.getByText('还没有规则执行过', { exact: true })).toBeVisible()
})

test('Geo 维护结果离开页面后销毁', async ({ page }) => {
  // 基础设置是配置页的一个分页（?section=settings），Geo 数据是它里面的一组 / 基础设置 is one config sub-page (?section=settings); Geo 数据 is a group inside it
  await open(page, '/config?section=settings')
  await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: /Geo 数据/ }).click()
  const geo = page.locator('.geo')
  await geo.getByLabel('自动更新').selectOption('24')
  await expect(geo.getByLabel('自动更新')).toHaveValue('24')
  await geo.getByRole('button', { name: '清理未引用的 Geo 文件' }).click()
  await expect(geo.locator('.geo-note--ok')).toContainText('已清理')

  await page.goto('/logs')
  await page.goto('/config?section=settings')
  await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: /Geo 数据/ }).click()
  await expect(page.locator('.geo')).toBeVisible()
  await expect(page.locator('.geo-note--ok')).toHaveCount(0)
})

test('DNS 诊断在结果顶部显示实际命中的规则 @responsive', async ({ page }) => {
  await open(page, '/diagnostics')
  await page.getByRole('button', { name: '执行查询' }).click()

  const result = page.locator('.diagnostic-result')
  // 命中的规则在执行路径里那一行（组件库的「结果说明」行，带绿色对勾），结果栏不复述。
  // The matched rule is its own row in the path (the kit's step row with a green check); the result bar does not repeat it.
  const matched = result.locator('.ui-step', { hasText: '命中规则 geosite-global' })
  await expect(matched).toBeVisible()
  await expect(matched).toHaveClass(/ui-step--ok/)
  await expect(result.getByRole('heading', { name: '执行路径' })).toBeVisible()
  await expect(result.locator('.diag-outcome')).not.toContainText('geosite-global')
  await expectNoPageOverflow(page)
})

test('系统页按「要不要现在动手」排序，更新项压成一行 @responsive', async ({ page }) => {
  await open(page, '/system')

  // 服务状态在页头，只有一行：它回答「在不在跑」和「要不要动它」；后面依次是更新、安装、凭据。
  // The service state sits in the page header, one line answering whether it runs and whether to
  // touch it; updates, the installation and credentials follow in that order.
  const order = await page.evaluate(() => [...document.querySelectorAll('main .service-line, main section.ui-card')]
    .map((block) => block.className.split(' ').find((name) => name === 'service-line' || name.endsWith('-panel'))))
  expect(order).toEqual(['service-line', 'update-panel', 'runtime-panel', 'credential-panel'])
  // 这一页是看状态、偶尔操作，没有黑色主按钮；列表里每行的操作都是次要按钮。
  // A page read and occasionally acted on has no black primary button; row actions are secondary.
  await expect(page.locator('main .ui-btn--primary, main .button--primary')).toHaveCount(0)

  const line = page.locator('.service-line')
  await expect(line).toHaveCount(1)
  // 页头的事实行：服务、PID、面板版本、内核。服务那一项由状态点说在不在跑，跑着时不多写一个字，停了才加「已停止」；
  // 全称放在悬停标题里。重启、停止就在页头右边。
  // The header's facts row: service, PID, panel version, kernel. The service fact's dot says whether it runs, with no
  // extra word while running and 已停止 only when stopped; the full state sits in the hover title. Restart and stop are in the header.
  await expect(line.locator('.ui-facts .ui-lbl')).toHaveText(['服务', 'PID', '面板版本', '内核'])
  const serviceFact = line.locator('.ui-facts > div').filter({ hasText: 'kixdns.service' }).locator('b')
  await expect(serviceFact).toHaveAttribute('title', '正在运行')
  await expect(serviceFact.locator('.ui-dot')).not.toHaveClass(/ui-dot--off/)
  await expect(serviceFact).not.toContainText('已停止')
  await expect(line.getByRole('button', { name: '重启', exact: true })).toBeVisible()
  await expect(line.getByRole('button', { name: '停止', exact: true })).toBeVisible()

  // 每项更新只保留「从哪到哪」和按钮，不再是一张带三格事实表的大卡。
  const rows = page.locator('.update-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.first().locator('.update-row__from-to')).toContainText('→')
  await expect(rows.nth(1).locator('.update-row__from-to')).toContainText('v1.0.0 → v1.0.1')
  await expect(page.locator('.update-facts')).toHaveCount(0)

  await expectNoPageOverflow(page)
})

test('有更新时只在铃铛上出角标，哪一页都不弹提示；版本换行时「→」跟着新版本走 @responsive', async ({ page }) => {
  // 更新检查跑完的标志是角标上的数：等到它，再断言没有提示跟着弹出来（以前是一条「请前往系统页面查看」）
  // The badge count is the sign that the update check has run: wait for it, then assert no toast followed (there used to be a 请前往系统页面查看 toast)
  await open(page, '/')
  await expect(page.locator('.topbar-update .notification-badge')).toHaveText('2')
  await expect(page.locator('.toast')).toHaveCount(0)
  // 系统页也一样：「可用更新」就在眼前 / The same on the system page: 可用更新 is in plain sight
  await open(page, '/system')
  await expect(page.locator('.update-row').first()).toBeVisible()
  await expect(page.locator('.topbar-update .notification-badge')).toHaveText('2')
  await expect(page.locator('.toast')).toHaveCount(0)
  // 两个版本放不下一行时，「→」和新版本在同一行，不挂在旧版本后面（版本号现在是等宽数字的正文字体 .ui-num，不再是 .ui-mono）
  // When both versions do not fit on one line, the 「→」 shares a line with the new version instead of trailing the old one (versions are now tabular body figures, .ui-num, no longer .ui-mono)
  const fromTo = page.locator('.update-row').first().locator('.update-row__from-to')
  const [arrow, latest] = await fromTo.evaluate((element) => {
    const keep = element.querySelector('.update-row__keep')!
    const range = document.createRange()
    range.setStart(keep.firstChild!, 0)
    range.setEnd(keep.firstChild!, 1)
    return [range.getBoundingClientRect().top, keep.querySelector('.ui-num')!.getBoundingClientRect().top]
  })
  expect(Math.abs(arrow - latest)).toBeLessThan(4)
})

test('内核可更新到最新并回到上一个 @responsive', async ({ page }) => {
  await open(page, '/system')
  const kernelRow = page.locator('.update-row').first()
  const runtime = page.locator('.runtime-panel')
  await expect(kernelRow.locator('.update-row__from-to')).toContainText('Run #30231271280 → Run #30235703570')
  // 更新前先确认要装哪个构建，并按当前服务状态说清是短暂重启还是什么都不启动。
  // An update first names the build and says, from the service state, whether DNS restarts briefly or nothing starts.
  await kernelRow.getByRole('button', { name: '更新', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toContainText('Run #30235703570')
  await expect(page.getByRole('alertdialog')).toContainText('DNS 解析短暂中断')
  await expect(page.getByRole('alertdialog')).toContainText('开机自启设置保持不变')
  await expectNoPageOverflow(page)
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: '内核已更新并通过健康检查' })).toBeVisible()
  await expect(kernelRow.locator('.update-row__from-to')).toContainText('已是最新')
  await expect(runtime.locator('.install-version')).toHaveText('Run #30235703570')
  // 上一个版本写在「当前安装」卡的底行，回退按钮就在它旁边 / The previous build sits on the installed card's bottom row, with the rollback button beside it
  await expect(runtime.locator('.install-previous')).toContainText('上一个版本 Run #30231271280')

  await page.locator('.service-line').getByRole('button', { name: '停止' }).click()
  await acceptConfirm(page)
  await expect(page.locator('.service-line')).toContainText('已停止')

  await runtime.getByRole('button', { name: '回退', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toContainText('回退到 Run #30231271280')
  await expect(page.getByRole('alertdialog')).toContainText('不会启动服务')
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: '服务仍停止，下次启动时生效' })).toBeVisible()
  await expect(page.locator('.service-line')).toContainText('已停止')
  await expect(runtime.locator('.install-version')).toHaveText('Run #30231271280')
  await expect(runtime.locator('.install-previous')).toContainText('上一个版本 Run #30235703570')
})

test('内核检查失败时面板更新照常提示 @responsive', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-kernel-check-failed', 'true'))
  await open(page, '/system')
  const [kernelRow, panelRow] = [page.locator('.update-row').first(), page.locator('.update-row').nth(1)]
  await expect(kernelRow.locator('.update-row__from-to')).toContainText('检查失败：GitHub 匿名 API 配额已用尽')
  await expect(kernelRow.getByRole('button')).toHaveCount(0)
  await expect(panelRow.locator('.update-row__from-to')).toContainText('v1.0.0 → v1.0.1')
  await expect(panelRow.getByRole('button', { name: '在线更新' })).toBeVisible()
  // 回退只用本机的版本，读不到远端时照样能回。 / Rollback uses only local versions, so it still works offline.
  await expect(page.locator('.runtime-panel').getByRole('button', { name: '回退', exact: true })).toBeEnabled()
  await expect(page.locator('.topbar-update .notification-badge')).toHaveText('1')
  await expectNoPageOverflow(page)
})

test('更新通知可标记已读并在刷新后保持', async ({ page }) => {
  await open(page, '/')
  const bell = page.locator('.topbar-update')
  await expect(bell.locator('.notification-badge')).toHaveText('2')
  await bell.dispatchEvent('click')
  const popover = page.locator('.notification-popover')
  await expect(popover).toBeVisible()
  await expect(popover.locator('.notification-item--unread')).toHaveCount(2)
  await popover.getByRole('button', { name: '全部已读' }).click()
  await expect(bell.locator('.notification-badge')).toHaveCount(0)
  // 读过之后两条通知还在，只是不再标未读；「全部已读」没东西可标就收起来，不另写一行「已全部阅读」
  // After reading, both notices stay but lose their unread mark; 全部已读 goes away with nothing left to mark, and no 已全部阅读 line is added
  await expect(popover.locator('.notification-item')).toHaveCount(2)
  await expect(popover.locator('.notification-item--unread')).toHaveCount(0)
  await expect(popover.locator('.notification-item__title i')).toHaveCount(0)
  await expect(popover.getByRole('button', { name: '全部已读' })).toHaveCount(0)

  await page.reload()
  await expect(page.locator('.app-shell')).toBeVisible()
  await expect(page.locator('.topbar-update .notification-badge')).toHaveCount(0)
  await page.locator('.topbar-update').dispatchEvent('click')
  await expect(page.locator('.notification-popover .notification-item')).toHaveCount(2)
  await expect(page.locator('.notification-popover .notification-item--unread')).toHaveCount(0)
})

test('操作审计可按动作筛选', async ({ page }) => {
  await open(page, '/logs')
  await page.getByRole('tab', { name: '操作审计', exact: true }).click()
  await expect(page.locator('.audit-line')).toHaveCount(7)
  await page.getByRole('group', { name: '审计动作类别' }).getByRole('button', { name: '配置', exact: true }).click()
  await expect(page.locator('.audit-line')).toHaveCount(3)
  await page.getByLabel('筛选操作审计').fill('schedule')
  await expect(page.locator('.audit-line')).toHaveCount(1)
  await expect(page.locator('.audit-line')).toContainText('config.geo_data.schedule.apply')
})

test('运行日志的级别筛选由服务端执行', async ({ page }) => {
  // 分页的演示：日志共 120 行，首屏只加载 80 行，其中 5 行是警告，全部 120 行里有 8 行。
  // The paged demo: 120 lines in all, 80 loaded on the first page; 5 of those are
  // warnings, 8 of the full 120 are.
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-log-paged-slow', 'true'))
  await open(page, '/logs')
  await expect(page.locator('.log-line')).toHaveCount(80)

  // 切到「警告」后是 8 行：浏览器只过滤已加载的 80 行最多找到 5 行，多出来的 3 行只能来自服务端。
  // Warning shows 8 lines: filtering the 80 loaded lines in the browser finds at
  // most 5, so the other 3 can only have come from the server.
  await page.getByRole('group', { name: '日志级别' }).getByRole('button', { name: '警告', exact: true }).click()
  await expect(page.locator('.log-line')).toHaveCount(8)
  await expect(page.locator('.log-line--warning')).toHaveCount(8)
  await expect(page.locator('.log-line--info')).toHaveCount(0)

  await page.getByRole('group', { name: '日志级别' }).getByRole('button', { name: '全部', exact: true }).click()
  await expect(page.locator('.log-line')).toHaveCount(80)
})

test('运行日志停在顶部时直接显示新日志，读历史时攒进提示条 @responsive', async ({ page }) => {
  // mock 在这个标记下每取一次首屏就多出三行更新的日志。时钟由测试往前拨，不等真实的 5 秒。
  // Under this flag the mock adds three newer lines on every first-page fetch.
  // The test moves the clock forward instead of waiting five real seconds.
  await page.clock.install()
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-log-growing', 'true'))
  await open(page, '/logs')
  const lines = page.locator('.log-line')
  const banner = page.locator('.ui-banner')
  await expect(lines.first()).toContainText('transport=tcp')
  // 没有实时开关了。/ There is no live switch any more.
  await expect(page.getByRole('button', { name: /实时|已暂停/ })).toHaveCount(0)
  // 滚动只在列表里发生，整页不出纵向滚动条：每行的读屏标签曾经逃出列表的裁剪，
  // 把页面撑出一大段空白。
  // Scrolling happens inside the list only, never the whole page: the per-line
  // screen-reader labels once escaped the list's clipping and stretched the page.
  expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(0)

  // 停在顶部：下一次取数直接换上，不出提示条。
  // At the top: the next fetch goes straight into the list, no banner.
  const newestAtTop = await lines.first().textContent()
  await page.clock.fastForward(5_000)
  await expect(lines.first()).not.toHaveText(newestAtTop!)
  await expect(banner).toHaveCount(0)

  // 往下读历史：下一次取数不动列表，只在上方出提示条，数目是新来的三行。
  // Reading history: the next fetch leaves the list alone and only raises the
  // banner, counting the three lines that arrived.
  await page.locator('.log-stream').evaluate((stream) => {
    stream.scrollTop = 400
    stream.dispatchEvent(new Event('scroll'))
  })
  const newestWhileReading = await lines.first().textContent()
  await page.clock.fastForward(5_000)
  await expect(banner).toHaveText('有 3 条新日志，点击显示')
  await expect(lines.first()).toHaveText(newestWhileReading!)
  await expectNoPageOverflow(page)

  // 点提示条：新日志进来，回到顶部，提示条消失。
  // Pressing the banner brings the new lines in, back at the top, and it goes away.
  await banner.click()
  await expect(banner).toHaveCount(0)
  await expect(lines.first()).not.toHaveText(newestWhileReading!)
  expect(await page.locator('.log-stream').evaluate((stream) => stream.scrollTop)).toBe(0)
})

test('unit 输出未送到 journald 时运行日志显示常驻提示 @responsive', async ({ page }) => {
  await open(page, '/logs')
  await expect(page.locator('.log-notice')).toHaveCount(0)

  await page.addInitScript(() => localStorage.setItem('kixdns:demo-log-output-redirected', 'true'))
  await open(page, '/logs')
  const notice = page.locator('.log-notice')
  // 句子由服务端拼好，页面原样展示，不在浏览器里再拼一遍。
  // The sentence is composed server-side and shown verbatim, not re-assembled in the browser.
  await expect(notice).toHaveText('这个 unit 的输出没有送到 journald（StandardOutput=append:/var/log/kixdns.log），这里只会看到 systemd 自己的启停记录')
  await expect(page.locator('.status-banner')).toHaveCount(0)
  await expectNoPageOverflow(page)

  await page.getByRole('tab', { name: '操作审计', exact: true }).click()
  await expect(notice).toHaveCount(0)
})

test('切换级别后不会拿旧级别的游标翻页', async ({ page }) => {
  // mock 在这个标记下分页（120 行，每页 80）且响应慢：带 before 的 300ms，带 level 的 1500ms。
  // 顺序：翻页（全部）在飞 → 切到警告 → 旧翻页落地被丢弃 → 滚到底。修复前这一滚会拿着
  // 「全部」的游标 79 去请求警告级别，落地时把 79 之后的三行警告再追加一遍：8 行变 11 行。
  // Under this flag the mock pages (120 lines, 80 per page) and answers slowly: 300ms with
  // `before`, 1500ms with `level`. Sequence: older page (all) in flight → switch to warning →
  // the stale older page lands and is dropped → scroll to the bottom. Before the fix that
  // scroll requests the warning level with the "all" cursor 79, and when it lands the three
  // warning lines after 79 are appended again: 8 lines become 11.
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-log-paged-slow', 'true'))
  await open(page, '/logs')
  const lines = page.locator('.log-line')
  const loadMore = page.locator('.log-more')
  // 翻页走滚动处理器而不是点按钮：Playwright 点之前会把按钮滚进视口，那一滚本身就触发翻页。
  // 事件显式派发一次，不依赖视口高度够不够让流真的滚起来。
  // Page via the scroll handler, not the button: Playwright scrolls the button into view before
  // clicking and that scroll already triggers a page. Dispatch the event explicitly so the test
  // does not depend on the viewport being short enough for the stream to actually scroll.
  const scrollToBottom = () => page.locator('.log-stream').evaluate((stream) => {
    stream.scrollTop = stream.scrollHeight
    stream.dispatchEvent(new Event('scroll'))
  })
  await expect(lines).toHaveCount(80)
  await expect(loadMore).toBeEnabled()

  await scrollToBottom()
  await expect(loadMore).toContainText('正在加载')
  await page.getByRole('group', { name: '日志级别' }).getByRole('button', { name: '警告', exact: true }).click()
  // 旧翻页落地（300ms）：修复后按钮已随游标一起消失，修复前它重新可点。
  // The stale older page lands (300ms): fixed, the button is gone with the cursor; unfixed, it is clickable again.
  await expect(loadMore.filter({ hasText: '正在加载' })).toHaveCount(0)
  await scrollToBottom()

  // 警告首屏（1500ms）：120 行里 index % 17 === 0 的 8 行，一页放得下，没有游标。
  // The warning first page (1500ms): the 8 lines with index % 17 === 0 out of 120, one page, no cursor.
  await expect(lines).toHaveCount(8)
  await expect(loadMore).toHaveCount(0)
  // 等够一次带 level 的翻页（1500ms）落地的时间：修复前它会把 index 85/102/119 再追加一遍。
  // Wait long enough for a level-bearing older page (1500ms) to land: unfixed, it appends index 85/102/119 again.
  await page.waitForTimeout(1800)
  await expect(lines).toHaveCount(8)
})

test('主页面不会产生视口级横向溢出 @responsive', async ({ page }) => {
  for (const path of ['/', '/config', '/logs', '/diagnostics', '/system']) {
    await open(page, path)
    await expectNoPageOverflow(page)
  }
})
