<script setup lang="ts">
import { Download, GitBranch, KeyRound, Plus, RefreshCw, RotateCcw, Save, Square, Trash2, Workflow } from '@lucide/vue'
import { ref } from 'vue'
import UiCard from '../components/ui/UiCard.vue'
import UiEmpty from '../components/ui/UiEmpty.vue'
import UiNewItemsBanner from '../components/ui/UiNewItemsBanner.vue'
import UiNumber from '../components/ui/UiNumber.vue'
import UiPageHeader from '../components/ui/UiPageHeader.vue'
import UiSection from '../components/ui/UiSection.vue'
import UiTabs from '../components/ui/UiTabs.vue'
import UiTask, { type UiTaskState } from '../components/ui/UiTask.vue'

// 组件清单：只在开发服务器里有，给改版前的截图评审和 e2e 用，不进正式构建。
// The component sheet: dev server only, for review screenshots and e2e
// before pages adopt the parts. It is not part of the production build.
const view = ref('running')
const views = [{ value: 'running', label: '运行情况' }, { value: 'ranking', label: '查询排行' }, { value: 'rules', label: '规则命中' }]
const level = ref('all')
const levels = [{ value: 'all', label: '全部' }, { value: 'error', label: '错误' }, { value: 'warning', label: '警告' }, { value: 'info', label: '信息' }]
const track = ref('action')
const tracks = [{ value: 'action', label: 'Actions', icon: GitBranch }, { value: 'release', label: 'Releases' }]

const total = ref(12_847_392)
function refresh(): void { total.value += 180 + Math.floor(Math.random() * 900) }

const taskState = ref<UiTaskState>('idle')
const taskStarted = ref<number | null>(null)
const taskProgress = ref<number | null>(null)
const taskNote = ref('增强 681d813a7 · x86_64 · p8 · 07/31 01:31')
const wait = (ms: number) => new Promise((resolve) => { window.setTimeout(resolve, ms) })
async function install(): Promise<void> {
  taskState.value = 'run'
  taskStarted.value = Date.now()
  for (let step = 1; step <= 10; step += 1) {
    taskProgress.value = step / 10
    taskNote.value = `正在下载 ${(18.4 * step / 10).toFixed(1)} / 18.4 MB`
    await wait(260)
  }
  taskProgress.value = null
  taskNote.value = '正在切换到新版本'
  await wait(900)
  taskState.value = 'done'
  taskNote.value = '已切换到 Run #30235703570'
}
function fail(): void {
  taskState.value = 'fail'
  taskNote.value = '下载中断：连接 nightly.link 超时。检查网络后重试。'
}
function reset(): void {
  taskState.value = 'idle'
  taskStarted.value = null
  taskNote.value = '增强 681d813a7 · x86_64 · p8 · 07/31 01:31'
}

const pending = ref(0)
const logLines = ref([
  { time: '15:27:13.000', text: 'request completed pipeline=default transport=udp elapsed_ms=9', warn: false },
  { time: '15:26:51.000', text: 'upstream request timed out, continuing with next configured resolver', warn: true },
  { time: '15:26:33.000', text: 'request completed pipeline=default transport=udp elapsed_ms=12', warn: false },
])
function arrive(): void { pending.value += 3 }
function showNew(): void {
  const stamps = ['15:28:07.000', '15:27:49.000', '15:27:31.000'].slice(0, pending.value)
  logLines.value = [...stamps.map((time, i) => ({ time, text: `request completed pipeline=default transport=tcp elapsed_ms=${9 - i}`, warn: false })), ...logLines.value]
  pending.value = 0
}
</script>

<template>
  <div class="page ui-kit">
    <UiPageHeader title="系统" stack>
      <template #meta><span class="ui-dot"></span><span class="ui-mono">kixdns.service</span> 正在运行<span class="ui-sep">·</span>PID <span class="ui-mono">1428</span><span class="ui-sep">·</span>已运行 3 天 8 小时</template>
      <template #actions><button class="ui-btn ui-btn--secondary" type="button"><RotateCcw :size="16" />重启</button><button class="ui-btn ui-btn--danger" type="button"><Square :size="16" />停止</button></template>
    </UiPageHeader>

    <UiTabs v-model="view" :items="views" label="概览视图" id-prefix="kit" />

    <UiSection title="筛选分段" aside="下沉轨道里一个凸起的白块">
      <div class="ui-kit__row ui-kit__row--stack">
        <UiTabs v-model="level" :items="levels" label="日志级别" variant="segment" />
        <UiTabs v-model="track" :items="tracks" label="版本源" variant="segment" />
      </div>
    </UiSection>

    <UiSection title="按钮与控件高度" aside="一屏最多一个主按钮；同一行里的控件一样高">
      <p class="ui-kit__label">常规：页头、工具栏、表单。桌面 36，手机 44</p>
      <div class="ui-kit__row">
        <button class="ui-btn ui-btn--primary" type="button">执行查询</button>
        <button class="ui-btn ui-btn--secondary" type="button">校验</button>
        <button class="ui-btn ui-btn--text" type="button">构建详情</button>
        <button class="ui-btn ui-btn--danger" type="button">停止</button>
        <button class="ui-icon-btn" type="button" title="刷新" aria-label="刷新"><RefreshCw :size="18" /></button>
        <button class="ui-btn ui-btn--primary" type="button" disabled><Save :size="16" />保存并热加载</button>
      </div>
      <div class="ui-kit__row">
        <label class="ui-input ui-kit__grow"><KeyRound :size="16" aria-hidden="true" /><input id="kit-token" placeholder="github_pat_…" aria-label="GitHub 令牌" /></label>
        <button class="ui-btn ui-btn--secondary" type="button">保存</button>
        <button class="ui-icon-btn" type="button" title="删除凭据" aria-label="删除凭据"><Trash2 :size="18" /></button>
      </div>
      <div class="ui-kit__row">
        <UiTabs v-model="track" :items="tracks" label="版本源（常规）" variant="segment" />
        <button class="ui-icon-btn" type="button" title="刷新版本" aria-label="刷新版本"><RefreshCw :size="18" /></button>
      </div>
      <p class="ui-kit__label">行内：列表行、状态胶囊里。桌面 30，手机 36</p>
      <div class="ui-kit__row">
        <button class="ui-btn ui-btn--secondary ui-btn--sm" type="button">切换</button>
        <button class="ui-btn ui-btn--secondary ui-btn--sm" type="button">安装并切换</button>
        <button class="ui-btn ui-btn--text ui-btn--sm" type="button">取消</button>
        <button class="ui-icon-btn ui-icon-btn--sm" type="button" title="切换到这个版本" aria-label="切换到这个版本"><RotateCcw :size="16" /></button>
        <button class="ui-icon-btn ui-icon-btn--sm" type="button" title="删除" aria-label="删除"><Trash2 :size="16" /></button>
        <UiTabs v-model="track" :items="tracks" label="版本源（行内）" variant="segment" size="sm" />
      </div>
    </UiSection>

    <div class="ui-kit__grid">
      <UiCard title="当前安装" desc="增强版运行时">
        <template #actions><span class="ui-tag ui-tag--ok">已安装</span></template>
        <dl class="ui-kv">
          <div><dt>当前版本</dt><dd class="ui-mono">Run #30231271280</dd></div>
          <div><dt>上游提交</dt><dd class="ui-mono">647c5b1d2af6</dd></div>
          <div><dt>控制协议</dt><dd class="ui-mono">v1</dd></div>
          <div><dt>安装来源</dt><dd><a class="ui-link" href="#">上游详情</a></dd></div>
        </dl>
      </UiCard>
      <UiCard title="当前运行配置">
        <template #title><span class="ui-tag ui-tag--ok">已生效</span></template>
        <template #actions><button class="ui-btn ui-btn--secondary ui-btn--sm" type="button">管理配置</button></template>
        <dl class="ui-strip">
          <div><dt>配置代次</dt><dd class="ui-mono">#18</dd></div>
          <div><dt>重载序号</dt><dd class="ui-mono">#24</dd></div>
          <div><dt>配置摘要</dt><dd class="ui-mono">45b9a1c0c7b551</dd></div>
          <div><dt>补丁集</dt><dd class="ui-mono">v6</dd></div>
        </dl>
        <template #foot><span>PID <span class="ui-mono">1428</span> · 统计为运行时累计值</span></template>
      </UiCard>
    </div>

    <UiSection title="上游台账" aside="最近一小时">
      <div class="ui-kit__ledger">
        <div class="ui-rec-head"><span>上游</span><span>成功率</span><span>平均耗时</span><span>响应次数</span></div>
        <div class="ui-rec">
          <div class="ui-rec__name"><span class="ui-dot"></span><span class="ui-mono">1.1.1.1:53</span><span class="ui-tag ui-tag--mono">udp</span></div>
          <span class="ui-rec__n">99.7%</span><span class="ui-rec__n">12 ms</span><span class="ui-rec__n">18,320</span>
          <div class="ui-rec__meta ui-rec__phone">成功率 99.7% · 平均 12 ms · 18,320 次响应</div>
        </div>
        <div class="ui-rec">
          <div class="ui-rec__name"><span class="ui-dot ui-dot--warn"></span><span class="ui-mono">dns.google/dns-query</span><span class="ui-tag ui-tag--mono">doh</span></div>
          <span class="ui-rec__n">97.1%</span><span class="ui-rec__n">1.3 s</span><span class="ui-rec__n">1,114</span>
          <div class="ui-rec__meta ui-rec__phone">成功率 97.1% · 平均 1.3 s · 1,114 次响应</div>
        </div>
      </div>
    </UiSection>

    <UiCard title="可用构建" desc="要等几秒的操作用状态胶囊">
      <UiTask :state="taskState" title="Run #30235703570" :started-at="taskStarted" :progress="taskProgress">
        <template #icon><Download :size="15" /></template>
        <template #title><span class="ui-tag ui-tag--ok">最新</span></template>
        <template #meta><p v-if="taskState === 'fail'" class="ui-task__error">{{ taskNote }}</p><span v-else>{{ taskNote }}</span></template>
        <template #actions>
          <button v-if="taskState === 'idle'" class="ui-btn ui-btn--secondary ui-btn--sm" type="button" @click="install">安装并切换</button>
          <button v-if="taskState === 'idle'" class="ui-btn ui-btn--text ui-btn--sm" type="button" @click="fail">演示失败</button>
          <button v-if="taskState === 'done' || taskState === 'fail'" class="ui-btn ui-btn--text ui-btn--sm" type="button" @click="reset">复原</button>
        </template>
      </UiTask>
    </UiCard>

    <UiSection title="数字">
      <div class="ui-kit__row">
        <span class="ui-kit__figure"><UiNumber :value="total.toLocaleString('en-US')" /></span>
        <button class="ui-icon-btn" type="button" title="模拟一次刷新" aria-label="模拟一次刷新" @click="refresh"><RefreshCw :size="18" /></button>
      </div>
    </UiSection>

    <UiCard title="新数据提示条" flush>
      <template #actions><button class="ui-btn ui-btn--secondary ui-btn--sm" type="button" @click="arrive">来了 3 条新日志</button></template>
      <div class="ui-kit__log">
        <UiNewItemsBanner v-if="pending > 0" :label="`有 ${pending} 条新日志，点击显示`" @show="showNew" />
        <div v-for="line in logLines" :key="line.time" class="log-line" :class="line.warn ? 'log-line--warning' : 'log-line--info'"><time>{{ line.time }}</time><strong>kixdns</strong><p>{{ line.text }}</p></div>
      </div>
    </UiCard>

    <UiCard title="空状态">
      <UiEmpty :icon="Workflow" title="还没有入口" desc="入口决定请求交给哪个 Pipeline。没有入口时，请求都交给默认的 Pipeline。">
        <button class="ui-btn ui-btn--secondary ui-btn--sm" type="button"><Plus :size="16" />添加入口</button>
      </UiEmpty>
    </UiCard>
  </div>
</template>

<style>
/* 组件清单页自己的排版：跟着这个只在开发服务器里存在的页面走，不进正式包的样式 */
.ui-kit { display: grid; gap: var(--s-5); padding-block: var(--s-6); }
.ui-kit__row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2); }
.ui-kit__label { margin: var(--s-2) 0 0; color: var(--l-ink-3); font-size: var(--t-1); }
.ui-kit__grow { flex: 1 1 160px; max-width: 420px; }
.ui-kit__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-4); align-items: start; }
.ui-kit__ledger { --rec-cols: minmax(0, 1.6fr) repeat(3, minmax(0, .7fr)); }
.ui-kit__figure { font-family: var(--f-display); font-size: var(--t-6); font-weight: var(--w-bold); }
.ui-kit__log { overflow: hidden; border-radius: 0 0 var(--r-3) var(--r-3); }
@media (max-width: 640px) { .ui-kit__grid { grid-template-columns: minmax(0, 1fr); } .ui-kit__row--stack { display: grid; } }
</style>
