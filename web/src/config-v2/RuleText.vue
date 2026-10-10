<script setup lang="ts">
import { computed } from 'vue'
import { findRuleByName, model } from './store'

// KixDNS 给的原因里提到的规则名和上游组名能点：点规则打开那条规则，点组打开那个组（和现在面板的 RuntimeMessage 一样）
// Rule and group names in a reason from KixDNS are links: a rule opens its editor, a group its drawer (like today's RuntimeMessage)
const props = defineProps<{ text: string }>()
const emit = defineEmits<{ rule: [id: number]; group: [id: string] }>()
const parts = computed(() => props.text.split(/(「[^」]+」)/).map((piece) => {
  const name = /^「(.+)」$/.exec(piece)?.[1]
  if (!name) return { text: piece }
  const rule = findRuleByName(name)
  if (rule) return { text: piece, rule: rule.id }
  const group = model.groups.find((g) => g.name === name)
  return group ? { text: piece, group: group.id } : { text: piece }
}))
</script>

<template>
  <span class="rtext"><template v-for="(p, i) in parts" :key="i"><template v-if="p.rule !== undefined">「<button class="ui-objlink ui-objlink--plain" type="button" @click="emit('rule', p.rule)">{{ p.text.slice(1, -1) }}</button>」</template><template v-else-if="p.group !== undefined">「<button class="ui-objlink ui-objlink--plain" type="button" @click="emit('group', p.group)">{{ p.text.slice(1, -1) }}</button>」</template><template v-else>{{ p.text }}</template></template></span>
</template>
