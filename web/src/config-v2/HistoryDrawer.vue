<script setup lang="ts">
import { Ellipsis, Trash2, X } from '@lucide/vue'
import { computed, nextTick, onMounted, ref } from 'vue'
import type { ConfigVersion } from '../api/types'
import UiMenu from '../components/ui/UiMenu.vue'
import { useConfirm } from '../composables/useConfirm'
import { useToast } from '../composables/useToast'
import { diffModels, type DiffBlock } from '../config-model/diff'
import { readConfig } from '../config-model/document'
import { errorMessage, formatVersionTime } from '../utils'
import RuleText from './RuleText.vue'
import { appliedModel, dirty } from './store'
import { bulkDeleting, currentVersionId, deleteVersion, deleteVersions, deleting, friendlyRuntimeError, restoreVersion, restoring, versionDetail, versions } from './useConfigDocument'

// 历史版本：一行是备注加「#编号 · 时间」，点一行看「恢复它会改什么」；恢复和删除在行的菜单里，「选择」可以一次删几个。
// History: a row is the note plus 「#id · time」; clicking it shows what restoring would change. Restore and delete live in the row's
// menu, and 选择 deletes several at once.
const props = defineProps<{ compareWith?: number | null }>()
const emit = defineEmits<{ close: []; rule: [id: number] }>()
const toast = useToast()
const confirm = useConfirm()
const dialog = ref<HTMLDialogElement | null>(null)
const diffDialog = ref<HTMLDialogElement | null>(null)
const selecting = ref(false)
const picked = ref<number[]>([])
const preview = ref<ConfigVersion | null>(null)
// 比较的结果：打开一行后去取那个版本的全文，拿到才算；没拿到之前是 null，什么都不显示
// The comparison: a row's full content is fetched when opened and compared once it arrives; null until then, and nothing shows
const blocks = ref<DiffBlock[] | null>(null)
// 有哪个版本正在恢复或删除时，菜单里的操作都停一停 / While any version is being restored or deleted the menu actions wait
const busy = computed(() => restoring.value !== null || deleting.value !== null || bulkDeleting.value)

const isCurrent = (v: ConfigVersion) => v.id === currentVersionId.value
const deletable = computed(() => versions.value.filter((v) => !isCurrent(v)))
onMounted(async () => {
  dialog.value?.showModal()
  if (props.compareWith) { const v = versions.value.find((x) => x.id === props.compareWith); if (v) await openDiff(v) }
})

// 比较方向固定：现在生效的 → 这个版本（恢复它会发生什么） / Fixed direction: the applied one → this version (what restoring it does)
async function openDiff(v: ConfigVersion): Promise<void> {
  if (selecting.value || isCurrent(v)) return
  preview.value = v
  blocks.value = null
  await nextTick()
  diffDialog.value?.showModal()
  try {
    const detail = await versionDetail(v.id)
    // 等的时候关掉了或换了一个版本，这份就不要了 / Closed or switched to another version meanwhile: this one is dropped
    if (preview.value?.id !== v.id) return
    blocks.value = diffModels(appliedModel.value, readConfig(detail.content).model)
  } catch (error) {
    toast.error(errorMessage(error))
    if (preview.value?.id === v.id) closeDiff()
  }
}
function closeDiff(): void { diffDialog.value?.close(); preview.value = null; blocks.value = null }
async function restore(v: ConfigVersion): Promise<void> {
  const ok = await confirm.ask({
    title: `恢复到配置版本 #${v.id}`,
    body: `${dirty.value ? '编辑器里未保存的修改会丢失。' : ''}会用版本 #${v.id} 的内容生成一个新版本并立即应用；现在这一版留在历史里，随时可以再恢复。`,
    confirmLabel: `恢复版本 #${v.id}`,
  })
  if (!ok) return
  closeDiff()
  try {
    const r = await restoreVersion(v.id)
    toast.success(r.state === 'pending' ? `版本 #${v.id} 已保存为待应用版本` : `版本 #${v.id} 已恢复，当前版本 #${r.versionId}`)
  } catch (error) {
    toast.error(`没有恢复版本 #${v.id}：${friendlyRuntimeError(error)}`)
  }
}
async function remove(v: ConfigVersion): Promise<void> {
  if (isCurrent(v)) { toast.error('当前生效版本不能删除，请先恢复其他版本'); return }
  const ok = await confirm.ask({ title: `删除配置版本 #${v.id}`, body: '删除后不能恢复。当前生效的配置不受影响。', confirmLabel: '删除这个版本', items: [`#${v.id} · ${v.message || '未填写备注'}`], destructive: true })
  if (!ok) return
  try {
    await deleteVersion(v)
    toast.success(`配置版本 #${v.id} 已删除`)
  } catch (error) {
    toast.error(errorMessage(error))
  }
}
async function removePicked(): Promise<void> {
  const list = versions.value.filter((v) => picked.value.includes(v.id))
  const ok = await confirm.ask({ title: `删除 ${list.length} 个历史版本`, body: '删除后不能恢复。当前生效的配置不受影响。', confirmLabel: `删除 ${list.length} 个版本`, items: list.map((v) => `#${v.id} · ${v.message || '未填写备注'}`), destructive: true })
  if (!ok) return
  try {
    const count = await deleteVersions(list.map((v) => v.id))
    toast.success(`已删除 ${count} 个配置版本`)
    picked.value = []
    selecting.value = false
  } catch (error) {
    toast.error(errorMessage(error))
  }
}
function toggle(v: ConfigVersion): void {
  if (isCurrent(v)) return
  picked.value = picked.value.includes(v.id) ? picked.value.filter((x) => x !== v.id) : [...picked.value, v.id]
}
const menu = () => [
  { value: 'compare', label: '和当前比较' },
  { value: 'restore', label: '恢复为这个版本', disabled: busy.value },
  { value: 'delete', label: '删除这个版本', danger: true, disabled: busy.value },
]
function act(v: ConfigVersion, value: string): void {
  if (value === 'compare') void openDiff(v)
  else if (value === 'restore') void restore(v)
  else if (value === 'delete') void remove(v)
}
function onRuleLink(id: number): void { dialog.value?.close(); emit('rule', id) }
</script>

<template>
  <dialog ref="dialog" class="pdrawer hist" aria-labelledby="hist-title" @cancel.prevent="preview ? closeDiff() : emit('close')" @click.self="emit('close')">
    <aside class="pdrawer__panel" :class="{ 'is-covered': preview }">
      <header class="pdrawer__head">
        <h2 id="hist-title">历史版本</h2>
        <button class="ui-icon-btn" type="button" aria-label="关闭历史版本" title="关闭历史版本" @click="emit('close')"><X :size="16" /></button>
      </header>
      <ol v-if="versions.length" class="hist__list">
        <li v-for="v in versions" :key="v.id" class="hist__row" :class="{ 'is-picked': picked.includes(v.id), 'is-current': isCurrent(v) }">
          <label v-if="selecting" class="ui-checkbox hist__check" :class="{ 'is-hidden': isCurrent(v) }"><input type="checkbox" :checked="picked.includes(v.id)" :disabled="isCurrent(v)" :aria-label="`选择版本 #${v.id}`" @change="toggle(v)"><i></i></label>
          <button class="hist__main" type="button" :disabled="isCurrent(v) && !selecting" @click="selecting ? toggle(v) : openDiff(v)">
            <span class="hist__note" :class="{ 'is-empty': !v.message }">{{ v.message || '未填写备注' }}</span>
            <span class="hist__meta">#{{ v.id }} · {{ formatVersionTime(v.created_at) }} · {{ v.actor }}</span>
          </button>
          <span class="hist__tags">
            <span v-if="restoring === v.id" class="hist__busy"><span class="ui-spin" aria-hidden="true"></span>恢复中</span>
            <span v-else-if="deleting === v.id" class="hist__busy"><span class="ui-spin" aria-hidden="true"></span>删除中</span>
            <span v-else-if="isCurrent(v)" class="ui-tag ui-tag--ok">当前</span>
            <span v-else-if="v.apply_state === 'failed'" class="ui-tag ui-tag--err">失败</span>
            <span v-else-if="v.apply_state === 'pending'" class="ui-tag ui-tag--warn">待应用</span>
          </span>
          <span class="hist__menu"><UiMenu v-if="!isCurrent(v) && !selecting" :items="menu()" :label="`版本 #${v.id} 的操作`" :title="`#${v.id} · ${v.message || '未填写备注'}`" anchor=".hist__row" @select="act(v, $event)" /><!-- 当前版本也占着这一格（不能操作），各行的标签落在同一条右边 / The current version keeps the slot too (disabled), so every row's tag ends on the same right edge --><button v-else-if="isCurrent(v) && !selecting" class="ui-icon-btn ui-icon-btn--sm" type="button" disabled aria-label="当前版本没有可做的操作"><Ellipsis :size="16" aria-hidden="true" /></button></span>
          <p v-if="v.apply_error" class="hist__err"><RuleText :text="v.apply_error" @rule="onRuleLink" /></p>
        </li>
      </ol>
      <p v-else class="hist__empty">还没有保存过版本</p>
      <!-- 批量删除从底栏进出，页头只有标题和关闭 / Bulk delete is entered and left from the footer; the header holds only the title and close -->
      <footer v-if="selecting" class="pdrawer__foot"><button class="ui-btn ui-btn--secondary" type="button" :disabled="bulkDeleting" @click="selecting = false; picked = []">取消</button><span class="editor__spacer"></span><button class="ui-btn ui-btn--danger" type="button" :disabled="!picked.length || bulkDeleting" @click="removePicked">{{ picked.length ? `删除 ${picked.length} 个版本` : '删除所选' }}</button></footer>
      <footer v-else-if="deletable.length" class="pdrawer__foot hist__foot"><button class="ui-btn ui-btn--danger hist__bulk" type="button" @click="selecting = true; picked = []"><Trash2 :size="16" aria-hidden="true" />批量删除</button></footer>
    </aside>
    <dialog ref="diffDialog" class="pdialog diffd" aria-labelledby="diff-title" @cancel.prevent="closeDiff" @click.self="closeDiff">
      <div v-if="preview" class="pdialog__panel diffd__panel">
        <header class="pdialog__head">
          <!-- 全文还没到时只有谁、什么时候；比较的那句等算出来再接在前面 / Until the content arrives only who and when; the comparison phrase joins in front once computed -->
          <div class="pdrawer__titles"><h2 id="diff-title">#{{ preview.id }} · {{ preview.message || '未填写备注' }}</h2><p><template v-if="blocks">{{ blocks.length ? `和当前比，${blocks.length} 处不同` : '和当前一样' }} · </template>{{ preview.actor }} · {{ formatVersionTime(preview.created_at) }}</p></div>
          <button class="ui-icon-btn" type="button" aria-label="关闭比较" @click="closeDiff"><X :size="16" /></button>
        </header>
        <div class="pdialog__body diffd__body">
          <template v-if="blocks && blocks.length">
            <p class="diffd__legend">恢复这个版本：<span class="diffd__sign">−</span> 去掉 <span class="diffd__sign">+</span> 加上</p>
            <section v-for="(b, i) in blocks" :key="i" class="diffd__block">
              <h3><span class="diffd__kind">{{ b.kind }}</span>{{ b.title }}<small v-if="b.note">{{ b.note }}</small></h3>
              <ul><li v-for="(l, j) in b.lines" :key="j" :class="l.sign === '+' ? 'is-add' : 'is-del'"><span class="diffd__sign" aria-hidden="true">{{ l.sign === '+' ? '+' : '−' }}</span><span class="visually-hidden">{{ l.sign === '+' ? '加上' : '去掉' }}</span>{{ l.text }}</li></ul>
            </section>
          </template>
          <p v-else-if="blocks" class="hist__empty">这个版本和当前的配置一样，恢复它不会改变什么。</p>
        </div>
        <footer v-if="blocks && blocks.length" class="pdialog__foot"><button class="ui-btn ui-btn--secondary" type="button" @click="closeDiff">关闭</button><button class="ui-btn ui-btn--primary" type="button" @click="restore(preview)">恢复为版本 #{{ preview.id }}</button></footer>
      </div>
    </dialog>
  </dialog>
</template>
