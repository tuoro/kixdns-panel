import { expect, test, type Page } from '@playwright/test'

// 校验失败时让 /validate 抛错：只在测试里替换 API 模块边界，生产代码没有测试入口。
// Makes /validate throw by swapping the API module boundary in the test only; production code has no test hook.
async function rejectValidation(page: Page): Promise<void> {
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('save-original')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?save-original';
      import { apiRequest as original } from '/src/api/client.ts?save-original';
      export async function apiRequest(path, init) {
        if (path === '/api/v1/config/validate') throw new Error('规则 cn-direct 引用了不存在的上游组');
        return original(path, init);
      }
    ` })
  })
}

// 让校验和保存各慢 800 毫秒，第二次点击一定落在保存进行中。 / Slows validate and save by 800ms so a second press lands mid-save.
async function slowSave(page: Page): Promise<void> {
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('slow-original')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?slow-original';
      import { apiRequest as original } from '/src/api/client.ts?slow-original';
      export async function apiRequest(path, init) {
        if (path === '/api/v1/config' && init && init.method === 'PUT') globalThis.__configPuts = (globalThis.__configPuts ?? 0) + 1;
        if (path === '/api/v1/config/validate' || (path === '/api/v1/config' && init && init.method === 'PUT')) await new Promise((resolve) => setTimeout(resolve, 800));
        return original(path, init);
      }
    ` })
  })
}

async function openSettings(page: Page, group: RegExp): Promise<void> {
  await page.goto('/config')
  await page.getByRole('tab', { name: '基础设置', exact: true }).click()
  await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: group }).click()
}

test('保存条按「一件东西」数改了几处，保存后停在原来那一组 @responsive', async ({ page }) => {
  await slowSave(page)
  await openSettings(page, /基础与监听/)
  await page.getByLabel('上游超时 (ms)', { exact: true }).fill('2000')
  if ((page.viewportSize()?.width ?? 1440) <= 860) await page.getByRole('button', { name: '全部设置' }).click()
  await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: /缓存与后台刷新/ }).click()
  await page.getByLabel('缓存容量', { exact: true }).fill('30000')
  // 两项设置，就是两处；不按字段、不按字符数。 / Two settings are two changes, not a field or character count.
  await expect(page.locator('.config-save-state')).toContainText('已修改 2 处')

  const button = page.getByRole('button', { name: '保存并热加载', exact: true })
  const idleBox = await button.boundingBox()
  await button.click()
  // 在忙时按钮保持墨色、标成忙；再点一次不会再存一遍。 / While busy the button stays ink and is marked busy; a second press does not save again.
  const busy = page.locator('.config-save-button')
  await expect(busy).toHaveAttribute('aria-busy', 'true')
  // 按钮不挪也不变宽：手机上备注和校验只是看不见，位置还在（审计第三轮 S1）
  // The button neither moves nor widens: on a phone 备注 and 校验 are only hidden and keep their place (audit round 3, S1)
  const busyBox = await busy.boundingBox()
  expect(Math.round(busyBox!.x)).toBe(Math.round(idleBox!.x))
  expect(Math.round(busyBox!.width)).toBe(Math.round(idleBox!.width))
  // 不是禁用：没有 disabled，也没有变成禁用的灰色。 / Not disabled: no disabled attribute and not the greyed disabled look.
  await expect(busy).not.toHaveAttribute('disabled')
  expect(await busy.evaluate((element) => Number(getComputedStyle(element).opacity))).toBe(1)
  const busyBarTop = (await page.locator('.config-savebar').boundingBox())!.y
  await busy.click({ force: true })
  // 结果写在保存栏上：打勾、「已生效 · 版本 #19」，按钮收起，三秒后整条淡出；刷新不换成骨架，人还在缓存那一组。
  // The outcome is in the save bar: a tick and 已生效 · 版本 #19 with the buttons gone, fading after three seconds;
  // the refresh keeps the editor, so the cache group stays open.
  await expect(page.locator('.config-save-state')).toContainText('已生效 · 版本 #19')
  await expect(page.locator('.config-save-check')).toBeVisible()
  await expect(page.getByRole('button', { name: '保存并热加载', exact: true })).toHaveCount(0)
  // 保存栏的上沿在「已生效」时不跳：撑住的是忙时量到的原高度，不是取整后的；「已用 N 秒」出现时也不撑高半个像素
  // （审计第二轮 S5、第五轮 S1、第六轮 C6）
  // The bar's top edge does not jump in the done state: it holds the exact busy height, not a rounded one, and 已用 N 秒 appearing
  // grows nothing by half a pixel either (audit round 2 S5, round 5 S1, round 6 C6)
  expect(Math.abs((await page.locator('.config-savebar').boundingBox())!.y - busyBarTop)).toBeLessThanOrEqual(0.1)
  // 只存了一次：版本只加了一个，没有因重复提交失败。 / Saved once: exactly one new version and no failure from a repeat submit.
  await expect(page.locator('.config-heading .ui-ph__meta')).toContainText('版本 #19')
  // 两次请求的时间过去后，保存请求只发出过一次。 / After two more requests' worth of time, only one save request was sent.
  await page.waitForTimeout(2000)
  expect(await page.evaluate(() => (globalThis as { __configPuts?: number }).__configPuts)).toBe(1)
  await expect(page.locator('.config-savebar')).toHaveCount(0)
  await expect(page.getByLabel('缓存容量', { exact: true })).toHaveValue('30000')
  await expect(page.getByRole('navigation', { name: '设置分组', includeHidden: true }).getByRole('button', { name: /缓存与后台刷新/, includeHidden: true })).toHaveAttribute('aria-current', 'true')
})

// 改过的设置在它那一行的名字后面、在分组上都有墨点，改回原值就消失（规范 8.1，审计第三轮 T8）
// A changed setting gets an ink dot after its name and on its group, gone again once the value is back (spec 8.1, audit round 3, T8)
test('改过的设置和它的分组画墨点，改回去就没有', async ({ page }) => {
  await openSettings(page, /基础与监听/)
  const field = page.getByLabel('上游超时 (ms)', { exact: true })
  const row = page.locator('.ui-setrow', { has: field })
  const group = page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: /基础与监听/ })
  const original = await field.inputValue()
  await expect(row.locator('.settings-dot')).toHaveCount(0)
  await field.fill('2000')
  await expect(row.locator('.settings-dot')).toHaveCount(1)
  await expect(group.locator('.settings-dot')).toHaveCount(1)
  await expect(field).toHaveAttribute('aria-description', '已修改')
  await field.fill(original)
  await expect(row.locator('.settings-dot')).toHaveCount(0)
  await expect(group.locator('.settings-dot')).toHaveCount(0)
})

// 窄屏上保存栏出现时，JSON 视图停在它上方 16，和桌面一样，页面不滚（审计第二轮 V1、第三轮 V1）
// On narrow screens the JSON view stops 16 above the save bar as on desktop, and the page does not scroll (audit round 2 V1, round 3 V1)
test('窄屏上 JSON 视图停在保存栏上方 16，页面不滚 @responsive', async ({ page }, testInfo) => {
  if (testInfo.project.name !== 'mobile') await page.setViewportSize({ width: 768, height: 1024 })
  await openSettings(page, /缓存与后台刷新/)
  await page.getByLabel('缓存容量', { exact: true }).fill('30000')
  await page.getByRole('tab', { name: '解析编排', exact: true }).click()
  await page.getByRole('button', { name: 'JSON', exact: true }).click()
  await expect(page.locator('.config-savebar')).toBeVisible()
  // 量的是看得见的框（面板的边线），不是里面的编辑器 / Measured to the visible frame (the panel's border), not the editor inside it
  const frame = await page.locator('.workbench-document-panel').boundingBox()
  const bar = await page.locator('.config-savebar').boundingBox()
  expect(Math.round(bar!.y - (frame!.y + frame!.height))).toBe(16)
  expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(0)
})

// 保存失败时按钮不挪：短的分组里保存栏也停在视口底边上方，原因多出一行时往上长（审计第七轮 S3）；
// 手机上两行的保存栏里字到按钮一样远，失败时也是（审计第七轮 S2）
// A failed save never moves the button: on a short group the bar still rests above the viewport bottom and grows upward when the reason
// adds a row (audit round 7, S3); on a phone the text sits as far from the buttons in a failed bar as in any two-row bar (audit round 7, S2)
test('保存失败时按钮不挪，字到按钮和平时一样远 @responsive', async ({ page }) => {
  const phone = (page.viewportSize()?.width ?? 1440) <= 640
  if (!phone) await page.setViewportSize({ width: 1024, height: 900 })
  await rejectValidation(page)
  await openSettings(page, /缓存与后台刷新/)
  await page.getByLabel('缓存容量', { exact: true }).fill('30000')
  const save = page.getByRole('button', { name: '保存并热加载', exact: true })
  await expect(save).toBeVisible()
  // 保存栏升起的动画走完再量 / Measure once the bar has finished rising
  const settled = () => expect.poll(() => page.locator('.config-savebar').evaluate((bar) => bar.getAnimations({ subtree: true }).length)).toBe(0)
  await settled()
  const gap = () => page.locator('.config-savebar').evaluate((bar) => {
    const range = document.createRange()
    range.selectNodeContents(bar.querySelector('.ui-savebar__status')!)
    const text = Math.max(...[...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => rect.bottom))
    return bar.querySelector('.config-save-button')!.getBoundingClientRect().top - text
  })
  const before = (await save.boundingBox())!
  const idleGap = await gap()
  await save.click()
  await expect(page.locator('.config-save-state .ui-savebar__verdict')).toHaveText('没有通过校验')
  await settled()
  const after = (await save.boundingBox())!
  expect(Math.abs(after.y - before.y), '保存按钮挪了').toBeLessThanOrEqual(0.5)
  // 桌面上短的分组里保存栏也正好停在视口底边上方 24，和解析编排一样（审计第八轮 S1）
  // On desktop the bar rests exactly 24 above the viewport bottom on a short group too, as on 解析编排 (audit round 8, S1)
  if (!phone) {
    // 文档区的上沿按量出来的整数算，会有不到 1 的零头，工作台也一样；差 2 就是错的那种（第八轮 S1 的 26）
    // The document top is measured to a whole pixel, leaving under 1 of rounding, as on the workbench; an error is 2 (round 8 S1's 26)
    const barBottom = await page.locator('.config-savebar').evaluate((bar) => innerHeight - bar.getBoundingClientRect().bottom)
    expect(Math.abs(barBottom - 24), '保存栏离视口底边').toBeLessThan(1)
  }
  if (phone) expect(Math.abs(await gap() - idleGap), '失败时字到按钮的距离').toBeLessThanOrEqual(1)
})

test('校验没过就停在第 1 步：写明原因，不生成新版本', async ({ page }) => {
  await rejectValidation(page)
  await openSettings(page, /缓存与后台刷新/)
  await page.getByLabel('缓存容量', { exact: true }).fill('30000')
  await page.getByRole('button', { name: '保存并热加载', exact: true }).click()
  const state = page.locator('.config-save-state')
  // 一句结论、一行原因（规范第 8 节） / A verdict and a reason line (spec section 8)
  await expect(state.locator('.ui-savebar__verdict')).toHaveText('没有通过校验')
  await expect(state).toContainText('规则 cn-direct 引用了不存在的上游组')
  await expect(state).toHaveAttribute('role', 'alert')
  // 版本还是原来那个，修改也还在。 / The running version is unchanged and the edit is kept.
  await expect(page.locator('.config-heading .ui-ph__meta')).toContainText('版本 #18')
  await expect(page.getByLabel('缓存容量', { exact: true })).toHaveValue('30000')
  // 再改一笔，过时的失败说明就换回平常那句。 / Another edit replaces the stale failure with the usual sentence.
  await page.getByLabel('缓存容量', { exact: true }).fill('31000')
  await expect(state).toContainText('已修改 1 处')
})
