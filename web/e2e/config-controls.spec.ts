import { expect, test, type Locator, type Page } from '@playwright/test'

// 首次安装时起点一直在屏幕上（宽屏在检查器里，手机在列表里，点一个就带着它打开整屏层），工具栏里没有「添加入口」（审计第四轮 B4）
// On first install the starts are always on screen (in the inspector on wide screens, in the list on a phone, where a tap opens the layer
// with it chosen), and the toolbar has no 添加入口 (audit round 4, B4)
async function pickFirstStart(page: Page, name: RegExp): Promise<Locator> {
  const phone = (page.viewportSize()?.width ?? 1440) <= 860
  const starts = phone ? page.getByRole('radiogroup', { name: '添加第一个入口', exact: true }) : page.getByRole('region', { name: '添加入口', exact: true })
  await starts.getByRole('radio', { name }).click()
  return page.getByRole('region', { name: '添加入口', exact: true })
}

async function openConfig(page: Page): Promise<void> {
  await page.goto('/config')
  await expect(page.locator('.app-shell')).toBeVisible()
}

async function expectNoOverflow(page: Page): Promise<void> {
  const { clientWidth, scrollWidth } = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
}

test('设置搜索呈现前置开关，关闭功能保留值，清除搜索回到原来那一组 @responsive', async ({ page }) => {
  await openConfig(page)
  await page.getByRole('tab', { name: '基础设置', exact: true }).click()
  // 分组列表是导航：一开始停在「基础与监听」，缓存那一组还没打开。
  // The group list is navigation: it starts on 基础与监听, with the cache group not open.
  const nav = page.getByRole('navigation', { name: '设置分组' })
  const cacheSection = nav.getByRole('button', { name: /缓存与后台刷新/ })
  await expect(nav.getByRole('button', { name: /基础与监听/ })).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('spinbutton', { name: '刷新阈值 (%)', exact: true })).toHaveCount(0)

  await page.getByRole('searchbox', { name: '搜索基础设置' }).fill('cache_refresh_threshold_percent')
  const threshold = page.getByRole('spinbutton', { name: '刷新阈值 (%)', exact: true })
  const enabled = page.getByRole('switch', { name: '后台刷新', exact: true })
  const toggle = page.locator('.ui-setrow--toggle').filter({ has: enabled })
  // 搜到的设置连同它依赖的开关一起列出来。 / A match is listed together with the switch it depends on.
  await expect(enabled).not.toBeChecked()
  await expect(threshold).toBeVisible()
  await expect(threshold).toBeDisabled()
  // 灰掉的设置写明要先打开哪个开关 / A disabled setting names the switch to turn on first
  await expect(page.getByText('先打开「后台刷新」', { exact: true })).toBeVisible()
  // 搜索不影响 Geo 数据，它仍在分组里。 / Searching leaves Geo 数据 alone; it is still in the group list.
  // 手机上搜索结果会替换分组列表，所以这里只查 Geo 数据没有被搜索从列表里去掉。
  // On a phone the results replace the group list, so this checks only that search did not drop Geo 数据 from it.
  await expect(nav.locator('.settings-nav__item', { hasText: 'Geo 数据' })).toHaveCount(1)
  await expect(page.getByRole('tab', { name: '基础设置', exact: true })).toHaveAttribute('aria-selected', 'true')

  await toggle.click()
  await expect(threshold).toBeEnabled()
  await threshold.fill('23')
  await toggle.click()
  await expect(enabled).not.toBeChecked()
  await expect(threshold).toBeDisabled()
  await expect(threshold).toHaveValue('23')

  await page.getByRole('button', { name: '清除设置搜索', exact: true }).click()
  await expect(page.getByRole('searchbox', { name: '搜索基础设置' })).toHaveValue('')
  // 清除搜索回到原来那一组。 / Clearing the search returns to the group that was open.
  await expect(nav.getByRole('button', { name: /基础与监听/ })).toHaveAttribute('aria-current', 'true')
  await expect(threshold).toHaveCount(0)
  await expect(nav.getByRole('button', { name: /Geo 数据/ })).toBeVisible()
  await expect(page.getByRole('tab', { name: '基础设置', exact: true })).toHaveAttribute('aria-selected', 'true')

  await cacheSection.click()
  await toggle.click()
  await expect(threshold).toHaveValue('23')
  await expectNoOverflow(page)
})

test('已有上游回填地址与协议，ECS 折叠和重新编辑均保留固定子网 @responsive', async ({ page }) => {
  await openConfig(page)
  const guide = await pickFirstStart(page, /指定域名上游/)
  await guide.getByLabel('条件 1 值', { exact: true }).fill('interactive.example')
  await guide.getByLabel('动作 1 上游', { exact: true }).fill('9.9.9.9:53')
  await guide.getByLabel('动作 1 传输协议', { exact: true }).selectOption('tcp')
  // 已有上游在上游输入框右端的 ▾ 里，选中同时填上游和协议 / Existing upstreams sit behind the ▾ at the end of the upstream field; picking one fills both
  await guide.getByLabel('动作 1 选用已有上游', { exact: true }).click()
  await page.getByRole('menuitem', { name: '1.1.1.1:53 (UDP)', exact: true }).click()
  await expect(guide.getByLabel('动作 1 上游', { exact: true })).toHaveValue('1.1.1.1:53')
  await expect(guide.getByLabel('动作 1 传输协议', { exact: true })).toHaveValue('udp')

  const advanced = guide.locator('.action-ecs-toggle')
  await expect(advanced).toHaveAttribute('aria-expanded', 'false')
  await advanced.click()
  await guide.getByLabel('动作 1 ECS 模式', { exact: true }).selectOption('static')
  await guide.getByLabel('ECS 固定 IP', { exact: true }).fill('192.0.2.0')
  await guide.getByLabel('ECS 固定前缀', { exact: true }).fill('24')
  await advanced.click()
  await expect(advanced).toHaveAttribute('aria-expanded', 'false')
  await expect(guide.getByLabel('ECS 固定 IP', { exact: true })).toHaveCount(0)
  await advanced.click()
  await expect(guide.getByLabel('ECS 固定 IP', { exact: true })).toHaveValue('192.0.2.0')
  await expect(guide.getByLabel('ECS 固定前缀', { exact: true })).toHaveValue('24')
  await advanced.click()
  await guide.getByRole('button', { name: '应用到草稿', exact: true }).click()
  await expect(guide).toHaveCount(0)

  const created = page.locator('.workbench-entry').filter({ hasText: 'interactive.example' })
  await created.locator('.workbench-entry-select').click()
  const editor = page.locator('.workbench-guide')
  await expect(editor.locator('.action-ecs-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(editor.getByLabel('动作 1 ECS 模式', { exact: true })).toHaveValue('static')
  await expect(editor.getByLabel('ECS 固定 IP', { exact: true })).toHaveValue('192.0.2.0')
  await expect(editor.getByLabel('ECS 固定前缀', { exact: true })).toHaveValue('24')
  await expect(editor.getByLabel('动作 1 传输协议', { exact: true })).toHaveValue('udp')
  await expectNoOverflow(page)
})

test('域名映射批量导入先预览并定位错误行，全部修正后追加且保留 TTL 0 @responsive', async ({ page }) => {
  await openConfig(page)
  await page.getByRole('tab', { name: '域名映射', exact: true }).click()
  await page.getByRole('button', { name: '添加映射', exact: true }).click()
  await page.getByLabel('映射 1 源域名', { exact: true }).fill('existing.example')
  await page.getByLabel('映射 1 目标域名', { exact: true }).fill('preserved.example.')
  await page.getByRole('button', { name: '批量粘贴', exact: true }).click()

  const bulk = page.getByRole('textbox', { name: '批量域名映射', exact: true })
  const invalidLine = 'bad.example target.example. -1'
  await bulk.fill(`first.example target.example. 0\n\n${invalidLine}\nlast.example final.example.`)
  // 批量区先说清格式，逐行预览在下面；有一行不对，「追加到映射表」就是灰的，旁边写着是哪一行——通过检查后才追加。
  // 预览只标出错的行，不写「N 条有效」这种计数（审计 M9）。
  // The bulk area states the format with the per-line preview below; while a line is wrong 追加到映射表 stays disabled
  // with the failing line named beside it, so lines append only after checking. Only failing lines are marked, no count row (audit M9).
  await expect(page.getByText('一行一条：源域名 目标域名 [TTL 秒]', { exact: true })).toBeVisible()
  await expect(page.locator('.mapping-editor__preview li')).toHaveCount(3)
  await expect(page.locator('.mapping-editor__preview li.has-error')).toHaveCount(1)
  await expect(page.locator('.mapping-editor__blocker')).toHaveText('第 3 行要先改好')
  await expect(page.getByRole('status').filter({ hasText: '1 行要先改好' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: '追加到映射表', exact: true })).toBeDisabled()
  await expect(page.locator('.mapping-editor__item')).toHaveCount(1)
  await expect(page.getByLabel('映射 1 源域名', { exact: true })).toHaveValue('existing.example')

  await page.getByTitle('定位到第 3 行', { exact: true }).click()
  await expect(bulk).toBeFocused()
  const selectedLine = await bulk.evaluate((element: HTMLTextAreaElement) => (
    element.value.slice(element.selectionStart, element.selectionEnd)
  ))
  expect(selectedLine).toBe(invalidLine)

  await bulk.fill('first.example target.example. 0\n\ncorrected.example origin.example. 60\nlast.example final.example.')
  await expect(page.locator('.mapping-editor__preview li')).toHaveCount(3)
  await expect(page.locator('.mapping-editor__preview li.has-error')).toHaveCount(0)
  await expect(page.locator('.mapping-editor__blocker')).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: '3 条都能追加' })).toHaveCount(1)
  await expect(page.locator('.mapping-editor__item')).toHaveCount(1)
  await page.getByRole('button', { name: '追加到映射表', exact: true }).click()

  await expect(page.locator('.mapping-editor__item')).toHaveCount(4)
  await expect(bulk).toHaveCount(0)
  await expect(page.getByLabel('映射 1 源域名', { exact: true })).toHaveValue('existing.example')
  await expect(page.getByLabel('映射 1 目标域名', { exact: true })).toHaveValue('preserved.example.')
  await expect(page.getByLabel('映射 2 源域名', { exact: true })).toHaveValue('first.example')
  await expect(page.getByLabel('映射 2 TTL', { exact: true })).toHaveValue('0')
  await expect(page.getByLabel('映射 3 源域名', { exact: true })).toHaveValue('corrected.example')
  await expect(page.getByLabel('映射 3 TTL', { exact: true })).toHaveValue('60')
  await expect(page.getByLabel('映射 4 TTL', { exact: true })).toHaveValue('300')
  await expectNoOverflow(page)
})

test('批量框一次贴进几行后从每行的开头显示 @responsive', async ({ page }) => {
  await openConfig(page)
  await page.getByRole('tab', { name: '域名映射', exact: true }).click()
  await page.getByRole('button', { name: '批量粘贴', exact: true }).click()
  const bulk = page.getByRole('textbox', { name: '批量域名映射', exact: true })
  // 真的从剪贴板粘贴几行：框不折行，贴完回到行首，每行从第一个字开始（审计第二轮 M1）
  // A real clipboard paste of several lines: the box never wraps, and afterwards it shows each line from its first character (audit round 2, M1)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() => navigator.clipboard.writeText('media.home.arpa nas.lan.example.net\nbad.example target.example. -1\nprinter.home.arpa, gw.lan.example.net, 600'))
  await bulk.focus()
  await page.keyboard.press('ControlOrMeta+V')
  await expect(page.locator('.mapping-editor__preview li')).toHaveCount(3)
  await expect.poll(() => bulk.evaluate((element: HTMLTextAreaElement) => element.scrollLeft)).toBe(0)
})

test('设置行与 Geo 维护完整容纳操作按钮 @responsive', async ({ page }) => {
  await openConfig(page)
  await page.getByRole('tab', { name: '基础设置', exact: true }).click()
  await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: /Geo 数据/ }).click()
  await page.getByRole('button', { name: '远程链接', exact: true }).click()
  await page.getByRole('button', { name: '添加链接', exact: true }).click()
  const rows = page.locator('.geo-list .geo-item:visible')
  // 同一帧测量，避免 Vue 更新列表后逐个 nth 定位指向已移除的行。× 在文件那一行末尾，不能被裁掉；
  // 所有地址框右边对齐（规范 3.11）。
  // Measured in one frame so no nth locator points at a row Vue has removed. The × ends the file line and must
  // not be clipped; every link box ends on the same line (spec 3.11).
  await expect.poll(() => rows.evaluateAll((elements) => ({
    multipleRows: elements.length > 1,
    clippedRows: elements.filter((row) => {
      const button = row.querySelector('.geo-file__remove')
      return !button || button.getBoundingClientRect().right > row.getBoundingClientRect().right + 1
    }).length,
    linkRightEdges: new Set([...document.querySelectorAll('.geo-link')].map((link) => Math.round(link.getBoundingClientRect().right))).size,
  }))).toEqual({ multipleRows: true, clippedRows: 0, linkRightEdges: 1 })
  await expectNoOverflow(page)
})

test('添加映射只加一个空行：不写进草稿、不出保存栏，焦点落在新行的源域名 @responsive', async ({ page }) => {
  await openConfig(page)
  await page.getByRole('tab', { name: '域名映射', exact: true }).click()
  const before = await page.locator('.mapping-editor__item').count()
  // 空行不算修改：不写进草稿，保存栏不出来（规范 9.3，审计 M1） / A blank row is no change: nothing written, no save bar (spec 9.3, audit M1)
  await page.getByRole('button', { name: '添加映射', exact: true }).click()
  await expect(page.locator('.mapping-editor__item')).toHaveCount(before + 1)
  await expect(page.getByLabel(`映射 ${before + 1} 源域名`, { exact: true })).toBeFocused()
  await expect(page.locator('.config-savebar')).toHaveCount(0)

  // 已经有行时，焦点也落在新加的那一行，而不是原来的最后一行（审计 M2） / With rows present, focus lands on the new row, not the old last one (audit M2)
  await page.getByLabel(`映射 ${before + 1} 源域名`, { exact: true }).fill('first.example')
  await page.getByLabel(`映射 ${before + 1} 目标域名`, { exact: true }).fill('target.example.')
  await page.getByRole('button', { name: '添加映射', exact: true }).click()
  await expect(page.getByLabel(`映射 ${before + 2} 源域名`, { exact: true })).toBeFocused()
  await expect(page.getByLabel(`映射 ${before + 2} 源域名`, { exact: true })).toHaveValue('')
  await expectNoOverflow(page)
})

test('上游地址框在中间改字：光标不跳、值不走样，一次退格删一个字', async ({ page }) => {
  await openConfig(page)
  const guide = await pickFirstStart(page, /指定域名上游/)
  // 模板的域名留空，要自己填（审计第二轮 B1） / The template's domain starts empty and must be filled (audit round 2, B1)
  await guide.getByLabel('条件 1 值', { exact: true }).fill('caret.example')
  const upstream = guide.getByLabel('动作 1 上游', { exact: true })
  await upstream.fill('https://dns.example/dns-query')
  // 框里在「/」后面有可以断行的零宽字符，传出去的值里没有 / The field holds zero-width break points after 「/」, the emitted value does not
  const plain = () => upstream.evaluate((element: HTMLTextAreaElement) => element.value.replace(/[\u200b\u2060]/g, ''))
  const caretAfter = (text: string) => upstream.evaluate((element: HTMLTextAreaElement, visible: string) => {
    let seen = 0
    let at = 0
    while (at < element.value.length && seen < visible.length) {
      if (!/[\u200b\u2060]/.test(element.value[at]!)) seen += 1
      at += 1
    }
    element.setSelectionRange(at, at)
  }, text)

  // 在中间打字：字落在光标处，光标跟着字走 / Typing in the middle: characters land at the caret, which moves with them
  await caretAfter('https://dns')
  await page.keyboard.type('xy')
  expect(await plain()).toBe('https://dnsxy.example/dns-query')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  expect(await plain()).toBe('https://dns.example/dns-query')

  // 紧跟在「/」后面退格：一次就删掉「/」，不是先删那个看不见的字符 / Backspace right after 「/」 deletes the 「/」 in one press, not the invisible character first
  await caretAfter('https://dns.example/')
  await page.keyboard.press('Backspace')
  expect(await plain()).toBe('https://dns.exampledns-query')
  await page.keyboard.type('/')
  expect(await plain()).toBe('https://dns.example/dns-query')

  // 应用到草稿后，配置里的值同样干净 / After applying, the config value is just as clean
  await guide.getByRole('button', { name: '应用到草稿', exact: true }).click()
  await page.getByRole('button', { name: 'JSON', exact: true }).click()
  const downloaded = page.waitForEvent('download')
  await page.getByTitle('下载 JSON', { exact: true }).click()
  const chunks: Buffer[] = []
  for await (const chunk of await (await downloaded).createReadStream()) chunks.push(chunk as Buffer)
  const json = Buffer.concat(chunks).toString('utf8')
  expect(json).toContain('"upstream": "https://dns.example/dns-query"')
  expect(json).not.toMatch(/[\u200b\u2060]/)
})
