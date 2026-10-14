<script setup lang="ts">
import { Plus, Server } from '@lucide/vue'
import { computed } from 'vue'
import UiDotText from '../components/ui/UiDotText.vue'
import UiEmpty from '../components/ui/UiEmpty.vue'
import UiMenu from '../components/ui/UiMenu.vue'
import { useConfirm } from '../composables/useConfirm'
import { useToast } from '../composables/useToast'
import { ecsText, effectiveProtocol, fallbackSentence, PROTOCOL_LABEL, type UpstreamGroup } from '../config-model/model'
import { usePhone } from './phone'
import { changedGroupIds, copyReplaceBlocker, groupUsers, healthOf, model, oldPanelCopies, replaceWithCopy } from './store'

// 上游组：每组一张卡。标题行是组名和它的标签，右端 编辑 和「…」；下面是近一小时好不好；地址一行一条；最下面一句备用和子网。
// 「新建上游组」是这一页唯一的主操作：宽屏传送到页头，手机在列表上面一行。
// Upstream groups, one card each. The title row is the name with its tags, 编辑 and 「…」 at the right end; under it the last hour's
// health; one address per row; fallback and subnet close the card. 新建上游组 is the tab's one primary action: it teleports to the page
// header on wide screens and takes a row above the list on phones.
const emit = defineEmits<{ edit: [id: string | null]; rules: [groupId: string] }>()
const toast = useToast()
const confirm = useConfirm()
const phone = usePhone()

const health = (g: UpstreamGroup) => healthOf(g)
// 卡片上写明还用在哪儿；「其余请求」标题行已有标签，不重复 / The card says where else it is used; 其余请求 already has a tag in the title row
const usedIn = (g: UpstreamGroup): string[] => groupUsers(g.id).filter((use) => use !== '其余请求')
// 旧版面板留下的副本：副本卡片底部一行说来历，后面跟「用它替换「原组」」；不能一键替换时说为什么
// A copy the old panel left behind: one line at the foot of the copy's card says where it came from, followed by 用它替换「原组」, or why that is not possible
// 名字里的连字符后面不折行：手机上「global-copy」不会断成两行 / No break after a hyphen in a name: on phones 「global-copy」 stays on one line
const glue = (name: string): string => name.replace(/-(?=\w)/g, '-\u2060')
const copyOf = computed(() => new Map(oldPanelCopies().map(({ copy, original }) => {
  const blocker = copyReplaceBlocker(copy, original)
  const name = `「${glue(original.name)}」`
  return [copy.id, { original, origin: `旧版面板改${name}时复制的${blocker ? `；${blocker}，不能一键替换` : ''}`, action: blocker ? null : `用它替换${name}` }]
})))
async function replace(copy: UpstreamGroup): Promise<void> {
  const original = copyOf.value.get(copy.id)!.original
  const [from, to] = [`「${glue(copy.name)}」`, `「${glue(original.name)}」`]
  // 确认框里只写主机名，连字符处不折行：手机上不会断成「cloudflare-」和「dns.com」两截 / The dialog names hosts only, unbroken at hyphens, so a phone never splits cloudflare- from dns.com
  const addresses = [...new Set(copy.addresses.map((a) => glue(shown(a.address).replace(/\/.*$/, ''))))]
  const upstreams = addresses.length > 3 ? `${addresses.slice(0, 3).join('、')} 等 ${addresses.length}\u00a0个` : addresses.join('、')
  const uses = groupUsers(original.id)
  const ok = await confirm.ask({
    title: `用${from}替换${to}`,
    // 先说替换后是什么样，再说哪些地方的走向会变：副本自己用着的地方上游不变，不用列 / What it looks like afterwards, then whose route changes: the copy's own uses keep their upstreams and are not listed
    body: `替换后只留${to}一组，${addresses.length ? `上游是 ${upstreams}` : '还没有上游地址'}，保存后生效。${uses.length ? `原来走${to}的这些地方会跟着换：` : `${to}现在没有地方在用，解析不受影响。`}`,
    items: uses,
    confirmLabel: '替换',
  })
  // 等确认的时候草稿可能整份换过（重新读入、导入），这一对不在了或者不能替换了就不动：卡片会照新的样子显示
  // The draft may have been replaced while the dialog was open (re-read, import); if the pair is gone or blocked, leave it, the cards show the new state
  if (!ok || !model.groups.includes(copy) || !model.groups.includes(original) || copyReplaceBlocker(copy, original)) return
  toast.undoable(`已用${from}替换${to}`, replaceWithCopy(copy, original))
}
const tone = (rate: number) => (rate >= 99 ? '' : rate >= 95 ? 'ui-dot--warn' : 'ui-dot--err')
// 延迟只有拿到过回复才有数；没有就不写「平均 … ms」 / Latency exists only once a reply came back; without one the 平均 … ms part is left out
const healthParts = (g: UpstreamGroup): string[] => {
  const h = health(g)!
  // 和概览的上游状态同一种写法、同一种算法：成功率、平均耗时、那个时段的次数（不缩成「万」） / Worded and computed as the overview's upstream status: success rate, mean latency, the period's count (never shortened to 万)
  return [`成功率 ${h.success}%`, ...(h.latency === null ? [] : [`平均 ${h.latency} ms`]), `${h.period} ${h.queries.toLocaleString('en-US')}\u00a0次响应`]
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
    <div v-if="model.groups.length" class="gcards">
      <article v-for="g in model.groups" :key="g.id" class="ui-card gcard">
        <header class="gcard__head">
          <!-- 改过还没保存的组和规则、映射一样带一个点 / A group changed but not yet saved carries the same dot as rules and mappings -->
          <button class="gcard__name" type="button" @click="emit('edit', g.id)"><span class="gcard__name-text">{{ g.name }}</span><span v-if="changedGroupIds.has(g.id)" class="ui-dot ui-dot--ink rrow__changed" role="img" aria-label="改过，还没保存" title="改过，还没保存"></span></button>
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
        <!-- 说明和「用在…」同占卡片的最后一格：同一排的卡片按四格对齐，多一格会把对齐打乱
             The facts and 「用在…」 share the card's last track: cards in a row align on four tracks, and a fifth would break that -->
        <div class="gcard__foot">
          <p class="gcard__facts"><UiDotText :parts="facts(g)" /></p>
          <p v-if="usedIn(g).length" class="gcard__facts">用在{{ usedIn(g).join('、') }}</p>
          <p v-if="copyOf.has(g.id)" class="gcard__facts gcard__copy">
            <span>{{ copyOf.get(g.id)!.origin }}</span>
            <button v-if="copyOf.get(g.id)!.action" class="ui-link" type="button" @click="replace(g)">{{ copyOf.get(g.id)!.action }}</button>
          </p>
        </div>
      </article>
    </div>
  </div>
</template>
