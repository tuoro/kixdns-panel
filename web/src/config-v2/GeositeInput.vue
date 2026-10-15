<script setup lang="ts">
import { ChevronDown, X } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import type { UiMenuItem } from '../components/ui/UiMenu.vue'
import UiMenu from '../components/ui/UiMenu.vue'
import { geositeIssue, geositeWarning, refineOptions, searchGeosite, splitTag, type GeositeOption } from '../config-model/geosite'
import { usePhone } from './phone'
import { useGeositeCatalog } from './useGeosite'
import { fmtCount } from './view'

// GeoSite 条件的值：和别的条件一样一个值一块。打字时下面列出数据里的分类（名字、说明、域名数），上下键挑、回车选，
// 也可以照旧直接写。带属性的分类块上有个小箭头，点开选「全部」或只要带某个属性的域名（google@cn）。数据里没有的值
// 块变黄，提示由条件表单写在下面。手机上列表就放在输入框下面，不另弹一层。
// A GeoSite condition's values, one block each as in the other conditions. Typing lists the data's categories below (name,
// note, domain count), picked with the arrow keys and Enter, or the value is typed out as before. A category with
// attributes gets a small chevron on its block, choosing 全部 or only the domains carrying one attribute (google@cn). A value
// the data lacks turns amber, the condition form explaining why below. On a phone the list sits right under the field
// instead of floating.
const props = withDefaults(defineProps<{
  modelValue: string[]
  label: string
  placeholder?: string
  valid?: (value: string) => boolean
  invalid?: boolean
  /** 出错时指向错误提示的 id / The error message's id while invalid */
  describedby?: string
}>(), { placeholder: '', valid: () => true, invalid: false, describedby: undefined })
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

const catalog = useGeositeCatalog()
const phone = usePhone()
const id = useId()
const listId = `${id}-list`
const optionId = (index: number): string => `${id}-opt-${index}`
const text = ref('')
const focused = ref(false)
// 按了 Esc：列表先收起，接着打字或按下键再出来 / After Esc the list folds away until typing or the down arrow brings it back
const dismissed = ref(false)
const active = ref(-1)
const field = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)

const options = computed<GeositeOption[]>(() => (catalog.value.categories.size ? searchGeosite(catalog.value, text.value, props.modelValue) : []))
// 手机上列表就是弹层的一部分，一直摆着：跟着焦点收起的话，贴底的弹层会突然变矮，手指抬起时落到弹层外面把它关掉
// On a phone the list is part of the sheet and stays put: folding it on blur would shrink the bottom-anchored sheet, and a lifted finger would land outside and close it
const open = computed(() => (phone.value || focused.value) && !dismissed.value && options.value.length > 0)

// 有字时默认指着第一项，回车就选它；没字时不指，回车不做事 / With text the first option is active so Enter picks it; without text nothing is
watch(text, (value) => { active.value = value.trim() ? 0 : -1; dismissed.value = false })
watch(options, (next) => { if (active.value >= next.length) active.value = next.length - 1 })
watch(active, async (index) => {
  if (index < 0) return
  await nextTick()
  document.getElementById(optionId(index))?.scrollIntoView({ block: 'nearest' })
})

function addValues(values: string[]): void {
  const next = [...props.modelValue]
  for (const value of values) if (!next.includes(value)) next.push(value)
  if (next.length !== props.modelValue.length) emit('update:modelValue', next)
}
// 分类名不分大小写，统一写小写，和列表里的写法一样 / Names ignore case; values are written in lower case like the list
function add(raw: string): void {
  addValues(raw.split(/[\s,，;；]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))
}
function commit(): void {
  if (!text.value.trim()) return
  add(text.value)
  text.value = ''
}
function pick(option: GeositeOption): void {
  addValues([option.value])
  text.value = ''
  active.value = -1
  input.value?.focus()
}
function remove(index: number): void {
  emit('update:modelValue', props.modelValue.filter((_, i) => i !== index))
  input.value?.focus()
}
// 细分：把这一块换成选中的那一项；已经有同样的值就并掉 / Narrowing replaces the block with the chosen value, merging with an equal one
function refine(index: number, value: string): void {
  const next = props.modelValue.map((v, i) => (i === index ? value : v))
  emit('update:modelValue', next.filter((v, i) => next.indexOf(v) === i))
}

// 「1,077 个域名」「11.1 万个域名」：带单位时数和「个」之间不再空格 / 「1,077 个域名」, 「11.1 万个域名」: no second space after a unit
const domainsLabel = (n: number): string => { const count = fmtCount(n); return /[万亿]$/.test(count) ? `${count}个域名` : `${count}\u00a0个域名` }
const categoryOf = (value: string) => catalog.value.categories.get(splitTag(value.toLowerCase()).base)
const refinable = (value: string): boolean => Boolean(categoryOf(value)?.attributes.length)
function refineItems(value: string): UiMenuItem[] {
  const category = categoryOf(value)
  return category ? refineOptions(category).map((o) => ({ value: o.value, label: o.attr === null ? `全部（${domainsLabel(o.domains)}）` : `带 ${o.attr}：${o.note}（${domainsLabel(o.domains)}）` })) : []
}
const warned = (value: string): boolean => Boolean(geositeIssue(value, catalog.value))
const chipTitle = (value: string): string => (!props.valid(value) ? `${value}：写得不对` : geositeWarning([value], false, catalog.value) ?? value)

function onKey(event: KeyboardEvent): void {
  if (event.isComposing) return
  const count = options.value.length
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && count) {
    event.preventDefault()
    dismissed.value = false
    const step = event.key === 'ArrowDown' ? 1 : -1
    active.value = active.value < 0 ? (step > 0 ? 0 : count - 1) : (active.value + step + count) % count
  } else if (event.key === 'Enter' && open.value && active.value >= 0) {
    event.preventDefault()
    pick(options.value[active.value]!)
  } else if (event.key === 'Escape' && open.value) {
    // 只收起列表，不关掉外面的弹层 / Folds the list only, not the sheet or dialog around it
    event.preventDefault()
    event.stopPropagation()
    dismissed.value = true
  } else if (event.key === 'Enter' || event.key === ',' || event.key === ' ') {
    if (text.value.trim()) { event.preventDefault(); commit() }
    else if (event.key !== 'Enter') event.preventDefault()
  } else if (event.key === 'Backspace' && !text.value && props.modelValue.length) {
    emit('update:modelValue', props.modelValue.slice(0, -1))
  }
}
function onPaste(event: ClipboardEvent): void {
  const pasted = event.clipboardData?.getData('text') ?? ''
  if (!/[\s,，;；]/.test(pasted.trim())) return
  event.preventDefault()
  add(pasted)
}
function onFocus(): void {
  focused.value = true
  dismissed.value = false
}
function onBlur(): void {
  focused.value = false
  commit()
}

// 桌面上列表放在顶层（popover），不被检查器这些滚动容器裁掉；贴着输入框，下面放不下就往上翻
// On desktop the list lives in the top layer (popover) so scrolling containers never clip it; it hugs the field and flips up when there is no room below
function place(): void {
  const menu = list.value
  const box = field.value?.getBoundingClientRect()
  if (!menu || !box || phone.value) return
  // 至少 360 宽，说明列才放得下；窄的检查器里会伸出输入框右边 / At least 360 wide so the notes fit; in a narrow inspector it reaches past the field's right edge
  menu.style.setProperty('--gsi-w', `${Math.round(Math.max(box.width, 360))}px`)
  const gap = 4
  const height = menu.offsetHeight
  const below = window.innerHeight - box.bottom - gap
  const top = below >= height || box.top - gap < height ? box.bottom + gap : box.top - gap - height
  const left = Math.min(Math.max(8, box.left), window.innerWidth - menu.offsetWidth - 8)
  menu.style.setProperty('--gsi-x', `${Math.round(left)}px`)
  menu.style.setProperty('--gsi-y', `${Math.round(Math.max(8, top))}px`)
}
function listen(on: boolean): void {
  const method = on ? 'addEventListener' : 'removeEventListener'
  window[method]('resize', place)
  document[method]('scroll', place, true)
}
watch([open, phone], async ([isOpen, isPhone]) => {
  listen(false)
  if (!isOpen || isPhone) return
  await nextTick()
  if (list.value && !list.value.matches(':popover-open')) list.value.showPopover()
  place()
  listen(true)
})
// 候选变了（多一行少一行）高度跟着变，往上翻时要重新贴住 / A changed list changes height, so a flipped list re-hugs the field
watch(options, () => { if (open.value && !phone.value) void nextTick(place) })
onBeforeUnmount(() => listen(false))
</script>

<template>
  <div ref="field" class="chips ui-input" :class="{ 'chips--bad': invalid }" @click.self="input?.focus()">
    <span v-for="(value, index) in modelValue" :key="value" class="chip" :class="{ 'chip--bad': !valid(value), 'chip--warn': valid(value) && warned(value) }" :title="chipTitle(value)">
      <span class="chip__text">{{ value }}</span>
      <UiMenu v-if="refinable(value)" :items="refineItems(value)" :label="`细分 ${categoryOf(value)!.name}`" :title="`细分 ${categoryOf(value)!.name}`" align="start" trigger-class="chip__refine" @select="refine(index, $event)"><ChevronDown :size="14" aria-hidden="true" /></UiMenu>
      <button class="chip__x" type="button" :aria-label="`去掉 ${value}`" @click="remove(index)"><X :size="14" aria-hidden="true" /></button>
    </span>
    <input ref="input" v-model="text" role="combobox" :aria-label="label" :aria-invalid="invalid || undefined" :aria-describedby="describedby" aria-autocomplete="list" :aria-expanded="open" :aria-controls="open ? listId : undefined" :aria-activedescendant="open && active >= 0 ? optionId(active) : undefined" :placeholder="modelValue.length ? '' : placeholder" autocapitalize="off" autocomplete="off" spellcheck="false" @keydown="onKey" @paste="onPaste" @focus="onFocus" @blur="onBlur">
  </div>
  <!-- 字段下面的说明（出错、提醒）紧跟在框下面；手机上列表排在它们后面，说明不会被列表隔开
       The field's messages (errors, cautions) sit right under the field; on a phone the list follows them, so no list separates them from the field -->
  <slot />
  <!-- 按下时不让输入框失去焦点，点一项就是选它 / Pointer down keeps the field focused, so a click picks the option -->
  <ul v-if="open" :id="listId" ref="list" class="gsi" :class="{ 'gsi--pop': !phone }" role="listbox" :aria-label="`${label}的分类`" :popover="phone ? undefined : 'manual'" @pointerdown.prevent>
    <li v-for="(option, index) in options" :id="optionId(index)" :key="option.value" class="gsi__opt" :class="{ 'is-active': index === active }" role="option" :aria-selected="index === active" :title="`${option.value}：${option.domains.toLocaleString('en-US')} 个域名`" @click="pick(option)" @pointermove="active = index">
      <span class="gsi__name">{{ option.value }}</span>
      <span class="gsi__note">{{ option.note }}</span>
      <!-- 列表里只写数，单位在每行的提示里；细分菜单没有列，写全 / The list shows the number only, the unit in each row's tooltip; the narrowing menu has no columns, so it spells it out -->
      <span class="gsi__count">{{ fmtCount(option.domains) }}</span>
    </li>
  </ul>
</template>
