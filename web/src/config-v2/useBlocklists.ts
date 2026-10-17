import { reactive } from 'vue'
import { apiRequest, jsonBody } from '../api/client'
import type { BlocklistBuildResult, BlocklistSource, BlocklistState, GeoDataSchedule } from '../api/types'
import { useToast } from '../composables/useToast'
import { errorMessage } from '../utils'
import { draftGeneration, model } from './store'

// 拦截列表在面板服务端的情况：每个链接在用哪一份、多少条、上次更新和失败原因，还有自动更新的设置。配置页里共用一份。
// 订阅本身在草稿里；订阅一变就请服务端重新合成，合成出的文件填进草稿，保存后生效。
// The blocklists as the panel server holds them: for each link the copy in use, its count, the last update and why one failed,
// plus the automatic-update setting. One copy for the config page. The subscriptions themselves live in the draft; whenever
// they change the server builds again and the file it builds goes into the draft, taking effect on save.
export const blocklists = reactive({
  sources: {} as Record<string, BlocklistSource>,
  schedule: null as GeoDataSchedule | null,
  status: 'loading' as 'loading' | 'ok' | 'failed',
  // 正在下载的链接 / The links downloading now
  downloading: new Set<string>(),
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

// 一次接一次地合成，最后一次说了算。等的时候草稿整份换掉了、或者订阅又改了，这次的文件不填：后面那次会填
// Builds run one after another and the last one counts. When the draft was replaced or the subscriptions changed meanwhile, this
// build's file is not filled in: the next one will be
let queue: Promise<void> = Promise.resolve()
/** 按草稿里的订阅重新合成；`refresh` 里的链接重新下载 / Builds again for the draft's subscriptions; links in `refresh` download again */
export function rebuildBlocklists(refresh: string[] = []): Promise<void> {
  const toast = useToast()
  queue = queue.then(async () => {
    const generation = draftGeneration()
    const subscriptions = subscriptionsSent()
    const sent = JSON.stringify(subscriptions)
    // 和服务端一样：从没试过的、点名的才下载 / As on the server: only lists never tried, or named, download
    const fetching = subscriptions.map((s) => s.url).filter((url) => refresh.includes(url) || !blocklists.sources[url])
    for (const url of fetching) blocklists.downloading.add(url)
    try {
      const result = await apiRequest<BlocklistBuildResult>('/api/v1/config/blocklists/build', { method: 'POST', ...jsonBody({ subscriptions, refresh }) })
      blocklists.sources = { ...blocklists.sources, ...result.sources }
      if (draftGeneration() === generation && JSON.stringify(subscriptionsSent()) === sent) model.blocklists.file = result.path
      if (result.failed) toast.error(`${result.failed}\u00a0个列表没下载成功，原因写在列表下面`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      for (const url of fetching) blocklists.downloading.delete(url)
    }
  })
  return queue
}

export async function saveBlocklistSchedule(hours: number | null): Promise<void> {
  try {
    blocklists.schedule = await apiRequest<GeoDataSchedule>('/api/v1/config/blocklists/schedule', { method: 'PUT', ...jsonBody({ interval_hours: hours }) })
  } catch (e) {
    useToast().error(errorMessage(e))
  }
}
