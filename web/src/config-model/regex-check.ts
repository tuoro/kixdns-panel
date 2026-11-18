import { shallowReactive } from 'vue'

// 编辑器里的正则照内核读：内核用 Rust 的 regex 库编译域名和 TXT 的正则，和浏览器的正则不是一套写法（标志可以写在中间、\pL、字符组的
// 集合运算、a++ 内核收；[a-\d] 浏览器收、内核不收）。所以页面不自己猜，请面板服务端用内核的那个库、同样的上限编译一遍
// （POST /api/v1/config/regex-check，见 crates/panel-server/src/regex_check.rs），记下回答。用到正则的地方照常同步地问
// （grammar.ts kernelRegexOk）：问过的直接给回答；没问过的排队，一会儿里要问的合成一次请求，回答来了用到它的地方跟着变（回答放在响应式的
// Map 里）。回答来之前、服务端连不上时没有回答，kernelRegexOk 只按本地查得出的那几种拦，不挡着编辑；保存时内核自己还会再查一遍
// The editor reads regexes as the kernel does: the kernel compiles name and TXT regexes with Rust's regex library, whose syntax is not
// the browser's (flags mid-pattern, \pL, class set operations and a++ the kernel takes; [a-\d] the browser takes and the kernel refuses).
// So the page does not guess: it asks the panel server to compile them with the kernel's library and limits (POST
// /api/v1/config/regex-check, see crates/panel-server/src/regex_check.rs) and keeps the answers. Places that use a regex ask
// synchronously as before (grammar.ts kernelRegexOk): an answer in hand is given at once; one not asked yet is queued, the asks of a
// moment go in one request, and whatever used it follows when the answer arrives (answers live in a reactive Map). Before an answer,
// or while the server cannot be reached, there is none, and kernelRegexOk stops only the few kinds the page can tell itself, without
// holding up editing; the kernel checks once more on save

/** 问一批正则：和请求一一对应，内核编得出为 null，编不出为原因 / Asks about a batch of regexes: one per pattern, null when the kernel
 * compiles it, otherwise the cause */
export type RegexChecker = (patterns: string[]) => Promise<(string | null)[]>

/** 一次请求最多带几个，和服务端的上限一样 / At most this many per request, as the server allows */
export const REGEX_CHECK_BATCH = 200
/** 一会儿里要问的攒一下：边打字边查时不是每个键一次请求 / Asks within this delay go together, so typing is not one request per key */
export const REGEX_CHECK_DELAY_MS = 250
/** 没问成的过这么久再问，连不上时不一直重试 / One that could not be asked is tried again after this long, not over and over while unreachable */
export const REGEX_RETRY_MS = 15_000
/** 最多记这么多个回答，多了丢最早的 / At most this many answers kept, the oldest dropped first */
const KEEP = 2000

const answers = shallowReactive(new Map<string, string | null>())
const queued = new Set<string>()
const inFlight = new Map<string, Promise<void>>()
const failedAt = new Map<string, number>()
let checker: RegexChecker | null = null
let timer: ReturnType<typeof setTimeout> | null = null

/** 页面启动时接上面板服务端；不接（测试、没有服务端）时只按本地查 / Hooked to the panel server when the page starts; without it (tests,
 * no server) only the local checks apply */
export function setRegexChecker(next: RegexChecker | null): void {
  checker = next
}

/**
 * 内核对这个正则的回答：null 编得出，字符串是编不出的原因；还不知道时为 undefined，同时排队去问
 * The kernel's answer for this regex: null when it compiles, a string giving why not; undefined while unknown, queuing the ask meanwhile
 */
export function kernelRegexVerdict(pattern: string): string | null | undefined {
  if (answers.has(pattern)) return answers.get(pattern)
  ask(pattern)
  return undefined
}

/** 现在就问完这些（排着队的一起问），等回答来；问不成也照样结束 / Asks about these now (with whatever is queued) and waits for the answers;
 * it finishes even when the ask fails */
export async function checkKernelRegexes(patterns: string[]): Promise<void> {
  for (const p of patterns) if (!answers.has(p)) { failedAt.delete(p); ask(p) }
  flush()
  await Promise.all(patterns.map((p) => inFlight.get(p)))
}

function ask(pattern: string): void {
  if (!checker || queued.has(pattern) || inFlight.has(pattern)) return
  const failed = failedAt.get(pattern)
  if (failed !== undefined && Date.now() - failed < REGEX_RETRY_MS) return
  queued.add(pattern)
  timer ??= setTimeout(flush, REGEX_CHECK_DELAY_MS)
}

function flush(): void {
  if (timer) clearTimeout(timer)
  timer = null
  const patterns = [...queued]
  queued.clear()
  const send = checker
  if (!send) return
  for (let i = 0; i < patterns.length; i += REGEX_CHECK_BATCH) {
    const batch = patterns.slice(i, i + REGEX_CHECK_BATCH)
    // 当场就发：等着回答的看得到它在路上 / Sent at once, so those waiting see it under way
    let asked: Promise<(string | null)[]>
    try { asked = send(batch) } catch (error) { asked = Promise.reject(error) }
    const done = asked.then(
      (errors) => {
        // 回答的条数对不上就当没问成 / An answer of the wrong length counts as no answer
        if (errors.length !== batch.length) throw new Error('regex check answered the wrong number of patterns')
        batch.forEach((p, n) => remember(p, errors[n] ?? null))
      },
    ).catch(() => {
      const now = Date.now()
      for (const p of batch) failedAt.set(p, now)
    }).finally(() => {
      for (const p of batch) inFlight.delete(p)
    })
    for (const p of batch) inFlight.set(p, done)
  }
}

function remember(pattern: string, error: string | null): void {
  failedAt.delete(pattern)
  answers.delete(pattern)
  answers.set(pattern, error)
  if (answers.size > KEEP) answers.delete(answers.keys().next().value!)
}
