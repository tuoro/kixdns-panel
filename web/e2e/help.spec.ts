import { expect, test, type Page } from '@playwright/test'

// 页内帮助：概念旁的「?」弹层、帮助抽屉、快捷键。弹层在顶层里按按钮位置摆、不出屏；手机上从底部升起；快捷键在输入框里不触发。
// In-page help: the 「?」 popover beside a concept, the help drawer, the shortcuts. The popover sits in the top layer by its button and stays on screen;
// on phones it rises from the bottom; shortcuts never fire while typing.

async function openNewRule(page: Page): Promise<void> {
  await page.goto('/config')
  await expect(page.locator('.cfg__panel')).toBeVisible()
  await page.getByRole('button', { name: '新建规则', exact: true }).first().click()
  await expect(page.locator('.editor')).toBeVisible()
}

test('概念旁的「?」：点开说明，Esc 关掉焦点回到按钮，「全部说明」打开抽屉并展开这一条 @responsive', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await openNewRule(page)
  const button = page.getByRole('button', { name: '什么是回答后检查' })
  await button.click()
  const pop = page.getByRole('dialog', { name: '回答后检查', exact: true })
  await expect(pop).toBeVisible()
  await expect(pop).toContainText('上游超时或连不上不会走到这一步')
  // 等升起的动画走完再量：慢机器上量到半路，底边还在屏幕外 / Measure after the rise animation: on a slow machine a mid-flight box is still below the screen
  await pop.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  // 在屏幕里，手机上贴底 / On screen, docked to the bottom on phones
  const box = (await pop.boundingBox())!
  const vp = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width)
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1)
  if (mobile) expect(Math.round(box.y + box.height)).toBe(vp.height)
  await page.keyboard.press('Escape')
  await expect(pop).toBeHidden()
  await expect(button).toBeFocused()
  // Esc 只关弹层，编辑页还在 / Esc closes only the popover; the editor stays
  await expect(page.locator('.editor')).toBeVisible()
  await button.click()
  await pop.getByRole('button', { name: '全部说明和快捷键' }).click()
  const drawer = page.getByRole('dialog', { name: '帮助', exact: true })
  await expect(drawer).toBeVisible()
  await expect(drawer.locator('#help-after')).toHaveAttribute('open', '')
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
})

test('「…」里的帮助：这一页的概念 + 快捷键；手机上不列快捷键 @responsive', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await page.goto('/config')
  await expect(page.locator('.cfg__panel')).toBeVisible()
  await page.getByRole('button', { name: '更多配置操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '帮助', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: '帮助', exact: true })
  await expect(drawer).toBeVisible()
  await expect(drawer.locator('.help__topic summary')).toHaveText(['回答后检查', '客户端子网（ECS）', 'GeoSite 分类', '规则组', '备用组', '域名映射', '规则默认值', '内核规则', '测试域名'])
  await drawer.locator('#help-fallback summary').click()
  await expect(drawer.locator('#help-fallback')).toContainText('不会改问备用组')
  if (mobile) await expect(drawer.getByRole('heading', { name: '键盘快捷键' })).toBeHidden()
  else await expect(drawer.getByRole('heading', { name: '键盘快捷键' })).toBeVisible()
  await drawer.getByRole('button', { name: '关闭帮助' }).click()
  await expect(drawer).toBeHidden()
})

test('快捷键：/ 聚焦搜索、n 新建规则、? 打开快捷键一览；输入框里都不触发', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机没有键盘 / phones have no keyboard')
  await page.goto('/config')
  await expect(page.locator('.cfg__panel')).toBeVisible()
  await page.keyboard.press('/')
  const search = page.getByLabel('搜索规则')
  await expect(search).toBeFocused()
  // 输入框里打 n 和 ? 是字，不是快捷键 / Typing n and ? in a field is text, not a shortcut
  await page.keyboard.type('n?')
  await expect(search).toHaveValue('n?')
  await expect(page.locator('.editor')).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: '帮助', exact: true })).toHaveCount(0)
  await search.fill('')
  await search.blur()
  await page.keyboard.press('n')
  await expect(page.locator('.editor')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.editor')).toHaveCount(0)
  await page.keyboard.press('?')
  const drawer = page.getByRole('dialog', { name: '帮助', exact: true })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('heading', { name: '键盘快捷键' })).toBeVisible()
  await expect(drawer.locator('.help__keys dd')).toContainText(['打开帮助和快捷键', '搜索规则', '新建规则', '保存草稿'])
})

test('账户菜单里的「键盘快捷键」在别的页也能打开一览', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机上不显示这一行 / hidden on phones')
  await page.goto('/logs')
  await expect(page.locator('main h1')).toBeVisible()
  await page.locator('.account-button').click()
  await page.getByRole('button', { name: '键盘快捷键' }).click()
  const drawer = page.getByRole('dialog', { name: '帮助', exact: true })
  await expect(drawer).toBeVisible()
  await expect(drawer.locator('.help__topic')).toHaveCount(0)
  await expect(drawer.getByRole('heading', { name: '键盘快捷键' })).toBeVisible()
})

test('右栏检查器里「?」紧跟「回答后检查」，弹层不被右栏裁掉', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '右栏只在宽屏 / the inspector is wide-screen only')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/config')
  await expect(page.locator('.cfg__panel')).toBeVisible()
  await page.getByRole('button', { name: '新建规则', exact: true }).first().click()
  const inspector = page.locator('.rules-split > .editor--inspector')
  await expect(inspector).toBeVisible()
  const title = inspector.locator('#ec-after')
  const button = inspector.getByRole('button', { name: '什么是回答后检查' })
  const t = (await title.boundingBox())!, b = (await button.boundingBox())!
  expect(b.x - (t.x + t.width)).toBeLessThanOrEqual(8)
  // 点标题那一行还是折叠 / 展开 / A click on the title row still folds and unfolds
  const fold = inspector.getByRole('button', { name: '回答后检查', exact: true })
  await expect(fold).toHaveAttribute('aria-expanded', 'false')
  // 点在摘要那一段：标题按钮伸出的那层盖着整行，所以是真实的鼠标点击 / Click on the summary: the title button's stretched layer covers the row, so it is a real mouse click
  const sum = (await inspector.locator('.ecard__head--stretch .ecard__sum').boundingBox())!
  await page.mouse.click(sum.x + sum.width / 2, sum.y + sum.height / 2)
  await expect(fold).toHaveAttribute('aria-expanded', 'true')
  await button.click()
  const pop = page.getByRole('dialog', { name: '回答后检查', exact: true })
  await expect(pop).toBeVisible()
  // 点「?」不会顺带折叠 / The 「?」 click does not fold the section
  await expect(fold).toHaveAttribute('aria-expanded', 'true')
  const p = (await pop.boundingBox())!
  expect(p.x + p.width).toBeLessThanOrEqual(1440)
  expect(await pop.evaluate((el) => el.matches(':popover-open'))).toBe(true)
})
