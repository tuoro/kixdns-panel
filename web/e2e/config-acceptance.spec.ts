import { expect, test, type Page } from '@playwright/test'

/**
 * 配置页规范第 14 节的验收清单里能自动检查的几条：文字角色（B）、控件（C）、说明文字预算（D）、
 * 空闲安静（E）、横线（F）、减少动态效果（H）、键盘（I）。每条都在真实形状的配置上扫所有视图，
 * 出错时把违规的元素列出来，而不是只说「不对」。
 *
 * The automatable items of the config page spec's acceptance list (section 14): text roles (B),
 * controls (C), the copy budget (D), idle quiet (E), rules (F), reduced motion (H) and the keyboard (I).
 * Each scans every view on a realistically shaped config and lists the offending elements on failure.
 */

// 真实形状的配置：域名映射、四个入口（最后一个是兜底）、一个没有入口的 Pipeline、带响应处理的规则
// A realistically shaped config: a domain mapping, four entries (the last a catch-all), a Pipeline with no entry, a rule with response handling
const stagedConfig = {
  version: '1.0',
  settings: { bind_udp: '0.0.0.0:53', bind_tcp: '0.0.0.0:53', default_upstream: '1.1.1.1:53', upstream_timeout_ms: 1800, cache_capacity: 20000 },
  pipeline_select: [
    { pipeline: 'domain_mapping', matcher_operator: 'or', matchers: [{ type: 'domain_suffix', value: 'nas.home.arpa' }, { type: 'domain_suffix', value: 'router.home.arpa' }] },
    { pipeline: 'blocked', matcher_operator: 'and', matchers: [{ type: 'geo_site', operator: 'and', value: 'category-ads-all' }] },
    { pipeline: 'domestic', matcher_operator: 'and', matchers: [{ type: 'geo_site', operator: 'and', value: 'cn' }] },
    { pipeline: 'domestic', matcher_operator: 'and', matchers: [{ type: 'client_ip', operator: 'and', cidr: '192.168.1.36/32' }] },
    { pipeline: 'default', matcher_operator: 'and', matchers: [{ type: 'any', operator: 'and' }] },
  ],
  pipelines: [
    { id: 'domain_mapping', rules: [
      { name: 'domain_mapping-mapping-1', matchers: [{ type: 'domain_suffix', value: 'nas.home.arpa' }], actions: [{ type: 'static_cname_response', target: 'nas.lan.example.net', ttl: 300 }], response_matchers: [], response_actions_on_match: [], response_actions_on_miss: [] },
      { name: 'domain_mapping-mapping-2', matchers: [{ type: 'domain_suffix', value: 'router.home.arpa' }], actions: [{ type: 'static_cname_response', target: 'gw.lan.example.net', ttl: 300 }], response_matchers: [], response_actions_on_match: [], response_actions_on_miss: [] },
    ] },
    { id: 'default', rules: [
      { name: 'secure-forward', matchers: [], matcher_operator: 'and', actions: [{ type: 'forward', upstream: 'https://dns.google/dns-query', transport: 'doh' }], response_matchers: [{ type: 'response_answer_ip', operator: 'and', cidr: '0.0.0.0/32' }], response_matcher_operator: 'and', response_actions_on_match: [{ type: 'log', level: 'warn' }, { type: 'jump_to_pipeline', pipeline: 'fallback-check' }], response_actions_on_miss: [] },
      { name: 'late-rule', matchers: [{ type: 'qtype', operator: 'and', value: 'AAAA' }], matcher_operator: 'and', actions: [{ type: 'static_response', rcode: 'NXDOMAIN' }] },
    ] },
    { id: 'domestic', rules: [{ name: 'cn-direct', matchers: [], matcher_operator: 'and', actions: [{ type: 'forward', upstream: '223.5.5.5:53', transport: 'tcp_udp' }] }] },
    { id: 'blocked', rules: [{ name: 'deny-ads', matchers: [], matcher_operator: 'and', actions: [{ type: 'static_response', rcode: 'NXDOMAIN' }] }] },
    { id: 'fallback-check', rules: [{ name: 'fallback-log', matchers: [], matcher_operator: 'and', actions: [{ type: 'log', level: 'info' }, { type: 'forward', upstream: '1.1.1.1:53', transport: 'udp' }] }] },
  ],
}

// 只在测试里替换 API 模块边界：读配置时换成上面这份，其余照常 / Swaps the API module boundary in the test only: the config read returns the one above
async function stage(page: Page): Promise<void> {
  await page.route(/\/src\/api\/client\.ts(?:\?.*)?$/, async (route) => {
    if (route.request().url().includes('acceptance-original')) return route.continue()
    await route.fulfill({ contentType: 'application/javascript', body: `
      export * from '/src/api/client.ts?acceptance-original';
      import { apiRequest as original } from '/src/api/client.ts?acceptance-original';
      const staged = ${JSON.stringify(stagedConfig)};
      export async function apiRequest(path, init) {
        const result = await original(path, init);
        if (path === '/api/v1/config' && (!init || !init.method || init.method === 'GET')) {
          // 骨架的测试把读配置拦住，好量骨架 / The skeleton test holds the config read so the skeleton can be measured
          if (sessionStorage.getItem('acceptance-hold-config')) await new Promise(() => {});
          return { ...result, content: staged };
        }
        return result;
      }
    ` })
  })
}

interface View { name: string; open: (page: Page) => Promise<void>; idle?: boolean; dialog?: boolean }

const views: View[] = [
  { name: '工作台', idle: true, open: async () => {} },
  { name: '检查器（转发入口）', idle: true, open: async (page) => { await page.getByRole('button', { name: /^编辑入口 02 / }).click() } },
  { name: '添加入口（分流）', open: async (page) => {
    await page.locator('.workbench-list-toolbar').getByRole('button', { name: '添加入口', exact: true }).click()
    await page.getByRole('radio', { name: /国内外 DNS 分流/ }).click()
  } },
  { name: '自由编辑', idle: true, open: async (page) => { await page.locator('.workbench-list-toolbar').getByRole('button', { name: '自由编辑', exact: true }).click() } },
  { name: '一键添加规则', dialog: true, open: async (page) => {
    await page.locator('.workbench-list-toolbar').getByRole('button', { name: '自由编辑', exact: true }).click()
    await page.locator('.manual-pipeline').first().getByRole('button', { name: '一键添加', exact: true }).click()
    await page.getByRole('radio', { name: /异常响应回退/ }).click()
  } },
  { name: '域名映射', idle: true, open: async (page) => { await page.getByRole('tab', { name: '域名映射', exact: true }).click() } },
  { name: '基础设置', idle: true, open: async (page) => { await page.getByRole('tab', { name: '基础设置', exact: true }).click() } },
  { name: 'Geo 数据', idle: true, open: async (page) => {
    await page.getByRole('tab', { name: '基础设置', exact: true }).click()
    await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: /Geo 数据/ }).click()
  } },
  { name: '历史版本', dialog: true, open: async (page) => { await page.getByRole('button', { name: '历史版本', exact: true }).click() } },
  { name: '版本比较', dialog: true, open: async (page) => {
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    await page.getByTitle(/^比较版本 #\d+ 和当前$/).first().click()
  } },
  { name: '草稿有修改', open: async (page) => {
    await page.getByRole('button', { name: /^编辑入口 02 / }).click()
    await page.locator('.workbench-inspector').getByLabel('条件 1 值', { exact: true }).fill('cn-direct-list')
    await page.getByRole('button', { name: '应用到草稿', exact: true }).click()
  } },
  { name: 'JSON', open: async (page) => { await page.getByRole('button', { name: 'JSON', exact: true }).click() } },
]

async function openView(page: Page, view: View): Promise<void> {
  await stage(page)
  await page.goto('/config')
  await expect(page.locator('.workbench, .config-skeleton').first()).toBeVisible()
  await expect(page.locator('.config-skeleton')).toHaveCount(0)
  await view.open(page)
  // 等出现动画走完（最长 500），再量 / Let the entrance animations finish (500 at most) before measuring
  await page.waitForTimeout(600)
}

// 扫的范围：配置页本身，和打开着的对话框、菜单 / What gets scanned: the config page and any open dialog or menu
const SCOPE = '.config-page, dialog[open], .ui-menu--pop:popover-open'

test.describe('B 文字角色', () => {
  for (const view of views) {
    test(`${view.name}：字号只有 12、13、14、17、22，字重只有 400、500、600，颜色都是令牌 @responsive`, async ({ page }) => {
      await openView(page, view)
      const problems = await page.evaluate((scope) => {
        const probe = document.createElement('span')
        document.body.append(probe)
        const tokens = [...document.styleSheets].flatMap((sheet) => {
          try { return [...sheet.cssRules] } catch { return [] }
        }).flatMap((rule) => (rule instanceof CSSStyleRule && rule.selectorText === ':root' ? [...rule.style].filter((name) => name.startsWith('--')) : []))
        const colors = new Set(tokens.map((name) => {
          probe.style.color = ''
          probe.style.color = `var(${name})`
          return getComputedStyle(probe).color
        }))
        probe.remove()
        const phone = window.innerWidth <= 640
        const found: string[] = []
        const seen = new Set<Element>()
        let scanned = 0
        for (const root of document.querySelectorAll(scope)) {
          for (const element of root.querySelectorAll<HTMLElement>('*')) {
            // JSON 编辑器里的字也守文字角色：13 号等宽、键名 500、颜色用令牌 / The JSON editor's text keeps the roles too
            if (seen.has(element) || element.closest('svg')) continue
            seen.add(element)
            const text = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? '').join('').trim()
            // 可编辑区域（JSON 编辑器的正文）也是输入框：手机上同样 16 / An editable region (the JSON editor's text) is a field too: 16 on a phone as well
            const field = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || Boolean(element.closest('[contenteditable="true"]'))
            if (!text && !field) continue
            if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') continue
            scanned += 1
            const style = getComputedStyle(element)
            const size = Math.round(parseFloat(style.fontSize) * 100) / 100
            const weight = Number(style.fontWeight)
            const label = `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}「${(text || (element as HTMLInputElement).value || '').slice(0, 16)}」`
            if (![12, 13, 14, 17, 22].includes(size) && !(phone && field && size === 16)) found.push(`字号 ${size}：${label}`)
            if (![400, 500, 600].includes(weight)) found.push(`字重 ${weight}：${label}`)
            if (!field && !colors.has(style.color)) found.push(`颜色 ${style.color}：${label}`)
          }
        }
        // 扫到的文字太少说明范围选错了，不能当作通过 / Too little text scanned means the scope is wrong, which must not pass
        if (scanned < 20) found.push(`只扫到 ${scanned} 个有字的元素`)
        return found
      }, SCOPE)
      expect(problems, problems.join('\n')).toEqual([])
    })
  }
})

test.describe('C 控件', () => {
  for (const width of [1440, 1024, 768, 700, 375]) {
    for (const view of views) {
      test(`${view.name} @ ${width}：只用组件库的下拉框，图标只有 14 和 16，同一行的控件一样高`, async ({ page }) => {
        await page.setViewportSize({ width, height: width < 500 ? 812 : 1000 })
        await openView(page, view)
        const problems = await page.evaluate((scope) => {
          const found: string[] = []
          const roots = [...document.querySelectorAll(scope)]
          const inScope = (element: Element) => roots.some((root) => root.contains(element))
          for (const select of document.querySelectorAll('select')) {
            if (inScope(select) && !select.closest('.ui-select')) found.push(`不是 .ui-select 的下拉框：${select.getAttribute('aria-label')}`)
          }
          for (const icon of document.querySelectorAll<SVGElement>('svg')) {
            if (!inScope(icon) || !icon.getClientRects().length || icon.closest('.ui-empty__icon, .cm-editor')) continue
            const { width: w, height: h } = icon.getBoundingClientRect()
            if (![14, 16].includes(Math.round(w)) || Math.round(w) !== Math.round(h)) found.push(`图标 ${Math.round(w)}×${Math.round(h)}：${icon.getAttribute('class')} 在 ${icon.parentElement?.className}`)
          }
          // 同一行：竖向范围重叠、共享同一个父容器的控件 / One line: controls sharing a parent whose vertical spans overlap
          const controls = [...document.querySelectorAll<HTMLElement>('button, .ui-input, .ui-seg, .ui-rows__handle')]
            .filter((element) => inScope(element) && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
            .filter((element) => !element.matches('.ui-tag, .ui-menu__item, .ui-seg__opt, .ui-pick__opt *, .ui-objlink, .config-head-action, .ui-input button, .ui-input__affix, [role="tab"], .workbench-entry-select, .workbench-row, .manual-pipeline__toggle, .config-history__main, .ui-tabs__tab, .settings-nav__item'))
            .filter((element) => !element.parentElement?.closest('.ui-input, .ui-seg'))
          const byParent = new Map<Element, HTMLElement[]>()
          for (const control of controls) {
            const line = control.parentElement!
            byParent.set(line, [...(byParent.get(line) ?? []), control])
          }
          for (const [line, items] of byParent) {
            const boxes = items.map((item) => ({ item, box: item.getBoundingClientRect() }))
            for (const a of boxes) {
              for (const b of boxes) {
                if (a.item === b.item) continue
                const overlap = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top)
                if (overlap > 4 && Math.abs(a.box.height - b.box.height) > 1) {
                  found.push(`同一行高度不同（${Math.round(a.box.height)} 与 ${Math.round(b.box.height)}）：${a.item.className || a.item.tagName} / ${b.item.className || b.item.tagName} 在 ${(line as HTMLElement).className}`)
                }
              }
            }
          }
          return [...new Set(found)]
        }, SCOPE)
        expect(problems, problems.join('\n')).toEqual([])
      })
    }
  }
})

test.describe('E 空闲安静', () => {
  for (const view of views.filter((item) => item.idle)) {
    test(`${view.name}：没有修改时保存栏不在，没有常驻的禁用按钮 @responsive`, async ({ page }) => {
      await openView(page, view)
      await expect(page.locator('.config-savebar')).toHaveCount(0)
      const disabled = await page.locator('.config-page button:disabled:visible').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') || button.textContent?.trim()))
      expect(disabled, `常驻的禁用按钮：${disabled.join('、')}`).toEqual([])
    })
  }

  test('首行没有上移、末行没有下移：占位但看不见 @responsive', async ({ page }) => {
    await openView(page, views.find((view) => view.name === '自由编辑')!)
    const rules = page.locator('.manual-pipeline[data-pipeline="default"]').locator('.manual-rule')
    await expect(rules).toHaveCount(2)
    await expect(rules.first().getByRole('button', { name: /^上移规则/ })).toBeHidden()
    await expect(rules.last().getByRole('button', { name: /^下移规则/ })).toBeHidden()
  })
})

test.describe('D 说明文字预算', () => {
  for (const view of views) {
    test(`${view.name}：注释角色的字加占位符里的中文不超过 120 字 @responsive`, async ({ page }) => {
      await openView(page, view)
      const { total, parts } = await page.evaluate((scope) => {
        const roots = [...document.querySelectorAll(scope)]
        const inScope = (element: Element) => roots.some((root) => root.contains(element))
        const parts: string[] = []
        // 注释角色：12 号、400 的界面字（不是机器值、不是标签、不是出错信息） / The note role: 12px, 400, UI font (not machine values, tags or errors)
        for (const element of document.querySelectorAll<HTMLElement>('p, small, span, li')) {
          if (!inScope(element) || !element.getClientRects().length || element.closest('.cm-editor, code, .ui-tag, .ui-field-error, .ui-diff, .config-history, .workbench-entry-number, .ui-rows__num, .ui-menu__title')) continue
          const style = getComputedStyle(element)
          if (parseFloat(style.fontSize) !== 12 || Number(style.fontWeight) !== 400 || /Plex Mono/i.test(style.fontFamily.split(',')[0] ?? '')) continue
          const own = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? '').join('')
          const cjk = own.match(/[一-鿿]/g)?.length ?? 0
          if (cjk) parts.push(`${cjk} 注释：${own.trim().slice(0, 24)}`)
        }
        for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[placeholder], textarea[placeholder]')) {
          if (!inScope(field) || !field.getClientRects().length) continue
          const cjk = field.placeholder.match(/[一-鿿]/g)?.length ?? 0
          if (cjk) parts.push(`${cjk} 占位：${field.placeholder}`)
        }
        return { total: parts.reduce((sum, part) => sum + Number(part.split(' ')[0]), 0), parts }
      }, SCOPE)
      // 实际字数记在测试结果里，方案页的第 4 节从这里取数 / The measured count goes into the test result; section 4 of the package page takes it from there
      test.info().annotations.push({ type: '字数', description: String(total) })
      expect(total, parts.join('\n')).toBeLessThanOrEqual(120)
    })
  }
})

test.describe('F 横线', () => {
  // 每个视图允许出现的横线：面板边、页签底线、头部下沿、底栏上沿……框（四边都有）不算线。
  // 页签底线宽屏上画在整个导航行（config-nav）下，手机上画在页签（config-sections）自己下面，指示块落在线上。
  // The rules each view may show: panel edges, the tab underline, a header's bottom edge, a footer's top edge. Boxes (all four sides) are not rules.
  // The tab baseline runs under the whole nav row (config-nav) on wide screens and under the tabs themselves (config-sections) on a phone, so the indicator sits on it.
  const allowed = [
    'config-nav', 'config-sections', 'ui-tabs__ind', 'config-guide__header', 'config-guide__footer', 'config-guide__path', 'workbench-custom__head',
    'config-drawer__head', 'config-drawer__foot', 'ui-rec', 'config-diff-dialog__header', 'config-diff-dialog__footer',
    'ui-menu__sep', 'cm-gutters', 'ui-savebar',
  ]
  for (const view of views) {
    test(`${view.name}：可见的横线只有允许的那几种 @responsive`, async ({ page }) => {
      await openView(page, view)
      const lines = await page.evaluate((scope) => {
        const roots = [...document.querySelectorAll(scope)]
        const found: string[] = []
        for (const root of roots) {
          for (const element of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
            if (!(element instanceof HTMLElement) || !element.getClientRects().length) continue
            const style = getComputedStyle(element)
            const drawn = (side: 'Top' | 'Bottom' | 'Left' | 'Right') => parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== 'none' && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(style[`border${side}Color`])
            const horizontal = drawn('Top') || drawn('Bottom')
            const box = drawn('Top') && drawn('Bottom') && drawn('Left') && drawn('Right')
            if (!horizontal || box || element.getBoundingClientRect().width < 40) continue
            found.push([...element.classList].join('.') || element.tagName.toLowerCase())
          }
        }
        return [...new Set(found)]
      }, SCOPE)
      const unexpected = lines.filter((line) => !allowed.some((name) => line.split('.').includes(name)))
      expect(unexpected, `不在允许名单里的横线：${unexpected.join('、')}`).toEqual([])
    })
  }
})

test('H 减少动态效果：出现、展开、菜单、抽屉都不位移 @responsive', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openView(page, views[0]!)
  // 记下所有带位移的动画 / Record every animation that moves something
  await page.evaluate(() => {
    const moving = (window as unknown as { __moving: string[] }).__moving = []
    const observe = () => {
      for (const animation of document.getAnimations()) {
        const effect = animation.effect as KeyframeEffect | null
        const frames = effect?.getKeyframes() ?? []
        if (frames.some((frame) => frame.transform && frame.transform !== 'none')) moving.push(`${(effect?.target as Element | null)?.className ?? '?'}：${(animation as CSSAnimation).animationName ?? 'transition'}`)
      }
      requestAnimationFrame(observe)
    }
    observe()
  })
  await page.getByRole('button', { name: /^编辑入口 02 / }).click()
  await page.locator('.workbench-inspector').getByLabel('条件 1 值', { exact: true }).fill('cn-direct-list')
  await page.getByRole('button', { name: '应用到草稿', exact: true }).click()
  await expect(page.locator('.config-savebar')).toBeVisible()
  // 手机上在面板里打字时保存栏收着、量不到高度；滚动留白要等栏露出来才按它算，不能是一整屏（规范 8.2）
  // On a phone the bar is folded away while typing in the sheet and measures nothing; scroll padding follows the bar once it
  // shows, never a whole screen (spec 8.2)
  expect(await page.evaluate(() => parseFloat(document.documentElement.style.scrollPaddingBottom) || 0)).toBeLessThan(page.viewportSize()!.height / 2)
  await page.getByLabel(/^入口 \d+ 操作$/).first().click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '历史版本', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '历史版本' })).toBeVisible()
  await page.waitForTimeout(600)
  const moving = await page.evaluate(() => [...new Set((window as unknown as { __moving: string[] }).__moving)])
  expect(moving, moving.join('\n')).toEqual([])
})

// 放得下一行的网址整块换到下一行，不在「/」后面拆开；前面的「转发至」放不下时留在上一行（审计第三轮 V2、A3）
// A URL that fits a line wraps whole instead of splitting after a 「/」; the 转发至 before it stays on the line above when both do not fit (audit round 3, V2, A3)
test('放得下一行的网址整块换行，不拆开 @responsive', async ({ page }) => {
  await openView(page, { name: '流程', open: async (current) => { await current.getByRole('button', { name: '流程', exact: true }).click() } })
  const url = page.locator('.flow-rule', { hasText: 'secure-forward' }).locator('.phrase__unit', { hasText: 'https://dns.google/dns-query' })
  await expect(url).toHaveCount(1)
  const height = (await url.boundingBox())!.height
  const line = await url.evaluate((element) => parseFloat(getComputedStyle(element).lineHeight))
  expect(height).toBeLessThan(line * 1.5)
})

// 自由编辑的 Pipeline 标题：说明只在「 · 」后面换行，不把「规则」这样的词拆成两行；箭头留在名字那一行。
// 规则展开、以「响应处理」收尾时，到下一个 Pipeline 名字的距离和规则收起时一样（审计第五轮 V1、V2、V3）
// 自由编辑's Pipeline titles: the fact breaks only after 「 · 」, never splitting a word such as 规则, and the chevron stays on the name line.
// An expanded rule ending on 响应处理 is as far from the next Pipeline's name as the same rule collapsed (audit round 5, V1, V2, V3)
test('自由编辑：Pipeline 标题不拆词，规则展开和收起时到下一个 Pipeline 一样远 @responsive', async ({ page }) => {
  await openView(page, views.find((view) => view.name === '自由编辑')!)
  const readTitles = () => page.locator('.manual-pipeline__head').evaluateAll((heads) => heads.map((head) => {
    const title = head.querySelector('.manual-pipeline__title')!
    const range = document.createRange()
    const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT)
    const breaks: string[] = []
    let top: number | null = null
    let previous = ''
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      for (let index = 0; index < node.length; index += 1) {
        range.setStart(node, index)
        range.setEnd(node, index + 1)
        const rect = range.getClientRects()[0]
        const char = node.data[index]!
        if (!rect || /\s/.test(char)) continue
        if (top !== null && rect.top > top + 4) breaks.push(`${previous}|${char}`)
        top = rect.top
        previous = char
      }
    }
    // 名字那一行：标题的第一个行框。等宽字自己的字框比行框高，量它的中线会偏 2（审计第六轮）
    // The name line is the title's first line box; the mono font's own content box is taller than the line, so its centre sits 2 off (round 6)
    const nameLine = title.getBoundingClientRect().top + parseFloat(getComputedStyle(title).lineHeight) / 2
    const chevron = head.querySelector('.manual-pipeline__chev')!.getBoundingClientRect()
    const menu = head.querySelector('.manual-reveal .ui-icon-btn, .manual-reveal button')?.getBoundingClientRect()
    const toggle = head.querySelector('.manual-pipeline__toggle')!.getBoundingClientRect()
    const centre = (rect: DOMRect) => (rect.top + rect.bottom) / 2
    return {
      text: title.textContent,
      breaks,
      // 行数按标题的高度数：等宽字和中文的字框上沿不齐，按字的位置数会把一行数成两行
      // Lines are counted from the title's height: mono and Chinese glyph boxes start at different heights, so counting by glyph position can see two lines in one
      lines: Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight)),
      toggle: toggle.height,
      chevron: Math.abs(centre(chevron) - nameLine),
      menu: menu ? Math.abs(centre(menu) - nameLine) : 0,
    }
  }))
  const splitsOf = (titles: Awaited<ReturnType<typeof readTitles>>) => titles
    .filter((title) => title.breaks.some((pair) => /^\p{Script=Han}\|\p{Script=Han}$/u.test(pair)))
    .map((title) => `${title.text}：${title.breaks.join(' ')}`)
  const titles = await readTitles()
  expect(splitsOf(titles), '在词中间换行的标题').toEqual([])
  const offLine = titles.filter((title) => title.chevron >= 1 || title.menu >= 1).map((title) => `${title.text}：箭头 ${title.chevron.toFixed(1)}，「…」 ${title.menu.toFixed(1)}`)
  expect(offLine, '箭头或「…」不在名字那一行的标题').toEqual([])
  // 一行的标题按钮正好 44：名字和说明各按各的行高对齐时撑到过 46.5（审计第六轮 C4、V2）
  // A one-line title's toggle is exactly 44: the name and fact on their own line heights once grew it to 46.5 (audit round 6, C4, V2)
  const tall = titles.filter((title) => title.lines === 1 && Math.abs(title.toggle - 44) > 0.5).map((title) => `${title.text}：${title.toggle}`)
  expect(tall, '一行的标题按钮不是 44 高').toEqual([])

  // 下一个 Pipeline 名字的字的上沿，减去这一条规则最后一行字的下沿；只量文字，不量行内块的盒子
  // The top of the next Pipeline name's text, less the bottom of the rule's last line of text; text only, never an inline block's box
  // domestic 的规则是转发，所以它以「响应处理」收尾；下一个是 blocked / domestic's rule forwards, so it ends on 响应处理; blocked comes next
  const domestic = page.locator('.manual-pipeline[data-pipeline="domestic"]')
  const toggle = domestic.locator('.manual-pipeline__toggle')
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  // 手机上 ECS 下拉框和上面的 Pipeline ID 框在同一条右边线结束（审计第五轮 V4、第六轮 V1）
  // On a phone the ECS select ends on the Pipeline ID box's right edge (audit round 5 V4, round 6 V1)
  if ((page.viewportSize()?.width ?? 1440) <= 640) {
    const idBox = (await domestic.getByLabel(/^Pipeline \d+ ID$/).locator('xpath=..').boundingBox())!
    const ecsBox = (await domestic.locator('.manual-field__controls > .ui-select').first().boundingBox())!
    expect(Math.abs(ecsBox.x + ecsBox.width - (idBox.x + idBox.width)), 'ECS 下拉框的右边线').toBeLessThanOrEqual(0.5)
  }
  const rule = domestic.locator('.manual-rule').last()
  const next = page.locator('.manual-pipeline[data-pipeline="blocked"] .manual-pipeline__title code')
  const textEdges = (locator: typeof rule) => locator.evaluate((element) => {
    const range = document.createRange()
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const rects: DOMRect[] = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      range.selectNodeContents(node)
      rects.push(...[...range.getClientRects()].filter((rect) => rect.width > 0))
    }
    return { top: Math.min(...rects.map((rect) => rect.top)), bottom: Math.max(...rects.map((rect) => rect.bottom)) }
  })
  await expect(rule.locator('.manual-response__summary')).toBeVisible()
  const expanded = (await textEdges(next)).top - (await textEdges(rule.locator('.manual-response__summary > span'))).bottom
  await rule.getByRole('button', { name: /^收起规则/ }).click()
  await expect(rule.locator('.manual-rule__summary')).toBeVisible()
  const collapsed = (await textEdges(next)).top - (await textEdges(rule.locator('.manual-rule__summary'))).bottom
  expect(Math.abs(expanded - collapsed), `展开 ${expanded.toFixed(1)}，收起 ${collapsed.toFixed(1)}`).toBeLessThanOrEqual(3)

  // 手机的各种宽度都扫一遍：换行落在哪里取决于宽度，只量一个宽度会漏掉 / Sweep the phone widths: where a line breaks depends on the width, so one width can miss it
  const splits: string[] = []
  for (let width = 320; width <= 480; width += 4) {
    await page.setViewportSize({ width, height: 812 })
    splits.push(...splitsOf(await readTitles()).map((split) => `${width}：${split}`))
  }
  expect(splits, '在词中间换行的标题').toEqual([])
})

// 骨架照上一次的列表画：再打开这一页时，骨架每一行名字的格子和读完以后的名字在同一高度，数据到了行不挪（审计第五轮 B1）
// The skeleton follows the list as it was last time: on the next visit each skeleton row's name box sits where the loaded name does,
// so rows stay put when the data arrives (audit round 5, B1)
test('骨架照上次的列表画，数据到了行不挪 @responsive', async ({ page }) => {
  await openView(page, views[0]!)
  const rowTops = (rows: string, name: string) => page.locator(rows).evaluateAll((elements, selector) => elements.map((element) => element.querySelector(selector)!.getBoundingClientRect().top), name)
  const loaded = (await rowTops('.workbench-routes :is(.workbench-mapping-row, .workbench-entry)', '.workbench-entry-condition')).slice(0, 6)
  // 重新打开这一页（离开时会记下列表的样子），读配置停住不回来 / Reopen the page (leaving records the list's shape) with the config read held
  await page.evaluate(() => sessionStorage.setItem('acceptance-hold-config', '1'))
  await page.goto('/config')
  await expect(page.locator('.config-skeleton')).toBeVisible()
  // 画的是记下来的样子，不是默认的样子：默认的样子带 --more 那几条（审计第六轮 C5）
  // The record is drawn, not the default shape, which carries the --more bars (audit round 6, C5)
  await expect(page.locator('.config-skeleton__route--more')).toHaveCount(0)
  const skeleton = await rowTops('.config-skeleton__row', '.config-skeleton__name')
  expect(skeleton).toHaveLength(loaded.length)
  const moved = skeleton.map((top, index) => ({ row: index + 1, by: Math.round((loaded[index]! - top) * 10) / 10 })).filter((row) => Math.abs(row.by) > 1)
  expect(moved, '数据到了以后会挪的行').toEqual([])
})

// 同一行上的字坐同一条基线：流程两栏的第一行（审计第五轮 V6、第八轮 V2），手机上 JSON 的行号和正文（审计第七轮 V2、第八轮 V1）；
// JSON 当前行的底色在行号栏和正文里上下对齐
// Text on one line shares a baseline: the first lines of 流程's two columns (audit round 5 V6, round 8 V2) and, on a phone, JSON line numbers
// and code (audit round 7 V2, round 8 V1); the JSON active line's band lines up across the gutter and the code
test('流程两栏的第一行、JSON 的行号和正文同一条基线 @responsive', async ({ page }) => {
  const baseline = (locator: ReturnType<Page['locator']>) => locator.evaluate((element) => {
    const probe = document.createElement('span')
    probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'
    element.appendChild(probe)
    const y = probe.getBoundingClientRect().top
    probe.remove()
    return y
  })
  const phone = (page.viewportSize()?.width ?? 1440) <= 640
  if (!phone) {
    await openView(page, { name: '流程', open: async (current) => { await current.getByRole('button', { name: '流程', exact: true }).click() } })
    const left = await baseline(page.locator('.flow-col').first().locator('.flow-route .flow-body > span').first())
    const right = await baseline(page.locator('.flow-col').nth(1).locator('.flow-pipeline header code').first())
    expect(Math.abs(left - right), '流程两栏第一行的基线').toBeLessThanOrEqual(0.5)
  }
  await openView(page, views.find((view) => view.name === 'JSON')!)
  await page.locator('.cm-content .cm-line').nth(1).click()
  const number = page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^2$/ })
  const line = page.locator('.cm-content .cm-line').nth(1)
  expect(Math.abs(await baseline(number) - await baseline(line)), '行号和正文的基线').toBeLessThanOrEqual(0.5)
  const band = (await page.locator('.cm-activeLineGutter').boundingBox())!
  const active = (await page.locator('.cm-activeLine').boundingBox())!
  expect(Math.abs(band.y - active.y), '当前行底色的上沿').toBeLessThanOrEqual(0.5)
  expect(Math.abs(band.y + band.height - active.y - active.height), '当前行底色的下沿').toBeLessThanOrEqual(0.5)
})

test.describe('I 键盘', () => {
  test('添加条件后焦点在新行的类型，删掉一行后焦点在接替它的那一行 @responsive', async ({ page }) => {
    await openView(page, views[1]!)
    const inspector = page.locator('.workbench-inspector')
    await inspector.getByRole('button', { name: '添加条件', exact: true }).click()
    await expect(inspector.getByLabel('条件 2 类型', { exact: true })).toBeFocused()
    await inspector.getByRole('button', { name: '删除条件 1', exact: true }).click()
    await expect(inspector.getByLabel('条件 1 类型', { exact: true })).toBeFocused()
  })

  test('「…」菜单：回车打开并聚焦第一项，方向键移动，Esc 关闭并把焦点还给按钮', async ({ page }) => {
    await openView(page, views[0]!)
    const trigger = page.getByLabel('入口 02 操作', { exact: true })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: '入口 02 操作' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: '移到最前', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: '上移', exact: true })).toBeFocused()
    await page.keyboard.press('End')
    await expect(menu.getByRole('menuitem', { name: '删除入口', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test('子项的序号是「调整顺序」菜单：用键盘挪一条动作，焦点跟着那一条走', async ({ page }) => {
    await openView(page, views[3]!)
    const rule = page.locator('.manual-pipeline[data-pipeline="fallback-check"]')
    await rule.locator('.manual-pipeline__toggle').click()
    const handle = rule.getByLabel('调整动作 1 的顺序', { exact: true })
    await handle.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(rule.getByLabel('动作 2 类型', { exact: true })).toHaveValue('log')
    await expect(rule.getByLabel('调整动作 2 的顺序', { exact: true })).toBeFocused()
  })

  test('⌘/Ctrl+S 等于点保存栏的主要按钮 @responsive', async ({ page }) => {
    await openView(page, views.find((view) => view.name === '草稿有修改')!)
    await expect(page.locator('.config-savebar')).toBeVisible()
    await page.keyboard.press('ControlOrMeta+s')
    await expect(page.locator('.config-save-state')).toContainText('已生效')
  })
})
