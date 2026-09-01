<script setup lang="ts">
import {
  Braces,
  Check,
  Clock3,
  Download,
  FileUp,
  GitCompare,
  History,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Workflow,
  Zap,
} from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { ApiError, apiRequest, jsonBody } from '../api/client'
import type {
  ConfigApplyResult,
  ConfigDocument,
  ConfigVersion,
  ConfigVersionDetail,
  ConfigVersions,
  ConfigRuntimeApplyState,
  DeleteConfigVersionResult,
  DeleteConfigVersionsResult,
  Overview,
  ServiceStatus,
  ValidationResult,
} from '../api/types'
import ConfigFlowPreview from '../components/config/ConfigFlowPreview.vue'
import DomainMappingConfigEditor from '../components/config/DomainMappingConfigEditor.vue'
import ConfigVersionDiffDialog from '../components/config/ConfigVersionDiffDialog.vue'
import StructuredConfigEditor from '../components/config/StructuredConfigEditor.vue'
import JsonEditor from '../components/JsonEditor.vue'
import StatusBanner from '../components/StatusBanner.vue'
import { normalizeConfig, promoteDomainMappingSelectors, serializeConfig } from '../config-editor/model'
import { SETTING_SECTIONS, settingSupported } from '../config-editor/schema'
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
const section = ref<'pipeline' | 'mapping'>('pipeline')
const fileInput = ref<HTMLInputElement | null>(null)
const loading = ref(true)
const validating = ref(false)
const saving = ref(false)
const restoring = ref<number | null>(null)
const deleting = ref<number | null>(null)
const bulkDeleting = ref(false)
const selectedVersionIds = ref<number[]>([])
const previewing = ref<number | null>(null)
const previewVersion = ref<ConfigVersionDetail | null>(null)
const validation = ref<ValidationResult | null>(null)
const parseError = ref('')
const loadError = ref('')
const capabilityError = ref('')
const runtimeStopped = ref(false)
const runtimeCapabilities = ref<string[]>([])
const toast = useToast()
const changed = computed(() => source.value !== baseline.value)
const runtimeApplyState = computed<ConfigRuntimeApplyState | undefined>(() => document.value?.runtime.apply_state)
const hasApplyFailure = computed(() => runtimeApplyState.value === 'failed'
  || document.value?.runtime.status === 'failed'
  || Boolean(document.value?.runtime.pending_error)
  || Boolean(document.value?.pending?.error))
const hasPending = computed(() => !hasApplyFailure.value
  && (runtimeApplyState.value === 'pending'
    || document.value?.runtime.status === 'pending'
    || Boolean(document.value?.pending)))
const pendingVersionId = computed(() => document.value?.pending?.version_id
  ?? (runtimeApplyState.value === 'pending' ? document.value?.version_id : null)
  ?? null)
const currentVersionId = computed(() => {
  const activeSha = document.value?.runtime.active_sha256
  const applied = versions.value.find((version) => version.apply_state === 'applied'
    && (!activeSha || version.sha256 === activeSha))
  if (applied) return applied.id
  if (hasPending.value || hasApplyFailure.value) return null
  return document.value?.version_id ?? null
})
const deletableVersionIds = computed(() => versions.value
  .filter((version) => version.id !== currentVersionId.value)
  .map((version) => version.id))
const allDeletableVersionsSelected = computed(() => deletableVersionIds.value.length > 0
  && deletableVersionIds.value.every((versionId) => selectedVersionIds.value.includes(versionId)))
const runtimeLabel = computed(() => {
  if (runtimeApplyState.value === 'pending' || hasPending.value || document.value?.runtime.status === 'pending') return '配置待应用'
  if (runtimeApplyState.value === 'failed' || document.value?.runtime.status === 'failed' || hasApplyFailure.value) return '配置应用失败'
  if (document.value?.runtime.status === 'active') return `运行中 · 代次 #${document.value.runtime.generation}`
  if (document.value?.runtime.status === 'different') return '文件与运行配置不同'
  if (runtimeStopped.value) return 'KixDNS 未启动'
  return '运行状态不可用'
})
const runtimeUnavailable = computed(() => document.value?.runtime.status === 'unavailable'
  && !runtimeStopped.value)
const unsupportedFields = computed(() => {
  const settings = config.value?.settings
  if (!settings) return []
  return SETTING_SECTIONS
    .flatMap((section) => section.fields)
    .filter((field) => Object.prototype.hasOwnProperty.call(settings, field.key)
      && !settingSupported(field, runtimeCapabilities.value))
    .map((field) => field.label)
})
const deferSave = computed(() => runtimeStopped.value
  || runtimeUnavailable.value
  || Boolean(capabilityError.value)
  || unsupportedFields.value.length > 0)
const canApplyPending = computed(() => (hasPending.value || hasApplyFailure.value) && !deferSave.value)
const canSave = computed(() => changed.value || canApplyPending.value)
const saveLabel = computed(() => {
  if (saving.value) return canApplyPending.value ? '应用中' : (deferSave.value ? '保存中' : '应用中')
  if (hasApplyFailure.value && canApplyPending.value && !changed.value) return '重试应用'
  if (canApplyPending.value && !changed.value) return '应用待应用'
  if (deferSave.value) return '保存为待应用'
  return '保存并热加载'
})
const validationLabel = computed(() => {
  if (parseError.value) return parseError.value
  if (hasPending.value) return '配置已保存为待应用版本，启动兼容的 KixDNS 后可继续应用'
  if (validation.value?.valid) {
    return `KixDNS 校验通过 · ${validation.value.pipeline_count} Pipeline / ${validation.value.rule_count} 规则`
  }
  if (deferSave.value) return 'KixDNS 当前未运行或无法确认能力，保存后将在运行时校验并应用'
  return '保存前将调用 KixDNS 内部编译器校验'
})
let syncingConfig = false
let pendingLoad: Promise<void> | null = null

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

function friendlyRuntimeError(error: unknown): string {
  return friendlyRuntimeMessage(errorMessage(error))
}

function friendlyRuntimeMessage(message: string): string {
  if (/No such file|os error 2|控制接口.*不可用|控制接口.*未启动/i.test(message)) {
    return 'KixDNS 未启动，配置将保存为待应用版本'
  }
  return message
}

function applyResultState(result: ConfigApplyResult): 'applied' | 'pending' {
  if (result.apply_state === 'pending' || !result.active_config) return 'pending'
  return 'applied'
}

function shouldRefreshAfterSaveError(error: unknown): boolean {
  return error instanceof ApiError
    && ['unsupported_config_fields', 'config_validation_failed', 'reload_failed', 'kixdns_rejected'].includes(error.code)
}

function parseSource(): Record<string, unknown> | null {
  parseError.value = ''
  try {
    const value: unknown = JSON.parse(source.value)
    if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error('配置根节点必须是 JSON 对象')
    promoteDomainMappingSelectors(value as Record<string, unknown>)
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

function load(): Promise<void> {
  if (pendingLoad) return pendingLoad
  loading.value = true
  pendingLoad = (async () => {
    const [nextDocument, history, overview, service] = await Promise.all([
      apiRequest<ConfigDocument>('/api/v1/config'),
      apiRequest<ConfigVersions>('/api/v1/config/versions'),
      apiRequest<Overview>('/api/v1/overview').catch((error: unknown) => {
        capabilityError.value = friendlyRuntimeError(error)
        return null
      }),
      apiRequest<ServiceStatus>('/api/v1/service').catch(() => null),
    ])
    const declaredCapabilities = nextDocument.runtime.declared_capabilities ?? []
    if (overview) {
      runtimeStopped.value = !overview.live
        && (service?.active_state === 'inactive' || overview.service_active === false)
      runtimeCapabilities.value = overview.live ? overview.health.capabilities : declaredCapabilities
      capabilityError.value = overview.live || declaredCapabilities.length > 0 ? '' : 'KixDNS 实时能力暂不可用'
    } else {
      runtimeStopped.value = service?.active_state === 'inactive'
      runtimeCapabilities.value = declaredCapabilities
      if (!runtimeStopped.value && !capabilityError.value && declaredCapabilities.length === 0) {
        capabilityError.value = 'KixDNS 实时能力暂不可用'
      }
    }
    document.value = nextDocument
    versions.value = history.versions
    selectedVersionIds.value = []
    syncingConfig = true
    config.value = normalizeConfig(nextDocument.content)
    source.value = serializeConfig(config.value)
    baseline.value = source.value
    syncingConfig = false
    validation.value = null
    previewVersion.value = null
    loadError.value = ''
  })().catch((error: unknown) => {
    loadError.value = errorMessage(error)
  }).finally(() => {
    loading.value = false
    pendingLoad = null
  })
  return pendingLoad
}

async function validate(): Promise<ValidationResult | null> {
  const content = parseSource()
  if (!content) return null
  if (deferSave.value) {
    toast.info('KixDNS 当前未启动或无法确认能力，保存后将作为待应用版本保留')
    return null
  }
  validating.value = true
  try {
    validation.value = await apiRequest<ValidationResult>('/api/v1/config/validate', {
      method: 'POST',
      ...jsonBody(content),
    })
    toast.success(`配置通过校验，${validation.value.pipeline_count} 条 Pipeline，${validation.value.rule_count} 条规则`)
    return validation.value
  } catch (error) {
    toast.error(friendlyRuntimeError(error))
    return null
  } finally {
    validating.value = false
  }
}

async function save(): Promise<void> {
  if (!document.value || !canSave.value) return
  const content = parseSource()
  if (!content) return
  saving.value = true
  try {
    const result = await apiRequest<ConfigApplyResult>('/api/v1/config', {
      method: 'PUT',
      ...jsonBody({ content, expected_sha256: document.value.sha256, message: message.value.trim() }),
    })
    validation.value = result.validation ?? null
    if (applyResultState(result) === 'pending') {
      toast.info('配置已保存为待应用版本，启动兼容的 KixDNS 后即可应用')
    } else {
      const generation = result.active_config?.generation
      toast.success(generation == null ? '配置已生效' : `配置已生效，运行时代次 #${generation}`)
    }
    message.value = ''
    await load()
  } catch (error) {
    toast.error(friendlyRuntimeError(error))
    if (shouldRefreshAfterSaveError(error)) await load()
  } finally {
    saving.value = false
  }
}

async function restore(version: ConfigVersion): Promise<void> {
  if (!document.value) return
  const unsavedWarning = changed.value ? '\n\n编辑器中未保存的修改会丢失。' : ''
  if (!window.confirm(`恢复配置版本 #${version.id}？${unsavedWarning}\n\n当前已保存配置仍会保留在历史记录中。`)) return
  restoring.value = version.id
  try {
    const result = await apiRequest<ConfigApplyResult>(`/api/v1/config/versions/${version.id}/restore`, {
      method: 'POST',
      ...jsonBody({ expected_sha256: document.value.sha256 }),
    })
    if (applyResultState(result) === 'pending') {
      toast.info(`版本 #${version.id} 已保存为待应用版本`)
    } else {
      toast.success(`版本 #${version.id} 已恢复，当前版本 #${result.version_id}`)
    }
    await load()
  } catch (error) {
    toast.error(friendlyRuntimeError(error))
  } finally {
    restoring.value = null
  }
}

async function deleteVersion(version: ConfigVersion): Promise<void> {
  if (!document.value) return
  if (version.id === currentVersionId.value) {
    toast.error('当前生效版本不能删除，请先恢复其他版本')
    return
  }
  if (!window.confirm(`删除配置版本 #${version.id}？此操作无法撤销。`)) return
  deleting.value = version.id
  try {
    const removesDesired = version.id === pendingVersionId.value
      || version.apply_state === 'pending'
      || version.apply_state === 'failed'
    await apiRequest<DeleteConfigVersionResult>(`/api/v1/config/versions/${version.id}`, {
      method: 'DELETE',
      ...jsonBody({ expected_sha256: document.value.sha256 }),
    })
    if (removesDesired) {
      await load()
    } else {
      const history = await apiRequest<ConfigVersions>('/api/v1/config/versions')
      versions.value = history.versions
      selectedVersionIds.value = selectedVersionIds.value.filter((versionId) => versionId !== version.id)
    }
    toast.success(`配置版本 #${version.id} 已删除`)
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    deleting.value = null
  }
}

function toggleVersionSelection(versionId: number): void {
  if (versionId === currentVersionId.value) return
  selectedVersionIds.value = selectedVersionIds.value.includes(versionId)
    ? selectedVersionIds.value.filter((selectedId) => selectedId !== versionId)
    : [...selectedVersionIds.value, versionId]
}

function toggleAllDeletableVersions(): void {
  selectedVersionIds.value = allDeletableVersionsSelected.value
    ? []
    : [...deletableVersionIds.value]
}

async function deleteSelectedVersions(): Promise<void> {
  if (!document.value || selectedVersionIds.value.length === 0) return
  const ids = [...selectedVersionIds.value]
  if (!window.confirm(`删除选中的 ${ids.length} 个配置版本？此操作无法撤销。`)) return
  bulkDeleting.value = true
  try {
    const removesDesired = versions.value.some((version) => ids.includes(version.id)
      && (version.id === pendingVersionId.value
        || version.apply_state === 'pending'
        || version.apply_state === 'failed'))
    const result = await apiRequest<DeleteConfigVersionsResult>('/api/v1/config/versions/bulk', {
      method: 'DELETE',
      ...jsonBody({ ids, expected_sha256: document.value.sha256 }),
    })
    selectedVersionIds.value = []
    if (removesDesired) {
      await load()
    } else {
      const history = await apiRequest<ConfigVersions>('/api/v1/config/versions')
      versions.value = history.versions
    }
    toast.success(`已删除 ${result.deleted_ids.length} 个配置版本`)
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    bulkDeleting.value = false
  }
}

async function openVersionDiff(version: ConfigVersion): Promise<void> {
  previewing.value = version.id
  try {
    previewVersion.value = await apiRequest<ConfigVersionDetail>(`/api/v1/config/versions/${version.id}`)
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    previewing.value = null
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
      <div v-if="document" class="document-meta" :title="document.runtime.active_sha256 ? `运行摘要 ${document.runtime.active_sha256}` : '无法读取 KixDNS 运行配置'">
        <span
          class="status-dot"
          :class="{
            'status-dot--danger': hasApplyFailure,
            'status-dot--warning': !hasApplyFailure && (hasPending || document.runtime.status === 'pending' || document.runtime.status === 'different'),
            'status-dot--muted': !hasApplyFailure && !hasPending && document.runtime.status === 'unavailable',
          }"
        ></span>
        <span>{{ runtimeLabel }}</span>
        <span v-if="pendingVersionId" class="document-meta__version">待应用 #{{ pendingVersionId }}</span>
        <span v-else-if="currentVersionId" class="document-meta__version">版本 #{{ currentVersionId }}</span>
        <code>{{ shortHash(document.sha256, 14) }}</code>
      </div>
      <button class="button button--secondary" type="button" :disabled="loading || saving || restoring !== null || deleting !== null || bulkDeleting" @click="load"><RefreshCw :size="16" :class="{ spin: loading }" />重新读取</button>
    </div>
    <StatusBanner v-if="loadError" :message="loadError" :stale="Boolean(document)" :busy="loading" @retry="load" />
    <div v-if="hasPending || hasApplyFailure || runtimeStopped || runtimeUnavailable || capabilityError || unsupportedFields.length" class="config-compatibility-banner">
      <TriangleAlert :size="18" />
      <div>
        <strong>
          {{
            hasPending
              ? '配置已保存，当前处于待应用状态'
              : (hasApplyFailure
                ? '配置应用失败，当前仍保留上一份生效配置'
                : (runtimeStopped
                  ? 'KixDNS 未启动，无法确认当前 KixDNS 配置能力'
                  : (runtimeUnavailable
                    ? '无法确认当前 KixDNS 的运行能力'
                    : (capabilityError ? '无法确认当前 KixDNS 的配置能力' : '配置包含当前版本不支持的字段'))))
          }}
        </strong>
        <p v-if="hasPending">编辑内容已经安全保存；启动声明相应能力的 KixDNS 后会自动应用，也可点击“应用待应用”立即重试。</p>
        <p v-else-if="hasApplyFailure">{{ friendlyRuntimeMessage(document?.runtime.pending_error || document?.pending?.error || '请检查 KixDNS 日志后重试。') }}</p>
        <p v-else-if="runtimeStopped">当前编辑内容会保存为待应用版本，启动 KixDNS 后可继续应用。</p>
        <p v-else-if="runtimeUnavailable">当前无法确认控制通道，编辑内容会保存为待应用版本，运行状态恢复后可继续应用。</p>
        <p v-else-if="capabilityError">受版本约束的已有字段已只读保留，能力恢复后可继续编辑。</p>
        <p v-else>已只读保留：{{ unsupportedFields.join('、') }}。切换兼容版本后可保存为待应用版本。</p>
      </div>
    </div>
    <nav class="config-section-tabs" aria-label="配置分类">
      <button type="button" :class="{ active: section === 'pipeline' }" @click="section = 'pipeline'">Pipeline 配置</button>
      <button type="button" :class="{ active: section === 'mapping' }" @click="section = 'mapping'">域名映射</button>
    </nav>
    <div class="config-layout">
      <section class="editor-panel">
        <header class="editor-toolbar">
          <div v-if="section === 'pipeline'"><strong>pipeline.json</strong><span v-if="changed" class="unsaved-dot">未保存</span></div>
          <div v-else class="mapping-toolbar-title">
            <div><strong>域名映射</strong><span class="mapping-priority"><Zap :size="12" />最高优先级</span><span v-if="changed" class="unsaved-dot">未保存</span></div>
            <small>命中后直接应答并跳过其他 Pipeline</small>
          </div>
          <div class="editor-toolbar__actions">
            <input ref="fileInput" class="visually-hidden" type="file" accept=".json,application/json" @change="importFile">
            <button v-if="section === 'pipeline'" class="icon-button" type="button" title="导入 JSON" :disabled="loading || saving" @click="fileInput?.click()"><FileUp :size="16" /></button>
            <button v-if="section === 'pipeline'" class="icon-button" type="button" title="下载 JSON" :disabled="loading" @click="downloadJson"><Download :size="16" /></button>
            <button class="button button--secondary" type="button" :disabled="loading || validating || saving || restoring !== null || deleting !== null || bulkDeleting || deferSave" @click="validate"><ShieldCheck :size="16" />{{ validating ? '校验中' : (deferSave ? '运行后校验' : '校验') }}</button>
            <button class="button button--primary" type="button" :disabled="loading || validating || saving || restoring !== null || deleting !== null || bulkDeleting || !canSave" @click="save"><Save :size="16" />{{ saveLabel }}</button>
          </div>
        </header>

        <nav v-if="section === 'pipeline'" class="config-mode-tabs" role="tablist" aria-label="配置编辑模式">
          <button type="button" role="tab" :aria-selected="mode === 'structured'" :class="{ active: mode === 'structured' }" @click="activateMode('structured')"><Settings2 :size="15" />表单</button>
          <button type="button" role="tab" :aria-selected="mode === 'json'" :class="{ active: mode === 'json' }" @click="activateMode('json')"><Braces :size="15" />JSON</button>
          <button type="button" role="tab" :aria-selected="mode === 'flow'" :class="{ active: mode === 'flow' }" @click="activateMode('flow')"><Workflow :size="15" />流程</button>
        </nav>

        <div v-if="loading" class="editor-loading">正在读取配置…</div>
        <div v-else-if="!document" class="editor-loading">配置暂不可用</div>
        <DomainMappingConfigEditor v-else-if="section === 'mapping' && config" v-model="config" :capabilities="runtimeCapabilities" />
        <StructuredConfigEditor v-else-if="mode === 'structured' && config" v-model="config" :capabilities="runtimeCapabilities" @notice="toast.info($event)" />
        <JsonEditor v-else-if="mode === 'json'" v-model="source" />
        <ConfigFlowPreview v-else-if="config" :config="config" />

        <footer class="editor-footer">
          <div class="validation-state">
            <TriangleAlert v-if="parseError" :size="16" /><Check v-else-if="validation?.valid" :size="16" /><Clock3 v-else :size="16" />
            <span :class="{ 'text-danger': parseError }">{{ validationLabel }}</span>
          </div>
          <input v-model="message" aria-label="版本备注" maxlength="160" placeholder="版本备注（可选）">
        </footer>
      </section>

      <aside class="history-panel">
        <header><div><History :size="18" /><h2>版本历史</h2></div><span title="自动保留最近 100 个版本">{{ versions.length }} / 100</span></header>
        <div v-if="deletableVersionIds.length > 0" class="history-bulk-actions">
          <label>
            <input type="checkbox" :checked="allDeletableVersionsSelected" :disabled="bulkDeleting || deleting !== null || restoring !== null || saving || validating" @change="toggleAllDeletableVersions">
            <span>{{ selectedVersionIds.length > 0 ? `已选 ${selectedVersionIds.length} 项` : '全选可删除项' }}</span>
          </label>
          <button class="button button--danger-quiet" type="button" :disabled="selectedVersionIds.length === 0 || bulkDeleting || deleting !== null || restoring !== null || saving || validating" @click="deleteSelectedVersions">
            <Trash2 :size="14" :class="{ spin: bulkDeleting }" />删除所选
          </button>
        </div>
        <div class="history-list">
          <article v-for="version in versions" :key="version.id" :class="{ 'history-item--current': version.id === currentVersionId, 'history-item--pending': version.id === pendingVersionId, 'history-item--failed': version.apply_state === 'failed' }">
            <div class="history-item__top">
              <input v-if="version.id !== currentVersionId" class="history-item__checkbox" type="checkbox" :aria-label="`选择配置版本 #${version.id}`" :checked="selectedVersionIds.includes(version.id)" :disabled="bulkDeleting || deleting !== null || restoring !== null || saving || validating" @change="toggleVersionSelection(version.id)">
              <strong :title="version.message || '未填写备注'">{{ version.message || '未填写备注' }}</strong>
              <div class="history-item__actions">
                <span v-if="version.id === currentVersionId" class="tag tag--success">当前</span>
                <span v-else-if="version.apply_state === 'failed'" class="tag tag--danger">失败</span>
                <span v-else-if="version.id === pendingVersionId || version.apply_state === 'pending'" class="tag tag--warning">待应用</span>
                <span v-else-if="version.apply_state === 'superseded'" class="tag tag--muted">已替代</span>
                <template v-if="version.id !== currentVersionId">
                  <button class="icon-button icon-button--small" type="button" title="比较此版本" :disabled="previewing !== null" @click="openVersionDiff(version)"><GitCompare :size="15" :class="{ spin: previewing === version.id }" /></button>
                  <button class="icon-button icon-button--small" type="button" title="恢复此版本" :disabled="restoring !== null || deleting !== null || bulkDeleting || saving || validating" @click="restore(version)"><RotateCcw :size="15" :class="{ spin: restoring === version.id }" /></button>
                  <button class="icon-button icon-button--small icon-button--danger" type="button" title="删除此版本" :disabled="restoring !== null || deleting !== null || bulkDeleting || saving || validating" @click="deleteVersion(version)"><Trash2 :size="15" :class="{ spin: deleting === version.id }" /></button>
                </template>
              </div>
            </div>
            <div class="history-item__identity"><span>#{{ version.id }}</span><code>{{ shortHash(version.sha256, 12) }}</code></div>
            <small>{{ version.actor }} · {{ formatDate(version.created_at) }}</small>
            <small v-if="version.apply_error" class="history-item__error">{{ friendlyRuntimeMessage(version.apply_error) }}</small>
          </article>
          <p v-if="versions.length === 0" class="empty-state">暂无配置版本</p>
        </div>
      </aside>
    </div>
    <ConfigVersionDiffDialog v-if="previewVersion && document" :current="document.content" :version="previewVersion" @close="previewVersion = null" />
  </div>
</template>
