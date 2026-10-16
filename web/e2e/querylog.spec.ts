import { expect, test, type Page } from '@playwright/test'

// 查询日志页：演示数据按演示配置生成，格式和面板接口一样，页面照样先换成显示用的记录
// The query log page: demo data is generated from the demo config, shaped like the panel API, and the page converts it as it would
// real data

// 演示用的样本配置（上游组、拦截、域名映射都有），日志才有各种去向 / The demo sample config (groups, blocks, mappings), so the
// log has every kind of destination
async function useSampleConfig(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-destinations', 'true'))
}

async function openQueryLog(page: Page, path = '/logs'): Promise<void> {
  await useSampleConfig(page)
  await page.goto(path)
  await expect(page.locator('.qlog-row').first()).toBeVisible()
}

test('日志页先是查询日志：一行一条，点开看概况和处理过程 @responsive', async ({ page }, testInfo) => {
  await openQueryLog(page)
  await expect(page.getByRole('tab', { name: '查询日志' })).toHaveAttribute('aria-selected', 'true')
  await page.locator('.qlog-row').first().click()
  if (testInfo.project.name === 'mobile') {
    const sheet = page.locator('dialog.qlog-sheet[open]')
    await expect(sheet.locator('.qlog-fact')).toHaveCount(3)
    await expect(sheet.locator('.ui-step').last()).toContainText(/回给客户端|没处理完就结束了/)
    return
  }
  const pane = page.locator('.qlog-pane')
  await expect(pane.locator('.qlog-fact')).toHaveCount(3)
  await pane.getByRole('button', { name: '处理过程', exact: true }).click()
  await expect(pane.locator('.ui-step').last()).toContainText(/回给客户端|没处理完就结束了/)
  // 上下键逐条看，Esc 收起 / The arrow keys step through rows, Esc closes
  const first = await page.locator('.qlog-row').first().getAttribute('data-id')
  await page.locator('.qlog-row').first().focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.qlog-row.is-selected')).not.toHaveAttribute('data-id', first!)
  await page.keyboard.press('Escape')
  await expect(pane).toHaveCount(0)
})

test('搜索不分大小写，按去向只看拦截；处理过程不提面板生成的转发规则', async ({ page }) => {
  await openQueryLog(page)
  await page.getByLabel('搜索域名或客户端').fill('GOOGLE')
  await expect(page).toHaveURL(/q=GOOGLE/)
  const names = page.locator('.qlog-row .qlog-c-name')
  await expect(names.first()).toContainText('google')
  for (const name of await names.allTextContents()) expect(name.toLowerCase()).toContain('google')

  await page.getByLabel('搜索域名或客户端').fill('')
  // 搜索框停手 250 毫秒才写回地址栏：等它写完再筛，不然那次重读会把点开的详情收起来
  // The search box writes back to the address bar 250 ms after typing stops: wait for it, or that re-read closes the opened detail
  await expect(page).not.toHaveURL(/q=/)
  await page.getByLabel('按去向筛选').selectOption({ label: '拦截' })
  await expect(page).toHaveURL(/dest=blocked/)
  await expect(page.locator('.qlog-row').first().locator('.qlog-dot')).toHaveClass(/qlog-dot--off/)
  const tones = await page.locator('.qlog-row .qlog-dot').evaluateAll((dots) => dots.map((dot) => dot.className))
  expect(tones.every((tone) => tone.includes('qlog-dot--off'))).toBe(true)
  // 拦截的 HTTPS 查询（空地址只回 A、AAAA 的地址）也算拦截 / A blocked HTTPS query (空地址 answers addresses for A and AAAA only) is still a block
  await page.locator('.qlog-row').first().click()
  await page.locator('.qlog-pane').getByRole('button', { name: '处理过程', exact: true }).click()
  await expect(page.locator('.qlog-pane .ui-step').first()).toContainText('拦截')
  await expect(page.locator('.qlog-pane')).not.toContainText('转发给')
})

test('往下读到漏记的那一段时照实说，有筛选时不出漏记行', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '桌面的列表自己滚')
  await openQueryLog(page)
  const stream = page.locator('.qlog-stream')
  await expect.poll(async () => {
    await stream.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
    return page.locator('.qlog-gap').count()
  }, { timeout: 10_000 }).toBe(1)
  await expect(page.locator('.qlog-gap')).toHaveText('这里漏记了 37 条：KixDNS 当时太忙没记下，或者面板没来得及取走')
  // 一句话放在一个行内元素里：按词切开的几段不会变成并排的几栏 / One sentence in one inline element: the runs cut at words never
  // become side-by-side columns
  expect(await page.locator('.qlog-gap').evaluate((el) => el.children.length)).toBe(1)
  await page.getByLabel('按去向筛选').selectOption({ label: '失败' })
  await expect(page).toHaveURL(/dest=failed/)
  await expect(page.locator('.qlog-gap')).toHaveCount(0)
})

test('一次只往前找那么多：没找到时说查到哪儿了，接着找由人点 @responsive', async ({ page }) => {
  await useSampleConfig(page)
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-querylog-scan-limit', '5'))
  await page.goto('/logs?q=doubleclick')
  const more = page.getByRole('button', { name: '继续往前查' })
  await expect(more).toBeVisible()
  await expect(page.getByText('还没找到符合条件的查询')).toBeVisible()
  await expect(page.getByText('没有符合条件的查询')).toHaveCount(0)
  for (let i = 0; i < 60 && (await page.locator('.qlog-row').count()) === 0; i++) {
    await more.click()
    await expect(page.getByText('正在读取更早的查询')).toHaveCount(0)
  }
  await expect(page.locator('.qlog-row').first()).toContainText('doubleclick')
})

test('设置只有保存多久、最多占用和不记录的域名；清空以后从头记 @responsive', async ({ page }) => {
  await openQueryLog(page)
  await page.getByRole('button', { name: '查询日志设置' }).click()
  const drawer = page.locator('dialog.pdrawer[open]')
  await expect(drawer.getByRole('heading', { name: '查询日志设置' })).toBeVisible()
  await expect(drawer.getByRole('checkbox')).toHaveCount(0)
  await expect(drawer).not.toContainText('只记网段')
  await drawer.getByRole('button', { name: '自定义', exact: true }).click()
  // 刚选「自定义」还没填时不报错；填错了离开那个框才说，框也标红 / No error the moment 自定义 is chosen; a wrong value is said once the field is left, and the field turns red
  await expect(drawer.locator('.ui-field-error')).toHaveCount(0)
  await drawer.getByLabel('保存多少小时').fill('0')
  await drawer.getByLabel('保存多少小时').blur()
  await expect(drawer.locator('#ql-hours-err')).toHaveText('保存多久填 1 到 8760 之间的整数小时')
  await expect(drawer.getByLabel('保存多少小时')).toHaveAttribute('aria-invalid', 'true')
  // 错误不比下面的说明小 / An error is never smaller than the hint below it
  const size = (id: string) => drawer.locator(id).evaluate((el) => getComputedStyle(el).fontSize)
  expect(await size('#ql-hours-err')).toBe(await size('#ql-mb-hint'))
  await drawer.getByRole('button', { name: '保存', exact: true }).click()
  await expect(drawer).toBeVisible()
  // 没保存成：焦点回到有错的框 / Not saved: focus goes back to the wrong field
  await expect(drawer.getByLabel('保存多少小时')).toBeFocused()
  // 服务端不认的域名：说在那个框下面，不悄悄不保存 / A domain the server refuses is said under its field, never a silent no-save
  await drawer.getByLabel('不记录的域名').fill('例子.中国')
  await drawer.getByLabel('不记录的域名').blur()
  await expect(drawer.locator('#ql-ignored-err')).toContainText('xn--')
  await drawer.getByLabel('不记录的域名').fill('ads.example.com, tracker.example.com')
  await drawer.getByLabel('保存多少小时').fill('12')
  await drawer.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '查询日志设置已保存' })).toBeVisible()

  await page.getByRole('button', { name: '查询日志设置' }).click()
  await expect(drawer.getByLabel('保存多少小时')).toHaveValue('12')
  await drawer.getByRole('button', { name: '清空查询日志' }).click()
  await page.locator('dialog.confirm[open]').getByRole('button', { name: '清空查询日志' }).click()
  await expect(page.locator('.toast', { hasText: '查询日志已清空' })).toBeVisible()
  await expect(page.getByText('还没有查询')).toBeVisible()
})

test('内核不支持查询日志：以前记下的照样能看；什么也没有时说去更新内核 @responsive', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-querylog-unsupported', 'true'))
  await openQueryLog(page)
  await expect(page.getByText('当前内核不支持查询日志，下面是以前记下的')).toBeVisible()
  await page.getByRole('button', { name: '查询日志设置' }).click()
  await page.locator('dialog.pdrawer[open]').getByRole('button', { name: '清空查询日志' }).click()
  await page.locator('dialog.confirm[open]').getByRole('button', { name: '清空查询日志' }).click()
  await expect(page.getByText('当前内核不支持查询日志', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '去系统页' })).toBeVisible()
})

test('从概览的上游状态点进来，只看问过这个上游的查询', async ({ page }) => {
  await page.goto('/')
  const jump = page.locator('.overview-card--upstreams a.ov-jump').first()
  const label = (await jump.getAttribute('aria-label'))!
  const upstream = /问过 (\S+) 的查询/.exec(label)![1]!
  await jump.click()
  await expect(page.locator('.qlog-filter')).toContainText(`问过上游 ${upstream}`)
  await expect(page.locator('.qlog-row').first()).toBeVisible()
  await page.locator('.qlog-row').first().click()
  await page.locator('.qlog-pane').getByRole('button', { name: '处理过程', exact: true }).click()
  await expect(page.locator('.qlog-pane .ui-steps')).toContainText(upstream)
})

test('地址栏带着上游组的去向打开：等配置读到再筛，只列这个组的', async ({ page }) => {
  await openQueryLog(page)
  const value = await page.getByLabel('按去向筛选').evaluate((select) => [...(select as HTMLSelectElement).options].find((o) => o.value.startsWith('group:'))!.value)
  const label = await page.getByLabel('按去向筛选').evaluate((select, v) => [...(select as HTMLSelectElement).options].find((o) => o.value === v)!.text, value)
  const group = /「(.+)」/.exec(label)![1]!
  await page.goto(`/logs?dest=${encodeURIComponent(value)}`)
  await expect(page.locator('.qlog-row').first()).toBeVisible()
  for (const dest of await page.locator('.qlog-row .qlog-c-dest > span:first-child').allTextContents()) expect(dest).toBe(group)
})

test('慢的旧读取晚回来也不盖住新的：清空搜索后列表是全部', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '桌面就够')
  await openQueryLog(page)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-read-slow', 'true'))
  await page.getByLabel('搜索域名或客户端').fill('apple')
  await expect(page).toHaveURL(/q=apple/)
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-read-slow'))
  await page.getByLabel('搜索域名或客户端').fill('')
  await expect(page).not.toHaveURL(/q=/)
  await page.waitForTimeout(2500)
  const names = await page.locator('.qlog-row .qlog-c-name').allTextContents()
  expect(names.some((name) => !name.includes('apple'))).toBe(true)
})

test('选中的那条写在地址栏里：去诊断页再回来，详情还开着；Esc 在详情里也能关，焦点回到那一行', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机的详情是整屏，另有用例')
  await openQueryLog(page)
  const row = page.locator('.qlog-row').nth(2)
  const id = (await row.getAttribute('data-id'))!
  await row.click()
  await expect(page).toHaveURL(new RegExp(`id=${id}`))
  await page.locator('.qlog-pane').getByRole('link', { name: '用诊断再测一次' }).click()
  await expect(page).toHaveURL(/diagnostics/)
  await page.goBack()
  await expect(page.locator('.qlog-pane')).toBeVisible()
  await expect(page.locator('.qlog-row.is-selected')).toHaveAttribute('data-id', id)
  await page.locator('.qlog-pane').getByRole('button', { name: '处理过程', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.qlog-pane')).toHaveCount(0)
  await expect(page.locator(`.qlog-row[data-id="${id}"]`)).toBeFocused()
  await expect(page).not.toHaveURL(/id=/)
  // 整张表只有一个 Tab 停点 / The table is a single Tab stop
  expect(await page.locator('.qlog-row[tabindex="0"]').count()).toBe(1)
})

test('没有符合条件的查询：一下清除全部筛选 @responsive', async ({ page }) => {
  await useSampleConfig(page)
  await page.goto('/logs?q=zzzz-nothing&client=192.168.1.8')
  await expect(page.getByText('没有符合条件的查询')).toBeVisible()
  await page.getByRole('button', { name: '清除筛选' }).click()
  await expect(page).not.toHaveURL(/q=|client=/)
  await expect(page.locator('.qlog-row').first()).toBeVisible()
  await expect(page.getByLabel('搜索域名或客户端')).toHaveValue('')
})

test('选中往前读到的那一页里的一条：列表不重读，读到的几页都还在', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '桌面就够')
  await openQueryLog(page)
  const rows = page.locator('.qlog-row')
  const firstPage = await rows.count()
  await page.locator('.qlog-stream').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await expect.poll(() => rows.count()).toBeGreaterThan(firstPage)
  const loaded = await rows.count()
  const row = rows.nth(loaded - 3)
  const id = (await row.getAttribute('data-id'))!
  await row.click()
  await expect(page).toHaveURL(new RegExp(`id=${id}`))
  await page.waitForTimeout(800)
  // 重读会退回到只有第一页；滚到底接着往前读是应该的，所以只会更多 / A reload would drop back to the first page; reading on at the
  // bottom is expected, so the count only grows
  expect(await rows.count()).toBeGreaterThanOrEqual(loaded)
  await expect(page.locator('.qlog-row.is-selected')).toHaveAttribute('data-id', id)
  await expect(page.locator('.qlog-pane')).toBeVisible()
})

test('手机上点开再关掉看得见的那一条：列表不动 @responsive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '手机的整屏详情')
  await openQueryLog(page)
  await page.evaluate(() => window.scrollTo(0, 600))
  const row = page.locator('.qlog-row').nth(12)
  await expect(row).toBeInViewport()
  const before = await page.evaluate(() => window.scrollY)
  await row.click()
  const sheet = page.locator('dialog.qlog-sheet[open]')
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  await page.waitForTimeout(300)
  expect(await page.evaluate(() => window.scrollY)).toBe(before)
  await expect(row).toBeFocused()
})

test('手机上返回先关详情和设置，再返回才离开日志页 @responsive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '只有手机的详情和设置是整屏，记一步历史')
  await useSampleConfig(page)
  await page.goto('/')
  await page.goto('/logs')
  await expect(page.locator('.qlog-row').first()).toBeVisible()
  const sheet = page.locator('dialog.qlog-sheet[open]')

  // 返回手势关详情，留在日志页 / The back gesture closes the detail and stays on the log page
  await page.locator('.qlog-row').first().click()
  await expect(sheet).toBeVisible()
  await expect(page).toHaveURL(/id=/)
  await page.goBack()
  await expect(sheet).toHaveCount(0)
  await expect(page).toHaveURL(/\/logs$/)
  await expect(page.locator('.qlog-row.is-selected')).toHaveCount(0)

  // 点关闭按钮也退掉那一步：之后一次返回就离开日志页 / The close button goes back over that step too: one back afterwards leaves the page
  await page.locator('.qlog-row').nth(1).click()
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  await expect(page).toHaveURL(/\/logs$/)

  // 设置也一样 / The settings the same
  await page.getByRole('button', { name: '查询日志设置' }).click()
  const drawer = page.locator('dialog.qlog-drawer[open]')
  await expect(drawer).toBeVisible()
  await expect(page).toHaveURL(/settings=1/)
  await page.goBack()
  await expect(drawer).toHaveCount(0)
  await expect(page).toHaveURL(/\/logs$/)

  await page.goBack()
  await expect(page).not.toHaveURL(/\/logs/)
})

test('往前翻到更早的一天：日期行吸在表头（手机是顶栏）下面，一直看得到是哪天 @responsive', async ({ page }, testInfo) => {
  // 过了午夜二十分钟：列表里有昨天的记录 / Twenty minutes past midnight: the list holds yesterday's entries
  const now = new Date()
  now.setHours(0, 20, 0, 0)
  await page.clock.install({ time: now })
  await openQueryLog(page)
  const day = page.locator('.qlog-day').first()
  await expect(day).toBeVisible()
  const phone = testInfo.project.name === 'mobile'
  await day.evaluate((el, onPhone) => {
    const by = el.getBoundingClientRect().top + 400
    if (onPhone) window.scrollBy(0, by)
    else el.closest('.qlog-stream')!.scrollBy(0, by)
  }, phone)
  const under = phone ? page.locator('.app-header') : page.locator('.qlog-head')
  await expect.poll(async () => Math.round((await day.boundingBox())!.y - ((await under.boundingBox())!.y + (await under.boundingBox())!.height))).toBe(0)
})

test('手机上按客户端筛选：每条还是两行，域名不被挤成几个字 @responsive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '桌面另有收列的规则')
  await useSampleConfig(page)
  await page.goto('/logs?client=192.168.1.8')
  const row = page.locator('.qlog-row').first()
  await expect(row).toBeVisible()
  const name = await row.locator('.qlog-c-name').boundingBox()
  const time = await row.locator('.qlog-c-time').boundingBox()
  // 时间在右边，域名占住左边剩下的宽度 / The time sits on the right and the domain takes the rest of the left
  expect(name!.width).toBeGreaterThan(200)
  expect(time!.x).toBeGreaterThan(name!.x + name!.width - 1)
  // 第二行不再重复筛着的那个地址 / The second line no longer repeats the filtered address
  await expect(row.locator('.qlog-phone')).not.toContainText('192.168.1.8')
})

const panelDown = (page: Page, down: boolean) => page.evaluate((on) => {
  if (on) localStorage.setItem('kixdns:demo-panel-down', 'true')
  else localStorage.removeItem('kixdns:demo-panel-down')
}, down)

test('手机上从诊断页回来、或者前进回到一条：详情开着，关掉时退回那一步，不留两个一样的 @responsive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '只有手机的详情记一步历史')
  await useSampleConfig(page)
  await page.goto('/')
  await page.goto('/logs')
  const sheet = page.locator('dialog.qlog-sheet[open]')
  await page.locator('.qlog-row').first().click()
  await sheet.getByRole('link', { name: '用诊断再测一次' }).click()
  await expect(page).toHaveURL(/diagnostics/)
  await page.goBack()
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  await expect(page).toHaveURL(/\/logs$/)
  // 关掉以后列表停在那一条 / After closing, the list rests on that entry
  await expect(page.locator('.qlog-row').first()).toBeInViewport()
  // 前进回到那一条：详情跟着开 / Forward onto that entry: the detail opens with it
  await page.goForward()
  await expect(page).toHaveURL(/id=/)
  await expect(sheet).toBeVisible()
  await page.goBack()
  await expect(sheet).toHaveCount(0)
  // 设置也一样：前进回到设置那一步，设置跟着开 / The settings the same: forward onto the settings step opens them
  await page.getByRole('button', { name: '查询日志设置' }).click()
  const drawer = page.locator('dialog.qlog-drawer[open]')
  await expect(drawer).toBeVisible()
  await page.goBack()
  await expect(drawer).toHaveCount(0)
  await page.goForward()
  await expect(page).toHaveURL(/settings=1/)
  await expect(drawer).toBeVisible()
  await page.goBack()
  await expect(drawer).toHaveCount(0)
  // 再返回就离开日志页 / One more back leaves the log page
  await page.goBack()
  await expect(page).not.toHaveURL(/\/logs/)
})

test('窄窗口里表格改成每条两行：域名不被挤成几个字；矮屏幕上开着详情，列表还留着 5 行', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '宽屏的事')
  await page.setViewportSize({ width: 900, height: 900 })
  await openQueryLog(page)
  const stream = page.locator('.qlog-stream')
  await expect(stream).toHaveClass(/is-narrow/)
  await expect(page.locator('.qlog-head')).toBeHidden()
  const row = page.locator('.qlog-row').first()
  await expect(row.locator('.qlog-phone')).toBeVisible()
  const cut = await page.locator('.qlog-row .qlog-c-name .qlog-lit').evaluateAll((names) => names.slice(0, 50).filter((n) => n.scrollWidth > n.clientWidth + 1).length)
  expect(cut).toBe(0)

  // 1024 宽的窗口开着侧栏，列表 728：七列会截断域名，也换成两行 / A 1024 window with the sidebar leaves a 728 list: seven columns would cut
  // domains, so it is two lines too
  await page.setViewportSize({ width: 1024, height: 768 })
  await expect(stream).toHaveClass(/is-narrow/)
  // 详情的三块概况在这一档还是并排，矮的详情里也都看得见 / The detail's three blocks stay side by side in this band, all visible in the
  // short detail
  await page.locator('.qlog-row').nth(1).click()
  const body = (await page.locator('.qlog-pane__body').boundingBox())!
  for (const fact of await page.locator('.qlog-pane .qlog-fact').all()) {
    const box = (await fact.boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(body.y + body.height + 0.5)
  }
  await page.locator('.qlog-pane').getByRole('button', { name: '关闭详情' }).click()

  await page.setViewportSize({ width: 1280, height: 610 })
  await expect(stream).not.toHaveClass(/is-narrow/)
  await page.locator('.qlog-row').nth(2).click()
  const pane = page.locator('.qlog-pane')
  await expect(pane).toBeVisible()
  const list = (await stream.boundingBox())!
  const head = (await page.locator('.qlog-head').boundingBox())!
  expect(list.height - head.height).toBeGreaterThanOrEqual(5 * 32)
  // 详情整个在卡片里，不被裁掉 / The detail sits wholly inside the card, never clipped
  const card = (await page.locator('.log-console.qlog').boundingBox())!
  const box = (await pane.boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(card.y + card.height + 0.5)
})

test('开着详情换了筛选：详情收起；用键盘点「不再记录这个域名」以后焦点在关闭按钮上，Esc 照样能关', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '桌面就够')
  await openQueryLog(page)
  const row = page.locator('.qlog-row').filter({ has: page.locator('.qlog-dot--ok') }).first()
  await row.click()
  await expect(page.locator('.qlog-pane')).toBeVisible()
  await page.getByLabel('按去向筛选').selectOption({ label: '拦截' })
  await expect(page).toHaveURL(/dest=blocked/)
  await expect(page.locator('.qlog-pane')).toHaveCount(0)

  await page.getByLabel('按去向筛选').selectOption({ label: '全部去向' })
  await expect(page).not.toHaveURL(/dest=/)
  await page.locator('.qlog-row').first().click()
  const ignore = page.locator('.qlog-pane').getByRole('button', { name: '不再记录这个域名' })
  await ignore.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.qlog-pane').getByRole('button', { name: '已不记录这个域名' })).toBeDisabled()
  await expect(page.locator('.qlog-pane').getByRole('button', { name: '关闭详情' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('.qlog-pane')).toHaveCount(0)
})

test('连不上面板又连上：开着的第二页那条照旧开着；换了筛选的旧行一直淡着；认不出的去向从地址栏去掉', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '桌面就够')
  test.setTimeout(90_000)
  const banner = page.locator('.conn__inner')
  await openQueryLog(page)
  // 第二页的一条开着，连上以后整个重读：它不在第一页，详情照旧开着 / An entry from page two is open and the reconnect re-reads
  // everything: it is not on page one, and the detail stays open
  const rows = page.locator('.qlog-row')
  const firstPage = await rows.count()
  await page.locator('.qlog-stream').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await expect.poll(() => rows.count()).toBeGreaterThan(firstPage)
  const deep = rows.nth(firstPage + 5)
  const id = (await deep.getAttribute('data-id'))!
  await deep.click()
  await expect(page.locator('.qlog-pane')).toBeVisible()
  await panelDown(page, true)
  await expect(banner).toBeVisible({ timeout: 12_000 })
  await panelDown(page, false)
  await expect(banner).toHaveCount(0, { timeout: 12_000 })
  await expect(page.locator('.qlog-row').first()).toBeVisible()
  await expect(page.locator('.qlog-pane')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`id=${id}`))
  // 整张表还是一个 Tab 停点 / The table is still a single Tab stop
  expect(await page.locator('.qlog-row[tabindex="0"]').count()).toBe(1)

  // 连不上时换筛选：读不到，旧的行淡着、点不了；连上以后是筛过的 / Filters changed while unreachable: the read fails and the old rows
  // stay faded and unclickable; after reconnecting the list is the filtered one
  await panelDown(page, true)
  await page.getByLabel('搜索域名或客户端').fill('apple')
  await expect(page).toHaveURL(/q=apple/)
  await expect(banner).toBeVisible({ timeout: 12_000 })
  await expect(page.locator('.qlog-stream')).toHaveClass(/is-loading/)
  await panelDown(page, false)
  await expect(banner).toHaveCount(0, { timeout: 12_000 })
  await expect(page.locator('.qlog-stream')).not.toHaveClass(/is-loading/)
  for (const name of await page.locator('.qlog-row .qlog-c-name').allTextContents()) expect(name.toLowerCase()).toContain('apple')
  // 筛过的结果全读完了也没有那一条：详情收起 / The filtered result read to the end without that entry: the detail closes
  await expect(page.locator('.qlog-pane')).toHaveCount(0)

  // 连不上时打开一个认不出的去向：连上以后从地址栏去掉 / An unknown destination opened while unreachable leaves the address bar after reconnecting
  await panelDown(page, true)
  await page.goto('/logs?dest=group%3Adeleted')
  await panelDown(page, false)
  await expect(page.locator('.qlog-row').first()).toBeVisible({ timeout: 12_000 })
  await expect(page).not.toHaveURL(/dest=/)
})

test('去掉筛选、一路往前查到底：焦点落在说得通的地方，不掉到设置按钮上', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '键盘的事，桌面就够')
  await useSampleConfig(page)
  await page.goto('/logs?client=192.168.1.8')
  await expect(page.locator('.qlog-row').first()).toBeVisible()
  await page.getByRole('button', { name: '去掉筛选：客户端 192.168.1.8' }).click()
  await expect(page.getByLabel('搜索域名或客户端')).toBeFocused()

  await page.addInitScript(() => localStorage.setItem('kixdns:demo-querylog-scan-limit', '400'))
  await page.goto('/logs?q=zzzz-nothing')
  const more = page.getByRole('button', { name: '继续往前查' })
  for (let i = 0; i < 30 && (await page.getByText('没有符合条件的查询').count()) === 0; i++) {
    await more.click()
    await expect(page.getByText('正在读取更早的查询')).toHaveCount(0)
  }
  await expect(page.getByText('没有符合条件的查询')).toBeVisible()
  await expect(page.getByRole('button', { name: '清除筛选' })).toBeFocused()
})

test('有底栏的矮窗口：点开的详情露出页签，卡片不压在底栏下面，最后一步看得到', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '宽屏的窄窗口')
  await page.setViewportSize({ width: 700, height: 600 })
  await openQueryLog(page)
  await page.locator('.qlog-row').nth(2).click()
  const nav = (await page.locator('.mobile-nav').boundingBox())!
  const bar = (await page.locator('.qlog-pane__bar').boundingBox())!
  expect(bar.y).toBeGreaterThanOrEqual(0)
  expect(bar.y + bar.height).toBeLessThanOrEqual(nav.y)
  await page.locator('.qlog-pane').getByRole('button', { name: '处理过程', exact: true }).click()
  await page.locator('.qlog-pane__body').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const last = (await page.locator('.qlog-pane .ui-step').last().boundingBox())!
  expect(last.y + last.height).toBeLessThanOrEqual(nav.y)
  const card = (await page.locator('.log-console.qlog').boundingBox())!
  expect(card.y + card.height).toBeLessThanOrEqual(nav.y)
})

test('只看这个客户端：开着的那条一定在筛过的结果里，详情照旧开着', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机上这个按钮本来就先收起详情')
  await openQueryLog(page)
  const rows = page.locator('.qlog-row')
  const firstPage = await rows.count()
  await page.locator('.qlog-stream').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await expect.poll(() => rows.count()).toBeGreaterThan(firstPage)
  const deep = rows.nth(firstPage + 100)
  const id = (await deep.getAttribute('data-id'))!
  await deep.click()
  // 筛过的这次只扫最新的 100 条：开着的那条不在读到的第一页里 / The filtered read scans only the newest 100 records, so the open entry is
  // not on the first page read
  await page.evaluate(() => localStorage.setItem('kixdns:demo-querylog-scan-limit', '100'))
  await page.locator('.qlog-pane').getByRole('button', { name: '只看这个客户端' }).click()
  await expect(page).toHaveURL(/client=/)
  await expect(page.getByRole('button', { name: '继续往前查' })).toBeVisible()
  expect(await page.locator(`.qlog-row[data-id="${id}"]`).count()).toBe(0)
  await expect(page.locator('.qlog-pane')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`id=${id}`))
})
