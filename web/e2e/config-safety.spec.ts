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
  await page.evaluate(() => { localStorage.setItem('kixdns:demo-save-slow', 'true'); localStorage.setItem('kixdns:demo-save-conflict', 'true') })
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
  await drawer.getByRole('button', { name: '关闭' }).click()
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
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-slow', 'true'))
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toContainText('写入并应用')
  await page.getByRole('link', { name: '日志', exact: true }).click()
  await page.getByRole('button', { name: /^账户：/ }).click()
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.locator('dialog.confirm[open]')).toContainText('退出登录以后不再告诉你结果')
  await page.locator('dialog.confirm[open]').getByRole('button', { name: '放弃并退出' }).click()
  await expect(page).toHaveURL(/\/login/)
  // 慢保存要 1.5 秒才落地：等它落地以后再看 / The slow save takes 1.5 s to land: look after it has
  await page.waitForTimeout(2500)
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
  await expect(dialog).toContainText('没有生效，重启后仍用之前那份配置；要再试，到配置页点「重试应用」')
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
