import { expect, test } from '@playwright/test'

test('共享导航在桌面和手机均能到达所有页面 @responsive', async ({ page }, testInfo) => {
  await page.goto('/')
  const mobile = testInfo.project.name === 'mobile'
  const navigation = page.getByRole('navigation', { name: mobile ? '移动端导航' : '主导航', exact: true })
  await expect(navigation).toBeVisible()
  // 桌面侧栏分组：配置的四个子页各一项，规则是默认页不带参数 / The desktop sidebar's groups: one item per config sub-page, 规则 the default without a parameter
  await expect(navigation.getByRole('link')).toHaveCount(mobile ? 5 : 8)
  await expect(page.locator('.sidebar')).toHaveCount(0)
  const pages = mobile
    ? [['配置', '/config'], ['日志', '/logs'], ['诊断', '/diagnostics'], ['系统', '/system'], ['概览', '/']]
    : [['规则', '/config'], ['上游组', '/config\\?section=upstreams'], ['域名映射', '/config\\?section=mapping'], ['基础设置', '/config\\?section=settings'], ['规则', '/config'], ['日志', '/logs'], ['诊断', '/diagnostics'], ['系统', '/system'], ['概览', '/']]
  for (const [name, path] of pages) {
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

test('键盘跳至内容后标题整个在视口里，不被侧栏或任何固定元素盖住', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('main h1')).toBeVisible()
  // 先滚到页底：跳至内容要把人带回标题，不是停在原地 / Scroll to the bottom first: the skip link must bring the reader back to the title, not leave them where they are
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const skip = page.getByRole('link', { name: '跳至内容', exact: true })
  await skip.focus()
  await skip.press('Enter')
  await expect(page.locator('main')).toBeFocused()
  // 桌面导航是整高的侧栏，没有「标题在顶栏下面」可量。要保证的是：标题整个在视口里，
  // 它四角和中心点上最上层的元素都是标题自己——没有固定或粘性的东西压在上面。
  // The desktop navigation is a full-height sidebar, so there is no bar for the title to sit below. What must hold:
  // the heading is entirely inside the viewport, and the topmost element at its four corners and centre is the heading
  // itself, with nothing fixed or sticky laid over it.
  const check = await page.locator('main h1').evaluate((heading) => {
    const box = heading.getBoundingClientRect()
    const inside = box.top >= 0 && box.left >= 0 && box.bottom <= window.innerHeight && box.right <= window.innerWidth
    const points: Array<[number, number]> = [
      [box.left + 1, box.top + 1], [box.right - 1, box.top + 1],
      [box.left + 1, box.bottom - 1], [box.right - 1, box.bottom - 1],
      [box.left + box.width / 2, box.top + box.height / 2],
    ]
    const blockers = points
      .map(([x, y]) => document.elementFromPoint(x, y))
      .filter((element) => element && !heading.contains(element))
      .map((element) => element!.className || element!.tagName)
    return { inside, blockers }
  })
  expect(check.inside).toBe(true)
  expect(check.blockers).toEqual([])
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

// 页头读完是宽屏两行的「标签 / 值」、手机一行状态：读完之前的占位一样高，数据到了标签页、工具行和卡片不往下跳
// The loaded header is two-line label / value pairs on wide screens and one status line on phones: the placeholder before the read is just as tall, so tabs, toolbars and cards do not jump when data lands
test('页头读完前后一样高，内容不往下跳 @responsive', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-read-slow', 'true'))
  // 手机系统页读完会多出「重启 / 停止」一行，那是能做的事到了，不是占位不准 / On phones the system page gains the 重启 / 停止 row once read: actions arriving, not a placeholder mismatch
  const paths = testInfo.project.name === 'mobile' ? ['/', '/config', '/logs'] : ['/', '/config', '/logs', '/system']
  for (const path of paths) {
    await page.goto(path)
    const header = page.locator('main .ui-ph')
    await expect(page.locator('main .ui-ph .sk')).toBeVisible()
    const loading = (await header.boundingBox())!.height
    await expect(page.locator('main .ui-ph .sk')).toHaveCount(0, { timeout: 10_000 })
    expect(Math.abs((await header.boundingBox())!.height - loading), path).toBeLessThanOrEqual(1)
  }
})

test('断网时内容区顶上挂出「连不上面板」，联网后自己收起 @responsive', async ({ page, context }, testInfo) => {
  await page.goto('/')
  await expect(page.locator('.overview-page')).toBeVisible()
  const banner = page.locator('.conn__inner')
  await expect(banner).toHaveCount(0)
  await context.setOffline(true)
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('连不上面板')
  // 页头不再复述上次读到的「运行中」：点变灰；手机写「状态未知」，宽屏「状态」标签下面只写「未知」
  // The header stops repeating the last-read 运行中: a grey dot; phones read 状态未知, and under the wide 状态 label it reads 未知 only
  const state = page.locator('.overview-heading').locator(testInfo.project.name === 'mobile' ? '.ui-ph__phone' : '.ui-facts > div:first-child b')
  await expect(state).toContainText(testInfo.project.name === 'mobile' ? '状态未知' : '未知')
  if (testInfo.project.name !== 'mobile') await expect(state).toHaveText('未知')
  await expect(state).not.toContainText('运行中')
  await expect(state.locator('.ui-dot')).toHaveClass(/ui-dot--off/)
  // 「已运行」也是上次读到的，不再写；配置版本和「更新于」照写；运行配置卡的「已生效」不上色
  // 已运行 is also last-read and is dropped; the config version and 更新于 stay; the config card's 已生效 loses its colour
  const heading = page.locator('.overview-heading')
  await expect(heading).not.toContainText('已运行')
  await expect(heading).toContainText(testInfo.project.name === 'mobile' ? '版本 #' : '更新于')
  const configTag = page.locator('.overview-config-state')
  await expect(configTag).toHaveText('已生效')
  await expect(configTag).not.toHaveClass(/ui-tag--ok/)
  // 滚到页底也还在：宽屏贴着窗口顶（侧栏不占顶部），手机贴着顶栏下沿 / Still there after scrolling to the bottom: at the window's top on wide screens (the sidebar leaves the top free), under the top bar on phones
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  const top = testInfo.project.name === 'mobile' ? await page.locator('.app-header').evaluate((el) => el.getBoundingClientRect().bottom) : 0
  expect(Math.round((await banner.boundingBox())!.y)).toBe(Math.round(top))
  await context.setOffline(false)
  await expect(banner).toHaveCount(0)
  await expect(page.getByText('已重新连上面板')).toBeVisible()
  // 连上后页头恢复 / Reconnected, the header is restored
  await expect(state).toContainText('运行中')
  await expect(state.locator('.ui-dot')).not.toHaveClass(/ui-dot--off/)
  await expect(heading).toContainText('已运行')
  await expect(configTag).toHaveClass(/ui-tag--ok/)
})

test('连不上面板时配置页和系统页的页头也写「状态未知」，连上后恢复 @responsive', async ({ page, context }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await page.goto('/config')
  const config = mobile ? page.locator('.ui-ph__lead') : page.locator('.cfg__facts > span').first().locator('b')
  await expect(config).toContainText('运行中')
  await context.setOffline(true)
  await expect(page.locator('.conn__inner')).toBeVisible()
  if (mobile) await expect(config).toContainText('状态未知')
  else await expect(config).toHaveText('未知')
  await expect(config).not.toContainText('运行中')
  await expect(config.locator('.ui-dot')).toHaveClass(/ui-dot--off/)
  await context.setOffline(false)
  await expect(page.locator('.conn__inner')).toHaveCount(0)
  await expect(config).toContainText('运行中')

  await page.goto('/system')
  const system = page.locator('.system-heading').locator(mobile ? '.ui-ph__phone' : '.ui-facts > div:first-child b')
  await expect(system).toContainText(mobile ? '运行中' : 'kixdns.service')
  await expect(system).not.toContainText('状态未知')
  await context.setOffline(true)
  await expect(page.locator('.conn__inner')).toBeVisible()
  await expect(system).toContainText('状态未知')
  await expect(system).not.toContainText('运行中')
  await expect(system.locator('.ui-dot')).toHaveClass(/ui-dot--off/)
  await context.setOffline(false)
  await expect(page.locator('.conn__inner')).toHaveCount(0)
  await expect(system).not.toContainText('状态未知')
  await expect(system.locator('.ui-dot')).not.toHaveClass(/ui-dot--off/)
})
