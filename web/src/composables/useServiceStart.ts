import { ref } from 'vue'
import { apiRequest, isPanelDown } from '../api/client'
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
export async function waitForKixdns(): Promise<{ outcome: 'back' | 'silent' | 'gone'; doc: ConfigDocument | null }> {
  const session = useSession()
  const deadline = Date.now() + 15_000
  let panelDown = false
  let doc: ConfigDocument | null = null
  let seen = false
  while (Date.now() < deadline) {
    // 只看最近一次：面板断开过又连上，照常等 KixDNS / Only the latest read counts: a panel that dropped and came back waits for KixDNS as usual
    doc = await apiRequest<ConfigDocument>('/api/v1/config').then((read) => {
      panelDown = false
      return read
    }, (error: unknown) => {
      panelDown = isPanelDown(error)
      return null
    })
    if (!session.authenticated.value) return { outcome: 'gone', doc: null }
    // 服务端已经看出它起不来、能退回：不用等满十五秒 / The server already sees it is not coming up and can roll back: no need
    // to wait out the fifteen seconds
    if (doc?.runtime.restart_rollback) return { outcome: 'silent', doc }
    if (doc?.runtime.active_sha256 && seen) {
      kixdnsBack()
      return { outcome: 'back', doc }
    }
    seen = Boolean(doc?.runtime.active_sha256)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return { outcome: panelDown ? 'gone' : 'silent', doc }
}

// 「没有回应」的错误提示不会自己消失：以后哪次读到 KixDNS 活着（再启动、systemd 下一次重试起来了）就收起，不留一句过时的话
// The no-answer error does not clear itself: whenever a later read finds KixDNS alive (another start, a systemd retry that
// came up) it is dismissed, rather than left saying something stale
let silentToast: number | null = null
export function kixdnsBack(): void {
  if (silentToast === null) return
  useToast().dismiss(silentToast)
  silentToast = null
}
// 到了配置页、提示条已经在说能退回：「到配置页退回」那条提示过时了 / On the config page with the notice already offering the
// rollback: the 「到配置页退回」 toast is stale
export const dismissNoAnswer = kixdnsBack
/** 等不到它回来时说的话；重启后起不来、配置页能退回改过的设置时指过去 / What is said when it does not come back; after a restart
 *  with changed settings the config page can put back, it points there */
export function sayNoAnswer(verb: '启动' | '重启', doc: ConfigDocument | null, rollbackShown = false): void {
  // 这一页的提示条已经在说能退回（配置页、概览、诊断）：不另起一条 / This page's notice already offers the rollback (the config
  // page, the overview, diagnostics): no second copy
  if (doc?.runtime.restart_rollback && rollbackShown) return
  // 起不来、能退回时和各页页头一样叫「启动失败」 / Not coming up with a rollback on offer, it is 启动失败 as in every page header
  const text = doc?.runtime.restart_rollback ? 'KixDNS 启动失败，可以到配置页退回改过的设置' : `KixDNS ${verb}后没有回应，查看日志了解原因`
  kixdnsBack()
  silentToast = useToast().error(text)
}

// 在说 KixDNS 停着的地方直接启动它（概览、配置页头、诊断），不用先去系统页。等它回来再说已启动；返回新的服务状态，失败给出原因并返回 null。
// Start KixDNS right where a page says it is stopped (overview, config header, diagnostics) without a trip to the system page.
// Says it started once it is back; returns the new service status, or says why it failed and returns null.
export function useServiceStart() {
  const toast = useToast()
  const starting = ref(false)
  async function start(options: { rollbackShown?: () => boolean } = {}): Promise<ServiceStatus | null> {
    if (starting.value) return null
    starting.value = true
    try {
      const status = await apiRequest<ServiceStatus>('/api/v1/service/start', { method: 'POST' })
      const { outcome, doc } = await waitForKixdns()
      const applied = outcome === 'back' ? await applyWaiting(doc) : null
      if (outcome === 'back') toast.success(applied ? `KixDNS 服务已启动，${applied}` : 'KixDNS 服务已启动')
      else if (outcome === 'silent') sayNoAnswer('启动', doc, options.rollbackShown?.() ?? false)
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
// 正在退回改过的设置：回来以后整份换上退回后的文件，配置页这期间不能改（离开再回来的那一页也一样）
// Rolling back the changed settings: the rolled-back file replaces the page on return, so the config page cannot be edited
// meanwhile (a page opened again after leaving included)
export const rollingBackKixdns = ref(false)

// 在说「改过的设置要重启才生效」的地方直接重启 KixDNS（配置页），确认由调用方先问。`afterBack` 在它回来以后、说「已重启」之前跑
// （整份重读），读完才放开按钮；还能退回改过的设置时，`rollback` 为真，改调退回的接口
// Restart KixDNS right where a page says changed settings take a restart (the config page); the caller asks for confirmation
// first. `afterBack` runs once it is back and before 已重启 is said (the whole page is read again), and the button is released
// after that; with `rollback` it calls the endpoint that puts the changed settings back first
// 回来以后还有等着的待应用版本（确认框说过「重启后应用」、退回另存的那一版）：当场应用，不等后台每 5 秒那一遍，免得刚说完
// 「已重启」页头又挂起「待应用」；没成就留给那一遍
// Back with a pending version still waiting (the confirm promised 重启后应用, or the rollback stored one): it is applied on the
// spot rather than waiting for the 5-second background pass, so 待应用 does not hang in the header right after 已重启; a failure
// is left to that pass
// 只有真的应用了才算（KixDNS 又连不上时服务端照样回 200，只是还待应用）；说「已生效」还是「已应用」照它报的要不要重启
// Only a real apply counts (with KixDNS unreachable again the server still answers 200, just still pending); whether it reads
// 已生效 or 已应用 follows whether it reports settings waiting for a restart
async function applyWaiting(doc: ConfigDocument | null): Promise<string | null> {
  const pending = doc?.pending
  if (!pending?.version_id || pending.error) return null
  const id = pending.version_id
  const result = await apiRequest<ConfigApplyResult>(`/api/v1/config/versions/${id}/apply`, { method: 'POST' }).catch(() => null)
  if (result?.apply_state !== 'applied') return null
  return `版本\u00a0#${id} ${result.active_config?.restart_pending?.length ? '已应用' : '已生效'}`
}

export function useServiceRestart() {
  const toast = useToast()
  async function restart(options: { beforeSend?: () => void; afterBack?: () => Promise<void>; rollbackShown?: () => boolean; rollback?: boolean } = {}): Promise<'back' | 'silent' | 'gone' | 'failed'> {
    if (restartingKixdns.value) return 'failed'
    restartingKixdns.value = true
    rollingBackKixdns.value = Boolean(options.rollback)
    try {
      options.beforeSend?.()
      await apiRequest(options.rollback ? '/api/v1/config/restart-rollback' : '/api/v1/service/restart', { method: 'POST' })
      const { outcome, doc } = await waitForKixdns()
      const applied = outcome === 'back' ? await applyWaiting(doc) : null
      await options.afterBack?.().catch(() => undefined)
      // 回来时顺手应用了待应用的版本：一条提示说完，不另起「版本 #N 已生效」 / A pending version applied on return: one toast
      // says both, with no separate 版本 #N 已生效
      const restarted = options.rollback ? '已退回原来的设置，KixDNS 服务已重启' : 'KixDNS 服务已重启'
      if (outcome === 'back') toast.success(applied ? `${restarted}，${applied}` : restarted)
      else if (outcome === 'silent') sayNoAnswer('重启', doc, options.rollbackShown?.() ?? false)
      return outcome
    } catch (error) {
      toast.error(errorMessage(error))
      // 没发出去或者被拒（比如退回时它已经回来了）：照样重读，页面不留着过时的状态 / Not sent or refused (say it was already
      // back when the rollback arrived): the page is read again all the same, so no stale state stays
      await options.afterBack?.().catch(() => undefined)
      return 'failed'
    } finally {
      restartingKixdns.value = false
      rollingBackKixdns.value = false
    }
  }
  return { restart }
}
