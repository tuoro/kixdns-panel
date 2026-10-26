import { expect, type Page, test } from '@playwright/test'
import { acceptConfirm } from './confirm'

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
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
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

// 退出登录时问的按钮用退出的说法（和在别处退出一样）：先不退出 / 放弃并退出 / Sign-out asks with sign-out buttons (as from elsewhere): 先不退出 / 放弃并退出
test('有没保存的修改时退出登录：先问，选先不退出就还登录着', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'stay.example')
  await page.locator('.account-button').click()
  await page.getByRole('button', { name: '退出登录' }).click()
  const ask = page.getByRole('alertdialog', { name: '放弃未保存的修改' })
  await expect(ask).toBeVisible()
  await expect(ask.getByRole('button', { name: '放弃并退出' })).toBeVisible()
  await ask.getByRole('button', { name: '先不退出' }).click()
  await expect(page).toHaveURL(/\/config/)
  await expect(page.locator('.cfg__savebar')).toContainText('已修改')
  // 还登录着：保存照样成功 / Still signed in: saving still works
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
})

// 同意放弃并退出，可退出没成功（连不上面板）：人还登录着、还在配置页，修改还在 / Agreed to drop and sign out, but the sign-out failed (panel unreachable):
// still signed in, still on the config page, the edits still there
test('有修改时退出登录、同意放弃，退出没成功：修改还在', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'stay.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-panel-down', 'true'))
  await page.locator('.account-button').click()
  await page.getByRole('button', { name: '退出登录' }).click()
  await page.getByRole('alertdialog', { name: '放弃未保存的修改' }).getByRole('button', { name: '放弃并退出' }).click()
  await expect(page).toHaveURL(/\/config/)
  await expect(page.locator('.cfg__savebar')).toContainText('已修改')
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-panel-down'))
})

test('别处先存了一个版本：保存停住，可以下载自己的修改，重新读取前先问', async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem('conflict-armed')) { sessionStorage.setItem('conflict-armed', '1'); localStorage.setItem('kixdns:demo-save-conflict', 'true') } })
  await page.goto('/config')
  await addRule(page, 'mine.example')
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  const bar = page.locator('.cfg__savebar')
  await expect(bar).toContainText('这份配置在别处改过了')
  // 再按保存只会再失败一次：主按钮停用；放弃修改在这时就是重新读取，不另放一个（和手机一样）；能把自己的修改下载下来
  // Saving again would only fail again: the primary is disabled; discarding is re-reading here, so there is no second control (as on phones); the user's edits can be downloaded
  await expect(bar.getByRole('button', { name: '保存并应用', exact: true })).toBeDisabled()
  await expect(bar.getByRole('button', { name: '放弃修改', exact: true })).toHaveCount(0)
  await expect(bar.getByRole('button', { name: '重新读取', exact: true })).toBeVisible()
  const download = page.waitForEvent('download')
  await bar.getByRole('button', { name: '下载草稿', exact: true }).click()
  expect((await download).suggestedFilename()).toBe('kixdns-config.json')
  // 重新读取会丢掉草稿：先问 / Reloading drops the draft: it asks first
  await bar.getByRole('button', { name: '重新读取', exact: true }).click()
  const ask = page.getByRole('alertdialog', { name: '放弃未保存的修改' })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: '取消' }).click()
  await expect(page.locator('[data-rule]', { hasText: 'mine.example' })).toBeVisible()
})

test('右栏里改了没点完成就离开配置页：先问这条规则', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'leave.example')
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await page.locator('[data-rule]').first().locator('.rrow__main').click()
  await page.getByLabel('规则名称，可以不填，不填就用条件当名字').fill('没点完成')
  // 草稿已经保存，只剩面板里的修改：保存条照样升起，Ctrl+S 会把它一起存了 / The draft is saved and only the panel's edit is left: the bar still rises
  await expect(page.locator('.cfg__savebar')).toContainText('右侧规则的修改还没放进草稿')
  await page.locator('.desktop-nav').getByRole('link', { name: '概览' }).click()
  const ask = page.getByRole('alertdialog', { name: '放弃这条规则的修改' })
  await expect(ask).toBeVisible()
  // 会丢东西的确认框，焦点在「继续编辑」上 / A confirm that loses something focuses 继续编辑
  await expect(ask.getByRole('button', { name: '继续编辑' })).toBeFocused()
  await ask.getByRole('button', { name: '继续编辑' }).click()
  await expect(page.getByLabel('规则名称，可以不填，不填就用条件当名字')).toHaveValue('没点完成')
})

test('JSON 视图里放弃修改：编辑器里的文字一起回到草稿的样子', async ({ page }) => {
  await page.goto('/config')
  await page.getByRole('button', { name: '更多配置操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '查看 JSON', exact: true }).click()
  const editor = page.locator('.cfg__json-editor .cm-content')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('End')
  await page.keyboard.type(',\n"x_test": 1')
  await expect(page.locator('.cfg__savebar')).toContainText('JSON 有修改')
  await page.getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toHaveCount(0)
  await expect(editor).not.toContainText('x_test')
})

test('冲突以后再改一笔，保存仍然停着，直到重新读取', async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem('conflict-armed')) { sessionStorage.setItem('conflict-armed', '1'); localStorage.setItem('kixdns:demo-save-conflict', 'true') } })
  await page.goto('/config')
  await addRule(page, 'first.example')
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  const bar = page.locator('.cfg__savebar')
  await expect(bar).toContainText('这份配置在别处改过了')
  await addRule(page, 'second.example', 'block')
  await expect(bar).toContainText('这份配置在别处改过了')
  await expect(bar.getByRole('button', { name: '保存并应用', exact: true })).toBeDisabled()
  // 重新读取以后，上一份草稿的失败不再挂着 / After re-reading, the previous draft's failure no longer hangs around
  await bar.getByRole('button', { name: '重新读取', exact: true }).click()
  await page.getByRole('alertdialog', { name: '放弃未保存的修改' }).getByRole('button', { name: '放弃修改并重新读取' }).click()
  await expect(page.locator('.cfg__savebar')).toHaveCount(0)
})

test('手机上从整页编辑按返回：回到规则列表，改过先问 @responsive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '整页编辑只在窄屏上出现 / the full-page editor appears only on narrow screens')
  await page.goto('/')
  await page.locator('.mobile-nav').getByRole('link', { name: '配置' }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('back.example')
  await quick.press('Enter')
  await page.locator('[data-rule]').first().locator('.rrow__main').click()
  await page.getByLabel('规则名称，可以不填，不填就用条件当名字').fill('改了一半')
  await page.goBack()
  const ask = page.getByRole('alertdialog', { name: '放弃这条规则的修改' })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: '放弃修改' }).click()
  // 回到的是规则列表，不是概览 / Back lands on the rule list, not the overview
  await expect(page).toHaveURL(/\/config/)
  await expect(page.locator('[data-rule]').first()).toContainText('back.example')
})

test('手机上编辑列表靠下的规则，完成后那一行还在眼前并拿到焦点 @responsive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '整页编辑只在窄屏上出现 / the full-page editor appears only on narrow screens')
  // 二十条规则的内核配置，导入后列表比一屏长 / A kernel config with twenty rules, so the imported list is longer than one screen
  const rules = Array.from({ length: 20 }, (_, i) => ({ name: `r${i + 1}`, matchers: [{ type: 'domain_suffix', value: `site${i + 1}.example` }], actions: [{ type: 'forward', upstream: '1.1.1.1:53' }] }))
  const config = { version: '1.0', settings: {}, pipeline_select: [{ pipeline: 'main', matchers: [] }], pipelines: [{ id: 'main', rules }] }
  await page.goto('/config')
  // 等配置读完再导入，不然读回来的配置会把导入的盖掉 / Import only after the config has loaded, or the load would overwrite the import
  await expect(page.locator('.rcard')).toBeVisible()
  await page.locator('input[type="file"]').setInputFiles({ name: 'many.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(config)) })
  const dialog = page.locator('dialog[open]')
  if (await dialog.count()) await page.keyboard.press('Escape')
  const row = page.locator('[data-rule]', { hasText: 'r18' })
  await row.scrollIntoViewIfNeeded()
  await row.locator('.rrow__main').click()
  await page.getByLabel('规则名称，可以不填，不填就用条件当名字').fill('第十八条')
  await page.getByRole('button', { name: '完成', exact: true }).click()
  const edited = page.locator('[data-rule]', { hasText: '第十八条' })
  await expect(edited.locator('.rrow__main')).toBeFocused()
  // 以前返回时浏览器把列表恢复到页顶，这一行落在屏幕外 / Before, back restored the list to the top and the row was off screen
  await expect(edited).toBeInViewport()
})

test('上游组抽屉里改了还没写进草稿就按浏览器返回：先问一句', async ({ page }) => {
  // 从概览点进来：返回走的是页面里的路由，离开前要问 / Arrive from the overview, so back is an in-app route change that must ask first
  await page.goto('/')
  await page.locator('.desktop-nav').getByRole('link', { name: '上游组' }).click()
  await page.getByRole('button', { name: '新建上游组', exact: true }).first().click()
  const drawer = page.locator('dialog[open]').last()
  await drawer.getByLabel('名称', { exact: true }).fill('半成品')
  await page.goBack()
  const ask = page.getByRole('alertdialog', { name: '放弃这个上游组的修改' })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: '继续编辑' }).click()
  await expect(page).toHaveURL(/section=upstreams/)
  await expect(drawer.getByLabel('名称', { exact: true })).toHaveValue('半成品')
})

test('保存时才发现 KixDNS 停了：标题说停了，不说没通过校验，草稿还在', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'stopped.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-validate-stopped', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar.locator('.ui-savebar__verdict')).toHaveText('KixDNS 已停止')
  await expect(bar).toContainText('草稿还在，可以先存成待应用版本')
  await expect(page.locator('[data-rule]', { hasText: 'stopped.example' })).toBeVisible()
})

test('高级规则能打开编辑，改了没点完成也算没保存 @responsive', async ({ page }, testInfo) => {
  // 放不进面板写法的内核规则（动作在决定结果后还有一个）导入后成为高级规则 / A kernel rule that fits no panel field (an action after the deciding one) imports as an advanced rule
  const config = { version: '1.0', settings: {}, pipeline_select: [{ pipeline: 'main', matchers: [] }], pipelines: [{ id: 'main', rules: [{ name: 'ads', matchers: [{ type: 'geo_site', value: 'category-ads-all' }], actions: [{ type: 'log', level: 'info' }, { type: 'deny' }, { type: 'static_response', rcode: 'NXDOMAIN' }] }] }] }
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/config')
  await expect(page.locator('.rcard')).toBeVisible()
  await page.locator('input[type="file"]').setInputFiles({ name: 'raw.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(config)) })
  const report = page.locator('dialog[open]')
  if (await report.count()) await page.keyboard.press('Escape')
  await page.locator('[data-rule]', { hasText: 'ads' }).locator('.rrow__main').click()
  const editor = testInfo.project.name === 'mobile' ? page.locator('.editor').first() : page.locator('.editor--inspector')
  await expect(editor).toBeVisible()
  await expect(editor.getByRole('button', { name: '完成', exact: true })).toBeVisible()
  // 改一处没点完成就取消：先问一句（导入本身已经让草稿有修改，所以看的是取消时的提问） / One edit then 取消 asks first (the import already dirtied the draft, so the question on 取消 is what tells)
  await editor.getByRole('checkbox', { name: '启用这条规则' }).uncheck()
  await editor.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('alertdialog', { name: '放弃这条规则的修改' })).toBeVisible()
  expect(errors).toEqual([])
})

test('保存在校验这一步被 KixDNS 拒绝：草稿和失败的说法都留着', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'rejected.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-validate-reject', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar.locator('.ui-savebar__verdict')).toHaveText('没有通过校验')
  // 以前 120 毫秒后重读文件把草稿整份换掉，保存条跟着消失，看起来像保存成功 / Before, the file was re-read 120 ms later and replaced the draft, so the bar vanished as if the save had worked
  await page.waitForTimeout(800)
  await expect(bar.locator('.ui-savebar__verdict')).toHaveText('没有通过校验')
  await expect(page.locator('[data-rule]', { hasText: 'rejected.example' })).toBeVisible()
})

test('保存途中又改了一笔：保存完那一笔还在，算一处没保存的修改', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'first.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-slow', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('写入并应用')
  await addRule(page, 'during.example', 'block')
  await expect(bar).toContainText('已生效', { timeout: 5000 })
  await expect(page.locator('[data-rule]', { hasText: 'during.example' })).toBeVisible()
  await expect(bar).toContainText('已修改 1 处')
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

// 保存途中离开：问「放弃」也放弃不了，所以不问；保存照常做完，结果用提示说。没保存成功时草稿留着，回来还在
// Leaving mid-save: a 放弃 question could not discard anything, so none is asked; the save finishes and a toast tells the outcome. If it failed the draft stays for the return
test('保存途中离开配置页：不问放弃，保存的结果用提示说', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'leaving.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-slow', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('写入并应用')
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await expect(page.locator('dialog.confirm[open]')).toHaveCount(0)
  await expect(page.locator('.toast', { hasText: /版本 #\d+ 已生效/ })).toBeVisible({ timeout: 5000 })
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

// 提示里有防断行的不可见字符（「配置页」「改过了」不拆开）：比文字前先去掉 / Toasts carry invisible no-break joiners (配置页 and 改过了 stay whole): strip them before comparing text
const toastTexts = (page: Page) => page.locator('.toast').allTextContents().then((texts) => texts.map((text) => text.replace(/\u2060/g, '').trim()))

test('保存途中离开，保存没成功：提示说清楚，回到配置页草稿还在', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'kept.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', 'true'); localStorage.setItem('kixdns:demo-save-conflict', 'true') })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('写入并应用')
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContain('配置没有保存：这份配置在别处改过了。草稿留在配置页，回去重新读取后再改')
  // 草稿只在内存里：这时刷新或关掉浏览器先问一句 / The draft lives only in memory: reloading or closing the browser asks first
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })).toBe(true)
  await page.getByRole('link', { name: '规则', exact: true }).click()
  await expect(page.locator('[data-rule]', { hasText: 'kept.example' })).toBeVisible()
  await expect(bar).toContainText('这份配置在别处改过了')
  // 保存条接着说了，离开时的那条提示收起 / The save bar says it now, so the toast from leaving goes
  await expect.poll(() => toastTexts(page)).not.toContain('配置没有保存：这份配置在别处改过了。草稿留在配置页，回去重新读取后再改')
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

// 保存还没做完人已经离开：刷新或关掉浏览器先问一句（草稿只在内存里） / A save still running after leaving: reloading or closing the browser asks first (the draft lives only in memory)
test('保存途中离开：保存还没做完时刷新浏览器先问', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'unload.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-slow', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('写入并应用')
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })).toBe(true)
  await expect(page.locator('.toast', { hasText: /版本 #\d+ 已生效/ })).toBeVisible({ timeout: 5000 })
  // 保存做完、草稿没有别的修改了：不再拦着 / The save is done and nothing else is unsaved: no longer guarded
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })).toBe(false)
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

// 保存途中又改了一笔，离开时同意丢掉它：保存没成功，回来看到的是正在保存的那一份，不会冒出说好丢掉的那一笔
// One more edit during a save, agreed to drop on leaving: the save fails, and coming back shows the draft being saved, not the edit agreed to drop
test('保存途中离开时丢掉之后的修改：保存没成功回来也不再出现', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'saving.example')
  // 保存要慢到人离开时还在做：1.5 秒在机器忙时不够，保存先在页上做完，离开以后就没有提示了 / The save must still be running when the user
  // leaves: 1.5 seconds is not enough on a busy machine, the save then finishes on the page and nothing is told away
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', '4000'); localStorage.setItem('kixdns:demo-save-conflict', 'true') })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('写入并应用')
  await addRule(page, 'dropped.example', 'block')
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await page.locator('dialog.confirm[open]').getByRole('button', { name: '放弃修改' }).click()
  await expect(page).toHaveURL(/\/logs/)
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContain('配置没有保存：这份配置在别处改过了。草稿留在配置页，回去重新读取后再改')
  await page.getByRole('link', { name: '规则', exact: true }).click()
  await expect(page.locator('[data-rule]', { hasText: 'saving.example' })).toBeVisible()
  await expect(page.locator('[data-rule]', { hasText: 'dropped.example' })).toHaveCount(0)
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

// 保存途中离开到概览：「版本 #N 已生效」落地时概览马上重读，页头不再写上一个版本 / Leaving for the overview mid-save: when 「版本 #N 已生效」 lands the overview re-reads at once, so its header no longer names the previous version
test('保存途中离开到概览：提示说已生效时概览也是新版本', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'overview-after.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-slow', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('写入并应用')
  await page.getByRole('link', { name: '概览', exact: true }).click()
  const applied = page.locator('.toast', { hasText: /版本 #\d+ 已生效/ })
  await expect(applied).toBeVisible({ timeout: 5000 })
  const version = (await applied.textContent())!.match(/#(\d+)/)![1]
  await expect(page.locator('.overview-heading')).toContainText(`#${version}`, { timeout: 3000 })
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

// 保存途中又改了一笔再离开：那一笔会丢，照样先问 / Leaving after one more edit during the save: that edit would be lost, so it still asks
test('保存途中又改过再离开：照样先问', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'first-leave.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-slow', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('写入并应用')
  await addRule(page, 'second-leave.example')
  await page.getByRole('link', { name: '日志', exact: true }).click()
  // 正在保存的那份照常落地，问的只是之后改的 / The part being saved still lands; the question is only about the later edits
  await expect(page.locator('dialog.confirm[open]')).toContainText('放弃保存开始后改的内容')
  await expect(page.locator('dialog.confirm[open]')).toContainText('正在保存的那份照常保存；保存开始以后改的会丢掉。')
  await page.locator('dialog.confirm[open]').getByRole('button', { name: '继续编辑' }).click()
  await expect(page).toHaveURL(/\/config/)
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

test('规则组弹窗里改了一半就按浏览器返回到别的分区：先问一句', async ({ page }) => {
  await page.goto('/')
  const nav = page.locator('.desktop-nav')
  await nav.getByRole('link', { name: '上游组' }).click()
  await nav.getByRole('link', { name: '规则', exact: true }).click()
  await page.getByRole('button', { name: '新建规则组', exact: true }).click()
  const dialog = page.locator('dialog.pdialog[open]')
  await dialog.getByPlaceholder('比如：内网解析').fill('半成品')
  await page.goBack()
  const ask = page.getByRole('alertdialog', { name: '放弃这个规则组的修改' })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: '继续编辑' }).click()
  await expect(dialog.getByPlaceholder('比如：内网解析')).toHaveValue('半成品')
})

test('整页编辑改了一半时窗口变宽、换成右侧面板：不问，修改跟过去', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/config')
  await addRule(page, 'wide.example')
  await page.locator('[data-rule]').first().locator('.rrow__main').click()
  await page.getByLabel('规则名称，可以不填，不填就用条件当名字').fill('改了一半')
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.locator('.editor--inspector')).toBeVisible()
  await page.waitForTimeout(500)
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(page.getByLabel('规则名称，可以不填，不填就用条件当名字')).toHaveValue('改了一半')
  expect(new URL(page.url()).searchParams.get('rule')).toBeNull()
})

test('域名映射：行里改了没点完成就离开、批量导入写了内容按 Esc，都先问', async ({ page }) => {
  await page.goto('/config?section=mapping')
  await page.getByLabel('要映射的域名').fill('nas.home.arpa')
  await page.getByLabel('回答的 IP 或域名').fill('192.168.1.10')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  // 先保存，草稿干净了，剩下的只有行里没点完成的那一笔 / Save first so the draft is clean and only the uncommitted row edit is left
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await page.locator('.rw__row').first().getByRole('button', { name: /操作/ }).click()
  await page.getByRole('menuitem', { name: '编辑' }).click()
  await page.locator('.rw__row').first().locator('input').nth(1).fill('192.168.1.99')
  await page.locator('.desktop-nav').getByRole('link', { name: '概览' }).click()
  const ask = page.getByRole('alertdialog', { name: '放弃这条域名映射的修改' })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: '继续编辑' }).click()
  await expect(page).toHaveURL(/section=mapping/)

  await page.getByRole('button', { name: '批量导入' }).click()
  await page.getByLabel('要导入的域名映射').fill('tv.home.arpa 192.168.1.20')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('alertdialog', { name: '放弃批量导入的修改' })).toBeVisible()
})

test('上游组抽屉：备用组开了又关、没改什么就关上，不问也不提示「已更新」', async ({ page }) => {
  await page.goto('/config?section=upstreams')
  await page.getByRole('button', { name: '新建上游组', exact: true }).first().click()
  let drawer = page.locator('dialog.pdrawer[open]')
  await drawer.getByLabel('名称', { exact: true }).fill('国内')
  await drawer.getByPlaceholder(/dns-query/).first().fill('223.5.5.5')
  await drawer.getByRole('button', { name: '新建', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  await page.locator('.gcard').first().getByRole('button', { name: '编辑' }).click()
  drawer = page.locator('dialog.pdrawer[open]')
  const fallback = drawer.getByRole('checkbox', { name: '使用备用组' })
  await fallback.check()
  await fallback.uncheck()
  await drawer.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(drawer).toHaveCount(0)
  await page.locator('.gcard').first().getByRole('button', { name: '编辑' }).click()
  await page.locator('dialog.pdrawer[open]').getByRole('button', { name: '完成', exact: true }).click()
  await expect(page.locator('dialog.pdrawer[open]')).toHaveCount(0)
  await expect(page.getByText(/^已更新/)).toHaveCount(0)
})

test('保存途中打开上游组抽屉，保存落地后改名：改的是打开的那个组，别的组一个不少', async ({ page }) => {
  await page.goto('/config?section=upstreams')
  await page.getByRole('button', { name: '新建上游组', exact: true }).first().click()
  const created = page.locator('dialog.pdrawer[open]')
  await created.getByLabel('名称', { exact: true }).fill('海外')
  await created.getByPlaceholder(/dns-query/).first().fill('8.8.8.8')
  await created.getByRole('button', { name: '新建', exact: true }).click()
  await expect(page.locator('.gcard')).toHaveCount(2)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-slow', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('写入并应用')
  await page.locator('.gcard').first().getByRole('button', { name: '编辑' }).click()
  const drawer = page.locator('dialog.pdrawer[open]')
  await expect(bar).toContainText('已生效', { timeout: 5000 })
  await drawer.getByLabel('名称', { exact: true }).fill('改过名')
  await drawer.getByRole('button', { name: '完成', exact: true }).click()
  await expect(page.locator('.gcard')).toHaveCount(2)
  await expect(page.locator('.gcard', { hasText: '海外' })).toHaveCount(1)
  await expect(page.locator('.gcard', { hasText: '改过名' })).toHaveCount(1)
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

// 单独点的「校验」还没回来时离开：没有在保存，问的是整份草稿；按保存不会被吞掉，等校验回来接着存
// Leaving while a lone 校验 is out: nothing is being saved, so the question is about the whole draft; pressing save is not swallowed, it waits for the check
test('校验途中离开问整份草稿，按保存会等校验回来接着存', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'checking.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-validate-slow', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '校验' }).click()
  await expect(bar).toContainText('校验中')
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect(page.locator('dialog.confirm[open]')).toContainText('放弃未保存的修改')
  await page.locator('dialog.confirm[open]').getByRole('button', { name: '继续编辑' }).click()
  await bar.getByRole('button', { name: '校验' }).click()
  await expect(bar).toContainText('校验中')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText(/已生效\s*·\s*版本 #\d+/, { timeout: 8000 })
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-validate-slow'))
})

// 保存途中换掉草稿的操作先停用：重新读取、恢复版本都会和那次保存撞上 / Actions that replace the draft wait during a save: re-reading or restoring would collide with it
test('保存途中不能重新读取或恢复版本', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'busy.example')
  // 校验和写入都放慢，保存前后要 3 秒，够打开历史版本 / Validation and the write both slowed: 3 s of save, enough to open the history
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', 'true'); localStorage.setItem('kixdns:demo-validate-slow', 'true') })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('校验')
  await page.getByRole('button', { name: '更多配置操作' }).click()
  await expect(page.getByRole('menuitem', { name: '重新读取配置' })).toBeDisabled()
  await page.getByRole('menuitem', { name: '历史版本' }).click()
  await page.locator('dialog.hist[open]').getByRole('button', { name: '版本 #17 的操作' }).click()
  // 弹层里停用的菜单项按角色找不到，按元素找 / A disabled menu item inside the dialog is not found by role, so find the element itself
  await expect(page.locator('[role=menuitem]', { hasText: '恢复为这个版本' })).toBeDisabled()
  await expect(page.locator('[role=menuitem]', { hasText: '删除这个版本' })).toBeDisabled()
  await page.evaluate(() => { localStorage.removeItem('kixdns:demo-save-slow'); localStorage.removeItem('kixdns:demo-validate-slow') })
})

// 在输入框里按 Ctrl+S：焦点留在输入框里，接着打的字不会跑到按钮上或者变成快捷键
// Ctrl+S in a field: focus stays in the field, so the next keys neither go to the button nor fire shortcuts
test('在输入框里按 Ctrl+S，焦点不离开输入框', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机没有键盘 / phones have no keyboard')
  await page.goto('/config')
  await addRule(page, 'typing.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-slow', 'true'))
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.focus()
  await page.keyboard.press('Control+s')
  // 保存还在进行时接着打字：字进输入框，不进保存按钮 / Typing on while the save runs: the keys go into the field, not to the save button
  await expect(page.locator('.cfg__savebar')).toContainText('写入并应用')
  await page.keyboard.type('next')
  await expect(quick).toBeFocused()
  await expect(quick).toHaveValue('next')
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

// 宽屏右侧面板里按 Ctrl+S：修改收进草稿并保存，面板不关，焦点还在名字框里 / Ctrl+S in the wide side panel: the edit goes into the draft and is saved, the panel stays open and focus stays in the name field
test('宽屏右侧编辑规则时按 Ctrl+S，保存后面板不关', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '只看宽屏的右侧面板')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/config')
  await addRule(page, 'panel.example')
  await page.keyboard.press('Escape')
  await page.locator('[data-rule]', { hasText: 'panel.example' }).locator('.rrow__main').click()
  const name = page.getByLabel('规则名称，可以不填，不填就用条件当名字')
  await name.fill('面板里改的名字')
  await page.keyboard.press('Control+s')
  await expect(page.locator('.cfg__savebar')).toContainText(/已生效/, { timeout: 8000 })
  await expect(name).toBeVisible()
  await expect(name).toBeFocused()
  await expect(page.locator('[data-rule]', { hasText: '面板里改的名字' })).toHaveCount(1)
})

// 草稿留在内存里时退出登录：先问一句，同意了才放下 / Signing out with a held draft: ask first, and let it go only on agreement
test('配置页的草稿还留着时退出登录先问', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '账户菜单在宽屏的顶栏')
  await page.goto('/config')
  await addRule(page, 'held.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', 'true'); localStorage.setItem('kixdns:demo-save-conflict', 'true') })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('写入并应用')
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContain('配置没有保存：这份配置在别处改过了。草稿留在配置页，回去重新读取后再改')
  await page.getByRole('button', { name: /^账户：/ }).click()
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.locator('dialog.confirm[open]')).toContainText('放弃配置页的草稿')
  await page.locator('dialog.confirm[open]').getByRole('button', { name: '先不退出' }).click()
  await expect(page).toHaveURL(/\/logs/)
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

// 开着右侧规则面板（没改动）时断线又连上：静默重读的是同一份文件，面板不会自己关上 / A side panel open (unedited) through an outage: the quiet re-read finds the same file, so the panel does not close by itself
test('断线又连上时开着的规则面板不会自己关上', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '只看宽屏的右侧面板')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/config')
  await addRule(page, 'stay-open.example')
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__savebar')).toContainText(/已生效/, { timeout: 8000 })
  await page.locator('[data-rule]', { hasText: 'stay-open.example' }).locator('.rrow__main').click()
  const name = page.getByLabel('规则名称，可以不填，不填就用条件当名字')
  await expect(name).toBeVisible()
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-panel-down', 'true'); window.dispatchEvent(new Event('kixdns:panel-unreachable')) })
  await expect(page.locator('.conn__inner')).toBeVisible()
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-panel-down'))
  await expect(page.locator('.conn__inner')).toHaveCount(0, { timeout: 10_000 })
  await page.waitForTimeout(800)
  await expect(name).toBeVisible()
})

// 保存途中退出登录、同意放弃：确认框说了「不再告诉你结果」，登录页就不再弹那次保存的结果
// Signing out mid-save and agreeing to drop the draft: the confirm said no result would follow, so the login page shows none
test('保存途中退出登录并放弃：登录页不再说那次保存的结果', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '账户菜单在宽屏的顶栏')
  await page.goto('/config')
  await addRule(page, 'signout.example')
  // 保存要慢到走到退出登录的确认框时还在做（1.5 秒在机器忙时不够） / The save must still be running when the sign-out confirm opens (1.5
  // seconds is not enough on a busy machine)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-slow', '4000'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('写入并应用')
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await page.getByRole('button', { name: /^账户：/ }).click()
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.locator('dialog.confirm[open]')).toContainText('退出登录以后不再告诉你结果')
  await page.locator('dialog.confirm[open]').getByRole('button', { name: '放弃并退出' }).click()
  await expect(page).toHaveURL(/\/login/)
  // 慢保存要 4 秒才落地：等它落地以后再看 / The slow save takes 4 s to land: look after it has
  await page.waitForTimeout(5000)
  expect((await toastTexts(page)).filter((text) => text.includes('已生效'))).toEqual([])
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

// 应用失败过的版本，重启以后面板不会再试（旧文件已经放回去了）：重启的确认框照实说，并指到「重试应用」
// A version that failed to apply is not retried after a restart (the old file was put back): the restart confirm says so and points to 重试应用
test('应用失败的版本：重启确认框不说「重启后应用」', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'failed-apply.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-apply-failed', 'true'))
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('main')).toContainText('没有生效，仍在用之前那份配置')
  await page.getByRole('link', { name: '系统', exact: true }).first().click()
  await page.getByRole('button', { name: '重启', exact: true }).click()
  const dialog = page.locator('dialog.confirm[open]')
  await expect(dialog).toContainText('没有生效，重启后仍用之前那份配置；要再试，到配置页点\u2060「重试应用」')
  await expect(dialog).not.toContainText('重启后应用待应用的版本')
  await page.keyboard.press('Escape')
})

// 「重试应用」「现在应用」每次都存成一个新版本：成功时说出按的是哪一版、现在是哪一版，备注跟着到新版本上
// （以前只说「版本 #N+1 已生效」，按的明明是 #N，新版本还没有备注）
// 重试应用 and 现在应用 are each stored as a new version: success names the version pressed and the current one, and the note moves to the new version
// (it used to say only 版本 #N+1 已生效 although #N was pressed, and the new version had no note)
test('重试应用成功：说出两个版本号，备注带到新版本', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'retry-note.example')
  const bar = page.locator('.cfg__savebar')
  // 宽屏的备注框一直在，窄一些才收在「备注」后面 / Wide screens always show the note field; narrower ones keep it behind 备注
  const note = bar.getByLabel('版本备注')
  if (!(await note.isVisible())) await bar.locator('.savebar__note-toggle').click()
  await note.fill('把视频域名交给 CDN 组')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-apply-failed', 'true'))
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('main')).toContainText('没有生效，仍在用之前那份配置')
  const failed = Number((await page.locator('main').innerText()).match(/版本 #(\d+) 没有生效/)![1])
  await page.getByRole('button', { name: '重试应用' }).click()
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContain(`已应用版本 #${failed} 的内容，当前版本\u00a0#${failed + 1}`)
  await page.getByRole('button', { name: '更多配置操作' }).click()
  await page.getByRole('menuitem', { name: '历史版本' }).click()
  await expect(page.locator('.hist__row').first()).toContainText(`#${failed + 1}`)
  await expect(page.locator('.hist__row').first()).toContainText('把视频域名交给 CDN 组')
})

// 存成待应用的版本，按「现在应用」：页头说的是 #N，生效的就是 #N（以前另存一个内容相同的 #N+1），备注留在它上面
// Save a pending version and press 现在应用: the header said #N and #N is what takes effect (it used to store an identical #N+1), with its note
async function savePending(page: Page, domain: string, note: string): Promise<number> {
  await page.goto('/config')
  await addRule(page, domain)
  const bar = page.locator('.cfg__savebar')
  const field = bar.getByLabel('版本备注')
  if (!(await field.isVisible())) await bar.locator('.savebar__note-toggle').click()
  await field.fill(note)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-pending', 'true'))
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('main .ui-ph')).toContainText('待应用')
  // 等这次保存连同它的重读都做完：之后设的演示开关才不会被这次重读用掉 / Wait for the save and its re-read to finish, so a demo flag set afterwards is not used up by that re-read
  await expect(bar).toContainText('已存成待应用版本')
  return Number((await page.locator('main .ui-ph').innerText()).match(/版本 #(\d+) 待应用/)![1])
}
const reconnect = (page: Page) => page.evaluate(async () => {
  localStorage.removeItem('kixdns:demo-panel-down')
  const url = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/composables/useConnection.ts')).pop()!
  const connection = await import(url)
  void connection.useConnection().retry()
})

test('现在应用：待应用的版本原地生效，编号和备注不变，不多出版本', async ({ page }) => {
  const pending = await savePending(page, 'in-place.example', '把视频域名交给 CDN 组')
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContain(`版本 #${pending} 已生效`)
  await page.getByRole('button', { name: '更多配置操作' }).click()
  await page.getByRole('menuitem', { name: '历史版本' }).click()
  const top = page.locator('.hist__row').first()
  await expect(top).toContainText(`#${pending}`)
  await expect(top).toContainText('把视频域名交给 CDN 组')
  await expect(page.locator('.hist__row', { hasText: `#${pending + 1}` })).toHaveCount(0)
})

test('现在应用的回应丢了：连上以后按待应用的还在不在核对，说出结果', async ({ page }) => {
  const pending = await savePending(page, 'in-place-lost.example', '回应丢了')
  // 生效了，回应却没回来 / In effect, but the answer never arrives
  await page.evaluate(() => localStorage.setItem('kixdns:demo-put-answer-lost', 'true'))
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await expect(page.locator('.conn__inner')).toBeVisible()
  await reconnect(page)
  await expect.poll(() => toastTexts(page), { timeout: 8000 }).toContain(`刚才那次应用：版本 #${pending} 已生效`)
})

// 离开配置页以后保存成功的提示也是配置页的结果：会话结束时一起收起，不带到登录页上
// The success toast of a save that finished after leaving the config page is a config-page outcome too: it goes when the session ends, not onto the login page
test('离开以后保存成功的提示：会话结束时收起，不留在登录页', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'away-success.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-slow', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('写入并应用')
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect.poll(async () => (await toastTexts(page)).some((text) => /^版本 #\d+ 已生效$/.test(text)), { timeout: 5000 }).toBe(true)
  await page.evaluate(async () => {
    const { SESSION_EXPIRED_EVENT } = await import('/src/api/client.ts')
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
  })
  await expect(page).toHaveURL(/\/login/)
  expect((await toastTexts(page)).filter((text) => text.includes('已生效'))).toEqual([])
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

// 现在应用的回应丢了、人去了别的页、断线时别处又存了一版：连上以后「不知道…应用了没有」换成核对的结果，不悄悄收掉
// 现在应用 lost its answer, the user went to another page, and another version was saved elsewhere meanwhile: once back, 「不知道…应用了没有」 is replaced by
// the check's result instead of quietly going away
test('现在应用的回应丢了、离开以后别处改过：连上以后说那次应用不在现在的配置里', async ({ page }) => {
  const pending = await savePending(page, 'apply-lost-away.example', '离开以后')
  await page.evaluate(() => {
    window.addEventListener('kixdns:panel-unreachable', () => localStorage.setItem('kixdns:demo-panel-down', 'true'), { capture: true, once: true })
    localStorage.setItem('kixdns:demo-put-answer-lost', 'true')
  })
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await expect(page.locator('.conn__inner')).toBeVisible()
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContain(`不知道版本 #${pending} 应用了没有：连不上面板。连上后会自己核对`)
  // 别处直接存了一版 / Another version is saved elsewhere
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/api/mock.ts')).pop()!
    const { mockRequest } = await import(url)
    const current = await mockRequest('/api/v1/config')
    const content = JSON.parse(JSON.stringify(current.content))
    content.settings = { ...content.settings, cache_capacity: 4321 }
    await mockRequest('/api/v1/config', { method: 'PUT', body: JSON.stringify({ content, expected_sha256: current.sha256, message: '别处' }) })
  })
  await reconnect(page)
  await expect.poll(async () => (await toastTexts(page)).some((text) => text.startsWith('刚才那次应用不在现在的配置里：这份配置在别处改过了')), { timeout: 8000 }).toBe(true)
  expect(await toastTexts(page)).not.toContain(`不知道版本 #${pending} 应用了没有：连不上面板。连上后会自己核对`)
})

test('现在应用没送到面板：连上以后说还没有应用，不说成功', async ({ page }) => {
  const pending = await savePending(page, 'in-place-unsent.example', '没送到')
  // 面板这时已经连不上了，页面还不知道：按下去的请求根本没到 / The panel is already unreachable and the page does not know yet: the request never arrives
  await page.evaluate(() => localStorage.setItem('kixdns:demo-panel-down', 'true'))
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await expect(page.locator('.conn__inner')).toBeVisible()
  await reconnect(page)
  await expect.poll(() => toastTexts(page), { timeout: 8000 }).toContain(`版本 #${pending} 还没有应用，可以再点「现在应用」`)
  await expect(page.locator('main .ui-ph')).toContainText(`版本 #${pending} 待应用`)
})

// 没送到、人随后离开：待应用的版本还在，后台会自己补上，所以用会自己收起的提示说什么时候自己应用，不挂一条要手动关、还指回配置页按钮的红色提示
// Never arrived and the user then left: the pending version is still there and the background catches up, so a self-dismissing toast
// says when it applies by itself, not a red one to close by hand that points back at a button on the config page
test('现在应用没送到面板、人随后离开：连上以后用会自己收起的提示说还没有应用、什么时候自己应用', async ({ page }) => {
  const pending = await savePending(page, 'in-place-unsent-away.example', '没送到又离开')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-panel-down', 'true'))
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await expect(page.locator('.conn__inner')).toBeVisible()
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContain(`不知道版本 #${pending} 应用了没有：连不上面板。连上后会自己核对`)
  await reconnect(page)
  // KixDNS 在：后台那一遍几秒内就补上 / KixDNS is in: the background pass catches up within seconds
  await expect.poll(() => toastTexts(page), { timeout: 8000 }).toContain(`版本 #${pending} 还没有应用，几秒内会自动应用`)
  await expect(page.locator('.toast--info', { hasText: '还没有应用' })).toHaveCount(1)
  await expect(page.locator('.toast--error')).toHaveCount(0)
})

// 回应丢了、其实到了服务端被拒、人在配置页上：提示条（带「重试应用」）说没有生效，不另弹一条说同一件事的红色提示
// The answer was lost though the server got it and refused it, with the user on the config page: the notice (with 重试应用) says it
// did not take, and no red toast repeats it
test('现在应用被拒、回应却丢了，人在配置页上：连上以后只由提示条说没有生效', async ({ page }) => {
  // 被拒的回应换成断线：服务端已经记下没有生效，页面只知道连不上 / The refusal's answer is swapped for an outage: the server has
  // recorded the refusal, the page only knows it could not reach the panel
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('lose-refusal')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?lose-refusal';
      import { apiRequest as original, ApiError, PANEL_UNREACHABLE_EVENT } from '/src/api/client.ts?lose-refusal';
      export async function apiRequest(path, init) {
        try { return await original(path, init) } catch (error) {
          if (!/\\/apply$/.test(String(path)) || error?.code !== 'reload_failed' || localStorage.getItem('e2e:lose-refusal') !== 'true') throw error;
          localStorage.removeItem('e2e:lose-refusal');
          localStorage.setItem('kixdns:demo-panel-down', 'true');
          window.dispatchEvent(new Event(PANEL_UNREACHABLE_EVENT));
          throw new ApiError('连不上面板：网络断了，或者面板正在重启。稍后再试。', 0, 'network_unreachable');
        }
      }
    ` })
  })
  const pending = await savePending(page, 'in-place-refused-lost.example', '被拒又丢了回应')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-apply-failed', 'true'); localStorage.setItem('e2e:lose-refusal', 'true') })
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await expect(page.locator('.conn__inner')).toBeVisible()
  await reconnect(page)
  await expect(page.locator('.cfg__notice')).toContainText(`版本 #${pending} 没有生效`, { timeout: 8000 })
  await expect(page.locator('.cfg__notice').getByRole('button', { name: '重试应用', exact: true })).toBeVisible()
  await expect(page.locator('main .ui-ph')).toContainText('应用失败')
  await expect(page.locator('.toast', { hasText: '没有生效' })).toHaveCount(0)
})

// 「重试应用」丢了回应：提示条读起来和按下之前一样，所以核对的结果另说一句，照回应回来时那次重试的说法；没送到就说没送到，指「重试应用」
// 重试应用 lost its answer: the notice reads as it did before the press, so the check's result is said separately, in the words of a
// retry whose answer arrived; one that never arrived says so and points at 重试应用
async function failOnce(page: Page, domain: string): Promise<number> {
  const pending = await savePending(page, domain, '先没有生效')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-apply-failed', 'true'))
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await expect(page.locator('.cfg__notice')).toContainText(`版本 #${pending} 没有生效`)
  return pending
}
test('重试应用被拒、回应却丢了，人在配置页上：连上以后说重试也没有生效、存成了哪一版', async ({ page }) => {
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('lose-retry')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?lose-retry';
      import { apiRequest as original, ApiError, PANEL_UNREACHABLE_EVENT } from '/src/api/client.ts?lose-retry';
      export async function apiRequest(path, init) {
        try { return await original(path, init) } catch (error) {
          if (String(path) !== '/api/v1/config' || init?.method !== 'PUT' || error?.code !== 'reload_failed' || localStorage.getItem('e2e:lose-retry') !== 'true') throw error;
          localStorage.removeItem('e2e:lose-retry');
          localStorage.setItem('kixdns:demo-panel-down', 'true');
          window.dispatchEvent(new Event(PANEL_UNREACHABLE_EVENT));
          throw new ApiError('连不上面板：网络断了，或者面板正在重启。稍后再试。', 0, 'network_unreachable');
        }
      }
    ` })
  })
  const pending = await failOnce(page, 'retry-refused-lost.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-apply-failed', 'true'); localStorage.setItem('e2e:lose-retry', 'true') })
  await page.locator('.cfg__notice').getByRole('button', { name: '重试应用', exact: true }).click()
  // 在页上由提示条说，断线时也说（「连不上面板」由横幅说） / On the page the notice says it, during the outage too (the banner says 连不上面板)
  await expect(page.locator('.cfg__notice')).toContainText('不知道重试应用了没有。')
  await expect(page.locator('.cfg__notice')).toContainText('连上后会自己核对')
  await reconnect(page)
  await expect(page.locator('.cfg__notice')).toContainText(`版本 #${pending + 1} 没有生效`, { timeout: 8000 })
  // 原因由提示条说，提示只交代重试的结果和编号 / The notice gives the cause; the toast only tells the retry's outcome and number
  await expect.poll(async () => (await toastTexts(page)).filter((text) => text === `重试也没有生效，存成了版本 #${pending + 1}`).length, { timeout: 5000 }).toBe(1)
  expect(await toastTexts(page)).not.toContain('不知道重试应用了没有：连不上面板。连上后会自己核对')
})


test('重试应用被拒、回应却丢了、人已离开：连上以后和回应回来时说同一句，带上原因', async ({ page }) => {
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('lose-retry')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?lose-retry';
      import { apiRequest as original, ApiError, PANEL_UNREACHABLE_EVENT } from '/src/api/client.ts?lose-retry';
      export async function apiRequest(path, init) {
        try { return await original(path, init) } catch (error) {
          if (String(path) !== '/api/v1/config' || init?.method !== 'PUT' || error?.code !== 'reload_failed' || localStorage.getItem('e2e:lose-retry') !== 'true') throw error;
          localStorage.removeItem('e2e:lose-retry');
          localStorage.setItem('kixdns:demo-panel-down', 'true');
          window.dispatchEvent(new Event(PANEL_UNREACHABLE_EVENT));
          throw new ApiError('连不上面板：网络断了，或者面板正在重启。稍后再试。', 0, 'network_unreachable');
        }
      }
    ` })
  })
  const pending = await failOnce(page, 'retry-refused-lost.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-apply-failed', 'true'); localStorage.setItem('e2e:lose-retry', 'true') })
  await page.locator('.cfg__notice').getByRole('button', { name: '重试应用', exact: true }).click()
  // 在页上由提示条说，断线时也说（「连不上面板」由横幅说） / On the page the notice says it, during the outage too (the banner says 连不上面板)
  await expect(page.locator('.cfg__notice')).toContainText('不知道重试应用了没有。')
  await expect(page.locator('.cfg__notice')).toContainText('连上后会自己核对')
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await reconnect(page)
  // 接住「不知道重试应用了没有」，离开时这条是唯一说原因的地方 / Answers 「不知道重试应用了没有」; away, this is the only place giving the cause
  await expect.poll(() => toastTexts(page), { timeout: 8000 }).toContain(`重试也没有生效，存成了版本 #${pending + 1}。KixDNS 没有接受这份配置：upstream "fast" did not answer the health check`)
  expect((await toastTexts(page)).some((text) => text.startsWith('刚才那次应用') || text.startsWith('不知道重试'))).toBe(false)
})
test('重试应用没送到面板：连上以后说没送到，指「重试应用」，不说还没有应用', async ({ page }) => {
  const pending = await failOnce(page, 'retry-unsent.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-panel-down', 'true'))
  await page.locator('.cfg__notice').getByRole('button', { name: '重试应用', exact: true }).click()
  await expect(page.locator('.conn__inner')).toBeVisible()
  await reconnect(page)
  await expect.poll(() => toastTexts(page), { timeout: 8000 }).toContain('重试没有送到面板，可以再点「重试应用」')
  expect((await toastTexts(page)).some((text) => text.includes('还没有应用'))).toBe(false)
  await expect(page.locator('.cfg__notice')).toContainText(`版本 #${pending} 没有生效`)
})

// 「重试应用」没送到、人离开了配置页：「不知道重试应用了没有」换成核对的结果，不是一声不响地收掉（在页上断线后离开、离开以后才断，两条路）
// 重试应用 never arrived and the user left the config page: 「不知道重试应用了没有」 is replaced by the check's result instead of quietly
// going (cut off on the page and then left, or cut off only once away: two paths)
test('重试应用没送到面板、随后离开配置页：连上以后说没送到，指回配置页的「重试应用」', async ({ page }) => {
  await failOnce(page, 'retry-unsent-left.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-panel-down', 'true'))
  await page.locator('.cfg__notice').getByRole('button', { name: '重试应用', exact: true }).click()
  // 在页上由提示条说，断线时也说（「连不上面板」由横幅说） / On the page the notice says it, during the outage too (the banner says 连不上面板)
  await expect(page.locator('.cfg__notice')).toContainText('不知道重试应用了没有。')
  await expect(page.locator('.cfg__notice')).toContainText('连上后会自己核对')
  await page.getByRole('link', { name: '日志', exact: true }).click()
  // 真离开了配置页再连上：离开前要走一遍离页检查，不等的话核对会在配置页上做 / Reconnect only once the config page is really left:
  // leaving runs the leave guard first, and without the wait the check runs on the config page
  await expect(page).toHaveURL(/\/logs/)
  await reconnect(page)
  await expect.poll(() => toastTexts(page), { timeout: 8000 }).toContain('重试没有送到面板，回到配置页可以再点「重试应用」')
  expect(await toastTexts(page)).not.toContain('不知道重试应用了没有：连不上面板。连上后会自己核对')
})

test('按了重试应用马上离开、离开以后才断线：连上以后说没送到，不是一声不响', async ({ page }) => {
  // 那次重试晚一点再断，而且根本没到服务端 / The retry is cut off a little later and never reaches the server
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('drop-retry')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?drop-retry';
      import { apiRequest as original, ApiError, PANEL_UNREACHABLE_EVENT } from '/src/api/client.ts?drop-retry';
      export async function apiRequest(path, init) {
        if (String(path) !== '/api/v1/config' || init?.method !== 'PUT' || localStorage.getItem('e2e:drop-retry') !== 'true') return original(path, init);
        localStorage.removeItem('e2e:drop-retry');
        await new Promise((resolve) => setTimeout(resolve, 800));
        localStorage.setItem('kixdns:demo-panel-down', 'true');
        window.dispatchEvent(new Event(PANEL_UNREACHABLE_EVENT));
        throw new ApiError('连不上面板：网络断了，或者面板正在重启。稍后再试。', 0, 'network_unreachable');
      }
    ` })
  })
  await failOnce(page, 'retry-dropped-away.example')
  await page.evaluate(() => localStorage.setItem('e2e:drop-retry', 'true'))
  await page.locator('.cfg__notice').getByRole('button', { name: '重试应用', exact: true }).click()
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContain('不知道重试应用了没有：连不上面板。连上后会自己核对')
  await reconnect(page)
  await expect.poll(() => toastTexts(page), { timeout: 8000 }).toContain('重试没有送到面板，回到配置页可以再点「重试应用」')
  expect(await toastTexts(page)).not.toContain('不知道重试应用了没有：连不上面板。连上后会自己核对')
})

// 被拒以后页头直接换成应用失败：重读回来之前不闪「待应用 · 现在应用」，也没有一个还能按的「现在应用」
// After a refusal the header goes straight to 应用失败: no 待应用 · 现在应用 flash before the re-read lands, and no 现在应用 left to press
// 从按下到页头说应用失败，每一帧都看：有没有一个能按的「现在应用」 / Every frame from the press until the header says 应用失败: is
// there a 现在应用 that can be pressed
async function applyNowOffered(page: Page): Promise<boolean> {
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  return page.evaluate(() => new Promise<boolean>((resolve) => {
    let seen = false
    const look = () => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('main button')].find((b) => b.textContent?.trim() === '现在应用' && b.offsetParent !== null)
      if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && !button.closest('[inert]')) seen = true
      if (document.querySelector('main .ui-ph')?.textContent?.includes('应用失败')) resolve(seen)
      else requestAnimationFrame(look)
    }
    requestAnimationFrame(look)
  }))
}
test('现在应用被拒：页头直接说应用失败，重读回来之前不再给「现在应用」', async ({ page }) => {
  await savePending(page, 'in-place-refused-flash.example', '被拒不闪')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-apply-failed', 'true'); localStorage.setItem('kixdns:demo-read-slow', 'true') })
  expect(await applyNowOffered(page)).toBe(false)
  await expect(page.locator('.cfg__notice')).toContainText('没有生效')
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-read-slow'))
})

// 「读不懂 KixDNS 的回应」那一种被拒也一样：本地照服务端常见的存法记下原因，页头不闪 / A refusal reported as an unreadable reply too:
// the cause is recorded locally as the server commonly stores it, and the header does not flash
test('现在应用回「读不懂 KixDNS 的回应」：页头也直接说应用失败，不闪「现在应用」', async ({ page }) => {
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('as-protocol')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?as-protocol';
      import { apiRequest as original, ApiError } from '/src/api/client.ts?as-protocol';
      export async function apiRequest(path, init) {
        try { return await original(path, init) } catch (error) {
          if (!/\\/apply$/.test(String(path)) || error?.code !== 'reload_failed') throw error;
          throw new ApiError('unexpected end of input', 503, 'kixdns_protocol_error');
        }
      }
    ` })
  })
  await savePending(page, 'in-place-protocol.example', '读不懂回应')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-apply-failed', 'true'); localStorage.setItem('kixdns:demo-read-slow', 'true') })
  expect(await applyNowOffered(page)).toBe(false)
  await expect(page.locator('.cfg__notice')).toContainText('没有生效')
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-read-slow'))
})

// 连着被拒两次再成功：「重试也没有生效」任何时候只有一条（只说最近那一次），成功以后一条都不剩
// Refused twice, then it works: there is only ever one 「重试也没有生效」 (about the latest retry), and none is left after the success
test('重试应用连着被拒两次再成功：只留最近那一次的结果，成功以后收起', async ({ page }) => {
  const pending = await failOnce(page, 'retry-twice.example')
  const retries = () => toastTexts(page).then((texts) => texts.filter((text) => text.startsWith('重试也没有生效')))
  for (const attempt of [1, 2]) {
    await page.evaluate(() => localStorage.setItem('kixdns:demo-apply-failed', 'true'))
    await page.locator('.cfg__notice').getByRole('button', { name: '重试应用', exact: true }).click()
    await expect.poll(retries, { timeout: 5000 }).toEqual([`重试也没有生效，存成了版本 #${pending + attempt}`])
  }
  await page.locator('.cfg__notice').getByRole('button', { name: '重试应用', exact: true }).click()
  await expect(page.locator('.cfg__notice')).toHaveCount(0, { timeout: 8000 })
  expect(await retries()).toEqual([])
})

// 「重试也没有生效」说的是那一版：失败的换成了别的版本（这里是改了再保存又被拒），它就过时了，收起；离开配置页时页上那条也收起
// 「重试也没有生效」 speaks of that version: once the failure is another version (here a further save refused too) it is stale and
// goes; the one said on the page also goes when the config page is left
test('重试被拒以后改了再保存又被拒：先前那条「重试也没有生效」收起', async ({ page }) => {
  const pending = await failOnce(page, 'retry-then-save.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-apply-failed', 'true'))
  await page.locator('.cfg__notice').getByRole('button', { name: '重试应用', exact: true }).click()
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContain(`重试也没有生效，存成了版本 #${pending + 1}`)
  await addRule(page, 'saved-after-retry.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-apply-failed', 'true'))
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__notice')).toContainText(`版本 #${pending + 2} 没有生效`, { timeout: 8000 })
  expect((await toastTexts(page)).filter((text) => text.startsWith('重试也没有生效'))).toEqual([])
})

test('页上说的「重试也没有生效」：离开配置页时收起，不带到别的页', async ({ page }) => {
  const pending = await failOnce(page, 'retry-then-leave.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-apply-failed', 'true'))
  await page.locator('.cfg__notice').getByRole('button', { name: '重试应用', exact: true }).click()
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContain(`重试也没有生效，存成了版本 #${pending + 1}`)
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  expect((await toastTexts(page)).filter((text) => text.startsWith('重试也没有生效'))).toEqual([])
})

// 恢复版本也被拒：服务端已经把旧内容存成了新的一版、记成没有生效。页面跟着重读，先前的「重试也没有生效」收起，提示条说新的那一版，
// 再按「重试应用」不撞上「别处改过了」（那是这一页自己的恢复）
// A restore refused too: the server has stored the old content as a new version and recorded it as not taken. The page reads again,
// the earlier 「重试也没有生效」 goes, the notice names the new version, and 重试应用 does not meet 别处改过了 (that was this page's own
// restore)
test('重试被拒以后恢复一个版本，恢复也被拒：页面跟着服务端，再重试不说别处改过了', async ({ page }) => {
  const pending = await failOnce(page, 'retry-then-restore.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-apply-failed', 'true'))
  await page.locator('.cfg__notice').getByRole('button', { name: '重试应用', exact: true }).click()
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContain(`重试也没有生效，存成了版本 #${pending + 1}`)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-apply-failed', 'true'))
  await page.getByRole('button', { name: '更多配置操作' }).click()
  await page.getByRole('menuitem', { name: '历史版本' }).click()
  await page.locator('.hist__row', { hasText: '#17' }).locator('.hist__menu button[aria-haspopup]').click()
  await page.locator('[role=menuitem]', { hasText: '恢复为这个版本' }).click()
  await page.locator('dialog.confirm[open]').getByRole('button', { name: /恢复为版本 #17/ }).click()
  // 「的内容」后面的断点显示时才放，文字里没有零宽空格 / The break after 的内容 is placed when shown; the text carries no zero-width space
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContain(`版本\u00a0#17\u00a0的内容存成了版本\u00a0#${pending + 2}，没有生效`)
  expect((await toastTexts(page)).filter((text) => text.startsWith('重试也没有生效'))).toEqual([])
  await page.keyboard.press('Escape')
  await expect(page.locator('.cfg__notice')).toContainText(`版本 #${pending + 2} 没有生效`)
  await page.locator('.cfg__notice').getByRole('button', { name: '重试应用', exact: true }).click()
  await expect(page.locator('.cfg__notice')).toHaveCount(0, { timeout: 8000 })
  expect((await toastTexts(page)).some((text) => text.includes('别处改过了'))).toBe(false)
})

// 重试被 KixDNS 的校验拒绝：服务端照样存下一版、记成没有生效，和别的被拒一样说「重试也没有生效，存成了版本 #N」，原因只由提示条说
// A retry refused by KixDNS's own check: the server still stores a version and records it as not taken, so it reads like the other
// refusals, 「重试也没有生效，存成了版本 #N」, with the cause given by the notice alone
test('重试应用被 KixDNS 的校验拒绝：说存成了哪一版、没有生效，不说「重试没有成功」', async ({ page }) => {
  const pending = await failOnce(page, 'retry-invalid.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-apply-invalid', 'true'))
  await page.locator('.cfg__notice').getByRole('button', { name: '重试应用', exact: true }).click()
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContain(`重试也没有生效，存成了版本 #${pending + 1}`)
  expect((await toastTexts(page)).some((text) => text.startsWith('重试没有成功'))).toBe(false)
  await expect(page.locator('.cfg__notice')).toContainText(`版本 #${pending + 1} 没有生效`)
  // 原因说成没有通过 KixDNS 的校验：不把「没有生效」再说一遍，也不指一张这里没有的问题列表 / The cause reads as failing KixDNS's check:
  // not 没有生效 said again, nor a list of problems that is not here
  await expect(page.locator('.cfg__notice')).toContainText('没有通过 KixDNS 的校验')
  await expect(page.locator('.cfg__notice')).not.toContainText('先改好校验里列出的问题')
})

// 现在应用被拒、回应丢了、人已离开，KixDNS 在：连上以后和回应回来时说同一句，带上原因 / 现在应用 refused, answer lost, user away,
// KixDNS in: once back it reads as when the answer arrives, cause included
test('现在应用被拒、回应丢了、人已离开：连上以后和回应回来时说同一句，带上原因', async ({ page }) => {
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('lose-apply')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?lose-apply';
      import { apiRequest as original, ApiError, PANEL_UNREACHABLE_EVENT } from '/src/api/client.ts?lose-apply';
      export async function apiRequest(path, init) {
        try { return await original(path, init) } catch (error) {
          if (!/\\/apply$/.test(String(path)) || error?.code !== 'reload_failed' || localStorage.getItem('e2e:lose-refusal') !== 'true') throw error;
          localStorage.removeItem('e2e:lose-refusal');
          localStorage.setItem('kixdns:demo-panel-down', 'true');
          window.dispatchEvent(new Event(PANEL_UNREACHABLE_EVENT));
          throw new ApiError('连不上面板：网络断了，或者面板正在重启。稍后再试。', 0, 'network_unreachable');
        }
      }
    ` })
  })
  const pending = await savePending(page, 'in-place-refused-away-in.example', '被拒、离开')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-apply-failed', 'true'); localStorage.setItem('e2e:lose-refusal', 'true') })
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await expect(page.locator('.conn__inner')).toBeVisible()
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await reconnect(page)
  await expect.poll(() => toastTexts(page), { timeout: 8000 }).toContain(`版本 #${pending} 没有生效。KixDNS 没有接受这份配置：upstream "fast" did not answer the health check。回到配置页可以重试应用`)
  expect((await toastTexts(page)).some((text) => text.startsWith('刚才那次'))).toBe(false)
})

// 「校验并应用」（手改过的文件）没送到、断线期间 KixDNS 停了：启动时读的正是这份文件，不指启动以后不会出现的按钮
// 校验并应用 (a hand-edited file) never arrived and KixDNS stopped meanwhile: it reads this very file on start, so no pointing at a
// button that will not be there afterwards
test('校验并应用没送到、断线期间 KixDNS 停了：说启动后会读这份文件，不指「校验并应用」', async ({ page }) => {
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('file-differs')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?file-differs';
      import { apiRequest as original } from '/src/api/client.ts?file-differs';
      import { ApiError, PANEL_UNREACHABLE_EVENT } from '/src/api/client.ts?file-differs';
      export async function apiRequest(path, init) {
        // 写入那一步断线、没到服务端（校验照常过）：这样才走到丢了回应以后的核对 / Cut off at the write, which never reaches the server (the
        // check passes as usual): only then does the check after a lost answer run
        if (String(path) === '/api/v1/config' && init?.method === 'PUT' && localStorage.getItem('e2e:drop-write') === 'true') {
          localStorage.removeItem('e2e:drop-write');
          localStorage.setItem('kixdns:demo-panel-down', 'true');
          window.dispatchEvent(new Event(PANEL_UNREACHABLE_EVENT));
          throw new ApiError('连不上面板：网络断了，或者面板正在重启。稍后再试。', 0, 'network_unreachable');
        }
        const result = await original(path, init);
        // 停着时也没有在用的那份配置，和真服务端一样 / Stopped, no config is in use either, as on the real server
        if (String(path) === '/api/v1/config' && !init?.method) return { ...result, runtime: { ...result.runtime, status: 'different', ...(localStorage.getItem('e2e:kixdns-stopped') === 'true' ? { active_sha256: null } : {}) } };
        if (String(path) === '/api/v1/service' && localStorage.getItem('e2e:kixdns-stopped') === 'true') return { ...result, active_state: 'inactive' };
        return result;
      }
    ` })
  })
  await page.goto('/config')
  const check = page.getByRole('button', { name: '校验并应用', exact: true }).locator('visible=true').first()
  await expect(check).toBeVisible({ timeout: 8000 })
  await page.evaluate(() => localStorage.setItem('e2e:drop-write', 'true'))
  await check.click()
  await expect(page.locator('.conn__inner')).toBeVisible()
  await page.evaluate(() => localStorage.setItem('e2e:kixdns-stopped', 'true'))
  await reconnect(page)
  await expect.poll(() => toastTexts(page), { timeout: 8000 }).toContain('配置还没有应用，KixDNS\u00a0启动后会读这份文件')
  await page.evaluate(() => localStorage.removeItem('e2e:kixdns-stopped'))
})

// 读配置第一次失败：照「面板内部出错」答，紧接着那次读版本列表也失败（不然核对会照 KixDNS 在跑的那一版下结论），之后照常
// The first config read fails with 面板内部出错, and so does the version-list read right after it (or the check would settle from the
// version KixDNS runs), then all is as usual
const readFailsOnce = (page: Page) => page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
  if (route.request().url().includes('read-fails-once')) return route.continue()
  await route.fulfill({ contentType: 'application/javascript', body: `
    export * from '/src/api/client.ts?read-fails-once';
    import { apiRequest as original, ApiError } from '/src/api/client.ts?read-fails-once';
    export async function apiRequest(path, init) {
      if (String(path) === '/api/v1/config' && !init?.method && localStorage.getItem('e2e:read-fails-once') === 'true') {
        localStorage.removeItem('e2e:read-fails-once');
        localStorage.setItem('e2e:versions-next-fails', 'true');
        throw new ApiError('面板内部出错', 500, 'internal_error');
      }
      if (String(path) === '/api/v1/config/versions' && localStorage.getItem('e2e:versions-next-fails') === 'true') {
        localStorage.removeItem('e2e:versions-next-fails');
        throw new ApiError('面板内部出错', 500, 'internal_error');
      }
      return original(path, init);
    }
  ` })
})

// 回应丢了的那次保存，连上以后第一次核对读配置失败、5 秒后读到：保存条最后说已经保存过了，「读取配置失败」也跟着撤，谁先做完核对都一样
// A save whose answer was lost, with the first check after the reconnect failing to read and the next one 5 seconds later landing: the
// save bar ends on 已经保存过了 and 读取配置失败 goes too, whichever look finished the check
test('保存的回应丢了、连上以后第一次核对读不到配置：读到以后说已经保存过了，读取失败的说法也撤掉', async ({ page }) => {
  await readFailsOnce(page)
  await page.goto('/config')
  await addRule(page, 'read-fails-once.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-put-answer-lost', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  // 结果不知道：页面锁住，保存条收起，只由提示条说 / The outcome is unknown: the page locks, the save bar folds away, and only the notice
  // speaks
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。')
  await expect(page.locator('.cfg__panel')).toHaveAttribute('aria-busy', 'true')
  await expect(bar).toHaveCount(0)
  await page.evaluate(() => localStorage.setItem('e2e:read-fails-once', 'true'))
  await reconnect(page)
  // 读不到配置：原因跟着那一句，不另挂「读取配置失败」，不再说连不上面板 / The config cannot be read: the cause goes with that sentence, with no
  // separate 读取配置失败 and no more 连不上面板
  await expect(page.locator('.cfg__notice')).toContainText('读不到配置：面板内部出错。读到后会自己核对')
  await expect(page.getByText('读取配置失败')).toHaveCount(0)
  await expect(page.locator('.cfg__notice')).not.toContainText('连不上面板')
  // 读到以后解开，由保存条说结果 / Once read the page unlocks and the save bar tells the result
  await expect(bar).toContainText(/已经保存过了/, { timeout: 12_000 })
  await expect(page.locator('.cfg__panel')).not.toHaveAttribute('aria-busy', 'true')
  await expect(page.locator('.cfg__notice', { hasText: '不知道' })).toHaveCount(0)
})

// 读写照几个记号出错 / Reads and writes fail as a few marks say:
// - e2e:read-seq：读配置一次一次来，「1」失败、「0」照常 / config reads one at a time, 1 failing and 0 as usual;
// - e2e:read-fails：记号在时读配置、读版本列表都失败（面板无从知道那次写入怎样了） / while set, every config and version-list read fails
//   (the panel has no way to tell what became of the write);
// - e2e:config-only-fails：只有读配置失败，概览照常 / only config reads fail, the overview answers;
// - e2e:drop-write：下一次写配置没到面板就断线 / the next config write is cut off before reaching the panel;
// - e2e:lose-refusal：写入被拒时回应丢掉 / a refused write loses its answer;
// - e2e:silent-after-refusal：写入被拒以后 KixDNS 不答（读到的配置里没有在用的那份） / after a refused write KixDNS is silent (the config
//   read has none in use);
// - e2e:read-delay：读配置先等这么多毫秒 / config reads wait this many milliseconds first;
// - e2e:versions-next-fails：读配置失败以后，紧接着那次读版本列表也失败（不然核对会照 KixDNS 在跑的那一版下结论） / after a failed config
//   read the next version-list read fails too (or the check would settle from the version KixDNS runs);
// - e2e:overview-fails：记号在时读概览失败 / while set, overview reads fail
const readSequence = (page: Page) => page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
  if (route.request().url().includes('read-seq')) return route.continue()
  await route.fulfill({ contentType: 'application/javascript', body: `
    export * from '/src/api/client.ts?read-seq';
    import { apiRequest as original, ApiError, PANEL_UNREACHABLE_EVENT } from '/src/api/client.ts?read-seq';
    const cut = () => {
      localStorage.setItem('kixdns:demo-panel-down', 'true');
      window.dispatchEvent(new Event(PANEL_UNREACHABLE_EVENT));
      return new ApiError('连不上面板：网络断了，或者面板正在重启。稍后再试。', 0, 'network_unreachable');
    };
    export async function apiRequest(path, init) {
      const write = String(path) === '/api/v1/config' && init?.method === 'PUT';
      if (String(path) === '/api/v1/config' && !init?.method) {
        const delay = Number(localStorage.getItem('e2e:read-delay') ?? 0);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        const seq = localStorage.getItem('e2e:read-seq') ?? '';
        if (seq) {
          localStorage.setItem('e2e:read-seq', seq.slice(1));
          if (seq[0] === '1') { localStorage.setItem('e2e:versions-next-fails', 'true'); throw new ApiError('面板内部出错', 500, 'internal_error') }
        }
        if (localStorage.getItem('e2e:read-fails') === 'true' || localStorage.getItem('e2e:config-only-fails') === 'true') throw new ApiError('面板内部出错', 500, 'internal_error');
      }
      if (write && localStorage.getItem('e2e:drop-write') === 'true') { localStorage.removeItem('e2e:drop-write'); throw cut() }
      if (String(path) === '/api/v1/overview' && localStorage.getItem('e2e:overview-fails') === 'true') throw new ApiError('面板内部出错', 500, 'internal_error');
      if (String(path) === '/api/v1/config/versions' && (localStorage.getItem('e2e:read-fails') === 'true' || localStorage.getItem('e2e:versions-next-fails') === 'true')) { localStorage.removeItem('e2e:versions-next-fails'); throw new ApiError('面板内部出错', 500, 'internal_error') }
      let result;
      try { result = await original(path, init) } catch (error) {
        if (write && error?.code === 'reload_failed' && localStorage.getItem('e2e:silent-after-refusal') === 'true') { localStorage.removeItem('e2e:silent-after-refusal'); localStorage.setItem('e2e:kixdns-silent', 'true') }
        if (!write || error?.code !== 'reload_failed' || localStorage.getItem('e2e:lose-refusal') !== 'true') throw error;
        localStorage.removeItem('e2e:lose-refusal');
        throw cut();
      }
      if (String(path) === '/api/v1/config' && !init?.method && localStorage.getItem('e2e:kixdns-silent') === 'true') return { ...result, runtime: { ...result.runtime, active_sha256: null } };
      return result;
    }
  ` })
})

// 保存被拒、回应丢了，连上以后读配置依次失败、成功（核对）、失败（核对之后的整页重读）：页面照核对读到的说——不说「已经保存过了」，
// 「读取配置失败」留着，再改一处保存也不撞上自己那次写入
// A refused save lost its answer, and after the reconnect config reads fail, land (the check), then fail (the whole re-read after it):
// the page speaks from what the check read — no 已经保存过了, 读取配置失败 stays up, and saving another edit does not meet its own write
test('保存被拒、回应丢了，核对读到以后整页重读又失败：不说已经保存过了，再保存不撞上自己', async ({ page }) => {
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'fail-ok-fail.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-apply-failed', 'true'); localStorage.setItem('e2e:lose-refusal', 'true') })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。')
  await page.evaluate(() => localStorage.setItem('e2e:read-seq', '101'))
  await reconnect(page)
  // 核对隔 5 秒再试才读到 / The check reads only on its try 5 seconds later
  await expect.poll(() => page.evaluate(() => localStorage.getItem('e2e:read-seq')), { timeout: 12_000 }).toBe('')
  await expect(page.locator('.cfg__savebar', { hasText: '不知道存上没有' })).toHaveCount(0)
  await expect(page.locator('.cfg__notice')).toContainText('读取配置失败')
  await expect(page.locator('.cfg__savebar', { hasText: '已经保存过了' })).toHaveCount(0)
  // 页头照核对读到的说没有生效 / The header says it did not take, from what the check read
  await expect(page.locator('main .ui-ph')).toContainText('配置应用失败')
  await addRule(page, 'fail-ok-fail-2.example')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText(/版本 #\d+/, { timeout: 8000 })
  await expect(bar).not.toContainText('别处改过了')
})

// 保存没送到、核对读不到配置时按「重试」：这一按就是核对，核对出没存上就到此为止，不再问要不要放弃修改
// 重试 while the unsent save cannot be checked: the press is the check, and finding it not landed ends there without asking to drop the
// edits
test('保存没送到、核对读不到配置时按「重试」：说没有存上，不问要不要丢掉修改', async ({ page }) => {
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'unsent-retry.example')
  await page.evaluate(() => localStorage.setItem('e2e:drop-write', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。')
  await page.evaluate(() => localStorage.setItem('e2e:read-seq', '1'))
  await reconnect(page)
  const notice = page.locator('.cfg__notice')
  await expect(notice).toContainText('读不到配置：')
  await notice.getByRole('button', { name: '重试', exact: true }).click()
  await expect.poll(() => toastTexts(page), { timeout: 3000 }).toContain('刚才那次保存没有存上，可以再保存')
  await expect(page.getByText('放弃修改并重新读取')).toHaveCount(0)
  await expect(page.locator('[data-rule]', { hasText: 'unsent-retry.example' })).toBeVisible()
})

// 保存被拒、回应回来时人已离开、KixDNS 这时不答：后半句照读回来的状态说，和回应丢了那条路一样
// A refused save whose answer arrives with the user away and KixDNS silent by then: the second half follows the state read back, as on the
// lost-answer path
test('保存被拒、回应回来时人已离开、KixDNS 不答：说连上 KixDNS 以后可以回到配置页重试应用', async ({ page }) => {
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'refused-away-silent.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', 'true'); localStorage.setItem('kixdns:demo-apply-failed', 'true'); localStorage.setItem('e2e:silent-after-refusal', 'true') })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('写入并应用')
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await expect.poll(async () => (await toastTexts(page)).find((text) => text.includes('没有生效')), { timeout: 8000 }).toMatch(/^版本 #\d+ 保存了，没有生效。KixDNS 没有接受这份配置：upstream "fast" did not answer the health check。连上\u00a0KixDNS\u00a0后，可以回到配置页重试应用$/)
  await page.evaluate(() => { localStorage.removeItem('kixdns:demo-save-slow'); localStorage.removeItem('e2e:kixdns-silent') })
})

// 页头来的写入回应丢了、核对读不到配置：没有保存条，由提示条说不知道、原因跟着它；页头写未知、不给应用的按钮。读到以后说结果
// A write from the header lost its answer and the check cannot read the config: with no save bar the notice says it is unknown with the
// cause; the header reads unknown and offers no apply button. Once read, the result is told
test('现在应用的回应丢了、核对读不到配置：提示条说不知道版本 #N 应用了没有，页头不给现在应用', async ({ page }) => {
  await readSequence(page)
  const pending = await savePending(page, 'apply-lost-unreadable.example', '应用读不到')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-put-answer-lost', 'true'))
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await expect(page.locator('.conn__inner')).toBeVisible()
  await page.evaluate(() => localStorage.setItem('e2e:read-fails', 'true'))
  await reconnect(page)
  const notice = page.locator('.cfg__notice')
  await expect(notice).toContainText(`不知道版本 #${pending} 应用了没有。`)
  await expect(notice).toContainText('读不到配置：面板内部出错。读到后会自己核对')
  await expect(notice).not.toContainText('读取配置失败')
  await expect(page.locator('main .ui-ph')).toContainText('未知')
  await expect(page.getByRole('button', { name: '现在应用', exact: true })).toHaveCount(0)
  await page.evaluate(() => localStorage.removeItem('e2e:read-fails'))
  await expect.poll(() => toastTexts(page), { timeout: 12_000 }).toContain(`刚才那次应用：版本 #${pending} 已生效`)
  await expect(page.locator('.cfg__notice', { hasText: '不知道' })).toHaveCount(0)
})

// 校验并应用的回应丢了（其实写进去了）、核对读不到配置：页头不再给「校验并应用」，按不出第二次；读到以后不说没有应用、不说别处改过了
// 校验并应用 lost its answer (it landed) and the check cannot read the config: the header no longer offers 校验并应用, so no second press;
// once read, nothing says it did not apply or was changed elsewhere
test('校验并应用的回应丢了、核对读不到配置：页头不给校验并应用，读到以后说已生效、没有别处改过了', async ({ page }) => {
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('differs-lost')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?differs-lost';
      import { apiRequest as original, ApiError } from '/src/api/client.ts?differs-lost';
      export async function apiRequest(path, init) {
        if (/^\\/api\\/v1\\/config(?:\\/versions(?:\\/\\d+)?)?$/.test(String(path)) && !init?.method && localStorage.getItem('e2e:read-fails') === 'true') throw new ApiError('面板内部出错', 500, 'internal_error');
        const result = await original(path, init);
        if (String(path) === '/api/v1/config' && !init?.method && localStorage.getItem('e2e:written') !== 'true') return { ...result, runtime: { ...result.runtime, status: 'different' } };
        return result;
      }
    ` })
  })
  await page.goto('/config')
  const check = page.getByRole('button', { name: '校验并应用', exact: true }).locator('visible=true').first()
  await expect(check).toBeVisible({ timeout: 8000 })
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-put-answer-lost', 'true'); localStorage.setItem('e2e:written', 'true') })
  await check.click()
  await expect(page.locator('.conn__inner')).toBeVisible()
  await page.evaluate(() => localStorage.setItem('e2e:read-fails', 'true'))
  await reconnect(page)
  await expect(page.locator('.cfg__notice')).toContainText('不知道配置应用了没有。')
  await expect(page.getByRole('button', { name: '校验并应用', exact: true })).toHaveCount(0)
  await page.evaluate(() => localStorage.removeItem('e2e:read-fails'))
  await expect.poll(async () => (await toastTexts(page)).some((text) => /^刚才那次应用存成了版本 #\d+：已生效/.test(text)), { timeout: 12_000 }).toBe(true)
  await expect(page.locator('.cfg__notice', { hasText: /没有应用|别处改过了|不知道/ })).toHaveCount(0)
})

// 连上以后、核对回来之前：保存条说正在核对，不再说连不上面板 / Back in touch and before the check returns: the bar says 正在核对, no longer
// 连不上面板
test('保存的回应丢了，连上以后核对还在读：提示条说正在核对', async ({ page }) => {
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'lost-checking.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-put-answer-lost', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  // 连不上：「连不上面板」由横幅说，这里只说连上后会核对 / Unreachable: the banner says 连不上面板, this only says it is checked once back
  await expect(page.locator('.cfg__notice')).toContainText('连上后会自己核对')
  await page.evaluate(() => localStorage.setItem('e2e:read-delay', '2000'))
  await reconnect(page)
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。')
  await expect(page.locator('.cfg__notice')).toContainText('正在核对')
  await page.evaluate(() => localStorage.removeItem('e2e:read-delay'))
  await expect(bar).toContainText(/已经保存过了/, { timeout: 8000 })
})

// 等核对时按「重试」：核对在路上时按钮按住，按下去有动静 / 重试 during the wait: the button is held while the check runs, so the press shows
test('核对读不到配置时按「重试」：核对在路上时按钮按住', async ({ page }) => {
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'lost-retry-held.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-put-answer-lost', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。')
  await page.evaluate(() => localStorage.setItem('e2e:read-seq', '1'))
  await reconnect(page)
  const retry = page.locator('.cfg__notice').getByRole('button', { name: '重试', exact: true })
  await expect(retry).toBeEnabled()
  await page.evaluate(() => localStorage.setItem('e2e:read-delay', '1500'))
  await retry.click()
  await expect(retry).toBeDisabled()
  await expect(bar).toContainText(/已经保存过了/, { timeout: 6000 })
})

// 回应丢了的那次保存还没核对时离开配置页：不问「放弃未保存的修改」（它可能已经存上了），草稿留着，离开以后由提示说核对的结果
// Leaving the config page with the lost save unchecked: no 放弃未保存的修改 question (it may have landed); the draft is kept and a toast
// tells the check's result away
test('保存的回应丢了、核对读不到时离开配置页：不问放弃，提示说不知道，读到以后说已经存上了', async ({ page }) => {
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'lost-leave.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-put-answer-lost', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。')
  await page.evaluate(() => localStorage.setItem('e2e:read-fails', 'true'))
  await reconnect(page)
  await expect(page.locator('.cfg__notice')).toContainText('读到后会自己核对')
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContain('不知道配置存上没有：读不到配置。草稿留在配置页，读到后会自己核对')
  await page.evaluate(() => localStorage.removeItem('e2e:read-fails'))
  await expect.poll(async () => (await toastTexts(page)).some((text) => text.startsWith('刚才那次保存已经存上了')), { timeout: 12_000 }).toBe(true)
})

// 保存途中离开、回应丢了、还没核对时在别的页退出登录：确认框说不知道存上没有，不说「没保存成功」
// Signing out from another page while the save left during lost its answer and is unchecked: the confirm says whether it landed is
// unknown, not that it failed
test('离开时保存的回应丢了、还没核对时退出登录：确认框说不知道存上没有', async ({ page }) => {
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'lost-signout.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', 'true'); localStorage.setItem('kixdns:demo-put-answer-lost', 'true') })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('写入并应用')
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContain('不知道配置存上没有：连不上面板。草稿留在配置页，连上后会自己核对')
  await page.evaluate(() => localStorage.setItem('e2e:read-fails', 'true'))
  await reconnect(page)
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContain('不知道配置存上没有：读不到配置。草稿留在配置页，读到后会自己核对')
  await page.getByRole('button', { name: /^账户：/ }).click()
  await page.getByRole('dialog', { name: '账户', exact: true }).getByRole('button', { name: '退出登录', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('配置页刚才那次保存不知道存上没有。退出登录以后不再告诉你结果，没存上的修改也会丢掉。')
  await dialog.getByRole('button', { name: '先不退出', exact: true }).click()
  await page.evaluate(() => { localStorage.removeItem('kixdns:demo-save-slow'); localStorage.removeItem('e2e:read-fails') })
})

// 「重试应用」在页上丢了回应：连上以后由提示条说不知道（带原因），提示里那条收起，不说两遍
// 重试应用 lost its answer on the page: once back the notice says it is unknown (with the cause) and the toast goes, so it is not said twice
test('重试应用在页上丢了回应、核对读不到：提示条说不知道重试应用了没有，提示收起', async ({ page }) => {
  await readSequence(page)
  const pending = await failOnce(page, 'retry-lost-unreadable.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-apply-failed', 'true'); localStorage.setItem('e2e:lose-refusal', 'true') })
  await page.locator('.cfg__notice').getByRole('button', { name: '重试应用', exact: true }).click()
  // 在页上由提示条说，断线时也说（「连不上面板」由横幅说） / On the page the notice says it, during the outage too (the banner says 连不上面板)
  await expect(page.locator('.cfg__notice')).toContainText('不知道重试应用了没有。')
  await expect(page.locator('.cfg__notice')).toContainText('连上后会自己核对')
  await page.evaluate(() => localStorage.setItem('e2e:read-fails', 'true'))
  await reconnect(page)
  const notice = page.locator('.cfg__notice')
  await expect(notice).toContainText('不知道重试应用了没有。')
  await expect(notice).toContainText('读不到配置：面板内部出错。读到后会自己核对')
  expect((await toastTexts(page)).some((text) => text.startsWith('不知道重试应用了没有'))).toBe(false)
  await page.evaluate(() => localStorage.removeItem('e2e:read-fails'))
  await expect.poll(async () => (await toastTexts(page)).filter((text) => text === `重试也没有生效，存成了版本 #${pending + 1}`).length, { timeout: 12_000 }).toBe(1)
})

// 回应丢了的那次保存还没核对时会话过期：登录页说不知道存上没有，不说「没保存的修改没有留下来」
// The session expires while the lost save is unchecked: the login page says whether it landed is unknown, not just that unsaved edits were
// lost
test('保存的回应丢了、还没核对时会话过期：登录页说不知道那次保存存上没有', async ({ page }) => {
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'lost-expired.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-put-answer-lost', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。')
  await page.evaluate(() => localStorage.setItem('e2e:read-fails', 'true'))
  await reconnect(page)
  await expect(page.locator('.cfg__notice')).toContainText('读到后会自己核对')
  await page.evaluate(() => window.dispatchEvent(new Event('kixdns:session-expired')))
  await expect(page).toHaveURL(/\/login\?/)
  expect(new URL(page.url()).searchParams.get('expired')).toBe('unknown')
  await expect(page.locator('.auth-expired small')).toHaveText('刚才那次配置保存不知道存上没有，没存上的修改没有留下来。登录后回到刚才的页面。')
  // 和草稿丢了那种一样用黄底三角（不是灰底时钟） / The yellow triangle, as when a draft is lost (not the grey clock)
  await expect(page.locator('.auth-expired')).not.toHaveClass(/ui-notice--off/)
  await page.evaluate(() => localStorage.removeItem('e2e:read-fails'))
})

// 核对认出存上了、整页重读慢：锁住的页面、提示条的「不知道」和保存条的结果在同一帧换，不会一边还说不知道、一边已经出了保存条
// The check finds the save landed and the whole re-read is slow: the locked page, the notice's 「不知道」 and the save bar's result change in
// the same frame, never 不知道 still showing while the save bar is already out
test('保存的回应丢了、核对认出存上了、重读慢：提示条和保存条同一帧换', async ({ page }) => {
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'lost-slow-reread.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-put-answer-lost', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。')
  await expect(bar).toHaveCount(0)
  // 每一帧看一次（画出来的才算） / Checked every frame (only what is painted counts)
  await page.evaluate(() => {
    const w = window as unknown as { split: string[] }
    w.split = []
    const look = () => {
      const unknown = document.querySelector('.cfg__notice')?.textContent?.includes('不知道') ?? false
      const barText = document.querySelector('.cfg__savebar')?.textContent ?? ''
      const locked = document.querySelector('.cfg__panel')?.getAttribute('aria-busy') === 'true'
      if (unknown && barText) w.split.push(`不知道 + 保存条：${barText}`)
      if (!unknown && locked) w.split.push('不说不知道了，页面还锁着')
      if (!barText.includes('已经保存过了')) requestAnimationFrame(look)
    }
    requestAnimationFrame(look)
    localStorage.setItem('e2e:read-delay', '1000')
  })
  await reconnect(page)
  await expect(bar).toContainText(/已经保存过了/, { timeout: 10_000 })
  expect(await page.evaluate(() => (window as unknown as { split: string[] }).split)).toEqual([])
  await page.evaluate(() => localStorage.removeItem('e2e:read-delay'))
})

// 读不到配置、KixDNS 在跑的正是那次写入：照「存上了、已生效」说，和概览说的一样，不挂「不知道」
// The config cannot be read and KixDNS runs that very write: told as landed and in effect, as the overview says, with no 「不知道」 left up
test('现在应用的回应丢了、配置一直读不到、KixDNS 在跑的就是它：在概览上说已生效，不说不知道', async ({ page }) => {
  await readSequence(page)
  const pending = await savePending(page, 'apply-lost-running.example', '读不到却在跑')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-put-answer-lost', 'true'))
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await expect(page.locator('.conn__inner')).toBeVisible()
  await page.getByRole('link', { name: '概览', exact: true }).locator('visible=true').first().click()
  await page.evaluate(() => localStorage.setItem('e2e:config-only-fails', 'true'))
  await reconnect(page)
  await expect.poll(() => toastTexts(page), { timeout: 8000 }).toContain(`刚才那次应用：版本 #${pending} 已生效`)
  expect((await toastTexts(page)).some((text) => text.startsWith('不知道'))).toBe(false)
  await page.evaluate(() => localStorage.removeItem('e2e:config-only-fails'))
})

// 没有生效的那一版之后又改了保存、回应丢了：断线时、核对时提示条都不照断线前说「仍在用之前那份配置」
// After a version that did not take, an edit is saved and its answer lost: neither during the outage nor during the check does the notice
// repeat 仍在用之前那份配置 from before
test('没有生效以后改一处保存、回应丢了：提示条不再说仍在用之前那份配置', async ({ page }) => {
  await readSequence(page)
  await failOnce(page, 'failed-then-save-lost.example')
  await addRule(page, 'failed-then-save-lost-2.example', 'block')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-put-answer-lost', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。')
  await expect(page.locator('.cfg__notice', { hasText: '仍在用之前那份配置' })).toHaveCount(0)
  await page.evaluate(() => localStorage.setItem('e2e:read-delay', '1500'))
  await reconnect(page)
  await expect(page.locator('.cfg__notice')).toContainText('正在核对')
  await expect(page.locator('.cfg__notice', { hasText: '仍在用之前那份配置' })).toHaveCount(0)
  await page.evaluate(() => localStorage.removeItem('e2e:read-delay'))
  await expect(bar).toContainText(/已经保存过了/, { timeout: 8000 })
})

// 「重试应用」的回应丢了、还连不上：提示条不再说「仍在用之前那份配置」，不知道由提示说
// 重试应用 lost its answer and the panel is still unreachable: the notice no longer says 仍在用之前那份配置; the toast says it is unknown
test('重试应用的回应丢了、还连不上：提示条不再说仍在用之前那份配置', async ({ page }) => {
  await readSequence(page)
  await failOnce(page, 'retry-lost-down.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-apply-failed', 'true'); localStorage.setItem('e2e:lose-refusal', 'true') })
  await page.locator('.cfg__notice').getByRole('button', { name: '重试应用', exact: true }).click()
  // 在页上由提示条说，断线时也说（「连不上面板」由横幅说） / On the page the notice says it, during the outage too (the banner says 连不上面板)
  await expect(page.locator('.cfg__notice')).toContainText('不知道重试应用了没有。')
  await expect(page.locator('.cfg__notice')).toContainText('连上后会自己核对')
  await expect(page.locator('.cfg__notice', { hasText: '仍在用之前那份配置' })).toHaveCount(0)
})

// 从读不到配置到读到：「读取配置失败」和结果同一刻换，中间不空出一段（页面不先跳一下再出新的提示条）；每一帧看
// From unreadable to read: 读取配置失败 changes at the same moment as the result, with no gap between (the page does not jump before the new
// notice comes); checked every frame
test('保存被拒、回应丢了、读不到配置以后读到：提示条中间不空掉', async ({ page }) => {
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'refused-lost-nogap.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-apply-failed', 'true'); localStorage.setItem('e2e:lose-refusal', 'true') })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。')
  await page.evaluate(() => localStorage.setItem('e2e:read-seq', '1'))
  await reconnect(page)
  await expect(page.locator('.cfg__notice')).toContainText('读不到配置：')
  await page.evaluate(() => {
    const w = window as unknown as { gaps: number; done: boolean }
    w.gaps = 0
    w.done = false
    const look = () => {
      const text = document.querySelector('.cfg__notice')?.textContent ?? ''
      if (!text) w.gaps += 1
      if (text.includes('没有生效')) { w.done = true; return }
      requestAnimationFrame(look)
    }
    requestAnimationFrame(look)
    localStorage.setItem('e2e:read-delay', '800')
  })
  await expect.poll(() => page.evaluate(() => (window as unknown as { done: boolean }).done), { timeout: 12_000 }).toBe(true)
  expect(await page.evaluate(() => (window as unknown as { gaps: number }).gaps)).toBe(0)
  await page.evaluate(() => localStorage.removeItem('e2e:read-delay'))
})

// 读不到配置时，后台每 5 秒那次核对不按住提示条的「重试」：只有人按了才按住 / With the config unreadable, the background check every 5
// seconds does not hold the notice's 重试: only a press does
test('读不到配置时，后台的核对不让「重试」一灰一灰', async ({ page }) => {
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'retry-no-flicker.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-put-answer-lost', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。')
  await page.evaluate(() => localStorage.setItem('e2e:read-fails', 'true'))
  await reconnect(page)
  const retry = page.locator('.cfg__notice').getByRole('button', { name: '重试', exact: true })
  await expect(retry).toBeEnabled()
  await page.evaluate(() => {
    const w = window as unknown as { held: number }
    w.held = 0
    const end = performance.now() + 7000
    const look = () => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('.cfg__notice button')].find((b) => b.textContent?.trim() === '重试')
      if (button?.disabled) w.held += 1
      if (performance.now() < end) requestAnimationFrame(look)
    }
    requestAnimationFrame(look)
  })
  await page.waitForTimeout(7500)
  expect(await page.evaluate(() => (window as unknown as { held: number }).held)).toBe(0)
  await page.evaluate(() => localStorage.removeItem('e2e:read-fails'))
})

// 读不到配置、KixDNS 在跑的正是那次保存：在配置页上也照「已经保存过了」说，页头、历史跟着换成那一版
// The config cannot be read and KixDNS runs that very save: on the config page too it reads 已经保存过了, with the header and the history
// following that version
test('保存的回应丢了、配置读不到、KixDNS 在跑的就是它：在页上说已经保存过了，历史里有那一版', async ({ page }) => {
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'save-lost-running.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-put-answer-lost', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。')
  await page.evaluate(() => localStorage.setItem('e2e:config-only-fails', 'true'))
  await reconnect(page)
  await expect(bar).toContainText(/已经保存过了[\s·]+版本\s#\d+/, { timeout: 8000 })
  const saved = Number((await bar.textContent())!.match(/版本\s#(\d+)/)![1])
  await expect(page.locator('main .ui-ph')).toContainText(`#${saved}`)
  await expect(page.locator('main .ui-ph')).not.toContainText('未知')
  await page.getByRole('button', { name: '更多配置操作' }).click()
  await page.getByRole('menuitem', { name: '历史版本' }).click()
  await expect(page.locator('.hist__row', { hasText: `#${saved}` })).toBeVisible()
  await page.evaluate(() => localStorage.removeItem('e2e:config-only-fails'))
})

// 回应丢了、结果不知道：配置页锁住——内容点不了，「更多」里会改草稿、写入的几项停用，Ctrl+S 不保存、说一句为什么，撤销提示收起，页头写未知；
// 核对说完解开
// The answer was lost and the outcome is unknown: the config page locks — the content cannot be used, the 更多 items that change or write
// the draft are disabled, Ctrl+S saves nothing but says why, undo toasts go and the header reads unknown; once checked it unlocks
test('保存的回应丢了：配置页锁住，核对说完再解开', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '宽屏上看「更多」菜单和快速添加')
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'lock.example')
  await expect(page.locator('.toast', { hasText: '撤销' })).toHaveCount(1)
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-put-answer-lost', 'true'); localStorage.setItem('e2e:read-fails', 'true') })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  const notice = page.locator('.cfg__notice')
  await expect(notice).toContainText('刚才那次保存不知道存上没有。')
  await reconnect(page)
  await expect(notice).toContainText('读不到配置：面板内部出错。读到后会自己核对')
  // 锁住那一刻撤销提示就收起（不是等它八秒后自己消失） / Undo toasts go the moment it locks (not when they expire after eight seconds)
  await expect(page.locator('.toast', { hasText: '撤销' })).toHaveCount(0, { timeout: 1000 })
  await expect(page.locator('main .ui-ph')).toContainText('未知')
  await expect(page.locator('.cfg__panel')).toHaveAttribute('aria-busy', 'true')
  await expect(page.locator('.cfg__panel')).toHaveAttribute('inert', '')
  // 页头的页面操作（新建规则、测试域名）也一起锁住 / The page actions in the header (新建规则, 测试域名) are locked too
  await expect(page.locator('#cfg-actions')).toHaveAttribute('inert', '')
  await expect(bar).toHaveCount(0)
  await page.getByRole('button', { name: '更多配置操作' }).click()
  for (const name of ['历史版本', '查看 JSON', '导入 JSON', '重新读取配置']) await expect(page.getByRole('menuitem', { name })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: '下载 JSON' })).toBeEnabled()
  await page.keyboard.press('Escape')
  // Ctrl+S 不保存，说一句为什么；快捷键 n 不打开新建规则 / Ctrl+S saves nothing but says why; the n shortcut opens no new rule
  await page.keyboard.press('Control+s')
  await expect.poll(() => toastTexts(page)).toContain('没有保存：刚才那次保存不知道存上没有，核对完再试')
  await page.keyboard.press('n')
  await page.waitForTimeout(500)
  expect((await toastTexts(page)).some((text) => text.includes('没有要保存的修改'))).toBe(false)
  await expect(page.locator('.cfg__savebar')).toHaveCount(0)
  await expect(page.locator('.editor')).toHaveCount(0)
  expect(await page.evaluate(async () => (await import(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/config-v2/useConfigDocument.ts')).pop()!)).stage.value)).toBe('idle')
  await page.evaluate(() => localStorage.removeItem('e2e:read-fails'))
  await expect(bar).toContainText(/已经保存过了/, { timeout: 12_000 })
  await expect(page.locator('.cfg__panel')).not.toHaveAttribute('aria-busy', 'true')
  await expect(page.locator('main .ui-ph')).not.toContainText('未知')
})

// 保存还在路上时打开了上游组抽屉，随后回应丢了、页面锁住：抽屉照常改完，改的放进草稿；核对说完，保存条说已经保存过了、之后改的那一处还没保存
// The upstream group drawer opened while a save was under way, then the answer was lost and the page locked: the drawer is finished as
// usual and its edit goes into the draft; once checked the save bar says it was already saved, with the later edit still unsaved
test('保存途中开着上游组抽屉、回应丢了：抽屉照常改完，核对说完算一处修改', async ({ page }) => {
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'lock-drawer.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', '3000'); localStorage.setItem('kixdns:demo-put-answer-lost', 'true') })
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('写入并应用')
  await page.getByRole('link', { name: '上游组', exact: true }).locator('visible=true').first().click()
  await page.locator('.gcard__name').first().click()
  const drawer = page.locator('dialog[open]')
  await expect(drawer).toBeVisible()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。', { timeout: 8000 })
  // 一直连不上，直到测试自己重连：锁着的那几步不赶演示面板 5 秒后自己连上 / Kept unreachable until the test reconnects, so the locked steps
  // need not beat the demo panel reconnecting by itself after 5 seconds
  await page.evaluate(() => localStorage.setItem('kixdns:demo-panel-down', 'true'))
  await expect(page.locator('.cfg__panel')).toHaveAttribute('inert', '')
  await drawer.getByLabel('名称').fill('锁住时改的')
  await drawer.getByRole('button', { name: '完成', exact: true }).click()
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await expect(page.locator('.cfg__savebar')).toHaveCount(0)
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
  await reconnect(page)
  await expect(page.locator('.cfg__savebar')).toContainText(/已经保存过了[\s·]+版本\s#\d+[\s·]+之后改的 1 处还没保存/, { timeout: 12_000 })
  await expect(page.locator('.cfg__savebar')).toContainText(/已修改\s*1\s*处/, { timeout: 5000 })
  await expect(page.locator('.gcard__name', { hasText: '锁住时改的' })).toBeVisible()
})

// 页面锁着时，锁住以前开着的上游组抽屉里还有没放进草稿的修改：离开时只问那一样，说草稿留着
// With the page locked, the upstream group drawer opened before the lock holds an edit not yet in the draft: leaving asks about that one
// alone and says the draft stays
test('保存的回应丢了、抽屉里还有没放进草稿的修改时离开：只问那一样，说草稿留着', async ({ page }) => {
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'lock-leave.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', '3000'); localStorage.setItem('kixdns:demo-put-answer-lost', 'true') })
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('写入并应用')
  await page.getByRole('link', { name: '上游组', exact: true }).locator('visible=true').first().click()
  await page.locator('.gcard__name').first().click()
  const drawer = page.locator('dialog[open]')
  await expect(drawer).toBeVisible()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。', { timeout: 8000 })
  // 一直连不上，直到测试自己重连：锁着的那几步不赶演示面板 5 秒后自己连上 / Kept unreachable until the test reconnects, so the locked steps
  // need not beat the demo panel reconnecting by itself after 5 seconds
  await page.evaluate(() => localStorage.setItem('kixdns:demo-panel-down', 'true'))
  await drawer.getByLabel('名称').fill('没放进草稿')
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
  // 抽屉是模态的，点不到导航：直接点链接元素 / The drawer is modal and the nav cannot be clicked: the link element is clicked directly
  await page.evaluate(() => document.querySelector<HTMLAnchorElement>('.desktop-nav a[href="/logs"]')!.click())
  const ask = page.getByRole('alertdialog')
  await expect(ask).toContainText('放弃这个上游组的修改')
  await expect(ask).toContainText('刚才在这里改的内容还没放进草稿，离开就没了。草稿留着，核对完会说结果。')
  await ask.getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
})

// 锁着时在抽屉里改完、放进了草稿，人随后离开：核对出存上了，提示照保存条那样说之后改的那一处还留在配置页
// Edited in the drawer while locked, folded into the draft, then left: when the check finds the save landed, the toast says, as the
// save bar would, that the later edit is still on the config page
test('锁着时在抽屉里改完再离开，核对出存上了：提示说之后改的还留在配置页', async ({ page }) => {
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'lock-away.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', '3000'); localStorage.setItem('kixdns:demo-put-answer-lost', 'true') })
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('写入并应用')
  await page.getByRole('link', { name: '上游组', exact: true }).locator('visible=true').first().click()
  await page.locator('.gcard__name').first().click()
  const drawer = page.locator('dialog[open]')
  await expect(drawer).toBeVisible()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。', { timeout: 8000 })
  // 一直连不上，直到测试自己重连：锁着的那几步不赶演示面板 5 秒后自己连上 / Kept unreachable until the test reconnects, so the locked steps
  // need not beat the demo panel reconnecting by itself after 5 seconds
  await page.evaluate(() => localStorage.setItem('kixdns:demo-panel-down', 'true'))
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
  await drawer.getByLabel('名称').fill('锁住时改的')
  await drawer.getByRole('button', { name: '完成', exact: true }).click()
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await page.locator('.desktop-nav').getByRole('link', { name: '日志', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await reconnect(page)
  await expect.poll(async () => (await toastTexts(page)).some((text) => /^刚才那次保存已经存上了：版本 #\d+ 已生效；之后改的 1 处留在配置页，还没保存$/.test(text)), { timeout: 12_000 }).toBe(true)
})

// 保存写进去了、KixDNS 没接受，回应又丢了；锁着时在抽屉里改完：核对完保存条和回应回来时一样说「保存了，没有生效」，不在红色提示条下面打勾
// The save was written and KixDNS refused it, and the answer was lost; the drawer was finished while locked: once checked the bar says
// 保存了，没有生效 as when the answer arrives, with no tick under the red notice
test('保存被拒、回应丢了，锁着时在抽屉里改完：核对完保存条说保存了没有生效', async ({ page }) => {
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'lock-refused.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', '3000'); localStorage.setItem('kixdns:demo-apply-failed', 'true'); localStorage.setItem('e2e:lose-refusal', 'true') })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('写入并应用')
  await page.getByRole('link', { name: '上游组', exact: true }).locator('visible=true').first().click()
  await page.locator('.gcard__name').first().click()
  const drawer = page.locator('dialog[open]')
  await expect(drawer).toBeVisible()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。', { timeout: 8000 })
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
  await drawer.getByLabel('名称').fill('锁住时改的')
  await drawer.getByRole('button', { name: '完成', exact: true }).click()
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await reconnect(page)
  await expect(bar).toContainText('保存了，没有生效', { timeout: 12_000 })
  await expect(bar).toContainText('did not answer the health check')
  await expect(bar).not.toContainText('已经保存过了')
  await expect(page.locator('.cfg__notice')).toContainText('没有生效')
})

// 文件还在选的时候页面锁住了（选好时才轮到导入）：不导入，说一句为什么；草稿和锁都不动
// The page locked while the file was still being picked (the import only comes due once picked): nothing is imported and a line says
// why; the draft and the lock stay as they are
test('保存的回应丢了、页面锁着时才选好要导入的文件：不导入，说一句为什么', async ({ page }) => {
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'lock-import.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-put-answer-lost', 'true'))
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。')
  // 一直连不上，直到测试自己重连：锁着的那几步不赶演示面板 5 秒后自己连上 / Kept unreachable until the test reconnects, so the locked steps
  // need not beat the demo panel reconnecting by itself after 5 seconds
  await page.evaluate(() => localStorage.setItem('kixdns:demo-panel-down', 'true'))
  const config = { version: '1.0', settings: {}, pipeline_select: [{ pipeline: 'main', matchers: [] }], pipelines: [{ id: 'main', rules: [] }] }
  await page.locator('input[type="file"]').setInputFiles({ name: 'late.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(config)) })
  await expect.poll(() => toastTexts(page)).toContain('没有导入 late.json：刚才那次保存不知道存上没有，核对完再试')
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await expect(page.locator('[data-rule]', { hasText: 'lock-import.example' })).toHaveCount(1)
  await expect(page.locator('.cfg__panel')).toHaveAttribute('inert', '')
})

// 存上了的那一种：整页重读失败时，页头和保存条照核对读到的那一版说 / The landed kind: with the re-read failing, the header and the bar
// speak of the version the check read
test('保存的回应丢了，核对读到以后整页重读又失败：页头说的是存上的那一版', async ({ page }) => {
  await readSequence(page)
  await page.goto('/config')
  await addRule(page, 'fail-ok-fail-landed.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-put-answer-lost', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。')
  await page.evaluate(() => localStorage.setItem('e2e:read-seq', '101'))
  await reconnect(page)
  await expect(bar).toContainText(/已经保存过了[\s·]+版本\s#\d+/, { timeout: 12_000 })
  const saved = Number((await bar.textContent())!.match(/版本\s#(\d+)/)![1])
  await expect(page.locator('.cfg__notice')).toContainText('读取配置失败')
  await expect(page.locator('main .ui-ph')).toContainText(`#${saved}`)
})

// 回应丢了的那次还没核对时按「读取配置失败」上的「重试」：只再核对一次，不问要不要丢掉修改（那份修改可能已经存上了）
// 重试 on 读取配置失败 while the lost save is unchecked: it only checks again, without asking to drop the edits (they may have landed)
test('保存的回应丢了、核对读不到配置时按「重试」：再核对一次，不问要不要丢掉修改', async ({ page }) => {
  await readFailsOnce(page)
  await page.goto('/config')
  await addRule(page, 'read-fails-retry.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-put-answer-lost', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__notice')).toContainText('刚才那次保存不知道存上没有。')
  await page.evaluate(() => localStorage.setItem('e2e:read-fails-once', 'true'))
  await reconnect(page)
  const notice = page.locator('.cfg__notice')
  await expect(notice).toContainText('读不到配置：')
  await notice.getByRole('button', { name: '重试', exact: true }).click()
  // 比 5 秒后自己再试早：是这一按核对出来的 / Sooner than the try 5 seconds later: this press did the check
  await expect(bar).toContainText(/已经保存过了/, { timeout: 3000 })
  await expect(page.getByText('放弃修改并重新读取')).toHaveCount(0)
  await expect(page.getByText('读取配置失败')).toHaveCount(0)
})

// 离开时保存的回应丢了，连上以后核对读不到配置：离开时那条改说读不到配置；这时回到配置页，保存条不先说「别处改过了」（读回来的是自己那次写入）
// A save left during lost its answer and the check after the reconnect cannot read the config: the toast from leaving now says the config
// cannot be read; back on the config page at once, the save bar never calls one's own write 别处改过了
test('离开时保存的回应丢了、核对读不到配置：提示说读不到配置，马上回配置页也不说别处改过了', async ({ page }) => {
  await readFailsOnce(page)
  await page.goto('/config')
  await addRule(page, 'read-fails-away.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', 'true'); localStorage.setItem('kixdns:demo-put-answer-lost', 'true') })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('写入并应用')
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContain('不知道配置存上没有：连不上面板。草稿留在配置页，连上后会自己核对')
  await page.evaluate(() => localStorage.setItem('e2e:read-fails-once', 'true'))
  await reconnect(page)
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContain('不知道配置存上没有：读不到配置。草稿留在配置页，读到后会自己核对')
  expect((await toastTexts(page)).some((text) => text.includes('连不上面板'))).toBe(false)
  // 记下保存条有没有说过「别处改过了」 / Record whether the save bar ever says 别处改过了
  await page.evaluate(() => {
    const w = window as unknown as { sawConflict: boolean }
    w.sawConflict = false
    new MutationObserver(() => { if (document.querySelector('.cfg__savebar')?.textContent?.includes('别处改过了')) w.sawConflict = true }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  await page.getByRole('link', { name: '规则', exact: true }).click()
  await expect(bar).toContainText(/已经保存过了/, { timeout: 12_000 })
  expect(await page.evaluate(() => (window as unknown as { sawConflict: boolean }).sawConflict)).toBe(false)
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

// 被拒、回应丢了、人已离开，连上时 KixDNS 不答：不指配置页上没有的「重试应用」 / Refused, answer lost, user away, and KixDNS silent on
// reconnect: no pointing at a 重试应用 the config page does not offer
test('现在应用被拒、回应丢了、人已离开，连上时 KixDNS 不答：只说没有生效、连上 KixDNS 以后再试', async ({ page }) => {
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('lose-silent')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?lose-silent';
      import { apiRequest as original, ApiError, PANEL_UNREACHABLE_EVENT } from '/src/api/client.ts?lose-silent';
      export async function apiRequest(path, init) {
        let result;
        try { result = await original(path, init) } catch (error) {
          if (!/\\/apply$/.test(String(path)) || error?.code !== 'reload_failed' || localStorage.getItem('e2e:lose-refusal') !== 'true') throw error;
          localStorage.removeItem('e2e:lose-refusal');
          localStorage.setItem('kixdns:demo-panel-down', 'true');
          window.dispatchEvent(new Event(PANEL_UNREACHABLE_EVENT));
          throw new ApiError('连不上面板：网络断了，或者面板正在重启。稍后再试。', 0, 'network_unreachable');
        }
        // KixDNS 不答：读到的配置里没有在用的那份 / KixDNS silent: the config read has none in use
        if (String(path) === '/api/v1/config' && !init?.method && localStorage.getItem('e2e:kixdns-silent') === 'true') return { ...result, runtime: { ...result.runtime, active_sha256: null } };
        return result;
      }
    ` })
  })
  const pending = await savePending(page, 'in-place-refused-silent.example', '被拒又不答')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-apply-failed', 'true'); localStorage.setItem('e2e:lose-refusal', 'true') })
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await expect(page.locator('.conn__inner')).toBeVisible()
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await page.evaluate(() => localStorage.setItem('e2e:kixdns-silent', 'true'))
  await reconnect(page)
  // KixDNS 不答（不是停着、也不是起不来）：说连上它以后 / KixDNS silent (neither stopped nor failing to come up): once it is reached
  await expect.poll(() => toastTexts(page), { timeout: 8000 }).toContain(`版本 #${pending} 没有生效。KixDNS 没有接受这份配置：upstream "fast" did not answer the health check。连上\u00a0KixDNS\u00a0后，可以回到配置页重试应用`)
  await page.evaluate(() => localStorage.removeItem('e2e:kixdns-silent'))
})

// 原因是 KixDNS 在确认前停了、回应丢了、人已离开，连上时 KixDNS 又在跑：后半句按读回来的状态说，不叫人等一次已经有过的启动
// The cause is KixDNS stopping before it confirmed, the answer was lost with the user away, and KixDNS runs again on the reconnect: the
// second half follows the state read back, without telling the user to wait for a start that already happened
test('现在应用因为 KixDNS 停了没有生效、回应丢了，连上时 KixDNS 在：说回到配置页可以重试应用', async ({ page }) => {
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('lose-stopped')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?lose-stopped';
      import { apiRequest as original, ApiError, PANEL_UNREACHABLE_EVENT } from '/src/api/client.ts?lose-stopped';
      const STOPPED = 'KixDNS 已停止，仍在用之前的配置';
      export async function apiRequest(path, init) {
        let result;
        try { result = await original(path, init) } catch (error) {
          if (!/\\/apply$/.test(String(path)) || error?.code !== 'reload_failed' || localStorage.getItem('e2e:lose-refusal') !== 'true') throw error;
          localStorage.removeItem('e2e:lose-refusal');
          localStorage.setItem('e2e:stopped-cause', 'true');
          localStorage.setItem('kixdns:demo-panel-down', 'true');
          window.dispatchEvent(new Event(PANEL_UNREACHABLE_EVENT));
          throw new ApiError('连不上面板：网络断了，或者面板正在重启。稍后再试。', 0, 'network_unreachable');
        }
        // 服务端记下的原因是停了（KixDNS 随后又被拉起来） / The cause the server stored is the stop (KixDNS was brought back up afterwards)
        if (String(path) === '/api/v1/config' && !init?.method && localStorage.getItem('e2e:stopped-cause') === 'true' && result.pending?.error) return { ...result, pending: { ...result.pending, error: STOPPED }, runtime: { ...result.runtime, pending_error: STOPPED } };
        return result;
      }
    ` })
  })
  const pending = await savePending(page, 'in-place-stopped-back.example', '停了又起来')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-apply-failed', 'true'); localStorage.setItem('e2e:lose-refusal', 'true') })
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await expect(page.locator('.conn__inner')).toBeVisible()
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await reconnect(page)
  await expect.poll(() => toastTexts(page), { timeout: 8000 }).toContain(`版本 #${pending} 没有生效。KixDNS 在确认新配置前停了。回到配置页可以重试应用`)
  await page.evaluate(() => localStorage.removeItem('e2e:stopped-cause'))
})

// 「校验并应用」（手改过的文件）被 KixDNS 的校验拒绝、人已离开：开头说配置存成了哪一版，那一版是这一按才存出来的
// 校验并应用 (a hand-edited file) refused by KixDNS's validation with the user away: the opening says which version the config was stored
// as, since that version only came about with this press
test('校验并应用被拒、人已离开：说配置存成了版本 #N，没有生效', async ({ page }) => {
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('file-differs-away')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?file-differs-away';
      import { apiRequest as original } from '/src/api/client.ts?file-differs-away';
      export async function apiRequest(path, init) {
        const result = await original(path, init);
        if (String(path) === '/api/v1/config' && !init?.method && !result.pending) return { ...result, runtime: { ...result.runtime, status: 'different' } };
        return result;
      }
    ` })
  })
  await page.goto('/config')
  const check = page.getByRole('button', { name: '校验并应用', exact: true }).locator('visible=true').first()
  await expect(check).toBeVisible({ timeout: 8000 })
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', 'true'); localStorage.setItem('kixdns:demo-apply-invalid', 'true') })
  await check.click()
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await expect(page).toHaveURL(/\/logs/)
  await expect.poll(async () => (await toastTexts(page)).find((text) => text.includes('没有生效')), { timeout: 8000 }).toMatch(/^配置存成了版本 #\d+，没有生效。没有通过 KixDNS 的校验。回到配置页可以重试应用$/)
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

// 有待应用的版本时离开再回到配置页：页面照常出来（以前每 5 秒看一眼的那段在声明前读了连接状态，整页空白）
// Leaving and returning to the config page with a version pending: the page renders (the 5-second watcher used to read the connection state before its
// declaration, leaving a blank page)
test('有待应用的版本时回到配置页：页面照常出来', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await savePending(page, 'return-pending.example', '回来看看')
  await page.getByRole('link', { name: '日志', exact: true }).first().click()
  await page.getByRole('link', { name: '规则', exact: true }).first().click()
  await expect(page.locator('[data-rule]', { hasText: 'return-pending.example' })).toBeVisible()
  await expect(page.locator('main .ui-ph')).toContainText('待应用')
  expect(errors).toEqual([])
})

// 等着待应用的版本时别处换了文件：页面整份跟着换（以前只把新运行状态贴到旧文件上，页头说「运行中」，列表还是旧的）
// The file changes elsewhere while a version is pending: the page follows the whole file (it used to pin the new runtime onto the old file, so the header
// said 运行中 over the old list)
test('等着待应用的版本时别处换了文件：页面整份跟着换', async ({ page }) => {
  await savePending(page, 'replaced-elsewhere.example', '等着生效')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-changed-elsewhere', 'true'))
  await expect(page.locator('[data-rule]', { hasText: 'replaced-elsewhere.example' })).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('main .ui-ph')).not.toContainText('待应用')
  // 读入了别处的版本：说一句，不让待应用的那条规则悄悄消失 / Another writer's version was read in: said so, so the pending rule does not vanish without a word
  await expect.poll(() => toastTexts(page)).toContainEqual(expect.stringMatching(/^这份配置在别处改过了，已读入版本\u00a0#\d+$/))
})

// 等着待应用的版本时，后台那一遍让它生效了：页面开着就说一句（说过「就绪后自动应用」，用户等的就是这个）
// The background pass puts the pending version into effect while the page is open: it is said (the user was told 就绪后自动应用 and waits for exactly this)
test('等着待应用的版本时后台让它生效了：说一句已生效', async ({ page }) => {
  const pending = await savePending(page, 'background-applies.example', '等后台')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-background-applies', 'true'))
  await expect.poll(() => toastTexts(page), { timeout: 10_000 }).toContain(`版本 #${pending} 已生效`)
  await expect(page.locator('main .ui-ph')).not.toContainText('待应用')
})

// 「现在应用」途中又改了一处、然后离开：问的是整份草稿（应用没有「正在保存的那份」可以留下）
// An edit during 现在应用, then leaving: the question is about the whole draft (an apply has no 「the one being saved」 to keep)
test('现在应用途中改了再离开：问放弃未保存的修改', async ({ page }) => {
  await savePending(page, 'leave-during-apply.example', '途中改')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-slow', 'true'))
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await addRule(page, 'edit-during-apply.example')
  await page.getByRole('link', { name: '日志', exact: true }).first().click()
  const ask = page.getByRole('alertdialog')
  await expect(ask).toBeVisible()
  await expect(ask).toContainText('放弃未保存的修改')
  await ask.getByRole('button', { name: '继续编辑' }).click()
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

// 上游组抽屉开着、没改什么时，每 5 秒那次看读进了别处的版本：抽屉换成读进来的组，按「完成」不把打开时的副本写回去（以前悄悄撤掉了别处加的地址）
// An upstream-group drawer is open and unedited when the 5-second look reads another writer's version in: the drawer takes the group just read, and 完成
// does not write back the copy taken at opening (it used to silently undo the address added elsewhere)
test('上游组抽屉开着时读进了别处的版本：抽屉跟着换，完成不撤掉别处加的地址', async ({ page }) => {
  await savePending(page, 'drawer-read-in.example', '等着生效')
  await page.getByRole('link', { name: '上游组', exact: true }).first().click()
  await page.locator('.gcard').first().getByRole('button', { name: '编辑' }).click()
  const drawer = page.locator('dialog.pdrawer[open]')
  await expect(drawer).toBeVisible()
  await page.evaluate(() => localStorage.setItem('kixdns:demo-elsewhere-pending', 'true'))
  const values = () => drawer.locator('input').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))
  await expect.poll(values, { timeout: 10_000 }).toContain('203.0.113.53')
  // 读入的提示放在抽屉里，看得见，也不盖住底下的「取消」「完成」 / The read-in toast sits inside the drawer, in sight, and clear of 取消 / 完成 below
  await expect(drawer.locator('.toast')).toContainText('这份配置在别处改')
  const toastBox = (await drawer.locator('.toast').boundingBox())!
  const footBox = (await drawer.locator('.pdrawer__foot').boundingBox())!
  expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(footBox.y)
  await drawer.getByLabel('名称', { exact: true }).fill('改过名的组')
  await drawer.getByRole('button', { name: '完成', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  const card = page.locator('.gcard', { hasText: '改过名的组' })
  await expect(card).toContainText('203.0.113.53')
})

// 「现在应用」没成功挂着「版本 #N 没有应用」时，别处又存了一个待应用的版本、读了进来：那条说旧版本的提示收起
// 现在应用 failed and 「版本 #N 没有应用」 shows when another writer's pending version is read in: the notice about the old version goes
test('现在应用没成功后读进了别处的待应用版本：旧版本的提示收起', async ({ page }) => {
  const pending = await savePending(page, 'stale-notice.example', '应用出错')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-apply-error', 'true'))
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await expect(page.locator('.cfg__notice')).toContainText(`版本 #${pending} 没有应用`)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-elsewhere-pending', 'true'))
  await expect.poll(() => toastTexts(page), { timeout: 10_000 }).toContainEqual(expect.stringMatching(/^这份配置在别处改过了，已读入版本\u00a0#\d+$/))
  await expect(page.locator('main .ui-ph')).toContainText(`版本 #${pending + 1} 待应用`)
  await expect(page.locator('.cfg__notice')).toHaveCount(0)
})

// 每 5 秒那次看的读还在路上时离开了配置页：读回来不在别的页上说「已生效」（页头回来时会说）
// The 5-second look's read is still out when the config page is left: when it lands nothing says 已生效 on the other page (the header says it on return)
test('看的那次读还在路上时离开配置页：别的页上不说已生效', async ({ page }) => {
  const pending = await savePending(page, 'leave-mid-check.example', '离开时')
  await page.evaluate(async () => {
    localStorage.setItem('kixdns:demo-read-slow', 'true')
    localStorage.setItem('kixdns:demo-background-applies', 'true')
    const url = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/config-v2/useConfigDocument.ts')).pop()!
    const doc = await import(url)
    void doc.checkPending()
  })
  await page.getByRole('link', { name: '日志', exact: true }).first().click()
  await expect(page).toHaveURL(/\/logs/)
  await page.waitForTimeout(2500)
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-read-slow'))
  expect(await toastTexts(page)).not.toContain(`版本 #${pending} 已生效`)
})

// 离开配置页后「现在应用」没有生效，提示挂在别的页上；退出登录时它一起收起，不留在登录页
// 现在应用 fails after the config page was left and its toast hangs on another page; signing out takes it away, so it does not stay on the login page
test('离开后现在应用没有生效的提示：退出登录时收起', async ({ page }) => {
  const pending = await savePending(page, 'signout-away-toast.example', '退出前')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', 'true'); localStorage.setItem('kixdns:demo-apply-failed', 'true') })
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await page.getByRole('link', { name: '日志', exact: true }).first().click()
  await expect.poll(() => toastTexts(page), { timeout: 8000 }).toContainEqual(expect.stringContaining(`版本 #${pending} 没有生效`))
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
  await page.getByRole('button', { name: /^账户：/ }).click()
  await page.getByRole('dialog', { name: '账户', exact: true }).getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.locator('.toast')).toHaveCount(0)
})

// 「现在应用」途中改了一处，离开时同意放弃，又在应用做完之前回来：说好丢掉的那处不在草稿里（以前回来时还在，应用做完后也还在）
// An edit during 现在应用, agreed to drop on leaving, then a return before the apply ends: the dropped edit is not in the draft (it used to be back, and stayed after the apply)
test('现在应用途中同意放弃修改又马上回来：丢掉的修改不再出现', async ({ page }) => {
  const pending = await savePending(page, 'drop-during-apply.example', '途中丢')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-slow', '4000'))
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await addRule(page, 'dropped-edit.example')
  await page.getByRole('link', { name: '日志', exact: true }).first().click()
  await acceptConfirm(page)
  await expect(page).toHaveURL(/\/logs/)
  await page.goBack()
  // 回来时应用还没做完 / Back before the apply is done
  await expect(page.locator('.cfg__spin').first()).toBeVisible()
  await expect(page.locator('[data-rule]', { hasText: 'dropped-edit.example' })).toHaveCount(0)
  await expect.poll(() => toastTexts(page), { timeout: 8000 }).toContain(`版本 #${pending} 已生效`)
  await expect(page.locator('[data-rule]', { hasText: 'dropped-edit.example' })).toHaveCount(0)
  await expect(page.getByText(/已修改 \d+ 处/)).toHaveCount(0)
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

// 断线期间后台让待应用的版本生效了：连上后说一句（以前只有「已重新连上面板」，页头悄悄变成运行中）
// The background put the pending version into effect during an outage: said after reconnecting (only 已重新连上面板 used to show while the header quietly turned to 运行中)
test('断线期间待应用的版本生效了：连上后说已生效', async ({ page }) => {
  const pending = await savePending(page, 'applied-while-down.example', '断线时')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-panel-down', 'true'); window.dispatchEvent(new Event('kixdns:panel-unreachable')) })
  await expect(page.locator('.conn__inner')).toBeVisible()
  await page.evaluate(() => localStorage.setItem('kixdns:demo-background-applies', 'true'))
  await reconnect(page)
  await expect.poll(() => toastTexts(page), { timeout: 8000 }).toContain(`版本 #${pending} 已生效`)
  await expect(page.locator('main .ui-ph')).not.toContainText('待应用')
})

// 删除待应用的版本时恰好赶上每 5 秒那次看：那次看跳过，不把这一页自己删掉的说成「别处改过了」
// The 5-second look falls inside the delete of the pending version: that look is skipped, and this page's own delete is not called 别处改过了
test('删除待应用的版本时赶上每 5 秒那次看：不说别处改过了', async ({ page }) => {
  const pending = await savePending(page, 'delete-mid-check.example', '要删掉')
  await page.getByRole('button', { name: '更多配置操作' }).click()
  await page.getByRole('menuitem', { name: '历史版本' }).click()
  await page.getByRole('button', { name: `版本 #${pending} 的操作` }).click()
  await page.getByRole('menuitem', { name: '删除这个版本' }).click()
  await page.evaluate(() => localStorage.setItem('kixdns:demo-read-slow', 'true'))
  await acceptConfirm(page)
  // 删除后的重读还在路上，这时那次看来了 / The delete's re-read is still out when the look comes
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/config-v2/useConfigDocument.ts')).pop()!
    const doc = await import(url)
    await new Promise((resolve) => setTimeout(resolve, 300))
    await doc.checkPending()
  })
  await expect.poll(() => toastTexts(page), { timeout: 8000 }).toContainEqual(expect.stringContaining(`#${pending} 已删除`))
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-read-slow'))
  expect((await toastTexts(page)).filter((text) => text.includes('别处改过了'))).toEqual([])
})

// 按「现在应用」时待应用的已经被别处换掉：没什么要保存的，直接读入新的并说一句，不留一条没有按钮、读完也不走的红色提示
// 现在应用 meets a pending version replaced elsewhere: nothing needs saving, so the new one is read in and said, with no red notice that has no button and
// outlives the re-read
test('现在应用撞上别处的版本：读入并说一句，不留过时的提示', async ({ page }) => {
  const pending = await savePending(page, 'in-place-overtaken.example', '被别处换掉')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-apply-overtaken', 'true'))
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContainEqual(expect.stringMatching(new RegExp(`^版本 #${pending} 没有应用：这份配置在别处改过了，已读入版本\u00a0#\\d+$`)))
  await expect(page.locator('main .ui-ph')).not.toContainText('待应用')
  await expect(page.locator('.cfg__notice')).toHaveCount(0)
})

// 「现在应用」途中退出登录：应用没有草稿可丢，不问；退出以后也不报它的结果
// Signing out during 现在应用: an apply has no draft to lose, so nothing is asked, and its outcome is not reported afterwards
test('现在应用途中退出登录：不问草稿，登录页上不报结果', async ({ page }) => {
  const pending = await savePending(page, 'in-place-signout.example', '途中退出')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-slow', 'true'))
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await page.locator('.account-button').click()
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await page.waitForTimeout(2500)
  expect(await toastTexts(page)).not.toContain(`版本 #${pending} 已生效`)
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

// 校验途中又改了草稿：结论说的是改之前的那份，不挂到现在的草稿上（以前会把没校验过的说成「校验通过」）
// The draft edited while 校验 runs: the verdict is about the draft before the edit and is not hung on the current one (it used to call an unchecked edit 校验通过)
test('校验途中改了草稿：校验的结论不挂到改过的草稿上', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'checked-before.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-validate-slow', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '校验', exact: true }).click()
  await addRule(page, 'added-during-check.example')
  await page.waitForTimeout(2500)
  await expect(bar).not.toContainText('校验通过')
  await expect(bar).toContainText('已修改')
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-validate-slow'))
})

// JSON 视图里校验以后又改了：「校验通过」说的不是现在这份，不再挂着
// JSON edited after 校验 in the JSON view: 校验通过 is no longer about what is there and does not stay
test('JSON 视图校验以后又改了：不再挂着校验通过', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'json-check.example')
  await page.getByRole('button', { name: '更多配置操作' }).click()
  await page.getByRole('menuitem', { name: '查看 JSON' }).click()
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '校验', exact: true }).click()
  await expect(bar).toContainText('校验通过')
  await page.locator('.json-editor .cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' ')
  await expect(bar).not.toContainText('校验通过')
})

// 历史版本里没生效的原因和页面上的提示同一个说法：不带「仍在用之前的配置」（KixDNS 停着时那句不对）
// The history row gives the same cause as the notice: without 仍在用之前的配置 (untrue while KixDNS is stopped)
test('历史里没生效的原因和提示同一个说法', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'history-cause.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-apply-failed', 'true'))
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('main')).toContainText('没有生效，仍在用之前那份配置')
  await page.getByRole('button', { name: '更多配置操作' }).click()
  await page.getByRole('menuitem', { name: '历史版本' }).click()
  const err = page.locator('.hist__err').first()
  await expect(err).toContainText('KixDNS 没有接受这份配置')
  await expect(err).not.toContainText('仍在用之前的配置')
})

// 单独「校验」还没回来时按的保存，从按下起就是一次保存：按钮写「保存中」，重新读取停用；校验没过就停在那句结论上，不接着存
// Save pressed while a lone 校验 is out is a save from the press: the button reads 保存中 and 重新读取 is disabled; a failed check stops there instead of saving
test('校验途中按的保存：算作保存，校验没过就不存', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'queued.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-validate-slow', 'true'); localStorage.setItem('kixdns:demo-validate-reject', 'true') })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '校验', exact: true }).click()
  await bar.locator('.savebar__save').click()
  await expect(bar.locator('.savebar__save')).toHaveText('保存中')
  await page.getByRole('button', { name: '更多配置操作' }).click()
  await expect(page.locator('[role=menuitem]', { hasText: '重新读取配置' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(bar).toContainText('没有通过校验', { timeout: 5000 })
  // 没有接着存：保存条停在校验的结论上，按钮回到「保存并应用」 / Nothing followed: the bar stays at the check's verdict and the button is back to 保存并应用
  await page.waitForTimeout(1500)
  await expect(bar).toContainText('没有通过校验')
  await expect(bar.locator('.savebar__save')).toHaveText('保存并应用')
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-validate-slow'))
})

// 键盘按「校验」：焦点不落到「保存并应用」上，再按一下 Enter 也不会保存 / 校验 by keyboard: focus does not land on 保存并应用, so another Enter does not save
test('键盘按校验以后，焦点不在保存按钮上', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'enter.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-validate-slow', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '校验', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(bar).toContainText('校验中')
  await expect(bar.locator('.savebar__save')).not.toBeFocused()
  await page.keyboard.press('Enter')
  await expect(bar).toContainText('校验通过', { timeout: 5000 })
  await expect(page.locator('[data-rule]', { hasText: 'enter.example' })).toBeVisible()
  await expect(bar.locator('.savebar__save')).toHaveText('保存并应用')
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-validate-slow'))
})

// 保存途中历史版本里停用的操作照样看得见（灰着），不是几行空白；「删除 N 个版本」也停用
// During a save the history's disabled actions stay visible (greyed), not blank rows; 删除 N 个版本 is disabled too
test('保存途中，历史版本里停用的操作灰着显示', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'hist-menu.example')
  // 校验和写入各 1.5 秒：打开历史和菜单时保存一定还在跑 / Validation and the write take 1.5 s each, so the save is surely still running while the history and its menu open
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', 'true'); localStorage.setItem('kixdns:demo-validate-slow', 'true') })
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  await page.getByRole('button', { name: '更多配置操作' }).click()
  await page.getByRole('menuitem', { name: '历史版本' }).click()
  await page.locator('.hist__menu button[aria-haspopup]').first().click()
  const restore = page.locator('[role=menuitem]', { hasText: '恢复为这个版本' })
  // 不等保存做完：菜单一打开就得看得见、灰着 / Without waiting for the save to end: as soon as the menu opens it must be visible and greyed
  await expect(restore).toHaveCSS('visibility', 'visible', { timeout: 500 })
  await expect(restore).toBeDisabled({ timeout: 500 })
  await page.evaluate(() => { localStorage.removeItem('kixdns:demo-save-slow'); localStorage.removeItem('kixdns:demo-validate-slow') })
})

// 配置页上保存还在路上时退出登录：和在别处一样问，同意以后登录页干净 / Signing out on the config page with a save on its way: asked as anywhere else, and the login page is clean after agreeing
test('配置页上保存途中退出登录：先问，同意后不留草稿', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '账户菜单在宽屏的顶栏')
  await page.goto('/config')
  await addRule(page, 'onpage-signout.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', 'true'); localStorage.setItem('kixdns:demo-save-conflict', 'true') })
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  await page.getByRole('button', { name: /^账户：/ }).click()
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.locator('dialog.confirm[open]')).toContainText('配置页的保存还没做完')
  await page.locator('dialog.confirm[open]').getByRole('button', { name: '放弃并退出' }).click()
  await expect(page).toHaveURL(/\/login/)
  await page.waitForTimeout(2500)
  expect(await toastTexts(page)).toEqual([])
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

// 重新读取还在读时，列表不能改：读回来的会整份换掉草稿 / While 重新读取 reads, the list takes no edits: what comes back replaces the draft
test('重新读取途中，页面不能改', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'reread.example')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-read-slow', 'true'))
  await page.getByRole('button', { name: '更多配置操作' }).click()
  await page.getByRole('menuitem', { name: '重新读取配置' }).click()
  await page.locator('dialog.confirm[open]').getByRole('button', { name: '放弃修改并重新读取' }).click()
  await expect(page.locator('.cfg__panel')).toHaveAttribute('inert', '')
  await expect(page.locator('.cfg__panel')).not.toHaveAttribute('inert', '', { timeout: 10_000 })
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-read-slow'))
})

// 校验途中按的保存、按完就离开，校验没过：和直接保存失败一样，草稿留着、提示说为什么，回来还在
// A save pressed during 校验, the page left right after, and the check fails: as with a direct save that fails, the draft is kept, a toast says why, and it is there on return
test('排着的保存离开后校验没过：草稿留着并说明', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'queued-left.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-validate-slow', 'true'); localStorage.setItem('kixdns:demo-validate-reject', 'true') })
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '校验', exact: true }).click()
  await bar.locator('.savebar__save').click()
  await page.getByRole('link', { name: '日志', exact: true }).first().click()
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContainEqual(expect.stringContaining('配置没有保存：没有通过校验。草稿留在配置页'))
  await page.getByRole('link', { name: '规则', exact: true }).first().click()
  await expect(page.locator('[data-rule]', { hasText: 'queued-left.example' })).toBeVisible()
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-validate-slow'))
})

// 离开后没保存成功的草稿留着；离开期间别处存了新版本：回来时马上说「别处改过了」，不悄悄换到新文件上
// （以前悄悄换了底子，下一次保存就把别处的改动当成自己的删掉了）
// A draft whose save failed after leaving is held; another writer saves meanwhile: on return the page says 别处改过了 at once instead of silently moving onto
// the new file (it used to rebase, and the next save then removed the other writer's change as if it were one's own)
test('留着的草稿回来时文件在别处改过了：马上进冲突，不悄悄换底子', async ({ page }) => {
  await page.goto('/config')
  await addRule(page, 'held-return.example')
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-validate-slow', 'true'); localStorage.setItem('kixdns:demo-validate-reject', 'true') })
  const bar = page.locator('.cfg__savebar')
  await bar.locator('.savebar__save').click()
  await page.getByRole('link', { name: '日志', exact: true }).first().click()
  await expect.poll(() => toastTexts(page), { timeout: 5000 }).toContainEqual(expect.stringContaining('配置没有保存：没有通过校验。草稿留在配置页'))
  await page.evaluate(() => { localStorage.removeItem('kixdns:demo-validate-slow'); localStorage.removeItem('kixdns:demo-validate-reject'); localStorage.setItem('kixdns:demo-changed-elsewhere', 'true') })
  await page.getByRole('link', { name: '规则', exact: true }).first().click()
  await expect(bar).toContainText('这份配置在别处改过了')
  await expect(bar.getByRole('button', { name: '保存并应用', exact: true })).toBeDisabled()
  await expect(page.locator('[data-rule]', { hasText: 'held-return.example' })).toBeVisible()
})

// 断网时改了，连上时文件已经在别处换了：连上就说「别处改过了」，不等保存撞上才知道
// Edits made during an outage, and the file changed elsewhere by the time the panel is back: say 别处改过了 on reconnect instead of waiting for a save to hit it
test('断网时改的草稿，连上时文件在别处改过了：马上进冲突', async ({ page }) => {
  await page.goto('/config')
  await expect(page.locator('.cfg__panel')).toBeVisible()
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-panel-down', 'true'); window.dispatchEvent(new Event('kixdns:panel-unreachable')) })
  await expect(page.locator('.conn__inner')).toBeVisible()
  await addRule(page, 'outage-edit.example')
  await page.evaluate(async () => {
    localStorage.removeItem('kixdns:demo-panel-down')
    localStorage.setItem('kixdns:demo-changed-elsewhere', 'true')
    const url = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/composables/useConnection.ts')).pop()!
    const connection = await import(url)
    void connection.useConnection().retry()
  })
  await expect(page.locator('.conn__inner')).toHaveCount(0, { timeout: 10_000 })
  const bar = page.locator('.cfg__savebar')
  await expect(bar).toContainText('这份配置在别处改过了')
  await expect(page.locator('[data-rule]', { hasText: 'outage-edit.example' })).toBeVisible()
})

// 连上以后的静默重读还在路上时保存落地：那次读是写之前发的，不能拿它把刚存上的规则冲掉
// A save lands while the quiet re-read after a reconnect is still out: that read left before the write and must not wipe the rule just saved
test('重连后的重读还在路上时保存落地，刚存的规则不会被冲掉', async ({ page }) => {
  await page.goto('/config')
  await expect(page.locator('.cfg__panel')).toBeVisible()
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-panel-down', 'true'); window.dispatchEvent(new Event('kixdns:panel-unreachable')) })
  await expect(page.locator('.conn__inner')).toBeVisible()
  await page.evaluate(async () => {
    localStorage.setItem('kixdns:demo-read-slow', 'true')
    localStorage.removeItem('kixdns:demo-panel-down')
    const url = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/composables/useConnection.ts')).pop()!
    const connection = await import(url)
    void connection.useConnection().retry()
  })
  await expect(page.locator('.conn__inner')).toHaveCount(0, { timeout: 10_000 })
  // 读还在路上（1.5 秒）：这时加一条规则、保存；只让读慢，写照常快 / The read is still out (1.5 s): add a rule and save now; only reads are slow, the write is quick
  await addRule(page, 'during-reread.example')
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效', { timeout: 10_000 })
  // 那次旧的读回来以后：规则还在，也不算没保存的修改 / After the old read returns: the rule is still there and does not count as unsaved
  await page.waitForTimeout(3500)
  await expect(page.locator('[data-rule]', { hasText: 'during-reread.example' })).toBeVisible()
  await expect(page.locator('[data-rule]', { hasText: 'during-reread.example' }).getByLabel('改过，还没保存')).toHaveCount(0)
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-read-slow'))
})
