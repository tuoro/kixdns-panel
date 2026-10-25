import { expect, test } from '@playwright/test'

// 提示里退回的叫法：只在这几处折行——标点或空格后、退回的叫法前后、几个连住的词（「一起（保存）生效」「才生效」「停了」「这份配置」）和按钮名「再点「…」」前面、文字里原有的零宽断点后；
// 不切进词里，也不撑出去。能断在哪由这里自己定，不从被测的分块推出来。句子照代码的拼法写（带不换行空格和 U+2060）。这里只跑
// Chromium；WebKit 另用 WebKitGTK 量过（见审计记录）
// Rollback names in toasts: lines break only here — after punctuation or a space, before or after a rollback name, and before a few
// glued words (一起（保存）生效, 才生效, 停了, 这份配置) and the button name 「再点「…」」, and after a zero-width break already in the text; never inside a word and never overflowing. Where a break may
// fall is decided here, not derived from the runs under test. The sentences are spelled as the code builds them (with no-break spaces
// and U+2060). Only Chromium runs here; WebKit was measured separately with WebKitGTK (see the audit notes)
const SENTENCES = [
  'KixDNS 服务已重启，退回的设置和待应用的修改已生效',
  'KixDNS 服务已重启，退回的设置和待应用的修改已应用，有些设置要再重启一次才生效',
  'KixDNS 服务已启动，退回的设置和待应用的修改已应用，有些设置要重启 KixDNS\u00a0才生效',
  '已退回原来的设置，KixDNS 服务已重启；待应用的修改也已应用，有些设置要再重启一次才生效',
  '已退回原来的设置，KixDNS 服务已重启；待应用的修改没有生效，到配置页看原因',
  '待应用的修改存成了版本\u00a0#22，KixDNS\u00a0就绪后\u2060自\u2060动\u2060应\u2060用',
  '退回的设置和待应用的修改还没有应用：KixDNS\u00a0启动失败，退回原来的设置时一起应用',
  '退回的设置和待应用的修改还没有应用：KixDNS\u00a0启动失败，KixDNS\u00a0启动后\u2060自\u2060动\u2060应\u2060用',
  '退回的设置和待应用的修改还没有应用：KixDNS\u00a0没有回应，就绪后自动应用',
  '不知道待应用的修改应用了没有：连不上面板。连上后会自己核对',
  '待应用的修改还没有应用，可以再点「现在应用」',
  '待应用的修改还没有应用；它的内容会和你的修改一起保存生效',
  '待应用的修改还没有应用，回到配\u2060置\u2060页可以再点「现在应用」',
  '刚才那次应用：待应用的修改已生效',
  '刚才那次应用：待应用的修改已应用，有些设置要重启 KixDNS 才生效',
  '待应用的修改正在应用，完成后再保存',
  '重试没有送到面板，连上\u00a0KixDNS\u00a0后，可以再点「重试应用」',
  '重试没有送到面板，KixDNS\u00a0启动后，可以回到配\u2060置\u2060页再点「重试应用」',
  '重试没有送到面板；回到配\u2060置\u2060页保存时，会带上那一版的内容',
  '刚才那次应用：版本 #19 没有生效，连上\u00a0KixDNS\u00a0后，可以回到配\u2060置\u2060页重试应用',
  '刚才那次应用：待应用的修改没有生效，KixDNS\u00a0启动后，可以回到配\u2060置\u2060页重试应用',
  '待应用的修改还没有应用，几秒内会自动应用',
  '退回的设置和待应用的修改还没有应用，连上\u00a0KixDNS\u00a0后\u2060自\u2060动\u2060应\u2060用',
  '重试也没有生效，存成了版本 #20。KixDNS 没有接受这份配置：upstream "fast" did not answer the health check',
  '版本\u00a0#17\u00a0的内容\u200b存成了版本\u00a0#21，没有生效',
  '配置还没有应用，KixDNS\u00a0启动后，可以回到配\u2060置\u2060页再点「校验并应用」',
  '不知道配置应用了没有：连不上面板。连上后会自己核对',
  '刚才那次应用：版本 #19 没有生效；回到配\u2060置\u2060页保存时，会带上那一版的内容',
  '重试也没有生效。KixDNS 在确认新配置前停了',
]
const WIDTHS = [...Array.from({ length: 111 }, (_, i) => 300 + i * 2), 640, 1024]

test('提示里退回的叫法：只在该断的地方折行，不撑出去', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const problems: string[] = []
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    problems.push(...await page.evaluate(async (texts) => {
      const { useToast } = await import('/src/composables/useToast.ts')
      const toast = useToast()
      const found: string[] = []
      for (const text of texts) {
        for (const message of [...toast.messages.value]) toast.dismiss(message.id)
        toast.error(text)
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const el = [...document.querySelectorAll('.toast')].pop()!
        const box = el.querySelector(':scope > span') as HTMLElement
        // 可以断的地方 / Where a break may fall
        const allowed = new Set<number>()
        for (const m of text.matchAll(/退回的设置和待应用的修改|退回的设置|待应用的修改/g)) { allowed.add(m.index); allowed.add(m.index + m[0].length) }
        for (const m of text.matchAll(/一起(?:保存)?生效|才生效|停了|这份配置|再点「/g)) allowed.add(m.index)
        for (let k = 1; k < text.length; k += 1) if (/[，：；。 \u200b]/.test(text[k - 1]!) || text[k] === ' ') allowed.add(k)
        const range = document.createRange()
        let index = 0
        let top: number | null = null
        const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const content = node.textContent ?? ''
          for (let i = 0; i < content.length; i += 1, index += 1) {
            range.setStart(node, i); range.setEnd(node, i + 1)
            const rect = [...range.getClientRects()].find((r) => r.width > 0)
            if (!rect) continue
            const y = Math.round(rect.top)
            if (top !== null && y > top + 4 && !allowed.has(index)) found.push(`${window.innerWidth} 宽：「${text.slice(0, index)} / ${text.slice(index)}」`)
            if (top === null || y > top + 4) top = y
          }
        }
        if (el.getBoundingClientRect().right > window.innerWidth + 1 || box.scrollWidth > box.clientWidth + 1) found.push(`${window.innerWidth} 宽撑出去：「${text}」`)
      }
      return found
    }, SENTENCES))
  }
  expect(problems).toEqual([])
})
