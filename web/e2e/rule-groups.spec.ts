import { expect, test, type Page } from '@playwright/test'

// 规则组只能由主列表里「转到规则组」的规则带进来：没有规则组时只留一行；组卡片上写明从哪条规则转进来，没有时直接给「新建入口规则」；
// 不再有监听标签，v4.0.0 写在规则组上的监听标签读进来变成高级入口，还有高级入口指着的组不让删
// A rule group is entered only through a main-list rule set to 转到规则组: with none there is a single line; a group card says which rules
// jump into it and offers 新建入口规则 when none do; listener labels are gone, a v4.0.0 one on a group reads in as an advanced entry, and a
// group an advanced entry still points at cannot be deleted

async function newGroup(page: Page, name: string): Promise<void> {
  await page.locator('.rgroups__line').getByRole('button', { name: '新建规则组', exact: true }).click()
  const dialog = page.locator('dialog.pdialog[open]')
  await expect(dialog.getByRole('heading')).toHaveText('新建规则组')
  // 只有名称和说明，没有监听标签 / Only a name and a note, no listener label
  await expect(dialog.locator('.pfield')).toHaveCount(2)
  await expect(dialog).not.toContainText('监听标签')
  await dialog.getByPlaceholder('比如：内网解析').fill(name)
  await dialog.getByRole('button', { name: '新建', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

test('没有规则组时只留一行；新建以后从组卡片直接建入口规则，转进来的规则写在卡片上 @responsive', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await page.goto('/config')
  const line = page.locator('.rgroups__line')
  await expect(line).toContainText('好几条规则共用同一个前提时，可以收进一个规则组。')
  await expect(page.locator('.rgroups__head')).toHaveCount(0)

  await newGroup(page, '孩子的设备')
  const card = page.locator('[data-group]', { hasText: '孩子的设备' })
  await expect(page.locator('.rgroups__desc')).toHaveText('主列表里结果是「转到规则组」的规则命中时，请求才进到组里，进去后不再回主列表。')
  await expect(card.locator('.rcard__facts')).toContainText('还没有规则转到这里')
  await expect(card.getByRole('button', { name: '在组里新建规则' })).toBeVisible()

  // 新建入口规则：主列表里的新规则，结果已经是转到这个组 / 新建入口规则: a new main-list rule already set to this group
  await card.getByRole('button', { name: '新建入口规则' }).click()
  const editor = page.locator('.editor')
  // 是一条新规则，排在主列表最前 / A new rule, first in the main list
  await expect(editor).toContainText('第 1 条')
  if (mobile) await expect(editor.getByRole('button', { name: '修改结果' })).toContainText('转到规则组「孩子的设备」')
  else {
    await expect(editor.locator('label.tile.is-on b')).toHaveText('转到规则组')
    await expect(editor.getByLabel('结果：规则组')).toContainText('孩子的设备')
  }
  await page.getByLabel(/^规则名称/).fill('孩子的平板')
  await editor.getByRole('button', { name: '新建', exact: true }).click()

  // 卡片写明从哪条规则转进来，规则名点开就是那条规则 / The card names the rule jumping in, and the name opens it
  await expect(card.locator('.rcard__facts')).toHaveText('从「孩子的平板」转进来')
  await card.locator('.rcard__facts').getByRole('button', { name: '孩子的平板' }).click()
  await expect(page.getByLabel(/^规则名称/)).toHaveValue('孩子的平板')
  if (mobile) return
  // 桌面上主列表里这条的结果点了跳到组卡片 / On desktop the rule's outcome jumps to the group card
  await page.getByRole('button', { name: '跳到规则组「孩子的设备」' }).click()
  await expect(card).toBeFocused()
})

test('规则组的菜单：改名称和说明，不再有监听标签', async ({ page }) => {
  await page.goto('/config')
  await newGroup(page, '内网')
  const card = page.locator('[data-group]', { hasText: '内网' })
  await card.getByRole('button', { name: '规则组「内网」的操作' }).click()
  await page.getByRole('menuitem', { name: '名称和说明' }).click()
  const dialog = page.locator('dialog.pdialog[open]')
  await expect(dialog.getByRole('heading')).toHaveText('规则组的名称和说明')
  await expect(dialog).not.toContainText('监听标签')
})

test('v4.0.0 写在规则组上的监听标签读进来变成高级入口；还有高级入口指着的组不让删', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-listener-group', 'true'))
  await page.goto('/config')
  const entries = page.locator('.entries')
  await expect(entries.locator('.entries__list li').first()).toContainText('监听标签是 lan')
  await expect(entries.locator('.entries__list li').first()).toContainText('进入「内网解析」')
  const card = page.locator('[data-group="lan"]')
  await expect(card).not.toContainText('监听标签')
  await expect(card.locator('.rcard__facts')).toHaveText('从「内网反查」转进来，高级入口也指向这里')
  // 读进来的样子就是存着的样子：没有要保存的修改 / What was read is what is stored: nothing to save
  await expect(page.locator('.cfg__savebar')).toHaveCount(0)
  // 主列表的「内网反查」也转到这个组：两样都在时先说规则 / 内网反查 in the main list jumps here too: with both, the rule comes first
  await card.getByRole('button', { name: '规则组「内网解析」的操作' }).click()
  await expect(page.getByRole('menuitem', { name: '删除（先改掉转到这里的规则）' })).toBeDisabled()
})
