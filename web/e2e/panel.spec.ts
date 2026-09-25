import { expect, test, type Page } from '@playwright/test'
import { acceptConfirm } from './confirm'

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
  await page.locator('.workbench-list-footer').getByRole('button', { name: '自由编辑', exact: true }).click()
  await expect(page.getByRole('region', { name: '解析编排工作台', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '返回解析编排' })).toBeVisible()
}

test('首次未启动时保留完整概览布局', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-empty-first-install', 'true'))
  await open(page, '/')

  await expect(page.getByText('KixDNS 未启动', { exact: true })).toBeVisible()
  await expect(page.getByText('数据可能已过期')).toHaveCount(0)
  await expect(page.locator('.overview-total-value')).toHaveText('0')
  await expect(page.getByRole('heading', { name: '请求分布' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '当前运行配置' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '上游台账' })).toBeVisible()
  await expect(page.getByRole('button', { name: '清空内部缓存' })).toBeDisabled()
  await page.getByRole('tab', { name: '查询排行', exact: true }).click()
  await expect(page.getByRole('heading', { name: '客户端排行' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '请求域名排行' })).toBeVisible()
  await page.getByRole('tab', { name: '规则命中', exact: true }).click()
  await expect(page.getByRole('heading', { name: '规则命中' })).toBeVisible()
})

test('首次未启动时保存配置会标记为待应用', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-empty-first-install', 'true'))
  await open(page, '/config')

  await expect(page.getByText('KixDNS 未启动，无法确认当前 KixDNS 配置能力')).toBeVisible()
  await page.getByRole('button', { name: '基础设置', exact: true }).click()
  await page.locator('.settings-grid .setting-field input').first().fill('0.0.0.0:54')
  await page.getByRole('button', { name: '保存为待应用' }).click()

  await expect(page.locator('.toast--info').filter({ hasText: '待应用' })).toBeVisible()
  await expect(page.getByText('配置已保存，当前处于待应用状态')).toBeVisible()
  await page.getByRole('button', { name: '历史版本', exact: true }).click()
  await expect(page.locator('.history-item--pending')).toHaveCount(1)

  // 待应用候选存在时，删除历史版本仍应使用候选 SHA 完成并发校验。
  const history = page.locator('.history-list')
  await history.getByTitle('删除此版本').first().click()
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: '已删除' })).toBeVisible()
  await expect(history.locator('article')).toHaveCount(4)
  await expect(page.locator('.history-item--pending')).toHaveCount(0)
  await page.getByRole('button', { name: '关闭版本历史', exact: true }).click()
  await expect(page.locator('.document-meta').getByText('KixDNS 未启动', { exact: true })).toBeVisible()
})

test('配置历史支持差异、恢复和受保护删除', async ({ page }) => {
  await open(page, '/config')
  await page.getByRole('button', { name: '历史版本', exact: true }).click()
  const history = page.locator('.history-list')
  await expect(history.locator('article')).toHaveCount(4)

  await history.getByTitle('比较此版本').first().click()
  const diff = page.locator('.config-diff-dialog')
  await expect(diff).toBeVisible()
  await expect(diff.getByText(/处差异/)).toBeVisible()
  await diff.getByRole('button', { name: '关闭', exact: true }).click()
  // 差异框叠在版本历史上，关掉后历史仍然开着。/ The diff stacks on the history, which stays open after it closes.
  await expect(diff).toHaveCount(0)

  await history.getByTitle('恢复此版本').first().click()
  await acceptConfirm(page)
  await expect(page.locator('.toast--success')).toContainText('已恢复')
  await expect(history.locator('article')).toHaveCount(5)
  await expect(history.locator('.history-item--current').getByTitle('删除此版本')).toHaveCount(0)

  await history.getByTitle('删除此版本').first().click()
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: '已删除' })).toBeVisible()
  await expect(history.locator('article')).toHaveCount(4)
})

test('Geo 维护结果离开页面后销毁', async ({ page }) => {
  await open(page, '/config')
  await page.getByRole('button', { name: '基础设置', exact: true }).click()
  const geo = page.locator('.geo-data-section')
  await geo.scrollIntoViewIfNeeded()
  await geo.locator('.geo-schedule-control select').selectOption('24')
  await expect(geo.locator('.geo-schedule-control select')).toHaveValue('24')
  await geo.getByRole('button', { name: '清理未引用的 Geo 文件' }).click()
  await expect(geo.locator('.geo-data-success')).toContainText('已清理')

  await page.goto('/logs')
  await page.goto('/config')
  await page.getByRole('button', { name: '基础设置', exact: true }).click()
  await expect(page.locator('.geo-data-success')).toHaveCount(0)
})

test('DNS 诊断在结果顶部显示实际命中的规则 @responsive', async ({ page }) => {
  await open(page, '/diagnostics')
  await page.getByRole('button', { name: '执行查询' }).click()

  const result = page.locator('.diagnostic-result')
  // 「命中规则」现在是明细表的字段名，规则本身在对应的值里。
  await expect(result.locator('.diag-kv')).toContainText('命中规则')
  await expect(result.locator('.diagnostic-match-summary')).toContainText('geosite-global')
  await expect(result.locator('.diagnostic-match-summary')).toContainText('Pipeline · default')
  await expect(result.getByRole('heading', { name: '规则执行路径' })).toBeVisible()
  await expectNoPageOverflow(page)
})

test('默认用完整方案创建并保留自由编辑入口', async ({ page }) => {
  await open(page, '/config')
  await expect(page.getByRole('region', { name: '解析编排工作台', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '分流规则' })).toHaveCount(0)

  const before = await page.locator('.workbench-entry').count()
  await page.locator('.workbench-list-toolbar').getByRole('button', { name: '添加入口', exact: true }).click()
  const guide = page.getByRole('region', { name: '添加入口', exact: true })
  await guide.getByRole('button', { name: /指定域名上游/ }).click()
  await guide.getByLabel('条件 1 值').fill('example.net')
  await guide.getByLabel('动作 1 上游').fill('9.9.9.9:53')
  await guide.locator('.config-guide__preview > summary').click()
  await expect(guide.locator('.solution-guide__preview').first()).toContainText('example.net')
  await guide.getByRole('button', { name: '应用到草稿', exact: true }).click()

  await expect(page.locator('.workbench-entry')).toHaveCount(before + 1)
  const created = page.locator('.workbench-entry').filter({ hasText: 'example.net' })
  await expect(created).toContainText('9.9.9.9:53')
  await created.locator('.workbench-entry-select').click()
  await expect(page.locator('.workbench-guide')).toBeVisible()
  await page.getByRole('button', { name: '关闭一键方案' }).click()

  await openManualConfig(page)
  await expect(page.getByRole('heading', { name: '分流规则' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '处理流程' })).toBeVisible()
  await page.getByRole('button', { name: '返回解析编排' }).click()
  await expect(page.getByRole('region', { name: '解析编排工作台', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '分流规则' })).toHaveCount(0)
})

test('域名映射独立维护、优先序列化且不在 Pipeline 页面重复展示 @responsive', async ({ page }) => {
  await open(page, '/config')
  await page.getByRole('button', { name: '域名映射', exact: true }).click()
  await expect(page.getByText('最高优先级')).toBeVisible()
  await expect(page.getByText('命中后直接应答并跳过其他 Pipeline')).toBeVisible()

  await page.getByRole('button', { name: '添加映射' }).click()
  await page.getByLabel('映射 1 源域名').fill('alias.example')
  await page.getByLabel('映射 1 目标域名').fill('origin.example.')
  await page.getByLabel('映射 1 TTL').fill('120')
  await page.getByRole('button', { name: '添加映射' }).click()
  await page.getByLabel('映射 2 源域名').fill('alias-two.example')
  await page.getByLabel('映射 2 目标域名').fill('origin-two.example.')

  await page.getByRole('button', { name: '解析编排', exact: true }).click()
  await expect(page.locator('.workbench-entry').filter({ hasText: 'alias.example' })).toHaveCount(0)
  await page.getByRole('tab', { name: 'JSON' }).click()
  const json = await page.locator('.cm-content').innerText()
  expect(json).toContain('alias.example')
  expect(json).toContain('alias-two.example')
  expect(json.indexOf('"pipeline": "domain_mapping"')).toBeLessThan(json.indexOf('"id": "default"'))
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

test('处理流程仅在多条件时显示条件关系 @responsive', async ({ page }) => {
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

test('一键规则支持模板、组合条件、双响应分支和再次编辑 @responsive', async ({ page }) => {
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

test('规则支持单条和当前 Pipeline 批量收起展开 @responsive', async ({ page }) => {
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

test('规则显示控制流并提示被前方兜底规则遮挡 @responsive', async ({ page }) => {
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

test('规则支持在当前 Pipeline 内快捷调整执行顺序 @responsive', async ({ page }) => {
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

test('系统页按「要不要现在动手」排序，更新项压成一行 @responsive', async ({ page }) => {
  await open(page, '/system')

  // 服务状态在最上且只有一行：它回答「在不在跑」和「要不要动它」。
  const order = await page.evaluate(() => [...document.querySelectorAll('main section.panel')]
    .map((panel) => panel.className.split(' ').find((name) => name.endsWith('-panel'))))
  expect(order).toEqual(['service-panel', 'update-panel', 'runtime-panel', 'credential-panel', 'version-panel'])

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

test('增强版本可安装、切换并删除非活动库存 @responsive', async ({ page }) => {
  await open(page, '/system')
  const panel = page.locator('.version-panel')
  await expect(panel.locator('.remote-versions .version-row')).not.toHaveCount(0)
  // 切换前先确认，并按当前服务状态说清是短暂重启还是什么都不启动。
  // Every switch asks first and says, from the service state, whether DNS restarts briefly or nothing starts.
  await panel.locator('.remote-versions .version-row').first().getByRole('button', { name: '安装并切换' }).click()
  await expect(page.getByRole('alertdialog')).toContainText('DNS 解析短暂中断')
  await expect(page.getByRole('alertdialog')).toContainText('开机自启设置保持不变')
  await expectNoPageOverflow(page)
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: '已安装并通过健康检查' })).toBeVisible()

  await page.locator('.service-line').getByRole('button', { name: '停止' }).click()
  await acceptConfirm(page)
  await expect(page.locator('.service-line')).toContainText('已停止')

  await panel.getByTitle('切换到此版本').first().click()
  await expect(page.getByRole('alertdialog')).toContainText('不会启动服务')
  await acceptConfirm(page)
  await expect(page.locator('.toast--success').filter({ hasText: '服务仍停止，下次启动时生效' })).toBeVisible()
  await expect(page.locator('.service-line')).toContainText('已停止')

  await panel.getByRole('button', { name: '删除本地版本' }).first().click()
  await acceptConfirm(page)
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
