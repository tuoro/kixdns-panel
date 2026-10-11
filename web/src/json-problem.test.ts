import { describe, expect, it } from 'vitest'
import { jsonProblemText, jsonSyntaxProblem, scanJsonError } from './json-problem'

describe('JSON 写错时说中文', () => {
  it('写对了没有问题', () => expect(jsonSyntaxProblem('{"a": 1}')).toBeNull())
  it('多余的逗号', () => expect(jsonProblemText(jsonSyntaxProblem('{"a": 1,}')!)).toBe('第 1 行第 9 列 · 多余的逗号'))
  it('属性名没加引号', () => expect(jsonSyntaxProblem('{\n  a: 1\n}')).toMatchObject({ line: 2, reason: '属性名要用双引号' }))
  it('没写完', () => expect(jsonSyntaxProblem('{"a": ')?.reason).toBe('JSON 不完整'))
  it('数组没合上', () => expect(jsonSyntaxProblem('{"a": [1, 2')?.reason).toBe('少了逗号或右括号'))
  it('没有英文', () => expect(jsonProblemText(jsonSyntaxProblem('{"a" 1}')!)).not.toMatch(/[A-Za-z]{3,}/))
  it('浏览器不给位置的错误也指到出错的那一行', () => {
    expect(jsonSyntaxProblem('{\n  "broken": ,\n  "a": 1\n}')).toMatchObject({ line: 2, column: 13 })
    expect(jsonSyntaxProblem('[1,,2]')).toMatchObject({ line: 1, column: 4 })
  })
  it('自己走一遍的位置和浏览器给的一致', () => {
    for (const text of ['{"a" 1}', '{"a": 1,}', '{a: 1}', '{"a": [1, 2']) {
      const pos = Number(/position (\d+)/.exec((() => { try { JSON.parse(text); return '' } catch (e) { return String((e as Error).message) } })())?.[1])
      expect(scanJsonError(text)).toBe(pos)
    }
  })
})
