import { expect, test, type Page } from '@playwright/test'

// 只在 KixDNS 启动时读取的设置：改了照常保存、重载，但要重启才生效。保存后配置页的提示条说清是哪些，就地重启；表单里不提重启
// （改过的每一项、整组的标题下都挂一句太吵）
// Settings KixDNS reads only at startup: a change saves and reloads as usual but takes a restart. After the save the config page's
// notice says which and restarts in place; the form itself says nothing about restarts (a line under every edit or group title was noise)

async function openGroup(page: Page, group: string): Promise<void> {
  await page.goto('/config?section=settings')
  await page.getByRole('button', { name: new RegExp(group) }).locator('visible=true').first().click()
  await expect(page.getByRole('heading', { name: group, exact: true })).toBeVisible()
}

test('改了监听地址：保存后提示要重启，就地重启以后提示消失 @responsive', async ({ page }) => {
  await openGroup(page, '基础与监听')
  await page.getByLabel('UDP 监听地址', { exact: true }).fill('0.0.0.0:5300')
  // 改过的单项下面不挂「重启后生效」：每一项都挂一句太吵，保存后提示条会说 / No restart note under the edited setting: one under
  // every edit was noise, and the notice says it after the save
  await expect(page.getByText('重启 KixDNS 后生效', { exact: true })).toHaveCount(0)

  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  const notice = page.locator('.cfg__notice')
  await expect(notice).toContainText(/改过的设置要重启 KixDNS\s才生效：UDP\s监听地址。/)
  // 保存条不说「已生效」：上面刚说了要重启 / The save bar does not say 已生效 right under a notice saying a restart is due
  // 手机上提示条常在视口外：保存条带上「待重启」 / On a phone the notice is often off screen: the save bar carries 待重启
  await expect(page.locator('.cfg__savebar')).toContainText(/已应用\s·\s版本 #\d+\s·\s待重启/)
  await expect(page.locator('.cfg__savebar')).not.toContainText('已生效')
  await expect(page.getByText('重启 KixDNS 后生效', { exact: true })).toHaveCount(0)

  await notice.getByRole('button', { name: '重启 KixDNS', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText(/重启后生效的设置：UDP\s监听地址。/)
  await confirm.getByRole('button', { name: '重启服务', exact: true }).click()
  await expect(page.getByText('KixDNS 服务已重启')).toBeVisible()
  await expect(notice).toHaveCount(0)
  // 「已应用」随之退下，不等它自己停满三秒 / 已应用 goes with it, without waiting out its three seconds
  await expect(page.locator('.cfg__savebar', { hasText: '已应用' })).toHaveCount(0, { timeout: 1000 })
})

test('表单里不提重启：整组都要重启才生效的，组标题下也不说 @responsive', async ({ page }) => {
  await openGroup(page, '连接与传输')
  await page.getByLabel('TCP 连接池', { exact: true }).fill('32')
  await expect(page.locator('.settings-group').getByText(/重启/)).toHaveCount(0)
})

test('改重载即生效的设置：不提示重启，保存条照常说已生效 @responsive', async ({ page }) => {
  await openGroup(page, '基础与监听')
  await page.getByLabel('上游超时 (ms)', { exact: true }).fill('2500')
  await expect(page.getByText('重启 KixDNS 后生效', { exact: true })).toHaveCount(0)
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__savebar')).toContainText(/已生效\s·\s版本 #\d+/)
  await expect(page.locator('.cfg__notice')).toHaveCount(0)
})

async function saveListenerChange(page: Page): Promise<void> {
  await openGroup(page, '基础与监听')
  await page.getByLabel('UDP 监听地址', { exact: true }).fill('0.0.0.0:5300')
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__notice')).toContainText('改过的设置要重启 KixDNS 才生效')
}

test('概览的运行配置：有设置等着重启时说「待重启」，重启以后回到「已生效」 @responsive', async ({ page }) => {
  await saveListenerChange(page)
  // 演示数据只在这一页的内存里：用页内导航去概览，不重新加载 / Demo data lives in this page's memory: navigate in-app, no reload
  await page.getByRole('link', { name: '概览', exact: true }).locator('visible=true').first().click()
  const tag = page.locator('.overview-config-state')
  await expect(tag).toHaveText('待重启')
  await page.getByRole('link', { name: '管理配置' }).click()
  await page.locator('.cfg__notice').getByRole('button', { name: '重启 KixDNS', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '重启服务', exact: true }).click()
  await expect(page.locator('.cfg__notice')).toHaveCount(0)
  await page.getByRole('link', { name: '概览', exact: true }).locator('visible=true').first().click()
  await expect(tag).toHaveText('已生效')
})

test('重启以后 KixDNS 没起来：页头和提示条照实说，退回改过的设置再重启就回来了 @responsive', async ({ page }) => {
  await page.clock.install()
  await saveListenerChange(page)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-restart-no-answer', 'true'))
  const notice = page.locator('.cfg__notice')
  await notice.getByRole('button', { name: '重启 KixDNS', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '重启服务', exact: true }).click()
  // 等它回来的时候按钮一直按不下，页头写「正在重启」 / While waiting the button stays held and the header reads 正在重启
  await expect(notice.getByRole('button', { name: '重启 KixDNS', exact: true })).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByText('正在重启', { exact: true }).locator('visible=true')).toHaveCount(1)
  await expect(page.getByText('KixDNS 服务已重启')).toHaveCount(0)
  // 一直往前拨钟，直到等满十五秒：配置页上由提示条说，不另起提示 / Move the clock on until the fifteen seconds are up: on the
  // config page the notice says it, with no toast besides
  await expect(async () => {
    await page.clock.fastForward(2_000)
    await expect(notice).toContainText(/重启后 KixDNS 没有起来，改过的设置可能用不了：UDP\s监听地址。/, { timeout: 300 })
  }).toPass()
  await expect(page.locator('.toast', { hasText: '没有' })).toHaveCount(0)
  await expect(page.getByText(/没有起来$/).locator('visible=true').first()).toBeVisible()

  await notice.getByRole('button', { name: '退回原来的设置并重启', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText(/UDP\s监听地址\s0\.0\.0\.0:53/)
  await confirm.getByRole('button', { name: '退回并重启', exact: true }).click()
  // 等它回来的时候表单不能改：回来以后整份换上退回后的文件 / While waiting the form cannot be edited: the rolled-back file
  // replaces the page on return
  await expect(page.locator('.cfg__panel')).toHaveAttribute('inert', '')
  await expect(page.getByText('已退回原来的设置，KixDNS 服务已重启')).toBeVisible()
  await expect(notice).toHaveCount(0)
  await expect(page.getByLabel('UDP 监听地址', { exact: true })).toHaveValue('0.0.0.0:53')
  // 文件是这一页改的：不说「别处改过了」；退回的那一版回来就应用了，页头不挂「待应用」，也不再补一句「已生效」
  // This page changed the file: no 别处改过了; the rolled-back version is applied on return, so the header shows no 待应用
  // and no 已生效 follows
  await expect(page.locator('.toast', { hasText: '别处改' })).toHaveCount(0)
  await expect(page.getByText(/待应用/).locator('visible=true')).toHaveCount(0)
  await page.clock.fastForward(6_000)
  await expect(page.locator('.toast', { hasText: '已生效' })).toHaveCount(0)
})

test('重启以后 KixDNS 没起来：在系统页再启动一次照样起不来，退回的出路还在 @responsive', async ({ page }) => {
  await page.clock.install()
  await saveListenerChange(page)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-restart-no-answer', 'true'))
  const notice = page.locator('.cfg__notice')
  await notice.getByRole('button', { name: '重启 KixDNS', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '重启服务', exact: true }).click()
  await expect(async () => {
    await page.clock.fastForward(2_000)
    await expect(notice).toContainText('重启后 KixDNS 没有起来', { timeout: 300 })
  }).toPass()
  // 去系统页再启动一次：文件没变，照样起不来；系统页和概览一样说「正在启动」，不说「已停止」
  // Start once more from the system page: the file is unchanged, so it fails again; the system page says 正在启动 as the overview
  // does, not 已停止
  await page.getByRole('link', { name: '系统', exact: true }).locator('visible=true').first().click()
  await expect(page.getByText('正在启动').locator('visible=true').first()).toBeVisible()
  await page.getByRole('button', { name: '启动', exact: true }).click()
  await expect(async () => {
    await page.clock.fastForward(2_000)
    await expect(page.locator('.toast', { hasText: 'KixDNS 启动后没有起来，可以到配置页退回改过的设置' })).toBeVisible({ timeout: 300 })
  }).toPass()
  await expect(page.getByText('KixDNS 服务已启动')).toHaveCount(0)
  await page.getByRole('link', { name: /^(配置|基础设置)$/ }).locator('visible=true').first().click()
  await expect(notice.getByRole('button', { name: '退回原来的设置并重启', exact: true })).toBeVisible()
})

test('重启以后 KixDNS 没起来时：草稿有修改先保存，存成待应用以后才能退回 @responsive', async ({ page }) => {
  await page.clock.install()
  await saveListenerChange(page)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-restart-no-answer', 'true'))
  const notice = page.locator('.cfg__notice')
  await notice.getByRole('button', { name: '重启 KixDNS', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '重启服务', exact: true }).click()
  await expect(async () => {
    await page.clock.fastForward(2_000)
    await expect(notice).toContainText('重启后 KixDNS 没有起来', { timeout: 300 })
  }).toPass()
  // 草稿有修改时先保存：退回改的是存下的那份 / With edits in the draft, save first: the rollback changes the saved config
  await page.getByLabel('上游超时 (ms)', { exact: true }).fill('2500')
  await expect(notice).toContainText('先保存草稿里的修改，再退回这些设置')
  await expect(notice.getByRole('button')).toHaveCount(0)
  // KixDNS 不在：只能存成待应用 / KixDNS is not there: it can only be kept as pending
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存为待应用' }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('待应用版本')
  await expect(notice.getByRole('button', { name: '退回原来的设置并重启', exact: true })).toBeVisible()
})
