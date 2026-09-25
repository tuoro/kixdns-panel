import { expect, test, type Page } from '@playwright/test'
import type { DnsDiagnostic, DnsTraceStep } from '../src/api/types'

const answerFixture: DnsDiagnostic = {
  domain: 'example.com', record_type: 'A', server: 'KixDNS 内部执行链', response_code: 'No Error', elapsed_ms: 12,
  truncated: false, answers: ['example.com. 300 IN A 104.18.26.120'], trace_supported: true, trace_truncated: false, trace: [],
}

async function diagnosticFixture(page: Page, result: DnsDiagnostic, failOnce = false): Promise<void> {
  // 演示模式不经过 fetch：只在测试中替换 API 模块边界，不给生产代码增加测试入口。
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('diagnostic-original')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?diagnostic-original';
      import { apiRequest as original } from '/src/api/client.ts?diagnostic-original';
      let shouldFail = ${JSON.stringify(failOnce)};
      export async function apiRequest(path, init) {
        if (path !== '/api/v1/diagnostics/dns') return original(path, init);
        if (shouldFail) { shouldFail = false; throw new Error('DNS 服务暂不可用'); }
        return ${JSON.stringify(result)};
      }
    ` })
  })
}

async function query(page: Page, domain = 'example.com'): Promise<void> {
  await page.goto('/diagnostics')
  await expect(page.getByRole('heading', { name: '诊断', exact: true })).toBeVisible()
  await page.getByLabel('域名', { exact: true }).fill(domain)
  await page.getByRole('button', { name: '执行查询', exact: true }).click()
  await expect(page.locator('.diagnostic-result')).toBeVisible()
}

async function noOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
}

test('诊断应答台账、规则摘要和服务器来源保持真实', async ({ page }) => {
  await query(page)
  await expect(page.locator('.diag-answer-row')).toHaveCount(2)
  await expect(page.locator('.diag-answer-row').first()).toContainText('104.18.26.120')
  await expect(page.locator('.diag-answer-row').last()).toContainText('104.18.27.120')
  await expect(page.locator('.diag-ttl').first()).toHaveText('300')
  // 结论带一句话说清走了哪条管线的哪条规则、由谁应答。
  // The verdict says, in one sentence, which pipeline's rule matched and who answered.
  await expect(page.locator('.diagnostic-match-summary')).toContainText('命中 default 的规则 geosite-global')
  await expect(page.locator('.diag-answers .diag-server')).toContainText('KixDNS 内部执行链')
  await expect(page.locator('.diag-elapsed')).toHaveText('12 ms')
  // 宽窄屏都是应答在上、执行路径在下，同宽：不再并排，也就没有短卡片留下的大块空白。
  // At every width the answer sits above the path at the same width: no side-by-side pair, so no short card with a block of empty space.
  const trace = await page.locator('.diag-trace').boundingBox()
  const answer = await page.locator('.diag-answers').boundingBox()
  expect(answer!.y + answer!.height).toBeLessThan(trace!.y)
  expect(answer?.width).toBe(trace?.width)
  // 时刻在圆点左边，像日志的时间戳。 / The time sits left of the mark, like a log timestamp.
  const time = await page.locator('.diag-step-time').first().boundingBox()
  const mark = await page.locator('.diag-step-mark').first().boundingBox()
  expect(time!.x + time!.width).toBeLessThanOrEqual(mark!.x)
  await noOverflow(page)
})

test('每一步的细节直接摊开，缓存未命中不是故障 @responsive', async ({ page }) => {
  await query(page)
  const steps = page.locator('.diag-step')
  await expect(steps).toHaveCount(6)
  // 不点任何东西：六步的标签和细节应当已经全部可读。
  await expect(steps.nth(5)).toContainText('https://1.1.1.1/dns-query')
  // 程序内部的写法翻成人话：不出现 Some(Https)、false 和 hickory 的「No Error」。
  // Program-internal spellings become words: no Some(Https), false or hickory's "No Error".
  await expect(steps.nth(5)).toContainText('应答 NOERROR')
  await expect(steps.nth(5)).toContainText('未截断')
  await expect(steps.nth(4)).toContainText('传输 DoH')
  await expect(page.locator('.diag-trace')).not.toContainText('Some(')
  await expect(page.locator('.diag-trace')).not.toContainText('false')
  await expect(steps.nth(0)).toContainText('客户端 127.0.0.1')
  await expect(page.locator('.diag-time-note')).toContainText('不表示该阶段的独立耗时')
  // 未命中是中性状态，不画成故障。
  await expect(steps.nth(2)).toHaveClass(/diag-step--neutral/)
  await expect(steps.nth(2)).toContainText('未命中')
  // 每步一句话，不再是「阶段名 + 内核标签」把同一件事说两遍。
  // One sentence per step, no longer "stage + kernel label" saying the same thing twice.
  await expect(steps.nth(2).locator('.diag-step-what')).toHaveText('响应缓存未命中')
  await expect(steps.nth(4).locator('.diag-step-what')).toHaveText('决定转发给 https://1.1.1.1/dns-query')
  await noOverflow(page)
})

test('原始应答原样保留，重新查询换掉整份结果 @responsive', async ({ page }) => {
  await query(page, '  example.net  ')
  const raw = page.locator('.diag-raw-response')
  await raw.locator('summary').click()
  await expect(raw.locator('pre').first()).toHaveText('example.net. 300 IN A 104.18.26.120')
  await page.getByLabel('域名', { exact: true }).fill('example.org')
  await page.getByRole('button', { name: '执行查询', exact: true }).click()
  await expect(page.locator('.diag-step').first()).toContainText('example.org')
  await expect(page.locator('.diag-raw-response pre').first()).toContainText('example.org')
})

test('窄屏查询同行且标题、命中名不再海报化 @responsive', async ({ page }) => {
  // 两个项目都使用 Desktop Chrome，按真实 viewport 而非设备标志判断响应式分支。
  await query(page)
  if ((page.viewportSize()?.width ?? 1440) > 700) return
  // 量用户看得见的框：输入框和下拉框的边框画在外面那层上，三样的顶边和高度都一样。
  // Measure the visible frames: the field and the select draw their border on the
  // outer label, and all three share one top edge and one height.
  const input = await page.locator('.diag-domain').boundingBox()
  const type = await page.locator('.diag-record-type').boundingBox()
  const submit = await page.getByRole('button', { name: '执行查询' }).boundingBox()
  expect(input?.y).toBe(type?.y)
  expect(input?.y).toBe(submit?.y)
  expect(input?.height).toBe(submit?.height)
  expect(type?.height).toBe(submit?.height)
  // 正好是触控高度 44：手机上全局给下拉框的 44 最小高度曾把外框撑到 46，整行跟着变高。
  // Exactly the 44 touch height: the global 44 minimum on selects once pushed the frame to 46 and the whole row with it.
  expect(submit?.height).toBe(44)
  expect(await page.locator('.diag-heading h1').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeLessThanOrEqual(22)
  expect(await page.locator('.diag-resolution').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeLessThanOrEqual(16)
  await noOverflow(page)
})

test('长 TXT 与未知记录原串可读，基础内核不虚构规则轨迹', async ({ page }) => {
  const txt = '"' + 'long  value\\032 '.repeat(45) + '" "escaped\\\"quote"'
  const raw = '无法识别的原始应答  \\  保留空格'
  await diagnosticFixture(page, { ...answerFixture, record_type: 'TXT', trace_supported: false, answers: ['example.com. 300 IN TXT ' + txt, raw] })
  await query(page)
  expect(await page.locator('.diag-answer-row code').first().textContent()).toBe(txt)
  expect(await page.locator('.diag-answer-row code').last().textContent()).toBe(raw)
  await expect(page.locator('.diag-trace-unavailable')).toContainText('当前内核仅支持基础查询')
  await expect(page.locator('.diag-step')).toHaveCount(0)
  await noOverflow(page)
})

test('缓存命中不显示伪规则，空 Answer 与截断状态仍清楚', async ({ page }) => {
  await diagnosticFixture(page, { ...answerFixture, answers: [], truncated: true, trace: [
    { stage: 'response_cache', status: 'fresh', label: '响应缓存命中', detail: null, elapsed_ms: 0 },
  ] })
  await query(page)
  await expect(page.locator('.diag-status')).toContainText('响应缓存命中，未记录规则匹配')
  await expect(page.locator('.diag-empty-answers')).toBeVisible()
  await expect(page.locator('.diag-answers > header')).toContainText('已截断')
  await expect(page.locator('.diag-step')).toHaveCount(1)
  await noOverflow(page)
})

test('真实内核轨迹：未命中的规则并成一行，「准备转发」不带英文状态、不说两遍', async ({ page }) => {
  // 照 p27 内核补丁的写法：命中之前每条规则各记一行，上游先记一次「准备转发到」。
  // As the p27 kernel patch writes it: one row per rule tried before the match, and an upstream "准备转发到" step first.
  const trace: DnsTraceStep[] = [
    { stage: 'pipeline', status: 'selected', label: 'default', detail: null, elapsed_ms: 0 },
    { stage: 'rule_cache', status: 'miss', label: '管线 default 的规则缓存未命中', detail: null, elapsed_ms: 0 },
    ...['block-ads', 'geosite-cn', 'lan-hosts'].map((label) => ({ stage: 'rule', status: 'missed', label, detail: '管线：default；匹配器数：1', elapsed_ms: 0 })),
    { stage: 'rule', status: 'matched', label: 'geosite-global', detail: '管线：default；匹配器数：1', elapsed_ms: 1 },
    { stage: 'upstream', status: 'started', label: '准备转发到 https://1.1.1.1/dns-query', detail: '规则：geosite-global；传输：Some(Https)', elapsed_ms: 1 },
  ]
  await diagnosticFixture(page, { ...answerFixture, trace })
  await query(page)
  const steps = page.locator('.diag-step')
  await expect(steps).toHaveCount(5)
  await expect(steps.nth(1).locator('.diag-step-what')).toHaveText('管线 default 的规则缓存未命中')
  await expect(steps.nth(2)).toHaveClass(/diag-step--idle/)
  await expect(steps.nth(2).locator('.diag-step-what')).toHaveText('3 条规则未命中')
  await expect(steps.nth(2).locator('.diag-step-why')).toHaveText('block-ads、geosite-cn、lan-hosts')
  await expect(steps.nth(4).locator('.diag-step-what')).toHaveText('发往 https://1.1.1.1/dns-query')
  await expect(page.locator('.diag-trace')).not.toContainText('started')
  await noOverflow(page)
})

test('多个命中与长轨迹不被固定六阶段裁掉', async ({ page }) => {
  const trace: DnsTraceStep[] = Array.from({ length: 11 }, (_, index) => ({
    stage: index === 10 ? 'future_stage' : 'rule', status: 'matched', label: 'rule-' + index + '-' + 'long-name-'.repeat(8), detail: '保留原始说明', elapsed_ms: index,
  }))
  await diagnosticFixture(page, { ...answerFixture, trace, trace_truncated: true })
  await query(page)
  // 结论带只点前三条并说明一共几条；执行路径里十一步一步不少。
  // The verdict names the first three and the total; the path keeps every one of the eleven steps.
  await expect(page.locator('.diag-status')).toContainText('等 10 条规则')
  await expect(page.locator('.diag-step')).toHaveCount(11)
  await expect(page.locator('.diag-trace-warning')).toContainText('不代表完整解析路径')
  await expect(page.locator('.diag-step').last()).toContainText('future_stage')
  await noOverflow(page)
})

test('查询失败可重试，成功空轨迹不沿用旧结果', async ({ page }) => {
  await diagnosticFixture(page, { ...answerFixture, response_code: 'NXDOMAIN', answers: [] }, true)
  await page.goto('/diagnostics')
  await page.getByRole('button', { name: '执行查询', exact: true }).click()
  await expect(page.locator('.diag-error')).toContainText('DNS 服务暂不可用')
  await expect(page.locator('.diagnostic-result')).toHaveCount(0)
  await page.getByRole('button', { name: '执行查询', exact: true }).click()
  await expect(page.locator('.diag-error')).toHaveCount(0)
  await expect(page.locator('.diag-status')).toContainText('NXDOMAIN')
  await expect(page.locator('.diag-note')).toContainText('本次查询没有返回执行轨迹')
  await noOverflow(page)
})
