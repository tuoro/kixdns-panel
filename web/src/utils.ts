export function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/**
 * 小到一位小数显示不出来、但确实发生过的占比，写成「低于 0.1%」。
 *
 * 1,204 次除以 1,284 万是 0.0094%，`formatPercent` 会写成 0.0%——那和「一次也没
 * 有」在屏幕上长得一模一样。发生过和没发生过是两件事，不能显示成同一个字符串。
 *
 * A share too small to show at one decimal but which did happen reads as
 * "below 0.1%". 1,204 out of 12.8M is 0.0094%, which formatPercent writes as
 * 0.0% — indistinguishable on screen from never having happened. Having
 * occurred and not having occurred must not render identically.
 */
export function formatSmallPercent(value: number): string {
  if (value > 0 && value * 100 < 0.05) return '低于 0.1%'
  return formatPercent(value)
}

/**
 * 上游成功率：成功次数除以真正得到结果的尝试数。
 * 并发竞争里被取消的尝试（aborted）既不是成功也不是失败，不计入分母；
 * 否则同一条规则下的几个上游会按"谁先应答"瓜分成功率。
 */
/**
 * 成功率只看超时和连接错误。SERVFAIL、REFUSED 也算拿到了响应（坏掉的域名所有上游都会这样回），
 * 在响应码分布里看；并发竞争中被取消的尝试既不算成功也不算失败。
 */
export function upstreamSuccessRate(item: { success: number; errors: number }): number {
  const judged = item.success + item.errors
  return judged > 0 ? item.success / judged : 0
}

export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp * 1000))
}

// 历史版本的时间：今天、昨天写字，今年只写月日，更早的写年月日；都不写秒。
// A version's time: 今天 and 昨天 in words, month and day within the year, the full date before that; never seconds.
export function formatVersionTime(timestamp: number, now: number = Date.now()): string {
  const date = new Date(timestamp * 1000)
  const today = new Date(now)
  const pad = (value: number) => String(value).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const day = 86_400_000
  if (date.getTime() >= startOfToday && date.getTime() < startOfToday + day) return `今天 ${time}`
  if (date.getTime() >= startOfToday - day && date.getTime() < startOfToday) return `昨天 ${time}`
  // 下次自动更新这类将来的时间 / Times ahead, such as the next automatic update
  if (date.getTime() >= startOfToday + day && date.getTime() < startOfToday + 2 * day) return `明天 ${time}`
  if (date.getFullYear() === today.getFullYear()) return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${time}`
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
}

// 多久以前：刚刚、N 分钟前、N 小时前、N 天前（Geo 文件下载时间用） / How long ago, for Geo file download times
export function formatAgo(timestamp: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor(now / 1000 - timestamp))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86_400)} 天前`
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))} 秒`
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  // 零的单位不写：「0 小时 21 分钟」读成「21 分钟」 / Zero units are left out: 0 小时 21 分钟 reads 21 分钟
  if (days > 0) return hours ? `${days} 天 ${hours} 小时` : `${days} 天`
  if (!hours) return `${minutes} 分钟`
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`
}

export function shortHash(value: string | null | undefined, length = 10): string {
  return value ? value.slice(0, length) : '未记录'
}

interface KixdnsVersionIdentity {
  source: 'action' | 'release' | 'fork' | null
  source_id: number | null
  run_id?: number | null
  release_tag?: string | null
}

/** fork 发布写日期版本，更早的 Release 写标签，旧的 Action 内核写「构建 #上游 Run」，和服务端的 label() 一致。 / A fork release reads as its date version, an earlier Release as its tag, an old Action kernel as 构建 # and the upstream run, as the server's label() does. */
export function formatKixdnsVersion(version: KixdnsVersionIdentity | null | undefined): string {
  if (!version) return '未记录'
  if (version.source === 'fork') return version.release_tag ?? '未记录'
  if (version.source === 'release') return version.release_tag ?? 'Release'
  if (version.source === 'action') {
    if (version.run_id) return `构建 #${version.run_id}`
    return version.source_id ? `构建产物 #${version.source_id}` : '构建'
  }
  return '未记录'
}

/** 操作者：面板自己做的（定时更新、自动退回）写「自动」，不写英文的 system / The actor: what the panel did on its own (schedules, automatic fallback) reads 自动, not the English system */
export function actorName(actor: string | null | undefined): string {
  return !actor || actor === 'system' ? '自动' : actor
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '没有成功，过一会儿再试'
}

// 快捷键（? n /）要不要让路：焦点在能打字的地方（输入框、多行框、下拉、可编辑区）时让；开关、单选框、文件框不打字，照样响应
// Whether keyboard shortcuts (? n /) step aside: they do while focus is somewhere text goes (a text field, textarea, select, editable region); switches,
// radios and file pickers take no text, so shortcuts still work there
const TYPING = 'textarea, select, [contenteditable="true"], input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="range"], [type="color"], [type="file"])'
export const isTyping = (target: EventTarget | null): boolean => target instanceof HTMLElement && Boolean(target.closest(TYPING))

// 句子最后几个字绑在一起不折行：中文折行时末行不会只剩一两个字 / Binds a sentence's last few characters so a Chinese wrap never leaves one or two alone on the last line
export function keepTail(text: string, size = 5): [string, string] {
  if (text.length <= size * 2) return [text, '']
  return [text.slice(0, -size), text.slice(-size)]
}

/**
 * 一句话里带连字符的词（列表名、主机名、修饰符）各自连成一块，不在连字符后面断开；别的地方照常折行。紧挨着的引号、句末标点跟着连住，不会单独
 * 落到行首。超过 24 个字符的（long）整块换到下一行，比一行还长才在里面断开，免得窄屏上撑出去。不往文字里加看不见的字符，复制出来和原文一样
 * Splits a sentence so each hyphenated word (a list name, a host, a modifier) is one glued run that never breaks after its hyphen, the rest wrapping as usual.
 * Quotes and closing punctuation next to it are glued along, so they never start a line alone. One over 24 characters (long) moves whole to the next line
 * and only breaks inside when longer than a line, lest it overflow a narrow screen. No invisible characters go into the text, so a copy reads as the original
 */
const HYPHEN_WORD = /「?([$\w.|@^/]*\w-[\w.|@^/-]*[\w^])[」。，：；）]*/g
// 提示条里另外连住「版本 #N」（带着后面的「已生效」「已应用」「待应用」「没有生效」）、「「名字」的」「再点一次「按钮」」和「KixDNS」与后面的一个字：版本号和
// 状态词不拆开，「的」不落到行首，按钮名不单独落到最后一行，KixDNS 不挂在行尾；默认名「「文件名 · 主机」」单独拿出来（name），交给 NameText 按「·」折行。
// 句尾常见的几个词也整块连住（「写进配置文件」「设置已生效」「修改已生效」「才生效」），末行不只剩一个字（中文不按字数切：「修改已生效」切在四个字会拆开「修改」）。
// 「，：；。」都和前一个字连住（「「名字」的」后面的也连上）：一长串字被迫硬切时，标点不落到行首。「还没有应用」「没有应用」也是句尾词，
// 「再点「按钮」」（有没有「一次」都算）整块连住
// Common sentence endings are glued whole too (写进配置文件, 设置已生效, 修改已生效, 才生效), so the last line never holds one character alone (Chinese is
// not cut by count: four characters from the end of 修改已生效 would split 修改). Every 「，：；。」 also stays with the character before it (after a
// 「「name」的」 too), so a forced break in a long run never puts punctuation at a line's start. 还没有应用 and 没有应用 are sentence
// endings too, and 「再点「button」」 (with or without 一次) stays whole
// Toasts also glue 「版本 #N」 (with a following 已生效, 已应用, 待应用 or 没有生效), 「「name」的」, 「再点一次「button」」 and 「KixDNS」 with the character after it:
// no version split from its state, no 的 starting a line, no button name alone on the last line, no KixDNS left at a line end; a default name
// 「「file · host」」 is taken out on its own (name) for NameText to wrap at 「·」
const TOAST_GLUE = /(「[^「」]+?\u00a0·\u00a0[^「」]+?」的?)|(版本[ \u00a0]#\d+(?:[ \u00a0](?:已生效|已应用|待应用|没有生效))?[。，：；]*)|(「[^「」]{1,24}」的[，：；。]?)|「?([$\w.|@^/]*\w-[\w.|@^/-]*[\w^])[」。，：；）]*|(再点(?:一次)?「[^「」]{1,12}」)|(KixDNS[ \u00a0][\u4e00-\u9fff])|((?:写进配置文件|(?:设置|修改)已(?:生效|应用)|才生效|一起(?:保存)?生效|还?没有应用|停了|这份(?:配置|文件)|读不懂[ \u00a0]KixDNS[ \u00a0]的回应|没有通过[ \u00a0]KixDNS[ \u00a0]的校验)[。，：；]*)|((?:退回的设置和待应用的修改|退回的设置|待应用的修改)[，：；。]*)|([\u4e00-\u9fff][，：；。])/g
export type GlueRun = { text: string; glue: boolean; long?: boolean; name?: { name: string; suffix: string }; breakAfter?: boolean; parts?: GlueRun[]; lead?: boolean }
// 保存条、提示条这类按词换行（keep-all）的短句里，「版本 #N」「之后改的 N 处」整块不拆：只在显示时放进不折行的一块，文字里不加看不见的
// 字符，复制出来和原文一样 / In short keep-all lines such as the save bar and notices, 「版本 #N」 and 「之后改的 N 处」 never split: they are
// only put in a run that does not wrap when shown, with no invisible characters in the text, so a copy reads as the original
const NUMBER_GLUE = /版本[ \u00a0]#\d+|之后改的[ \u00a0]\d+[ \u00a0]处/g
export const numberRuns = (text: string): GlueRun[] => glueRuns(text, NUMBER_GLUE, () => undefined)
function glueRuns(text: string, pattern: RegExp, word: (m: RegExpMatchArray) => string | undefined, name?: (m: RegExpMatchArray) => GlueRun['name']): GlueRun[] {
  const runs: GlueRun[] = []
  let at = 0
  for (const m of text.matchAll(pattern)) {
    if (m.index > at) runs.push({ text: text.slice(at, m.index), glue: false })
    const hyphenated = word(m)
    const named = name?.(m)
    runs.push({ text: m[0], glue: true, ...(hyphenated !== undefined && hyphenated.length > 24 ? { long: true } : {}), ...(named ? { name: named } : {}) })
    at = m.index + m[0].length
  }
  if (at < text.length) runs.push({ text: text.slice(at), glue: false })
  return runs
}
export const hyphenRuns = (text: string): GlueRun[] => glueRuns(text, HYPHEN_WORD, (m) => m[1])
// 提示的断行，在 Chromium 和 WebKit（Safari）上都要成立：
// - 断点只有空格和显式的断点（显示成生成的零宽空格，见 styles.css 的 .brk）。每个「，：；。」后面都放一个，不管它在连块里还是普通字里：
//   WebKit 按词换行时不在中文标点处断；Chromium 那里本来就能断，多放一个不多出断点；
// - 退回的叫法没有空格、整块连住，它所在的那一段（两处断点之间）名字前面那截、后面那截也各连成一块；
// - 中间没有断点的几个相邻连块合成一串（parts），显示时整串放进一个 glue-block（inline-block，最宽一行），串里块和块之间放断点：整串
//   先作为一个整体换行，比一行还宽时才在串里、只在块和块之间断开（一句开头的那一串留在行内，见 chained）。
// 不能只靠「放不下才硬切」：WebKit 在两个相邻的不折行块之间不硬切，提示会伸出屏幕。也不能只在名字后面加断点：它随时可用，宽一点的屏上
// 会抢在前面的标点之前，拆成「…已重启，退回的设置和待应用的修改 / 已生效」
// Toast line breaking has to hold in both Chromium and WebKit (Safari):
// - the only break points are spaces and explicit ones (shown as a generated zero-width space, see .brk in styles.css). One follows
//   every 「，：；。」, in a glued run or in plain text: WebKit's keep-all does not break at CJK punctuation, while Chromium already
//   does, so the extra one adds no break point there;
// - the rollback's names have no space and stay whole, and the parts of a name's stretch (between two break points) before and after
//   it are glued too;
// - adjacent glued runs with no break point between them form a chain (parts), shown as one glue-block (inline-block, at most a line
//   wide) with break points between its members: the chain moves as a whole, and only when wider than a line does it break inside,
//   between members only (a chain opening the text stays inline, see chained).
// Relying on a cut only when nothing fits fails in WebKit, which never cuts between two adjacent no-wrap runs, so the toast overflows. A
// break point after the name alone fails too: always available, on a wider screen it wins over the punctuation before it and splits
// 「…已重启，退回的设置和待应用的修改 / 已生效」
const ROLLBACK_NAME = /^(?:退回的设置和待应用的修改|退回的设置|待应用的修改)$/
const STRETCH_END = /[，：；。 ]/
const ENDS_AT_PUNCTUATION = /[，：；。]$/
// 手机最窄时一行放得下的字数，少报一点：连起来比这长的就不连，免得撑出去 / About as many characters as the narrowest phone line
// holds, erring low: a glued part longer than this is left as it is, lest it overflow
const PHONE_LINE = 12
// 文字里写着的零宽断点（「版本 #N 的内容\u200b存成了…」）显示成 .brk，不留在文字里，复制出来是原文
// A zero-width break written into the text (「版本 #N 的内容\u200b存成了…」) is shown as a .brk and left out of the text, so a copy reads
// as the original
export const toastRuns = (text: string): GlueRun[] => {
  const pieces = text.split('\u200b')
  return pieces.flatMap((piece, i) => {
    const runs = piece ? pieceRuns(piece, i === 0) : []
    if (i < pieces.length - 1 && runs.length) runs[runs.length - 1] = { ...runs[runs.length - 1]!, breakAfter: true }
    return runs
  })
}
// opens：这一段是不是整句的开头（只有句首的串留在行内） / opens: whether this piece opens the whole text (only a chain there stays inline)
function pieceRuns(text: string, opens: boolean): GlueRun[] {
  const runs = glueRuns(text, TOAST_GLUE, (m) => m[4], (m) => {
    if (!m[1]) return undefined
    const suffix = m[1].endsWith('的') ? '的' : ''
    return { name: m[1].slice(1, m[1].length - 1 - suffix.length), suffix }
  }).map((run) => (run.glue && run.text.endsWith('」的') ? { ...run, breakAfter: true } : run))
  for (let i = 0; i < runs.length; i += 1) {
    if (runs[i]!.glue && ROLLBACK_NAME.test(runs[i]!.text)) i = gluedBeside(runs, i)
  }
  // 标点后的断点：后面紧跟开引号时不放，「；「」这样相邻的标点才挤得紧（Chromium 隔着断点不挤；开引号前本来就能断）
  // The break point after punctuation is left out before an opening quote, so adjacent marks such as 「；「」 still close up
  // (Chromium does not close them up across a break point, and a break is allowed before an opening quote anyway)
  // 普通字也在每个标点后切开：WebKit 只认显式的断点，连块吃掉了标点前那个字（「KixDNS 后」）时，标点就落在普通字里
  // Plain text is split after every punctuation mark too: WebKit honours explicit break points only, and when a glued run takes the
  // character before a mark (「KixDNS 后」) the mark lands in plain text
  const out = chained(runs, opens).flatMap((run): GlueRun[] => (run.glue ? [run] : run.text.split(/(?<=[，：；。])/).map((text) => ({ text, glue: false }))))
  return out.map((run, k) => (!run.name && ENDS_AT_PUNCTUATION.test(run.text) && !/^[「『（《“]/.test(out[k + 1]?.text ?? '') ? { ...run, breakAfter: true } : run))
}
// 第一个断点以后（含）的位置，按 UTF-16 数，和 slice 一致 / Where the break points are, counted in UTF-16 as slice counts
const breaksIn = (text: string) => [...text.matchAll(new RegExp(STRETCH_END, 'g'))].map((m) => m.index)
// 把第 i 块（名字）前后到这一段断点为止的字各连成一块，原地改 runs，返回名字现在的位置。只切普通的字；别的连块（默认名、长的连字符词、
// 中间带空格的「KixDNS 没」这类）不拆，碰到就停。空格本身不连进去，它仍是断点 / Glue the text on each side of run i (a name) up to its
// stretch's break points, each into one run, in place; returns where the name now sits. Only plain text is split; other glued runs (a
// default name, a long hyphenated word, one with a space inside such as 「KixDNS 没」) are never split, and the gluing stops at them. A
// space itself is never glued in: it stays a break point
function gluedBeside(runs: GlueRun[], i: number): number {
  const stops = (run: GlueRun) => Boolean(run.name || run.long || run.breakAfter) || (run.glue && breaksIn(run.text).some((k) => k < run.text.length - 1))
  // 前面：往回到上一个断点（断点留在原处） / Before: back to the previous break point (which stays where it is)
  let from = i
  while (from > 0 && !stops(runs[from - 1]!)) {
    const prev = runs[from - 1]!
    const ends = breaksIn(prev.text)
    if (ends.length === 0) { from -= 1; continue }
    const last = ends[ends.length - 1]!
    if (last < prev.text.length - 1) {
      runs.splice(from - 1, 1, { text: prev.text.slice(0, last + 1), glue: false }, { text: prev.text.slice(last + 1), glue: false })
      i += 1
    }
    break
  }
  const head = runs.slice(from, i).map((run) => run.text).join('')
  if (head && head.length <= PHONE_LINE) {
    runs.splice(from, i - from, { text: head, glue: true })
    i = from + 1
  }
  // 后面：往前到下一个断点（标点连进去，空格不连）；名字自己带着标点时，后面本来就能断 / After: on to the next break point (taking a
  // punctuation mark along, not a space); a name carrying its own punctuation can already break after it
  if (STRETCH_END.test(runs[i]!.text.slice(-1))) return i
  let to = i + 1
  while (to < runs.length && !stops(runs[to]!)) {
    const next = runs[to]!
    const ends = breaksIn(next.text)
    if (ends.length === 0) { to += 1; continue }
    const cut = next.text[ends[0]!] === ' ' ? ends[0]! : ends[0]! + 1
    if (cut === 0) break
    if (cut < next.text.length) runs.splice(to, 1, { text: next.text.slice(0, cut), glue: false }, { text: next.text.slice(cut), glue: false })
    to += 1
    break
  }
  const tail = runs.slice(i + 1, to).map((run) => run.text).join('')
  if (tail && tail.length <= PHONE_LINE) runs.splice(i + 1, to - i - 1, { text: tail, glue: true })
  return i
}
// 中间没有断点的相邻连块合成一串；默认名、长的连字符词、「「名字」的」自己排，不进串 / Adjacent glued runs with no break point between
// them form a chain; a default name, a long hyphenated word and 「「name」的」 lay themselves out and stay out
function chained(runs: GlueRun[], opens: boolean): GlueRun[] {
  const out: GlueRun[] = []
  let chain: GlueRun[] = []
  // 一句开头的那一串前面没有别的字和它抢一行，留在行内（只在块之间放断点）：放进 glue-block 的话，它折成两行就占满整行，后面放得下的
  // 那一段也被挤到下一行 / A chain opening the text has nothing before it competing for its line, so it stays inline (with break
  // points between members only): in a glue-block, once it wraps it takes the whole width and pushes what would fit after it down
  const flush = () => {
    if (chain.length > 1) out.push({ text: chain.map((run) => run.text).join(''), glue: true, parts: chain, ...(opens && out.length === 0 ? { lead: true } : {}) })
    else out.push(...chain)
    chain = []
  }
  for (const run of runs) {
    const joins = run.glue && !run.name && !run.long && !run.breakAfter
    if (!joins) { flush(); out.push(run); continue }
    chain.push(run)
    if (STRETCH_END.test(run.text.slice(-1))) flush()
  }
  flush()
  return out
}
// 帮助段落按「整块」排：段尾几个字连在一起（同 keepTail），10 个字以内的「…」也连在一起，不把「公司内网」「转到规则组」拆到两行；
// 带连字符的写法（$third-party）整个连住，不在连字符后面断开；引号跨在段尾的切口上时，切口挪到引号前面。这是面板自己给名字、引号加的连接规则，不是分词
// A help paragraph is laid out in glued runs: its last few characters stay together (as keepTail does), and so does every 「…」 of up to 10 characters, so
// 「公司内网」 or 「转到规则组」 never splits across lines; a hyphenated token ($third-party) stays whole instead of breaking after the hyphen; a quote
// straddling the tail cut moves the cut to the quote's start. This is the panel's own glue rule for names and quotes, not segmentation
export function helpRuns(text: string, size = 5): Array<{ text: string; glue: boolean }> {
  const quotes = [...text.matchAll(/「[^「」]{1,10}」|[$\w.|@^/]*\w-[\w.|@^/-]*[\w^]/g)].map((m) => [m.index, m.index + m[0].length] as const)
  let cut = text.length > size * 2 ? text.length - size : text.length
  for (const [start, end] of quotes) if (start < cut && end > cut) cut = start
  const runs: Array<{ text: string; glue: boolean }> = []
  let at = 0
  for (const [start, end] of quotes) {
    if (end > cut) break
    if (start > at) runs.push({ text: text.slice(at, start), glue: false })
    runs.push({ text: text.slice(start, end), glue: true })
    at = end
  }
  if (cut > at) runs.push({ text: text.slice(at, cut), glue: false })
  if (cut < text.length) runs.push({ text: text.slice(cut), glue: true })
  return runs
}
