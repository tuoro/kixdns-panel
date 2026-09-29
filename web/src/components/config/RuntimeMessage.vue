<script setup lang="ts">
import { computed } from 'vue'
import type { KixConfig } from '../../config-editor/types'

export interface RuntimeTarget {
  pipeline: string
  rule?: string
}

// 内核的原话按「文字 + 机器值」拆开（规范 8.4）：配置里真有的 Pipeline、规则名是等宽的链接，点了去那里；
// 引号里的其他值只是等宽；其余照原样用界面字。不猜句式：认得出的对象才做成链接，认不出的原话照写。
// A kernel message split into text and machine values (spec 8.4): Pipeline IDs and rule names that
// exist in the config become mono links that go there; other quoted values are just mono; the rest
// stays in the UI font. No guessing at sentence shapes: only recognised objects become links.
const props = defineProps<{ text: string; config?: KixConfig | null }>()
const emit = defineEmits<{ navigate: [target: RuntimeTarget] }>()

// tail：紧跟在机器值后面的标点，和它放在同一块里，逗号、冒号不会自己起一行（审计第三轮 C4）
// tail: punctuation right after a machine value, kept in the same block so a comma or colon never starts a line (audit round 3, C4)
interface Part { text: string; target?: RuntimeTarget; value?: boolean; tail?: string }
const TRAILING_PUNCTUATION = /^[,.:;!?)\]}，。：；、！？）】」』》]+/

const parts = computed<Part[]>(() => {
  const pipelines = new Set(props.config?.pipelines.map((pipeline) => pipeline.id) ?? [])
  const rules = new Map<string, string>()
  for (const pipeline of props.config?.pipelines ?? []) {
    for (const rule of pipeline.rules) if (rule.name && !rules.has(rule.name)) rules.set(rule.name, pipeline.id)
  }
  const result: Part[] = []
  let lastPipeline: string | undefined
  // 引号里的一段、或者一个像标识符的词（字母数字和 _ . - : /）。词不以 . : - 结尾：「listeners:」里的冒号是句子的标点，不是值的一部分
  // A quoted run, or an identifier-like word. A word never ends in . : or -: the colon in 「listeners:」 punctuates the sentence, it is not part of a value
  const pattern = /(['"`‘“「])([^'"`’”」]+)(['"`’”」])|[A-Za-z0-9](?:[A-Za-z0-9_.:/-]*[A-Za-z0-9_/])?/g
  let cursor = 0
  for (const match of props.text.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > cursor) result.push({ text: props.text.slice(cursor, start) })
    const quoted = match[2]
    const word = quoted ?? match[0]
    if (pipelines.has(word)) {
      lastPipeline = word
      result.push({ text: word, target: { pipeline: word } })
    } else if (rules.has(word)) {
      const pipeline = lastPipeline && props.config?.pipelines.find((item) => item.id === lastPipeline)?.rules.some((rule) => rule.name === word) ? lastPipeline : rules.get(word)!
      result.push({ text: word, target: { pipeline, rule: word } })
    } else if (quoted !== undefined) {
      result.push({ text: word, value: true })
    } else {
      // 带数字或 _ - : . / 的词多半是地址、端口、组名这类机器值 / Words with digits or _ - : . / are usually addresses, ports or group names
      result.push({ text: word, value: /[\d_:./-]/.test(word) })
    }
    cursor = start + match[0].length
  }
  if (cursor < props.text.length) result.push({ text: props.text.slice(cursor) })
  for (const [index, part] of result.entries()) {
    const next = result[index + 1]
    if (!(part.target || part.value) || !next || next.target || next.value) continue
    const tail = TRAILING_PUNCTUATION.exec(next.text)?.[0]
    if (!tail) continue
    part.tail = tail
    next.text = next.text.slice(tail.length)
  }
  return result.filter((part) => part.text || part.tail)
})
</script>

<template>
  <span class="runtime-message"><template v-for="(part, index) in parts" :key="index"><span v-if="part.tail" class="runtime-message__unit"><button v-if="part.target" class="ui-objlink" type="button" :title="part.target.rule ? `在自由编辑里打开规则 ${part.target.rule}` : `在自由编辑里打开 Pipeline ${part.target.pipeline}`" @click="emit('navigate', part.target)">{{ part.text }}</button><code v-else>{{ part.text }}</code>{{ part.tail }}</span><button v-else-if="part.target" class="ui-objlink" type="button" :title="part.target.rule ? `在自由编辑里打开规则 ${part.target.rule}` : `在自由编辑里打开 Pipeline ${part.target.pipeline}`" @click="emit('navigate', part.target)">{{ part.text }}</button><code v-else-if="part.value">{{ part.text }}</code><template v-else>{{ part.text }}</template></template></span>
</template>

<style scoped>
/* 中文只在机器值两边的空格处换行，「上游组」这样的词不会拆成两半；一段实在放不下才在任意处断。
   机器值整块换行，比一行还宽才在里面断（审计第二轮 S1）
   CJK breaks only at the spaces around machine values, so a noun like 上游组 never splits; only a run that cannot fit breaks
   anywhere. A machine value wraps whole and breaks inside only when wider than a line (audit round 2, S1) */
.runtime-message { word-break: keep-all; overflow-wrap: anywhere; }
.runtime-message code { display: inline-block; max-width: 100%; font-family: var(--f-mono); }
/* 机器值连同后面的标点是一块（审计第三轮 C4） / A machine value and the punctuation after it form one block (audit round 3, C4) */
.runtime-message__unit { display: inline-block; max-width: 100%; }
/* 等宽的机器值只占字那么高：按自己的行高对齐会把每一行撑高 1，两行的原因高出 2（审计第七轮 S1）。手机上的点按区靠 ::before，还是 44
   Mono values take only their glyph height; on their own line height they grew each line by 1 and a two-line reason by 2 (audit round 7, S1).
   The phone tap area comes from ::before and stays 44 */
.runtime-message code, .runtime-message .ui-objlink { line-height: 1; }
</style>
