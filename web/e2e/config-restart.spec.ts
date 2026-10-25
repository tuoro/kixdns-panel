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

test('重启以后 KixDNS 没起来：页头和提示条照实说，退回原来的设置再重启就回来了 @responsive', async ({ page }) => {
  await page.clock.install()
  await saveListenerChange(page)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-restart-no-answer', 'true'))
  const notice = page.locator('.cfg__notice')
  await notice.getByRole('button', { name: '重启 KixDNS', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '重启服务', exact: true }).click()
  // 等它回来的时候按钮一直按不下，页头写「正在重启」 / While waiting the button stays held and the header reads 正在重启
  await expect(notice.getByRole('button', { name: '重启 KixDNS', exact: true })).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByText(/正在重启$/).locator('visible=true')).toHaveCount(1)
  await expect(page.getByText('KixDNS 服务已重启')).toHaveCount(0)
  // 一直往前拨钟，直到等满十五秒：配置页上由提示条说，不另起提示 / Move the clock on until the fifteen seconds are up: on the
  // config page the notice says it, with no toast besides
  await expect(async () => {
    await page.clock.fastForward(2_000)
    await expect(notice).toContainText(/可能是改过的设置让 KixDNS\s起不来：UDP\s监听地址。/, { timeout: 300 })
  }).toPass()
  await expect(page.locator('.toast', { hasText: '没有' })).toHaveCount(0)
  // 状态由页头说，和概览、系统页同一个词 / The header says the state, in the same word as the overview and the system page
  await expect(page.getByText(/启动失败$/).locator('visible=true').first()).toBeVisible()

  await notice.getByRole('button', { name: '退回原来的设置并重启', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  // 名字和值粘在一起，不分到两行 / Name and value stay together, never split across lines
  await expect(confirm).toContainText('UDP\u00a0监听地址\u00a00.0.0.0:53。其他修改都保留。')
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
  // 操作记录写设置名，不写内核的键名 / The audit row names the setting, not the kernel's key
  await page.evaluate(() => { history.pushState(history.state, '', '/logs?view=audit'); dispatchEvent(new PopStateEvent('popstate', { state: history.state })) })
  const row = page.locator('.audit-line', { hasText: '退回原来的设置' })
  await expect(row).toContainText(/UDP\s监听地址，版本 #\d+/)
  await expect(row).not.toContainText('bind_udp')
  // 这一行照常折行，不撑出卡片、不让日志区横向滚动 / The row wraps as usual, without overflowing the card or scrolling the log sideways
  expect(await row.evaluate((line) => {
    let box: HTMLElement | null = line as HTMLElement
    while (box) { if (box.scrollWidth > box.clientWidth + 1) return false; box = box.parentElement }
    return true
  })).toBe(true)
})

test('重启以后 KixDNS 没起来：在系统页再重启一次照样起不来，退回的出路还在 @responsive', async ({ page }) => {
  await page.clock.install()
  await saveListenerChange(page)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-restart-no-answer', 'true'))
  const notice = page.locator('.cfg__notice')
  await notice.getByRole('button', { name: '重启 KixDNS', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '重启服务', exact: true }).click()
  await expect(async () => {
    await page.clock.fastForward(2_000)
    await expect(notice).toContainText('可能是改过的设置让 KixDNS', { timeout: 300 })
  }).toPass()
  // 系统页和配置页、概览一样说「启动失败」；systemd 在重试时给「重启」「停止」，不给「启动」
  // The system page says 启动失败 as the config page and overview do; while systemd retries it offers 重启 and 停止, not 启动
  await page.getByRole('link', { name: '系统', exact: true }).locator('visible=true').first().click()
  await expect(page.getByText('启动失败').locator('visible=true').first()).toBeVisible()
  await expect(page.getByRole('button', { name: '启动', exact: true })).toHaveCount(0)
  // 系统页也在页头下面放一条提示：可能的原因和出路 / The system page has a notice under its header too: the likely cause and the
  // way out
  const systemNotice = page.locator('.ui-notice', { hasText: 'KixDNS 启动失败' })
  await expect(systemNotice).toContainText(/可能是改过的设置让 KixDNS\s起不来，可以退回/)
  await expect(systemNotice.getByRole('link', { name: '去配置页', exact: true })).toHaveAttribute('href', '/config?section=settings')
  // 起不来时的确认框照实说：服务本来就断着，重启是再试一次，能退回的指到配置页 / The confirm says it as it is: the service is
  // down already, a restart tries once more, and what can go back points to the config page
  await page.getByRole('button', { name: '重启', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText(/KixDNS\s现在起不来，重启会再试一次。可能是改过的设置导致的，可以到配置页退回：UDP\s监听地址。/)
  await expect(confirm).not.toContainText('短暂中断')
  await confirm.getByRole('button', { name: '重启服务', exact: true }).click()
  // 文件没变，照样起不来；服务端一看出来就说，不等满十五秒。这一页的提示条在说，不另弹提示
  // The file is unchanged, so it fails again; said as soon as the server sees it, without waiting out fifteen seconds. This
  // page's notice says it, so no toast besides
  await expect(systemNotice).toBeVisible()
  await expect(page.locator('.toast', { hasText: '启动失败' })).toHaveCount(0)
  await expect(page.getByText('KixDNS 服务已重启')).toHaveCount(0)
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toContainText('停止后 systemd 不再重试启动 KixDNS。配置不变。')
  await page.keyboard.press('Escape')
  // 诊断页也一样说「启动失败」，指到配置页 / The diagnostics page says 启动失败 too and points to the config page
  await page.getByRole('link', { name: '诊断', exact: true }).locator('visible=true').first().click()
  await expect(page.locator('.ui-notice', { hasText: 'KixDNS 启动失败' })).toContainText('可以退回')
  await expect(page.getByRole('link', { name: '去配置页', exact: true })).toBeVisible()
  // 概览同一个按钮、同一个去处 / The overview: the same button, the same place
  await page.getByRole('link', { name: '概览', exact: true }).locator('visible=true').first().click()
  await expect(page.locator('.ui-notice', { hasText: 'KixDNS 启动失败' })).toContainText(/可以退回：UDP\s监听地址/)
  await page.locator('.ui-notice').getByRole('link', { name: '去配置页', exact: true }).click()
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
    await expect(notice).toContainText('可能是改过的设置让 KixDNS', { timeout: 300 })
  }).toPass()
  // 草稿有修改时先保存：退回改的是存下的那份 / With edits in the draft, save first: the rollback changes the saved config
  await page.getByLabel('上游超时 (ms)', { exact: true }).fill('2500')
  await expect(notice).toContainText('先保存或放弃草稿里的修改，再退回这些设置')
  await expect(notice.getByRole('button')).toHaveCount(0)
  // KixDNS 不在：只能存成待应用 / KixDNS is not there: it can only be kept as pending
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存为待应用' }).click()
  // 保存条说实话：它不会自己等到，要随退回一起应用 / The save bar tells the truth: it will not just arrive, it applies with
  // the rollback
  await expect(page.locator('.cfg__savebar')).toContainText(/已存成待应用版本 #\d+，退回时一起应用/)
  await expect(notice.getByRole('button', { name: '退回原来的设置并重启', exact: true })).toBeVisible()
  // 页头还说着待应用的版本 / The header still names the pending version
  await expect(page.getByText(/待应用$/).locator('visible=true').first()).toBeVisible()
  // 退回确认框说清：待应用版本里这一项也改回 / The rollback confirm says it: this setting goes back in the pending version too
  await notice.getByRole('button', { name: '退回原来的设置并重启', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toContainText(/待应用的版本\s#\d+\s里这一项也改回，其他修改都保留。/)
  await page.keyboard.press('Escape')
  // 起不来时有了待应用版本，也不当它在线：页头不给「现在应用」，再改一笔照样只能存成待应用
  // Down with a pending version, it is still not treated as online: no 现在应用 in the header, and another edit can only be
  // kept as pending
  await expect(page.getByRole('button', { name: '现在应用', exact: true })).toHaveCount(0)
  await page.getByLabel('上游超时 (ms)', { exact: true }).fill('2600')
  await expect(page.locator('.cfg__savebar').getByRole('button', { name: '保存为待应用' })).toBeVisible()
})

test('有待应用的版本时重启：重启前先应用它，回来只说一句，页头不挂「待应用」 @responsive', async ({ page }) => {
  await saveListenerChange(page)
  // 再改一项、这次保存时 KixDNS 没及时回应，先存成待应用 / One more edit, kept as pending because KixDNS did not answer in time
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-pending', 'true'))
  await page.getByLabel('TCP 监听地址', { exact: true }).fill('0.0.0.0:5300')
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('待应用版本')
  const notice = page.locator('.cfg__notice')
  await notice.getByRole('button', { name: '重启 KixDNS', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  // 先说重启前，再说重启后 / What happens before the restart comes first, then what follows it
  await expect(confirm).toContainText(/服务会短暂中断，缓存会清空。重启前先应用待应用的版本\s#\d+。重启后生效的设置：/)
  await confirm.getByRole('button', { name: '重启服务', exact: true }).click()
  // 一条提示说完，带上重启前应用的那个版本 / One toast says it all, with the version applied before the restart
  await expect(page.locator('.toast')).toHaveText([/^KixDNS 服务已重启，版本\s#\d+\s已生效$/])
  await expect(notice).toHaveCount(0)
  await expect(page.getByText(/待应用/).locator('visible=true')).toHaveCount(0)
})

test('起不来、又没有可以退回的设置：指到日志；存了待应用的版本可以写进配置文件再重启 @responsive', async ({ page }) => {
  await page.goto('/config?section=settings')
  await page.evaluate(() => localStorage.setItem('kixdns:demo-restart-no-answer', 'no-rollback'))
  await page.getByRole('link', { name: '系统', exact: true }).locator('visible=true').first().click()
  await page.getByRole('button', { name: '重启', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '重启服务', exact: true }).click()
  // 服务端一看出起不来就说，不等满十五秒；这一页的提示条指到日志，不另弹提示
  // Said as soon as the server sees it does not come up, without waiting out fifteen seconds; this page's notice points to the
  // logs, with no toast besides
  const systemNotice = page.locator('.ui-notice', { hasText: 'KixDNS 启动失败' })
  await expect(systemNotice).toContainText('起不来的原因在运行日志里。', { timeout: 3_000 })
  await expect(systemNotice.getByRole('link', { name: '查看日志', exact: true })).toHaveAttribute('href', '/logs?view=runtime')
  await expect(page.locator('.toast')).toHaveCount(0)

  await page.getByRole('link', { name: /^(配置|基础设置)$/ }).locator('visible=true').first().click()
  const notice = page.locator('.cfg__notice')
  await expect(notice).toContainText('起不来的原因在运行日志里。')
  await expect(notice.getByRole('button', { name: '查看日志', exact: true })).toBeVisible()
  // 改一笔只能存成待应用；保存条说 KixDNS 起来就自动应用，写进配置文件那条出路只由提示条说（那里有按钮） / An edit can only be
  // kept as pending; the save bar says it applies once KixDNS is up, and the way out of writing it in is said by the notice alone
  // (which holds the button)
  // 手机上底栏的「配置」打开的是规则页签 / On a phone the bottom bar's 配置 opens the rules tab
  const settingsTab = page.getByRole('tab', { name: '基础设置', exact: true }).locator('visible=true')
  if (await settingsTab.count()) await settingsTab.click()
  await page.getByRole('button', { name: /基础与监听/ }).locator('visible=true').first().click()
  await page.getByLabel('上游超时 (ms)', { exact: true }).fill('2500')
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存为待应用' }).click()
  await expect(page.locator('.cfg__savebar')).toContainText(/已存成待应用版本 #\d+，KixDNS\s启动后\u2060自\u2060动\u2060应\u2060用/)
  await expect(page.locator('.cfg__savebar')).not.toContainText('写进配置文件')
  await expect(notice).toContainText(/版本\s#\d+\s要写进配置文件，KixDNS\s启动时才读得到它。/)
  // 别的页面同样指到配置页：系统页、概览的提示条都给「去配置页」 / Other pages point to the config page too: the system page and
  // overview notices both offer 去配置页
  await page.getByRole('link', { name: '系统', exact: true }).locator('visible=true').first().click()
  const systemFix = page.locator('.ui-notice', { hasText: 'KixDNS 启动失败' })
  await expect(systemFix).toContainText(/版本\s#\d+\s还没写进配置文件，可以到配置页写进去。/)
  await page.getByRole('link', { name: '概览', exact: true }).locator('visible=true').first().click()
  await expect(page.locator('.ui-notice', { hasText: 'KixDNS 启动失败' })).toContainText(/版本\s#\d+\s还没写进配置文件，可以到配置页写进去/)
  await page.locator('.ui-notice').getByRole('link', { name: '去配置页', exact: true }).click()
  await notice.getByRole('button', { name: '写进配置文件并重启', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText(/把版本\s#\d+\s写进配置文件/)
  await expect(confirm).toContainText('KixDNS 不在，没法先校验这份配置：直接写进配置文件，再重启。还是起不来的话，改好再写一次。')
  await confirm.getByRole('button', { name: '写进并重启', exact: true }).click()
  await expect(page.locator('.toast')).toHaveText([/^版本\s#\d+\s已写进配置文件，KixDNS 服务已重启$/])
  await expect(notice).toHaveCount(0)
  // 从概览的「去配置页」进来的是设置分区的开头：打开那一组再看 / Arriving from the overview's 去配置页 lands at the top of the
  // settings section: open the group to look
  await page.getByRole('button', { name: /基础与监听/ }).locator('visible=true').first().click()
  await expect(page.getByLabel('上游超时 (ms)', { exact: true })).toHaveValue('2500')
  await expect(page.getByText(/待应用|启动失败/).locator('visible=true')).toHaveCount(0)
})

test('退回、写进配置文件以后还是起不来：照实说做了什么，提示条只指到日志，不叫人再写一遍 @responsive', async ({ page }) => {
  await page.clock.install()
  await saveListenerChange(page)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-restart-no-answer', 'true'))
  const notice = page.locator('.cfg__notice')
  await notice.getByRole('button', { name: '重启 KixDNS', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '重启服务', exact: true }).click()
  await expect(async () => {
    await page.clock.fastForward(2_000)
    await expect(notice).toContainText('可能是改过的设置让 KixDNS', { timeout: 300 })
  }).toPass()
  // 原来的值这期间也用不了了：退回写进了文件，还是起不来 / The original value is unusable meanwhile too: the rollback is in the
  // file and it still fails
  await page.evaluate(() => localStorage.setItem('kixdns:demo-still-down', 'true'))
  await notice.getByRole('button', { name: '退回原来的设置并重启', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '退回并重启', exact: true }).click()
  // 提示条在说起不来，所以那句不再指去日志；退回存的那一版用户没见过，不报编号，也不叫人把它再写一遍
  // The notice says it does not come up, so the toast does not point to the logs again; the version the rollback stored is one
  // nobody saw, so its number is not given and nobody is asked to write it again
  await expect(page.locator('.toast')).toHaveText(['已退回原来的设置，KixDNS 还是起不来'])
  await expect(notice).toHaveText(/^\s*起不来的原因在运行日志里。\s*查看日志\s*$/)
  await expect(notice.getByRole('button', { name: '写进配置文件并重启' })).toHaveCount(0)
  await expect(page.getByLabel('UDP 监听地址', { exact: true })).toHaveValue('0.0.0.0:53')

  // 改好一笔、存成待应用、写进配置文件，还是起不来 / Fix something, keep it as pending, write it into the file: still down
  await page.getByLabel('上游超时 (ms)', { exact: true }).fill('2500')
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存为待应用' }).click()
  await expect(notice.getByRole('button', { name: '写进配置文件并重启', exact: true })).toBeVisible()
  await page.evaluate(() => localStorage.setItem('kixdns:demo-still-down', 'true'))
  await notice.getByRole('button', { name: '写进配置文件并重启', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '写进并重启', exact: true }).click()
  await expect(page.locator('.toast', { hasText: '已写进配置文件' })).toHaveText([/^版本\s#\d+\s已写进配置文件，KixDNS 还是起不来$/])
  await expect(notice).toContainText('起不来的原因在运行日志里。')
  await expect(notice.getByRole('button', { name: '写进配置文件并重启' })).toHaveCount(0)
  // 已经在文件里的那一版：保存条、系统页不再说可以写进配置文件 / A version already in the file: neither the save bar nor the
  // system page says it can be written in
  await page.getByRole('link', { name: '系统', exact: true }).locator('visible=true').first().click()
  await page.getByRole('button', { name: '重启', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  // 那一版已经在文件里：不再说待应用的版本 / That version is in the file already: the pending version is not mentioned
  await expect(confirm).toContainText('KixDNS\u00a0现在起不来，重启会再试一次。')
  await expect(confirm).not.toContainText('待应用')
  // 这次起来了：回来那一条带上它 / Up this time: the toast on return names it
  await confirm.getByRole('button', { name: '重启服务', exact: true }).click()
  await expect(page.locator('.toast', { hasText: 'KixDNS 服务已重启' })).toHaveText([/^KixDNS 服务已重启，版本\s#\d+\s已生效$/])
  await expect(page.locator('.ui-notice', { hasText: '启动失败' })).toHaveCount(0)
})

// 手机的保存条上没有「放弃修改」（在「…」里），逻辑和桌面同一份：只在桌面跑 / Phones keep 放弃修改 out of the save bar (it is under 「…」),
// and the logic is the desktop's: run on desktop only
test('退回的确认框开着时撤销放弃、找回了修改：不退回，那笔修改留着', async ({ page }) => {
  await page.clock.install()
  await saveListenerChange(page)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-restart-no-answer', 'true'))
  const notice = page.locator('.cfg__notice')
  await notice.getByRole('button', { name: '重启 KixDNS', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '重启服务', exact: true }).click()
  await expect(async () => {
    await page.clock.fastForward(2_000)
    await expect(notice).toContainText('可能是改过的设置让 KixDNS', { timeout: 300 })
  }).toPass()
  await page.getByLabel('上游超时 (ms)', { exact: true }).fill('2600')
  await page.locator('.cfg__savebar').getByRole('button', { name: '放弃修改', exact: true }).click()
  const discarded = page.locator('.toast', { hasText: '已放弃' })
  await expect(discarded).toBeVisible()
  await notice.getByRole('button', { name: '退回原来的设置并重启', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('其他修改都保留')
  // 提示在打开的确认框里照样能点 / Toasts stay clickable inside an open dialog
  await page.locator('.toast', { hasText: '已放弃' }).getByRole('button', { name: '撤销' }).click()
  await expect(page.getByLabel('上游超时 (ms)', { exact: true })).toHaveValue('2600')
  await confirm.getByRole('button', { name: '退回并重启', exact: true }).click()
  // 不发：提示条换回「先保存或放弃」，修改还在，监听地址没有退回 / Nothing is sent: the notice is back to 先保存或放弃, the edit
  // stays and the listen address is not put back
  await expect(notice).toContainText('先保存或放弃草稿里的修改，再退回这些设置')
  await expect(page.getByLabel('上游超时 (ms)', { exact: true })).toHaveValue('2600')
  await expect(page.getByLabel('UDP 监听地址', { exact: true })).toHaveValue('0.0.0.0:5300')
  await expect(page.locator('.toast', { hasText: '已退回' })).toHaveCount(0)
  // 按了却没发：说一句，不悄悄关掉 / Pressed but not sent: a line says so, rather than the dialog just closing
  await expect(page.locator('.toast', { hasText: '没有退回' })).toHaveText(['没有退回：草稿里还有修改没保存'])
})

test('别的页按了「启动」、等它回来时，配置页页头也转圈、写「正在启动」 @responsive', async ({ page }) => {
  // 演示停掉以后配置页仍报在运行（老局限），所以从系统页按「启动」，等待中切到配置页 / The demo still reports the config page as
  // running after a stop (a known limit), so 启动 is pressed on the system page and the config page is opened while it waits
  await page.clock.install()
  await page.goto('/system')
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '停止服务', exact: true }).click()
  await page.getByRole('button', { name: '启动', exact: true }).click()
  await expect(page.getByText('正在启动').locator('visible=true').first()).toBeVisible()
  await page.getByRole('link', { name: /^(配置|规则)$/ }).locator('visible=true').first().click()
  await expect(page.getByText(/正在启动$/).locator('visible=true').first()).toBeVisible()
  await page.clock.fastForward(2_000)
  await expect(page.locator('.toast', { hasText: 'KixDNS 服务已启动' })).toBeVisible()
  await expect(page.getByText(/正在启动$/).locator('visible=true')).toHaveCount(0)
})

test('退回以后还是起不来、之后重启起来了：提示说退回的设置已生效，不报退回存的编号 @responsive', async ({ page }) => {
  await page.clock.install()
  await saveListenerChange(page)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-restart-no-answer', 'true'))
  const notice = page.locator('.cfg__notice')
  await notice.getByRole('button', { name: '重启 KixDNS', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '重启服务', exact: true }).click()
  await expect(async () => {
    await page.clock.fastForward(2_000)
    await expect(notice).toContainText('可能是改过的设置让 KixDNS', { timeout: 300 })
  }).toPass()
  await page.evaluate(() => localStorage.setItem('kixdns:demo-still-down', 'true'))
  await notice.getByRole('button', { name: '退回原来的设置并重启', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '退回并重启', exact: true }).click()
  await expect(page.locator('.toast')).toHaveText(['已退回原来的设置，KixDNS 还是起不来'])
  await page.getByRole('link', { name: '系统', exact: true }).locator('visible=true').first().click()
  await page.getByRole('button', { name: '重启', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '重启服务', exact: true }).click()
  await expect(page.locator('.toast', { hasText: 'KixDNS 服务已重启' })).toHaveText(['KixDNS 服务已重启，退回的设置已生效'])
})

// 改了监听地址、重启后起不来，再存一笔待应用的修改：退回时把它一起带上。applyOnReturn 是回来时那次应用的演示开关
// The listener changed and the restart did not come up, then one more edit was kept as pending: the rollback carries it along.
// applyOnReturn is the demo flag for the apply on return
async function rollBackCarryingEdits(page: Page, applyOnReturn: string): Promise<void> {
  await page.clock.install()
  await saveListenerChange(page)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-restart-no-answer', 'true'))
  const notice = page.locator('.cfg__notice')
  await notice.getByRole('button', { name: '重启 KixDNS', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '重启服务', exact: true }).click()
  await expect(async () => {
    await page.clock.fastForward(2_000)
    await expect(notice).toContainText('可能是改过的设置让 KixDNS', { timeout: 300 })
  }).toPass()
  await page.getByLabel('上游超时 (ms)', { exact: true }).fill('2500')
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存为待应用' }).click()
  await expect(page.locator('.cfg__savebar')).toContainText('退回时一起应用')
  await page.evaluate((flag) => localStorage.setItem(flag, 'true'), applyOnReturn)
  await notice.getByRole('button', { name: '退回原来的设置并重启', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '退回并重启', exact: true }).click()
}

// 回来时那次应用面板内部出错：什么都没写，也不算被拒，KixDNS 在、带上的修改还待应用 / The apply on return meets an internal panel
// error: nothing written and not a refusal, so KixDNS is up with the carried edits still pending
async function upWithCarriedEdits(page: Page): Promise<void> {
  await rollBackCarryingEdits(page, 'kixdns:demo-apply-error')
  await expect(page.locator('.toast', { hasText: '已退回原来的设置' })).toHaveText(['已退回原来的设置，KixDNS 服务已重启'])
  // 退回的设置已经在用，页头只说修改 / The settings put back are in use, so the header speaks only of the edits
  await expect(page.getByText('修改待应用', { exact: true }).locator('visible=true').first()).toBeVisible()
  await expect(page.getByText(/退回的设置/).locator('visible=true')).toHaveCount(0)
}

test('退回带上的修改回来时没应用上、KixDNS 在：页头「修改待应用」，现在应用时「修改应用中」，结果说待应用的修改已生效 @responsive', async ({ page }) => {
  await upWithCarriedEdits(page)
  await page.evaluate(() => localStorage.setItem('kixdns:demo-save-slow', '2500'))
  await page.getByRole('button', { name: '现在应用', exact: true }).locator('visible=true').first().click()
  await expect(page.getByText('修改应用中', { exact: true }).locator('visible=true').first()).toBeVisible()
  // 应用途中想保存：说在应用修改，不报退回写下的编号 / Saving mid-apply: it says the edits are being applied, without the number the
  // rollback stored
  await page.getByLabel('上游超时 (ms)', { exact: true }).fill('2600')
  // 按钮这时只是看着停用（aria-disabled），点了说为什么 / The button only looks disabled now (aria-disabled), and a press says why
  await page.locator('.cfg__savebar').getByRole('button', { name: '保存并应用' }).click({ force: true })
  await expect(page.locator('.toast', { hasText: '正在应用' })).toHaveText(['正在应用修改，应用完再保存'])
  await page.clock.fastForward(2_600)
  await expect(page.locator('.toast', { hasText: '已生效' })).toHaveText(['待应用的修改已生效'])
  await expect(page.getByText(/待应用$|应用中$/).locator('visible=true')).toHaveCount(0)
  // 页头回到运行中：宽屏是状态格，手机是页头那一行 / The header is back to 运行中: the status cell when wide, the header line on phones
  await expect(page.locator('.cfg__facts, .cfg .ui-ph__lead').locator('visible=true').first()).toContainText(/(?:^|状态\s*)运行中/)
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

const reconnect = (page: Page) => page.evaluate(async () => {
  localStorage.removeItem('kixdns:demo-panel-down')
  // 装了假时钟，performance 里查不到加载过的模块，直接按路径取（和页面用的是同一个） / With the fake clock installed performance lists
  // no loaded modules, so the module is taken by its path (the same one the page uses)
  const connection = await import('/src/composables/useConnection.ts')
  void connection.useConnection().retry()
})

test('退回带上的修改、KixDNS 在时「现在应用」的回应丢了：连上后核对只说一句已生效，不另挂「还没有应用」 @responsive', async ({ page }) => {
  await upWithCarriedEdits(page)
  await page.evaluate(() => {
    window.addEventListener('kixdns:panel-unreachable', () => localStorage.setItem('kixdns:demo-panel-down', 'true'), { capture: true, once: true })
    localStorage.setItem('kixdns:demo-put-answer-lost', 'true')
  })
  await page.getByRole('button', { name: '现在应用', exact: true }).locator('visible=true').first().click()
  await expect(page.locator('.conn__inner')).toBeVisible()
  await reconnect(page)
  // 原地应用不比内容，只看文件还是不是那一版：退回写下的这一版也认得出已经生效 / An in-place apply is checked by the version in the
  // file, not the content: the version a rollback wrote is recognised as in effect too
  await expect(page.locator('.toast', { hasText: '刚才那次应用' })).toHaveText(['刚才那次应用：待应用的修改已生效'], { timeout: 8000 })
  await expect(page.locator('.toast', { hasText: '还没有应用' })).toHaveCount(0)
  await expect(page.locator('.cfg__notice', { hasText: '没有应用' })).toHaveCount(0)
  await expect(page.getByText(/待应用$/).locator('visible=true')).toHaveCount(0)
})

test('退回带上的修改、按「现在应用」马上离开、回应丢了：先说不知道待应用的修改应用了没有，连上后换成结果', async ({ page }) => {
  await upWithCarriedEdits(page)
  await page.evaluate(() => {
    window.addEventListener('kixdns:panel-unreachable', () => localStorage.setItem('kixdns:demo-panel-down', 'true'), { capture: true, once: true })
    localStorage.setItem('kixdns:demo-save-slow', '4000')
    localStorage.setItem('kixdns:demo-put-answer-lost', 'true')
  })
  await page.getByRole('button', { name: '现在应用', exact: true }).click()
  await page.getByRole('link', { name: '概览', exact: true }).locator('visible=true').first().click()
  // 到了概览才断：离开以后回应才丢的那条路 / Cut off only once on the overview: the path where the answer is lost after leaving
  await expect(page).toHaveURL(/\/$/)
  await expect(page.locator('.toast', { hasText: '不知道' })).toHaveCount(0)
  await page.clock.fastForward(4_100)
  await expect(page.locator('.toast', { hasText: '不知道' })).toHaveText(['不知道待应用的修改应用了没有：连不上面板。连上后会自己核对'])
  // 退回的叫法没有空格，「不知道」后面留了断点（toHaveText 会去掉零宽空格，这里看原文） / The rollback's name has no space, so a break point
  // follows 不知道 (toHaveText drops zero-width spaces, so the raw text is read)
  expect(await page.locator('.toast', { hasText: '不知道' }).evaluate((toast) => toast.textContent)).toContain('不知道\u200b待应用的修改')
  await reconnect(page)
  await expect(page.locator('.toast', { hasText: '那次应用' })).toHaveText([/^刚才那次应用：待应用的修改已生效/], { timeout: 8000 })
  await expect(page.locator('.toast', { hasText: '不知道' })).toHaveCount(0)
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-save-slow'))
})

test('别处重启时带上的修改被拒，进配置页：红色提示等提示条说出没有生效才收起，读得慢也一样', async ({ page }) => {
  await rollBackCarryingEdits(page, 'kixdns:demo-still-down')
  await expect(page.locator('.toast', { hasText: '还是起不来' })).toBeVisible()
  await page.getByRole('link', { name: '系统', exact: true }).locator('visible=true').first().click()
  await page.evaluate(() => localStorage.setItem('kixdns:demo-apply-failed', 'true'))
  await page.getByRole('button', { name: '重启', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '重启服务', exact: true }).click()
  const refused = page.locator('.toast', { hasText: '到配置页看原因' })
  await expect(refused).toHaveText(['KixDNS 服务已重启，待应用的修改没有生效，到配置页看原因'])
  // 收起的那一刻提示条已经在说没有生效（以前按上次留下的文档当场收起，提示条读完才出来）/ At the moment it goes the notice already
  // says it did not take (it used to go at once, judged by the document left from last time, before the notice was read)
  await page.evaluate(() => {
    const w = window as unknown as { goneBeforeNotice?: boolean }
    const toast = [...document.querySelectorAll('.toast')].find((e) => e.textContent?.includes('到配置页看原因'))!
    new MutationObserver((_, observer) => {
      if (toast.isConnected && !toast.className.includes('leave')) return
      w.goneBeforeNotice = !document.querySelector('.cfg__notice')?.textContent?.includes('没有生效')
      observer.disconnect()
    }).observe(document.body, { subtree: true, childList: true, attributes: true })
    localStorage.setItem('kixdns:demo-read-slow', 'true')
  })
  await page.getByRole('link', { name: /^(?:配置|基础设置)$/ }).locator('visible=true').first().click()
  await expect(page.locator('.cfg__notice')).toContainText('没有生效', { timeout: 5000 })
  await expect(refused).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { goneBeforeNotice?: boolean }).goneBeforeNotice)).toBe(false)
  await page.evaluate(() => localStorage.removeItem('kixdns:demo-read-slow'))
})

test('配置页外收到「…没有生效，到配置页看原因」以后退出登录：登录页上不留着它', async ({ page }) => {
  await rollBackCarryingEdits(page, 'kixdns:demo-apply-failed')
  await page.getByRole('link', { name: '概览', exact: true }).locator('visible=true').first().click()
  await expect(page.locator('.toast', { hasText: '到配置页看原因' })).toHaveText(['已退回原来的设置，KixDNS 服务已重启；待应用的修改没有生效，到配置页看原因'])
  await page.getByRole('button', { name: /^账户：/ }).click()
  await page.getByRole('dialog', { name: '账户', exact: true }).getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(/\/login/)
  await expect(page.locator('.toast', { hasText: '没有生效' })).toHaveCount(0)
})
