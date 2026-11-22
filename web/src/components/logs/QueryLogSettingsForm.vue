<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { apiRequest } from '../../api/client'
import type { QueryLogSettings } from '../../api/types'
import { useConfirm } from '../../composables/useConfirm'
import { capProblem, glueText, hoursProblem, ignoredDomains, sinceText, type SettingsSaveOutcome } from '../../querylog'
import { errorMessage } from '../../utils'
import '../../styles/config-v2.css'
import UiTabs from '../ui/UiTabs.vue'

// 查询日志设置的表单：日志页的设置抽屉和「基础设置」里的「查询日志」一组共用。它只管框里的内容、检查和读写；
// 什么时候关、保存后提示什么由放它的地方决定（save 交回结果）
// The query log settings form, shared by the logs page's settings drawer and the 查询日志 group in 基础设置. It owns the
// fields, their checks and the reads and writes; when to close and what to say after saving is the host's call (save
// hands back the outcome)
const props = withDefaults(defineProps<{ idPrefix?: string }>(), { idPrefix: 'ql' })
const settings = defineModel<QueryLogSettings | null>('settings', { required: true })
const emit = defineEmits<{ cleared: [] }>()
const confirm = useConfirm()
const root = ref<HTMLElement | null>(null)
const id = (name: string) => `${props.idPrefix}-${name}`
const MIB = 1048576

const RETENTIONS = [{ value: '6', label: '6 小时' }, { value: '24', label: '1 天' }, { value: '168', label: '7 天' }, { value: '720', label: '30 天' }, { value: '2160', label: '90 天' }, { value: 'custom', label: '自定义' }]
const draft = ref({ retention: '24', customHours: '', maxMb: '16', ignored: '' })
// 出错提示在填完（离开那个框）或按了保存以后才出来，不在刚选「自定义」时就红 / A problem shows once the field is left or 保存 is
// pressed, not the moment 自定义 is chosen
const touched = ref({ hours: false, mb: false, ignored: false, submitted: false })
const busy = ref(false)
// 服务端回来的错，按说的是哪一项放在那个框下面 / A server error goes under the field it is about
const serverProblem = ref<{ field: 'hours' | 'mb' | 'ignored' | 'form'; text: string } | null>(null)
const mb = (bytes: number) => `${Math.round(bytes / MIB)} MB`
const limit = computed(() => settings.value?.storage?.limit_bytes ?? null)
// 改了上限才按这台设备给得起的查：没改的照旧能存（空间少了，实际按给得起的算，下面一句会说）
// A changed cap is checked against what this device can give; an unchanged one still saves (with less room, the room
// available is what counts, as the line below says)
function roomProblem(maxMb: string): string {
  const value = Math.round(Number(maxMb)) * MIB
  if (limit.value === null || !settings.value || value === settings.value.max_bytes || value <= limit.value) return ''
  return `最多占用不能超过 ${mb(limit.value)}：这台设备的${settings.value.storage?.memory ? '内存' : '磁盘'}只能再给查询日志这么多`
}
const problems = computed(() => {
  const d = draft.value
  const shown = (field: 'hours' | 'mb' | 'ignored') => touched.value[field] || touched.value.submitted
  const said = (field: 'hours' | 'mb' | 'ignored') => (serverProblem.value?.field === field ? serverProblem.value.text : '')
  return {
    hours: (d.retention === 'custom' && shown('hours') ? hoursProblem(d.customHours) : '') || said('hours'),
    mb: (shown('mb') ? capProblem(d.maxMb) || roomProblem(d.maxMb) : '') || said('mb'),
    ignored: (shown('ignored') ? ignoredDomains(d.ignored).problem : '') || said('ignored'),
    form: serverProblem.value?.field === 'form' ? serverProblem.value.text : '',
  }
})
const valid = () => (draft.value.retention !== 'custom' || !hoursProblem(draft.value.customHours)) && !capProblem(draft.value.maxMb) && !roomProblem(draft.value.maxMb) && !ignoredDomains(draft.value.ignored).problem
// 存在哪、最多能设多大；已经存下的上限超过了现在给得起的，说一句实际按多少算
// Where it is kept and the largest cap allowed; when the saved cap exceeds what can be given now, say what counts
const storageText = computed(() => {
  const storage = settings.value?.storage
  if (!storage) return ''
  const where = storage.memory ? `存在内存里（${storage.path}），设备重启后清空。` : `存在 ${storage.path}。`
  const over = settings.value && settings.value.max_bytes > storage.limit_bytes ? `现在设的 ${mb(settings.value.max_bytes)} 超过了，实际按 ${mb(storage.limit_bytes)} 算。` : ''
  return `${where}这台设备最多能设 ${mb(storage.limit_bytes)}。${over}`
})

/** 按读到的设置重填表单 / Refill the form from the settings read */
function reset(s: QueryLogSettings): void {
  const preset = RETENTIONS.some((r) => r.value === String(s.retention_hours))
  draft.value = { retention: preset ? String(s.retention_hours) : 'custom', customHours: preset ? '' : String(s.retention_hours), maxMb: String(Math.round(s.max_bytes / MIB)), ignored: s.ignored_domains.join('\n') }
  touched.value = { hours: false, mb: false, ignored: false, submitted: false }
  serverProblem.value = null
}
// 表单出现时设置已经读到了，或者后来才读到：按它填一次（「基础设置」里这一组点开才挂上，读设置在那之前）
// The settings were read before the form appeared, or arrive later: fill it from them once (in 基础设置 the group mounts only
// when opened, after the read)
watch(settings, (next, previous) => { if (next && !previous) reset(next) }, { immediate: true })
// 改了框里的内容，服务端上次说的错就不算了 / Editing a field clears what the server said about the last attempt
watch(draft, () => { serverProblem.value = null }, { deep: true })
// 保存没通过：焦点放到第一个有错的框上，读屏器接着读它下面的错 / A save that did not go through: focus goes to the first wrong field,
// and a screen reader reads the error under it
function focusProblem(): void {
  void nextTick(() => root.value?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
}

/** 检查并保存；没改就不写 / Check and save; nothing is written when nothing changed */
async function save(): Promise<SettingsSaveOutcome> {
  touched.value.submitted = true
  serverProblem.value = null
  if (busy.value) return { status: 'busy' }
  if (!valid()) { focusProblem(); return { status: 'invalid' } }
  const d = draft.value
  const next = {
    retention_hours: d.retention === 'custom' ? Number(d.customHours) : Number(d.retention),
    max_bytes: Math.round(Number(d.maxMb)) * MIB,
    ignored_domains: ignoredDomains(d.ignored).domains,
  }
  const before = settings.value
  if (before && before.retention_hours === next.retention_hours && before.max_bytes === next.max_bytes && before.ignored_domains.join('\n') === next.ignored_domains.join('\n')) {
    return { status: 'unchanged' }
  }
  busy.value = true
  try {
    const saved = await apiRequest<QueryLogSettings>('/api/v1/querylog/settings', { method: 'PUT', body: JSON.stringify(next) })
    settings.value = saved
    reset(saved)
    return { status: 'saved', before, next: saved }
  } catch (error) {
    const text = errorMessage(error)
    serverProblem.value = { field: text.startsWith('保存多久') ? 'hours' : text.startsWith('最多占用') ? 'mb' : /域名/.test(text) ? 'ignored' : 'form', text }
    focusProblem()
    return { status: 'failed', text }
  } finally {
    busy.value = false
  }
}

async function clearAll(): Promise<void> {
  const ok = await confirm.ask({ title: '清空查询日志', body: '已经记下的查询全部删掉，找不回来。之后的查询照常记录。', confirmLabel: '清空查询日志', destructive: true })
  if (!ok) return
  try {
    settings.value = await apiRequest<QueryLogSettings>('/api/v1/querylog/clear', { method: 'POST' })
  } catch (error) {
    serverProblem.value = { field: 'form', text: `没能清空：${errorMessage(error)}` }
    return
  }
  emit('cleared')
}

defineExpose({ reset, save, busy })
</script>

<template>
  <div ref="root" class="qlog-settings">
    <!-- 每个框的问题写在它自己下面，框也标红 / Each field's problem sits under it, and the field turns red -->
    <div class="pfield">
      <span>保存多久</span>
      <UiTabs v-model="draft.retention" :items="RETENTIONS" label="保存多久" variant="segment" />
      <label v-if="draft.retention === 'custom'" class="ui-input qlog-hours"><input v-model="draft.customHours" inputmode="numeric" aria-label="保存多少小时" placeholder="1–8760" :aria-invalid="Boolean(problems.hours) || undefined" :aria-describedby="problems.hours ? id('hours-err') : undefined" @blur="touched.hours = true"><span>小时</span></label>
      <p v-if="problems.hours" :id="id('hours-err')" class="ui-field-error" role="alert"><template v-for="(run, k) in glueText(problems.hours)" :key="k"><span v-if="run.keep" class="qlog-keep">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></p>
    </div>
    <label class="pfield">
      <span>最多占用</span>
      <span class="ui-input qlog-mb"><input v-model="draft.maxMb" inputmode="numeric" aria-label="最多占用多少 MB" :aria-invalid="Boolean(problems.mb) || undefined" :aria-describedby="problems.mb ? id('mb-err') : id('mb-hint')" @blur="touched.mb = true"><span>MB</span></span>
      <p v-if="problems.mb" :id="id('mb-err')" class="ui-field-error" role="alert"><template v-for="(run, k) in glueText(problems.mb)" :key="k"><span v-if="run.keep" class="qlog-keep">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></p>
      <small :id="id('mb-hint')" class="pfield__hint">{{ settings ? `已用 ${mb(settings.used_bytes)}${settings.oldest_unix_ms ? `，记录从 ${sinceText(settings.oldest_unix_ms)} 起` : ''}。` : '' }}超过上限时先删最早的。</small>
      <small v-if="storageText" class="pfield__hint qlog-storage">{{ storageText }}</small>
    </label>
    <label class="pfield">
      <span>不记录的域名 <small>可选</small></span>
      <span class="ui-input ui-input--area qlog-ignored"><textarea v-model="draft.ignored" rows="4" aria-label="不记录的域名" placeholder="一行一个，也可以用逗号隔开；连子域名一起不记" spellcheck="false" autocapitalize="off" :aria-invalid="Boolean(problems.ignored) || undefined" :aria-describedby="problems.ignored ? id('ignored-err') : undefined" @blur="touched.ignored = true"></textarea></span>
      <p v-if="problems.ignored" :id="id('ignored-err')" class="ui-field-error" role="alert"><template v-for="(run, k) in glueText(problems.ignored)" :key="k"><span v-if="run.keep" class="qlog-keep">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></p>
    </label>
    <div class="qlog-danger">
      <button class="ui-btn ui-btn--danger ui-btn--sm" type="button" @click="clearAll">清空查询日志</button>
      <small>已经记下的全部删掉，之后照常记录</small>
    </div>
    <p v-if="problems.form" class="ui-field-error" role="alert"><template v-for="(run, k) in glueText(problems.form)" :key="k"><span v-if="run.keep" class="qlog-keep">{{ run.text }}</span><template v-else>{{ run.text }}</template></template></p>
  </div>
</template>

<!-- 和日志页一样不加 scoped：两处共用这几条 / Unscoped like the logs page: both places share these rules -->
<style>
.qlog-settings { display: grid; gap: var(--s-5); }
.qlog-hours, .qlog-mb { max-width: 12rem; }
.qlog-hours > span, .qlog-mb > span { color: var(--l-ink-3); font-size: var(--t-2); }
/* 不记录的域名用组件库的多行框：字是墨色 13 号，焦点只有框自己的一圈 / The ignored domains use the kit's multi-line field: ink at
   13px, with only the field's own focus ring */
.qlog-ignored.ui-input--area textarea { min-height: calc(var(--h-md) * 3 - var(--s-4)); overflow: auto; resize: vertical; }
/* 选项条只占选项那么宽，不拖一截空灰底（手机上照旧占满一行） / The segmented track is as wide as its options, with no empty grey tail (full width on phones as before) */
@media (min-width: 641px) { .qlog-settings .ui-seg { justify-self: start; } }
.qlog-danger { display: grid; justify-items: start; gap: var(--s-1); padding-top: var(--s-4); border-top: 1px solid var(--l-hair); }
.qlog-danger small { color: var(--l-ink-3); font-size: var(--t-1); }
/* 成段的说明从 641 起是 12 号，和上面的提示一样 / Sentences are 12px from 641 up, like the hints above */
@media (min-width: 641px) { .qlog-danger small { font-size: var(--t-2); } }
.qlog-keep { white-space: nowrap; }
</style>
