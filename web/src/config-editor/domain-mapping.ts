import { actionFieldErrors, validDnsName } from './field-validation'
import type { DomainMappingRow } from './solution'

export const DEFAULT_DOMAIN_MAPPING_TTL = 300

export type DomainMappingFieldErrors = Partial<Record<'source' | 'target' | 'ttl', string>>

export interface DomainMappingImportLine {
  lineNumber: number
  input: string
  row: DomainMappingRow | null
  errors: string[]
}

export interface DomainMappingImportPreview {
  lines: DomainMappingImportLine[]
  validCount: number
  errorCount: number
  rows: DomainMappingRow[]
}

export function domainMappingFieldErrors(row: DomainMappingRow): DomainMappingFieldErrors {
  const errors: DomainMappingFieldErrors = {}
  if (!row.source.trim()) errors.source = '请填写源域名'
  else if (!validDnsName(row.source)) errors.source = '源域名格式无效'
  const actionErrors = actionFieldErrors({ type: 'static_cname_response', target: row.target, ttl: row.ttl }, '')
  if (actionErrors.target) errors.target = actionErrors.target
  if (actionErrors.ttl) errors.ttl = actionErrors.ttl
  return errors
}

export function parseDomainMappingBulk(source: string): DomainMappingImportPreview {
  const lines = source.split(/\r?\n/).flatMap((input, index): DomainMappingImportLine[] => {
    if (!input.trim()) return []
    const parts = input.replace(/\s*(?:->|=>|→|,|，)\s*/g, ' ').trim().split(/\s+/)
    if (parts.length < 2 || parts.length > 3) {
      return [{ lineNumber: index + 1, input, row: null, errors: ['请按“源域名 目标域名 [TTL]”填写，每行一条'] }]
    }
    const row = { source: parts[0]!, target: parts[1]!, ttl: parts[2] === undefined ? DEFAULT_DOMAIN_MAPPING_TTL : Number(parts[2]) }
    return [{ lineNumber: index + 1, input, row, errors: Object.values(domainMappingFieldErrors(row)) }]
  })
  const validCount = lines.filter((line) => line.errors.length === 0).length
  const errorCount = lines.length - validCount
  // 只有完整预览通过时才提供导入数据，防止调用方意外部分导入。
  const rows = errorCount === 0 ? lines.flatMap((line) => line.row ? [line.row] : []) : []
  return { lines, validCount, errorCount, rows }
}

export function duplicateDomainMappingSources(rows: readonly DomainMappingRow[]): Map<number, number> {
  const seen = new Map<string, number>()
  const duplicates = new Map<number, number>()
  rows.forEach((row, index) => {
    const source = row.source.trim().toLowerCase().replace(/\.$/, '')
    if (!source) return
    const first = seen.get(source)
    if (first === undefined) seen.set(source, index)
    else duplicates.set(index, first)
  })
  return duplicates
}

export function formatDomainMappingTtl(ttl: number): string {
  if (ttl < 60) return `${ttl} 秒`
  const minutes = Math.floor(ttl / 60)
  const seconds = ttl % 60
  return `${ttl} 秒（${minutes} 分钟${seconds ? ` ${seconds} 秒` : ''}）`
}
