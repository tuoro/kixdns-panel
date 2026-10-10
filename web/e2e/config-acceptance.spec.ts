import { expect, test, type Page } from '@playwright/test'

/**
 * 配置页验收清单里能自动检查的几条：文字角色（B）、控件（C）、说明文字预算（D）、横线（F）。每条都在配置页的每一种状态上扫一遍，
 * 出错时把违规的元素列出来，而不是只说「不对」。
 *
 * The automatable items of the config page's acceptance list: text roles (B), controls (C), the copy budget (D) and rules (F).
 * Each scans every state of the config page and lists the offending elements on failure.
 */

// 页的各种状态：读的是演示配置（一个上游组、零条规则），需要内容的状态在打开时自己添上
// The page's states: on the demo config (one upstream group, no rules); states that need content add it while opening
interface View { name: string; path: string; dialog?: boolean; open: (page: Page, phone: boolean) => Promise<void> }

const quickAdd = async (page: Page, open: boolean, text: string, target?: string): Promise<void> => {
  // 宽屏上快速添加藏在工具行的「快速添加」后面，点一次就一直开着；手机上一直在 / On wide screens quick add hides behind 快速添加 and stays open once clicked; on phones it is always there
  if (!open) await page.getByRole('button', { name: '快速添加', exact: true }).click()
  const quick = page.getByLabel('快速添加：域名、GeoSite 或 IP 网段')
  await quick.fill(text)
  // 结果下拉框手机上要打了字才露出来，所以先填再选 / On a phone the outcome select shows only once something is typed, so fill first, then choose
  if (target) await page.getByLabel('快速添加的结果', { exact: true }).selectOption(target)
  await quick.press('Enter')
  // 新规则排在最后；几个值在行里用「、」连起来，按第一个找 / A new rule goes to the end; several values join with 「、」 in the row, so look for the first
  await expect(page.locator('[data-rule]').filter({ hasText: text.split(' ')[0]! })).toHaveCount(1)
}

const views: View[] = [
  // 两条规则：一条交给上游组，一条拦截，列表里的行、结果标签和「拦截」的样式都量得到 / Two rules, one to an upstream group and one blocked, so rows, outcome pills and the block styling are measured
  { name: '规则列表', path: '/config', open: async (page, phone) => {
    await quickAdd(page, phone, 'example.org www.example.org')
    await quickAdd(page, true, 'category-ads-all', 'block')
    await expect(page.locator('[data-rule]')).toHaveCount(2)
  } },
  // 宽屏（≥1360）在右栏里编辑，再窄就是整页编辑器 / Wide screens (≥1360) edit in the inspector; narrower ones in the full-page editor
  { name: '右栏编辑器', path: '/config', open: async (page, phone) => {
    await quickAdd(page, phone, 'example.org')
    await page.locator('[data-rule]').first().locator('.rrow__main').click()
    await expect(page.locator('.editor')).toBeVisible()
  } },
  { name: '测试域名', path: '/config', open: async (page) => {
    await page.getByRole('button', { name: '测试域名', exact: true }).click()
    const tester = page.locator('.tester')
    await tester.getByLabel('要测试的域名').fill('www.example.com')
    await tester.getByRole('button', { name: '测试', exact: true }).click()
    await expect(tester.locator('.tester__verdict')).toBeVisible()
  } },
  { name: '上游组', path: '/config?section=upstreams', open: async (page) => { await expect(page.locator('.gcard').first()).toBeVisible() } },
  { name: '新建上游组抽屉', path: '/config?section=upstreams', dialog: true, open: async (page) => {
    await page.getByRole('button', { name: '新建上游组', exact: true }).first().click()
    await expect(page.locator('dialog[open]').last().getByLabel('名称', { exact: true })).toBeVisible()
  } },
  // 两行：一条回 IP、一条回别名，行与行之间的线也在 / Two rows, one answering an IP and one an alias, so the line between rows is there too
  { name: '域名映射', path: '/config?section=mapping', open: async (page) => {
    for (const [domain, target] of [['nas.home.arpa', '192.168.1.10'], ['files.home.arpa', 'nas.home.arpa']]) {
      await page.getByLabel('要映射的域名').fill(domain!)
      await page.getByLabel('回答的 IP 或域名').fill(target!)
      await page.getByRole('button', { name: '添加', exact: true }).click()
    }
    await expect(page.locator('.rw__row')).toHaveCount(2)
  } },
  // 设置页在 860 以下先是分组目录，点进「规则默认值」才看到设置行 / Below 860 the settings page is a group list first; 规则默认值 opens the rows
  { name: '基础设置', path: '/config?section=settings', open: async (page) => {
    if ((page.viewportSize()?.width ?? 1440) <= 860) await page.getByRole('button', { name: /规则默认值/ }).click()
    await expect(page.getByText('拦截时怎么回应').first()).toBeVisible()
  } },
  { name: '历史版本', path: '/config', dialog: true, open: async (page) => {
    await page.getByRole('button', { name: '更多配置操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '历史版本', exact: true }).click()
    await expect(page.locator('.hist__row.is-current')).toHaveCount(1)
    await page.locator('.hist__row:not(.is-current) .hist__main').first().click()
    await expect(page.locator('.diffd')).toBeVisible()
    await expect(page.locator('.diffd__body').locator('.diffd__block, .hist__empty').first()).toBeVisible()
  } },
]

async function openView(page: Page, view: View): Promise<void> {
  await page.goto(view.path)
  await expect(page.locator('.cfg__skeleton')).toHaveCount(0)
  await expect(page.locator('.cfg__panel')).toBeVisible()
  await view.open(page, (page.viewportSize()?.width ?? 1440) <= 640)
  // 等出现动画走完（最长 500），再量 / Let the entrance animations finish (500 at most) before measuring
  await page.waitForTimeout(600)
}

// 扫的范围：配置页本身、整页编辑器，和打开着的对话框、菜单 / What gets scanned: the config page, the full-page editor, and any open dialog or menu
const SCOPE = '.cfg, .editor, dialog[open], .ui-menu--pop:popover-open'

test.describe('B 文字角色', () => {
  for (const view of views) {
    test(`${view.name}：字号只有令牌那几档（桌面 11、12、13、15、24，手机 12、13、14、16、22），字重只有 400、500、600，页标题 700，颜色都是令牌 @responsive`, async ({ page }) => {
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
        // 字阶就是 tokens.css 的 --t-0 到 --t-7：桌面 11/12/13/15/24，大数字 32/40，角标里的数字 10；手机整体放大一档 12/13/14/16/22，角标仍 10。
        // 手机上输入框的 16 就是字阶里的 --t-4，不用再单独放行。24 和 700 只给页标题：别处出现就是用错了角色。
        // 编辑器顶上的规则名输入框就是那一页的标题（editor__name），和 ui-ph__title 同一个角色
        // The scale is tokens.css's --t-0 to --t-7: desktop 11/12/13/15/24 with 32/40 for figures and 10 for the digit in a badge; phones one step
        // up at 12/13/14/16/22, the badge still 10. A phone field's 16 is the scale's own --t-4, so it needs no exception. 24 and 700 belong
        // to the page title alone: anywhere else they are the wrong role. The rule-name field atop the editor is that page's title (editor__name),
        // the same role as ui-ph__title
        const sizes = phone ? [10, 12, 13, 14, 16, 22] : [10, 11, 12, 13, 15, 24, 32, 40]
        const weights = [400, 500, 600]
        const found: string[] = []
        const seen = new Set<Element>()
        let scanned = 0
        for (const root of document.querySelectorAll(scope)) {
          for (const element of root.querySelectorAll<HTMLElement>('*')) {
            // JSON 编辑器里的字也守文字角色：13 号等宽、键名 500、颜色用令牌 / The JSON editor's text keeps the roles too
            // 只给读屏软件的字（visually-hidden）没有字号可言 / Screen-reader-only text (visually-hidden) has no size to check
            if (seen.has(element) || element.closest('svg, .visually-hidden')) continue
            seen.add(element)
            const text = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? '').join('').trim()
            // 可编辑区域（JSON 编辑器的正文）也是输入框：手机上同样 16 / An editable region (the JSON editor's text) is a field too: 16 on a phone as well
            const field = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || Boolean(element.closest('[contenteditable="true"]'))
            if (!text && !field) continue
            if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') continue
            const style = getComputedStyle(element)
            // 看不见的控件没有文字角色：开关里透明的 checkbox、1 像素的文件输入框只接事件，字号是继承来的
            // An invisible control has no text role: the switch's transparent checkbox and the 1px file input only take events, their size is inherited
            const box = element.getBoundingClientRect()
            if (field && (style.opacity === '0' || (box.width <= 1 && box.height <= 1))) continue
            scanned += 1
            const size = Math.round(parseFloat(style.fontSize) * 100) / 100
            const weight = Number(style.fontWeight)
            const title = element.matches('.ui-ph__title, .editor__name')
            const label = `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}「${(text || (element as HTMLInputElement).value || '').slice(0, 16)}」`
            if (!sizes.includes(size) || (size === (phone ? 22 : 24) && !title)) found.push(`字号 ${size}：${label}`)
            if (!weights.includes(weight) && !(weight === 700 && title)) found.push(`字重 ${weight}：${label}`)
            // 禁用的次要按钮用组件库的配方把 --l-ink-3 调进 --l-surface（components.css），调出来的颜色不是令牌本身，不在这里查
            // A disabled secondary button mixes --l-ink-3 into --l-surface by the kit's recipe (components.css); the mix is not a token itself, so it is not checked here
            const disabled = element.matches('button:disabled, button:disabled *')
            if (!field && !disabled && !colors.has(style.color)) found.push(`颜色 ${style.color}：${label}`)
          }
        }
        // 扫到的文字太少说明范围选错了，不能当作通过；最薄的一页是手机上只开着「规则默认值」两行的基础设置，十几个
        // Too little text scanned means the scope is wrong, which must not pass; the thinnest page, a phone's settings with only the two 规则默认值 rows open, has a dozen-odd
        if (scanned < 12) found.push(`只扫到 ${scanned} 个有字的元素`)
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
          // 手机上两处刻意用系统的选择列表，不是漏掉了组件库：规则页的筛选是一个按钮样式的 label（toolbar__filter），编辑器里「日志级别」「顺序」是整行一点就弹系统选单的行（crow--pick）
          // Two places on a phone deliberately use the system picker rather than a missed kit select: the rules tab's button-styled filter label (toolbar__filter)
          // and the editor's 日志级别 / 顺序 rows, which open the system sheet from the whole row (crow--pick)
          for (const select of document.querySelectorAll('select')) {
            if (inScope(select) && !select.closest('.ui-select, .toolbar__filter, .crow--pick')) found.push(`不是 .ui-select 的下拉框：${select.getAttribute('aria-label')}`)
          }
          for (const icon of document.querySelectorAll<SVGElement>('svg')) {
            if (!inScope(icon) || !icon.getClientRects().length || icon.closest('.ui-empty__icon, .cm-editor')) continue
            const { width: w, height: h } = icon.getBoundingClientRect()
            if (![14, 16].includes(Math.round(w)) || Math.round(w) !== Math.round(h)) found.push(`图标 ${Math.round(w)}×${Math.round(h)}：${icon.getAttribute('class')} 在 ${icon.parentElement?.className}`)
          }
          // 同一行：竖向范围重叠、共享同一个父容器的控件。整行就是按钮的那些（规则行、历史行、映射的域名格、手机编辑器的行）、
          // 文字样式的链接按钮和页签不算控件
          // One line: controls sharing a parent whose vertical spans overlap. Whole-row buttons (rule rows, history rows, a mapping's domain cell,
          // the phone editor's rows), text-styled link buttons and tabs are not controls
          const controls = [...document.querySelectorAll<HTMLElement>('button, .ui-input, .ui-seg, .ui-rows__handle')]
            .filter((element) => inScope(element) && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
            .filter((element) => !element.matches('.ui-tag, .ui-menu__item, .ui-seg__opt, .ui-pick__opt *, .ui-objlink, .ui-input button, .ui-input__affix, [role="tab"], .ui-tabs__tab, .settings-nav__item, .ui-link, .rrow__main, .rrow__grip, .hist__main, .gcard__name, .rw__d, .crow, .ecard__fold, .cfg__head-action, .editor__problem'))
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

test.describe('D 说明文字预算', () => {
  for (const view of views) {
    test(`${view.name}：注释角色的字加占位符里的中文不超过 120 字 @responsive`, async ({ page }) => {
      await openView(page, view)
      const { total, parts } = await page.evaluate((scope) => {
        const roots = [...document.querySelectorAll(scope)]
        const inScope = (element: Element) => roots.some((root) => root.contains(element))
        const parts: string[] = []
        // 注释角色：--t-1（桌面 11、手机 12）、400 的界面字（不是机器值、不是标签、不是出错信息、不是历史和比较里的数据行）
        // The note role: --t-1 (11 on desktop, 12 on a phone), 400, UI font (not machine values, tags, errors, or the data rows of history and diff)
        const noteSize = window.innerWidth <= 640 ? 12 : 11
        for (const element of document.querySelectorAll<HTMLElement>('p, small, span, li')) {
          if (!inScope(element) || !element.getClientRects().length || element.closest('.cm-editor, code, .ui-tag, .ui-field-error, .hist__list, .diffd__body, .rrow__num, .ui-menu__title')) continue
          const style = getComputedStyle(element)
          if (parseFloat(style.fontSize) !== noteSize || Number(style.fontWeight) !== 400 || /Plex Mono/i.test(style.fontFamily.split(',')[0] ?? '')) continue
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
      // 实际字数记在测试结果里 / The measured count goes into the test result
      test.info().annotations.push({ type: '字数', description: String(total) })
      expect(total, parts.join('\n')).toBeLessThanOrEqual(120)
    })
  }
})

test.describe('F 横线', () => {
  // 每个视图允许出现的横线，每一个都在 DOM 里核对过是刻意画的 1 像素 --l-hair 细线（下面那条断言把线的样子带在名字后面）；框（四边都有）不算线。
  // 规则列表：工具行、表头、快速添加行的底边，每条规则行的底边（rcard__tools、rlist__head、qadd、rrow）。
  // 域名映射：工具行、添加行、表头、每一行（rw__tools、rw__add、rw__head、rw__row）。上游组卡片：地址列表的上下沿（gcard__addrs）。
  // 抽屉和对话框：头尾（pdrawer__head、pdrawer__foot、pdialog__head、pdialog__foot），抽屉里字段之间（pfield），历史版本行之间（hist__row）。
  // 右栏编辑器：每个区块的上沿和底栏的上沿（ecard、editor__foot）。手机编辑器：行与行之间（crow）、「添加条件」的上沿（cform__padd）、内核 JSON 折叠标题的上沿（summary）。
  // 设置行之间（ui-setrow）、手机上设置分组目录的行之间（settings-nav__item）、手机页签的底线和落在它上面的指示块（ui-tabs、ui-tabs__ind）。
  // The rules each view may show, each checked in the DOM to be a deliberate 1px --l-hair line (the assertion below carries the line's shape after
  // its name); boxes (all four sides) are not rules. Rules list: the tools row, head, quick-add row and each rule row (rcard__tools, rlist__head, qadd,
  // rrow). Mappings: tools, add row, head and rows (rw__tools, rw__add, rw__head, rw__row). Group cards: the address list's edges (gcard__addrs).
  // Drawers and dialogs: head and foot (pdrawer__head, pdrawer__foot, pdialog__head, pdialog__foot), between a drawer's fields (pfield), between
  // history rows (hist__row). The inspector: each section's top and the footer's top (ecard, editor__foot). The phone editor: between rows (crow), above
  // 添加条件 (cform__padd), above the kernel JSON fold's summary (summary). Setting rows (ui-setrow), phone settings group rows (settings-nav__item),
  // the phone tab baseline with its indicator (ui-tabs, ui-tabs__ind).
  const allowed = [
    'rcard__tools', 'rlist__head', 'qadd', 'rrow', 'rw__tools', 'rw__add', 'rw__head', 'rw__row', 'gcard__addrs',
    'pdrawer__head', 'pdrawer__foot', 'pdialog__head', 'pdialog__foot', 'pfield', 'hist__row', 'ecard', 'editor__foot', 'crow', 'cform__padd', 'summary',
    'ui-setrow', 'settings-nav__item', 'ui-tabs', 'ui-tabs__ind',
  ]
  for (const view of views) {
    test(`${view.name}：可见的横线只有允许的那几种 @responsive`, async ({ page }) => {
      await openView(page, view)
      const lines = await page.evaluate((scope) => {
        const roots = [...document.querySelectorAll(scope)]
        const hair = getComputedStyle(document.documentElement).getPropertyValue('--l-hair').trim()
        const probe = document.createElement('span')
        probe.style.color = hair
        document.body.append(probe)
        const hairRgb = getComputedStyle(probe).color
        probe.remove()
        const found: string[] = []
        for (const root of roots) {
          for (const element of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
            if (!(element instanceof HTMLElement) || !element.getClientRects().length) continue
            const style = getComputedStyle(element)
            const drawn = (side: 'Top' | 'Bottom' | 'Left' | 'Right') => parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== 'none' && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(style[`border${side}Color`])
            const horizontal = drawn('Top') || drawn('Bottom')
            const box = drawn('Top') && drawn('Bottom') && drawn('Left') && drawn('Right')
            if (!horizontal || box || element.getBoundingClientRect().width < 40) continue
            // 名字后面带上这条线的样子，核对名单时就不用再去 DOM 里翻 / The line's shape follows the name, so checking the list needs no second look at the DOM
            const side = drawn('Top') ? 'Top' : 'Bottom'
            const shape = `${style[`border${side}Width`]} ${style[`border${side}Style`]} ${style[`border${side}Color`] === hairRgb ? '--l-hair' : style[`border${side}Color`]}`
            found.push(`${[...element.classList].join('.') || element.tagName.toLowerCase()} (${shape})`)
          }
        }
        return [...new Set(found)]
      }, SCOPE)
      // 这一视图里见到的每一条线都记在测试结果里，核对名单时从这里看 / Every line seen in this view goes into the test result, for checking the list against
      test.info().annotations.push({ type: '横线', description: lines.join('、') || '（没有）' })
      const unexpected = lines.filter((line) => !allowed.some((name) => line.split(' ')[0]!.split('.').includes(name)))
      expect(unexpected, `不在允许名单里的横线：${unexpected.join('、')}`).toEqual([])
    })
  }
})
