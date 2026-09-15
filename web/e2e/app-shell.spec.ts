import { expect, test } from '@playwright/test'

test('共享导航在桌面和手机均能到达所有页面 @responsive', async ({ page }, testInfo) => {
  await page.goto('/')
  const mobile = testInfo.project.name === 'mobile'
  const navigation = page.getByRole('navigation', { name: mobile ? '移动端导航' : '主导航', exact: true })
  await expect(navigation).toBeVisible()
  await expect(navigation.getByRole('link')).toHaveCount(5)
  await expect(page.locator('.sidebar')).toHaveCount(0)
  for (const [name, path] of [['配置', '/config'], ['日志', '/logs'], ['诊断', '/diagnostics'], ['系统', '/system'], ['概览', '/']]) {
    await navigation.getByRole('link', { name, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`${path}$`))
    await expect(page.locator('main h1')).toHaveCount(1)
    await expect(navigation.getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page')
  }
})

test('账户弹层支持 Escape 恢复焦点、外部关闭和退出登录', async ({ page }) => {
  await page.goto('/')
  const account = page.getByRole('button', { name: /^账户：/ })
  const dialog = page.getByRole('dialog', { name: '账户', exact: true })
  await account.click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(account).toBeFocused()
  await account.click()
  await page.locator('main h1').click()
  await expect(dialog).toHaveCount(0)
  await account.click()
  await dialog.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.locator('.app-shell')).toHaveCount(0)
})

test('键盘跳至内容时标题不被固定导航遮挡', async ({ page }) => {
  await page.goto('/')
  const skip = page.getByRole('link', { name: '跳至内容', exact: true })
  await skip.focus()
  await skip.press('Enter')
  await expect(page.locator('main')).toBeFocused()
  const header = await page.locator('.app-header').boundingBox()
  const heading = await page.locator('main h1').boundingBox()
  expect(heading!.y).toBeGreaterThanOrEqual(header!.y + header!.height)
})

test('不同屏宽无页面横向溢出，手机标题与点击区域保持合适尺寸 @responsive', async ({ page }, testInfo) => {
  const widths = testInfo.project.name === 'mobile' ? [360, 390, 768] : [1024, 1440]
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 })
    for (const path of ['/', '/config', '/diagnostics', '/logs', '/system']) {
      await page.goto(path)
      await expect(page.locator('main h1')).toBeVisible()
      const layout = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        heading: parseFloat(getComputedStyle(document.querySelector('main h1')!).fontSize),
      }))
      expect(layout.scroll, `${path} at ${width}px`).toBeLessThanOrEqual(layout.width)
      /*
       * 页面级不溢出挡不住「控件从自己那一格里挤出去」。凭据块的删除按钮就是这么
       * 漏过去的：那一格写死 34px，而 .icon-button 是 40px、窄屏还要满足 44px 的
       * 触控下限，按钮于是比格子宽，右边缘压出去。没有谁裁剪它，整页也没被撑宽，
       * 上面那条断言一路绿灯。
       *
       * 所以这里量的是每个控件对它「自己那一格」的关系——父元素的内容盒，padding
       * 以内。绝对定位的控件（显示/隐藏 Token 的眼睛）按设计就贴在定位父元素的边上，
       * 跳过。
       *
       * A page that does not scroll sideways can still have controls squeezed out
       * of the slot holding them. That is how the credential block's delete button
       * slipped through: its track was a fixed 34px while .icon-button is 40px and
       * rises to the 44px touch minimum on narrow screens, so the button outgrew
       * its track and its right edge pushed past it. Nothing clipped it and the
       * page never widened, so the assertion above stayed green.
       *
       * What is measured here is therefore each control against its own slot — its
       * parent's content box, inside the padding. Absolutely positioned controls
       * (the eye that reveals the token) sit on their containing block's edge by
       * design and are skipped.
       */
      const escaped = await page.evaluate(() => {
        const out: string[] = []
        for (const panel of document.querySelectorAll('.panel')) {
          for (const control of panel.querySelectorAll('button, input, select, textarea')) {
            const box = control.getBoundingClientRect()
            if (box.width === 0 && box.height === 0) continue
            if (getComputedStyle(control).position === 'absolute') continue
            const slot = control.parentElement
            if (!slot) continue
            const slotBox = slot.getBoundingClientRect()
            const style = getComputedStyle(slot)
            const left = slotBox.left + slot.clientLeft + parseFloat(style.paddingLeft)
            const right = left + slot.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
            if (box.left < left - 0.5 || box.right > right + 0.5) {
              out.push(`${control.className || control.tagName} 挤出 ${slot.className || slot.tagName}`)
            }
          }
        }
        return out
      })
      expect(escaped, `${path} at ${width}px`).toEqual([])
      if (width <= 700) expect(layout.heading, `${path} at ${width}px`).toBeLessThanOrEqual(22)
      if (width <= 860) {
        const target = await page.locator('.mobile-nav a').first().boundingBox()
        expect(target?.height).toBeGreaterThanOrEqual(44)
      }
    }
  }
})
