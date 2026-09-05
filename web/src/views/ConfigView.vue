<script setup lang="ts">
import {
  ArrowLeft,
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
  X,
  Zap,
} from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
import DnsSolutionEditor from '../components/config/DnsSolutionEditor.vue'
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
const section = ref<'pipeline' | 'mapping' | 'settings'>('pipeline')
const manualMode = ref(false)
const localDraftDirty = ref(false)
const focusedEditing = ref(false)
const workspaceKey = ref(0)
const solutionEditor = ref<InstanceType<typeof DnsSolutionEditor> | null>(null)
const historyOpen = ref(false)
const historyDialog = ref<HTMLDialogElement | null>(null)
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
const canSave = computed(() => !localDraftDirty.value && (changed.value || canApplyPending.value))
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

watch(historyOpen, async (open) => {
  if (!open) return
  await nextTick()
  historyDialog.value?.showModal()
})

watch(config, (value) => {
  if (!value || syncingConfig) return
  source.value = serializeConfig(value)
}, { deep: true, flush: 'sync' })

function confirmDiscard(): boolean {
  return (!changed.value && !localDraftDirty.value) || window.confirm('当前配置或入口修改尚未保存，确定放弃？')
}

function preventAccidentalClose(event: BeforeUnloadEvent): void {
  if (!changed.value && !localDraftDirty.value) return
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
  if (!confirmLocalDiscard()) return
  if (mode.value === 'json' && nextMode !== 'json' && !syncStructuredFromSource()) {
    toast.error('JSON 解析失败，修正后才能切换视图')
    return
  }
  mode.value = nextMode
  resetLocalState()
}

function confirmLocalDiscard(): boolean {
  return solutionEditor.value?.confirmDiscard() ?? true
}

function resetLocalState(): void {
  localDraftDirty.value = false
  focusedEditing.value = false
  workspaceKey.value += 1
}

function activateSection(nextSection: typeof section.value): void {
  if (section.value === nextSection && mode.value === 'structured') return
  if (!confirmLocalDiscard()) return
  if (mode.value === 'json' && !syncStructuredFromSource()) {
    toast.error('JSON 解析失败，修正后才能切换分类')
    return
  }
  resetLocalState()
  section.value = nextSection
  mode.value = 'structured'
  manualMode.value = false
}

function openManual(): void {
  manualMode.value = true
  resetLocalState()
}

function reload(): void {
  if (confirmDiscard()) void load()
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
    resetLocalState()
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
  const unsavedWarning = changed.value || localDraftDirty.value ? '\n\n编辑器中未保存的修改会丢失。' : ''
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
    historyOpen.value = false
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
    if (!confirmDiscard()) return
    if (file.size > 4 * 1024 * 1024) throw new Error('配置文件不能超过 4 MiB')
    source.value = await file.text()
    if (!syncStructuredFromSource()) {
      mode.value = 'json'
      throw new Error(parseError.value || 'JSON 解析失败')
    }
    mode.value = 'structured'
    resetLocalState()
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
  <div class="page config-page workbench-page" :class="{ 'workbench-page--editing': focusedEditing }">
    <header class="workbench-heading" :inert="focusedEditing">
      <div class="workbench-heading-main"><h1 class="page-heading">配置</h1>
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
      <span v-if="localDraftDirty" class="workbench-draft-state">入口待应用到草稿</span><span v-else-if="changed" class="unsaved-dot workbench-draft-state">草稿有修改</span>
      </div>
      <div class="workbench-heading-actions">
        <button class="button button--secondary" type="button" @click="historyOpen = true"><History :size="16" />历史版本</button>
        <div class="workbench-global-actions">
          <span class="workbench-save-hint">{{ localDraftDirty ? '先将入口修改应用到草稿' : changed ? '草稿尚未保存' : runtimeLabel }}</span>
          <button class="button button--secondary" type="button" :disabled="loading || validating || saving || restoring !== null || deleting !== null || bulkDeleting || deferSave || localDraftDirty" @click="validate"><ShieldCheck :size="16" />{{ validating ? '校验中' : (deferSave ? '运行后校验' : '校验') }}</button>
          <button class="button button--primary" type="button" :disabled="loading || validating || saving || restoring !== null || deleting !== null || bulkDeleting || !canSave" @click="save"><Save :size="16" />{{ saveLabel }}</button>
        </div>
      </div>
    </header>
    <StatusBanner v-if="loadError" :message="loadError" :stale="Boolean(document)" :busy="loading" @retry="reload" />
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
    <div class="workbench-navigation" :inert="focusedEditing">
      <nav class="workbench-section-tabs" aria-label="配置分类">
        <button type="button" :aria-pressed="section === 'pipeline'" :class="{ active: section === 'pipeline' }" @click="activateSection('pipeline')">解析编排</button>
        <button type="button" :aria-pressed="section === 'mapping'" :class="{ active: section === 'mapping' }" @click="activateSection('mapping')">域名映射</button>
        <button type="button" :aria-pressed="section === 'settings'" :class="{ active: section === 'settings' }" @click="activateSection('settings')">基础设置</button>
      </nav>
      <div class="workbench-view-tools">
        <nav class="workbench-mode-tabs" role="tablist" aria-label="配置编辑模式">
          <button v-if="mode !== 'structured'" type="button" role="tab" :aria-selected="false" @click="activateMode('structured')"><Settings2 :size="15" />表单</button>
          <button type="button" role="tab" :aria-selected="mode === 'json'" :class="{ active: mode === 'json' }" @click="activateMode('json')"><Braces :size="15" />JSON</button>
          <button v-if="section === 'pipeline'" type="button" role="tab" :aria-selected="mode === 'flow'" :class="{ active: mode === 'flow' }" @click="activateMode('flow')"><Workflow :size="15" />流程</button>
        </nav>
        <input ref="fileInput" class="visually-hidden" type="file" accept=".json,application/json" @change="importFile">
        <button class="icon-button" type="button" title="导入 JSON" :disabled="loading || saving" @click="fileInput?.click()"><FileUp :size="16" /></button>
        <button class="icon-button" type="button" title="下载 JSON" :disabled="loading" @click="downloadJson"><Download :size="16" /></button>
        <button class="icon-button" type="button" title="重新读取配置" :disabled="loading || saving || restoring !== null || deleting !== null || bulkDeleting" @click="reload"><RefreshCw :size="16" :class="{ spin: loading }" /></button>
      </div>
    </div>
    <div class="workbench-document">
      <section class="editor-panel workbench-document-panel">
        <header v-if="section === 'mapping' && mode === 'structured'" class="workbench-mapping-heading"><div><strong>域名映射</strong><span class="mapping-priority"><Zap :size="12" />最高优先级</span></div><p>命中后直接应答并跳过其他 Pipeline</p></header>
        <header v-else-if="section === 'settings' && mode === 'structured'" class="workbench-settings-heading"><strong>基础设置</strong><p>监听服务、上游、缓存与 Geo 数据；修改将加入同一份配置草稿。</p></header>
        <div v-if="section === 'pipeline' && mode === 'structured' && manualMode" class="workbench-manual-bar"><button class="button button--secondary" type="button" @click="manualMode = false"><ArrowLeft :size="15" />返回解析编排</button><span>自由编辑 · 保留完整 Pipeline 与规则结构</span></div>

        <div v-if="loading" class="editor-loading">正在读取配置…</div>
        <div v-else-if="!document" class="editor-loading">配置暂不可用</div>
        <JsonEditor v-else-if="mode === 'json'" v-model="source" />
        <ConfigFlowPreview v-else-if="mode === 'flow' && config" :config="config" />
        <DomainMappingConfigEditor v-else-if="section === 'mapping' && config" v-model="config" :capabilities="runtimeCapabilities" />
        <StructuredConfigEditor v-else-if="config && (section === 'settings' || manualMode)" v-model="config" :section="section === 'settings' ? 'settings' : 'pipeline'" :capabilities="runtimeCapabilities" @notice="toast.info($event)" />
        <DnsSolutionEditor v-else-if="config" :key="workspaceKey" ref="solutionEditor" v-model="config" :capabilities="runtimeCapabilities" @manual="openManual" @mapping="activateSection('mapping')" @notice="toast.info($event)" @dirty="localDraftDirty = $event" @editing="focusedEditing = $event" />

        <footer class="editor-footer" :inert="focusedEditing">
          <div class="validation-state">
            <TriangleAlert v-if="parseError" :size="16" /><Check v-else-if="validation?.valid" :size="16" /><Clock3 v-else :size="16" />
            <span :class="{ 'text-danger': parseError }">{{ validationLabel }}</span>
          </div>
          <input v-model="message" aria-label="版本备注" maxlength="160" placeholder="版本备注（可选）">
        </footer>
      </section>

    </div>

      <dialog v-if="historyOpen" ref="historyDialog" class="workbench-history-overlay" aria-labelledby="workbench-history-title" @click.self="historyOpen = false" @cancel.prevent="historyOpen = false">
      <aside class="history-panel workbench-history">
        <header><div><History :size="18" /><h2 id="workbench-history-title">版本历史</h2></div><span title="自动保留最近 100 个版本">{{ versions.length }} / 100</span><button class="icon-button" type="button" aria-label="关闭版本历史" @click="historyOpen = false"><X :size="18" /></button></header>
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
      </dialog>
    <ConfigVersionDiffDialog v-if="previewVersion && document" :current="document.content" :version="previewVersion" @close="previewVersion = null" />
  </div>
</template>

<style scoped>
.workbench-page { gap: 0; }
.workbench-heading { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 0 0 23px; }
.workbench-heading-main, .workbench-heading-actions, .workbench-global-actions { display: flex; align-items: center; gap: 12px; }
.workbench-heading-main { flex-wrap: wrap; gap: 10px 18px; min-width: 0; }
.workbench-heading-main h1 { margin: 0; padding-right: 20px; border-right: 1px solid var(--line); font-size: 28px; line-height: 1; }
.workbench-heading-main .document-meta { min-width: 0; font-size: 12px; }
.workbench-heading-main .document-meta code { display: none; }
.workbench-draft-state { display: inline-flex; align-items: center; gap: 6px; color: #a96821; font-size: 12px; }
.workbench-draft-state::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.workbench-save-hint { display: none; }
.workbench-navigation { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; border: 1px solid var(--line); border-bottom: 0; background: var(--surface, #fff); }
.workbench-section-tabs { display: flex; gap: 8px; align-self: stretch; padding-left: 16px; }
.workbench-section-tabs button { display: flex; align-items: center; justify-content: center; min-height: 55px; padding: 0 16px; color: var(--muted); background: transparent; border: 0; border-bottom: 3px solid transparent; cursor: pointer; font-size: 14px; }
.workbench-section-tabs button.active { color: var(--ink); border-bottom-color: var(--green); font-weight: 700; }
.workbench-view-tools { display: flex; align-items: center; gap: 6px; padding-right: 12px; }
.workbench-mode-tabs { display: flex; gap: 5px; }
.workbench-mode-tabs button { display: flex; align-items: center; gap: 6px; min-height: 34px; padding: 7px 10px; color: var(--muted); border: 1px solid transparent; border-radius: 4px; background: transparent; font-size: 12px; cursor: pointer; }
.workbench-mode-tabs button.active { color: var(--ink); border-color: var(--line); background: var(--canvas, #f5f6f4); }
.workbench-document { display: block; min-width: 0; }
.workbench-document-panel { min-width: 0; border-radius: 0; }
.workbench-document-panel .editor-footer { min-height: 58px; gap: 12px; font-size: 12px; }
.workbench-document-panel .validation-state { font-size: 12px; line-height: 1.5; }
.workbench-document-panel .editor-footer > input { font-size: 12px; }
.workbench-mapping-heading, .workbench-settings-heading { display: grid; gap: 9px; padding: 23px 24px; border-bottom: 1px solid var(--line); }
.workbench-mapping-heading > div { display: flex; align-items: center; gap: 12px; }
.workbench-mapping-heading strong, .workbench-settings-heading > strong { font-size: 18px; }
.workbench-mapping-heading p, .workbench-settings-heading p { color: var(--muted); font-size: 12px; line-height: 1.6; }
.workbench-manual-bar { display: flex; align-items: center; gap: 15px; padding: 16px 20px; border-bottom: 1px solid var(--line); }
.workbench-manual-bar > span { color: var(--muted); font-size: 12px; }
.workbench-history-overlay { position: fixed; inset: 0; width: 100%; height: 100%; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; background: transparent; overflow: hidden; }
.workbench-history-overlay::backdrop { background: #08130d70; }
.workbench-history { position: absolute; top: 0; right: 0; bottom: 0; width: min(460px, 100%); display: flex; flex-direction: column; border: 0; border-radius: 0; background: var(--surface, #fff); }
.workbench-history > header { flex-shrink: 0; min-height: 70px; }
.workbench-history > header h2 { font-size: 18px; }
.workbench-history > header > span { margin-left: auto; }
.workbench-history .history-list { flex: 1; min-height: 0; max-height: none; overflow-y: auto; }
.workbench-history .history-item__top > strong { font-size: 14px; }
.workbench-history :is(small, .history-item__identity, .history-bulk-actions, .history-bulk-actions span) { font-size: 12px; }
@media (max-width: 1100px) {
  .workbench-heading { align-items: flex-start; }
  .workbench-heading-main { max-width: 58%; }
  .workbench-heading-actions { flex-wrap: wrap; justify-content: flex-end; }
}
@media (max-width: 860px) {
  .workbench-page { padding-bottom: 115px; }
  .workbench-heading { align-items: flex-start; gap: 12px; padding-bottom: 16px; }
  .workbench-heading-main { max-width: none; flex: 1; gap: 10px; }
  .workbench-heading-main h1 { flex: 1 1 100%; padding: 0; border: 0; font-size: 20px; }
  .workbench-heading-main .document-meta { flex-wrap: wrap; gap: 6px; font-size: 12px; }
  .workbench-heading-actions > button { padding-inline: 10px; font-size: 12px; }
  .workbench-heading-actions > button > svg { display: none; }
  .workbench-global-actions { position: fixed; z-index: 45; bottom: calc(64px + env(safe-area-inset-bottom)); left: 0; right: 0; display: grid; grid-template-columns: 1fr 2fr; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--line); background: var(--surface, #fff); }
  .workbench-save-hint { display: block; grid-column: 1 / -1; color: var(--muted); font-size: 12px; }
  .workbench-global-actions button { min-height: 44px; justify-content: center; }
  .workbench-page--editing .workbench-global-actions { display: none; }
  .workbench-navigation { gap: 0; }
  .workbench-section-tabs { width: 100%; padding: 0 8px; gap: 0; }
  .workbench-section-tabs > button { flex: 1; min-height: 48px; padding: 0 10px; font-size: 14px; }
  .workbench-view-tools { width: 100%; justify-content: flex-end; gap: 4px; padding: 5px 10px; border-top: 1px solid var(--line); }
  .workbench-mode-tabs { margin-right: auto; }
  .workbench-mode-tabs button { min-height: 44px; }
  .workbench-document-panel .editor-footer { padding: 14px 16px; }
  .workbench-manual-bar { flex-wrap: wrap; padding: 12px 16px; }
  .workbench-mapping-heading, .workbench-settings-heading { padding: 18px 16px; }
  .workbench-history { padding-bottom: env(safe-area-inset-bottom); }
}
</style>
