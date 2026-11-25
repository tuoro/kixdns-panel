import { expect, test, type Page } from '@playwright/test'

// 基础设置照内核报的配置能力列出、读法跟着变：引导 DNS 要 config_bootstrap_v1，「重新计时」的名字和默认值看
// config_serve_stale_ttl_reset_v2。演示模式的内核两项都有，用例里拿掉一项来演旧内核
// The settings follow the kernel's config capabilities in what they list and how they read: 引导 DNS needs config_bootstrap_v1, and the
// name and default of the stale timer follow config_serve_stale_ttl_reset_v2. The demo kernel has both; a case drops one to play an
// older kernel

async function openGroup(page: Page, group: RegExp): Promise<void> {
  await page.goto('/config?section=settings')
  await page.locator('.settings-nav').getByRole('button', { name: group }).click()
}

// 在页面里改草稿和内核报的能力 / Edit the draft and the kernel's reported capabilities inside the page
async function inPage(page: Page, change: { dropCapability?: string; bootstrap?: string; groupAddress?: string }): Promise<void> {
  await page.evaluate(async ({ dropCapability, bootstrap, groupAddress }) => {
    const url = (part: string) => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes(part)).pop()!
    const store = await import(url('/src/config-v2/store.ts'))
    const document = await import(url('/src/config-v2/useConfigDocument.ts'))
    if (dropCapability) document.runtimeCapabilities.value = document.runtimeCapabilities.value.filter((c: string) => c !== dropCapability)
    if (bootstrap !== undefined) store.model.settings = { ...store.model.settings, bootstrap }
    if (groupAddress) store.model.groups[0].addresses = [{ address: groupAddress, protocol: 'auto' }]
  }, change)
}

const bootstrapWritten = (page: Page) => page.evaluate(async () => {
  const url = (part: string) => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes(part)).pop()!
  const store = await import(url('/src/config-v2/store.ts'))
  return Object.hasOwn(store.model.settings, 'bootstrap')
})

test('引导 DNS：照内核查写法；没写又有上游写成域名时框下面提醒；清空就是没写', async ({ page }) => {
  await openGroup(page, /基础与监听/)
  const box = page.getByLabel('引导 DNS', { exact: true })
  await expect(box).toBeVisible()
  await box.fill('dns.google:53')
  await box.blur()
  await expect(page.locator('.ui-field-error', { hasText: '「dns.google:53」不是「IP:端口」' })).toBeVisible()
  await box.fill('223.5.5.5:53, 119.29.29.29:53')
  await box.blur()
  await expect(page.locator('.ui-field-error', { hasText: '不是「IP:端口」' })).toHaveCount(0)
  // 清空的框不写进配置，内核按没写处理 / A cleared box is not written, so the kernel takes it as unset
  await box.fill('')
  await expect.poll(() => bootstrapWritten(page)).toBe(false)
  await inPage(page, { groupAddress: 'tls://dns.google' })
  const hint = page.locator('.ui-field-warn', { hasText: '写成了域名，没写引导 DNS 时交给系统解析' })
  await expect(hint).toBeVisible()
  await expect(box).toHaveAttribute('aria-describedby', 'settings-warning-bootstrap')
  await box.fill('223.5.5.5:53')
  await expect(hint).toHaveCount(0)
})

test('内核不认引导 DNS 时不列这一项；配置里写了的照样列出、标红，清空以后收起', async ({ page }) => {
  await openGroup(page, /基础与监听/)
  await expect(page.getByLabel('引导 DNS', { exact: true })).toBeVisible()
  await inPage(page, { dropCapability: 'config_bootstrap_v1' })
  await expect(page.getByLabel('引导 DNS', { exact: true })).toHaveCount(0)
  await inPage(page, { bootstrap: '223.5.5.5:53' })
  const box = page.getByLabel('引导 DNS', { exact: true })
  await expect(box).toHaveValue('223.5.5.5:53')
  await expect(page.locator('.ui-field-error', { hasText: '当前内核不认引导 DNS：清空它，或者先把内核更新到最新' })).toBeVisible()
  await box.fill('')
  await expect(box).toHaveCount(0)
  await expect.poll(() => bootstrapWritten(page)).toBe(false)
})

test('过期缓存的「重新计时」：新内核是刷新失败后才重新计时、默认关；旧内核照旧每用一次就重新计时、默认开', async ({ page }) => {
  await openGroup(page, /过期缓存/)
  const stale = page.getByRole('switch', { name: '过期后继续用旧结果', exact: true })
  if (!(await stale.isChecked())) await page.locator('label.ui-setrow--toggle', { hasText: '过期后继续用旧结果' }).click()
  await expect(stale).toBeChecked()
  await expect(page.getByRole('switch', { name: '刷新失败后重新计时', exact: true })).not.toBeChecked()
  await expect(page.locator('label.ui-setrow--toggle', { hasText: '刷新失败后重新计时' })).toContainText('后台刷新失败以后')
  await inPage(page, { dropCapability: 'config_serve_stale_ttl_reset_v2' })
  await expect(page.getByRole('switch', { name: '每用一次旧结果就重新计时', exact: true })).toBeChecked()
  await expect(page.getByRole('switch', { name: '刷新失败后重新计时', exact: true })).toHaveCount(0)
})

test('监听地址不写死默认端口：占位写「内核默认」，说明里说随内核版本', async ({ page }) => {
  await openGroup(page, /基础与监听/)
  for (const label of ['UDP 监听地址', 'TCP 监听地址']) {
    const box = page.getByLabel(label, { exact: true })
    await box.fill('')
    await expect(box).toHaveAttribute('placeholder', '内核默认')
  }
  await expect(page.locator('.ui-setrow', { hasText: 'UDP 监听地址' })).toContainText('内核版本不同默认也不同')
})
