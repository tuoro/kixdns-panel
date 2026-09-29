<script setup lang="ts">
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState, RangeSet, StateEffect, StateField, type Text } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  drawSelection,
  dropCursor,
  gutterLineClass,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { JSON_SOFT_BREAK } from '../ui/soft-breaks'

// JSON 视图（规范 3.9）：语法只用字重和墨色深浅区分——键 500，数字、布尔和 null 用次要色，标点最浅；
// 不用彩色。解析出错时那一行画红色波浪线、行号变红；reveal 把光标放到指定的行列（保存栏点「第 7 行第 5 列」）。
// The JSON view (spec 3.9): syntax is told apart only by weight and ink depth (keys 500; numbers, booleans
// and null secondary; punctuation lightest), never by hue. On a parse error that line gets a red wavy
// underline and a red line number; reveal puts the cursor at a line and column (the save bar's link).
const props = defineProps<{ modelValue: string; readonly?: boolean; errorLine?: number }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const host = ref<HTMLElement | null>(null)
let view: EditorView | null = null

const ledgerHighlight = HighlightStyle.define([
  { tag: tags.propertyName, fontWeight: '500' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--l-ink-2)' },
  { tag: [tags.punctuation, tags.separator, tags.brace, tags.squareBracket], color: 'var(--l-ink-3)' },
])

// 键一律 500：不靠语法树认，靠「引号里的一段后面跟着冒号」认。写错时语法树在出错处附近会断，键不能因此变细（审计 V19）。
// Keys are always 500, recognised as a quoted run followed by a colon rather than by the syntax tree, which breaks
// near a mistake; a key never loses its weight because of an error nearby (audit V19).
const keyMatcher = new MatchDecorator({ regexp: /"(?:[^"\\\n]|\\.)*"(?=\s*:)/g, decoration: Decoration.mark({ class: 'cm-json-key' }) })
const keyWeight = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = keyMatcher.createDeco(view) }
  update(update: ViewUpdate) { this.decorations = keyMatcher.updateDeco(update, this.decorations) }
}, { decorations: (plugin) => plugin.decorations })

// 长键在「_」后面可以折行（放一个 <wbr>）：手机上 statistics_anonymize_client_ip 断成「statistics_anonymize_」
// 「client_ip」，不从词中间断开（审计第二轮 V2）。路径在「/」后面也可以折行，落在目录的边界上，不在 kixdns-panel 的「-」处断开；
// 「://」后面不放（审计第三轮 V12）。「.」后面不放：1.1.1.1:53 这样的地址不能拆开。<wbr> 不占文档位置，光标照常移动
// Long keys may wrap after 「_」 (a <wbr> goes there): on a phone statistics_anonymize_client_ip wraps as
// 「statistics_anonymize_」「client_ip」 instead of mid-word (audit round 2, V2). Paths may also wrap after 「/」, on a directory
// boundary rather than at the hyphen in kixdns-panel; never right after 「://」 (audit round 3, V12). Never after 「.」, so an
// address such as 1.1.1.1:53 stays whole. The <wbr> takes no document position, so the caret moves as usual
class SoftBreak extends WidgetType {
  toDOM(): HTMLElement { return document.createElement('wbr') }
  eq(): boolean { return true }
}
const softBreak = Decoration.widget({ widget: new SoftBreak(), side: 1 })
// 哪里可以软换行见 ui/soft-breaks.ts / Where a line may wrap: see ui/soft-breaks.ts
const breakMatcher = new MatchDecorator({ regexp: JSON_SOFT_BREAK, decorate: (add, _from, to) => add(to, to, softBreak) })
const softBreaks = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = breakMatcher.createDeco(view) }
  update(update: ViewUpdate) { this.decorations = breakMatcher.updateDeco(update, this.decorations) }
}, { decorations: (plugin) => plugin.decorations })

// 折行时续行挂在这一行的键下面、再缩两格：窄屏上层级还读得出来，不会从第 0 列重新开始（审计 V1）。
// 做法是每一行按前面的空格数给一个左内边距，再用同样大小的负首行缩进把第一行拉回原位。行首的缩进不许断开：
// 否则放不下的长键会先在缩进后面断一次，留下一个空的第一行。
// Wrapped continuation rows hang under the line's key, two columns further in, so nesting stays readable on a narrow
// screen instead of restarting at column 0 (audit V1): each line gets a left padding by its leading spaces, and an
// equal negative first-line indent pulls the first row back. The leading indent never breaks, or a key too long for
// the row would first break after it and leave an empty first row.
const leadMark = Decoration.mark({ class: 'cm-lead' })
const hangCache = new Map<number, Decoration>()
function hangFor(spaces: number): Decoration {
  let decoration = hangCache.get(spaces)
  if (!decoration) {
    decoration = Decoration.line({ class: 'cm-hang', attributes: { style: `--hang: ${spaces + 2}ch` } })
    hangCache.set(spaces, decoration)
  }
  return decoration
}
function hangingIndent(view: EditorView): DecorationSet {
  const ranges = []
  for (const { from, to } of view.visibleRanges) {
    for (let position = from; position <= to;) {
      const line = view.state.doc.lineAt(position)
      const spaces = /^ */.exec(line.text)?.[0].length ?? 0
      ranges.push(hangFor(spaces).range(line.from))
      if (spaces) ranges.push(leadMark.range(line.from, line.from + spaces))
      position = line.to + 1
    }
  }
  return Decoration.set(ranges, true)
}
const hanging = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = hangingIndent(view) }
  update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged) this.decorations = hangingIndent(update.view) }
}, { decorations: (plugin) => plugin.decorations })

const setErrorLine = StateEffect.define<number | null>()
class ErrorGutterMarker extends GutterMarker {
  override elementClass = 'cm-error-gutter'
}
const errorGutterMarker = new ErrorGutterMarker()
const errorText = Decoration.mark({ class: 'cm-error-text' })
interface ErrorMarks { line: DecorationSet; gutter: RangeSet<GutterMarker> }
// 波浪线从这一行第一个不是空格的字画到行尾：缩进下面不画（审计第三轮 V11）。每次改动后都按行号那一格所在的行重画，
// 不去挪原来的范围：在出错的那一行中间回车，波浪线不会跟着跨到下一行（审计第四轮 C3）
// The wave runs from the line's first non-space character to its end, never under the indent (audit round 3, V11). After every edit it is
// redrawn on the line holding the gutter mark instead of mapping the old range, so pressing Enter inside the error line does not
// stretch the wave onto the next line (audit round 4, C3)
function errorLineMarks(doc: Text, from: number): ErrorMarks {
  const line = doc.lineAt(from)
  const start = line.from + (/^\s*/.exec(line.text)?.[0].length ?? 0)
  return { line: start < line.to ? Decoration.set([errorText.range(start, line.to)]) : Decoration.none, gutter: RangeSet.of([errorGutterMarker.range(line.from)]) }
}
const errorMarks = StateField.define<ErrorMarks>({
  create: () => ({ line: Decoration.none, gutter: RangeSet.empty }),
  update(value, transaction) {
    let next = value
    if (transaction.docChanged) {
      const gutter = value.gutter.map(transaction.changes)
      let at: number | undefined
      gutter.between(0, transaction.state.doc.length, (from) => { at = from })
      next = at === undefined ? { line: Decoration.none, gutter: RangeSet.empty } : errorLineMarks(transaction.state.doc, at)
    }
    for (const effect of transaction.effects) {
      if (!effect.is(setErrorLine)) continue
      const number = effect.value
      next = !number || number > transaction.state.doc.lines
        ? { line: Decoration.none, gutter: RangeSet.empty }
        : errorLineMarks(transaction.state.doc, transaction.state.doc.line(number).from)
    }
    return next
  },
  provide: (field) => [EditorView.decorations.from(field, (value) => value.line), gutterLineClass.from(field, (value) => value.gutter)],
})

onMounted(() => {
  if (!host.value) return
  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      dropCursor(),
      highlightActiveLine(),
      keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
      json(),
      syntaxHighlighting(ledgerHighlight),
      keyWeight,
      softBreaks,
      hanging,
      errorMarks,
      EditorState.readOnly.of(props.readonly ?? false),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': 'JSON 配置编辑器', spellcheck: 'false' }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) emit('update:modelValue', update.state.doc.toString())
      }),
    ],
  })
  view = new EditorView({ state, parent: host.value })
  if (props.errorLine) view.dispatch({ effects: setErrorLine.of(props.errorLine) })
})

watch(() => props.modelValue, (value) => {
  if (!view || value === view.state.doc.toString()) return
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
})

watch(() => props.errorLine, (line) => {
  view?.dispatch({ effects: setErrorLine.of(line ?? null) })
})

function reveal(line: number, column: number): void {
  if (!view) return
  const doc = view.state.doc
  const target = doc.line(Math.min(Math.max(1, line), doc.lines))
  const position = Math.min(target.from + Math.max(0, column - 1), target.to)
  view.dispatch({ selection: { anchor: position }, scrollIntoView: true })
  view.focus()
}

defineExpose({ reveal })
onBeforeUnmount(() => view?.destroy())
</script>

<template><div ref="host" class="json-editor"></div></template>
