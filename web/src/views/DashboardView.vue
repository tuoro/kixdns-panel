<script setup lang="ts">
import { Activity, Database, Eraser, RefreshCw, Timer, Zap } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { apiRequest } from '../api/client'
import type { CacheFlushResult, Overview, ServiceStatus } from '../api/types'
import { useToast } from '../composables/useToast'
import { errorMessage, formatDuration, formatNumber, formatPercent, shortHash } from '../utils'

const overview = ref<Overview | null>(null)
const service = ref<ServiceStatus | null>(null)
const loading = ref(true)
const refreshing = ref(false)
const flushing = ref(false)
const toast = useToast()
let timer: number | undefined

const cacheHitRate = computed(() => {
  const metrics = overview.value?.metrics
  if (!metrics?.cache_lookups_total) return 0
  return (metrics.cache_hits_fresh + metrics.cache_hits_stale) / metrics.cache_lookups_total
})
const maxPipeline = computed(() => Math.max(...(overview.value?.metrics.pipelines.map((item) => item.count) ?? [1])))

async function load(silent = false): Promise<void> {
  if (!silent) refreshing.value = true
  try {
    const [nextOverview, nextService] = await Promise.all([
      apiRequest<Overview>('/api/v1/overview'),
      apiRequest<ServiceStatus>('/api/v1/service'),
    ])
    overview.value = nextOverview
    service.value = nextService
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

async function flushCache(): Promise<void> {
  if (!window.confirm('清空 KixDNS 响应缓存和规则缓存？')) return
  flushing.value = true
  try {
    const result = await apiRequest<CacheFlushResult>('/api/v1/cache/flush', { method: 'POST' })
    toast.success(`已清理 ${formatNumber(result.response_entries_before + result.rule_entries_before)} 个缓存条目`)
    await load(true)
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    flushing.value = false
  }
}

onMounted(async () => {
  await load()
  timer = window.setInterval(() => void load(true), 15000)
})
onBeforeUnmount(() => window.clearInterval(timer))
</script>

<template>
  <div class="page dashboard-page">
    <div class="page-actions">
      <div class="status-line"><span :class="service?.active_state === 'active' ? 'status-dot' : 'status-dot status-dot--danger'"></span>{{ service?.unit ?? 'kixdns.service' }} · {{ service?.sub_state ?? '读取中' }}</div>
      <button class="button button--secondary" type="button" :disabled="refreshing" @click="load()"><RefreshCw :size="16" :class="{ spin: refreshing }" />刷新</button>
    </div>

    <div v-if="loading" class="skeleton-grid"><span v-for="index in 4" :key="index"></span></div>
    <template v-else-if="overview">
      <section class="metric-grid" aria-label="核心指标">
        <article class="metric"><span class="metric__icon metric__icon--green"><Zap :size="19" /></span><div><small>累计请求</small><strong>{{ formatNumber(overview.metrics.requests_total) }}</strong><em>当前 {{ overview.metrics.requests_inflight }} 个并发</em></div></article>
        <article class="metric"><span class="metric__icon metric__icon--amber"><Activity :size="19" /></span><div><small>缓存命中率</small><strong>{{ formatPercent(cacheHitRate) }}</strong><em>含新鲜与过期命中</em></div></article>
        <article class="metric"><span class="metric__icon metric__icon--ink"><Database :size="19" /></span><div><small>缓存条目</small><strong>{{ formatNumber(overview.metrics.cache_entries) }}</strong><em>运行时内部条目</em></div></article>
        <article class="metric"><span class="metric__icon metric__icon--red"><Timer :size="19" /></span><div><small>持续运行</small><strong>{{ formatDuration(overview.health.uptime_seconds) }}</strong><em>PID {{ overview.health.pid }}</em></div></article>
      </section>

      <section class="dashboard-grid">
        <article class="panel panel--span-7">
          <header class="panel__header"><div><h2>Pipeline 命中</h2><p>按累计请求次数排序</p></div><span class="tag">{{ overview.metrics.pipelines.length }} 条</span></header>
          <div class="bar-list">
            <div v-for="pipeline in overview.metrics.pipelines" :key="pipeline.name" class="bar-row">
              <div><strong>{{ pipeline.name }}</strong><span>{{ formatNumber(pipeline.count) }}</span></div>
              <span class="bar-track"><i :style="{ width: `${Math.max(2, pipeline.count / maxPipeline * 100)}%` }"></i></span>
            </div>
            <p v-if="overview.metrics.pipelines.length === 0" class="empty-state">尚无 Pipeline 命中数据</p>
          </div>
        </article>

        <article class="panel panel--span-5 runtime-panel">
          <header class="panel__header"><div><h2>运行时配置</h2><p>最近一次结构化热加载</p></div><span :class="overview.active_config.last_reload.success ? 'tag tag--success' : 'tag tag--danger'">{{ overview.active_config.last_reload.success ? '生效' : '失败' }}</span></header>
          <dl class="detail-list">
            <div><dt>配置代次</dt><dd>#{{ overview.active_config.generation }}</dd></div>
            <div><dt>重载序号</dt><dd>#{{ overview.active_config.reload_sequence }}</dd></div>
            <div><dt>配置摘要</dt><dd class="mono">{{ shortHash(overview.active_config.sha256, 14) }}</dd></div>
            <div><dt>上游提交</dt><dd class="mono">{{ shortHash(overview.health.upstream_commit, 12) }}</dd></div>
            <div><dt>补丁集</dt><dd>v{{ overview.health.patchset }}</dd></div>
          </dl>
          <button class="button button--danger-quiet button--full" type="button" :disabled="flushing" @click="flushCache"><Eraser :size="16" />{{ flushing ? '正在清理' : '清空内部缓存' }}</button>
        </article>

        <article class="panel panel--span-12">
          <header class="panel__header"><div><h2>上游请求</h2><p>内部尝试、成功和异常计数</p></div></header>
          <div class="table-scroll"><table><thead><tr><th>上游</th><th>传输</th><th>尝试</th><th>成功率</th><th>错误</th><th>拒绝</th></tr></thead><tbody><tr v-for="item in overview.metrics.upstreams" :key="`${item.upstream}:${item.transport}`"><td class="mono table-strong">{{ item.upstream }}</td><td><span class="tag tag--muted">{{ item.transport }}</span></td><td>{{ formatNumber(item.attempts) }}</td><td>{{ formatPercent(item.attempts ? item.success / item.attempts : 0) }}</td><td :class="{ 'text-danger': item.errors > 0 }">{{ formatNumber(item.errors) }}</td><td>{{ formatNumber(item.rejected) }}</td></tr></tbody></table></div>
        </article>

        <article class="panel panel--span-12">
          <header class="panel__header"><div><h2>规则命中</h2><p>请求与响应阶段的累计执行次数</p></div><span class="tag">{{ overview.metrics.rules.length }} 项</span></header>
          <div class="rule-grid"><div v-for="rule in overview.metrics.rules" :key="`${rule.pipeline}:${rule.phase}:${rule.rule}`"><span :class="rule.phase === 'request' ? 'phase phase--request' : 'phase phase--response'">{{ rule.phase === 'request' ? '请求' : '响应' }}</span><strong>{{ rule.rule }}</strong><small>{{ rule.pipeline }}</small><b>{{ formatNumber(rule.count) }}</b></div></div>
        </article>
      </section>
    </template>
  </div>
</template>
