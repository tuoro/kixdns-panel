import { expect, test, type Page } from '@playwright/test'

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
  await page.locator('.solution-section__actions').getByRole('button', { name: '自由编辑', exact: true }).click()
  await expect(page.getByRole('heading', { name: '快捷编辑' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '返回快捷编辑' })).toBeVisible()
}

test('首次未启动时保留完整概览布局', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-empty-first-install', 'true'))
  await open(page, '/')

  await expect(page.getByText('KixDNS 未启动', { exact: true })).toBeVisible()
  await expect(page.getByText('数据可能已过期')).toHaveCount(0)
  await expect(page.locator('.metric')).toHaveCount(4)
  await expect(page.locator('.metric').first().getByText('0', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Pipeline 命中' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '运行时配置' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '客户端排行' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '请求域名排行' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '上游请求' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '规则命中' })).toBeVisible()
  await expect(page.getByRole('button', { name: '清空内部缓存' })).toBeDisabled()
})

test('首次未启动时保存配置会标记为待应用', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-empty-first-install', 'true'))
  await open(page, '/config')

  await expect(page.getByText('KixDNS 未启动，无法确认当前 KixDNS 配置能力')).toBeVisible()
  await page.locator('.settings-grid .setting-field input').first().fill('0.0.0.0:54')
  await page.getByRole('button', { name: '保存为待应用' }).click()

  await expect(page.locator('.toast--info').filter({ hasText: '待应用' })).toBeVisible()
  await expect(page.getByText('配置已保存，当前处于待应用状态')).toBeVisible()
  await expect(page.locator('.history-item--pending')).toHaveCount(1)

  // 待应用候选存在时，删除历史版本仍应使用候选 SHA 完成并发校验。
  const history = page.locator('.history-list')
  page.once('dialog', (dialog) => dialog.accept())
  await history.getByTitle('删除此版本').first().click()
  await expect(page.locator('.toast--success').filter({ hasText: '已删除' })).toBeVisible()
  await expect(history.locator('article')).toHaveCount(4)
  await expect(page.locator('.history-item--pending')).toHaveCount(0)
  await expect(page.getByText('KixDNS 未启动', { exact: true })).toBeVisible()
})

test('配置历史支持差异、恢复和受保护删除', async ({ page }) => {
  await open(page, '/config')
  const history = page.locator('.history-list')
  await expect(history.locator('article')).toHaveCount(4)

  await history.getByTitle('比较此版本').first().click()
  const diff = page.locator('.config-diff-dialog')
  await expect(diff).toBeVisible()
  await expect(diff.getByText(/处差异/)).toBeVisible()
  await diff.getByRole('button', { name: '关闭', exact: true }).click()

  page.once('dialog', (dialog) => dialog.accept())
  await history.getByTitle('恢复此版本').first().click()
  await expect(page.locator('.toast--success')).toContainText('已恢复')
  await expect(history.locator('article')).toHaveCount(5)
  await expect(history.locator('.history-item--current').getByTitle('删除此版本')).toHaveCount(0)

  page.once('dialog', (dialog) => dialog.accept())
  await history.getByTitle('删除此版本').first().click()
  await expect(page.locator('.toast--success').filter({ hasText: '已删除' })).toBeVisible()
  await expect(history.locator('article')).toHaveCount(4)
})

test('Geo 维护结果离开页面后销毁', async ({ page }) => {
  await open(page, '/config')
  const geo = page.locator('.geo-data-section')
  await geo.scrollIntoViewIfNeeded()
  await geo.locator('.geo-schedule-control select').selectOption('24')
  await expect(geo.locator('.geo-schedule-control select')).toHaveValue('24')
  await geo.getByRole('button', { name: '清理未引用的 Geo 文件' }).click()
  await expect(geo.locator('.geo-data-success')).toContainText('已清理')

  await page.goto('/logs')
  await page.goto('/config')
  await expect(page.locator('.geo-data-success')).toHaveCount(0)
})

test('默认用完整方案创建并保留自由编辑入口', async ({ page }) => {
  await open(page, '/config')
  await expect(page.getByRole('heading', { name: '快捷编辑' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '分流规则' })).toHaveCount(0)

  const before = await page.locator('.solution-card').count()
  await page.getByRole('button', { name: '一键添加方案', exact: true }).click()
  const guide = page.getByRole('dialog', { name: '一键添加 DNS 方案' })
  await guide.getByRole('button', { name: /指定域名上游/ }).click()
  await guide.getByLabel('条件 1 值').fill('example.net')
  await guide.getByLabel('动作 1 上游').fill('9.9.9.9:53')
  await expect(guide.locator('.solution-guide__preview').first()).toContainText('example.net')
  await guide.getByRole('button', { name: '创建方案', exact: true }).click()

  await expect(page.locator('.solution-card')).toHaveCount(before + 1)
  const created = page.locator('.solution-card').filter({ hasText: 'example.net' })
  await expect(created).toContainText('9.9.9.9:53')
  await created.getByRole('button', { name: '一键编辑' }).click()
  await expect(page.getByRole('dialog', { name: '一键编辑 DNS 方案' })).toBeVisible()
  await page.getByRole('button', { name: '关闭一键方案' }).click()

  await openManualConfig(page)
  await expect(page.getByRole('heading', { name: '分流规则' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '处理流程' })).toBeVisible()
  await page.getByRole('button', { name: '返回快捷编辑' }).click()
  await expect(page.getByRole('heading', { name: '快捷编辑' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '分流规则' })).toHaveCount(0)
})

test('域名映射方案可配置 CNAME 目标和 TTL', async ({ page }) => {
  await open(page, '/config')
  const before = await page.locator('.solution-card').count()
  await page.getByRole('button', { name: '一键添加方案', exact: true }).click()

  const guide = page.getByRole('dialog', { name: '一键添加 DNS 方案' })
  await guide.getByRole('button', { name: /域名映射/ }).click()
  await guide.getByLabel('条件 1 值').fill('alias.example')
  await guide.getByLabel('动作 1 CNAME 目标').fill('origin.example.')
  await guide.getByLabel('动作 1 CNAME TTL').fill('120')
  await expect(guide.locator('.solution-guide__preview').first()).toContainText('将域名映射到 origin.example.')
  await guide.getByRole('button', { name: '创建方案', exact: true }).click()

  await expect(page.locator('.solution-card')).toHaveCount(before + 1)
  const created = page.locator('.solution-card').filter({ hasText: 'alias.example' })
  await expect(created).toContainText('将域名映射到 origin.example.')
  await expectNoPageOverflow(page)
})

test('入口分流使用渐进式条件关系编辑', async ({ page }) => {
  await open(page, '/config')
  await openManualConfig(page)
  await page.getByRole('button', { name: '添加分流' }).click()

  const selector = page.locator('.selector-block').last()
  await selector.scrollIntoViewIfNeeded()
  await expect(selector.getByText('按顺序匹配，首个命中生效')).toBeVisible()
  await expect(selector.getByText('未添加条件，这条分流会匹配所有请求')).toBeVisible()
  await expect(selector.getByLabel(/条件关系/)).toHaveCount(0)

  await selector.getByRole('button', { name: '添加条件' }).click()
  await expect(selector.getByLabel(/条件关系/)).toHaveCount(0)
  await expect(selector.getByText('满足此条件时分流')).toBeVisible()
  await selector.getByRole('button', { name: '添加条件' }).click()
  await expect(selector.getByLabel(/条件关系/)).toHaveValue('all')
  await expect(selector.getByLabel(/逻辑运算符/)).toHaveCount(0)
  await expect(selector.getByText('所有条件均成立时分流')).toBeVisible()

  await selector.getByLabel(/条件关系/).selectOption('custom')
  await expect(selector.getByText('首个条件')).toBeVisible()
  await expect(selector.getByLabel('条件 2 逻辑运算符')).toHaveValue('and')
  await selector.getByLabel('条件 2 逻辑运算符').selectOption('and_not')
  await expect(selector.getByLabel('条件 2 逻辑运算符')).toHaveValue('and_not')

  await selector.getByLabel(/条件关系/).selectOption('any')
  await expect(selector.getByLabel(/逻辑运算符/)).toHaveCount(0)
  await expect(selector.getByText('任一条件成立时分流')).toBeVisible()
})

test('处理流程仅在多条件时显示条件关系', async ({ page }) => {
  await open(page, '/config')
  await openManualConfig(page)
  const rule = page.locator('.rule-block').first()
  await rule.scrollIntoViewIfNeeded()

  const request = rule.locator('.rule-stage').first()
  while (await request.locator('.matcher-row').count() > 1) {
    await request.locator('.matcher-row').last().getByTitle(/删除条件/).click()
  }
  await expect(request.getByLabel('请求条件关系')).toHaveCount(0)
  await expect(request.getByLabel(/逻辑运算符/)).toHaveCount(0)

  await request.getByRole('button', { name: '添加条件' }).click()
  await expect(request.getByLabel('请求条件关系')).toHaveValue('all')
  await expect(request.getByLabel(/逻辑运算符/)).toHaveCount(0)

  await request.getByLabel('请求条件关系').selectOption('custom')
  await expect(request.getByText('首个条件')).toBeVisible()
  await expect(request.getByLabel('条件 2 逻辑运算符')).toHaveValue('and')

  await request.getByLabel('请求条件关系').selectOption('any')
  await expect(request.getByLabel(/逻辑运算符/)).toHaveCount(0)
  await expect(request.getByText('任一条件成立时执行')).toBeVisible()
  await expectNoPageOverflow(page)
})

test('一键规则支持模板、组合条件、双响应分支和再次编辑', async ({ page }) => {
  await open(page, '/config')
  await openManualConfig(page)
  await page.getByRole('button', { name: '添加 Pipeline', exact: true }).click()
  const fallbackPipeline = page.locator('.pipeline-block').last()
  await fallbackPipeline.locator('summary').click()
  await fallbackPipeline.getByLabel('Pipeline ID').fill('global_doh')
  await fallbackPipeline.getByLabel('Pipeline ID').blur()

  const pipeline = page.locator('.pipeline-block').first()
  await pipeline.scrollIntoViewIfNeeded()
  await pipeline.getByRole('button', { name: '一键添加' }).click()

  const guide = page.getByRole('dialog', { name: '一键添加规则' })
  await expect(guide).toBeVisible()
  await guide.getByRole('button', { name: /异常响应回退/ }).click()
  await expect(guide.getByLabel('启用响应处理')).toBeChecked()

  const requestStep = guide.locator('.rule-guide__step').nth(1)
  await requestStep.getByRole('button', { name: '添加条件' }).click()
  await requestStep.getByLabel('条件 2 类型').selectOption('qtype')
  await requestStep.getByLabel('条件 2 QType').selectOption('AAAA')
  await requestStep.getByLabel('一键请求条件关系').selectOption('any')

  const branches = guide.locator('.rule-guide__branch')
  const success = branches.nth(0)
  await success.getByTitle('下移动作 1').click()
  await expect(success.locator('.rule-guide__warning')).toContainText('1 个动作不会执行')
  await success.getByTitle('上移动作 2').click()
  await expect(success.locator('.rule-guide__warning')).toHaveCount(0)
  const miss = branches.nth(1)
  await miss.getByRole('button', { name: '添加动作' }).click()
  await miss.getByLabel('动作 1 类型').selectOption('continue')

  await expect(guide.locator('.rule-guide__preview').first()).toContainText('GeoSite cn 或 查询类型为 AAAA')
  await expect(guide.locator('.rule-guide__preview').first()).toContainText('转发至 https://doh.pub/dns-query, https://dns.alidns.com/dns-query')
  await expect(guide.locator('.rule-guide__preview--response')).toContainText('应答 IP 属于 0.0.0.0/32')
  await expect(guide.locator('.rule-guide__preview--response')).toContainText('记录 warn 日志，然后 跳转至 Pipeline global_doh')
  await expect(guide.locator('.rule-guide__preview--miss')).toContainText('继续匹配后续规则')
  await expect(guide.locator('.rule-guide__placement')).toContainText('放在第 1 条')
  await expectNoPageOverflow(page)
  await guide.getByRole('button', { name: '创建规则' }).click()

  await expect(guide).toHaveCount(0)
  const names = pipeline.locator('.rule-block > header > input')
  await expect(names.nth(0)).toHaveValue('response-fallback')
  await expect(names.nth(1)).toHaveValue('secure-forward')
  await expect(pipeline.locator('.rule-summary').first()).toContainText('GeoSite cn')
  const created = pipeline.locator('.rule-block').first()
  await expect(created.locator('.rule-stage').first().locator('.matcher-row')).toHaveCount(2)
  await expect(created.locator('.rule-stage--response .matcher-row')).toHaveCount(3)
  const matchedActions = created.locator('.response-actions .rule-stage').first().locator('.action-row')
  await expect(matchedActions).toHaveCount(2)
  await expect(matchedActions.nth(0).getByLabel('动作 1 类型')).toHaveValue('log')
  await expect(matchedActions.nth(1).getByLabel('动作 2 类型')).toHaveValue('jump_to_pipeline')
  await expect(created.locator('.response-actions .rule-stage').nth(1).locator('.action-row')).toHaveCount(1)

  await created.getByRole('button', { name: '一键编辑规则 response-fallback' }).click()
  const editGuide = page.getByRole('dialog', { name: '一键编辑规则' })
  await editGuide.getByLabel('一键规则名称').fill('cn-doh-fallback')
  await expect(editGuide.getByLabel('一键请求条件关系')).toHaveValue('any')
  await expect(editGuide.locator('.rule-guide__branch').nth(1).getByLabel('动作 1 类型')).toHaveValue('continue')
  await editGuide.getByRole('button', { name: '保存规则' }).click()
  await expect(names.nth(0)).toHaveValue('cn-doh-fallback')
  await expect(names.nth(1)).toHaveValue('secure-forward')
  await expectNoPageOverflow(page)
})

test('规则支持单条和当前 Pipeline 批量收起展开', async ({ page }) => {
  await open(page, '/config')
  await openManualConfig(page)
  const pipeline = page.locator('.pipeline-block').first()
  const rule = pipeline.locator('.rule-block').first()
  await pipeline.scrollIntoViewIfNeeded()

  await expect(rule.locator('.rule-stage')).not.toHaveCount(0)
  await rule.getByRole('button', { name: '收起规则 secure-forward' }).click()
  await expect(rule.locator('.rule-stage')).toHaveCount(0)
  await expect(rule.locator('.rule-summary')).toBeVisible()
  await rule.getByRole('button', { name: '展开规则 secure-forward' }).click()
  await expect(rule.locator('.rule-stage')).not.toHaveCount(0)

  await pipeline.getByRole('button', { name: '全部收起' }).click()
  await expect(pipeline.locator('.rule-stage')).toHaveCount(0)
  await pipeline.getByRole('button', { name: '全部展开' }).click()
  await expect(pipeline.locator('.rule-stage')).not.toHaveCount(0)
  await expectNoPageOverflow(page)
})

test('规则显示控制流并提示被前方兜底规则遮挡', async ({ page }) => {
  await open(page, '/config')
  await openManualConfig(page)
  const pipeline = page.locator('.pipeline-block').first()
  await pipeline.scrollIntoViewIfNeeded()

  const fallback = pipeline.locator('.rule-block').first()
  await expect(fallback.locator('.rule-flow')).toHaveText('在此终止')

  await pipeline.getByRole('button', { name: '手动添加' }).click()
  const specific = pipeline.locator('.rule-block').nth(1)
  await specific.locator('header input').fill('specific')
  await expect(specific.locator('.rule-flow')).toHaveText('继续后续规则')
  await expect(specific.locator('.rule-order-warning')).toContainText('前面的 #1“secure-forward”匹配任意请求并终止')

  await specific.getByRole('button', { name: '置顶规则 specific' }).click()
  await expect(pipeline.locator('.rule-order-warning')).toHaveCount(0)
  await expectNoPageOverflow(page)
})

test('规则支持在当前 Pipeline 内快捷调整执行顺序', async ({ page }) => {
  await open(page, '/config')
  await openManualConfig(page)
  const pipeline = page.locator('.pipeline-block').first()
  await pipeline.scrollIntoViewIfNeeded()
  await expect(pipeline.locator('.rule-summary').first()).toContainText(/当\s*任意请求/)
  await expect(pipeline.locator('.rule-summary').first()).toContainText(/执行\s*转发至 1\.1\.1\.1:53（UDP）/)

  await pipeline.getByRole('button', { name: '手动添加' }).click()
  await pipeline.getByRole('button', { name: '手动添加' }).click()

  const names = pipeline.locator('.rule-block > header > input')
  await names.nth(1).fill('second')
  await names.nth(2).fill('third')

  await pipeline.getByRole('button', { name: '上移规则 third' }).click()
  await expect.poll(() => names.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)))
    .toEqual(['secure-forward', 'third', 'second'])

  await pipeline.getByRole('button', { name: '置顶规则 second' }).click()
  await expect.poll(() => names.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)))
    .toEqual(['second', 'secure-forward', 'third'])
  await expect(pipeline.getByRole('button', { name: '上移规则 second' })).toBeDisabled()
  await expect(pipeline.getByRole('button', { name: '下移规则 third' })).toBeDisabled()
  await expectNoPageOverflow(page)
})

test('转发动作支持不写入协议的自动传输模式', async ({ page }) => {
  await open(page, '/config')
  await openManualConfig(page)
  const transport = page.getByLabel(/动作 \d+ 传输协议/).first()
  await expect(transport.locator('option[value=""]')).toHaveText('自动（按上游）')
  await transport.selectOption('')
  await expect(transport).toHaveValue('')
})

test('增强版本可安装、切换并删除非活动库存', async ({ page }) => {
  await open(page, '/system')
  const panel = page.locator('.version-panel')
  await expect(panel.locator('.remote-versions .version-row')).not.toHaveCount(0)
  await panel.locator('.remote-versions .version-row').first().getByRole('button', { name: '安装并启用' }).click()
  await expect(page.locator('.toast--success').filter({ hasText: '已安装' })).toBeVisible()

  await panel.getByTitle('切换到此版本').first().click()
  await expect(page.locator('.toast--success').filter({ hasText: '已切换' })).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept())
  await panel.getByRole('button', { name: '删除本地版本' }).first().click()
  await expect(page.locator('.toast--success').filter({ hasText: '已删除' })).toBeVisible()
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
  await page.locator('.log-toolbar select').selectOption('config.')
  await expect(page.locator('.audit-line')).toHaveCount(3)
  await page.getByLabel('筛选操作审计').fill('schedule')
  await expect(page.locator('.audit-line')).toHaveCount(1)
  await expect(page.locator('.audit-line')).toContainText('config.geo_data.schedule.apply')
})

test('主页面不会产生视口级横向溢出', async ({ page }) => {
  for (const path of ['/', '/config', '/logs', '/diagnostics', '/system']) {
    await open(page, path)
    await expectNoPageOverflow(page)
  }
})
