import { expect, test, type Page } from '@playwright/test'

async function openDiff(page: Page) {
  await page.goto('/config')
  await expect(page.locator('.app-shell')).toBeVisible()
  await page.getByRole('button', { name: '历史版本', exact: true }).click()
  const history = page.getByRole('dialog', { name: '历史版本' })
  await expect(history.locator('.config-history__row')).toHaveCount(4)
  // 历史是浏览面：点一行就打开它和当前的比较（规范 3.8） / History is a browse surface: clicking a row opens its comparison (spec 3.8)
  const trigger = history.getByTitle(/^比较版本 #\d+ 和当前$/).first()
  await trigger.click()
  const diff = page.locator('.config-diff-dialog')
  await expect(diff).toBeVisible()
  await expect(diff.getByText(/处不同/)).toBeVisible()
  return { history, trigger, diff }
}

function focusInsideDiff(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean(document.activeElement?.closest('.config-diff-dialog')))
}

test('版本差异是真正的模态框：焦点留在框内，Esc 关闭后回到触发按钮 @responsive', async ({ page }) => {
  const { history, trigger, diff } = await openDiff(page)

  expect(await focusInsideDiff(page), '打开后焦点在框内').toBe(true)
  // 来回 Tab 足够多次，覆盖框内所有可聚焦元素再绕一圈。
  // Tab back and forth enough times to pass every focusable element and wrap.
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press('Tab')
    expect(await focusInsideDiff(page), `第 ${step + 1} 次 Tab 后焦点仍在框内`).toBe(true)
  }
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press('Shift+Tab')
    expect(await focusInsideDiff(page), `第 ${step + 1} 次 Shift+Tab 后焦点仍在框内`).toBe(true)
  }

  await page.keyboard.press('Escape')
  await expect(diff).toHaveCount(0)
  // 差异框从版本历史里打开，关掉之后回到历史里原来那个按钮，可以接着比较下一个版本。
  // The diff opens from the version history; closing it returns to the very
  // button in the history, ready to compare the next version.
  await expect(history).toBeVisible()
  await expect(trigger).toBeFocused()

  // 再按一次 Esc 才关掉版本历史：一次 Esc 只关最上面那一层。
  // A second Esc closes the history: one Esc only closes the topmost layer.
  await page.keyboard.press('Escape')
  await expect(history).toHaveCount(0)
})

test('点击遮罩只关闭差异框，焦点同样回到触发按钮 @responsive', async ({ page }) => {
  const { history, trigger, diff } = await openDiff(page)
  const viewport = page.viewportSize()!
  if (viewport.width <= 640) {
    // 手机上对话框占满整屏（规范 3.5），没有遮罩可点，用右上角的关闭
    // On a phone the dialog fills the screen (spec 3.5): there is no backdrop, so close it from the top right
    const box = await diff.boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(viewport.width - 1)
    expect(box!.height).toBeGreaterThanOrEqual(viewport.height - 1)
    await diff.getByRole('button', { name: '关闭', exact: true }).click()
  } else {
    // 点在框外的遮罩上。/ Click the backdrop outside the panel.
    await page.mouse.click(4, 4)
  }
  await expect(diff).toHaveCount(0)
  await expect(history).toBeVisible()
  await expect(trigger).toBeFocused()
})
