import { shallowReactive } from 'vue'

// 编辑器里的正则照内核读：内核用 Rust 的 regex 库编译域名和 TXT 的正则，和浏览器的正则不是一套写法（标志可以写在中间、\pL、字符组的
// 集合运算、a++ 内核收；[a-\d] 浏览器收、内核不收），编译出来都限 1 MB；内核在解析之前先看长度，域名的超过 16384 字节、TXT 的超过 1000
// 字节都不收。
// 所以页面不自己猜，请面板服务端用内核的那个库、同样的上限编译一遍（POST /api/v1/config/regex-check，见
// crates/panel-server/src/regex_check.rs），每个正则带上它用在哪儿（kind），按 (kind, 正则) 记下回答。用到正则的地方照常同步地问
// （grammar.ts kernelRegexOk）：问过的直接给回答；没问过的排队，一会儿里要问的合成一次请求，回答来了用到它的地方跟着变（回答放在响应式的
// Map 里）。回答来之前、服务端连不上时没有回答，只按本地查得出的那几种拦，不挡着编辑；保存时内核自己还会再查一遍。
// 超过长度上限的不问：内核只看长度就不收，页面照内核的原话自己回答，不必送过去
// The editor reads regexes as the kernel does: the kernel compiles name and TXT regexes with Rust's regex library, whose syntax is not
// the browser's (flags mid-pattern, \pL, class set operations and a++ the kernel takes; [a-\d] the browser takes and the kernel refuses),
// and either may compile to 1 MB; before parsing, the kernel refuses a name regex over 16384 bytes long and a TXT one over 1000.
// So the page does not guess: it asks the panel server to compile them with the kernel's library and limits (POST
// /api/v1/config/regex-check, see crates/panel-server/src/regex_check.rs), each regex with where it is used (kind), and keeps the
// answers by (kind, regex). Places that use a regex ask synchronously as before (grammar.ts kernelRegexOk): an answer in hand is given
// at once; one not asked yet is queued, the asks of a moment go in one request, and whatever used it follows when the answer arrives
// (answers live in a reactive Map). Before an answer, or while the server cannot be reached, there is none, and only the few kinds the
// page can tell itself are stopped, without holding up editing; the kernel checks once more on save.
// One over its length limit is not asked: the kernel refuses it on its length alone, so the page answers it in the kernel's own words
// without sending it

/** 正则用在哪儿：域名的、TXT 内容的；长度上限不一样（16384、1000 字节），不收的原话也不一样 / Where a regex is used: names or TXT
 * content; the length limits differ (16384 and 1000 bytes), and so do the kernel's words for a refusal */
export type RegexKind = 'domain' | 'txt'
/** 内核为什么不收：写法不对、编译出来太大、比长度上限长 / Why the kernel refuses it: written wrong, too big once compiled, longer than
 * the length limit */
export type RegexCause = 'syntax' | 'too-big' | 'too-long'
/** 内核对一个正则的回答 / The kernel's answer for one regex */
export type RegexAnswer =
  | { verdict: 'compiles' }
  | { verdict: 'refused'; cause: RegexCause; error: string }
export interface RegexItem { kind: RegexKind; pattern: string }
/** 问一批正则：和请求一一对应 / Asks about a batch of regexes: one answer per item */
export type RegexChecker = (items: RegexItem[]) => Promise<RegexAnswer[]>

/** 一次请求最多带几个，和服务端的上限一样 / At most this many per request, as the server allows */
export const REGEX_CHECK_BATCH = 200
/** 内核的一条域名正则最长这么多字节，在解析之前查（kixdns matcher/mod.rs MAX_REGEX_LEN，regex_check.rs MAX_REGEX_BYTES） / The most
 * bytes a name regex of the kernel's may be, checked before parsing (kixdns matcher/mod.rs MAX_REGEX_LEN, regex_check.rs MAX_REGEX_BYTES) */
export const REGEX_MAX_BYTES = 16 * 1024
/** 内核的 TXT 正则最长这么多字节，先于别的检查 / The most bytes a TXT regex of the kernel's may be, checked before anything else */
export const TXT_REGEX_BYTES = 1000
/** 一次请求的正则合起来（写成 JSON 以后）最多这么多字节：服务端的请求体上限是它再加 64 KiB 的外壳 / The most bytes the regexes of one
 * request take written as JSON: the server's body limit is this plus 64 KiB for the rest */
export const REGEX_CHECK_BODY_BYTES = REGEX_CHECK_BATCH * REGEX_MAX_BYTES
/** 一会儿里要问的攒一下：边打字边查时不是每个键一次请求 / Asks within this delay go together, so typing is not one request per key */
export const REGEX_CHECK_DELAY_MS = 250
/** 没问成的过这么久再问，连不上时不一直重试 / One that could not be asked is tried again after this long, not over and over while unreachable */
export const REGEX_RETRY_MS = 15_000
/** 最多记这么多个回答，多了丢最早的 / At most this many answers kept, the oldest dropped first */
const KEEP = 2000
const VERDICTS = new Set(['compiles', 'refused'])

const utf8 = new TextEncoder()
const keyOf = (kind: RegexKind, pattern: string): string => `${kind}:${pattern}`
const answers = shallowReactive(new Map<string, RegexAnswer>())
// 排着队和在路上的：响应式的，问不成时用到它的地方也跟着变 / Queued and under way: reactive, so whatever uses it follows when an ask fails too
const asking = shallowReactive(new Set<string>())
const queued = new Map<string, RegexItem>()
const inFlight = new Map<string, Promise<void>>()
const failedAt = new Map<string, number>()
let checker: RegexChecker | null = null
let timer: ReturnType<typeof setTimeout> | null = null

/** 页面启动时接上面板服务端；不接（测试、没有服务端）时只按本地查 / Hooked to the panel server when the page starts; without it (tests,
 * no server) only the local checks apply */
export function setRegexChecker(next: RegexChecker | null): void {
  checker = next
}

/** 比长度上限长时内核的回答，照内核的原话；不长时为 null / The kernel's answer for one over its length limit, in the kernel's words; null
 * when it is not */
function tooLong(kind: RegexKind, pattern: string): RegexAnswer | null {
  const max = kind === 'txt' ? TXT_REGEX_BYTES : REGEX_MAX_BYTES
  if (pattern.length <= max) return null
  const bytes = utf8.encode(pattern).length
  return bytes > max ? { verdict: 'refused', cause: 'too-long', error: `regex pattern too long: ${bytes} bytes (max ${max})` } : null
}

/**
 * 内核对这个正则的回答；还不知道时为 undefined，同时排队去问。比长度上限长的不问，照内核的原话直接回答
 * The kernel's answer for this regex; undefined while unknown, queuing the ask meanwhile. One over its length limit is not asked but
 * answered at once in the kernel's words
 */
export function kernelRegexVerdict(kind: RegexKind, pattern: string): RegexAnswer | undefined {
  const key = keyOf(kind, pattern)
  const known = answers.get(key)
  if (known) return known
  const long = tooLong(kind, pattern)
  if (long) return long
  ask(key, { kind, pattern })
  return undefined
}

/**
 * 正在问服务端、回答还没来：用到它的地方可以先留着上一次的结论（标成在查），不必先去掉、过一会儿再出来。问不成（连不上）时不算
 * Being asked and not answered yet: whatever uses it may keep its last conclusion meanwhile (marked as checking), rather than drop it and
 * show it again a moment later. Not when the ask failed (unreachable)
 */
export function kernelRegexChecking(kind: RegexKind, pattern: string): boolean {
  // 先问（要排队的这时排上），再看在不在问：同一个计算里先读后写会让它自己重算 / Ask first (queuing it if need be), then look: reading and
  // then writing in one computation would make it recompute itself
  return kernelRegexVerdict(kind, pattern) === undefined && asking.has(keyOf(kind, pattern))
}

/** 现在就问完这些（排着队的一起问），等回答来；问不成也照样结束 / Asks about these now (with whatever is queued) and waits for the answers;
 * it finishes even when the ask fails */
export async function checkKernelRegexes(items: RegexItem[]): Promise<void> {
  for (const item of items) {
    const key = keyOf(item.kind, item.pattern)
    if (!answers.has(key) && !tooLong(item.kind, item.pattern)) { failedAt.delete(key); ask(key, item) }
  }
  flush()
  await Promise.all(items.map((item) => inFlight.get(keyOf(item.kind, item.pattern))))
}

function ask(key: string, item: RegexItem): void {
  if (!checker || queued.has(key) || inFlight.has(key)) return
  const failed = failedAt.get(key)
  if (failed !== undefined && Date.now() - failed < REGEX_RETRY_MS) return
  queued.set(key, item)
  asking.add(key)
  timer ??= setTimeout(flush, REGEX_CHECK_DELAY_MS)
}

function flush(): void {
  if (timer) clearTimeout(timer)
  timer = null
  const items = [...queued]
  queued.clear()
  const send = checker
  if (!send) {
    for (const [key] of items) asking.delete(key)
    return
  }
  // 一批最多 200 个、写成 JSON 最多 REGEX_CHECK_BODY_BYTES：服务端的请求体上限装得下 / At most 200 per batch and at most
  // REGEX_CHECK_BODY_BYTES as JSON, which the server's body limit holds
  let batch: [string, RegexItem][] = []
  let bytes = 0
  for (const entry of items) {
    const size = utf8.encode(JSON.stringify(entry[1])).length + 1
    if (batch.length && (batch.length === REGEX_CHECK_BATCH || bytes + size > REGEX_CHECK_BODY_BYTES)) {
      sendBatch(send, batch)
      batch = []
      bytes = 0
    }
    batch.push(entry)
    bytes += size
  }
  if (batch.length) sendBatch(send, batch)
}

function sendBatch(send: RegexChecker, batch: [string, RegexItem][]): void {
  // 当场就发：等着回答的看得到它在路上 / Sent at once, so those waiting see it under way
  let asked: Promise<RegexAnswer[]>
  try { asked = send(batch.map(([, item]) => item)) } catch (error) { asked = Promise.reject(error) }
  const done = asked.then(
    (found) => {
      // 回答的条数、写法对不上就当没问成 / An answer of the wrong length or shape counts as no answer
      if (!Array.isArray(found) || found.length !== batch.length || !found.every((a) => VERDICTS.has((a as { verdict?: string } | null)?.verdict ?? ''))) {
        throw new Error('regex check answered the wrong number of patterns')
      }
      batch.forEach(([key], n) => remember(key, found[n]!))
    },
  ).catch(() => {
    const now = Date.now()
    for (const [key] of batch) failedAt.set(key, now)
  }).finally(() => {
    for (const [key] of batch) { inFlight.delete(key); asking.delete(key) }
  })
  for (const [key] of batch) inFlight.set(key, done)
}

function remember(key: string, answer: RegexAnswer): void {
  failedAt.delete(key)
  answers.delete(key)
  answers.set(key, answer)
  if (answers.size > KEEP) answers.delete(answers.keys().next().value!)
}
