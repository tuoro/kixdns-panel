<script setup lang="ts">
import { keepTail } from './view'
import { CircleAlert, Info, X } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import UiDotText from '../components/ui/UiDotText.vue'
import { importReport, importSource } from './store'

// 导入说明：旧格式读进来时做了什么、哪些原样保留了。先说结论，再一条条列；要注意的排前面。
// The import notes: what reading an older config did and what was kept verbatim. The verdict first, then each note, warnings on top.
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
onMounted(() => dialog.value?.showModal())
const r = computed(() => importReport.value!)
const sorted = computed(() => [...r.value.notes].sort((a, b) => (a.level === b.level ? 0 : a.level === 'warn' ? -1 : 1)))
const noteGroups = computed(() => [
  { level: 'warn', title: '需要留意', notes: sorted.value.filter((n) => n.level === 'warn') },
  { level: 'info', title: '已自动整理', notes: sorted.value.filter((n) => n.level !== 'warn') },
].filter((group) => group.notes.length))
const verdict = computed(() => (r.value.stats.raw ? `${r.value.stats.raw} 条规则原样保留为高级规则，其余都已转换` : '全部转换好了，行为和原来一样'))
</script>

<template>
  <dialog ref="dialog" class="pdialog" aria-labelledby="imp-title" @cancel.prevent="emit('close')" @click.self="emit('close')">
    <div class="pdialog__panel imp">
      <header class="pdialog__head">
        <div class="pdrawer__titles"><h2 id="imp-title">导入说明</h2><p><UiDotText :parts="[importSource, `${r.stats.rules} 条规则`, `${r.stats.groups} 个上游组`, ...(r.stats.mappings ? [`${r.stats.mappings} 条域名映射`] : [])]" /></p></div>
        <button class="ui-icon-btn" type="button" aria-label="关闭" @click="emit('close')"><X :size="16" /></button>
      </header>
      <div class="pdialog__body">
        <p class="imp__verdict">{{ verdict }}</p>
        <!-- 要留意的和已经自动整理的分成两组，各有小标题 / Things to watch and things already tidied are two groups, each with a subhead -->
        <div v-if="sorted.length" class="imp__groups">
          <section v-for="group in noteGroups" :key="group.level" class="imp__group">
            <h3 class="imp__subhead">{{ group.title }}</h3>
            <ul class="imp__notes">
              <li v-for="(n, i) in group.notes" :key="i" :class="`is-${n.level}`"><CircleAlert v-if="n.level === 'warn'" :size="16" aria-hidden="true" /><Info v-else :size="16" aria-hidden="true" /><span>{{ keepTail(n.text)[0] }}<span class="nowrap">{{ keepTail(n.text)[1] }}</span></span></li>
            </ul>
          </section>
        </div>
      </div>
      <footer class="pdialog__foot"><button class="ui-btn ui-btn--primary" type="button" @click="emit('close')">知道了</button></footer>
    </div>
  </dialog>
</template>
