<script setup lang="ts">
import { ChevronDown, ShieldCheck } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UiNumber from '../components/ui/UiNumber.vue'
import UiDotText from '../components/ui/UiDotText.vue'
import { useBarHeight } from '../composables/useBarHeight'
import { useToast } from '../composables/useToast'
import DraftReviewDialog from './DraftReviewDialog.vue'
import RuleText from './RuleText.vue'
import { usePhone, useTightSaveBar } from './phone'
import { changeCount, dialogEdits, discardWithUndo, editorEdited, model } from './store'
import { blockedFields, busy, pendingVersionId, queued, rereading, saveInFlight, sayBlocked, conflict, deferNote, deferSave, editTouched, elapsed, note, origin, save, saveMessage, stage, validate, validation, verdict } from './useConfigDocument'

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
const tight = useTightSaveBar()

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
    // 恢复版本、重新读取还在读：读回来的会换掉草稿，等它读完 / A restore or re-read is reading: what comes back replaces the draft, so wait for it
    if (rereading.value) { toast.info('正在读取配置，读完再保存'); return }
    // 页头的「现在应用」在跑：这时保存不了草稿，说一句，不让按键没反应 / The header's 现在应用 is running: the draft cannot be saved now, so say so instead of swallowing the key
    if (applying.value) { toast.info(applyingNote.value); return }
    // 单独的「校验」还没回来时照样保存（等它回来接着存）；真的在保存时不重复 / During a lone 校验 the save still goes (it waits for the check); during a real save it is not repeated
    if (saveInFlight.value) return
    if (props.jsonError) toast.info('JSON 写错了，改好才能保存')
    else if (conflict.value && draftStage.value === 'failed') toast.info('这份配置在别处改过了，先重新读取')
    else if (blockedFields.value.length) sayBlocked()
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
// 页头的「现在应用」在跑（不是这条保存条的保存） / The header's 现在应用 is running (not this bar's save)
const applying = computed(() => busy.value && origin.value === 'apply')
const applyingNote = computed(() => `正在应用${pendingVersionId.value ? `版本 #${pendingVersionId.value}` : '待应用的版本'}，应用完再保存`)
// 在写入这份草稿，或者排在单独的「校验」后面等着写：按钮写「保存中」；页头在应用时不算 / Writing this draft, or queued behind a lone 校验 to write: the button reads 保存中; the header's apply does not count
const saving = computed(() => (busy.value && stage.value !== 'checking' && origin.value === 'draft') || queued.value)
// 保存还在跑（写入落地以后、重读完之前草稿已经算干净了）：按钮一直留着写「保存中」，不在说「第 2 步」时消失
// The save is still running (after the write lands and before the re-read the draft already counts as clean): the button stays, reading 保存中, instead of vanishing mid-「第 2 步」
const inSave = computed(() => draftStage.value === 'validating' || draftStage.value === 'applying' || queued.value)
useBarHeight(bar, '--savebar-h')
// 保存开始时焦点挪到保存按钮（上面会出「保存中」），只在焦点本来就在保存条上或者没落在任何地方时：正在输入框里打字的人不被拽走。
// 单独的「校验」不挪到保存按钮：再按一下 Enter 或按住不放就成了保存并应用，焦点放到状态那一行
// When a save starts focus moves to the save button (it shows 保存中), only if focus was already in the bar or nowhere: someone typing in a field is not pulled away.
// A lone 校验 does not move it to the save button, where a second Enter or a held key would save and apply: focus goes to the status line
watch(busy, (b) => {
  if (!b) return
  void nextTick(() => {
    const active = document.activeElement
    if (!active || active === document.body || bar.value?.contains(active)) (stage.value === 'checking' && !queued.value ? statusLine.value : saveButton.value)?.focus()
  })
})

function discard(): void {
  // 文件在别处改过了：放弃修改就是回到面板上现在的那份，重新读取；退回旧的底子会显示一份已经不存在的配置
  // The file was changed elsewhere: discarding means going back to what the panel holds now, so re-read; restoring the old base would show a config that no longer exists
  if (conflict.value) { emit('reload'); return }
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
    <!-- 恢复版本还在读：读回来的会换掉草稿，保存条也先不能按（和下面的列表一样调淡） / A restore is still reading: what comes back replaces the draft, so the bar takes no presses either (dimmed like the list) -->
    <footer v-if="visible" ref="bar" class="ui-savebar cfg__savebar" :inert="rereading || undefined" :aria-busy="rereading || undefined" :class="{ 'ui-savebar--err': draftStage === 'failed' || Boolean(jsonError) || blockedFields.length > 0, 'savebar--wrap': draftStage === 'done' && pending }">
      <p :key="draftStage === 'failed' ? `f-${note}` : 'state'" ref="statusLine" tabindex="-1" data-focus-landing class="ui-savebar__status" :class="{ 'ui-shake': draftStage === 'failed' }" :role="draftStage === 'failed' || jsonError ? 'alert' : 'status'">
        <template v-if="draftStage === 'done'"><svg class="ui-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg><span class="ui-savebar__detail"><UiDotText :parts="note.split(' · ')" /></span></template>
        <!-- 排在单独的「校验」后面的保存：状态和直接保存一样写「第 1 步 · 校验」，不和「保存中」各说各的 / A save queued behind a lone 校验 reads 「第 1 步 · 校验」 like a direct save, not 「校验中」 beside 保存中 -->
        <template v-else-if="draftStage === 'checking' && !queued"><span class="ui-spin" aria-hidden="true"></span><span class="ui-savebar__detail">校验中</span></template>
        <template v-else-if="draftStage === 'validating' || draftStage === 'checking'"><span class="ui-spin" aria-hidden="true"></span><span class="ui-savebar__detail"><UiDotText :parts="['第 1 步', '校验', ...(elapsed ? [elapsed] : [])]" /></span></template>
        <template v-else-if="draftStage === 'applying'"><span class="ui-spin" aria-hidden="true"></span><span class="ui-savebar__detail"><UiDotText :parts="deferSave ? ['存成待应用版本', ...(elapsed ? [elapsed] : [])] : ['第 2 步', '写入并应用', ...(elapsed ? [elapsed] : [])]" /></span></template>
        <template v-else-if="draftStage === 'failed'">
          <span class="ui-savebar__verdict">{{ verdict }}</span>
          <small><RuleText :text="note" @rule="emit('rule', $event)" @group="emit('group', $event)" /></small>
          <!-- 别处先存了一个版本：不覆盖它，重新读取再改 / Someone else saved first: never overwrite it; reload and redo -->
          <span v-if="conflict" class="savebar__acts"><button class="ui-btn ui-btn--text ui-btn--sm savebar__act" type="button" @click="emit('download')">下载草稿</button><button class="ui-btn ui-btn--text ui-btn--sm savebar__act" type="button" @click="emit('reload')">重新读取</button></span>
        </template>
        <template v-else-if="jsonError"><span class="ui-savebar__verdict">JSON 写错了</span><small><button class="ui-objlink ui-objlink--plain" type="button" @click="emit('reveal', jsonError.line, jsonError.column)">第 {{ jsonError.line }} 行第 {{ jsonError.column }} 列</button> · {{ jsonError.reason }}</small></template>
        <!-- 有内核不支持的设置：保存不了，说是哪几项 / Settings the kernel does not support: saving cannot happen, and the bar names them -->
        <template v-else-if="blockedFields.length"><span class="ui-savebar__verdict">保存不了</span><small>有 {{ blockedFields.length }} 项内核不支持，见页面上方</small></template>
        <template v-else-if="validated"><span class="ui-dot" aria-hidden="true"></span><span class="ui-savebar__detail"><UiDotText :parts="tight ? ['校验通过'] : ['校验通过', '可以保存']" /></span></template>
        <template v-else-if="changeCount === 0"><span class="ui-dot ui-dot--ink" aria-hidden="true"></span><span class="ui-savebar__detail">{{ jsonDirty ? 'JSON 有修改' : '右侧规则的修改还没放进草稿' }}<small v-if="deferSave"> · {{ deferNote }}</small></span></template>
        <template v-else><span class="ui-dot ui-dot--ink" aria-hidden="true"></span><span class="ui-savebar__detail"><button class="ui-objlink savebar__review" type="button" aria-haspopup="dialog" title="看看改了哪些" @click="review">已修改 <b class="ui-savebar__count"><UiNumber :value="String(changeCount)" /></b> 处</button><small v-if="deferSave"> · {{ deferNote }}</small></span></template>
      </p>
      <!-- JSON 写错时只留「放弃修改」：改不好也能回到草稿 / With broken JSON only 放弃修改 stays, so the way back to the draft is always there -->
      <button v-if="jsonError && !phone" class="ui-btn ui-btn--secondary savebar__discard" type="button" @click="discard">放弃修改</button>
      <template v-if="(draftStage !== 'done' || pending) && (pending || draftStage === 'failed' || inSave) && !jsonError">
        <span v-if="busy && saveMessage" class="savebar__note-text">{{ saveMessage }}</span>
        <button v-if="!(phone && conflict)" class="ui-btn ui-btn--text savebar__note-toggle" :class="{ 'is-aside': busy }" type="button" :inert="busy" :aria-expanded="noteOpen || Boolean(saveMessage)" @click="noteOpen = !noteOpen">备注<ChevronDown class="ui-btn__chev" :size="16" aria-hidden="true" /></button>
        <label class="ui-input ui-savebar__note savebar__note" :class="{ 'is-open': noteOpen || Boolean(saveMessage), 'is-aside': busy }" :inert="busy"><input v-model="saveMessage" aria-label="版本备注" maxlength="160" placeholder="版本备注（可选）"></label>
        <!-- 保存旁边一定有放弃：丢掉草稿回到运行中的配置，提示里能撤销；冲突时放弃就是重新读取，旁边已经有「重新读取」，不再放第二个（和手机一样）
             Save always comes with discard: drop the draft back to the running config, undoable from the toast; in a conflict discarding is re-reading, and
             重新读取 already sits beside it, so no second control (as on phones) -->
        <button v-if="!phone && pending && !(conflict && draftStage === 'failed')" class="ui-btn ui-btn--secondary savebar__discard" :class="{ 'is-aside': busy }" type="button" :inert="busy" @click="discard">放弃修改</button>
        <!-- 被内核不支持的设置挡住时不给「校验」：按了只会把同一句提示再说一遍 / No 校验 while unsupported settings block saving: pressing it would only repeat the same toast -->
        <button v-if="!deferSave && !conflict && pending && !blockedFields.length" class="ui-btn ui-btn--secondary savebar__check" :class="{ 'is-aside': busy }" type="button" :inert="busy" @click="check"><ShieldCheck :size="16" aria-hidden="true" />校验</button>
        <!-- 别处先存了新版本时再保存只会再失败一次：先重新读取 / After someone else saved, saving again only fails again: reload first -->
        <!-- 手机上冲突时不留灰掉的保存和备注：这时只能下载或重新读取，省下一整行 / On phones a conflict drops the greyed save and 备注: only download or reload can happen then, which saves a whole row -->
        <button v-if="!(phone && conflict && draftStage === 'failed')" ref="saveButton" class="ui-btn ui-btn--primary savebar__save config-save-button" type="button" :aria-busy="busy || undefined" :disabled="(conflict && draftStage === 'failed') || applying" :title="applying ? applyingNote : undefined" @click="saveDraft"><span v-if="saving" class="ui-spin" aria-hidden="true"></span>{{ saving ? '保存中' : saveLabel }}</button>
      </template>
    </footer>
  </Transition>
  <DraftReviewDialog v-if="reviewing" :save-label="saveLabel" :can-save="!busy" @close="closeReview" @save="reviewing = false; saveDraft()" />
</template>
