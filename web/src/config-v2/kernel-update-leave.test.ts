import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { blocklistKey } from '../config-model/model'
import { sampleModel } from '../config-model/testing/samples'
import { useToast } from '../composables/useToast'
import { KERNEL_UPDATE, PANEL_BLOCK_HINT, goesToKernelUpdate } from '../kernel-problems'
import { model, resetTo } from './store'
import { finishStage, keepDraftForUpdate, note, recheckKernelRefusal, setViewing, stage, stayedDuringSave, validation } from './useConfigDocument'

// 内核不认面板的配置块时保存被拒，人点「去更新内核」去系统页：草稿留到回来，回来时照现在的内核再校验。校验只经过 apiRequest，换成假的，
// 演换过的内核收下草稿、没换的照样拒收
// A save refused by a kernel that does not take the panel's block, and the user follows 去更新内核 to the system page: the draft is kept for
// the return, and the return checks it again against the kernel as it is then. Validation goes through apiRequest alone, so a fake plays a
// changed kernel taking the draft and an unchanged one still refusing it
const apiRequest = vi.hoisted(() => vi.fn())
vi.mock('../api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('../api/client')>(), apiRequest }))

// 不认面板配置块的内核说的那一条，和内核 config::problems 一字不差 / What a kernel not taking the panel's block says, word for word as the kernel's config::problems
const REFUSAL = 'panel: the kernel does not read this key, so what it says has no effect; check its spelling and where it is written'
const KEPT = '草稿留在配\u2060置\u2060页，更新内核后回去保存'
const toasts = () => useToast().messages.value.map((m) => m.message)

beforeEach(() => {
  // 拦截列表的文件已经按订阅合成好：校验不先等合成 / The blocklist file is already built for the subscriptions: the check does not wait for a build
  const draft = sampleModel()
  draft.blocklists.builtFor = blocklistKey(draft.blocklists)
  resetTo(draft)
  setViewing(true)
  finishStage('idle')
  validation.value = null
  apiRequest.mockReset()
})

describe('沿「去更新内核」离开配置页：草稿留到回来', () => {
  it('去的是系统页上更新内核的那一行才算', () => {
    expect(goesToKernelUpdate(KERNEL_UPDATE)).toBe(true)
    expect(goesToKernelUpdate({ path: '/system', hash: '' })).toBe(false)
    expect(goesToKernelUpdate({ path: '/logs', hash: KERNEL_UPDATE.hash })).toBe(false)
  })

  it('有修改的草稿留到回来；离开时提示说一句，回到配置页时收起', () => {
    model.settings.cache_capacity = 30000
    keepDraftForUpdate()
    setViewing(false)
    expect(toasts()).toContain(KEPT)
    expect(setViewing(true)).toBe(true)
    expect(toasts()).not.toContain(KEPT)
  })

  it('换页没成（人还在配置页上）：说好的作罢，之后离开不留草稿', () => {
    model.settings.cache_capacity = 30000
    keepDraftForUpdate()
    stayedDuringSave()
    setViewing(false)
    expect(toasts()).not.toContain(KEPT)
    expect(setViewing(true)).toBe(false)
  })

  it('草稿没有修改：没什么要留的，也不提示', () => {
    keepDraftForUpdate()
    setViewing(false)
    expect(toasts()).not.toContain(KEPT)
    expect(setViewing(true)).toBe(false)
  })
})

describe('回到留着的草稿：保存条说着内核不认面板的配置块时照现在的内核再校验', () => {
  beforeEach(() => {
    model.settings.cache_capacity = 30000
    finishStage('failed', PANEL_BLOCK_HINT)
  })

  it('内核换过、收下了：那句换成校验通过', async () => {
    apiRequest.mockResolvedValue({ protocol_version: 1, valid: true, pipeline_count: 1, rule_count: 1 })
    recheckKernelRefusal()
    await vi.waitFor(() => expect(validation.value).not.toBeNull())
    expect(apiRequest).toHaveBeenCalledWith('/api/v1/config/validate', expect.objectContaining({ method: 'POST' }))
    expect(stage.value).toBe('idle')
  })

  it('内核没换：照样拒收，保存条再说一遍（旁边还是去更新内核）', async () => {
    apiRequest.mockRejectedValue(new ApiError(REFUSAL, 422, 'kixdns_rejected', [REFUSAL]))
    recheckKernelRefusal()
    await vi.waitFor(() => expect(stage.value).toBe('failed'))
    expect(apiRequest).toHaveBeenCalledTimes(1)
    expect(note.value).toBe(PANEL_BLOCK_HINT)
  })

  it('别的失败和内核无关：照旧留着，不再校验', () => {
    finishStage('failed', '设置 缓存容量：太大了')
    recheckKernelRefusal()
    expect(stage.value).toBe('failed')
    expect(apiRequest).not.toHaveBeenCalled()
  })
})
