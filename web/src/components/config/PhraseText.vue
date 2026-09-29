<script lang="ts">
// 模块级：所有 PhraseText 共用的量宽工具 / Module scope: width helpers shared by every PhraseText

// 一段字有多宽：用画布按真正的字体量，不估（审计第三轮 D2：估的会差出几像素，放得下的一段被拆开）
// How wide a text is, measured on a canvas in the real font rather than estimated (audit round 3, D2: an estimate is off by a few pixels and splits a run that fits)
let measureContext: CanvasRenderingContext2D | null | undefined
function textWidth(text: string, shorthand: string): number {
  if (!text) return 0
  measureContext ??= document.createElement('canvas').getContext('2d')
  if (!measureContext) return 0
  measureContext.font = shorthand
  // 页面不做字距调整，画布也不做（审计第七轮 D1） / The page renders without kerning, so the canvas measures without it too (audit round 7, D1)
  measureContext.fontKerning = 'none'
  return measureContext.measureText(text).width
}

// 这句话所在的那一行有多宽：量最近的块级祖先，跟着它的宽度变。所有实例共用一个 ResizeObserver
// How wide the sentence's line is: the nearest block ancestor, tracked as it resizes. All instances share one ResizeObserver
const watchers = new WeakMap<Element, Set<() => void>>()
let observer: ResizeObserver | undefined
function watchWidth(element: Element, callback: () => void): () => void {
  observer ??= new ResizeObserver((entries) => { for (const entry of entries) watchers.get(entry.target)?.forEach((notify) => notify()) })
  let callbacks = watchers.get(element)
  if (!callbacks) {
    callbacks = new Set()
    watchers.set(element, callbacks)
    observer.observe(element)
  }
  callbacks.add(callback)
  return () => {
    callbacks.delete(callback)
    if (callbacks.size) return
    watchers.delete(element)
    observer?.unobserve(element)
  }
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { phraseSegments, type Phrase, type PhraseSegment } from '../../config-editor/phrase'

// 一句「正文 + 机器值」（config-editor/phrase.ts）怎么排：
// · 机器值等宽，而且整块换行：地址连同后面的「(DoH)」是一个块，放不下就整个挪到下一行；网址只在「/」后面断，
//   绝不在连字符处拆开。正文里带连字符的词（category-ads-all）也整块换行。值前面紧挨着的英文类别词
//   （Pipeline、GeoSite）放进同一块，一起换行（审计第二轮 D9）。
// · 句子按「 · 」分成几段。一段放得下一整行就整段换行，换行先落在两段之间；放不下一整行的长段
//   （手机上带网址的一段）照常在空格处断。中文词不拆开：「转发至」不会断成「转发 / 至」（审计第二轮 D2）。
// · 「·」跟着前一段走，留在行尾，不出现在一行之首（GB/T 15834—2011 5.1.7 间隔号；审计第二轮 S4）。
//   浏览器会在整块的前后断行，不换行空格粘不住它，所以前一段以块结尾时「·」写在那一块里面。
// · 一段或一块比一整行还宽时，才在它里面断（手机上很长的网址）。
// mono=false 时值只是整块换行、不换字体（入口的名字一句话一种字体）。trail 在最后再挂一个「·」，给后面接着写的字用。
// How a sentence of body text and machine values (config-editor/phrase.ts) is set:
// · Machine values are mono and wrap as whole units: an address with its "(DoH)" moves to the next line together; a
//   URL breaks only after a "/", never at a hyphen. Hyphenated words in the body (category-ads-all) wrap whole too. A
//   Latin kind word right before a value (Pipeline, GeoSite) joins the value's unit and wraps with it (audit round 2, D9).
// · The sentence splits at " · " into runs. A run that fits on a line wraps whole, so a wrap falls between runs first;
//   a run longer than a whole line (one holding a URL, on a phone) breaks at its spaces as usual. Chinese words never
//   split: 转发至 never becomes 转发 / 至 (audit round 2, D2).
// · The "·" travels with the run before it, ending a line rather than starting one (GB/T 15834-2011 5.1.7, the
//   interpunct never begins a line; audit round 2, S4). Browsers break before and after an atomic unit and a no-break
//   space cannot hold it, so when the run ends in a unit the "·" is written inside that unit.
// · Only a run or unit wider than a whole line breaks inside (a long URL on a phone).
// With mono=false values only wrap whole and keep the UI font (an entry name is one sentence, one font). trail hangs one
// more "·" at the end, for text that follows the sentence.
const props = withDefaults(defineProps<{ phrase: Phrase | readonly PhraseSegment[]; mono?: boolean; trail?: boolean }>(), { mono: true, trail: false })

interface TextItem { kind: 'text'; text: string; dot?: 'sep' | 'trail' }
// 一个值（或带连字符的词）连同它前面的类别词、后面的括号尾巴和行尾的「·」。网址分成几截：整条放得下一行就是一块，
// 放不下才在截与截之间断 / A value (or hyphenated word) with its kind word before, bracket tail after and line-end 「·」. A URL
// comes in chunks: one unit when the whole URL fits a line, breaking between chunks only when it does not
// lead：值前面跟它一起换行的词，从外到里（「然后跳转至」「Pipeline」）/ lead: the words before the value that wrap with it, outermost first (然后跳转至, Pipeline)
interface UnitItem { kind: 'unit'; lead: string[]; chunks: string[]; code: boolean; tail: string; dot?: 'sep' | 'trail' }
type Item = TextItem | UnitItem

const HYPHENATED = /[A-Za-z0-9][A-Za-z0-9_.!]*(?:-[A-Za-z0-9_.!]+)+/g
const SEPARATOR = ' · '

// 从正文末尾取下紧挨着值的词，交给下一块：英文类别词（「跳转至 Pipeline 」里的 Pipeline），再加上它前面紧挨着的中文动词
// （「然后跳转至」，五个字以内）；没有类别词时是四个字以内的中文动词（转发至、属于、或）。放得下一行时这些词和值一起换行，
// 不会断成「转发至」/「223.5.5.5:53」（审计第三轮 D2、第四轮 D3）；放不下时从外往里把词留在上一行的末尾（见 apart）
// Take the words right before a value off the end of the text, for the next unit: a Latin kind word (Pipeline in 「跳转至 Pipeline 」)
// plus the Chinese verb right before it (然后跳转至, up to five characters); without a kind word, a Chinese verb of up to four characters
// (转发至, 属于, 或). When they fit a line the words wrap with the value, never 「转发至」 / 「223.5.5.5:53」 (audit round 3 D2, round 4 D3);
// when they do not, words stay at the end of the line above, outermost first (see apart)
function takeLead(run: Item[]): string[] {
  const last = run[run.length - 1]
  if (last?.kind !== 'text') return []
  const take = (pattern: RegExp): string | undefined => {
    const match = pattern.exec(last.text)
    if (!match) return undefined
    last.text = last.text.slice(0, last.text.length - match[2]!.length - 1)
    return match[2]
  }
  const kind = take(/(^|[^A-Za-z0-9_.-])([A-Za-z]+) $/)
  const verb = take(kind ? /(^|[^\p{Script=Han}])(\p{Script=Han}{1,5}) $/u : /(^|[^\p{Script=Han}])(\p{Script=Han}{1,4}) $/u)
  if (!last.text) run.pop()
  return [verb, kind].filter((word): word is string => Boolean(word))
}
// 词连起来写：词和词、词和值之间是不换行的空格 / Words joined with no-break spaces, between each other and before the value
function leadText(words: string[]): string {
  return words.map((word) => `${word}\u00a0`).join('')
}

function pushText(run: Item[], text: string): void {
  let cursor = 0
  for (const match of text.matchAll(HYPHENATED)) {
    const start = match.index ?? 0
    if (start > cursor) run.push({ kind: 'text', text: text.slice(cursor, start) })
    run.push({ kind: 'unit', lead: takeLead(run), chunks: [match[0]], code: false, tail: '' })
    cursor = start + match[0].length
  }
  if (cursor < text.length) run.push({ kind: 'text', text: text.slice(cursor) })
}

// 按「 · 」切成几段，每段是一串文字和块 / Split at " · " into runs, each a list of text and units
const runs = computed<Item[][]>(() => {
  const segments = Array.isArray(props.phrase) ? [...props.phrase] as PhraseSegment[] : phraseSegments(props.phrase as Phrase)
  const result: Item[][] = [[]]
  const current = (): Item[] => result[result.length - 1]!
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!
    if (!segment.code) {
      segment.text.split(SEPARATOR).forEach((part, partIndex) => {
        if (partIndex > 0) result.push([])
        if (part) pushText(current(), part)
      })
      continue
    }
    // 网址和路径在「/」后面可以断，但「://」后面不断：https://dns.google/ · dns-query；CIDR 这类短值不拆
    // URLs and paths may break after a "/", never right after 「://」: https://dns.google/ · dns-query; short values such as a CIDR stay whole
    const chunks = /:\/\/|^\//.test(segment.text) ? segment.text.split(/(?<=(?<!:\/)\/)(?!\/)/).filter(Boolean) : [segment.text]
    // 紧跟着的「 (DoH)」贴在最后一块上，不会单独掉到下一行 / A following " (DoH)" sticks to the last chunk and never drops to a line of its own
    let tail = ''
    const next = segments[index + 1]
    const bracket = next && !next.code ? /^ \([^()]*\)/.exec(next.text) : null
    if (next && bracket) {
      tail = bracket[0]
      segments[index + 1] = { text: next.text.slice(tail.length), code: false }
    }
    current().push({ kind: 'unit', lead: takeLead(current()), chunks, code: props.mono, tail })
  }
  const kept = result.filter((run, index) => run.length > 0 || index === 0)
  // 「·」写在每段最后一样东西上：是块就写进块里 / The 「·」 goes on each run's last item, inside it when that is a unit
  kept.forEach((run, index) => {
    const dot = index < kept.length - 1 ? 'sep' : props.trail ? 'trail' : undefined
    const last = run[run.length - 1]
    if (dot && last) last.dot = dot
  })
  return kept
})

const root = ref<HTMLElement | null>(null)
// 这一行有多宽（像素），和正文、等宽两种字体的写法；量之前按无限宽算 / The line's width in pixels and the body and mono font shorthands; infinite until measured
const lineWidth = ref(Number.POSITIVE_INFINITY)
const fonts = ref({ body: '', mono: '' })
// 挂在最后的「·」由外面决定显不显示（工作台在窄列表里藏起它和「2 处引用」）：藏着的不算宽度
// Whether the trailing 「·」 shows is up to the parent (the workbench hides it with 「2 处引用」 in a narrow list); a hidden one takes no width
const trailShown = ref(true)
let stopWatching: (() => void) | undefined

function lineBox(element: HTMLElement): HTMLElement | null {
  let box = element.parentElement
  while (box) {
    const display = getComputedStyle(box).display
    if (!display.startsWith('inline') && display !== 'contents') return box
    box = box.parentElement
  }
  return null
}
function measure(box: HTMLElement): void {
  const style = getComputedStyle(box)
  // 用带小数的宽度：整数的 clientWidth 会把 307.4 当成 307，放得下的一块被判成放不下（审计第四轮 D3）
  // The fractional width: the integer clientWidth reads 307.4 as 307 and a unit that fits is judged not to (audit round 4, D3)
  const width = box.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
  lineWidth.value = width > 0 ? width : Number.POSITIVE_INFINITY
  if (!root.value) return
  const own = getComputedStyle(root.value)
  const base = `${own.fontStyle} ${own.fontWeight} ${own.fontSize}`
  const mono = own.getPropertyValue('--f-mono').trim()
  fonts.value = { body: `${base} ${own.fontFamily}`, mono: props.mono && mono ? `${base} ${mono}` : `${base} ${own.fontFamily}` }
  const trail = root.value.querySelector('.phrase__trail')
  trailShown.value = !trail || getComputedStyle(trail).display !== 'none'
}
onMounted(() => {
  const box = root.value && lineBox(root.value)
  if (!box) return
  measure(box)
  stopWatching = watchWidth(box, () => measure(box))
  // 字体加载完字宽会变，再量一次 / Glyph widths change once the fonts load, so measure again
  void document.fonts?.ready.then(() => { if (root.value) measure(box) })
})
onBeforeUnmount(() => stopWatching?.())

function dotWidth(item: Item): number {
  return item.dot === 'sep' || (item.dot === 'trail' && trailShown.value) ? textWidth('\u00a0·', fonts.value.body) : 0
}
function itemWidth(item: Item): number {
  if (item.kind === 'text') return textWidth(item.text, fonts.value.body) + dotWidth(item)
  return textWidth(leadText(item.lead), fonts.value.body) + valueWidth(item)
}
// 值本身（连同尾巴和「·」）有多宽，不算前面的词 / The value itself, with its tail and 「·」, without the word before it
function valueWidth(item: UnitItem): number {
  const { body, mono } = fonts.value
  return textWidth(item.tail, body) + textWidth(item.chunks.join(''), item.code ? mono : body) + dotWidth(item)
}
// 放得下一整行（画布和排版量出来的宽度只差零点几，留 0.5） / Fits a line (canvas and layout differ by a fraction of a pixel, so 0.5 spare)
function fits(width: number): boolean {
  return width + 0.5 <= lineWidth.value
}
// 整段换行的段：纯文字的段，或者放得下一整行的段 / Runs that wrap whole: plain text, or runs that fit a line
function solid(run: Item[]): boolean {
  return run.every((item) => item.kind === 'text') || !fonts.value.body || fits(run.reduce((sum, item) => sum + itemWidth(item), 0))
}
// 前面几个词里有几个要留在上一行（从外往里数）：词和值一起放不下一行就先让出最外面的动词，还放不下再让出类别词；值要拆成几截时，
// 按第一截算，免得那一块比一行还宽、从主机名中间断开（审计第三轮 A3、第四轮 C1、D3）
// How many of the words before the value stay on the line above, counted from the outside: when words and value do not fit a line the
// outer verb goes first, then the kind word; when the value splits into chunks, the first chunk counts, so that unit is never wider than a
// line and never breaks inside a host name (audit round 3 A3, round 4 C1 and D3)
function apart(item: UnitItem): number {
  if (!item.lead.length || !fonts.value.body) return 0
  const whole = parts(item).length === 1
  const rest = whole ? valueWidth(item) : textWidth(item.chunks[0] ?? '', item.code ? fonts.value.mono : fonts.value.body)
  for (let count = 0; count < item.lead.length; count += 1) {
    if (fits(textWidth(leadText(item.lead.slice(count)), fonts.value.body) + rest)) return count
  }
  return item.lead.length
}
// 一个值画成几块：值自己放得下一行就一块，否则按截 / How many units a value takes: one when the value itself fits a line, else one per chunk
function parts(item: UnitItem): string[] {
  const whole = !fonts.value.body || fits(valueWidth(item))
  return item.chunks.length > 1 && !whole ? item.chunks : [item.chunks.join('')]
}
</script>

<template>
  <span ref="root" class="phrase" :class="{ 'phrase--plain': !mono }"><template v-for="(run, runIndex) in runs" :key="runIndex"><template v-if="runIndex > 0">{{ ' ' }}</template><span class="phrase__run" :class="{ 'phrase__run--solid': solid(run) }"><template v-for="(item, index) in run" :key="index"><template v-if="item.kind === 'text'">{{ item.text }}<span v-if="item.dot" class="phrase__dot" :class="{ 'phrase__trail': item.dot === 'trail' }">&nbsp;·</span></template><template v-for="(chunk, part) in parts(item)" v-else :key="part"><template v-if="part === 0 && apart(item)">{{ leadText(item.lead.slice(0, apart(item))).trimEnd() }}{{ ' ' }}</template><wbr v-if="part > 0"><span class="phrase__unit"><template v-if="part === 0">{{ leadText(item.lead.slice(apart(item))) }}</template><code v-if="item.code">{{ chunk }}</code><template v-else>{{ chunk }}</template><template v-if="part === parts(item).length - 1">{{ item.tail }}<span v-if="item.dot" class="phrase__dot" :class="{ 'phrase__trail': item.dot === 'trail' }">&nbsp;·</span></template></span></template></template></span></template></span>
</template>

<style scoped>
/* 中文词不拆开，只在空格和标点处断；实在放不下才在任意处断 / Chinese words stay whole and break only at spaces and punctuation; anywhere only when nothing else fits */
.phrase { word-break: keep-all; overflow-wrap: anywhere; }
.phrase code { font-family: var(--f-mono); }
/* 等宽字和正文字的基线位置不一样，按各自的行高对齐会把一行撑高 1：代码只占字那么高，行高由正文定，每行都是 1lh（审计第五轮 B1）
   Mono and text faces sit their baselines differently, so each keeping its own line height grows a line by 1: code takes only its
   glyph height and the text sets the line, so every line is 1lh (audit round 5, B1) */
.phrase code { line-height: 1; }
.phrase--plain code { font-family: inherit; }
/* 块是原子：放不下整块换行；比一行还宽才在里面断。纯文字的段和放得下一整行的段也整段换行；更长的段照常在空格处断。
   「·」在前一段的末尾，只会留在行尾，不会出现在一行之首。
   Units are atomic: they wrap whole and break inside only when wider than a line. Plain-text runs and runs that fit on a
   line wrap whole too; longer runs break at their spaces. The 「·」 ends the run before it, so it can end a line but never
   start one. */
.phrase__run--solid, .phrase__unit { display: inline-block; max-width: 100%; overflow-wrap: anywhere; }
</style>
