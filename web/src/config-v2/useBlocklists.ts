import { reactive, watch } from 'vue'
import { ApiError, apiRequest, isPanelDown, jsonBody } from '../api/client'
import type { BlocklistBuildResult, BlocklistSource, BlocklistState, GeoDataSchedule } from '../api/types'
import { isDefaultName, normalUrl, shortName } from '../config-model/blocklist'
import { blocklistKey } from '../config-model/model'
import { useConnection } from '../composables/useConnection'
import { useSession } from '../composables/useSession'
import { useToast } from '../composables/useToast'
import { errorMessage } from '../utils'
import { appliedModel, draftGeneration, model, sameDraftSince } from './store'

// 拦截列表在面板服务端的情况：每个链接在用哪一份、多少条、上次更新和失败原因，还有自动更新的设置。配置页里共用一份。
// 订阅本身在草稿里；订阅一变就请服务端重新合成，合成出的文件填进草稿，保存后生效。
// The blocklists as the panel server holds them: for each link the copy in use, its count, the last update and why one failed,
// plus the automatic-update setting. One copy for the config page. The subscriptions themselves live in the draft; whenever
// they change the server builds again and the file it builds goes into the draft, taking effect on save.
export const blocklists = reactive({
  sources: {} as Record<string, BlocklistSource>,
  schedule: null as GeoDataSchedule | null,
  status: 'loading' as 'loading' | 'ok' | 'failed',
  // 正在下载、和排着队要下载的链接 / The links downloading now, or queued to
  downloading: new Set<string>(),
  // 最近一次合成没成功的原因；成功以后清掉 / Why the latest build failed; cleared once one succeeds
  buildError: '',
})

let loading: Promise<void> | null = null
export function loadBlocklists(): Promise<void> {
  loading ??= (async () => {
    try {
      const state = await apiRequest<BlocklistState>('/api/v1/config/blocklists')
      blocklists.sources = state.sources
      blocklists.schedule = state.schedule
      blocklists.status = 'ok'
    } catch {
      // 拿到过一份就接着用 / Keep a copy once there is one
      if (blocklists.status !== 'ok') blocklists.status = 'failed'
    } finally {
      loading = null
    }
  })()
  return loading
}

const subscriptionsSent = () => model.blocklists.subscriptions.map((s) => ({ url: s.url, enabled: s.enabled }))
/** 草稿里的文件不是按现在的订阅合成的：要重新合成，保存要等它 / The draft's file was not built for the current subscriptions: a build is due, and a save waits for it */
export const needsBuild = (): boolean => blocklistKey(model.blocklists) !== model.blocklists.builtFor

/**
 * 一次合成怎么收场：filled 文件填进了草稿；current 草稿里的文件本来就对得上，没动；superseded 订阅在途中又变了，留给下一次合成；
 * dropped 草稿整份换过了（放弃修改、恢复版本），这次的不填；failed 没合成成功
 * How a build ended: filled put its file into the draft; current found the draft's file already matching and left it; superseded met
 * subscriptions that changed meanwhile, leaving it to the next build; dropped met a draft replaced wholesale (a discard, a restore) and
 * filled nothing; failed did not build
 */
// fixable：服务端拒绝了这组订阅（比如链接不合要求），再试一样，要改好 / fixable: the server refused these subscriptions (a link it does not accept, say),
// so trying again changes nothing until it is fixed
// remove：被拒的是某一个订阅的链接（链接在页面上改不了），要做的是删掉它 / remove: the refusal named one subscription's link (links cannot be edited on the
// page), so the way out is to remove it
export interface BuildOutcome { outcome: 'filled' | 'current' | 'superseded' | 'dropped' | 'failed'; error?: string; down?: boolean; fixable?: boolean; remove?: boolean }
// 订阅变化引起的合成失败那条提示：下一次合成成功、保存或校验接手、或者不再需要合成时收起
// The toast for a failed build the subscriptions set off: it goes once a later build succeeds, a save or a check takes over, or no build is due any more
let staleToast: number | null = null
export function dismissBuildToast(): void {
  if (staleToast !== null) useToast().dismiss(staleToast)
  staleToast = null
}
// 下载失败的那条提示：每次合成只留一条，新的换掉旧的；它说到的列表有一个不再出错（删掉、放弃修改、重新下载好了）就收起，表格下面照样列着还在出错的
// The failed-download toast: one per build, a new one replacing the old; it goes once a list it spoke of no longer fails (removed, discarded, downloaded
// fine since), the lists still failing staying listed under the table
let failToast: number | null = null
let failToastUrls: string[] = []
// 会话过期以后才落地的结果不说：已经在登录页上了 / Results landing after the session expired say nothing: the login page is up
const signedIn = () => useSession().authenticated.value
const failingUrls = () => model.blocklists.subscriptions.filter((s) => blocklists.sources[s.url]?.last_error).map((s) => s.url)
function dismissFailToast(): void {
  if (failToast !== null) useToast().dismiss(failToast)
  failToast = null
  failToastUrls = []
}
watch(failingUrls, (now) => { if (failToastUrls.some((url) => !now.includes(url))) dismissFailToast() })
// 「没能重新下载」那条：下一次合成成功、或者是因为连不上面板而面板又连上了，就收起 / The 没能重新下载 toast: it goes once a later build succeeds, or when
// it was about the panel being unreachable and the panel is back
let refreshToast: number | null = null
let refreshToastDown = false
function dismissRefreshToast(): void {
  if (refreshToast !== null) useToast().dismiss(refreshToast)
  refreshToast = null
}
/** 拦截列表那几条提示都收起：放弃草稿离开配置页时，它们说的东西已经不在了 / Clears the blocklist toasts: on leaving the config page with the draft
 * discarded, what they spoke of is gone */
export function dismissBlocklistToasts(): void {
  dismissBuildToast()
  dismissFailToast()
  dismissRefreshToast()
  if (draftedToast !== null) useToast().dismiss(draftedToast)
  draftedToast = null
}
// 「新的一份已放进草稿」那条：放弃草稿离开时它说的就不对了，一起收起 / The 「new copy in the draft」 toast: dropping the draft on leaving makes it untrue, so
// it goes along
let draftedToast: number | null = null
export function sayDrafted(text: string): void {
  if (draftedToast !== null) useToast().dismiss(draftedToast)
  draftedToast = useToast().info(text)
}
// 退出登录或会话过期：和配置页别的提示一样，拦截列表的几条也收起，登录页上不挂着它们 / Signing out or the session expiring: like the config page's other
// toasts, the blocklist ones go too, so none hangs on the login page
watch(() => useSession().authenticated.value, (now) => {
  if (now) return
  dismissBlocklistToasts()
  dismissScheduleToast()
})

// 一次接一次地合成。落地时订阅又变了，这次的文件不填：后面那次会填。只是重新合成（没点名下载）、而草稿里的文件已经对得上时也不填，
// 比如放弃修改以后，免得刚放弃就又多出一处「另一次下载的列表」
// Builds run one after another. When the subscriptions changed by the time one lands, its file is not filled in: a later one will be.
// Nor is a plain rebuild (nothing named to download) once the draft's file already matches, after a discard say, so that a fresh
// discard does not grow a 「another download」 change at once
let queue: Promise<unknown> = Promise.resolve()
/**
 * 按草稿里的订阅重新合成；`refresh` 里的链接重新下载。`quiet` 时合成失败不弹提示：保存或校验在等它，由保存条说
 * Builds again for the draft's subscriptions; links in `refresh` download again. With `quiet` a failed build raises no toast: a save or a check is
 * waiting on it and the save bar says it
 */
// force：草稿里的文件已经对得上也再合成一次，用上服务端刚下好的那份 / force: build again even when the draft's file already matches, to take in the copy the
// server just downloaded
export function rebuildBlocklists(refresh: string[] = [], quiet = false, force = false): Promise<BuildOutcome> {
  // 排队时就定下：放弃修改、恢复版本以后，之前点名的下载不再填进换过的草稿 / Fixed when queued: after a discard or a restore, a download named before
  // no longer fills the replaced draft
  const generation = draftGeneration()
  // 和服务端一样：从没试过的、点名的才下载；排上队就显示「下载中」 / As on the server: only lists never tried, or named, download; they show 下载中 once queued
  const fetching = model.blocklists.subscriptions.map((s) => s.url).filter((url) => refresh.includes(url) || !blocklists.sources[url])
  for (const url of fetching) blocklists.downloading.add(url)
  const run = queue.then(async (): Promise<BuildOutcome> => {
    if (refresh.length && !sameDraftSince(generation)) return { outcome: 'dropped' }
    if (!refresh.length && !force && !needsBuild()) return { outcome: 'current' }
    const subscriptions = subscriptionsSent()
    const key = blocklistKey(model.blocklists)
    // 这次之前每个链接最后一次试着下载的时间：落地后变了的才是这次下载的 / When each link was last tried before this build: those that changed by
    // the time it lands are the ones this build downloaded
    const triedBefore = new Map(fetching.map((url) => [url, blocklists.sources[url]?.last_attempt_at ?? null]))
    try {
      const result = await apiRequest<BlocklistBuildResult>('/api/v1/config/blocklists/build', { method: 'POST', ...jsonBody({ subscriptions, refresh }) })
      blocklists.sources = { ...blocklists.sources, ...result.sources }
      blocklists.buildError = ''
      dismissBuildToast()
      dismissRefreshToast()
      nameByTitle()
      sayFailures(fetching.filter((url) => (result.sources[url]?.last_attempt_at ?? null) !== triedBefore.get(url)), result.sources, refresh)
      if (refresh.length && !sameDraftSince(generation)) return { outcome: 'dropped' }
      if (blocklistKey(model.blocklists) !== key) return { outcome: 'superseded' }
      if (!refresh.length && !force && !needsBuild()) return { outcome: 'current' }
      model.blocklists.file = result.path
      model.blocklists.builtFor = key
      return { outcome: 'filled' }
    } catch (e) {
      const down = isPanelDown(e)
      const fixable = e instanceof ApiError && e.status === 400
      // 连不上面板时只说「连不上面板」，横幅已经说了别的；服务端的原因以「拦截列表」开头，放进「拦截列表没有…」里就不再重复
      // With the panel unreachable only 连不上面板 is said, the banner saying the rest; the server's reasons open with 拦截列表, dropped when they sit
      // inside 「拦截列表没有…」
      let error = down ? '连不上面板' : errorMessage(e).replace(/^拦截列表/, '').replace(/[。.]\s*$/, '')
      // 服务端说出了被拒的链接（太长时只给开头）：换成那个列表在页面上的名字，长链接在手机上要占好几行 / The server named the refused link (only its start
      // when long): it becomes that list's name on the page, a long link taking several lines on a phone
      const quoted = fixable ? /^「([^」]+)」/.exec(error)?.[1] : undefined
      const refused = quoted ? model.blocklists.subscriptions.find((s) => s.url === quoted || (quoted.endsWith('…') && s.url.startsWith(quoted.slice(0, -1)))) : undefined
      // 「「bad.txt」的链接只能用 https://」：名字放进句子里，不再括号里套引号再套冒号 / The name goes into the sentence rather than quote-in-colon inside brackets
      if (refused) {
        const rest = error.slice(`「${quoted}」：`.length)
        error = `「${shortName(refused.name, refused.url)}」${rest.startsWith('链接') ? `的${rest}` : `：${rest}`}`
      }
      const remove = Boolean(refused)
      blocklists.buildError = error
      // 点名下载的（立即更新）说没下载成；订阅变化引起的：连不上时不说（横幅说着，连上后会自动补上），保存、校验在等时不说（保存条说），
      // 别的原因说一句
      // A named download (立即更新) says it did not download; one the subscriptions set off: nothing while unreachable (the banner says so and a
      // build follows on reconnecting), nothing while a save or check waits (the save bar says it), any other cause says one line
      if (!signedIn()) return { outcome: 'failed', error, down, fixable, remove }
      if (refresh.length) {
        dismissRefreshToast()
        refreshToast = useToast().error(`没能重新下载：${error}`)
        refreshToastDown = down
      }
      else if (!down && !quiet) {
        // 上一次合成失败的那条换成这条：原因不同时不留两条 / This one replaces the previous failed build's toast: a different cause leaves no second one
        dismissBuildToast()
        staleToast = useToast().error(remove ? `${error}，删掉这个列表再保存` : `拦截列表没有重新合成（${error}），${fixable ? '改好再保存' : '保存前会再试一次'}`)
      }
      return { outcome: 'failed', error, down, fixable, remove }
    }
  })
  queue = run.finally(() => { for (const url of fetching) blocklists.downloading.delete(url) })
  return run
}

// 自己粘贴、还没保存的列表，下载下来带着标题（`! Title: …`）时用它当名字；改过名字的、已经保存的不动。和别的列表重名时后面加上主机
// A pasted list not yet saved takes the title its download carries (`! Title: …`) as its name; renamed or saved ones stay as they are. A title
// another list already has gets the host after it
function nameByTitle(): void {
  // 已经保存过的按规整后的链接认，和改动数一个口径 / Saved ones are matched by normal link, as the change count is
  const saved = new Set(appliedModel.value.blocklists.subscriptions.map((s) => normalUrl(s.url)))
  for (const s of model.blocklists.subscriptions) {
    const title = blocklists.sources[s.url]?.summary.title
    if (!title || saved.has(normalUrl(s.url)) || !isDefaultName(s.name, s.url)) continue
    const names = new Set(model.blocklists.subscriptions.filter((x) => x !== s).map((x) => x.name))
    // 主机写在前面：截短时截掉的是大家一样的标题 / The host goes first: cutting short drops the title they share
    // 加了主机还重名（同一个主机上几个同标题的列表）就再加编号 / Still taken with the host (several same-titled lists on one host): a number follows
    let name = title
    if (names.has(name)) {
      let host = ''
      try { host = new URL(s.url).host } catch { /* 链接已经查过，不会读不出 / the link was checked and always parses */ }
      name = `${host}\u00a0·\u00a0${title}`
      for (let n = 2; names.has(name); n++) name = `${host}\u00a0·\u00a0${title} (${n})`
    }
    if (s.name !== name) s.name = name
  }
}

// 这次下载的里有没成功的就说一句，只一句，换掉上一句：数的是现在表格下面列着的所有出错的列表（停用的也在，标着「已停用」），没下载成功的和没更新上的
// 分开说。合成途中删掉的不算。点名更新了一个列表（立即更新）、或者只下载了一个停用的列表，它没成时直接说它的原因：点了一个就回答这一个
// When this build's downloads include failures, one toast says so, replacing the previous one: it counts every failing list now listed under the table
// (disabled ones too, marked as such), telling failed downloads apart from failed updates. Lists removed meanwhile do not count. A single list updated by
// name (立即更新), or a single disabled list downloaded, that fails gets its reason said directly: one pressed is one answered
function sayFailures(fetched: string[], sources: Record<string, BlocklistSource>, refresh: string[]): void {
  const subscription = (url: string) => model.blocklists.subscriptions.find((s) => s.url === url)
  const failed = fetched.filter((url) => sources[url]?.last_error && subscription(url))
  if (!failed.length || !signedIn()) return
  dismissFailToast()
  const one = failed.length === 1 ? subscription(failed[0]!) : undefined
  const only = one && (refresh.length === 1 ? refresh[0] === one.url : fetched.length === 1 && !one.enabled) ? one : undefined
  if (only) {
    const status = sources[only.url]!
    const cause = status.last_error!.replace(/[。.]\s*$/, '')
    // 原因里已经有主机时，默认名只写文件名 / With the host already in the cause, a default name shows its file part
    let host = ''
    try { host = new URL(only.url).host } catch { /* 链接已经查过 / the link was checked */ }
    const name = host && cause.includes(host) ? shortName(only.name, only.url) : only.name
    failToast = useToast().error(`「${name}」${status.sha256 ? '没更新上' : '没下载成功'}：${cause}`)
    failToastUrls = [only.url]
    return
  }
  const failing = model.blocklists.subscriptions.map((s) => blocklists.sources[s.url]).filter((s): s is BlocklistSource => Boolean(s?.last_error))
  const held = failing.filter((s) => s.sha256).length
  const none = failing.length - held
  const what = none && held ? `${none}\u00a0个列表没下载成功，${held}\u00a0个没更新上` : none ? `${none}\u00a0个列表没下载成功` : `${held}\u00a0个列表没更新上`
  failToast = useToast().error(`${what}，原因写在列表下面`)
  failToastUrls = failingUrls()
}

/** 等合成没成：原因、是不是连不上面板、是不是订阅在等的时候又变了、是不是要先改好 / Why waiting for a build failed: the reason, whether the panel was
 * unreachable, whether the subscriptions changed meanwhile, whether something must be fixed first */
export interface BuildProblem { reason: string; down: boolean; changed: boolean; fixable?: boolean; remove?: boolean }
/** 保存前：等排着的合成落地；还对不上就再合成一次。返回还没合成好的原因，好了为 null / Before a save: wait for queued builds; if still stale, build once more. Returns why it is not built yet, or null once it is */
export async function settleBlocklists(): Promise<BuildProblem | null> {
  await queue
  if (!needsBuild()) return null
  const result = await rebuildBlocklists([], true)
  if (!needsBuild()) return null
  return result.outcome === 'failed' ? { reason: result.error ?? '', down: Boolean(result.down), changed: false, fixable: result.fixable, remove: result.remove } : { reason: '', down: false, changed: true }
}

// 订阅一变（加、删、开关、撤销、放弃修改再撤销、恢复版本）就重新合成；面板连上时补上断线时没合成的
// Any change to the subscriptions (add, remove, switch, undo, undoing a discard, restoring a version) builds again; reconnecting makes
// up a build missed while the panel was down
watch(() => [blocklistKey(model.blocklists), model.blocklists.builtFor], () => { if (needsBuild()) void rebuildBlocklists(); else dismissBuildToast() })
const { down } = useConnection()
watch(down, (isDown) => {
  if (isDown) return
  if (refreshToastDown) dismissRefreshToast()
  if (scheduleToastDown) dismissScheduleToast()
  if (needsBuild()) void rebuildBlocklists()
})

/** 改自动更新；成功返回 true，没改成说出原因（连不上面板时横幅已经说了，不再接原因） / Changes the automatic update; true on success, and on failure
 * says why (with the panel unreachable the banner already says it, so no reason follows) */
// 没改成的那条提示：再改一次时收起，不和下一次的结果叠在一起 / The toast for a change that failed: it goes on the next attempt instead of stacking
// with that one's result
let scheduleToast: number | null = null
// 因为连不上面板没改成的：连上时收起，和「没能重新下载」一样（下拉框已经退回原值，横幅也说了连上） / One that failed because the panel was unreachable
// goes on reconnecting, as 没能重新下载 does (the select is already back to its value and the banner says the panel is back)
let scheduleToastDown = false
function dismissScheduleToast(): void {
  if (scheduleToast !== null) useToast().dismiss(scheduleToast)
  scheduleToast = null
}
export async function saveBlocklistSchedule(hours: number | null): Promise<boolean> {
  const label = hours === null ? '关闭' : hours === 24 ? '每天' : '每周'
  dismissScheduleToast()
  try {
    blocklists.schedule = await apiRequest<GeoDataSchedule>('/api/v1/config/blocklists/schedule', { method: 'PUT', ...jsonBody({ interval_hours: hours }) })
    useToast().success(hours === null ? '拦截列表的自动更新已关闭' : `拦截列表的自动更新已设为${label}`)
    return true
  } catch (e) {
    // 会话过期：已经回到登录页，不说 / The session expired: the login page is up, nothing to say
    if (e instanceof ApiError && e.status === 401) return false
    scheduleToastDown = isPanelDown(e)
    scheduleToast = useToast().error(`拦截列表的自动更新没改成「${label}」${isPanelDown(e) ? '' : `（${errorMessage(e).replace(/[。.]\s*$/, '')}）`}`)
    return false
  }
}
