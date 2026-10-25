import { ref, watch } from 'vue'
import { ApiError, apiRequest, isPanelDown, jsonBody } from '../api/client'
import type { ConfigApplyResult, ConfigDocument, ServiceStatus } from '../api/types'
import { errorMessage } from '../utils'
import { useSession } from './useSession'
import { useToast } from './useToast'

/**
 * 启动、重启以后，KixDNS 读完配置、控制通道连上还要一会儿：等它回来（半秒看一次，最多十五秒）再说结果，起不来的 KixDNS
 * 不被说成已经启动、已经重启。认它回来看的是 `active_sha256`：只有活着的 KixDNS 报得出它；有待应用、应用失败的版本时，
 * 运行状态那一栏照样写 pending、failed，不能拿来认。内核先开控制通道、后绑监听，起不来的新进程也会短暂应答，所以要隔半秒
 * 连着两次读到它才算回来。
 * 等的时候面板自己连不上了（顶上的横幅会说）、或者退出登录了，结果是 `gone`，什么都不再说。
 *
 * After a start or restart KixDNS needs a moment to read its config and open the control channel: the outcome is told
 * once it is back (looking every half second, fifteen seconds at most), so a KixDNS that never comes up is not reported
 * as started or restarted. Back means `active_sha256` is there: only a live KixDNS reports it, while with a pending or
 * failed version the runtime status still reads pending or failed and proves nothing. The kernel opens its control channel
 * before binding its listeners, so a new process that cannot come up may answer briefly: it counts as back only when two
 * reads half a second apart both find it.
 * If the panel itself goes unreachable meanwhile (the banner says so) or the session ends, the outcome is `gone` and
 * nothing more is said.
 */
export async function waitForKixdns(): Promise<{ outcome: 'back' | 'silent' | 'gone'; doc: ConfigDocument | null; pendingSeen: number | null }> {
  const session = useSession()
  const deadline = Date.now() + 15_000
  let panelDown = false
  let doc: ConfigDocument | null = null
  let seen = false
  // 等的途中见过的待应用版本：回来时后台那一遍可能先一步把它应用了，最后一次读就看不到它 / The pending version seen while
  // waiting: on return the background pass may apply it first, and the last read no longer shows it
  let pendingSeen: number | null = null
  while (Date.now() < deadline) {
    // 只看最近一次：面板断开过又连上，照常等 KixDNS / Only the latest read counts: a panel that dropped and came back waits for KixDNS as usual
    doc = await apiRequest<ConfigDocument>('/api/v1/config').then((read) => {
      panelDown = false
      return read
    }, (error: unknown) => {
      panelDown = isPanelDown(error)
      return null
    })
    if (!session.authenticated.value) return { outcome: 'gone', doc: null, pendingSeen }
    if (doc?.pending?.version_id && !doc.pending.error) pendingSeen = doc.pending.version_id
    // 服务端已经看出它起不来（能不能退回都一样）：不用等满十五秒 / The server already sees it is not coming up (with or without
    // a rollback): no need to wait out the fifteen seconds
    if (doc?.runtime.restart_rollback || doc?.runtime.did_not_come_up) return { outcome: 'silent', doc, pendingSeen }
    if (doc?.runtime.active_sha256 && seen) {
      backUnconfirmed.value = false
      kixdnsBack()
      return { outcome: 'back', doc, pendingSeen }
    }
    seen = Boolean(doc?.runtime.active_sha256)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return { outcome: panelDown ? 'gone' : 'silent', doc, pendingSeen }
}

// 「没有回应」「启动失败」的错误提示不会自己消失：以后哪次读到 KixDNS 活着（再启动、systemd 下一次重试起来了）就收起，不留一句
// 过时的话 / The no-answer and failed-start errors do not clear themselves: whenever a later read finds KixDNS alive (another start,
// a systemd retry that came up) they are dismissed, rather than left saying something stale
let silentToast: number | null = null
export function kixdnsBack(): void {
  if (silentToast === null) return
  useToast().dismiss(silentToast)
  silentToast = null
}
export const dismissNoAnswer = kixdnsBack
// 从连不上变成连上，要连着两次读到才算回来：起不来的循环里新进程会短暂应答。在那之前各页接着看，「启动失败」那条提示也先留着。
// 配置页、概览、诊断、系统页每次读完都报一声；停着不算连不上
// Going from unreachable to reachable counts as back only after two reads in a row: in a loop that never comes up a new process
// answers briefly. Until then pages keep looking and the 启动失败 toast stays. The config page, overview, diagnostics and system
// page each report after every read; stopped does not count as unreachable
export const backUnconfirmed = ref(false)
let aliveOnce = false
export function noteRead(alive: boolean, stopped: boolean): void {
  if (!alive) {
    aliveOnce = false
    backUnconfirmed.value = !stopped
    return
  }
  if (backUnconfirmed.value && !aliveOnce) {
    aliveOnce = true
    return
  }
  backUnconfirmed.value = false
  kixdnsBack()
}
// 这一页正在说 KixDNS 起不来（配置页、概览、诊断、系统页的提示条）：那就不另弹一条，已经弹了的收起。一件事只在一处说。同步收：
// 提示条一出来紧接着就会说结果，那条提示不能晚一拍才收（会把刚弹的收掉）
// This page is saying KixDNS does not come up (the notice of the config page, the overview, diagnostics or the system page): no
// separate toast then, and one already shown goes. One thing is said in one place. Dismissed in sync: the outcome is said right
// after the notice appears, and a dismissal one tick late would take away the toast just raised
export const downShownHere = ref(false)
watch(downShownHere, (shown) => { if (shown) dismissNoAnswer() }, { flush: 'sync' })
// 开着的页面在说结果之前先重读（不管是哪一页发起的启动、重启）：结果出来时，页面上已经是读到的样子，提示条说了的不另弹
// Open pages read again before the outcome is said (whichever page started the start or restart): by the time the outcome is
// told the page shows what was read, and what its notice says is not raised again
const pageReaders = new Set<() => Promise<void>>()
export function readBeforeTelling(read: () => Promise<void>): () => void {
  pageReaders.add(read)
  return () => { pageReaders.delete(read) }
}
async function readPages(own?: () => Promise<void>): Promise<void> {
  await Promise.all([...pageReaders, ...(own ? [own] : [])].map((read) => read().catch(() => undefined)))
}
// 配置页开着没有：配置页外说「已应用」时要补上「有些设置要重启」那半句 / Whether the config page is open: away from it, 已应用
// needs its 「有些设置要重启」 clause
export const configPageOpen = ref(false)
/** 等不到它回来时说的话。起不来时和各页页头一样叫「启动失败」，能退回时指到配置页；只有服务端也看不出死活时才说「没有回应」
 *  What is said when it does not come back. Not coming up, it is 启动失败 as in every page header, pointing to the config page
 *  when a rollback is on offer; 没有回应 only when the server cannot tell either */
export function sayNoAnswer(verb: '启动' | '重启', doc: ConfigDocument | null): void {
  const failed = Boolean(doc?.runtime.restart_rollback || doc?.runtime.did_not_come_up)
  if (failed && downShownHere.value) return
  const text = doc?.runtime.restart_rollback ? 'KixDNS 启动失败，可以到配置页退回原来的设置'
    : failed ? 'KixDNS 启动失败，查看日志了解原因'
    : `KixDNS ${verb}后没有回应，查看日志了解原因`
  kixdnsBack()
  silentToast = useToast().error(text)
}
/** 退回、写进配置文件以后还是起不来：说清那一步已经做了；这一页已经在说起不来时不再指去日志
 *  Still not coming up after a rollback or a write into the file: say that step was done; when this page already says it does
 *  not come up, it does not point to the logs again */
function sayStillDown(done: string): void {
  kixdnsBack()
  silentToast = downShownHere.value ? useToast().info(`${done}，KixDNS 还是起不来`) : useToast().error(`${done}，KixDNS 还是起不来，查看日志了解原因`)
}

// 在说 KixDNS 停着的地方直接启动它（概览、配置页头、诊断），不用先去系统页。等它回来再说已启动；返回新的服务状态，失败给出原因并返回 null。
// `afterBack` 在等完以后、说结果之前跑（这一页重读）：起不来时页上的提示条先换成「启动失败」，就不另弹一条
// Start KixDNS right where a page says it is stopped (overview, config header, diagnostics) without a trip to the system page.
// Says it started once it is back; returns the new service status, or says why it failed and returns null.
// `afterBack` runs after the wait and before the outcome is said (the page reads again): not coming up, the page's notice turns
// to 启动失败 first, and no separate toast is raised
export function useServiceStart() {
  const toast = useToast()
  const starting = ref(false)
  async function start(options: { afterBack?: () => Promise<void> } = {}): Promise<ServiceStatus | null> {
    if (starting.value) return null
    starting.value = true
    try {
      const status = await apiRequest<ServiceStatus>('/api/v1/service/start', { method: 'POST' })
      const { outcome, doc, pendingSeen } = await waitForKixdns()
      const applied = outcome === 'back' ? await applyWaiting(doc, pendingSeen) : null
      await readPages(options.afterBack)
      if (outcome === 'back') sayBack('KixDNS 服务已启动', applied)
      else if (outcome === 'silent') sayNoAnswer('启动', doc)
      return status
    } catch (error) {
      toast.error(errorMessage(error))
      return null
    } finally {
      starting.value = false
    }
  }
  return { starting, start }
}

// 正在重启、等 KixDNS 回来：页头写「正在重启」，保存、应用先等它 / Restarting and waiting for KixDNS: the header reads
// 正在重启, and saving or applying waits for it
export const restartingKixdns = ref(false)
// 正在退回、正在写进配置文件：回来以后整份换上新的文件，配置页这期间不能改（离开再回来的那一页也一样）
// Rolling back or writing into the file: the new file replaces the page on return, so the config page cannot be edited
// meanwhile (a page opened again after leaving included)
export const rollingBackKixdns = ref(false)

// 回来以后还有等着的待应用版本（重启前连不上、退回另存的那一版）：当场应用，不等后台每 5 秒那一遍，免得刚说完「已重启」
// 页头又挂起「待应用」；没成就留给那一遍。只有真的应用了才算（KixDNS 又连不上时服务端照样回 200，只是还待应用）
// Back with a pending version still waiting (unreachable before the restart, or the one a rollback stored): it is applied on the
// spot rather than waiting for the 5-second background pass, so 待应用 does not hang in the header right after 已重启; a failure
// is left to that pass. Only a real apply counts (with KixDNS unreachable again the server still answers 200, just still pending)
// 最后一次读里没有了、等的途中见过的那一版也照样应用：后台那一遍先应用了的，服务端照样回「已应用」
// One seen while waiting but gone from the last read is applied too: if the background pass applied it first, the server still
// answers applied
async function applyWaiting(doc: ConfigDocument | null, pendingSeen: number | null): Promise<{ id: number; waits: boolean } | null> {
  const pending = doc?.pending
  if (pending?.error) return null
  const id = pending?.version_id ?? pendingSeen
  if (!id) return null
  const result = await apiRequest<ConfigApplyResult>(`/api/v1/config/versions/${id}/apply`, { method: 'POST' }).catch(() => null)
  if (result?.apply_state !== 'applied') return null
  return { id, waits: Boolean(result.active_config?.restart_pending?.length) }
}
// 回来时一条提示说完。应用了的版本照它报的说「已生效」或「已应用」；配置页外的「已应用」补上「有些设置要重启」，用普通提示。
// 重启前那一下被拒了的版本也在这一条里说，配置页外指到那里看原因（配置页的提示条写着原因）
// One toast says it on return. An applied version reads 已生效 or 已应用 as it reports; away from the config page 已应用 gets the
// 「有些设置要重启」 clause and a plain toast. A version refused just before the restart is told in the same toast, pointing away
// from the config page to it for the reason (the config page's notice gives the reason)
function sayBack(done: string, applied: { id: number; waits: boolean } | null, refused: number | null = null): void {
  const toast = useToast()
  if (refused !== null) { toast.info(`${done}，版本\u00a0#${refused} 没有生效${configPageOpen.value ? '' : '，到配置页看原因'}`); return }
  if (!applied) { toast.success(done); return }
  const away = applied.waits && !configPageOpen.value
  const text = `${done}，版本\u00a0#${applied.id} ${applied.waits ? '已应用' : '已生效'}${away ? '，有些设置要重启 KixDNS 才生效' : ''}`
  if (away) toast.info(text)
  else toast.success(text)
}

// 重启 KixDNS，确认由调用方先问。三种做法：
// - 普通重启；
// - `rollback`：先把改过的设置退回上次正常启动时的值；
// - `writePending`：先把待应用的版本写进配置文件。
// `afterBack` 在它回来以后、说结果之前跑（整份重读），读完才放开按钮
// Restart KixDNS; the caller asks for confirmation first. Three ways:
// - a plain restart;
// - `rollback`: put the changed settings back to the values it last started with first;
// - `writePending`: write the pending version into the config file first.
// `afterBack` runs once it is back and before the outcome is said (the whole page is read again), and the button is released after it
export function useServiceRestart() {
  const toast = useToast()
  async function restart(options: { beforeSend?: () => void; afterBack?: () => Promise<void>; rollback?: { hadPending: boolean }; writePending?: number } = {}): Promise<'back' | 'silent' | 'gone' | 'failed'> {
    if (restartingKixdns.value) return 'failed'
    restartingKixdns.value = true
    rollingBackKixdns.value = Boolean(options.rollback || options.writePending)
    try {
      options.beforeSend?.()
      const path = options.rollback ? '/api/v1/config/restart-rollback' : options.writePending ? '/api/v1/config/restart-with-pending' : '/api/v1/service/restart'
      // KixDNS 还在时，服务端重启前先应用待应用的版本，回应里说成没成 / With KixDNS still there the server applies the pending
      // version before the restart, and the answer says how it went
      // 写进配置文件的是确认框里说的那一版：期间换了，服务端拒绝 / The version written is the one the confirm named: if it
      // changed meanwhile the server refuses
      const sent = await apiRequest<{ applied_before?: { version_id: number; apply_state: string } }>(path, { method: 'POST', ...(options.writePending ? jsonBody({ version_id: options.writePending }) : {}) })
      const before = sent?.applied_before
      const { outcome, doc, pendingSeen } = await waitForKixdns()
      const applied = outcome === 'back' ? await applyWaiting(doc, pendingSeen) ?? (before?.apply_state === 'applied' ? { id: before.version_id, waits: false } : null) : null
      await readPages(options.afterBack)
      // 等完、读完，重启就结束了：先放下「正在重启」，各页的提示条换成读到的样子（起不来时说「启动失败」），再说结果
      // Waited and read, the restart is over: 正在重启 goes first and each page's notice turns to what was read (启动失败 when it
      // did not come up), before the outcome is said
      restartingKixdns.value = false
      rollingBackKixdns.value = false
      if (options.rollback) {
        // 退回自己存的那一版人没见过，不报它的编号；带着待应用的修改时说那笔修改也生效了
        // The version the rollback stored is one nobody saw, so its number is not given; with pending edits carried along, say
        // they took effect too
        if (outcome === 'back') toast.success(options.rollback.hadPending && applied ? `已退回原来的设置，KixDNS 服务已重启，待应用的修改也${applied.waits ? '已应用' : '已生效'}` : '已退回原来的设置，KixDNS 服务已重启')
        else if (outcome === 'silent') sayStillDown('已退回原来的设置')
      } else if (options.writePending) {
        if (outcome === 'back') toast.success(`版本\u00a0#${options.writePending} 已写进配置文件，KixDNS 服务已重启`)
        else if (outcome === 'silent') sayStillDown(`版本\u00a0#${options.writePending} 已写进配置文件`)
      } else if (outcome === 'back') sayBack('KixDNS 服务已重启', applied, before?.apply_state === 'failed' ? before.version_id : null)
      else if (outcome === 'silent') sayNoAnswer('重启', doc)
      return outcome
    } catch (error) {
      // 被拒是因为状态已经变了（它自己回来了、记号清了）：普通提示，页面跟着重读 / Refused because the state moved on (it came back by
      // itself, the mark was cleared): a plain toast, and the page is read again
      if (error instanceof ApiError && ['restart_rollback_missing', 'restart_pending_write_needless'].includes(error.code)) toast.info(errorMessage(error))
      else toast.error(errorMessage(error))
      await readPages(options.afterBack)
      return 'failed'
    } finally {
      restartingKixdns.value = false
      rollingBackKixdns.value = false
    }
  }
  return { restart }
}
