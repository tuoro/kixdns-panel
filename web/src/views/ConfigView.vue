<script setup lang="ts">
import { Check, Clock3, History, RefreshCw, RotateCcw, Save, ShieldCheck, TriangleAlert } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import { apiRequest, jsonBody } from '../api/client'
import type { ConfigApplyResult, ConfigDocument, ConfigVersion, ConfigVersions, ValidationResult } from '../api/types'
import JsonEditor from '../components/JsonEditor.vue'
import { useToast } from '../composables/useToast'
import { errorMessage, formatDate, shortHash } from '../utils'

const document = ref<ConfigDocument | null>(null)
const versions = ref<ConfigVersion[]>([])
const source = ref('')
const baseline = ref('')
const message = ref('')
const loading = ref(true)
const validating = ref(false)
const saving = ref(false)
const restoring = ref<number | null>(null)
const validation = ref<ValidationResult | null>(null)
const parseError = ref('')
const toast = useToast()
const changed = computed(() => source.value !== baseline.value)

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

async function load(): Promise<void> {
  loading.value = true
  try {
    const [nextDocument, history] = await Promise.all([
      apiRequest<ConfigDocument>('/api/v1/config'),
      apiRequest<ConfigVersions>('/api/v1/config/versions'),
    ])
    document.value = nextDocument
    versions.value = history.versions
    source.value = JSON.stringify(nextDocument.content, null, 2)
    baseline.value = source.value
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
    toast.success(`配置通过校验：${validation.value.pipeline_count} 条 Pipeline，${validation.value.rule_count} 条规则`)
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

onMounted(load)
</script>

<template>
  <div class="page config-page">
    <div class="page-actions">
      <div v-if="document" class="document-meta"><span class="status-dot"></span><span>当前摘要</span><code>{{ shortHash(document.sha256, 14) }}</code></div>
      <button class="button button--secondary" type="button" :disabled="loading" @click="load"><RefreshCw :size="16" :class="{ spin: loading }" />重新读取</button>
    </div>
    <div class="config-layout">
      <section class="editor-panel">
        <header class="editor-toolbar">
          <div><strong>pipeline.json</strong><span v-if="changed" class="unsaved-dot">未保存</span></div>
          <div>
            <button class="button button--secondary" type="button" :disabled="loading || validating" @click="validate"><ShieldCheck :size="16" />{{ validating ? '校验中' : '校验' }}</button>
            <button class="button button--primary" type="button" :disabled="loading || saving || !changed" @click="save"><Save :size="16" />{{ saving ? '应用中' : '保存并热加载' }}</button>
          </div>
        </header>
        <div v-if="loading" class="editor-loading">正在读取配置…</div>
        <JsonEditor v-else v-model="source" />
        <footer class="editor-footer">
          <div class="validation-state">
            <TriangleAlert v-if="parseError" :size="16" /><Check v-else-if="validation?.valid" :size="16" /><Clock3 v-else :size="16" />
            <span :class="{ 'text-danger': parseError }">{{ parseError || (validation?.valid ? `KixDNS 校验通过 · ${validation.pipeline_count} Pipeline / ${validation.rule_count} 规则` : '保存前将调用 KixDNS 内部编译器校验') }}</span>
          </div>
          <input v-model="message" aria-label="版本说明" maxlength="160" placeholder="版本说明（可选）" />
        </footer>
      </section>

      <aside class="history-panel">
        <header><div><History :size="18" /><h2>版本历史</h2></div><span>{{ versions.length }}</span></header>
        <div class="history-list">
          <article v-for="version in versions" :key="version.id" :class="{ 'history-item--current': version.sha256 === document?.sha256 }">
            <div class="history-item__top"><strong>#{{ version.id }}</strong><span v-if="version.sha256 === document?.sha256" class="tag tag--success">当前</span><button v-else class="icon-button icon-button--small" type="button" title="恢复此版本" :disabled="restoring !== null" @click="restore(version)"><RotateCcw :size="15" :class="{ spin: restoring === version.id }" /></button></div>
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
