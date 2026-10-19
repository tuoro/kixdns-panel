<script setup lang="ts">
import { computed } from 'vue'
import GlueText from './GlueText.vue'

// 句子里的一个列表名：默认名「文件名 · 主机」按「·」分成两段，只在两段之间折行（「·」贴在前一段末尾，折行落在它后面时由外面的 v-line-dots 藏起来）。
// 每一段和贴着它的引号、后缀连成一块，不会让「」」「：」落到行首；太长的一段整块换行，比一行还长才在里面断开
// One list name in a sentence: a default 「file name · host」 splits at 「·」 into two parts and wraps only between them (the 「·」 sits at the end of the first,
// and the v-line-dots around it hides it when a wrap falls right after). Each part is one block with the quote and suffix touching it, so 「」」 or 「：」 never
// starts a line; a part too long moves whole and only breaks inside when longer than a line
// whole：宽屏上整个名字放得下一行就不拆开（一串名字中间有一个被拆成两行，不如整个挪到下一行好读）；手机上照旧在「·」处折
// whole: on wide screens a name that fits a line is never split (one name broken in two amid a row of names reads worse than moving it down whole);
// phones still wrap at 「·」
const props = defineProps<{ name: string; quoted?: boolean; bold?: boolean; suffix?: string; whole?: boolean }>()
const parts = computed(() => props.name.split('\u00a0·\u00a0'))
// 带空格的长标题本来就能在空格处折：连成一整块的话，比一行还长时占满整行，前后的字都排不到它旁边。照普通文字排（带连字符的词照样连着），
// 只把最后一个词和后缀连成一块（后缀以「（」开头时，它前面本来可以断开；这一块比一行还长时照样在里面断开，不撑出去）
// A long title with spaces wraps at its spaces anyway: as one block it fills the whole line once longer than one, leaving no room for the words around
// it. It is laid out as text (hyphenated words still held together), with only its last word and the suffix as one block (one opening with 「（」 could
// otherwise break before it; a block longer than a line still breaks inside instead of overflowing)
const title = computed(() => {
  const only = parts.value.length === 1 ? parts.value[0]! : ''
  const cut = only.lastIndexOf(' ')
  return only.length > 30 && cut > 0 ? { head: only.slice(0, cut + 1), last: only.slice(cut + 1) } : null
})
</script>

<!-- 每一段是 glue-block：放不下时整块换行，比一行还长才在里面断开，带着后缀也不会撑出去；「·」和名字同色同粗，是名字的一部分。
     后缀以「的」结尾时（「名字」的），后面留一个折行处：连住的「的」后面接着的汉字在 keep-all 下拆不开，不留的话一长串只能硬切
     Each part is a glue-block: it moves whole when it does not fit and only breaks inside when longer than a line, so even with its suffix it never
     overflows; the 「·」 takes the name's colour and weight, being part of the name. A suffix ending in 的 (「name」的) is followed by a break opportunity:
     the CJK text after the glued 的 cannot break under keep-all, so without one a long run could only be cut hard -->
<template><span :class="{ 'name-whole': whole }"><template v-if="title"><template v-if="quoted">「</template><b v-if="bold"><GlueText :text="title.head" /></b><GlueText v-else :text="title.head" /><span class="glue-block"><b v-if="bold">{{ title.last }}</b><template v-else>{{ title.last }}</template>{{ quoted ? '」' : '' }}{{ suffix }}</span></template><template v-else><template v-for="(part, i) in parts" :key="i"><template v-if="i > 0">{{ ' ' }}</template><span class="glue-block"><template v-if="i === 0 && quoted">「</template><b v-if="bold">{{ part }}<span v-if="i < parts.length - 1" class="name-dot" data-line-dot>&nbsp;·</span></b><template v-else>{{ part }}<span v-if="i < parts.length - 1" class="name-dot" data-line-dot>&nbsp;·</span></template><template v-if="i === parts.length - 1">{{ quoted ? '」' : '' }}{{ suffix }}</template></span></template></template></span><wbr v-if="suffix?.endsWith('的')"></template>
