<script setup lang="ts">
import type { KixConfig } from '../../config-editor/types'
import PipelineEditor from './PipelineEditor.vue'
import type { RuntimeTarget } from './RuntimeMessage.vue'
import SettingsEditor from './SettingsEditor.vue'

const config = defineModel<KixConfig>({ required: true })
withDefaults(defineProps<{ capabilities: string[]; section?: 'all' | 'settings' | 'pipeline'; focus?: RuntimeTarget | null; changedSettings?: ReadonlySet<string> }>(), { section: 'all', focus: null, changedSettings: undefined })
defineEmits<{ notice: [message: string] }>()
</script>

<template>
  <div class="structured-editor">
    <SettingsEditor v-if="section !== 'pipeline'" v-model="config.settings" v-model:version="config.version" :capabilities="capabilities" :changed="changedSettings" />
    <PipelineEditor v-if="section !== 'settings'" v-model="config" :manual-only="section === 'pipeline'" :capabilities="capabilities" :focus="focus" @notice="$emit('notice', $event)" />
  </div>
</template>
