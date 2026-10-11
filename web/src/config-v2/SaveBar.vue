<script setup lang="ts">
import { ChevronDown, ShieldCheck } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UiNumber from '../components/ui/UiNumber.vue'
import UiDotText from '../components/ui/UiDotText.vue'
import { useBarHeight } from '../composables/useBarHeight'
import { useToast } from '../composables/useToast'
import DraftReviewDialog from './DraftReviewDialog.vue'
import RuleText from './RuleText.vue'
import { usePhone } from './phone'
import { changeCount, dialogEdits, discardWithUndo, editorEdited, model } from './store'
import { blockedFields, busy, conflict, deferNote, deferSave, editTouched, elapsed, note, origin, save, saveMessage, stage, validate, validation, verdict } from './useConfigDocument'

// 保存条只替草稿说话：有改动才升起来，保存完一会儿就收起。两步：先校验，再写入并热加载；任何一步失败都停住，原因里的规则能点。
// KixDNS 没启动、连不上、不报能力时只存成待应用版本。Ctrl/Cmd+S 等于点保存。进度和结果都来自 useConfigDocument。
// The save bar speaks only for the draft: it rises with changes and leaves shortly after a save. Two steps — validate, then write and
// hot-reload; either can fail and stop, with clickable rule names in the reason. When KixDNS is down, unreachable or silent about
// capabilities, a save only stores a pending version. Ctrl/Cmd+S presses save. Progress and outcome come from useConfigDocument.
// flush：保存、校验之前把面板和 JSON 里还没进草稿的修改收进来（save）；放弃和查看之前只收 JSON 的（fold）；返回 false 就停在原处
// flush: before save or validate, pull in edits not yet in the draft from the rule panel and the JSON view (save); before discard or review only the JSON ones (fold); false means stop where we are
const props = defineProps<{ jsonError: { line: number; column: number; reason: string } | null; jsonDirty?: boolean; flush?: (purpose: 'save' | 'fold') => boolean }>()
const emit = defineEmits<{ rule: [id: number]; group: [id: string]; reveal: [line: number, column: number]; reload: []; download: []; discarded: [] }>()
const toast = useToast()
// 手机上主按钮只写「保存」，给「已修改 N 处」留出一行 / On a phone the main button just says 保存, leaving room for 已修改 N 处
const phone = usePhone()

// 页头发起的「现在应用」不进保存条 / An apply started from the header never shows in the bar
const draftStage = computed(() => (origin.value === 'draft' ? stage.value : 'idle'))
// 还没进草稿的修改也让保存条升起：JSON 里的、右侧面板里没点「完成」的 / Edits not yet in the draft raise the bar too: the JSON view's and the side panel's not yet 完成
const pending = computed(() => changeCount.value > 0 || Boolean(props.jsonDirty) || editorEdited.value)
const visible = computed(() => pending.value || draftStage.value !== 'idle' || Boolean(props.jsonError))
const noteOpen = ref(false)
// 单独点过「校验」且之后没再改：说一句校验通过 / After a lone 校验 with no edit since: say it passed
const validated = computed(() => (draftStage.value === 'idle' && validation.value && changeCount.value > 0 ? validation.value : null))
// 有新改动就清掉上一次的结果 / A new edit clears the previous result
watch(() => JSON.stringify(model), () => { editTouched(); validation.value = null })

function onKey(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    // 弹层开着时不替它保存，但说一句该怎么做，不让按键没反应 / With a dialog open the bar does not save for it, but says what to do instead of swallowing the key
    if (document.querySelector('dialog[open]')) { toast.info(dialogEdits.size ? '先点窗口里的按钮把修改放进草稿，再保存' : '先关掉这个窗口，再保存'); return }
    if (busy.value) return
    if (props.jsonError) toast.info('JSON 写错了，改好才能保存')
    else if (conflict.value && draftStage.value === 'failed') toast.info('别处已经保存了新版本，先重新读取')
    else if (blockedFields.value.length) toast.info(`当前内核不支持：${blockedFields.value.join('、')}，改好再保存`)
    else if (visible.value) saveDraft()
    // 域名映射行里改了还没点保存：说一句，不说「没有要保存的修改」 / A domain-mapping row edited but not committed: say so instead of 没有要保存的修改
    else if (dialogEdits.size) toast.info(`先保存${[...dialogEdits.values()][0]}，再保存配置`)
    else toast.info('没有要保存的修改')
  }
}
function saveDraft(): void {
  if (props.flush && !props.flush('save')) return
  void save('draft')
}
// 校验看的是草稿：只读回 JSON，不替右侧面板点「完成」（那会关掉它） / Validation checks the draft: it reads the JSON back but never presses 完成 for the side panel (that would close it)
function check(): void {
  if (props.flush && !props.flush('fold')) return
  // 只有右侧规则没点完成时，草稿里还没有它：说清校验看的是什么，不默默校验一份没变的草稿 / With only an unfinished panel edit the draft does not hold it yet: say what 校验 looks at instead of silently checking an unchanged draft
  if (changeCount.value === 0 && editorEdited.value) { toast.info('校验看的是草稿：右侧规则点「完成」后才算进去'); return }
  void validate()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
const saveButton = ref<HTMLButtonElement | null>(null)
const statusLine = ref<HTMLElement | null>(null)
// 保存落地后按钮可能跟着收起：焦点掉到页面开头时放到状态那一行，读屏也会读到结果 / After a save lands the buttons may fold away: when focus falls to the page start it goes to the status line, which a screen reader then reads
watch(() => draftStage.value, (now) => {
  if (now !== 'done') return
  void nextTick(() => { if (!document.activeElement || document.activeElement === document.body) statusLine.value?.focus() })
})
const bar = ref<HTMLElement | null>(null)
// 点「已修改 N 处」看草稿和运行中的配置差在哪；从这里也能直接保存 / Clicking 已修改 N 处 shows how the draft differs from the running config, with save right there
const reviewing = ref(false)
// 看之前先把右侧面板里没点「完成」的修改收进来：对话框里看到的就是要保存的 / Before the review, the side panel's edits not yet 完成 go in, so the dialog shows exactly what will be saved
function review(): void {
  if (props.flush && !props.flush('save')) return
  reviewing.value = true
}
function closeReview(): void {
  reviewing.value = false
  void nextTick(() => document.querySelector<HTMLButtonElement>('.savebar__review')?.focus())
}
const saveLabel = computed(() => (deferSave.value ? '保存为待应用' : '保存并应用'))
useBarHeight(bar, '--savebar-h')
watch(busy, (b) => { if (b) void nextTick(() => saveButton.value?.focus()) })

function discard(): void {
  // 只有面板或 JSON 里的修改时，说清丢掉的是哪些，不给一个什么都恢复不了的「撤销」 / With only panel or JSON edits, say which were dropped instead of offering an 撤销 that restores nothing
  const what = props.jsonDirty ? '已放弃 JSON 里的修改' : editorEdited.value ? '已放弃右侧规则的修改' : undefined
  props.flush?.('fold')
  discardWithUndo(what)
  emit('discarded')
  // 焦点落到提示里的「撤销」：保存条收起后不掉回页面开头 / Focus lands on the toast's 撤销, so it does not fall back to the page start once the bar leaves
  void nextTick(() => [...document.querySelectorAll<HTMLButtonElement>('.toast-undo')].pop()?.focus())
}
</script>

<template>
  <Transition name="cfg-savebar">
    <footer v-if="visible" ref="bar" class="ui-savebar cfg__savebar" :class="{ 'ui-savebar--err': draftStage === 'failed' || Boolean(jsonError) || blockedFields.length > 0, 'savebar--wrap': draftStage === 'done' && pending }">
      <p :key="draftStage === 'failed' ? `f-${note}` : 'state'" ref="statusLine" tabindex="-1" class="ui-savebar__status" :class="{ 'ui-shake': draftStage === 'failed' }" :role="draftStage === 'failed' || jsonError ? 'alert' : 'status'">
        <template v-if="draftStage === 'done'"><svg class="ui-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg><span class="ui-savebar__detail">{{ note }}</span></template>
        <template v-else-if="draftStage === 'checking'"><span class="ui-spin" aria-hidden="true"></span><span class="ui-savebar__detail">校验中</span></template>
        <template v-else-if="draftStage === 'validating'"><span class="ui-spin" aria-hidden="true"></span><span class="ui-savebar__detail"><UiDotText :parts="['第 1 步', '校验', ...(elapsed ? [elapsed] : [])]" /></span></template>
        <template v-else-if="draftStage === 'applying'"><span class="ui-spin" aria-hidden="true"></span><span class="ui-savebar__detail"><UiDotText :parts="deferSave ? ['存成待应用版本', ...(elapsed ? [elapsed] : [])] : ['第 2 步', '写入并应用', ...(elapsed ? [elapsed] : [])]" /></span></template>
        <template v-else-if="draftStage === 'failed'">
          <span class="ui-savebar__verdict">{{ verdict }}</span>
          <small><RuleText :text="note" @rule="emit('rule', $event)" @group="emit('group', $event)" /></small>
          <!-- 别处先存了一个版本：不覆盖它，重新读取再改 / Someone else saved first: never overwrite it; reload and redo -->
          <span v-if="conflict" class="savebar__acts"><button class="ui-btn ui-btn--text ui-btn--sm savebar__act" type="button" @click="emit('download')">下载草稿</button><button class="ui-btn ui-btn--text ui-btn--sm savebar__act" type="button" @click="emit('reload')">重新读取</button></span>
        </template>
        <template v-else-if="jsonError"><span class="ui-savebar__verdict">JSON 写错了</span><small><button class="ui-objlink ui-objlink--plain" type="button" @click="emit('reveal', jsonError.line, jsonError.column)">第 {{ jsonError.line }} 行第 {{ jsonError.column }} 列</button> · {{ jsonError.reason }}</small></template>
        <!-- 有内核不支持的设置：保存不了，说是哪几项 / Settings the kernel does not support: saving cannot happen, and the bar names them -->
        <template v-else-if="blockedFields.length"><span class="ui-savebar__verdict">保存不了</span><small>当前内核不支持：{{ blockedFields.join('、') }}。怎么改见页面上方的提示</small></template>
        <template v-else-if="validated"><span class="ui-dot" aria-hidden="true"></span><span class="ui-savebar__detail"><UiDotText :parts="['校验通过', '可以保存']" /></span></template>
        <template v-else-if="changeCount === 0"><span class="ui-dot ui-dot--ink" aria-hidden="true"></span><span class="ui-savebar__detail">{{ jsonDirty ? 'JSON 有修改' : '右侧规则的修改还没放进草稿' }}<small v-if="deferSave"> · {{ deferNote }}</small></span></template>
        <template v-else><span class="ui-dot ui-dot--ink" aria-hidden="true"></span><span class="ui-savebar__detail"><button class="ui-objlink savebar__review" type="button" aria-haspopup="dialog" title="看看改了哪些" @click="review">已修改 <b class="ui-savebar__count"><UiNumber :value="String(changeCount)" /></b> 处</button><small v-if="deferSave"> · {{ deferNote }}</small></span></template>
      </p>
      <!-- JSON 写错时只留「放弃修改」：改不好也能回到草稿 / With broken JSON only 放弃修改 stays, so the way back to the draft is always there -->
      <button v-if="jsonError && !phone" class="ui-btn ui-btn--secondary savebar__discard" type="button" @click="discard">放弃修改</button>
      <template v-if="(draftStage !== 'done' || pending) && (pending || draftStage === 'failed') && !jsonError">
        <span v-if="busy && saveMessage" class="savebar__note-text">{{ saveMessage }}</span>
        <button class="ui-btn ui-btn--text savebar__note-toggle" :class="{ 'is-aside': busy }" type="button" :inert="busy" :aria-expanded="noteOpen || Boolean(saveMessage)" @click="noteOpen = !noteOpen">备注<ChevronDown class="ui-btn__chev" :size="16" aria-hidden="true" /></button>
        <label class="ui-input ui-savebar__note savebar__note" :class="{ 'is-open': noteOpen || Boolean(saveMessage), 'is-aside': busy }" :inert="busy"><input v-model="saveMessage" aria-label="版本备注" maxlength="160" placeholder="版本备注（可选）"></label>
        <!-- 保存旁边一定有放弃：丢掉草稿回到运行中的配置，提示里能撤销 / Save always comes with discard: drop the draft back to the running config, undoable from the toast -->
        <button v-if="!phone && pending" class="ui-btn ui-btn--secondary savebar__discard" :class="{ 'is-aside': busy }" type="button" :inert="busy" @click="discard">放弃修改</button>
        <button v-if="!deferSave && !conflict && pending" class="ui-btn ui-btn--secondary savebar__check" :class="{ 'is-aside': busy }" type="button" :inert="busy" @click="check"><ShieldCheck :size="16" aria-hidden="true" />校验</button>
        <!-- 别处先存了新版本时再保存只会再失败一次：先重新读取 / After someone else saved, saving again only fails again: reload first -->
        <button ref="saveButton" class="ui-btn ui-btn--primary savebar__save config-save-button" type="button" :aria-busy="busy || undefined" :disabled="conflict && draftStage === 'failed'" @click="saveDraft"><span v-if="busy && stage !== 'checking'" class="ui-spin" aria-hidden="true"></span>{{ busy && stage !== 'checking' ? '保存中' : saveLabel }}</button>
      </template>
    </footer>
  </Transition>
  <DraftReviewDialog v-if="reviewing" :save-label="saveLabel" :can-save="!busy" @close="closeReview" @save="reviewing = false; saveDraft()" />
</template>
