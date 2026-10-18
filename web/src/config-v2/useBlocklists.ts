import { reactive, watch } from 'vue'
import { apiRequest, jsonBody } from '../api/client'
import type { BlocklistBuildResult, BlocklistSource, BlocklistState, GeoDataSchedule } from '../api/types'
import { subscriptionName } from '../config-model/blocklist'
import { blocklistKey } from '../config-model/model'
import { useConnection } from '../composables/useConnection'
import { useToast } from '../composables/useToast'
import { errorMessage } from '../utils'
import { appliedModel, draftGeneration, model } from './store'

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

// 一次接一次地合成。落地时订阅又变了，这次的文件不填：后面那次会填。只是重新合成（没点名下载）、而草稿里的文件已经对得上时也不填，
// 比如放弃修改以后，免得刚放弃就又多出一处「另一次下载的列表」
// Builds run one after another. When the subscriptions changed by the time one lands, its file is not filled in: a later one will be.
// Nor is a plain rebuild (nothing named to download) once the draft's file already matches, after a discard say, so that a fresh
// discard does not grow a 「another download」 change at once
let queue: Promise<void> = Promise.resolve()
/** 按草稿里的订阅重新合成；`refresh` 里的链接重新下载 / Builds again for the draft's subscriptions; links in `refresh` download again */
export function rebuildBlocklists(refresh: string[] = []): Promise<void> {
  // 排队时就定下：放弃修改、恢复版本以后，之前点名的下载不再填进换过的草稿 / Fixed when queued: after a discard or a restore, a download named before
  // no longer fills the replaced draft
  const generation = draftGeneration()
  // 和服务端一样：从没试过的、点名的才下载；排上队就显示「下载中」 / As on the server: only lists never tried, or named, download; they show 下载中 once queued
  const fetching = model.blocklists.subscriptions.map((s) => s.url).filter((url) => refresh.includes(url) || !blocklists.sources[url])
  for (const url of fetching) blocklists.downloading.add(url)
  const run = queue.then(async () => {
    if (refresh.length ? draftGeneration() !== generation : !needsBuild()) return
    const subscriptions = subscriptionsSent()
    const key = blocklistKey(model.blocklists)
    try {
      const result = await apiRequest<BlocklistBuildResult>('/api/v1/config/blocklists/build', { method: 'POST', ...jsonBody({ subscriptions, refresh }) })
      blocklists.sources = { ...blocklists.sources, ...result.sources }
      blocklists.buildError = ''
      const current = blocklistKey(model.blocklists) === key && (refresh.length ? draftGeneration() === generation : needsBuild())
      if (current) {
        model.blocklists.file = result.path
        model.blocklists.builtFor = key
      }
      nameByTitle()
      sayFailures(fetching, result.sources)
    } catch (e) {
      blocklists.buildError = errorMessage(e)
      useToast().error(`拦截列表没有重新合成：${blocklists.buildError.replace(/[。.]\s*$/, '')}。保存前会再试一次`)
    }
  })
  queue = run.finally(() => { for (const url of fetching) blocklists.downloading.delete(url) })
  return queue
}

// 自己粘贴、还没保存的列表，下载下来带着标题（`! Title: …`）时用它当名字；改过名字的、已经保存的不动
// A pasted list not yet saved takes the title its download carries (`! Title: …`) as its name; renamed or saved ones stay as they are
function nameByTitle(): void {
  const saved = new Set(appliedModel.value.blocklists.subscriptions.map((s) => s.id))
  for (const s of model.blocklists.subscriptions) {
    const title = blocklists.sources[s.url]?.summary.title
    if (title && !saved.has(s.id) && s.name === subscriptionName(s.url) && s.name !== title) s.name = title
  }
}

// 这次下载的里有没成功的：一份都没有的说没下载成功，下载过的说没更新上、接着用原来那份 / Failures among this build's downloads: those with no copy
// failed to download, those with one failed to update and keep the copy they had
function sayFailures(fetched: string[], sources: Record<string, BlocklistSource>): void {
  const failed = fetched.map((url) => sources[url]).filter((s): s is BlocklistSource => Boolean(s?.last_error))
  const held = failed.filter((s) => s.sha256).length
  const none = failed.length - held
  if (!failed.length) return
  const what = none && held ? `${none}\u00a0个列表没下载成功，${held}\u00a0个没更新上` : none ? `${none}\u00a0个列表没下载成功` : `${held}\u00a0个列表没更新上，接着用原来那份`
  useToast().error(`${what}，原因写在列表下面`)
}

/** 保存前：等排着的合成落地；还对不上就再合成一次。返回还没合成好的原因，好了为 null / Before a save: wait for queued builds; if still stale, build once more. Returns why it is not built yet, or null once it is */
export async function settleBlocklists(): Promise<string | null> {
  await queue
  if (!needsBuild()) return null
  await rebuildBlocklists()
  return needsBuild() ? blocklists.buildError || '合成没有完成' : null
}

// 订阅一变（加、删、开关、撤销、放弃修改再撤销、恢复版本）就重新合成；面板连上时补上断线时没合成的
// Any change to the subscriptions (add, remove, switch, undo, undoing a discard, restoring a version) builds again; reconnecting makes
// up a build missed while the panel was down
watch(() => [blocklistKey(model.blocklists), model.blocklists.builtFor], () => { if (needsBuild()) void rebuildBlocklists() })
const { down } = useConnection()
watch(down, (isDown) => { if (!isDown && needsBuild()) void rebuildBlocklists() })

/** 改自动更新；成功返回 true，没改成说出原因 / Changes the automatic update; true on success, and on failure says why */
export async function saveBlocklistSchedule(hours: number | null): Promise<boolean> {
  const label = hours === null ? '关闭' : hours === 24 ? '每天' : '每周'
  try {
    blocklists.schedule = await apiRequest<GeoDataSchedule>('/api/v1/config/blocklists/schedule', { method: 'PUT', ...jsonBody({ interval_hours: hours }) })
    useToast().success(hours === null ? '拦截列表的自动更新已关闭' : `拦截列表的自动更新已设为${label}`)
    return true
  } catch (e) {
    useToast().error(`自动更新没有改成「${label}」：${errorMessage(e).replace(/[。.]\s*$/, '')}`)
    return false
  }
}
