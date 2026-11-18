import { expect, test, type Download, type Page } from '@playwright/test'

// 配置页外壳上的几条流程：JSON 视图、下载、导入、放弃修改、侧栏里的五个配置入口。规则、上游组、域名映射、设置本身在 config-v2.spec.ts。
// The config page shell's flows: the JSON view, download, import, discard, and the sidebar's five config entries. The rules, upstream
// groups, mappings and settings themselves are covered in config-v2.spec.ts.

async function open(page: Page, path = '/config'): Promise<void> {
  await page.goto(path)
  await expect(page.locator('.cfg__panel')).toBeVisible()
}

// 「…」菜单里的一项 / One item of the 「…」 menu
async function more(page: Page, item: string): Promise<void> {
  await page.getByRole('button', { name: '更多配置操作', exact: true }).click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

async function readDownload(download: Download): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function downloadJson(page: Page): Promise<string> {
  const downloaded = page.waitForEvent('download')
  await more(page, '下载 JSON')
  const download = await downloaded
  expect(download.suggestedFilename()).toBe('kixdns-config.json')
  return readDownload(download)
}

async function quickAdd(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill(text)
  await quick.press('Enter')
  await expect(page.locator('[data-rule]').first()).toContainText(text)
}

// JSON 视图给人看、给人改的是内核读的那份（不带 panel）；在里面改一个设置，回到表单就是一处修改，设置页里能看到新值
// The JSON view shows and edits the kernel's part (no panel key); a setting changed there is one change back in the form, visible on the settings page
test('JSON 视图：显示内核配置，改了设置回到表单算一处修改', async ({ page }) => {
  await open(page)
  await more(page, '查看 JSON')
  await expect(page.locator('.cfg__json')).toBeVisible()
  await expect(page.locator('main h1')).toHaveText('配置')
  // 全文从下载拿：JSON 视图里下载的就是编辑器里的文字，而编辑器只渲染看得见的几行
  // The full text comes from the download: in the JSON view it is the editor's text, and the editor renders only the visible lines
  const kernel = JSON.parse(await downloadJson(page)) as Record<string, unknown>
  expect(kernel).not.toHaveProperty('panel')
  expect(kernel).toHaveProperty('pipelines')
  expect((kernel.settings as Record<string, unknown>).cache_capacity).toBe(20000)
  // 双击数字选中这个词，打字替换它 / Double-click the number to select the word, type over it
  const line = page.locator('.cm-line', { hasText: '"cache_capacity": 20000' })
  const number = await line.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const at = node.data.indexOf('20000')
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + 5)
      const box = range.getBoundingClientRect()
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    }
    return null
  })
  expect(number).not.toBeNull()
  await page.mouse.dblclick(number!.x, number!.y)
  await page.keyboard.type('30000')
  await expect(page.locator('.cm-line', { hasText: '"cache_capacity": 30000' })).toHaveCount(1)
  await expect(line).toHaveCount(0)
  // JSON 视图里改的也算草稿：保存条马上升起，说 JSON 有修改；回到表单时读回来，按对象数 / Edits in the JSON view count as draft: the save bar rises at once saying JSON 有修改; back in the form they are read back and counted per object
  await expect(page.locator('.cfg__savebar')).toContainText('JSON 有修改')
  // 桌面上回表单走页头的「表单 | JSON」分段或「…」菜单（手机上「完整配置」旁边另有一个「回到表单」）/ On desktop the way back is the header's 表单 | JSON segment or the 「…」 menu (phones add a 回到表单 beside 完整配置)
  await more(page, '回到表单')
  await expect(page.locator('.cfg__json')).toHaveCount(0)
  await expect(page.locator('.cfg__savebar')).toContainText('已修改 1 处')
  // 走侧栏换页，草稿留着；设置页里是新值，分组和那一行都点了墨点 / Switch pages through the sidebar so the draft stays; the settings page shows the new value with ink dots on the group and row
  await page.locator('.desktop-nav').getByRole('link', { name: '基础设置', exact: true }).click()
  await expect(page).toHaveURL(/section=settings/)
  await page.locator('.settings-nav').getByRole('button', { name: /缓存与后台刷新/ }).click()
  await expect(page.getByLabel('缓存容量', { exact: true })).toHaveValue('30000')
  await expect(page.getByLabel('缓存容量', { exact: true })).toHaveAccessibleDescription('已修改')
  await expect(page.locator('.cfg__savebar')).toContainText('已修改 1 处')
})

// 在 JSON 视图里改了，又恢复一个版本、恢复被拒：恢复问过「没保存的修改会丢失」，被拒时草稿也整份换成读回来的那份，JSON 里的修改跟着
// 丢掉；回到表单不冒出「已修改」，一保存就把恢复改回去
// Edited in the JSON view, then a restore that is refused: the restore asked 没保存的修改会丢失, and when refused the draft is still
// replaced wholesale by what was read, so the JSON edit goes too; back in the form no 已修改 appears that a save would use to undo it
test('JSON 视图里有修改时恢复版本被拒：JSON 也换成读回来的那份，回到表单没有修改', async ({ page }) => {
  await open(page)
  await more(page, '查看 JSON')
  const line = page.locator('.cm-line', { hasText: '"cache_capacity": 20000' })
  const number = await line.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const at = node.data.indexOf('20000')
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + 5)
      const box = range.getBoundingClientRect()
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    }
    return null
  })
  await page.mouse.dblclick(number!.x, number!.y)
  await page.keyboard.type('30000')
  await expect(page.locator('.cfg__savebar')).toContainText('JSON 有修改')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-apply-failed', 'true'))
  await more(page, '历史版本')
  await page.locator('.hist__row', { hasText: '#17' }).locator('.hist__menu button[aria-haspopup]').click()
  await page.locator('[role=menuitem]', { hasText: '恢复为这个版本' }).click()
  await page.locator('dialog.confirm[open]').getByRole('button', { name: /恢复为版本 #17/ }).click()
  await expect(page.locator('.toast', { hasText: '没有生效' })).toBeVisible({ timeout: 5000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.cm-line', { hasText: '"cache_capacity": 30000' })).toHaveCount(0)
  await more(page, '回到表单')
  await expect(page.locator('.cfg__json')).toHaveCount(0)
  await expect(page.locator('.cfg__savebar', { hasText: '已修改' })).toHaveCount(0)
})

// 下载的是配置文件存的样子：内核配置加顶层 panel（面板自己的模型和散列）
// The download is what the config file holds: the kernel config plus a top-level panel (the panel's own model and hash)
test('下载 JSON：文件带顶层 panel，内核部分照原样', async ({ page }) => {
  await open(page)
  const file = JSON.parse(await downloadJson(page)) as Record<string, unknown>
  expect(file).toHaveProperty('panel')
  expect(file).toHaveProperty('pipelines')
  const panel = file.panel as Record<string, unknown>
  expect(panel).toHaveProperty('hash')
  expect(panel).toHaveProperty('model')
  expect((file.settings as Record<string, unknown>).cache_capacity).toBe(20000)
})

// 导入：用页面自己下载的文件改一个设置再导回来；提示说已导入，草稿有一处修改
// Import: take the page's own download, change a setting and bring it back; the toast says 已导入 and the draft has one change
test('导入 JSON：隐藏的文件框读入文件，提示已导入', async ({ page }) => {
  await open(page)
  const file = JSON.parse(await downloadJson(page)) as Record<string, unknown>
  ;(file.settings as Record<string, unknown>).cache_capacity = 25000
  // 内核部分改了，panel 里的散列就对不上，按内核格式重新读 / With the kernel part changed the panel hash no longer matches, so it is re-read as a kernel config
  delete file.panel
  await page.locator('input[type=file]').setInputFiles({ name: 'imported.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) })
  await expect(page.locator('.toast', { hasText: '已导入 imported.json' })).toBeVisible()
  // 读进来的是内核格式时会给一份导入说明；关掉它 / A kernel-format read may show the import notes; dismiss them
  const report = page.getByRole('button', { name: '知道了', exact: true })
  if (await report.count()) await report.click()
  await expect(page.locator('.cfg__savebar')).toContainText('已修改')
  await page.locator('.desktop-nav').getByRole('link', { name: '基础设置', exact: true }).click()
  await page.locator('.settings-nav').getByRole('button', { name: /缓存与后台刷新/ }).click()
  await expect(page.getByLabel('缓存容量', { exact: true })).toHaveValue('25000')
})

// 配置的一个分页：宽屏点侧栏，手机点页头下面的分类 / One section of the config: the sidebar on wide screens, the section tabs on a phone
async function toSection(page: Page, label: string): Promise<void> {
  const side = page.locator('.desktop-nav').getByRole('link', { name: label, exact: true })
  if (await side.isVisible()) await side.click()
  else await page.locator('.cfg__tabs').getByRole('tab', { name: label, exact: true }).click()
}

// 导入的文件里其余请求指向已经删掉的组（panel 里的模型没人检查过）：和规则引用删掉的组一样当场标出来，不等保存时内核拒绝
// An imported file whose catch-alls point at a deleted group (the model in panel was never checked): flagged on the spot as a rule on a deleted
// group is, instead of waiting for the kernel to refuse the save
test('导入的配置里其余请求指向已经删掉的组：规则列表和基础设置里都标出来 @responsive', async ({ page }) => {
  await open(page)
  const file = JSON.parse(await downloadJson(page)) as { panel: { model: Record<string, unknown> } }
  // 只改 panel 里的模型，散列照旧对得上内核部分，读进来就是这份模型 / Only the model in panel changes; the hash still matches the kernel part, so this model is read as is
  file.panel.model.rest = { type: 'upstream', group: 'gone' }
  file.panel.model.ruleGroups = [{ id: 'lan', name: '内网解析', note: '', rules: [], rest: { type: 'upstream', group: 'gone' } }]
  await page.locator('input[type=file]').setInputFiles({ name: 'dangling.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) })
  await expect(page.locator('.toast', { hasText: '已导入 dangling.json' })).toBeVisible()
  // 主列表和规则组最下面的「其余请求」：选的是已删除的组，框标红，和规则一样挂「要修改」 / The 其余请求 row of the main list and of the rule
  // group: the deleted group is selected, the box is red, and 要修改 hangs on it as on a rule
  const rests = page.locator('.rpin--rest')
  await expect(rests).toHaveCount(2)
  for (const rest of await rests.all()) {
    const select = rest.getByRole('combobox', { name: '其余请求怎么处理' })
    await expect(select).toHaveAttribute('aria-invalid', 'true')
    await expect(select.locator('option:checked')).toHaveText('交给「已删除的组」')
    await expect(rest.locator('.ui-tag--warn')).toHaveText('要修改')
  }
  // 基础设置里的「其余请求」就是主列表最下面那一行：同样标出来，框下面说怎么改，和规则编辑里选的组没了一样
  // 其余请求 in the settings is the main list's last row: marked the same, with what to do under the box, as in the rule editor when the chosen group is gone
  await toSection(page, '基础设置')
  await page.locator('.settings-nav').getByRole('button', { name: /规则默认值/ }).click()
  const setting = page.getByRole('combobox', { name: '其余请求', exact: true })
  await expect(setting).toHaveAttribute('aria-invalid', 'true')
  await expect(setting.locator('option:checked')).toHaveText('已删除的组')
  await expect(page.getByText('这个组已经删掉了，选一个现有的组')).toBeVisible()
  // 选回一个现有的组，标记就收起；规则组的那一行还标着 / Choosing an existing group clears the mark; the rule group's row stays marked
  await setting.selectOption({ label: 'default' })
  await expect(setting).not.toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('这个组已经删掉了，选一个现有的组')).toHaveCount(0)
  await toSection(page, '规则')
  await expect(rests.first().locator('.ui-tag--warn')).toHaveCount(0)
  await expect(rests.first().getByRole('combobox', { name: '其余请求怎么处理' })).not.toHaveAttribute('aria-invalid', 'true')
  await expect(rests.nth(1).locator('.ui-tag--warn')).toHaveText('要修改')
})

// 有高级规则时「默认上游」在「基础与监听」里单独设：照内核读一遍，写错了当场说哪个地址哪里不对，和上游组的地址一个说法，不等保存时内核拒绝
// With advanced rules 默认上游 is set on its own under 基础与监听: read as the kernel reads it, a mistake says on the spot which address is wrong and
// how, in the words of an upstream group's addresses, instead of waiting for the kernel to refuse the save
test('有高级规则时的「默认上游」写错了当场标出来，说法和上游组的地址一样 @responsive', async ({ page }) => {
  await open(page)
  // 决定结果的动作后面还有一个：放不进面板的写法，导入后成为高级规则；默认上游没写端口 / An action after the deciding one fits no panel field and
  // imports as an advanced rule; the default upstream lacks a port
  const config = { version: '1.0', settings: { default_upstream: '1.1.1.1' }, pipeline_select: [{ pipeline: 'main', matchers: [] }], pipelines: [{ id: 'main', rules: [{ name: 'ads', matchers: [{ type: 'geo_site', value: 'category-ads-all' }], actions: [{ type: 'deny' }, { type: 'static_response', rcode: 'NXDOMAIN' }] }] }] }
  await page.locator('input[type=file]').setInputFiles({ name: 'raw.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(config)) })
  await expect(page.locator('.toast', { hasText: '已导入 raw.json' })).toBeVisible()
  const report = page.getByRole('button', { name: '知道了', exact: true })
  if (await report.count()) await report.click()
  await toSection(page, '基础设置')
  await page.locator('.settings-nav').getByRole('button', { name: /基础与监听/ }).click()
  const field = page.getByLabel('默认上游', { exact: true })
  await expect(field).toHaveValue('1.1.1.1')
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  const error = page.locator(`#${await field.getAttribute('aria-describedby')}`)
  await expect(error).toHaveText('第 1 个地址：UDP 只能写 IP 和端口，比如 223.5.5.5:53；域名要用 TCP、DoH、DoT 或 DoQ')
  await field.fill('1.1.1.1:53, 8.8.8.8:0')
  await expect(error).toHaveText('第 2 个地址的端口要在 1 到 65535 之间')
  // 清空了内核读到的是空的，一个地址都没有，整份配置不收 / Cleared, the kernel reads an empty value with no address and refuses the config
  await field.fill('')
  await expect(error).toHaveText('至少填一个地址')
  await field.fill('1.1.1.1:53, https://dns.google/dns-query')
  await expect(field).not.toHaveAttribute('aria-invalid', 'true')
  await expect(field).not.toHaveAttribute('aria-describedby', /./)
  await expect(error).toHaveCount(0)
})

// 放弃修改：草稿回到运行中的配置，保存条收起，提示里能撤销 / Discard: the draft returns to the running config, the bar leaves, and the toast can undo
test('放弃修改清掉保存条，提示里可以撤销', async ({ page }) => {
  await open(page)
  await quickAdd(page, 'example.org')
  await expect(page.locator('.cfg__savebar')).toContainText('已修改 1 处')
  await page.getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toHaveCount(0)
  await expect(page.locator('[data-rule]')).toHaveCount(0)
  const toast = page.locator('.toast', { hasText: '已放弃 1 处修改' })
  await expect(toast).toBeVisible()
  await toast.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.locator('[data-rule]').first()).toContainText('example.org')
  await expect(page.locator('.cfg__savebar')).toContainText('已修改 1 处')
})

// 侧栏里配置的五项共用一条路由，?section= 说是哪一页；规则是默认页，不带参数；当前的那一项有 aria-current
// The sidebar's five config items share one route and ?section= names the page; 规则 is the default without a parameter; the current item carries aria-current
test('侧栏的五个配置入口切换分页，当前项带 aria-current', async ({ page }) => {
  await open(page)
  const nav = page.locator('.desktop-nav')
  const current = () => nav.locator('a[aria-current="page"]')
  await expect(current()).toHaveText('规则')
  const sections: Array<[string, RegExp, string]> = [
    ['上游组', /section=upstreams/, '上游组'],
    ['域名映射', /section=mapping/, '域名映射'],
    ['拦截列表', /section=blocklists/, '拦截列表'],
    ['基础设置', /section=settings/, '基础设置'],
  ]
  for (const [label, url, title] of sections) {
    await nav.getByRole('link', { name: label, exact: true }).click()
    await expect(page).toHaveURL(url)
    await expect(current()).toHaveCount(1)
    await expect(current()).toHaveText(label)
    await expect(page.locator('main h1')).toHaveText(title)
  }
  await nav.getByRole('link', { name: '规则', exact: true }).click()
  await expect(page).not.toHaveURL(/section=/)
  await expect(current()).toHaveText('规则')
  await expect(page.locator('main h1')).toHaveText('规则')
})
