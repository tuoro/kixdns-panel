import { expect, test, type Page } from '@playwright/test'

const configFixture = {
  version: '1.0',
  settings: { bind_addr: '0.0.0.0:53', default_upstream: '1.1.1.1:53' },
  pipeline_select: [
    { pipeline: 'domestic', matcher_operator: 'and', matchers: [{ type: 'geo_site', operator: 'and', value: 'geosite:cn' }] },
  ],
  pipelines: [
    { id: 'domestic', rules: [{ name: 'domestic-rule', matchers: [], matcher_operator: 'and', actions: [{ type: 'forward', upstream: '223.5.5.5:53', transport: '' }] }] },
  ],
}

/** 导入一份配置，让草稿处于「有未保存修改」的状态。 */
async function openDirtyConfig(page: Page): Promise<void> {
  await page.goto('/config')
  await expect(page.getByLabel('解析编排工作台', { exact: true })).toBeVisible()
  await page.locator('input[type=file]').setInputFiles({
    name: 'draft.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(configFixture)),
  })
  await expect(page.locator('.workbench-entry')).toHaveCount(1)
  await expect(page.locator('.workbench-draft-state')).toContainText('草稿有修改')
}

/** 模拟一次受保护接口返回 401：直接派发 client 在 401 时派发的那个事件。 */
async function expireSession(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { SESSION_EXPIRED_EVENT } = await import('/src/api/client.ts')
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
  })
}

test('会话过期不跳转，配置草稿在重新验证后原样还在 @responsive', async ({ page }) => {
  await openDirtyConfig(page)

  await expireSession(page)

  // 不跳转：还在 /config，工作台仍然挂载着，导入的那条入口没有消失。
  await expect(page.getByRole('dialog', { name: '登录状态已过期' })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/config')
  await expect(page.getByLabel('解析编排工作台', { exact: true })).toBeVisible()
  await expect(page.locator('.workbench-entry')).toHaveCount(1)
  await expect(page.locator('.workbench-draft-state')).toContainText('草稿有修改')

  // 明确告诉用户改动还在——看到这个框的人第一反应就是担心这个。
  await expect(page.getByRole('dialog')).toContainText('你在本页的改动都还在')

  await page.getByLabel('密码', { exact: true }).fill('demo-password')
  await page.getByRole('button', { name: '继续', exact: true }).click()

  // 验证通过后框消失，人还在刚才那一屏，草稿一字未动。
  await expect(page.getByRole('dialog', { name: '登录状态已过期' })).toHaveCount(0)
  expect(new URL(page.url()).pathname).toBe('/config')
  await expect(page.locator('.workbench-entry')).toHaveCount(1)
  await expect(page.locator('.workbench-draft-state')).toContainText('草稿有修改')
})

test('会话过期后选择退出登录才离开当前页', async ({ page }) => {
  await openDirtyConfig(page)
  await expireSession(page)

  await expect(page.getByRole('dialog', { name: '登录状态已过期' })).toBeVisible()
  // 退出是这个框里唯一真会丢东西的选项，所以它必须是用户主动选的——
  // 而且配置页自己的离开守卫还会再问一次未保存的改动，这一层也要过。
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(/\/login\?redirect=/)
})
