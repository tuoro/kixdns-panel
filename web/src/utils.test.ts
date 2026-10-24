import { describe, expect, it } from 'vitest'
import { errorMessage, formatAgo, formatDuration, formatKixdnsVersion, formatPercent, formatSmallPercent, formatVersionTime, helpRuns, hyphenRuns, shortHash, toastRuns, upstreamSuccessRate } from './utils'

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
    const glued = (text: string) => toastRuns(text).filter((r) => r.glue).map((r) => r.text)
    expect(glued('新下载的拦截列表：已存成待应用版本\u00a0#20，KixDNS 就绪后自动应用')).toEqual(['版本\u00a0#20，', 'KixDNS 就'])
    expect(glued('「bad.txt」的链接只能用 https://，删掉这个列表再保存')).toEqual(['「bad.txt」的'])
    // 按钮名不单独落到最后一行 / The button name never sits alone on the last line
    expect(glued('新的一份存不上：这份配置在别处改过了；先重新读取，再点一次「全部更新」')).toEqual(['再点一次「全部更新」'])
    // 版本号带着后面的状态词，KixDNS 带着后面一个字 / The version number keeps its state word, and KixDNS the character after it
    expect(glued('新下载的拦截列表已经存上了：版本 #20 已生效')).toEqual(['版本 #20 已生效'])
    expect(glued('版本 #20 已应用，改过的设置要重启 KixDNS 才生效')).toEqual(['版本 #20 已应用，', 'KixDNS 才'])
    // 「）」不连进去：行尾的它能压成半宽，一行放得下的不被挤成两行 / 「）」 stays out: at a line end it can shrink to half width, so what fits one line is not
    // pushed to two
    expect(glued('已换上新下载的拦截列表（版本 #20）')).toEqual(['版本 #20'])
    expect(glued('新下载的拦截列表：存成了版本 #20，没有生效。KixDNS 没有接受这份配置')).toEqual(['版本 #20，', 'KixDNS 没'])
    expect(glued('它留在配置页的草稿里。KixDNS\u00a0的原话：pipeline "main"')).toEqual(['KixDNS\u00a0的'])
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
