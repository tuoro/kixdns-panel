import { expect, test, type Locator } from '@playwright/test'

// 上游组卡片写明还用在哪儿；旧版面板编辑共用的组时复制出的「原名-copy」，卡片上说清来历，一键用它替换原来那组
// Group cards say where else they are used; a 「name-copy」 the old panel made when one place of a shared group was edited says so on its card
// and can replace the original in one step

// 名字里的连字符后面接了不折行的连接符，比较前去掉 / Names carry a word joiner after each hyphen; drop it before comparing
const plain = async (locator: Locator) => (await locator.innerText()).replace(/\u2060/g, '')

test('旧版面板留下的副本：卡片说明来历，一键替换原来那组，能撤销 @responsive', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-old-copy', 'true'))
  await page.goto('/config?section=upstreams')
  const card = (name: string) => page.locator('.gcard').filter({ has: page.locator('.gcard__name-text', { hasText: new RegExp(`^${name}$`) }) })
  await expect(card('global').locator('.gcard__foot')).toContainText('用在规则「cn_parallel」的回答后检查')
  // 其余请求在标题行已经有标签，「用在…」不再写一遍；最后一行是来历 / 其余请求 already has a tag in the title row and is not repeated; the last line is the origin
  await expect(card('global-copy').locator('.gcard__head')).toContainText('其余请求')
  await expect.poll(() => plain(card('global-copy').locator('.gcard__copy'))).toContain('旧版面板改「global」时复制的')
  await expect(card('global').locator('.gcard__copy')).toHaveCount(0)

  await card('global-copy').getByRole('button', { name: /^用它替换「global」$/ }).click()
  const dialog = page.getByRole('alertdialog')
  await expect.poll(() => plain(dialog.getByRole('heading'))).toBe('用「global-copy」替换「global」')
  await expect.poll(() => plain(dialog.locator('#confirm-body'))).toBe('替换后只留「global」一组，上游是 dns.google、cloudflare-dns.com，保存后生效。原来走「global」的这些地方会跟着换：')
  await expect(dialog.locator('.confirm__items li')).toHaveText(['规则「cn_parallel」的回答后检查'])
  await dialog.getByRole('button', { name: '替换', exact: true }).click()

  // 只剩「global」：换成了副本的上游，其余请求和回答后检查都走它 / Only 「global」 is left, with the copy's upstreams, serving both 其余请求 and the answer check
  await expect(card('global-copy')).toHaveCount(0)
  await expect(card('global').locator('.gcard__addr')).toHaveText(['dns.google/dns-query', 'cloudflare-dns.com/dns-query'])
  await expect(card('global').locator('.gcard__head')).toContainText('其余请求')
  await expect(card('global').locator('.gcard__head')).toContainText('2 处在用')
  await expect(page.locator('.gcard__copy')).toHaveCount(0)

  // 撤销：两组和原来的地址都回来 / Undo: both groups and the original addresses come back
  await page.getByRole('button', { name: '撤销' }).click()
  await expect(card('global-copy')).toHaveCount(1)
  await expect(card('global').locator('.gcard__addr')).toHaveText(['dns.quad9.net/dns-query'])
  await expect(card('global-copy').locator('.gcard__head')).toContainText('其余请求')
})

test('替换以后保存：重新读回来也只剩原来那组', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-old-copy', 'true'))
  await page.goto('/config?section=upstreams')
  await page.locator('.gcard__copy').getByRole('button').click()
  await page.getByRole('alertdialog').getByRole('button', { name: '替换', exact: true }).click()
  const bar = page.locator('.cfg__savebar')
  await bar.getByRole('button', { name: '保存并应用' }).click()
  await expect(bar).toHaveCount(0, { timeout: 10_000 })
  // 保存后面板重新读一次配置：卡片照着读回来的配置画 / After saving the panel re-reads the config, and the cards follow what came back
  await expect(page.locator('.gcard__name-text')).toHaveText(['global', 'doh.pub 等 2 个'])
  await expect(page.locator('.gcard').first().locator('.gcard__addr')).toHaveText(['dns.google/dns-query', 'cloudflare-dns.com/dns-query'])
})

test('没有旧版面板副本时不出这一行', async ({ page }) => {
  await page.goto('/config?section=upstreams')
  await expect(page.locator('.gcard').first()).toBeVisible()
  await expect(page.locator('.gcard__copy')).toHaveCount(0)
})
