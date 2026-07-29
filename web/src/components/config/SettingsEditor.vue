<script setup lang="ts">
import { Plus, Trash2 } from '@lucide/vue'
import { SETTING_SECTIONS, settingVisible, type SettingField } from '../../config-editor/schema'
import type { GlobalSettings } from '../../config-editor/types'
import GeoDataEditor from './GeoDataEditor.vue'

const settings = defineModel<GlobalSettings>({ required: true })
defineEmits<{ notice: [message: string] }>()

function scalarValue(field: SettingField): string | number {
  const value = settings.value[field.key]
  return typeof value === 'string' || typeof value === 'number' ? value : ''
}

function csvValue(field: SettingField): string {
  const value = settings.value[field.key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join(', ') : typeof value === 'string' ? value : ''
}

function listValue(field: SettingField): string[] {
  const value = settings.value[field.key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function setText(field: SettingField, event: Event): void {
  settings.value[field.key] = (event.currentTarget as HTMLInputElement).value
}

function setNumber(field: SettingField, event: Event): void {
  const raw = (event.currentTarget as HTMLInputElement).value
  if (raw === '') {
    if (field.nullable) settings.value[field.key] = null
    else delete settings.value[field.key]
    return
  }
  settings.value[field.key] = Number(raw)
}

function setBoolean(field: SettingField, event: Event): void {
  settings.value[field.key] = (event.currentTarget as HTMLInputElement).checked
}

function setCsv(field: SettingField, event: Event): void {
  settings.value[field.key] = (event.currentTarget as HTMLInputElement).value
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean)
}

function addListItem(field: SettingField): void {
  settings.value[field.key] = [...listValue(field), '']
}

function setListItem(field: SettingField, index: number, event: Event): void {
  const next = [...listValue(field)]
  next[index] = (event.currentTarget as HTMLInputElement).value
  settings.value[field.key] = next
}

function removeListItem(field: SettingField, index: number): void {
  settings.value[field.key] = listValue(field).filter((_, itemIndex) => itemIndex !== index)
}
</script>

<template>
  <section v-for="section in SETTING_SECTIONS" :key="section.id" class="config-section">
    <header class="config-section__header">
      <span class="section-mark" :class="`section-mark--${section.tone}`"></span>
      <h3>{{ section.title }}</h3>
    </header>
    <div class="settings-grid">
      <template v-for="field in section.fields" :key="field.key">
        <label v-if="settingVisible(field, settings) && field.type !== 'boolean' && field.type !== 'list'" class="setting-field" :class="{ 'setting-field--wide': field.wide }" :title="field.title">
          <span>{{ field.label }}</span>
          <input v-if="field.type === 'text'" type="text" :value="scalarValue(field)" :placeholder="field.placeholder" @input="setText(field, $event)">
          <input v-else-if="field.type === 'number'" type="number" :value="scalarValue(field)" :placeholder="field.placeholder" :min="field.min" :max="field.max" @input="setNumber(field, $event)">
          <input v-else type="text" :value="csvValue(field)" :placeholder="field.placeholder" @input="setCsv(field, $event)">
        </label>

        <label v-else-if="settingVisible(field, settings) && field.type === 'boolean'" class="setting-toggle" :title="field.title">
          <span>{{ field.label }}</span>
          <input type="checkbox" :checked="Boolean(settings[field.key])" @change="setBoolean(field, $event)">
          <i aria-hidden="true"></i>
        </label>

        <div v-else-if="settingVisible(field, settings)" class="setting-field setting-field--wide setting-list">
          <span>{{ field.label }}</span>
          <div v-for="(item, index) in listValue(field)" :key="index" class="setting-list__row">
            <input type="text" :value="item" :placeholder="field.placeholder" :aria-label="`${field.label} ${index + 1}`" @input="setListItem(field, index, $event)">
            <button class="icon-button icon-button--small" type="button" :title="`删除${field.label}`" @click="removeListItem(field, index)"><Trash2 :size="14" /></button>
          </div>
          <button class="inline-command" type="button" @click="addListItem(field)"><Plus :size="14" />添加路径</button>
        </div>
      </template>
    </div>
  </section>
  <GeoDataEditor v-model="settings" @notice="$emit('notice', $event)" />
</template>
