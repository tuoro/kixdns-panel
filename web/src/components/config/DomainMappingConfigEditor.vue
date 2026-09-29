<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { collectDomainMappingRows, replaceDomainMappingRows, type DomainMappingRow } from '../../config-editor/solution'
import { CONFIG_STATIC_CNAME_RESPONSE_V1 } from '../../config-editor/schema'
import type { KixConfig } from '../../config-editor/types'
import DomainMappingTable from './DomainMappingTable.vue'

const config = defineModel<KixConfig>({ required: true })
const props = defineProps<{ capabilities: string[] }>()
const supported = computed(() => props.capabilities.includes(CONFIG_STATIC_CNAME_RESPONSE_V1))
// 点了「添加映射」还一个字没填的行留在这里，不写进草稿，也不算修改（规范 9.3）；填了一格就写进去。
// 配置从外面变了（重新读取、导入、恢复）时，这里跟着换成配置里的那份。
// A row added but not yet typed into stays here, out of the draft and uncounted (spec 9.3); one filled field
// writes it. When the config changes from outside (reload, import, restore) this follows the config.
const blank = (row: DomainMappingRow) => !row.source.trim() && !row.target.trim()
const identity = (rows: readonly DomainMappingRow[]) => JSON.stringify(rows.map((row) => [row.source, row.target]))
// 行的内容（源、目标、TTL）一样就不写：加一个空行、换回原值都不该碰草稿（规范 9.3，审计 M1）
// Rows with the same content (source, target, TTL) are not written: adding a blank row or typing a value back must leave the draft alone (spec 9.3, audit M1)
const content = (rows: readonly DomainMappingRow[]) => JSON.stringify(rows.map((row) => [row.source, row.target, Number.isNaN(row.ttl) ? null : row.ttl]))
const localRows = ref<DomainMappingRow[]>(collectDomainMappingRows(config.value))
watch(() => identity(collectDomainMappingRows(config.value)), (fromConfig) => {
  if (fromConfig !== identity(localRows.value.filter((row) => !blank(row)))) localRows.value = collectDomainMappingRows(config.value)
})
const rows = computed({
  get: () => localRows.value,
  set: (value) => {
    localRows.value = value
    const filled = value.filter((row) => !blank(row))
    if (content(filled) === content(collectDomainMappingRows(config.value))) return
    replaceDomainMappingRows(config.value, filled)
  },
})
</script>

<template>
  <div class="domain-mapping-config">
    <!-- 不再写「域名映射」标题：页签上已经写了；它排在哪、怎么匹配由映射表上方那一句说。
         No 域名映射 title, which the tab already shows; the table's own line says where it ranks and how it matches. -->
    <p v-if="!supported" class="domain-mapping-config__warning">当前 KixDNS 不支持固定 CNAME；已有映射会保留，请先更新或切换内核后再应用。</p>
    <DomainMappingTable v-model="rows" />
  </div>
</template>

<style scoped>
/* 四边一样的内边距：和面板里组与组的间距一样，24（手机 16）（规范 6.4，审计 M11） / Even padding on all four sides, the panel's group spacing: 24 (16 on a phone) (spec 6.4, audit M11) */
.domain-mapping-config { display: grid; gap: var(--s-3); padding: var(--s-5); background: var(--l-surface); border-radius: var(--r-3); }
.domain-mapping-config__warning { margin: 0; padding: var(--s-2) var(--s-3); border-radius: var(--r-2); background: var(--warn-tint-l); color: var(--l-ink); font-size: var(--t-2); }
@media (max-width: 640px) {
  .domain-mapping-config { padding: var(--s-4); }
}
</style>
