import { expect, test, type Page } from '@playwright/test'
import { acceptConfirm, cancelConfirm } from './confirm'

const configFixture = {
  version: '1.0',
  settings: { bind_addr: '0.0.0.0:53', default_upstream: '1.1.1.1:53' },
  pipeline_select: [
    { pipeline: 'mapping', matcher_operator: 'and', matchers: [{ type: 'domain_suffix', operator: 'and', value: 'alias.example' }] },
    { pipeline: 'domestic', matcher_operator: 'and', matchers: [{ type: 'geo_site', operator: 'and', value: 'geosite:cn' }] },
    { pipeline: 'fallback', matcher_operator: 'and', matchers: [] },
  ],
  pipelines: [
    { id: 'mapping', rules: [{ name: 'mapping-rule', matchers: [], matcher_operator: 'and', actions: [{ type: 'static_cname_response', target: 'origin.example.', ttl: 300 }] }] },
    { id: 'domestic', rules: [{ name: 'domestic-rule', matchers: [], matcher_operator: 'and', actions: [{ type: 'forward', upstream: '223.5.5.5:53', transport: '' }] }] },
    { id: 'fallback', rules: [{ name: 'fallback-rule', matchers: [], matcher_operator: 'and', actions: [{ type: 'forward', upstream: '1.1.1.1:53', transport: '' }] }] },
  ],
}

async function openWorkbench(page: Page, fixture: unknown = configFixture): Promise<void> {
  await page.goto('/config')
  await expect(page.getByLabel('解析编排工作台', { exact: true })).toBeVisible()
  await page.locator('input[type=file]').setInputFiles({ name: 'workbench.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) })
  await expect(page.locator('.workbench-entry')).toHaveCount(2)
}

async function downloadConfig(page: Page) {
  const downloaded = page.waitForEvent('download')
  await page.getByTitle('下载 JSON', { exact: true }).click()
  const stream = await (await downloaded).createReadStream()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function configWithJumpReference() {
  return {
    ...configFixture,
    pipelines: [...configFixture.pipelines, {
      id: 'jump-source',
      rules: [{ name: 'jump', matchers: [], matcher_operator: 'and', actions: [{ type: 'jump_to_pipeline', pipeline: 'domestic' }] }],
    }],
  }
}

test('删除入口保留被其他规则跳转引用的 Pipeline', async ({ page }) => {
  await openWorkbench(page, configWithJumpReference())
  await expect(page.locator('.workbench-entry').first()).toContainText('2 处引用')
  await page.getByLabel('入口 01 操作', { exact: true }).click()
  await page.getByRole('button', { name: '删除入口', exact: true }).first().click()
  await acceptConfirm(page)
  await expect(page.locator('.workbench-entry')).toHaveCount(1)
  const result = await downloadConfig(page)
  expect(result.pipeline_select.some((entry: { pipeline: string }) => entry.pipeline === 'domestic')).toBe(false)
  expect(result.pipelines.find((pipeline: { id: string }) => pipeline.id === 'domestic')).toBeDefined()
  expect(result.pipelines.find((pipeline: { id: string }) => pipeline.id === 'jump-source').rules[0].actions[0].pipeline).toBe('domestic')
})

test('被跳转引用的流程默认复制编辑，不影响原规则目标', async ({ page }) => {
  await openWorkbench(page, configWithJumpReference())
  await page.getByRole('button', { name: '编辑入口 01 domestic', exact: true }).click()
  const inspector = page.locator('.workbench-inspector')
  await expect(inspector.getByLabel('共享流程处理方式', { exact: true })).toHaveValue('copy')
  await inspector.getByLabel('动作 1 上游', { exact: true }).fill('9.9.9.9:53')
  await inspector.getByRole('button', { name: '应用到草稿', exact: true }).click()
  const result = await downloadConfig(page)
  const copiedId = result.pipeline_select[1].pipeline
  expect(copiedId).not.toBe('domestic')
  expect(result.pipelines.find((pipeline: { id: string }) => pipeline.id === copiedId).rules[0].actions[0].upstream).toBe('9.9.9.9:53')
  expect(result.pipelines.find((pipeline: { id: string }) => pipeline.id === 'domestic').rules[0].actions[0].upstream).toBe('223.5.5.5:53')
  expect(result.pipelines.find((pipeline: { id: string }) => pipeline.id === 'jump-source').rules[0].actions[0].pipeline).toBe('domestic')
})

test('工作台单独展示最高优先级映射，普通入口可搜索和调整顺序 @responsive', async ({ page }) => {
  await openWorkbench(page)
  // 流程带压成一行后，每段带自己的实际条数，优先级说明落在下方那句提示里。
  await expect(page.locator('.workbench-priority')).toContainText('1 条 CNAME')
  await expect(page.locator('.workbench-priority .workbench-flow-node.is-current')).toContainText('2 个')
  await expect(page.locator('.workbench-priority-hint')).toContainText('最高优先级')
  await expect(page.locator('.workbench-priority-hint')).toContainText('首个匹配生效')
  const search = page.getByLabel('搜索入口或 Pipeline')
  await search.fill('domestic')
  await expect(page.locator('.workbench-entry')).toHaveCount(1)
  await search.fill('')
  await page.getByLabel('入口 02 操作', { exact: true }).click()
  await page.getByRole('button', { name: '移到最前', exact: true }).last().click()
  const config = await downloadConfig(page)
  expect(config.pipeline_select.map((entry: { pipeline: string }) => entry.pipeline)).toEqual(['mapping', 'fallback', 'domestic'])
  expect(config.pipelines).toHaveLength(3)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})

test('检查器取消保护局部修改，关闭恢复条目焦点并保持配置草稿不变 @responsive', async ({ page }) => {
  await openWorkbench(page)
  const before = await downloadConfig(page)
  const launcher = page.getByRole('button', { name: '编辑入口 01 domestic', exact: true })
  await launcher.click()
  const inspector = page.locator('.workbench-inspector')
  await inspector.getByLabel('动作 1 上游', { exact: true }).fill('9.9.9.9:53')
  if ((page.viewportSize()?.width ?? 1440) <= 860) {
    const label = await inspector.locator('.action-field').filter({ has: page.getByLabel('动作 1 上游', { exact: true }) }).locator('span').first().boundingBox()
    const input = await inspector.getByLabel('动作 1 上游', { exact: true }).boundingBox()
    expect(label!.x + label!.width).toBeLessThanOrEqual(input!.x)
    expect(label!.y).toBeGreaterThanOrEqual(input!.y)
    expect(label!.y + label!.height).toBeLessThanOrEqual(input!.y + input!.height)
  }
  await expect(page.getByRole('button', { name: '保存并热加载', exact: true, includeHidden: true })).toBeDisabled()
  await inspector.getByRole('button', { name: '取消', exact: true }).click()
  await cancelConfirm(page)
  await expect(inspector.getByLabel('动作 1 上游', { exact: true })).toHaveValue('9.9.9.9:53')
  await page.keyboard.press('Escape')
  await acceptConfirm(page)
  await expect(launcher).toBeFocused()
  expect(await downloadConfig(page)).toEqual(before)
})

test('应用到草稿后才改写同一配置，设置与 JSON 可往返', async ({ page }) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: '编辑入口 01 domestic', exact: true }).click()
  const inspector = page.locator('.workbench-inspector')
  await inspector.getByLabel('动作 1 上游', { exact: true }).fill('9.9.9.9:53')
  await inspector.getByRole('button', { name: '应用到草稿', exact: true }).click()
  await expect(page.locator('.toast').filter({ hasText: '入口修改已应用到草稿' })).toBeVisible()
  await expect(page.getByRole('button', { name: '保存并热加载', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '基础设置', exact: true }).click()
  await expect(page.locator('.settings-grid')).not.toHaveCount(0)
  await expect(page.locator('.pipeline-block')).toHaveCount(0)
  await page.getByRole('tab', { name: 'JSON', exact: true }).click()
  const result = await downloadConfig(page)
  expect(result.pipelines.find((pipeline: { id: string }) => pipeline.id === 'domestic').rules[0].actions[0].upstream).toBe('9.9.9.9:53')
  await page.getByRole('button', { name: '解析编排', exact: true }).click()
  await expect(page.locator('.workbench-entry')).toHaveCount(2)
  await expect(page.locator('.workbench-priority')).toContainText('1 条 CNAME')
})

test('未应用的入口修改在导航、模式切换和重新读取时可保留 @responsive', async ({ page }, testInfo) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: '编辑入口 01 domestic', exact: true }).click()
  const inspector = page.locator('.workbench-inspector')
  await inspector.getByLabel('动作 1 上游', { exact: true }).fill('9.9.9.9:53')
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('link', { name: 'KixDNS 首页', exact: true }).click()
    await cancelConfirm(page)
    await expect(page).toHaveURL(/\/config$/)
    await expect(inspector.getByLabel('动作 1 上游', { exact: true })).toHaveValue('9.9.9.9:53')
    return
  }
  await page.getByRole('tab', { name: 'JSON', exact: true }).click()
  await cancelConfirm(page)
  await expect(inspector.getByLabel('动作 1 上游', { exact: true })).toHaveValue('9.9.9.9:53')
  await page.getByTitle('重新读取配置', { exact: true }).click()
  await cancelConfirm(page)
  await expect(inspector.getByLabel('动作 1 上游', { exact: true })).toHaveValue('9.9.9.9:53')
})

test('导入可撤销，失败的提示不会自己溜走', async ({ page }) => {
  await openWorkbench(page)
  await expect(page.locator('.workbench-entry')).toHaveCount(2)

  // 导入整份替换草稿，所以那条提示右侧是撤销而不是叉。
  // 草稿此时已是脏的，配置页自己的放弃确认会先拦一道。
  const imported = { ...configFixture, pipeline_select: [configFixture.pipeline_select[1]] }
  await page.locator('input[type=file]').setInputFiles({
    name: 'replace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)),
  })
  await acceptConfirm(page)
  await expect(page.locator('.workbench-entry')).toHaveCount(1)
  // openWorkbench 的那次导入也留了一条撤销（窗口 8 秒），所以取最新那条。
  const undo = page.locator('.toast-undo').last()
  await expect(undo).toBeVisible()
  await undo.click()
  await expect(page.locator('.workbench-entry')).toHaveCount(2)

  // 失败的提示不自动消失：一条没人看见就溜走的错误等于没报过。
  await page.locator('input[type=file]').setInputFiles({
    name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{ not json'),
  })
  await acceptConfirm(page)
  const failure = page.locator('.toast--error')
  await expect(failure).toBeVisible()
  await page.waitForTimeout(6000)
  await expect(failure).toBeVisible()
  // 同一时刻成功提示早已自己消失，只剩这条错误。
  await expect(page.locator('.toast--success')).toHaveCount(0)
})
