import { expect, test, type Page } from '@playwright/test'

// 编辑器认的写法和内核认的一样：上游地址、子网、域名映射。内核拒绝的当场说出来，大家习惯的写法（只写 IP、写 *.）照样能用
// The editor accepts what the kernel accepts: upstream addresses, subnets, domain mappings. What the kernel refuses is said on the spot, and
// the usual ways of writing (a bare IP, a leading *.) still work

async function newGroup(page: Page, address: string) {
  await page.goto('/config?section=upstreams')
  await page.getByRole('button', { name: '新建上游组', exact: true }).first().click()
  const drawer = page.locator('dialog[open]').last()
  await drawer.getByLabel('名称', { exact: true }).fill('测试组')
  await drawer.getByLabel('第 1 个地址', { exact: true }).fill(address)
  return drawer
}

test('上游组：只写 IP 的地址按 53 端口存', async ({ page }) => {
  const drawer = await newGroup(page, '223.5.5.5')
  await drawer.getByRole('button', { name: '新建', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  const card = page.locator('.gcard').filter({ hasText: '测试组' })
  await expect(card.locator('.gcard__addr')).toHaveText(['223.5.5.5:53'])
})

// 演示的样例配置里「国内」组有一个旧写法的 tcp+udp://223.5.5.5（内核不收）：打开什么都不改点「完成」，也补上 53 写回去
// The sample demo config's 国内 group holds an old-style tcp+udp://223.5.5.5 (refused by the kernel): opening it and pressing 完成 with no
// edit still gives it 53 and writes it back
test('上游组：旧配置里没写端口的地址，打开点「完成」就补上 53', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-destinations', 'true'))
  await page.goto('/config?section=upstreams')
  const card = page.locator('.gcard').filter({ has: page.locator('.gcard__name-text', { hasText: /^国内$/ }) })
  await expect(card.locator('.gcard__addr').last()).toHaveText('223.5.5.5')
  await card.locator('.gcard__name').click()
  const drawer = page.locator('dialog[open]').last()
  await drawer.getByRole('button', { name: '完成', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  await expect(card.locator('.gcard__addr').last()).toHaveText('223.5.5.5:53')
})

test('上游组：UDP 写了域名、DoQ 用 IP 没写 sni，当场说哪个地址怎么改', async ({ page }) => {
  const drawer = await newGroup(page, 'udp://dns.example:53')
  await drawer.getByRole('button', { name: '新建', exact: true }).click()
  await expect(drawer.locator('.pdrawer__problem')).toContainText('第 1 个地址')
  await drawer.getByLabel('第 1 个地址', { exact: true }).fill('quic://223.5.5.5')
  await drawer.getByRole('button', { name: '新建', exact: true }).click()
  await expect(drawer.locator('.pdrawer__problem')).toContainText('sni')
})

test('上游组：固定子网的前缀超出范围、发送客户端子网的前缀框空着，当场说出来', async ({ page }) => {
  const drawer = await newGroup(page, 'https://dns.example/dns-query')
  await drawer.getByLabel('客户端子网', { exact: true }).selectOption({ label: '发送固定的子网' })
  await drawer.getByLabel('固定子网', { exact: true }).fill('203.0.113.0/999')
  await drawer.getByRole('button', { name: '新建', exact: true }).click()
  await expect(drawer.locator('.pdrawer__problem')).toBeVisible()
  await drawer.getByLabel('客户端子网', { exact: true }).selectOption({ label: '发送客户端所在子网' })
  await drawer.getByLabel('IPv4 前缀长度', { exact: true }).fill('')
  await drawer.getByRole('button', { name: '新建', exact: true }).click()
  await expect(drawer.locator('.pdrawer__problem')).toBeVisible()
})

// 正则照内核读：页面请面板服务端用内核的正则库编译一遍（演示里 kixdns:demo-regex-refused 说内核不收哪些）。a++ 内核收，以前 JS 读不了就标红；
// [a-\d] 内核不收，以前 JS 收了不说；前后断言不用等回答就标红
// Regexes read as the kernel reads them: the page asks the panel server to compile them with the kernel's regex library (in the demo
// kixdns:demo-regex-refused says which the kernel refuses). a++ the kernel takes, once marked because JS could not read it; [a-\d] the
// kernel refuses, once let through by JS; lookaround is marked without waiting for the answer
test('域名正则照内核读：内核收的不标红，内核不收的标红', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kixdns:demo-regex-refused', JSON.stringify(['[a-\\d]'])))
  await page.goto('/config')
  await expect(page.locator('.cfg__panel')).toBeVisible()
  await page.getByRole('button', { name: '新建规则', exact: true }).first().click()
  const editor = page.locator('.editor')
  await editor.getByRole('button', { name: '添加条件' }).first().click()
  await page.getByRole('menuitem', { name: '域名', exact: true }).click()
  const row = editor.locator('.cform__row').first()
  await row.locator('select').selectOption('re')
  const input = row.locator('.chips input')
  for (const value of ['a++', '[a-\\d]', '(?=x)']) {
    await input.fill(value)
    await input.press('Enter')
  }
  const chips = row.locator('.chip')
  await expect(chips).toHaveText(['a++', '[a-\\d]', '(?=x)'])
  await expect(chips.nth(1)).toHaveClass(/chip--bad/)
  await expect(chips.nth(2)).toHaveClass(/chip--bad/)
  await expect(chips.nth(0)).not.toHaveClass(/chip--bad/)
})

// 中文域名照收，写进内核时换成 punycode，页面上显示写的中文 / Chinese names are taken, written to the kernel as punycode, and shown as written
test('中文域名：域名映射照收，显示写的中文', async ({ page }) => {
  await page.goto('/config?section=mapping')
  await page.getByLabel('要映射的域名').fill('中文.example')
  await page.getByLabel('回答的 IP 或域名').fill('192.168.1.10')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.locator('.rw__row .rw__dt', { hasText: '中文.example' })).toHaveCount(1)
  // 它的 punycode 写法是同一个域名 / Its punycode spelling is the same name
  await page.getByLabel('要映射的域名').fill('xn--fiq228c.example')
  await page.getByLabel('回答的 IP 或域名').fill('192.168.1.11')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.getByText('xn--fiq228c.example 已经有映射了')).toBeVisible()
})

test('中文域名：快速添加照收，显示写的中文', async ({ page }, testInfo) => {
  await page.goto('/config')
  await expect(page.locator('main h1')).toBeVisible()
  if (testInfo.project.name !== 'mobile') await page.getByRole('button', { name: '快速添加' }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill('例子.测试')
  await quick.press('Enter')
  await expect(page.locator('[data-rule]', { hasText: '例子.测试' })).toHaveCount(1)
})

test('域名映射：写了 *. 存的是去掉 *. 的域名，批量导入也一样', async ({ page }) => {
  await page.goto('/config?section=mapping')
  await page.getByLabel('要映射的域名').fill('*.home.arpa')
  await page.getByLabel('回答的 IP 或域名').fill('192.168.1.10')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.locator('.rw__row .rw__dt')).toContainText(['home.arpa'])
  await expect(page.locator('.rw__row .rw__dt', { hasText: '*.' })).toHaveCount(0)
  await page.getByRole('button', { name: '批量导入' }).click()
  await page.getByLabel('要导入的域名映射').fill('*.lan.arpa 192.168.1.11')
  await expect(page.locator('.rwi li').first()).toContainText('lan.arpa → 192.168.1.11')
  await expect(page.locator('.rwi li').first()).not.toContainText('*.')
  // TTL 超过 u32、CNAME 目标以横线开头：内核不收，预览里说出来 / A TTL beyond a u32, a CNAME target starting with a hyphen: refused by the kernel,
  // said in the preview
  await page.getByLabel('要导入的域名映射').fill('big.home.arpa nas.home.arpa 4294967296\nbad.home.arpa -nas.home.arpa')
  await expect(page.locator('.rwi li small')).toHaveText(['TTL 填 0 到 4294967295 之间的整数', '回答写成 IP（几个用逗号隔开）或一个域名'])
})

// 负数和小数浏览器自己就拦（框是 min=0 的数字框）；超过 u32 的浏览器不拦，内核整份配置不收
// Negatives and fractions the browser stops itself (the box is a number box with min=0); one beyond a u32 it lets through, and the kernel
// refuses the whole config
test('域名映射：CNAME 的 TTL 超过 4294967295，当场说出来', async ({ page }) => {
  await page.goto('/config?section=mapping')
  await page.getByLabel('要映射的域名').fill('files.home.arpa')
  await page.getByLabel('回答的 IP 或域名').fill('nas.home.arpa')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  // 编辑时行里只有输入框，按文字找不到它：先记下编号 / While editing the row holds only inputs and no text to find it by: note its id first
  const at = await page.locator('[data-rw]', { hasText: 'files.home.arpa' }).getAttribute('data-rw')
  const row = page.locator(`[data-rw="${at}"]`)
  await row.locator('.rw__d').click()
  await row.getByLabel('TTL', { exact: true }).fill('4294967296')
  await row.getByRole('button', { name: '保存', exact: true }).click()
  await expect(row.locator('.rw__err')).toHaveText('TTL 填 0 到 4294967295 之间的整数')
})

// 规则的自定义回答：TXT 超过 255 字节、TTL 是负数，内核整份配置不收。底栏说第一处，回答框下面也说，错的是 TTL 时标红 TTL 那一格
// A rule's custom answer: TXT over 255 bytes or a negative TTL, and the kernel refuses the whole config. The footer names the first, the line
// under the answer says it too, and when the TTL is wrong the TTL box is the one marked
test('规则的自定义回答：TXT 太长、TTL 是负数，当场说出来', async ({ page }) => {
  await page.goto('/config')
  await page.getByRole('button', { name: '新建规则', exact: true }).first().click()
  const editor = page.locator('.editor')
  await editor.locator('.tile', { hasText: '自定义回答' }).click()
  await editor.getByRole('group', { name: '结果：记录类型' }).getByRole('button', { name: 'TXT', exact: true }).click()
  await editor.getByLabel('结果：回答内容').fill('a'.repeat(256))
  await editor.getByRole('button', { name: '新建', exact: true }).click()
  await expect(editor.locator('.editor__problem')).toContainText('TXT 内容最长 255 字节，现在 256 字节')
  await expect(editor.locator('.oparams .ui-field-error')).toHaveText('TXT 内容最长 255 字节，现在 256 字节')
  await editor.getByLabel('结果：回答内容').fill('ok')
  await editor.getByLabel('结果：TTL').fill('-1')
  await expect(editor.locator('.oparams .ui-field-error')).toHaveText('TTL 填 0 到 4294967295 之间的整数')
  await expect(editor.getByLabel('结果：TTL')).toHaveAttribute('aria-invalid', 'true')
  await expect(editor.getByLabel('结果：回答内容')).not.toHaveAttribute('aria-invalid', 'true')
})

// 规则单独设的固定子网空着：保存前说出来，收着的「更多」打开、子网框标红 / A rule's own fixed subnet left empty: said before saving, the folded 更多
// opens and the subnet box is marked
test('规则单独的固定子网空着，点新建时打开「更多」标出来', async ({ page }) => {
  await page.goto('/config')
  await page.getByRole('button', { name: '新建规则', exact: true }).first().click()
  const editor = page.locator('.editor')
  const more = editor.locator('.ecard__fold')
  await more.click()
  await editor.getByLabel('客户端子网', { exact: true }).selectOption({ label: '发送固定的子网' })
  await more.click()
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await editor.getByRole('button', { name: '新建', exact: true }).click()
  await expect(editor.locator('.editor__problem')).toContainText('固定子网写成 203.0.113.0/24 这样')
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  await expect(editor.getByLabel('固定子网', { exact: true })).toHaveAttribute('aria-invalid', 'true')
})

// 手机上结果、回答后检查的「然后」、客户端子网各是一行，点开是弹层：写错了点「新建」，那一行标红；点底下「还有 1 处要改」打开那个弹层，光标放进
// 标红的那一格。以前只有选的组删掉了才标那一行，子网那一行从不标，点那句话什么都不发生
// On a phone the outcome, the answer check's 然后 and the client subnet are rows opening sheets: written wrong, 新建 marks that row, and the
// 还有 1 处要改 line opens that sheet with the caret in the red box. Before, only a deleted group marked its row, the subnet row was never
// marked, and tapping the line did nothing
test('手机上：子网、回答后检查的「然后」、结果的 TTL 写错，那一行标红，点「还有 1 处要改」打开它的弹层 @responsive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '弹层只在手机上有')
  await page.goto('/config')
  await page.getByRole('button', { name: '新建规则', exact: true }).first().click()
  const editor = page.locator('.editor')
  const problem = editor.locator('.editor__problem')
  const sheet = page.locator('dialog[open]')
  const done = () => sheet.getByRole('button', { name: '完成', exact: true }).click()

  // 客户端子网 / The client subnet
  const ecsRow = editor.getByRole('button', { name: '修改客户端子网' })
  await ecsRow.click()
  await sheet.getByLabel('客户端子网', { exact: true }).selectOption({ label: '发送固定的子网' })
  await sheet.getByLabel('固定子网', { exact: true }).fill('203.0.113.0/999')
  await done()
  // 点「新建」就打开那个弹层，光标在标红的框里；收起以后那一行标红，点底下那句话再打开 / 新建 opens that sheet with the caret in the red box;
  // closed again, the row is marked, and the line at the bottom opens it once more
  await editor.getByRole('button', { name: '新建', exact: true }).click()
  await expect(sheet.getByLabel('固定子网', { exact: true })).toBeFocused()
  await done()
  await expect(problem).toContainText('固定子网写成 203.0.113.0/24 这样')
  await expect(ecsRow).toHaveClass(/is-bad/)
  await problem.click()
  await expect(sheet.getByLabel('固定子网', { exact: true })).toBeFocused()
  await expect(sheet.getByLabel('固定子网', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  await sheet.getByLabel('固定子网', { exact: true }).fill('203.0.113.0/24')
  await done()
  await expect(ecsRow).not.toHaveClass(/is-bad/)

  // 回答后检查的「然后」：替换成太长的 TXT / The answer check's 然后: replaced with too long a TXT
  await page.getByRole('group', { name: '回答后检查' }).getByRole('button', { name: '单独设置' }).click()
  await editor.getByRole('button', { name: '上游出错', exact: true }).click()
  const thenRow = editor.getByRole('button', { name: '修改满足时怎么做' })
  await thenRow.click()
  await sheet.getByLabel('满足时怎么做', { exact: true }).selectOption({ label: '替换 TXT 内容' })
  await sheet.getByLabel('然后：新的 TXT 内容').fill('a'.repeat(256))
  await done()
  await expect(problem).toContainText('TXT 内容最长 255 字节，现在 256 字节')
  await expect(thenRow).toHaveClass(/is-bad/)
  await problem.click()
  await expect(sheet.getByLabel('然后：新的 TXT 内容')).toBeFocused()
  await sheet.getByLabel('然后：新的 TXT 内容').fill('v=spf1 -all')
  await done()
  await expect(thenRow).not.toHaveClass(/is-bad/)

  // 结果：CNAME 的 TTL 超过 4294967295 / The outcome: a CNAME TTL beyond 4294967295
  const outcomeRow = editor.getByRole('button', { name: '修改结果' })
  await outcomeRow.click()
  await sheet.getByText('自定义回答', { exact: true }).click()
  await sheet.getByRole('group', { name: '结果：记录类型' }).getByRole('button', { name: 'CNAME', exact: true }).click()
  await sheet.getByLabel('结果：回答内容').fill('target.example.com')
  await sheet.getByLabel('结果：TTL').fill('99999999999')
  await done()
  await expect(problem).toContainText('TTL 填 0 到 4294967295 之间的整数')
  await expect(outcomeRow).toHaveClass(/is-bad/)
  await problem.click()
  await expect(sheet.getByLabel('结果：TTL')).toBeFocused()
  await expect(sheet.getByLabel('结果：TTL')).toHaveAttribute('aria-invalid', 'true')
})

// 宽屏的面板里「回答后检查」平时收着：「然后」写错了，点「还有 1 处要改」先把它展开，光标放进标红的那一格（以前只会展开「更多」）
// In the wide-screen inspector 回答后检查 stays folded: with 然后 written wrong, the 还有 1 处要改 line unfolds it first and puts the caret in
// the red box (it used to unfold 更多 only)
test('面板里：回答后检查的「然后」写错了，点「还有 1 处要改」展开收着的回答后检查', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机上是整页编辑，没有收着的卡片')
  await page.goto('/config')
  await page.getByRole('button', { name: '新建规则', exact: true }).first().click()
  const editor = page.locator('.editor')
  const fold = editor.getByRole('button', { name: '回答后检查', exact: true })
  await fold.click()
  await page.getByRole('group', { name: '回答后检查' }).getByRole('button', { name: '单独设置' }).click()
  await editor.getByRole('button', { name: '上游出错', exact: true }).click()
  await editor.getByLabel('满足时怎么做', { exact: true }).selectOption({ label: '替换 TXT 内容' })
  await editor.getByLabel('然后：新的 TXT 内容').fill('a'.repeat(256))
  await fold.click()
  await expect(fold).toHaveAttribute('aria-expanded', 'false')
  await editor.getByRole('button', { name: '新建', exact: true }).click()
  const problem = editor.locator('.editor__problem')
  await expect(problem).toContainText('TXT 内容最长 255 字节，现在 256 字节')
  await problem.click()
  await expect(fold).toHaveAttribute('aria-expanded', 'true')
  await expect(editor.getByLabel('然后：新的 TXT 内容')).toBeFocused()
  await expect(editor.getByLabel('然后：新的 TXT 内容')).toHaveAttribute('aria-invalid', 'true')
})
