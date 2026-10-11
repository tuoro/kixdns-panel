import { expect, test, type Page } from '@playwright/test'

// 内核 p28 起的两项诊断能力（演示数据声明了它们）：测试域名可以指定客户端 IP、可以直接测还没保存的草稿；诊断页也能指定客户端 IP。
// The two diagnostic abilities from kernel p28 (the demo data declares them): the domain tester takes a client IP and can test the
// unsaved draft; the diagnostics page takes a client IP too.

async function openTester(page: Page): Promise<ReturnType<Page['locator']>> {
  await page.getByRole('button', { name: '测试域名', exact: true }).click()
  const tester = page.locator('.tester')
  await expect(tester).toBeVisible()
  return tester
}

test('有草稿时默认测草稿：拦截刚加的域名，结果标着「草稿」；切到正在用的就按生效配置回答 @responsive', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await page.goto('/config')
  await expect(page.locator('.cfg__panel')).toBeVisible()
  if (!mobile) await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('example.org')
  await page.getByLabel('快速添加的结果', { exact: true }).selectOption('block')
  await quick.press('Enter')
  await expect(page.locator('[data-rule]')).toHaveCount(1)
  const tester = await openTester(page)
  const target = tester.getByRole('group', { name: '测哪份配置' })
  await expect(target.getByRole('button', { name: '测草稿' })).toHaveAttribute('aria-pressed', 'true')
  await expect(tester.locator('.tester__hint').first()).toContainText('测的是还没保存的草稿')
  await tester.getByLabel('要测试的域名').fill('www.example.org')
  await tester.getByRole('button', { name: '测试', exact: true }).click()
  await expect(tester.locator('.tester__verdict')).toContainText('草稿')
  await expect(tester.locator('.tester__verdict')).toContainText('NXDOMAIN')

  await target.getByRole('button', { name: '测正在用的' }).click()
  await expect(tester.locator('.tester__hint').first()).toContainText('测的是 KixDNS 正在用的配置')
  await tester.getByRole('button', { name: '测试', exact: true }).click()
  await expect(tester.locator('.tester__verdict')).not.toContainText('草稿')
  await expect(tester.locator('.tester__verdict')).toContainText('104.18.26.120')
})

test('没有草稿时不出现切换，测的就是正在用的配置 @responsive', async ({ page }) => {
  await page.goto('/config')
  await expect(page.locator('.cfg__panel')).toBeVisible()
  const tester = await openTester(page)
  await expect(tester.getByRole('group', { name: '测哪份配置' })).toHaveCount(0)
  await expect(tester.getByLabel('客户端 IP，可以不填')).toBeVisible()
  await expect(tester.locator('.tester__hint').first()).toHaveText('测的是 KixDNS 正在用的配置。')
})

test('测试域名指定客户端 IP：路径第一步写着这个 IP；写错时不发请求、提示连到输入框 @responsive', async ({ page }) => {
  await page.goto('/config')
  await expect(page.locator('.cfg__panel')).toBeVisible()
  const tester = await openTester(page)
  await tester.getByLabel('要测试的域名').fill('www.example.com')
  const client = tester.getByLabel('客户端 IP，可以不填')
  await client.fill('192.168.1.9')
  await tester.getByRole('button', { name: '测试', exact: true }).click()
  await expect(tester.locator('.ui-step').first()).toContainText('192.168.1.9')

  await client.fill('192.168.1')
  await expect(client).toHaveAttribute('aria-invalid', 'true')
  const describedby = await client.getAttribute('aria-describedby')
  await expect(page.locator(`[id="${describedby}"]`)).toHaveText('客户端 IP 写得不对')
  // 写错时回车不发请求，结果还是上一次的 / With a bad IP, Enter sends nothing and the last result stays
  await client.press('Enter')
  await expect(tester.locator('.ui-step').first()).toContainText('192.168.1.9')
})

test('诊断页指定客户端 IP：路径第一步写着这个 IP @responsive', async ({ page }) => {
  await page.goto('/diagnostics')
  await expect(page.locator('main h1')).toBeVisible()
  await page.getByLabel('域名', { exact: true }).fill('www.example.com')
  await page.getByLabel('客户端 IP，可以不填').fill('10.8.0.3')
  await page.getByRole('button', { name: '执行查询' }).click()
  await expect(page.locator('.diag-trace .ui-step, .diag-trace li').first()).toContainText('10.8.0.3')
})
