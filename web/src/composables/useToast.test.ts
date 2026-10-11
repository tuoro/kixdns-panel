import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissUndoable, toastMark, useToast } from './useToast'

const toast = useToast()

function clear(): void {
  for (const item of [...toast.messages.value]) toast.dismiss(item.id)
}

beforeEach(() => {
  vi.useFakeTimers()
  clear()
})
afterEach(() => {
  clear()
  vi.useRealTimers()
})

const kinds = () => toast.messages.value.map((item) => item.kind)

describe('提示条的存活规则', () => {
  it('成功过一会儿自己消失', () => {
    toast.success('配置已保存')
    expect(toast.messages.value).toHaveLength(1)
    vi.advanceTimersByTime(5000)
    expect(toast.messages.value).toHaveLength(0)
  })

  it('失败不自动消失——没人看见就溜走的错误等于没报过', () => {
    toast.error('应用失败')
    vi.advanceTimersByTime(60_000)
    expect(toast.messages.value).toHaveLength(1)
    expect(toast.messages.value[0].kind).toBe('error')
  })

  it('可撤销的停得更久，撤销窗口就是它显示的这段时间', () => {
    toast.undoable('已删除 3 个版本', () => {})
    vi.advanceTimersByTime(5000)
    expect(toast.messages.value).toHaveLength(1)
    vi.advanceTimersByTime(3500)
    expect(toast.messages.value).toHaveLength(0)
  })

  it('点撤销会执行回调并收起这一条', () => {
    const undo = vi.fn()
    toast.undoable('已删除 3 个版本', undo)
    toast.runUndo(toast.messages.value[0].id)
    expect(undo).toHaveBeenCalledTimes(1)
    expect(toast.messages.value).toHaveLength(0)
  })

  it('最多同时三条', () => {
    for (const text of ['一', '二', '三', '四']) toast.success(text)
    expect(toast.messages.value).toHaveLength(3)
  })

  it('挤掉的是最旧的非错误那条，错误不会被后来的成功顶掉', () => {
    toast.error('应用失败')
    toast.success('一')
    toast.success('二')
    toast.success('三')
    expect(toast.messages.value).toHaveLength(3)
    expect(kinds()).toContain('error')
    expect(toast.messages.value.map((item) => item.message)).toEqual(['应用失败', '二', '三'])
  })

  it('三条全是错误时谁也不挤掉，宁可多显示一条', () => {
    toast.error('一')
    toast.error('二')
    toast.error('三')
    toast.error('四')
    expect(toast.messages.value).toHaveLength(4)
  })

  it('保存落地只收起草稿定下来之前的撤销：保存途中又改的那条撤销还在', () => {
    toast.undoable('已添加规则「a」', () => {})
    const mark = toastMark()
    toast.undoable('已删除规则「b」', () => {})
    dismissUndoable(mark)
    expect(toast.messages.value.map((item) => item.message)).toEqual(['已删除规则「b」'])
    dismissUndoable()
    expect(toast.messages.value).toEqual([])
  })

  it('同一句提示已经开着时不叠第二条', () => {
    toast.info('当前内核不支持：启用查询排行，先关掉再保存')
    toast.info('当前内核不支持：启用查询排行，先关掉再保存')
    expect(toast.messages.value.filter((item) => item.message.startsWith('当前内核不支持'))).toHaveLength(1)
  })
})
