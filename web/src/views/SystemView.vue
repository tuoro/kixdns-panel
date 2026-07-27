<script setup lang="ts">
import { CircleCheck, ExternalLink, GitCommitHorizontal, Play, RefreshCw, RotateCw, ServerCog, Square, UploadCloud } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { apiRequest } from '../api/client'
import type { ServiceAction, ServiceStatus, UpdateInfo } from '../api/types'
import { useToast } from '../composables/useToast'
import { errorMessage, shortHash } from '../utils'

const service = ref<ServiceStatus | null>(null)
const update = ref<UpdateInfo | null>(null)
const loadingService = ref(true)
const checking = ref(true)
const serviceAction = ref<ServiceAction | null>(null)
const applying = ref(false)
const toast = useToast()
const running = computed(() => service.value?.active_state === 'active')

async function loadService(): Promise<void> {
  loadingService.value = true
  try {
    service.value = await apiRequest<ServiceStatus>('/api/v1/service')
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    loadingService.value = false
  }
}

async function control(action: ServiceAction): Promise<void> {
  const names: Record<ServiceAction, string> = { start: '启动', stop: '停止', restart: '重启' }
  if ((action === 'stop' || action === 'restart') && !window.confirm(`${names[action]} KixDNS 服务？`)) return
  serviceAction.value = action
  try {
    service.value = await apiRequest<ServiceStatus>(`/api/v1/service/${action}`, { method: 'POST' })
    toast.success(`KixDNS 服务已${names[action]}`)
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    serviceAction.value = null
  }
}

async function checkUpdate(): Promise<void> {
  checking.value = true
  try {
    update.value = await apiRequest<UpdateInfo>('/api/v1/updates')
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    checking.value = false
  }
}

async function applyUpdate(): Promise<void> {
  if (!update.value?.available || !window.confirm('安装已校验的增强构建？服务会短暂重启，失败时自动回滚。')) return
  applying.value = true
  try {
    update.value = await apiRequest<UpdateInfo>('/api/v1/updates/apply', { method: 'POST' })
    toast.success('增强构建已安装并通过健康检查')
    await loadService()
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    applying.value = false
  }
}

onMounted(() => Promise.all([loadService(), checkUpdate()]))
</script>

<template>
  <div class="page system-page">
    <div class="system-layout">
      <section class="panel service-panel">
        <header class="panel__header"><div><h2>宿主机服务</h2><p>固定 systemd unit 控制</p></div><ServerCog :size="20" /></header>
        <div v-if="loadingService" class="inline-loading">读取服务状态…</div>
        <template v-else-if="service">
          <div class="service-state"><span :class="running ? 'service-state__icon' : 'service-state__icon service-state__icon--stopped'"><CircleCheck :size="24" /></span><div><small>{{ service.unit }}</small><strong>{{ running ? '正在运行' : '已停止' }}</strong><p>{{ service.active_state }} / {{ service.sub_state }} · PID {{ service.main_pid || '—' }}</p></div></div>
          <div class="service-actions">
            <button class="button button--secondary" type="button" :disabled="running || serviceAction !== null" @click="control('start')"><Play :size="16" />启动</button>
            <button class="button button--secondary" type="button" :disabled="!running || serviceAction !== null" @click="control('restart')"><RotateCw :size="16" :class="{ spin: serviceAction === 'restart' }" />重启</button>
            <button class="button button--danger-quiet" type="button" :disabled="!running || serviceAction !== null" @click="control('stop')"><Square :size="15" />停止</button>
          </div>
        </template>
      </section>

      <section class="panel update-panel">
        <header class="panel__header"><div><h2>增强构建更新</h2><p>GitHub Action + nightly.link</p></div><button class="icon-button" type="button" title="检查更新" :disabled="checking" @click="checkUpdate"><RefreshCw :size="18" :class="{ spin: checking }" /></button></header>
        <div v-if="checking && !update" class="inline-loading">正在检查最近成功构建…</div>
        <template v-else-if="update">
          <div class="update-state" :class="{ 'update-state--available': update.available }"><span><UploadCloud v-if="update.available" :size="22" /><CircleCheck v-else :size="22" /></span><div><strong>{{ update.available ? '有可用构建' : '已是最新构建' }}</strong><p>{{ update.available ? '安装前将验证 Artifact 与包内二进制摘要' : '当前二进制与最近成功 Action 一致' }}</p></div></div>
          <dl class="detail-list update-details">
            <div><dt>已安装</dt><dd class="mono">{{ shortHash(update.installed_commit, 12) }}</dd></div>
            <div><dt>最近成功</dt><dd class="mono">{{ shortHash(update.latest_commit, 12) }}</dd></div>
            <div><dt>Action Run</dt><dd><a :href="update.run_url" target="_blank" rel="noopener noreferrer">#{{ update.run_id }}<ExternalLink :size="13" /></a></dd></div>
            <div><dt>Artifact</dt><dd>{{ update.artifact }}</dd></div>
            <div><dt>摘要</dt><dd class="mono">{{ shortHash(update.artifact_digest.replace('sha256:', ''), 14) }}</dd></div>
          </dl>
          <button class="button button--primary button--full" type="button" :disabled="!update.available || applying" @click="applyUpdate"><GitCommitHorizontal :size="17" />{{ applying ? '校验并安装中' : update.available ? '安装增强构建' : '无需更新' }}</button>
        </template>
      </section>
    </div>

    <section class="security-grid">
      <article><span>01</span><div><strong>来源固定</strong><p>仓库、工作流、分支和 Artifact 由启动参数锁定。</p></div></article>
      <article><span>02</span><div><strong>双重摘要</strong><p>校验 GitHub digest 与包内 SHA256SUMS。</p></div></article>
      <article><span>03</span><div><strong>失败回滚</strong><p>启动或健康检查失败时恢复上一二进制。</p></div></article>
    </section>
  </div>
</template>
