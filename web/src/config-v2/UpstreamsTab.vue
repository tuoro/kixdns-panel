<script setup lang="ts">
import { Plus, Server } from '@lucide/vue'
import UiDotText from '../components/ui/UiDotText.vue'
import UiEmpty from '../components/ui/UiEmpty.vue'
import UiMenu from '../components/ui/UiMenu.vue'
import { useToast } from '../composables/useToast'
import { ecsText, effectiveProtocol, fallbackSentence, PROTOCOL_LABEL, type UpstreamGroup } from '../config-model/model'
import { usePhone } from './phone'
import { groupUsers, healthOf, model } from './store'
import { fmtTimes } from './view'

// 上游组：每组一张卡。标题行是组名和它的标签，右端 编辑 和「…」；下面是近一小时好不好；地址一行一条；最下面一句备用和子网。
// 「新建上游组」是这一页唯一的主操作：宽屏传送到页头，手机在列表上面一行。
// Upstream groups, one card each. The title row is the name with its tags, 编辑 and 「…」 at the right end; under it the last hour's
// health; one address per row; fallback and subnet close the card. 新建上游组 is the tab's one primary action: it teleports to the page
// header on wide screens and takes a row above the list on phones.
const emit = defineEmits<{ edit: [id: string | null]; rules: [groupId: string] }>()
const toast = useToast()
const phone = usePhone()

const health = (g: UpstreamGroup) => healthOf(g)
const tone = (rate: number) => (rate >= 99 ? '' : rate >= 95 ? 'ui-dot--warn' : 'ui-dot--err')
// 延迟只有拿到过回复才有数；没有就不写「平均 … ms」 / Latency exists only once a reply came back; without one the 平均 … ms part is left out
const healthParts = (g: UpstreamGroup): string[] => {
  const h = health(g)!
  return [`成功 ${h.success}%`, ...(h.latency === null ? [] : [`平均 ${h.latency} ms`]), `近一小时 ${fmtTimes(h.queries)}`]
}
const shown = (address: string) => address.replace(/^[a-z+]+:\/\//i, '')
function facts(g: UpstreamGroup): string[] {
  return [fallbackSentence(model, g) ?? '没有备用组', ecsText(g.ecs)]
}
function menu(g: UpstreamGroup) {
  const inUse = groupUsers(g.id).length > 0
  return [
    { value: 'edit', label: '编辑' },
    { value: 'default', label: '设为其余请求的上游', disabled: model.rest.type === 'upstream' && model.rest.group === g.id },
    { value: 'delete', label: inUse ? '删除（还在用）' : '删除', danger: true, disabled: inUse },
  ]
}
function act(g: UpstreamGroup, value: string): void {
  if (value === 'edit') emit('edit', g.id)
  else if (value === 'default') { model.rest = { type: 'upstream', group: g.id }; toast.success(`其余请求改为交给「${g.name}」`) }
  else if (value === 'delete') {
    const at = model.groups.indexOf(g)
    model.groups.splice(at, 1)
    toast.undoable(`已删除上游组「${g.name}」`, () => model.groups.splice(at, 0, g))
  }
}
</script>

<template>
  <div class="ups">
    <!-- 手机：按钮自己一行；宽屏：传送到页头，和规则页的「新建规则」同一处 / Phones: the button on a row of its own; wide screens: teleported to the page header, where the rules tab keeps 新建规则 -->
    <div v-if="phone" class="toolbar ups__bar">
      <button class="ui-btn ui-btn--primary" type="button" @click="emit('edit', null)"><Plus :size="16" aria-hidden="true" />新建上游组</button>
    </div>
    <Teleport v-else defer to="#cfg-actions">
      <button class="ui-btn ui-btn--primary" type="button" @click="emit('edit', null)"><Plus :size="16" aria-hidden="true" />新建上游组</button>
    </Teleport>
    <!-- 没有组时那句引导放在空状态里，不再占着工具行 / With no groups the lead sentence lives in the empty state instead of a tools row -->
    <UiEmpty v-if="!model.groups.length" class="ui-card ups__empty" :icon="Server" title="还没有上游组" desc="规则里选组名就行，地址、加密方式和备用都在组里设一次。" />
    <div v-else class="gcards">
      <article v-for="g in model.groups" :key="g.id" class="ui-card gcard">
        <header class="gcard__head">
          <button class="gcard__name" type="button" @click="emit('edit', g.id)">{{ g.name }}</button>
          <span v-if="model.rest.type === 'upstream' && model.rest.group === g.id" class="ui-tag">其余请求</span>
          <span class="gcard__spacer"></span>
          <button v-if="groupUsers(g.id).length" class="ui-link gcard__uses gcard__uses--head" type="button" :title="groupUsers(g.id).join('\n')" @click="emit('rules', g.id)">{{ groupUsers(g.id).length }} 处在用</button>
          <span v-else class="gcard__unused gcard__uses--head">没有规则在用</span>
          <button class="ui-btn ui-btn--secondary ui-btn--sm ui-btn--inline gcard__edit" type="button" @click="emit('edit', g.id)">编辑</button>
          <UiMenu :items="menu(g)" :label="`上游组「${g.name}」的操作`" @select="act(g, $event)" />
        </header>
        <!-- 「几处在用」在标题行，状态行只放健康数字 / 「N 处在用」 sits in the title row; the status line holds only the health figures -->
        <p class="gcard__health">
          <template v-if="health(g)">
            <span class="ui-dot" :class="tone(health(g)!.success)" aria-hidden="true"></span>
            <UiDotText class="ui-dot-text--stats" :parts="healthParts(g)" />
          </template>
        </p>
        <!-- 地址一行一条，行间细线：地址等宽在左，协议标签在右端。健康数字只有整组的，没有每个地址的延迟，所以行下不画条
             One address per hairline row: the address in mono on the left, the protocol tag at the right end. Health is per group, not per address, so no latency bar under a row -->
        <ul class="gcard__addrs">
          <li v-for="(a, i) in g.addresses" :key="i"><span class="gcard__addr">{{ shown(a.address) }}</span><span class="ui-tag gcard__proto">{{ PROTOCOL_LABEL[effectiveProtocol(a)] }}</span></li>
        </ul>
        <p class="gcard__facts"><UiDotText :parts="facts(g)" /></p>
      </article>
    </div>
  </div>
</template>
