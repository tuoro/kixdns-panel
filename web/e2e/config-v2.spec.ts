import { expect, test } from '@playwright/test'

// 新配置页（?v2=1，③b）：读入演示配置、快速添加一条规则、在右栏（宽屏）或整页（手机）打开、保存并热加载。
// 旧配置页的用例在 config-*.spec.ts 里照跑；这一页在 ③d 成为默认前只走 ?v2=1。
// The new config page (?v2=1, ③b): load the demo config, quick-add a rule, open it in the inspector (wide) or full page (phone),
// save with hot reload. The old page's specs keep running; this page is reached only through ?v2=1 until ③d makes it the default.
test('新配置页：读入、快速添加、打开、保存并热加载 @responsive', async ({ page }, testInfo) => {
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
  await page.getByRole('button', { name: mobile ? '完成' : '保存', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '已更新「示例站点」' })).toBeVisible()
  await expect(row).toContainText('示例站点')
  // 保存：先校验再写入，保存条说「已生效 · 版本 #N」，页头版本跟着变 / Save: validate then write; the bar says 已生效 · 版本 #N and the header version follows
  await page.getByRole('button', { name: mobile ? '保存' : '保存并热加载', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await expect(page.locator('.cfg__savebar')).toContainText('版本 #')
  if (!mobile) await expect(page.locator('.cfg__facts')).toContainText('1 条')
})

test('新配置页：其余三页还没接上时指回现有配置页', async ({ page }) => {
  await page.goto('/config?v2=1&section=mapping')
  await expect(page.locator('.cfg__pending')).toContainText('域名映射')
  await page.getByRole('link', { name: '打开现有配置页' }).click()
  await expect(page).toHaveURL(/\/config\?section=mapping$/)
  await expect(page.getByRole('tab', { name: '域名映射' })).toHaveAttribute('aria-selected', 'true')
})
