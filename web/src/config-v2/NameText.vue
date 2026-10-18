<script setup lang="ts">
import { computed } from 'vue'

// 句子里的一个列表名：默认名「文件名 · 主机」按「·」分成两段，只在两段之间折行（「·」贴在前一段末尾，折行落在它后面时由外面的 v-line-dots 藏起来）。
// 每一段和贴着它的引号、后缀连成一块，不会让「」」「：」落到行首；太长的一段整块换行，比一行还长才在里面断开
// One list name in a sentence: a default 「file name · host」 splits at 「·」 into two parts and wraps only between them (the 「·」 sits at the end of the first,
// and the v-line-dots around it hides it when a wrap falls right after). Each part is one block with the quote and suffix touching it, so 「」」 or 「：」 never
// starts a line; a part too long moves whole and only breaks inside when longer than a line
const props = defineProps<{ name: string; quoted?: boolean; bold?: boolean; suffix?: string }>()
const parts = computed(() => props.name.split('\u00a0·\u00a0'))
</script>

<!-- 每一段是 glue-block：放不下时整块换行，比一行还长才在里面断开，带着后缀也不会撑出去；「·」和名字同色同粗，是名字的一部分
     Each part is a glue-block: it moves whole when it does not fit and only breaks inside when longer than a line, so even with its suffix it never
     overflows; the 「·」 takes the name's colour and weight, being part of the name -->
<template><template v-for="(part, i) in parts" :key="i"><template v-if="i > 0">{{ ' ' }}</template><span class="glue-block"><template v-if="i === 0 && quoted">「</template><b v-if="bold">{{ part }}<span v-if="i < parts.length - 1" class="name-dot" data-line-dot>&nbsp;·</span></b><template v-else>{{ part }}<span v-if="i < parts.length - 1" class="name-dot" data-line-dot>&nbsp;·</span></template><template v-if="i === parts.length - 1">{{ quoted ? '」' : '' }}{{ suffix }}</template></span></template></template>
