import { expect, test } from '@playwright/test'

// 直接打开（或刷新）操作审计页签：原来只读了运行日志，审计这边空着说「还没有操作记录」
// Opening (or reloading) the audit tab directly: it used to read only the runtime log, leaving the audit empty with 「还没有操作记录」
test('直接打开操作审计：读得出记录，不说「还没有操作记录」 @responsive', async ({ page }) => {
  await page.goto('/logs?view=audit')
  await expect(page.locator('.audit-line').first()).toBeVisible()
  await expect(page.getByText('还没有操作记录')).toHaveCount(0)
  // 刷新以后也一样 / The same after a reload
  await page.reload()
  await expect(page.locator('.audit-line').first()).toBeVisible()
})

// 退回那一行写设置名和版本，长的时候照常折行：不撑出卡片，设置名、「版本 #N」不从中间拆开
// The rollback row names settings and versions; when long it wraps as usual, without overflowing the card or splitting a name or a
// 「版本 #N」
test('操作审计里退回那一行：长的时候照常折行，不横向溢出 @responsive', async ({ page }) => {
  // 服务端会写的两种长详情：六项带上修改，两项五位数版本号 / Two long details the server would write: six settings with carried edits,
  // two settings with five-digit version numbers
  const details = [
    'bind_udp、bind_tcp、tcp_pool_size、cache_capacity、flow_control_enabled、doq_enable_0rtt，版本 #120，待应用的修改另存为版本 #121',
    'bind_udp、cache_capacity，版本 #12345，待应用的修改另存为版本 #12346',
  ]
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('audit-original')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?audit-original';
      import { apiRequest as original } from '/src/api/client.ts?audit-original';
      export async function apiRequest(path, init) {
        const result = await original(path, init);
        if (String(path).startsWith('/api/v1/audit')) return { ...result, events: [${details.map((detail, i) => `{ id: ${99 - i}, actor: 'admin', action: 'config.restart_rollback', detail: '${detail}', created_at: Math.floor(Date.now() / 1000) - ${i} }`).join(', ')}, ...result.events] };
        return result;
      }
    ` })
  })
  // 侧栏版最窄的一段（861–900）、换栏宽的 1025、常见的 1100 和 1440、无侧栏的 641 到 768、手机 / The narrowest sidebar band
  // (861–900), 1025 where the columns change, the common 1100 and 1440, 641 to 768 without the sidebar, and phones
  for (const width of [861, 880, 900, 1025, 1100, 1440, 768, 720, 641, 410, 375, 360, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/logs?view=audit')
    const rows = page.locator('.audit-line', { hasText: '退回原来的设置' })
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText(/UDP\s监听地址、TCP\s监听地址、TCP\s连接池、DoQ\s0-\u2060?RTT、缓存容量、自动限流，版本 #120，待应用的修改另存为版本 #121/)
    for (const row of await rows.all()) {
      const layout = await row.evaluate((line) => {
        // 只看这一行：行里的字不超出这一行，这一行不超出卡片（日志页工具栏在 861 宽本来就伸出卡片几像素，那是另一件事）
        // Only this row: its text stays inside the row and the row inside the card (the logs toolbar already reaches a few pixels
        // past the card at 861, which is a separate matter)
        const own = (line as HTMLElement).getBoundingClientRect()
        const card = (line as HTMLElement).closest('.log-console')!.getBoundingClientRect()
        if (own.right > card.right + 1) return `row past card ${Math.round(own.right - card.right)}`
        for (const el of (line as HTMLElement).querySelectorAll('*')) if (el.getBoundingClientRect().right > own.right + 1) return `text past row ${Math.round(el.getBoundingClientRect().right - own.right)}`
        if ((line as HTMLElement).scrollWidth > (line as HTMLElement).clientWidth + 1) return 'row scrolls'
        // 每一次折行都落在两块之间：上一行以「、」「，」结尾，或者下一行以「版本」开头（「待应用的修改另存为」和「版本 #N」之间）
        // Every break falls between two glued units: the line ends at 「、」 or 「，」, or the next line starts with 「版本」 (between
        // 「待应用的修改另存为」 and 「版本 #N」)
        const p = line.querySelector('p') as HTMLElement
        const range = document.createRange()
        const chars: Array<{ top: number; char: string }> = []
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent ?? ''
          for (let i = 0; i < text.length; i += 1) {
            range.setStart(node, i); range.setEnd(node, i + 1)
            chars.push({ top: Math.round(range.getBoundingClientRect().top), char: text[i]! })
          }
        }
        const text = chars.map((c) => c.char).join('')
        const bad: string[] = []
        for (let i = 1; i < chars.length; i += 1) {
          if (chars[i]!.top <= chars[i - 1]!.top + 4) continue
          if (/[、，]/.test(chars[i - 1]!.char) || text.startsWith('版本', i)) continue
          bad.push(`${text.slice(Math.max(0, i - 6), i)} / ${text.slice(i, i + 4)}`)
        }
        return bad.join(' | ')
      })
      expect(layout, `${width} 宽`).toBe('')
    }
  }
})
