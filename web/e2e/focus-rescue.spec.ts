import { expect, test, type Page } from '@playwright/test'

// 拿着焦点的东西被删掉或停用时，焦点不掉回 <body>：键盘用户不用从页头重新 Tab
// When whatever holds focus is removed or disabled, focus does not fall back to <body>: a keyboard user need not Tab from the header again
const activeIsBody = (page: Page) => page.evaluate(() => document.activeElement === document.body || document.activeElement === null)

test('提示里的「撤销」、横幅的「重试」用掉以后，焦点不掉到页面最外层', async ({ page }) => {
  await page.goto('/config')
  await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('undo.example.org')
  await quick.press('Enter')
  const undo = page.locator('.toast').getByRole('button', { name: '撤销' })
  await undo.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.toast', { hasText: 'undo.example.org' })).toHaveCount(0)
  await expect.poll(() => activeIsBody(page)).toBe(false)

  await page.evaluate(() => localStorage.setItem('kixdns:demo-panel-down', 'true'))
  await page.evaluate(() => window.dispatchEvent(new Event('kixdns:panel-unreachable')))
  const retry = page.locator('.conn__inner').getByRole('button', { name: '重试' })
  await retry.focus()
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-panel-down'))
  await page.keyboard.press('Enter')
  await expect(page.locator('.conn__inner')).toHaveCount(0)
  await expect.poll(() => activeIsBody(page)).toBe(false)
})

test('保存完保存条收起，焦点不掉到页面最外层', async ({ page }) => {
  await page.goto('/config')
  await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('bar.example.org')
  await quick.press('Enter')
  const save = page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' })
  await save.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.cfg__savebar')).toHaveCount(0, { timeout: 10_000 })
  await expect.poll(() => activeIsBody(page)).toBe(false)
})

// 撤销一条以后焦点不落到另一条提示的「撤销」上：再按一次回车不会又撤掉一处
// After one 撤销, focus never lands on another toast's 撤销: pressing Enter again cannot silently undo another edit
test('撤销以后焦点不落到另一条的「撤销」上', async ({ page }) => {
  await page.goto('/config?section=mapping')
  for (const [domain, target] of [['x.home.arpa', '192.168.1.20'], ['y.home.arpa', '192.168.1.21']]) {
    await page.getByLabel('要映射的域名').fill(domain)
    await page.getByLabel('回答的 IP 或域名').fill(target)
    await page.getByRole('button', { name: '添加', exact: true }).click()
  }
  for (const domain of ['x.home.arpa', 'y.home.arpa']) {
    await page.getByRole('button', { name: `${domain} 的操作` }).click()
    await page.getByRole('menuitem', { name: '删除' }).click()
  }
  const undos = page.locator('.toast').getByRole('button', { name: '撤销' })
  await expect(undos).toHaveCount(2)
  await undos.last().focus()
  await page.keyboard.press('Enter')
  await expect(undos).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('.toast-stack')))).toBe(false)
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(false)
})

// 删掉列表里靠后的一条：焦点落到下一条，不跳回第一条 / Deleting a row further down: focus lands on the next row, not back on the first
test('删掉一条域名映射，焦点落到下一条', async ({ page }) => {
  await page.goto('/config?section=mapping')
  for (const [domain, target] of [['a.home.arpa', '192.168.1.10'], ['b.home.arpa', '192.168.1.11'], ['c.home.arpa', '192.168.1.12']]) {
    await page.getByLabel('要映射的域名').fill(domain)
    await page.getByLabel('回答的 IP 或域名').fill(target)
    await page.getByRole('button', { name: '添加', exact: true }).click()
  }
  await expect(page.locator('[data-rw]')).toHaveCount(3)
  await page.getByRole('button', { name: 'b.home.arpa 的操作' }).click()
  await page.getByRole('menuitem', { name: '删除' }).click()
  await expect(page.locator('[data-rw]')).toHaveCount(2)
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-rw]')?.textContent ?? '')).toContain('c.home.arpa')
})
