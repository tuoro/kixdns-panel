<script setup lang="ts">
import { ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, ArrowUpToLine, ChevronRight, GitBranch, MoreHorizontal, Plus, Search, Settings2, Trash2, Zap } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { collectDnsSolutions, collectDomainMappingRows, materializeSolutionRules, solutionInsertIndex, type DnsSolution, type SolutionDraft } from '../../config-editor/solution'
import { summarizeActions, summarizeMatchers } from '../../config-editor/summary'
import type { KixConfig, PipelineConfig } from '../../config-editor/types'
import SolutionGuide from './SolutionGuide.vue'

const config = defineModel<KixConfig>({ required: true })
defineProps<{ capabilities: string[] }>()
const emit = defineEmits<{ manual: []; mapping: []; notice: [message: string]; dirty: [value: boolean]; editing: [value: boolean] }>()
const solutions = computed(() => collectDnsSolutions(config.value).filter((solution) => solution.groupType !== 'domain_mapping'))
const entries = computed(() => solutions.value.filter((solution) => solution.selectorIndex !== undefined))
const orphans = computed(() => solutions.value.filter((solution) => solution.kind === 'orphan'))
const mappingCount = computed(() => collectDomainMappingRows(config.value).length)
const query = ref('')
const session = ref<DnsSolution | 'create' | undefined>(entries.value[0])
const sessionKey = ref(0)
const localDirty = ref(false)
const focused = ref(false)
const inspector = ref<HTMLElement | null>(null)
const mobileViewport = window.matchMedia('(max-width: 860px)')
const isMobile = ref(mobileViewport.matches)
let returnFocus: HTMLElement | null = null
const filteredEntries = computed(() => entries.value.filter(matchesSearch))
const filteredOrphans = computed(() => orphans.value.filter(matchesSearch))
const selectedSolution = computed(() => session.value && session.value !== 'create' ? session.value : undefined)
const canGuide = computed(() => session.value === 'create' || selectedSolution.value?.kind === 'simple' || selectedSolution.value?.kind === 'group')

watch(localDirty, (value) => emit('dirty', value), { flush: 'sync' })
watch([focused, isMobile], ([value, mobile]) => emit('editing', value && mobile), { flush: 'sync' })

function resize(event: MediaQueryListEvent): void { isMobile.value = event.matches }
onMounted(() => mobileViewport.addEventListener('change', resize))
onBeforeUnmount(() => mobileViewport.removeEventListener('change', resize))

async function focusInspector(): Promise<void> {
  if (!isMobile.value) return
  await nextTick()
  inspector.value?.querySelector<HTMLButtonElement>('button')?.focus()
}

function trapMobileFocus(event: KeyboardEvent): void {
  if (!isMobile.value || !focused.value) return
  const controls = Array.from(inspector.value?.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], summary, [tabindex]') ?? [])
    .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0)
  const first = controls[0]
  const last = controls.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }

function solutionEntry(solution: DnsSolution): string {
  if (!solution.selector) return '无直接入口，可被其他流程跳转调用'
  return summarizeMatchers(solution.selector.matchers, solution.selector.matcher_operator, 'selector')
}

function solutionAction(solution: DnsSolution): string {
  if (!solution.pipeline) return solution.reason ?? '目标 Pipeline 不存在'
  if (solution.kind !== 'simple' || !solution.rule) return `${solution.pipeline.rules.length} 条规则 · 自定义流程`
  return summarizeActions(solution.rule.actions)
}

function matchesSearch(solution: DnsSolution): boolean {
  const term = query.value.trim().toLocaleLowerCase()
  return !term || [solution.pipeline?.id, solution.selector?.pipeline, solutionEntry(solution), solutionAction(solution)].join(' ').toLocaleLowerCase().includes(term)
}

function entryNumber(solution: DnsSolution): string {
  return String(entries.value.findIndex((entry) => entry.selectorIndex === solution.selectorIndex) + 1).padStart(2, '0')
}

function confirmDiscard(): boolean {
  return !localDirty.value || window.confirm('当前入口的修改尚未应用到草稿，确定放弃？')
}

function resetSession(next?: DnsSolution | 'create', focus = false): void {
  const restoreFocus = focused.value && !focus
  localDirty.value = false
  session.value = next
  sessionKey.value += 1
  focused.value = focus
  if (restoreFocus) void nextTick(() => returnFocus?.isConnected && returnFocus.focus({ preventScroll: true }))
}

function selectSolution(solution: DnsSolution | 'create'): void {
  if (solution !== 'create' && selectedSolution.value?.key === solution.key) {
    focused.value = true
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    void focusInspector()
    return
  }
  if (!confirmDiscard()) return
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  resetSession(solution, true)
  void focusInspector()
}

function cancel(): void {
  if (confirmDiscard()) resetSession()
}

function moveSolution(solution: DnsSolution, direction: -1 | 1 | 'first' | 'last'): void {
  if (solution.selectorIndex === undefined || !confirmDiscard()) return
  const position = entries.value.findIndex((entry) => entry.selectorIndex === solution.selectorIndex)
  const targetPosition = direction === 'first' ? 0 : direction === 'last' ? entries.value.length - 1 : position + direction
  const targetIndex = entries.value[targetPosition]?.selectorIndex
  if (targetIndex === undefined || targetIndex === solution.selectorIndex) return
  const [selector] = config.value.pipeline_select.splice(solution.selectorIndex, 1)
  if (selector) config.value.pipeline_select.splice(targetIndex, 0, selector)
  resetSession(entries.value.find((entry) => entry.selector === selector))
  emit('notice', '入口顺序已更新到草稿，保存配置后生效')
}

function removeSolution(solution: DnsSolution): void {
  if (solution.selectorIndex === undefined || !solution.selector || !confirmDiscard()) return
  if (!window.confirm(`删除入口“${solution.selector.pipeline}”？`)) return
  const pipelineId = solution.selector.pipeline
  config.value.pipeline_select.splice(solution.selectorIndex, 1)
  if (solution.referenceCount === 1 && solution.pipelineIndex !== undefined) config.value.pipelines.splice(solution.pipelineIndex, 1)
  resetSession()
  emit('notice', solution.referenceCount === 1 ? `入口及独立 Pipeline “${pipelineId}”已从草稿删除` : `入口已从草稿删除，共享 Pipeline “${pipelineId}”已保留`)
}

function materializePipeline(draft: SolutionDraft): PipelineConfig {
  const pipeline = clone(draft.pipeline)
  pipeline.rules = materializeSolutionRules(draft)
  return pipeline
}

function insertNewDraft(draft: SolutionDraft): void {
  const selector = clone(draft.selector)
  if (draft.pipelineMode !== 'reuse') {
    const pipeline = materializePipeline(draft)
    selector.pipeline = pipeline.id
    config.value.pipelines.push(pipeline)
  }
  config.value.pipeline_select.splice(solutionInsertIndex(config.value, selector), 0, selector)
}

function saveDrafts(drafts: SolutionDraft[]): void {
  const editing = selectedSolution.value
  if (!editing) {
    for (const draft of drafts) insertNewDraft(draft)
    resetSession(entries.value.find((entry) => entry.selector?.pipeline === drafts[0]?.selector.pipeline))
    emit('notice', `已将 ${drafts.length} 个入口加入草稿，保存配置后生效`)
    return
  }
  const draft = drafts[0]
  if (!draft || editing.selectorIndex === undefined) return
  const selector = clone(draft.selector)
  if (draft.pipelineMode === 'owned' || draft.pipelineMode === 'shared') {
    const pipelineIndex = config.value.pipelines.findIndex((pipeline) => pipeline.id === draft.existingPipelineId)
    if (pipelineIndex >= 0) {
      const pipeline = materializePipeline(draft)
      pipeline.id = draft.existingPipelineId ?? pipeline.id
      selector.pipeline = pipeline.id
      config.value.pipelines.splice(pipelineIndex, 1, pipeline)
    }
  } else if (draft.pipelineMode === 'copy') {
    const pipeline = materializePipeline(draft)
    config.value.pipelines.push(pipeline)
    selector.pipeline = pipeline.id
  }
  config.value.pipeline_select.splice(editing.selectorIndex, 1, selector)
  if (draft.pipelineMode === 'reuse' && editing.referenceCount === 1 && editing.pipelineIndex !== undefined) config.value.pipelines.splice(editing.pipelineIndex, 1)
  resetSession(entries.value.find((entry) => entry.selectorIndex === editing.selectorIndex))
  emit('notice', draft.pipelineMode === 'shared' ? '共享流程的修改已应用到草稿，保存配置后生效' : '入口修改已应用到草稿，保存配置后生效')
}

function openManual(): void {
  if (!confirmDiscard()) return
  resetSession()
  emit('manual')
}

function openMapping(): void {
  if (!confirmDiscard()) return
  resetSession()
  emit('mapping')
}

defineExpose({ confirmDiscard })
</script>

<template>
  <section class="workbench" :data-config-editing="focused ? 'true' : undefined" aria-label="解析编排工作台">
    <div class="workbench-routes" :inert="focused && isMobile">
      <!-- 压成一条可读的状态带：标出每段的实际条数，当前所在段用深色填充。
           它现在是导航而不是装饰——原来那张占了四行的示意图既点不动，
           也没说出每段有多少条。
           A single readable strip carrying each stage's real count, with the
           current one filled. It is navigation now rather than decoration: the
           four-row diagram it replaces could not be clicked and never said how
           much sat in each stage. -->
      <nav class="workbench-priority" aria-label="DNS 解析顺序">
        <span class="workbench-request">DNS 请求</span>
        <span class="workbench-flow-arrow" aria-hidden="true"><ArrowRight :size="15" /></span>
        <button class="workbench-mapping-node" type="button" @click="openMapping"><Zap :size="13" />域名映射<b>{{ mappingCount }} 条 CNAME</b></button>
        <span class="workbench-flow-arrow" aria-hidden="true"><ArrowRight :size="15" /></span>
        <span class="workbench-flow-node is-current">入口匹配<b>{{ entries.length }} 个</b></span>
        <span class="workbench-flow-arrow" aria-hidden="true"><ArrowRight :size="15" /></span>
        <span class="workbench-response">Pipeline 处理</span>
        <p class="workbench-priority-hint">域名映射最高优先级，命中即返回 CNAME；其余按入口自上而下，首个匹配生效</p>
      </nav>
      <header class="workbench-list-toolbar">
        <label class="workbench-search"><Search :size="16" /><input v-model="query" type="search" aria-label="搜索入口或 Pipeline" placeholder="搜索入口、Pipeline"></label>
        <span>{{ entries.length }} 个入口</span>
        <button class="button button--secondary" type="button" @click="selectSolution('create')"><Plus :size="16" />添加入口</button>
      </header>
      <div class="workbench-route-scroll">
        <div class="workbench-column-labels" aria-hidden="true"><span>顺序 / 匹配条件</span><span>Pipeline</span><span>处理</span></div>
        <div class="workbench-entry-list">
          <article v-for="solution in filteredEntries" :key="solution.key" class="workbench-entry" :class="{ 'is-selected': selectedSolution?.key === solution.key }">
            <button class="workbench-entry-select" type="button" :aria-label="`编辑入口 ${entryNumber(solution)} ${solution.selector?.pipeline}`" :aria-pressed="selectedSolution?.key === solution.key" @click="selectSolution(solution)">
              <span class="workbench-entry-number">{{ entryNumber(solution) }}</span>
              <span class="workbench-entry-condition"><strong>{{ solutionEntry(solution) }}</strong><small v-if="(solution.selector?.matchers.length ?? 0) > 1">{{ solution.selector?.matchers.length }} 个条件</small></span>
              <ArrowRight class="workbench-entry-arrow" :size="16" /><span class="workbench-entry-pipeline">{{ solution.pipeline?.id ?? solution.selector?.pipeline }}<small v-if="solution.referenceCount > 1">{{ solution.referenceCount }} 处引用</small></span>
              <ArrowRight class="workbench-entry-arrow" :size="16" /><span class="workbench-entry-action">{{ solutionAction(solution) }}</span><ChevronRight class="workbench-entry-chevron" :size="16" />
            </button>
            <details class="workbench-entry-menu"><summary :aria-label="`入口 ${entryNumber(solution)} 操作`"><MoreHorizontal :size="18" /></summary><div>
              <button type="button" :disabled="solution.selectorIndex === entries[0]?.selectorIndex" @click="moveSolution(solution, 'first')"><ArrowUpToLine :size="14" />移到最前</button>
              <button type="button" :disabled="solution.selectorIndex === entries[0]?.selectorIndex" @click="moveSolution(solution, -1)"><ArrowUp :size="14" />上移入口</button>
              <button type="button" :disabled="solution.selectorIndex === entries.at(-1)?.selectorIndex" @click="moveSolution(solution, 1)"><ArrowDown :size="14" />下移入口</button>
              <button type="button" :disabled="solution.selectorIndex === entries.at(-1)?.selectorIndex" @click="moveSolution(solution, 'last')"><ArrowDownToLine :size="14" />移到最后</button>
              <button type="button" class="workbench-delete" @click="removeSolution(solution)"><Trash2 :size="14" />删除入口</button>
            </div></details>
          </article>
        </div>
        <p v-if="filteredEntries.length === 0" class="workbench-empty">{{ query ? '没有匹配的入口' : '暂无入口，添加一个方案开始编排' }}</p>
        <section v-if="filteredOrphans.length" class="workbench-orphans"><header><GitBranch :size="15" /><strong>无直接入口的 Pipeline</strong></header><p>可由跳转动作调用，不参与上方入口顺序。</p><button v-for="solution in filteredOrphans" :key="solution.key" type="button" @click="selectSolution(solution)"><span>{{ solution.pipeline?.id }}</span><small>{{ solution.pipeline?.rules.length }} 条规则</small><ChevronRight :size="15" /></button></section>
      </div>
      <footer class="workbench-list-footer"><span>{{ query ? `显示 ${filteredEntries.length} / ${entries.length} 个入口` : `${entries.length} 个入口 · 顺序决定匹配优先级` }}</span><button type="button" @click="openManual"><Settings2 :size="14" />自由编辑</button></footer>
    </div>
    <aside ref="inspector" class="workbench-inspector" :role="focused && isMobile ? 'dialog' : 'complementary'" :aria-modal="focused && isMobile ? true : undefined" aria-label="入口编辑器" @keydown.esc.stop="cancel" @keydown.tab="trapMobileFocus">
      <SolutionGuide v-if="session && canGuide" :key="sessionKey" embedded :config="config" :solution="selectedSolution" :capabilities="capabilities" @dirty="localDirty = $event" @cancel="cancel" @save="saveDrafts" />
      <div v-else-if="selectedSolution" class="workbench-custom"><header><strong>{{ selectedSolution.pipeline?.id ?? selectedSolution.selector?.pipeline }}</strong><button class="button button--secondary" type="button" @click="cancel">返回</button></header><span class="workbench-custom-tag">{{ selectedSolution.kind === 'orphan' ? '可复用流程' : '自定义流程' }}</span><h3>{{ solutionEntry(selectedSolution) }}</h3><p>{{ selectedSolution.reason }}。请在自由编辑中调整，已有配置会完整保留。</p><p v-if="selectedSolution.referenceCount > 1">此流程有 {{ selectedSolution.referenceCount }} 处引用，修改会同时影响引用它的入口和规则。</p><button class="button button--primary" type="button" @click="openManual"><Settings2 :size="16" />打开自由编辑</button></div>
      <div v-else class="workbench-inspector-empty"><GitBranch :size="28" /><h3>选择一个入口</h3><p>在这里调整匹配条件与处理动作，并预览配置效果。</p><button class="button button--secondary" type="button" @click="selectSolution('create')"><Plus :size="15" />添加入口</button></div>
    </aside>
  </section>
</template>

<style scoped>
.workbench { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(370px, 1fr); min-height: 620px; height: min(880px, calc(100dvh - 238px)); color: var(--ink); background: var(--surface, #fff); }
.workbench-routes { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 1px solid var(--line); }
.workbench-priority { flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
/* 类名挂在外层 span 上：lucide 组件会用自己的 class 覆盖掉传进去的那个，
   直接写在 <ArrowRight class="..."> 上不会生效，而且不会报错。
   The class goes on a wrapping span: the lucide component replaces whatever
   class is passed to it, so writing it on <ArrowRight> has no effect and no
   error either. */
.workbench-flow-arrow { display: inline-flex; flex: 0 0 auto; color: var(--line); }
.workbench-request, .workbench-response, .workbench-flow-node, .workbench-mapping-node { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 5px; background: var(--canvas); color: var(--muted); font-size: 12px; white-space: nowrap; border: 0; }
.workbench-flow-node b, .workbench-mapping-node b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
/* 条数跟随所在节点的前景色：非当前节点是浅底深字，当前节点是深底反白。
   写死颜色会让它在当前态变成黑压黑。
   The count inherits its node's foreground: an inactive node is dark on light
   and the current one light on dark. A fixed colour turns it black on black. */
.workbench-flow-node.is-current { background: var(--ink); color: var(--d-ink); }
.workbench-flow-node.is-current b { color: var(--d-ink); }
.workbench-mapping-node { cursor: pointer; }
.workbench-mapping-node:hover { color: var(--ink); background: var(--line); }
.workbench-priority-hint { flex-basis: 100%; margin: 2px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.workbench-list-toolbar { display: flex; align-items: center; flex: 0 0 auto; gap: 12px; padding: 17px 20px; border-bottom: 1px solid var(--line); }
.workbench-list-toolbar > span { white-space: nowrap; margin-left: auto; color: var(--muted); font-size: 12px; }
.workbench-search { display: flex; align-items: center; gap: 8px; min-width: 0; max-width: 290px; padding: 0 10px; border: 1px solid var(--line); border-radius: 5px; }
.workbench-search > svg { flex-shrink: 0; color: var(--muted); }
.workbench-search input { width: 100%; min-width: 0; height: 36px; padding: 0; border: 0; background: transparent; font-size: 12px; outline: 0; }
.workbench-search:focus-within { outline: 2px solid var(--green); outline-offset: 2px; }
.workbench-route-scroll { flex: 1; overflow-y: auto; min-height: 0; padding-bottom: 110px; overscroll-behavior: contain; }
.workbench-column-labels { display: grid; grid-template-columns: 1.4fr .8fr 1fr; padding: 12px 62px 12px 26px; color: var(--muted); font-size: 12px; border-bottom: 1px solid var(--line); }
.workbench-entry-list { display: grid; gap: 5px; padding: 8px 12px; }
.workbench-entry { position: relative; display: flex; min-width: 0; align-items: center; border: 1px solid transparent; border-left: 3px solid transparent; border-radius: 5px; }
.workbench-entry.is-selected { color: #fff; border-left-color: var(--d-ink); background: var(--ink); }
.workbench-entry-select { display: grid; grid-template-columns: 28px minmax(0, 1.25fr) 16px minmax(0, .8fr) 16px minmax(0, 1fr); align-items: center; flex: 1; min-width: 0; gap: 10px; padding: 18px 10px; color: inherit; border: 0; background: transparent; cursor: pointer; text-align: left; }
.workbench-entry-select strong, .workbench-entry-select > span { font-size: 14px; font-weight: 500; line-height: 1.5; overflow-wrap: anywhere; }
.workbench-entry-select > .workbench-entry-number { color: var(--green); font-size: 16px; font-variant-numeric: tabular-nums; }
.workbench-entry-condition, .workbench-entry-pipeline { display: grid; gap: 4px; min-width: 0; }
.workbench-entry-select small { color: var(--muted); font-size: 12px; }
.workbench-entry.is-selected .workbench-entry-number, .workbench-entry.is-selected .workbench-entry-arrow { color: var(--d-ink); }
.workbench-entry.is-selected small { color: #c4ccc6; }
.workbench-entry-arrow { color: var(--muted); }
.workbench-entry-chevron { display: none; }
.workbench-entry-menu { position: relative; flex: 0 0 auto; align-self: stretch; display: flex; align-items: center; margin-right: 4px; }
.workbench-entry-menu > summary { display: grid; place-items: center; width: 36px; height: 44px; list-style: none; cursor: pointer; }
.workbench-entry-menu > summary::-webkit-details-marker { display: none; }
.workbench-entry-menu > div { position: absolute; z-index: 3; top: 48px; right: 0; min-width: 144px; display: grid; padding: 6px; background: var(--surface, #fff); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 8px 25px #07120e20; }
.workbench-entry-menu button { display: flex; align-items: center; gap: 8px; padding: 10px 12px; font-size: 12px; text-align: left; border: 0; border-radius: 4px; background: transparent; cursor: pointer; }
.workbench-entry-menu button:hover:not(:disabled) { background: var(--canvas, #f5f6f4); }
.workbench-entry-menu button:disabled { opacity: .4; cursor: default; }
.workbench-delete { color: #ad4545; }
.workbench-empty { padding: 35px 20px; text-align: center; color: var(--muted); font-size: 14px; }
.workbench-orphans { margin: 15px 22px; padding-top: 20px; border-top: 1px solid var(--line); }
.workbench-orphans > header { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.workbench-orphans > p { margin: 8px 0 13px; font-size: 12px; color: var(--muted); line-height: 1.6; }
.workbench-orphans > button { width: 100%; display: flex; align-items: center; gap: 10px; padding: 12px 0; text-align: left; color: inherit; border: 0; background: transparent; cursor: pointer; font-size: 14px; }
.workbench-orphans small { margin-left: auto; font-size: 12px; color: var(--muted); }
.workbench-list-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 57px; padding: 12px 20px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); }
.workbench-list-footer button { display: flex; align-items: center; gap: 6px; padding: 5px 0; color: var(--ink); background: none; border: 0; cursor: pointer; font-size: 12px; }
.workbench-inspector { min-width: 0; min-height: 0; height: 100%; overflow: hidden; }
.workbench-inspector-empty, .workbench-custom { display: flex; flex-direction: column; align-items: flex-start; gap: 18px; padding: 30px; }
.workbench-inspector-empty { padding-top: 80px; }
.workbench-inspector-empty > svg { color: var(--green); }
.workbench-inspector-empty h3, .workbench-custom h3 { font-size: 18px; line-height: 1.6; overflow-wrap: anywhere; }
.workbench-inspector-empty p, .workbench-custom p { color: var(--muted); font-size: 14px; line-height: 1.8; }
.workbench-custom > header { display: flex; justify-content: space-between; align-items: center; gap: 10px; width: 100%; font-size: 18px; overflow-wrap: anywhere; }
.workbench-custom-tag { padding: 5px 9px; background: #fff6e6; color: #89622a; border-radius: 4px; font-size: 12px; }
@media (max-width: 1150px) and (min-width: 861px) {
  .workbench { grid-template-columns: minmax(0, 1fr) 380px; }
  .workbench-priority { padding: 10px 12px; gap: 5px 6px; }
  /* 窄屏收掉首尾两个说明节点，连它们各自那支箭头一起——
     只藏节点会在两端留下指向空处的箭头。
     用相邻选择器而不是 :first-of-type：后者按元素类型数，
     箭头恰好是这里唯一的 svg，改动标记就会静默失配。
     Narrow screens drop the opening and closing labels along with each one's
     arrow: hiding only the nodes leaves arrows pointing at nothing. Sibling
     selectors rather than :first-of-type, which counts by element type and
     silently stops matching the moment the markup gains another svg. */
  .workbench-request, .workbench-response { display: none; }
  .workbench-request + .workbench-flow-arrow { display: none; }
  .workbench-flow-arrow:has(+ .workbench-response) { display: none; }
  .workbench-entry-select { grid-template-columns: 26px minmax(0, 1fr) minmax(0, .8fr); }
  .workbench-entry-arrow, .workbench-entry-action { display: none; }
  .workbench-column-labels { grid-template-columns: 1fr .8fr; padding-right: 50px; }
  .workbench-column-labels > span:last-child { display: none; }
  .workbench-list-toolbar { flex-wrap: wrap; }
  .workbench-search { flex: 1 1 100%; max-width: none; }
}
@media (max-width: 860px) {
  .workbench { display: block; height: auto; min-height: 0; }
  .workbench-routes { border-right: 0; }
  .workbench-priority { padding: 12px; gap: 5px 6px; }
  /* 首尾两个说明节点连同各自那支箭头一起收掉；只藏节点会在两端留下指向空处的箭头。 */
  .workbench-request, .workbench-response { display: none; }
  .workbench-request + .workbench-flow-arrow { display: none; }
  .workbench-flow-arrow:has(+ .workbench-response) { display: none; }
  .workbench-priority-hint { font-size: 12px; }
  .workbench-list-toolbar { flex-wrap: wrap; gap: 10px; padding: 12px 16px; }
  .workbench-search { max-width: none; flex: 1 1 100%; }
  .workbench-list-toolbar > span { margin-left: 0; margin-right: auto; }
  .workbench-list-toolbar .button { min-height: 44px; }
  .workbench-route-scroll { overflow: visible; padding-bottom: 90px; }
  .workbench-column-labels { display: none; }
  .workbench-entry-list { padding: 6px 10px; }
  .workbench-entry-select { grid-template-columns: 25px minmax(0, 1fr) auto; gap: 6px 10px; padding: 13px 8px; }
  .workbench-entry-number { grid-row: 1 / 3; align-self: center; }
  .workbench-entry-condition { grid-column: 2; grid-row: 2; }
  .workbench-entry-condition strong { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; opacity: .78; }
  .workbench-entry-condition small { display: none; }
  .workbench-entry-pipeline { grid-column: 2; grid-row: 1; font-size: 14px !important; }
  .workbench-entry-pipeline small, .workbench-entry-arrow, .workbench-entry-action { display: none; }
  .workbench-entry-chevron { display: block; grid-column: 3; grid-row: 1 / 3; }
  .workbench-entry-menu > summary { width: 44px; height: 100%; min-height: 44px; }
  .workbench-entry-menu button { min-height: 44px; font-size: 14px; }
  .workbench-list-footer { padding: 10px 16px; }
  .workbench-list-footer button { min-height: 44px; }
  .workbench-inspector { display: none; }
  .workbench[data-config-editing="true"] .workbench-inspector { display: block; position: fixed; z-index: 80; top: var(--app-header-height, 52px); right: 0; bottom: 0; left: 0; height: auto; background: var(--surface, #fff); }
}
</style>
