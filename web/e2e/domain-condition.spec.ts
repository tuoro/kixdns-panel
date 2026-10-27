import { expect, test } from '@playwright/test'

// 域名条件的比较：「属于」是这个名字和它下面的所有子域名，写进来的 *. 去掉并说一句为什么；「就是」只算这个名字本身，
// 不收 *.，当场说明怎么改。
// Comparing a domain condition: 属于 is the name and every subdomain under it, and a *. written in is dropped with a line
// saying why; 就是 is the name itself only, refuses *. and says at once how to fix it.

test('域名条件：「属于」去掉 *. 并说明，下次改就收起；「就是」不收 *.', async ({ page }) => {
  await page.goto('/config')
  await expect(page.locator('.cfg__panel')).toBeVisible()
  await page.getByRole('button', { name: '新建规则', exact: true }).first().click()
  const editor = page.locator('.editor')
  await editor.getByRole('button', { name: '添加条件' }).first().click()
  await page.getByRole('menuitem', { name: '域名', exact: true }).click()
  const row = editor.locator('.cform__row').first()
  const input = row.locator('.chips input')
  const chips = row.locator('.chip')

  await input.fill('*.example.net')
  await input.press('Enter')
  await expect(chips).toHaveText(['example.net'])
  const note = row.getByText('「属于」已经包含子域名，*. 不用写')
  await expect(note).toBeVisible()

  // 提示只说刚才那一下 / The note speaks of that one edit only
  await input.fill('example.org')
  await input.press('Enter')
  await expect(chips).toHaveText(['example.net', 'example.org'])
  await expect(note).toHaveCount(0)

  await row.locator('select').selectOption('exact')
  await input.fill('*.example.edu')
  await input.press('Enter')
  await expect(chips).toHaveText(['example.net', 'example.org', '*.example.edu'])
  await expect(row.getByText('「就是」只算这个名字本身，*. 要改用「属于」')).toBeVisible()
  // 没起名字时名字的占位就是条件 / Unnamed, the name placeholder reads as the condition
  const name = page.getByLabel('规则名称，可以不填，不填就用条件当名字')
  await expect(name).toHaveAttribute('placeholder', /^域名就是 example\.net、example\.org/)

  // 换回「属于」，*. 也去掉 / Back to 属于, the *. is dropped too
  await row.locator('select').selectOption('is')
  await expect(chips).toHaveText(['example.net', 'example.org', 'example.edu'])
  await expect(name).toHaveAttribute('placeholder', /^域名属于 example\.net、example\.org/)
})
