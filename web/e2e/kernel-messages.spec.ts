import { expect, type Page, test } from '@playwright/test'

// 内核报来的配置问题和提醒带着代号（声明 message_codes_v1 的内核），页面按代号说成中文：保存被拒的逐条原因、在用配置的提醒、校验通过时的提醒、
// Geo 数据的问题都不出现内核的英文原话。演示后端照真内核的样子发代号和原话（kixdns:demo-validate-reject-list、kixdns:demo-kernel-notes）
// The kernel's configuration problems and warnings carry codes (kernels declaring message_codes_v1), and the page says them in Chinese by
// the code: the reasons a save is refused for, the warnings of the config in use, the warnings of a passed validation and the Geo data
// problems all read without the kernel's English. The demo backend sends codes and words as a real kernel does
// (kixdns:demo-validate-reject-list, kixdns:demo-kernel-notes)

async function addRule(page: Page, domain: string): Promise<void> {
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  if (!(await quick.isVisible())) await page.getByRole('button', { name: '快速添加' }).click()
  await quick.fill(domain)
  await quick.press('Enter')
  await expect(page.locator('[data-rule]', { hasText: domain })).toBeVisible()
}

test('保存被内核拒收：逐条的原因按代号说成中文', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-validate-reject-list', 'true'))
  await page.goto('/config')
  await addRule(page, 'refused-in-chinese.example')
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar.locator('.ui-savebar__verdict')).toHaveText('没有通过校验')
  const reasons = bar.locator('.savebar__reasons [role="listitem"]')
  await expect(reasons).toHaveCount(3)
  await expect(reasons.nth(0)).toContainText('「域名属于」写的是「.」，对每个域名都成立')
  await expect(reasons.nth(1)).toContainText('要转到的组「gone」不存在')
  await expect(reasons.nth(2)).toContainText('设置\u00a0缓存容量：填大于 0 的整数')
  await expect(bar).not.toContainText('matches every name')
  await expect(bar).not.toContainText('KixDNS\u00a0的原话')
})

test('在用配置的提醒、校验通过时的提醒、Geo 数据的问题都说中文', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-kernel-notes', 'true'))
  await page.goto('/')
  const geo = page.locator('.kernel-notes', { hasText: 'Geo\u00a0数据有\u00a02\u00a0个问题' })
  await expect(geo).toContainText('GeoSite 文件 /var/lib/kixdns-panel/geo/geosite.dat 不存在')
  await expect(geo).toContainText('GeoSite 分类 netflix 哪个文件里都没有')
  await expect(geo).not.toContainText('does not exist')

  await page.goto('/config')
  const running = page.locator('.kernel-notes', { hasText: '在用的配置有\u00a02\u00a0条提醒' })
  await expect(running).toContainText('3000 毫秒不到上游超时（9000 毫秒）的两倍半')
  await expect(running).toContainText('跳满「跳转次数上限」就回 SERVFAIL')
  await expect(running).not.toContainText('comes back round')

  await addRule(page, 'warned-in-chinese.example')
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '校验', exact: true }).click()
  await expect(bar).toContainText('2\u00a0条提醒：照样生效，但值得知道')
  await expect(bar.locator('.savebar__reasons')).toContainText('3000 毫秒不到上游超时（9000 毫秒）的两倍半')
  await expect(bar).not.toContainText('is under 2.5 times')
})
