import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * 「安静的账本」组件清单（/ui，只在开发服务器里有）。页面改版只用这些零件拼，
 * 所以零件的行为在这里一次测清：指示块跟着选中走、减少动态效果时直接到位、
 * 数字只弹变了的位、长操作的状态、提示条，以及 375 下的触控尺寸和两行记录。
 *
 * The component sheet (/ui, dev server only). Redesigned pages are built from
 * these parts alone, so their behaviour is pinned here once: the indicator
 * follows the selection, reduced motion lands it at once, numbers pop only
 * the changed positions, long operations report their state, the banner
 * holds new data back, and at 375 every target is tappable and records
 * collapse to two lines.
 */
async function open(page: Page): Promise<void> {
  await page.goto('/ui')
  await expect(page.locator('.ui-kit')).toBeVisible()
}

/** 指示块的位置和宽度等于选中那一项 / The indicator sits exactly under the selected item */
async function expectIndicatorOn(group: Locator, selected: string, indicator: string): Promise<void> {
  await expect.poll(() => group.evaluate((element, [selectedSelector, indicatorSelector]) => {
    const target = element.querySelector<HTMLElement>(selectedSelector!)!
    const ind = element.querySelector<HTMLElement>(indicatorSelector!)!
    const style = getComputedStyle(ind)
    const x = new DOMMatrixReadOnly(style.transform).m41
    return Math.abs(x - target.offsetLeft) < 0.5 && Math.abs(parseFloat(style.width) - target.offsetWidth) < 0.5
  }, [selected, indicator])).toBe(true)
}

test('区块页签：点击和方向键都换选中，指示块滑到选中那一项下面 @responsive', async ({ page }) => {
  await open(page)
  const tabs = page.getByRole('tablist', { name: '概览视图' })
  await expectIndicatorOn(tabs, '[aria-selected="true"]', '.ui-tabs__ind')

  await tabs.getByRole('tab', { name: '查询排行' }).click()
  await expect(tabs.getByRole('tab', { name: '查询排行' })).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.getByRole('tab', { name: '运行情况' })).toHaveAttribute('aria-selected', 'false')
  await expectIndicatorOn(tabs, '[aria-selected="true"]', '.ui-tabs__ind')

  await page.keyboard.press('ArrowRight')
  await expect(tabs.getByRole('tab', { name: '规则命中' })).toBeFocused()
  await expect(tabs.getByRole('tab', { name: '规则命中' })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Home')
  await expect(tabs.getByRole('tab', { name: '运行情况' })).toHaveAttribute('aria-selected', 'true')
  await expectIndicatorOn(tabs, '[aria-selected="true"]', '.ui-tabs__ind')
})

test('筛选分段：选中用 aria-pressed 表达，凸起块跟着走 @responsive', async ({ page }) => {
  await open(page)
  const levels = page.getByRole('group', { name: '日志级别' })
  await expectIndicatorOn(levels, '[aria-pressed="true"]', '.ui-seg__ind')
  await levels.getByRole('button', { name: '警告', exact: true }).click()
  await expect(levels.getByRole('button', { name: '警告', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(levels.getByRole('button', { name: '全部', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await expectIndicatorOn(levels, '[aria-pressed="true"]', '.ui-seg__ind')
})

test('数字刷新时只有变了的那几位弹入', async ({ page }) => {
  await open(page)
  const figure = page.locator('.ui-kit__figure .ui-num')
  await expect(figure.locator('.ui-num__digit--pop')).toHaveCount(0)
  const before = await figure.getAttribute('aria-label')
  await page.getByRole('button', { name: '模拟一次刷新' }).click()
  await expect(figure).not.toHaveAttribute('aria-label', before!)
  const popped = await figure.locator('.ui-num__digit--pop').count()
  const digits = await figure.locator('.ui-num__digit').count()
  // 每次加 180 到 1079：个位到千位之间会变，百万位和千万位不变
  // Each refresh adds 180 to 1079: the low positions change, the millions do not
  expect(popped).toBeGreaterThan(0)
  expect(popped).toBeLessThan(digits)
  await expect(figure.locator('.ui-num__digit').first()).not.toHaveClass(/ui-num__digit--pop/)
})

test('系统开了减少动态效果：指示块直接到位，数字和提示条不动', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await open(page)
  const tabs = page.getByRole('tablist', { name: '概览视图' })
  // 全局的减少动态效果规则把过渡压到 0.01 毫秒，等于直接到位
  // The global reduced-motion rule squeezes transitions to 0.01 ms, which is landing at once
  const seconds = (value: string) => parseFloat(value) * (value.endsWith('ms') ? 0.001 : 1)
  expect(seconds(await tabs.locator('.ui-tabs__ind').evaluate((el) => getComputedStyle(el).transitionDuration))).toBeLessThan(0.001)
  expect(seconds(await page.getByRole('group', { name: '日志级别' }).locator('.ui-seg__ind').evaluate((el) => getComputedStyle(el).transitionDuration))).toBeLessThan(0.001)
  await page.getByRole('button', { name: '模拟一次刷新' }).click()
  const pop = page.locator('.ui-kit__figure .ui-num__digit--pop').first()
  await expect(pop).toBeAttached()
  expect(await pop.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
  await page.getByRole('button', { name: '来了 3 条新日志' }).click()
  expect(await page.locator('.ui-banner').evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
})

test('状态胶囊：进行中写进度和已用时间，完成打勾，失败写原因 @responsive', async ({ page }) => {
  await open(page)
  const task = page.locator('.ui-task')
  await expect(task).toHaveAttribute('data-state', 'idle')
  await task.getByRole('button', { name: '安装并切换' }).click()
  await expect(task).toHaveAttribute('data-state', 'run')
  await expect(task.getByRole('progressbar')).toBeVisible()
  await expect(task.getByRole('status')).toContainText(/正在下载 .* MB/)
  await expect(task.getByRole('status')).toContainText(/已用 \d+ 秒/)
  await expect(task).toHaveAttribute('data-state', 'done', { timeout: 10_000 })
  await expect(task.getByRole('status')).toHaveText('已切换到 Run #30235703570')
  await expect(task.getByRole('progressbar')).toHaveCount(0)

  await task.getByRole('button', { name: '复原' }).click()
  await task.getByRole('button', { name: '演示失败' }).click()
  await expect(task).toHaveAttribute('data-state', 'fail')
  await expect(task.getByRole('status')).toContainText('检查网络后重试')
})

test('新数据提示条：新日志先攒着，点了才放进列表 @responsive', async ({ page }) => {
  await open(page)
  const lines = page.locator('.ui-kit__log .log-line')
  await expect(lines).toHaveCount(3)
  await page.getByRole('button', { name: '来了 3 条新日志' }).click()
  const banner = page.locator('.ui-banner')
  await expect(banner).toHaveText('有 3 条新日志，点击显示')
  await expect(lines).toHaveCount(3)
  await banner.click()
  await expect(banner).toHaveCount(0)
  await expect(lines).toHaveCount(6)
  await expect(lines.first()).toContainText('15:28:07.000')
})

test('同一行里的控件一样高：按钮、图标按钮、分段、输入框不混两种尺寸 @responsive', async ({ page }) => {
  await open(page)
  await page.locator('.ui-task').getByRole('button', { name: '安装并切换' }).click()
  const rows = await page.evaluate(() => {
    const containers = document.querySelectorAll<HTMLElement>('.ui-kit__row, .ui-ph__actions, .ui-card__actions, .ui-task__actions, .ui-rec__act')
    return [...containers].map((row) => ({
      text: row.textContent?.trim().slice(0, 40) ?? '',
      heights: [...row.querySelectorAll<HTMLElement>(':scope > button, :scope > a.ui-btn, :scope > .ui-seg, :scope > .ui-input')]
        .map((control) => Math.round(control.getBoundingClientRect().height * 2) / 2),
    })).filter((row) => row.heights.length >= 2)
  })
  expect(rows.length).toBeGreaterThan(3)
  for (const row of rows) expect(new Set(row.heights).size, `${row.text}: ${row.heights.join(' / ')}`).toBe(1)
})

test('375 下能点的东西至少 44 像素，记录变两行，页面不横向溢出 @responsive', async ({ page }) => {
  await open(page)
  const phone = page.viewportSize()!.width <= 640
  const heights = await page.evaluate(() => {
    const measure = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].map((el) => el.getBoundingClientRect().height)
    return {
      regular: measure('.ui-btn:not(.ui-btn--sm)'),
      small: measure('.ui-btn--sm'),
      icon: measure('.ui-icon-btn:not(.ui-icon-btn--sm)'),
      seg: measure('.ui-seg:not(.ui-seg--sm)'),
      segSmall: measure('.ui-seg--sm'),
      input: measure('.ui-input:not(.ui-input--sm)'),
      tab: measure('.ui-tabs__tab'),
    }
  })
  const floor = phone
    ? { regular: 44, small: 36, icon: 44, seg: 44, segSmall: 36, input: 44, tab: 44 }
    : { regular: 36, small: 30, icon: 36, seg: 36, segSmall: 30, input: 36, tab: 0 }
  for (const [kind, values] of Object.entries(heights)) {
    expect(values.length, kind).toBeGreaterThan(0)
    for (const height of values) expect(height, kind).toBeGreaterThanOrEqual(floor[kind as keyof typeof floor] - 0.5)
  }
  const record = page.locator('.ui-kit__ledger .ui-rec').first()
  if (phone) {
    await expect(record.locator('.ui-rec__n').first()).toBeHidden()
    await expect(record.locator('.ui-rec__phone')).toBeVisible()
  } else {
    await expect(record.locator('.ui-rec__n').first()).toBeVisible()
    await expect(record.locator('.ui-rec__phone')).toBeHidden()
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
