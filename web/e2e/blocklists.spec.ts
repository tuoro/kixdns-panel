import { expect, test, type Page } from '@playwright/test'

// 拦截列表：从推荐的列表订阅，先下载、下完给出条数；没用上的行看得到原因；规则页最上面多一行「拦截列表」；保存以后历史版本里说得出改了什么。
// 演示模式下的下载是假的（src/api/mock-blocklists.ts）。
// Blocklists: subscribing from the suggested lists downloads first and shows counts once done; unused lines show why; the rules page gains a
// 拦截列表 row at the top; after saving, the version history says what changed. Downloads are pretend in demo mode (src/api/mock-blocklists.ts).

async function open(page: Page): Promise<void> {
  await page.goto('/config?section=blocklists')
  await expect(page.locator('.cfg__panel')).toBeVisible()
}

async function subscribe(page: Page, names: string[]): Promise<void> {
  await page.getByRole('button', { name: '推荐的列表', exact: true }).first().click()
  const dialog = page.locator('dialog[open]')
  for (const name of names) await dialog.locator('.blp__item', { hasText: name }).click()
  await dialog.getByRole('button', { name: `订阅 ${names.length} 个`, exact: true }).click()
  await expect(page.locator('.bl__row')).toHaveCount(names.length)
}

test('订阅推荐的列表：先下载，下完给出条数和没用上的行 @responsive', async ({ page }) => {
  await open(page)
  await expect(page.getByText('还没有订阅拦截列表')).toBeVisible()
  await subscribe(page, ['AdGuard DNS filter', 'anti-AD'])
  await expect(page.locator('.bl__busy').first()).toBeVisible()
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const antiAd = page.locator('.bl__row', { hasText: 'anti-AD' })
  await expect(antiAd).toContainText('9.7\u00a0万条')
  await expect(antiAd).toContainText('4\u00a0条没用上')
  await expect(antiAd.locator('.bl__changed')).toHaveAttribute('title', '新加的，还没保存')
  await expect(page.locator('.cfg__savebar')).toContainText('已修改 2 处')
  await antiAd.getByRole('button', { name: 'anti-AD 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '查看没用上的 4 条', exact: true }).click()
  const skipped = page.locator('dialog[open]')
  await expect(skipped.locator('.bl__problem')).toHaveCount(4)
  await expect(skipped.locator('.bl__problem').first()).toContainText('还不支持 $dnstype')
})

test('自己写的规则只指出用不上的行；规则页最上面多一行拦截列表，保存以后历史里写得出改了什么', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true }).fill('! 自己加的\n||ad.example.com^\n@@||s.example.com^\n||x.example^$client=10.0.0.1')
  const problems = page.locator('.bl__problem')
  await expect(problems).toHaveCount(1)
  await expect(problems).toContainText('第 4 行')
  await expect(problems).toContainText('还不支持 $client')

  await page.locator('.desktop-nav').getByRole('link', { name: '规则', exact: true }).click()
  const pin = page.locator('.rpin', { hasText: '拦截列表' })
  await expect(pin).toContainText('AdGuard DNS filter、自己写的 2 条，先于下面所有规则')
  await expect(pin.locator('.opill')).toContainText('拦截')
  await pin.getByRole('button', { name: '管理拦截列表', exact: true }).click()
  await expect(page).toHaveURL(/section=blocklists/)

  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await page.getByRole('button', { name: '更多配置操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '历史版本', exact: true }).click()
  await page.locator('.hist__row:not(.is-current) .hist__main').first().click()
  const diff = page.locator('.diffd')
  await expect(diff).toContainText('拦截列表「AdGuard DNS filter」')
  await expect(diff).toContainText('自己写的拦截规则')
})

test('删掉一个订阅能撤销；关掉一个以后重新合成，规则页那一行只剩开着的', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter', 'OISD big'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('checkbox', { name: '启用 OISD big', exact: true }).uncheck({ force: true })
  await expect(page.locator('.bl__row', { hasText: 'OISD big' })).toHaveClass(/is-off/)
  const adguard = page.locator('.bl__row', { hasText: 'AdGuard DNS filter' })
  await adguard.getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  await expect(page.locator('.bl__row')).toHaveCount(1)
  await page.locator('.toast').getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.locator('.bl__row')).toHaveCount(2)
  await page.locator('.desktop-nav').getByRole('link', { name: '规则', exact: true }).click()
  await expect(page.locator('.rpin', { hasText: '拦截列表' })).toContainText('AdGuard DNS filter，先于下面所有规则')
})
