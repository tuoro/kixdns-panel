import { expect, test, type Page } from '@playwright/test'

// 在线更新失败时，系统页要说清失败原因，并能手动收起。
// When an online update fails, the system page states the reason and lets the user dismiss it.

async function openSystemWithFailedUpdate(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-panel-update-failed', 'true'))
  await page.goto('/system')
  await expect(page.locator('.app-shell')).toBeVisible()
}

test('在线更新失败时显示具体原因，收起后刷新也不再出现 @responsive', async ({ page }) => {
  await openSystemWithFailedUpdate(page)

  // 回归：有可用更新时标题行只显示版本变化，失败原因根本看不到，也无法收起。
  // Regression: with an update available the title line showed only the version change, so the
  // failure reason was never visible and could not be dismissed.
  const panelRow = page.locator('.update-row').nth(1)
  await expect(panelRow.locator('.update-row__from-to')).toContainText('v1.0.0 → v1.0.1')
  const failure = panelRow.locator('.update-row__failure')
  await expect(failure).toContainText('在线更新失败：下载安装包失败，面板还是原来的版本。检查网络后再点一次在线更新')
  await expect(panelRow.getByRole('button', { name: '在线更新' })).toBeEnabled()

  // 手机宽度下原因和按钮都在行内，不撑出横向滚动。
  // At phone width the reason and the button stay inside the row without a horizontal scroll.
  const sizes = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.clientWidth)
  const rowBox = await panelRow.boundingBox()
  const dismissBox = await failure.getByRole('button', { name: '知道了' }).boundingBox()
  expect(rowBox && dismissBox).toBeTruthy()
  expect(dismissBox!.x + dismissBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width)

  await failure.getByRole('button', { name: '知道了' }).click()
  await expect(panelRow.locator('.update-row__failure')).toHaveCount(0)

  await page.reload()
  await expect(page.locator('.app-shell')).toBeVisible()
  await expect(page.locator('.update-row').nth(1).locator('.update-row__from-to')).toContainText('v1.0.0 → v1.0.1')
  await expect(page.locator('.update-row__failure')).toHaveCount(0)
})

// 打开页面时检查更新失败（网络不通），之后点「检查更新」取到了新内核：「更新」按钮要能点，不用刷新网页。
// 按钮装的是单独读来的内核状态里的最新版本，以前只重新检查更新、不重读内核，按钮一直灰着
// The update check failed when the page opened (no network), and 检查更新 later found a new kernel: 更新 must
// be clickable without reloading the page. The button installs the latest version from the kernel status read on
// its own, which used not to be read again after the check, so the button stayed grey
test('第一次检查更新失败，点检查更新取到新内核后「更新」按钮能点 @responsive', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-kernel-check-failed', 'true'))
  await page.goto('/system')
  const kernelRow = page.locator('.update-row').first()
  await expect(kernelRow.locator('.update-row__from-to')).toContainText('检查失败')

  // 网络恢复 / The network comes back
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-kernel-check-failed'))
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await expect(kernelRow.getByText('有新版本')).toBeVisible()
  await expect(kernelRow.getByRole('button', { name: '更新', exact: true })).toBeEnabled()
})

// 在线更新进行中离开系统页：还在路上的读取回来以后不再排下一次查询，别的页上不再查、不弹提示、不刷新。五种情形：打开时第一次读状态、
// 2 秒一次的查询（还在更新、更新失败、读不到且已过了 30 分钟）、更新完成后确认面板活着的那一次
// Leaving the system page during an online update: a read still on its way schedules no further query when it lands, so other pages
// see no more queries, toasts or reloads. Five cases: the first status read on opening, the 2-second query (still updating, failed,
// unreadable with 30 minutes gone) and the check that the panel is alive after completion
for (const how of ['status', 'downloading', 'failed', 'lost', 'complete'] as const) {
  test(`在线更新进行中离开系统页：还在路上的读取回来以后不再接着查（${how}）`, async ({ page }) => {
    await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
      if (route.request().url().includes('update-poll-original')) return route.continue()
      await route.fulfill({ contentType: 'application/javascript', body: `
        export * from '/src/api/client.ts?update-poll-original';
        import { apiRequest as original } from '/src/api/client.ts?update-poll-original';
        const state = globalThis.__update = { sent: 0, hold: ${how === 'status'}, held: [], answer: 'downloading', holdHealth: false };
        export async function apiRequest(path, init) {
          if (path === '/api/v1/health' && state.holdHealth) { await new Promise((resolve) => state.held.push(resolve)); return { status: 'ok' }; }
          if (path !== '/api/v1/panel-update' || (init && init.method && init.method !== 'GET')) return original(path, init);
          state.sent += 1;
          if (state.hold) await new Promise((resolve) => state.held.push(resolve));
          if (state.answer === 'throw') throw new Error('连不上面板');
          return { state: state.answer, message: '', target_version: 'v1.0.1', updated_at: Math.floor(Date.now() / 1000) };
        }
      ` })
    })
    type Update = { sent: number; hold: boolean; held: (() => void)[]; answer: string; holdHealth: boolean }
    const update = () => page.evaluate(() => (globalThis as unknown as { __update: Update }).__update)
    await page.clock.install()
    await page.goto('/system')
    if (how === 'status') {
      await expect.poll(async () => (await update()).held.length).toBe(1)
    } else {
      await expect(page.getByText('面板正在在线更新').first()).toBeVisible()
      // 页面时钟停住：只有 runFor 才往前走 / The page clock stands still: only runFor moves it
      await page.clock.pauseAt(Date.now() + 1_000)
      await page.evaluate((complete) => {
        const state = (globalThis as unknown as { __update: Update }).__update
        if (complete) { state.answer = 'complete'; state.holdHealth = true } else state.hold = true
      }, how === 'complete')
      await page.clock.runFor(2_000)
      await expect.poll(async () => (await update()).held.length).toBe(1)
    }
    await page.evaluate(() => { (window as unknown as { __still: boolean }).__still = true })
    await page.getByRole('link', { name: '概览', exact: true }).click()
    await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible()
    const sent = (await update()).sent
    if (how === 'lost') await page.clock.fastForward(31 * 60_000)
    await page.evaluate((answer) => {
      const state = (globalThis as unknown as { __update: Update }).__update
      state.hold = false
      if (answer) state.answer = answer
      state.held.forEach((go) => go())
      state.held = []
    }, how === 'failed' ? 'failed' : how === 'lost' ? 'throw' : '')
    // 回来的那次已经落地：不弹提示，页面也没刷新 / The read has landed: no toast, and the page was not reloaded
    expect((await update()).held.length).toBe(0)
    await expect(page.locator('.toast')).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __still?: boolean }).__still)).toBe(true)
    await page.clock.runFor(10_000)
    expect((await update()).sent).toBe(sent)
  })
}
