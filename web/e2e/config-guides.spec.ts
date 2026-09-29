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

async function openConfig(page: Page): Promise<void> {
  await page.goto('/config')
  await expect(page.getByRole('region', { name: '解析编排工作台', exact: true })).toBeVisible()
}

// 一键规则对话框的执行路径：宽屏在右边一栏，手机上收成底栏上方的一行，点开再看（规范 3.5）
// The rule dialog's execution path: a right column when wide, one line above the footer on a phone (spec 3.5)
async function showPath(guide: Locator): Promise<Locator> {
  const folded = guide.locator('.config-guide__path')
  if (await folded.count()) {
    if (await folded.getAttribute('open') === null) await folded.locator('summary').click()
    return folded
  }
  return guide.locator('.config-guide__preview')
}

// 有一个入口的配置：不是首次安装，检查器可以关（首次安装时它就是起点列表，没有关闭，见 config-workbench）
// A config with one entry: not a first install, so the inspector can close (on first install it is the start picker with no close; see config-workbench)
async function importOneEntry(page: Page): Promise<void> {
  const fixture = {
    version: '1.0',
    settings: {},
    pipeline_select: [{ pipeline: 'domestic', matcher_operator: 'and', matchers: [{ type: 'geo_site', operator: 'and', value: 'cn' }] }],
    pipelines: [
      { id: 'default', rules: [{ name: 'default-rule', matchers: [], matcher_operator: 'and', actions: [{ type: 'forward', upstream: '1.1.1.1:53', transport: 'udp' }] }] },
      { id: 'domestic', rules: [{ name: 'domestic-rule', matchers: [], matcher_operator: 'and', actions: [{ type: 'forward', upstream: '223.5.5.5:53', transport: '' }] }] },
    ],
  }
  await page.locator('input[type=file]').setInputFiles({ name: 'one-entry.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) })
  await expect(page.locator('.workbench-entry')).toHaveCount(1)
}

async function downloadConfig(page: Page) {
  const downloaded = page.waitForEvent('download')
  await page.getByTitle('下载 JSON', { exact: true }).click()
  const stream = await (await downloaded).createReadStream()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

test('入口编辑保留提交区，字段错误可见，取消后恢复焦点 @responsive', async ({ page }, testInfo) => {
  await openConfig(page)
  await importOneEntry(page)
  const launcher = page.locator('.workbench-list-toolbar').getByRole('button', { name: '添加入口', exact: true })
  await launcher.click()
  const guide = page.getByRole('region', { name: '添加入口', exact: true })
  // 起点先不选（规范 3.6）；选了以后列表收成一行，写着插在哪（规范 4.4 的事实）
  // Nothing is chosen at first (spec 3.6); once chosen the list folds into one line and the placement is stated (a fact, spec 4.4)
  await guide.getByRole('radio', { name: /指定域名上游/ }).click()
  await expect(guide.locator('.ui-picked')).toContainText('指定域名上游')
  // 编号和工作台列表一样：导入的那份有 1 个入口，新的是入口 02（审计 B1） / Numbered as the workbench list: the import holds one entry, so the new one is 入口 02 (audit B1)
  await expect(guide.locator('.solution-guide__note')).toHaveText('放在最后，成为入口 02')
  await guide.getByLabel('条件 1 值', { exact: true }).fill('interactive.example')
  // 流程设置添加时默认收着，标题上写着 Pipeline ID（审计 B7）；打开它改规则名称
  // 流程设置 starts folded when adding, its title showing the Pipeline ID (audit B7); open it to edit the rule name
  const flow = guide.locator('.workbench-flow-settings')
  await expect(flow).not.toHaveAttribute('open')
  await flow.locator('summary').click()
  const name = guide.getByLabel('方案规则名称')
  await name.fill('')
  // 主按钮一直能按：有缺项时底栏写「还差 N 项」，按下去标出缺的字段、焦点落上去，不写进草稿（规范 8.4）
  // The primary button always works: with something missing the footer says 还差 N 项, and pressing it marks the field and focuses it without touching the draft (spec 8.4)
  await expect(guide.locator('.solution-guide__missing')).toContainText('还差 1 项')
  await expect(guide.locator('.config-guide__footer')).toBeInViewport()
  await guide.getByRole('button', { name: '应用到草稿', exact: true }).click()
  await expect(name).toHaveAttribute('aria-invalid', 'true')
  await expect(name).toBeFocused()
  await expect(guide.locator('.ui-field-error')).toContainText('请填写规则名称')
  await expect(guide).toBeVisible()
  await guide.locator('.config-guide__editor').evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(guide.locator('.config-guide__footer')).toBeInViewport()

  await name.fill('interactive-rule')
  await expect(name).not.toHaveAttribute('aria-invalid', 'true')
  await expect(guide.locator('.solution-guide__missing')).toHaveCount(0)
  await expect(guide.getByRole('button', { name: '应用到草稿', exact: true })).toBeEnabled()
  await guide.getByRole('button', { name: '关闭一键方案' }).focus()
  await page.keyboard.press('Shift+Tab')
  if (testInfo.project.name === 'mobile') expect(await guide.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  await guide.getByRole('button', { name: '关闭一键方案' }).focus()
  await page.keyboard.press('Escape')
  await acceptConfirm(page)
  await expect(guide).toHaveCount(0)
  await expect(launcher).toBeFocused()
  // 取消的入口没有写进草稿：还是只有导入的那一个入口 / The cancelled entry never reached the draft: only the imported entry remains
  await expect(page.locator('.workbench-entry')).toHaveCount(1)
  await expect(page.locator('.workbench-entry')).not.toContainText('interactive.example')
})

test('批量方案分别保留响应开关，关闭后忽略隐藏错误且提交内容一致', async ({ page }) => {
  await openConfig(page)
  const guide = await pickFirstStart(page, /国内外 DNS 分流/)
  const response = guide.locator('.solution-guide__response')
  const missing = guide.locator('.solution-guide__missing')
  // 两段先都放进去再数：国内解析是入口 01，全局兜底放在最后成为入口 02（审计第三轮 B1）
  // Both parts are inserted before counting: 国内解析 is entry 01 and 全局兜底 goes last as entry 02 (audit round 3, B1)
  const placement = guide.locator('.solution-guide__placement')
  await expect(placement).toHaveText('成为入口 01')
  // 响应处理添加时默认收着，标题上写着它现在的状态（审计 B13） / 响应处理 starts folded when adding, its title stating what is set (audit B13)
  await expect(guide.locator('.solution-guide__advanced')).not.toHaveAttribute('open')
  await expect(guide.locator('.solution-guide__advanced > summary')).toContainText('3 个条件')
  await guide.locator('.solution-guide__advanced > summary').click()
  await response.getByLabel('条件 1 CIDR', { exact: true }).fill('')
  await expect(missing).toBeVisible()
  await guide.getByLabel('启用方案响应处理').uncheck()
  await guide.getByRole('button', { name: '全局兜底', exact: true }).click()
  // 起点那一行已经说了它放在最后，「没有条件时…」那句不再重复 / The start line already says it goes last, so the 没有条件时 note does not repeat it
  await expect(placement).toHaveText('放在最后，成为入口 02')
  await expect(guide.getByText(/没有条件时匹配所有请求/)).toHaveCount(0)
  await guide.getByRole('button', { name: '添加条件', exact: true }).click()
  await guide.getByLabel('条件 1 类型').selectOption('domain_suffix')
  await guide.getByLabel('条件 1 值').fill('global.example')
  await guide.getByRole('button', { name: '国内解析', exact: true }).click()
  // 回到国内解析，响应处理还是刚才打开的样子，开关还是关着的 / Back on 国内解析 the response group is still open as left, its switch still off
  await expect(guide.locator('.solution-guide__advanced')).toHaveAttribute('open', '')
  await expect(guide.getByLabel('启用方案响应处理')).not.toBeChecked()
  await guide.getByLabel('启用方案响应处理').check()
  await expect(response.getByLabel('条件 1 CIDR', { exact: true })).toHaveValue('')
  await expect(missing).toBeVisible()
  // 关掉响应处理，藏起来的那一格不再算缺项 / With response handling off, the hidden field no longer counts as missing
  await guide.getByLabel('启用方案响应处理').uncheck()
  await expect(missing).toHaveCount(0)
  // 两个入口也叫「应用到草稿」：放置那两句已经说了会加两个（审计第五轮 B2） / Two entries are still 应用到草稿: the placement lines already say two are added (audit round 5, B2)
  await guide.getByRole('button', { name: '应用到草稿', exact: true }).click()
  await expect(guide).toHaveCount(0)

  await page.getByRole('button', { name: 'JSON', exact: true }).click()
  const config = await downloadConfig(page)
  const domestic = config.pipelines.find((pipeline: { id: string }) => pipeline.id === 'cn_doh').rules[0]
  expect(domestic.response_matchers ?? []).toEqual([])
  expect(domestic.response_actions_on_match ?? []).toEqual([])
  expect(domestic.response_actions_on_miss ?? []).toEqual([])
  expect(config.pipeline_select.map((selector: { pipeline: string }) => selector.pipeline).slice(0, 2)).toEqual(['cn_doh', 'global_doh'])
})

test('已有兜底入口时，国内外分流只建国内解析，由它继续兜底 @responsive', async ({ page }) => {
  await openConfig(page)
  // 一个国内入口加一个接住所有请求的入口 / One domestic entry plus one that catches every request
  const fixture = {
    version: '1.0',
    settings: {},
    pipeline_select: [
      { pipeline: 'domestic', matcher_operator: 'and', matchers: [{ type: 'geo_site', operator: 'and', value: 'cn' }] },
      { pipeline: 'default', matcher_operator: 'and', matchers: [] },
    ],
    pipelines: [
      { id: 'default', rules: [{ name: 'default-rule', matchers: [], matcher_operator: 'and', actions: [{ type: 'forward', upstream: '1.1.1.1:53', transport: 'udp' }] }] },
      { id: 'domestic', rules: [{ name: 'domestic-rule', matchers: [], matcher_operator: 'and', actions: [{ type: 'forward', upstream: '223.5.5.5:53', transport: '' }] }] },
    ],
  }
  await page.locator('input[type=file]').setInputFiles({ name: 'catch-all.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) })
  await expect(page.locator('.workbench-entry')).toHaveCount(2)
  await page.locator('.workbench-list-toolbar').getByRole('button', { name: '添加入口', exact: true }).click()
  const guide = page.getByRole('region', { name: '添加入口', exact: true })
  // 起点的说明按这份配置写：只建国内解析，其余请求仍由「任意请求」兜底；用名字不用编号，选完以后编号会变（审计第三轮 B8）
  // The start's description follows this config: only 国内解析 is built, the rest still falls to 任意请求; named, not numbered, since the number shifts once picked (audit round 3, B8)
  await expect(guide.locator('.ui-pick__opt', { hasText: '国内外 DNS 分流' }).locator('small')).toHaveText('创建国内解析，其余请求仍由「任意请求」兜底')
  await guide.getByRole('radio', { name: /国内外 DNS 分流/ }).click()
  // 选中就是完整的：没有两段切换、没有「还差」，那一句写着沿用哪个入口（审计第二轮 B2、第三轮 B8）
  // Complete as picked: no two-part switch, no 还差, and the placement line names the entry it reuses (audit round 2 B2, round 3 B8)
  await expect(guide.locator('.solution-guide__tabs')).toHaveCount(0)
  await expect(guide.locator('.solution-guide__missing')).toHaveCount(0)
  await expect(guide.locator('.solution-guide__placement')).toHaveText('成为入口 02，排在「任意请求」前面，由它继续兜底')
  await guide.getByRole('button', { name: '应用到草稿', exact: true }).click()
  await expect(guide).toHaveCount(0)

  await page.getByRole('button', { name: 'JSON', exact: true }).click()
  const config = await downloadConfig(page)
  const domestic = config.pipelines.find((pipeline: { id: string }) => pipeline.id === 'cn_doh')
  expect(domestic.rules[0].response_actions_on_match.at(-1)).toEqual({ type: 'jump_to_pipeline', pipeline: 'default' })
  expect(config.pipelines.some((pipeline: { id: string }) => pipeline.id === 'global_doh')).toBe(false)
})

// 编辑时把一个入口的条件删光：它匹配所有请求，应用后挪到最后兜底；留在中间，它后面的入口都轮不到。已经有兜底时拦下（审计第三轮）
// Clearing an entry's conditions while editing: it matches every request and moves to the end on apply; left in the middle it would
// hide every entry after it. With a catch-all already there, the edit is stopped (audit round 3)
async function importEntries(page: Page, entries: Array<[string, string?]>): Promise<void> {
  const fixture = {
    version: '1.0',
    settings: {},
    pipeline_select: entries.map(([pipeline, value]) => ({ pipeline, matcher_operator: 'and', matchers: value ? [{ type: 'domain_suffix', operator: 'and', value }] : [] })),
    pipelines: entries.map(([id]) => ({ id, rules: [{ name: `${id}-rule`, matchers: [], matcher_operator: 'and', actions: [{ type: 'forward', upstream: '1.1.1.1:53', transport: 'udp' }] }] })),
  }
  await page.locator('input[type=file]').setInputFiles({ name: 'entries.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) })
  await expect(page.locator('.workbench-entry')).toHaveCount(entries.length)
}

test('编辑时删光条件的入口挪到最后兜底', async ({ page }) => {
  await openConfig(page)
  await importEntries(page, [['first', 'a.example'], ['second', 'b.example'], ['third', 'c.example']])
  const inspector = page.locator('.workbench-inspector')
  await page.getByRole('button', { name: /^编辑入口 01 / }).click()
  await inspector.getByRole('button', { name: '删除条件 1', exact: true }).click()
  await expect(inspector.getByText('没有条件时匹配所有请求，这个入口会放在最后兜底。')).toBeVisible()
  await inspector.getByRole('button', { name: '应用到草稿', exact: true }).click()
  await expect(page.locator('.workbench-entry').nth(0)).toContainText('second')
  await expect(page.locator('.workbench-entry').nth(2)).toContainText('任意请求')
  await expect(page.locator('.workbench-entry').nth(2)).toContainText('first')
})

test('已有兜底入口时，编辑也不能把别的入口的条件删光', async ({ page }) => {
  await openConfig(page)
  await importEntries(page, [['first', 'a.example'], ['rest']])
  const inspector = page.locator('.workbench-inspector')
  await page.getByRole('button', { name: /^编辑入口 01 / }).click()
  await inspector.getByRole('button', { name: '删除条件 1', exact: true }).click()
  const error = inspector.locator('.solution-guide__group-error')
  await expect(error).toHaveText('入口 02「任意请求」已经接住所有请求，这里至少要一个条件')
  await inspector.getByRole('button', { name: '应用到草稿', exact: true }).click()
  await expect(error).toHaveClass(/is-shown/)
  await expect(page.locator('.workbench-entry').nth(0)).toContainText('a.example')
})

// 两段起点里国内解析的条件删光了：两段都接住所有请求，全局兜底永远轮不到，错误写在国内解析这一段（审计第四轮 C2）
// Clearing 国内解析's condition in the two-part start makes both parts catch everything and 全局兜底 unreachable; the error goes on 国内解析 (audit round 4, C2)
test('两段起点不能两段都兜底', async ({ page }) => {
  await openConfig(page)
  await importOneEntry(page)
  // 已经有一个入口：不是首次安装，从工具栏的「添加入口」打开起点 / Not a first install (one entry exists): the toolbar's 添加入口 opens the starts
  await page.locator('.workbench-list-toolbar').getByRole('button', { name: '添加入口', exact: true }).click()
  const guide = page.getByRole('region', { name: '添加入口', exact: true })
  await guide.getByRole('radio', { name: /国内外 DNS 分流/ }).click()
  await guide.getByRole('button', { name: '删除条件 1', exact: true }).click()
  await expect(guide.locator('.solution-guide__group-error')).toHaveText('全局兜底已经接住所有请求，这里至少要一个条件')
  await expect(guide.locator('.solution-guide__missing')).toContainText('还差 1 项')
})

// 上游框里主机名放得下一行时，「://」后面不断：协议不会单独留在上一行的末尾（审计第四轮 D1、B1）
// In the upstream box a host that fits a line is never split from its scheme, so 「https://」 never ends a line on its own (audit round 4, D1, B1)
test('上游框里放得下的主机名不和协议分开 @responsive', async ({ page }) => {
  await openConfig(page)
  const phone = (page.viewportSize()?.width ?? 1440) <= 860
  const starts = phone ? page.getByRole('radiogroup', { name: '添加第一个入口', exact: true }) : page.getByRole('region', { name: '添加入口', exact: true })
  await starts.getByRole('radio', { name: /国内外 DNS 分流/ }).click()
  const upstream = page.getByLabel('动作 1 上游', { exact: true })
  await expect(upstream).toBeVisible()
  const shown = await upstream.inputValue()
  expect(shown).toContain('dns.alidns.com')
  expect(shown).not.toContain('://\u200b')
  // 两个地址的「://」后面都是不断行的连接符 / Both addresses carry a word joiner right after 「://」
  expect(shown.split('://\u2060')).toHaveLength(3)
  // 手机上一个地址一行放不下，在主机名后的「/」处断，不在 dns-query 中间断：量宽的字体要对（审计第七轮 D1、B1）
  // On a phone an address wider than the line breaks after the host's 「/」, never inside dns-query: the measuring font must be right (audit round 7, D1, B1)
  if ((page.viewportSize()?.width ?? 1440) <= 640) expect(shown).toContain('doh.pub/\u200b')
})

// 几个上游一行放不下时一行一个：只在「,」后面断，放得下一行的地址里面不断。font 简写在不做字距调整时读出来是空的，
// 拿它量宽会以为全都放得下（审计第七轮 D1、B1）
// When several upstreams do not fit one line they go one per line: breaks after 「,」 only, and an address that fits stays whole. With
// kerning off the font shorthand reads empty, and measuring with it made everything seem to fit (audit round 7, D1, B1)
test('上游框：几个地址一行放不下时一行一个，放得下的地址里面不断', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 })
  await openConfig(page)
  await page.locator('.workbench-list-toolbar').getByRole('button', { name: '自由编辑', exact: true }).click()
  await page.locator('.manual-pipeline').first().getByRole('button', { name: '一键添加', exact: true }).click()
  const guide = page.getByRole('dialog', { name: '一键添加规则' })
  await guide.getByRole('radio', { name: /异常响应回退/ }).click()
  const shown = await guide.getByLabel('动作 1 上游', { exact: true }).inputValue()
  expect(shown).toContain(',\u200b')
  expect(shown).not.toContain('com/\u200b')
  expect(shown).not.toContain('pub/\u200b')
})

test('规则关闭响应处理后可保存，再次开启仍保留未完成草稿', async ({ page }) => {
  await openConfig(page)
  await page.locator('.workbench-list-toolbar').getByRole('button', { name: '自由编辑', exact: true }).click()
  await page.locator('.manual-pipeline').first().getByRole('button', { name: '一键添加', exact: true }).click()
  const guide = page.getByRole('dialog', { name: '一键添加规则' })
  await guide.getByRole('radio', { name: /指定域名上游/ }).click()
  // 模板的域名留空，要自己填（审计第二轮 B1） / The template's domain starts empty and must be filled (audit round 2, B1)
  await guide.getByLabel('条件 1 值', { exact: true }).first().fill('switch.example')
  await guide.getByLabel('一键规则名称').fill('response-switch')
  await guide.getByLabel('响应处理设置').click()
  await guide.getByLabel('启用响应处理').check()
  const matcher = guide.locator('.rule-guide__response').getByLabel('条件 1 值', { exact: true })
  const missing = guide.locator('.rule-guide__missing')
  await matcher.fill('')
  await expect(missing).toBeVisible()
  await guide.getByLabel('启用响应处理').uncheck()
  await expect(missing).toHaveCount(0)
  // 执行路径跟着开关走：关掉响应处理，路径里就没有响应那几步 / The path follows the switch: with response handling off it has no response steps
  await expect(await showPath(guide)).not.toContainText('若响应匹配')
  await guide.getByLabel('启用响应处理').check()
  await expect(matcher).toHaveValue('')
  await guide.getByLabel('启用响应处理').uncheck()
  await guide.getByRole('button', { name: '创建规则', exact: true }).click()
  await page.getByRole('button', { name: 'JSON', exact: true }).click()
  const config = await downloadConfig(page)
  const rule = config.pipelines[0].rules.find((candidate: { name: string }) => candidate.name === 'response-switch')
  expect(rule.response_matchers ?? []).toEqual([])
  expect(rule.response_actions_on_match ?? []).toEqual([])
})
