<script setup lang="ts">
import { computed } from 'vue'
import GlueText from './GlueText.vue'
import { findRuleByName, model } from './store'

// KixDNS 给的原因里提到的规则名和上游组名能点：点规则打开那条规则，点组打开那个组（和现在面板的 RuntimeMessage 一样）
// Rule and group names in a reason from KixDNS are links: a rule opens its editor, a group its drawer (like today's RuntimeMessage)
// links：写在「」里的显示名直接对到规则编号（没起名字的规则显示的是条件，按名字认不回来） / links: display titles written in 「」 map straight to rule ids (an unnamed rule shows its condition, which name lookup cannot trace)
// breaks：中文标点后放显式的断点（WebKit 按词换行时不在中文标点处断，长句会从词中间硬切） / breaks: explicit break points after CJK
// punctuation (WebKit's keep-all does not break there, so a long sentence is cut mid-word)
const props = defineProps<{ text: string; links?: Record<string, number>; breaks?: boolean }>()
// 别的文字里带连字符的词（列表名、主机名）不在连字符后面断开 / Hyphenated words elsewhere in the text (list names, hosts) do not break after the hyphen
// 名字是行内的链接（不是按钮那样的一整块）：长名字像文字一样折行，引号用连接符粘在名字两头，不会单独落在行首行尾
// The name is an inline link (not a boxed button): a long name wraps like text, and word joiners glue the quotes to both ends, so neither is left alone at a line edge
const JOIN = '\u2060'
const emit = defineEmits<{ rule: [id: number]; group: [id: string] }>()
const parts = computed(() => props.text.split(/(「[^」]+」)/).map((piece) => {
  const name = /^「(.+)」$/.exec(piece)?.[1]
  if (!name) return { text: piece }
  if (props.links && Object.hasOwn(props.links, name)) return { text: piece, rule: props.links[name] }
  const rule = findRuleByName(name)
  if (rule) return { text: piece, rule: rule.id }
  const group = model.groups.find((g) => g.name === name)
  return group ? { text: piece, group: group.id } : { text: piece }
}))
</script>

<template>
  <span class="rtext"><template v-for="(p, i) in parts" :key="i"><template v-if="p.rule !== undefined">「{{ JOIN }}<a class="ui-objlink" href="#" @click.prevent="emit('rule', p.rule)">{{ p.text.slice(1, -1) }}</a>{{ JOIN }}」</template><template v-else-if="p.group !== undefined">「{{ JOIN }}<a class="ui-objlink" href="#" @click.prevent="emit('group', p.group)">{{ p.text.slice(1, -1) }}</a>{{ JOIN }}」</template><GlueText v-else :text="p.text" :breaks="breaks" /></template></span>
</template>

<style>
/* 段落里的链接能折行；手机上不再往上下补点按区：相邻两行的链接会互相盖住，点前一个开的是后一个（行内链接按文字本身算点按区）
   Links in running text can wrap; on phones they no longer grow their hit area up and down: links on neighbouring lines covered each other and a tap on the
   first opened the second (an inline link counts its text as the hit area) */
.rtext .ui-objlink { position: static; white-space: normal; }
.rtext .ui-objlink::before { content: none; }
/* 句子里的链接焦点框贴着字：默认往外让 2 会压到两边的「」 / A link in running text keeps its focus ring tight: the default 2 px offset ran through the 「」 beside it */
.rtext .ui-objlink:focus-visible { outline-offset: 0; border-radius: var(--r-1); }
</style>
