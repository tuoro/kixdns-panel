<script setup lang="ts">
import { ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, ArrowUpToLine, ChevronRight, GitBranch, Plus, Search, Settings2, Trash2, X, Zap } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useConfirm } from '../../composables/useConfirm'
import { ENTRY_ORDER_NOTE, SOLUTION_TEMPLATES, collectDnsSolutions, collectDomainMappingRows, materializeSolutionRules, pipelineRole, selectorMatchesEveryRequest, solutionInsertIndex, solutionTemplateDescription, type DnsSolution, type SolutionDraft, type SolutionTemplateId } from '../../config-editor/solution'
import { actionsPhrase, entryNamePhrase, join, phrase, rulePhrase, type Phrase } from '../../config-editor/phrase'
import { summarizeMatchers } from '../../config-editor/summary'
import type { KixConfig, PipelineConfig, RuleConfig } from '../../config-editor/types'
import PhraseText from './PhraseText.vue'
import { rememberListShape } from './list-shape'
import SolutionGuide from './SolutionGuide.vue'
import UiMenu, { type UiMenuItem } from '../ui/UiMenu.vue'

const config = defineModel<KixConfig>({ required: true })
// openKey：重建后先打开哪个入口（保存之后回到刚才那一个）；打开的入口变了就用 open 事件报出去。
// openKey: which entry to open after a rebuild (the same one after a save); changes are reported with the open event.
// changed：草稿里改过的入口和 Pipeline（按身份比出来的，见 changes.ts），行尾画一个墨色小点。
// changed: entries and Pipelines the draft changed (compared by identity, see changes.ts); they get an ink dot.
const props = defineProps<{ capabilities: string[]; openKey?: string; changed?: ReadonlySet<string> }>()
const confirm = useConfirm()
const emit = defineEmits<{ manual: [pipelineId?: string]; mapping: []; notice: [message: string]; dirty: [value: boolean]; editing: [value: boolean]; open: [key: string | undefined] }>()
const solutions = computed(() => collectDnsSolutions(config.value).filter((solution) => solution.groupType !== 'domain_mapping'))
const entries = computed(() => solutions.value.filter((solution) => solution.selectorIndex !== undefined))
const orphans = computed(() => solutions.value.filter((solution) => solution.kind === 'orphan'))
// 都没命中的请求交给谁：内核的 select_pipeline 退回配置里第一个 Pipeline。有一个入口匹配所有请求时，
// 它后面的都到不了，这句就不写。
// Where unmatched requests go: the kernel's select_pipeline falls back to the first Pipeline. With an
// entry that matches every request nothing gets past it, so the line is left out.
const fallbackPipeline = computed(() => config.value.pipelines[0]?.id)
const catchAll = computed(() => config.value.pipeline_select.some(selectorMatchesEveryRequest))
const mappingCount = computed(() => collectDomainMappingRows(config.value).length)
const query = ref('')
const session = ref<DnsSolution | 'create' | undefined>(entries.value.find((entry) => entry.key === props.openKey) ?? entries.value[0])
// 首次安装：一个入口都没有时，检查器直接是起点列表，不能关（规范 3.7）；手机上它是全屏层，照常能关。
// First install: with no entries the inspector is the start picker and cannot be closed (spec 3.7); on a phone it is a full-screen layer and closes as usual.
const firstInstall = computed(() => entries.value.length === 0)
const sessionKey = ref(0)
const localDirty = ref(false)
const focused = ref(false)
const inspector = ref<HTMLElement | null>(null)
const routes = ref<HTMLElement | null>(null)
const guide = ref<InstanceType<typeof SolutionGuide> | null>(null)
// 保存时替人按「应用到草稿」：这时不弹「已应用到草稿，保存后生效」，紧接着就保存了 / Applying on the way to a save: no 「applied to the draft, save to take effect」 notice, since the save follows at once
let quietApply = false
const mobileViewport = window.matchMedia('(max-width: 860px)')
const isMobile = ref(mobileViewport.matches)
let returnFocus: HTMLElement | null = null
const selectedSolution = computed(() => session.value && session.value !== 'create' ? session.value : undefined)
// 搜索时正在检查器里改的那一行一直留在列表里：列表和检查器说的是同一件事（审计 A21）
// While searching, the row open in the inspector stays in the list, so the list and the inspector agree (audit A21)
// 手机上检查器关着时没有「正在改的那一行」，不能夹带进搜索结果 / On a phone with the layer closed nothing is being edited, so no row is kept
const keptKey = computed(() => (!isMobile.value || focused.value ? selectedSolution.value?.key : undefined))
const filteredEntries = computed(() => entries.value.filter((entry) => matchesSearch(entry) || entry.key === keptKey.value))
const filteredOrphans = computed(() => orphans.value.filter((orphan) => matchesSearch(orphan) || orphan.key === keptKey.value))
const canGuide = computed(() => session.value === 'create' || selectedSolution.value?.kind === 'simple' || selectedSolution.value?.kind === 'group')
const guideOpen = computed(() => (session.value !== undefined && canGuide.value) || (firstInstall.value && !selectedSolution.value))
// 关掉检查器就是关掉：列表占满整个工作台，选一行再打开（审计 A17） / Closing the inspector closes it: the list takes the whole workbench until a row is chosen (audit A17)
const inspectorClosed = computed(() => !guideOpen.value && !selectedSolution.value)
const searchInput = ref<HTMLInputElement | null>(null)

// 检查器里的错误点名一个入口时，列表滚到那一行、闪一下（审计第二轮 B3） / When an inspector error names an entry, the list scrolls to that row and flashes it (audit round 2, B3)
const flashKey = ref<string>()
let flashTimer: ReturnType<typeof setTimeout> | undefined
async function revealEntry(selectorIndex: number): Promise<void> {
  const solution = entries.value.find((item) => item.selectorIndex === selectorIndex)
  if (!solution) return
  // 只清掉搜索，不把焦点拽进搜索框：键盘用户还在检查器里改这一项（审计第三轮 C2）
  // Clear the search without pulling focus into the box: a keyboard user is still fixing the draft in the inspector (audit round 3, C2)
  if (query.value && !matchesSearch(solution)) query.value = ''
  flashKey.value = undefined
  await nextTick()
  flashKey.value = solution.key
  document.querySelector<HTMLElement>(`[data-entry-key="${CSS.escape(solution.key)}"]`)?.scrollIntoView({ block: 'nearest' })
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => { flashKey.value = undefined }, 1400)
}

function clearSearch(): void {
  query.value = ''
  searchInput.value?.focus()
}
// 窄屏首次安装：检查器平时不显示，起点就直接列在列表里，点一个就带着它打开全屏层（审计 B9）
// Narrow first install: the inspector is hidden until opened, so the starting points sit in the list itself and one tap opens the layer with it chosen (audit B9)
const startTemplates = computed(() => SOLUTION_TEMPLATES.filter((template) => (
  template.id !== 'domain_mapping'
  && (!template.requiresCapability || props.capabilities.includes(template.requiresCapability))
)).map((template) => ({ ...template, description: solutionTemplateDescription(config.value, template) })))
const startTemplate = ref<SolutionTemplateId | undefined>()
function startWith(template?: SolutionTemplateId, event?: Event): void {
  // 起点只是一个入口，不留选中：关掉全屏层回来还能再点同一个 / A start is a way in, not a lasting choice: after closing the layer the same one can be tapped again
  if (event?.target instanceof HTMLInputElement) event.target.checked = false
  startTemplate.value = template
  void selectSolution('create')
}
// 搜索只在有东西可搜时出现 / Search appears only when there is something to search
const searchable = computed(() => entries.value.length + orphans.value.length > 1)

watch(localDirty, (value) => emit('dirty', value), { flush: 'sync' })
watch(session, (value) => emit('open', value && value !== 'create' ? value.key : undefined), { immediate: true })
watch([focused, isMobile], ([value, mobile]) => emit('editing', value && mobile), { flush: 'sync' })

function resize(event: MediaQueryListEvent): void { isMobile.value = event.matches }
// 列表的样子记下来给下次的骨架用：字体到了以后记一次，离开这一页或关掉页面时再记一次（审计第五轮 B1）。
// 只记骨架画得出来的宽度：桌面上检查器关着时列表铺满工作台，骨架总留着检查器那一栏，这时不记（审计第六轮 C1）
// The list's shape is recorded for the next skeleton: once the fonts are in, and again on leaving the page or closing it (audit round 5, B1).
// Only a width the skeleton can have is recorded: on desktop a closed inspector lets the list span the workbench, while the skeleton
// always keeps the inspector column, so nothing is recorded then (audit round 6, C1)
// 看屏幕上的样子，不看状态：去自由编辑时状态先变成「检查器关着」，屏幕上的列表却还带着检查器那一栏（审计第七轮 C2）
// Judged by the layout on screen, not the state: leaving for 自由编辑 flips the state to 'inspector closed' first, while the list on screen still has the inspector column (audit round 7, C2)
function rememberShape(): void {
  if (!routes.value || query.value) return
  if (!isMobile.value && routes.value.closest('.workbench')?.classList.contains('is-closed')) return
  rememberListShape(routes.value)
}
onMounted(() => {
  mobileViewport.addEventListener('change', resize)
  window.addEventListener('pagehide', rememberShape)
  void document.fonts.ready.then(rememberShape)
})
onBeforeUnmount(() => {
  rememberShape()
  mobileViewport.removeEventListener('change', resize)
  window.removeEventListener('pagehide', rememberShape)
})

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

// 入口行的第二行：去哪个 Pipeline、做什么。Pipeline ID 和地址是机器值，等宽、不从中间断开（规范 1.5）。
// An entry's second line: which Pipeline and what it does. The Pipeline ID and addresses are machine values, mono and never split (spec 1.5).
// 列表停下来时不停在说明那一行的中间：上沿切着半行小字，在工具栏下面像一道虚线。离哪头近就停到哪头，整句露出来或整句藏起来（审计第六轮 A2）。
// 手机上翻的是整页，这个列表不滚，这里不起作用
// The list never comes to rest inside the order note: an edge through half a line of small text reads as a dotted line under the toolbar.
// It settles at whichever end is nearer, showing the whole sentence or hiding it (audit round 6, A2). On a phone the page scrolls, not this list
let settleTimer = 0
function settleNote(event: Event): void {
  const scroller = event.currentTarget as HTMLElement
  window.clearTimeout(settleTimer)
  settleTimer = window.setTimeout(() => {
    const note = scroller.querySelector('.workbench-order-note')
    if (!note) return
    const end = note.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + scroller.scrollTop
    const top = scroller.scrollTop
    if (top <= 0.5 || top >= end - 0.5) return
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    scroller.scrollTo({ top: top < end / 2 ? 0 : end, behavior })
  }, 120)
}
onBeforeUnmount(() => window.clearTimeout(settleTimer))

function solutionName(solution: DnsSolution): Phrase {
  return solution.selector ? entryNamePhrase(solution.selector.matchers, solution.selector.matcher_operator) : phrase(solutionEntry(solution))
}

function solutionAction(solution: DnsSolution): Phrase {
  if (!solution.pipeline) return phrase(solution.reason ?? '目标 Pipeline 不存在')
  if (solution.kind !== 'simple' || !solution.rule) return phrase(`${solution.pipeline.rules.length} 条规则`)
  return actionsPhrase(solution.rule.actions)
}

function solutionRoute(solution: DnsSolution): Phrase {
  const id = solution.pipeline?.id ?? solution.selector?.pipeline ?? ''
  return join(phrase(id, [id]), ' · ', solutionAction(solution))
}

// 没有入口的 Pipeline 是怎么被用到的：接住其余请求（第一个，且没有兜底入口）、由规则跳转进来，或者未被引用（和入口行的「2 处引用」同一个词）。
// How a Pipeline without an entry gets used: it catches the rest (the first one, when no entry catches all), rules jump into it, or nothing references it.
function orphanRole(solution: DnsSolution): string {
  return pipelineRole(config.value, solution.pipeline?.id ?? '') ?? ''
}

// 列表里的那一行：它是兜底时，列表最后一句已经写了「其余请求 → 它」，这里只写规则数，不重复。
// In the list: when it is the fallback, the list's last line already says so; only the rule count here.
function orphanListMeta(solution: DnsSolution): string {
  const rules = `${solution.pipeline?.rules.length ?? 0} 条规则`
  return solution.pipeline?.id === fallbackPipeline.value && !catchAll.value ? rules : `${orphanRole(solution)}\u00a0· ${rules}`
}

// 和列表那一行同一个顺序：先说它怎么被用到（审计 A15）。规则数不写：下面就是编了号的规则，只在一条都没有时说一句（审计第七轮 A2）
// Same order as the list row: how it is used first (audit A15). No rule count: the numbered rules follow right below, so only an empty
// Pipeline says so (audit round 7, A2)
function customMeta(solution: DnsSolution): string {
  const rules = solution.pipeline?.rules.length ? '' : '还没有规则'
  if (solution.kind === 'orphan') return [orphanRole(solution), rules].filter(Boolean).join('\u00a0· ')
  const entry = `入口 ${entryNumber(solution)}`
  if (!solution.pipeline) return `${entry}\u00a0· 目标 Pipeline 不存在`
  // 「·」用不换行空格贴着前面的字：换行时它留在行尾，不出现在一行之首（GB/T 15834 5.1.7）
  // The 「·」 is glued to the word before it by a no-break space: on a wrap it ends the line and never starts one (GB/T 15834 5.1.7)
  return [entry, rules, solution.referenceCount > 1 ? `${solution.referenceCount} 处引用` : ''].filter(Boolean).join('\u00a0· ')
}

// 「·」用普通的分隔写法：PhraseText 把它放进前面那一块里，换行时留在上一行的行尾（审计第三轮 C1）
// The ordinary separator: PhraseText puts the 「·」 inside the unit before it, so on a wrap it ends the line above (audit round 3, C1)
function ruleSentence(rule: RuleConfig): Phrase {
  const response = rule.response_matchers.length || rule.response_actions_on_match.length || rule.response_actions_on_miss.length ? ' · 另有响应处理' : ''
  return join(rulePhrase(rule), response)
}

function matchesSearch(solution: DnsSolution): boolean {
  const term = query.value.trim().toLocaleLowerCase()
  return !term || [solution.pipeline?.id, solution.selector?.pipeline, solutionEntry(solution), solutionAction(solution).text].join(' ').toLocaleLowerCase().includes(term)
}

function entryNumber(solution: DnsSolution): string {
  return String(entries.value.findIndex((entry) => entry.selectorIndex === solution.selectorIndex) + 1).padStart(2, '0')
}

async function confirmDiscard(): Promise<boolean> {
  if (!localDirty.value) return true
  return confirm.ask({
    title: '放弃这个入口的修改',
    body: '当前入口还没有应用到配置草稿，离开后这些改动会丢失。草稿里已经应用过的内容不受影响。',
    confirmLabel: '放弃修改',
    cancelLabel: '继续编辑',
    destructive: true,
  })
}

function resetSession(next?: DnsSolution | 'create', focus = false): void {
  const restoreFocus = focused.value && !focus
  localDirty.value = false
  session.value = next
  sessionKey.value += 1
  focused.value = focus
  if (restoreFocus) void nextTick(() => returnFocus?.isConnected && returnFocus.focus({ preventScroll: true }))
}

async function selectSolution(solution: DnsSolution | 'create'): Promise<void> {
  if (solution !== 'create' && selectedSolution.value?.key === solution.key) {
    focused.value = true
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    void focusInspector()
    return
  }
  if (!await confirmDiscard()) return
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  resetSession(solution, true)
  void focusInspector()
}

async function cancel(): Promise<void> {
  if (await confirmDiscard()) resetSession()
}

async function moveSolution(solution: DnsSolution, direction: -1 | 1 | 'first' | 'last'): Promise<void> {
  if (solution.selectorIndex === undefined || !await confirmDiscard()) return
  const position = movable.value.findIndex((entry) => entry.selectorIndex === solution.selectorIndex)
  if (position < 0) return
  const targetPosition = direction === 'first' ? 0 : direction === 'last' ? movable.value.length - 1 : position + direction
  const targetIndex = movable.value[targetPosition]?.selectorIndex
  if (targetIndex === undefined || targetIndex === solution.selectorIndex) return
  const [selector] = config.value.pipeline_select.splice(solution.selectorIndex, 1)
  if (selector) config.value.pipeline_select.splice(targetIndex, 0, selector)
  resetSession(entries.value.find((entry) => entry.selector === selector))
  emit('notice', '入口顺序已更新到草稿，保存配置后生效')
}

async function removeSolution(solution: DnsSolution): Promise<void> {
  if (solution.selectorIndex === undefined || !solution.selector || !await confirmDiscard()) return
  if (!await confirm.ask({
    title: `删除入口 ${solution.selector.pipeline}`,
    body: solution.referenceCount === 1
      ? '这条入口和它独占的 Pipeline 会一起从草稿里移除。保存配置后才会真正生效，在此之前可以放弃草稿撤回。'
      : '这条入口会从草稿里移除；它指向的 Pipeline 还有其他入口在用，会保留下来。保存配置后才会真正生效。',
    confirmLabel: '删除这条入口',
    destructive: true,
  })) return
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

function insertNewDraft(target: KixConfig, draft: SolutionDraft): void {
  const selector = clone(draft.selector)
  if (draft.pipelineMode !== 'reuse') {
    const pipeline = materializePipeline(draft)
    selector.pipeline = pipeline.id
    target.pipelines.push(pipeline)
  }
  target.pipeline_select.splice(solutionInsertIndex(target, selector), 0, selector)
}

// 把检查器交出的草稿写进一份配置：「应用到草稿」写进草稿本身，数「改了几处」时写进它的副本。
// 改的是已有入口时返回它写完后的位置，写不进去时返回 null
// Writes the inspector's drafts into a config: 应用到草稿 writes the draft itself, counting changes writes a copy of it.
// Editing an existing entry returns where it ends up; null when nothing could be written
function writeDrafts(target: KixConfig, editing: DnsSolution | undefined, drafts: SolutionDraft[]): number | undefined | null {
  if (!editing) {
    for (const draft of drafts) insertNewDraft(target, draft)
    return undefined
  }
  const draft = drafts[0]
  if (!draft || editing.selectorIndex === undefined) return null
  const selector = clone(draft.selector)
  if (draft.pipelineMode === 'owned' || draft.pipelineMode === 'shared') {
    const pipelineIndex = target.pipelines.findIndex((pipeline) => pipeline.id === draft.existingPipelineId)
    if (pipelineIndex >= 0) {
      const pipeline = materializePipeline(draft)
      pipeline.id = draft.existingPipelineId ?? pipeline.id
      selector.pipeline = pipeline.id
      target.pipelines.splice(pipelineIndex, 1, pipeline)
    }
  } else if (draft.pipelineMode === 'copy') {
    const pipeline = materializePipeline(draft)
    target.pipelines.push(pipeline)
    selector.pipeline = pipeline.id
  }
  target.pipeline_select.splice(editing.selectorIndex, 1, selector)
  // 条件删光的入口匹配所有请求：挪到最后兜底，和添加时一样；留在中间，它后面的入口都轮不到（审计第三轮）
  // An entry with no conditions left matches every request: it moves to the end as the fallback, as when adding; left in the
  // middle, every entry after it would be unreachable (audit round 3)
  let selectorIndex = editing.selectorIndex
  if (selectorMatchesEveryRequest(selector) && selectorIndex < target.pipeline_select.length - 1) {
    target.pipeline_select.splice(selectorIndex, 1)
    selectorIndex = target.pipeline_select.push(selector) - 1
  }
  if (draft.pipelineMode === 'reuse' && editing.referenceCount === 1 && editing.pipelineIndex !== undefined) target.pipelines.splice(editing.pipelineIndex, 1)
  return selectorIndex
}

function saveDrafts(drafts: SolutionDraft[]): void {
  const editing = selectedSolution.value
  const selectorIndex = writeDrafts(config.value, editing, drafts)
  if (!editing) {
    resetSession(entries.value.find((entry) => entry.selector?.pipeline === drafts[0]?.selector.pipeline))
    if (!quietApply) emit('notice', `已将 ${drafts.length} 个入口加入草稿，保存配置后生效`)
    return
  }
  if (selectorIndex == null) return
  resetSession(entries.value.find((entry) => entry.selectorIndex === selectorIndex))
  const draft = drafts[0]!
  if (!quietApply) emit('notice', draft.pipelineMode === 'shared' ? '共享流程的修改已应用到草稿，保存配置后生效' : '入口修改已应用到草稿，保存配置后生效')
}

// 行尾的墨点：草稿里改过的，加上检查器里正在改、还没应用的那一行。保存会把它一起存进去，墨点和保存栏的「几处」对得上（规范第 11 节）
// The rows' ink dot: changed in the draft, plus the row the inspector is editing without applying yet. A save takes it along, so the
// dots agree with the save bar's count (spec section 11)
function isChanged(solution: DnsSolution): boolean {
  return Boolean(props.changed?.has(solution.key)) || (localDirty.value && selectedSolution.value?.key === solution.key)
}

// 检查器里没应用的修改写进草稿之后的样子。页面拿它数「改了几处」：保存会把这些修改一起存进去（规范第 11 节）
// The draft as it would be with the inspector's unapplied edits written in. The page counts changes from it, since a save takes
// these edits along (spec section 11)
const pendingConfig = computed<KixConfig | null>(() => {
  const drafts = localDirty.value ? guide.value?.pendingDrafts : undefined
  if (!drafts?.length) return null
  const target = clone(config.value)
  writeDrafts(target, selectedSolution.value, drafts)
  return target
})

async function openManual(pipelineId?: string): Promise<void> {
  if (!await confirmDiscard()) return
  resetSession()
  emit('manual', pipelineId)
}

// 兜底入口（匹配所有请求）钉在最后：它不能往上挪，别的入口也不能挪到它下面，否则挪过去的那个永远命中不了。
// The catch-all entry stays last: it cannot move up and nothing can move below it, or whatever moved there would never match.
const movable = computed(() => entries.value.filter((entry) => !entry.selector || !selectorMatchesEveryRequest(entry.selector)))
// 有兜底入口钉在最后时，「移到最后」其实是挪到它前面：照放置那句的说法写出来（审计第七轮 A3）
// With a catch-all pinned last, 移到最后 really moves in front of it: say so, as the placement line does (audit round 7, A3)
// 只在兜底确实是最后一个入口时这样写：兜底夹在中间时「移到最后」真的会挪到它后面（审计第八轮 C1）
// Only when the catch-all really is the last entry: with one in the middle, 移到最后 does move past it (audit round 8, C1)
const lastLabel = computed(() => {
  const last = entries.value.at(-1)
  return last?.selector && selectorMatchesEveryRequest(last.selector)
    ? `移到「${summarizeMatchers(last.selector.matchers, last.selector.matcher_operator, 'selector')}」前面`
    : '移到最后'
})

function entryMenuItems(solution: DnsSolution): UiMenuItem[] {
  const pinned = !movable.value.some((entry) => entry.key === solution.key)
  const first = pinned || solution.key === movable.value[0]?.key
  const last = pinned || solution.key === movable.value.at(-1)?.key
  return [
    { value: 'first', label: '移到最前', icon: ArrowUpToLine, disabled: first },
    { value: 'up', label: '上移', icon: ArrowUp, disabled: first },
    { value: 'down', label: '下移', icon: ArrowDown, disabled: last },
    { value: 'last', label: lastLabel.value, icon: ArrowDownToLine, disabled: last },
    { value: 'remove', label: '删除入口', icon: Trash2, danger: true },
  ]
}

function onEntryMenu(solution: DnsSolution, value: string): void {
  if (value === 'remove') void removeSolution(solution)
  else void moveSolution(solution, value === 'up' ? -1 : value === 'down' ? 1 : value === 'first' ? 'first' : 'last')
}

async function openMapping(): Promise<void> {
  if (!await confirmDiscard()) return
  resetSession()
  emit('mapping')
}

// 页面保存前调用：检查器里有没应用的修改就替人按「应用到草稿」。表单完整返回 true（修改已进草稿），缺东西返回 false（已标出来）
// Called by the page before a save: unapplied inspector edits are applied as if 应用到草稿 were pressed. Returns true when the form was
// complete (the edit is in the draft), false when something is missing (now marked)
function applyPending(): boolean {
  if (!localDirty.value || !guide.value) return true
  quietApply = true
  try {
    return guide.value.submit()
  } finally {
    quietApply = false
  }
}

defineExpose({ confirmDiscard, applyPending, pendingConfig })
</script>

<template>
  <section class="workbench" :class="{ 'is-closed': inspectorClosed }" :data-config-editing="focused ? 'true' : undefined" aria-label="解析编排工作台">
    <div ref="routes" class="workbench-routes" :inert="focused && isMobile">
      <header class="workbench-list-toolbar">
        <label v-if="searchable" class="ui-input workbench-search"><Search :size="16" aria-hidden="true" /><input ref="searchInput" v-model="query" type="search" aria-label="搜索入口或 Pipeline" placeholder="搜索入口、Pipeline"><button v-if="query" class="ui-input__affix" type="button" aria-label="清除搜索" title="清除搜索" @click.prevent="clearSearch"><X :size="14" aria-hidden="true" /></button></label>
        <button class="ui-btn ui-btn--text workbench-manual" type="button" @click="openManual()"><Settings2 :size="16" aria-hidden="true" />自由编辑</button>
        <!-- 首次安装时起点列表一直在屏幕上（宽屏在检查器里，手机在列表里），「添加入口」就不再重复一遍（审计第四轮 B4）
             On first install the start list is always on screen (in the inspector on wide screens, in the list on a phone), so 添加入口 does not repeat it (audit round 4, B4) -->
        <button v-if="!firstInstall" class="ui-btn ui-btn--secondary workbench-create" type="button" :aria-current="session === 'create' ? 'true' : undefined" @click="startWith()"><Plus :size="16" aria-hidden="true" />添加入口</button>
      </header>
      <div class="workbench-route-scroll" @scroll.passive="settleNote">
        <!-- 顺序就是这张列表本身：域名映射钉在最前（它先于所有入口匹配），下面按序号往下，最后一行写都没命中的请求去哪。
             The order is the list itself: domain mappings pinned first (they match before any entry), entries by
             number, and a last line saying where unmatched requests go. -->
        <p v-if="entries.length && !query" class="workbench-order-note">{{ ENTRY_ORDER_NOTE }}</p>
        <button v-if="mappingCount && !query" class="workbench-row workbench-mapping-row" type="button" @click="openMapping">
          <span class="workbench-entry-number"><Zap :size="14" aria-hidden="true" /></span>
          <span class="workbench-entry-body"><span class="workbench-entry-condition">域名映射&nbsp;· {{ mappingCount }} 条</span><span class="workbench-entry-route">最先匹配，命中直接返回 CNAME</span></span>
          <ChevronRight class="workbench-row-chevron" :size="16" aria-hidden="true" />
        </button>
        <ol v-if="filteredEntries.length" class="workbench-entry-list">
          <li v-for="solution in filteredEntries" :key="solution.key" class="workbench-item workbench-entry" :class="{ 'is-selected': selectedSolution?.key === solution.key, 'is-flash': flashKey === solution.key, 'is-kept': query && !matchesSearch(solution) }" :data-entry-key="solution.key">
            <button class="workbench-entry-select" type="button" :aria-label="`编辑入口 ${entryNumber(solution)} ${solution.selector?.pipeline}`" :aria-description="isChanged(solution) ? '已修改' : undefined" :aria-pressed="selectedSolution?.key === solution.key" @click="selectSolution(solution)">
              <span class="workbench-entry-number">{{ entryNumber(solution) }}</span>
              <span class="workbench-entry-body">
                <span class="workbench-entry-condition"><PhraseText :phrase="solutionName(solution)" :mono="false" /></span>
                <span class="workbench-entry-route"><ArrowRight :size="14" aria-hidden="true" /><PhraseText :phrase="solutionRoute(solution)" :trail="solution.referenceCount > 1" /><span v-if="solution.referenceCount > 1" class="workbench-entry-refs">{{ ' ' }}<span>{{ solution.referenceCount }} 处引用</span></span></span>
              </span>
              <span v-if="isChanged(solution)" class="ui-dot ui-dot--ink workbench-entry-dot" aria-hidden="true"></span>
            </button>
            <UiMenu class="workbench-entry-menu" anchor=".workbench-item" :label="`入口 ${entryNumber(solution)} 操作`" :title="`入口 ${entryNumber(solution)}\u00a0· ${solutionName(solution).text}`" :items="entryMenuItems(solution)" @select="onEntryMenu(solution, $event)" />
          </li>
        </ol>
        <p v-if="fallbackPipeline && !catchAll && !query" class="workbench-fallback" :class="{ 'is-first': firstInstall }">
          <template v-if="firstInstall">没有入口时，请求都交给 <code>{{ fallbackPipeline }}</code>。</template>
          <template v-else><span class="workbench-entry-number" aria-hidden="true"></span><span>其余请求 <ArrowRight :size="14" aria-hidden="true" /><span class="visually-hidden">交给</span> <code>{{ fallbackPipeline }}</code></span></template>
        </p>
        <!-- 手机上起点直接列在这里，和下面「没有入口的 Pipeline」一样先写组标题（审计第二轮 B13）
             On a phone the starts are listed here, titled like the 没有入口的 Pipeline group below (audit round 2, B13) -->
        <section v-if="firstInstall && isMobile && !query" class="workbench-starts" aria-labelledby="workbench-starts-title">
          <h3 id="workbench-starts-title">添加第一个入口</h3>
          <div class="ui-pick" role="radiogroup" aria-labelledby="workbench-starts-title">
            <label v-for="template in startTemplates" :key="template.id" class="ui-pick__opt">
              <input type="radio" name="workbench-start" @change="startWith(template.id, $event)">
              <b>{{ template.name }}</b><small>{{ template.description }}</small>
            </label>
          </div>
        </section>
        <p v-if="query && filteredEntries.length === 0 && filteredOrphans.length === 0" class="workbench-empty">没有匹配的入口或 Pipeline</p>
        <section v-if="filteredOrphans.length" class="workbench-orphans" aria-labelledby="workbench-orphans-title">
          <h3 id="workbench-orphans-title">没有入口的 Pipeline</h3>
          <ul>
            <li v-for="solution in filteredOrphans" :key="solution.key" class="workbench-item workbench-orphan" :class="{ 'is-selected': selectedSolution?.key === solution.key }">
              <button class="workbench-entry-select" type="button" :aria-description="isChanged(solution) ? '已修改' : undefined" :aria-pressed="selectedSolution?.key === solution.key" @click="selectSolution(solution)">
                <span class="workbench-entry-number"><GitBranch :size="14" aria-hidden="true" /></span>
                <span class="workbench-entry-body"><code class="workbench-entry-condition">{{ solution.pipeline?.id }}</code><span class="workbench-entry-route">{{ orphanListMeta(solution) }}</span></span>
                <span v-if="isChanged(solution)" class="ui-dot ui-dot--ink workbench-entry-dot" aria-hidden="true"></span>
              </button>
            </li>
          </ul>
        </section>
      </div>
    </div>
    <aside ref="inspector" class="workbench-inspector" :role="focused && isMobile ? 'dialog' : 'complementary'" :aria-modal="focused && isMobile ? true : undefined" aria-label="入口编辑器" @keydown.esc.stop="cancel" @keydown.tab="trapMobileFocus">
      <SolutionGuide v-if="guideOpen" ref="guide" :key="sessionKey" class="ui-rise" embedded :can-reveal="!isMobile" :page-saves="!isMobile" @reveal="revealEntry" :closable="!firstInstall || isMobile" :entry-label="selectedSolution ? `入口 ${entryNumber(selectedSolution)}` : undefined" :config="config" :solution="selectedSolution" :capabilities="capabilities" :start="session === 'create' ? startTemplate : undefined" @dirty="localDirty = $event" @cancel="cancel" @save="saveDrafts" />
      <!-- 表单改不了的写法（多条规则、没有入口的 Pipeline）：检查器是浏览面，一行一条规则，最后一个去自由编辑的按钮（规范 3.3）。
           A shape the form cannot edit (several rules, a Pipeline without an entry): the inspector is a browse
           surface, one rule per line, and a button into 自由编辑 at the end (spec 3.3). -->
      <section v-else-if="selectedSolution" :key="selectedSolution.key" class="workbench-custom ui-rise" aria-labelledby="workbench-custom-title">
        <header class="workbench-custom__head">
          <h2 id="workbench-custom-title"><code>{{ selectedSolution.pipeline?.id ?? selectedSolution.selector?.pipeline }}</code></h2>
          <button class="ui-icon-btn" type="button" aria-label="关闭" title="关闭" @click="cancel"><X :size="16" /></button>
        </header>
        <div class="workbench-custom__body">
          <p class="workbench-custom__meta">{{ customMeta(selectedSolution) }}</p>
          <ol v-if="selectedSolution.pipeline?.rules.length" class="workbench-custom__rules">
            <li v-for="(rule, index) in selectedSolution.pipeline.rules" :key="index">
              <span class="workbench-entry-number">{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="workbench-entry-body"><code class="workbench-entry-condition">{{ rule.name }}</code><span class="workbench-entry-route"><PhraseText :phrase="ruleSentence(rule)" /></span></span>
            </li>
          </ol>
          <button class="ui-btn ui-btn--text workbench-custom__edit" type="button" @click="openManual(selectedSolution.pipeline?.id)"><Settings2 :size="16" aria-hidden="true" />在自由编辑里改</button>
        </div>
      </section>
    </aside>
  </section>
</template>

<style scoped>
/* 工作台只用 tokens.css 的变量。左边是入口列表（浏览面：一行一句话），右边是检查器（编辑面）。
   1024 和 900 宽时检查器分到更大的一份：列表 5 份，检查器至少 26rem、6 份（规范 3.10）。
   Tokens only. The entry list on the left is a browse surface, one sentence per row; the inspector on the
   right is an edit surface. The inspector gets the larger share: 5 : 6, at least 26rem (spec 3.10). */
.workbench { display: grid; grid-template-columns: minmax(0, 5fr) minmax(26rem, 6fr); height: var(--workbench-h, max(560px, calc(100dvh - 318px))); color: var(--l-ink); background: var(--l-surface); }
/* 高度跟着保存栏升降一起变；第一次量完之前不带过渡 / The height follows the save bar's rise and fall, without a transition before the first measurement */
[data-measured] .workbench { transition: height var(--m-base) var(--ease-out); }
/* 检查器关着：列表占满整个工作台 / Inspector closed: the list takes the whole workbench */
.workbench.is-closed { grid-template-columns: minmax(0, 1fr); }
.workbench.is-closed .workbench-routes { border-right: 0; }
.workbench.is-closed .workbench-inspector { display: none; }
.workbench-routes { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 1px solid var(--l-hair); container-type: inline-size; }
.workbench-list-toolbar { display: flex; align-items: center; flex: 0 0 auto; gap: var(--s-2); padding: var(--s-4) var(--s-4) var(--s-2); }
.workbench-search { flex: 1 1 auto; max-width: 20rem; }
.workbench-search > svg { flex-shrink: 0; color: var(--l-ink-3); }
.workbench-manual { margin-left: auto; }
/* 没有搜索框时（首次安装）每个宽度都一个排法：「自由编辑」往回收到内容的左边线，「添加入口」靠右（审计第三轮 B12）
   Without the search box (first install) every width uses one arrangement: 自由编辑 pulled back to the content edge, 添加入口 on the right (audit round 3, B12) */
.workbench-list-toolbar:not(:has(.workbench-search)) .workbench-manual { margin-left: calc(var(--s-2) * -1); margin-right: auto; }
/* 列表窄于一行放得下搜索、自由编辑、添加入口时，搜索单独一行，占位字不会被截成「搜索入口、」（审计 A5）
   When the list is too narrow for search, 自由编辑 and 添加入口 on one line, search takes its own row, so the placeholder is never cut to 「搜索入口、」 (audit A5) */
@container (max-width: 27rem) {
  .workbench-list-toolbar { flex-wrap: wrap; }
  .workbench-search { flex: 1 1 100%; max-width: none; }
  /* 「自由编辑」往回收一格，图标落在列表的左边线上；「添加入口」靠右 / 自由编辑 pulled back so its icon sits on the list's edge; 添加入口 to the right */
  .workbench-manual { margin-left: calc(var(--s-2) * -1); margin-right: auto; }
}
/* 列表上边的 4 放在滚动区上，不放在说明上：搜索时说明收起，第一行照样离工具栏 12（审计第三轮 A6）
   The 4 above the list sits on the scroller, not on the note: while searching the note folds away and the first row still sits 12 under the toolbar (audit round 3, A6) */
.workbench-route-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: var(--s-1) var(--s-2) var(--s-5); overscroll-behavior: contain; scroll-padding-block: var(--s-3); }
.workbench-order-note { margin: 0; padding: 0 var(--s-2) var(--s-2); color: var(--l-ink-3); font-size: var(--t-1); }
.workbench-entry-list, .workbench-orphans ul, .workbench-custom__rules { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
/* 入口、没有入口的 Pipeline、域名映射那一行长得一样：序号列、两行字（名称、次要）、行尾。只有入口带 .workbench-entry：
   它是「第几个入口」的计数依据；没有入口的 Pipeline 是 .workbench-orphan。
   Entries, orphan Pipelines and the mapping row share one anatomy: an ordinal column, two lines (name, secondary), the
   row end. Only entries carry .workbench-entry, which is what counts as an entry; orphan Pipelines are .workbench-orphan. */
.workbench-item, .workbench-row { position: relative; display: flex; align-items: center; min-width: 0; border-radius: var(--r-2); transition: background-color var(--m-quick) var(--ease-out); }
@media (hover: hover) { .workbench-item:hover, .workbench-row:hover { background: var(--l-canvas); } }
.workbench-item.is-selected { background: var(--l-sunk); }
/* 被点名的那一行先亮成下沉色，再慢慢退回去 / The named row lights up in the sunk tint, then fades back */
.workbench-item.is-flash { animation: workbench-flash calc(var(--m-slow) * 3) var(--ease-in-out); }
@keyframes workbench-flash { 0%, 40% { background: var(--l-sunk); } }
@media (prefers-reduced-motion: reduce) { .workbench-item.is-flash { animation: none; background: var(--l-sunk); } }
.workbench-entry-select, .workbench-row { flex: 1; min-width: 0; display: grid; grid-template-columns: var(--s-6) minmax(0, 1fr) auto; align-items: center; gap: var(--s-2); padding: var(--s-3) var(--s-2); border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
/* 入口行平时只有两格，路线拿到整行的宽度，放得下的地址不会被挤断（审计第三轮 A3）。墨点放在哪看设备：能悬停的，它就在「…」那一格里，
   和「…」轮流出现；触屏上「…」一直在，墨点在它左边另占一格（手机上贴着 44 宽的那一格放，不占宽度）。没有入口的 Pipeline 没有「…」，
   墨点在它自己那一格里，和「›」「…」一样宽
   An entry row normally has two tracks, so the route gets the full width and an address that fits is not split (audit round 3, A3). Where the
   dot goes depends on the device: with hover it lives in the 「…」 cell and takes turns with the 「…」; on touch the 「…」 always shows and the dot
   takes a track to its left (on a phone it sits against the 44-wide cell and takes no width). An orphan Pipeline has no 「…」: its dot sits in
   a track of its own, as wide as the 「›」 and 「…」 cells */
.workbench-entry-select { grid-template-columns: var(--s-6) minmax(0, 1fr); }
.workbench-orphan .workbench-entry-select:has(> .workbench-entry-dot) { grid-template-columns: var(--s-6) minmax(0, 1fr) var(--h-sm); }
@media (hover: none) {
  .workbench-entry .workbench-entry-select:has(> .workbench-entry-dot) { grid-template-columns: var(--s-6) minmax(0, 1fr) auto; }
}
.workbench-row { width: 100%; }
/* 域名映射那一行和下面的入口也隔 2，和列表里的行一样：选中和指到时的底色不连成一块（审计第五轮 B1）
   The mapping row keeps the list's 2 from the entry below, so selected and hover grounds never merge (audit round 5, B1) */
.workbench-mapping-row { margin-bottom: 2px; }
/* 检查器在「添加入口」时，工具栏的这个按钮和选中的行一样铺凹槽底：列表这边也看得出右边开着的是什么（审计第七轮 B3）
   While the inspector shows 添加入口, this toolbar button takes the selected row's sunk fill, so the list side shows what the pane holds (audit round 7, B3) */
/* 用 aria-current 说「右边开着的就是它」，不用 aria-pressed：再按一次不会把它关掉，不是开关（审计第八轮 C8）
   aria-current says the pane shows this, not aria-pressed: pressing again does not close it, so it is no toggle (audit round 8, C8) */
.workbench-create[aria-current="true"] { background: var(--l-sunk); }
.workbench-entry-number { display: inline-flex; align-self: start; padding-top: 2px; color: var(--l-ink-3); font-family: var(--f-mono); font-size: var(--t-1); font-variant-numeric: tabular-nums; }
.workbench-item.is-selected .workbench-entry-number { color: var(--l-ink); }
/* 搜索时留在列表里的那一行只是因为检查器正开着它：连序号在内整行变淡，看得出它不是搜到的；写在选中规则后面才压得住它（审计第二轮 A1、第三轮 A2）
   The row kept while searching only because the inspector has it open is dimmed, ordinal included, so it does not read as a hit; it comes after the selected rule so it wins (audit round 2 A1, round 3 A2) */
.workbench-item.is-kept :is(.workbench-entry-number, .workbench-entry-condition, .workbench-entry-route) { color: var(--l-ink-3); }
/* 它的「…」也变淡；指到、聚焦或菜单开着时照常，看得出还能点（审计第四轮 A4） / Its 「…」 dims too, back to normal on hover, focus or while open, so it still looks usable (audit round 4, A4) */
.workbench-item.is-kept:not(:hover, :has(:focus-visible)) .workbench-entry-menu :deep(.ui-icon-btn:not([aria-expanded="true"])) { color: var(--l-ink-3); }
.workbench-entry-body { min-width: 0; display: grid; gap: 2px; }
.workbench-entry-condition { color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-medium); }
code.workbench-entry-condition { font-family: var(--f-mono); }
.workbench-entry-route { color: var(--l-ink-2); font-size: var(--t-2); text-wrap: pretty; }
.workbench-entry-route > svg { margin-right: var(--s-1); color: var(--l-ink-3); vertical-align: -2px; }
/* 「→」挂在外面：路线折行时续行从箭头后面的字开始，不回到箭头下面（审计第三轮 B9）。缩进会继承，里面的块要清零。
   手机上的列表（窄于 24rem）不挂：让出这 18 像素，「转发至 223.5.5.5:53 (TCP+UDP)」就得拆成三行，比续行对不齐更糟
   The 「→」 hangs outside: a wrapped route continues under the text after the arrow, not under the arrow (audit round 3, B9). The indent
   inherits, so blocks inside reset it. A phone's list (narrower than 24rem) does not hang it: giving up those 18px would split
   「转发至 223.5.5.5:53 (TCP+UDP)」 over three lines, which is worse than a continuation that starts under the arrow */
@container (min-width: 24rem) {
  .workbench-entry .workbench-entry-route { padding-inline-start: calc(var(--size-icon-sm) + var(--s-1)); text-indent: calc((var(--size-icon-sm) + var(--s-1)) * -1); }
  .workbench-entry .workbench-entry-route :deep(*) { text-indent: 0; }
}
/* 「2 处引用」换行时整个挪下去；它前面的「·」由路线那句挂在自己末尾，留在上一行的行尾
   「2 处引用」 wraps as one unit; the 「·」 before it hangs off the end of the route sentence and stays at the end of the line above */
.workbench-entry-refs > span { white-space: nowrap; }
/* 「›」占一个和「…」一样大的格子、右边留同样的 8：两者圆心在同一条竖线上（审计第二轮 A5、B8）
   The 「›」 takes a cell as wide as the 「…」 button with the same 8 on its right, so both centre on one line (audit round 2, A5, B8) */
.workbench-row-chevron { margin-inline: calc((var(--h-sm) - var(--size-icon)) / 2); color: var(--l-ink-3); }
.workbench-entry-menu { flex: 0 0 auto; margin-right: var(--s-2); }
/* 没有入口的 Pipeline 没有「…」：墨点居中在和「›」「…」一样宽的格子里，行尾的记号在同一条竖线上
   An orphan Pipeline has no 「…」: its ink dot centres in a cell as wide as the 「›」 and 「…」 cells, so row-end marks share one line */
.workbench-orphan .workbench-entry-dot { justify-self: center; }
/* 「…」在能悬停的设备上只在指到、聚焦、选中或菜单开着时出现；触屏上一直显示（规范 2.10）。
   On hover devices the … shows on hover, focus, selection or while open; always on touch (spec 2.10). */
@media (hover: hover) {
  .workbench-entry-menu :deep(.ui-icon-btn) { opacity: 0; transition: opacity var(--m-quick) var(--ease-out); }
  /* 键盘聚焦才亮出「…」：点完关掉检查器、焦点回到这一行时，不会单独剩一个「…」（审计第二轮 A9）
   Keyboard focus reveals the 「…」; focus returned to the row after a pointer interaction does not leave a lone 「…」 (audit round 2, A9) */
  .workbench-item:is(:hover, :has(:focus-visible)) .workbench-entry-menu :deep(.ui-icon-btn), .workbench-entry-menu :deep(.ui-icon-btn[aria-expanded="true"]) { opacity: 1; }
  /* 墨点在「…」那一格正中，和映射行的「›」在同一条竖线上；指到、键盘聚焦或菜单开着时「…」换上来，墨点让开（审计第三轮 A5）
     The ink dot sits in the middle of the 「…」 cell, on the mapping row's 「›」 line; on hover, keyboard focus or an open menu the 「…」 takes its place (audit round 3, A5) */
  .workbench-entry .workbench-entry-dot { position: absolute; top: 50%; right: calc(var(--s-2) + (var(--h-sm) - var(--size-dot)) / 2); translate: 0 -50%; transition: opacity var(--m-quick) var(--ease-out); }
  .workbench-entry:is(:hover, :has(:focus-visible), :has([aria-expanded="true"])) .workbench-entry-dot { opacity: 0; }
}
/* 「选中」只在检查器看得见的宽度上算数；窄屏上检查器关着，选中那一行不该单独亮出「…」
   Selection counts only where the inspector is visible; on a narrow screen it is closed, so the selected row gets no standing … */
@media (hover: hover) and (min-width: 861px) {
  /* 选中的那一行改过时，那一格留给墨点，「…」指到才出来 / A selected row that changed keeps the cell for its dot; the 「…」 comes on hover */
  .workbench-item.is-selected:not(:has(.workbench-entry-dot)) .workbench-entry-menu :deep(.ui-icon-btn) { opacity: 1; }
}
/* 列表窄的时候（手机、1100 以下的双栏）不写「· 2 处引用」：路线已经占了两行，再多一行只剩这几个字；共享与否在检查器的「流程设置」里写着。
   30rem：1024 宽的列表（约 28rem）也算窄（审计第二轮 S4）
   In a narrow list (phones, the split view below 1100) the route drops 「· 2 处引用」: the route already takes two lines and a third
   would hold only those words; whether the Pipeline is shared is stated in the inspector's 流程设置. 30rem, so the list at 1024
   (about 28rem) counts as narrow (audit round 2, S4) */
@container (max-width: 30rem) {
  .workbench-entry-refs, .workbench-entry-route :deep(.phrase__trail) { display: none; }
}
/* 列表的最后一句：都没命中的请求去哪。对齐名称那一列，用次要的颜色，不是一行能点的东西。
   The list's last line: where unmatched requests go. It lines up with the name column in the secondary colour and is not clickable. */
.workbench-fallback { display: grid; grid-template-columns: var(--s-6) minmax(0, 1fr); gap: var(--s-2); margin: var(--s-1) 0 0; padding: var(--s-2) var(--s-2); color: var(--l-ink-2); font-size: var(--t-2); }
.workbench-fallback svg { color: var(--l-ink-3); vertical-align: -2px; }
.workbench-fallback code { color: var(--l-ink); font-family: var(--f-mono); }
.workbench-fallback.is-first { display: block; margin: var(--s-2) 0 0; color: var(--l-ink); font-size: var(--t-3); }
.workbench-starts { margin-top: var(--s-6); }
/* 组标题和下面第一行之间 8：选中的那一行铺底色时，底色离标题的字 12 上下，不贴着（审计第四轮 A3）
   8 between a group title and its first row: a selected row's fill then starts about 12 under the title glyphs instead of touching them (audit round 4, A3) */
.workbench-starts h3 { margin: 0 0 var(--s-2); padding: 0 var(--s-2); color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-bold); }
/* 起点排在列表的格子上：单选框在序号那一列，名字和说明从名字那一列开始，和下面的「default」、载入后的入口名对齐（审计第六轮 B3）
   The starts sit on the list's grid: the radio in the ordinal column, titles and descriptions from the name column, lined up with
   「default」 below and with entry names once loaded (audit round 6, B3) */
.workbench-starts .ui-pick { margin-inline: 0; }
.workbench-starts .ui-pick__opt { grid-template-columns: var(--s-6) minmax(0, 1fr); padding-inline: var(--s-2); }
.workbench-empty { margin: 0; padding: var(--s-6) var(--s-4); color: var(--l-ink-3); font-size: var(--t-3); text-align: center; }
.workbench-orphans { margin-top: var(--s-6); }
.workbench-orphans h3 { margin: 0 0 var(--s-2); padding: 0 var(--s-2); color: var(--l-ink); font-size: var(--t-3); font-weight: var(--w-bold); }
.workbench-inspector { min-width: 0; min-height: 0; height: 100%; overflow: hidden; }
/* 浏览面检查器：头部和编辑面一样（区块标题 + 关闭），下面一行元数据，再是规则的句子 / Browse inspector: the same header, a meta line, then the rules */
.workbench-custom { display: flex; flex-direction: column; height: 100%; }
.workbench-custom__head { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); padding: var(--s-4) var(--s-5); border-bottom: 1px solid var(--l-hair); }
.workbench-custom__head h2 { min-width: 0; margin: 0; font-size: var(--t-4); font-weight: var(--w-bold); line-height: var(--lh-tight); overflow-wrap: anywhere; }
.workbench-custom__head code { font-family: var(--f-mono); }
/* 四边都是 24，和入口检查器的第一组离头部一样远：两种检查器之间切换，内容不上下跳（规范 6.4，审计第三轮 A7）
   24 on every side, as far below the header as the entry inspector's first group, so switching inspectors does not shift the content (spec 6.4, audit round 3, A7) */
.workbench-custom__body { flex: 1; min-height: 0; overflow-y: auto; display: grid; align-content: start; justify-items: start; gap: var(--s-3); padding: var(--s-5); }
.workbench-custom__meta { margin: 0; color: var(--l-ink-2); font-size: var(--t-2); }
.workbench-custom__rules { width: 100%; }
.workbench-custom__rules > li { display: grid; grid-template-columns: var(--s-6) minmax(0, 1fr); gap: var(--s-2); padding: var(--s-2) 0; }
/* 「在自由编辑里改」上下往回收：看不见的留白不算，字离最后一条规则 24 上下（规范 6.5，审计第四轮 A2）
   在自由编辑里改 is pulled back above and below: its invisible padding does not count, so its text sits about 24 under the last rule (spec 6.5, audit round 4, A2) */
.workbench-custom__edit { margin-block: calc((1lh - var(--h-md)) / 2); margin-inline-start: calc(var(--s-2) * -1); }
@media (max-width: 860px) {
  .workbench { display: block; height: auto; }
  .workbench-routes { border-right: 0; }
  /* 工具栏左右和行内容一样 16：搜索框、说明、序号从同一条竖线开始（审计第二轮 A12） / The toolbar's inset matches the rows' 16, so search, note and ordinals share one line (audit round 2, A12) */
  /* 浏览检查器在窄屏上是全屏层：头部和内边距跟入口检查器一样（审计 A8） / On narrow screens the browse inspector is a full-screen layer with the entry inspector's header and inset (audit A8) */
  .workbench-custom__head { padding: var(--s-3) var(--s-4); }
  .workbench-custom__body { padding: var(--s-4); }
  .workbench-route-scroll { overflow: visible; padding-bottom: var(--s-3); }
  .workbench-inspector { display: none; }
  /* 手机上检查器没打开时没有「当前选中」可言，不给第一行上底色 / A phone has no selection while the inspector is closed */
  .workbench:not([data-config-editing="true"]) .workbench-item.is-selected { background: transparent; }
  .workbench:not([data-config-editing="true"]) .workbench-item.is-selected .workbench-entry-number { color: var(--l-ink-3); }
  .workbench[data-config-editing="true"] .workbench-inspector { position: fixed; z-index: 80; top: var(--app-header-height, 52px); right: 0; bottom: 0; left: 0; display: block; height: auto; background: var(--l-surface); }
}
@media (max-width: 640px) {
  /* 手机上「…」是 44 的点按格，「›」和墨点的格子跟着 44 / On a phone the 「…」 is a 44 tap cell and the 「›」 and dot cells follow */
  .workbench-row-chevron { margin-inline: calc((var(--h-touch) - var(--size-icon)) / 2); }
  .workbench-orphan .workbench-entry-select:has(> .workbench-entry-dot) { grid-template-columns: var(--s-6) minmax(0, 1fr) var(--h-touch); }
  .workbench-custom__edit { margin-block: calc((1lh - var(--h-touch)) / 2); }
}
@media (hover: hover) and (max-width: 640px) {
  .workbench-entry .workbench-entry-dot { right: calc(var(--s-2) + (var(--h-touch) - var(--size-dot)) / 2); }
}
/* 手机：墨点不另占一格，贴在 44 宽的「…」那一格左边上，离「…」和路线的字都还有空（审计第三轮 A3）
   A phone: the dot takes no track and sits on the left edge of the 44-wide 「…」 cell, clear of both the 「…」 and the route text (audit round 3, A3) */
@media (hover: none) and (max-width: 640px) {
  .workbench-entry .workbench-entry-select:has(> .workbench-entry-dot) { grid-template-columns: var(--s-6) minmax(0, 1fr); }
  .workbench-entry .workbench-entry-dot { position: absolute; top: 50%; right: calc(var(--s-2) + var(--h-touch) - var(--size-dot) / 2); translate: 0 -50%; }
}
@media (prefers-reduced-motion: reduce) { .workbench-entry-dot { transition: none; } }

</style>
