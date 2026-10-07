import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * 每个选项都要完整落在分段控件自己的可见区域和视口里。
 *
 * 只查页面没有横向溢出是不够的：控件自己是一个隐藏了滚动条的横向滚动容器时，
 * 页面宽度照样正常，被裁掉的选项却既看不到、也没有任何可滚动的提示。
 *
 * Every option has to sit wholly inside the control's own visible box and the
 * viewport. Checking the page for horizontal overflow is not enough: when the
 * control is itself a sideways scroller with its scrollbar hidden, the page
 * width stays fine while clipped options are neither visible nor hinted at.
 */
async function expectEveryOptionVisible(page: Page, group: Locator, labels: string[]): Promise<void> {
  await expect(group).toBeVisible()
  const viewport = page.viewportSize()!
  const box = (await group.boundingBox())!
  const overflow = await group.evaluate((element) => element.scrollWidth - element.clientWidth)
  expect(overflow, '分段控件不应横向滚动').toBeLessThanOrEqual(0)
  for (const label of labels) {
    const option = await group.getByRole('button', { name: label, exact: true }).boundingBox()
    expect(option, label).not.toBeNull()
    expect(option!.x, `${label} 左边缘`).toBeGreaterThanOrEqual(Math.max(0, box.x) - 0.5)
    expect(option!.x + option!.width, `${label} 右边缘`).toBeLessThanOrEqual(Math.min(viewport.width, box.x + box.width) + 0.5)
    // 可点的高度至少 44，手机上点得准。量的是手指点下去能落到这一格的范围，不是画出来的格子：组件库的分段格子画 40 高，
    // 可点区域借外框 2px 内边距补到 44（.ui-seg__opt::after）；两行排开时上一行补不到下面，格子本身就得够高
    // At least 44px tappable so a thumb can hit it. This measures where a tap still lands on the option, not the drawn cell: the
    // kit's segment cells are drawn 40 tall and the hit area borrows the frame's 2px padding to reach 44 (.ui-seg__opt::after);
    // across two rows the top row cannot borrow from below, so the cell itself must be tall enough
    const hit = await group.getByRole('button', { name: label, exact: true }).evaluate((element) => {
      const box = element.getBoundingClientRect()
      const x = box.left + box.width / 2
      let top = box.top + 1
      let bottom = box.bottom - 1
      while (top > box.top - 8 && element.contains(document.elementFromPoint(x, top - 1))) top -= 1
      while (bottom < box.bottom + 8 && element.contains(document.elementFromPoint(x, bottom + 1))) bottom += 1
      return bottom - top + 1
    })
    expect(hit, `${label} 可点高度`).toBeGreaterThanOrEqual(43.5)
  }
  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(pageOverflow, '页面不应横向溢出').toBeLessThanOrEqual(0)
}

/** 占位提示是唯一说明能搜什么的地方，被截断就等于没说。/ The placeholder is the only hint at what can be searched; cut off, it says nothing. */
async function expectPlaceholderFits(page: Page): Promise<void> {
  const { text, box } = await page.locator('.log-search input').evaluate((input: HTMLInputElement) => {
    const style = getComputedStyle(input)
    const context = document.createElement('canvas').getContext('2d')!
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    return { text: context.measureText(input.placeholder).width, box: input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) }
  })
  expect(text, '占位提示完整显示').toBeLessThanOrEqual(box)
}

test('375 宽下日志级别和审计类别的每个选项都完整可见 @responsive', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/logs')
  await expect(page.locator('.log-line').first()).toBeVisible()

  await expectEveryOptionVisible(page, page.getByRole('group', { name: '日志级别' }), ['全部', '错误', '警告', '信息'])
  await expectPlaceholderFits(page)

  await page.getByRole('tab', { name: '操作审计', exact: true }).click()
  await expect(page.locator('.audit-line').first()).toBeVisible()
  await expectEveryOptionVisible(page, page.getByRole('group', { name: '审计动作类别' }), ['全部', '配置', '服务', 'KixDNS', '认证', '诊断'])
  await expectPlaceholderFits(page)
  // 刷新和下载仍在视口内。/ Refresh and download still sit inside the viewport.
  for (const title of ['刷新审计记录', '下载筛选结果']) {
    const icon = (await page.getByTitle(title, { exact: true }).boundingBox())!
    expect(icon.x + icon.width, title).toBeLessThanOrEqual(375)
  }
})

// 日志页和别的页一套说法：页头写「日志」，区块页签在卡片外面，级别筛选是组件库的分段——选中是凸起的白块，不是黑底白字
// The logs page speaks the same language as the rest: the header reads 日志, the section tabs sit outside the card, and the
// level filter is the kit segment, its pressed option a raised white block rather than white text on a dark fill
test('日志页用组件库的页头、区块页签和筛选分段 @responsive', async ({ page }) => {
  await page.goto('/logs')
  await expect(page.locator('.log-line').first()).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: '日志', exact: true })).toBeVisible()
  const tabs = page.getByRole('tablist', { name: '日志视图' })
  await expect(tabs.getByRole('tab')).toHaveText(['运行日志', '操作审计'])
  expect(await tabs.evaluate((element) => Boolean(element.closest('.log-console')))).toBe(false)
  const level = page.getByRole('group', { name: '日志级别' })
  await expect(level).toHaveClass(/\bui-seg\b/)
  const ink = await level.getByRole('button', { name: '全部', exact: true }).evaluate((element) => {
    const [r, g, b] = getComputedStyle(element).color.match(/\d+/g)!.map(Number)
    return (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255
  })
  expect(ink, '选中项是深色字').toBeLessThan(0.3)
})
