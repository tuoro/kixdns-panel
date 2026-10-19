<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

// 一行字的几种说法，从长到短：显示这一格放得下的第一种；都放不下时用最后一种，照样截短。说法换了、这一格宽度变了、字体载入以后都重新挑
// One line's wordings from longest to shortest: shows the first that fits the cell, or the last one, still cut off, when none does. Picks again
// when the wordings change, the cell is resized or the fonts load
const props = defineProps<{ variants: string[] }>()
const el = ref<HTMLElement | null>(null)
const at = ref(0)

// 量的时候直接换字：同一帧里量完再换回挑中的那句，画面上不会闪 / Measuring swaps the text directly and puts the chosen wording back in the same frame,
// so nothing flickers
function fit(): void {
  const node = el.value
  if (!node) return
  const last = props.variants.length - 1
  let pick = last
  for (let i = 0; i < last; i++) {
    node.textContent = props.variants[i]
    if (node.scrollWidth <= node.clientWidth) { pick = i; break }
  }
  node.textContent = props.variants[pick] ?? ''
  at.value = pick
}

let observer: ResizeObserver | null = null
onMounted(() => {
  fit()
  observer = new ResizeObserver(() => fit())
  if (el.value) observer.observe(el.value)
  void document.fonts?.ready.then(() => fit())
})
onBeforeUnmount(() => observer?.disconnect())
watch(() => props.variants.join('\n'), () => { void nextTick(fit) })
</script>

<template>
  <span ref="el">{{ variants[Math.min(at, variants.length - 1)] }}</span>
</template>
