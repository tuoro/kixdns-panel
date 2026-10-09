import { describe, expect, it } from 'vitest'
import { newOf, opPart, REQUEST_ORDER, RESPONSE_ORDER } from './condKinds'
import { FIELD, opOf, RESPONSE_FIELD, type FieldDef } from './model'

// 「添加条件」菜单里能加出每一个字段；行里的小菜单能切到每一种比较，切过去读回来还是它
// The 添加条件 menu can add every field, and a row's small menu can switch to every comparison and read back the same one
describe('条件表单认得每一种条件', () => {
  it.each([['请求条件', FIELD, REQUEST_ORDER], ['回答条件', RESPONSE_FIELD, RESPONSE_ORDER]] as const)('%s：菜单里正好是全部字段，不重不漏', (_, fields, order) => {
    expect([...order].sort()).toEqual(Object.keys(fields).sort())
  })

  it.each([['请求条件', FIELD], ['回答条件', RESPONSE_FIELD]] as const)('%s：每个字段的每种比较切过去都读得回来', (_, fields) => {
    for (const [field, def] of Object.entries(fields as Record<string, FieldDef>)) {
      for (const op of def.ops) {
        const c = { ...newOf(field, 1, fields as Record<string, FieldDef>), ...opPart(op) }
        expect(opOf(def, c).value, `${field}:${op.value}`).toBe(op.value)
      }
    }
  })
})
