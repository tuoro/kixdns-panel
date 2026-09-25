<script setup lang="ts">
import { ref, watch } from 'vue'
import { diffDigits, type DigitCell } from '../../ui/digits'

// 数字：值变了只有变了的那几位弹入；第一次显示和值没变时一位都不动。
// 调用方负责格式化（千分位、单位），这里只按显示出来的字符比较。
// A number whose changed positions pop in when the value changes; nothing
// moves on first render or when the value is unchanged. Callers format the
// value (grouping, units); this compares the rendered characters only.
const props = defineProps<{ value: string }>()
const cells = ref<DigitCell[]>(diffDigits(null, props.value))
// 每次变化换一次 key，同一位连续变化时动画也会重新播放
// A new key per change so a position that changes again replays its animation
const generation = ref(0)
watch(() => props.value, (next, previous) => {
  cells.value = diffDigits(previous ?? null, next)
  generation.value += 1
})
</script>

<template>
  <span class="ui-num" :aria-label="value"><span v-for="(cell, index) in cells" :key="`${index}-${cell.changed ? generation : 0}`"
    class="ui-num__digit" :class="{ 'ui-num__digit--pop': cell.changed }" aria-hidden="true">{{ cell.char }}</span></span>
</template>
