import { describe, expect, it } from 'vitest'
import type { ConfigVersion } from './api/types'
import { runningVersionId } from './running-version'

const version = (id: number, sha256: string): ConfigVersion => ({ id, sha256, message: '', actor: 'admin', created_at: id })

describe('正在运行的是哪个版本', () => {
  it('按内容摘要对上，同一份内容取最新的版本', () => {
    expect(runningVersionId('b', [version(1, 'a'), version(2, 'b'), version(5, 'b'), version(3, 'c')])).toBe(5)
  })
  it('对不上或没有摘要时不编号', () => {
    expect(runningVersionId('z', [version(1, 'a')])).toBeNull()
    expect(runningVersionId(null, [version(1, 'a')])).toBeNull()
  })
})
