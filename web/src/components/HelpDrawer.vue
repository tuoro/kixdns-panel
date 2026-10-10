<script setup lang="ts">
import { X } from '@lucide/vue'
import { computed, nextTick, onMounted, ref } from 'vue'
import { useHelp } from '../composables/useHelp'
import { SHORTCUTS, topicsOf } from '../help/topics'

// 帮助抽屉：这一页的概念按词条列出来（点开读），底部是快捷键一览。从「?」弹层过来时直接展开那个词条；从账户菜单或 ? 键过来时滚到快捷键。
// The help drawer: this page's concepts as expandable entries, the shortcut list at the bottom. Coming from a 「?」 popover opens that entry; coming from the account menu or the ? key scrolls to the shortcuts.
const help = useHelp()
const dialog = ref<HTMLDialogElement | null>(null)
const body = ref<HTMLElement | null>(null)
const req = computed(() => help.request.value)
const topics = computed(() => (req.value ? topicsOf(req.value.page) : []))

onMounted(() => {
  dialog.value?.showModal()
  void nextTick(() => {
    const target = req.value?.section === 'shortcuts' ? body.value?.querySelector('#help-shortcuts') : req.value?.topic ? body.value?.querySelector(`#help-${req.value.topic}`) : null
    target?.scrollIntoView({ block: 'start' })
  })
})
</script>

<template>
  <dialog ref="dialog" class="help" aria-labelledby="help-title" @cancel.prevent="help.hide()" @click.self="help.hide()">
    <div class="help__panel">
      <header class="help__head">
        <h2 id="help-title">帮助</h2>
        <button class="ui-icon-btn" type="button" aria-label="关闭帮助" title="关闭帮助" @click="help.hide()"><X :size="16" /></button>
      </header>
      <div ref="body" class="help__body">
        <section v-if="topics.length" class="help__sec" aria-labelledby="help-topics-title">
          <h3 id="help-topics-title" class="ui-lbl">这一页的概念</h3>
          <details v-for="t in topics" :id="`help-${t.id}`" :key="t.id" class="help__topic" :open="t.id === req?.topic">
            <summary>{{ t.title }}</summary>
            <p v-for="(line, i) in t.body" :key="i">{{ line }}</p>
          </details>
        </section>
        <section id="help-shortcuts" class="help__sec help__sec--keys" aria-labelledby="help-keys-title">
          <h3 id="help-keys-title" class="ui-lbl">键盘快捷键</h3>
          <div v-for="g in SHORTCUTS" :key="g.title" class="help__keys">
            <h4>{{ g.title }}</h4>
            <dl>
              <template v-for="s in g.items" :key="s.what">
                <dt><kbd v-for="k in s.keys" :key="k" class="kbd">{{ k }}</kbd></dt>
                <dd>{{ s.what }}</dd>
              </template>
            </dl>
          </div>
        </section>
      </div>
    </div>
  </dialog>
</template>
