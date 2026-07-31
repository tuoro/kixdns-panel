export type ConfigDiffKind = 'added' | 'removed' | 'changed'

export interface ConfigDiffEntry {
  path: string
  kind: ConfigDiffKind
  current: unknown
  selected: unknown
}

export interface ConfigDiffResult {
  entries: ConfigDiffEntry[]
  truncated: boolean
}

export function diffConfig(current: unknown, selected: unknown, limit = 200): ConfigDiffResult {
  const entries: ConfigDiffEntry[] = []
  let truncated = false

  function append(path: string, before: unknown, after: unknown): void {
    if (entries.length >= limit) {
      truncated = true
      return
    }
    entries.push({
      path,
      kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed',
      current: before,
      selected: after,
    })
  }

  function walk(before: unknown, after: unknown, path: string): void {
    if (truncated || Object.is(before, after)) return
    if (Array.isArray(before) && Array.isArray(after)) {
      const length = Math.max(before.length, after.length)
      for (let index = 0; index < length; index += 1) {
        walk(before[index], after[index], `${path}[${index}]`)
      }
      return
    }
    if (isRecord(before) && isRecord(after)) {
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
      for (const key of keys) walk(before[key], after[key], appendPath(path, key))
      return
    }
    append(path, before, after)
  }

  walk(current, selected, '$')
  return { entries, truncated }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function appendPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`
}
