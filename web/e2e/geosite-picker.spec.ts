import { expect, test, type Locator, type Page } from '@playwright/test'

// GeoSite 条件：分类从数据里挑（演示数据是 Loyalsoldier 里的一部分），带属性的可以细分；数据里没有的值在条件下面和规则列表上都会标出来。
// GeoSite conditions: categories are picked from the data (the demo holds part of Loyalsoldier's), categories with attributes can be
// narrowed, and a value the data lacks is flagged under the condition and on the rule list.

async function newGeositeCondition(page: Page): Promise<{ editor: Locator; field: Locator; list: Locator; chips: Locator }> {
  await page.goto('/config')
  await expect(page.locator('.cfg__panel')).toBeVisible()
  await page.getByRole('button', { name: '新建规则', exact: true }).first().click()
  const editor = page.locator('.editor')
  await editor.getByRole('button', { name: '添加条件' }).first().click()
  await page.getByRole('menuitem', { name: 'GeoSite', exact: true }).click()
  const field = page.getByRole('combobox', { name: 'GeoSite', exact: true })
  return { editor, field, list: page.getByRole('listbox', { name: 'GeoSite的分类' }), chips: page.locator('.chips:has([role="combobox"]) .chip') }
}

test('GeoSite 条件从数据里挑分类，带属性的可以细分', async ({ page }) => {
  const { editor, field, list, chips } = await newGeositeCondition(page)
  // 新加的条件直接聚焦，先列出常用分类和它们的说明 / A new condition is focused and lists the common categories with their notes first
  await expect(field).toBeFocused()
  await expect(list.getByRole('option').first()).toContainText('cn')
  await expect(list.getByRole('option').first()).toContainText('中国大陆常用域名')

  await field.fill('goo')
  await expect(list.getByRole('option').first()).toContainText('google')
  await field.press('Enter')
  await expect(chips).toHaveText(['google'])

  await editor.getByRole('button', { name: '细分 google' }).click()
  await page.getByRole('menuitem', { name: /^带 cn：在中国大陆有接入点/ }).click()
  await expect(chips).toHaveText(['google@cn'])

  // 中文说明也能搜 / Notes are searchable too
  await field.fill('苹果')
  await expect(list.getByRole('option').first()).toContainText('apple')

  // 数据里没有的分类：块变黄，下面说命中不了 / A category the data lacks: an amber block and a line saying it cannot match
  await field.fill('googel')
  await field.press('Enter')
  await expect(page.locator('.chip--warn')).toHaveText(['googel'])
  await expect(editor.locator('.ui-field-warn')).toHaveText('当前 GeoSite 数据里没有 googel，这个值不会命中')

  // @! 是属性名本身，和 V2Ray 一样；写了就说明 / @! names the attribute itself, as in V2Ray, and is explained when written
  await field.fill('google@!')
  await expect(list.getByRole('option')).toHaveText([/^google@!cn/])
  await field.press('Enter')
  await expect(editor.locator('.ui-field-note')).toHaveText('google@!cn 指标了 !cn 的域名（和 V2Ray 一样）。要「google 里不带 cn 的」，再加一个条件：不属于 google@cn')

  // Esc 只收起列表，不离开编辑器 / Esc folds the list without leaving the editor
  await field.fill('app')
  await expect(list).toBeVisible()
  await field.press('Escape')
  await expect(list).toBeHidden()
  await expect(page.getByText('放弃这条规则的修改')).toHaveCount(0)
  await expect(editor).toBeVisible()
})

test('写了数据里没有的分类：规则列表标「无此分类」', async ({ page }) => {
  const { editor, field } = await newGeositeCondition(page)
  await field.fill('googel')
  await field.press('Enter')
  await editor.getByRole('button', { name: '新建', exact: true }).click()
  const tag = page.locator('[data-rule] .ui-tag--warn', { hasText: '无此分类' })
  await expect(tag).toBeVisible()
  await expect(tag).toHaveAttribute('title', '当前 GeoSite 数据里没有 googel，这个值不会命中')
})

test('还没有 GeoSite 数据：先列出安装包里的分类，条件下面说不会命中，规则标「缺 GeoSite」', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-geosite-empty', 'true'))
  const { editor, field, list } = await newGeositeCondition(page)
  await expect(list.getByRole('option').first()).toContainText('cn')
  await field.press('ArrowDown')
  await field.press('Enter')
  await expect(editor.locator('.ui-field-warn')).toHaveText('还没有 GeoSite 数据，这个条件不会命中。到「基础设置 › Geo 数据」导入或填写')
  await editor.getByRole('button', { name: '新建', exact: true }).click()
  await expect(page.locator('[data-rule] .ui-tag--warn', { hasText: '缺 GeoSite' })).toBeVisible()
})

test('快速添加认得数据里的分类，数据里没有的直接说', async ({ page }) => {
  await page.goto('/config')
  await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  const hint = page.locator('.qadd__hint')
  // bilibili 不在原来那 11 个常用分类里，现在照样认成 GeoSite / bilibili was not among the old 11 common categories and is now recognised all the same
  await quick.fill('bilibili')
  await expect(hint).toContainText('新建一条规则：GeoSite 是 bilibili')
  await quick.fill('geosite:googel')
  await expect(hint).toHaveText('当前 GeoSite 数据里没有「googel」')
  await expect(hint).toHaveClass(/is-err/)
})

test('手机上分类列表放在输入框下面，点一项就加上 @responsive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '桌面上列表浮在输入框下面，见上面几条 / on desktop the list floats under the field, see above')
  const { field, list, chips } = await newGeositeCondition(page)
  await expect(field).toBeFocused()
  // 不另弹一层：列表就在弹层里输入框的下面 / No extra layer: the list sits under the field inside the sheet
  await expect(list).not.toHaveAttribute('popover')
  await list.getByRole('option').filter({ hasText: 'geolocation-!cn' }).click()
  await expect(chips).toHaveText(['geolocation-!cn'])
  // 关上弹层，行上就能看到数据里没有的值，不用点进去 / With the sheet closed the row itself shows a value the data lacks
  await field.fill('googel')
  await field.press('Enter')
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await expect(page.locator('.cform__prow .cform__pwarn')).toHaveText('当前 GeoSite 数据里没有 googel，这个值不会命中')
  await page.locator('.cform__prow').click()
  // 细分菜单从弹层里打开：弹层不能因为列表收起变矮而被误关（手指抬起落到外面）
  // The narrowing menu opens from inside the sheet: the sheet must not close because a folding list shrank it under the finger
  await field.fill('google')
  await field.press('Enter')
  await page.getByRole('button', { name: '细分 google' }).click()
  await page.getByRole('menuitem', { name: /^带 cn：/ }).click()
  await expect(chips).toHaveText(['geolocation-!cn', 'googel', 'google@cn'])
  await expect(page.locator('dialog.psheet[open]')).toHaveCount(1)
  const box = await list.boundingBox()
  const viewport = page.viewportSize()!
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
})
