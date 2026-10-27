import { expect, test } from '@playwright/test'

// 新配置页（?v2=1，③b）：读入演示配置、快速添加一条规则、在右栏（宽屏）或整页（手机）打开、保存并应用。
// 旧配置页的用例在 config-*.spec.ts 里照跑；这一页在 ③d 成为默认前只走 ?v2=1。
// The new config page (?v2=1, ③b): load the demo config, quick-add a rule, open it in the inspector (wide) or full page (phone),
// save with hot reload. The old page's specs keep running; this page is reached only through ?v2=1 until ③d makes it the default.
test('新配置页：读入、快速添加、打开、保存并应用 @responsive', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await page.goto('/config?v2=1')
  await expect(page.locator('main h1')).toHaveText(mobile ? '配置' : '规则')
  // 演示配置只有一条兜底转发：读成一个上游组、零条规则 / The demo config is one catch-all forward: one upstream group, no rules
  await expect(page.locator('.rcard__empty')).toBeVisible()
  await expect(page.getByText('其余请求', { exact: true })).toBeVisible()
  if (!mobile) {
    await expect(page.locator('.cfg__facts')).toContainText('运行中')
    await page.getByRole('button', { name: '快速添加' }).click()
  }
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('example.org www.example.org')
  await expect(page.locator('.qadd__hint')).toContainText('新建一条规则')
  await quick.press('Enter')
  const row = page.locator('[data-rule]').first()
  await expect(row).toContainText('example.org')
  await expect(page.locator('.cfg__savebar')).toContainText('已修改')
  // 打开：宽屏在右栏，手机整页；名字空着时占位是条件本身 / Open it: the inspector on wide screens, the full page on a phone; an unnamed rule's placeholder is its condition
  await row.locator('.rrow__main').click()
  const name = page.getByLabel('规则名称，可以不填，不填就用条件当名字')
  await expect(name).toHaveAttribute('placeholder', /example\.org/)
  await name.fill('示例站点')
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '已更新「示例站点」' })).toBeVisible()
  await expect(row).toContainText('示例站点')
  // 保存：先校验再写入，保存条说「已生效 · 版本 #N」，页头版本跟着变 / Save: validate then write; the bar says 已生效 · 版本 #N and the header version follows
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await expect(page.locator('.cfg__savebar')).toContainText('版本 #')
  if (!mobile) await expect(page.locator('.cfg__facts')).toContainText('1 条')
})

// 测试域名：问的是 KixDNS 正在用的配置（演示里诊断接口固定命中 geosite-global），结论和路径和诊断页同一种写法
// 测试域名 asks the running config (the demo diagnostics endpoint always matches geosite-global); verdict and path read as on the diagnostics page
test('新配置页：测试域名走诊断接口，命中的规则在路径里打勾 @responsive', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await page.goto('/config?v2=1')
  await expect(page.locator('main h1')).toBeVisible()
  await page.getByRole('button', { name: '测试域名', exact: true }).click()
  const tester = page.locator('.tester')
  await expect(tester).toContainText('测的是 KixDNS 正在用的配置')
  await tester.getByLabel('要测试的域名').fill('www.example.com')
  await tester.getByRole('button', { name: '测试', exact: true }).click()
  await expect(tester.locator('.tester__verdict')).toContainText('回答 104.18.26.120')
  await expect(tester.locator('.ui-step--ok')).toContainText('geosite-global')
  // 草稿一改，说明里多一句 / Once the draft changes the hint says so
  if (!mobile) await page.getByRole('button', { name: '快速添加' }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('example.org')
  await quick.press('Enter')
  await expect(tester).toContainText('草稿还没保存')
})

test('新配置页：上游组、域名映射、基础设置三页 @responsive', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  // 上游组：演示配置读成一个组；新建一个组，卡片多一张 / Upstream groups: the demo reads as one group; creating another adds a card
  await page.goto('/config?v2=1&section=upstreams')
  await expect(page.locator('.gcard')).toHaveCount(1)
  await page.getByRole('button', { name: '新建上游组', exact: true }).first().click()
  const drawer = page.locator('dialog[open]').last()
  await drawer.getByLabel('名称', { exact: true }).fill('国内')
  await drawer.getByPlaceholder(/dns-query/).first().fill('223.5.5.5')
  await drawer.getByRole('button', { name: '新建', exact: true }).click()
  await expect(page.locator('.gcard')).toHaveCount(2)
  await expect(page.locator('.cfg__savebar')).toContainText('已修改')
  // 域名映射：加一条，表里出现，类型列说会回什么记录 / Mapping: add one row, it appears with the record type it will answer
  await page.goto('/config?v2=1&section=mapping')
  await page.getByLabel('要映射的域名').fill('nas.home.arpa')
  await page.getByLabel('回答的 IP 或域名').fill('192.168.1.10')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.locator('.rw__row')).toHaveCount(1)
  await expect(page.locator('.rw__row').first()).toContainText('nas.home.arpa')
  await expect(page.locator('.rw__row').first().locator('.rw__k')).toContainText('A')
  // 基础设置：最前面一组「规则默认值」，「默认上游」由「其余请求」接管、不再单独出现 / Settings: 规则默认值 leads; 默认上游 is owned by 其余请求 and no longer listed
  await page.goto('/config?v2=1&section=settings')
  if (mobile) await page.getByRole('button', { name: /规则默认值/ }).click()
  await expect(page.getByText('拦截时怎么回应')).toBeVisible()
  await expect(page.getByText('其余请求', { exact: true })).toBeVisible()
  await expect(page.getByLabel('默认上游', { exact: true })).toHaveCount(0)
})

test('新配置页：历史版本能打开、比较和看到当前版本', async ({ page }) => {
  await page.goto('/config?v2=1')
  await expect(page.locator('main h1')).toBeVisible()
  await page.getByRole('button', { name: '更多配置操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '历史版本', exact: true }).click()
  const drawer = page.locator('.hist')
  await expect(drawer).toBeVisible()
  await expect(drawer.locator('.hist__row.is-current')).toHaveCount(1)
  const other = drawer.locator('.hist__row:not(.is-current)').first()
  await other.locator('.hist__main').click()
  await expect(page.locator('.diffd')).toBeVisible()
  await expect(page.locator('.diffd').locator('#diff-title')).toContainText('#')
})

// 第一次装好、KixDNS 还没启动时，「启动」是最要紧的一步：页头里是一个小号次要按钮（不是一行下划线字），比字高也不撑高那一行；
// 连不上面板时收起（按了也只会失败），页头写「状态未知」，连上后回来
// Freshly installed with KixDNS not started, 启动 is the step that matters most: a small secondary button in the header (not a line of
// underlined text) that never heightens its line though it is taller than the text; withdrawn while the panel is unreachable (pressing it
// could only fail), the header reading 状态未知, and back on reconnect
test('页头的「启动」是小号次要按钮，不撑高那一行；连不上面板时收起 @responsive', async ({ page, context }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-empty-first-install', 'true'))
  await page.goto('/config')
  const status = mobile ? page.locator('.ui-ph__lead') : page.locator('.cfg__facts > span').first()
  // 手机写全「KixDNS 已停止」，宽屏「状态」标签下面只写「已停止」 / Phones say KixDNS 已停止 in full; under the wide 状态 label it reads 已停止
  await expect(mobile ? status : status.locator('b')).toContainText(mobile ? 'KixDNS 已停止' : '已停止')
  const start = status.getByRole('button', { name: '启动', exact: true })
  await expect(start).toBeVisible()
  await expect(start).toHaveClass(/ui-btn--secondary/)
  await expect(start).toHaveClass(/ui-btn--sm/)
  // 按钮所在的那一行比按钮矮：按钮没有把它撑高；宽屏同一排的事实仍一样高
  // The line holding the button is shorter than the button: it did not heighten it; on wide screens the facts in the row stay one height
  const line = mobile ? status : status.locator('b')
  const lineHeight = (await line.boundingBox())!.height
  expect(lineHeight).toBeLessThan((await start.boundingBox())!.height)
  if (!mobile) {
    const heights = await page.locator('.cfg__facts > span').evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)))
    expect(new Set(heights).size).toBe(1)
  }
  await context.setOffline(true)
  await expect(page.locator('.conn__inner')).toBeVisible()
  if (mobile) await expect(status).toContainText('状态未知')
  else await expect(status.locator('b')).toHaveText('未知')
  await expect(start).toHaveCount(0)
  await context.setOffline(false)
  await expect(page.locator('.conn__inner')).toHaveCount(0)
  // 手机写全「KixDNS 已停止」，宽屏「状态」标签下面只写「已停止」 / Phones say KixDNS 已停止 in full; under the wide 状态 label it reads 已停止
  await expect(mobile ? status : status.locator('b')).toContainText(mobile ? 'KixDNS 已停止' : '已停止')
  await expect(start).toBeVisible()
})

// 手机上「规则组」区块头：标题和「新建规则组」一行、上下居中，说明在下面占满整行，「转到规则组」不拆成两行
// Phone 规则组 head: the title and 新建规则组 share one line, centred; the description runs full width below, and 转到规则组 stays on one line
test('手机上「规则组」的说明在标题和按钮下面占满整行 @responsive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '只看手机的版式')
  await page.goto('/config')
  // 没有规则组时只有一行，先建一个，区块头才出来 / With no rule groups there is only a line; create one so the section head shows
  await page.locator('.rgroups__line').getByRole('button', { name: '新建规则组', exact: true }).click()
  await page.locator('dialog.pdialog[open]').getByPlaceholder('比如：内网解析').fill('孩子的设备')
  await page.locator('dialog.pdialog[open]').getByRole('button', { name: '新建', exact: true }).click()
  const head = page.locator('.rgroups__head')
  await head.scrollIntoViewIfNeeded()
  const box = async (locator: ReturnType<typeof page.locator>) => (await locator.boundingBox())!
  const whole = await box(head)
  const title = await box(head.locator('.rgroups__title'))
  const desc = await box(head.locator('.rgroups__desc'))
  const button = await box(head.getByRole('button', { name: '新建规则组' }))
  expect(desc.y).toBeGreaterThanOrEqual(button.y + button.height - 0.5)
  expect(Math.round(desc.width)).toBe(Math.round(whole.width))
  expect(Math.abs(title.y + title.height / 2 - (button.y + button.height / 2))).toBeLessThanOrEqual(1)
  const phraseLines = await head.locator('.rgroups__desc').evaluate((element) => {
    const text = element.firstChild!
    const at = text.textContent!.indexOf('「转到规则组」')
    const range = document.createRange()
    range.setStart(text, at)
    range.setEnd(text, at + '「转到规则组」'.length)
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size
  })
  expect(phraseLines).toBe(1)
})

// KixDNS 停着、又有待应用的版本：页头先说停了，再说哪个版本在等，「启动」跟在后面读作启动 KixDNS
// KixDNS stopped with a version waiting: the header first says it is stopped, then which version waits, so the 启动 after it reads as starting KixDNS
test('KixDNS 停着时存成待应用：页头先说停了再说哪个版本在等（手机「KixDNS 已停止 · 版本 #N 待应用」） @responsive', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-empty-first-install', 'true'))
  await page.goto('/config')
  if (!mobile) await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('stopped.example.org')
  await quick.press('Enter')
  await page.getByRole('button', { name: '保存为待应用', exact: true }).click()
  const status = mobile ? page.locator('.ui-ph__lead') : page.locator('.cfg__facts > span').first().locator('b')
  // 宽屏的版本号在旁边的「配置版本」里，状态只写「已停止 · 待应用」，一排放得下 / On wide screens the version sits in the 配置版本 fact beside it, so the state reads 已停止 · 待应用 and the row fits
  if (mobile) await expect(status).toContainText(/KixDNS 已停止\s*·?\s*版本 #\d+ 待应用/)
  else {
    await expect(status).toContainText(/^已停止\s*·?\s*待应用/)
    await expect(page.locator('.cfg__facts')).toContainText(/配置版本\s*#\d+/)
  }
  await expect(status.getByRole('button', { name: '启动', exact: true })).toBeVisible()
})

// 641–679（横放的手机）和 861–876 停着又有待应用版本时，页头一行放得下：放不下的事实先收起，不折成两行
// At 641–679 (landscape phones) and 861–876, stopped with a pending version, the header stays one line: facts that do not fit give way instead of wrapping
test('停着又有待应用版本：窄一点的宽度下配置页、系统页页头也只有一行', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '只看 641 以上的页头')
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-empty-first-install', 'true'))
  await page.goto('/config')
  await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('narrow.example.org')
  await quick.press('Enter')
  await page.getByRole('button', { name: '保存为待应用', exact: true }).click()
  await expect(page.locator('.cfg__facts')).toContainText(/待应用/)
  const headHeight = () => page.locator('main .ui-ph').first().evaluate((el) => Math.round(el.getBoundingClientRect().height))
  for (const width of [667, 641, 870]) {
    await page.setViewportSize({ width, height: 800 })
    await expect.poll(headHeight).toBeLessThan(90)
  }
  await page.setViewportSize({ width: 650, height: 800 })
  await page.getByRole('link', { name: '系统', exact: true }).first().click()
  await expect(page.locator('.system-facts')).toBeVisible()
  await expect.poll(headHeight).toBeLessThan(90)
})

// 保存途中又加的规则不在这次保存里：保存落地后它的「撤销」照样留着；保存之前那条的撤销收起（撤回去会改掉刚保存的东西）
// A rule added during a save is not part of it: its 撤销 stays after the save lands, while the earlier rule's undo goes (undoing would change what was just saved)
test('保存途中又改的那一处，保存落地后「撤销」还在', async ({ page }) => {
  await page.goto('/config')
  await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('first.example.org')
  await quick.press('Enter')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-slow', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  // 等保存真的发出去（写入那一步慢 1.5 秒）再改 / Edit only once the save is under way (the write step takes 1.5 s)
  await expect(bar).toContainText('保存中')
  await quick.fill('later.example.org')
  await quick.press('Enter')
  await expect(bar).toContainText('之后改的 1 处还没保存', { timeout: 10_000 })
  await expect(page.locator('.toast', { hasText: 'later.example.org' }).getByRole('button', { name: '撤销' })).toBeVisible()
  // 第一条的提示是「已添加规则」；合并进来的那条写的是「已加到「…」」 / The first rule's toast reads 已添加规则; the merged one reads 已加到「…」
  await expect(page.locator('.toast', { hasText: '已添加规则' })).toHaveCount(0)
})

// 同一个上游，概览和上游组卡片用同一种算法：时段、成功率、次数都一样（以前上游组卡片用累计数和旧分母，同一个「最近一小时」写两个成功率）
// One upstream, one rule on both pages: the overview and the group card show the same period, success rate and count (the card used lifetime counts and the old denominator, so one 最近一小时 carried two rates)
test('上游组卡片和概览的上游状态写同一个成功率', async ({ page }) => {
  await page.goto('/')
  const row = page.locator('.overview-card--upstreams .overview-row', { hasText: '1.1.1.1:53' })
  const overview = (await row.locator('.overview-row-sub').innerText()).replace(/\s+/g, ' ')
  const rate = /成功率 ([\d.]+%)/.exec(overview)![1]
  const count = /([\d,]+) 次响应/.exec(overview)![1]
  await page.goto('/config?section=upstreams')
  // 演示里「default」只有 1.1.1.1:53 一个地址 / In the demo, default has the single address 1.1.1.1:53
  const card = page.locator('.gcard', { has: page.getByRole('button', { name: 'default', exact: true }) })
  await expect(card.locator('.gcard__health')).toContainText(`成功率 ${rate}`)
  await expect(card.locator('.gcard__health')).toContainText(`最近一小时 ${count}`)
})

// 手机保存条：「校验通过」不压到按钮；冲突时不留灰掉的保存和备注，「下载草稿」和上面的说明左对齐
// Phone save bar: 校验通过 never runs under the buttons; a conflict keeps no greyed save or 备注, and 下载草稿 lines up with the text above
test('手机保存条：校验通过不压按钮，冲突时只留下载和重新读取 @responsive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '只看手机的保存条')
  await page.goto('/config')
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('bar.example.org')
  await quick.press('Enter')
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '校验', exact: true }).click()
  await expect(bar.locator('.ui-savebar__status')).toContainText('校验通过')
  // 量字本身占到哪里（元素自己的框在字溢出时不跟着变宽） / Measure where the words themselves reach (the element's own box does not grow when the text overflows)
  const textRight = await bar.locator('.ui-savebar__detail').evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    return range.getBoundingClientRect().right
  })
  const firstButton = await bar.locator('.savebar__note-toggle').evaluate((el) => el.getBoundingClientRect().left)
  expect(textRight).toBeLessThanOrEqual(firstButton)

  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-conflict', 'true'))
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('这份配置在别处改过了')
  await expect(bar.getByRole('button', { name: '保存并应用' })).toHaveCount(0)
  await expect(bar.locator('.savebar__note-toggle')).toHaveCount(0)
  // 失败时这一行会晃一下：等晃完，两处在同一刻量（分两次量，忙的时候会各量到晃动的不同位置） / The line shakes on failure: wait for it to end and measure
  // both at the same moment (measured apart, a busy run caught them at different points of the shake)
  const { words, download } = await bar.locator('.ui-savebar__status').evaluate(async (status) => {
    await Promise.all(status.getAnimations({ subtree: true }).map((animation) => animation.finished))
    const range = document.createRange()
    range.selectNodeContents([...status.querySelectorAll('button')].find((b) => b.textContent?.includes('下载草稿'))!)
    return { words: status.querySelector('small')!.getBoundingClientRect().left, download: range.getBoundingClientRect().left }
  })
  expect(Math.abs(download - words)).toBeLessThanOrEqual(1)
})

// 侧栏版最窄的一段（861–909）「校验通过」只写这四个字：「· 可以保存」会把「保存并应用」挤出屏幕；910 起放得下就写全
// In the narrowest sidebar band (861–909) the bar says just 校验通过: 「· 可以保存」 pushed 保存并应用 off screen; from 910 there is room for the whole line
test('侧栏版最窄时，校验通过的保存条不把按钮挤出屏幕', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '只看 861 以上的保存条')
  await page.setViewportSize({ width: 861, height: 800 })
  await page.goto('/config')
  await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('narrow.example.org')
  await quick.press('Enter')
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '校验', exact: true }).click()
  await expect(bar.locator('.ui-savebar__status')).toContainText('校验通过')
  for (const width of [861, 909, 910]) {
    await page.setViewportSize({ width, height: 800 })
    await expect(bar.locator('.ui-savebar__status')).toContainText(width >= 910 ? '可以保存' : '校验通过')
    if (width < 910) await expect(bar.locator('.ui-savebar__status')).not.toContainText('可以保存')
    const save = (await bar.getByRole('button', { name: '保存并应用' }).boundingBox())!
    expect(save.x + save.width, `${width}`).toBeLessThanOrEqual(width)
  }
})

// 手机上提示条的按钮在字下面单独一行，不压住字（只有一行字的提示条也一样）
// On phones a notice's button has its own row under the text and never covers it (one-line notices included)
test('手机上提示条的按钮不压住字 @responsive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '只看手机的提示条')
  await page.goto('/config')
  await expect(page.locator('.rcard').first()).toBeVisible()
  const config = { version: '1.0', settings: {}, pipeline_select: [{ pipeline: 'main', matchers: [] }], pipelines: [{ id: 'main', rules: [{ name: 'g', matchers: [{ type: 'geo_site', value: 'geosite:cn' }], actions: [{ type: 'deny' }] }] }] }
  await page.locator('input[type="file"]').setInputFiles({ name: 'prefixed.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(config)) })
  if (await page.locator('dialog[open]').count()) await page.keyboard.press('Escape')
  const notice = page.locator('.cfg__notice')
  await expect(notice.getByRole('button', { name: '去掉前缀' })).toBeVisible()
  const overlap = await notice.evaluate((box) => {
    const text = box.querySelector(':scope > span')!.getBoundingClientRect()
    const button = box.querySelector('.ui-notice__action')!.getBoundingClientRect()
    return Math.min(text.bottom, button.bottom) - Math.max(text.top, button.top) > 0 && Math.min(text.right, button.right) - Math.max(text.left, button.left) > 0
  })
  expect(overlap).toBe(false)
})

// 手机上规则行、映射行的「…」和开关在同一行并排，点按区都到 44、互不压住（以前「…」在开关正下方，只隔 28，点开关偏下一点就打开了菜单）
// On phones a rule or mapping row has 「…」 and the switch side by side on one line, each with a 44 tap area that does not cover the other
// (「…」 used to sit right under the switch, 28 apart, so a tap a little low on the switch opened the menu)
test('手机上行里的「…」和开关并排，点按区各 44 @responsive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '只看手机的行')
  // 从按钮中心往四个方向走，量出点得到它的范围 / Walk out from the control's centre in four directions to measure where it can be tapped
  const reach = (rowSelector: string, switchSelector: string, menuSelector: string) => page.evaluate(([rowSelector, switchSelector, menuSelector]) => {
    const row = document.querySelector(rowSelector)!
    const measure = (el: Element) => {
      const box = el.getBoundingClientRect()
      const cx = box.left + box.width / 2
      const cy = box.top + box.height / 2
      const hits = (x: number, y: number) => { const at = document.elementFromPoint(x, y); return at !== null && (at === el || el.contains(at) || at.contains(el) && at.tagName === 'LABEL') }
      let top = cy, bottom = cy, left = cx, right = cx
      while (hits(cx, top - 1) && top > cy - 40) top--
      while (hits(cx, bottom + 1) && bottom < cy + 40) bottom++
      while (hits(left - 1, cy) && left > cx - 40) left--
      while (hits(right + 1, cy) && right < cx + 40) right++
      return { cy, width: right - left + 1, height: bottom - top + 1 }
    }
    return { toggle: measure(row.querySelector(switchSelector)!), menu: measure(row.querySelector(menuSelector)!) }
  }, [rowSelector, switchSelector, menuSelector])

  await page.goto('/config')
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('row.example.org')
  await quick.press('Enter')
  const rule = await reach('[data-rule]', '.rrow__switch input', '.rrow__menu .ui-icon-btn')
  await page.goto('/config?section=mapping')
  await page.getByLabel('要映射的域名').fill('row.home.arpa')
  await page.getByLabel('回答的 IP 或域名').fill('192.168.1.40')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  const mapping = await reach('[data-rw]', '.ui-switch input', '.ui-menu-host .ui-icon-btn')
  // 点域名进编辑：为了省略号裁掉的溢出不能把点按区域也裁成 20 高 / Tapping the domain to edit: the overflow clipped for the ellipsis must not clip the tap area to 20 as well
  const domain = await reach('[data-rw]', '.rw__d', '.rw__d')
  expect(domain.toggle.height).toBeGreaterThanOrEqual(44)
  for (const { toggle, menu } of [rule, mapping]) {
    expect(Math.abs(toggle.cy - menu.cy)).toBeLessThan(2)
    for (const area of [toggle, menu]) {
      expect(area.width).toBeGreaterThanOrEqual(44)
      expect(area.height).toBeGreaterThanOrEqual(44)
    }
  }
})

// 手机上规则行、映射行整行都能点进编辑：第二行（结果、回答）以前点了没反应 / On phones a rule or mapping row opens the editor anywhere: the second line (outcome, answer) used to do nothing
test('手机上点规则行、映射行的第二行也能进编辑 @responsive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '只看手机的行')
  await page.goto('/config')
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('second-line.example.org')
  await quick.press('Enter')
  // 像手指一样点第二行那个位置（那里接住点击的是整行的点击区） / Tap the second line's spot as a finger would (the row's hit area takes it there)
  const tapCentre = async (locator: ReturnType<typeof page.locator>) => { const box = (await locator.boundingBox())!; await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2) }
  await tapCentre(page.locator('[data-rule]', { hasText: 'second-line.example.org' }).locator(':scope > .rrow__pill'))
  await expect(page).toHaveURL(/rule=/)
  await page.goBack()
  await page.goto('/config?section=mapping')
  await page.getByLabel('要映射的域名').fill('line.home.arpa')
  await page.getByLabel('回答的 IP 或域名').fill('192.168.1.50')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await tapCentre(page.locator('[data-rw]', { hasText: 'line.home.arpa' }).locator('.rw__t'))
  await expect(page.locator('.rw__edit')).toBeVisible()
})

// 上游组的 ECS 说明跟着所选方式说：固定子网对内网客户端也发（内核 apply_ecs），只有「发送客户端所在子网」跳过内网
// The group's ECS hint follows the choice: a fixed subnet is sent for LAN clients too (kernel apply_ecs); only 发送客户端所在子网 skips them
test('上游组的子网说明跟着所选方式说', async ({ page }) => {
  await page.goto('/config?section=upstreams')
  await page.locator('.gcard__name').first().click()
  const select = page.getByLabel('客户端子网', { exact: true })
  const hint = page.locator('.pfield:has(select[aria-label="客户端子网"]) .pfield__hint')
  await select.selectOption({ label: '发送固定的子网' })
  await expect(hint).toHaveText('每个请求都带上这个子网，内网客户端也一样。')
  await select.selectOption({ label: '发送客户端所在子网' })
  await expect(hint).toHaveText('发送子网能让国内 CDN 回离客户端近的地址；内网客户端的请求不带子网。')
})

// 「不检查」时没有「这一步」：超时的说明直接说会怎样 / Under 不检查 there is no step to skip: the timeout note says what happens
test('回答后不检查时，超时的说明不提「这一步」', async ({ page }) => {
  await page.goto('/config')
  await page.getByRole('button', { name: '新建规则', exact: true }).first().click()
  // 宽屏的右侧面板里这一段默认收着 / In the wide side panel this section starts folded
  await page.locator('.editor').getByRole('button', { name: '回答后检查', exact: true }).click()
  await page.getByRole('group', { name: '回答后检查' }).getByRole('button', { name: '不检查' }).click()
  const note = page.locator('.after__limit')
  await expect(note).toHaveText('上游全部超时或连不上时：开了「过期后继续用旧结果」先回旧结果，没有就回 SERVFAIL。')
})

// 停用的行调淡以后，第二行也照样点得进编辑（调淡的部分以前盖在整行的点按区上面） / Disabled rows still open from their second line (the dimmed parts used to sit above the row's hit area)
test('手机上停用的规则行、映射行，点第二行也能进编辑 @responsive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '只看手机的行')
  await page.goto('/config')
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('off-line.example.org')
  await quick.press('Enter')
  const tapCentre = async (locator: ReturnType<typeof page.locator>) => { const box = (await locator.boundingBox())!; await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2) }
  const row = page.locator('[data-rule]', { hasText: 'off-line.example.org' })
  await row.locator('.rrow__switch').click()
  await expect(row).toHaveClass(/is-off/)
  await tapCentre(row.locator(':scope > .rrow__pill'))
  await expect(page).toHaveURL(/rule=/)
  await page.goBack()
  await page.goto('/config?section=mapping')
  await page.getByLabel('要映射的域名').fill('off.home.arpa')
  await page.getByLabel('回答的 IP 或域名').fill('192.168.1.51')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  const mapping = page.locator('[data-rw]', { hasText: 'off.home.arpa' })
  await mapping.locator('.ui-switch').click()
  await expect(mapping).toHaveClass(/is-off/)
  await tapCentre(mapping.locator('.rw__t'))
  await expect(page.locator('.rw__edit')).toBeVisible()
})

// 保存途中状态会变长（「第 2 步 · 写入并应用 · 已用 N 秒」）：最窄的侧栏宽度下「保存中」也不被挤出屏幕；手机上状态前的转圈是圆的，不被挤扁
// The status grows during a save (第 2 步 · 写入并应用 · 已用 N 秒): at the narrowest sidebar width 保存中 stays on screen; on phones the status spinner stays round
test('保存途中的保存条：按钮不出屏，转圈不变形 @responsive', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  if (!mobile) await page.setViewportSize({ width: 861, height: 800 })
  await page.goto('/config')
  await expect(page.locator('.cfg__panel')).toBeVisible()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  if (!(await quick.isVisible())) await page.getByRole('button', { name: '快速添加', exact: true }).click()
  await quick.fill('inflight.example.org')
  await quick.press('Enter')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', 'true'); localStorage.setItem('kixdns:demo-validate-slow', 'true') })
  const bar = page.locator('.cfg__savebar')
  await bar.locator('.savebar__save').click()
  // 等进到第 2 步再量（这一步稳定 1.5 秒）：从第 1 步换过去的那一下状态会重画，转圈换成新的元素
  // Measure once in step 2 (steady for 1.5 s): switching from step 1 redraws the status and the spinner becomes a new element
  await expect(bar.locator('.ui-savebar__status')).toContainText(/写入并应用.*已用/, { timeout: 5000 })
  const width = page.viewportSize()!.width
  const save = (await bar.locator('.savebar__save').boundingBox())!
  expect(save.x + save.width).toBeLessThanOrEqual(width)
  const spinner = bar.locator('.ui-savebar__status .ui-spin')
  await expect(spinner).toBeVisible()
  const spin = (await spinner.boundingBox())!
  expect(Math.round(spin.width)).toBe(Math.round(spin.height))
  await page.evaluate(() => { localStorage.removeItem('kixdns:demo-save-slow'); localStorage.removeItem('kixdns:demo-validate-slow') })
})

// 内核不支持 CNAME 时，提示说出写成域名的是哪几条规则：前两条点名、点了打开那条，多的写「等 N 条」
// With CNAME unsupported, the notice names the rules whose answers are domains: the first two by name, opening that rule on click, the rest as 「等 N 条」
test('内核不支持 CNAME 时，提示点名写成域名的规则', async ({ page }) => {
  await page.goto('/config')
  await expect(page.locator('.cfg__panel')).toBeVisible()
  await page.evaluate(async () => {
    const url = (part: string) => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes(part)).pop()!
    const store = await import(url('/src/config-v2/store.ts'))
    const models = await import(url('/src/config-model/model.ts'))
    const document = await import(url('/src/config-v2/useConfigDocument.ts'))
    for (const name of ['a', 'b', 'c']) {
      const rule = models.newRule(store.newId(), { type: 'answer', kind: 'cname', value: `${name}.cdn.example.net`, ttl: null })
      rule.conditions = [[{ id: store.newId(), field: 'domain', values: [`${name}.example.com`], negate: false, regex: false }]]
      store.model.rules.push(rule)
    }
    document.runtimeCapabilities.value = document.runtimeCapabilities.value.filter((c: string) => c !== 'config_static_cname_response_v1')
  })
  const notice = page.locator('.cfg__notice')
  // 名字两头的引号用连接符粘着，比文字时先去掉（连同不换行空格） / The quotes are glued to the names with word joiners, removed (with no-break spaces) before comparing
  const plain = () => notice.evaluate((el) => el.textContent!.replace(/\u2060/g, '').replace(/\u00a0/g, ' '))
  await expect.poll(plain).toContain('写成域名的有：规则「域名属于 a.example.com」「域名属于 b.example.com」等 3 条')
  await notice.getByRole('link', { name: '域名属于 b.example.com' }).click()
  await expect(page.locator('.editor')).toBeVisible()
  await expect(page.locator('.editor')).toContainText('b.example.com')
  await expect(page.locator('.editor')).toContainText('这条选了 CNAME')
})

// 起了名字的规则只在「回答后检查」里回答域名，也点得到它；一条规则拆成两组条件只算一处，上面的条数和下面点名的对得上
// A named rule whose 回答后检查 answers with a domain is named too; a rule split into two condition groups counts once, so the count above matches the names below
test('CNAME 提示：回答后检查里的也点名，拆开的规则只算一处', async ({ page }) => {
  await page.goto('/config')
  await expect(page.locator('.cfg__panel')).toBeVisible()
  await page.evaluate(async () => {
    const url = (part: string) => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes(part)).pop()!
    const store = await import(url('/src/config-v2/store.ts'))
    const models = await import(url('/src/config-model/model.ts'))
    const document = await import(url('/src/config-v2/useConfigDocument.ts'))
    const domain = (value: string) => ({ id: store.newId(), field: 'domain', values: [value], negate: false, regex: false })
    const split = models.newRule(store.newId(), { type: 'answer', kind: 'cname', value: 'split.cdn.example.net', ttl: null })
    split.name = '两组条件'
    split.conditions = [[domain('one.example.com')], [domain('two.example.com')]]
    const checked = models.newRule(store.newId(), { type: 'upstream', group: store.model.groups[0].id })
    checked.name = '异常时回 CDN'
    checked.conditions = [[domain('check.example.com')]]
    checked.response = { ...checked.response, mode: 'custom', conditions: [{ id: store.newId(), field: 'rcode', negate: false, values: ['SERVFAIL'] }], then: { type: 'answer', kind: 'cname', value: 'fallback.cdn.example.net', ttl: null } }
    store.model.rules.push(split, checked)
    document.runtimeCapabilities.value = document.runtimeCapabilities.value.filter((c: string) => c !== 'config_static_cname_response_v1')
  })
  const notice = page.locator('.cfg__notice')
  await expect(notice).toContainText('有 2 处回答写的是域名')
  await expect(notice.getByRole('link', { name: '两组条件' })).toBeVisible()
  await expect(notice.getByRole('link', { name: '异常时回 CDN' })).toBeVisible()
  await notice.getByRole('link', { name: '异常时回 CDN' }).click()
  await expect(page.locator('.editor')).toBeVisible()
  await expect(page.locator('.editor')).toContainText('check.example.com')
})
