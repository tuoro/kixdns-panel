import { expect, test, type Download, type Page } from '@playwright/test'

// 配置页外壳上的几条流程：JSON 视图、下载、导入、放弃修改、侧栏里的四个配置入口。规则、上游组、域名映射、设置本身在 config-v2.spec.ts。
// The config page shell's flows: the JSON view, download, import, discard, and the sidebar's four config entries. The rules, upstream
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
  // JSON 视图里改的还没进草稿：保存条不出来，回到表单才算 / Edits in the JSON view are not in the draft yet: no save bar until 回到表单
  await expect(page.locator('.cfg__savebar')).toHaveCount(0)
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

// 侧栏里配置的四项共用一条路由，?section= 说是哪一页；规则是默认页，不带参数；当前的那一项有 aria-current
// The sidebar's four config items share one route and ?section= names the page; 规则 is the default without a parameter; the current item carries aria-current
test('侧栏的四个配置入口切换分页，当前项带 aria-current', async ({ page }) => {
  await open(page)
  const nav = page.locator('.desktop-nav')
  const current = () => nav.locator('a[aria-current="page"]')
  await expect(current()).toHaveText('规则')
  const sections: Array<[string, RegExp, string]> = [
    ['上游组', /section=upstreams/, '上游组'],
    ['域名映射', /section=mapping/, '域名映射'],
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
