<script setup lang="ts">
import {
  Braces,
  Check,
  Clock3,
  Download,
  FileUp,
  History,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  TriangleAlert,
  Workflow,
} from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { apiRequest, jsonBody } from '../api/client'
import type { ConfigApplyResult, ConfigDocument, ConfigVersion, ConfigVersions, ValidationResult } from '../api/types'
import ConfigFlowPreview from '../components/config/ConfigFlowPreview.vue'
import StructuredConfigEditor from '../components/config/StructuredConfigEditor.vue'
import JsonEditor from '../components/JsonEditor.vue'
import { normalizeConfig, serializeConfig } from '../config-editor/model'
import type { ConfigEditorMode, KixConfig } from '../config-editor/types'
import { useToast } from '../composables/useToast'
import { errorMessage, formatDate, shortHash } from '../utils'

const document = ref<ConfigDocument | null>(null)
const config = ref<KixConfig | null>(null)
const versions = ref<ConfigVersion[]>([])
const source = ref('')
const baseline = ref('')
const message = ref('')
const mode = ref<ConfigEditorMode>('structured')
const fileInput = ref<HTMLInputElement | null>(null)
const loading = ref(true)
const validating = ref(false)
const saving = ref(false)
const restoring = ref<number | null>(null)
const validation = ref<ValidationResult | null>(null)
const parseError = ref('')
const toast = useToast()
const changed = computed(() => source.value !== baseline.value)
let syncingConfig = false

watch(source, () => {
  validation.value = null
  parseError.value = ''
})

watch(config, (value) => {
  if (!value || syncingConfig) return
  source.value = serializeConfig(value)
}, { deep: true, flush: 'sync' })

function confirmDiscard(): boolean {
  return !changed.value || window.confirm('当前配置尚未保存，确定离开？')
}

function preventAccidentalClose(event: BeforeUnloadEvent): void {
  if (!changed.value) return
  event.preventDefault()
  event.returnValue = ''
}

function parseSource(): Record<string, unknown> | null {
  parseError.value = ''
  try {
    const value: unknown = JSON.parse(source.value)
    if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error('配置根节点必须是 JSON 对象')
    return value as Record<string, unknown>
  } catch (error) {
    parseError.value = errorMessage(error)
    validation.value = null
    return null
  }
}

function syncStructuredFromSource(): boolean {
  const content = parseSource()
  if (!content) return false
  syncingConfig = true
  config.value = normalizeConfig(content)
  source.value = serializeConfig(config.value)
  syncingConfig = false
  return true
}

function activateMode(nextMode: ConfigEditorMode): void {
  if (mode.value === nextMode) return
  if (mode.value === 'json' && nextMode !== 'json' && !syncStructuredFromSource()) {
    toast.error('JSON 解析失败，修正后才能切换视图')
    return
  }
  mode.value = nextMode
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const [nextDocument, history] = await Promise.all([
      apiRequest<ConfigDocument>('/api/v1/config'),
      apiRequest<ConfigVersions>('/api/v1/config/versions'),
    ])
    document.value = nextDocument
    versions.value = history.versions
    syncingConfig = true
    config.value = normalizeConfig(nextDocument.content)
    source.value = serializeConfig(config.value)
    baseline.value = source.value
    syncingConfig = false
    validation.value = null
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    loading.value = false
  }
}

async function validate(): Promise<ValidationResult | null> {
  const content = parseSource()
  if (!content) return null
  validating.value = true
  try {
    validation.value = await apiRequest<ValidationResult>('/api/v1/config/validate', {
      method: 'POST',
      ...jsonBody(content),
    })
    toast.success(`配置通过校验，${validation.value.pipeline_count} 条 Pipeline，${validation.value.rule_count} 条规则`)
    return validation.value
  } catch (error) {
    toast.error(errorMessage(error))
    return null
  } finally {
    validating.value = false
  }
}

async function save(): Promise<void> {
  if (!document.value || !changed.value) return
  const content = parseSource()
  if (!content) return
  saving.value = true
  try {
    const checked = await validate()
    if (!checked?.valid) return
    const result = await apiRequest<ConfigApplyResult>('/api/v1/config', {
      method: 'PUT',
      ...jsonBody({ content, expected_sha256: document.value.sha256, message: message.value.trim() }),
    })
    toast.success(`配置已生效，运行时代次 #${result.active_config.generation}`)
    message.value = ''
    await load()
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    saving.value = false
  }
}

async function restore(version: ConfigVersion): Promise<void> {
  if (!document.value || !window.confirm(`恢复版本 #${version.id}？当前配置会先保存为历史版本。`)) return
  restoring.value = version.id
  try {
    const result = await apiRequest<ConfigApplyResult>(`/api/v1/config/versions/${version.id}/restore`, {
      method: 'POST',
      ...jsonBody({ expected_sha256: document.value.sha256 }),
    })
    toast.success(`版本 #${version.id} 已恢复，当前版本 #${result.version_id}`)
    await load()
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    restoring.value = null
  }
}

async function importFile(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error('配置文件不能超过 4 MiB')
    source.value = await file.text()
    if (!syncStructuredFromSource()) {
      mode.value = 'json'
      throw new Error(parseError.value || 'JSON 解析失败')
    }
    mode.value = 'structured'
    toast.success(`已导入 ${file.name}`)
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    input.value = ''
  }
}

function downloadJson(): void {
  if (!parseSource()) return
  const blob = new Blob([source.value], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = 'pipeline.json'
  anchor.click()
  URL.revokeObjectURL(url)
}

onBeforeRouteLeave(confirmDiscard)
onMounted(() => {
  window.addEventListener('beforeunload', preventAccidentalClose)
  void load()
})
onBeforeUnmount(() => window.removeEventListener('beforeunload', preventAccidentalClose))
</script>

<template>
  <div class="page config-page">
    <div class="page-actions">
      <div v-if="document" class="document-meta"><span class="status-dot"></span><span>当前摘要</span><code>{{ shortHash(document.sha256, 14) }}</code></div>
      <button class="button button--secondary" type="button" :disabled="loading || saving || restoring !== null" @click="load"><RefreshCw :size="16" :class="{ spin: loading }" />重新读取</button>
    </div>
    <div class="config-layout">
      <section class="editor-panel">
        <header class="editor-toolbar">
          <div><strong>pipeline.json</strong><span v-if="changed" class="unsaved-dot">未保存</span></div>
          <div class="editor-toolbar__actions">
            <input ref="fileInput" class="visually-hidden" type="file" accept=".json,application/json" @change="importFile">
            <button class="icon-button" type="button" title="导入 JSON" :disabled="loading || saving" @click="fileInput?.click()"><FileUp :size="16" /></button>
            <button class="icon-button" type="button" title="下载 JSON" :disabled="loading" @click="downloadJson"><Download :size="16" /></button>
            <button class="button button--secondary" type="button" :disabled="loading || validating || saving || restoring !== null" @click="validate"><ShieldCheck :size="16" />{{ validating ? '校验中' : '校验' }}</button>
            <button class="button button--primary" type="button" :disabled="loading || validating || saving || restoring !== null || !changed" @click="save"><Save :size="16" />{{ saving ? '应用中' : '保存并热加载' }}</button>
          </div>
        </header>

        <nav class="config-mode-tabs" role="tablist" aria-label="配置编辑模式">
          <button type="button" role="tab" :aria-selected="mode === 'structured'" :class="{ active: mode === 'structured' }" @click="activateMode('structured')"><Settings2 :size="15" />表单</button>
          <button type="button" role="tab" :aria-selected="mode === 'json'" :class="{ active: mode === 'json' }" @click="activateMode('json')"><Braces :size="15" />JSON</button>
          <button type="button" role="tab" :aria-selected="mode === 'flow'" :class="{ active: mode === 'flow' }" @click="activateMode('flow')"><Workflow :size="15" />流程</button>
        </nav>

        <div v-if="loading" class="editor-loading">正在读取配置…</div>
        <StructuredConfigEditor v-else-if="mode === 'structured' && config" v-model="config" @notice="toast.info($event)" />
        <JsonEditor v-else-if="mode === 'json'" v-model="source" />
        <ConfigFlowPreview v-else-if="config" :config="config" />

        <footer class="editor-footer">
          <div class="validation-state">
            <TriangleAlert v-if="parseError" :size="16" /><Check v-else-if="validation?.valid" :size="16" /><Clock3 v-else :size="16" />
            <span :class="{ 'text-danger': parseError }">{{ parseError || (validation?.valid ? `KixDNS 校验通过 · ${validation.pipeline_count} Pipeline / ${validation.rule_count} 规则` : '保存前将调用 KixDNS 内部编译器校验') }}</span>
          </div>
          <input v-model="message" aria-label="版本说明" maxlength="160" placeholder="版本说明（可选）">
        </footer>
      </section>

      <aside class="history-panel">
        <header><div><History :size="18" /><h2>版本历史</h2></div><span>{{ versions.length }}</span></header>
        <div class="history-list">
          <article v-for="version in versions" :key="version.id" :class="{ 'history-item--current': version.sha256 === document?.sha256 }">
            <div class="history-item__top"><strong>#{{ version.id }}</strong><span v-if="version.sha256 === document?.sha256" class="tag tag--success">当前</span><button v-else class="icon-button icon-button--small" type="button" title="恢复此版本" :disabled="restoring !== null || saving || validating" @click="restore(version)"><RotateCcw :size="15" :class="{ spin: restoring === version.id }" /></button></div>
            <p>{{ version.message || '未填写版本说明' }}</p>
            <code>{{ shortHash(version.sha256, 12) }}</code>
            <small>{{ version.actor }} · {{ formatDate(version.created_at) }}</small>
          </article>
          <p v-if="versions.length === 0" class="empty-state">暂无配置版本</p>
        </div>
      </aside>
    </div>
  </div>
</template>
