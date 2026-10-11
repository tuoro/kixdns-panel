import { expect, test, type Page } from '@playwright/test'

/**
 * 可达性守卫：每一页浅色、暗色两套里，看得见的字和底色的对比度都过 WCAG AA（正文 4.5:1，大字 3:1）；
 * 标题不跳级；出错提示连到输入框；不画框的添加行聚焦时看得出来。谁改颜色掉到线下，这里就红。
 *
 * Accessibility guard: on every page, in both light and dark, visible text against its ground meets WCAG AA (4.5:1 body, 3:1 large);
 * headings never skip a level; error messages are linked to their fields; borderless add rows show focus. A colour change below the line turns this red.
 */
const CONTRAST = `(() => {
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }); return .2126 * r + .7152 * g + .0722 * b }
  const parse = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s); if (!m) return null; const p = m[1].split(',').map(Number); return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 } }
  const bgOf = (el) => { let e = el; while (e) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.9) return c.rgb; e = e.parentElement } return parse(getComputedStyle(document.body).backgroundColor)?.rgb ?? [255, 255, 255] }
  const out = []; const seen = new Set()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let n
  while ((n = walker.nextNode())) {
    const el = n.parentElement
    if (!el || seen.has(el) || !n.textContent.trim()) continue
    seen.add(el)
    // 装饰性的（aria-hidden）、读屏专用的、停用的控件不算 / Decorative (aria-hidden), screen-reader-only and disabled controls are exempt
    if (el.closest('[aria-hidden="true"], .visually-hidden, .skip-link, :disabled, [aria-disabled="true"]')) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || !el.getClientRects().length || Number(cs.opacity) < 0.9) continue
    const fg = parse(cs.color); if (!fg || fg.a < 0.9) continue
    const L1 = lum(fg.rgb), L2 = lum(bgOf(el)); const ratio = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05)
    // WCAG 的大字：18pt（24px），或 14pt（18.66px）加粗 / WCAG large text: 18pt (24px), or 14pt (18.66px) bold
    const size = parseFloat(cs.fontSize); const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700)
    if (ratio < (large ? 3 : 4.5)) out.push(ratio.toFixed(2) + ' ' + size + 'px ' + String(el.className || el.tagName).slice(0, 40) + ' 「' + n.textContent.trim().slice(0, 16) + '」')
  }
  return out
})()`

const PAGES: [string, string][] = [['概览', '/'], ['日志', '/logs'], ['诊断', '/diagnostics'], ['系统', '/system'], ['规则', '/config'], ['上游组', '/config?section=upstreams'], ['域名映射', '/config?section=mapping'], ['基础设置', '/config?section=settings']]

async function visit(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await expect(page.locator('main h1')).toBeVisible()
  await expect(page.locator('.cfg__skeleton, .sk')).toHaveCount(0, { timeout: 10_000 }).catch(() => {})
  await page.waitForTimeout(400)
}

for (const scheme of ['light', 'dark'] as const) {
  test(`对比度：${scheme === 'light' ? '浅色' : '暗色'}下每一页的字都过 WCAG AA @responsive`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    const bad: string[] = []
    for (const [name, path] of PAGES) {
      await visit(page, path)
      for (const b of await page.evaluate<string[]>(CONTRAST)) bad.push(`${name}: ${b}`)
    }
    // 规则编辑页 / The rule editor
    await visit(page, '/config')
    await page.getByRole('button', { name: '新建规则', exact: true }).first().click()
    await expect(page.locator('.editor')).toBeVisible()
    await page.waitForTimeout(300)
    for (const b of await page.evaluate<string[]>(CONTRAST)) bad.push(`规则编辑: ${b}`)
    expect(bad, bad.join('\n')).toEqual([])
  })
}

test('标题不跳级：每一页从 h1 开始，往下一次只深一级 @responsive', async ({ page }) => {
  const bad: string[] = []
  for (const [name, path] of PAGES) {
    await visit(page, path)
    const levels = await page.evaluate(() => [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter((h) => h.getClientRects().length).map((h) => Number(h.tagName[1])))
    if (levels[0] !== 1) bad.push(`${name}: 第一个标题是 h${levels[0]}`)
    for (let i = 1; i < levels.length; i++) if (levels[i]! > levels[i - 1]! + 1) bad.push(`${name}: h${levels[i - 1]} 后面直接 h${levels[i]}`)
  }
  expect(bad, bad.join('\n')).toEqual([])
})

test('条件没填值就保存：错误提示连到输入框上，读屏器读完名字接着读它', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机上条件在弹层里改，错误写在那一行的按钮上 / on phones a condition is edited in a sheet and the error sits on its row button')
  await visit(page, '/config')
  await page.getByRole('button', { name: '新建规则', exact: true }).first().click()
  const editor = page.locator('.editor')
  await expect(editor).toBeVisible()
  await editor.getByRole('button', { name: '添加条件' }).first().click()
  await page.getByRole('menuitem', { name: '域名', exact: true }).click()
  const field = editor.getByRole('textbox', { name: '域名', exact: true })
  await expect(field).toBeVisible()
  await expect(field).not.toHaveAttribute('aria-describedby')
  await editor.getByRole('button', { name: /^(保存|添加规则)$/ }).click()
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  const id = await field.getAttribute('aria-describedby')
  expect(id).toBeTruthy()
  const message = page.locator(`[id="${id}"]`)
  await expect(message).toHaveClass(/ui-field-error/)
  await expect(message).not.toBeEmpty()
})

test('不画框的添加行聚焦时，左边有一条品牌色竖条', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机上快速添加常显、带外框 / on phones quick add is always shown, framed')
  await visit(page, '/config')
  await page.getByRole('button', { name: '快速添加', exact: true }).click()
  await page.getByLabel('快速添加：域名、GeoSite 或 IP 网段').focus()
  const bar = await page.locator('.qadd').evaluate((el) => { const cs = getComputedStyle(el, '::before'); return { w: cs.width, bg: cs.backgroundColor, content: cs.content } })
  const accent = await page.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--accent)'; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c })
  expect(bar.content).not.toBe('none')
  expect(bar.w).toBe('3px')
  expect(bar.bg).toBe(accent)
  await visit(page, '/config?section=mapping')
  await page.getByLabel('要映射的域名').focus()
  expect(await page.locator('.rw__add').evaluate((el) => getComputedStyle(el, '::before').backgroundColor)).toBe(accent)
})
