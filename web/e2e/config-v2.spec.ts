import { expect, test } from '@playwright/test'

// 新配置页（?v2=1，③b）：读入演示配置、快速添加一条规则、在右栏（宽屏）或整页（手机）打开、保存并热加载。
// 旧配置页的用例在 config-*.spec.ts 里照跑；这一页在 ③d 成为默认前只走 ?v2=1。
// The new config page (?v2=1, ③b): load the demo config, quick-add a rule, open it in the inspector (wide) or full page (phone),
// save with hot reload. The old page's specs keep running; this page is reached only through ?v2=1 until ③d makes it the default.
test('新配置页：读入、快速添加、打开、保存并热加载 @responsive', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await page.goto('/config?v2=1')
  await expect(page.locator('main h1')).toHaveText(mobile ? '配置' : '规则')
  // 演示配置只有一条兜底转发：读成一个上游组、零条规则 / The demo config is one catch-all forward: one upstream group, no rules
  await expect(page.locator('.rcard__empty')).toBeVisible()
  await expect(page.getByText('其余请求', { exact: true })).toBeVisible()
  if (!mobile) {
    await expect(page.locator('.cfg__facts')).toContainText('运行中')
    await page.getByRole('button', { name: '快速添加' }).click()
  }
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('example.org www.example.org')
  await expect(page.locator('.qadd__hint')).toContainText('新建一条规则')
  await quick.press('Enter')
  const row = page.locator('[data-rule]').first()
  await expect(row).toContainText('example.org')
  await expect(page.locator('.cfg__savebar')).toContainText('已修改')
  // 打开：宽屏在右栏，手机整页；名字空着时占位是条件本身 / Open it: the inspector on wide screens, the full page on a phone; an unnamed rule's placeholder is its condition
  await row.locator('.rrow__main').click()
  const name = page.getByLabel('规则名称，可以不填，不填就用条件当名字')
  await expect(name).toHaveAttribute('placeholder', /example\.org/)
  await name.fill('示例站点')
  await page.getByRole('button', { name: mobile ? '完成' : '保存', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '已更新「示例站点」' })).toBeVisible()
  await expect(row).toContainText('示例站点')
  // 保存：先校验再写入，保存条说「已生效 · 版本 #N」，页头版本跟着变 / Save: validate then write; the bar says 已生效 · 版本 #N and the header version follows
  await page.getByRole('button', { name: mobile ? '保存' : '保存并热加载', exact: true }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('已生效')
  await expect(page.locator('.cfg__savebar')).toContainText('版本 #')
  if (!mobile) await expect(page.locator('.cfg__facts')).toContainText('1 条')
})

// 测试域名：问的是 KixDNS 正在用的配置（演示里诊断接口固定命中 geosite-global），结论和路径和诊断页同一种写法
// 测试域名 asks the running config (the demo diagnostics endpoint always matches geosite-global); verdict and path read as on the diagnostics page
test('新配置页：测试域名走诊断接口，命中的规则在路径里打勾 @responsive', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await page.goto('/config?v2=1')
  await expect(page.locator('main h1')).toBeVisible()
  await page.getByRole('button', { name: '测试域名', exact: true }).click()
  const tester = page.locator('.tester')
  await expect(tester).toContainText('测的是 KixDNS 正在用的配置')
  await tester.getByLabel('要测试的域名').fill('www.example.com')
  await tester.getByRole('button', { name: '测试', exact: true }).click()
  await expect(tester.locator('.tester__verdict')).toContainText('回答 104.18.26.120')
  await expect(tester.locator('.ui-step--ok')).toContainText('geosite-global')
  // 草稿一改，说明里多一句 / Once the draft changes the hint says so
  if (!mobile) await page.getByRole('button', { name: '快速添加' }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('example.org')
  await quick.press('Enter')
  await expect(tester).toContainText('草稿还没保存')
})

test('新配置页：上游组、域名映射、基础设置三页 @responsive', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  // 上游组：演示配置读成一个组；新建一个组，卡片多一张 / Upstream groups: the demo reads as one group; creating another adds a card
  await page.goto('/config?v2=1&section=upstreams')
  await expect(page.locator('.gcard')).toHaveCount(1)
  await page.getByRole('button', { name: '新建上游组', exact: true }).first().click()
  const drawer = page.locator('dialog[open]').last()
  await drawer.getByLabel('名称', { exact: true }).fill('国内')
  await drawer.getByPlaceholder(/dns-query/).first().fill('223.5.5.5')
  await drawer.getByRole('button', { name: '新建', exact: true }).click()
  await expect(page.locator('.gcard')).toHaveCount(2)
  await expect(page.locator('.cfg__savebar')).toContainText('已修改')
  // 域名映射：加一条，表里出现，类型列说会回什么记录 / Mapping: add one row, it appears with the record type it will answer
  await page.goto('/config?v2=1&section=mapping')
  await page.getByLabel('要映射的域名').fill('nas.home.arpa')
  await page.getByLabel('回答的 IP 或域名').fill('192.168.1.10')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.locator('.rw__row')).toHaveCount(1)
  await expect(page.locator('.rw__row').first()).toContainText('nas.home.arpa')
  await expect(page.locator('.rw__row').first().locator('.rw__k')).toContainText('A')
  // 基础设置：最前面一组「规则默认值」，「默认上游」由「其余请求」接管、不再单独出现 / Settings: 规则默认值 leads; 默认上游 is owned by 其余请求 and no longer listed
  await page.goto('/config?v2=1&section=settings')
  if (mobile) await page.getByRole('button', { name: /规则默认值/ }).click()
  await expect(page.getByText('拦截时怎么回应')).toBeVisible()
  await expect(page.getByText('其余请求', { exact: true })).toBeVisible()
  await expect(page.getByLabel('默认上游', { exact: true })).toHaveCount(0)
})

test('新配置页：历史版本能打开、比较和看到当前版本', async ({ page }) => {
  await page.goto('/config?v2=1')
  await expect(page.locator('main h1')).toBeVisible()
  await page.getByRole('button', { name: '更多配置操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '历史版本', exact: true }).click()
  const drawer = page.locator('.hist')
  await expect(drawer).toBeVisible()
  await expect(drawer.locator('.hist__row.is-current')).toHaveCount(1)
  const other = drawer.locator('.hist__row:not(.is-current)').first()
  await other.locator('.hist__main').click()
  await expect(page.locator('.diffd')).toBeVisible()
  await expect(page.locator('.diffd').locator('#diff-title')).toContainText('#')
})
