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
  // 宽屏的「内容」列写推荐的列表拦什么 / The wide 内容 column says what a suggested list blocks
  await expect(page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).locator('.bl__about')).toHaveText('AdGuard 官方维护，广告和跟踪')
  await page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true }).fill('! 自己加的\n||ad.example.com^\n@@||s.example.com^\n||x.example^$client=10.0.0.1')
  const problems = page.locator('.bl__problem')
  await expect(problems).toHaveCount(1)
  await expect(problems).toContainText('第 4 行')
  await expect(problems).toContainText('还不支持 $client')

  await page.locator('.desktop-nav').getByRole('link', { name: '规则', exact: true }).click()
  const pin = page.locator('.rpin', { hasText: '拦截列表' })
  await expect(pin).toContainText('AdGuard DNS filter，自己写的规则 2 条，先于下面所有规则')
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
  await expect(diff).toContainText('拦截列表 · 自己写的规则')
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

test('合成还没回来就保存：等合成落地再存，存下的文件就是按现在的订阅合成的', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter', 'OISD big'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  // 关掉一个马上保存：保存先等这次合成，之后不会再冒出一处「还没保存」 / Switch one off and save at once: the save waits for this build, and no
  // 「not saved yet」 change turns up afterwards
  await page.getByRole('checkbox', { name: '启用 OISD big', exact: true }).uncheck({ force: true })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  // 保存条做完会收起：看的是这期间没有冒出「还没保存」「已修改」 / The save bar folds away when done: what matters is that no 还没保存 or 已修改
  // turns up meanwhile
  await page.waitForTimeout(1000)
  await expect(page.locator('.cfg__savebar', { hasText: /还没保存|已修改/ })).toHaveCount(0)
  await page.locator('.desktop-nav').getByRole('link', { name: '规则', exact: true }).click()
  await expect(page.locator('.rpin', { hasText: '拦截列表' })).toContainText('AdGuard DNS filter，先于下面所有规则')
})

test('立即更新：草稿没有别的修改时直接存成新版本；有修改时放进草稿', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  // 演示里同一秒下载的是同一份：隔开一秒，这次才是新的一份 / In the demo a download within the same second is the same copy: a second apart, this one is new
  await page.waitForTimeout(1100)
  const row = page.locator('.bl__row', { hasText: 'AdGuard DNS filter' })
  await row.getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效', { timeout: 5000 })
  await expect(page.locator('.cfg__savebar', { hasText: '已修改' })).toHaveCount(0)
  await page.getByRole('button', { name: '更多配置操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '历史版本', exact: true }).click()
  await expect(page.locator('.hist__row').first()).toContainText('手动更新拦截列表')
  await page.keyboard.press('Escape')

  // 有没保存的修改：新的一份放进草稿 / With unsaved edits: the new copy goes into the draft
  await page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true }).fill('||ad.example.com^')
  await page.waitForTimeout(1100)
  await row.getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '新的一份已放进草稿，保存后生效' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.cfg__savebar')).toContainText('已修改 2 处')
})

test('自己粘贴的列表先叫「文件名 · 主机」，下载下来带着标题就用标题', async ({ page }) => {
  await open(page)
  await page.getByLabel('列表的链接').fill('https://RAW.githubusercontent.com/hagezi/dns-blocklists/main/adblock/light.txt')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.locator('.bl__row').first()).toContainText('light.txt · raw.githubusercontent.com')
  await expect(page.locator('.bl__row').first()).toContainText("HaGeZi's Light DNS Blocklist", { timeout: 5000 })
  // 同一个链接换种写法不能再加一次 / The same link written another way cannot be added again
  await page.getByLabel('列表的链接').fill('https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/light.txt')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('已经订阅了这个列表')
})

test('连删两个再先后撤销，顺序照旧', async ({ page }) => {
  await open(page)
  const names = ['AdGuard DNS filter', 'HaGeZi Pro', 'OISD big', 'anti-AD']
  await subscribe(page, names)
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  for (const name of ['HaGeZi Pro', 'OISD big']) {
    await page.locator('.bl__row', { hasText: name }).getByRole('button', { name: `${name} 的操作`, exact: true }).click()
    await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  }
  for (const name of ['HaGeZi Pro', 'OISD big']) await page.locator('.toast', { hasText: name }).getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.locator('.bl__nm b')).toHaveText(names)
})

test('推荐的列表不能越过 32 个的上限', async ({ page }) => {
  await open(page)
  for (let i = 0; i < 28; i++) {
    await page.getByLabel('列表的链接').fill(`https://lists.example.org/l${i}.txt`)
    await page.getByRole('button', { name: '添加', exact: true }).click()
  }
  await expect(page.locator('.bl__row')).toHaveCount(28)
  await page.getByRole('button', { name: '推荐的列表', exact: true }).first().click()
  const dialog = page.locator('dialog[open]')
  await expect(dialog).toContainText('还能再订阅 4 个')
  for (const name of ['AdGuard DNS filter', 'HaGeZi Pro', 'OISD big', 'anti-AD']) await dialog.locator('.blp__item', { hasText: name }).click()
  await expect(dialog.locator('.blp__item', { hasText: 'AdAway' }).locator('input')).toBeDisabled()
  await dialog.getByRole('button', { name: '订阅 4 个', exact: true }).click()
  await expect(page.locator('.bl__row')).toHaveCount(32)
})

test('自动更新没改成时，下拉框退回原来的值', async ({ page }) => {
  await open(page)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-panel-down', 'true'))
  const select = page.getByRole('combobox', { name: '自动更新', exact: true })
  await select.selectOption('24')
  await expect(page.locator('.toast', { hasText: '自动更新没有改成「每天」' })).toBeVisible()
  await expect(select).toHaveValue('0')
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-panel-down'))
})

test('手机上点底部菜单的暗处只收起菜单，不碰下面的开关 @responsive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '桌面上「…」菜单是浮层，没有遮罩 / on desktop the 「…」 menu floats, with no backdrop')
  await open(page)
  await subscribe(page, ['AdGuard DNS filter', 'anti-AD'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const toggle = page.getByRole('checkbox', { name: '启用 AdGuard DNS filter', exact: true })
  const box = await toggle.locator('xpath=..').boundingBox()
  await page.locator('.bl__row', { hasText: 'anti-AD' }).getByRole('button', { name: 'anti-AD 的操作', exact: true }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(toggle).toBeChecked()
  await expect(page).toHaveURL(/section=blocklists/)
})
