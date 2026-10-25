import { ref, watch } from 'vue'
import { ApiError, apiRequest, isPanelDown, jsonBody } from '../api/client'
import type { ConfigApplyResult, ConfigDocument, PendingConfig, ServiceStatus } from '../api/types'
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
interface PendingSeen { id: number; origin: PendingConfig['from_rollback'] }
export async function waitForKixdns(): Promise<{ outcome: 'back' | 'silent' | 'gone'; doc: ConfigDocument | null; pendingSeen: PendingSeen | null }> {
  const session = useSession()
  const deadline = Date.now() + 15_000
  let panelDown = false
  let doc: ConfigDocument | null = null
  let seen = false
  // 等的途中见过的待应用版本：回来时后台那一遍可能先一步把它应用了，最后一次读就看不到它 / The pending version seen while
  // waiting: on return the background pass may apply it first, and the last read no longer shows it
  let pendingSeen: PendingSeen | null = null
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
    if (doc?.pending?.version_id && !doc.pending.error) pendingSeen = { id: doc.pending.version_id, origin: doc.pending.from_rollback }
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
// 「…没有生效，到配置页看原因」那条错误提示：到了配置页、提示条在说没有生效时就交棒，收起 / The 「…没有生效，到配置页看原因」 error
// toast: once on the config page with its notice saying it did not take, it hands over and goes
const refusedToasts = new Set<number>()
export function dismissRefused(): void {
  for (const id of refusedToasts) useToast().dismiss(id)
  refusedToasts.clear()
}
// 退出登录、会话过期：「启动失败」「没有生效」这两类错误提示都收起，不留在登录页上 / Signed out or expired: the 启动失败 and
// 没有生效 error toasts both go, rather than staying on the sign-in page
watch(() => useSession().authenticated.value, (signedIn) => {
  if (signedIn) return
  dismissRefused()
  kixdnsBack()
})
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
// 读的途中又挂上来的页（刚点进去的配置页）也等它读一轮，再说结果 / A page mounted while the reads were out (a config page just opened)
// is also read once before the outcome is said
async function readPages(own?: () => Promise<void>): Promise<void> {
  const done = new Set<() => Promise<void>>()
  let round = [...pageReaders, ...(own ? [own] : [])]
  while (round.length) {
    round.forEach((read) => done.add(read))
    await Promise.all(round.map((read) => read().catch(() => undefined)))
    round = [...pageReaders].filter((read) => !done.has(read))
  }
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
  const writable = doc?.runtime.pending_writable
  const text = doc?.runtime.restart_rollback ? 'KixDNS 启动失败，可以到配置页退回原来的设置'
    : writable ? `KixDNS 启动失败，可以到配置页把版本\u00a0#${writable}\u00a0写进配置文件`
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
// 等启动的 KixDNS 回来：系统页页头转圈、写「正在启动」；读完、说结果之前放下，和重启一样
// Waiting for a started KixDNS to come back: the system page's header spins and reads 正在启动; let go once read and before the
// outcome is said, as for a restart
export const startingKixdns = ref(false)
export function useServiceStart() {
  const toast = useToast()
  const starting = ref(false)
  async function start(options: { afterBack?: () => Promise<void> } = {}): Promise<ServiceStatus | null> {
    // 重启还在等时不另起启动 / No start while a restart is still awaited
    if (starting.value || startingKixdns.value || restartingKixdns.value) return null
    starting.value = true
    startingKixdns.value = true
    try {
      const status = await apiRequest<ServiceStatus>('/api/v1/service/start', { method: 'POST' })
      const { outcome, doc, pendingSeen } = await waitForKixdns()
      const applied = outcome === 'back' ? await applyWaiting(doc, pendingSeen) : null
      await readPages(options.afterBack)
      startingKixdns.value = false
      // 读的途中退出登录了：什么都不说，和等的途中一样 / Signed out during the reads: nothing is said, as during the wait
      if (!useSession().authenticated.value) return status
      if (outcome === 'back') sayBack('KixDNS 服务已启动', applied)
      else if (outcome === 'silent') sayNoAnswer('启动', doc)
      return status
    } catch (error) {
      toast.error(errorMessage(error))
      return null
    } finally {
      starting.value = false
      startingKixdns.value = false
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
// 退回存的那几版是面板自己生成的，用户没见过：提示里不报编号，说「退回的设置」 / The versions a rollback stores are the panel's
// own, never seen by the user: a toast gives no number for them and says 退回的设置
// 按服务端标的来认，不看备注 / Told by the server's mark, not by the note
export const ROLLBACK_LABELS = { settings: '退回的设置', settings_and_pending: '退回的设置和待应用的修改' } as const
export type RollbackOrigin = keyof typeof ROLLBACK_LABELS
/** 给用户看的地方怎么称呼一个待应用的版本，按状态不按按钮：退回写下的不报编号。带上修改的那一版，KixDNS 在的时候（退回的设置
 *  已经在用）、或者没有生效时（只会是带上的那笔修改），只剩带上的修改，叫「待应用的修改」（carried）；KixDNS 不在、等它回来时，
 *  两样一起才用上，叫全名。别的写「版本 #N」
 *  How a pending version is named wherever users read it, by state rather than by button: one a rollback wrote has no number.
 *  For the version carrying pending edits, while KixDNS runs (the settings put back are in use) or when it did not take (it can only
 *  be the carried edits), only the carried edits are left and it reads 待应用的修改 (carried); while KixDNS is not there and both
 *  come in together on its return, the full name. Any other reads 版本 #N */
export function versionName(id: number, origin?: RollbackOrigin | null, carried = false): string {
  if (origin === 'settings_and_pending' && carried) return '待应用的修改'
  return origin ? ROLLBACK_LABELS[origin] : `版本\u00a0#${id}`
}
/** 名字接状态词：编号后面空一格，退回的叫法紧接 / A name followed by its state word: a space after a number, none after the
 *  rollback's names */
export function nameWith(name: string, state: string): string {
  return name.startsWith('版本') ? `${name}\u00a0${state}` : `${name}${state}`
}
// refused：KixDNS 回来了，却不接受这一版（回来时那次应用被拒） / refused: KixDNS is back but refused this version (the apply on
// return was rejected)
interface Applied { id: number; waits: boolean; name: string; refused?: boolean }
// wasAlive：KixDNS 在这次启动、重启之前就在跑（退回的设置那时已经在用），用上的只有带上的修改 / wasAlive: KixDNS was running before
// this start or restart (the settings put back were in use then), so only the carried edits came in
async function applyWaiting(doc: ConfigDocument | null, pendingSeen: PendingSeen | null, wasAlive = false): Promise<Applied | null> {
  const pending = doc?.pending
  // 等的途中还在等、这会儿带着错误：后台那一遍先试过、被拒了，同样算回来时那次应用被拒 / Waiting while it was awaited and carrying
  // an error now: the background pass tried first and was refused, which counts as the apply on return being refused just the same
  if (pending?.error) return pending.version_id && pendingSeen?.id === pending.version_id ? { id: pending.version_id, waits: false, name: versionName(pending.version_id, pending.from_rollback, true), refused: true } : null
  const id = pending?.version_id ?? pendingSeen?.id
  if (!id) return null
  const origin = pending?.version_id ? pending.from_rollback : pendingSeen?.origin
  // 被拒不看错误码，看读回来的状态：服务端记成没有生效的才算（和它在重启前那一下的判断一样）/ Refusal is judged by the state
  // read back, not the error code: only what the server recorded as not taken counts (as it judges the apply before a restart)
  const result = await apiRequest<ConfigApplyResult>(`/api/v1/config/versions/${id}/apply`, { method: 'POST' })
    .catch(() => apiRequest<ConfigDocument>('/api/v1/config').then((read) => (read.pending?.version_id === id && read.pending.error ? 'refused' as const : null), () => null))
  if (result === 'refused') return { id, waits: false, name: versionName(id, origin, true), refused: true }
  if (result?.apply_state !== 'applied') return null
  return { id, waits: Boolean(result.active_config?.restart_pending?.length), name: versionName(id, origin, wasAlive) }
}
// 回来时一条提示说完。应用了的版本照它报的说「已生效」或「已应用」；配置页外的「已应用」补上「有些设置要重启」，用普通提示。
// 重启前那一下被拒了的版本也在这一条里说，配置页外指到那里看原因（配置页的提示条写着原因）
// One toast says it on return. An applied version reads 已生效 or 已应用 as it reports; away from the config page 已应用 gets the
// 「有些设置要重启」 clause and a plain toast. A version refused just before the restart is told in the same toast, pointing away
// from the config page to it for the reason (the config page's notice gives the reason)
function sayBack(done: string, applied: Applied | null, refused: string | null = null): void {
  const toast = useToast()
  // 没有生效是错误：配置页外用不会自己消失的错误提示；配置页上提示条写着原因，用普通提示 / Not taking is an error: away from
  // the config page an error toast that stays; on it the notice gives the reason, so a plain toast
  const notTaken = refused ?? (applied?.refused ? applied.name : null)
  if (notTaken !== null) {
    if (configPageOpen.value) toast.info(`${done}，${nameWith(notTaken, '没有生效')}`)
    else refusedToasts.add(toast.error(`${done}，${nameWith(notTaken, '没有生效')}，到配置页看原因`))
    return
  }
  if (!applied) { toast.success(done); return }
  const away = applied.waits && !configPageOpen.value
  const again = done.endsWith('已重启') ? '再重启一次' : '重启 KixDNS\u00a0'
  const text = `${done}，${nameWith(applied.name, applied.waits ? '已应用' : '已生效')}${away ? `，有些设置要${again}才生效` : ''}`
  if (away) toast.info(text)
  else toast.success(text)
}

// 重启 KixDNS，确认由调用方先问。三种做法：
// - 普通重启；
// - `rollback`：先把改过的设置退回上次正常启动时的值；
// - `writePending`：先把待应用的版本写进配置文件。
// `afterBack` 在它回来以后、说结果之前跑（整份重读），读完才放开按钮。
// `wasAlive` 是确认框按 KixDNS 在不在说的那份判断：结果照同一份叫待应用的版本
// Restart KixDNS; the caller asks for confirmation first. Three ways:
// - a plain restart;
// - `rollback`: put the changed settings back to the values it last started with first;
// - `writePending`: write the pending version into the config file first.
// `afterBack` runs once it is back and before the outcome is said (the whole page is read again), and the button is released after it.
// `wasAlive` is the confirm's own judgement of whether KixDNS was in: the outcome names the pending version by the same one
export function useServiceRestart() {
  const toast = useToast()
  async function restart(options: { beforeSend?: () => void; afterBack?: () => Promise<void>; rollback?: { hadPending: boolean }; writePending?: number; wasAlive?: boolean } = {}): Promise<'back' | 'silent' | 'gone' | 'failed'> {
    // 启动还在等时不另起重启 / No restart while a start is still awaited
    if (restartingKixdns.value || startingKixdns.value) return 'failed'
    restartingKixdns.value = true
    rollingBackKixdns.value = Boolean(options.rollback || options.writePending)
    try {
      options.beforeSend?.()
      const path = options.rollback ? '/api/v1/config/restart-rollback' : options.writePending ? '/api/v1/config/restart-with-pending' : '/api/v1/service/restart'
      // KixDNS 还在时，服务端重启前先应用待应用的版本，回应里说成没成 / With KixDNS still there the server applies the pending
      // version before the restart, and the answer says how it went
      // 写进配置文件的是确认框里说的那一版：期间换了，服务端拒绝 / The version written is the one the confirm named: if it
      // changed meanwhile the server refuses
      const sent = await apiRequest<{ applied_before?: { version_id: number; apply_state: string; from_rollback?: RollbackOrigin } }>(path, { method: 'POST', ...(options.writePending ? jsonBody({ version_id: options.writePending }) : {}) })
      const before = sent?.applied_before
      const { outcome, doc, pendingSeen } = await waitForKixdns()
      // 确认框没说时：服务端重启前应用过（applied_before）就说明 KixDNS 那时在跑 / Without the confirm's word: an apply before the
      // restart (applied_before) means KixDNS was running then
      const applied = outcome === 'back' ? await applyWaiting(doc, pendingSeen, options.wasAlive ?? Boolean(before)) ?? (before?.apply_state === 'applied' ? { id: before.version_id, waits: false, name: versionName(before.version_id, before.from_rollback, options.wasAlive ?? true) } : null) : null
      await readPages(options.afterBack)
      // 等完、读完，重启就结束了：先放下「正在重启」，各页的提示条换成读到的样子（起不来时说「启动失败」），再说结果
      // Waited and read, the restart is over: 正在重启 goes first and each page's notice turns to what was read (启动失败 when it
      // did not come up), before the outcome is said
      restartingKixdns.value = false
      rollingBackKixdns.value = false
      if (!useSession().authenticated.value) return 'gone'
      if (options.rollback) {
        // 退回自己存的那一版人没见过，不报它的编号；带着待应用的修改时说那笔修改也生效了
        // The version the rollback stored is one nobody saw, so its number is not given; with pending edits carried along, say
        // they took effect too
        // 带上的修改里也有要重启的设置时，配置页外补一句（配置页上提示条会说） / With settings in the carried edits that take a
        // restart too, a clause follows away from the config page (on it the notice says so)
        // 要再重启的那半句用「；」隔开，和被拒那句同一个结构 / The restart clause is set off with 「；」, in the refused sentence's shape
        const tail = applied?.waits && !configPageOpen.value
        const carried = tail ? '已退回原来的设置，KixDNS 服务已重启；待应用的修改里，有些设置要再重启一次才生效' : '已退回原来的设置，KixDNS 服务已重启，待应用的修改也用上了'
        // 带上的修改被拒了：照实说，配置页外用不会自己消失的错误提示 / The carried edits were refused: said as they are, away from
        // the config page in an error toast that stays
        if (outcome === 'back' && options.rollback.hadPending && applied?.refused) {
          const text = `已退回原来的设置，KixDNS 服务已重启；${nameWith(applied.name, '没有生效')}`
          if (configPageOpen.value) toast.info(text)
          else refusedToasts.add(toast.error(`${text}，到配置页看原因`))
        } else if (outcome === 'back' && options.rollback.hadPending && applied) {
          if (tail) toast.info(carried)
          else toast.success(carried)
        } else if (outcome === 'back') toast.success('已退回原来的设置，KixDNS 服务已重启')
        else if (outcome === 'silent') sayStillDown('已退回原来的设置')
      } else if (options.writePending) {
        if (outcome === 'back') toast.success(`版本\u00a0#${options.writePending}\u00a0已写进配置文件，KixDNS 服务已重启`)
        else if (outcome === 'silent') sayStillDown(`版本\u00a0#${options.writePending}\u00a0已写进配置文件`)
      } else if (outcome === 'back') sayBack('KixDNS 服务已重启', applied, before?.apply_state === 'failed' ? versionName(before.version_id, before.from_rollback, true) : null)
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
