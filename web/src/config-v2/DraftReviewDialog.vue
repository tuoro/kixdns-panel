<script setup lang="ts">
import { X } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { diffModels } from '../config-model/diff'
import DiffBlocks from './DiffBlocks.vue'
import { appliedModel, model } from './store'

// 保存前看一眼：草稿和上次保存的版本差在哪，删掉的、上游组、其余请求、设置都在里面（列表里的点只标得出规则）。
// 不写处数：保存条按对象数，这里按改动块数，两个数对不上反而让人起疑。
// A look before saving: how the draft differs from the last saved version, including deletions, upstream groups, the catch-all and
// settings, which the dots in the lists cannot show. No count: the save bar counts objects and this counts change blocks, and two
// numbers that disagree only raise doubt.
const props = defineProps<{ saveLabel: string; canSave: boolean }>()
const emit = defineEmits<{ close: []; save: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
onMounted(() => dialog.value?.showModal())
const blocks = computed(() => diffModels(appliedModel.value, model))
</script>

<template>
  <dialog ref="dialog" class="pdialog diffd" aria-labelledby="review-title" @cancel.prevent="emit('close')" @click.self="emit('close')">
    <div class="pdialog__panel diffd__panel">
      <header class="pdialog__head">
        <div class="pdrawer__titles"><h2 id="review-title">改了哪些</h2><p>{{ blocks.length ? '和上次保存的版本比' : '和上次保存的版本一样' }}</p></div>
        <button class="ui-icon-btn" type="button" aria-label="关闭" @click="emit('close')"><X :size="16" /></button>
      </header>
      <div class="pdialog__body diffd__body">
        <template v-if="blocks.length">
          <p class="diffd__legend">保存以后：<span class="diffd__sign is-del">−</span> 去掉 <span class="diffd__sign is-add">+</span> 加上</p>
          <DiffBlocks :blocks="blocks" />
        </template>
        <p v-else class="hist__empty">草稿和上次保存的版本一样，保存不会改变什么。</p>
      </div>
      <footer class="pdialog__foot"><button class="ui-btn ui-btn--secondary" type="button" @click="emit('close')">关闭</button><button v-if="blocks.length" class="ui-btn ui-btn--primary" type="button" :disabled="!props.canSave" @click="emit('save')">{{ props.saveLabel }}</button></footer>
    </div>
  </dialog>
</template>
