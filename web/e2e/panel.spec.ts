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
  await expect(page.getByRole('button', { name: '清空缓存' })).toBeDisabled()
  await page.getByRole('tab', { name: '查询排行', exact: true }).click()
  await expect(page.getByRole('heading', { name: '客户端排行' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '请求域名排行' })).toBeVisible()
  // 页签已经写了「规则命中」，下面不再重复同名标题；页签内容照样在 / The tab names 规则命中, so no repeated heading below; the panel is still there
  await page.getByRole('tab', { name: '规则命中', exact: true }).click()
  await expect(page.getByRole('tabpanel', { name: '规则命中' })).toBeVisible()
  await expect(page.getByText('还没有规则命中过', { exact: true })).toBeVisible()
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
  // 已经有 GeoSite 了：不再提安装包里那份 / GeoSite is already there: the package's copy is not offered
  await expect(page.locator('.geo-builtin')).toHaveCount(0)
})

test('还没有 GeoSite 时可以导入安装包自带的那份 @responsive', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-geosite-empty', 'true'))
  await open(page, '/config?section=settings')
  await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: /Geo 数据/ }).click()
  const geo = page.locator('.geo')
  const offer = geo.locator('.geo-builtin')
  const link = geo.getByRole('textbox', { name: 'GeoSite 链接 1' })
  await expect(offer).toContainText('geosite.dat')
  await expect(offer).toContainText('安装包自带')

  // 用户填了自己的链接就不再提；清掉又回来 / A link of the user's own hides the offer; clearing it brings it back
  await link.fill('https://example.com/geosite.dat')
  await expect(offer).toHaveCount(0)
  await link.fill('')
  await expect(offer).toBeVisible()

  await geo.getByRole('button', { name: '导入安装包自带的 GeoSite' }).click()
  await expect(geo.locator('.geo-note--ok')).toContainText('已导入，文件路径已填进草稿')
  await expect(offer).toHaveCount(0)
  // 链接框为了好折行插了看不见的断点，比较前去掉 / The link field adds invisible break hints for wrapping; drop them before comparing
  await expect.poll(async () => (await link.inputValue()).replace(/[\u200b\u2060]/g, ''))
    .toBe('https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat')
  await expect(geo.locator('.geo-item', { has: page.getByRole('textbox', { name: 'GeoSite 链接 1' }) }).locator('.geo-file')).toContainText('geosite.dat10.7 MiB · 安装包自带')
  // 路径进了草稿，保存后才生效 / The path is in the draft and takes effect on save
  await expect(page.locator('.cfg__savebar')).toContainText('已修改 1 处')
  await expectNoPageOverflow(page)
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
  await expect(kernelRow.locator('.update-row__from-to')).toContainText('2026.10.13 → 2026.10.13.2')
  await expect(kernelRow.getByRole('link', { name: '发布说明' })).toHaveAttribute('href', 'https://github.com/tuoro/kixdns/releases/tag/2026.10.13.2')
  await expect(runtime.locator('.install-version__label')).toHaveText('版本')
  await expect(runtime.locator('.install-version b')).toHaveText('2026.10.13')
  // fork 发布没有补丁集：附注里不写「补丁集 未记录」；提交是内核仓库的 / A fork release has no patchset, so the notes do not say 补丁集 未记录; its commit is the kernel repository's
  await expect(runtime.locator('.install-meta')).not.toContainText('补丁集')
  await expect(runtime.locator('.install-hashes')).toContainText('内核提交351d490c7bc0')
  // 当前安装链到内核所在的 fork 发布页，不再链到上游的老提交 / The current install links to its fork release, no longer to an old upstream commit
  await expect(runtime.locator('.install-meta').getByRole('link', { name: '发布说明' })).toHaveAttribute('href', 'https://github.com/tuoro/kixdns/releases/tag/2026.10.13')
  await expect(runtime.getByRole('link', { name: '原版源码' })).toHaveCount(0)
  // 面板改用 fork 发布之前的 p28 内核还留着，照旧按构建号称呼 / The p28 kernel from before the move to fork releases is still kept and named by its build as before
  await expect(runtime.locator('.install-previous')).toContainText('上一个版本 构建 #36374613990')
  // 更新前先确认要装哪个版本，并按当前服务状态说清是短暂重启还是什么都不启动。
  // An update first names the version and says, from the service state, whether DNS restarts briefly or nothing starts.
  await kernelRow.getByRole('button', { name: '更新', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toContainText('更新内核到 2026.10.13.2')
  await expect(page.getByRole('alertdialog')).toContainText('先下载并校验这个版本')
  await expect(page.getByRole('alertdialog')).toContainText('DNS 解析短暂中断')
  await expect(page.getByRole('alertdialog')).toContainText('开机自启设置保持不变')
  await expectNoPageOverflow(page)
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: '内核已更新，正在运行' })).toBeVisible()
  await expect(kernelRow.locator('.update-row__from-to')).toContainText('已是最新')
  await expect(runtime.locator('.install-version b')).toHaveText('2026.10.13.2')
  await expect(runtime.locator('.install-version__label')).toHaveText('版本')
  await expect(runtime.locator('.install-meta').getByRole('link', { name: '发布说明' })).toHaveAttribute('href', 'https://github.com/tuoro/kixdns/releases/tag/2026.10.13.2')
  // 上一个版本写在「当前安装」卡的底行，回退按钮就在它旁边 / The previous version sits on the installed card's bottom row, with the rollback button beside it
  await expect(runtime.locator('.install-previous')).toContainText('上一个版本 2026.10.13')

  await page.locator('.service-line').getByRole('button', { name: '停止' }).click()
  await acceptConfirm(page)
  await expect(page.locator('.service-line')).toContainText('已停止')

  await runtime.getByRole('button', { name: '回退', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toContainText('回退到 2026.10.13')
  await expect(page.getByRole('alertdialog')).toContainText('不会启动服务')
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: '服务仍停止，下次启动时生效' })).toBeVisible()
  await expect(page.locator('.service-line')).toContainText('已停止')
  await expect(runtime.locator('.install-version b')).toHaveText('2026.10.13')
  await expect(runtime.locator('.install-previous')).toContainText('上一个版本 2026.10.13.2')
})

test('内核检查失败时面板更新照常提示 @responsive', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-kernel-check-failed', 'true'))
  await open(page, '/system')
  const [kernelRow, panelRow] = [page.locator('.update-row').first(), page.locator('.update-row').nth(1)]
  await expect(kernelRow.locator('.update-row__from-to')).toContainText('检查失败：GitHub 匿名访问次数用完了')
  // 不知道最新版本就不给「更新」；行里唯一的按钮是去填 Token 的，点了焦点落到 Token 输入框
  // No 更新 without a known latest build; the row's only button leads to the token field and focuses it
  await expect(kernelRow.getByRole('button')).toHaveCount(1)
  await kernelRow.getByRole('button', { name: '填写 Token', exact: true }).click()
  await expect(page.locator('input[aria-label="GitHub Token"]')).toBeFocused()
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
  await expect(page.locator('.audit-line')).toContainText('定时更新 Geo 数据')
})

test('运行日志的级别筛选由服务端执行', async ({ page }) => {
  // 分页的演示：日志共 120 行，首屏只加载 80 行，其中 5 行是警告，全部 120 行里有 8 行。
  // The paged demo: 120 lines in all, 80 loaded on the first page; 5 of those are
  // warnings, 8 of the full 120 are.
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-log-paged-slow', 'true'))
  await open(page, '/logs?view=runtime')
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
  await open(page, '/logs?view=runtime')
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
  await open(page, '/logs?view=runtime')
  await expect(page.locator('.log-notice')).toHaveCount(0)

  await page.addInitScript(() => localStorage.setItem('kixdns:demo-log-output-redirected', 'true'))
  await open(page, '/logs?view=runtime')
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
  await open(page, '/logs?view=runtime')
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

// 只在测试里替换 API 模块边界 / Swap the API module boundary in the test only
async function wrapClient(page: Page, tag: string, body: string): Promise<void> {
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes(tag)) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?${tag}';
      import { apiRequest as original } from '/src/api/client.ts?${tag}';
      ${body}
    ` })
  })
}
type Held = { hold: boolean; held: (() => void)[] }
const release = (page: Page) => page.evaluate(() => { const state = (globalThis as unknown as { __held: Held }).__held; state.hold = false; state.held.forEach((go) => go()); state.held = [] })

test('起不来时点停止：停止之前发出的那次服务状态晚回来，页头也不退回「启动失败」', async ({ page }) => {
  // 服务状态是发出那一刻的；__held.hold 打开时停在路上 / The service state is the one of the moment it is sent; with __held.hold on it
  // waits on its way
  await wrapClient(page, 'stop-original', `
    const state = globalThis.__held = { hold: false, held: [] };
    let now = { active_state: 'activating', sub_state: 'auto-restart', main_pid: 0, did_not_come_up: true };
    export async function apiRequest(path, init) {
      if (path === '/api/v1/service/stop') { now = { active_state: 'inactive', sub_state: 'dead', main_pid: 0, did_not_come_up: false }; return { unit: 'kixdns.service', ...now }; }
      if (path !== '/api/v1/service') return original(path, init);
      const said = { unit: 'kixdns.service', ...now };
      if (state.hold) await new Promise((resolve) => state.held.push(resolve));
      return said;
    }
  `)
  await page.clock.install()
  await open(page, '/system')
  const facts = page.locator('.system-facts')
  await expect(facts).toContainText('启动失败')
  // 页面时钟停住：只有 runFor 才往前走 / The page clock stands still: only runFor moves it
  await page.clock.pauseAt(Date.now() + 1_000)
  // 起不来时每 5 秒看一次服务：这一次停在路上 / While it does not come up the service is looked at every 5 seconds: this one is held
  await page.evaluate(() => { (globalThis as unknown as { __held: Held }).__held.hold = true })
  await page.clock.runFor(5_000)
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __held: Held }).__held.held.length)).toBe(1)
  await page.evaluate(() => { (globalThis as unknown as { __held: Held }).__held.hold = false })
  await page.locator('.service-line').getByRole('button', { name: '停止' }).click()
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: 'KixDNS 服务已停止' })).toBeVisible()
  await release(page)
  await expect(page.locator('.service-line').getByRole('button', { name: '启动' })).toBeEnabled()
  await expect(facts).toContainText('已停止')
  await expect(facts).not.toContainText('启动失败')
})

test('更新内核时检查更新还在路上：更新以后的检查结果是更新以后的，不再说有新版本', async ({ page }) => {
  // 检查结果是发出那一刻的 / A check's result is the one of the moment it is sent
  await wrapClient(page, 'kernel-check-original', `
    const state = globalThis.__held = { hold: false, held: [] };
    export async function apiRequest(path, init) {
      if (path !== '/api/v1/updates/status') return original(path, init);
      const said = await original(path, init);
      if (state.hold) await new Promise((resolve) => state.held.push(resolve));
      return said;
    }
  `)
  await open(page, '/system')
  const kernelRow = page.locator('.update-row').first()
  await expect(kernelRow.locator('.update-row__from-to')).toContainText('2026.10.13 → 2026.10.13.2')
  await page.evaluate(() => { (globalThis as unknown as { __held: Held }).__held.hold = true })
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __held: Held }).__held.held.length)).toBe(1)
  await page.evaluate(() => { (globalThis as unknown as { __held: Held }).__held.hold = false })
  await kernelRow.getByRole('button', { name: '更新', exact: true }).click()
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: '内核已更新，正在运行' })).toBeVisible()
  await release(page)
  await expect(page.getByRole('button', { name: '检查更新', exact: true })).toBeEnabled()
  await expect(kernelRow.locator('.update-row__from-to')).toContainText('已是最新')

  // 回退也一样：回退以后又有新版本可装 / A rollback likewise: after it the new version can be installed again
  await page.evaluate(() => { (globalThis as unknown as { __held: Held }).__held.hold = true })
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __held: Held }).__held.held.length)).toBe(1)
  await page.evaluate(() => { (globalThis as unknown as { __held: Held }).__held.hold = false })
  await page.locator('.runtime-panel').getByRole('button', { name: '回退', exact: true }).click()
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: '已回退到上一个内核' })).toBeVisible()
  await release(page)
  await expect(page.getByRole('button', { name: '检查更新', exact: true })).toBeEnabled()
  await expect(kernelRow.locator('.update-row__from-to')).toContainText('2026.10.13 → 2026.10.13.2')
})

// 保存 Token 以后重读的内核状态还在路上就换了内核：那次读是换之前的，晚回来也不把页面退回换之前（回退也一样）
// After a token save the kernel state is read again, and the kernel is switched while that read is still out: it predates the switch,
// so landing late it does not put the page back to before it (a rollback likewise)
test('读内核状态还在路上就更新、回退了内核：之前发出的那次晚回来也不把页面退回去', async ({ page }) => {
  await wrapClient(page, 'kernel-read-original', `
    const state = globalThis.__held = { hold: false, held: [], failService: false };
    export async function apiRequest(path, init) {
      if (path === '/api/v1/service' && state.failService) throw new Error('服务状态读不到（模拟）');
      if (path !== '/api/v1/kixdns/kernel') return original(path, init);
      const said = await original(path, init);
      if (state.hold) await new Promise((resolve) => state.held.push(resolve));
      return said;
    }
  `)
  await open(page, '/system')
  const installedVersion = page.locator('.install-version b')
  await expect(installedVersion).toHaveText('2026.10.13')
  const held = () => page.evaluate(() => (globalThis as unknown as { __held: Held }).__held.held.length)
  const holdNextRead = async () => {
    await page.evaluate(() => { (globalThis as unknown as { __held: Held }).__held.hold = true })
    await page.locator('input[aria-label="GitHub Token"]').fill('github_pat_e2e_placeholder')
    await page.getByRole('button', { name: /^(保存|替换)$/ }).click()
    await expect.poll(held).toBe(1)
    await page.evaluate(() => { (globalThis as unknown as { __held: Held }).__held.hold = false })
  }
  await holdNextRead()
  // 更新以后那次服务状态读失败：页顶出读取失败的提示条，借它的「重试」看「读取中」收没收（读取中时它按不下）
  // The service read after the update fails: the read-failure banner shows, and its 重试 tells whether 读取中 ended (it is held while reading)
  await page.evaluate(() => { (globalThis as unknown as { __held: Held & { failService: boolean } }).__held.failService = true })
  await page.locator('.update-row').first().getByRole('button', { name: '更新', exact: true }).click()
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: '内核已更新' })).toBeVisible()
  await expect(installedVersion).toHaveText('2026.10.13.2')
  await release(page)
  await expect.poll(held).toBe(0)
  await expect(page.locator('input[aria-label="GitHub Token"]')).toBeEnabled()
  await expect(installedVersion).toHaveText('2026.10.13.2')
  // 作废的那次读不再替自己收尾，「读取中」由更新的回应收起，不一直挂着 / The voided read no longer winds itself up; the update's answer
  // ends 读取中, so it does not hang on
  const banner = page.locator('.status-banner')
  await expect(banner).toContainText('服务状态：服务状态读不到（模拟）')
  await expect(banner.getByRole('button', { name: '重试' })).toBeEnabled()
  await page.evaluate(() => { (globalThis as unknown as { __held: Held & { failService: boolean } }).__held.failService = false })

  await holdNextRead()
  await page.locator('.runtime-panel').getByRole('button', { name: '回退', exact: true }).click()
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: '已回退到上一个内核' })).toBeVisible()
  await expect(installedVersion).toHaveText('2026.10.13')
  await release(page)
  await expect.poll(held).toBe(0)
  await expect(page.locator('input[aria-label="GitHub Token"]')).toBeEnabled()
  await expect(installedVersion).toHaveText('2026.10.13')
})

// 读内核状态失败过一次（页面照旧留着上次读到的），之后更新成功：更新的回应就是新状态，「内核：…」那条读取失败不再挂着
// A kernel-state read failed once (the page keeps what it read last), then an update succeeds: its answer is the new state, so the
// 「内核：…」 read failure no longer stays up
test('读内核状态失败过，之后更新成功：内核那条读取失败收起', async ({ page }) => {
  await wrapClient(page, 'kernel-fail-original', `
    const state = globalThis.__kernelFail = { fail: false };
    export async function apiRequest(path, init) {
      if (path === '/api/v1/kixdns/kernel' && state.fail) throw new Error('内核状态读不到（模拟）');
      return original(path, init);
    }
  `)
  await open(page, '/system')
  await expect(page.locator('.install-version b')).toHaveText('2026.10.13')
  await page.evaluate(() => { (globalThis as unknown as { __kernelFail: { fail: boolean } }).__kernelFail.fail = true })
  // 保存 Token 以后会重读内核状态：这一次读失败 / A token save re-reads the kernel state: this read fails
  await page.locator('input[aria-label="GitHub Token"]').fill('github_pat_e2e_placeholder')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const banner = page.locator('.status-banner')
  await expect(banner).toContainText('内核：内核状态读不到（模拟）')
  await page.evaluate(() => { (globalThis as unknown as { __kernelFail: { fail: boolean } }).__kernelFail.fail = false })
  await page.locator('.update-row').first().getByRole('button', { name: '更新', exact: true }).click()
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: '内核已更新' })).toBeVisible()
  await expect(page.locator('.install-version b')).toHaveText('2026.10.13.2')
  await expect(banner).toHaveCount(0)
})

// 检查更新以后会重读 Token 状态（剩余次数）：那次读还在路上时保存了 Token，晚回来也不把「已配置」改回「匿名」，读失败了也不挂出错误。
// 保存途中（还在等检查结果、自己那次重读还没发）回来，和保存完以后回来，都一样
// 检查更新 re-reads the token status (the remaining quota): a token saved while that read is still out stays 已配置 when it lands late,
// and a failure of that read puts up no error. Alike whether it lands mid-save (waiting on the check, before the save's own re-read) or
// after the save
type TokenHeld = Held & { landed: number; fail: boolean; holdChecks: boolean; checks: (() => void)[] }
for (const [when, fails] of [['保存途中', false], ['保存以后', false], ['保存以后、读失败', true]] as const) {
  test(`读 Token 状态还在路上就保存了 Token（${when}回来）：不改回「匿名」，不挂错误`, async ({ page }) => {
    await wrapClient(page, `token-status-${when === '保存途中' ? 'mid' : 'after'}-${fails}-original`, `
      const state = globalThis.__held = { hold: false, held: [], landed: 0, fail: ${fails}, holdChecks: false, checks: [] };
      export async function apiRequest(path, init) {
        if (path === '/api/v1/updates/status' && state.holdChecks) {
          const said = await original(path, init);
          await new Promise((resolve) => state.checks.push(resolve));
          return said;
        }
        if (path !== '/api/v1/settings/github-token' || (init?.method ?? 'GET') !== 'GET') return original(path, init);
        const said = await original(path, init);
        if (state.hold) {
          await new Promise((resolve) => state.held.push(resolve));
          state.landed += 1;
          if (state.fail) throw new Error('Token 状态读不到（模拟）');
        }
        return said;
      }
    `)
    const held = () => page.evaluate(() => (globalThis as unknown as { __held: TokenHeld }).__held)
    await open(page, '/system')
    const tag = page.locator('.ui-tag', { hasText: /^(匿名|已配置)$/ })
    const tokenError = page.locator('.system-error')
    await expect(tag).toHaveText('匿名')
    await page.evaluate(() => { (globalThis as unknown as { __held: TokenHeld }).__held.hold = true })
    await page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect.poll(async () => (await held()).held.length).toBe(1)
    await page.evaluate((mid) => { const state = (globalThis as unknown as { __held: TokenHeld }).__held; state.hold = false; state.holdChecks = mid }, when === '保存途中')
    await page.locator('input[aria-label="GitHub Token"]').fill('github_pat_e2e_placeholder')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.toast--success').filter({ hasText: 'GitHub Token 已验证并保存' })).toBeVisible()
    await expect(tag).toHaveText('已配置')
    if (when === '保存途中') {
      // 保存还在等检查结果：这时之前那次读回来 / The save still waits on the check: the earlier read lands now
      await expect.poll(async () => (await held()).checks.length).toBeGreaterThan(0)
      await release(page)
      await expect.poll(async () => (await held()).landed).toBe(1)
      await expect(tag).toHaveText('已配置')
      await expect(tokenError).toHaveCount(0)
      await page.evaluate(() => { const state = (globalThis as unknown as { __held: TokenHeld }).__held; state.holdChecks = false; state.checks.forEach((go) => go()); state.checks = [] })
      await expect(page.locator('input[aria-label="GitHub Token"]')).toBeEnabled()
    } else {
      await expect(page.locator('input[aria-label="GitHub Token"]')).toBeEnabled()
      await release(page)
      await expect.poll(async () => (await held()).landed).toBe(1)
    }
    await expect(tag).toHaveText('已配置')
    await expect(tokenError).toHaveCount(0)
    await expect(page.getByRole('button', { name: '删除 Token', exact: true })).toBeEnabled()
  })
}

test('保存 GitHub Token 时检查更新还在路上：保存以后的检查结果是带上 Token 的，不再说检查失败', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-kernel-check-failed', 'true'))
  await wrapClient(page, 'token-check-original', `
    const state = globalThis.__held = { hold: false, held: [] };
    export async function apiRequest(path, init) {
      if (path !== '/api/v1/updates/status') return original(path, init);
      const said = await original(path, init);
      if (state.hold) await new Promise((resolve) => state.held.push(resolve));
      return said;
    }
  `)
  await open(page, '/system')
  const kernelRow = page.locator('.update-row').first()
  await expect(kernelRow.locator('.update-row__from-to')).toContainText('检查失败')
  // 匿名访问用完时发出的那次检查停在路上 / The check sent while anonymous access was used up waits on its way
  await page.evaluate(() => { (globalThis as unknown as { __held: Held }).__held.hold = true })
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __held: Held }).__held.held.length)).toBe(1)
  await page.evaluate(() => { (globalThis as unknown as { __held: Held }).__held.hold = false; localStorage.removeItem('kixdns:demo-kernel-check-failed') })
  await page.locator('input[aria-label="GitHub Token"]').fill('github_pat_e2e_placeholder')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.toast--success').filter({ hasText: 'GitHub Token 已验证并保存' })).toBeVisible()
  await release(page)
  await expect(page.getByRole('button', { name: '检查更新', exact: true })).toBeEnabled()
  await expect(kernelRow.getByText('有新版本')).toBeVisible()

  // 删掉 Token 也一样：删之前发出的检查不算数，删了以后匿名访问又用完了 / Deleting the token likewise: a check sent before the delete
  // does not count, and anonymous access is used up again afterwards
  await page.evaluate(() => { (globalThis as unknown as { __held: Held }).__held.hold = true })
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __held: Held }).__held.held.length)).toBe(1)
  await page.evaluate(() => { (globalThis as unknown as { __held: Held }).__held.hold = false; localStorage.setItem('kixdns:demo-kernel-check-failed', 'true') })
  await page.getByRole('button', { name: '删除 Token', exact: true }).click()
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: 'GitHub Token 已删除' })).toBeVisible()
  await release(page)
  await expect(page.getByRole('button', { name: '检查更新', exact: true })).toBeEnabled()
  await expect(kernelRow.locator('.update-row__from-to')).toContainText('检查失败')
})

test('主页面不会产生视口级横向溢出 @responsive', async ({ page }) => {
  for (const path of ['/', '/config', '/logs', '/diagnostics', '/system']) {
    await open(page, path)
    await expectNoPageOverflow(page)
  }
})
