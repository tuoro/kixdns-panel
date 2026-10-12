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

const addMappings = async (page: Page, rows: string[][]) => {
  for (const [domain, target] of rows) {
    await page.getByLabel('要映射的域名').fill(domain!)
    await page.getByLabel('回答的 IP 或域名').fill(target!)
    await page.getByRole('button', { name: '添加', exact: true }).click()
  }
}
const activeLabel = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? '')

// 编辑完一条（✓ 或 ×）焦点回到这一条，不跑到下一条；用「…」上移以后焦点还在挪过去的那一条上
// After editing a row (✓ or ×) focus returns to that row, not the next; after 上移 from its 「…」 focus stays on the moved row
test('编辑完、挪动以后，焦点留在这一条映射上', async ({ page }) => {
  await page.goto('/config?section=mapping')
  await addMappings(page, [['a.home.arpa', '192.168.1.10'], ['b.home.arpa', '192.168.1.11'], ['c.home.arpa', '192.168.1.12']])
  await page.locator('[data-rw]', { hasText: 'b.home.arpa' }).locator('.rw__d').focus()
  await page.keyboard.press('Enter')
  await page.getByLabel('回答', { exact: true }).fill('192.168.1.21')
  await page.keyboard.press('Enter')
  await expect.poll(() => activeLabel(page)).toBe('b.home.arpa')

  await page.getByRole('button', { name: 'b.home.arpa 的操作' }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: '上移' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-rw]').first()).toContainText('b.home.arpa')
  await page.waitForTimeout(300)
  expect(await activeLabel(page)).toBe('b.home.arpa 的操作')
})

// 第二次撤销回到这一次进提示之前的地方，不回到第一次的输入框 / The second 撤销 returns to where this toast was entered from, not the first one's field
test('每次撤销都回到这一次的来处', async ({ page }) => {
  await page.goto('/config?section=mapping')
  await addMappings(page, [['x.home.arpa', '192.168.1.20'], ['y.home.arpa', '192.168.1.21'], ['z.home.arpa', '192.168.1.22']])
  const undo = page.locator('.toast').getByRole('button', { name: '撤销' })
  const removeByKeyboard = async (domain: string) => {
    await page.getByRole('button', { name: `${domain} 的操作` }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('menuitem', { name: '删除' }).focus()
    await page.keyboard.press('Enter')
  }
  await removeByKeyboard('x.home.arpa')
  await page.getByLabel('要映射的域名').focus()
  await undo.last().focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => activeLabel(page)).toBe('要映射的域名')

  await removeByKeyboard('z.home.arpa')
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-rw]')))).toBe(true)
  await undo.last().focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-rw]', { hasText: 'z.home.arpa' })).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-rw]')))).toBe(true)
})

// 从规则的开关 Tab 到保存，保存完保存条收起后焦点回到那个开关，不跳到页面开头
// Tab from a rule's switch to save: when the bar leaves, focus returns to that switch instead of jumping to the page start
test('保存条收起后焦点回到进保存条之前的开关', async ({ page }) => {
  await page.goto('/config')
  await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  for (const domain of ['one.example.org', 'two.example.org']) {
    await quick.fill(domain)
    await quick.press('Enter')
  }
  const toggle = page.locator('[data-rule]', { hasText: 'one.example.org' }).locator('input[type=checkbox]').first()
  const label = await toggle.getAttribute('aria-label')
  await toggle.focus()
  await page.keyboard.press('Space')
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.cfg__savebar')).toHaveCount(0, { timeout: 10_000 })
  await expect.poll(() => activeLabel(page)).toBe(label)
})

// 开着的抽屉里删掉一个地址，焦点留在抽屉里，不落到抽屉后面（那里点不到，焦点会停在 <body>）
// Deleting an address inside an open drawer keeps focus in the drawer, never behind it (nothing there takes focus, so it would stay on <body>)
test('抽屉里删掉一个地址，焦点留在抽屉里', async ({ page }) => {
  await page.goto('/config?section=upstreams')
  await page.locator('.gcard__name').first().click()
  const add = page.locator('dialog[open] .addrs__add')
  await add.click()
  await add.click()
  const remove = page.locator('dialog[open] .addr').last().locator('button[aria-label^="删除第"]:visible').first()
  await remove.focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('dialog[open]')))).toBe(true)
})

// 重启做完以后焦点回到「重启」：确认框把焦点交回来时按钮刚好停用，浏览器随后才放掉焦点
// After a restart focus is back on 重启: the confirm hands focus back just as the button is disabled, and the browser lets go of it only afterwards
test('重启完焦点回到「重启」', async ({ page }) => {
  await page.goto('/system')
  await page.getByRole('button', { name: '重启', exact: true }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '重启服务' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '重启', exact: true })).toBeEnabled({ timeout: 10_000 })
  await expect.poll(() => activeLabel(page)).toBe('重启')
})

// 自己放掉的焦点不去接：元素还在原处时离开它（点空白处、blur），焦点留在页面上，接着按的快捷键不会变成在框里打字
// Focus let go on purpose is not caught: leaving an element that stays in place (blank click, blur) keeps focus on the page, so the next shortcut is not typed into the field
test('自己离开输入框以后，焦点不被拉回去', async ({ page }) => {
  await page.goto('/config')
  const search = page.getByLabel('搜索规则')
  await search.focus()
  await search.blur()
  // 等过兜底检查的那一帧再看 / Look after the frame in which the rescue checks
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))))
  expect(await activeIsBody(page)).toBe(true)
})
