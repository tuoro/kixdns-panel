<script setup lang="ts">
import { ChevronDown, ShieldCheck } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UiNumber from '../components/ui/UiNumber.vue'
import UiDotText from '../components/ui/UiDotText.vue'
import { useToast } from '../composables/useToast'
import RuleText from './RuleText.vue'
import { usePhone } from './phone'
import { changeCount, discardDraft, model, replaceModel } from './store'
import { busy, conflict, deferNote, deferSave, editTouched, elapsed, note, origin, save, saveMessage, stage, validate, validation, verdict } from './useConfigDocument'

// 保存条只替草稿说话：有改动才升起来，保存完一会儿就收起。两步：先校验，再写入并热加载；任何一步失败都停住，原因里的规则能点。
// KixDNS 没启动、连不上、不报能力时只存成待应用版本。Ctrl/Cmd+S 等于点保存。进度和结果都来自 useConfigDocument。
// The save bar speaks only for the draft: it rises with changes and leaves shortly after a save. Two steps — validate, then write and
// hot-reload; either can fail and stop, with clickable rule names in the reason. When KixDNS is down, unreachable or silent about
// capabilities, a save only stores a pending version. Ctrl/Cmd+S presses save. Progress and outcome come from useConfigDocument.
const props = defineProps<{ jsonError: { line: number; column: number; reason: string } | null }>()
const emit = defineEmits<{ rule: [id: number]; group: [id: string]; reveal: [line: number, column: number]; reload: [] }>()
const toast = useToast()
// 手机上主按钮只写「保存」，给「已修改 N 处」留出一行 / On a phone the main button just says 保存, leaving room for 已修改 N 处
const phone = usePhone()

// 页头发起的「现在应用」不进保存条 / An apply started from the header never shows in the bar
const draftStage = computed(() => (origin.value === 'draft' ? stage.value : 'idle'))
const visible = computed(() => changeCount.value > 0 || draftStage.value !== 'idle' || Boolean(props.jsonError))
const noteOpen = ref(false)
// 单独点过「校验」且之后没再改：说一句校验通过 / After a lone 校验 with no edit since: say it passed
const validated = computed(() => (draftStage.value === 'idle' && validation.value && changeCount.value > 0 ? validation.value : null))
// 有新改动就清掉上一次的结果 / A new edit clears the previous result
watch(() => JSON.stringify(model), () => { editTouched(); validation.value = null })

function onKey(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    if (document.querySelector('[data-config-editing="true"]')) return
    if (visible.value && !busy.value && !props.jsonError) void save('draft')
    else if (!changeCount.value) toast.info('没有要保存的修改')
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
const saveButton = ref<HTMLButtonElement | null>(null)
watch(busy, (b) => { if (b) void nextTick(() => saveButton.value?.focus()) })

function discard(): void {
  const draft = JSON.stringify(model)
  const count = changeCount.value
  discardDraft()
  toast.undoable(`已放弃 ${count} 处修改`, () => replaceModel(JSON.parse(draft)))
}
</script>

<template>
  <Transition name="cfg-savebar">
    <footer v-if="visible" class="ui-savebar cfg__savebar" :class="{ 'ui-savebar--err': draftStage === 'failed' || Boolean(jsonError) }">
      <p :key="draftStage === 'failed' ? `f-${note}` : 'state'" class="ui-savebar__status" :class="{ 'ui-shake': draftStage === 'failed' }" :role="draftStage === 'failed' || jsonError ? 'alert' : 'status'">
        <template v-if="draftStage === 'done'"><svg class="ui-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg><span class="ui-savebar__detail">{{ note }}</span></template>
        <template v-else-if="draftStage === 'checking'"><span class="ui-spin" aria-hidden="true"></span><span class="ui-savebar__detail">校验中</span></template>
        <template v-else-if="draftStage === 'validating'"><span class="ui-spin" aria-hidden="true"></span><span class="ui-savebar__detail"><UiDotText :parts="['第 1 步', '校验', ...(elapsed ? [elapsed] : [])]" /></span></template>
        <template v-else-if="draftStage === 'applying'"><span class="ui-spin" aria-hidden="true"></span><span class="ui-savebar__detail"><UiDotText :parts="deferSave ? ['存成待应用版本', ...(elapsed ? [elapsed] : [])] : ['第 2 步', '写入并热加载', ...(elapsed ? [elapsed] : [])]" /></span></template>
        <template v-else-if="draftStage === 'failed'">
          <span class="ui-savebar__verdict">{{ verdict }}</span>
          <small><RuleText :text="note" @rule="emit('rule', $event)" @group="emit('group', $event)" /></small>
          <!-- 别处先存了一个版本：不覆盖它，重新读取再改 / Someone else saved first: never overwrite it; reload and redo -->
          <button v-if="conflict" class="ui-btn ui-btn--text ui-btn--sm savebar__act" type="button" @click="emit('reload')">重新读取</button>
        </template>
        <template v-else-if="jsonError"><span class="ui-savebar__verdict">JSON 写错了</span><small><button class="ui-objlink ui-objlink--plain" type="button" @click="emit('reveal', jsonError.line, jsonError.column)">第 {{ jsonError.line }} 行第 {{ jsonError.column }} 列</button> · {{ jsonError.reason }}</small></template>
        <template v-else-if="validated"><span class="ui-dot" aria-hidden="true"></span><span class="ui-savebar__detail"><UiDotText :parts="['校验通过', `${validated.pipeline_count} 个 Pipeline、${validated.rule_count} 条内核规则`]" /></span></template>
        <template v-else><span class="ui-dot ui-dot--ink" aria-hidden="true"></span><span class="ui-savebar__detail">已修改 <b class="ui-savebar__count"><UiNumber :value="String(changeCount)" /></b> 处<small v-if="deferSave"> · {{ deferNote }}</small></span></template>
      </p>
      <template v-if="draftStage !== 'done' && (changeCount > 0 || draftStage === 'failed') && !jsonError">
        <span v-if="busy && saveMessage" class="savebar__note-text">{{ saveMessage }}</span>
        <button class="ui-btn ui-btn--text savebar__note-toggle" :class="{ 'is-aside': busy }" type="button" :inert="busy" :aria-expanded="noteOpen || Boolean(saveMessage)" @click="noteOpen = !noteOpen">备注<ChevronDown class="ui-btn__chev" :size="16" aria-hidden="true" /></button>
        <label class="ui-input ui-savebar__note savebar__note" :class="{ 'is-open': noteOpen || Boolean(saveMessage), 'is-aside': busy }" :inert="busy"><input v-model="saveMessage" aria-label="版本备注" maxlength="160" placeholder="版本备注（可选）"></label>
        <!-- 保存旁边一定有放弃：丢掉草稿回到运行中的配置，提示里能撤销 / Save always comes with discard: drop the draft back to the running config, undoable from the toast -->
        <button v-if="!phone && draftStage !== 'failed'" class="ui-btn ui-btn--secondary savebar__discard" :class="{ 'is-aside': busy }" type="button" :inert="busy" @click="discard">放弃修改</button>
        <button v-if="!deferSave" class="ui-btn ui-btn--secondary savebar__check" :class="{ 'is-aside': busy }" type="button" :inert="busy" @click="validate"><ShieldCheck :size="16" aria-hidden="true" />校验</button>
        <button ref="saveButton" class="ui-btn ui-btn--primary savebar__save config-save-button" type="button" :aria-busy="busy || undefined" @click="save('draft')"><span v-if="busy" class="ui-spin" aria-hidden="true"></span>{{ busy ? '保存中' : deferSave ? (phone ? '存为待应用' : '保存为待应用') : (phone ? '保存' : '保存并热加载') }}</button>
      </template>
    </footer>
  </Transition>
</template>
