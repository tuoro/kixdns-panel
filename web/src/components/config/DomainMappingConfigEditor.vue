<script setup lang="ts">
import { computed } from 'vue'
import { collectDomainMappingRows, replaceDomainMappingRows } from '../../config-editor/solution'
import { CONFIG_STATIC_CNAME_RESPONSE_V1 } from '../../config-editor/schema'
import type { KixConfig } from '../../config-editor/types'
import DomainMappingTable from './DomainMappingTable.vue'

const config = defineModel<KixConfig>({ required: true })
const props = defineProps<{ capabilities: string[] }>()
const supported = computed(() => props.capabilities.includes(CONFIG_STATIC_CNAME_RESPONSE_V1))
const rows = computed({
  get: () => collectDomainMappingRows(config.value),
  set: (value) => replaceDomainMappingRows(config.value, value),
})
</script>

<template>
  <div class="domain-mapping-config">
    <p v-if="!supported" class="domain-mapping-config__warning">当前 KixDNS 不支持固定 CNAME；已有映射会保留，请先更新或切换内核后再应用。</p>
    <DomainMappingTable v-model="rows" />
  </div>
</template>

<style scoped>
.domain-mapping-config { min-height: 520px; padding: 18px 20px 22px; background: #fff; }
.domain-mapping-config__warning { margin-bottom: 14px; padding: 10px 12px; color: #8a6329; background: #fff8ee; border-left: 3px solid #bf8b36; font-size: 9px; line-height: 1.5; }
@media (max-width: 640px) {
  .domain-mapping-config { min-height: 0; padding: 14px 13px 18px; }
}
</style>
