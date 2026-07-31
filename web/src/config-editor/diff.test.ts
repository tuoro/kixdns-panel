import { describe, expect, it } from 'vitest'
import { diffConfig } from './diff'

describe('配置差异', () => {
  it('按字段识别新增、删除和修改', () => {
    const result = diffConfig(
      { settings: { timeout: 1000, removed: true }, pipelines: [{ id: 'default' }] },
      { settings: { timeout: 1500, added: true }, pipelines: [{ id: 'default' }] },
    )

    expect(result).toEqual({
      entries: [
        { path: '$.settings.added', kind: 'added', current: undefined, selected: true },
        { path: '$.settings.removed', kind: 'removed', current: true, selected: undefined },
        { path: '$.settings.timeout', kind: 'changed', current: 1000, selected: 1500 },
      ],
      truncated: false,
    })
  })

  it('限制超大差异的输出数量', () => {
    const result = diffConfig({ values: [1, 2, 3] }, { values: [4, 5, 6] }, 2)
    expect(result.entries).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })
})
