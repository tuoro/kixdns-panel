<script setup lang="ts">
import { ArrowUpRight, ChevronRight, CircleAlert, Eraser, RefreshCw } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { apiRequest } from '../api/client'
import type { CacheFlushResult, Overview, QueryStatsSnapshot, ServiceStatus, StatsClearResult } from '../api/types'
import StatusBanner from '../components/StatusBanner.vue'
import { useToast } from '../composables/useToast'
import { pipelineDistribution } from '../dashboard-presentation'
import { dashboardRuntimeState, emptyOverview, emptyQueryStats, hasStaleDashboardData, supportsQueryStats } from '../dashboard-state'
import { errorMessage, formatDuration, formatNumber, formatPercent, shortHash } from '../utils'

const overview = ref<Overview | null>(null)
const service = ref<ServiceStatus | null>(null)
const stats = ref<QueryStatsSnapshot | null>(null)
const loading = ref(true)
const refreshing = ref(false)
const requesting = ref(false)
const flushing = ref(false)
const statsLoading = ref(false)
const statsClearing = ref(false)
const statsWindow = ref(86_400)
const overviewError = ref('')
const serviceError = ref('')
const statsError = ref('')
const toast = useToast()
const activeView = ref('runtime')
const views = [
  { id: 'runtime', label: '运行情况' },
  { id: 'stats', label: '查询排行' },
  { id: 'rules', label: '规则命中' },
]
const pipelineColors = ['var(--ink)', 'var(--green)', 'var(--muted)']
let timer: number | undefined
let statsTimer: number | undefined
let pendingLoad: Promise<void> | null = null
let pendingStatsLoad: Promise<void> | null = null

const statsWindows = [
  { label: '1 小时', value: 3_600 },
  { label: '6 小时', value: 21_600 },
  { label: '24 小时', value: 86_400 },
]

const runtimeState = computed(() => dashboardRuntimeState(overview.value, service.value))
const overviewDisplayError = computed(() => runtimeState.value === 'stopped-empty' ? '' : overviewError.value)
const loadError = computed(() => [overviewDisplayError.value, serviceError.value, statsError.value].filter(Boolean).join('；'))
const statsSupported = computed(() => supportsQueryStats(overview.value?.health.capabilities ?? []))
const runtimeUnavailable = computed(() => hasStaleDashboardData(runtimeState.value))
const runtimeControlsDisabled = computed(() => runtimeState.value !== 'live')
const displayOverview = computed(() => overview.value ?? (runtimeState.value === 'stopped-empty' ? emptyOverview() : null))
const showStatsSection = computed(() => statsSupported.value || runtimeState.value === 'stopped-empty')
const displayStats = computed(() => stats.value ?? (runtimeState.value === 'stopped-empty' ? emptyQueryStats(statsWindow.value) : null))
const maxClient = computed(() => Math.max(1, ...(stats.value?.clients.map((item) => item.count) ?? [])))
const maxDomain = computed(() => Math.max(1, ...(stats.value?.domains.map((item) => item.count) ?? [])))

const cacheHitRate = computed(() => {
  const metrics = displayOverview.value?.metrics
  if (!metrics?.cache_lookups_total) return 0
  return (metrics.cache_hits_fresh + metrics.cache_hits_stale) / metrics.cache_lookups_total
})
const pipelines = computed(() => pipelineDistribution(displayOverview.value?.metrics.pipelines ?? []))
const rankingGroups = [
  {
    id: 'clients', title: '客户端排行',
    description: '按来源地址聚合',
  },
  {
    id: 'domains', title: '请求域名排行', description: '按查询次数降序排列',
  },
] as const
const configStateLabel = computed(() => {
  if (!overview.value) return '未运行'
  if (runtimeUnavailable.value) return '运行快照'
  return overview.value.active_config.last_reload.success ? '已生效' : '重载失败'
})

function moveViewFocus(event: KeyboardEvent, index: number): void {
  let next = index
  if (event.key === 'ArrowRight') next = (index + 1) % views.length
  else if (event.key === 'ArrowLeft') next = (index + views.length - 1) % views.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = views.length - 1
  else return
  event.preventDefault()
  activeView.value = views[next]!.id
  const tab = event.currentTarget as HTMLButtonElement
  tab.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
}

function load(silent = false): Promise<void> {
  if (pendingLoad) return pendingLoad
  if (!silent) refreshing.value = true
  requesting.value = true
  pendingLoad = (async () => {
    const [overviewResult, serviceResult] = await Promise.allSettled([
      apiRequest<Overview>('/api/v1/overview'),
      apiRequest<ServiceStatus>('/api/v1/service'),
    ])
    if (overviewResult.status === 'fulfilled') {
      overview.value = overviewResult.value
      overviewError.value = ''
    } else overviewError.value = `运行数据：${errorMessage(overviewResult.reason)}`
    if (serviceResult.status === 'fulfilled') {
      service.value = serviceResult.value
      serviceError.value = ''
    } else serviceError.value = `服务状态：${errorMessage(serviceResult.reason)}`
  })().finally(() => {
    loading.value = false
    refreshing.value = false
    requesting.value = false
    pendingLoad = null
  })
  return pendingLoad
}

function loadStats(silent = false): Promise<void> {
  if (!statsSupported.value) {
    stats.value = null
    statsError.value = ''
    return Promise.resolve()
  }
  if (pendingStatsLoad) return pendingStatsLoad
  if (!silent) statsLoading.value = true
  pendingStatsLoad = apiRequest<QueryStatsSnapshot>(`/api/v1/stats/top?window=${statsWindow.value}&limit=10`)
    .then((result) => {
      stats.value = result
      statsError.value = ''
    })
    .catch((error: unknown) => {
      statsError.value = `查询排行：${errorMessage(error)}`
    })
    .finally(() => {
      statsLoading.value = false
      pendingStatsLoad = null
    })
  return pendingStatsLoad
}

async function refreshAll(): Promise<void> {
  await load()
  await loadStats()
}

async function setStatsWindow(windowSeconds: number): Promise<void> {
  if (statsWindow.value === windowSeconds) return
  statsWindow.value = windowSeconds
  await loadStats()
}

async function clearQueryStats(): Promise<void> {
  if (!window.confirm('清空全部客户端和请求域名排行？')) return
  statsClearing.value = true
  try {
    await apiRequest<StatsClearResult>('/api/v1/stats/clear', { method: 'POST' })
    toast.success('查询排行已清空')
    await loadStats(true)
  } catch (error) {
    toast.error(errorMessage(error))
  } finally {
    statsClearing.value = false
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
  await loadStats()
  timer = window.setInterval(() => void load(true), 15000)
  statsTimer = window.setInterval(() => void loadStats(true), 60000)
})
onBeforeUnmount(() => {
  window.clearInterval(timer)
  window.clearInterval(statsTimer)
})
</script>

<template>
  <div class="page overview-page">
    <header class="page-heading overview-heading">
      <div>
        <h1>运行概览</h1>
        <p class="overview-heading-context">{{ service?.unit ?? 'kixdns.service' }} · {{ service?.sub_state ?? '读取中' }}</p>
      </div>
      <button class="overview-button" type="button" :disabled="requesting || statsLoading" @click="refreshAll">
        <RefreshCw :size="16" :class="{ spin: refreshing || statsLoading }" /><span>刷新</span>
      </button>
    </header>

    <StatusBanner v-if="loadError" class="overview-notice" :message="loadError" :stale="hasStaleDashboardData(runtimeState)" :busy="requesting || statsLoading" @retry="refreshAll" />
    <section v-if="!loading && runtimeState === 'stopped-empty'" class="overview-notice overview-notice--paused" role="status">
      <CircleAlert :size="18" />
      <div><strong>KixDNS 未启动</strong><p>当前尚无运行数据，启动 KixDNS 后概览将自动更新。</p></div>
    </section>
    <section v-if="runtimeUnavailable" class="overview-notice overview-notice--paused" role="status">
      <CircleAlert :size="18" />
      <div>
        <strong>{{ runtimeState === 'stopped-snapshot' ? 'KixDNS 已停止' : '实时数据暂不可用' }}</strong>
        <p>{{ runtimeState === 'stopped-snapshot' ? '当前显示最后一次运行快照，数据已停止更新。' : '当前显示最近一次成功快照，实时数据恢复后会自动更新。' }}</p>
      </div>
    </section>

    <div class="overview-tabs" role="tablist" aria-label="概览视图">
      <button v-for="(view, index) in views" :id="`overview-tab-${view.id}`" :key="view.id" type="button" role="tab"
        :aria-selected="activeView === view.id" :aria-controls="`overview-panel-${view.id}`" :tabindex="activeView === view.id ? 0 : -1"
        @click="activeView = view.id" @keydown="moveViewFocus($event, index)">{{ view.label }}</button>
    </div>

    <div v-if="loading" class="overview-loading" role="status">正在读取运行数据…</div>
    <template v-else-if="displayOverview">
      <section id="overview-panel-runtime" v-show="activeView === 'runtime'" class="overview-view" role="tabpanel" aria-labelledby="overview-tab-runtime" tabindex="0">
        <section class="overview-summary" aria-label="核心指标">
          <div class="overview-total">
            <span>累计请求</span>
            <strong class="overview-total-value">{{ formatNumber(displayOverview.metrics.requests_total) }}</strong>
            <small>自本次启动以来</small>
          </div>
          <dl class="overview-vitals">
            <div class="overview-vital overview-vital--uptime"><dt>持续运行</dt><dd>{{ overview ? formatDuration(displayOverview.health.uptime_seconds) : '--' }}</dd></div>
            <div class="overview-vital overview-vital--inflight"><dt>当前并发</dt><dd>{{ formatNumber(displayOverview.metrics.requests_inflight) }}</dd></div>
            <div class="overview-vital overview-vital--cache">
              <dt title="含新鲜与过期命中">缓存命中率</dt><dd>{{ formatPercent(cacheHitRate) }}<small class="overview-mobile-cache">{{ formatNumber(displayOverview.metrics.cache_entries) }} 条缓存</small></dd>
            </div>
            <div class="overview-vital overview-vital--entries"><dt>缓存条目</dt><dd>{{ formatNumber(displayOverview.metrics.cache_entries) }}</dd></div>
          </dl>
        </section>

        <section class="overview-section overview-distribution" aria-labelledby="overview-distribution-heading">
          <header class="overview-section-heading"><h2 id="overview-distribution-heading">请求分布</h2><p>按 Pipeline 累计命中</p></header>
          <template v-if="pipelines.length">
            <div class="overview-distribution-track" aria-hidden="true">
              <span v-for="(pipeline, index) in pipelines" :key="pipeline.name" class="overview-distribution-segment"
                :style="{ width: `${pipeline.share * 100}%`, backgroundColor: pipelineColors[index % pipelineColors.length] }"
                :title="`${pipeline.name} · ${formatPercent(pipeline.share)}`"><span>{{ pipeline.name }}</span></span>
            </div>
            <ul class="overview-pipeline-list" aria-label="Pipeline 命中分布">
              <li v-for="(pipeline, index) in pipelines" :key="pipeline.name">
                <span class="overview-pipeline-name"><i :style="{ backgroundColor: pipelineColors[index % pipelineColors.length] }" aria-hidden="true"></i><strong>{{ pipeline.name }}</strong></span>
                <span class="overview-pipeline-count">{{ formatNumber(pipeline.count) }}</span>
                <span class="overview-pipeline-share">{{ formatPercent(pipeline.share) }}</span>
              </li>
            </ul>
          </template>
          <p v-else class="overview-empty">尚无 Pipeline 命中数据</p>
        </section>

        <section class="overview-section" aria-labelledby="overview-upstream-heading">
          <header class="overview-section-heading"><div><h2 id="overview-upstream-heading">上游请求</h2><p>内部尝试、成功与异常计数</p></div><span>{{ displayOverview.metrics.upstreams.length }} 个上游</span></header>
          <template v-if="displayOverview.metrics.upstreams.length">
            <div class="overview-upstream-desktop">
              <table class="overview-table">
                <caption class="overview-sr-only">各上游的运行时累计请求结果</caption>
                <thead><tr><th scope="col">上游</th><th scope="col">传输</th><th scope="col">尝试</th><th scope="col">成功率</th><th scope="col">错误</th><th scope="col">拒绝</th></tr></thead>
                <tbody><tr v-for="item in displayOverview.metrics.upstreams" :key="`${item.upstream}:${item.transport}`">
                  <th scope="row" class="overview-mono">{{ item.upstream }}</th><td><span class="overview-transport">{{ item.transport }}</span></td>
                  <td>{{ formatNumber(item.attempts) }}</td><td>{{ formatPercent(item.attempts ? item.success / item.attempts : 0) }}</td>
                  <td :class="{ 'overview-warning': item.errors > 0 }">{{ formatNumber(item.errors) }}</td><td>{{ formatNumber(item.rejected) }}</td>
                </tr></tbody>
              </table>
            </div>
            <div class="overview-upstream-mobile">
              <details v-for="item in displayOverview.metrics.upstreams" :key="`${item.upstream}:${item.transport}`" class="overview-upstream-detail">
                <summary>
                  <span class="overview-upstream-identity"><strong class="overview-mono">{{ item.upstream }}</strong><span class="overview-transport">{{ item.transport }}</span></span>
                  <span class="overview-upstream-summary">尝试 {{ formatNumber(item.attempts) }} · 成功率 {{ formatPercent(item.attempts ? item.success / item.attempts : 0) }}</span>
                  <ChevronRight :size="18" class="overview-disclosure-icon" />
                </summary>
                <dl class="overview-upstream-counts">
                  <div><dt>成功</dt><dd>{{ formatNumber(item.success) }}</dd></div>
                  <div><dt>错误</dt><dd :class="{ 'overview-warning': item.errors > 0 }">{{ formatNumber(item.errors) }}</dd></div>
                  <div><dt>拒绝</dt><dd>{{ formatNumber(item.rejected) }}</dd></div>
                </dl>
              </details>
            </div>
          </template>
          <p v-else class="overview-empty">尚无上游请求数据</p>
        </section>
      </section>

      <section id="overview-panel-stats" v-show="activeView === 'stats'" class="overview-view" role="tabpanel" aria-labelledby="overview-tab-stats" tabindex="0">
        <header class="overview-section-heading overview-stats-heading">
          <div><h2>查询排行</h2><p v-if="displayStats">已观察 {{ formatNumber(displayStats.requests_observed) }} 次请求<span v-if="displayStats.dropped_updates"> · 丢弃 {{ formatNumber(displayStats.dropped_updates) }} 次统计更新</span></p><p v-else>客户端与请求域名</p></div>
          <div class="overview-stats-tools">
            <div class="overview-windows" role="group" aria-label="统计窗口">
              <button v-for="option in statsWindows" :key="option.value" type="button" :aria-pressed="statsWindow === option.value" :disabled="statsLoading || runtimeControlsDisabled" @click="setStatsWindow(option.value)">{{ option.label }}</button>
            </div>
            <button v-if="stats?.enabled" class="overview-button overview-icon-button" type="button" title="清空查询排行" aria-label="清空查询排行" :disabled="statsClearing || runtimeControlsDisabled" @click="clearQueryStats"><Eraser :size="16" /></button>
          </div>
        </header>
        <p v-if="!showStatsSection" class="overview-empty">当前 KixDNS 未提供查询排行能力。</p>
        <div v-else-if="displayStats?.enabled" class="overview-rankings">
          <section v-for="group in rankingGroups" :key="group.id" class="overview-ranking">
            <header><h3>{{ group.title }}</h3><p>{{ group.id === 'clients' && displayStats.anonymized_clients ? '按脱敏网段聚合' : group.description }}</p></header>
            <ol v-if="displayStats[group.id].length" class="overview-ranking-list">
              <li v-for="(item, index) in displayStats[group.id]" :key="item.name">
                <span class="overview-rank">{{ String(index + 1).padStart(2, '0') }}</span>
                <strong class="overview-mono" :title="item.name">{{ item.name }}</strong><span>{{ formatNumber(item.count) }}</span>
                <i aria-hidden="true"><span :style="{ width: `${item.count / (group.id === 'clients' ? maxClient : maxDomain) * 100}%` }"></span></i>
              </li>
            </ol>
            <p v-else class="overview-empty">{{ group.id === 'clients' ? '当前窗口暂无客户端数据' : '当前窗口暂无域名数据' }}</p>
          </section>
        </div>
        <div v-else-if="stats" class="overview-empty overview-stats-disabled"><strong>查询统计未启用</strong><p>当前没有收集客户端地址和请求域名。</p><RouterLink class="overview-button" to="/config">打开配置<ArrowUpRight :size="16" /></RouterLink></div>
        <p v-else class="overview-empty">{{ statsLoading ? '正在读取查询排行' : '查询排行暂不可用' }}</p>
      </section>

      <section id="overview-panel-rules" v-show="activeView === 'rules'" class="overview-view" role="tabpanel" aria-labelledby="overview-tab-rules" tabindex="0">
        <header class="overview-section-heading"><div><h2>规则命中</h2><p>请求与响应阶段的累计执行次数</p></div><span>{{ displayOverview.metrics.rules.length }} 项</span></header>
        <div v-if="displayOverview.metrics.rules.length" class="overview-rules">
          <div class="overview-rule-head" aria-hidden="true"><span>阶段</span><span>Pipeline</span><span>规则</span><span>执行次数</span></div>
          <ul>
            <li v-for="rule in displayOverview.metrics.rules" :key="`${rule.pipeline}:${rule.phase}:${rule.rule}`" class="overview-rule">
              <span class="overview-phase" :class="{ 'overview-phase--response': rule.phase === 'response' }">{{ rule.phase === 'request' ? '请求' : '响应' }}</span>
              <span class="overview-rule-pipeline overview-mono">{{ rule.pipeline }}</span><strong class="overview-rule-name overview-mono">{{ rule.rule }}</strong><span class="overview-rule-count">{{ formatNumber(rule.count) }}</span>
            </li>
          </ul>
        </div>
        <p v-else class="overview-empty">尚无规则命中数据</p>
      </section>

      <section class="overview-runtime" aria-labelledby="overview-runtime-heading">
        <header class="overview-runtime-heading">
          <div><h2 id="overview-runtime-heading">{{ runtimeUnavailable ? '最后运行配置' : '当前运行配置' }}</h2><span class="overview-config-state" :class="{ 'overview-config-state--active': runtimeState === 'live' && displayOverview.active_config.last_reload.success, 'overview-warning': overview && !displayOverview.active_config.last_reload.success }">{{ configStateLabel }}</span></div>
          <RouterLink class="overview-button" to="/config">管理配置<ArrowUpRight :size="16" /></RouterLink>
        </header>
        <dl class="overview-runtime-ledger">
          <div><dt>配置代次</dt><dd>{{ overview ? `#${displayOverview.active_config.generation}` : '--' }}</dd></div>
          <div><dt>重载序号</dt><dd>{{ overview ? `#${displayOverview.active_config.reload_sequence}` : '--' }}</dd></div>
          <div><dt>配置摘要</dt><dd class="overview-mono" :title="overview ? displayOverview.active_config.sha256 : undefined">{{ overview ? shortHash(displayOverview.active_config.sha256, 14) : '--' }}</dd></div>
          <div><dt>上游提交</dt><dd class="overview-mono">{{ overview ? shortHash(displayOverview.health.upstream_commit, 12) : '--' }}</dd></div>
          <div><dt>补丁集</dt><dd>{{ overview ? `v${displayOverview.health.patchset}` : '--' }}</dd></div>
        </dl>
        <p v-if="overview && !displayOverview.active_config.last_reload.success && displayOverview.active_config.last_reload.error" class="overview-reload-error">{{ displayOverview.active_config.last_reload.error }}</p>
        <footer class="overview-runtime-footer">
          <p>PID {{ overview ? displayOverview.health.pid : '--' }}<span> · 统计为运行时累计值</span></p>
          <button class="overview-button overview-cache-button" type="button" :disabled="flushing || runtimeControlsDisabled" @click="flushCache"><Eraser :size="15" />{{ flushing ? '正在清理' : '清空内部缓存' }}</button>
        </footer>
      </section>
    </template>
    <p v-else class="overview-empty">运行数据暂不可用，请检查增强控制通道。</p>
  </div>
</template>

<style scoped>
.overview-page { color: var(--ink); font-size: 14px; line-height: 1.5; }
.overview-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.overview-heading h1 { margin: 0; font-size: 28px; font-weight: 650; letter-spacing: -.04em; line-height: 1.25; }
.overview-heading-context { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
.overview-button { min-height: 40px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 13px; border: 1px solid var(--line); border-radius: 4px; color: var(--ink); background: var(--surface); font: inherit; font-size: 13px; text-decoration: none; cursor: pointer; }
.overview-button:hover:not(:disabled) { border-color: var(--ink); }
.overview-button:disabled { opacity: .45; cursor: not-allowed; }
.overview-button:focus-visible, .overview-tabs button:focus-visible, .overview-windows button:focus-visible, .overview-upstream-detail summary:focus-visible { outline: 2px solid var(--green); outline-offset: 3px; }
.overview-notice { margin-bottom: 16px; }
.overview-notice--paused { display: flex; align-items: flex-start; gap: 10px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); }
.overview-notice--paused > svg { flex: 0 0 auto; margin-top: 2px; color: var(--muted); }
.overview-notice p { margin: 3px 0 0; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.overview-tabs { display: flex; gap: 28px; min-height: 46px; margin-bottom: 24px; border-bottom: 1px solid var(--line); }
.overview-tabs button { position: relative; padding: 0 8px 12px; border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 14px; cursor: pointer; }
.overview-tabs button[aria-selected="true"] { color: var(--ink); font-weight: 600; }
.overview-tabs button[aria-selected="true"]::after { position: absolute; right: 0; bottom: -1px; left: 0; height: 3px; background: var(--green); content: ''; }
.overview-view { outline-offset: 5px; }
.overview-summary { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, .9fr); gap: 48px; padding-bottom: 26px; }
.overview-total { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; min-width: 0; }
.overview-total > span { font-size: 14px; }
.overview-total-value { max-width: 100%; margin: 8px 0 2px; font-size: clamp(42px, 6.2vw, 88px); font-weight: 500; font-variant-numeric: tabular-nums; letter-spacing: -.055em; line-height: 1.15; overflow-wrap: anywhere; }
.overview-total small { color: var(--muted); font-size: 12px; }
.overview-vitals { margin: 0; }
.overview-vital { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 42px; border-bottom: 1px solid var(--line); }
.overview-vital:last-child { border-bottom: 0; }
.overview-vital dt, .overview-vital dd { margin: 0; }
.overview-vital dd { font-size: 17px; font-variant-numeric: tabular-nums; }
.overview-mobile-cache { display: none; }
.overview-section { padding: 22px 0 0; margin-bottom: 24px; border-top: 1px solid var(--line); }
.overview-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 16px; }
.overview-section-heading > div:first-child { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 16px; min-width: 0; }
.overview-section-heading h2, .overview-runtime h2 { margin: 0; font-size: 17px; font-weight: 600; line-height: 1.4; }
.overview-section-heading p, .overview-section-heading > span { margin: 0; color: var(--muted); font-size: 12px; }
.overview-distribution-track { display: flex; height: 40px; overflow: hidden; border-radius: 3px; background: var(--line); }
.overview-distribution-segment { display: flex; flex: 0 0 auto; min-width: 0; align-items: center; justify-content: center; overflow: hidden; color: var(--surface); }
.overview-distribution-segment > span { min-width: 0; padding: 0 8px; overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.overview-pipeline-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px 24px; margin: 12px 0 0; padding: 0; list-style: none; }
.overview-pipeline-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; min-width: 0; }
.overview-pipeline-name { display: flex; grid-column: 1 / -1; align-items: baseline; gap: 8px; min-width: 0; }
.overview-pipeline-name i { flex: 0 0 8px; width: 8px; height: 8px; border-radius: 1px; }
.overview-pipeline-name strong { font-weight: 500; overflow-wrap: anywhere; }
.overview-pipeline-count { font-variant-numeric: tabular-nums; }
.overview-pipeline-share { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.overview-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.overview-table th, .overview-table td { padding: 13px 12px; border-top: 0; border-bottom: 1px solid var(--line); background: transparent; text-align: right; white-space: normal; text-transform: none; font-variant-numeric: tabular-nums; }
.overview-table tr:last-child th, .overview-table tr:last-child td { border-bottom: 0; }
.overview-table thead th { color: var(--muted); font-size: 12px; font-weight: 500; }
.overview-table th:first-child, .overview-table td:nth-child(2), .overview-table th:nth-child(2) { text-align: left; }
.overview-table th:first-child { padding-left: 0; font-weight: 500; overflow-wrap: anywhere; }
.overview-table td:last-child, .overview-table th:last-child { padding-right: 0; }
.overview-table tbody th { max-width: 320px; color: var(--ink); font-size: 14px; }
.overview-transport { display: inline-block; padding: 2px 6px; border: 1px solid var(--line); border-radius: 3px; color: var(--ink); font: inherit; font-size: 12px; white-space: nowrap; }
.overview-warning { color: #a56118; }
.overview-upstream-mobile { display: none; }
.overview-runtime { margin-top: 24px; padding: 18px 20px 0; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); }
.overview-runtime-heading, .overview-runtime-heading > div { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 16px; }
.overview-runtime-heading { margin-bottom: 18px; }
.overview-runtime-heading h2 { font-size: 15px; }
.overview-config-state { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
.overview-config-state::before { width: 7px; height: 7px; border-radius: 50%; background: currentColor; content: ''; }
.overview-config-state--active { color: var(--green); }
.overview-runtime-ledger { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 16px; margin: 0 0 18px; }
.overview-runtime-ledger > div { min-width: 0; padding-right: 10px; border-right: 1px solid var(--line); }
.overview-runtime-ledger > div:last-child { border: 0; }
.overview-runtime-ledger dt { margin-bottom: 4px; color: var(--muted); font-size: 12px; }
.overview-runtime-ledger dd { margin: 0; overflow-wrap: anywhere; font-size: 13px; }
.overview-runtime-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 54px; border-top: 1px solid var(--line); }
.overview-runtime-footer p { margin: 0; color: var(--muted); font-size: 12px; }
.overview-cache-button { border-color: transparent; background: transparent; color: var(--muted); font-size: 12px; }
.overview-reload-error { color: #a56118; overflow-wrap: anywhere; font-size: 12px; }
.overview-stats-heading { align-items: flex-start; margin-bottom: 24px; }
.overview-stats-heading > div:first-child { display: block; }
.overview-stats-heading p { margin-top: 4px; }
.overview-stats-tools { display: flex; align-items: center; gap: 8px; }
.overview-windows { display: flex; }
.overview-windows button { min-height: 40px; padding: 7px 12px; border: 1px solid var(--line); border-right: 0; color: var(--muted); background: var(--surface); font: inherit; font-size: 12px; cursor: pointer; }
.overview-windows button:first-child { border-radius: 4px 0 0 4px; }
.overview-windows button:last-child { border-right: 1px solid var(--line); border-radius: 0 4px 4px 0; }
.overview-windows button[aria-pressed="true"] { color: var(--green); background: var(--canvas); box-shadow: inset 0 -2px var(--green); }
.overview-windows button:disabled { opacity: .45; cursor: not-allowed; }
.overview-icon-button { width: 40px; padding: 0; }
.overview-rankings { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 36px; }
.overview-ranking { min-width: 0; }
.overview-ranking h3 { margin: 0; font-size: 15px; font-weight: 600; }
.overview-ranking header p { margin: 3px 0 14px; color: var(--muted); font-size: 12px; }
.overview-ranking-list, .overview-rules ul { margin: 0; padding: 0; list-style: none; }
.overview-ranking-list li { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 6px 8px; padding: 13px 0; border-bottom: 1px solid var(--line); }
.overview-rank { color: var(--muted); font-size: 12px; }
.overview-ranking-list strong { min-width: 0; font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.overview-ranking-list li > span:last-of-type { font-size: 13px; font-variant-numeric: tabular-nums; }
.overview-ranking-list li > i { grid-column: 2 / -1; height: 3px; background: var(--line); }
.overview-ranking-list i > span { display: block; height: 100%; background: var(--green); }
.overview-rule, .overview-rule-head { display: grid; grid-template-columns: 72px minmax(100px, 1fr) minmax(160px, 2fr) 110px; gap: 16px; align-items: center; padding: 14px 0; border-bottom: 1px solid var(--line); }
.overview-rule-head { color: var(--muted); font-size: 12px; }
.overview-rule-head > span:last-child, .overview-rule-count { text-align: right; font-variant-numeric: tabular-nums; }
.overview-rule-name { min-width: 0; font-size: 14px; font-weight: 500; overflow-wrap: anywhere; }
.overview-rule-pipeline { color: var(--muted); overflow-wrap: anywhere; font-size: 13px; }
.overview-phase { justify-self: start; padding: 2px 7px; border: 1px solid var(--line); border-radius: 3px; color: var(--green); font-size: 12px; }
.overview-phase--response { color: var(--muted); }
.overview-empty, .overview-loading { padding: 28px 0; color: var(--muted); font-size: 13px; }
.overview-stats-disabled > * { display: block; margin: 0 0 8px; }
.overview-stats-disabled .overview-button { display: inline-flex; margin-top: 8px; }
.overview-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.overview-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

@media (max-width: 1000px) {
  .overview-summary { gap: 28px; }
  .overview-runtime-ledger { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .overview-table th, .overview-table td { padding: 12px 8px; font-size: 13px; }
  .overview-table tbody th { max-width: 230px; }
}

@media (max-width: 700px) {
  .overview-heading { margin-bottom: 8px; }
  .overview-heading h1 { font-size: 20px; letter-spacing: -.025em; }
  .overview-heading-context { display: none; }
  .overview-button { min-height: 44px; padding: 8px 10px; font-size: 12px; }
  .overview-heading > .overview-button { gap: 5px; }
  .overview-tabs { gap: 16px; min-height: 44px; margin-bottom: 16px; }
  .overview-tabs button { padding: 0 4px 9px; font-size: 14px; }
  .overview-summary { grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 14px 16px; padding-bottom: 16px; }
  .overview-total { grid-column: 1; grid-row: 1; justify-content: start; }
  .overview-total > span { font-size: 12px; color: var(--muted); }
  .overview-total-value { margin: 3px 0; font-size: clamp(28px, 8vw, 32px); letter-spacing: -.045em; }
  .overview-total small { font-size: 12px; }
  .overview-vitals { display: contents; }
  .overview-vital { display: grid; align-content: start; justify-content: stretch; gap: 3px; min-height: 0; border: 0; }
  .overview-vital dt { font-size: 12px; color: var(--muted); }
  .overview-vital dd { font-size: 20px; line-height: 1.3; }
  .overview-vital--uptime { grid-column: 2; grid-row: 1; padding-left: 12px; border-left: 1px solid var(--line); }
  .overview-vital--uptime dd { margin-top: 7px; font-size: 14px; }
  .overview-vital--cache { grid-column: 1; grid-row: 2; }
  .overview-vital--inflight { grid-column: 2; grid-row: 2; padding-left: 12px; border-left: 1px solid var(--line); }
  .overview-vital--entries { display: none; }
  .overview-mobile-cache { display: block; color: var(--muted); font-size: 12px; }
  .overview-section { padding-top: 16px; margin-bottom: 18px; }
  .overview-section-heading { align-items: baseline; gap: 8px; margin-bottom: 10px; }
  .overview-section-heading h2 { font-size: 15px; }
  .overview-section-heading > div:first-child { display: block; }
  .overview-section-heading > div > p { display: none; }
  .overview-section-heading > p, .overview-section-heading > span { font-size: 12px; }
  .overview-distribution-track { height: 7px; border-radius: 2px; }
  .overview-distribution-segment > span { display: none; }
  .overview-pipeline-list { display: block; margin-top: 5px; }
  .overview-pipeline-list li { grid-template-columns: minmax(0, 1fr) auto 49px; gap: 8px; align-items: center; min-height: 34px; border-bottom: 1px solid var(--line); font-size: 14px; }
  .overview-pipeline-list li:last-child { border-bottom: 0; }
  .overview-pipeline-name { grid-column: auto; gap: 7px; }
  .overview-pipeline-name i { flex-basis: 7px; width: 7px; height: 7px; }
  .overview-pipeline-share { font-size: 12px; text-align: right; }
  .overview-upstream-desktop { display: none; }
  .overview-upstream-mobile { display: block; }
  .overview-upstream-detail { border-bottom: 1px solid var(--line); }
  .overview-upstream-detail:last-child { border-bottom: 0; }
  .overview-upstream-detail summary { position: relative; display: grid; gap: 4px; min-height: 56px; padding: 11px 28px 11px 0; list-style: none; cursor: pointer; }
  .overview-upstream-detail summary::-webkit-details-marker { display: none; }
  .overview-upstream-identity { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex-wrap: wrap; }
  .overview-upstream-identity strong { min-width: 0; overflow-wrap: anywhere; font-size: 14px; font-weight: 500; }
  .overview-transport { padding: 0 5px; font-size: 12px; }
  .overview-upstream-summary { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .overview-disclosure-icon { position: absolute; top: 21px; right: 0; color: var(--muted); transition: transform .15s; }
  .overview-upstream-detail[open] .overview-disclosure-icon { transform: rotate(90deg); }
  .overview-upstream-counts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0; padding: 3px 0 14px; }
  .overview-upstream-counts dt { color: var(--muted); font-size: 12px; }
  .overview-upstream-counts dd { margin: 3px 0 0; font-size: 12px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .overview-runtime { margin-top: 18px; padding: 12px 12px 0; }
  .overview-runtime-heading { margin-bottom: 12px; }
  .overview-runtime-heading > div { gap: 8px; }
  .overview-runtime-heading h2 { font-size: 14px; }
  .overview-runtime-heading > .overview-button { min-height: 44px; padding: 4px 7px; font-size: 12px; }
  .overview-config-state { gap: 4px; font-size: 12px; }
  .overview-config-state::before { width: 6px; height: 6px; }
  .overview-runtime-ledger { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; margin-bottom: 12px; }
  .overview-runtime-ledger > div { border: 0; padding: 0; }
  .overview-runtime-ledger dt { margin-bottom: 2px; font-size: 12px; }
  .overview-runtime-ledger dd { font-size: 12px; }
  .overview-runtime-footer { gap: 6px; min-height: 48px; }
  .overview-runtime-footer p { font-size: 12px; }
  .overview-runtime-footer p span { display: none; }
  .overview-cache-button { padding-right: 0; font-size: 12px; }
  .overview-stats-heading { flex-direction: column; gap: 14px; margin-bottom: 18px; }
  .overview-stats-heading > div > p { display: block; font-size: 12px; }
  .overview-stats-tools { width: 100%; justify-content: space-between; gap: 10px; }
  .overview-windows button { min-height: 44px; padding: 8px 13px; font-size: 12px; }
  .overview-icon-button { width: 44px; }
  .overview-rankings { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .overview-ranking-list li { grid-template-columns: 21px minmax(0, 1fr) auto; gap: 5px 7px; padding: 11px 0; }
  .overview-ranking-list strong, .overview-ranking-list li > span:last-of-type { font-size: 14px; }
  .overview-rule-head { display: none; }
  .overview-rule { grid-template-columns: minmax(0, 1fr) auto; gap: 5px 10px; padding: 12px 0; }
  .overview-phase { grid-column: 1; grid-row: 1; font-size: 12px; }
  .overview-rule-count { grid-column: 2; grid-row: 1 / 4; align-self: center; font-size: 14px; }
  .overview-rule-name { grid-column: 1; grid-row: 2; font-size: 13px; }
  .overview-rule-pipeline { grid-column: 1; grid-row: 3; font-size: 12px; }
  .overview-notice--paused { padding: 12px; }
}
</style>
