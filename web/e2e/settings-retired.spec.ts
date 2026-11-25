import { expect, test, type Page } from '@playwright/test'

// 配置里留着内核不再读的旧设置时，基础设置页上面说一句、给「清掉」：清掉的是草稿里的这几项，别的设置不动，提示里能撤销
// With old settings the kernel no longer reads left in the config, the settings page says so above the card with 清掉: it clears just
// these from the draft, leaves every other setting alone, and the toast can undo it

const settings = (page: Page) => page.evaluate(async () => {
  const url = (part: string) => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes(part)).pop()!
  const store = await import(url('/src/config-v2/store.ts'))
  return { ...store.model.settings } as Record<string, unknown>
})

test('旧设置一键清掉，别的设置不动，能撤销', async ({ page }) => {
  await page.goto('/config?section=settings')
  await expect(page.locator('.sets__card')).toBeVisible()
  const notice = page.locator('.sets > .ui-notice')
  await expect(notice).toHaveCount(0)
  await page.evaluate(async () => {
    const url = (part: string) => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes(part)).pop()!
    const store = await import(url('/src/config-v2/store.ts'))
    store.model.settings = { ...store.model.settings, statistics_enabled: true, flow_control_max_permits: 512, flow_control_min_permits: 8, tcp_health_check_error_threshold: 3 }
  })
  await expect(notice).toContainText('配置里还留着不再起作用的旧设置：查询统计、智能流控的旧数值、TCP 错误阈值')
  const before = await settings(page)
  await notice.getByRole('button', { name: '清掉', exact: true }).click()
  await expect(notice).toHaveCount(0)
  const after = await settings(page)
  for (const key of ['statistics_enabled', 'flow_control_max_permits', 'flow_control_min_permits', 'tcp_health_check_error_threshold']) expect(after).not.toHaveProperty(key)
  const { statistics_enabled: _a, flow_control_max_permits: _b, flow_control_min_permits: _c, tcp_health_check_error_threshold: _d, ...kept } = before
  expect(after).toEqual(kept)
  await page.locator('.toast', { hasText: '已清掉 4 项旧设置' }).getByRole('button', { name: '撤销' }).click()
  await expect(notice).toContainText('查询统计')
  expect(await settings(page)).toEqual(before)
})
