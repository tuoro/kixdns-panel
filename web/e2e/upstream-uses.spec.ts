import { expect, test, type Locator } from '@playwright/test'

// 上游组卡片写明还用在哪儿；旧版面板编辑共用的组时复制出的「原名-copy」，页顶说清来历和怎么整体换掉
// Group cards say where else they are used; a 「name-copy」 the old panel made when one place of a shared group was edited gets a note on top
// explaining where it came from and how to replace the group everywhere

// 名字里的连字符后面接了不折行的连接符，比较前去掉 / Names carry a word joiner after each hyphen; drop it before comparing
const plain = async (locator: Locator) => (await locator.innerText()).replace(/\u2060/g, '')

test('旧版面板留下的副本：页顶说明来历，原来那组写明还用在回答后检查 @responsive', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-old-copy', 'true'))
  await page.goto('/config?section=upstreams')
  const note = page.locator('.ups__copy')
  await expect(note).toHaveCount(1)
  await expect.poll(() => plain(note)).toContain('「global-copy」是旧版面板自动复制出来的')
  await expect.poll(() => plain(note)).toContain('原来的「global」还用在规则「cn_parallel」的回答后检查；要整体换掉，就把这一处也改到「global-copy」。')

  const card = (name: string) => page.locator('.gcard').filter({ has: page.locator('.gcard__name-text', { hasText: new RegExp(`^${name}$`) }) })
  await expect(card('global').locator('.gcard__foot')).toContainText('用在规则「cn_parallel」的回答后检查')
  // 其余请求在标题行已经有标签，不再写一遍 / 其余请求 already has a tag in the title row and is not repeated
  await expect(card('global-copy').locator('.gcard__foot p')).toHaveCount(1)
  await expect(card('global-copy').locator('.gcard__head')).toContainText('其余请求')
})

test('没有旧版面板副本时不出说明', async ({ page }) => {
  await page.goto('/config?section=upstreams')
  await expect(page.locator('.gcard').first()).toBeVisible()
  await expect(page.locator('.ups__copy')).toHaveCount(0)
})
