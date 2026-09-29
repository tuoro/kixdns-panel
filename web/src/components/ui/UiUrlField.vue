<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

// 放网址、上游这类长机器值的框：等宽，放不下就换行、框跟着长高，不把后半截藏起来（规范 3.11）。
// 浏览器不会在「/」后面换行，只会在连字符处把 dns-query 拆开。这里在每个「/」和「,」后面放一个零宽空格（可以断），
// 在每个「-」后面放一个零宽连接符（不能断），换行就只落在路径和地址的边界上；实在一整段都放不下才从中间断。
// 这两种字符只在框里：传出去的值、复制和剪切出去的文字里都没有。放在 .ui-input.ui-input--area 里用，右端可以再放一个 .ui-input__affix。
// A field for long machine values such as URLs and upstreams: mono, wrapping when it does not fit and growing with
// its content, never hiding the tail (spec 3.11). Browsers never break after "/" and happily split dns-query at its
// hyphen. A zero-width space after each "/" and "," (a break) and a word joiner after each "-" (no break) put line
// breaks on path and address boundaries only; a segment breaks inside only when it cannot fit a whole line. Both
// characters live only in the field: the emitted value and copied or cut text never contain them. Use it inside
// .ui-input.ui-input--area, optionally with a .ui-input__affix at the end.
const model = defineModel<string>({ default: '' })
withDefaults(defineProps<{ label: string; placeholder?: string; invalid?: boolean; disabled?: boolean; describedby?: string }>(), {
  placeholder: undefined,
  invalid: false,
  disabled: false,
  describedby: undefined,
})
const emit = defineEmits<{ blur: [] }>()

const BREAK = '\u200b'
const JOIN = '\u2060'
const INVISIBLE = /[\u200b\u2060]/g
const field = ref<HTMLTextAreaElement | null>(null)
let observer: ResizeObserver | undefined

function plain(text: string): string {
  return text.replace(INVISIBLE, '')
}

let measureContext: CanvasRenderingContext2D | null | undefined
function textWidth(text: string, shorthand: string): number {
  measureContext ??= document.createElement('canvas').getContext('2d')
  if (!measureContext) return 0
  measureContext.font = shorthand
  // 页面不做字距调整，画布也不做，量出来的宽度才和画出来的一样 / The page renders without kerning, so the canvas measures without it too
  measureContext.fontKerning = 'none'
  return measureContext.measureText(text).width
}

// 「://」后面不断：协议和主机名留在同一行。几个上游一行放不下时一行一个：只在「,」后面断，
// 放得下一行的地址里面不断，放不下一行的地址才在「/」后面断（审计第二轮 D13）
// No break right after 「://」: the scheme stays with its host. When several upstreams do not fit on one line they
// go one per line: breaks fall after 「,」 only, an address that fits a line stays whole, and only an address wider
// than a line breaks after its 「/」 (audit round 2, D13)
function breakable(text: string, room = Number.POSITIVE_INFINITY, shorthand = ''): string {
  // 协议连同主机名一行都放不下时，才在「://」后面断：主机名本身不从中间断开（审计第二轮 B6）
  // Only when the scheme with its host is wider than a line does it break after 「://」, so a host is never cut (audit round 2, B6)
  // 浏览器自己会在「//」后面断开；主机名放得下一行时在那里放一个零宽连接符，协议不会单独留在上一行的行尾（审计第四轮前自查：「dns-query, https://」/「dns.alidns.com/」）
  // Browsers break after 「//」 on their own; when the host fits a line a word joiner goes there, so the scheme never ends the line above alone
  // (self-check before audit round 4: 「dns-query, https://」 / 「dns.alidns.com/」)
  const keepScheme = (part: string): string => part.replace('://', `://${JOIN}`)
  const slashes = (part: string): string => {
    const broken = part.replace(/((?<!:\/)\/(?!\/))/g, `$1${BREAK}`)
    const host = /^\s*[a-z][a-z0-9+.-]*:\/\/[^/,]*\/?/i.exec(part)
    return host && textWidth(host[0].trim(), shorthand) > room ? broken.replace('://', `://${BREAK}`) : keepScheme(broken)
  }
  const perLine = text.includes(',') && textWidth(text, shorthand) > room
  const parts = text.split(/(?<=,)/).map((part) => (perLine && textWidth(part.trim(), shorthand) <= room ? keepScheme(part) : slashes(part)))
  return parts.join(BREAK).replace(/-/g, `-${JOIN}`)
}

// 按整行长高：一行是 1lh（21.7 像素），scrollHeight 取整成 22，框就比旁边的下拉框高出零点几、底边差 1 像素（审计第四轮 V5）
// Grows in whole lines: one line is 1lh (21.7px) and scrollHeight rounds it to 22, which left the box a fraction taller than the select beside it (audit round 4, V5)
function grow(): void {
  const element = field.value
  if (!element) return
  element.style.height = 'auto'
  const line = parseFloat(getComputedStyle(element).lineHeight)
  element.style.height = line > 0 ? `calc(${Math.max(1, Math.round(element.scrollHeight / line))} * 1lh)` : `${element.scrollHeight}px`
}

// 刚写出去的值。父组件传回来要等下一次渲染，这之前 model.value 还是旧的，所以这里自己记一份
// The value just emitted. The parent passes it back only on its next render and model.value is stale until then, so keep our own copy
let current = model.value ?? ''

// 把值写回框里；caret 是光标前有几个真实字符，写回之后光标还在原来那两个字符中间。
// 没给 caret、而框正聚焦时（父组件改了值，比如去掉了空白），光标也留在原来的字符之间
// Writes the value back into the field; caret counts the real characters before the cursor, which stays between the
// same two characters. With no caret while the field has focus (the parent changed the value, say it dropped
// whitespace), the cursor also stays between its characters
function render(caret?: number, value: string = current): void {
  const element = field.value
  if (!element) return
  const style = getComputedStyle(element)
  const room = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
  // 字体用几个分开的属性拼：font-kerning: none 时 font 简写读出来是空的，画布会退回 10px 的默认字体，每一段都像放得下（审计第七轮 D1、B1）
  // The font is built from its longhands: with font-kerning: none the font shorthand reads empty and the canvas falls back to its 10px
  // default, so every part seems to fit (audit round 7, D1, B1)
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  const display = breakable(value, room > 0 ? room : Number.POSITIVE_INFINITY, font)
  if (element.value !== display) {
    const keep = caret ?? (document.activeElement === element ? plain(element.value.slice(0, element.selectionStart)).length : undefined)
    element.value = display
    if (keep !== undefined) {
      let seen = 0
      let at = 0
      while (at < display.length && seen < keep) {
        if (display[at] !== BREAK && display[at] !== JOIN) seen += 1
        at += 1
      }
      element.setSelectionRange(at, at)
    }
  }
  grow()
}

function write(value: string, caret: number): void {
  current = value
  model.value = value
  render(caret, value)
}

function commit(element: HTMLTextAreaElement): void {
  const caret = plain(element.value.slice(0, element.selectionStart)).length
  // 这是一个值，不是一段文字：粘进来的换行一律去掉 / One value, not a paragraph: pasted line breaks are dropped
  write(plain(element.value).replace(/\r?\n/g, ''), caret)
}

function onInput(event: Event): void {
  const input = event as InputEvent
  if (input.isComposing) return
  const element = event.target as HTMLTextAreaElement
  // 退格只删掉了一个看不见的字符：替人把旁边那个看得见的也删掉，一次退格就是一个字
  // A delete that removed only an invisible character: remove the visible neighbour too, so one keypress deletes one character
  if (input.inputType?.startsWith('delete') && plain(element.value) === current) {
    const caret = plain(element.value.slice(0, element.selectionStart)).length
    if (input.inputType === 'deleteContentBackward' && caret > 0) {
      write(current.slice(0, caret - 1) + current.slice(caret), caret - 1)
      return
    }
    if (input.inputType === 'deleteContentForward' && caret < current.length) {
      write(current.slice(0, caret) + current.slice(caret + 1), caret)
      return
    }
  }
  commit(element)
}

// 拖出去的文字也不带看不见的字符 / Text dragged out carries no invisible characters either
function onDragStart(event: DragEvent): void {
  const element = field.value
  if (!element || !event.dataTransfer) return
  event.dataTransfer.setData('text/plain', plain(element.value.slice(element.selectionStart, element.selectionEnd)))
}

function onCopy(event: ClipboardEvent, cut: boolean): void {
  const element = field.value
  if (!element || !event.clipboardData || element.selectionStart === element.selectionEnd) return
  event.clipboardData.setData('text/plain', plain(element.value.slice(element.selectionStart, element.selectionEnd)))
  event.preventDefault()
  if (!cut || element.readOnly || element.disabled) return
  element.setRangeText('', element.selectionStart, element.selectionEnd, 'end')
  commit(element)
}

watch(model, (value) => {
  current = value ?? ''
  render(undefined, current)
})
onMounted(() => {
  render()
  // 框变宽变窄时重新决定在哪里断、重新量高度；字体加载完也重来一次 / When the field's width changes, re-decide where it breaks and re-measure its height; again once the fonts load
  observer = new ResizeObserver(() => render())
  if (field.value) observer.observe(field.value)
  void nextTick(grow)
  void document.fonts?.ready.then(() => render())
})
onBeforeUnmount(() => observer?.disconnect())
defineExpose({ focus: () => field.value?.focus() })
</script>

<template>
  <textarea ref="field" rows="1" spellcheck="false" autocapitalize="off" autocomplete="off" :aria-label="label" :placeholder="placeholder" :disabled="disabled" :aria-invalid="invalid || undefined" :aria-describedby="describedby" @input="onInput" @compositionend="onInput" @copy="onCopy($event, false)" @cut="onCopy($event, true)" @dragstart="onDragStart" @keydown.enter.prevent @blur="emit('blur')"></textarea>
</template>
