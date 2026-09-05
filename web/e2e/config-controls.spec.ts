import { expect, test, type Page } from '@playwright/test'

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

test('设置搜索呈现前置开关，关闭功能保留值，清除搜索恢复原折叠状态', async ({ page }) => {
  await openConfig(page)
  await page.getByRole('button', { name: '基础设置', exact: true }).click()
  const cacheSection = page.getByRole('button', { name: '缓存与后台刷新', exact: true })
  await expect(cacheSection).toHaveAttribute('aria-expanded', 'false')

  await page.getByRole('searchbox', { name: '搜索基础设置' }).fill('cache_refresh_threshold_percent')
  const threshold = page.getByRole('spinbutton', { name: '刷新阈值 (%)', exact: true })
  const enabled = page.getByRole('checkbox', { name: '后台刷新', exact: true })
  const toggle = page.locator('.setting-toggle').filter({ has: enabled })
  await expect(cacheSection).toHaveAttribute('aria-expanded', 'true')
  await expect(enabled).not.toBeChecked()
  await expect(threshold).toBeVisible()
  await expect(threshold).toBeDisabled()
  await expect(page.getByText('启用「后台刷新」后可调整；已有值保留。')).toBeVisible()
  await expect(page.locator('.geo-data-section')).toBeVisible()
  await expect(page.getByRole('button', { name: '基础设置', exact: true })).toHaveAttribute('aria-pressed', 'true')

  await toggle.click()
  await expect(threshold).toBeEnabled()
  await threshold.fill('23')
  await toggle.click()
  await expect(enabled).not.toBeChecked()
  await expect(threshold).toBeDisabled()
  await expect(threshold).toHaveValue('23')

  await page.getByRole('button', { name: '清除设置搜索', exact: true }).click()
  await expect(page.getByRole('searchbox', { name: '搜索基础设置' })).toHaveValue('')
  await expect(cacheSection).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('button', { name: '基础与监听', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.geo-data-section')).toBeVisible()
  await expect(page.getByRole('button', { name: '基础设置', exact: true })).toHaveAttribute('aria-pressed', 'true')

  await cacheSection.click()
  await toggle.click()
  await expect(threshold).toHaveValue('23')
  await expectNoOverflow(page)
})

test('已有上游回填地址与协议，ECS 折叠和重新编辑均保留固定子网', async ({ page }) => {
  await openConfig(page)
  await page.locator('.workbench-list-toolbar').getByRole('button', { name: '添加入口', exact: true }).click()
  const guide = page.getByRole('region', { name: '添加入口', exact: true })
  await guide.getByRole('button', { name: /指定域名上游/ }).click()
  await guide.getByLabel('条件 1 值', { exact: true }).fill('interactive.example')
  await guide.getByLabel('动作 1 上游', { exact: true }).fill('9.9.9.9:53')
  await guide.getByLabel('动作 1 传输协议', { exact: true }).selectOption('tcp')
  await guide.getByRole('button', { name: '使用已有上游 1.1.1.1:53（UDP）', exact: true }).click()
  await expect(guide.getByLabel('动作 1 上游', { exact: true })).toHaveValue('1.1.1.1:53')
  await expect(guide.getByLabel('动作 1 传输协议', { exact: true })).toHaveValue('udp')

  const advanced = guide.locator('.action-advanced')
  await expect(advanced).not.toHaveAttribute('open')
  await advanced.locator('summary').click()
  await guide.getByLabel('动作 1 ECS 模式', { exact: true }).selectOption('static')
  await guide.getByLabel('ECS 固定 IP', { exact: true }).fill('192.0.2.0')
  await guide.getByLabel('ECS 固定前缀', { exact: true }).fill('24')
  await advanced.locator('summary').click()
  await expect(advanced).not.toHaveAttribute('open')
  await advanced.locator('summary').click()
  await expect(guide.getByLabel('ECS 固定 IP', { exact: true })).toHaveValue('192.0.2.0')
  await expect(guide.getByLabel('ECS 固定前缀', { exact: true })).toHaveValue('24')
  await advanced.locator('summary').click()
  await guide.getByRole('button', { name: '应用到草稿', exact: true }).click()
  await expect(guide).toHaveCount(0)

  const created = page.locator('.workbench-entry').filter({ hasText: 'interactive.example' })
  await created.locator('.workbench-entry-select').click()
  const editor = page.locator('.workbench-guide')
  await expect(editor.locator('.action-advanced')).toHaveAttribute('open', '')
  await expect(editor.getByLabel('动作 1 ECS 模式', { exact: true })).toHaveValue('static')
  await expect(editor.getByLabel('ECS 固定 IP', { exact: true })).toHaveValue('192.0.2.0')
  await expect(editor.getByLabel('ECS 固定前缀', { exact: true })).toHaveValue('24')
  await expect(editor.getByLabel('动作 1 传输协议', { exact: true })).toHaveValue('udp')
  await expectNoOverflow(page)
})

test('域名映射批量导入先预览并定位错误行，全部修正后追加且保留 TTL 0', async ({ page }) => {
  await openConfig(page)
  await page.getByRole('button', { name: '域名映射', exact: true }).click()
  await page.getByRole('button', { name: '添加映射', exact: true }).click()
  await page.getByLabel('映射 1 源域名', { exact: true }).fill('existing.example')
  await page.getByLabel('映射 1 目标域名', { exact: true }).fill('preserved.example.')
  await page.getByRole('button', { name: '批量粘贴', exact: true }).click()

  const bulk = page.getByRole('textbox', { name: '批量域名映射', exact: true })
  const invalidLine = 'bad.example target.example. -1'
  await bulk.fill(`first.example target.example. 0\n\n${invalidLine}\nlast.example final.example.`)
  await expect(page.getByText('粘贴后先预览', { exact: true })).toBeVisible()
  await expect(page.locator('.mapping-editor__preview-count')).toContainText('2 条有效')
  await expect(page.locator('.mapping-editor__preview-count')).toContainText('1 行需要修正')
  await expect(page.getByRole('button', { name: '导入到映射表', exact: true })).toBeDisabled()
  await expect(page.locator('.mapping-editor__item')).toHaveCount(1)
  await expect(page.getByLabel('映射 1 源域名', { exact: true })).toHaveValue('existing.example')

  await page.getByTitle('定位到第 3 行', { exact: true }).click()
  await expect(bulk).toBeFocused()
  const selectedLine = await bulk.evaluate((element: HTMLTextAreaElement) => (
    element.value.slice(element.selectionStart, element.selectionEnd)
  ))
  expect(selectedLine).toBe(invalidLine)

  await bulk.fill('first.example target.example. 0\n\ncorrected.example origin.example. 60\nlast.example final.example.')
  await expect(page.locator('.mapping-editor__preview-count')).toContainText('3 条有效')
  await expect(page.locator('.mapping-editor__preview-count')).toContainText('可全部导入')
  await expect(page.locator('.mapping-editor__item')).toHaveCount(1)
  await page.getByRole('button', { name: '导入到映射表', exact: true }).click()

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

test('设置行与 Geo 维护完整容纳操作按钮', async ({ page }) => {
  await openConfig(page)
  await page.getByRole('button', { name: '基础设置', exact: true }).click()
  await page.getByRole('tab', { name: '远程链接', exact: true }).click()
  await page.getByRole('button', { name: '添加链接', exact: true }).click()
  const rows = page.locator('.setting-list__row:visible, .geo-maintenance:visible')
  // 同一帧测量，避免 Vue 更新列表后逐个 nth 定位指向已移除的行。
  await expect.poll(() => rows.evaluateAll((elements) => ({
    multipleRows: elements.length > 1,
    clippedRows: elements.filter((row) => {
      const button = row.querySelector('.icon-button')
      return !button || button.getBoundingClientRect().right > row.getBoundingClientRect().right + 1
    }).length,
  }))).toEqual({ multipleRows: true, clippedRows: 0 })
  await expectNoOverflow(page)
})
