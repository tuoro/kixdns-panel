import { expect, test, type Page } from '@playwright/test'

/**
 * 检查器里改一个字段、底栏出现时，检查器会把改的那一块滚进视野（ConfigGuideLayout 的 revealEdited）。
 * 滚到哪里有三条要守：改的字段整个看得见；上沿和底栏那条线都不从一行字中间切过去；也不从一个按钮的点按格、一个框中间切过去，
 * 否则边上露出的那一条空白还能点（审计第六轮 A1、第七轮 A1、C1，第八轮 C2–C4）。
 *
 * When a field in the inspector changes and the footer appears, the inspector scrolls the edited block into view (revealEdited in
 * ConfigGuideLayout). Three things must hold wherever it settles: the edited field is fully visible; neither the top edge nor the footer's
 * rule cuts through a line of text; and neither cuts through a button's tap box or a field, or the blank strip at the edge would still
 * respond (audit round 6 A1, round 7 A1 and C1, round 8 C2–C4).
 */

// 条件多、上游多、带响应处理的入口：表单比视口高，各种停法都会碰到 / An entry with many conditions, several upstreams and response handling: the form is taller than the view
const fixture = {
  version: '1.0',
  settings: { bind_addr: '0.0.0.0:53', default_upstream: '1.1.1.1:53' },
  pipeline_select: [
    { pipeline: 'rich', matcher_operator: 'or', matchers: [
      { type: 'domain_suffix', operator: 'or', value: 'alpha.example' },
      { type: 'domain_suffix', operator: 'or', value: 'beta.example' },
      { type: 'domain_suffix', operator: 'or', value: 'gamma.example' },
      { type: 'client_ip', operator: 'or', cidr: '10.0.0.0/8' },
    ] },
    { pipeline: 'default', matcher_operator: 'and', matchers: [] },
  ],
  pipelines: [
    { id: 'rich', rules: [{
      name: 'rich-rule', matchers: [], matcher_operator: 'and',
      actions: [{ type: 'forward', upstream: 'https://doh.pub/dns-query, https://dns.alidns.com/dns-query, 223.5.5.5:53', transport: '' }],
      response_matchers: [{ type: 'response_answer_ip', operator: 'and', cidr: '0.0.0.0/32' }], response_matcher_operator: 'and',
      response_actions_on_match: [{ type: 'log', level: 'warn' }], response_actions_on_miss: [],
    }] },
    { id: 'default', rules: [{ name: 'default-rule', matchers: [], matcher_operator: 'and', actions: [{ type: 'forward', upstream: '1.1.1.1:53', transport: '' }] }] },
  ],
}

async function openEntry(page: Page): Promise<void> {
  await page.goto('/config')
  await expect(page.getByLabel('解析编排工作台', { exact: true })).toBeVisible()
  await page.locator('input[type=file]').setInputFiles({ name: 'reveal.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) })
  await expect(page.locator('.workbench-entry')).toHaveCount(2)
  await page.getByRole('button', { name: /^编辑入口 01 / }).click()
  await expect(page.locator('.config-guide__editor')).toBeVisible()
}

// 停下来以后：改的字段看不看得见；上下两条边切到了哪些字（连同框里的字）和看不见的点按格。框露一半还看得出是框，不算
// Once settled: whether the edited field shows, and which text (with the text in fields) and invisible tap boxes the two edges cut.
// A half-shown field still reads as a field and does not count
function settled(page: Page) {
  return page.locator('.config-guide__editor').evaluate((editor) => {
    const frame = editor.getBoundingClientRect()
    const edges = [frame.top, frame.bottom]
    const crosses = (from: number, to: number) => edges.some((edge) => from < edge - 1 && to > edge + 1)
    const cut: string[] = []
    const range = document.createRange()
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim() || !node.parentElement?.checkVisibility()) continue
      range.selectNodeContents(node)
      for (const rect of range.getClientRects()) if (rect.height > 0 && crosses(rect.top, rect.bottom)) cut.push(`字「${node.textContent.trim().slice(0, 12)}」`)
    }
    for (const control of editor.querySelectorAll<HTMLElement>('button, summary, [role="button"]')) {
      const rect = control.getBoundingClientRect()
      if (rect.height > 0 && control.checkVisibility() && crosses(rect.top, rect.bottom)) cut.push(`点按格「${(control.getAttribute('aria-label') ?? control.textContent ?? '').trim().slice(0, 12)}」`)
    }
    for (const field of editor.querySelectorAll<HTMLElement>('.ui-input')) {
      const rect = field.getBoundingClientRect()
      if (!(rect.height > 0) || !field.checkVisibility()) continue
      const line = parseFloat(getComputedStyle(field).lineHeight) || 21
      const middle = (rect.top + rect.bottom) / 2
      const [from, to] = field.querySelector('textarea') ? [rect.top, rect.bottom] : [middle - line / 2, middle + line / 2]
      if (crosses(from, to)) cut.push(`框里的字「${(field.querySelector('input, textarea, select') as HTMLInputElement | null)?.value?.slice(0, 12) ?? ''}」`)
    }
    const active = document.activeElement as HTMLElement | null
    const box = (active?.closest('.ui-input') ?? active)?.getBoundingClientRect()
    const shown = Boolean(box) && box!.top >= frame.top - 0.5 && box!.bottom <= frame.bottom + 0.5
    return { cut: [...new Set(cut)], shown }
  })
}

const fields = ['条件 1 值', '条件 3 值', '条件 4 CIDR', '动作 1 上游']
const sizes = [
  { width: 375, height: 650 }, { width: 375, height: 700 }, { width: 375, height: 750 }, { width: 375, height: 800 },
  { width: 1280, height: 900 }, { width: 1024, height: 760 },
]

for (const size of sizes) {
  // 字段本来就整个看得见时检查器不滚：用户正在那里打字，不能让内容在光标底下挪；这时底栏那条边像任何滚动框的边一样可以压着东西
  // When the field already shows in full the inspector does not scroll: the user is typing there and content must not move under the
  // caret; the footer's edge may then cross content like any scroll box's edge
  test(`检查器滚到改的地方：字段看得见，滚了就不切字、不切点按格 ${size.width}×${size.height} @responsive`, async ({ page }) => {
    const phone = (page.viewportSize()?.width ?? 1440) <= 640
    test.skip(phone !== size.width <= 640, '手机的尺寸只在手机那一组跑，桌面的只在桌面那一组跑 / Phone sizes run in the phone project only, desktop sizes in the desktop project only')
    test.setTimeout(120_000)
    await page.setViewportSize(size)
    await openEntry(page)
    const problems: string[] = []
    for (const field of fields) {
      // 字段先整个露在视野里：贴着上沿，或贴着下沿（底栏出来会盖住它）。人只能在看得见的字段里打字
      // The field first shows in full: against the top edge, or against the bottom one (where the footer will cover it). People only type into fields they can see
      for (const start of ['top', 'bottom'] as const) {
        const editor = page.locator('.config-guide__editor')
        const input = page.locator('.workbench-inspector').getByLabel(field, { exact: true })
        await input.evaluate((element, where) => {
          const scroller = element.closest('.config-guide__editor')!
          const box = (element.closest('.ui-input') ?? element).getBoundingClientRect()
          const frame = scroller.getBoundingClientRect()
          scroller.scrollTop += where === 'top' ? box.top - frame.top - 4 : box.bottom - frame.bottom + 4
        }, start)
        await input.click()
        const before = await editor.evaluate((element) => element.scrollTop)
        await input.press('End')
        await input.pressSequentially('x')
        await expect(page.locator('.config-guide__footer')).toBeVisible()
        await page.waitForTimeout(400)
        const moved = Math.abs(await editor.evaluate((element) => element.scrollTop) - before) > 0.5
        const result = await settled(page)
        const label = `${field}（从${start === 'top' ? '顶上' : '底下'}开始）`
        if (!result.shown) problems.push(`${label}：字段不在视野里`)
        if (moved && result.cut.length) problems.push(`${label}：滚了以后切到 ${result.cut.join('、')}`)
        // 还原，底栏收起，下一个字段从头来 / Revert, so the footer folds away and the next field starts afresh
        await page.locator('.config-guide__footer').getByRole('button', { name: '还原', exact: true }).click()
        await expect(page.locator('.config-guide__footer')).toBeHidden()
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
  })
}
