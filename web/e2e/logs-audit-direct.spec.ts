import { expect, test } from '@playwright/test'

// 直接打开（或刷新）操作审计页签：原来只读了运行日志，审计这边空着说「还没有操作记录」
// Opening (or reloading) the audit tab directly: it used to read only the runtime log, leaving the audit empty with 「还没有操作记录」
test('直接打开操作审计：读得出记录，不说「还没有操作记录」 @responsive', async ({ page }) => {
  await page.goto('/logs?view=audit')
  await expect(page.locator('.audit-line').first()).toBeVisible()
  await expect(page.getByText('还没有操作记录')).toHaveCount(0)
  // 刷新以后也一样 / The same after a reload
  await page.reload()
  await expect(page.locator('.audit-line').first()).toBeVisible()
})
