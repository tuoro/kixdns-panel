import { expect, test, type Page } from '@playwright/test'

// kixdns:demo-panel-down 让演示面板不答话，和真的 fetch 失败走同一条路：横幅挂出，每 5 秒问一次，去掉开关后下一次就连上
// kixdns:demo-panel-down makes the demo panel stop answering, the same path as a real fetch failure: the banner goes up, asks every 5 seconds, and reconnects on the next ask once the flag is gone
const panelDown = (page: Page, down: boolean) => page.evaluate((on) => {
  if (on) localStorage.setItem('kixdns:demo-panel-down', 'true')
  else localStorage.removeItem('kixdns:demo-panel-down')
}, down)
const banner = (page: Page) => page.locator('.conn__inner')

test('连不上面板时按了保存：连上以后保存条回到原样，不变成「保存为待应用」，也不怪 KixDNS @responsive', async ({ page }, testInfo) => {
  await page.goto('/config')
  if (testInfo.project.name !== 'mobile') await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('down.example.org')
  await quick.press('Enter')
  const bar = page.locator('.cfg__savebar')
  await panelDown(page, true)
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('连不上面板')
  await expect(banner(page)).toBeVisible()
  await panelDown(page, false)
  await expect(banner(page)).toHaveCount(0, { timeout: 10_000 })
  // 连上以后：「连不上面板」收起，按钮还是「保存并应用」，没有「KixDNS 没有报告它支持哪些功能」 / Reconnected: the verdict goes, the button is still 保存并应用, and no 没有报告能力 notice
  await expect(bar).not.toContainText('连不上面板')
  await expect(bar.getByRole('button', { name: '保存并应用' })).toBeVisible()
  await expect(page.getByText('KixDNS 没有报告它支持哪些功能', { exact: false })).toHaveCount(0)
  await expect(page.locator('[data-rule]', { hasText: 'down.example.org' })).toBeVisible()
  // 再按一次照常先校验再写入 / Pressed again it validates before writing as usual
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('已生效')
})

test('连不上面板时打开的配置页和系统页，连上以后自己读出来 @responsive', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await page.goto('/logs')
  await expect(page.locator('main h1')).toHaveText('日志')
  await panelDown(page, true)
  await page.getByRole('link', { name: mobile ? '配置' : '规则', exact: true }).first().click()
  // 原因和重试交给顶上的横幅：页内只写一句连上后会自己打开 / The cause and the retry belong to the banner: the page only says it opens by itself once connected
  await expect(page.locator('.cfg__wait')).toHaveText('连上面板后自动打开')
  await expect(page.locator('.cfg__failed')).toHaveCount(0)
  // 没读到配置时页头不写规则数、上游组数，只写状态 / Without a config read the header shows no rule or group counts, only the state
  if (!mobile) {
    await expect(page.locator('.cfg__facts')).toContainText('未知')
    await expect(page.locator('.cfg__facts')).not.toContainText('规则')
    await expect(page.locator('.cfg__facts')).not.toContainText('上游组')
  }
  await panelDown(page, false)
  await expect(page.locator('.cfg__panel')).toBeVisible({ timeout: 10_000 })

  await panelDown(page, true)
  await page.getByRole('link', { name: '系统', exact: true }).first().click()
  await expect(banner(page)).toBeVisible()
  await expect(page.locator('.system-wait')).toHaveText('连上面板后自动打开')
  // 什么都没读到时不画卡片：缓存的更新卡读不到内核会写成「还没安装」 / No cards while nothing is read: the cached update card would say 还没安装 without the kernel
  await expect(page.locator('.update-panel')).toHaveCount(0)
  await panelDown(page, false)
  await expect(banner(page)).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('.system-heading')).toContainText(mobile ? '运行中' : 'kixdns.service')
})

// 连不上面板时：横幅说原因、给重试；页面只说手上的数是什么时候读到的，不复述原因，按了只会失败的操作都停用
// With the panel unreachable the banner gives the cause and the retry; the page only says when its figures were read, restates nothing, and disables anything that could only fail
test('连不上面板时页面不复述横幅，按了只会失败的操作都停用 @responsive', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.locator('.overview-card--upstreams')).toBeVisible()
  await panelDown(page, true)
  await page.evaluate(() => window.dispatchEvent(new Event('kixdns:panel-unreachable')))
  await expect(banner(page)).toBeVisible()
  // 读到的时刻：宽屏在页头的「更新于」里，手机在这一行里（手机页头没有这一项），不说两遍
  // The read time: in the header's 更新于 on wide screens, in this line on phones (their header lacks it), never twice
  const notice = page.locator('.overview-notice')
  if (testInfo.project.name === 'mobile') {
    await expect(notice).toHaveText(/^显示 .+ 读到的数据$/)
    await expect(notice.getByRole('button')).toHaveCount(0)
  } else {
    await expect(notice).toBeHidden()
    await expect(page.locator('.overview-heading .ui-facts')).toContainText('更新于')
  }
  await expect(page.getByRole('button', { name: '刷新' })).toBeDisabled()

  await page.getByRole('link', { name: '系统', exact: true }).first().click()
  await expect(page.locator('.system-wait')).toBeVisible()
  await panelDown(page, false)
  await expect(banner(page)).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByRole('button', { name: '重启' })).toBeEnabled()
  await panelDown(page, true)
  await page.evaluate(() => window.dispatchEvent(new Event('kixdns:panel-unreachable')))
  await expect(banner(page)).toBeVisible()
  for (const name of ['重启', '停止']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled()
  await expect(page.locator('.ui-notice--err')).toHaveCount(0)
})

// 写进去了、回应却丢了：连上以后面板上已经是这份配置，保存条直接说「已经保存过了」，不再请人再存一次，也不说「别处改过了」
// Written but the answer was lost: once reconnected the panel already holds this config, so the bar says 已经保存过了 at once, asks for no second save and never says 别处改过了
test('保存的回应丢了：连上后直接说「已经保存过了」，不是冲突', async ({ page }) => {
  await page.goto('/config')
  await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('lost.example.org')
  await quick.press('Enter')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-put-answer-lost', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  // 写入那一步断的：不知道存上没有，页面锁住、保存条收起，不叫人再存一次 / Cut off at the write: whether it landed is unknown, so the page locks
  // and the save bar folds away, asking nobody to save again
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。')
  await expect(page.locator('.cfg__notice')).toContainText('连上后会自己核对')
  await expect(bar).toHaveCount(0)
  // 连上以后只变一次：从「连不上面板」直接到「已经保存过了」，中间不闪「校验通过 · 可以保存」 / Back online it changes once: from 连不上面板 straight to 已经保存过了, no 校验通过 · 可以保存 flashing between
  await page.evaluate(() => {
    const w = window as unknown as { sawReady: boolean }
    w.sawReady = false
    new MutationObserver(() => { if (document.querySelector('.cfg__savebar')?.textContent?.includes('校验通过')) w.sawReady = true }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  await expect(banner(page)).toHaveCount(0, { timeout: 10_000 })
  await expect(bar).toContainText(/已经保存过了\s*·\s*版本 #\d+/)
  expect(await page.evaluate(() => (window as unknown as { sawReady: boolean }).sawReady)).toBe(false)
  await expect(bar.getByRole('button', { name: '保存并应用' })).toHaveCount(0)
  await expect(page.locator('[data-rule]', { hasText: 'lost.example.org' }).getByLabel('改过，还没保存')).toHaveCount(0)
})

// 保存途中又改了一笔、那次保存的回应丢了：页面这时锁住；连上后说已经保存过了、之后改的还没保存
// One more edit while the save runs, then that save's answer is lost: the page locks then; once reconnected the bar says it was already saved
// and the later edit is not
async function loseAnswerThenEdit(page: Page): Promise<void> {
  await page.goto('/config')
  await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('lost.example.org')
  await quick.press('Enter')
  // 回应丢了的那一刻面板也停止答话，连上之前的检查都读不到；保存放慢，好在它还在做时再改一笔 / The panel stops answering as the answer is
  // lost, so nothing checks before it is back; the save is slowed so one more edit can be made while it runs
  await page.evaluate(() => {
    window.addEventListener('kixdns:panel-unreachable', () => localStorage.setItem('kixdns:demo-panel-down', 'true'), { capture: true, once: true })
    localStorage.setItem('kixdns:demo-put-answer-lost', 'true')
    localStorage.setItem('kixdns:demo-save-slow', '3000')
  })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('写入并应用')
  await page.getByLabel('快速添加的结果', { exact: true }).selectOption('block')
  await quick.fill('later.example.org')
  await quick.press('Enter')
  await expect(page.locator('[data-rule]', { hasText: 'later.example.org' })).toBeVisible()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。', { timeout: 8000 })
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
}

test('回应丢了又改了一笔：连上后说已经保存过了，之后改的还没保存', async ({ page }) => {
  await loseAnswerThenEdit(page)
  await panelDown(page, false)
  const bar = page.locator('.cfg__savebar')
  await expect(bar).toContainText(/已经保存过了\s*·\s*版本 #\d+\s*·\s*之后改的 1 处还没保存/, { timeout: 10_000 })
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText(/已生效\s*·\s*版本 #\d+/)
  await expect(bar).not.toContainText('别处改过了')
})

// 有没保存的修改时连不上面板、又读了一次配置：连上以后那条「读取配置失败」收起，不和「已重新连上面板」并排
// Unsaved edits, the panel unreachable and the config re-read: once reconnected, 读取配置失败 goes instead of sitting beside 已重新连上面板
test('有修改时断线读过一次配置：连上后「读取配置失败」收起', async ({ page }) => {
  await page.goto('/config')
  await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('keep.example.org')
  await quick.press('Enter')
  await panelDown(page, true)
  await page.evaluate(async () => {
    const { load } = await import('/src/config-v2/useConfigDocument.ts')
    await load({ quiet: true, keepDraft: true })
  })
  await expect(banner(page)).toBeVisible()
  await panelDown(page, false)
  await expect(banner(page)).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('.cfg__notice', { hasText: '读取配置失败' })).toHaveCount(0)
  await expect(page.locator('[data-rule]', { hasText: 'keep.example.org' })).toBeVisible()
})

// 日志页连上以后马上重读：操作审计不轮询，以前「读取失败」会在横幅收起后一直挂着
// The logs page re-reads on reconnect: the audit tab does not poll, and its 读取失败 used to stay after the banner had gone
test('日志页连上后马上重读，「读取失败」不留在横幅收起之后', async ({ page }) => {
  await page.goto('/logs')
  await page.getByRole('tab', { name: '操作审计' }).click()
  await expect(page.locator('.audit-line').first()).toBeVisible()
  await panelDown(page, true)
  await page.getByRole('button', { name: '刷新审计记录' }).click()
  await expect(banner(page)).toBeVisible()
  await panelDown(page, false)
  await expect(banner(page)).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('.logs-notice')).toHaveCount(0)
  await expect(page.locator('.audit-line').first()).toBeVisible()
})

// 打开日志页时就连不上：只留一句「连上面板后自动打开」，没有空着的工具行；连上以后直接出日志，中间不闪一下红色的「读取失败」
// The panel already unreachable when the logs page opens: only the waiting line, no empty toolbar; once back the log appears with no red 读取失败 flashing in between
test('日志页什么都没读到就断了：只留一句，连上后不闪红字', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('main h1')).toBeVisible()
  await panelDown(page, true)
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect(page.locator('.logs-notice')).toHaveText('连上面板后自动打开', { timeout: 10_000 })
  await expect(page.locator('.log-console')).toHaveCount(0)
  await page.evaluate(() => {
    const w = window as unknown as { sawRed: boolean }
    w.sawRed = false
    new MutationObserver(() => { if (document.querySelector('.logs-notice.ui-notice--err')) w.sawRed = true }).observe(document.body, { subtree: true, childList: true })
  })
  await panelDown(page, false)
  await expect(page.locator('.log-console')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.logs-notice')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { sawRed: boolean }).sawRed)).toBe(false)
})

// 配置页连不上面板时，重新读取、批量删除、比较里的恢复都停用：按了只会失败，或者进到一个什么都选不了的状态
// On the config page with the panel unreachable, re-reading, bulk delete and the compare's restore are disabled: pressing them could only fail, or enter a state where nothing can be picked
test('配置页断线时重新读取、批量删除、恢复都停用', async ({ page }) => {
  await page.goto('/config')
  await page.getByRole('button', { name: '更多配置操作' }).click()
  await page.getByRole('menuitem', { name: '历史版本' }).click()
  const drawer = page.locator('dialog.hist[open]')
  await drawer.getByRole('button', { name: '版本 #17 的操作' }).click()
  await page.getByRole('menuitem', { name: '和当前比较' }).click()
  const restore = page.locator('dialog.diffd[open]').getByRole('button', { name: '恢复为版本 #17' })
  await expect(restore).toBeEnabled()
  await panelDown(page, true)
  await page.evaluate(() => window.dispatchEvent(new Event('kixdns:panel-unreachable')))
  await expect(banner(page)).toBeVisible()
  await expect(restore).toBeDisabled()
  await page.locator('dialog.diffd[open]').getByRole('button', { name: '关闭比较' }).click()
  await expect(drawer.getByRole('button', { name: '批量删除' })).toBeDisabled()
  await drawer.getByRole('button', { name: '关闭' }).first().click()
  await page.getByRole('button', { name: '更多配置操作' }).click()
  await expect(page.getByRole('menuitem', { name: '重新读取配置' })).toBeDisabled()
})

// 回应丢了的时候人已经离开配置页：连上以后照样核对，提示换成核对的结果；回到配置页，保存条不再说「连不上面板」
// The answer was lost after leaving the config page: once reconnected it is still checked and the toast becomes the result; back on the config page the bar no longer says 连不上面板
test('回应丢了时已经离开配置页：连上后照样核对，回来不再说连不上', async ({ page }) => {
  const toastTexts = () => page.locator('.toast').allTextContents().then((texts) => texts.map((text) => text.replace(/⁠/g, '').trim()))
  await page.goto('/config')
  await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('away-lost.example.org')
  await quick.press('Enter')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', 'true'); localStorage.setItem('kixdns:demo-put-answer-lost', 'true') })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('写入并应用')
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect.poll(toastTexts, { timeout: 5000 }).toContain('刚才那次保存不知道存上没有：连不上面板。草稿留在配置页，连上后会自己核对')
  await expect(banner(page)).toHaveCount(0, { timeout: 10_000 })
  await expect.poll(async () => (await toastTexts()).some((text) => /^刚才那次保存已经存上了：版本 #\d+ 已生效$/.test(text)), { timeout: 5000 }).toBe(true)
  expect(await toastTexts()).not.toContain('刚才那次保存不知道存上没有：连不上面板。草稿留在配置页，连上后会自己核对')
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
  await page.getByRole('link', { name: '规则', exact: true }).click()
  await expect(page.locator('[data-rule]', { hasText: 'away-lost.example.org' })).toBeVisible()
  await expect(page.locator('.cfg__savebar', { hasText: '连不上面板' })).toHaveCount(0)
  await expect(page.locator('[data-rule]', { hasText: 'away-lost.example.org' }).getByLabel('改过，还没保存')).toHaveCount(0)
})

// 900 宽时「已经保存过了 · 之后改的 N 处还没保存」这么长的状态换成两行：备注框放得下占位字，「保存并应用」不被挤出屏幕
// At 900 a status as long as 已经保存过了 · 之后改的 N 处还没保存 takes two rows: the note still fits its placeholder and 保存并应用 is not pushed off screen
test('窄一点的宽屏上，长的保存条状态不把按钮挤出屏幕', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '只看 861 以上的保存条')
  await page.setViewportSize({ width: 900, height: 800 })
  await loseAnswerThenEdit(page)
  await panelDown(page, false)
  const bar = page.locator('.cfg__savebar')
  await expect(bar).toContainText(/已经保存过了/, { timeout: 10_000 })
  const save = await bar.getByRole('button', { name: '保存并应用' }).boundingBox()
  expect(save!.x + save!.width).toBeLessThanOrEqual(900)
  const note = await bar.locator('.savebar__note').boundingBox()
  expect(note!.width).toBeGreaterThanOrEqual(150)
})

// 回应丢了、连上之前别处又存了一版：面板上的文件既不是草稿的底子、也不是自己那次保存。按冲突处理，不给一个会悄悄盖掉别处版本的保存
// The answer was lost and someone else saved before the reconnect: the file on the panel is neither the draft's base nor one's own save. It is handled as a
// conflict, with no save offered that would silently overwrite the other version
test('回应丢了时别处又存了一版：连上后按冲突处理，不悄悄盖掉', async ({ page }) => {
  await page.goto('/config')
  await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('mine.example.org')
  await quick.press('Enter')
  await page.evaluate(() => {
    window.addEventListener('kixdns:panel-unreachable', () => localStorage.setItem('kixdns:demo-panel-down', 'true'), { capture: true, once: true })
    localStorage.setItem('kixdns:demo-put-answer-lost', 'true')
  })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。')
  // 别处直接写进演示后端（绕过这一页的连不上） / Someone else writes straight into the demo backend (bypassing this page's outage)
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/api/mock.ts')).pop()!
    const mock = await import(url) as { mockRequest: (path: string, init?: RequestInit) => Promise<{ sha256: string; content: { settings?: Record<string, unknown> } }> }
    const current = await mock.mockRequest('/api/v1/config')
    const content = JSON.parse(JSON.stringify(current.content)) as { settings: Record<string, unknown> }
    content.settings = { ...content.settings, cache_capacity: 4321 }
    await mock.mockRequest('/api/v1/config', { method: 'PUT', body: JSON.stringify({ content, expected_sha256: current.sha256, message: '别处' }) })
  })
  await panelDown(page, false)
  await expect(banner(page)).toHaveCount(0, { timeout: 10_000 })
  await expect(bar).toContainText('这份配置在别处改过了', { timeout: 5000 })
  await expect(bar.getByRole('button', { name: '保存并应用' })).toBeDisabled()
})

