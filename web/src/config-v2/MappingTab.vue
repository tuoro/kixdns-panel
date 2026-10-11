<script setup lang="ts">
import { Check, FileInput, Plus, Search, X } from '@lucide/vue'
import UiHelp from '../components/ui/UiHelp.vue'
import { computed, nextTick, reactive, ref } from 'vue'
import UiEmpty from '../components/ui/UiEmpty.vue'
import UiMenu from '../components/ui/UiMenu.vue'
import { useToast } from '../composables/useToast'
import { isDomain, isIp, mappingIsIp, splitList, type Mapping } from '../config-model/model'
import { usePhone } from './phone'
import { changedMappingIds, model, newId } from './store'
import { canCname } from './useConfigDocument'

// 域名映射：域名直接回答一个 IP 或另一个域名，先于所有规则，也管子域名。像通讯录一样一行一条，上面一行直接添加。
// Local mappings: a domain answers an IP or another name, ahead of every rule and for its subdomains too. One line each like an
// address book, with an add line on top.
const toast = useToast()
const phone = usePhone()
const add = reactive({ domain: '', target: '' })
const addError = ref('')
const domainInput = ref<HTMLInputElement | null>(null)
const query = ref('')

function targetProblem(target: string): string | null {
  const t = target.trim()
  if (!t) return '填要回答的 IP 或域名'
  if (splitList(t).every(isIp)) return null
  if (isDomain(t)) return canCname.value ? null : '当前 KixDNS 不支持固定 CNAME，回答只能写 IP'
  return '回答写成 IP（几个用逗号隔开）或一个域名'
}
function problem(domain: string, target: string, self: number | null): string | null {
  const d = domain.trim().toLowerCase()
  if (!d) return '填要映射的域名'
  if (!isDomain(d)) return '域名写得不对'
  if (model.mappings.some((r) => r.id !== self && r.domain.toLowerCase() === d)) return `${d} 已经有映射了`
  return targetProblem(target)
}
function submit(): void {
  const p = problem(add.domain, add.target, null)
  if (p) { addError.value = p; return }
  // 加在最后：从上往下第一条命中的生效，后加的不抢前面的 / Appended: the first match wins, so a new row never overrides earlier ones
  const row = { id: newId(), domain: add.domain.trim().toLowerCase(), target: add.target.trim(), ttl: null, enabled: true }
  model.mappings.push(row)
  void nextTick(() => { const el = document.querySelector<HTMLElement>(`[data-rw="${row.id}"]`); el?.scrollIntoView({ block: 'nearest' }); el?.classList.add('is-fresh'); setTimeout(() => el?.classList.remove('is-fresh'), 1600) })
  add.domain = ''
  add.target = ''
  addError.value = ''
  domainInput.value?.focus()
}
const kind = (r: Mapping) => (mappingIsIp(r) ? [...new Set(splitList(r.target).map((ip) => (ip.includes(':') ? 'AAAA' : 'A')))].join(' + ') : 'CNAME')
// 添加行的类型列：回答写对了就先显示会回什么记录 / The add row's type column: once the answer is valid it shows the record it will give
const addKind = computed(() => (add.target.trim() && !targetProblem(add.target) ? kind({ id: -1, domain: '', target: add.target.trim(), ttl: null, enabled: true }) : ''))
const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  return q ? model.mappings.filter((r) => `${r.domain} ${r.target}`.toLowerCase().includes(q)) : model.mappings
})

// 行内编辑 / inline edit
const editing = reactive({ id: -1, domain: '', target: '', ttl: '' as string, error: '' })
async function edit(r: Mapping): Promise<void> {
  Object.assign(editing, { id: r.id, domain: r.domain, target: r.target, ttl: r.ttl === null ? '' : String(r.ttl), error: '' })
  await nextTick()
  document.querySelector<HTMLInputElement>(`[data-rw="${r.id}"] input`)?.focus()
}
function commit(r: Mapping): void {
  const p = problem(editing.domain, editing.target, r.id)
  if (p) { editing.error = p; return }
  Object.assign(r, { domain: editing.domain.trim().toLowerCase(), target: editing.target.trim(), ttl: editing.ttl === '' ? null : Number(editing.ttl) })
  editing.id = -1
}
const rowMenu = (r: Mapping) => {
  const i = model.mappings.indexOf(r)
  const last = model.mappings.length - 1
  return [
    { value: 'edit', label: '编辑' },
    { value: 'top', label: '移到最前', disabled: i === 0 }, { value: 'up', label: '上移', disabled: i === 0 },
    { value: 'down', label: '下移', disabled: i === last }, { value: 'bottom', label: '移到最后', disabled: i === last },
    { value: 'delete', label: '删除', danger: true },
  ]
}
function act(r: Mapping, value: string): void {
  const at = model.mappings.indexOf(r)
  const move = (to: number) => { model.mappings.splice(at, 1); model.mappings.splice(to, 0, r) }
  if (value === 'top') move(0)
  else if (value === 'up') move(at - 1)
  else if (value === 'down') move(at + 1)
  else if (value === 'bottom') move(model.mappings.length - 1)
  else if (value === 'edit') void edit(r)
  else if (value === 'delete') {
    const at = model.mappings.indexOf(r)
    model.mappings.splice(at, 1)
    toast.undoable(`已删除 ${r.domain} 的映射`, () => model.mappings.splice(at, 0, r))
  }
}

// 批量导入：一行一条「域名 回答 [TTL]」，用空格隔开，也认 hosts 文件的「IP 域名」。不用箭头：键盘上打不方便。
// Bulk import: one 「domain answer [TTL]」 per line, separated by spaces; hosts-file 「IP domain」 too. No arrows: they are awkward to type.
const importDialog = ref<HTMLDialogElement | null>(null)
const importText = ref('')
const parsed = computed(() => importText.value.split('\n').map((line) => line.replace(/#.*/, '').trim()).filter(Boolean).map((line) => {
  const parts = line.split(/\s+/)
  const ttlText = parts.length > 2 && /^\d+$/.test(parts.at(-1)!) ? parts.pop()! : null
  const [a = '', ...rest] = parts
  const b = rest.join(' ')
  const [domain, target] = isIp(a) ? [b.split(/\s+/)[0] ?? '', a] : [a, b]
  const ttl = ttlText === null ? null : Number(ttlText)
  const bad = ttl !== null && splitList(target).every(isIp) ? 'IP 回答的 TTL 固定 300 秒，去掉最后的数字' : null
  return { domain: domain.toLowerCase(), target, ttl, problem: problem(domain, target, null) ?? bad }
}))
const importable = computed(() => parsed.value.filter((p) => !p.problem))
function runImport(): void {
  for (const p of importable.value) model.mappings.push({ id: newId(), domain: p.domain, target: p.target, ttl: p.ttl, enabled: true })
  toast.success(`导入了 ${importable.value.length} 条域名映射`)
  importText.value = ''
  importDialog.value?.close()
}
</script>

<template>
  <div class="rw">
    <section class="ui-card rw__list" aria-label="域名映射列表">
      <!-- 和规则列表同一种排法：工具行是卡片的第一行（搜索在左，批量导入是右端的文字按钮），添加行在它下面
           Laid out like the rules list: the tools row is the card's first row (search left, 批量导入 as a text button at the right end), the add row under it -->
      <div class="rw__tools">
        <label v-if="model.mappings.length" class="ui-input rw__search"><Search :size="16" aria-hidden="true" /><input v-model="query" type="search" aria-label="搜索域名映射" placeholder="搜索域名或地址"></label>
        <button class="ui-btn ui-btn--text rw__import" type="button" @click="importDialog?.showModal()"><FileInput :size="16" aria-hidden="true" />批量导入</button>
        <UiHelp topic="mapping" />
      </div>
      <!-- 添加行和下面的表共用列：域名、回答写在各自的列里，类型列随输入显示会回什么记录，「添加」在行尾。和规则页的快速添加一样不画输入框
           The add row shares the table's columns: domain and answer in their own columns, the type column shows the record it will answer as you type, 添加 at the row end. Borderless like the rules tab's quick add -->
      <form class="rw__add" :class="{ 'is-typing': add.domain.trim() || add.target.trim() }" @submit.prevent="submit">
        <Plus class="rw__addicon" :size="16" aria-hidden="true" />
        <label class="rw__field rw__field--domain"><input ref="domainInput" v-model="add.domain" aria-label="要映射的域名" :placeholder="phone ? '添加域名映射：nas.home.arpa' : '添加域名：nas.home.arpa'" autocapitalize="off" spellcheck="false" @input="addError = ''"></label>
        <label class="rw__field rw__field--target"><input v-model="add.target" aria-label="回答的 IP 或域名" placeholder="回答：IP 或域名" autocapitalize="off" spellcheck="false" @input="addError = ''"></label>
        <span class="rw__k rw__addkind" aria-live="polite"><span v-if="addKind" class="ui-tag ui-tag--mono">{{ addKind }}</span></span>
        <button class="ui-btn ui-btn--secondary rw__submit" :class="{ 'ui-btn--sm': !phone }" type="submit" :disabled="!add.domain.trim() || !add.target.trim()">添加</button>
        <p v-if="addError" class="ui-field-error rw__adderr" role="alert">{{ addError }}</p>
      </form>
      <UiEmpty v-if="!model.mappings.length" :icon="FileInput" title="还没有域名映射" desc="比如把 nas.home.arpa 指到 NAS 的内网地址。" />
      <template v-else>
        <div class="rw__head" aria-hidden="true"><span>域名<span class="rlist__order">先于所有规则生效，连同子域名；从上往下第一条命中的生效</span></span><span>回答</span><span>类型</span><span>启用</span><span></span></div>
        <ul>
          <li v-for="r in shown" :key="r.id" class="rw__row" :class="{ 'is-off': !r.enabled, 'is-editing': editing.id === r.id }" :data-rw="r.id">
            <template v-if="editing.id === r.id">
              <form class="rw__edit" @submit.prevent="commit(r)">
                <label class="ui-input ui-input--sm is-mono"><input v-model="editing.domain" aria-label="域名" :aria-invalid="Boolean(editing.error) || undefined" :aria-describedby="editing.error ? 'rw-edit-err' : undefined" @input="editing.error = ''"></label>
                <label class="ui-input ui-input--sm is-mono"><input v-model="editing.target" aria-label="回答" :aria-invalid="Boolean(editing.error) || undefined" :aria-describedby="editing.error ? 'rw-edit-err' : undefined" @input="editing.error = ''"></label>
                <label v-if="!splitList(editing.target).every(isIp)" class="ui-input ui-input--sm rw__ttl"><input v-model="editing.ttl" type="number" min="0" aria-label="TTL" placeholder="300"><i>秒</i></label>
                <span v-else class="rw__ttl rw__ttl--fixed">TTL 300 秒</span>
                <button class="ui-icon-btn ui-icon-btn--sm" type="submit" aria-label="保存" title="保存"><Check :size="14" /></button>
                <button class="ui-icon-btn ui-icon-btn--sm" type="button" aria-label="取消" title="取消" @click="editing.id = -1"><X :size="14" /></button>
                <p v-if="editing.error" id="rw-edit-err" class="ui-field-error rw__err" role="alert">{{ editing.error }}</p>
              </form>
            </template>
            <template v-else>
              <button class="rw__d" type="button" @click="edit(r)">{{ r.domain }}<span v-if="changedMappingIds.has(r.id)" class="ui-dot ui-dot--ink rrow__changed" role="img" aria-label="改过，还没保存" title="改过，还没保存"></span></button>
              <!-- TTL 是回答的一部分，跟在回答后面；类型列只放类型 / The TTL belongs to the answer and follows it; the type column holds only the type -->
              <span class="rw__t">{{ r.target }}<span v-if="r.ttl !== null" class="rw__ttlnote">TTL {{ r.ttl }} 秒</span></span>
              <span class="rw__k"><span class="ui-tag ui-tag--mono">{{ kind(r) }}</span></span>
              <label class="ui-switch"><input v-model="r.enabled" type="checkbox" :aria-label="`启用 ${r.domain} 的映射`"><i></i></label>
              <UiMenu :items="rowMenu(r)" :label="`${r.domain} 的操作`" anchor=".rw__row" @select="act(r, $event)" />
            </template>
          </li>
        </ul>
        <p v-if="!shown.length" class="rlist__none">没有符合的映射</p>
      </template>
    </section>

    <dialog ref="importDialog" class="pdialog" aria-labelledby="rwi-title" @click.self="importDialog?.close()">
      <form class="pdialog__panel" @submit.prevent="runImport">
        <header class="pdialog__head"><h2 id="rwi-title">批量导入域名映射</h2><button class="ui-icon-btn" type="button" aria-label="关闭" @click="importDialog?.close()"><X :size="16" /></button></header>
        <div class="pdialog__body">
          <label class="pfield"><span>一行一条：域名 回答 [TTL]。hosts 文件的「IP 域名」也认。</span>
            <span class="ui-input ui-input--area"><textarea v-model="importText" rows="7" autofocus aria-label="要导入的域名映射" placeholder="nas.home.arpa 192.168.1.10&#10;192.168.1.20 tv.home.arpa&#10;files.home.arpa nas.home.arpa"></textarea></span>
          </label>
          <ul v-if="parsed.length" class="rwi">
            <li v-for="(p, i) in parsed" :key="i" :class="{ 'is-bad': p.problem }"><span class="is-mono">{{ p.domain || '—' }} → {{ p.target || '—' }}{{ p.ttl !== null ? ` · ${p.ttl} 秒` : '' }}</span><small v-if="p.problem">{{ p.problem }}</small></li>
          </ul>
        </div>
        <footer class="pdialog__foot"><button class="ui-btn ui-btn--secondary" type="button" @click="importDialog?.close()">取消</button><button class="ui-btn ui-btn--primary" type="submit" :disabled="!importable.length">{{ importable.length ? `导入 ${importable.length} 条` : '导入' }}</button></footer>
      </form>
    </dialog>
  </div>
</template>
