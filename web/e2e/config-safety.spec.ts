import { expect, type Page, test } from '@playwright/test'

// 草稿不能悄悄丢、也不能改错地方：右栏面板跟着列表走、JSON 视图里的修改算草稿、退出登录先问。
// The draft must neither vanish quietly nor change the wrong thing: the side panel follows the list, edits in the JSON view count as
// draft, and signing out asks first. The side panel exists only on wide screens, so these run on the desktop project.

// 结果相同的快速添加会并进已有的那条规则；要两条就给第二条换个结果（block） / Quick add merges into an existing rule with the same outcome, so a second rule gets a different one (block)
async function addRule(page: Page, domain: string, outcome?: 'block'): Promise<void> {
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  if (!(await quick.isVisible())) await page.getByRole('button', { name: '快速添加' }).click()
  await quick.fill(domain)
  if (outcome) await page.getByLabel('快速添加的结果', { exact: true }).selectOption(outcome)
  await quick.press('Enter')
  await expect(page.locator('[data-rule]', { hasText: domain })).toBeVisible()
}

async function rename(page: Page, domain: string, name: string): Promise<void> {
  await page.locator('[data-rule]', { hasText: domain }).locator('.rrow__main').click()
  await page.getByLabel('规则名称，可以不填，不填就用条件当名字').fill(name)
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await expect(page.locator('[data-rule]', { hasText: name })).toBeVisible()
}

test('右栏开着的规则在列表里删掉：面板关上，别的规则一条不少', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'first.example')
  await addRule(page, 'second.example', 'block')
  await rename(page, 'first.example', '甲')
  await rename(page, 'second.example', '乙')
  // 打开「甲」并在面板里改一处，再从列表的「…」删掉它 / Open 甲, edit it in the panel, then delete it from the list's 「…」
  await page.locator('[data-rule]', { hasText: '甲' }).locator('.rrow__main').click()
  await page.getByLabel('规则名称，可以不填，不填就用条件当名字').fill('甲改')
  await page.getByRole('button', { name: '规则「甲」的操作' }).click()
  await page.getByRole('menuitem', { name: '删除' }).click()
  // 面板跟着关上；以前点面板的「完成」会把「甲」加回来，同时删掉最后一条「乙」 / The panel closes; before, its 完成 brought 甲 back and dropped the last rule 乙
  await expect(page.locator('.editor--inspector')).toHaveCount(0)
  await expect(page.locator('[data-rule]')).toHaveCount(1)
  await expect(page.locator('[data-rule]').first()).toContainText('乙')
})

test('右栏开着时在列表里停用这条规则：面板跟着变，完成时不把开关改回去', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'switch.example')
  const row = page.locator('[data-rule]').first()
  await row.locator('.rrow__main').click()
  await expect(page.locator('.editor--inspector')).toBeVisible()
  await row.getByRole('checkbox').uncheck()
  await expect(page.getByRole('checkbox', { name: '启用这条规则' })).not.toBeChecked()
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await expect(row.getByRole('checkbox')).not.toBeChecked()
})

test('右栏里改了没点完成就换一条：先问一句', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'one.example')
  await addRule(page, 'two.example', 'block')
  await page.locator('[data-rule]', { hasText: 'one.example' }).locator('.rrow__main').click()
  await page.getByLabel('规则名称，可以不填，不填就用条件当名字').fill('改了一半')
  await page.locator('[data-rule]', { hasText: 'two.example' }).locator('.rrow__main').click()
  const dialog = page.getByRole('alertdialog', { name: '放弃这条规则的修改' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '继续编辑' }).click()
  await expect(page.getByLabel('规则名称，可以不填，不填就用条件当名字')).toHaveValue('改了一半')
})

test('保存条的保存会把右栏里没点完成的修改一起保存', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'carry.example')
  await page.locator('[data-rule]').first().locator('.rrow__main').click()
  await page.getByLabel('规则名称，可以不填，不填就用条件当名字').fill('一起保存')
  await page.getByRole('button', { name: '保存并热加载', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await expect(page.locator('[data-rule]').first()).toContainText('一起保存')
})

test('JSON 视图里的修改算草稿：保存条升起，离开前要问，回来时从表单开始', async ({ page }) => {
  await page.goto('/config')
  await page.getByRole('button', { name: '更多配置操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '查看 JSON', exact: true }).click()
  const editor = page.locator('.cfg__json-editor .cm-content')
  await expect(editor).toBeVisible()
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('End')
  await page.keyboard.type(',\n"note_from_test": 1')
  await expect(page.locator('.cfg__savebar')).toContainText('JSON 有修改')
  // 从侧栏离开要先问；选「继续编辑」留在原处 / Leaving through the sidebar asks first; 继续编辑 stays put
  await page.locator('.desktop-nav').getByRole('link', { name: '概览' }).click()
  const ask = page.getByRole('alertdialog', { name: '放弃未保存的修改' })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: '放弃修改' }).click()
  await expect(page.locator('main h1')).toHaveText('概览')
  // 回到配置页是表单，不是空着又切不回去的 JSON 视图 / Back on the config page it is the form, not an empty JSON view that cannot switch back
  await page.locator('.desktop-nav').getByRole('link', { name: '规则' }).click()
  await expect(page.locator('.cfg__json-editor')).toHaveCount(0)
  await expect(page.locator('.rcard')).toBeVisible()
})

test('有没保存的修改时退出登录：先问，选继续编辑就还登录着', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'stay.example')
  await page.locator('.account-button').click()
  await page.getByRole('button', { name: '退出登录' }).click()
  const ask = page.getByRole('alertdialog', { name: '放弃未保存的修改' })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: '继续编辑' }).click()
  await expect(page).toHaveURL(/\/config/)
  await expect(page.locator('.cfg__savebar')).toContainText('已修改')
  // 还登录着：保存照样成功 / Still signed in: saving still works
  await page.getByRole('button', { name: '保存并热加载', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
})

test('别处先存了一个版本：保存停住，可以下载自己的修改，重新读取前先问', async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem('conflict-armed')) { sessionStorage.setItem('conflict-armed', '1'); localStorage.setItem('kixdns:demo-save-conflict', 'true') } })
  await page.goto('/config')
  await addRule(page, 'mine.example')
  await page.getByRole('button', { name: '保存并热加载', exact: true }).click()
  const bar = page.locator('.cfg__savebar')
  await expect(bar).toContainText('这份配置在别处改过了')
  // 再按保存只会再失败一次：主按钮停用；放弃修改还在；能把自己的修改下载下来 / Saving again would only fail again: the primary is disabled; discard is still there; the user's edits can be downloaded
  await expect(bar.getByRole('button', { name: '保存并热加载', exact: true })).toBeDisabled()
  await expect(bar.getByRole('button', { name: '放弃修改', exact: true })).toBeVisible()
  const download = page.waitForEvent('download')
  await bar.getByRole('button', { name: '下载我的修改', exact: true }).click()
  expect((await download).suggestedFilename()).toBe('kixdns-config.json')
  // 重新读取会丢掉草稿：先问 / Reloading drops the draft: it asks first
  await bar.getByRole('button', { name: '重新读取', exact: true }).click()
  const ask = page.getByRole('alertdialog', { name: '放弃未保存的修改' })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: '取消' }).click()
  await expect(page.locator('[data-rule]', { hasText: 'mine.example' })).toBeVisible()
})
