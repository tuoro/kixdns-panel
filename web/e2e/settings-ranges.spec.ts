import { expect, test, type Page } from '@playwright/test'

// 基础设置在页内照内核的范围和相互关系说（哪些不收和内核一一对上，见 settings-kernel-fixtures.test.ts）：这里看页面上说得出来、
// 说在对的框下面，读不成数的框不当成清空
// The settings page tells the kernel's ranges and relations in place (which ones are refused matches the kernel, see
// settings-kernel-fixtures.test.ts): here the page says so under the right box, and a box that reads as no number is not taken as cleared

async function openNetwork(page: Page): Promise<void> {
  await page.goto('/config?section=settings')
  await page.locator('.settings-nav').getByRole('button', { name: /基础与监听/ }).click()
}

const setting = (page: Page, key: string) => page.evaluate(async (key) => {
  const url = (part: string) => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes(part)).pop()!
  const store = await import(url('/src/config-v2/store.ts'))
  return store.model.settings[key] as unknown
}, key)

test('跳转次数上限：最多 64，0 也行；读不成数的不当成清空', async ({ page }) => {
  await openNetwork(page)
  const jumps = page.getByLabel('跳转次数上限', { exact: true })
  await expect(page.locator('.ui-setrow', { hasText: '跳转次数上限' })).toContainText('回答后检查从第一次跳转起另算这么多次')
  await jumps.fill('65')
  const tooMany = page.locator('.ui-field-error', { hasText: '填 0 到 64 之间的整数' })
  await expect(tooMany).toBeVisible()
  await jumps.fill('0')
  await expect(tooMany).toHaveCount(0)
  await expect.poll(() => setting(page, 'response_jump_limit')).toBe(0)
  await jumps.fill('7')
  await jumps.press('End')
  await jumps.pressSequentially('e')
  const unreadable = page.locator('.ui-field-error', { hasText: '填一个整数' })
  await expect(unreadable).toBeVisible()
  // 配置里还是上一次读得成的数，不是清空 / The config keeps the last number that could be read instead of clearing it
  expect(await setting(page, 'response_jump_limit')).toBe(7)
  await jumps.fill('12')
  await expect(unreadable).toHaveCount(0)
  await expect.poll(() => setting(page, 'response_jump_limit')).toBe(12)
})

test('整体请求超时不能小于上游超时；写了 DoH 监听地址就要证书和私钥', async ({ page }) => {
  await openNetwork(page)
  await page.getByLabel('上游超时 (ms)', { exact: true }).fill('2000')
  await page.getByLabel('整体请求超时 (ms)', { exact: true }).fill('1000')
  await expect(page.locator('.ui-field-error', { hasText: '不能小于上游超时（2000 毫秒）' })).toBeVisible()
  await page.getByLabel('整体请求超时 (ms)', { exact: true }).fill('2000')
  await expect(page.locator('.ui-field-error', { hasText: '不能小于上游超时' })).toHaveCount(0)
  const doh = page.getByLabel('DoH 监听地址', { exact: true })
  await doh.fill('0.0.0.0:443')
  await doh.blur()
  await expect(page.locator('.ui-field-error', { hasText: '写了 DoH 监听地址就要写证书' })).toBeVisible()
  await expect(page.locator('.ui-field-error', { hasText: '写了 DoH 监听地址就要写私钥' })).toBeVisible()
  await doh.fill(':443')
  await doh.blur()
  await expect(page.locator('.ui-field-error', { hasText: '要写成「IP:端口」' })).toBeVisible()
})

test('刷新阈值到 99、可以是 0；分片数要 2 的幂', async ({ page }) => {
  await page.goto('/config?section=settings')
  await page.locator('.settings-nav').getByRole('button', { name: /缓存与后台刷新/ }).click()
  const refresh = page.getByRole('switch', { name: '后台刷新', exact: true })
  if (!(await refresh.isChecked())) await page.locator('label.ui-setrow--toggle', { hasText: '后台刷新' }).first().click()
  const threshold = page.getByLabel('刷新阈值 (%)', { exact: true })
  await expect(threshold).toHaveAttribute('max', '99')
  for (const value of ['0', '99']) {
    await threshold.fill(value)
    await expect(page.locator('.ui-field-error')).toHaveCount(0)
  }
  await threshold.fill('100')
  await expect(page.locator('.ui-field-error', { hasText: '填 0 到 99 之间的整数' })).toBeVisible()
  const shards = page.getByLabel('缓存分片数', { exact: true })
  await shards.fill('3')
  await expect(page.locator('.ui-field-error', { hasText: '2 到 65536 之间 2 的幂' })).toBeVisible()
  await shards.fill('64')
  await expect(page.locator('.ui-field-error', { hasText: '2 的幂' })).toHaveCount(0)
})
