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
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('audit-original')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?audit-original';
      import { apiRequest as original } from '/src/api/client.ts?audit-original';
      export async function apiRequest(path, init) {
        const result = await original(path, init);
        if (String(path).startsWith('/api/v1/audit')) return { ...result, events: [{ id: 99, actor: 'admin', action: 'config.restart_rollback', detail: 'bind_udp、bind_tcp、tcp_pool_size、cache_capacity、flow_control_enabled、doq_enable_0rtt，版本 #120，待应用的修改另存为版本 #121', created_at: Math.floor(Date.now() / 1000) }, ...result.events] };
        return result;
      }
    ` })
  })
  for (const width of [768, 375]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/logs?view=audit')
    const row = page.locator('.audit-line', { hasText: '退回原来的设置' })
    await expect(row).toContainText(/UDP\s监听地址、TCP\s监听地址、TCP\s连接池、DoQ\s0-\u2060?RTT、缓存容量、自动限流，版本 #120，待应用的修改另存为版本 #121/)
    const layout = await row.evaluate((line) => {
      let box: HTMLElement | null = line as HTMLElement
      while (box) { if (box.scrollWidth > box.clientWidth + 1) return `overflow ${box.className}`; box = box.parentElement }
      // 每一行都以「、」「，」结尾或是最后一行：名字、「版本 #N」不从中间断开 / Every line ends at 「、」 or 「，」 or is the last: no name or
      // 「版本 #N」 breaks inside
      const p = line.querySelector('p') as HTMLElement
      const range = document.createRange()
      const ends: string[] = []
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
      let last: { top: number; char: string } | null = null
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? ''
        for (let i = 0; i < text.length; i += 1) {
          range.setStart(node, i); range.setEnd(node, i + 1)
          const top = Math.round(range.getBoundingClientRect().top)
          if (last && top > last.top + 4) ends.push(last.char)
          last = { top, char: text[i]! }
        }
      }
      return ends.join('')
    })
    expect(layout).toMatch(/^[、，]*$/)
  }
})
