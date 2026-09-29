import { expect, test, type Page } from '@playwright/test'
import { acceptConfirm, cancelConfirm } from './confirm'

const configFixture = {
  version: '1.0',
  settings: { bind_addr: '0.0.0.0:53', default_upstream: '1.1.1.1:53' },
  pipeline_select: [
    { pipeline: 'mapping', matcher_operator: 'and', matchers: [{ type: 'domain_suffix', operator: 'and', value: 'alias.example' }] },
    { pipeline: 'domestic', matcher_operator: 'and', matchers: [{ type: 'geo_site', operator: 'and', value: 'cn' }] },
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

// 已保存的配置就是这份夹具，草稿一开始没有修改；保存之后读回演示后端存下的那份。校验和保存请求记在 __saveCalls
// The saved config is the fixture, so the draft starts unchanged; after a save, reads return what the demo backend stored.
// Validate and save requests are counted in __saveCalls
async function openSavedWorkbench(page: Page): Promise<void> {
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('saved-original')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?saved-original';
      import { apiRequest as original } from '/src/api/client.ts?saved-original';
      const fixture = ${JSON.stringify(configFixture)};
      export async function apiRequest(path, init) {
        const put = path === '/api/v1/config' && init && init.method === 'PUT';
        if (path === '/api/v1/config/validate' || put) globalThis.__saveCalls = (globalThis.__saveCalls ?? 0) + 1;
        if (put) globalThis.__saved = true;
        const result = await original(path, init);
        if (path === '/api/v1/config' && !put && !globalThis.__saved) return { ...result, content: fixture };
        return result;
      }
    ` })
  })
  await page.goto('/config')
  await expect(page.locator('.workbench-entry')).toHaveCount(2)
  await expect(page.locator('.config-savebar')).toHaveCount(0)
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
  await page.getByRole('menuitem', { name: '删除入口', exact: true }).click()
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
  // 第二个入口带条件，不是兜底，才能挪到最前（兜底入口钉在最后，见下一条用例）
  // The second entry has a condition, so it is not the catch-all and may move to the top (the catch-all stays last; see the next test)
  const movable = structuredClone(configFixture)
  movable.pipeline_select[2]!.matchers = [{ type: 'client_ip', operator: 'and', cidr: '192.168.1.0/24' }] as never
  await openWorkbench(page, movable)
  // 列表本身就是匹配顺序：域名映射钉在最前面（带条数、说明它最先匹配），下面是入口，第一个命中的生效。
  // The list is the match order: the mapping row pinned first (with its count, saying it matches first), then entries; first match wins.
  await expect(page.locator('.workbench-mapping-row')).toContainText('域名映射 · 1 条')
  await expect(page.locator('.workbench-mapping-row')).toContainText('最先匹配')
  await expect(page.locator('.workbench-entry')).toHaveCount(2)
  await expect(page.locator('.workbench-order-note')).toContainText('第一个命中的生效')
  const search = page.getByLabel('搜索入口或 Pipeline')
  await search.fill('domestic')
  await expect(page.locator('.workbench-entry')).toHaveCount(1)
  await search.fill('')
  await page.getByLabel('入口 02 操作', { exact: true }).click()
  await page.getByRole('menuitem', { name: '移到最前', exact: true }).click()
  const config = await downloadConfig(page)
  expect(config.pipeline_select.map((entry: { pipeline: string }) => entry.pipeline)).toEqual(['mapping', 'fallback', 'domestic'])
  expect(config.pipelines).toHaveLength(3)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})

test('兜底入口钉在最后：它不能往上挪，别的入口也不能挪到它下面', async ({ page }) => {
  await openWorkbench(page)
  // 入口 02 没有条件，匹配所有请求：挪到前面会让后面的入口永远命中不了
  // Entry 02 has no conditions and matches every request: moving it up would make the entries after it unreachable
  // 兜底钉在最后时，「移到最后」写成它真正去的地方：兜底前面（审计第七轮 A3）
  // With a catch-all pinned last, the move-to-last item names where it really goes: in front of the catch-all (audit round 7, A3)
  await page.getByLabel('入口 02 操作', { exact: true }).click()
  await expect(page.getByRole('menuitem', { name: '移到最后', exact: true })).toHaveCount(0)
  for (const name of ['移到最前', '上移', '下移', '移到「任意请求」前面']) await expect(page.getByRole('menuitem', { name, exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await page.getByLabel('入口 01 操作', { exact: true }).click()
  await expect(page.getByRole('menuitem', { name: '下移', exact: true })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: '移到「任意请求」前面', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('入口 01 操作', { exact: true })).toBeFocused()
})

test('检查器取消保护局部修改，关闭恢复条目焦点并保持配置草稿不变 @responsive', async ({ page }) => {
  await openWorkbench(page)
  const before = await downloadConfig(page)
  const launcher = page.getByRole('button', { name: '编辑入口 01 domestic', exact: true })
  await launcher.click()
  const inspector = page.locator('.workbench-inspector')
  const upstream = inspector.getByLabel('动作 1 上游', { exact: true })
  await upstream.fill('9.9.9.9:53')
  if ((page.viewportSize()?.width ?? 1440) <= 860) {
    // 窄容器里一条动作是一组：地址这种长值的字段名单独一行、在输入框正上方，左边对齐（规范 3.4）
    // In a narrow container an action is a group: a long value's label sits on its own line right above the input, left-aligned (spec 3.4)
    const label = await inspector.locator('.action-row .ui-rows__plabel', { hasText: '上游' }).boundingBox()
    const input = await inspector.locator('.action-row .ui-input', { has: page.getByLabel('动作 1 上游', { exact: true }) }).boundingBox()
    expect(label!.y + label!.height).toBeLessThanOrEqual(input!.y)
    expect(Math.abs(label!.x - input!.x)).toBeLessThanOrEqual(1)
  }
  // 检查器里还有没应用的修改时照样能保存：保存会先替人应用，保存栏写明这件事（规范第 11 节）；手机上编辑时保存栏收起
  // Unapplied inspector edits do not block a save: the save applies them first and the bar says so (spec section 11); on a
  // phone the bar is folded away while editing
  if ((page.viewportSize()?.width ?? 1440) > 860) {
    await expect(page.getByRole('button', { name: '保存并热加载', exact: true })).toBeEnabled()
    await expect(page.locator('.config-save-state')).toContainText('入口的修改会一起保存')
  } else {
    // 手机上面板里只有「应用到草稿」能提交，它还是主按钮 / In the phone sheet 应用到草稿 is the only way to submit, so it stays primary
    await expect(inspector.getByRole('button', { name: '应用到草稿', exact: true })).toHaveClass(/ui-btn--primary/)
  }
  // 「还原」把字段放回已应用的样子，检查器留在这个入口，底栏收起
  // 还原 puts the fields back as applied, keeps the inspector on this entry and folds the footer away
  await inspector.getByRole('button', { name: '还原', exact: true }).click()
  await expect(upstream).toHaveValue('223.5.5.5:53')
  await expect(inspector.getByRole('button', { name: '应用到草稿', exact: true })).toHaveCount(0)
  await upstream.fill('9.9.9.9:53')
  await page.keyboard.press('Escape')
  await cancelConfirm(page)
  await expect(upstream).toHaveValue('9.9.9.9:53')
  await page.keyboard.press('Escape')
  await acceptConfirm(page)
  await expect(launcher).toBeFocused()
  expect(await downloadConfig(page)).toEqual(before)
})

// 一步保存：检查器里的修改填完整了，「保存并热加载」替人应用再保存，不弹「已应用到草稿」；缺东西就停在检查器、
// 焦点落到缺的那一栏，一个请求都不发。草稿本身没改时，检查器里的修改也叫出保存栏（规范第 11 节）
// One-step save: with a complete inspector form, 保存并热加载 applies it and saves, without the 「applied to the draft」 toast;
// with a gap it stops in the inspector with focus on the missing field and sends no request. With the draft itself unchanged,
// inspector edits still bring up the save bar (spec section 11)
test('保存并热加载带上检查器里没应用的修改，没填完就停在检查器', async ({ page }) => {
  await openSavedWorkbench(page)
  await page.getByRole('button', { name: '编辑入口 01 domestic', exact: true }).click()
  const inspector = page.locator('.workbench-inspector')
  const upstream = inspector.getByLabel('动作 1 上游', { exact: true })
  const save = page.getByRole('button', { name: '保存并热加载', exact: true })
  await upstream.fill('9.9.9.9:53')
  await expect(page.locator('.config-save-state')).toContainText('已修改 1 处')
  await expect(page.locator('.config-save-state')).toContainText('入口的修改会一起保存')
  // 一屏只有一个主按钮：保存并热加载；检查器的「应用到草稿」退成次要按钮
  // One primary on screen, 保存并热加载; the inspector's 应用到草稿 steps down to a secondary button
  await expect(inspector.getByRole('button', { name: '应用到草稿', exact: true })).toHaveClass(/ui-btn--secondary/)
  expect(await page.locator('.ui-btn--primary').evaluateAll((buttons) => buttons.filter((button) => button.checkVisibility()).map((button) => button.textContent?.trim()))).toEqual(['保存并热加载'])
  // 提示在保存成功时会被收掉：从这里起记下出现过的每一条 / Notices are dismissed once the save succeeds, so record every one from here on
  await page.evaluate(() => {
    const seen: string[] = (globalThis as { __notices?: string[] }).__notices = []
    new MutationObserver(() => { for (const toast of document.querySelectorAll('.toast')) seen.push(toast.textContent ?? '') }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  await upstream.fill('')
  await save.click()
  await expect(upstream).toHaveAttribute('aria-invalid', 'true')
  await expect(upstream).toBeFocused()
  await expect(page.locator('.config-save-state')).toContainText('入口的修改会一起保存')
  expect(await page.evaluate(() => (globalThis as { __saveCalls?: number }).__saveCalls ?? 0)).toBe(0)

  await upstream.fill('9.9.9.9:53')
  await save.click()
  await expect(page.locator('.config-save-state')).toContainText('已生效')
  expect(await page.evaluate(() => (globalThis as { __notices?: string[] }).__notices!.filter((text) => text.includes('应用到草稿')))).toEqual([])
  await expect(inspector.getByRole('button', { name: '应用到草稿', exact: true })).toHaveCount(0)
  await expect(upstream).toHaveValue('9.9.9.9:53')
  const result = await downloadConfig(page)
  expect(result.pipelines.find((pipeline: { id: string }) => pipeline.id === 'domestic').rules[0].actions[0].upstream).toBe('9.9.9.9:53')
})

// 「改了几处」算上检查器里没应用的修改，按保存时真正写进去的样子数：另一个入口的修改多一处，已经改过的入口再改不多算
// 「how many changes」 counts the inspector's unapplied edits as a save would write them: another entry adds one, an entry already
// changed does not count twice
test('保存栏的「几处」算上检查器里没应用的修改', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await openSavedWorkbench(page)
  const inspector = page.locator('.workbench-inspector')
  const state = page.locator('.config-save-state')
  await page.getByRole('button', { name: '编辑入口 01 domestic', exact: true }).click()
  await inspector.getByLabel('动作 1 上游', { exact: true }).fill('9.9.9.9:53')
  await expect(state).toContainText('已修改 1 处')
  await inspector.getByRole('button', { name: '应用到草稿', exact: true }).click()
  await expect(state).toContainText('已修改 1 处')
  await expect(state).not.toContainText('入口的修改会一起保存')

  await page.getByRole('button', { name: /^编辑入口 02 / }).click()
  await inspector.getByLabel('动作 1 上游', { exact: true }).fill('8.8.8.8:53')
  await expect(state).toContainText('已修改 2 处')
  // 墨点和「几处」对得上：应用过的入口 01、检查器里正在改的入口 02 各一个
  // The dots agree with the count: one on applied entry 01, one on entry 02 being edited in the inspector
  await expect(page.locator('.workbench-entry .workbench-entry-dot')).toHaveCount(2)
  await expect(page.getByRole('button', { name: /^编辑入口 02 / })).toHaveAttribute('aria-description', '已修改')
  // 没填完也照样数：那个入口已经算一处 / An incomplete form still counts: the entry is already one change
  await inspector.getByLabel('动作 1 上游', { exact: true }).fill('')
  await expect(state).toContainText('已修改 2 处')
  await inspector.getByRole('button', { name: '还原', exact: true }).click()
  await expect(state).toContainText('已修改 1 处')
  await expect(page.locator('.workbench-entry .workbench-entry-dot')).toHaveCount(1)
  await expect(page.getByRole('button', { name: /^编辑入口 02 / })).not.toHaveAttribute('aria-description', '已修改')

  await page.getByRole('button', { name: '编辑入口 01 domestic', exact: true }).click()
  await inspector.getByLabel('动作 1 上游', { exact: true }).fill('9.9.9.10:53')
  await expect(state).toContainText('入口的修改会一起保存')
  await expect(state).toContainText('已修改 1 处')
  expect(errors).toEqual([])
})

test('应用到草稿后才改写同一配置，设置与 JSON 可往返', async ({ page }) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: '编辑入口 01 domestic', exact: true }).click()
  const inspector = page.locator('.workbench-inspector')
  await inspector.getByLabel('动作 1 上游', { exact: true }).fill('9.9.9.9:53')
  await inspector.getByRole('button', { name: '应用到草稿', exact: true }).click()
  await expect(page.locator('.toast').filter({ hasText: '入口修改已应用到草稿' })).toBeVisible()
  await expect(page.getByRole('button', { name: '保存并热加载', exact: true })).toBeEnabled()
  await page.getByRole('tab', { name: '基础设置', exact: true }).click()
  await expect(page.locator('.settings-pane .ui-setrow')).not.toHaveCount(0)
  await expect(page.locator('.manual-pipeline')).toHaveCount(0)
  await page.getByRole('button', { name: 'JSON', exact: true }).click()
  // JSON 看的是整份配置，分类页签换成「完整配置」；回到表单时还在原来那一类（审计 V6）
  // JSON shows the whole config and the section tabs give way to 完整配置; back in the form, the previous section is still selected (audit V6)
  await expect(page.getByRole('tab', { name: '解析编排', exact: true })).toHaveCount(0)
  await expect(page.locator('.config-sections--whole')).toHaveText('完整配置')
  const result = await downloadConfig(page)
  expect(result.pipelines.find((pipeline: { id: string }) => pipeline.id === 'domestic').rules[0].actions[0].upstream).toBe('9.9.9.9:53')
  await page.getByRole('button', { name: '表单', exact: true }).click()
  await expect(page.getByRole('tab', { name: '基础设置', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: '解析编排', exact: true }).click()
  await expect(page.locator('.workbench-entry')).toHaveCount(2)
  await expect(page.locator('.workbench-mapping-row')).toContainText('域名映射 · 1 条')
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
  await page.getByRole('button', { name: 'JSON', exact: true }).click()
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

test('首次安装：页头照实说未启动，没有入口时写明请求交给哪个 Pipeline @responsive', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-empty-first-install', 'true'))
  await page.goto('/config')
  // 服务停着时页头不能写「运行中」：配置里记的运行状态可能是上一次的。
  // With the service stopped the header must not say 运行中: the recorded runtime state may be stale.
  await expect(page.locator('.config-heading .ui-ph__meta')).toContainText('KixDNS 未启动')
  await expect(page.locator('.config-heading .ui-ph__meta')).not.toContainText('运行中')
  // 内核把没命中入口的请求交给第一个 Pipeline，所以 default 不是「只能被跳转进来」：列表写明请求交给它，
  // 它那一行不再重复这句，也不能写成「由规则跳转进来」。
  // The kernel sends unmatched requests to the first Pipeline, so default is not "reachable only by a jump": the
  // list says requests go to it, and its own row neither repeats that nor claims rules jump into it.
  await expect(page.locator('.workbench-fallback')).toContainText('没有入口时，请求都交给 default')
  await expect(page.locator('.workbench-orphan', { hasText: 'default' })).toContainText('1 条规则')
  await expect(page.locator('.workbench-orphan', { hasText: 'default' })).not.toContainText('由规则跳转进来')
  // 起点一直在屏幕上，工具栏里不再有第二个「添加入口」（审计第四轮 B4） / The starts are always on screen, so the toolbar has no second 添加入口 (audit round 4, B4)
  await expect(page.locator('.workbench-list-toolbar').getByRole('button', { name: '添加入口', exact: true })).toHaveCount(0)
  // 首次安装时检查器直接是起点列表，关不掉；手机上它是全屏层，照常能关（规范 3.7）
  // On first install the inspector is the start picker and cannot close; on a phone it is a full-screen layer and closes as usual (spec 3.7)
  if ((page.viewportSize()?.width ?? 1440) > 860) {
    const picker = page.getByRole('region', { name: '添加入口', exact: true })
    await expect(picker.getByRole('radio', { name: /国内外 DNS 分流/ })).toBeVisible()
    await expect(picker.getByRole('button', { name: '关闭一键方案' })).toHaveCount(0)
  } else {
    // 手机上起点直接列在列表里，和「没有入口的 Pipeline」一样先写组标题（审计第二轮 B13）
    // On a phone the starts sit in the list, titled like 没有入口的 Pipeline (audit round 2, B13)
    await expect(page.getByRole('radiogroup', { name: '添加第一个入口', exact: true }).getByRole('radio', { name: /国内外 DNS 分流/ })).toBeVisible()
  }
  await page.getByRole('button', { name: '流程', exact: true }).click()
  // 和工作台列表同一句话（审计 V17） / The same sentence as the workbench list (audit V17)
  await expect(page.locator('.flow-preview')).toContainText('没有入口时，请求都交给 default。')
  // 和列表、浏览检查器同一个说法（审计 V11） / Worded as in the list and the browse inspector (audit V11)
  await expect(page.locator('.flow-pipeline', { hasText: 'default' })).toContainText('接住其余请求')
  await expect(page.locator('.flow-pipeline', { hasText: 'default' })).not.toContainText('只能被跳转进来')
})

// 改 Pipeline ID 的时候，标题的说明还按改之前算：第一个 Pipeline 一直「接住其余请求」，不会中途变成「未被引用」（审计第五轮 C2、第六轮 C2）
// While a Pipeline ID is being typed the title's fact is worked out as before the edit: the first Pipeline keeps 接住其余请求 and never turns 未被引用 halfway (audit round 5 C2, round 6 C2)
test('自由编辑：改第一个 Pipeline 的 ID 时标题的说明不变 @responsive', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-empty-first-install', 'true'))
  await page.goto('/config')
  await page.locator('.workbench-list-toolbar').getByRole('button', { name: '自由编辑', exact: true }).click()
  const first = page.locator('.manual-pipeline').first()
  const title = first.locator('.manual-pipeline__title')
  await expect(title).toContainText(/default\s+接住其余请求/)
  const toggle = first.locator('.manual-pipeline__toggle')
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  const id = first.getByLabel('Pipeline 1 ID', { exact: true })
  await id.click()
  await id.press('End')
  await id.pressSequentially('x')
  await expect(title).toContainText(/defaultx\s+接住其余请求/)
  await id.blur()
  await expect(title).toContainText(/defaultx\s+接住其余请求/)
})

test('旧模板写成 geosite:cn 的条件：提示匹配不上，一键去掉前缀进草稿', async ({ page }) => {
  const fixture = structuredClone(configFixture)
  fixture.pipeline_select[1]!.matchers[0]!.value = 'geosite:cn'
  fixture.pipelines[2]!.rules[0]!.matchers = [{ type: 'geo_site_not', operator: 'and', value: 'GeoSite:category-ads-all' }]
  await openWorkbench(page, fixture)
  // 内核照原样查分类名，带前缀的条件永远匹配不上（#146） / The kernel looks the category up as written, so a prefixed condition never matches (#146)
  const notice = page.locator('.config-notice')
  await expect(notice).toContainText('2 个 GeoSite 条件带着 geosite: 前缀')
  await notice.getByRole('button', { name: '去掉前缀', exact: true }).click()
  await expect(notice).toHaveCount(0)
  await page.getByRole('button', { name: 'JSON', exact: true }).click()
  const result = await downloadConfig(page)
  expect(result.pipeline_select[1].matchers[0].value).toBe('cn')
  expect(result.pipelines[2].rules[0].matchers[0].value).toBe('category-ads-all')
})
