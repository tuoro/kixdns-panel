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
    await expect(sheet.locator('.ui-step').last()).toContainText(/回给客户端|回 SERVFAIL|回答之前请求就没了/)
    return
  }
  const pane = page.locator('.qlog-pane')
  await expect(pane.locator('.qlog-fact')).toHaveCount(3)
  await pane.getByRole('button', { name: '处理过程', exact: true }).click()
  await expect(pane.locator('.ui-step').last()).toContainText(/回给客户端|回 SERVFAIL|回答之前请求就没了/)
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
  await expect(page.locator('.qlog-gap')).toHaveText('这里漏记了 37 条：面板没能从内核取到')
  await page.getByLabel('按去向筛选').selectOption({ label: '失败' })
  await expect(page).toHaveURL(/dest=failed/)
  await expect(page.locator('.qlog-gap')).toHaveCount(0)
})

test('一次只往前找那么多：没找到时说找到哪儿了，接着找由人点 @responsive', async ({ page }) => {
  await useSampleConfig(page)
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-querylog-scan-limit', '5'))
  await page.goto('/logs?q=doubleclick')
  const stopped = page.locator('.qlog-stopped')
  await expect(stopped).toBeVisible()
  await expect(page.getByText('没有符合条件的查询')).toHaveCount(0)
  for (let i = 0; i < 60 && (await page.locator('.qlog-row').count()) === 0; i++) {
    await stopped.getByRole('button', { name: '继续往前找' }).click()
    await expect(page.locator('.qlog-more')).not.toHaveText('正在读取更早的查询')
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
  await drawer.getByLabel('保存多少小时').fill('0')
  await expect(drawer.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await expect(drawer).toContainText('保存时长填 1 到 8760 之间的整数小时')
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
