import { expect, test, type Page } from '@playwright/test'

// 拦截列表：从推荐的列表订阅，先下载、下完给出条数；没用上的行看得到原因；规则页最上面多一行「拦截列表」；保存以后历史版本里说得出改了什么。
// 演示模式下的下载是假的（src/api/mock-blocklists.ts）。
// Blocklists: subscribing from the suggested lists downloads first and shows counts once done; unused lines show why; the rules page gains a
// 拦截列表 row at the top; after saving, the version history says what changed. Downloads are pretend in demo mode (src/api/mock-blocklists.ts).

async function open(page: Page): Promise<void> {
  await page.goto('/config?section=blocklists')
  await expect(page.locator('.cfg__panel')).toBeVisible()
}

// 记下出现过的每一条提示：信息提示几秒就自己收起，事后看不到 / Record every toast raised: info toasts close by themselves within seconds and are gone afterwards
async function trackToasts(page: Page): Promise<() => Promise<string>> {
  await page.evaluate(() => {
    const seen: string[] = []
    ;(window as unknown as { __toasts: string[] }).__toasts = seen
    new MutationObserver(() => { for (const t of document.querySelectorAll('.toast')) { const text = t.textContent ?? ''; if (!seen.includes(text)) seen.push(text) } })
      .observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  return () => page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts.join(' | '))
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
  await expect(pin).toContainText('AdGuard DNS filter，自己写的规则 2 条')
  await expect(pin).not.toContainText('先于')
  // 用户定的：规则页最上面那两行任何宽度都不写「先于下面所有规则」 / The user's call: the two rows atop the rules page never say 「先于下面所有规则」
  await expect(page.locator('.rpin .rrow__cond', { hasText: '先于' })).toHaveCount(0)
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
  await expect(page.locator('.rpin', { hasText: '拦截列表' })).toContainText('AdGuard DNS filter')
  await expect(page.locator('.rpin', { hasText: '拦截列表' })).not.toContainText('先于')
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
  await expect(page.locator('.rpin', { hasText: '拦截列表' })).toContainText('AdGuard DNS filter')
  await expect(page.locator('.rpin', { hasText: '拦截列表' })).not.toContainText('先于')
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
  await expect(dialog).toContainText('这次还能选 4 个')
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
  await expect(page.locator('.toast', { hasText: '拦截列表的自动更新没改成「每天」' })).toBeVisible()
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

test('先点校验再点保存：保存也等合成落地，存下的文件对得上', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter', 'OISD big'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await page.getByRole('checkbox', { name: '启用 OISD big', exact: true }).uncheck({ force: true })
  await page.getByRole('button', { name: '校验', exact: true }).click()
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效', { timeout: 5000 })
  await page.waitForTimeout(1000)
  await expect(page.locator('.cfg__savebar', { hasText: /还没保存|已修改/ })).toHaveCount(0)
  await page.locator('.desktop-nav').getByRole('link', { name: '规则', exact: true }).click()
  await expect(page.locator('.rpin', { hasText: '拦截列表' })).toContainText('AdGuard DNS filter')
  await expect(page.locator('.rpin', { hasText: '拦截列表' })).not.toContainText('先于')
})

test('等合成时离开配置页、马上回来：不问也不重读，这次保存照常做完', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  // 新加的要下载 1.6 秒：按下保存就先等它 / The new one takes 1.6 s to download: the save waits for it first
  await page.getByLabel('列表的链接').fill('https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/light.txt')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('等拦截列表合成')
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.locator('.desktop-nav').getByRole('link', { name: '拦截列表', exact: true }).click()
  await expect(page.locator('.bl__row', { hasText: "HaGeZi's Light DNS Blocklist" })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.cfg__savebar', { hasText: /还没保存|已修改/ })).toHaveCount(0, { timeout: 5000 })
})

test('删掉以后从推荐里加回来：删除提示收起，撤销不会做出两行', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter', 'anti-AD'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.locator('.bl__row', { hasText: 'anti-AD' }).getByRole('button', { name: 'anti-AD 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '已删除「anti-AD」' })).toBeVisible()
  await page.getByRole('button', { name: '推荐的列表', exact: true }).first().click()
  await page.locator('dialog[open] .blp__item', { hasText: 'anti-AD' }).click()
  await page.locator('dialog[open]').getByRole('button', { name: '订阅 1 个', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '已删除「anti-AD」' })).toHaveCount(0)
  await expect(page.locator('.bl__row', { hasText: 'anti-AD' })).toHaveCount(1)
})

test('连不上面板时立即更新：只说没能重新下载，不再说列表没有变化', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-panel-down', 'true'))
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '没能重新下载：连不上面板' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.toast', { hasText: /最新|没有变化/ })).toHaveCount(0)
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-panel-down'))
  // 再下一次成功了：那条红色提示收起，不和成功的提示叠在一起 / The next download succeeds: the red toast goes instead of stacking with the success
  await page.waitForTimeout(1100)
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '已换上新下载的拦截列表' })).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.toast', { hasText: '没能重新下载' })).toHaveCount(0)
})

test('立即更新途中离开又回来、回来时那次读晚于下载落地：存上的就是草稿里的，没有多出修改', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await page.waitForTimeout(1100)
  // 读要 1.5 秒：回来时的那次读一定晚于 1.6 秒的下载落地 / Reads take 1.5 s, so the return's read always lands after the 1.6 s download
  await page.evaluate(() => localStorage.setItem('kixdns:demo-read-slow', 'true'))
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  // 真的离开了配置页（页面卸下），再回来 / Really off the config page (the page unmounted), then back
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await expect(page.locator('.cfg__panel')).toHaveCount(0)
  await page.locator('.desktop-nav').getByRole('link', { name: '拦截列表', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '已换上新下载的拦截列表' })).toBeVisible({ timeout: 10000 })
  await page.waitForTimeout(2000)
  await expect(page.locator('.cfg__savebar', { hasText: /还没保存|已修改/ })).toHaveCount(0)
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-read-slow'))
})

test('有修改时立即更新、离开时选了放弃修改：下好就直接存成新版本，回来没有修改', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await page.waitForTimeout(1100)
  await page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true }).fill('||ad.example.com^')
  const toasts = await trackToasts(page)
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page.locator('.toast', { hasText: /已换上新下载的拦截列表（版本.#\d+）/ })).toBeVisible({ timeout: 8000 })
  expect(await toasts()).not.toMatch(/放进草稿|草稿换掉了/)
  await page.locator('.desktop-nav').getByRole('link', { name: '拦截列表', exact: true }).click()
  await expect(page.locator('.bl__row', { hasText: 'AdGuard DNS filter' })).toBeVisible()
  await expect(page.locator('.cfg__savebar', { hasText: /还没保存|已修改/ })).toHaveCount(0, { timeout: 5000 })
  await expect(page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true })).toHaveValue('')
})

test('等合成时离开、这时面板断了：草稿留着，提示说清，回来还在', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await page.getByLabel('列表的链接').fill('https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/light.txt')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('等拦截列表合成')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-panel-down', 'true'))
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '配置没有保存：连不上面板' })).toBeVisible({ timeout: 8000 })
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-panel-down'))
  await page.locator('.desktop-nav').getByRole('link', { name: '拦截列表', exact: true }).click()
  await expect(page.locator('.bl__row')).toHaveCount(2, { timeout: 8000 })
})

test('校验途中又改了订阅再保存：校验回来后照常等合成、保存，不被吞掉', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter', 'OISD big'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-validate-slow', 'true'))
  await page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true }).fill('||ad.example.com^')
  await page.getByRole('button', { name: '校验', exact: true }).click()
  await page.getByRole('checkbox', { name: '启用 OISD big', exact: true }).uncheck({ force: true })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效', { timeout: 15000 })
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-validate-slow'))
  await page.waitForTimeout(1000)
  await expect(page.locator('.cfg__savebar', { hasText: /还没保存|已修改/ })).toHaveCount(0)
  await page.locator('.desktop-nav').getByRole('link', { name: '规则', exact: true }).click()
  await expect(page.locator('.rpin', { hasText: '拦截列表' })).toContainText('AdGuard DNS filter，自己写的规则 1 条')
  await expect(page.locator('.rpin', { hasText: '拦截列表' })).not.toContainText('先于')
})

test('重下也没用（404）时不叫人重新下载，说删掉换个链接；和能重下的一起时两句各说各的', async ({ page }) => {
  await open(page)
  await page.getByLabel('列表的链接').fill('https://lists.example.org/missing/hosts.txt')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.locator('.bl__causes')).toContainText('服务器返回 HTTP 404，链接可能失效了', { timeout: 5000 })
  await expect(page.locator('.bl__causes')).toContainText('重新下载也是一样：要换链接，先删掉它，再粘贴新的。')
  await expect(page.locator('.bl__causes')).not.toContainText('立即更新')
  await page.getByLabel('列表的链接').fill('https://lists.example.org/fail/other.txt')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.locator('.bl__causes')).toContainText('「hosts.txt · lists.example.org」重新下载也是一样：要换链接，先删掉它，再粘贴新的。', { timeout: 5000 })
  await expect(page.locator('.bl__causes')).toContainText('要重新下载，点「other.txt」那一行「…」里的「立即更新」。')
})

test('删掉又加回来以后立即更新：保存条说没改，更新就直接生效', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter', 'anti-AD'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  // 删掉 AdGuard 再从推荐里加回来：排到了最后，保存条说没改 / Remove AdGuard and add it back from the suggestions: it goes last and the save bar sees no change
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  await page.getByRole('button', { name: '推荐的列表', exact: true }).first().click()
  await page.locator('dialog[open] .blp__item', { hasText: 'AdGuard DNS filter' }).click()
  await page.locator('dialog[open]').getByRole('button', { name: '订阅 1 个', exact: true }).click()
  await expect(page.locator('.cfg__savebar', { hasText: /还没保存|已修改/ })).toHaveCount(0, { timeout: 5000 })
  await page.waitForTimeout(1100)
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '已换上新下载的拦截列表' })).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.toast', { hasText: '放进草稿' })).toHaveCount(0)
})

test('放弃的修改里有订阅变化时，离开后立即更新照样直接生效', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await page.waitForTimeout(1100)
  // 草稿里多一个订阅（马上开始下载），再立即更新 AdGuard / One more subscription in the draft (downloading at once), then 立即更新 on AdGuard
  await page.getByLabel('列表的链接').fill('https://lists.example.org/extra/hosts.txt')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  // 等它下完：立即更新那次合成按带着它的订阅发出去，离开时的放弃才会让它落地时对不上 / Let it finish: the 立即更新 build then goes out with it among the
  // subscriptions, so the discard on leaving makes it land mismatched
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const toasts = await trackToasts(page)
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page.locator('.toast', { hasText: /已换上新下载的拦截列表（版本.#\d+）/ })).toBeVisible({ timeout: 10000 })
  expect(await toasts()).not.toMatch(/草稿换掉了|放进草稿/)
  await page.locator('.desktop-nav').getByRole('link', { name: '拦截列表', exact: true }).click()
  await expect(page.locator('.bl__row')).toHaveCount(1)
  await expect(page.locator('.cfg__savebar', { hasText: /还没保存|已修改/ })).toHaveCount(0, { timeout: 5000 })
})

test('立即更新途中又改了、按保存、马上离开：那次保存做完，新的一份接着存成版本，回来没有修改', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await page.waitForTimeout(1100)
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  const toasts = await trackToasts(page)
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true }).fill('||ad.example.com^')
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await expect(page.locator('.cfg__panel')).toHaveCount(0)
  await expect(page.locator('.toast', { hasText: /已换上新下载的拦截列表（版本.#\d+）/ })).toBeVisible({ timeout: 10000 })
  await page.waitForTimeout(500)
  expect(await toasts()).not.toContain('放进草稿')
  await page.locator('.desktop-nav').getByRole('link', { name: '拦截列表', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true })).toHaveValue('||ad.example.com^')
  await expect(page.locator('.cfg__savebar', { hasText: /还没保存|已修改/ })).toHaveCount(0, { timeout: 5000 })
})

test('有修改时立即更新、新的一份已经放进草稿，离开时放弃：照样直接存成版本', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await page.waitForTimeout(1100)
  await page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true }).fill('||ad.example.com^')
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '新的一份已放进草稿，保存后生效' })).toBeVisible({ timeout: 5000 })
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '已换上新下载的拦截列表' })).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.toast', { hasText: '放进草稿' })).toHaveCount(0)
  await page.locator('.desktop-nav').getByRole('link', { name: '拦截列表', exact: true }).click()
  await expect(page.locator('.cfg__savebar', { hasText: /还没保存|已修改/ })).toHaveCount(0, { timeout: 5000 })
  await expect(page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true })).toHaveValue('')
})

test('立即更新在恢复版本途中落地：不和恢复撞成「别处改过了」，照草稿换掉说', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  // 记下这一版，再存一版，好恢复回带着 AdGuard 的这一版 / Note this version and save one more, so the restore goes back to the one with AdGuard
  const withList = Number(/版本 #(\d+)/.exec(await page.locator('.cfg__savebar').innerText())![1])
  await page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true }).fill('||ad.example.com^')
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText(`版本 #${withList + 1}`)
  await page.waitForTimeout(1100)
  const toasts = await trackToasts(page)
  // 下载 2.2 秒、读 1.5 秒：下载落在恢复以后那次读的途中；快一点慢一点也只是落在恢复之后，两种都该说「草稿换掉了」
  // A 2.2 s download and 1.5 s reads: the download lands during the read after the restore; faster or slower it lands after the restore, and both should
  // say the draft was replaced
  await page.evaluate(() => localStorage.setItem('kixdns:demo-download-slow', '2200'))
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await page.getByRole('button', { name: '更多配置操作' }).click()
  await page.getByRole('menuitem', { name: '历史版本' }).click()
  await page.locator('dialog.hist[open]').getByRole('button', { name: `版本 #${withList} 的操作` }).click()
  await page.getByRole('menuitem', { name: '和当前比较' }).click()
  const restore = page.locator('dialog.diffd[open]').getByRole('button', { name: `恢复为版本 #${withList}` })
  await expect(restore).toBeEnabled()
  await page.evaluate(() => localStorage.setItem('kixdns:demo-read-slow', 'true'))
  await restore.click()
  await page.locator('dialog.confirm[open]').getByRole('button', { name: `恢复为版本 #${withList}` }).click()
  await expect.poll(toasts, { timeout: 10000 }).toContain('下载途中草稿换掉了')
  await expect(page.locator('.cfg__savebar', { hasText: '别处改过了' })).toHaveCount(0)
  expect(await toasts()).toContain(`已恢复为版本 #${withList}`)
  await page.evaluate(() => { localStorage.removeItem('kixdns:demo-read-slow'); localStorage.removeItem('kixdns:demo-download-slow') })
})

test('新的一份已经放进草稿、之后又加了一个列表，离开时放弃：照样直接存成版本', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await page.waitForTimeout(1100)
  await page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true }).fill('||ad.example.com^')
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '新的一份已放进草稿，保存后生效' })).toBeVisible({ timeout: 5000 })
  // 落地以后又改了启用的那组订阅 / The enabled subscriptions change after it landed
  await page.getByRole('button', { name: '推荐的列表', exact: true }).first().click()
  await page.locator('dialog[open] .blp__item', { hasText: 'anti-AD' }).click()
  await page.locator('dialog[open]').getByRole('button', { name: '订阅 1 个', exact: true }).click()
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page.locator('.toast', { hasText: /已换上新下载的拦截列表（版本.#\d+）/ })).toBeVisible({ timeout: 8000 })
  await page.locator('.desktop-nav').getByRole('link', { name: '拦截列表', exact: true }).click()
  await expect(page.locator('.bl__row')).toHaveCount(1)
  await expect(page.locator('.cfg__savebar', { hasText: /还没保存|已修改/ })).toHaveCount(0, { timeout: 5000 })
})

test('保存慢的时候连着点两个列表的立即更新：两次都存成版本，最后没有修改', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter', 'anti-AD'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await page.waitForTimeout(1100)
  const toasts = await trackToasts(page)
  // 保存要 3 秒：第二份落在第一份的保存途中 / Saving takes 3 s: the second copy lands during the first one's save
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-slow', '3000'))
  for (const name of ['AdGuard DNS filter', 'anti-AD']) {
    await page.locator('.bl__row', { hasText: name }).getByRole('button', { name: `${name} 的操作`, exact: true }).click()
    await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
    await page.waitForTimeout(300)
  }
  await expect.poll(async () => ((await toasts()).match(/已换上新下载的拦截列表/g) ?? []).length, { timeout: 20000 }).toBe(2)
  await expect(page.locator('.cfg__savebar', { hasText: /还没保存|已修改/ })).toHaveCount(0, { timeout: 8000 })
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

test('草稿干净时点重新读取，立即更新落在读的途中：照常存成版本', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await page.waitForTimeout(1100)
  const toasts = await trackToasts(page)
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  // 读要 1.5 秒：1.6 秒的下载落在这次重新读取的途中 / Reads take 1.5 s: the 1.6 s download lands during this re-read
  await page.evaluate(() => localStorage.setItem('kixdns:demo-read-slow', 'true'))
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: '更多配置操作' }).click()
  await page.getByRole('menuitem', { name: '重新读取配置' }).click()
  await expect.poll(toasts, { timeout: 12000 }).toContain('已换上新下载的拦截列表')
  expect(await toasts()).not.toContain('草稿换掉了')
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-read-slow'))
})

test('失败说明末尾：手机上最多点名两个，宽屏点名到五个 @responsive', async ({ page }) => {
  await open(page)
  for (const url of ['https://lists.example.org/missing/a.txt', 'https://lists.example.org/missing/b.txt', 'https://lists.example.org/missing/c.txt', 'https://lists.example.org/fail/d.txt']) {
    await page.getByLabel('列表的链接').fill(url)
    await page.getByRole('button', { name: '添加', exact: true }).click()
    await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  }
  const causes = page.locator('.bl__causes')
  if ((page.viewportSize()?.width ?? 1440) < 640) await expect(causes).toContainText('其中 3 个重新下载也是一样')
  else await expect(causes).toContainText('「a.txt · lists.example.org」「b.txt · lists.example.org」「c.txt · lists.example.org」重新下载也是一样')
  await expect(causes).toContainText('要重新下载，点「d.txt」那一行「…」里的「立即更新」。')
})


// 页上点立即更新、校验被拒：红色提示指到保存栏，失败过去了就收起；放弃修改、重新读取都回到干净的页面，同意放弃以后离开也不再补存
// 立即更新 on the page, rejected at validation: the red toast points to the save bar and goes once the failure is over; 放弃修改 and 重新读取 both return
// to a clean page, and once a drop was agreed, leaving saves nothing later
test('立即更新在页上没存上：失败过去了提示就收起；放弃修改、重新读取都回到干净的页面', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  const failed = page.locator('.toast', { hasText: '新下载的拦截列表没能存上，原因写在保存栏' })
  const updateFails = async () => {
    await page.waitForTimeout(1100)
    await page.evaluate(() => localStorage.setItem('kixdns:demo-validate-reject', 'true'))
    await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
    await expect(failed).toBeVisible({ timeout: 6000 })
    await expect(bar).toContainText('没有通过校验')
  }
  // 自己再按一次保存，这次存上了 / Saved by hand the second time
  await updateFails()
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  await expect(failed).toHaveCount(0)
  // 放弃修改：保存栏收起，不停在说那份已经不在的草稿的「没有通过校验」上 / 放弃修改: the bar folds away instead of staying on 没有通过校验 about a draft gone
  await updateFails()
  await bar.getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(bar).toHaveCount(0)
  await expect(failed).toHaveCount(0)
  // 重新读取并同意放弃：换成面板上的那份，和确认框说的一样；离开时也不再补存 / Re-read and agree to drop: the panel's copy comes in, as the confirm said,
  // and leaving saves nothing later
  await updateFails()
  const toasts = await trackToasts(page)
  await page.getByRole('button', { name: '更多配置操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '重新读取配置', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改并重新读取', exact: true }).click()
  // 读的时候保存栏也收着：读完再看 / The bar is hidden while reading too: look once the read is done
  await expect.poll(() => page.evaluate(async () => (await import('/src/config-v2/useConfigDocument.ts')).loading.value)).toBe(false)
  await expect(bar).toHaveCount(0)
  await expect(failed).toHaveCount(0)
  // 之后一次无关的离开时放弃：那次没存上的新文件已经同意不要了，不补存，也不说草稿换掉了 / A later unrelated discard on leaving: the unsaved new file was
  // already agreed away, so nothing is saved and nothing says the draft was replaced
  await page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true }).fill('||after-reread.example^')
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await page.waitForTimeout(3000)
  expect(await toasts()).not.toContain('已换上新下载的拦截列表')
  expect(await toasts()).not.toContain('草稿换掉了')
})

// 写进去了、回应没回来：人在页上，先说不知道存上没有（不说没能存上），连上核对完换成结果
// Written but the answer never came back, with the user on the page: first it says whether it landed is unknown (not that it failed), and the check
// after reconnecting replaces that with the result
test('立即更新在页上存的时候回应丢了：先说不知道存上没有，连上核对完换成结果', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  await page.waitForTimeout(1100)
  const toasts = await trackToasts(page)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-put-answer-lost', 'true'))
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  const unknown = page.locator('.toast', { hasText: '新下载的拦截列表：不知道存上没有，连不上面板。连上后会自己核对' })
  await expect(unknown).toBeVisible({ timeout: 6000 })
  await expect(page.locator('.conn__inner')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('.toast', { hasText: /新下载的拦截列表已经存上了：版本 #\d+ 已生效/ })).toBeVisible({ timeout: 8000 })
  await expect(unknown).toHaveCount(0)
  expect(await toasts()).not.toContain('没能存上')
})

// 新的一份跟着订阅变化一起存上了（存下的文件不是落地的那份，可里面带着它）：之后别处又换了服务端的副本，离开时放弃也不再替人存一个「手动更新拦截列表」
// The new copy was saved along with a subscription change (the saved file is not the one landed, but it carries it): after the server's copy is swapped
// elsewhere, a discard on leaving no longer saves a 「手动更新拦截列表」 for the user
test('新的一份跟着订阅变化一起存上以后，离开时放弃不再补存', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter', 'anti-AD'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  await page.waitForTimeout(1100)
  const own = page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true })
  await own.fill('||carried.example^')
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '新的一份已放进草稿，保存后生效' })).toBeVisible({ timeout: 5000 })
  // 停用 anti-AD：再合成出来的文件也带着刚下好的那份，一起保存 / Switch anti-AD off: the rebuilt file carries the fresh copy too, saved together
  await page.getByRole('checkbox', { name: /^启用 anti-AD/ }).evaluate((e: HTMLElement) => e.click())
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效', { timeout: 8000 })
  // 像另一台设备点了立即更新：服务端换了 AdGuard 的副本，没写配置 / As if another device pressed 立即更新: the server's AdGuard copy changes, no config written
  await page.waitForTimeout(1100)
  await page.evaluate(async () => {
    const { apiRequest } = await import('/src/api/client.ts')
    const { model } = await import('/src/config-v2/store.ts')
    const subscriptions = model.blocklists.subscriptions.map((s) => ({ url: s.url, enabled: s.enabled }))
    const adguard = model.blocklists.subscriptions.find((s) => s.name === 'AdGuard DNS filter')!.url
    await apiRequest('/api/v1/config/blocklists/build', { method: 'POST', body: JSON.stringify({ subscriptions, refresh: [adguard] }) })
  })
  const toasts = await trackToasts(page)
  await own.fill('||later.example^')
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await page.waitForTimeout(3500)
  expect(await toasts()).not.toContain('已换上新下载的拦截列表')
})

// 新的一份放进草稿以后在配置页上退出登录：会话结束时它一起放下，再登录以后离开时放弃，不会存出上一个会话的那次下载（用户定的）
// Signing out on the config page with the new copy in the draft: it goes when the session ends, so after signing in again a discard on leaving does not
// save the previous session's download (the user's call)
test('立即更新放进草稿以后退出登录：再登录以后离开时放弃，不补存上一个会话的那次', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  await page.waitForTimeout(1100)
  const own = page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true })
  await own.fill('||before-signout.example^')
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '新的一份已放进草稿，保存后生效' })).toBeVisible({ timeout: 5000 })
  await page.locator('.account-button').click()
  await page.getByRole('button', { name: '退出登录' }).click()
  await page.getByRole('alertdialog', { name: '放弃未保存的修改' }).getByRole('button', { name: '放弃并退出' }).click()
  await expect(page).toHaveURL(/\/login/)
  await page.getByLabel('用户名').fill('admin')
  await page.getByLabel('密码', { exact: true }).fill('demo-password')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.locator('.desktop-nav').getByRole('link', { name: '拦截列表', exact: true }).click()
  await expect(page.locator('.bl__row', { hasText: 'AdGuard DNS filter' })).toBeVisible()
  // 等回来那次读读完，不然它会把下面写的冲掉 / Wait for the read on coming back, or it washes away what is typed below
  await expect.poll(() => page.evaluate(async () => (await import('/src/config-v2/useConfigDocument.ts')).loading.value)).toBe(false)
  await expect(bar).toHaveCount(0)
  const toasts = await trackToasts(page)
  await own.fill('||after-signin.example^')
  await expect(bar).toContainText('已修改 1 处')
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await page.waitForTimeout(3500)
  expect(await toasts()).not.toContain('已换上新下载的拦截列表')
})

// 页上立即更新、存的时候撞上「别处改过了」：重新读取会换掉草稿，新的一份跟着没了，所以说要再点一次；重新读取以后这条收起
// 立即更新 on the page meets 别处改过了 when saving: re-reading replaces the draft and the new copy with it, so it says to press again; once re-read
// the toast goes
test('立即更新在页上撞上别处改过了：说先重新读取再点一次，重新读取以后提示收起', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  await page.waitForTimeout(1100)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-conflict', 'true'))
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  const told = page.locator('.toast', { hasText: '新的一份存不上：这份配置在别处改过了；先重新读取，再点一次「立即更新」' })
  await expect(told).toBeVisible({ timeout: 6000 })
  await expect(bar).toContainText('这份配置在别处改过了')
  await bar.getByRole('button', { name: '重新读取', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改并重新读取', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await import('/src/config-v2/useConfigDocument.ts')).loading.value)).toBe(false)
  await expect(told).toHaveCount(0)
  await expect(bar).toHaveCount(0)
})

// 立即更新在页上没存上，离开时同意放弃：那条指到保存栏的红色提示跟着收起（别的页上没有保存栏），新的一份照样直接存成版本（用户定的）
// 立即更新 not saved on the page, then a discard agreed on leaving: the red toast pointing to the save bar goes along (other pages have none), and the new
// copy is still saved directly as a version (the user's call)
test('立即更新在页上没存上以后离开并放弃：红色提示跟着收起，新的一份照样存成版本', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  await page.waitForTimeout(1100)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-validate-reject', 'true'))
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  const failed = page.locator('.toast', { hasText: '新下载的拦截列表没能存上，原因写在保存栏' })
  await expect(failed).toBeVisible({ timeout: 6000 })
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await expect(page.locator('.toast', { hasText: '已换上新下载的拦截列表' })).toBeVisible({ timeout: 8000 })
  await expect(failed).toHaveCount(0)
})

// 立即更新在页上没存上，会话过期再登录：登录页说了「没有留下来」，回来时草稿就换成面板上的那份
// 立即更新 not saved on the page, then the session expires and the user signs in again: the login page said nothing was kept, so the draft comes back as the
// panel's copy
test('立即更新在页上没存上、会话过期再登录：草稿换成面板上的那份', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  await page.waitForTimeout(1100)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-validate-reject', 'true'))
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await expect(bar).toContainText('没有通过校验', { timeout: 6000 })
  await page.evaluate(async () => {
    const { SESSION_EXPIRED_EVENT } = await import('/src/api/client.ts')
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
  })
  await expect(page).toHaveURL(/\/login\?/)
  await page.getByLabel('用户名').fill('admin')
  await page.getByLabel('密码', { exact: true }).fill('demo-password')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.locator('.bl__row', { hasText: 'AdGuard DNS filter' })).toBeVisible()
  await expect.poll(() => page.evaluate(async () => (await import('/src/config-v2/useConfigDocument.ts')).loading.value)).toBe(false)
  await expect(bar).toHaveCount(0)
})

// 页上立即更新、写入那一刻连不上面板（请求没送到，没写进去），人离开并同意放弃：连上以后只说补存的结果，不说「它留在配置页的草稿里」（草稿已经放弃了）
// 立即更新 on the page, the panel unreachable the moment it writes (the request never arrived, nothing written), then the user leaves agreeing to discard:
// once back only the make-up save's result is said, not 「it stays in the config page's draft」 (that draft was discarded)
test('立即更新在页上写入时连不上、其实没写进去，离开并放弃：连上以后只说补存的结果', async ({ page }) => {
  await page.addInitScript(() => performance.setResourceTimingBufferSize(20000))
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  await page.waitForTimeout(1100)
  // 写入这一步开始的那一刻让面板不答话：写入的请求送不到 / The instant the write step starts the panel stops answering: the write never arrives
  await page.evaluate(async () => {
    const entries = performance.getEntriesByType('resource').map((e) => e.name)
    const vue = await import(entries.find((n) => n.includes('/node_modules/.vite/deps/vue.js'))!)
    const document = await import(entries.filter((n) => n.includes('/src/config-v2/useConfigDocument.ts')).pop()!)
    let armed = true
    vue.watch(document.stage, (stage: string) => {
      if (stage !== 'applying' || !armed) return
      armed = false
      localStorage.setItem('kixdns:demo-panel-down', 'true')
      window.dispatchEvent(new Event('kixdns:panel-unreachable'))
    }, { flush: 'sync' })
  })
  const toasts = await trackToasts(page)
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  const unknown = page.locator('.toast', { hasText: '新下载的拦截列表：不知道存上没有' })
  await expect(unknown).toBeVisible({ timeout: 6000 })
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await page.evaluate(async () => {
    localStorage.removeItem('kixdns:demo-panel-down')
    const url = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/composables/useConnection.ts')).pop()!
    void (await import(url)).useConnection().retry()
  })
  await expect.poll(toasts, { timeout: 12000 }).toContain('已换上新下载的拦截列表')
  await page.waitForTimeout(1000)
  expect(await toasts()).not.toContain('它留在配置页的草稿里')
  // 离开时放弃的有补存说结果，不另说「没有存上」 / A discard on leaving has its make-up save tell the result, with no 「没有存上」 besides
  expect(await toasts()).not.toContain('新下载的拦截列表没有存上')
  await expect(unknown).toHaveCount(0)
})

// 立即更新没存上以后再点一次：真实的列表几分钟里基本不变，下到的和草稿里那份一样。在用的还是旧的那份，所以照落地收场，草稿干净就直接存（用户定的）
// 立即更新 again after one that did not save: real lists barely change within minutes, so the download matches the copy in the draft. What is in use is
// still the old one, so it ends as a landing and a clean draft is saved at once (the user's call)
test('立即更新没存上以后再点一次，下到的和草稿里那份一样：照常存成版本', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  // 演示的下载按秒变：定住时间，之后两次下到的一样 / Demo downloads change by the second: with the time fixed, the next two are the same
  await page.clock.setFixedTime(new Date(Date.now() + 5000))
  const toasts = await trackToasts(page)
  const update = async () => {
    await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  }
  await page.evaluate(() => localStorage.setItem('kixdns:demo-validate-reject', 'true'))
  await update()
  const failed = page.locator('.toast', { hasText: '新下载的拦截列表没能存上，原因写在保存栏' })
  await expect(failed).toBeVisible({ timeout: 6000 })
  await update()
  await expect(page.locator('.toast', { hasText: '已换上新下载的拦截列表' })).toBeVisible({ timeout: 8000 })
  await expect(failed).toHaveCount(0)
  expect(await toasts()).not.toContain('已经是最新的')
  await expect(page.locator('.cfg__savebar', { hasText: /还没保存|已修改/ })).toHaveCount(0)
})

// 离开以后立即更新的那次保存撞上「别处改过了」，人回到配置页、冲突还在：那条提示换成页上的说法，还说要再点一次（用户定的）
// Away from the page, 立即更新's save met 别处改过了; back on the config page with the conflict still there, the toast takes the on-page wording and still
// says to press again (the user's call)
test('离开以后立即更新撞上别处改过了，回到配置页：提示换成页上的说法', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  await page.waitForTimeout(1100)
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-download-slow', '1500'); localStorage.setItem('kixdns:demo-save-conflict', 'true') })
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  const away = page.locator('.toast', { hasText: '新下载的拦截列表没能存上：这份配置在别处改过了；回到配置页重新读取，再点一次「立即更新」' })
  await expect(away).toBeVisible({ timeout: 8000 })
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-download-slow'))
  await page.locator('.desktop-nav').getByRole('link', { name: '拦截列表', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '新的一份存不上：这份配置在别处改过了；先重新读取，再点一次「立即更新」' })).toBeVisible({ timeout: 5000 })
  await expect(away).toHaveCount(0)
  await expect(bar).toContainText('这份配置在别处改过了')
})

// 写进去了、回应丢了，断线时别处恢复了原来那一版（文件散列回到原样）：版本号动过，就不说「没有存上，可以再保存」（照做会盖掉别处那次恢复），按别处改过说
// Written with the answer lost, then another writer restored the earlier version during the outage (the file hash back as it was): the version number
// moved, so it does not say 「not saved, save again」 (that would overwrite the restore), but treats it as changed elsewhere
test('立即更新的回应丢了、断线时别处恢复了原来那一版：按别处改过说，不叫人再存', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  await page.waitForTimeout(1100)
  const toasts = await trackToasts(page)
  // 写进去了，回应没回来，面板接着不答话 / Written, no answer, and the panel stays silent
  await page.evaluate(() => {
    window.addEventListener('kixdns:panel-unreachable', () => localStorage.setItem('kixdns:demo-panel-down', 'true'), { capture: true, once: true })
    localStorage.setItem('kixdns:demo-put-answer-lost', 'true')
  })
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '新下载的拦截列表：不知道存上没有' })).toBeVisible({ timeout: 6000 })
  // 连上之前别处恢复了原来那一版：存成新版本，文件散列回到原来那样 / Before reconnecting, another writer restores the earlier version: a new version whose
  // file hash is back to what it was
  await page.evaluate(async () => {
    localStorage.setItem('kixdns:demo-changed-elsewhere', 'true')
    localStorage.removeItem('kixdns:demo-panel-down')
    const url = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/composables/useConnection.ts')).pop()!
    void (await import(url)).useConnection().retry()
  })
  await expect(page.locator('.toast', { hasText: '新下载的拦截列表：先重新读取，再点一次「立即更新」' })).toBeVisible({ timeout: 10_000 })
  await expect(bar).toContainText('这份配置在别处改过了')
  expect(await toasts()).not.toContain('没有存上，可以再保存')
})

// 页上「不知道存上没有」时断着点了「放弃修改」，其实又没写进去：连上以后照实回一句，不让许过的核对没有下文
// 「不知道存上没有」 on the page, 放弃修改 pressed during the outage, and nothing was in fact written: once back it answers plainly, so the promised check
// is not left hanging
for (const leave of [false, true]) test(`立即更新写入时连不上、在页上放弃了修改${leave ? '再离开' : ''}：连上以后说没有存上`, async ({ page }) => {
  await page.addInitScript(() => performance.setResourceTimingBufferSize(20000))
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  await page.waitForTimeout(1100)
  await page.evaluate(async () => {
    const entries = performance.getEntriesByType('resource').map((e) => e.name)
    const vue = await import(entries.find((n) => n.includes('/node_modules/.vite/deps/vue.js'))!)
    const document = await import(entries.filter((n) => n.includes('/src/config-v2/useConfigDocument.ts')).pop()!)
    let armed = true
    vue.watch(document.stage, (stage: string) => {
      if (stage !== 'applying' || !armed) return
      armed = false
      localStorage.setItem('kixdns:demo-panel-down', 'true')
      window.dispatchEvent(new Event('kixdns:panel-unreachable'))
    }, { flush: 'sync' })
  })
  const toasts = await trackToasts(page)
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  const unknown = page.locator('.toast', { hasText: '新下载的拦截列表：不知道存上没有' })
  await expect(unknown).toBeVisible({ timeout: 6000 })
  await bar.getByRole('button', { name: '放弃修改', exact: true }).click()
  // 放弃以后接着离开也一样回答（离开不问：草稿已经干净了） / Leaving right after the discard is answered all the same (no question: the draft is clean)
  if (leave) {
    await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
    await expect(page).toHaveURL(/\/logs/)
  }
  await page.evaluate(async () => {
    localStorage.removeItem('kixdns:demo-panel-down')
    const url = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/composables/useConnection.ts')).pop()!
    void (await import(url)).useConnection().retry()
  })
  await expect(page.locator('.toast', { hasText: '新下载的拦截列表没有存上' })).toBeVisible({ timeout: 10_000 })
  await expect(unknown).toHaveCount(0)
  // 草稿已经放弃了：不叫人再保存 / The draft was discarded: nobody is asked to save again
  expect(await toasts()).not.toContain('可以再保存')
})

// 离开以后，人自己那次保存和立即更新那次都撞上「别处改过了」：两条提示；回到配置页、冲突还在时只剩页上的说法，「也没存上」收起（用户定的）
// Away from the page both the user's own save and 立即更新's met 别处改过了: two toasts; back on the config page with the conflict still there only the
// on-page wording is left, and 「也没存上」 goes (the user's call)
test('离开以后自己的保存和立即更新都撞上别处改过了，回到配置页：只剩页上的说法', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  await page.waitForTimeout(1100)
  await page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true }).fill('||mine.example^')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-download-slow', '2500'))
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', '1500'); localStorage.setItem('kixdns:demo-save-conflict', 'true') })
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  const also = page.locator('.toast', { hasText: '新下载的拦截列表也没存上：回到配置页重新读取，再点一次「立即更新」' })
  await expect(page.locator('.toast', { hasText: '配置没有保存：这份配置在别处改' })).toBeVisible({ timeout: 8000 })
  await expect(also).toBeVisible({ timeout: 8000 })
  await page.evaluate(() => { localStorage.removeItem('kixdns:demo-download-slow'); localStorage.removeItem('kixdns:demo-save-slow') })
  await page.locator('.desktop-nav').getByRole('link', { name: '拦截列表', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '新的一份存不上：这份配置在别处改过了；先重新读取，再点一次「立即更新」' })).toBeVisible({ timeout: 5000 })
  await expect(also).toHaveCount(0)
  await expect(page.locator('.toast', { hasText: '配置没有保存' })).toHaveCount(0)
})

// 离开以后核对出新下载的那份被别处盖掉，回到配置页：只说保存栏没说的那一步；不重新读取又离开并放弃：页上那句跟着收起，补存那次只说一条，不说「也」
// Found overwritten elsewhere while away, then back on the config page: only the step the bar lacks; leaving again with a discard and no re-read: the
// on-page sentence goes, and the make-up save says one toast, without 「也」
test('离开以后核对出被别处盖掉，回到配置页再离开并放弃：提示不叠、不留页上的说法', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  await page.waitForTimeout(1100)
  // 下载放慢，人先离开；落地以后补存写进去了、回应丢了，面板接着不答话 / The download is slowed and the user leaves first; after landing the save is written,
  // its answer lost, and the panel stays silent
  await page.evaluate(() => {
    localStorage.setItem('kixdns:demo-download-slow', '1500')
    window.addEventListener('kixdns:panel-unreachable', () => localStorage.setItem('kixdns:demo-panel-down', 'true'), { capture: true, once: true })
    localStorage.setItem('kixdns:demo-put-answer-lost', 'true')
  })
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await expect(page.locator('.toast', { hasText: '新下载的拦截列表：不知道存上没有' })).toBeVisible({ timeout: 8000 })
  await page.evaluate(async () => {
    localStorage.removeItem('kixdns:demo-download-slow')
    localStorage.setItem('kixdns:demo-changed-elsewhere', 'true')
    localStorage.removeItem('kixdns:demo-panel-down')
    const url = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/composables/useConnection.ts')).pop()!
    void (await import(url)).useConnection().retry()
  })
  await expect(page.locator('.toast', { hasText: '新下载的拦截列表：不在现在的配置里' })).toBeVisible({ timeout: 10_000 })
  await page.locator('.desktop-nav').getByRole('link', { name: '拦截列表', exact: true }).click()
  const here = page.locator('.toast', { hasText: '新下载的拦截列表：先重新读取，再点一次「立即更新」' })
  await expect(here).toBeVisible({ timeout: 5000 })
  await expect(bar).toContainText('这份配置在别处改过了')
  const toasts = await trackToasts(page)
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await expect(page.locator('.toast', { hasText: '新下载的拦截列表没能存上：这份配置在别处改过了' })).toBeVisible({ timeout: 8000 })
  await expect(here).toHaveCount(0)
  expect(await toasts()).not.toContain('也没存上')
})

// 没存上以后又点一次：人自己的保存正在跑、存上的正是这份时，说和刚存上的一样；草稿里有别的修改时，说已经在草稿里（不说又放进了一份）
// Pressed again after one that did not save: with the user's own save under way storing this very copy, it says it matches what was just saved; with other
// edits in the draft, it says the copy is already there (not that another was put in)
test('立即更新再点一次、下到的一样：保存途中说和刚存上的一样，有别的修改时说已经在草稿里', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  await page.clock.setFixedTime(new Date(Date.now() + 5000))
  const update = async () => {
    await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  }
  // 有别的修改：第一次放进草稿，第二次下到的一样 / With other edits: the first goes into the draft, the second matches it
  await page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true }).fill('||mine.example^')
  await update()
  await expect(page.locator('.toast', { hasText: '新的一份已放进草稿，保存后生效' })).toBeVisible({ timeout: 6000 })
  await update()
  await expect(page.locator('.toast', { hasText: '新的一份已经在草稿里，保存后生效' })).toBeVisible({ timeout: 6000 })
  // 保存途中再点一次：存上的正是这份 / Pressed again while saving: what gets saved is this very copy
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-slow', '2500'))
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('写入并应用')
  await update()
  await expect(page.locator('.toast', { hasText: '下载的和刚存上的一样，已经是最新的' })).toBeVisible({ timeout: 10_000 })
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

// 页上「不知道存上没有」时放弃了修改、又撤销，再离开时放弃：补存照样来，只说补存的结果，不先说「没有存上」
// 「不知道存上没有」 on the page, a discard then its undo, then a discard on leaving: the make-up save still comes and only its result is said, with no
// 「没有存上」 first
test('立即更新写入时连不上、在页上放弃又撤销，再离开并放弃：只说补存的结果', async ({ page }) => {
  await page.addInitScript(() => performance.setResourceTimingBufferSize(20000))
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  await page.waitForTimeout(1100)
  await page.evaluate(async () => {
    const entries = performance.getEntriesByType('resource').map((e) => e.name)
    const vue = await import(entries.find((n) => n.includes('/node_modules/.vite/deps/vue.js'))!)
    const document = await import(entries.filter((n) => n.includes('/src/config-v2/useConfigDocument.ts')).pop()!)
    let armed = true
    vue.watch(document.stage, (stage: string) => {
      if (stage !== 'applying' || !armed) return
      armed = false
      localStorage.setItem('kixdns:demo-panel-down', 'true')
      window.dispatchEvent(new Event('kixdns:panel-unreachable'))
    }, { flush: 'sync' })
  })
  const toasts = await trackToasts(page)
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '新下载的拦截列表：不知道存上没有' })).toBeVisible({ timeout: 6000 })
  await bar.getByRole('button', { name: '放弃修改', exact: true }).click()
  await page.locator('.toast').getByRole('button', { name: '撤销', exact: true }).click()
  await expect(bar).toContainText('已修改 1 处')
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await page.evaluate(async () => {
    localStorage.removeItem('kixdns:demo-panel-down')
    const url = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/composables/useConnection.ts')).pop()!
    void (await import(url)).useConnection().retry()
  })
  await expect.poll(toasts, { timeout: 12000 }).toContain('已换上新下载的拦截列表')
  await page.waitForTimeout(1000)
  expect(await toasts()).not.toContain('新下载的拦截列表没有存上')
})

// 提示条：「「名字」的」后面能折（不然后面一长串汉字只能硬切），连住的「KixDNS 的」后面不能折（「的原话」不拆开）；每个「，：；。」后面
// 也各有一个断点，连块里、普通字里都一样（WebKit 按词换行时不在中文标点处断）
// Toasts: a break is allowed after 「「name」的」 (else the CJK run after it could only be cut hard), not after a glued 「KixDNS 的」 (「的原话」
// stays whole); every 「，：；。」 has a break point after it too, in a glued run or plain text alike (WebKit's keep-all does not break at
// CJK punctuation)
test('提示条：「名字」的后面能折，KixDNS 的后面不能折', async ({ page }) => {
  await page.goto('/logs')
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/composables/useToast.ts')).pop()!
    const { useToast } = await import(url)
    useToast().error('「ads-and-trackers.txt」的链接只能用 https://，删掉这个列表再保存')
    useToast().error('配置没有保存：没有通过校验。KixDNS\u00a0的原话：pipeline "main" references unknown upstream group "fast"')
  })
  await expect(page.locator('.toast')).toHaveCount(2)
  const breaks = await page.locator('.toast > span').evaluateAll((spans) => spans.map((span) => [...span.querySelectorAll('.brk')].map((w) => w.previousSibling?.textContent ?? '')))
  expect(breaks).toEqual([['「ads-and-trackers.txt」的', '链接只能用 https://，'], ['存：', '验。', '话：']])
  expect(breaks[1]!.some((before) => before.startsWith('KixDNS'))).toBe(false)
})

// 订阅里留着一个总是下载失败的列表，全部更新没存上以后再点：其余的下到的一样，也照落地收场、照常存（用户定的），不一声不响
// With a list that always fails left in the subscriptions, 全部更新 again after one that did not save: the rest download the same, yet it still ends as a
// landing and saves (the user's call), never silently
test('有列表总下载失败时，全部更新没存上以后再点：照常存成版本', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await page.getByLabel('列表的链接').fill('https://lists.example.org/fail/always.txt')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效', { timeout: 8000 })
  await page.clock.setFixedTime(new Date(Date.now() + 5000))
  const all = page.getByRole('button', { name: '全部更新', exact: true }).first()
  await page.evaluate(() => localStorage.setItem('kixdns:demo-validate-reject', 'true'))
  await all.click()
  const failed = page.locator('.toast', { hasText: '新下载的拦截列表没能存上，原因写在保存栏' })
  await expect(failed).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await all.click()
  await expect(page.locator('.toast', { hasText: '已换上新下载的拦截列表' })).toBeVisible({ timeout: 10_000 })
  await expect(failed).toHaveCount(0)
})

// 草稿里只改过订阅（关掉一个列表），点另一个的立即更新、下到的没变：说和上次下载的一样，不说有新的一份（用户定的）
// Only the subscriptions changed in the draft (one list switched off), 立即更新 on another and the download is unchanged: it says the same as last downloaded,
// not that there is a new copy (the user's call)
test('只改过订阅、立即更新下到的没变：说和上次下载的一样', async ({ page }) => {
  await open(page)
  // 定住时间：之后每次下到的都一样（演示的下载按秒变） / With the time fixed every later download is the same (demo downloads change by the second)
  await page.clock.setFixedTime(new Date(Date.now() + 5000))
  await subscribe(page, ['AdGuard DNS filter', 'anti-AD'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  const toasts = await trackToasts(page)
  // 关掉以后马上点：重新合成还没落地也一样（合成的文件变了是因为订阅，不是下到了新东西） / Pressed right after switching off: the same while the rebuild has
  // not landed (the merged file changes because of the subscriptions, not because anything new was downloaded)
  await page.getByRole('checkbox', { name: /^启用 anti-AD/ }).evaluate((e: HTMLElement) => e.click())
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '下载的和上次下载的一样，已经是最新的' })).toBeVisible({ timeout: 6000 })
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.getByRole('button', { name: '全部更新', exact: true }).first().click()
  await expect(page.locator('.toast', { hasText: '下载的都和上次下载的一样，已经是最新的' })).toBeVisible({ timeout: 6000 })
  expect(await toasts()).not.toContain('新的一份')
  await expect(bar).toContainText('已修改 1 处')
})

// 上次下好的那份没存上，这时点一个总下载失败的列表的立即更新：只说它没下载成功，不顺手把上次那份存了
// The copy downloaded last time did not save, and 立即更新 is pressed on a list that always fails: only its failure is said, and the earlier copy is not
// saved along the way
for (const discard of [false, true]) test(`上次那份没存上时${discard ? '（又在页上放弃了）' : ''}点一个总下载失败的列表：只说没下载成功，不顺手存`, async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await page.getByLabel('列表的链接').fill('https://lists.example.org/fail/always.txt')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效', { timeout: 8000 })
  await page.waitForTimeout(1100)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-validate-reject', 'true'))
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '新下载的拦截列表没能存上，原因写在保存栏' })).toBeVisible({ timeout: 6000 })
  // 在页上放弃以后，服务端仍留着比在用的新的那一份：点失败的列表也不能把它存出去 / After a discard on the page the server still holds the newer copy:
  // pressing the failing list must not save it either
  if (discard) await bar.getByRole('button', { name: '放弃修改', exact: true }).click()
  const toasts = await trackToasts(page)
  await page.locator('.bl__row', { hasText: 'always.txt' }).getByRole('button', { name: /的操作$/ }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.waitForTimeout(1500)
  expect(await toasts()).toContain('没下载成功')
  expect(await toasts()).not.toContain('已换上新下载的拦截列表')
  if (!discard) await expect(bar).toContainText('没有通过校验')
})

// 离开以后先后两条成功：自己那次保存的「版本 #N 已生效」不被后来立即更新的「已换上…」顶掉
// Two results in a row away from the page: the user's own 「版本 #N 已生效」 is not pushed out by the 「已换上…」 of 立即更新 that follows
test('离开以后连着两条成功提示：前一条不被后一条顶掉', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  await page.waitForTimeout(1100)
  await page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true }).fill('||mine.example^')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-download-slow', '2500'); localStorage.setItem('kixdns:demo-save-slow', '800') })
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  const mine = page.locator('.toast', { hasText: /^版本 #\d+ 已生效$/ })
  await expect(mine).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.toast', { hasText: '已换上新下载的拦截列表' })).toBeVisible({ timeout: 8000 })
  await expect(mine).toBeVisible()
  await page.evaluate(() => { localStorage.removeItem('kixdns:demo-download-slow'); localStorage.removeItem('kixdns:demo-save-slow') })
})

// 下载途中在页上放弃了修改，照提示再点一次：服务端已经有比草稿新的那一份，这次下到的和它一样也是新东西，照常存成版本
// Edits discarded on the page mid-download, then pressed again as told: the server already holds a copy newer than the draft's, so a download matching it is
// still new and is saved as a version
test('下载途中放弃了修改、照提示再点一次立即更新：照常存成版本', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  // 定住时间：两次下到的一样，又都比已保存的新 / With the time fixed both downloads match each other and are newer than the saved copy
  await page.clock.setFixedTime(new Date(Date.now() + 5000))
  await page.getByRole('textbox', { name: '自己写的规则，一行一条', exact: true }).fill('||mine.example^')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-download-slow', '2000'))
  const update = async () => {
    await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  }
  await update()
  await bar.getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '下载途中草稿换掉了，这次下载的没有放进草稿；要用新的一份，再点一次「立即更新」' })).toBeVisible({ timeout: 6000 })
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-download-slow'))
  const toasts = await trackToasts(page)
  await update()
  await expect(page.locator('.toast', { hasText: '已换上新下载的拦截列表' })).toBeVisible({ timeout: 8000 })
  expect(await toasts()).not.toContain('已经是最新的')
  await expect(page.locator('.cfg__savebar', { hasText: /还没保存|已修改/ })).toHaveCount(0)
})

// 下载途中改了订阅、下到的和上次一样：订阅的改动自己会合成，不说「新的一份放进了草稿」
// The subscriptions changed mid-download and the download matches the last one: the subscription edit builds by itself, so it does not say a new copy went
// into the draft
test('下载途中改了订阅、下到的没变：说和上次下载的一样', async ({ page }) => {
  await open(page)
  await page.clock.setFixedTime(new Date(Date.now() + 5000))
  await subscribe(page, ['AdGuard DNS filter', 'anti-AD'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  const toasts = await trackToasts(page)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-download-slow', '1500'))
  await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  await page.getByRole('checkbox', { name: /^启用 anti-AD/ }).evaluate((e: HTMLElement) => e.click())
  await expect(page.locator('.toast', { hasText: '下载的和上次下载的一样，已经是最新的' })).toBeVisible({ timeout: 6000 })
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-download-slow'))
  expect(await toasts()).not.toContain('新的一份')
  await expect(bar).toContainText('已修改 1 处')
})

// 下载途中把这个列表停用了：说它已停用、启用后用上；再启用，草稿和已保存的只差这份新文件，再点一次照常存成版本
// The list switched off mid-download: it says it is off and takes effect once on; switched back on, the draft differs from the saved config only by the new
// file, and pressing again saves it as a version
test('下载途中停用了这个列表：说已停用；再启用后点一次照常存', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  await page.clock.setFixedTime(new Date(Date.now() + 5000))
  await page.evaluate(() => localStorage.setItem('kixdns:demo-download-slow', '1500'))
  const update = async () => {
    await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  }
  const toggle = () => page.getByRole('checkbox', { name: /^启用 AdGuard DNS filter/ }).evaluate((e: HTMLElement) => e.click())
  await update()
  await toggle()
  await expect(page.locator('.toast', { hasText: '新的一份已下载；「AdGuard DNS filter」已停用，启用后用上' })).toBeVisible({ timeout: 6000 })
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-download-slow'))
  await toggle()
  await expect.poll(() => page.evaluate(async () => (await import('/src/config-v2/useBlocklists.ts')).needsBuild())).toBe(false)
  await update()
  await expect(page.locator('.toast', { hasText: '已换上新下载的拦截列表' })).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.cfg__savebar', { hasText: /还没保存|已修改/ })).toHaveCount(0)
})

// 连着点两个列表的立即更新（第二个排在后面），然后停用第一个；两份都没变：第二个说和上次下载的一样，不说有新的一份
// 立即更新 on two lists in a row (the second queued), then the first switched off; neither copy changed: the second says the same as last downloaded, not that
// a new copy arrived
test('连着两个立即更新、中间停用了一个，下到的都没变：不说有新的一份', async ({ page }) => {
  await open(page)
  await page.clock.setFixedTime(new Date(Date.now() + 5000))
  await subscribe(page, ['AdGuard DNS filter', 'anti-AD'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  const toasts = await trackToasts(page)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-download-slow', '1200'))
  for (const name of ['anti-AD', 'AdGuard DNS filter']) {
    await page.locator('.bl__row', { hasText: name }).getByRole('button', { name: `${name} 的操作`, exact: true }).click()
    await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  }
  await page.getByRole('checkbox', { name: /^启用 anti-AD/ }).evaluate((e: HTMLElement) => e.click())
  await expect.poll(toasts, { timeout: 10_000 }).toContain('下载的和上次下载的一样，已经是最新的')
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-download-slow'))
  await page.waitForTimeout(500)
  expect(await toasts()).not.toContain('新的一份已放进草稿')
  expect(await toasts()).not.toContain('已换上')
  await expect(bar).toContainText('已修改 1 处')
})

// 上次那份没存上、再点一次下到的一样：下载途中改了订阅和按下前就改了，说的一样（新的一份已经在草稿里）
// The last copy did not save and pressing again downloads the same: changing the subscriptions mid-download says the same as changing them before the press
// (the new copy is already in the draft)
test('没存上以后再点一次、下载途中改了订阅：说新的一份已经在草稿里', async ({ page }) => {
  await open(page)
  await subscribe(page, ['AdGuard DNS filter', 'anti-AD'])
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效')
  await page.clock.setFixedTime(new Date(Date.now() + 5000))
  const update = async () => {
    await page.locator('.bl__row', { hasText: 'AdGuard DNS filter' }).getByRole('button', { name: 'AdGuard DNS filter 的操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '立即更新', exact: true }).click()
  }
  await page.evaluate(() => localStorage.setItem('kixdns:demo-validate-reject', 'true'))
  await update()
  await expect(page.locator('.toast', { hasText: '新下载的拦截列表没能存上，原因写在保存栏' })).toBeVisible({ timeout: 6000 })
  await page.evaluate(() => localStorage.setItem('kixdns:demo-download-slow', '1500'))
  await update()
  await page.getByRole('checkbox', { name: /^启用 anti-AD/ }).evaluate((e: HTMLElement) => e.click())
  await expect(page.locator('.toast', { hasText: '新的一份已经在草稿里，保存后生效' })).toBeVisible({ timeout: 8000 })
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-download-slow'))
})

// 全部更新途中删掉那个总下载失败的列表，其余的下到的没变：照样回答一句，不只剩「已删除」
// The always-failing list removed during 全部更新, the rest downloading the same: the press still gets an answer, not just 「已删除」
test('全部更新途中删掉总下载失败的列表：照样回答一句', async ({ page }) => {
  await open(page)
  await page.clock.setFixedTime(new Date(Date.now() + 5000))
  await subscribe(page, ['AdGuard DNS filter'])
  await page.getByLabel('列表的链接').fill('https://lists.example.org/fail/always.txt')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.locator('.bl__busy')).toHaveCount(0, { timeout: 5000 })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(bar).toContainText('已生效', { timeout: 8000 })
  await page.evaluate(() => localStorage.setItem('kixdns:demo-download-slow', '1500'))
  await page.getByRole('button', { name: '全部更新', exact: true }).first().click()
  await page.locator('.bl__row', { hasText: 'always.txt' }).getByRole('button', { name: /的操作$/ }).click()
  await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '下载的都和上次下载的一样，已经是最新的' })).toBeVisible({ timeout: 8000 })
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-download-slow'))
})
