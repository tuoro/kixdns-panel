import { expect, test, type Page } from '@playwright/test'
import { acceptConfirm } from './confirm'

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

test('会话过期不跳转，配置草稿在重新验证后原样还在 @responsive', async ({ page }, testInfo) => {
  await openDirtyConfig(page, testInfo.project.name === 'mobile')

  await expireSession(page)

  // 不跳转：还在 /config，配置页仍然挂载着，快速添加的那条规则没有消失。
  await expect(page.getByRole('dialog', { name: '登录状态已过期' })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/config')
  await expect(page.locator('.cfg__panel')).toBeVisible()
  await expect(page.locator('[data-rule]')).toHaveCount(1)
  await expect(page.locator('.cfg__savebar')).toContainText(/已修改 \d+ 处/)

  // 明确告诉用户改动还在——看到这个框的人第一反应就是担心这个。
  await expect(page.getByRole('dialog')).toContainText('你在本页的改动都还在')

  await page.getByLabel('密码', { exact: true }).fill('demo-password')
  await page.getByRole('button', { name: '继续', exact: true }).click()

  // 验证通过后框消失，人还在刚才那一屏，草稿一字未动。
  await expect(page.getByRole('dialog', { name: '登录状态已过期' })).toHaveCount(0)
  expect(new URL(page.url()).pathname).toBe('/config')
  await expect(page.locator('[data-rule]')).toHaveCount(1)
  await expect(page.locator('.cfg__savebar')).toContainText(/已修改 \d+ 处/)
})

test('会话过期后选择退出登录才离开当前页', async ({ page }) => {
  await openDirtyConfig(page, false)
  await expireSession(page)

  await expect(page.getByRole('dialog', { name: '登录状态已过期' })).toBeVisible()
  // 退出是这个框里唯一真会丢东西的选项，所以它必须是用户主动选的——
  // 而且配置页自己的离开守卫还会再问一次未保存的改动，这一层也要过。
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await acceptConfirm(page)
  await expect(page).toHaveURL(/\/login\?redirect=/)
})

test('抽屉开着时会话过期：重新登录的框在最上面，点得到、打得进字，抽屉里的修改还在 @responsive', async ({ page }) => {
  await page.goto('/config?section=upstreams')
  await page.getByRole('button', { name: '新建上游组', exact: true }).first().click()
  const drawer = page.locator('dialog.pdrawer[open]')
  await drawer.getByLabel('名称', { exact: true }).fill('半成品')
  await expireSession(page)
  const relogin = page.getByRole('dialog', { name: '登录状态已过期' })
  await expect(relogin).toBeVisible()
  // 点击会做命中检测：以前框被抽屉的遮罩盖住、变成不可点，这一步会超时 / A click hit-tests: before, the drawer's scrim covered the prompt and made it inert, so this timed out
  await relogin.getByLabel('密码').click({ timeout: 3000 })
  await page.keyboard.type('secret')
  await expect(relogin.getByLabel('密码')).toHaveValue('secret')
  await expect(drawer.getByLabel('名称', { exact: true })).toHaveValue('半成品')
})
