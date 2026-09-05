import { describe, expect, it } from 'vitest'
import { domainMappingFieldErrors, duplicateDomainMappingSources, parseDomainMappingBulk } from './domain-mapping'

describe('域名映射批量预览', () => {
  it('跳过空行但保留原始行号与输入', () => {
    const preview = parseDomainMappingBulk('\r\n a.example b.example. 60\r\n\r\nmissing\r\n')
    expect(preview.lines.map((line) => line.lineNumber)).toEqual([2, 4])
    expect(preview.lines[0]?.input).toBe(' a.example b.example. 60')
    expect(preview.validCount).toBe(1)
    expect(preview.errorCount).toBe(1)
    expect(preview.lines[1]?.errors).toEqual(['请按“源域名 目标域名 [TTL]”填写，每行一条'])
    expect(preview.rows).toEqual([])
  })

  it('兼容空格、逗号和箭头，并允许 TTL 为 0', () => {
    const preview = parseDomainMappingBulk('a.example b.example\nc.example,d.example,0\ne.example → f.example. 120\ng.example => h.example 30\ni.example -> j.example 60\nk.example，l.example，90')
    expect(preview.errorCount).toBe(0)
    expect(preview.validCount).toBe(6)
    expect(preview.rows.map((row) => row.ttl)).toEqual([300, 0, 120, 30, 60, 90])
  })

  it.each(['-1', '1.5', '4294967296', 'NaN', 'Infinity', 'abc'])('拒绝非法 TTL %s，保留错误行且不部分导入', (ttl) => {
    const preview = parseDomainMappingBulk(`good.example target.example 300\nbad.example target.example ${ttl}`)
    expect(preview.validCount).toBe(1)
    expect(preview.errorCount).toBe(1)
    expect(preview.lines[1]?.lineNumber).toBe(2)
    expect(preview.lines[1]?.errors).toContain('CNAME TTL 必须是 0 到 4294967295 的整数')
    expect(preview.rows).toEqual([])
  })

  it('源域名与 CNAME 目标使用共享域名校验', () => {
    const preview = parseDomainMappingBulk('bad..example target.example\nvalid.example target..example')
    expect(preview.validCount).toBe(0)
    expect(preview.lines[0]?.errors).toContain('源域名格式无效')
    expect(preview.lines[1]?.errors).toContain('CNAME 目标域名格式无效')
  })

  it('空输入不产生可导入数据', () => {
    expect(parseDomainMappingBulk(' \n\t\r\n')).toEqual({ lines: [], validCount: 0, errorCount: 0, rows: [] })
  })

  it('重复源只报告顺序，不阻止导入', () => {
    const preview = parseDomainMappingBulk('same.example first.example\nSAME.example. second.example')
    expect(preview.errorCount).toBe(0)
    expect(preview.rows).toHaveLength(2)
    expect(duplicateDomainMappingSources(preview.rows)).toEqual(new Map([[1, 0]]))
  })

  it('表单空 TTL 明确报错，0 保持有效', () => {
    expect(domainMappingFieldErrors({ source: 'a.example', target: 'b.example', ttl: Number.NaN }).ttl).toBeDefined()
    expect(domainMappingFieldErrors({ source: 'a.example', target: 'b.example', ttl: 0 })).toEqual({})
  })
})
