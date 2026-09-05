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
  await expect(page.getByRole('heading', { name: 'DNS 诊断', exact: true })).toBeVisible()
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
  await expect(page.locator('.diagnostic-match-summary')).toContainText('geosite-global')
  await expect(page.locator('.diagnostic-match-summary')).toContainText('Pipeline · default')
  await expect(page.locator('.diag-result-footer')).toContainText('KixDNS 内部执行链')
  await expect(page.locator('.diag-elapsed')).toHaveText('12 ms')
  await noOverflow(page)
})

test('执行步骤可选择和键盘折叠，缓存未命中不是故障', async ({ page }) => {
  await query(page)
  const steps = page.locator('.diag-step')
  await expect(steps).toHaveCount(6)
  await expect(steps.nth(3)).toHaveAttribute('aria-expanded', (page.viewportSize()?.width ?? 1440) <= 700 ? 'false' : 'true')
  await steps.nth(5).click()
  const detail = page.locator('.diag-step-detail:visible')
  await expect(detail).toHaveCount(1)
  await expect(detail).toContainText('https://1.1.1.1/dns-query')
  await expect(detail).toContainText('不表示该阶段的独立耗时')
  await steps.nth(5).press('Enter')
  await expect(detail).toHaveCount(0)
  await steps.nth(2).click()
  await expect(steps.nth(2)).toHaveClass(/diag-step--neutral/)
  await expect(detail).toContainText('未命中')
  await noOverflow(page)
})

test('原始应答原样保留，重新查询不沿用旧步骤状态', async ({ page }) => {
  await query(page, '  example.net  ')
  const raw = page.locator('.diag-raw-response')
  await raw.locator('summary').click()
  await expect(raw.locator('pre').first()).toHaveText('example.net. 300 IN A 104.18.26.120')
  await page.locator('.diag-step').first().click()
  await page.getByLabel('域名', { exact: true }).fill('example.org')
  await page.getByRole('button', { name: '执行查询', exact: true }).click()
  await expect(page.locator('.diag-step').nth(3)).toHaveAttribute('aria-expanded', (page.viewportSize()?.width ?? 1440) <= 700 ? 'false' : 'true')
  await expect(page.locator('.diag-step').first()).toContainText('example.org')
})

test('窄屏查询同行且标题、命中名不再海报化', async ({ page }) => {
  // 两个项目都使用 Desktop Chrome，按真实 viewport 而非设备标志判断响应式分支。
  await query(page)
  if ((page.viewportSize()?.width ?? 1440) > 700) return
  const input = await page.getByLabel('域名', { exact: true }).boundingBox()
  const type = await page.getByLabel('记录类型', { exact: true }).boundingBox()
  const submit = await page.getByRole('button', { name: '执行查询' }).boundingBox()
  expect(input?.y).toBe(type?.y)
  expect(input?.y).toBe(submit?.y)
  expect(await page.locator('.diag-heading h1').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeLessThanOrEqual(22)
  expect(await page.locator('.diag-match strong').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeLessThanOrEqual(16)
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
  await expect(page.locator('.diag-match')).toContainText('响应缓存命中，未记录规则匹配')
  await expect(page.locator('.diag-empty-answers')).toBeVisible()
  await expect(page.locator('.diag-answers > header')).toContainText('已截断')
  await expect(page.locator('.diag-step')).toHaveCount(1)
  await noOverflow(page)
})

test('多个命中与长轨迹不被固定六阶段裁掉', async ({ page }) => {
  const trace: DnsTraceStep[] = Array.from({ length: 11 }, (_, index) => ({
    stage: index === 10 ? 'future_stage' : 'rule', status: 'matched', label: 'rule-' + index + '-' + 'long-name-'.repeat(8), detail: '保留原始说明', elapsed_ms: index,
  }))
  await diagnosticFixture(page, { ...answerFixture, trace, trace_truncated: true })
  await query(page)
  await expect(page.locator('.diag-match li')).toHaveCount(10)
  await expect(page.locator('.diag-step')).toHaveCount(11)
  await expect(page.locator('.diag-trace-warning')).toContainText('不代表完整解析路径')
  await page.locator('.diag-step').last().click()
  await expect(page.locator('.diag-step-detail:visible')).toContainText('future_stage')
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
