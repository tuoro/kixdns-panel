<script setup lang="ts">
import type { KixConfig } from '../../config-editor/types'
import PipelineEditor from './PipelineEditor.vue'
import SettingsEditor from './SettingsEditor.vue'

const config = defineModel<KixConfig>({ required: true })
defineEmits<{ notice: [message: string] }>()
</script>

<template>
  <div class="structured-editor">
    <section class="config-section config-version">
      <header class="config-section__header"><span class="section-mark section-mark--ink"></span><h3>配置格式</h3></header>
      <label class="setting-field"><span>Version</span><input v-model="config.version" type="text" placeholder="1.0"></label>
    </section>
    <SettingsEditor v-model="config.settings" @notice="$emit('notice', $event)" />
    <PipelineEditor v-model="config" @notice="$emit('notice', $event)" />
  </div>
</template>
