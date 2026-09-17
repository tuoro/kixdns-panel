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
    // 至少 44px 高，手机上点得准。/ At least 44px tall so a thumb can hit it.
    expect(option!.height, `${label} 高度`).toBeGreaterThanOrEqual(43.5)
  }
  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(pageOverflow, '页面不应横向溢出').toBeLessThanOrEqual(0)
}

/** 占位提示是唯一说明能搜什么的地方，被截断就等于没说。/ The placeholder is the only hint at what can be searched; cut off, it says nothing. */
async function expectPlaceholderFits(page: Page): Promise<void> {
  const { text, box } = await page.locator('.search-field input').evaluate((input: HTMLInputElement) => {
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

  await page.locator('.log-view-tabs button').nth(1).click()
  await expect(page.locator('.audit-line').first()).toBeVisible()
  await expectEveryOptionVisible(page, page.getByRole('group', { name: '审计动作类别' }), ['全部', '配置', '服务', 'KixDNS', '认证', '诊断'])
  await expectPlaceholderFits(page)
  // 刷新和下载仍在视口内。/ Refresh and download still sit inside the viewport.
  for (const title of ['刷新审计记录', '下载筛选结果']) {
    const icon = (await page.getByTitle(title, { exact: true }).boundingBox())!
    expect(icon.x + icon.width, title).toBeLessThanOrEqual(375)
  }
})
