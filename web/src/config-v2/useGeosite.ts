import { computed, effectScope, ref, watch, type ComputedRef } from 'vue'
import { apiRequest } from '../api/client'
import type { GeositeCategories } from '../api/types'
import { mergeCatalog, type Catalog } from '../config-model/geosite'
import { appliedModel, model } from './store'

// 面板读出的 GeoSite 分类，配置页里共用一份：第一次用到时问一次；草稿里出现没读过的文件（导入、下载、改了路径）
// 或者保存过（新写的本地路径这时才读得到）就再问。接口按文件缓存，再问一次很便宜。
// The GeoSite categories the panel reads, one copy for the whole config page: asked the first time they are needed, and again
// when the draft names a file not read yet (an import, a download, an edited path) or after a save (only then can a newly
// typed local path be read). The API caches per file, so asking again is cheap.
const response = ref<GeositeCategories | null>(null)
const status = ref<'loading' | 'failed' | 'ok'>('loading')
let inflight: Promise<void> | null = null
// 上一次因为哪些没读到的路径去问过：同一组路径不反复问 / The unread paths that last prompted a request, so one set is not asked about twice
let asked = ''

function draftPaths(): string[] {
  const paths = model.settings.geosite_data_paths
  return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : []
}

function load(): Promise<void> {
  inflight ??= (async () => {
    try {
      response.value = await apiRequest<GeositeCategories>('/api/v1/config/geo-data/geosite-categories')
      status.value = 'ok'
    } catch {
      // 拿到过一份就接着用；从没拿到过才算失败，这时只能手写 / Keep a copy once there is one; only never getting one is a failure, and values are typed by hand
      if (!response.value) status.value = 'failed'
    } finally {
      inflight = null
    }
  })()
  return inflight
}

function askAboutUnread(): void {
  const read = new Set(response.value?.files.filter((file) => file.sha256).map((file) => file.path) ?? [])
  const unread = draftPaths().map((path) => path.trim()).filter((path) => path && !read.has(path))
  const key = unread.join('\n')
  if (!unread.length || key === asked) return
  asked = key
  void load()
}

let catalog: ComputedRef<Catalog> | null = null

// 合并只算一份，条件框和每一行规则都看这一份 / Merged once, shared by every condition field and rule row
export function useGeositeCatalog(): ComputedRef<Catalog> {
  if (!catalog) {
    void load()
    // 不跟着哪个组件卸载：配置页里随时有条件框在用 / Not tied to any one component: condition fields come and go across the config page
    catalog = effectScope(true).run(() => {
      watch(() => draftPaths().join('\n'), askAboutUnread)
      watch(appliedModel, () => { asked = ''; askAboutUnread() })
      return computed(() => mergeCatalog(response.value, draftPaths(), status.value))
    })!
  }
  return catalog
}
