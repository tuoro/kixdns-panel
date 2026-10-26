import { describe, expect, it } from 'vitest'
import { errorMessage, formatAgo, formatDuration, formatKixdnsVersion, formatPercent, formatSmallPercent, formatVersionTime, helpRuns, hyphenRuns, noticeRuns, shortHash, toastRuns, upstreamSuccessRate } from './utils'

describe('界面格式化工具', () => {
  it('生成稳定且紧凑的运行指标', () => {
    expect(formatPercent(0.81234)).toBe('81.2%')
    expect(formatDuration(0)).toBe('0 秒')
    expect(formatDuration(59)).toBe('59 秒')
    expect(formatDuration(60)).toBe('1 分钟')
    expect(formatDuration(1260)).toBe('21 分钟')
    expect(formatDuration(3600)).toBe('1 小时')
    expect(formatDuration(3660)).toBe('1 小时 1 分钟')
    expect(formatDuration(86400)).toBe('1 天')
    expect(formatDuration(90061)).toBe('1 天 1 小时')
    expect(shortHash('0123456789abcdef', 8)).toBe('01234567')
    expect(shortHash(null)).toBe('未记录')
  })

  it('不会把未知异常直接渲染为对象字符串', () => {
    expect(errorMessage(new Error('明确错误'))).toBe('明确错误')
    expect(errorMessage({ secret: 'value' })).toBe('没有成功，过一会儿再试')
  })

  it('使用上游身份展示 KixDNS 版本', () => {
    expect(formatKixdnsVersion({ source: 'fork', source_id: 3, run_id: null, release_tag: '2026.10.13.2' })).toBe('2026.10.13.2')
    expect(formatKixdnsVersion({ source: 'release', source_id: 1, run_id: null, release_tag: 'v0.1.1' })).toBe('v0.1.1')
    expect(formatKixdnsVersion({ source: 'action', source_id: 2, run_id: 30235703570, release_tag: null })).toBe('构建 #30235703570')
    expect(formatKixdnsVersion({ source: 'action', source_id: 8695590365, run_id: null, release_tag: null })).toBe('构建产物 #8695590365')
    expect(formatKixdnsVersion(null)).toBe('未记录')
  })
})

describe('上游成功率', () => {
  it('只把超时和连接错误算作失败', () => {
    expect(upstreamSuccessRate({ success: 95, errors: 5 })).toBeCloseTo(0.95)
    // 上游如实回了 SERVFAIL / REFUSED：那是域名或上游策略的问题，归在响应码分布里，不拖成功率
    const answeredWithServfail = { attempts: 70, success: 20, errors: 0, rejected: 30, aborted: 20 }
    expect(upstreamSuccessRate(answeredWithServfail)).toBe(1)
  })

  it('并发竞争中被取消的尝试不计入分母', () => {
    const lostMostRaces = { attempts: 20, success: 4, errors: 1, rejected: 0, aborted: 15 }
    expect(upstreamSuccessRate(lostMostRaces)).toBeCloseTo(0.8)
  })

  it('没有可判断的响应时为 0', () => {
    expect(upstreamSuccessRate({ success: 0, errors: 0 })).toBe(0)
  })
})

describe('极小占比', () => {
  it('发生过但四舍五入到 0.0% 时写成「低于 0.1%」', () => {
    // 1,204 次 / 1,284.7 万次 = 0.0094%，直接格式化会写成 0.0%。
    expect(formatSmallPercent(1_204 / 12_847_392)).toBe('低于 0.1%')
  })

  it('真正为零时仍然写 0.0%，不和「极小」混为一谈', () => {
    expect(formatSmallPercent(0)).toBe('0.0%')
  })

  it('刚好到得了一位小数就照常显示', () => {
    expect(formatSmallPercent(0.001)).toBe('0.1%')
    expect(formatSmallPercent(0.0005)).toBe('0.1%')
  })

  it('负值不当作极小值处理', () => {
    expect(formatSmallPercent(-0.0001)).toBe('-0.0%')
  })
})

describe('formatVersionTime', () => {
  // 以本地时间 2026-09-26 12:00 为「现在」 / "Now" is 2026-09-26 12:00 local time
  const now = new Date(2026, 8, 26, 12, 0).getTime()
  const at = (...parts: [number, number, number, number, number]) => new Date(...parts).getTime() / 1000

  it('今天和昨天写字，不写秒', () => {
    expect(formatVersionTime(at(2026, 8, 26, 0, 5), now)).toBe('今天 00:05')
    expect(formatVersionTime(at(2026, 8, 25, 18, 46), now)).toBe('昨天 18:46')
    expect(formatVersionTime(at(2026, 8, 25, 0, 0), now)).toBe('昨天 00:00')
  })

  it('明天的时间写明天，后天起写日期', () => {
    expect(formatVersionTime(at(2026, 8, 27, 8, 21), now)).toBe('明天 08:21')
    expect(formatVersionTime(at(2026, 8, 28, 8, 21), now)).toBe('09/28 08:21')
  })

  it('今年更早的只写月日和时间，往年写年月日', () => {
    expect(formatVersionTime(at(2026, 8, 24, 18, 46), now)).toBe('09/24 18:46')
    expect(formatVersionTime(at(2025, 11, 31, 23, 59), now)).toBe('2025/12/31')
  })
})

describe('formatAgo', () => {
  const now = 1_790_000_000_000
  it('按分钟、小时、天往上走，不写秒', () => {
    expect(formatAgo(now / 1000 - 20, now)).toBe('刚刚')
    expect(formatAgo(now / 1000 - 5 * 60, now)).toBe('5 分钟前')
    expect(formatAgo(now / 1000 - 3 * 3600, now)).toBe('3 小时前')
    expect(formatAgo(now / 1000 - 3 * 86_400 - 60, now)).toBe('3 天前')
  })
})

describe('hyphenRuns', () => {
  it('提示条标题在「，：；。、」后面能断，「版本 #N」整块，原文不变 / notice titles break after 「，：；。、」 with 「版本 #N」 whole and the text unchanged', () => {
    const text = '改过的设置要重启 KixDNS\u00a0才生效：UDP\u00a0监听地址、TCP\u00a0监听地址。'
    const runs = noticeRuns(text)
    expect(runs.map((r) => r.text).join('')).toBe(text)
    expect(runs.filter((r) => r.breakAfter).map((r) => r.text.slice(-1))).toEqual(['：', '、'])
    expect(noticeRuns('不知道版本 #19 应用了没有。').filter((r) => r.glue).map((r) => r.text)).toEqual(['版本 #19'])
  })
  it('带连字符的词各自连住，原文不变 / hyphenated words are glued runs and the text is unchanged', () => {
    const text = '要重新下载，点「fail-hosts.txt」那一行；连不上 anti-ad.net，写 @@||own-block.example^'
    const runs = hyphenRuns(text)
    expect(runs.map((r) => r.text).join('')).toBe(text)
    // 紧挨着的引号、句末标点跟着连住 / Quotes and closing punctuation next to it go along
    expect(runs.filter((r) => r.glue).map((r) => r.text)).toEqual(['「fail-hosts.txt」', 'anti-ad.net，', '@@||own-block.example^'])
    // 太长的整块换行，不撑出去 / Too long a word moves whole, without overflowing
    expect(hyphenRuns('连不上 very-long-subdomain-name.example.org。').find((r) => r.glue)).toEqual({ text: 'very-long-subdomain-name.example.org。', glue: true, long: true })
  })

  it('提示条另外连住版本号、「名字」的和「再点一次「按钮」」 / toasts also glue the version number, 「name」的 and 「再点一次「button」」', () => {
    // 「一个字＋标点」那一类单独测，这里只比前面几类 / The 「character + punctuation」 runs are tested on their own; here only the
    // other kinds are compared
    const glued = (text: string) => toastRuns(text).flatMap((r) => r.parts ?? [r]).filter((r) => r.glue && !/^[\u4e00-\u9fff][，：；。]$/.test(r.text)).map((r) => r.text)
    expect(glued('新下载的拦截列表：已存成待应用版本\u00a0#20，KixDNS 就绪后自动应用')).toEqual(['版本\u00a0#20，', 'KixDNS 就'])
    expect(glued('「bad.txt」的链接只能用 https://，删掉这个列表再保存')).toEqual(['「bad.txt」的'])
    expect(glued('「bad.txt」的，删掉这个列表再保存')).toEqual(['「bad.txt」的，'])
    // 按钮名不单独落到最后一行 / The button name never sits alone on the last line
    expect(glued('新的一份存不上：这份配置在别处改过了；先重新读取，再点一次「全部更新」')).toEqual(['这份配置', '再点一次「全部更新」'])
    // 「这份配置」「新配置」「停了」连成一个词：服务端原话、面板自己的说法在窄屏上不切在词中间 / 这份配置, 新配置 and 停了 stay whole, so the server's
    // words and the panel's own never cut mid-word on a narrow screen
    expect(glued('KixDNS 没有接受这份配置：upstream "fast" did not answer the health check')).toEqual(['KixDNS 没', '这份配置：'])
    expect(glued('KixDNS 在确认新配置前停了')).toEqual(['KixDNS 在', '新配置', '停了'])
    expect(glued('KixDNS 没有及时确认新配置。回到配置页可以重试应用')).toEqual(['KixDNS 没', '新配置。'])
    // 英文原话里的「词 + 数字」不拆开，两组之间的空格照样能断 / A word and its number in English wording stay together, and the space
    // between two such pairs still breaks
    expect(glued('读不懂 KixDNS 的回应：expected value at line 1 column 1')).toEqual(['读不懂 KixDNS 的回应：', 'line 1', 'column 1'])
    // 连字符词照旧整个连住，不被「词 + 数字」抢走；很长的数字不连 / A hyphenated word still stays whole rather than being taken by word +
    // number; a very long number is not glued
    expect(glued('timeout 5-second step')).toEqual(['5-second'])
    expect(glued('serial 12345678901234')).toEqual([])
    // 带冒号、小数点的数连在一起（「12:30」不拆开），紧跟的英文标点也连进去；连住的那一块整块换行 / A number with a colon or a decimal point
    // stays together (12:30 is not split), with English punctuation right after it glued in; the glued block wraps as one
    expect(glued('since 12:30 today')).toEqual(['since 12:30'])
    expect(glued('at line 3, column 14.')).toEqual(['line 3,', 'column 14.'])
    expect(glued('bind 0.0.0.0:53 failed')).toEqual(['bind 0.0.0.0:53'])
    expect(glued('刚才那次保存已经存上了：版本 #19 已生效；之后改的 1 处留在配置页，还没保存')).toEqual(['版本 #19 已生效；', '之后改的 1 处'])
    // 短的英文括号整个连住（括号不单独留在行尾或落到行首） / A short English parenthetical stays whole (no bracket left at a line end or
    // starting a line)
    expect(glued('bind failed (os error 98)')).toEqual(['(os error 98)'])
    expect(glued('拉取失败（HTTP 404）')).toEqual(['（HTTP 404）'])
    expect(toastRuns('at line 1 column 1').filter((r) => r.glue).map((r) => r.long)).toEqual([true, true])
    expect(glued('配置还没有应用，KixDNS\u00a0启动后会读这份文件')).toEqual(['还没有应用，', 'KixDNS\u00a0启', '这份文件'])
    // 版本号带着后面的状态词，KixDNS 带着后面一个字 / The version number keeps its state word, and KixDNS the character after it
    expect(glued('新下载的拦截列表已经存上了：版本 #20 已生效')).toEqual(['版本 #20 已生效'])
    expect(glued('版本 #20 已应用，改过的设置要重启 KixDNS 才生效')).toEqual(['版本 #20 已应用，', 'KixDNS 才'])
    // 「）」不连进去：行尾的它能压成半宽，一行放得下的不被挤成两行 / 「）」 stays out: at a line end it can shrink to half width, so what fits one line is not
    // pushed to two
    expect(glued('已换上新下载的拦截列表（版本 #20）')).toEqual(['版本 #20'])
    expect(glued('新下载的拦截列表：存成了版本 #20，没有生效。KixDNS 没有接受这份配置')).toEqual(['版本 #20，', 'KixDNS 没', '这份配置'])
    expect(glued('它留在配置页的草稿里。KixDNS\u00a0的原话：pipeline "main"')).toEqual(['KixDNS\u00a0的'])
    // 句尾常见的词整块连住，末行不只剩一个字 / Common endings stay whole, so the last line never holds one character alone
    expect(glued('KixDNS 启动失败，可以到配置页把版本\u00a0#19\u00a0写进配置文件')).toEqual(['KixDNS 启', '版本\u00a0#19', '写进配置文件'])
    expect(glued('待应用的修改还没有应用，可以再点「现在应用」')).toEqual(['待应用的修改', '还没有应用，', '再点「现在应用」'])
    // 退回的叫法没有空格：名字整块连住，名字前面那截、后面那截（到这一段的标点为止）也各连成一块；中间没有断点的相邻连块合成一串，
    // 整串先作为一个整体换行，比一行还宽时才在串里、块和块之间断开。以标点结尾的连块后面放断点（WebKit 不在中文标点处断）
    // The rollback's names have no space: a name stays whole, and the parts of its stretch before and after it (up to the stretch's
    // punctuation) are glued too; adjacent glued runs with no break point between them form a chain, which moves as a whole and
    // breaks inside, between members, only when wider than a line. A glued run ending in punctuation gets a break point after it
    // (WebKit does not break at CJK punctuation)
    // 「{a|b}」是一串（显示成一个 glue-block，块之间可断）；「[a]」是单独一块；「/」是后面放的断点 / 「{a|b}」 is a chain (one
    // glue-block, breakable between members); 「[a]」 a single run; 「/」 a break point placed after it
    const units = (text: string) => toastRuns(text).map((r) => `${r.parts ? `{${r.parts.map((part) => part.text).join('|')}}` : r.glue ? `[${r.text}]` : r.text}${r.breakAfter ? '/' : ''}`).join('')
    expect(units('KixDNS 服务已重启，退回的设置和待应用的修改已生效')).toBe('[KixDNS 服]务已重[启，]/{退回的设置和待应用的修改|已生效}')
    expect(units('不知道待应用的修改应用了没有：连不上面板。连上后会自己核对')).toBe('{不知道|待应用的修改|应用了没有：}/连不上面[板。]/连上后会自己核对')
    expect(units('退回的设置和待应用的修改还没有应用：KixDNS 没有回应，就绪后自动应用')).toBe('{退回的设置和待应用的修改|还没有应用：}/[KixDNS 没]有回[应，]/就绪后自动应用')
    expect(units('待应用的修改存成了版本\u00a0#22，KixDNS\u00a0就绪后自动应用')).toBe('{待应用的修改|存成了版本\u00a0#22，}/[KixDNS\u00a0就]绪后自动应用')
    expect(units('已退回原来的设置，KixDNS 服务已重启；待应用的修改也已应用，有些设置要再重启一次才生效')).toBe('已退回原来的设[置，]/[KixDNS 服]务已重[启；]/{待应用的修改|也已应用，}/有些设置要再重启一次[才生效]')
    // 一句开头的那一串留在行内（lead），句中的串放进 glue-block / A chain opening the text stays inline (lead), one mid-sentence goes
    // into a glue-block
    expect(toastRuns('退回的设置和待应用的修改还没有应用：KixDNS 没有回应，就绪后自动应用')[0]!.lead).toBe(true)
    expect(toastRuns('KixDNS 服务已重启，退回的设置和待应用的修改已生效').find((r) => r.parts)?.lead).toBeUndefined()
    // 连块吃掉了标点前那个字（「KixDNS 后」）时，普通字里的标点后面也有断点 / When a glued run takes the character before a mark
    // (「KixDNS 后」), the mark in plain text gets its break point too
    expect(units('重试没有送到面板，连上\u00a0KixDNS\u00a0后，可以再点「重试应用」')).toBe('重试没有送到面[板，]/连上\u00a0[KixDNS\u00a0后]，/可以[再点「重试应用」]')
    // 标点后的断点在开引号前不放，「；「」才挤得紧 / No break point after punctuation before an opening quote, so 「；「」 closes up
    expect(units('新的一份已下载；「anti-ad.txt」还没有放进草稿')).toBe('新的一份已下[载；][「anti-ad.txt」]还没有放进草稿')
    // 名字自己带着标点：后面本来就能断，不再往后连 / A name carrying its punctuation can already break after it, so nothing after is glued
    expect(units('退回的设置，其他照旧')).toBe('[退回的设置，]/其他照旧')
    // 中间带空格的连块不拆；名字后面的空格不连进去，仍是断点 / A glued run with a space inside is never split; a space after a name is
    // not glued in and stays a break point
    expect(units('待应用的修改KixDNS 没有回应')).toBe('{待应用的修改|KixDNS 没}有回应')
    expect(units('待应用的修改 KixDNS 就绪')).toBe('[待应用的修改] [KixDNS 就]绪')
    // 不含退回叫法的句子只多了标点后的断点；「「名字」的」后面照旧留断点 / A sentence without a rollback name only gains the break points
    // after punctuation; 「「name」的」 keeps its break point
    expect(units('不知道版本 #19 应用了没有：连不上面板。连上后会自己核对')).toBe('不知道[版本 #19] 应用了没[有：]/连不上面[板。]/连上后会自己核对')
    expect(units('「bad.txt」的链接只能用 https://')).toBe('[「bad.txt」的]/链接只能用 https://')
    // 句尾的「一起保存生效」整块连住，末行不只剩「效」 / 一起保存生效 at the end stays whole, so the last line never holds 效 alone
    expect(units('待应用的修改还没有应用；它的内容会和你的修改一起保存生效')).toBe('{待应用的修改|还没有应用；}/它的内容会和你的修改[一起保存生效]')
    // 「，：；。」和前一个字连住：硬切时标点不落到行首 / 「，：；。」 stay with the character before: a forced break never starts a line
    // with punctuation
    const pairs = toastRuns('不知道版本 #19 应用了没有：连不上面板。连上后会自己核对').filter((r) => r.glue).map((r) => r.text)
    expect(pairs).toEqual(['版本 #19', '有：', '板。'])
    expect(toastRuns('一句话').map((r) => r.text).join('')).toBe('一句话')
    // 默认名单独拿出来，按「·」折行 / A default name is taken out to wrap at 「·」
    expect(toastRuns('「hosts.txt\u00a0·\u00a0lists.example.org」没下载成功').find((r) => r.name)?.name).toEqual({ name: 'hosts.txt\u00a0·\u00a0lists.example.org', suffix: '' })
  })
})

describe('helpRuns', () => {
  const glued = (text: string) => helpRuns(text).filter((r) => r.glue).map((r) => r.text)
  it('段尾五个字连在一起，整段拼回来不多不少 / the last five characters are glued and the runs add back up to the text', () => {
    const text = '把一个域名直接回成某个 IP，不再去问上游。'
    expect(helpRuns(text).map((r) => r.text).join('')).toBe(text)
    expect(glued(text)).toEqual(['去问上游。'])
  })
  it('10 个字以内的「…」整个连住，长引号不连 / a 「…」 of up to 10 characters is glued whole; a longer one is not', () => {
    expect(glued('比如公司内网的设备，可以用「公司内网」这一组单独转发出去。')).toEqual(['「公司内网」', '单独转发出去。'.slice(-5)])
    expect(glued('写成「这是一段超过十个字的很长很长的引号」的样子以后再说明')).toEqual(['以后再说明'])
  })
  it('引号跨在段尾切口上时，切口挪到引号前面 / a quote straddling the tail cut moves the cut to its start', () => {
    const runs = helpRuns('某条规则的结果选「转到规则组」')
    expect(runs.at(-1)).toEqual({ text: '「转到规则组」', glue: true })
    expect(runs.map((r) => r.text).join('')).toBe('某条规则的结果选「转到规则组」')
  })
  it('短句不拆 / a short line stays one run', () => {
    expect(helpRuns('先试一个例子')).toEqual([{ text: '先试一个例子', glue: false }])
  })
})
