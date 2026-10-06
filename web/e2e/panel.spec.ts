import { expect, test, type Locator, type Page } from '@playwright/test'
import { acceptConfirm } from './confirm'

// 首次安装时起点一直在屏幕上（宽屏在检查器里，手机在列表里，点一个就带着它打开整屏层），工具栏里没有「添加入口」（审计第四轮 B4）
// On first install the starts are always on screen (in the inspector on wide screens, in the list on a phone, where a tap opens the layer
// with it chosen), and the toolbar has no 添加入口 (audit round 4, B4)
async function pickFirstStart(page: Page, name: RegExp): Promise<Locator> {
  const phone = (page.viewportSize()?.width ?? 1440) <= 860
  const starts = phone ? page.getByRole('radiogroup', { name: '添加第一个入口', exact: true }) : page.getByRole('region', { name: '添加入口', exact: true })
  await starts.getByRole('radio', { name }).click()
  return page.getByRole('region', { name: '添加入口', exact: true })
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await expect(page.locator('.app-shell')).toBeVisible()
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const sizes = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.clientWidth)
}

async function openManualConfig(page: Page): Promise<void> {
  await page.locator('.workbench-list-toolbar').getByRole('button', { name: '自由编辑', exact: true }).click()
  await expect(page.getByRole('region', { name: '解析编排工作台', exact: true })).toHaveCount(0)
  await expect(backToWorkbench(page)).toBeVisible()
}

// 自由编辑上方的位置条「← 解析编排 / 自由编辑」里回到工作台的那个按钮
// The way back to the workbench in the location bar above 自由编辑 (← 解析编排 / 自由编辑)
function backToWorkbench(page: Page) {
  return page.getByRole('navigation', { name: '位置' }).getByRole('button', { name: '解析编排', exact: true })
}

// 一键规则对话框的执行路径：宽屏在右边一栏，手机上收成底栏上方的一行，点开再看（规范 3.5）
// The rule dialog's execution path: a right column when wide, one line above the footer on a phone (spec 3.5)
async function rulePath(guide: ReturnType<Page['getByRole']>) {
  const folded = guide.locator('.config-guide__path')
  if (await folded.count()) {
    if (await folded.getAttribute('open') === null) await folded.locator('summary').click()
    return folded
  }
  return guide.locator('.config-guide__preview')
}

// 挪一条子项（动作、条件）：序号就是「调整顺序」菜单 / Move a sub-item (action, condition): its ordinal is the reorder menu
async function moveSubItem(page: Page, scope: ReturnType<Page['locator']>, label: string, direction: '上移' | '下移'): Promise<void> {
  await scope.getByLabel(label, { exact: true }).click()
  await page.getByRole('menuitem', { name: direction, exact: true }).click()
}

test('首次未启动时保留完整概览布局', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-empty-first-install', 'true'))
  await open(page, '/')

  await expect(page.getByText('KixDNS 已停止', { exact: true })).toBeVisible()
  await expect(page.getByText('数据可能已过期')).toHaveCount(0)
  await expect(page.locator('.overview-total-value')).toHaveText('—')
  await expect(page.getByRole('heading', { name: '请求分布' })).toBeVisible()
  // 没运行过：卡片叫「运行配置」，标签写「未运行」，不自相矛盾 / Never run: the card is 运行配置 with the tag 未运行, not a contradiction
  await expect(page.getByRole('heading', { name: '运行配置', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '上游状态' })).toBeVisible()
  await expect(page.getByRole('button', { name: '清空内部缓存' })).toBeDisabled()
  await page.getByRole('tab', { name: '查询排行', exact: true }).click()
  await expect(page.getByRole('heading', { name: '客户端排行' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '请求域名排行' })).toBeVisible()
  // 页签已经写了「规则命中」，下面不再重复同名标题；页签内容照样在 / The tab names 规则命中, so no repeated heading below; the panel is still there
  await page.getByRole('tab', { name: '规则命中', exact: true }).click()
  await expect(page.getByRole('tabpanel', { name: '规则命中' })).toBeVisible()
  await expect(page.getByText('还没有规则执行过', { exact: true })).toBeVisible()
})

test('首次未启动时保存配置会标记为待应用', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-empty-first-install', 'true'))
  await open(page, '/config')

  // KixDNS 没运行只写在页头；有修改时保存栏说保存后会怎样（评审 N9：不再另起一条提示）
  // A stopped KixDNS is stated in the header only; with changes the save bar says what saving will do (review N9: no extra notice)
  await expect(page.locator('.config-heading .ui-ph__meta')).toContainText('KixDNS 未启动')
  await expect(page.locator('.config-notice')).toHaveCount(0)
  await page.getByRole('tab', { name: '基础设置', exact: true }).click()
  await page.locator('.settings-pane .ui-setrow input').first().fill('0.0.0.0:54')
  // 页头已经写了未启动，保存栏只说保存之后怎样（审计 A18） / The header already says it is stopped; the save bar says only what saving does (audit A18)
  await expect(page.locator('.config-save-state')).toContainText('保存后等 KixDNS 启动再应用')
  await page.getByRole('button', { name: '保存为待应用' }).click()

  // 保存的结果写在保存栏上，不再只弹一条提示；页头写版本待应用。 / The outcome is in the save bar, not only a toast; the header says the version is pending.
  await expect(page.locator('.config-save-state')).toContainText('已存成待应用版本')
  await expect(page.locator('.config-heading .ui-ph__meta')).toContainText('待应用')
  await page.getByRole('button', { name: '历史版本', exact: true }).click()
  const history = page.locator('.config-history')
  const pendingRows = history.locator('.config-history__row').filter({ has: page.locator('.ui-tag--warn') })
  await expect(pendingRows).toHaveCount(1)

  // 待应用候选存在时，删除历史版本仍应使用候选 SHA 完成并发校验。
  await history.getByRole('button', { name: /^版本 #\d+ 操作$/ }).first().click()
  await page.getByRole('menuitem', { name: '删除这个版本', exact: true }).click()
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: '已删除' })).toBeVisible()
  await expect(history.locator('.config-history__row')).toHaveCount(4)
  await expect(pendingRows).toHaveCount(0)
  await page.getByRole('button', { name: '关闭历史版本', exact: true }).click()
  await expect(page.locator('.config-heading .ui-ph__meta').getByText('KixDNS 未启动', { exact: true })).toBeVisible()
})

test('配置历史支持差异、恢复和受保护删除', async ({ page }) => {
  await open(page, '/config')
  await page.getByRole('button', { name: '历史版本', exact: true }).click()
  const history = page.locator('.config-history')
  const rows = history.locator('.config-history__row')
  await expect(rows).toHaveCount(4)

  // 点一行就打开它和当前的比较（规范 3.8） / Clicking a row opens its comparison with the current version (spec 3.8)
  await history.getByTitle(/^比较版本 #\d+ 和当前$/).first().click()
  const diff = page.locator('.config-diff-dialog')
  await expect(diff).toBeVisible()
  await expect(diff.getByText(/处不同/)).toBeVisible()
  await diff.getByRole('button', { name: '关闭', exact: true }).click()
  // 差异框叠在版本历史上，关掉后历史仍然开着。/ The diff stacks on the history, which stays open after it closes.
  await expect(diff).toHaveCount(0)

  // 恢复和删除在行尾的「…」里；当前版本没有这个菜单，所以删不掉
  // Restore and delete live in the row's …; the current version has no such menu, so it cannot be deleted
  await history.getByRole('button', { name: /^版本 #\d+ 操作$/ }).first().click()
  await page.getByRole('menuitem', { name: '恢复为这个版本', exact: true }).click()
  await acceptConfirm(page)
  await expect(page.locator('.toast--success')).toContainText('已恢复')
  await expect(rows).toHaveCount(5)
  await expect(history.locator('.config-history__row').filter({ has: page.getByText('当前', { exact: true }) }).getByRole('button', { name: /操作$/ })).toHaveCount(0)

  await history.getByRole('button', { name: /^版本 #\d+ 操作$/ }).first().click()
  await page.getByRole('menuitem', { name: '删除这个版本', exact: true }).click()
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: '已删除' })).toBeVisible()
  await expect(rows).toHaveCount(4)
})

test('Geo 维护结果离开页面后销毁', async ({ page }) => {
  await open(page, '/config')
  await page.getByRole('tab', { name: '基础设置', exact: true }).click()
  await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: /Geo 数据/ }).click()
  const geo = page.locator('.geo')
  await geo.getByLabel('自动更新').selectOption('24')
  await expect(geo.getByLabel('自动更新')).toHaveValue('24')
  await geo.getByRole('button', { name: '清理未引用的 Geo 文件' }).click()
  await expect(geo.locator('.geo-note--ok')).toContainText('已清理')

  await page.goto('/logs')
  await page.goto('/config')
  await page.getByRole('tab', { name: '基础设置', exact: true }).click()
  await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: /Geo 数据/ }).click()
  await expect(page.locator('.geo')).toBeVisible()
  await expect(page.locator('.geo-note--ok')).toHaveCount(0)
})

test('DNS 诊断在结果顶部显示实际命中的规则 @responsive', async ({ page }) => {
  await open(page, '/diagnostics')
  await page.getByRole('button', { name: '执行查询' }).click()

  const result = page.locator('.diagnostic-result')
  // 命中的规则在执行路径里那一行，结果栏不复述。
  // The matched rule is its own row in the path; the result bar does not repeat it.
  await expect(result.locator('.diag-step', { hasText: '命中规则 geosite-global' })).toBeVisible()
  await expect(result.getByRole('heading', { name: '执行路径' })).toBeVisible()
  await expectNoPageOverflow(page)
})

test('默认用完整方案创建并保留自由编辑入口', async ({ page }) => {
  await open(page, '/config')
  await expect(page.getByRole('region', { name: '解析编排工作台', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Pipeline', exact: true })).toHaveCount(0)

  const before = await page.locator('.workbench-entry').count()
  const guide = await pickFirstStart(page, /指定域名上游/)
  await guide.getByLabel('条件 1 值').fill('example.net')
  await guide.getByLabel('动作 1 上游').fill('9.9.9.9:53')
  await guide.getByRole('button', { name: '应用到草稿', exact: true }).click()

  await expect(page.locator('.workbench-entry')).toHaveCount(before + 1)
  const created = page.locator('.workbench-entry').filter({ hasText: 'example.net' })
  await expect(created).toContainText('9.9.9.9:53')
  await created.locator('.workbench-entry-select').click()
  await expect(page.locator('.workbench-guide')).toBeVisible()
  await page.getByRole('button', { name: '关闭一键方案' }).click()

  await openManualConfig(page)
  await expect(page.getByRole('heading', { name: '入口', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Pipeline', exact: true })).toBeVisible()
  await backToWorkbench(page).click()
  await expect(page.getByRole('region', { name: '解析编排工作台', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Pipeline', exact: true })).toHaveCount(0)
})

test('域名映射独立维护、优先序列化且不在 Pipeline 页面重复展示 @responsive', async ({ page }) => {
  await open(page, '/config')
  await page.getByRole('tab', { name: '域名映射', exact: true }).click()
  // 映射表上方只说它怎么匹配；它排在所有入口前面、命中返回 CNAME，写在解析编排列表的第一行（下面查）。
  // Above the table: how a mapping matches. That mappings rank before every entry and answer with a CNAME is on the workbench list's first row (checked below).
  await expect(page.locator('.mapping-editor__order')).toContainText('源域名连同子域名一起映射')

  await page.getByRole('button', { name: '添加映射' }).click()
  await page.getByLabel('映射 1 源域名').fill('alias.example')
  await page.getByLabel('映射 1 目标域名').fill('origin.example.')
  await page.getByLabel('映射 1 TTL').fill('120')
  await page.getByRole('button', { name: '添加映射' }).click()
  await page.getByLabel('映射 2 源域名').fill('alias-two.example')
  await page.getByLabel('映射 2 目标域名').fill('origin-two.example.')

  await page.getByRole('tab', { name: '解析编排', exact: true }).click()
  await expect(page.locator('.workbench-entry').filter({ hasText: 'alias.example' })).toHaveCount(0)
  await expect(page.locator('.workbench-mapping-row')).toContainText('域名映射 · 2 条')
  await expect(page.locator('.workbench-mapping-row')).toContainText('最先匹配，命中直接返回 CNAME')
  await page.getByRole('button', { name: 'JSON', exact: true }).click()
  // 读下载的全文：编辑器只渲染看得见的几行 / Read the downloaded text: the editor renders only the visible lines
  const downloaded = page.waitForEvent('download')
  await page.getByTitle('下载 JSON', { exact: true }).click()
  const chunks: Buffer[] = []
  for await (const chunk of await (await downloaded).createReadStream()) chunks.push(chunk as Buffer)
  const json = Buffer.concat(chunks).toString('utf8')
  expect(json).toContain('alias.example')
  expect(json).toContain('alias-two.example')
  expect(json.indexOf('"pipeline": "domain_mapping"')).toBeLessThan(json.indexOf('"id": "default"'))
  await expectNoPageOverflow(page)
})

test('入口分流使用渐进式条件关系编辑', async ({ page }) => {
  await open(page, '/config')
  await openManualConfig(page)
  await page.getByRole('button', { name: '添加入口', exact: true }).click()

  const selector = page.locator('.manual-entry').last()
  await selector.scrollIntoViewIfNeeded()
  // 「按顺序匹配、第一个命中的生效」写在入口那一段的标题下，只说一次，不再每条入口重复。
  // "Matched in order, first hit wins" is stated once under the entries section title rather than under every entry.
  await expect(page.locator('.manual-section__note').first()).toHaveText('从上往下匹配，第一个命中的生效。')
  await expect(selector.getByText('没有条件时匹配所有请求，它后面的入口都到不了。')).toBeVisible()
  await expect(selector.getByLabel(/条件关系/)).toHaveCount(0)

  // 条件关系只在两个以上条件时出现（规范 3.4a） / The relation select appears only with two or more conditions (spec 3.4a)
  await selector.getByRole('button', { name: '添加条件' }).click()
  await expect(selector.getByLabel(/条件关系/)).toHaveCount(0)
  await selector.getByRole('button', { name: '添加条件' }).click()
  await expect(selector.getByLabel(/条件关系/)).toHaveValue('all')
  await expect(selector.getByLabel(/逻辑运算符/)).toHaveCount(0)

  await selector.getByLabel(/条件关系/).selectOption('custom')
  await expect(selector.getByText('首个条件')).toBeVisible()
  await expect(selector.getByLabel('条件 2 逻辑运算符')).toHaveValue('and')
  await selector.getByLabel('条件 2 逻辑运算符').selectOption('and_not')
  await expect(selector.getByLabel('条件 2 逻辑运算符')).toHaveValue('and_not')

  await selector.getByLabel(/条件关系/).selectOption('any')
  await expect(selector.getByLabel(/逻辑运算符/)).toHaveCount(0)
  await expect(selector.getByLabel(/条件关系/)).toHaveValue('any')
})

test('处理流程仅在多条件时显示条件关系 @responsive', async ({ page }) => {
  await open(page, '/config')
  await openManualConfig(page)
  const rule = page.locator('.manual-rule').first()
  await rule.scrollIntoViewIfNeeded()

  const request = rule.locator('.manual-stage').first()
  while (await request.locator('.matcher-row').count() > 1) {
    await request.locator('.matcher-row').last().getByTitle(/删除条件/).click()
  }
  await expect(request.getByLabel('请求条件关系')).toHaveCount(0)
  await expect(request.getByLabel(/逻辑运算符/)).toHaveCount(0)

  await request.getByRole('button', { name: '添加条件' }).click()
  await expect(request.getByLabel('请求条件关系')).toHaveValue('all')
  await expect(request.getByLabel(/逻辑运算符/)).toHaveCount(0)

  await request.getByLabel('请求条件关系').selectOption('custom')
  // 表格排法里第一条的运算那一格写「首个条件」；窄的时候每条是一组，运算在它自己那一行，第一条没有运算
  // In the table layout the first row's operator cell reads 首个条件; when narrow each condition is a group with its operator on its own line, and the first has none
  if ((page.viewportSize()?.width ?? 1440) > 860) await expect(request.getByText('首个条件')).toBeVisible()
  await expect(request.getByLabel('条件 1 逻辑运算符')).toHaveCount(0)
  await expect(request.getByLabel('条件 2 逻辑运算符')).toHaveValue('and')

  await request.getByLabel('请求条件关系').selectOption('any')
  await expect(request.getByLabel(/逻辑运算符/)).toHaveCount(0)
  await expect(request.getByLabel('请求条件关系')).toHaveValue('any')
  await expectNoPageOverflow(page)
})

test('一键规则支持模板、组合条件、双响应分支和再次编辑 @responsive', async ({ page }) => {
  await open(page, '/config')
  await openManualConfig(page)
  await page.getByRole('button', { name: '添加 Pipeline', exact: true }).click()
  const fallbackPipeline = page.locator('.manual-pipeline').last()
  await fallbackPipeline.locator('.manual-pipeline__toggle').click()
  await fallbackPipeline.getByLabel(/^Pipeline \d+ ID$/).fill('global_doh')
  await fallbackPipeline.getByLabel(/^Pipeline \d+ ID$/).blur()

  const pipeline = page.locator('.manual-pipeline').first()
  await pipeline.scrollIntoViewIfNeeded()
  await pipeline.getByRole('button', { name: '一键添加' }).click()

  const guide = page.getByRole('dialog', { name: '一键添加规则' })
  await expect(guide).toBeVisible()
  await guide.getByRole('radio', { name: /异常响应回退/ }).click()
  await expect(guide.getByLabel('启用响应处理')).toBeChecked()

  const requestStep = guide.locator('.rule-guide__group').filter({ has: page.getByRole('heading', { name: /匹配哪些请求/ }) })
  await requestStep.getByRole('button', { name: '添加条件' }).click()
  await requestStep.getByLabel('条件 2 类型').selectOption('qtype')
  await requestStep.getByLabel('条件 2 QType').selectOption('AAAA')
  await requestStep.getByLabel('一键请求条件关系').selectOption('any')

  // 响应处理里依次是响应条件、匹配成功、匹配失败；动作的序号就是「调整顺序」菜单
  // Response handling holds the response conditions, then on-match and on-miss actions; an action's ordinal is its reorder menu
  const response = guide.locator('.rule-guide__response')
  const success = response.locator('.action-list').nth(0)
  // 模板不替人选跳去哪：跳转目标是空的，先选上（审计第六轮 D3） / The template never picks the jump target: it starts empty, so choose it (audit round 6, D3)
  await expect(success.getByLabel('动作 2 目标 Pipeline')).toHaveValue('')
  await success.getByLabel('动作 2 目标 Pipeline').selectOption('global_doh')
  await moveSubItem(page, success, '调整动作 1 的顺序', '下移')
  await expect(response.locator('.ui-field-error')).toContainText('1 个动作不会执行')
  await moveSubItem(page, success, '调整动作 2 的顺序', '上移')
  await expect(response.locator('.ui-field-error')).toHaveCount(0)
  const miss = response.locator('.action-list').nth(1)
  await miss.getByRole('button', { name: '添加动作' }).click()
  await miss.getByLabel('动作 1 类型').selectOption('continue')

  const path = await rulePath(guide)
  await expect(path).toContainText('GeoSite cn 或 查询类型为 AAAA')
  await expect(path).toContainText('转发至 https://doh.pub/dns-query、https://dns.alidns.com/dns-query')
  await expect(path).toContainText('应答 IP 属于 0.0.0.0/32')
  await expect(path).toContainText('记录 warn 日志，然后跳转至 Pipeline global_doh')
  await expect(path).toContainText('继续匹配后续规则')
  // 一句话说完放到哪：哪个 Pipeline、第几条（审计 D6） / One line for where it goes: which Pipeline, which position (audit D6)
  await expect(path.locator('.rule-guide__placement')).toHaveText('插入到 default 第 1 条')
  await expectNoPageOverflow(page)
  await guide.getByRole('button', { name: '创建规则' }).click()

  await expect(guide).toHaveCount(0)
  const names = pipeline.locator('.manual-rule__name input')
  await expect(names.nth(0)).toHaveValue('response-fallback')
  await expect(names.nth(1)).toHaveValue('secure-forward')
  const created = pipeline.locator('.manual-rule').first()
  await expect(created.locator('.manual-stage').first().locator('.matcher-row')).toHaveCount(2)
  await expect(created.locator('.manual-stage').first()).toContainText('匹配哪些请求')
  // 有响应处理的规则，那一段是展开的（规范 3.4c） / A rule with response handling has that section open (spec 3.4c)
  const createdResponse = created.locator('.manual-response')
  await expect(createdResponse).toHaveAttribute('open', '')
  await expect(createdResponse.locator('.matcher-row')).toHaveCount(3)
  const matchedActions = createdResponse.locator('.action-list').nth(0).locator('.action-row')
  await expect(matchedActions).toHaveCount(2)
  await expect(matchedActions.nth(0).getByLabel('动作 1 类型')).toHaveValue('log')
  await expect(matchedActions.nth(1).getByLabel('动作 2 类型')).toHaveValue('jump_to_pipeline')
  await expect(createdResponse.locator('.action-list').nth(1).locator('.action-row')).toHaveCount(1)

  await created.getByLabel('规则 response-fallback 操作', { exact: true }).click()
  await page.getByRole('menuitem', { name: '一键编辑', exact: true }).click()
  const editGuide = page.getByRole('dialog', { name: '一键编辑规则' })
  await editGuide.getByLabel('一键规则名称').fill('cn-doh-fallback')
  await expect(editGuide.getByLabel('一键请求条件关系')).toHaveValue('any')
  await expect(editGuide.locator('.rule-guide__response .action-list').nth(1).getByLabel('动作 1 类型')).toHaveValue('continue')
  await editGuide.getByRole('button', { name: '保存规则' }).click()
  await expect(names.nth(0)).toHaveValue('cn-doh-fallback')
  await expect(names.nth(1)).toHaveValue('secure-forward')
  await expectNoPageOverflow(page)
})

test('规则支持单条和当前 Pipeline 批量收起展开 @responsive', async ({ page }) => {
  await open(page, '/config')
  await openManualConfig(page)
  const pipeline = page.locator('.manual-pipeline').first()
  const rule = pipeline.locator('.manual-rule').first()
  await pipeline.scrollIntoViewIfNeeded()

  await expect(rule.locator('.manual-stage')).not.toHaveCount(0)
  await rule.getByRole('button', { name: '收起规则 secure-forward' }).click()
  await expect(rule.locator('.manual-stage')).toHaveCount(0)
  // 收起时一句话代替各段 / Collapsed, one sentence stands in for the stages
  await expect(rule.locator('.manual-rule__summary')).toBeVisible()
  await rule.getByRole('button', { name: '展开规则 secure-forward' }).click()
  await expect(rule.locator('.manual-stage')).not.toHaveCount(0)
  await expect(rule.locator('.manual-rule__summary')).toHaveCount(0)

  await pipeline.getByRole('button', { name: '全部收起' }).click()
  await expect(pipeline.locator('.manual-stage')).toHaveCount(0)
  await pipeline.getByRole('button', { name: '全部展开' }).click()
  await expect(pipeline.locator('.manual-stage')).not.toHaveCount(0)
  await expectNoPageOverflow(page)
})

test('规则显示控制流并提示被前方兜底规则遮挡 @responsive', async ({ page }) => {
  await open(page, '/config')
  await openManualConfig(page)
  const pipeline = page.locator('.manual-pipeline').first()
  await pipeline.scrollIntoViewIfNeeded()

  const fallback = pipeline.locator('.manual-rule').first()
  await expect(fallback.locator('.manual-rule__flow')).toHaveText('在此终止')

  await pipeline.getByRole('button', { name: '手动添加' }).click()
  const specific = pipeline.locator('.manual-rule').nth(1)
  await specific.locator('.manual-rule__name input').fill('specific')
  await expect(specific.locator('.manual-rule__flow')).toHaveText('继续后续规则')
  await expect(specific.locator('.manual-rule__blocked')).toContainText('第 1 条「secure-forward」匹配所有请求')

  await specific.getByLabel('规则 specific 操作', { exact: true }).click()
  await page.getByRole('menuitem', { name: '移到最前', exact: true }).click()
  await expect(pipeline.locator('.manual-rule__blocked')).toHaveCount(0)
  await expectNoPageOverflow(page)
})

test('规则支持在当前 Pipeline 内快捷调整执行顺序 @responsive', async ({ page }) => {
  await open(page, '/config')
  await openManualConfig(page)
  const pipeline = page.locator('.manual-pipeline').first()
  await pipeline.scrollIntoViewIfNeeded()
  // 收起的规则用一句话说它做什么 / A collapsed rule says what it does in one sentence
  await pipeline.getByRole('button', { name: '收起规则 secure-forward' }).click()
  await expect(pipeline.locator('.manual-rule__summary').first()).toContainText('任意请求，转发至 1.1.1.1:53 (UDP)')
  await pipeline.getByRole('button', { name: '展开规则 secure-forward' }).click()

  await pipeline.getByRole('button', { name: '手动添加' }).click()
  await pipeline.getByRole('button', { name: '手动添加' }).click()

  const names = pipeline.locator('.manual-rule__name input')
  await names.nth(1).fill('second')
  await names.nth(2).fill('third')

  // 宽屏上上移下移挂在规则头上；窄屏上在「…」菜单里，给规则名字留地方
  // On wide screens up and down sit in the rule head; on narrow ones they are in the … menu, leaving room for the name
  if ((page.viewportSize()?.width ?? 1440) <= 860) {
    await pipeline.getByLabel('规则 third 操作', { exact: true }).click()
    await page.getByRole('menuitem', { name: '上移', exact: true }).click()
  } else {
    await pipeline.getByRole('button', { name: '上移规则 third' }).click()
  }
  await expect.poll(() => names.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)))
    .toEqual(['secure-forward', 'third', 'second'])

  await pipeline.getByLabel('规则 second 操作', { exact: true }).click()
  await page.getByRole('menuitem', { name: '移到最前', exact: true }).click()
  await expect.poll(() => names.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)))
    .toEqual(['second', 'secure-forward', 'third'])
  // 第一条没有上移、最后一条没有下移：占位但看不见，不是灰的（规范 2.10）
  // The first rule has no move-up and the last no move-down: kept in place but invisible, never greyed (spec 2.10)
  await expect(pipeline.getByRole('button', { name: '上移规则 second' })).toBeHidden()
  await expect(pipeline.getByRole('button', { name: '下移规则 third' })).toBeHidden()
  await expectNoPageOverflow(page)
})

test('转发动作支持不写入协议的自动传输模式', async ({ page }) => {
  await open(page, '/config')
  await openManualConfig(page)
  const transport = page.getByLabel(/动作 \d+ 传输协议/).first()
  await expect(transport.locator('option[value=""]')).toHaveText('自动识别协议')
  await transport.selectOption('')
  await expect(transport).toHaveValue('')
})

test('系统页按「要不要现在动手」排序，更新项压成一行 @responsive', async ({ page }) => {
  await open(page, '/system')

  // 服务状态在页头，只有一行：它回答「在不在跑」和「要不要动它」；后面依次是更新、安装、凭据。
  // The service state sits in the page header, one line answering whether it runs and whether to
  // touch it; updates, the installation and credentials follow in that order.
  const order = await page.evaluate(() => [...document.querySelectorAll('main .service-line, main section.ui-card')]
    .map((block) => block.className.split(' ').find((name) => name === 'service-line' || name.endsWith('-panel'))))
  expect(order).toEqual(['service-line', 'update-panel', 'runtime-panel', 'credential-panel'])
  // 这一页是看状态、偶尔操作，没有黑色主按钮；列表里每行的操作都是次要按钮。
  // A page read and occasionally acted on has no black primary button; row actions are secondary.
  await expect(page.locator('main .ui-btn--primary, main .button--primary')).toHaveCount(0)

  const line = page.locator('.service-line')
  await expect(line).toHaveCount(1)
  await expect(line).toContainText('kixdns.service')
  await expect(line).toContainText('正在运行')

  // 每项更新只保留「从哪到哪」和按钮，不再是一张带三格事实表的大卡。
  const rows = page.locator('.update-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.first().locator('.update-row__from-to')).toContainText('→')
  await expect(rows.nth(1).locator('.update-row__from-to')).toContainText('v1.0.0 → v1.0.1')
  await expect(page.locator('.update-facts')).toHaveCount(0)

  await expectNoPageOverflow(page)
})

test('内核可更新到最新并回到上一个 @responsive', async ({ page }) => {
  await open(page, '/system')
  const kernelRow = page.locator('.update-row').first()
  const runtime = page.locator('.runtime-panel')
  await expect(kernelRow.locator('.update-row__from-to')).toContainText('Run #30231271280 → Run #30235703570')
  // 更新前先确认要装哪个构建，并按当前服务状态说清是短暂重启还是什么都不启动。
  // An update first names the build and says, from the service state, whether DNS restarts briefly or nothing starts.
  await kernelRow.getByRole('button', { name: '更新', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toContainText('Run #30235703570')
  await expect(page.getByRole('alertdialog')).toContainText('DNS 解析短暂中断')
  await expect(page.getByRole('alertdialog')).toContainText('开机自启设置保持不变')
  await expectNoPageOverflow(page)
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: '内核已更新并通过健康检查' })).toBeVisible()
  await expect(kernelRow.locator('.update-row__from-to')).toContainText('已是最新')
  await expect(runtime.locator('.install-version')).toHaveText('Run #30235703570')
  await expect(runtime.locator('.ui-card__foot')).toContainText('上一个版本 Run #30231271280')

  await page.locator('.service-line').getByRole('button', { name: '停止' }).click()
  await acceptConfirm(page)
  await expect(page.locator('.service-line')).toContainText('已停止')

  await runtime.getByRole('button', { name: '回退', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toContainText('回退到 Run #30231271280')
  await expect(page.getByRole('alertdialog')).toContainText('不会启动服务')
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: '服务仍停止，下次启动时生效' })).toBeVisible()
  await expect(page.locator('.service-line')).toContainText('已停止')
  await expect(runtime.locator('.install-version')).toHaveText('Run #30231271280')
  await expect(runtime.locator('.ui-card__foot')).toContainText('上一个版本 Run #30235703570')
})

test('内核检查失败时面板更新照常提示 @responsive', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-kernel-check-failed', 'true'))
  await open(page, '/system')
  const [kernelRow, panelRow] = [page.locator('.update-row').first(), page.locator('.update-row').nth(1)]
  await expect(kernelRow.locator('.update-row__from-to')).toContainText('检查失败：GitHub 匿名 API 配额已用尽')
  await expect(kernelRow.getByRole('button')).toHaveCount(0)
  await expect(panelRow.locator('.update-row__from-to')).toContainText('v1.0.0 → v1.0.1')
  await expect(panelRow.getByRole('button', { name: '在线更新' })).toBeVisible()
  // 回退只用本机的版本，读不到远端时照样能回。 / Rollback uses only local versions, so it still works offline.
  await expect(page.locator('.runtime-panel').getByRole('button', { name: '回退', exact: true })).toBeEnabled()
  await expect(page.locator('.topbar-update .notification-badge')).toHaveText('1')
  await expectNoPageOverflow(page)
})

test('更新通知可标记已读并在刷新后保持', async ({ page }) => {
  await open(page, '/')
  const bell = page.locator('.topbar-update')
  await expect(bell.locator('.notification-badge')).toHaveText('2')
  await bell.dispatchEvent('click')
  const popover = page.locator('.notification-popover')
  await expect(popover).toBeVisible()
  await popover.getByRole('button', { name: '全部已读' }).click()
  await expect(bell.locator('.notification-badge')).toHaveCount(0)
  await expect(popover).toContainText('已全部阅读')

  await page.reload()
  await expect(bell.locator('.notification-badge')).toHaveCount(0)
})

test('操作审计可按动作筛选', async ({ page }) => {
  await open(page, '/logs')
  await page.locator('.log-view-tabs button').nth(1).click()
  await expect(page.locator('.audit-line')).toHaveCount(7)
  await page.getByRole('group', { name: '审计动作类别' }).getByRole('button', { name: '配置', exact: true }).click()
  await expect(page.locator('.audit-line')).toHaveCount(3)
  await page.getByLabel('筛选操作审计').fill('schedule')
  await expect(page.locator('.audit-line')).toHaveCount(1)
  await expect(page.locator('.audit-line')).toContainText('config.geo_data.schedule.apply')
})

test('运行日志的级别筛选由服务端执行', async ({ page }) => {
  // 分页的演示：日志共 120 行，首屏只加载 80 行，其中 5 行是警告，全部 120 行里有 8 行。
  // The paged demo: 120 lines in all, 80 loaded on the first page; 5 of those are
  // warnings, 8 of the full 120 are.
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-log-paged-slow', 'true'))
  await open(page, '/logs')
  await expect(page.locator('.log-line')).toHaveCount(80)

  // 切到「警告」后是 8 行：浏览器只过滤已加载的 80 行最多找到 5 行，多出来的 3 行只能来自服务端。
  // Warning shows 8 lines: filtering the 80 loaded lines in the browser finds at
  // most 5, so the other 3 can only have come from the server.
  await page.getByRole('group', { name: '日志级别' }).getByRole('button', { name: '警告', exact: true }).click()
  await expect(page.locator('.log-line')).toHaveCount(8)
  await expect(page.locator('.log-line--warning')).toHaveCount(8)
  await expect(page.locator('.log-line--info')).toHaveCount(0)

  await page.getByRole('group', { name: '日志级别' }).getByRole('button', { name: '全部', exact: true }).click()
  await expect(page.locator('.log-line')).toHaveCount(80)
})

test('运行日志停在顶部时直接显示新日志，读历史时攒进提示条 @responsive', async ({ page }) => {
  // mock 在这个标记下每取一次首屏就多出三行更新的日志。时钟由测试往前拨，不等真实的 5 秒。
  // Under this flag the mock adds three newer lines on every first-page fetch.
  // The test moves the clock forward instead of waiting five real seconds.
  await page.clock.install()
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-log-growing', 'true'))
  await open(page, '/logs')
  const lines = page.locator('.log-line')
  const banner = page.locator('.log-new-lines')
  await expect(lines.first()).toContainText('transport=tcp')
  // 没有实时开关了。/ There is no live switch any more.
  await expect(page.getByRole('button', { name: /实时|已暂停/ })).toHaveCount(0)
  // 滚动只在列表里发生，整页不出纵向滚动条：每行的读屏标签曾经逃出列表的裁剪，
  // 把页面撑出一大段空白。
  // Scrolling happens inside the list only, never the whole page: the per-line
  // screen-reader labels once escaped the list's clipping and stretched the page.
  expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(0)

  // 停在顶部：下一次取数直接换上，不出提示条。
  // At the top: the next fetch goes straight into the list, no banner.
  const newestAtTop = await lines.first().textContent()
  await page.clock.fastForward(5_000)
  await expect(lines.first()).not.toHaveText(newestAtTop!)
  await expect(banner).toHaveCount(0)

  // 往下读历史：下一次取数不动列表，只在上方出提示条，数目是新来的三行。
  // Reading history: the next fetch leaves the list alone and only raises the
  // banner, counting the three lines that arrived.
  await page.locator('.log-stream').evaluate((stream) => {
    stream.scrollTop = 400
    stream.dispatchEvent(new Event('scroll'))
  })
  const newestWhileReading = await lines.first().textContent()
  await page.clock.fastForward(5_000)
  await expect(banner).toHaveText('有 3 条新日志，点击显示')
  await expect(lines.first()).toHaveText(newestWhileReading!)
  await expectNoPageOverflow(page)

  // 点提示条：新日志进来，回到顶部，提示条消失。
  // Pressing the banner brings the new lines in, back at the top, and it goes away.
  await banner.click()
  await expect(banner).toHaveCount(0)
  await expect(lines.first()).not.toHaveText(newestWhileReading!)
  expect(await page.locator('.log-stream').evaluate((stream) => stream.scrollTop)).toBe(0)
})

test('unit 输出未送到 journald 时运行日志显示常驻提示 @responsive', async ({ page }) => {
  await open(page, '/logs')
  await expect(page.locator('.log-notice')).toHaveCount(0)

  await page.addInitScript(() => localStorage.setItem('kixdns:demo-log-output-redirected', 'true'))
  await open(page, '/logs')
  const notice = page.locator('.log-notice')
  // 句子由服务端拼好，页面原样展示，不在浏览器里再拼一遍。
  // The sentence is composed server-side and shown verbatim, not re-assembled in the browser.
  await expect(notice).toHaveText('这个 unit 的输出没有送到 journald（StandardOutput=append:/var/log/kixdns.log），这里只会看到 systemd 自己的启停记录')
  await expect(page.locator('.status-banner')).toHaveCount(0)
  await expectNoPageOverflow(page)

  await page.locator('.log-view-tabs button').nth(1).click()
  await expect(notice).toHaveCount(0)
})

test('切换级别后不会拿旧级别的游标翻页', async ({ page }) => {
  // mock 在这个标记下分页（120 行，每页 80）且响应慢：带 before 的 300ms，带 level 的 1500ms。
  // 顺序：翻页（全部）在飞 → 切到警告 → 旧翻页落地被丢弃 → 滚到底。修复前这一滚会拿着
  // 「全部」的游标 79 去请求警告级别，落地时把 79 之后的三行警告再追加一遍：8 行变 11 行。
  // Under this flag the mock pages (120 lines, 80 per page) and answers slowly: 300ms with
  // `before`, 1500ms with `level`. Sequence: older page (all) in flight → switch to warning →
  // the stale older page lands and is dropped → scroll to the bottom. Before the fix that
  // scroll requests the warning level with the "all" cursor 79, and when it lands the three
  // warning lines after 79 are appended again: 8 lines become 11.
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-log-paged-slow', 'true'))
  await open(page, '/logs')
  const lines = page.locator('.log-line')
  const loadMore = page.locator('.runtime-load-more')
  // 翻页走滚动处理器而不是点按钮：Playwright 点之前会把按钮滚进视口，那一滚本身就触发翻页。
  // 事件显式派发一次，不依赖视口高度够不够让流真的滚起来。
  // Page via the scroll handler, not the button: Playwright scrolls the button into view before
  // clicking and that scroll already triggers a page. Dispatch the event explicitly so the test
  // does not depend on the viewport being short enough for the stream to actually scroll.
  const scrollToBottom = () => page.locator('.log-stream').evaluate((stream) => {
    stream.scrollTop = stream.scrollHeight
    stream.dispatchEvent(new Event('scroll'))
  })
  await expect(lines).toHaveCount(80)
  await expect(loadMore).toBeEnabled()

  await scrollToBottom()
  await expect(loadMore).toContainText('正在加载')
  await page.getByRole('group', { name: '日志级别' }).getByRole('button', { name: '警告', exact: true }).click()
  // 旧翻页落地（300ms）：修复后按钮已随游标一起消失，修复前它重新可点。
  // The stale older page lands (300ms): fixed, the button is gone with the cursor; unfixed, it is clickable again.
  await expect(loadMore.filter({ hasText: '正在加载' })).toHaveCount(0)
  await scrollToBottom()

  // 警告首屏（1500ms）：120 行里 index % 17 === 0 的 8 行，一页放得下，没有游标。
  // The warning first page (1500ms): the 8 lines with index % 17 === 0 out of 120, one page, no cursor.
  await expect(lines).toHaveCount(8)
  await expect(loadMore).toHaveCount(0)
  // 等够一次带 level 的翻页（1500ms）落地的时间：修复前它会把 index 85/102/119 再追加一遍。
  // Wait long enough for a level-bearing older page (1500ms) to land: unfixed, it appends index 85/102/119 again.
  await page.waitForTimeout(1800)
  await expect(lines).toHaveCount(8)
})

test('主页面不会产生视口级横向溢出 @responsive', async ({ page }) => {
  for (const path of ['/', '/config', '/logs', '/diagnostics', '/system']) {
    await open(page, path)
    await expectNoPageOverflow(page)
  }
})
