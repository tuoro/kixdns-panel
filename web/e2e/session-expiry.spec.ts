import { expect, test, type Page } from '@playwright/test'

/** 在配置页快速添加一条规则，让草稿处于「有未保存修改」的状态。 */
async function openDirtyConfig(page: Page, mobile: boolean): Promise<void> {
  await page.goto('/config')
  await expect(page.locator('.cfg__panel')).toBeVisible()
  // 宽屏上快速添加藏在工具行的「快速添加」后面，点开才占一行；手机上一直在
  // On wide screens quick add hides behind the toolbar's 快速添加; on phones it is always there
  if (!mobile) await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('example.org')
  await quick.press('Enter')
  await expect(page.locator('[data-rule]')).toHaveCount(1)
  await expect(page.locator('.cfg__savebar')).toContainText(/已修改 \d+ 处/)
}

/** 模拟一次受保护接口返回 401：直接派发 client 在 401 时派发的那个事件。 */
async function expireSession(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { SESSION_EXPIRED_EVENT } = await import('/src/api/client.ts')
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
  })
}

async function signIn(page: Page): Promise<void> {
  await page.getByLabel('用户名').fill('admin')
  await page.getByLabel('密码', { exact: true }).fill('demo-password')
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

// 会话过期就回登录页，不盖一层重新登录的框，也不问「放弃修改」：会话已经没了，留下也存不了
// An expired session goes straight to the login page: no re-login dialog over the page and no 放弃修改 question, since with the session gone staying could save nothing
test('会话过期直接回登录页；草稿丢了照实说，登录后回到原来那一页 @responsive', async ({ page }, testInfo) => {
  await openDirtyConfig(page, testInfo.project.name === 'mobile')
  await expireSession(page)

  await expect(page).toHaveURL(/\/login\?/)
  const url = new URL(page.url())
  expect(url.searchParams.get('redirect')).toBe('/config')
  expect(url.searchParams.get('expired')).toBe('draft')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  const note = page.locator('.auth-expired')
  await expect(note.locator('span')).toHaveText('登录已过期')
  await expect(note.locator('small')).toHaveText('刚才没保存的配置修改没有留下来。登录后回到刚才的页面。')
  // 配置页的「撤销」提示随页面一起收起：草稿已经没了，撤销不了 / The config page's undo toast goes with the page: the draft is gone, nothing to undo
  await expect(page.locator('.toast').filter({ hasText: '已添加规则' })).toHaveCount(0)

  await signIn(page)
  await expect(page).toHaveURL(/\/config$/)
  await expect(page.locator('.cfg__panel')).toBeVisible()
})

test('没有没保存的修改时，登录页只说过期，登录后回到原来那一页', async ({ page }) => {
  await page.goto('/logs')
  await expect(page.locator('main h1')).toHaveText('日志')
  await expireSession(page)
  await expect(page).toHaveURL(/\/login\?/)
  expect(new URL(page.url()).searchParams.get('expired')).toBe('1')
  await expect(page.locator('.auth-expired span')).toHaveText('登录已过期')
  await expect(page.locator('.auth-expired small')).toHaveText('登录后回到刚才的页面。')
  await signIn(page)
  await expect(page).toHaveURL(/\/logs$/)
})

test('抽屉开着时会话过期：抽屉随页面一起关掉，直接到登录页', async ({ page }) => {
  await page.goto('/config?section=upstreams')
  await page.getByRole('button', { name: '新建上游组', exact: true }).first().click()
  await page.locator('dialog.pdrawer[open]').getByLabel('名称', { exact: true }).fill('半成品')
  await expireSession(page)
  await expect(page).toHaveURL(/\/login\?/)
  expect(new URL(page.url()).searchParams.get('expired')).toBe('draft')
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '登录面板', exact: true })).toBeVisible()
})

// 过期时放行的那一次只给那次换页：登录回来再改，离开照样要问
// The pass given on expiry covers only that page change: back after signing in, a new edit still asks before leaving
test('会话过期放行的那一次不会留到以后：登录回来再改，离开照样先问', async ({ page }) => {
  for (const start of ['/config', '/logs']) {
    await page.goto(start)
    await expect(page.locator('main h1')).toBeVisible()
    await expireSession(page)
    await expect(page).toHaveURL(/\/login\?/)
    await signIn(page)
    await expect(page).toHaveURL(new RegExp(`${start}$`))
    // 站内换页，不重新加载：放行标记要是留下来，就会留在这一页的内存里 / Navigate inside the app without a reload: a lingering pass would live in this page's memory
    if (start !== '/config') await page.getByRole('link', { name: '规则', exact: true }).first().click()
    await expect(page.locator('.cfg__panel')).toBeVisible()
    await page.getByRole('button', { name: '快速添加', exact: true }).click()
    const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
    await quick.fill(`again${start.slice(1)}.example.org`)
    await quick.press('Enter')
    await expect(page.locator('.cfg__savebar')).toContainText(/已修改 \d+ 处/)
    await page.getByRole('link', { name: '日志' }).first().click()
    await expect(page.getByRole('alertdialog', { name: '放弃未保存的修改' })).toBeVisible()
    await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改' }).click()
    await expect(page).toHaveURL(/\/logs$/)
  }
})
