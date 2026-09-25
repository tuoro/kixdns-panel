import { describe, expect, it } from 'vitest'
import { diffDigits } from './digits'

const changed = (previous: string | null, next: string): string =>
  diffDigits(previous, next).map((cell) => (cell.changed ? '^' : '.')).join('')

describe('diffDigits', () => {
  it('第一次显示一位都不动', () => {
    expect(changed(null, '12,847,392')).toBe('..........')
  })

  it('只标出变了的那几位', () => {
    expect(changed('12,847,392', '12,847,981')).toBe('.......^^^')
    expect(changed('12,847,392', '12,848,001')).toBe('.....^.^^^')
  })

  it('值不变时一位都不动', () => {
    expect(changed('83.6%', '83.6%')).toBe('.....')
  })

  it('位数变多时按右对齐比较，左边多出来的位算变了', () => {
    expect(changed('999', '1,000')).toBe('^^^^^')
    // 小数点还在原位，不算变了 / The decimal point stays put, so it does not count as changed
    expect(changed('9.8 ms', '10.2 ms')).toBe('^^.^...')
  })

  it('位数变少时同样右对齐', () => {
    expect(changed('1,002', '998')).toBe('^^^')
    expect(changed('13 ms', '9 ms')).toBe('^...')
  })
})
